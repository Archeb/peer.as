#!/usr/bin/env bash
# 构建边缘 SSR worker -> <dist>/_worker.js + <dist>/_routes.json(CF Pages Advanced Mode)。
#
# **fail-safe 铁律**:任何失败只告警 + 清掉残留产物,绝不阻断部署 —— 站点退化为纯静态
# (CF SPA-200 / Caddy try_files 回退),SEO 退化为纯前端渲染。所以本脚本永远 exit 0。
# 用法:scripts/build-ssr.sh [dist 目录,默认 <repo>/dist]
set -u
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$PROJ/ipcollect/web"
OUT="${1:-$PROJ/dist}"

log(){ printf '[build-ssr] %s\n' "$*"; }

# 先清旧产物:无论成功失败,绝不让上一次的 _worker.js 残留(防失败时仍带着旧 SSR 上线)。
rm -f "$OUT/_worker.js" "$OUT/_routes.json"

if [ ! -d "$WEB/node_modules" ]; then
  log "⚠ web/node_modules 缺失,跳过 SSR(纯静态部署)"; exit 0
fi
if [ ! -d "$OUT" ]; then
  log "⚠ 输出目录 $OUT 不存在,跳过 SSR"; exit 0
fi

if ( cd "$WEB" && npx vite build --config vite.ssr.config.js ); then
  if [ -f "$WEB/ssr-dist/_worker.js" ] && [ -f "$WEB/_routes.json" ]; then
    cp "$WEB/ssr-dist/_worker.js" "$OUT/_worker.js"
    cp "$WEB/_routes.json" "$OUT/_routes.json"
    log "✅ _worker.js($(wc -c <"$OUT/_worker.js") B) + _routes.json 就位"
  else
    log "⚠ 构建未产出 _worker.js / 缺 _routes.json,跳过(纯静态)"
    rm -f "$OUT/_worker.js" "$OUT/_routes.json"
  fi
else
  log "⚠ SSR 构建失败,跳过(纯静态部署,SEO 退化为纯前端)"
  rm -f "$OUT/_worker.js" "$OUT/_routes.json"
fi
exit 0
