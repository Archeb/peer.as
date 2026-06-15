// DuckDB-WASM 数据层 (从 web_ref/app.js 移植)。无后端: 浏览器对静态 parquet 发 HTTP Range 查询。
import { S } from './store.svelte.js'
import { features } from './site.js'
// DuckDB-WASM 资产经 Vite `?url` 打包: 输出带内容 hash 的独立资源(不内联到 JS), 随 dist 部署。
// **wasm 自托管的边界**: CN 镜像(Caddy, 无大小限制)同源托管完整 wasm;**CF Pages 单文件 ≤25MiB,
// 而 duckdb-eh/mvp.wasm 达 33/39MB 放不下** -> CF 部署临时移出这俩 wasm(见 daily-refresh 3b),
// CF 路径下 wasm 同源取不到时回退外部 CDN(见 CDN_DIST / wasmSrcs)。worker(<1MB)与 JS API 始终同源打包。
import wasmMvp from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import workerMvp from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import wasmEh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import workerEh from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'

const DUCKDB_VER = '1.32.0'
// CF Pages 路径下 wasm 的外部回退源(同源放不下时按序尝试)。两个全球 CDN 互为备份、均带 CORS。
// 文件用 duckdb 官方原名(非 hash); 仅 CF 海外/直连节点会用到, 国内主路径走 CN VPS 同源、不碰这里。
const CDN_DIST = [
  `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VER}/dist`,
  `https://unpkg.com/@duckdb/duckdb-wasm@${DUCKDB_VER}/dist`,
]

// 数据宿主在「运行时」按域名/地区选定(见 configure)。三个候选:
// - **R2(peer-as-data.opentrace.app)** = 海外默认: 数据从 CF Pages 同源剥离, 独立 R2 桶托管。**动机**: CF Pages 单文件
//   ≤25MiB、单部署 ≤2万文件, 放不下全表 parquet(最大分片已近 25MiB), 故海外数据迁 R2(VITE_DATA_BASE
//   构建期注入; 绑自定义域名 + Cache Everything 缓存规则 -> 命中即免 Class B、R2 egress 本就免费)。
//   未配 VITE_DATA_BASE(本地 dev / dn42) 则回落同源。
// - **cn.peer.as** = 境内: CN 优化 VPS(Caddy)托管的整站镜像, 自带 /data。直连或 GeoDNS 命中时同源相对。
// - **同源 /data** = 本地 serve / GeoDNS 把 peer.as 解到 CN 机器 / dn42: 本机即正确源。
// wasm/worker **不随数据迁移**: 由构建打包(详见顶部与 wasmSrcs), worker/JS API 始终同源; wasm 同源优先, CF 节点回退 CDN。
const SAME = new URL('./data', document.baseURI).href.replace(/\/$/, '')       // 同源 /data(本地/CN 机器)
const CN_ORIGIN = (import.meta.env.VITE_CN_BASE || 'https://cn.peer.as').replace(/\/$/, '')
let CN_HOST = 'cn.peer.as'; try { CN_HOST = new URL(CN_ORIGIN).hostname } catch { /* 默认 cn.peer.as */ }
// R2 海外数据宿主(构建期 VITE_DATA_BASE 注入, 如 https://peer-as-data.opentrace.app)。未配置=空串 -> 海外回落同源(本地 dev/dn42)。
const R2_DATA = (import.meta.env.VITE_DATA_BASE || '').replace(/\/$/, '')
// 海外默认数据源: peeras 且配了 R2 用 R2, 否则同源。**用 cnMirror 收口**: R2 桶只装 peeras 全表,
// dn42(cnMirror=false)即便 build 误带 VITE_DATA_BASE 也绝不取 R2(会加载错数据集)。getData() 的一致回退目标也是它。
const GLOBAL = (features.cnMirror && R2_DATA) ? R2_DATA : SAME

// 运行时选定(默认 GLOBAL=海外源); configure() 据域名/geo 改写。
export let DATA = GLOBAL           // parquet/json 基址。ES module 活绑定: 重新赋值后各处即时生效。
export let edge = 'cf'             // 'cf' | 'cn', 仅诊断用。

