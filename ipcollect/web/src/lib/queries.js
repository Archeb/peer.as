// 搜索 / insight 逻辑 (从 web_ref/app.js 移植), 结果写入 S。
import { S } from './store.svelte.js'
import { t } from './i18n.js'
import { q, rpList, pathsFileFor, pathsearchFilesForOrigin, pathsearchFilesForOrigins,
  byoriginFilesForOrigin, byoriginFilesForOrigins, originCountsFiles,
  prefixesFilesForRange, irrFilesForRange,
  assetSetFiles, assetSetFilesForKey, assetMemberFilesForKey, assetMemberOfFilesForKey, asnNeighFilesForAsn, ensureEngine } from './db.js'
import { resolveDns } from './dns.js'
import { features } from './site.js'
import { progressBegin, progressSet, progressFinish } from './progress.js'
import {
  int2ip, parseSeq, sqlStr, ccLabel, regionName, lowCut, lowCutFor, isLowVis, asnName, classifyQuery,
  asnsMatchingName, compilePathQuery, ip2range, ip6Range, parseBest, placeLabel, classifyRelation, isTier1,
  registrableDomain,
} from './bgp.js'

const NAME_CAP = 200   // AS 名称命中的 origin ASN 上限(过多则提示精确化)

// family 单选(S.filters.fam: 'all'|'4'|'6')过滤分片清单: v6 文件路径含 '_v6/'(geo_v6/、pathsearch_v6/)。
function byFam(files) {
  const fam = S.filters?.fam || 'all'
  if (fam === '4') return (files || []).filter(f => !f.includes('_v6/'))
  if (fam === '6') return (files || []).filter(f => f.includes('_v6/'))
  return files || []
}

let _ccMap = { lang: null, map: null }
function ccMap() {
  if (_ccMap.lang === S.lang && _ccMap.map) return _ccMap.map
  const m = {}
  ;(S.meta?.countries || []).forEach(c => { m[ccLabel(c.cc).toLowerCase()] = c.cc; m[c.cc.toLowerCase()] = c.cc })
  _ccMap = { lang: S.lang, map: m }
  return m
}
export function resolveCC(v) {
  v = (v || '').trim(); if (!v) return null
  return ccMap()[v.toLowerCase()] || (/^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null)
}

// 慢查询进度条(仅全表 AS_PATH 搜索用)。DuckDB-WASM 的单次 query 无分片级进度回调, 但成本主要由
// **本次扫描的字节数**决定(下载 + LIKE 扫描)。pathsearch 分片体积均匀(实测 v4 均 ~9.2MB / v6 ~7.5MB /
// 合 ~8.9MB, 构建有上限 cap ~12MB), 故可用「分片数 × 平均片大小」估出本次字节, 再除以学习到的吞吐(MB/s)
// 得 ETA, 把进度推进到 0.9, 查询返回时补满 1。
// _mbPerSec 由每次真实 elapsed 反推并 EWMA 校准 —— 首查用粗估, 之后越来越准(二次命中缓存吞吐更高, 自适应)。
// 注: SHARD_MB 这个常数在估计与校准里同时出现会约掉, 只影响首次冷查的绝对估计与显示的 MB 数;
//     构建改了分片尺寸也不影响后续估值准度。超出预估仍未返回时进度自然卡 0.9 涓流(NProgress 回退)。
const SHARD_MB = 9                                        // 实测平均分片大小(MB); cap ~12MB
let _mbPerSec = 10                                        // 学习到的有效吞吐(下载+扫描), 会被实测校准
let _progTimer = null, _progT0 = 0, _progMB = SHARD_MB
function progressStart(shards) {
  clearInterval(_progTimer)
  _progMB = Math.max(1, shards || 1) * SHARD_MB
  _progT0 = performance.now()
  const eta = _progMB / _mbPerSec * 1000                  // 预估时长(ms)
  progressBegin()
  _progTimer = setInterval(() => {
    progressSet((performance.now() - _progT0) / eta * 0.9)   // 推进到 0.9, 单调
  }, 100)
}
function progressDone() {
  clearInterval(_progTimer); _progTimer = null
  if (!S.busy) return
  const mbps = _progMB / ((performance.now() - _progT0) / 1000)
  if (mbps > 0.5 && mbps < 500) _mbPerSec = _mbPerSec * 0.7 + mbps * 0.3   // EWMA 校准(滤掉异常值)
  progressFinish()
}

let _timer = null
// 当前表格搜索(global/country/subnet)的 SQL 片段缓存, 供「数据导出」无 offset、大上限地复用整套查询。
// 仅这三种模式置之; domain/asset/空 置 null(导出按钮随之不可用)。
let _tableQuery = null
export function scheduleSearch(ms = 700) { clearTimeout(_timer); _timer = setTimeout(runSearch, ms) }
export function searchNow() { clearTimeout(_timer); runSearch() }

