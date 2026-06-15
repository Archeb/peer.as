<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { cycleTheme, toggleLang } from '../lib/ui.js'
  import { setView, goHome, openProbe, openTrace } from '../lib/queries.js'
  import { genAgo, genUtc } from '../lib/clock.svelte.js'
  import { iPrefix, iPath, iGlobal, iClock, iTheme, iLang, iAbout, iRepo, iIssue, iChangelog, iNodes, iWhois, iProbe, iClose, iSatellite } from '../lib/icons.js'
  import { brand, features } from '../lib/site.js'
  import logoBa from '../assets/peeras-ba.png'

  let counts = $derived(S.meta?.counts || {})
  let nCountry = $derived((S.meta?.countries || []).length)
  let fmt = n => (n ?? '—') === '—' ? '—' : Number(n).toLocaleString()
  let themeLabel = $derived({ auto: 'AUTO', light: 'LIGHT', dark: 'DARK', ba: 'BA' }[S.theme] || 'AUTO')
</script>

{#if S.side}<div class="scrim" onclick={() => (S.side = false)} role="presentation"></div>{/if}
<aside class="side" class:open={S.side}>
  <div class="brand">
    <button class="logo" class:img={S.theme === 'ba'} onclick={() => { S.side = false; goHome() }} title={t('home')} aria-label={t('home')}>
      {#if S.theme === 'ba'}
        <img class="logo-img" src={logoBa} alt="{brand.main}{brand.hi}" />
      {:else}
        <span class="dot"></span>{brand.main}<span class="hi">{brand.hi}</span>
      {/if}
    </button>
    <button class="sideclose" onclick={() => (S.side = false)} title={t('menu')} aria-label={t('menu')}>
      <Fa icon={iClose} />
    </button>
  </div>

  {#if features.whoisView}
    <nav class="vnav" aria-label={t('nav_views')}>
      <button class="vitem" class:on={S.view === 'whois' && !S.probeExpanded} aria-current={S.view === 'whois' && !S.probeExpanded}
        onclick={() => { S.side = false; setView('whois') }}>
        <Fa icon={iWhois} /> <span>{t('nav_whois')}</span>
      </button>
      <button class="vitem" class:on={S.view === 'whois' && S.probeExpanded} aria-current={S.view === 'whois' && S.probeExpanded}
        onclick={() => { S.side = false; openProbe() }}>
        <Fa icon={iProbe} /> <span>{t('nav_probe')}</span>
      </button>
      {#if features.routeTrace}
        <button class="vitem" class:on={S.view === 'trace'} aria-current={S.view === 'trace'}
          onclick={() => { S.side = false; openTrace() }}>
          <Fa icon={iSatellite} /> <span>{t('nav_trace')}</span>
        </button>
      {/if}
      <button class="vitem" class:on={S.view === 'routing'} aria-current={S.view === 'routing'}
        onclick={() => { S.side = false; setView('routing') }}>
        <Fa icon={iNodes} /> <span>{t('nav_routing')}</span>
      </button>
    </nav>
  {/if}

  <section class="sec">
    <h3>{t('overview')}</h3>
    <dl class="stats">
      <div><dt><Fa icon={iPrefix} /> {t('t_prefix4')}</dt><dd>{fmt(counts.prefixes)}</dd></div>
      <div><dt><Fa icon={iPrefix} /> {t('t_prefix6')}</dt><dd>{fmt(counts.prefixes_v6)}</dd></div>
      <div><dt><Fa icon={iPath} /> {t('t_paths')}</dt><dd>{fmt((counts.paths || 0) + (counts.paths_v6 || 0))}</dd></div>
      <div><dt><Fa icon={iGlobal} /> {t('t_country')}</dt><dd>{nCountry || '—'}</dd></div>
      <div><dt><Fa icon={iClock} /> {t('t_gen')}</dt><dd class="gen" title={genUtc(S.meta?.generated_ts)}>{genAgo(S.meta?.generated_ts)}</dd></div>
    </dl>
  </section>

  <div class="foot">
    <nav class="links">
      <a class="lnk" href="https://github.com/Archeb/peer.as" target="_blank" rel="noopener noreferrer">
        <Fa icon={iRepo} /> {t('src_home')}
      </a>
      <a class="lnk" href="https://github.com/Archeb/peer.as/issues" target="_blank" rel="noopener noreferrer">
        <Fa icon={iIssue} /> {t('feedback')}
      </a>
      <button class="lnk lnkbtn" onclick={() => (S.changelog = true)}>
        <Fa icon={iChangelog} /> {t('changelog')}
      </button>
      <button class="lnk lnkbtn" onclick={() => (S.about = true)}>
        <Fa icon={iAbout} /> {t('about')}
      </button>
    </nav>
    <div class="ctl">
      <button class="ghost" onclick={toggleLang} title="中 / English">
        <Fa icon={iLang} /> {S.lang === 'zh' ? 'EN' : '中'}
      </button>
      <button class="ghost" onclick={cycleTheme} title={t('theme')}>
        <Fa icon={iTheme} /> {themeLabel}
      </button>
    </div>
  </div>
</aside>

<style>
  /* 左侧抽屉: 固定离屏(默认收起), .open 滑入。遮罩 .scrim 点击外部收起。配色全用主题 token, 跟随明/暗。 */
  .scrim { position: fixed; inset: 0; z-index: 29; background: rgba(2, 6, 14, .5); animation: fade .16s ease; }
  @keyframes fade { from { opacity: 0; } }
  .side {
    position: fixed; top: 0; left: 0; z-index: 30;
    width: 232px; height: 100vh; color: var(--muted);
    background:
      radial-gradient(color-mix(in srgb, var(--fg) 3%, transparent) 1px, transparent 1px) 0 0 / 15px 15px,
      linear-gradient(180deg, var(--panel), var(--bg));
    display: flex; flex-direction: column; gap: 20px; padding: 16px 16px 14px;
    overflow: auto; border-right: 1px solid var(--line);
    transform: translateX(-100%); transition: transform .22s ease, box-shadow .22s ease;
  }
  .side.open { transform: translateX(0); box-shadow: 0 0 50px -8px rgba(0, 0, 0, .45); }

  .brand { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .sideclose {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; border-radius: 8px; cursor: pointer;
    background: transparent; border: 1px solid var(--line); color: var(--muted); transition: all .14s;
  }
  .sideclose:hover { color: var(--fg); border-color: var(--accent); background: var(--alt); }
  .sideclose :global(svg) { width: 12px; }
  .brand .logo {
    font: 800 18px/1 var(--mono); letter-spacing: -.01em; color: var(--fg);
    display: flex; align-items: center;
    background: none; border: 0; padding: 0; cursor: pointer; transition: opacity .14s;
  }
  .brand .logo:hover { opacity: .82; }
  .brand .logo.img { padding: 0; }
  .brand .logo .logo-img { display: block; height: 32px; width: auto; max-width: 168px; object-fit: contain; }
  .brand .logo .hi { color: var(--accent); }
  .brand .logo .dot {
    width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
    margin-right: 9px; box-shadow: 0 0 10px var(--accent); animation: pulse 2.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  .brand .tag { font-size: 10.5px; color: var(--muted); margin-top: 7px; line-height: 1.4; }

  /* 顶层视图导航(路由分析 / WHOIS)。左侧 accent 竖条标记当前视图。 */
  .vnav { display: flex; flex-direction: column; gap: 3px; margin-top: -6px; }
  .vitem {
    display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
    background: transparent; border: 1px solid transparent; border-radius: 8px;
    padding: 8px 10px; cursor: pointer; position: relative;
    font: 600 12.5px var(--sans); color: var(--fg); transition: all .14s;
  }
  .vitem :global(svg) { width: 13px; color: var(--muted); transition: color .14s; }
  .vitem:hover { background: var(--alt); color: var(--fg); }
  .vitem:hover :global(svg) { color: var(--fg); }
  .vitem.on {
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 16%, transparent), transparent);
    border-color: color-mix(in srgb, var(--accent) 35%, transparent); color: var(--fg);
  }
  .vitem.on::before {
    content: ''; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px;
    border-radius: 0 3px 3px 0; background: var(--accent); box-shadow: 0 0 10px var(--accent);
  }
  .vitem.on :global(svg) { color: var(--accent); }
  /* 浅色模式: 强 accent 实色辉光在白底上显得过浓, 收一档(暗色不变) */
  @media (prefers-color-scheme: light) {
    :global(:root:not([data-theme])) .vitem.on::before { box-shadow: 0 0 4px color-mix(in srgb, var(--accent) 38%, transparent); }
  }
  :global(:root[data-theme='light']) .vitem.on::before { box-shadow: 0 0 4px color-mix(in srgb, var(--accent) 38%, transparent); }

  .sec h3 {
    margin: 0 0 9px; font: 700 10px/1 var(--sans); letter-spacing: .14em;
    text-transform: uppercase; color: var(--muted);
  }
  .stats { margin: 0; }
  .stats > div {
    display: flex; justify-content: space-between; align-items: baseline;
    padding: 5px 0; border-bottom: 1px solid var(--line2); font-size: 12px;
  }
  .stats dt { color: var(--muted); display: inline-flex; align-items: center; gap: 7px; }
  .stats dt :global(svg) { color: var(--muted); width: 11px; }
  .stats dd { margin: 0; color: var(--fg); font: 600 12.5px/1 var(--mono); }
  .stats dd.gen { color: var(--muted); }

  .foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; padding-top: 14px; }
  .links { display: flex; flex-direction: column; gap: 3px; border-top: 1px solid var(--line2); padding-top: 10px; }
  .lnk {
    display: inline-flex; align-items: center; gap: 8px; text-decoration: none;
    color: var(--muted); font: 600 11px var(--sans); padding: 4px 2px; transition: color .15s;
  }
  .lnk :global(svg) { color: var(--muted); width: 12px; transition: color .15s; }
  .lnk:hover, .lnk:hover :global(svg) { color: var(--accent); }
  .lnkbtn { background: transparent; border: 0; cursor: pointer; text-align: left; font-family: var(--sans); }
  .ctl { display: flex; gap: 6px; }
  .ctl .ghost {
    flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    background: transparent; border: 1px solid var(--line); color: var(--fg);
    border-radius: 7px; padding: 7px 8px; font: 600 11px var(--sans); cursor: pointer;
    transition: all .15s;
  }
  .ctl .ghost:hover { background: var(--alt); color: var(--fg); border-color: var(--accent); }

  /* 移动端: 桌面侧栏抽屉隐藏, 改用 MobileBar(顶栏 logo + 下拉菜单) */
  @media (max-width: 820px) {
    .side, .scrim { display: none; }
  }
</style>
