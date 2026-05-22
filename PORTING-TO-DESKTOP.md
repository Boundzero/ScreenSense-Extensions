# ScreenSense — Porting Extension Improvements Back to the Desktop App

**Purpose:** This document is a work-order for bringing the improvements made in the browser-extension fork (Firefox + Chromium, JS/MV3) back into the original desktop application (Python/Qt). It covers only the changes made *after* the desktop→extension fork.

**How to read this:** Each item has four parts — **What** it does, **Why** it matters, the **JS logic** we used in the extension, and the **Desktop (Python/Qt) translation** describing how to apply it. Items are ordered by value: do the ⭐ HIGH-VALUE ones first.

**Important framing:** This is a *translation*, not a copy. The two projects are different runtimes. Some extension work is browser-platform plumbing with no desktop equivalent — those items are listed at the end under "Do NOT port" so you don't waste effort on them.

---

## Table of contents

1. ⭐ Model guidance (operational knowledge) — **do this first, it's free**
2. ⭐ Open WebUI robustness chain (the big one)
3. ⭐ JSON-mode forcing
4. ⭐ Model-output JSON parsing with `<think>` stripping
5. Timeout + cancel (AbortController pattern)
6. OWUI 0.9.5 session-metadata workaround (#24550)
7. Empty-response → Ollama-native fallback
8. Ask-as-conversation (follow-up questions)
9. Telegram output (optional feature)
10. Things to NOT port (extension-only)

---

## 1. ⭐ Model guidance (operational knowledge)

**What:** Default to a *non-thinking* vision model. The field-tested winner is **`mistral-small3.2`**. Avoid thinking models (the Qwen3.x line, e.g. `qwen3.6:27b`) for vision-quiz tasks.

**Why:** This was the single highest-impact discovery of the whole project. Thinking models burn their entire token budget generating chain-of-thought reasoning for image inputs and frequently *never emit the answer*. Real evidence from the Ollama logs during testing: individual `/api/chat` requests took **22m39s, 24m20s, 15m55s** with `qwen3.6:27b`, several ending in `llama runner terminated / signal: killed` (OOM on a 24 GB RTX 3090). `llama3.2-vision:11b` was fast but **answered text-heavy multiple-choice questions incorrectly** (it's LLaVA-derived, weak on dense text). `mistral-small3.2` was fast (3–10 s), accurate, and never OOM'd over both local and tunnel connections.

**JS logic:** No code — this lives in the README model table and is enforced only by the default model string.

**Desktop translation:**
- Change the default model in the desktop config / first-run setup to `mistral-small3.2`.
- Add the recommendation table to the desktop app's docs/README and ideally surface a one-line hint in the model-picker UI ("Tip: non-thinking vision models like mistral-small3.2 are fastest and most reliable").
- Recommended table to reproduce:

| Model | VRAM | Speed | Notes |
|---|---|---|---|
| `mistral-small3.2` | ~15 GB | 3–10s | **Top pick.** Non-thinking, strong OCR. |
| `qwen2.5-vl:7b` | ~6 GB | 3–10s | Best low-VRAM option, good on dense text. |
| `qwen2.5-vl:32b` | ~22 GB | 15–40s | Higher accuracy, still non-thinking. |
| `minicpm-v` | ~8 GB | 5–15s | OCR fallback. |
| `llama3.2-vision:11b` | ~8 GB | 5–15s | ⚠ Weak on text-heavy questions. |
| `qwen3.6:27b` | ~22 GB | 30s–25min | ❌ Thinking model — avoid for quizzes. |

---

## 2. ⭐ Open WebUI robustness chain (the big one)

**What:** A layered strategy for talking to Open WebUI that survives its various quirks. Request path priority:
1. Try the **OpenAI-compatible** endpoint `POST {base}/api/chat/completions`.
2. If that errors with a known recoverable failure (image-handler error, the 0.9.5 session bug, or an empty response), **fall back to the Ollama-native** endpoint `POST {base}/ollama/api/chat`, which bypasses OWUI's `process_chat` layer entirely.
3. Read the response across **multiple possible shapes** (see §7).

**Why:** OWUI's OpenAI-compat layer is fragile for vision requests depending on version, model, Pipelines/Functions, and tunnel/proxy stack. The Ollama-native endpoint is much more reliable for locally-hosted vision models because it skips the buggy middle layer. This chain is *the* reason quiz mode became reliable.

**JS logic (the dispatcher in `complete_json`):**
```javascript
async complete_json({ imagePngB64, userText, systemPrompt, maxTokens, signal }) {
  try {
    return await this._openAIFormatComplete({ imagePngB64, userText, systemPrompt, maxTokens, signal });
  } catch (e) {
    const msg = String(e?.message || "");
    if (this._isImageHandlerError(msg)
        || this._is095SessionBug(msg)
        || this._isEmptyResponseError(msg)) {
      return await this._ollamaFormatComplete({ imagePngB64, userText, systemPrompt, maxTokens, signal });
    }
    throw e;
  }
}
```

Error detectors (decide whether a failure is recoverable):
```javascript
_isEmptyResponseError(msg) {
  return /empty response/i.test(msg) && /open\s*webui/i.test(msg);
}
_isImageHandlerError(msg) {
  return /image[_ ]?(handler|processor|input|url)/i.test(msg)
      || /unsupported image/i.test(msg)
      || (/NoneType.*attribute/i.test(msg) && /image/i.test(msg));
}
_is095SessionBug(msg) {
  return /'NoneType'\s*object has no attribute\s*'startswith'/i.test(msg);
}
```

**Desktop translation (Python, e.g. in `providers.py` / your OWUI client class):**
```python
import re

def complete_json(self, image_b64, user_text, system_prompt, max_tokens=4000, timeout=180):
    try:
        return self._openai_format_complete(image_b64, user_text, system_prompt, max_tokens, timeout)
    except ProviderError as e:
        msg = str(e)
        if self._is_image_handler_error(msg) or self._is_095_session_bug(msg) or self._is_empty_response(msg):
            return self._ollama_format_complete(image_b64, user_text, system_prompt, max_tokens, timeout)
        raise

@staticmethod
def _is_empty_response(msg):
    return bool(re.search(r"empty response", msg, re.I) and re.search(r"open\s*webui", msg, re.I))

@staticmethod
def _is_image_handler_error(msg):
    return bool(
        re.search(r"image[_ ]?(handler|processor|input|url)", msg, re.I)
        or re.search(r"unsupported image", msg, re.I)
        or (re.search(r"NoneType.*attribute", msg, re.I) and re.search(r"image", msg, re.I))
    )

@staticmethod
def _is_095_session_bug(msg):
    return bool(re.search(r"'NoneType'\s*object has no attribute\s*'startswith'", msg, re.I))
```
Use `requests` (or `httpx`) for the two endpoint calls. The Ollama-native body differs from the OpenAI body — see §7 for the exact shapes.

---

## 3. ⭐ JSON-mode forcing

**What:** On every quiz request, instruct the server to constrain output to valid JSON. Send **both** spellings so whichever the upstream model supports takes effect:
- OpenAI spelling: `"response_format": {"type": "json_object"}`
- Ollama-native spelling: `"format": "json"`

**Why:** Without JSON mode, thinking models emit reasoning prose and run out of tokens before producing the answer object (we saw a model produce 14,707 chars of reasoning and never emit JSON). JSON mode constrains the model to emit a valid object and self-terminate as soon as it closes. Most effective with non-thinking models, but harmless and helpful everywhere.

**JS logic (OpenAI-compat body):**
```javascript
const body = this._withSessionPadding({
  model: this.model,
  max_tokens: maxTokens,
  stream: !!stream,
  messages: [...],
  response_format: { type: "json_object" },  // OpenAI spelling
  format: "json",                            // Ollama-native spelling
  options: { num_ctx: 8192 },
});
```
Ollama-native body uses `"format": "json"` plus `options: { num_ctx: 8192, num_predict: maxTokens }`.

**Desktop translation:** Add both keys to the request payload dicts in your OWUI client. They're inert on providers that don't recognize them, so it's safe to always include them on the quiz path. (Do *not* force JSON mode on the free-form "ask" path — that should return prose.)

---

## 4. ⭐ Model-output JSON parsing with `<think>` stripping

**What:** A robust parser that extracts a JSON object from messy model output: strips `<think>…</think>` chain-of-thought wrappers (including unclosed/truncated ones), strips markdown code fences, then does a balanced-brace scan to find the first parseable `{…}`.

**Why:** Even with JSON mode, some models wrap output in `<think>` tags or fences, or emit leading prose. This parser recovers the answer instead of failing. The unclosed-`<think>` handling specifically rescues truncated thinking-model output.

**JS logic:**
```javascript
export function parseJsonFromModelOutput(text) {
  if (!text) return null;
  text = stripThinkingTags(text.trim());
  try { return JSON.parse(text); } catch {}
  const stripped = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?\s*```\s*$/, "").trim();
  try { return JSON.parse(stripped); } catch {}
  let i = text.indexOf("{");
  while (i !== -1) {
    const obj = extractBalancedObject(text, i);     // brace counter, string-aware
    if (obj) { try { return JSON.parse(obj); } catch {} }
    i = text.indexOf("{", i + 1);
  }
  return null;
}

