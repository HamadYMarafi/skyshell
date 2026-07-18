#!/usr/bin/env python3
"""
xinput.py — persistent XTest input injector for the cockpit bridge.

The bridge used to spawn one xdotool PROCESS per input event; under a mouse-move
or trackpad-scroll flood the spawn queue grew seconds deep, clicks landed late
or interleaved, and scrolling was unusable. This daemon holds ONE X connection
and injects events in microseconds, in strict arrival order.

Protocol: one JSON object per stdin line (run with python3 -u). Every message may
carry "mods": a list of X keysym names (Control_L, Shift_L, Alt_L, Super_L) that
are HELD for the duration of the action and released after — without that,
ctrl-click / shift-click / ctrl-wheel-zoom silently degrade to plain ones.
  {"t":"m","x":640,"y":400}                   absolute pointer move
  {"t":"b","b":1,"d":1,"x":..,"y":..,"mods":[]} button down (d=1) / up (d=0);
                                        optional x/y moves first so the action
                                        lands on the exact pixel, atomically
  {"t":"w","b":4,"n":3,"x":..,"y":..}   wheel: n press/release taps of button b
                                        (4=up 5=down 6=left 7=right); x/y matter
                                        — X delivers wheel events to whatever is
                                        under the POINTER, so the notch must land
                                        under the user's cursor
  {"t":"k","sym":"BackSpace","mods":[]} tap a key by keysym NAME, with modifiers
                                        held around it. Named keys and combos
                                        only: literal text stays on xdotool,
                                        which does the keymap remapping that
                                        arbitrary unicode needs.

Exits non-zero if the display dies (kasmvnc restart) — the bridge respawns us.
"""
import json
import os
import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest

DISP = os.environ.get('DISPLAY', ':99')
WHEEL_GAP = float(os.environ.get('COCKPIT_WHEEL_GAP', '0.012'))   # s between wheel taps

def main():
    d = display.Display(DISP)
    if not d.has_extension('XTEST'):
        print('XTEST extension missing on %s' % DISP, file=sys.stderr)
        return 1

    kc_cache = {}

    def keycode(name):
        """X keysym NAME -> keycode in the current keymap (0 if unmapped)."""
        if name not in kc_cache:
            ks = XK.string_to_keysym(name)
            kc_cache[name] = d.keysym_to_keycode(ks) if ks else 0
        return kc_cache[name]

    def hold(mods):
        codes = [keycode(s) for s in (mods or [])]
        codes = [c for c in codes if c]
        for c in codes:
            xtest.fake_input(d, X.KeyPress, c)
        return codes

    def unhold(codes):
        for c in reversed(codes):
            xtest.fake_input(d, X.KeyRelease, c)

    sys.stderr.write('xinput ready on %s\n' % DISP)
    sys.stderr.flush()
    n = 0
    for line in sys.stdin:
        try:
            m = json.loads(line)
            t = m.get('t')
            if t == 'm':
                xtest.fake_input(d, X.MotionNotify, x=int(m['x']), y=int(m['y']))
            elif t == 'b':
                if 'x' in m:
                    xtest.fake_input(d, X.MotionNotify, x=int(m['x']), y=int(m['y']))
                held = hold(m.get('mods'))
                btn = int(m.get('b', 1))
                xtest.fake_input(d, X.ButtonPress if m.get('d') else X.ButtonRelease, btn)
                unhold(held)
            elif t == 'w':
                if 'x' in m:
                    xtest.fake_input(d, X.MotionNotify, x=int(m['x']), y=int(m['y']))
                held = hold(m.get('mods'))
                btn = int(m.get('b', 5))
                taps = max(1, min(20, int(m.get('n', 1))))
                for i in range(taps):
                    xtest.fake_input(d, X.ButtonPress, btn)
                    xtest.fake_input(d, X.ButtonRelease, btn)
                    # Chromium coalesces wheel events that arrive in the same
                    # compositor frame: fired back-to-back with zero gap, a
                    # 10-notch flick can scroll like 2. xdotool's own
                    # `click --repeat` inserts ~12ms for exactly this reason.
                    if i + 1 < taps and WHEEL_GAP > 0:
                        d.flush()
                        time.sleep(WHEEL_GAP)
                unhold(held)
            elif t == 'k':
                sym = m.get('sym')
                kc = keycode(sym) if sym else 0
                if kc:
                    held = hold(m.get('mods'))
                    xtest.fake_input(d, X.KeyPress, kc)
                    xtest.fake_input(d, X.KeyRelease, kc)
                    unhold(held)
            d.flush()
            # Periodic hard sync so a dead X server surfaces as an exception
            # (flush alone can buffer into a broken socket for a while).
            n += 1
            if n % 200 == 0:
                d.sync()
        except (KeyboardInterrupt, BrokenPipeError):
            return 0
        except Exception as e:
            # A dead display connection is fatal (bridge restarts us); a bad
            # message is not.
            if 'Connection' in type(e).__name__ or 'closed' in str(e).lower():
                print('display connection lost: %r' % e, file=sys.stderr)
                return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
