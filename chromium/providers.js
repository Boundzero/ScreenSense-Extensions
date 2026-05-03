// providers.js — browser-side LLM provider abstraction.
//
// Port of screensense/providers.py to vanilla JS using fetch().
// Each provider exposes two methods:
//   - complete_json({imagePngB64, userText, systemPrompt, maxTokens}) -> string
//   - stream({imagePngB64, userText, systemPrompt, maxTokens, onDelta}) -> Promise<string>
//
// Same critical quirks as the Python port:
//   - Anthropic requires `anthropic-dangerous-direct-browser-access: true` for CORS.
//   - Open WebUI tries OpenAI-vision format, falls back to Ollama-native on the
//     telltale "NoneType has no attribute" error.
//   - Open WebUI requests need a browser-like User-Agent ONLY when behind a
//     Cloudflare tunnel — but browsers force their own UA, so we can't override
//     it from fetch(). The Cloudflare tunnel BIC issue therefore doesn't apply
//     here (the request already comes from a real browser).
//   - num_ctx sent in request body for OWUI, never assumed.

// ============================================================================
// Anthropic
// ============================================================================

export class AnthropicProvider {
  static id = "anthropic";
  static displayName = "Anthropic Claude";
  static keyPrefix = "sk-ant-";
  static defaultModel = "claude-sonnet-4-6";
  static models = [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ];

  constructor({ apiKey, model }) {
    this.apiKey = apiKey;
    this.model = model || AnthropicProvider.defaultModel;
  }

  async complete_json({ imagePngB64, userText, systemPrompt, maxTokens = 4000, signal }) {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: imagePngB64 },
          },
          { type: "text", text: userText },
        ],
      }],
    };

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
        signal,
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new ProviderError(
        `Anthropic ${resp.status}: ${await safeText(resp)}`,
        resp.status,
      );
    }
    const data = await resp.json();
    return (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");
  }

  async stream({ imagePngB64, userText, systemPrompt, maxTokens = 1024, onDelta, signal }) {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      stream: true,
      messages: [{
        role: "user",
        content: imagePngB64
          ? [
              { type: "image", source: { type: "base64", media_type: "image/png", data: imagePngB64 } },
              { type: "text", text: userText || "What's on this screen?" },
            ]
          : [{ type: "text", text: userText }],
      }],
    };

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
        signal,
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new ProviderError(
        `Anthropic ${resp.status}: ${await safeText(resp)}`,
        resp.status,
      );
    }

    let full = "";
    await readSSE(resp, (event) => {
      // Anthropic SSE: each event has `type` and JSON `data`.
      if (event.event === "content_block_delta") {
        const delta = event.data?.delta?.text;
        if (delta) {
          full += delta;
          onDelta?.(delta);
        }
      }
    });
    return full;
  }

  /** Continue a conversation. `turns` is a neutral array of
   *  { role: "user"|"assistant", text } objects (after the first turn).
   *  `imagePngB64` is the original screenshot, attached to the first user
   *  turn. systemPrompt is sent separately (Anthropic convention). */
  async streamConversation({ turns, imagePngB64, systemPrompt, maxTokens = 1024, onDelta, signal }) {
    const messages = turns.map((t, i) => {
      if (i === 0 && t.role === "user" && imagePngB64) {
        return {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: imagePngB64 } },
            { type: "text", text: t.text },
          ],
        };
      }
      return { role: t.role, content: [{ type: "text", text: t.text }] };
    });

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      signal,
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens, system: systemPrompt, stream: true, messages }),
    });
    if (!resp.ok) {
      throw new ProviderError(`Anthropic ${resp.status}: ${await safeText(resp)}`, resp.status);
    }
    let full = "";
    await readSSE(resp, (event) => {
      if (event.event === "content_block_delta") {
        const delta = event.data?.delta?.text;
        if (delta) { full += delta; onDelta?.(delta); }
      }
    });
    return full;
  }
}

// ============================================================================
// OpenAI
// ============================================================================

export class OpenAIProvider {
  static id = "openai";
  static displayName = "OpenAI ChatGPT";
  static keyPrefix = "sk-";
  static defaultModel = "gpt-5.4";
  static models = [
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-4o",
  ];

  constructor({ apiKey, model, baseUrl }) {
    this.apiKey = apiKey;
    this.model = model || OpenAIProvider.defaultModel;
    this.baseUrl = (baseUrl || "https://api.openai.com").replace(/\/+$/, "");
  }

