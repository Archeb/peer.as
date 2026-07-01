// 站点 Profile / Feature Flags(前端侧)—— 与后端 ipcollect/profile.py 对应。
// 由构建期环境变量 VITE_SITE 选定(默认 'peeras'); 同后端约定: peeras = 现状全开。
//
// 用法:  import { SITE, features } from './lib/site.js'
//        if (features.geo) { ...地区导航... }
//
// **Phase 1 仅落地此模块, 组件尚未接线**(地区导航/RDAP 去留是 Phase 2 = 实现 dn42 前端)。
// 维护铁律(见 AGENTS.md「站点 Profile」): 差异靠开关关成 no-op, 不靠删代码分叉。

export const SITE = (import.meta.env.VITE_SITE || 'peeras')

const PROFILES = {
  peeras: {
    geo: true,         // 地区(国家/城市)导航 + geo 数据视图
    rdapWhois: true,   // whois 走公网 RDAP 直连 + 兜底 worker(dn42 改 registry 静态数据)
    dns: true,         // DNS 解析视图(DoH)
    cnMirror: true,    // 存在 cn.peer.as 整站镜像 -> 前端 configure() 才做 CN 分流(切数据到镜像)
    whoisView: true,   // 侧栏「WHOIS·RDAP」独立查询视图(直查任意 ASN/IP/前缀/域名注册信息)
    routeTrace: true,  // 「全球路由跟踪」视图(globalping MTR + 自有 IP 库, 3D 地球可视化)
    peeringdb: true,   // PeeringDB/IXP 浏览器 + ASN peering 画像
  },
  dn42: {
    geo: false,
    rdapWhois: false,  // whois 走静态 registry JSON
    dns: false,        // 无 DoH 解析; 但域名仍可查 registry whois(见 queries.js)
    cnMirror: false,   // dn42 只上 CF Pages、无 cn.peer.as 镜像 -> 前端永不做 CN 分流(否则会切到只镜像 peeras 数据的 cn.peer.as, 加载错数据集炸掉)
    whoisView: false,  // dn42 关掉独立 WHOIS 视图(no-op): 域名/ASN 信息仍由详情面板 registry whois 提供, 不另立公网式入口
    routeTrace: false, // dn42 无 globalping 监测点覆盖 -> 关掉全球路由跟踪视图
    peeringdb: false,
  },
}

export const features = PROFILES[SITE] || PROFILES.peeras

// 站点 logo / 品牌(结构性, 非 i18n)。.hi 段用 accent 高亮。
const BRANDS = {
  peeras: { main: 'PEER', hi: '.AS' },
  dn42: { main: 'DN42.PEER', hi: '.AS' },
}
export const brand = BRANDS[SITE] || BRANDS.peeras
