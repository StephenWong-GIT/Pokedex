// app.js — glue: glasses / voice / phone UI <-> camera <-> Claude <-> glasses.
(() => {
  const $ = (id) => document.getElementById(id);
  const hasBridge = typeof miraCompanion !== "undefined";
  const KEY_NAME = "anthropicKey";
  const URL_NAME = "cameraUrl";
  const LINE_CHARS = 40;     // ~fits 592px at the 24px font
  const LINES_PER_PAGE = 9;  // + 1 footer line = the glasses' 10-line body

  const READ_PROMPT =
    "Read out all the text in the photo. If it isn't in English, translate it into English.";
  const MORE_PROMPT = "Tell me more about it.";

  // The same actions from every input: glasses tap / ring menu / hold, voice.
  const ACTIONS = {
    capture: (origin) => scan(origin),
    read:    (origin) => ask(READ_PROMPT, origin),
    more:    (origin) => ask(MORE_PROMPT, origin),
    ask:     () => startAsk("menu"),
    next:    () => { if (!nextPage()) sendPage(); },
    hold:    () => startAsk("hold"),
    release: () => { if (dict) finishAsk(); else flash("Didn't catch that. Try again."); },
  };

  // Voice commands (Mira's Thud recogniser, max 16). The descriptions help it
  // match natural variations of each phrase.
  const VOICE = [
    { say: "Capture",        act: "capture", desc: "Take a photo with the camera and say what is in front of me." },
    { say: "Read it",        act: "read",    desc: "Read out the text in the photo, translated into English." },
    { say: "Translate",      act: "read",    desc: "Translate the writing in the photo into English." },
    { say: "Tell me more",   act: "more",    desc: "Tell me more about the thing in the photo." },
    { say: "Ask a question", act: "ask",     desc: "Start listening for a spoken question about the photo." },
    { say: "Next page",      act: "next",    desc: "Show the next page of the answer on the glasses." },
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

  // ---- voice (glasses mic, via the Mira phone app)
  // startCapture() keeps the glasses mic open while this app is in the
  // foreground; Mira then runs our registered commands and, on request,
  // dictation. Mira releases the mic when the app closes or glasses disconnect.
  const canVoice = () => hasBridge && typeof miraCompanion.startCapture === "function";
  async function setupVoice() {
    if (!canVoice() || typeof miraCompanion.setVoiceCommands !== "function") {
      $("voicehelp").textContent = "Voice: not available here. Type a question, or use the keyboard's dictation mic.";
      return;
    }
    try {
      const descriptions = {};
      for (const v of VOICE) descriptions[v.say] = v.desc;
      await miraCompanion.setVoiceCommands(VOICE.map((v) => v.say), "pokedex", descriptions);
      await miraCompanion.startCapture();
      log("voice on: " + VOICE.map((v) => v.say).join(", "));
    } catch (e) {
      log("voice setup failed: " + ((e && e.message) || e));
    }
  }
  function onVoiceCommand(m) {
    if (dict) return; // the question being dictated may contain a command word
    const v = VOICE.find((x) => x.say.toLowerCase() === String(m.command || "").toLowerCase());
    log('voice: "' + m.command + '"' + (v ? "" : " (unknown)"));
    if (v) ACTIONS[v.act]("voice");
  }

  // Glasses-only messages that don't change the saved answer pages.
  function flash(text) {
    if (hasBridge) miraCompanion.sendToApp({ t: wrap(text).slice(0, 10).join("|") }).catch(() => {});
  }

  // Spoken questions. mode "hold": talk while holding the touch bar, sent on
  // release. Otherwise ("menu"/voice): sent when Mira detects you stopped.
  let dict = null;
  async function startAsk(mode) {
    if (working || dict) return;
    if (!canVoice() || typeof miraCompanion.startDictation !== "function") {
      flash("Voice questions need the Mira app. Type your question on the phone.");
      return;
    }
    const id = "q" + Date.now();
    dict = { id, mode, text: "", timer: 0 };
    $("question").placeholder = "Listening...";
    if (mode !== "hold") flash("Listening... ask your question.");
    try {
      await miraCompanion.startCapture(); // no-op if already running
      await miraCompanion.startDictation({ captureID: id, endpointDetection: mode !== "hold" });
      // Give up if nothing usable arrives (hold mode ends on release instead).
      if (mode !== "hold") dict.timer = setTimeout(finishAsk, 15000);
    } catch (e) {
      dict = null;
      $("question").placeholder = "Ask about the photo...";
      const msg = (e && e.message) || String(e);
      log("dictation failed: " + msg);
      flash("Mic unavailable: " + msg);
    }
  }
  function onDictation(m) {
    if (!dict || (m.captureID && m.captureID !== dict.id)) return; // late text
    dict.text = String(m.text || m.confirmedText || "").trim();
    $("question").placeholder = dict.text || "Listening...";
    if (m.final && dict.mode !== "hold" && dict.text) finishAsk();
  }
  async function finishAsk() {
    if (!dict) return;
    const d = dict;
    dict = null;
    clearTimeout(d.timer);
    $("question").placeholder = "Ask about the photo...";
    let text = d.text;
    try {
      const r = await miraCompanion.stopDictation(); // keeps voice commands running
      if (r && typeof r.text === "string" && r.text.trim()) text = r.text.trim();
    } catch (e) { log("stopDictation: " + ((e && e.message) || e)); }
    if (!text) { flash("Didn't catch that. Try again."); return; }
    log('heard: "' + text + '"');
    ask(text, "voice");
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
      status('Camera OK. Say "Capture", tap the glasses, or swipe the ring for the menu.');
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
      'Say: "' + VOICE.map((v) => v.say).join('", "') + '". On the glasses: tap = capture, ' +
      "swipe = action menu, hold = ask out loud. Or type any question above.";

    if (hasBridge) {
      miraCompanion.onFromApp((m) => {
        if (!m) return;
        if (m.type === "action" && ACTIONS[m.a]) ACTIONS[m.a]("glasses");
        else if (m.type === "voiceCommand") onVoiceCommand(m);
        else if (m.type === "dictation") onDictation(m);
        else if (m.type === "hello") { log("glasses connected"); sendPage(); setupVoice(); }
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
