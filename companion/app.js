// app.js — glue: glasses / voice / phone UI <-> camera <-> Claude <-> glasses.
(() => {
  const $ = (id) => document.getElementById(id);
  const hasBridge = typeof miraCompanion !== "undefined";
  const KEY_NAME = "anthropicKey";
  const URL_NAME = "cameraUrl";
  const LINE_CHARS = 40;     // ~fits 592px at the 24px font
  const LINES_PER_PAGE = 9;  // + 1 footer line = the glasses' 10-line body

  // Spoken phrase -> action. Phrases are what you say to the glasses.
  const READ_PROMPT =
    "Read out all the text in the photo. If it isn't in English, translate it into English.";
  const VOICE = [
    { say: "Capture",      run: () => scan("voice") },
    { say: "Scan",         run: () => scan("voice") },
    { say: "Read it",      run: () => ask(READ_PROMPT, "voice") },
    { say: "Translate",    run: () => ask(READ_PROMPT, "voice") },
    { say: "Tell me more", run: () => ask("Tell me more about it.", "voice") },
    { say: "Next page",    run: () => { nextPage(); armVoice(); } },
  ];

  // ---- storage (Mira store on device, localStorage when testing in a browser)
  async function load(name) {
    try { if (hasBridge) return (await miraCompanion.storeGet(name)) || ""; } catch (e) {}
    try { return localStorage.getItem(name) || ""; } catch (e) { return ""; }
  }
  async function save(name, value) {
    try { if (hasBridge) { await miraCompanion.storeSet(name, value); return; } } catch (e) {}
    try { localStorage.setItem(name, value); } catch (e) {}
  }

  // ---- UI helpers
  function status(msg) { $("status").textContent = msg; }
  function log(msg) {
    const li = document.createElement("li");
    li.textContent = new Date().toLocaleTimeString() + "  " + msg;
    $("log").prepend(li);
    while ($("log").children.length > 30) $("log").lastChild.remove();
  }
  function addChat(who, text) {
    const div = document.createElement("div");
    div.className = "msg " + who;
    div.textContent = text;
    $("chat").append(div);
    div.scrollIntoView({ block: "nearest" });
  }
  function setBusy(on) {
    for (const id of ["scan", "askbtn"]) $(id).disabled = on;
    for (const b of document.querySelectorAll(".chip")) b.disabled = on;
  }

  // ---- glasses messaging
  // Glasses parse {"t":"line|line"} with a simple prefix match, so strip
  // characters that would break that: quotes, backslashes, '|', non-ASCII.
  function wrap(text) {
    const clean = text
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D"\\|]/g, "")
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const lines = [];
    let line = "";
    for (const word of clean.split(" ")) {
      if ((line + " " + word).trim().length > LINE_CHARS) {
        if (line) lines.push(line);
        line = word.slice(0, LINE_CHARS);
      } else {
        line = (line + " " + word).trim();
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // Long answers (e.g. a translated scroll) are split into pages; a ring
  // swipe shows the next one.
  let pages = []; // no answer yet: glasses keep their idle message
  let page = 0;
  function morePages() { return page < pages.length - 1; }
  function sendPage() {
    if (!hasBridge || !pages.length) return;
    let lines = pages[page];
    if (pages.length > 1) {
      const hint = morePages() ? "swipe for more" : "swipe to scan";
      lines = lines.concat("", "(" + (page + 1) + "/" + pages.length + ") " + hint);
    }
    miraCompanion.sendToApp({ t: lines.join("|") }).catch((e) => log("send failed: " + e));
  }
  function show(text) {
    const lines = wrap(text);
    pages = [];
    for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
    if (!pages.length) pages = [[""]];
    page = 0;
    sendPage();
  }
  function nextPage() {
    if (morePages()) { page++; sendPage(); return true; }
    return false;
  }
  function glassesBusy() {
    if (hasBridge) miraCompanion.sendToApp({ type: "busy" }).catch(() => {});
  }

  // ---- talking to Claude
  let working = false;
  async function run(label, job) {
    if (working) return;
    working = true;
    setBusy(true);
    try {
      const key = $("key").value.trim();
      if (!key) throw new Error("Add your Anthropic API key in Settings first.");
      glassesBusy();
      const t0 = performance.now();
      const answer = await job(key);
      status("Done in " + Math.round(performance.now() - t0) + " ms");
      addChat("bot", answer);
      log(label + ": " + answer);
      show(answer);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      status("Error: " + msg);
      log("error: " + msg);
      show("Error: " + msg);
    } finally {
      working = false;
      setBusy(false);
      armVoice();
    }
  }

  // New photo -> new conversation. An optional question replaces the default
  // "what is this?" prompt (e.g. typing "what does this say?" before capturing).
  function scan(origin, question) {
    return run(origin, async (key) => {
      // The picker needs a real tap on the phone; iOS ignores it otherwise.
      if (Camera.active.name === "picker" && origin !== "phone") {
        throw new Error("Photo picker mode: tap Scan on the phone.");
      }
      status("Grabbing frame (" + Camera.active.name + ")...");
      const jpeg = await Camera.getFrame();
      $("shot").src = "data:image/jpeg;base64," + jpeg;
      $("chat").textContent = "";
      if (question) addChat("me", question);
      status("Asking Claude...");
      return Claude.describe(key, jpeg, question);
    });
  }

  // Follow-up about the current photo. With no photo yet, capture first and
  // ask the question about the new photo.
  function ask(question, origin) {
    question = (question || "").trim();
    if (!question) return;
    if (!Claude.hasPhoto()) return scan(origin, question);
    return run(origin, async (key) => {
      addChat("me", question);
      status("Asking Claude...");
      return Claude.ask(key, question);
    });
  }

  // ---- voice (Mira mic). The exact message shape isn't documented yet, so
  // look in the likely fields and log everything to the on-phone Log.
  function armVoice() {
    if (!hasBridge || typeof miraCompanion.startCapture !== "function") return;
    try {
      const p = miraCompanion.startCapture();
      if (p && p.catch) p.catch((e) => log("startCapture: " + e));
    } catch (e) { log("startCapture: " + e); }
  }
  function setupVoice() {
    if (!hasBridge || typeof miraCompanion.setVoiceCommands !== "function") {
      $("voicehelp").textContent = "Voice: not available here. Type a question, or use the keyboard's dictation mic.";
      return;
    }
    try {
      const p = miraCompanion.setVoiceCommands(VOICE.map((v) => v.say));
      if (p && p.catch) p.catch((e) => log("setVoiceCommands: " + e));
      armVoice();
      log("voice commands on: " + VOICE.map((v) => v.say).join(", "));
    } catch (e) {
      log("voice setup failed: " + e);
    }
  }
  function spokenText(m) {
    for (const k of ["command", "text", "phrase", "transcript", "value", "name", "data"]) {
      if (typeof m[k] === "string" && m[k].trim()) return m[k].trim();
    }
    return "";
  }
  const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, "").trim();
  function onVoice(m) {
    const said = spokenText(m);
    const hit = VOICE.find((v) => norm(v.say) === norm(said));
    if (hit) { log('voice: "' + said + '"'); hit.run(); return; }
    // Anything else that came through as words: treat it as a question.
    if (said) { log('voice question: "' + said + '"'); ask(said, "voice"); return; }
    log("voice event with no text: " + JSON.stringify(m));
    armVoice();
  }

  // ---- camera start, with automatic fallback to the photo picker
  async function startCamera() {
    const choice = $("source").value;
    try {
      if (choice === "url") {
        Camera.use("url").endpoint = $("camurl").value.trim();
        $("preview").hidden = true;
        status("Using camera URL");
        return;
      }
      if (choice === "picker") {
        Camera.use("picker");
        $("preview").hidden = true;
        status("Photo picker mode: use the Scan button on the phone");
        return;
      }
      Camera.use("phone");
      $("preview").hidden = false;
      await Camera.active.start($("preview"));
      status('Camera OK. Say "Capture", tap the glasses, or swipe the ring.');
      log("phone camera started");
    } catch (e) {
      const msg = (e && (e.name + " " + e.message)) || String(e);
      log("camera blocked: " + msg);
      Camera.use("picker");
      $("source").value = "picker";
      $("preview").hidden = true;
      status("Live camera blocked (" + msg + "). Using photo picker: tap Scan on the phone.");
    }
  }

  // ---- wire up
  async function init() {
    $("key").value = await load(KEY_NAME);
    if (!$("key").value) $("settings").open = true; // first run: show the key field
    $("camurl").value = await load(URL_NAME);
    $("key").addEventListener("change", () => save(KEY_NAME, $("key").value.trim()));
    $("camurl").addEventListener("change", () => { save(URL_NAME, $("camurl").value.trim()); startCamera(); });
    $("source").addEventListener("change", startCamera);
    $("scan").addEventListener("click", () => scan("phone"));
    $("askform").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const q = $("question").value;
      $("question").value = "";
      ask(q, "phone");
    });
    for (const b of document.querySelectorAll(".chip")) {
      b.addEventListener("click", () => ask(b.dataset.q === "READ" ? READ_PROMPT : b.dataset.q, "phone"));
    }
    $("model").textContent = Claude.MODEL;
    $("voicehelp").textContent =
      'Say: "' + VOICE.map((v) => v.say).join('", "') + '". Or type any question below.';

    if (hasBridge) {
      miraCompanion.onFromApp((m) => {
        if (!m) return;
        if (m.type === "snap") scan("glasses");
        else if (m.type === "swipe") { if (!nextPage()) scan("ring"); }
        else if (m.type === "voiceCommand") onVoice(m);
        else if (m.type === "hello") { log("glasses connected"); sendPage(); }
        else log("from glasses: " + JSON.stringify(m));
      });
      setupVoice();
    } else {
      log("No Mira bridge (browser test mode). Use the phone controls.");
    }
    startCamera();
  }
  init();
})();
