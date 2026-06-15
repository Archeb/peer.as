#!/usr/bin/env bash
# scripts/deploy.sh — PEER.AS 唯一部署入口（cron / 手动 / 开发都走这里，结果完全一致）。
# 用法: scripts/deploy.sh [--data] [--no-build] [--cf-only|--cn-only]
#   (无 flag)   build 前端 + 部署两端（复用现有 dist/data）   —— 改了前端后推送 / 只动前端
#   --data      先 ingest --reset + export-parquet 重建数据，再 build + 部署 —— daily refresh / 全重推数据
#   --no-build  跳过 npm build，用现有 web/dist（少用；纯重新部署现有 dist）
#   --cf-only / --cn-only   只部署一端（默认 CF + CN 两端都部署）
# 设计：数据(ingest+export)、前端(build)、部署(CF+CN) 三段；部署核心只实现这一份。
set -euo pipefail

# PROJ = 本脚本所在仓库根(从脚本位置推导, 不写死路径) —— 这样 peeras / dn42 各自 checkout 都能用同一份脚本。
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJ"

# cron 直接调用时 PATH/HOME 极简，补齐 node-24（npm/wrangler）与系统目录；HOME 供 wrangler 读 OAuth、ssh 读密钥。
export HOME="${HOME:-/home/aosc}"
case ":$PATH:" in *":/usr/lib/node-24/bin:"*) ;; *) export PATH="/usr/lib/node-24/bin:/usr/local/bin:/usr/bin:/bin:$PATH" ;; esac
# .env: CN_DEPLOY_SSH/CN_DEPLOY_PATH（CN VPS）、可选 CF 凭据覆盖。
[ -f "$PROJ/.env" ] && { set -a; . "$PROJ/.env"; set +a; }

usage(){ cat <<'EOF'
scripts/deploy.sh — PEER.AS 唯一部署入口（cron / 手动 / 开发都走这里，结果一致）。
用法: scripts/deploy.sh [--data] [--no-build] [--cf-only|--cn-only]
  (无 flag)   build 前端 + 部署两端（复用现有 dist/data）       改了前端后推送 / 只动前端
  --data      ingest --reset + export-parquet 重建数据，再 build + 部署   daily refresh / 全重推数据
  --no-build  跳过 npm build，用现有 web/dist（纯重新部署现有 dist）
  --cf-only / --cn-only   只部署一端（默认 CF + CN 两端）
EOF
}

WITH_DATA=0; DO_BUILD=1; TARGET=both
for a in "$@"; do case "$a" in
  --data)     WITH_DATA=1 ;;
  --no-build) DO_BUILD=0 ;;
  --cf-only)  TARGET=cf ;;
  --cn-only)  TARGET=cn ;;
  -h|--help)  usage; exit 0 ;;
  *) echo "未知参数: $a（见 --help）" >&2; exit 2 ;;
esac; done

log(){ echo "[$(date -Is)] $*"; }

mkdir -p "$PROJ/logs"

# ── 0) GitOps 代码同步（以后只需 commit+push，两站 cron/手动部署都自动拉新代码，无需手动 ff dn42-prod）──
#   ff-only：仅快进到 origin/main，绝不 reset/覆盖本地提交；分叉/离线只告警不阻断，用当前工作树继续。
#   config.json 是 gitignored 的本地文件，不受同步影响（peeras/dn42 靠它区分）。
#   放在 flock 之前：若代码确有更新则 re-exec 本脚本以应用新版本（避免改动运行中的脚本；IPC_GIT_SYNCED 防重入死循环）。
if [ "${IPC_GIT_SYNCED:-0}" != 1 ] && command -v git >/dev/null 2>&1 && git -C "$PROJ" rev-parse --git-dir >/dev/null 2>&1; then
  _before="$(git -C "$PROJ" rev-parse HEAD 2>/dev/null || true)"
  if git -C "$PROJ" fetch --quiet origin 2>/dev/null && git -C "$PROJ" merge --ff-only origin/main >/dev/null 2>&1; then
    _after="$(git -C "$PROJ" rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$_after" ] && [ "$_before" != "$_after" ]; then
      log "git: 同步到 origin/main (${_before:0:7} -> ${_after:0:7})；re-exec 以应用新版本"
      export IPC_GIT_SYNCED=1
      exec "$PROJ/scripts/deploy.sh" "$@"
    fi
    log "git: 代码已是 origin/main 最新 (${_after:0:7})"
  else
    log "git: ⚠ 同步跳过（离线/分叉/有未推送本地提交?），用当前工作树继续"
  fi
