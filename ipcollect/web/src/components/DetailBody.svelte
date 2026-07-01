<script>
  // 详情正文(按 S.detailKind 分派): ASN -> AsnDetail; 域名 -> DomainDetail; 前缀/IP -> 本组件内联渲染
  // (概览 pill + MOAS + PathGraph + 上下级 + paths 表 + IRR/RPKI + IP WHOIS)。
  // 从 InsightDrawer 抽出, 供 InsightDrawer(右侧抽屉 / trace 浮窗)与 WhoisView(首页内联)共用同一份渲染。
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { compilePathQuery, asnName } from '../lib/bgp.js'
  import { holderOrg } from '../lib/rdap.js'
  import { showInsight, showAsn } from '../lib/queries.js'
  import { iStar, iUp, iDown, iSpinner } from '../lib/icons.js'
  import PathGraph from './PathGraph.svelte'
  import AsPath from './AsPath.svelte'
  import Whois from './Whois.svelte'
  import AsnDetail from './AsnDetail.svelte'
  import DomainDetail from './DomainDetail.svelte'
  import OriginStatus from './OriginStatus.svelte'

  let ins = $derived(S.insight)
  // IRR 来源库权威性(RIR 直营=权威绿; 第三方=中性灰)。
  let irrAuth = $derived(new Set(S.meta?.irr?.authoritative || []))
  const isAuth = s => irrAuth.has(String(s).toUpperCase())
  let pq = $derived(compilePathQuery(S.filters.path))

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
</script>

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

<style>
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
    /* 标题下移一点, 避免顶到右上浮岛(抽屉模式) */
    h2 { margin-top: 16px; }
  }
</style>
