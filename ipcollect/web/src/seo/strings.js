// SEO 落地页文案(zh/en)—— 边缘 SSR 的**唯一文案源**:body 组件(*.Seo.svelte)与 _worker.js 的 <head>
// 都从这里取,保证标题/描述/正文一致。
//
// **铁律:本文件及同目录组件零依赖 app 内部**(不 import store/db/i18n,不碰浏览器 API),
// 仅纯函数 + 字面量 → SSR 安全、单向依赖、SSR 整层可被抠掉而不影响 SPA 构建。

export const BRANDS = { peeras: 'PEER.AS', dn42: 'DN42.PEER.AS' }

export function pickLang(lang) { return lang === 'en' ? 'en' : 'zh' }

// ASN 落地页文案。data = {asn, name, nameEn, org, v4, v6, peers, brand}
export function asnText(lang, d) {
  const zh = lang !== 'en'
  const nm = (zh ? d.name : (d.nameEn || d.name)) || ''
  const brand = d.brand || BRANDS.peeras
  const total = (d.v4 || 0) + (d.v6 || 0)
  const peers = d.peers || 0
  const heading = `AS${d.asn}${nm ? ' · ' + nm : ''}`
  return {
    nm, brand, heading,
    v4label: zh ? 'IPv4 前缀' : 'IPv4 prefixes',
    v6label: zh ? 'IPv6 前缀' : 'IPv6 prefixes',
    peerLabel: zh ? '邻居(Peers)' : 'Peers',
    orgLabel: zh ? '运营组织' : 'Organization',
    summary: zh
      ? `自治系统 AS${d.asn}${nm ? `(${nm})` : ''} 在全球 BGP 路由表中作为 origin 通告 `
        + `${d.v4 || 0} 个 IPv4 前缀和 ${d.v6 || 0} 个 IPv6 前缀(共 ${total} 个),观测到 ${peers} 个邻居(peers)。`
        + `在 ${brand} 查看其通告前缀、回程 AS_PATH、上下游邻居(provider/peer/customer)与对等关系。`
      : `Autonomous System AS${d.asn}${nm ? ` (${nm})` : ''} originates ${d.v4 || 0} IPv4 `
        + `and ${d.v6 || 0} IPv6 prefixes (${total} total) and is seen with ${peers} peers in the global BGP routing table. `
        + `Explore its announced prefixes, backhaul AS_PATH, upstream/peer/downstream neighbors and peering on ${brand}.`,
    cta: zh ? '正在加载交互式 BGP 分析…' : 'Loading interactive BGP analysis…',
    title: zh
      ? `AS${d.asn}${nm ? ' ' + nm : ''} — BGP 路由 · 通告前缀 · 邻居 · ${brand}`
      : `AS${d.asn}${nm ? ' ' + nm : ''} — BGP routing · prefixes · neighbors · ${brand}`,
    desc: zh
      ? `AS${d.asn}${nm ? `(${nm})` : ''} 的 BGP 洞察:${d.v4 || 0} 个 IPv4 + ${d.v6 || 0} 个 IPv6 通告前缀、`
        + `${peers} 个邻居、回程 AS_PATH 与对等关系。${brand} 全球 BGP/IP/ASN 情报。`
      : `BGP insights for AS${d.asn}${nm ? ` (${nm})` : ''}: ${d.v4 || 0} IPv4 + ${d.v6 || 0} IPv6 prefixes, `
        + `${peers} peers, backhaul AS_PATH and peering. Global BGP/IP/ASN intelligence on ${brand}.`,
  }
}

// AS-SET 落地页文案。data = {key, source, descr, count, brand}
export function assetText(lang, d) {
  const zh = lang !== 'en'
  const brand = d.brand || BRANDS.peeras
  return {
    brand,
    membersLabel: zh ? '直接成员' : 'direct members',
    sourceLabel: zh ? '登记于' : 'Registered in',
    summary: zh
      ? `as-set ${d.key}${d.descr ? ` —— ${d.descr}` : ''}。该 IRR as-set 含 ${d.count || 0} 个直接成员`
        + `${d.source ? `,登记于 ${d.source}` : ''}。在 ${brand} 展开其客户锥层级、成员 ASN 与子 as-set。`
      : `as-set ${d.key}${d.descr ? ` — ${d.descr}` : ''}. This IRR as-set has ${d.count || 0} direct members`
        + `${d.source ? `, registered in ${d.source}` : ''}. Expand its customer cone, member ASNs and sub-as-sets on ${brand}.`,
    cta: zh ? '正在加载 as-set 层级树…' : 'Loading as-set hierarchy…',
    title: zh
      ? `${d.key} — IRR as-set · 客户锥 · 成员 · ${brand}`
      : `${d.key} — IRR as-set · customer cone · members · ${brand}`,
    desc: zh
      ? `IRR as-set ${d.key} 的客户锥与成员:${d.count || 0} 个直接成员`
        + `${d.source ? `,登记于 ${d.source}` : ''}。${brand} 全球 BGP/IRR 情报。`
      : `Customer cone and members of IRR as-set ${d.key}: ${d.count || 0} direct members`
        + `${d.source ? `, registered in ${d.source}` : ''}. Global BGP/IRR intelligence on ${brand}.`,
  }
}

