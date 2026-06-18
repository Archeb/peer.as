# AGENTS.md — PEER.AS 维护 & 部署指南

> **本项目今后只由 agent 维护。本文件 = 入口 + 架构 + 部署流程的权威概览**，默认读者是一个**无任何先验上下文**的 agent。
> **只记不易过时的骨架**（项目是什么、模块分工、怎么部署、不可破坏的不变量）；**实现/设计细节随源码与 `docs/` 走，不在此复述**。
> 架构或部署流程有变更时同步更新本文件。（README 面向人类、偏介绍；本文件面向 agent、偏操作。）

## 项目是什么

自研 CLI `ipc`（python 包 `ipcollect/`，用同目录 `.venv`）+ 纯静态 Web 看板 **PEER.AS（全球 BGP Insights）**。

从 **4 采集点**（RIPE RIS `rrc01`/`rrc06`/`rrc03` + RouteViews `route-views2`）MRT **全表（IPv4+IPv6）** 静态分析回程 AS_PATH，
**入库 = 全球全部 v4+v6 前缀**（不按 ASN/国家过滤），用 **DuckDB 工作库**去重，导出 **Parquet** 数据集，
**DuckDB-WASM 在浏览器里直查静态 Parquet**（全 GET 整片下载、无 Range、无后端）。

- **中间库 = DuckDB**（`ipcollect.duckdb`，跑完即弃，已 gitignore；SQLite 已退役）。
- **地理以 geo 库为准**（不靠前缀首 IP）：三轨合并为非重叠区间——`ipdb`（私有，CN 城市级）+ `GeoLite2-City`（非 CN 全球城市级）+ `rir`（国家级兜底）。
- 设计契约/踩坑见 **`docs/DUCKDB_V6_REFACTOR.md`**、`docs/GLOBAL_DESIGN.md`、`docs/RPKI_IRR_RESEARCH.md`、`docs/RDAP_WHOIS_RESEARCH.md`。

## 运行入口

仓库根用 `./ipc <子命令>`（启动器自动走 `.venv`，数据/缓存落本目录）。主要子命令：
`init`/`config`/`geo-import`/`ingest`/`export-parquet`/`build`/`sync-web`/`serve`。
（查询类 CLI 已退役；调试直接用 DuckDB 查工作库或 parquet。）

## 架构 / 文件地图（`ipcollect/`）

