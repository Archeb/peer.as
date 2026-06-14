<script>
  import { truncToTier1, asnName, TIER1 } from '../lib/bgp.js'
  import { showAsn } from '../lib/queries.js'
  let { rec } = $props()
  const goKey = (e, asn) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showAsn(asn) } }

  // ── 手型拖拽平移(桌面) ──
  // PC 上原本只能拖底部滚动条, 很难用; 改成在图上按住直接左右/上下拖。
  // 触摸设备走浏览器原生滚动(pointerdown 直接 return), 不动它, 保持移动端兼容。
  let wrap = $state(null)
  let pan = null            // 拖拽中: { sx, sy, left, top, moved }
  let justPanned = false    // 刚发生过拖拽 → 吞掉随后的节点 click, 避免误触导航
  function onPanDown(e) {
    if (e.pointerType === 'touch') return            // 移动端: 原生滚动
    if (e.button !== 0) return                        // 仅左键
    justPanned = false
    // 注意: 此处**不**立刻 setPointerCapture —— 一旦捕获, 后续 click 会被重定向到 wrap,
    // 节点 <g> 的 onclick 永不触发(纯点击失效)。改为等真正拖动(越过阈值)才捕获。
    pan = { sx: e.clientX, sy: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop, moved: false, pid: e.pointerId }
  }
  function onPanMove(e) {
    if (!pan) return
    const dx = e.clientX - pan.sx, dy = e.clientY - pan.sy
    if (!pan.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      pan.moved = true
      wrap.setPointerCapture?.(pan.pid)              // 确认是拖动后才捕获, 保证拖出区域也能继续
    }
    if (!pan.moved) return                            // 阈值内: 当作点击, 不滚动也不捕获
    wrap.scrollLeft = pan.left - dx
    wrap.scrollTop = pan.top - dy
  }
  function onPanUp(e) {
    if (!pan) return
    if (pan.moved) wrap.releasePointerCapture?.(pan.pid)
    justPanned = pan.moved
    pan = null
  }
  const go = asn => { if (justPanned) return; showAsn(asn) }

  const NW = 120, NH = 34, COLG = 56, ROWG = 14, HEAD = 26
  // 距离轴标签(语言感知): 横轴 = 到 origin 的 AS 跳数; 第 0 列就是 origin。
  const distLabel = d => d === 0 ? 'origin' : `${d}`
  // 图按 raw(含 prepend)的路径算距离: 没 prepend 时 asnsRaw 为空, 回退 clean。
  const rawOf = p => (p.asnsRaw && p.asnsRaw.length) ? p.asnsRaw : p.asns
  function bezier(x1, y1, x2, y2, cls, sw) {
    const mx = ((x1 + x2) / 2).toFixed(1)
    return { d: `M${x1.toFixed(1)},${y1.toFixed(1)} C${mx},${y1.toFixed(1)} ${mx},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`, cls, sw }
  }
  const ek2 = (au, du, av, dv) => au + ':' + du + '>' + av + ':' + dv   // 边键: 上游asn:距离 > 下游asn:距离
  function compute(rec) {
    // 路由图**只画经过 Tier-1 的路径**: 有些 path 经 IXP 收来、不过 Tier-1, 否则其末端(非 Tier-1)
    // 会被并排画在 Tier-1 列, 误导。我们只关心 上游→Tier-1, 故把无 Tier-1 的路径整条剔除。
    // (注: 全部去重路径表仍展示所有路径, 只有这张图过滤。)
    const raw = (rec?.paths || []).filter(p => p.asns && p.asns.length && p.asns.some(a => TIER1.has(a)))
    if (!raw.length) return null
    // origin 高亮集: MOAS 时多个 origin 都高亮(rec.origins); 否则退化为单 origin / 路径末端。
    const originSet = new Set((rec.origins && rec.origins.length) ? rec.origins
      : [rec.origin_asn || raw[0].asns[raw[0].asns.length - 1]])
    // ── 拆框模型: 节点 = (asn, 距离), 每个单列框。同一 AS 多个距离 → 多个框(同一行)。 ──
    // prepend(同 AS 连续多份)**折叠成一个节点**(取最靠 origin 那份的距离), 被吃掉的列体现为那条上游边
    // 横跨多列 + 虚线 ×N; 而不是冒出 N 个框。
    const cellD = new Map()          // asn -> Set(距离): 该 AS(折叠 prepend 后)出现过的列
    const edgeW = new Map()          // 边键 -> Σpeers
    const edgeMeta = new Map()       // 边键 -> {au,du,av,dv,span}
    const nodeEdges = {}             // asn -> Set(边键): 经过该 AS 的所有路径的全部边(hover 用)
    const nodeCells = {}             // asn -> Set("asn:距离"): 经过该 AS 的所有路径上的全部格子(hover 虚化, 按格子而非按 ASN)
    const adj = {}                   // asn -> Set(asn): 布局排序用的无向邻接
    for (const p of raw) {
      const a = truncToTier1(rawOf(p)), n = a.length, w = p.peers || 1
      // 折叠 prepend: 从 origin(末)往上游(头)走, 距离 d 照常计入被吃的列; 同 AS 连续只建一个节点(最小 d)。
      const seq = []                                                 // origin → 上游: [{asn,d}]
      for (let i = n - 1, d = 0; i >= 0; i--, d++) { if (seq.length && seq[seq.length - 1].asn === a[i]) continue; seq.push({ asn: a[i], d }) }
      for (const s of seq) { if (!cellD.has(s.asn)) cellD.set(s.asn, new Set()); cellD.get(s.asn).add(s.d) }
      const ek = []
      for (let j = 0; j < seq.length - 1; j++) {
        const lo = seq[j], hi = seq[j + 1]                           // lo 靠 origin(小 d), hi 靠上游(大 d)
        const k = ek2(hi.asn, hi.d, lo.asn, lo.d)
        edgeW.set(k, (edgeW.get(k) || 0) + w)
        if (!edgeMeta.has(k)) edgeMeta.set(k, { au: hi.asn, du: hi.d, av: lo.asn, dv: lo.d, span: hi.d - lo.d })
        ek.push(k);
        (adj[hi.asn] = adj[hi.asn] || new Set()).add(lo.asn); (adj[lo.asn] = adj[lo.asn] || new Set()).add(hi.asn)
      }
      const pas = new Set(seq.map(s => s.asn)), pcells = seq.map(s => s.asn + ':' + s.d)
      for (const node of pas) {
        (nodeEdges[node] = nodeEdges[node] || new Set()); for (const k of ek) nodeEdges[node].add(k);
        (nodeCells[node] = nodeCells[node] || new Set()); for (const c of pcells) nodeCells[node].add(c)
      }
    }
    // 主路径 = 被最多采集点看到(peers)的那条 ⇒ 事实最偏好; 同票优先 is_best, 再取更短。accent 高亮其边。
    let bp = null
    for (const p of raw) {
      const sc = [p.peers || 0, p.is_best ? 1 : 0, -(p.asns.length)]
      if (!bp || sc[0] > bp.sc[0] || (sc[0] === bp.sc[0] && (sc[1] > bp.sc[1] || (sc[1] === bp.sc[1] && sc[2] > bp.sc[2])))) bp = { p, sc }
    }
    const mainEdges = new Set()
    if (bp) {
      const a = truncToTier1(rawOf(bp.p)), n = a.length, seq = []
      for (let i = n - 1, d = 0; i >= 0; i--, d++) { if (seq.length && seq[seq.length - 1].asn === a[i]) continue; seq.push({ asn: a[i], d }) }
      for (let j = 0; j < seq.length - 1; j++) mainEdges.add(ek2(seq[j + 1].asn, seq[j + 1].d, seq[j].asn, seq[j].d))
    }

    const asns = [...cellD.keys()]
    let maxD = 0; for (const s of cellD.values()) for (const d of s) if (d > maxD) maxD = d
    const rowP = NH + ROWG, colP = NW + COLG
    const cx = col => COLG + col * colP + NW / 2
    const mean = ar => ar.reduce((s, v) => s + v, 0) / ar.length
    // ── 布局(两步): ① 连续重心法得到大致 y(每列在整高内居中, 越靠 origin 的稀疏列越贴中线);
    //    ② 量化到整行网格 ⇒ 大框各列严格对齐、不再错位。 ──
    const colMembers = {}
    for (const asn of asns) for (const d of cellD.get(asn)) (colMembers[d] = colMembers[d] || []).push(asn)
    let maxCount = 1; for (const d in colMembers) maxCount = Math.max(maxCount, colMembers[d].length)
    const mid = HEAD + ROWG / 2 + maxCount * rowP / 2
    const Y = {}; for (const a of asns) Y[a] = mid                    // 初始全堆中线, 再迭代散开
    for (let it = 0; it < 20; it++) {
      const prop = {}
      for (const d in colMembers) {
        const L = colMembers[d].slice().sort((a, b) => (Y[a] - Y[b]) || (a - b))
        const y0 = HEAD + ROWG / 2 + (maxCount - L.length) * rowP / 2   // 该列在整高内居中
        L.forEach((a, j) => { const yy = y0 + j * rowP + NH / 2; (prop[a] = prop[a] || []).push(yy) })
      }
      for (const a of asns) Y[a] = mean(prop[a])
    }
    // ② 量化到整行网格(R = 最密列节点数行)。每列成员按 y 放进各自"居中块";
    //    跨距离 AS 先在它最稀疏(块最小、最居中)的列定行, 到更密的列沿用同一行 ⇒ 各列同一行、严格对齐。
    const start = {}; for (const d in colMembers) start[d] = Math.round((maxCount - colMembers[d].length) / 2)
    const rowOf = {}
    const colsByDensity = Object.keys(colMembers).map(Number).sort((a, b) => colMembers[a].length - colMembers[b].length)
    for (const d of colsByDensity) {
      const members = colMembers[d].slice().sort((a, b) => (Y[a] - Y[b]) || (a - b))
      const taken = new Set(); for (const a of members) if (rowOf[a] != null) taken.add(rowOf[a])
      let ptr = start[d]
      for (const a of members) { if (rowOf[a] != null) continue; while (taken.has(ptr)) ptr++; rowOf[a] = ptr; taken.add(ptr); ptr++ }
    }
    let maxRow = 0; for (const a of asns) maxRow = Math.max(maxRow, rowOf[a])
    for (const a of asns) Y[a] = HEAD + ROWG / 2 + rowOf[a] * rowP + NH / 2
    const W = (maxD + 1) * colP + COLG, H = HEAD + ROWG + (maxRow + 1) * rowP
    // ── 框: 每个 (asn, 距离) 各画一个单列框。同一 AS 的各列因共享一行(Y[asn]) 而天然落在同一行。 ──
    const boxes = [], cellY = Y
    for (const asn of asns) {
      const y = Y[asn], origin = originSet.has(asn), t1 = TIER1.has(asn), name = asnName(asn)
      for (const d of cellD.get(asn)) boxes.push({ asn, ck: asn + ':' + d, x: cx(d), y, origin, t1, name })
    }
    // ── 边: 接在格子两侧(上游出左侧、下游进右侧)。一般跨 1 列; prepend 折叠后那条上游边跨多列 ⇒ 虚线 ×span。 ──
    const edges = []
    for (const [k, wt] of edgeW) {
      const m = edgeMeta.get(k), yu = cellY[m.au], yv = cellY[m.av]
      if (yu == null || yv == null) continue
      const sw = Math.min(4.5, 1 + Math.log2(wt + 1) / 2)
      const x1 = cx(m.du) - NW / 2, x2 = cx(m.dv) + NW / 2
      const e = bezier(x1, yu, x2, yv, mainEdges.has(k) ? 'gmain' : 'gedge', sw)
      e.key = k; e.w = wt; e.pre = m.span >= 2; e.rep = m.span; e.mx = (x1 + x2) / 2; e.my = (yu + yv) / 2
      edges.push(e)
    }
    edges.sort((p, q) => (p.cls === 'gmain' ? 1 : 0) - (q.cls === 'gmain' ? 1 : 0))   // 主路径后画 ⇒ 压在上层
    // 顶部距离轴: 每列一条淡竖线 + 跳数标签
    const axis = []
    for (let d = 0; d <= maxD; d++) axis.push({ x: cx(d), label: distLabel(d) })
    return { W, H, edges, boxes, axis, nodeEdges, nodeCells }
  }
  let g = $derived(compute(rec))
  // hover/focus 某节点 → 高亮"到这个 node 的所有可达线路", 并在每条边中点显示其 peer 权重。
  let hovered = $state(null)
  let hoverSet = $derived(hovered != null && g ? g.nodeEdges[hovered] : null)
  let hoverCells = $derived(hovered != null && g ? g.nodeCells[hovered] : null)
