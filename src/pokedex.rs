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
//   double tap     on an answer: show the big picture; in the menu: close it;
//                  while listening: stop. Claimed only then, so on the idle
//                  screen and on the big picture it opens Mira's sidebar.
//
// The phone also sends a 4-bit grayscale copy of each capture
// (setBytesForApp): a 240x180 picture followed by a 120x90 thumbnail. The big
// one shows while Claude thinks and on "Show picture"; the thumbnail sits
// beside the first page of the answer.
//
// Keep text above y=430: Mira's SAY hint pill is drawn along the bottom.
//
// Voice commands are handled entirely on the phone. The phone does all
// networking, paging and text wrapping; this side stays tiny.
#![no_std]
#![allow(static_mut_refs)]
#[path = "../sdk/Shared/companion.rs"] mod companion;
#[path = "../sdk/Shared/content.rs"] mod content;
#[path = "../sdk/Shared/companion_bytes.rs"] mod companion_bytes;

// 32x32 sidebar icon: a "pokeball" (circle, middle band, center button).
app_icon!(content::app_icon::Icon::new()
    .circle(16, 16, 13).line(3, 16, 12, 16).line(20, 16, 29, 16).circle(16, 16, 4).0);

#[link(wasm_import_module = "mira")]
extern "C" {
    fn begin();
    fn present();
    fn fill_rect(x: i32, y: i32, w: i32, h: i32, gray: i32);
    fn text(x: i32, y: i32, w: i32, h: i32, gray: i32, font: i32, align: i32, spacing: i32, p: *const u8, n: i32);
    fn bitmap4(x: i32, y: i32, w: i32, h: i32, pixels: *const u8, len: i32);
    fn ble_send(method: i32, payload: *const u8, len: i32) -> i32;
}
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { loop {} }

const APP_NAME: &[u8] = b"Pokedex"; // must match the manifest title in build.py
const MAX_TEXT: usize = 1024;
const BUSY_TIMEOUT_MS: u32 = 25_000;
const MENU_IDLE_MS: u32 = 10_000; // close an untouched menu without running anything

// Pictures: 4-bit grayscale, two pixels per byte (left = high nibble).
// 240x180 is about the largest that fits the shared 32 KiB image pool.
const PIC_W: i32 = 240;
const PIC_H: i32 = 180;
const PIC_BYTES: usize = (PIC_W as usize / 2) * PIC_H as usize;
const PIC_X: i32 = (640 - PIC_W) / 2;
const THUMB_W: i32 = 120;
const THUMB_H: i32 = 90;
const THUMB_BYTES: usize = (THUMB_W as usize / 2) * THUMB_H as usize;
const THUMB_X: i32 = 640 - 24 - THUMB_W;
const BODY_Y: i32 = 86;
const LINE_H: i32 = 34;
const MAX_LINES: i32 = 10; // last line ends ~y=424, clear of the SAY pill

const HELLO: &[u8] = b"{\"type\":\"hello\"}";
const CAPTURE: &[u8] = b"{\"type\":\"action\",\"a\":\"capture\"}";
const HOLD: &[u8] = b"{\"type\":\"action\",\"a\":\"hold\"}";
const RELEASE: &[u8] = b"{\"type\":\"action\",\"a\":\"release\"}";
const STOP: &[u8] = b"{\"type\":\"action\",\"a\":\"stop\"}";
const SHOW_PIC: &[u8] = b"show"; // handled on the glasses, never sent

