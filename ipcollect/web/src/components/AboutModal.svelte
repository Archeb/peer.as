<script>
  import Fa from 'svelte-fa'
  import { S } from '../lib/store.svelte.js'
  import { iClose } from '../lib/icons.js'
  const close = () => (S.about = false)
</script>

{#if S.about}
  <div class="modal" onclick={(e) => e.target === e.currentTarget && close()} role="presentation">
    <div class="modal-box">
      <button class="close" onclick={close} aria-label="close"><Fa icon={iClose} /></button>
      <h2>PEER.AS · 关于 / About</h2>
      <p><b>PEER.AS</b> — 全球 IPv4/IPv6 BGP 表的<b>静态、可复现</b>浏览器：每个前缀、它的 origin ASN，以及真正到达它的
        <b>AS_PATH</b>。全程在浏览器内运行，<b>无后端 / API / 数据库</b>，纯静态文件可自托管或镜像。
        <span class="en">A static, reproducible in-browser explorer of the global IPv4/IPv6 BGP table — every prefix, its
        origin ASNs, and the real AS_PATHs reaching it. Runs fully client-side; no backend, API or database.</span></p>

      <h3>数据与架构 / Data &amp; stack</h3>
      <ul>
        <li><b>数据</b>：来自 <b>RouteViews</b> 与 <b>RIPE RIS</b> 的全表 MRT RIB Dump（IPv4/IPv6）。
          <span class="en">Full-table MRT RIB dumps from RouteViews and RIPE RIS (IPv4/IPv6).</span></li>
        <li><b>查询</b>：导出 <b>Parquet</b>，浏览器内 <b>DuckDB-WASM</b> 直查；靠 <code>meta.json</code> 区间索引只取查询所需的少数分片。
          <span class="en">Parquet queried in-browser by DuckDB-WASM, fetching only the shards a query needs.</span></li>
        <li><b>可复现</b>：数据源公开，任何人都能重跑流水线、重建同一份站点。
          <span class="en">Reproducible & self-hostable from a fully public source.</span></li>
      </ul>

      <h3>中国优化 / China-optimized server</h3>
      <p>中国大陆访问由 <a href="https://www.dmit.io" target="_blank" rel="noopener noreferrer"><b>DMIT</b></a> 赞助的<b>中国优化线路服务器</b>就近加速（数据与查询引擎自该节点分发），海外经 Cloudflare；特此鸣谢。
        <span class="en">Mainland-China visitors are served from a China-optimized server kindly sponsored by
        <a href="https://www.dmit.io" target="_blank" rel="noopener noreferrer">DMIT</a>; elsewhere via Cloudflare.</span></p>

      <p class="disc"><b>免责 / Disclaimer</b>：仅是 rrc00 各 peer 的去程视角；父子段基于已采集前缀、可能不全；城市级精度取决于地理库。
        公开近似快照，仅供 BGP 研究 / 学习，<b>不作运营决策依据</b>。
        <span class="en">Outbound view of rrc00's peers; coverage may be partial. Approximate public snapshot — research/education only, not authoritative.</span></p>
      <p class="egg">✨ 试试点击 10 次首页 logo。<span class="en">Try tapping the homepage logo 10 times.</span></p>
    </div>
  </div>
{/if}

<style>
  .modal { position: fixed; inset: 0; background: rgba(2, 6, 14, .62); backdrop-filter: blur(3px); display: flex; align-items: flex-start; justify-content: center; padding: 7vh 16px; overflow: auto; z-index: 50; animation: fade .15s ease; }
  @keyframes fade { from { opacity: 0 } }
  .modal-box { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; max-width: 660px; width: 100%; padding: 24px 28px; box-shadow: 0 24px 70px rgba(0, 0, 0, .5); position: relative; }
  .close { position: absolute; top: 16px; right: 18px; background: transparent; border: 0; cursor: pointer; color: var(--muted); font-size: 18px; }
  .close:hover { color: var(--accent); }
  h2 { font: 600 16px var(--sans); margin: 0 0 12px; }
  h3 { font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; color: var(--accent); margin: 18px 0 6px; }
  p { font-size: 12.5px; line-height: 1.75; margin: 6px 0; color: var(--fg); }
  b { font-weight: 600; }
  code { font: 11.5px var(--mono); color: var(--code); }
  ul { margin: 4px 0; padding-left: 18px; }
  li { font-size: 12.5px; line-height: 1.7; margin: 4px 0; }
  .modal-box a { color: var(--link); text-decoration: none; }
  .modal-box a:hover { text-decoration: underline; }
  /* 英文副行: muted, 与中文主行拉开层次 */
  .en { display: block; color: var(--muted); margin-top: 2px; }
  .disc .en { display: inline; }
  .disc { color: var(--muted); font-size: 12px; border-top: 1px solid var(--line2); margin-top: 16px; padding-top: 13px; }
  .egg { color: var(--accent); font-size: 12px; margin-top: 8px; }
  .egg .en { display: inline; color: var(--muted); margin-left: 4px; }
</style>
