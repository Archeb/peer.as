#!/usr/bin/env python3
"""peer.as / dn42.peer.as 的 **OG 大图渲染器** —— 跑在 CN VPS 上,Caddy 反代 `/og/*` 到本服务。

为什么放这:CF Pages Function 有 CPU/包体/字体(CJK)限制,而这台真实服务器无此约束。
社交平台(Discord/Telegram/Twitter)只认 PNG/JPEG 的 og:image,故在此把 ASN/AS-SET 卡片
栅格化成 1200×630 PNG,让分享链接一眼看到 ASN/前缀信息。中文用 Noto Sans CJK SC。

数据:直接读本机 `/var/www/cn/data` 下 deploy.sh 已同步的小 JSON(asn.json/asset.json/asnames.json),
**不碰 parquet**。渲染结果按实体+数据版本(源 JSON mtime)磁盘缓存,二次命中近乎零成本。

路由(由 CF Function 的 og:image 指过来):
  GET /og/asn.png?n=<asn>
  GET /og/asset.png?k=<url-encoded set_key>
  GET /og/home.png            品牌通用卡(入口页用)
"""
import datetime
import io
import json
import os
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageDraw, ImageFont

# CACHE 必须在 rsync 同步树(/var/www/cn)之外 —— 否则 deploy.sh 的 `rsync --delete` 会把它清掉。
# 用 systemd CacheDirectory(/var/cache/og-renderer, 属 www-data)。
DATA = os.environ.get("OG_DATA", "/var/www/cn/data")
CACHE = os.environ.get("OG_CACHE", "/var/cache/og-renderer")
PORT = int(os.environ.get("OG_PORT", "8092"))
W, H = 1200, 630

BG = (10, 14, 21)       # #0a0e15  与站点深色主题一致
FG = (221, 230, 240)    # #dde6f0
MUTED = (143, 158, 178)
ACCENT = (91, 157, 255) # #5b9dff
CARD = (18, 24, 38)
LINE = (30, 38, 56)

try:
    os.makedirs(CACHE, exist_ok=True)
except OSError:
    pass  # 缓存目录不可建 -> 降级为不缓存(render 内写缓存也都各自 try),不让服务起不来


# ── 字体:拉丁用 Noto Sans,中文用 Noto Sans CJK SC(经 fc-match 取确切 file+index)──────────
def _fc(pattern, fallback):
    try:
        out = subprocess.check_output(["fc-match", "-f", "%{file}:%{index}", pattern],
                                      text=True, stderr=subprocess.DEVNULL).strip()
        f, i = out.rsplit(":", 1)
        if f:
            return f, int(i or 0)
    except Exception:
        pass
    return fallback

LATIN_B = "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"
LATIN_R = "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"
CJK_B = _fc("Noto Sans CJK SC:weight=bold", ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 2))
CJK_R = _fc("Noto Sans CJK SC", ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2))

_fonts = {}
def _font(key, size):
    k = (key, size)
    if k in _fonts:
        return _fonts[k]
    if key == "lb":   f = ImageFont.truetype(LATIN_B, size)
    elif key == "lr": f = ImageFont.truetype(LATIN_R, size)
    elif key == "cb": f = ImageFont.truetype(CJK_B[0], size, index=CJK_B[1])
    else:             f = ImageFont.truetype(CJK_R[0], size, index=CJK_R[1])
    _fonts[k] = f
    return f

_CJK = re.compile(r"[⺀-鿿豈-﫿＀-￯　-〿]")
def font_for(s, bold, size):
    cjk = bool(_CJK.search(s or ""))
    return _font(("cb" if cjk else "lb") if bold else ("cr" if cjk else "lr"), size)


# ── 数据(按 mtime 缓存,数据刷新自动失效)────────────────────────────────────────────────
_lock = threading.Lock()
_cache = {}
def load(name):
    p = os.path.join(DATA, name)
    m = os.path.getmtime(p)
    with _lock:
        c = _cache.get(name)
        if c and c[0] == m:
            return c[1]
        obj = json.load(open(p, encoding="utf-8"))
        _cache[name] = (m, obj)
        return obj

def data_mtime():
    t = 0.0
    for n in ("seo/asn.json", "seo/asset.json", "asnames.json", "meta.json"):
        try:
            t = max(t, os.path.getmtime(os.path.join(DATA, n)))
        except OSError:
            pass
    return t


# ── 绘图 ───────────────────────────────────────────────────────────────────────────────
def _base():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # 左上品牌(.AS 用 accent)
    d.text((64, 54), "PEER", font=_font("lb", 46), fill=FG)
    w = d.textlength("PEER", font=_font("lb", 46))
    d.text((64 + w, 54), ".AS", font=_font("lb", 46), fill=ACCENT)
    # 右上小标签
    tag = "BGP · IP · ASN Insights"
    tw = d.textlength(tag, font=_font("lr", 26))
    d.text((W - 64 - tw, 66), tag, font=_font("lr", 26), fill=MUTED)
    return img, d

def _truncate(d, s, fnt, maxw):
    if d.textlength(s, font=fnt) <= maxw:
        return s
    while s and d.textlength(s + "…", font=fnt) > maxw:
        s = s[:-1]
    return s + "…"

def _fmt(n):
    try:
        return f"{int(n):,}"
    except Exception:
        return str(n)

