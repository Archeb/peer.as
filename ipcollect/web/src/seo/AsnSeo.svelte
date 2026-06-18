<script>
  // ASN 落地页正文(边缘 SSR)。纯展示,零 app 依赖。SPA 接管后整块被移除。
  import { asnText } from './strings.js'
  let { lang = 'zh', asn, name = '', nameEn = '', org = '', v4 = 0, v6 = 0, peers = 0,
        prefixes = [], brand = 'PEER.AS' } = $props()
  const x = asnText(lang, { asn, name, nameEn, org, v4, v6, peers, brand })
  const lq = lang === 'en' ? '?lang=en' : ''
</script>

<article class="seo-doc">
  <h1>{x.heading}</h1>
  {#if org}<p class="seo-sub">{x.orgLabel}: {org}</p>{/if}
  <p class="seo-lede">{x.summary}</p>
  <ul class="seo-facts">
    <li><span>{x.v4label}</span><b>{v4}</b></li>
    <li><span>{x.v6label}</span><b>{v6}</b></li>
    <li><span>{x.peerLabel}</span><b>{peers}</b></li>
  </ul>
  {#if prefixes.length}
    <!-- 通告前缀内链: 给爬虫一条「ASN → 各前缀落地页(/<prefix>)」的发现路径, 一并抓走。 -->
    <section class="seo-prefixes">
      <h2>{x.prefixesLabel}</h2>
      <ul class="seo-pfxlist">
        {#each prefixes as p}
          <li><a href={'/' + p[0] + lq}>{p[0]}</a><span class="cc">{p[1]}</span></li>
        {/each}
      </ul>
      {#if (v4 || 0) + (v6 || 0) > prefixes.length}<p class="seo-more"><a href={'/' + asn + lq}>{x.prefixesMore}</a></p>{/if}
    </section>
  {/if}
</article>
