<script>
  // WHOIS 独立视图(顶层 view==='whois', features.whoisView 门控)。
  // 一个「注册局卷宗」气质的全宽查询页: 命令行式输入框 -> 解析成 record 卷宗,
  // 数据正文复用现有 Whois.svelte(kind 'autnum'|'ip'|'domain')。解析/路由逻辑在 queries.runWhois。
  // 空状态时整列垂直居中; 一旦有结果(或错误)则顶部对齐(类 class:center)。
  import Fa from 'svelte-fa'
  import { onMount } from 'svelte'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { runWhois, openInRouting, routeTier1s, goHome } from '../lib/queries.js'
  import { features } from '../lib/site.js'
  import { regionName, asnName } from '../lib/bgp.js'
  import { fetchTrace, ccLatLon } from '../lib/geo.js'
  import { iSearch, iArrowR, iClose, iNodes } from '../lib/icons.js'
  import { tapLogo } from '../lib/ui.js'
  import MobileBar from './MobileBar.svelte'
  import Whois from './Whois.svelte'
  import Doodle from './Doodle.svelte'
  import SelfProbe from './SelfProbe.svelte'
  import logoBig from '../assets/peeras-ba-hero.png'

  // ── 首页 3D 地球 doodle(纯装饰)──────────────────────────────────
  // 起点 = 用户连接 IP + 国家(cloudflare trace); 只画"你自己"这条连接的路由, 加载一次。
  // 之后切页面路径都不再改它(不重渲染); 出结果时整块淡出。点节点/卡片 = 快速查询。
  let dgOrigin = $state(null)
  let dgRoute = $state(null)
  let dgRouteLoading = $state(false)
  onMount(async () => {
    const tr = await fetchTrace()
    if (!tr) return
    const c = ccLatLon(tr.cc)
    dgOrigin = { ip: tr.ip, lat: c.lat, lon: c.lon, line1: tr.ip, line2: tr.cc ? regionName(tr.cc) : '' }
    dgRouteLoading = true
    try {
      const res = await routeTier1s(tr.ip)     // 你自己 IP 的路由(引擎就绪后算一次)
      if (res.origin_asn) { const nm = asnName(res.origin_asn) || ''; dgOrigin = { ...dgOrigin, asn: res.origin_asn, line2: 'AS' + res.origin_asn + (nm ? ' ' + nm : '') } }
      dgRoute = res
    } catch (e) { /* ignore */ }
    dgRouteLoading = false
  })
  let dgLoading = $derived(dgRouteLoading)

  // 立体字 PEER.AS: 现在是查询框正上方的字标(不再是全屏背景), 与查询框作为一组纵向居中。
  // 只保留鼠标视差的 3D 倾斜 + 入场淡入(bgShown) + 出结果折叠淡出。
  let wordTransform = $state('')
  let bgShown = $state(false)
  let booting = $state(true)   // 首帧禁用过渡/动画: 直接从 URL 带查询进来时字标/地球直接隐藏, 不放动画
  // 最近一次指针位置(client 坐标): 用于 resize 后保持视差不跳
  let lastPx = 0, lastPy = 0
  // 统一的立体字视差更新: 同时被 window mousemove 与 canvas 转发(onpointer)调用。
  function updateWord(clientX, clientY) {
    lastPx = clientX; lastPy = clientY
    const ox = Math.max(-0.5, Math.min(0.5, clientX / window.innerWidth - 0.5))
    const oy = Math.max(-0.5, Math.min(0.5, clientY / window.innerHeight - 0.5))
    wordTransform = `rotateX(${(-oy * 10).toFixed(2)}deg) rotateY(${(ox * 10).toFixed(2)}deg)`
  }
  onMount(() => {
    // 两帧后再开过渡 + 触发入场(此时若带查询, 仍是 gone 态, 不会有动画)
    requestAnimationFrame(() => requestAnimationFrame(() => { booting = false; bgShown = true }))
    const onMove = (e) => updateWord(e.clientX, e.clientY)
    const onResize = () => updateWord(lastPx, lastPy)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('resize', onResize) }
  })

  // 命令行输入: 本地态, 与 S.whois.input 单向同步(外部经路由/示例改 input 时回灌, 用户键入不被打断)。
  let box = $state(S.whois.input || '')
  $effect(() => { box = S.whois.input || '' })

  let inputEl
  $effect(() => { inputEl?.focus() })

  // 已解析 record 的类型(据 S.whois.kind/key, 区分 v4/v6/CIDR), 用于卷宗色脊 + 类型徽标。
  let rec = $derived.by(() => {
    const { kind, key } = S.whois
    if (kind === 'autnum') return { cls: 'asn', label: t('wv_t_asn') }
    if (kind === 'ip') {
      const v6 = String(key).includes(':'), cidr = String(key).includes('/')
      return { cls: v6 ? 'ip6' : 'ip4', label: cidr ? t('wv_t_cidr') : (v6 ? t('wv_t_ipv6') : t('wv_t_ipv4')) }
    }
    if (kind === 'domain') return { cls: 'domain', label: t('wv_t_domain') }
    return { cls: 'none', label: t('wv_t_none') }
  })
  // 子域名提示: RDAP 站把域名缩到可注册根(key) 查询时, 告知实际查询对象。
  let rootNote = $derived(
    S.whois.kind === 'domain' && features.rdapWhois && S.whois.key &&
    S.whois.key !== (S.whois.input || '').toLowerCase().replace(/\.$/, '')
  )

  // 「查看更多信息」标签: 按对象类型给出路由分析里能提供的更深内容。
  let moreLabel = $derived.by(() => {
    const { kind, key } = S.whois
    if (kind === 'autnum') return t('wv_more_asn')
    if (kind === 'domain') return t('wv_more_domain')
    if (kind === 'ip') return String(key).includes('/') ? t('wv_more_prefix') : t('wv_more_ip')
    return ''
  })

  // 「高级搜索」开 -> 任何查询直接进路由分析; 否则简洁 WHOIS(runWhois 内部仍会把 as-set/名称等非 WHOIS 对象转路由)。
  function run(x) { S.advWhois ? openInRouting(x) : runWhois(x) }
  function submit(e) { e?.preventDefault(); run(box) }
  function pick(x) { box = x; run(x) }
  // 清除: 清空输入并回到 WHOIS 首页(结果收起 + 地球淡入丝滑返回)
  function clearBox() { box = ''; goHome(); inputEl?.focus() }
  function persistAdv() { try { localStorage.setItem('ipc-adv-whois', S.advWhois ? '1' : '0') } catch (e) { /* 隐私模式忽略 */ } }
