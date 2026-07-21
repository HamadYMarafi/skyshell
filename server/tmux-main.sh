#!/bin/bash
export TMUX_TMPDIR=/tmp
# tmux auto-creates /tmp/tmux-<uid> only via TMUX_TMPDIR — the explicit -S path
# below does NOT, so at early boot (fresh empty /tmp) the socket dir must exist
# first or this unit fails (bit us on the 2026-07-13 reboot drill).
# Socket path derives from the running uid so it always matches ttyd's default
# /tmp/tmux-<uid> socket (hardcoding 1001 broke tabs on uid-1000 boxes).
SOCKDIR="/tmp/tmux-$(id -u)"
mkdir -p "$SOCKDIR" && chmod 700 "$SOCKDIR"
S="tmux -S $SOCKDIR/default"
$S has-session -t main 2>/dev/null && exit 0
$S new-session -d -s main -n chat-1
$S new-window -t main -n chat-2
$S select-window -t main:1
