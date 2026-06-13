// RDAP / WHOIS 客户端(纯前端直连)。
// - bootstrap: 构建期内置 IANA RFC 9224 表(rdap-bootstrap.json, 由 scripts/vendor-rdap-bootstrap.sh 自更新),
//   把 ASN/IP/域名直接映射到对应 RIR / TLD 注册局的 RDAP base, 直连查询。
//   **不依赖任何第三方重定向器(如 rdap.org)**: bootstrap 查不到 base 就不查(ip/asn 直接报"无", 域名转自有 WHOIS worker)。
// - 各 RIR 在 GET 上均回 Access-Control-Allow-Origin:* (实测), 简单 GET 无预检 —— 故浏览器可直连。
// - 返回值已把 jCard/嵌套 entity 拍平成 {key,value} 行 + entity 树, 供 Whois.svelte 做扁平 whois 渲染。
// - 缓存: 内存(去重 in-flight) + sessionStorage(跨刷新), key = `autnum:<n>` / `ip:<cidr>`。
// 详见 docs/RDAP_WHOIS_RESEARCH.md。
import BOOT from './rdap-bootstrap.json'
import { S } from './store.svelte.js'
import { cnProxyBase } from './db.js'
import { ip2int, ip6ToBig } from './bgp.js'
// WHOIS 兜底文本解析(无 RDAP 的 ccTLD): 标签->规范 key 字典 + 多格式解析器(详见该文件)。fmtDate 也由它统一提供。
import { parseWhois, fmtDate } from './whois-labels.js'

// 域名无 RDAP(典型 .de 等 ccTLD)时的 WHOIS over HTTP 兜底(CF Worker, 源码见 whois-worker/)。
// 海外直连 worker; 境内(edge=cn)经 CN 机器 /whois 中转(直连 workers.dev 连通性差)。见 deploy/cn.peer.as.Caddyfile。
const WHOIS_WORKER = 'https://peer-as-whois.archeb.workers.dev/'
// CN 优化: 数据切到 cn.peer.as 时可走同源反代(留接口, 未部署则仍直连)。见研究文档 §5.1。
function cnProxy() {
  return (S.edge === 'cn' && typeof location !== 'undefined') ? null : null  // 预留: 返回反代 base 即启用
}

// ── bootstrap 查找 ────────────────────────────────────────────────
// service 条目 = [ [范围串...], [base url...] ]; 取第一个 https base, 保证以 '/' 结尾。
function pickBase(svc) {
  const urls = svc[1] || []
  let u = urls.find(x => x.startsWith('https://')) || urls[0]
  if (!u) return null
  return u.endsWith('/') ? u : u + '/'
}
function asnBase(asn) {
  for (const svc of BOOT.asn || []) {
    for (const r of svc[0]) {
      const dash = r.indexOf('-')
      const lo = +(dash < 0 ? r : r.slice(0, dash))
      const hi = +(dash < 0 ? r : r.slice(dash + 1))
      if (asn >= lo && asn <= hi) return pickBase(svc)
    }
  }
  return null
}
// IPv4 CIDR "41.0.0.0/8" 是否含地址整数 n
function v4Has(cidr, n) {
  const sl = cidr.indexOf('/'); const net = ip2int(cidr.slice(0, sl)); const plen = +cidr.slice(sl + 1)
  if (net == null) return false
  const size = Math.pow(2, 32 - plen)
  return n >= net && n <= net + size - 1
}
function v6Has(cidr, n) {
  const sl = cidr.indexOf('/'); const net = ip6ToBig(cidr.slice(0, sl)); const plen = BigInt(cidr.slice(sl + 1))
  if (net == null) return false
  const host = 128n - plen
  const start = (net >> host) << host
  return n >= start && n <= (start | ((1n << host) - 1n))
}
// 域名 -> TLD 注册局 RDAP base(据 dns bootstrap 末位标签匹配)。命中失败返回 null(转 WHOIS 兜底)。
function domainBase(domain) {
  const labels = String(domain).toLowerCase().replace(/\.$/, '').split('.')
  const tld = labels[labels.length - 1]
  for (const svc of BOOT.dns || []) for (const t of svc[0]) if (String(t).toLowerCase() === tld) return pickBase(svc)
  return null
}
// IP/前缀(取网络起始地址)定位 RIR base。addr 形如 '1.1.1.0/24' 或 '2001:db8::/32' 或裸 IP。
function ipBase(addr, v6) {
  const a = addr.split('/')[0]
  if (v6) {
    const n = ip6ToBig(a); if (n == null) return null
    for (const svc of BOOT.ipv6 || []) for (const c of svc[0]) if (v6Has(c, n)) return pickBase(svc)
  } else {
    const n = ip2int(a); if (n == null) return null
    for (const svc of BOOT.ipv4 || []) for (const c of svc[0]) if (v4Has(c, n)) return pickBase(svc)
  }
  return null
}

