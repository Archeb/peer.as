<script>
  // 可复用搜索建议下拉: 空态列最近搜索(localStorage), 输入时给出分组建议 ——
  //   直达(ASN / 前缀 / 域名 / as-set) · 自治系统(AS 名反查) · 交换中心(IX 名/城市)。
  // 由 SearchBox(顶栏)与 WhoisView(首页命令行)共用。宿主负责输入框本身 + focus/blur 切 open;
  // 本组件负责建议计算 + 渲染 .drop + 键盘导航(宿主把输入框 onkeydown 转发到导出的 keydown())。
  import { untrack } from 'svelte'
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { classifyQuery, asnsMatchingName, asnName, opText, opCls, ccLabel } from '../lib/bgp.js'
  import { openIxpBrowser, loadIxpList } from '../lib/queries.js'
  import { features } from '../lib/site.js'
  import { iSubnet, iSearch, iClose, iClock, iOrigin, iNet, iGlobal, iUsers } from '../lib/icons.js'

  let { value = $bindable(''), open = $bindable(false), onenter = () => {}, variant = 'field' } = $props()

  let hi = $state(-1)
  const fmt = n => Number(n || 0).toLocaleString()
  const GLABEL = { jump: () => t('sb_g_jump'), as: () => t('sb_g_as'), ix: () => t('sb_g_ix') }
  const TYPE_ICON = { asn: iOrigin, prefix: iSubnet, domain: iGlobal, asset: iUsers, ixp: iNet, name: iSearch, hist: iClock }

  // ── 最近搜索(localStorage)──
  // 历史项存**结构化对象** { q(展示+去重键), type, term?/ix_id? }, 这样重选能复现原跳转
  // (IX 回 IX 浏览器, 而非把 IX 名当 ASN 名搜)。兼容旧版纯字符串历史(视作 name 搜索)。
  const HKEY = 'ipc-search-history'
  function loadHist() {
    try {
      return JSON.parse(localStorage.getItem(HKEY) || '[]')
        .map(e => (typeof e === 'string' ? { q: e, type: 'name', term: e } : e))
        .filter(e => e && e.q)
    } catch { return [] }
  }
  let history = $state(loadHist())
  function saveHist() { try { localStorage.setItem(HKEY, JSON.stringify(history.slice(0, 12))) } catch { /* 隐私模式忽略 */ } }
  function addHist(entry) { if (!entry || !entry.q) return; history = [entry, ...history.filter(x => x.q !== entry.q)].slice(0, 12); saveHist() }
  function removeHist(qk) { history = history.filter(x => x.q !== qk); saveHist() }
  function clearHist() { history = [] ; saveHist() }
  // 由一条建议构造历史项(记录跳转后的对象; 「按名称搜索」兜底才记搜索词)。
  function toEntry(it) {
    if (it.type === 'ixp') return { q: it.label, type: 'ixp', ix_id: it.ix_id }
    if (it.type === 'name') return { q: it.term, type: 'name', term: it.term }
    return { q: it.term ?? it.label, type: it.type, term: it.term ?? it.label }
  }
  // 按历史项类型复现导航: IX 走 IX 浏览器; 其余填框走既有搜索/跳转流程(ASN/前缀/域名/as-set/名称)。
  function dispatch(entry) {
    if (entry.type === 'ixp') { openIxpBrowser(entry.ix_id); return }
    value = entry.term ?? entry.q
    onenter()
  }

  const MINQ = 2   // 少于此长度不做名称/IX 扫描(避免「一个字母就开查」)

  let q = $derived(value.trim())
  let probe = $derived(classifyQuery(q))
  let ixRows = $derived(S.ixp?.rows || [])
  // IX 检索串(name/aka/city/country)预先小写化一次, 仅在列表变动时重建 —— 免每次按键重拼字符串。
  let ixHay = $derived(ixRows.map(r => `${r.name} ${r.aka || ''} ${r.name_long || ''} ${r.city || ''} ${r.country || ''}`.toLowerCase()))

  // 下拉打开时预热 IX 列表(供顶栏建议 + 空态)。仅依赖 open —— ensureIx 内部读/写 S.ixp,
  // 必须 untrack, 否则 loadIxpList 改 S.ixp 会回灌本 effect 造成无限循环(effect_update_depth_exceeded)。
  $effect(() => { if (open) untrack(() => ensureIx()) })
  // 输入变化时复位高亮。
  $effect(() => { value; hi = -1 })

  // AS 名反查开销大(全表 indexOf 扫描 + 排序), 单独 debounce + 异步计算, 不在渲染/按键路径同步跑。
  let asMatches = $state([])
  let asTok = 0
  $effect(() => {
    const cur = q
    if (!open || cur.length < MINQ || !/[a-z]/i.test(cur)) { asMatches = []; return }
    const my = ++asTok
    const timer = setTimeout(() => {
      if (my !== asTok) return
      const { asns } = asnsMatchingName(cur, 6)
      if (my !== asTok) return
      asMatches = asns.map(a => ({ group: 'as', type: 'asn', asn: a, term: 'AS' + a, label: asnName(a) || ('AS' + a), sub: 'AS' + a, op: opText(a), cls: opCls(a) }))
    }, 180)
    return () => clearTimeout(timer)
  })

  // 扁平建议列表(键盘 + 渲染共用同一序)。直达 + IX 过滤便宜(即时); AS 名走上面 debounce 后的 asMatches。
  let flat = $derived.by(() => {
    if (!q) return history.map(h => ({ group: 'hist', type: 'hist', entry: h, label: h.q }))
    const out = []
    // 1) 直达: 精确类型(便宜且精确, 不受最小长度限制 —— 如单数字 ASN)
    if (probe.kind === 'asn') out.push({ group: 'jump', type: 'asn', asn: probe.asn, term: 'AS' + probe.asn, label: 'AS' + probe.asn, sub: asnName(probe.asn), op: opText(probe.asn), cls: opCls(probe.asn) })
    else if (probe.kind === 'ipv4' || probe.kind === 'ipv6') out.push({ group: 'jump', type: 'prefix', term: q, label: q, sub: t('sb_open_prefix') })
    else if (probe.kind === 'domain') out.push({ group: 'jump', type: 'domain', term: probe.domain, label: probe.domain, sub: 'DNS' })
    else if (probe.kind === 'asset') out.push({ group: 'jump', type: 'asset', term: probe.key, label: probe.key, sub: 'as-set' })
    if (q.length < MINQ) return out   // 单字符只给便宜的直达, 不扫名称/IX
    // 2) 自治系统: AS 名反查(debounce 结果)
    out.push(...asMatches)
    // 3) 交换中心: IX 名 / 城市 / 国家(用预建的小写检索串)
    if (ixRows.length) {
      const ql = q.toLowerCase()
      let n = 0
      for (let i = 0; i < ixRows.length && n < 6; i++) {
        if (!ixHay[i].includes(ql)) continue
        const r = ixRows[i]
        out.push({ group: 'ix', type: 'ixp', ix_id: r.ix_id, label: r.name, sub: [r.city, r.country && ccLabel(r.country)].filter(Boolean).join(' · '), count: r.net_count }); n++
      }
    }
    // 4) 兜底: 按名称搜索(交给现有搜索流程做 origin 反查)
    if (probe.kind === 'name' || probe.kind === 'text') out.push({ group: 'name', type: 'name', term: q, label: t('sb_search_name').replace('{q}', q) })
    return out
  })

  function ensureIx() {
    if (features.peeringdb && S.ready && !(S.ixp?.rows?.length)) loadIxpList()
  }
  function pick(it) {
    // 历史记录的是「跳转后的对象」而非搜索词(结构化, 见 toEntry): 重选历史项按其类型复现导航。
    const entry = it.type === 'hist' ? it.entry : toEntry(it)
    addHist(entry)
    open = false; hi = -1
    dispatch(entry)
  }
  // 未选中项时提交: 记搜索词 + 触发宿主 onenter。
  function submitPlain() {
    const v = value.trim()
    if (v) addHist({ q: v, type: 'name', term: v })
    open = false; hi = -1
    onenter()
  }
  // 宿主把输入框 onkeydown 转发到这里(↑↓ 选择, Enter 选中/提交, Esc 收起)。
  export function keydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); if (open && hi >= 0 && flat[hi]) pick(flat[hi]); else submitPlain(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); open = true; hi = Math.min(hi + 1, flat.length - 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(hi - 1, -1) }
    else if (e.key === 'Escape') { open = false; hi = -1 }
  }
  const showHdr = (it, i) => GLABEL[it.group] && (i === 0 || flat[i - 1].group !== it.group)