function stripThinkingTags(text) {
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const openIdx = text.search(/<think>/i);
  if (openIdx !== -1 && !/<\/think>/i.test(text)) text = text.slice(0, openIdx).trim();
  return text;
}
```

**Desktop translation (Python):**
```python
import json, re

def parse_json_from_model_output(text):
    if not text:
        return None
    text = _strip_thinking_tags(text.strip())
    try:
        return json.loads(text)
    except Exception:
        pass
    stripped = re.sub(r"^```(?:json)?\s*\n?", "", text)
    stripped = re.sub(r"\n?\s*```\s*$", "", stripped).strip()
    try:
        return json.loads(stripped)
    except Exception:
        pass
    i = text.find("{")
    while i != -1:
        obj = _extract_balanced_object(text, i)
        if obj:
            try:
                return json.loads(obj)
            except Exception:
                pass
        i = text.find("{", i + 1)
    return None

def _strip_thinking_tags(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.I | re.S).strip()
    m = re.search(r"<think>", text, re.I)
    if m and not re.search(r"</think>", text, re.I):
        text = text[:m.start()].strip()
    return text

def _extract_balanced_object(text, start):
    if text[start] != "{":
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc: esc = False
            elif ch == "\\": esc = True
            elif ch == '"': in_str = False
        else:
            if ch == '"': in_str = True
            elif ch == "{": depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[start:i+1]
    return None
