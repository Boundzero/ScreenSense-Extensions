// popup.js — UI for the toolbar popup.

const api = (typeof browser !== "undefined") ? browser : chrome;

let state = null;
let providers = [];

const els = {
  enabledToggle:  document.getElementById("enabled-toggle"),
  statusLine:     document.getElementById("status-line"),
  actionsSection: document.getElementById("actions-section"),
  watcherToggle:  document.getElementById("watcher-toggle"),
  providerSelect: document.getElementById("provider-select"),
  modelSelect:    document.getElementById("model-select"),
  refreshModels:  document.getElementById("refresh-models"),
  apiKey:         document.getElementById("api-key"),
  apiKeyRow:      document.getElementById("api-key-row"),
  baseUrl:        document.getElementById("base-url"),
  baseUrlRow:     document.getElementById("base-url-row"),
  cfSection:      document.getElementById("cf-section"),
  cfId:           document.getElementById("cf-id"),
  cfSecret:       document.getElementById("cf-secret"),
  saveBtn:        document.getElementById("save-config"),
  testBtn:        document.getElementById("test-config"),
  saveState:      document.getElementById("save-state"),
  // Output settings
  outputMode:     document.getElementById("output-mode"),
  outputHint:     document.getElementById("output-hint"),
  telegramFields: document.getElementById("telegram-fields"),
  tgToken:        document.getElementById("tg-token"),
  tgChatId:       document.getElementById("tg-chatid"),
  tgTest:         document.getElementById("tg-test"),
  outputSave:     document.getElementById("output-save"),
  outputSaveState:document.getElementById("output-save-state"),
  customizeHotkeys: document.getElementById("customize-hotkeys"),
};

// ============================================================================
// Boot
// ============================================================================

(async function init() {
  const resp = await api.runtime.sendMessage({ type: "get-state" });
  if (!resp?.ok) {
    setStatus("error", "Failed to load state");
    return;
  }
  state = resp.state;
  providers = resp.providers;
  populateProviders();
  render();
})();

function populateProviders() {
  els.providerSelect.innerHTML = "";
  for (const p of providers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.displayName;
    els.providerSelect.appendChild(opt);
  }
}

function render() {
  // Toggle
  els.enabledToggle.checked = state.enabled;
  document.body.classList.toggle("disabled", !state.enabled);

  // Watcher
  els.watcherToggle.checked = !!state.watcher.enabled;

  // Provider select
  els.providerSelect.value = state.providerId;
  const providerInfo = providers.find(p => p.id === state.providerId);
  const cfg = state.config[state.providerId] || {};

  // Model select — populate from provider's known models OR previously saved
  // custom model. For Open WebUI, the list is fetched on demand.
  els.modelSelect.innerHTML = "";
  const modelList = providerInfo?.models || [];
  for (const m of modelList) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    els.modelSelect.appendChild(opt);
  }
  // If the saved model isn't in the list, prepend it.
  if (cfg.model && !modelList.includes(cfg.model)) {
    const opt = document.createElement("option");
    opt.value = cfg.model;
    opt.textContent = cfg.model;
    els.modelSelect.insertBefore(opt, els.modelSelect.firstChild);
  }
  els.modelSelect.value = cfg.model || providerInfo?.defaultModel || "";

  // API key
  els.apiKey.value = cfg.apiKey || "";

  // Open WebUI extras
  const isOWUI = state.providerId === "openwebui";
  els.baseUrlRow.hidden    = !isOWUI;
  els.cfSection.hidden     = !isOWUI;
  els.refreshModels.hidden = !isOWUI;
  els.apiKeyRow.querySelector("label").textContent = isOWUI ? "API key (optional)" : "API key";
  if (isOWUI) {
    els.baseUrl.value = cfg.baseUrl || "";
    els.cfId.value = cfg.cfClientId || "";
    els.cfSecret.value = cfg.cfClientSecret || "";
  }

  // Status line
  setStatusLine();

  // Output settings
  renderOutput();
}

function renderOutput() {
  const out = state.output || { mode: "screen", telegram: {} };
  els.outputMode.value = out.mode || "screen";
  const isTg = out.mode === "telegram";
  els.telegramFields.hidden = !isTg;
  els.tgTest.hidden = !isTg;
  els.tgToken.value = out.telegram?.botToken || "";
  els.tgChatId.value = out.telegram?.chatId || "";
  els.outputHint.textContent = isTg
    ? "Answers go ONLY to Telegram. Nothing appears on the page — safe for screen sharing."
    : "Answers appear on the page as usual.";
}