// 把打包出的 wasm/worker 资产展开成「按序尝试」的候选(cachedBlobURL 逐个 fetch, 首个成功即止):
// 1) 数据切 CN 镜像时, 同一 hash 资产在 CN 镜像也有(随 dist rsync) -> 优先 CN 优化线;
// 2) 同源;3) 外部 CDN(官方原名, cdnName 形如 `duckdb-eh.wasm`)兜底。
// **关键**: CF Pages 对缺失路径回 SPA 200 + index.html(非 404), 故 CF 上被排除的大 wasm 同源会拿到 HTML ——
// 不能把同源 wasm 列进 CF 路径的候选(否则假阳)。sameOriginMissing=true(wasm 且 edge='cf')时跳过同源直接 CDN;
// worker(CF 上存在)/CN 路径仍同源优先。cachedBlobURL 另有「拒绝 HTML 响应」双保险兜底。
function wasmSrcs(assetUrl, cdnName, sameOriginMissing) {
  const abs = new URL(assetUrl, document.baseURI)
  const cdn = CDN_DIST.map(d => `${d}/${cdnName}`)
  if (DATA.startsWith(CN_ORIGIN)) return [`${CN_ORIGIN}${abs.pathname}`, abs.href, ...cdn]  // 切 CN 镜像: 都有
  if (sameOriginMissing && edge === 'cf') return cdn   // CF Pages 上大 wasm 不存在 -> 直接 CDN
  return [abs.href, ...cdn]                             // CN VPS/本地同源有; worker 任何路径同源有
}

let db = null, conn = null

// 带超时的 fetch(超时即 abort; 用于 geo 探测/健康检查, 不拖慢启动)。
async function fetchT(url, opts = {}, ms = 2000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms)
  try { return await fetch(url, { ...opts, signal: ac.signal }) } finally { clearTimeout(t) }
}

// 启动时调用一次: 选定数据宿主(wasm/worker 已打包同源, 见 wasmSrcs)。
export async function configure() {
  DATA = GLOBAL; edge = 'cf'      // 海外默认: R2(配置了)否则同源
  // 本站无 cn.peer.as 整站镜像(profile cn_mirror=false, 如 dn42): 永远同源(GLOBAL=SAME), 不做任何 CN 探测/分流。
  // 否则会把数据切到 cn.peer.as —— 而 cn.peer.as 只镜像 peeras 全球数据集, dn42 切过去会加载错 meta/parquet 直接炸。
  if (!features.cnMirror) { DATA = SAME; return edge }
  // 1) 直连 CN 机器(host=cn.peer.as): 同源即 CN 机器 —— 数据 /data 同源(不走 R2)。
  if (location.hostname === CN_HOST) {
    DATA = SAME; edge = 'cn'
    return edge
  }
  // 2) 否则: 探 /cdn-cgi/trace 判断当前在 Cloudflare 还是 CN 加速机。
  //    CF 上: 200 + 含 loc=XX。CN 加速机(GeoDNS 把 peer.as 解到本机)/本地 serve: 无此端点 -> 404。
  let onCF = false, loc = null
  try {
    const r = await fetchT('/cdn-cgi/trace', { cache: 'no-store' }, 1200)
    if (r.ok) { onCF = true; loc = (/(?:^|\n)loc=([A-Z]{2})/.exec(await r.text()) || [])[1] }
    // r 收到但非 200(典型 404) -> onCF 保持 false -> 判定走了 CN 加速机(见下)。
  } catch { /* 网络错误(非 404 响应): 含糊, 不强判, 保持 CF 默认 */ onCF = null }
  if (onCF === false) {
    // /cdn-cgi/trace 明确 404(收到响应但非 200) => 不在 Cloudflare => GeoDNS 已把 peer.as 解到 CN 加速机
    // (或本地 serve)。本机即正确源 => 切回同源 /data(不走 R2); edge=cn 让 UI 显示「中国优化服务器」赞助提示。
    DATA = SAME; edge = 'cn'
  } else if (onCF && loc === 'CN') {        // 在 CF Pages 且身处境内(GeoDNS 没生效, 拿到 CF IP)
    try {                                   // 健康探测 CN 机器: 通了才切数据到镜像, 失败保持 GLOBAL(R2)回退。
      const r = await fetchT(`${CN_ORIGIN}/data/meta.json`, { cache: 'no-store' }, 2000)
      if (r.ok) { DATA = `${CN_ORIGIN}/data`; edge = 'cn' }   // wasm 随之优先走 CN 镜像(wasmSrcs)
    } catch { /* CN 机器不可达 -> 保持 GLOBAL(R2/同源)回退 */ }
  }
  // else: onCF && loc!=CN (海外 CF), 或 onCF===null(网络错误) -> GLOBAL(R2), edge='cf'
  return edge
}

