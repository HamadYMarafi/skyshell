#!/bin/bash
# Defines the custom RandR modes the rotate feature switches between: "land"
# (1280x800) and "port" (720x1280). bctl_service.py's /bctl/orient flips between
# them. Run at display startup (kasmvnc.service ExecStartPost) so the modes exist.
# The box has no `cvt`, so the modelines are hardcoded — don't remove them.
export DISPLAY=:99; sleep 1
# Detect the real output name. KasmVNC's Xvnc calls it VNC-0; the retired Xvfb
# called it "screen". Hardcoding "screen" is why rotate silently broke on the
# 2026-07-06 Kasm migration — detect it instead.
O=$(xrandr 2>/dev/null | awk '/ connected| unknown connection/{print $1; exit}'); O=${O:-screen}
xrandr --newmode "land" 83.50 1280 1352 1480 1680 800 803 809 831 -hsync +vsync 2>/dev/null
xrandr --addmode "$O" "land" 2>/dev/null
xrandr --newmode "port" 92.50 720 776 848 976 1280 1283 1293 1330 -hsync +vsync 2>/dev/null
xrandr --addmode "$O" "port" 2>/dev/null
# Do NOT force a mode here — the display stays at its native 1280x800 (kasmvnc.yaml);
# /bctl/orient switches to land/port on demand.
