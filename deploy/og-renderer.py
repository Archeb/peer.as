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
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageDraw, ImageFont

# CACHE 必须在 rsync 同步树(/var/www/cn)之外 —— 否则 deploy.sh 的 `rsync --delete` 会把它清掉。
# 用 systemd CacheDirectory(/var/cache/og-renderer, 属 www-data)。
DATA = os.environ.get("OG_DATA", "/var/www/cn/data")
CACHE = os.environ.get("OG_CACHE", "/var/cache/og-renderer")
# 随服务一起部署的静态资产(rdap-bootstrap.json + og-icons/*.png), 默认取脚本同目录(/opt/og-renderer)。
ASSETS = os.environ.get("OG_ASSETS", os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("OG_PORT", "8092"))
W, H = 1200, 630

BG = (10, 14, 21)       # #0a0e15  与站点深色主题一致
FG = (221, 230, 240)    # #dde6f0
MUTED = (143, 158, 178)
ACCENT = (91, 157, 255) # #5b9dff
SIGNAL = (248, 113, 113) # #f87171  abuse 联系人高亮(红)
CARD = (18, 24, 38)
LINE = (30, 38, 56)

# ── ASN 卡右栏 WHOIS: RDAP autnum 注册联系人(注册人/管理技术/滥用举报…)─────────────────────
# og-renderer 跑在能上网的真实 VPS, 渲染 ASN 卡时实时查一次 RDAP(复用前端同款 rdap-bootstrap.json
# 定位 RIR base), 取顶层(+一层嵌套)entity 的 roles+name。**独立长 TTL 磁盘缓存**(whois 极少变),
# 与 og 图本身的 data_mtime 缓存分开 —— 故数据每次刷新重渲染 og 图时, whois 直接读缓存不重查。
# 失败/查不到 → 右栏不画(优雅降级, 文字卡照出)。peeras only(dn42 无 og 渲染器)。
WH_X = 720              # 右栏起点 x; 左栏(AS 号/名称/pills)收敛到此左侧
RDAP_TIMEOUT = 5
RDAP_TTL = 30 * 86400     # 命中(有联系人): 缓 30 天
RDAP_NEG_TTL = 2 * 86400  # 未命中/失败的负缓存: 2 天后再试(不卡死)
# RDAP role -> 简短英文标签(与前端 i18n en 对齐); 多角色用 ' · ' 连接。未知角色原样。
ROLE_LABEL = {"registrant": "registrant", "administrative": "admin", "technical": "tech",
              "abuse": "abuse", "registrar": "registrar", "noc": "NOC", "reseller": "reseller",
              "routing": "routing", "proxy": "proxy", "notifications": "notify"}

# ── 左下角国旗 ───────────────────────────────────────────────────────────────────────────
# ASN 国家取自管线 seo/asn_cc.json(autnums 注册国 CC, 5 个 RIR 全覆盖、稳定; **不查 RDAP/WHOIS** —— RDAP
# 仅 APNIC 返 country, 其余 RIR 要 WHOIS 且 AFRINIC/RIPE 还得从关联组织推断, 不可靠)。国旗用 flag-icons
# 预栅格的 PNG(4x3)。与右下角数据时间垂直居中。**TW 地区 ASN 不显示国旗**(显示口径)。
FLAG_DIR = os.path.join(ASSETS, "og-icons", "flags")
FLAG_H = 38
FLAG_HIDE = {"TW"}    # 这些 CC 不显示国旗
FLAG_ALIAS = {}       # CC→旗 映射(扩展位; 当前无)
PAD = 64        # 左右/底部统一 padding
BOT = 64        # 底部 padding(与左右一致)

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

