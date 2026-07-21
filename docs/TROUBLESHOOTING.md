# TROUBLESHOOTING — symptom → cause → fix

The gotchas a self-hoster actually hits, distilled from running this stack.
Deploy-pipeline mechanics: [UPDATING.md](UPDATING.md). Dead box:
[RESTORE.md](RESTORE.md).

## App shell

### You deployed, but the browser still shows the old UI
**Cause:** the service worker. Navigations are network-first (`sw.js`), so a
stale shell normally can't happen while online — when it does, it's because
`index.html` changed without a bump of the `CACHE` constant in `sw.js`.
`tools/predeploy.sh` gates deploys on exactly this; hand-copied files skip the
gate.
**Fix:** bump `CACHE` in `sw.js` and deploy properly. On the device: close and
reopen the PWA (or hard-reload the tab). You never need `Clear-Site-Data` or
cache nuking — the cached shell is only the offline fallback.

## nginx

### 502 / duplicate-listen errors right after you "backed up" a config
**Cause:** a `.bak` copy left in `sites-enabled/`. nginx loads **every** file
in that directory — the backup loads as a second, conflicting server block.
**Fix:** backups belong in `/etc/nginx/backups/` (where the repo's tools put
them). Remove the stray file, then `sudo nginx -t && sudo systemctl reload nginx`.

### `unknown "connection_upgrade" variable` on `nginx -t`
**Cause:** `infra/nginx/term-jwt-map.conf` isn't installed. It carries the
WebSocket `$connection_upgrade` map **and** the `jwtprobe` log format that
`term-ui.conf` references — it's the always-installed plumbing file.
**Fix:** install it into `/etc/nginx/conf.d/` alongside the vhosts.

## KasmVNC / display

### `kasmvnc.service` refuses to start on a fresh box
**Cause:** `vncserver` will not run with an empty `~/.kasmpasswd` — even
though the unit disables auth (`-disableBasicAuth -SecurityTypes None`).
**Fix:** run `kasmvncpasswd` once as the service user and create a throwaway
user. The credentials are never used; their existence is mandatory.

### Browser panel shows a blurry, squeezed, or phone-shaped desktop
**Cause:** the shared display `:99` geometry doesn't match your panel —
another device sized it, or the Chromium window lost its maximized tracking.
**Fix:** the app's fit watchdog repairs this automatically, but only while the
panel is open, in **Take over**, and the tab is **focused** — focus it and
give it a few seconds (it compares framebuffer vs panel every tick and nudges
both Kasm and the window). Manual check: `DISPLAY=:99 xdotool getdisplaygeometry`
(expect `1280x800`); `sudo systemctl restart cockpit-webrtc` re-pins `:99` to
1280x800 and re-fits Chrome (its `ExecStartPre`/`ExecStartPost`).

## Terminal / tabs

### Tabs bar lists and creates windows, but the terminal ignores them
**Cause:** two tmux servers — the tabs service and ttyd are on different
sockets. Both derive `/tmp/tmux-<uid>/default` from the running uid
(`tabs_service.py`, `tmux-main.sh`); they diverge when the units run as
different users (or something overrides the path).
**Fix:** run `web-terminal`, `term-tabs`, and `tmux-main` as the **same**
user. If you must relocate the socket, set `TERM_TABS_TMUX_SOCK` in
`term-tabs.service` to ttyd's actual socket path.

## Origin auth

### `enable-origin-auth.sh` "self-reverts" although the flip was fine
**Cause:** nginx's graceful reload keeps old workers answering for a moment;
a probe fired immediately after the reload sees pre-flip behavior and trips
the self-revert.
**Fix:** the shipped script sleeps 3 s after the reload before verifying —
keep that sleep if you fork it, and just re-run the script. Details:
[ORIGIN-AUTH.md](ORIGIN-AUTH.md).

## SSH one-liners

### `ssh box "pkill -f <pattern>"` kills the session, or "fails" with exit 1
**Cause:** two traps. (a) `pkill -f` matches full command lines, and the
remote shell running your one-liner *contains the pattern* — pkill matches its
own parent shell. (b) `pkill` exits 1 when nothing matched, which aborts
`set -e` scripts and makes ssh report failure.
**Fix:** (a) bracket one character: `pkill -f 'chro[m]ium'` still matches
`chromium` but never the literal bracketed string in your own command line.
(b) append `|| true` when no-match is fine (`tools/deploy.sh` does this for
its tunnel cleanup).

## WebRTC cockpit

### Video plays, but no audio
**Cause:** Chromium isn't playing into the cockpit's PulseAudio null-sink.
`cockpit-audio.service` provides the sink; `live-browser.service` needs a
`PULSE_SERVER=unix:/run/cockpit-pulse/native` drop-in to route its audio
there — without it the audio leg silently dies (see
`infra/systemd/dropins/README.md`).
**Fix:**
```bash
sudo mkdir -p /etc/systemd/system/live-browser.service.d
printf '[Service]\nEnvironment=PULSE_SERVER=unix:/run/cockpit-pulse/native\n' | \
  sudo tee /etc/systemd/system/live-browser.service.d/10-audio.conf
sudo systemctl daemon-reload
sudo systemctl restart cockpit-audio live-browser cockpit-webrtc
```

### WebRTC connects, but the video is black
**Cause:** signaling rides the tunnel, media does not — the server advertises
only its public UDP candidates on the pinned port range **40000–40009**
(`COCKPIT_RTP_MIN`/`COCKPIT_RTP_MAX`, srflx-only filtering in
`cockpit/webrtc/webrtc_server.py`). That range must be open at **both** the
host firewall (ufw/iptables) *and* the cloud security list / security group.
Opening only one layer is the classic miss.
**Fix:** allow inbound UDP 40000–40009 in both layers, then reconnect the
panel — no service restart needed.
