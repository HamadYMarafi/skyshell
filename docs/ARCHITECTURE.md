# Architecture

How Skyshell fits together — the request flow, every service, every port, and
why each piece exists.

Placeholders used throughout: `skyshell.example.com` (your app hostname),
`YOUR_SERVER_IP` (your box), `your-team.cloudflareaccess.com` (your Access team).

---

## The big picture

```
        Your phone / laptop  (any browser, PWA-installable)
                     │  HTTPS · 443 only · nothing else exposed
                     ▼
        ┌───────────────────────────────┐
        │        Cloudflare edge         │
        │  • Tunnel (cloudflared)        │  ← the box dials OUT; no inbound ports
        │  • Access (one login gate)     │
        └───────────────┬───────────────┘
                        │  encrypted tunnel
                        ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │  Linux server  (YOUR_SERVER_IP)                                     │
   │                                                                     │
   │   nginx :7690  ─────────  the Skyshell app vhost (Access-gated)      │
   │     ├─ /                → /var/www/term-ui/index.html (xterm.js SPA) │
   │     ├─ /assets/*        → xterm.js, font, icons                      │
   │     ├─ /ws · /token     → ttyd :7681 → tmux "main" → shell → your AI │
   │     ├─ /tabs · /stats   → tabs service :7691 (Python stdlib)         │
   │     ├─ /bctl/*          → browser-control :7692 (→ xdotool)          │
   │     ├─ /browser/*       → KasmVNC :6081  (watch the live browser)    │
   │     └─ /live2/*         → cockpit bridge :8934 + WebRTC :8935        │
   │                                                                     │
   │   nginx :7695  ─────────  emergency/agent vhost (identical app,      │
   │                            NEVER Access-gated; SSH-tunnel only)      │
   │                                                                     │
   │   origin-auth :7697  ──── verifies the Access JWT at the origin      │
   │                                                                     │
   │   display :99 (Xvfb) ── window manager ── live Chromium             │
   │        │                                   │ --proxy-server → :8899  │
   │        │                                   └ CDP :9222 ◄──────┐      │
   │   tinyproxy :8899 ───────────────────────► your residential exit IP  │
   │                                                               │      │
   │   Playwright-MCP :8933 ──────────────────────────────────────┘      │
   │        ▲ your AI drives the SAME browser you're watching            │
   └────────────────────────────────────────────────────────────────────┘
```

Everything except nginx binds to `127.0.0.1`. nginx itself is only reachable
through the Cloudflare tunnel (or, for `:7695`, an SSH tunnel). There is no
public listening port on the box.

---

## Services (systemd units)

Each component is one systemd unit in `infra/systemd/`. Ports are all localhost.

| Unit | Port(s) | What it does |
|---|---|---|
| `web-terminal.service` | `7681` | ttyd, wrapping `tmux new-session -A -s main` over a WebSocket. `KillMode=process` so restarting the unit never kills your session. |
| `tmux-main.service` | — | oneshot at boot; recreates the `main` tmux session so long-running work (incl. an in-progress AI session) survives a reboot. |
| `term-tabs.service` | `7691` | Python HTTP service: session/tab list, host+uptime+egress-identity stats, the PIN-gated file browser + upload. |
| `bctl.service` | `7692` | Python HTTP → input-injection bridge: turns `/bctl/*` calls into `xdotool` actions on the live browser (nav, type, key, scroll, orientation). |
| `kasmvnc.service` | `6081` | KasmVNC serving display `:99` over web/WebSocket — the "watch the browser" pixel stream. |
| `live-browser.service` | display `:99`, CDP `9222` | The headed Chromium itself: `--proxy-server=…:8899`, stealth flags, locked to your residential locale/timezone. |
| `residential-proxy.service` | `8899` | tinyproxy forward proxy; upstream = your rented residential exit IP. |
| `residential-browser.service` | `8933` | Playwright MCP attached to Chromium's CDP — the AI-drive endpoint. |
| `cockpit-bridge.service` | `8934` | Node: CDP screencast + control ("cockpit v2"), same live session, lower latency than KasmVNC. |
| `cockpit-webrtc.service` | `8935` | Python: WebRTC media server, streams `:99` as H.264/Opus. |
| `cockpit-audio.service` | — | PulseAudio sink feeding the WebRTC stream. |
| `live-active.service` | — | tracks whether a viewer is actually watching, so idle encoders can suspend. |
| `origin-auth.service` | `7697` | Verifies the `Cf-Access-Jwt-Assertion` signature at the origin (defense in depth). |
| `cloudflared-skyshell.service` | — | The outbound tunnel to Cloudflare. |
| `term-health.{service,timer}` | — | Probes every endpoint + the proxy + the public URL every few minutes; alerts on state change. |
| `term-backup.{service,timer}` | — | Nightly config+state tarball with rotation. |
| `term-alert@.service` | — | Failure hook wired onto the units → push notification on down/recovery. |

