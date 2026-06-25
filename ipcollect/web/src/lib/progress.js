// 共享进度条状态(写 S.busy / S.prog, 仅 Topbar statusline 渲染)。
// 两处驱动: ① 慢查询(全表 AS_PATH 扫描, queries.js, 字节估算 + 吞吐校准的涓流);
//          ② 首次引擎加载(db.js initDuck, wasm 下载有真实字节进度 + 各阶段步进)。
// 二者不会并发(查询必在引擎就绪后)。这里只管「设值 / 收尾淡出」, 推进策略各自实现。
import { S } from './store.svelte.js'

let _fade = null
export function progressBegin() { clearTimeout(_fade); S.busy = true; S.prog = 0.02 }
// 单调推进到 [0, 0.99](永不在收尾前到顶); 未开始则忽略。
export function progressSet(v) {
  if (!S.busy) return
  const x = Math.max(0, Math.min(0.99, v))
  if (x > S.prog) S.prog = x
}
// 补满 1 再短暂停留淡出。
export function progressFinish() {
  clearTimeout(_fade)
  if (!S.busy) return
  S.prog = 1
  _fade = setTimeout(() => { S.busy = false; S.prog = 0 }, 280)
}
// 失败/中断: 立即收起, 不补满。
export function progressAbort() { clearTimeout(_fade); S.busy = false; S.prog = 0 }
