<script>
  // 顶栏主搜索框(增强版 Field): 输入外壳 + 清除钮, 建议/历史下拉交给 SearchSuggest(与 WhoisView 共用)。
  import Fa from 'svelte-fa'
  import { t } from '../lib/i18n.js'
  import { iSubnet, iSearch, iClose } from '../lib/icons.js'
  import SearchSuggest from './SearchSuggest.svelte'

  let { value = $bindable(''), onenter = () => {} } = $props()

  let open = $state(false)
  let inputEl = $state()
  let suggest = $state()
</script>

<div class="field big grow sb">
  <span class="fi"><Fa icon={value ? iSearch : iSubnet} /></span>
  <input
    bind:this={inputEl} type="text" bind:value placeholder={t('ph_ip')}
    spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off"
    role="combobox" aria-expanded={open} aria-controls="sb-drop" aria-autocomplete="list"
    onfocus={() => (open = true)} oninput={() => (open = true)}
    onblur={() => setTimeout(() => (open = false), 150)} onkeydown={(e) => suggest?.keydown(e)} />
  {#if value}<button type="button" class="clr" onmousedown={(e) => { e.preventDefault(); value = ''; inputEl?.focus(); open = true }} aria-label={t('clear')}><Fa icon={iClose} /></button>{/if}

  <SearchSuggest bind:this={suggest} bind:value bind:open {onenter} variant="field" />
</div>

<style>
  /* 基础 .field 视觉(Field.svelte 的样式是作用域内的, 这里独立复刻, 复用 class 名以套用 Topbar 的 :global(.field) 响应式规则) */
  .field {
    position: relative;
    display: inline-flex; align-items: center; gap: 7px; min-width: 0;
    background: var(--inbg); border: 1px solid var(--line); border-radius: 7px;
    padding: 0 9px; height: 32px; transition: border-color .15s, box-shadow .15s;
  }
  .field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .field.grow { flex: 1 1 0; }
  .field.big { height: 40px; padding: 0 13px; border-radius: 9px; gap: 9px; }
  .field.big .fi { font-size: 14px; }
  .field.big input { font-size: 14px; }
  .fi { color: var(--muted); font-size: 12px; display: inline-flex; flex: 0 0 auto; }
  .field:focus-within .fi { color: var(--accent); }
  input {
    border: 0; background: transparent; color: var(--fg); font-size: 12.5px;
    font-family: inherit; width: 100%; min-width: 0; padding: 0; outline: none;
  }
  input::placeholder { color: var(--muted); opacity: .8; }
  .clr {
    flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; border: 0; background: transparent; color: var(--muted);
    cursor: pointer; border-radius: 5px; font-size: 11px;
  }
  .clr:hover { color: var(--fg); background: var(--alt); }
</style>
