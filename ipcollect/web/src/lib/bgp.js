// AS_PATH / ASN / geo 纯逻辑 (从 web_ref/app.js 移植)。读 S.meta / S.lang 故有响应性。
import { S } from './store.svelte.js'
import { SITE } from './site.js'

const OP_CLS = { '电信': 'op-ct', '联通': 'op-cu', '移动': 'op-cm', '国际': 'op-intl' }
// 运营商(op)分类的英文显示名(i18n)。op 仅几个固定类别, 故在前端维护译名(类似 UI 词表), 不进 config。
const OP_EN = { '电信': 'Telecom', '联通': 'Unicom', '移动': 'Mobile', '国际': 'International', '其他': 'Other' }
export const TIER1 = new Set([174, 701, 702, 1239, 1299, 2828, 2914, 3257, 3320, 3356, 3491,
  5511, 6453, 6461, 6762, 6830, 6939, 7018, 7473, 12956, 1273, 3549, 3551, 209])

// CJK 判断/剥离: 英文界面下从中文别名/地名里滤出拉丁部分, 避免英中混排。
const CJK_RE = /[㐀-鿿豈-﫿぀-ヿ]/
export const hasCJK = s => CJK_RE.test(s || '')
const stripCJK = s => (s || '').replace(/[㐀-鿿豈-﫿぀-ヿ]+/g, '').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim()

// ASN 名(语言感知)。zh: 注册表中文别名优先 → APNIC 全量名。
// en: 注册表英文别名(asn_names_en) → APNIC 英文名(非中文) → 从中文别名滤出的拉丁部分(CN2/CUII/CERNET…) → 兜底。
export function asnName(a) {
  const reg = S.meta && S.meta.asn_names && S.meta.asn_names[a]
  const full = S.asnNames && S.asnNames[a]
  if (S.lang === 'zh') return reg || full || ''
  const en = S.meta && S.meta.asn_names_en && S.meta.asn_names_en[a]
  if (en) return en
  if (full && !hasCJK(full)) return full
  const base = reg || full || ''
  return stripCJK(base) || full || base
}
export const asnOrg = a => (S.asnOrg && S.asnOrg[a]) || ''     // GeoLite organization(全名)
export const opOf = a => (S.meta && S.meta.asn_ops && S.meta.asn_ops[a]) || ''   // 原始分类(中文 key; 用于配色/排序)
export const opText = a => { const o = opOf(a); return (S.lang !== 'zh' && OP_EN[o]) ? OP_EN[o] : o }   // 显示用(语言感知)
export const opCls = a => OP_CLS[opOf(a)] || ''
export const isTier1 = a => TIER1.has(+a)

// 邻居关系判定(基于收集器路径方向 + Tier-1 集合)。
// 路径方向: index0=收集器侧(上行/朝全表), 末位=origin(下行/朝边缘)。
//   Y 在 X 的 origin 侧(arr[i+1]) ⇒ X 把 Y 的路由往上扩散 ⇒ Y 多半是 X 的「客户(down)」, 可靠;
//   Y 在 X 的收集器侧(arr[i-1]) ⇒ Y 可能是 X 的 provider, 也可能只是 peer/收集器位置假象, 不可靠。
// 入参 d=origin 侧出现次数, u=**经 Tier-1 校验后**的收集器侧上游证据次数(调用方已剔除 full-feed 假象)。
// 原则: 只有绝对证据才判上游/下游, 其余一律 peer(不臆测方向)。返回 'up'|'down'|'peer'。
const REL_HI = 0.8, REL_LO = 0.2          // 方向比阈值: ≥HI 判客户, ≤LO 判上游, 居中判 peer
export function classifyRelation(x, y, d, u) {
  const xt = TIER1.has(+x), yt = TIER1.has(+y)
  if (xt && yt) return 'peer'            // 两个 Tier-1 之间只可能对等(无客户/供应商), 与方向无关
  if (yt && !xt) return 'up'              // 对方是 Tier-1、本侧不是 ⇒ 上游(绝对证据)
  const tot = d + u
  if (!tot) return 'peer'                  // 无任何可靠方向证据(如仅 full-feed 假象) ⇒ peer
  const r = d / tot                        // 越接近 1 越像客户, 越接近 0 越像上游
  if (r >= REL_HI) return 'down'           // 强烈偏 origin 侧 ⇒ 客户(绝对证据)
  if (!xt && r <= REL_LO) return 'up'      // 强烈偏收集器侧(u 已过 Tier-1 校验) ⇒ 上游; Tier-1 无上游故排除
  return 'peer'                            // 方向混杂 / Tier-1 自身 / 证据不足 ⇒ 对端
}

