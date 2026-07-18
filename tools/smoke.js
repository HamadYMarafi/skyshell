/* Live smoke test — drives the real app in headless Chrome.
 *
 * Usage: BASE=http://127.0.0.1:8443 node tools/smoke.js
 * (BASE defaults to the standard agent tunnel port.)
 *
 * PASS requires, within the budget:
 *  1. shell loads, xterm mounts, and the ttyd WS actually connects
 *     (document.title changes from "Terminal" to the tmux title)
 *  2. service worker active; exactly one cache, matching sw.js's CACHE const
 *  3. /tabs returns a JSON array; /stats returns proxy_ok boolean; the
 *     folder-upload endpoints (mkdir → nested upload → delete) round-trip,
 *     and a synthetic folder drop through the real client queue (_tdTest)
 *     walks, uploads, pastes the root path, and cleans up after itself
 *  4. right-click over the terminal opens the app context menu (not the
 *     native one), Escape closes it; an OSC 52 sequence through the real
 *     parser lands on the clipboard lane; the menu's Paste drives pasteClip
 *     end-to-end with a stubbed clipboard read (_cbTest taps both lanes
 *     BEFORE the terminal hand-off — nothing reaches the live tmux or the
 *     machine clipboard; term.paste itself is asserted present, not driven)
 *  5. Live Browser panel opens and its iframe points at /browser/
 *  6. zero console errors, zero pageerrors, zero CSP violations,
 *     zero HTTP >= 400 responses
 */
