#!/bin/bash
# Idempotent infra installer: monitoring, backups, hardening drop-ins, nginx.
# Run from the repo root on the MAC:  bash tools/apply-infra.sh
# Ships repo infra/ + server scripts to the box and applies them with
# backup -> test -> reload -> verify at each step.
set -e
cd "$(dirname "$0")/.."
KEY=~/.ssh/your-server.key
BOX=ubuntu@YOUR_SERVER_IP
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=15 $BOX"
TS=$(date +%Y%m%d-%H%M%S)

echo "== ship scripts + units =="
scp -q -i "$KEY" -o BatchMode=yes server/term-alert.sh server/term-health.sh server/term-backup.sh $BOX:term-ui/
scp -q -i "$KEY" -o BatchMode=yes infra/systemd/term-alert@.service infra/systemd/term-health.service \
    infra/systemd/term-health.timer infra/systemd/term-backup.service infra/systemd/term-backup.timer $BOX:/tmp/
scp -q -i "$KEY" -o BatchMode=yes infra/nginx/term-ui.conf infra/nginx/term-ui-headers.conf infra/nginx/term-jwt-map.conf $BOX:/tmp/

$SSH "set -e
chmod +x ~/term-ui/term-alert.sh ~/term-ui/term-health.sh ~/term-ui/term-backup.sh

echo '== units + timers =='
sudo -n install -m 644 /tmp/term-alert@.service /tmp/term-health.service /tmp/term-health.timer /tmp/term-backup.service /tmp/term-backup.timer /etc/systemd/system/

echo '== OnFailure drop-ins =='
for u in web-terminal term-tabs bctl kasmvnc live-browser residential-proxy residential-browser cloudflared-skyshell nginx; do
  sudo -n mkdir -p /etc/systemd/system/\$u.service.d
  printf '[Unit]\nOnFailure=term-alert@%%n.service\n' | sudo -n tee /etc/systemd/system/\$u.service.d/10-alert.conf >/dev/null
done

echo '== hardening drop-ins =='
h() { sudo -n mkdir -p /etc/systemd/system/\$1.service.d; printf '%s\n' \"\$2\" | sudo -n tee /etc/systemd/system/\$1.service.d/20-hardening.conf >/dev/null; }
h term-tabs '[Service]
NoNewPrivileges=yes
ProtectSystem=full
ReadWritePaths=/home/ubuntu
RestrictSUIDSGID=yes'
h bctl '[Service]
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=read-only
RestrictSUIDSGID=yes'
h residential-proxy '[Service]
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
RestrictSUIDSGID=yes'
h cloudflared-skyshell '[Service]
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=read-only
RestrictSUIDSGID=yes'
h residential-browser '[Service]
NoNewPrivileges=yes
RestrictSUIDSGID=yes'

echo '== nginx (backup -> install -> test -> reload) =='
sudo -n mkdir -p /etc/nginx/backups /etc/nginx/snippets
sudo -n cp -a /etc/nginx/sites-enabled/term-ui /etc/nginx/backups/term-ui.bak-$TS 2>/dev/null || true
sudo -n install -m 644 /tmp/term-ui-headers.conf /etc/nginx/snippets/
# the auth include must exist (empty until origin-auth is enabled) or nginx -t fails
[ -f /etc/nginx/snippets/term-ui-auth.conf ] || sudo -n touch /etc/nginx/snippets/term-ui-auth.conf
# jwtprobe log_format + $connection_upgrade map — term-ui.conf needs both
sudo -n install -m 644 /tmp/term-jwt-map.conf /etc/nginx/conf.d/term-jwt-map.conf
sudo -n install -m 644 /tmp/term-ui.conf /etc/nginx/sites-enabled/term-ui
sudo -n nginx -t
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now term-health.timer term-backup.timer >/dev/null 2>&1
sudo -n systemctl reload nginx

echo '== restart hardened services (order: quick blips) =='
sudo -n systemctl restart term-tabs bctl residential-proxy residential-browser
sudo -n systemctl restart cloudflared-skyshell
sleep 3
for u in term-tabs bctl residential-proxy residential-browser cloudflared-skyshell nginx; do
  printf '%-24s %s\n' \$u \$(systemctl is-active \$u)
done"
echo "APPLY-INFRA DONE ($TS)"