function setStatusLine() {
  const info = providers.find(p => p.id === state.providerId);
  if (!state.enabled) {
    els.statusLine.textContent = "Off — flip the switch above to enable.";
    return;
  }
  const cfg = state.config[state.providerId] || {};
  if (state.providerId !== "openwebui" && !cfg.apiKey) {
    els.statusLine.textContent = `${info?.displayName}: set an API key below.`;
  } else if (state.providerId === "openwebui" && !cfg.baseUrl) {
    els.statusLine.textContent = "Open WebUI: set a base URL below.";
  } else {
    els.statusLine.textContent = `${info?.displayName} · ${cfg.model || info?.defaultModel}`;
  }
}

// ============================================================================
// Events
// ============================================================================

els.enabledToggle.addEventListener("change", async () => {
  const resp = await api.runtime.sendMessage({ type: "toggle-enabled" });
  if (resp?.ok) {
    state.enabled = resp.enabled;
    render();
  }
});

els.watcherToggle.addEventListener("change", async () => {
  state.watcher.enabled = els.watcherToggle.checked;
  await api.runtime.sendMessage({
    type: "set-state",
    patch: { watcher: { enabled: state.watcher.enabled } },
  });
});

els.providerSelect.addEventListener("change", () => {
  state.providerId = els.providerSelect.value;
  render();
});

els.modelSelect.addEventListener("change", () => {
  const cfg = state.config[state.providerId];
  cfg.model = els.modelSelect.value;
});

els.refreshModels.addEventListener("click", async () => {
  const cfg = state.config.openwebui;
  cfg.baseUrl = els.baseUrl.value.trim();
  cfg.apiKey  = els.apiKey.value.trim();
  cfg.cfClientId     = els.cfId.value.trim();
  cfg.cfClientSecret = els.cfSecret.value.trim();
  if (!cfg.baseUrl) {
    setStatus("error", "Need a base URL first.");
    return;
  }
  setStatus("info", "Fetching models…");

  // Save first so background uses the latest values.
  await api.runtime.sendMessage({
    type: "set-state",
    patch: { config: { openwebui: cfg } },
  });
  const resp = await api.runtime.sendMessage({ type: "list-openwebui-models" });
  if (!resp?.ok) {
    setStatus("error", resp?.error || "Failed to fetch models.");
    return;
  }
  // Re-populate model select with fetched list.
  els.modelSelect.innerHTML = "";
  for (const m of resp.models) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    els.modelSelect.appendChild(opt);
  }
  if (resp.models.length) {
    els.modelSelect.value = cfg.model && resp.models.includes(cfg.model)
      ? cfg.model
      : resp.models[0];
  }
  setStatus("ok", `Found ${resp.models.length} model(s).`);
});

els.saveBtn.addEventListener("click", async () => {
  const id = state.providerId;
  const cfg = {
    apiKey: els.apiKey.value.trim(),
    model:  els.modelSelect.value || providers.find(p => p.id === id)?.defaultModel || "",
  };
  if (id === "openwebui") {
    cfg.baseUrl        = els.baseUrl.value.trim();
    cfg.cfClientId     = els.cfId.value.trim();
    cfg.cfClientSecret = els.cfSecret.value.trim();
  }
  const resp = await api.runtime.sendMessage({
    type: "set-state",
    patch: {
      providerId: id,
      config: { [id]: cfg },
    },
  });
  if (resp?.ok) {
    state = resp.state;
    setStatus("ok", "Saved.");
    setStatusLine();
  } else {
    setStatus("error", resp?.error || "Save failed.");
  }
});

els.testBtn.addEventListener("click", async () => {
  // Save first so the test uses the latest values.
  const id = state.providerId;
  const cfg = {
    apiKey: els.apiKey.value.trim(),
    model:  els.modelSelect.value || providers.find(p => p.id === id)?.defaultModel || "",
  };
  if (id === "openwebui") {
    cfg.baseUrl        = els.baseUrl.value.trim();
    cfg.cfClientId     = els.cfId.value.trim();
    cfg.cfClientSecret = els.cfSecret.value.trim();
  }
  await api.runtime.sendMessage({
    type: "set-state",
    patch: { providerId: id, config: { [id]: cfg } },
  });
  setStatus("info", "Testing…");
  const resp = await api.runtime.sendMessage({ type: "test-connection" });
  if (resp?.ok) {
    setStatus("ok", `Connection works. Reply: "${resp.reply}"`);
  } else {
    setStatus("error", resp?.error || "Test failed.");
  }
});