</script>

<main class="wv">
  <!-- 右侧 3D 地球: 入场从右上远方放大就位 → 占据右侧、露约 1/3 球面缓慢转动 → 出结果放大右移退场。
       露出的弧面可拖动/点击(命中层裁成圆, 圆外穿透), 用 CSS transform 框出"地球左侧视图"的感觉。 -->
  <div class="globe-stage" class:in={bgShown} class:gone={S.whois.kind || S.probeExpanded} class:booting>
    <Doodle origin={dgOrigin} route={dgRoute} loading={dgLoading} onpick={(qq) => pick(qq)} onpointer={updateWord} />
  </div>
  <MobileBar />
  <div class="scroll">
    <div class="col" class:wide={S.probeExpanded} class:lifted={!S.probePinned && !S.probeExpanded && !S.whois.kind}>
      <!-- PEER.AS 字标: 查询框正上方, 与查询框作为一组纵向居中; 出结果时折叠淡出 -->
      <div class="wordmark" class:in={bgShown} class:gone={S.whois.kind || S.probeExpanded} class:booting aria-hidden="true">
        <!-- 彩蛋: 连点大字标 10 次解锁 Blue Archive 主题 -->
        <div class="word" class:img={S.theme === 'ba'} style:transform={wordTransform}
             role="button" tabindex="-1" onclick={tapLogo}
             onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') tapLogo() }}>
          {#if S.theme === 'ba'}<img class="word-img" src={logoBig} alt="PEER.AS" />{:else}<span class="p">PEER.</span><span class="a">AS</span>{/if}
        </div>
      </div>

      <form class="console" onsubmit={submit}>
        <span class="prompt" aria-hidden="true">▸</span>
        <!-- textarea(非 input): 彻底避免 1Password 等把它当密码框。rows=1 + 拦 Enter, 行为同单行 input -->
        <textarea
          bind:this={inputEl}
          class="cmd"
          rows="1"
          name="q"
          bind:value={box}
          placeholder={t('wv_ph')}
          spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"
          aria-label="WHOIS" data-1p-ignore data-lpignore="true"
          onkeydown={(e) => { if (e.key === 'Enter') submit(e) }}
          oninput={() => { if (box.includes('\n')) box = box.replace(/\n/g, '') }}
        ></textarea>
        {#if box}
          <button type="button" class="clear" onclick={clearBox} aria-label="清除" title="清除"><Fa icon={iClose} /></button>
        {/if}
        {#if features.rdapWhois}
          <!-- 「专业版」开关: 嵌在输入框内、查询按钮左侧。一个图标表激活/非激活, 不再有滑动开关 -->
          <button type="button" class="adv" class:on={S.advWhois}
                  onclick={() => { S.advWhois = !S.advWhois; persistAdv() }}
                  aria-pressed={S.advWhois} aria-label={t('wv_adv')} title={t('wv_adv') + ' · ' + t('wv_adv_hint')}>
            <Fa icon={iNodes} />
          </button>
        {/if}
        <button type="submit" class="run"><Fa icon={iSearch} /> <span>{t('wv_go')}</span></button>
      </form>

      <!-- 「你的接入」自助探测卡片: 仅首页(出结果时随 hero 一并收起)。
           取消图钉(probePinned=false)时首页默认收起, 字标+查询框仍由 .scroll 居中; 经侧栏「IP 探测」摊开(probeExpanded)时照常显示。 -->
      <div class="spwrap" class:gone={S.whois.kind || (!S.probePinned && !S.probeExpanded)} class:expanded={S.probeExpanded} class:booting>
        <SelfProbe onpick={(qq) => pick(qq)} />
      </div>

      <!-- 国家目录(/networks)入口不放第一屏 hero; 改由左侧 Sidebar footer 承载(见 Sidebar.svelte)。 -->

      {#if S.whois.kind}
        <section class="dossier" data-t={rec.cls}>
          <div class="spine"><span class="spine-lbl">{rec.label}</span></div>
          <div class="doc">
            <div class="dochead">
              <span class="reckey">{S.whois.input}</span>
              <span class="tbadge" data-t={rec.cls}>{rec.label}</span>
            </div>
            {#if rootNote}
              <div class="subnote">{t('wv_root_note')} <b>{S.whois.key}</b></div>
            {/if}
            <Whois kind={S.whois.kind} rkey={S.whois.key} />
            {#if moreLabel}
              <button class="more" onclick={() => openInRouting(S.whois.input)}>
                <span>{moreLabel}</span> <Fa icon={iArrowR} />
              </button>
            {/if}
          </div>
        </section>
      {/if}
    </div>
  </div>
</main>

<style>
  /* 视图配色: 暗色为运营商终端, 亮色为干净变体(沿用全局 token)。背景= 点阵网格 + 顶部 accent 辉光。 */
  .wv {
    flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh;
    position: relative; overflow: hidden;            /* 地球/字标定位上下文 + 裁到 view 内 */
    container-type: inline-size;                      /* 供 @container 判断内容区宽度(地球太窄退场) */
    background:
      radial-gradient(1100px 460px at 50% -180px, var(--accent-dim), transparent 70%),
      radial-gradient(rgba(125,200,190,.05) 1px, transparent 1px) 0 0 / 22px 22px,
      var(--bg);
  }
  /* 用 padding-top 近似居中(可过渡), 不用 justify-content(切换不可动画 → 搜索框瞬移) */
  /* 始终 flex 纵向 + 垂直居中(safe): 所有状态(首页/「IP 探测」摊开/查询结果)用同一套布局,
     状态互切时不换 display、不换 justify → 收起/摊开/查询全靠子项(字标/卡堆/卡片)的高度与 transform
     连续过渡, flex 每帧重新居中, 不会瞬移跳顶。safe = 内容超高时自动退回顶对齐, 不裁顶部、仍可滚动。 */
  .scroll {
    position: relative; z-index: 1; flex: 1; overflow: auto; padding: 28px 22px 0px;
    display: flex; flex-direction: column; align-items: center; justify-content: safe center;
  }
  .col { max-width: 820px; margin: 0 auto; width: 100%; transition: margin .4s ease; }
  /* 取消图钉(探测卡片收起)时底部留 15vh: flex safe-center 把这段空白计入 → 整组(字标+查询框)相对视口上移,
     不至于太靠下。图钉钉住(卡片显示)时不留, 否则整体偏高。 */
  .col.lifted { margin-bottom: 15vh; }
  /* 「你的接入」摊牌时, 列放开到整个 scroll 横向空间(让发牌网格能横铺), 但搜索框/示例仍居中收窄 */
  .col.wide { max-width: none; }
  /* 「你的接入」摊牌时列放宽, 但搜索框仍居中收窄在 820(地球已移到列外的侧景层, 不受列宽影响) */
  .col.wide .console { max-width: 820px; margin-left: auto; margin-right: auto; }

  /* ── PEER.AS 字标(查询框正上方) ── 3D 叠层立体字 + 鼠标视差; 入场淡入 / 出结果折叠淡出 ──
     宽度 ≈ 查询框(820)的 70%; 与查询框作为一组, 由 .scroll 的 flex safe-center 纵向居中。 */
  .wordmark {
    display: flex; justify-content: center; perspective: 900px;
    margin: 0 auto 24px; max-height: 220px; overflow: visible;
    opacity: 0; transition: opacity .8s ease, max-height .5s ease, margin .5s ease;
    /* 浅色默认; 暗色在下方覆盖。对比度压低一档(前景往背景靠 + 立体阴影变浅) */
    --w1: #aeb9c4; --w1e: #9aa7b3; --w2: #dab98c; --w2e: #c7a87e;
  }
  .wordmark.in { opacity: 1; }                /* 入场淡入 */
  .wordmark.gone {                            /* 出结果: 折叠 + 淡出, 把查询框让到顶部 */
    opacity: 0; max-height: 0; margin: 0; overflow: hidden;
    transition: opacity .4s ease, max-height .5s ease, margin .5s ease;
  }
  .wordmark.booting { transition: none; }     /* 首帧不放动画(URL 直达带查询时直接隐藏) */
  .wordmark .word {
    font: 800 clamp(54px, 12.5vw, 150px)/1 var(--sans);   /* 约为查询框宽度的 70% */
    letter-spacing: -.045em; white-space: nowrap;
    transform-style: preserve-3d; user-select: none; will-change: transform;
    transition: transform .3s ease;                  /* 视差平滑 */
    cursor: pointer;                                 /* 彩蛋: 连点 10 次解锁 BA 主题 */
  }
  .wordmark span {
    text-shadow:
      1px 1px 0 var(--ext), 2px 2px 0 var(--ext), 3px 3px 0 var(--ext), 4px 4px 0 var(--ext),
      6px 9px 18px rgba(0,0,0,.20);
  }
  .wordmark .p { color: var(--w1); --ext: var(--w1e); }
  .wordmark .a { color: var(--w2); --ext: var(--w2e); }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme])) .wordmark { --w1: #566f88; --w1e: #232e38; --w2: #b08f5b; --w2e: #3f3220; }
  }
  :global(:root[data-theme='dark']) .wordmark { --w1: #566f88; --w1e: #232e38; --w2: #b08f5b; --w2e: #3f3220; }
  /* BA 主题: 大字标换成蓝+粉 logo 图(仍随 .word 做视差/折叠) */
  .wordmark .word.img { letter-spacing: 0; }
  .wordmark .word-img {
    display: block; height: clamp(88px, 19vw, 176px); width: auto; max-width: 86vw;
    filter: drop-shadow(4px 6px 10px rgba(0, 0, 0, .18));
  }

  /* ── 右侧 3D 地球侧景 stage ──
     一个大方块绝对定位在 view 右侧, 用 translateX 把"球心"推出右边缘, 只露出左侧约 1/3 球面
     —— 像隔着窗拍地球的左侧。canvas 在自己方块里居中(globe.js), 偏移全交给这层 transform。
     纯装饰: pointer-events:none + z-index 0(在内容之下), 不抢中间查询框的点击。
     canvas 分辨率取自未变换尺寸(globe.js 用 offsetWidth), 故入场缩放既不糊也不会被 RO 重置。 */
  .globe-stage {
    --gs-size: min(118vh, 1100px);
    position: absolute; top: 50%; right: 0; z-index: 2;  /* 在内容之上, 才接得到拖动/点击 */
    width: var(--gs-size); height: var(--gs-size);
    transform: translate(56%, -50%) scale(1);            /* 就位: 球心推到右缘外, 露左侧 ~1/3 */
    transform-origin: center center; opacity: 1;
    transition: transform 1.15s cubic-bezier(.22, .61, .36, 1), opacity 1.05s ease;
    will-change: transform, opacity;
    pointer-events: none;                                /* 本层(含画布)不接事件 → 让命中层(裁成圆)接 */
  }
  .globe-stage :global(.doodle) { width: 100%; height: 100%; }
  /* 只把"命中层"裁成圆(球心在右缘外, 只罩住露出的弧面): 弧面可拖动/点击, 圆外(中间查询框那侧)
     指针穿透回内容、不挡查询框。画布在下层不裁 → 节点卡片/标注溢出圆外也照样完整显示。 */
  .globe-stage :global(.dg-hit) { pointer-events: auto; clip-path: circle(32% at 50% 50%); }
  /* 入场前(未加 .in): 远在右上角且极小且透明 → 加 .in 过渡到就位 = 从远方放大飞入 */
  .globe-stage:not(.in) { transform: translate(150%, -125%) scale(.2); opacity: 0; }
  /* 出结果 / 「你的接入」摊牌: 放大 + 继续右移 + 淡出 = 向右拉近离场 */
  .globe-stage.gone {
    transform: translate(118%, -50%) scale(1.45); opacity: 0;
    transition: transform .85s cubic-bezier(.5, 0, .75, 0), opacity .7s ease;
  }
  .globe-stage.booting { transition: none; }            /* 首帧不放动画(URL 直达带查询时直接隐藏) */
  /* 内容区(.wv)太窄 → 地球自动退场(放大右移淡出), 不再压住中间查询框。
     1320 按"查询框 820 + 两侧留白 + 球露出的弧"估算; 嫌早/晚就调这个数。 */
  @container (max-width: 1320px) {
    .globe-stage { transform: translate(120%, -50%) scale(1.2); opacity: 0; pointer-events: none; }
  }
  @media (max-width: 680px) { .globe-stage { display: none; } }   /* 手机: 彻底不渲染侧球 */

  /* 「你的接入」探测卡片包裹层: 出结果时与 hero 同步收起(高度折叠 + 下沉淡出, 不直接消失) */
  .spwrap {
    max-height: 480px; opacity: 1;     /* 折叠用上界: 桌面两栏内容远小于此 */
    transition: max-height .5s ease, opacity .4s ease, transform .5s ease, margin .5s ease;
  }
  .spwrap.gone { max-height: 0; opacity: 0; transform: translateY(16px); margin: 0; pointer-events: none; }
  /* 摊开成网格: 放大高度上界(留足余量, 但不用 none —— none↔480 无法过渡会瞬跳)+ 取消裁切,
     让多行卡片完整展开、发牌飞入不被切顶; 收起时 max-height 2400→480 可平滑过渡(卡片同时缩回叠堆)。 */
  .spwrap.expanded { max-height: 2400px; overflow: visible; }
  .spwrap.booting { transition: none; }

  /* ── 命令行输入 ── */
  .console {
    display: flex; align-items: center; gap: 10px; margin-top: 6px;
    padding: 0 8px 0 16px; height: 58px;
    background: var(--inbg); border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 14px 40px -22px rgba(0,0,0,.55);
    transition: border-color .15s, box-shadow .15s;
  }
  .console:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-dim), 0 14px 40px -22px rgba(0,0,0,.55); }
  .prompt { color: var(--accent); font: 700 16px var(--mono); animation: blink 1.25s step-end infinite; user-select: none; }
  @keyframes blink { 0%,55% { opacity: 1 } 56%,100% { opacity: .25 } }
  /* textarea 当单行用: 固定一行高、不换行、无 resize 拖拽角、无滚动条 */
  .cmd {
    flex: 1; min-width: 0; border: 0; outline: 0; background: transparent;
    font: 500 17px var(--mono); color: var(--fg); letter-spacing: -.005em;
    height: 24px; line-height: 24px; padding: 0; margin: 0;
    resize: none; white-space: nowrap; overflow: hidden;
  }
  .cmd::-webkit-scrollbar { display: none; }
  /* 占位符是中文(输入提示), 用 sans —— mono 下中文难看; 实际输入(ASN/IP/域名)仍走上面的 mono。 */
  .cmd::placeholder { color: var(--muted); opacity: .7; font-family: var(--sans); font-size: 14px; }
  .run {
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; height: 42px; padding: 0 18px;
    background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 10px;
    font: 700 13.5px var(--sans); cursor: pointer; box-shadow: 0 2px 12px var(--accent-dim);
    transition: filter .12s, transform .05s;
  }
  .run:hover { filter: brightness(1.08); }
  .run:active { transform: translateY(1px); }
  .run :global(svg) { width: 13px; }

  /* 清除按钮(输入框有文字时显示, 在查询按钮左侧) */
  .clear {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; padding: 0; border-radius: 9px; cursor: pointer;
    background: transparent; color: var(--muted); border: 1px solid transparent;
    transition: color .12s, background .12s, border-color .12s;
  }
  .clear:hover { color: var(--fg); background: var(--alt); border-color: var(--line); }
  .clear :global(svg) { width: 13px; }

  /* ── 类型徽标(按 data-t 着色) ── 用 sans: 中文(前缀/域名)在 mono 下难看 ── */
  .tbadge {
    flex: 0 0 auto; font: 700 11px var(--sans); letter-spacing: .06em; text-transform: uppercase;
    padding: 4px 9px; border-radius: 7px; white-space: nowrap;
    color: var(--tc, var(--muted));
    background: color-mix(in srgb, var(--tc, var(--muted)) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--tc, var(--muted)) 32%, transparent);
  }
  [data-t='asn']    { --tc: var(--accent); }
  [data-t='ip4']    { --tc: #3b82f6; }
  [data-t='ip6']    { --tc: #8b5cf6; }
  [data-t='cidr']   { --tc: #0ea5e9; }
  [data-t='domain'] { --tc: var(--signal); }
  [data-t='bad']    { --tc: #ef4444; }
  [data-t='none']   { --tc: var(--muted); }

  /* 「专业版」开关: 命令行内、查询按钮左侧的图标按钮。一个图标表激活/非激活 ——
     灰=关, accent(亮+淡底)=开。状态记忆于 localStorage。 */
  .adv {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px; padding: 0; border-radius: 10px; cursor: pointer;
    background: transparent; color: var(--muted); border: 1px solid transparent;
    transition: color .15s, background .15s, border-color .15s;
  }
  .adv:hover { color: var(--fg); background: var(--alt); }
  .adv.on { color: var(--accent); background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 32%, transparent); }
  .adv:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-dim); }
  .adv :global(svg) { width: 15px; }

  /* ── record 卷宗 ── */
  .dossier {
    position: relative; margin-top: 26px; display: flex; align-items: stretch;
    background: var(--panel); border: 1px solid var(--line); border-radius: 16px; overflow: hidden;
    box-shadow: 0 24px 60px -34px rgba(0,0,0,.6);
  }
  /* 蓝图式四角刻线 */
  .dossier::before, .dossier::after {
    content: ''; position: absolute; width: 14px; height: 14px; pointer-events: none;
    border-color: color-mix(in srgb, var(--tc, var(--accent)) 55%, transparent); opacity: .7;
  }
  .dossier::before { top: 9px; right: 9px; border-top: 2px solid; border-right: 2px solid; border-radius: 0 5px 0 0; }
  .dossier::after { bottom: 9px; right: 9px; border-bottom: 2px solid; border-right: 2px solid; border-radius: 0 0 5px 0; }
  /* 左侧色脊: 类型色竖条 + 竖排标签 */
  .spine {
    flex: 0 0 46px; display: flex; align-items: center; justify-content: center;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--tc, var(--accent)) 22%, transparent), color-mix(in srgb, var(--tc, var(--accent)) 8%, transparent));
    border-right: 1px solid color-mix(in srgb, var(--tc, var(--accent)) 30%, transparent);
  }
  /* 竖排标签: 不旋转(rotate(180) 会上下颠倒); 用 sans(中文不走 mono); 竖排上下行距用 .14em */
  .spine-lbl {
    writing-mode: vertical-rl; text-orientation: mixed;
    font: 700 11px var(--sans); letter-spacing: .14em; text-transform: uppercase;
    color: var(--tc, var(--accent));
  }
  .doc { flex: 1; min-width: 0; padding: 20px 22px 22px; }
  .dochead { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .reckey { font: 700 20px var(--mono); letter-spacing: -.01em; color: var(--fg); word-break: break-all; }
  .subnote { margin: 8px 0 2px; font-size: 11.5px; color: var(--muted); line-height: 1.5; }
  .subnote b { color: var(--link); font-family: var(--mono); font-weight: 600; word-break: break-all; }

  /* 「查看更多信息」: 跳到路由分析的完整详情(ASN 邻居/关系、前缀 RPKI/IRR、域名 DNS)。 */
  .more {
    display: inline-flex; align-items: center; gap: 8px; margin-top: 18px;
    background: var(--accent-dim); color: var(--accent);
    border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent); border-radius: 9px;
    padding: 9px 14px; font: 600 12.5px var(--sans); cursor: pointer; transition: all .14s; text-align: left;
  }
  .more:hover { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .more :global(svg) { width: 12px; transition: transform .14s; }
  .more:hover :global(svg) { transform: translateX(3px); }

  @media (max-width: 820px) {
    /* 底部 + 左右安全区: 避开 iOS/安卓底栏与横屏刘海 */
    .scroll { padding: 14px calc(8px + env(safe-area-inset-right, 0px)) calc(36px + env(safe-area-inset-bottom, 0px)) calc(8px + env(safe-area-inset-left, 0px)); }
    /* 居中沿用桌面同一套(.scroll 的 safe center): 卡少时居中, 单列过高自动退回顶对齐。 */
    /* 移动端: spwrap 常显(露出 SelfProbe 里的「摊开」按钮); 卡堆默认隐藏由 SelfProbe 内部(.stage)控制。 */
    .console { flex-wrap: wrap; height: auto; padding: 10px 12px; gap: 8px 10px; }
    .prompt { order: 1; }
    .cmd { order: 2; flex: 1 1 auto; min-width: 0; height: 34px; line-height: 34px; font-size: 16px; }  /* 与 ▸ 同行, 填满本行剩余宽度 */
    .clear { order: 2; }                                                              /* 与 ▸/输入同行, 在其右 */
    .adv { order: 2; }                                                                /* 「专业版」与搜索框同一行 */
    .run { order: 3; flex: 1 1 100%; justify-content: center; height: 40px; }          /* 整行换到下一行 */
    /* 卷宗: 色脊转为顶部横条 */
    .dossier { flex-direction: column; }
    .spine { flex: 0 0 auto; height: 34px; width: 100%; border-right: 0; border-bottom: 1px solid color-mix(in srgb, var(--tc, var(--accent)) 30%, transparent); }
    .spine-lbl { writing-mode: horizontal-tb; transform: none; }
    .reckey { font-size: 17px; }
  }
</style>
