// claude.js — sends one image to Claude and returns a short description.
// Runs on the phone. The API key never leaves the phone except to Anthropic.

const Claude = (() => {
  // Check https://docs.anthropic.com/en/docs/about-claude/models for current IDs.
  const MODEL = "claude-haiku-4-5";

  const PROMPT =
    "You are a Pokedex for the real world. In 1-2 short sentences (max 40 words), " +
    "name the main thing in front of me and give one interesting fact about it. " +
    "Plain text only, no markdown.";

  async function describe(apiKey, jpegB64) {
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
        max_tokens: 150,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegB64 } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.message) || "HTTP " + res.status;
      throw new Error("Claude: " + msg);
    }
    return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
  }

  return { describe, MODEL };
})();
