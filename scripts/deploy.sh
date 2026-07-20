#!/usr/bin/env bash
# scripts/deploy.sh — PEER.AS 唯一部署入口（cron / 手动 / 开发都走这里，结果完全一致）。
# 用法: scripts/deploy.sh [--data|--data-light] [--no-build] [--cf-only|--cn-only]
#   (无 flag)    build 前端 + 部署两端（复用现有 dist/data）   —— 改了前端后推送 / 只动前端
#   --data       先 ingest --reset(4 个公开全表源 + 已配置私有源) + export-parquet —— daily refresh / 全重推
#   --data-light 仅重灌高频源(route-views2 + 已配置的 AS4837 私有源) + export —— 增量轻刷新
#   --no-build   跳过 npm build，用现有 web/dist（少用；纯重新部署现有 dist）
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
用法: scripts/deploy.sh [--data|--data-light] [--no-build] [--cf-only|--cn-only]
  (无 flag)    build 前端 + 部署两端（复用现有 dist/data）       改了前端后推送 / 只动前端
  --data       ingest --reset(全量) + export-parquet 重建数据，再 build + 部署   daily refresh / 全重推
  --data-light 仅重灌 REFRESH_ONLY(默认 route-views2 + 已配置 AS4837 私有源) + export
  --no-build   跳过 npm build，用现有 web/dist（纯重新部署现有 dist）
  --cf-only / --cn-only   只部署一端（默认 CF + CN 两端）
EOF
}

WITH_DATA=0; WITH_DATA_LIGHT=0; DO_BUILD=1; TARGET=both
# 增量轻刷新只重灌发布周期短的采集点；AS4837 URL 存在时自动随 route-views2 刷新。
# 显式设置 REFRESH_ONLY 时完全尊重调用方，不自动追加。
if [ -z "${REFRESH_ONLY+x}" ]; then
  REFRESH_ONLY="route-views2"
  [ -n "${IPC_MRT_AS4837_RIB_URL:-}" ] && REFRESH_ONLY="$REFRESH_ONLY,as4837-us"
fi
for a in "$@"; do case "$a" in
  --data)       WITH_DATA=1 ;;
  --data-light) WITH_DATA_LIGHT=1 ;;
  --no-build)   DO_BUILD=0 ;;
  --cf-only)    TARGET=cf ;;
  --cn-only)    TARGET=cn ;;
  -h|--help)    usage; exit 0 ;;
  *) echo "未知参数: $a（见 --help）" >&2; exit 2 ;;
esac; done
[ "$WITH_DATA" = 1 ] && [ "$WITH_DATA_LIGHT" = 1 ] && { echo "--data 与 --data-light 互斥" >&2; exit 2; }

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

# 站点 profile(见 ipcollect/profile.py + config.json): 一次读出 site / cn_mirror / cf_project。
#   site       前端 VITE_SITE(决定文案/品牌/person 导航等); peeras / dn42。
#   cn_mirror  是否部署 CN VPS; peeras=1, dn42=0(只上 CF)。
#              (peeras 的 VPS 现在是**前端唯一源** + 自托管 SSR, 不只是镜像; 海外经 CF for SaaS 回源它。)
#   cf_project CF Pages 项目名; peeras=bgp-insights(**已休眠**, 前端不再推 CF, 仅 dn42 用 deploy_cf 推自己的项目)。
# 读取失败回退 peeras 现状值(保守, 不破坏主站部署)。
_prof="$("$PROJ/.venv/bin/python" -c 'from ipcollect import config, profile
from urllib.parse import urlparse
c=config.load(); f=profile.features(c)
dcp = c.get("data_cf_project") or ("bgp-insights-data" if f["cn_mirror"] else "")
print(profile.site(c), ("1" if f["cn_mirror"] else "0"), (c.get("cf_project") or "bgp-insights"), (urlparse(c.get("site_base") or "https://peer.as").hostname or "peer.as"), dcp)' 2>/dev/null || echo "peeras 1 bgp-insights peer.as bgp-insights-data")"
read -r SITE CN_MIRROR CF_PROJECT PRIMARY_HOST DATA_CF_PROJECT <<<"$_prof"
[ -n "${SITE:-}" ] || { SITE=peeras; CN_MIRROR=1; CF_PROJECT=bgp-insights; PRIMARY_HOST=peer.as; DATA_CF_PROJECT=bgp-insights-data; }
export VITE_SITE="$SITE"   # npm build(ipc build)据此产出对应站点前端
# 数据/前端解耦(仅 peeras, DATA_CF_PROJECT 非空): --data* 只推「数据」Pages 项目(data.peer.as)+ CN /data;
# 无 data flag 只 build+推「前端」项目(不含 /data)+ CN 前端。两者各自独立锁 -> 前端部署永不被数据 cron 阻塞。
# dn42(DATA_CF_PROJECT 空)沿用旧耦合流程(数据+前端同项目、同 dist)。
DATA_MODE=0; { [ "$WITH_DATA" = 1 ] || [ "$WITH_DATA_LIGHT" = 1 ]; } && DATA_MODE=1
DECOUPLED=0; [ -n "${DATA_CF_PROJECT:-}" ] && DECOUPLED=1
export VITE_DATA_BASE="${VITE_DATA_BASE:-https://data.peer.as/data}"   # 前端海外数据源(db.js OVERSEAS)

