# Security notes

Skyshell puts a shell, a file browser, and a live browser on the public
internet. Treat it accordingly.

## The security model

- **Zero inbound ports.** The box dials *out* to Cloudflare via `cloudflared`.
  Nothing listens on a public interface, so there is no port to scan or attack.
- **One front door.** Every hostname sits behind a **Cloudflare Access**
  application. Only the identities you allow (an email, a group, an IdP) ever
  reach the origin.
- **Defense in depth (optional).** `server/origin_auth.py` +
  `tools/enable-origin-auth.sh` add a *second*, origin-side check: nginx
  verifies the `Cf-Access-Jwt-Assertion` signature against your team's keys, so
  a stray tunnel hostname or an Access misconfig can't hand out a shell. See
  [`docs/ORIGIN-AUTH.md`](docs/ORIGIN-AUTH.md).
- **Localhost-only services.** ttyd, the Python services, KasmVNC, the proxy,
  and CDP all bind `127.0.0.1`. They are only reachable through nginx (which is
  only reachable through the tunnel).
- **The emergency vhost (`:7695`) is deliberately un-gated** but reachable
  **only** over an SSH tunnel — SSH access is already root-equivalent trust.
  Don't expose it through the public tunnel.

## Your responsibilities as a deployer

- Keep the box's SSH **key-only**, firewalled, and patched (`fail2ban` helps).
- Put **strong, unguessable** values in every secret file (`.static-proxy`,
  `.term-origin-secret`, any code-server password).
- The **live browser runs real Chromium on a residential IP** — you are
  responsible for what it browses and for complying with the residential
  proxy provider's and target sites' terms of service.
- Never commit `.env` or any file under `.gitignore`'s secret list.

## Reporting

This is a personal/skeleton project with no security SLA. If you find a real
issue in the code, open an issue (for non-sensitive bugs) or contact the
maintainer privately (for anything exploitable).
