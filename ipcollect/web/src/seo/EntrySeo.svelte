<script>
  // 入口页落地页正文(home/advanced/trace/probe,边缘 SSR)。纯展示,零 app 依赖。
  import { entryText } from './strings.js'
  let { lang = 'zh', page = 'home', brand = 'PEER.AS' } = $props()
  const x = entryText(lang, page, brand)
</script>

<article class="seo-doc">
  <h1>{x.h1}</h1>
  <p class="seo-lede">{x.sum}</p>
</article>
