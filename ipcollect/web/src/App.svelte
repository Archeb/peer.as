<script>
  import { onMount } from 'svelte'
  import Fa from 'svelte-fa'
  import { S } from './lib/store.svelte.js'
  import { configure, ensureEngine, ensureMeta } from './lib/db.js'
  import { applyTheme, setLang } from './lib/ui.js'
  import { ccLabel } from './lib/bgp.js'
  import { applyRoute, hardCloseDetail, clearDetail, isNotFoundPath } from './lib/queries.js'
  import { t } from './lib/i18n.js'
  import { brand, features } from './lib/site.js'
  import { iSpinner, iMenu, iClose } from './lib/icons.js'
  import Sidebar from './components/Sidebar.svelte'
  import MobileBar from './components/MobileBar.svelte'
  import Topbar from './components/Topbar.svelte'
  import WhoisView from './components/WhoisView.svelte'
  import RouteTraceView from './components/RouteTraceView.svelte'
  import Results from './components/Results.svelte'
  import NotFound from './components/NotFound.svelte'
  import DnsView from './components/DnsView.svelte'
  import AsSetView from './components/AsSetView.svelte'
  import InsightDrawer from './components/InsightDrawer.svelte'
  import AboutModal from './components/AboutModal.svelte'
  import ChangelogModal from './components/ChangelogModal.svelte'
  import PathHelpModal from './components/PathHelpModal.svelte'
  import ExportModal from './components/ExportModal.svelte'

  // 当前正在查看的详情(prefix/asn/domain/dns)对应的页标题 —— 让每个 pushState 历史项可辨识(便于翻历史记录)；
  // 无详情时回落默认页标题。随详情状态 + 语言响应式变化(与 queries.js 的 go() pushState 同源, 故历史项标题对应正确)。
  function pageTitle() {
    const B = brand.main + brand.hi
    // 详情子页(prefix/asn/domain): 对象名 · 品牌。trace 浮窗里开 insight 也命中, 故先于各视图落地页判定。
    if (S.detailKind === 'prefix' && S.insight?.prefix) return `${S.insight.prefix} · ${B}`
    if (S.detailKind === 'asn' && S.asnView) {
      const n = S.asnView.name
      return `AS${S.asnView.asn}${n ? ' ' + n : ''} · ${B}`
    }
    if (S.detailKind === 'domain' && S.domainView?.domain) return `${S.domainView.domain} · ${B}`
    if (S.mode === 'dns' && S.dns?.domain) return `${S.dns.domain} · ${B}`   // 移动端无右侧面板时仍用域名
    if (S.mode === 'asset' && (S.asset?.key || S.asset?.input)) return `${S.asset.key || S.asset.input} · ${B}`
    // 各视图落地页标题:首页用品牌默认标题(不带 WHOIS); 其余三页带 "<名称> · 品牌"。
    if (S.view === 'whois') {
      if (S.whois?.input) return `${S.whois.input} · WHOIS · ${B}`   // WHOIS 查询结果(非首页, 仍标 WHOIS)
      if (S.probeExpanded) return `${t('nav_probe')} · ${B}`         // IP 探测落地页
      return t('page_title')                                        // 首页(去掉 WHOIS)
    }
    if (S.view === 'trace') return `${t('nav_trace')} · ${B}`        // 环球网测落地页
    if (S.view === 'routing') return `${t('nav_routing')} · ${B}`    // 路由分析落地页
    return t('page_title')
  }

  // 随语言/详情本地化 <head>: title / lang / description (切英文时 title 也变英文; 切详情时 title 变成正在看的对象)。
  $effect(() => {
    document.documentElement.lang = S.lang === 'zh' ? 'zh-CN' : 'en'
    document.title = pageTitle()
    const d = document.querySelector('meta[name="description"]')
    if (d) d.setAttribute('content', t('page_desc'))
  })

  // ── 边缘 SSR(#seo-shell)无缝接管 ───────────────────────────────────────────
  // _worker.js 给爬虫/直达落地者注入了全屏覆盖的 #seo-shell(含真实内容)。SPA 在此处「同壳接管」:
  // 当对应视图的实时内容就绪后移除该覆盖层, 露出 app —— 同 URL、无跳转、内容优先(加载期看到的是内容而非转圈)。
  // **仅 DOM id 约定, 不 import seo/**(单向依赖)。纯静态/本地 dev 无 #seo-shell 时全为 no-op。
  let _seoGone = false
  function dropSeo() { if (!_seoGone) { _seoGone = true; document.getElementById('seo-shell')?.remove() } }
  $effect(() => {
    if (_seoGone) return
    if (S.fatal || S.notFound) return dropSeo()                     // 出错 / 404 -> 让 app 的对应态显示
    if (S.view === 'whois' || S.view === 'trace') return dropSeo()  // 即时视图: 立刻接管
    if (S.view === 'routing') {
      if (S.loading) return                                         // 引擎加载中: 继续展示 SSR 内容
      if (S.detailKind === 'asn') { if (S.asnView && !S.asnView.loading) dropSeo(); return }
      if (S.detailKind === 'prefix') { if (S.insight && !S.insight.loading) dropSeo(); return }
      if (S.mode === 'asset') { if (S.asset && !S.asset.loading) dropSeo(); return }
      dropSeo()                                                     // 路由分析空落地页等已就绪
    }
  })

  onMount(async () => {
    applyTheme(localStorage.getItem('ipc-theme') || 'auto')
    setTimeout(dropSeo, 12000)   // 兜底: 引擎卡住/异常时, 覆盖层最多 12s 后也移除, 绝不长期遮挡 app

    S.advWhois = localStorage.getItem('ipc-adv-whois') === '1'   // 「高级搜索」记忆态
    const qp = new URLSearchParams(location.search)
    setLang(qp.get('lang') || localStorage.getItem('ipc-lang')
      || ((navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'))
    const dw = parseFloat(localStorage.getItem('ipc-detail-w')); if (dw) S.detailW = Math.min(72, Math.max(38, dw))

    // peeras 首页(/, 无 ?q)与 /whois 深链 = WHOIS 视图: 不依赖引擎/meta, 立刻**同步**解析并渲染终态。
    // 关键: 不能只切 view 而把目标留到下面 await 之后再解析 —— 否则首帧落在 WHOIS 首页(地球/立体字可见),
    // 等 meta 拉完才 applyRoute 出详情, 会从首页"动画收起"到详情。这里同步 applyRoute, 让首帧直接就是详情/首页终态。
    const whoisLanding = features.whoisView && (/^\/whois(\/|$)/.test(location.pathname) || (location.pathname === '/' && !qp.has('q')))
    if (whoisLanding) { S.view = 'whois'; S.loading = false; applyRoute({ initial: true }) }

    // /trace 同理: 全球路由跟踪是纯前端可视化(globalping MTR), 不依赖引擎/meta。直接深开 /trace 时
    // 也立刻**同步**切到 trace 视图渲染, 否则首帧会落在「路由分析·正在加载查询引擎」boot 闪屏;
    // 引擎随后在下面空闲时静默后台预载(与首页一致)。
    const traceLanding = !whoisLanding && features.routeTrace && /^\/trace(\/|$)/.test(location.pathname)
    if (traceLanding) { S.view = 'trace'; S.loading = false; applyRoute({ initial: true }) }

    // 404 同理: 未定义的 URL 不依赖引擎/meta, 立刻同步渲染 NotFound, 不闪「路由分析·加载引擎」boot。
    const notFoundLanding = !whoisLanding && !traceLanding && isNotFoundPath()
    if (notFoundLanding) { S.loading = false; applyRoute({ initial: true }) }

    // 选定数据宿主: CN 用户(/cdn-cgi/trace loc=CN)且 VPS 健康 -> cn.peer.as, 否则同源 CF。
    // wasm 同源打包(CN 完整自托管); CF 节点超 25MiB 的 wasm 回退外部 CDN(见 db.js wasmSrcs)。
    // edge 存入 store, 供空状态显示「正在使用中国优化服务器」赞助提示。
    S.edge = await configure()

    // 路由监听 + Esc 尽早注册(独立于数据/引擎): 直开 /whois 也要能 PJAX 前进后退、Esc。
    window.addEventListener('popstate', () => applyRoute())
    window.addEventListener('keydown', e => { if (e.key === 'Escape') { S.about = false; S.changelog = false; S.pathHelp = false; S.menu = false; S.side = false; S.exportOpen = false; if (S.detailKind) hardCloseDetail() } })

    // meta.json 必须拿最新的(它带 version, 决定其它文件的 ?v=); no-cache 强制条件请求(未变则 304, 变了取新)。
    // getData 带回退: 选定宿主(可能是 CN VPS)失败时整体回退 CF。失败置 fatal(路由视图显示), 但不 return ——
    // WHOIS 视图不依赖 meta, 仍要能用; 故继续 applyRoute。
    // ensureMeta(): 与按需查询(SelfProbe 触发的 ensureEngine)共用同一 promise, 去重且消除「引擎先于 meta 就绪」竞态。
    try { await ensureMeta() }
    catch (e) { S.fatal = `meta.json: ${e.message}（先跑 ipc export-parquet）` }

    const cc0 = qp.get('cc'); if (cc0) S.filters.cc = ccLabel(cc0.toUpperCase())
    const city0 = qp.get('city'); if (city0) S.filters.city = city0

    // 解析当前 URL 渲染。WHOIS 落地页上面已同步解析完, 这里只处理路由分析分支(先 await ensureEngine():
    // 34MB DuckDB + 全量 ASN 名按需懒加载, 期间保持 loading 转圈)。前进/后退经 popstate 重渲染(PJAX)。
    if (!whoisLanding && !traceLanding && !notFoundLanding) applyRoute({ initial: true })

    // 落地在 WHOIS 首页时, 引擎本不会加载。空闲时**静默后台预载**(ensureEngine 幂等), 这样之后切到「路由分析」无感秒开;
    // 不阻塞首屏/RDAP, 也不影响 WHOIS 视图(其忽略 S.loading)。meta 缺失则跳过(路由本就不可用)。
    if ((S.view === 'whois' || S.view === 'trace') && S.meta) {
      const idle = window.requestIdleCallback || (cb => setTimeout(cb, 1500))
      idle(() => ensureEngine().catch(() => {}))
    }
  })
</script>

{#if S.notFound}
  <!-- 404: 完全独立的整屏页面, 不挂任何 app 外壳(无 Sidebar / Topbar / MobileBar) -->
  <NotFound target={S.notFound.target} />
{:else}
<div class="app">
  <Sidebar />
  <!-- 左上角开合按钮(桌面专用, 首页 + 路由分析两页都有); 抽屉展开时由侧栏自带的关闭钮/遮罩收起 -->
  {#if !S.side}
    <button class="sidetoggle" onclick={() => (S.side = true)} aria-label={t('menu')} aria-expanded={S.side}>
      <Fa icon={iMenu} />
    </button>
  {/if}
  {#if S.view === 'whois'}
    <!-- WHOIS·RDAP 独立视图(自带 MobileBar + 全宽 record, 无 Topbar 过滤器 / 无右侧详情面板) -->
    <WhoisView />
  {:else if S.view === 'trace'}
    <!-- 全球路由跟踪(globalping MTR + 自有 IP 库, 3D 地球; 自带 MobileBar) -->
    <RouteTraceView />
    <!-- 点击 trace 面板里的 IP/ASN -> 浮窗复用 InsightDrawer 展示 insight -->
    <InsightDrawer floating onclose={clearDetail} />
  {:else}
    <main class="main">
      <MobileBar />
      <Topbar />
      <div class="content">
        {#if S.fatal}
          <div class="fatal"><b>×</b> {S.fatal}</div>
        {:else if S.loading}
          <div class="boot"><Fa icon={iSpinner} spin /> <span>{S.msg || t('loading')}</span></div>
        {:else if S.mode === 'dns'}
          <DnsView />
        {:else if S.mode === 'asset'}
          <AsSetView />
        {:else}
          <Results />
        {/if}
      </div>
    </main>
    <InsightDrawer />
  {/if}
</div>
{/if}
<AboutModal />
<ChangelogModal />
<PathHelpModal />
<ExportModal />

<style>
  .app { display: flex; min-height: 100vh; min-height: 100dvh; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  /* 左上角开合按钮: 固定悬浮, 用主题 token 与页面同色(明暗自适应)。抽屉收起时常驻。 */
  .sidetoggle {
    position: fixed; top: 12px; left: 12px; z-index: 31;
    display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 9px;
    color: var(--muted); cursor: pointer; box-shadow: 0 6px 18px -12px rgba(0,0,0,.45);
    -webkit-tap-highlight-color: transparent; outline: none; appearance: none;
    transition: border-color .14s, color .14s, background .14s;
  }
  .sidetoggle:hover { color: var(--fg); border-color: var(--accent); background: var(--alt); }
  .sidetoggle:active { background: var(--alt); }            /* 明确 active 态, 避免 UA 默认白底闪烁 */
  .sidetoggle:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .sidetoggle :global(svg) { width: 15px; }
  /* flex 列: 让空状态的赞助条用 margin-top:auto 贴到底部; 底 padding 14px 与侧栏 .foot 对齐 */
  .content { flex: 1; padding: 6px 18px 14px; display: flex; flex-direction: column; }
  .boot { padding: 70px 20px; text-align: center; color: var(--muted); font: 13px var(--mono); display: flex; align-items: center; justify-content: center; gap: 10px; }
  .boot :global(svg) { color: var(--accent); }
  .fatal { padding: 40px 20px; color: #e06c6c; font-size: 13px; }
  .fatal b { color: #e06c6c; }
  @media (max-width: 820px) {
    .app { flex-direction: column; }
    /* 底部留出 iOS/安卓浏览器底栏 + 刘海安全区, 左右留出横屏刘海 → 内容不被系统 UI 遮住 */
    .content {
      padding: 4px calc(12px + env(safe-area-inset-right, 0px)) calc(24px + env(safe-area-inset-bottom, 0px)) calc(12px + env(safe-area-inset-left, 0px));
    }
    .sidetoggle { display: none; }   /* 移动端用 MobileBar 的菜单钮 */
  }
</style>
