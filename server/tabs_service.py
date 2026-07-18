#!/usr/bin/env python3
import json, subprocess, time, os, stat, mimetypes, hashlib, hmac, secrets, shutil, tempfile, re, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote_plus
# Env overrides exist so a STAGING instance can run beside prod (different port,
# throwaway pin file / sandboxes) — defaults are the production values.
BIND=("127.0.0.1",int(os.environ.get("TERM_TABS_PORT","7691"))); SOCK="/tmp/tmux-1001/default"; SESS="main"
TMUX=["tmux","-S",SOCK]
FILES_BASE=os.path.realpath(os.environ.get("TERM_TABS_FILES_BASE","/home/ubuntu"))
LIB_BASE=os.path.realpath(os.environ.get("TERM_TABS_LIB_BASE","/home/ubuntu/files"))
try: os.makedirs(LIB_BASE,exist_ok=True)
except Exception: pass
PIN_FILE=os.environ.get("TERM_TABS_PIN_FILE","/home/ubuntu/.term-ui-pin")
LOCK=threading.Lock()           # guards TOKENS + PIN_FAILS (ThreadingHTTPServer => concurrent handlers)
TOKENS={}                       # hex token -> expiry epoch (15min TTL, see _new_token)
PIN_FAILS={"n":0,"until":0}     # brute-force lockout state for /tabs/sys/unlock
def tmux(a,t=5):
    try:
        p=subprocess.run(TMUX+a,capture_output=True,text=True,timeout=t); return p.returncode,p.stdout,p.stderr
    except Exception as e: return 1,"",str(e)
def windows():
    # Injection-proof framing WITHOUT control bytes (tmux octal-escapes \x1f in -F
    # output, which silently emptied the list): the three fixed fields — digits and
    # 0/1 flags that can never contain a tab — come FIRST, the free-text name comes
    # LAST, and split(maxsplit=3) keeps any tabs inside the name intact.
    fmt="#{window_index}\t#{window_active}\t#{window_activity_flag}\t#{window_name}"
    rc,out,err=tmux(["list-windows","-t",SESS,"-F",fmt])
    if rc!=0: return None,err.strip()
    w=[]
    for ln in out.splitlines():
        p=ln.split("\t",3)
        if len(p)<4 or not p[0].isdigit(): continue
        w.append({"index":int(p[0]),"name":p[3],"active":p[1]=="1","activity":p[2]=="1"})
    return w,None
def uptime_pretty():
    rc,out,_=tmux(["display-message","-p","x"]) # noop keepalive
    try:
        p=subprocess.run(["uptime","-p"],capture_output=True,text=True,timeout=3)
        return p.stdout.strip() or "up"
    except Exception: return "up"
def loadavg():
    try:
        with open("/proc/loadavg") as f: return f.read().split()[0]
    except Exception: return "?"
def host():
    try:
        with open("/etc/hostname") as f: return f.read().strip()
    except Exception: return "server"
PROXY_URL=os.environ.get("TERM_TABS_PROXY","http://127.0.0.1:8899")
PROXY_STATE={"ok":True,"checked":0.0,"geo":None}   # honest /stats: refreshed by _proxy_probe_loop (main-guard only,
                                                   # so imports/tests never touch the network); True until first probe.
                                                   # geo={"city","country","ip","checked"} — the /stats "location" used
                                                   # to be the hardcoded string "London"; now it's this live check.
def _proxy_probe_loop():
    import urllib.request, json as _json
    op=urllib.request.build_opener(urllib.request.ProxyHandler({"http":PROXY_URL,"https":PROXY_URL}))
    geo_next=0.0
    while True:
        ok=False
        try:
            with op.open("http://connectivitycheck.gstatic.com/generate_204",timeout=4) as r:
                ok=r.status in (200,204)
        except Exception: ok=False
        with LOCK: PROXY_STATE["ok"]=ok; PROXY_STATE["checked"]=time.time()
        if ok and time.time()>=geo_next:
            # Egress identity every ~5 min (rate-limit friendly): reachability alone
            # can't tell a residential London exit from a silent fallback route.
            geo_next=time.time()+300
            try:
                with op.open("https://ipinfo.io/json",timeout=8) as r:
                    d=_json.loads(r.read().decode("utf-8","replace"))
                g={"city":d.get("city"),"country":d.get("country"),"ip":d.get("ip"),"checked":int(time.time())}
                with LOCK: PROXY_STATE["geo"]=g
            except Exception: pass          # keep last-known geo; its "checked" stamp shows staleness
        elif not ok:
            with LOCK: PROXY_STATE["geo"]=None   # route down — a remembered city would lie
        time.sleep(60)
