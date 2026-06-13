<script>
  import { pathTokens } from '../lib/bgp.js'
  import { showAsn } from '../lib/queries.js'
  // nav=true 时每个 ASN 可点击跳转到该 ASN 详情(stopPropagation 防触发外层行点击)。
  // arrow=true 时各跳之间用 › 连接(显式表示 AS_PATH 方向: 采集点 › … › origin)。
  // onnav: 可选自定义点击处理(收 asn)。给了就用它取代默认 showAsn —— 供首页等需要先切视图的场景。
  let { asns, dim = false, hi = [], nav = false, arrow = false, onnav = null } = $props()
  let toks = $derived(pathTokens(asns))
  let hiSet = $derived(new Set((hi || []).map(Number)))
  const go = (e, asn) => { e.stopPropagation(); if (onnav) onnav(asn); else showAsn(asn) }
</script>

{#snippet body(tk)}<b>{tk.asn}</b>{#if tk.name}<span class="an">({tk.nameShort})</span>{/if}{#if tk.tier1}<span class="t1" title="Tier-1">★</span>{/if}{#if tk.rep > 1}<span class="rep" title="AS prepend ×{tk.rep}">×{tk.rep}</span>{/if}{/snippet}

<code class="aspath" class:dim>
  {#each toks as tk, i}{#if nav}<button type="button"
      class="asn nav {tk.cls}" class:hi={hiSet.has(tk.asn)}
      title={tk.op ? tk.op + ' · ' + tk.name : tk.name}
      onclick={(e) => go(e, tk.asn)}>{@render body(tk)}</button>{:else}<span
      class="asn {tk.cls}" class:hi={hiSet.has(tk.asn)}
      title={tk.op ? tk.op + ' · ' + tk.name : tk.name}>{@render body(tk)}</span>{/if}{#if arrow && i < toks.length - 1}<span class="arr">›</span>{:else}{' '}{/if}{/each}
</code>

<style>
  .aspath { font-family: var(--mono); font-size: 11.5px; line-height: 1.85; color: var(--code); }
  .aspath.dim { opacity: 0.62; }
  .asn { color: var(--c, var(--code)); white-space: nowrap; }
  /* nav: 让 <button> 完全继承内联文本外观, 只在 hover 时下划线提示可点 */
  .asn.nav { font: inherit; background: transparent; border: 0; padding: 0; margin: 0; cursor: pointer; vertical-align: baseline; }
  .asn.nav:hover { text-decoration: underline; text-underline-offset: 2px; }
  .asn.hi { background: var(--accent-dim); border-radius: 4px; padding: 0 3px; outline: 1px solid var(--accent); }
  .asn .an { opacity: 0.72; font-size: 0.92em; font-family: var(--sans); }
  .asn .t1 { color: var(--signal); margin-left: 1px; font-size: 0.85em; }
  .asn .rep { color: var(--accent); font-size: 0.82em; margin-left: 2px; font-weight: 700; opacity: 0.9; }
  .arr { color: var(--muted); opacity: .5; margin: 0 2px; font-weight: 700; user-select: none; }
</style>
