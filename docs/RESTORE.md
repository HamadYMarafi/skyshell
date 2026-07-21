# RESTORE — bare box → running Skyshell

Two paths. Path A is minutes; Path B is the from-scratch runbook.

Both assume you have the two things git does not hold: **your latest backup
tarball** (`/var/backups/term-ui-config/term-backup-*.tar.gz`, written nightly
by `server/term-backup.sh` — pull copies off-box, or configure its encrypted
R2 push) and **your Cloudflare tunnel credentials** (`~/.cloudflared/` — also
captured inside the tarball). No tarball? Then this isn't a restore — do a
fresh install: [DEPLOY.md](DEPLOY.md).

For a box that's *up but misbehaving*, start with
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) instead.

## Path A — cloud volume snapshot (fastest)

If your provider snapshots the boot volume: restore the snapshot onto a new
instance, boot, confirm `systemctl --failed` is empty and
`~/term-ui/term-health.sh --report` runs clean. No DNS change needed — the
tunnel follows its credentials, not the IP. Done. (Snapshot policy is a
cloud-console setting; turn it on before you need it.)

## Path B — from scratch (~1–2 h)

**Ingredients:** a clone of this repo (your fork on GitHub, or the
`term-ui-git.bundle` inside the backup tarball — `git clone term-ui-git.bundle`
recovers the full history even with the box *and* your workstation gone), the
latest `term-backup-*.tar.gz`, fresh Ubuntu 24.04 (arm64 assumed below —
adjust package arches otherwise).

1. **Packages** — the line below is the terminal core; the **full** shopping
   list (WebRTC cockpit, audio, GStreamer, wmctrl/xrandr tools, backups) is
   [DEPLOY.md](DEPLOY.md) step 2 — run that instead if you're restoring the
   whole stack:
   ```bash
   sudo apt update && sudo apt install -y nginx tmux ttyd tinyproxy git curl python3 \
        python3-jwt python3-cryptography xdotool xclip fluxbox
   # KasmVNC: install the arm64 .deb from kasmweb releases (provides /usr/bin/Xvnc + vncserver)
   # cloudflared: official arm64 .deb from Cloudflare
   # Chromium: npx playwright install --with-deps chromium  (as the service user;
   #   path ~/.cache/ms-playwright — --with-deps pulls Chromium's system libraries)
   ```
2. **Repo + webroot**
   ```bash
   git clone <your-fork-or-bundle> ~/skyshell && mkdir -p ~/term-ui
   install -m 755 ~/skyshell/server/*.sh ~/term-ui/
   install -m 644 ~/skyshell/server/*.py ~/term-ui/
   # live-active.service execs this exact path:
   sudo install -m 755 ~/skyshell/server/live-active.sh /usr/local/bin/skyshell-live-active.sh
   sudo mkdir -p /var/www/term-ui
   sudo cp -r ~/skyshell/{index.html,sw.js,manifest.json,assets} /var/www/term-ui/
   sudo chown -R www-data:www-data /var/www/term-ui
   ```
3. **Runtime state from the backup tarball** (this is what git does NOT have).
   Unpack it first:
   ```bash
   mkdir ~/restore && tar xzf term-backup-<ts>.tar.gz -C ~/restore
   ```
   Then put back:
   - `cloudflared/` → `~/.cloudflared/` (tunnel credential json + config.yml)
   - `vnc/` → `~/.vnc/` (kasmvnc.yaml, xstartup) — **plus run `kasmvncpasswd`
     once** to create a throwaway user: Xvnc refuses to start with an empty
     `~/.kasmpasswd` even though auth is disabled in the unit
   - `home-state/` → `~/.term-ui-pin`, `~/.term-alert-env`, `~/files/`
   - `etc-misc/skyshell-cockpit/` → `/var/www/skyshell-cockpit/` (the `/live/`
     panel's `inject.js` + the activity flag `live-active.sh` writes — box-only
     files, in no repo)
   - `etc-misc/residential-proxy.conf` → step 5
   - AI CLI token, if you use one in the terminal: `web-terminal.service` reads
     `/home/ubuntu/.claude/.oauth-env` via `EnvironmentFile=-` — the `-` makes
     it optional, so the terminal starts fine without it; re-mint from your CLI
     when you want it back.
