<script>
  import { truncToTier1, asnName, TIER1 } from '../lib/bgp.js'
  import { showAsn } from '../lib/queries.js'
  import { S } from '../lib/store.svelte.js'
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
  const distLabel = d => d === 0 ? 'origin' : (S.lang === 'zh' ? `${d} 跳` : `${d} hop${d > 1 ? 's' : ''}`)
  // 图按 raw(含 prepend)的路径算距离: 没 prepend 时 asnsRaw 为空, 回退 clean。
  const rawOf = p => (p.asnsRaw && p.asnsRaw.length) ? p.asnsRaw : p.asns
  function bezier(x1, y1, x2, y2, cls, sw) {
    const mx = ((x1 + x2) / 2).toFixed(1)
    return { d: `M${x1.toFixed(1)},${y1.toFixed(1)} C${mx},${y1.toFixed(1)} ${mx},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`, cls, sw }
  }
  function compute(rec) {
    // 路由图**只画经过 Tier-1 的路径**: 有些 path 经 IXP 收来、不过 Tier-1, 否则其末端(非 Tier-1)
    // 会被并排画在 Tier-1 列, 误导。我们只关心 上游→Tier-1, 故把无 Tier-1 的路径整条剔除。
    // (注: 全部去重路径表仍展示所有路径, 只有这张图过滤。)
    const raw = (rec?.paths || []).filter(p => p.asns && p.asns.length && p.asns.some(a => TIER1.has(a)))
    if (!raw.length) return null
    // origin 高亮集: MOAS 时多个 origin 都高亮(rec.origins); 否则退化为单 origin / 路径末端。
    const originSet = new Set((rec.origins && rec.origins.length) ? rec.origins
      : [rec.origin_asn || raw[0].asns[raw[0].asns.length - 1]])
    const depth = {}, edgeW = {}, nodes = new Set(), nodeEdges = {}
    for (const p of raw) {
      const a = truncToTier1(rawOf(p)), n = a.length, w = p.peers || 1
      // 距离从 origin(数组末)倒着累加: prepend 的重复拷贝**也吃一格距离**(d 照常++),
      // 但同一个 AS 只建一个节点、取最小距离 ⇒ 被 prepend 的那条上游边自然横跨多列、画得更长。
      for (let i = n - 1, d = 0; i >= 0; i--, d++) { nodes.add(a[i]); if (depth[a[i]] == null || d < depth[a[i]]) depth[a[i]] = d }
      const ek = []
      for (let i = 0; i < n - 1; i++) { const x = a[i], y = a[i + 1]; if (x === y) continue; const k = x + '>' + y; edgeW[k] = (edgeW[k] || 0) + w; ek.push(k) }
      // hover 用: 经过该节点的所有路径上的全部边 ⇒ "到这个 node 的所有可达线路"。
      for (const node of new Set(a)) { (nodeEdges[node] = nodeEdges[node] || new Set()); for (const k of ek) nodeEdges[node].add(k) }
    }
    // 主路径 = 被最多采集点看到(peers)的那条 ⇒ 事实上最被偏好; 同票优先 is_best, 再取更短。
    // 收集它的边集用于高亮(accent 色), 让"哪条路更被 prefer"一眼可见。
    let bp = null
    for (const p of raw) {
      const sc = [p.peers || 0, p.is_best ? 1 : 0, -(p.asns.length)]
      if (!bp || sc[0] > bp.sc[0] || (sc[0] === bp.sc[0] && (sc[1] > bp.sc[1] || (sc[1] === bp.sc[1] && sc[2] > bp.sc[2])))) bp = { p, sc }
    }
    const mainEdges = new Set()
    if (bp) { const a = truncToTier1(rawOf(bp.p)); for (let i = 0; i < a.length - 1; i++) if (a[i] !== a[i + 1]) mainEdges.add(a[i] + '>' + a[i + 1]) }
    const arr = [...nodes], maxD = Math.max(0, ...arr.map(x => depth[x])), layers = {}
    arr.forEach(x => { (layers[depth[x]] = layers[depth[x]] || []).push(x) })
    // 列内排序: 先按 ASN 定序, 再用重心法(barycenter)上下来回扫 —— 每个节点排到其相邻列邻居的平均
    // 纵向位置上, 显著减少连线交叉(Sugiyama 层序的经典启发式)。
    const depths = Object.keys(layers).map(Number).sort((a, b) => a - b)
    Object.values(layers).forEach(l => l.sort((p, q) => p - q))
    const nbr = {}
    for (const k in edgeW) { const [a, b] = k.split('>').map(Number); (nbr[a] = nbr[a] || []).push(b); (nbr[b] = nbr[b] || []).push(a) }
    const idx = {}, reindex = () => { for (const d of depths) layers[d].forEach((a, i) => { idx[a] = i }) }
    reindex()
    const orderBy = (d, rd) => {            // 把 d 列按其在 rd 列邻居的平均位置排序
      const bc = {}
      for (const a of layers[d]) {
        const ns = (nbr[a] || []).filter(x => depth[x] === rd)
        bc[a] = ns.length ? ns.reduce((s, x) => s + idx[x], 0) / ns.length : idx[a]
      }
      layers[d].sort((p, q) => (bc[p] - bc[q]) || (idx[p] - idx[q]))   // 重心相等保持稳定
      reindex()
    }
    for (let it = 0; it < 4; it++) {
      for (let i = 1; i < depths.length; i++) orderBy(depths[i], depths[i - 1])       // 下行: 参照更靠 origin 的左列
      for (let i = depths.length - 2; i >= 0; i--) orderBy(depths[i], depths[i + 1])  // 上行: 参照更靠 Tier-1 的右列
    }
    const rowP = NH + ROWG, colP = NW + COLG
    const maxRows = Math.max(1, ...Object.values(layers).map(l => l.length))
    // 不再画 prefix 节点: origin(depth0) 直接放在第 0 列, 图就是 origin -> 上游 -> Tier-1。
    // HEAD 留给顶部距离轴; 内容整体下移 HEAD。
    const cols = maxD + 1, W = cols * colP + COLG, contentH = Math.max(maxRows, 1) * rowP + ROWG, H = contentH + HEAD
    const cx = col => COLG + col * colP + NW / 2, pos = {}
    for (const d in layers) { const l = layers[d], y0 = HEAD + (contentH - l.length * rowP) / 2, x = cx(+d); l.forEach((asn, j) => { pos[asn] = { x, y: y0 + j * rowP + NH / 2 } }) }
    const edges = []
    for (const k in edgeW) {
      const [a, b] = k.split('>').map(Number), pa = pos[a], pb = pos[b]
      if (!pa || !pb) continue
      const sw = Math.min(4.5, 1 + Math.log2(edgeW[k] + 1) / 2)
      const span = depth[a] - depth[b]                 // a 更上游(大 d), b 更靠 origin(小 d); >1 ⇒ 中间被 prepend
      const e = bezier(pa.x - NW / 2, pa.y, pb.x + NW / 2, pb.y, mainEdges.has(k) ? 'gmain' : 'gedge', sw)
      e.key = k; e.w = edgeW[k]; e.pre = span >= 2; e.rep = span; e.mx = (pa.x + pb.x) / 2; e.my = (pa.y + pb.y) / 2
      edges.push(e)
    }
    edges.sort((p, q) => (p.cls === 'gmain' ? 1 : 0) - (q.cls === 'gmain' ? 1 : 0))   // 主路径后画 ⇒ 压在上层
    const boxes = arr.map(asn => ({
      x: pos[asn].x, y: pos[asn].y, asn, origin: originSet.has(asn),
      t1: TIER1.has(asn), name: asnName(asn),
    }))
    // 顶部距离轴: 每列一条淡竖线 + 跳数标签
    const axis = []
    for (let d = 0; d <= maxD; d++) axis.push({ x: cx(d), label: distLabel(d) })
    return { W, H, edges, boxes, axis, nodeEdges }
  }
  let g = $derived(compute(rec))
  // hover/focus 某节点 → 高亮"到这个 node 的所有可达线路", 并在每条边中点显示其 peer 权重。
  let hovered = $state(null)
  let hoverSet = $derived(hovered != null && g ? g.nodeEdges[hovered] : null)
