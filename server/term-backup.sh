#!/bin/bash
# term-backup.sh — nightly config+state snapshot (term-backup.timer, 03:30 UTC).
# Captures everything RESTORE.md needs that git does NOT hold:
# runtime creds/state (tunnel credential, PIN hash, library files) + the
# as-installed configs. Keeps 14 rotations in /var/backups/term-ui-config, and
# pushes each to Cloudflare R2 (r2:backups/term-box/) so a lost box != lost backups.
# Also takes a WEEKLY snapshot of the live-browser Chromium profile (the logged-in
# cookies/sessions), cache-excluded, local + R2.
set -e
DEST=/var/backups/term-ui-config
PROFDEST=/var/backups/livebrowser-profile
TS=$(date +%Y%m%d-%H%M%S)
R2=r2:backups/term-box
RCLONE="rclone --s3-no-check-bucket --transfers=2 --retries=3"
sudo -n mkdir -p "$DEST" "$PROFDEST"

T=$(mktemp -d)
mkdir -p "$T/etc-nginx" "$T/systemd" "$T/term-ui" "$T/vnc" "$T/cloudflared" "$T/home-state" "$T/cockpit" "$T/etc-misc"
cp /etc/nginx/sites-available/term-ui "$T/etc-nginx/" 2>/dev/null || cp /etc/nginx/sites-enabled/term-ui "$T/etc-nginx/"
cp /etc/nginx/snippets/term-ui-headers.conf "$T/etc-nginx/" 2>/dev/null || true
cp /etc/nginx/conf.d/cockpit.conf "$T/etc-nginx/" 2>/dev/null || true
# Units: terminal stack + the cockpit/live-browser stack (previously omitted, so a
# rebuild-from-backup was missing the whole WebRTC cockpit and the display units).
for u in web-terminal term-tabs bctl kasmvnc live-browser live-active residential-proxy \
         residential-browser tmux-main cloudflared-skyshell cockpit-audio cockpit-bridge \
         cockpit-webrtc term-alert@ term-health term-backup; do
  systemctl cat "$u" > "$T/systemd/$u.unit" 2>/dev/null || true
