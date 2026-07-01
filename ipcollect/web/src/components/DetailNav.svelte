<script>
  // 详情面板分区导航(scrollspy): 扫描 .dbody 里带 data-sec 的区块, 滚动时高亮当前区块, 点击平滑跳转。
  // 数据驱动: 区块由 prefix/asn 视图各自渲染并打 data-sec="<key>", 这里只负责映射图标/标签 + 联动。
  import Fa from 'svelte-fa'
  import { tick } from 'svelte'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { iNodes, iPrefix, iPath, iWhois, iRange, iUsers, iShield, iNet } from '../lib/icons.js'

  const ICON = { graph: iNodes, rel: iPrefix, paths: iPath, whois: iWhois, originated: iPrefix, relations: iRange, neighbors: iNodes, memberof: iUsers, irr: iShield, peeringdb: iNet }

  let root = $state()
  let secs = $state([])      // [{id, key, el}]
  let active = $state(null)
  let scroller = null

  function rescan() {
    if (!scroller) return
    const els = [...scroller.querySelectorAll('[data-sec]')]
    secs = els.map((el, i) => {
      if (!el.id) el.id = `sec-${el.dataset.sec}-${i}`
      return { id: el.id, key: el.dataset.sec, el }
    })
    onScroll()
  }
  function onScroll() {
    if (!scroller || !secs.length) return
    const y = scroller.scrollTop + 96
    let cur = secs[0].id
    for (const s of secs) { if (s.el.offsetTop <= y) cur = s.id; else break }
    active = cur
  }
  function go(s) {
    if (scroller && s.el) scroller.scrollTo({ top: Math.max(0, s.el.offsetTop - 16), behavior: 'smooth' })
  }

  $effect(() => {
    S.detailKind; S.insight; S.asnView; S.domainView    // 视图/内容变化 -> 重扫
    if (!scroller) scroller = root?.closest('.dbody')
    if (scroller && !scroller._navbound) { scroller.addEventListener('scroll', onScroll, { passive: true }); scroller._navbound = true }
    tick().then(rescan)
  })
</script>

<nav class="secnav" bind:this={root} class:empty={secs.length < 2}>
  {#each secs as s}
    <button class="sn" class:on={active === s.id} title={t('sec_' + s.key)} aria-label={t('sec_' + s.key)} onclick={() => go(s)}>
      <Fa icon={ICON[s.key] || iPrefix} />
    </button>
  {/each}
</nav>

<style>
  .secnav {
    display: inline-flex; align-items: center; gap: 2px; padding: 3px;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    border: 1px solid var(--line2); border-radius: 9px;
    backdrop-filter: blur(6px); box-shadow: 0 2px 10px rgba(0, 0, 0, .12);
  }
  .secnav.empty { display: none; }
  .sn {
    display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
    background: transparent; border: 0; border-radius: 6px; color: var(--muted); cursor: pointer;
    font-size: 11.5px; transition: all .12s;
  }
  .sn:hover { color: var(--fg); background: var(--line2); }
  .sn.on { color: var(--accent-fg); background: var(--accent); }
  /* 移动端: 分区导航移到底部居中浮动(三个按钮仍在右上角的岛里) */
  @media (max-width: 820px) {
    .secnav {
      position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 45;
      padding: 4px; gap: 3px; box-shadow: 0 4px 20px rgba(0, 0, 0, .3);
    }
    .sn { width: 34px; height: 34px; font-size: 13px; }
  }
</style>