def safe_path(rel):
    # Containment: os.path.join ignores its base arg when rel is absolute (the
    # classic bypass), but the startswith(base+sep) check below still rejects
    # the result since it won't be under FILES_BASE. The "+os.sep" also guards
    # the sibling-prefix footgun (e.g. /home/ubuntuXYZ must NOT pass as a child
    # of /home/ubuntu).
    target=os.path.realpath(os.path.join(FILES_BASE,rel or ""))
    if target==FILES_BASE or target.startswith(FILES_BASE+os.sep): return target
    return None
def list_entries(target):
    out=[]
    for nm in os.listdir(target):
        try: st=os.stat(os.path.join(target,nm))
        except OSError: continue          # unreadable / racing delete — skip, don't fail the listing
        out.append({"name":nm,"dir":stat.S_ISDIR(st.st_mode),"size":st.st_size,"mtime":int(st.st_mtime)})
    # dirs before files; within each group, dotfiles after normal entries; then case-insensitive name
    out.sort(key=lambda e:(0 if e["dir"] else 1, e["name"].startswith("."), e["name"].lower()))
    return out
def _new_token():
    tok=secrets.token_hex(16)
    with LOCK: TOKENS[tok]=time.time()+900        # 15 minutes
    return tok
def _valid_token(tok):
    now=time.time()
    with LOCK:                                    # purge+lookup atomically — unlocked iteration raced inserts
        for k in [k for k,exp in TOKENS.items() if exp<now]: del TOKENS[k]
        return bool(tok) and tok in TOKENS
def _safe_name(name):
    # Lib endpoints are rooted at /home/ubuntu/files, NOT inside safe_path's
    # FILES_BASE (=/home/ubuntu) — a realpath+startswith check would happily let
    # ".." escape into sibling dirs of files/, so basenames are hard-blocked instead.
    # Control chars (incl. CR/LF) are rejected too: they'd reach response headers.
    if not name or name.startswith(".") or "/" in name or ".." in name or "\\" in name or "\x00" in name:
        return None
    if any(ord(c)<32 or ord(c)==127 for c in name): return None
    return name
def _safe_relpath(path):
    # Folder uploads send dir="Top/sub/deep" — every segment must independently
    # pass _safe_name (blocks "..", dotfiles, backslash, control chars, empty),
    # so the joined path can only land under LIB_BASE. Depth/length capped.
    if not path or len(path)>900: return None
    segs=path.split("/")
    if len(segs)>32: return None
    for s in segs:
        if _safe_name(s) is None: return None
    return "/".join(segs)
def _dispo(name):
    # Content-Disposition hygiene: http.server writes header values verbatim, so
    # quotes/backslashes/control bytes in a filename could break (or inject into)
    # the response head. Legacy files predating _safe_name's control-char rule
    # can still carry them — neutralise at the output edge.
    return re.sub(r'[\r\n"\\\x00-\x1f\x7f]',"_",name)
def _pin_state():
    return os.path.exists(PIN_FILE)
def _set_pin(pin):
    salt=secrets.token_hex(8)
    h=hashlib.sha256((salt+pin).encode()).hexdigest()
    fd=os.open(PIN_FILE,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,"w") as f: f.write(salt+"$"+h)
def _check_pin(pin):
    try:
        with open(PIN_FILE) as f: data=f.read()
    except Exception: return False
    salt,_,h=data.partition("$")
    calc=hashlib.sha256((salt+pin).encode()).hexdigest()
    return hmac.compare_digest(calc,h)
