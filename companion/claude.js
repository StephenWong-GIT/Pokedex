// claude.js — talks to Claude about the current photo.
// Runs on the phone. The API key never leaves the phone except to Anthropic.
//
// A "session" is one photo plus every question asked about it. Each question
// re-sends the whole conversation (the API is stateless), so follow-ups like
// "what does it say?" or "translate it" still see the original image.
// Plain fetch() is used on purpose: the companion is inlined into one HTML
// file with no bundler, so the npm SDK isn't available here.

const Claude = (() => {
  const MODEL = "claude-haiku-5-5";
  // Follow-ups per photo. History is append-only (editing earlier turns would
  // invalidate the model's replayed thinking), so we cap it instead of trimming.
  const MAX_TURNS = 20;

  const SYSTEM =
    "You are a Pokedex for the real world, running on smart glasses. The user shows you " +
    "a photo from their camera and may ask follow-up questions about it. Answers are read " +
    "on a tiny monochrome display, so be brief: 1-3 short sentences unless the user asks you " +
    "to read or translate text, then give the full text, translated into English if it isn't " +
    "English (for non-Latin scripts give only the English, plus a short romanization if it " +
    "helps). Plain ASCII text only: no markdown, no bullet points, no emoji.";

  const FIRST_PROMPT =
    "Name the main thing in front of me and give one interesting fact about it (max 40 words). " +
    "If there's visible writing, say briefly what language it is in.";

  // Current conversation: [{role, content}], first user turn holds the image.
  let messages = [];

  function hasPhoto() { return messages.length > 0; }
  function reset() { messages = []; }

  async function call(apiKey) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Required for calling the API straight from a web page.
        // Fine here: it's your own key on your own phone.
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        // Haiku 5.5 thinks by default and thinking counts toward this cap, so
        // leave headroom; the system prompt keeps the visible answer short.
        max_tokens: 2048,
        output_config: { effort: "low" }, // fast answers; raise if quality lags
        system: SYSTEM,
        messages,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || "HTTP " + res.status;
      throw new Error("Claude: " + msg);
    }
    if (data.stop_reason === "refusal") throw new Error("Claude declined to answer that.");
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    if (!text) throw new Error("Claude returned no text (stop: " + data.stop_reason + ")");
    // Keep the full content (thinking blocks included) unmodified for the next turn.
    messages.push({ role: "assistant", content: data.content });
    return text;
  }

  // New photo: starts a fresh conversation.
  async function describe(apiKey, jpegB64, question) {
    messages = [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegB64 } },
        { type: "text", text: question || FIRST_PROMPT },
      ],
    }];
    try { return await call(apiKey); } catch (e) { messages = []; throw e; }
  }

  // Follow-up about the current photo.
  async function ask(apiKey, question) {
    if (!hasPhoto()) throw new Error("Capture something first.");
    if (messages.length >= 1 + 2 * MAX_TURNS) throw new Error("That's a lot of questions. Capture again to start fresh.");
    messages.push({ role: "user", content: question });
    try { return await call(apiKey); } catch (e) { messages.pop(); throw e; }
  }

  return { describe, ask, reset, hasPhoto, MODEL };
})();
