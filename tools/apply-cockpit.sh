#!/bin/bash
# apply-cockpit.sh — install the v2 live-browser cockpit (CDP screencast + control).
# Run from the repo root on the MAC:  bash tools/apply-cockpit.sh
#
# Additive & reversible: ships the bridge to ~/cockpit, installs cockpit-bridge.service
# on its own port 8934, and adds an nginx `location /live2/` to cockpit.conf with
# backup -> nginx -t -> reload -> self-restore. Touches NONE of the existing units and
# leaves the working /live/ (KasmVNC) panel in place as fallback.
set -e
cd "$(dirname "$0")/.."
KEY=~/.ssh/your-server.key
BOX=ubuntu@YOUR_SERVER_IP
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=15 $BOX"
TS=$(date +%Y%m%d-%H%M%S)

echo "== [1/5] ship cockpit bundle -> ~/cockpit =="
rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes" cockpit/ "$BOX:/home/ubuntu/cockpit/"
scp -q -i "$KEY" -o BatchMode=yes infra/systemd/cockpit-bridge.service "$BOX:/tmp/cockpit-bridge.service"
scp -q -i "$KEY" -o BatchMode=yes infra/nginx/cockpit.conf "$BOX:/tmp/cockpit.conf"
# term-jwt-map.conf carries the $connection_upgrade map cockpit.conf relies on
# since 2026-07-21 — the two must always ship together or nginx -t fails.
scp -q -i "$KEY" -o BatchMode=yes infra/nginx/term-jwt-map.conf "$BOX:/tmp/term-jwt-map.conf"

echo "== [2/5] install + (re)start cockpit-bridge.service =="
$SSH "node --check /home/ubuntu/cockpit/bridge/server.js && echo 'server.js syntax OK'"   # validate BEFORE (re)start
$SSH "sudo -n install -m644 /tmp/cockpit-bridge.service /etc/systemd/system/cockpit-bridge.service"
$SSH "sudo -n systemctl daemon-reload"
$SSH "sudo -n systemctl enable cockpit-bridge"
$SSH "sudo -n systemctl restart cockpit-bridge"   # explicit restart so redeploys pick up new code/env
sleep 2
echo "   bridge active: $($SSH 'systemctl is-active cockpit-bridge')"
echo "   bridge healthz: $($SSH 'curl -s --max-time 4 127.0.0.1:8934/healthz')"

echo "== [2b/5] install + (re)start cockpit-webrtc.service (encoder retune + 1:1 display pin) =="
scp -q -i "$KEY" -o BatchMode=yes infra/systemd/cockpit-webrtc.service "$BOX:/tmp/cockpit-webrtc.service"
$SSH "python3 -c 'import ast; ast.parse(open(\"/home/ubuntu/cockpit/webrtc/webrtc_server.py\").read()); print(\"webrtc_server.py syntax OK\")'"
$SSH "sudo -n install -m644 /tmp/cockpit-webrtc.service /etc/systemd/system/cockpit-webrtc.service"
$SSH "sudo -n systemctl daemon-reload"
$SSH "sudo -n systemctl restart cockpit-webrtc"   # ExecStartPre pins :99 to 1280x800; ExecStartPost re-fits Chrome
sleep 4
echo "   webrtc active: $($SSH 'systemctl is-active cockpit-webrtc')"
echo "   :99 geometry : $($SSH 'DISPLAY=:99 xdotool getdisplaygeometry')"

echo "== [3/5] OnFailure alert drop-ins (matches the other units) =="
for u in cockpit-bridge cockpit-webrtc cockpit-audio; do
  $SSH "sudo -n mkdir -p /etc/systemd/system/$u.service.d && printf '[Unit]\nOnFailure=term-alert@%%n.service\n' | sudo -n tee /etc/systemd/system/$u.service.d/10-alert.conf >/dev/null"
done
$SSH "sudo -n systemctl daemon-reload"

echo "== [4/5] nginx: backup -> install /live2/ -> test -> reload (self-restoring) =="
$SSH "sudo -n cp -a /etc/nginx/conf.d/cockpit.conf /etc/nginx/backups/cockpit.conf.bak-$TS"
$SSH "sudo -n cp -a /etc/nginx/conf.d/term-jwt-map.conf /etc/nginx/backups/term-jwt-map.conf.bak-$TS 2>/dev/null || true"
$SSH "sudo -n install -m644 /tmp/cockpit.conf /etc/nginx/conf.d/cockpit.conf"
$SSH "sudo -n install -m644 /tmp/term-jwt-map.conf /etc/nginx/conf.d/term-jwt-map.conf"
if $SSH "sudo -n nginx -t"; then
  $SSH "sudo -n systemctl reload nginx"
  echo "   nginx reloaded"
else
  echo "   nginx -t FAILED — restoring previous cockpit.conf + term-jwt-map.conf"
  $SSH "sudo -n cp -a /etc/nginx/backups/cockpit.conf.bak-$TS /etc/nginx/conf.d/cockpit.conf"
  $SSH "sudo -n cp -a /etc/nginx/backups/term-jwt-map.conf.bak-$TS /etc/nginx/conf.d/term-jwt-map.conf 2>/dev/null || true"
  exit 1
fi

echo "== [5/5] verify /live2/ through nginx (:8080) =="
echo "   /live2/healthz : $($SSH 'curl -s --max-time 5 127.0.0.1:8080/live2/healthz')"
echo "   /live2/ index  : $($SSH 'curl -s -o /dev/null -w "%{http_code}" --max-time 5 127.0.0.1:8080/live2/')"
echo "   existing /live/: $($SSH 'curl -s -o /dev/null -w "%{http_code}" --max-time 5 127.0.0.1:8080/live/vnc.html') (KasmVNC fallback still up)"
echo "DONE $TS — cockpit v2 live at https://app.example.com/live2/ (behind your CF Access)"
echo "Rollback: sudo systemctl disable --now cockpit-bridge ; sudo cp /etc/nginx/backups/cockpit.conf.bak-$TS /etc/nginx/conf.d/cockpit.conf ; sudo systemctl reload nginx"