</script>

{#if open}
  <div class="drop {variant}" id="sb-drop" role="listbox">
    {#if !q}
      <div class="drophd"><span>{t('sb_recent')}</span>{#if history.length}<button type="button" class="hclr" onmousedown={(e) => { e.preventDefault(); clearHist() }}>{t('sb_recent_clear')}</button>{/if}</div>
      {#if !history.length}
        <div class="dropempty">{t('sb_no_recent')}</div>
      {:else}
        {#each flat as it, i (it.entry.q)}
          <div class="ditem hist" class:hl={hi === i} role="option" tabindex="-1" aria-selected={hi === i} onmouseenter={() => (hi = i)}>
            <button type="button" class="dmain" onmousedown={(e) => { e.preventDefault(); pick(it) }}>
              <span class="dt"><Fa icon={TYPE_ICON[it.entry.type] || iClock} /></span><span class="dl">{it.label}</span>
            </button>
            <button type="button" class="drm" onmousedown={(e) => { e.preventDefault(); removeHist(it.entry.q) }} aria-label={t('clear')}><Fa icon={iClose} /></button>
          </div>
        {/each}
      {/if}
    {:else if flat.length}
      {#each flat as it, i (it.group + ':' + (it.term || it.ix_id) + ':' + i)}
        {#if showHdr(it, i)}<div class="dgrp">{GLABEL[it.group]()}</div>{/if}
        <button type="button" class="ditem" class:hl={hi === i} role="option" tabindex="-1" aria-selected={hi === i}
          onmouseenter={() => (hi = i)} onmousedown={(e) => { e.preventDefault(); pick(it) }}>
          <span class="dt"><Fa icon={TYPE_ICON[it.type]} /></span>
          <span class="dl">{it.label}</span>
          {#if it.sub}<span class="ds" class:geo={it.type === 'ixp'}>{it.sub}</span>{/if}
          {#if it.type === 'ixp'}<span class="dm"><Fa icon={iUsers} /> {fmt(it.count)}</span>
          {:else if it.op}<span class="badge {it.cls || 'b-mute'} dop">{it.op}</span>{/if}
        </button>
      {/each}
    {:else}
      <div class="dropempty">{q.length < MINQ ? t('sb_more') : t('sb_none')}</div>
    {/if}
  </div>
{/if}

<style>
  .drop {
    position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 40;
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    box-shadow: 0 12px 34px -10px rgba(0, 0, 0, .4); padding: 5px;
    max-height: min(58vh, 440px); overflow: auto;
  }
  /* 命令行变体(WhoisView): 拉开一点间距 + 更大圆角, 与大查询框协调 */
  .drop.console { top: calc(100% + 8px); border-radius: 12px; }
  .drophd { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 8px 6px; color: var(--muted); font: 700 9.5px var(--sans); letter-spacing: .09em; text-transform: uppercase; }
  .hclr { background: transparent; border: 0; color: var(--link); cursor: pointer; font: 600 10px var(--sans); text-transform: none; letter-spacing: 0; padding: 0; }
  .hclr:hover { color: var(--accent); }
  .dropempty { padding: 12px 8px; color: var(--muted); font-size: 12px; }
  .dgrp { padding: 8px 8px 4px; color: var(--muted); font: 700 9px var(--sans); letter-spacing: .1em; text-transform: uppercase; }

  .ditem {
    display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
    background: transparent; border: 0; border-radius: 7px; cursor: pointer;
    padding: 7px 8px; color: var(--fg);
  }
  .ditem.hl, .ditem.hist.hl { background: var(--rowhover); }
  .ditem .dt { flex: 0 0 auto; display: inline-flex; color: var(--muted); width: 13px; justify-content: center; }
  .ditem.hl .dt { color: var(--accent); }
  .ditem .dl { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 12.5px var(--sans); }
  .ditem .ds { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font: 11px var(--mono); }
  .ditem .dm { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font: 600 10.5px var(--mono); }
  .ditem .dm :global(svg) { width: 10px; }
  .ditem .dop { flex: 0 0 auto; }

  /* 历史行: 主按钮 + 删除钮 两段 */
  .ditem.hist { padding: 0; gap: 0; }
  .ditem.hist .dmain { display: flex; align-items: center; gap: 9px; flex: 1 1 auto; min-width: 0; background: transparent; border: 0; cursor: pointer; color: var(--fg); padding: 7px 8px; text-align: left; }
  .ditem.hist .dmain .dl { font-weight: 500; }
  .ditem.hist .drm { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 26px; align-self: stretch; background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 10px; border-radius: 0 7px 7px 0; }
  .ditem.hist .drm:hover { color: #ef4444; background: color-mix(in srgb, #ef4444 8%, transparent); }

  @media (max-width: 820px) {
    /* 窄屏: 隐藏 IX 建议的地理位置(城市·国家), 让交换中心名称完整显示 */
    .ditem .ds.geo { display: none; }
  }
</style>