```
If the desktop app already has a JSON extractor, just add the `<think>`-stripping step in front of it — that's the part most likely to be missing.

---

## 5. Timeout + cancel (AbortController pattern)

**What:** A hard timeout (default **180 s**) on every LLM call, plus a user-facing **Cancel** that actually aborts the in-flight network request (not just abandons the wait). When it fires, the connection closes so the server stops generating.

**Why:** Before this, a runaway thinking model left the app waiting 15–25 minutes while the server burned GPU. The abort closes the socket; Ollama sees the disconnect and stops. Also surfaces a clear "timed out — try a smaller/non-thinking model" message.

**JS logic:** `AbortController` + `setTimeout(() => controller.abort(), 180000)`, with the `signal` passed into every `fetch`. A Cancel button posts a message that calls `controller.abort()`.

**Desktop translation (Python/Qt):**
- If using `requests`: pass `timeout=180` to every call (note: this is an inactivity timeout, good enough for the hard cap). For true cancel, run the request in a `QThread`/`QRunnable` and use a flag + `response.close()`, or switch to `httpx` with a cancellation token.
- If using `QNetworkAccessManager`: keep the `QNetworkReply` handle; a Cancel button calls `reply.abort()`. Use a `QTimer.singleShot(180000, reply.abort)` for the hard cap.
- UX: show a Cancel control while a request is in flight, and after ~60 s change the status text to suggest the model may be stuck.

---

## 6. OWUI 0.9.5 session-metadata workaround (#24550)

**What:** Inject placeholder session fields into *every* OWUI request body: `chat_id`, `session_id`, `id` (all fresh UUIDs), and `parent_id: null`.

**Why:** Open WebUI 0.9.5 (and nearby versions, which auto-update) has a server bug (GitHub issue #24550) where API requests lacking web-UI session metadata crash with `'NoneType' object has no attribute 'startswith'`. Padding the body with these fields dodges the crash.

**JS logic:**
```javascript
_withSessionPadding(body) {
  return { ...body,
    chat_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    id: crypto.randomUUID(),
    parent_id: null,
  };
}
```

**Desktop translation (Python):**
```python
import uuid
def _with_session_padding(body):
    return { **body,
        "chat_id": str(uuid.uuid4()),
        "session_id": str(uuid.uuid4()),
        "id": str(uuid.uuid4()),
        "parent_id": None,
    }
