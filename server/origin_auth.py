#!/usr/bin/env python3
"""origin_auth.py — nginx auth_request verifier for Cloudflare Access JWTs.

Defense-in-depth: the ONLY thing that should reach the app on :7690 is
traffic that already passed Cloudflare Access (which stamps every proxied
request — including WebSocket upgrades — with a Cf-Access-Jwt-Assertion
header signed by the team's keys). Verifying that signature AT THE ORIGIN
means a Cloudflare misconfig (stray hostname routed at this port, tunnel
config drift) can no longer expose an open terminal.

Escape hatches (so this can never lock the owner out):
  - the agent/emergency port :7695 has no auth at all (reaching it requires
    SSH, which is already root-equivalent trust)
  - X-Term-Secret header matching /home/ubuntu/.term-origin-secret also
    passes (for local scripts/health probes through :7690)
  - tools/disable-origin-auth.sh empties the nginx snippet and reloads

Requires: python3-jwt + python3-cryptography (apt). Binds 127.0.0.1:7697.
GET /verify -> 204 (pass) or 401 (deny). Team certs are fetched from the
Access certs endpoint and cached 12h (refetched on unknown kid).
"""
import json, os, time, threading, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jwt                      # PyJWT
from jwt import PyJWKClient

TEAM = os.environ.get("ACCESS_TEAM_DOMAIN", "your-team.cloudflareaccess.com")
CERTS_URL = "https://%s/cdn-cgi/access/certs" % TEAM
SECRET_FILE = os.environ.get("TERM_ORIGIN_SECRET_FILE", "/home/ubuntu/.term-origin-secret")
BIND = ("127.0.0.1", int(os.environ.get("ORIGIN_AUTH_PORT", "7697")))

_jwks = {"client": None, "ts": 0.0}
_lock = threading.Lock()

def jwks():
    with _lock:
        if _jwks["client"] is None or time.time() - _jwks["ts"] > 43200:
            _jwks["client"] = PyJWKClient(CERTS_URL, cache_keys=True)
            _jwks["ts"] = time.time()
        return _jwks["client"]

def secret_ok(v):
    if not v: return False
    try:
        with open(SECRET_FILE) as f: want = f.read().strip()
        return bool(want) and v.strip() == want
    except Exception:
        return False

def token_ok(tok):
    if not tok: return False
    try:
        key = jwks().get_signing_key_from_jwt(tok)
        jwt.decode(tok, key.key, algorithms=["RS256"],
                   options={"verify_aud": False},   # signature+exp+iss are the guarantees we need
                   issuer="https://%s" % TEAM)
        return True
    except Exception:
        return False

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/verify":
            self.send_response(404); self.end_headers(); return
        if secret_ok(self.headers.get("X-Term-Secret")) or token_ok(self.headers.get("Cf-Access-Jwt-Assertion")):
            self.send_response(204)
        else:
            self.send_response(401)
        self.end_headers()
    def log_message(self, *a): pass

if __name__ == "__main__":
    ThreadingHTTPServer(BIND, H).serve_forever()
