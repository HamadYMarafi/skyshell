#!/usr/bin/env python3
import subprocess, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote_plus
ENV=dict(os.environ, DISPLAY=":99")
def xrandr_output():
    # The connected output name (VNC-0 under KasmVNC, "screen" under the old Xvfb).
    # Hardcoding it broke rotate on the 2026-07-06 Kasm migration — detect instead.
    try:
        out=subprocess.run(["xrandr"],capture_output=True,text=True,env=ENV,timeout=4).stdout
        for line in out.splitlines():
            p=line.split()
            if len(p)>=2 and p[1] in ("connected","unknown"): return p[0]
    except Exception: pass
    return "screen"
def focus():
    try:
        w=subprocess.run(["xdotool","search","--class","chrom"],capture_output=True,text=True,env=ENV,timeout=4).stdout.split()
        if w: subprocess.run(["xdotool","windowactivate","--sync",w[-1]],env=ENV,timeout=4)
    except Exception: pass
def key(*k): focus(); subprocess.run(["xdotool","key"]+list(k),env=ENV,timeout=6)
def typ(t): focus(); subprocess.run(["xdotool","type","--clearmodifiers","--delay","8",t],env=ENV,timeout=20)
def goto(u):
    focus(); subprocess.run(["xdotool","key","ctrl+l"],env=ENV,timeout=5)
    subprocess.run(["xdotool","type","--clearmodifiers","--delay","10",u],env=ENV,timeout=12)
    subprocess.run(["xdotool","key","Return"],env=ENV,timeout=5)
SAFE={"Return","Tab","BackSpace","Escape","Delete","space","Up","Down","Left","Right","Home","End","Page_Up","Page_Down"}
class H(BaseHTTPRequestHandler):
    def ok(self): self.send_response(200);self.send_header("Content-Type","application/json");self.end_headers();self.wfile.write(b'{"ok":true}')
    def do_POST(self):
        pr=urlparse(self.path); qs=parse_qs(pr.query); p=pr.path
        if p=="/bctl/goto":
            u=unquote_plus((qs.get("url") or [""])[0]).strip()
            if u and not u.startswith(("http://","https://","about:")): u="https://"+u
            if u: goto(u)
        elif p=="/bctl/back": key("alt+Left")
        elif p=="/bctl/forward": key("alt+Right")
        elif p=="/bctl/reload": key("ctrl+r")
        elif p=="/bctl/home": goto("https://ipinfo.io/json")
        elif p=="/bctl/type":
            t=unquote_plus((qs.get("text") or [""])[0])
            if t: typ(t)
        elif p=="/bctl/key":
            k=(qs.get("key") or [""])[0]
            if k in SAFE: key(k)
        elif p=="/bctl/orient":
            mode=(qs.get("mode") or [""])[0]
            m="port" if mode=="portrait" else "land"; dw,dh=(720,1280) if mode=="portrait" else (1280,800)
            subprocess.run(["xrandr","--output",xrandr_output(),"--mode",m],env=ENV,timeout=6)
            try:
                w=subprocess.run(["xdotool","search","--class","chrom"],capture_output=True,text=True,env=ENV,timeout=4).stdout.split()
                if w: subprocess.run(["xdotool","windowsize",w[-1],str(dw),str(dh),"windowmove",w[-1],"0","0"],env=ENV,timeout=5)
            except Exception: pass
        elif p=="/bctl/scroll":
            d=(qs.get("dir") or ["down"])[0]
            btn="4" if d=="up" else "5"   # 4=wheel up, 5=wheel down
            n=(qs.get("n") or ["7"])[0]; n=n if n.isdigit() else "4"
            try: subprocess.run(["xdotool","mousemove","360","450","click","--repeat",n,btn],env=ENV,timeout=6)
            except Exception: pass
        elif p=="/bctl/fit":   # size the chrome window to the CURRENT display (kasm resize=remote)
            try:
                g=subprocess.run(["xdotool","getdisplaygeometry"],capture_output=True,text=True,env=ENV,timeout=4).stdout.split()
                w=subprocess.run(["xdotool","search","--class","chrom"],capture_output=True,text=True,env=ENV,timeout=4).stdout.split()
                if len(g)>=2 and w: subprocess.run(["xdotool","windowsize",w[-1],g[0],g[1],"windowmove",w[-1],"0","0"],env=ENV,timeout=5)
            except Exception: pass
        elif p=="/bctl/ping": pass   # latency probe for the HUD chip
        else: self.send_response(404);self.end_headers();return
        self.ok()
    def log_message(self,*a): pass
ThreadingHTTPServer(("127.0.0.1",7692),H).serve_forever()