done
cp -r /etc/systemd/system/*.service.d "$T/systemd/" 2>/dev/null || true
cp /home/ubuntu/term-ui/*.py /home/ubuntu/term-ui/*.sh "$T/term-ui/" 2>/dev/null || true
# Cockpit application code (bridge/server.js, webrtc/webrtc_server.py, web/index.html)
cp -r /home/ubuntu/cockpit/bridge /home/ubuntu/cockpit/webrtc /home/ubuntu/cockpit/web "$T/cockpit/" 2>/dev/null || true
cp /home/ubuntu/.vnc/kasmvnc.yaml /home/ubuntu/.vnc/xstartup "$T/vnc/" 2>/dev/null || true
cp /home/ubuntu/.cloudflared/config.yml /home/ubuntu/.cloudflared/*.json "$T/cloudflared/" 2>/dev/null || true
cp /home/ubuntu/.term-ui-pin /home/ubuntu/.term-alert-env "$T/home-state/" 2>/dev/null || true
# Residential-egress config (your residential proxy provider upstream) + the Chromium managed policy
# (URL blocklist + WebRTC leak policy). Both root-owned 600 now, so sudo to read.
sudo -n cp /etc/residential-proxy.conf "$T/etc-misc/" 2>/dev/null || true
sudo -n cp -r /etc/chromium/policies "$T/etc-misc/" 2>/dev/null || true
# Full git history of the term-ui repo: the box bare repo is what deploys and
# restores clone from, and commits newer than the Mac's last fetch existed ONLY
# here. A bundle is a single-file clone source (git clone term-ui-git.bundle).
git --git-dir=/home/ubuntu/term-ui.git bundle create "$T/term-ui-git.bundle" --all 2>/dev/null || true
# Skyshell cockpit panel (inject.js + shell page) — box-only files, in no repo.
cp -r /var/www/skyshell-cockpit "$T/etc-misc/" 2>/dev/null || true
# user library (skip if it has ballooned past 500MB)
if [ "$(du -sm /home/ubuntu/files 2>/dev/null | cut -f1 || echo 0)" -lt 500 ]; then
  cp -r /home/ubuntu/files "$T/home-state/" 2>/dev/null || true
fi

sudo -n tar czf "$DEST/term-backup-$TS.tar.gz" -C "$T" .
sudo -n chown ubuntu:ubuntu "$DEST/term-backup-$TS.tar.gz"
sudo -n rm -rf "$T"   # sudo: $T holds root-owned copies (residential-proxy.conf, policies/)
sudo -n bash -c "cd $DEST && ls -1t term-backup-*.tar.gz | tail -n +15 | xargs -r rm --"
echo "config backup written: $DEST/term-backup-$TS.tar.gz"

# --- offsite: push config tarball to R2, keep 14 remote ---
if $RCLONE copy "$DEST/term-backup-$TS.tar.gz" "$R2/config/" 2>/dev/null; then
  echo "config backup pushed to $R2/config/"
  $RCLONE lsf "$R2/config/" 2>/dev/null | grep '^term-backup-' | sort | head -n -14 \
    | while read -r f; do $RCLONE deletefile "$R2/config/$f" 2>/dev/null || true; done
else
  echo "WARN: R2 push failed (config backup is still safe locally)"
fi

# --- WEEKLY: live-browser profile snapshot (logged-in cookies/sessions) ---
# Age-gated so this heavy tar runs ~weekly off the same nightly timer. Excludes the
# ~560MB of disposable caches — only the small valuable state (Cookies, Login Data,
# Preferences, Local/Session Storage) is kept. tar-while-running is crash-consistent
# (same as a power cut); fine for disaster recovery.
NEWEST_PROF=$(ls -1t "$PROFDEST"/profile-*.tar.gz 2>/dev/null | head -1)
RUN_PROF=1
if [ -n "$NEWEST_PROF" ] && [ "$(find "$NEWEST_PROF" -mtime -6 2>/dev/null)" ]; then RUN_PROF=0; fi
# FORCE_PROFILE=1 overrides the weekly age gate — used by chromium-update.sh to
# guarantee a fresh profile snapshot right before touching the browser.
[ "${FORCE_PROFILE:-0}" = 1 ] && RUN_PROF=1
if [ "$RUN_PROF" = 1 ]; then
  PT="$PROFDEST/profile-$TS.tar.gz"
  # NB: GNU tar only applies --exclude patterns that appear BEFORE the path operand
  # (.livebrowser). Placing them after silently keeps everything. All excluded dirs
  # are disposable — Chromium re-creates caches and re-downloads component models;
  # only the session state (Cookies, Login Data, Preferences, Storage, Network) is kept.
  sudo -n tar czf "$PT" -C /home/ubuntu \
    --exclude='.livebrowser/Default/Cache' \
    --exclude='.livebrowser/Default/Code Cache' \
    --exclude='.livebrowser/Default/Service Worker' \
    --exclude='.livebrowser/Default/GPUCache' \
    --exclude='.livebrowser/Default/DawnGraphiteCache' \
    --exclude='.livebrowser/Default/DawnWebGPUCache' \
    --exclude='.livebrowser/GPUPersistentCache' \
    --exclude='.livebrowser/GraphiteDawnCache' \
    --exclude='.livebrowser/ShaderCache' \
    --exclude='.livebrowser/GrShaderCache' \
    --exclude='.livebrowser/component_crx_cache' \
    --exclude='.livebrowser/TranslateKit' \
    --exclude='.livebrowser/WasmTtsEngine' \
    --exclude='.livebrowser/OnDeviceHeadSuggestModel' \
    --exclude='.livebrowser/OptimizationGuidePredictionModels' \
    .livebrowser 2>/dev/null || true
  sudo -n chown ubuntu:ubuntu "$PT" 2>/dev/null || true
  sudo -n bash -c "cd $PROFDEST && ls -1t profile-*.tar.gz | tail -n +5 | xargs -r rm --"
  echo "profile snapshot written: $PT ($(du -h "$PT" 2>/dev/null | cut -f1))"
  if $RCLONE copy "$PT" "$R2/profile/" 2>/dev/null; then
    echo "profile snapshot pushed to $R2/profile/"
    $RCLONE lsf "$R2/profile/" 2>/dev/null | grep '^profile-' | sort | head -n -4 \
      | while read -r f; do $RCLONE deletefile "$R2/profile/$f" 2>/dev/null || true; done
  else
    echo "WARN: R2 profile push failed (snapshot is still safe locally)"
  fi
fi
