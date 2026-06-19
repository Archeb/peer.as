<script>
  // 404 落地页正文(边缘 SSR / 给爬虫与无 JS 访客)。纯展示, 零 app 依赖。
  // 与 SPA 端 components/NotFound.svelte 同一「traceroute 失败」隐喻, 措辞取自 strings.notFoundText。
  import { notFoundText } from './strings.js'
  let { lang = 'zh', brand = 'PEER.AS', target = '' } = $props()
  const x = notFoundText(lang, { brand, target })
  const host = String(brand).toLowerCase()   // peer.as / dn42.peer.as
</script>

<article class="seo-doc nf-seo">
  <p class="nf-eyebrow">{x.eyebrow}</p>
  <h1>{x.h1}</h1>
  <p class="seo-lede">{x.lede}</p>
  {#if target}<p class="nf-target">{x.targetLabel}: <code>{target}</code></p>{/if}
  <div class="nf-trace" aria-hidden="true">
    <span class="cmd">traceroute {target}</span>
    <span class="ok">01  · · · · {x.youLabel}</span>
    <span class="ok">02  · · · · {x.edgeLabel}</span>
    <span class="ok">03  {host} · {x.reachedLabel}</span>
    <span>04  * * * · {x.noRespLabel}</span>
    <span class="bad">✗ no route to host · {x.code}</span>
  </div>
</article>