// Ring/touch-bar menu: label, message to the phone (empty = just close).
const MENU: [(&[u8], &[u8]); 8] = [
    (b"Capture", CAPTURE),
    (b"Read it", b"{\"type\":\"action\",\"a\":\"read\"}"),
    (b"Tell me more", b"{\"type\":\"action\",\"a\":\"more\"}"),
    (b"Ask a question", b"{\"type\":\"action\",\"a\":\"ask\"}"),
    (b"Show picture", SHOW_PIC),
    (b"Next page", b"{\"type\":\"action\",\"a\":\"next\"}"),
    (b"Save photo", b"{\"type\":\"action\",\"a\":\"save\"}"),
    (b"Cancel", b""),
];
const ROW_Y: i32 = 80;
const ROW_H: i32 = 42;

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
static mut LISTENING: bool = false; // phone is listening for a spoken question
static mut PICTURE: bool = false;   // "Show picture" view
static mut DOUBLE_TAP: bool = false; // we currently claim double tap
static mut PIC: [u8; PIC_BYTES + THUMB_BYTES] = [0; PIC_BYTES + THUMB_BYTES];
static mut PIC_READY: bool = false;
static mut PIC_FRESH: bool = false; // arrived during the current "thinking"
static mut PIC_READER: companion_bytes::Reader = companion_bytes::Reader::new();
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

unsafe fn draw_picture(y: i32) {
    bitmap4(PIC_X, y, PIC_W, PIC_H, PIC.as_ptr(), PIC_BYTES as i32);
}

/// Body text: lines separated by '|' (the phone pre-wraps them to fit). A
/// leading '@' means "first answer page": draw the thumbnail top-right (the
/// phone wrapped the first lines narrower to leave room for it).
unsafe fn draw_body() {
    let mut body = &BODY[..BODY_LEN];
    if body.first() == Some(&b'@') {
        body = &body[1..];
        if PIC_READY {
            bitmap4(THUMB_X, 80, THUMB_W, THUMB_H, PIC[PIC_BYTES..].as_ptr(), THUMB_BYTES as i32);
        }
    }
    let mut y = BODY_Y;
    for line in body.split(|b| *b == b'|').take(MAX_LINES as usize) {
        if !line.is_empty() {
            text(24, y, 592, 32, 15, 0, 0, 24, line.as_ptr(), line.len() as i32);
        }
        y += LINE_H;
    }
}

