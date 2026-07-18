#!/bin/bash
# disable-origin-auth.sh — instant revert of origin JWT enforcement (box-side).
set -e
printf '# origin auth disabled\n' | sudo tee /etc/nginx/snippets/term-ui-auth.conf >/dev/null
sudo nginx -t
sudo systemctl reload nginx
echo "origin auth DISABLED — :7690 open again (verifier service left running, harmless)"