// 中国优化转发基址(给 DoH / WHOIS 这两个境内连通性差的外部依赖用)。复用数据宿主判定:
// 数据落在哪台 CN 机器, 就用同机的 /dns-query、/whois 中转(Caddy 反代 cloudflare-dns.com / whois worker)。
//   - DATA 已切 cn.peer.as 镜像(境内 CF 用户, GeoDNS 没生效)        -> CN_ORIGIN(跨域到 cn.peer.as)
//   - edge=cn 且当前在 *.peer.as(直连 cn.peer.as, 或 GeoDNS 把 peer.as 解到 CN 机器)
//     —— 同源即 CN 机器, peer.as/cn.peer.as 共用同一份 Caddy (site) 含这两个端点 -> ''(同源相对)
//   - 海外 CF / 本地 serve(edge=cn 但 host 非 *.peer.as, serve 无这两个端点)    -> null(前端直连外部源)
export function cnProxyBase() {
  if (DATA.startsWith(CN_ORIGIN)) return CN_ORIGIN
  if (edge === 'cn' && typeof location !== 'undefined' && /(^|\.)peer\.as$/.test(location.hostname)) return ''
  return null
}

export async function getJSON(url, opts) {
  const r = await fetch(url, opts)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json()
}

// meta/asnames 等关键 JSON 的「带回退」取数: 先试选定宿主(可能是 CN VPS), 失败则整体回退海外默认 GLOBAL
// (R2, 或未配 R2 时同源)并把后续数据源也切过去(consistent fallback)。path 形如 `/meta.json`、`/asnames.json?v=…`。
export async function getData(path, opts) {
  try { return await getJSON(`${DATA}${path}`, opts) }
  catch (e) {
    // 数据源(cn.peer.as 镜像, 或本机)取数失败 -> 一致回退到海外默认 GLOBAL(R2/同源)。
    if (DATA !== GLOBAL) { DATA = GLOBAL; edge = 'cf'; return await getJSON(`${GLOBAL}${path}`, opts) }
    throw e
  }
}

// 数据版本查询串: meta.version 拼成 ?v=<hash>。数据一变 version 就变 -> URL 变 -> 旧缓存(浏览器/CDN)失效。
// 所有 parquet/asnames URL 都带上它; 因此即便 parquet 长缓存(max-age=86400)也不会读到过期数据。
export const dv = () => { const v = S.meta?.version; return v ? `?v=${encodeURIComponent(v)}` : '' }

// 版本入名: 升级 duckdb 自动弃旧缓存。`-r3`: 早期版本曾把坏响应(CF SPA-200 HTML / 空/截断的大 wasm)
// 误存进缓存导致持续空白; 配合下方「字节级校验」从源头堵死, bump 版本名再弃一次历史毒化缓存。
const WASM_CACHE = `duckdb-wasm-${DUCKDB_VER}-r3`