// ── jCard / 响应拍平 ──────────────────────────────────────────────
// 行 = {key, value}; key 是规范语义串(Whois.svelte 映射到图标+i18n 标签), 未知 key 原样显示。
const VCARD_KEY = { fn: 'fullname', org: 'org', adr: 'address', tel: 'phone', email: 'email', kind: 'kind', role: 'role', title: 'title', url: 'url' }
const EVENT_KEY = { registration: 'registration', 'last changed': 'lastchanged', expiration: 'expiration', reregistration: 'lastchanged', 'last update of RDAP database': 'rdapupdated' }

function vcardRows(entity) {
  const arr = entity?.vcardArray?.[1]
  if (!Array.isArray(arr)) return []
  const rows = []
  for (const item of arr) {
    const [prop, params, , value] = item
    if (prop === 'version') continue
    let key = VCARD_KEY[prop] || prop
    let v
    if (prop === 'adr') v = (params && params.label) ? params.label.replace(/\s*\n+\s*/g, ', ') : (Array.isArray(value) ? value.filter(Boolean).join(', ') : value)
    else if (Array.isArray(value)) v = value.filter(Boolean).join(' ')
    else v = value
    if (prop === 'tel' && params && /fax/i.test(params.type || '')) key = 'fax'
    v = (v == null ? '' : String(v)).trim()
    if (v && !rows.some(r => r.key === key && r.value === v)) rows.push({ key, value: v })
  }
  return rows
}

function entityName(e) {
  const fn = e?.vcardArray?.[1]?.find(x => x[0] === 'fn')
  return (fn && fn[3]) || e.handle || (e.roles && e.roles[0]) || '?'
}

function normEntity(e, depth = 0) {
  return {
    handle: e.handle || null,
    roles: e.roles || [],
    name: entityName(e),
    rows: vcardRows(e),
    entities: depth < 4 ? (e.entities || []).map(s => normEntity(s, depth + 1)) : [],
  }
}

