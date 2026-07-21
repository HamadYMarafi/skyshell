# Deploy Skyshell on a server

This is the native use case: Skyshell is **built to live on an always-on Linux
box** and be reachable from anywhere. This guide is the **map and the order** —
it points at the real files you'll edit rather than pretending to be a
one-command installer, because standing this up means making a handful of
decisions (your domain, your proxy, your login policy) that only you can make.

> New to servers? Every step below is doable, but you should be comfortable
> SSH-ing into a Linux box and editing a config file. Just want to see it run?
> Start with [LOCAL.md](LOCAL.md) instead.

---

## 0 — What you need

- **A Linux server**, always on. A small **ARM VM** from any cloud is plenty
  (the original runs on a 4-core ARM box). Ubuntu is assumed below.
- **A domain on Cloudflare** (free plan is fine) — for the tunnel + login gate.
- **A residential proxy** (optional, only for the live browser) — any provider
  that gives you an `http://user:pass@host:port` endpoint. See
  [LIVE-BROWSER.md](LIVE-BROWSER.md).
- **Your workstation** with `ssh` and this repo cloned.

---

## 1 — Harden the box (once)

```bash
# key-only SSH, a firewall that allows only SSH, fail2ban
sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw enable
sudo apt update && sudo apt install -y fail2ban
# disable password SSH in /etc/ssh/sshd_config: PasswordAuthentication no
sudo systemctl reload ssh
```
Because Skyshell exposes **no inbound ports** (the tunnel dials out), your
firewall stays SSH-only — with one optional exception: the WebRTC cockpit's
media path flows direct over UDP `40000-40009`. If you'll use `/live2/*`, allow
it in **both** layers (`sudo ufw allow 40000:40009/udp` *and* your cloud
security list); skip it if the KasmVNC panel is enough. See
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## 2 — Install the components

```bash
sudo apt update
# core: nginx, tmux, git+curl (clone, health probes), the origin-auth JWT deps
sudo apt install -y nginx tmux git curl python3 python3-jwt python3-cryptography
# node: the cockpit bridge and the Playwright MCP run under node/npx
sudo apt install -y nodejs npm
# proxy: local tinyproxy forwarding to your residential upstream, plus
# iptables for the browser's egress kill-switch (livebrowser-killswitch)
sudo apt install -y tinyproxy iptables
# X desktop on :99: window manager + xrandr/input/window/clipboard tools
sudo apt install -y fluxbox x11-xserver-utils x11-utils xdotool wmctrl xclip
# cockpit bridge helpers (xinput.py, clipwatch.py) + WebRTC signaling
sudo apt install -y python3-xlib python3-websockets
# audio: the virtual sink the live browser plays into (cockpit-audio.service)
sudo apt install -y pulseaudio
# WebRTC media: PyGObject + GStreamer (ximagesrc → x264enc → webrtcbin, Opus, ICE)
sudo apt install -y python3-gi gir1.2-gst-plugins-base-1.0 gir1.2-gst-plugins-bad-1.0 \
  gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
  gstreamer1.0-nice gstreamer1.0-pulseaudio
# backups: rclone pushes age-encrypted snapshots offsite (term-backup.sh)
sudo apt install -y rclone age
# ttyd: `sudo apt install -y ttyd` (Ubuntu 24.04+), or the static binary for
#   your arch from https://github.com/tsl0922/ttyd/releases — it must end up at
#   /usr/bin/ttyd (web-terminal.service's ExecStart path)
# cloudflared: the .deb (installs /usr/bin/cloudflared, the unit's path) from
#   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
# KasmVNC: the .deb for your arch from https://github.com/kasmtech/KasmVNC/releases
#   (provides /usr/bin/vncserver + kasmvncpasswd)
# Chromium via Playwright (a known-good build; --with-deps pulls the system
# libraries Chromium needs on a fresh box):
npx playwright install --with-deps chromium
# live-browser.service launches through this symlink; ~/term-ui/chromium-update.sh
# repoints it on updates and rolls back by repointing it back:
ln -sfn ~/.cache/ms-playwright/chromium-* ~/.cache/ms-playwright/chromium-current
```
(Exact package names vary by distro/arch — treat this as the shopping list.)

## 3 — Put the code in place

```bash
git clone https://github.com/<you>/skyshell.git ~/skyshell
cd ~/skyshell
cp .env.example .env            # then edit — see docs/CONFIGURE.md

# front-end
sudo mkdir -p /var/www/term-ui
sudo cp index.html sw.js manifest.json /var/www/term-ui/
sudo cp -r assets /var/www/term-ui/

# server services (the units run these from ~/term-ui by absolute path)
mkdir -p ~/term-ui ~/cockpit
cp server/*.py ~/term-ui/
install -m 755 server/*.sh ~/term-ui/   # tmux-main, term-health, term-backup, term-alert, display-modes, chromium-update
# two scripts live outside ~/term-ui — the units call them at these exact paths:
sudo install -m 755 server/livebrowser-killswitch.sh /usr/local/sbin/livebrowser-killswitch
sudo install -m 755 server/live-active.sh /usr/local/bin/skyshell-live-active.sh
# live-active writes its activity flag here (and the cockpit vhost serves it) —
# must exist and be writable by the service user:
sudo mkdir -p /var/www/skyshell-cockpit && sudo chown "$USER" /var/www/skyshell-cockpit

# cockpit (WebRTC browser view)
cp -r cockpit/* ~/cockpit/
(cd ~/cockpit/bridge && npm ci)         # the bridge needs the `ws` package — MODULE_NOT_FOUND without this
```

## 4 — Configure (the only real work)