  async complete_json({ imagePngB64, userText, systemPrompt, maxTokens = 4000, signal }) {
    // Skip Responses API for browser fetch — Chat Completions is universal and
    // works against self-hosted OpenAI-compatible servers too.
    const dataUrl = `data:image/png;base64,${imagePngB64}`;
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    };

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        signal,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new ProviderError(
        `OpenAI ${resp.status}: ${await safeText(resp)}`,
        resp.status,
      );
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || "";
  }

  async stream({ imagePngB64, userText, systemPrompt, maxTokens = 1024, onDelta, signal }) {
    const messages = [{ role: "system", content: systemPrompt }];
    if (imagePngB64) {
      const dataUrl = `data:image/png;base64,${imagePngB64}`;
      messages.push({
        role: "user",
        content: [
          { type: "text", text: userText || "What's on this screen?" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      });
    } else {
      messages.push({ role: "user", content: userText });
    }

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        signal,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        stream: true,
        messages,
      }),
    });

    if (!resp.ok) {
      throw new ProviderError(
        `OpenAI ${resp.status}: ${await safeText(resp)}`,
        resp.status,
      );
    }

    let full = "";
    await readSSE(resp, (event) => {
      // OpenAI streams `data: {...}` lines without a custom event name.
      const delta = event.data?.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        onDelta?.(delta);
      }
    });
    return full;
  }

  /** Continue a conversation. `turns` is a neutral array of
   *  { role, text }; the original image attaches to the first user turn. */
  async streamConversation({ turns, imagePngB64, systemPrompt, maxTokens = 1024, onDelta, signal }) {
    const messages = [{ role: "system", content: systemPrompt }];
    turns.forEach((t, i) => {
      if (i === 0 && t.role === "user" && imagePngB64) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: t.text },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imagePngB64}` } },
          ],
        });
      } else {
        messages.push({ role: t.role, content: t.text });
      }
    });

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      signal,
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens, stream: true, messages }),
    });
    if (!resp.ok) {
      throw new ProviderError(`OpenAI ${resp.status}: ${await safeText(resp)}`, resp.status);
    }
    let full = "";
    await readSSE(resp, (event) => {
      const delta = event.data?.choices?.[0]?.delta?.content;
      if (delta) { full += delta; onDelta?.(delta); }
    });
    return full;
  }
}

// ============================================================================
// Google Gemini
// ============================================================================

export class GoogleProvider {
  static id = "google";
  static displayName = "Google Gemini";
  static keyPrefix = "";
  static defaultModel = "gemini-3-flash-preview";
  static models = [
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-lite",
  ];

  constructor({ apiKey, model }) {
    this.apiKey = apiKey;
    this.model = model || GoogleProvider.defaultModel;
  }

  async complete_json({ imagePngB64, userText, systemPrompt, maxTokens = 4000, signal }) {
    const body = {
      contents: [{
        role: "user",
        parts: [
          { inline_data: { mime_type: "image/png", data: imagePngB64 } },
          { text: userText },
        ],
      }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
      },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const resp = await fetch(url, {
        signal,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new ProviderError(
        `Gemini ${resp.status}: ${await safeText(resp)}`,
        resp.status,
      );
    }
    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    return parts.map(p => p.text || "").join("");
  }

  async stream({ imagePngB64, userText, systemPrompt, maxTokens = 1024, onDelta, signal }) {
    const parts = [];
    if (imagePngB64) {
      parts.push({ inline_data: { mime_type: "image/png", data: imagePngB64 } });
    }
    parts.push({ text: userText || "What's on this screen?" });

    const body = {
      contents: [{ role: "user", parts }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: maxTokens },
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
    const resp = await fetch(url, {
        signal,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new ProviderError(
        `Gemini ${resp.status}: ${await safeText(resp)}`,
        resp.status,
      );
    }

    let full = "";
    await readSSE(resp, (event) => {
      const chunkParts = event.data?.candidates?.[0]?.content?.parts || [];
      for (const p of chunkParts) {
        if (p.text) {
          full += p.text;
          onDelta?.(p.text);
        }
      }
    });
    return full;
  }

  /** Continue a conversation. `turns` is a neutral array of { role, text };
   *  Gemini uses role "model" for assistant turns. Image attaches to the
   *  first user turn. */
  async streamConversation({ turns, imagePngB64, systemPrompt, maxTokens = 1024, onDelta, signal }) {
    const contents = turns.map((t, i) => {
      const role = t.role === "assistant" ? "model" : "user";
      const parts = [];
      if (i === 0 && t.role === "user" && imagePngB64) {
        parts.push({ inline_data: { mime_type: "image/png", data: imagePngB64 } });
      }
      parts.push({ text: t.text });
      return { role, parts };
    });

    const body = {
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: maxTokens },
    };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
    const resp = await fetch(url, {
      signal,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new ProviderError(`Gemini ${resp.status}: ${await safeText(resp)}`, resp.status);
    }
    let full = "";
    await readSSE(resp, (event) => {
      const chunkParts = event.data?.candidates?.[0]?.content?.parts || [];
      for (const p of chunkParts) {
        if (p.text) { full += p.text; onDelta?.(p.text); }
      }
    });
    return full;
  }
}

export class OpenWebUIProvider {
  static id = "openwebui";
  static displayName = "Open WebUI";
  static keyPrefix = "";
  static defaultModel = "";  // fetched live
  static models = [];        // populated via listModels()

  constructor({ apiKey, model, baseUrl, cfClientId, cfClientSecret }) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.cfClientId = cfClientId || "";
    this.cfClientSecret = cfClientSecret || "";
    if (!this.baseUrl) {
      throw new Error("Open WebUI requires a base URL.");
    }
  }

  _headers(extra = {}) {
    const h = { "content-type": "application/json", ...extra };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    if (this.cfClientId) h["CF-Access-Client-Id"] = this.cfClientId;
    if (this.cfClientSecret) h["CF-Access-Client-Secret"] = this.cfClientSecret;
    return h;
  }

  /** Open WebUI 0.9.5 has a server-side bug (github.com/open-webui/open-webui#24550)
   *  where `/api/chat/completions` requests that lack session metadata fields
   *  trip a `'NoneType' object has no attribute 'startswith'` error in
   *  `process_chat`. The web UI doesn't hit it because it always sends
   *  `chat_id` / `session_id` / `parent_id`. Padding our API-style requests
   *  with the same fields routes them through the working code path.
   *
   *  These IDs are placeholders — we don't use the OWUI chat history feature,
   *  and the server doesn't care that they don't reference real records;
   *  it just needs them to be non-null strings so the .startswith() works. */
  _withSessionPadding(body) {
    return {
      ...body,
      chat_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      id: crypto.randomUUID(),       // per-message ID, also expected by some versions
      parent_id: null,
    };
  }

  async listModels({ signal } = {}) {
    const url = `${this.baseUrl}/api/models`;
    let resp;
    try {
      resp = await fetch(url, {
        signal,
        method: "GET",
        headers: this._headers(),
      });
    } catch (e) {
      throw enrichFetchError(e, url);
    }
    if (!resp.ok) {
      throw new ProviderError(
        `Open WebUI ${resp.status}: ${await safeText(resp)}`,
        resp.status,
      );
    }
    const data = await resp.json();
    // OWUI returns { data: [{ id, name, ... }, ...] }
    const list = Array.isArray(data) ? data : (data.data || data.models || []);
    return list.map(m => m.id || m.name).filter(Boolean);
  }

  async complete_json({ imagePngB64, userText, systemPrompt, maxTokens = 4000, signal }) {
    // Try OpenAI-vision format first. Three known failure modes route us to
    // the Ollama-native fallback path:
    //
    //   1. Image-handler format mismatch — `image_url` shape isn't accepted
    //      by this OWUI build's preprocessor.
    //
    //   2. OWUI 0.9.5 session-metadata bug (#24550) — `'NoneType'.startswith`
    //      in `process_chat`. Our request bodies already include session
    //      padding to dodge this; if it STILL hits, the workaround isn't
    //      taking on this version.
    //
    //   3. Both streaming and non-streaming returned 200 OK with an empty
    //      body. The OpenAI-compat path is broken for some reason (Pipeline,
    //      Function, upstream model misconfig). The Ollama-native endpoint
    //      bypasses `process_chat` entirely and usually works.
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

  _isEmptyResponseError(msg) {
    return /empty response/i.test(msg) && /open\s*webui/i.test(msg);
  }

  _isImageHandlerError(msg) {
    // Match errors specifically about the image preprocessor. The bare
    // "NoneType has no attribute" pattern is too broad — Open WebUI 0.9.5
    // also throws that for a completely unrelated session-metadata bug
    // (#24550), and falling back to the Ollama path for THAT one just
    // produces a different error. Require an image-handling keyword nearby.
    return /image[_ ]?(handler|processor|input|url)/i.test(msg)
        || /unsupported image/i.test(msg)
        || (/NoneType.*attribute/i.test(msg) && /image/i.test(msg));
  }

  /** Detect the OWUI 0.9.5 `process_chat` session-metadata bug specifically. */
  _is095SessionBug(msg) {
    // The error text from OWUI is: 'NoneType' object has no attribute 'startswith'
    return /'NoneType'\s*object has no attribute\s*'startswith'/i.test(msg);
  }

  async _openAIFormatComplete({ imagePngB64, userText, systemPrompt, maxTokens, signal }) {
    // First attempt: streaming. Cloudflare Tunnel + long-generation thinking
    // models can stall non-streamed requests at the tunnel buffer layer,
    // so we ask for SSE by default and accumulate chunks.
    const result = await this._openAIChatCompletions({
      imagePngB64, userText, systemPrompt, maxTokens, stream: true, signal,
    });

    // If streaming returned zero data, retry without streaming. Various OWUI
    // configurations (custom Pipelines, certain upstream backends, some
    // tunnel/proxy stacks) accept `stream:true` but return either a non-SSE
    // body or an immediately-closed empty stream. Falling back to a regular
    // request usually recovers the response.
    if (!result) {
      const nonStream = await this._openAIChatCompletions({
        imagePngB64, userText, systemPrompt, maxTokens, stream: false, signal,
      });
      if (!nonStream) {
        throw new ProviderError(
          "Open WebUI returned an empty response on both streaming and non-streaming requests. The server accepted the request (200 OK) but produced no model output. Check the OWUI server logs — most likely cause is a broken Pipeline/Function or an upstream model that failed silently. (Falling back to /ollama/api/chat if the model is locally hosted.)"
        );
      }
      return nonStream;
    }
    return result;
  }

  /** One round-trip to OWUI's /api/chat/completions endpoint. Streaming
   *  controlled by the `stream` flag. Returns the accumulated text or
   *  empty string if the server produced nothing. */
  async _openAIChatCompletions({ imagePngB64, userText, systemPrompt, maxTokens, stream, signal }) {
    const dataUrl = `data:image/png;base64,${imagePngB64}`;
    const body = this._withSessionPadding({
      model: this.model,
      max_tokens: maxTokens,
      stream: !!stream,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      // Force JSON mode — both spellings of the same option. response_format
      // is the OpenAI spelling; `format: "json"` is the Ollama-native one.
      // OWUI/Ollama recognizes whichever the upstream model supports.
      // This is critical for thinking models like Qwen3.x — without JSON mode,
      // they burn the entire token budget on reasoning prose and never emit
      // the answer JSON. With it, the model is constrained to emit valid JSON
      // and self-terminates as soon as the JSON object closes.
      response_format: { type: "json_object" },
      format: "json",
      options: { num_ctx: 8192 },
    });

    const url = `${this.baseUrl}/api/chat/completions`;
    let resp;
    try {
      resp = await fetch(url, {
        signal,
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw enrichFetchError(e, url);
    }

    if (!resp.ok) {
      throw new ProviderError(
        `Open WebUI ${resp.status}: ${await safeText(resp)}`,
        resp.status,
      );
    }

    // Decide whether we actually got a streaming body. If the server
    // ignored stream:true and returned a regular JSON response, read it
    // as JSON. If we asked for non-streaming, ditto.
    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    const isSSE = contentType.includes("text/event-stream") || contentType.includes("event-stream");

    if (stream && isSSE) {
      // Read the SSE stream and accumulate.
      let content = "";
      let thinking = "";
      let sawAny = false;
      await readSSE(resp, (event) => {
        const delta = event.data?.choices?.[0]?.delta;
        if (!delta) return;
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          sawAny = true;
        }
        // OWUI passes through various reasoning-field names depending on
        // the upstream model.
        const t = delta.reasoning ?? delta.reasoning_content ?? delta.thinking;
        if (typeof t === "string" && t) {
          thinking += t;
          sawAny = true;
        }
      });
      if (!sawAny) return "";
      return content || thinking;
    }

    // Non-streaming path (either we asked for it, or the server downgraded).
    // Read as JSON. Reasoning models put final output in `thinking` when
    // `content` is empty.
    const text = await resp.text();
    if (!text.trim()) return "";
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Server returned something non-JSON. Pass it through as-is for the
      // parser; the diagnose path will give us a useful preview.
      return text;
    }
    const msg = data.choices?.[0]?.message || {};
    return msg.content || msg.reasoning || msg.reasoning_content || msg.thinking || "";
  }

  async _ollamaFormatComplete({ imagePngB64, userText, systemPrompt, maxTokens, signal }) {
    // Stream the Ollama-native path too, for the same tunnel-keepalive reason
    // as the OpenAI-format streamer above. Ollama uses NDJSON (one JSON
    // object per line), not SSE.
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText, images: [imagePngB64] },
      ],
      stream: true,
      // Ollama-native JSON mode. Same purpose as response_format on the
      // OpenAI path: constrains thinking models to emit valid JSON and
      // self-terminate instead of burning the token budget on prose.
      format: "json",
      options: { num_ctx: 8192, num_predict: maxTokens },
    };

    const url = `${this.baseUrl}/ollama/api/chat`;
    let resp;
    try {
      resp = await fetch(url, {
        signal,
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw enrichFetchError(e, url);
    }

    if (!resp.ok) {
      throw new ProviderError(
        `Open WebUI (Ollama path) ${resp.status}: ${await safeText(resp)}`,
        resp.status,
      );
    }

    let content = "";
    let thinking = "";
    let sawAny = false;
    await readNDJSON(resp, (chunk) => {
      const m = chunk?.message;
      if (!m) return;
      if (typeof m.content === "string" && m.content) { content += m.content; sawAny = true; }
      if (typeof m.thinking === "string" && m.thinking) { thinking += m.thinking; sawAny = true; }
    });
    if (!sawAny) {
      throw new ProviderError(
        "Open WebUI's Ollama-native endpoint (/ollama/api/chat) accepted the request (200 OK) but emitted no message chunks. The model may have failed to load on the Ollama backend, or the model doesn't support image inputs. Try a different model from the dropdown — and check `docker logs open-webui` / `ollama logs` for the actual error."
      );
    }
    return content || thinking;
  }

  async stream({ imagePngB64, userText, systemPrompt, maxTokens = 1024, onDelta, signal }) {
    const messages = [{ role: "system", content: systemPrompt }];
    if (imagePngB64) {
      const dataUrl = `data:image/png;base64,${imagePngB64}`;
      messages.push({
        role: "user",
        content: [
          { type: "text", text: userText || "What's on this screen?" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      });
    } else {
      messages.push({ role: "user", content: userText });
    }
    return this._streamMessages({ messages, maxTokens, onDelta, signal });
  }

  /** Continue a conversation. Accepts the neutral { turns, imagePngB64,
   *  systemPrompt } form (same signature as the other providers) and builds
   *  the OpenAI-style message array, embedding the original image in the
   *  first user turn. No new screenshot is taken. */
  async streamConversation({ turns, imagePngB64, systemPrompt, maxTokens = 1024, onDelta, signal }) {
    const messages = [{ role: "system", content: systemPrompt }];
    turns.forEach((t, i) => {
      if (i === 0 && t.role === "user" && imagePngB64) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: t.text },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imagePngB64}` } },
          ],
        });
      } else {
        messages.push({ role: t.role, content: t.text });
      }
    });
    return this._streamMessages({ messages, maxTokens, onDelta, signal });
  }

  /** Shared transport for stream() and streamConversation(). Sends a
   *  pre-built OpenAI-style message array, handles SSE vs JSON downgrade,
   *  empty-response retry, and the Ollama-native fallback. */
  async _streamMessages({ messages, maxTokens, onDelta, signal }) {
    const url = `${this.baseUrl}/api/chat/completions`;
    let resp;
    try {
      resp = await fetch(url, {
        signal,
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(this._withSessionPadding({
          model: this.model,
          max_tokens: maxTokens,
          stream: true,
          messages,
          options: { num_ctx: 8192 },
        })),
      });
    } catch (e) {
      throw enrichFetchError(e, url);
    }

    if (!resp.ok) {
      throw new ProviderError(
        `Open WebUI ${resp.status}: ${await safeText(resp)}`,
        resp.status,
      );
    }

    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    const isSSE = contentType.includes("text/event-stream") || contentType.includes("event-stream");
    console.log(`[ScreenSense] ask stream: HTTP ${resp.status}, content-type="${contentType}", branch=${isSSE ? "SSE" : "JSON"}`);

    if (isSSE) {
      let full = "";
      let eventCount = 0;
      await readSSE(resp, (event) => {
        eventCount++;
        const delta = event.data?.choices?.[0]?.delta;
        if (!delta) return;
        if (typeof delta.content === "string" && delta.content) {
          full += delta.content;
          onDelta?.(delta.content);
        }
        const t = delta.reasoning ?? delta.reasoning_content ?? delta.thinking;
        if (typeof t === "string" && t) {
          full += t;
          onDelta?.(t);
        }
      });
      console.log(`[ScreenSense] ask SSE done: ${eventCount} events, ${full.length} content chars`);
      if (full) return full;
      console.log("[ScreenSense] ask SSE empty — retrying non-streaming");
      const retry = await this._streamFallbackNonStreaming({ messages, maxTokens, signal });
      console.log(`[ScreenSense] ask non-stream retry: ${retry.length} chars. Preview: ${JSON.stringify(retry.slice(0, 120))}`);
      if (retry) { onDelta?.(retry); return retry; }
      return "";
    }

    // Server returned a non-streaming JSON body.
    const text = await resp.text();
    if (!text.trim()) {
      throw new ProviderError(
        "Open WebUI returned an empty response. The server accepted the request (200 OK) but produced no model output. Check the OWUI server logs."
      );
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      onDelta?.(text);
      return text;
    }
    const oaMsg = data.choices?.[0]?.message || {};
    const ollamaMsg = data.message || {};
    const out =
      oaMsg.content || oaMsg.reasoning || oaMsg.reasoning_content || oaMsg.thinking ||
      ollamaMsg.content || ollamaMsg.thinking ||
      data.choices?.[0]?.text ||
      "";
    if (out) { onDelta?.(out); return out; }

    console.warn(`[ScreenSense] ask OpenAI-compat empty. Raw (first 600): ${text.slice(0, 600)}`);
    console.log("[ScreenSense] ask falling back to /ollama/api/chat");
    const ollamaOut = await this._askViaOllamaNative({ messages, maxTokens, signal, onDelta });
    return ollamaOut;
  }

  /** Ask via the Ollama-native /ollama/api/chat endpoint (NDJSON stream).
   *  Used as a fallback when the OpenAI-compat path returns empty content.
   *  Converts our OpenAI-style messages (which may have array content with
   *  image_url parts) into Ollama-native shape (flat content + images[]). */
  async _askViaOllamaNative({ messages, maxTokens, signal, onDelta }) {
    // Flatten OpenAI-style messages to Ollama-native.
    const native = messages.map((m) => {
      if (Array.isArray(m.content)) {
        let textPart = "";
        const images = [];
        for (const part of m.content) {
          if (part.type === "text") textPart += part.text;
          else if (part.type === "image_url") {
            const url = part.image_url?.url || "";
            const comma = url.indexOf(",");
            images.push(comma >= 0 ? url.slice(comma + 1) : url);
          }
        }
        const out = { role: m.role, content: textPart };
        if (images.length) out.images = images;
        return out;
      }
      return { role: m.role, content: m.content };
    });

    const url = `${this.baseUrl}/ollama/api/chat`;
    let resp;
    try {
      resp = await fetch(url, {
        signal,
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify({
          model: this.model,
          messages: native,
          stream: true,
          options: { num_ctx: 8192, num_predict: maxTokens },
        }),
      });
    } catch (e) {
      throw enrichFetchError(e, url);
    }
    if (!resp.ok) {
      throw new ProviderError(`Open WebUI (Ollama path) ${resp.status}: ${await safeText(resp)}`, resp.status);
    }
    let full = "";
    await readNDJSON(resp, (chunk) => {
      const m = chunk?.message;
      if (!m) return;
      if (typeof m.content === "string" && m.content) { full += m.content; onDelta?.(m.content); }
      if (typeof m.thinking === "string" && m.thinking) { full += m.thinking; onDelta?.(m.thinking); }
    });
    console.log(`[ScreenSense] ask Ollama-native fallback: ${full.length} chars`);
    return full;
  }

  /** Retry an ask request with stream:false. Used when the SSE stream
   *  completes with zero content (some OWUI/model combos accept stream:true
   *  for vision but emit nothing). Returns the full text or "". */
  async _streamFallbackNonStreaming({ messages, maxTokens, signal }) {
    const url = `${this.baseUrl}/api/chat/completions`;
    let resp;
    try {
      resp = await fetch(url, {
        signal,
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(this._withSessionPadding({
          model: this.model,
          max_tokens: maxTokens,
          stream: false,
          messages,
          options: { num_ctx: 8192 },
        })),
      });
    } catch (e) {
      throw enrichFetchError(e, url);
    }
    if (!resp.ok) {
      throw new ProviderError(`Open WebUI ${resp.status}: ${await safeText(resp)}`, resp.status);
    }
    const text = await resp.text();
    if (!text.trim()) return "";
    let data;
    try { data = JSON.parse(text); } catch { return text; }
    const m = data.choices?.[0]?.message || {};
    return m.content || m.reasoning || m.reasoning_content || m.thinking || "";
  }
}