// ============================================================================
// Output settings handlers
// ============================================================================

els.outputMode.addEventListener("change", () => {
  const mode = els.outputMode.value;
  els.telegramFields.hidden = mode !== "telegram";
  els.tgTest.hidden = mode !== "telegram";
  els.outputHint.textContent = mode === "telegram"
    ? "Answers go ONLY to Telegram. Nothing appears on the page — safe for screen sharing."
    : "Answers appear on the page as usual.";
});

function readOutputFromForm() {
  return {
    mode: els.outputMode.value,
    telegram: {
      botToken: els.tgToken.value.trim(),
      chatId: els.tgChatId.value.trim(),
    },
  };
}

els.outputSave.addEventListener("click", async () => {
  const output = readOutputFromForm();
  if (output.mode === "telegram" && (!output.telegram.botToken || !output.telegram.chatId)) {
    setOutputStatus("error", "Telegram mode needs both a bot token and a chat ID.");
    return;
  }
  const resp = await api.runtime.sendMessage({ type: "set-state", patch: { output } });
  if (resp?.ok) {
    state = resp.state;
    setOutputStatus("ok", output.mode === "telegram" ? "Saved. Answers will go to Telegram." : "Saved.");
  } else {
    setOutputStatus("error", resp?.error || "Save failed.");
  }
});

els.tgTest.addEventListener("click", async () => {
  const output = readOutputFromForm();
  if (!output.telegram.botToken || !output.telegram.chatId) {
    setOutputStatus("error", "Enter a bot token and chat ID first.");
    return;
  }
  await api.runtime.sendMessage({ type: "set-state", patch: { output } });
  setOutputStatus("info", "Sending test message…");
  const resp = await api.runtime.sendMessage({ type: "test-telegram" });
  if (resp?.ok) {
    setOutputStatus("ok", "Test message sent — check Telegram.");
  } else {
    setOutputStatus("error", resp?.error || "Test failed.");
  }
});

els.customizeHotkeys.addEventListener("click", async () => {
  // Firefox has no openable shortcuts URL (about:addons can't be deep-linked
  // to the shortcuts pane). Open about:addons and tell the user where to go.
  try {
    await api.tabs.create({ url: "about:addons" });
    window.close();
  } catch {
    // Fallback: just instruct.
  }
  setStatus("info", "In about:addons: click the gear ⚙ → \"Manage Extension Shortcuts\" to rebind keys.");
});

let outputStatusTimer = null;
function setOutputStatus(kind, msg) {
  els.outputSaveState.className = `save-state ${kind === "info" ? "" : kind}`;
  els.outputSaveState.textContent = msg;
  if (outputStatusTimer) clearTimeout(outputStatusTimer);
  if (kind !== "error") {
    outputStatusTimer = setTimeout(() => { els.outputSaveState.textContent = ""; }, 4000);
  }
}

// Action buttons → forward to background, close popup so the user can interact
// with the page (drag a region etc).
els.actionsSection.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  if (!state.enabled) {
    setStatus("error", "Toggle ScreenSense on first (the switch in the header).");
    return;
  }

  const action = btn.dataset.action;
  const validActions = new Set([
    "quiz-fullscreen", "quiz-region", "ask-fullscreen", "ask-region",
  ]);
  if (!validActions.has(action)) return;

  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) {
    setStatus("error", "No active tab.");
    return;
  }
  const tabId = tab.id;
  const url = tab.url || "";

  // Restricted URLs that can't have content scripts.
  if (/^(about:|moz-extension:|chrome:|view-source:|resource:)/.test(url)
      || /^https?:\/\/(addons\.mozilla\.org|accounts-static\.cdn\.mozilla\.net)/.test(url)) {
    setStatus("error", "This page is restricted (about:/addons.mozilla.org). Try a regular http(s) page.");
    return;
  }

  // Try to deliver the trigger. If the content script wasn't there, inject it and retry.
  try {
    await sendTriggerOrInject(tabId, action);
    window.close();
  } catch (err) {
    setStatus("error", err.message || "Couldn't reach the page.");
  }
});

