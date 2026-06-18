// CF Pages Function(Advanced Mode `_worker.js`)—— 边缘同壳 SSR,给爬虫渲染 ASN / AS-SET / 入口落地页。
//
// 设计:
//  - 命中 SEO 路由(/<asn>、/asset/<key>、/、/advanced、/trace、/probe)→ 取 SPA 外壳 index.html,
//    本地化 <head>(title/description/canonical/hreflang/OG/JSON-LD)+ 注入 #seo-shell 内容块,返回完整 HTML。
//    用户 JS 启动后 SPA 原地无缝接管(同 URL、同壳),main.js 在内容就绪后移除 #seo-shell。
//  - 其余一切(前缀 /1.1.1.0/24、/dns、/whois、静态资源…)→ env.ASSETS.fetch 原样(含 CF SPA-200 回退)。
//  - **全程 fail-safe**:任何异常 → env.ASSETS.fetch(request)。SSR 整层失效也只是退化为纯前端渲染。
//  - 数据已与前端解耦:peeras 从 **data.peer.as 跨源** fetch(asnames.json + data/seo/*.json);
//    dn42 仍同源 env.ASSETS。按 isolate 缓存。读不了 parquet,故 export 侧已把所需字段导成小 JSON。
//    index.html 外壳仍走 env.ASSETS(前端项目)。
//
// **零 app 依赖**:仅 import 同目录 *.Seo.svelte + strings.js + svelte/server。单向依赖,SPA 不感知本层。

import { render } from 'svelte/server'
import AsnSeo from './AsnSeo.svelte'
import AssetSeo from './AssetSeo.svelte'
import EntrySeo from './EntrySeo.svelte'
import { BRANDS } from './strings.js'

// ── isolate 级缓存(promise) ──────────────────────────────────────────
let _asnP, _asnamesP, _assetP, _netP, _ctx
// 数据已与前端解耦:peeras 从 **data.peer.as 跨源** fetch(前端项目不含 /data);
// dn42(无独立数据项目)仍同源 env.ASSETS。每个 isolate 只服务一个项目/域,首请求设一次即可。
function setCtx(env, base, host) {
  if (!_ctx) _ctx = { env, base, dataOrigin: host && host.includes('dn42') ? null : 'https://data.peer.as' }
}
function loadJson(path) {
  const { env, base, dataOrigin } = _ctx
  const p = dataOrigin ? fetch(`${dataOrigin}${path}`) : env.ASSETS.fetch(new URL(path, base))
  return p.then(r => (r && r.ok ? r.json() : null)).catch(() => null)
}
const asnData = () => (_asnP ??= loadJson('/data/seo/asn.json'))
const asnames = () => (_asnamesP ??= loadJson('/data/asnames.json'))
const assetData = () => (_assetP ??= loadJson('/data/seo/asset.json'))
const netData = () => (_netP ??= loadJson('/data/seo/networks.json'))

// ── 小工具 ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function pickLang(url, request) {
  const q = url.searchParams.get('lang')
  if (q === 'zh' || q === 'en') return q
  const ck = request.headers.get('cookie') || ''
  const m = /(?:^|;\s*)ipc-lang=(zh|en)/.exec(ck)
  if (m) return m[1]
  const al = (request.headers.get('accept-language') || '').toLowerCase()
  if (al.includes('zh')) return 'zh'
  return 'en'   // 无信号默认 en(与 sitemap x-default 一致)
}
function brandOf(host) { return host && host.includes('dn42') ? BRANDS.dn42 : BRANDS.peeras }
// canonical/hreflang/og 永远用品牌域(非服务主机) -> *.pages.dev / cn 镜像不会被当独立站收录。
function canonicalHost(host) { return host && host.includes('dn42') ? 'dn42.peer.as' : 'peer.as' }

function matchRoute(pathname) {
  const p = pathname.replace(/\/+$/, '') || '/'
  if (p === '/') return { kind: 'entry', page: 'home' }
  if (p === '/advanced') return { kind: 'entry', page: 'advanced' }
  if (p === '/trace') return { kind: 'entry', page: 'trace' }
  if (p === '/probe') return { kind: 'entry', page: 'probe' }
  let m = /^\/(\d{1,10})$/.exec(p)
  if (m) return { kind: 'asn', asn: m[1] }
  m = /^\/asset\/(.+)$/.exec(p)
  if (m) { try { return { kind: 'asset', key: decodeURIComponent(m[1]) } } catch { return null } }
  return null
}

