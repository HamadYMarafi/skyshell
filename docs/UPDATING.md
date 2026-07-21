# UPDATING — the only ritual

Everything ships from this repo. The `.bak`-file era is over.

## One-time setup — the box bare repo

Deploys and box-side installs pull from a bare git repo **on the server**, not
from GitHub. Create it once:

```bash
# on the server
git init --bare ~/skyshell.git

# on your workstation, inside your clone
git remote add box ubuntu@YOUR_SERVER_IP:skyshell.git
git push box main
```

`tools/deploy.sh` pushes `main` **and** the `deployed` tag to `box` on every
successful deploy, so the bare repo always tracks what's live.

> **Plain-clone warning:** a plain `git clone` of the bare repo checks out
> `main` — so `main` must stay pushed. deploy.sh does this for you; a tag-only
> push would leave the bare repo's `main` behind, and the next box-side clone
> would restore stale code.

> Two box-side details: the on-box clone always lands at `~/term-ui-repo`
> (hardcoded in `apply-on-box.sh`), and `server/term-backup.sh` bundles the
> bare repo from `~/term-ui.git` — its historical name — into the nightly
> backup. `ln -s skyshell.git ~/term-ui.git` on the server keeps that step
> working.

## Client / server code (`index.html`, `sw.js`, `manifest.json`, `assets/`, `server/tabs_service.py`, `server/bctl_service.py`)

```bash
# 1. edit
# 2. bump the CACHE constant in sw.js if index.html changed (the gate enforces this)
git add -A && git commit -m "..."
bash tools/deploy.sh
```

`tools/deploy.sh` refuses a dirty tree, then runs the full pipeline:

1. **Gate** (`tools/predeploy.sh`): syntax checks, theme-surface + contrast checker,
   19 unit/HTTP tests for tabs_service (incl. the shipped-bug regressions),
   sw-cache-bump guard vs the `deployed` tag.
2. **Ship**: timestamped backup on the box (`/var/backups/term-ui/deploy-<ts>/`),
   then install; `tabs_service.py`/`bctl_service.py` restart their services only
   when actually changed vs `deployed`.
3. **Live smoke** (`tools/smoke.js` through an SSH tunnel to the :7695 agent
   vhost): WS connects, SW cache coherent, endpoints live, Live Browser panel
   opens, zero console/CSP/HTTP errors.
4. **Tag or roll back**: success moves the `deployed` tag and pushes
   `main` + `deployed` to `box`; a failed smoke restores the backup and
   restarts services automatically.

## Infra (nginx, systemd units, monitoring)

Edit under `infra/`, commit, `git push box main`, then run **on the box**
(unit installs need sudo, so this step runs server-side, not from the deploy
pipeline):

```bash
ssh -i ~/.ssh/your-server.key ubuntu@YOUR_SERVER_IP \
  'rm -rf ~/term-ui-repo && git clone -q ~/skyshell.git ~/term-ui-repo && bash ~/term-ui-repo/tools/apply-on-box.sh'
```

Idempotent; nginx self-restores if its config test fails.

## Origin JWT enforcement

See `docs/ORIGIN-AUTH.md` — staged: preflight the jwt log, then
`tools/enable-origin-auth.sh` on the box; `tools/disable-origin-auth.sh` reverts.

## Invariants

- `main` on your workstation == `main` on the box bare remote
  (`git push box main` — deploy.sh does it on every deploy).
- Never edit files directly on the box or in `/var/www/term-ui` — they get
  overwritten by the next deploy.
- nginx backups go to `/etc/nginx/backups/`, NEVER `sites-enabled/` (a `.bak`
  there loads as a conflicting server block → 502).
- Monitoring: `term-health.timer` probes every 5 min and alerts via
  `~/.term-alert-env` (ntfy topic; optional Discord webhook var); nightly
  config+state backup at 03:30 UTC, 14 rotations in `/var/backups/term-ui-config/`.

Something broke after an update? → [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
