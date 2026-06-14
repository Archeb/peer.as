// peer-as-nexttrace —— globalping measurement 的 geo 富集反代。
//
// 设计(见 wrangler.toml):客户端用自己的 IP 直接 POST 创建 globalping measurement(否则 worker
// 单一出口 IP 会被 GP 限流);本 worker 仅 GET `?id=<measureId>` → 向 GP 取回该 measurement →
// 抽取其中出现的公网跳/目标 IP → 用「无限额 NextTrace token」(服务端 secret)批量查 geo → 把
// geo 附在响应 `d.geo = { ip: GeoResult }` 里返回。只认真实 measureId、只给该 measurement 里的
// IP 附 geo,故不能被滥用为任意 IP 的免费 geo 代理。
//
// 响应 = 原 globalping measurement JSON + 额外的 `geo` 字段。前端 `geo-resolve.js` 的 nexttrace
// 源直接读 `d.geo[ip]`(已是归一化 GeoResult,按 ?lang= 出中/英地名),无需任何客户端 token。

interface Env {
  NEXTTRACE_TOKEN: string
}

interface GeoResult {
  ip: string
  cc: string
  city: string
  province: string
  asn: number | null
  prefix: string | null
  lat: number
  lon: number
  source: 'nexttrace'
  place: string
}

const GP_BASE = 'https://api.globalping.io/v1/measurements/'
const NT_BATCH = 'https://api.nxtrace.org/v4/ipGeo/batch'
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
}

// 私网 / LAN / 保留地址(无公网 geo 意义)→ 不查、不返回(与前端 isPrivate 一致)。
function isPrivate(ip: string): boolean {
  if (!ip) return true
  if (ip.includes(':')) {
    const s = ip.toLowerCase()
    return s === '::1' || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')
      || s.startsWith('fc') || s.startsWith('fd')
  }
  const m = ip.split('.').map(Number)
  if (m.length !== 4 || m.some((x) => isNaN(x))) return true
  const [a, b] = m
  return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

// 一条 NextTrace IPGeoData → 归一化 GeoResult(按 zh 选中/英文地名);无坐标 → null。
function ntGeoResult(ip: string, j: any, zh: boolean): GeoResult | null {
  if (!j) return null
  const lat = typeof j.lat === 'number' ? j.lat : parseFloat(j.lat)
  const lon = typeof j.lng === 'number' ? j.lng : parseFloat(j.lng)
  if (!isFinite(lat) || !isFinite(lon)) return null
  const asnRaw = j.asnumber ? parseInt(String(j.asnumber).replace(/^AS/i, ''), 10) : NaN
  const pick = (z: any, e: any) => (zh ? (z || e) : (e || z)) || ''
  const city = pick(j.city, j.city_en), prov = pick(j.prov, j.prov_en), country = pick(j.country, j.country_en)
  const parts: string[] = []
  for (const x of [city, prov, country]) { const v = (x || '').trim(); if (v && !parts.includes(v)) parts.push(v) }
  return {
    ip, cc: j.country_code || '', city: city || prov || country, province: prov || '',
    asn: isFinite(asnRaw) ? asnRaw : null, prefix: j.prefix || null,
    lat, lon, source: 'nexttrace', place: parts.join(' · '),
  }
}

// NextTrace 单批最大 IP 数:超过的等下一批(批与批串行, 见 geoForIps 的 for 循环)。
const NT_BATCH_MAX = 10

// 一批 IP → { ip: IPGeoData }。POST NextTrace batch;失败(网络错 / 非 2xx)重试 1 次, 两次都失败返回空 Map
// (该批无 geo, 前端退化为无坐标, 不阻塞整体)。
async function ntBatchGeo(chunk: string[], token: string): Promise<Map<string, any>> {
  const map = new Map<string, any>()
  for (let attempt = 0; attempt < 2; attempt++) {       // 首次 + 失败后重试 1 次
    try {
      const r = await fetch(NT_BATCH, {
        method: 'POST',
        headers: { 'X-NextTrace-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ips: chunk }),
      })
      if (r.ok) {
        const j: any = await r.json()
        for (const it of (j.results || [])) if (it && it.ok && it.data) map.set(it.ip, it.data)
        return map
      }
      // 非 2xx → 落到下一轮重试
    } catch { /* 网络错误 → 落到下一轮重试 */ }
  }
  return map
}

// 一组 IP → { ip: GeoResult }。边缘 Cache API 按 (lang,ip) 缓存(IP geo 稳定, 反复轮询只查新 IP);
// 缓存未命中的批量查 NextTrace(每 NT_BATCH_MAX 一组, 批间串行)。某 IP 无 geo → 不出现在结果里(前端视为无坐标)。
async function geoForIps(ips: string[], token: string, zh: boolean, ctx: ExecutionContext): Promise<Record<string, GeoResult>> {
  const out: Record<string, GeoResult> = {}
  const cache = caches.default
  const keyOf = (ip: string) => `https://nt-geo.internal/${zh ? 'zh' : 'en'}/${ip}`
  const miss: string[] = []
  await Promise.all(ips.map(async (ip) => {
    const hit = await cache.match(keyOf(ip))
    if (hit) { try { out[ip] = await hit.json() } catch { miss.push(ip) } }
    else miss.push(ip)
  }))
  for (let i = 0; i < miss.length; i += NT_BATCH_MAX) {
    const chunk = miss.slice(i, i + NT_BATCH_MAX)
    const map = await ntBatchGeo(chunk, token)
    for (const ip of chunk) {
      const g = map.has(ip) ? ntGeoResult(ip, map.get(ip), zh) : null
      if (g) {
        out[ip] = g
        ctx.waitUntil(cache.put(keyOf(ip), new Response(JSON.stringify(g), { headers: { 'Cache-Control': 'max-age=86400' } })))
      }
    }
  }
  return out
}

const json = (obj: any, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
    const url = new URL(req.url)
    const id = url.searchParams.get('id') || ''
    const zh = url.searchParams.get('lang') === 'zh'
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(id)) return json({ error: 'bad or missing measurement id' }, 400)

    // 1) 取回 globalping measurement(GET; 匿名 measurement 公开可读, 无需 GP token)
    const gpr = await fetch(GP_BASE + encodeURIComponent(id), { headers: { Accept: 'application/json' } })
    const body = await gpr.text()
    if (!gpr.ok) return new Response(body, { status: gpr.status, headers: { ...CORS, 'Content-Type': 'application/json' } })
    let d: any
    try { d = JSON.parse(body) } catch { return new Response(body, { headers: { ...CORS, 'Content-Type': 'application/json' } }) }

    // 2) 抽取该 measurement 里出现的公网 IP(目标 + 各跳)
    const ips = new Set<string>()
    for (const res of (d.results || [])) {
      const r = res.result || {}
      if (r.resolvedAddress && !isPrivate(r.resolvedAddress)) ips.add(r.resolvedAddress)
      for (const h of (r.hops || [])) if (h.resolvedAddress && !isPrivate(h.resolvedAddress)) ips.add(h.resolvedAddress)
    }

    // 3) 附加 geo(无 token 配置 → 空 geo, 前端退化为无坐标但仍出结果)
    d.geo = (env.NEXTTRACE_TOKEN && ips.size) ? await geoForIps([...ips], env.NEXTTRACE_TOKEN, zh, ctx) : {}
    return json(d)
  },
}