// ============================================================================
// Provider factory + registry
// ============================================================================

export const PROVIDERS = {
  [AnthropicProvider.id]: AnthropicProvider,
  [OpenAIProvider.id]:    OpenAIProvider,
  [GoogleProvider.id]:    GoogleProvider,
  [OpenWebUIProvider.id]: OpenWebUIProvider,
};

export function makeProvider(id, config) {
  const Cls = PROVIDERS[id];
  if (!Cls) throw new Error(`Unknown provider: ${id}`);
  return new Cls(config);
}

// ============================================================================
// Helpers
// ============================================================================

export class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function safeText(resp) {
  try {
    return (await resp.text()).slice(0, 500);
  } catch {
    return "(no body)";
  }
}

/** Wrap a fetch TypeError ("Failed to fetch", "NetworkError when attempting...")
 *  into a ProviderError that carries the URL we tried, so humanizeProviderError
 *  can give targeted advice (especially about the http→https upgrade trap).
 *  Preserves AbortError identity so callers can distinguish cancellation from
 *  real network failures. */
function enrichFetchError(err, attemptedUrl) {
  const msg = String(err?.message || err);
  const wrapped = new ProviderError(`fetch failed (${msg}) for ${attemptedUrl}`);
  wrapped.attemptedUrl = attemptedUrl;
  wrapped.cause = err;
  if (err?.name === "AbortError") {
    wrapped.name = "AbortError";
  }
  return wrapped;
}

