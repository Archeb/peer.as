<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { closeInsight, hardCloseDetail, navBack, navForward, navCanBack, navCanFwd } from '../lib/queries.js'
  import { iClose, iArrowL, iArrowR } from '../lib/icons.js'

  // floating: 浮窗模式(trace 视图复用本组件展示 insight) —— 不再是右侧贴边面板, 而是可拖动/缩放的浮岛。
  // onclose: 浮窗关闭回调(由调用方清详情态)。docked(默认)模式一切照旧, 路由分析视图不受影响。
  // 正文渲染统一由 DetailBody 承担(与 WhoisView 首页内联共用)。
  import DetailNav from './DetailNav.svelte'
  import DetailBody from './DetailBody.svelte'

  let { floating = false, onclose = null } = $props()
  let canBack = $derived(navCanBack())
  let canFwd = $derived(navCanFwd())

  const isMobile = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 820px)').matches

  // 关闭: 移动端直接全关; 桌面端沿用智能关闭(看 prefix 且主体是 ASN 时先返回 ASN)。
  function onClose() {
    if (isMobile()) hardCloseDetail()
    else closeInsight()
  }

  // ── 浮窗(floating)拖动 + 缩放 ──
  let fEl = $state(null)
  let fwin = $state({ x: 40, y: 64, w: 460, h: 600 })
  let fges = $state(null)
  let fInit = false
  const clampN = (v, a, b) => v < a ? a : v > b ? b : v
  $effect(() => {                                  // 首次打开时把浮窗放到右上(panel 在左, 不挡)
    if (floating && S.detailKind && !fInit) {
      fInit = true
      const w = Math.min(460, window.innerWidth - 40), h = Math.min(window.innerHeight - 96, 720)
      fwin = { x: Math.max(20, window.innerWidth - w - 36), y: 64, w, h }
    }
  })
  function startFMove(e) {
    if (isMobile()) return                          // 移动端: 浮窗锁全屏, 不可拖动
    if (e.target.closest && e.target.closest('button, a, input, .fgrip')) return
    fges = { mode: 'move', sx: e.clientX, sy: e.clientY, ox: fwin.x, oy: fwin.y }
    window.addEventListener('pointermove', onFges); window.addEventListener('pointerup', endFges); e.preventDefault()
  }
  function startFResize(e) {
    if (isMobile()) return                          // 移动端: 全屏, 不提供缩放
    const r = fEl.getBoundingClientRect(); fwin.w = r.width; fwin.h = r.height
    fges = { mode: 'resize', sx: e.clientX, sy: e.clientY, ow: r.width, oh: r.height }
    window.addEventListener('pointermove', onFges); window.addEventListener('pointerup', endFges); e.preventDefault(); e.stopPropagation()
  }
  function onFges(e) {
    if (!fges) return
    const dx = e.clientX - fges.sx, dy = e.clientY - fges.sy
    if (fges.mode === 'move') { fwin.x = clampN(fges.ox + dx, 6, window.innerWidth - 90); fwin.y = clampN(fges.oy + dy, 6, window.innerHeight - 46) }
    else { fwin.w = clampN(fges.ow + dx, 320, Math.min(720, window.innerWidth - fwin.x - 8)); fwin.h = clampN(fges.oh + dy, 240, window.innerHeight - fwin.y - 8) }
  }
  function endFges() { fges = null; window.removeEventListener('pointermove', onFges); window.removeEventListener('pointerup', endFges) }

  // 拖拽调宽(docked 模式右侧分隔条)
  let dragging = false
  function startDrag(e) {
    dragging = true; document.body.style.userSelect = 'none'; e.preventDefault()
    const move = ev => {
      if (!dragging) return
      S.detailW = Math.min(72, Math.max(38, (window.innerWidth - ev.clientX) / window.innerWidth * 100))
      localStorage.setItem('ipc-detail-w', S.detailW.toFixed(1))
    }
    const up = () => { dragging = false; document.body.style.userSelect = ''; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
</script>

{#if S.detailKind}
  {#if floating}
    <!-- 浮窗模式(trace 视图): 像主面板一样浮起 + 顶部 draghandle + 右下角缩放 -->
    <div class="floatwin" bind:this={fEl} class:dragging={!!fges}
         style:left="{fwin.x}px" style:top="{fwin.y}px" style:width="{fwin.w}px" style:height="{fwin.h}px">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="fbar" onpointerdown={startFMove}>
        <!-- 左上角: 后退 / 前进 导航(stopPropagation 不触发拖动) -->
        <div class="fnav" onpointerdown={(e) => e.stopPropagation()}>
          <button class="fnavb" disabled={!canBack} onclick={navBack} title={t('nav_back')} aria-label={t('nav_back')}><Fa icon={iArrowL} /></button>
          <button class="fnavb" disabled={!canFwd} onclick={navForward} title={t('nav_fwd')} aria-label={t('nav_fwd')}><Fa icon={iArrowR} /></button>
        </div>
        <span class="fhandle" aria-hidden="true"><i></i><i></i></span>
        <button class="fclose" onpointerdown={(e) => e.stopPropagation()} onclick={() => onclose && onclose()} title={t('detail_close')} aria-label={t('detail_close')}><Fa icon={iClose} /></button>
      </div>
      <div class="dbody floatbody"><DetailBody /></div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="fgrip" onpointerdown={startFResize} aria-hidden="true"></div>
    </div>
  {:else}
    <aside class="detail open" style:flex-basis="{S.detailW}%" style:width="{S.detailW}%">
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="dragbar" onmousedown={startDrag} role="separator" aria-orientation="vertical"></div>
      <div class="dbody">
        <!-- 右上浮岛: 分区导航(左) + 后退/前进/关闭(右), 随滚动悬浮; 标题在其左侧不被遮挡 -->
        <div class="dfloat">
          <DetailNav />
          <div class="island">
            <button class="navb" disabled={!canBack} onclick={navBack} title={t('nav_back')} aria-label={t('nav_back')}><Fa icon={iArrowL} /></button>
            <button class="navb" disabled={!canFwd} onclick={navForward} title={t('nav_fwd')} aria-label={t('nav_fwd')}><Fa icon={iArrowR} /></button>
            <button class="navb close" onclick={onClose} title={t('detail_close')} aria-label={t('detail_close')}><Fa icon={iClose} /></button>
          </div>
        </div>
        <DetailBody />
      </div>
    </aside>
  {/if}
{/if}

<style>
  /* ── 浮窗模式(trace 视图复用): 可拖动/缩放的浮岛, 顶部 draghandle ── */
  .floatwin {
    position: fixed; z-index: 50; display: flex; flex-direction: column; overflow: hidden;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 40px 90px -40px rgba(0,0,0,.75), inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
    backdrop-filter: blur(18px) saturate(1.2); -webkit-backdrop-filter: blur(18px) saturate(1.2);
  }
  .floatwin.dragging { user-select: none; }
  .fbar { position: relative; flex: 0 0 auto; height: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; cursor: move; touch-action: none; border-bottom: 1px solid var(--line2); }
  .fhandle { display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .fhandle i { width: 30px; height: 2px; border-radius: 2px; background: color-mix(in srgb, var(--muted) 42%, transparent); transition: background .15s; }
  .floatwin:hover .fhandle i { background: color-mix(in srgb, var(--muted) 65%, transparent); }
  .fnav { position: absolute; left: 6px; top: 50%; transform: translateY(-50%); display: inline-flex; align-items: center; gap: 2px; }
  .fnavb { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 7px; background: transparent; border: 0; color: var(--muted); cursor: pointer; transition: all .12s; }
  .fnavb:hover:not(:disabled) { color: var(--fg); background: var(--alt); }
  .fnavb:disabled { opacity: .3; cursor: default; }
  .fnavb :global(svg) { width: 11px; }
  .fclose { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 7px; background: transparent; border: 0; color: var(--muted); cursor: pointer; transition: all .12s; }
  .fclose:hover { color: #ef4444; background: var(--alt); }
  .fclose :global(svg) { width: 11px; }
  .dbody.floatbody { flex: 1; min-height: 0; padding: 8px 20px 28px; }
  .fgrip { position: absolute; right: 0; bottom: 0; width: 26px; height: 26px; z-index: 3; cursor: nwse-resize; touch-action: none; }
  .fgrip::after { content: ''; position: absolute; right: 7px; bottom: 7px; width: 12px; height: 12px; border-right: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); border-bottom: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 0 0 6px 0; opacity: .5; transition: opacity .14s; }
  .fgrip:hover::after { opacity: 1; }

  .detail { flex: 0 0 42%; display: flex; background: var(--inbg); border-left: 1px solid var(--line); position: sticky; top: 0; height: 100vh; overflow: hidden; }
  .dragbar { flex: 0 0 6px; cursor: col-resize; background: var(--line); transition: background .12s; }
  .dragbar:hover, .dragbar:active { background: var(--accent); }
  .dbody { flex: 1; min-width: 0; overflow: auto; padding: 14px 22px 40px; position: relative; }
  /* 右上浮岛: 随滚动悬浮(sticky)、右浮(float)让标题在其左侧环绕不被遮挡 */
  .dfloat { position: sticky; top: 6px; float: right; z-index: 6; display: inline-flex; align-items: center; gap: 8px; margin: 0 0 4px 12px; }
  .island {
    display: inline-flex; align-items: center; gap: 2px; padding: 3px;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    border: 1px solid var(--line2); border-radius: 9px;
    backdrop-filter: blur(6px); box-shadow: 0 2px 10px rgba(0, 0, 0, .12);
  }
  .navb { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; background: transparent; border: 0; border-radius: 6px; color: var(--muted); cursor: pointer; font-size: 12px; transition: all .12s; }
  .navb:hover:not(:disabled) { color: var(--fg); background: var(--line2); }
  .navb:disabled { opacity: .3; cursor: default; }
  .navb.close:hover { color: #ef4444; }

  @media (max-width: 820px) {
    /* 浮窗模式: 自动全屏, 不可拖动/缩放 */
    .floatwin { inset: 0 !important; width: auto !important; height: auto !important; border: 0; border-radius: 0; }
    .fbar { cursor: default; }
    .fgrip { display: none; }
    .dbody.floatbody { padding: 8px 18px 84px; }
    .detail { position: fixed; inset: 0; width: 100% !important; flex-basis: 100% !important; z-index: 40; }
    .dragbar { display: none; }
    /* 底部留白, 防止被底部居中的分区导航遮挡 */
    .dbody { padding-bottom: 76px; }
  }
</style>
