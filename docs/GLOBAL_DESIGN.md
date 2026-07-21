# 全球化重构 设计契约 (GLOBAL_DESIGN)

> 本文件是 Phase 1–4 的**唯一权威设计契约**。所有实现与验证 subagent 以此为准。
> 改了实现就同步改这里。背景见 `AGENTS.md` 与 memory `global-redesign`。

## 目标
境内 → **全球全表** BGP Insights；**纯静态、可复现、可镜像**；分发用 **DuckDB-WASM + Parquet**
（浏览器对静态 Parquet 发 HTTP Range 查询，无后端）。geo 双轨（官方 ipdb / 开源可再分发库）。

## 不变量（勿违背）
- 只看 **AS_PATH**（含哪些 ASN + 顺序/相邻）；**无任何线路质量评分**。
- `origin asn` 仅展示，不参与筛选/排序。
- path 搜索 = **连续相邻子序列**（`1299 23764 4809` ≠ `1299 4809`）；`--asn` 才是无序含任一。

## Phase 1 — 全表(v4)入库（SQLite 中间层）
- **范围**：scope=`global` 时收**全部 v4 前缀**；去掉 focus-ASN 4 字节预筛与 `focus∩asnset` 门槛；
  **不按国家过滤**。`focus_asns`/`focus_country_code` 在 global 模式下**仅作高亮/导航**，不参与入库。
- **v6 deferred**：SQLite INTEGER 是 64 位，装不下 128 位 v6 start/end。Phase 1/2 先做 v4；
  v6 留待后续（需 128 位端到端 + Parquet HUGEINT）。global ingest 跳过 family==6。
- **去重存储**：`pathobs` 改为**每前缀 distinct 路径 + peer 计数**（不存 per-peer）：
  `pathobs(id, prefix_id, path_clean, path_len, origin_asn, n_peers)`。ingest 时按 path_clean 去重、
  累加 n_peers。`prefix.n_paths` = 该前缀总 peer 观测数（=可见度信号，sum(n_peers)）。
- **跳过 path_asn**：global 模式不建 ASN→前缀倒排巨表（DuckDB/前端直接查 path 串）。
  CLI `--asn` 退化为对 pathobs 的 LIKE 扫描。
- **config**：新增 `ingest_scope`（默认 `global`）。CLI `ingest --scope global|focus`、`--limit` 仍可用。
- **产出实测**：prefix 行数、pathobs(distinct) 行数、db 体积 —— 作为 Phase 2 分区粒度依据。

## Phase 2 — 导出 Parquet（duckdb python，按国家分区）
四张表，写到 `dist/data/parquet/`：
**实测**：duckdb 不支持 PARTITION_BY+FILE_SIZE 同用，而 CF Pages 25MiB/文件硬限必须切文件 →
**改为按键排序 + 20MB 切文件**(不用 Hive 分区)，靠 parquet row-group 的 min/max 做 Range 行级裁剪。
- `geo/`：**国家 working-set 表**(选国家=只拉该 cc row-group, 之后过滤 in-browser SQL 下推)。一行=(pid,cc,
  city)。列：`cc,city,province,pid,prefix,plen,origin_asn,n_paths,segs,paths_blob,observed_peers,best_path`。
  **按 cc 排序**。`paths_blob`='|'拼接的去重路径(≤PATH_CAP)，每条记录为 `@n_peers@ path`，供连续序列匹配及加权计票。
  CN 等 focus 国家=城市级(多行/pid); 其余=国家级(city NULL)。
- `prefixes/`：**按 ip_start 排序**(不分区)。列 `pid,prefix,ip_start,ip_end,plen,family,origin_asn,
  n_origins,n_paths,cc,province,city`。子网搜索/父子段(范围自连接)/pid 详情。即 ipindex。
- `paths/`：**按 pid 排序**。列 `pid,path_str,path_arr(int[]),path_len,n_peers,is_best`。`is_best` 仅表示稳定选出的代表观测路径，不代表全球流量；insight 展示全量路径。
- `asn_dim.parquet`：`asn,name,op`(config.asn_registry 精选高亮)。
- carve：`_build_segments` = `_forest`+`_subtract`(有效路由=自身−更具体子段)+`GeoIndex.carve_cc`;
  focus 国家保留 city、其余合并国家级。`meta.json`：dfz_ref + counts + countries + country_names(zh)/
  country_names_en + focus_countries + cities + path_presets + focus_asns + asn_names/ops + site_base。

## Phase 3 — 前端 DuckDB-WASM（`web/app.js`）
- 懒加载 `@duckdb/duckdb-wasm@1.32.0`(jsDelivr ESM + blob-worker 跨域 shim)；首屏 `meta.json` 秒开。
- 查询(远端 parquet Range)：`geo WHERE cc=? [AND city=?] [AND paths_blob LIKE ?] [AND n_paths>=lowcut]
  匹配观测占比 = `sum(blob 里匹配记录的内嵌 peer 权重) / observed_peers`，按占比、匹配 peer 数、总可见度降序；子网 `prefixes WHERE ip_start<=:ip AND ip_end>=:ip`；
  insight `paths WHERE pid=?`；父子段 `prefixes` 范围自连接；低可见 `n_paths<0.2*dfz_ref`。
- 导航 国家→城市(focus)；CN+境外高亮 preset。**i18n**：`Intl.DisplayNames` 出双语国名 + STRINGS 切 UI。
- 验证：duckdb python 跑**同款 SQL** 对拍；浏览器运行态无法 headless 验证(已知缺口)。

## SSG + SEO（`ssg.py`）
WASM 查询站对爬虫不可见 → 为每国家出**双语预渲染落地页** `c/<cc>.html`(国名中英/前缀数/top origin/城市,
title/description/OG/canonical, 链 `/?cc=XX`) + `countries.html` + `sitemap.xml` + `robots.txt`。

## Phase 4 — geo 双轨 + CI
- `geoip.py` provider：`ipdb`(私有, 城市级, 官方) / `rir`(RIR delegated-extended, 国家级, 完全开放, OSS)。
  config `geo_provider`；`ipc geo-import --provider rir`。
- `.github/workflows/build.yml`：geo-import(rir) → ingest(global) → export-parquet → 部署 Pages。
  全表 ingest 在 GitHub 7GB runner 偏紧(已 `IPC_DUCKDB_MEM` 降内存+磁盘溢出)，必要时自托管。
- 开源仓库只含代码 + 国家级开放 geo；`ipdb.txt` 永不入库；密钥走 Secrets/env。

## 已落地的脱敏（前序）
密钥走 env（`.env.example`）；`config.json`/`.wrangler/`/`ipdb.txt`/`*.db`/`cache/`/`dist/` 全 gitignore；
测活(Shodan+probe)整套已删。