// 渲染一个 SEO 路由的正文 -> {body} 或 null(数据缺失则回退给 SPA)。
async function renderRoute(r, lang, brand, env, base) {
  if (r.kind === 'entry') {
    return { body: render(EntrySeo, { props: { lang, page: r.page, brand } }).body }
  }
  if (r.kind === 'asn') {
    const [counts, names] = await Promise.all([asnData(), asnames()])
    const c = counts && counts[r.asn]
    const name = (names && names[r.asn]) || ''
    if (!c && !name) return null   // 未知 ASN -> 交给 SPA(可能是新数据/前缀误配)
    const props = { lang, asn: r.asn, name, nameEn: name, v4: (c && c[0]) || 0, v6: (c && c[1]) || 0, peers: (c && c[2]) || 0, brand }
    return { body: render(AsnSeo, { props }).body }
  }
  if (r.kind === 'asset') {
    const sets = await assetData()
    const a = sets && sets[r.key]
    if (!a) return null
    const props = { lang, setKey: r.key, source: a.s || '', descr: a.d || '', count: a.c || 0, members: a.m || [], brand }
    return { body: render(AssetSeo, { props }).body }
  }
  return null
}

// 注入到 index.html 外壳。tpl=原始 index.html 文本。jsonld=已构建的 schema.org 对象(随路由类型而异)。
function injectShell(tpl, { body, lang, title, desc, canonical, jsonld, ogImage }) {
  const htmlLang = lang === 'zh' ? 'zh-CN' : 'en'
  const sep = canonical.includes('?') ? '&' : '?'
  const altZh = esc(canonical + sep + 'lang=zh')
  const altEn = esc(canonical + sep + 'lang=en')
  const ld = jsonld
  // og:image -> CN VPS 的 Pillow 渲染器(cn.peer.as/og/*),社交平台分享时显示 ASN/AS-SET 大图卡。
  const img = ogImage
    ? `<meta property="og:image" content="${esc(ogImage)}"/>` +
      `<meta property="og:image:width" content="1200"/>` +
      `<meta property="og:image:height" content="630"/>` +
      `<meta property="og:image:type" content="image/png"/>` +
      `<meta name="twitter:image" content="${esc(ogImage)}"/>`
    : ''
  const headExtra =
    `<link rel="alternate" hreflang="zh" href="${altZh}"/>` +
    `<link rel="alternate" hreflang="en" href="${altEn}"/>` +
    `<link rel="alternate" hreflang="x-default" href="${esc(canonical)}"/>` +
    `<meta property="og:title" content="${esc(title)}"/>` +
    `<meta property="og:description" content="${esc(desc)}"/>` +
    `<meta property="og:url" content="${esc(canonical)}"/>` +
    img +
    (ogImage ? `<meta name="twitter:card" content="summary_large_image"/>` : '') +
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`

  let out = tpl
  out = out.replace(/<html[^>]*>/i, `<html lang="${htmlLang}">`)
  out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`)
  out = out.replace(/<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${esc(desc)}"/>`)
  if (/<link\s+rel=["']canonical["'][^>]*>/i.test(out))
    out = out.replace(/<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${esc(canonical)}"/>`)
  else
    out = out.replace(/<\/head>/i, `<link rel="canonical" href="${esc(canonical)}"/></head>`)
  // 外壳静态版 og:* / twitter:card 先删,避免与本页注入的重复。
  out = out.replace(/<meta\s+property=["']og:(title|description|url|image)["'][^>]*>/gi, '')
  if (ogImage) out = out.replace(/<meta\s+name=["']twitter:card["'][^>]*>/gi, '')
  // 外壳静态 hreflang(首页有 zh/en)也先删,避免与本页注入的 hreflang 重复。
  out = out.replace(/<link\s+rel=["']alternate["'][^>]*hreflang=[^>]*>/gi, '')
  out = out.replace(/<\/head>/i, `${headExtra}</head>`)
  // #seo-shell 覆盖层(全屏,主题深色;SPA 接管后由 main.js 移除)。放在 #app 之后、脚本之前。
  const shell = `<div id="seo-shell">${SHELL_STYLE}<main class="seo-wrap">${body}</main></div>`
  if (/<div id="app"><\/div>/i.test(out))
    out = out.replace(/<div id="app"><\/div>/i, `<div id="app"></div>${shell}`)
  else
    out = out.replace(/<body[^>]*>/i, m => `${m}${shell}`)
  return out
}

// #seo-shell 内联样式:不依赖 app.css(异步加载),覆盖全屏、深色、内容居中可读。
const SHELL_STYLE = `<style>
#seo-shell{position:fixed;inset:0;z-index:50;overflow:auto;background:#0a0e15;color:#dde6f0;
font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.6}
#seo-shell .seo-wrap{max-width:880px;margin:0 auto;padding:48px 22px 64px}
#seo-shell h1{font-size:1.6rem;margin:.1em 0 .4em;font-weight:700}
#seo-shell .seo-sub{opacity:.7;margin:.2em 0;font-size:.95rem}
#seo-shell .seo-lede{margin:1em 0;font-size:1.02rem}
#seo-shell .seo-facts{list-style:none;padding:0;display:flex;gap:18px;flex-wrap:wrap;margin:1.2em 0}
#seo-shell .seo-facts li{background:#121826;border:1px solid #1e2638;border-radius:10px;padding:10px 16px;display:flex;flex-direction:column;gap:2px}
#seo-shell .seo-facts span{opacity:.65;font-size:.8rem}
#seo-shell .seo-facts b{font-size:1.3rem}
#seo-shell .seo-members{display:flex;flex-wrap:wrap;gap:6px 12px;padding:0;list-style:none;margin:.6em 0}
#seo-shell .seo-members a{color:#5b9dff;text-decoration:none}
#seo-shell .seo-cta{opacity:.55;font-size:.88rem;margin-top:1.6em}
#seo-shell a{color:#5b9dff}
html[data-theme="light"] #seo-shell{background:#f6f8fc;color:#1a2230}
html[data-theme="light"] #seo-shell .seo-facts li{background:#fff;border-color:#dde3ee}
@media (prefers-color-scheme:light){html:not([data-theme="dark"]):not([data-theme="ba"]) #seo-shell{background:#f6f8fc;color:#1a2230}html:not([data-theme="dark"]):not([data-theme="ba"]) #seo-shell .seo-facts li{background:#fff;border-color:#dde3ee}}
</style>`

// ── /networks 国家分流目录(独立 SEO 页, 非 SPA 外壳;给爬虫/用户一条「首页→国家→ASN」内链路径)──
const NET_PER_PAGE = 500
const NET_CSS = `*{box-sizing:border-box}body{margin:0;background:#0a0e15;color:#dde6f0;
font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.55}
a{color:#5b9dff;text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 64px}
header.bar{display:flex;align-items:baseline;gap:14px;margin-bottom:8px}
header.bar .brand{font-size:1.5rem;font-weight:700;color:#dde6f0}.brand .hi{color:#5b9dff}
.crumb{font-size:.85rem;color:#8f9eb2;margin:6px 0 18px}.crumb a{color:#8f9eb2}
h1{font-size:1.5rem;margin:.2em 0}.lede{color:#8f9eb2;margin:.2em 0 1.4em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.grid a{display:flex;justify-content:space-between;gap:10px;background:#121826;border:1px solid #1e2638;
border-radius:10px;padding:11px 14px;color:#dde6f0}.grid a:hover{border-color:#5b9dff;text-decoration:none}
.grid .n{color:#8f9eb2;font-size:.85rem;white-space:nowrap}
ul.asns{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:4px 18px}
ul.asns li{padding:5px 0;border-bottom:1px solid #141b2a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
ul.asns .nm{color:#cdd8e6}ul.asns .pf{color:#8f9eb2;font-size:.8rem}
.pager{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0;align-items:center}
.pager a,.pager span{padding:6px 11px;border:1px solid #1e2638;border-radius:8px;font-size:.9rem}
.pager .cur{background:#1a2336;border-color:#5b9dff;color:#dde6f0}.pager .dis{opacity:.4}
footer{margin-top:34px;color:#8f9eb2;font-size:.85rem}`

function netDoc(lang, title, desc, canonical, bodyInner) {
  const hl = lang === 'zh' ? 'zh-CN' : 'en'
  const sep = canonical.includes('?') ? '&' : '?'
  return `<!doctype html><html lang="${hl}"><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"/>` +
    `<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"/>` +
    `<meta name="robots" content="index,follow"/>` +
    `<link rel="canonical" href="${esc(canonical)}"/>` +
    `<link rel="alternate" hreflang="zh" href="${esc(canonical + sep + 'lang=zh')}"/>` +
    `<link rel="alternate" hreflang="en" href="${esc(canonical + sep + 'lang=en')}"/>` +
    `<link rel="alternate" hreflang="x-default" href="${esc(canonical)}"/>` +
    `<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(desc)}"/>` +
    `<meta property="og:url" content="${esc(canonical)}"/>` +
    `<style>${NET_CSS}</style></head><body><div class="wrap">${bodyInner}` +
    `<footer><a href="/${lang === 'en' ? '?lang=en' : ''}">← ${lang === 'zh' ? '回到 PEER.AS 首页' : 'Back to PEER.AS'}</a></footer>` +
    `</div></body></html>`
}

function lq(lang) { return lang === 'en' ? '?lang=en' : '' }

function renderNetHub(net, lang, brand, canonical) {
  const zh = lang === 'zh'
  const title = zh ? `按国家浏览自治系统(ASN) · ${brand}` : `Browse Autonomous Systems (ASN) by country · ${brand}`
  const desc = zh
    ? `按国家/地区浏览全球自治系统(ASN):各国注册的网络、通告前缀与邻居。${brand} BGP/IP/ASN 情报目录。`
    : `Browse Autonomous Systems (ASN) by country/region: networks registered in each country, their prefixes and peers. ${brand} BGP/IP/ASN directory.`
  const items = (net.countries || []).map(c => {
    const name = zh ? (c.zh || c.cc) : (c.en || c.cc)
    return `<a href="/networks/${c.cc}${lq(lang)}"><span>${esc(name)} <span class="n">(${c.cc})</span></span>` +
      `<span class="n">${c.n.toLocaleString()} ASN</span></a>`
  }).join('')
  const body = `<header class="bar"><a class="brand" href="/${lq(lang)}">PEER<span class="hi">.AS</span></a></header>` +
    `<div class="crumb">${zh ? '首页' : 'Home'} / ${zh ? '网络目录' : 'Networks'}</div>` +
    `<h1>${zh ? '按国家浏览自治系统(ASN)' : 'Autonomous Systems by country'}</h1>` +
    `<p class="lede">${zh ? `${(net.countries || []).length} 个国家/地区 · 点开查看各国注册的 ASN 与其通告前缀。`
      : `${(net.countries || []).length} countries/regions · open one to see its registered ASNs and announced prefixes.`}</p>` +
    `<div class="grid">${items}</div>`
  return netDoc(lang, title, desc, canonical, body)
}

function renderNetCountry(net, asnNames, asnCounts, cc, page, lang, brand, canonicalBase) {
  const zh = lang === 'zh'
  const all = (net.asns || {})[cc]
  if (!all) return null
  const meta = (net.countries || []).find(c => c.cc === cc) || { cc }
  const cname = zh ? (meta.zh || cc) : (meta.en || cc)
  const pages = Math.max(1, Math.ceil(all.length / NET_PER_PAGE))
  page = Math.min(Math.max(1, page), pages)
  const slice = all.slice((page - 1) * NET_PER_PAGE, page * NET_PER_PAGE)
  const li = slice.map(a => {
    const nm = (asnNames && asnNames[a]) || ''
    const c = asnCounts && asnCounts[a]
    const pf = c ? `${(c[0] + c[1]).toLocaleString()} ${zh ? '前缀' : 'prefixes'}` : ''
    return `<li><a href="/${a}${lq(lang)}">AS${a}</a> <span class="nm">${esc(nm)}</span> <span class="pf">${pf}</span></li>`
  }).join('')
  // 分页(canonicalBase = /networks/<cc>): 第 1 页无 /1 后缀
  const purl = p => canonicalBase + (p > 1 ? '/' + p : '') + lq(lang)
  let pager = ''
  if (pages > 1) {
    const parts = []
    parts.push(page > 1 ? `<a href="${purl(page - 1)}">${zh ? '上一页' : 'Prev'}</a>` : `<span class="dis">${zh ? '上一页' : 'Prev'}</span>`)
    const lo = Math.max(1, page - 2), hi = Math.min(pages, page + 2)
    if (lo > 1) parts.push(`<a href="${purl(1)}">1</a>`, lo > 2 ? '<span class="dis">…</span>' : '')
    for (let p = lo; p <= hi; p++) parts.push(p === page ? `<span class="cur">${p}</span>` : `<a href="${purl(p)}">${p}</a>`)
    if (hi < pages) parts.push(hi < pages - 1 ? '<span class="dis">…</span>' : '', `<a href="${purl(pages)}">${pages}</a>`)
    parts.push(page < pages ? `<a href="${purl(page + 1)}">${zh ? '下一页' : 'Next'}</a>` : `<span class="dis">${zh ? '下一页' : 'Next'}</span>`)
    pager = `<div class="pager">${parts.filter(Boolean).join('')}</div>`
  }
  const pageSuffix = pages > 1 ? (zh ? ` · 第 ${page}/${pages} 页` : ` · page ${page}/${pages}`) : ''
  const title = (zh ? `${cname} 的自治系统(ASN)` : `Autonomous Systems in ${cname}`) + pageSuffix + ` · ${brand}`
  const desc = zh
    ? `${cname}(${cc})注册的 ${all.length.toLocaleString()} 个自治系统(ASN)及其通告前缀。${brand} BGP/IP/ASN 目录。`
    : `${all.length.toLocaleString()} Autonomous Systems (ASN) registered in ${cname} (${cc}) and their announced prefixes. ${brand} BGP/IP/ASN directory.`
  const canonical = `https://peer.as${canonicalBase}${page > 1 ? '/' + page : ''}`
  const body = `<header class="bar"><a class="brand" href="/${lq(lang)}">PEER<span class="hi">.AS</span></a></header>` +
    `<div class="crumb"><a href="/${lq(lang)}">${zh ? '首页' : 'Home'}</a> / <a href="/networks${lq(lang)}">${zh ? '网络目录' : 'Networks'}</a> / ${esc(cname)}</div>` +
    `<h1>${zh ? `${esc(cname)} 的自治系统` : `Autonomous Systems in ${esc(cname)}`}</h1>` +
    `<p class="lede">${all.length.toLocaleString()} ASN${pageSuffix}</p>` +
    `<ul class="asns">${li}</ul>${pager}`
  return netDoc(lang, title, desc, canonical, body)
}

async function renderNetworks(url, request, env) {
  try {
    setCtx(env, url.origin, url.host)
    const lang = pickLang(url, request)
    const brand = brandOf(url.host)
    const net = await netData()
    if (!net || !net.countries) return env.ASSETS.fetch(request)   // 无数据(如 dn42) -> 回退
    const path = url.pathname.replace(/\/+$/, '')
    if (path === '/networks') {
      const html = renderNetHub(net, lang, brand, `https://peer.as/networks`)
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-seo-ssr': 'networks' } })
    }
    const m = /^\/networks\/([A-Za-z]{2})(?:\/(\d{1,4}))?$/.exec(path)
    if (!m) return env.ASSETS.fetch(request)
    const cc = m[1].toUpperCase(), page = m[2] ? parseInt(m[2], 10) : 1
    const [names, counts] = await Promise.all([asnames(), asnData()])
    const html = renderNetCountry(net, names, counts, cc, page, lang, brand, `/networks/${cc}`)
    if (!html) return env.ASSETS.fetch(request)
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600', 'x-seo-ssr': 'networks-cc' } })
  } catch (e) {
    return env.ASSETS.fetch(request)
  }
}

export default {
  async fetch(request, env) {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return env.ASSETS.fetch(request)
      const url = new URL(request.url)
      setCtx(env, url.origin, url.host)   // 选定数据源(peeras -> data.peer.as 跨源; dn42 -> 同源)
      // /networks[/<cc>[/<page>]] = 独立国家分流目录(非 SPA 外壳),自带 try/回退。
      if (url.pathname === '/networks' || url.pathname.startsWith('/networks/')) return renderNetworks(url, request, env)
      const r = matchRoute(url.pathname)
      if (!r) return env.ASSETS.fetch(request)

      const lang = pickLang(url, request)
      const host = url.host
      const brand = brandOf(host)
      const base = url.origin

      const rendered = await renderRoute(r, lang, brand, env, base)
      if (!rendered) return env.ASSETS.fetch(request)

      // canonical 永远指向**品牌域**(非服务主机),避免 *.pages.dev 与 peer.as 重复收录。
      const cHost = canonicalHost(host)
      const canonical = `https://${cHost}${url.pathname}`
      const brandUrl = `https://${cHost}/`
      const htmlLang = lang === 'zh' ? 'zh-CN' : 'en'

      // 文案(title/desc)与 body 同源:重新按 strings 取(render 不回传)。动态 import 避免顶层循环。
      // 同时收集结构化事实 -> JSON-LD Dataset(参考 ipinfo 的 variableMeasured 做法,助搜索引擎理解实体)。
      const { asnText, assetText, entryText } = await import('./strings.js')
      let title, desc, jsonld
      const site = { '@type': 'WebSite', name: brand, url: brandUrl }
      if (r.kind === 'entry') {
        const x = entryText(lang, r.page, brand); title = x.title; desc = x.desc
        jsonld = { '@context': 'https://schema.org', '@type': 'WebPage',
          name: title, description: desc, url: canonical, inLanguage: htmlLang, isPartOf: site }
      } else if (r.kind === 'asn') {
        const [counts, names] = await Promise.all([asnData(), asnames()])
        const c = counts && counts[r.asn]; const name = (names && names[r.asn]) || ''
        const v4 = (c && c[0]) || 0, v6 = (c && c[1]) || 0, peers = (c && c[2]) || 0
        const x = asnText(lang, { asn: r.asn, name, nameEn: name, v4, v6, peers, brand })
        title = x.title; desc = x.desc
        const vars = [{ '@type': 'PropertyValue', name: 'ASN', value: `AS${r.asn}` }]
        if (name) vars.push({ '@type': 'PropertyValue', name: 'AS Name', value: name })
        vars.push({ '@type': 'PropertyValue', name: 'IPv4 prefixes', value: v4 })
        vars.push({ '@type': 'PropertyValue', name: 'IPv6 prefixes', value: v6 })
        vars.push({ '@type': 'PropertyValue', name: 'Peers', value: peers })
        jsonld = { '@context': 'https://schema.org', '@graph': [site,
          { '@type': 'Dataset', name: `AS${r.asn}${name ? ' ' + name : ''}`, description: desc,
            url: canonical, inLanguage: htmlLang, isPartOf: site, variableMeasured: vars }] }
      } else {
        const sets = await assetData(); const a = (sets && sets[r.key]) || {}
        const x = assetText(lang, { key: r.key, source: a.s || '', descr: a.d || '', count: a.c || 0, brand })
        title = x.title; desc = x.desc
        const vars = [{ '@type': 'PropertyValue', name: 'AS-SET', value: r.key }]
        if (a.s) vars.push({ '@type': 'PropertyValue', name: 'Source', value: a.s })
        vars.push({ '@type': 'PropertyValue', name: 'Direct members', value: a.c || 0 })
        jsonld = { '@context': 'https://schema.org', '@graph': [site,
          { '@type': 'Dataset', name: r.key, description: desc,
            url: canonical, inLanguage: htmlLang, isPartOf: site, variableMeasured: vars }] }
      }

      // og:image -> CN VPS 的 Pillow 渲染器(peeras only; dn42 无该渲染器 -> 不出图)。
      let ogImage = null
      if (cHost === 'peer.as') {
        const OG = 'https://cn.peer.as/og'
        if (r.kind === 'asn') ogImage = `${OG}/asn.png?n=${r.asn}`
        else if (r.kind === 'asset') ogImage = `${OG}/asset.png?k=${encodeURIComponent(r.key)}`
        else ogImage = `${OG}/home.png`
      }

      const tplRes = await env.ASSETS.fetch(new URL('/index.html', base))
      if (!tplRes || !tplRes.ok) return env.ASSETS.fetch(request)
      const tpl = await tplRes.text()
      const html = injectShell(tpl, { body: rendered.body, lang, title, desc, canonical, jsonld, ogImage })

      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300, must-revalidate',
          'x-seo-ssr': r.kind,
        },
      })
    } catch (e) {
      try { return env.ASSETS.fetch(request) } catch { return new Response('', { status: 500 }) }
    }
  },
}
