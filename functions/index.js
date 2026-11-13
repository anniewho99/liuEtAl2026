// /chat proxy for the AI condition. Replaces the Express /chat route from
// app_reading.js / app_fractions.js. Same prompts as the original, plus one sentence for fractions (answer only if explicitly asked).
// The OpenAI key is stored as a Functions secret:  firebase functions:secrets:set OPENAI_API_KEY
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

// gpt-5-chat-latest (used in the original pilots) was shut down on 2026-07-23; OpenAI lists gpt-5.6-sol as its replacement.
// Change this one line to switch models. The model OpenAI actually served is logged and returned with each reply.
const MODEL = "gpt-5.6-sol";
const PROMPT_VERSION = "original-plus-one-rule-v8";   // returned with every reply so you can confirm which deploy is live
const MAX_MESSAGE_CHARS = 2000;   // guard: the endpoint is public
const MAX_HISTORY_TURNS = 40;

function buildSystemPrompt(experiment, ctx) {
  const isReading = experiment === "reading" || (!experiment && ctx && Array.isArray(ctx.options));
  const base = isReading
    ? "You are a helpful assistant working with the user to solve a reading comprehension problem. Keep your responses concise (a few sentences max)."
    : "You are a helpful assistant working with the user to solve a fractions problem. Keep your responses concise (a few sentences max).";
  // Fractions only: the one addition to the original prompt. Placed after the problem text.
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

      const messages = [
        { role: "system", content: buildSystemPrompt(experiment, puzzleContext) },
        ...history,
        { role: "user", content: message },
      ];

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
        res.status(502).json({ success: false, error: "Failed to get chat response" });
        return;
      }
      const data = await r.json();
      const assistantMessage = data.choices[0].message.content;
      console.log("chat model served:", data.model, "prompt:", PROMPT_VERSION);

      res.json({
        success: true,
        message: assistantMessage,
        model: data.model,
        promptVersion: PROMPT_VERSION,
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