- `cli.py` — `ipc` 子命令入口（argparse）。
- `config.py` — `DEFAULT_CONFIG` + `load/save`；`mrt_collectors`/`geolite_*` 等集中在此。`asn_registry` 唯一权威源 = `ipcollect/data/asn_registry.csv`（CSV，可直接 PR，改即生效、不写回 config.json）。
- `bgp.py` — AS_PATH 清洗/邻接、ASN 命名、`path_contains_seq`（**连续子序列**）。
- `mrt.py` — 流式 MRT RIB 解析（v4+v6）+ 断点续传下载；按采集点名自动选 RIS/RouteViews 布局；`ingest()` 全表去重写工作库。
- `store.py` — **DuckDB 工作库**：连接、`obs`/`meta` 表、CSV 流式灌入、`finalize`（去重 → `pathobs`/`prefix`）。
- `geoip.py` — GeoLite 过期检查/下载、`build_geo`（三轨合并非重叠区间 + AS org）、按 family 内存 bisect 的 geo 索引。
- `parquet_export.py` — **主发布步骤**（`ipc export-parquet`）：读工作库出两套 Parquet（`prefixes`/`paths`/`pathsearch`/`byorigin`/`geo` 等，v4+v6）+ `asnames.json`/`asnorg.json` + `meta.json`，调 `ssg`，拷前端。
- `ssg.py` — **sitemap 索引 + 分片(ASN/AS-SET/入口, 带 hreflang)+ robots**(旧的 /c/*.html 国家落地页已废弃)。`parquet_export` 另产 `data/seo/{asn,asset}.json`(边缘 SSR 紧凑数据)。
- **边缘 SEO SSR(CF-only, fail-safe)**: `web/src/seo/`(`*.Seo.svelte` + `strings.js` + `worker.js`,**零 app 依赖、单向**)→ `vite.ssr.config.js` 打成 `dist/_worker.js`(CF Pages Advanced Mode)+ `_routes.json`。爬虫访问 `/<asn>`/`/asset/<key>`/入口页 → 同壳 SSR(本地化 head + #seo-shell 内容块),SPA 启动后 `App.svelte` 移除 #seo-shell 无缝接管(同 URL)。`scripts/build-ssr.sh` 永远 exit 0:失败/缺依赖只跳过(不产 `_worker.js`)→ 站点退化为纯静态 + SPA-200 回退,**绝不阻断部署**。CN 镜像(Caddy 跑不了 Worker)不发 `_worker.js`,境内仍纯前端渲染(Googlebot 走 CF)。
  - **OG 大图(社交分享卡)**:CF Function 给 ASN/AS-SET/入口页注入 `og:image` → **CN VPS 上的 Pillow 渲染器**(`deploy/og-renderer.py`,systemd `og-renderer.service`,监听 127.0.0.1:8092,Caddy 反代 `/og/*`)。它读本机 `/var/www/cn/data/seo/*.json` 画 1200×630 PNG(中文用 Noto Sans CJK SC),磁盘缓存 `/var/www/cn/og-cache`(按源 JSON mtime 失效)。**手动部署**(同 Caddyfile,deploy.sh 不管):改 `og-renderer.py` 后 `scp 到 /opt/og-renderer/ && systemctl restart og-renderer`;改 Caddyfile 后 `scp 到 /etc/caddy/Caddyfile && caddy validate && systemctl reload caddy`。dn42 无此渲染器 → CF Function 对 dn42 不出 `og:image`。
- `rpki.py` / `irr.py` / `asset.py` — 路由起源验证（RPKI ROA / IRR route / IRR as-set 锥）。导出期预计算成静态列/数据集，前端零后端查询；`meta.has_*` 缺失即前端降级。
- `profile.py` — 站点 profile（peeras / dn42）特性开关（见下「站点 Profile」）。
- `registry.py` — dn42 专用：RPSL registry 解析 → 逐 ASN/域名静态 whois。
- `serve.py` — 本地 debug 静态托管（支持 Range）。
- **`web/`** — 前端 = **Vite + Svelte 5**。`src/App.svelte` + `src/components/*` + `src/lib/*`（`db.js` DuckDB-WASM 数据层、`queries.js` 搜索/视图、`rdap.js`/`dns.js` WHOIS/DNS、`geo.js`、`site.js` profile、`store.svelte.js` 全局状态）。**改完必须 `npm run build`**（产 `web/dist/`），`export-parquet`/`ipc build` 再拷进 `dist/`。组件级内部细节看源码，不在本文件复述。

### 数据表（工作库 `ipcollect.duckdb`）

`obs`（ingest 中间观测，finalize 后可弃）· `pathobs`（pid + 去重 AS_PATH + n_peers）· `prefix`（每前缀 + ip_start/end + 代表 origin + n_origins + n_paths）· `geo`（非重叠区间 + cc/省/市）· `country_dim`/`asn_dim`/`meta`。

## 配置（`config.json`，集中维护、勿 hard code）

```bash
./ipc config show
./ipc config set mrt_collectors rrc01,rrc06   # 列表/对象直接手改 config.json
```

- 入库口径固定为**全球全表**（不按 ASN/国家过滤）。
- ASN 命名/分组 = `ipcollect/data/asn_registry.csv`（列 `asn,name,name_en,op`；`#` 行注释）；改即生效。
- 脱敏（**重要**）：**不得提交任何密钥/机器敏感信息**。CF account id / API token 走环境变量（见 `.env.example`）；`config.json`、`.env`、`.wrangler/`、私有 geo 库 `ipdb.txt` 均已 gitignore。

## 站点 Profile（多站点：peer.as + dn42）

本代码库可服务 `peeras`（全球公网）与 `dn42`（dn42 fork，无地理）。**维护铁律：站点差异一律用「配置开关关成 no-op」实现，绝不删代码分叉**——主站演进时 dn42 永不冲突。

- 后端 `ipcollect/profile.py` 的 `PROFILES` + `features(cfg)`；`config.json` 的 `"site"` 选定、`"features":{}` 可逐项覆盖。**peeras = 现状全开**；新开关的 peeras 默认值必须复现当前行为。
- 前端 `web/src/lib/site.js` 的 `SITE`（`VITE_SITE`）+ `features`。组件按 `features` 分支。
- 关键开关：`geo`（地理管线总开关）、`cn_mirror`（CN 镜像 + 前端 CN 分流，**后端开关必须透传到前端 `features.cnMirror`**）、`whois`/`whoisView`/`dns`/`routeTrace`。
- **dn42 实例**：独立 worktree `/home/aosc/dn42-peer-as`（分支 `dn42-prod`，跟踪 origin/main），跑同一份 `deploy.sh`（site-aware）；CF 项目 `dn42-peer-as`、域名 `dn42.peer.as`；cron 每 10min。

## 数据维护命令

```bash
./ipc ingest --reset            # 下载 4 采集点最新 RIB, 全表 v4+v6 入 DuckDB。改采集点后必须重跑
./ipc ingest --only route-views2 # 增量: 只重灌列出的采集点(其余 obs 保留, finalize 仍全量合并)。需先 --reset 打底
./ipc export-parquet --out dist # 工作库 -> dist/data/parquet + meta.json + SSG（约 3-5min）。主发布步骤
./ipc build                     # 只改前端时: npm run build + 拷 web/dist -> dist/（秒级, 不碰数据）
./ipc serve                     # 本地看站 http://127.0.0.1:8787/
```

- **ingest 按采集点并行解析**（进程池绕 GIL, fork 上下文; 子进程纯解析不碰 DuckDB, 父进程串行灌库）：
  4 采集点墙钟 = 最慢单点(~12min) 而非相加(~27min)。DuckDB 线程默认吃满核(`min(8,核数)`, 可 `IPC_DUCKDB_THREADS` 调小)。
- **各采集点真实快照时刻**记进 meta `mrt_snap_<collector>`(RIB 文件名的 UTC 时刻) / `ingest_ts_<collector>`(本机灌入时刻)——
  采集点发布周期不同(RIS bview 8h / RouteViews RIB 2h)故时龄天然不齐, 这是多视角 BGP 语义、非 bug; meta 留作透明化。

- geo 库 ingest 会自动按需重建（GeoLite 过期才下）；手动 `./ipc geo-import`。
- DuckDB 溢出目录走真盘（`cache/duck_tmp`，别用 /tmp tmpfs）；内存紧可 `IPC_DUCKDB_MEM=8GB IPC_DUCKDB_THREADS=2`。

## 部署

### 部署 SOP（看这一节就够）

**目录分工：** 开发在 worktree `/home/aosc/test-ip-collect-dev`（branch `dev`，已软链好依赖/数据/`.env`/`.venv`）；
**别在两个部署目录里开发**（都挂 cron、保持干净）：peeras 主 checkout `/home/aosc/test-ip-collect`（branch `main`）、dn42 `/home/aosc/dn42-peer-as`（`dn42-prod`）。

**五步：**
1. dev worktree 改完 → `git add` **只加改的源文件**（**绝不 `git add -A`**：`public/data`/`duckdb-ext`/`.venv` 是本地 symlink，不该提交）→ commit。
2. `git fetch origin` → 不能 ff（origin/main 被 dn42 推进、分叉）则 `git rebase origin/main`（可能撞 `AGENTS.md`/`db.js`）。
3. `git push origin dev:main`。**GitOps 唯一真源 = `origin/main`；不 push 到 main，线上 ≤8h 被 cron 回滚。**
4. **从主 checkout** `cd /home/aosc/test-ip-collect && scripts/deploy.sh`：只动前端→无 flag；改了数据/全重推→`--data`；只刷高频采集点(route-views2)→`--data-light`(增量, 需先 `--data` 打底过)。脚本自己 GitOps ff、`npm build`、数据闸校验、推 **CF(前端+数据) + CN(镜像)** 两端、末尾核两端入口一致。
   - **绝不在缺 `.env` 的 worktree 跑 deploy.sh**（CN 凭据只在 `.env`，缺则 CN 静默跳过→两端不一致）；**绝不手敲 wrangler/rsync/手动 build**。
5. 成功 = 日志末尾 `完成 ✅`。dn42 由其自己的 10min cron 自动同步，无需手动。

> 纯文档/记忆类改动（如本文件）：走 1–3 即可，**不必跑 deploy.sh**（不进 dist、不影响站点）。
> `scripts/deploy.sh` 是**唯一部署入口**（cron / 手动 / 开发全走它，结果一致）。flag：`--data` / `--no-build` / `--cf-only` / `--cn-only` / `--help`。

### 数据分发：同源 Pages + CN 整站镜像

**数据随前端一起部署到 CF Pages、海外同源 `/data`**（Pages 资产分发到全球边缘、就近返回、无回源）。数据宿主**按用户位置在 `web/src/lib/db.js` 的 `configure()` 运行时选**：

- **海外 = 同源 `/data`**（CF Pages）。
- **境内 = `cn.peer.as`**（CN 优化 VPS 整站镜像，见下「中国优化」），数据自带 `/data`。
- **GeoDNS 把 peer.as 解到 CN 机器 / 本地 serve** = 同源（本机即正确源）。

`configure()` 逻辑：直连 cn.peer.as 或 `/cdn-cgi/trace` 404（GeoDNS→CN 机器/本地）⇒ 同源 edge=cn；CF 上 `loc=CN`（境内但 GeoDNS 没生效）⇒ 健康探测后切 cn.peer.as（带回退同源）；其余（海外 CF）⇒ 同源 edge=cf。wasm/worker 随构建打包（worker/JS API 始终同源；CF 节点大 wasm 回退 CDN）。
**数据版本/缓存**：`meta.version` 驱动 `?v=` 失效（所有 parquet/asnames URL 带上，故可长缓存，`web/public/_headers` 管）；`meta.json` 自身 no-cache。

> **曾短暂试过 R2（海外数据独立桶 `peer-as-data`），2026-06-15 当天回退**：CF Pages 是边缘分发，R2 自定义域名是单源拉取式缓存，**叠加 8h 数据刷新 + `?v=` 整批失效 + 低单点流量 → 每个 POP 基本都冷回源**，比 Pages 慢很多；而迁 R2 的唯一理由（Pages 25MiB/2万文件上限）当前未撞线（最大分片 ~19.5MB、943 文件）。**结论：留在 Pages**；将来某分片逼近 25MiB 时靠**切更细分片**（export 的 `*_FILE_SIZE` 旋钮）继续留 Pages，而非搬 R2。

### 中国优化（cn.peer.as）

CF Pages 在中国大陆慢（跨境限速/丢包）。方案：一台优化线路 VPS（Caddy）托管**与 peer.as 完全一致的整站**（前端 + 数据 + 自托管 DuckDB-WASM），`deploy.sh` 的 CN 步 rsync 整个 `dist/` 过去。GeoDNS 把境内 `peer.as` 解到本机（需本机有 peer.as 的 TLS 证书，LE 走 DNS-01）。
DuckDB-WASM、Cache Storage 大 wasm 缓存、parquet 扩展自托管、全 GET 模式、Caddy 配置（CORS、关 h3、DoH/WHOIS 境内反代）等实现细节较多且稳定，**见 `web/src/lib/db.js` 与 `deploy/cn.peer.as.Caddyfile` 源码**，不在此复述。

### cron 自动刷新（全量 8h + 轻量 2h）

`scripts/daily-refresh.sh`（fcron 薄封装）把参数**原样透传** deploy.sh（无参 = `--data` 全量）。两条 peeras cron 行：

- **全量** `40 0,8,16 * * *  …/daily-refresh.sh`（每 8h，对齐 RIPE RIS bview UTC 00/08/16 + 40min）。
- **轻量** `40 2,4,6,10,12,14,18,20,22 * * *  …/daily-refresh.sh --data-light`（其余偶数点 +40min，每 2h 刷 route-views2，对齐 RouteViews 2h RIB）。
  净效果：**route-views2 视角 ≤2h 新鲜，RIS 视角 ≤8h**（采集点发布周期不同，时龄不齐是常态，见「数据维护命令」）。

`flock`(deploy.sh 内) 防并发：轻量若撞上未跑完的全量会自动跳过。日志按 full/light 分桶轮转。改 cron 用 `fcrontab -` stdin 灌入（直接 `fcrontab 文件` 在无 tty 下会段错误）。wrangler OAuth 过期会让 CF 步失败 → 重 `wrangler login`。
> **传播**：`--data-light` 依赖主 checkout 已拉到含该 flag 的代码；首次 cron 触发时旧 `daily-refresh.sh` 会忽略参数跑全量，deploy.sh 自身 GitOps ff 更新工作树后，下一次轻量即生效（自愈）。

## 不变量 / 常见坑（改动前必读）

- **不要重新引入"线路质量"评分**（CN2/GIA 从境外回程 BGP 分不出）。只看 AS_PATH。
- **`origin asn` 仅展示**，不参与筛选/排序；永远叫 "origin asn"，不叫"回程 asn"。
- path 搜索是**连续相邻子序列**（`1299 23764 4809` ≠ `1299 4809`）。
- **RPKI 覆盖判定别写双不等式区间 join**（110万×93万会退化 nested-loop 卡死）——用 `rpki.classify` 的分桶等值 hash join。
- ASN 命名/分组改 **`ipcollect/data/asn_registry.csv`**（不在代码里）；改 `name_en` 需重 `export-parquet` 才进 meta。
- 改 `mrt_collectors` 后**必须重 `ingest`**。
- **前端改 `ipcollect/web/*` 后必须 `npm run build`**（`ipc build` 会跑）才进 dist；**改 `CHANGELOG.md` 也要重 build**（前端内联它）。
- **export 会先 `rmtree(dist/data/parquet)` 全部重写**（文件名/计数每次变，故 URL 带 `?v=` 失效）。
- `ipcollect.duckdb` 是中间态（已 gitignore）；`--reset` 清 obs/pathobs/prefix，**保留 geo/asn_dim/country_dim**。
- 多个性能关键点（pathsearch/byorigin/prefixes 的**单线程排序写 + 区间索引文件级裁剪**）：改导出分片逻辑前先读 `parquet_export.py` 与 `db.js` 的 `*FilesForRange/Origin`，**别改成多线程并行写**（会令区间重叠、裁剪失效）。

## CHANGELOG 约定

仓库根 `CHANGELOG.md` 是单一数据源（前端构建期内联）。**只记面向用户的功能性变更**（中英双语，最新在上，`## YYYY-MM-DD` 分组）；纯维护/重构/数据刷新/基础设施变更不记。改它要重 build。

## 在不烧资源的前提下验证

- **JS**：`node --check`；**前端**：`npm run build` + `ipc serve` 肉眼看。
- **Python**：`./ipc <cmd> --help`、`python -c "from ipcollect import ..."`、只读查询直接跑。
- **避免重下 400MB RIB**：库已存在就直接用；试 ingest 逻辑用 `--mrt-file cache/mrt/bview.*.gz` 或 `--limit`。

## 记忆

项目背景、设计取向、"仅 agent 维护"等见 `~/.claude/projects/-home-aosc-test-ip-collect/memory/`（`MEMORY.md` 为索引）。
