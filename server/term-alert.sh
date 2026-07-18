#!/bin/bash
# term-alert.sh "<title>" "<body>" — push an alert + always log to journal.
# Transports (any that are configured in /home/ubuntu/.term-alert-env, 0600):
#   ALERT_NTFY_TOPIC=term-box-xxxx          -> https://ntfy.sh push (no account)
#   ALERT_DISCORD_WEBHOOK=https://discord…  -> optional, if the owner wires one later
TITLE="${1:-term-box alert}"
BODY="${2:-'(no detail)'}"
ENVF=/home/ubuntu/.term-alert-env
[ -f "$ENVF" ] && . "$ENVF"

echo "ALERT: $TITLE — $BODY" | systemd-cat -t term-alert -p warning

if [ -n "$ALERT_NTFY_TOPIC" ]; then
  curl -s --max-time 8 \
    -H "Title: $TITLE" -H "Priority: high" -H "Tags: rotating_light" \
    -d "$BODY" "https://ntfy.sh/$ALERT_NTFY_TOPIC" >/dev/null || true
fi
if [ -n "$ALERT_DISCORD_WEBHOOK" ]; then
  curl -s --max-time 8 -H "Content-Type: application/json" \
    -d "{\"content\":\"🚨 **$TITLE**\\n$BODY\"}" "$ALERT_DISCORD_WEBHOOK" >/dev/null || true
fi
exit 0
