# Configure Skyshell for your setup

Everything specific to a deployment is a **placeholder** you replace. This page
is the map: what to change, where it lives, and how to find it all.

## Find every placeholder

```bash
# from the repo root — lists every value you still need to set
grep -rIn -E 'example\.com|YOUR_SERVER_IP|your-server\.key|YOUR_TUNNEL_ID|YOUR_CF_ACCOUNT_ID|your-team\.cloudflareaccess|change-me|<YOUR' . \
  --exclude-dir=assets --exclude-dir=node_modules
```

## The must-change values

| Placeholder | Means | Set it in | Env var |
|---|---|---|---|
| `skyshell.example.com` | your app's public hostname | `infra/cloudflared/config.example.yml`, `infra/systemd/cockpit-bridge.service`, `infra/systemd/cockpit-webrtc.service`, `server/term-health.sh`, `tools/enable-origin-auth.sh` | `APP_HOST` |
| `code.example.com` | (optional) code-server hostname | `infra/cloudflared/config.example.yml` | `CODE_HOST` |
| `app.example.com` | (optional) the standalone cockpit vhost's own hostname | `infra/systemd/cockpit-bridge.service` + `cockpit-webrtc.service` (`COCKPIT_ALLOWED_ORIGINS`), `tools/apply-cockpit.sh`; its tunnel ingress is the commented `cockpit.example.com` block in `infra/cloudflared/config.example.yml` | — |
| `your-team.cloudflareaccess.com` | your Cloudflare Access team domain | `server/origin_auth.py` (default) | `ACCESS_TEAM_DOMAIN` |
| `<YOUR_TUNNEL_ID>` | your cloudflared tunnel id | `infra/cloudflared/config.example.yml` | `CF_TUNNEL_ID` |
| `YOUR_SERVER_IP` | your box's address | `tools/deploy.sh`, `tools/apply-infra.sh`, `tools/apply-on-box.sh`, `tools/apply-cockpit.sh` | `DEPLOY_HOST` |
| `your-server.key` | your SSH private-key filename | same `tools/*.sh` as above | `SSH_KEY` |
| `/etc/residential-proxy.conf` | your residential proxy upstream (kept off git) | on the server; referenced by `infra/systemd/residential-proxy.service` | see `.env.example` |
| ntfy topic / Discord webhook | where health alerts go | `~/.term-alert-env` on the server (read by `server/term-alert.sh`) | `ALERT_NTFY_TOPIC`, `ALERT_DISCORD_WEBHOOK` |

## Paths you may need to adjust

The units assume a conventional Ubuntu layout. If your user or paths differ,
update them consistently:

| Path | What it is |
|---|---|
| `~/skyshell` | your clone of this repo on the box (the path these docs assume). One exception: `tools/enable-origin-auth.sh` hardcodes the clone as `R=~/term-ui-repo` — point its `R=` variable at your clone rather than renaming it |
| `/home/ubuntu` | the service user's home (in most `*.service` files) |
| `/var/www/term-ui` | where the front-end (`index.html`, `assets/`) is served from (nginx `root`) |
| `~/term-ui` | where the Python services (`tabs_service.py`, `bctl_service.py`) live |
| `~/cockpit` | where the WebRTC cockpit lives (`cockpit/bridge`, `cockpit/webrtc`) |
| `~/.cloudflared/config.yml` | the real tunnel config (copied from the `.example`) |

Set `User=` / `HOME=` in the `.service` files to your service user.

## Ports

All the localhost ports are listed with defaults in
[`.env.example`](../.env.example). Change one only if it clashes on your box —
and then change it in the matching `.service`/nginx file too.

## Service knobs (optional)

Defaults are right for most boxes — set these only when yours differs:

- **`TERM_TABS_TMUX_SOCK`** — tmux socket path for `server/tabs_service.py`.
  The default derives from the running uid (`/tmp/tmux-<uid>/default`), which
  matches what `tmux-main.sh` creates — most users never set it. Override via
  `Environment=` in `term-tabs.service` if you run tmux on a custom socket.
- **`EGRESS_EXPECT`** — the country `term-health.sh` expects the live browser's
  egress IP to resolve to (default `GB`). If your residential proxy exits
  elsewhere, set it or every health run alerts a "drift":
  `sudo systemctl edit term-health` → `[Service]` + `Environment=EGRESS_EXPECT=US`
  (or export it when running `term-health.sh --report` by hand).
- **rclone remote `r2`** — `term-backup.sh` pushes nightly snapshots to an
  rclone remote named `r2` (`r2:backups/term-box`). Run `rclone config` once to
  create it; any S3-compatible bucket works (Cloudflare R2, S3, B2, …).
  Skipping `rclone config` just means no offsite push — the local rotations in
  `/var/backups` are written either way.
- **`AGE_RECIPIENT`** (in `server/term-backup.sh`) — the bucket only ever
  receives **age-encrypted** blobs; while this is still the placeholder the
  push is skipped entirely, never sent plaintext. Generate a keypair with
  `age-keygen` on your **own machine**, paste the `public key:` line into
  `AGE_RECIPIENT`, and keep the private key off the server — it is the only
  thing that decrypts your backups.

---

## Swapping in your own pieces

- **Your own residential proxy** → put the upstream in `/etc/residential-proxy.conf`;
  restart `residential-proxy` + `live-browser`. Match `TZ`/`--lang` in
  `live-browser.service` to the proxy's region. Guide: [LIVE-BROWSER.md](LIVE-BROWSER.md).
- **Your own AI / model** → point an MCP client at `:8933` or a CDP script at
  `:9222`. Guide: [CONNECT-YOUR-AI.md](CONNECT-YOUR-AI.md).
- **Your own domain / login policy** → it's all in the Cloudflare Tunnel + Access
  setup in [DEPLOY.md](DEPLOY.md). Add a hostname to `config.yml`, create its
  Access app, done.
- **No Cloudflare at all** → you can front nginx with your own TLS + auth instead;
  just don't ever expose the un-gated `:7695` vhost or the localhost services
  directly. See the security model in [ARCHITECTURE.md](ARCHITECTURE.md).
- **Different terminal theme / UI** → the whole front-end is one `index.html`;
  themes live near the top. Bump the cache constant in `sw.js` after editing.
