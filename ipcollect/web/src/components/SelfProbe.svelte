<script>
  // 首页「你的接入」自助探测 —— 多出口卡片(单一 DOM, 真·层叠)。
  // 请求一批开放 CORS 的边缘端点(geo.probeEgressIps: cdn-cgi/trace + upyun), 取各端点看到的
  // 客户端 IP, 去重后按 family 分两叠(左 v4 / 右 v6); 有几个出口 IP 就有几张(每族最多 4)。
  //
  // 关键: 所有卡片是同一批持久 DOM 元素, 从不重新生成。两种布局(叠 / 摊)都由 styleFor() 算出
  // 每张卡的 transform(绝对定位 + 居中 left:50%), 靠 CSS transition 在两态间平滑过渡 ——
  //   · 叠(collapsed): 每族 N 张真叠在一起(第 2 张后透明), 点叠 = 切下一张; 第一张带 [+N IP] 角标。
  //   · 摊(expanded): 同一批卡飞向网格(一行≤4), v4/v6 同时发; 收回即逆过程, 同一批元素飞回叠。
  // family 由右下角 IPv4/IPv6 色标(family 背景色)标识。富集(probeIp)只改卡内文案, 不动元素。
  import { onMount } from 'svelte'
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { probeHomeIps, probeEgressIps, probeStun } from '../lib/geo.js'
  import { probeIp, openProbe, collapseProbe } from '../lib/queries.js'
  import { holderOrg } from '../lib/rdap.js'
  import { iVisible, iLowvis, iLoc } from '../lib/icons.js'
  import { iChevD, iProbe } from '../lib/icons.js'

  let { onpick = () => {} } = $props()

  // 几何: 间距常量固定; 卡宽/高随窄屏(移动端 IP 探测)自适应 —— 见下 narrow/CARDW/CARDH。
  const GAP = 16, PILEGAP = 40

  // 来源徽标配色: 按站点类别分类(AI / 交易所 / 开发工具 / 媒体社交 / WebRTC / 直连探测 / 其它)。
  const CAT_COLOR = { ai: '#a855f7', ex: '#f59e0b', dev: '#3b82f6', media: '#ec4899', stun: '#14b8a6', direct: '#22c55e', other: '#6366f1' }
  const SRC_CAT = {
    OpenAI: 'ai', Claude: 'ai', Grok: 'ai', Anthropic: 'ai', Perplexity: 'ai', ChatGPT: 'ai', Sora: 'ai',
    Coinbase: 'ex', OKX: 'ex',
    SakuraFrp: 'dev', cdnjs: 'dev', jsDelivr: 'dev', 'CF Mirrors': 'dev', npm: 'dev', Kali: 'dev', unpkg: 'dev', 'Node.js': 'dev', GitLab: 'dev', PerfOps: 'dev', 'CF-NS': 'dev', Upyun: 'dev', Aliyun: 'dev',
    Crunchyroll: 'media', Discord: 'media', X: 'media', Medium: 'media', Netease: 'media',
    Qualcomm: 'other',
  }
  function srcCat(name) {
    if (!name) return 'other'
    if (name.startsWith('STUN')) return 'stun'                 // WebRTC/STUN 一类
    if (name.startsWith('IPv4') || name.startsWith('IPv6') || name === 'PEER.AS') return 'direct'   // 直连/单栈/自有域探测一类
    return SRC_CAT[name] || 'other'
  }
  const srcColor = (name) => CAT_COLOR[srcCat(name)]
  // 展示文案: 品牌名原样; 两个直连探测的稳定标识经 i18n 译出(随语言切换)。
  function srcLabel(name) {
    if (name === 'IPv6-direct') return t('sp_src_v6direct')
    if (name === 'IPv4-single') return t('sp_src_v4single')
    return name
  }

  // 隐藏 IP(截图/隐私): 仅遮挡出口地址, 富集照常。v4/v6 各自独立, 记忆于 localStorage("v4,v6" 两位)。
  const HIDE_KEY = 'ipc-hide-self-ip'
  let hide = $state((() => {
    try { const s = (localStorage.getItem(HIDE_KEY) || '').split(','); return [s[0] === '1', s[1] === '1'] }
    catch (e) { return [false, false] }
  })())
  function toggleHide(fi) {
    hide[fi] = !hide[fi]
    try { localStorage.setItem(HIDE_KEY, (hide[0] ? '1' : '0') + ',' + (hide[1] ? '1' : '0')) } catch (e) { /* 隐私模式忽略 */ }
  }
  // 摊开态点卡片空白处: 两个协议栈一起切换(有任一在显示 → 全隐藏; 全隐藏 → 全显示)。
  function toggleHideAll() {
    const v = !hide[0] || !hide[1]
    hide[0] = v; hide[1] = v
    try { localStorage.setItem(HIDE_KEY, (hide[0] ? '1' : '0') + ',' + (hide[1] ? '1' : '0')) } catch (e) { /* 隐私模式忽略 */ }
  }

  let probing = $state(true)
  let settled = $state(false)             // 叠堆是否已"结算"(全部 probe + 飞入都完): false=对齐一摞, true=微旋露右下角
  let defaultIp = $state(null)            // 被最多端点看到的出口(浏览器主用栈)
  let fams = $state([
    { fam: 'ip4', label: 'IPv4', accent: '#2563eb', entries: [], front: 0 },   // 蓝
    { fam: 'ip6', label: 'IPv6', accent: '#9333ea', entries: [], front: 0 },   // 紫
  ])

  // onSource(ip, source): 每个端点每看到一次出口 IP 就回调(带来源品牌名)。提到组件作用域,
  // 让首页最小探测与(点开后的)完整探测共用同一汇入口。
  //  · 新 IP → 立刻插卡 + 异步库内富集(prefix/ASN/geo)在原地补;
  //  · 已有该 IP → 只把来源累加进 sources(展开详情显示"来源 +N")。
  const onSource = (ip, src) => {                                // src = { name, host }
    const fi = ip.includes(':') ? 1 : 0
    const cur = fams[fi].entries
    const idx = cur.findIndex(e => e.ip === ip)
    if (idx >= 0) {                                              // 已有: 累加来源(按 name 去重)
      const s = cur[idx].sources
      if (!s.some(x => x.name === src.name)) fams[fi].entries[idx].sources = [...s, src]
      return
    }
    if (cur.length >= 4) return                                  // 每族最多 4 张(顶 + 露 3 角)
    const ei = cur.length
    fams[fi].entries = [...cur, { ip, enriching: true, info: null, holder: '', sources: [src] }]
    reveal(fams[fi].fam + ':' + ip)                              // 排程入场动画(下一帧落入叠堆)
    probeIp(ip).then((info) => {
      fams[fi].entries[ei].info = info; fams[fi].entries[ei].enriching = false
      const px = info && info.prefix
      if (px) holderOrg(px).then(h => { if (h) fams[fi].entries[ei].holder = h })
    }).catch(() => { fams[fi].entries[ei].enriching = false })
  }

  // 首页最小探测: **只**打自有 Cloudflare 域(default.peer.as 活跃出口 + ipv4.peer.as 的 v4 出口),
  // 不向任何第三方发请求。给出基础的"你的接入"卡片, 邀请用户点开看完整出口。
  async function runHomeProbe() {
    const { defaultIp: dip } = await probeHomeIps(onSource)
    if (dip) defaultIp = dip
    probing = false
    maybeSettle()
  }
  // 完整多出口发现: 30+ 第三方边缘端点(cdn-cgi/trace 等) + WebRTC/STUN 泄漏探测。
  // **仅当用户主动点开 IPv4/IPv6(摊开)时才跑**, 且整页只跑一次。
  let fullProbed = false
  async function runFullProbe() {
    if (fullProbed) return
    fullProbed = true
    probing = true
    const [r] = await Promise.all([probeEgressIps(onSource), probeStun(onSource)])
    probing = false                 // HTTP + STUN 全部结束
    if (r && r.defaultIp) defaultIp = r.defaultIp   // 用 HTTP 票数确定活跃(浏览器主用)协议栈的高亮
    maybeSettle()
  }

  onMount(() => { runHomeProbe() })                 // 首页: 永远只跑最小探测
  // 用户点开 IPv4/IPv6(摊开, expanded → true; 含深链直达 /probe)时, 懒触发一次完整探测。
  $effect(() => { if (S.probeExpanded) runFullProbe() })

  const stop = (e) => e.stopPropagation()
  // 隐藏态: 把每个十六进制位换成 'x'(保留 . : / 分隔符与位数), 真实 IP 不进 DOM, 截图/取证也无法还原。
  const maskIp = (ip) => String(ip).replace(/[0-9a-fA-F]/g, 'x')

  // ── 摊开态 + 布局 ───────────────────────────────────────────────
  let expanded = $derived(S.probeExpanded)
  // 活跃(浏览器主用)协议栈 = 默认出口所属 family; 其 family 色标用淡橙, 其余灰。
  let activeFam = $derived(defaultIp ? (defaultIp.includes(':') ? 'ip6' : 'ip4') : null)
  let secEl = $state()
  let stageW = $state(820)
  // 可用宽度: 移动端(<820)的 stage 从 display:none 切显示时 clientWidth 常没及时更新(还停在初始 820),
  // 会被误算成多列、卡片重叠。故移动端宽度直接用 window 宽(col 整宽 - 边距), 桌面才用实测 stageW。
  let winW = $state(typeof window !== 'undefined' ? window.innerWidth : 1200)
  onMount(() => {
    const f = () => { winW = window.innerWidth }
    f(); window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  })
  let avail = $derived(winW < 820 ? Math.max(150, winW - 20) : (stageW || winW))
  // 窄屏(移动端「IP 探测」摊开)自适应: 卡片近整宽、单列、更扁; 桌面维持 300×150。
  let narrow = $derived(avail < 560)
  let CARDW = $derived(narrow ? Math.min(avail, 460) : 300)
  let CARDH = $derived(narrow ? 116 : 150)
  function toggleExpand() { collapseProbe() }   // 收起钮 = 退出 IP 探测摊开态(回 / URL)

  let renderList = $derived.by(() => {
    // 没探到 IP 的协议栈 = 整块不显示(不出"无 IPvx"提示); 探到几个就出几张卡。
    const out = []; let g = 0
    fams.forEach((f, fi) => {
      const base = { fi, fam: f.fam, accent: f.accent, label: f.label }
      f.entries.forEach((e, ci) => out.push({ ...base, key: f.fam + ':' + e.ip, kind: 'ip', ci, e, g: g++ }))
    })
    return out
  })
  let entryCount = $derived(renderList.filter(c => c.kind === 'ip').length)
  let cols = $derived(Math.max(1, Math.min(4, entryCount || 1, Math.floor((avail + GAP) / (CARDW + GAP)) || 1)))
  let gridRows = $derived(Math.max(1, Math.ceil((entryCount || 1) / cols)))
  // 舞台高度: 无卡时收为 0(探测中且还没拿到任何 IP); 有卡后按叠/摊布局撑开。
  let stageH = $derived(!renderList.length ? 0 : expanded ? gridRows * (CARDH + GAP) - GAP : CARDH + (settled ? 26 : 6))

  // 叠态每族横向落点: 只有一族有卡 → 居中(0); 两族都有 → 左右分置。按"实际有卡的族"数算, 不写死 v4 左/v6 右。
  let pileXs = $derived.by(() => {
    const present = fams.map((f, i) => i).filter(i => fams[i].entries.length > 0)
    const xs = {}
    present.forEach((fi, k) => { xs[fi] = present.length <= 1 ? 0 : (k - (present.length - 1) / 2) * (CARDW + PILEGAP) })
    return xs
  })

  // 逐张入场: 每张新卡(按 key)先以"叠堆正上方 + 透明"渲染一帧, 下一帧记入 revealed →
  // 由 .card 的 CSS transition 落入叠堆 = 一张张"插牌"动画(每拿到一个 IP 就插一张)。
  let revealed = $state(new Set())
  // 入场"飞入"串行队列: 相邻两张强制间隔 100ms 才放下一张 —— 多个 IP 几乎同时到也一张一张落, 不会一起砸下来。
  let revealQ = []
  let revealBusy = false
  function reveal(key) { revealQ.push(key); if (!revealBusy) pumpReveal() }
  function pumpReveal() {
    revealBusy = true
    const key = revealQ.shift()
    if (key === undefined) { revealBusy = false; maybeSettle(); return }   // 队列空 → 看能否结算
    // 双 rAF: 先让新卡以"上方+透明"渲染并绘制一帧, 再翻 revealed → CSS transition 才会从上方落下(否则瞬间归位)。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!revealed.has(key)) revealed = new Set(revealed).add(key)
      setTimeout(pumpReveal, 100)                  // 强制间隔 100ms 再放下一张
    }))
  }

  // 结算: 全部 probe 完成 + 所有飞入都派发并播完之后, 叠堆才从"整齐一摞"展成"微旋露右下角"(发牌感)。
  // 任一条件未满足(还有 probe pending / 还有卡在排队飞入)就不结算。
  function maybeSettle() {
    if (settled || probing || revealBusy || revealQ.length) return
    setTimeout(() => { if (!settled && !probing && !revealBusy && !revealQ.length) settled = true }, 560)  // 等最后一张落位动画(~.55s)播完
  }

  const depthOf = (c) => {
    if (c.kind !== 'ip') return 0
    const n = fams[c.fi].entries.length || 1
    return (c.ci - fams[c.fi].front + n) % n
  }

  function styleFor(c) {
    const pileOffset = pileXs[c.fi] ?? 0
    // 入场前(尚未 reveal): 停在归位叠堆的正上方 + 透明且置顶(z 高 → 看得到它从上方落下);
    // reveal 后 CSS transition 落入叠堆并归位到本卡的层深 z = "插牌"动画。
    if (c.kind === 'ip' && !revealed.has(c.key)) {
      return `transform: translate(${(pileOffset - CARDW / 2).toFixed(1)}px, -34px) scale(.92) rotate(0deg); opacity:0; z-index:40; pointer-events:none;`
    }
    if (expanded && c.kind === 'ip') {
      const row = Math.floor(c.g / cols), col = c.g % cols
      const rowCount = Math.min(cols, entryCount - row * cols)
      const offX = (col - (rowCount - 1) / 2) * (CARDW + GAP)
      const y = row * (CARDH + GAP)
      const z = 30 - depthOf(c)
      return `transform: translate(${(offX - CARDW / 2).toFixed(1)}px, ${y}px) scale(1) rotate(0deg); opacity:1; z-index:${z}; pointer-events:auto;`
    }
    if (expanded) {
      return `transform: translate(${(pileOffset - CARDW / 2).toFixed(1)}px, 0px) scale(.96) rotate(0deg); opacity:0; z-index:0; pointer-events:none;`
    }
    // 未摊开, 分两段时序:
    //  · 未结算(飞入中 / 仍有 probe pending): 整齐对齐叠成一摞, 不露角; 新卡从上方飞入落顶。
    //  · 已结算(全部 probe 完 + 飞入动画都播完): 才微微旋转、错开露出右下角一点(front + 背后最多 2 张)。
    const dd = (fams[c.fi].entries.length - 1) - c.ci    // 0=最新(最上), 越早到越靠下
    if (!settled) {
      return `transform: translate(${(pileOffset - CARDW / 2).toFixed(1)}px, 0px) scale(1) rotate(0deg); opacity:1; z-index:${30 - dd}; pointer-events:auto;`
    }
    // 露角: 不管背后 1/2/3 张, "最深那张"始终落在同一极限(= 原版单张露角 dx7/dy11/rot2.4),
    // 故侵占下方的空位恒定 —— 张数多时只是把这段 0→极限 等分得更密(每张占 dd/behind), 不再越叠越往外。
    const behind = Math.min(fams[c.fi].entries.length - 1, 3)   // 背后露角的张数(最多 3)
    const frac = behind ? Math.min(dd / behind, 1) : 0          // dd=behind → 1(到极限); 顶张/单张 → 0
    const dx = 7 * frac, dy = 11 * frac, rot = 2.4 * frac
    const sc = 1 - 0.06 * frac, op = 1 - 0.18 * frac
    return `transform: translate(${(pileOffset - CARDW / 2 + dx).toFixed(1)}px, ${dy.toFixed(1)}px) scale(${sc.toFixed(3)}) rotate(${rot.toFixed(2)}deg); opacity:${op.toFixed(2)}; z-index:${30 - dd}; pointer-events:auto;`
  }
  // 叠堆最上面那张(最新到的)才挂 famtag / +N 角标; 摊开时 famtag 走 expanded|| 全显。
  function topVisible(c) {
    return c.kind === 'ip' && c.ci === fams[c.fi].entries.length - 1
  }

  $effect(() => {
    if (expanded && secEl) requestAnimationFrame(() => secEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  })
</script>

<!-- origin: ASxxxx + AS 名称 badge -->
{#snippet asn(info)}
  <button class="lk asn" onclick={(ev) => { stop(ev); onpick('AS' + info.origin_asn) }} title={'AS' + info.origin_asn + (info.origin_name ? ' · ' + info.origin_name : '')}>
    <span class="asnum">AS{info.origin_asn}</span>
    {#if info.origin_name}<span class="asname">{info.origin_name}</span>{/if}
  </button>
{/snippet}

<!-- 一张出口卡正文: (折叠态)隐藏钮 + IP(可下钻, 可带 [+N IP]) + 库内富集(前缀 / ASxxxx+名 / 地理) -->
{#snippet body(fi, e, showBadge)}
  <div class="cbody">
    {#if !expanded}
      <button class="fold" class:folded={hide[fi]} onclick={(ev) => { stop(ev); toggleHide(fi) }}
              title={hide[fi] ? t('sp_show') : t('sp_hide')} aria-pressed={hide[fi]}>
        <Fa icon={hide[fi] ? iLowvis : iVisible} />
      </button>
    {/if}
    <div class="iprow">
      {#if hide[fi]}
        <span class="ip masked">{maskIp(e.ip)}</span>
      {:else}
        <!-- a(非 button): 行内元素, 让 +N IP 能与 IP 在同一行自然混排 -->
        <a class="ip" role="button" tabindex="0" title={e.ip}
           onclick={(ev) => { stop(ev); onpick(e.ip) }}
           onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { stop(ev); ev.preventDefault(); onpick(e.ip) } }}>{e.ip}</a>
      {/if}
      {#if showBadge}<span class="ipmore">+{fams[fi].entries.length - 1} IP</span>{/if}
      <!-- 展开详情: IP 后面挂"来源"(经哪个站点/服务看到的; 按类别配色); 悬停显示来源 host。
           多来源再跟一个 +N, 悬停列出全部来源 host。 -->
      {#if expanded && e.sources?.length}
        <span class="ipmore src" style="--sc:{srcColor(e.sources[0].name)}" title={e.sources[0].host}>{srcLabel(e.sources[0].name)}</span>{#if e.sources.length > 1}<span class="ipmore srcmore" title={e.sources.map(s => srcLabel(s.name) + ' — ' + s.host).join('\n')}>+{e.sources.length - 1}</span>{/if}
      {/if}
    </div>
    {#if e.enriching}
      <span class="sub muted">{t('sp_analyzing')}</span>
    {:else if !e.info || e.info.prefix == null}
      {#if e.info && e.info.origin_asn != null}
        <div class="kv">{@render asn(e.info)}</div>
      {:else}
        <span class="sub muted">{t('sp_nocover')}</span>
      {/if}
    {:else}
      {#if e.info.origin_asn != null}
        <div class="kv">{@render asn(e.info)}</div>
      {/if}
      {#if e.holder}
        <div class="kv"><span class="k">{t('sp_holder')}</span><span class="holder">{e.holder}</span></div>
      {/if}
      {#if e.info.loc}
        <div class="loc"><Fa icon={iLoc} /><span>{e.info.loc}</span></div>
      {/if}
    {/if}
  </div>
{/snippet}

<section class="sp" class:expanded bind:this={secEl}>
  <div class="stage" bind:clientWidth={stageW} style="height:{stageH}px">
    {#each renderList as c (c.key)}
      {@const top = topVisible(c)}
      <div class="card" class:clickable={c.kind === 'ip'} class:flat={!expanded && c.ci !== 0}
           data-t={c.fam} style="--ac:{c.accent}; --cw:{CARDW}px; --ch:{CARDH}px; {styleFor(c)}"
           role={c.kind === 'ip' ? 'button' : undefined}
           onclick={() => { if (c.kind !== 'ip') return; if (expanded) toggleHideAll(); else openProbe() }}>
        {@render body(c.fi, c.e, !expanded && top && fams[c.fi].entries.length > 1)}
        {#if expanded || top}<span class="famtag" class:act={c.fam === activeFam}>{c.label}</span>{/if}
      </div>
    {/each}
  </div>

  {#if expanded}
    <!-- 摊开态总是给收起钮(即便 probe 未完/还没卡): 刚进 /probe 就想退也能退 -->
    <div class="dealrow">
      <button class="dealbtn up" onclick={toggleExpand}
              title={t('sp_collapse')} aria-label={t('sp_collapse')}>
        <Fa icon={iChevD} />
      </button>
    </div>
  {/if}

  <!-- 移动端首页: 卡堆默认不显(.stage 隐藏), 给一个"摊开"按钮进 IP 探测; 桌面隐藏(桌面直接点卡堆)。 -->
  {#if !expanded}
    <div class="dealrow mdeal">
      <button class="dealbtn down" onclick={openProbe} title={t('sp_dealout')} aria-label={t('sp_dealout')}>
        <Fa icon={iProbe} />
      </button>
    </div>
  {/if}
</section>

<style>
  .sp { margin: 30px 0 0; padding: 6px 26px 18px; }

  .stage { position: relative; width: 100%; transition: height .55s cubic-bezier(.2, .8, .25, 1); }

  .card {
    position: absolute; top: 0; left: 50%; width: var(--cw, 300px); height: var(--ch, 150px);
    display: flex; flex-direction: column; overflow: hidden; border-radius: 16px;
    background: linear-gradient(180deg, var(--panel), color-mix(in srgb, var(--panel) 84%, var(--bg)));
    border: 1px solid var(--line); transform-origin: 50% 50%; will-change: transform, opacity;
    box-shadow: 0 16px 34px -22px rgba(0,0,0,.5);
    transition: transform .55s cubic-bezier(.2, .8, .25, 1), opacity .45s ease;
  }
  /* 叠放时只让最底那张(最先到、压在最下面的 ci=0)带阴影投到地面(符合物理: 整叠的影子来自最底);
     其余各张去阴影, 避免层层叠加变重。 */
  .card.flat { box-shadow: none; }
  .card.clickable { cursor: pointer; }   /* 叠态点卡=进 IP 探测; 摊开态点卡空白=切换 IP 隐藏(均手型) */

  /* 右下角 family 色标(IPv4/IPv6, 仅第一张): 非活跃栈=灰; 活跃(浏览器主用)栈=淡橙(低对比度) */
  .famtag {
    position: absolute; right: 0; bottom: 0; z-index: 6; pointer-events: none;
    padding: 5px 10px; border-radius: 9px 0 0 0;
    font: 800 9px var(--sans); letter-spacing: .14em; text-transform: uppercase; line-height: 1;
    color: var(--muted); background: color-mix(in srgb, var(--muted) 12%, transparent);
  }
  .famtag.act { color: #cf9f63; background: color-mix(in srgb, #cf9f63 15%, transparent); }

  .cbody { flex: 1; min-height: 0; padding: 12px 17px 16px; display: flex; flex-direction: column; gap: 9px; }

  .fold {
    position: absolute; top: 0; right: 0; z-index: 7;
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; padding: 0; cursor: pointer; border: 0;
    border-radius: 0 0 0 9px; background: transparent; color: var(--muted);
    transition: box-shadow .32s cubic-bezier(.34, 1.56, .64, 1), color .15s, background .2s;
  }
  .fold:hover { color: var(--fg); }
  .fold :global(svg) { width: 12px; height: 12px; }
  .fold.folded { background: color-mix(in srgb, var(--ac) 9%, transparent); box-shadow: inset 2px -2px 4px -1px rgba(0,0,0,.2); }

  /* IP 行: 行内流式(非 flex) —— IP 折行时 [+N IP] 角标紧跟最后一行之后, 而非独立成块靠右。
     line-height 给徽标留竖向空间; vertical-align:middle 让徽标与 IP 文字竖向居中(等价 align-items:center)。 */
  .iprow { padding-right: 20px; line-height: 1.65; }
  .sp.expanded .iprow { padding-right: 0; }   /* 摊开态无右上角隐藏钮, 不需右内距 */
  .ip { font: 600 15px var(--mono); color: var(--fg); letter-spacing: -.01em; cursor: pointer; word-break: break-all; text-decoration: none; vertical-align: middle; }
  a.ip:hover { color: var(--ac); text-decoration: none; }
  .ip.masked { user-select: none; color: var(--muted); opacity: .7; letter-spacing: .03em; }   /* 无自定 cursor: 跟随卡片手型(点它也切换显隐) */
  .sub { font-size: 12.5px; }
  .muted { color: var(--muted); font-family: var(--sans); }

  .ipmore {
    display: inline-block; vertical-align: middle; margin-left: 3px;
    font: 700 10px var(--sans); letter-spacing: .03em; line-height: 1;
    color: var(--ac); background: color-mix(in srgb, var(--ac) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--ac) 34%, transparent); border-radius: 999px; padding: 3px 7px; white-space: nowrap;
  }
  /* 来源名徽标: 按站点类别配色(--sc, 见 srcColor); 悬停显示来源 host。 */
  .ipmore.src {
    color: var(--sc); font-weight: 700; cursor: help;
    background: color-mix(in srgb, var(--sc) 15%, transparent);
    border-color: color-mix(in srgb, var(--sc) 36%, transparent);
  }
  /* +N 来源徽标: 中性灰(它是计数, 非具体来源); 悬停列出全部来源 host。 */
  .ipmore.srcmore {
    color: var(--muted); cursor: help;
    background: color-mix(in srgb, var(--muted) 12%, transparent);
    border-color: color-mix(in srgb, var(--muted) 28%, transparent);
  }

  .kv { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .k { font: 700 9px var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
  .lk { background: none; border: 0; padding: 0; cursor: pointer; color: var(--link); font: 500 13.5px var(--sans); text-align: left; }
  .lk.mono { font-family: var(--mono); font-size: 13.5px; word-break: break-all; }
  .holder { font: 500 12.5px var(--sans); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
  .lk:hover { text-decoration: underline; text-underline-offset: 3px; }

  /* origin: ASxxxx + 名称 badge */
  .asn { text-decoration: none!important; display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .asnum { font: 600 13.5px var(--mono); color: var(--link); }
  .asname {
    font: 600 10.5px var(--sans); color: var(--muted); line-height: 1;
    background: var(--alt); border: 1px solid var(--line); border-radius: 6px; padding: 3px 7px;
    max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .asn:hover .asnum { text-decoration: underline; text-underline-offset: 3px; }

  .loc { display: inline-flex; align-items: center; gap: 6px; margin-top: auto; padding-right: 56px; font: 500 12px var(--sans); color: var(--muted); }
  .loc :global(svg) { width: 11px; opacity: .85; }
  .loc span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .dealrow { display: flex; justify-content: center; margin-top: 14px; }
  .dealbtn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 46px; height: 28px; padding: 0; border-radius: 999px; cursor: pointer;
    background: var(--inbg); border: 1px solid var(--line); color: var(--muted);
    box-shadow: 0 10px 24px -18px rgba(0,0,0,.6);
    transition: color .15s, border-color .15s, background .15s, transform .15s;
  }
  .dealbtn:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); transform: translateY(1px); }
  .dealbtn.up:hover { transform: translateY(-1px); }
  .dealbtn :global(svg) { width: 14px; transition: transform .45s cubic-bezier(.16,1,.3,1); }
  .dealbtn.up :global(svg) { transform: rotate(180deg); }
  /* 移动端首页「摊开」按钮(仅图标, 用 IP 探测同款图标): 桌面隐藏, 仅窄屏显示。 */
  .mdeal { visibility: hidden; display: flex; }
  .dealbtn.down { width: 54px; height: 34px; }
  .dealbtn.down :global(svg) { width: 15px; }

  @media (max-width: 820px) {
    /* 移动端「IP 探测」: 卡片近整宽、更扁、内距更紧凑(去掉桌面的大留白)。 */
    .sp { margin-top: 14px; padding: 2px 2px 8px; }
    .card { border-radius: 13px; box-shadow: 0 10px 22px -16px rgba(0,0,0,.5); }
    .cbody { padding: 9px 13px 10px; gap: 5px; }
    .iprow { line-height: 1.4; padding-right: 8px; }
    .ip { font-size: 15px; }
    .loc { padding-right: 8px; }
    .dealrow { margin-top: 10px; }
    .mdeal { visibility: visible; }                       /* 移动端显示「摊开」按钮 */
    .sp:not(.expanded) .stage { display: none; }    /* 移动端首页: 卡堆不默认显示, 只留按钮 */
  }
</style>
