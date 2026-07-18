#!/usr/bin/env node
'use strict';
/*
 * cockpit-bridge — a thin, curated CDP bridge for the Skyshell live-browser cockpit.
 *
 * It attaches to the SAME Chromium the KasmVNC panel streams (CDP on
 * COCKPIT_CDP, default http://127.0.0.1:9222) — coexisting with the Playwright
 * MCP already on :8933 — and exposes one WebSocket to browser clients:
 *
 *   bridge -> client : hello, frame, nav, targets, console, net, netbody, ax, shot, error
 *   client -> bridge : mouse, key, nav, viewport, theme, shot, ax, clickNode, netbody, switchTarget, input(on/off)
 *
 * It also serves the static cockpit UI from ../web. One origin, one port.
 * Nothing here mutates the box; it only drives the browser it's pointed at.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const CDP_BASE = process.env.COCKPIT_CDP || 'http://127.0.0.1:9222';
const PORT = parseInt(process.env.COCKPIT_PORT || '8934', 10);
const HOST = process.env.COCKPIT_HOST || '127.0.0.1';
const WEB_DIR = path.resolve(__dirname, '..', 'web');
const QUALITY = parseInt(process.env.COCKPIT_QUALITY || '72', 10);
const MAXW = parseInt(process.env.COCKPIT_MAXW || '1280', 10);
const MAXH = parseInt(process.env.COCKPIT_MAXH || '800', 10);

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------------ *
 *  Real X input via xdotool.
 *  The WebRTC video is the WHOLE :99 desktop (tab strip, address bar, page).
 *  CDP's Input.dispatchMouseEvent can only reach PAGE content — never the
 *  browser chrome — and is offset from the full-frame coordinates the user
 *  clicks in. Driving the real X server instead means a click at (x,y) hits
 *  exactly what's under it (a tab's ✕, the omnibox, a menu, the page), 1:1
 *  with what's on screen. This is what makes the cockpit a real browser.
 * ------------------------------------------------------------------ */
const { spawn } = require('child_process');
const XENV = {
  ...process.env,
  DISPLAY: process.env.COCKPIT_DISPLAY || process.env.DISPLAY || ':99',
  XAUTHORITY: process.env.XAUTHORITY || path.join(process.env.HOME || '/home/ubuntu', '.Xauthority'),
};
let DESK_W = MAXW, DESK_H = MAXH;
// NB: refreshDeskSize is defined below in terms of getGeom() (execFile + a 4s
// timeout). A bare spawn() with no timeout would leave one immortal xdotool per
// 5s tick if the X server ever accepted the socket but stopped answering.

// Serialize xdotool actions so a down never overtakes the move before it; each
// call self-times-out so one wedged spawn can't stall the whole input chain.
// The timeout only unblocks the CHAIN — the spawned process keeps running, so
// long ops (typing a clipboard chunk) must pass a timeout that outlives them
// or the next op's keystrokes interleave with theirs.
let xchain = Promise.resolve();
let xdoPending = 0;                                  // queued+running xdotool ops
function xdoRun(args, timeoutMs) {
  return new Promise((res) => {
    let done = false; const fin = () => { if (!done) { done = true; res(); } };
    try {
      const p = spawn('xdotool', args, { env: XENV });
      p.on('error', fin); p.on('close', fin);
      setTimeout(fin, timeoutMs);
    } catch { fin(); }
  });
}
function xdo(args, timeoutMs = 500) {
  xdoPending++;
  xchain = xchain.then(() => xdoRun(args, timeoutMs)).then(() => { xdoPending--; }, () => { xdoPending--; });
  return xchain;
}
const deskXY = (nx, ny) => ({ x: Math.round(nx * DESK_W), y: Math.round(ny * DESK_H) });

/* ------------------------------------------------------------------ *
 *  Fast input path — persistent XTest daemon (xinput.py).
 *  One spawned PROCESS per input event (the old xdotool path) meant a mouse
 *  or trackpad flood queued seconds of spawns and clicks landed late or
 *  interleaved. The daemon holds one X connection and injects in strict
 *  order at microsecond cost; xdotool remains as an automatic fallback
 *  (and still handles keyboard, where its unicode keymap logic matters).
 * ------------------------------------------------------------------ */
let xin = null, xinAlive = false, xinFails = 0;
function startXInput() {
  if (xinFails >= 5) { log('xinput daemon disabled after repeated failures — staying on xdotool fallback'); return; }
  try {
    const child = spawn('python3', ['-u', path.join(__dirname, 'xinput.py')], { env: XENV, stdio: ['pipe', 'ignore', 'pipe'] });
    xin = child;
    let err = '';
    // EVERY stream we touch needs an 'error' listener. Writing to the stdin of a
    // child that just died raises EPIPE as an *event* on the stream (not a throw
    // from write()), and an unhandled stream 'error' takes down the whole bridge.
    // The daemon dying (e.g. kasmvnc restart kills :99) must degrade to xdotool,
    // never crash the process.
    child.stdin.on('error', () => { if (xin === child) xinAlive = false; });
    child.stderr.on('error', () => {});
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-300);
      if (!xinAlive && /xinput ready/.test(err)) { xinAlive = true; xinFails = 0; log('xinput daemon ready — XTest fast path active'); }
    });
    // 'error' (spawn failed: ENOENT) does NOT emit 'exit', so it must schedule its
    // own retry — otherwise a transient spawn failure would strand us on xdotool
    // forever. Guard with xin===child so a stale child's events can't respawn twice.
    child.on('error', () => {
      if (xin !== child) return;
      xinAlive = false; xinFails++;
      setTimeout(startXInput, 2000);
    });
    child.on('exit', (c) => {
      if (xin !== child) return;                    // superseded child — its respawn already happened
      if (xinAlive || xinFails === 0) log('xinput daemon exited (code ' + c + ') ' + err.trim().slice(-160));
      xinAlive = false; xinFails++;
      setTimeout(startXInput, 2000);
    });
  } catch (e) { xinAlive = false; xinFails++; setTimeout(startXInput, 2000); }
}
function xiSend(o) {
  if (!xinAlive || !xin || !xin.stdin || !xin.stdin.writable) return false;
  try {
    xin.stdin.write(JSON.stringify(o) + '\n');
    // A WEDGED daemon (X server hung, python swapped) never drains its pipe, but
    // the stream stays "writable" — Node just buffers in userland forever. Without
    // this check xiSend would keep reporting success, the xdotool fallback would
    // never engage, and the whole backlog would replay into the browser the moment
    // X recovered. A transient high-water mark is normal; a quarter-megabyte of
    // undrained input is not.
    if (xin.stdin.writableLength > 256000) {
      log('xinput daemon is not draining (' + xin.stdin.writableLength + 'B queued) — killing it, falling back to xdotool');
      xinAlive = false;
      try { xin.kill('SIGKILL'); } catch {}
      return false;
    }
    return true;
  } catch { xinAlive = false; return false; }
}

