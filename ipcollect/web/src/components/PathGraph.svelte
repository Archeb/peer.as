<script>
  import { tick } from 'svelte'
  import Fa from 'svelte-fa'
  import { iClose, iZoomIn, iZoomOut, iCopy, iDownload, iCheck } from '../lib/icons.js'
  import { truncToTier1, asnName, TIER1 } from '../lib/bgp.js'
  import { showAsn } from '../lib/queries.js'
  let { rec } = $props()
  const goKey = (e, asn) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showAsn(asn) } }

  // ── 全屏模态 ──
  // 内嵌图常被抽屉宽度压扁; 点「全屏」按钮 → 整页深色遮罩, 图居中, 可拖拽/缩放看全貌。
  let full = $state(false)
  const openFull = () => { zoom = 1; full = true }
  const closeFull = () => { full = false; mptrs.clear(); mpan = null; pinch = null; dragging = false }
  // 抽屉(.floatwin)有 backdrop-filter ⇒ 给 position:fixed 后代造了新的包含块, 模态会被框死在抽屉内、
  // 盖不住整页(左侧主页面露出来还压在上面)。用 portal 把模态搬到挂载根 #app 下(脱离该包含块);
  // 仍在 #app 子树内 ⇒ Svelte 5 的 click 事件委托照常生效。
  function portal(node) {
    const root = document.getElementById('app') || document.body
    root.appendChild(node)
    return { destroy() { node.remove() } }
  }

  // ── 全屏图交互: svg 始终 1:1 等比(viewBox 不变, 出图尺寸 = g.W×g.H × zoom ⇒ 矢量缩放不糊),
  //    支持 滚轮缩放 / 双指捏合缩放 / 拖拽平移; 缩放都以光标(或两指中点)为锚, 该点保持不动。 ──
  let zoom = $state(1)
  let dragging = $state(false)   // 仅光标反馈
  let fwrap = $state(null)       // 全屏滚动容器(按钮缩放/重置用)
  const ZMIN = 0.2, ZMAX = 6
  const mptrs = new Map()        // 活跃指针: pid -> {x,y}
  let mpan = null                // 单指/单击拖拽
  let pinch = null               // 双指捏合: {d0,z0,ox,oy,cx,cy,el}
  const pdist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
  // 以容器内锚点(ox,oy=相对容器左上像素)缩放到 nz, 保持锚点不动(先改 zoom→tick 等 DOM 重排→再回滚动)
  async function zoomAt(el, ox, oy, nz) {
    nz = Math.min(ZMAX, Math.max(ZMIN, nz))
    if (nz === zoom || !el) return
    const cx = (el.scrollLeft + ox) / zoom, cy = (el.scrollTop + oy) / zoom
    zoom = nz
    await tick()
    el.scrollLeft = cx * nz - ox; el.scrollTop = cy * nz - oy
  }
  async function onWheel(e) {
    // macOS 触控板「捏合」= wheel + ctrlKey(Chrome/FF/Safari 通用); Ctrl/⌘+滚轮同理。
    // 按 deltaY **比例**取指数系数 ⇒ 平滑连续, 不再每事件固定一格(触控板会狂发小 delta, 固定步长就卡)。
    if (e.ctrlKey) {
      e.preventDefault()
      const el = e.currentTarget, r = el.getBoundingClientRect()
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY      // 行模式换算成像素
      await zoomAt(el, e.clientX - r.left, e.clientY - r.top, zoom * Math.exp(-dy * 0.01))
    }
    // 否则(普通滚轮 / 触控板双指滚动): 不拦截, 交给容器原生滚动平移 ⇒ 最丝滑
  }
  function mDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    mptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    justPanned = false
    const el = e.currentTarget
    if (mptrs.size === 2) {                                   // 进入捏合: 记中点与起始间距
      const [a, b] = [...mptrs.values()], r = el.getBoundingClientRect()
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top
      pinch = { d0: pdist(a, b) || 1, z0: zoom, ox: mx, oy: my, cx: (el.scrollLeft + mx) / zoom, cy: (el.scrollTop + my) / zoom, el }
      mpan = null
    } else if (mptrs.size === 1) {                            // 单指: 暂不捕获(留给节点 click), 越阈值才拖
      mpan = { sx: e.clientX, sy: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false, pid: e.pointerId, el }
    }
  }
  async function mMove(e) {
    if (!mptrs.has(e.pointerId)) return
    mptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch && mptrs.size >= 2) {
      const [a, b] = [...mptrs.values()]
      const nz = Math.min(ZMAX, Math.max(ZMIN, pinch.z0 * pdist(a, b) / pinch.d0))
      if (nz !== zoom) { zoom = nz; await tick(); pinch.el.scrollLeft = pinch.cx * nz - pinch.ox; pinch.el.scrollTop = pinch.cy * nz - pinch.oy }
      return
    }
    if (mpan) {
      const dx = e.clientX - mpan.sx, dy = e.clientY - mpan.sy
      if (!mpan.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) { mpan.moved = true; dragging = true; mpan.el.setPointerCapture?.(mpan.pid) }
      if (!mpan.moved) return
      mpan.el.scrollLeft = mpan.left - dx; mpan.el.scrollTop = mpan.top - dy
    }
  }
  function mUp(e) {
    mptrs.delete(e.pointerId)
    if (mpan && mpan.pid === e.pointerId) { if (mpan.moved) { justPanned = true; mpan.el.releasePointerCapture?.(mpan.pid) } mpan = null; dragging = false }
    if (mptrs.size < 2) pinch = null
  }
  // 按钮缩放: 以容器中心为锚
  const zoomBtn = f => { if (fwrap) { const r = fwrap.getBoundingClientRect(); zoomAt(fwrap, r.width / 2, r.height / 2, zoom * f) } }
  const resetZoom = async () => { zoom = 1; await tick(); if (fwrap) { fwrap.scrollLeft = 0; fwrap.scrollTop = 0 } }

  // ── 导出 SVG / PNG ── 独立文件没有外部 CSS, 故把计算样式内联到每个元素; 并还原成 1:1 自然尺寸(去 zoom)。
  const EXPORT_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
    'opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline']
  const exportName = () => `peeras-${(rec?.prefix || 'graph').replace(/[^\w.]+/g, '_')}`
  async function buildExportSvg() {
    // 先清掉 hover/选中, 确保导出的是干净全图(否则会把虚化/高亮态烤进去)
    hovered = null; selected = null
    await tick()
    const live = (fwrap || document).querySelector('svg.pathsvg')
    if (!live) return null
    const clone = live.cloneNode(true)
    clone.setAttribute('width', g.W); clone.setAttribute('height', g.H)
    clone.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`)
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const src = live.querySelectorAll('*'), dst = clone.querySelectorAll('*')
    for (let i = 0; i < src.length; i++) {
      const cs = getComputedStyle(src[i])
      let s = ''
      for (const p of EXPORT_PROPS) { const v = cs.getPropertyValue(p); if (v && v !== 'normal') s += `${p}:${v};` }
      dst[i].setAttribute('style', s); dst[i].removeAttribute('class')
    }
    return clone
  }
  async function exportStr() {
    const el = await buildExportSvg(); if (!el) return null
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(el)
  }
  function dl(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement('a')
    a.href = url; a.download = name; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
  async function exportSvg() {
    const str = await exportStr(); if (!str) return
    dl(new Blob([str], { type: 'image/svg+xml' }), `${exportName()}.svg`)
  }
  // 2× 光栅化为 PNG blob; white=true 先铺白底, 否则透明。供下载与复制共用。
  async function renderPng(white) {
    const str = await exportStr(); if (!str) return null
    const scale = 2, img = new Image()
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str)
    try { await img.decode() } catch { await new Promise(r => { img.onload = r; img.onerror = r }) }
    const cv = document.createElement('canvas')
    cv.width = Math.round(g.W * scale); cv.height = Math.round(g.H * scale)
    const ctx = cv.getContext('2d')
    if (white) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height) }
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.drawImage(img, 0, 0, g.W, g.H)
    return await new Promise(res => cv.toBlob(res, 'image/png'))
  }
  async function exportPng(white) {
    const b = await renderPng(white); if (b) dl(b, `${exportName()}${white ? '-white' : ''}.png`)
  }
  // 复制到剪贴板(白底, 贴到聊天/文档里不会黑乎乎一片)。给 ClipboardItem 传 Promise<Blob> ⇒ 兼容 Safari 的用户手势要求。
  // 注意: 写图片剪贴板需**安全上下文**(https 或 http://localhost); 经 LAN IP 的 http 不行 ⇒ 明确报「失败」, 不偷偷下载。
  let copyState = $state('idle')   // 'idle' | 'ok' | 'fail'
  let copyTimer = null
  const flashCopy = s => { copyState = s; clearTimeout(copyTimer); copyTimer = setTimeout(() => copyState = 'idle', 1600) }
  async function copyPng() {
    if (!(window.isSecureContext && navigator.clipboard?.write && window.ClipboardItem)) {
      console.warn('[copy] 剪贴板写图需安全上下文(HTTPS 或 http://localhost); 当前非安全上下文, 改用「PNG」下载按钮')
      flashCopy('fail'); return
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderPng(true).then(b => b || new Blob()) })])
      flashCopy('ok')
    } catch (e) { console.warn('[copy] 写剪贴板失败', e); flashCopy('fail') }
  }

  // ── 手型拖拽平移(桌面) ──
  // PC 上原本只能拖底部滚动条, 很难用; 改成在图上按住直接左右/上下拖。
  // 触摸设备走浏览器原生滚动(pointerdown 直接 return), 不动它, 保持移动端兼容。
  // 滚动容器取 e.currentTarget(而非单一 bind) ⇒ 内嵌图与全屏图两个容器共用同一套逻辑。
  let pan = $state(null)    // 拖拽中: { sx, sy, left, top, moved, pid, el }
  let justPanned = false    // 刚发生过拖拽 → 吞掉随后的节点 click, 避免误触导航
  function onPanDown(e) {
    if (e.pointerType === 'touch') return            // 移动端: 原生滚动
    if (e.button !== 0) return                        // 仅左键
    justPanned = false
    // 注意: 此处**不**立刻 setPointerCapture —— 一旦捕获, 后续 click 会被重定向到容器,
    // 节点 <g> 的 onclick 永不触发(纯点击失效)。改为等真正拖动(越过阈值)才捕获。
    const el = e.currentTarget
    pan = { sx: e.clientX, sy: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false, pid: e.pointerId, el }
  }
  function onPanMove(e) {
    if (!pan) return
    const dx = e.clientX - pan.sx, dy = e.clientY - pan.sy
    if (!pan.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      pan.moved = true
      pan.el.setPointerCapture?.(pan.pid)             // 确认是拖动后才捕获, 保证拖出区域也能继续
    }
    if (!pan.moved) return                            // 阈值内: 当作点击, 不滚动也不捕获
    pan.el.scrollLeft = pan.left - dx
    pan.el.scrollTop = pan.top - dy
  }
  function onPanUp() {
    if (!pan) return
    if (pan.moved) pan.el.releasePointerCapture?.(pan.pid)
    justPanned = pan.moved
    pan = null
  }
  // ── 点击选中模式 ──
  // 第一次点击节点 → 进入选中(高亮像 hover 一样保持); 再点同一节点 → 跳转该 ASN;
  // 点击空白处 → 退出选中。选中态下仍可拖拽平移看长路由(justPanned 吞掉拖拽尾随的 click)。
  function onNodeClick(ev, asn) {
    ev.stopPropagation()                       // 阻止冒泡到背景, 否则会被 onBgClick 立刻清掉
    if (justPanned) return                      // 刚拖完: 不当作点击
    if (selected === asn) { showAsn(asn); full = false; return }   // 跳转前先关全屏, 否则盖住新结果
    selected = asn
  }
  // 点图内空白(非节点): 退出选中; stopPropagation 防止冒泡到全屏遮罩把模态也关掉。
  function onBgClick(ev) { ev?.stopPropagation?.(); if (justPanned) return; selected = null }

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
  {#snippet board(sc)}
    <svg viewBox="0 0 {g.W} {g.H}" width={g.W * sc} height={g.H * sc} class="pathsvg" class:hovering={!!hoverSet}>
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
  {/snippet}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="graphbox">
    <button class="gfsbtn" onclick={openFull} aria-label="全屏查看" title="全屏查看">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="graphwrap" class:grabbing={!!pan} onclick={onBgClick}
         onpointerdown={onPanDown} onpointermove={onPanMove} onpointerup={onPanUp} onpointercancel={onPanUp}>
      {@render board(1)}
    </div>
  </div>

  {#if full}
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_no_noninteractive_tabindex -->
    <div class="gfull" role="dialog" aria-modal="true" tabindex="-1" use:portal>
      <!-- 整个全屏遮罩都是 滚动/缩放/拖拽 区域(不再局限于图那块小卡片) -->
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
      <div class="gscroll" bind:this={fwrap} class:grabbing={dragging} onclick={onBgClick}
           onpointerdown={mDown} onpointermove={mMove} onpointerup={mUp} onpointercancel={mUp} onwheel={onWheel}>
        <div class="gcenter">{@render board(zoom)}</div>
      </div>
      <div class="gctrls">
        <button class="gbtn ic" onclick={() => zoomBtn(1 / 1.25)} aria-label="缩小" title="缩小"><Fa icon={iZoomOut} /></button>
        <button class="gbtn pct" onclick={resetZoom} aria-label="重置为 1:1" title="重置为 1:1">{Math.round(zoom * 100)}%</button>
        <button class="gbtn ic" onclick={() => zoomBtn(1.25)} aria-label="放大" title="放大"><Fa icon={iZoomIn} /></button>
        <span class="gdiv"></span>
        <button class="gbtn" class:ok={copyState === 'ok'} class:fail={copyState === 'fail'} onclick={copyPng}
          aria-label="复制图片到剪贴板" title="复制图片到剪贴板(白底, 需 HTTPS 或 localhost)">
          <Fa icon={copyState === 'ok' ? iCheck : copyState === 'fail' ? iClose : iCopy} />
          <span>{copyState === 'ok' ? '已复制' : copyState === 'fail' ? '失败' : '复制'}</span>
        </button>
        <button class="gbtn" onclick={exportSvg} aria-label="下载 SVG 矢量图" title="下载 SVG · 矢量"><Fa icon={iDownload} /><span>SVG</span></button>
        <button class="gbtn" onclick={() => exportPng(true)} aria-label="下载 PNG(白底)" title="下载 PNG · 白底"><Fa icon={iDownload} /><span>PNG</span></button>
        <span class="gdiv"></span>
        <button class="gbtn ic close" onclick={closeFull} aria-label="关闭" title="关闭 (Esc)"><Fa icon={iClose} /></button>
      </div>
    </div>
  {/if}
{/if}

<svelte:window onkeydown={(e) => { if (full && e.key === 'Escape') closeFull() }} />

<style>
  /* 内嵌图容器: 相对定位, 右上角浮一个全屏按钮 */
  .graphbox { position: relative; }
  .gfsbtn { position: absolute; top: 8px; right: 8px; z-index: 3; display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; padding: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--muted); cursor: pointer; }
  .gfsbtn:hover { color: var(--accent); border-color: var(--accent); }
  .graphwrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--alt); padding: 6px; cursor: grab; }
  .graphwrap.grabbing { cursor: grabbing; user-select: none; }
  /* svg 出图按 width/height 属性的真实像素, flex 容器里也绝不收缩 ⇒ 始终 1:1 等比 */
  .pathsvg { display: block; max-width: none; flex: 0 0 auto; }
  /* ── 全屏模态 ── */
  .gfull { position: fixed; inset: 0; z-index: 1000;
    background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(10px); }
  /* 滚动/缩放/拖拽区 = 整个全屏遮罩; 触摸全交给自定义逻辑(单指拖/双指缩), 不跟原生滚动打架 */
  .gscroll { position: absolute; inset: 0; overflow: auto; touch-action: none; cursor: grab; }
  .gscroll.grabbing { cursor: grabbing; user-select: none; }
  /* gcenter 至少铺满视口并居中 svg; 放大到比视口大时用 safe 居中 ⇒ 可滚动/拖到任意边缘不裁切 */
  .gcenter { min-width: 100%; min-height: 100%; display: flex; align-items: safe center; justify-content: safe center; box-sizing: border-box; padding: 24px; }
  /* 控制条: 钉在遮罩右上角(滚动区之外, 不随内容滚动)。磨砂分段工具条, 缩放/导出/关闭三组。 */
  .gctrls { position: absolute; top: 18px; right: 20px; z-index: 1001; display: flex; align-items: center; gap: 6px;
    padding: 5px; border: 1px solid color-mix(in srgb, var(--line) 80%, transparent); border-radius: 13px;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    backdrop-filter: blur(10px) saturate(1.4);
    box-shadow: 0 10px 30px -12px rgba(0, 0, 0, .55), inset 0 1px 0 color-mix(in srgb, #fff 7%, transparent);
    max-width: calc(100vw - 32px); flex-wrap: wrap; }
  /* 分组靠细分隔线, 按钮本身无底色 */
  .gdiv { width: 1px; height: 18px; background: color-mix(in srgb, var(--line) 90%, transparent); margin: 0 3px; }
  .gbtn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 9px; border: 0; border-radius: 7px;
    background: none; color: var(--muted); font: 600 11.5px var(--mono); letter-spacing: .02em; line-height: 1;
    cursor: pointer; transition: color .12s; }
  .gbtn :global(svg) { width: 13px; height: 13px; flex: 0 0 auto; }
  .gbtn.ic { width: 28px; padding: 0; justify-content: center; }
  .gbtn.pct { min-width: 46px; justify-content: center; color: var(--fg); font-weight: 700; font-variant-numeric: tabular-nums; }
  .gbtn:hover { color: var(--accent); }
  .gbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .gbtn.ok { color: var(--signal); }
  .gbtn.fail { color: #e5484d; }
  .gbtn.close:hover { color: #e5484d; }
  /* 手机: 收起文字标签, 纯图标; 倍率仍显示 */
  @media (max-width: 640px) {
    .gctrls { top: 10px; right: 10px; }
    .gbtn span { display: none; }
    .gbtn { padding: 0; width: 30px; justify-content: center; }
    .gbtn.pct { width: auto; padding: 0 6px; }
  }
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
