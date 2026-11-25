// Pokedex — glasses side (Rust -> WASM).
//
// Flow: tap the touch bar  ->  send {"type":"snap"} to the phone companion
// ->  phone grabs a camera frame, asks Claude, and replies
// {"t":"line one|line two|..."}  ->  we draw those lines on the glasses.
// A swipe (touch bar or ring) sends {"type":"swipe"}: the phone shows the next
// page of a long answer, or scans if there is none. Voice commands and
// follow-up questions are handled entirely on the phone.
//
// The phone does all networking, paging and text wrapping; this side stays tiny.
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
}
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { loop {} }

const APP_NAME: &[u8] = b"Pokedex"; // must match the manifest title in build.py
const MAX_TEXT: usize = 1024;

static mut BRIDGE: companion::Companion = companion::Companion::new(APP_NAME);
static mut BODY: [u8; MAX_TEXT] = [0; MAX_TEXT];
static mut BODY_LEN: usize = 0;
static mut BUSY: bool = false;
static mut SEND_SNAP: bool = false;
static mut SEND_SWIPE: bool = false;
static mut SEND_HELLO: bool = false;
static mut BUSY_MS: u32 = 0; // give up if the phone never answers
const BUSY_TIMEOUT_MS: u32 = 25_000;

const IDLE_MSG: &[u8] = b"Say CAPTURE, tap, or swipe the ring|to scan what's in front of you.||Then ask: READ IT, TRANSLATE,|TELL ME MORE.";

unsafe fn set_body(s: &[u8]) {
    let n = s.len().min(MAX_TEXT);
    BODY[..n].copy_from_slice(&s[..n]);
    BODY_LEN = n;
}

unsafe fn render() {
    begin();
    // Header
    let title = if BUSY { b"POKEDEX  -  thinking..." as &[u8] } else { b"POKEDEX" };
    text(24, 20, 592, 40, 15, 2, 0, 32, title.as_ptr(), title.len() as i32);
    fill_rect(24, 66, 592, 2, 6);
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

#[no_mangle]
pub unsafe extern "C" fn app_init() {
    BRIDGE = companion::Companion::new(APP_NAME);
    BUSY = false;
    SEND_SNAP = false;
    SEND_SWIPE = false;
    SEND_HELLO = true;
    set_body(IDLE_MSG);
    render();
}

#[no_mangle]
pub unsafe extern "C" fn app_render(ms: i32) {
    let mut dirty = content::context_changed();
    if let Some(msg) = BRIDGE.tick(ms.max(0) as u32) {
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
    if BUSY {
        BUSY_MS = BUSY_MS.saturating_add(ms.max(0) as u32);
        if BUSY_MS > BUSY_TIMEOUT_MS {
            BUSY = false;
            SEND_SNAP = false;
            SEND_SWIPE = false;
            set_body(b"No answer from the phone.|Is the Pokedex page open in Mira?");
            dirty = true;
        }
    }
    // Outgoing: retry on later ticks if the bridge is busy.
    if SEND_HELLO && BRIDGE.send(b"{\"type\":\"hello\"}") { SEND_HELLO = false; }
    if SEND_SNAP && BRIDGE.send(b"{\"type\":\"snap\"}") { SEND_SNAP = false; }
    if SEND_SWIPE && BRIDGE.send(b"{\"type\":\"swipe\"}") { SEND_SWIPE = false; }
    if dirty { render(); }
}

#[no_mangle]
pub unsafe extern "C" fn app_event(e: i32) {
    // 0 = touch-bar click, 1/2 = swipes (rings only send 1 and 2).
    // Double-click (3) is left to the Shell for navigation.
    if BUSY { return; }
    if e == 0 {
        BUSY = true;
        BUSY_MS = 0;
        SEND_SNAP = true;
        set_body(b"Looking...");
        render();
    } else if e == 1 || e == 2 {
        // Phone decides: next page, or a new scan (it then sends "busy").
        SEND_SWIPE = true;
    }
}

#[no_mangle]
pub extern "C" fn app_stop() {}
