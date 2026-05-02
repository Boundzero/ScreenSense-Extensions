// background.js — service worker / event page for ScreenSense.
//
// Responsibilities:
//   - Hold the master enabled/disabled state and provider config.
//   - Take screen captures via browser.tabs.captureVisibleTab and crop to
//     a requested region.
//   - Run the LLM call (quiz JSON or chat stream).
//   - Manage the auto-watcher: periodic capture + change detection that
//     auto-triggers quiz mode when the page LOOKS like it has a question.
//   - Route hotkey commands to the content script.
//
// All UI lives in the content script. Background never touches the DOM.

import {
  makeProvider,
  parseJsonFromModelOutput,
  humanizeProviderError,
  AnthropicProvider,
  OpenAIProvider,
  GoogleProvider,
  OpenWebUIProvider,
  PROVIDERS,
} from "./providers.js";
import {
  QUIZ_SYSTEM_PROMPT,
  ASK_SYSTEM_PROMPT,
  normalizeQuizResult,
  diagnoseRawResponse,
} from "./quiz.js";

// Cross-browser API shim. Firefox exposes both `browser` and (since ~MV3)
// `chrome`. We always use `browser`.
const api = (typeof browser !== "undefined") ? browser : chrome;

// ============================================================================
// State
// ============================================================================

const DEFAULT_STATE = {
  enabled: true,
  providerId: AnthropicProvider.id,
  config: {
    anthropic: { apiKey: "", model: AnthropicProvider.defaultModel },
    openai:    { apiKey: "", model: OpenAIProvider.defaultModel },
    google:    { apiKey: "", model: GoogleProvider.defaultModel },
    openwebui: {
      apiKey: "", model: "", baseUrl: "",
      cfClientId: "", cfClientSecret: "",
    },
  },
  watcher: {
    enabled: false,
    intervalMs: 2500,
    autoTriggerQuiz: true,
  },
  // Where answers go:
  //   "screen"   — render on the page (default, original behavior)
  //   "telegram" — send to Telegram only; render NOTHING on screen
  // The two are mutually exclusive by design: when telegram is selected the
  // page stays completely clean (intended for screen-share / presentation
  // fact-checking where the answer must not appear on the shared display).
  output: {
    mode: "screen",
    telegram: { botToken: "", chatId: "" },
  },
};

let state = structuredClone(DEFAULT_STATE);

// `ready` resolves once the persisted state has been merged into `state`.
// Every message handler MUST `await ready` before reading or writing state.
// Without this, a service-worker respawn can hit message handlers while
// `state` still holds the empty defaults — which we'd then merge-and-save
// over the real user config. (This is the cause of the "settings get wiped
// every few requests" bug.)
let ready = loadState();

async function loadState() {
  const stored = await api.storage.local.get("state");
  if (stored.state) {
    // Deep-merge so newly-added defaults aren't dropped, but persisted
    // values take precedence.
    state = mergeDeep(structuredClone(DEFAULT_STATE), stored.state);
  }
  applyToolbarBadge();
  applyWatcher();
}

// If another extension context writes to storage, refresh our in-memory
// state so the next handler sees the latest values. We deliberately don't
// re-invoke applyWatcher/applyToolbarBadge here — the writer is virtually
// always us (saveState in a message handler), and those callbacks fired
// from the writing handler already. Re-running them on every write just
// produces redundant `set-watcher` traffic to the content script.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.state) return;
  const newVal = changes.state.newValue;
  if (newVal) {
    state = mergeDeep(structuredClone(DEFAULT_STATE), newVal);
  }
});

