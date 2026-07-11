// 路由追踪的窄范围显示修正。不得借此伪造 ASN；只补无法从 BGP 宣告取得的骨干名称。
export function traceAsName(ip, fallback = '') {
  const parts = String(ip || '').split('/')[0].split('.').map(Number)
  if (parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
      parts[0] === 59 && parts[1] === 43) return 'CN2'
  return fallback || ''
}
