#!/bin/bash
# Deploy to the box with gate, backup, live smoke, and automatic rollback.
#   bash tools/deploy.sh
# Requires a CLEAN committed tree (deploys are commits, not working files).
set -e
cd "$(dirname "$0")/.."
KEY=~/.ssh/your-server.key
BOX=ubuntu@YOUR_SERVER_IP
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=15 $BOX"
TS=$(date +%Y%m%d-%H%M%S)
TUN_PORT=18443

[ -z "$(git status --porcelain)" ] || { echo "ABORT: uncommitted changes — commit first"; exit 1; }
bash tools/predeploy.sh

CHANGED_TABS=0; CHANGED_BCTL=0
if git rev-parse -q --verify deployed >/dev/null 2>&1; then
  git diff --quiet deployed -- server/tabs_service.py || CHANGED_TABS=1
  git diff --quiet deployed -- server/bctl_service.py || CHANGED_BCTL=1
else CHANGED_TABS=1; CHANGED_BCTL=1; fi

echo "== ship files =="
scp -q -i "$KEY" -o BatchMode=yes index.html sw.js manifest.json $BOX:/tmp/
rsync -az --checksum -e "ssh -i $KEY -o BatchMode=yes" assets/ $BOX:/tmp/term-assets/
$SSH "set -e
  sudo -n mkdir -p /var/backups/term-ui/deploy-$TS
  sudo -n cp -a /var/www/term-ui/index.html /var/www/term-ui/sw.js /var/www/term-ui/manifest.json /var/backups/term-ui/deploy-$TS/
  sudo -n install -o www-data -g www-data -m 644 /tmp/index.html /tmp/sw.js /tmp/manifest.json /var/www/term-ui/
  sudo -n rsync -a --chown=www-data:www-data /tmp/term-assets/ /var/www/term-ui/assets/
  if [ $CHANGED_TABS = 1 ]; then cp ~/term-ui/tabs_service.py ~/term-ui/tabs_service.py.bak-$TS; fi
  if [ $CHANGED_BCTL = 1 ]; then cp ~/term-ui/bctl_service.py ~/term-ui/bctl_service.py.bak-$TS; fi"
if [ $CHANGED_TABS = 1 ]; then
  scp -q -i "$KEY" -o BatchMode=yes server/tabs_service.py $BOX:term-ui/tabs_service.py
  $SSH "sudo -n systemctl restart term-tabs"
fi
if [ $CHANGED_BCTL = 1 ]; then
  scp -q -i "$KEY" -o BatchMode=yes server/bctl_service.py $BOX:term-ui/bctl_service.py
  $SSH "sudo -n systemctl restart bctl"
fi

echo "== live smoke =="
ssh -i "$KEY" -o BatchMode=yes -o ExitOnForwardFailure=yes -f -N -L $TUN_PORT:127.0.0.1:7695 $BOX   # 7695 = agent vhost (stays open under origin auth)
trap "pkill -f '$TUN_PORT:127.0.0.1:7695' 2>/dev/null || true" EXIT
sleep 1
if BASE=http://127.0.0.1:$TUN_PORT node tools/smoke.js; then
  git tag -f deployed >/dev/null && git push -q -f box deployed 2>/dev/null || true
  echo "DEPLOY OK  ($TS · $(git rev-parse --short HEAD))"
else
  echo "SMOKE FAILED — ROLLING BACK"
  $SSH "set -e
    sudo -n install -o www-data -g www-data -m 644 /var/backups/term-ui/deploy-$TS/* /var/www/term-ui/
    if [ $CHANGED_TABS = 1 ]; then cp ~/term-ui/tabs_service.py.bak-$TS ~/term-ui/tabs_service.py; sudo -n systemctl restart term-tabs; fi
    if [ $CHANGED_BCTL = 1 ]; then cp ~/term-ui/bctl_service.py.bak-$TS ~/term-ui/bctl_service.py; sudo -n systemctl restart bctl; fi"
  echo "ROLLED BACK to pre-$TS state"
  exit 1
fi