export async function runSearch(keepPage = false) {
  if (!S.ready) return
  if (!keepPage) S.page = 0          // 新搜索归首页; 翻页(gotoPage)调 runSearch(true) 保留 S.page
  _tableQuery = null                 // 默认清空; 仅 global/country/subnet 分支重新缓存
  const f = S.filters
  // 精确框(子网/express)优先：非空即抢占，其余筛选忽略(并在 UI 禁用)。
  const probe = classifyQuery(f.ip)
  // 域名 -> DNS 解析视图(左:记录, 右:域名详情面板); 抢占其它一切, 自成一支。
  // 域名: peeras 走 DoH 解析视图; dn42(无 DoH)直接展示 registry 域名 whois。
  if (probe.kind === 'domain') return features.dns ? runDns(probe.domain) : runDomainWhois(probe.domain)
  if (probe.kind === 'asset') return runAsSet(probe.key)   // as-set -> 左侧嵌套列表视图
  S.dns = null; S.asset = null   // 离开 DNS / as-set 模式: 清空, 主内容区回到结果表
  // 精确框是 ASN 时: 设为「主体」并自动展开右侧 ASN 详情面板(whois + 上下游)。其它输入(含 IP/空)清空
  // 主体上下文(影响关闭语义)。已在展示同一 ASN 则不打断(避免点开 prefix 后被搜索拽回)。放在子网早返回之前。
  setSubjectAsn(probe.kind === 'asn' ? probe.asn : null)
  if (probe.kind === 'ipv6' || probe.kind === 'ipv4') return runSubnet(probe, f)
  const boxAsn = probe.kind === 'asn' ? probe.asn : null   // 纯数字 -> origin AS, 可与国家/城市/AS_PATH 叠加

  // AS 名称搜索: 含字母的查询(name), 或带点但非合法 IP 的串(text, 如 amazon.com) -> 反推匹配的 origin ASN
  // (可能多个), 作为 origin 过滤集。
  let nameHit = null
  const nameQ = probe.kind === 'name' ? probe.q : (probe.kind === 'text' ? f.ip.trim() : null)
  if (nameQ != null) {
    nameHit = asnsMatchingName(nameQ, NAME_CAP)
    if (!nameHit.asns.length) {
      S.rows = []; S.mode = 'global'
      S.msg = (S.lang === 'zh' ? `无 ASN 名称匹配 “${nameQ}”` : `no ASN name matches “${nameQ}”`)
      return
    }
  }

  const cc = resolveCC(f.cc)
  const pq = compilePathQuery(f.path)       // AS_PATH 查询(支持 * ? ! 通配/排除); empty=无 path 条件
  const hasPath = !pq.empty
  // origin 过滤集: 来自纯数字框(单个) 或 名称反查(多个); null=不过滤 origin。
  // person 筛选(dn42, 取代国家/地区): 选定 person -> 用其 origin ASN 集合走全表 origin 过滤(复用 pathsearch)。
  let personAsns = null, personName = null
  if (f.person && f.person.trim()) {
    const p = (S.meta?.persons || []).find(x => x.id === f.person.trim())
    personAsns = p ? p.asns : []
    personName = p ? (p.name || p.id) : f.person.trim()
  }
  const originAsns = boxAsn != null ? [boxAsn] : (nameHit ? nameHit.asns : (personAsns || null))
  const city = (f.city || '').trim()
  const limit = Math.max(1, parseInt(f.limit || '500', 10))
  const inclLow = !!f.incllow

  // MOAS 角标列: geo/pathsearch 的 n_origins 是新增列, 旧数据无 -> 由 meta.has_n_origins 门控, 缺标志即不 SELECT
  // (避免新前端 + 旧数据 SELECT 缺列报错; 下次刷新后自动点亮)。结尾留空格以拼进列表。
  const moasCol = S.meta?.has_n_origins ? ' n_origins,' : ''
  // RPKI/IRR 状态列(门控: 旧数据无此列不 SELECT)。结尾留逗号以拼进列表。
  const statSel = (S.meta?.has_rpki ? ' rpki,' : '') + (S.meta?.has_irr ? ' irr,' : '')
  const w = []
  let fromExpr, cols, isGlobal = false, shardCount = 0   // shardCount: 全表 AS_PATH 扫描的分片数(进度条预估用)
  if (cc) {
    // 国家视图: v4 + v6 geo working-set 一起读(schema 一致, segs 均为 CIDR 串列表), 显示层合并。
    // 受 family 单选(f.fam: all/4/6)约束: byFam 只留对应 family 的分片。
    const geoFiles = byFam([...(S.meta?.files?.geo?.[cc] || []), ...(S.meta?.files?.geo_v6?.[cc] || [])])
    if (!geoFiles.length) { S.rows = []; S.mode = 'country'; S.msg = t('no_data_cc'); return }
    fromExpr = rpList(geoFiles)
    cols = `pid, prefix, city, province, plen, origin_asn,${statSel}${moasCol} n_paths, segs, best_path`
    if (city && S.meta?.cities?.[cc]) w.push(`city = ${sqlStr(city)}`)
  } else {
    if (!hasPath && !originAsns) { S.rows = []; S.mode = 'prompt'; S.msg = ''; return }
    isGlobal = true
    // 纯 origin 过滤(有 originAsns 且无 AS_PATH 子串)走 byorigin 轻量分片(无 paths_blob, 文件/footer ~10×↓);
    // 含 AS_PATH 子串(需 paths_blob)或纯 path 搜索仍走 pathsearch。缺 byorigin(旧数据)回退 pathsearch。
    const useBy = originAsns && !hasPath && S.meta?.has_byorigin
    const psAll = useBy ? byoriginFilesForOrigins(originAsns)
      : originAsns ? pathsearchFilesForOrigins(originAsns) : pathsearchFilesForOrigin(null)
    const psFiles = psAll === null ? [] : byFam(psAll)   // family 单选过滤
    if (!psFiles.length) {   // 无覆盖分片(origin 不在库, 或被 family 过滤空) -> 空结果, 不下任何文件
      S.rows = []; S.mode = 'global'
      const lbl = originLabel(originAsns, nameHit, nameQ, personName)
      S.msg = (S.lang === 'zh' ? `全表：显示 0 个前缀 · ${lbl}` : `global: 0 prefixes · ${lbl}`)
      return
    }
    fromExpr = rpList(psFiles)
    cols = `pid, prefix, cc, origin_asn,${statSel}${moasCol} n_paths, best_path`
    shardCount = psFiles.length
  }
  if (hasPath) for (const c of pq.sqlConds('paths_blob')) w.push(c)
  if (originAsns) w.push(originAsns.length === 1 ? `origin_asn = ${originAsns[0]}` : `origin_asn IN (${originAsns.join(',')})`)
  // MOAS: pathsearch 现按 (前缀,origin) 多行 -> 纯 AS_PATH 搜索(不按 origin)需 is_primary 去重回每前缀一行;
  // 按 origin 搜索时不去重(要的就是该 origin 那行, 含次要 origin)。仅新数据(has_moas)有此列。
  if (isGlobal && !originAsns && S.meta?.has_moas) w.push('is_primary')
  // 低可见阈值按 family 取(结果可能混 v4+v6): prefix 含 ':' 用 v6 阈值, 否则 v4。
  if (!inclLow) w.push(`n_paths >= (CASE WHEN prefix LIKE '%:%' THEN ${Math.ceil(lowCutFor(true))} ELSE ${Math.ceil(lowCutFor(false))} END)`)
  const bestExpr = pq.sqlBest('best_path')
  const order = (bestExpr ? `(${bestExpr}) DESC, ` : '') + 'n_paths DESC'
  const where = w.length ? w.join(' AND ') : ''
  const off = (S.page || 0) * limit
  const sql = `SELECT ${cols} FROM ${fromExpr} ${where ? 'WHERE ' + where : ''} ORDER BY ${order} LIMIT ${limit + 1}${off ? ` OFFSET ${off}` : ''}`
  _tableQuery = { src: fromExpr, where, cols, order, cc: cc || '' }   // 供导出复用

  const slow = isGlobal && hasPath          // 全表 AS_PATH 扫描: 唯一需要顶部进度条的慢操作
  S.msg = slow ? `${t('searching_global')} · ~${Math.round(shardCount * SHARD_MB)} MB` : t('querying')
  if (slow) progressStart(shardCount); else S.busy = true   // 普通查询: 状态行只转圈, 不显示进度条
  let rows
  try { rows = await q(sql) }
  catch (e) { if (slow) progressDone(); else S.busy = false; S.rows = []; S.msg = `${t('query_failed')}: ${e.message}`; return }
  if (slow) progressDone(); else S.busy = false
  const more = rows.length > limit; if (more) rows = rows.slice(0, limit)
  S.more = more
  rows.forEach(r => { r._best = !!(pq.hasInclude && pq.testStr(r.best_path)) })
  rows.sort((a, b) => (pq.hasInclude ? (b._best ? 1 : 0) - (a._best ? 1 : 0) : 0) || cmpBy('n_paths', -1, a, b))
  S.rows = rows
  S.mode = cc ? 'country' : 'global'
  S.sortKey = 'n_paths'; S.sortDir = -1

  const N = `${rows.length}${more ? '+' : ''}`
  const scope = cc ? `${ccLabel(cc)}${city ? ' · ' + city : ''}` : t('global')
  const oTxt = originAsns ? ` · ${originLabel(originAsns, nameHit, nameQ, personName)}` : ''
  const pTxt = hasPath ? (S.lang === 'zh' ? ` · path [${pq.summary()}]${pq.hasInclude ? '（★=落在最优路径）' : ''}` : ` · path [${pq.summary()}]${pq.hasInclude ? ' (★=on best path)' : ''}`) : ''
  S.msg = (S.lang === 'zh'
    ? `${scope}：显示 ${N} 个前缀${oTxt}${pTxt}` + (!inclLow ? ' · 已隐藏低可见' : '')
    : `${scope}: ${N} prefixes${oTxt}${pTxt}` + (!inclLow ? ' · low-vis hidden' : ''))
}

// origin 过滤的人类可读标签: 名称搜索显示 “名称→N 个 ASN(列前几个)”, 纯数字显示单个 origin AS。
function originLabel(asns, nameHit, nameQ, personName) {
  if (personName) return (S.lang === 'zh' ? `person ${personName}` : `person ${personName}`)
  if (nameHit && nameQ) {
    const n = asns.length
    const head = asns.slice(0, 6).map(a => 'AS' + a).join(', ')
    const tail = (n > 6 || nameHit.more) ? '…' : ''
    return (S.lang === 'zh'
      ? `名称 “${nameQ}” → ${n}${nameHit.more ? '+' : ''} 个 origin (${head}${tail})`
      : `name “${nameQ}” → ${n}${nameHit.more ? '+' : ''} origins (${head}${tail})`)
  }
  return `origin AS${asns[0]}`
}

async function runSubnet(r, f) {
  S.msg = t('querying')
  const v6 = r.kind === 'ipv6'
  const { start, end, isCidr, plen } = r
  const label = (f.ip || '').trim() || (isCidr ? `${start}/${plen}` : `${start}`)
  // v6: 比较在 SQL 里做(start/end 是 BigInt -> 十进制串 + ::UHUGEINT); 不取回原始 ip 整数(JS 会丢精度)。
  const lit = v6 ? (x => `'${x}'::UHUGEINT`) : (x => `${x}`)
  const src = rpList(prefixesFilesForRange(start, end, v6))
  if (v6 && !(S.meta?.files?.prefixes_v6 || []).length) { S.rows = []; S.mode = 'subnet'; S.msg = `${label} · ${t('no_cover')}`; return }
  // 区间重叠: 命中覆盖该范围的母段, 以及落在该范围内的更具体段。
  const w = [`ip_start <= ${lit(end)}`, `ip_end >= ${lit(start)}`]
  const cc = resolveCC(f.cc)
  if (cc) w.push(`cc = ${sqlStr(cc)}`)
  const city = (f.city || '').trim()
  if (city) w.push(`city = ${sqlStr(city)}`)
  if (!f.incllow) w.push(`n_paths >= ${Math.ceil(lowCutFor(v6))}`)
  const limit = Math.max(1, parseInt(f.limit || '500', 10))
  let rows
  S.busy = true   // 子网查询: 状态行转圈
  try {
    const statSel = (S.meta?.has_rpki ? 'rpki, ' : '') + (S.meta?.has_irr ? 'irr, ' : '')
    const subCols = `pid, prefix, plen, cc, city, origin_asn, ${statSel}n_origins, n_paths`
    const subWhere = w.join(' AND '), subOrder = 'plen DESC, ip_start'
    const off = (S.page || 0) * limit
    rows = await q(`SELECT ${subCols} FROM ${src} WHERE ${subWhere} ORDER BY ${subOrder} LIMIT ${limit + 1}${off ? ` OFFSET ${off}` : ''}`)
    _tableQuery = { src, where: subWhere, cols: subCols, order: subOrder, cc: cc || '' }   // 供导出复用
  } catch (e) { S.busy = false; S.rows = []; S.msg = `${t('query_failed')}: ${e.message}`; return }
  S.busy = false
  const more = rows.length > limit; if (more) rows = rows.slice(0, limit)
  S.rows = rows; S.mode = 'subnet'; S.more = more
  const extra = [cc && ccLabel(cc), city, !f.incllow && (S.lang === 'zh' ? '隐藏低可见' : 'low-vis hidden')].filter(Boolean).join(' · ')
  const tail = extra ? ' · ' + extra : ''
  if (!rows.length) { S.msg = `${label}${tail} · ${t('no_cover')}`; return }
  S.msg = `${label} · ${rows.length}${more ? '+' : ''} ${t('subnet_done')}${tail}`
}

