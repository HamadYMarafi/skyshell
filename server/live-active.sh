#!/bin/bash
export DISPLAY=:99
xsetroot -solid '#000000' 2>/dev/null
while true; do
  WID=$(xdotool search --onlyvisible --class chromium 2>/dev/null | head -1)
  if [ -n "$WID" ]; then
    echo 1 > /var/www/skyshell-cockpit/active 2>/dev/null
    wmctrl -i -r "$WID" -b add,maximized_vert,maximized_horz 2>/dev/null
  else
    echo 0 > /var/www/skyshell-cockpit/active 2>/dev/null
  fi
  sleep 2
done
