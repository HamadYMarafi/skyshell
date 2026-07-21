/* ==========================================================================
 * Terminal — service worker
 * ==========================================================================
 * Goal: an installable, offline-capable APP SHELL — while NEVER caching the
 * live endpoints (/ws, /token, /tabs, /stats). Those must always hit the
 * network so the terminal, auth and session/stat state are real-time.
 *
 * Strategy:
 *   - navigations (the index.html document) -> NETWORK-FIRST (freshest shell when
 *                                   online; cached shell only as an offline fallback)
 *                                   so a browser can never wedge on a stale app.
 *   - GET /assets/*              -> stale-while-revalidate (instant + self-updating)
 *   - GET /token /tabs /stats    -> network-only (bypass cache entirely)
 *   - GET /browser/* (Live Browser, SAME-ORIGIN, incl. its iframe DOCUMENT) ->
 *                                   network-only; MUST be tested before the
 *                                   navigation branch (its iframe load is mode=navigate too)
 *   - /ws + /browser/websockify (WebSocket) -> never reach fetch(); nothing to do
 *   - non-GET (POST /tabs/*)     -> passthrough to network
 *   - cross-origin               -> untouched
 * ======================================================================== */

var CACHE = "term-shell-v21";   // v21: file links — paths in terminal output validate against the box and click-download via /tabs/dl; http(s) URLs open in a new tab

/* App shell + same-origin static assets to precache. Missing files are tolerated
   (Promise.allSettled) so a not-yet-deployed asset never blocks activation. */
var SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "/assets/xterm.js",
  "/assets/xterm.css",
  "/assets/xterm-addon-fit.js",
  "/assets/xterm-addon-search.js",
  "/assets/JetBrainsMonoNerdFont.woff2",
  "/assets/icon-180.png",
  "/assets/icon-192.png",
  "/assets/icon-512.png"
];

self.addEventListener("install", function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.allSettled(SHELL.map(function (u) {
        // Guarded add (same rule as the navigate branch): never precache a redirect
        // or cross-origin body — e.g. a CF-Access login page during an expired
        // session — as part of the offline shell. cache.add() would have.
        return fetch(u, { cache: "no-cache" }).then(function (res) {
          if (res && res.ok && res.type === "basic" && !res.redirected) return cache.put(u, res);
          throw new Error("skip " + u);
        });
      }));
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* Live endpoints that must never be served from cache: the same-origin Live
   Browser panels — /browser/ (KasmVNC) and /live2/ (the WebRTC cockpit; its
   page carries a per-server token and an evolving control protocol, so a
   cached shell would talk stale protocol to a fresh bridge) — plus the live
   data endpoints. Both panel paths load as NAVIGATIONS (iframe), so this test
   must stay AHEAD of the network-first navigation branch below. */
function isBypass(url) {
  return /^\/(browser|live2)(\/|$)/.test(url.pathname)
      || /\/(ws|token|tabs|stats)(\/|\?|$)/.test(url.pathname);
}

self.addEventListener("fetch", function (event) {
  var req = event.request;

  // Only GET is cacheable; POST /tabs/* and friends go straight to the network.
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Leave cross-origin requests (e.g. the Live Browser tab) alone.
  if (url.origin !== self.location.origin) return;

  // Real-time endpoints: network-only, never cached. MUST run before the
  // navigation branch below — the Live Browser iframe (/browser/index.html) is a
  // mode="navigate" load too, and must stay live-only, never cache-managed.
  if (isBypass(url)) { event.respondWith(fetch(req)); return; }

  // App DOCUMENT (navigations): NETWORK-FIRST. An online browser always gets the
  // freshest index.html, so it can never stay stuck on a stale cached shell after
  // a deploy. Cache is only a fallback when offline. A CF-Access redirect/login
  // page is never cached as the shell (guarded on basic + ok + !redirected).
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req, { cache: "no-cache" }).then(function (res) {
        if (res && res.ok && res.type === "basic" && !res.redirected) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {                       // offline -> serve the cached shell
        return caches.match(req).then(function (c) { return c || caches.match("./index.html"); });
      })
    );
    return;
  }

  // Static assets (/assets/*): stale-while-revalidate for instant paint.
  event.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok && res.type === "basic") {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });   // offline -> whatever we have
      return cached || network;                   // cache-first for instant paint
    })
  );
});
