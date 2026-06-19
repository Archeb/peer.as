<script>
  // 404 —— 用本站「网络运营控制台」语汇把「页面不存在」表达成「目标无路由」:
  // 一段真实的三跳 traceroute(你的 IP → 边缘节点 → 本站),最后一跳为空 = 无路由 · 404。
  // SPA 端(路由无法解析为任何已知对象/视图时)渲染; SSR 端有对应静态版(seo/NotFoundSeo.svelte)。
  import Fa from 'svelte-fa'
  import { onMount } from 'svelte'
  import { t } from '../lib/i18n.js'
  import { goHome } from '../lib/queries.js'
  import { fetchTrace } from '../lib/geo.js'
  import { iCompass } from '../lib/icons.js'

  let { target = '' } = $props()
  // 没传 target 时取当前路径(被请求、却无路由的那一跳)。
  let shown = $derived(target || (typeof location !== 'undefined' ? decodeURIComponent(location.pathname) : ''))
  const host = typeof location !== 'undefined' ? location.host : 'peer.as'

  // 前两跳来自同源 /cdn-cgi/trace: 你的 IP + 边缘节点(CF colo / CN 镜像标记)。
  let ip = $state('')
  let edge = $state('')
  onMount(async () => {
    const tr = await fetchTrace()
    if (tr) {
      ip = tr.ip || ''
      edge = tr.colo || (tr.edge ? tr.edge.toUpperCase() : '') || tr.cc || ''
    }
  })

  function back() {
    if (typeof history !== 'undefined' && history.length > 1) history.back()
    else goHome()
  }
</script>

<div class="nf">
  <!-- 信号物: 一次真实但走到尽头的 traceroute。前三跳抵达本站, 第四跳(被请求的资源)无路由 -> 404。 -->
  <div class="card" role="img" aria-label={t('nf_title')}>
    <div class="bar">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="cmd">traceroute {shown}</span>
    </div>
    <ol class="hops">
      <li class="ok"><span class="h">01</span><span class="n">{ip || '· · ·'}</span><span class="r">{t('nf_you')}</span></li>
      <li class="ok"><span class="h">02</span><span class="n">{edge || '· · ·'}</span><span class="r">{t('nf_edge')}</span></li>
      <li class="ok"><span class="h">03</span><span class="n">{host}</span><span class="r">{t('nf_reached')}</span></li>
      <li class="dead"><span class="h">04</span><span class="n">* * *</span><span class="r">{t('nf_noresp')}</span></li>
    </ol>
    <div class="fail"><span class="x">✗</span> no route to host <b class="code">404</b></div>
  </div>

  <h1>{t('nf_title')}</h1>
  <p class="lede">{t('nf_desc')}</p>
  {#if shown}
    <p class="target"><span>{t('nf_target')}</span><code>{shown}</code></p>
  {/if}

  <div class="actions">
    <button class="btn primary" onclick={goHome}><Fa icon={iCompass} /> {t('home')}</button>
    <button class="btn ghost" onclick={back}>{t('nf_back')}</button>
  </div>
</div>

<style>
  .nf {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px; padding: 40px 20px 64px; text-align: center; min-height: 58vh;
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
  .hops { list-style: none; margin: 0; padding: 8px 0; }
  .hops li { display: flex; align-items: center; gap: 12px; padding: 4px 15px; font-size: 12.5px; }
  .hops .h { color: var(--muted); opacity: .55; width: 16px; flex: 0 0 auto; }
  .hops .n { flex: 1; min-width: 0; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hops .r { color: var(--accent); font-size: 11px; flex: 0 0 auto; }
  /* 末跳: 被请求资源无响应(* * *), 转中性/红, 不算抵达 */
  .hops .dead .n { color: var(--muted); letter-spacing: 2px; }
  .hops .dead .r { color: var(--nf-bad); }
  .fail {
    display: flex; align-items: center; gap: 10px; padding: 11px 15px;
    border-top: 1px dashed var(--line); background: var(--nf-bad-bg); color: var(--nf-bad); font-size: 13px;
  }
  .fail .x { font-weight: 700; }
  .fail .code { margin-left: auto; font-size: 15px; font-weight: 700; letter-spacing: .5px; }

  h1 { margin: 8px 0 0; font: 600 19px/1.3 var(--sans); color: var(--fg); }
  .lede { margin: 0; max-width: 388px; color: var(--muted); font: 13px/1.65 var(--sans); }
  .target { display: inline-flex; align-items: center; gap: 8px; margin: 2px 0 0; font-size: 12px; color: var(--muted); }
  .target code {
    font-family: var(--mono); color: var(--fg); background: var(--alt); border: 1px solid var(--line);
    border-radius: 5px; padding: 2px 8px; max-width: min(78vw, 320px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

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

  /* 入场: 跳逐行落下, 失败行最后浮现。尊重减弱动效。 */
  @media (prefers-reduced-motion: no-preference) {
    .hops li, .fail { animation: nf-in .42s ease both; }
    .hops li:nth-child(1) { animation-delay: .04s; }
    .hops li:nth-child(2) { animation-delay: .16s; }
    .hops li:nth-child(3) { animation-delay: .28s; }
    .hops li:nth-child(4) { animation-delay: .42s; }
    .fail { animation-delay: .58s; }
  }
  @keyframes nf-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
</style>
