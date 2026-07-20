<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { genAgo, genUtc } from '../lib/clock.svelte.js'
  import { iPrefix, iPath, iGlobal, iClock, iSatellite, iDb, iGear } from '../lib/icons.js'

  // 前端构建版本(vite define 编译期注入; 缺失时回退)。
  const BUILD_SHA = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev'
  const BUILD_TS = typeof __BUILD_TS__ !== 'undefined' ? __BUILD_TS__ : 0

  let { prompt = false } = $props()

  let counts = $derived(S.meta?.counts || {})
  let nCountry = $derived((S.meta?.countries || []).length)
  let dataVer = $derived((S.meta?.version || '').slice(0, 8))

  // 采集点: 新数据是对象 {name,src,snap_ts,ingest_ts}; 兼容旧数据(纯字符串)。
  let collectors = $derived((S.meta?.collectors || []).map(c =>
    typeof c === 'string'
      ? { name: c, src: c.startsWith('route-views') ? 'routeviews' : 'ris', snap_ts: null, ingest_ts: null }
      : c))

  const fmt = n => (n ?? null) === null ? '—' : Number(n).toLocaleString()

  // 已知采集点的物理位置(vantage point), 让 idle 区像观测台。未知则只显示来源类型。
  const LOC = {
    rrc01: ['London', '伦敦'], rrc03: ['Amsterdam', '阿姆斯特丹'],
    rrc06: ['Tokyo', '东京'], rrc00: ['Amsterdam', '阿姆斯特丹'],
    'route-views2': ['Oregon', '俄勒冈'], 'route-views3': ['San Jose', '圣何塞'],
    'route-views4': ['Sydney', '悉尼'], 'route-views6': ['Eugene', '尤金'],
  }
  const srcLabel = s => s === 'routeviews' ? 'RouteViews' : s === 'ris' ? 'RIPE RIS' : ''
  const locLabel = c => { const l = c.location || LOC[c.name]; return l ? (S.lang === 'zh' ? l[1] : l[0]) : '' }

  // 数据新鲜度(按快照时刻): <3h=live(青) / <12h=aging(琥珀) / 更久=stale / 无=na。
  function freshness(ts) {
    if (!ts) return 'na'
    const age = Date.now() / 1000 - Number(ts)
    if (age < 3 * 3600) return 'live'
    if (age < 12 * 3600) return 'aging'
    return 'stale'
  }

  let metrics = $derived([
    { icon: iPrefix, k: t('t_prefix4'), v: fmt(counts.prefixes) },
    { icon: iPrefix, k: t('t_prefix6'), v: fmt(counts.prefixes_v6) },
    { icon: iPath, k: t('t_paths'), v: fmt((counts.paths || 0) + (counts.paths_v6 || 0)) },
    { icon: iGlobal, k: t('t_country'), v: nCountry ? fmt(nCountry) : '—' },
  ])
</script>

<section class="ov" class:prompt>
  {#if prompt}
    <p class="hint">{t('ov_hint')}</p>
  {/if}

  <div class="metrics">
    {#each metrics as m}
      <div class="metric">
        <span class="mk"><Fa icon={m.icon} /> {m.k}</span>
        <span class="mv">{m.v}</span>
      </div>
    {/each}
  </div>

  {#if collectors.length}
    <h3 class="ohdr"><Fa icon={iSatellite} /> {t('ov_sources')} <span class="cnt">{collectors.length}</span></h3>
    <ul class="srcs">
      {#each collectors as c}
        <li>
          <span class="dot" data-f={freshness(c.snap_ts)} title={genUtc(c.snap_ts) || t('ov_na')}></span>
          <span class="cname">{c.name}</span>
          <span class="cmeta">{srcLabel(c.src)}{#if srcLabel(c.src) && locLabel(c)}{' · '}{/if}{locLabel(c)}</span>
          <span class="cago" title={c.snap_ts ? `${t('ov_snap')} ${genUtc(c.snap_ts)}` : t('ov_na')}>
            {c.snap_ts ? genAgo(c.snap_ts) : t('ov_na')}
          </span>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="foot">
    <span title={genUtc(S.meta?.generated_ts)}><Fa icon={iClock} /> {t('t_gen')} {genAgo(S.meta?.generated_ts)}</span>
    <span class="sep">·</span>
    <span title={S.meta?.version}><Fa icon={iDb} /> {t('ov_data')} {dataVer || '—'}</span>
    <span class="sep">·</span>
    <span title={BUILD_TS ? genUtc(BUILD_TS) : ''}><Fa icon={iGear} /> {t('ov_build')} {BUILD_SHA}</span>
  </div>
</section>

<style>
  .ov { color: var(--muted); }
  .ohdr {
    display: flex; align-items: center; gap: 8px;
    margin: 0 0 9px; font: 700 10px/1 var(--sans); letter-spacing: .14em;
    text-transform: uppercase; color: var(--muted);
  }
  .ohdr :global(svg) { width: 11px; color: var(--muted); }
  .ohdr .cnt {
    font: 600 10px var(--mono); letter-spacing: 0; color: var(--accent);
    background: var(--accent-dim); border-radius: 999px; padding: 1px 7px;
  }

  /* 指标卡 */
  .metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 18px; }
  .metric {
    display: flex; flex-direction: column; gap: 5px; min-width: 0;
    padding: 11px 13px; border-radius: 8px;
    background: color-mix(in srgb, var(--alt) 75%, transparent);
  }
  .mk {
    display: inline-flex; align-items: center; gap: 7px; min-width: 0;
    font: 600 11px var(--sans); color: var(--muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .mk :global(svg) { width: 11px; color: var(--accent); flex: none; }
  .mv { font: 600 18px/1 var(--mono); color: var(--fg); }

  /* 采集点(vantage points)列表 */
  .srcs { list-style: none; margin: 0 0 18px; padding: 0; }
  .srcs li {
    display: grid; grid-template-columns: auto auto 1fr auto; align-items: baseline;
    gap: 9px; padding: 7px 2px; border-bottom: 1px solid var(--line2); font-size: 12.5px;
  }
  .srcs li:last-child { border-bottom: 0; }
  .dot {
    width: 7px; height: 7px; border-radius: 50%; align-self: center;
    background: var(--muted); box-shadow: 0 0 0 0 transparent;
  }
  .dot[data-f="live"]  { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .dot[data-f="aging"] { background: var(--signal); }
  .dot[data-f="stale"] { background: var(--muted); }
  .dot[data-f="na"]    { background: transparent; border: 1px solid var(--line); }
  .cname { font: 600 12.5px var(--mono); color: var(--fg); }
  .cmeta { color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .cago { font: 12px var(--sans); color: var(--muted); white-space: nowrap; justify-self: end; }

  /* 页脚: 数据版本 + 生成时间 + 前端 build */
  .foot {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    padding-top: 11px; border-top: 1px solid var(--line2);
    font: 11px var(--sans); color: var(--muted);
  }
  .foot span { display: inline-flex; align-items: center; gap: 5px; }
  .foot :global(svg) { width: 10px; opacity: .8; }
  .foot .sep { opacity: .5; }

  .hint { margin: 0 0 18px; font: 13px var(--sans); color: var(--muted); text-align: center; }

  /* idle hero 框定 */
  .ov.prompt { width: min(620px, 100%); margin: 40px auto 0; padding: 0 8px; }
  .ov.prompt .ohdr { color: var(--fg); }

  @media (max-width: 680px) {
    .ov.prompt { margin-top: 22px; padding: 0; }
    .metrics { gap: 7px; }
    .metric { padding: 9px 11px; }
    .mv { font-size: 16px; }
  }
</style>
