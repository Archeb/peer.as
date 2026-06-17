<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { compilePathQuery, asnName, parseBest } from '../lib/bgp.js'
  import { holderOrg } from '../lib/rdap.js'
  import { showInsight, showAsn, closeInsight, hardCloseDetail, navBack, navForward, navCanBack, navCanFwd } from '../lib/queries.js'
  import { iClose, iStar, iUp, iDown, iSpinner, iArrowL, iArrowR } from '../lib/icons.js'
  import PathGraph from './PathGraph.svelte'

  // floating: 浮窗模式(trace 视图复用本组件展示 insight) —— 不再是右侧贴边面板, 而是可拖动/缩放的浮岛。
  // onclose: 浮窗关闭回调(由调用方清详情态)。docked(默认)模式一切照旧, 路由分析视图不受影响。
  import AsPath from './AsPath.svelte'
  import Whois from './Whois.svelte'
  import AsnDetail from './AsnDetail.svelte'
  import DomainDetail from './DomainDetail.svelte'
  import DetailNav from './DetailNav.svelte'
  import OriginStatus from './OriginStatus.svelte'

  let { floating = false, onclose = null } = $props()
  let ins = $derived(S.insight)
  // IRR 来源库权威性(RIR 直营=权威绿; 第三方=中性灰)。
  let irrAuth = $derived(new Set(S.meta?.irr?.authoritative || []))
  const isAuth = s => irrAuth.has(String(s).toUpperCase())
  let pq = $derived(compilePathQuery(S.filters.path))
  let canBack = $derived(navCanBack())
  let canFwd = $derived(navCanFwd())

  // 去重路径默认只显示 5 行, 可展开。换前缀时重置。
  const PATHS_HEAD = 5
  let pathsOpen = $state(false)
  $effect(() => { ins?.prefix; pathsOpen = false })
  let shownPaths = $derived(ins?.paths ? (pathsOpen ? ins.paths : ins.paths.slice(0, PATHS_HEAD)) : [])

  // MOAS origin 列表默认只显示 9 个, 可折叠展开。换前缀时重置。
  const ORIGINS_HEAD = 9
  let originsOpen = $state(false)
  $effect(() => { ins?.prefix; originsOpen = false })
  let shownOrigins = $derived(ins?.origins ? (originsOpen ? ins.origins : ins.origins.slice(0, ORIGINS_HEAD)) : [])

  // IP 所属组织(RDAP inetnum 持有者): 与 origin ASN(运营商)不同, 实时查、失败静默。换前缀重置。
  let holder = $state('')
  $effect(() => {
    const px = ins?.prefix
    holder = ''
    if (px) holderOrg(px).then(h => { if (S.insight?.prefix === px && h) holder = h })
  })

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

