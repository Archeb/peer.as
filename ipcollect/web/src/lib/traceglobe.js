// 全球路由跟踪 3D 地球引擎(canvas)。
//
// 复用首页 doodle(globe.js)的「地球渲染语言」—— 正交投影 + 大气光晕 + 海岸线 + 经纬网 +
// 夜面城市灯 + 大圆弧 + 数据包,但面向 MTR 可视化整体重做:
//   · 地轴以 23.5° 倾斜(屏幕平面内 roll)→ 像在太空/空间站里俯瞰地球; 缓慢自转; 南极在可见区外。
//   · 数据 = 若干监测点(globalping vantage points)+ 各自到目标的「逐跳(hop)链」。
//   · 随 MTR 逐跳返回,大圆弧逐跳「生长」; 每轮探测有一道彗星「探测波」从监测点扫向当前最远跳;
//     建好的路径上持续有数据包朝目标流动 → 多监测点的彩色路径汇聚到同一个脉冲靶标。
//
// 2D/3D 双模式: 陆地不再实心填充, 而是几万颗「星点」粒子(等面积采样陆地 mask);
//   切到 2D(墨卡托)时粒子逐颗错峰从球面滑行到平面, 弧线/节点/光点走同一套统一投影同步形变。
//
// createTraceGlobe(canvas, { tip, hit, mode2d, onpick, onhover }) ->
//   { setData(model), setMode(to2d), focus(probeId|null), recenter(), destroy() }
//   model 形状见 globalping.js streamTrace 注释(target + probes[].hops[])。
import worldLand from './world-land.js'
import { geoEquirectangular, geoOrthographic, geoMercator, geoPath, geoArea } from 'd3-geo'

const D2R = Math.PI / 180
const TAU = Math.PI * 2
const clamp = (v, a, b) => v < a ? a : v > b ? b : v

// 加载时的默认朝向(仅初始姿态, 之后可像真实地球仪一样朝任意方向自由拖动 —— 无固定地轴)。
const INIT_LAT = -22 * D2R   // d3 rotate 的 φ = −中心纬度 → 视野中心落在北纬 ~22°
const INIT_ROLL = 0          // 不倾斜, 地球站正(北极朝上); 用户可用右键拖动手动 roll 角度
const LIFT = 1              // 弧线/节点紧贴球面(2D canvas 画家序: 后画即在上层, 不会被球体挡住)
const ZOOM0 = 0.82          // 默认缩放(复位回到此)

// ── 2D(墨卡托)与形变 ──
const MERC_LAT = 84 * D2R    // 墨卡托纬度截断(再高 y 发散; 也是 2D 地图框的上下边)
const mercYof = la => Math.log(Math.tan(Math.PI / 4 + clamp(la, -MERC_LAT, MERC_LAT) / 2))
const MERC_MAX = mercYof(MERC_LAT)
const invMercY = y => 2 * Math.atan(Math.exp(y)) - Math.PI / 2
const wrapPi = a => { a = (a + Math.PI) % TAU; return (a < 0 ? a + TAU : a) - Math.PI }
const MORPH_T = 1.15         // 2D/3D 形变时长(秒)
const STAG = .35             // 粒子错峰滑行: 各粒子延迟 0..STAG(归一化到形变进度)
const hash1 = k => { const s = Math.sin(k) * 43758.5453; return s - Math.floor(s) }   // 确定性伪随机

// ── 陆地多边形(GeoJSON MultiPolygon, 模块级构建一次)──
// 陆地填充的半球裁剪不再手写(球缘缝合的 winding 极易出错), 交给 d3-geo 的 clipCircle。
// d3 按**球面 winding** 判定多边形内外: 环面积 > 2π(超过半球)即方向反了, 会被解释成补集
// (填出海洋/整圆盘 → 拖动时"反色")。这里逐环用 geoArea 归一化, 保证 fill 永远是陆地本身。
const LAND = (() => {
  const polys = []
  for (const ring of worldLand) {
    let r = ring
    if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) r = [...r, r[0]]
    if (geoArea({ type: 'Polygon', coordinates: [r] }) > TAU) r = [...r].reverse()
    polys.push([r])
  }
  return { type: 'MultiPolygon', coordinates: polys }
})()

// ── 粒子化陆地 ── 不实心填充陆地: 把 LAND 画到等距圆柱 mask 上, 用 R2 低差异序列在「墨卡托
// 平面」上均匀撒点(而非球面等面积) → 2D 地图上密度天然均匀, 不会赤道密两极稀。逐点查 mask 留
// 陆地点。每颗带: 地理笛卡尔向量(3D 旋转)、墨卡托 y(2D 端)、纬度门控权重 w3=cos²lat(3D 时按
// 此概率保留 → 还原球面均匀)、独立门控随机数、亮度/亮星/闪烁/错峰(确定性, 帧间稳定)。
function buildParticles(N) {
  const MW = 2048, MH = 1024, S = MW / TAU
  const cv = document.createElement('canvas'); cv.width = MW; cv.height = MH
  const mc = cv.getContext('2d', { willReadFrequently: true })
  mc.fillStyle = '#fff'; mc.beginPath()
  geoPath(geoEquirectangular().translate([MW / 2, MH / 2]).scale(S), mc)(LAND); mc.fill()
  const mask = mc.getImageData(0, 0, MW, MH).data
  const la = new Float32Array(N), lo = new Float32Array(N)
  const vx = new Float32Array(N), vy = new Float32Array(N), vz = new Float32Array(N)
  const my = new Float32Array(N), br = new Float32Array(N), dl = new Float32Array(N), ph = new Float32Array(N)
  const w3 = new Float32Array(N), uu = new Float32Array(N)
  const big = new Uint8Array(N)
  // R2 低差异序列(塑性数): 在墨卡托矩形 [−π,π]×[−Ymax,Ymax] 上极均匀铺点(优于纯随机)
  const G = 1.32471795724474602596, A1 = 1 / G, A2 = 1 / (G * G)
  const cap = Math.ceil(N * 4.2)                   // 墨卡托图上陆地约占 ~24%, 超采到 ~4.2N 候选
  let n = 0
  for (let i = 0; i < cap && n < N; i++) {
    const xr = (.5 + A1 * i) % 1, yr = (.5 + A2 * i) % 1
    const o = (xr - .5) * TAU, Y = (yr - .5) * 2 * MERC_MAX
    const a = invMercY(Y)                           // 墨卡托 y → 纬度
    const ix = Math.min(MW - 1, Math.max(0, (MW / 2 + o * S) | 0))
    const iy = Math.min(MH - 1, Math.max(0, (MH / 2 - a * S) | 0))
    if (mask[(iy * MW + ix) * 4 + 3] < 128) continue
    la[n] = a; lo[n] = o; my[n] = Y
    const cl = Math.cos(a)
    vx[n] = cl * Math.cos(o); vy[n] = cl * Math.sin(o); vz[n] = Math.sin(a)
    w3[n] = Math.max(.04, cl * cl)                  // 3D 保留概率(cos²lat → 球面均匀; 极点留少量)
    uu[n] = hash1(i * 5.917)                         // 门控随机数(独立均匀)
    const h = hash1(i * 1.317)
    br[n] = .42 + .58 * h * h                        // 亮度偏暗分布(h² 压低中位)
    big[n] = hash1(i * 2.71) > .982 ? 1 : 0          // ~2% 亮星(十字增辉)
    dl[n] = hash1(i * 3.137) * STAG
    ph[n] = hash1(i * 4.733)
    n++
  }
  // 不打乱: R2 序列本身低差异, 前缀 [0,k) 就是在地图上均匀分布的子集(越往后越细分)。按 zoom 取
  // 前缀即可动态调疏密, 缩小时点依旧均匀。(打乱会让前缀退化成随机子集 → 出现泊松团块、不均匀。)
  return { n, la, lo, vx, vy, vz, my, br, w3, uu, dl, ph, big }
}

function toRgb(s) {
  s = (s || '').trim()
  let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s.replace(/^#/, ''))
  if (m) return parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16)
  m = /rgba?\(([^)]+)\)/.exec(s)
  if (m) return m[1].split(',').slice(0, 3).map(x => Math.round(parseFloat(x))).join(',')
  return '128,128,128'
}
function shortIp(ip) {
  if (!ip || !ip.includes(':')) return ip || ''
  const g = ip.split(':'); if (g.length <= 4) return ip
  return g.slice(0, 2).join(':') + '…' + g.slice(-2).join(':')
}

