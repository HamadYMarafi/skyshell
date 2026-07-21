# systemd drop-ins

Installed by `tools/apply-infra.sh` as `/etc/systemd/system/<unit>.service.d/*.conf`.

## 10-alert.conf (all stack units)
`OnFailure=term-alert@%n.service` — any unit entering failed state pushes an alert.

## Drop-ins to create by hand (the apply script does not generate these)

- `live-browser.service.d/10-audio.conf` — routes Chromium audio into the
  cockpit null-sink; the WebRTC cockpit's audio leg is silent without it:
  ```ini
  [Service]
  Environment=PULSE_SERVER=unix:/run/cockpit-pulse/native
  ```
- `nginx.service.d/restart.conf` — auto-restart nginx on failure:
  ```ini
  [Service]
  Restart=on-failure
  RestartSec=2
  ```

Create each under `/etc/systemd/system/<unit>.service.d/`, then
`sudo systemctl daemon-reload`. If you run any extra box-local unit (e.g. a
keepalive that stops your cloud provider reclaiming an idle VM), give it the
same `10-alert.conf` OnFailure hook.

## 20-hardening.conf (selected units only)
Free sandboxing where it cannot break function:
- **term-tabs**: NoNewPrivileges, ProtectSystem=full, ReadWritePaths=/home/ubuntu (writes: PIN file, library, System-Files saves), RestrictSUIDSGID
- **bctl**: NoNewPrivileges, ProtectSystem=full, ProtectHome=read-only, RestrictSUIDSGID
- **residential-proxy**: NoNewPrivileges, ProtectSystem=full, ProtectHome=yes, RestrictSUIDSGID
- **cloudflared-skyshell**: NoNewPrivileges, ProtectSystem=full, ProtectHome=read-only (reads ~/.cloudflared), RestrictSUIDSGID
- **residential-browser**: NoNewPrivileges, RestrictSUIDSGID only (npx writes ~/.npm)

DELIBERATELY NO systemd NoNewPrivileges (do not "fix"):
- **web-terminal** — it IS the god shell; NoNewPrivileges would break sudo inside the terminal
- **kasmvnc**, **live-browser** — X server + Chromium sandbox internals; systemd NoNewPrivileges
  can break Chrome's OWN sandbox. live-browser runs WITH Chrome's sandbox (no
  `--no-sandbox`; renderers are seccomp+userns confined — requires unprivileged
  userns, the Ubuntu default). That is exactly WHY systemd NoNewPrivileges must
  stay off here: it would disable the userns sandbox Chrome relies on.
