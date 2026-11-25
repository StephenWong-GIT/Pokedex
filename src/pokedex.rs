// Pokedex — glasses side (Rust -> WASM).
//
// Input -> {"type":"action","a":...} to the phone companion -> phone grabs a
// camera frame and/or asks Claude, and replies {"t":"line one|line two|..."}
// -> we draw those lines on the glasses.
//
//   tap            capture now, or run the highlighted menu item
//   swipe / ring   open the action menu and move the highlight (nothing runs
//                  until you tap; the menu closes after MENU_IDLE_MS)
//   hold / release talk while holding to ask a question (phone dictation)
//
// Voice commands are handled entirely on the phone. The phone does all
// networking, paging and text wrapping; this side stays tiny.
#![no_std]
#![allow(static_mut_refs)]
#[path = "../sdk/Shared/companion.rs"] mod companion;
#[path = "../sdk/Shared/content.rs"] mod content;

// 32x32 sidebar icon: a "pokeball" (circle, middle band, center button).
app_icon!(content::app_icon::Icon::new()
    .circle(16, 16, 13).line(3, 16, 12, 16).line(20, 16, 29, 16).circle(16, 16, 4).0);

#[link(wasm_import_module = "mira")]
extern "C" {
    fn begin();
    fn present();
    fn fill_rect(x: i32, y: i32, w: i32, h: i32, gray: i32);
    fn text(x: i32, y: i32, w: i32, h: i32, gray: i32, font: i32, align: i32, spacing: i32, p: *const u8, n: i32);
    fn ble_send(method: i32, payload: *const u8, len: i32) -> i32;
}
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { loop {} }

const APP_NAME: &[u8] = b"Pokedex"; // must match the manifest title in build.py
const MAX_TEXT: usize = 1024;
const BUSY_TIMEOUT_MS: u32 = 25_000;
const MENU_IDLE_MS: u32 = 10_000; // close an untouched menu without running anything

const HELLO: &[u8] = b"{\"type\":\"hello\"}";
const CAPTURE: &[u8] = b"{\"type\":\"action\",\"a\":\"capture\"}";
const HOLD: &[u8] = b"{\"type\":\"action\",\"a\":\"hold\"}";
const RELEASE: &[u8] = b"{\"type\":\"action\",\"a\":\"release\"}";

// Ring/touch-bar menu: label, message to the phone (empty = just close).
const MENU: [(&[u8], &[u8]); 6] = [
    (b"Capture", CAPTURE),
    (b"Read it", b"{\"type\":\"action\",\"a\":\"read\"}"),
    (b"Tell me more", b"{\"type\":\"action\",\"a\":\"more\"}"),
    (b"Ask a question", b"{\"type\":\"action\",\"a\":\"ask\"}"),
    (b"Next page", b"{\"type\":\"action\",\"a\":\"next\"}"),
    (b"Cancel", b""),
];
const ROW_Y: i32 = 84;
const ROW_H: i32 = 52;

const IDLE_MSG: &[u8] = b"Say CAPTURE or tap to scan.|Swipe the ring for more actions.|Hold the touch bar to ask a question.";

static mut BRIDGE: companion::Companion = companion::Companion::new(APP_NAME);
static mut BODY: [u8; MAX_TEXT] = [0; MAX_TEXT];
static mut BODY_LEN: usize = 0;
static mut BUSY: bool = false;
static mut BUSY_MS: u32 = 0; // give up if the phone never answers
static mut MENU_OPEN: bool = false;
static mut SEL: usize = 0;
static mut MENU_MS: u32 = 0;
static mut HOLDING: bool = false;
// Outgoing messages, sent in order; a busy bridge retries on later ticks.
static mut OUTBOX: [&[u8]; 4] = [b""; 4];
static mut OUT_LEN: usize = 0;

unsafe fn queue(msg: &'static [u8]) {
    if OUT_LEN < OUTBOX.len() { OUTBOX[OUT_LEN] = msg; OUT_LEN += 1; }
}

unsafe fn set_body(s: &[u8]) {
    let n = s.len().min(MAX_TEXT);
    BODY[..n].copy_from_slice(&s[..n]);
    BODY_LEN = n;
}

unsafe fn label(x: i32, y: i32, w: i32, gray: i32, font: i32, s: &[u8]) {
    text(x, y, w, 44, gray, font, 0, 32, s.as_ptr(), s.len() as i32);
}

