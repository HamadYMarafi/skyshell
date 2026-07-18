#!/bin/bash
# livebrowser-killswitch {add|del} — kernel egress kill-switch for the live browser.
# The browser must only ever talk to its residential proxy (127.0.0.1:8899), CDP,
# and the DNS stub — all loopback. Any OTHER egress = a leak of the bare Oracle
# datacenter IP (defeats the residential identity), so DROP+LOG it. This fails the
# residential path CLOSED at the kernel, independent of Chrome's --proxy-server flag.
# Matches the systemd cgroup (no dedicated uid / no X-display surgery). Installed to
# /usr/local/sbin and driven by live-browser.service ExecStartPost/StopPost (run as
# root via the systemd '+' prefix). Idempotent. v4 + v6.
set -u
CG="system.slice/live-browser.service"
CHAIN="LIVEBROWSER-EGRESS"
for IPT in iptables ip6tables; do
  $IPT -D OUTPUT -m cgroup --path "$CG" -j "$CHAIN" 2>/dev/null || true
  $IPT -F "$CHAIN" 2>/dev/null || true
  $IPT -X "$CHAIN" 2>/dev/null || true
  [ "${1:-add}" = del ] && continue
  $IPT -N "$CHAIN"
  $IPT -A "$CHAIN" -o lo -j ACCEPT
  $IPT -A "$CHAIN" -m limit --limit 6/min --limit-burst 10 -j LOG --log-prefix "LB-EGRESS-LEAK " --log-level 4
  $IPT -A "$CHAIN" -j DROP
  $IPT -I OUTPUT -m cgroup --path "$CG" -j "$CHAIN"
done
