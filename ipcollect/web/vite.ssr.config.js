import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// 把 svelte SSR 运行时对 node:async_hooks 的 import 重定向到同步替身,使 _worker.js 不依赖
// nodejs_compat(纯 Workers 即可跑)。见 src/seo/async-hooks-shim.js 的正确性说明。
const alsShim = fileURLToPath(new URL('./src/seo/async-hooks-shim.js', import.meta.url))

// 边缘 SSR worker 的**独立** SSR 构建:把 src/seo/worker.js + 共享 SEO 组件 + svelte/server
// 打成单文件 _worker.js(CF Pages Advanced Mode)。与主 SPA 构建(vite.config.js)完全解耦 ——
// 本构建失败不影响 `npm run build`/部署(由 scripts/build-ssr.sh fail-safe 兜底)。
export default defineConfig({
  base: './',
  envDir: '../../',
  plugins: [svelte()],
  resolve: { alias: { 'node:async_hooks': alsShim, async_hooks: alsShim } },
  build: {
    ssr: 'src/seo/worker.js',
    outDir: 'ssr-dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    rollupOptions: {
      output: { entryFileNames: '_worker.js', format: 'es', inlineDynamicImports: true },
    },
  },
  // webworker 目标:用 worker/browser 解析条件、不引 node 内置,产出可在 workerd(CF)跑的 ESM。
  // noExternal:把 svelte 等依赖一并打进单文件(CF Worker 不能外链 node_modules)。
  ssr: { noExternal: true, target: 'webworker' },
})
