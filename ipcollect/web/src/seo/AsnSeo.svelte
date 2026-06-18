<script>
  // ASN 落地页正文(边缘 SSR)。纯展示,零 app 依赖。SPA 接管后整块被移除。
  import { asnText } from './strings.js'
  let { lang = 'zh', asn, name = '', nameEn = '', org = '', v4 = 0, v6 = 0, peers = 0, brand = 'PEER.AS' } = $props()
  const x = asnText(lang, { asn, name, nameEn, org, v4, v6, peers, brand })
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
  <p class="seo-cta">{x.cta}</p>
</article>