// ── DNS 解析(DoH) + A/AAAA 富集前缀/origin ASN ───────────────────────────────
// 一个 IP -> 库内覆盖它的最具体前缀 + origin ASN(供点击下钻到前缀/ASN 详情)。库内无覆盖则 prefix=null。
async function enrichIp(ip, v6) {
  const r = v6 ? ip6Range(ip) : ip2range(ip)
  if (!r) return { ip }
  if (v6 && !(S.meta?.files?.prefixes_v6 || []).length) return { ip }   // 无 v6 前缀数据集
  const src = rpList(prefixesFilesForRange(r.start, r.end, v6))
  const lit = v6 ? (x => `'${x}'::UHUGEINT`) : (x => `${x}`)
  try {
    // 覆盖该地址的前缀里取最具体(范围最小)那一条。
    const rows = await q(`SELECT pid, prefix, origin_asn, n_paths, cc, city, province FROM ${src}
      WHERE ip_start <= ${lit(r.start)} AND ip_end >= ${lit(r.end)}
      ORDER BY (ip_end - ip_start) ASC LIMIT 1`)
    const m = rows[0]
    if (m) return { ip, pid: m.pid, prefix: m.prefix, asn: m.origin_asn, n_paths: m.n_paths, cc: m.cc, city: m.city, province: m.province }
  } catch (e) { /* 富集失败不影响记录展示 */ }
  return { ip }
}

// 全球路由跟踪用: 给定一个 IP, 用库内 geo 数据集富集 cc/city/province + origin ASN/前缀。
// 引擎未就绪先 ensureEngine(trace 视图本不加载引擎); 库内无覆盖 / 失败 -> 仅回 {ip}。
// 这是 geo-resolve.js 默认解析器的 DuckDB 数据源(坐标另由 geo.js 质心补; 外部 geoip API 走可插拔接口)。
export async function geoEnrich(ip) {
  const s = (ip || '').trim()
  if (!s) return null
  const v6 = s.includes(':')
  try { await ensureEngine() } catch { return { ip: s } }
  if (!S.ready) return { ip: s }
  try { return await enrichIp(s, v6) } catch { return { ip: s } }
}

// 只读: 给定 IP/前缀, 算出其去重路径经过的 Tier-1 路由图(供首页地球 doodle "画路由图")。
//   asns    = 路径里出现过的全部 Tier-1
//   entries = 各路径最上游(收集器侧)的第一个 Tier-1 —— 用户起点连向它们
//   adj     = 相邻 Tier-1 对(上游→朝前缀方向), 构成 Tier-1 间的链路结构
// 不改 S、不切视图; 引擎未就绪 / 无覆盖则全空。失败静默退化。
export async function routeTier1s(input) {
  const empty = { asns: [], entries: [], adj: [], origin_asn: null, prefix: null }
  const s = (input || '').trim()
  if (!s) return empty
  try { await ensureEngine() } catch (e) { return empty }   // WHOIS 首页引擎多半还没载, 先确保就绪
  if (!S.ready) return empty
  const v6 = s.includes(':')
  const r = v6 ? ip6Range(s) : ip2range(s)
  if (!r) return empty
  let m
  try { m = await enrichIp(s, v6) } catch (e) { return empty }
  if (!m || m.pid == null) return { ...empty, origin_asn: m?.asn ?? null, prefix: m?.prefix ?? null }
  let paths = []
  try { paths = await q(`SELECT path_arr FROM ${rpList(pathsFileFor(m.pid))} WHERE pid=${m.pid}`) } catch (e) { /* ignore */ }
  const set = new Set(), entries = new Set(), adj = new Set()
  for (const p of paths) {
    const t1 = Array.from(p.path_arr || []).map(Number).filter(a => isTier1(a))
    for (const a of t1) set.add(a)
    if (t1.length) entries.add(t1[0])
    for (let i = 0; i < t1.length - 1; i++) if (t1[i] !== t1[i + 1]) adj.add(t1[i] + '_' + t1[i + 1])
  }
  return { asns: [...set], entries: [...entries], adj: [...adj].map(x => x.split('_').map(Number)), origin_asn: m.asn, prefix: m.prefix }
}

// 首页自助探测: 给定用户来源 IP, 算出库内覆盖前缀 / origin ASN / 直接观测上游。
// 上游 = 各去重路径里 origin 前一跳的 AS(跳过 origin 自身的 prepend), 按经过的去重路径条数排序。
// 引擎未就绪会先 ensureEngine; 库内无覆盖则 prefix/origin 为 null(前端按"无覆盖"展示)。失败静默退化。
export async function probeIp(ip) {
  const s = (ip || '').trim()
  if (!s) return null
  const v6 = s.includes(':')
  try { await ensureEngine() } catch (e) { return { ip: s, v6 } }
  if (!S.ready) return { ip: s, v6 }
  let m
  try { m = await enrichIp(s, v6) } catch (e) { return { ip: s, v6 } }
  // 地理: geo 库给到的城市级位置(国内到城市); cc='ZZ'/缺失视为无。
  const cc = m?.cc && m.cc !== 'ZZ' ? m.cc : ''
  const out = {
    ip: s, v6,
    prefix: m?.prefix ?? null,
    origin_asn: m?.asn ?? null,
    origin_name: m?.asn != null ? asnName(m.asn) : '',
    n_paths: m?.n_paths ?? 0,
    cc,
    loc: cc ? placeLabel(m.province, m.city, cc) : '',
    upstreams: [],
    paths: [],            // 该前缀的全部去重 AS_PATH(≤PATH_CAP), 供卡片堆展开看
  }
  if (m?.pid == null) return out
  let rows = []
  try {
    rows = await q(`SELECT path_arr, path_arr_raw, path_len, n_peers, is_best FROM ${rpList(pathsFileFor(m.pid))}
      WHERE pid=${m.pid} ORDER BY is_best DESC, path_len ASC, n_peers DESC`)
  } catch (e) { /* ignore */ }
  const up = new Map()
  for (const p of rows) {
    const a = Array.from(p.path_arr || []).map(Number)
    // 展示用原始 path(含 prepend); 仅含 prepend 的行才带 path_arr_raw, 否则回退折叠后的 a。
    const araw = p.path_arr_raw ? Array.from(p.path_arr_raw).map(Number) : a
    out.paths.push({ asns: araw, len: Number(p.path_len) || araw.length, peers: Number(p.n_peers) || 0, best: !!p.is_best })
    if (a.length < 2) continue
    const origin = a[a.length - 1]
    let i = a.length - 2
    while (i >= 0 && a[i] === origin) i--      // 跳过 origin 自身 prepend
    if (i < 0) continue
    const u = a[i]
    if (u === origin || Number.isNaN(u)) continue
    up.set(u, (up.get(u) || 0) + 1)
  }
  out.upstreams = [...up.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 6)
    .map(([asn, n]) => ({ asn, name: asnName(asn), n }))
  return out
}

// 域名 -> DNS 解析视图。左侧主内容区(DnsView)显示记录, 右侧(桌面)自动展开域名详情面板(DomainDetail)。
export async function runDns(domain) {
  domain = String(domain || '').toLowerCase().replace(/\.$/, '')
  if (!domain) return
  _tableQuery = null   // DNS 视图非表格: 禁用导出
  S.mode = 'dns'
  S.rows = []; S.selectedPid = null
  setSubjectDomain(domain)            // 设主体 + 桌面端自动开域名详情面板
  go('/dns/' + domain)
  S.dns = { domain, loading: true }
  S.msg = (S.lang === 'zh' ? `正在解析 ${domain} 的 DNS…` : `Resolving DNS for ${domain}…`)
  let res
  try { res = await resolveDns(domain) }
  catch (e) { S.dns = { domain, error: e.message }; S.msg = (S.lang === 'zh' ? `DNS 解析失败：${e.message}` : `DNS failed: ${e.message}`); return }
  // 仍在看同一域名才写回(用户可能已切走)。
  if (S.dns?.domain !== domain) return
  const recsOf = ty => (res.types.find(x => x.type === ty)?.records) || []
  const aRecs = recsOf('A'), aaaaRecs = recsOf('AAAA')
  const [a, aaaa] = await Promise.all([
    Promise.all(aRecs.map(rec => enrichIp(rec.data, false).then(e => ({ ...rec, ...e })))),
    Promise.all(aaaaRecs.map(rec => enrichIp(rec.data, true).then(e => ({ ...rec, ...e })))),
  ])
  if (S.dns?.domain !== domain) return
  const others = res.types.filter(t => t.type !== 'A' && t.type !== 'AAAA')
  S.dns = { domain, status: res.status, a, aaaa, others, errors: res.errors }
  const n = a.length + aaaa.length + others.reduce((s, t) => s + t.records.length, 0)
  S.msg = (S.lang === 'zh'
    ? (res.status === 3 ? `${domain}：域名不存在（NXDOMAIN）` : `${domain}：${n} 条 DNS 记录 · DNS over HTTPS`)
    : (res.status === 3 ? `${domain}: NXDOMAIN` : `${domain}: ${n} DNS records · DNS over HTTPS`))
}

