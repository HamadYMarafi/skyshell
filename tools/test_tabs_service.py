#!/usr/bin/env python3
"""Unit + HTTP-level tests for tabs_service.py.

Run:  python3 tools/test_tabs_service.py           (from the repo root)
Uses the service's own env overrides to sandbox into a temp dir — never
touches /home/ubuntu or the real PIN file. Starts the real handler on an
ephemeral port, so auth, lockout, containment and uploads are tested through
actual HTTP, not by poking privates.

Regression cases locked in here:
  - v10 PIN off-by-one (5th miss must 429 immediately, no phantom "left")
  - sibling-prefix and absolute-path containment bypasses
"""
import json, os, sys, tempfile, threading, unittest, urllib.request, urllib.error

TMP = os.path.realpath(tempfile.mkdtemp(prefix="tabs-test-"))  # macOS: /var -> /private/var
FILES = os.path.join(TMP, "home"); LIB = os.path.join(TMP, "files")
os.makedirs(FILES); os.makedirs(os.path.join(FILES, "sub"))
os.environ["TERM_TABS_FILES_BASE"] = FILES
os.environ["TERM_TABS_LIB_BASE"] = LIB
os.environ["TERM_TABS_PIN_FILE"] = os.path.join(TMP, "pin")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import tabs_service as T
from http.server import ThreadingHTTPServer

SRV = ThreadingHTTPServer(("127.0.0.1", 0), T.H)
PORT = SRV.server_address[1]
threading.Thread(target=SRV.serve_forever, daemon=True).start()

def req(method, path, body=None, headers=None):
    r = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path), method=method,
                               data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def jreq(method, path, **kw):
    c, b = req(method, path, **kw)
    try: return c, json.loads(b)
    except Exception: return c, b

def form(**kv):
    from urllib.parse import urlencode
    return urlencode(kv).encode(), {"Content-Type": "application/x-www-form-urlencoded"}


class Containment(unittest.TestCase):
    def test_safe_path_root_and_child(self):
        self.assertEqual(T.safe_path(""), FILES)
        self.assertEqual(T.safe_path("sub"), os.path.join(FILES, "sub"))

    def test_safe_path_escapes(self):
        self.assertIsNone(T.safe_path("../"))
        self.assertIsNone(T.safe_path("../../etc/passwd"))
        self.assertIsNone(T.safe_path("/etc/passwd"))          # absolute-join bypass

    def test_safe_path_sibling_prefix(self):
        os.makedirs(FILES + "XYZ", exist_ok=True)              # /…/homeXYZ next to /…/home
        self.assertIsNone(T.safe_path("../homeXYZ"))

    def test_safe_path_symlink_escape(self):
        ln = os.path.join(FILES, "esc")
        if not os.path.islink(ln): os.symlink(TMP, ln)         # points OUTSIDE the base
        self.assertIsNone(T.safe_path("esc"))

    def test_safe_name(self):
        self.assertEqual(T._safe_name("a.txt"), "a.txt")
        for bad in ["", ".hidden", "a/b", "..", "a\\b", "a\x00b", "a\rb", "a\x1fb"]:
            self.assertIsNone(T._safe_name(bad), bad)

    def test_dispo_neutralises_header_bytes(self):
        self.assertNotIn('"', T._dispo('a"b'))
        self.assertNotIn("\r", T._dispo("a\r\nSet-Cookie: x"))
        self.assertNotIn("\\", T._dispo("a\\b"))

    def test_safe_relpath(self):
        self.assertEqual(T._safe_relpath("a"), "a")
        self.assertEqual(T._safe_relpath("a/b c/d.txt"), "a/b c/d.txt")
        for bad in ["", "/a", "a//b", "a/../b", "..", "a/.hid/b", ".h/a", "a\\b/c",
                    "a/b\x00c", "a/b\rc", "x" * 901, "/".join(["d"] * 33)]:
            self.assertIsNone(T._safe_relpath(bad), repr(bad))