unsafe fn render() {
    begin();
    let title: &[u8] = if MENU_OPEN { b"POKEDEX  -  tap to choose" }
        else if PICTURE { b"POKEDEX  -  picture" }
        else if HOLDING || LISTENING { b"POKEDEX  -  listening..." }
        else if BUSY { b"POKEDEX  -  thinking..." }
        else { b"POKEDEX" };
    label(24, 20, 592, 15, 2, title);
    fill_rect(24, 66, 592, 2, 6);
    if MENU_OPEN {
        for (i, item) in MENU.iter().enumerate() {
            let y = ROW_Y + i as i32 * ROW_H;
            let on = i == SEL;
            if on { fill_rect(24, y + 6, 6, 30, 15); }
            label(44, y, 540, if on { 15 } else { 5 }, 2, item.0);
        }
        content::cursor(600, ROW_Y + SEL as i32 * ROW_H + 18, true);
    } else if PICTURE {
        draw_picture(84);
        label(24, 276, 592, 10, 1, b"Tap or swipe to go back.");
        content::cursor(614, 440, false);
    } else if BUSY && PIC_READY && PIC_FRESH {
        draw_picture(84); // what was captured, while Claude thinks
        label(24, 276, 592, 15, 0, b"Thinking...");
        content::cursor(614, 440, false);
    } else {
        draw_body();
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

/// Unsigned number after `key` in compact JSON, e.g. "len": in {"len":13824}.
fn number(msg: &[u8], key: &[u8]) -> Option<u32> {
    let at = msg.windows(key.len()).position(|w| w == key)? + key.len();
    let digits = msg[at..].iter().take_while(|b| b.is_ascii_digit());
    let mut n: u32 = 0;
    let mut any = false;
    for b in digits { n = n.wrapping_mul(10).wrapping_add((b - b'0') as u32); any = true; }
    if any { Some(n) } else { None }
}

unsafe fn handle(msg: &[u8]) -> bool {
    if let Some(t) = extract_text(msg) {
        set_body(t);
        BUSY = false;
        PICTURE = false;
    } else if msg == b"{\"type\":\"busy\"}" {
        BUSY = true;
        BUSY_MS = 0;
        PIC_FRESH = false;
        LISTENING = false;
        PICTURE = false;
    } else if msg == b"{\"type\":\"listen\"}" {
        LISTENING = true;
    } else if msg == b"{\"type\":\"quiet\"}" {
        LISTENING = false;
    } else if msg == b"{\"type\":\"pic\"}" {
        PICTURE = PIC_READY;
        MENU_OPEN = false;
    } else if msg.starts_with(b"{\"type\":\"img\"") {
        // New capture: download its picture from the phone.
        let (id, len, sum) = (number(msg, b"\"id\":"), number(msg, b"\"len\":"), number(msg, b"\"sum\":"));
        PIC_READY = false;
        if let (Some(id), Some(len), Some(sum)) = (id, len, sum) {
            if len as usize == PIC_BYTES + THUMB_BYTES { PIC_READER.start(id, len as usize, sum); }
        }
    } else {
        return false;
    }
    true
}

unsafe fn capture() {
    queue(CAPTURE);
    BUSY = true;
    BUSY_MS = 0;
    PIC_FRESH = false;
    set_body(b"Looking...");
}

/// Run the highlighted menu item.
unsafe fn pick() {
    MENU_OPEN = false;
    let msg = MENU[SEL].1;
    if msg == SHOW_PIC {
        PICTURE = PIC_READY;
        if !PIC_READY { set_body(b"No picture yet. Say CAPTURE first."); }
    } else if msg == CAPTURE {
        capture();
    } else if !msg.is_empty() {
        queue(msg);
    }
    if !msg.is_empty() {
        let cue = [29u8]; // "command accepted" click
        ble_send(0x0066, cue.as_ptr(), 1);
    }
}

/// Take double tap only while it has a job here; otherwise Mira's sidebar.
unsafe fn sync_double_tap() {
    let want = MENU_OPEN || LISTENING || (PIC_READY && !PICTURE && !BUSY && !HOLDING);
    if want != DOUBLE_TAP {
        DOUBLE_TAP = want;
        content::double_tap_local(want);
    }
}

#[no_mangle]
pub unsafe extern "C" fn app_init() {
    BRIDGE = companion::Companion::new(APP_NAME);
    BUSY = false;
    MENU_OPEN = false;
    HOLDING = false;
    LISTENING = false;
    PICTURE = false;
    DOUBLE_TAP = false;
    PIC_READY = false;
    PIC_READER.cancel();
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
        dirty |= handle(msg);
    }
    match PIC_READER.tick(ms, &mut PIC) {
        Ok(true) => { PIC_READY = true; PIC_FRESH = true; dirty = true; }
        Ok(false) => {}
        Err(()) => { PIC_READY = false; } // bad transfer: just skip the picture
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
    sync_double_tap();
    if dirty { render(); }
}

#[no_mangle]
pub unsafe extern "C" fn app_event(e: i32) {
    // 0 click, 1 swipe forward (= up/previous), 2 swipe backward (= down/next),
    // 3 double click (only reaches us while claimed), 10 hold start, 12 hold end.
    match e {
        10 => {
            if BUSY || content::sidebar_open() || content::overlay_visible() { return; }
            MENU_OPEN = false;
            PICTURE = false;
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
        3 => {
            if MENU_OPEN { MENU_OPEN = false; }
            else if PIC_READY && !PICTURE && !BUSY && !HOLDING {
                // Looking at the picture, not talking: end any follow-up window.
                if LISTENING { LISTENING = false; queue(STOP); }
                PICTURE = true;
            }
            else if LISTENING { LISTENING = false; queue(STOP); }
            else { return; }
        }
        _ if BUSY || HOLDING => return,
        0 | 1 | 2 if PICTURE => { PICTURE = false; } // any touch closes the picture
        0 => { if MENU_OPEN { pick(); } else { capture(); } }
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
    sync_double_tap();
    render();
}

#[no_mangle]
pub extern "C" fn app_stop() {}