fi
export IPC_GIT_SYNCED=1

# 防并发：cron 与手动互斥（上一次没跑完就退出，避免并发重 ingest 撕裂 DB / 半成品 dist 被部署）。
exec 9>"$PROJ/logs/deploy.lock"
if ! flock -n 9; then log "另一次 deploy 仍在运行，退出。"; exit 0; fi

# 站点 profile(见 ipcollect/profile.py + config.json): 一次读出 site / cn_mirror / cf_project。
#   site       前端 VITE_SITE(决定文案/品牌/person 导航等); peeras / dn42。
#   cn_mirror  是否部署 cn.peer.as 镜像; peeras=1, dn42=0(只上 CF)。
#   cf_project CF Pages 项目名; peeras=bgp-insights, dn42 实例在 config.json 设 cf_project。
# 读取失败回退 peeras 现状值(保守, 不破坏主站部署)。
_prof="$("$PROJ/.venv/bin/python" -c 'from ipcollect import config, profile
from urllib.parse import urlparse
c=config.load(); f=profile.features(c)
print(profile.site(c), ("1" if f["cn_mirror"] else "0"), (c.get("cf_project") or "bgp-insights"), (urlparse(c.get("site_base") or "https://peer.as").hostname or "peer.as"))' 2>/dev/null || echo "peeras 1 bgp-insights peer.as")"
read -r SITE CN_MIRROR CF_PROJECT PRIMARY_HOST <<<"$_prof"
[ -n "${SITE:-}" ] || { SITE=peeras; CN_MIRROR=1; CF_PROJECT=bgp-insights; PRIMARY_HOST=peer.as; }
export VITE_SITE="$SITE"   # npm build(ipc build)据此产出对应站点前端

log "deploy 开始: site=$SITE host=$PRIMARY_HOST data=$WITH_DATA build=$DO_BUILD target=$TARGET cn_mirror=$CN_MIRROR cf_project=$CF_PROJECT"