/* Global input ORDER. The daemon injects instantly while xdotool ops sit in a
 * spawn queue, so a click could otherwise overtake text still being typed —
 * focus moves mid-string and the tail lands in the wrong element (or fires
 * Chrome's single-key shortcuts). When any xdotool work is outstanding, daemon
 * ops queue behind it; in the steady state (nothing pending) they go straight
 * out with zero added latency. */
function inputSend(msg, fallbackArgs, timeoutMs = 500) {
  if (xdoPending === 0) {
    if (xiSend(msg)) return;
    if (fallbackArgs) xdo(fallbackArgs, timeoutMs);
    return;
  }
  xdoPending++;
  xchain = xchain
    .then(() => { if (!xiSend(msg) && fallbackArgs) return xdoRun(fallbackArgs, timeoutMs); })
    .then(() => { xdoPending--; }, () => { xdoPending--; });
}
startXInput();

/* ------------------------------------------------------------------ *
 *  Shared-display guard.
 *  :99 is one display shared by every viewer. A phone's KasmVNC session can
 *  legitimately rotate it to 720x1280 — but nothing rotated it back, so the
 *  next desktop viewer found the browser "stuck in portrait" (cockpit video
 *  has no resize channel of its own). fitDesktop() restores the 1280x800
 *  default through bctl (the same code path as a manual rotate, with a raw
 *  xrandr fallback if the named "land" mode is missing). displayGuard() runs
 *  it automatically when a cockpit viewer connects and on a slow idle loop —
 *  but ONLY while no KasmVNC client is attached, so an active phone session
 *  keeps whatever orientation it asked for.
 * ------------------------------------------------------------------ */
const { execFile } = require('child_process');
function getGeom() {
  return new Promise((res) => {
    execFile('xdotool', ['getdisplaygeometry'], { env: XENV, timeout: 4000 }, (e, out) => {
      const m = String(out || '').trim().split(/\s+/).map(Number);
      res(!e && m.length === 2 && m[0] > 0 && m[1] > 0 ? { w: m[0], h: m[1] } : null);
    });
  });
}
function refreshDeskSize() { getGeom().then(g => { if (g) { DESK_W = g.w; DESK_H = g.h; } }); }
refreshDeskSize();
setInterval(refreshDeskSize, 5000);
function kasmViewerCount() {
  return new Promise((res) => {
    execFile('ss', ['-Htn', 'state', 'established', '( sport = :6081 )'], { timeout: 4000 }, (e, out) => {
      if (e) return res(-1);                 // unknown — treat as "someone may be watching", don't touch
      res(String(out || '').split('\n').filter(l => l.trim()).length);
    });
  });
}
let fitBusy = false;
async function fitDesktop(reason) {
  if (fitBusy) return false;
  fitBusy = true;
  try {
    await fetch('http://127.0.0.1:7692/bctl/orient?mode=landscape', { method: 'POST', signal: AbortSignal.timeout(8000) }).catch(() => {});
    await new Promise(r => setTimeout(r, 600));
    let g = await getGeom();
    if (!g || g.w !== 1280 || g.h !== 800) {
      // bctl's orient needs the named "land" RandR mode — fall back to a plain mode set
      await new Promise((res) => { try { const p = spawn('xrandr', ['-s', '1280x800'], { env: XENV }); p.on('error', res); p.on('close', res); setTimeout(res, 4000); } catch { res(); } });
      await fetch('http://127.0.0.1:7692/bctl/fit', { method: 'POST', signal: AbortSignal.timeout(8000) }).catch(() => {});
      g = await getGeom();
    }
    if (g) { DESK_W = g.w; DESK_H = g.h; }
    const okNow = !!g && g.w === 1280 && g.h === 800;
    log('fitDesktop(' + reason + ') ->', g ? g.w + 'x' + g.h : 'unknown');
    broadcast({ t: 'console', level: okNow ? 'info' : 'warn', text: '[cockpit] display ' + (okNow ? 'reset to 1280×800' : 'reset attempted — still ' + (g ? g.w + 'x' + g.h : 'unknown')) + ' (' + reason + ')' });
    return okNow;
  } finally {
    setTimeout(() => { fitBusy = false; }, 2000);
  }
}
let stuckStrikes = 0, lastAutoFit = 0, declineLogged = 0;
async function displayGuard(trigger) {
  const g = await getGeom();
  if (!g) return;
  if (g.w === 1280 && g.h === 800) { stuckStrikes = 0; return; }

  // A HUMAN just opened the cockpit — a fixed-1280x800 desktop view. Their intent
  // is unambiguous, so heal it. The KasmVNC socket count is NOT consulted here on
  // purpose: a phone that walks out of wifi leaves a half-open socket ESTABLISHED
  // for many minutes (measured: it still showed a "viewer" a second after the peer
  // was destroyed), and letting that veto the heal is exactly how the display
  // stays stuck in portrait for the person actually looking at it.
  if (trigger === 'viewer-connect') {
    if (Date.now() - lastAutoFit < 120000) return;
    lastAutoFit = Date.now(); stuckStrikes = 0;
    await fitDesktop(trigger);
    return;
  }

  // The BACKGROUND loop is conservative: never yank the display out from under a
  // KasmVNC session that is genuinely attached and in use.
  const kasm = await kasmViewerCount();
  if (kasm !== 0) {
    if (Date.now() - declineLogged > 60000) {
      declineLogged = Date.now();
      log('displayGuard: :99 is ' + g.w + 'x' + g.h + ' but ' + (kasm < 0 ? 'the KasmVNC viewer count is UNKNOWN (ss failed)' : kasm + ' KasmVNC viewer(s) attached') + ' — leaving it alone (reopen the panel, or use the ⛶ Fit desktop button, to force)');
    }
    stuckStrikes = 0; return;
  }
  stuckStrikes++;
  if (stuckStrikes < 2) return;                                        // ~2 min of a stuck display before the idle loop acts — don't race a reconnecting phone
  if (Date.now() - lastAutoFit < 120000) return;
  lastAutoFit = Date.now(); stuckStrikes = 0;
  await fitDesktop(trigger);
}
setInterval(() => { displayGuard('idle').catch(() => {}); }, 60000);

