#!/bin/bash
# term-backup.sh — nightly config+state snapshot (term-backup.timer, 03:30 UTC).
# Captures everything RESTORE.md needs that git does NOT hold:
# runtime creds/state (tunnel credential, PIN hash, library files) + the
# as-installed configs, PLUS the `claude` multi-model launcher code (council/duo/
# subcouncil/hands + shell rc files + cliproxyapi config — code only, no secrets;
# see the EXCLUDED SECRETS block below). Keeps 14 rotations in
# /var/backups/term-ui-config, and pushes each to Cloudflare R2
# (r2:backups/term-box/) so a lost box != lost backups.
#
# R2 ONLY EVER HOLDS ENCRYPTED BLOBS. Every tarball is encrypted with `age`
# (asymmetric, recipient public key only — see docs/AGE-SETUP.md) before it leaves
# the box. The local /var/backups copies stay plaintext for fast on-box
# restore; only the .age ciphertext is pushed to R2. If `age` isn't installed
# or AGE_RECIPIENT below hasn't been set to a real public key yet, the R2 push
# is skipped entirely (never falls back to pushing plaintext) — the local
# backup still gets written either way.
#
# Also takes a WEEKLY snapshot of the live-browser Chromium profile (the logged-in
# cookies/sessions), cache-excluded, local + R2 (same encrypt-before-push flow).
set -e
DEST=/var/backups/term-ui-config
PROFDEST=/var/backups/livebrowser-profile
TS=$(date +%Y%m%d-%H%M%S)
R2=r2:backups/term-box
RCLONE="rclone --s3-no-check-bucket --transfers=2 --retries=3"

# --- age recipient (PUBLIC key only — the private key never lives on this box).
# Generate the keypair on your Mac with `age-keygen`, then paste the "public key:"
# line here. Full steps: docs/AGE-SETUP.md.
AGE_RECIPIENT="age1REPLACE_WITH_YOUR_PUBLIC_KEY"

AGE_TMP=$(mktemp -d)
trap 'rm -rf "$AGE_TMP"' EXIT

sudo -n mkdir -p "$DEST" "$PROFDEST"

T=$(mktemp -d)
mkdir -p "$T/etc-nginx" "$T/systemd" "$T/term-ui" "$T/vnc" "$T/cloudflared" "$T/home-state" \
         "$T/cockpit" "$T/etc-misc" "$T/openrouter/bin" "$T/cliproxyapi"
cp /etc/nginx/sites-available/term-ui "$T/etc-nginx/" 2>/dev/null || cp /etc/nginx/sites-enabled/term-ui "$T/etc-nginx/"
cp /etc/nginx/snippets/term-ui-headers.conf "$T/etc-nginx/" 2>/dev/null || true
cp /etc/nginx/conf.d/cockpit.conf "$T/etc-nginx/" 2>/dev/null || true
# term-jwt-map.conf is the ONLY definition of the $connection_upgrade map +
# jwtprobe log_format since 2026-07-21 — without it a restored nginx can't start.
cp /etc/nginx/conf.d/term-jwt-map.conf "$T/etc-nginx/" 2>/dev/null || true
# Units: terminal stack + the cockpit/live-browser stack (previously omitted, so a
# rebuild-from-backup was missing the whole WebRTC cockpit and the display units).
for u in web-terminal term-tabs bctl kasmvnc live-browser live-active residential-proxy \
         residential-browser tmux-main cloudflared-skyshell cockpit-audio cockpit-bridge \
         cockpit-webrtc term-alert@ term-health term-backup status term-keepalive; do
  systemctl cat "$u" > "$T/systemd/$u.unit" 2>/dev/null || true
done
# Timers are separate units — systemctl cat <name> above only captures the .service.
for tmr in term-health term-backup term-keepalive term-restore-verify; do
  systemctl cat "$tmr.timer" > "$T/systemd/$tmr.timer.unit" 2>/dev/null || true
