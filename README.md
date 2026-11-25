# Pokedex

A real-world Pokedex for **Mira glasses**. Say "capture" (or tap the glasses / swipe your ring), and the app grabs a camera frame, asks **Claude** what it's looking at, and shows the answer on the glasses. Then ask follow-ups about the same photo: "read it", "translate", "tell me more", or type any question on the phone.

```
ring swipe / tap ──► glasses app (Rust/WASM) ──{"type":"snap"}──► phone companion (HTML/JS)
                                                                    │ getFrame()  (camera.js)
                                                                    │ Claude Haiku (claude.js)
glasses display ◄──────────────{"t":"line|line|..."}────────────────┘
```

Status: proof of concept. v1 uses the phone camera; `companion/camera.js` is built so other cameras (Wi‑Fi cams, ESP32‑CAM, etc.) can be swapped in later.

## Project layout

| Path | What it is |
|---|---|
| `src/pokedex.rs` | Glasses app: handles tap/ring input, draws the answer |
| `companion/index.html` | Phone UI: camera preview, Scan button, settings |
| `companion/camera.js` | **Camera sources** — the only file that changes per camera |
| `companion/claude.js` | Sends one image to Claude, returns a short description |
| `companion/app.js` | Glue between glasses, camera, and Claude |
| `scripts/setup_sdk.py` | Extracts the Mira SDK from Mira's `SKILL.md` into `sdk/` |
| `scripts/build.py` | Compiles + packages everything into `dist/Pokedex.html` |

`sdk/` and `dist/` are git-ignored. The Mira SDK is Mira's code, so it isn't committed here.

## Setup

Requirements: Rust with the `wasm32-unknown-unknown` target, Python 3, Node.js.

```sh
rustup target add wasm32-unknown-unknown
mkdir -p sdk && cp /path/to/Mira/SKILL.md sdk/SKILL.md   # Mira's SDK guide
python3 scripts/setup_sdk.py
python3 scripts/build.py                               # -> dist/Pokedex.html
```

## Install on the glasses

In the Mira phone app: **Apps → Create an app → Upload → `dist/Pokedex.html` → Check code → Add → Install → Open**.
To update: long-press the app card → **Edit App → Upload → Save → Update → Open**.

Then open **Settings** on the Pokedex phone page and paste your Anthropic API key.

## API key

- Get one at [console.anthropic.com](https://console.anthropic.com) (separate from a Claude.ai subscription). Set a monthly spend limit.
- The key is stored **only on your phone** via Mira's companion storage. It is never in this repo.
- Model: `claude-haiku-5-5` at low effort. A scan or follow-up costs well under a cent. Each follow-up re-sends the photo so Claude can still see it.

## Controls

Every capture starts a new conversation about that photo. Questions after it are about the same photo until you capture again.

| Input | Action |
|---|---|
| Say **"Capture"** (or "Scan") | New photo + description |
| Say **"Read it"** / **"Translate"** | Read the text in the photo, translated to English |
| Say **"Tell me more"** | Follow-up about the same photo |
| Say **"Next page"** | Next page of a long answer |
| Tap touch bar | New photo + description |
| Ring / touch-bar swipe | Next page of a long answer, or a new scan if there's none |
| Double tap | Mira navigation (sidebar/Home) |
| Phone **Scan** button | New photo (also needed in photo-picker mode) |
| Phone **Ask** box | Any question about the current photo (iOS keyboard dictation works here) |

Voice uses `miraCompanion.setVoiceCommands` + `startCapture`, whose message format isn't documented yet. Every voice event is written to the phone's **Log**, so check it first if a command does nothing. If Mira passes free-form speech (any words that aren't a command), the app asks Claude about it as a question.

## First thing to test

The live phone camera only works if Mira's in-app web view allows `getUserMedia`. If it's blocked, the app falls back to **photo picker** mode automatically (status line will say so). If both fail, the camera has to come from somewhere else (see `camera.js` → `url` source).

## Swapping cameras

Add a source to `companion/camera.js` with `start()` and `getFrame()` (returns base64 JPEG), then select it in Settings. The `url` source already handles any camera that serves a JPEG snapshot over HTTP. iOS may block plain-`http://` / local-network URLs from the page, so test early.