/* ------------------------------------------------------------------ *
 *  Clipboard: ONE shared clipboard between the user's device and the remote
 *  browser, synced automatically in both directions.
 *
 *    remote -> local : clipwatch.py raises an XFIXES event the moment anything
 *                      in the remote browser copies (Ctrl+C *or* the context
 *                      menu). We read the text and push it to the viewer, which
 *                      writes it to the real system clipboard.
 *    local  -> remote: the viewer reads its own clipboard (on focus) and sends
 *                      it; we load it into the remote X clipboard so Ctrl+V
 *                      inside the browser pastes it. 'paste' does both at once.
 *
 *  Echo guard: our own xclipSet makes xclip the selection owner, which fires
 *  clipwatch — without lastPush we would read our own write back and bounce it
 *  to the viewer forever.
 *  The manual 'type'/'set'/'get' actions stay as the no-permission fallback.
 * ------------------------------------------------------------------ */
let lastRemoteClip = null, lastPush = null, clipTimer = null;
let cw = null, cwFails = 0;
function startClipWatch() {
  if (cwFails >= 5) { log('clipwatch disabled after repeated failures — clipboard sync is manual only'); return; }
  try {
    const child = spawn('python3', ['-u', path.join(__dirname, 'clipwatch.py')], { env: XENV, stdio: ['ignore', 'pipe', 'pipe'] });
    cw = child;
    let buf = '';
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.stderr.on('data', (d) => { if (/clipwatch ready/.test(String(d))) { cwFails = 0; log('clipwatch ready — remote copies sync to your device automatically'); } });
    child.stdout.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      buf = '';
      // Debounce: a single copy can bump the selection more than once, and the
      // owner change can land a hair before the content is servable.
      clearTimeout(clipTimer);
      clipTimer = setTimeout(pullRemoteClip, 120);
    });
    child.on('error', () => { if (cw === child) { cwFails++; setTimeout(startClipWatch, 3000); } });
    child.on('exit', () => { if (cw !== child) return; cwFails++; setTimeout(startClipWatch, 3000); });
  } catch { cwFails++; setTimeout(startClipWatch, 3000); }
}
async function pullRemoteClip() {
  const text = await xclipGet();
  if (text == null || text === '') return;
  if (text === lastPush) return;            // our own write coming back — do not bounce it
  if (text === lastRemoteClip) return;
  lastRemoteClip = text;
  broadcast({ t: 'clip', remote: text.slice(0, 262144) });
}
startClipWatch();
const TYPE_MAX = 300;    // above this we paste instead of typing (see below)
async function typeText(text) {
  text = String(text).slice(0, 20000);
  // Long text is PASTED, not typed. Typing 20k chars is ~1500 keystrokes ≈ 160s
  // during which the input queue is monopolised — every click and keypress in
  // that window would land after it, or worse, interleave into it. One
  // clipboard load + Ctrl+V is instant and lands atomically.
  if (text.length > TYPE_MAX) {
    if (await xclipSet(text)) { inputSend({ t: 'k', sym: 'v', mods: ['Control_L'] }, ['key', '--clearmodifiers', 'ctrl+v']); return 'paste'; }
    // clipboard unavailable — fall through and type it anyway
  }
  for (let i = 0; i < text.length; i += 200) {
    xdo(['type', '--clearmodifiers', '--delay', '8', '--', text.slice(i, i + 200)], 10000);
  }
  await xchain;
  return 'type';
}
function xclipSet(text) {
  // Record OUR write centrally: every path that loads the remote clipboard
  // (auto-push, paste, long-text type, the manual button) makes xclip the
  // selection owner, which fires clipwatch. Without this the bridge would read
  // its own write back and bounce it to the viewer as if the remote had copied.
  const mine = String(text).slice(0, 262144);
  lastPush = mine; lastRemoteClip = mine;
  return new Promise((res) => {
    try {
      // 'exit', NOT 'close', and stdout/stderr NOT piped. xclip FORKS a background
      // process to own the X selection (that's how X clipboards work — an owner
      // must stay alive), and that fork inherits our pipes. Waiting for 'close'
      // therefore waits for the *grandchild* to die, which only happens when some
      // other app takes the clipboard — so a perfectly successful write hung for
      // the full 4s timeout and then reported FAILURE. That made "→ Remote
      // clipboard" always show an error, and silently disabled the paste path for
      // long text.
      const p = spawn('xclip', ['-i', '-selection', 'clipboard'], { env: XENV, stdio: ['pipe', 'ignore', 'ignore'] });
      let fin = false; const done = (v) => { if (!fin) { fin = true; res(v); } };
      p.on('error', () => done(false));
      p.stdin.on('error', () => done(false));   // xclip missing/dead => EPIPE event, not a throw
      p.on('exit', (c) => done(c === 0));
      setTimeout(() => done(false), 4000);      // don't kill: the fork legitimately lives on
      p.stdin.end(String(text).slice(0, 262144));
    } catch { res(false); }
  });
}
function xclipGet() {
  return new Promise((res) => {
    try {
      const p = spawn('xclip', ['-o', '-selection', 'clipboard'], { env: XENV });
      let out = '', fin = false; const done = (v) => { if (!fin) { fin = true; res(v); } };
      p.stdout.on('error', () => done(null));
      p.stdout.on('data', (d) => { out += d; if (out.length > 262144) { try { p.kill(); } catch {} done(out.slice(0, 262144)); } });
      p.on('error', () => done(null));
      p.on('close', (c) => done(c === 0 ? out : (out || null)));
      setTimeout(() => { try { p.kill(); } catch {} done(out || null); }, 4000);
    } catch { res(null); }
  });
}

