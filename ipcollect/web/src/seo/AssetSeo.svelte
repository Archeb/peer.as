<script>
  // AS-SET 落地页正文(边缘 SSR)。纯展示,零 app 依赖。
  import { assetText } from './strings.js'
  let { lang = 'zh', setKey, source = '', descr = '', count = 0, members = [], brand = 'PEER.AS' } = $props()
  const x = assetText(lang, { key: setKey, source, descr, count, brand })
  // 成员链接:纯 ASN(AS\d+) -> /<num>;子 as-set / 带来源键 -> /asset/<key>
  function href(m) {
    const s = String(m || '')
    const mm = /^AS(\d+)$/i.exec(s)
    return mm ? `/${mm[1]}` : `/asset/${encodeURIComponent(s)}`
  }
</script>

<article class="seo-doc">
  <h1>{setKey}</h1>
  {#if source}<p class="seo-sub">{x.sourceLabel}: {source}</p>{/if}
  <p class="seo-lede">{x.summary}</p>
  <p class="seo-facts"><b>{count}</b> {x.membersLabel}</p>
  {#if members && members.length}
    <ul class="seo-members">
      {#each members as m}
        <li><a href={href(m)}>{m}</a></li>
      {/each}
    </ul>
  {/if}
  <p class="seo-cta">{x.cta}</p>
</article>