> Not every helper script that a unit references ships in this repo (a few live
> in `/usr/local/bin` on the box, e.g. `skyshell-live-active.sh`). The units
> document what they expect; wire them to your own copies.

---

## HTTP endpoints (the app vhost, `:7690`)

| Route | Proxies to | Purpose |
|---|---|---|
| `GET /` | `index.html` | the SPA shell |
| `GET /assets/*` | static | xterm.js, font, icons |
| `GET /manifest.json`, `/sw.js` | static | PWA install + service worker |
| `GET /token` | ttyd `:7681` | ttyd auth token (then the WS) |
| `WS /ws` (subprotocol `tty`) | ttyd `:7681` | the terminal stream |
| `GET /tabs`, `GET /stats` | tabs `:7691` | session list + host/uptime/egress stats |
| `POST /tabs/{select,new,rename,close}` | tabs `:7691` | tmux window control |
| `/tabs/files`, `/tabs/file`, `/tabs/sys/*` | tabs `:7691` | PIN-gated file browser (token, 15-min TTL) |
| `POST /tabs/lib/upload` | tabs `:7691` | large-file upload area |
| `POST /bctl/*` | bctl `:7692` | drive the live browser (goto/back/type/scroll/orient…) |
| `GET /browser/*`, `WS /browser/websockify` | KasmVNC `:6081` | watch + control the live browser (VNC path) |
| `/live2/`, `/live2/webrtc` | cockpit `:8934` / `:8935` | the WebRTC "cockpit v2" live view |

The `:7695` emergency vhost exposes the **same** routes **without** the Access
gate — see below.

---

## Security posture

- **Zero inbound ports.** `cloudflared` establishes an outbound tunnel; the box
  never listens on a public interface.
- **One front door.** Every hostname is fronted by a Cloudflare Access app; only
  the identities you allow reach the origin.
- **Origin-side JWT check (optional, staged).** `origin-auth.service` verifies
  the Access JWT's RS256 signature against
  `https://your-team.cloudflareaccess.com/cdn-cgi/access/certs` **at nginx**, so
  a stray tunnel hostname or an Access misconfig can't silently hand out a shell.
  Rolled out staged (soak-logged, then flipped) — see [ORIGIN-AUTH.md](ORIGIN-AUTH.md).
- **Strict CSP.** The app shell ships a tight `Content-Security-Policy`
  (`default-src 'self'`, no third-party origins, same-origin framing only) —
  see `infra/nginx/term-ui-headers.conf`.
- **Localhost-only services.** Everything but nginx binds `127.0.0.1`.
- **The emergency vhost (`:7695`)** is intentionally un-gated so automation/you
  can still get in if the Access path breaks — but it's reachable **only** over
  an SSH tunnel (`ssh -L 8443:127.0.0.1:7695 …`), which is already
  root-equivalent trust. Never route it through the public tunnel.

---

## The live-browser subsystem (a mini-architecture)

```
   Xvfb :99  →  window manager  →  Chromium  ──►  two consumers, one live session
                                       │
             ┌─────────────────────────┼──────────────────────────┐
             ▼                         ▼                          ▼
      KasmVNC :6081            cockpit :8934/:8935          Playwright-MCP :8933
      (human, VNC)             (human, WebRTC/H.264)        (AI, via CDP :9222)
                                       ▲                          ▲
                                 bctl :7692 (xdotool)   ── control plane for humans
```

- One browser process; **multiple simultaneous consumers** hit the same live
  session — a human watching (VNC or WebRTC) *and* an AI driving (CDP) at once.
- Human clicks/typing flow through `bctl` (`/bctl/*` → `xdotool`); the AI drives
  directly over CDP / Playwright MCP.
- Egress always goes out through tinyproxy → your residential exit IP, so both
  consumers see (and act on) the same residential-IP web session.
- Each active viewer costs a real encode pipeline; an open-but-hidden viewer
  auto-suspends after a short idle window (an early version leaked encoders).

Deep dive: [LIVE-BROWSER.md](LIVE-BROWSER.md).

---

## Deploy / update flow

The maintainer workflow is a **git-gated pipeline with automatic rollback**
(`tools/deploy.sh`): refuse a dirty tree → run the test/lint/theme gate
(`tools/predeploy.sh`) → timestamped on-box backup → ship → **live smoke test**
through an SSH tunnel (`tools/smoke.js`) → tag success **or** restore the backup
and restart services on failure. See [UPDATING.md](UPDATING.md). Standing the
system up from scratch: [DEPLOY.md](DEPLOY.md).
