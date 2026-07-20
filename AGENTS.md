# AGENTS.md — PEER.AS 维护 & 部署指南

> **本项目今后只由 agent 维护。本文件 = 入口 + 架构 + 部署流程的权威概览**，默认读者是一个**无任何先验上下文**的 agent。
> **只记不易过时的骨架**（项目是什么、模块分工、怎么部署、不可破坏的不变量）；**实现/设计细节随源码与 `docs/` 走，不在此复述**。
> 架构或部署流程有变更时同步更新本文件。（README 面向人类、偏介绍；本文件面向 agent、偏操作。）

## 项目是什么

自研 CLI `ipc`（python 包 `ipcollect/`，用同目录 `.venv`）+ 纯静态 Web 看板 **PEER.AS（全球 BGP Insights）**。

从 **4 个公开全表采集点**（RIPE RIS `rrc01`/`rrc06`/`rrc03` + RouteViews `route-views2`）
及可选的 **AS4837 美国私有视角** MRT（IPv4+IPv6）静态分析回程 AS_PATH，
**入库 = 全球全部 v4+v6 前缀**（不按 ASN/国家过滤），用 **DuckDB 工作库**去重，导出 **Parquet** 数据集，
**DuckDB-WASM 在浏览器里直查静态 Parquet**（全 GET 整片下载、无 Range、无后端）。

- **中间库 = DuckDB**（`ipcollect.duckdb`，跑完即弃，已 gitignore；SQLite 已退役）。
- **地理以 geo 库为准**（不靠前缀首 IP）：三轨合并为非重叠区间——`ipdb`（私有，CN 城市级）+ `GeoLite2-City`（非 CN 全球城市级）+ `rir`（国家级兜底）。
- 设计契约/踩坑见 **`docs/DUCKDB_V6_REFACTOR.md`**、`docs/GLOBAL_DESIGN.md`、`docs/RPKI_IRR_RESEARCH.md`、`docs/RDAP_WHOIS_RESEARCH.md`。

## 运行入口

仓库根用 `./ipc <子命令>`（启动器自动走 `.venv`、加载 gitignored `.env`，数据/缓存落本目录）。主要子命令：
`init`/`config`/`geo-import`/`ingest`/`export-parquet`/`build`/`sync-web`/`serve`。
（查询类 CLI 已退役；调试直接用 DuckDB 查工作库或 parquet。）

## 架构 / 文件地图（`ipcollect/`）