const { chromium } = require('playwright-core');
const BASE = process.env.BASE || 'http://127.0.0.1:8443';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1380, height: 860 } });
  const fail = [];
  const consoleErrs = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => consoleErrs.push('pageerror: ' + String(e).slice(0, 200)));
  page.on('response', r => { if (r.status() >= 400) fail.push('HTTP ' + r.status() + ' ' + r.url().slice(0, 120)); });
  await page.addInitScript(() => {
    window.__cspv = [];
    document.addEventListener('securitypolicyviolation', e =>
      window.__cspv.push(e.violatedDirective + ' ' + (e.blockedURI || '').slice(0, 80)));
  });

  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 25000 });

  // 1. WS connected => ttyd retitles the document
  try {
    await page.waitForFunction(() => document.title && document.title !== 'Terminal', null, { timeout: 15000 });
  } catch (e) { fail.push('WS never connected (title unchanged)'); }
  const hasXterm = await page.evaluate(() => !!document.querySelector('.xterm'));
  if (!hasXterm) fail.push('xterm did not mount');

  // 2. SW + cache version coherence
  await page.waitForTimeout(4000);
  const swState = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { active: !!(reg && reg.active), keys: await caches.keys() };
  });
  const swSrc = await (await page.request.get(BASE + '/sw.js')).text();
  const expected = (swSrc.match(/CACHE\s*=\s*"([^"]+)"/) || [])[1];
  if (!swState.active) fail.push('service worker not active');
  if (expected && !swState.keys.includes(expected)) fail.push('cache mismatch: expected ' + expected + ' got [' + swState.keys + ']');
  if (swState.keys.length > 1) fail.push('stale caches present: ' + swState.keys.join(','));

  // 3. control-plane endpoints
  const tabs = await (await page.request.get(BASE + '/tabs')).json().catch(() => null);
  if (!Array.isArray(tabs)) fail.push('/tabs did not return an array');
  const stats = await (await page.request.get(BASE + '/stats')).json().catch(() => ({}));
  if (typeof stats.proxy_ok !== 'boolean') fail.push('/stats proxy_ok missing');

  // 3.5 folder-upload endpoints (v19): mkdir root → nested upload → recursive
  // delete. Cleanup runs in finally — a mid-step failure must not strand an
  // orphan dir on the live box (it'd be invisible in the Library panel).
  let smokeRoot = null;
  try {
    const mk = await (await page.request.post(BASE + '/tabs/lib/mkdir?name=smoke-folder')).json();
    if (!mk.name) throw new Error('mkdir: ' + JSON.stringify(mk));
    smokeRoot = mk.name;
    const up = await (await page.request.post(
      BASE + '/tabs/lib/upload?name=probe.txt&dir=' + encodeURIComponent(mk.name + '/sub'),
      { headers: { 'Content-Type': 'application/octet-stream' }, data: 'folder-smoke' })).json();
    if (!up.ok) throw new Error('nested upload: ' + JSON.stringify(up));
  } catch (e) { fail.push('folder endpoints: ' + String(e).slice(0, 160)); }
  finally {
    if (smokeRoot) {
      const del = await (await page.request.post(BASE + '/tabs/lib/delete?name=' + encodeURIComponent(smokeRoot))).json().catch(() => ({}));
      if (!del.ok) fail.push('folder delete failed — orphan on box: ' + smokeRoot);
    }
  }

  // 3.6 client folder-drop path: synthetic directory entries through the REAL
  // drop queue (window._tdTest) — walk, mkdir, nested+empty-dir uploads, and
  // the root-path paste (tapPaste captures it; nothing reaches the live tmux).
  try {
    const paste = await page.evaluate(() => new Promise((res) => {
      const pastes = [];
      window._tdTest.tapPaste(t => pastes.push(t));
      const mkFile = (name, content) => ({ isFile: true, isDirectory: false, name, file: cb => cb(new File([content], name)) });
      const mkDir = (name, children) => ({ isFile: false, isDirectory: true, name,
        createReader: () => { let handed = false;
          return { readEntries: cb => { if (handed) return cb([]); handed = true; cb(children); } }; } });
      const root = mkDir('smoke-drop', [
        mkFile('a.txt', 'x'),
        mkDir('sub', [mkFile('b.txt', 'y')]),
        mkDir('cache', [mkFile('.DS_Store', 'junk')]),   // dotfile-only dir must still be created
      ]);
      window._tdTest.enqueue([{ folder: root }]);
      const t0 = Date.now();
      (function poll() {
        if (pastes.length) return res(pastes[0]);
        if (Date.now() - t0 > 20000) return res(null);
        setTimeout(poll, 200);
      })();
    }));
    if (!paste || paste.indexOf('smoke-drop') < 0) throw new Error('paste=' + JSON.stringify(paste));
    // recover the server-final root name from the pasted (possibly quoted) path;
    // a successful recursive delete doubles as proof the tree landed server-side
    const dropRoot = paste.trim().replace(/^'(.*)'$/, '$1').replace('/home/ubuntu/files/', '');
    const del = await (await page.request.post(BASE + '/tabs/lib/delete?name=' + encodeURIComponent(dropRoot))).json().catch(() => ({}));
    if (!del.ok) fail.push('client-drop cleanup failed — orphan on box: ' + dropRoot);
  } catch (e) { fail.push('client folder drop: ' + String(e).slice(0, 160)); }

  // 3.7 context menu + clipboard lanes (v20): a real right-click over the
  // terminal must open OUR menu (native + tmux menus are suppressed); OSC 52
  // must decode through the real parser; menu Paste must read the clipboard.
  // _cbTest.tap intercepts the clipboard/terminal ends — nothing reaches the
  // live tmux session or the machine clipboard.
  try {
    const bb = await (await page.$('.xterm-screen')).boundingBox();
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { button: 'right' });
    await page.waitForFunction(() => window._cbTest && window._cbTest.isOpen(), null, { timeout: 3000 });
    const items = await page.evaluate(() => window._cbTest.items().filter(i => i.shown).map(i => i.act));
    for (const need of ['copy', 'paste', 'selectall', 'search'])
      if (!items.includes(need)) fail.push('ctxmenu: missing item ' + need + ' (got ' + items + ')');
    await page.keyboard.press('Escape');
    if (await page.evaluate(() => window._cbTest.isOpen())) fail.push('ctxmenu: Escape did not close it');

    const copied = await page.evaluate(() => new Promise((res) => {
      window._cbTest.tap((kind, text) => { if (kind === 'copy') res(text); });
      window._cbTest.writeOsc52('smoke-osc52-✓');
      setTimeout(() => res('TIMEOUT'), 4000);
    }));
    if (copied !== 'smoke-osc52-✓') fail.push('osc52 copy: got ' + JSON.stringify(copied));

    // stub the clipboard read — branded Chrome's new-headless clipboard is the
    // REAL macOS pasteboard, and a seed write would clobber the operator's
    // clipboard on every deploy. The stub still drives pasteClip end-to-end.
    const pasted = await page.evaluate(() => new Promise((res) => {
      const orig = navigator.clipboard.readText.bind(navigator.clipboard);
      const done = (v) => { navigator.clipboard.readText = orig; res(v); };
      navigator.clipboard.readText = () => Promise.resolve('smoke-paste-✓');
      window._cbTest.tap((kind, text) => { if (kind === 'paste') done(text); });
      window._cbTest.run('paste');
      setTimeout(() => done('TIMEOUT'), 4000);
    }));
    if (pasted !== 'smoke-paste-✓') fail.push('menu paste: got ' + JSON.stringify(pasted));
    await page.evaluate(() => window._cbTest.tap(null));
    // the tap intercepts before term.paste — assert the bracketed-paste API
    // at least exists, so a bundle swap that loses it can't ship silently
    if (!(await page.evaluate(() => window._cbTest.pasteApi()))) fail.push('term.paste API missing');
  } catch (e) { fail.push('ctxmenu/clipboard: ' + String(e).slice(0, 160)); }

  // 4. Live Browser panel
  try {
    await page.click('#btn-live-browser', { timeout: 5000 });
    await page.waitForTimeout(5000);
    const src = await page.evaluate(() => {
      const f = document.querySelector('#browser-panel iframe');
      return f ? f.src : null;
    });
    if (!src || src.indexOf('/live2/') < 0) fail.push('Live Browser iframe missing/wrong: ' + src);
  } catch (e) { fail.push('Live Browser panel failed to open'); }

  // 5. cleanliness
  const cspv = await page.evaluate(() => window.__cspv);
  cspv.forEach(v => fail.push('CSP violation: ' + v));
  consoleErrs.forEach(c => fail.push('console: ' + c));

  await browser.close();
  if (fail.length) { console.error('SMOKE FAIL\n - ' + fail.join('\n - ')); process.exit(1); }
  console.log('SMOKE PASS  (ws + sw:' + expected + ' + tabs:' + tabs.length + ' + folder-endpoints + ctxmenu/clipboard + browser-panel + 0 errors)');
})().catch(e => { console.error('SMOKE FATAL ' + String(e).slice(0, 300)); process.exit(1); });