// 校验取到的字节确实是预期资源, 而非空/截断/被 CF SPA 回的 HTML。坏数据一律不入缓存、不喂 duckdb。
// wasm: 必须以 magic `00 61 73 6d` 开头; worker(JS): 非空且不以 '<'(0x3c, HTML)开头。
function validBytes(buf, isWasm) {
  if (!buf || buf.byteLength < 8) return false
  const u = new Uint8Array(buf, 0, 4)
  if (isWasm) return u[0] === 0x00 && u[1] === 0x61 && u[2] === 0x73 && u[3] === 0x6d
  return u[0] !== 0x3c
}

// 把大体积 wasm/worker 存进 Cache Storage, 以 blob: URL 交给 duckdb。
// 为何不靠浏览器 HTTP 缓存: eh.wasm 解压后 34MB, 超出磁盘缓存单资源上限 -> 易缓存失败/截断、每刷新重下;
// 故 fetch 一律 `no-store`(不读不写 HTTP 缓存), 改由 Cache Storage(无单资源上限)持久化。
// urls 按序尝试(CN 镜像/同源/CDN), 每个候选都做字节级校验, 首个合法即止并存入。键与宿主无关(稳定)。
async function cachedBlobURL(key, urls, type, isWasm) {
  const req = `${location.origin}/__duckdbwasm__/${key}`
  let cache, buf
  try {
    cache = await caches.open(WASM_CACHE)
    const hit = await cache.match(req)
    if (hit) {
      const b = await hit.arrayBuffer()
      if (validBytes(b, isWasm)) buf = b          // 命中且合法: 用缓存
      else await cache.delete(req).catch(() => {}) // 命中但坏(历史毒化): 删除并回退到重新取
    }
  } catch { /* 无 Cache API */ }
  if (!buf) {
    let err
    for (const u of urls) {
      try {
        const r = await fetch(u, { cache: 'no-store' })
        if (!r.ok) { err = new Error(`${u} → ${r.status}`); continue }
        const b = await r.arrayBuffer()
        if (!validBytes(b, isWasm)) { err = new Error(`${u} → 非法内容(${b.byteLength}B)`); continue }
        buf = b
        try { if (cache) await cache.put(req, new Response(b, { headers: { 'content-type': type } })) }
        catch { /* 配额/无痕: 不缓存也能用 */ }
        break
      } catch (e) { err = e }
    }
    if (!buf) throw err
  }
  return URL.createObjectURL(new Blob([buf], type ? { type } : undefined))
}

export async function initDuck() {
  // JS API: 动态 import 打包出的同源 chunk(惰性加载, 不进首屏; 不再碰 jsDelivr)。
  const duckdb = await import('@duckdb/duckdb-wasm')
  // 候选 bundle 指向打包资产(?url); selectBundle 按浏览器特性挑 mvp/eh。
  const picked = await duckdb.selectBundle({
    mvp: { mainModule: wasmMvp, mainWorker: workerMvp },
    eh:  { mainModule: wasmEh,  mainWorker: workerEh },
  })
  const variant = picked.mainModule === wasmEh ? 'eh' : 'mvp'
  // worker.js + 大 wasm 都过 Cache Storage(跨刷新命中); wasmSrcs 给候选: CN 镜像优先 / 同源 / CDN 兜底。
  // cdnName 用 duckdb 官方原名(CDN 上即此名): worker=duckdb-browser-<v>.worker.js, wasm=duckdb-<v>.wasm。
  const workerUrl = await cachedBlobURL(`${variant}.worker.js`,
    wasmSrcs(picked.mainWorker, `duckdb-browser-${variant}.worker.js`, false), 'text/javascript', false)
  const wasmUrl = await cachedBlobURL(`${variant}.wasm`,
    wasmSrcs(picked.mainModule, `duckdb-${variant}.wasm`, true), 'application/wasm', true)

  const worker = new Worker(workerUrl)
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING)
  db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(wasmUrl, picked.pthreadWorker)
  // 全 GET 模式: 关掉 duckdb-wasm 读 parquet 前的 HEAD(取大小/Range 支持)与 Range 探测,
  // 每个分片只发一条普通 GET(200, 无 Range 头) —— 直接整片下。我们的分片是手工小分片 + 文件级
  // 区间裁剪(prefixes_ip/pathsearch_origin 等), 本就不依赖 duckdb 的 Range 部分读; 整片 GET 让
  // 不可变 ?v= URL 100% 落浏览器磁盘缓存(max-age=1y), 二次访问/重复查询零网络, 且消灭首屏串行
  // HEAD RTT 链。forceFullHTTPReads 需配 allowFullHTTPReads=true(否则全 GET 分支不执行)。
  await db.open({
    path: ':memory:',
    filesystem: { reliableHeadRequests: false, allowFullHTTPReads: true, forceFullHTTPReads: true },
  })
  URL.revokeObjectURL(workerUrl)
  URL.revokeObjectURL(wasmUrl)   // instantiate 已读完 wasm, 释放 blob
  conn = await db.connect()
  // **顺序关键(踩过坑)**: 必须先 setupExtensions 再 tuneSession。tuneSession 里的
  // `SET parquet_metadata_cache=true` 是 **parquet 扩展注册的设置**, DuckDB 为满足该 SET 会
  // autoload parquet(PhysicalSet -> AutoloadExtensionByConfigName)。若此时仓库还没指到自托管,
  // autoload 就跨境拉 extensions.duckdb.org。setupExtensions 先跑(已 LOAD parquet)后, 该 SET
  // 不再触发任何 autoload; 即便 eager 预热失败, 仓库也已指向自托管, autoload 不跨境。
  await setupExtensions(variant)
  await tuneSession()
}

