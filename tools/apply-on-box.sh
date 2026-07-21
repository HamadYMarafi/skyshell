#!/bin/bash
# apply-on-box.sh — one-shot privileged installer, run ON the box:
#
#   ssh -i ~/.ssh/your-server.key ubuntu@YOUR_SERVER_IP \
#     'rm -rf ~/term-ui-repo && git clone -q ~/term-ui.git ~/term-ui-repo && bash ~/term-ui-repo/tools/apply-on-box.sh'
#
# Installs: monitoring (alerts + 5-min health probe + nightly backups),
# OnFailure alert drop-ins, systemd hardening drop-ins, nginx CSP/security
# headers, and the honest-proxy_ok tabs_service. Idempotent; nginx aborts
# and self-restores if its config test fails.
set -e
R=~/term-ui-repo
TS=$(date +%Y%m%d-%H%M%S)

echo "== [1/7] server scripts =="
install -m 755 $R/server/term-alert.sh $R/server/term-health.sh $R/server/term-backup.sh $R/server/chromium-update.sh ~/term-ui/
install -m 644 $R/server/tabs_service.py ~/term-ui/tabs_service.py.new
# live-browser's egress kill-switch helper (referenced by its ExecStartPost).
sudo install -m 755 $R/server/livebrowser-killswitch.sh /usr/local/sbin/livebrowser-killswitch

echo "== [2/7] systemd units + timers =="
sudo install -m 644 $R/infra/systemd/term-alert@.service $R/infra/systemd/term-health.service \
  $R/infra/systemd/term-health.timer $R/infra/systemd/term-backup.service $R/infra/systemd/term-backup.timer /etc/systemd/system/

echo "== [3/7] OnFailure alert drop-ins =="
for u in web-terminal term-tabs bctl kasmvnc live-browser live-active residential-proxy residential-browser cloudflared-skyshell nginx; do
  sudo mkdir -p /etc/systemd/system/$u.service.d
  printf '[Unit]\nOnFailure=term-alert@%%n.service\n' | sudo tee /etc/systemd/system/$u.service.d/10-alert.conf >/dev/null
done

echo "== [4/7] hardening drop-ins (see infra/systemd/dropins/README.md) =="
hard() { sudo mkdir -p "/etc/systemd/system/$1.service.d"; printf '%s\n' "$2" | sudo tee "/etc/systemd/system/$1.service.d/20-hardening.conf" >/dev/null; }
hard term-tabs $'[Service]\nNoNewPrivileges=yes\nProtectSystem=full\nReadWritePaths=/home/ubuntu\nRestrictSUIDSGID=yes'
hard bctl $'[Service]\nNoNewPrivileges=yes\nProtectSystem=full\nProtectHome=read-only\nRestrictSUIDSGID=yes'
hard residential-proxy $'[Service]\nNoNewPrivileges=yes\nProtectSystem=full\nProtectHome=yes\nRestrictSUIDSGID=yes'
hard cloudflared-skyshell $'[Service]\nNoNewPrivileges=yes\nProtectSystem=full\nProtectHome=read-only\nRestrictSUIDSGID=yes'
hard residential-browser $'[Service]\nNoNewPrivileges=yes\nRestrictSUIDSGID=yes'
# web-terminal, kasmvnc, live-browser stay unsandboxed BY DESIGN (sudo shell / X / Chrome sandbox)

echo "== [5/7] nginx: backup -> install -> test (self-restoring) =="
sudo mkdir -p /etc/nginx/backups /etc/nginx/snippets
sudo cp -a /etc/nginx/sites-enabled/term-ui /etc/nginx/backups/term-ui.bak-$TS 2>/dev/null || true
sudo install -m 644 $R/infra/nginx/term-ui-headers.conf /etc/nginx/snippets/
[ -f /etc/nginx/snippets/term-ui-auth.conf ] || sudo touch /etc/nginx/snippets/term-ui-auth.conf
sudo install -m 644 $R/infra/nginx/term-jwt-map.conf /etc/nginx/conf.d/term-jwt-map.conf
sudo install -m 644 $R/infra/nginx/term-ui.conf /etc/nginx/sites-enabled/term-ui
if ! sudo nginx -t; then
  echo "nginx -t FAILED — restoring previous config"
  sudo cp -a /etc/nginx/backups/term-ui.bak-$TS /etc/nginx/sites-enabled/term-ui
  sudo rm -f /etc/nginx/snippets/term-ui-headers.conf
  exit 1
fi

echo "== [6/7] apply: reload nginx, deploy honest proxy_ok, enable timers, restarts =="
sudo systemctl daemon-reload
sudo systemctl reload nginx
cp ~/term-ui/tabs_service.py ~/term-ui/tabs_service.py.bak-$TS
mv ~/term-ui/tabs_service.py.new ~/term-ui/tabs_service.py
sudo systemctl enable --now term-health.timer term-backup.timer
sudo systemctl restart term-tabs bctl residential-proxy residential-browser
sudo systemctl restart cloudflared-skyshell     # ~3s tunnel blip; app auto-reconnects
sleep 3

echo "== [7/7] verify =="
for u in nginx term-tabs bctl residential-proxy residential-browser cloudflared-skyshell web-terminal kasmvnc live-browser; do
  printf '%-24s %s\n' $u "$(systemctl is-active $u)"
done
echo "-- security headers on /:"
curl -sI http://127.0.0.1:7690/ | grep -iE 'content-security|x-content-type|referrer-policy|permissions-policy|cache-control'
echo "-- /stats (proxy_ok now probed, first probe within ~seconds):"
sleep 5; curl -s http://127.0.0.1:7690/stats; echo
echo "-- health probe run:"
~/term-ui/term-health.sh && echo "health script exited clean"
echo "-- first backup:"
~/term-ui/term-backup.sh
echo "-- test alert (watch the ntfy topic on your phone):"
~/term-ui/term-alert.sh "term-box monitoring armed" "alerts + 5-min health probe + nightly 03:30 backups are live ($TS)"
echo "ALL DONE $TS"
