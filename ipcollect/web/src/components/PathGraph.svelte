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
    pan = { sx: e.clientX, sy: e.clientY, left: wrap.scrollLeft, top: wrap.scrollTop, moved: false }
    wrap.setPointerCapture?.(e.pointerId)
  }
  function onPanMove(e) {
    if (!pan) return
    const dx = e.clientX - pan.sx, dy = e.clientY - pan.sy
    if (!pan.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) pan.moved = true
    wrap.scrollLeft = pan.left - dx
    wrap.scrollTop = pan.top - dy
  }
  function onPanUp(e) {
    if (!pan) return
    wrap.releasePointerCapture?.(e.pointerId)
    justPanned = pan.moved
    pan = null
  }
  const go = asn => { if (justPanned) return; showAsn(asn) }

  const NW = 120, NH = 34, COLG = 56, ROWG = 14
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
    const depth = {}, edgeW = {}, nodes = new Set()
    for (const p of raw) {
      const a = truncToTier1(p.asns), n = a.length, w = p.peers || 1
      for (let i = 0; i < n; i++) { nodes.add(a[i]); const d = n - 1 - i; if (depth[a[i]] == null || d < depth[a[i]]) depth[a[i]] = d }
      for (let i = 0; i < n - 1; i++) { const k = a[i] + '>' + a[i + 1]; edgeW[k] = (edgeW[k] || 0) + w }
    }
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
    const cols = maxD + 1, W = cols * colP + COLG, H = Math.max(maxRows, 1) * rowP + ROWG
    const cx = col => COLG + col * colP + NW / 2, pos = {}
    for (const d in layers) { const l = layers[d], y0 = (H - l.length * rowP) / 2, x = cx(+d); l.forEach((asn, j) => { pos[asn] = { x, y: y0 + j * rowP + NH / 2 } }) }
    const edges = []
    for (const k in edgeW) {
      const [a, b] = k.split('>').map(Number), pa = pos[a], pb = pos[b]
      if (!pa || !pb) continue
      const sw = Math.min(4.5, 1 + Math.log2(edgeW[k] + 1) / 2)
      edges.push(bezier(pa.x - NW / 2, pa.y, pb.x + NW / 2, pb.y, 'gedge', sw))
    }
    const boxes = arr.map(asn => ({
      x: pos[asn].x, y: pos[asn].y, asn, origin: originSet.has(asn),
      t1: TIER1.has(asn), name: asnName(asn),
    }))
    return { W, H, edges, boxes }
  }
  let g = $derived(compute(rec))
</script>

{#if g}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="graphwrap" class:grabbing={!!pan} bind:this={wrap}
       onpointerdown={onPanDown} onpointermove={onPanMove} onpointerup={onPanUp} onpointercancel={onPanUp}>
    <svg viewBox="0 0 {g.W} {g.H}" width={g.W} height={g.H} class="pathsvg">
      {#each g.edges as e}<path d={e.d} class={e.cls} stroke-width={e.sw} fill="none" />{/each}
      {#each g.boxes as b}
        <g class="gnode nav" class:origin={b.origin} class:tier1={b.t1}
          role="button" tabindex="0" aria-label="AS{b.asn}"
          onclick={() => go(b.asn)} onkeydown={(e) => goKey(e, b.asn)}>
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
  :global(.gmain) { stroke: var(--accent); opacity: .8; }
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
</style>