// meta.json 单次加载(它带 version, 决定其它文件的 ?v=, 以及 files 文件清单)。**App 启动与任何按需查询
// 共用这一个 promise** —— 关键: 首页自助探测(SelfProbe)在 meta 到位前就会触发 ensureEngine, 若引擎抢先就绪而
// S.meta 仍为 null, enrichIp 读到的文件清单是空数组 -> read_parquet([]) 抛错 -> 误报「库内无前缀覆盖」。
// 让 ensureEngine 也经此等到 meta 即可堵死该竞态。幂等; 失败不缓存(允许重试)。no-cache: 条件请求拿最新。
let _metaPromise = null
export function ensureMeta() {
  if (S.meta) return Promise.resolve(S.meta)
  if (!_metaPromise) {
    _metaPromise = getData('/meta.json', { cache: 'no-cache' })
      .then(m => { S.meta = m; return m })
      .catch(e => { _metaPromise = null; throw e })
  }
  return _metaPromise
}

// 惰性初始化「路由分析」引擎: DuckDB-WASM(34MB+) + 全量 ASN 名(~1MB)/org 表。
// **WHOIS 视图不需要引擎**(纯 RDAP/网络), 故直开 /whois 不加载; 切到路由分析(或路由 URL)时才调。
// 幂等: 缓存 promise, 只跑一次; 成功置 S.ready, 失败置 S.fatal 并重置(允许后续重试)。
// 先 await ensureMeta(): version 决定 ?v=, 且 ready 之后的查询要靠 meta.files 取文件清单(否则空文件清单误报无覆盖)。
let _enginePromise = null
export function ensureEngine() {
  if (_enginePromise) return _enginePromise
  _enginePromise = (async () => {
    S.loading = true
    // meta 失败不阻断引擎初始化(App 会另置 fatal); 但 happy path 必须等到, 否则查询读空文件清单。
    try { await ensureMeta() } catch (e) { /* meta 不可达: 查询将空, App 已置 fatal */ }
    const asnP = getData(`/asnames.json${dv()}`).then(n => { S.asnNames = n }).catch(() => {})
    const orgP = getData(`/asnorg.json${dv()}`).then(o => { S.asnOrg = o }).catch(() => {})
    try { await initDuck() }
    catch (e) { S.fatal = `DuckDB-WASM: ${e.message}`; S.loading = false; _enginePromise = null; throw e }
    try { await asnP } catch (e) { /* 可选, 忽略 */ }
    try { await orgP } catch (e) { /* 可选, 忽略 */ }
    S.ready = true; S.loading = false; S.msg = ''
  })()
  return _enginePromise
}