// ── as-set 嵌套列表(Phase 3): 左侧主内容区显示客户锥层级树, 点子 as-set 就地懒展开 ──────────────
const ASSET_SRC_PRIO = ['RIPE', 'APNIC', 'ARIN', 'AFRINIC', 'LACNIC', 'RIPE-NONAUTH', 'RADB', 'DN42']
// 择优: ① 先排掉空壳(0 成员的同名占位, 如 ARIN::AS-HURRICANE) ② 非空者按来源优先级(权威优先) ③ 再按成员数。
// 这样既避免默认落到空集合, 又在多个非空版本间偏好权威库; 其余版本仍列在「也登记于」供切换。
function pickBestAssetSource(cands) {
  const rank = s => { const i = ASSET_SRC_PRIO.indexOf(String(s).toUpperCase()); return i < 0 ? 99 : i }
  return [...cands].sort((a, b) =>
    (a.n_members ? 0 : 1) - (b.n_members ? 0 : 1)
    || rank(a.source) - rank(b.source)
    || (b.n_members - a.n_members))[0]
}

// 精确框输入 as-set 名(AS-FOO / AS123:AS-X / SOURCE::AS-X) -> 在左侧主内容区展开嵌套树。
export async function runAsSet(input) {
  const key = String(input || '').trim().toUpperCase()
  if (!key) return
  _tableQuery = null   // as-set 视图非表格: 禁用导出
  S.mode = 'asset'; S.rows = []; S.dns = null; S.selectedPid = null; S.subject = null
  closeDetailState()                       // as-set 是主内容(左), 关掉右侧子页
  S.asset = { input: key, loading: true }
  go('/asset/' + encodeURIComponent(key))
  S.msg = `as-set ${key} …`
  try {
    let row, candidates = null
    if (key.includes('::')) {              // 显式来源键 SOURCE::NAME
      const src = rpList(assetSetFilesForKey(key))
      row = src ? (await q(`SELECT set_key,source,name,descr,n_members FROM ${src} WHERE set_key=${sqlStr(key)} LIMIT 1`))[0] : null
    } else {                               // 按名查(可能多来源): 整扫 asset_set(小) 取候选, 按优先级择优
      const cands = await q(`SELECT set_key,source,name,descr,n_members FROM ${rpList(assetSetFiles())} WHERE name=${sqlStr(key)} ORDER BY n_members DESC`)
      if (cands.length) { row = pickBestAssetSource(cands); candidates = cands }
    }
    if (S.asset?.input !== key) return     // 用户已切走
    if (!row) {
      S.asset = { input: key, notfound: true }
      S.msg = (S.lang === 'zh' ? `as-set ${key}：库内无登记` : `as-set ${key}: not registered in IRR`)
      return
    }
    S.asset = { key: row.set_key, source: row.source, name: row.name, descr: row.descr,
      n_members: Number(row.n_members), candidates }
    S.msg = (S.lang === 'zh' ? `as-set ${row.set_key} · ${row.n_members} 个直接成员`
                             : `as-set ${row.set_key} · ${row.n_members} direct members`)
  } catch (e) { S.asset = { input: key, error: e.message }; S.msg = `${t('query_failed')}: ${e.message}` }
}

// 懒加载某 as-set 的直接成员(AsSetTree 展开一层时调) -> [{ord, kind:'asn'|'set', val}]。
export async function loadAsSetMembers(setKey) {
  const files = assetMemberFilesForKey(setKey)
  if (!files || !files.length) return []
  const rows = await q(`SELECT ord,kind,val FROM ${rpList(files)} WHERE set_key=${sqlStr(setKey)} ORDER BY ord`)
  return rows.map(r => ({ ord: Number(r.ord), kind: r.kind, val: r.val }))
}

// 反查: 某成员(ASN 'AS123' 或子 set_key)被哪些 as-set 直接包含 -> [parent_key]。
export async function loadMemberOf(member) {
  if (!S.meta?.has_asset) return []
  const files = assetMemberOfFilesForKey(member)
  if (!files || !files.length) return []
  try {
    const rows = await q(`SELECT DISTINCT parent_key FROM ${rpList(files)} WHERE member=${sqlStr(member)} ORDER BY parent_key LIMIT 500`)
    return rows.map(r => r.parent_key)
  } catch (e) { return [] }
}

export function cmpBy(key, dir, a, b) {
  let x = a[key], y = b[key]
  if (x == null) x = -Infinity; if (y == null) y = -Infinity
  if (typeof x === 'string' || typeof y === 'string') { x = String(x); y = String(y) }
  return x < y ? -dir : (x > y ? dir : 0)
}
export function sortRows(key) {
  if (S.sortKey === key) S.sortDir = -S.sortDir; else { S.sortKey = key; S.sortDir = -1 }
  S.rows = [...S.rows].sort((a, b) => cmpBy(S.sortKey, S.sortDir, a, b))
}

// ---- 详情面板: prefix / asn 视图 + 导航历史 ----
export async function showInsight(pid, prefix) {
  S.detailKind = 'prefix'
  S.asnView = null
  S.selectedPid = pid
  if (S.view !== 'trace') go('/' + prefix)   // trace 视图里 insight 走浮窗, 不动 URL(也使浮窗内部链接自洽)
  S.insight = { loading: true, prefix }   // prefix 先填上, 让页标题/历史项立刻可辨识(查询返回前)
  const v6 = (prefix || '').includes(':')
  // 用 prefix 串的 [start,end] 裁剪 prefixes 文件(该 pid 的行 ip_start 落在此区间内, 只读相交文件)。
  const prng = v6 ? ip6Range(prefix) : ip2range(prefix)
  const src = rpList(prefixesFilesForRange(prng?.start, prng?.end, v6))
  let det, paths
  try {
    // 不取 ip_start/ip_end(v6 取回 JS 会丢精度); 范围从 prefix 串算。
    // MOAS: origin_asns/origin_npaths 是新数组列(仅 has_moas 数据有, 且仅多源前缀非空) -> 完整 origin 列表。
    const moasCols = S.meta?.has_moas ? ', origin_asns, origin_npaths' : ''
    // RPKI/IRR: 代表 origin 状态 + MOAS 每 origin 数组(与 origin_asns 对齐)。门控缺列不 SELECT。
    const statCols = (S.meta?.has_rpki ? ', rpki, origin_rpki' : '') + (S.meta?.has_irr ? ', irr, origin_irr' : '')
    det = (await q(`SELECT prefix, plen, origin_asn, n_origins${moasCols}${statCols}, n_paths, cc, city, province FROM ${src} WHERE pid=${pid} LIMIT 1`))[0]
    paths = await q(`SELECT path_arr, path_arr_raw, path_len, n_peers, is_best FROM ${rpList(pathsFileFor(pid))} WHERE pid=${pid} ORDER BY path_len ASC, n_peers DESC`)
  } catch (e) { S.insight = { error: e.message }; return }
  if (!det) { S.insight = { error: 'not found' }; return }
  const rng = v6 ? ip6Range(det.prefix) : ip2range(det.prefix)
  const [sup, sub] = rng ? await relData(pid, rng.start, rng.end, v6) : [[], []]
  // asns = clean(供路由图拓扑/origin 聚合/路径搜索, 无连续自环); asnsRaw = 含 prepend 的原始数组, 仅展示用(AsPath 折叠成 ×N)。
  const pmap = paths.map(p => ({
    asns: Array.from(p.path_arr || []).map(Number),
    asnsRaw: p.path_arr_raw ? Array.from(p.path_arr_raw).map(Number) : null,
    peers: p.n_peers, is_best: p.is_best,
  }))
  // MOAS 全部 origin: 优先用 prefixes 的 origin_asns/origin_npaths 数组(权威完整, 不受 PATH_CAP 截断);
  // 缺数组时(单源前缀 / 旧数据)退化为从去重路径末端 AS 聚合(可能不全 -> 由 +N… 提示)。
  let origins
  // RPKI/IRR 每 origin 状态数组(与 origin_asns 对齐; 仅 MOAS 多源前缀非空)。
  const orpki = det.origin_rpki ? Array.from(det.origin_rpki).map(Number) : null
  const oirr = det.origin_irr ? Array.from(det.origin_irr).map(Number) : null
  if (det.origin_asns) {
    const asns = Array.from(det.origin_asns).map(Number)
    const nps = Array.from(det.origin_npaths || []).map(Number)
    origins = asns.map((a, i) => ({ asn: a, peers: nps[i] || 0, paths: 0, rpki: orpki ? orpki[i] : 0, irr: oirr ? oirr[i] : 0 }))
  } else {
    const oAgg = new Map()
    for (const p of pmap) {
      const o = p.asns[p.asns.length - 1]
      if (o == null || Number.isNaN(o)) continue
      const c = oAgg.get(o) || { asn: o, peers: 0, paths: 0 }
      c.peers += Number(p.peers) || 0; c.paths += 1; oAgg.set(o, c)
    }
    origins = [...oAgg.values()].sort((a, b) => (b.peers - a.peers) || (b.paths - a.paths))
    // 单源前缀: 代表 origin 的 rpki/irr 取自 det(prefixes 行)。
    for (const o of origins) if (o.asn === Number(det.origin_asn)) { o.rpki = Number(det.rpki) || 0; o.irr = Number(det.irr) || 0 }
  }
  S.insight = {
    pid, prefix: det.prefix,
    loc: placeLabel(det.province, det.city, det.cc),
    origin_asn: det.origin_asn, origin_name: asnName(det.origin_asn), n_paths: det.n_paths,
    n_origins: Number(det.n_origins ?? origins.length), origins,
    lowvis: isLowVis(det),
    rpki: Number(det.rpki) || 0, irr: Number(det.irr) || 0, irrObjs: [],
    paths: pmap,
    sup, sub,
  }
  // IRR route 对象明细(精确前缀): 异步加载, 不阻塞详情主体。
  if (S.meta?.has_irr && rng) loadInsightIrr(pid, rng, v6)
}