// 入口页文案。page ∈ home|advanced|trace|probe
export function entryText(lang, page, brand) {
  const zh = lang !== 'en'
  brand = brand || BRANDS.peeras
  const T = {
    home: {
      zh: { h1: `${brand} — 全球 BGP · IP · ASN 情报`,
        sum: `${brand} 是一个快速、静态、可复现的 BGP looking glass 与 IP/ASN 情报工具:查询任意 IP 前缀、`
          + `自治系统(ASN)、AS_PATH、origin 与对等关系,基于多采集点公开 MRT 全表的回程路由分析。`,
        title: `${brand} — BGP, IP & ASN 情报 · looking glass`,
        desc: `查询全球 BGP 路由、IP 前缀、ASN、AS_PATH、origin 与对等关系。快速、静态、可复现的 BGP looking glass 与 IP/ASN 情报工具。` },
      en: { h1: `${brand} — Global BGP, IP & ASN Insights`,
        sum: `${brand} is a fast, static, reproducible BGP looking glass and IP/ASN intelligence tool: look up any IP `
          + `prefix, Autonomous System (ASN), AS_PATH, origins and peering, from multi-collector public MRT full-table backhaul routing.`,
        title: `${brand} — BGP, IP & ASN Insights · looking glass`,
        desc: `Explore global BGP routing, IP prefixes, ASNs, AS_PATH, origins and peering. A fast, static, reproducible BGP looking glass and IP/ASN intelligence tool.` },
    },
    advanced: {
      zh: { h1: `${brand} 路由分析`,
        sum: `按 origin ASN、国家/地区、城市、AS_PATH 子序列筛选全球 IP 前缀,查看回程路径、MOAS、RPKI/IRR 状态并导出。`,
        title: `路由分析 — 前缀 · AS_PATH · origin 筛选 · ${brand}`,
        desc: `按 origin ASN、国家、城市与 AS_PATH 子序列筛选全球 IP 前缀,查看回程路径、MOAS 与 RPKI/IRR 状态。` },
      en: { h1: `${brand} Route Analysis`,
        sum: `Filter global IP prefixes by origin ASN, country/region, city and AS_PATH subsequence; inspect backhaul paths, MOAS, RPKI/IRR status and export.`,
        title: `Route Analysis — prefix · AS_PATH · origin filter · ${brand}`,
        desc: `Filter global IP prefixes by origin ASN, country, city and AS_PATH subsequence; inspect backhaul paths, MOAS and RPKI/IRR status.` },
    },
    trace: {
      zh: { h1: `全球路由跟踪`,
        sum: `从全球多个探测点对目标 IP/域名做 MTR/traceroute,在 3D 地球上可视化每一跳的 ASN 与地理位置。`,
        title: `全球路由跟踪 — MTR · traceroute 可视化 · ${brand}`,
        desc: `从全球多个探测点对目标做 MTR/traceroute,3D 地球可视化每跳 ASN 与地理位置。` },
      en: { h1: `Global Route Trace`,
        sum: `Run MTR/traceroute to a target IP/host from probes worldwide and visualize each hop's ASN and geolocation on a 3D globe.`,
        title: `Global Route Trace — MTR · traceroute visualization · ${brand}`,
        desc: `Run MTR/traceroute from worldwide probes and visualize each hop's ASN and geolocation on a 3D globe.` },
    },
    probe: {
      zh: { h1: `你的接入`,
        sum: `自动探测你的来源 IP:覆盖前缀、origin ASN、直接观测到的上游,以及 IPv6 可达性。`,
        title: `IP 接入探测 — 你的前缀 · origin · 上游 · ${brand}`,
        desc: `自动探测你的来源 IP:覆盖前缀、origin ASN、直接观测上游与 IPv6 可达性。` },
      en: { h1: `Your Connectivity`,
        sum: `Auto-probe your source IP: covering prefix, origin ASN, directly observed upstreams and IPv6 reachability.`,
        title: `IP Connectivity Probe — your prefix · origin · upstreams · ${brand}`,
        desc: `Auto-probe your source IP: covering prefix, origin ASN, directly observed upstreams and IPv6 reachability.` },
    },
  }
  const e = (T[page] || T.home)[zh ? 'zh' : 'en']
  return {
    ...e, brand,
    cta: zh ? '正在加载交互界面…' : 'Loading interactive interface…',
  }
}

// bot 内容层左侧 rail 的全站内链(品牌→首页、国家目录)。href 带 lang(与 SSR 其它内链一致)。
export function navText(lang) {
  const zh = lang !== 'en'
  const lq = zh ? '' : '?lang=en'
  return {
    lq,
    home: zh ? '回到首页' : 'Home',
    networks: zh ? '按国家浏览所有自治系统(ASN)' : 'Browse all Autonomous Systems by country',
  }
}