// Coalesce the fire-hose of mousemove events to the latest position, but
// always flush the pending move right before a press/release/wheel so the
// action lands on the exact pixel even if intermediate moves were dropped.
// The XTest daemon is cheap (8ms window ≈ 120Hz); the xdotool fallback keeps
// the old, safer 24ms.
let pendingMove = null, moveTimer = null;
function flushMove() {
  if (moveTimer) { clearTimeout(moveTimer); moveTimer = null; }
  if (pendingMove) {
    const { x, y } = pendingMove; pendingMove = null;
    inputSend({ t: 'm', x, y }, ['mousemove', '--sync', String(x), String(y)]);
  }
}
function queueMove(x, y) {
  // With the XTest daemon a move costs microseconds, and the CLIENT already
  // throttles its moves — so coalescing here buys nothing and costs up to a full
  // debounce interval of pointer lag on every drag. Inject immediately.
  // (The xdotool fallback still coalesces: there a move is a whole process.)
  if (xinAlive && xdoPending === 0) { inputSend({ t: 'm', x, y }, ['mousemove', '--sync', String(x), String(y)]); return; }
  pendingMove = { x, y };
  if (!moveTimer) moveTimer = setTimeout(() => { moveTimer = null; flushMove(); }, xinAlive ? 4 : 24);
}

const XBTN = { 0: 1, 1: 2, 2: 3 };                             // left/middle/right ONLY
// mods bitmask from the UI: 1=Alt 2=Ctrl 4=Meta 8=Shift
const modSeq = (mods) => [(mods & 2) && 'ctrl', (mods & 1) && 'alt', (mods & 4) && 'super', (mods & 8) && 'shift'].filter(Boolean);
const MODSYM = { ctrl: 'Control_L', alt: 'Alt_L', super: 'Super_L', shift: 'Shift_L' };
const modSyms = (mods) => modSeq(mods).map(s => MODSYM[s]);
// JS KeyboardEvent.key -> X keysym NAME. These names all resolve to a real
// keycode in any standard keymap, so the daemon can inject them directly (no
// keymap remapping) — which is what takes autorepeating keys (Backspace, the
// arrows) off the one-process-per-keystroke path.
const KEYSYM = {
  'Enter': 'Return', 'Backspace': 'BackSpace', 'Delete': 'Delete', 'Tab': 'Tab', 'Escape': 'Escape',
  'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
  'Home': 'Home', 'End': 'End', 'PageUp': 'Prior', 'PageDown': 'Next',
  ' ': 'space', 'Insert': 'Insert', 'ContextMenu': 'Menu',
  'F1': 'F1', 'F2': 'F2', 'F3': 'F3', 'F4': 'F4', 'F5': 'F5', 'F6': 'F6',
  'F7': 'F7', 'F8': 'F8', 'F9': 'F9', 'F10': 'F10', 'F11': 'F11', 'F12': 'F12',
};
// Punctuation -> keysym names, for modifier combos (ctrl+- / ctrl+= zoom, etc).
const PUNCT = {
  '+': 'plus', '-': 'minus', '=': 'equal', '_': 'underscore', '/': 'slash', '\\': 'backslash',
  '.': 'period', ',': 'comma', ';': 'semicolon', "'": 'apostrophe', '`': 'grave',
  '[': 'bracketleft', ']': 'bracketright',
};
function symName(k) {
  if (KEYSYM[k]) return KEYSYM[k];
  if (k.length === 1) return /[a-zA-Z0-9]/.test(k) ? k : (PUNCT[k] || null);
  return null;
}

// --- auth: WebSocket clients must present the correct Origin AND a per-server
// token that is injected into the served page. A hostile page inside the very
// browser this bridge controls cannot match the Origin (browsers set it and JS
// can't forge it) nor read the token (it's same-origin to the cockpit page).
// Token persists outside the rsync'd dir so redeploys don't invalidate open tabs.
const TOKEN_FILE = process.env.COCKPIT_TOKEN_FILE || path.join(process.env.HOME || __dirname, '.cockpit-token');
let AUTH = '';
try { AUTH = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!AUTH) { AUTH = require('crypto').randomBytes(24).toString('base64url'); try { fs.writeFileSync(TOKEN_FILE, AUTH, { mode: 0o600 }); } catch {} }
const SUBPROTO = 'cockpit.' + AUTH;
const ALLOWED_ORIGINS = (process.env.COCKPIT_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
function originOk(o) {
  o = o || '';
  // loopback origins are only reachable via SSH tunnel / on-box (an internet
  // attacker's page can't present a localhost Origin), so always trust them.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true;
  return ALLOWED_ORIGINS.includes(o);
}

/* ------------------------------------------------------------------ *
 *  CDP client — one WebSocket to the active page target, id-correlated.
 * ------------------------------------------------------------------ */
class CDP {
  constructor() {
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();   // event name -> fn(params)
    this.targetId = null;
    this.connected = false;
  }
  on(evt, fn) { this.handlers.set(evt, fn); }

  async listPages() {
    const res = await fetch(`${CDP_BASE}/json`).then(r => r.json());
    return res.filter(t => t.type === 'page' && !/^devtools:/.test(t.url));
  }

  async connect(targetId) {
    const pages = await this.listPages();
    if (!pages.length) throw new Error('no page targets on ' + CDP_BASE);
    const target = (targetId && pages.find(p => p.id === targetId)) || pages[0];
    this.targetId = target.id;
    await this._openWs(target.webSocketDebuggerUrl);
    return target;
  }

  _openWs(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
      this.ws = ws;
      ws.on('open', () => { this.connected = true; resolve(); });
      ws.on('message', (buf) => {
        let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve: rs, reject: rj, t } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(t);                       // else every screencastFrameAck (30-60/s) leaves a live 20s timer
          msg.error ? rj(new Error(msg.error.message || 'cdp error')) : rs(msg.result);
        } else if (msg.method) {
          const h = this.handlers.get(msg.method);
          if (h) { try { h(msg.params); } catch (e) { log('handler err', msg.method, e.message); } }
        }
      });
      // A close BEFORE 'open' must reject, or connect() awaits a promise that can
      // never settle and startSession() hangs forever holding a half-wired session.
      ws.on('close', () => { this.connected = false; reject(new Error('cdp ws closed')); });
      ws.on('error', (e) => { if (!this.connected) reject(e); else log('cdp ws error', e.message); });
    });
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('cdp not connected'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); }
      }, 20000);
      this.pending.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws && this.ws.close(); } catch {} }
}

