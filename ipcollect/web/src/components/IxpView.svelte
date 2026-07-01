<script>
  // PeeringDB IXP 详情(主内容区, mode==='ixp')。目录侧栏已删 —— 导航改由顶栏搜索框(IX 名/AS)
  // 与「IX 目录」SSR 页承担; 本视图只渲染单个选中 IX 的详情, 空态给热门交换中心快捷入口。
  // 详情沿用详情面板范式: .dsec 分区 + 平铺指标 + 标准表。成员表可即时筛选/排序, 点行下钻 ASN。
  import { onMount } from 'svelte'
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { ccLabel, flagSrc } from '../lib/bgp.js'
  import { loadIxpList, selectIxp, showAsn } from '../lib/queries.js'
  import { iNet, iSearch, iSpinner, iUsers, iBuilding, iPrefix, iLink, iExt, iCheck, iBolt } from '../lib/icons.js'
  import AsnTag from './AsnTag.svelte'

  const fmt = n => (n == null || n === '') ? '—' : Number(n).toLocaleString()
  const gbps = n => {
    n = Number(n || 0)
    if (!n) return '—'
    if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}T`
    return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}G`
  }
  const loc = r => [r?.city, r?.country && ccLabel(r.country)].filter(Boolean).join(' · ') || '—'
  const href = u => /^https?:\/\//i.test(String(u || '')) ? u : ''

  let d = $derived(S.ixp?.detail)
  let ix = $derived(d?.ix)
  let members = $derived(d?.members || [])
  let totalSpeed = $derived(members.reduce((s, r) => s + Number(r.speed || 0), 0))
  let pdbIx = $derived(ix?.ix_id ? `https://www.peeringdb.com/ix/${ix.ix_id}` : '')
  // 空态「热门交换中心」快捷入口: 列表按 net_count 降序, 取前若干。
  let popular = $derived((S.ixp?.rows || []).slice(0, 12))

  // 成员表: 即时筛选 + 列排序。切换 IX 时复位。
  let mq = $state('')
  let msort = $state({ k: 'speed', d: -1 })
  $effect(() => { S.ixp?.selected; mq = ''; msort = { k: 'speed', d: -1 } })
  function sortBy(k) { msort = msort.k === k ? { k, d: -msort.d } : { k, d: k === 'speed' ? -1 : 1 } }
  const arrow = k => msort.k === k ? (msort.d < 0 ? '▾' : '▴') : ''
  let memList = $derived.by(() => {
    let a = members
    const f = mq.trim().toLowerCase()
    if (f) a = a.filter(m => `${m.asn} ${m.net_name || ''} ${m.ipaddr4 || ''} ${m.ipaddr6 || ''}`.toLowerCase().includes(f))
    const { k, d: dir } = msort
    const val = m => k === 'asn' ? Number(m.asn) : k === 'speed' ? Number(m.speed || 0) : (m.net_name || '').toLowerCase()
    return [...a].sort((x, y) => {
      const vx = val(x), vy = val(y)
      if (vx < vy) return -dir
      if (vx > vy) return dir
      return Number(x.asn) - Number(y.asn)
    })
  })

  onMount(() => { loadIxpList() })   // 只为空态热门 + 顶栏建议预热列表; 不自动选中
</script>

