<script>
  import Fa from 'svelte-fa'
  import { showAsn, loadEvidence } from '../lib/queries.js'
  import { t } from '../lib/i18n.js'
  import { iAbout, iSpinner } from '../lib/icons.js'
  import AsnTag from './AsnTag.svelte'
  import AsPath from './AsPath.svelte'

  // 一组关系邻居(up/peer/down 之一)。items=[{asn,n,d,u,ev}], subject=被查询的 ASN。
  // ev 两形态: 预计算={pid}(点开按 pid 懒查路径); 旧数据全表扫={path,side,prefix?}(现成)。
  // 标签 inline 排满换行(flex-wrap); 「依据」小图标, 点击浮出该关系的样本路径(同组一次只开一条)。
  let { title, icon, items, subject } = $props()
  let openAsn = $state(null)
  let pop = $state(null)
  let evCache = $state({})       // asn -> 'loading' | {path,side} | null(查无)
  // 展示折叠: items 是**全部**邻居(计数即真实数), 默认只渲染前 SHOW 个; 超出给「展开/收起」。
  const SHOW = 40
  let expanded = $state(false)
  const shown = $derived(expanded ? items : items.slice(0, SHOW))

  async function toggle(it) {
    if (openAsn === it.asn) { openAsn = null; return }
    openAsn = it.asn
    // ev 是 {pid} 且未缓存 -> 懒查那条样本路径(只在点开时, 不拖慢 ASN 加载)。
    if (it.ev?.path == null && it.ev?.pid != null && evCache[it.asn] === undefined) {
      evCache = { ...evCache, [it.asn]: 'loading' }
      const e = await loadEvidence(it.ev.pid, subject, it.asn)
      evCache = { ...evCache, [it.asn]: e }
    }
  }
  const evOf = it => (it.ev?.path ? it.ev : evCache[it.asn])   // 现成 / 懒查结果

  // 浮层右缘若超出视口则改为右对齐锚点, 避免溢出窄面板产生横向滚动。
  $effect(() => {
    openAsn; evCache
    if (openAsn == null || !pop || typeof window === 'undefined') return
    pop.style.left = '0'; pop.style.right = 'auto'
    const r = pop.getBoundingClientRect()
    if (r.right > window.innerWidth - 8) { pop.style.left = 'auto'; pop.style.right = '0' }
  })
</script>

{#if items?.length}
  <div class="rgroup">
    <b><Fa {icon} /> {title} <span class="gc">{items.length}</span></b>
    <div class="taglist">
      {#each shown as it}
        <span class="tag" class:noev={!it.ev} class:open={openAsn === it.asn}>
          <button class="nav" onclick={() => showAsn(it.asn)} title="AS{it.asn}"><AsnTag asn={it.asn} /><span class="cnt">{it.n}</span></button>
          {#if it.ev}
            <button class="ev" class:on={openAsn === it.asn} onclick={() => toggle(it)} title={t('rel_evidence')} aria-label={t('rel_evidence')}><Fa icon={iAbout} /></button>
            {#if openAsn === it.asn}
              {@const e = evOf(it)}
              <div class="evpop" bind:this={pop}>
                <div class="evhead">
                  {#if it.ev.prefix}<span class="evpx">{it.ev.prefix}</span>{/if}
                  {#if e && e !== 'loading' && e.side}<span class="evside">{e.side === 'd' ? t('rel_side_down') : t('rel_side_up')}</span>{/if}
                </div>
                {#if e === 'loading' || e === undefined}
                  <span class="evload"><Fa icon={iSpinner} spin /></span>
                {:else if e}
                  <div class="evpath">
                    <span class="end">{t('ev_collector')} →</span>
                    <AsPath asns={e.path} hi={[subject, it.asn]} arrow nav />
                    <span class="end">→ {t('ev_origin')}</span>
                  </div>
                {:else}
                  <span class="evload muted">{t('none_in_db')}</span>
                {/if}
              </div>
            {/if}
          {/if}
        </span>
      {/each}
    </div>
    {#if items.length > SHOW}
      <button class="more" onclick={() => expanded = !expanded}>
        {expanded ? t('rel_collapse') : t('rel_show_all').replace('{n}', items.length.toLocaleString())}
      </button>
    {/if}
  </div>
{/if}

<style>
  .rgroup { margin: 10px 0 0; }
  .rgroup > b { color: var(--muted); font-weight: 600; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; margin-bottom: 7px; }
  .rgroup > b :global(svg) { color: var(--accent); }
  .rgroup > b .gc { font: 10px var(--mono); color: var(--muted); background: var(--line2); border-radius: 999px; padding: 0 6px; }
  .taglist { display: flex; flex-wrap: wrap; gap: 6px 8px; }
  .more { margin-top: 7px; background: transparent; border: 1px solid var(--line2); color: var(--muted); cursor: pointer; padding: 3px 10px; border-radius: 7px; font-size: 11px; }
  .more:hover { color: var(--accent); border-color: var(--accent); }
  .tag { position: relative; display: inline-flex; align-items: stretch; border: 1px solid var(--line2); border-radius: 7px; background: var(--inbg); }
  .tag.open { border-color: var(--accent); }
  .tag .nav { display: inline-flex; align-items: center; gap: 4px; background: transparent; border: 0; cursor: pointer; padding: 3px 8px; font-size: 11.5px; border-radius: 7px 0 0 7px; }
  .tag.noev .nav { border-radius: 7px; }
  .tag .nav:hover { background: var(--line2); }
  .tag .cnt { font: 10px var(--mono); color: var(--muted); background: var(--line2); border-radius: 999px; padding: 0 5px; }
  .tag .ev { display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 0; border-left: 1px solid var(--line2); cursor: pointer; padding: 0 7px; color: var(--muted); font-size: 11px; border-radius: 0 7px 7px 0; }
  .tag .ev:hover, .tag .ev.on { color: var(--accent); background: var(--accent-dim); }
  .evpop {
    position: absolute; top: calc(100% + 5px); left: 0; z-index: 20;
    width: max-content; min-width: 200px; max-width: min(420px, 84vw);
    padding: 8px 10px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 8px; box-shadow: 0 6px 22px rgba(0, 0, 0, .22);
  }
  .evload { color: var(--muted); font-size: 11.5px; display: inline-flex; padding: 2px 0; }
  .evpath { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 5px; }
  .evpath .end { font: 9.5px var(--sans); color: var(--muted); white-space: nowrap; letter-spacing: .02em; }
  .evhead { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; flex-wrap: wrap; }
  .evhead .evpx { font: 11px var(--mono); color: var(--link); }
  .evhead .evside { font-size: 10.5px; color: var(--muted); }
</style>
