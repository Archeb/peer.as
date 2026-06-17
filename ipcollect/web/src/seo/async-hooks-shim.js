// node:async_hooks 的极小同步替身 —— 让 Svelte SSR(svelte/server)能在**纯** CF Workers 上跑,
// 无需 nodejs_compat 兼容标志(避免「模块加载期 import node:async_hooks 失败 → 整个 _worker.js 实例化失败
// → 所有路由报错」的全站风险)。
//
// 正确性前提:svelte 的 render() 是**同步**的(同步返回 {head,body},无 await 跨越 context),
// 故 run() 用同步 try/finally 还原上一层 store 即等价于真 AsyncLocalStorage。一旦将来 SSR 变异步,
// 需改回真实 async_hooks(配 nodejs_compat)。
export class AsyncLocalStorage {
  constructor() { this._store = undefined }
  getStore() { return this._store }
  run(store, callback, ...args) {
    const prev = this._store
    this._store = store
    try { return callback(...args) } finally { this._store = prev }
  }
  enterWith(store) { this._store = store }
  exit(callback, ...args) {
    const prev = this._store
    this._store = undefined
    try { return callback(...args) } finally { this._store = prev }
  }
}
export class AsyncResource {
  constructor() {}
  runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args) }
  bind(fn) { return fn }
}
export default { AsyncLocalStorage, AsyncResource }