/* ------------------------------------------------------------------ *
 *  Session — owns the CDP connection + domain wiring, fans out to clients.
 * ------------------------------------------------------------------ */
const clients = new Set();
const MAX_BUFFERED = 4 * 1024 * 1024;    // a viewer this far behind cannot be caught up

// Control messages go to everyone. FRAMES are different: they are 100-250KB of
// base64 JPEG at up to 30/s, and they must NEVER go to a viewer that is watching
// the WebRTC video — that is exactly the dead weight that congested the link and
// knocked the media path to 'disconnected'. Suppressing the screencast SOURCE is
// not enough: one fallback viewer (a phone, or a tab whose WebRTC failed) would
// otherwise put every WebRTC viewer back on the firehose.
function broadcast(obj) {
  const s = JSON.stringify(obj);
  const isFrame = obj.t === 'frame';
  for (const c of clients) {
    if (c.readyState !== WebSocket.OPEN) continue;
    if (isFrame && c.videoMode !== 'jpeg') continue;
    // Backpressure: a viewer on a slow link (the phone this fallback exists for)
    // cannot drain 30 frames/s. Without this the undeliverable frames pile into
    // ws.bufferedAmount — hundreds of MB in minutes — until the OOM killer picks
    // a victim. Frames are disposable: drop them for a viewer that is behind.
    if (isFrame && c.bufferedAmount > MAX_BUFFERED) { c.slowFrames = (c.slowFrames || 0) + 1; continue; }
    c.send(s);
  }
}

let cdp = null;
let lastMeta = { deviceWidth: MAXW, deviceHeight: MAXH, offsetTop: 0, pageScaleFactor: 1 };
let curUrl = '', curTitle = '', lastFrameAt = 0;

// Screencast only emits on visual change, so an idle page goes silent and new
// clients see black. captureFrame() paints the CURRENT state on demand; a slow
// idle-refresh loop + an on-connect capture keep the view live without spamming.
async function captureFrame() {
  if (!cdp || !cdp.connected || !clients.size) return;
  try {
    const lm = await cdp.send('Page.getLayoutMetrics').catch(() => null);
    if (lm && lm.cssVisualViewport) lastMeta = { deviceWidth: lm.cssVisualViewport.clientWidth, deviceHeight: lm.cssVisualViewport.clientHeight, offsetTop: 0, pageScaleFactor: 1 };
    const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY });
    broadcast({ t: 'frame', data: r.data, meta: lastMeta });
    lastFrameAt = Date.now();
  } catch {}
}

async function wireDomains(c) {
  c.on('Page.screencastFrame', async (p) => {
    lastMeta = p.metadata; lastFrameAt = Date.now();
    broadcast({ t: 'frame', data: p.data, meta: p.metadata });
    try { await c.send('Page.screencastFrameAck', { sessionId: p.sessionId }); } catch {}
  });
  c.on('Page.frameNavigated', (p) => {
    if (p.frame && !p.frame.parentId) { curUrl = p.frame.url; broadcast({ t: 'nav', url: curUrl, title: curTitle }); }
  });
  c.on('Page.navigatedWithinDocument', (p) => { curUrl = p.url; broadcast({ t: 'nav', url: curUrl, title: curTitle }); });
  c.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map(fmtRemote).join(' ');
    broadcast({ t: 'console', level: p.type, text, ts: p.timestamp });
  });
  c.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    const text = d.exception ? (d.exception.description || d.exception.value) : d.text;
    broadcast({ t: 'console', level: 'error', text: String(text), ts: p.timestamp });
  });
  c.on('Log.entryAdded', (p) => {
    const e = p.entry || {};
    broadcast({ t: 'console', level: e.level === 'error' ? 'error' : (e.level === 'warning' ? 'warn' : 'info'), text: e.text, ts: e.timestamp, src: e.source });
  });
  c.on('Network.requestWillBeSent', (p) => {
    broadcast({ t: 'net', phase: 'req', id: p.requestId, method: p.request.method, url: p.request.url, ts: p.timestamp, rtype: p.type });
  });
  c.on('Network.responseReceived', (p) => {
    broadcast({ t: 'net', phase: 'res', id: p.requestId, status: p.response.status, mime: p.response.mimeType, url: p.response.url });
  });
  c.on('Network.loadingFinished', (p) => broadcast({ t: 'net', phase: 'done', id: p.requestId, size: p.encodedDataLength }));
  c.on('Network.loadingFailed', (p) => broadcast({ t: 'net', phase: 'fail', id: p.requestId, error: p.errorText }));

  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable').catch(() => {});
  await c.send('Network.enable').catch(() => {});
  await c.send('DOM.enable').catch(() => {});
  // startScreencast only emits frames for the FOREGROUNDED tab — force ours visible.
  await c.send('Page.bringToFront').catch(() => {});
  screencastOn = false;            // fresh CDP session starts with screencast off
  applyScreencast();               // (serialized; re-derives from the viewers' modes)
  try {
    const { frameTree } = await c.send('Page.getFrameTree');
    curUrl = frameTree.frame.url;
  } catch {}
}

/* The JPEG screencast is only the FALLBACK view — while every connected viewer
 * is on WebRTC video, broadcasting ~100-250KB base64 frames down the same
 * tunnel is pure waste that congests the viewer's downlink and can knock the
 * WebRTC media path into 'disconnected' (measured: 1.1MB of dead JPEG on one
 * short session). Viewers report their mode ({t:'video', mode:'rtc'|'jpeg'});
 * the screencast runs only while someone actually needs it. */
