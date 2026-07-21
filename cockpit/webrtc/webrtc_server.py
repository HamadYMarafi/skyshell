#!/usr/bin/env python3
"""
cockpit-webrtc — WebRTC media server for the live-browser cockpit.

Streams the existing X display :99 (the residential Chromium) + its audio sink
over WebRTC with H.264 + Opus. Signaling is a WebSocket, gated by the SAME
Origin allowlist + token as the rest of the cockpit (token read from the shared
file, presented by the browser as the 'cockpit.<token>' subprotocol).

The box's browser is untouched: ximagesrc is a read-only X client on :99.
Media goes direct browser<->box over one opened UDP port (host/srflx candidate
via STUN); no relay, no cost.
"""
import asyncio, json, os, threading, traceback
import gi
gi.require_version('Gst', '1.0'); gi.require_version('GstWebRTC', '1.0'); gi.require_version('GstSdp', '1.0')
from gi.repository import Gst, GstWebRTC, GstSdp, GLib
import websockets

Gst.init(None)

HOST     = os.environ.get('COCKPIT_WEBRTC_HOST', '127.0.0.1')
PORT     = int(os.environ.get('COCKPIT_WEBRTC_PORT', '8935'))
DISPLAY  = os.environ.get('DISPLAY', ':99')
PULSE    = os.environ.get('PULSE_SERVER', 'unix:/run/cockpit-pulse/native')
STUN     = os.environ.get('COCKPIT_STUN', 'stun://stun.l.google.com:19302')
BITRATE  = int(os.environ.get('COCKPIT_WEBRTC_BITRATE', '8000'))
# 60, not 30: at 30 the screen is only PHOTOGRAPHED 30x/sec while the remote
# Chromium renders at ~60 — so every change waits ~16ms on average (33ms worst)
# just to be captured. That is latency added to every single interaction, and
# motion is sampled at half the rate it is actually drawn. Doubling the capture
# rate halves the wait and makes scrolling and dragging look like a real screen.
FPS      = int(os.environ.get('COCKPIT_WEBRTC_FPS', '60'))
# Keyframe interval. The old default (2s) put a big I-frame on the wire every two
# seconds; those cost an order of magnitude more to encode and ship than a
# P-frame, and they were the visible latency SPIKES (the 224-347ms tail measured
# glass-to-glass). Nothing here needs periodic keyframes: every viewer gets a
# fresh pipeline whose first frame is an IDR, and a receiver that loses packets
# asks for one (PLI). So make them rare.
GOP      = int(os.environ.get('COCKPIT_WEBRTC_GOP', str(FPS * 10)))
# intra-refresh: TESTED AND REJECTED (2026-07-13). The theory was that keyframe
# bursts caused the latency spikes; measurement says otherwise — median was
# identical with it on (83ms) and off (84ms), and the tail did not shrink. It is
# off because it makes packet-loss recovery far worse: with no IDRs in the
# stream, a lossy wifi moment cannot be fixed by a single keyframe request and
# instead needs a full intra sweep (~1.3s of broken picture). Knob kept for
# future experiments.
INTRA_REFRESH = os.environ.get('COCKPIT_WEBRTC_INTRA_REFRESH', '0') != '0'
# ultrafast keeps x264 well under one core on this 4-core box (veryfast pegged it
# at ~154% and starved the encoder -> dropped frames/smear); the freed CPU + the
# higher bitrate below net out to a SHARPER, smoother picture, not a softer one.
PRESET   = os.environ.get('COCKPIT_WEBRTC_PRESET', 'ultrafast')
WIDTH    = int(os.environ.get('COCKPIT_WEBRTC_W', '1280'))   # must be even (x264 4:2:0); matches the pinned :99 size 1:1 (no rescale blur)
HEIGHT   = int(os.environ.get('COCKPIT_WEBRTC_H', '800'))
RTP_MIN  = int(os.environ.get('COCKPIT_RTP_MIN', '40000'))   # pinned so ONE firewall rule fits
RTP_MAX  = int(os.environ.get('COCKPIT_RTP_MAX', '40009'))
# Concurrent viewers are capped so a reconnect storm can't stack encoders and so the
# pinned 40000-40009 range (one firewall rule) can't be exhausted by simultaneous
# ICE gathering. ICE is concentrated on the routable interface via srflx-only
# candidate filtering in _on_ice (see the note in Session.start).
MAX_SESSIONS    = int(os.environ.get('COCKPIT_MAX_SESSIONS', '2'))
CONNECT_TIMEOUT = int(os.environ.get('COCKPIT_CONNECT_TIMEOUT', '20'))  # s from PLAYING to media-connected
# 15s (was 8): 'disconnected' is usually a transient the ICE layer self-heals;
# killing the pipeline early forced a full client rebuild on every link hiccup
# (matches the client's own 10s grace before it rebuilds).
DISC_GRACE      = int(os.environ.get('COCKPIT_DISC_GRACE', '15'))
TOKEN_FILE = os.environ.get('COCKPIT_TOKEN_FILE', os.path.expanduser('~/.cockpit-token'))
ALLOWED  = [o.strip() for o in os.environ.get('COCKPIT_ALLOWED_ORIGINS', '').split(',') if o.strip()]
try:
    TOKEN = open(TOKEN_FILE).read().strip()