// 会话级缓存设置(内存, **仅本会话、不跨刷新**): 减少对同一文件的重复元数据请求 —— 主要是 read_parquet
// 前为取文件大小发的 HEAD(~200ms RTT), 以及 parquet footer 重复解析。同一会话内重复读同一分片即可跳过。
// 逐条 try: 不同 duckdb 版本设置名可能有差异, 缺失则忽略, 不影响主流程。
async function tuneSession() {
  for (const sql of [
    `SET enable_http_metadata_cache=true`,   // 缓存 HTTP 文件元数据(HEAD 取的大小/支持 Range 等)
    `SET enable_object_cache=true`,           // 缓存已解析对象(parquet 元数据), 跨查询复用
    `SET parquet_metadata_cache=true`,        // 缓存 parquet footer 元数据
  ]) {
    try { await conn.query(sql) } catch { /* 该版本无此设置: 忽略 */ }
  }
}

// read_parquet 会 autoload **parquet 扩展**(~3MB)。默认从 extensions.duckdb.org 跨境拉, 首查卡 ~2s。
// 自托管: 把扩展仓库指到同源(海外 CF / 本地 / CN 直连)或 CN 镜像(数据切 CN 时), 启动即预装+加载、首查不卡。
// 引擎按 `${repo}/<引擎版本>/wasm_<variant>/parquet.duckdb_extension.wasm` 取(版本由引擎自填);
// 文件 vendor 在 dist/duckdb-ext/(见 scripts/vendor-duckdb-ext.sh)。**带回退**: 自托管源**确实**不可用(缺文件/被
// CF 当 SPA 回 200 HTML)时, RESET 回退官方 extensions.duckdb.org(退化成默认行为, 不炸)。
//
// **关键(踩过坑)**: eager `INSTALL parquet` 在 duckdb-wasm 浏览器端可能偶发抛错(即便自托管源完全可用); 旧逻辑
// 一抛错就无条件 RESET 回官方源, 于是随后 read_parquet 的 autoload 跨境拉扩展 —— 这正是「自托管失效又跨境」的回归。
// 现在: **只有探测确认自托管扩展真的坏了(取不到 wasm magic)才 RESET**; 否则保留自托管仓库, autoload 仍走自托管。
async function setupExtensions(variant) {
  const repo = DATA.startsWith(CN_ORIGIN)
    ? `${CN_ORIGIN}/duckdb-ext`
    : new URL('./duckdb-ext', document.baseURI).href.replace(/\/$/, '')
  try {
    await conn.query(`SET custom_extension_repository='${repo}'`)
    await conn.query(`SET autoinstall_extension_repository='${repo}'`)
    await conn.query(`INSTALL parquet`)   // 预装(从自托管源)
    await conn.query(`LOAD parquet`)       // 预热: 首个 read_parquet 不再触发拉取
  } catch (e) {
    // eager 预热失败。**不无条件 RESET**(那会让 autoload 跨境)。先探测自托管扩展是否真坏。
    if (await selfHostExtBroken(repo, variant)) {
      try {
        await conn.query(`RESET custom_extension_repository`)
        await conn.query(`RESET autoinstall_extension_repository`)
      } catch { /* ignore */ }
    }
    // 自托管可用但 eager 失败: 保留仓库, read_parquet 时 autoload 自走自托管(不跨境), 仅首查略慢。
  }
}