let screencastOn = false;
// Needs the fallback stream ONLY if a live viewer is actually rendering it.
// 'rtc' = watching the video; 'idle' = the panel is closed or the tab is hidden,
// so it is rendering nothing at all and must not pull frames out of the browser.
function anyJpeg() {
  for (const c of clients) if (c.readyState === WebSocket.OPEN && c.videoMode === 'jpeg') return true;
  return false;
}
// SERIALIZED: toggles must never overlap. A viewer connects (want=ON) and
// reports 'rtc' milliseconds later (want=OFF) — run concurrently, the second
// call read a stale screencastOn (the first was still awaiting its CDP round
// trip), saw "no change", and returned, leaving the screencast running for a
// WebRTC viewer forever. Each queued step re-derives `want` at execution time.
let scChain = Promise.resolve();
function applyScreencast() {
  scChain = scChain.then(async () => {
    if (!cdp || !cdp.connected) return;
    const want = clients.size > 0 && anyJpeg();
    if (want === screencastOn) return;
    try {
      if (want) await cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: MAXW, maxHeight: MAXH, everyNthFrame: 1 });
      else await cdp.send('Page.stopScreencast');
      screencastOn = want;
      log('screencast', want ? 'ON (a viewer needs the JPEG fallback)' : 'OFF (all viewers on WebRTC)');
    } catch (e) { log('screencast toggle failed:', e.message); }
  }).catch(() => {});
  return scChain;
}

function fmtRemote(a) {
  if (a == null) return String(a);
  if (a.type === 'string') return a.value;
  if ('value' in a) return typeof a.value === 'object' ? JSON.stringify(a.value) : String(a.value);
  return a.description || a.preview?.description || a.subtype || a.type || '';
}

// Serialized: the 4s reconnect tick, a switchTarget from a client, and the
// initial attach can otherwise overlap — one closing a socket the other is still
// opening, leaving a half-wired session and a dangling promise.
let sessionChain = Promise.resolve();
function startSession(targetId) {
  sessionChain = sessionChain.then(() => _startSession(targetId)).catch((e) => { throw e; });
  return sessionChain;
}
async function _startSession(targetId) {
  if (cdp) { try { await cdp.send('Page.stopScreencast'); } catch {} cdp.close(); }
  cdp = new CDP();
  const target = await cdp.connect(targetId);
  curUrl = target.url; curTitle = target.title || '';
  await wireDomains(cdp);
  log('attached to target', cdp.targetId, curUrl);
  broadcast({ t: 'nav', url: curUrl, title: curTitle });
  await sendTargets();
}

async function sendTargets() {
  try {
    const pages = await cdp.listPages();
    broadcast({ t: 'targets', list: pages.map(p => ({ id: p.id, url: p.url, title: p.title, active: p.id === cdp.targetId })) });
  } catch {}
}

/* ------------------------------------------------------------------ *
 *  Input + control handlers (client -> browser)
 * ------------------------------------------------------------------ */
function handleMouse(m, ws) {
  const { x, y } = deskXY(m.nx, m.ny);
  if (m.type === 'move') { queueMove(x, y); return; }
  flushMove();                                    // land the action on the exact pixel
  // Modifiers must be HELD across the button/wheel action or ctrl-click, shift-
  // click and ctrl-wheel silently degrade to plain ones — a user ctrl-clicking
  // links to open background tabs would instead navigate away from the page.
  const mods = modSyms(m.mods || 0);              // X keysym names, for the daemon
  const xdoMod = modSeq(m.mods || 0).join('+');   // "ctrl+shift", for the xdotool fallback
  const withMods = (...tail) => {
    const a = ['mousemove', '--sync', String(x), String(y)];
    if (xdoMod) a.push('keydown', xdoMod);
    a.push(...tail);
    if (xdoMod) a.push('keyup', xdoMod);
    return a;
  };
  if (m.type === 'wheel') {
    // New clients pre-accumulate trackpad deltas into whole notches (m.wy/m.wx,
    // with a carry client-side); legacy clients send raw dy/dx per event, which
    // we convert the old way. Without notch accumulation a soft trackpad scroll
    // became a minimum-one-notch event 30-60x/sec — the scroll-speed/lag storm.
    const wy = m.wy !== undefined ? m.wy : (m.dy ? Math.sign(m.dy) * Math.min(10, Math.max(1, Math.round(Math.abs(m.dy) / 100))) : 0);
    const wx = m.wx !== undefined ? m.wx : (m.dx ? Math.sign(m.dx) * Math.min(10, Math.max(1, Math.round(Math.abs(m.dx) / 100))) : 0);
    // Carry x/y: X delivers a wheel event to whatever is under the POINTER, and
    // the pointer only tracks the cursor once a move has been sent. Scrolling
    // before the first mousemove (panel just opened) would otherwise scroll
    // whatever the pointer was last parked on — a different tab, or the page
    // behind a menu. Positioning atomically with the notch makes it always land
    // under the user's cursor.
    if (wy) {
      const b = wy > 0 ? 5 : 4, n = Math.min(20, Math.abs(wy));
      inputSend({ t: 'w', b, n, x, y, mods }, withMods('click', '--repeat', String(n), String(b)));
    }
    if (wx) {
      const b = wx > 0 ? 7 : 6, n = Math.min(20, Math.abs(wx));
      inputSend({ t: 'w', b, n, x, y, mods }, withMods('click', '--repeat', String(n), String(b)));
    }
    return;
  }
  const btn = XBTN[m.button];
  if (!btn) return;                               // thumb/extra buttons: ignore, never remap to a left-click
  if (m.type === 'down' || m.type === 'up') {
    const down = m.type === 'down';
    // Track what WE pressed, per client, so a viewer that vanishes mid-drag
    // doesn't leave a button held down on the SHARED desktop (every later move
    // would select text and no click would work until someone noticed).
    if (ws) { if (down) ws.held.add(btn); else ws.held.delete(btn); }
    // Daemon path is atomic mods+move+press/release on one ordered pipe — the old
    // overlapping-spawn reordering (down/up landing out of order under load,
    // i.e. broken clicks) can't happen there.
    inputSend({ t: 'b', x, y, b: btn, d: down ? 1 : 0, mods },
      withMods(down ? 'mousedown' : 'mouseup', String(btn)));
  }
}
function releaseHeld(ws) {
  if (!ws || !ws.held || !ws.held.size) return;
  for (const b of ws.held) inputSend({ t: 'b', b, d: 0 }, ['mouseup', String(b)]);
  log('released ' + ws.held.size + ' stuck mouse button(s) left by a departing viewer');
  ws.held.clear();
}

