# The live browser — a watchable, drivable browser on a residential IP

This is the part that makes Skyshell more than a web terminal: a **real Chromium
running on the server**, reaching the internet through a **residential IP**, that
**you can watch and click** in the app — and that **your AI can drive** at the
same time.

This page explains how it's built and how to swap in your own proxy and model.

---

## Why a residential IP at all?

A server's own IP belongs to a datacenter ASN (Oracle, AWS, Hetzner…). A huge
number of sites treat datacenter IPs as hostile by default — CAPTCHAs, silent
blocks, "unusual traffic" walls, geo-restrictions. A **residential** IP is an
address a real ISP hands to a home, so the same request looks like an ordinary
person browsing from a house.

Skyshell routes its browser (and only its browser) through a residential proxy,
so the browser you're watching behaves like a normal home visitor — while the
rest of the box keeps its own plain identity.

> **Responsibility:** a residential exit means you're browsing *as if* from
> someone's home connection. You are responsible for what the browser does and
> for complying with your proxy provider's terms and the terms of the sites you
> visit. See [SECURITY.md](../SECURITY.md).

---

## The egress chain

```
   Chromium (headed, on display :99)
        │  --proxy-server=http://127.0.0.1:8899
        ▼
   tinyproxy  (residential-proxy.service, :8899)
        │  upstream =  http://USER:PASS@your-residential-exit:PORT
        ▼
   Your residential proxy provider  →  the open web (as a home IP)
```

- **`live-browser.service`** launches Chromium with
  `--proxy-server=http://127.0.0.1:8899` so *all* of its traffic goes to the
  local proxy — never straight out.
- **`residential-proxy.service`** is a tiny [tinyproxy](https://tinyproxy.github.io/)
  whose upstream is your rented residential exit. The credentials live in
  `/etc/residential-proxy.conf` on the server — **never in git**.
- **`server/livebrowser-killswitch.sh`** is a fail-closed guard: it makes sure
  the browser can *only* reach the proxy (and its local CDP), so a dropped
  `--proxy-server` flag or a crash can't leak the box's real datacenter IP.

### Plugging in *your* residential proxy

1. Buy a residential proxy (any provider that gives you an
   `http://user:pass@host:port` endpoint — static/"sticky" residential is ideal
   so your exit IP stays stable).
2. Put the upstream line in `/etc/residential-proxy.conf` (tinyproxy `upstream`
   directive). Example shape only:
   ```
   upstream http user:pass@your-exit-host:PORT
   ```
3. `sudo systemctl restart residential-proxy live-browser`
4. Verify the exit IP:
   ```bash
   curl -sx http://127.0.0.1:8899 https://ipinfo.io/json
   ```
   You should see the residential IP, its city, and the ISP — not your box.

---

## Stealth hardening (so it doesn't read as a bot)

A residential IP isn't enough; the browser fingerprint has to match. `live-browser.service`
and the Chromium profile are configured so the browser presents cleanly:

| Signal | What Skyshell does |
|---|---|
| **Timezone** | `TZ=Europe/London` (set this to match your proxy's region so the JS clock, `Intl`, and headers line up) |
| **Language / locale** | `--lang=en-GB` + the profile pins `intl.accept_languages=en-GB,en` |
| **WebRTC leak** | profile forces `disable_non_proxied_udp` — WebRTC can't reveal any IP but the proxied one |
| **`navigator.webdriver`** | not set (this isn't an automation-flagged launch) |
| **`window.chrome`** | present, as on a normal desktop Chrome |
| **WebGL** | a real software-rendered context via SwiftShader/llvmpipe (`--use-angle=swiftshader --enable-unsafe-swiftshader`) — no GPU on the box, but standard checks pass |

The original build verified this against public bot-detection pages
(`bot.sannysoft.com`, `browserleaks.com`): no `webdriver` tell, `window.chrome`
present, a real WebGL context, WebRTC leaking nothing but the residential IP.
Re-verify on your own setup — fingerprinting moves.

> **Match the region.** The single most common mistake: a London exit IP with a
> `America/New_York` clock and `en-US` headers. Set `TZ` and `--lang` to your
> proxy's actual region.

---

## Watching and driving it (as a human)

Two view paths, same live browser:

- **KasmVNC** (`/browser/*` → `:6081`) — the always-on pixel panel embedded in
  the app. Simple, robust, works everywhere.
- **WebRTC "cockpit v2"** (`/live2/*` → `:8934`/`:8935`) — an H.264/Opus stream
  with lower glass-to-glass latency; optional, additive to the VNC path.

Your clicks, typing, scrolling, and the rotate button go through the
**`bctl`** service (`/bctl/*` → `xdotool`), which injects real input events into
the Chromium window on display `:99`. The display runs a square framebuffer with
`land` (1280×800) and `port` (720×1280) RandR modes, so on a phone you can flip
the browser to portrait.

---

## Driving it with your AI

The same Chromium exposes **Chrome DevTools Protocol on `:9222`**, and
`residential-browser.service` runs a **Playwright MCP** server on `:8933`
attached to that CDP endpoint. So any MCP-capable client — Claude Code, a local
model, your own agent — can open, click, read, and fill pages **in the exact
browser you're watching**, from your residential IP.

That's the whole trick: **your model browses the live internet from a home IP,
and you watch it happen in real time.** Full setup, with config snippets:
→ [CONNECT-YOUR-AI.md](CONNECT-YOUR-AI.md).

---

## Lessons baked into this subsystem

- **Don't spawn a process per input event.** The control bridge originally
  launched one `xdotool` process per mouse/key event; it looked fine at low
  rates and queue-backlogged catastrophically under real interaction. It was
  rebuilt around a persistent low-level input daemon. If you fork the control
  path, keep it persistent.
- **Idle viewers must suspend.** Each viewer is a full encode pipeline; an early
  version leaked encoders when a panel was open-but-hidden. Track "is anyone
  actually watching" and suspend when not.
- **Measure latency end-to-end.** The final tuning pass (capture rate, keyframe
  interval, buffer depth, socket options) roughly halved glass-to-glass latency —
  and one plausible optimization was tested and *rejected* once the numbers
  showed no real benefit. Measure; don't guess.
