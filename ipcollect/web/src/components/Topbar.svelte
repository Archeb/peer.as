<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { ccLabel, classifyQuery } from '../lib/bgp.js'
  import { resolveCC, searchNow, openWhoisFromBox, gotoPage, canExport } from '../lib/queries.js'
  import { iCountry, iCity, iPath, iSubnet, iSearch, iClear, iHelp, iWhois, iUser, iArrowL, iArrowR, iDownload, iSpinner } from '../lib/icons.js'
  import { features } from '../lib/site.js'
  import Field from './Field.svelte'

  // 结果分页 / 导出栏: 仅 global/country/subnet 表格模式且有行时显示。
  let tableMode = $derived(['global', 'country', 'subnet'].includes(S.mode) && S.rows.length > 0)
  let cc = $derived(resolveCC(S.filters.cc))
  let cities = $derived((cc && S.meta?.cities?.[cc]) || [])
  let f = S.filters
  // dn42(!features.geo): 用 person 筛选取代国家/地区。person 列表来自 meta.persons(值=nic-hdl)。
  let personPh = $derived(S.lang === 'zh' ? '按 person 筛选 (nic-hdl)' : 'filter by person (nic-hdl)')
  // 精确框类型(empty/ipv4/asn/ipv6/text)：IP/CIDR 时 AS_PATH 不可叠加(prefixes 无路径数据), 其余筛选都可组合。
  let probe = $derived(classifyQuery(S.filters.ip))
  let pathNA = $derived(probe.kind === 'ipv4' || probe.kind === 'ipv6')
  let canWhois = $derived(probe.kind === 'asn' || probe.kind === 'domain')   // 移动端 Whois 按钮: 精确框是 ASN 或 域名时可用
  // family 单选: 约束国家/全表搜索只看 v4 或 v6(子网搜索由 IP 本身决定 family, 此时禁用)。
  const FAM = [{ v: 'all', label: () => t('fam_all') }, { v: '4', label: () => 'IPv4' }, { v: '6', label: () => 'IPv6' }]
  let famIdx = $derived(Math.max(0, FAM.findIndex(o => o.v === (f.fam || 'all'))))
  function setFam(v) { f.fam = v; if (!pathNA) searchNow() }
  // 移动端: 用单按钮点击轮换地址族(ALL → IPv4 → IPv6 → …), 省掉三段控件的横向空间
  let famLabel = $derived((f.fam || 'all') === '4' ? 'IPv4' : (f.fam || 'all') === '6' ? 'IPv6' : t('fam_all'))
  function cycleFam() { setFam(FAM[(famIdx + 1) % FAM.length].v) }
  // 不再随输入自动搜索: 仅回车(onenter)或点击「搜索」触发。离散控件(family 段、复选)点击即搜。
  function clearAll() {
    Object.assign(f, { cc: '', city: '', person: '', path: '', origin: '', ip: '', limit: 500, incllow: false, fam: 'all' })
    searchNow()
  }
</script>