def load_opt(name):
    """像 load() 但文件缺失/损坏时返回 {}(用于可选数据集, 如 seo/asn_cc.json 旧数据尚无)。"""
    try:
        return load(name)
    except Exception:
        return {}

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
    # 右下角数据时间: 与左下角国旗**垂直居中对齐**(align-items:center)——两者中线同在 H-BOT-FLAG_H/2。
    # 国旗底边 = H-BOT(下/右 padding 一致), 国旗较高故定行高, 文字居中其中。
    d.text((W - PAD, H - BOT - FLAG_H // 2), s, font=_font("lr", 24), fill=MUTED, anchor="rm")

# ── 国旗(左下角)──────────────────────────────────────────────────────────────────────────
_flags = {}
def _flag(cc):
    if not cc:
        return None
    up = str(cc).upper()
    if up in FLAG_HIDE:        # TW 地区 ASN 不出旗
        return None
    key = FLAG_ALIAS.get(up, up).lower()
    if key in _flags:
        return _flags[key]
    im = None
    try:
        src = Image.open(os.path.join(FLAG_DIR, f"{key}.png")).convert("RGBA")
        im = src.resize((round(FLAG_H * src.width / src.height), FLAG_H), Image.LANCZOS)
    except Exception:
        im = None
    _flags[key] = im
    return im

def _pill(d, x, y, label, value, vcolor):
    lf, vf = _font("lr", 26), _font("lb", 48)
    d.text((x, y), label, font=lf, fill=MUTED)
    d.text((x, y + 34), value, font=vf, fill=vcolor)
    return max(d.textlength(label, font=lf), d.textlength(value, font=vf))

# ── RDAP 取数(右栏 WHOIS)──────────────────────────────────────────────────────────────
_BOOT = None
def _boot():
    global _BOOT
    if _BOOT is None:
        try:
            with open(os.path.join(ASSETS, "rdap-bootstrap.json"), encoding="utf-8") as fh:
                _BOOT = json.load(fh)
        except Exception:
            _BOOT = {}
    return _BOOT

def _asn_base(asn):
    for svc in _boot().get("asn", []):
        try:
            ranges, urls = svc[0], svc[1]
        except Exception:
            continue
        for r in ranges:
            dash = str(r).find("-")
            try:
                lo = int(r if dash < 0 else r[:dash])
                hi = int(r if dash < 0 else r[dash + 1:])
            except ValueError:
                continue
            if lo <= asn <= hi:
                for u in urls:
                    if isinstance(u, str) and u.startswith("https://"):
                        return u if u.endswith("/") else u + "/"
    return None

def _vcard(e):
    arr = e.get("vcardArray")
    fn = kind = None
    if isinstance(arr, list) and len(arr) > 1 and isinstance(arr[1], list):
        for it in arr[1]:
            if not isinstance(it, list) or len(it) < 4:
                continue
            if it[0] == "fn":
                fn = it[3] if isinstance(it[3], str) else (" ".join(map(str, it[3])) if isinstance(it[3], list) else None)
            elif it[0] == "kind":
                kind = it[3]
    return fn, kind

def _collect_entities(d):
    acc = []
    def walk(ents, depth):
        for e in ents or []:
            if not isinstance(e, dict):
                continue
            roles = [r for r in (e.get("roles") or []) if isinstance(r, str)]
            fn, kind = _vcard(e)
            acc.append({"roles": roles, "name": str(fn or e.get("handle") or (roles[0] if roles else "?")), "kind": kind})
            if depth < 1:
                walk(e.get("entities"), depth + 1)
    walk(d.get("entities"), 0)
    seen, out = set(), []
    for a in acc:
        k = (a["name"], tuple(a["roles"]))
        if k in seen:
            continue
        seen.add(k)
        out.append(a)
    out.sort(key=lambda a: 0 if a["roles"] else 1)   # 有角色的优先(稳定排序保留发现顺序)
    return out[:5]

def _rdap_asn(asn):
    """返回 [{roles,name,kind}, …](≤5); 失败/无 → []。独立长 TTL 磁盘缓存(autnum-<n>.json)。"""
    try:
        a = int(asn)
    except (TypeError, ValueError):
        return []
    try:
        os.makedirs(os.path.join(CACHE, "rdap"), exist_ok=True)
    except OSError:
        pass
    cf = os.path.join(CACHE, "rdap", f"autnum-{a}.json")
    try:
        age = time.time() - os.path.getmtime(cf)
        with open(cf, encoding="utf-8") as fh:
            obj = json.load(fh)
        if age < (RDAP_TTL if obj.get("ents") else RDAP_NEG_TTL):
            return obj.get("ents", [])
    except Exception:
        pass
    ents = []
    base = _asn_base(a)
    if base:
        try:
            req = urllib.request.Request(
                base + f"autnum/{a}",
                headers={"Accept": "application/rdap+json", "User-Agent": "peer.as-og/1.0"})
            with urllib.request.urlopen(req, timeout=RDAP_TIMEOUT) as r:
                ents = _collect_entities(json.load(r))
        except Exception:
            ents = []
    try:
        with open(cf, "w", encoding="utf-8") as fh:
            json.dump({"ents": ents}, fh, ensure_ascii=False)
    except OSError:
        pass
    return ents

# ── 图标(预栅格 FA alpha mask, tint 成角色色)─────────────────────────────────────────────
_icons = {}
def _icon(name, size, color):
    k = (name, size, color)
    if k in _icons:
        return _icons[k]
    col = None
    try:
        im = Image.open(os.path.join(ASSETS, "og-icons", f"{name}.png")).convert("RGBA").resize((size, size), Image.LANCZOS)
        col = Image.new("RGBA", (size, size), color + (255,))
        col.putalpha(im.split()[3])
    except Exception:
        col = None
    _icons[k] = col
    return col

def _role_icon_name(roles, kind):
    if "abuse" in roles:
        return "shield"
    if kind in ("org", "group"):
        return "users"
    return "user"

def _draw_whois(img, dr, asn):
    ents = _rdap_asn(asn)
    if not ents:
        return
    x = WH_X
    n = min(len(ents), 5)
    dr.line([(x - 26, 150), (x - 26, 176 + n * 64)], fill=LINE, width=2)
    dr.text((x, 150), "REGISTRY", font=_font("lr", 24), fill=MUTED)
    tx = x + 38
    maxw = W - 64 - tx
    y = 192
    for e in ents[:5]:
        roles = e["roles"]
        color = SIGNAL if "abuse" in roles else ACCENT
        ic = _icon(_role_icon_name(roles, e["kind"]), 26, color)
        if ic:
            img.paste(ic, (x, y + 6), ic)
        label = " · ".join(ROLE_LABEL.get(r, r) for r in roles) or "contact"
        dr.text((tx, y), label.upper(), font=_font("lr", 20), fill=color)
        nf = font_for(e["name"], True, 28)
        dr.text((tx, y + 24), _truncate(dr, e["name"], nf, maxw), font=nf, fill=FG)
        y += 64


def render_asn(asn):
    counts = load("seo/asn.json").get(asn)
    if counts is None and asn not in load("asnames.json"):
        return None
    # AS 名首选英文(asn_name_en.json = autnums handle + config name_en), 回退 asnames.json(可能中文)。
    name = load_opt("asn_name_en.json").get(asn) or load("asnames.json").get(asn, "")
    v4 = counts[0] if counts else 0
    v6 = counts[1] if counts else 0
    peers = counts[2] if counts and len(counts) > 2 else 0
    img, d = _base()
    # 左栏收敛到右栏(WH_X)左侧, 给 WHOIS 让位。AS 号顶部与右栏 REGISTRY(y=150)平齐;
    # 字号较小(6 位 ASN 也不顶到右栏分隔线 WH_X-26), name 放大。
    left_w = WH_X - 64 - 44       # 右留白加大, 防大 ASN 撞分隔线
    asn_str = f"AS{asn}"
    fs = 120
    while fs > 80 and d.textlength(asn_str, font=_font("lb", fs)) > left_w:
        fs -= 4
    d.text((64, 117), asn_str, font=_font("lb", fs), fill=FG)   # 字形顶与右栏 REGISTRY(y=150)对齐
    if name:
        nf = font_for(name, True, 76)
        d.text((64, 262), _truncate(d, name, nf, left_w), font=nf, fill=ACCENT)
    y = 368
    gap = 60
    x = 64
    x += _pill(d, x, y, "IPv4 prefixes", _fmt(v4), FG) + gap
    x += _pill(d, x, y, "IPv6 prefixes", _fmt(v6), FG) + gap
    _pill(d, x, y, "Peers", _fmt(peers), ACCENT)
    _draw_whois(img, d, asn)
    fl = _flag(load_opt("seo/asn_cc.json").get(asn))   # 左下角国旗(与右下角数据时间齐平)
    if fl:
        img.paste(fl, (PAD, H - BOT - FLAG_H), fl)
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
