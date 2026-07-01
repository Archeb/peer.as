<script>
  import Fa from 'svelte-fa'
  import { t } from '../lib/i18n.js'
  import { ccLabel, flagSrc } from '../lib/bgp.js'
  import { openIxpBrowser, runAsSet } from '../lib/queries.js'
  import { iNet, iSpinner, iBuilding, iUsers, iExt, iLink, iPrefix } from '../lib/icons.js'

  let { data } = $props()
  let ixOpen = $state(false)
  let facOpen = $state(false)
  let net = $derived(data?.net)
  let ix = $derived(data?.ix || [])
  let fac = $derived(data?.fac || [])
  let ixShown = $derived(ixOpen ? ix : ix.slice(0, 8))
  let facShown = $derived(facOpen ? fac : fac.slice(0, 6))
  $effect(() => { data; ixOpen = false; facOpen = false })

  const loc = r => [r?.ix_city || r?.city, (r?.ix_country || r?.country) && ccLabel(r.ix_country || r.country)].filter(Boolean).join(' · ')
  const gbps = n => {
    n = Number(n || 0)
    if (!n) return '—'
    if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}T`
    return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}G`
  }
  const href = u => /^https?:\/\//i.test(String(u || '')) ? u : ''
  // irr_as_set 可能是多个(空格/逗号分隔, 或带来源前缀 RIPE::AS-FOO), 逐个拆成可点 token -> as-set 页。
  const asSetToks = s => String(s || '').trim().split(/[\s,]+/).filter(Boolean)
  let pdbNet = $derived(net?.net_id ? `https://www.peeringdb.com/net/${net.net_id}` : '')
  const facts = () => [
    ['pdb_type', net?.info_type],
    ['pdb_scope', net?.info_scope],
    ['pdb_traffic', net?.info_traffic],
    ['pdb_ratio', net?.info_ratio],
    ['pdb_policy', net?.policy_general],
    ['pdb_contracts', net?.policy_contracts],
    ['pdb_locations', net?.policy_locations],
    ['pdb_prefixes', (net?.info_prefixes4 || net?.info_prefixes6) ? `IPv4 ${net.info_prefixes4 || 0} · IPv6 ${net.info_prefixes6 || 0}` : ''],
    ['IRR AS-SET', net?.irr_as_set],
  ].filter(x => x[1])
</script>

