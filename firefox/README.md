# ScreenSense — Firefox Extension

A Firefox port of the [ScreenSense](../PROJECT_STATE.md) desktop app. Same four AI providers (Anthropic Claude, OpenAI ChatGPT, Google Gemini, Open WebUI), same quiz/ask modes, same auto-highlight-on-screen behavior — re-engineered for the browser.

---

## Features

- **Full-screen quiz** — captures the visible tab, sends to the LLM, highlights the correct answer on the page.
- **Region quiz** — drag-to-select a region, then run quiz on just that crop. Useful for long exam pages where only one question is on screen.
- **Full-screen ask** — generic Q&A about whatever's on screen, streamed into a draggable panel. Ask follow-up questions in the same panel (e.g. "how do I fix that error?") — the model keeps the original screenshot and conversation context, no re-capture.
- **Region ask** — same, but for a cropped region. Follow-ups supported here too.
- **Auto-watcher** — monitors the active tab for DOM changes; when the page text starts looking like a multiple-choice question, it auto-runs quiz mode and highlights the answer. No clicks needed.
- **Master on/off toggle** — flip the switch in the popup (or `Ctrl+Shift+Y` if you bind it) to silence everything without uninstalling. The toolbar icon shows an "off" badge.

### Hotkeys

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+Space` | Ask about full screen |
| `Ctrl+Shift+Q` | Quiz mode (full screen) |
| `Ctrl+Shift+R` | Ask about region |
| (unbound) | Quiz mode (region) — bind in `about:addons` → ⚙ → Manage Extension Shortcuts |
| (unbound) | Toggle on/off |

Press `Esc` to close the answer panel or clear highlights.

---

## Installation

### Quick install for testing (temporary)

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**
3. Pick `manifest.json` from the unzipped folder.

The extension stays loaded until you restart Firefox.

### Why isn't it signed?

Firefox requires extensions to be signed by AMO (addons.mozilla.org) before they can install permanently on the standard build. Until ScreenSense is submitted and signed, your options are:

- **Use `about:debugging`** (the workflow above) — re-load on each Firefox restart.
- **Use Firefox Developer Edition, Nightly, or ESR** — these allow `xpinstall.signatures.required` to be set to `false` in `about:config`, after which the `.xpi` installs permanently like any other add-on.

Standard Firefox stable/release does not allow signature checks to be disabled, by design.

### Grant host permissions (REQUIRED for non-active-tab features)

After loading, the extension only has access to the **currently focused** tab via `activeTab`. To use the auto-watcher, hotkeys on background tabs, or to talk to a self-hosted Open WebUI server, grant full host permission:

1. Open `about:addons`
2. Click **ScreenSense**
3. Open the **Permissions** tab
4. Enable **Access your data for all websites**

Without this, action buttons may fail with "Permission not granted for this site" and Open WebUI requests will hit a generic "Network error".

### Reload any tabs that were open before install

Firefox only injects content scripts into tabs that load *after* the extension is installed. If the quiz/ask buttons do nothing on a tab you had open, just refresh that tab. The extension will now self-heal by injecting on demand if the user has granted host permissions, but a manual reload is faster.

---

## First-run setup

1. Click the toolbar icon. The popup appears.
2. **Flip the switch** in the header to enable ScreenSense (it ships enabled, but verify the green pill is showing).
3. Open **Provider & settings** at the bottom.
4. Pick a provider, paste your API key, pick a model.
5. Click **Test** — this makes a tiny round-trip to confirm the API key, model, and network all work without burning a vision-token call.
6. Click **Save**.
7. (Optional) Tick **Auto-watch this tab for quiz questions** for hands-free highlighting.

### Open WebUI specifically

- Enter the full base URL **including the protocol**: `http://localhost:8080`, not `localhost:8080`.
- If your server requires auth, paste an API key from Open WebUI → Settings → Account → API Keys.
- Click **↻** next to the model select to fetch the live model list from your server.
- If you're behind Cloudflare Access, expand "Behind a Cloudflare tunnel?" and paste your service-token Client ID/Secret.

If Test fails with "Couldn't reach Open WebUI":
- **Host permission not granted** — see "Grant host permissions" above. This is the most common cause.
- **Base URL wrong** — paste it into a normal Firefox tab and confirm it loads.
- **Self-signed cert** — Firefox blocks these silently from extensions; visit the URL once in a normal tab and accept the cert.
- **CORS blocked** — your Open WebUI server needs `CORS_ALLOW_ORIGIN` set to `*` (or to `moz-extension://*` for paranoid setups).

