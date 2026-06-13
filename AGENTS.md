# AGENTS.md — PEER.AS 维护 & 部署指南

> **本项目今后只由 agent 维护。本文件是唯一权威维护文档**：默认读者是一个**无任何先验上下文**的
> agent。请保证读完即可独立维护并发版；**任何改动后同步更新本文件**。
> （README 面向人类、偏介绍；本文件面向 agent、偏操作。）

本项目 = 自研 CLI `ipc`（python 包 `ipcollect/`，用同目录 `.venv`）+ 纯静态 Web 看板
**PEER.AS（全球版 BGP Insights）**。从 **4 采集点**(RIPE RIS `rrc01`/`rrc06`/`rrc03` + RouteViews `route-views2`，按名自动选布局) MRT **全表(IPv4+IPv6)** 静态分析回程 AS_PATH，
**入库 = 全球全部 v4+v6 前缀**（不按 ASN/国家过滤，focus_* 仅作高亮/导航），用 **DuckDB 工作库**去重，导出
**Parquet** 数据集（v4 + v6 两套），**DuckDB-WASM 在浏览器里查询静态 Parquet**（全 GET 整片下载、无 Range，无后端），部署到 Cloudflare Pages。
**重构细节见 `docs/DUCKDB_V6_REFACTOR.md`（DuckDB+v6 设计契约, 含踩坑记录), 旧版见 `docs/GLOBAL_DESIGN.md`。**

> 规模实测(2026-06 四采集点 rrc01/06/03+route-views2)：**1.13M v4 + 0.26M v6 前缀 / 95.9M 去重路径**（含 prepend）。
> 对比双采集点(rrc01+rrc06, 50.5M 路径)：可见 AS 邻接边 +22%、distinct path +90%、前缀 +2%；下载/库各约 ×2.4/×2.8。
> **中间库 = DuckDB**(`ipcollect.duckdb`, 跑完即弃, 已 gitignore；SQLite 已退役)。
> **IP 列用 `UHUGEINT`**(无符号 128 位, 同时容纳 v4/v6；**比较要 `::UHUGEINT` cast**, 否则 DuckDB 推断成有符号
> HUGEINT 会让 v6 溢出)。**4 字节 ASN(>2^31)用 BIGINT**，勿用 INT32。
> **地理以 geo 库为准**（不靠前缀首 IP）：ingest 不打 geo；导出时按 geo **切成各国家/城市子段**(carve, 已算成 CIDR 串)，
> 前缀出现在它覆盖的每个地区里。geo 三轨合并为**非重叠**区间：`ipdb`(私有, **CN 城市级**) +
> `GeoLite2-City`(**非 CN 全球城市级**, 含 v4+v6) + `rir`(国家级开放兜底)；另 `GeoLite2-ASN` 出 AS organization。

## 脱敏约定（重要）

本仓库面向公开/可镜像，**不得提交任何密钥或机器特定敏感信息**：
- **密钥/账户**：Cloudflare account id、API token 等一律走环境变量（见 `.env.example`），不写进任何提交文件。
- **`config.json`**：已 gitignore（仅本机配置，无密钥）；提交的是 `config.example.json`。
- **geo 库**：私有商业库 `ipdb.txt` 已 gitignore，**不可随仓库再分发**；路径可用 `IPC_IPDB_PATH` 覆盖。
- **`.wrangler/`**：已 gitignore（含 account id 缓存）。
- 已移除「存活探测」整套（Shodan + ICMP/TCP probe）；勿再引入第三方密钥依赖。

## 架构 / 文件地图（`ipcollect/`）
- `cli.py` — `ipc` 子命令入口（argparse）。**只保留部署/处理快捷入口**：`init`/`config`/`geo-import`/`ingest`/
  `build`/`export-parquet`/`sync-web`/`serve`。**查询入口(query/stats/insight/geo-lookup)已退役**(source of
  truth = 原始 MRT, 调试直接用 DuckDB 查工作库或 parquet)。
- `config.py` — `DEFAULT_CONFIG` + `load/save`；`asn_registry`/`mrt_collectors`(=`[rrc01,rrc06,rrc03,route-views2]`)/`routeviews_base_url`/`geolite_*` 集中在此，
  `load()` 时调 `bgp.set_registry()` 灌入。
- `bgp.py` — AS_PATH 清洗(`clean_path` 折叠 prepend, **仅供搜索/邻接/展示**, 入库去重不再用它)、ASN 命名（运行时由 config 灌入）、`path_contains_seq`（**连续子序列**）、`resolve_asns`。
- `mrt.py` — 自写流式 MRT RIB 解析(v4+v6)；下载**断点续传+重试**；`collector_source()`/`latest_bview_url()` 按采集点名自动选 **RIS(`rrc*`, gz) / RouteViews(`route-views*`, bz2, `bgpdata/<月>/RIBS/`)** 布局(月份目录往回找避开空未来月)；`ingest()`：遍历 `mrt_collectors`,
  收全表 v4+v6, Python 端按 **(prefix, path_raw)**(含 prepend)去重写 `obs`(带 path_clean+collector), 末尾 `store.finalize()` 跨 collector 合并出
  `pathobs`/`prefix`。ingest 前先 `geoip.ensure_geolite`(过期才下) + 缺/更新时 `build_geo`。`--family 4/6` 调试限族。
- `store.py` — **DuckDB 工作库**(取代 SQLite)。`connect`(套 IPC_DUCKDB_* + cache/duck_tmp 溢出)、`obs`/`meta` 表、
  `ObsWriter`(CSV 流式写)+`load_csv`(read_csv+`::UHUGEINT` cast 批量灌)、`finalize`(GROUP BY 去重 → pathobs/prefix + pid)。
  `util.uhuge_halves` 拆 hi/lo 两个 UBIGINT 取(避开 UHUGEINT→python 慢转换)。
- `geoip.py` — `ensure_geolite`(查 GitHub release tag, 过期才下 GeoLite mmdb)、`build_geo`(ipdb CN + GeoLite 非 CN
  合并非重叠 geo + `coalesce_geo` 合并同城段 + `asn_dim`(org) + `country_dim`)、`GeoIndexDuck`(从 DuckDB 按 family
  内存 bisect, hi/lo 快载)、`carve_cc(start,end,cap)`(超大聚合前缀退化国家级单段防炸)。旧 `import_ipdb/GeoIndex`(读
  SQLite) 仍在但新管线不用。
- **`parquet_export.py`** — `ipc export-parquet`：直接读 DuckDB 工作库(无 ATTACH)，按 family 出**两套** Parquet
  (`prefixes{,_v6}`/`paths{,_v6}`/`pathsearch{,_v6}`/`geo{,_v6}/<cc>`)+ `asnames.json`/`asnorg.json` + `meta.json`，调 `ssg`。
  v4 IP 列导 BIGINT、v6 导 UHUGEINT；segs **预算成 CIDR 串列表**(前端直接显示, 不必对 v6 做 BigInt)；代表 cc 走 ASOF join。
  `_forest_duck`/`_subtract`/`_segments_duck` 是 carve(纯 Python, 位宽无关)。`copy_web()` 只拷前端。**主战场**。
- **`ssg.py`** — 每国家双语 SEO 落地页 `c/<cc>.html` + `countries.html` + sitemap/robots；`_origins` 读导出期建的 `pgeo`。
- `serve.py` — 本地 debug 静态托管(支持 Range)；`--rebuild` 只重拷前端(数据需 `export-parquet`)。
- **`rpki.py`** — RPKI ROA 路由起源验证(RFC 6811)。`refresh`下载 VRP(peeras=Cloudflare `rpki.json`/dn42=registry max-length)→
  `cache/rpki/vrp.csv`；`attach`建 `vrp` 表；`classify`用**按前缀长度分桶 + 物化候选键的等值 hash join**(切忌写双不等式区间
  join, 110万×93万会退化成 nested-loop 跑不完, 详见 `docs/RPKI_IRR_RESEARCH.md`)产 `rpki_status(pid,origin,rpki)`。
- **`irr.py`** — IRR route/route6 对象登记态。`refresh`流式解析各 RIR 的 gzip RPSL dump(精确前缀+origin)→
  `cache/irr/route.csv`；`classify`产 `irr_status(pid,origin,irr)`(present/mismatch/not-found)。
  **RADB 走 NRTMv3 增量镜像**(`nrtm.radb.net:43`, 本机直连免注册): 首跑/断档 FTP 全量 bootstrap(+读 `RADB.CURRENTSERIAL`
  定精确 serial 无缝衔接), 之后 `!jRADB` 取区间→`-g RADB:3:<上次+1>-<当前>` 拉 ADD/DEL 增量, 应用到持久化
  `cache/irr/{radb.objects.csv,radb.serial}`。取代旧的每轮 37min 全量 FTP(降到增量 ~1-5min / 无变化 ~5s);
  必须见完整 `%START…%END` 才提交 serial(防截断丢尾), 落后 >30k op 则重 bootstrap。
