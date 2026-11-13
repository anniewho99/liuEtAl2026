// /chat proxy for the AI condition. Replaces the Express /chat route from
// app_reading.js / app_fractions.js. Same model, same prompts, same response shape.
// The OpenAI key is stored as a Functions secret:  firebase functions:secrets:set OPENAI_API_KEY
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

// gpt-5-chat-latest (used in the original pilots) was shut down on 2026-07-23; OpenAI lists gpt-5.6-sol as its replacement.
// Change this one line to switch models. The model OpenAI actually served is logged and returned with each reply.
const MODEL = "gpt-5.6-sol";
const PROMPT_VERSION = "answer-rule-lean-guard-v6";   // returned with every reply so you can confirm which deploy is live
const MAX_MESSAGE_CHARS = 2000;   // guard: the endpoint is public
const MAX_HISTORY_TURNS = 40;

function buildSystemPrompt(experiment, ctx) {
  const isReading = experiment === "reading" || (!experiment && ctx && Array.isArray(ctx.options));
  const base = isReading
    ? "You are a helpful assistant working with the user to solve a reading comprehension problem. Keep your responses concise (a few sentences max)."
    : "You are a helpful assistant working with the user to solve a fractions problem. Keep your responses concise (a few sentences max).";
  // Fractions only. Placed at the END of the system prompt (after the problem text) so it is not buried.
  const answerRule = isReading ? "" :
    "Do not state the final answer to the problem unless the user explicitly asks for it (for example, 'what is the answer?', 'just tell me', or 'solve this'). " +
    "Otherwise, help without giving the final answer.";
  if (!ctx || !ctx.problem) return base + (answerRule ? "\n\n" + answerRule : "");

  let p = base + "\n\n";
  if (isReading) {
    if (ctx.text) p += "Here is the passage:\n" + ctx.text + "\n\n";
    p += "Here is the question:\n" + ctx.problem + "\n\n";
    if (Array.isArray(ctx.options) && ctx.options.length > 0) {
      p += "Here are the options:\n" + ctx.options.join("\n") + "\n\n";
    }
  } else {
    p += "Here is the problem:\n" + ctx.problem + "\n\n";
    if (ctx.units) p += "Answer format: " + ctx.units + "\n\n";
  }
  return p + answerRule;
}

/* ---------- ANSWER GUARD (fractions only) ----------
   The prompt asks the AI not to give the answer unless explicitly asked, but the model often solves the problem anyway.
   So after each reply we check whether it contains the correct answer; if it does and the user did not explicitly ask,
   we ask the model once to rewrite without the answer (and fall back to a short neutral reply if it still leaks).
   The participant never sees the first draft. */
function normalizeMath(s) {
  return String(s)
    .replace(/\\left|\\right|\\displaystyle|\\boxed|\\[,;! ]/g, "")
    .replace(/\\[dt]?frac\s*\{\s*(\d+)\s*\}\s*\{\s*(\d+)\s*\}/g, "$1/$2")
    .replace(/\\\(|\\\)|\\\[|\\\]|\$|[{}]/g, "")
    .replace(/\s+/g, "");
}
function leaksAnswer(reply, answers) {
  const r = normalizeMath(reply);
  return (answers || []).some((a) => {
    const n = normalizeMath(a);
    if (!/\d\/\d/.test(n)) return false;               // only fraction-form answers (e.g. 21/10)
    const esc = n.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
    return new RegExp("(?<![\\d/])" + esc + "(?!\\d)").test(r);
  });
}
// Generous on purpose: if the message looks like it asks for the answer, we do not block it.
const EXPLICIT_ASK = /\b(answer|answers|solve|solution|result|final|tell me|give me|show me|do it for me|work it out|figure it out for me|what('| i)?s? (it|the)|equals?|how much is)\b/i;
const NEUTRAL_FALLBACK = "I can help with this. What have you tried so far, or which step are you unsure about?";

async function callOpenAI(messages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY.value()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, messages }),
  });
  if (!r.ok) {
    console.error("OpenAI error", r.status, await r.text());
    return null;
  }
  return r.json();
}

exports.chat = onRequest(
  { cors: true, secrets: [OPENAI_API_KEY], region: "us-central1", timeoutSeconds: 60, maxInstances: 20 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ success: false, error: "POST only" });
      return;
    }
    try {
      const { message, conversationHistory = [], puzzleContext = null, experiment = null } = req.body || {};
      if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE_CHARS) {
        res.status(400).json({ success: false, error: "Bad message" });
        return;
      }
      const history = (Array.isArray(conversationHistory) ? conversationHistory : [])
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-MAX_HISTORY_TURNS);

      // Fractions only: repeat the rule right before the user's newest message (models obey rules near the end far more reliably).
      const isReadingReq = experiment === "reading" || (!experiment && puzzleContext && Array.isArray(puzzleContext.options));
      const turnReminder = isReadingReq ? [] : [{
        role: "system",
        content:
          "Reminder: do not state the final answer unless the user's latest message explicitly asks for it. " +
          "Messages like 'hello', 'idk', 'I'm stuck', 'nice', or 'thanks' are not requests for the answer.",
      }];
      const messages = [
        { role: "system", content: buildSystemPrompt(experiment, puzzleContext) },
        ...history,
        ...turnReminder,
        { role: "user", content: message },
      ];

      const data = await callOpenAI(messages);
      if (!data) {
        res.status(502).json({ success: false, error: "Failed to get chat response" });
        return;
      }
      let assistantMessage = data.choices[0].message.content;
      let guard = null;

      // Answer guard (fractions): reply revealed the answer although the user did not explicitly ask for it
      const answers = Array.isArray(puzzleContext && puzzleContext.answers) ? puzzleContext.answers.slice(0, 10) : [];
      if (!isReadingReq && answers.length && !EXPLICIT_ASK.test(message) && leaksAnswer(assistantMessage, answers)) {
        guard = "regenerated";
        const retry = await callOpenAI([
          ...messages,
          { role: "assistant", content: assistantMessage },
          { role: "system", content: "Your previous reply stated the final answer, but the user did not explicitly ask for it. Write a new reply to the user's latest message that does not state the final answer or the result of the last step. Keep it concise." },
        ]);
        const retryText = retry && retry.choices && retry.choices[0].message.content;
        if (retryText && !leaksAnswer(retryText, answers)) {
          assistantMessage = retryText;
        } else {
          guard = "fallback";
          assistantMessage = NEUTRAL_FALLBACK;
        }
      }
      console.log("chat model served:", data.model, "prompt:", PROMPT_VERSION, "guard:", guard);

      res.json({
        success: true,
        message: assistantMessage,
        model: data.model,
        promptVersion: PROMPT_VERSION,
        guard: guard,
        conversationHistory: [
          ...history,
          { role: "user", content: message },
          { role: "assistant", content: assistantMessage },
        ],
      });
    } catch (err) {
      console.error("Chat error:", err);
      res.status(500).json({ success: false, error: "Failed to get chat response" });
    }
  }
);