- `cli.py` — `ipc` 子命令入口（argparse）。
- `config.py` — `DEFAULT_CONFIG` + `load/save`；`mrt_collectors`/`geolite_*` 等集中在此。`asn_registry` 唯一权威源 = `ipcollect/data/asn_registry.csv`（CSV，可直接 PR，改即生效、不写回 config.json）。
- `bgp.py` — AS_PATH 清洗/邻接、ASN 命名、`path_contains_seq`（**连续子序列**）。
- `mrt.py` — 流式 MRT RIB 解析（v4+v6，含未压缩 `.mrt`）+ 断点续传下载；自动选 RIS/RouteViews/私有 AS4837 布局；`ingest()` 去重写工作库。AS4837 的 URL/Basic Auth 只走 `.env`，首跳本地 ASN 65311 在入库前剥离。
- `store.py` — **DuckDB 工作库**：连接、`obs`/`meta` 表、CSV 流式灌入、`finalize`（去重 → `pathobs`/`prefix`）。
- `geoip.py` — GeoLite 过期检查/下载、`build_geo`（三轨合并非重叠区间 + AS org）、按 family 内存 bisect 的 geo 索引。
- `parquet_export.py` — **主发布步骤**（`ipc export-parquet`）：读工作库出两套 Parquet（`prefixes`/`paths`/`pathsearch`/`byorigin`/`geo` 等，v4+v6）+ `asnames.json`/`asnorg.json` + `meta.json`，调 `ssg`，拷前端。
- `ssg.py` — **sitemap 索引 + 分片(ASN/AS-SET/入口, 带 hreflang)+ robots**(旧的 /c/*.html 国家落地页已废弃)。`parquet_export` 另产 `data/seo/{asn,asset}.json`(边缘 SSR 紧凑数据)。
- **边缘 SEO SSR(自托管于 CN VPS, fail-safe)**: `web/src/seo/`(`*.Seo.svelte` + `strings.js` + `worker.js`,**单向依赖**:`*.Seo.svelte`/`strings.js` 零 app 依赖;`worker.js` 仅额外引 `../lib/icons.js`(纯 FA re-export、零浏览器依赖、tree-shake 只带 iSpinner))→ `vite.ssr.config.js` 打成 `dist/_worker.js`(CF Workers advanced-mode 格式的单文件 ESM bundle,**但运行时不在 CF——由 VPS 上的 Node 跑,见下条**)。爬虫访问 `/<asn>`/`/asset/<key>`/入口页 → 注入 `#seo-shell`,SPA 启动后 `App.svelte` 按 id 移除接管(同 URL)。前缀不做 SSR。
  - **`#seo-shell` 两层(一份 HTML 两类受众, 靠"盖"不靠"换")**:`.seo-bot`=给爬虫的真内容(h1/摘要/内链/事实, **正常渲染不 display:none** → 非 cloaking, 同一份 HTML 发所有 UA)+ `.seo-load`=不透明加载罩盖在上面(复用 app `.boot` 观感:mono+accent spinner+该路由 `cta` 文案, 主题 token 内联自 app.css)。人类只看到 loading 罩(loading→内容, 不闪);不跑 JS 的爬虫读源码 `.seo-bot`;跑 JS 的(Googlebot)JS 一到就揭罩见 SPA。旧版整屏"内容文档"覆盖层已废弃(SPA 接管时海外首屏会闪不同内容)。`/networks` 国家目录内链不放第一屏:在 `.seo-bot` 内 + 左侧 `Sidebar.svelte` footer(`features.geo` 门控)。
  - `scripts/build-ssr.sh` 永远 exit 0:失败/缺依赖只跳过(不产 `_worker.js`)→ 退化为纯静态 + SPA-200 回退,**绝不阻断部署**。(同一份 bundle 现由 CN VPS 的 `peeras-ssr.service`(Node)自托管运行,见下条;Caddy 自身不跑 Worker。)
  - **SSR 改为「CN VPS 自托管」(2026-06-18,不再跑 CF Pages Function)**:CF 上 SSR 已下线(GPTBot 把每个 ASN 落地页打成一次 Pages Function invocation,免费版 10万/天配额被爬满;peer.as 是 custom-domain 无 WAF 可拦)。现 **peer.as → CF for SaaS(`opentrace.app` zone 自定义主机名)→ 回源 CN VPS**,VPS 用 **Node 跑同一份 `_worker.js` bundle**(`peeras-ssr.service` → `deploy/ssr-server.mjs`,听 `127.0.0.1:8788`,数据走本地盘环回);**Caddy 把 SEO 路由(`@seo`)reverse_proxy 到它**(见 `deploy/cn.peer.as.Caddyfile`)。`build-ssr.sh` **仅 `cn_mirror`=peeras 时建 bundle**,`deploy_cn_frontend` 自动 scp 到 `/opt/peeras-ssr/` + `restart peeras-ssr`(见「部署 SOP」)。**dn42**(无 cn_mirror、不要 SEO)→ 不建 bundle,SSR 全关。CF 上 peeras 只剩 `data.peer.as`(数据项目)。CF 端 cache-all 须排除 `/dns-query`/`/whois`/`/cdn-cgi` 且 Edge TTL「尊重源」(否则 `meta.json` no-cache 被缓存死、`/cdn-cgi/trace` 地理探针被缓存乱)。
  - **/networks 国家分流目录(SEO 内链枢纽)**:`/networks`(国家网格)→ `/networks/<cc>[/<page>]`(该国 ASN 列表,500/页,链到 `/<asn>`)。由 `_worker.js` 渲染**独立目录页(非 SPA 外壳,双语 `?lang`)**,数据 `data/seo/networks.json`(export 从 autnums 末段 CC 建 asn→国家)。首页(EntrySeo + SPA WhoisView)有可见入口链接;sitemap 收录全部。**`/networks*` 与所有 SEO 落地页一样由 VPS 自托管 SSR(`peeras-ssr.service`)渲染**,Caddy `@seo` reverse_proxy 到 `127.0.0.1:8788`(取代旧的反代 CF Worker)。
  - **OG 大图(社交分享卡)**:VPS 自托管 SSR(`peeras-ssr`)给 ASN/AS-SET/入口页注入 `og:image`,**用品牌域 `peer.as/og/*`**(2026-06-18 从 cn.peer.as 改回;VPS 现为唯一源,且经 CF for SaaS 还吃边缘缓存)→ **CN VPS 上的 Pillow 渲染器**(`deploy/og-renderer.py`,systemd `og-renderer.service`,监听 127.0.0.1:8092,Caddy 反代 `/og/*`)。它读本机 `/var/www/cn/data/{seo/*.json,asnames.json,meta.json}` 画 1200×630 PNG(ASN 卡含 IPv4/IPv6/Peers + 右下角「最新采集点快照时刻」;中文用 Noto Sans CJK SC),磁盘缓存 systemd `CacheDirectory=/var/cache/og-renderer`(**不可放 /var/www/cn —— 会被 deploy rsync --delete 清掉**;按源 JSON mtime 失效)。`asn.json` 含第 3 元素 peers(来自 asn_neigh)。**手动部署**(同 Caddyfile,deploy.sh 不管):改 `og-renderer.py` 后 `scp 到 /opt/og-renderer/ && systemctl restart og-renderer`;改 Caddyfile 后 `scp 到 /etc/caddy/Caddyfile && caddy validate && systemctl reload caddy`。dn42 已无 SSR(不渲染落地页)→ 不出 `og:image`。
- `rpki.py` / `irr.py` / `asset.py` — 路由起源验证（RPKI ROA / IRR route / IRR as-set 锥）。导出期预计算成静态列/数据集，前端零后端查询；`meta.has_*` 缺失即前端降级。
- `peeringdb.py` — CAIDA PeeringDB dump → 静态 Parquet：ASN PeeringDB 画像、IXP/IXLAN/交换网段、ASN-at-IXP、facility presence。原始 dump 只落 `cache/peeringdb/`，发布只出裁剪后的 `data/parquet/peeringdb/*`；`meta.has_peeringdb` 缺失即前端隐藏 IXP/PeeringDB 入口。
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
./ipc ingest --reset            # 下载 4 个公开全表源 + 已配置私有源的最新 RIB，v4+v6 入 DuckDB
./ipc ingest --only route-views2 # 增量: 只重灌列出的采集点(其余 obs 保留, finalize 仍全量合并)。需先 --reset 打底
./ipc export-parquet --out dist # 工作库 -> dist/data/parquet + meta.json + SSG（约 3-5min）。主发布步骤
./ipc build                     # 只改前端时: npm run build + 拷 web/dist -> dist/（秒级, 不碰数据）
./ipc serve                     # 本地看站 http://127.0.0.1:8787/
```

- **ingest 按采集点并行解析**（进程池绕 GIL, fork 上下文; 子进程纯解析不碰 DuckDB, 父进程串行灌库）：
  多采集点墙钟 = 最慢单点(~12min) 而非相加。DuckDB 线程默认吃满核(`min(8,核数)`, 可 `IPC_DUCKDB_THREADS` 调小)。
- **AS4837 私有源**：`.env` 配 `IPC_MRT_AS4837_RIB_URL/USERNAME/PASSWORD` 即启用，`VERIFY=0` 为忽略私有 HTTPS 证书（默认）；公开 `meta.json` 仅显示 `AS4837` / `美国`，绝不输出 URL/凭据/内部采集标识。该源是 AS4837 专用视角（不是 DFZ 全表），只消费 `rib/`，不消费增量不连续的 `updates/`。
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
4. **从主 checkout** `cd /home/aosc/test-ip-collect && scripts/deploy.sh`。**数据/前端已解耦(peeras)成两条独立流水线 + 各自独立锁(互不阻塞)**：
   - **只动前端 → 无 flag**：`build`+`build-ssr`(SSR bundle 仅 `cn_mirror`=peeras 建)→ **只推 CN VPS**(`deploy_cn_frontend`：rsync 前端外壳 + scp `_worker.js`/`ssr-server.mjs` 到 `/opt/peeras-ssr/` + `restart peeras-ssr`)。**不再推 CF Pages 前端项目**(`bgp-insights` 已休眠)——peer.as 经 CF for SaaS 回源到 VPS,前端/SSR/外壳全由 VPS 提供。秒级、不被数据 cron 阻塞。**dn42**(无 cn_mirror、不要 SEO)→ 不建 SSR bundle,整 dist 推自己的 CF Pages(SSR 全关)。
   - **刷数据 → `--data`**(全量)/`--data-light`(增量, 需先 `--data` 打底)：`export-parquet` → 推**数据项目** `bgp-insights-data`(`data.peer.as`) + CN `/data`。**不碰前端**。
   - 脚本自己 GitOps ff、数据闸校验、CF+CN 并行、末尾校验(前端核入口一致；数据核 `meta.version`)。
   - **绝不在缺 `.env` 的 worktree 跑**（CN 凭据 + `VITE_DATA_BASE` 在 `.env`）；**绝不手敲 wrangler/rsync/手动 build**。
5. 成功 = 日志末尾 `完成 ✅`。dn42 由其自己的 10min cron 自动同步，无需手动。

> 纯文档/记忆类改动（如本文件）：走 1–3 即可，**不必跑 deploy.sh**。
> `scripts/deploy.sh` 是**唯一部署入口**。flag：`--data` / `--data-light` / `--no-build` / `--cf-only` / `--cn-only` / `--help`。

### 数据分发：数据 Pages 项目 + 前端自托管 CN VPS + CN 整站镜像

**数据是独立 Pages 项目;前端已迁到 CN VPS(2026-06-18,见上「边缘 SEO SSR」)**——两者部署独立,前端/SSR 部署不被 8h/2h 数据 cron 阻塞：

- **前端项目** `bgp-insights`(`peer.as`)：**已休眠(2026-06-18)**。peer.as 改走 CF for SaaS(`opentrace.app` zone 自定义主机名)→ 回源 CN VPS,前端/SSR/外壳全由 VPS(`peeras-ssr.service` + Caddy)提供;SSR 自托管见「边缘 SEO SSR」节 + `deploy/{ssr-server.mjs,peeras-ssr.service,cn.peer.as.Caddyfile}`。本 Pages 项目不再部署、无人引用(保留可回退)。
- **数据项目** `bgp-insights-data`(`data.peer.as`，CNAME→`bgp-insights-data.pages.dev`)：只含 `/data`(parquet/json/seo)，`_headers` 给 CORS `*` + 缓存(`deploy/data-headers`)。**同样 CF 边缘分发**(非单源，故不重蹈 R2 冷缓存覆辙)。

数据宿主**按用户位置在 `web/src/lib/db.js` 的 `configure()` 运行时选**(`OVERSEAS`=`VITE_DATA_BASE`，默认 `data.peer.as/data`)：
- **海外 = `data.peer.as`**(数据项目)。
- **境内 = `cn.peer.as`**(CN VPS 整站镜像，自带 `/data`)。
- **直连 cn.peer.as / GeoDNS→CN 机器 / 本地 serve = 同源 `/data`**(本机即正确源)。
  - **位置判定靠 `/cdn-cgi/trace`(不再靠 404)**:CF 与 CN Caddy 都返回 200+`loc=XX`,但 **CN Caddy 额外回一行 `edge=cn`**(real CF 永不返回)。`configure()`:host 是 cn.peer.as / localhost → 直接同源;否则探 trace —— 见 `edge=cn` → 同源(GeoDNS 已解到本机);real CF 且 `loc=CN` → 健康探测后切 `cn.peer.as`;否则海外。`web/src/lib/geo.js` 的 `fetchTrace` 也改走同源命中此端点(原 `default.peer.as` 子域已下线)。**部署顺序**:改了 `cn.peer.as.Caddyfile` 要**先 scp+reload VPS**再推前端,否则新前端遇旧 Caddy(仍 404)会把境内 GeoDNS 用户误判成海外。
- 取数失败统一回退 `OVERSEAS`(data.peer.as)。**自托管 SSR 的 `_worker.js`(peeras, 跑在 VPS)读 VPS 本地 `/data`**(`env.DATA_ORIGIN` 环回, 不跨源拉 data.peer.as);dn42 已无 SSR。

**数据版本/缓存**：`meta.version` 驱动 `?v=` 失效；`meta.json` no-cache。
**CF Pages 限**(数据项目)：≤25MiB/文件、≤2万文件(当前 961 parquet / 最大分片 <25MiB)；逼近时用 export 的 `*_FILE_SIZE` 旋钮切更细分片。
> 早期(2026-06-15)试过 R2 当天回退(单源拉取缓存→各 POP 冷回源慢)；现在的「第二个 Pages 项目」是多边缘分发，无此问题。`.env` 里 R2 时代遗留的 `VITE_DATA_BASE=peer-as-data.opentrace.app`(死域名)已改为 `data.peer.as`。

### 中国优化（cn.peer.as）

一台优化线路 VPS（Caddy）托管整站（前端 + 数据 + 自托管 DuckDB-WASM + SSR）。**2026-06-18 起这台 VPS 是前端的唯一源**：境内经 GeoDNS 直连本机、海外经 CF for SaaS 回源本机(故下面「前端部署 → rsync」既服务境内、也是海外的回源)。`deploy.sh` 的 CN 步分两路：`--data*` → rsync `dist/data` 到 `cn:/data`；前端部署 → rsync 其余(排除 `/data`) + 推 SSR bundle 到 `/opt/peeras-ssr/` 重启服务。GeoDNS 把境内 `peer.as` 解到本机（需本机有 peer.as 的 TLS 证书，LE 走 DNS-01；CF for SaaS 回源也用同一张证书,SNI=peer.as）。Caddy 还反代 `/og/*`(本机 og-renderer)、`/networks*` 及所有 SEO 路由(`@seo` → 本机 `peeras-ssr` Node SSR, `127.0.0.1:8788`)、DoH/WHOIS。
DuckDB-WASM、Cache Storage 大 wasm 缓存、parquet 扩展自托管、全 GET 模式、Caddy 配置（CORS、关 h3、DoH/WHOIS 境内反代）等实现细节较多且稳定，**见 `web/src/lib/db.js` 与 `deploy/cn.peer.as.Caddyfile` 源码**，不在此复述。

### cron 自动刷新（全量 8h + 轻量 2h）

`scripts/daily-refresh.sh`（fcron 薄封装）把参数**原样透传** deploy.sh（无参 = `--data` 全量）。**解耦后 `--data*` 只刷数据项目(data.peer.as)+CN /data，不动前端**；前端随代码改动单独 `deploy.sh`(无 flag) 部署。两条 peeras cron 行：

- **全量** `40 0,8,16 * * *  …/daily-refresh.sh`（每 8h，对齐 RIPE RIS bview UTC 00/08/16 + 40min）。
- **轻量** `40 2,4,6,10,12,14,18,20,22 * * *  …/daily-refresh.sh --data-light`（其余偶数点 +40min，每 2h 刷 route-views2，对齐 RouteViews 2h RIB）。
  净效果：**route-views2 / 已配置 AS4837 视角 ≤2h 新鲜，RIS 视角 ≤8h**（采集点发布周期不同，时龄不齐是常态，见「数据维护命令」）。

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
- **PeeringDB 是自报数据，不是 BGP 观测事实**：可用于 ASN/IXP 展示、筛选和共同 IXP 候选提示；不得把共同 IX、端口速率或 policy 字段当作 AS_PATH 邻接/上下游判定证据。
- 多个性能关键点（pathsearch/byorigin/prefixes 的**单线程排序写 + 区间索引文件级裁剪**）：改导出分片逻辑前先读 `parquet_export.py` 与 `db.js` 的 `*FilesForRange/Origin`，**别改成多线程并行写**（会令区间重叠、裁剪失效）。

## CHANGELOG 约定

仓库根 `CHANGELOG.md` 是单一数据源（前端构建期内联）。**只记面向用户的功能性变更**（中英双语，最新在上，`## YYYY-MM-DD` 分组）；纯维护/重构/数据刷新/基础设施变更不记。改它要重 build。

## 在不烧资源的前提下验证

- **JS**：`node --check`；**前端**：`npm run build` + `ipc serve` 肉眼看。
- **Python**：`./ipc <cmd> --help`、`python -c "from ipcollect import ..."`、只读查询直接跑。
- **避免重下 400MB RIB**：库已存在就直接用；试 ingest 逻辑用 `--mrt-file cache/mrt/bview.*.gz` 或 `--limit`。

## 记忆

项目背景、设计取向、"仅 agent 维护"等见 `~/.claude/projects/-home-aosc-test-ip-collect/memory/`（`MEMORY.md` 为索引）。