// 该前缀(精确)在 IRR 里登记的全部 route 对象 -> [{origin, sources:[库名]}], 写回 S.insight.irrObjs。
async function loadInsightIrr(pid, rng, v6) {
  try {
    const src = rpList(irrFilesForRange(rng.start, rng.end, v6))
    const lit = v6 ? (x => `'${x}'::UHUGEINT`) : (x => `${x}`)
    const rows = await q(`SELECT origin, sources FROM ${src} WHERE ip_start=${lit(rng.start)} AND ip_end=${lit(rng.end)} ORDER BY origin`)
    const objs = rows.map(r => ({ origin: Number(r.origin), sources: Array.from(r.sources || []).map(String) }))
    if (S.insight && S.insight.pid === pid) S.insight = { ...S.insight, irrObjs: objs }
  } catch (e) { /* IRR 明细失败不影响详情主体 */ }
}
// 父子段(更大/更小): v6 用 prefixes_v6 + ::UHUGEINT 字面量(范围在 SQL 里比, 不取回原始整数)。
async function relData(pid, s, e, v6) {
  const src = rpList(prefixesFilesForRange(s, e, v6))
  const lit = v6 ? (x => `'${x}'::UHUGEINT`) : (x => `${x}`)
  try {
    const sup = await q(`SELECT pid, prefix, plen FROM ${src} WHERE ip_start <= ${lit(s)} AND ip_end >= ${lit(e)} AND pid <> ${pid} ORDER BY (ip_end-ip_start) ASC LIMIT 12`)
    const sub = await q(`SELECT pid, prefix, plen FROM ${src} WHERE ip_start >= ${lit(s)} AND ip_end <= ${lit(e)} AND pid <> ${pid} ORDER BY ip_start LIMIT 64`)
    return [sup, sub]
  } catch (e) { return [[], []] }
}
// ── ASN 详情视图(whois 由 Whois.svelte 自取; 这里只算本地 BGP: 通告前缀 + 观测上游) ──────
export async function showAsn(asn) {
  asn = +asn
  S.detailKind = 'asn'
  S.selectedPid = null
  S.insight = null
  S.asnView = { asn, name: asnName(asn), loading: true }
  if (S.view !== 'trace') go('/' + asn)      // trace 视图里走浮窗, 不动 URL
  if (!S.ready) { return }
  try {
    // 通告前缀列表走 byorigin(纯 origin, 无 paths_blob); 计数走 origin_counts 预聚合(O(1), 与 family 过滤无关)。
    // 缺新数据集(旧数据)各自回退: byorigin->pathsearch, origin_counts->分片运行时 SUM。
    const psAll = S.meta?.has_byorigin ? byoriginFilesForOrigin(asn) : pathsearchFilesForOrigin(asn)
    const psFiles = psAll === null ? [] : byFam(psAll)
    let rows = [], c4 = 0, c6 = 0
    const tasks = []
    if (psFiles.length) {    // 该 ASN 是库内某些前缀的 origin -> 取通告前缀(纯 transit/不在库则为空, 仍展示邻居)
      const from = rpList(psFiles)
      tasks.push(q(`SELECT pid, prefix, cc, n_paths, best_path FROM ${from} WHERE origin_asn=${asn} ORDER BY n_paths DESC LIMIT 400`)
        .then(r => { rows = r }))
    }
    if (S.meta?.has_origin_counts) {
      tasks.push(q(`SELECT n_v4 AS c4, n_v6 AS c6 FROM ${rpList(originCountsFiles())} WHERE origin_asn=${asn}`)
        .then(r => { c4 = Number(r[0]?.c4 || 0); c6 = Number(r[0]?.c6 || 0) }))
    } else if (psFiles.length) {
      const from = rpList(psFiles)
      tasks.push(q(`SELECT SUM(CASE WHEN prefix LIKE '%:%' THEN 0 ELSE 1 END) AS c4, SUM(CASE WHEN prefix LIKE '%:%' THEN 1 ELSE 0 END) AS c6 FROM ${from} WHERE origin_asn=${asn}`)
        .then(r => { c4 = Number(r[0]?.c4 || 0); c6 = Number(r[0]?.c6 || 0) }))
    }
    await Promise.all(tasks)
    S.asnView = {
      asn, name: asnName(asn),
      count4: c4, count6: c6,
      prefixes: rows, neigh: null,
    }
  } catch (e) { S.asnView = { asn, name: asnName(asn), error: e.message } }
  // 反查该 ASN 被哪些 as-set 直接包含(member-of), 异步补到面板。
  if (S.meta?.has_asset && S.asnView?.asn === asn && !S.asnView.error) {
    loadMemberOf('AS' + asn).then(ms => { if (S.asnView?.asn === asn) S.asnView = { ...S.asnView, memberOf: ms } })
  }
  // 完整邻居已预计算(asn_neigh)-> 廉价, 自动加载(不再需要「按需」按钮; 旧数据无此列时仍由按钮触发全表扫)。
  if (S.meta?.has_asn_neigh && S.asnView?.asn === asn && !S.asnView.error) scanNeighbors(asn)
}
// ── 邻居关系(三态: up=provider / peer / down=customer) ──────────────────────────────────
const emptyRel = () => ({ up: [], peer: [], down: [] })
// 在 acc(Map y -> {d,u,w,wd,evd,evu}) 中累计一条邻接观测。可靠证据 d/u, 假象 wd/w 仅供落 peer + 计数。
//   'd'  = Y 在 origin 侧, 且 X 左侧(收集器侧)存在 Tier-1 ⇒ X 经 DFZ 到达收集器, Y 是可靠客户;
//   'wd' = Y 在 origin 侧, 但 X 左侧无 Tier-1(X 是 full-feed 收集器边缘) ⇒ 方向不可靠(Y 可能是 X 的 provider/peer);
//   'u'  = Y 在收集器侧, 且其位置之上存在 Tier-1 ⇒ 可靠上游;
//   'w'  = Y 在收集器侧, 但其上无 Tier-1(full-feed/泄漏) ⇒ 上游假象。
// 各侧留一条样本路径作为「依据」(首次出现即记, 不覆盖)。
function bumpNeighbor(acc, y, side, prefix, arr) {
  let o = acc.get(y)
  if (!o) { o = { d: 0, u: 0, w: 0, wd: 0, evd: null, evu: null }; acc.set(y, o) }
  o[side]++
  if (side === 'd' || side === 'wd') { if (!o.evd) o.evd = { prefix, path: arr, side: 'd' } }
  else if (!o.evu) o.evu = { prefix, path: arr, side: 'u' }   // u/w 都属收集器侧
}
// 把累计的邻接 Map 按 classifyRelation 分到 up/peer/down 三组, 各带计数 + 一条依据路径。
// 关键: 方向分类只用可靠证据(d/u, 已剔除 full-feed 假象 wd/w); 不丢弃任何邻居 ——
//   只有绝对证据进上游/下游, 其余(含纯假象)一律落到 peer, 不臆测方向。
// 不截断: 返回**全部**邻居(已按 n 降序), 计数即真实邻居数。展示侧(RelGroup)再按需折叠显示个数 ——
// 「采集/计算不能漏, 展示可以限制默认显示个数」。
function groupRelations(asn, acc) {
  const out = emptyRel()
  for (const [y, o] of acc) {
    const rel = classifyRelation(asn, y, o.d, o.u)         // wd/w 不传入, 不污染方向 ⇒ 仅假象者落 peer
    // 依据: 预计算带代表样本 pid(点开懒查 path) + ev_prefix(直接显示在哪条前缀上观测到);
    //       旧数据全表扫路径已有现成 evd/evu(含 path/prefix/side)。
    const ev = o.ev_pid != null ? { pid: o.ev_pid, prefix: o.ev_prefix } : (rel === 'down' ? (o.evd || o.evu) : (o.evu || o.evd))
    // 计数: 上下游用可靠证据; peer(含假象)用总观测次数, 以反映其被看到的频度。
    const n = rel === 'peer' ? (o.d + o.u + o.w + o.wd) : (o.d + o.u)
    out[rel].push({ asn: y, n, d: o.d, u: o.u, ev })
  }
  for (const k of ['up', 'peer', 'down']) out[k].sort((a, b) => b.n - a.n)
  return out
}
// 处理一条路径: 累计 asn 两侧邻接。上/下游证据都要求路径经过 DFZ 核心(Tier-1), 否则记为假象(w/wd)。
function accPath(acc, arr, asn, prefix) {
  let firstT1 = Infinity                          // 路径中第一个 Tier-1 的下标(从收集器侧起)
  for (let j = 0; j < arr.length; j++) { if (isTier1(arr[j])) { firstT1 = j; break } }
  for (let i = 0; i < arr.length; i++) if (arr[i] === asn) {
    if (i < arr.length - 1 && arr[i + 1] !== asn) {
      const weakDown = firstT1 >= i                // X 左侧(收集器侧)无 Tier-1 ⇒ X 未经 DFZ(full-feed 边缘),
      bumpNeighbor(acc, arr[i + 1], weakDown ? 'wd' : 'd', prefix, arr)  //   origin 侧邻居方向不可靠(可能是 provider)
    }
    if (i > 0 && arr[i - 1] !== asn) {
      const weakUp = firstT1 > i - 1               // 左邻位置之上无 Tier-1 ⇒ 未经 DFZ(full-feed/泄漏) ⇒ 上游假象
      bumpNeighbor(acc, arr[i - 1], weakUp ? 'w' : 'u', prefix, arr)
    }
  }
}
// (deriveRelations 已删: 「观测关系」与「完整邻居」合并 —— 详情面板只剩一个邻居分区, 用预计算的完整邻接,
//  样本「依据」由 showAsn 的 evacc 补。accPath/groupRelations 仍由 scanNeighbors 复用。)
// 「完整邻居」: has_asn_neigh 时读预计算 asn_neigh; 否则(旧数据)回退全表扫 pathsearch。
// 重(大 transit ASN 命中分片多), 故不自动触发, 由面板按钮触发; LIMIT 兜底防超大。
export async function scanNeighbors(asn) {
  asn = +asn
  if (!S.asnView || S.asnView.asn !== asn) return
  S.asnView = { ...S.asnView, neigh: { loading: true } }
  try {
    // 预计算路径(has_asn_neigh): 只读覆盖该 asn 的 1 个 asn_neigh 分片取邻接计数 d/u/w/wd，
    // up/peer/down 分类仍用前端 groupRelations(算法可调)。无 2 万截断、瞬时返回。
    if (S.meta?.has_asn_neigh) {
      const files = asnNeighFilesForAsn(asn)
      if (!files.length) { S.asnView = { ...S.asnView, neigh: { ...emptyRel(), scanned: 0, precomputed: true } }; return }
      const src = rpList(files)
      // ev_pid 是后加的列: 数据可能比前端旧(两个 CF 项目独立部署有时间差, 如 dn42)。缺列就退而不取证据 pid,
      // 邻居照常显示(只是无 ℹ), 不报错。下次该站重导出补上列后自动恢复证据。
      let rows
      try { rows = await q(`SELECT neighbor, d, u, w, wd, ev_pid, ev_prefix FROM ${src} WHERE asn=${asn}`) }
      catch { rows = await q(`SELECT neighbor, d, u, w, wd FROM ${src} WHERE asn=${asn}`) }
      const acc = new Map()
      for (const r of rows) acc.set(Number(r.neighbor),
        { d: Number(r.d), u: Number(r.u), w: Number(r.w), wd: Number(r.wd),
          ev_pid: r.ev_pid == null ? null : Number(r.ev_pid), ev_prefix: r.ev_prefix ?? null })
      // 每对带代表样本 pid -> ℹ 依据在点开时才按 pid 懒查(loadEvidence), 不在此处取, 不拖慢 ASN 加载。
      S.asnView = { ...S.asnView, neigh: { ...groupRelations(asn, acc), scanned: rows.length, precomputed: true } }
      return
    }
    // 旧数据回退: 前端全表扫 pathsearch(重 + 2 万截断)。
    const psAll = pathsearchFilesForOrigin(null)
    const psFiles = psAll === null ? [] : byFam(psAll)
    if (!psFiles.length) { S.asnView = { ...S.asnView, neigh: { ...emptyRel(), scanned: 0 } }; return }
    // MOAS: pathsearch 多源前缀有多行(每 origin 一行, paths_blob 相同) -> 全表扫邻居要 is_primary 去重, 防重复计数。
    const primary = S.meta?.has_moas ? 'is_primary AND ' : ''
    const rows = await q(`SELECT prefix, paths_blob FROM ${rpList(psFiles)} WHERE ${primary}paths_blob LIKE '% ${asn} %' LIMIT 20000`)
    const acc = new Map()
    for (const r of rows) {
      for (const path of String(r.paths_blob || '').trim().split('|')) {
        accPath(acc, path.trim().split(/\s+/).map(Number), asn, r.prefix)
      }
    }
    S.asnView = { ...S.asnView, neigh: { ...groupRelations(asn, acc), scanned: rows.length, capped: rows.length >= 20000 } }
  } catch (e) { S.asnView = { ...S.asnView, neigh: { error: e.message } } }
}

