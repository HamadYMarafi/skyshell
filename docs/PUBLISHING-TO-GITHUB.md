# Publishing Skyshell to GitHub (first-timer friendly)

Never used GitHub before? This walks you from "a folder on my Mac" to "a repo on
my profile I can link on LinkedIn." Two paths — pick one.

> **Before anything: the safety check.** This repo was built to contain **no**
> secrets, but make it a habit to verify before every push:
> ```bash
> cd skyshell
> grep -rIn -E '([0-9]{1,3}\.){3}[0-9]{1,3}|@gmail\.com|BEGIN [A-Z ]*PRIVATE KEY' \
>   --exclude-dir=assets --exclude-dir=.git . | grep -vE '127\.0\.0\.1|0\.0\.0\.0|10\.0\.0\.|example\.com'
> ```
> If that prints nothing but localhost/example lines, you're clean. `.gitignore`
> already blocks `.env`, keys, and the real tunnel config.

---

## Path A — GitHub Desktop (easiest, all clicks)

1. Make a free account at **github.com**.
2. Download **GitHub Desktop** (desktop.github.com), open it, sign in.
3. **File → Add Local Repository →** choose the `skyshell` folder. It'll offer to
   "create a repository" — say yes (this runs `git init` for you).
4. Type a summary in the box (e.g. *"Initial commit — Skyshell"*) and click
   **Commit to main**.
5. Click **Publish repository**. Untick "Keep this code private" if you want it
   public (you do, for a showcase). Click **Publish**.
6. Done — click **View on GitHub** to see it live.

---

## Path B — the command line

**One-time setup** (skip what you already have):
```bash
# install GitHub's CLI + sign in (opens a browser)
brew install gh
gh auth login          # choose GitHub.com → HTTPS → login with a browser

git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

**Publish the folder:**
```bash
cd path/to/skyshell
git init
git add -A
git commit -m "Initial commit — Skyshell"
git branch -M main
# creates the repo on your account AND pushes in one go:
gh repo create skyshell --public --source=. --remote=origin --push
```

That's it — `gh` prints the URL.

<details>
<summary>No <code>gh</code>? Do it manually.</summary>

1. On github.com click **New repository** → name it `skyshell` → **Public** →
   **don't** add a README/License (this folder already has them) → **Create**.
2. Copy the commands GitHub shows under *"…or push an existing repository"*:
   ```bash
   cd path/to/skyshell
   git init && git add -A && git commit -m "Initial commit — Skyshell"
   git branch -M main
   git remote add origin https://github.com/<you>/skyshell.git
   git push -u origin main
   ```
   (GitHub will ask you to authenticate in the browser the first time.)
</details>

---

## Make it look good (5 minutes)

1. **About box** (top-right of the repo page → the ⚙️): add a one-line
   description and **topics** — e.g. `self-hosted`, `web-terminal`, `xterm`,
   `cloudflare-tunnel`, `residential-proxy`, `playwright`, `mcp`, `pwa`.
2. **Screenshots**: the README galleries already render from
   `docs/screenshots/`. To use your own captures, replace those files (keep the
   filenames) or drop new images into `docs/screenshots/` and update the paths
   in `README.md`.
3. **Pin it** to your profile: your profile page → **Customize your pins** →
   tick `skyshell`.
4. **License**: the `LICENSE` file says *"Skyshell contributors"* — you may want
   to change that line to your own name.

---

## The LinkedIn post (template)

> 🪐 I built **Skyshell** — a self-hosted web terminal + a live browser on a
> residential IP that I *and my AI* can drive, all from my phone, behind one
> login with zero open ports.
>
> It turns a cheap always-on server into a cockpit I reach from any browser:
> a real shell with persistent sessions, and a watchable Chromium that browses
> the live web from a home IP — which any local or API model can pilot over
> CDP / MCP while I watch.
>
> Zero inbound ports (Cloudflare Tunnel dials out), one login (Access), and it
> installs to my home screen as a PWA. Open source, MIT.
>
> 👉 github.com/<you>/skyshell
>
> #selfhosted #opensource #webdev #AI #devtools

Swap in your handle, attach a screenshot or a short screen-recording of the live
browser, and post.

---

## Updating it later

After the first push, publishing changes is just:
```bash
git add -A && git commit -m "what changed" && git push
```
(Or, in GitHub Desktop: commit, then **Push origin**.)
