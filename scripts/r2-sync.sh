#!/usr/bin/env bash
# scripts/r2-sync.sh — 把 dist/data 同步到 R2 桶（海外数据宿主 peer-as-data.opentrace.app）。
#
# 背景: CF Pages 单文件 ≤25MiB、单部署 ≤2万文件，放不下全表 parquet（最大分片已近 25MiB）。故海外数据
#   从 Pages 同源剥离，独立 R2 桶托管（绑自定义域名 peer-as-data.opentrace.app + Cache Everything 规则 -> 命中即免
#   Class B、R2 egress 本就免费）。deploy.sh 在 WITH_DATA=1 且配了 R2_BUCKET 时调用本脚本。
#
# 一致性: 与 CN rsync 同策略——分片先全部上传，meta.json（版本指针）最后传，缩小"分片已更新、meta 未更新"
#   的窗口。任一分片重试 3 次仍失败 => 非零退出（deploy 据此中止，不上传 meta.json，线上保持上一版指针）。
# 排除 dotfile（如旧 `--local` 模拟器残留 .wrangler/）。
#
# 用法: r2-sync.sh <data_dir> <bucket> [parallelism]   （依赖 wrangler OAuth in $HOME）
set -uo pipefail

DATA_DIR="${1:?用法: r2-sync.sh <data_dir> <bucket> [P]}"
BUCKET="${2:?缺 bucket 名}"
P="${3:-16}"

WR="/usr/lib/node-24/bin/wrangler"; command -v "$WR" >/dev/null 2>&1 || WR="wrangler"
log(){ echo "[$(date -Is)] r2-sync: $*"; }
[ -d "$DATA_DIR" ] || { log "✗ 数据目录不存在: $DATA_DIR"; exit 1; }

# 单文件上传（content-type / cache-control 按类型；meta.json 短缓存，其余配合前端 ?v= 长缓存）。重试 3 次。
put_one(){
  local rel="$1" src="$DATA_DIR/$1" ct cc t
  case "$rel" in *.json) ct=application/json ;; *) ct=application/octet-stream ;; esac
  case "$rel" in meta.json) cc="public, max-age=0, must-revalidate" ;; *) cc="public, max-age=86400" ;; esac
  for t in 1 2 3; do
    "$WR" r2 object put "$BUCKET/$rel" --file "$src" --remote \
        --content-type "$ct" --cache-control "$cc" >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "$rel" >> "$FAILLOG"
  return 1
}
export -f put_one
export DATA_DIR BUCKET WR

cd "$DATA_DIR"

# 1) 除 meta.json 外全部并行上传
FAILLOG="$(mktemp)"; export FAILLOG
mapfile -t FILES < <(find . -type f -not -path '*/.*' -not -name 'meta.json' -printf '%P\n')
[ "${#FILES[@]}" -gt 0 ] || { log "✗ 没有可上传的文件（dist/data 为空?）"; rm -f "$FAILLOG"; exit 1; }
log "上传 ${#FILES[@]} 个分片/索引（并行 $P）-> $BUCKET …"
printf '%s\n' "${FILES[@]}" | xargs -P "$P" -I{} bash -c 'put_one "$@"' _ {}
NFAIL=$(wc -l < "$FAILLOG" 2>/dev/null || echo 0)
if [ "${NFAIL:-0}" != 0 ]; then
  log "✗ $NFAIL 个文件上传失败 —— 不上传 meta.json，中止（线上保持上一版数据指针）"
  sed 's/^/[r2-sync]   FAIL /' "$FAILLOG" | head -20
  rm -f "$FAILLOG"; exit 1
fi
rm -f "$FAILLOG"

# 2) 全部分片就绪 -> 最后传 meta.json（此后前端才看到新版本）
if [ -f "$DATA_DIR/meta.json" ]; then
  FAILLOG="$(mktemp)"; export FAILLOG
  if ! put_one "meta.json"; then log "✗ meta.json 上传失败"; rm -f "$FAILLOG"; exit 1; fi
  rm -f "$FAILLOG"
fi
log "✓ 同步完成（${#FILES[@]} 分片/索引 + meta.json）"
