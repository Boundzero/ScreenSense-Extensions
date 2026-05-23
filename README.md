# ScreenSense

Browser extensions (Firefox + Chromium) that read what's on your screen with a vision LLM. Two modes:

- **Quiz** — captures the screen (or a region you drag-select), detects a multiple-choice question, and highlights the answer right on the page.
- **Ask** — a conversation about what's on screen: ask "what's this error?", then follow up with "how do I fix it?" — the model keeps the original screenshot and context across turns.

It works with four LLM backends: **Anthropic Claude**, **OpenAI**, **Google Gemini**, and **Open WebUI** (self-hosted Ollama). It also supports an optional **Telegram output** mode that sends answers to a chat instead of showing them on screen.

This repo contains two builds from one shared codebase:

| Folder | Browser | Background model |
|---|---|---|
| [`firefox/`](firefox/) | Firefox | MV3 event page |
| [`chromium/`](chromium/) | Chrome, Edge, Opera, Brave | MV3 service worker |

The three logic files (`providers.js`, `background.js`, `content.js`) are kept byte-identical between the two builds except for a small number of browser-specific strings; the manifests and popups are intentionally browser-specific.

---

## Intended use

ScreenSense is built for **legitimate, consensual uses**, such as:

- **Live fact-checking** — verifying claims in a presentation or article in real time.
- **Accessibility** — getting a plain-language description or explanation of on-screen content.
- **Studying and self-testing** — checking your own answers on practice questions you own.
- **Second-screen reference** — routing notes/answers to your own phone via Telegram so they don't clutter your main display.

**Please do not use ScreenSense to gain an unfair or dishonest advantage.** Specifically, it is **not** intended for use during proctored exams, certification tests, technical interviews, or any setting where outside assistance is prohibited and others reasonably believe you are working unaided. The Telegram "hidden from screen" mode exists for second-screen and screen-sharing workflows where moving the answer off the shared display is appropriate — not to conceal assistance from a proctor or interviewer.

A technical note worth understanding: a browser extension **cannot** reliably hide an on-screen overlay from OS-level screen capture (Zoom, Teams, Meet, OBS all capture the actual displayed pixels). The Telegram mode works by *not putting the answer on the screen at all* — it is the honest way to keep an answer off a shared display, and it only ever sends data to the destination you configure.

You are responsible for using this software lawfully and ethically in your context.

---

## Privacy

- **Screenshots are never stored or written to disk.** They're held in memory only for the duration of a single request, sent to the LLM backend you configured, then discarded. Only your *settings* (provider, model, base URL, API keys, Telegram config) are persisted, in the browser's extension storage.
- **Your data goes only where you point it.** If you use the Open WebUI provider against your own server, screenshots travel only to that server. If you use a cloud provider (Anthropic/OpenAI/Google), the image is sent to that provider under its data policy. Telegram messages go only to the bot/chat you configure.
- The extensions contain no analytics, telemetry, or third-party calls beyond the LLM backend and (if enabled) the Telegram Bot API.

---

## Install

### Chromium (Chrome / Edge / Opera / Brave)

1. Download or clone this repo.
2. Open `chrome://extensions` (or `edge://extensions`, etc.).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the `chromium/` folder.
5. Open **Details → Site access → On all sites** (needed for Open WebUI and the auto-watcher).

### Firefox

1. Download or clone this repo.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select `firefox/manifest.json`.
   - Temporary add-ons are cleared when Firefox restarts; for a permanent install you'd sign the `.xpi` via AMO.
4. Open `about:addons → ScreenSense → Permissions` and enable **Access your data for all websites**.

---

## First-run setup

1. Click the toolbar icon to open the popup, and make sure the master switch is **on**.
2. Open **Provider & settings**, pick a provider, paste your API key, choose a model, click **Test**, then **Save**.
3. (Optional) Open **Output settings** to route answers to **Telegram** instead of the screen.

### Recommended model (self-hosted Open WebUI / Ollama)

Use a **non-thinking vision model**. Field-tested pick: **`mistral-small3.2`** — fast (3–10s), strong OCR, no runaway reasoning. Avoid thinking models (e.g. `qwen3.6:27b`) for quiz mode — they can spend many minutes generating reasoning and never emit an answer. See [`docs/CHANGELOG.md`](docs/CHANGELOG.md) and [`PORTING-TO-DESKTOP.md`](PORTING-TO-DESKTOP.md) for the full model guidance and the reasoning behind it.

---

## Hotkeys

| Default | Action |
|---|---|
| `Ctrl+Shift+1` | Quiz mode (region) |
| `Ctrl+Shift+2` | Quiz mode (full screen) |
| `Ctrl+Shift+3` | Ask about region |
| `Ctrl+Shift+4` | Ask about full screen |

All rebindable — Chromium: `chrome://extensions/shortcuts`; Firefox: `about:addons` → gear ⚙ → **Manage Extension Shortcuts**. The popup has a "Customize hotkeys →" link.

---

## Telegram output (optional)

When enabled, answers are sent to a Telegram chat and **nothing appears on screen** (a strict either/or). Setup:

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Send your bot any message, then visit `https://api.telegram.org/bot<token>/getUpdates` to find your numeric chat ID.
3. In the popup → **Output settings**, choose **Telegram only**, paste the token and chat ID, click **Send test message**, then **Save**.

In this mode you'll get a "📸 Screen captured — analyzing…" notice in Telegram followed by the answer; the page itself stays clean.

---

## Related

- [`PORTING-TO-DESKTOP.md`](PORTING-TO-DESKTOP.md) — a guide for porting these improvements back to a Python/Qt desktop equivalent (the project this was originally derived from).
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — version history.

## License

MIT — see [`LICENSE`](LICENSE).
