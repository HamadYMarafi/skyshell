# ORIGIN-AUTH — verifying Cloudflare Access at nginx (staged)

**What it is:** a second, origin-side auth layer. Every app location on the
`:7690` vhost — and `/live2/*` on the `:8080` cockpit vhost — carries
`include snippets/term-ui-auth.conf`. As shipped, that snippet is an inert
comment. Enabled, it becomes `auth_request /_origin_auth;`, which nginx routes
to a small local verifier (`server/origin_auth.py` as `origin-auth.service`,
`127.0.0.1:7697`). A request then passes only with a valid **Cloudflare Access
JWT** (the `Cf-Access-Jwt-Assertion` header Access stamps on every proxied
request, WebSocket upgrades included) or the local **`X-Term-Secret`** header.

**Why:** without it, anything that reaches `127.0.0.1:7690` gets the full app —
Cloudflare Access is a *single* point of total compromise. Verifying the JWT
signature at the origin closes the misconfig class (a stray tunnel hostname
routed at this port, CF config drift): a forged header can't be signed with
your team's keys.

**Why staged:** enforcement flipped blind can lock your own devices out. So the
pieces deploy inert, and the flip happens only after real-traffic evidence.

## The pieces

- **The snippet** — `snippets/term-ui-auth.conf`, included on every gated
  location of `:7690` *and* on `/live2/` + `/live2/webrtc` of the `:8080`
  cockpit vhost (each vhost has its own internal `/_origin_auth` location), so
  one flip covers the terminal **and** the Live-Browser panel path. The enable
  script verifies both vhosts and self-reverts on any miss.
- **The verifier** — `origin_auth.py` checks the RS256 signature against
  `https://<your-team>.cloudflareaccess.com/cdn-cgi/access/certs` (12h cache,
  refetch on unknown kid) plus `exp` + `iss`. Set your team via the
  `ACCESS_TEAM_DOMAIN` env var. `aud` is deliberately not pinned —
  signature+issuer is sufficient against the local/misconfig threat, and it
  keeps the verifier working if the Access app id ever changes. Local callers
  (health probe, scripts) pass `X-Term-Secret` matching
  `~/.term-origin-secret`, minted by the enable script; `term-health.sh`
  already sends it, so there's no monitoring gap on flip.
- **The preflight log** — `infra/nginx/term-jwt-map.conf` defines the
  `jwtprobe` log format; the app vhost logs `jwt=0|1` per request to
  `/var/log/nginx/term-jwt.log` (whether a JWT was present — never the token).

## The agent / emergency vhost (`:7695`)

An identical copy of the app on `127.0.0.1:7695`, **never** auth-gated —
reaching it requires SSH, which is already root-equivalent trust. Agents and
the deploy smoke test tunnel in with `ssh -L 8443:127.0.0.1:7695`. It is also
your escape hatch if a flip ever goes wrong while you're away from a browser
that can pass Access.

## Preflight (30 seconds of phone time)

Open https://skyshell.example.com on the device you actually use, use the
terminal briefly, open the Live Browser panel. Then on the box:

```bash
sudo grep ' jwt=1 ' /var/log/nginx/term-jwt.log | grep -cE '"GET /(ws|browser/websockify)'   # want > 0
sudo grep -c ' jwt=0 ' /var/log/nginx/term-jwt.log                                            # local probes only
```

The critical lines are the **WebSocket upgrades** (`/ws`,
`/browser/websockify`) showing `jwt=1` — that proves Access stamps upgrade
requests too. Don't flip until you see them on real traffic.

## Enable

```bash
bash ~/term-ui-repo/tools/enable-origin-auth.sh    # on the box
```

The script: installs deps + the verifier unit, sanity-checks the verifier
directly (401 bare / 204 with secret), flips the snippet to `auth_request`,
reloads nginx, **sleeps 3 seconds**, then verifies enforcement: bare `:7690` →
401 · `X-Term-Secret` → 200 · `:7695` → 200 · `:8080 /live2/` → 401 bare /
200 with secret. Any miss self-reverts to the disabled snippet and reloads.

The 3-second settle is load-bearing: a graceful nginx reload keeps old workers
answering briefly, so an immediate probe sees pre-flip behavior and
false-triggers the self-revert. Keep the sleep if you fork the script.

**Then immediately re-test the real path**: open the app through Cloudflare
Access on your normal device, use the terminal, open the Live Browser panel.

## Revert (any time, SSH only)

```bash
bash ~/term-ui-repo/tools/disable-origin-auth.sh
```

Empties the snippet, reloads nginx — `:7690` is open (to localhost) again. The
verifier service is left running; it's harmless.
