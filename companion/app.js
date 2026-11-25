// app.js — glue: glasses <-> camera <-> Claude <-> glasses.
(() => {
  const $ = (id) => document.getElementById(id);
  const hasBridge = typeof miraCompanion !== "undefined";
  const KEY_NAME = "anthropicKey";
  const URL_NAME = "cameraUrl";
  const LINE_CHARS = 40; // ~fits 592px at the 24px font
  const MAX_LINES = 10;

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
    while ($("log").children.length > 20) $("log").lastChild.remove();
  }

  // ---- glasses messaging
  // Glasses parse {"t":"line|line"} with a simple prefix match, so strip
  // characters that would break that: quotes, backslashes, '|', non-ASCII.
  function toGlassesLines(text) {
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
    return lines.slice(0, MAX_LINES).join("|");
  }
  function sendToGlasses(text) {
    if (!hasBridge) return;
    miraCompanion.sendToApp({ t: toGlassesLines(text) }).catch((e) => log("send failed: " + e));
  }

  // ---- the scan
  let scanning = false;
  async function scan(origin) {
    if (scanning) return;
    scanning = true;
    $("scan").disabled = true;
    try {
      const key = $("key").value.trim();
      if (!key) throw new Error("Add your Anthropic API key below first.");
      if (hasBridge) miraCompanion.sendToApp({ type: "busy" }).catch(() => {});
      status("Grabbing frame (" + Camera.active.name + ")...");
      const jpeg = await Camera.getFrame();
      $("shot").src = "data:image/jpeg;base64," + jpeg;
      status("Asking Claude...");
      const t0 = performance.now();
      const answer = await Claude.describe(key, jpeg);
      const ms = Math.round(performance.now() - t0);
      $("answer").textContent = answer;
      status("Done in " + ms + " ms");
      log(origin + ": " + answer);
      sendToGlasses(answer);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      status("Error: " + msg);
      log("error: " + msg);
      sendToGlasses("Error: " + msg);
    } finally {
      scanning = false;
      $("scan").disabled = false;
    }
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
      status("Camera OK. Tap the glasses or swipe the ring to scan.");
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
    $("model").textContent = Claude.MODEL;

    if (hasBridge) {
      miraCompanion.onFromApp((m) => {
        if (!m) return;
        if (m.type === "snap") scan("glasses");
        if (m.type === "hello") log("glasses connected");
      });
    } else {
      log("No Mira bridge (browser test mode). Use the Scan button.");
    }
    startCamera();
  }
  init();
})();