{#snippet body()}
      {#if S.detailKind === 'asn'}
        <AsnDetail />
      {:else if S.detailKind === 'domain'}
        <DomainDetail />
      {:else if ins?.loading}
        <div class="dload"><Fa icon={iSpinner} spin /> {t('querying')}</div>
      {:else if ins?.error}
        <div class="dload err">{ins.error}</div>
      {:else if ins}
        <h2>{ins.prefix} <span class="loc">· {ins.loc}</span></h2>
        <div class="pill">
          origin asn <button class="originlink" onclick={() => showAsn(ins.origin_asn)} disabled={!ins.origin_asn}><b>{ins.origin_asn || ''}</b>{ins.origin_name ? ` (${ins.origin_name})` : ''}</button><OriginStatus rpki={ins.rpki} irr={ins.irr} unknown />
          {#if ins.n_origins > 1}<span class="badge b-moas moastag" title={t('moas_note')}>{t('moas')} · {ins.n_origins}</span>{/if}
          · {ins.paths.length} {t('distinct')} / {ins.n_paths || 0} {t('peers')}
          {#if S.meta?.dfz_ref}
            · <span class="badge {ins.lowvis ? 'b-warn' : 'b-ok'}">{ins.n_paths || 0}/{S.meta.dfz_ref} {ins.lowvis ? t('lowvis') : 'DFZ'}</span>
          {/if}
        </div>
        {#if holder}
          <div class="pill holder"><span class="hk">{t('ip_holder')}</span> {holder}</div>
        {/if}

        {#if ins.n_origins > 1 && ins.origins?.length}
          <div class="moasbox" data-sec="moas">
            <div class="moashdr"><span class="badge b-moas">{t('moas')} · {ins.n_origins}</span> {t('moas_origins')}</div>
            <div class="moaslist">
              {#each shownOrigins as o}
                <button class="moasitem" onclick={() => showAsn(o.asn)}>
                  <b>AS{o.asn}</b>{#if asnName(o.asn)}<span class="onm">{asnName(o.asn)}</span>{/if}{#if o.peers}<span class="opeers">{o.peers} {t('peers')}</span>{/if}<OriginStatus rpki={o.rpki} irr={o.irr} />
                </button>
              {/each}
              {#if originsOpen && ins.origins.length < ins.n_origins}<span class="omore">+{ins.n_origins - ins.origins.length}…</span>{/if}
            </div>
            {#if ins.origins.length > ORIGINS_HEAD}
              <button class="expandrow moasexp" onclick={() => (originsOpen = !originsOpen)}>
                {originsOpen ? t('collapse') : t('show_all').replace('{n}', ins.origins.length)}
              </button>
            {/if}
          </div>
        {/if}

        <h3 class="dsec" data-sec="graph">{t('graph_title')}</h3>
        <PathGraph rec={{ paths: ins.paths, origin_asn: ins.origin_asn, origins: ins.origins?.map(o => o.asn), prefix: ins.prefix }} />

        <div class="rel" data-sec="rel">
          <div class="relbox">
            <b><Fa icon={iUp} /> {t('sup')}</b>
            {#if ins.sup.length}
              {#each ins.sup as r, i}{#if i}<span class="sub-sep">⊂</span>{/if}<button class="rellink" onclick={() => showInsight(r.pid, r.prefix)}>{r.prefix}</button>{/each}
            {:else}<span class="muted">{t('none_in_db')}</span>{/if}
          </div>
          <div class="relbox">
            <b><Fa icon={iDown} /> {t('sub')}</b>
            {#if ins.sub.length}
              <div class="rels">{#each ins.sub as r}<button class="rellink" onclick={() => showInsight(r.pid, r.prefix)}>{r.prefix}</button>{/each}</div>
            {:else}<span class="muted">{t('none_in_db')}</span>{/if}
          </div>
        </div>

        <h3 class="dsec" data-sec="paths">{t('paths_all')}</h3>
        <table class="paths">
          <thead><tr><th>#peer</th><th>len</th><th>AS_PATH</th></tr></thead>
          <tbody>
            {#each shownPaths as g}
              <tr class:hit={pq.hasInclude && pq.test(g.asns)}>
                <td class="num">{g.peers}</td>
                <td class="num">{g.asns.length}</td>
                <td>{#if g.is_best}<span class="star"><Fa icon={iStar} /></span> {/if}<AsPath asns={g.asnsRaw || g.asns} nav arrow /></td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if ins.paths.length > PATHS_HEAD}
          <button class="expandrow" onclick={() => (pathsOpen = !pathsOpen)}>
            {pathsOpen ? t('collapse') : t('show_all').replace('{n}', ins.paths.length)}
          </button>
        {/if}

        {#if S.meta?.has_irr}
          <h3 class="dsec" data-sec="irr">{t('sec_irr')}</h3>
          {#if ins.irrObjs?.length}
            <div class="irrlist">
              {#each ins.irrObjs as o}
                <div class="irritem">
                  <button class="originlink" onclick={() => showAsn(o.origin)}><b>AS{o.origin}</b></button>{#if asnName(o.origin)}<span class="irrnm">{asnName(o.origin)}</span>{/if}{#if o.origin === ins.origin_asn}<span class="badge b-ok irrcur" title={t('irr_observed')}>●</span>{/if}
                  <span class="irrsrcs">{#each o.sources as s}<span class="badge {isAuth(s) ? 'b-ok' : 'b-mute'} srcb" title={isAuth(s) ? t('irr_auth') : t('irr_thirdparty')}>{s}</span>{/each}</span>
                </div>
              {/each}
            </div>
          {:else}
            <div class="muted irrnone">{t('irr_none')}</div>
          {/if}
        {/if}
        {#if S.meta?.rpki?.as_of || S.meta?.irr?.as_of}
          <div class="provenance">
            {#if S.meta?.rpki?.as_of}<span>{t('rpki_badge')} {t('data_asof')} {S.meta.rpki.as_of}</span>{/if}
            {#if S.meta?.irr?.as_of}<span>IRR {t('data_asof')} {S.meta.irr.as_of}</span>{/if}
          </div>
        {/if}

        <Whois kind="ip" rkey={ins.prefix} />
      {/if}
{/snippet}

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
      <div class="dbody floatbody">{@render body()}</div>
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
        {@render body()}
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
  .expandrow {
    width: 100%; margin-top: 2px; padding: 6px; background: transparent; border: 1px dashed var(--line);
    border-radius: 7px; color: var(--link); cursor: pointer; font: 600 11.5px var(--sans); transition: all .12s;
  }
  .expandrow:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
  .originlink { background: transparent; border: 0; padding: 0; cursor: pointer; color: var(--link); font: inherit; }
  .originlink b { color: var(--link); font-family: var(--mono); }
  .originlink:hover:not(:disabled) { text-decoration: underline; }
  .originlink:disabled { cursor: default; color: var(--muted); }
  .originlink:disabled b { color: var(--fg); }
  .dload { color: var(--muted); padding: 30px 0; font-size: 13px; }
  .dload.err { color: var(--bad, #dc2626); }
  h2 { font: 600 15px var(--mono); margin: 0 0 7px; color: var(--fg); }
  h2 .loc { color: var(--muted); font-weight: 400; font-size: 13px; font-family: var(--sans); }
  .pill { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; line-height: 1.7; }
  .pill b { color: var(--fg); font-family: var(--mono); }
  .pill.holder { color: var(--fg); font-size: 12.5px; font-family: var(--sans); margin-top: -2px; }
  .pill.holder .hk { font: 700 9px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-right: 6px; }
  .moastag { margin: 0 4px; font-size: 10px; padding: 0 6px; vertical-align: middle; cursor: help; }
  .moasbox { margin: 6px 0 2px; padding: 9px 11px; border: 1px solid color-mix(in srgb, #8b5cf6 32%, transparent); border-radius: 8px; background: color-mix(in srgb, #8b5cf6 7%, transparent); }
  .moashdr { font-size: 11px; color: var(--muted); margin-bottom: 7px; display: flex; align-items: center; gap: 7px; }
  .moaslist { display: flex; flex-wrap: wrap; gap: 6px 8px; }
  .moasitem { display: inline-flex; align-items: baseline; gap: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; cursor: pointer; font: 12px var(--sans); transition: border-color .12s; }
  .moasitem:hover { border-color: var(--accent); }
  .moasitem b { color: var(--link); font-family: var(--mono); font-weight: 700; }
  .moasitem .onm { color: var(--fg); }
  .moasitem .opeers { color: var(--muted); font-size: 10.5px; font-family: var(--mono); }
  .omore { color: var(--muted); font-size: 11px; align-self: center; }
  .moasexp { margin-top: 8px; }
  .dsec { font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--accent); margin: 20px 0 8px; border-top: 1px solid var(--line2); padding-top: 13px; display: flex; align-items: center; gap: 7px; }
  .rel { margin-top: 8px; }
  .relbox { margin: 10px 0 0; font-size: 12px; }
  .relbox b { color: var(--muted); font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
  .rels { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 5px 11px; }
  .rellink { background: transparent; border: 0; color: var(--link); cursor: pointer; font: 12px var(--mono); padding: 0; }
  .rellink:hover { text-decoration: underline; }
  .sub-sep { color: var(--muted); margin: 0 6px; }
  .muted { color: var(--muted); }
  .irrlist { display: flex; flex-direction: column; gap: 5px; margin-top: 4px; }
  .irritem { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; font-size: 12px; }
  .irritem .originlink b { font-family: var(--mono); }
  .irrnm { color: var(--fg); }
  .irrcur { font-size: 8px; padding: 0 4px; align-self: center; }
  .irrsrcs { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: auto; }
  .srcb { font-size: 9.5px; padding: 0 5px; cursor: help; }
  .irrnone { font-size: 12px; margin-top: 2px; }
  .provenance { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--muted); font-size: 10.5px; margin: 14px 0 2px; }
  table.paths { border-collapse: collapse; width: 100%; font-size: 12px; }
  table.paths th { text-align: left; font: 700 10px var(--mono); text-transform: uppercase; color: var(--muted); padding: 4px 9px; border-bottom: 1px solid var(--line); }
  table.paths td { padding: 5px 9px; border-bottom: 1px solid var(--line2); vertical-align: top; }
  table.paths td.num { font-family: var(--mono); text-align: right; color: var(--muted); white-space: nowrap; }
  table.paths tr.hit { background: var(--hit); }
  .star { color: var(--signal); }
  @media (max-width: 820px) {
    /* 浮窗模式: 自动全屏, 不可拖动/缩放 */
    .floatwin { inset: 0 !important; width: auto !important; height: auto !important; border: 0; border-radius: 0; }
    .fbar { cursor: default; }
    .fgrip { display: none; }
    .dbody.floatbody { padding: 8px 18px 84px; }
    .detail { position: fixed; inset: 0; width: 100% !important; flex-basis: 100% !important; z-index: 40; }
    .dragbar { display: none; }
    /* 标题下移一点, 避免顶到右上浮岛 */
    h2 { margin-top: 16px; }
    /* 底部留白, 防止被底部居中的分区导航遮挡 */
    .dbody { padding-bottom: 76px; }
  }
</style>
