// content.js — runs in every page. Handles:
//   - Region picker (drag overlay)
//   - Answer panel (rendered correct answer + rationale)
//   - DOM-based highlighting of correct answers on the page
//   - Mutation-observer watcher that pings background when the page changes
//
// Communicates with background via runtime.sendMessage (request/response) and
// receives push messages (quiz-result, toast, trigger, set-watcher) via
// runtime.onMessage.

(() => {
  const api = (typeof browser !== "undefined") ? browser : chrome;

  // Stylesheet for our shadow-DOM UI. Kept inline so we don't depend on
  // fetch + web_accessible_resources to load it.
  const SHADOW_CSS = `
.ss-overlay-root, .ss-highlight-root, .ss-panel-root, .ss-toast-root {
  position: absolute; inset: 0; pointer-events: none;
}

/* ---- Region picker ---- */
.ss-region-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.25); cursor: crosshair;
}
.ss-region-rect {
  position: absolute;
  border: 2px solid #ffd60a;
  background: rgba(255,214,10,0.12);
  pointer-events: none;
}
.ss-region-hint {
  position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
  background: rgba(20,20,22,0.92); color: #f1f1f3;
  padding: 7px 14px; border-radius: 999px;
  font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  pointer-events: none;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
}

/* ---- Highlight box ---- */
.ss-highlight-box {
  position: fixed;
  border: 3px solid #ffd60a;
  border-radius: 4px;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 0 16px rgba(255,214,10,0.55);
  pointer-events: none;
  transition: opacity 0.2s;
  animation: ss-pulse 1.4s ease-in-out 3;
}
@keyframes ss-pulse {
  0%, 100% { box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 0 16px rgba(255,214,10,0.55); }
  50%      { box-shadow: 0 0 0 1px rgba(0,0,0,0.5), 0 0 26px rgba(255,214,10,0.85); }
}
.ss-highlight-tag {
  position: absolute; top: -22px; left: -3px;
  background: #ffd60a; color: #000;
  padding: 2px 7px; border-radius: 4px 4px 0 0;
  font: 700 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  white-space: nowrap;
}

/* ---- Panel ---- */
.ss-panel {
  position: fixed; top: 16px; right: 16px; width: 360px;
  max-width: calc(100vw - 32px); max-height: calc(100vh - 32px);
  background: rgba(26,26,28,0.97); color: #f1f1f3;
  border: 1px solid #2e2e32; border-radius: 10px;
  overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,0.45);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  display: flex; flex-direction: column;
  pointer-events: auto;
}
.ss-panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid #2e2e32; user-select: none;
}
.ss-panel-title { font-weight: 600; font-size: 13px; }
.ss-panel-close {
  cursor: pointer; width: 22px; height: 22px; border-radius: 4px;
  display: grid; place-items: center; font-size: 18px; color: #9a9aa1;
  transition: background 0.1s, color 0.1s;
}
.ss-panel-close:hover { background: #2e2e32; color: #f1f1f3; }
.ss-panel-body { padding: 12px 14px 14px; overflow-y: auto; }

.ss-labelled { margin-bottom: 10px; }
.ss-label {
  font-size: 10.5px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.5px; color: #9a9aa1; margin-bottom: 2px;
}
.ss-labelled-content { font-size: 13px; }

.ss-answer-block {
  background: rgba(255,214,10,0.07);
  border-left: 3px solid #ffd60a;
  padding: 8px 10px; border-radius: 0 6px 6px 0; margin-bottom: 8px;
}
.ss-answer-head { display: flex; align-items: flex-start; gap: 8px; }
.ss-answer-num {
  background: #ffd60a; color: #000; font-weight: 700;
  width: 22px; height: 22px; border-radius: 4px;
  display: grid; place-items: center; font-size: 12px; flex: 0 0 22px;
}
.ss-answer-text { font-weight: 500; flex: 1 1 auto; }
.ss-answer-rationale {
  font-size: 12px; color: #c0c0c8; margin-top: 6px; padding-left: 30px;
}
.ss-panel-meta {
  font-size: 11px; color: #9a9aa1;
  margin-top: 10px; padding-top: 10px; border-top: 1px solid #2e2e32;
}
.ss-ask-output { white-space: pre-wrap; font-size: 13px; }

/* Conversation view */
.ss-ask-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 50vh;
  overflow-y: auto;
}
.ss-ask-turn { font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
.ss-ask-turn-user {
  align-self: flex-end;
  background: #2b3a4a;
  color: #e8eef5;
  padding: 6px 10px;
  border-radius: 10px 10px 2px 10px;
  max-width: 85%;
}
.ss-ask-turn-assistant {
  align-self: flex-start;
  color: #f1f1f3;
  max-width: 100%;
}
.ss-ask-inputrow {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  border-top: 1px solid #2e2e32;
  padding-top: 10px;
}
.ss-ask-input {
  flex: 1 1 auto;
  background: #1a1a1c;
  color: #f1f1f3;
  border: 1px solid #3a3a40;
  border-radius: 6px;
  padding: 7px 10px;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  resize: none;
  max-height: 96px;
  min-height: 18px;
}
.ss-ask-input:focus { outline: none; border-color: #4a7ab8; }
.ss-ask-send {
  flex: 0 0 auto;
  background: #3a5a82;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.ss-ask-send:hover { background: #436a96; }
.ss-ask-send:disabled { opacity: 0.5; cursor: default; }

.ss-loading-status {
  font-size: 13px;
  color: #c0c0c8;
}
.ss-loading-elapsed {
  font-size: 11px;
  color: #9a9aa1;
  margin-top: 8px;
  font-family: "Segoe UI Mono", "SF Mono", Menlo, monospace;
}
.ss-cancel-btn {
  display: inline-block;
  margin-top: 12px;
  background: #2e2e32;
  color: #f1f1f3;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.ss-cancel-btn:hover { background: #3a3a40; }

/* ---- Toast ---- */
.ss-toast {
  position: fixed; top: 16px; left: 50%;
  transform: translate(-50%, -10px);
  background: rgba(26,26,28,0.97); color: #f1f1f3;
  border: 1px solid #2e2e32;
  padding: 10px 16px; border-radius: 8px;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  max-width: min(640px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0; pointer-events: auto;
  transition: opacity 0.2s, transform 0.2s;
  box-shadow: 0 8px 30px rgba(0,0,0,0.4);
}
.ss-toast.visible { opacity: 1; transform: translate(-50%, 0); }
.ss-toast-error { border-color: #ef4444; }
.ss-toast-warn  { border-color: #f59e0b; }
.ss-toast-info  { border-color: #3b82f6; }
.ss-toast-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.ss-toast-btn {
  cursor: pointer;
  background: #2e2e32;
  color: #f1f1f3;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 4px 10px;
  font: 500 11px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.ss-toast-btn:hover { background: #3a3a40; }
`;

  // Re-entrancy guard. We want to make sure:
  //   (a) Re-injection (e.g. extension upgrade, popup self-heal) doesn't
  //       leave two copies of the script fighting each other.
  //   (b) If a *previous* injection THREW before registering its message
  //       listener, the next injection isn't blocked by the guard — that
  //       would leave the page stuck with no listener forever.
  //
  // Strategy: the guard is set at the very end of init, AFTER listeners are
  // registered. Earlier injections that crashed mid-init are effectively
  // unmarked and a fresh inject takes over. The cost: a crashed-then-re-injected
  // page has two "ghost" shadow-DOM hosts in the DOM. That's why we also
  // explicitly remove any previous host before creating a new one.
  const PREVIOUS_HOST = document.getElementById("screensense-host");
  if (PREVIOUS_HOST && window.__screenSenseLoaded) {
    // Healthy existing instance — bail.
    return;
  }
  if (PREVIOUS_HOST) {
    // Stale host from a crashed prior load — remove it before reinitialising.
    try { PREVIOUS_HOST.remove(); } catch {}
  }

  // --------------------------------------------------------------------------
  // Shadow-DOM container
  // --------------------------------------------------------------------------
  // Wrap everything in a Shadow DOM so page CSS can't touch us. Without this,
  // sites with aggressive global selectors (anything matching `div`) wreck
  // the overlay.
  const host = document.createElement("div");
  host.id = "screensense-host";
  host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  // Inject our styles inside the shadow root. We embed the CSS as a string
  // rather than fetching content/content.css because:
  //   1. fetch(runtime.getURL(...)) requires the file to be in
  //      web_accessible_resources, an easy thing to forget.
  //   2. It works identically whether the content script was loaded via
  //      manifest or injected at runtime via scripting.executeScript.
  //   3. It saves a network round-trip on every page load.
  const style = document.createElement("style");
  style.textContent = SHADOW_CSS;
  shadow.appendChild(style);

  // Roots for each UI element. None block pointer events unless explicitly
  // enabled below.
  const overlayRoot   = shadow.appendChild(div("ss-overlay-root"));
  const highlightRoot = shadow.appendChild(div("ss-highlight-root"));
  const panelRoot     = shadow.appendChild(div("ss-panel-root"));
  const toastRoot     = shadow.appendChild(div("ss-toast-root"));

  function div(cls) {
    const d = document.createElement("div");
    d.className = cls;
    return d;
  }

  // --------------------------------------------------------------------------
  // Toast
  // --------------------------------------------------------------------------

  function showToast({ message, level = "info", timeout, id }) {
    // Default timeout scales with message length so the user has time to
    // read long error messages (parse-failure previews, OWUI diagnostics).
    // Errors stay until dismissed.
    if (timeout == null) {
      timeout = level === "error" ? 0 : Math.max(4500, message.length * 30);
    }
    // If an id is given, remove any existing toast with that id first (so a
    // "working…" toast can be replaced by its result).
    if (id) {
      const existing = toastRoot.querySelector(`[data-ss-toast-id="${id}"]`);
      if (existing) existing.remove();
    }
    const t = div(`ss-toast ss-toast-${level}`);
    if (id) t.setAttribute("data-ss-toast-id", id);

    const body = document.createElement("div");
    body.textContent = message;
    t.appendChild(body);

    // For errors (long, dismissable), add Copy + Close buttons.
    if (level === "error" || message.length > 200) {
      const actions = div("ss-toast-actions");
      const copy = div("ss-toast-btn");
      copy.textContent = "Copy";
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(message);
          copy.textContent = "Copied";
          setTimeout(() => { copy.textContent = "Copy"; }, 1500);
        } catch {
          copy.textContent = "Copy failed";
        }
      };
      const close = div("ss-toast-btn");
      close.textContent = "Close";
      close.onclick = () => dismiss();
      actions.appendChild(copy);
      actions.appendChild(close);
      t.appendChild(actions);
    }

    toastRoot.appendChild(t);
    requestAnimationFrame(() => t.classList.add("visible"));

    function dismiss() {
      t.classList.remove("visible");
      setTimeout(() => t.remove(), 300);
    }

    if (timeout > 0) {
      setTimeout(dismiss, timeout);
    }
  }

  /** Dismiss a toast by id (used to clear a persistent "working…" toast). */
  function dismissToast(id) {
    const el = toastRoot.querySelector(`[data-ss-toast-id="${id}"]`);
    if (el) {
      el.classList.remove("visible");
      setTimeout(() => el.remove(), 300);
    }
  }

  // --------------------------------------------------------------------------
  // Region picker
  // --------------------------------------------------------------------------

  let activePicker = null;

  function pickRegion() {
    return new Promise((resolve, reject) => {
      if (activePicker) {
        activePicker.cancel();
      }
      const overlay = div("ss-region-overlay");
      const rect = div("ss-region-rect");
      const hint = div("ss-region-hint");
      hint.textContent = "Drag to select. Esc to cancel.";
      overlay.appendChild(rect);
      overlay.appendChild(hint);
      overlayRoot.appendChild(overlay);
      overlayRoot.style.pointerEvents = "auto";

      let startX = 0, startY = 0, dragging = false;

      function onDown(e) {
        if (e.button !== 0) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        rect.style.left   = startX + "px";
        rect.style.top    = startY + "px";
        rect.style.width  = "0px";
        rect.style.height = "0px";
        rect.classList.add("active");
      }
      function onMove(e) {
        if (!dragging) return;
        const x = Math.min(startX, e.clientX);
        const y = Math.min(startY, e.clientY);
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        rect.style.left   = x + "px";
        rect.style.top    = y + "px";
        rect.style.width  = w + "px";
        rect.style.height = h + "px";
      }
      function onUp(e) {
        if (!dragging) return;
        dragging = false;
        const x = Math.min(startX, e.clientX);
        const y = Math.min(startY, e.clientY);
        const w = Math.abs(e.clientX - startX);
        const h = Math.abs(e.clientY - startY);
        if (w < 10 || h < 10) {
          // Too small — treat as cancel.
          cleanup();
          reject(new Error("Region too small."));
          return;
        }
        // Defer cleanup by one frame so the dragged rect gets removed BEFORE
        // captureVisibleTab runs. Otherwise the screenshot captures our own
        // overlay. (Mirrors the desktop app's 50ms QTimer hack — same root
        // cause, different platform.)
        cleanup();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve({ x, y, width: w, height: h });
        }));
      }
      function onKey(e) {
        if (e.key === "Escape") {
          cleanup();
          reject(new Error("Cancelled."));
        }
      }
      function cleanup() {
        overlay.remove();
        overlayRoot.style.pointerEvents = "none";
        window.removeEventListener("mousedown", onDown, true);
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup",   onUp,   true);
        window.removeEventListener("keydown",   onKey,  true);
        activePicker = null;
      }

      activePicker = { cancel: () => { cleanup(); reject(new Error("Cancelled.")); } };
      window.addEventListener("mousedown", onDown, true);
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup",   onUp,   true);
      window.addEventListener("keydown",   onKey,  true);
    });
  }

  // --------------------------------------------------------------------------
  // Highlight overlay
  // --------------------------------------------------------------------------
  // Two strategies:
  //   A) DOM-based: search the page text for the LLM's answer string,
  //      outline the smallest enclosing element. Most accurate.
  //   B) Pixel-based fallback: if DOM matching fails, draw the box at the
  //      image coords the LLM saw, accounting for any region crop offset.

  let highlightElements = [];

  function clearHighlights() {
    for (const el of highlightElements) el.remove();
    highlightElements = [];
  }

  /** Find the smallest DOM element whose textContent contains the answer.
   *  Returns null if no match. */
  function findDomNodeForAnswer(answer) {
    const candidates = [
      stripPrefix(answer.text),
      answer.text,
    ].filter(t => t && t.length >= 3);

    for (const target of candidates) {
      const node = findSmallestContaining(document.body, target);
      if (node) return node;
    }
    return null;
  }

  function stripPrefix(text) {
    return text.replace(/^\s*[A-Da-d0-9][\.\):]\s*/, "").trim();
  }

  function findSmallestContaining(root, needle) {
    // Walk the DOM, tracking the smallest element whose normalized text
    // contains the needle. We compare normalized whitespace to be robust
    // against multi-line answer choices.
    const normNeedle = normalize(needle);
    if (!normNeedle) return null;

    let best = null;
    let bestSize = Infinity;

    // Visit only elements whose own text (not descendants) is non-trivial,
    // OR whose normalized full text matches. Use TreeWalker for speed.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        // Skip script/style/our own host.
        const tag = node.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        if (node === host || node.id === "screensense-host") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode()) {
      const el = walker.currentNode;
      const txt = normalize(el.textContent || "");
      if (!txt.includes(normNeedle)) continue;
      // Only consider it a candidate if the element is visible.
      if (!isVisible(el)) continue;
      // Pick the SMALLEST such element — i.e., the deepest one that still
      // fully contains the needle. We measure size by textContent length.
      const size = (el.textContent || "").length;
      if (size < bestSize) {
        best = el;
        bestSize = size;
      }
    }
    return best;
  }

  function normalize(s) {
    return s.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
  }

  function isVisible(el) {
    if (!el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0;
  }

  // Anchored-rect tracker: keep DOM-bound highlights aligned as the user scrolls.
  // We use a rAF loop instead of scroll listeners — it's smoother and we don't
  // care about energy on a feature that's only active when a quiz answer is shown.
  const anchorMap = new WeakMap();

  function drawAnchoredHighlight(target, index, answer) {
    const box = div("ss-highlight-box");
    const tag = div("ss-highlight-tag");
    tag.textContent = answer.letter ? `Answer ${answer.letter}` : `Answer ${index + 1}`;
    box.appendChild(tag);
    highlightRoot.appendChild(box);
    highlightElements.push(box);
    anchorMap.set(box, target);
    updateAnchoredHighlight(box, target);
  }

  function updateAnchoredHighlight(box, target) {
    const r = target.getBoundingClientRect();
    box.style.left   = r.left   + "px";
    box.style.top    = r.top    + "px";
    box.style.width  = r.width  + "px";
    box.style.height = r.height + "px";
    box.style.display = (r.width === 0 || r.bottom < 0 || r.top > innerHeight) ? "none" : "";
  }

  function tickAnchors() {
    for (const box of highlightElements) {
      const t = anchorMap.get(box);
      if (t) updateAnchoredHighlight(box, t);
    }
    requestAnimationFrame(tickAnchors);
  }
  requestAnimationFrame(tickAnchors);

  function highlightAnswersAnchored(result) {
    clearHighlights();
    if (!result?.found_question || !result.answers?.length) return { matched: 0 };
    let matched = 0;
    for (let i = 0; i < result.answers.length; i++) {
      const ans = result.answers[i];
      const target = findDomNodeForAnswer(ans);
      if (target) {
        drawAnchoredHighlight(target, i, ans);
        matched++;
      }
    }
    return { matched, total: result.answers.length };
  }

  // --------------------------------------------------------------------------
  // Answer panel
  // --------------------------------------------------------------------------

  let activePanel = null;

  function showAnswerPanel({ result, info }) {
    closePanel();

    const panel = div("ss-panel");
    const header = div("ss-panel-header");
    const title = div("ss-panel-title");
    title.textContent = result.found_question ? "Quiz answer" : "No question detected";
    const closeBtn = div("ss-panel-close");
    closeBtn.textContent = "×";
    closeBtn.title = "Close (Esc)";
    closeBtn.onclick = closePanel;
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = div("ss-panel-body");
    if (!result.found_question) {
      body.appendChild(textNode("No multiple-choice question found in this region. Try Region Quiz on a tighter crop, or use Ask About Screen for general questions."));
    } else {
      if (result.question) {
        body.appendChild(labelled("Question", result.question));
      }
      for (let i = 0; i < result.answers.length; i++) {
        const ans = result.answers[i];
        const block = div("ss-answer-block");
        const head = div("ss-answer-head");
        const num = div("ss-answer-num");
        num.textContent = ans.letter || `${i + 1}`;
        head.appendChild(num);
        const text = div("ss-answer-text");
        text.textContent = stripPrefix(ans.text) || ans.text;
        head.appendChild(text);
        block.appendChild(head);
        if (ans.rationale) {
          const rat = div("ss-answer-rationale");
          rat.textContent = ans.rationale;
          block.appendChild(rat);
        }
        body.appendChild(block);
      }
      if (result.overall_explanation) {
        body.appendChild(labelled("Explanation", result.overall_explanation));
      }
      const meta = div("ss-panel-meta");
      const matched = info?.matched ?? 0;
      const total = info?.total ?? result.answers.length;
      meta.textContent = `Confidence: ${result.confidence}${matched < total ? ` · ${matched}/${total} highlighted on page` : " · all answers highlighted"}`;
      body.appendChild(meta);
    }

    panel.appendChild(header);
    panel.appendChild(body);
    panelRoot.appendChild(panel);
    // Note: we do NOT set panelRoot.style.pointerEvents="auto" — that would
    // make the whole shadow-root layer swallow every click in the viewport,
    // blocking the user from clicking the highlighted answer underneath.
    // The .ss-panel itself has `pointer-events: auto` in CSS, which is all
    // we need: clicks inside the panel widget reach the panel, clicks
    // elsewhere pass through to the page.
    activePanel = panel;

    // Make it draggable.
    makeDraggable(panel, header);

    // Auto-dismiss on the user's next click outside the panel — typically
    // that means they clicked the highlighted answer to select it, and now
    // want the panel out of the way.
    installAutoDismiss();
  }

  /** Build the Ask conversation panel: a scrollable thread of turns plus a
   *  follow-up input box. Returns a controller object the ask flow uses to
   *  append turns and stream tokens. Holds the original screenshot and the
   *  full turn history so follow-ups can be sent without re-capturing. */
  function showAskConversation() {
    closePanel();
    const panel = div("ss-panel");
    const header = div("ss-panel-header");
    const title = div("ss-panel-title");
    title.textContent = "Ask";
    const closeBtn = div("ss-panel-close");
    closeBtn.textContent = "×";
    closeBtn.onclick = closePanel;
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = div("ss-panel-body");
    const thread = div("ss-ask-thread");
    body.appendChild(thread);

    // Input row (hidden until the first answer completes).
    const inputRow = div("ss-ask-inputrow");
    inputRow.style.display = "none";
    const input = document.createElement("textarea");
    input.className = "ss-ask-input";
    input.rows = 1;
    input.placeholder = "Ask a follow-up…";
    const sendBtn = document.createElement("button");
    sendBtn.className = "ss-ask-send";
    sendBtn.textContent = "Send";
    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);
    body.appendChild(inputRow);

    panel.appendChild(header);
    panel.appendChild(body);
    panelRoot.appendChild(panel);
    activePanel = panel;
    makeDraggable(panel, header);

    // Conversation state held in this closure.
    const state = {
      imageB64: null,            // original screenshot (set on first answer)
      turns: [],                 // [{role:"user"|"assistant", text}]
      busy: false,
    };

    // Auto-grow the textarea.
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 96) + "px";
    });

    function addTurn(role, text) {
      const el = div(`ss-ask-turn ss-ask-turn-${role}`);
      el.textContent = text;
      thread.appendChild(el);
      thread.scrollTop = thread.scrollHeight;
      return el;
    }

    function setBusy(b) {
      state.busy = b;
      sendBtn.disabled = b;
      input.disabled = b;
    }

    // The ask flow wires this to actually send a follow-up.
    let onFollowup = null;

    function submitFollowup() {
      const q = input.value.trim();
      if (!q || state.busy) return;
      input.value = "";
      input.style.height = "auto";
      onFollowup?.(q);
    }
    sendBtn.onclick = submitFollowup;
    input.addEventListener("keydown", (e) => {
      // Enter sends; Shift+Enter inserts a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitFollowup();
      }
    });

    return {
      panel,
      state,
      addTurn,
      setBusy,
      revealInput() {
        inputRow.style.display = "flex";
        // Focus so the user can immediately type a follow-up.
        setTimeout(() => input.focus(), 0);
      },
      set onFollowup(fn) { onFollowup = fn; },
      // Begin a new assistant turn; returns an element that streams update.
      startAssistantTurn() {
        const el = addTurn("assistant", "…");
        let first = true;
        return {
          append(delta) {
            if (first) { el.textContent = ""; first = false; }
            el.textContent += delta;
            thread.scrollTop = thread.scrollHeight;
          },
          finalize(text) {
            if (typeof text === "string" && text.trim()) el.textContent = text;
            else if (first) el.textContent = "(empty response)";
            thread.scrollTop = thread.scrollHeight;
          },
          error(msg) { el.textContent = "⚠ " + msg; },
        };
      },
    };
  }

  /** Install a one-shot "click anywhere outside the panel" listener that
   *  dismisses the answer panel + highlights. The listener uses the capture
   *  phase so it runs before the page's own click handlers — but it does NOT
   *  preventDefault/stopPropagation, so the page click (e.g. selecting a
   *  radio button) still happens normally. */
  let autoDismissListener = null;
  function installAutoDismiss() {
    removeAutoDismiss();
    autoDismissListener = (e) => {
      // Ignore clicks that originated inside our shadow root (panel itself,
      // close button, etc). composedPath() lets us see across the shadow
      // boundary cleanly.
      const path = e.composedPath ? e.composedPath() : [];
      if (path.includes(host)) return;
      // First click outside our UI: dismiss panel + highlights, but let the
      // event continue to the page.
      closePanel();
      clearHighlights();
    };
    // Use capture so we run before page handlers, in case any page handler
    // calls stopPropagation. mousedown rather than click feels snappier and
    // fires before the page does anything weird with the click.
    window.addEventListener("mousedown", autoDismissListener, true);
  }

  function removeAutoDismiss() {
    if (autoDismissListener) {
      window.removeEventListener("mousedown", autoDismissListener, true);
      autoDismissListener = null;
    }
  }

  function makeDraggable(panel, handle) {
    let dragging = false, ox = 0, oy = 0;
    handle.style.cursor = "move";
    handle.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("ss-panel-close")) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      panel.style.right = "auto";
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = (e.clientX - ox) + "px";
      panel.style.top  = (e.clientY - oy) + "px";
    });
    window.addEventListener("mouseup", () => { dragging = false; });
  }

  function closePanel() {
    if (activePanel) {
      activePanel.remove();
      activePanel = null;
    }
    removeAutoDismiss();
  }

  function textNode(s) {
    const el = document.createElement("div");
    el.textContent = s;
    return el;
  }
  function labelled(label, content) {
    const wrap = div("ss-labelled");
    const l = div("ss-label");
    l.textContent = label;
    const c = div("ss-labelled-content");
    c.textContent = content;
    wrap.appendChild(l);
    wrap.appendChild(c);
    return wrap;
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closePanel();
      clearHighlights();
    }
  });

  // --------------------------------------------------------------------------
  // Action triggers
  // --------------------------------------------------------------------------

  /** Quiz mode uses a long-lived port (same as Ask mode) instead of
   *  sendMessage. This is critical: Firefox MV3 terminates idle event pages
   *  after ~30s, and Qwen3.6:27b on Open WebUI can take 30-90s to respond.
   *  With sendMessage, the message channel would die mid-LLM-call and the
   *  content script's await would reject with "Could not establish
   *  connection. Receiving end does not exist." A connected port keeps the
   *  event page alive for the whole operation. */
  function runQuizViaPort({ rect, silent = false } = {}) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      let port;
      let userCancelled = false;
      console.log("[ScreenSense/content] runQuizViaPort starting, rect=", rect, "silent=", silent);

      // In silent (Telegram) mode we show NO on-screen UI at all — no loading
      // panel, no confirmation. Status feedback goes to Telegram from the
      // background instead. Use a no-op stub so the rest of the flow is
      // unchanged.
      const loadingPanel = silent
        ? { close() {}, updateElapsed() {}, lastElapsed: 0 }
        : showQuizLoadingPanel({
            onCancel: () => {
              if (resolved) return;
              userCancelled = true;
              console.log("[ScreenSense/content] user cancelled, posting cancel to background");
              try { port?.postMessage({ type: "cancel" }); } catch {}
            },
          });

      try {
        port = api.runtime.connect({ name: "screensense-stream" });
        console.log("[ScreenSense/content] port connected");
      } catch (e) {
        console.error("[ScreenSense/content] runtime.connect threw:", e);
        loadingPanel.close();
        reject(e);
        return;
      }

      port.onMessage.addListener((msg) => {
        console.log("[ScreenSense/content] port message:", msg?.type, msg);
        if (msg?.type === "progress") {
          loadingPanel.updateElapsed(msg.elapsedSec);
          return;
        }
        if (msg?.type === "sent-telegram") {
          // Telegram mode — nothing on screen. The background already sent the
          // answer (and the "analyzing" notice) to Telegram.
          loadingPanel.close();
          resolved = true;
          resolve();
          return;
        }
        if (msg?.type === "quiz-result") {
          loadingPanel.close();
          try {
            const info = highlightAnswersAnchored(msg.result);
            if (!msg.auto || msg.result.found_question) {
              showAnswerPanel({ result: msg.result, info });
            }
            resolved = true;
            resolve();
          } catch (e) {
            resolved = true;
            reject(new Error("Got an answer but couldn't render it: " + (e?.message || e)));
          }
        } else if (msg?.type === "quiz-error") {
          loadingPanel.close();
          resolved = true;
          reject(new Error(msg.message));
        }
      });

      port.onDisconnect.addListener(() => {
        console.log("[ScreenSense/content] port disconnected, resolved=" + resolved);
        loadingPanel.close();
        if (!resolved) {
          if (userCancelled) {
            resolved = true;
            reject(new Error("Cancelled."));
            return;
          }
          const err = api.runtime.lastError;
          const lastProgress = loadingPanel.lastElapsed;
          const ctx = lastProgress
            ? ` Last heartbeat was at ${lastProgress}s — so the background got at least that far.`
            : " No heartbeat was ever received — the background may not have started processing.";
          reject(new Error(
            (err?.message || "The quiz request ended without a response.") +
            ctx +
            "\n\nOpen the page's regular DevTools console (F12) and look for [ScreenSense/content] log lines, then about:debugging → ScreenSense → Inspect → Console for [ScreenSense] background logs. Paste both."
          ));
        }
      });

      console.log("[ScreenSense/content] posting quiz-start to background");
      try {
        port.postMessage({
          type: "quiz-start",
          rect: rect || null,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
        console.log("[ScreenSense/content] quiz-start posted");
      } catch (e) {
        console.error("[ScreenSense/content] postMessage threw:", e);
        loadingPanel.close();
        reject(e);
      }
    });
  }

  /** Lightweight progress panel shown while quiz is running. */
  function showQuizLoadingPanel({ onCancel } = {}) {
    closePanel();
    const panel = div("ss-panel");
    const header = div("ss-panel-header");
    const title = div("ss-panel-title");
    title.textContent = "Analyzing…";
    const closeBtn = div("ss-panel-close");
    closeBtn.textContent = "×";
    closeBtn.onclick = () => {
      onCancel?.();
      closePanel();
    };
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = div("ss-panel-body");
    const status = div("ss-loading-status");
    status.textContent = "Capturing screen and sending to model…";
    const elapsed = div("ss-loading-elapsed");
    elapsed.textContent = "";
    const cancelBtn = div("ss-cancel-btn");
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => {
      cancelBtn.textContent = "Cancelling…";
      onCancel?.();
    };
    body.appendChild(status);
    body.appendChild(elapsed);
    body.appendChild(cancelBtn);

    panel.appendChild(header);
    panel.appendChild(body);
    panelRoot.appendChild(panel);
    activePanel = panel;
    makeDraggable(panel, header);

    return {
      close() {
        if (activePanel === panel) closePanel();
      },
      updateElapsed(sec) {
        this.lastElapsed = sec;
        status.textContent = `Model still working…`;
        elapsed.textContent = `Elapsed: ${sec}s`;
        // After 60s, change the messaging — at that point Qwen is almost
        // certainly stuck in a thinking loop, not legitimately working.
        if (sec >= 60) {
          status.textContent = `Model is taking a long time (${sec}s). It may be stuck — Cancel and try a smaller model.`;
        }
      },
      lastElapsed: 0,
    };
  }

  async function doQuizFullscreen() {
    console.log("[ScreenSense/content] doQuizFullscreen triggered");
    const silent = (await getOutputMode()) === "telegram";
    try {
      await runQuizViaPort({ silent });
    } catch (e) {
      const m = String(e?.message || e);
      console.error("[ScreenSense/content] doQuizFullscreen rejected:", e);
      if (!/^Cancelled\.?$/i.test(m)) {
        showToast({ message: m, level: "error" });
      }
    }
  }

  async function doQuizRegion() {
    console.log("[ScreenSense/content] doQuizRegion triggered");
    let rect;
    try {
      rect = await pickRegion();
      console.log("[ScreenSense/content] region picked:", rect);
    } catch (e) {
      if (!/Cancelled|too small/i.test(String(e?.message || ""))) {
        showToast({ message: String(e?.message || e), level: "error" });
      }
      return;
    }
    const silent = (await getOutputMode()) === "telegram";
    try {
      await runQuizViaPort({ rect, silent });
    } catch (e) {
      const m = String(e?.message || e);
      console.error("[ScreenSense/content] doQuizRegion rejected:", e);
      if (!/^Cancelled\.?$/i.test(m)) {
        showToast({ message: m, level: "error" });
      }
    }
  }

  /** Run one ask turn over a fresh port. `payload` is the port message
   *  (ask-start or ask-followup). Streams into the provided assistant-turn
   *  renderer. Resolves with the final text (or null on error/empty).
   *  `conv` is the conversation controller; on the first turn we capture the
   *  returned image into conv.state for follow-ups. */
  function runAskTurn(payload, conv, assistantTurn) {
    return new Promise((resolve) => {
      let full = "";
      let gotAnything = false;
      let finished = false;
      const port = api.runtime.connect({ name: "screensense-stream" });
      port.onMessage.addListener((msg) => {
        if (msg.type === "delta") {
          full += msg.delta;
          gotAnything = true;
          assistantTurn.append(msg.delta);
        } else if (msg.type === "done") {
          finished = true;
          const finalText = (msg.text || full || "").trim();
          assistantTurn.finalize(finalText);
          // First turn returns the screenshot — stash it for follow-ups.
          if (msg.imageB64 && !conv.state.imageB64) conv.state.imageB64 = msg.imageB64;
          resolve(finalText || null);
        } else if (msg.type === "error") {
          finished = true;
          assistantTurn.error(msg.message);
          resolve(null);
        } else if (msg.type === "sent-telegram") {
          finished = true;
          // Shouldn't normally reach here (Telegram-mode ask uses the
          // panel-less path), but handle it safely: don't render the answer.
          resolve("__SENT_TO_TELEGRAM__");
        } else if (msg.type === "progress") {
          // Heartbeat only — leave the "…" placeholder until real tokens arrive.
        }
      });
      port.onDisconnect.addListener(() => {
        if (!finished && !gotAnything) {
          assistantTurn.error("The request ended without a response. Check chrome://extensions → ScreenSense → service worker → Console.");
          resolve(null);
        }
      });
      try {
        port.postMessage(payload);
      } catch (e) {
        assistantTurn.error(String(e?.message || e));
        resolve(null);
      }
    });
  }

  /** Wire the follow-up input of a conversation to send ask-followup turns. */
  function wireFollowups(conv, initialQuestion) {
    conv.onFollowup = async (question) => {
      conv.setBusy(true);
      conv.addTurn("user", question);
      conv.state.turns.push({ role: "user", text: question });
      const assistantTurn = conv.startAssistantTurn();
      const text = await runAskTurn({
        type: "ask-followup",
        turns: conv.state.turns,
        imageB64: conv.state.imageB64,
      }, conv, assistantTurn);
      conv.state.turns.push({ role: "assistant", text: text || "" });
      conv.setBusy(false);
    };
    // Record the implicit first user turn (the question the screenshot answered).
    conv.state.turns.push({ role: "user", text: initialQuestion });
  }

  /** Ask the background what the current output mode is ("screen" or
   *  "telegram"). Queried fresh before each action so it's never stale. */
  async function getOutputMode() {
    try {
      const resp = await api.runtime.sendMessage({ type: "get-output-mode" });
      return resp?.mode || "screen";
    } catch {
      return "screen";
    }
  }

  /** Telegram-mode ask: NO panel, NO on-screen answer. Shows a brief working
   *  toast, then a confirmation when the answer has been sent to Telegram.
   *  Follow-ups aren't offered here (there's no panel) — each ask is one-shot
   *  to Telegram. */
  /** Telegram-mode ask: completely silent on screen. The background sends an
   *  "analyzing…" notice to Telegram when it starts, then the answer when
   *  done. Nothing appears on the page. Only hard errors surface as a toast
   *  (so a misconfiguration isn't invisible). */
  function runAskToTelegram(payload) {
    const port = api.runtime.connect({ name: "screensense-stream" });
    let done = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "sent-telegram") {
        done = true;  // success — nothing on screen, the answer is in Telegram
      } else if (msg.type === "error") {
        done = true;
        showToast({ message: "⚠ " + msg.message, level: "error" });
      }
      // delta/progress/done are ignored — nothing renders on screen.
    });
    port.onDisconnect.addListener(() => {
      if (!done) {
        showToast({ message: "⚠ The request ended without a response.", level: "error" });
      }
    });
    try { port.postMessage(payload); }
    catch (e) { showToast({ message: String(e?.message || e), level: "error" }); }
  }

  async function doAskFullscreen() {
    if (await getOutputMode() === "telegram") {
      runAskToTelegram({ type: "ask-start", devicePixelRatio: window.devicePixelRatio || 1 });
      return;
    }
    const conv = showAskConversation();
    conv.setBusy(true);
    const firstQuestion = "What's on this screen? Be concise.";
    conv.addTurn("user", firstQuestion);
    const assistantTurn = conv.startAssistantTurn();
    console.log("[ScreenSense/content] doAskFullscreen connecting port");
    const text = await runAskTurn({
      type: "ask-start",
      devicePixelRatio: window.devicePixelRatio || 1,
    }, conv, assistantTurn);
    wireFollowups(conv, firstQuestion);
    conv.state.turns.push({ role: "assistant", text: text || "" });
    conv.setBusy(false);
    conv.revealInput();
  }

  async function doAskRegion() {
    let rect;
    try {
      rect = await pickRegion();
    } catch (e) {
      if (!/Cancelled|too small/i.test(String(e?.message || ""))) {
        showToast({ message: String(e?.message || e), level: "error" });
      }
      return;
    }
    if (await getOutputMode() === "telegram") {
      runAskToTelegram({ type: "ask-start", rect, devicePixelRatio: window.devicePixelRatio || 1 });
      return;
    }
    const conv = showAskConversation();
    conv.setBusy(true);
    const firstQuestion = "What's on this screen? Be concise.";
    conv.addTurn("user", firstQuestion);
    const assistantTurn = conv.startAssistantTurn();
    console.log("[ScreenSense/content] doAskRegion connecting port");
    const text = await runAskTurn({
      type: "ask-start",
      rect,
      devicePixelRatio: window.devicePixelRatio || 1,
    }, conv, assistantTurn);
    wireFollowups(conv, firstQuestion);
    conv.state.turns.push({ role: "assistant", text: text || "" });
    conv.setBusy(false);
    conv.revealInput();
  }

  // --------------------------------------------------------------------------
  // Watcher
  // --------------------------------------------------------------------------
  // Strategy: a MutationObserver fires when the DOM changes. We debounce
  // for `intervalMs`, then check whether the visible-viewport text looks
  // quiz-like. If so, ping background to capture+analyze.
  //
  // Background dedupes via its 5-second cooldown.

  const QUIZ_PATTERNS = [
    /^\s*[A-D]\s*[\.\):]/m,
    /^\s*[1-4]\s*[\.\):]/m,
    /\bwhich of the following\b/i,
    /\bchoose (the|one|all)\b/i,
    /\bcorrect answer\b/i,
    /\bselect (the )?correct\b/i,
    /\bselect (all|two|three|four|2|3|4)\b/i,
  ];

  let watcherEnabled = false;
  let watcherInterval = 2500;
  let watcherObserver = null;
  let watcherTimer = null;
  let lastTextHash = "";

  function startWatcher() {
    if (watcherObserver) return;
    watcherObserver = new MutationObserver(() => scheduleWatcherCheck());
    watcherObserver.observe(document.body, {
      subtree: true, childList: true, characterData: true,
    });
    // Initial check after a beat.
    scheduleWatcherCheck();
  }

  function stopWatcher() {
    if (watcherObserver) {
      watcherObserver.disconnect();
      watcherObserver = null;
    }
    if (watcherTimer) {
      clearTimeout(watcherTimer);
      watcherTimer = null;
    }
  }

  function scheduleWatcherCheck() {
    if (watcherTimer) clearTimeout(watcherTimer);
    watcherTimer = setTimeout(() => {
      watcherTimer = null;
      runWatcherCheck();
    }, watcherInterval);
  }

  function runWatcherCheck() {
    if (!watcherEnabled) return;
    // Sample visible text in the viewport. Cheap and avoids huge pages.
    const visibleText = sampleVisibleText().slice(0, 4000);
    const looksLikeQuiz = QUIZ_PATTERNS.some(p => p.test(visibleText));
    if (!looksLikeQuiz) return;

    // Hash the visible text to detect *meaningful* change. Cursor jiggle
    // or hover-state DOM mutations shouldn't re-trigger.
    const hash = cheapHash(visibleText);
    if (hash === lastTextHash) return;
    lastTextHash = hash;

    api.runtime.sendMessage({ type: "watcher-trigger", payload: { hash } })
      .catch(() => { /* background may be reloading */ });
  }

  function sampleVisibleText() {
    // Walk text nodes in the viewport. Avoids reading offscreen content
    // (e.g. infinite-scroll virtualization that has the wrong answer
    // 20 screens below).
    const out = [];
    const vh = window.innerHeight;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        if (p === host) return NodeFilter.FILTER_REJECT;
        const r = p.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      out.push(n.nodeValue.trim());
      if (out.length > 200) break;
    }
    return out.join("\n");
  }

  function cheapHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  // --------------------------------------------------------------------------
  // Message router from background
  // --------------------------------------------------------------------------

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;

    switch (msg.type) {
      case "trigger": {
        const fn = ({
          "quiz-fullscreen": doQuizFullscreen,
          "quiz-region":     doQuizRegion,
          "ask-fullscreen":  doAskFullscreen,
          "ask-region":      doAskRegion,
        })[msg.action];
        if (!fn) {
          sendResponse({ ok: false, error: `Unknown action "${msg.action}".` });
          return false;
        }
        // Kick off the action async but synchronously ack so the caller
        // (popup) knows we received the trigger. Errors inside fn surface
        // via the in-page toast.
        Promise.resolve().then(fn).catch(err => {
          showToast({ message: String(err?.message || err), level: "error" });
        });
        sendResponse({ ok: true });
        return false;
      }

      case "quiz-result": {
        const info = highlightAnswersAnchored(msg.result);
        // For auto-triggered quizzes, only pop the panel if we actually found
        // a question. Otherwise it'd interrupt the user constantly.
        if (msg.auto && !msg.result.found_question) {
          sendResponse({ ok: true, suppressed: true });
          return false;
        }
        showAnswerPanel({ result: msg.result, info });
        sendResponse({ ok: true });
        return false;
      }

      case "toast":
        showToast({ message: msg.message, level: msg.level || "info" });
        sendResponse({ ok: true });
        return false;

      case "set-watcher":
        watcherEnabled = !!msg.enabled;
        if (typeof msg.intervalMs === "number") watcherInterval = msg.intervalMs;
        if (watcherEnabled) startWatcher();
        else { stopWatcher(); clearHighlights(); }
        sendResponse({ ok: true });
        return false;

      case "ping":
        // Heartbeat used by the popup/background to check whether the content
        // script is alive on this tab.
        sendResponse({ ok: true });
        return false;
    }
    return false;
  });

  // Tell background we're ready — it can then push our initial watcher state.
  api.runtime.sendMessage({ type: "get-state" }).then(resp => {
    if (resp?.ok) {
      watcherEnabled  = resp.state.enabled && resp.state.watcher.enabled;
      watcherInterval = resp.state.watcher.intervalMs;
      if (watcherEnabled) startWatcher();
    }
  }).catch(() => {});

  // Init complete. Only NOW do we mark ourselves loaded — any earlier and
  // a crash mid-init would leave the page un-rescuable. See the re-entrancy
  // guard comment near the top of this file.
  window.__screenSenseLoaded = true;
})();
