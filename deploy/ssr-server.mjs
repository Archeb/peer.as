// peer.as 自托管 SSR(VPS)—— 用纯 Node 跑 CF Pages 的 _worker.js bundle。
//
// 背景:边缘 SEO SSR 原本是 CF Pages Function(advanced mode),但 ① Pages Function 10万/天配额被
// AI 爬虫(GPTBot)爬爆 ② 想 SSG 全量预渲染又撞 Pages 单部署 ≤2万文件。落地页是全球表量级(8万+),
// 两道墙都过不去。改由**自己的 VPS** 跑同一份 `_worker.js`(零改造复用),前面 CF for SaaS + cache-all
// 兜爬虫;VPS 不限文件数、不按次计费,随便爬。
//
// 本服务做两件事(同一个 loopback 端口):
//   1. SEO 路由(/ /<asn> /asset/* /networks* /advanced /trace /probe)→ 调 worker.fetch() 出 SSR HTML。
//   2. /data/* → 直接从本地磁盘(SSR_DATA_DIR)读 —— worker 的 DATA_ORIGIN 指回本服务自身环回,
//      故数据走**本地盘**,不再每个冷 isolate 跨源拉 data.peer.as 的 8.6MB asset.json(慢且偶发卡死)。
//
// Caddy 把上述 SEO 路由 reverse_proxy 到本服务(127.0.0.1:SSR_PORT);其余(静态/dns/whois/og)Caddy 直服。
// 纯 node builtin,无需在 VPS 上 npm install(svelte 等已打进 bundle)。
//
// env:SSR_WORKER(bundle 路径)· SSR_STATIC_ROOT(含 index.html 的前端根)· SSR_DATA_DIR(本地 /data 根)
//      · SSR_HOST/SSR_PORT(默认 127.0.0.1:8788)。

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'

const WORKER      = process.env.SSR_WORKER      || '/opt/peeras-ssr/_worker.js'
const STATIC_ROOT = process.env.SSR_STATIC_ROOT || '/var/www/cn'
const DATA_DIR    = process.env.SSR_DATA_DIR    || '/var/www/cn/data'
const HOST        = process.env.SSR_HOST        || '127.0.0.1'
const PORT        = parseInt(process.env.SSR_PORT || '8788', 10)
const DATA_ORIGIN = `http://${HOST}:${PORT}`   // worker 的数据源 = 本服务自身(/data/* 从本地盘出)

const worker = (await import(WORKER)).default

// index.html 外壳(SEO 路由注入用 + 回退 SPA-200)。缓存在内存,部署换文件需重启服务。
let _index = null
async function indexHtml() {
  if (_index == null) {
    _index = await readFile(path.join(STATIC_ROOT, 'index.html'), 'utf8')
      .catch(() => '<!doctype html><html><head></head><body><div id="app"></div></body></html>')
  }
  return _index
}

// env.ASSETS:worker 取 /index.html 外壳 + 非 SEO 路由回退都走这里。Caddy 只把 SEO 路由喂进来,
// 故这里返回 index.html 即可(= CF 上的 SPA-200 回退语义)。
const env = {
  DATA_ORIGIN,
  ASSETS: { fetch: async () => new Response(await indexHtml(), {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  }) },
}

// 把请求交给 worker;worker 内部已全程 fail-safe(异常 → env.ASSETS)。这里再兜一层。
async function ssr(request) {
  try { return await worker.fetch(request, env) }
  catch { return new Response(await indexHtml(), {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) }
}

// /data/* → 本地盘(防目录穿越:解析后必须仍在 DATA_DIR 内)。
function serveData(reqPath, res) {
  const rel = decodeURIComponent(reqPath.replace(/^\/data/, '')).split('?')[0]
  const file = path.normalize(path.join(DATA_DIR, rel))
  if (!file.startsWith(DATA_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404; return res.end('not found')
  }
  res.statusCode = 200
  res.setHeader('content-type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream')
  createReadStream(file).pipe(res)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || 'peer.as'}${req.url}`
    const pathname = req.url.split('?')[0]
    if (pathname.startsWith('/data/')) return serveData(req.url, res)

    let request
    try { request = new Request(url, { method: req.method, headers: req.headers }) }
    catch { request = new Request(url) }   // 个别非法 header → 退化为无头请求
    const out = await ssr(request)
    res.statusCode = out.status
    out.headers.forEach((v, k) => { try { res.setHeader(k, v) } catch {} })
    res.end(await out.text())
  } catch (e) {
    res.statusCode = 500; res.end('')
  }
})

// 仅作为入口时监听(被 import 做单测时设 SSR_NO_LISTEN=1 跳过)。
if (process.env.SSR_NO_LISTEN !== '1') {
  server.listen(PORT, HOST, () =>
    console.error(`[peeras-ssr] ${HOST}:${PORT}  worker=${WORKER}  static=${STATIC_ROOT}  data=${DATA_DIR}`))
}

export { server, ssr, env }