// 探测自托管 parquet 扩展是否不可用: 取扩展文件头几个字节校验 wasm magic(`\0asm`)。
// 取不到 / 非 wasm(SPA-200 HTML / 404)=> 坏 => 回退官方源。只在 eager 预热失败时调用(happy path 不调)。
// 用 Range 取头部; 若上游忽略 Range 返回整文件(如 CF), 也只读首个 chunk 后 cancel(), 不整下 3MB。
async function selfHostExtBroken(repo, variant) {
  try {
    const ver = await db.getVersion()   // 形如 'v1.4.3'
    const url = `${repo}/${ver}/wasm_${variant}/parquet.duckdb_extension.wasm`
    const r = await fetch(url, { cache: 'no-store', headers: { Range: 'bytes=0-7' } })
    if (!r.ok && r.status !== 206) return true
    const reader = r.body.getReader()
    const { value } = await reader.read()
    reader.cancel().catch(() => {})
    const b = value || new Uint8Array()
    return !(b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d)
  } catch {
    return true
  }
}

// 跑 SQL, 返回普通对象数组 (顶层 BigInt -> Number)
export async function q(sql) {
  const res = await conn.query(sql)
  return res.toArray().map(row => {
    const o = row.toJSON()
    for (const k in o) if (typeof o[k] === 'bigint') o[k] = Number(o[k])
    return o
  })
}

// HTTP 不支持 glob -> 用 meta.files 的显式文件清单; 每个 URL 带 ?v=<数据版本> 做缓存失效。
export const rpList = files => `read_parquet([${(files || []).map(f => `'${DATA}/parquet/${f}${dv()}'`).join(',')}])`
export const rp = name => rpList((S.meta?.files || {})[name])

// paths 分多文件(v4 + v6); pid 全局唯一且两族不交 -> 合查两族 paths_pid 区间, 命中即只读那 1 个文件。
export function pathsFileFor(pid) {
  const idx = [...(S.meta?.files?.paths_pid || []), ...(S.meta?.files?.paths_pid_v6 || [])]
  const hits = idx.filter(e => pid >= e.lo && pid <= e.hi)
  return hits.length ? hits.map(e => e.f)
    : [...(S.meta?.files?.paths || []), ...(S.meta?.files?.paths_v6 || [])]
}

// 全局搜索的 pathsearch 文件全集(v4 + v6)。
const _psAll = () => [...(S.meta?.files?.pathsearch || []), ...(S.meta?.files?.pathsearch_v6 || [])]
const _psOriginIdx = () => [...(S.meta?.files?.pathsearch_origin || []), ...(S.meta?.files?.pathsearch_origin_v6 || [])]

// pathsearch 按 origin_asn 排序 + 区间索引(两族): origin AS 搜索只读覆盖该 ASN 的文件。
// 返回 null = 两族都无该 origin(直接给空结果, 不发查询)。无 origin 过滤 -> 返回全部分片(全表扫)。
export function pathsearchFilesForOrigin(originAsn) {
  const idx = _psOriginIdx()
  if (originAsn == null || !idx.length) return _psAll()
  const hit = idx.filter(e => e.lo != null && e.hi != null && originAsn >= e.lo && originAsn <= e.hi)
  return hit.length ? hit.map(e => e.f) : null
}

// prefixes 按 ip_start 排序 + 每文件 [min ip_start, max ip_end] 区间索引(meta.files.prefixes_ip, **仅 v4**)。
// 精确 IP / 子网 / 父子段查询只读区间与 [start,end] 相交的小文件, 其余整文件跳过(原来恒读整套 ~24MB)。
// v4 ip 列是精确 BIGINT(Number 装得下); v6 的 UHUGEINT 写进 parquet 是有损 DOUBLE 且仅 1~2 个小文件 ->
// 不建索引、回退读全部(行为不变)。无索引(旧数据)/缺 start,end 同样回退全部, 仍正确。
export function prefixesFilesForRange(start, end, v6) {
  const all = v6 ? (S.meta?.files?.prefixes_v6 || []) : (S.meta?.files?.prefixes || [])
  const idx = v6 ? null : S.meta?.files?.prefixes_ip
  if (!idx || !idx.length || start == null || end == null) return all
  const hits = idx.filter(it => it.lo <= end && it.hi >= start).map(it => it.f)
  return hits.length ? hits : all
}