/** Read an SSE stream. Each `data:` line is parsed as JSON and passed to onEvent
 *  as { event, data }. Handles "data: [DONE]" sentinel. */
async function readSSE(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let currentEvent = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);

      if (line === "") {
        currentEvent = null;
        continue;
      }
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const data = JSON.parse(payload);
          onEvent({ event: currentEvent, data });
        } catch {
          // ignore non-JSON keepalives
        }
      }
    }
  }
}

/** Read a newline-delimited JSON stream (Ollama's native chat format).
 *  Each non-empty line is parsed as JSON and passed to onChunk. */
async function readNDJSON(resp, onChunk) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, "").trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onChunk(JSON.parse(line));
      } catch {
        // ignore malformed lines (keepalives etc)
      }
    }
  }
  // Trailing chunk without newline.
  const tail = buf.trim();
  if (tail) {
    try { onChunk(JSON.parse(tail)); } catch {}
  }
}

/** Robust JSON extractor — handles markdown fences, prose preambles, balanced
 *  brace scanning. Direct port of QuizWorker._parse_json, plus thinking-model
 *  tag stripping for Qwen-family models. */
export function parseJsonFromModelOutput(text) {
  if (!text) return null;
  text = text.trim();

  // Strip thinking-model wrappers. Qwen and some R1-derived models wrap
  // chain-of-thought in <think>...</think> before emitting the actual
  // answer. If the closing </think> is missing (truncated mid-thought),
  // strip from <think> to the end and let the parser hunt for JSON in
  // what remains — which is often empty, but worth trying.
  text = stripThinkingTags(text);

  try { return JSON.parse(text); } catch {}

  // Strip code fences.
  const stripped = text
    .replace(/^```(?:json|JSON)?\s*\n?/, "")
    .replace(/\n?\s*```\s*$/, "")
    .trim();
  try { return JSON.parse(stripped); } catch {}

  // Balanced-brace scan from every `{` until one parses.
  let i = text.indexOf("{");
  while (i !== -1) {
    const obj = extractBalancedObject(text, i);
    if (obj) {
      try { return JSON.parse(obj); } catch {}
    }
    i = text.indexOf("{", i + 1);
  }
  return null;
}

