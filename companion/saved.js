// saved.js — photos you chose to keep ("Save"), stored on this phone only.
// iOS won't let a web page write to the camera roll by itself, so photos wait
// here until you tap "Add to camera roll", which opens the iPhone share sheet
// ("Save Images"). Stored in the page's IndexedDB; falls back to memory if
// the web view doesn't allow it.

const Saved = (() => {
  const MAX = 50; // oldest are dropped beyond this
  let db = null;
  let memory = []; // fallback store and cache: [{at, jpeg, answer}]

  function req(r) {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function open() {
    if (db || typeof indexedDB === "undefined") return db;
    try {
      const r = indexedDB.open("pokedex", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("photos", { keyPath: "at" });
      db = await req(r);
    } catch (e) { db = null; }
    return db;
  }
  const store = (mode) => db.transaction("photos", mode).objectStore("photos");

  async function list() {
    if (await open()) memory = await req(store("readonly").getAll());
    return memory.slice().sort((a, b) => a.at - b.at);
  }
  async function add(item) {
    if (memory.some((p) => p.at === item.at)) return false;
    memory.push(item);
    if (await open()) await req(store("readwrite").put(item));
    const all = await list();
    for (const old of all.slice(0, Math.max(0, all.length - MAX))) await remove(old.at);
    return true;
  }
  async function remove(at) {
    memory = memory.filter((p) => p.at !== at);
    if (await open()) await req(store("readwrite").delete(at));
  }
  async function clear() {
    memory = [];
    if (await open()) await req(store("readwrite").clear());
  }
  function toFile(item) {
    const bin = atob(item.jpeg);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const name = "pokedex-" + new Date(item.at).toISOString().replace(/[:.]/g, "-") + ".jpg";
    return new File([bytes], name, { type: "image/jpeg" });
  }
  // Must run inside a real tap on the phone (iOS rule for the share sheet).
  async function share(items) {
    const files = items.map(toFile);
    if (!navigator.canShare || !navigator.canShare({ files })) {
      throw new Error("Sharing isn't available here. Long-press a photo to save it instead.");
    }
    await navigator.share({ files });
  }

  return { list, add, remove, clear, share };
})();