function eventsRows(d) {
  const out = []
  for (const ev of d.events || []) {
    const k = EVENT_KEY[ev.eventAction]
    if (k && k !== 'rdapupdated') out.push({ key: k, value: fmtDate(ev.eventDate) })
  }
  return out
}
// 把原始 RDAP 对象规范化成渲染模型
export function normalize(kind, key, d) {
  const head = []
  if (kind === 'autnum') {
    head.push({ key: 'handle', value: d.handle || `AS${key}` })
    if (d.name) head.push({ key: 'name', value: d.name })
    if (d.startAutnum != null) head.push({ key: 'asrange', value: d.startAutnum === d.endAutnum ? `AS${d.startAutnum}` : `AS${d.startAutnum} – AS${d.endAutnum}` })
  } else if (kind === 'domain') {
    head.push({ key: 'ldhname', value: d.ldhName || key })
    if (d.unicodeName && d.unicodeName !== d.ldhName) head.push({ key: 'name', value: d.unicodeName })
    if (d.handle) head.push({ key: 'handle', value: d.handle })
  } else {
    if (d.name) head.push({ key: 'name', value: d.name })
    head.push({ key: 'handle', value: d.handle || key })
    if (d.startAddress) head.push({ key: 'iprange', value: `${d.startAddress} – ${d.endAddress}` })
    const cidr = (d.cidr0_cidrs || []).map(c => `${c.v4prefix || c.v6prefix}/${c.length}`).join(', ')
    if (cidr) head.push({ key: 'cidr', value: cidr })
    if (d.type) head.push({ key: 'iptype', value: d.type })
    if (d.parentHandle) head.push({ key: 'parent', value: d.parentHandle })
  }
  if (d.country) head.push({ key: 'country', value: d.country })
  if (d.status && d.status.length) head.push({ key: 'status', value: d.status.join(', ') })
  head.push(...eventsRows(d))
  if (kind === 'domain') {
    for (const ns of d.nameservers || []) { const v = ns.ldhName || ns.handle; if (v) head.push({ key: 'ns', value: v }) }
    if (d.secureDNS) head.push({ key: 'dnssec', value: d.secureDNS.delegationSigned ? 'signed' : 'unsigned' })
  }
  const remarks = []
  for (const r of d.remarks || []) {
    const txt = (r.description || []).join('\n').trim()
    if (txt) remarks.push({ key: 'remark', title: r.title || '', value: txt })
  }
  return {
    kind, key,
    title: kind === 'autnum' ? (d.handle || `AS${key}`) : kind === 'domain' ? (d.ldhName || key) : (d.handle || key),
    head,
    entities: (d.entities || []).map(e => normEntity(e)),
    remarks,
    port43: d.port43 || null,
    raw: d,
  }
}

// ── WHOIS 兜底 ────────────────────────────────────────────────────
// 无 RDAP 的 ccTLD: 全文解析 + 标签->规范 key 映射全部抽到 ./whois-labels.js(parseWhois), 见其文件头。
// 调 worker 取 whois(application/json -> {server,domain,whois})。失败/空抛错, 由调用方决定是否再降级。
// 境内经 CN 机器 /whois 中转; referrerPolicy 保证跨域中转时带本站 Referer(过 Caddy 白名单)。
async function whoisFallback(domain) {
  const b = cnProxyBase()
  const url = (b == null ? WHOIS_WORKER + '?domain=' : `${b}/whois?domain=`) + encodeURIComponent(domain)
  const res = await fetch(url, { headers: { Accept: 'application/json' }, referrerPolicy: 'strict-origin-when-cross-origin' })
  if (!res.ok) { const e = new Error(`WHOIS HTTP ${res.status}`); e.status = res.status; throw e }
  const j = await res.json()
  if (!j || !j.whois || !String(j.whois).trim()) throw new Error('WHOIS empty')
  return parseWhois(domain, j.server || '', j.whois)
}

// ── fetch + 缓存 ──────────────────────────────────────────────────
const mem = new Map()   // `${kind}:${key}` -> Promise<normalized>

async function httpGet(url) {
  const res = await fetch(url, { headers: { Accept: 'application/rdap+json' }, redirect: 'follow' })
  let body = null
  try { body = await res.json() } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    const msg = body && (body.title || (body.description || [])[0]) ? (body.title || body.description[0]) : `HTTP ${res.status}`
    const err = new Error(msg); err.status = res.status; throw err
  }
  return { body, host: (() => { try { return new URL(res.url).host } catch { return '' } })() }
}