function mergeDeep(base, overlay) {
  for (const k of Object.keys(overlay || {})) {
    const v = overlay[k];
    if (v && typeof v === "object" && !Array.isArray(v) && base[k]) {
      base[k] = mergeDeep(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

async function saveState() {
  await api.storage.local.set({ state });
}

function applyToolbarBadge() {
  api.action.setBadgeText({ text: state.enabled ? "" : "off" });
  api.action.setBadgeBackgroundColor({ color: "#555" });
  api.action.setTitle({
    title: state.enabled
      ? "ScreenSense — click for actions"
      : "ScreenSense (off) — click to re-enable",
  });
}

function activeProvider() {
  const id = state.providerId;
  const cfg = state.config[id];
  if (!cfg) throw new Error(`No config for provider "${id}".`);
  if (id !== "openwebui" && !cfg.apiKey) {
    throw new Error(`No API key configured for ${PROVIDERS[id].displayName}. Open the popup to set one.`);
  }
  if (id === "openwebui" && !cfg.baseUrl) {
    throw new Error("Open WebUI requires a base URL. Open the popup to set one.");
  }
  return makeProvider(id, cfg);
}

// ============================================================================
// Capture
// ============================================================================

/** Capture the visible area of the active tab. Returns base64 PNG (no prefix). */
async function captureVisibleTabB64(tabId) {
  // captureVisibleTab takes a windowId, not a tabId.
  const tab = await api.tabs.get(tabId);
  const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  // dataUrl: "data:image/png;base64,...."
  const comma = dataUrl.indexOf(",");
  return dataUrl.slice(comma + 1);
}

/** Crop a base64 PNG to a CSS-pixel rect. Rect is in viewport (CSS) coords
 *  but the captured image is in physical pixels — we scale by devicePixelRatio
 *  reported by the content script. Returns base64 PNG. */
async function cropPngB64(b64, rect, devicePixelRatio) {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bitmap = await createImageBitmap(blob);

  const dpr = devicePixelRatio || 1;
  const sx = Math.max(0, Math.round(rect.x * dpr));
  const sy = Math.max(0, Math.round(rect.y * dpr));
  const sw = Math.min(bitmap.width  - sx, Math.round(rect.width  * dpr));
  const sh = Math.min(bitmap.height - sy, Math.round(rect.height * dpr));

  if (sw <= 0 || sh <= 0) {
    throw new Error("Cropped region has zero area.");
  }

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return await blobToBase64(outBlob);
}

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  // chunked btoa to avoid stack overflow on large buffers
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ============================================================================
// LLM flows
// ============================================================================

async function runQuiz(tabId, { rect, devicePixelRatio, signal, announce = false } = {}) {
  const provider = activeProvider();

  // 1. Capture.
  let imageB64 = await captureVisibleTabB64(tabId);
  if (rect) {
    imageB64 = await cropPngB64(imageB64, rect, devicePixelRatio);
  }
  // Abort early if the user cancelled during capture.
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // In Telegram mode, tell the user on their phone that we've captured and are
  // waiting on the model (the screen stays silent). `announce` is false for the
  // auto-watcher so it doesn't spam a notice on every page change.
  if (announce && isTelegramMode()) {
    try { await sendToTelegram("📸 Screen captured — analyzing the question…", { signal }); } catch {}
  }

  // 2. Call the LLM.
  // For OWUI specifically, append `/no_think` — this is the documented Qwen3
  // family escape hatch that tells the model to skip chain-of-thought and
  // emit the answer directly. Without it, Qwen3 thinking models can spend
  // 5-25 minutes generating reasoning tokens for image quizzes (verified
  // against your Ollama logs showing 22m39s, 24m20s request durations).
  // Other providers ignore the suffix harmlessly.
  const userText = (state.providerId === "openwebui")
    ? "Analyze this question and return the JSON response. /no_think"
    : "Analyze this question and return the JSON response.";

  const raw = await provider.complete_json({
    imagePngB64: imageB64,
    userText,
    systemPrompt: QUIZ_SYSTEM_PROMPT,
    maxTokens: 4000,
    signal,
  });

  // 3. Parse.
  const data = parseJsonFromModelOutput(raw);
  if (!data) {
    const diag = diagnoseRawResponse(raw);
    const sep = "─".repeat(40);
    const composed =
      diag.message +
      `\n\n${sep}\nModel output (${diag.length} chars):\n${sep}\n` +
      diag.preview;
    const err = new Error(composed);
    err.parseFailure = diag;
    throw err;
  }
  const result = normalizeQuizResult(data);

  // Surface the captured image so the content script can fall back to
  // pixel-coord highlight if DOM matching fails.
  return { result, imageB64, cropRect: rect || null, devicePixelRatio: devicePixelRatio || 1 };
}

async function runAsk(tabId, { rect, devicePixelRatio, userText, port, signal } = {}) {
  const provider = activeProvider();
  console.log(`[ScreenSense] ask starting — provider=${state.providerId} model=${activeCfgModel()} rect=${rect ? "region" : "fullscreen"}`);
  let imageB64 = await captureVisibleTabB64(tabId);
  if (rect) {
    imageB64 = await cropPngB64(imageB64, rect, devicePixelRatio);
  }
  console.log(`[ScreenSense] ask image captured, ${imageB64.length} b64 chars`);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const question = userText || "What's on this screen? Be concise.";
  const telegram = isTelegramMode();
  if (telegram) {
    // Let the user know on their phone that capture happened and we're waiting
    // on the model — so the silence on screen isn't ambiguous.
    try { await sendToTelegram("📸 Screen captured — asking the model…", { signal }); } catch {}
  }
  try {
    let deltaCount = 0;
    const text = await provider.stream({
      imagePngB64: imageB64,
      userText: question,
      systemPrompt: ASK_SYSTEM_PROMPT,
      maxTokens: 2048,
      signal,
      onDelta: (delta) => {
        deltaCount++;
        // In Telegram mode we suppress on-screen streaming entirely — the
        // answer must not appear on the page. We collect it and send once
        // at the end.
        if (!telegram) {
          try { port?.postMessage({ type: "delta", delta }); } catch {}
        }
      },
    });
    console.log(`[ScreenSense] ask finished — ${deltaCount} deltas, ${text?.length || 0} total chars. output=${telegram ? "telegram" : "screen"}`);
    if (telegram) {
      await sendToTelegram(`ScreenSense (ask):\n\n${text}`, { signal });
      try { port?.postMessage({ type: "sent-telegram", what: "ask" }); } catch {}
    } else {
      // Include the image and the question used so the content script can hold
      // conversation state for follow-up questions (it re-sends them with
      // ask-followup; we never re-capture).
      try { port?.postMessage({ type: "done", text, imageB64, question }); } catch {}
    }
    return { ok: true, text };
  } catch (e) {
    console.error("[ScreenSense] ask error:", e);
    const msg = humanizeProviderError(e, PROVIDERS[state.providerId].displayName, activeCfgModel());
    try { port?.postMessage({ type: "error", message: msg }); } catch {}
    throw e;
  }
}

/** Continue an Ask conversation. The content script supplies the full turn
 *  history (user/assistant text) plus the original screenshot — we do NOT
 *  capture a new one. The model answers the latest follow-up question with
 *  the image and prior context available. */
async function runAskFollowup({ turns, imageB64, port, signal } = {}) {
  const provider = activeProvider();
  if (typeof provider.streamConversation !== "function") {
    const m = `${PROVIDERS[state.providerId].displayName} doesn't support follow-up questions yet.`;
    try { port?.postMessage({ type: "error", message: m }); } catch {}
    throw new Error(m);
  }
  console.log(`[ScreenSense] ask-followup — ${turns.length} turns, provider=${state.providerId}`);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    let deltaCount = 0;
    const text = await provider.streamConversation({
      turns,
      imagePngB64: imageB64,
      systemPrompt: ASK_SYSTEM_PROMPT,
      maxTokens: 2048,
      signal,
      onDelta: (delta) => {
        deltaCount++;
        try { port?.postMessage({ type: "delta", delta }); } catch {}
      },
    });
    console.log(`[ScreenSense] ask-followup finished — ${deltaCount} deltas, ${text?.length || 0} chars`);
    try { port?.postMessage({ type: "done", text }); } catch {}
    return { ok: true, text };
  } catch (e) {
    console.error("[ScreenSense] ask-followup error:", e);
    const msg = humanizeProviderError(e, PROVIDERS[state.providerId].displayName, activeCfgModel());
    try { port?.postMessage({ type: "error", message: msg }); } catch {}
    throw e;
  }
}

/** Format a normalized quiz result as readable plain text for Telegram. */
function formatQuizForTelegram(result) {
  if (!result || !result.found_question) {
    return "ScreenSense: no question detected on screen.";
  }
  const lines = [];
  if (result.question) lines.push(`Q: ${result.question}`, "");
  const ans = result.answers || [];
  if (ans.length) {
    lines.push("Answer" + (ans.length > 1 ? "s" : "") + ":");
    for (const a of ans) {
      const letter = a.letter ? `${a.letter}. ` : "• ";
      lines.push(`${letter}${a.text}`);
      if (a.rationale) lines.push(`   ↳ ${a.rationale}`);
    }
  }
  if (result.overall_explanation) {
    lines.push("", result.overall_explanation);
  }
  if (result.confidence) {
    lines.push("", `Confidence: ${result.confidence}`);
  }
  return lines.join("\n");
}

function activeCfgModel() {
  const id = state.providerId;
  return state.config[id]?.model || "(unset)";
}

// ============================================================================
// Output routing (screen vs Telegram)
// ============================================================================

/** True when answers should be sent to Telegram and NOT rendered on screen. */
function isTelegramMode() {
  return state.output?.mode === "telegram"
      && !!state.output?.telegram?.botToken
      && !!state.output?.telegram?.chatId;
}

/** Send a message to the configured Telegram chat. Throws on failure so the
 *  caller can surface it. Splits long messages — Telegram caps at 4096 chars
 *  per message. */
async function sendToTelegram(text, { signal } = {}) {
  const tg = state.output?.telegram || {};
  if (!tg.botToken || !tg.chatId) {
    throw new Error("Telegram is selected as the output but the bot token or chat ID is missing. Open the popup → Output settings.");
  }
  const body = (text && text.trim()) ? text.trim() : "(empty response)";
  const url = `https://api.telegram.org/bot${tg.botToken}/sendMessage`;
  // Telegram hard-limits a single message to 4096 chars; chunk if needed.
  const chunks = [];
  for (let i = 0; i < body.length; i += 4000) chunks.push(body.slice(i, i + 4000));

  for (const chunk of chunks) {
    let resp;
    try {
      resp = await fetch(url, {
        signal,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: tg.chatId,
          text: chunk,
          disable_web_page_preview: true,
        }),
      });
    } catch (e) {
      throw new Error(`Couldn't reach Telegram: ${e?.message || e}`);
    }
    if (!resp.ok) {
      let detail = "";
      try { const j = await resp.json(); detail = j.description || ""; } catch {}
      // Common cases: 401 bad token, 400 bad chat_id ("chat not found").
      if (resp.status === 401) {
        throw new Error("Telegram rejected the bot token (401). Double-check the token from @BotFather.");
      }
      if (/chat not found/i.test(detail)) {
        throw new Error("Telegram couldn't find that chat ID. Make sure you've sent your bot a message first (bots can't initiate chats), then re-fetch your chat ID.");
      }
      throw new Error(`Telegram error ${resp.status}${detail ? `: ${detail}` : ""}.`);
    }
  }
}

// ============================================================================
// Auto-watcher
// ============================================================================

// We don't use perceptual hashing in the browser — the content script tells
// us when the DOM has likely changed *and* the page text looks quiz-like.
// That's a much cheaper signal than periodic capture + hashing.
//
// The content script owns the watcher cadence (a simple MutationObserver +
// debounce). Background just listens for "watcher-trigger" messages and
// decides whether to run a full auto-quiz cycle.

let lastAutoQuizAt = 0;
const AUTO_QUIZ_COOLDOWN_MS = 5000;

async function handleWatcherTrigger(tabId, payload) {
  if (!state.enabled || !state.watcher.enabled || !state.watcher.autoTriggerQuiz) return;
  const now = Date.now();
  if (now - lastAutoQuizAt < AUTO_QUIZ_COOLDOWN_MS) return;
  lastAutoQuizAt = now;

  try {
    const out = await runQuiz(tabId, {});
    if (out.result.found_question && out.result.answers.length) {
      if (isTelegramMode()) {
        // Telegram mode: send the auto-detected answer to Telegram, render
        // nothing on screen (preserves the strict either/or even for the
        // auto-watcher). Auto-watcher stays silent on the page by design.
        try {
          await sendToTelegram(formatQuizForTelegram(out.result));
        } catch (e) {
          console.warn("[ScreenSense] auto-watcher telegram send failed:", e);
        }
      } else {
        api.tabs.sendMessage(tabId, {
          type: "quiz-result",
          auto: true,
          ...out,
        });
      }
    }
    // No question — silently do nothing.
  } catch (e) {
    // Auto-watcher errors are silent (no toast). Only manual triggers get
    // surfaced; otherwise a broken config would spam toasts forever.
    console.warn("[ScreenSense] auto-watcher error:", e);
  }
}

function applyWatcher() {
  // Tell the active tab (and only the active tab) whether the watcher should run.
  // Doing this on tab activation keeps inactive tabs idle.
  api.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    for (const t of tabs) {
      api.tabs.sendMessage(t.id, {
        type: "set-watcher",
        enabled: state.enabled && state.watcher.enabled,
        intervalMs: state.watcher.intervalMs,
      }).catch(() => { /* tab may not have content script */ });
    }
  });
}

