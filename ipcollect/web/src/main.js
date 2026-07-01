import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app'),
})

// 注册 Service Worker: 壳(HTML/assets)重复加载秒开、可离线。相对路径契合 base './'(可镜像)。
// 失败(不支持/无痕/非安全上下文)静默忽略, 不影响主功能。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}) })
}

export default app
