<script>
  // 移动端菜单: 右上角悬浮按钮 + 下拉(桌面侧栏的视图导航/统计/链接/语言/主题/关于/更新日志)。
  // 不再占用整条顶栏(省空间); 仅在窄屏显示(CSS @media), 桌面用侧栏。
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { cycleTheme, toggleLang } from '../lib/ui.js'
  import { setView, openProbe, openTrace } from '../lib/queries.js'
  import { genAgo, genUtc } from '../lib/clock.svelte.js'
  import { iMenu, iClose, iPrefix, iPath, iGlobal, iClock, iTheme, iLang, iAbout, iRepo, iIssue, iChangelog, iNodes, iWhois, iProbe, iSatellite, iNet } from '../lib/icons.js'
  import { features } from '../lib/site.js'

  let counts = $derived(S.meta?.counts || {})
  let nCountry = $derived((S.meta?.countries || []).length)
  let fmt = n => (n ?? '—') === '—' ? '—' : Number(n).toLocaleString()
  let themeLabel = $derived({ auto: 'AUTO', light: 'LIGHT', dark: 'DARK', ba: 'BA' }[S.theme] || 'AUTO')
  const close = () => (S.menu = false)
  const openModal = k => { S.menu = false; S[k] = true }
</script>

<!-- 移动端不再占用一条顶栏: 仅右上角悬浮一个菜单按钮(logo/状态栏已去除以省空间) -->
<button class="menubtn" onclick={() => (S.menu = !S.menu)} aria-label={t('menu')} aria-expanded={S.menu}>
  <Fa icon={S.menu ? iClose : iMenu} />
</button>

