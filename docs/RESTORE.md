# RESTORE — bare box → running Terminal Cloud

Two paths. Path A is minutes; Path B is the from-scratch runbook.

## Path A — Oracle volume snapshot (fastest)
Restore the boot-volume backup in the OCI console onto a new A1.Flex instance,
boot, confirm `systemctl --failed` is empty and `term-health.sh` runs clean,
update the DNS-side nothing (tunnel follows credentials, not IP). Done.
(Snapshot policy is a console-side setting — see 07 review doc open items.)

## Path B — from scratch (~1–2 h)

**Ingredients:** this repo (Mac copy or a clone of the box bare repo
`~/term-ui.git`), the latest `/var/backups/term-ui-config/term-backup-*.tar.gz`
(pulled to the Mac, or off the old disk), fresh Ubuntu 24.04 aarch64.

1. **Packages**
   ```bash
   sudo apt update && sudo apt install -y nginx tmux ttyd tinyproxy git curl python3 \
        python3-jwt python3-cryptography xdotool xclip fluxbox
   # KasmVNC: install the arm64 .deb from kasmweb releases (provides /usr/bin/Xvnc + vncserver)
   # cloudflared: official arm64 .deb from Cloudflare
   # Chromium: npx playwright install chromium  (as ubuntu; path ~/.cache/ms-playwright)
   ```
2. **Repo + webroot**
   ```bash
   git clone <repo> ~/term-ui-repo && mkdir -p ~/term-ui
   install -m 755 ~/term-ui-repo/server/*.sh ~/term-ui/
   install -m 644 ~/term-ui-repo/server/*.py ~/term-ui/
   sudo mkdir -p /var/www/term-ui
   sudo cp -r ~/term-ui-repo/{index.html,sw.js,manifest.json,assets} /var/www/term-ui/
   sudo chown -R www-data:www-data /var/www/term-ui
   ```
3. **Runtime state from the backup tarball** (this is what git does NOT have):
   `~/.cloudflared/` (tunnel credential json + config.yml), `~/.vnc/`
   (kasmvnc.yaml, xstartup — plus run `kasmvncpasswd` once for the throwaway
   "dummy" user), `~/.term-ui-pin`, `~/.term-alert-env`, `~/files/`,
   `/home/ubuntu/.claude/.oauth-env` (Claude token for the terminal env —
   re-mint with `claude setup-token` if missing).
4. **systemd + nginx**
   ```bash
   sudo install -m 644 ~/term-ui-repo/infra/systemd/*.service ~/term-ui-repo/infra/systemd/*.timer /etc/systemd/system/
   # the four legacy stack units (web-terminal, kasmvnc, live-browser, tmux-main,
   # residential-proxy, residential-browser, cloudflared-skyshell) are captured
   # in infra/systemd/ too — install the lot, then:
   bash ~/term-ui-repo/tools/apply-on-box.sh     # drop-ins, nginx, timers, killswitch, verify
   sudo systemctl enable --now web-terminal term-tabs bctl kasmvnc live-browser live-active \
        residential-proxy residential-browser tmux-main cloudflared-skyshell
   ```
   Then the WebRTC live-browser cockpit (separate app on :8934/:8935, its own installer):
   ```bash
   bash ~/term-ui-repo/tools/apply-cockpit.sh    # ships ~/cockpit, installs cockpit-audio/bridge/webrtc, nginx /live2/
   ```
   Native display geometry (1280x800) comes from `~/.vnc/kasmvnc.yaml` in the backup
   tarball; the Chromium profile (logged-in sessions) restores from the weekly
   `/var/backups/livebrowser-profile/profile-*.tar.gz` (or its R2 copy) into
   `/home/ubuntu/.livebrowser` — untar as ubuntu before first `live-browser` start.

   **Chromium symlink (required since 2026-07-13):** `live-browser.service`
   launches through `~/.cache/ms-playwright/chromium-current` — create it after
   the playwright install: `ln -sfn ~/.cache/ms-playwright/chromium-<NNNN> ~/.cache/ms-playwright/chromium-current`.
   Later browser updates go through `~/term-ui/chromium-update.sh` (manual,
   ~monthly: profile backup → new build → repoint symlink → smoke → auto-rollback).
   The clipboard bridge in the cockpit needs `xclip` (in the apt list above).
5. **Residential proxy**: `/etc/residential-proxy.conf` comes from the backup
   tarball (contains the your residential proxy provider upstream credentials).
6. **Verify**: `~/term-ui/term-health.sh && echo GREEN`, then load
   https://skyshell.example.com through Cloudflare Access, open the Live
   Browser panel, check the exit IP chip says London.
7. **Re-arm** origin auth if it was enabled: `bash ~/term-ui-repo/tools/enable-origin-auth.sh`.

## What lives where (recap)
- **git repo** — all code + all config-as-intended (`infra/`).
- **term-backup tarball** — credentials + mutable state (tunnel creds, PIN,
  alert env, library files, as-installed units) — nightly, 14 rotations,
  pushed to R2. Since 2026-07-13 it also carries `term-ui-git.bundle` (full
  git history — `git clone term-ui-git.bundle` recovers the repo even with
  both the box and the Mac gone) and the `/var/www/skyshell-cockpit/` panel
  files (inject.js — in no repo).
- **/var/backups/term-ui/** — pre-deploy webroot snapshots + the retired
  `.bak` archaeology from the pre-git era.