</script>

{#if g}
  {#snippet edge(e, dim, hi)}
    <g class:gdim={dim}>
      <path d={e.d} class={e.cls} class:gpre={e.pre} class:ghi={hi} stroke-width={e.sw} fill="none" />
      {#if e.pre}<text class="gprelbl" x={e.mx} y={e.my - 5}>×{e.rep}</text>{/if}
    </g>
  {/snippet}
  {#snippet node(b, dim, hot)}
    <g class="gnode nav" class:origin={b.origin} class:tier1={b.t1} class:hilite={hot} class:gdimnode={dim}
      role="button" tabindex="0" aria-label="AS{b.asn}"
      onclick={() => go(b.asn)} onkeydown={(ev) => goKey(ev, b.asn)}
      onmouseenter={() => hovered = b.asn} onmouseleave={() => { if (hovered === b.asn) hovered = null }}
      onfocus={() => hovered = b.asn} onblur={() => { if (hovered === b.asn) hovered = null }}>
      <rect x={b.x - NW / 2} y={b.y - NH / 2} width={NW} height={NH} rx="5" />
      <text x={b.x} y={b.y - 3} class="gas">AS{b.asn}{b.t1 ? ' ★' : ''}</text>
      {#if b.name}<text x={b.x} y={b.y + 10} class="gnm">{b.name.slice(0, 15)}</text>{/if}
    </g>
  {/snippet}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="graphwrap" class:grabbing={!!pan} bind:this={wrap}
       onpointerdown={onPanDown} onpointermove={onPanMove} onpointerup={onPanUp} onpointercancel={onPanUp}>
    <svg viewBox="0 0 {g.W} {g.H}" width={g.W} height={g.H} class="pathsvg" class:hovering={!!hoverSet}>
      <!-- 距离轴: 每列一条淡竖线 + 到 origin 的跳数标签 -->
      {#each g.axis as ax}
        <line class="gaxis" x1={ax.x} y1="18" x2={ax.x} y2={g.H} />
        <text class="gaxlbl" x={ax.x} y="12">{ax.label}</text>
      {/each}
      {#if hoverSet}
        <!-- hover 分层重绘: 虚化边/节点(底) → 高亮边(中) → 权重 → 路径节点 → 当前节点(顶), 防遮挡 -->
        {#each g.edges as e}{#if !hoverSet.has(e.key)}{@render edge(e, true, false)}{/if}{/each}
        {#each g.boxes as b}{#if !hoverCells?.has(b.ck)}{@render node(b, true, false)}{/if}{/each}
        {#each g.edges as e}{#if hoverSet.has(e.key)}{@render edge(e, false, true)}{/if}{/each}
        {#each g.boxes as b}{#if hoverCells?.has(b.ck) && hovered !== b.asn}{@render node(b, false, false)}{/if}{/each}
        {#each g.boxes as b}{#if hovered === b.asn}{@render node(b, false, true)}{/if}{/each}
      {:else}
        {#each g.edges as e}{@render edge(e, false, false)}{/each}
        {#each g.boxes as b}{@render node(b, false, false)}{/each}
      {/if}
    </svg>
  </div>
{/if}

<style>
  .graphwrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--alt); padding: 6px; cursor: grab; }
  .graphwrap.grabbing { cursor: grabbing; user-select: none; }
  .pathsvg { display: block; max-width: none; }
  :global(.gedge) { stroke: var(--muted); opacity: .4; fill: none; }
  :global(.gmain) { stroke: var(--accent); opacity: .85; }
  /* prepend 折叠后那条跨多列的上游边: 虚线提示"中间被 prepend 撑长" */
  :global(.gpre) { stroke-dasharray: 5 4; }
  .gprelbl { font: 700 10px var(--mono); fill: var(--muted); text-anchor: middle; }
  /* hover 高亮: 命中的可达线路加粗加深, 其余淡出 */
  :global(.ghi) { stroke: var(--accent); opacity: .95; }
  :global(.gdim) { opacity: .08; }
  /* hover 时路径外的节点整体虚化 */
  .gnode.gdimnode { opacity: .12; }
  /* 距离轴 */
  .gaxis { stroke: var(--line); stroke-width: 1; opacity: .5; }
  .gaxlbl { font: 10px var(--mono); fill: var(--muted); text-anchor: middle; }
  /* 统一着色: 非 Tier-1 一律中性色, 仅 Tier-1(下方覆盖)与 origin 上色 */
  .gnode rect { fill: var(--bg); stroke: var(--muted); stroke-width: 1.4; }
  .gnode.nav { cursor: pointer; }
  .gnode.nav:hover rect { stroke: var(--accent); stroke-width: 2.2; }
  .gnode.nav:focus-visible { outline: none; }
  .gnode.nav:focus-visible rect { stroke: var(--accent); stroke-width: 2.6; }
  .gnode :global(.gas) { font: 700 11px var(--mono); fill: var(--fg); text-anchor: middle; dominant-baseline: middle; }
  .gnode :global(.gnm) { font: 10px var(--sans); fill: var(--muted); text-anchor: middle; }
  .gnode.tier1 rect { stroke: var(--signal); stroke-width: 2.6; }
  .gnode.tier1 :global(.gas) { fill: var(--signal); }
  .gnode.origin rect { fill: color-mix(in srgb, var(--accent) 14%, var(--bg)); stroke: var(--accent); stroke-width: 2; }
  .gnode.hilite rect { stroke: var(--accent); stroke-width: 2.6; }
</style>