async function sendTriggerOrInject(tabId, action) {
  const msg = { type: "trigger", action };

  // First attempt — works if content script is already loaded.
  try {
    const reply = await api.tabs.sendMessage(tabId, msg);
    // Content script returns { ok: true } on receipt. If we got here without
    // throwing, success.
    if (reply && reply.ok === false && reply.error) {
      throw new Error(reply.error);
    }
    return;
  } catch (e) {
    const m = String(e?.message || e);
    // The telltale "no receiver" error. Other errors (e.g. content-script
    // threw) should propagate.
    if (!/Could not establish connection|Receiving end does not exist|No tab with id/i.test(m)) {
      throw e;
    }
  }

  // Inject the content script. CSS is embedded in the JS as a constant,
  // so we don't need a separate insertCSS call.
  //
  // We first clear the re-entrancy flag in the page's window. Without this,
  // a ghost from a previous extension version (whose listeners are gone but
  // whose flag is still set on the page's window object) would cause our
  // freshly-injected content.js to bail out at the re-entrancy guard.
  try {
    await api.scripting.executeScript({
      target: { tabId },
      func: () => {
        try { delete window.__screenSenseLoaded; } catch {}
        const ghost = document.getElementById("screensense-host");
        if (ghost) try { ghost.remove(); } catch {}
      },
    });
    await api.scripting.executeScript({
      target: { tabId },
      files: ["content/content.js"],
    });
  } catch (e) {
    const m = String(e?.message || e);
    if (/Missing host permission/i.test(m)) {
      throw new Error(
        "Permission not granted for this site.\n\n" +
        "Open about:addons → ScreenSense → Permissions and enable \"Access your data for all websites\", then close and reopen this popup."
      );
    }
    if (/Cannot access|insufficient permissions|denied/i.test(m)) {
      throw new Error(
        "Firefox blocked injection into this page. This usually means it's a restricted URL (PDFs in the built-in viewer, the new-tab page, file:// URLs without explicit permission, or pages on accounts.firefox.com).\n\n" +
        "Try the same action on a regular http(s) page."
      );
    }
    throw new Error(`Couldn't inject ScreenSense into this page: ${m}`);
  }

  // Give the content script a beat to register its listeners, then retry.
  await new Promise(r => setTimeout(r, 200));
  try {
    const reply = await api.tabs.sendMessage(tabId, msg);
    if (reply && reply.ok === false && reply.error) {
      throw new Error(reply.error);
    }
  } catch (e) {
    const m = String(e?.message || e);
    if (/Could not establish connection|Receiving end does not exist/i.test(m)) {
      // We injected the script, waited, and STILL no listener responded.
      // The script almost certainly threw during init. Two likely causes:
      //   - This page has a strict Content-Security-Policy that blocks
      //     inline event handlers, eval, or some other thing our content
      //     script does. (We don't use eval, but some pages CSP-block style
      //     injection in shadow DOM.)
      //   - Some earlier state left __screenSenseLoaded set but listeners
      //     never registered. v0.8+ fixes this by setting the flag last,
      //     but a v0.7-or-earlier ghost could still exist on a long-lived
      //     tab.
      throw new Error(
        "ScreenSense was injected but its message listener didn't register. The page likely has a Content-Security-Policy that's blocking us, or there's a ghost from an earlier extension version on this tab.\n\n" +
        "Reload the tab (Ctrl+R) and try again. If it still fails, try a different page to confirm whether it's page-specific."
      );
    }
    throw new Error(`Injected but couldn't communicate: ${m}`);
  }
}

// ============================================================================
// Status helpers
// ============================================================================

let statusTimer = null;
function setStatus(kind, msg) {
  els.saveState.className = `save-state ${kind === "info" ? "" : kind}`;
  els.saveState.textContent = msg;
  if (statusTimer) clearTimeout(statusTimer);
  if (kind !== "error") {
    statusTimer = setTimeout(() => { els.saveState.textContent = ""; }, 3000);
  }
}

// ============================================================================
// Diagnostics
// ============================================================================
//
// The "Run diagnostics" button walks the entire request chain and reports
// what works and what doesn't. Useful when the user sees the bare-error toast
// "Could not establish connection. Receiving end does not exist." — the
// report tells us which link is actually broken.

const diagOut = document.getElementById("diag-output");
const diagBtn = document.getElementById("diag-btn");
const reloadContentBtn = document.getElementById("reload-content-btn");

