#!/bin/bash
# term-health.sh — 5-minutely stack probe (systemd timer term-health.timer).
# Alerts on STATE CHANGES (broke / recovered), re-alerts every 6h while broken.
# Run with --report for a one-shot human-readable health view (no alerting).
STATE=/run/term-health/state       # sorted list of currently-failing checks
STAMP=/run/term-health/lastalert   # (dir created by RuntimeDirectory=, survives runs via Preserve)
mkdir -p /run/term-health 2>/dev/null || true
REPORT=0; [ "$1" = "--report" ] && REPORT=1
FAILS=""
# NB: both MUST return 0 — ok() is used on the LHS of `&& ok ... || add ...`, so a
# non-zero return here would make every passing check fall through to add().
add() { FAILS="$FAILS$1"$'\n'; [ "$REPORT" = 1 ] && printf '  FAIL %s\n' "$1"; return 0; }
ok()  { [ "$REPORT" = 1 ] && printf '  ok   %s\n' "$1"; return 0; }

# Local checks send X-Term-Secret so they keep passing once origin JWT
# enforcement is on (empty header pre-enforcement — harmless).
SEC=$(cat /home/ubuntu/.term-origin-secret 2>/dev/null || true)
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "X-Term-Secret: $SEC" "$@"; }

{ [ "$(code http://127.0.0.1:7690/)" = 200 ]              && ok "shell /"; }              || add "shell /  not 200"
{ [ "$(code http://127.0.0.1:7690/tabs)" = 200 ]          && ok "/tabs"; }               || add "/tabs not 200"
{ [ "$(code http://127.0.0.1:7690/token)" = 200 ]         && ok "/token"; }              || add "/token not 200"
{ [ "$(code http://127.0.0.1:7690/browser/)" = 200 ]      && ok "/browser/ (KasmVNC)"; } || add "/browser/ (KasmVNC) not 200"
{ [ "$(code -X POST http://127.0.0.1:7690/bctl/ping)" = 200 ] && ok "bctl ping"; }        || add "bctl not 200"

# --- Browser DATA path (was previously unchecked — 38 silent webrtc SEGVs on 07-11
# never surfaced here). CDP 9222 also doubles as a Chromium hang detector: a wedged
# renderer host stops answering /json/version while the process still lives.
{ [ "$(code http://127.0.0.1:9222/json/version)" = 200 ] && ok "chrome CDP 9222"; }      || add "chrome CDP 9222 not 200 (hung/dead browser?)"
{ [ "$(code http://127.0.0.1:8933/)" != 000 ]            && ok "playwright-mcp 8933"; }  || add "playwright-mcp 8933 not responding"
{ [ "$(code http://127.0.0.1:8934/healthz)" = 200 ]      && ok "cockpit-bridge 8934"; }  || add "cockpit-bridge 8934 healthz not 200"
{ [ "$(code http://127.0.0.1:8935/)" != 000 ]            && ok "cockpit-webrtc 8935"; }  || add "cockpit-webrtc 8935 signaling not responding"

STATS=$(curl -s --max-time 8 -H "X-Term-Secret: $SEC" http://127.0.0.1:7690/stats || echo '{}')
{ echo "$STATS" | grep -q '"proxy_ok": true' && ok "residential proxy reachable"; } || add "residential proxy DOWN (stats proxy_ok)"

# Assert the egress is still the UK residential exit, not a silent fallback to bare
# Oracle (proxy_ok only proves reachability, not identity). Only fire on a DEFINITIVE
# non-GB answer — a failed geo lookup stays silent (reachability is covered above).
GEO=$(curl -m 8 -sx http://127.0.0.1:8899 https://ipinfo.io/country 2>/dev/null | tr -d '[:space:]')
if [ -n "$GEO" ]; then { [ "$GEO" = "GB" ] && ok "egress country GB"; } || add "egress country drifted to $GEO (expected GB — your residential proxy provider fallback/leak?)"; fi

# Resource guards
DISK=$(df / | awk 'NR==2{print $5}' | tr -d '%')
{ [ "$DISK" -lt 88 ] && ok "root disk ${DISK}%"; } || add "root disk ${DISK}% full (>=88%)"
XPID=$(pgrep -f 'Xvnc :99' | head -1)
if [ -n "$XPID" ]; then XRSS=$(ps -o rss= -p "$XPID" | tr -d ' ')
  { [ "${XRSS:-0}" -lt 4718592 ] && ok "Xvnc RSS $((XRSS/1024))MB"; } || add "Xvnc RSS $((XRSS/1024))MB approaching the 5G cap"; fi

# Shared-display geometry — REPORT-only, never an alert: portrait is legitimate
# while a phone drives via /live/, and the cockpit bridge auto-restores 1280x800
# once no KasmVNC client is attached. This line just makes a stuck state visible.
GEOM=$(DISPLAY=:99 XAUTHORITY=/home/ubuntu/.Xauthority timeout 5 xdotool getdisplaygeometry 2>/dev/null | tr ' ' 'x')
if [ -n "$GEOM" ]; then
  if [ "$GEOM" = "1280x800" ]; then ok "display :99 ${GEOM}"; else ok "display :99 ${GEOM} (non-default — phone session or pending auto-fit)"; fi
fi

# Restart-storm detector: Restart=always units can crash-loop without ever being
# marked "failed", so OnFailure alerts never fire for them. Compare NRestarts
# against the previous run (5 min ago); a jump of >=3 means something is looping.
RSTATE=/run/term-health/nrestarts
RNEW=""
STORM=""
for u in live-browser kasmvnc web-terminal term-tabs bctl residential-proxy residential-browser cloudflared-skyshell cockpit-audio cockpit-bridge cockpit-webrtc; do
  n=$(systemctl show -p NRestarts --value "$u" 2>/dev/null)
  case "$n" in ''|*[!0-9]*) continue;; esac
  RNEW="$RNEW$u $n"$'\n'
  prev=$(awk -v u="$u" '$1==u{print $2}' "$RSTATE" 2>/dev/null)
  case "$prev" in ''|*[!0-9]*) continue;; esac
  [ "$n" -ge $((prev + 3)) ] && STORM="$STORM $u"
done
printf '%s' "$RNEW" > "$RSTATE"
if [ -n "$STORM" ]; then
  for u in $STORM; do add "restart storm: $u is restart-looping"; done
else
  ok "no restart storms"
fi

# Public path — traverses DNS + Cloudflare edge + tunnel + Access (302 = healthy gate)
PUB=$(code https://skyshell.example.com/)
case "$PUB" in 200|302) ok "public URL ($PUB)";; *) add "public URL returned $PUB (tunnel/CF?)";; esac

if [ "$REPORT" = 1 ]; then
  CUR=$(printf '%s' "$FAILS" | sort -u)
  if [ -n "$CUR" ]; then echo "== term-box health: DEGRADED =="; else echo "== term-box health: all green =="; fi
  exit 0
fi

CUR=$(printf '%s' "$FAILS" | sort -u)
PREV=$(cat "$STATE" 2>/dev/null || true)

if [ -n "$CUR" ]; then
  NOW=$(date +%s); LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ "$CUR" != "$PREV" ] || [ $((NOW - LAST)) -gt 21600 ]; then
    /home/ubuntu/term-ui/term-alert.sh "term-box health" "$CUR"
    echo "$NOW" > "$STAMP"
  fi
else
  [ -n "$PREV" ] && /home/ubuntu/term-ui/term-alert.sh "term-box recovered" "all checks green again"
  rm -f "$STAMP"
fi
printf '%s' "$CUR" > "$STATE"
exit 0