// IRR route 对象明细数据集(meta.files.irr / irr_v6 + v4 区间索引 irr_ip), 同 prefixesFilesForRange 思路。
export function irrFilesForRange(start, end, v6) {
  const all = v6 ? (S.meta?.files?.irr_v6 || []) : (S.meta?.files?.irr || [])
  const idx = v6 ? null : S.meta?.files?.irr_ip
  if (!idx || !idx.length || start == null || end == null) return all
  const hits = idx.filter(it => it.lo <= end && it.hi >= start).map(it => it.f)
  return hits.length ? hits : all
}

// as-set 字符串键文件级索引(数据按键排序 -> 各文件 [lo,hi] 区间不重叠; 字符串字典序与 DuckDB 二进制序一致)。
function _strIdxFiles(allName, idxName, key) {
  const all = S.meta?.files?.[allName] || []
  const idx = S.meta?.files?.[idxName]
  if (!idx || !idx.length || key == null) return all
  const hits = idx.filter(it => it.lo <= key && key <= it.hi).map(it => it.f)
  return hits.length ? hits : []
}
// ASN 邻接计数(asn_neigh)按 asn 数值区间索引: 完整邻居只读覆盖该 asn 的 1 分片。无覆盖=该 asn 不在邻接表。
export function asnNeighFilesForAsn(asn) {
  const idx = S.meta?.files?.asn_neigh_key
  const all = S.meta?.files?.asn_neigh || []
  if (!idx || !idx.length || asn == null) return all
  const hit = idx.filter(e => e.lo != null && e.hi != null && asn >= e.lo && asn <= e.hi).map(e => e.f)
  return hit.length ? hit : []
}

export const assetSetFiles = () => S.meta?.files?.asset_set || []   // 全部(小; 按名查集合时整扫)
export const assetSetFilesForKey = key => _strIdxFiles('asset_set', 'asset_set_key', key)
export const assetMemberFilesForKey = key => _strIdxFiles('asset_member', 'asset_member_key', key)
export const assetMemberOfFilesForKey = m => _strIdxFiles('asset_memberof', 'asset_memberof_key', m)

// 多个 origin ASN -> 覆盖它们的 pathsearch 文件并集(两族)。全都无覆盖才返回 null。
export function pathsearchFilesForOrigins(asns) {
  const idx = _psOriginIdx()
  if (!Array.isArray(asns) || !asns.length || !idx.length) return _psAll()
  const set = new Set()
  for (const a of asns)
    for (const e of idx)
      if (e.lo != null && e.hi != null && a >= e.lo && a <= e.hi) set.add(e.f)
  return set.size ? [...set] : null
}

// byorigin: pathsearch 的精简版(无 paths_blob), 纯 origin 查询(不含 AS_PATH 子串)走这套轻量分片。
// 索引/语义与 pathsearchFilesForOrigin* 完全同构, 只是换 byorigin_origin 索引 + byorigin 文件集。
const _byAll = () => [...(S.meta?.files?.byorigin || []), ...(S.meta?.files?.byorigin_v6 || [])]
const _byOriginIdx = () => [...(S.meta?.files?.byorigin_origin || []), ...(S.meta?.files?.byorigin_origin_v6 || [])]
export function byoriginFilesForOrigin(originAsn) {
  const idx = _byOriginIdx()
  if (originAsn == null || !idx.length) return _byAll()
  const hit = idx.filter(e => e.lo != null && e.hi != null && originAsn >= e.lo && originAsn <= e.hi)
  return hit.length ? hit.map(e => e.f) : null
}
export function byoriginFilesForOrigins(asns) {
  const idx = _byOriginIdx()
  if (!Array.isArray(asns) || !asns.length || !idx.length) return _byAll()
  const set = new Set()
  for (const a of asns)
    for (const e of idx)
      if (e.lo != null && e.hi != null && a >= e.lo && a <= e.hi) set.add(e.f)
  return set.size ? [...set] : null
}
// origin_counts: 每 origin 通告前缀数(v4/v6) 预聚合, 单小文件(按 origin 排序)。
export const originCountsFiles = () => S.meta?.files?.origin_counts || []