4. **systemd + nginx**
   ```bash
   sudo install -m 644 ~/skyshell/infra/systemd/*.service ~/skyshell/infra/systemd/*.timer /etc/systemd/system/
   # The as-installed drop-ins (OnFailure alerts, hardening, the live-browser
   # audio routing) were captured by the nightly backup — put them back:
   sudo cp -r ~/restore/systemd/*.service.d /etc/systemd/system/
   sudo systemctl daemon-reload
   # apply-on-box.sh reads the repo from ~/term-ui-repo — point that at your clone:
   ln -sfn ~/skyshell ~/term-ui-repo
   bash ~/skyshell/tools/apply-on-box.sh     # drop-ins, nginx, timers, killswitch, verify
   sudo systemctl enable --now web-terminal term-tabs bctl kasmvnc live-browser live-active \
        residential-proxy residential-browser tmux-main cloudflared-skyshell
   ```
   (No drop-in capture in your tarball? `apply-on-box.sh` regenerates the alert
   + hardening drop-ins; the two hand-made ones — cockpit audio routing and
   nginx restart — are spelled out in `infra/systemd/dropins/README.md`.)

   Then the WebRTC live-browser cockpit (separate app on :8934/:8935, its own
   installer — runs **from your workstation**, it ships over SSH; set `KEY`/`BOX`
   at the top first):
   ```bash
   bash tools/apply-cockpit.sh    # ships ~/cockpit, installs cockpit-audio/bridge/webrtc, nginx /live2/
   ```
   Native display geometry (1280x800) comes from `~/.vnc/kasmvnc.yaml` in the
   backup tarball; the Chromium profile (logged-in sessions) restores from the
   weekly `/var/backups/livebrowser-profile/profile-*.tar.gz` (or its R2 copy)
   into `/home/ubuntu/.livebrowser` — untar as the service user before the first
   `live-browser` start.

   **Chromium symlink (required):** `live-browser.service` launches through
   `~/.cache/ms-playwright/chromium-current` — create it after the playwright
   install: `ln -sfn ~/.cache/ms-playwright/chromium-<NNNN> ~/.cache/ms-playwright/chromium-current`.
   Later browser updates go through `~/term-ui/chromium-update.sh` (manual,
   ~monthly: profile backup → new build → repoint symlink → smoke → auto-rollback).
   The clipboard bridge in the cockpit needs `xclip` (in the apt list above).
5. **Residential proxy**: restore `etc-misc/residential-proxy.conf` from the
   tarball to `/etc/residential-proxy.conf` (it contains your residential proxy
   provider's upstream credentials — never in git).
6. **Verify**: `~/term-ui/term-health.sh --report && echo GREEN`, then load
   https://skyshell.example.com through Cloudflare Access, open the Live
   Browser panel, check the exit-IP chip matches your proxy's region
   (`EGRESS_EXPECT` in the `term-health` unit env, default `GB` — see
   [CONFIGURE.md](CONFIGURE.md)).
7. **Re-arm** origin auth if it was enabled:
   `bash ~/term-ui-repo/tools/enable-origin-auth.sh` — see
   [ORIGIN-AUTH.md](ORIGIN-AUTH.md).

## What lives where (recap)
- **git repo** — all code + all config-as-intended (`infra/`).
- **term-backup tarball** — credentials + mutable state (tunnel creds, PIN,
  alert env, library files, as-installed units + their `*.service.d` drop-ins) —
  nightly, 14 rotations, optionally age-encrypted and pushed to R2
  (`server/term-backup.sh`). It also carries `term-ui-git.bundle` (full git
  history — `git clone term-ui-git.bundle` recovers the repo even with both the
  box and your workstation gone) and the `/var/www/skyshell-cockpit/` panel
  files (in no repo).
- **/var/backups/term-ui/** — pre-deploy webroot snapshots, one per deploy
  (written by `tools/deploy.sh`, used by its auto-rollback).