```
Wrap every OWUI request body with this before sending. Combined with the §2 fallback, this makes the OWUI path resilient to the 0.9.5 bug whether or not the padding takes.

---

## 7. Empty-response → Ollama-native fallback (response shapes)

**What:** When the OpenAI-compat endpoint returns HTTP 200 but **empty content** (a real failure mode with some OWUI+vision combos), retry on the Ollama-native endpoint. Also: read the response across all shapes it might arrive in.

**Why:** This was the exact bug that made "Ask" return blank. OWIU returned `content-type: application/json` (a non-streamed downgrade) with empty `content`. The Ollama-native endpoint returns the real answer.

**Endpoint + body differences:**
- OpenAI-compat: `POST {base}/api/chat/completions`, messages use `content` arrays with `{type:"image_url", image_url:{url:"data:image/png;base64,…"}}`.
- Ollama-native: `POST {base}/ollama/api/chat`, messages use flat `content` strings plus a sibling `images: ["<base64>"]` array (no `data:` prefix). Streamed as NDJSON.

**Response-shape reading (try all):**
```javascript
const oaMsg     = data.choices?.[0]?.message || {};   // OpenAI-compat
const ollamaMsg = data.message || {};                 // Ollama-native
const out = oaMsg.content || oaMsg.reasoning || oaMsg.reasoning_content || oaMsg.thinking
         || ollamaMsg.content || ollamaMsg.thinking
         || data.choices?.[0]?.text || "";            // legacy completion
```

**Desktop translation (Python):** Implement an `_ollama_format_complete` that POSTs to `/ollama/api/chat` with the flattened message shape (text in `content`, image base64 in `images=[…]`), and read the response with the same fallback chain of keys shown above. Trigger it when the OpenAI-compat path returns empty (add `_is_empty_response` to the recoverable-error set in §2).

---

## 8. Ask-as-conversation (follow-up questions)

**What:** "Ask about the screen" became a multi-turn conversation. After the first answer, the user can ask follow-ups ("how do I fix that error?", "any recommendations?") and the model answers using the **same screenshot** plus prior turns — no re-capture.

**Why:** Hugely more useful for the real workflow (diagnosing an error, then asking how to fix it). The screenshot is captured once; follow-ups re-send the original image embedded in the first user turn plus the running text history.

**JS logic:** A `streamConversation({ turns, imagePngB64, systemPrompt })` method on each provider that takes a neutral turn list (`[{role, text}, …]`) and embeds the image in the first user turn. The conversation state (image + turns) is held by the UI; each turn is one request with the full history.

**Desktop translation (Python/Qt):**
- Keep the captured image and a `turns` list in the Ask window's state.
- Add a `stream_conversation(turns, image_b64, system_prompt)` to your provider(s): build the messages array, attach the image to the first user turn only, send the whole history each time.
- UI: turn the Ask result area into a scrollable thread (user bubbles + assistant answers) with a text input + Send at the bottom. Qt: a `QListView`/`QTextBrowser` thread plus a `QLineEdit`/`QPlainTextEdit` + button; Enter sends, Shift+Enter newlines.
- Image embedding per provider: OpenAI/OWUI → `image_url` data URL; Ollama-native → `images=[b64]`; Anthropic → base64 image block + separate `system`; Gemini → `inline_data` and assistant role is `"model"`.

---

## 9. Telegram output (optional feature)

**What:** Optionally route answers to a Telegram chat instead of the screen. A strict either/or: when Telegram mode is on, **nothing renders on screen** — the answer (and a "📸 captured — analyzing…" start notice) goes only to Telegram. Useful for second-screen / fact-checking workflows.

**Why:** Lets the answer arrive on a phone without appearing on the (possibly shared) main display. Telegram is used because it has a trivial bot send API; WhatsApp has no comparable personal API (would need the Business Cloud API).

**JS logic:** `POST https://api.telegram.org/bot{token}/sendMessage` with `{chat_id, text, disable_web_page_preview:true}`; chunk to ≤4096 chars; specific errors for 401 (bad token) and "chat not found" (you must message the bot first so it can reply).