</script>

{#if g}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="graphwrap" class:grabbing={!!pan} bind:this={wrap}
       onpointerdown={onPanDown} onpointermove={onPanMove} onpointerup={onPanUp} onpointercancel={onPanUp}>
    <svg viewBox="0 0 {g.W} {g.H}" width={g.W} height={g.H} class="pathsvg" class:hovering={!!hoverSet}>
      <!-- 距离轴: 每列一条淡竖线 + 到 origin 的跳数标签 -->
      {#each g.axis as ax}
        <line class="gaxis" x1={ax.x} y1="18" x2={ax.x} y2={g.H} />
        <text class="gaxlbl" x={ax.x} y="12">{ax.label}</text>
      {/each}
      <!-- 边: gmain=最多采集点看到; gpre(虚线)=中间被 prepend; hover 时 ghi 高亮/gdim 淡出 -->
      {#each g.edges as e}
        <path d={e.d} class={e.cls} class:gpre={e.pre}
          class:ghi={hoverSet?.has(e.key)} class:gdim={hoverSet && !hoverSet.has(e.key)}
          stroke-width={e.sw} fill="none" />
      {/each}
      <!-- prepend ×rep 标记(常显) -->
      {#each g.edges as e}{#if e.pre && !(hoverSet && !hoverSet.has(e.key))}
        <text class="gprelbl" x={e.mx} y={e.my - 5}>×{e.rep}</text>{/if}{/each}
      <!-- hover: 可达线路在中点显示 peer 权重(多少采集点看到这条边) -->
      {#if hoverSet}{#each g.edges as e}{#if hoverSet.has(e.key)}
        <g class="gwt">
          <rect x={e.mx - 13} y={e.my + 1} width="26" height="13" rx="3" />
          <text x={e.mx} y={e.my + 7.5}>{e.w}</text>
        </g>{/if}{/each}{/if}
      {#each g.boxes as b}
        <g class="gnode nav" class:origin={b.origin} class:tier1={b.t1}
          class:hilite={hovered === b.asn}
          role="button" tabindex="0" aria-label="AS{b.asn}"
          onclick={() => go(b.asn)} onkeydown={(e) => goKey(e, b.asn)}
          onmouseenter={() => hovered = b.asn} onmouseleave={() => { if (hovered === b.asn) hovered = null }}
          onfocus={() => hovered = b.asn} onblur={() => { if (hovered === b.asn) hovered = null }}>
          <rect x={b.x - NW / 2} y={b.y - NH / 2} width={NW} height={NH} rx="5" />
          <text x={b.x} y={b.y - 3} class="gas">AS{b.asn}{b.t1 ? ' ★' : ''}</text>
          {#if b.name}<text x={b.x} y={b.y + 10} class="gnm">{b.name.slice(0, 15)}</text>{/if}
        </g>
      {/each}
    </svg>
  </div>
{/if}

<style>
  .graphwrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--alt); padding: 6px; cursor: grab; }
  .graphwrap.grabbing { cursor: grabbing; user-select: none; }
  .pathsvg { display: block; max-width: none; }
  :global(.gedge) { stroke: var(--muted); opacity: .4; fill: none; }
  :global(.gmain) { stroke: var(--accent); opacity: .85; }
  /* prepend 边: 虚线提示"中间被 prepend 撑长" */
  :global(.gpre) { stroke-dasharray: 5 4; }
  /* hover 高亮: 命中的可达线路加粗加深, 其余淡出 */
  :global(.ghi) { stroke: var(--accent); opacity: .95; }
  :global(.gdim) { opacity: .08; }
  /* 距离轴 */
  .gaxis { stroke: var(--line); stroke-width: 1; opacity: .5; }
  .gaxlbl { font: 10px var(--mono); fill: var(--muted); text-anchor: middle; }
  /* prepend ×rep 角标 */
  .gprelbl { font: 700 10px var(--mono); fill: var(--muted); text-anchor: middle; }
  /* hover 时的 peer 权重药丸 */
  .gwt rect { fill: var(--accent); opacity: .92; }
  .gwt text { font: 700 9px var(--mono); fill: var(--bg); text-anchor: middle; dominant-baseline: central; }
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
