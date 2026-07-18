# systemd drop-ins

Installed by `tools/apply-infra.sh` as `/etc/systemd/system/<unit>.service.d/*.conf`.

## 10-alert.conf (all stack units)
`OnFailure=term-alert@%n.service` — any unit entering failed state pushes an alert.

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
  can break Chrome's OWN sandbox. NOTE (2026-07-12): live-browser now runs WITH Chrome's
  sandbox — `--no-sandbox` was dropped (renderers are seccomp+userns confined; the box already
  allows unprivileged userns). That is exactly WHY systemd NoNewPrivileges must stay off here:
  it would disable the userns sandbox Chrome now relies on.