// 地名(语言感知): 省+市拼接。英文界面滤掉 CJK 段(geo 里日韩等城市可能是中文名 + 英文省 -> 避免混排);
// 滤空则回退英文国名(ccLabel)。中文界面原样显示。
export function placeLabel(province, city, cc) {
  let parts = [province, city].filter(Boolean)
  if (S.lang !== 'zh') parts = parts.filter(p => !hasCJK(p))
  return parts.join(' ') || (cc ? ccLabel(cc) : '')
}

// 国家/地区名覆盖(必须先于 Intl.DisplayNames): CN/TW/HK/MO 的规范表述。
const CC_OVERRIDE = {
  zh: { CN: '中国大陆', TW: '中国台湾', MO: '中国澳门', HK: '中国香港' },
  en: { CN: 'Chinese Mainland', TW: 'Taiwan, China', MO: 'Macao', HK: 'Hong Kong' },
}
let _region = {}
export function regionName(cc) {
  const lang = S.lang === 'zh' ? 'zh' : 'en'
  if (CC_OVERRIDE[lang][cc]) return CC_OVERRIDE[lang][cc]
  try {
    _region[lang] = _region[lang] || new Intl.DisplayNames([lang], { type: 'region' })
    const n = _region[lang].of(cc); if (n && n !== cc) return n
  } catch (e) { /* ignore */ }
  const m = lang === 'zh' ? (S.meta && S.meta.country_names) : (S.meta && S.meta.country_names_en)
  return (m && m[cc]) || cc
}
export const ccLabel = cc => `${regionName(cc)} (${cc})`

// 低可见阈值按 family 取(v6 全网 peer 数远少, 自有 dfz_ref_v6)。
export const lowCutFor = v6 => Math.max(3, 0.2 * ((v6 ? (S.meta && S.meta.dfz_ref_v6) : (S.meta && S.meta.dfz_ref)) || 1))
export const lowCut = () => lowCutFor(false)
export const isLowVis = r => !!r && r.n_paths != null && S.meta && r.n_paths < lowCutFor((r.prefix || '').includes(':'))

const short = s => (s && s.length > 22) ? s.slice(0, 21) + '…' : s
// AS_PATH -> [{asn,name,nameShort,op,cls,tier1}]  (供 <AsPath> 渲染; nameShort 防超长 handle 撑爆路径)
export function pathTokens(asns) {
  return (asns || []).map(a => {
    const name = asnName(a)
    return { asn: a, name, nameShort: short(name), op: opText(a), cls: opCls(a), tier1: TIER1.has(+a) }
  })
}
export const parseBest = s => (s ? s.trim().split(/\s+/).map(Number) : [])

export const sqlStr = s => "'" + String(s).replace(/'/g, "''") + "'"

export function ip2int(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec((s || '').trim())
  if (!m) return null
  let n = 0
  for (let i = 1; i <= 4; i++) { const o = +m[i]; if (o > 255) return null; n = n * 256 + o }
  return n >>> 0
}
export const int2ip = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')

// IPv4 地址或 CIDR -> {start,end,plen,isCidr}; 纯 IP 视作单点(/32)。非法返回 null。
export function ip2range(s) {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\/(\d{1,2}))?$/.exec((s || '').trim())
  if (!m) return null
  const base = ip2int(m[1])
  if (base === null) return null
  if (m[2] === undefined) return { start: base, end: base, plen: 32, isCidr: false }
  const plen = +m[2]
  if (plen > 32) return null
  const size = Math.pow(2, 32 - plen)        // plen=0 -> 2^32, 仍在安全整数内
  const start = base - (base % size)          // 对齐到网络地址
  return { start, end: start + size - 1, plen, isCidr: true }
}

// IPv6 地址串 -> BigInt(128 位); 支持一个 :: 压缩。非法返回 null。
export function ip6ToBig(s) {
  s = (s || '').trim()
  if (!s.includes(':') || !/^[0-9a-fA-F:]+$/.test(s)) return null
  if (s.indexOf('::') !== s.lastIndexOf('::')) return null      // 至多一个 ::
  let groups
  if (s.includes('::')) {
    const [h, t] = s.split('::')
    const hp = h ? h.split(':') : [], tp = t ? t.split(':') : []
    const fill = 8 - hp.length - tp.length
    if (fill < 0) return null
    groups = [...hp, ...Array(fill).fill('0'), ...tp]
  } else groups = s.split(':')
  if (groups.length !== 8) return null
  let n = 0n
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    n = (n << 16n) | BigInt(parseInt(g, 16))
  }
  return n
}

