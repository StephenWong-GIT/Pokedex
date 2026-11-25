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

Every capture starts a new conversation about that photo. Trigger words work at any time, including during the 10-second follow-up window. Questions after it are about the same photo until you capture again.

| Input | Action |
|---|---|
| Say **"Capture"** | New photo + description |
| Say **"Read it"** / **"Translate"** | Read the text in the photo, translated to English |
| Say **"Tell me more"** | Follow-up about the same photo |
| Say **"Ask a question"**, then your question | Any spoken question (Mira dictation; sent when you pause) |
| Say **"Next page"** | Next page of a long answer |
| Say **"Save"** (or ring menu / phone **Save photo**) | Keep the current photo in **Saved photos** on the phone page |
| Just talk, right after an answer | **Conversation mode:** for 10 s after each answer the glasses listen for a follow-up question (toggle in Settings) |
| Tap touch bar | New photo + description, or run the highlighted menu item |
| Swipe (ring or touch bar) | Open the action menu / move the highlight. Nothing runs until you tap; an untouched menu closes after 10 s |
| Hold touch bar | Talk while holding; your question is sent when you let go |
| Double tap | Mira navigation (sidebar/Home) |
| Phone **Scan** / **Ask** | Same actions from the phone (typing or keyboard dictation) |

The ring menu holds: Capture, Read it, Tell me more, Ask a question, Next page, Save photo, Cancel.

## Saving photos

Captures are not kept unless you save them. Saved photos stay on the phone (in the page's own storage) under **Saved photos**. iOS doesn't let a web page write to the camera roll on its own, so tap **Add all to camera roll** (or a single photo) and pick **Save Images** in the share sheet. Settings has an option to save every capture automatically.

Voice uses Mira's SDK: `setVoiceCommands` + `startCapture` for the commands and `startDictation` for free-form questions. While the Pokedex app is open in the foreground, the glasses microphone stays on so the commands can be heard; Mira releases it when you leave the app. Voice events are written to the phone page's **Log**.

## First thing to test

The live phone camera only works if Mira's in-app web view allows `getUserMedia`. If it's blocked, the app falls back to **photo picker** mode automatically (status line will say so). If both fail, the camera has to come from somewhere else (see `camera.js` → `url` source).

## Swapping cameras

Add a source to `companion/camera.js` with `start()` and `getFrame()` (returns base64 JPEG), then select it in Settings. The `url` source already handles any camera that serves a JPEG snapshot over HTTP. iOS may block plain-`http://` / local-network URLs from the page, so test early.