// ── 自由旋转(四元数)── 用四元数表示地球朝向, 拖动 = 在视空间叠加旋转(trackball),
//    所以没有「被锁死的地轴」: 可像谷歌地球 / 真实地球仪一样朝任意方向转。
//    朝向 q 把「地理笛卡尔向量」映射到「视空间」(x=屏幕右, y=屏幕上, z=朝观察者; z>0 为正面)。
const qMul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
]
const qNorm = q => { const m = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / m, q[1] / m, q[2] / m, q[3] / m] }
const qAxis = (x, y, z, a) => { const h = a / 2, s = Math.sin(h); return [Math.cos(h), x * s, y * s, z * s] }
// 旋转矩阵(行优先 3x3): v_view = M · v_geo
function qMat(q) {
  const [w, x, y, z] = q
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z
  return [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
  ]
}
function qSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  if (d < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; d = -d }
  if (d > 0.9995) return qNorm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t])
  const th0 = Math.acos(d), th = th0 * t, s0 = Math.sin(th0)
  const s1 = Math.sin(th0 - th) / s0, s2 = Math.sin(th) / s0
  return [a[0] * s1 + b[0] * s2, a[1] * s1 + b[1] * s2, a[2] * s1 + b[2] * s2, a[3] * s1 + b[3] * s2]
}
const qClamp = v => v < -1 ? -1 : v > 1 ? 1 : v
// 矩阵 → 四元数(行优先, 同 qMat 约定)
function matToQ(m) {
  const t = m[0][0] + m[1][1] + m[2][2]
  let w, x, y, z
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; w = .25 * s; x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; w = (m[2][1] - m[1][2]) / s; x = .25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = .25 * s; z = (m[1][2] + m[2][1]) / s }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = .25 * s }
  return qNorm([w, x, y, z])
}
// d3 rotate 欧拉角 [λ,φ,γ](弧度)→ 朝向四元数。λ=−中心经度, φ=−中心纬度, γ=屏幕内 roll。
function eulerToQ(lam, phi, gam) {
  const cλ = Math.cos(lam), sλ = Math.sin(lam), cφ = Math.cos(phi), sφ = Math.sin(phi), cγ = Math.cos(gam), sγ = Math.sin(gam)
  const M0 = [cφ * cλ, -cφ * sλ, -sφ]
  const M1 = [-sγ * sφ * cλ + cγ * sλ, sγ * sφ * sλ + cγ * cλ, -sγ * cφ]
  const M2 = [cγ * sφ * cλ + sγ * sλ, -cγ * sφ * sλ + sγ * cλ, cγ * cφ]
  return matToQ([M1, M2, M0])   // 视空间矩阵 Mv = P·M_d3(P 把地理笛卡尔轴排到屏幕轴)
}
// 视空间矩阵 → d3 rotate 角度[λ,φ,γ](度), 供 d3-geo 画陆地填充时严格对齐 projectLL。
function mvEuler(m) {
  const lam = Math.atan2(-m[2][1], m[2][0])
  const phi = -Math.asin(qClamp(m[2][2]))
  const gam = Math.atan2(-m[0][2], m[1][2])
  return [lam / D2R, phi / D2R, gam / D2R]
}