except Exception:
    TOKEN = ''
SUBPROTO = 'cockpit.' + TOKEN if TOKEN else None

def log(*a): print('[webrtc]', *a, flush=True)

AUDIO_ON = os.environ.get('COCKPIT_AUDIO', '1') != '0'
_VIDEO = (
    'ximagesrc display-name={disp} use-damage=false show-pointer=true '
    '  ! video/x-raw,framerate={fps}/1 ! videoconvert ! videoscale add-borders=true '
    '  ! video/x-raw,format=I420,width={w},height={h},pixel-aspect-ratio=1/1 '
    # ONE buffer, not two: this queue exists to decouple the capture thread from
    # the encoder thread, not to store frames. Holding two means a frame can sit
    # here for a whole extra frame-time before it is even encoded — latency for
    # nothing. leaky=downstream means that if the encoder ever falls behind we
    # DROP the stale frame instead of delaying every frame after it.
    '  ! queue max-size-buffers=1 leaky=downstream '
    # intra-refresh: instead of dumping a whole keyframe on the wire at once (a
    # burst that takes ~10x longer to encode and send than a normal frame — the
    # measured latency SPIKES), x264 sweeps a column of intra blocks across the
    # picture, so every frame costs about the same. The result is a flat latency
    # profile instead of a periodic hitch. Safe here: each viewer gets its own
    # fresh pipeline whose first frame is a real IDR, and a lossy receiver can
    # still force a refresh via PLI.
    '  ! x264enc tune=zerolatency speed-preset={preset} bitrate={br} key-int-max={gop} intra-refresh={ir} '
    '  ! video/x-h264,profile=constrained-baseline '
    '  ! rtph264pay config-interval=-1 aggregate-mode=zero-latency '
    '  ! application/x-rtp,media=video,encoding-name=H264,payload=96 ! wrb. '
)
_AUDIO = (
    'pulsesrc server={pulse} device=cockpit.monitor '
    '  ! audioconvert ! audioresample '
    # leaky queue: when x264 hogs the CPU, drop audio backlog instead of starving
    # pulsesrc ("Can't record audio fast enough" -> Opus dropouts)
    '  ! queue max-size-time=200000000 leaky=downstream '
    '  ! opusenc bitrate=96000 complexity=4 inband-fec=true '
    '  ! rtpopuspay ! application/x-rtp,media=audio,encoding-name=OPUS,payload=97 ! wrb. '
)
PIPELINE = (
    'webrtcbin name=wrb bundle-policy=max-bundle latency=0 stun-server={stun} '
    + _VIDEO + (_AUDIO if AUDIO_ON else '')
).format(stun=STUN, disp=DISPLAY, fps=FPS, br=BITRATE, gop=GOP, pulse=PULSE, w=WIDTH, h=HEIGHT, preset=PRESET,
         ir='true' if INTRA_REFRESH else 'false')