class PinAndTokens(unittest.TestCase):
    def setUp(self):
        try: os.unlink(os.environ["TERM_TABS_PIN_FILE"])
        except FileNotFoundError: pass
        with T.LOCK: T.TOKENS.clear(); T.PIN_FAILS["n"] = 0; T.PIN_FAILS["until"] = 0

    def test_setpin_validation_and_mode(self):
        b, h = form(pin="12a4"); self.assertEqual(jreq("POST", "/tabs/sys/setpin", body=b, headers=h)[0], 400)
        b, h = form(pin="1234"); c, j = jreq("POST", "/tabs/sys/setpin", body=b, headers=h)
        self.assertEqual(c, 200); self.assertIn("token", j)
        self.assertEqual(os.stat(os.environ["TERM_TABS_PIN_FILE"]).st_mode & 0o777, 0o600)
        b, h = form(pin="9999"); self.assertEqual(jreq("POST", "/tabs/sys/setpin", body=b, headers=h)[0], 403)

    def test_lockout_no_off_by_one(self):
        b, h = form(pin="1234"); jreq("POST", "/tabs/sys/setpin", body=b, headers=h)
        lefts = []
        for i in range(4):
            b, h = form(pin="0000"); c, j = jreq("POST", "/tabs/sys/unlock", body=b, headers=h)
            self.assertEqual(c, 401); lefts.append(j["left"])
        self.assertEqual(lefts, [4, 3, 2, 1])
        b, h = form(pin="0000"); c, j = jreq("POST", "/tabs/sys/unlock", body=b, headers=h)
        self.assertEqual(c, 429)                                # 5th miss locks IMMEDIATELY (v10 regression)
        self.assertGreater(j["retry"], 0)
        b, h = form(pin="1234"); c, _ = jreq("POST", "/tabs/sys/unlock", body=b, headers=h)
        self.assertEqual(c, 429)                                # even the right PIN is refused while locked

    def test_unlock_token_and_auth_gates(self):
        b, h = form(pin="1234"); jreq("POST", "/tabs/sys/setpin", body=b, headers=h)
        b, h = form(pin="1234"); c, j = jreq("POST", "/tabs/sys/unlock", body=b, headers=h)
        self.assertEqual(c, 200); tok = j["token"]
        self.assertEqual(jreq("GET", "/tabs/files")[0], 401)    # no token
        c, j = jreq("GET", "/tabs/files", headers={"X-Term-Tok": tok})
        self.assertEqual(c, 200); self.assertEqual(j["path"], "")
        self.assertEqual(jreq("GET", "/tabs/file?path=/etc/passwd", headers={"X-Term-Tok": tok})[0], 403)
        with T.LOCK: T.TOKENS[tok] = 1                          # force-expire
        self.assertEqual(jreq("GET", "/tabs/files", headers={"X-Term-Tok": tok})[0], 401)

    def test_sys_state_relative_retry(self):
        c, j = jreq("GET", "/tabs/sys/state")
        self.assertEqual(c, 200)
        for k in ("set", "locked_until", "retry"): self.assertIn(k, j)


