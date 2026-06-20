<script>
  // 404 —— 用本站「网络运营控制台」语汇把「页面不存在」表达成「目标无路由」:
  // 一段真实的 4 跳 traceroute(你的 IP → 边缘节点 → 本站 → * * * 无响应) = 无路由 · 404。
  // 先探测同源 /cdn-cgi/trace(最多等 0.5s), 就绪后逐行落下(JS step 计数 + class 过渡, 可靠)。
  // 行始终在 DOM 里(opacity 控制显隐)→ 卡片高度恒定, spinner 覆盖在其上, 切换不跳高。
  // SPA 端渲染; SSR 端有对应静态版(seo/NotFoundSeo.svelte)。
  import Fa from 'svelte-fa'
  import { onMount } from 'svelte'
  import { t } from '../lib/i18n.js'
  import { goHome } from '../lib/queries.js'
  import { fetchTrace } from '../lib/geo.js'
  import { iCompass, iSpinner } from '../lib/icons.js'

  let { target = '' } = $props()
  // 没传 target 时取当前路径(被请求、却无路由的那一跳)。
  let shown = $derived(target || (typeof location !== 'undefined' ? decodeURIComponent(location.pathname) : ''))
  const host = typeof location !== 'undefined' ? location.host : 'peer.as'

  let ip = $state('')
  let edge = $state('')
  let ready = $state(false)   // /cdn-cgi/trace 解析完(或 0.5s 超时)→ 撤 spinner, 开始逐行落下
  let step = $state(0)        // 已落下的行数: 1..4 = 四跳, 5 = 失败行

  // 第二跳标注: edge=cn 标记 = 我们自建的 DMIT(LAX); 否则真 Cloudflare, 用 colo(如 NRT)。
  function labelEdge(tr) {
    if (tr.edge === 'cn') return 'DMIT.LAX'
    if (tr.colo) return 'CLOUDFLARE.' + tr.colo
    if (tr.edge) return tr.edge.toUpperCase()
    return tr.cc || ''
  }
  function apply(tr) { if (tr) { ip = tr.ip || ''; edge = labelEdge(tr) } }

  onMount(async () => {
    const p = fetchTrace()
    // 等 trace 出结果, 但最多等 0.5s —— 到点就先开动画(占位), 真值后到再补。
    const tr = await Promise.race([p, new Promise(r => setTimeout(() => r('timeout'), 500))])
    if (tr && tr !== 'timeout') apply(tr); else p.then(apply)
    ready = true

    // 逐行落下(每行 130ms): 始终按节奏揭示, 减弱动效时退化为纯淡入(见 CSS), 不取消顺序。
    const tick = () => { step += 1; if (step < 5) setTimeout(tick, 130) }
    setTimeout(tick, 60)
  })

  function back() {
    if (typeof history !== 'undefined' && history.length > 1) history.back()
    else goHome()
  }
</script>