<header class="topbar">
  <!-- 顶部进度条: 仅确定性进度(全表 AS_PATH 搜索 + 首次引擎加载, S.prog>0)时显示; 普通查询只在状态行转圈 -->
  {#if S.prog > 0}
    <div class="topprog" aria-hidden="true"><div class="topprog-fill" style="width:{Math.round(S.prog * 100)}%"></div></div>
  {/if}
  <div class="filters">
    <!-- 第一行: family 单选 + 精确查询 IP / CIDR / ASN — 命中即抢占, 其余筛选禁用 -->
    <div class="row primary">
      <div class="famseg" class:disabled={pathNA} role="radiogroup" aria-label={t('fam_label')}>
        <span class="fampill" style="transform: translateX({famIdx * 100}%)"></span>
        {#each FAM as o}
          <button type="button" class="famopt" class:on={(f.fam || 'all') === o.v}
            role="radio" aria-checked={(f.fam || 'all') === o.v} disabled={pathNA}
            title={t('fam_label')} onclick={() => setFam(o.v)}>{o.label()}</button>
        {/each}
      </div>
      <!-- 移动端: 单按钮轮换地址族(替代上面的三段控件, 由 CSS 互斥显隐) -->
      <button type="button" class="fammob" class:act={(f.fam || 'all') !== 'all'} disabled={pathNA}
        title={t('fam_label')} aria-label={t('fam_label')} onclick={cycleFam}>{famLabel}</button>
      <Field icon={iSubnet} bind:value={f.ip} placeholder={t('ph_ip')} big grow width=""
        onenter={searchNow} />
      <!-- ≤410px: 强制换行, 让搜索/WHOIS/清空整体落到第二行(否则窄屏精确框会被挤到自己一行, 破坏布局) -->
      <div class="rowbreak" aria-hidden="true"></div>
      <button class="gobtn big" onclick={searchNow}><Fa icon={iSearch} /> {t('search')}</button>
      <button class="gobtn big whoisbtn" onclick={openWhoisFromBox} disabled={!canWhois} title={t('whois_open')}><Fa icon={iWhois} /> WHOIS</button>
      <button class="clrbtn" onclick={clearAll} title={t('clear')}><Fa icon={iClear} /></button>
    </div>
    <!-- 第二行: 其余筛选(AS_PATH 撑满剩余宽度) -->
    <div class="row secondary">
      {#if features.geo}
        <Field icon={iCountry} bind:value={f.cc} placeholder={t('ph_cc')} list="cclist"
          width="220px" onenter={searchNow} />
        <Field icon={iCity} bind:value={f.city} placeholder={cities.length ? t('ph_city') : '—'}
          list="citylist" disabled={!cities.length} width="155px" onenter={searchNow} />
      {:else}
        <Field icon={iUser} bind:value={f.person} placeholder={personPh} list="personlist"
          width="280px" onenter={searchNow} />
      {/if}
      <Field icon={iPath} bind:value={f.path} placeholder={t('ph_path')}
        grow width="" disabled={pathNA} onenter={searchNow} />
      <button class="helpbtn" onclick={() => (S.pathHelp = true)} title={t('path_help')} aria-label={t('path_help')}>
        <Fa icon={iHelp} />
      </button>
      <input class="numbox" type="text" bind:value={f.limit} title={t('ph_limit')}
        onkeydown={(e) => e.key === 'Enter' && searchNow()} />
      <label class="chk" title={t('lowvis')}>
        <input type="checkbox" bind:checked={f.incllow} onchange={searchNow} />
        <span>{t('incllow')}</span>
      </label>
      {#if pathNA}<span class="locknote">{t('path_na')}</span>{/if}
    </div>
  </div>
  <div class="statusline">
    {#if S.busy}<span class="spin"><Fa icon={iSpinner} spin /></span>{/if}
    <span class="msg">{S.msg}</span>
    {#if tableMode}
      <div class="resbar">
        <div class="pager">
          <button class="pgbtn" disabled={S.page === 0} onclick={() => gotoPage(-1)} title={t('page_prev')} aria-label={t('page_prev')}><Fa icon={iArrowL} /></button>
          <span class="pgn">{t('page_n').replace('{n}', (S.page || 0) + 1)}</span>
          <button class="pgbtn" disabled={!S.more} onclick={() => gotoPage(1)} title={t('page_next')} aria-label={t('page_next')}><Fa icon={iArrowR} /></button>
        </div>
        <button class="expbtn" disabled={!canExport()} onclick={() => (S.exportOpen = true)} title={t('exp_title')}>
          <Fa icon={iDownload} /> <span>{t('export_btn')}</span>
        </button>
      </div>
    {/if}
  </div>

  {#if features.geo}
    <datalist id="cclist">
      {#each S.meta?.countries || [] as c}
        <option value={ccLabel(c.cc)}>{c.n_prefix.toLocaleString()}</option>
      {/each}
    </datalist>
    <datalist id="citylist">
      {#each cities as c}<option value={c.name}>{c.n_prefix.toLocaleString()}</option>{/each}
    </datalist>
  {:else}
    <datalist id="personlist">
      {#each S.meta?.persons || [] as p}<option value={p.id}>{p.name} · {p.n_prefix.toLocaleString()}</option>{/each}
    </datalist>
  {/if}
</header>

<style>
  .topbar {
    position: sticky; top: 0; z-index: 6; padding: 12px 18px 10px;
    background:
      radial-gradient(rgba(125,200,190,.025) 1px, transparent 1px) 0 0 / 18px 18px,
      var(--panel);
    border-bottom: 1px solid var(--line);
  }
  /* 桌面: 只在第一行左侧给左上角悬浮开合按钮(App .sidetoggle, 固定 left:12 + 38 宽)留位, 不挤占整条 topbar */
  @media (min-width: 821px) { .row.primary { padding-left: 46px; } }
  .filters { display: flex; flex-direction: column; gap: 9px; }
  .row { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; }
  .rowbreak { display: none; }   /* 仅 ≤410px 启用(flex-basis:100% 占满整行→强制后续元素换行) */
  .row.primary { padding-bottom: 9px; border-bottom: 1px dashed var(--line); }
  .gobtn.big { height: 40px; padding: 0 22px; font-size: 13.5px; border-radius: 9px; }
  /* family 单选(分段控件): 3 段等宽 + 滑动高亮块, 切换时动画。 */
  .famseg {
    position: relative; flex: 0 0 auto; display: inline-flex; height: 40px;
    background: var(--inbg); border: 1px solid var(--line); border-radius: 9px;
    padding: 3px; gap: 0; user-select: none;
  }
  .famseg .fampill {
    position: absolute; top: 3px; left: 3px; bottom: 3px; width: calc((100% - 6px) / 3);
    background: var(--accent); border-radius: 7px; box-shadow: 0 2px 8px var(--accent-dim);
    transition: transform .2s cubic-bezier(.4, 0, .2, 1); will-change: transform; z-index: 0;
  }
  .famseg .famopt {
    position: relative; z-index: 1; flex: 1 0 auto; min-width: 49px; padding: 0 12px;
    background: transparent; border: 0; border-radius: 7px; cursor: pointer;
    font: 600 12px var(--sans); color: var(--muted); transition: color .2s; white-space: nowrap;
  }
  .famseg .famopt.on { color: var(--accent-fg); }
  .famseg .famopt:not(.on):hover { color: var(--fg); }
  .famseg.disabled { opacity: .45; pointer-events: none; }
  /* 移动端单按钮地址族(默认隐藏, 桌面用上面的三段控件) */
  .fammob {
    display: none; flex: 0 0 auto; align-items: center; justify-content: center;
    height: 40px; min-width: 52px; padding: 0 12px; border-radius: 9px; cursor: pointer;
    background: var(--inbg); border: 1px solid var(--line); color: var(--muted);
    font: 700 12px var(--sans); letter-spacing: .01em; white-space: nowrap; transition: all .14s;
  }
  .fammob:hover { color: var(--fg); border-color: var(--accent); }
  .fammob.act { background: var(--accent-dim); border-color: color-mix(in srgb, var(--accent) 40%, transparent); color: var(--accent); }
  .fammob:disabled { opacity: .45; pointer-events: none; }
  .clrbtn {
    display: inline-flex; align-items: center; justify-content: center; height: 40px; width: 40px;
    flex: 0 0 auto; background: transparent; border: 1px solid var(--line); border-radius: 9px;
    color: var(--muted); cursor: pointer; transition: all .12s;
  }
  .clrbtn:hover { color: #ef4444; border-color: #ef4444; background: color-mix(in srgb, #ef4444 8%, transparent); }
  .numbox {
    width: 64px; height: 32px; background: var(--inbg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 7px; padding: 0 9px;
    font: 12.5px var(--mono); outline: none;
  }
  .numbox:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .helpbtn {
    display: inline-flex; align-items: center; justify-content: center; height: 32px; width: 32px;
    flex: 0 0 auto; background: transparent; border: 1px solid var(--line); border-radius: 7px;
    color: var(--muted); cursor: pointer; transition: all .12s;
  }
  .helpbtn:hover { color: var(--accent); border-color: var(--accent); }
  .chk {
    display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
    color: var(--muted); cursor: pointer; white-space: nowrap; user-select: none;
  }
  .chk input { width: auto; accent-color: var(--accent); }
  .gobtn {
    display: inline-flex; align-items: center; gap: 7px; height: 32px;
    background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 7px;
    padding: 0 16px; font: 600 12.5px var(--sans); cursor: pointer; transition: filter .12s, transform .05s;
    box-shadow: 0 2px 10px var(--accent-dim);
  }
  .gobtn:hover { filter: brightness(1.08); }
  .gobtn:active { transform: translateY(1px); }
  .gobtn:disabled { opacity: .4; cursor: default; filter: none; box-shadow: none; }
  /* WHOIS = 次要按钮(仅移动端显示, 见 @media): 与主搜索按钮的 accent 实色区分 */
  .whoisbtn {
    display: none;
    background: var(--inbg); color: var(--fg); border: 1px solid var(--line); box-shadow: none;
  }
  .whoisbtn:hover:not(:disabled) { filter: none; border-color: var(--accent); color: var(--accent); }
  .statusline { margin-top: 9px; min-height: 16px; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 8px; }
  .statusline .msg { min-width: 0; flex: 1; }
  /* 状态行加载图标: 任意查询 / 引擎加载进行中(S.busy)时转动。 */
  .statusline .spin { flex: 0 0 auto; display: inline-flex; align-items: center; color: var(--accent); font-size: 11px; }
  /* 顶部进度条: 贴 topbar 顶缘的细线, 宽度跟 S.prog; 移动光泽提示"仍在跑"。仅确定性进度时渲染。 */
  .topprog {
    position: absolute; left: 0; right: 0; top: 0; height: 2.5px;
    background: var(--inbg); overflow: hidden; z-index: 7;
  }
  .topprog-fill {
    position: relative; height: 100%;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    box-shadow: 0 0 8px var(--accent-dim);
    transition: width .25s cubic-bezier(.4, 0, .2, 1);
  }
  .topprog-fill::after {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, #fff 55%, transparent), transparent);
    animation: qsheen 1.1s linear infinite;
  }
  @keyframes qsheen { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
  /* 分页 + 导出: 同行最右 */
  .resbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
  .pager { display: inline-flex; align-items: center; gap: 2px; }
  .pgbtn {
    display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
    background: transparent; border: 1px solid var(--line); border-radius: 6px; color: var(--muted);
    cursor: pointer; transition: all .12s; font-size: 11px;
  }
  .pgbtn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .pgbtn:disabled { opacity: .35; cursor: default; }
  .pgn { font: 600 11.5px var(--mono); color: var(--fg); padding: 0 6px; white-space: nowrap; }
  .expbtn {
    display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px;
    background: var(--inbg); border: 1px solid var(--line); border-radius: 6px; color: var(--fg);
    font: 600 11.5px var(--sans); cursor: pointer; transition: all .12s; white-space: nowrap;
  }
  .expbtn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }
  .expbtn:disabled { opacity: .4; cursor: default; }
  .expbtn :global(svg) { width: 11px; }
  .numbox:disabled { opacity: .45; cursor: not-allowed; }
  .chk input:disabled ~ span { opacity: .45; }
  /* Field 组件被禁用时统一变暗(兼容根为 input 或包裹 input 两种结构) */
  .row.secondary :global(.field input:disabled),
  .row.secondary :global(input.field:disabled) { opacity: .45; cursor: not-allowed; }
  .locknote {
    display: inline-flex; align-items: center; white-space: nowrap;
    font-size: 11px; color: var(--accent); letter-spacing: .02em;
  }
  @media (max-width: 820px) {
    .topbar { padding: 10px 12px; }
    /* 三段地址族控件换成单按钮(省空间) */
    .famseg { display: none; }
    .fammob { display: inline-flex; }
    /* 换行后两行更紧凑(行距 6px, 列距仍 9px) */
    .row.primary { gap: 6px 9px; }
    /* 首行控件统一 38px 高, 与右上角悬浮菜单钮(38px)对齐 */
    .row.primary :global(.field) { height: 38px !important; }
    .row.primary .fammob, .row.primary .gobtn.big, .row.primary .clrbtn { height: 38px; }
    /* 次要筛选行: 两列自适应 */
    .row.secondary :global(.field) { flex: 1 1 calc(50% - 9px); width: auto !important; }
    /* 主查询行 第1行: 地址族 + 主搜索框 同行(搜索框右侧留出悬浮菜单钮的位置, 仅本行退避)
       第2行: 搜索(占满剩余空间, 内容居中) + WHOIS(自适应内容) + 清空(固定) */
    .row.primary .famseg { flex: 0 0 auto; }
    .row.primary :global(.field) { flex: 1 1 50%; width: auto !important; margin-right: calc(49px + env(safe-area-inset-right, 0px)); }
    .row.primary .gobtn.big:not(.whoisbtn) { flex: 1 1 auto; justify-content: center; }  /* 搜索撑满剩余 */
    .row.primary .whoisbtn { display: inline-flex; flex: 0 0 auto; }        /* WHOIS 自适应 */
    .row.primary .clrbtn { flex: 0 0 auto; }                               /* 清空固定 */
  }
  @media (max-width: 410px) {
    /* 极窄屏: famseg + 精确框同占第一行(精确框收缩填满 famseg 右侧剩余宽度),
       rowbreak 强制 搜索/WHOIS/清空 整体落到第二行(按钮的 flex 规则沿用 ≤820px 块) */
    .row.primary .famseg { flex: 0 0 auto; }
    .row.primary :global(.field) { flex: 1 1 0; min-width: 0; width: auto !important; }
    .rowbreak { display: block; flex-basis: 100%; height: 0; }
  }
</style>