api.tabs.onActivated?.addListener(async () => {
  await ready;
  applyWatcher();
});

// ============================================================================
// Messaging
// ============================================================================

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // Wait for the persisted state to be loaded before doing anything that
    // reads or writes state. Without this gate, a freshly-respawned service
    // worker can serve a request with empty defaults — and worse, save those
    // defaults over the user's real config.
    await ready;
    try {
      const tabId = sender.tab?.id ?? (await getActiveTabId());

      switch (msg?.type) {
        case "test-telegram": {
          // Send a test message using the currently-saved telegram config.
          try {
            await sendToTelegram("✅ ScreenSense test message — your Telegram output is configured correctly.");
            return sendResponse({ ok: true });
          } catch (e) {
            return sendResponse({ ok: false, error: e?.message || String(e) });
          }
        }

        case "get-output-mode": {
          // Content script asks this right before rendering, so it knows
          // whether to show UI on screen (mode "screen") or stay invisible
          // because the answer is going to Telegram (mode "telegram").
          return sendResponse({ ok: true, mode: isTelegramMode() ? "telegram" : "screen" });
        }

        case "diag-ping": {
          // Lightweight reachability probe used by the popup's Diagnostics
          // button. Reports whether state was loaded successfully and a
          // cheap checksum of the config so we can tell if something
          // wiped the user's settings.
          const ck = JSON.stringify({
            provider: state.providerId,
            owuiBase: state.config?.openwebui?.baseUrl || "",
            owuiKey: state.config?.openwebui?.apiKey ? "set" : "",
            anthrKey: state.config?.anthropic?.apiKey ? "set" : "",
            opnaiKey: state.config?.openai?.apiKey ? "set" : "",
            googKey: state.config?.google?.apiKey ? "set" : "",
          });
          return sendResponse({
            ok: true,
            enabled: state.enabled,
            providerId: state.providerId,
            storageLoaded: true,
            stateChecksum: ck,
          });
        }

        case "diag-probe-owui": {
          // Actual network round-trip to the user's Open WebUI server.
          // Catches: server down, wrong port, firewall, CSP override not
          // taking effect, http→https upgrade issue, auth wrong, etc.
          const cfg = state.config.openwebui;
          if (!cfg?.baseUrl) {
            return sendResponse({ ok: false, error: "No Open WebUI base URL set." });
          }
          try {
            const provider = makeProvider("openwebui", cfg);
            // Hard 10-second timeout — listing models should be <1s on a
            // healthy server. Longer = network blackhole or firewall drop.
            const probeAbort = new AbortController();
            const probeTimeout = setTimeout(() => probeAbort.abort(), 10_000);
            try {
              const models = await provider.listModels({ signal: probeAbort.signal });
              clearTimeout(probeTimeout);
              const sample = models.slice(0, 5);
              return sendResponse({
                ok: true,
                status: 200,
                modelCount: models.length,
                sampleModels: sample,
                allModels: models,
              });
            } finally {
              clearTimeout(probeTimeout);
            }
          } catch (e) {
            const msg = humanizeProviderError(e, "Open WebUI", cfg.model || "(unset)");
            return sendResponse({
              ok: false,
              status: e?.status,
              error: msg,
            });
          }
        }

        case "get-state":
          return sendResponse({ ok: true, state, providers: providersInfo() });

        case "set-state":
          state = mergeDeep(state, msg.patch || {});
          await saveState();
          applyToolbarBadge();
          applyWatcher();
          return sendResponse({ ok: true, state });

        case "toggle-enabled":
          state.enabled = !state.enabled;
          await saveState();
          applyToolbarBadge();
          applyWatcher();
          return sendResponse({ ok: true, enabled: state.enabled });

        case "list-openwebui-models": {
          const cfg = state.config.openwebui;
          if (!cfg.baseUrl) throw new Error("Open WebUI base URL not set.");
          const p = makeProvider("openwebui", cfg);
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 10_000);
          try {
            const models = await p.listModels({ signal: ac.signal });
            return sendResponse({ ok: true, models });
          } finally {
            clearTimeout(t);
          }
        }

        case "test-connection": {
          // Minimal round-trip: send a tiny text-only stream that returns
          // a single word. Confirms auth, model name, and network all work
          // without burning a vision-token call.
          const provider = activeProvider();
          let text = "";
          try {
            text = await provider.stream({
              imagePngB64: null,
              userText: "Reply with the single word: ok",
              systemPrompt: "You are a connectivity test. Reply with exactly one word.",
              maxTokens: 16,
              onDelta: (d) => { text += d; },
            });
          } catch (e) {
            // Some providers (OWUI's ollama path) don't support text-only
            // through chat completions reliably; retry with a complete_json
            // shape. The error from this attempt is what we surface.
            throw e;
          }
          return sendResponse({ ok: true, reply: text.trim().slice(0, 100) });
        }

        case "ask": {
          if (!state.enabled) throw new Error("ScreenSense is currently off.");
          // Ask is now port-based; the message handler shouldn't see this anymore,
          // but if a future caller sends it, do a non-streaming fallback by
          // skipping the port.
          const out = await runAsk(tabId, {
            rect: msg.rect,
            devicePixelRatio: msg.devicePixelRatio,
            userText: msg.userText,
          });
          return sendResponse({ ok: true, text: out.text });
        }

        case "watcher-trigger": {
          await handleWatcherTrigger(tabId, msg.payload || {});
          return sendResponse({ ok: true });
        }

        default:
          return sendResponse({ ok: false, error: `Unknown message type "${msg?.type}".` });
      }
    } catch (e) {
      // Parse failures are model-output problems, not provider errors. The
      // raw preview is the most actionable info we can show — humanize-as-
      // provider-error would prepend "Open WebUI error:" and truncate at
      // 300 chars, hiding what the model actually returned.
      let humanized;
      if (e?.parseFailure) {
        humanized = e.message;
      } else {
        const providerName = PROVIDERS[state.providerId]?.displayName || "Provider";
        humanized = humanizeProviderError(e, providerName, activeCfgModel());
      }
      console.error("[ScreenSense] message handler error:", e);
      // Surface to the content script as a toast.
      try {
        const tabId = sender.tab?.id ?? (await getActiveTabId());
        api.tabs.sendMessage(tabId, { type: "toast", level: "error", message: humanized });
      } catch {}
      sendResponse({ ok: false, error: humanized });
    }
  })();
  return true; // async
});