async function doFetch(kind, key) {
  const ssKey = `rdap:${kind}:${key}`
  // 读缓存: **只有成功的查询会被写入**(见下)。若旧坏条目解析/规范化失败(历史 bug 残留的 {body:null} 等),
  // 当作未命中并**清掉它**, 走实时查询 —— 失败的请求绝不会卡在缓存里。
  try {
    const cached = sessionStorage.getItem(ssKey)
    if (cached) {
      const o = JSON.parse(cached)
      if (o.whois) return parseWhois(key, o.server, o.text)   // 上次走的 WHOIS 兜底
      const n = normalize(kind, key, o.body); n.source = o.host; return n
    }
  } catch (e) {
    try { sessionStorage.removeItem(ssKey) } catch (_) { /* ignore */ }
  }

  const v6 = kind === 'ip' && String(key).includes(':')
  const base = kind === 'autnum' ? asnBase(+key) : kind === 'domain' ? domainBase(key) : ipBase(String(key), v6)
  const path = kind === 'autnum' ? `autnum/${key}` : kind === 'domain' ? `domain/${encodeURIComponent(key)}` : `ip/${key}`
  // 只查 bootstrap 解析出的权威 RDAP base(+ 可选 CN 反代)。**无第三方兜底**: base 为空就不发请求。
  const tries = []
  const proxy = cnProxy()
  if (proxy) tries.push(proxy + path)
  if (base) tries.push(base + path)

  let lastErr
  for (const url of tries) {
    try {
      const { body, host } = await httpGet(url)
      const n = normalize(kind, key, body); n.source = host   // **先 normalize 成功**再写缓存: 绝不缓存无法解析的 body。
      try { sessionStorage.setItem(ssKey, JSON.stringify({ body, host })) } catch (e) { /* 配额/隐私模式忽略 */ }
      return n
    } catch (e) {
      lastErr = e
      if (e.status === 404) break   // 明确不存在: 停止 RDAP 重试(域名转 WHOIS 兜底)
    }
  }
  // 域名: RDAP 全失败(无 RDAP 的 ccTLD / 404)时回退 WHOIS。兜底再失败则抛原 RDAP 错。
  if (kind === 'domain') {
    try {
      const n = await whoisFallback(key)
      try { sessionStorage.setItem(ssKey, JSON.stringify({ whois: true, server: n.source, text: n.rawWhois })) } catch (e) { /* 忽略 */ }
      return n
    } catch (we) { /* 落到下面抛 RDAP 错 */ }
  }
  // **失败收尾**: 清掉该 key 的任何缓存条目(本次或历史残留), 保证下次是干净的实时重试, 不会"永远返回错误"。
  try { sessionStorage.removeItem(ssKey) } catch (e) { /* ignore */ }
  throw lastErr || new Error('RDAP fetch failed')
}

// 公共入口: 返回规范化模型(带 .source 主机名)。同 key 并发去重、跨刷新走 sessionStorage。
export function fetchRdap(kind, key) {
  const k = `${kind}:${key}`
  if (mem.has(k)) return mem.get(k)
  const p = doFetch(kind, key).catch(e => { mem.delete(k); throw e })
  mem.set(k, p)
  return p
}

export const rdapAsn = asn => fetchRdap('autnum', String(asn))
export const rdapIp = prefix => fetchRdap('ip', String(prefix))
export const rdapDomain = domain => fetchRdap('domain', String(domain).toLowerCase().replace(/\.$/, ''))

// 「IP 所属组织」= 前缀(inetnum)的登记持有者, 可能是承载 AS 的下游企业, 与 origin ASN(运营商)是两回事。
// 从 IP 的 RDAP 规范化模型里抽: 优先 registrant/administrative 实体的 org 行或实体名, 回退 netname。
export function ipHolder(n) {
  if (!n) return null
  const ents = n.entities || []
  const pick = ents.find(e => (e.roles || []).includes('registrant'))
    || ents.find(e => (e.roles || []).includes('administrative'))
    || ents[0]
  let org = ''
  if (pick) {
    const r = (pick.rows || []).find(x => x.key === 'org')
    org = (r && r.value) || (pick.name && pick.name !== '?' ? pick.name : '')
  }
  const row = k => ((n.head || []).find(x => x.key === k) || {}).value || ''
  return { org, netname: row('name'), cc: row('country') }
}

// 便捷: 取前缀持有者组织名(org 优先, 回退 netname); 失败/无则空串。复用 rdapIp 的缓存。
export async function holderOrg(prefix) {
  try { const h = ipHolder(await rdapIp(prefix)); return (h && (h.org || h.netname)) || '' }
  catch { return '' }
}
