import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { execSync } from 'node:child_process'

// 前端构建版本: 部署时 deploy.sh 已 git ff 到 origin/main, 故短 SHA = 上线的提交。非 git 时回退 'dev'。
const BUILD_SHA = (() => {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
  catch { return 'dev' }
})()
const BUILD_TS = Math.floor(Date.now() / 1000)

// base './' -> 资源用相对路径, 部署到任意根/子路径都能跑(可镜像)。
// envDir 指向仓库根: 与 CLOUDFLARE_* 同住一个 .env(gitignore)。Vite 只把 `VITE_` 前缀
// 暴露进 bundle, 故根 .env 里的凭据不会泄漏; 仅 VITE_DATA_BASE(数据宿主, 如 R2) 进前端。
export default defineConfig({
  base: './',
  envDir: '../../',
  plugins: [svelte()],
  // 构建期常量(编译时文本替换), 供前端展示「前端 build 版本」。
  define: {
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __BUILD_TS__: JSON.stringify(BUILD_TS),
  },
  // cssTarget 设到 backdrop-filter 已原生(无前缀)支持的版本 ⇒ esbuild 不再自动塞 -webkit-backdrop-filter。
  build: { target: 'es2022', cssTarget: ['chrome111', 'edge111', 'firefox128', 'safari18'], chunkSizeWarningLimit: 2000, assetsInlineLimit: 2048 },
})
