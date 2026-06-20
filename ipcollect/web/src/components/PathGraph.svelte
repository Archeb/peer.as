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
  // ── 点击选中模式 ──
  // 第一次点击节点 → 进入选中(高亮像 hover 一样保持); 再点同一节点 → 跳转该 ASN;
  // 点击空白处 → 退出选中。选中态下仍可拖拽平移看长路由(justPanned 吞掉拖拽尾随的 click)。
  function onNodeClick(ev, asn) {
    ev.stopPropagation()                       // 阻止冒泡到背景, 否则会被 onBgClick 立刻清掉
    if (justPanned) return                      // 刚拖完: 不当作点击
    if (selected === asn) { showAsn(asn); return }
    selected = asn
  }
  function onBgClick() { if (justPanned) return; selected = null }

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
        ek.push(k)
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
    // ── 布局(两步): ① 树序布局定每个 AS 的理想上下顺序; ② 量化到整行网格并居中。 ──
    // 这张图从 origin 向上游基本是一棵树(每个 AS 沿路径只有一个朝 origin 的下游, 可有多个上游)。
    // 按树做 DFS: 叶子顺次排号, 父节点取子节点序号均值 ⇒ 父子天然对齐、同父的子连续 ⇒ 跨列连线不交叉;
    // 兄弟里把"子树更大"的排到中间 ⇒ 主干(如 Tier-1)居中, 细碎叶子分到上下两端。
    // (旧重心法会被大量"只连同一个父"的叶子拽向中线, 反把分叉主干挤到上下端, 大量交叉。)
    const colMembers = {}
    for (const asn of asns) for (const d of cellD.get(asn)) (colMembers[d] = colMembers[d] || []).push(asn)
    let maxCount = 1; for (const d in colMembers) maxCount = Math.max(maxCount, colMembers[d].length)
    const childrenOf = {}     // 下游(小d) -> Set 上游(大d): 朝上游展开的树/DAG
    for (const m of edgeMeta.values()) (childrenOf[m.av] = childrenOf[m.av] || new Set()).add(m.au)
    // 子树叶子数(兄弟排序用): 越大越往中间放
    const size = {}
    const sz = a => {
      if (size[a] != null) return size[a]
      size[a] = 1                                   // 先占位防环
      const ch = childrenOf[a]; if (!ch || !ch.size) return size[a] = 1
      let s = 0; for (const k of ch) s += sz(k); return size[a] = s || 1
    }
    for (const a of asns) sz(a)
    let roots = asns.filter(a => originSet.has(a))
    if (!roots.length) { let md = Infinity, r = asns[0]; for (const a of asns) { const dm = Math.min(...cellD.get(a)); if (dm < md) { md = dm; r = a } } roots = [r] }
    const ord = {}, seen = new Set(); let cnt = 0
    const dfs = a => {
      if (seen.has(a)) return ord[a]
      seen.add(a)
      const all = childrenOf[a] ? [...childrenOf[a]] : []
      if (!all.length) return ord[a] = cnt++
      // 兄弟按子树大小降序, 再"大的居中"交替展开 ⇒ 主干在中、碎叶在缘
      const byBig = all.filter(k => !seen.has(k)).sort((x, y) => (size[y] - size[x]) || (x - y))
      const centered = []
      byBig.forEach((k, i) => i % 2 ? centered.push(k) : centered.unshift(k))
      const vs = []
      for (const k of centered) vs.push(dfs(k))
      for (const k of all) if (ord[k] != null && !centered.includes(k)) vs.push(ord[k])   // DAG 已访问子也计入对齐
      return ord[a] = vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : cnt++
    }
    for (const r of roots) dfs(r)
    const Y = {}; for (const a of asns) Y[a] = ord[a] != null ? ord[a] : cnt++   // 兜底: 不连通残余 → 顺次排尾
    // ② 量化到整行网格(R = 最密列节点数行)。每列成员按 y 放进各自"居中块";
    //    跨距离 AS 先在它最稀疏(块最小、最居中)的列定行, 到更密的列沿用同一行 ⇒ 各列同一行、严格对齐。
    const start = {}; for (const d in colMembers) start[d] = Math.round((maxCount - colMembers[d].length) / 2)
    const rowOf = {}
    const colsByDensity = Object.keys(colMembers).map(Number).sort((a, b) => colMembers[a].length - colMembers[b].length)
    for (const d of colsByDensity) {
      const members = colMembers[d].slice().sort((a, b) => (Y[a] - Y[b]) || (a - b))
      const taken = new Set(); for (const a of members) if (rowOf[a] != null) taken.add(rowOf[a])
      let ptr = start[d]
      // 已定行的成员(来自更稀疏的列)保持原行, 但把 ptr 推到其后 ⇒ 后续(y 更大的)新成员落在它下方, 保持 y 单调、不互相穿插。
      for (const a of members) {
        if (rowOf[a] != null) { ptr = Math.max(ptr, rowOf[a] + 1); continue }
        while (taken.has(ptr)) ptr++; rowOf[a] = ptr; taken.add(ptr); ptr++
      }
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
  // 选中(点击)优先于 hover: 一旦选中, hover 不再改变高亮, 直到点空白处退出。
  let hovered = $state(null)
  let selected = $state(null)
  let active = $derived(selected != null ? selected : hovered)
  let hoverSet = $derived(active != null && g ? g.nodeEdges[active] : null)
  let hoverCells = $derived(active != null && g ? g.nodeCells[active] : null)
</script>

{#if g}
  {#snippet edge(e, dim, hi)}
    <g class:gdim={dim}>
      <path d={e.d} class={e.cls} class:gpre={e.pre} class:ghi={hi} stroke-width={e.sw} fill="none" />
      {#if e.pre}<text class="gprelbl" x={e.mx} y={e.my - 5}>×{e.rep}</text>{/if}
    </g>
  {/snippet}
  {#snippet node(b, dim, hot)}
    <g class="gnode nav" class:origin={b.origin} class:tier1={b.t1} class:hilite={hot} class:armed={selected === b.asn} class:gdimnode={dim}
      role="button" tabindex="0" aria-label="AS{b.asn}"
      onclick={(ev) => onNodeClick(ev, b.asn)} onkeydown={(ev) => goKey(ev, b.asn)}
      onmouseenter={() => hovered = b.asn} onmouseleave={() => { if (hovered === b.asn) hovered = null }}
      onfocus={() => hovered = b.asn} onblur={() => { if (hovered === b.asn) hovered = null }}>
      <rect x={b.x - NW / 2} y={b.y - NH / 2} width={NW} height={NH} rx="5" />
      <text x={b.x} y={b.y - 3} class="gas">AS{b.asn}{b.t1 ? ' ★' : ''}</text>
      {#if b.name}<text x={b.x} y={b.y + 10} class="gnm">{b.name.slice(0, 15)}</text>{/if}
    </g>
  {/snippet}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="graphwrap" class:grabbing={!!pan} bind:this={wrap} onclick={onBgClick}
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
        {#each g.boxes as b}{#if hoverCells?.has(b.ck) && active !== b.asn}{@render node(b, false, false)}{/if}{/each}
        {#each g.boxes as b}{#if active === b.asn}{@render node(b, false, true)}{/if}{/each}
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
  .gnode.nav:focus { outline: none; }
  .gnode.nav:focus-visible { outline: none; }
  .gnode.nav:focus-visible rect { stroke: var(--accent); stroke-width: 2.6; }
  .gnode :global(.gas) { font: 700 11px var(--mono); fill: var(--fg); text-anchor: middle; dominant-baseline: middle; }
  .gnode :global(.gnm) { font: 10px var(--sans); fill: var(--muted); text-anchor: middle; }
  .gnode.tier1 rect { stroke: var(--signal); stroke-width: 2.6; }
  .gnode.tier1 :global(.gas) { fill: var(--signal); }
  .gnode.origin rect { fill: color-mix(in srgb, var(--accent) 14%, var(--bg)); stroke: var(--accent); stroke-width: 2; }
  .gnode.hilite rect { stroke: var(--accent); stroke-width: 2.6; }
  /* armed = 已选中, 再点一次即跳转: 实心强调 + 虚线描边提示"待跳转" */
  .gnode.armed rect { fill: color-mix(in srgb, var(--accent) 22%, var(--bg)); stroke: var(--accent); stroke-width: 3; stroke-dasharray: 4 3; }
</style>