**Desktop translation (Python):**
```python
import requests
def send_to_telegram(token, chat_id, text):
    text = (text or "").strip() or "(empty response)"
    for i in range(0, len(text), 4000):
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text[i:i+4000], "disable_web_page_preview": True},
            timeout=30,
        )
        if r.status_code == 401:
            raise RuntimeError("Telegram rejected the bot token (401).")
        if not r.ok:
            detail = (r.json() or {}).get("description", "")
            if "chat not found" in detail.lower():
                raise RuntimeError("Chat ID not found — message your bot first, then re-fetch the chat ID.")
            raise RuntimeError(f"Telegram error {r.status_code}: {detail}")
```
- Add an "Output" setting: On-screen vs Telegram-only, with token + chat-id fields and a "Send test message" button.
- Gate every answer-rendering path on the mode: in Telegram mode, suppress the on-screen result window and the loading/“analyzing” UI; send the start notice + answer to Telegram. Keep *error* messages on screen so a misconfig isn't silent.
- If you have an auto-watch feature on desktop, do NOT send the per-trigger start notice from it (it would spam) — only send the final answer when a question is actually found.

---

## 10. Things to NOT port (extension-only)

These were workarounds for browser-platform constraints. The desktop app has none of these problems — skip them:

- **MV3 event-page / service-worker idle-timeout keepalive** (Firefox Bugzilla #1851373 storage-write hack; Chromium 30 s SW termination). Desktop processes don't get killed at 30 s — irrelevant.
- **http→https upgrade CSP override.** Browsers force-upgrade http requests; desktop `requests`/`httpx` call `http://your-owui-host:3050` directly with no upgrade. Irrelevant.
- **Port vs `sendMessage` plumbing.** This was purely to keep the background page alive across a long call — a browser concern.
- **Content-script shadow-DOM injection / region overlay in-page.** Desktop already owns its windows and screen capture; it doesn't inject into a web page.
- **Host-permission flows** (`chrome://extensions` site access, `about:addons` permissions). No analog.
- **CORS messaging.** Desktop HTTP isn't subject to browser CORS.

The desktop app's *advantage* is that it can capture the whole screen at the OS level and call the LLM directly — so the items above simply don't apply.

---

## Suggested order of work

1. **§1 model default** (5 minutes, biggest reliability win).
2. **§6 session padding** + **§3 JSON-mode** (small, safe, high impact).
3. **§4 parser `<think>` stripping** (drop-in).
4. **§2 + §7 OWUI fallback chain** (the core robustness work).
5. **§5 timeout/cancel** (UX + safety).
6. **§8 ask-conversation** (feature).
7. **§9 Telegram** (optional feature).

Items 2–4 are nearly copy-paste translations and will likely fix the same failures on desktop that they fixed in the extension. Item 4's `<think>` stripping is the most likely "missing piece" if the desktop app currently fails on thinking-model output.