function handleKey(m) {
  if (m.type !== 'down') return;                  // press+release is atomic on both paths — act once, on keydown
  const k = m.key;
  if (!k || k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return;  // bare modifiers ride on the real key
  const seq = modSeq(m.mods || 0);
  const hasCombo = seq.some(s => s !== 'shift');   // ctrl/alt/super held => a shortcut, not literal text
  const named = KEYSYM[k];

  // FAST PATH — named keys (Backspace, arrows, Enter…) and every modifier combo
  // go to the XTest daemon. Holding Backspace autorepeats keydown ~30x/sec; on
  // the old spawn-per-key path that queued ~30 processes a second at 30-40ms
  // each, so the chain fell behind and kept deleting for seconds AFTER the key
  // was released — the same flood that made the mouse unusable, left live on the
  // keyboard. These keysym names exist in every keymap, so no remapping needed.
  if (xinAlive && (named || hasCombo)) {
    const sym = named || symName(k);
    if (sym) { inputSend({ t: 'k', sym, mods: modSyms(m.mods || 0) }, ['key', '--clearmodifiers', seq.concat(sym).join('+')]); return; }
  }
  // Literal text keeps xdotool `type`: it does the unicode/keymap gymnastics
  // (scratch-keycode remapping) that arbitrary characters need, and human typing
  // is far too slow to flood anything.
  if (k.length === 1 && !hasCombo) { xdo(['type', '--clearmodifiers', '--', k]); return; }
  const sym = named || (k.length === 1 ? k : null);
  if (sym) xdo(['key', '--clearmodifiers', seq.concat(sym).join('+')]);
}

const VIDEO_MODES = new Set(['rtc', 'jpeg', 'idle']);
async function handleClientMsg(m, fromWs) {
  // Input goes to the real X server, independent of CDP — the browser stays
  // drivable even if the CDP side-channel blips, and it reaches the tab strip.
  if (m.t === 'mouse') { handleMouse(m, fromWs); return; }
  if (m.t === 'key') { handleKey(m); return; }
  // X-layer controls — like input, these must not depend on the CDP channel.
  const reply = (o) => { if (fromWs && fromWs.readyState === WebSocket.OPEN) fromWs.send(JSON.stringify(o)); };
  if (m.t === 'video') {           // viewer reports its render mode (rtc|jpeg|idle)
    if (fromWs) { fromWs.videoMode = VIDEO_MODES.has(m.mode) ? m.mode : 'jpeg'; applyScreencast(); }
    return;
  }
  if (m.t === 'fitDesktop') { lastAutoFit = Date.now(); await fitDesktop('button').catch(() => {}); return; }
  if (m.t === 'clip') {
    try {
      if (m.action === 'push' && typeof m.text === 'string') {
        // The viewer's system clipboard changed — mirror it into the remote
        // browser so a plain Ctrl+V there pastes it. Silent (no reply): this
        // fires on focus, not on a button press.
        if (m.text !== lastPush && m.text !== lastRemoteClip) {
          lastPush = m.text; lastRemoteClip = m.text;
          await xclipSet(m.text);
        }
      } else if (m.action === 'paste' && typeof m.text === 'string' && m.text) {
        // Cmd/Ctrl+V pressed while driving the remote: load the text, then press
        // Ctrl+V *inside* the remote browser so it lands in the focused field.
        lastPush = m.text; lastRemoteClip = m.text;
        const ok = await xclipSet(m.text);
        if (!ok) { reply({ t: 'clip', error: 'could not load the remote clipboard' }); return; }
        await new Promise(r => setTimeout(r, 40));   // let xclip's fork actually own the selection
        inputSend({ t: 'k', sym: 'v', mods: ['Control_L'] }, ['key', '--clearmodifiers', 'ctrl+v']);
        reply({ t: 'clip', done: 'paste' });
      } else if (m.action === 'type' && typeof m.text === 'string' && m.text) {
        const how = await typeText(m.text);       // long text is pasted, not typed
        reply({ t: 'clip', done: how });
      } else if (m.action === 'set' && typeof m.text === 'string') {
        const ok = await xclipSet(m.text);
        reply({ t: 'clip', done: ok ? 'set' : null, error: ok ? undefined : 'remote clipboard write failed (is xclip installed?)' });
      } else if (m.action === 'get') {
        const v = await xclipGet();
        reply(v == null ? { t: 'clip', error: 'remote clipboard read failed (empty, or xclip missing)' } : { t: 'clip', text: v });
      }
    } catch (e) { reply({ t: 'clip', error: String(e.message || e) }); }
    return;
  }
  if (!cdp || !cdp.connected) return;
  try {
    switch (m.t) {
      case 'nav': {
        if (m.action === 'go' && m.url) {
          let u = m.url.trim();
          if (/^https?:\/\//i.test(u)) { /* http(s) allowed */ }
          else if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) u = null;   // block file:/chrome:/data:/about:/javascript:
          else u = 'https://' + u;                              // bare host -> https
          if (u) await cdp.send('Page.navigate', { url: u });
          else broadcast({ t: 'error', msg: 'blocked a non-http(s) URL' });
        } else if (m.action === 'back') { await cdp.send('Runtime.evaluate', { expression: 'history.back()' }); }
        else if (m.action === 'forward') { await cdp.send('Runtime.evaluate', { expression: 'history.forward()' }); }
        else if (m.action === 'reload') { await cdp.send('Page.reload', {}); }
        break;
      }
      case 'viewport': {
        if (m.reset) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
        else await cdp.send('Emulation.setDeviceMetricsOverride', { width: m.w, height: m.h, deviceScaleFactor: m.dsf || 0, mobile: !!m.mobile });
        break;
      }
      case 'theme': {
        const features = m.scheme === 'no-override' ? [] : [{ name: 'prefers-color-scheme', value: m.scheme }];
        await cdp.send('Emulation.setEmulatedMedia', { features });
        break;
      }
      case 'shot': {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        broadcast({ t: 'shot', data: r.data });
        break;
      }
      case 'ax': {
        const r = await cdp.send('Accessibility.getFullAXTree').catch(() => ({ nodes: [] }));
        broadcast({ t: 'ax', nodes: (r.nodes || []).slice(0, 4000) });
        break;
      }
      case 'clickNode': {
        try {
          const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: m.backendNodeId });
          const q = model.content; const cx = (q[0] + q[2] + q[4] + q[6]) / 4; const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
        } catch (e) { broadcast({ t: 'error', msg: 'clickNode: ' + e.message }); }
        break;
      }
      case 'netbody': {
        try {
          const r = await cdp.send('Network.getResponseBody', { requestId: m.id });
          broadcast({ t: 'netbody', id: m.id, body: r.body.slice(0, 200000), base64: r.base64Encoded });
        } catch (e) { broadcast({ t: 'netbody', id: m.id, error: e.message }); }
        break;
      }
      case 'switchTarget': { await startSession(m.id); break; }
    }
  } catch (e) { log('client msg err', m.t, e.message); }
}