# ── 1) 数据（可选）──────────────────────────────────────────────────────────
if [ "$WITH_DATA" = 1 ]; then
  # 清缓存：旧 MRT(每版 ~350MB×2) + duck 溢出残留，否则日积月累撑爆硬盘。保留 cache/geo(GeoLite + 版本戳)。
  log "数据 1/2: 清缓存(mrt/duck_tmp; 保留 geo)"
  rm -f  "$PROJ"/cache/mrt/*.gz "$PROJ"/cache/mrt/*.part "$PROJ"/cache/mrt/dl.log 2>/dev/null || true
  rm -rf "$PROJ"/cache/duck_tmp/* 2>/dev/null || true
  log "数据 2/2: ingest(MRT→DuckDB) ∥ rpki/irr/asset(下载→cache) 并行 → 互锁 → export-parquet"
  # 资源不重叠故可安全并行: ingest 写 DuckDB; 三个 import 只写 cache/ 文件(不碰 DuckDB)。
  # import 后台跑(日志落文件、末尾回放), ingest 前台(扫描进度实时可见)。
  # best-effort: 某源失败不阻断; 开关关或无网时 export 自动降级 has_*=False。
  imp_log="$PROJ/logs/_imports.$$"
  {
    ./ipc rpki-import  || log "  ! rpki-import 失败(继续, 本轮无 RPKI 标注)"
    ./ipc irr-import   || log "  ! irr-import 失败(继续, 本轮无 IRR 标注)"
    ./ipc asset-import || log "  ! asset-import 失败(继续, 本轮无 as-set 树)"
  } >"$imp_log" 2>&1 &
  IMP_PID=$!
  ING_RC=0; ./ipc ingest --reset || ING_RC=$?
  if [ "$ING_RC" != 0 ]; then
    # ingest 失败=致命(数据撕裂)。先收掉后台 import(避免成孤儿与下次运行抢写 cache), 再中止。
    kill "$IMP_PID" 2>/dev/null || true; wait "$IMP_PID" 2>/dev/null || true
    cat "$imp_log" 2>/dev/null || true; rm -f "$imp_log"
    log "✗ ingest 失败(rc=$ING_RC) —— 中止部署"; exit 1
  fi
  # 互锁: 必须等下载阶段也结束(export 要读 cache 里的 rpki/irr/asset), 两 stage 都完成才进 export
  IMP_RC=0; wait "$IMP_PID" || IMP_RC=$?
  log "  ↓ 下载阶段(rpki/irr/asset)输出"; cat "$imp_log" 2>/dev/null || true; rm -f "$imp_log"
  [ "$IMP_RC" = 0 ] || log "  ! 下载阶段退出码=$IMP_RC（各步已各自容错, 不阻断 export）"
  ./ipc export-parquet --out dist
fi

# ── 2) 前端 ────────────────────────────────────────────────────────────────
# export-parquet 只产数据/SSG、不拷前端（copy_web 在 build/sync-web 里），故前端步骤独立、在数据之后。
# 默认总是 npm build：保证部署的前端永远是最新源码（消除"改了前端源却忘 build、部署旧前端"的事故类）。
if [ "$DO_BUILD" = 1 ]; then
  log "前端: vendor duckdb 扩展 + RDAP bootstrap + ipc build（npm run build + 拷 web/dist -> dist）"
  scripts/vendor-duckdb-ext.sh    # 确保 public/duckdb-ext/ 就位（pinned，已存在则秒过）-> vite 拷进 dist
  # RDAP bootstrap 自更新（IANA RFC 9224）：best-effort，IANA 拉不到就用现有内置，**不阻塞部署**。
  # 前端已无 rdap.org 第三方兜底，故这份内置表需随部署保鲜。build 后还原源文件（git 跟踪文件，
  # 留改动会脏 working tree → 下次 git merge --ff-only 撞 committed 更新时冲突）；本次 build 已吃到新表。
  if scripts/vendor-rdap-bootstrap.sh >/dev/null 2>&1; then
    log "前端: ✓ RDAP bootstrap 已自更新（IANA）"
  else
    log "前端: ⚠ RDAP bootstrap 自更新失败（IANA 不可达?），用现有内置继续"
  fi
  ./ipc build --out dist
  git -C "$PROJ" checkout -- ipcollect/web/src/lib/rdap-bootstrap.json 2>/dev/null || true
else
  log "前端: --no-build，仅 ipc sync-web（拷已构建 web/dist -> dist）"
  ./ipc sync-web --out dist
fi

# ── 2.5) 部署前数据完整性闸（防把空/残缺数据推上线覆盖好数据）─────────────────
# 背景: 2026-06-05 主站炸库 —— ingest/export 在断网下失败, 但 ipc 退出码曾被吞(已修),
#   set -e 没拦住 -> 拿空库 export -> meta.json 仍是旧版(未重写)而 parquet 全空 ->
#   rsync --delete + wrangler 把好数据抹掉。此闸: meta.json 声明的每个 parquet 分片必须
#   真实存在于 dist/data/parquet/, 否则中止(绝不部署), 让线上保持上一版好数据。
gate_data(){
  local meta="$PROJ/dist/data/meta.json"
  [ -f "$meta" ] || { log "✗ 数据闸: dist/data/meta.json 缺失 —— 中止部署"; exit 1; }
  local res; res="$("$PROJ/.venv/bin/python" - "$PROJ/dist" <<'PY'
import json, os, sys
dist = sys.argv[1]
pq = os.path.join(dist, "data", "parquet")
try:
    m = json.load(open(os.path.join(dist, "data", "meta.json")))
except Exception as e:
    print(f"ERR meta-unreadable {e}"); raise SystemExit(0)
checked = miss = 0
for v in (m.get("files") or {}).values():
    if isinstance(v, list):
        for f in v:
            if isinstance(f, str) and f.endswith(".parquet"):
                checked += 1
                if not os.path.exists(os.path.join(pq, f)):
                    miss += 1
print(f"OK {checked} {miss}")
PY
)" || { log "✗ 数据闸: 校验脚本异常 —— 中止部署"; exit 1; }
  case "$res" in
    "OK "*)
      read -r _ checked miss <<<"$res"
      if [ "${checked:-0}" = 0 ]; then log "✗ 数据闸: meta 未声明任何 parquet 分片 —— 中止部署(export 失败?)"; exit 1; fi
      if [ "${miss:-1}" != 0 ]; then log "✗ 数据闸: meta 声明 $checked 个 parquet, 本地缺失 $miss —— 中止部署(export 残缺?)"; exit 1; fi
      log "✓ 数据闸: $checked 个 parquet 分片齐备" ;;
    *) log "✗ 数据闸: $res —— 中止部署"; exit 1 ;;
  esac
}
gate_data

# ── 3) 部署核心（唯一实现）─────────────────────────────────────────────────
deploy_cn(){
  if [ -z "${CN_DEPLOY_SSH:-}" ]; then log "CN: 未设置 CN_DEPLOY_SSH，跳过"; return 0; fi
  local CNPATH="${CN_DEPLOY_PATH:-/var/www/cn}"
  local RSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"
  # CN VPS（Caddy 无大小限制）托管**完整 dist 含 wasm**。--delete 清掉本地没有的旧文件（含已废 /duckdb）。
  # meta.json 最后单独传（原子切版本：数据分片先到位再切版本号）。best-effort，失败不阻断（境内回退 CF）。
  log "CN: rsync 整站 dist/ -> ${CN_DEPLOY_SSH}:${CNPATH}/（含完整 wasm；meta.json 最后传）"
  if rsync -a --delete --exclude='data/meta.json' -e "$RSH" "$PROJ/dist/" "${CN_DEPLOY_SSH}:${CNPATH}/" \
     && rsync -a -e "$RSH" "$PROJ/dist/data/meta.json" "${CN_DEPLOY_SSH}:${CNPATH}/data/meta.json"; then
    log "CN: ✓ 同步完成"
  else
    log "CN: ⚠ 同步失败（境内回退 CF，不阻断）"
  fi
}
deploy_cf(){
  # CF Pages 单文件 ≤25MiB，而 duckdb-eh/mvp.wasm 达 33/39MB（pages deploy 不认 .assetsignore）。
  # 用「硬链接暂存株」部署：cp -al 整个 dist 到同盘临时目录（秒级、不复制数据），删副本里的 *.wasm 再 deploy。
  #   真实 dist/ 全程不动 → 既能与 deploy_cn(rsync dist/ 含 wasm) 安全并行，又比"移出/移回"更稳(wrangler 失败也不伤 dist)。
  #   (CF 节点前端 wasmSrcs 走 CDN 取 wasm；worker/数据照常同源)
  local STAGE rc=0
  STAGE="$(mktemp -d "$PROJ/.cfstage.XXXXXX")" || { log "CF: ✗ 暂存目录创建失败"; return 1; }
  cp -al "$PROJ/dist/." "$STAGE/" || { rm -rf "$STAGE"; log "CF: ✗ 硬链接暂存失败"; return 1; }
  rm -f "$STAGE"/assets/*.wasm 2>/dev/null || true
  # 数据走 R2(peer-as-data.opentrace.app)时, Pages 不再托管 dist/data —— 逃 CF Pages 单文件≤25MiB / 单部署≤2万文件上限。
  # 保留 dist/duckdb-ext(parquet 扩展 ~3MB, 前端走同源, 见 db.js setupExtensions)。
  # **仅 peeras(CN_MIRROR=1)**: R2 桶只装 peeras 全表; dn42 是单站 CF Pages、数据同源, 绝不移除(与前端 cnMirror 收口一致)。
  if [ -n "${R2_BUCKET:-}" ] && [ "$CN_MIRROR" = 1 ]; then
    rm -rf "$STAGE/data" 2>/dev/null || true
    log "CF: 数据走 R2($R2_BUCKET)，已从 Pages 暂存株移除 dist/data（仅部署前端 + duckdb-ext）"
  fi
  log "CF: wrangler pages deploy → 项目 $CF_PROJECT（排除超限 wasm；CF 节点 wasm 回退 CDN）"
  wrangler pages deploy "$STAGE" --project-name "$CF_PROJECT" --branch main --commit-dirty=true \
    --commit-message="deploy.sh $SITE $([ "$WITH_DATA" = 1 ] && echo 'data+web' || echo web)" || rc=$?
  rm -rf "$STAGE"
  return $rc
}
deploy_r2(){
  # 海外数据宿主: 同步 dist/data -> R2 桶(peer-as-data.opentrace.app)。仅 WITH_DATA=1 且配了 R2_BUCKET 时调用(见下)。
  # meta.json 最后传(原子切版本); 任一分片失败=非零退出(中止部署)。详见 scripts/r2-sync.sh。
  log "R2: 同步 dist/data -> 桶 $R2_BUCKET（peer-as-data.opentrace.app）"
  scripts/r2-sync.sh "$PROJ/dist/data" "$R2_BUCKET" 16
}
# 并行推送: R2(数据, 仅 --data) ∥ CN(rsync 整站) ∥ CF(wrangler 暂存株)。三者互不冲突(deploy_cf 不动 dist/)。
# 互锁: 等都结束再继续(verify 要各端已切版本)。CN best-effort(函数内吞失败); R2/CF 失败=中止。
# R2 仅在 peeras(CN_MIRROR=1) 且 TARGET≠cn(海外由 R2 供数据) 且 WITH_DATA=1(数据有变) 且配了桶时跑;
# 纯前端部署(WITH_DATA=0)R2 数据不变跳过; dn42(CN_MIRROR=0)是单站 CF Pages、永不碰 R2。
CN_PID= ; CF_PID= ; R2_PID= ; CF_RC=0 ; R2_RC=0
{ [ "$TARGET" != cf ] && [ "$CN_MIRROR" = 1 ]; } && { deploy_cn & CN_PID=$!; }
{ [ "$TARGET" != cn ] && [ "$CN_MIRROR" = 1 ] && [ "$WITH_DATA" = 1 ] && [ -n "${R2_BUCKET:-}" ]; } && { deploy_r2 & R2_PID=$!; }
[ "$TARGET" != cn ] && { deploy_cf & CF_PID=$!; }
[ -n "$CN_PID" ] && { wait "$CN_PID" || true; }
[ -n "$R2_PID" ] && { wait "$R2_PID" || R2_RC=$?; }
[ -n "$CF_PID" ] && { wait "$CF_PID" || CF_RC=$?; }
[ "$R2_RC" = 0 ] || { log "✗ R2 数据同步失败(rc=$R2_RC) —— 中止部署"; exit 1; }
[ "$CF_RC" = 0 ] || { log "✗ CF 部署失败(rc=$CF_RC) —— 中止部署"; exit 1; }

# ── 4) 部署后轻量校验（防回归：两端入口一致 + CN wasm 自托管）─────────────────
verify(){
  local le; le="$(grep -o 'assets/index-[^\"]*\.js' dist/index.html | head -1)"
  log "校验: 本地入口 = $le"
  for h in "$PRIMARY_HOST" cn.peer.as; do
    { [ "$TARGET" = cf ] && [ "$h" = cn.peer.as ]; } && continue
    { [ "$TARGET" = cn ] && [ "$h" = "$PRIMARY_HOST" ]; } && continue
    { [ "$CN_MIRROR" != 1 ] && [ "$h" = cn.peer.as ]; } && continue
    local got; got="$(curl -fsS --max-time 15 "https://$h/" 2>/dev/null | grep -o 'assets/index-[^\"]*\.js' | head -1 || true)"
    if [ "$got" = "$le" ]; then log "校验: ✓ $h 入口一致"; else log "校验: ⚠ $h 入口=${got:-空}（缓存/传播中?需复查）"; fi
  done
  # R2 海外数据宿主校验: peer-as-data.opentrace.app/meta.json 应返回 JSON。需自定义域名已绑定 + Cache 规则生效。
  if [ "$TARGET" != cn ] && [ "$CN_MIRROR" = 1 ] && [ -n "${R2_BUCKET:-}" ] && [ -n "${VITE_DATA_BASE:-}" ]; then
    local rm1; rm1="$(curl -fsS --max-time 20 "${VITE_DATA_BASE%/}/meta.json" 2>/dev/null | head -c1 || true)"
    if [ "$rm1" = "{" ]; then log "R2: ✓ ${VITE_DATA_BASE} 数据可达（meta.json）"
    else log "R2: ⚠ ${VITE_DATA_BASE}/meta.json 不可达/非 JSON —— 自定义域名绑定了? Cache 规则? CORS?（海外数据将取不到）"; fi
  fi
  if [ "$TARGET" != cf ] && [ "$CN_MIRROR" = 1 ]; then
    local w; w="$(ls "$PROJ"/dist/assets/duckdb-eh-*.wasm 2>/dev/null | head -1 | xargs -r basename || true)"
    if [ -n "$w" ]; then
      local ct; ct="$(curl -fsSI --max-time 20 "https://cn.peer.as/assets/$w" 2>/dev/null | grep -i '^content-type:' | tr -d '\r' || true)"
      case "$ct" in *application/wasm*) log "CN: ✓ wasm 自托管（$ct）" ;; *) log "CN: ⚠ wasm $ct（应为 application/wasm）" ;; esac
    fi
  fi
  # **关键**: parquet 扩展自托管校验（防 CF SPA-200 把 HTML 当扩展）。校验每个已部署端的扩展实际返回 wasm magic。
  # rel = duckdb-ext/<引擎版本>/wasm_eh/parquet.duckdb_extension.wasm（从 dist 取实际路径，免硬编码版本）。
  local rel; rel="$(cd "$PROJ/dist" 2>/dev/null && ls duckdb-ext/*/wasm_eh/parquet.duckdb_extension.wasm 2>/dev/null | head -1 || true)"
  if [ -n "$rel" ]; then
    for h in "$PRIMARY_HOST" cn.peer.as; do
      { [ "$TARGET" = cf ] && [ "$h" = cn.peer.as ]; } && continue
      { [ "$TARGET" = cn ] && [ "$h" = "$PRIMARY_HOST" ]; } && continue
      { [ "$CN_MIRROR" != 1 ] && [ "$h" = cn.peer.as ]; } && continue
      local magic; magic="$(curl -fsS --max-time 25 "https://$h/$rel" 2>/dev/null | head -c4 | xxd -p 2>/dev/null || true)"
      if [ "$magic" = "0061736d" ]; then log "扩展: ✓ $h parquet 扩展自托管（wasm magic 正确）"
      else log "扩展: ⚠ $h parquet 扩展 magic=${magic:-空}（非 wasm！前端会回退官方源，请查 $rel 是否部署）"; fi
    done
  else
    log "扩展: ⚠ dist/duckdb-ext 缺失（vendor 未跑?）—— 前端将回退官方 extensions.duckdb.org"
  fi
}
verify || true
log "完成 ✅"