// 按代表样本 pid 懒查一条含 (subj,nb) 相邻的路径 -> {path, side}。RelGroup 点开 ℹ 时才调, 不在 ASN 加载时取(不拖慢)。
export async function loadEvidence(pid, subj, nb) {
  try {
    const rows = await q(`SELECT path_arr FROM ${rpList(pathsFileFor(pid))} WHERE pid=${pid} ORDER BY path_len ASC`)
    for (const r of rows) {
      const arr = Array.from(r.path_arr || []).map(Number)
      for (let k = 0; k < arr.length; k++) if (arr[k] === subj) {
        if (arr[k + 1] === nb) return { path: arr, side: 'd' }   // nb 在 origin 侧(右) = 下行
        if (arr[k - 1] === nb) return { path: arr, side: 'u' }   // nb 在收集器侧(左) = 上行
      }
    }
  } catch (e) { /* 证据取失败不影响列表 */ }
  return null
}

// dn42: 无 DoH 解析, 域名 -> 直接展示 registry whois(右侧域名详情面板; 左侧不进 DNS 记录视图)。
export function runDomainWhois(domain) {
  domain = String(domain || '').toLowerCase().replace(/\.$/, '')
  if (!domain) return
  S.rows = []; S.selectedPid = null; S.dns = null; S.mode = 'prompt'
  setSubjectDomain(domain)            // 设主体 + 桌面端自动开域名详情面板(Whois kind='domain' -> registry)
  S.msg = `${domain} · registry WHOIS`
}

// ── 域名详情视图(WHOIS/RDAP 由 Whois.svelte kind='domain' 自取; 这里只置面板状态) ──
export function showDomain(domain) {
  domain = String(domain || '').toLowerCase().replace(/\.$/, '')
  S.detailKind = 'domain'
  S.selectedPid = null
  S.insight = null
  S.asnView = null
  S.domainView = { domain }
  go('/dns/' + domain)
}

// 精确框 ASN -> 设主体 + 自动开面板(主体变化时); 非 ASN -> 清主体。
// 移动端: 详情页全屏, 输入即自动弹出会打断输入 -> 只设主体不自动开, 由 Topbar 的「Whois」按钮显式打开。
const isMobileViewport = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 820px)').matches
function setSubjectAsn(asn) {
  if (asn == null) { S.subject = null; return }
  if (S.subject?.kind === 'asn' && S.subject.id === asn && S.detailKind) return  // 已在看, 别打断
  S.subject = { kind: 'asn', id: asn }
  if (!isMobileViewport()) showAsn(asn)
}
// 域名主体: 同 setSubjectAsn, 但开域名详情面板。
function setSubjectDomain(domain) {
  if (S.subject?.kind === 'domain' && S.subject.id === domain && S.detailKind === 'domain') return
  S.subject = { kind: 'domain', id: domain }
  if (!isMobileViewport()) showDomain(domain)
}
// Topbar「Whois」按钮(移动端): 显式打开当前精确框主体(ASN 或 域名)的详情面板。
export function openWhoisFromBox() {
  if (S.subject?.kind === 'asn') showAsn(S.subject.id)
  else if (S.subject?.kind === 'domain') showDomain(S.subject.id)
}

// ── WHOIS 首页视图(features.whoisView; 落地页 = /) ───────────────────
// 解析输入串 -> 设 S.whois 载荷并切到 whois 视图; 不跑 BGP 搜索(纯网络 RDAP/WHOIS, 与 DuckDB 无关)。
// kind 映射: asn->autnum; ipv4/ipv6(含 CIDR)->ip(key=原串); domain->domain(RDAP 站取可注册根域名, registry 站取原域名)。
// **as-set / 名称 / 其它非 WHOIS 对象 -> 直接转路由分析**(openInRouting)。go() 在 applyRoute(_suppressUrl) 内为 no-op。
// 注: 「高级搜索」开关的「任何查询都进路由」由 UI 提交层(WhoisView)决定, 不在此 —— 免得 URL 驱动的 /whois/x 深链被开关劫持。
export function runWhois(input) {
  const raw = String(input || '').trim()
  S.view = 'whois'
  S.probeExpanded = false   // 进入查询时收起「你的接入」摊开网格
  if (!raw) { S.whois = { input: '', kind: null, key: null, err: '' }; go('/'); return }   // 首页 = /
  const p = classifyQuery(raw)
  if (p.kind === 'asn') S.whois = { input: raw, kind: 'autnum', key: String(p.asn), err: '' }
  else if (p.kind === 'ipv4' || p.kind === 'ipv6') S.whois = { input: raw, kind: 'ip', key: raw, err: '' }
  else if (p.kind === 'domain') S.whois = { input: raw, kind: 'domain', key: features.rdapWhois ? registrableDomain(p.domain) : p.domain, err: '' }
  else return openInRouting(raw)   // as-set / name / text -> 路由分析(不在 WHOIS 范围)
  go('/whois/' + encodeURIComponent(raw))
}

