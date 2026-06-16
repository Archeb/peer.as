<script>
  // 全球路由跟踪视图(顶层 view==='trace', features.routeTrace 门控)。
  // 右侧: 大半个倾斜地球(TraceGlobe, 露 ~4/5, 南极在可见区外, 缓慢自转)。
  // 左侧: 极简「指挥台」HUD —— 默认只有目标输入框 + 跟踪/监测点/展开几个按钮; 可展开看监测点选择 + 实时逐跳结果。
  // 数据为 live: globalping(/v1/measurements 真实 MTR/traceroute/ping)+ 库内 geo 富集逐跳坐标。
  import Fa from 'svelte-fa'
  import { onMount } from 'svelte'
  import { fade } from 'svelte/transition'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { loadInsightFor } from '../lib/queries.js'
  import { asnName } from '../lib/bgp.js'
  import { iPlay, iStop, iClose, iChevD, iChevR, iProbe, iClock, iGear, iInfinity, iSearch, iClear, iPlus, iCity, iCountry, iNet, iLoc, iRecenter, iCompass, iVisible, iLowvis } from '../lib/icons.js'
  import { streamTrace } from '../lib/globalping.js'
  import { loadNTraceMap } from '../lib/ntrace-map.js'
  import { loadProbeLocations } from '../lib/trace-probes.js'
  import { setGeoSource } from '../lib/geo-resolve.js'
  import MobileBar from './MobileBar.svelte'
  import TraceGlobe from './TraceGlobe.svelte'

  // ── 设置持久化(localStorage, 自动保存) ──
  const SETKEY = 'ipc-trace-settings'
  function loadSettings() { try { return JSON.parse(localStorage.getItem(SETKEY) || '{}') || {} } catch { return {} } }
  const _set = loadSettings()

  // ── 本地态 ──
  let box = $state(S.trace?.target || '')
  let booting = $state(true)            // 首帧不放入场动画(URL 直达时直接就位)
  let shown = $state(false)             // 入场淡入开关
  let probesOpen = $state(false)        // 监测点选择是否展开
  let settingsOpen = $state(false)      // MTR 设置(协议/端口/包数)是否展开
  let probeQuery = $state('')           // 监测点选择里的搜索词
  let mtr = $state({
    type: _set.type ?? 'mtr', infinite: _set.infinite ?? false, family: _set.family ?? 'auto',
    proto: _set.proto ?? 'icmp', port: _set.port ?? 443, packets: _set.packets ?? 3,
  })
  let geoSource = $state(_set.geoSource ?? 'nexttrace')   // GeoIP 数据源: NextTrace(经 worker, 免 token) / 内置
  let map2d = $state(_set.map2d ?? (typeof window !== 'undefined' && window.innerWidth <= 820))   // 2D(墨卡托)/3D 切换(右下角); 移动端默认 2D, 桌面默认 3D(无存档时)
  let lockNorth = $state(_set.lockNorth ?? true)         // 锁定正北(北极朝上, 拖动不产生 roll); 默认开, 右下角可解除
  let globeCtrl = null                                    // TraceGlobe 引擎句柄(复位按钮用)
  let famLabel = $derived(mtr.family === '4' ? 'IPv4' : mtr.family === '6' ? 'IPv6' : 'AUTO')
  // 各类型可用项(对齐 globalping spec): ping 协议仅 ICMP/TCP; trace/mtr 加 UDP。
  // port 仅在该协议会用到端口时可填(ping/trace 仅 TCP; mtr 为 TCP/UDP)。packets 仅 ping/mtr。无尽仅 ping。
  let protoOpts = $derived(mtr.type === 'ping' ? ['icmp', 'tcp'] : ['icmp', 'udp', 'tcp'])
  let portOn = $derived(mtr.type === 'mtr' ? (mtr.proto === 'tcp' || mtr.proto === 'udp') : mtr.proto === 'tcp')
  let packetsOn = $derived(mtr.type === 'ping' || mtr.type === 'mtr')
  // 切到 ping 时若当前协议是 UDP(ping 不支持)矫正回 ICMP; 非 ping 时无尽无意义, 关掉。
  $effect(() => { if (mtr.type === 'ping' && mtr.proto === 'udp') mtr.proto = 'icmp' })
  $effect(() => { if (mtr.type !== 'ping' && mtr.infinite) mtr.infinite = false })
  // 应用 + 自动保存全部设置(MTR 选项 + GeoIP 源/token)
  $effect(() => { setGeoSource(geoSource) })
  $effect(() => {
    const data = { type: mtr.type, infinite: mtr.infinite, family: mtr.family, proto: mtr.proto, port: mtr.port, packets: mtr.packets, geoSource, map2d, lockNorth }
    try { localStorage.setItem(SETKEY, JSON.stringify(data)) } catch { /* 隐私模式忽略 */ }
  })

  // ── 监测点(globalping /v1/probes, 异步加载, 按城市聚合)──
  let allLocations = $state([])         // [{ id, city, cc, country, lat, lon, count, networks:[{asn,name,n}] }]
  let locLoading = $state(true)
  let locError = $state('')
  // 选择(append 式, 无选中/未选中态 —— 像 globalping 首页筛选器: dropdown autofill → 追加到已选列表)。
  // picks: 有序条件列表, 每条 = { key, kind:'city'|'net'|'magic', id?, city?, country?, asn?, magic?, label, count }
  //   city  -> {city,country,limit}(该城市随机 N 个探测点)
  //   net   -> magic "City+ASxxx"(该城市指定供应商)
  //   magic -> as-is magic(国家/全局网络建议 或 用户纯手打)
  const SELKEY = 'ipc-trace-sel'
  function loadPicks() { try { const j = JSON.parse(localStorage.getItem(SELKEY) || '{}') || {}; return Array.isArray(j.picks) ? j.picks : [] } catch { return [] } }
  let picks = $state(loadPicks())
  const DEF_COUNT = 1
  const DEFAULT_CITIES = ['Frankfurt', 'Ashburn', 'Tokyo', 'Singapore', 'São Paulo', 'London', 'Los Angeles', 'Sydney']
  let LOCBY = $derived.by(() => Object.fromEntries(allLocations.map(L => [L.id, L])))
  const cityPick = (L) => ({ key: 'city:' + L.id, kind: 'city', id: L.id, city: L.city, cc: L.cc, label: L.city, count: DEF_COUNT })
  const netPick = (L, nw) => ({ key: 'net:' + L.id + ':' + nw.asn, kind: 'net', id: L.id, city: L.city, cc: L.cc, asn: nw.asn, magic: `${L.city}+AS${nw.asn}`, label: `${L.city} · ${nw.name}`, count: DEF_COUNT })
  const magicPick = (m, label) => ({ key: 'magic:' + m, kind: 'magic', magic: m, label: label || m, count: DEF_COUNT })
  function applyDefaultSelection(locs) {
    const out = []
    for (const name of DEFAULT_CITIES) { if (out.length >= 5) break; const L = locs.find(x => x.city === name); if (L) out.push(cityPick(L)) }
    if (!out.length) for (const L of locs.slice(0, 5)) out.push(cityPick(L))
    picks = out
  }
  let totalProbes = $derived(picks.reduce((a, p) => a + (p.count || 1), 0))
  function hasPick(key) { return picks.some(p => p.key === key) }
  function addPick(p) { if (!hasPick(p.key)) picks = [...picks, p]; resetProbeInput() }
  function removePick(key) { picks = picks.filter(p => p.key !== key) }
  function setPickCount(key, n) { picks = picks.map(p => p.key === key ? { ...p, count: Math.max(1, Math.min(50, n)) } : p) }
  function clearAllSel() { picks = [] }
  $effect(() => { try { localStorage.setItem(SELKEY, JSON.stringify({ picks })) } catch { /* 隐私模式忽略 */ } })
  // 地球高亮: 各城市当前被选条件(city + net)合计的取样数
  let cityCount = $derived.by(() => {
    const m = {}
    for (const p of picks) if (p.id) m[p.id] = (m[p.id] || 0) + (p.count || 1)
    return m
  })

  // 地图 popup 上对某地点(城市)的快捷选择 —— 行为对齐 probewrap 里的 chip:
  //   + 增一个(无则新建该城市 pick), − 减一个(到 0 移除), × 清空该地点全部选择(city + 其网络)。
  //   任意添加都展开 probewrap, 让用户看到刚加进去的条件。
  function locCityCount(id) { const p = picks.find(x => x.key === 'city:' + id); return p ? (p.count || 1) : 0 }
  function locInc(L) {
    const key = 'city:' + L.id, p = picks.find(x => x.key === key)
    if (p) setPickCount(key, (p.count || 1) + 1); else addPick(cityPick(LOCBY[L.id] || L))
    probesOpen = true
  }
  function locDec(L) {
    const key = 'city:' + L.id, p = picks.find(x => x.key === key); if (!p) return
    if ((p.count || 1) <= 1) removePick(key); else setPickCount(key, (p.count || 1) - 1)
  }
  function locClear(id) { picks = picks.filter(p => p.id !== id) }                 // 清空该地点全部(city + net)
  function locAddNet(L, nw) { addPick(netPick(LOCBY[L.id] || L, nw)); probesOpen = true }

  // ── 筛选器 combobox(行为对齐 globalping 首页): 输入即返回匹配的城市/国家/网络建议;
  //    点建议 → 追加到已选; 也可纯手打 magic, 经 submit/回车 as-is 追加。无选中态, 纯 append。──
  let sugOpen = $state(false)
  let sugHi = $state(-1)            // 建议高亮项下标(贯穿三组的扁平序号)
  let suggest = $derived.by(() => {
    const q = probeQuery.trim().toLowerCase()
    if (!q) return { cities: [], countries: [], networks: [] }
    const cities = allLocations
      .filter(L => `${L.city} ${L.country} ${L.cc}`.toLowerCase().includes(q))
      .slice(0, 6).map(L => ({ id: L.id, label: L.city, sub: L.country, count: L.count, L }))
    const ccm = new Map()
    for (const L of allLocations) if (`${L.country} ${L.cc}`.toLowerCase().includes(q)) {
      const o = ccm.get(L.cc) || { cc: L.cc, country: L.country, n: 0 }; o.n += L.count; ccm.set(L.cc, o)
    }
    const countries = [...ccm.values()].sort((a, b) => b.n - a.n).slice(0, 4)
    const nm = new Map()
    for (const L of allLocations) for (const nw of L.networks) if (nw.name.toLowerCase().includes(q) || ('as' + nw.asn).includes(q)) {
      const o = nm.get(nw.asn) || { asn: nw.asn, name: nw.name, n: 0 }; o.n += nw.n; nm.set(nw.asn, o)
    }
    const networks = [...nm.values()].sort((a, b) => b.n - a.n).slice(0, 5)
    return { cities, countries, networks }
  })
  // 扁平化建议(供键盘上下选 + Enter 选中)。每项 { run:()=>void, key }
  let sugFlat = $derived.by(() => {
    const f = []
    for (const c of suggest.cities) f.push({ run: () => addPick(cityPick(c.L)) })
    for (const c of suggest.countries) f.push({ run: () => addPick(magicPick(c.country, c.country)) })
    for (const n of suggest.networks) f.push({ run: () => addPick(magicPick(n.name, n.name)) })
    return f
  })
  let sugHas = $derived(suggest.cities.length + suggest.countries.length + suggest.networks.length > 0)
  function addMagic(s) {                          // 纯手打 magic as-is 追加
    const m = String(s || '').trim()
    if (m) addPick(magicPick(m))
  }
  function resetProbeInput() { probeQuery = ''; sugOpen = false; sugHi = -1 }
  function onProbeKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (sugOpen && sugHi >= 0 && sugFlat[sugHi]) sugFlat[sugHi].run()
      else addMagic(probeQuery)                   // 无高亮建议 → 纯 magic as-is 追加
    } else if (e.key === 'ArrowDown') { e.preventDefault(); sugOpen = true; sugHi = Math.min(sugHi + 1, sugFlat.length - 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sugHi = Math.max(sugHi - 1, -1) }
    else if (e.key === 'Escape') { sugOpen = false; sugHi = -1 }
  }

  // 悬停地球光点 → 交互式 popup(列该城市托管网络, 点击即把「该城市」或「城市+某网络」追加进已选)
  let hoverLoc = $state(null)
  let popX = $state(0), popY = $state(0), popBelow = $state(false)
  let popPinned = false, popTimer = 0
  function onLocHover(loc, sx, sy) {
    clearTimeout(popTimer)
    if (loc) { hoverLoc = loc; popX = sx; popY = sy; popBelow = sy < 300 }
    else { popTimer = setTimeout(() => { if (!popPinned) hoverLoc = null }, 130) }   // 留点时间让鼠标移到 popup 上
  }
  function cycleFam() { mtr.family = mtr.family === 'auto' ? '4' : mtr.family === '4' ? '6' : 'auto' }  // 自动→IPv4→IPv6→…
  // 传给地球的光点: 取 count 最高的 ~110 个 + 已选(不在前列的)补上; 各带已选取样数
  let locInfo = $derived.by(() => {
    const top = allLocations.slice(0, 110)
    const ids = new Set(top.map(L => L.id))
    const extra = allLocations.filter(L => cityCount[L.id] && !ids.has(L.id))
    return [...top, ...extra].map(L => ({ ...L, sel: cityCount[L.id] || 0 }))
  })
  // 一轮结果的光谱色: 蓝(最优/低延迟)→绿→黄→红(高延迟)
  function roundColor(rtt) {
    const f = Math.max(0, Math.min(1, (rtt - 15) / 285))
    return `hsl(${(220 * (1 - f)).toFixed(0)}, 72%, 56%)`
  }
  let trace = $state({ target: null, probes: [] })   // 引擎 + 列表的单一数据源(从 globalping 事件流重建)
  let running = $state(false)
  let remoteLoading = $state(false)      // 正在加载 NextTrace traceMap JSON
  let loadedNTraceId = $state('')        // 当前显示的 traceMap id(空 = globalping/live 模式)
  let ntraceHtmlUrl = $state('')
  let ntraceGenerated = $state('')
  let ntraceSeq = 0
  let currentNTraceId = ''
  let pendingNTraceId = ''
  let errMsg = $state('')               // 发起失败(配额/网络)文案
  let focusId = $state(null)            // hover 某监测点 → 地球上高亮它的路径
  let openRows = $state(new Set())      // 展开查看逐跳的监测点
  let inputEl
  let ctl = null                        // 当前 streamTrace 控制器
  let ranFor = ''                       // 最近发起的 target(防 effect 重复触发)

  // ── 历史记录(localStorage)+ 输入框下拉自动匹配 ──
  const HKEY = 'ipc-trace-history'
  let history = $state(loadHistory())
  let dropOpen = $state(false)
  let hi = $state(-1)                    // 下拉里高亮项的下标
  let dropRect = $state({ left: 0, top: 0, bottom: 0, width: 0, up: false })
  function loadHistory() { try { return JSON.parse(localStorage.getItem(HKEY) || '[]').filter(x => typeof x === 'string') } catch { return [] } }
  function saveHistory() { try { localStorage.setItem(HKEY, JSON.stringify(history.slice(0, 16))) } catch { /* 隐私模式忽略 */ } }
  function addHistory(tg) { history = [tg, ...history.filter(x => x !== tg)].slice(0, 16); saveHistory() }
  function removeHistory(tg) { history = history.filter(x => x !== tg); saveHistory() }
  function clearAllHistory() { history = []; saveHistory(); dropOpen = false }
  let matches = $derived.by(() => {
    const qq = box.trim().toLowerCase()
    return history.filter(h => { const l = h.toLowerCase(); return qq ? (l.includes(qq) && l !== qq) : true }).slice(0, 8)
  })
  function measureDrop() {
    if (!inputEl) return
    const r = inputEl.getBoundingClientRect()
    // 移动端面板贴底、输入在底部 → 历史下拉改为向上展开(否则落到屏幕外)
    const up = window.innerWidth <= 820
    dropRect = { left: r.left, top: r.bottom + 6, bottom: window.innerHeight - r.top + 6, width: r.width, up }
  }
  function openDrop() { measureDrop(); dropOpen = true; hi = -1 }
  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); if (dropOpen && hi >= 0 && matches[hi]) pickHistory(matches[hi]); else submit(e); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); measureDrop(); dropOpen = true; hi = Math.min(hi + 1, matches.length - 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(hi - 1, -1) }
    else if (e.key === 'Escape') { dropOpen = false; hi = -1 }
  }
  function pickHistory(tg) { box = tg; dropOpen = false; hi = -1; inputEl?.focus() }   // 仅填充, 不立即发起

  // 监测点芯片文案: 列出已选位置(城市), 放不下用 +N 收尾
  let probeChip = $derived.by(() => {
    const cs = picks.map(p => p.kind === 'city' ? p.city : p.label)
    const head = []; let len = 0
    for (const c of cs) { if (head.length && len + c.length > 26) break; head.push(c); len += c.length + 3 }
    return { text: head.join(' · ') || '—', more: cs.length - head.length }
  })

  // ── 浮窗: 拖标题移动 + 拖右下角缩放(边框角即缩放手柄, 暗示窗口可拉伸)──
  let panelEl
  let win = $state({ x: 50, y: 60, w: 410, h: null })   // 初始左上角(避开 sidetoggle); h=null 自适应, 拖角后变定值
  let winDrag = $state(false)
  let gesture = null
  const clampN = (v, a, b) => v < a ? a : v > b ? b : v
  function startMove(e) {
    if (window.innerWidth <= 820) return                  // 移动端: 面板锁定在底部, 不可拖动
    if (e.button != null && e.button !== 0) return
    // 整块面板可拖, 但放过交互区域(输入/按钮/结果列表/监测点网格/缩放角)
    if (e.target.closest && e.target.closest('input, button, textarea, a, select, .console, .results, .suggest, .chips, .settings, .grip')) return
    winDrag = true; dropOpen = false                      // 拖窗时收起历史下拉(否则会停在旧位置)
    gesture = { mode: 'move', sx: e.clientX, sy: e.clientY, ox: win.x, oy: win.y }
    window.addEventListener('pointermove', onGesture); window.addEventListener('pointerup', endGesture)
    e.preventDefault()
  }
  function startResize(e) {
    if (window.innerWidth <= 820) return                  // 移动端: 不提供缩放
    const r = panelEl.getBoundingClientRect()
    winDrag = true; win.w = r.width; win.h = r.height; dropOpen = false   // 起手先固定当前尺寸
    gesture = { mode: 'resize', sx: e.clientX, sy: e.clientY, ow: r.width, oh: r.height }
    window.addEventListener('pointermove', onGesture); window.addEventListener('pointerup', endGesture)
    e.preventDefault(); e.stopPropagation()
  }
  function onGesture(e) {
    if (!gesture) return
    const dx = e.clientX - gesture.sx, dy = e.clientY - gesture.sy
    if (gesture.mode === 'move') {
      win.x = clampN(gesture.ox + dx, 6, window.innerWidth - 90)
      win.y = clampN(gesture.oy + dy, 6, window.innerHeight - 56)
    } else {
      win.w = clampN(gesture.ow + dx, 220, Math.min(760, window.innerWidth - win.x - 8))
      win.h = clampN(gesture.oh + dy, 220, window.innerHeight - win.y - 8)
    }
  }
  function endGesture() { winDrag = false; gesture = null; window.removeEventListener('pointermove', onGesture); window.removeEventListener('pointerup', endGesture) }

  onMount(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      booting = false; shown = true
      if (window.innerWidth <= 680) { win.x = 12; win.y = 75; win.w = window.innerWidth - 24 }   // 手机: 避开顶部 side, 左右等边距
      else { win.x = 50; win.y = 60; win.w = Math.min(410, window.innerWidth - 100) }
    }))
    // 异步加载 globalping 监测点清单 → 铺光点; 无已记住的选择时才铺默认。不从 URL 带参发起。
    loadProbeLocations().then(locs => {
      allLocations = locs; locLoading = false
      if (!picks.length) applyDefaultSelection(locs)
    }).catch(e => { locLoading = false; locError = e?.message || 'load failed' })
    return () => { ctl?.cancel(); window.removeEventListener('pointermove', onGesture); window.removeEventListener('pointerup', endGesture) }
  })

  $effect(() => {
    const id = (S.trace?.ntraceId || '').trim()
    if (id) loadRemoteTrace(id)
    else if (currentNTraceId || pendingNTraceId) resetRemoteTrace()
  })

  function resetRemoteTrace() {
    ctl?.cancel(); ctl = null; ntraceSeq++
    running = false
    currentNTraceId = ''; pendingNTraceId = ''
    loadedNTraceId = ''; ntraceHtmlUrl = ''; ntraceGenerated = ''; remoteLoading = false
    trace = { target: null, probes: [] }
    focusId = null; openRows = new Set(); rawView = new Set(); hiddenProbes = new Set(); errMsg = ''
  }

  function loadRemoteTrace(id) {
    if (!id || id === currentNTraceId || id === pendingNTraceId) return
    ctl?.cancel()
    const ac = new AbortController()
    const seq = ++ntraceSeq
    ctl = { cancel() { ac.abort(); ntraceSeq++ } }
    pendingNTraceId = id
    running = true; remoteLoading = true; errMsg = ''; focusId = null
    openRows = new Set(); rawView = new Set(); hiddenProbes = new Set()
    trace = { target: null, probes: [] }
    loadNTraceMap(id, ac.signal).then(model => {
      if (seq !== ntraceSeq) return
      currentNTraceId = id; pendingNTraceId = ''
      loadedNTraceId = id
      ntraceHtmlUrl = model.htmlUrl || ''
      ntraceGenerated = model.generatedAt || ''
      box = model.target?.label || model.target?.ip || ''
      trace = model
      openRows = new Set((model.probes || []).map(p => p.id))
      running = false; remoteLoading = false; ctl = null
    }).catch(e => {
      if (seq !== ntraceSeq || e?.name === 'AbortError') return
      currentNTraceId = ''; pendingNTraceId = ''
      loadedNTraceId = ''; ntraceHtmlUrl = ''; ntraceGenerated = ''
      running = false; remoteLoading = false; ctl = null
      errMsg = `${t('rt_ntrace_err')}: ${e?.message || ''}`
    })
  }

  function clearNTraceUrl() {
    if (location.pathname.replace(/^\/+|\/+$/g, '') === 'trace' && new URLSearchParams(location.search).has('nt')) {
      window.history.replaceState(window.history.state || {}, '', '/trace')
    }
  }

  function launch(tg) {
    const target = (tg ?? box).trim()
    if (!target) return
    if (!totalProbes) { errMsg = t('rt_pick_probes'); probesOpen = true; return }
    setGeoSource(geoSource)   // 发起前确保 GeoIP 源已生效(防 HMR/时序导致未应用)
    box = target; ranFor = target; addHistory(target)
    ctl?.cancel(); currentNTraceId = ''; pendingNTraceId = ''; loadedNTraceId = ''; ntraceHtmlUrl = ''; ntraceGenerated = ''; remoteLoading = false
    if (S.trace?.ntraceId) { S.trace = { target: '' }; clearNTraceUrl() }
    dropOpen = false; running = true; focusId = null; errMsg = ''
    trace = { target: null, probes: [] }
    // 已选条件 → globalping locations: city 走 {city,country(ISO cc),limit}; net/magic 走 {magic,limit}。
    // country 必须是两位 ISO 码 —— 取 pick.cc, 兼容旧存档则回查 LOCBY; 仍无则退化成 city 名 magic。
    const locations = picks.map(p => {
      if (p.kind !== 'city') return { magic: p.magic, limit: p.count || 1 }
      const cc = p.cc || LOCBY[p.id]?.cc
      return cc ? { city: p.city, country: cc, limit: p.count || 1 } : { magic: p.city, limit: p.count || 1 }
    })
    if (!locations.length) { running = false; errMsg = t('rt_pick_probes'); probesOpen = true; return }
    const runType = mtr.type   // 锁定本次类型(发起后改 type 选择器不影响已跑结果的渲染)
    ctl = streamTrace(target, locations, {
      onInit(skel) {
        // 自建模型(各 probe 起始 hops 为空), 之后只从事件追加 —— 与消费真实流式 API 完全一致
        trace = { target: skel.target, type: runType, probes: skel.probes.map(p => ({
          id: p.id, color: p.color, colorHex: p.colorHex, city: p.city, cc: p.cc, country: p.country,
          network: p.network, asn: p.asn, lat: p.lat, lon: p.lon, status: 'probing', hops: [], rounds: [], raw: '', stats: null,
        })) }
      },
      onHop(id, hop) {
        const p = trace.probes.find(x => x.id === id); if (!p) return
        p.hops = [...p.hops, hop]
        trace = { target: trace.target, type: trace.type, probes: [...trace.probes] }   // 触发地球 + 列表更新
      },
      onMeta(id, info) {                                     // ping: 原始输出(详情展示) + stats(prow 摘要)
        const p = trace.probes.find(x => x.id === id); if (!p) return
        if (info?.raw != null) p.raw = info.raw
        if (info?.stats) p.stats = info.stats
        trace = { target: trace.target, type: trace.type, probes: [...trace.probes] }
      },
      onProbeDone(id, info) {
        const p = trace.probes.find(x => x.id === id); if (!p) return
        p.status = 'done'
        p.rounds = (info?.rounds || []).slice(-40)           // 到目标的真实逐包 RTT 样本(光谱小点)
        trace = { target: trace.target, type: trace.type, probes: [...trace.probes] }
      },
      onUpdate(id, hops, rounds) {                           // 无尽 ping 的后续轮: 刷新逐跳 + 累加该轮样本
        const p = trace.probes.find(x => x.id === id); if (!p) return
        if (hops && hops.length) p.hops = hops
        p.status = 'done'
        if (rounds && rounds.length) p.rounds = [...(p.rounds || []), ...rounds].slice(-40)
        trace = { target: trace.target, type: trace.type, probes: [...trace.probes] }
      },
      onDone() { running = false },
      onError(e) { running = false; errMsg = e?.message === 'rate-limited' ? t('rt_err_rate') : `${t('rt_err')}: ${e?.message || ''}` },
    }, { type: mtr.type, infinite: mtr.infinite, family: mtr.family, proto: mtr.proto, port: mtr.port, packets: mtr.packets })
  }
  function stop() {
    ctl?.cancel(); running = false
    if (pendingNTraceId) {
      pendingNTraceId = ''; remoteLoading = false
      trace = { target: null, probes: [] }
    }
  }
  // 清除地球 + panel 上的全部结果(保留输入/选点, 可直接重跑)
  function clearResults() {
    ctl?.cancel(); running = false
    trace = { target: null, probes: [] }
    focusId = null; openRows = new Set(); rawView = new Set(); hiddenProbes = new Set(); ranFor = ''; S.trace = { target: '' }; errMsg = ''
    currentNTraceId = ''; pendingNTraceId = ''
    loadedNTraceId = ''; ntraceHtmlUrl = ''; ntraceGenerated = ''; remoteLoading = false
    clearNTraceUrl()
  }
  function submit(e) { e?.preventDefault(); launch() }
  function clearBox() { box = ''; inputEl?.focus() }
  function toggleRow(id) { const s = new Set(openRows); s.has(id) ? s.delete(id) : s.add(id); openRows = s }

  // 逐跳详情里某监测点切到「原始输出」视图(灯箱式两态: 逐跳 / rawOutput)。
  let rawView = $state(new Set())
  function setRawView(id, raw) { const s = new Set(rawView); raw ? s.add(id) : s.delete(id); rawView = s }

  // 隐藏某监测点的路径在地球上的显示(点 pdot 切换; 不影响列表逐跳详情)。传给 TraceGlobe 跳过绘制。
  let hiddenProbes = $state(new Set())
  function toggleHidden(id) { const s = new Set(hiddenProbes); s.has(id) ? s.delete(id) : s.add(id); hiddenProbes = s }

  // 把逐跳富集成渲染列表: 在 TTL 不连续处(中间被 * 省略的跳)插入「N 跳未响应」缺口标记。
  // 序号是真实 TTL, 故相邻两跳 idx 差 >1 即代表中间有未响应的跳; 开头(prev=0)留缺口表示首跳前的未响应。
  function hopList(hops) {
    const out = []; let prev = 0
    for (const h of hops) {
      const gap = h.idx - prev - 1
      if (gap > 0) out.push({ gap, key: 'g' + h.idx })
      out.push({ h, key: 'h' + h.idx })
      prev = h.idx
    }
    return out
  }

  let doneCount = $derived(trace.probes.filter(p => p.status === 'done').length)
  function pick(q) { loadInsightFor(q) }   // 点结果/地球里的 IP/ASN → 浮窗显示 insight(不离开本视图)
