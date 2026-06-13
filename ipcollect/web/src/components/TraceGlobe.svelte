<script>
  // 全球路由跟踪的 3D 地球(canvas)。包一层 canvas + 命中层 + tooltip, 逻辑在 lib/traceglobe.js。
  // model: { target, probes:[...] } ; onpick: (q)=>void(点跳/靶标转发查询) ; onhover: (probeId|null)=>void
  import { onMount } from 'svelte'
  import { createTraceGlobe } from '../lib/traceglobe.js'
  import { ccLatLon, fetchTrace } from '../lib/geo.js'

  let { model = null, locations = null, focusId = null, hold = false, mode2d = false, onpick = null, onhover = null, onlochover = null, onengine = null } = $props()

  let canvasEl, hitEl, tipEl, ctrl
  // 初始视角定位到用户所在国家/地区: 用自有域 default.peer.as 的 trace 取 loc=国家码 → 国家质心经纬度。
  // (改自第三方 cf-ns.com, 统一只打自有 Cloudflare 端点。)
  function locateHome() {
    fetchTrace().then(tr => {
      if (tr?.cc) { const c = ccLatLon(tr.cc); ctrl?.setHome(c.lon, c.lat) }
    }).catch(() => { /* 定位失败: 保持默认初始朝向 */ })
  }
  onMount(() => {
    ctrl = createTraceGlobe(canvasEl, { tip: tipEl, hit: hitEl, mode2d, onpick, onhover, onlochover })
    if (locations) ctrl.setLocations(locations)   // 初帧即铺光点(不等首次 reactive)
    if (model) ctrl.setData(model)
    onengine && onengine(ctrl)                    // 把引擎句柄交给父组件(供复位按钮调用)
    locateHome()
    return () => ctrl?.destroy()
  })
  $effect(() => { if (model) ctrl?.setData(model) })
  $effect(() => { if (locations) ctrl?.setLocations(locations) })
  $effect(() => { ctrl?.setHold(hold) })
  $effect(() => { ctrl?.focus(focusId) })
  $effect(() => { ctrl?.setMode(mode2d) })
</script>

<div class="tglobe">
  <canvas bind:this={canvasEl}></canvas>
  <div class="tg-hit" bind:this={hitEl}></div>
  <div class="tg-tip" bind:this={tipEl}><div class="tg-a"></div><div class="tg-b"></div><div class="tg-c"></div></div>
</div>

<style>
  .tglobe { position: relative; width: 100%; height: 100%; touch-action: none; }
  .tglobe canvas { display: block; width: 100%; height: 100%; position: relative; z-index: 1; pointer-events: none; }
  .tglobe .tg-hit { position: absolute; inset: 0; z-index: 2; cursor: grab; touch-action: none; }
  .tglobe .tg-hit.hot { cursor: pointer; }
  .tglobe .tg-hit.grabbing { cursor: grabbing; }

  .tg-tip {
    position: absolute; left: 0; top: 0; transform: translate(-50%, -100%);
    pointer-events: none; opacity: 0; transition: opacity .14s ease; z-index: 5;
    background: color-mix(in srgb, var(--panel) 88%, transparent); color: var(--fg);
    border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; white-space: nowrap;
    backdrop-filter: blur(8px); box-shadow: 0 8px 26px -12px rgba(0,0,0,.5);
  }
  .tg-tip:global(.on) { opacity: 1; }
  .tg-tip .tg-a { font: 700 11.5px var(--mono); color: var(--fg); letter-spacing: -.01em; }
  .tg-tip .tg-b { font: 600 11px var(--sans); color: var(--accent); margin-top: 2px; }
  .tg-tip .tg-c { font: 500 10.5px var(--mono); color: var(--muted); margin-top: 2px; }
  .tg-tip::after {
    content: ''; position: absolute; left: 50%; bottom: -5px; width: 9px; height: 9px;
    background: var(--panel); border-right: 1px solid var(--line); border-bottom: 1px solid var(--line);
    transform: translateX(-50%) rotate(45deg);
  }
</style>