_next_sid = [0]

class Session:
    """One viewer = one pipeline + webrtcbin. gst callbacks run on the GLib
    thread; sends are marshalled to the asyncio loop, gst ops to the GLib loop."""
    def __init__(self, ws, loop):
        _next_sid[0] += 1
        self.sid = _next_sid[0]
        self.ws, self.loop = ws, loop
        self.pipe = self.wrb = self._agent = None
        self.connected = False
        self._deadline = None    # GLib timeout source id (GLib thread only)
        self._dead = False

    def _send(self, obj):
        async def _s():
            try:
                await self.ws.send(json.dumps(obj))
            except Exception:
                pass   # viewer already gone; teardown happens via the handler
        asyncio.run_coroutine_threadsafe(_s(), self.loop)

    def start(self):
        def build():
            if self.pipe is not None or self._dead:
                return False           # duplicate 'start' — never stack a second pipeline on one session
            try:
                self.pipe = Gst.parse_launch(PIPELINE)
                self.wrb = self.pipe.get_by_name('wrb')
                try:
                    self._agent = self.wrb.get_property('ice-agent')   # keep a ref (GC'ing it corrupts ICE)
                    self._agent.set_property('min-rtp-port', RTP_MIN)
                    self._agent.set_property('max-rtp-port', RTP_MAX)
                except Exception as e:
                    log('ice port-range set failed:', e)
                # ICE is concentrated on the one internet-routable interface at the
                # CANDIDATE layer, not the binding layer: _on_ice advertises ONLY the
                # srflx (public) candidate, and only 10.0.0.102 can reach STUN to form
                # one — so Tailscale / VPN-bridge / link-local paths are never offered to
                # the peer. libnice still binds range ports on other interfaces while
                # gathering, but releases the non-nominated ones once a pair is chosen.
                # (libnice's add_local_address / GstWebRTCNice.add_local_ip_address are
                # NOT exposed via Python GI on this GStreamer 1.24 build, so we can't pin
                # at the binding layer — the srflx-only filter makes that unnecessary.)
                # Disabling UPnP just stops pointless SSDP :1900 probing on the LAN.
                try:
                    nagent = self._agent.get_property('agent')   # underlying NiceAgent GObject
                    nagent.set_property('upnp', False)
                except Exception as e:
                    log(f'#{self.sid} upnp-disable skipped:', e)
                self.wrb.connect('on-negotiation-needed', self._on_neg)
                self.wrb.connect('on-ice-candidate', self._on_ice)
                self.wrb.connect('notify::ice-connection-state', self._on_state)
                self.wrb.connect('notify::connection-state', self._on_state)
                bus = self.pipe.get_bus()
                bus.add_signal_watch()
                bus.connect('message::error', self._on_bus)
                bus.connect('message::warning', self._on_bus)
                self.pipe.set_state(Gst.State.PLAYING)
                log(f'#{self.sid} pipeline PLAYING')
                # The encoder now burns CPU whether or not media flows — bound it:
                # if the peer can't complete ICE within the deadline, kill the session.
                self._arm_deadline(CONNECT_TIMEOUT, f'not connected within {CONNECT_TIMEOUT}s')
            except Exception as e:
                log('start error:', e); traceback.print_exc()
                self._send({'type': 'error', 'msg': 'pipeline: ' + str(e)})
            return False
        GLib.idle_add(build)

    def _on_bus(self, bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error(); log('BUS ERROR:', err.message, '|', dbg)
        else:
            err, _ = msg.parse_warning(); log('BUS WARN:', err.message)

    # ---- media-state lifecycle (all on the GLib thread) ----
    def _arm_deadline(self, secs, why):
        self._clear_deadline()
        def fire():
            self._deadline = None
            self._die(why)
            return False
        self._deadline = GLib.timeout_add_seconds(secs, fire)

    def _clear_deadline(self):
        if self._deadline is not None:
            GLib.source_remove(self._deadline)
            self._deadline = None

    def _on_state(self, el, pspec):
        try:
            ice = el.get_property('ice-connection-state').value_nick
            conn = el.get_property('connection-state').value_nick
        except Exception:
            return
        log(f'#{self.sid} state ice={ice} conn={conn}')
        # FAILURE IS CHECKED FIRST. These are two independent state machines and
        # ice-connection-state's resting value after nomination is 'completed' —
        # so a success-first test ("conn connected OR ice completed") reads a dead
        # peer as healthy, clears the deadline on every notify, and leaves a full
        # x264 encoder streaming to nobody indefinitely.
        if 'failed' in (ice, conn) or conn == 'closed':
            self._die(f'media path {ice}/{conn}')
        elif 'disconnected' in (ice, conn):
            if self._deadline is None:   # grace window; cleared again if it recovers
                self._arm_deadline(DISC_GRACE, f'disconnected >{DISC_GRACE}s')
        elif conn == 'connected' or ice in ('connected', 'completed'):
            if not self.connected:
                self.connected = True
                log(f'#{self.sid} media CONNECTED')
            self._clear_deadline()

    def _die(self, why):
        """Tear down the pipeline AND kick the viewer socket so the client retries.
        Without this, a failed peer left a full x264 pipeline encoding to nobody
        until the websocket ping timeout (~40s) — or forever, if pings survived."""
        if self._dead:
            return
        self._dead = True
        log(f'#{self.sid} teardown: {why}')
        # MUST be marshalled to the GLib loop. notify:: callbacks run on
        # webrtcbin's OWN thread, and set_state(NULL) from there joins that very
        # thread -> deadlock. A wedged GLib loop wedges every session while the
        # asyncio thread keeps accepting sockets, so systemd sees a "healthy"
        # process and Restart=always never fires. Every other gst op here is
        # idle_add'd for exactly this reason.
        GLib.idle_add(lambda: (self._teardown(), False)[1])
        async def _close():
            try:
                await self.ws.close(code=1011, reason=why[:100])
            except Exception:
                pass
        asyncio.run_coroutine_threadsafe(_close(), self.loop)

    def _on_neg(self, el):
        # Async change-func pattern (NOT synchronous wait — that deadlocks/crashes).
        log('negotiation-needed')
        promise = Gst.Promise.new_with_change_func(self._on_offer, el)
        el.emit('create-offer', None, promise)
        log('create-offer emitted')

    def _on_offer(self, promise, el):
        try:
            log('_on_offer entered')
            reply = promise.get_reply(); log('got reply')
            offer = reply.get_value('offer'); log('got offer', type(offer).__name__)
            sdp_text = offer.sdp.as_text(); log('got sdp', len(sdp_text))
            el.emit('set-local-description', offer, Gst.Promise.new()); log('set-local done')
            self._send({'type': 'offer', 'sdp': sdp_text}); log('sent offer')
        except Exception as e:
            log('offer error:', e); traceback.print_exc()

    def _on_ice(self, el, mlineindex, candidate):
        # Only advertise the public UDP (srflx) candidate — the one path we opened in
        # the firewall (UDP 40000-40009). Drop host candidates (VCN-private, Tailscale,
        # link-local) and TCP-ICE candidates, which either can't carry media to the
        # remote or aren't firewalled through, forcing the known-good public UDP path.
        parts = candidate.split()
        if len(parts) < 8 or parts[2].upper() != 'UDP' or 'typ srflx' not in candidate:
            return
        self._send({'type': 'ice', 'sdpMLineIndex': mlineindex, 'candidate': candidate})

    def on_answer(self, sdp):
        def apply():
            res, msg = GstSdp.SDPMessage.new_from_text(sdp)
            answer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.ANSWER, msg)
            self.wrb.emit('set-remote-description', answer, Gst.Promise.new())
            log('applied answer'); return False
        GLib.idle_add(apply)

    def on_remote_ice(self, mlineindex, candidate):
        def add():
            self.wrb.emit('add-ice-candidate', mlineindex, candidate); return False
        GLib.idle_add(add)

    def _teardown(self):
        # GLib thread only. Idempotent.
        self._clear_deadline()
        if self.pipe:
            try:
                self.pipe.get_bus().remove_signal_watch()
            except Exception:
                pass
            self.pipe.set_state(Gst.State.NULL)
            self.pipe = self.wrb = self._agent = None

    def stop(self):
        def teardown():
            self._teardown(); return False
        GLib.idle_add(teardown)


