# Run Skyshell locally

Skyshell is designed to live on a server, but you can run the core on your own
machine to try it out — no Cloudflare, no domain, no proxy. This is the fastest
way to see the terminal UI and poke at the code.

> The **terminal** runs anywhere (Linux/macOS). The **live browser** stack
> (Xvfb + KasmVNC + Chromium + tinyproxy) is Linux-oriented — on macOS run it in
> a Linux VM/container, or skip it locally and just use the terminal.

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

The app vhost includes two `snippets/` files — create empty (inert) versions so
the auth/headers includes resolve with no Cloudflare in front:
```bash
sudo mkdir -p /etc/nginx/snippets
sudo touch /etc/nginx/snippets/term-ui-auth.conf        # empty = no origin auth (local)
sudo cp infra/nginx/term-ui-headers.conf /etc/nginx/snippets/
# serve the front-end
sudo mkdir -p /var/www/term-ui
sudo cp index.html sw.js manifest.json /var/www/term-ui/ && sudo cp -r assets /var/www/term-ui/
# use the app vhost
sudo cp infra/nginx/term-ui.conf /etc/nginx/conf.d/skyshell-local.conf
sudo nginx -t && sudo nginx -s reload
```

**4. (optional) the tabs/stats service** — powers the tab bar + the identity strip:
```bash
TERM_TABS_PORT=7691 python3 server/tabs_service.py &
```

**5. Open it** → **http://127.0.0.1:7690**

You'll get the full themed terminal UI, tabs, command palette, and PWA install —
just without the Cloudflare login (because you're on localhost).

---

## Adding the live browser locally (Linux)

On a Linux box you can bring up the watchable browser too:

```bash
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