// IPv6 地址或 CIDR -> {start,end,plen,isCidr} (start/end 为 BigInt)。非法返回 null。
export function ip6Range(s) {
  const m = /^([0-9a-fA-F:]+)(?:\/(\d{1,3}))?$/.exec((s || '').trim())
  if (!m) return null
  const base = ip6ToBig(m[1])
  if (base === null) return null
  if (m[2] === undefined) return { start: base, end: base, plen: 128, isCidr: false }
  const plen = +m[2]
  if (plen > 128) return null
  const host = 128n - BigInt(plen)
  const start = (base >> host) << host
  return { start, end: start | ((1n << host) - 1n), plen, isCidr: true }
}

// 域名判定: 多段标签 + 字母(或 xn--)结尾的 TLD; 不含空格/斜杠。用于把 "mozz.ie" 这类带点但非 IP 的串
// 路由到 DNS 解析(而非当作 AS 名称搜索)。允许 IDN(\p{L} 含 Unicode 字母)与末尾点。
const DOMAIN_RE = /^(?=.{1,253}\.?$)([\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+([\p{L}]{2,}|xn--[\p{L}\p{N}-]{2,})\.?$/u
// dn42 站: TLD 允许字母开头的字母数字(如 .dn42), 否则 foo.dn42 不会被识别为域名。
const DOMAIN_RE_DN42 = /^(?=.{1,253}\.?$)([\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+([\p{L}][\p{L}\p{N}]+|xn--[\p{L}\p{N}-]{2,})\.?$/u
const ACTIVE_DOMAIN_RE = SITE === 'dn42' ? DOMAIN_RE_DN42 : DOMAIN_RE
export const isDomain = s => ACTIVE_DOMAIN_RE.test((s || '').trim())

// 常见「二级公共后缀」(SLD): 形如 co.uk / com.cn / com.au / co.jp / ne.jp / gov.cn …。
// 用于把子域名缩略到可注册域名(eTLD+1)做 WHOIS/RDAP —— RDAP 域名查询通常只对可注册域名有效。
// 轻量启发式(非完整 PSL): 命中即多取一段。覆盖绝大多数真实场景, 不引入 ~200KB 的 Public Suffix List。
const SLD = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gr',
  'lg', 'ed', 'ad', 'sch', 'mil', 'in', 'idv', 'asn', 'id', 'biz', 'info', 'name'])
// 域名 -> 可注册域名(根域名)。'a.b.example.co.uk' -> 'example.co.uk'; 'mail.google.com' -> 'google.com'。
export function registrableDomain(domain) {
  const labels = String(domain || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  // 倒数第二段是常见二级后缀(co.uk / com.cn) 且还有更前段 -> 取末三段; 否则取末二段。
  if (SLD.has(labels[labels.length - 2])) return labels.slice(-3).join('.')
  return labels.slice(-2).join('.')
}

// as-set 名判定: AS-FOO(扁平) / AS2914:AS-GLOBAL(层级) / RADB::AS-FOO(显式来源键)。排除纯 ASN 与 IPv6。
// 用于把这类查询路由到 as-set 嵌套列表视图(而非 IPv6 / AS 名称搜索)。
export function isAsSet(s) {
  const u = (s || '').trim().toUpperCase()
  if (!u || /\s/.test(u)) return false
  if (!/^[A-Z0-9:_.-]+$/.test(u)) return false
  if (/^AS\d+$/.test(u)) return false                 // 纯 ASN 不是 as-set
  if (u.includes('::')) return /::AS-?\w/.test(u)      // SOURCE::AS-FOO 显式来源键
  return /^AS-/.test(u) || /^AS\d+:AS/.test(u) || /:AS-/.test(u)
}

// 把精确框文本归类成查询类型并路由: asn / ipv4 / ipv6 / domain / asset / text / empty
export function classifyQuery(s) {
  s = (s || '').trim()
  if (!s) return { kind: 'empty' }
  if (isAsSet(s)) return { kind: 'asset', key: s.toUpperCase() }  // as-set 嵌套列表(须早于 ':' -> IPv6 分支)
  if (s.includes(':')) {                                        // 冒号 -> IPv6
    const r = ip6Range(s)
    return r ? { kind: 'ipv6', ...r } : { kind: 'text' }
  }
  if (s.includes('.') || s.includes('/')) {                     // 点分十进制 / 带掩码 -> IPv4
    const r = ip2range(s)
    if (r) return { kind: 'ipv4', ...r }
    if (isDomain(s)) return { kind: 'domain', domain: s.toLowerCase().replace(/\.$/, '') }  // 域名 -> DNS 解析
    return { kind: 'text' }
  }
  const asm = /^(?:asn?\s*)?([0-4]?\d{1,9})$/i.exec(s)  // 纯数字 或 AS/ASN 前缀(大小写均可) -> ASN
  if (asm) return { kind: 'asn', asn: parseInt(asm[1], 10) }
  return { kind: 'name', q: s }   // 其余(含字母, 无点/冒号/斜杠) -> 按 AS 名称搜索, 反推 origin ASN
}

// AS 名称 -> origin ASN 反查。索引(asn -> 小写名)由全量 asnames.json + 注册表(meta.asn_names, 含中文运营商名)
// 合并而成, 同一 ASN 的多个名都收录(故中/英名都能命中); 按 meta/asnNames 条目数做轻量缓存键, 变了才重建。
let _nidx = null, _nidxKey = ''
function nameIndex() {
  const full = S.asnNames || {}, reg = (S.meta && S.meta.asn_names) || {}, regEn = (S.meta && S.meta.asn_names_en) || {}
  const key = Object.keys(full).length + ':' + Object.keys(reg).length + ':' + Object.keys(regEn).length
  if (_nidx && _nidxKey === key) return _nidx
  const arr = []
  const add = (k, name) => { if (!name) return; const a = +k; if (a) arr.push({ asn: a, nl: String(name).toLowerCase() }) }
  for (const k in reg) add(k, reg[k])
  for (const k in regEn) add(k, regEn[k])     // 英文别名(CERNET/CMIN2…)也可搜
  for (const k in full) add(k, full[k])
  _nidx = arr; _nidxKey = key; return arr
}
// 返回 { asns:[origin...], more } : 子串(忽略大小写)命中, 按 精确=0 / 词首=1 / 子串=2 排序, 同 ASN 去重, 截断到 cap。
export function asnsMatchingName(query, cap = 200) {
  const ql = (query || '').trim().toLowerCase()
  if (!ql) return { asns: [], more: false }
  const best = new Map()
  for (const { asn, nl } of nameIndex()) {
    const i = nl.indexOf(ql); if (i < 0) continue
    const rank = nl === ql ? 0 : (i === 0 || /\W/.test(nl[i - 1]) ? 1 : 2)
    const prev = best.get(asn); if (prev == null || rank < prev) best.set(asn, rank)
  }
  const hits = [...best.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])
  return { asns: hits.slice(0, cap).map(h => h[0]), more: hits.length > cap }
}

export function parseSeq(str) {
  return (str || '').trim().replace(/->/g, ' ').replace(/,/g, ' ')
    .split(/\s+/).filter(x => /^\d+$/.test(x)).map(Number)
}
export function seqIn(asns, seq) {
  if (!seq.length) return true
  const n = asns.length, m = seq.length
  for (let i = 0; i + m <= n; i++) {
    let ok = true
    for (let j = 0; j < m; j++) if (asns[i + j] !== seq[j]) { ok = false; break }
    if (ok) return true
  }
  return false
}

// ── AS_PATH 高级查询: 通配 + 排除 ──────────────────────────────────────────────
// 语法: 数字=ASN; `*`=任意间隔(含 0 跳, 同一条路径内); `?`=正好一跳; `!N`/`-N`=排除该 ASN(整条路径都不含)。
//   1299 4538      相邻
//   1299 * 4538    1299 在 4538 之前(任意间隔, 同一路径)
//   1299 ? 4538    中间正好 1 跳
//   4538 !174      含 4538、且全程不经 174
// paths_blob 形如 ' a b c | d e f ': 用 `[0-9]` 字符类(不含 `|`)保证序列匹配锁在同一条路径内,
// 不会出现「A 在路径1、B 在路径2」的假命中。
function _normWild(include) {     // 去首尾通配 + 合并连续通配(任一 * 则为 *, 否则 ? 计数累加)
  const a = include.slice()
  while (a.length && (a[0] === '*' || a[0] === '?')) a.shift()
  while (a.length && (a[a.length - 1] === '*' || a[a.length - 1] === '?')) a.pop()
  const out = []
  for (const tok of a) {
    const prev = out[out.length - 1]
    if ((tok === '*' || tok === '?') && prev && (prev === '*' || typeof prev === 'object')) {
      if (tok === '*' || prev === '*') out[out.length - 1] = '*'
      else prev.q++           // 连续 ? 累加成 {q:n}
    } else if (tok === '?') out.push({ q: 1 })
    else out.push(tok)        // 数字 或 '*'
  }
  return out
}
// 把归一化 include 编译成锚定空格的正则源(对 blob 与单路径串都适用)
function _reSource(norm) {
  let re = ' '
  for (const tok of norm) {
    if (tok === '*') re += '(?:[0-9]+ )*'
    else if (typeof tok === 'object') re += '(?:[0-9]+ ){' + tok.q + '}'   // 正好 q 跳
    else re += tok + ' '
  }
  return re
}
export function parsePathQuery(str) {
  const raw = (str || '').trim().replace(/->/g, ' ').replace(/,/g, ' ').split(/\s+/).filter(Boolean)
  const include0 = [], excludes = []
  for (const tok of raw) {
    if (/^\*+$/.test(tok)) { include0.push('*'); continue }       // 一个或多个 * 都视作任意间隔
    if (/^\?+$/.test(tok)) { for (let i = 0; i < tok.length; i++) include0.push('?'); continue }  // ?? = 两跳
    const ex = /^[!-](\d+)$/.exec(tok); if (ex) { excludes.push(+ex[1]); continue }
    const m = /^(\d+)$/.exec(tok); if (m) include0.push(+m[1])
  }
  const norm = _normWild(include0)
  const nums = norm.filter(x => typeof x === 'number')
  const wildcard = norm.some(x => x === '*' || typeof x === 'object')
  return { include: norm, nums, excludes, wildcard, hasInclude: norm.length > 0, reSource: norm.length ? _reSource(norm) : null }
}
// 编译查询: 提供 SQL 条件、best-path 排序表达式、单路径 JS 匹配、状态栏摘要。
export function compilePathQuery(str) {
  const q = parsePathQuery(str)
  const empty = !q.hasInclude && !q.excludes.length
  const re = q.reSource ? new RegExp(q.reSource) : null
  return {
    ...q, empty,
    // WHERE 条件数组(作用于给定列, 通常 'paths_blob')
    sqlConds(col) {
      const c = []
      if (q.hasInclude) c.push(q.wildcard
        ? `regexp_matches(${col}, ${sqlStr(q.reSource)})`
        : `${col} LIKE ${sqlStr('% ' + q.nums.join(' ') + ' %')}`)
      for (const x of q.excludes) c.push(`${col} NOT LIKE ${sqlStr('% ' + x + ' %')}`)
      return c
    },
    // best_path 命中 include -> 置顶★(排序用); 无 include 返回 null
    sqlBest(bestCol) {
      if (!q.hasInclude) return null
      return q.wildcard
        ? `regexp_matches(${bestCol}, ${sqlStr(q.reSource)})`
        : `${bestCol} LIKE ${sqlStr('% ' + q.nums.join(' ') + ' %')}`
    },
    // 单条路径(asn 数组)是否命中 include 序列 — 抽屉里高亮用
    test(asns) { return re ? re.test(' ' + (asns || []).join(' ') + ' ') : true },
    // 路径字符串(best_path, 已带首尾空格)是否命中 include
    testStr(s) { return re && s ? re.test(s) : false },
    // 状态栏可读摘要
    summary() {
      const parts = []
      if (q.hasInclude) parts.push(q.include.map(t => t === '*' ? '*' : typeof t === 'object' ? '?'.repeat(t.q) : t).join(' '))
      for (const x of q.excludes) parts.push('!' + x)
      return parts.join(' ')
    },
  }
}
export function truncToTier1(asns) {
  // 从最上游(数组头)往下找**第一个** Tier-1, 保留它到 origin 的整段 ⇒ 图的末端(最上游列)恒为 Tier-1,
  // 且经多个 Tier-1 转接的链完整保留(如 1299→174→origin、3549→3356→174→origin);
  // origin 之上、最上游 Tier-1 之前的非 Tier-1(IXP/小上游)被裁掉, 以保证「末端为 Tier-1」。
  for (let i = 0; i < asns.length; i++) if (TIER1.has(asns[i])) return asns.slice(i)
  return asns.length > 1 ? asns.slice(1) : asns
}

// 区间 [{s,e}] -> 最简 CIDR (不用位运算防 32 位溢出; BigInt 转 Number)
export function rangesToCidrs(segs) {
  const out = []
  const merged = Array.from(segs || []).map(o => [Number(o.s), Number(o.e)]).sort((a, b) => a[0] - b[0])
  for (let [s, e] of merged) {
    while (s <= e) {
      let size = 1, plen = 32
      while (plen > 0) {
        const ns = s - (s % (size * 2))
        if (ns !== s || s + size * 2 - 1 > e) break
        size *= 2; plen--
      }
      out.push(`${int2ip(s)}/${plen}`)
      s += size
    }
  }
  return out
}