function diagLog(line) {
  diagOut.classList.add("visible");
  diagOut.textContent += line + "\n";
  diagOut.scrollTop = diagOut.scrollHeight;
}

diagBtn?.addEventListener("click", async () => {
  diagOut.textContent = "";
  diagOut.classList.add("visible");
  diagLog("ScreenSense diagnostics");
  diagLog("─".repeat(40));

  // 1. Manifest + version
  try {
    const mf = api.runtime.getManifest();
    diagLog(`Extension: ${mf.name} v${mf.version} (manifest v${mf.manifest_version})`);
  } catch (e) {
    diagLog(`Manifest fetch FAILED: ${e}`);
  }

  // 2. Background reachable?
  diagLog("");
  diagLog("Probing background event page…");
  try {
    const t0 = performance.now();
    const resp = await api.runtime.sendMessage({ type: "diag-ping" });
    const dt = Math.round(performance.now() - t0);
    if (resp?.ok) {
      diagLog(`  ✓ background responded in ${dt}ms`);
      diagLog(`    state.enabled=${resp.enabled}  providerId=${resp.providerId}`);
      diagLog(`    storage loaded=${resp.storageLoaded}  state-checksum=${resp.stateChecksum}`);
    } else {
      diagLog(`  ✗ background sent error: ${resp?.error || "(no message)"}`);
    }
  } catch (e) {
    diagLog(`  ✗ background unreachable: ${e?.message || e}`);
    diagLog("    This means the background script failed to register its listener.");
    diagLog("    Open about:debugging → ScreenSense → Inspect to see the background console.");
  }

  // 3. Active tab + restricted-URL check
  diagLog("");
  diagLog("Inspecting active tab…");
  let tab;
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
    if (!tab) {
      diagLog("  ✗ no active tab");
      return;
    }
    diagLog(`  tab #${tab.id}: ${tab.url || "(url hidden)"}`);
    diagLog(`  status: ${tab.status}  audible: ${tab.audible}  discarded: ${tab.discarded}`);
    if (/^(about:|moz-extension:|chrome:|view-source:|resource:|file:)/.test(tab.url || "")) {
      diagLog("  ✗ this is a restricted URL — content scripts can't run here");
      return;
    }
  } catch (e) {
    diagLog(`  ✗ tabs.query failed: ${e?.message || e}`);
    return;
  }

  // 4. Host permission for the active tab (needed for content script injection,
  //    screenshot capture, highlight rendering).
  diagLog("");
  diagLog("Checking host permission for the active tab (where the overlay UI runs)…");
  try {
    const origin = new URL(tab.url).origin + "/";
    const granted = await api.permissions.contains({ origins: [origin] });
    diagLog(`  ${origin}: ${granted ? "✓ granted" : "✗ NOT granted"}`);
    if (!granted) {
      diagLog("    open about:addons → ScreenSense → Permissions → enable");
      diagLog("    \"Access your data for all websites\".");
    }
  } catch (e) {
    diagLog(`  could not check (${e?.message || e}) — assume granted if extension was loaded`);
  }

  // 4b. Host permission for the active provider's server (separate concern —
  //     this is where the LLM API calls go from the background).
  if (state?.providerId === "openwebui") {
    const baseUrl = state?.config?.openwebui?.baseUrl;
    if (baseUrl) {
      diagLog("");
      diagLog("Checking host permission for the Open WebUI server (where API calls go)…");
      try {
        const origin = new URL(baseUrl).origin + "/";
        const granted = await api.permissions.contains({ origins: [origin] });
        diagLog(`  ${origin}: ${granted ? "✓ granted" : "✗ NOT granted"}`);
        if (!granted) {
          diagLog("    The extension can't reach this server without permission.");
          diagLog("    about:addons → ScreenSense → Permissions → enable");
          diagLog("    \"Access your data for all websites\".");
        }
      } catch (e) {
        diagLog(`  could not parse baseUrl as origin (${e?.message || e})`);
      }

      // 4c. Active network probe — actually try to reach the server.
      //     This is the only diagnostic that catches problems the permission
      //     check misses (server down, wrong port, firewall, CSP override
      //     not taking effect, http-upgrade issue, etc).
      diagLog("");
      diagLog("Probing Open WebUI server (real network round-trip)…");
      try {
        const t0 = performance.now();
        const probe = await api.runtime.sendMessage({ type: "diag-probe-owui" });
        const dt = Math.round(performance.now() - t0);
        if (probe?.ok) {
          diagLog(`  ✓ server responded HTTP ${probe.status} in ${dt}ms`);
          if (typeof probe.modelCount === "number") {
            diagLog(`    found ${probe.modelCount} model(s) on this server`);
            if (probe.modelCount > 0 && probe.sampleModels) {
              diagLog(`    sample: ${probe.sampleModels.join(", ")}`);
            }
            if (state.config.openwebui.model
                && probe.allModels
                && !probe.allModels.includes(state.config.openwebui.model)) {
              diagLog(`  ⚠ configured model "${state.config.openwebui.model}" is NOT in the server's model list.`);
              diagLog("    Click ↻ next to the model select to refresh, then pick a real model.");
            }
          }
        } else {
          diagLog(`  ✗ probe failed: ${probe?.error || "(no detail)"}`);
        }
      } catch (e) {
        diagLog(`  ✗ probe request failed: ${e?.message || e}`);
      }
    }
  }

  // 5. Content script alive on this tab?
  diagLog("");
  diagLog("Probing content script on this tab…");
  try {
    const t0 = performance.now();
    const resp = await api.tabs.sendMessage(tab.id, { type: "ping" });
    const dt = Math.round(performance.now() - t0);
    if (resp?.ok) {
      diagLog(`  ✓ content script responded in ${dt}ms`);
    } else {
      diagLog(`  ? content script responded but no ok flag: ${JSON.stringify(resp)}`);
    }
  } catch (e) {
    const m = String(e?.message || e);
    diagLog(`  ✗ content script silent: ${m}`);
    if (/Could not establish connection|Receiving end does not exist/i.test(m)) {
      diagLog("    This means no content script is loaded on this tab. Causes:");
      diagLog("    • Tab loaded before the extension was installed — reload the tab.");
      diagLog("    • Content script threw during init — see the page console (F12 → Console).");
      diagLog("    • The page has a CSP that blocked our injection.");
      diagLog("    Try the \"Re-inject on this tab\" button.");
    }
  }

  // 6. Provider config sanity
  diagLog("");
  diagLog("Provider config…");
  const id = state?.providerId;
  const cfg = state?.config?.[id] || {};
  diagLog(`  active: ${id}`);
  diagLog(`  model: ${cfg.model || "(unset)"}`);
  diagLog(`  apiKey: ${cfg.apiKey ? `set (${cfg.apiKey.length} chars)` : "(unset)"}`);
  if (id === "openwebui") {
    diagLog(`  baseUrl: ${cfg.baseUrl || "(unset)"}`);
    diagLog(`  cfClientId: ${cfg.cfClientId ? "set" : "(unset)"}`);
    if (cfg.baseUrl && /^http:\/\//.test(cfg.baseUrl)) {
      diagLog("  ⚠ baseUrl uses http:// — v0.3+ overrides upgrade-insecure-requests so this should work, but it's a common failure point.");
    }
  }

  diagLog("");
  diagLog("Done. Paste this whole report when reporting bugs.");
});