Edit these to match your box. The full "which file, which line" map is in
**[CONFIGURE.md](CONFIGURE.md)** — the short version:

- **`infra/cloudflared/config.example.yml`** → copy to `~/.cloudflared/config.yml`,
  set your hostnames + tunnel id.
- **`infra/systemd/*.service`** → set `User=`, `HOME=`, hostnames in
  `COCKPIT_ALLOWED_ORIGINS`, and any paths that differ on your box.
- **`infra/nginx/`** → install the shared plumbing first, then the vhosts.
  `term-jwt-map.conf` carries both the WebSocket `$connection_upgrade` map and
  the `jwtprobe` log_format that `term-ui.conf` references — without it (and the
  empty auth snippet) `nginx -t` fails:
  ```bash
  sudo cp infra/nginx/term-jwt-map.conf /etc/nginx/conf.d/
  sudo mkdir -p /etc/nginx/snippets
  sudo touch /etc/nginx/snippets/term-ui-auth.conf       # empty = origin auth off until step 9
  sudo cp infra/nginx/term-ui-headers.conf /etc/nginx/snippets/
  sudo cp infra/nginx/term-ui.conf /etc/nginx/sites-available/term-ui
  sudo ln -sfn /etc/nginx/sites-available/term-ui /etc/nginx/sites-enabled/term-ui
  sudo cp infra/nginx/cockpit.conf /etc/nginx/conf.d/    # cockpit vhost (:8080)
  ```
  Adjust `root` in `term-ui.conf` if your front-end lives elsewhere.
- **`infra/kasmvnc/`** → KasmVNC's config + a required user, before
  `kasmvnc.service` first starts:
  ```bash
  mkdir -p ~/.vnc
  cp infra/kasmvnc/kasmvnc.yaml infra/kasmvnc/xstartup ~/.vnc/
  chmod +x ~/.vnc/xstartup
  kasmvncpasswd    # any throwaway user/password — KasmVNC refuses to start with
                   # zero users; the unit runs auth-disabled, localhost-only
  ```
- **`/etc/residential-proxy.conf`** → your tinyproxy upstream (see LIVE-BROWSER.md).
- **`~/.term-alert-env`** (0600, on the box) → `ALERT_NTFY_TOPIC=your-topic` so
  health alerts reach your phone (optional `ALERT_DISCORD_WEBHOOK=` too — see
  [.env.example](../.env.example)). Without it alerts only go to the journal.

## 5 — Cloudflare Tunnel

```bash
cloudflared tunnel login                         # opens a browser to authorize
cloudflared tunnel create skyshell-cloud         # prints your tunnel id + creds file
cloudflared tunnel route dns skyshell-cloud skyshell.example.com
# put the tunnel id + hostnames into ~/.cloudflared/config.yml (from step 4)
```
The name `skyshell-cloud` is what `cloudflared-skyshell.service` runs
(`… run skyshell-cloud`) — if you pick another name, change the unit's
`ExecStart` to match or the service fails with "tunnel not found".

## 6 — Cloudflare Access (the login gate)

In the Cloudflare **Zero Trust** dashboard:

1. **Access → Applications → Add** a *self-hosted* app for `skyshell.example.com`.
2. Add a **policy**: Allow → *Emails* → your email (or a group / your IdP).
3. Repeat for any other hostname you exposed (code-server, cockpit).

Now every hostname requires your login before it ever reaches the box.

## 7 — Bring it up

Install and enable the units, then start everything:

```bash
sudo cp infra/systemd/*.service infra/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now \
  cloudflared-skyshell residential-proxy live-browser residential-browser \
  kasmvnc web-terminal tmux-main term-tabs bctl live-active \
  cockpit-audio cockpit-bridge cockpit-webrtc \
  term-health.timer term-backup.timer
sudo nginx -t && sudo systemctl reload nginx
```
For cockpit **audio**, add the `live-browser` PULSE_SERVER drop-in by hand —
the WebRTC stream is silent without it: see
[infra/systemd/dropins/README.md](../infra/systemd/dropins/README.md).

> `tools/apply-on-box.sh`, `apply-infra.sh`, and `apply-cockpit.sh` are the
> author's install/hardening helpers — read them; they encode the exact unit
> list + systemd hardening drop-ins, but they assume the author's paths, so
> adapt before running.

## 8 — Verify

```bash
bash server/term-health.sh --report   # probes every endpoint + the proxy + public URL
curl -sx http://127.0.0.1:8899 https://ipinfo.io/json   # confirm the residential exit
```
Then open **https://skyshell.example.com** in a browser, pass the Access login,
and you should land in the terminal with the live-browser panel available. On a
phone, use the browser's **Add to Home Screen** to install the PWA.

---

## 9 — Optional hardening: origin-side JWT

Once it's working, turn on the second auth layer (nginx verifies the Access JWT
at the origin) — staged, with a soak period and auto-revert:
→ [ORIGIN-AUTH.md](ORIGIN-AUTH.md).

> `tools/enable-origin-auth.sh` expects the box clone at `~/term-ui-repo` (the
> `R=` variable at its top) — point `R=` at `~/skyshell` instead of renaming
> your clone.

## Updating later

Day-to-day changes ship through the git-gated pipeline with auto-rollback:
→ [UPDATING.md](UPDATING.md). The workstation-side gate needs `npm install`
once at the repo root (the smoke test uses `playwright-core`) and a system
**Google Chrome** install — `tools/smoke.js` launches `channel: 'chrome'`.

## If it breaks

Disaster recovery / rebuild-from-nothing: → [RESTORE.md](RESTORE.md).
