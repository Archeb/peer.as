#!/usr/bin/env bash
# scripts/daily-refresh.sh — fcron 入口（见 `fcrontab -l`）。**薄封装**：实际工作全在 scripts/deploy.sh。
# 本脚本只负责日志文件 + 轮转。把收到的参数**原样透传** deploy.sh（无参 = 全量 --data）。
#   全量 (--data)：清缓存 → ingest --reset(4 采集点) → export → build → 部署。
#   轻量 (--data-light)：只重灌 REFRESH_ONLY(默认 route-views2 每 2h) → export → build → 部署（其余采集点保留）。
# 并发互斥 / PATH / HOME / .env / 校验等都在 deploy.sh 内（cron 与手动共用同一份逻辑，结果一致）。
# **多实例**：PROJ 从脚本位置推导（不写死），peeras 与 dn42 各自 checkout 用同一份脚本。保留份数 REFRESH_KEEP（默认 45）。
#   - peeras 全量：每 8 小时（本地 00:40/08:40/16:40，对齐 RIPE RIS bview 发布 UTC 00/08/16 + 40min 延迟）。
#   - peeras 轻量：每 2 小时（其余偶数点 +40min，对齐 RouteViews 2h RIB；cron 行加 --data-light）。
#   - dn42：每 10 分钟（对齐 dn42 GRC 10min 发布；cron 行前置 REFRESH_KEEP=144）。
set -euo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGDIR="$PROJ/logs"; mkdir -p "$LOGDIR"
# 无参默认全量 --data（向后兼容现有 cron 行）。
ARGS=("$@"); [ ${#ARGS[@]} -eq 0 ] && ARGS=(--data)
# 日志按 full/light 分桶轮转：避免每 2h 的 light 把每 8h 的 full 日志挤掉。
TAG=full; case " ${ARGS[*]} " in *" --data-light "*) TAG=light ;; esac
TS="$(date +%Y%m%d-%H%M%S)"; LOG="$LOGDIR/daily-refresh-$TAG-$TS.log"
KEEP="${REFRESH_KEEP:-45}"

if "$PROJ/scripts/deploy.sh" "${ARGS[@]}" >>"$LOG" 2>&1; then
  echo "[$(date -Is)] daily-refresh($TAG) OK" >>"$LOG"; status=OK
else
  status="FAILED(exit=$?)"; echo "[$(date -Is)] daily-refresh($TAG) $status" >>"$LOG"
fi

# 只保留最近 KEEP 份日志（按 tag 分桶）
ls -1t "$LOGDIR"/daily-refresh-"$TAG"-*.log 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
[ "$status" = OK ]
