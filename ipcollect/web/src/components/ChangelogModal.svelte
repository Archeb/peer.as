<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { iClose } from '../lib/icons.js'
  // 单一数据源: 直接 import 仓库根的 CHANGELOG.md(?raw, 构建期内联), 网站与仓库内容永远一致。
  import raw from '../../../../CHANGELOG.md?raw'

  const close = () => (S.changelog = false)
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

  // 极简 Markdown -> 分块(h1/h2/ul/p), 够覆盖本 changelog 的格式即可。
  function blocks(md) {
    const out = [], lines = md.replace(/\r/g, '').split('\n')
    let list = null
    const flush = () => { if (list) { out.push({ t: 'ul', items: list }); list = null } }
    for (const ln of lines) {
      if (/^#\s+/.test(ln)) { flush(); out.push({ t: 'h1', h: inline(ln.replace(/^#\s+/, '')) }) }
      else if (/^##\s+/.test(ln)) { flush(); out.push({ t: 'h2', h: inline(ln.replace(/^##\s+/, '')) }) }
      else if (/^-\s+/.test(ln)) { (list = list || []).push(inline(ln.replace(/^-\s+/, ''))) }
      else if (ln.trim() === '') { flush() }
      else { flush(); out.push({ t: 'p', h: inline(ln) }) }
    }
    flush()
    return out
  }
  let bs = $derived(blocks(raw))
  // 按 h2(日期)分组: head = 首个日期之前的标题/前言(始终显示); sections = 各日期一段(可折叠)。
  let grouped = $derived.by(() => {
    const head = [], sections = []
    let cur = null
    for (const b of bs) {
      if (b.t === 'h2') { cur = { date: b.h, body: [] }; sections.push(cur) }
      else if (cur) cur.body.push(b)
      else head.push(b)
    }
    return { head, sections }
  })
</script>

{#if S.changelog}
  <div class="modal" onclick={(e) => e.target === e.currentTarget && close()} role="presentation">
    <div class="modal-box">
      <button class="close" onclick={close} aria-label="close"><Fa icon={iClose} /></button>
      {#each grouped.head as b}
        {#if b.t === 'h1'}<h2>{@html b.h}</h2>
        {:else if b.t === 'ul'}<ul>{#each b.items as it}<li>{@html it}</li>{/each}</ul>
        {:else}<p class="intro">{@html b.h}</p>{/if}
      {/each}
      <!-- 每个日期一段, 默认只展开最新(第一个); 点日期头折叠/展开。 -->
      {#each grouped.sections as sec, i (sec.date)}
        <details class="sec" open={i === 0}>
          <summary><span class="date">{@html sec.date}</span></summary>
          <div class="body">
            {#each sec.body as b}
              {#if b.t === 'ul'}<ul>{#each b.items as it}<li>{@html it}</li>{/each}</ul>
              {:else if b.t === 'h2' || b.t === 'h1'}<h3>{@html b.h}</h3>
              {:else}<p>{@html b.h}</p>{/if}
            {/each}
          </div>
        </details>
      {/each}
    </div>
  </div>
{/if}

<style>
  .modal { position: fixed; inset: 0; background: rgba(2, 6, 14, .62); backdrop-filter: blur(3px); display: flex; align-items: flex-start; justify-content: center; padding: 7vh 16px; overflow: auto; z-index: 50; animation: fade .15s ease; }
  @keyframes fade { from { opacity: 0 } }
  .modal-box { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; max-width: 660px; width: 100%; padding: 24px 28px; box-shadow: 0 24px 70px rgba(0, 0, 0, .5); position: relative; }
  .close { position: absolute; top: 16px; right: 18px; background: transparent; border: 0; cursor: pointer; color: var(--muted); font-size: 18px; }
  .close:hover { color: var(--accent); }
  h2 { font: 600 16px var(--sans); margin: 0 0 10px; padding-right: 26px; }
  h3 { font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--accent); margin: 18px 0 6px; }
  p { font-size: 12.5px; line-height: 1.7; margin: 6px 0; color: var(--muted); }
  .intro { font-size: 11.5px; color: var(--muted); opacity: .85; }
  /* 每个日期一段, 可折叠 */
  .sec { border-top: 1px solid var(--line); }
  .sec > summary {
    list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px;
    padding: 12px 2px; user-select: none;
  }
  .sec > summary::-webkit-details-marker { display: none; }
  .sec > summary::before {
    content: '▸'; color: var(--muted); font-size: 11px; transition: transform .15s ease;
  }
  .sec[open] > summary::before { transform: rotate(90deg); }
  .sec > summary .date { font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--accent); }
  .sec > summary:hover .date { color: var(--fg); }
  .sec[open] > summary .date { color: var(--accent); }
  .sec .body { padding: 0 2px 6px; }
  ul { margin: 4px 0 10px; padding-left: 18px; }
  li { font-size: 12.5px; line-height: 1.7; margin: 6px 0; color: var(--fg); }
  :global(.modal-box code) { font: 11.5px var(--mono); color: var(--code); }
  :global(.modal-box strong) { font-weight: 600; color: var(--fg); }
</style>
