// /chat proxy for the AI condition. Replaces the Express /chat route from
// app_reading.js / app_fractions.js. Same model, same prompts, same response shape.
// The OpenAI key is stored as a Functions secret:  firebase functions:secrets:set OPENAI_API_KEY
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

// gpt-5-chat-latest (used in the original pilots) was shut down on 2026-07-23; OpenAI lists gpt-5.6-sol as its replacement.
// Change this one line to switch models. The model OpenAI actually served is logged and returned with each reply.
const MODEL = "gpt-5.6-sol";
const MAX_MESSAGE_CHARS = 2000;   // guard: the endpoint is public
const MAX_HISTORY_TURNS = 40;

function buildSystemPrompt(experiment, ctx) {
  const isReading = experiment === "reading" || (!experiment && ctx && Array.isArray(ctx.options));
  const base = isReading
    ? "You are a helpful assistant working with the user to solve a reading comprehension problem. Keep your responses concise (a few sentences max)."
    : "You are a helpful assistant working with the user to solve a fractions problem. Keep your responses concise (a few sentences max).";
  // Fractions only. Placed at the END of the system prompt (after the problem text) so it is not buried.
  const answerRule = isReading ? "" :
    "IMPORTANT RULE: Do not state the final answer to the problem, and do not complete the last step of the calculation, unless the user explicitly asks for the answer. " +
    "Requests such as 'what is the answer?', 'just give me the answer', 'solve this', or 'solve it for me' all count as explicitly asking, and then you should give the answer. " +
    "Otherwise (for example 'help', 'I'm stuck', 'how do I do this?', 'what's the first step?'), never reveal the final value: give a short hint, ask a guiding question, or explain only the next step, and let the user work out the answer themselves. " +
    "This holds even if the problem looks easy or the user seems frustrated.";
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
      console.log("chat model served:", data.model);

      res.json({
        success: true,
        message: assistantMessage,
        model: data.model,
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