{#if S.menu}
  <div class="scrim" onclick={close} role="presentation"></div>
  <div class="menu" role="menu">
    {#if features.whoisView}
      <nav class="vnav" aria-label={t('nav_views')}>
        <button class="vitem" class:on={S.view === 'whois' && !S.probeExpanded} onclick={() => { close(); setView('whois') }}>
          <Fa icon={iWhois} /> {t('nav_whois')}
        </button>
        <button class="vitem" class:on={S.view === 'whois' && S.probeExpanded} onclick={() => { close(); openProbe() }}>
          <Fa icon={iProbe} /> {t('nav_probe')}
        </button>
        {#if features.routeTrace}
          <button class="vitem" class:on={S.view === 'trace'} onclick={() => { close(); openTrace() }}>
            <Fa icon={iSatellite} /> {t('nav_trace')}
          </button>
        {/if}
        <button class="vitem" class:on={S.view === 'routing'} onclick={() => { close(); setView('routing') }}>
          <Fa icon={iNodes} /> {t('nav_routing')}
        </button>
      </nav>
    {/if}
    <dl class="stats">
      <div><dt><Fa icon={iPrefix} /> {t('t_prefix4')}</dt><dd>{fmt(counts.prefixes)}</dd></div>
      <div><dt><Fa icon={iPrefix} /> {t('t_prefix6')}</dt><dd>{fmt(counts.prefixes_v6)}</dd></div>
      <div><dt><Fa icon={iPath} /> {t('t_paths')}</dt><dd>{fmt((counts.paths || 0) + (counts.paths_v6 || 0))}</dd></div>
      <div><dt><Fa icon={iGlobal} /> {t('t_country')}</dt><dd>{nCountry || '—'}</dd></div>
      <div><dt><Fa icon={iClock} /> {t('t_gen')}</dt><dd class="gen" title={genUtc(S.meta?.generated_ts)}>{genAgo(S.meta?.generated_ts)}</dd></div>
    </dl>
    <nav class="links">
      {#if features.peeringdb}
        <!-- IX 目录(/ixps): 整页导航 SEO 页, 与桌面 Sidebar 一致。 -->
        <a class="lnk" href={S.lang === 'en' ? '/ixps?lang=en' : '/ixps'} onclick={close}>
          <Fa icon={iNet} /> {t('nav_ix_dir')}
        </a>
      {/if}
      {#if features.geo}
        <!-- 国家目录(/networks): 整页导航, 非 SPA 路由。移动端入口, 与桌面 Sidebar 一致。 -->
        <a class="lnk" href={S.lang === 'en' ? '/networks?lang=en' : '/networks'} onclick={close}>
          <Fa icon={iGlobal} /> {t('nav_networks')}
        </a>
      {/if}
      <a class="lnk" href="https://github.com/Archeb/peer.as" target="_blank" rel="noopener noreferrer" onclick={close}>
        <Fa icon={iRepo} /> {t('src_home')}
      </a>
      <a class="lnk" href="https://github.com/Archeb/peer.as/issues" target="_blank" rel="noopener noreferrer" onclick={close}>
        <Fa icon={iIssue} /> {t('feedback')}
      </a>
      <button class="lnk" onclick={() => openModal('changelog')}><Fa icon={iChangelog} /> {t('changelog')}</button>
      <button class="lnk" onclick={() => openModal('about')}><Fa icon={iAbout} /> {t('about')}</button>
    </nav>
    <div class="ctl">
      <button class="ghost" onclick={toggleLang}><Fa icon={iLang} /> {S.lang === 'zh' ? 'EN' : '中'}</button>
      <button class="ghost" onclick={cycleTheme}><Fa icon={iTheme} /> {themeLabel}</button>
    </div>
  </div>
{/if}

<style>
  /* 默认隐藏(桌面用侧栏); 仅窄屏显示 */
  .menubtn { display: none; }

  @media (max-width: 820px) {
    /* 不再有整条顶栏, 菜单按钮悬浮在右上角(顶部 + 右侧安全区避刘海) */
    .menubtn {
      display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px;
      position: fixed; z-index: 11;
      top: calc(10px + env(safe-area-inset-top, 0px));   /* 与路由分析首行输入框(38px, 顶距 10px)对齐 */
      right: calc(14px + env(safe-area-inset-right, 0px));
      background: var(--panel); border: 1px solid var(--line); border-radius: 8px; color: var(--fg);
      font-size: 16px; cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .menubtn:active { background: var(--alt); }

    .scrim { position: fixed; inset: 0; z-index: 9; background: rgba(2, 6, 14, .5); }
    .menu {
      position: fixed;
      top: calc(56px + env(safe-area-inset-top, 0px));
      right: calc(10px + env(safe-area-inset-right, 0px)); left: calc(10px + env(safe-area-inset-left, 0px)); z-index: 10;
      background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, .5); padding: 14px 16px;
      display: flex; flex-direction: column; gap: 12px; animation: drop .14s ease;
      /* 菜单过高(四宫格 + 统计 + 链接)时内部滚动, 底部留安全区, 不被系统底栏裁掉 */
      max-height: calc(100dvh - 70px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
      overflow: auto;
    }
    @keyframes drop { from { opacity: 0; transform: translateY(-6px); } }

    /* 四个视图功能: 双栏四宫格 */
    .vnav { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .vnav .vitem {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      background: transparent; border: 1px solid var(--line); border-radius: 8px;
      padding: 10px 8px; font: 600 12.5px var(--sans); color: var(--fg); cursor: pointer;
    }
    .vnav .vitem :global(svg) { width: 13px; color: var(--muted); }
    .vnav .vitem.on { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
    .vnav .vitem.on :global(svg) { color: var(--accent); }

    .stats { margin: 0; }
    .stats > div { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 0; border-bottom: 1px solid var(--line2); font-size: 13px; }
    .stats dt { color: var(--muted); display: inline-flex; align-items: center; gap: 7px; }
    .stats dt :global(svg) { color: var(--muted); width: 12px; }
    .stats dd { margin: 0; color: var(--fg); font: 600 13px/1 var(--mono); }
    .stats dd.gen { font-size: 11.5px; }

    .links { display: flex; flex-direction: column; gap: 2px; border-top: 1px solid var(--line2); padding-top: 8px; }
    .lnk {
      display: inline-flex; align-items: center; gap: 10px; text-decoration: none;
      color: var(--fg); font: 600 13px var(--sans); padding: 9px 4px;
      background: transparent; border: 0; cursor: pointer; text-align: left; width: 100%;
    }
    .lnk :global(svg) { color: var(--muted); width: 14px; }
    .lnk:active { color: var(--accent); }
    .ctl { display: flex; gap: 8px; }
    .ctl .ghost {
      flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      background: transparent; border: 1px solid var(--line); color: var(--fg);
      border-radius: 8px; padding: 10px 8px; font: 600 12.5px var(--sans); cursor: pointer;
    }
    .ctl .ghost:active { background: var(--alt); border-color: var(--accent); }
  }
</style>