def data_label():
    # 右下角时间 = 生成时所依赖的**最新采集点快照时刻**(meta.collectors[].snap_ts 取最大;
    # 各采集点发布周期不同故时龄不齐,取最新代表"数据至少新到这个时刻")。缺则回退 generated_ts。
    try:
        meta = load("meta.json")
        cols = meta.get("collectors") or []
        ts = max((c.get("snap_ts") or 0) for c in cols) if cols else 0
        ts = ts or meta.get("generated_ts") or 0
        if not ts:
            return ""
        return datetime.datetime.fromtimestamp(int(ts), datetime.timezone.utc).strftime(
            "Data as of %Y-%m-%d %H:%M UTC")
    except Exception:
        return ""

def _stamp(d):
    s = data_label()
    if not s:
        return
    f = _font("lr", 24)
    w = d.textlength(s, font=f)
    d.text((W - 64 - w, H - 52), s, font=f, fill=MUTED)

def _pill(d, x, y, label, value, vcolor):
    lf, vf = _font("lr", 26), _font("lb", 48)
    d.text((x, y), label, font=lf, fill=MUTED)
    d.text((x, y + 34), value, font=vf, fill=vcolor)
    return max(d.textlength(label, font=lf), d.textlength(value, font=vf))

def render_asn(asn):
    counts = load("seo/asn.json").get(asn)
    if counts is None and asn not in load("asnames.json"):
        return None
    name = load("asnames.json").get(asn, "")
    v4 = counts[0] if counts else 0
    v6 = counts[1] if counts else 0
    peers = counts[2] if counts and len(counts) > 2 else 0
    img, d = _base()
    d.text((64, 132), f"AS{asn}", font=_font("lb", 150), fill=FG)
    if name:
        nf = font_for(name, True, 60)
        d.text((64, 300), _truncate(d, name, nf, W - 128), font=nf, fill=ACCENT)
    y = 408
    gap = 80
    x = 64
    x += _pill(d, x, y, "IPv4 prefixes", _fmt(v4), FG) + gap
    x += _pill(d, x, y, "IPv6 prefixes", _fmt(v6), FG) + gap
    _pill(d, x, y, "Peers", _fmt(peers), ACCENT)
    _stamp(d)
    return img

def render_asset(key):
    a = load("seo/asset.json").get(key)
    if a is None:
        return None
    img, d = _base()
    d.text((64, 132), "AS-SET", font=_font("lb", 40), fill=MUTED)
    kf = font_for(key, True, 92)
    d.text((64, 186), _truncate(d, key, kf, W - 128), font=kf, fill=FG)
    descr = a.get("d") or ""
    if descr:
        df = font_for(descr, False, 34)
        d.text((64, 312), _truncate(d, descr, df, W - 128), font=df, fill=MUTED)
    y = 408
    x = _pill(d, 64, y, "Direct members", _fmt(a.get("c", 0)), ACCENT)
    if a.get("s"):
        _pill(d, 64 + x + 80, y, "Registered in", str(a["s"]), FG)
    _stamp(d)
    return img

def render_home():
    img, d = _base()
    d.text((64, 188), "Global BGP, IP &", font=_font("lb", 96), fill=FG)
    d.text((64, 296), "ASN Insights", font=_font("lb", 96), fill=ACCENT)
    sub = "Look up any IP prefix, ASN, AS_PATH, origin & peering"
    d.text((64, 430), sub, font=_font("lr", 36), fill=MUTED)
    _stamp(d)
    return img


# ── HTTP ───────────────────────────────────────────────────────────────────────────────
def _safe(s):
    return re.sub(r"[^A-Za-z0-9._:-]", "_", s)[:120]

def render(kind, arg):
    if kind == "asn":
        if not re.fullmatch(r"\d{1,10}", arg or ""):
            return None, None
        cf, img = f"asn-{arg}.png", lambda: render_asn(arg)
    elif kind == "asset":
        cf, img = f"asset-{_safe(arg)}.png", lambda: render_asset(arg)
    elif kind == "home":
        cf, img = "home.png", render_home
    else:
        return None, None
    path = os.path.join(CACHE, cf)
    # 命中缓存且不旧于源数据 -> 直接返回
    try:
        if os.path.getmtime(path) >= data_mtime():
            with open(path, "rb") as fh:
                return fh.read(), path
    except OSError:
        pass
    im = img()
    if im is None:
        return None, None
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    data = buf.getvalue()
    try:
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except OSError:
        pass
    return data, path


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass  # 交给 systemd/journald 之外不额外刷日志

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", cache=False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if cache:
            self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/og/health":
            return self._send(200, b"ok")
        q = parse_qs(u.query)
        if u.path == "/og/asn.png":
            kind, arg = "asn", (q.get("n", [""])[0])
        elif u.path == "/og/asset.png":
            kind, arg = "asset", (q.get("k", [""])[0])
        elif u.path == "/og/home.png":
            kind, arg = "home", ""
        else:
            return self._send(404, b"not found")
        try:
            data, _ = render(kind, arg)
        except Exception as e:  # noqa  渲染异常 -> 404(分享方无图,页面文字预览仍在)
            return self._send(500, str(e).encode())
        if not data:
            return self._send(404, b"no such entity")
        self._send(200, data, "image/png", cache=True)


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"og-renderer on 127.0.0.1:{PORT}  DATA={DATA} CACHE={CACHE}", flush=True)
    print(f"  latin={LATIN_B}\n  cjk={CJK_B}", flush=True)
    srv.serve_forever()
