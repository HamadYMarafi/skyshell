#!/usr/bin/env python3
"""
clipwatch.py — tell the bridge whenever the REMOTE browser's clipboard changes.

Uses the X XFIXES extension to get an event the instant the CLIPBOARD selection
changes owner (i.e. something in the remote browser copied). That is strictly
better than polling `xclip -o` on a timer: no spawns, no latency, and it catches
a copy made from the context menu just as well as one made with Ctrl+C.

Prints one line ("changed") per event; the bridge then reads the actual text.
Deliberately does NOT watch PRIMARY (X's select-to-copy selection) — that fires
on every mouse text-selection and has no equivalent on macOS, so mirroring it
into the user's real clipboard would be constant, unwanted noise.

Runs as a child of cockpit-bridge, which respawns it if it dies. A missing
XFIXES just means clipboard sync degrades to the manual buttons — never fatal.
"""
import os
import sys

from Xlib import display
from Xlib.ext import xfixes


def main():
    d = display.Display(os.environ.get('DISPLAY', ':99'))
    if not d.has_extension('XFIXES'):
        print('XFIXES extension missing — no clipboard events', file=sys.stderr)
        return 1
    d.xfixes_query_version()
    root = d.screen().root
    d.xfixes_select_selection_input(
        root, d.intern_atom('CLIPBOARD'), xfixes.XFixesSetSelectionOwnerNotifyMask)
    sys.stderr.write('clipwatch ready\n')
    sys.stderr.flush()
    while True:
        d.next_event()                      # blocks until the clipboard changes owner
        sys.stdout.write('changed\n')
        sys.stdout.flush()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (KeyboardInterrupt, BrokenPipeError):
        sys.exit(0)
    except Exception as e:                  # display died (kasmvnc restart) — bridge respawns us
        print('clipwatch exiting: %r' % (e,), file=sys.stderr)
        sys.exit(1)