class Library(unittest.TestCase):
    def test_upload_collision_download_delete(self):
        c, j = jreq("POST", "/tabs/lib/upload?name=x.txt", body=b"one",
                    headers={"Content-Type": "application/octet-stream"})
        self.assertEqual((c, j["name"]), (200, "x.txt"))
        c, j = jreq("POST", "/tabs/lib/upload?name=x.txt", body=b"two",
                    headers={"Content-Type": "application/octet-stream"})
        self.assertEqual((c, j["name"]), (200, "x (2).txt"))
        c, body = req("GET", "/tabs/lib/file?name=x%20(2).txt")
        self.assertEqual((c, body), (200, b"two"))
        self.assertEqual(jreq("POST", "/tabs/lib/upload?name=../evil", body=b"z",
                              headers={"Content-Type": "application/octet-stream"})[0], 400)
        c, j = jreq("GET", "/tabs/lib")
        self.assertEqual(sorted(e["name"] for e in j["entries"]), ["x (2).txt", "x.txt"])
        self.assertEqual(jreq("POST", "/tabs/lib/delete?name=x%20(2).txt")[0], 200)

    def test_folder_mkdir_upload_delete(self):
        c, j = jreq("POST", "/tabs/lib/mkdir?name=proj")
        self.assertEqual((c, j["name"]), (200, "proj"))
        c, j = jreq("POST", "/tabs/lib/mkdir?name=proj")            # root collides ONCE, not per-file
        self.assertEqual((c, j["name"]), (200, "proj (2)"))
        c, j = jreq("POST", "/tabs/lib/upload?name=f.txt&dir=proj/sub", body=b"deep",
                    headers={"Content-Type": "application/octet-stream"})
        self.assertEqual((c, j["name"]), (200, "f.txt"))
        with open(os.path.join(LIB, "proj", "sub", "f.txt")) as f: self.assertEqual(f.read(), "deep")
        c, j = jreq("POST", "/tabs/lib/upload?name=f.txt&dir=proj/sub", body=b"deep2",
                    headers={"Content-Type": "application/octet-stream"})
        self.assertEqual((c, j["name"]), (200, "f (2).txt"))        # collision resolved IN the subdir
        self.assertEqual(jreq("POST", "/tabs/lib/mkdir?path=proj/empty/leaf")[0], 200)
        self.assertTrue(os.path.isdir(os.path.join(LIB, "proj", "empty", "leaf")))
        # escapes hard-blocked on every parameter
        self.assertEqual(jreq("POST", "/tabs/lib/upload?name=f&dir=../evil", body=b"z",
                              headers={"Content-Type": "application/octet-stream"})[0], 400)
        self.assertEqual(jreq("POST", "/tabs/lib/upload?name=f&dir=a/.h", body=b"z",
                              headers={"Content-Type": "application/octet-stream"})[0], 400)
        self.assertEqual(jreq("POST", "/tabs/lib/mkdir?path=../evil")[0], 400)
        self.assertEqual(jreq("POST", "/tabs/lib/mkdir?name=../evil")[0], 400)
        self.assertEqual(jreq("POST", "/tabs/lib/mkdir")[0], 400)
        self.assertFalse(os.path.exists(os.path.join(TMP, "evil")))
        # dirs stay hidden from the flat lib listing
        c, j = jreq("GET", "/tabs/lib")
        self.assertNotIn("proj", [e["name"] for e in j["entries"]])
        # folder delete is recursive; the sibling root survives
        self.assertEqual(jreq("POST", "/tabs/lib/delete?name=proj")[0], 200)
        self.assertFalse(os.path.exists(os.path.join(LIB, "proj")))
        self.assertEqual(jreq("POST", "/tabs/lib/delete?name=proj%20(2)")[0], 200)

    def test_sys_save_atomic_and_gated(self):
        p = os.path.join(FILES, "note.txt")
        with open(p, "w") as f: f.write("old")
        os.chmod(p, 0o640)
        self.assertEqual(jreq("POST", "/tabs/sys/save?path=note.txt", body=b"new")[0], 401)
        b, h = form(pin="1234")
        jreq("POST", "/tabs/sys/setpin", body=b, headers=h)     # idempotent if exists (403) — token via unlock
        c, j = jreq("POST", "/tabs/sys/unlock", body=b, headers=h)
        tok = j["token"]
        c, _ = jreq("POST", "/tabs/sys/save?path=note.txt", body=b"new", headers={"X-Term-Tok": tok})
        self.assertEqual(c, 200)
        with open(p) as f: self.assertEqual(f.read(), "new")
        self.assertEqual(os.stat(p).st_mode & 0o777, 0o640)     # mode survives the atomic replace


