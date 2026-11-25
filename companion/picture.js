// picture.js — a rough copy of each capture for the glasses display:
// 192x144, 15 gray levels (gray 15 is transparent on the glasses, so 0..14),
// auto-contrast + error-diffusion dithering, packed two pixels per byte.
// Sent with miraCompanion.setBytesForApp; the glasses download and check it.

const Picture = (() => {
  const W = 192, H = 144, LEVELS = 14;
  let nextId = 1;

  function loadImage(jpegB64) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode photo"));
      img.src = "data:image/jpeg;base64," + jpegB64;
    });
  }

  async function encode(jpegB64) {
    const img = await loadImage(jpegB64);
    // Center-crop to 4:3 so nothing is squashed.
    const sw = img.naturalWidth, sh = img.naturalHeight;
    let cw = sw, ch = (sw * 3) / 4;
    if (ch > sh) { ch = sh; cw = (sh * 4) / 3; }
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext("2d");
    g.drawImage(img, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, W, H);
    const rgba = g.getImageData(0, 0, W, H).data;

    const lum = new Float32Array(W * H);
    const hist = new Uint32Array(256);
    for (let i = 0; i < W * H; i++) {
      const v = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
      lum[i] = v;
      hist[Math.min(255, v | 0)]++;
    }
    // Stretch contrast between the 2nd and 98th percentile.
    const pct = (p) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p * W * H) return v; }
      return 255;
    };
    const lo = pct(0.02), hi = Math.max(pct(0.98), lo + 1);

    const out = new Uint8Array((W / 2) * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const v = Math.min(LEVELS, Math.max(0, ((lum[i] - lo) / (hi - lo)) * LEVELS));
        const q = Math.round(v);
        const err = (v - q) * ((hi - lo) / LEVELS); // back in luminance units
        // Floyd-Steinberg error diffusion
        if (x + 1 < W) lum[i + 1] += err * 7 / 16;
        if (y + 1 < H) {
          if (x > 0) lum[i + W - 1] += err * 3 / 16;
          lum[i + W] += err * 5 / 16;
          if (x + 1 < W) lum[i + W + 1] += err * 1 / 16;
        }
        out[i >> 1] |= x % 2 === 0 ? q << 4 : q;
      }
    }
    return out;
  }

  // 32-bit FNV-1a, the checksum the glasses verify.
  function fnv1a(bytes) {
    let h = 0x811c9dc5;
    for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
    return h >>> 0;
  }

  // Returns true if the picture was handed to Mira.
  async function send(jpegB64) {
    if (typeof miraCompanion === "undefined" || typeof miraCompanion.setBytesForApp !== "function") return false;
    const bytes = await encode(jpegB64);
    const id = nextId++;
    await miraCompanion.setBytesForApp(id, bytes);
    await miraCompanion.sendToApp({ type: "img", id, len: bytes.length, sum: fnv1a(bytes) });
    return true;
  }

  return { send, encode, fnv1a, W, H };
})();