<h3 class="dsec" data-sec="peeringdb">
  <Fa icon={iNet} /> PeeringDB
  {#if pdbNet}<a class="ext" href={pdbNet} target="_blank" rel="noopener noreferrer" title="peeringdb.com"><Fa icon={iExt} /></a>{/if}
</h3>

{#if data?.loading}
  <div class="muted small"><Fa icon={iSpinner} spin /> {t('querying')}</div>
{:else if data?.error}
  <div class="err small">{data.error}</div>
{:else if data?.empty}
  <div class="muted small">{t('pdb_none')}</div>
{:else}
  {#if net}
    <dl class="facts">
      {#each facts() as f}
        <div>
          <dt>{f[0] === 'IRR AS-SET' ? f[0] : t(f[0])}</dt>
          {#if f[0] === 'IRR AS-SET'}
            <dd class="asset">{#each asSetToks(f[1]) as tok}<button type="button" class="asetlink" onclick={() => runAsSet(tok)} title={t('asset_open')}>{tok}</button>{/each}</dd>
          {:else}
            <dd>{f[1]}</dd>
          {/if}
        </div>
      {/each}
    </dl>
    {#if href(net.website) || href(net.looking_glass) || href(net.route_server) || href(net.policy_url)}
      <div class="plink">
        {#if href(net.website)}<a href={href(net.website)} target="_blank" rel="noopener noreferrer"><Fa icon={iExt} /> {t('pdb_web')}</a>{/if}
        {#if href(net.looking_glass)}<a href={href(net.looking_glass)} target="_blank" rel="noopener noreferrer"><Fa icon={iLink} /> Looking Glass</a>{/if}
        {#if href(net.route_server)}<a href={href(net.route_server)} target="_blank" rel="noopener noreferrer"><Fa icon={iLink} /> Route Server</a>{/if}
        {#if href(net.policy_url)}<a href={href(net.policy_url)} target="_blank" rel="noopener noreferrer"><Fa icon={iLink} /> {t('pdb_policy_url')}</a>{/if}
      </div>
    {/if}
  {/if}

  {#if ix.length}
    <h4 class="subsec"><Fa icon={iUsers} /> {t('pdb_ix_presence')} <span class="cc">{ix.length}</span></h4>
    <div class="rows">
      {#each ixShown as r}
        <button class="ixrow" onclick={() => openIxpBrowser(r.ix_id, { keepDetail: true })} title={r.ix_name || r.name}>
          <span class="flagcol">{#if flagSrc(r.ix_country || r.country)}<img class="flag" src={flagSrc(r.ix_country || r.country)} alt="" loading="lazy" />{/if}</span>
          <span class="body">
            <span class="hd">
              <span class="nmt"><b>{r.ix_name || r.name}</b>{#if loc(r)}<em>{loc(r)}</em>{/if}</span>
              <span class="rt">
                <span class="sp">{gbps(r.speed)}</span>
                {#if r.is_rs_peer}<span class="badge b-ok mini">RS</span>{/if}
                {#if r.bfd_support}<span class="badge b-mute mini">BFD</span>{/if}
              </span>
            </span>
            {#if r.ipaddr4 || r.ipaddr6}<span class="ips">{[r.ipaddr4, r.ipaddr6].filter(Boolean).join('  ·  ')}</span>{/if}
          </span>
        </button>
      {/each}
    </div>
    {#if ix.length > 8}<button class="expandrow" onclick={() => (ixOpen = !ixOpen)}>{ixOpen ? t('collapse') : t('show_all').replace('{n}', ix.length)}</button>{/if}
  {/if}

  {#if fac.length}
    <h4 class="subsec"><Fa icon={iBuilding} /> {t('pdb_fac_presence')} <span class="cc">{fac.length}</span></h4>
    <div class="rows">
      {#each facShown as f}
        <svelte:element this={f.fac_id ? 'a' : 'div'} class="facrow" class:link={f.fac_id}
          href={f.fac_id ? `https://www.peeringdb.com/fac/${f.fac_id}` : undefined}
          target={f.fac_id ? '_blank' : undefined} rel="noopener noreferrer" title={f.fac_name || f.name}>
          <span class="flagcol">{#if flagSrc(f.country)}<img class="flag" src={flagSrc(f.country)} alt="" loading="lazy" />{/if}</span>
          <span class="body">
            <span class="hd">
              <b>{f.fac_name || f.name}</b>
              <span class="fn"><Fa icon={iPrefix} /> {f.net_count || 0}</span>
            </span>
            {#if [f.city, f.country].some(Boolean)}<span class="fl">{[f.city, f.country && ccLabel(f.country)].filter(Boolean).join(' · ')}</span>{/if}
          </span>
        </svelte:element>
      {/each}
    </div>
    {#if fac.length > 6}<button class="expandrow" onclick={() => (facOpen = !facOpen)}>{facOpen ? t('collapse') : t('show_all').replace('{n}', fac.length)}</button>{/if}
  {/if}
{/if}

<style>
  .dsec { font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--accent); margin: 20px 0 8px; border-top: 1px solid var(--line2); padding-top: 13px; display: flex; align-items: center; gap: 7px; }
  .dsec .ext { margin-left: auto; color: var(--muted); display: inline-flex; }
  .dsec .ext:hover { color: var(--accent); }
  .dsec .ext :global(svg) { width: 11px; }
  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .err { color: var(--bad, #dc2626); padding: 6px 0; }

  /* 自报概况: 透明单元格 + 内部分隔线(不填色, 只留边框), 奇数末项整行铺满不留洞 */
  .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0; border: 1px solid var(--line2); border-radius: 8px; overflow: hidden; }
  .facts > div { padding: 7px 10px; min-width: 0; border-top: 1px solid var(--line2); }
  .facts > div:nth-child(-n+2) { border-top: 0; }
  .facts > div:nth-child(odd) { border-right: 1px solid var(--line2); }
  .facts > div:last-child:nth-child(odd) { grid-column: 1 / -1; border-right: 0; }
  .facts dt { margin: 0 0 3px; color: var(--muted); font: 700 9px var(--sans); letter-spacing: .08em; text-transform: uppercase; }
  .facts dd { margin: 0; color: var(--fg); font-size: 12px; overflow-wrap: anywhere; }
  .facts dd.asset { display: flex; flex-wrap: wrap; gap: 4px; }
  .asetlink { background: var(--panel); border: 1px solid var(--line); border-radius: 5px; color: var(--link); cursor: pointer; font: 600 11px var(--mono); padding: 1px 6px; transition: border-color .12s, color .12s; }
  .asetlink:hover { border-color: var(--accent); color: var(--accent); }

  .plink { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 0; }
  .plink a { display: inline-flex; align-items: center; gap: 5px; color: var(--link); text-decoration: none; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; font: 600 11px var(--sans); }
  .plink a:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

  .subsec { margin: 16px 0 7px; color: var(--muted); font: 700 10px var(--sans); letter-spacing: .07em; text-transform: uppercase; display: flex; gap: 6px; align-items: center; }
  .subsec .cc { font: 10px var(--mono); color: var(--muted); background: var(--line2); border-radius: 999px; padding: 0 6px; text-transform: none; letter-spacing: 0; }

  .rows { border: 1px solid var(--line2); border-radius: 8px; overflow: hidden; }

  /* 行结构: [flagcol 定宽] [body 弹性(可多行)]。多行文本永不折到国旗下方。 */
  .ixrow, .facrow { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; border-bottom: 1px solid var(--line2); background: transparent; text-align: left; padding: 8px 10px; color: var(--fg); text-decoration: none; }
  .ixrow { cursor: pointer; }
  .ixrow:last-child, .facrow:last-child { border-bottom: 0; }
  .ixrow:hover, .facrow.link:hover { background: var(--rowhover); }
  .facrow.link { cursor: pointer; }
  .flagcol { flex: 0 0 20px; display: flex; align-items: center; justify-content: center; align-self: center; }
  .flagcol .flag { width: 20px; height: 15px; border-radius: 2px; object-fit: cover; box-shadow: 0 0 0 1px var(--line2); }
  .body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .hd { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; min-width: 0; }
  .nmt { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .nmt b { font: 600 12px var(--sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nmt em { color: var(--muted); font-size: 11px; font-style: normal; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rt { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .rt .sp { font: 600 11.5px var(--mono); color: var(--fg); }
  .ips { color: var(--muted); font: 11px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hd b { min-width: 0; font: 600 12px var(--sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .facrow .fn { flex-shrink: 0; color: var(--muted); font: 11px var(--mono); display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .facrow .fn :global(svg) { width: 10px; }
  .facrow .fl { color: var(--muted); font-size: 11px; }

  .badge.mini { padding: 0 5px; font-size: 9.5px; line-height: 1.6; }

  .expandrow { width: 100%; margin-top: 6px; padding: 6px; background: transparent; border: 1px dashed var(--line); border-radius: 7px; color: var(--link); cursor: pointer; font: 600 11.5px var(--sans); transition: all .12s; }
  .expandrow:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

  @media (max-width: 820px) {
    .facts { grid-template-columns: 1fr; }
    .facts > div { border-right: 0; border-top: 1px solid var(--line2); }
    .facts > div:first-child { border-top: 0; }
    .facts > div:last-child:nth-child(odd) { grid-column: auto; }
  }
</style>