</script>

<main class="rtv">
  <!-- 地球(占满视图、偏右); 在球上按下也收起历史下拉(拖地球时不留残影) -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="globe-stage" class:in={shown} class:booting onpointerdown={() => { dropOpen = false; if (document.activeElement && document.activeElement.blur) document.activeElement.blur() }}>
    <TraceGlobe model={trace} locations={locInfo} {focusId} hidden={hiddenProbes} hideLocations={!!loadedNTraceId} {lockNorth} hold={!!hoverLoc} mode2d={map2d} onpick={pick} onlochover={onLocHover} onhover={(id) => (focusId = id)} onengine={(c) => (globeCtrl = c)} />
  </div>

  <!-- 右下角控制: 复位 + 2D/3D 投影切换(粒子形变转场) -->
  <div class="projctl" class:in={shown}>
    {#if !map2d}
      <button class="reset" class:on={lockNorth} onclick={() => (lockNorth = !lockNorth)}
              aria-pressed={lockNorth} title={t(lockNorth ? 'rt_north_unlock' : 'rt_north_lock')} aria-label={t('rt_north_lock')}><Fa icon={iCompass} /></button>
    {/if}
    <button class="reset" onclick={() => globeCtrl?.reset()} title={t('rt_recenter')} aria-label={t('rt_recenter')}><Fa icon={iRecenter} /></button>
    <div class="projsel" role="group" aria-label="3D / 2D">
      <button class:on={!map2d} onclick={() => (map2d = false)} aria-pressed={!map2d} title={t('rt_proj3d')}>3D</button>
      <button class:on={map2d} onclick={() => (map2d = true)} aria-pressed={map2d} title={t('rt_proj2d')}>2D</button>
    </div>
  </div>

  <MobileBar />

  <!-- 左侧指挥台 HUD: 可自由拖动 / 右下角缩放的浮窗 -->
  <div class="hud" class:in={shown} class:booting>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="panel" class:dragging={winDrag} bind:this={panelEl} onpointerdown={startMove}
         style:left="{win.x}px" style:top="{win.y}px" style:width="{win.w}px" style:height={trace.probes.length && win.h != null ? win.h + 'px' : null}>
      <!-- 顶部两道浅色横杠: 拖动示意(整块面板非交互区域均可拖动) -->
      <div class="draghandle" aria-hidden="true"><span></span><span></span></div>

      <form class="console" onsubmit={submit} autocomplete="off">
        <button type="button" class="fam" class:act={mtr.family !== 'auto'} onclick={cycleFam}
                title={t('rt_family')} aria-label={t('rt_family')}>{famLabel}</button>
        <input
          bind:this={inputEl} class="cmd" name="target" bind:value={box}
          placeholder={t('rt_ph')} spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"
          data-1p-ignore data-lpignore="true" aria-label={t('rt_title')}
          role="combobox" aria-controls="rt-hist" aria-expanded={dropOpen && matches.length > 0} aria-autocomplete="list"
          onfocus={() => { if (!booting) openDrop() }} oninput={() => { measureDrop(); dropOpen = true; hi = -1 }}
          onblur={() => setTimeout(() => (dropOpen = false), 140)} onkeydown={onKey} />
        {#if box}<button type="button" class="icon clr" onclick={clearBox} aria-label={t('clear')} title={t('clear')}><Fa icon={iClose} /></button>{/if}
        {#if running}
          <button type="button" class="go stop" onclick={stop} aria-label={t('rt_stop')} title={t('rt_stop')}><Fa icon={iStop} /></button>
        {:else}
          <button type="submit" class="go" aria-label={t('rt_go')} title={t('rt_go')}><Fa icon={iPlay} /></button>
        {/if}
      </form>

      <!-- 工具区: 第一行 监测点城市 + 无尽 + 设置齿轮; 齿轮展开第二行 MTR 设置 -->
      <div class="tools">
        <div class="trow">
          <button class="chip" class:on={probesOpen} onclick={() => (probesOpen = !probesOpen)} title={t('rt_probes')}>
            <Fa icon={iProbe} />
            <span class="cities">{probeChip.text}</span>{#if probeChip.more}<span class="more">+{probeChip.more}</span>{/if}
          </button>
          <select class="typesel" bind:value={mtr.type} title={t('rt_type')} aria-label={t('rt_type')}>
            <option value="ping">Ping</option>
            <option value="traceroute">Trace</option>
            <option value="mtr">MTR</option>
          </select>
          {#if mtr.type === 'ping'}
            <button class="iconchip sq" class:on={mtr.infinite} onclick={() => (mtr.infinite = !mtr.infinite)}
                    aria-pressed={mtr.infinite} aria-label={t('rt_infinite')} title={t('rt_infinite_hint')}>
              <Fa icon={iInfinity} />
            </button>
          {/if}
          <button class="iconchip sq" class:on={settingsOpen} onclick={() => (settingsOpen = !settingsOpen)}
                  aria-expanded={settingsOpen} aria-label={t('rt_settings')} title={t('rt_settings')}>
            <Fa icon={iGear} />
          </button>
        </div>
        {#if settingsOpen}
          <div class="settings">
            <div class="seg" role="group" aria-label={t('rt_proto')}>
              {#each protoOpts as p}
                <button class:on={mtr.proto === p} onclick={() => (mtr.proto = p)}>{p.toUpperCase()}</button>
              {/each}
            </div>
            <label class="field" class:off={!portOn}>
              <span>{t('rt_port')}</span>
              <input type="text" inputmode="numeric" maxlength="5" bind:value={mtr.port} disabled={!portOn} />
            </label>
            {#if packetsOn}
              <label class="field">
                <span>{t('rt_packets')}</span>
                <input type="text" inputmode="numeric" maxlength="2" bind:value={mtr.packets} />
              </label>
            {/if}
            <label class="field">
              <span>{t('rt_source')}</span>
              <select class="srcsel" bind:value={geoSource}>
                <option value="nexttrace">NextTrace</option>
                <option value="duckdb">{t('rt_source_builtin')}</option>
              </select>
            </label>
          </div>
        {/if}
      </div>

      <!-- 监测点选择(可展开, 带搜索) -->
      {#if probesOpen}
        <div class="probewrap">
          <!-- 筛选器: 搜索/输入 → dropdown 建议 → 追加; 或纯手打 magic 经 submit/回车 as-is 追加 -->
          <div class="psrow">
            <div class="probesearch">
              <Fa icon={iSearch} />
              <input type="text" bind:value={probeQuery} placeholder={t('rt_probe_search')}
                     spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"
                     onkeydown={onProbeKey} onfocus={() => (sugOpen = true)}
                     oninput={() => { sugOpen = true; sugHi = -1 }}
                     onblur={() => setTimeout(() => (sugOpen = false), 150)} />
            </div>
            <button class="pssubmit" onclick={() => addMagic(probeQuery)} disabled={!probeQuery.trim()}
                    title={t('rt_add')} aria-label={t('rt_add')}><Fa icon={iPlus} /></button>
            <button class="psclear" onclick={clearAllSel} disabled={!totalProbes}
                    title={t('rt_clear_sel')} aria-label={t('rt_clear_sel')}><Fa icon={iClear} /></button>
          </div>

          <!-- 建议下拉(城市 / 国家 / 网络) -->
          {#if sugOpen && probeQuery.trim() && sugHas}
            {@const cityN = suggest.cities.length}
            {@const ccN = suggest.countries.length}
            <ul class="suggest">
              {#each suggest.cities as c, i (c.id)}
                <li class="sgrp" class:hl={sugHi === i}>
                  <button onmousedown={(e) => { e.preventDefault(); addPick(cityPick(c.L)) }} onmouseenter={() => (sugHi = i)}>
                    <Fa icon={iCity} /><span class="sg-l">{c.label}</span><span class="sg-s">{c.sub}</span><span class="sg-n">{c.count}</span>
                  </button>
                </li>
              {/each}
              {#each suggest.countries as c, i (c.cc)}
                <li class="sgrp" class:hl={sugHi === cityN + i}>
                  <button onmousedown={(e) => { e.preventDefault(); addPick(magicPick(c.country, c.country)) }} onmouseenter={() => (sugHi = cityN + i)}>
                    <Fa icon={iCountry} /><span class="sg-l">{c.country}</span><span class="sg-s">{c.cc}</span><span class="sg-n">{c.n}</span>
                  </button>
                </li>
              {/each}
              {#each suggest.networks as nw, i (nw.asn)}
                <li class="sgrp" class:hl={sugHi === cityN + ccN + i}>
                  <button onmousedown={(e) => { e.preventDefault(); addPick(magicPick(nw.name, nw.name)) }} onmouseenter={() => (sugHi = cityN + ccN + i)}>
                    <Fa icon={iNet} /><span class="sg-l">{nw.name}</span><span class="sg-s">AS{nw.asn}</span><span class="sg-n">{nw.n}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}

          {#if locLoading}
            <div class="probemsg"><span class="spin"></span>{t('rt_loading_probes')}</div>
          {:else if locError}
            <div class="probemsg err">{t('rt_no_probes')}</div>
          {:else if picks.length}
            <!-- 已选条件 chips(append 列表): 每条带取样数步进 + 移除 -->
            <div class="chips">
              {#each picks as p (p.key)}
                <span class="chip2" class:net={p.kind !== 'city'}>
                  <span class="c2-l" title={p.label}>{p.label}</span>
                  <button class="c2-pm" onclick={() => setPickCount(p.key, (p.count || 1) - 1)} disabled={(p.count || 1) <= 1} aria-label="−">−</button>
                  <span class="c2-n">{p.count || 1}</span>
                  <button class="c2-pm" onclick={() => setPickCount(p.key, (p.count || 1) + 1)} aria-label="+">+</button>
                  <button class="c2-x" onclick={() => removePick(p.key)} aria-label={t('clear')}><Fa icon={iClose} /></button>
                </span>
              {/each}
            </div>
          {/if}
          <div class="poweredby">Powered by <a href="https://globalping.io" target="_blank" rel="noopener noreferrer">Globalping</a> × <a href="https://www.nxtrace.org" target="_blank" rel="noopener noreferrer">NextTrace</a></div>
        </div>
      {/if}

      <!-- 发起失败提示(配额/网络/未选点) -->
      {#if remoteLoading && !trace.probes.length}
        <div class="rtinfo"><span class="spin"></span>{t('rt_ntrace_loading')}</div>
      {:else if errMsg && !trace.probes.length}
        <div class="rterr">{errMsg}</div>
      {/if}

      <!-- 实时逐跳结果(开始跟踪后自动展开) -->
      {#if trace.probes.length}
        <div class="results">
            <!-- 头部一行: 目标 + 解析 IP + 归属地 + 进度 + 清除(域名无解析/无地理则 as-is, 只见目标) -->
            <div class="rhead">
              <button class="rtarget" onclick={() => trace.target?.ip && pick(trace.target.ip)}>{trace.target?.label || box}</button>
              {#if trace.target?.ip && trace.target.ip !== trace.target.label}
                <button class="rip" onclick={() => pick(trace.target.ip)} title={trace.target.ip}>{trace.target.ip}</button>
              {/if}
              {#if trace.target?.loc}<span class="rloc" title={trace.target.loc}><Fa icon={iLoc} />{trace.target.loc}</span>{/if}
              {#if loadedNTraceId}
                <a class="rsource" href={ntraceHtmlUrl || ('https://assets.nxtrace.org/tracemap/' + loadedNTraceId + '.html')}
                   target="_blank" rel="noopener noreferrer" title={ntraceGenerated || loadedNTraceId}>{t('rt_ntrace_loaded')}</a>
              {/if}
              <span class="rcount">{doneCount}/{trace.probes.length}</span>
              <button class="rclear" onclick={clearResults} title={t('rt_clear')} aria-label={t('rt_clear')}><Fa icon={iClear} /></button>
            </div>
            <div class="plist">
              {#each trace.probes as p (p.id)}
                {@const isPing = trace.type === 'ping'}
                {@const hops = p.hops}
                {@const st = p.stats}
                {@const done = p.status === 'done'}
                {@const tgtHop = hops.find(h => h.isTarget)}
                {@const reached = !!tgtHop}
                {@const phid = hiddenProbes.has(p.id)}
                {@const pasName = asnName(p.asn)}
                <div class="pcard" class:focus={focusId === p.id}
                     onmouseenter={() => (focusId = p.id)} onmouseleave={() => (focusId = null)} role="presentation">
                  <button class="prow" style:--pc={p.colorHex} onclick={() => toggleRow(p.id)}>
                    <!-- pdot: 平时是该监测点的色点; hover 显示眼睛 → 点一下切换它的路径在地球上的显隐 -->
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <span class="pdot" class:phid role="button" tabindex="0"
                          title={phid ? t('rt_show_path') : t('rt_hide_path')} aria-pressed={phid}
                          onclick={(e) => { e.stopPropagation(); toggleHidden(p.id) }}
                          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); toggleHidden(p.id) } }}>
                      <span class="pdot-c" style:background={p.colorHex}></span>
                      <span class="pdot-eye"><Fa icon={phid ? iLowvis : iVisible} /></span>
                    </span>
                    <span class="pname">
                      <span class="pcity">{p.city}</span>
                      <!-- AS 号 + 注册名/Org(对齐 SelfProbe 风格); 点击下钻 ASN 详情(stopPropagation 不展开行) -->
                      {#if p.asn}
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <span class="asbadge" role="button" tabindex="0"
                              title={'AS' + p.asn + (pasName ? ' · ' + pasName : '')}
                              onclick={(e) => { e.stopPropagation(); pick('AS' + p.asn) }}
                              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); pick('AS' + p.asn) } }}>
                          <span class="asnum">AS{p.asn}</span>{#if pasName}<span class="asname">{pasName}</span>{/if}
                        </span>
                      {/if}
                    </span>
                    <!-- 中间: 每个小点 = 一轮结果, 按延迟光谱蓝→绿→黄→红着色 -->
                    <span class="rounds">{#each p.rounds || [] as r}<i style:background={roundColor(r)}></i>{/each}</span>
                    <!-- 目标未响应(trace/mtr 到目标无回包)如实标「未响应」, 不再拿最后一个有回包的跳冒充目标延迟 -->
                    <span class="pstat" class:run={p.status === 'probing'} class:noresp={done && !isPing && !reached}>
                      {#if p.status !== 'done'}<span class="spin"></span>{isPing ? '' : hops.length}
                      {:else if isPing}{st ? st.avg : '—'}<u>ms</u>{#if st && st.loss}<b class="loss">{st.loss}%</b>{/if}
                      {:else if reached}{tgtHop.rtt ?? '—'}<u>ms</u>
                      {:else}{t('rt_noresp')}{/if}
                    </span>
                    <Fa icon={openRows.has(p.id) ? iChevD : iChevR} />
                  </button>
                  {#if openRows.has(p.id)}
                    {#if isPing}
                      <!-- ping: 不展示逐跳, 而是 stats 摘要 + 原始 rawOutput -->
                      <div class="pingdet">
                        {#if st}
                          <div class="pstats">
                            <span><i>min</i>{st.min}</span><span><i>avg</i>{st.avg}</span><span><i>max</i>{st.max}</span>
                            <span><i>rcv</i>{st.rcv}/{st.total}</span><span class:bad={st.loss}><i>loss</i>{st.loss}%</span>
                            {#if st.drop}<span class="bad"><i>drop</i>{st.drop}</span>{/if}
                          </div>
                        {/if}
                        {#if p.raw}<pre class="raw">{p.raw}</pre>{/if}
                      </div>
                    {:else}
                      {#if rawView.has(p.id) && p.raw}
                        <pre class="raw">{p.raw}</pre>
                      {:else}
                        <ol class="hops">
                          {#each hopList(hops) as row (row.key)}
                            {#if row.gap}
                              <!-- 中间被 * 省略的未响应跳: 折叠成一行「N 跳未响应」 -->
                              <li class="gaprow"><span class="hn">⋯</span><span class="gaptxt">{row.gap} {t('rt_hops_skipped')}</span></li>
                            {:else}
                              {@const h = row.h}
                              <li class:tgt={h.isTarget}>
                                <span class="hn">{h.idx}</span>
                                <span class="hip">
                                  <!-- IP 显示为 「rdns (ip)」(无 rdns 则仅 ip); 点击下钻前缀详情 -->
                                  <button class="hlink hip-ip" onclick={() => pick(h.ip)} title={h.rdns ? h.rdns + ' (' + h.ip + ')' : h.ip}>
                                    {#if h.rdns}<span class="rdns">{h.rdns}</span> <span class="ippar">({h.ip})</span>{:else}{h.ip}{/if}
                                  </button>
                                  {#if h.asn}
                                    <!-- 只放注册名/Org 名牌(去掉 ASxxxx); 无名时退回 AS 号当名牌文案。点击下钻 ASN 详情 -->
                                    <button class="hlink hip-asn" onclick={() => pick('AS' + h.asn)} title={'AS' + h.asn + (h.name ? ' · ' + h.name : '')}>
                                      <span class="asname">{h.name || 'AS' + h.asn}</span>
                                    </button>
                                  {/if}
                                </span>
                                <span class="hgeo">{h.city || h.cc || ''}</span>
                                <span class="hrtt">{h.rtt == null ? '*' : h.rtt}<u>{h.rtt == null ? '' : 'ms'}</u>{#if h.loss}<b class="loss">{h.loss}%</b>{/if}</span>
                              </li>
                            {/if}
                          {/each}
                          <!-- 目标始终没回包: 末尾补一行标注目标未响应 -->
                          {#if done && !reached}
                            <li class="tgt">
                              <span class="hn">·</span>
                              <span class="hip">
                                {#if trace.target?.ip}<button class="hlink hip-ip" onclick={() => pick(trace.target.ip)}>{trace.target.ip}</button>{:else}<span class="hip-ip">{trace.target?.label || box}</span>{/if}
                              </span>
                              <span class="hgeo">{trace.target?.city || ''}</span>
                              <span class="hrtt noresp">{t('rt_noresp')}</span>
                            </li>
                          {/if}
                        </ol>
                      {/if}
                      <!-- 灯箱式切换点: 逐跳 ↔ 原始输出 -->
                      {#if p.raw}
                        <div class="viewdots" role="group" aria-label="{t('rt_view_hops')} / {t('rt_view_raw')}">
                          <button class="vdot" class:on={!rawView.has(p.id)} onclick={() => setRawView(p.id, false)}
                                  title={t('rt_view_hops')} aria-label={t('rt_view_hops')} aria-pressed={!rawView.has(p.id)}></button>
                          <button class="vdot" class:on={rawView.has(p.id)} onclick={() => setRawView(p.id, true)}
                                  title={t('rt_view_raw')} aria-label={t('rt_view_raw')} aria-pressed={rawView.has(p.id)}></button>
                        </div>
                      {/if}
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>
        </div>
      {/if}

      <!-- 右下角缩放手柄: 仅在有结果时出现(无结果时缩放只会拉出空白) -->
      {#if trace.probes.length}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="grip" onpointerdown={startResize} title={t('rt_resize')} aria-hidden="true"></div>
      {/if}
    </div>
  </div>

  <!-- 历史下拉(渲染在面板外, 避开浮窗 overflow/backdrop-filter 裁切; 位置由输入框实时测得) -->
  {#if dropOpen && matches.length}
    <ul class="hist" id="rt-hist" style:left="{dropRect.left}px" style:width="{dropRect.width}px"
        style:top={dropRect.up ? null : dropRect.top + 'px'} style:bottom={dropRect.up ? dropRect.bottom + 'px' : null}>
      <div class="histscroll">
        {#each matches as h, i (h)}
          <li class="histrow" class:hl={i === hi}>
            <button type="button" class="histmain" onmousedown={(e) => { e.preventDefault(); pickHistory(h) }} onmouseenter={() => (hi = i)}>
              <Fa icon={iClock} /> <span>{h}</span>
            </button>
            <button type="button" class="histdel" tabindex="-1" aria-label={t('clear')} onmousedown={(e) => { e.preventDefault(); e.stopPropagation(); removeHistory(h) }}><Fa icon={iClose} /></button>
          </li>
        {/each}
      </div>
      <li class="histclear">
        <button type="button" onmousedown={(e) => { e.preventDefault(); clearAllHistory() }}><Fa icon={iClear} /> {t('rt_hist_clear')}</button>
      </li>
    </ul>
  {/if}

  <!-- 探测点光点交互 popup: 点城市名 = 追加该城市(随机); 点某网络 = 追加「城市+该供应商」。纯 append。 -->
  {#if hoverLoc}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="locpop" class:below={popBelow} style:left="{popX}px" style:top="{popY}px"
         transition:fade={{ duration: 120 }}
         onmouseenter={() => { popPinned = true }}
         onmouseleave={() => { popPinned = false; hoverLoc = null }}>
      <!-- 地点头: 点 + 加一个(无则新建); 已选则 −/数量/+ 步进; × 清空该地点全部选择(城市 + 其网络) -->
      <div class="lp-head">
        <span class="lp-city">{hoverLoc.city}<i class="lp-cc">{hoverLoc.cc}</i></span>
        {#if locCityCount(hoverLoc.id) > 0}
          <span class="lp-steps">
            <button class="lp-pm" onclick={() => locDec(hoverLoc)} aria-label="−">−</button>
            <span class="lp-n">{locCityCount(hoverLoc.id)}</span>
            <button class="lp-pm" onclick={() => locInc(hoverLoc)} aria-label="+">+</button>
          </span>
        {:else}
          <button class="lp-addbtn" onclick={() => locInc(hoverLoc)} title={t('rt_add')}>
            <Fa icon={iPlus} /><span class="lp-av">{hoverLoc.count}</span>
          </button>
        {/if}
        {#if cityCount[hoverLoc.id]}
          <button class="lp-clr" onclick={() => locClear(hoverLoc.id)} title={t('rt_clear_sel')} aria-label={t('rt_clear_sel')}><Fa icon={iClose} /></button>
        {/if}
      </div>
      <!-- 指定网络(点击即追加 magic "城市+ASxxx", 精确从该供应商发起) -->
      {#if hoverLoc.networks?.length}
        <div class="lp-list">
          {#each hoverLoc.networks as nw (nw.asn)}
            <button class="lp-item" onclick={() => locAddNet(hoverLoc, nw)} title={nw.name}>
              <span class="lp-net">{nw.name}</span>
              <span class="lp-asn">AS{nw.asn}<i class="lp-x">×{nw.n}</i></span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</main>

<style>
  /* 视图: 深空底 + 点阵网格 + 顶部 accent 辉光(同 WhoisView 约定) */
  .rtv {
    flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh;
    position: relative; overflow: hidden; container-type: inline-size;
    background:
      radial-gradient(1200px 520px at 76% -160px, var(--accent-dim), transparent 70%),
      radial-gradient(rgba(125,200,190,.05) 1px, transparent 1px) 0 0 / 22px 22px,
      var(--bg);
  }

  /* ── 地球 stage ── 占满整个视图(球心偏右、半径盖住视口 → 看不到圆盘边, 无背景割裂);
     球的偏移/大小在引擎(traceglobe.js resize)里定。 ── */
  .globe-stage {
    position: absolute; inset: 0; z-index: 1;
    transform: scale(1); opacity: 1; transform-origin: 57% 50%;
    transition: transform 1.1s cubic-bezier(.22,.61,.36,1), opacity .9s ease;
    will-change: transform, opacity;
  }
  .globe-stage :global(.tglobe) { width: 100%; height: 100%; }
  /* 命中层不裁切: 整个视图都可拖动/缩放地球(像谷歌地球); HUD 空白处 pointer-events:none 穿透到此层,
     仅浮窗面板/下拉拦截事件 → 其余随处可拖。 */
  /* 入场前: 略放大 + 透明 → 加 .in 收回就位淡入(始终盖住视口, 不闪出球缘) */
  .globe-stage:not(.in) { transform: scale(1.08); opacity: 0; }
  .globe-stage.booting { transition: none; }

  /* ── 左侧指挥台 HUD ── 可自由拖动 / 右下角缩放的玻璃浮窗; 入场从左滑入淡入 ── */
  .hud {
    position: absolute; inset: 0; z-index: 3; pointer-events: none;   /* 仅面板接事件; 留白处穿透到地球(随处可拖) */
    opacity: 0; transform: translateX(-18px); transition: opacity .7s ease .15s, transform .7s cubic-bezier(.22,.61,.36,1) .15s;
  }
  .hud.in { opacity: 1; transform: none; }
  .hud.booting { transition: none; }
  .hud .panel { pointer-events: auto; }

  .panel {
    position: absolute;                          /* left/top/width/height 由 win 状态驱动 */
    background: color-mix(in srgb, var(--panel) 82%, transparent);
    border: 1px solid var(--line); border-radius: 16px;
    box-shadow: 0 30px 70px -36px rgba(0,0,0,.7), inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
    backdrop-filter: blur(16px) saturate(1.2); -webkit-backdrop-filter: blur(16px) saturate(1.2);
    padding: 8px 18px 18px; display: flex; flex-direction: column; gap: 12px;
    max-height: calc(100dvh - 24px); overflow: hidden; will-change: left, top, width, height;
  }
  .panel.dragging { user-select: none; }

  /* 右下角缩放手柄: 命中区扩到整个角(含 padding), 视觉刻线只画在内侧 → 点到 padding 也能缩放 */
  .grip {
    position: absolute; right: 0; bottom: 0; width: 28px; height: 28px; z-index: 3;
    cursor: nwse-resize; touch-action: none;
  }
  .grip::after {
    content: ''; position: absolute; right: 7px; bottom: 7px; width: 13px; height: 13px;
    border-right: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    border-bottom: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    border-radius: 0 0 6px 0; opacity: .5; transition: opacity .14s;
  }
  .grip:hover::after { opacity: 1; }

  /* 顶部拖动示意: 两道浅色横杠(整块面板非交互区域均可拖动) */
  .draghandle { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 2px 0 1px; cursor: move; touch-action: none; }
  .draghandle span { width: 30px; height: 2px; border-radius: 2px; background: color-mix(in srgb, var(--muted) 40%, transparent); transition: background .15s; }
  .panel:hover .draghandle span { background: color-mix(in srgb, var(--muted) 65%, transparent); }

  /* 命令行输入(同首页 console 约定: 高 54, 圆角 13) */
  .console {
    flex: 0 0 auto;                       /* 固定 54 高, 永不被 flex 挤压变矮 */
    display: flex; align-items: center; gap: 8px; padding: 0 7px; height: 54px;
    background: var(--inbg); border: 1px solid var(--line); border-radius: 13px;
    box-shadow: 0 12px 34px -22px rgba(0,0,0,.6); transition: border-color .15s, box-shadow .15s;
  }
  .console:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-dim), 0 12px 34px -22px rgba(0,0,0,.6); }
  /* 左侧地址族切换: 正方形, 点击轮换 自动/IPv4/IPv6, 字距紧凑 */
  .fam {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 40px; padding: 0; border-radius: 9px; cursor: pointer;
    background: var(--alt); border: 1px solid var(--line); color: var(--muted);
    font: 800 10.5px var(--mono); letter-spacing: -.04em; transition: all .14s;
  }
  .fam:hover { color: var(--fg); border-color: var(--accent); }
  .fam.act { background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 40%, transparent); color: var(--accent); }
  .fam:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-dim); }
  .cmd { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; font: 500 16px var(--mono); color: var(--fg); letter-spacing: -.005em; height: 24px; }
  .cmd::placeholder { color: var(--muted); opacity: .7; font-family: var(--sans); font-size: 14px; }
  .go {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; padding: 0;
    background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 10px;
    cursor: pointer; box-shadow: 0 2px 14px var(--accent-dim); transition: filter .12s, transform .05s;
  }
  .go:hover { filter: brightness(1.08); } .go:active { transform: translateY(1px); }
  .go :global(svg) { width: 12px; }
  .go.stop { background: color-mix(in srgb, var(--signal) 90%, #000); color: #1a1206; box-shadow: 0 2px 14px color-mix(in srgb, var(--signal) 30%, transparent); }
  .icon { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 8px; cursor: pointer; background: transparent; color: var(--muted); border: 1px solid transparent; transition: all .12s; }
  .icon:hover { color: var(--fg); background: var(--alt); border-color: var(--line); }
  .icon :global(svg) { width: 12px; }

  /* 工具区: 第一行(城市/无尽/齿轮) + 可展开的第二行(MTR 设置) */
  .tools { flex: 0 0 auto; display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
  .trow { display: flex; align-items: center; gap: 8px; }
  .chip, .iconchip {
    display: inline-flex; align-items: center; height: 34px;
    background: var(--alt); border: 1px solid var(--line); border-radius: 9px; color: var(--fg);
    font: 600 12.5px var(--sans); cursor: pointer; transition: all .14s;
  }
  .chip { flex: 1 1 auto; min-width: 0; gap: 8px; padding: 0 12px; }     /* 城市芯片占满本行剩余宽度 */
  .iconchip { flex: 0 0 auto; gap: 6px; padding: 0 11px; font-size: 12px; }
  .iconchip.sq { width: 34px; padding: 0; justify-content: center; }
  .chip :global(svg), .iconchip :global(svg) { width: 12px; color: var(--muted); flex: 0 0 auto; }
  .chip:hover, .iconchip:hover { border-color: var(--accent); }
  .chip.on, .iconchip.on { background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 38%, transparent); color: var(--accent); }
  .chip.on :global(svg), .iconchip.on :global(svg) { color: var(--accent); }
  .chip .cities { flex: 1 1 auto; min-width: 0; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chip .more { flex: 0 0 auto; font: 700 11px var(--mono); color: var(--muted); }
  .chip.on .more { color: var(--accent); }
  /* 测量类型下拉(Ping/Trace/MTR): 原生 select(下拉不被面板裁切), 外观对齐 chip + 自绘 ▾ */
  .typesel {
    flex: 0 0 auto; height: 34px; padding: 0 23px 0 10px; border-radius: 9px;
    background-color: var(--alt); border: 1px solid var(--line); color: var(--fg);
    font: 700 12px var(--mono); letter-spacing: .02em; cursor: pointer; appearance: none; -webkit-appearance: none; outline: none;
    background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
    background-position: calc(100% - 13px) center, calc(100% - 9px) center; background-size: 4px 4px; background-repeat: no-repeat;
    transition: border-color .14s;
  }
  .typesel:hover { border-color: var(--accent); }
  .typesel:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }

  /* MTR 设置行 */
  .settings { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--alt) 60%, transparent); animation: drop .16s ease; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--inbg); }
  .seg button { background: transparent; border: 0; padding: 6px; font: 700 11.5px var(--mono); letter-spacing: .05em; color: var(--muted); cursor: pointer; transition: all .12s; }
  .seg button + button { border-left: 1px solid var(--line); }
  .seg button:hover { color: var(--fg); }
  .seg button.on { background: var(--accent); color: var(--accent-fg); }
  .field { display: inline-flex; align-items: center; gap: 6px; font: 600 11.5px var(--sans); color: var(--muted); }
  .field span { white-space: nowrap; }
  .field input { width: 56px; height: 28px; border: 1px solid var(--line); border-radius: 7px; background: var(--inbg); color: var(--fg); font: 500 13px var(--mono); padding: 0 8px; outline: none; transition: border-color .12s; }
  .field input:focus { border-color: var(--accent); }
  .field.off { opacity: .4; }
  /* GeoIP 数据源选择 + token 输入(settings 内) */
  .srcsel {
    height: 28px; padding: 0 22px 0 8px; border-radius: 7px; border: 1px solid var(--line);
    background-color: var(--inbg); color: var(--fg); font: 600 11.5px var(--sans); cursor: pointer;
    appearance: none; -webkit-appearance: none; outline: none;
    background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
    background-position: calc(100% - 12px) center, calc(100% - 8px) center; background-size: 4px 4px; background-repeat: no-repeat;
    transition: border-color .12s;
  }
  .srcsel:hover, .srcsel:focus-visible { border-color: var(--accent); }

  /* 监测点选择(搜索框 + 网格) */
  .probewrap { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; animation: drop .18s ease; }
  .poweredby { text-align: center; padding-top: 2px; font: 500 10.5px var(--sans); color: var(--muted); opacity: .8; }
  .poweredby a { color: var(--muted); text-decoration: none; border-bottom: 1px dotted color-mix(in srgb, var(--muted) 50%, transparent); }
  .poweredby a:hover { color: var(--accent); border-bottom-color: var(--accent); }
  .psrow { display: flex; align-items: center; gap: 6px; }
  .psrow .probesearch { flex: 1 1 auto; min-width: 0; }
  .psclear { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: var(--alt); border: 1px solid var(--line); color: var(--muted); cursor: pointer; transition: all .12s; }
  .psclear:hover:not(:disabled) { color: #ef4444; border-color: color-mix(in srgb, #ef4444 45%, var(--line)); }
  .psclear:disabled { opacity: .35; cursor: default; }
  .psclear :global(svg) { width: 12px; }
  .probesearch { display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 10px; background: var(--inbg); border: 1px solid var(--line); border-radius: 8px; }
  .probesearch :global(svg) { width: 11px; color: var(--muted); flex: 0 0 auto; }
  .probesearch input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--fg); font: 500 13px var(--mono); }
  .probesearch input::placeholder { color: var(--muted); font-family: var(--sans); font-size: 12.5px; }
  @keyframes drop { from { opacity: 0; transform: translateY(-6px); } }
  /* submit(追加当前输入为 magic)按钮 */
  .pssubmit { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 8px; background: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 60%, #000); color: var(--accent-fg); cursor: pointer; transition: filter .12s, opacity .12s; }
  .pssubmit:hover:not(:disabled) { filter: brightness(1.08); }
  .pssubmit:disabled { opacity: .4; cursor: default; }
  .pssubmit :global(svg) { width: 11px; }
  /* 建议下拉(城市/国家/网络) */
  .suggest { list-style: none; margin: 0; padding: 4px; display: flex; flex-direction: column; gap: 1px; max-height: 240px; overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--inbg); animation: drop .14s ease; }
  .sgrp button { width: 100%; display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 7px; background: transparent; border: 0; cursor: pointer; text-align: left; }
  .sgrp button :global(svg) { width: 11px; color: var(--muted); }
  .sgrp.hl button, .sgrp button:hover { background: var(--alt); }
  .sg-l { font: 600 12.5px var(--sans); color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sg-s { font: 500 11px var(--mono); color: var(--muted); white-space: nowrap; }
  .sg-n { font: 600 10.5px var(--mono); color: var(--accent); }
  /* 已选条件 chips(append 列表) */
  .chips { display: flex; flex-wrap: wrap; gap: 6px; max-height: 156px; overflow: auto; padding: 1px; animation: drop .16s ease; }
  .chip2 { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 9px; border-radius: 8px; background: var(--accent-dim); border: 1px solid color-mix(in srgb, var(--accent) 38%, transparent); }
  .chip2.net { background: color-mix(in srgb, var(--signal) 14%, transparent); border-color: color-mix(in srgb, var(--signal) 36%, transparent); }
  .c2-l { font: 600 12px var(--sans); color: var(--fg); max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .c2-pm { width: 18px; height: 18px; border-radius: 5px; border: 0; background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); font: 700 13px var(--sans); line-height: 1; cursor: pointer; }
  .c2-pm:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 30%, transparent); }
  .c2-pm:disabled { opacity: .3; cursor: default; }
  .c2-n { min-width: 12px; text-align: center; font: 600 11px var(--mono); color: var(--fg); }
  .c2-x { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 5px; border: 0; background: transparent; color: var(--muted); cursor: pointer; }
  .c2-x:hover { color: #ef4444; background: color-mix(in srgb, #ef4444 14%, transparent); }
  .c2-x :global(svg) { width: 8px; }

  /* 结果区 */
  .results { flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow: auto; padding-right: 2px; animation: drop .2s ease; }

  /* 历史下拉(渲染在面板外 → 绝对定位于 .rtv, 不被浮窗 overflow/backdrop-filter 裁切) */
  .hist {
    position: absolute; z-index: 6; margin: 0; padding: 5px; list-style: none; overflow: hidden;
    background: color-mix(in srgb, var(--panel) 92%, transparent); border: 1px solid var(--line); border-radius: 11px;
    box-shadow: 0 22px 50px -20px rgba(0,0,0,.6); backdrop-filter: blur(16px) saturate(1.2); -webkit-backdrop-filter: blur(16px) saturate(1.2);
    animation: drop .14s ease;
  }
  .histscroll { max-height: 240px; overflow: auto; }   /* 历史项滚动区, 高度有上限 */
  /* 底部「清空历史」固定项 */
  .histclear { margin-top: 4px; border-top: 1px solid var(--line2); padding-top: 4px; }
  .histclear button {
    width: 100%; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    background: transparent; border: 0; cursor: pointer; padding: 7px 9px; border-radius: 8px;
    color: var(--muted); font: 600 12px var(--sans); transition: all .12s;
  }
  .histclear button:hover { color: #ef4444; background: color-mix(in srgb, #ef4444 10%, transparent); }
  .histclear :global(svg) { width: 11px; }
  .histrow { display: flex; align-items: center; border-radius: 8px; }
  .histrow.hl { background: var(--accent-dim); }
  .histmain {
    flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 9px; text-align: left;
    background: transparent; border: 0; cursor: pointer; padding: 8px 9px; color: var(--fg); font: 500 13.5px var(--mono);
  }
  .histmain :global(svg) { width: 11px; color: var(--muted); flex: 0 0 auto; }
  .histmain span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .histrow.hl .histmain :global(svg) { color: var(--accent); }
  .histdel {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
    margin-right: 3px; border-radius: 7px; cursor: pointer; background: transparent; border: 0; color: var(--muted);
    opacity: 0; transition: opacity .12s, color .12s, background .12s;
  }
  .histrow:hover .histdel, .histrow.hl .histdel { opacity: .7; }
  .histdel:hover { color: var(--fg); background: var(--alt); opacity: 1; }
  .histdel :global(svg) { width: 9px; }

  /* 探测点光点交互 popup(渲染在面板外, 绝对定位于 .rtv 即视口) */
  .locpop {
    position: absolute; z-index: 7; width: 224px;
    transform: translate(-50%, calc(-100% - 9px));       /* 默认浮在光点上方 */
    background: color-mix(in srgb, var(--panel) 92%, transparent);
    border: 1px solid var(--line); border-radius: 11px; overflow: hidden;
    box-shadow: 0 22px 50px -20px rgba(0,0,0,.6);
    backdrop-filter: blur(16px) saturate(1.2); -webkit-backdrop-filter: blur(16px) saturate(1.2);
  }
  .locpop.below { transform: translate(-50%, 15px); }    /* 光点靠顶时改到下方 */
  /* popup 头部 = 地点选择控件(−/数量/+ 步进 或 +添加; × 清空该地点全部选择) */
  .lp-head { display: flex; align-items: center; gap: 8px; padding: 8px 11px; border-bottom: 1px solid var(--line2); }
  .lp-city { flex: 1 1 auto; min-width: 0; font: 700 13px var(--sans); color: var(--fg); display: inline-flex; align-items: center; gap: 6px; }
  .lp-cc { flex: 0 0 auto; font: 600 10px var(--mono); letter-spacing: .05em; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; font-style: normal; }
  /* 已选: −/数量/+ 步进(同 probewrap chip2) */
  .lp-steps { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px; }
  .lp-pm { width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; border: 0; background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); font: 700 14px var(--sans); line-height: 1; cursor: pointer; transition: background .1s; }
  .lp-pm:hover { background: color-mix(in srgb, var(--accent) 30%, transparent); }
  .lp-n { min-width: 14px; text-align: center; font: 700 12px var(--mono); color: var(--accent); }
  /* 未选: + 添加(右侧小数字 = 该地点可用探测点数) */
  .lp-addbtn { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 7px; background: var(--accent); border: 0; color: var(--accent-fg); cursor: pointer; font: 700 11px var(--mono); transition: filter .1s; }
  .lp-addbtn:hover { filter: brightness(1.08); }
  .lp-addbtn :global(svg) { width: 9px; }
  .lp-av { font: 700 11px var(--mono); }
  /* 清空该地点全部选择 */
  .lp-clr { flex: 0 0 auto; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; border: 0; background: transparent; color: var(--muted); cursor: pointer; transition: color .1s, background .1s; }
  .lp-clr:hover { color: #ef4444; background: color-mix(in srgb, #ef4444 14%, transparent); }
  .lp-clr :global(svg) { width: 9px; }
  .lp-list { max-height: 248px; overflow: auto; padding: 4px; display: flex; flex-direction: column; gap: 2px; }
  .lp-item { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 7px; background: transparent; border: 0; cursor: pointer; text-align: left; transition: background .1s; }
  .lp-item:hover { background: var(--alt); }
  .lp-net { font: 600 12.5px var(--sans); color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lp-asn { font: 500 11px var(--mono); color: var(--muted); white-space: nowrap; }
  .lp-asn .lp-x { font-style: normal; margin-left: 4px; opacity: .7; }
  /* 监测点加载 / 失败提示 */
  .probemsg { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 18px 0; font: 500 12.5px var(--sans); color: var(--muted); }
  .probemsg.err { color: #ef4444; }
  .rtinfo { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 9px; background: color-mix(in srgb, var(--accent) 8%, transparent); color: var(--muted); font: 500 12.5px var(--sans); animation: drop .16s ease; }
  /* 发起失败提示条 */
  .rterr { flex: 0 0 auto; padding: 9px 12px; border: 1px solid color-mix(in srgb, #ef4444 40%, var(--line)); border-radius: 9px; background: color-mix(in srgb, #ef4444 10%, transparent); color: #ef4444; font: 500 12.5px var(--sans); animation: drop .16s ease; }
  /* 头部一行: 目标 / 解析 IP / 归属地 / 进度 / 清除 —— 全在 rhead 内, 不换行 */
  .rhead { display: flex; align-items: center; gap: 8px; font: 600 12px var(--mono); color: var(--muted); border-bottom: 1px solid var(--line2); padding-bottom: 7px; }
  .rtarget { flex: 0 1 auto; min-width: 32px; background: transparent; border: 0; padding: 0; cursor: pointer; color: var(--link); font: 600 12px var(--mono); text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rtarget:hover { text-decoration: underline; }
  .rip { flex: 0 1 auto; min-width: 0; background: transparent; border: 0; padding: 0; cursor: pointer; color: var(--link); font: 500 12px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rip:hover { text-decoration: underline; }
  .rloc { flex: 1 1 auto; display: inline-flex; align-items: center; gap: 4px; min-width: 0; font: 500 11.5px var(--sans); color: var(--muted); overflow: hidden; white-space: nowrap; }
  .rloc :global(svg) { width: 9px; flex: 0 0 auto; }
  .rsource { flex: 0 0 auto; color: var(--accent); text-decoration: none; font: 600 11px var(--sans); border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-radius: 999px; padding: 2px 7px; white-space: nowrap; }
  .rsource:hover { background: var(--accent-dim); }
  .rcount { flex: 0 0 auto; margin-left: auto; }
  .rclear { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; background: transparent; border: 0; color: var(--muted); cursor: pointer; transition: color .12s; }
  .rclear:hover { color: var(--fg); }
  .rclear :global(svg) { width: 11px; }

  .plist { display: flex; flex-direction: column; gap: 5px; }
  .pcard { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: color-mix(in srgb, var(--panel) 50%, transparent); transition: border-color .15s, box-shadow .15s; }
  .pcard.focus { border-color: var(--pc, var(--accent)); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent); }
  .prow {
    width: 100%; display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto; align-items: center; gap: 9px;
    background: transparent; border: 0; cursor: pointer; padding: 9px 11px; text-align: left; color: var(--fg);
  }
  .prow :global(svg) { width: 10px; color: var(--muted); }
  /* pdot = 隐藏切换钮: 平时显色点, hover 浮现眼睛(示意可点切换地球上该路径显隐) */
  .pdot {
    position: relative; width: 16px; height: 16px; flex: 0 0 auto; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center; border-radius: 50%;
    transition: background .14s;
  }
  .pdot:hover { background: color-mix(in srgb, var(--fg) 9%, transparent); }
  .pdot-c { width: 9px; height: 9px; border-radius: 50%; transition: opacity .14s; }
  .pdot-eye {
    position: absolute; inset: 0; display: inline-flex; align-items: center; justify-content: center;
    opacity: 0; transition: opacity .14s; pointer-events: none;
  }
  .pdot :global(svg) { width: 11px; height: 11px; color: var(--fg); }
  .pdot:hover .pdot-c { opacity: 0; }
  .pdot:hover .pdot-eye { opacity: 1; }
  /* 已隐藏态: 常显划线眼睛 + 色点压暗, 明确标示该路径已从地球移除 */
  .pdot.phid .pdot-c { opacity: .25; }
  .pdot.phid .pdot-eye { opacity: .85; }
  .pdot.phid:hover .pdot-eye { opacity: 1; }
  .pname { font: 600 13px var(--sans); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; min-width: 0; }
  .pcity { flex: 0 0 auto; }

  /* ASxxxx + 注册名/Org 名牌(对齐 SelfProbe): probe 名里的 AS(.asbadge, 可点) + 每跳的 AS(.hip-asn) 共用 */
  .asbadge { display: inline-flex; align-items: center; gap: 5px; min-width: 0; cursor: pointer; }
  .asbadge:hover .asnum { text-decoration: underline; text-underline-offset: 2px; }
  .asnum { flex: 0 0 auto; font: 600 11.5px var(--mono); color: var(--link); }
  .asname {
    flex: 0 1 auto; font: 600 10px var(--sans); color: var(--muted); line-height: 1;
    background: var(--alt); border: 1px solid var(--line); border-radius: 5px; padding: 2px 5px;
    max-width: 124px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* 中间: 每轮结果小点(比 pdot 小, 不发光), 按光谱着色; 溢出时显示最新的(靠右) */
  .rounds { display: flex; align-items: center; justify-content: flex-end; gap: 3px; min-width: 0; overflow: hidden; }
  .rounds i { flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%; }
  .pstat { font: 600 11.5px var(--mono); color: var(--accent); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .pstat u { color: var(--muted); text-decoration: none; font-size: 9.5px; margin-left: 1px; }
  .pstat.run { color: var(--signal); }
  .spin, .pstat .spin { width: 10px; height: 10px; border-radius: 50%; border: 1.6px solid color-mix(in srgb, var(--signal) 30%, transparent); border-top-color: var(--signal); display: inline-block; animation: sp .7s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }

  .hops { list-style: none; margin: 0; padding: 2px 11px 10px; display: flex; flex-direction: column; gap: 3px; border-top: 1px solid var(--line2); }
  .hops li { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto auto; align-items: center; gap: 8px; padding: 2px 0; animation: hopin .25s ease; }
  @keyframes hopin { from { opacity: 0; transform: translateX(-5px); } }
  .hn { font: 600 11px var(--mono); color: var(--muted); text-align: right; }
  /* IP 与 ASN 各自独立可点(分别导航到前缀 / ASN 详情) */
  .hip { min-width: 0; display: inline-flex; align-items: baseline; gap: 6px; overflow: hidden; }
  .hlink { background: transparent; border: 0; padding: 0; cursor: pointer; text-align: left; font-family: var(--mono); }
  .hip-ip { flex: 0 1 auto; min-width: 0; font: 500 12px var(--mono); color: var(--link); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hip-ip .rdns { color: var(--link); }                       /* rdns 为主, IP 跟在括号里弱化 */
  .hip-ip .ippar { color: var(--muted); font-size: 11px; }
  .hip-ip:hover .rdns, .hip-ip:hover { text-decoration: underline; }
  /* AS 名牌(hops 里只放注册名/Org 名牌): hover 高亮名牌本身 */
  .hip-asn { flex: 0 0 auto; display: inline-flex; align-items: center; min-width: 0; }
  .hip-asn:hover .asname { color: var(--link); border-color: color-mix(in srgb, var(--link) 45%, var(--line)); }
  .hops li.tgt .hip-ip, .hops li.tgt .hip-ip .rdns { color: var(--signal); }
  .hgeo { font: 500 11px var(--sans); color: var(--muted); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 96px; justify-self: end; }
  .hrtt { font: 600 11.5px var(--mono); color: var(--fg); text-align: right; white-space: nowrap; }
  .hrtt u { color: var(--muted); text-decoration: none; font-size: 9.5px; margin-left: 1px; }
  .hrtt .loss { color: #ef4444; margin-left: 5px; font-size: 10px; }
  .pstat .loss { color: #ef4444; font: 600 10px var(--mono); }

  /* 目标未响应: 概要列与逐跳末行的延迟列均如实标「未响应」, 灰显与有效延迟区分(不再冒充末跳延迟) */
  .pstat.noresp { color: var(--muted); font-weight: 600; font-size: 11px; letter-spacing: .02em; }
  .hrtt.noresp { color: var(--muted); font-weight: 600; font-size: 10.5px; }

  /* 中间被 * 省略的未响应跳: 折叠成一行「N 跳未响应」(两列: 序号占位 + 文案) */
  .gaprow { grid-template-columns: 16px 1fr !important; opacity: .72; }
  .gaptxt { font: 500 10.5px var(--sans); font-style: italic; color: var(--muted); }

  /* 非 ping 逐跳详情里切到原始输出: 与 .hops 一致的内边距/上分隔 */
  .pcard > .raw { margin: 7px 11px 4px; }

  /* 灯箱式视图切换点(逐跳 ↔ 原始输出) */
  .viewdots { display: flex; justify-content: center; gap: 7px; padding: 5px 0 9px; }
  .vdot {
    width: 7px; height: 7px; padding: 0; border-radius: 50%; cursor: pointer;
    border: 1px solid color-mix(in srgb, var(--muted) 55%, transparent); background: transparent;
    transition: background .15s, border-color .15s, transform .15s;
  }
  .vdot:hover { border-color: var(--accent); transform: scale(1.18); }
  .vdot.on { background: var(--accent); border-color: var(--accent); }

  /* ping 详情: stats 摘要 + 原始输出(rawOutput) */
  .pingdet { border-top: 1px solid var(--line2); padding: 8px 11px 10px; display: flex; flex-direction: column; gap: 7px; }
  .pstats { display: flex; flex-wrap: wrap; gap: 5px 7px; }
  .pstats span { display: inline-flex; align-items: baseline; gap: 4px; padding: 2px 7px; border-radius: 6px; background: color-mix(in srgb, var(--alt) 70%, transparent); border: 1px solid var(--line); font: 600 11.5px var(--mono); color: var(--fg); }
  .pstats span i { font: 600 9.5px var(--sans); font-style: normal; letter-spacing: .03em; color: var(--muted); text-transform: uppercase; }
  .pstats span.bad { color: #ef4444; border-color: color-mix(in srgb, #ef4444 40%, var(--line)); }
  .pstats span.bad i { color: color-mix(in srgb, #ef4444 70%, var(--muted)); }
  .raw { margin: 0; padding: 9px 11px; border-radius: 8px; background: var(--inbg); border: 1px solid var(--line); color: var(--fg); font: 500 11.5px var(--mono); line-height: 1.5; white-space: pre-wrap; word-break: break-all; overflow-x: auto; max-height: 220px; overflow-y: auto; }

  /* 右下角控制组: 复位 + 2D/3D 投影切换。玻璃小分段, 与 HUD 同语言 */
  .projctl {
    position: absolute; right: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); z-index: 4;
    display: flex; align-items: center; gap: 8px;
    opacity: 0; transition: opacity .7s ease .3s;
  }
  .projctl.in { opacity: 1; }
  .projctl > .reset, .projsel {
    display: flex; gap: 2px; padding: 3px; border-radius: 11px;
    background: color-mix(in srgb, var(--panel) 80%, transparent);
    border: 1px solid var(--line);
    backdrop-filter: blur(12px) saturate(1.2); -webkit-backdrop-filter: blur(12px) saturate(1.2);
    box-shadow: 0 18px 44px -26px rgba(0,0,0,.65);
  }
  /* 复位按钮: 单独的玻璃方块 */
  .projctl > .reset {
    width: 36px; height: 36px; align-items: center; justify-content: center; padding: 0;
    cursor: pointer; color: var(--muted); transition: background .14s, color .14s;
  }
  .projctl > .reset:hover { color: var(--accent); background: color-mix(in srgb, var(--accent-dim) 70%, var(--panel)); }
  .projctl > .reset.on { color: var(--accent); background: var(--accent-dim); }
  .projctl > .reset:active { transform: translateY(1px); }
  .projctl > .reset :global(svg) { width: 14px; }
  .projsel button {
    width: 38px; height: 30px; border: 0; border-radius: 8px; cursor: pointer;
    background: transparent; color: var(--muted); font: 800 11px var(--mono); letter-spacing: -.02em;
    transition: background .14s, color .14s;
  }
  .projsel button:hover { color: var(--fg); }
  .projsel button.on { background: var(--accent-dim); color: var(--accent); }

  /* 窄屏: 浮窗背景更实, 地球退作背景 */
  @container (max-width: 900px) {
    .panel { background: color-mix(in srgb, var(--panel) 92%, transparent); }
  }

  /* 移动端: 面板锁定在底部、不可拖动/缩放; 反转布局让输入在底、结果向上展开 */
  @media (max-width: 820px) {
    .panel {
      left: 0 !important; right: 0 !important; top: auto !important; bottom: 0;
      width: auto !important; height: auto !important;
      flex-direction: column-reverse;                 /* 输入在底, 工具/结果向上展开 */
      border-radius: 16px 16px 0 0;                    /* 贴底, 仅上缘圆角 */
      max-height: calc(100dvh - 12px); cursor: default;
      padding: 12px 14px calc(14px + env(safe-area-inset-bottom, 0px));
    }
    .panel.dragging { user-select: auto; }
    .draghandle, .grip { display: none !important; }   /* 去掉拖动手柄与缩放角 */
    /* 地球控制(复位 + 2D/3D)移到左上, 避开底部面板与右上角菜单钮 */
    .projctl {
      left: calc(12px + env(safe-area-inset-left, 0px)); right: auto;
      top: calc(10px + env(safe-area-inset-top, 0px)); bottom: auto;
    }
  }
</style>