class TermLinks(unittest.TestCase):
    """v21: /tabs/stat + /tabs/dl back the clickable file-links in terminal output."""
    def test_dl_path_containment(self):
        self.assertEqual(T.dl_path(os.path.join(FILES, "sub")), os.path.join(FILES, "sub"))
        self.assertEqual(T.dl_path("~/note"), os.path.join(FILES, "note"))   # ~ expands to the home base
        self.assertIsNone(T.dl_path("/etc/passwd"))
        self.assertIsNone(T.dl_path("/tmpXYZ/x"))                            # sibling prefix of an allowed base
        if not os.path.realpath(FILES + "XYZ").startswith(                   # FILES-sibling probe is only
                os.path.realpath("/tmp") + os.sep):                          # meaningful when it's outside the
            self.assertIsNone(T.dl_path(FILES + "XYZ/x"))                    # /tmp base (CI + macOS tmpdirs)
        self.assertIsNone(T.dl_path("relative/x"))
        self.assertIsNone(T.dl_path(""))
        self.assertIsNone(T.dl_path("/" + "x" * 1024))
        self.assertIsNone(T.dl_path("/home/ubuntu/\x00etc"))                # embedded NUL -> no crash, no match
        self.assertIsNone(T.dl_path("~root/x"))                             # only ~/ expands, not ~user
        ln = os.path.join(FILES, "dl-esc")
        if not os.path.islink(ln): os.symlink("/etc/passwd", ln)             # symlink out of base
        self.assertIsNone(T.dl_path(ln))
        self.assertTrue((T.dl_path("/tmp") or "").endswith("tmp"))          # /tmp is an allowed base

    def test_stat_and_dl_http(self):
        p = os.path.join(FILES, "dl-probe.md")
        with open(p, "w") as f: f.write("dl-content")
        # stat is ALWAYS 200 (hover-probe, fires constantly): ok/file in the body,
        # never a status code. Containment failures surface as ok:false, not 403.
        c, j = jreq("GET", "/tabs/stat?path=" + p)
        self.assertEqual((c, j["ok"], j["file"], j["size"]), (200, True, True, 10))
        c, j = jreq("GET", "/tabs/stat?path=" + os.path.join(FILES, "sub"))
        self.assertEqual((c, j["ok"], j["file"]), (200, True, False))         # dirs: ok true, file false
        c, j = jreq("GET", "/tabs/stat?path=" + os.path.join(FILES, "ghost"))
        self.assertEqual((c, j["ok"]), (200, False))                         # missing: 200 ok:false
        c, j = jreq("GET", "/tabs/stat?path=/etc/passwd")
        self.assertEqual((c, j["ok"]), (200, False))                         # out-of-base: 200 ok:false
        c, body = req("GET", "/tabs/dl?path=" + p)
        self.assertEqual((c, body), (200, b"dl-content"))
        self.assertEqual(jreq("GET", "/tabs/dl?path=/etc/passwd")[0], 403)
        self.assertEqual(jreq("GET", "/tabs/dl?path=" + os.path.join(FILES, "sub"))[0], 404)  # dirs don't stream
        # attachment disposition (the whole point vs the inline /tabs/file)
        r = urllib.request.urlopen("http://127.0.0.1:%d/tabs/dl?path=%s" % (PORT, p), timeout=5)
        self.assertIn("attachment", r.headers.get("Content-Disposition", ""))


class Endpoints(unittest.TestCase):
    def test_tabs_degrades_gracefully_without_tmux(self):
        c, j = jreq("GET", "/tabs")                             # no tmux socket in the sandbox
        self.assertIn(c, (200, 503))
        if c == 503: self.assertIn("error", j)

    def test_stats_shape(self):
        c, j = jreq("GET", "/stats")
        self.assertEqual(c, 200)
        for k in ("uptime", "host", "location", "proxy_ok", "load"): self.assertIn(k, j)

    def test_unknown_routes(self):
        self.assertEqual(jreq("GET", "/nope")[0], 404)
        self.assertEqual(jreq("POST", "/nope")[0], 400)


if __name__ == "__main__":
    unittest.main(verbosity=1)