# 防并发锁：解耦(peeras)时数据与前端各用独立锁(互不阻塞 -> 前端部署不再等数据 cron);
# 耦合(dn42)用单锁。放在 prof/模式确定之后(git-sync 已在 flock 之前完成)。
LOCKF="$PROJ/logs/deploy.lock"
[ "$DECOUPLED" = 1 ] && LOCKF="$PROJ/logs/deploy.$([ "$DATA_MODE" = 1 ] && echo data || echo frontend).lock"
exec 9>"$LOCKF"
if ! flock -n 9; then log "另一次 deploy 仍在运行(${LOCKF##*/})，退出。"; exit 0; fi

log "deploy 开始: site=$SITE host=$PRIMARY_HOST data=$WITH_DATA data_light=$WITH_DATA_LIGHT$([ "$WITH_DATA_LIGHT" = 1 ] && echo "($REFRESH_ONLY)") build=$DO_BUILD target=$TARGET cn_mirror=$CN_MIRROR cf_project=$CF_PROJECT data_cf_project=${DATA_CF_PROJECT:-（无,耦合）} decoupled=$DECOUPLED mode=$([ "$DATA_MODE" = 1 ] && echo data || echo frontend)"

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

elif [ "$WITH_DATA_LIGHT" = 1 ]; then
  # 增量轻刷新(路径 2a): 仅重灌 REFRESH_ONLY 列出的采集点(发布周期短, 如 route-views2 每 2h),
  #   其余采集点 obs 沿用上次全量结果。需先有一次 --data 全量打底(obs 持久在 ipcollect.duckdb)。
  #   不重跑 rpki/irr/asset(沿用上次 cache); finalize+export 仍是全量(故产物仍是完整快照, 过数据闸)。
  log "数据(轻): 增量重灌采集点 [$REFRESH_ONLY] —— 其余 obs 保留, 不动 rpki/irr/asset"
  rm -rf "$PROJ"/cache/duck_tmp/* 2>/dev/null || true
  for c in ${REFRESH_ONLY//,/ }; do
    rm -f "$PROJ"/cache/mrt/"$c"-* 2>/dev/null || true   # 清该采集点旧快照, 免堆积
  done
  ING_RC=0; ./ipc ingest --only "$REFRESH_ONLY" || ING_RC=$?
  if [ "$ING_RC" != 0 ]; then
    log "✗ 轻刷新 ingest 失败(rc=$ING_RC; 未全量打底? 用 --data) —— 中止部署"; exit 1
  fi
  ./ipc export-parquet --out dist
fi

# ── 2) 前端 ────────────────────────────────────────────────────────────────
# export-parquet 只产数据/SSG、不拷前端（copy_web 在 build/sync-web 里），故前端步骤独立、在数据之后。
# 默认总是 npm build：保证部署的前端永远是最新源码（消除"改了前端源却忘 build、部署旧前端"的事故类）。
# 解耦(peeras)数据模式: 只刷数据项目, **不建/不推前端**(前端随代码改动单独部署)。
if [ "$DECOUPLED" = 1 ] && [ "$DATA_MODE" = 1 ]; then
  log "前端: 解耦数据模式 —— 跳过前端构建(只刷数据项目)"
elif [ "$DO_BUILD" = 1 ]; then
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
  # SEO SSR bundle(dist/_worker.js)。**只为 peeras 的 CN VPS 自托管而建**(cn_mirror=1)。
  # 背景:peer.as 的 SSR 不再跑 CF Pages Function(配额被 GPTBot 爬爆 + custom-domain 无 WAF),
  # 改由 CN VPS 的 peeras-ssr.service 跑同一份 bundle(见 deploy_cn_frontend 自动推送+重启)。
  # dn42(无 cn_mirror、不指望 SEO)→ 不建、不发 _worker.js,SSR 全关。构建 fail-safe、永不阻断。
  if [ "$CN_MIRROR" = 1 ]; then
    log "前端: 构建 SEO SSR bundle（dist/_worker.js → CN VPS 自托管, fail-safe）"
    scripts/build-ssr.sh "$PROJ/dist" || true
  else
    log "前端: 无 cn_mirror（如 dn42）→ 不建 SSR bundle，清理残留 _worker.js/_routes.json"
    rm -f "$PROJ/dist/_worker.js" "$PROJ/dist/_routes.json"
  fi
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
# ── 3) 部署核心 ────────────────────────────────────────────────────────────
RSH="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20"

# 耦合(dn42): 整 dist(数据+前端)一把推 —— 旧实现保留。
deploy_cn(){
  if [ -z "${CN_DEPLOY_SSH:-}" ]; then log "CN: 未设置 CN_DEPLOY_SSH，跳过"; return 0; fi
  local CNPATH="${CN_DEPLOY_PATH:-/var/www/cn}"
  log "CN: rsync 整站 dist/ -> ${CN_DEPLOY_SSH}:${CNPATH}/（排除 _worker.js/_routes.json；meta.json 最后传）"
  if rsync -a --delete --exclude='data/meta.json' --exclude='data/.wrangler' --exclude='_worker.js' --exclude='_routes.json' -e "$RSH" "$PROJ/dist/" "${CN_DEPLOY_SSH}:${CNPATH}/" \
     && rsync -a -e "$RSH" "$PROJ/dist/data/meta.json" "${CN_DEPLOY_SSH}:${CNPATH}/data/meta.json"; then
    log "CN: ✓ 同步完成"
  else log "CN: ⚠ 同步失败（境内回退 CF，不阻断）"; fi
}
deploy_cf(){   # 整 dist -> CF_PROJECT(去超限 wasm)
  local STAGE rc=0
  STAGE="$(mktemp -d "$PROJ/.cfstage.XXXXXX")" || { log "CF: ✗ 暂存目录创建失败"; return 1; }
  cp -al "$PROJ/dist/." "$STAGE/" || { rm -rf "$STAGE"; log "CF: ✗ 硬链接暂存失败"; return 1; }
  rm -rf "$STAGE/data/.wrangler"; rm -f "$STAGE"/assets/*.wasm 2>/dev/null || true
  log "CF: wrangler pages deploy → 项目 $CF_PROJECT（排除超限 wasm）"
  wrangler pages deploy "$STAGE" --project-name "$CF_PROJECT" --branch main --commit-dirty=true \
    --commit-message="deploy.sh $SITE web+data" || rc=$?
  rm -rf "$STAGE"; return $rc
}

# 解耦(peeras): 数据项目 / 前端项目 各自独立推送 ──────────────────────────────
deploy_cf_data(){   # dist/data -> DATA_CF_PROJECT(data.peer.as);stage = data/ + _headers
  local STAGE rc=0
  STAGE="$(mktemp -d "$PROJ/.cfstage.XXXXXX")" || { log "CF(data): ✗ 暂存失败"; return 1; }
  mkdir -p "$STAGE/data"
  cp -al "$PROJ/dist/data/." "$STAGE/data/" || { rm -rf "$STAGE"; log "CF(data): ✗ 硬链接失败"; return 1; }
  rm -rf "$STAGE/data/.wrangler"
  cp "$PROJ/deploy/data-headers" "$STAGE/_headers" 2>/dev/null || true
  log "CF(data): wrangler pages deploy → 项目 $DATA_CF_PROJECT"
  wrangler pages deploy "$STAGE" --project-name "$DATA_CF_PROJECT" --branch main --commit-dirty=true \
    --commit-message="deploy.sh $SITE data" || rc=$?
  rm -rf "$STAGE"; return $rc
}
# (deploy_cf_frontend 已移除: peeras 前端不再推 CF Pages 前端项目 bgp-insights(已休眠),
#  改由 deploy_cn_frontend 进 CN VPS(含自托管 SSR bundle)。dn42 走下面耦合 deploy_cf。)
deploy_cn_data(){   # rsync 仅 dist/data -> cn:/data(--delete 限 data/ 内)
  [ -z "${CN_DEPLOY_SSH:-}" ] && { log "CN(data): 未设 CN_DEPLOY_SSH,跳过"; return 0; }
  local CNPATH="${CN_DEPLOY_PATH:-/var/www/cn}"
  log "CN(data): rsync dist/data/ -> ${CN_DEPLOY_SSH}:${CNPATH}/data/（排除 .wrangler；meta.json 最后）"
  if rsync -a --delete --exclude='.wrangler' --exclude='meta.json' -e "$RSH" "$PROJ/dist/data/" "${CN_DEPLOY_SSH}:${CNPATH}/data/" \
     && rsync -a -e "$RSH" "$PROJ/dist/data/meta.json" "${CN_DEPLOY_SSH}:${CNPATH}/data/meta.json"; then
    log "CN(data): ✓ 同步完成"
  else log "CN(data): ⚠ 同步失败(不阻断)"; fi
}
deploy_cn_frontend(){   # rsync dist 但排除 data/(数据由 deploy_cn_data 管;--delete 不碰 data/)
  [ -z "${CN_DEPLOY_SSH:-}" ] && { log "CN(fe): 未设 CN_DEPLOY_SSH,跳过"; return 0; }
  local CNPATH="${CN_DEPLOY_PATH:-/var/www/cn}"
  log "CN(fe): rsync dist/ -> ${CN_DEPLOY_SSH}:${CNPATH}/（排除 /data /_worker.js /_routes.json）"
  if rsync -a --delete --exclude='/data' --exclude='/_worker.js' --exclude='/_routes.json' -e "$RSH" "$PROJ/dist/" "${CN_DEPLOY_SSH}:${CNPATH}/"; then
    log "CN(fe): ✓ 同步完成"
  else log "CN(fe): ⚠ 同步失败(不阻断)"; fi
  # 自托管 SSR(peeras-ssr.service)的 bundle 自动化: 前端外壳 rsync 完后, 推 _worker.js + wrapper
  # 到 /opt/peeras-ssr/ 再 restart(服务内存缓存 index.html, 重启才重读新外壳 → 与新 assets 一致)。
  # best-effort: 失败只告警, VPS 继续跑旧 bundle(SSR 不中断)。_worker.js 仅 cn_mirror 时构建(见上)。
  if [ -f "$PROJ/dist/_worker.js" ]; then
    log "CN(fe): 推 SSR bundle + wrapper -> ${CN_DEPLOY_SSH}:/opt/peeras-ssr/ 并 restart peeras-ssr"
    if rsync -a -e "$RSH" "$PROJ/dist/_worker.js" "$PROJ/deploy/ssr-server.mjs" "${CN_DEPLOY_SSH}:/opt/peeras-ssr/" \
       && $RSH "$CN_DEPLOY_SSH" 'systemctl restart peeras-ssr'; then
      log "CN(fe): ✓ SSR bundle 已更新 + 服务重启"
    else log "CN(fe): ⚠ SSR bundle 推送/重启失败(不阻断, VPS 继续跑旧 bundle)"; fi
  fi
}

# 部署分派: 解耦(peeras)按模式只推一类;耦合(dn42)整 dist 一把推。CN best-effort, CF 失败=中止。
CF_RC=0
if [ "$DECOUPLED" = 1 ] && [ "$DATA_MODE" = 1 ]; then
  gate_data
  CN_PID= ; CF_PID=
  [ "$TARGET" != cn ] && { deploy_cf_data & CF_PID=$!; }
  { [ "$TARGET" != cf ] && [ "$CN_MIRROR" = 1 ]; } && { deploy_cn_data & CN_PID=$!; }
  [ -n "$CN_PID" ] && { wait "$CN_PID" || true; }
  [ -n "$CF_PID" ] && { wait "$CF_PID" || CF_RC=$?; }
  [ "$CF_RC" = 0 ] || { log "✗ CF(data) 部署失败(rc=$CF_RC) —— 中止"; exit 1; }
elif [ "$DECOUPLED" = 1 ]; then
  # peeras 前端: **只进 CN VPS**(含自托管 SSR bundle 推送 + 服务重启, 见 deploy_cn_frontend)。
  # 不再推 CF Pages 前端项目(bgp-insights 已休眠): peer.as 经 CF for SaaS 回源到 VPS, 前端/SSR/外壳
  # 全由 VPS 提供; CF 上 peeras 只剩 data.peer.as(数据项目)。故无 CF 失败闸(CF_RC 恒 0)。
  if [ "$TARGET" = cf ]; then
    log "前端: peeras 前端已无 CF 目标(只进 CN VPS) —— --cf-only 在前端模式下无操作"
  elif [ "$CN_MIRROR" = 1 ]; then
    deploy_cn_frontend
  fi
else
  gate_data
  CN_PID= ; CF_PID=
  { [ "$TARGET" != cf ] && [ "$CN_MIRROR" = 1 ]; } && { deploy_cn & CN_PID=$!; }
  [ "$TARGET" != cn ] && { deploy_cf & CF_PID=$!; }
  [ -n "$CN_PID" ] && { wait "$CN_PID" || true; }
  [ -n "$CF_PID" ] && { wait "$CF_PID" || CF_RC=$?; }
  [ "$CF_RC" = 0 ] || { log "✗ CF 部署失败(rc=$CF_RC) —— 中止部署"; exit 1; }
fi

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
# 数据模式校验: 数据宿主 meta.version 与本地一致(data.peer.as 未绑定时只告警)。
verify_data(){
  local lv; lv="$("$PROJ/.venv/bin/python" -c "import json;print(json.load(open('$PROJ/dist/data/meta.json'))['version'])" 2>/dev/null || true)"
  log "校验(data): 本地 meta.version = ${lv:-?}"
  for h in data.peer.as cn.peer.as; do
    { [ "$TARGET" = cf ] && [ "$h" = cn.peer.as ]; } && continue
    { [ "$TARGET" = cn ] && [ "$h" = data.peer.as ]; } && continue
    { [ "$CN_MIRROR" != 1 ] && [ "$h" = cn.peer.as ]; } && continue
    local gv; gv="$(curl -fsS --max-time 15 "https://$h/data/meta.json" 2>/dev/null | "$PROJ/.venv/bin/python" -c "import json,sys;print(json.load(sys.stdin).get('version',''))" 2>/dev/null || true)"
    if [ -n "$gv" ] && [ "$gv" = "$lv" ]; then log "校验(data): ✓ $h meta.version 一致"
    else log "校验(data): ⚠ $h meta.version=${gv:-空}（缓存/传播/域名未绑?需复查）"; fi
  done
}
if [ "$DECOUPLED" = 1 ] && [ "$DATA_MODE" = 1 ]; then verify_data || true; else verify || true; fi
log "完成 ✅"