done
cp -r /etc/systemd/system/*.service.d "$T/systemd/" 2>/dev/null || true
cp /home/ubuntu/term-ui/*.py /home/ubuntu/term-ui/*.sh "$T/term-ui/" 2>/dev/null || true
# Status dashboard app (:8790) — code lives only in ~/term-status, capture it whole.
cp -r /home/ubuntu/term-status "$T/term-status" 2>/dev/null || true
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

# --- claude launcher code (openrouter multi-model launcher: council/duo/subcouncil
# + `hands` + models.tsv + shell rc files + cliproxyapi config). This is CODE AND
# CONFIG ONLY so a box rebuild restores the `claude` command without the owner
# re-authoring it from memory.
#
# INTENTIONALLY EXCLUDED (secrets — re-copied from the Mac by hand on rebuild;
# NEVER backed up here, NEVER pushed anywhere):
#   ~/.openrouter/env              — OpenRouter/provider API keys
#   ~/.codex/auth.json             — Codex OAuth token
#   ~/.cli-proxy-api/*.json        — cliproxyapi provider auth tokens
# Any other token/key/credential file under these dirs is excluded the same way —
# only the specific filenames below are ever copied.
cp /home/ubuntu/.openrouter/claude-launcher.zsh /home/ubuntu/.openrouter/council.py \
   /home/ubuntu/.openrouter/duo.py /home/ubuntu/.openrouter/subcouncil.py \
   /home/ubuntu/.openrouter/models.tsv "$T/openrouter/" 2>/dev/null || true
cp /home/ubuntu/.openrouter/bin/hands "$T/openrouter/bin/" 2>/dev/null || true
cp /home/ubuntu/.zshrc /home/ubuntu/.zshenv "$T/home-state/" 2>/dev/null || true
cp /home/ubuntu/cliproxyapi/config.yaml "$T/cliproxyapi/" 2>/dev/null || true

# user library (skip if it has ballooned past 500MB)
if [ "$(du -sm /home/ubuntu/files 2>/dev/null | cut -f1 || echo 0)" -lt 500 ]; then
  cp -r /home/ubuntu/files "$T/home-state/" 2>/dev/null || true
fi

sudo -n tar czf "$DEST/term-backup-$TS.tar.gz" -C "$T" .
sudo -n chown ubuntu:ubuntu "$DEST/term-backup-$TS.tar.gz"
sudo -n rm -rf "$T"   # sudo: $T holds root-owned copies (residential-proxy.conf, policies/)
sudo -n bash -c "cd $DEST && ls -1t term-backup-*.tar.gz | tail -n +15 | xargs -r rm --"
echo "config backup written: $DEST/term-backup-$TS.tar.gz"

# --- age gate: decide ONCE whether R2 pushes are allowed this run. If `age` is
# missing or AGE_RECIPIENT is still the placeholder, every push below is skipped
# (local backups are unaffected) rather than ever sending plaintext to R2.
AGE_OK=1
if ! command -v age >/dev/null 2>&1; then
  echo "WARN: age not installed — skipping R2 push (install: sudo apt-get install -y age; see docs/AGE-SETUP.md)"
  AGE_OK=0
elif [ -z "$AGE_RECIPIENT" ] || [ "$AGE_RECIPIENT" = "age1REPLACE_WITH_YOUR_PUBLIC_KEY" ]; then
  echo "WARN: AGE_RECIPIENT not configured — skipping R2 push (see docs/AGE-SETUP.md)"
  AGE_OK=0
fi

# encrypt_and_push <local-plaintext-tar> <r2-subdir: config|profile> <remote-name-prefix> <keep-count>
# Encrypts the plaintext tar to a throwaway .age file, pushes ONLY that .age to R2,
# rotates the remote to <keep-count>, then deletes the local .age (the local
# plaintext tar itself is untouched — that's what fast on-box restore uses).
encrypt_and_push() {
  local plainfile="$1" subdir="$2" prefix="$3" keep="$4"
  [ "$AGE_OK" = 1 ] || return 0
  local base agefile
  base=$(basename "$plainfile")
  agefile="$AGE_TMP/$base.age"
  if age -r "$AGE_RECIPIENT" -o "$agefile" "$plainfile" 2>/dev/null; then
    if $RCLONE copy "$agefile" "$R2/$subdir/" 2>/dev/null; then
      echo "$base.age pushed to $R2/$subdir/ (encrypted; plaintext stays local-only)"
      $RCLONE lsf "$R2/$subdir/" 2>/dev/null | grep "^${prefix}" | sort | head -n -"$keep" \
        | while read -r f; do $RCLONE deletefile "$R2/$subdir/$f" 2>/dev/null || true; done
    else
      echo "WARN: R2 push failed for $base.age (backup is still safe locally)"
    fi
  else
    echo "WARN: age encryption failed for $base — skipping R2 push (backup is still safe locally)"
  fi
  rm -f "$agefile"
}

# --- offsite: encrypt + push config tarball to R2, keep 14 remote ---
encrypt_and_push "$DEST/term-backup-$TS.tar.gz" "config" "term-backup-" 14

# --- WEEKLY: live-browser profile snapshot (logged-in cookies/sessions) ---
# Age-gated so this heavy tar runs ~weekly off the same nightly timer. Excludes the
# ~560MB of disposable caches — only the small valuable state (Cookies, Login Data,
# Preferences, Local/Session Storage) is kept. tar-while-running is crash-consistent
# (same as a power cut); fine for disaster recovery.
NEWEST_PROF=$(find "$PROFDEST" -maxdepth 1 -name 'profile-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | head -1 | cut -d' ' -f2-)
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
  encrypt_and_push "$PT" "profile" "profile-" 4
fi
