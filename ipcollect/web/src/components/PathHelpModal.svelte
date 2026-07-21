<script>
  // AS_PATH 高级搜索语法说明(通配 + 排除)。由搜索框旁的 ? 图标打开。
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { iClose } from '../lib/icons.js'
  const close = () => (S.pathHelp = false)
  let zh = $derived(S.lang === 'zh')
  // [语法, 含义zh, 含义en]
  const rows = [
    ['4809 4538', '相邻：4809 紧接着 4538', 'Adjacent: 4809 immediately followed by 4538'],
    ['1299 * 4538', '间隔：1299 在 4538 之前，中间任意跳（含 0 跳），同一条路径内', 'Gap: 1299 before 4538, any hops between (incl. none), within one path'],
    ['1299 ? 4538', '一跳：1299 与 4538 之间正好 1 个 ASN（?? = 2 跳，依此类推）', 'One hop: exactly 1 ASN between 1299 and 4538 (?? = 2, etc.)'],
    ['4538 !174', '排除：含 4538，且整条路径都不经过 174', 'Exclude: contains 4538, and no path transits 174'],
    ['* 9929 * !4837', '组合：经过 9929、且全程不经 4837', 'Combine: transits 9929, never via 4837'],
  ]
</script>

{#if S.pathHelp}
  <div class="modal" onclick={(e) => e.target === e.currentTarget && close()} role="presentation">
    <div class="modal-box">
      <button class="close" onclick={close} aria-label="close"><Fa icon={iClose} /></button>
      <h2>{zh ? 'AS_PATH 搜索语法' : 'AS_PATH search syntax'}</h2>
      <p>{zh
        ? '输入空格分隔的 ASN 序列匹配「相邻」路径段。可用通配与排除符细化：'
        : 'Type a space-separated ASN sequence to match an adjacent path segment. Refine with wildcards and exclusions:'}</p>
      <table>
        <thead><tr><th>{zh ? '写法' : 'Syntax'}</th><th>{zh ? '含义' : 'Meaning'}</th></tr></thead>
        <tbody>
          {#each rows as r}
            <tr><td><code>{r[0]}</code></td><td>{zh ? r[1] : r[2]}</td></tr>
          {/each}
        </tbody>
      </table>
      <ul>
        <li><code>*</code> {zh ? '= 任意间隔（含 0 跳）' : '= any gap (incl. zero hops)'}</li>
        <li><code>?</code> {zh ? '= 正好一跳（可叠加 ??、???）' : '= exactly one hop (stackable ??, ???)'}</li>
        <li><code>!N</code> {zh ? '或 ' : 'or '}<code>-N</code> {zh ? '= 排除经过 ASN N' : '= exclude ASN N'}</li>
      </ul>
      <p class="disc">{zh
        ? '通配/排除只在该前缀已导出的去重路径（每前缀最多 128 条）内判定；序列匹配始终锁定在同一条路径内。结果按匹配路径的 peer 观测占比排序。'
        : 'Wildcards/exclusions are evaluated over the prefix’s exported distinct paths (up to 128 per prefix); sequence matching always stays within a single path. Results are ranked by the peer-observation share of matching paths.'}</p>
    </div>
  </div>
{/if}

<style>
  .modal { position: fixed; inset: 0; background: rgba(2, 6, 14, .62); backdrop-filter: blur(3px); display: flex; align-items: flex-start; justify-content: center; padding: 7vh 16px; overflow: auto; z-index: 50; animation: fade .15s ease; }
  @keyframes fade { from { opacity: 0 } }
  .modal-box { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; max-width: 580px; width: 100%; padding: 24px 28px; box-shadow: 0 24px 70px rgba(0, 0, 0, .5); position: relative; }
  .close { position: absolute; top: 16px; right: 18px; background: transparent; border: 0; cursor: pointer; color: var(--muted); font-size: 18px; }
  .close:hover { color: var(--accent); }
  h2 { font: 600 16px var(--sans); margin: 0 0 12px; padding-right: 26px; }
  p { font-size: 12.5px; line-height: 1.7; margin: 6px 0; color: var(--muted); }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th { text-align: left; font: 700 10px var(--mono); text-transform: uppercase; color: var(--muted); padding: 5px 8px; border-bottom: 1px solid var(--line); }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line2); font-size: 12.5px; color: var(--fg); vertical-align: top; }
  td:first-child { white-space: nowrap; }
  code { font: 12px var(--mono); color: var(--code); background: var(--alt); padding: 1px 6px; border-radius: 5px; }
  ul { margin: 8px 0; padding-left: 18px; }
  li { font-size: 12.5px; line-height: 1.9; color: var(--fg); }
  .disc { color: var(--muted); font-size: 11.5px; border-top: 1px solid var(--line2); margin-top: 14px; padding-top: 12px; }
</style>