- **`asset.py`** — IRR as-set 客户锥层级树。`refresh`解析 as-set 对象的一级 `members:`(ASN/子 as-set)→ `cache/asset/`
  三 CSV(as_set 头 / as_set_member 一级边 / as_memberof 反查)；**绝不预展开**(最大锥 10万+ ASN)。
  **下载走 `util.download_file`(支持 http(s) + ftp)**: RADB 只有 `ftp://`(requests 不认 ftp://)。
- (已删) `db.py`/`report.py`/`build.py` —— SQLite schema / CLI 查询渲染 / 旧 JSON 导出, 随 SQLite 退役删除。
- **`web/`** — 前端 = **Vite + Svelte 5 项目**(不再是裸 JS)。`src/App.svelte` + `src/components/*`(Sidebar/
  Topbar/Results/InsightDrawer/PathGraph/AboutModal/AsnTag/AsPath/Field + **AsnDetail/Whois/WhoisEntity/WhoisRow**
  + **DnsView/DomainDetail**(DNS 解析视图 + 域名详情面板) + **Doodle**(首页 3D 地球 hero) + **SelfProbe**(首页「你的接入」自助探测卡片))
  + `src/lib/*`(store.svelte.js 全局 runes 状态、db.js DuckDB-WASM、queries.js 搜索/insight/**asn 视图+dns 视图+面板导航**+
  **probeIp**(给定 IP → 覆盖前缀/origin/观测上游, 供 SelfProbe)、
  bgp.js(含 `classifyQuery` 的 **domain** 分支 + `isDomain`)、**geo.js**(Tier-1 城市坐标 + cloudflare trace + **probeEgressIps** fetch 二十多个开放-CORS 边缘端点 cdn-cgi/trace+upyun 摸全部出口 IP；旧 jsonp/probeSelfIps 保留未用)、
  i18n.js、icons.js Font Awesome、ui.js + **rdap.js**(RDAP 直连,
  含 **domain** 域名查询)、**rdap-bootstrap.json**(内置 IANA asn/ipv4/ipv6/**dns** 表)、**dns.js**(DoH 解析)、
  **whois-fields.js**(字段→图标) + **clock.svelte.js**(模块级 $state `now` 每 30s 自走; `genAgo(ts)` 出"x小时x分前"、`genUtc(ts)` 出 UTC 串, 供侧栏/移动菜单「生成」时间显示相对时间 + hover UTC))。`web/mock/rdap/`=离线开发用真实 RDAP 样本(不进 bundle)。
  Console 暗色设计 + **系统默认字体**(勿强制自定义 web 字体, 中文会糊) + FA 图标 + teal/amber。**改完要 `npm run build`**(产出 `web/dist/`),
  `export-parquet` 再把 `web/dist/` 拷进 `dist/`。`web/test-e2e.mjs` = puppeteer-core 无头冒烟测试(用系统 Chrome)。

## 数据表（DuckDB 工作库 `ipcollect.duckdb`，`store.py`/`geoip.py` 建）
- `obs` — ingest 中间观测(每 collector 去重后的 (prefix,path) 行 + n_peers + collector)；finalize 后可弃。
- `pathobs`(pid + 去重 AS_PATH + n_peers, 跨 collector 合并) · `prefix`(每前缀 + pid + ip_start/end `UHUGEINT` +
  family + 代表 origin(`arg_max` peer 数最多者) + `n_origins`(distinct origin 数, MOAS>1) + n_paths) ·
  (导出期 `prefix_origins`: 每**多源**前缀的全部 origin + 各 peer 数 → prefixes 的 `origin_asns`/`origin_npaths` 数组列) ·
  `geo`(非重叠区间 + family + cc/prov/city + provider) · `country_dim`(cc→zh/en 名) ·
  `asn_dim`(asn→org) · `meta`(kv, 含 `geo_tag` GeoLite 版本)。导出期还建临时 `pgeo`(前缀+代表 cc, ASOF)。

所有命令在仓库根目录下用 `./ipc <子命令>`（启动器自动走 `.venv`，数据/缓存落本目录）。

---

## 配置（config.json，集中维护、勿 hard code）

```bash
./ipc config show
./ipc config set mrt_collectors rrc01,rrc06   # set 写字符串值; 列表/对象直接手改 config.json
```

- 入库口径固定为**全球全表**（收全部 v4+v6 前缀，不按 ASN/国家过滤）；无 `focus_*` / `ingest_scope` 之类开关。
- `asn_registry`：ASN→`{name, name_en?, op}`（展示/下拉/着色用）。**唯一权威源 = `ipcollect/data/asn_registry.csv`**
  （CSV，可直接 PR；`#` 开头行为注释），`config.load()` 每次读 CSV 灌入 `bgp` 模块、覆盖 `config.json` 里的任何残留表。
  CSV 改了即时生效——`save()` **不**把 `asn_registry` 写回 `config.json`（避免冻结 CSV）。
  `name`=中文/主展示名、`name_en`=可选英文别名（i18n，缺省时英文界面从 `name` 滤出拉丁部分兜底，如 `电信CN2→CN2`）；
  `op`=运营商/厂商分类：三大运营商有专属配色（电信/联通/移动），其余 `教育/科技/国际/IDC`（IDC=云/主机厂商，无专属配色）；
  新增 op 值会优雅降级（前端 `bgp.js` 的 `OP_CLS` 无该项=无配色、`OP_EN` 无该项=回退中文原值），要配色/英文名再补 `bgp.js` 两表。
  export 把 `name`→`meta.asn_names`、`name_en`→`meta.asn_names_en`、`op`→`meta.asn_ops`。
- **三层命名分工**（前端）：① **运营商/承载网**（curated `name`+`op`，用于路由列表/AsPath/probe origin）；
  ② **AS Name 原始 handle**（`asnames.json`/APNIC，便于搜索消歧，在 ASN detail 与 WHOIS 突出）；
  ③ **IP 所属组织**（前缀 inetnum 持有者，**RDAP 实时**，`rdap.js` 的 `holderOrg(prefix)`，在 prefix detail/SelfProbe 显示，
  可能是承载 AS 的下游企业，**与 origin ASN 不是一回事**；GeoLite `org`=AS 级组织，**不是** IP 级持有者，别混用）。

---

## 站点 Profile / Feature Flags（多站点维护：peer.as + dn42）

本代码库可服务多个站点（`peeras` = 全球公网 PEER.AS；`dn42` = dn42 fork，无地理）。**维护铁律：站点差异
一律用「配置开关关成 no-op」实现，绝不靠删代码分叉**——这样主站演进时 dn42 永不冲突，「改一处两边同步」才成立。

- **后端**：`ipcollect/profile.py` 定义 `PROFILES`（每站一套开关）+ `features(cfg)` 访问器。
  `config.json` 的 `"site"`（默认 `"peeras"`）选定 profile；`"features": {...}` 可逐项覆盖单个开关（无需换 site）。
  **`peeras` = 现状全开**；新增任何开关，其 peeras 默认值**必须复现当前行为**（否则即回归）。
- **开关清单**（`profile.py`）：`geo`（geo 管线总开关：geoip ensure/build、export carve + 国家 SSG、前端地区导航）、
  `cn_mirror`（部署 cn.peer.as 镜像）、`whois`（前端 whois 后端 rdap/registry，`Whois.svelte` 据此选源）。
- **已接线的接缝**（peeras 默认值下行为不变，已实测一致）：
  - `mrt.py` ingest：`features["geo"]` 为假则跳过 GeoLite/geo 构建。
  - `parquet_export.py`：`geo_on = features["geo"]`；为假时 pgeo 不连 geo（cc/省/市 NULL→下游 `'ZZ'`）、跳过 carve
    `_carve_geo_dirs`、无 geo 目录、无国家/城市 meta、无国家 SSG。**carve 已抽成 `_carve_geo_dirs` 单独函数**（geo profile 才调）。
  - `scripts/deploy.sh`：开头算 `CN_MIRROR`（读 profile，失败回退 1）；为 0 时跳过 `deploy_cn` 与 cn.peer.as 校验。
  - **前端** `web/src/lib/site.js`：`SITE = import.meta.env.VITE_SITE || 'peeras'` + `features`（geo/rdapWhois/dns/**cnMirror**/**whoisView**）。
    组件按 `features` 分支：`Topbar`（geo→国家/城市；!geo→**person 选择框**，列表 `meta.persons`，值=nic-hdl）、
    `Whois.svelte`（rdapWhois→在线 RDAP；否则 `lib/registry.js` 读静态 JSON）、`queries.js`（!dns 时域名走
    `runDomainWhois`=registry 域名 whois 而非 DoH；person 选定→其 origin ASN 集合走全表 origin 过滤，复用 `pathsearchFilesForOrigins`）。
  - **顶层视图开关 `whoisView`（peeras 开 / dn42 关）**：`S.view`（`'routing'`|`'whois'`）= 侧栏「路由分析 / 首页」切换的顶层视图。
    **peeras 落地页 `/` = WHOIS 首页**（`WhoisView.svelte`，「注册局卷宗」气质：命令行式输入 → 复用 `Whois.svelte` 渲染 record，支持
    ASN/IP/前缀/域名）；**路由分析落地页让到 `/advanced`**（`ROUTING_HOME`）。**只动落地页**——`/​<asn>`、`/<prefix>`、`/dns/x`、
    `/asset/x`、`/?q=`、`/whois/<q>` 路径解析全不变。侧栏 `nav_whois` 标签 = 「首页」。UI 只用「WHOIS」概念、不暴露 RDAP（协议类型仅在结果
    「来源」行 `Whois.svelte` `.wsrc` 注明：RDAP / WHOIS / dn42 registry，路由详情面板同样生效）。
    路由在 `queries.js`：`applyRoute`（`/`+无`?q` 或 `/whois[/<q>]` → whois；`/advanced` → 路由空落地页）、`runWhois`、`setView`、`hardCloseDetail`。
    **WHOIS 框搜 as-set / 名称等非 WHOIS 对象 → `runWhois` 直接转 `openInRouting`（路由分析）**。结果卡片底部「查看更多信息」也走 `openInRouting`。
    **「高级搜索」开关**（`S.advWhois`，localStorage `ipc-adv-whois` 记忆，示例行最右的迷你 switch）：勾上后提交层（`WhoisView`）把**任何**查询都走
    `openInRouting`、不出简洁 WHOIS（开关判定只在 UI 提交层，不在 `runWhois`，免得 `/whois/x` 深链/popstate 被劫持）。**dn42 `whoisView:false`** →
    侧栏不出导航项、`/` 仍是路由空落地页、`App` 不渲染 `WhoisView`（组件仍打包，纯 no-op）；域名/ASN 注册信息照旧由详情面板 registry whois 提供。
    左上 LOGO（侧栏 + MobileBar）= `goHome()`：peeras 回 WHOIS 首页 `/`、dn42 回路由 `/`，均清详情/筛选/结果。
  - **首页 hero：3D 地球 doodle + 「你的接入」自助探测卡片**（均仅 WHOIS 首页空状态显示，出结果随 hero 收起淡出）。
    `Doodle.svelte`：纯装饰 3D 地球，起点 = cloudflare trace 的连接 IP+国家（`geo.js fetchTrace`/`ccLatLon`/`TIER1_GEO`），
    用 `queries.routeTier1s` 算「你自己」这条 IP 的 Tier-1 路由图，加载一次、之后不重渲染；点节点/卡片 = 快速查询。
    背景全屏 3D 立体字 `PEER.AS` 在 `WhoisView` 内（鼠标视差 + 入场淡入 + 出结果淡出）。
    `SelfProbe.svelte`：用 **`geo.js probeEgressIps()`**（`fetch` 一批**开放 CORS** 的边缘端点 = 二十多个站点的
    `cdn-cgi/trace`(取 `ip=`) + upyun `pubstatic.b0.upaiyun.com/?_upnode`(取 `remote_addr`)，各带 7s AbortController 超时、失败静默）
    取各端点看到的客户端 IP，**去重并按 family 分组、按出现频次排序**（多 WAN/多出口/happy-eyeballs/CDN 不同 PoP 会让不同站看到不同出口
    → 借此摸出你**全部接入出口**；返回 `{v4,v6,defaultIp}`，defaultIp=被最多端点看到者=浏览器主用栈）。每族至多取 4 个 IP，
    再用 **`queries.probeIp(ip)`** 富集（覆盖前缀 + 地理 `loc` + origin ASN+名）。**`probeSelfIps`(test-ipv6.com JSONP) 仍在但 SelfProbe 已不用。**
    形态 = **单一舞台、持久 DOM**：所有卡片是同一批元素、从不重新生成；两态（叠 collapsed / 摊 expanded）都由 `styleFor()` 算出每张卡的
    `transform`（绝对定位 + `left:50%` 居中，故列宽变化不跳），靠 CSS transition 平滑过渡。叠态 = 左 v4 / 右 v6 两堆真层叠（depth≥2 透明藏底），
    点堆 `cycle()` 切下一张（`front` 取模）；第一张带 `[+N IP]` 角标。摊态（`S.probeExpanded`，箭头 `toggleExpand` 切）= 同一批卡按
    `transition-delay` 错峰飞向**网格（一行≤4、定宽 300px 居中、用满 col 宽）**，v4/v6 同时开发；收回即逆过程。出口卡右下角 `.famtag`
    色标注明 IPv4/IPv6（非活跃栈=灰、`defaultIp` 所属活跃栈=淡橙 `#cf9f63`；**摊开时每张都标, 折叠时仅第一张**）；折角钮**独立隐藏 IP**（`hide=[v4,v6]`，
    localStorage `ipc-hide-self-ip`，仅叠态可见）。`S.probeExpanded` 在 `runWhois`/`goHome` 复位；摊开时 `WhoisView` 让 `.col` 放宽
    （`.col.wide`，但搜索框/示例/`.hero` 仍锁 820 居中——`.hero` 不锁宽则地球 canvas 的 ResizeObserver 会重置 WebGL 闪一下）。
    探测/富集失败静默退化，不阻塞首页。`enrichIp` 回传 `cc/city/province`（DNS 视图无害忽略）。
  - **WHOIS 兜底文本解析 = `web/src/lib/whois-labels.js`**（独立文件）：无 RDAP 的 ccTLD 经 whois-worker 取回 port-43 原文后，
    把各注册局列名映射到统一规范 key。含**标签字典**（实测 + richardpenman/whois、mboot-github/WhoisDomain 两解析器的逐 TLD 字面量）
    与**多格式解析器**（inline `Label: value` · JPRS 括号 `[Label] value` · RPSL `key:` · Nominet/.it/.dk/.eu 缩进段 indented-block），
    日期归一化 `fmtDate` 也在此（rdap.js 改为 import）。`rdap.js` 的 `doFetch`/`whoisFallback` 调 `parseWhois()`；新增 ccTLD 列名只改这一个文件。
  - **DuckDB 引擎懒加载（`db.js` `ensureEngine()`）**：WHOIS 视图纯 RDAP/网络、不需引擎，故 `App.onMount` **不再 eager `initDuck`**——
    只做 `configure`+`meta.json`+注册 popstate/Esc，然后 `applyRoute`。引擎（34MB DuckDB-WASM + 全量 asnames/asnorg）改由 `ensureEngine()`
    **首次进路由分析时才加载**（幂等缓存 promise；置 `S.ready`/`S.loading`，失败置 `S.fatal`）。触发点：`applyRoute` 路由分支、
    `setView('routing')`、`openInRouting()`。**直开 `/whois` / 首页 `/` 不阻塞于引擎**（`onMount` 早判 URL 即切 `S.view='whois'`、`loading=false`，秒出查询壳）。
    **落地 WHOIS 时空闲静默后台预载引擎**（`onMount` 末 `requestIdleCallback → ensureEngine()`，不阻塞首屏/RDAP；之后切路由分析无感秒开；
    WHOIS 视图忽略 `S.loading` 故预载期间无感）。`fatal` 已挪进 store（`S.fatal`），meta 失败不再 early-return（不阻断 WHOIS 视图）。
  - **结果表分页 + CSV 导出（仅 `global`/`country`/`subnet` 表格模式）**：`statusline`（Topbar）同行最右 = 分页器（`gotoPage(±1)` 翻页，
    `OFFSET=page*limit` 由 `runSearch(true)` 复用整套搜索逻辑重查；新搜索 `S.page` 归 0）+ 导出按钮。`S.page`/`S.more` 在 store。
    导出：`runSearch`/`runSubnet` 把查询片段缓存进 `_tableQuery`（`{src,where,cols,order,cc}`；domain/asset/dns 置 null → 按钮不可用），
    `ExportModal` 经 `exportColumns()` 列出当前可导出列（按 `cols` 串 + meta 门控：前缀/origin/AS名/国家/位置/plen/路径数/RPKI/IRR/MOAS/最优路径/覆盖网段），
    勾选后 `exportCsv(keys)` 去 offset、`LIMIT EXPORT_CAP`(10万) 取**全量**当前搜索结果，带 BOM 下载 UTF-8 CSV。值从结果行/廉价派生(AS名、placeLabel)。
  - **本地 worktree 预览数据**：`dist/data` 与 `dist/parquet` 等只在主 checkout（`ipc build` 仅拷前端壳、不动数据）。在 worktree 里
    `ipc serve` 会因缺 `/data/meta.json` 报「Unexpected token '<' … not valid JSON」。修复：`ln -s 主checkout/dist/data` 与 `…/dist/duckdb-ext`
    进 worktree 的 `dist/`（静态服务即时生效，刷新浏览器即可）。
  - **前端 CN 分流必须 site-aware（踩过坑，2026-06 修）**：`db.js` `configure()` 在 `!features.cnMirror` 时**直接同源返回、不做任何
    `/cdn-cgi/trace` 探测/切数据**。否则境内用户访问 dn42.peer.as → trace=CN → 健康探测 `cn.peer.as/data/meta.json` 通 → 把 `DATA`
    切到 `cn.peer.as/data`，**而 cn.peer.as 只镜像 peeras 全球数据集**（geo/多分片），dn42 前端（无 geo/单分片/person 导航）拿到错
    meta/parquet 直接炸。`cn_mirror` 是后端部署开关，**必须同步透传到前端 `features.cnMirror`**（新增 CN 镜像类站点开关时记得两侧都加）。
  - **文案 / 品牌**：`web/src/lib/i18n.dn42.js`（dn42 专属字符串覆盖，i18n.js 在 `SITE==='dn42'` 时 merge 进 STRINGS）；
    logo/品牌在 `site.js` 的 `brand`（peeras=PEER.AS / dn42=DN42.PEER.AS），`Sidebar`/`MobileBar` 据此渲染。
    `bgp.js` 的域名判定按 `SITE` 选正则：dn42 用 `DOMAIN_RE_DN42`（TLD 允许字母开头的字母数字，认 `.dn42`）。

### dn42 站（Phase 2 已实现）

**数据源**：MRT = `https://mrt42.strexp.net/master4|6_latest.mrt.bz2`（bz2，无月份目录，`mrt_layout="dn42"`）；
registry（全量 whois）= git 仓 `registry_repo`（`cache/dn42-registry`，clone/pull）。dn42 全在 clearnet，**采集不需隧道**。
- `ipcollect/registry.py`：RPSL 解析 → ASN 名（aut-num.as-name）、ASN→person（aut-num.admin-c，兜底 mnt-by→mntner.admin-c）、
  person 显示名；`export_dn42()` 写**逐 ASN 静态 whois** `data/registry/autnum/AS<n>.json`（与前端 `rdap.normalize()` 同形：
  head 行 + admin/tech/mnt 实体树）+ 算 `meta.persons`（按前缀数降序）与 `meta.asn_person`。
  **域名 whois**：`export_dn42` 还把全量 `dns/` 对象写成 `data/registry/domain/<zone>.json`（同形, nserver 作 head 行）；
  前端输入 `*.dn42` → `fetchRegistry('domain',…)` 逐级回退到登记的 zone。
- `mrt.py`：`mrt_layout="dn42"` 直取 master4/6 bz2（`_open_mrt` 按扩展名选 bz2/gz）；GRC 每前缀经上千 peer ⇒ 每前缀
  ~2000 条 AS_PATH（paths/ 按 `PATH_CAP`=128 取 top-N，pathsearch/pp 有界）。
- **按 person 筛选取代国家**：无 geo；前端选 person → 用其 ASN 集合过滤 `pathsearch`（origin_asn IN）。

#### dn42 部署（独立 checkout + 同一份脚本）

部署脚本（`deploy.sh` / `vendor-duckdb-ext.sh` / `daily-refresh.sh`）**PROJ 均从脚本位置推导、不写死**，且 deploy.sh
**site-aware**：开头读 `config.json` 得 `site`/`cn_mirror`/`cf_project`/host(=site_base)，据此 `export VITE_SITE`、
选 CF 项目、决定是否部署 CN、校验哪个域名。故 **peeras 与 dn42 各自一个 checkout，跑同一份 deploy.sh**。
- **dn42 实例（已建并在跑）** = git worktree `/home/aosc/dn42-peer-as`，分支 `dn42-prod`（跟踪 origin/main）。
  **代码自动同步（GitOps）**：`deploy.sh` 开头(flock 前)会 `git fetch + merge --ff-only origin/main`，有更新则 re-exec 应用新版本
  → **改代码只需 `commit + push origin main`，两站 cron/手动部署自动拉新代码**，无需再手动 ff/reset dn42-prod。
  （ff-only 仅快进、不覆盖本地提交；分叉/离线只告警不阻断；`config.json` 是 gitignored 本地文件不受影响。
  应急手动同步仍可 `git -C /home/aosc/dn42-peer-as fetch && git reset --hard origin/main`。）`.venv` 与 `ipcollect/web/node_modules` 软链到主
  checkout 复用依赖（无需重装）。实例 `config.json`：`site=dn42`、`cf_project=dn42-peer-as`、`mrt_layout=dn42`、
  `mrt_base_url=https://mrt42.strexp.net`、`mrt_collectors=["mrt42"]`、`registry_repo=…`、`site_base=https://dn42.peer.as`、
  `asn_registry=[]`。
- CF 项目 `dn42-peer-as`（已建）+ 自定义域名 **`dn42.peer.as`** 已绑定生效（deploy verify 的入口一致 + parquet 扩展 wasm 均 ✓）。
- 跑：实例目录 `scripts/deploy.sh --data`（≈3min：ingest ~131s + export + build + wrangler 上传）；cn_mirror=0 ⇒ 只上 CF。**线上正常**。
- **cron 每 10min（已装，见 `fcrontab -l`）**：`*/10 * * * * REFRESH_KEEP=144 /home/aosc/dn42-peer-as/scripts/daily-refresh.sh`
  （对齐 dn42 GRC 10min 发布；与 peeras 8h 并存，各自 `flock`(各自 logs/deploy.lock) 互不阻塞；改 cron 用 `fcrontab -` stdin 灌入）。
- **未做 / 可改进**：IP/前缀的 registry whois（route/inetnum 长前缀匹配；现仅 ASN + 域名 whois，IP 占位）、
  按 ASN/person 的 SSG 落地页、dn42 DNS 的 DoH 实时解析（现为 registry whois，无 A/AAAA 记录解析）、
  index.html 静态 `<title>` 仍是 peeras（运行时 `document.title` 已按 profile 改；SEO 预渲染未做）。

---

## 数据维护流程

### 0) geo 库（**通常不用手动跑** —— ingest 会自动检查 GeoLite 是否过期并按需重建 geo）
```bash
./ipc geo-import                      # 手动重建 geo: ipdb(CN城市)+GeoLite2-City(非CN全球,v4+v6)+asn_dim(org)
./ipc geo-import --force-download     # 强制重下 GeoLite mmdb(忽略本地版本戳)
./ipc geo-import --no-geolite         # 只用 ipdb(CN), 不叠 GeoLite
```
GeoLite mmdb 缓存在 `cache/geo/`(+ `geolite.version` 戳)。**首次 geo-import 较慢(~11min: 遍历 5.8M 段 + 非重叠合并)**, 只在 GeoLite 更新时重跑。

### 1) 全表 ingest 最新 RIB（4 采集点, v4+v6）
```bash
./ipc ingest --reset                  # 下载 rrc01/06/03(RIS,gz ~350/40/310MB)+route-views2(RouteViews,bz2 ~75MB) 最新 RIB, 全表 v4+v6 入 DuckDB; 约 40-45 分钟
# 复用本地已下: ./ipc ingest --reset --mrt-file cache/mrt/<file>.gz   # 单文件, 调试
# 只收某族: ./ipc ingest --reset --family 6
```
入库 = **全球全部 v4+v6 前缀**(不过滤)。ingest 会**先检查 GeoLite 过期**(过期才下), geo 表缺失或 GeoLite 更新时
自动 `build_geo`(否则复用; `--reset` 只清 obs/pathobs/prefix, **不清 geo**)。改采集点(`config mrt_collectors`)需重 ingest。

### 2) 导出 Parquet + SSG（主发布步骤）
```bash
./ipc export-parquet --out dist       # DuckDB -> dist/data/parquet/*(v4+v6) + meta.json + SSG(c/<cc>.html…), 约 3-5 分钟
```
注意: duckdb 溢出目录走真盘(`cache/duck_tmp`; /tmp 是 tmpfs/RAM 会 OOM)。内存紧可设
`IPC_DUCKDB_MEM=8GB IPC_DUCKDB_THREADS=2`。**v6 的 128 位别直接取进 Python**(慢)/取进前端(丢精度)——见 `docs/DUCKDB_V6_REFACTOR.md §8`。

### 2.5) 只改前端（免重导出）

前端代码改完、**数据(parquet/meta/SSG)没变**时，不必跑耗时的 `export-parquet`，一条命令搞定：
```bash
./ipc build             # = npm run build(ipcollect/web) + 拷 web/dist -> dist/; 不碰数据。日常改前端就用它
./ipc build --no-npm    # 跳过 npm、只拷已构建的 web/dist(等价旧 sync-web)
./ipc sync-web          # 同 --no-npm: 只拷 web/dist -> dist/(web 已 build、不想重跑 npm 时用)
```
`ipc build` 跑 Vite 构建再调 `parquet_export.copy_web`(清旧 assets, 保留 `data/` 与 SSG)；秒级。
**仅当 ingest/数据/geo/SSG 变了才需要重新 `export-parquet`。** 本地预览同理：`ipc build` 后 `./ipc serve` 刷新即生效。

### 3) 查 / 看（调试）
CLI 查询入口已退役。调试直接用 DuckDB 查工作库或产物 parquet:
```bash
.venv/bin/python -c "import duckdb;c=duckdb.connect('ipcollect.duckdb',read_only=True);\
print(c.execute('SELECT family,count(*) FROM prefix GROUP BY family').fetchall())"
# 或对导出的 parquet: duckdb -c "SELECT * FROM read_parquet('dist/data/parquet/prefixes_v6/*.parquet') LIMIT 5"
```
本地看站: `./ipc serve` 后浏览器开 http://127.0.0.1:8787/(支持 Range, 与生产一致)。

---

## 更新日志（CHANGELOG，重要约定）

仓库根 `CHANGELOG.md` 是**单一数据源**：网站「更新日志」弹窗由前端 `?raw` 直接 import 它（构建期内联，
见 `web/src/components/ChangelogModal.svelte`），故**网站与仓库永远一致，改一处即可**。
- **每次新增/改动「面向用户的功能」都必须在 `CHANGELOG.md` 顶部追加一条**（中英双语，最新在上，按日期分组）。
- **纯维护性改动不写**（重构、依赖升级、数据每日刷新、文档/措辞、性能调优等无可见行为变化的）。
- 格式跟随现有条目即可（`## YYYY-MM-DD` 分组 + `- **新增/改进：…**` 列表项）。改了它前端要重新 `npm run build`。

## 部署 SOP（每次部署看这一节就够，别再通读下方长清单 / `deploy.sh`）

**目录分工（机器上现状）：**
- **别在这两个"部署目录"里开发**（都挂 cron，保持 `git status` 干净）：peeras 主 checkout `/home/aosc/test-ip-collect`(branch `main`)、dn42 `/home/aosc/dn42-peer-as`(branch `dn42-prod`)。
- **日常开发 worktree = `/home/aosc/test-ip-collect-dev`(branch `dev`)**：已建好并软链 `node_modules`/`dist|public 的 data`/`duckdb-ext`/`.env`/`.venv`，可直接 `npm run dev`、`npx vite build`。

**部署五步：**
1. 在 dev worktree 改完 → `git add` **只加改的源文件**；**绝不 `git add -A`**（`public/data`、`public/duckdb-ext`、`.venv` 是本地 symlink，未 gitignore 但**不该提交**）→ commit。
2. `git fetch origin` → 确认能快进：`git merge-base --is-ancestor origin/main HEAD`。不能（origin/main 被 dn42 提交推进、已分叉）→ `git rebase origin/main`（可能撞 `AGENTS.md`/`db.js`，解冲突）。
3. `git push origin dev:main`。**GitOps 的唯一真源是 `origin/main`；不 push 到 main，线上 ≤8h 会被 cron 回滚。**
4. **从主 checkout** `cd /home/aosc/test-ip-collect && scripts/deploy.sh`：
   - 只动前端/代码 → 无 flag（复用现有数据）；改了数据/要全重推 v4+v6 → `--data`。
   - 它自己会 GitOps ff 到 origin/main、`npm build`、数据闸校验、推 **CF + CN** 两端、末尾核两端入口一致。
   - **绝不在缺 `.env` 的 worktree 跑 deploy.sh**（CN 静默跳过→两端 meta 不一致）；**绝不手敲 wrangler/rsync/手动 build**。
5. 成功 = 日志末尾打印 `完成 ✅`（含「✓ peer.as 入口一致」「✓ cn.peer.as 入口一致」）。**dn42 站由它自己的 10min cron 从 origin/main 自动同步，无需手动部署。**

> 纯文档/记忆类改动（如本文件）：走 1–3（commit + `push origin dev:main`）即可，**不必跑 deploy.sh**（不进 dist、不影响站点）。
> 需要排错或细节时，再往下读「部署注意事项(踩坑清单)」与「构建 & 部署」。

## 构建 & 部署（Cloudflare Pages）

**唯一部署入口 = `scripts/deploy.sh`**。cron(daily-refresh)、手动改完推送、开发全重推数据/只动前端 **全走它同一段部署核心**，
调用即得一致结果。**勿再手敲 `wrangler pages deploy` / `rsync` / 手动 build —— 那正是导致部署不一致事故的根源。**
**维护改动：直接跑 deploy.sh 推，无需再确认（用户已授权直接推）。**

### 部署注意事项（踩坑清单，部署前必读）
- **GitOps 推送前先 rebase 到 `origin/main`**：deploy.sh 开头会 `git fetch + merge --ff-only origin/main`，cron(peeras 8h)
  与 dn42 实例(10min)都从 `origin/main` 拉代码。`origin/main` 可能已被 **dn42 的提交推进**，本地分支会**分叉、无法 ff-push**。
  流程：`git rebase origin/main`(解 AGENTS.md/db.js 等共改文件的冲突) → 确认 `merge-base --is-ancestor origin/main HEAD` → `git push origin HEAD:main`。
  **必须 push 到 `origin/main` 才持久**，否则下次 cron(≤8h)会把线上回滚到旧代码。
- **从 git worktree 部署：除 data 产物外，`.env` 也必须 symlink**（最隐蔽的坑）。deploy.sh 的 **CN rsync 凭据
  (`CN_DEPLOY_SSH`/`CN_DEPLOY_PATH`)只在 `.env`**；worktree 缺 `.env` ⇒ **CN 步静默跳过、cn.peer.as 服旧数据，而 CF 照常成功**
  (wrangler 用 `HOME` 的 OAuth，不读 .env) ⇒ **两端 meta 不一致**。worktree 要复用主 checkout 时一并软链：
  `ipcollect.duckdb`、`ipdb.txt`、`config.json`、`.env`、`.venv`、`cache`、`ipcollect/web/node_modules`。
- **含完整 fresh dist 的 worktree 可直接 `deploy.sh`（无 --data）**：copy_web 保留 `dist/data`、只重 build 前端。
  （承接「deploy-from-main-checkout」记忆：关键是**该 checkout 必须有完整 dist/data**——主 checkout 或自己导出过数据的 worktree 都行；
  全新空 worktree 缺 data/SSG 会推残缺快照。）
- **部署后两端都要核**：`curl https://peer.as/data/meta.json` 与 `https://cn.peer.as/data/meta.json` 的 `version` 必须**一致**，
  且新特性标志(`has_rpki`/`has_irr`/`has_asset`/`has_asn_neigh`)符合预期。**peer.as 入口 hash 校验的 ⚠ 多是 CF 传播延迟**(秒级)，
  稍后复查即一致；但 **cn.peer.as 入口/meta 不一致 = CN rsync 真没成功**(查 `.env`/SSH)，不是延迟。
- **改了 import 数据源/profile 开关影响 dn42**：rpki/irr/asset 的 dn42 路径(registry)若未充分验证，靠 export 里的 try/except
  降级(`has_*=False`)兜底，不会拖垮 dn42 刷新；但仍应留意 dn42 实例首轮日志。

```bash
# 改完前端 / 只动前端: build 前端 + 部署 CF+CN(复用现有数据):
scripts/deploy.sh
# 改了数据(ingest/geo/SSG) 或要全重推 v4+v6: 重导数据 + build + 部署:
scripts/deploy.sh --data
# 其它: --no-build(纯重新部署现有 dist) | --cf-only/--cn-only(只部署一端) | --help
```
deploy.sh 内部三段：**[--data 时] 数据 → 总是 npm build(ipc build) → 部署核心(CF + CN)**。**默认总是 npm build**
（消除"改了前端源却忘 build、部署旧前端"的事故类）。两段都用**并行 + 互锁(barrier)**:
- **数据段(--data)**: `ingest`(写 DuckDB) **∥** `rpki/irr/asset`(只写 cache、不碰 DuckDB)并行 —— ingest 前台(进度实时)、
  imports 后台(日志末尾回放)。互锁: **两 stage 都完成**才 `export-parquet`; ingest 失败=致命(先收编后台再中止)。
- **部署核心**: CN rsync(整站含 wasm、meta.json 最后传) **∥** CF `wrangler pages deploy` 并行, 互锁等两端结束再 verify。
  CF 用**硬链接暂存株**(`cp -al` 整 dist 到同盘临时目录、删副本 >25MiB wasm 再 deploy；真 `dist/` 全程不动 →
  与 CN rsync 无竞争、wrangler 失败也不伤 dist)。CN best-effort(失败回退 CF), CF 失败=中止；末尾校验两端入口一致 + wasm/扩展自托管。
凭据：wrangler OAuth(HOME)、`.env` 的 `CN_DEPLOY_SSH`/`CN_DEPLOY_PATH`。首次/换机若缺前端依赖：`(cd ipcollect/web && npm ci)`。

部署事实：
- **品牌/域名**：**PEER.AS**，主域名 **https://peer.as**（用户自有域名）。`site_base` 已设为 `https://peer.as`
  （SEO canonical/sitemap/SSG 用）。`peer.as` 作为**自定义域名**绑在下面的 Pages 项目上。
- **Pages 项目**：`bgp-insights`（项目内部名不变，与主站 `opentrace` 分开；`bgp-insights.pages.dev` 仍为部署目标/备用）。
- **绑定自定义域名**(在 CF 控制台/或有 DNS 权限的 token 做)：Pages 项目 `bgp-insights` → Custom domains → 加 `peer.as`
  + 在 DNS 加 CNAME/记录指向 `bgp-insights.pages.dev`。**wrangler 部署 token 无 DNS 写权限**，此步需在控制台手动。
- **凭据**：CF account id / API token 通过环境变量(`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`)
  或 `wrangler login` 提供；`.wrangler/` 与 `.env` 均已 gitignore，**不得写进提交文件**。
- 前端是 Vite+Svelte 编译产物(`web/dist/`)拷进 `dist/`；CF Pages 侧无构建命令；`./ipc serve` 仅本地 debug。
- **全 GET / 缓存（关键）**：前端跑**全 GET 模式**(`db.js` `forceFullHTTPReads`，详见下「中国优化」)，每个 parquet
  分片只发一条普通 `GET`(200, 无 HEAD/无 Range)。**不再依赖 CF 边缘 Range/206**(那只在自定义域名 `peer.as` 生效、
  `*.pages.dev` 常回 200 全量)——本就用不到 Range 部分读(裁剪在文件级做)。关键是让这些 200 响应**可长期缓存**:
  `web/public/_headers`（Vite 拷进 `dist/`）把 `/assets/*` 与 `/data/parquet|prefixes/*` 设长缓存(max-age=1y)、
  `/data/meta.json` 设 `no-cache`、`/data/asnames.json` 长缓存(显式列, 别用 `/data/*.json` 否则会和 meta.json 规则叠加)。
  200 + 不可变 `?v=` URL + 长缓存 ⇒ **100% 落浏览器磁盘缓存**，二次访问/会话内重复查询零网络。改 `_headers` 后重新 deploy 即可。
- **数据版本 / 缓存失效（关键）**：parquet/json 路径固定(`prefixes/data_4.parquet`)但内容每次 export 都变 ⇒ 固定 URL +
  长缓存会让浏览器/CDN 读到**过期分片**(曾导致高位 prefix 搜不到、隐私窗口却能搜到)。修复：`meta.version`=文件清单+计数+ts
  的 sha1 短哈希；前端 `dv()`(db.js) 把 `?v=<version>` 拼到**所有** parquet/asnames URL 上(经 `rpList`)，数据一变 version
  变 → URL 变 → 旧缓存失效。`meta.json` 自身用 `cache:'no-cache'` 取且 `_headers` 也 `no-cache`(它是 version 源, 必须最新)。
  因此 parquet 可放心设 1 年长缓存。**改了数据务必重新 export(刷新 version)再 deploy**。

发版自检：
```bash
test -f dist/index.html && grep -oE 'assets/index-[^"]+\.js' dist/index.html   # 前端 bundle 已进 dist
curl -s -o /dev/null -w "%{http_code}\n" https://peer.as/                        # 或 bgp-insights.pages.dev
```

### 数据分发：同源 + CN 整站镜像（2026-06 起；**已弃用 R2**）

**为什么弃 R2**:DuckDB-WASM 前端实测**不发 Range、整片下载分片**(<25MiB 直接整取;本地带日志服务器 + 对生产用 CDP
抓 Web Worker 流量两路验证一致)。所以 R2 相对同源 Pages **无传输收益**,反而其公开 egress 是**被刷爆账单的风险**。
故移除 R2,数据全部**同源**。**真正决定每次查询下载量的是 meta 索引的文件级裁剪**(`read_parquet` 只取相关分片整下;
单查实测:小国 geo ~10KB、US ~44MB、**IP/CIDR 经 `prefixes_ip` 区间索引裁到 1 个 ~2MB 分片**(原恒读整套 ~24MB, 见前端要点)、
origin-ASN 经 `pathsearch_origin` 索引 ~1/N 分片、**纯 AS_PATH 无 origin = 最坏全扫所有 pathsearch**)。优化方向是"减少整下
字节"(更细分片 + 连续 ip_start/origin 排序 + 区间索引 + meta 文件级裁剪),不是 Range。

**两个独立整站,目录完全一致,任一域名都能用:**
- **`peer.as` = CF Pages**:`wrangler pages deploy dist` 部署前端 + `dist/data`(同源 `/data`)。海外主站。
- **`cn.peer.as` = CN 优化 VPS(Caddy)**:`deploy.sh` 的 CN 步 rsync **整个 dist(前端 + 数据 + 打包的 wasm)** 过去。境内主站。

**前端选源(`db.js configure()`,App.svelte onMount 最先调;无 `VITE_DATA_BASE` 了)**:
1. `location.hostname === cn.peer.as` ⇒ **同源相对**(数据 `/data`)。edge=cn。
2. 否则(在 CF Pages,或 GeoDNS 把 peer.as 解到 CN 机器):探同源 `GET /cdn-cgi/trace`(CF 才有)。
   - `loc=CN`(确在 CF Pages 且身处境内,即 **GeoDNS 没生效拿到 CF IP**)⇒ 健康探测 `cn.peer.as/data/meta.json`,
     通了把数据切到 `cn.peer.as`(**带回退**:不通则保持同源 CF)。edge=cn。
   - 否则(海外,或 GeoDNS 已把 peer.as 解到 CN 机器——此时 trace 取不到 ⇒ 当非 CN)⇒ **同源**(本机即正确源)。
   覆盖:`VITE_CN_BASE`(默认 `https://cn.peer.as`)。
   - 注:GeoDNS 把 peer.as 解到 CN 机器时,hostname 仍是 peer.as ⇒ 走分支 2 的"否则"= 同源(=CN 机器, 数据快)。
   - **wasm/worker 随构建打包(`/assets/*`,见下)**:CN VPS/本地同源托管完整 wasm ⇒ 国内零跨境;
     数据切 `cn.peer.as` 时 `wasmSrcs()` 让 wasm 优先走 CN 镜像同 hash 资产。**唯一例外**:CF Pages 单文件 ≤25MiB
     放不下 33/39MB 的 wasm(部署时从硬链接暂存株里删掉再传, 见 deploy.sh deploy_cf)⇒ **CF 节点的 wasm 回退外部 CDN**(jsDelivr→unpkg,见 `CDN_DIST`);
     worker(<1MB)与 JS API 仍同源。即:**国内主路径(CN VPS)完全自托管;CF 海外/直连节点的 wasm 走 CDN**。
     **坑**:CF Pages 对缺失路径回 SPA 200+HTML(非 404),故 CF 路径**不能**把同源 wasm 列入候选(否则 HTML 被当 wasm
     → instantiate CompileError);`wasmSrcs(sameOriginMissing=true && edge='cf')` 直接走 CDN, `cachedBlobURL` 另拒绝 HTML 响应双保险。
- **GeoDNS(运维侧,域名解析)**:境内 `peer.as` 解析到 CN 机器 IP、境外解析到 CF Pages。
  **前置(切 NS 前必须)**:CN 机器 Caddy 要能服务 `peer.as` 这个 Host **且有 peer.as 的 TLS 证书**——LE HTTP-01 会失败
  (海外验证者解析 peer.as→CF),需 **DNS-01**(或把 CF 的证书同步过去)。否则境内用户被 GeoDNS 引到 CN 机器时 TLS 握手失败。

**数据版本/缓存**:`meta.version` 仍驱动 `?v=` 失效(同源/CN 都生效)。Pages 侧 `web/public/_headers` 管缓存;
CN 侧 Caddy 管缓存(见下「中国优化」)。**数据变更:export → rsync CN + pages deploy**(daily-refresh 自动)。

### 中国优化（cn.peer.as）

**问题**：CF Pages 在中国大陆慢(anycast 跨境被限速/丢包，RTT ~450ms)。**方案**：一台中国优化线路的
VPS(DMIT LAX，`cn.peer.as`)用 **Caddy** 托管**与 peer.as 完全一致的整站(前端 + 数据 + 自托管 DuckDB-WASM)**。
分流见上「数据分发：同源 + CN 整站镜像」(`db.js configure()`)：直连 cn.peer.as / GeoDNS 把 peer.as 解到本机 ⇒ 同源;
GeoDNS 没生效拿到 CF IP 且 `loc=CN` ⇒ 切 cn.peer.as(带健康探测 + 自动回退)。**已弃用 R2,数据全部同源**。

**DuckDB-WASM vendored 打包(JS API/worker 零外部依赖;wasm 仅 CF 节点回退 CDN)**：`@duckdb/duckdb-wasm`
(版本钉 `DUCKDB_VER`)是 npm 依赖。`db.js` 顶部用 Vite **`?url`** 引入 4 个资产(`duckdb-{mvp,eh}.wasm` +
`duckdb-browser-{mvp,eh}.worker.js`)⇒ Vite 输出**带内容 hash 的独立资源**到 `dist/assets/`(不内联进 JS)。
JS API 经 `await import('@duckdb/duckdb-wasm')` 打成**同源惰性 chunk**(`duckdb-browser-<hash>.js`,~46KB gz)。
`selectBundle` 仍按浏览器特性挑 mvp/eh(其内置 `getJsDelivrBundles` 因走手动 bundle 而成死代码、不触发)。
**wasm 托管的硬约束**:**CF Pages 单文件 ≤25MiB**,而 eh/mvp.wasm 达 33/39MB ⇒ CF 部署时**把这俩 wasm 从硬链接暂存株里删掉再传**
(`pages deploy` 不认 `.assetsignore`;deploy.sh deploy_cf: `cp -al` 整 dist→删副本 wasm→deploy 该副本→删副本, 真 dist/ 不动)。CF 节点的 wasm 经 `wasmSrcs()` 的
`CDN_DIST`(jsDelivr→unpkg, 官方原名)回退取。**CN VPS(Caddy 无限制)同源托管完整 wasm**,国内主路径完全自托管、
不碰 CDN;worker(<1MB)与 JS API 任何路径都同源。**注意 CF SPA-200 坑**:CF 对缺失路径回 200+HTML(非 404),
故 CF 路径不把同源 wasm 列入候选(`edge==='cf'` 直接 CDN),`cachedBlobURL` 另拒绝 `text/html` 响应作双保险。

**+ Cache Storage(核心修复)**：`duckdb-eh.wasm` 解压 **34MB**,**超出 Chromium HTTP 磁盘缓存单资源上限
(`max_size/8`) ⇒ 每次刷新都重下 ~8MB**。修法(`initDuck` + `cachedBlobURL`):`wasmSrcs()` 给出候选源(CN 镜像优先 →
同源 → CDN 兜底, 按序 fetch 首个成功即止)→ wasm/worker.js **存入 Cache Storage(无单资源上限)**,以 blob: URL 喂给 duckdb
(wasm blob 标 `application/wasm` 走 instantiateStreaming;worker.js 自包含,cached text 直接 `new Worker`)。
**首装后每次加载/F5 本地命中、零跨境**。键与宿主无关(`__duckdbwasm__/<variant>.*`),缓存名带版本
(`duckdb-wasm-<ver>-r3`)、升级 duckdb 自动弃旧。**Service Worker**(`public/sw.js`,VERSION 入 cache 名)只缓存同源壳
(HTML network-first 防陈旧 hash、`/assets/*` cache-first)，**放行 `*.wasm`/`*.worker-*.js`**(由 Cache Storage 管)与 /data GET、跨源。
**+ 全 GET 模式(关键性能, db.js `db.open({filesystem:{forceFullHTTPReads:true, allowFullHTTPReads:true, reliableHeadRequests:false}})`)**:
duckdb-wasm **默认**读 parquet 前发**同步 XHR 的 HEAD** 取文件大小/Range 支持(~200ms RTT, **顺序阻塞**, 内部
`enable_http_metadata_cache` 只在同会话内有效、刷新即失效) + 再发 Range GET。我们用不到 Range 部分读(分片裁剪已在
**文件级**做掉, 见下「数据分发」), 故开 `forceFullHTTPReads`(**需配 `allowFullHTTPReads:true`, 否则全 GET 分支不执行**)让
**每个分片只发一条普通 GET(200, 无 HEAD/无 Range)** → 消灭首屏串行 HEAD RTT 链; 且 200 + 不可变 `?v=` URL + `_headers`
长缓存(max-age=1y) ⇒ **100% 落浏览器磁盘缓存**, 二次访问/会话内重复查询零网络。**故 SW 不再需要 HEAD 缓存 hack**:
旧 `headCached`/`data-head-<VERSION>` Cache 已删, VERSION→`v4` 时 activate 顺带清掉历史 `data-head-*` 缓存。
**坏缓存防护(踩过坑)**:① `fetch` 一律 `{cache:'no-store'}` —— 否则 immutable 大 wasm 进浏览器 HTTP 缓存易截断/失败,
plain fetch 读回坏数据存进 Cache Storage → 持续空白;② `validBytes()` 字节级校验(wasm magic `00 61 73 6d`/worker 非空非 HTML),
读写 Cache Storage 都校验, 命中坏条目即 `cache.delete` 重取(自愈)。两者 + cache 名 bump 共同根治 SPA-200 HTML / 空 / 截断毒化。

**DuckDB parquet 扩展自托管**：`read_parquet` 会 autoload **parquet 扩展**(~3MB)，默认从 `extensions.duckdb.org`
跨境拉、首查卡 ~2s。改为自托管(`db.js setupExtensions`)：`SET custom_extension_repository` 指到同源(海外 CF /
本地 / CN 直连)或 CN 镜像(数据切 CN 时)的 `/duckdb-ext`，启动即 `INSTALL+LOAD parquet` 预热(首查不卡)。引擎按
`${repo}/<引擎版本>/wasm_<variant>/parquet.duckdb_extension.wasm` 取(版本引擎自填)。扩展文件 **vendor**(非 npm 自带)：
`scripts/vendor-duckdb-ext.sh` 下载 pinned 版(eh+mvp，gitignore 在 `public/duckdb-ext/`)→ vite → dist → 部署两端。
**带回退(坑, 2026-06 修)**：自托管源**确实**不可用(缺文件 / 被 CF 当 SPA 回 200 HTML)时才 `RESET` 回退官方源
(退化默认、不炸)。**关键**：eager `INSTALL parquet` 在 duckdb-wasm 浏览器端**可能偶发抛错(即便自托管源完全可用)**;
旧逻辑一抛错就**无条件 RESET 回官方源** → 随后 `read_parquet` 的 autoload 跨境拉扩展(= 「自托管又跨境」回归)。
现在 `setupExtensions` 在 eager 失败时**先探测**自托管扩展真伪(`selfHostExtBroken`: Range 取头几字节校验 wasm
magic `\0asm`, 上游忽略 Range 则读首 chunk 即 cancel, 不整下 3MB) —— **仅探测确认坏了才 RESET**, 否则保留自托管仓库,
autoload 自走自托管(不跨境, 仅首查略慢)。deploy.sh 部署后校验两端扩展返回 wasm magic(防 SPA-200)。
**初始化顺序(坑, 2026-06 修)**：`init()` 里 **`setupExtensions` 必须先于 `tuneSession`**。`tuneSession` 的
`SET parquet_metadata_cache=true` 是 **parquet 扩展注册的设置**，DuckDB 为满足该 SET 会 autoload parquet
(`PhysicalSet → AutoloadExtensionByConfigName`)；若此时仓库还没指到自托管，就跨境拉 `extensions.duckdb.org`
(与 `read_parquet` 的 autoload 是**两条独立路径**，上面的 RESET 探测管不到这条)。`setupExtensions` 先跑(已 `LOAD
parquet`)后该 SET 不再触发任何 autoload。**别把会触发扩展 autoload 的 `SET` 排在 setupExtensions 之前。**
**升级 duckdb 须同步重 vendor**(见下「升级」)。

**VPS 状态(已部署并实测，2026-06-01)**：Debian 12 / Caddy v2.11 / BBR+fq 已开 / 无防火墙。
- **HTTP/3 已全局禁用(只留 h1/h2，Caddyfile 顶部 `servers { protocols h1 h2 }`)**：中国对 UDP/QUIC
  做 QoS 限速，走 h3 反而更慢；本机仅服务 CN ⇒ 全局关即可(海外走 CF 不受影响)。关后不监听 UDP/443、不广播 alt-svc h3。
- 目录：`/var/www/cn/`(**整站**：前端 index.html + `assets/`(JS/CSS + **打包的 duckdb wasm/worker**,hash 名) +
  SSG `c/` + `data/`(parquet);全部 rsync 自 `dist/`,无需手动维护 wasm)。
  **Caddy 现需服务 `cn.peer.as` 与 `peer.as` 两个 Host**(GeoDNS 把境内 peer.as 引到本机);peer.as 证书走 DNS-01
  或同步 CF 证书(LE HTTP-01 会失败,见「数据分发」)。SPA 根 + `/data` + `/assets`。(旧 `/duckdb/` 已废弃。)
- 配置：`deploy/cn.peer.as.Caddyfile` → `/etc/caddy/Caddyfile`(Caddy 自动签 LE 证书)。**要点**：
  CORS `*` + Expose `Content-Range` 等 + OPTIONS 预检 204；`encode` **只排除 `*.parquet`**(它走 Range，压缩
  破坏 206)，**wasm 照压**(34MB→8MB，整块取非 Range)；`/assets/*`(含 hash wasm)/parquet 长缓存 immutable、meta.json no-cache。
  访问日志走 journald(`journalctl -u caddy`；systemd 沙箱下写 `/var/log` 被拒，故未用 file log)。
- **DoH / WHOIS 转发(境内连通性兜底)**:`route{}` 内加了两个反代 —— `/dns-query`→`cloudflare-dns.com`(同路径)、
  `/whois`→`peer-as-whois.archeb.workers.dev`(`rewrite * /`,worker 用 `?domain=` 查询)。境内直连 1.1.1.1 DoH 常被墙/污染、
  workers.dev 也不稳,故经本机(优化线对外网通畅)中转。前端 `dns.js`/`rdap.js` 在 `edge=cn` 时改打这两个端点(见
  `cnProxyBase()` @ `db.js`)。**防开放代理滥用**:两端点用 `header_regexp Referer ^https://(cn\.)?peer\.as(?:[:/]|$)` +
  互斥 `handle` 块,**仅放行 Referer 来自本站域名**,其余 403(浏览器对同源/跨我方域名请求都带 Referer,前端 fetch 另带
  `referrerPolicy` 保证)。两反代均简单 GET 无预检;站点 `header`(defer)把上游 ACAO 统一成单个 `*`。
- 实测：parquet 206+Range+CORS 不压缩；wasm `content-encoding: gzip` 下载 8MB；预检 204；h3 已禁用(无 alt-svc)；
  浏览器实测 F5 不再重下 wasm(命中 Cache Storage)、`?cc=CN` 查询 500 行正确。

**VPS 重建/维护**：
- 数据：`deploy.sh` 的 CN 步 rsync(`.env` 的 `CN_DEPLOY_SSH`/`CN_DEPLOY_PATH`；best-effort，失败不阻断)。
- 首次/换机装 Caddy：官方 apt 源装 `caddy`，scp `deploy/cn.peer.as.Caddyfile` → `/etc/caddy/Caddyfile`，
  `caddy validate && systemctl reload caddy`。DNS 须先把 `cn.peer.as` 灰云 A 记录指向本机(否则签证书失败)。
- duckdb wasm:**已随构建打包到 `/assets/`,随 daily rsync 自动更新**,VPS 无需手动维护。**升级 duckdb 版本** =
  ① `cd ipcollect/web && npm i @duckdb/duckdb-wasm@<VER>` + 改 `DUCKDB_VER`(db.js,驱动 `WASM_CACHE` 失效);
  ② **同步升 parquet 扩展**:改 `scripts/vendor-duckdb-ext.sh` 的 `EXTVER`(= 新版对应的**引擎版本**,如 v1.4.3) +
  `rm -rf ipcollect/web/public/duckdb-ext/`(让 deploy 重下新版;否则引擎请求新版本路径而文件是旧版 → 扩展加载失败、回退官方源);
  ③ 重新部署(`scripts/deploy.sh`,其 verify 会校验扩展确返回 wasm)。

### 自动化：每 8 小时自动刷新 + 部署（cron）

`scripts/daily-refresh.sh` 是 **fcron 的薄封装**（脚本名沿用 daily 是历史遗留，**实为每 8h 一次**）：只管日志文件 +
45 份轮转，实际 `exec scripts/deploy.sh --data`（= 清缓存 → `ingest --reset` v4+v6 → `export-parquet` → **npm build** →
部署 CF+CN）。**部署逻辑只在 deploy.sh 一处**，cron 与手动结果一致。**已弃用 R2**（数据全部同源，见「中国优化」）。
- **频率 = 每 8 小时**（本地 Asia/Shanghai `00:40 / 08:40 / 16:40`，条目 `40 0,8,16 * * *`）。这对齐
  **RIPE RIS bview 的 8h 发布节奏（UTC 00/08/16）+ ~40min 发布延迟**——bview 是数据源，跑更勤也不会更新（要更实时得改吃
  RIS update/RIS Live 增量流，是另一套有状态架构）。单轮 **~22min**(ingest∥下载、CN∥CF 并行 + RADB NRTM 增量后；
  首跑或 RADB 断档需 bootstrap 那轮 ~37min) ≪ 8h 间隔，`flock` 防并发足够。
- 安装/查看：`fcrontab -l`。改时间：编辑后 `fcrontab - < 文件` 重灌（**本机 setuid `fcrontab` 在无 tty/后台下
  `fcrontab 文件` 直接调用会段错误；必须用 stdin 形式 `fcrontab -`**）。注意 fcron **自解析引号**：命令里别写 shell 风格
  双引号（路径无空格就别加），否则该行被判 `Mismatched quotes` 静默跳过（acme.sh 续期那行曾因此失效，已去引号修好）。
- deploy.sh 要点（cron 与手动共用）：补 `PATH`(含 `/usr/lib/node-24/bin`) 与 `HOME`(wrangler 读 `~/.config/.wrangler`
  OAuth 凭据，自动续期)；加载 `.env`(CN_DEPLOY_*); `flock`(`logs/deploy.lock`) 串行锁防重 ingest 撕裂库；
  `--data` 时先清缓存(`cache/mrt/*.gz`+`cache/duck_tmp/*`，保留 `cache/geo`/`autnums.txt`)防撑爆硬盘。
- **每次都 `npm build`**（deploy.sh 默认）：保证部署前端永远是最新源码，根治"改了前端源却忘 build"的事故类。
  （历史坑：旧 daily-refresh 从不 build，前端要人工先 build —— 已废除。）
- 手动试跑全量：`scripts/deploy.sh --data`（约 22 分钟；RADB 需 bootstrap 那轮 ~37min）。日志：`tail -f logs/daily-refresh-*.log`。
- 凭据失效（OAuth 过期/换机）会导致 CF deploy 步骤失败：重跑 `wrangler login` 即可恢复。

---

## 前端要点（`web/` Svelte 源；改完要 `npm run build` + `ipc export-parquet` 才进 dist）
- DuckDB-WASM 在浏览器发 SQL over 远端 parquet(**全 GET 整片下载**, 无 Range; 见「中国优化」全 GET 模式)。**BigInt**：q() 只降顶层；嵌套 list<struct>
  (segs.s/e)要 `Number()`。i18n zh/en(`Intl.DisplayNames` + STRINGS), `?lang/?cc/?city` 深链。
- 搜索 = `geo/<cc>` 里 `paths_blob LIKE '% seq %'`(连续序列)；`best_path LIKE` 命中最优路径**置顶★**。
- **国家可不选 = 全表搜索**(读 `pathsearch`, 一行/前缀)：AS_PATH(`paths_blob LIKE`, 全表扫、较慢) 或
  **origin AS**(`origin_asn=X`, 精确)。选了国家则走 `geo/<cc>`(带城市级+本段)。
  (已移除「预制 path 下拉」与「kw 模糊搜索」，改为通用的 path 输入 + 精确 origin AS。)
- **pathsearch 按 origin_asn 排序 + 区间索引(关键性能)**：`pathsearch` 导出时**单线程 + preserve_insertion_order=true**
  按 `origin_asn` 排序写小分片(`PATHSEARCH_FILE_SIZE`=6MB)，meta 写 `files.pathsearch_origin`=每文件 `{f,lo,hi}`
  origin 区间(互不重叠)。前端 `pathsearchFilesForOrigin()`(db.js)据此让 **origin AS 搜索只 `read_parquet` 覆盖该 ASN 的
  那 1 个文件**(原来要扫全部 ~18 个/177MB → 现 ~7MB)；索引完整但无文件覆盖 = 该 origin 不存在, 直接空结果不发查询。
  **纯 AS_PATH(LIKE)搜索仍全表扫所有分片**(无法按子串裁剪)。单线程是必须的：多线程 COPY 写多文件不保证跨文件全局有序
  → origin 区间重叠 → 退化成多文件命中。
  - **`byorigin`(纯 origin 查询的精简版, 关键性能)**：pathsearch 里 `paths_blob` 占 ~90% 体积, 但**纯 origin 过滤根本不用它**。
    故另导一套 `byorigin{,_v6}` = pathsearch 去掉 `paths_blob`(只留 pid/prefix/cc/origin/n_origins/n_paths/is_primary/rpki/irr/best_path),
    同构 `files.byorigin_origin` 区间索引。`originAsns && !hasPath`(ASN/名称/person/MOAS, 不含 AS_PATH 子串)走它 →
    文件数/footer ~10×↓(v4 ~185MB/25 文件 → ~17.5MB/~3 文件)。含 AS_PATH 子串/纯 path 搜索仍走 pathsearch。
    前端 `byoriginFilesForOrigin(s)`(db.js), 门控 `meta.has_byorigin`(缺=回退 pathsearch)。
  - **`origin_counts`(每 origin 通告前缀数预聚合)**：跨 family 单小文件 `(origin_asn, n_v4, n_v6)`(<1MB)。
    `showAsn` 计数 O(1) 直读, 免运行时对分片 `SUM` 聚合。门控 `meta.has_origin_counts`(缺=回退分片聚合)。
  - **MOAS 多行(关键)**：pathsearch 现按 **(前缀, origin)** 每 origin 一行(以前每前缀只留代表 origin)，故按**任一** origin
    搜 AS / 看「该 AS 通告的前缀」都能命中多源前缀。`is_primary` 标记代表 origin 那行：纯 AS_PATH 搜索 + `scanNeighbors`
    加 `is_primary` 去重回每前缀一行(防重复/重复计数)；按 origin 搜索不去重(要的就是该 origin 行)。门控 `meta.has_moas`。
    体积影响小(MOAS 占 ~0.84%, 行数 +~0.9%)。
- **prefixes 按 ip_start 排序 + 区间索引(关键性能, 同 pathsearch 思路, **仅 v4**)**：`prefixes` 导出**单线程 +
  preserve_insertion_order=true** 写小分片(`PREFIX_FILE_SIZE`=2MB ⇒ ~11 个连续 ip_start 区段文件)，meta 写
  `files.prefixes_ip`=每文件 `{f,lo,hi}`(min ip_start / max ip_end)。前端 `prefixesFilesForRange(start,end,v6)`(db.js)
  让**精确 IP / 子网 / 父子段查询只 `read_parquet` 与 [start,end] 相交的那 1 个文件**(实测单 IP 查 ~2MB, 原恒读整套
  ~24MB → **降 ~12x**, 0 漏)。**单线程是必须的**：多线程并行写令各文件 ip_start 不连续、跨满全表 → 区间退化成每文件覆盖全
  空间、裁剪失效(曾验证多线程下 avg 读 7.6/16 文件, 单线程 0.9/11)。**v6 不建索引**：UHUGEINT 写进 parquet 是有损
  DOUBLE(边界偏差 ~2^76, 据此裁剪有误跳过风险)且 v6 仅 1~3 个小文件、收益甚微 ⇒ 前端对 v6 回退读全部(行为不变)。
- 「浏览所有国家」入口已从侧栏移除；`countries.html` + `sitemap.xml` 仍在(给爬虫), SSG 落地页不受影响。
- **子网搜索**(`#ip` 框)：`prefixes`(ip_start 排序) `WHERE ip_start<=ip AND ip_end>=ip`，覆盖它的所有前缀。
  父子段也由 `prefixes` 范围自连接实时查；文件按 `prefixesFilesForRange` 裁剪(见上 prefixes_ip)。填了合法 IP 时**优先于**国家/path 等其它筛选。
- 主题：自动/亮/暗（`data-theme` + localStorage）；移动端有 `@media` 适配。
- badge/线路配色：电信蓝/联通红/移动绿/教育紫/科技橙/国际灰（`asn_ops` 驱动）。
- 抽屉显示**更大/更小段**（库内采集到的，可能不全，UI 已标注）。
- **MOAS（一个 prefix 多个 origin AS）**：`prefix.n_origins>1` 即多源。列表(国家/全局/子网)在 origin 列加紫色 `MOAS N` 角标；
  抽屉读 prefixes 的 `origin_asns`/`origin_npaths` 数组列出**全部 origin**(按 peer 降序, 默认折叠 9 条可展开, 完整不截断)，
  路由图把所有 origin 节点都高亮。**按任一 origin 可搜**(见上 pathsearch MOAS 多行)：搜某 AS / 看其通告前缀都能命中它作为
  次要 origin 的多源前缀。门控：列表角标 `meta.has_n_origins`；完整 origin 列表 + 次要 origin 搜索 + `is_primary` 去重 `meta.has_moas`
  (旧数据无对应列即降级, 不报错)。典型例：`192.58.128.0/24`(12 个 origin)。
- **DFZ 可见性**：`n_paths`(=观测到该前缀的 peer 数, 跨 rrc01+rrc06) 是可见度信号；export 出**按 family** 的
  `dfz_ref`/`dfz_ref_v6`(n_paths p90)。前端 `isLowVis`/`lowCutFor(v6)` = `n_paths < 0.2*dfz_ref[_v6]`(v6 自有阈值,
  其全网 peer 数远少)；控制栏「含低可见」默认**不勾**。
- 「关于」modal：数据来源/分析方法/免责（仅供学习研究 BGP）/数据更正 issue 链接。

### WHOIS / RDAP + ASN 详情面板 + 面板导航（`rdap.js` / `AsnDetail`/`Whois*`；调研见 `docs/RDAP_WHOIS_RESEARCH.md`）
- **纯前端直连 RDAP**，零后端。`rdap.js`：构建期内置 IANA RFC 9224 bootstrap 表(`rdap-bootstrap.json`, ~6.6KB)
  把 ASN/IP **直接**映射到对应 RIR 的 RDAP base 直连查询；命中失败/出错回退 `rdap.org` 重定向器。各 RIR 与 rdap.org
  在 GET 上均回 `Access-Control-Allow-Origin:*`(实测)、重定向每跳过 CORS、简单 GET 无预检 ⇒ 浏览器可直连。
  缓存 = 内存(并发去重) + sessionStorage(`rdap:<kind>:<key>`)。`normalize()` 把 jCard/嵌套 entity 拍平成
  `{key,value}` 行 + entity 树。**升级/刷新 bootstrap**：跑 `scripts/vendor-rdap-bootstrap.sh`(可并入 daily) 再 build。
- **WHOIS 渲染**(`Whois.svelte`→`WhoisRow`/`WhoisEntity`)：扁平 whois 观感——一行一个 `key:value`、常见 key 左侧
  FA 图标(`whois-fields.js` 映射, 未知用默认点)、**嵌套 entity 默认折叠成一行可点开**(tree-guide 缩进, abuse 高亮)。
  `Whois` 自取 RDAP(props `kind`,`rkey`), 与 queries.js 解耦。前缀详情面板尾部嵌 `<Whois kind="ip">`。
- **ASN 详情视图**(`AsnDetail.svelte`, `S.detailKind='asn'` + `S.asnView`)：精确框输入 ASN(`classifyQuery` kind=asn)
  → `setSubjectAsn` 自动开面板。内容 = WHOIS(autnum) + **通告前缀**(origin 索引, 廉价: `pathsearchFilesForOrigin(asn)`
  + COUNT v4/v6) + **观测上游**(据通告前缀 best_path 左侧一跳推得, 随结果免费拿到) + **完整邻居**
  (`scanNeighbors`: 现读**导出期预计算的 `asn_neigh`**(按 asn 数值索引取 1 分片的邻接计数 d/u/w/wd)→ `groupRelations` 前端分类,
  **自动加载、完整无截断**；旧数据无 `has_asn_neigh` 时回退全表扫 `paths_blob LIKE` + 2 万截断)。**无 ASN 级路由图**(路由图是 per-prefix 的)。
- **ASN 邻接预计算(`asn_neigh`, `parquet_export._build_asn_neigh`)**：从 `paths{,_v6}` 把每条 AS_PATH 展开成相邻对, 按
  Tier-1 位置门控算 **d**(强下游)/**u**(强上游)/**w**(弱上)/**wd**(弱下) 计数, GROUP BY (asn,neighbor)。**只预计算邻接事实(计数),
  不预计算 up/peer/down 分类**(分类留前端 `groupRelations`/`classifyRelation`, 改判定不必重导出)。约 +30s / ~4MB / ~44 万对。
  **`parquet_export.TIER1` 必须与 `web/src/lib/bgp.js` 的 `TIER1` 一致**(弱/强门控用; 改一处同步两处)。
- **URL 路由 / PJAX(`queries.js` `applyRoute`/`go`)**：**浏览器历史 = 单一真相**。开详情 `pushState('/<asn>'`
  或 `'/<prefix>')`；面板前进/后退按钮 = `history.back()/forward()`；`popstate` 调 `applyRoute()` 按 URL 重渲染
  (`_suppressUrl` 屏蔽回写防环)。`S.nav={idx,max}` 仅供 ←/→ 可用态。支持: `/<asn>`(如 `/4842`)、`/<prefix>`
  (如 `/1.1.1.0/24`、`/2001:db8::/32`)直开/刷新 → 填精确框 + 搜索 + 展开详情(`openPrefixByString` 按前缀串查 pid);
  传统 `?q=<词>` 搜索。**关闭语义**：`closeInsight` 看 prefix 且主体是 ASN 时**先返回 ASN 页**, 再点才真关;
  **Esc / 移动端关闭 = `hardCloseDetail`** 全关 + URL 回 `/?q=<框>`(或 `/`)。
  - **页标题随详情变(历史记录可辨识)**：`App.svelte` 的 `pageTitle()`(`$effect` 内)据 `S.detailKind`/`insight`/
    `asnView`/`domainView`/`dns` 算出 `<前缀|ASN|域名> · <brand>`(无详情回落 `t('page_title')`)。与 `go()` pushState
    同源响应 ⇒ 每个历史项记录到对应标题。`showInsight` 的 loading 态预填 `insight.prefix` 让标题在查询返回前即正确。
- **深层路径硬约束(两处必须)**：① `index.html` 的 `<base href="/">` —— 否则 `/1.1.1.0/24` 下相对资源与
  `db.js` 的 `document.baseURI`(算 `SAME=/data`)会解析到 `/1.1.1.0/...` 而全坏；② **CN Caddy 的 `try_files {path} /index.html`**
  SPA 回退(`deploy/cn.peer.as.Caddyfile`) —— 否则直开 `/4842` 在 cn.peer.as 404(CF Pages 默认对缺失路径回 index.html, 无需配)。
  改 Caddyfile 后须 scp 到 VPS + `caddy reload`(deploy.sh 不传 Caddyfile)。
- **域名 WHOIS 兜底(`whois-worker/`)**:部分 TLD(`.de`/`.ie` 等 ccTLD)无 RDAP —— RDAP 全失败(含 404)时 `rdap.js`
  的 `doFetch` 回退 `whoisFallback()` 调 **peer-as-whois** worker(`whois-worker/`, 基于已归档 abersheeran/http-whois,
  改了 CORS+读到 EOF+whois server 正则)取扁平 whois, `whoisToModel()` 把高置信字段(注册商/日期/状态/NS…)拍成
  与 RDAP 一致的 head 行 + 保留全文 `rawWhois`(`Whois.svelte` 用 `<pre>` 展示),来源行标 `via=whois`。gTLD 仍走 RDAP。
  缓存复用 sessionStorage(`{whois:true,server,text}`)。部署:`cd whois-worker && npm i && npm run deploy`。
- **中国访问**:RDAP/各 RIR 在境外, `cn.peer.as` 境内直连仍直走外部(一般可达, 暂未反代)。但 **DoH(`cloudflare-dns.com`)
  与 WHOIS worker(`workers.dev`)境内连通性差** —— `edge=cn` 时 `dns.js`/`rdap.js` 经 `cnProxyBase()` 改打本机
  `/dns-query`、`/whois`(Caddy 反代, 带 Referer 白名单),见上「中国优化 · DoH/WHOIS 转发」。

### DNS 解析视图 + 域名详情(`dns.js` / `DnsView`/`DomainDetail`; 域名 RDAP 走 `rdap.js`)
- **触发**：精确框输入域名(`classifyQuery` 的 **domain** 分支, 见 `bgp.js` 的 `isDomain`/`DOMAIN_RE`——多段标签 +
  字母/xn-- 结尾 TLD, 含 IDN; 带点但非 IP 的串走这里, 无点的仍是 AS 名称搜索)。专属路由 **`/dns/<域名>`**(applyRoute
  识别 `dns/` 前缀)。`runSearch` 顶部 `probe.kind==='domain'` 即 `return runDns(domain)`(抢占, 早于子网/origin 等分支)。
- **解析(`dns.js resolveDns`)**：纯前端 **DoH JSON**(`Accept:application/dns-json` —— Accept 是 CORS 安全列表头,
  简单 GET 无预检, 端点回 `ACAO:*`)。**endpoint 动态**(`endpoint()` 据 `cnProxyBase()`):海外直连
  `cloudflare-dns.com/dns-query`;`edge=cn` 经本机 `/dns-query` 中转(境内直连 1.1.1.1 DoH 常被墙/污染),见「中国优化」。
  并发查 A/AAAA/CNAME/NS/MX/TXT/SOA/CAA 八类, 单类失败不阻断; 按记录类型 code 过滤 Answer。
  缓存 = 内存去重 + sessionStorage(`dns:<域名>`)。
- **左侧主内容(`DnsView`, `S.mode==='dns'`, App 据此改渲染)**：A/AAAA 各一个 tablewrap(带小标题), 每行 = 地址 +
  库内**最具体覆盖前缀** + **origin ASN**(`queries.runDns` 用 `enrichIp` 查 `prefixes`/`prefixes_v6` 富集; 点击行下钻
  `showInsight`)。其它记录类型直接分组列 value/TTL。载荷在 `S.dns`。
- **右侧域名详情(`DomainDetail`, `detailKind==='domain'`, 载荷 `S.domainView`)**：逻辑同 ASN 面板——头部 + 概要
  pill(取 `S.dns` 计数) + `<Whois kind="domain">`。**域名 RDAP**：`rdap.js` 的 `domainBase`(按末位标签查 dns bootstrap)
  →直连 TLD 注册局, 命中失败回退 `rdap.org/domain/<域名>`; `normalize` 的 domain 分支出 ldhName/status/events
  (注册/到期/变更)/nameservers/DNSSEC。**注意**：部分 TLD(如 `.de`/`.ie`)无 RDAP / 不被 rdap.org 覆盖 →
  RDAP 全失败后**自动回退 WHOIS worker**(见上「域名 WHOIS 兜底」, 仍出结构化 head + 全文), DNS 记录解析也不受影响。
- **主体/关闭语义**：域名 = `S.subject={kind:'domain'}`(`setSubjectDomain`, 桌面自动开面板、移动端由 Topbar WHOIS 按钮开)。
  从 A 记录下钻到前缀/ASN 后, `closeInsight` **先返回域名面板, 再点才真关**(二次关闭; 与 ASN 主体同一机制)。
  `hardCloseDetail` 在 DNS 模式下保留 `/dns/<域名>` URL(左侧记录仍在)。
- **刷新 dns bootstrap**：`scripts/vendor-rdap-bootstrap.sh` 现一并下 `dns.json`(全 TLD RDAP base, ~39KB) 再 build。

## RPKI / IRR / as-set（路由起源验证 + 客户锥；调研见 `docs/RPKI_IRR_RESEARCH.md`）
三层数据**全在导出期用 DuckDB 预计算成静态列/数据集**，前端零后端按 parquet 查询。**数据缺失(import 没跑/开关关/无网)
即 `meta.has_*=False`，前端不 SELECT 对应列、自动降级**(同 `has_moas` 门控惯例)，不报错。两站(peeras/dn42)默认全开。

- **采集(`ipc rpki-import` / `irr-import` / `asset-import`)**：下载/解析 → `cache/{rpki,irr,asset}/*.csv`(+`meta.json` 含 `as_of`)。
  best-effort：某源失败只跳过。`deploy.sh --data` 把这三个与 ingest **并行**跑(它们只写 cache、不碰 DuckDB), 互锁后 export。
  **RADB 无 HTTPS**：IRR route 走 **NRTMv3 增量**(见上 `irr.py` 条, 取代每轮全量 FTP); as-set 仍走 `ftp` dump
  (`util.download_file` 支持 ftp, `reuse=` 命中缓存不重下); RPKI VRP 走 https。
- **导出(`parquet_export.py`)**：先 `route_origin`(每 (前缀,origin) 对，含 MOAS 次要 origin) → `rpki.classify`/`irr.classify`。
  - `rpki`(UTINYINT 0=NotFound 1=Valid 2=Invalid-ASN 3=Invalid-len) / `irr`(0=not-found 1=present 2=mismatch) 列贴到
    `prefixes{,_v6}`(代表 origin)、`pathsearch{,_v6}`(每 origin 行)、`geo{,_v6}`(代表)；MOAS 数组 `origin_rpki`/`origin_irr`(与 `origin_asns` 对齐)。
  - **RPKI 覆盖判定必须按前缀长度分桶 + 物化候选键的等值 hash join**(`rpki.classify`)——切忌写 `vrp.ip_start<=p.ip_start AND vrp.ip_end>=p.ip_end`
    双不等式区间 join，DuckDB 对 ~110万×93万会退化成 nested-loop、**30 分钟跑不完**(踩过)。VRP 存 `vlen`(前缀长度)用于分桶。
  - IRR 对象明细数据集 `irr{,_v6}/`(精确前缀 ∩ 已观测前缀，每 (pid,origin) 一行 + `sources` 数组) + v4 区间索引 `irr_ip`。
  - as-set 三数据集 `asset_set`/`asset_member`/`asset_memberof`，各按字符串键排序 + **字符串区间文件索引**(`asset_*_key`，`_str_index`)。
  - `meta`：`has_rpki`/`has_irr`/`has_asset` + `rpki`/`irr`/`asset`(各含 `as_of`/计数/`sources`/`authoritative`)。
- **前端**：
  - `OriginStatus.svelte`(rpki/irr 码 → 徽章；Valid 绿/Invalid 红分 ASN·长度/NotFound 中性；IRR present·mismatch)。
    挂 `Results`(origin 列)、`InsightDrawer`(origin pill + MOAS 每 origin + **IRR 路由对象区块**列来源库 + 权威/第三方 trust)。列选择门控在 `queries.js`。
  - **as-set 嵌套列表(左侧主内容, `mode='asset'`)**：`AsSetView.svelte` + 递归 `AsSetTree.svelte`(点子 as-set 懒查一层 +
    `loadAsSetMembers`，**环检测**(祖先 set 集)+ 深度上限 24)。`classifyQuery` 的 **asset** 分支(`isAsSet`：`AS-FOO`/`AS123:AS-X`/
    `SOURCE::AS-X`，**须早于 `:`→IPv6 分支**)；路由 `/asset/<键>`。ASN 详情面板加「所属 as-set」反查(`loadMemberOf`，读预计算 `asset_memberof` 索引)。
  - db.js：`irrFilesForRange`(同 prefixes_ip)、`asset*FilesForKey`(字符串索引)。**改 `ipcollect/web/*` 后必须 `npm run build`**。

## 不变量 / 常见坑（改动前必读）
- **不要重新引入"线路质量"评分**。CN2/GIA 从境外回程 BGP 分不出（GIA ⊂ CN2 同走 4809）。只看 AS_PATH。
- **RPKI 覆盖判定别写双不等式区间 join**（会退化 nested-loop 卡死）——用 `rpki.classify` 的分桶等值 hash join。改 import 源列表见 `irr.py`/`asset.py` 的 `DEFAULT_SOURCES`。
- **`origin asn` 仅展示**，不得参与筛选/排序；命名永远叫 "origin asn"，不叫"回程 asn"。
- path 搜索是**连续相邻子序列**（`1299 23764 4809` ≠ `1299 4809`），不是"含且无序"。`--asn` 才是无序含任一。
- **ASN 名称/分组在 `ipcollect/data/asn_registry.csv`**（CSV，可直接 PR），不在代码里；改名/加 ASN/标 IDC 改这里即可
  （列 `asn,name,name_en,op`；`#` 行注释）。改 CSV 即时生效（不写回 config.json）。
- **i18n 显示(语言感知)**：`bgp.js` 的 `asnName(a)`(zh=中文别名优先, en=`name_en`→APNIC 英文名→中文别名滤拉丁兜底)、
  `opText(a)`(op 分类按 `OP_EN` 译)、`placeLabel(prov,city,cc)`(英文界面滤掉 CJK 地名段、滤空回退英文国名 —— 修
  geo 里「英文省+中文市」混排，**纯前端、无需重建 geo**)。`opOf`/`opCls` 仍用中文 op key 做配色/排序。改了
  `name_en` 等 config 需重新 `export-parquet` 才进 `meta`(英文别名才生效；运营商/地名 i18n 是纯前端、build 即生效)。
- 改 `mrt_collectors` 后**必须重新 `ingest`**。
- **geo 以合并后 geo 表为准**：export 用 `GeoIndexDuck.carve_cc` 把前缀切成各城市子段(**全球都到城市**,
  CN 用 ipdb / 国际用 GeoLite)，segs 预算成 **CIDR 串列表**进 `geo{,_v6}/<cc>`。超大聚合前缀(覆盖 geo 段 >`SEG_OVERLAP_CAP`)
  退化国家级单段防炸。
- **有效路由切段(关键)**：BGP 是最长前缀匹配——前缀的 AS_PATH 只对「**自身范围 − 更具体子段**」有效。export 先
  `_forest_duck` 建层状森林, 对每前缀 `_subtract(range, 子段holes)` 得有效范围, **再**按 geo 切城市。
- **export 会先 `shutil.rmtree(dist/data/parquet)`** 全部重写(文件名/计数每次变)。
- 前端改 `ipcollect/web/*` 后**必须 `npm run build`**(`ipc build` 会跑) 才进 `web/dist/`→`dist/`。**改 CHANGELOG 也要重 build**(内联)。
- `ipcollect.duckdb` 是中间态(跑完即弃, 已 gitignore)；`--reset` 清 obs/pathobs/prefix, **保留 geo/asn_dim/country_dim**。
  旧 `ipcollect.db`(SQLite) 已无用, 可删。

## 在不烧资源的前提下验证（重要）
- **JS**：`node --check dist/app.js`（或 `ipcollect/web/app.js`）。**CSS/HTML**：肉眼 + `ipc serve` 本地看。
- **Python 逻辑**：`./ipc <cmd> --help`、`python -c "from ipcollect import ..."`、对**只读查询**直接跑。
- **避免重下 400MB RIB**：库已存在就直接用；要试 ingest 逻辑可用 `--mrt-file cache/mrt/bview.*.gz`
  指向本地已下文件；或用 `--limit` 小批量。
- 改完**务必同步本文件**，并视情况更新 memory（见下）。

## 记忆
项目背景、设计取向、部署、"仅 agent 维护"等见
`~/.claude/projects/-home-aosc-test-ip-collect/memory/`（`MEMORY.md` 为索引）。

## 路线图（进行中）
**已完成**：全球全表 **v4+v6** PEER.AS(rrc01+rrc06 双采集点)，**DuckDB 工作库**(SQLite 退役)，纯静态可复现，
**DuckDB-WASM + Parquet**(v4/v6 两套)分发；geo 三轨合并(ipdb CN 城市 + GeoLite 国际城市 + rir 兜底)、**全球城市级** +
**AS organization**；i18n(zh/en) + SEO。详见 `docs/DUCKDB_V6_REFACTOR.md`。**无 CI**：全手动在本机跑, GitHub 仅托管源码。
**待办/可改进**：geo-import 的非重叠窗口去重(~分钟级)可优化;
v6 全表 carve 体量较大(692MB)可视情况收敛国际城市粒度。