reloadContentBtn?.addEventListener("click", async () => {
  diagOut.textContent = "";
  diagOut.classList.add("visible");
  diagLog("Re-injecting content script on current tab…");
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (!tabId) { diagLog("  ✗ no active tab"); return; }

    // Clear any prior state in the page's window before re-injecting.
    await api.scripting.executeScript({
      target: { tabId },
      func: () => {
        try { delete window.__screenSenseLoaded; } catch {}
        const ghost = document.getElementById("screensense-host");
        if (ghost) try { ghost.remove(); } catch {}
      },
    });
    diagLog("  ✓ cleared prior state");

    await api.scripting.executeScript({
      target: { tabId },
      files: ["content/content.js"],
    });
    diagLog("  ✓ injected content.js");

    await new Promise(r => setTimeout(r, 250));
    const resp = await api.tabs.sendMessage(tabId, { type: "ping" });
    if (resp?.ok) {
      diagLog("  ✓ content script responded to ping — try your action again.");
    } else {
      diagLog(`  ? unexpected ping response: ${JSON.stringify(resp)}`);
    }
  } catch (e) {
    diagLog(`  ✗ re-inject failed: ${e?.message || e}`);
    if (/Missing host permission/i.test(String(e?.message || ""))) {
      diagLog("    Grant \"Access your data for all websites\" in about:addons.");
    }
  }
});