export function createTraceGlobe(canvas, opts = {}) {
  const ctx = canvas.getContext('2d')
  const tipEl = opts.tip || null
  const onpick = opts.onpick || null
  const onhover = opts.onhover || null
  const onlochover = opts.onlochover || null  // 悬停/点击探测点光点 → (loc|null, sx, sy); 组件据此弹交互 popup
  let hold = false                            // 外部(popup 打开时)暂停自转, 让光点不漂移
  const surf = opts.hit || canvas
  const root = document.documentElement

  let W = 0, H = 0, DPR = 1, R = 0, Rbase = 0, cx = 0, cy = 0, baseCx = 0, baseCy = 0
  let zoom = ZOOM0                 // 滚轮缩放(像谷歌地球): 实际 R = Rbase * zoom。初始略缩小, 露出球缘/太空感
  let panX = 0, panY = 0           // 球心相对默认位置的平移(滚轮朝鼠标缩放时累积, 让指针下的点不动)
  function resize() {
    const w = canvas.offsetWidth, h = canvas.offsetHeight
    if (!w || !h) return
    DPR = Math.min(window.devicePixelRatio || 1, 2)
    W = w; H = h
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    // 地球占满整个视图、球心在 3D 空间里推到偏右(~57% 宽处); 半径取到能盖住最远的视口角 ——
    // 这样默认看不到任何圆盘边缘, 也就不存在「地球底色 ≠ 页面底色」的割裂(浅色尤甚)。缩小(滚轮)后才露球缘。
    baseCx = W * 0.57; baseCy = H * 0.5
    panX = clamp(panX, -W * 0.55, W * 0.55); panY = clamp(panY, -H * 0.55, H * 0.55)
    cx = baseCx + panX; cy = baseCy + panY
    const farX = Math.max(baseCx, W - baseCx), farY = Math.max(baseCy, H - baseCy)
    Rbase = Math.hypot(farX, farY) * 1.04
    R = Rbase * zoom
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize()

  const css = n => getComputedStyle(root).getPropertyValue(n).trim()
  function palette() {
    const bg = toRgb(css('--bg')).split(',').map(Number)
    const isDark = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) < 110
    return {
      accentRgb: toRgb(css('--accent')), signalRgb: toRgb(css('--signal')),
      muted: css('--muted'), panel: css('--panel'), fg: css('--fg'), sans: css('--sans'),
      glassRgb: isDark ? '224,242,238' : '255,255,255',
      atmoRgb: isDark ? '150,205,255' : '120,175,225',
      landRgb: isDark ? '92,124,140' : '96,124,148',
      isDark,
    }
  }

  // 夜面城市灯近似(同 globe.js): 抽稀海岸线顶点 + 确定性亮度抖动。
  // ── 探测点「光点」: 全部可用监测点位置(取代旧的装饰城市灯)。亮度 ∝ count, 选中高亮; 可 hover/点击 ──
  let locations = []           // [{ id, la, lo, city, cc, country, count, sel }]  ← setLocations 注入
  const locHits = []           // 本帧各光点屏幕位置(供命中检测)

  // ── 相机: 自由朝向(四元数)+ 缓慢自转 + 新 trace 时缓飞到目标 ──
  let q = eulerToQ(0, INIT_LAT, INIT_ROLL)   // 当前朝向(加载默认: 看北纬 ~22°、站正)
  let MV = qMat(q)                           // 本帧旋转矩阵(每帧由 q 重算; projectLL 复用)
  let userMoved = false                      // 用户是否已手动拖动/缩放(true 后不再自动飞到 home)
  let lockNorth = opts.lockNorth !== false   // 锁定正北(北极朝上): 拖动只转经纬、roll 恒为 0; 默认开
  const cam = { q: null, flying: false, flyT: 0 }   // 缓飞目标朝向(slerp)

  // ── 2D/3D 模式 ── mt: 形变进度 0(纯 3D)..1(纯 2D), 朝 mode2d 推进; ms = smoothstep(mt)。
  // 2D = 墨卡托: lam0 = 地图中心经度(弧度), Y0 = 中心墨卡托纵坐标; 缩放/平移仍复用 cx/cy/R。
  let mode2d = !!opts.mode2d
  let mt = mode2d ? 1 : 0, ms = mt
  let lam0 = 0, Y0 = mercYof(-INIT_LAT)
  const cam2 = { on: false, lam: 0, Y: 0, t: 0 }   // 2D 缓飞(对应 3D 的 cam)
  let zFix = null                                  // 2D 低倍率切回 3D: 随形变把 zoom 补回 3D 下限
  let homing = false                               // 复位中: 缩放/平移平滑归位(朝向由 cam/cam2 缓飞)

  // 粒子化陆地: 池更大 + 按 zoom 取前缀(放大多画、缩小少画 → 屏上疏密大致恒定) + 粒子层画布(直写 ImageData)
  // 屏上密度 ≈ 恒定的关键: drawN ∝ zoom²(放大多画、缩小少画 → 每屏像素点数不随缩放变)。
  // DENS 标定到「最小缩放就有满密度」(含 3D 纬度门控 ~0.44 的折损); 到 POOL 封顶后由 splat 顶住。
  const SMALL = (window.innerWidth || 1024) <= 680
  const PT_POOL = SMALL ? 150000 : 400000    // 粒子池上限(池越大封顶越晚、增长区间越大, 也越吃 CPU; 卡就调小)
  const PT_DENS = SMALL ? 70000 : 190000     // 密度系数(drawN ≈ DENS·zoom²; 越大整体越密)
  const PT_MIN = SMALL ? 18000 : 40000       // 最少绘制数(主要保 2D 全图缩到很小时仍可读)
  const parts = buildParticles(PT_POOL)
  let pcv = null, pcx = null, pimg = null, p8 = null, p32 = null

  // 视空间叠加旋转(trackball): 横拖绕屏幕竖轴、纵拖绕屏幕横轴 —— 复合出任意朝向, 无固定地轴。
  // 2D 下退化为地图平移(经度回绕、纬度截断); 形变进行中(~1s)不接管, 避免两套姿态互搏。
  function dragRotate(dx, dy) {
    if (mt > 0 && mt < 1) return
    homing = false
    if (mt >= 1) {
      lam0 = wrapPi(lam0 - dx / R)
      Y0 = clamp(Y0 + dy / R, -MERC_MAX, MERC_MAX)
      cam2.on = false; userMoved = true; return
    }
    const qy = qAxis(0, 1, 0, dx / R), qx = qAxis(1, 0, 0, dy / R)
    q = qNorm(qMul(qMul(qx, qy), q))
    // 锁定正北: trackball 会累积出 roll, 故每步把朝向拆成欧拉角、把 γ(屏内 roll)清零再重建 ——
    // 中心经纬不变(只去掉扭转), 北极始终朝上。
    if (lockNorth) { const e = mvEuler(qMat(q)); q = eulerToQ(e[0] * D2R, e[1] * D2R, 0) }
    cam.flying = false; userMoved = true
  }
  // 右键拖动: 绕视线轴 roll(转动地球仪的「角度」)。da = 指针绕球心的角度变化(球心附近已钳制限速)。
  // 2D 地图必须北朝上, roll 无意义 → 仅纯 3D 生效; 锁定正北时也禁用。
  function rollRotate(da) { if (mt > 0 || lockNorth) return; q = qNorm(qMul(qAxis(0, 0, 1, da), q)); cam.flying = false; userMoved = true; homing = false }
  // 切换正北锁定: 开启时把当前朝向缓飞到「同中心、零 roll」的姿态, 平滑摆正北极。
  function setLockNorth(b) {
    const on = !!b; if (on === lockNorth) return
    lockNorth = on
    if (on && mt === 0) { const e = mvEuler(qMat(q)); cam.q = eulerToQ(e[0] * D2R, e[1] * D2R, 0); cam.flying = true; cam.flyT = 0 }
  }

  // ── 统一投影 ── 地理 → 屏幕。ms=0 纯 3D(四元数+正交); ms=1 纯 2D(墨卡托); 形变期屏幕空间
  // 线性混合 → 每个点沿「球面位置 → 平面位置」滑行。z: 3D 深度(背面<0), 混合时拉向 1 ——
  // 原有按 z 的背面剔除/深度调光公式在 2D 下自动变成全显全亮, 调用方无需分支。
  // wx: 2D 端横坐标(仅 ms>0 时给出), 供弧线/经纬线检测反经线回绕 → 断笔不画横穿地图的直线。
  function projXYZ(px, py, pz, la, lo, lift = 1) {
    let sx3 = 0, sy3 = 0, z3 = 1
    if (ms < 1) {
      const m = MV
      const x = m[0][0] * px + m[0][1] * py + m[0][2] * pz
      const y = m[1][0] * px + m[1][1] * py + m[1][2] * pz
      z3 = m[2][0] * px + m[2][1] * py + m[2][2] * pz
      sx3 = cx + x * R * lift; sy3 = cy - y * R * lift
      if (ms <= 0) return { sx: sx3, sy: sy3, z: z3 }
    }
    if (la == null) { la = Math.asin(clamp(pz, -1, 1)); lo = Math.atan2(py, px) }
    const sx2 = cx + wrapPi(lo - lam0) * R, sy2 = cy - (mercYof(la) - Y0) * R
    if (ms >= 1) return { sx: sx2, sy: sy2, z: 1, wx: sx2 }
    return { sx: sx3 + (sx2 - sx3) * ms, sy: sy3 + (sy2 - sy3) * ms, z: z3 + (1 - z3) * ms, wx: sx2 }
  }
  function projectLL(lat, lon, lift = 1) {
    const cl = Math.cos(lat)
    return projXYZ(cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat), lat, lon, lift)
  }
  // 缓飞到某地理点(经/纬, 度): 居中该点。3D 保留当前 roll; 2D = 平移地图中心。
  function flyTo(lonDeg, latDeg) {
    if (mode2d) {
      cam2.lam = lonDeg * D2R
      cam2.Y = clamp(mercYof(clamp(latDeg, -60, 60) * D2R), -MERC_MAX, MERC_MAX)
      cam2.on = true; cam2.t = 0; return
    }
    const roll = lockNorth ? 0 : mvEuler(qMat(q))[2] * D2R   // 锁定正北时缓飞落点也北极朝上
    cam.q = eulerToQ(-lonDeg * D2R, -clamp(latDeg, -60, 60) * D2R, roll)
    cam.flying = true; cam.flyT = 0
  }
  // 朝屏幕点 (px,py) 缩放(像谷歌地球): 调整球心平移, 让指针正下方的地球点保持不动。
  // 2D 允许缩得更小(整张世界地图能收进视口); 形变进行中不缩放。
  function zoomAt(px, py, factor) {
    if (mt > 0 && mt < 1) return
    const nz = clamp(zoom * factor, mt >= 1 ? 0.16 : 0.5, 5.5)
    if (nz === zoom) return
    const k = nz / zoom
    cx = px - (px - cx) * k; cy = py - (py - cy) * k
    panX = clamp(cx - baseCx, -W * 0.55, W * 0.55); panY = clamp(cy - baseCy, -H * 0.55, H * 0.55)
    cx = baseCx + panX; cy = baseCy + panY
    zoom = nz; R = Rbase * zoom; cam.flying = false; userMoved = true; homing = false
  }
  // 2D/3D 切换: 进入 2D 以当前视野中心为地图中心; 回 3D 把地图中心还原成四元数姿态(北朝上)。
  function setMode(to2d) {
    to2d = !!to2d
    if (to2d === mode2d) return
    mode2d = to2d
    if (to2d) {
      const e = mvEuler(qMat(q))                   // [λ,φ,γ](度), 中心经纬 = (−λ, −φ)
      lam0 = wrapPi(-e[0] * D2R); Y0 = clamp(mercYof(-e[1] * D2R), -MERC_MAX, MERC_MAX)
      cam.flying = false
    } else {
      q = eulerToQ(-lam0, -invMercY(Y0), 0)
      cam2.on = false
      if (zoom < 0.5) zFix = { from: zoom, to: 0.5 }
    }
  }

  // ── 数据 ──
  let model = { target: null, probes: [] }
  let target = null            // { la, lo, ip, label, city }
  let probes = []              // [{ ...vp, rgb, hops:[{la,lo,...}], segGrow:[], waveT, waveSeg, nDone }]
  let activeProbe = null       // hover/选中高亮的 probe id(null=全亮)
  let hidden = new Set()       // 被用户隐藏的 probe id: 其路径/节点/包/源点都不画、也不参与命中
  let hideLoc = false          // 隐藏全部探测点光点(NextTrace traceMap 模式: 与 globalping 测点无关)
  const packets = []
  let pktAcc = 0
  let targetKey = null         // 目标稳定键(仅目标真的换了才重新缓飞相机, 不被逐跳更新打断)

  function setData(m) {
    model = m || { target: null, probes: [] }
    const newKey = model.target ? model.target.ip + '@' + model.target.lat + ',' + model.target.lon : null
    const tgChanged = newKey !== targetKey; targetKey = newKey
    // 目标无有效坐标(0,0 / anycast 占位)→ 不在地球上画靶标(头部信息仍由组件单独展示)。
    target = (model.target && (model.target.lat || model.target.lon)) ? {
      la: model.target.lat * D2R, lo: model.target.lon * D2R,
      ip: model.target.ip, label: model.target.label, city: model.target.city,
    } : null

    // 增量合并: 已存在的 probe 保留生长进度, 仅给「新到的跳」补一条 segGrow=0(从而触发生长动画)。
    const prev = new Map(probes.map(p => [p.id, p]))
    // 节点统一带地理笛卡尔向量(vx,vy,vz): 弧线在未旋转的地理系里 slerp(与旋转可交换,
    // 3D 结果与旧视空间实现逐像素一致), 再经统一投影 → 2D/形变下自动正确。
    const geoNode = (latDeg, lonDeg, extra) => {
      const la = latDeg * D2R, lo = lonDeg * D2R, cl = Math.cos(la)
      return { ...extra, la, lo, vx: cl * Math.cos(lo), vy: cl * Math.sin(lo), vz: Math.sin(la) }
    }
    probes = (model.probes || []).map(mp => {
      const old = prev.get(mp.id)
      const rgb = (mp.color || [45, 212, 191]).join(',')
      // 只把有坐标的跳画到地球(私网/anycast 无坐标 → 跳过, 弧线自然连接前后有地理的跳);
      // 详情面板用的是完整 mp.hops(含这些), 故"不落地球 ≠ 详情里消失"。
      const hops = (mp.hops || []).filter(h => h.lat != null && h.lon != null).map(h => geoNode(h.lat, h.lon, h))
      // segGrow[i] = 第 i 段(节点 i-1 → i, 节点 0 视为监测点本身)的生长进度 0..1
      const segGrow = old ? old.segGrow.slice() : []
      while (segGrow.length < hops.length) segGrow.push(0) // 每跳一条入边的生长进度; 新到的跳从 0 开始长
      return {
        ...mp, rgb, hops, segGrow, _n0: geoNode(mp.lat, mp.lon),
        waveT: old ? old.waveT : 0, waveGap: old ? old.waveGap : 0,
        appearT: old ? old.appearT : introT,
      }
    })
    if (!probes.length) { packets.length = 0; pktAcc = 0 }   // 结果清空 → 立刻收掉仍在飞的流量包(否则引用旧 probe 继续飞)
    if (model.target && tgChanged && (model.target.lat || model.target.lon)) {   // 新目标 → 相机缓飞过去(0,0/anycast 不飞)
      flyTo(model.target.lon, model.target.lat)
    }
  }
  function focus(id) { activeProbe = id || null }
  function setHidden(s) { hidden = (s instanceof Set) ? s : new Set(s || []) }
  function recenter() { if (target) flyTo(target.lo / D2R, target.la / D2R) }
  // 复位: 缩放/平移平滑归位(homing) + 朝向缓飞(有目标→飞目标; 否则回默认朝向/地图中心)。2D/3D 通用。
  function reset() {
    userMoved = false; homing = true; zFix = null
    if (target) flyTo(target.lo / D2R, target.la / D2R)
    else if (mode2d) { cam2.lam = 0; cam2.Y = clamp(mercYof(-INIT_LAT), -MERC_MAX, MERC_MAX); cam2.on = true; cam2.t = 0 }
    else { cam.q = eulerToQ(0, INIT_LAT, INIT_ROLL); cam.flying = true; cam.flyT = 0 }
  }
  // 初始视角: 缓飞到用户所在地(经/纬, 度)。仅在尚无 trace 目标、且用户还没手动操作过地球时生效。
  function setHome(lon, lat) {
    if (typeof lat !== 'number' || typeof lon !== 'number') return
    if (!target && !userMoved) flyTo(lon, lat)
  }

  // ── 交互(hover 出 tooltip; 点击转发查询)──
  let pointer = { x: -1, y: -1, inside: false }, hover = null, lastHoverId = null, lastLocId = null
  const hitList = []   // 本帧全部可点目标 {sx,sy,rad,payload}; 点击时实时命中(不能用 hover —— 按下即被清)
  const drag = { active: false, lx: 0, ly: 0, moved: 0, button: 0 }
  function setPointer(e) {
    const r = surf.getBoundingClientRect(), t = e.touches ? e.touches[0] : e
    if (!t) return
    pointer.x = t.clientX - r.left; pointer.y = t.clientY - r.top; pointer.inside = true
  }
  // 指针在 window 上跟踪(不绑在命中层 surf 上): HUD 浮窗盖在地球之上且与之重叠, 鼠标移到浮窗后
  // surf 既收不到 mousemove、也不会触发 mouseleave(指针几何上仍在 surf 框内)→ pointer 冻结在旧坐标,
  // 悬停命中/tooltip 卡在原地不动、地球还停转。故只在「最顶层命中元素正是 surf」时才算 inside。
  const onMove = e => {
    if (e.target === surf) setPointer(e)
    else { pointer.inside = false; pointer.x = pointer.y = -1 }
  }
  const onLeave = () => { pointer.inside = false; pointer.x = pointer.y = -1 }
  const onDown = e => { drag.active = true; drag.button = e.button; drag.moved = 0; drag.lx = e.clientX; drag.ly = e.clientY; surf.classList.add('grabbing'); e.preventDefault() }
  const onCtx = e => e.preventDefault()   // 右键用于 roll, 屏蔽浏览器右键菜单
  const onWinMove = e => {
    if (!drag.active) return
    const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly; drag.lx = e.clientX; drag.ly = e.clientY
    drag.moved += Math.abs(dx) + Math.abs(dy)
    // 右键 roll: 按指针绕球心的「角度变化」扭转 → 抓住的点始终跟随鼠标(上下半球都一致, 不反向);
    // 分母对半径做下限钳制(球心附近用 minR² 兜底) → 靠近球心也不会突然变得超快。
    if (drag.button === 2) {
      const r = surf.getBoundingClientRect()
      const px = (e.clientX - r.left) - cx, py = -((e.clientY - r.top) - cy)   // 视空间(y 朝上)指针相对球心
      const minR2 = 90 * 90
      rollRotate((px * -dy - py * dx) / Math.max(px * px + py * py, minR2))
    } else dragRotate(dx, dy)
  }
  const onWinUp = () => { if (drag.active) { drag.active = false; surf.classList.remove('grabbing') } }
  // 触摸: 单指拖动旋转; 双指 = 捏合缩放 + 中点平移(转朝向 / 2D 平移地图) + 扭转(roll, 仅 3D) 同时进行。
  // (.tg-hit 设 touch-action:none, 不会触发浏览器手势)
  let pinchD = 0, pinchMx = 0, pinchMy = 0, pinchAng = 0
  const touchDist = e => { const a = e.touches[0], b = e.touches[1]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) }
  const touchAng = e => { const a = e.touches[0], b = e.touches[1]; return Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) }
  const touchMx = e => (e.touches[0].clientX + e.touches[1].clientX) / 2
  const touchMy = e => (e.touches[0].clientY + e.touches[1].clientY) / 2
  const onTStart = e => {
    if (e.touches.length >= 2) { pinchD = touchDist(e); pinchMx = touchMx(e); pinchMy = touchMy(e); pinchAng = touchAng(e); drag.active = false; cam.flying = false; return }
    const t = e.touches[0]; if (!t) return; drag.active = true; drag.moved = 0; drag.lx = t.clientX; drag.ly = t.clientY; setPointer(e)
  }
  const onTMove = e => {
    if (e.touches.length >= 2) {
      const d = touchDist(e), mx = touchMx(e), my = touchMy(e), ang = touchAng(e)
      if (pinchD > 0) {
        const r = surf.getBoundingClientRect()
        zoomAt(mx - r.left, my - r.top, d / pinchD)   // 捏合缩放(朝双指中点)
        dragRotate(mx - pinchMx, my - pinchMy)         // 双指平移中点 → 转朝向(2D 下平移地图)
        rollRotate(pinchAng - ang)                     // 双指扭转 → roll(跟手方向; 仅 3D 生效)
      }
      pinchD = d; pinchMx = mx; pinchMy = my; pinchAng = ang; return
    }
    const t = e.touches[0]; if (!t) return
    if (drag.active) { const dx = t.clientX - drag.lx, dy = t.clientY - drag.ly; drag.lx = t.clientX; drag.ly = t.clientY; drag.moved += Math.abs(dx) + Math.abs(dy); dragRotate(dx, dy) }
    setPointer(e)
  }
  const onTEnd = e => { if (!e.touches || e.touches.length < 2) pinchD = 0; drag.active = false; pointer.inside = false }
  // 滚轮缩放(像谷歌地球): 朝指针所在的地球点放大/缩小; 缩放期间打断自动缓飞
  // 触摸板判定(捏合缩放 + 两指上下滚动都算): 不靠 deltaY 大小阈值(快滑会漏判), 而靠设备特征 ——
  //   · 捏合手势 → 浏览器置 ctrlKey;
  //   · Firefox 物理鼠标走行/页模式(deltaMode≠0), 触摸板走像素模式(deltaMode=0);
  //   · Chrome/Safari 鼠标与触摸板都走像素模式, 但物理鼠标的 wheelDeltaY 恒为 120 的整数倍, 触摸板不是。
  // 命中即触摸板 → 缩放灵敏度减半(两指滚动事件密集、累计过快); 鼠标滚轮维持原速一次一档。
  function isTouchpad(e) {
    if (e.ctrlKey) return true
    if (e.deltaMode !== 0) return false                       // 行/页模式 = 鼠标滚轮
    const wd = e.wheelDeltaY ?? e.wheelDelta                  // Chrome/Safari 物理鼠标: 120 整数倍
    if (wd) return Math.abs(wd) % 120 !== 0
    return true                                               // 像素模式且无 wheelDelta(Firefox 触摸板)
  }
  const onWheel = e => {
    e.preventDefault(); const r = surf.getBoundingClientRect()
    const base = e.deltaY < 0 ? 1.12 : 0.892
    const factor = isTouchpad(e) ? 1 + (base - 1) * 0.5 : base   // 触摸板: 把相对 1.0 的缩放幅度砍半
    zoomAt(e.clientX - r.left, e.clientY - r.top, factor)
  }
  function hitAt(px, py) {       // 实时命中(用上一帧的 hitList, 不受 drag.active 清 hover 影响), 返回命中项
    let bd = 1e9, hit = null
    for (const it of hitList) { const d = (it.sx - px) ** 2 + (it.sy - py) ** 2; if (d < it.rad * it.rad && d < bd) { bd = d; hit = it } }
    return hit
  }
  const onClick = () => {
    if (drag.moved > 6) return
    const it = hitAt(pointer.x, pointer.y)
    if (!it) { onlochover && onlochover(null, 0, 0); return }   // 点空白处 → 关闭 popup(触屏 dismiss 路径)
    const h = it.payload
    if (h.kind === 'loc') { onlochover && onlochover(h.loc, it.sx, it.sy); return }   // 点光点 → 弹/开 popup(触屏入口)
    if (!onpick) return
    if (h.kind === 'hop' && h.node.asn) onpick('AS' + h.node.asn)
    else if (h.kind === 'hop' && h.node.ip) onpick(h.node.ip)
    else if (h.kind === 'target' && target?.ip) onpick(target.ip)
    else if (h.kind === 'probe') onpick('AS' + h.probe.asn)
  }
  window.addEventListener('mousemove', onMove); surf.addEventListener('mouseleave', onLeave)
  surf.addEventListener('mousedown', onDown)
  window.addEventListener('mousemove', onWinMove); window.addEventListener('mouseup', onWinUp)
  surf.addEventListener('touchstart', onTStart, { passive: true }); surf.addEventListener('touchmove', onTMove, { passive: true }); surf.addEventListener('touchend', onTEnd)
  surf.addEventListener('wheel', onWheel, { passive: false })
  surf.addEventListener('click', onClick); surf.addEventListener('contextmenu', onCtx)

  // ── 弧线(纯大圆 slerp + 抬升)── 在地理笛卡尔系 slerp(节点已带 vx/vy/vz), 经统一投影出屏 ──
  function arcPoint(a, b, t) {
    let dot = clamp(a.vx * b.vx + a.vy * b.vy + a.vz * b.vz, -1, 1)
    const om = Math.acos(dot)
    // 两端几乎重合(相邻跳落在同一城市/国家质心 → 坐标相同): slerp 的 sin 比值会塌成 0,
    // 把点甩到屏幕中心 (cx,cy) 卡住不动。退化为该点本身。
    if (om < 1e-4) { const p = projXYZ(a.vx, a.vy, a.vz, a.la, a.lo, LIFT); return { sx: p.sx, sy: p.sy, vz: p.z } }
    const so = Math.sin(om)
    const s0 = Math.sin((1 - t) * om) / so, s1 = Math.sin(t * om) / so
    const p = projXYZ(a.vx * s0 + b.vx * s1, a.vy * s0 + b.vy * s1, a.vz * s0 + b.vz * s1, null, null, LIFT)
    return { sx: p.sx, sy: p.sy, vz: p.z }
  }
  function drawArc(a, b, rgb, grow, alpha, width) {
    let dot = clamp(a.vx * b.vx + a.vy * b.vy + a.vz * b.vz, -1, 1)
    const om = Math.acos(dot); if (om < 1e-4) return   // 两端重合: 零长弧, 无可画(否则画到屏幕中心)
    const so = Math.sin(om)
    const steps = Math.max(2, Math.min(40, Math.round(om / .09)))
    ctx.strokeStyle = `rgba(${rgb},${alpha})`; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    ctx.beginPath(); let pen = false, pwx = 0
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * grow, s0 = Math.sin((1 - t) * om) / so, s1 = Math.sin(t * om) / so
      const p = projXYZ(a.vx * s0 + b.vx * s1, a.vy * s0 + b.vy * s1, a.vz * s0 + b.vz * s1, null, null, LIFT)
      const jump = pen && ms > 0 && Math.abs(p.wx - pwx) > R * 2   // 2D 端跨反经线回绕 → 断笔
      pwx = p.wx
      if (p.z <= -.02) { pen = false; continue }
      if (pen && !jump) ctx.lineTo(p.sx, p.sy)
      else { ctx.moveTo(p.sx, p.sy); pen = true }
    }
    ctx.stroke()
  }

  // ── 地球本体(暗=夜地球+大气; 亮=抽象玻璃球)── 陆地交给粒子层, 这里只画 chrome + 经纬网 ──
  function strokeArc(P, fn, t0, t1, steps, aF, aB) {
    let prev = null
    for (let i = 0; i <= steps; i++) {
      const ll = fn(t0 + (t1 - t0) * i / steps)
      const p = projectLL(ll[0], ll[1]), vis = p.z > 0
      const jump = prev && ms > 0 && Math.abs(p.wx - prev.wx) > R * 2   // 跨反经线回绕 → 断笔
      if (prev && (prev.vis || vis) && !jump) {
        ctx.strokeStyle = `rgba(${P.accentRgb},${(prev.vis && vis) ? aF : aB})`
        ctx.beginPath(); ctx.moveTo(prev.sx, prev.sy); ctx.lineTo(p.sx, p.sy); ctx.stroke()
      }
      prev = { sx: p.sx, sy: p.sy, wx: p.wx, vis }
    }
  }
  function drawGraticule(P) {
    ctx.lineWidth = 1
    const aF = P.isDark ? .07 : .11, aB = P.isDark ? .025 : .04
    for (let m = 0; m < 12; m++) { const lon = (m / 12) * TAU; strokeArc(P, lat => [lat, lon], -80 * D2R, 80 * D2R, 30, aF, aB) }
    for (let p = 1; p < 6; p++) { const lat = (p / 6) * Math.PI - Math.PI / 2; strokeArc(P, lon => [lat, lon], -Math.PI, Math.PI, 46, aF * .85, aB * .85) }
  }
  // 静止 2D 用直线经纬网: 纬线铺满整宽、经线按世界宽平铺 → 与无界地图一致(投影版只铺一条带, 缩放后会断)。
  function drawGraticule2D(P) {
    const top = cy - (MERC_MAX - Y0) * R, bot = cy + (MERC_MAX + Y0) * R
    const t = Math.max(0, top), b = Math.min(H, bot)
    ctx.lineWidth = 1; ctx.strokeStyle = `rgba(${P.accentRgb},${P.isDark ? .07 : .11})`
    ctx.beginPath()
    for (let p = 1; p < 6; p++) {                       // 纬线(横): 整宽
      const lat = (p / 6) * Math.PI - Math.PI / 2; if (Math.abs(lat) >= MERC_LAT) continue
      const y = cy - (mercYof(lat) - Y0) * R; if (y > -1 && y < H + 1) { ctx.moveTo(0, y); ctx.lineTo(W, y) }
    }
    const MW = TAU * R, k0 = Math.floor((-cx) / MW) - 1, k1 = Math.ceil((W - cx) / MW) + 1
    for (let m = 0; m < 12; m++) {                      // 经线(竖): 平铺
      const baseX = cx + wrapPi((m / 12) * TAU - lam0) * R
      for (let k = k0; k <= k1; k++) { const x = baseX + k * MW; if (x > -1 && x < W + 1) { ctx.moveTo(x, t); ctx.lineTo(x, b) } }
    }
    ctx.stroke()
  }
  // 2D 地图背景(横向无界 → 铺满整个视口宽度, 只在上下两极画边线)。形变期与 3D 球体 chrome 交叉淡入淡出。
  function drawMapFrame(P) {
    const top = cy - (MERC_MAX - Y0) * R, bot = top + MERC_MAX * 2 * R
    const t = Math.max(-1, top), b = Math.min(H + 1, bot)
    if (b <= t) return
    if (P.isDark) {
      ctx.fillStyle = '#05080f'; ctx.fillRect(0, t, W, b - t)
      const vol = ctx.createLinearGradient(0, top, 0, bot)
      vol.addColorStop(0, 'rgba(2,5,10,.55)'); vol.addColorStop(.5, 'rgba(20,38,60,.35)'); vol.addColorStop(1, 'rgba(2,5,10,.55)')
      ctx.fillStyle = vol; ctx.fillRect(0, t, W, b - t)
      ctx.strokeStyle = `rgba(${P.atmoRgb},.25)`; ctx.lineWidth = 1.4
    } else {
      ctx.fillStyle = 'rgba(255,255,255,.42)'; ctx.fillRect(0, t, W, b - t)
      ctx.strokeStyle = `rgba(${P.accentRgb},.3)`; ctx.lineWidth = 1.2
    }
    ctx.beginPath(); ctx.moveTo(0, top + .5); ctx.lineTo(W, top + .5); ctx.moveTo(0, bot - .5); ctx.lineTo(W, bot - .5); ctx.stroke()
  }
  // ── 实心大陆架(静止态: 3D 正交球面 / 2D 墨卡托平面) ── 与 projXYZ 严格同参; 形变中段不画,
  //    交给粒子层。两端(接近静止)由 draw() 用 globalAlpha 与粒子交叉淡入淡出。
  const projO = geoOrthographic().clipAngle(90)
  const landPathO = geoPath(projO, ctx)
  const projM = geoMercator()
  const landPathM = geoPath(projM, ctx)
  function landFill(P) { return P.isDark ? 'rgba(30,47,62,.62)' : 'rgba(218,226,225,.5)' }
  function coastStroke(P) { return P.isDark ? `rgba(${P.landRgb},.6)` : `rgba(${P.accentRgb},.42)` }
  // 3D: d3 正交投影按本帧自由朝向(MV 反解欧拉角)填陆地; 海岸线用 projectLL 手动剔背面单描一遍。
  function drawLand3D(P) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    projO.rotate(mvEuler(MV)).translate([cx, cy]).scale(R)
    ctx.fillStyle = landFill(P); ctx.beginPath(); landPathO(LAND); ctx.fill()
    ctx.strokeStyle = coastStroke(P); ctx.lineWidth = 1; ctx.beginPath()
    for (const ring of worldLand) {
      let pen = false
      for (let i = 0; i < ring.length; i++) {
        const q = projectLL(ring[i][1] * D2R, ring[i][0] * D2R)
        if (q.z > 0) { if (pen) ctx.lineTo(q.sx, q.sy); else { ctx.moveTo(q.sx, q.sy); pen = true } }
        else pen = false
      }
    }
    ctx.stroke()
  }
  // 2D: d3 墨卡托投影, 参数与 projXYZ 的 2D 端严格对齐(中心经度 lam0、纵偏 Y0、缩放 R)。
  //   x = cx + wrapPi(lon−lam0)·R, y = cy − (mercY(lat)−Y0)·R ↔ d3 rotate([−lam0],…)+translate+scale。
  // 横向无界: 按一个世界宽 MW=TAU·R 平铺多份覆盖整个视口 → 缩放/平移到边缘不再露白。
  function drawLand2D(P) {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    const MW = TAU * R, ty = cy + Y0 * R
    projM.scale(R).rotate([-lam0 / D2R, 0, 0]).clipExtent([[0, 0], [W, H]])
    const k0 = Math.floor((-MW / 2 - cx) / MW), k1 = Math.ceil((W + MW / 2 - cx) / MW)
    ctx.fillStyle = landFill(P)
    for (let k = k0; k <= k1; k++) { projM.translate([cx + k * MW, ty]); ctx.beginPath(); landPathM(LAND); ctx.fill() }
    ctx.strokeStyle = coastStroke(P); ctx.lineWidth = 1
    for (let k = k0; k <= k1; k++) { projM.translate([cx + k * MW, ty]); ctx.beginPath(); landPathM(LAND); ctx.stroke() }
  }

  // 粒子化陆地渲染(仅形变中段显示): 在 CSS 像素分辨率的 ImageData 上直写像素(重叠处 alpha 饱和
  // 叠加 → 密集自然提亮), 一次 putImageData + drawImage 合成回主画布(暗主题 lighter 加色 = 星光)。
  // 形变期: 每颗粒子按自己的错峰延迟 dl 在「3D 端 ↔ 2D 端」间滑行, 背面粒子边滑边淡入。pAlpha 控整体淡入淡出。
  function drawParticles(P, pAlpha) {
    if (!parts.n || W < 4 || H < 4) return
    const PW = Math.round(W), PH = Math.round(H)
    if (!pcv || pcv.width !== PW || pcv.height !== PH) {
      pcv = pcv || document.createElement('canvas')
      pcv.width = PW; pcv.height = PH
      pcx = pcv.getContext('2d')
      pimg = pcx.createImageData(PW, PH); p8 = pimg.data; p32 = new Uint32Array(p8.buffer)
    }
    p32.fill(0)
    const pr = P.isDark ? 168 : 26, pg = P.isDark ? 206 : 48, pb = P.isDark ? 236 : 72
    const gA = (P.isDark ? 1.18 : 1.12) * (pAlpha == null ? 1 : pAlpha)
    const m = MV
    const m00 = m[0][0], m01 = m[0][1], m02 = m[0][2], m10 = m[1][0], m11 = m[1][1], m12 = m[1][2], m20 = m[2][0], m21 = m[2][1], m22 = m[2][2]
    const { n, lo, vx, vy, vz, my, br, w3, uu, dl, ph, big } = parts
    const t3 = mt <= 0, t2 = mt >= 1, rw = PW * 4
    // drawN: 绘制数随 zoom² 增长(到 POOL 封顶) → 放大时粒子动态变多, 屏上疏密大致恒定。直接取 R2
    // 前缀 [0,drawN)(低差异 → 均匀, 越往后越细分; 不可乱序, 否则前缀变随机子集出现团块)。
    const drawN = Math.min(n, Math.max(PT_MIN, Math.round(PT_DENS * zoom * zoom)))
    // spread: 缩放超过封顶后, 点已全画仍显稀 → 让每颗向四邻(更高倍再加对角)铺开, 填空隙不再稀疏
    const spread = clamp((zoom - 1.25) * .6, 0, 1)
    for (let i = 0; i < drawN; i++) {
      // 纬度门控: 池在墨卡托图上均匀 → 2D(keepP=1)全留即均匀; 3D(keepP=cos²lat)按概率留 → 还原
      // 球面均匀; 形变中阈值 w3→1, 高纬「2D 专属」粒子随地图摊平丝滑淡入(gate 软边)。
      const keepP = ms >= 1 ? 1 : w3[i] + (1 - w3[i]) * ms
      const ug = uu[i]
      if (ug >= keepP) continue
      const gate = keepP >= 1 ? 1 : Math.min(1, (keepP - ug) * 9)
      let sx = 0, sy = 0, al = 0, z3 = -1
      let x3 = 0, y3 = 0
      if (!t2) {
        x3 = m00 * vx[i] + m01 * vy[i] + m02 * vz[i]
        y3 = m10 * vx[i] + m11 * vy[i] + m12 * vz[i]
        z3 = m20 * vx[i] + m21 * vy[i] + m22 * vz[i]
      }
      if (t3) {
        if (z3 < .015) continue
        sx = cx + x3 * R; sy = cy - y3 * R
        al = .3 + .7 * Math.min(1, z3 * 1.5)
      } else {
        let dx = lo[i] - lam0; dx -= TAU * Math.round(dx / TAU)
        const sx2 = cx + dx * R, sy2 = cy - (my[i] - Y0) * R
        if (t2) { sx = sx2; sy = sy2; al = 1 }
        else {
          let ti = mt * (1 + STAG) - dl[i]; ti = ti < 0 ? 0 : ti > 1 ? 1 : ti
          ti = ti * ti * (3 - 2 * ti)
          const a3 = z3 < .015 ? 0 : .3 + .7 * Math.min(1, z3 * 1.5)
          const sx3 = cx + x3 * R, sy3 = cy - y3 * R
          sx = sx3 + (sx2 - sx3) * ti; sy = sy3 + (sy2 - sy3) * ti
          al = a3 + (1 - a3) * ti
          if (al < .02) continue
        }
      }
      if (sx < 2 || sy < 2 || sx >= PW - 2 || sy >= PH - 2) continue   // 屏外早剔(留 2px 边距给 splat 不越界)
      const tt = (introT * .45 + ph[i]) % 1                       // 三角波闪烁(比 sin 便宜)
      al *= br[i] * gate * (.8 + .55 * (tt < .5 ? tt : 1 - tt)) * gA
      if (al <= 0) continue
      const va = al >= 1 ? 255 : al * 255
      // 双线性 splat: 按亚像素权重把亮度分到相邻 4 像素 → 转动时点在像素间平滑移动, 不再逐像素跳变(消抖)
      const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy, gx = 1 - fx, gy = 1 - fy
      const k = (iy * PW + ix) * 4
      p8[k] = pr; p8[k + 1] = pg; p8[k + 2] = pb; p8[k + 3] += va * gx * gy
      p8[k + 4] = pr; p8[k + 5] = pg; p8[k + 6] = pb; p8[k + 7] += va * fx * gy
      p8[k + rw] = pr; p8[k + rw + 1] = pg; p8[k + rw + 2] = pb; p8[k + rw + 3] += va * gx * fy
      p8[k + rw + 4] = pr; p8[k + rw + 5] = pg; p8[k + rw + 6] = pb; p8[k + rw + 7] += va * fx * fy
      // 高倍 splat 填空隙(此时已放大、转动少, 用最近邻向四邻/对角铺开即可): 亮星恒亮
      const cr = big[i] ? va * .5 : (spread > 0 ? va * spread * .5 : 0)
      if (cr > 0) {
        p8[k - 4] = pr; p8[k - 3] = pg; p8[k - 2] = pb; p8[k - 1] += cr
        p8[k + 8] = pr; p8[k + 9] = pg; p8[k + 10] = pb; p8[k + 11] += cr
        p8[k - rw] = pr; p8[k - rw + 1] = pg; p8[k - rw + 2] = pb; p8[k - rw + 3] += cr
        p8[k + 2 * rw] = pr; p8[k + 2 * rw + 1] = pg; p8[k + 2 * rw + 2] = pb; p8[k + 2 * rw + 3] += cr
        if (spread > .5 && !big[i]) {                             // 更高倍: 连对角一起铺(2×2 块感)
          const dr = va * spread * .3
          p8[k - rw - 4] = pr; p8[k - rw - 3] = pg; p8[k - rw - 2] = pb; p8[k - rw - 1] += dr
          p8[k - rw + 8] = pr; p8[k - rw + 9] = pg; p8[k - rw + 10] = pb; p8[k - rw + 11] += dr
          p8[k + 2 * rw - 4] = pr; p8[k + 2 * rw - 3] = pg; p8[k + 2 * rw - 2] = pb; p8[k + 2 * rw - 1] += dr
          p8[k + 2 * rw + 8] = pr; p8[k + 2 * rw + 9] = pg; p8[k + 2 * rw + 10] = pb; p8[k + 2 * rw + 11] += dr
        }
      }
    }
    pcx.putImageData(pimg, 0, 0)
    ctx.save()
    if (P.isDark) ctx.globalCompositeOperation = 'lighter'
    ctx.drawImage(pcv, 0, 0, W, H)
    ctx.restore()
  }
  function drawAbstractGlobe(P) {
    // 外发光: 仅柔和勾出球的轮廓(渐隐到透明 → 不形成硬圆盘边)
    const glow = ctx.createRadialGradient(cx, cy, R * .72, cx, cy, R * 1.5)
    glow.addColorStop(0, `rgba(${P.accentRgb},.09)`); glow.addColorStop(1, `rgba(${P.accentRgb},0)`)
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, R * 1.5, 0, TAU); ctx.fill()

    const hx = cx - R * .32, hy = cy - R * .4
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip()
    // 关键: 不填充任何实心本体 → 页面背景(含点阵网格)直接透过玻璃球, 与 main 背景零色差融合。
    // 仅叠一层半透明高光 + 极淡 accent 边缘塑出球感, 再画经纬/海岸线。
    const body = ctx.createRadialGradient(hx, hy, R * .1, cx, cy, R * 1.05)
    body.addColorStop(0, 'rgba(255,255,255,.5)')        // 左上受光高光(比背景亮 → 球感)
    body.addColorStop(.5, 'rgba(255,255,255,.13)')
    body.addColorStop(.85, `rgba(${P.accentRgb},.05)`)  // 边缘极淡 accent(玻璃感, 非硬边)
    body.addColorStop(1, `rgba(${P.accentRgb},.1)`)
    ctx.fillStyle = body; ctx.fillRect(cx - R, cy - R, R * 2, R * 2)
    ctx.restore()
    // 玻璃高光边(左上亮 → 右下淡 accent, 不形成完整硬环)
    ctx.save(); ctx.lineWidth = 1.3
    const rim = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R)
    rim.addColorStop(0, 'rgba(255,255,255,.85)'); rim.addColorStop(.5, `rgba(${P.accentRgb},0)`); rim.addColorStop(1, `rgba(${P.accentRgb},.28)`)
    ctx.strokeStyle = rim; ctx.beginPath(); ctx.arc(cx, cy, R - .6, 0, TAU); ctx.stroke(); ctx.restore()
  }
  function drawGlobe(P) {
    if (!P.isDark) { drawAbstractGlobe(P); return }
    const atmo = P.atmoRgb
    // 太空底: 把球周围压暗到接近本体色, 让黑色星球融进页面背景, 不露生硬圆盘边(随缩放一起放大)
    const space = ctx.createRadialGradient(cx, cy, R * .5, cx, cy, R * 1.9)
    space.addColorStop(0, 'rgba(5,8,15,.95)'); space.addColorStop(.52, 'rgba(5,8,15,.92)'); space.addColorStop(1, 'rgba(5,8,15,0)')
    ctx.fillStyle = space; ctx.fillRect(0, 0, W, H)
    ctx.save(); ctx.globalCompositeOperation = 'lighter'
    const haloR = R * 1.4, halo = ctx.createRadialGradient(cx, cy, R * .95, cx, cy, haloR)
    halo.addColorStop(0, `rgba(${atmo},.14)`); halo.addColorStop(.3, `rgba(${atmo},.05)`); halo.addColorStop(1, `rgba(${atmo},0)`)
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, TAU); ctx.fill(); ctx.restore()

    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip()
    ctx.fillStyle = '#05080f'; ctx.fillRect(cx - R, cy - R, R * 2, R * 2)
    const vol = ctx.createRadialGradient(cx - R * .15, cy - R * .18, R * .1, cx, cy, R)
    vol.addColorStop(0, 'rgba(20,38,60,.5)'); vol.addColorStop(.6, 'rgba(10,20,34,.22)'); vol.addColorStop(1, 'rgba(2,5,10,.5)')
    ctx.fillStyle = vol; ctx.fillRect(cx - R, cy - R, R * 2, R * 2)
    ctx.save(); ctx.globalCompositeOperation = 'lighter'
    const fres = ctx.createRadialGradient(cx, cy, R * .82, cx, cy, R)
    fres.addColorStop(0, `rgba(${atmo},0)`); fres.addColorStop(.85, `rgba(${atmo},.06)`); fres.addColorStop(1, `rgba(${atmo},.24)`)
    ctx.fillStyle = fres; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill(); ctx.restore()
    ctx.restore()

    ctx.save(); ctx.globalCompositeOperation = 'lighter'
    ctx.lineWidth = 1.4; ctx.strokeStyle = `rgba(${atmo},.28)`
    ctx.beginPath(); ctx.arc(cx, cy, R - .6, 0, TAU); ctx.stroke(); ctx.restore()
  }

  // 圆角矩形(标签底板)
  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
  }

  // 探测点「光点」: 全部可用位置, 亮度/大小 ∝ count(log 标度); 选中=accent 高亮 + 环; hover 加环。
  // 画在路径/节点之下(背景网络感), 同时把屏幕位置压进 locHits 供命中检测。
  function drawLocations(P) {
    locHits.length = 0
    if (hideLoc || !locations.length) return
    for (const L of locations) {
      const p = projectLL(L.la, L.lo); if (p.z <= .04) continue
      const sx = p.sx, sy = p.sy, z = clamp(p.z, 0, 1)
      const mag = Math.min(1, Math.log(L.count + 1) / Math.log(60))     // 0..1 越多越亮
      const sel = L.sel > 0
      const isHot = hover && hover.kind === 'loc' && hover.loc.id === L.id
      const col = sel ? P.accentRgb : (P.isDark ? '150,205,255' : '70,130,165')
      const r = (1.3 + mag * 2.4) * (sel ? 1.3 : 1)
      ctx.save(); ctx.globalCompositeOperation = 'lighter'
      const ga = (sel ? .55 : .16 + mag * .24) * z
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 4.2)
      glow.addColorStop(0, `rgba(${col},${ga})`); glow.addColorStop(1, `rgba(${col},0)`)
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(sx, sy, r * 4.2, 0, TAU); ctx.fill(); ctx.restore()
      const da = (sel ? .95 : .4 + mag * .42) * z
      ctx.fillStyle = `rgba(${col},${da})`; ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fill()
      if (sel || isHot) { ctx.strokeStyle = `rgba(${col},${isHot ? .9 : .55})`; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(sx, sy, r + (isHot ? 4 : 3), 0, TAU); ctx.stroke() }
      locHits.push({ sx, sy, L })
    }
  }
  function setLocations(list) { locations = (list || []).map(L => ({ ...L, la: L.lat * D2R, lo: L.lon * D2R })) }
  function setHold(h) { hold = !!h }
  function setHideLoc(b) { hideLoc = !!b }

  // ── 主循环 ──
  let introT = 0, last = performance.now(), raf = 0
  function frame(now) { try { draw(now) } catch (e) { /* 单帧错误不杀循环 */ } raf = requestAnimationFrame(frame) }

  function draw(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now
    introT += dt

    // 2D/3D 形变推进: mt 朝目标模式滑动; ms = smoothstep(mt) 是本帧全局混合系数
    const mdir = mode2d ? 1 : -1
    if ((mdir > 0 && mt < 1) || (mdir < 0 && mt > 0)) mt = clamp(mt + dt / MORPH_T * mdir, 0, 1)
    ms = mt <= 0 ? 0 : mt >= 1 ? 1 : mt * mt * (3 - 2 * mt)
    if (zFix && !mode2d) { zoom = zFix.from + (zFix.to - zFix.from) * (1 - mt); if (mt <= 0) zFix = null }

    if (homing) {                    // 复位: 缩放/平移指数缓动归位(朝向由 cam/cam2 缓飞负责)
      const k = 1 - Math.exp(-dt * 4)
      zoom += (ZOOM0 - zoom) * k; panX += -panX * k; panY += -panY * k
      cx = baseCx + panX; cy = baseCy + panY
      if (Math.abs(zoom - ZOOM0) < .003 && Math.abs(panX) < .6 && Math.abs(panY) < .6) {
        zoom = ZOOM0; panX = 0; panY = 0; cx = baseCx; cy = baseCy; homing = false
      }
    }

    R = Rbase * zoom                 // 应用滚轮缩放
    const P = palette()

    // 相机: 缓飞到目标朝向 → 之后绕地理北极极慢自转(悬停节点 / popup 打开 / 拖动 / 非纯 3D 时暂停)
    if (cam.flying && cam.q) {
      const k = 1 - Math.exp(-dt * 2.6)
      q = qSlerp(q, cam.q, k)
      cam.flyT += dt; if (cam.flyT > 1.7) cam.flying = false
    } else if (!drag.active && !hover && !hold && mt === 0 && !probes.length && !target) {
      q = qMul(q, qAxis(0, 0, 1, dt * 0.018))     // 绕地球自身极轴自转(任意朝向下都自然); 有结果时静止
    }
    if (cam2.on) {                   // 2D 缓飞: 地图中心滑向目标
      const k = 1 - Math.exp(-dt * 2.6)
      lam0 = wrapPi(lam0 + wrapPi(cam2.lam - lam0) * k)
      Y0 += (cam2.Y - Y0) * k
      cam2.t += dt; if (cam2.t > 1.7) cam2.on = false
    }
    // 2D 垂直约束(墨卡托无两极, 不能横向那样无限): 带比视口高→钳进覆盖视口(不露上下白边); 比视口矮→居中。
    if (mt >= 1) {
      const halfH = MERC_MAX * R
      let ty = cy + Y0 * R
      ty = 2 * halfH >= H ? clamp(ty, H - halfH, halfH) : H / 2
      Y0 = clamp((ty - cy) / R, -MERC_MAX, MERC_MAX)
    }
    MV = qMat(q)                     // 本帧旋转矩阵(projXYZ / drawParticles 共用)

    ctx.clearRect(0, 0, W, H)
    // chrome 交叉淡入淡出: 球体(圆盘/大气) ↔ 地图框; 经纬网走统一投影自己形变
    if (ms < 1) {
      if (ms > 0) { ctx.save(); ctx.globalAlpha = 1 - ms }
      drawGlobe(P)
      if (ms > 0) ctx.restore()
    }
    if (ms > 0) { ctx.save(); ctx.globalAlpha = ms; drawMapFrame(P); ctx.restore() }
    if (ms >= 1) drawGraticule2D(P)   // 静止 2D: 直线经纬网, 横向平铺(无界)
    else drawGraticule(P)             // 3D / 形变: 投影经纬网(随形变)
    // 陆地: 静止两端画实心大陆架(3D 正交 / 2D 墨卡托); 形变中段溶解成粒子飞行。三者权重和恒为 1,
    // 互相交叉淡入淡出 → 实心大陆「化为粒子飞过去再凝结回实心」, 静止时完全不跑粒子(省 CPU)。
    const ss = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x)
    const land3dA = 1 - ss(mt / .2)            // mt 0→0.2: 实心 3D 陆地淡出
    const land2dA = ss((mt - .8) / .2)         // mt 0.8→1: 实心 2D 陆地淡入
    const partA = (1 - land3dA) - land2dA      // 中段(0.2~0.8)纯粒子; 两端为 0
    if (land3dA > .002) { ctx.save(); ctx.globalAlpha = land3dA; drawLand3D(P); ctx.restore() }
    if (land2dA > .002) { ctx.save(); ctx.globalAlpha = land2dA; drawLand2D(P); ctx.restore() }
    if (partA > .002) drawParticles(P, partA)  // 粒子仅形变中段出现
    drawLocations(P)            // 探测点光点(背景网络, 在路径/节点之下)

    // 节点投影缓存 + 推进各 probe 的「逐段生长」
    const GROW = 2.6      // 每段生长速度(越大越快)
    for (const p of probes) {
      const nodes = [p._n0, ...p.hops]   // 监测点 + 各跳(均带地理笛卡尔向量)
      p._nodes = nodes
      // 已「到达」的跳数 = hops.length; 让 segGrow 朝 1 推进, 形成逐段点亮
      let frontier = -1
      for (let i = 0; i < p.hops.length; i++) {
        // 前一段长成 ~0.6 后,本段才开始(链式生长)
        const prevOk = i === 0 ? true : p.segGrow[i - 1] > .55
        if (prevOk) p.segGrow[i] = clamp(p.segGrow[i] + dt * GROW, 0, 1)
        if (p.segGrow[i] > .02) frontier = i
      }
      p._frontier = frontier
    }

    const dimAll = activeProbe != null
    // 1) 路径弧线(每段按 segGrow 生长; 非激活 probe 压暗)
    for (const p of probes) {
      if (hidden.has(p.id)) continue
      const nodes = p._nodes; if (!nodes) continue
      const act = !dimAll || activeProbe === p.id
      const baseA = act ? 1 : .14
      for (let i = 0; i < p.hops.length; i++) {
        const g = p.segGrow[i]; if (g <= .001) continue
        const a = nodes[i], b = nodes[i + 1]
        const za = (projectLL(a.la, a.lo).z + projectLL(b.la, b.lo).z) / 2
        const depth = clamp(za * .5 + .5, 0, 1)
        // 底层稍粗的辉光 + 上层亮线
        drawArc(a, b, p.rgb, g, (.10 + depth * .12) * baseA, (act ? 5.5 : 3) * (.5 + depth * .5))
        drawArc(a, b, p.rgb, g, (.5 + depth * .4) * baseA, (act ? 1.7 : 1) * (.7 + depth * .5))
        // 生长中的弧头亮点
        if (g < .999 && i === p._frontier) {
          const tip = arcPoint(a, b, g)
          if (tip.vz > -.02) { ctx.fillStyle = `rgba(255,255,255,${.9 * baseA})`; ctx.beginPath(); ctx.arc(tip.sx, tip.sy, 2.4, 0, TAU); ctx.fill() }
        }
      }
    }

    // 2) MTR「探测波」彗星 + 路径上的持续数据包
    for (const p of probes) {
      if (hidden.has(p.id)) continue
      const nodes = p._nodes; if (!nodes || p._frontier < 0) continue
      const act = !dimAll || activeProbe === p.id
      const reach = p._frontier + (p.segGrow[p._frontier] || 0)    // 当前可到达的「连续段数」(含分数)
      // 探测波: 周期性从监测点扫到当前最远跳(像 ttl 递增的探测)
      p.waveGap -= dt
      if (p.waveGap <= 0 && reach > .2) { p.waveT = 0; p.waveGap = 1.6 + Math.random() * 1.2 }
      if (p.waveT >= 0) {
        p.waveT += dt * 1.35
        const head = p.waveT * Math.max(1, reach)
        for (let k = 0; k < 5; k++) {                              // 彗尾 5 个点
          const s = head - k * 0.16
          if (s <= 0 || s >= reach) continue
          const si = Math.floor(s), sf = s - si
          if (si >= p.hops.length) continue
          const pt = arcPoint(nodes[si], nodes[si + 1], sf); if (pt.vz <= -.02) continue
          const fade = (1 - k / 5) * (act ? 1 : .3)
          ctx.fillStyle = `rgba(${p.rgb},${.9 * fade})`; ctx.beginPath(); ctx.arc(pt.sx, pt.sy, (3.1 - k * .42), 0, TAU); ctx.fill()
          if (k === 0) { ctx.fillStyle = `rgba(255,255,255,${.95 * fade})`; ctx.beginPath(); ctx.arc(pt.sx, pt.sy, 1.5, 0, TAU); ctx.fill() }
        }
        if (head > reach + .8) p.waveT = -1
      }
    }
    // 持续流量包(只在路径全建好的 probe 上, 朝目标匀速流)
    pktAcc += dt
    while (pktAcc > .5) {
      pktAcc -= .5
      const done = probes.filter(p => p.status === 'done' && p.hops.length && !hidden.has(p.id))
      if (done.length) { const p = done[Math.floor(Math.random() * done.length)]; packets.push({ p, s: 0, spd: .55 + Math.random() * .25 }) }
    }
    for (let i = packets.length - 1; i >= 0; i--) {
      const pk = packets[i], p = pk.p, nodes = p._nodes
      pk.s += pk.spd * dt; if (!nodes || pk.s >= p.hops.length) { packets.splice(i, 1); continue }
      if (hidden.has(p.id)) continue                     // 该 probe 已隐藏: 飞行中的包停止绘制(仍推进至消失)
      const si = Math.floor(pk.s), sf = pk.s - si
      const pt = arcPoint(nodes[si], nodes[si + 1], sf); if (pt.vz <= -.02) continue
      const act = !dimAll || activeProbe === p.id
      const fade = Math.min(1, Math.min(pk.s, p.hops.length - pk.s) * 3) * (act ? 1 : .35)
      ctx.fillStyle = `rgba(255,255,255,${.95 * fade})`; ctx.beginPath(); ctx.arc(pt.sx, pt.sy, 1.7, 0, TAU); ctx.fill()
      ctx.strokeStyle = `rgba(${p.rgb},${.6 * fade})`; ctx.lineWidth = 1.4; ctx.stroke()
    }

    // 3) hover 命中检测(探测点光点 / 节点 probe / hop / target)。同时把全部可点目标记入 hitList 供点击用。
    let nextHover = null, best = 1e9
    hitList.length = 0
    const test = (sx, sy, rad, payload) => {
      hitList.push({ sx, sy, rad, payload })
      if (!pointer.inside || drag.active) return
      const d = (sx - pointer.x) ** 2 + (sy - pointer.y) ** 2
      if (d < rad * rad && d < best) { best = d; payload.sx = sx; payload.sy = sy; nextHover = payload }
    }
    for (const lh of locHits) test(lh.sx, lh.sy, 10, { kind: 'loc', loc: lh.L })

    // 4) 目标靶标(脉冲环)
    if (target) {
      const pt = projectLL(target.la, target.lo, LIFT)
      if (pt.z > -.05) {
        const sx = pt.sx, sy = pt.sy
        const pulse = (introT * .9) % 1
        ctx.save(); ctx.globalCompositeOperation = 'lighter'
        ctx.strokeStyle = `rgba(${P.signalRgb},${(1 - pulse) * .55})`; ctx.lineWidth = 1.6
        ctx.beginPath(); ctx.arc(sx, sy, 6 + pulse * 22, 0, TAU); ctx.stroke()
        ctx.strokeStyle = `rgba(${P.signalRgb},${(1 - ((pulse + .5) % 1)) * .35})`; ctx.lineWidth = 1.2
        ctx.beginPath(); ctx.arc(sx, sy, 6 + ((pulse + .5) % 1) * 22, 0, TAU); ctx.stroke()
        ctx.restore()
        // 十字准星 + 实心靶心
        ctx.strokeStyle = `rgba(${P.signalRgb},.9)`; ctx.lineWidth = 1.4
        ctx.beginPath(); ctx.moveTo(sx - 9, sy); ctx.lineTo(sx - 4, sy); ctx.moveTo(sx + 4, sy); ctx.lineTo(sx + 9, sy)
        ctx.moveTo(sx, sy - 9); ctx.lineTo(sx, sy - 4); ctx.moveTo(sx, sy + 4); ctx.lineTo(sx, sy + 9); ctx.stroke()
        ctx.fillStyle = css('--signal') || '#fbbf24'; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, TAU); ctx.fill()
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx - 1, sy - 1, 1.3, 0, TAU); ctx.fill()
        target._sx = sx; target._sy = sy; target._vis = pt.z > .04
        test(sx, sy, 16, { kind: 'target' })
      } else target._vis = false
    }

    // 5) 跳节点(小圆点, 按 probe 色)+ 监测点(发光大点 + 城市标签)
    for (const p of probes) {
      if (hidden.has(p.id)) continue                     // 隐藏的 probe: 节点/源点不画, 也不进命中列表
      const nodes = p._nodes; if (!nodes) continue
      const act = !dimAll || activeProbe === p.id
      // 中途跳
      for (let i = 0; i < p.hops.length; i++) {
        if (p.segGrow[i] < .9 || p.hops[i].isTarget) continue
        const n = p.hops[i], pt = projectLL(n.la, n.lo, LIFT); if (pt.z <= .02) continue
        const sx = pt.sx, sy = pt.sy
        const a = (act ? .85 : .25) * clamp((pt.z) * 3, .2, 1)
        ctx.fillStyle = `rgba(${p.rgb},${a})`; ctx.beginPath(); ctx.arc(sx, sy, 2.4, 0, TAU); ctx.fill()
        test(sx, sy, 11, { kind: 'hop', node: n, probe: p })
      }
      // 监测点
      const pp = projectLL(p.lat * D2R, p.lon * D2R, LIFT)
      if (pp.z > -.02) {
        const sx = pp.sx, sy = pp.sy
        p._sx = sx; p._sy = sy; p._vis = pp.z > .04
        const appear = clamp((introT - p.appearT) / .5, 0, 1)
        const r = 4.6 * appear
        const isHot = hover && hover.kind === 'probe' && hover.probe.id === p.id
        const a = (act ? 1 : .4) * appear
        ctx.save(); ctx.globalCompositeOperation = 'lighter'
        const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 16)
        glow.addColorStop(0, `rgba(${p.rgb},${.5 * a})`); glow.addColorStop(1, `rgba(${p.rgb},0)`)
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(sx, sy, 16, 0, TAU); ctx.fill(); ctx.restore()
        if (p.status === 'probing') {       // 探测中: 外圈扫描环
          const sp = (introT * 1.4) % 1
          ctx.strokeStyle = `rgba(${p.rgb},${(1 - sp) * .6 * a})`; ctx.lineWidth = 1.3
          ctx.beginPath(); ctx.arc(sx, sy, r + 2 + sp * 12, 0, TAU); ctx.stroke()
        }
        if (isHot) { ctx.strokeStyle = `rgba(${p.rgb},.8)`; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, TAU); ctx.stroke() }
        ctx.fillStyle = `rgb(${p.rgb})`; ctx.globalAlpha = a; ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fill()
        ctx.fillStyle = `rgba(${P.glassRgb},.85)`; ctx.beginPath(); ctx.arc(sx - r * .3, sy - r * .3, r * .34, 0, TAU); ctx.fill()
        ctx.globalAlpha = 1
        test(sx, sy, 13, { kind: 'probe', probe: p })
      } else p._vis = false
    }

    hover = nextHover
    surf.classList.toggle('hot', !!hover)
    // 边沿触发: 仅当「悬停的监测点」变化时回调(不每帧喷 null, 否则会和控制台卡片的 hover-高亮打架)
    const hid = hover && hover.kind === 'probe' ? hover.probe.id : null
    if (onhover && hid !== lastHoverId) { lastHoverId = hid; onhover(hid) }
    // 探测点光点: 边沿触发交给组件弹 DOM popup(可滚动/逐个添加); 不走 canvas tooltip
    const lid = hover && hover.kind === 'loc' ? hover.loc.id : null
    if (onlochover && lid !== lastLocId) { lastLocId = lid; onlochover(lid ? hover.loc : null, hover ? hover.sx : 0, hover ? hover.sy : 0) }

    // 6) tooltip(canvas 外的 DOM, 在 hover 节点上方) —— 仅 probe/hop/target, loc 用组件 popup
    if (tipEl) {
      if (hover && hover.kind !== 'loc') {
        const a = tipEl.querySelector('.tg-a'), b = tipEl.querySelector('.tg-b'), c = tipEl.querySelector('.tg-c')
        if (hover.kind === 'probe') {
          const p = hover.probe
          a.textContent = p.city + ' · ' + p.cc; b.textContent = 'AS' + p.asn + ' ' + (p.network || ''); c.textContent = p.status === 'done' ? `${p.hops.length} hops` : (p.status === 'probing' ? 'probing…' : 'queued')
        } else if (hover.kind === 'target') {
          a.textContent = 'TARGET'; b.textContent = shortIp(target.ip || ''); c.textContent = (target.city || '')
        } else {
          const n = hover.node
          a.textContent = '#' + n.idx + '  ' + shortIp(n.ip || ''); b.textContent = n.asn ? ('AS' + n.asn + ' ' + (n.name || '')) : (n.name || '—'); c.textContent = (n.city ? n.city + ' · ' : '') + (n.rtt != null ? n.rtt + ' ms' : '')
        }
        tipEl.style.left = hover.sx + 'px'; tipEl.style.top = (hover.sy - 8) + 'px'; tipEl.classList.add('on')
      } else tipEl.classList.remove('on')
    }
  }
  raf = requestAnimationFrame(frame)

  return {
    setData, setLocations, setHold, setMode, focus, setHidden, setHideLoc, setLockNorth, recenter, reset, setHome,
    destroy() {
      cancelAnimationFrame(raf); ro.disconnect()
      window.removeEventListener('mousemove', onMove); surf.removeEventListener('mouseleave', onLeave); surf.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onWinMove); window.removeEventListener('mouseup', onWinUp)
      surf.removeEventListener('touchstart', onTStart); surf.removeEventListener('touchmove', onTMove); surf.removeEventListener('touchend', onTEnd)
      surf.removeEventListener('wheel', onWheel); surf.removeEventListener('click', onClick); surf.removeEventListener('contextmenu', onCtx)
    },
  }
}
