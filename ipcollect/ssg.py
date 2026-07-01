"""SSG: 生成 **sitemap 索引 + 分片 sitemap + robots.txt**,供搜索引擎发现可被边缘 SSR 的落地页。

WASM 查询型站点(DuckDB-WASM 在浏览器里发 SQL)对爬虫几乎不可见。本项目的 SEO 方案改为:
**CF Pages Function(`_worker.js`)在边缘按 URL 同壳 SSR**——爬虫访问 `/<asn>` / `/asset/<key>` /
入口页(`/trace` `/probe` `/advanced`)时拿到含真实内容、本地化 `<head>` 的完整 HTML,JS 启动后
SPA 原地无缝接管(同 URL、同壳,非死胡同落地页)。

本模块只负责把「有哪些可抓取的 URL」写成 sitemap 让 Google 发现它们;真正的页面内容由 `_worker.js`
渲染(数据来自 `data/seo/*.json` + `meta.json`)。每条 URL 带 zh/en 的 `hreflang` 备选 + `x-default`。

> 旧的 `/c/<cc>.html` 国家双语落地页(独立 `.ssg` DOM + 一个「在看板打开」链接)已废弃:它与 SPA 脱节,
> 点进去等于重新加载,SEO 价值低。改由 `_worker.js` 同壳 SSR 接管。
"""
from __future__ import annotations

import time
from pathlib import Path
from urllib.parse import quote

from . import util

DEFAULT_SITE = "https://peer.as"
URLS_PER_FILE = 40000   # sitemap 协议上限 5 万 URL / 50MB,留余量分片(每条带 2 个 hreflang 备选)。
LANGS = ("zh", "en")
NET_PER_PAGE = 500      # 与 _worker.js renderNetCountry 的 NET_PER_PAGE 必须一致(分页 URL 才对得上)。
IX_PER_PAGE = 500       # 与 _worker.js renderIxCountry 的 IX_PER_PAGE 必须一致。


def _esc(s) -> str:
    s = str(s if s is not None else "")
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def _url_entry(site: str, path: str, lastmod: str) -> str:
    """一条 <url>:canonical 用 ?lang=zh,附 zh/en 的 hreflang 备选 + x-default(=en)。path 已 URL 编码。"""
    loc = f"{site}{path}"
    sep = "&" if "?" in path else "?"
    alts = "".join(
        f'<xhtml:link rel="alternate" hreflang="{lg}" href="{_esc(loc)}{sep}lang={lg}"/>'
        for lg in LANGS)
    alts += f'<xhtml:link rel="alternate" hreflang="x-default" href="{_esc(loc)}"/>'
    return (f"<url><loc>{_esc(loc)}{sep}lang=zh</loc>"
            f"<lastmod>{lastmod}</lastmod>{alts}</url>")


def _write_urlset(path: Path, entries: list[str]) -> None:
    body = "\n".join(entries)
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
        'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
        f"{body}\n</urlset>\n", encoding="utf-8")


def generate(out, meta: dict, seo_asns=None, seo_assets=None, seo_networks=None, seo_ixps=None) -> int:
    """写 sitemap 索引 + 分片 + robots。seo_asns / seo_assets = ASN/AS-SET 键列表;
    seo_networks = [{cc,n,...}] 国家分流目录(用于 /networks 及分页);
    seo_ixps = [{cc,n,...}] IX 目录(用于 /ixps 及分页)。

    返回收录的 URL 总数。任何调用方异常已在 export 侧 try/except 兜底。
    """
    out = Path(out)
    site = (meta.get("site_base") or DEFAULT_SITE).rstrip("/")
    seo_asns = seo_asns or []
    seo_assets = seo_assets or []
    seo_networks = seo_networks or []
    seo_ixps = seo_ixps or []
    lastmod = time.strftime("%Y-%m-%d", time.localtime(meta.get("generated_ts") or time.time()))

    # 收集所有可抓取路径(SSR 落地页): 入口页 + 每 ASN(/<asn>) + 每 AS-SET(/asset/<key>)。
    entry_paths = ["/", "/advanced", "/trace", "/probe"]
    asn_paths = [f"/{a}" for a in seo_asns]
    asset_paths = [f"/asset/{quote(str(k), safe='')}" for k in seo_assets]
    # 国家分流目录: /networks 总入口 + 每国 /networks/<cc>(及分页 /networks/<cc>/<p>)。
    net_paths = ["/networks"]
    for c in seo_networks:
        cc = c.get("cc")
        if not cc:
            continue
        net_paths.append(f"/networks/{cc}")
        pages = max(1, -(-int(c.get("n", 0)) // NET_PER_PAGE))   # ceil
        for p in range(2, pages + 1):
            net_paths.append(f"/networks/{cc}/{p}")
    # IX 目录: /ixps 总入口 + 每国 /ixps/<cc>(及分页 /ixps/<cc>/<p>)。
    ixp_paths = ["/ixps"] if seo_ixps else []
    for c in seo_ixps:
        cc = c.get("cc")
        if not cc:
            continue
        ixp_paths.append(f"/ixps/{cc}")
        pages = max(1, -(-int(c.get("n", 0)) // IX_PER_PAGE))   # ceil
        for p in range(2, pages + 1):
            ixp_paths.append(f"/ixps/{cc}/{p}")

    # 清理已废弃的旧国家落地页(/c/*.html + countries.html),避免死胡同页残留被索引。
    import shutil as _shutil
    _shutil.rmtree(out / "c", ignore_errors=True)
    (out / "countries.html").unlink(missing_ok=True)

    smdir = out / "sitemaps"
    smdir.mkdir(parents=True, exist_ok=True)
    # 清掉上次的分片(URL 数随数据变,文件数可能减少 -> 避免残留旧分片被索引)。
    for old in smdir.glob("*.xml"):
        old.unlink()

    shards: list[str] = []   # 子 sitemap 的相对路径(写进索引)

    def _emit(name: str, paths: list[str]) -> None:
        for i in range(0, len(paths), URLS_PER_FILE):
            chunk = paths[i:i + URLS_PER_FILE]
            fn = f"{name}-{i // URLS_PER_FILE}.xml"
            _write_urlset(smdir / fn, [_url_entry(site, p, lastmod) for p in chunk])
            shards.append(f"sitemaps/{fn}")

    _emit("entry", entry_paths)
    _emit("networks", net_paths)
    if ixp_paths:
        _emit("ixps", ixp_paths)
    _emit("asn", asn_paths)
    if asset_paths:
        _emit("asset", asset_paths)

    # sitemap 索引(robots 指向它)
    idx = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for s in shards:
        idx.append(f"<sitemap><loc>{_esc(site)}/{s}</loc><lastmod>{lastmod}</lastmod></sitemap>")
    idx.append("</sitemapindex>")
    (out / "sitemap.xml").write_text("\n".join(idx) + "\n", encoding="utf-8")

    (out / "robots.txt").write_text(
        f"User-agent: *\nAllow: /\nSitemap: {site}/sitemap.xml\n", encoding="utf-8")

    n_urls = len(entry_paths) + len(net_paths) + len(ixp_paths) + len(asn_paths) + len(asset_paths)
    util.log(f"  SSG: sitemap {n_urls} URL（{len(shards)} 分片）+ robots.txt"
             f"（ASN {len(asn_paths)} · AS-SET {len(asset_paths)} · networks {len(net_paths)} · ixps {len(ixp_paths)} · 入口 {len(entry_paths)}）")
    return n_urls
