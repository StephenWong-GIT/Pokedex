// camera.js — the ONLY file that knows where images come from.
// Swap the active source to use a different camera; nothing else changes.
// Every source returns a base64 JPEG string (no "data:" prefix).

const Camera = (() => {
  const MAX_SIDE = 1024; // downscale before upload: cheaper + faster, plenty for Claude

  function canvasToB64(canvas) {
    return canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
  }

  function drawScaled(src, w, h) {
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return canvasToB64(c);
  }

  // --- v1: phone camera (live preview, grab current frame) ---------------
  const phone = {
    name: "phone",
    video: null,
    async start(videoEl) {
      this.video = videoEl;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      videoEl.srcObject = stream;
      await videoEl.play().catch(() => {});
    },
    async getFrame() {
      const v = this.video;
      if (!v || !v.videoWidth) throw new Error("Camera not ready");
      return drawScaled(v, v.videoWidth, v.videoHeight);
    },
  };

  // --- fallback: system camera picker (one photo per scan) ---------------
  // Used automatically if getUserMedia is blocked inside the Mira web view.
  const picker = {
    name: "picker",
    input: null,
    async start() {},
    getFrame() {
      return new Promise((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.capture = "environment";
        input.onchange = () => {
          const file = input.files && input.files[0];
          if (!file) return reject(new Error("No photo taken"));
          const img = new Image();
          img.onload = () => resolve(drawScaled(img, img.naturalWidth, img.naturalHeight));
          img.onerror = () => reject(new Error("Could not read photo"));
          img.src = URL.createObjectURL(file);
        };
        input.click();
      });
    },
  };

  // --- v2 example: any camera that serves a JPEG at a URL ---------------
  // e.g. an ESP32-CAM at http://192.168.1.50/capture. Note: iOS may block
  // plain-http / local-network URLs from this page; test early.
  const url = {
    name: "url",
    endpoint: "",
    async start() {},
    async getFrame() {
      if (!this.endpoint) throw new Error("No camera URL set");
      const res = await fetch(this.endpoint, { cache: "no-store" });
      if (!res.ok) throw new Error("Camera URL returned " + res.status);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      return drawScaled(bmp, bmp.width, bmp.height);
    },
  };

  const sources = { phone, picker, url };
  let active = phone;

  return {
    sources,
    get active() { return active; },
    use(name) { active = sources[name]; return active; },
    getFrame() { return active.getFrame(); },
  };
})();
