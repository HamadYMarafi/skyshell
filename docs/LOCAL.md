# Run Skyshell locally

Skyshell is designed to live on a server, but you can run the core on your own
machine to try it out — no Cloudflare, no domain, no proxy. This is the fastest
way to see the terminal UI and poke at the code.

> The **terminal** runs anywhere (Linux/macOS). The **live browser** stack
> (Xvfb + KasmVNC + Chromium + tinyproxy) is Linux-oriented — on macOS run it in
> a Linux VM/container, or skip it locally and just use the terminal.

All commands below run from your clone of this repo (docs assume `~/skyshell`).

---

## Terminal only (2 minutes)

**1. Install the pieces**
```bash
# macOS
brew install ttyd tmux nginx
# Debian/Ubuntu
sudo apt install -y ttyd tmux nginx
```

**2. Start ttyd on the terminal port**
```bash
ttyd -p 7681 -i 127.0.0.1 -W tmux new-session -A -s main
```
(`-W` = writable. This is the same invocation `web-terminal.service` uses.)

**3. Serve the app with the repo's nginx config**

The app vhost references two `snippets/` files plus the shared plumbing in
`term-jwt-map.conf` (the WebSocket `$connection_upgrade` map + the `jwtprobe`
log_format) — install all three or `nginx -t` fails:
```bash
sudo mkdir -p /etc/nginx/snippets
sudo touch /etc/nginx/snippets/term-ui-auth.conf        # empty = no origin auth (local)
sudo cp infra/nginx/term-ui-headers.conf /etc/nginx/snippets/
sudo cp infra/nginx/term-jwt-map.conf /etc/nginx/conf.d/
# serve the front-end
sudo mkdir -p /var/www/term-ui
sudo cp index.html sw.js manifest.json /var/www/term-ui/ && sudo cp -r assets /var/www/term-ui/
# use the app vhost — the zz- name is load-bearing: conf.d loads alphabetically,
# and the vhost's `jwtprobe` access_log needs term-jwt-map.conf parsed FIRST
# (nginx -t fails with "unknown log format" otherwise)
sudo cp infra/nginx/term-ui.conf /etc/nginx/conf.d/zz-skyshell-local.conf
sudo nginx -t && sudo nginx -s reload
```

> **macOS:** the paths above are Debian/Ubuntu. With Homebrew nginx, configs
> live under `$(brew --prefix)/etc/nginx/` (create `snippets/` there and add an
> `include` for the conf.d-style drop-ins to `nginx.conf`'s `http` block), and
> you'll want a root you can write, e.g. `$(brew --prefix)/var/www/term-ui`
> (adjust `root` in the vhost). Same three files, same order rule.

**4. (optional) the tabs/stats service** — powers the tab bar + the identity strip:
```bash
TERM_TABS_PORT=7691 python3 server/tabs_service.py &
```
It expects tmux's default socket at `/tmp/tmux-<uid>/default`. On macOS tmux
uses `$TMPDIR` instead — run `export TMUX_TMPDIR=/tmp` before starting ttyd
(step 2) so both sides agree, or point `TERM_TABS_TMUX_SOCK` at your socket.

**5. Open it** → **http://127.0.0.1:7690**

You'll get the full themed terminal UI, tabs, command palette, and PWA install —
just without the Cloudflare login (because you're on localhost).

---

## Adding the live browser locally (Linux)

On a Linux box you can bring up the watchable browser too:

```bash
# the pieces (the full server shopping list — audio + WebRTC cockpit — is in
# DEPLOY.md step 2; this is just enough to watch and drive a browser)
sudo apt install -y xvfb tinyproxy fluxbox xdotool x11-xserver-utils
# a virtual display
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99
# a residential (or any) proxy — for a local test you can skip the residential part
tinyproxy -d -c /etc/residential-proxy.conf &          # or any http proxy on :8899
# Chromium pointed at the proxy, with CDP open
chromium --user-data-dir=/tmp/live --proxy-server=http://127.0.0.1:8899 \
  --remote-debugging-port=9222 --window-size=1280,800 https://ipinfo.io/json &
# watch it
vncserver :99 -websocketPort 6081 -interface 127.0.0.1 ...   # KasmVNC; see infra/kasmvnc/
```
Then the app's Live Browser panel (`/browser/*`) shows it, and `:9222` / a
Playwright MCP on `:8933` let your AI drive it — exactly as on the server. See
[LIVE-BROWSER.md](LIVE-BROWSER.md) and [CONNECT-YOUR-AI.md](CONNECT-YOUR-AI.md).

---

## Notes

- **No login locally.** With an empty `term-ui-auth.conf`, anything that reaches
  `:7690` gets the app — fine on `127.0.0.1`, **never** do this on a public box.
- **Ports** are the same as production (see [.env.example](../.env.example)); change
  them there if something clashes.
- When you're ready to make it always-on and reachable from your phone, go to
  [DEPLOY.md](DEPLOY.md).