unsafe fn render() {
    begin();
    let title: &[u8] = if MENU_OPEN { b"POKEDEX  -  choose" }
        else if HOLDING { b"POKEDEX  -  listening..." }
        else if BUSY { b"POKEDEX  -  thinking..." }
        else { b"POKEDEX" };
    label(24, 20, 592, 15, 2, title);
    fill_rect(24, 66, 592, 2, 6);
    if MENU_OPEN {
        for (i, item) in MENU.iter().enumerate() {
            let y = ROW_Y + i as i32 * ROW_H;
            let on = i == SEL;
            if on { fill_rect(24, y + 6, 6, 32, 15); }
            label(44, y, 540, if on { 15 } else { 5 }, 2, item.0);
        }
        label(24, 428, 592, 10, 1, b"Swipe to move, tap to choose");
        content::cursor(600, ROW_Y + SEL as i32 * ROW_H + 20, true);
    } else {
        // Body: lines separated by '|' (phone pre-wraps to fit 640px).
        let body = &BODY[..BODY_LEN];
        let mut y = 86;
        let mut start = 0;
        for i in 0..=body.len() {
            if i == body.len() || body[i] == b'|' {
                let line = &body[start..i];
                if !line.is_empty() {
                    text(24, y, 592, 32, 15, 0, 0, 24, line.as_ptr(), line.len() as i32);
                }
                y += 34;
                start = i + 1;
                if y > 440 { break; }
            }
        }
        content::cursor(614, 440, false);
    }
    present();
}

/// Pull the text out of {"t":"..."}. The phone strips quotes/backslashes, so a
/// plain prefix/suffix match is enough here.
fn extract_text(msg: &[u8]) -> Option<&[u8]> {
    let head = b"{\"t\":\"";
    let tail = b"\"}";
    if msg.len() >= head.len() + tail.len() && msg.starts_with(head) && msg.ends_with(tail) {
        Some(&msg[head.len()..msg.len() - tail.len()])
    } else {
        None
    }
}

unsafe fn capture() {
    queue(CAPTURE);
    BUSY = true;
    BUSY_MS = 0;
    set_body(b"Looking...");
}

/// Run the highlighted menu item.
unsafe fn pick() {
    MENU_OPEN = false;
    let msg = MENU[SEL].1;
    if msg == CAPTURE {
        capture();
    } else if !msg.is_empty() {
        queue(msg);
    }
    if !msg.is_empty() {
        let cue = [29u8]; // "command accepted" click
        ble_send(0x0066, cue.as_ptr(), 1);
    }
    render();
}

#[no_mangle]
pub unsafe extern "C" fn app_init() {
    BRIDGE = companion::Companion::new(APP_NAME);
    BUSY = false;
    MENU_OPEN = false;
    HOLDING = false;
    OUT_LEN = 0;
    queue(HELLO);
    content::holds_local(true); // hold-to-ask; claims reset on every app switch
    set_body(IDLE_MSG);
    render();
}

#[no_mangle]
pub unsafe extern "C" fn app_render(ms: i32) {
    let ms = ms.max(0) as u32;
    let mut dirty = content::context_changed();
    if let Some(msg) = BRIDGE.tick(ms) {
        if let Some(t) = extract_text(msg) {
            set_body(t);
            BUSY = false;
            dirty = true;
        } else if msg == b"{\"type\":\"busy\"}" {
            BUSY = true;
            BUSY_MS = 0;
            dirty = true;
        }
    }
    if MENU_OPEN {
        MENU_MS = MENU_MS.saturating_add(ms);
        if MENU_MS >= MENU_IDLE_MS { MENU_OPEN = false; dirty = true; }
    }
    if BUSY {
        BUSY_MS = BUSY_MS.saturating_add(ms);
        if BUSY_MS > BUSY_TIMEOUT_MS {
            BUSY = false;
            set_body(b"No answer from the phone.|Is the Pokedex page open in Mira?");
            dirty = true;
        }
    }
    if OUT_LEN > 0 && BRIDGE.send(OUTBOX[0]) {
        OUTBOX.copy_within(1..OUT_LEN, 0);
        OUT_LEN -= 1;
    }
    if dirty { render(); }
}

#[no_mangle]
pub unsafe extern "C" fn app_event(e: i32) {
    // 0 click, 1 swipe forward (= up/previous), 2 swipe backward (= down/next),
    // 10 hold start, 12 hold end. Rings may send only 1 and 2.
    // Double-click (3) is left to the Shell for navigation.
    match e {
        10 => {
            if BUSY || content::sidebar_open() || content::overlay_visible() { return; }
            MENU_OPEN = false;
            HOLDING = true;
            queue(HOLD);
            set_body(b"Ask your question, then let go.");
        }
        12 => {
            // Always handle the release, even if the hold started elsewhere.
            if !HOLDING { return; }
            HOLDING = false;
            queue(RELEASE);
            set_body(b"Got it...");
        }
        _ if BUSY || HOLDING => return,
        0 => { if MENU_OPEN { pick(); return; } capture(); }
        1 | 2 => {
            if !MENU_OPEN {
                MENU_OPEN = true;
                SEL = 0;
            } else if e == 2 {
                SEL = (SEL + 1) % MENU.len();
            } else {
                SEL = (SEL + MENU.len() - 1) % MENU.len();
            }
            MENU_MS = 0;
        }
        _ => return,
    }
    render();
}

#[no_mangle]
pub extern "C" fn app_stop() {}