def _headers(ws):
    # websockets API moved between versions; support both.
    r = getattr(ws, 'request', None)
    if r is not None and getattr(r, 'headers', None) is not None:
        return r.headers
    return getattr(ws, 'request_headers', {})

SESSIONS = []   # touched only from the asyncio thread

async def handler(ws, *args):
    origin = _headers(ws).get('Origin', '') or _headers(ws).get('origin', '')
    loopback = origin.startswith(('http://localhost', 'https://localhost', 'http://127.0.0.1', 'https://127.0.0.1'))
    if ALLOWED and origin not in ALLOWED and not loopback:   # loopback = tunnel/on-box only, trusted
        log('reject origin', origin); await ws.close(); return
    if SUBPROTO and getattr(ws, 'subprotocol', None) != SUBPROTO:
        log('reject token'); await ws.close(); return
    if len(SESSIONS) >= MAX_SESSIONS:
        # Reject the newcomer (never evict — two live panels would ping-pong each
        # other off). Dead slots free in <=CONNECT_TIMEOUT via the session deadline,
        # and the client keeps its JPEG fallback while it retries.
        log(f'reject viewer: at session cap {MAX_SESSIONS}')
        try:
            await ws.send(json.dumps({'type': 'error', 'msg': 'busy: viewer limit'}))
        except Exception:
            pass
        await ws.close(code=1013, reason='session cap'); return
    loop = asyncio.get_event_loop()
    sess = Session(ws, loop)
    SESSIONS.append(sess)
    log(f'viewer connected #{sess.sid} ({len(SESSIONS)}/{MAX_SESSIONS})')
    try:
        async for raw in ws:
            d = json.loads(raw)
            t = d.get('type')
            if t == 'start':
                sess.start()
            elif t == 'answer':
                sess.on_answer(d['sdp'])
            elif t == 'ice' and d.get('candidate'):
                sess.on_remote_ice(int(d.get('sdpMLineIndex', 0)), d['candidate'])
    except Exception as e:
        log('conn error:', e)
    finally:
        try:
            SESSIONS.remove(sess)
        except ValueError:
            pass
        sess.stop(); log(f'viewer gone #{sess.sid} ({len(SESSIONS)}/{MAX_SESSIONS})')


def main():
    # GStreamer wants its GLib main loop on the MAIN thread; run the asyncio
    # websocket server on a background thread. gst callbacks -> asyncio via
    # run_coroutine_threadsafe; asyncio -> gst via GLib.idle_add.
    aloop = asyncio.new_event_loop()

    def run_ws():
        asyncio.set_event_loop(aloop)
        async def serve():
            kwargs = {'subprotocols': [SUBPROTO]} if SUBPROTO else {}
            async with websockets.serve(handler, HOST, PORT, **kwargs):
                log(f'signaling on ws://{HOST}:{PORT}  (display {DISPLAY}, {FPS}fps {BITRATE}kbps, auth={"on" if SUBPROTO else "OFF"})')
                await asyncio.Future()
        try:
            aloop.run_until_complete(serve())
        except BaseException as e:
            # A dead signaling thread must kill the whole process (systemd restarts
            # us) — otherwise GLib keeps a portless zombie alive squatting the unit.
            log('FATAL: signaling server exited:', repr(e))
            os._exit(1)

    threading.Thread(target=run_ws, daemon=True).start()
    GLib.MainLoop().run()


if __name__ == '__main__':
    main()
