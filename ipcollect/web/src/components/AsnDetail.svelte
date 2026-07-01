<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { showInsight, showAsn, scanNeighbors, runAsSet } from '../lib/queries.js'
  import { ccLabel, isTier1, asnOrg, opText, opCls } from '../lib/bgp.js'
  import { iPrefix, iUp, iDown, iRange, iNodes, iSpinner, iUsers } from '../lib/icons.js'
  import Whois from './Whois.svelte'
  import RelGroup from './RelGroup.svelte'
  import PeeringDbBlock from './PeeringDbBlock.svelte'

  let a = $derived(S.asnView)
  let total = $derived((a?.count4 || 0) + (a?.count6 || 0))
  // 三层命名摊开: op 分类(运营商/厂商) · 原始注册名(APNIC handle, 便于搜索消歧) · GeoLite 组织名
  let handle = $derived(a ? (S.asnNames?.[a.asn] || '') : '')
  let geoOrg = $derived(a ? asnOrg(a.asn) : '')
  let op = $derived(a ? opText(a.asn) : '')
  let t1 = $derived(a && isTier1(a.asn))
  let neighEmpty = $derived(a?.neigh && !a.neigh.loading && !a.neigh.error && !a.neigh.up.length && !a.neigh.peer.length && !a.neigh.down.length)

  // 通告前缀默认只显示 5 行, 可展开。换 ASN 时重置。
  const HEAD = 5
  let pfxOpen = $state(false)
  let moOpen = $state(false)
  $effect(() => { a?.asn; pfxOpen = false; moOpen = false })
  let shownPfx = $derived(a?.prefixes ? (pfxOpen ? a.prefixes : a.prefixes.slice(0, HEAD)) : [])
</script>

