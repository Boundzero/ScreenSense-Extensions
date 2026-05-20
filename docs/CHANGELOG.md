# Changelog

All notable changes to ScreenSense (browser extensions). Both the Firefox and
Chromium builds share a version line; they're kept at feature parity.

## 1.6.1 — Telegram silent mode
- Telegram mode is now fully silent on screen: no "Analyzing…" panel, no "sent"
  toast. Status is delivered to Telegram instead ("📸 Screen captured —
  analyzing…" / "asking the model…", then the answer).
- Auto-watcher routes to Telegram silently and does not send a per-trigger
  start notice (avoids spamming on every page change).
- Only errors surface on-screen in Telegram mode, so a misconfiguration isn't
  invisible.

## 1.6.0 — Telegram output + customizable hotkeys
- New **Output settings**: send answers to a Telegram chat instead of the
  screen, as a strict either/or (nothing renders on the page in Telegram mode).
- Telegram sender with 4096-char chunking and specific errors for bad token
  (401) and "chat not found".
- All four actions now have distinct default hotkeys (`Ctrl+Shift+1`–`4`), all
  rebindable. Added a "Customize hotkeys →" link in the popup.

## 1.5.0 — Ask becomes a conversation
- The Ask panel is now multi-turn: ask a follow-up ("how do I fix that?") and
  the model answers using the same screenshot plus prior context — no
  re-capture.
- Added `streamConversation()` to all four providers (Anthropic, OpenAI,
  Google, Open WebUI), each translating a neutral turn list into its wire
  format with the image attached to the first user turn.

## 1.4.x — Ask reliability
- Fixed Ask returning blank: when Open WebUI's OpenAI-compat endpoint returns
  empty content, fall back to the Ollama-native `/ollama/api/chat` endpoint
  (the same escape hatch that makes quiz mode robust).
- Broadened response-shape reading (OpenAI-compat, Ollama-native, legacy
  completion) and refactored the shared streaming transport.
- Raised Ask token budget; added diagnostic logging.

## 1.4.0 — JSON-mode forcing + model guidance
- Force JSON mode on quiz requests (`response_format: {type:"json_object"}`
  plus Ollama-native `format: "json"`) so models emit valid JSON and
  self-terminate instead of rambling.
- Documented model guidance: `mistral-small3.2` recommended; thinking models
  (e.g. `qwen3.6:27b`) discouraged for quiz mode.

## 1.3.x — Timeouts, cancel, and a bug fix
- Hard 3-minute timeout on every LLM call via `AbortController`, plus a Cancel
  button that actually aborts the in-flight request.
- `/no_think` directive appended for Open WebUI quiz prompts (thinking-model
  mitigation).
- Fixed a `ReferenceError` in `listModels` introduced by an earlier mechanical
  edit; added timeouts to the model-list probe.

## 1.x — Open WebUI hardening
- Session-metadata padding to work around Open WebUI 0.9.5 bug #24550
  (`'NoneType' object has no attribute 'startswith'`).
- `<think>`-tag stripping and balanced-brace JSON extraction in the parser.
- Diagnostics panel (probe background, tab, permissions, content script,
  provider) and a "Re-inject on this tab" button.

## Chromium port
- Ported the Firefox build to Chromium MV3: `service_worker` background,
  service-worker-safe APIs, Chromium-appropriate restricted-URL detection and
  permission messaging, Chrome-compatible hotkey defaults.

## 0.x — Initial Firefox port
- Initial MV3 port of the desktop ScreenSense app: region/full-screen capture,
  crop via OffscreenCanvas, four LLM providers, quiz highlighting, ask panel,
  auto-watcher, shadow-DOM UI.
