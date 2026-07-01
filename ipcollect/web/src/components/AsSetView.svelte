<script>
  // as-set 嵌套列表视图(左侧主内容区, mode==='asset')。头部 = 集合信息; 下方 = 直接成员的嵌套树。
  // 根的直接成员立即加载展示; 子 as-set 由 AsSetTree 点一层懒查一层(+ 环检测/深度上限)。
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { t } from '../lib/i18n.js'
  import { runAsSet, loadAsSetMembers } from '../lib/queries.js'
  import { iSpinner, iUsers } from '../lib/icons.js'
  import AsSetTree from './AsSetTree.svelte'

  let A = $derived(S.asset)
  let members = $state(null)    // null=加载中; 数组=根直接成员
  let curKey = $state(null)

  // 切换 as-set 时重新加载根成员。
  $effect(() => {
    const k = A?.key
    if (k && k !== curKey) {
      curKey = k; members = null
      loadAsSetMembers(k).then(m => { if (S.asset?.key === k) members = m }).catch(() => { members = [] })
    } else if (!k) { curKey = null; members = null }
  })

  let altSources = $derived((A?.candidates || []).filter(c => c.set_key !== A?.key))
</script>

<div class="awrap">
  {#if A?.loading}
    <div class="aload"><Fa icon={iSpinner} spin /> {t('querying')}</div>
  {:else if A?.error}
    <div class="aload err">{A.error}</div>
  {:else if A?.unavailable}
    <div class="empty">{t('asset_unavailable')}</div>
  {:else if A?.notfound}
    <div class="empty">{t('asset_notfound').replace('{k}', A.input)}</div>
  {:else if A?.key}
    <div class="ahdr">
      <h2><Fa icon={iUsers} /> {A.name} <span class="src">{A.source}</span></h2>
      {#if A.descr}<div class="descr">{A.descr}</div>{/if}
      <div class="ameta">
        <b>{A.n_members}</b> {t('asset_direct_members')}
        {#if altSources.length}
          · {t('asset_also_in')}: {#each altSources as c}<button class="altb" onclick={() => runAsSet(c.set_key)}>{c.source} ({c.n_members})</button>{/each}
        {/if}
      </div>
    </div>

    {#if members === null}
      <div class="aload"><Fa icon={iSpinner} spin /> {t('querying')}</div>
    {:else if members.length}
      <div class="tree">
        {#each members as m (m.ord)}<AsSetTree node={m} ancestors={new Set([A.key])} depth={0} />{/each}
      </div>
    {:else}
      <div class="empty">{t('asset_no_members')}</div>
    {/if}
  {/if}
</div>

<style>
  .awrap { padding: 14px 16px 40px; }
  .aload { color: var(--muted); padding: 24px 6px; font-size: 13px; }
  .aload.err { color: var(--bad, #dc2626); }
  .empty { color: var(--muted); padding: 28px 6px; font-size: 13px; }
  .ahdr { margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--line2); }
  h2 { font: 600 16px var(--mono); margin: 0 0 5px; color: var(--fg); display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  h2 .src { font: 600 10px var(--sans); color: var(--muted); background: var(--alt); border: 1px solid var(--line); border-radius: 5px; padding: 1px 7px; letter-spacing: .04em; }
  .descr { color: var(--muted); font-size: 12.5px; margin-bottom: 6px; }
  .ameta { font-size: 12px; color: var(--muted); }
  .ameta b { color: var(--fg); font-family: var(--mono); }
  .altb { background: transparent; border: 1px solid var(--line); border-radius: 5px; color: var(--link); cursor: pointer; font: 11px var(--sans); padding: 1px 7px; margin-left: 5px; }
  .altb:hover { border-color: var(--accent); color: var(--accent); }
  .tree { margin-top: 4px; }
</style>