{#if a}
  <h2>AS{a.asn} {#if a.name}<span class="loc">· {a.name}</span>{/if}</h2>

  {#if op || handle || (geoOrg && geoOrg !== handle)}
    <div class="names">
      {#if op}<span class="opbadge {opCls(a.asn)}">{op}</span>{/if}
      {#if handle}<span class="ni"><span class="nl">{t('asn_handle')}</span><span class="mono">{handle}</span></span>{/if}
      {#if geoOrg && geoOrg !== handle}<span class="ni"><span class="nl">{t('asn_org')}</span>{geoOrg}</span>{/if}
    </div>
  {/if}

  {#if a.error}
    <div class="dload err">{a.error}</div>
  {:else}
    <div class="pill">
      {#if a.loading}<Fa icon={iSpinner} spin /> {t('querying')}
      {:else}
        <Fa icon={iPrefix} /> {total.toLocaleString()} {t('asn_originated')}
        {#if a.count4 || a.count6}<span class="fam">· IPv4 {(a.count4 || 0).toLocaleString()} · IPv6 {(a.count6 || 0).toLocaleString()}</span>{/if}
      {/if}
    </div>

    <!-- WHOIS / RDAP -->
    <Whois kind="autnum" rkey={a.asn} />

    {#if S.meta?.has_peeringdb && a.peeringdb}
      <PeeringDbBlock data={a.peeringdb} />
    {/if}

    {#if !a.loading}
      <!-- 通告前缀 -->
      <h3 class="dsec" data-sec="originated"><Fa icon={iPrefix} /> {t('asn_originated')}{#if total} · {total.toLocaleString()}{/if}</h3>
      {#if a.prefixes?.length}
        <div class="plist">
          {#each shownPfx as p}
            <button class="prow" onclick={() => showInsight(p.pid, p.prefix)}>
              <span class="px">{p.prefix}</span>
              <span class="pm">{ccLabel(p.cc)} · {p.n_paths}</span>
            </button>
          {/each}
        </div>
        {#if a.prefixes.length > HEAD}
          <button class="expandrow" onclick={() => (pfxOpen = !pfxOpen)}>
            {pfxOpen ? t('collapse') : t('show_all').replace('{n}', a.prefixes.length)}
          </button>
        {/if}
        {#if total > a.prefixes.length}<div class="more">… {(total - a.prefixes.length).toLocaleString()} more（取样 {a.prefixes.length}）</div>{/if}
      {:else}
        <div class="muted small">{t('asn_no_origin')}</div>
      {/if}

      <!-- IRR as-set 反查: 此 ASN 被哪些 as-set 直接列为成员(登记的客户锥归属) -->
      {#if S.meta?.has_asset && a.memberOf?.length}
        <h3 class="dsec" data-sec="memberof"><Fa icon={iUsers} /> {t('asn_memberof')} · {a.memberOf.length}</h3>
        <div class="msets">
          {#each (moOpen ? a.memberOf : a.memberOf.slice(0, 12)) as k}
            <button class="msetb" onclick={() => runAsSet(k)} title={t('asset_open')}>{k}</button>
          {/each}
        </div>
        {#if a.memberOf.length > 12}
          <button class="expandrow" onclick={() => (moOpen = !moOpen)}>{moOpen ? t('collapse') : t('show_all').replace('{n}', a.memberOf.length)}</button>
        {/if}
      {/if}

      <!-- 观测关系 = 完整邻居(三态 up/peer/down): 预计算邻接(asn_neigh)自动加载、完整无截断;
           旧数据无该列时回退「按需全表扫」按钮。「观测关系」与「完整邻居」已合并为本分区。 -->
      <h3 class="dsec" data-sec="relations"><Fa icon={iRange} /> {t('asn_rel')}</h3>
      {#if !a.neigh}
        <button class="scanbtn" onclick={() => scanNeighbors(a.asn)}><Fa icon={iNodes} /> {t('asn_neigh_btn')}</button>
        <div class="relnote">{t('asn_neigh_note')}</div>
      {:else if a.neigh.loading}
        <div class="muted small"><Fa icon={iSpinner} spin /> {t('querying')}</div>
      {:else if a.neigh.error}
        <div class="dload err">{a.neigh.error}</div>
      {:else}
        {#if neighEmpty}<div class="muted small">{t('none_in_db')}</div>{/if}
        <RelGroup title={t('rel_up')} icon={iUp} items={a.neigh.up} subject={a.asn} />
        <RelGroup title={t('rel_peer')} icon={iRange} items={a.neigh.peer} subject={a.asn} />
        <RelGroup title={t('rel_down')} icon={iDown} items={a.neigh.down} subject={a.asn} />
        <div class="relnote">{a.neigh.precomputed ? t('asn_neigh_pre') : t('asn_scanned').replace('{n}', a.neigh.scanned.toLocaleString())}{a.neigh.capped ? t('asn_capped') : ''}{t1 ? ' · ' + t('asn_rel_t1_note') : ''}</div>
      {/if}
    {/if}
  {/if}
{/if}

<style>
  h2 { font: 600 15px var(--mono); margin: 0 0 7px; color: var(--fg); }
  h2 .loc { color: var(--muted); font-weight: 400; font-size: 13px; font-family: var(--sans); }
  .names { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 8px; font-size: 12.5px; color: var(--fg); }
  .names .ni { display: inline-flex; align-items: baseline; gap: 5px; }
  .names .nl { font: 700 9px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
  .names .mono { font-family: var(--mono); }
  .opbadge { font: 700 10px var(--sans); padding: 2px 8px; border-radius: 999px; background: var(--alt); border: 1px solid var(--line); color: var(--muted); }
  .opbadge.op-ct { color: #c0392b; border-color: color-mix(in srgb, #c0392b 40%, transparent); background: color-mix(in srgb, #c0392b 10%, transparent); }
  .opbadge.op-cu { color: #2563eb; border-color: color-mix(in srgb, #2563eb 40%, transparent); background: color-mix(in srgb, #2563eb 10%, transparent); }
  .opbadge.op-cm { color: #15803d; border-color: color-mix(in srgb, #15803d 40%, transparent); background: color-mix(in srgb, #15803d 10%, transparent); }
  .pill { font-size: 11.5px; color: var(--muted); margin-bottom: 6px; line-height: 1.7; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .pill .fam { color: var(--muted); }
  .dsec { font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--accent); margin: 20px 0 8px; border-top: 1px solid var(--line2); padding-top: 13px; display: flex; align-items: center; gap: 7px; }
  .dload.err { color: var(--bad, #dc2626); font-size: 13px; padding: 10px 0; }
  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .plist { max-height: 280px; overflow: auto; display: flex; flex-direction: column; border: 1px solid var(--line2); border-radius: 8px; }
  .prow { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; background: transparent; border: 0; border-bottom: 1px solid var(--line2); cursor: pointer; padding: 5px 10px; text-align: left; }
  .prow:last-child { border-bottom: 0; }
  .prow:hover { background: var(--line2); }
  .prow .px { font: 12px var(--mono); color: var(--link); }
  .prow .pm { font-size: 11px; color: var(--muted); font-family: var(--sans); white-space: nowrap; }
  .more { font-size: 11px; color: var(--muted); padding: 6px 2px 0; }
  .expandrow { width: 100%; margin-top: 6px; padding: 6px; background: transparent; border: 1px dashed var(--line); border-radius: 7px; color: var(--link); cursor: pointer; font: 600 11.5px var(--sans); transition: all .12s; }
  .expandrow:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
  .msets { display: flex; flex-wrap: wrap; gap: 5px; }
  .msetb { background: var(--alt); border: 1px solid var(--line); border-radius: 5px; color: var(--link); cursor: pointer; font: 600 11px var(--mono); padding: 2px 7px; transition: border-color .12s; }
  .msetb:hover { border-color: var(--accent); color: var(--accent); }
  .relnote { color: var(--muted); font-size: 11px; margin: 8px 0 2px; line-height: 1.5; }
  .scanbtn { display: inline-flex; align-items: center; gap: 7px; background: var(--inbg); color: var(--accent); border: 1px solid var(--line); border-radius: 8px; cursor: pointer; padding: 7px 14px; font: 600 12px var(--sans); transition: all .12s; }
  .scanbtn:hover { border-color: var(--accent); background: var(--accent-dim); }
  /* 标题下移一点, 避免顶到右上浮岛(与 InsightDrawer 一致) */
  @media (max-width: 820px) { h2 { margin-top: 16px; } }
</style>
