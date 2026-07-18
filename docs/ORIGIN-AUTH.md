# ORIGIN-AUTH — verifying Cloudflare Access at nginx (staged)

**Why:** today, anything that reaches `127.0.0.1:7690` gets the full app —
ttyd's `/token` is empty, so Cloudflare Access is a *single* point of total
compromise. Verifying the `Cf-Access-Jwt-Assertion` signature at the origin
closes the misconfig class (a stray tunnel hostname routed at this port, CF
config drift) — a forged header can't be signed with the team's keys.

**Why staged:** enforcement flipped blind could lock the phone out. So the
pieces are deployed inert, and the flip happens only after real-traffic
evidence.

## Current state: **ENFORCED (live since 2026-07-13 ~04:14 UTC)**
Flipped on the owner's go. Verified: bare :7690 → 401, secret → 200, :7695 open,
:8080 `/live2/` gated; his real browser path proven through the verifier
(`jwt=1` GETs + a `GET /ws → 101` upgrade), including across a cold reboot.
Verifier = `origin-auth.service` (:7697). Gotcha: probe enforcement only
after a short settle — nginx graceful reload keeps old workers answering
briefly (the enable script now sleeps 3s; its first run self-reverted on this).

## Layout (deployed 2026-07-08; cockpit parity 2026-07-13)
- `:7690` locations carry `include snippets/term-ui-auth.conf` — flipped to `auth_request`.
- `:8080` (cockpit vhost, the Skyshell host) carries the SAME include on
  `/live2/` + `/live2/webrtc`, with its own internal `/_origin_auth` location —
  so one flip covers the terminal AND the Skyshell Live-Browser panel path.
  The enable script verifies both vhosts and self-reverts on any miss.
- `/var/log/nginx/term-jwt.log` logs `jwt=0|1` per request (never the token).
- `:7695` = agent/emergency vhost, identical app, **never** auth-gated
  (reaching it requires SSH = root-equivalent trust anyway). Agents tunnel
  `ssh -L 8443:127.0.0.1:7695`.
- `server/origin_auth.py` + `tools/enable-origin-auth.sh` /
  `tools/disable-origin-auth.sh` are in the repo, not yet installed.
- **Preflight status 2026-07-13: MET** — the Jul-12 log carries 220 `jwt=1`
  lines from real traffic including `GET /ws → 101` WebSocket upgrades.
  The flip is one command away; it stays owner-gated only because a
  misbehaving flip would briefly interrupt the live phone path.

## Preflight (30 seconds of phone time)
Open https://skyshell.example.com on the phone, use the terminal briefly,
open the Live Browser panel. Then on the box:
```bash
sudo grep ' jwt=1 ' /var/log/nginx/term-jwt.log | grep -cE '"GET /(ws|browser/websockify)'   # want > 0
sudo grep -c ' jwt=0 ' /var/log/nginx/term-jwt.log                                            # local probes only
```
The critical lines are the **WebSocket upgrades** (`/ws`, `/browser/websockify`)
showing `jwt=1` — that proves Access stamps upgrade requests too.

## Flip
```bash
bash ~/term-ui-repo/tools/enable-origin-auth.sh
```
Installs deps + verifier unit, sanity-checks 401/204 against the verifier,
flips the snippet to `auth_request /_origin_auth;`, reloads, then verifies:
bare :7690 → 401 · X-Term-Secret → 200 · :7695 → 200. Any miss self-reverts.
**Then immediately re-test the real phone path.**

## Revert (any time, SSH only)
```bash
bash ~/term-ui-repo/tools/disable-origin-auth.sh
```

## Notes
- Verifier checks RS256 signature against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
  (12h cache) + `exp` + `iss`. `aud` is deliberately not pinned — signature+issuer
  is sufficient against the local/misconfig threat, and it keeps the verifier
  working if the Access app id ever changes.
- Local callers (health probe) authenticate with `X-Term-Secret` from
  `/home/ubuntu/.term-origin-secret` (minted by the enable script).
- `term-health.sh` already sends the secret header — no monitoring gap on flip.
