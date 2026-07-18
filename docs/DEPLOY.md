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
firewall can stay SSH-only forever.

## 2 — Install the components

```bash
sudo apt update && sudo apt install -y \
  nginx tmux python3 python3-jwt python3-cryptography \
  xvfb tinyproxy xdotool x11-utils \
  nodejs npm
# ttyd: install the static binary for your arch from https://github.com/tsl0922/ttyd/releases
# cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
# KasmVNC: https://github.com/kasmtech/KasmVNC/releases
# Chromium via Playwright (gives a known-good build):
npx playwright install chromium
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

# server services + cockpit
mkdir -p ~/term-ui ~/cockpit
cp server/*.py ~/term-ui/
cp -r cockpit/* ~/cockpit/
```

## 4 — Configure (the only real work)

Edit these to match your box. The full "which file, which line" map is in
**[CONFIGURE.md](CONFIGURE.md)** — the short version:

- **`infra/cloudflared/config.example.yml`** → copy to `~/.cloudflared/config.yml`,
  set your hostnames + tunnel id.
- **`infra/systemd/*.service`** → set `User=`, `HOME=`, hostnames in
  `COCKPIT_ALLOWED_ORIGINS`, and any paths that differ on your box.
- **`infra/nginx/term-ui.conf`, `cockpit.conf`, `term-ui-headers.conf`** → copy
  into `/etc/nginx/` (site + `snippets/`), adjust `root` if needed.
- **`/etc/residential-proxy.conf`** → your tinyproxy upstream (see LIVE-BROWSER.md).

## 5 — Cloudflare Tunnel

```bash
cloudflared tunnel login                         # opens a browser to authorize
cloudflared tunnel create skyshell               # prints your tunnel id + creds file
cloudflared tunnel route dns skyshell skyshell.example.com
# put the tunnel id + hostnames into ~/.cloudflared/config.yml (from step 4)
```

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
  kasmvnc web-terminal tmux-main term-tabs bctl \
  cockpit-audio cockpit-bridge cockpit-webrtc \
  term-health.timer term-backup.timer
sudo nginx -t && sudo systemctl reload nginx
```
> `tools/apply-on-box.sh`, `apply-infra.sh`, and `apply-cockpit.sh` are the
> author's install/hardening helpers — read them; they encode the exact unit
> list + systemd hardening drop-ins, but they assume the author's paths, so
> adapt before running.

## 8 — Verify

```bash
bash server/term-health.sh        # probes every endpoint + the proxy + public URL
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

## Updating later

Day-to-day changes ship through the git-gated pipeline with auto-rollback:
→ [UPDATING.md](UPDATING.md).

## If it breaks

Disaster recovery / rebuild-from-nothing: → [RESTORE.md](RESTORE.md).