<div class="ixwrap">
  {#if S.ixp.error}
    <div class="empty err">{S.ixp.error}</div>
  {:else if d?.loading}
    <div class="boot"><Fa icon={iSpinner} spin /> {t('querying')}</div>
  {:else if d?.error}
    <div class="empty err">{d.error}</div>
  {:else if ix}
    <div class="titlebar">
      <div class="tmain">
        <h2>{#if flagSrc(ix.country)}<img class="flag" src={flagSrc(ix.country)} alt="" />{/if}{ix.name}</h2>
        <p>{loc(ix)}{#if ix.region_continent} · {ix.region_continent}{/if}</p>
      </div>
      <div class="links">
        {#if href(ix.website)}<a href={href(ix.website)} target="_blank" rel="noopener noreferrer"><Fa icon={iExt} /> {t('pdb_web')}</a>{/if}
        {#if href(ix.url_stats)}<a href={href(ix.url_stats)} target="_blank" rel="noopener noreferrer"><Fa icon={iLink} /> {t('pdb_stats')}</a>{/if}
        {#if pdbIx}<a href={pdbIx} target="_blank" rel="noopener noreferrer"><Fa icon={iExt} /> PeeringDB</a>{/if}
      </div>
    </div>

    <dl class="metrics">
      <div><dt><Fa icon={iUsers} /> {t('ixp_members')}</dt><dd>{fmt(ix.net_count)}</dd></div>
      <div><dt><Fa icon={iBuilding} /> {t('ixp_facilities')}</dt><dd>{fmt(ix.fac_count)}</dd></div>
      <div><dt><Fa icon={iBolt} /> {t('ixp_capacity')}</dt><dd>{gbps(totalSpeed)}</dd></div>
      <div><dt>IPv6</dt><dd class="v6">{#if ix.proto_ipv6}<Fa icon={iCheck} />{:else}<span class="no">—</span>{/if}</dd></div>
    </dl>

    {#if d.ixlans?.length}
      <h3 class="dsec"><Fa icon={iNet} /> {t('ixp_lans')} <span class="cc">{fmt(d.ixlans.length)}</span></h3>
      <div class="rows">
        {#each d.ixlans as l}
          <div class="lan">
            <b>{l.name || ('IXLAN ' + l.ixlan_id)}</b>
            <span class="mtu">MTU {l.mtu || '—'}</span>
            {#if l.rs_asn}<button class="aslink" onclick={() => showAsn(l.rs_asn)} title="Route server"><span class="rsl">RS</span><AsnTag asn={l.rs_asn} /></button>{:else}<span class="mtu">—</span>{/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if d.prefixes?.length}
      <h3 class="dsec"><Fa icon={iPrefix} /> {t('ixp_prefixes')} <span class="cc">{fmt(d.prefixes.length)}</span></h3>
      <div class="pfxs">
        {#each d.prefixes as p}
          <span class="pfx" class:v6={String(p.protocol).includes('6')}>{p.prefix}<em>{p.protocol}</em></span>
        {/each}
      </div>
    {/if}

    {#if d.facilities?.length}
      <h3 class="dsec"><Fa icon={iBuilding} /> {t('ixp_facilities')} <span class="cc">{fmt(d.facilities.length)}</span></h3>
      <div class="faclist">
        {#each d.facilities as f}
          <svelte:element this={f.fac_id ? 'a' : 'div'} class="facchip" class:link={f.fac_id}
            href={f.fac_id ? `https://www.peeringdb.com/fac/${f.fac_id}` : undefined}
            target={f.fac_id ? '_blank' : undefined} rel="noopener noreferrer"
            title={[f.fac_name, f.city, f.country && ccLabel(f.country)].filter(Boolean).join(' · ')}>
            <b>{f.fac_name}</b>
            <span class="fn"><Fa icon={iPrefix} /> {fmt(f.net_count)}</span>
          </svelte:element>
        {/each}
      </div>
    {/if}

    <div class="memhd">
      <h3 class="dsec"><Fa icon={iUsers} /> {t('ixp_members')} <span class="cc">{fmt(members.length)}</span></h3>
      {#if members.length > 12}
        <label class="mfilter"><Fa icon={iSearch} /><input bind:value={mq} placeholder={t('ixp_member_filter')} /></label>
      {/if}
    </div>
    {#if members.length}
      <div class="tablewrap">
        <table>
          <thead><tr>
            <th><button class="sh" class:act={msort.k === 'asn'} onclick={() => sortBy('asn')}>ASN<span class="ar">{arrow('asn')}</span></button></th>
            <th><button class="sh" class:act={msort.k === 'name'} onclick={() => sortBy('name')}>{t('w_name')}<span class="ar">{arrow('name')}</span></button></th>
            <th>{t('pdb_type')}</th>
            <th class="num"><button class="sh" class:act={msort.k === 'speed'} onclick={() => sortBy('speed')}>{t('ixp_speed')}<span class="ar">{arrow('speed')}</span></button></th>
            <th>LAN</th><th>IPv4</th><th>IPv6</th><th>RS</th>
          </tr></thead>
          <tbody>
            {#each memList as m}
              <tr class="mrow" onclick={() => showAsn(m.asn)}>
                <td><AsnTag asn={m.asn} /></td>
                <td class="mname">{m.net_name || ''}</td>
                <td class="mty">{m.info_type || ''}</td>
                <td class="num mono">{gbps(m.speed)}</td>
                <td class="mlan">{m.lan_name || ''}</td>
                <td class="mono ip">{m.ipaddr4 || ''}</td>
                <td class="mono ip">{m.ipaddr6 || ''}</td>
                <td>{#if m.is_rs_peer}<span class="badge b-ok mini">RS</span>{/if}</td>
              </tr>
            {/each}
            {#if !memList.length}<tr><td colspan="8" class="tempty">{t('none_in_db')}</td></tr>{/if}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="empty small">{t('none_in_db')}</div>
    {/if}
  {:else}
    <!-- 空态: 无选中 IX -> 引导到搜索框 / IX 目录, 附热门交换中心快捷入口 -->
    <div class="pick">
      <div class="pickhead"><Fa icon={iNet} /> {t('ixp_title')}</div>
      <p class="pickhint">{t('ixp_pick')}</p>
      {#if popular.length}
        <div class="popular">
          <div class="poptitle">{t('ixp_popular')}</div>
          <div class="popchips">
            {#each popular as r (r.ix_id)}
              <button class="popchip" onclick={() => selectIxp(r.ix_id)}>
                <b>{r.name}</b>
                <span><Fa icon={iUsers} /> {fmt(r.net_count)}</span>
              </button>
            {/each}
          </div>
        </div>
      {:else}
        <div class="boot"><Fa icon={iSpinner} spin /> {t('querying')}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ixwrap { min-width: 0; padding: 6px 0 24px; }
  .boot, .empty { padding: 40px 12px; text-align: center; color: var(--muted); font: 13px var(--mono); }
  .boot { display: flex; align-items: center; justify-content: center; gap: 9px; }
  .boot :global(svg) { color: var(--accent); }
  .err { color: var(--bad, #dc2626); }
  .small { padding: 18px 0; }
  .cc { font: 10px var(--mono); color: var(--muted); background: var(--line2); border-radius: 999px; padding: 0 6px; }

  /* ── 空态 ── */
  .pick { max-width: 760px; margin: 0 auto; padding: 40px 4px; }
  .pickhead { display: flex; align-items: center; gap: 9px; font: 700 13px var(--sans); letter-spacing: .06em; text-transform: uppercase; color: var(--fg); }
  .pickhead :global(svg) { color: var(--accent); }
  .pickhint { margin: 8px 0 22px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .poptitle { color: var(--muted); font: 700 10px var(--sans); letter-spacing: .07em; text-transform: uppercase; margin-bottom: 9px; }
  .popchips { display: flex; flex-wrap: wrap; gap: 8px; }
  .popchip { display: inline-flex; align-items: center; gap: 9px; border: 1px solid var(--line); background: var(--inbg); border-radius: 8px; padding: 7px 11px; cursor: pointer; color: var(--fg); transition: all .12s; }
  .popchip:hover { border-color: var(--accent); background: var(--accent-dim); }
  .popchip b { font: 600 12.5px var(--sans); }
  .popchip span { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font: 600 10.5px var(--mono); }
  .popchip span :global(svg) { width: 10px; }

  /* ── 详情 ── */
  .titlebar { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--line); padding-bottom: 12px; }
  .tmain { min-width: 0; }
  .titlebar h2 { margin: 0 0 4px; font: 650 19px var(--sans); color: var(--fg); overflow-wrap: anywhere; }
  .titlebar h2 .flag { width: 26px; height: 19.5px; margin-right: 9px; border-radius: 3px; object-fit: cover; vertical-align: -2px; box-shadow: 0 0 0 1px var(--line2); }
  .titlebar p { margin: 0; color: var(--muted); font-size: 12.5px; }
  .links { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
  .links a { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; color: var(--link); border: 1px solid var(--line); border-radius: 7px; padding: 5px 9px; font: 600 11.5px var(--sans); white-space: nowrap; }
  .links a:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }

  .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 14px 0 4px; border: 1px solid var(--line2); border-radius: 8px; overflow: hidden; background: var(--line2); max-width: 640px; }
  .metrics > div { padding: 10px 12px; background: var(--alt); }
  .metrics dt { color: var(--muted); font: 700 10px var(--sans); letter-spacing: .04em; text-transform: uppercase; display: flex; align-items: center; gap: 6px; }
  .metrics dt :global(svg) { width: 11px; }
  .metrics dd { margin: 5px 0 0; font: 700 19px var(--mono); color: var(--fg); }
  .metrics dd.v6 { color: var(--accent); }
  .metrics dd.v6 .no { color: var(--muted); }

  .dsec { margin: 20px 0 8px; padding-top: 13px; border-top: 1px solid var(--line2); color: var(--accent); font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; display: flex; align-items: center; gap: 7px; }
  .dsec .cc { text-transform: none; letter-spacing: 0; }

  .rows { border: 1px solid var(--line2); border-radius: 8px; overflow: hidden; max-width: 760px; }
  .lan { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 8px 11px; border-bottom: 1px solid var(--line2); font-size: 12px; }
  .lan:last-child { border-bottom: 0; }
  .lan b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .lan .mtu { color: var(--muted); font: 11px var(--mono); white-space: nowrap; }
  .aslink { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: var(--inbg); border-radius: 7px; padding: 2px 8px; cursor: pointer; color: var(--fg); }
  .aslink:hover { border-color: var(--accent); background: var(--accent-dim); }
  .aslink .rsl { font: 700 9px var(--sans); letter-spacing: .06em; color: var(--muted); }

  /* 设施: 横向排列 + 换行的紧凑 chip(一般同国, 不出旗); 名称限宽省略, 点击跳 PeeringDB 设施页 */
  .faclist { display: flex; flex-wrap: wrap; gap: 8px; }
  .facchip { display: inline-flex; align-items: center; gap: 8px; max-width: 260px; border: 1px solid var(--line2); border-radius: 8px; padding: 6px 10px; background: var(--alt); text-decoration: none; color: var(--fg); }
  .facchip.link { cursor: pointer; transition: border-color .12s, background .12s; }
  .facchip.link:hover { border-color: var(--accent); background: var(--accent-dim); }
  .facchip b { min-width: 0; font: 600 12px var(--sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .facchip .fn { flex-shrink: 0; color: var(--muted); font: 11px var(--mono); display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .facchip .fn :global(svg) { width: 10px; }

  .pfxs { display: flex; flex-wrap: wrap; gap: 6px; }
  .pfx { display: inline-flex; align-items: baseline; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; font: 12px var(--mono); color: var(--code); background: var(--alt); }
  .pfx em { color: var(--muted); font: 9px var(--sans); font-style: normal; text-transform: uppercase; letter-spacing: .04em; }
  .pfx.v6 { color: var(--link); }

  /* ── 成员表(标准 tablewrap) ── */
  .memhd { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .memhd .dsec { flex: 1 1 auto; }
  .mfilter { display: inline-flex; align-items: center; gap: 7px; height: 30px; border: 1px solid var(--line); background: var(--inbg); border-radius: 7px; padding: 0 9px; color: var(--muted); }
  .mfilter:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .mfilter :global(svg) { width: 11px; }
  .mfilter input { width: 190px; max-width: 46vw; border: 0; outline: 0; background: transparent; color: var(--fg); font: 12px var(--sans); }

  .tablewrap { overflow: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--line2); border-radius: 8px; max-height: 64vh; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line2); white-space: nowrap; }
  thead th { position: sticky; top: 0; z-index: 1; background: var(--alt); color: var(--muted); font: 700 10.5px var(--sans); letter-spacing: .04em; text-transform: uppercase; border-bottom: 1px solid var(--line); }
  th.num, td.num { text-align: right; }
  .sh { background: transparent; border: 0; padding: 0; margin: 0; font: inherit; color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; text-transform: uppercase; letter-spacing: .04em; }
  .sh:hover { color: var(--fg); }
  .sh.act { color: var(--accent); }
  .sh .ar { font-size: 9px; min-width: 6px; }
  tbody tr.mrow { cursor: pointer; }
  tbody tr.mrow:hover { background: var(--rowhover); }
  tbody tr:last-child td { border-bottom: 0; }
  .mono { font-family: var(--mono); }
  .ip { color: var(--muted); }
  .mname { min-width: 160px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
  .mty { color: var(--muted); }
  .mlan { color: var(--muted); }
  .tempty { text-align: center; color: var(--muted); font-family: var(--mono); padding: 18px; }
  .badge.mini { padding: 0 5px; font-size: 9.5px; line-height: 1.6; }

  @media (max-width: 820px) {
    .titlebar { flex-direction: column; }
    .links { justify-content: flex-start; }
    .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .lan { grid-template-columns: 1fr auto; }
    .tablewrap { max-height: none; }
  }
</style>
