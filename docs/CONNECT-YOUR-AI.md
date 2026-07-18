# Connect your AI to the live browser

Skyshell exposes the live browser through **two standard interfaces**, so *any*
model or agent — a cloud API, a local LLM, your own script — can drive the exact
browser you're watching, out through your residential IP.

| Interface | Port | Best for |
|---|---|---|
| **Chrome DevTools Protocol (CDP)** | `:9222` | any Playwright/Puppeteer/CDP script |
| **Playwright MCP** | `:8933` | any MCP-capable AI client (Claude Code, agents, IDEs) |

Both bind `127.0.0.1` on the server. From your laptop you reach them over an SSH
tunnel (they're never exposed publicly):

```bash
ssh -i ~/.ssh/your-server.key \
    -L 9222:127.0.0.1:9222 \
    -L 8933:127.0.0.1:8933 \
    ubuntu@YOUR_SERVER_IP
# now localhost:9222 (CDP) and localhost:8933 (MCP) point at the server's browser
```

> An AI agent *running on the box itself* (e.g. Claude Code inside the Skyshell
> terminal) doesn't need the tunnel — it reaches `127.0.0.1:9222/:8933` directly.

---

## Option A — MCP (point an AI client at `:8933`)

`residential-browser.service` runs [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)
attached to the browser's CDP endpoint:

```
npx @playwright/mcp --port 8933 --host 127.0.0.1 --cdp-endpoint http://127.0.0.1:9222
```

So it drives the **existing** residential browser rather than launching a fresh
one. Point any MCP client at the server on `:8933` (the exact URL/transport —
SSE vs streamable HTTP — depends on the playwright-mcp version; check
`npx @playwright/mcp --help`).

**Claude Code example** (run on the box, or through the tunnel):
```bash
claude mcp add --transport sse live-browser http://127.0.0.1:8933/sse
# then, inside Claude Code:
#   "open ipinfo.io/json in the live browser and read the exit IP back to me"
```

**Generic MCP client config** (shape only — adapt to your client):
```json
{
  "mcpServers": {
    "live-browser": {
      "transport": "sse",
      "url": "http://127.0.0.1:8933/sse"
    }
  }
}
```

Whatever the client, the model now has browser tools — navigate, click, type,
read, screenshot — operating on the live session you can watch in the app.

---

## Option B — raw CDP (drive it from a script)

Any language with a CDP/Playwright binding can attach to `:9222`. Example with
`playwright-core` (already a dependency):

```js
// node connect.js   (with :9222 tunneled to localhost, or run on the box)
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();

  await page.goto('https://ipinfo.io/json');
  console.log(await page.textContent('body'));   // prints your residential exit

  await browser.close();  // detaches; the browser keeps running for the next client
})();
```

Because you're **attaching** (not launching), the human watching over KasmVNC /
WebRTC sees every navigation your script makes, in real time.

---

## Wiring a local model

There's no special integration — a local model becomes a browsing agent the same
way a cloud one does:

- **If your local stack speaks MCP** (many agent runtimes and IDE plugins do):
  add the `:8933` server exactly like the Claude Code example above.
- **If it doesn't:** give the model a couple of tools that shell out to the CDP
  script in Option B (e.g. `browser_goto(url)`, `browser_read()`), and let it
  call them. The model plans; the CDP script acts; the browser executes on the
  residential IP.

Either way the loop is the same: **your model decides, the live browser does it
from a home IP, and you watch.**

---

## Safety

- The browser has whatever the residential exit can reach. Don't point an
  untrusted model at it without thinking about what it could do.
- Everything is still behind your Cloudflare Access login and localhost binds;
  don't expose `:9222` or `:8933` publicly.
- You own the ToS obligations of both the residential proxy and the sites the
  model visits. See [SECURITY.md](../SECURITY.md).
