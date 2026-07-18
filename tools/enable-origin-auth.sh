#!/bin/bash
# enable-origin-auth.sh — run ON the box AFTER docs/ORIGIN-AUTH.md's
# preflight confirms real traffic carries the Access JWT
# (grep ' jwt=1 ' /var/log/nginx/term-jwt.log).
# Flips :7690 to require a valid Cloudflare Access JWT (or X-Term-Secret).
# The agent/emergency port :7695 stays auth-free. Revert at any time with
# tools/disable-origin-auth.sh (also on the box, needs only SSH).
set -e
R=~/term-ui-repo
TS=$(date +%Y%m%d-%H%M%S)

echo "== deps =="
sudo apt-get install -y -q python3-jwt python3-cryptography >/dev/null

echo "== secret for local callers (health probe etc.) =="
if [ ! -f ~/.term-origin-secret ]; then
  umask 077; openssl rand -hex 24 > ~/.term-origin-secret
fi

echo "== verifier service =="
install -m 755 $R/server/origin_auth.py ~/term-ui/
sudo tee /etc/systemd/system/origin-auth.service >/dev/null <<'UNIT'
[Unit]
Description=Cloudflare Access JWT verifier for nginx auth_request
After=network.target

[Service]
User=ubuntu
ExecStart=/usr/bin/python3 /home/ubuntu/term-ui/origin_auth.py
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=read-only
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now origin-auth
sleep 1
# sanity: verifier answers and denies garbage
[ "$(curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:7697/verify)" = 401 ] || { echo "verifier not answering 401 — ABORT"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Term-Secret: $(cat ~/.term-origin-secret)" 127.0.0.1:7697/verify)" = 204 ] || { echo "secret path broken — ABORT"; exit 1; }

echo "== flip the nginx snippet =="
sudo cp -a /etc/nginx/snippets/term-ui-auth.conf /etc/nginx/backups/term-ui-auth.conf.bak-$TS 2>/dev/null || true
sudo tee /etc/nginx/snippets/term-ui-auth.conf >/dev/null <<'SNIP'
auth_request /_origin_auth;
SNIP
sudo nginx -t || { echo "nginx -t failed — reverting"; printf '# origin auth disabled\n' | sudo tee /etc/nginx/snippets/term-ui-auth.conf >/dev/null; exit 1; }
sudo systemctl reload nginx
# Graceful reload: old workers can still accept connections for a moment, so an
# immediate probe sees pre-flip behavior and false-triggers the self-revert
# (bit us 2026-07-13 — first flip attempt reverted itself on a 200).
sleep 3

echo "== verify enforcement =="
NO=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7690/tabs)
YES=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Term-Secret: $(cat ~/.term-origin-secret)" http://127.0.0.1:7690/tabs)
AGENT=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7695/tabs)
# The cockpit vhost (:8080, skyshell host) carries the same snippet on /live2/*
# — verify it flipped too, or the Skyshell panel path would be left unprotected.
L2NO=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/live2/healthz)
L2YES=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Term-Secret: $(cat ~/.term-origin-secret)" http://127.0.0.1:8080/live2/healthz)
echo "7690 bare: $NO (want 401) · 7690 secret: $YES (want 200) · 7695 agent: $AGENT (want 200)"
echo "8080 /live2/ bare: $L2NO (want 401) · with secret: $L2YES (want 200)"
[ "$NO" = 401 ] && [ "$YES" = 200 ] && [ "$AGENT" = 200 ] && [ "$L2NO" = 401 ] && [ "$L2YES" = 200 ] && echo "ORIGIN AUTH LIVE (term + cockpit vhosts)" || { echo "UNEXPECTED — reverting"; printf '# origin auth disabled\n' | sudo tee /etc/nginx/snippets/term-ui-auth.conf >/dev/null; sudo systemctl reload nginx; exit 1; }
echo "NOW: verify the REAL browser path (open https://skyshell.example.com on the phone, then the Live Browser panel). If broken: bash ~/term-ui-repo/tools/disable-origin-auth.sh"
