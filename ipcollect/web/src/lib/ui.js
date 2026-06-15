import { S } from './store.svelte.js'

export function applyTheme(th) {
  S.theme = th
  const r = document.documentElement
  if (th === 'light' || th === 'dark' || th === 'ba') r.setAttribute('data-theme', th); else r.removeAttribute('data-theme')
  if (th === 'auto') localStorage.removeItem('ipc-theme'); else localStorage.setItem('ipc-theme', th)
}
export function cycleTheme() {
  // 'ba'(Blue Archive)是彩蛋, 不进默认轮换; 在 ba 下点切换会回到 auto。
  const order = ['auto', 'light', 'dark']
  applyTheme(order[(order.indexOf(S.theme) + 1) % order.length])
}

// 彩蛋: 连点 logo 10 次解锁 Blue Archive 主题(1.5s 无操作则计数清零)。
let logoTaps = 0
let logoTapTimer = null
export function tapLogo() {
  logoTaps++
  if (logoTapTimer) clearTimeout(logoTapTimer)
  logoTapTimer = setTimeout(() => { logoTaps = 0 }, 1500)
  if (logoTaps >= 10) { logoTaps = 0; applyTheme('ba') }
}
export function setLang(l) {
  S.lang = (l === 'en') ? 'en' : 'zh'
  localStorage.setItem('ipc-lang', S.lang)
  document.documentElement.lang = S.lang === 'zh' ? 'zh-CN' : 'en'
}
export function toggleLang() { setLang(S.lang === 'zh' ? 'en' : 'zh') }