async function getActiveTabId() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

function providersInfo() {
  return Object.values(PROVIDERS).map(P => ({
    id: P.id,
    displayName: P.displayName,
    keyPrefix: P.keyPrefix,
    defaultModel: P.defaultModel,
    models: P.models,
  }));
}

// ============================================================================
// Commands (hotkeys)
// ============================================================================

// ============================================================================
// Streaming ask via long-lived port
// ============================================================================
//
// MV3 message-handler return values can't keep a sendResponse channel open for
// streaming. We use a long-lived Port instead: the content script connects,
// sends the initial ask request, and receives a sequence of {type, delta|text|message}
// messages back. The port stays alive for the whole stream and is dropped
// after the final {type:"done"|"error"} message.

api.runtime.onConnect.addListener((port) => {
  if (port.name !== "screensense-stream") return;
  const senderTabId = port.sender?.tab?.id;
  console.log(`[ScreenSense] port connected from tab ${senderTabId}`);
  if (!senderTabId) {
    try { port.postMessage({ type: "error", message: "No tab context." }); port.disconnect(); } catch {}
    return;
  }

  // Heartbeat: every 10s we send a no-op `progress` message over the port.
  // Three reasons:
  //   1. Keeps the port "active" from Firefox's perspective — defense against
  //      any aggressive event-page timeout that might fire even with the port
  //      open. (Documented Firefox guarantee says ports keep the page alive,
  //      but belt-and-suspenders since v1.0's symptom suggests otherwise.)
  //   2. Tells the content script we're still working, so the UI can show a
  //      progress indicator instead of looking frozen.
  //   3. If postMessage throws (port secretly dead), we discover it earlier
  //      and can clean up rather than holding a phantom op forever.
  // KEEP-ALIVE for the MV3 30-second idle-timeout (both browser families).
  //
  // Chromium: MV3 service workers are terminated after 30s of inactivity.
  // An in-flight fetch or active port traffic normally keeps them alive, but
  // periodic extension-API activity is the robust belt-and-suspenders signal.
  //
  // Firefox: Bugzilla 1851373 — Firefox terminates the background event page
  // after 30s even when a port is connected and actively passing messages
  // (the messaging API doesn't reset the internal idle timer). Storage events
  // DO reset it.
  //
  // Common fix for both: periodically write to storage.session (or
  // storage.local as fallback). Storage writes count as activity that resets
  // the idle timer on both engines. This is THE documented workaround from
  // the Mozilla bug thread, and it's harmless-and-helpful on Chromium too.
  const KEEPALIVE_INTERVAL_MS = 10000;  // well under the 30s timeout
  const KEEPALIVE_KEY = "_keepalive_tick";
  const keepaliveStore = api.storage.session || api.storage.local;
  let keepaliveCounter = 0;

  let heartbeatStart = 0;
  let heartbeatTimer = null;
  let keepaliveTimer = null;

  function startHeartbeat() {
    heartbeatStart = Date.now();

    // Storage-write keepalive (resets the idle timer on both engines).
    keepaliveTimer = setInterval(() => {
      keepaliveCounter++;
      keepaliveStore.set({ [KEEPALIVE_KEY]: keepaliveCounter }).catch(e => {
        console.warn(`[ScreenSense] keepalive storage write failed: ${e?.message || e}`);
      });
    }, KEEPALIVE_INTERVAL_MS);

    // Heartbeat over the port (UI progress feedback + diagnostic).
    heartbeatTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - heartbeatStart) / 1000);
      try {
        port.postMessage({ type: "progress", elapsedSec: elapsed });
        console.log(`[ScreenSense] heartbeat: ${elapsed}s elapsed`);
      } catch (e) {
        console.warn(`[ScreenSense] heartbeat post failed (port likely dead): ${e?.message || e}`);
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }, 10000);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
      // Clean up the tick key — not strictly necessary but tidy.
      keepaliveStore.remove(KEEPALIVE_KEY).catch(() => {});
    }
  }

  port.onDisconnect.addListener(() => {
    console.log(`[ScreenSense] port disconnected (after ${heartbeatStart ? Math.round((Date.now() - heartbeatStart) / 1000) + 's' : 'no operation started'})`);
    stopHeartbeat();
  });

  port.onMessage.addListener(async (msg) => {
    console.log(`[ScreenSense] port message received: ${msg?.type}`);
    try {
      await ready;
    } catch (e) {
      console.error("[ScreenSense] state load failed:", e);
      try { port.postMessage({ type: "quiz-error", message: `State load failed: ${e?.message || e}` }); } catch {}
      try { port.disconnect(); } catch {}
      return;
    }

    if (!state.enabled) {
      try { port.postMessage({ type: "quiz-error", message: "ScreenSense is currently off. Toggle it on from the popup." }); } catch {}
      try { port.disconnect(); } catch {}
      return;
    }

    // Each operation (ask or quiz) gets its own AbortController. The signal
    // is plumbed all the way through fetch() so a timeout or user-cancel
    // actually closes the connection to the LLM server rather than just
    // abandoning our promise. Without this, a runaway Qwen3.6:27b quiz
    // could keep generating tokens on the server for 20+ minutes (verified
    // against Ollama logs showing 22m39s, 24m20s request durations).
    const OPERATION_TIMEOUT_MS = 180_000;  // 3 minutes — plenty for legit responses
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn(`[ScreenSense] operation timeout (${OPERATION_TIMEOUT_MS/1000}s) — aborting`);
      abortController.abort();
    }, OPERATION_TIMEOUT_MS);

    // Listen for cancel messages from the content side (user pressed
    // Cancel button on the loading panel).
    const cancelListener = (innerMsg) => {
      if (innerMsg?.type === "cancel") {
        console.warn("[ScreenSense] user cancelled");
        abortController.userCancelled = true;
        abortController.abort();
      }
    };
    port.onMessage.addListener(cancelListener);

    if (msg?.type === "ask-start") {
      startHeartbeat();
      try {
        await runAsk(senderTabId, {
          rect: msg.rect,
          devicePixelRatio: msg.devicePixelRatio,
          userText: msg.userText,
          port,
          signal: abortController.signal,
        });
      } catch (e) {
        if (abortController.userCancelled) e.userCancelled = true;
        console.warn("[ScreenSense] ask error:", e);
      } finally {
        clearTimeout(timeoutId);
        stopHeartbeat();
        try { port.disconnect(); } catch {}
      }
      return;
    }

    if (msg?.type === "ask-followup") {
      startHeartbeat();
      try {
        await runAskFollowup({
          turns: msg.turns || [],
          imageB64: msg.imageB64,
          port,
          signal: abortController.signal,
        });
      } catch (e) {
        if (abortController.userCancelled) e.userCancelled = true;
        console.warn("[ScreenSense] ask-followup error:", e);
      } finally {
        clearTimeout(timeoutId);
        stopHeartbeat();
        try { port.disconnect(); } catch {}
      }
      return;
    }

    if (msg?.type === "quiz-start") {
      console.log(`[ScreenSense] quiz starting — provider=${state.providerId} model=${activeCfgModel()} output=${state.output?.mode}`);
      startHeartbeat();
      try {
        const t0 = Date.now();
        const out = await runQuiz(senderTabId, {
          rect: msg.rect,
          devicePixelRatio: msg.devicePixelRatio,
          signal: abortController.signal,
          announce: true,
        });
        const dt = Math.round((Date.now() - t0) / 1000);

        if (isTelegramMode()) {
          // Telegram mode: format the answer as text, send it, render NOTHING
          // on screen. Tell the content script it went to Telegram so it can
          // show a tiny ephemeral confirmation toast (no answer content).
          console.log(`[ScreenSense] quiz finished after ${dt}s — sending to Telegram`);
          await sendToTelegram(formatQuizForTelegram(out.result), { signal: abortController.signal });
          try { port.postMessage({ type: "sent-telegram", what: "quiz" }); } catch {}
        } else {
          console.log(`[ScreenSense] quiz finished after ${dt}s — posting quiz-result`);
          try {
            port.postMessage({ type: "quiz-result", auto: false, ...out });
            console.log("[ScreenSense] quiz-result posted successfully");
          } catch (postErr) {
            console.error("[ScreenSense] failed to post quiz-result — port likely dead:", postErr);
          }
        }
      } catch (e) {
        if (abortController.userCancelled) e.userCancelled = true;
        const dt = Math.round((Date.now() - heartbeatStart) / 1000);
        console.error(`[ScreenSense] quiz error after ${dt}s:`, e);
        let humanized;
        if (e?.parseFailure) {
          humanized = e.message;
        } else {
          const providerName = PROVIDERS[state.providerId]?.displayName || "Provider";
          humanized = humanizeProviderError(e, providerName, activeCfgModel());
        }
        try {
          // Errors are always shown on-screen as a toast, even in Telegram
          // mode — otherwise a misconfigured Telegram setup would fail
          // silently with no feedback anywhere.
          port.postMessage({ type: "quiz-error", message: humanized });
          console.log("[ScreenSense] quiz-error posted successfully");
        } catch (postErr) {
          console.error("[ScreenSense] failed to post quiz-error — port likely dead:", postErr);
        }
      } finally {
        clearTimeout(timeoutId);
        stopHeartbeat();
        try { port.disconnect(); } catch {}
      }
      return;
    }

    if (msg?.type === "cancel") {
      // already handled by cancelListener above, just don't fall through
      // to "unknown port message" warning.
      return;
    }

    console.warn(`[ScreenSense] unknown port message type: ${msg?.type}`);
  });
});

api.commands.onCommand.addListener(async (command) => {
  await ready;
  const tabId = await getActiveTabId();
  if (!tabId) return;

  if (command === "toggle-extension") {
    state.enabled = !state.enabled;
    await saveState();
    applyToolbarBadge();
    applyWatcher();
    api.tabs.sendMessage(tabId, {
      type: "toast",
      level: "info",
      message: `ScreenSense is now ${state.enabled ? "ON" : "OFF"}.`,
    });
    return;
  }

  if (!state.enabled) {
    api.tabs.sendMessage(tabId, {
      type: "toast",
      level: "warn",
      message: "ScreenSense is off. Toggle it on from the popup.",
    });
    return;
  }

  if (command === "ask-fullscreen") {
    api.tabs.sendMessage(tabId, { type: "trigger", action: "ask-fullscreen" });
  } else if (command === "quiz-fullscreen") {
    api.tabs.sendMessage(tabId, { type: "trigger", action: "quiz-fullscreen" });
  } else if (command === "ask-region") {
    api.tabs.sendMessage(tabId, { type: "trigger", action: "ask-region" });
  } else if (command === "quiz-region") {
    api.tabs.sendMessage(tabId, { type: "trigger", action: "quiz-region" });
  }
});