class H(BaseHTTPRequestHandler):
    def _s(self,c,pl):
        b=json.dumps(pl).encode(); self.send_response(c)
        self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b)))
        self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(b)
    def _params(self):
        # Merged query-string + urlencoded-body params (body wins). The PIN moved to
        # the request BODY so it never lands in the nginx access log; ?pin= is kept
        # for backward compatibility. NOT used by _sys_save (its body is file content).
        qd=parse_qs(urlparse(self.path).query)
        try:
            ctype=(self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            length=int(self.headers.get("Content-Length",0) or 0)
            if ctype=="application/x-www-form-urlencoded" and 0<length<=4096:
                qd.update(parse_qs(self.rfile.read(length).decode("utf-8","replace")))
        except Exception: pass
        return qd
    def _tok(self,qd):
        # Token travels in a header (out of the access log); ?tok= still accepted —
        # the client's window.open() streams can't set headers.
        return self.headers.get("X-Term-Tok") or (qd.get("tok") or [""])[0]
    def _files(self,q):
        try:
            qd=parse_qs(q)
            if not _valid_token(self._tok(qd)): self._s(401,{"err":"locked"}); return
            rel=(qd.get("path") or [""])[0]
            target=safe_path(rel)
            if target is None: self._s(403,{"err":"forbidden"}); return
            if not os.path.isdir(target): self._s(404,{"err":"not found"}); return
            relnorm=os.path.relpath(target,FILES_BASE)
            if relnorm==".": relnorm=""
            self._s(200,{"path":relnorm,"entries":list_entries(target)})
        except (BrokenPipeError,ConnectionResetError): pass       # client hung up — nothing to do
        except Exception as e:
            try: self._s(500,{"err":str(e)})
            except Exception: pass
    def _file(self,q):
        try:
            qd=parse_qs(q)
            if not _valid_token(self._tok(qd)): self._s(401,{"err":"locked"}); return
            rel=(qd.get("path") or [""])[0]
            target=safe_path(rel)
            if target is None: self._s(403,{"err":"forbidden"}); return
            if not os.path.isfile(target): self._s(404,{"err":"not found"}); return
            size=os.path.getsize(target)
            ctype=mimetypes.guess_type(target)[0] or "application/octet-stream"
            with open(target,"rb") as f:
                self.send_response(200)
                self.send_header("Content-Type",ctype); self.send_header("Content-Length",str(size))
                self.send_header("Content-Disposition",'inline; filename="%s"' % _dispo(os.path.basename(target)))
                self.end_headers()
                while True:
                    chunk=f.read(65536)
                    if not chunk: break
                    self.wfile.write(chunk)
        except (BrokenPipeError,ConnectionResetError): pass       # client disconnected mid-stream — normal
        except Exception as e:
            try: self._s(500,{"err":str(e)})
            except Exception: pass
    def _lib_file(self,q):
        try:
            name=(parse_qs(q).get("name") or [""])[0]
            nm=_safe_name(name)
            if nm is None: self._s(403,{"err":"forbidden"}); return
            target=os.path.join(LIB_BASE,nm)
            if not os.path.isfile(target): self._s(404,{"err":"not found"}); return
            size=os.path.getsize(target)
            ctype=mimetypes.guess_type(target)[0] or "application/octet-stream"
            with open(target,"rb") as f:
                self.send_response(200)
                self.send_header("Content-Type",ctype); self.send_header("Content-Length",str(size))
                self.send_header("Content-Disposition",'inline; filename="%s"' % _dispo(os.path.basename(target)))
                self.end_headers()
                while True:
                    chunk=f.read(65536)
                    if not chunk: break
                    self.wfile.write(chunk)
        except (BrokenPipeError,ConnectionResetError): pass       # client disconnected mid-stream — normal
        except Exception as e:
            try: self._s(500,{"err":str(e)})
            except Exception: pass
    def _sys_state(self):
        try:
            with LOCK: until=PIN_FAILS["until"]
            now=time.time()
            # "retry" is RELATIVE seconds — the absolute epoch stays for old clients,
            # but relative is immune to client/server clock skew.
            self._s(200,{"set":_pin_state(),"locked_until":until if until>now else 0,
                         "retry":int(max(0,until-now))})
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e:
            try: self._s(500,{"err":str(e)})
            except Exception: pass
    def _lib_list(self):
        try:
            out=[]
            for nm in os.listdir(LIB_BASE):
                if nm.startswith("."): continue          # uploads can't create dotfiles; hides in-flight .tmp-* spool files
                p=os.path.join(LIB_BASE,nm)
                try: st=os.stat(p)
                except OSError: continue           # unreadable / racing delete — skip, don't fail the listing
                if stat.S_ISDIR(st.st_mode): continue    # files only
                out.append({"name":nm,"dir":False,"size":st.st_size,"mtime":int(st.st_mtime)})
            out.sort(key=lambda e:e["name"].lower())
            self._s(200,{"entries":out})
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e:
            try: self._s(500,{"err":str(e)})
            except Exception: pass
    def _sys_setpin(self):
        try:
            pin=(self._params().get("pin") or [""])[0]
            if _pin_state(): self._s(403,{"err":"exists"}); return
            if not re.fullmatch(r"\d{4}",pin): self._s(400,{"err":"bad pin"}); return
            _set_pin(pin)
            self._s(200,{"ok":True,"token":_new_token()})
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e:
            try: self._s(500,{"err":str(e)})
            except Exception: pass
    def _sys_unlock(self):
        try:
            pin=(self._params().get("pin") or [""])[0]
            now=time.time()
            with LOCK: locked_for=PIN_FAILS["until"]-now
            if locked_for>0: self._s(429,{"err":"locked","retry":int(locked_for)}); return
            if not re.fullmatch(r"\d{4}",pin): self._s(400,{"err":"bad pin"}); return
            if _check_pin(pin):
                with LOCK: PIN_FAILS["n"]=0; PIN_FAILS["until"]=0
                self._s(200,{"ok":True,"token":_new_token()})
            else:
                with LOCK:
                    PIN_FAILS["n"]+=1
                    locked=PIN_FAILS["n"]>=5
                    if locked: PIN_FAILS["until"]=time.time()+120; PIN_FAILS["n"]=0
                    left=5-PIN_FAILS["n"]
                if locked: self._s(429,{"err":"locked","retry":120})   # 5th miss locks immediately — don't report a phantom attempt
                else: self._s(401,{"err":"bad","left":left})
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e:
            try: self._s(500,{"err":str(e)})
            except Exception: pass
    def _sys_save(self,q):
        try:
            qd=parse_qs(q)
            if not _valid_token(self._tok(qd)): self._s(401,{"err":"locked"}); return
            rel=(qd.get("path") or [""])[0]
            target=safe_path(rel)
            if target is None: self._s(403,{"err":"forbidden"}); return
            if not os.path.isfile(target): self._s(404,{"err":"not found"}); return
            length=int(self.headers.get("Content-Length",0) or 0)
            if length>1_000_000: self._s(413,{"err":"too large"}); return
            body=self.rfile.read(length)
            mode=os.stat(target).st_mode
            fd,tmp=tempfile.mkstemp(dir=os.path.dirname(target))
            with os.fdopen(fd,"wb") as f: f.write(body)
            os.chmod(tmp,mode & 0o777)
            os.replace(tmp,target)
            self._s(200,{"ok":True,"size":len(body)})
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e:
            try: self._s(500,{"err":str(e)})
            except Exception: pass
    def _lib_upload(self,q):
        tmp=None
        try:
            qd=parse_qs(q)
            name=(qd.get("name") or [""])[0]
            d=(qd.get("dir") or [""])[0]          # optional: folder drops land files in a subdir
            nm=_safe_name(name)
            if nm is None: self._s(400,{"err":"bad name"}); return
            dest=LIB_BASE
            if d:
                rp=_safe_relpath(d)
                if rp is None: self._s(400,{"err":"bad dir"}); return
                dest=os.path.join(LIB_BASE,rp); os.makedirs(dest,exist_ok=True)
            length=int(self.headers.get("Content-Length",0) or 0)
            if length>200_000_000: self._s(413,{"err":"too large"}); return
            # Stream to a hidden spool file in 64KB chunks — the old read(length)
            # held up to 200MB in RAM per in-flight upload. finally removes the
            # spool on ANY failure, so aborted uploads can't litter the library.
            fd,tmp=tempfile.mkstemp(prefix=".tmp-",dir=LIB_BASE)
            remaining=length
            with os.fdopen(fd,"wb") as f:
                while remaining>0:
                    chunk=self.rfile.read(min(65536,remaining))
                    if not chunk: break
                    f.write(chunk); remaining-=len(chunk)
            if remaining>0: self._s(400,{"err":"incomplete upload"}); return
            final=nm
            if os.path.exists(os.path.join(dest,final)):
                base,dot,ext=nm.rpartition(".")
                i=2
                while True:
                    cand=(base+" ("+str(i)+")."+ext) if dot else (nm+" ("+str(i)+")")
                    if not os.path.exists(os.path.join(dest,cand)): final=cand; break
                    i+=1
            os.replace(tmp,os.path.join(dest,final)); tmp=None
            self._s(200,{"ok":True,"name":final})
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e:
            try: self._s(500,{"err":str(e)})
            except Exception: pass
        finally:
            if tmp:
                try: os.unlink(tmp)
                except Exception: pass
    def _lib_mkdir(self,q):
        # Folder drops: ?name=Top creates ONE collision-resolved root ("Top (2)")
        # and returns the final name — so a whole dropped tree collides once, not
        # per-file; ?path=Top/sub/empty mkdir-p's a validated nested dir (empty
        # subdirectories inside a dropped folder have no upload to create them).
        try:
            qd=parse_qs(q)
            name=(qd.get("name") or [""])[0]; path=(qd.get("path") or [""])[0]
            if name:
                nm=_safe_name(name)
                if nm is None: self._s(400,{"err":"bad name"}); return
                final=nm; i=2
                while os.path.exists(os.path.join(LIB_BASE,final)):
                    final=nm+" ("+str(i)+")"; i+=1
                os.makedirs(os.path.join(LIB_BASE,final))
                self._s(200,{"ok":True,"name":final})
            elif path:
                rp=_safe_relpath(path)
                if rp is None: self._s(400,{"err":"bad path"}); return
                os.makedirs(os.path.join(LIB_BASE,rp),exist_ok=True)
                self._s(200,{"ok":True,"path":rp})
            else: self._s(400,{"err":"bad name"})
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e:
            try: self._s(500,{"err":str(e)})
            except Exception: pass
    def _lib_delete(self,q):
        try:
            name=(parse_qs(q).get("name") or [""])[0]
            nm=_safe_name(name)
            if nm is None: self._s(400,{"err":"bad name"}); return
            target=os.path.join(LIB_BASE,nm)
            if not os.path.exists(target): self._s(404,{"err":"not found"}); return
            # Real dirs (folder uploads) delete recursively — _safe_name keeps the
            # target a direct child of LIB_BASE. Symlinks always unlink (rmtree
            # would refuse; unlink removes the link, never what it points at).
            if os.path.isdir(target) and not os.path.islink(target): shutil.rmtree(target)
            else: os.unlink(target)
            self._s(200,{"ok":True})
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as e:
            try: self._s(500,{"err":str(e)})
            except Exception: pass
    def do_GET(self):
        pr=urlparse(self.path); pth=pr.path
        if pth=="/tabs":
            w,e=windows(); self._s(503 if w is None else 200, {"error":e} if w is None else w)
        elif pth=="/stats":
            with LOCK: pok=PROXY_STATE["ok"]; geo=PROXY_STATE["geo"]
            self._s(200,{"uptime":uptime_pretty(),"host":host(),"location":((geo or {}).get("city") or "unknown"),"proxy_ok":pok,"geo":geo,"load":loadavg()})
        elif pth=="/tabs/files": self._files(pr.query)
        elif pth=="/tabs/file": self._file(pr.query)
        elif pth=="/tabs/sys/state": self._sys_state()
        elif pth=="/tabs/lib": self._lib_list()
        elif pth=="/tabs/lib/file": self._lib_file(pr.query)
        else: self._s(404,{"error":"not found"})
    def do_POST(self):
        pr=urlparse(self.path); qs=parse_qs(pr.query); idx=(qs.get("index") or [""])[0]
        if pr.path=="/tabs/select" and idx.isdigit():
            rc,_,e=tmux(["select-window","-t",f"{SESS}:{idx}"]); self._s(200 if rc==0 else 500,{"ok":rc==0,"error":e.strip()})
        elif pr.path=="/tabs/new":
            rc,_,e=tmux(["new-window","-t",SESS]); self._s(200 if rc==0 else 500,{"ok":rc==0,"error":e.strip()})
        elif pr.path=="/tabs/rename" and idx.isdigit():
            nm=unquote_plus((qs.get("name") or [""])[0])
            # control chars (incl. \t \x1f) would corrupt the separator-framed list format
            nm=re.sub(r"[\x00-\x1f\x7f]"," ",nm)[:40].strip() or "session"
            rc,_,e=tmux(["rename-window","-t",f"{SESS}:{idx}",nm]); self._s(200 if rc==0 else 500,{"ok":rc==0,"error":e.strip()})
        elif pr.path=="/tabs/close" and idx.isdigit():
            rc,_,e=tmux(["kill-window","-t",f"{SESS}:{idx}"]); self._s(200 if rc==0 else 500,{"ok":rc==0,"error":e.strip()})
        elif pr.path=="/tabs/sys/setpin": self._sys_setpin()
        elif pr.path=="/tabs/sys/unlock": self._sys_unlock()
        elif pr.path=="/tabs/sys/save": self._sys_save(pr.query)
        elif pr.path=="/tabs/lib/upload": self._lib_upload(pr.query)
        elif pr.path=="/tabs/lib/mkdir": self._lib_mkdir(pr.query)
        elif pr.path=="/tabs/lib/delete": self._lib_delete(pr.query)
        else: self._s(400,{"error":"bad request"})
    def log_message(self,*a): pass
if __name__=="__main__":
    if PROXY_URL: threading.Thread(target=_proxy_probe_loop,daemon=True).start()
    ThreadingHTTPServer(BIND,H).serve_forever()
