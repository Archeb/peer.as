<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { isLowVis, parseBest, parseSeq, ccLabel, placeLabel } from '../lib/bgp.js'
  import { sortRows, showInsight, closeInsight } from '../lib/queries.js'
  import { iStar, iSignal, iChevD, iChevR } from '../lib/icons.js'
  import AsnTag from './AsnTag.svelte'
  import AsPath from './AsPath.svelte'
  import OriginStatus from './OriginStatus.svelte'
  import OverviewStats from './OverviewStats.svelte'

  // DMIT 赞助 logo(本地 public/dmit.svg)。绝对化以适配任意部署根(同 db.js 的做法)。
  const DMIT = new URL('./dmit.svg', document.baseURI).href

  let hasPath = $derived(parseSeq(S.filters.path).length > 0)
  let cols = $derived(4 + (hasPath ? 1 : 0)) // prefix, origin, loc, #path (+seg col always) (+match)

  function rowClick(r) {
    if (S.selectedPid === r.pid) closeInsight()
    else showInsight(r.pid, r.prefix)
  }
  const loc = r => placeLabel(r.province, r.city, r.cc)
  function arrow(key) { return S.sortKey === key ? (S.sortDir < 0 ? '▾' : '▴') : '' }
</script>

{#if S.rows.length}
  <div class="tablewrap">
    <table>
      <thead>
        <tr>
          <th onclick={() => sortRows('prefix')}>{t('col_prefix')} <span class="ar">{arrow('prefix')}</span></th>
          <th onclick={() => sortRows('origin_asn')}>{t('col_origin')} <span class="ar">{arrow('origin_asn')}</span></th>
          <th onclick={() => sortRows('city')}>{t('col_loc')} <span class="ar">{arrow('city')}</span></th>
          <th class="num" onclick={() => sortRows('n_paths')}>{t('col_path')} <span class="ar">{arrow('n_paths')}</span></th>
          <th class="nosort">{t('col_seg')}</th>
          {#if hasPath}<th class="nosort">{t('col_match')}</th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each S.rows as r, i (i)}
          {@const sel = S.selectedPid === r.pid}
          {@const low = isLowVis(r)}
          <tr class="prow" class:hit={r._best} class:selected={sel} onclick={() => rowClick(r)}>
            <td class="pfx">
              <span class="chev"><Fa icon={sel ? iChevD : iChevR} /></span>{r.prefix}
            </td>
            <td><AsnTag asn={r.origin_asn} /><OriginStatus rpki={r.rpki} irr={r.irr} />{#if r.n_origins > 1}<span class="badge b-moas moas" title={t('moas_note')}>{t('moas')} {r.n_origins}</span>{/if}</td>
            <td class="loc">{loc(r)}</td>
            <td class="num">
              <span class="np">{r.n_paths ?? 0}</span>
              {#if low}<span class="badge b-warn lv" title={t('lowvis')}><Fa icon={iSignal} /></span>{/if}
            </td>
            <td class="seg">{#if r.segs && r.segs.length}<span class="segn">{r.segs.length}</span>{/if}</td>
            {#if hasPath}
              <td class="match">
                {#if r.best_path}
                  {#if r._best}<span class="star"><Fa icon={iStar} /></span>{/if}
                  <AsPath asns={parseBest(r.best_path)} dim={!r._best} />
                {/if}
              </td>
            {/if}
          </tr>
          {#if sel && r.segs && r.segs.length}
            <tr class="segrow"><td></td><td colspan={cols}>
              <div class="seghdr">{t('segs_title')}</div>
              <div class="segs">
                {#each Array.from(r.segs || []).slice(0, 64) as cidr}<span class="segpill">{cidr}</span>{/each}
              </div>
            </td></tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  {#if S.mode === 'prompt'}
    <OverviewStats prompt />
  {:else}
    <div class="empty">{t('no_results')}</div>
  {/if}
  {#if S.edge === 'cn'}
    <!-- 仅当正使用中国优化服务器时, 在空内容区显示浅色赞助提示 -->
    <div class="cn-accel">
      <span>{t('cn_accel_pre')}</span>
      <a href="https://www.dmit.io" target="_blank" rel="noopener noreferrer" aria-label="DMIT">
        <img src={DMIT} alt="DMIT" />
      </a>
      {#if t('cn_accel_post')}<span>{t('cn_accel_post')}</span>{/if}
    </div>
  {/if}
{/if}

<style>
  .tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 11px; border-bottom: 1px solid var(--line2); white-space: nowrap; }
  thead th {
    position: sticky; top: 0; z-index: 2; background: var(--alt); color: var(--muted);
    font: 700 10.5px var(--sans); letter-spacing: .04em; text-transform: uppercase;
    cursor: pointer; border-bottom: 1px solid var(--line); user-select: none;
  }
  thead th.nosort { cursor: default; }
  th.num, td.num { text-align: right; }
  .ar { color: var(--accent); }
  tbody tr.prow { cursor: pointer; }
  tbody tr.prow:hover { background: var(--rowhover); }
  tr.hit { background: var(--hit); }
  tr.hit:hover { background: var(--hit-h); }
  tr.selected td { background: var(--rowhover); }
  tr.selected td.pfx { box-shadow: inset 3px 0 0 var(--accent); }
  .pfx { font-family: var(--mono); color: var(--link); }
  .chev { color: var(--muted); font-size: 9px; margin-right: 7px; display: inline-block; width: 8px; }
  tr.selected .chev, tr.prow:hover .chev { color: var(--accent); }
  .loc { color: var(--fg); }
  .np { font-family: var(--mono); }
  .lv { padding: 0 5px; font-size: 9px; }
  .moas { margin-left: 6px; font-size: 9px; padding: 0 5px; cursor: help; }
  .seg .segn {
    font: 600 10px var(--mono); color: var(--muted); background: var(--alt);
    border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px;
  }
  .match .star { color: var(--signal); margin-right: 4px; }
  tr.segrow td { background: var(--alt); padding: 9px 12px 11px; box-shadow: inset 3px 0 0 var(--accent); }
  .seghdr { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  .segs { display: flex; flex-wrap: wrap; gap: 4px 12px; }
  .segpill { font: 11.5px var(--mono); color: var(--code); }

  .empty { color: var(--muted); padding: 40px 6px; font-size: 13px; text-align: center; }
  /* 中国优化服务器赞助提示: 文字用与 prompt 一致的 muted 色; margin-top:auto 贴到内容区底部,
     与侧栏底部控制栏(.foot)高度对齐 */
  .cn-accel {
    display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px;
    margin-top: auto; padding-top: 24px;margin-bottom:8px; color: var(--muted); font-size: 11.5px;
  }
  .cn-accel a { line-height: 0; }
  .cn-accel img { height: 15px; display: block; }
</style>
