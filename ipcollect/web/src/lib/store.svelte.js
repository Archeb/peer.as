// 全局响应式状态 (Svelte 5 runes)。各组件 import { S } 读写, 深层响应。
export const S = $state({
  meta: null,
  asnNames: {},            // 全量 ASN -> 名(APNIC autnums + 注册表覆盖); 开机 fetch asnames.json
  asnOrg: {},              // ASN -> organization(GeoLite2-ASN); 开机 fetch asnorg.json
  ready: false,            // DuckDB-WASM 就绪
  edge: 'cf',              // 'cf' | 'cn'：数据/wasm 宿主(configure 选定)；cn=正用中国优化 VPS
  lang: 'zh',
  theme: 'auto',           // auto | light | dark
  loading: true,
  fatal: '',               // 致命错误文案(meta.json / DuckDB 引擎加载失败); 仅路由分析视图显示, 不阻断 WHOIS 视图
  notFound: null,          // { target } —— 路径无法解析为任何已知路由/对象时置(404); App 渲染 NotFound, applyRoute/goHome 清空
  msg: '',
  // 慢查询(全表 AS_PATH 扫描)进度条: DuckDB-WASM 单次 query 无分片进度回调 -> 用 NProgress 式涓流条:
  // 运行中缓增逼近 0.9(永不到顶), 查询返回时补满 1 再淡出。仅 Topbar statusline 渲染。
  busy: false,             // 慢查询进行中(进度条可见)
  prog: 0,                 // 进度 0..1
  rows: [],                // 当前结果行
  // 顶层视图: 'routing'(BGP 路由分析: 主查询页 + 详情面板) | 'whois'(WHOIS·RDAP 独立查询视图)
  // | 'trace'(全球路由跟踪: globalping MTR + 自有 IP 库, 3D 地球可视化)。
  // 侧栏/移动菜单切换; URL /whois[/<q>] 进 whois, /trace[/<target>] 进 trace, 其余回 routing(见 queries.applyRoute)。
  // dn42 站经 features.whoisView=false / features.routeTrace=false 关掉整条视图(no-op), 此字段恒为 'routing'。
  view: 'routing',
  // 全球路由跟踪视图载荷: target=当前跟踪目标(IP/域名); ntraceId=NextTrace traceMap JSON 深链。
  // 实际 MTR/traceMap 模型在 RouteTraceView 本地态(从流式事件/JSON 重建)。
  trace: { target: '' },
  // WHOIS·RDAP 独立视图载荷: input=用户原始输入串; kind/key=解析后传给 Whois 组件
  // (kind: 'autnum'|'ip'|'domain'; key=ASN号/IP·前缀串/可注册域名); err=识别失败的 i18n 键(空=正常)。
  whois: { input: '', kind: null, key: null, err: '' },
  // 「高级搜索」开关(localStorage 记忆, App.onMount 初始化): 勾上后首页搜索框任何查询都直接进路由分析(/advanced), 不出简洁 WHOIS。
  advWhois: false,
  // 首页「你的接入」卡片堆是否已"发牌"摊开成网格(SelfProbe 内的箭头切换; 出结果/回首页时复位)。
  probeExpanded: false,
  // 首页是否默认显示「你的接入」探测卡片(侧栏 IP 探测旁的图钉钮切换, localStorage 记忆, App.onMount 初始化)。
  // 关掉后首页只留字标 + 查询框(仍居中); 仍可经侧栏「IP 探测」进完整探测视图。
  probePinned: true,
  mode: 'prompt',          // prompt | country | global | subnet | dns
  // DNS 解析视图载荷(mode==='dns' 时主内容区改渲染 DnsView): { domain, loading, error, status, a:[], aaaa:[], others:[] }
  // a/aaaa 行已富集前缀+origin asn(由 queries.runDns 查 prefixes 得到); others = 其它记录类型分组。
  dns: null,
  // as-set 嵌套列表载荷(mode==='asset' 时主内容区改渲染 AsSetView): { key, name, source, descr, n_members, loading, error, candidates }
  // 树的子层由 AsSetTree 组件经 loadAsSetMembers(setKey) 懒加载(点一层查一层 + 环检测)。
  asset: null,
  filters: { cc: '', city: '', person: '', path: '', origin: '', ip: '', limit: 500, incllow: false, fam: 'all' },
  selectedPid: null,       // 选中行(高亮 + 展开本段)
  // ── 右侧详情面板 ──────────────────────────────────────────────
  // detailKind: 当前面板视图 'prefix' | 'asn' | 'domain' | null(关闭)。prefix 载荷在 insight, asn 在 asnView, domain 在 domainView。
  detailKind: null,
  insight: null,           // { prefix, loc, origin_asn, n_paths, lowvis, paths:[{asns,peers,is_best}], sup:[], sub:[], loading }
  asnView: null,           // { asn, name, loading, error, count4, count6, prefixes:[], rel:{up,peer,down}, neigh:null|{up,peer,down,scanned} } ; 组员 {asn,n,d,u,ev}
  domainView: null,        // { domain } —— 域名详情面板载荷; WHOIS/RDAP 由 Whois.svelte(kind='domain') 自取。
  // 主体上下文: 精确框是 ASN/域名 时 = {kind:'asn'|'domain', id}; 用于「关闭子页时先返回主体」语义。其它输入则 null。
  subject: null,
  // 面板前进/后退 = 浏览器历史驱动(pushState/popstate)。idx=当前历史序号, max=已达最大序号(决定能否前进)。
  nav: { idx: 0, max: 0 },
  about: false,
  changelog: false,
  pathHelp: false,            // AS_PATH 语法帮助弹窗
  menu: false,                // 移动端下拉菜单开关
  side: false,                // 桌面左侧栏抽屉开关(默认收起, 顶部左上 menubtn 切换)
  sortKey: 'n_paths',
  sortDir: -1,
  // ── 结果表分页 + 导出(仅 global/country/subnet 表格模式)──
  page: 0,                 // 0-based 当前页; 翻页按 offset=page*limit 重查。新搜索归 0。
  more: false,             // 当前页之后是否还有更多(取 limit+1 判断)
  exportOpen: false,       // 数据导出浮窗开关
  detailW: 42,             // 详情栏宽度 %
})
