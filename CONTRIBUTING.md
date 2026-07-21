# Contributing to Skyshell

Skyshell is a skeleton — it's meant to be forked, gutted, and rebuilt around
your own machine. PRs, issues, and forks are all welcome.

## Ground rules

1. **Never commit a secret.** No real hostnames, IPs, tunnel IDs, proxy
   credentials, SSH keys, or tokens. The repo ships only `*.example`
   placeholders and reads real values from `.env` / files listed in
   `.gitignore`. Before pushing, run the secret check below.
2. **Keep the two nginx vhosts in sync.** `infra/nginx/term-ui.conf` has an
   app vhost (`:7690`) and an identical emergency vhost (`:7695`) — a change to
   one almost always belongs in the other.
3. **Bump the service-worker cache constant** in `sw.js` whenever you change
   `index.html`, or the PWA will serve a stale shell.
4. **Prefer small, measured changes.** Much of this project is latency- and
   layout-sensitive; when you touch the live browser or the mobile keyboard,
   measure before/after rather than guessing.
5. **CI runs on every PR** (`.github/workflows/ci.yml`): the Python service
   tests, JS and shell syntax checks, and an `nginx -t` load of the configs
   under the documented install layout. Run the fast ones locally first —
   `python3 tools/test_tabs_service.py`, `node --check`, `bash -n`.

## Secret check before every push

```bash
# from the repo root — should print nothing
grep -rInE '([0-9]{1,3}\.){3}[0-9]{1,3}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|BEGIN [A-Z ]*PRIVATE KEY' \
  --include='*.md' --include='*.sh' --include='*.py' --include='*.js' \
  --include='*.conf' --include='*.yml' --include='*.service' . \
  | grep -vE '127\.0\.0\.1|0\.0\.0\.0|10\.0\.0\.|example\.com|@example'
```

## Local dev

See [`docs/LOCAL.md`](docs/LOCAL.md) to run the terminal + live browser on your
own laptop without any cloud setup.

## Code of conduct

Be decent. This is a small project; assume good faith.