/** Strip <think>...</think> blocks (Qwen, DeepSeek-R1-style models).
 *  Also handles unclosed <think> if the response was truncated. */
function stripThinkingTags(text) {
  // Closed blocks: replace each <think>...</think> with empty.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // Unclosed block: if <think> is present but </think> isn't, strip from
  // <think> onward. The actual answer JSON, if it exists at all, would
  // appear AFTER </think> — so an unclosed think tag means we never got
  // to the answer.
  const openIdx = text.search(/<think>/i);
  if (openIdx !== -1 && !/<\/think>/i.test(text)) {
    text = text.slice(0, openIdx).trim();
  }
  return text;
}

function extractBalancedObject(text, start) {
  if (text[start] !== "{") return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function humanizeProviderError(err, providerName, model) {
  const msg = String(err?.message || err);
  const status = err?.status;
  const attemptedUrl = err?.attemptedUrl || "";
  const isOWUI = /Open WebUI/i.test(providerName);
  const isHttpUrl = /^http:\/\//i.test(attemptedUrl);

  // AbortError fires when our client-side timeout or the user's Cancel
  // button aborts the in-flight fetch. Surface this distinctly so the user
  // doesn't think it's a server-side failure.
  if (err?.name === "AbortError" || /aborted|AbortError/i.test(msg)) {
    if (err?.userCancelled) {
      return "Cancelled. The request was stopped before the model finished.";
    }
    return `The request timed out (model didn't respond in time).\n\n` +
      (isOWUI
        ? "If you're on a thinking model like Qwen3.6:27b, it may have entered an infinite reasoning loop. Try:\n" +
          " • A smaller/faster vision model: llama3.2-vision:11b or qwen2.5-vl:7b respond in ~5-15s vs Qwen3.6's 30-300s.\n" +
          " • A non-thinking model — Qwen3.6's thinking mode regularly burns through 4000+ tokens without emitting JSON for image quizzes.\n" +
          " • Check your Ollama logs (`docker logs open-webui` or `ollama logs`) — if you see \"llama runner terminated\" or \"out of memory\", your GPU is over-committed for this model size."
        : "Try a different model, or increase the timeout in providers.js.");
  }

  if (status === 401 || status === 403) {
    if (isOWUI) {
      return `${providerName} rejected the request (auth, ${status}). If your server requires login, paste an API key from Open WebUI → Settings → Account → API Keys. If you're behind Cloudflare Access, fill in the Client ID and Secret.`;
    }
    return `${providerName} rejected the request (auth, ${status}). Check the API key in the popup.`;
  }
  if (status === 404) {
    if (isOWUI) {
      return `${providerName} returned 404. The base URL might be wrong, or the model "${model}" doesn't exist on this server. Click ↻ next to the model select to refresh the list.`;
    }
    return `${providerName} said the model "${model}" doesn't exist. Pick another model in the popup.`;
  }
  if (status === 400 && isOWUI && /'NoneType'\s*object has no attribute\s*'startswith'/i.test(msg)) {
    return [
      `${providerName} hit the known v0.9.5 server bug (#24550) — \`'NoneType'.startswith\` in process_chat.`,
      "",
      "ScreenSense already pads requests with session metadata (chat_id, session_id, id) to dodge this, but your server returned the error anyway. That can happen if:",
      " • A custom Pipeline/Filter/Function on the server strips those fields before process_chat runs.",
      " • Your OWUI version is a fork or build where the padding shape doesn't match.",
      "",
      "Workarounds: (a) disable any active OWUI Pipelines/Functions, (b) update OWUI past 0.9.5 once a fix lands (track github.com/open-webui/open-webui/issues/24550), or (c) for vision queries, ScreenSense will auto-fall-back to the /ollama/api/chat path which bypasses process_chat — if your model is locally hosted, that path should work.",
    ].join("\n");
  }
  if (status === 429) {
    return `${providerName} rate-limited the request. Wait a few seconds and try again.`;
  }
  if (status >= 500) {
    return `${providerName} server error (${status}). Try again, or switch provider.`;
  }
  if (/CORS/i.test(msg)) {
    if (isOWUI) {
      return `${providerName} blocked the request (CORS). Either enable CORS on your Open WebUI server (set CORS_ALLOW_ORIGIN to "*" or include "chrome-extension://*"), or grant host access to your server URL in chrome://extensions → ScreenSense → Details → Site access.`;
    }
    return `${providerName} blocked the request (CORS). Check the host configuration.`;
  }
  if (/Failed to fetch|NetworkError|TypeError|fetch failed/i.test(msg)) {
    if (isOWUI) {
      const lines = [`Couldn't reach ${providerName}${attemptedUrl ? ` at ${attemptedUrl}` : ""}.`];
      if (isHttpUrl) {
        lines.push(
          "",
          "You're using a plain http:// URL. In Chromium the LLM request is made from the extension service worker (not the page), so the usual mixed-content upgrade doesn't apply — a local http Open WebUI should work. If it doesn't, check:",
        );
      } else {
        lines.push("", "Most likely causes:");
      }
      lines.push(
        " • Host access not granted — chrome://extensions → ScreenSense → Details → Site access → \"On all sites\". (On Edge: edge://extensions.)",
        " • Base URL wrong — include protocol, e.g. \"http://localhost:8080\" not \"localhost:8080\".",
        " • Server not running — open the URL in a browser tab to confirm.",
        " • Self-signed HTTPS cert — visit the URL once in a normal tab and accept the cert.",
      );
      return lines.join("\n");
    }
    return `Network error reaching ${providerName}. Check your connection or the base URL.`;
  }
  return `${providerName} error: ${msg.slice(0, 300)}`;
}
