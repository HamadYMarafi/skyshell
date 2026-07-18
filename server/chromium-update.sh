#!/bin/bash
# chromium-update.sh — CONTROLLED update of the live-browser Chromium and the
# Playwright MCP pin. Run ON the box, by hand, roughly monthly:
#
#   bash ~/term-ui/chromium-update.sh              # -> latest @playwright/mcp
#   bash ~/term-ui/chromium-update.sh 0.0.81       # -> a specific version
#
# Deliberately NOT on any timer: a bad browser build must never auto-ship.
# Mechanism: live-browser.service launches the binary through the
# ~/.cache/ms-playwright/chromium-current symlink, so an update is
#   download new build -> repoint symlink -> restart -> smoke
# and a rollback is just repointing the symlink back. Old builds are kept.
# The MCP pin is applied as a systemd drop-in (30-mcp-pin.conf) so the unit
# file in the repo stays the authoritative baseline.
set -e
PW=/home/ubuntu/.cache/ms-playwright
CUR="$PW/chromium-current"
DROPIN=/etc/systemd/system/residential-browser.service.d/30-mcp-pin.conf

[ -L "$CUR" ] || { echo "ABORT: $CUR symlink missing — create it first (see docs/RESTORE.md)"; exit 1; }
OLD=$(readlink -f "$CUR")
echo "current build: $OLD"

echo "== [0/5] health preflight (won't update a sick stack) =="
/home/ubuntu/term-ui/term-health.sh --report | tail -1 | grep -q "all green" \
  || { echo "ABORT: stack is not all-green — fix that first"; exit 1; }

echo "== [1/5] fresh profile + config backup =="
FORCE_PROFILE=1 /home/ubuntu/term-ui/term-backup.sh

echo "== [2/5] resolve target versions =="
MCPV=${1:-$(npm view @playwright/mcp version)}
PWV=$(npm view "@playwright/mcp@$MCPV" dependencies.playwright 2>/dev/null | tr -d "^~'\"")
[ -n "$PWV" ] || PWV=$(npm view "@playwright/mcp@$MCPV" dependencies.playwright-core 2>/dev/null | tr -d "^~'\"")
[ -n "$PWV" ] || { echo "ABORT: cannot resolve the playwright version behind @playwright/mcp@$MCPV"; exit 1; }
echo "target: @playwright/mcp@$MCPV (playwright $PWV)"

echo "== [3/5] download the matching Chromium build =="
npx -y "playwright@$PWV" install chromium
NEW=$(ls -1dt "$PW"/chromium-[0-9]*/ 2>/dev/null | head -1); NEW=${NEW%/}
[ -x "$NEW/chrome-linux/chrome" ] || { echo "ABORT: no chrome binary under $NEW — nothing changed"; exit 1; }
[ "$NEW" = "$OLD" ] && echo "note: already on the newest build ($NEW) — updating only the MCP pin"

echo "== [4/5] repoint + restart (browser restarts; tabs come back via session restore) =="
ln -sfn "$NEW" "$CUR"
sudo -n mkdir -p "$(dirname "$DROPIN")"
printf '[Service]\nExecStart=\nExecStart=/usr/bin/npx @playwright/mcp@%s --port 8933 --host 127.0.0.1 --cdp-endpoint http://127.0.0.1:9222\n' "$MCPV" \
  | sudo -n tee "$DROPIN" >/dev/null
sudo -n systemctl daemon-reload
sudo -n systemctl restart live-browser
sleep 8
sudo -n systemctl restart residential-browser
sleep 6

echo "== [5/5] smoke =="
FAIL=0
curl -s --max-time 8 http://127.0.0.1:9222/json/version | grep -q '"Browser"' || { echo "  FAIL: CDP 9222 not answering"; FAIL=1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:8933/)" != 000 ] || { echo "  FAIL: playwright-mcp 8933 not answering"; FAIL=1; }
GEO=$(curl -m 10 -sx http://127.0.0.1:8899 https://ipinfo.io/country 2>/dev/null | tr -d '[:space:]')
[ "$GEO" = "GB" ] || { echo "  FAIL: egress country '$GEO' (expected GB)"; FAIL=1; }

if [ "$FAIL" = 1 ]; then
  echo "SMOKE FAILED — rolling back to $OLD"
  ln -sfn "$OLD" "$CUR"
  sudo -n rm -f "$DROPIN"
  sudo -n systemctl daemon-reload
  sudo -n systemctl restart live-browser; sleep 8
  sudo -n systemctl restart residential-browser; sleep 4
  curl -s --max-time 8 http://127.0.0.1:9222/json/version | grep -q '"Browser"' \
    && echo "rollback OK — browser answering on the previous build" \
    || echo "ROLLBACK ALSO UNHEALTHY — investigate: journalctl -u live-browser -n 50"
  exit 1
fi

echo "UPDATE OK"
echo "  Chromium: $(curl -s --max-time 8 http://127.0.0.1:9222/json/version | python3 -c 'import sys,json;print(json.load(sys.stdin).get("Browser","?"))' 2>/dev/null)"
echo "  MCP pin : @playwright/mcp@$MCPV (drop-in $DROPIN)"
echo "  rollback build kept at: $OLD"
echo "REMINDER: note the new pin in the repo docs so a rebuild-from-repo matches."
