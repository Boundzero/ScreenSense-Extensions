// quiz.js — quiz prompt + result shaping. Port of screensense/quiz.py.
//
// In the browser we don't OCR — we match the LLM's "text" answers against
// DOM text nodes instead, which is more accurate and avoids the desktop
// app's "OCR returns 0 boxes" issue.

export const QUIZ_SYSTEM_PROMPT = `You are an exam-helper analyzing a screenshot. Your job
is to identify the correct answer(s) to a question shown in the image.

# When to set found_question

Set found_question: TRUE in ALL of these situations:
  - You see a question with lettered choices (A, B, C, D…)
  - You see a question with numbered choices (1, 2, 3, 4…)
  - You see selectable options with bullets, radio buttons, or checkboxes
  - You see a fill-in-the-blank with selectable options
  - You see ANY test, quiz, exam, survey, or poll content
  - You see what LOOKS like answer choices even if the question stem is
    cut off by the crop — pick the most likely correct one and mark it
    confidence "low"
  - You see a coding question with multiple solution choices
  - You see a medical, legal, technical, or any subject-matter question

Set found_question: FALSE ONLY in these specific situations:
  - The image is a chat window, email, or social media feed
  - The image shows only prose text (article, blog post, documentation)
  - The image shows only an application UI with no test content
  - The image is mostly blank or shows a desktop wallpaper
  - You genuinely see NOTHING that looks like answer choices

# Crucial rule

If you can see ANY indication of selectable answers — even partial, even
unclear, even with a cut-off stem — set found_question to TRUE and pick the
most likely answer. Mark confidence as "low" when uncertain. Users find a
low-confidence guess far more useful than "found_question: false".

# Question types

  - "single"     — one correct answer (the default)
  - "select_n"   — explicitly asks for N answers ("select two", "choose 3")
  - "select_all" — "select all that apply", number unspecified

# Required output format

Respond with ONLY a JSON object — no prose before or after, no markdown:

{
  "found_question": true | false,
  "question": "a short summary of the question — 20 words max, NOT a verbatim transcription. Long scenarios should be condensed.",
  "question_type": "single" | "select_n" | "select_all",
  "answers": [
    {
      "letter": "A" | "B" | "1" | etc. (or null if not letter-keyed),
      "text": "the exact verbatim text of this correct answer as it appears on screen",
      "rationale": "1 sentence on why this answer is correct"
    }
  ],
  "overall_explanation": "1-2 sentence summary (optional)",
  "confidence": "high" | "medium" | "low"
}

# Answer text formatting (CRITICAL)

For each answer's "text" field: copy it EXACTLY as it appears on screen,
including any prefix like "A." or "1)". This is essential — the app uses
this text to locate and highlight the answer on the user's screen. If the
on-screen text is "B. Photosynthesis", write exactly "B. Photosynthesis" —
not "Photosynthesis" alone, not "Option B".

# Count rule

  - For "single" questions: the answers array has EXACTLY ONE entry
  - For "select_n" questions: EXACTLY N entries
  - For "select_all": every correct answer, in screen order (top-to-bottom)`;

export const ASK_SYSTEM_PROMPT = `You are a helpful assistant analyzing the user's screen.
Be concise. If you see an error, explain it and suggest a fix. If you see a
question, answer it. If you see a chart or data, summarize it. Use plain
prose — short paragraphs, no markdown unless code or lists are clearly
warranted.`;

/** Normalize the model's response into the structured shape we render. */
export function normalizeQuizResult(data) {
  if (!data || typeof data !== "object") return null;
  const answers = Array.isArray(data.answers) ? data.answers : [];
  return {
    found_question: Boolean(data.found_question),
    question: String(data.question || ""),
    question_type: String(data.question_type || "single"),
    answers: answers
      .filter(a => a && typeof a === "object")
      .map(a => ({
        letter: a.letter || null,
        text: String(a.text || ""),
        rationale: String(a.rationale || ""),
      }))
      .filter(a => a.text),
    overall_explanation: String(data.overall_explanation || ""),
    confidence: String(data.confidence || "low"),
  };
}

/** Diagnose common parse failures so we can show a helpful error. */
export function diagnoseRawResponse(text) {
  const stripped = (text || "").trim();
  const length = stripped.length;
  const hasThinkOpen = /<think>/i.test(stripped);
  const hasThinkClose = /<\/think>/i.test(stripped);
  const unclosedThink = hasThinkOpen && !hasThinkClose;

  const looksTruncated = stripped.startsWith("{") && !stripped.endsWith("}");
  const looksLikePureReasoning =
    !stripped.includes("{") &&
    /\b(the user|the question|let me|analyze|first,|step 1|the image)\b/i.test(stripped);

  let preview = stripped;
  if (preview.length > 1200) {
    preview = stripped.slice(0, 600)
      + `\n\n[…${stripped.length - 1200} chars omitted…]\n\n`
      + stripped.slice(-600);
  }
  // Empty preview (model returned nothing). Make it obvious.
  if (!preview) preview = "(model returned empty response)";

  if (unclosedThink) {
    return {
      kind: "unclosed-think",
      message:
        "The model started thinking but never finished — its <think> block is unclosed, which means it ran out of output tokens before producing the actual JSON answer.\n\n" +
        "Fixes:\n" +
        " • Region Quiz on just the answer choices (less to analyze, less thinking).\n" +
        " • Add `/no_think` to the system prompt — but Qwen3.6 is the only thinking model in our default list, and it should self-terminate. If it isn't, try a non-thinking model.\n" +
        " • Increase max_tokens — but our quiz path already requests 4000, so a thinking model burning through that is genuinely runaway.",
      preview,
      length,
    };
  }
  if (looksTruncated) {
    return {
      kind: "truncated",
      message:
        "The model's response was cut off mid-JSON. The output starts with { but never closes.\n\n" +
        "Fixes:\n" +
        " • Region Quiz on just the question (less context, faster).\n" +
        " • If you're on Open WebUI via Cloudflare tunnel: long generations (>60s) can be cut off by tunnel buffering even though the server is still generating. Try a smaller/faster model.\n" +
        " • Increase max_tokens (our quiz path uses 4000; bump it in providers.js if your model is verbose).",
      preview,
      length,
    };
  }
  if (looksLikePureReasoning) {
    return {
      kind: "reasoning",
      message:
        "The model wrote prose reasoning but never emitted JSON.\n\n" +
        "Fixes:\n" +
        " • Try a non-thinking model (any of the cloud Claude/GPT/Gemini options, or a small Llama Vision).\n" +
        " • For OWUI thinking models, append `/no_think` to your user message.",
      preview,
      length,
    };
  }
  return {
    kind: "unparseable",
    message:
      `Couldn't parse the model's response as JSON. Output was ${length} chars; no { ... } object found.\n\n` +
      "What the model returned is below — if it looks like a refusal, change the model. If it looks like JSON but with weird wrapping, send this to the developer.",
    preview,
    length,
  };
}