// 跳到路由分析: 「查看更多信息」、首页搜非 WHOIS 对象、「高级搜索」开关。把对象填进精确框跑一次 + 开对应详情。
// 基线先压一个路由 URL(/?q=), 详情类(asn/prefix/dns/asset)随后由 showAsn/openPrefix/runDns/runAsSet 各自细化覆盖。
export async function openInRouting(input) {
  const s = String(input || '').trim()
  if (!s) return
  S.view = 'routing'
  S.filters.ip = s
  go('/?q=' + encodeURIComponent(s))
  try { await ensureEngine() } catch { return }     // 从 WHOIS 跳来时引擎多半还没加载, 先确保就绪
  const probe = classifyQuery(s)
  await runSearch()                                  // 域名 -> runDns(/dns/); as-set -> runAsSet(/asset/); asn/ip -> 搜索
  if (probe.kind === 'asn') showAsn(probe.asn)        // 显式开 ASN 详情(移动端 setSubjectAsn 不自动开)
  else if (probe.kind === 'ipv4' || probe.kind === 'ipv6') await openPrefixByString(s)
}

// 在「浮窗」里加载 insight(供 trace 视图点 IP/ASN 用): 不切视图、不改 URL。
// 先即时置 loading 态(让浮窗带 spinner 弹出), 再 ensureEngine + 加载。ASN→ASN 详情; IP/前缀→找覆盖前缀开 prefix 详情。
export async function loadInsightFor(query) {
  const s = String(query || '').trim()
  if (!s) return
  const probe = classifyQuery(s)
  if (probe.kind === 'asn') { S.detailKind = 'asn'; S.insight = null; S.selectedPid = null; S.asnView = { asn: probe.asn, name: asnName(probe.asn), loading: true } }
  else if (probe.kind === 'ipv4' || probe.kind === 'ipv6') { S.detailKind = 'prefix'; S.asnView = null; S.insight = { loading: true } }
  else return
  try { await ensureEngine() } catch { S.insight = { error: t('query_failed') }; return }
  if (!S.ready) return
  if (probe.kind === 'asn') { showAsn(probe.asn); return }
  const v6 = probe.kind === 'ipv6'
  let m
  try { m = await enrichIp(s, v6) } catch { m = null }
  if (m && m.pid != null) showInsight(m.pid, m.prefix)
  else S.insight = { error: t('no_cover') }
}
// 仅清空详情状态(不动 URL): 供 trace 浮窗的关闭钮用。
export function clearDetail() { closeDetailState() }

// 点 LOGO 回首页。peeras: WHOIS 首页(/); dn42(无 whoisView): 路由分析干净落地页(/)。均清详情/筛选/结果。
export function goHome() {
  closeDetailState()
  S.notFound = null         // 离开 404
  S.probeExpanded = false   // 回首页复位「你的接入」摊开网格
  Object.assign(S.filters, { cc: '', city: '', person: '', path: '', origin: '', ip: '', limit: 500, incllow: false, fam: 'all' })
  S.dns = null; S.asset = null; S.rows = []; S.msg = ''
  if (features.whoisView) { S.view = 'whois'; S.whois = { input: '', kind: null, key: null, err: '' }; go('/') }
  else { S.view = 'routing'; go('/'); ensureEngine().then(() => runSearch()).catch(() => {}) }
}

// 「IP 探测」专用视图(= WHOIS 首页 + 卡片摊开网格, URL /probe)。侧栏/移动菜单入口指向它。
// 复位到干净首页(同 goHome), 但摊开「你的接入」网格 + 落 /probe URL(可深链/前进后退)。
export function openProbe() {
  closeDetailState()
  Object.assign(S.filters, { cc: '', city: '', person: '', path: '', origin: '', ip: '', limit: 500, incllow: false, fam: 'all' })
  S.dns = null; S.asset = null; S.rows = []; S.msg = ''
  S.view = 'whois'
  S.whois = { input: '', kind: null, key: null, err: '' }
  S.probeExpanded = true
  go('/probe')
}
// 收起摊开网格(卡堆收起钮): 回到 WHOIS 首页 URL(/)。
export function collapseProbe() {
  S.probeExpanded = false
  if (S.view === 'whois' && !S.whois.kind) go('/')
}

// ── 全球路由跟踪视图 ───────────────────────────────────────────────
// 侧栏/移动菜单入口: 切到干净 trace 视图；NextTrace traceMap 深链走 /trace?nt=<id>。
export function openTrace() { setView('trace') }

// ── 结果表分页 + 导出 ─────────────────────────────────────────────
// 翻页: 调 runSearch(true) 保留 S.page; OFFSET=page*limit 重查(复用整套搜索逻辑与 _best/排序后处理)。
export function gotoPage(delta) {
  const cur = S.page || 0
  const np = Math.max(0, cur + delta)
  if (np === cur || (delta > 0 && !S.more)) return
  S.page = np
  runSearch(true)
}
export function canExport() { return !!_tableQuery && S.rows.length > 0 }

// 导出列注册表: 仅列出当前 _tableQuery 真正取得的列(按 cols 串 + meta 门控)。值函数从结果行取/廉价派生(AS 名/地理)。
function colDefs() {
  const tq = _tableQuery || {}, has = s => (tq.cols || '').includes(s), cc = tq.cc || ''
  return [
    { key: 'prefix', label: t('col_prefix'), on: true, val: r => r.prefix },
    { key: 'origin', label: t('col_origin'), on: true, val: r => r.origin_asn },
    { key: 'origin_name', label: t('exp_origin_name'), on: true, val: r => asnName(r.origin_asn) || '' },
    { key: 'cc', label: t('exp_cc'), on: has('cc') || !!cc, val: r => r.cc || cc || '' },
    { key: 'loc', label: t('col_loc'), on: true, val: r => placeLabel(r.province, r.city, r.cc || cc) },
    { key: 'plen', label: t('exp_plen'), on: has('plen'), val: r => r.plen ?? '' },
    { key: 'n_paths', label: t('col_path'), on: true, val: r => r.n_paths ?? 0 },
    { key: 'rpki', label: t('exp_rpki'), on: has('rpki'), val: r => r.rpki ?? '' },
    { key: 'irr', label: t('exp_irr'), on: has('irr'), val: r => r.irr ?? '' },
    { key: 'moas', label: t('exp_moas'), on: has('n_origins'), val: r => r.n_origins ?? '' },
    { key: 'best', label: t('exp_best'), on: has('best_path'), val: r => (r.best_path ? parseBest(r.best_path).join(' ') : '') },
    { key: 'segs', label: t('exp_segs'), on: has('segs'), val: r => Array.from(r.segs || []).join(' ') },
  ].filter(c => c.on)
}
// 当前可导出的列(给浮窗渲染勾选框)。
export function exportColumns() { return colDefs().map(c => ({ key: c.key, label: c.label })) }

function csvEsc(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v }
function exportFilename() {
  const d = new Date(), p = n => String(n).padStart(2, '0')
  return `peer.as_${S.mode}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`
}
// 完整导出当前搜索结果为 CSV: 复用 _tableQuery, 去 offset、大上限(CAP)取全量, 取所选列。返回 {ok,n,capped}。
const EXPORT_CAP = 100000
export async function exportCsv(keys) {
  if (!_tableQuery) return { ok: false }
  const defs = colDefs().filter(c => keys.includes(c.key))
  if (!defs.length) return { ok: false }
  const { src, where, cols, order } = _tableQuery
  let rows
  try { rows = await q(`SELECT ${cols} FROM ${src} ${where ? 'WHERE ' + where : ''} ORDER BY ${order} LIMIT ${EXPORT_CAP}`) }
  catch (e) { return { ok: false, error: e.message } }
  const head = defs.map(c => csvEsc(c.label)).join(',')
  const body = rows.map(r => defs.map(c => csvEsc(c.val(r))).join(',')).join('\n')
  const csv = '﻿' + head + '\n' + body + '\n'   // BOM: Excel 正确识别 UTF-8(中文不乱码)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = exportFilename()
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { ok: true, n: rows.length, capped: rows.length >= EXPORT_CAP }
}

// 顶层视图切换(侧栏 / 移动菜单)。各视图保留自身 S 状态, 仅翻 S.view + 还原对应 URL(入历史栈, 可前进/后退)。
export function setView(v) {
  S.notFound = null   // 切视图(侧栏/移动菜单)离开 404
  if (v === 'whois') {
    S.probeExpanded = false   // 从「IP 探测」摊开态/其它视图回首页时收起网格
    S.view = 'whois'
    const inp = (S.whois?.input || '').trim()
    go(inp ? '/whois/' + encodeURIComponent(inp) : '/')   // 首页 = /
  } else if (v === 'trace') {
    S.view = 'trace'                                       // 全球路由跟踪(不依赖 DuckDB 引擎); 只有 /trace 一个路径
    S.trace = { target: '' }
    go('/trace')
  } else {
    if (v === S.view) return
    S.view = 'routing'
    const box = (S.filters.ip || '').trim()
    go(box ? `/?q=${encodeURIComponent(box)}` : ROUTING_HOME)   // 路由分析落地页 = /advanced(peeras)
    // 首次进路由分析才加载引擎(34MB), 就绪后渲染当前框。失败则 S.fatal 已置, 路由视图显示错误。
    ensureEngine().then(() => runSearch()).catch(() => {})
  }
}
// 路由分析的「空落地页」URL: peeras 让出 / 给 WHOIS 首页, 故用 /advanced; dn42(无 whoisView)路由本就是 /。
const ROUTING_HOME = features.whoisView ? '/advanced' : '/'