If Test fails with `400: {"detail": "'NoneType' object has no attribute 'startswith'"}`:
- This is **Open WebUI 0.9.5 server bug [#24550](https://github.com/open-webui/open-webui/issues/24550)** — the server crashes on API requests that lack web-UI session metadata. v0.5+ of ScreenSense pads every OWUI request with placeholder `chat_id`/`session_id`/`id` fields to dodge this. If you still see the error: check for active OWUI Pipelines or Functions that might be stripping those fields, or update OWUI once a server-side fix lands.
- ScreenSense also auto-falls-back to `/ollama/api/chat` (which bypasses the broken `process_chat` path) for vision queries when the bug fires, so quiz mode against locally-hosted models should still work even if the workaround doesn't take.

### Model recommendations for local OWUI/Ollama

For vision quiz mode against a local Ollama backend, model choice matters a *lot*. The single most important rule: **use a non-thinking vision model.** Thinking/reasoning models (the Qwen3.x line, DeepSeek-R1 derivatives) burn their entire token budget on chain-of-thought and frequently never emit the answer JSON — you wait minutes and get nothing.

| Model | VRAM | Speed (vision quiz) | Notes |
|---|---|---|---|
| `mistral-small3.2` | ~15 GB | ~3-10s | **Top pick — field-tested.** Excellent vision + OCR, no thinking mode, fast and reliable over both local and Cloudflare-tunnel connections. This is the recommended default. |
| `qwen2.5-vl:7b` | ~6 GB | ~3-10s | Great on text-heavy screenshots and dense layouts (trained on document/chart data). Best low-VRAM option. |
| `qwen2.5-vl:32b` | ~22 GB | ~15-40s | Higher accuracy, same OCR strengths, still no thinking mode. Fits a 24 GB card. |
| `minicpm-v` | ~8 GB | ~5-15s | Strong OCR fallback; handles any aspect ratio up to 1.8 MP. |
| `gemma3:12b` | ~12 GB | ~10-20s | Good OCR + reasoning balance. |
| `llama3.2-vision:11b` | ~8 GB | ~5-15s | ⚠ LLaVA-derived — weaker on dense text. In testing it answered text-heavy multiple-choice questions incorrectly. Fine for general image description, not recommended for quizzes. |
| `qwen3.6:27b` | ~22 GB | ⚠ 30s to 25 min | **Avoid for quiz mode.** Thinking model — spends 5-25 minutes generating reasoning tokens for image inputs and often never emits JSON. The `/no_think` directive and JSON-mode forcing (v1.3+) help but the non-thinking models above are simply better for this. |

**Recommended:** `ollama pull mistral-small3.2`, then pick it in the popup, Test, Save.

If you see Ollama logs with `out of memory` followed by `llama runner terminated`, your GPU is over-committed. Pick a smaller quant (`Q4_K_S` instead of `Q4_K_M`) or a smaller model.

ScreenSense forces JSON mode on every quiz request (`response_format: {type: "json_object"}` on the OpenAI-compat path, `format: "json"` on the Ollama-native path). This constrains the model to emit valid JSON and self-terminate. It's most effective with non-thinking models — thinking models can still ignore it and reason in the "JSON" string.

### Timeouts and cancel

Quiz/Ask operations time out after **3 minutes** by default. If the model hasn't responded by then, ScreenSense aborts the request (closing the connection to the LLM server, not just abandoning our promise) and shows a timeout error. You can also click **Cancel** on the loading panel at any time to abort manually. The timeout is set in `background.js` (`OPERATION_TIMEOUT_MS`); edit it if you need longer for legitimate slow models.

---

## Architecture

Same shape as the desktop app, mapped to MV3 primitives:

| Desktop component | Browser equivalent |
|---|---|
| `app.py` (controller + tray) | `background.js` (service worker) + toolbar popup |
| `providers.py` (4 LLM clients) | `providers.js` (4 LLM clients, direct `fetch()`) |
| `quiz.py` (worker + JSON parser) | `quiz.js` (prompt + parser) + `background.js` runQuiz |
| `watcher.py` (mss + perceptual hash) | `content.js` `MutationObserver` + text hash |
| `region_picker.py` (Qt overlay) | `content.js` `pickRegion()` (shadow DOM overlay) |
| `highlight.py` (full-screen Qt window) | `content.js` `drawAnchoredHighlight()` on real DOM nodes |
| `ui.py` (AnswerPanel) | `content.js` `showAnswerPanel()` + `content.css` |
| OCR text matching | DOM text-content search (`findSmallestContaining`) |

### Why DOM matching instead of OCR
The desktop app's OCR returns 0 boxes in most runs (a known issue in `PROJECT_STATE.md`), which breaks the highlight feature. In the browser we have direct DOM access — we can search the page's actual text nodes for the LLM's reported answer string and outline the matching element. No image-processing fragility, and the highlight stays accurate as the page scrolls or reflows (we re-measure on every animation frame).

For non-DOM content (PDFs in a viewer, canvas-rendered text, images of questions) DOM matching will miss, but the answer panel still shows the correct answer with rationale.

### Critical decisions inherited from the desktop app

- **Anthropic CORS header** — every request includes `anthropic-dangerous-direct-browser-access: true`. Without it Anthropic returns a 401 CORS error.
- **Open WebUI dual-format auto-fallback** — try OpenAI-vision format first, fall back to Ollama-native (`/ollama/api/chat` with `images: [b64]`) when we see the telltale `NoneType` error from OWUI's image preprocessor.
- **`num_ctx` in body, not UI** — OWUI's UI-level `num_ctx` doesn't reliably propagate to API requests. We send `options.num_ctx: 8192` in every request.
- **DPI scaling** — `tabs.captureVisibleTab` returns the image at physical pixel size, but `getBoundingClientRect()` etc. are in CSS pixels. We multiply rect coords by `devicePixelRatio` when cropping the captured image (mirrors the desktop `RegionPicker` multiplier).
- **One-frame defer on region capture** — after the user releases the mouse, we wait two animation frames before triggering capture, so the picker overlay is fully gone before the screenshot is taken. (Desktop uses `QTimer.singleShot(50, ...)` for the same reason.)
- **Auto-watcher cooldown** — background dedupes auto-trigger requests to one every 5 seconds. Content script additionally hashes visible text and only pings when the hash changes. This is the equivalent of the desktop watcher's perceptual-hash gating.

### What's deliberately *not* ported

- No installer / USB wizard — Firefox extensions install via AMO or `about:debugging`.
- No encrypted-passphrase API key storage — `browser.storage.local` is already sandboxed per-extension. (If you want extra paranoia, set `cleardata` to wipe local storage on browser close.)
- No `faulthandler` / file logging — service-worker errors land in the extension's console (`about:debugging` → Inspect).
- No streaming for quiz mode — quiz is one-shot JSON, same as desktop. Ask mode streams.

---

## Limitations

- **MV3 service-worker lifetime**: Firefox's MV3 background runs as an event page, so long-running operations (like the SSE stream for Ask mode) need to keep an active port. We do this via `tabs.connect`. If the worker is forcibly terminated mid-stream, the panel will show whatever streamed before the cutoff.
- **`captureVisibleTab` rate limit**: ~2 calls/sec. The auto-watcher's 2.5-second debounce stays comfortably under this.
- **Restricted pages**: Firefox blocks content scripts on `about:`, `moz-extension:`, and AMO domains. Hotkeys won't work there.
- **Cross-origin iframes**: the watcher only sees the top-level document.
- **`anthropic-dangerous-direct-browser-access: true`**: API keys ship from the browser. This is the intended pattern for a personal-use BYOK extension, but if you ever distribute on AMO, document this clearly.

---

## File map

```
screensense-firefox/
├── manifest.json
├── background.js          ← service worker: state, capture, routing
├── providers.js           ← 4 LLM clients (fetch-based)
├── quiz.js                ← QUIZ_SYSTEM_PROMPT + result normalizer
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── content/
│   ├── content.js         ← region picker, panel, highlights, watcher
│   └── content.css
├── icons/
│   └── icon-{16,32,48,128}.png
└── README.md              ← this file
```

---

## Known TODO

1. **Provider error humanization could be richer** — the desktop `humanize_provider_error` covers more cases (network timeout vs rate-limit vs auth) than the port currently does.
2. **Pixel-fallback highlight** — when DOM matching fails, we currently skip the highlight. Could draw a box at LLM-reported image coords (mirrors desktop's OCR-coord fallback), but most LLMs don't return per-answer pixel coords reliably. Would need a second prompt or a different LLM call shape.
3. **No `tests/` directory** — same gap as the desktop project. Smoke tests for `providers.js` and the JSON parser would be cheap and catch regressions.