<div class="nf">
  <!-- 信号物: 一次真实但走到尽头的 traceroute。前三跳抵达本站, 第四跳(被请求的资源)无响应 -> 404。 -->
  <div class="card" role="img" aria-label={t('nf_title')}>
    <div class="bar">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="cmd">traceroute {shown}</span>
    </div>
    <!-- body 高度恒定: 四跳 + 失败行始终在 DOM(靠 opacity 显隐), spinner 覆盖其上 -->
    <div class="body">
      <ol class="hops">
        <li class="row ok" class:show={step > 0}><span class="h">01</span><span class="n">{ip || '· · ·'}</span><span class="r">{t('nf_you')}</span></li>
        <li class="row ok" class:show={step > 1}><span class="h">02</span><span class="n">{edge || '· · ·'}</span><span class="r">{t('nf_edge')}</span></li>
        <li class="row ok" class:show={step > 2}><span class="h">03</span><span class="n">{host}</span><span class="r">{t('nf_reached')}</span></li>
        <li class="row dead" class:show={step > 3}><span class="h">04</span><span class="n">* * *</span><span class="r">{t('nf_noresp')}</span></li>
      </ol>
      <div class="fail row" class:show={step >= 5}><span class="x">✗</span> page not found <b class="code">404</b></div>
      {#if !ready}
        <div class="tracing"><Fa icon={iSpinner} spin /> <span>traceroute…</span></div>
      {/if}
    </div>
  </div>

  <div class="actions">
    <button class="btn primary" onclick={goHome}><Fa icon={iCompass} /> {t('home')}</button>
    <button class="btn ghost" onclick={back}>{t('nf_back')}</button>
  </div>
</div>

<style>
  /* 整屏独立页(不挂 app 外壳): 自带背景, 内容垂直居中 */
  .nf {
    min-height: 100vh; min-height: 100dvh;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px; padding: 40px 20px; text-align: center; background: var(--bg); color: var(--fg);
    /* 这一页唯一的越界色: 失败跳的红(明暗两套, 仅本组件作用域)。 */
    --nf-bad: #cf5246; --nf-bad-bg: rgba(207, 82, 76, .07);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme])) .nf { --nf-bad: #f08a80; --nf-bad-bg: rgba(240, 138, 128, .10); }
  }
  :global(:root[data-theme=dark]) .nf { --nf-bad: #f08a80; --nf-bad-bg: rgba(240, 138, 128, .10); }

  .card {
    width: 100%; max-width: 440px; text-align: left; font-family: var(--mono);
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
    box-shadow: 0 22px 48px -32px rgba(0, 0, 0, .55);
  }
  .bar { display: flex; align-items: center; gap: 6px; padding: 9px 13px; background: var(--alt); border-bottom: 1px solid var(--line); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); }
  .cmd { margin-left: 8px; font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* 恒定高度容器: spinner 绝对定位覆盖在(始终占位的)四跳+失败行之上 */
  .body { position: relative; }
  .tracing {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px;
    background: var(--panel); color: var(--muted); font-size: 12.5px;
  }
  .tracing :global(svg) { color: var(--accent); width: 13px; }

  .hops { list-style: none; margin: 0; padding: 8px 0; }
  .row { display: flex; align-items: center; gap: 12px; padding: 4px 15px; font-size: 12.5px; }
  .hops .h { color: var(--muted); opacity: .55; width: 16px; flex: 0 0 auto; }
  .hops .n { flex: 1; min-width: 0; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hops .r { color: var(--accent); font-size: 11px; flex: 0 0 auto; }
  /* 末跳: 被请求资源无响应(* * *), 转中性/红, 不算抵达 */
  .hops .dead .n { color: var(--muted); letter-spacing: 2px; }
  .hops .dead .r { color: var(--nf-bad); }
  .fail {
    padding: 11px 15px; border-top: 1px dashed var(--line); background: var(--nf-bad-bg);
    color: var(--nf-bad); font-size: 13px;
  }
  .fail .x { font-weight: 700; }
  .fail .code { margin-left: auto; font-size: 15px; font-weight: 700; letter-spacing: .5px; }

  /* 逐行落下: 行始终在 DOM(高度恒定), .show 落上时跑一次 keyframe。
     用 animation 而非 transition —— class 一加上即可靠地播放一次, 不受首帧/批量时机影响。 */
  .row { opacity: 0; }
  .row.show { animation: nf-drop .34s ease both; }
  @keyframes nf-drop { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  /* 减弱动效: 仍按顺序揭示, 但只淡入、不位移; 卡片不浮入 */
  @media (prefers-reduced-motion: reduce) {
    .row.show { animation: nf-fade .34s ease both; }
    .card { animation: none; }
  }
  @keyframes nf-fade { from { opacity: 0; } to { opacity: 1; } }

  .actions { display: flex; gap: 10px; margin-top: 8px; flex-wrap: wrap; justify-content: center; }
  .btn {
    display: inline-flex; align-items: center; gap: 7px; padding: 8px 17px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--panel); color: var(--fg); font: 600 12.5px var(--sans);
    cursor: pointer; transition: border-color .14s, background .14s, color .14s; -webkit-tap-highlight-color: transparent;
  }
  .btn :global(svg) { width: 13px; }
  .btn.ghost { background: transparent; color: var(--muted); }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .btn.primary:hover { background: var(--accent-h); border-color: var(--accent-h); color: var(--accent-fg); }
  .btn:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }

  /* 卡片 0.3s 浮入 */
  .card { animation: nf-card .3s ease both; }
  @keyframes nf-card { from { opacity: 0; transform: translateY(6px) scale(.99); } to { opacity: 1; transform: none; } }
</style>