/* ------------------------------------------------------------------ *
 *  HTTP static + WS server
 * ------------------------------------------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
// /geo — honest egress-location for the UI pills (the "London" label used to be
// a hardcoded string). Sourced from tabs_service's proxied probe (:7691/stats),
// which checks the REAL residential exit; cached 60s here so pill polling is free.
let geoCache = { at: 0, body: null };
function serveGeo(res) {
  const json = (b) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(b); };
  if (geoCache.body && Date.now() - geoCache.at < 60000) return json(geoCache.body);
  fetch('http://127.0.0.1:7691/stats', { signal: AbortSignal.timeout(4000) })
    .then(r => r.json())
    .then(s => {
      const g = s.geo || {};
      const body = JSON.stringify({ ok: s.proxy_ok === true, city: g.city || null, country: g.country || null, checked: g.checked || null });
      geoCache = { at: Date.now(), body };
      json(body);
    })
    .catch(() => json(JSON.stringify({ ok: null })));
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(cdp && cdp.connected ? 'ok' : 'no-cdp'); }
  if (req.url === '/geo' || req.url.startsWith('/geo?')) return serveGeo(res);
  // decodeURIComponent THROWS on a malformed escape ("/%"), and a decoded NUL
  // makes fs.readFile throw synchronously — either one, unhandled inside this
  // handler, is an uncaughtException that kills the whole bridge on one request.
  let rel;
  try {
    rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.includes('\0')) throw new Error('nul');
  } catch { res.writeHead(400); return res.end('bad request'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const fp = path.join(WEB_DIR, path.normalize(rel));
  if (!fp.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    let out = data;
    if (fp === path.join(WEB_DIR, 'index.html')) {
      out = Buffer.from(data.toString('utf8').replace('</head>', `<script>window.__CKPT_TOKEN=${JSON.stringify(AUTH)}</script></head>`));
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(out);
  });
});

// Nagle's algorithm batches small writes and can sit on an input event for tens
// of milliseconds waiting for more data. Every message on this socket is a tiny,
// latency-critical input event — send them the instant they exist.
server.on('connection', (socket) => { try { socket.setNoDelay(true); } catch {} });

const wss = new WebSocketServer({
  server, path: '/ws',
  verifyClient: (info) => {
    if (!originOk(info.origin)) { log('ws reject — origin', info.origin); return false; }
    const protos = String(info.req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
    if (!protos.includes(SUBPROTO)) { log('ws reject — bad/missing token from', info.origin); return false; }
    return true;
  },
});
wss.on('connection', (ws) => {
  ws.videoMode = 'jpeg';           // until its WebRTC connects, a viewer needs the fallback
  ws.held = new Set();             // mouse buttons this viewer is holding down
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  clients.add(ws);
  log('client connected, total', clients.size);
  ws.send(JSON.stringify({ t: 'hello', url: curUrl, title: curTitle, cdp: !!(cdp && cdp.connected) }));
  sendTargets();
  applyScreencast();
  captureFrame();   // paint current state immediately for the new client
  // Heal a stuck portrait display the moment someone opens the panel. On EVERY
  // connect, not just the first: with a second tab already attached, the viewer
  // who actually just opened the panel would otherwise never trigger it. The
  // 120s cooldown + fitBusy make repeats free.
  displayGuard('viewer-connect').catch(() => {});
  ws.on('message', (buf) => { let m; try { m = JSON.parse(buf.toString()); } catch { return; } handleClientMsg(m, ws); });
  ws.on('close', () => {
    clients.delete(ws);
    releaseHeld(ws);               // a viewer that vanished mid-drag must not leave a button pressed on the shared desktop
    log('client gone, total', clients.size + (ws.slowFrames ? ' (dropped ' + ws.slowFrames + ' frames it could not keep up with)' : ''));
    applyScreencast();
  });
  ws.on('error', () => {});
});

// Liveness: a laptop lid closing or a phone leaving wifi leaves a HALF-OPEN
// socket that stays readyState===OPEN for ~15 minutes. Until it is reaped it
// still counts as a viewer — holding the screencast on, taking frames, and (if
// it was mid-drag) holding a mouse button. Ping every 30s; a viewer that misses
// two rounds is gone.
setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) { log('reaping an unresponsive viewer'); try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

// keep the target list fresh + auto-recover if the CDP socket drops
setInterval(async () => {
  if (!cdp || !cdp.connected) { try { await startSession(); log('reconnected to CDP'); } catch (e) { /* browser down; retry next tick */ } return; }
  sendTargets();
}, 4000);

// idle-refresh: if screencast has been silent (static page), repaint so the
// view stays current for anyone watching — but only while someone is actually
// on the JPEG fallback; WebRTC viewers get their motion from the media path.
setInterval(() => { if (clients.size && anyJpeg() && Date.now() - lastFrameAt > 900) captureFrame(); }, 1000);

server.listen(PORT, HOST, async () => {
  log(`cockpit-bridge on http://${HOST}:${PORT}  (CDP ${CDP_BASE}, ws /ws)`);
  try { await startSession(); } catch (e) { log('initial CDP attach failed (will retry):', e.message); }
});