// ── 浏览器历史路由(PJAX) ──────────────────────────────────────────
// 单一真相 = 浏览器历史。开详情 pushState('/<asn|prefix>'); 面板 ←/→ = history.back()/forward();
// popstate 按 URL 重渲染。S.nav.{idx,max} 仅用于 ←/→ 的可用态。_suppressUrl 在按 URL 渲染时屏蔽回写。
let _suppressUrl = false
function go(path) {
  if (_suppressUrl || typeof history === 'undefined') return
  const cur = location.pathname + location.search
  if (cur === path) { history.replaceState({ idx: S.nav.idx }, '', path); return }   // 同 URL 不新增历史项
  const idx = S.nav.idx + 1
  history.pushState({ idx }, '', path)
  S.nav.idx = idx; S.nav.max = idx                                                    // 新前进 -> 截断更前的历史
}
export function navCanBack() { return S.nav.idx > 0 }
export function navCanFwd() { return S.nav.idx < S.nav.max }
export function navBack() { if (navCanBack()) history.back() }
export function navForward() { if (navCanFwd()) history.forward() }

function closeDetailState() { S.detailKind = null; S.selectedPid = null; S.insight = null; S.asnView = null; S.domainView = null }
// 智能关闭: 看子页(prefix/asn)且有主体上下文(ASN 或 域名) -> 先返回主体页; 否则真正关闭(再点即关)。
export function closeInsight() {
  if (S.detailKind === 'prefix' && S.subject?.kind === 'asn') { showAsn(S.subject.id); return }
  if (S.detailKind !== 'domain' && S.subject?.kind === 'domain') { showDomain(S.subject.id); return }
  hardCloseDetail()
}
// 彻底关闭(Esc / 移动端关闭): 关详情 + URL 回到搜索态。DNS 模式下保留 /dns/<域名>(左侧记录仍在);
// 否则框非空 -> /?q=, 否则根。
export function hardCloseDetail() {
  closeDetailState()
  if (S.mode === 'dns' && S.dns?.domain) { go('/dns/' + S.dns.domain); return }
  const box = (S.filters.ip || '').trim()
  go(box ? `/?q=${encodeURIComponent(box)}` : ROUTING_HOME)   // 空 -> 路由分析落地页(/advanced)
}

// 按前缀串精确开 prefix 详情(URL/popstate 用, 因 URL 只有前缀串无 pid)。命中库内同范围前缀则展开。
async function openPrefixByString(s) {
  const v6 = s.includes(':')
  const r = v6 ? ip6Range(s) : ip2range(s)
  if (!r) return
  const src = rpList(prefixesFilesForRange(r.start, r.end, v6))
  const lit = v6 ? (x => `'${x}'::UHUGEINT`) : (x => `${x}`)
  try {
    const rows = await q(`SELECT pid, prefix FROM ${src} WHERE ip_start=${lit(r.start)} AND ip_end=${lit(r.end)} ORDER BY n_paths DESC LIMIT 1`)
    if (rows[0]) showInsight(rows[0].pid, rows[0].prefix)
  } catch (e) { /* 无精确匹配则仅显示子网搜索结果 */ }
}

// 本站「已定义」的路径形态白名单(供 applyRoute 的 404 守卫用)。传入的 path 已去掉首尾斜杠并解码。
// 注意: 首页('')、whois/、trace/、probe 在 applyRoute 中已先行处理并 return, 不会走到这里; 故此处
// 只需覆盖剩余的「对象/视图」路由。名称搜索不占路径(走 /?q=), 故 name/text 一律视为未知 -> 404。
function isKnownRoute(path) {
  if (path === 'advanced') return true                                  // 路由分析空落地页
  if (/^networks(\/[A-Za-z]{2}(\/\d{1,4})?)?$/.test(path)) return true  // 国家目录(SSR) /networks[/<cc>[/<page>]]
  if (/^asset\/.+/.test(path)) return true                             // /asset/<as-set 键>
  if (/^dns\/.+/.test(path)) return true                              // /dns/<域名>
  const k = classifyQuery(path).kind                                   // 其余: 仅 ASN / IPv4 / IPv6·前缀 是合法对象路由
  return k === 'asn' || k === 'ipv4' || k === 'ipv6'
}

// 给 App.onMount 同步预判「直开此 URL 是否会落到 404」—— 与下面 applyRoute 的 404 守卫完全同源。
// 404 不依赖引擎/meta, 应像 whois/trace 一样首帧直出 NotFound, 不闪「正在加载查询引擎」。
export function isNotFoundPath() {
  if (typeof location === 'undefined') return false
  const path = decodeURIComponent(location.pathname).replace(/^\/+/, '').replace(/\/+$/, '')
  if (path === '') return false                                                          // 首页
  if (features.whoisView && (path === 'whois' || path.startsWith('whois/') || path === 'probe')) return false
  if (features.routeTrace && (path === 'trace' || path.startsWith('trace/'))) return false
  return !isKnownRoute(path)
}

// 解析 URL(路径 /<asn|prefix> 或 ?q=<词>)并渲染。initial=首次加载(种 history.state.idx); 否则 popstate。
export async function applyRoute({ initial = false } = {}) {
  _suppressUrl = true
  try {
    if (initial && history.state?.idx == null) history.replaceState({ idx: 0 }, '', location.pathname + location.search)
    S.nav.idx = history.state?.idx ?? 0
    if (initial) S.nav.max = S.nav.idx
    const sp = new URLSearchParams(location.search)
    const q0 = sp.get('q')
    const path = decodeURIComponent(location.pathname).replace(/^\/+/, '').replace(/\/+$/, '')
    S.notFound = null                              // 每次路由都先清 404 态(上次 404 -> 这次正常路由即恢复)
    S.view = 'routing'                             // 默认顶层视图; whois 分支改 'whois'(从 whois 后退到路由 URL 即自动复位)
    // peeras 首页 = WHOIS 视图: 空路径且无 ?q(落地页), 以及 /whois[/<q>] 深链。纯 RDAP, 不碰引擎。
    // dn42(无 whoisView)空路径仍走下面的路由空落地页, 不进 whois。
    if (features.whoisView && ((path === '' && q0 == null) || path === 'whois' || path.startsWith('whois/') || path === 'probe')) {
      S.loading = false
      runWhois(path.startsWith('whois/') ? decodeURIComponent(path.slice(6)) : '')
      S.probeExpanded = (path === 'probe')   // /probe -> 直接进「IP 探测」摊开态(runWhois 已先置 false)
      return
    }
    // /trace[?nt=<id>] -> 全球路由跟踪(纯前端 MTR/traceMap 可视化, 不碰 DuckDB 引擎)。
    // ?nt= NextTrace traceMap JSON 深链；路径段仍规范化掉，避免和 IP/prefix 路由冲突。
    if (features.routeTrace && (path === 'trace' || path.startsWith('trace/'))) {
      S.loading = false
      S.view = 'trace'
      const nt = (sp.get('nt') || '').trim()
      S.trace = { target: '', ntraceId: nt }
      if (path !== 'trace' && typeof history !== 'undefined') {
        history.replaceState(history.state || { idx: S.nav.idx }, '', nt ? `/trace?nt=${encodeURIComponent(nt)}` : '/trace')
      }
      return
    }
    // ── 通用路由守卫(404)──────────────────────────────────────────────
    // 走到这里说明已排除首页 / whois / trace / probe 等已处理的视图路由。
    // 只放行本站**已定义**的路径形态;其余任何乱打的 URL 一律 404(整站守卫, 不限于路由服务,
    // 也不必加载 34MB 查询引擎)。真正的「按名称搜索」走 /?q=(下面的 q0 分支), 不占用路径。
    if (path && !isKnownRoute(path)) {
      S.loading = false
      S.notFound = { target: decodeURIComponent(location.pathname) }
      return
    }
    // 路由分析需 DuckDB 引擎: 懒加载(首次), 就绪后再跑下面的 runSearch/runDns/runAsSet。失败则 S.fatal 已置, 直接退出。
    try { await ensureEngine() } catch { return }
    if (path === 'advanced') {                     // /advanced -> 路由分析空落地页(peeras 让出 / 给 WHOIS 首页后的去处)
      closeDetailState()
      await runSearch()
    } else if (path.startsWith('asset/')) {        // /asset/<as-set 键> -> 左侧嵌套列表
      const key = decodeURIComponent(path.slice(6))
      S.filters.ip = key
      await runAsSet(key)
    } else if (path.startsWith('dns/')) {          // /dns/<域名> -> DNS 视图(dn42 无 DoH: registry 域名 whois)
      const domain = path.slice(4)
      S.filters.ip = domain
      if (features.dns) await runDns(domain)
      else runDomainWhois(domain)
    } else if (path) {
      const probe = classifyQuery(path)
      S.filters.ip = path
      await runSearch()
      if (probe.kind === 'asn') showAsn(probe.asn)
      else if (probe.kind === 'ipv4' || probe.kind === 'ipv6') await openPrefixByString(path)
    } else if (q0 != null) {
      S.filters.ip = q0
      await runSearch()
    } else {
      closeDetailState()
      await runSearch()
    }
  } finally { _suppressUrl = false }
}
