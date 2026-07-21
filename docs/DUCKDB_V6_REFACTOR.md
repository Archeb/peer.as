# DuckDB 一把梭重构方案 — v6 先行验证 + 双数据源(rrc01 / rrc06)

> 状态:**设计方案(待实施)**。本文件是这次重构的权威设计契约;实施时逐阶段对照、改动后同步
> `AGENTS.md` 与 `docs/GLOBAL_DESIGN.md`。读者默认无先验上下文。

## 0. 目标与非目标

**目标**
1. **退役中间层 SQLite**,改用 **DuckDB 作为唯一工作引擎**(ingest 去重 + carve 喂数 + 导出 Parquet 一把梭)。
2. **加入 IPv6 支持**,且**先用 v6 验证新管线**(v6 数据量小、与现网 v4 product 完全隔离,炸了也只炸 v6),
   验证通过后再把 v4 迁到同一引擎、删掉 SQLite。
3. **数据源从单 rrc00 改为双采集点 `rrc01`(LINX, 伦敦)+ `rrc06`(NSPIXP, 东京)**,**弃用 rrc00**
   (代表性不足)。两点地理/网络互补,合并观测提升 vantage 多样性。

**非目标 / 不变量(沿用现有契约,勿破坏)**
- 不重新引入"线路质量"评分;**只看 AS_PATH**(含哪些 + 顺序)。
- `origin asn` 仅展示,不参与筛选/排序。
- path 搜索是**连续相邻子序列**;`--asn`/origin 才是无序/精确。
- ASN 命名/分组留在 `config.json` 的 `asn_registry`。
- 纯静态可复现:前端仍是 DuckDB-WASM + Parquet(HTTP Range),无后端。

---

## 1. 总体架构:before → after

```
BEFORE (现状)
  MRT(rrc00) ──Python解析──▶ SQLite(逐前缀 UPSERT + DELETE/重插 pathobs 去重)
                                  │  ATTACH(只读)
                                  ▼
                              DuckDB ──聚合/carve喂数/COPY──▶ Parquet(v4) + SSG
                                  ▲ (导出阶段甚至回读自己写的 parquet 避免再扫 SQLite)

AFTER (本方案)
  MRT(rrc01)─┐
  MRT(rrc06)─┴Python解析(含v6)──appender──▶ DuckDB 工作库(单引擎)
                                              │  obs 原始观测
                                              │  ─GROUP BY 去重→ prefix / pathobs(HUGEINT 区间, family 列)
                                              │  ─Python carve/forest(读DuckDB, 位宽无关)→ seg
                                              ▼
                                          COPY ──▶ Parquet:v4 一套 + v6 一套(*_v6) + SSG
  无 SQLite。CLI 调试改用 DuckDB(查工作库或直接查 Parquet 产物)。
```

核心收益:
- **去重从"行存别扭写法"变成一句 `GROUP BY`**:不再 `ON CONFLICT UPSERT` + 逐前缀 `DELETE pathobs 再重插`。
- **128 位靠 DuckDB 原生 `HUGEINT`**:v6 的 start/end 直接存,**不需要 BLOB/hi-lo 取巧**,v4(≤32 位)同样装下。
- **OOM 更稳**:DuckDB 原生溢出磁盘(沿用 `cache/duck_tmp` 真盘配置)。
- **少一座桥**:删掉 SQLite→DuckDB 的 `ATTACH` 搬运。

---

## 2. 关键设计决策

### 2.1 工作存储 = DuckDB(持久化为本地 `.duckdb` 文件)
ingest 期写一个本地 DuckDB 文件(替代 `ipcollect.db`),`--reset` = 重建。单写者、批处理、跑完即导出,
无并发/ACID 需求(和现状一致)。`PRAGMA memory_limit` / `threads` / `temp_directory='cache/duck_tmp'`
沿用现有 `IPC_DUCKDB_*` 环境变量语义。

### 2.2 128 位 = HUGEINT(v6 存储难题消失)
DuckDB(含 **DuckDB-WASM**)原生支持 128 位 `HUGEINT`。`prefix_from_bytes` 已返回 Python int(任意精度),
v6 给 128 位、v4 给 ≤32 位,**统一用 HUGEINT 存 `ip_start`/`ip_end`**。
> 前端注意:DuckDB-WASM 把 HUGEINT 经 Arrow 给 JS 时是 **BigInt**。子网搜索要把输入的 v6 地址转成 BigInt
> 再比较(`q()` 现已处理顶层 BigInt;v6 区间比较需显式 BigInt 路径)。v4 仍可用 Number。

### 2.3 拆表策略 —— **工作库统一(family 列),Parquet 输出按 family 拆** 〔决策点,见 §8〕
你最初(在"给 SQLite 打 BLOB 补丁"语境下)提的是"从 SQLite 到 Parquet 全程拆两类表"。换到 DuckDB-HUGEINT 后,
**物理拆表的存储理由消失**(一个 HUGEINT 列同时装 v4/v6)。本方案改为:
- **工作库**:`prefix`/`pathobs`/`obs` 单套表,带 `family` 列。逻辑复用一份,避免 v4/v6 代码翻倍。
- **Parquet 输出**:**按 family 拆成两套文件**(`prefixes/` vs `prefixes_v6/`、`pathsearch` vs `pathsearch_v6`、
  `geo/<cc>/*.parquet` vs `geo/<cc>/*_v6.parquet`)。
- **前端**:按输入 IP 的 family 路由(子网搜索),或对 AS_PATH/origin 搜索 **union 两套结果**、显示层合并
  —— 正是你描述的"同时查两表再聚合"。

这样既拿到你要的**隔离收益**(v6 可独立 lazy-load、独立缓存失效、v6 炸不到 v4 文件),又不必把入库/carve
逻辑复制两份。**若你坚持工作库也物理拆表**,见 §8,改动可控但维护面更大。

### 2.4 双数据源 rrc01 + rrc06(弃 rrc00);n_peers 语义
- 配置 `mrt_collectors: ["rrc01", "rrc06"]`(数组;保留旧 `mrt_collector` 单值做兼容回退)。
- ingest 对每个 collector 各取最新 bview、各自解析,**全部观测灌进同一张 `obs` 表**,带 `collector` 列。
- **去重在 `GROUP BY` 时跨 collector 合并**:`n_peers = count(DISTINCT collector || '|' || peer_ip)`
  (= 多少个不同 vantage 观测到这条 path,跨两采集点)。可另存 `n_collectors` 备分析。
- **代表观测路径 / `is_best`**:按 `n_peers DESC, path_len ASC, path string ASC` 稳定取 `rn=1`，仅供详情/路由图选取一条完整代表路径；不得称为“全球最优”或“实际流量路径”。AS_PATH 搜索主导性按所有匹配路径的 peer 观测权重之和计算。
- **DFZ 可见性 `dfz_ref`**:`n_paths`(观测到该前缀的 peer 数)基准会因双采集点而变,**v4/v6 各自重算
  `dfz_ref`**(v6 的全网 peer 数远少于 v4,不能共用阈值)。

### 2.5 carve / forest 保留 Python(位宽无关)
`_forest`/`_subtract`(最长前缀匹配的层状森林 + 有效路由区间相减)和 `geoip.GeoIndex`(内存 bisect)
**都是纯 Python 整数运算,128 位天然支持**,逻辑零改。只需:
- 数据源从 `SELECT ... FROM sqlite` 改成从 DuckDB 取(同样的列)。
- `GeoIndex` 载入 **v6 geo 段**(见 §3 geo)。bisect 对 v4/v6 混排不安全(数值区间可能重叠),稳妥起见
  **v4/v6 各建一个 `GeoIndex` 实例**,按 family 取用。

> 长期可把区间相减换成 `pytricia`/`SubnetTree` 前缀 trie,但**本次不做**(保持改动聚焦,trie 是后续优化)。

### 2.6 geo & ASN 富化:引入 GeoLite2 mmdb(国际→城市 + AS organization)
**v6 geo 来源 = MaxMind GeoLite2,且顺带补齐 v4 国际城市级 + AS org。** 三库分工互补:

| 来源 | 覆盖 | 粒度 | 用途 |
|---|---|---|---|
| **ipdb**(私有, 已有) | 国内 | 城市级 | CN 前缀 geo(最准,优先) |
| **GeoLite2-City.mmdb**(新) | 全球(含 v4+v6) | 城市级 | **国际**前缀 geo + **v6** geo(国内让位 ipdb) |
| GeoLite2-ASN.mmdb(新) | 全球 IP→ASN/org | — | **AS organization** 富化(现仅 APNIC 给的 AS name) |
| RIR delegated(OSS, 已有) | 全球 | 国家级 | 开放可复现兜底 |

要点:
- **格式统一转换**:`.mmdb` 是 IP 区间 trie。geo-import 时**遍历 mmdb 展开成 `geo` 区间表行**
  (`start_num/end_num` HUGEINT + family + cc/prov/city + `geo_provider`),与 ipdb 落进**同一张表**,
  carve/`GeoIndex` 一视同仁。用 `maxminddb` 库(可迭代 (network, record));加进 `requirements.txt`。
- **重叠消解(关键)**:`GeoIndex` 的 bisect 假设**区间互不重叠**;两个 provider 会重叠。
  **在 geo-import 阶段按优先级合并成单一非重叠区间集**:`ipdb(CN城市) > geolite(国际城市) > rir(国家级)`。
  即:CN 范围用 ipdb,其余用 GeoLite,空缺用 RIR;同段冲突取高优先级。这样运行期 `GeoIndex` 逻辑不变。
- **v4/v6 国际→城市:一步到位**(已定)。carve 不再限于 `focus_cities`/CN,**全球前缀都切到城市级**
  (有 GeoLite 城市数据的范围)。代价:geo 段数与 carve 产物/Parquet 体量显著上升 —— 用 `PATHSEARCH_FILE_SIZE`/
  `FILE_SIZE` 分片切文件控制单文件 <CF 25MiB 限制即可,DuckDB 全程在 `cache/duck_tmp` 溢出磁盘抗 OOM。
  `focus_cities` 退化为**前端导航/高亮用的城市集**,不再是 carve 粒度开关。
- **GeoLite 同步 = 跟随 MRT 检查过期**(已定):**每次 ingest(每次 MRT 更新)先检查本地 GeoLite 是否过期**
  ——查 P3TERX 最新 release 的日期 tag / ETag,与本地缓存记录比对;**仅当远端更新才重新下载**(geo 变化慢,
  多数日子命中本地、零下载)。本地缓存路径与版本戳存在 `cache/`(随 mrt 缓存清理策略保留 geo,见 daily-refresh)。
- **AS organization**:遍历 GeoLite2-ASN.mmdb 抽出 `asn → organization`,建/扩 `asn_dim`
  (`asn, name(APNIC), org(GeoLite), op(config asn_registry)`)。前端 `AsnTag` 可显示 org;
  `config.asn_registry` 仍是人工命名/分组的最高优先级覆盖。
- **GeoLite 来源**:P3TERX 镜像按日期 tag 发布(如 `2026.06.01`)。config 存 release/URL 模板;
  ingest 内置上述"检查过期→必要才下载"逻辑(取 latest release tag),无需独立定时任务。

---

## 3. 数据模型

### DuckDB 工作库(本地 `.duckdb`,跑完即弃)
```sql
-- 原始观测(append 期临时,去重后可 DROP 省空间)
obs(prefix VARCHAR, ip_start HUGEINT, ip_end HUGEINT, family TINYINT, plen TINYINT,
    origin_asn BIGINT, path_clean VARCHAR, collector VARCHAR, peer_ip VARCHAR)

-- 去重路径(每前缀×distinct path 一行)
pathobs AS
  SELECT prefix, ip_start, ip_end, family, plen, path_clean,
         arg_max(origin_asn, 1) AS origin_asn,           -- path 末段
         count(DISTINCT collector || '|' || peer_ip) AS n_peers
  FROM obs GROUP BY prefix, ip_start, ip_end, family, plen, path_clean;

-- 前缀维(每前缀一行)
prefix AS
  SELECT prefix, ip_start, ip_end, family, plen,
         <众数 origin> AS origin_asn,
         count(DISTINCT path_clean)                    AS n_distinct_paths,
         count(DISTINCT collector||'|'||peer_ip)       AS n_paths   -- DFZ 可见度信号
  FROM obs GROUP BY prefix, ip_start, ip_end, family, plen;

-- geo:start/end 改 HUGEINT;含 v4+v6;geo_provider 标来源;import 期已按优先级合并为非重叠区间
geo(start_num HUGEINT, end_num HUGEINT, family TINYINT, country_code, province, city, isp, country,
    geo_provider VARCHAR)   -- ipdb / geolite / rir

-- ASN 维:APNIC 名 + GeoLite org + config 覆盖
asn_dim(asn BIGINT, name VARCHAR, org VARCHAR, op VARCHAR)
```
> `arg_max`/众数 origin 的精确写法实现时定;语义同现状(取观测占比最高的 origin 当代表)。

### Parquet 输出(按 family 拆;v4 路径保持与现状一致,v6 加 `_v6` 后缀)
- `prefixes/`(v4) · `prefixes_v6/`:`pid, prefix, ip_start(HUGEINT), ip_end, plen, origin_asn, n_paths, …`
- `paths/`(v4) · `paths_v6/`:`pid, path_str, path_arr, path_len, n_peers, is_best`
- `pathsearch`(v4,按 origin_asn 排序 + 区间索引) · `pathsearch_v6`:同结构(**v6 也按 origin 排序写小分片**,
  含记录内嵌 peer 权重的 `paths_blob` 与 `observed_peers`，保留"origin AS 搜索只读 1 个文件"的性能优化)
- `geo/<cc>/*.parquet`(v4) · `geo/<cc>/*_v6.parquet`
- `meta.json`:扩展 —— `files.prefixes_v6 / paths_v6 / pathsearch_v6 / pathsearch_v6_origin`、
  `dfz_ref_v6`、`counts.{v4,v6}`、`collectors:["rrc01","rrc06"]`;`version` 哈希纳入 v6 文件清单
  (`?v=` 缓存失效机制对 v6 自动生效)。
- `_headers`:给 `*_v6` 路径加同样的长缓存规则(可缓存才有 Range)。

---

## 4. 分阶段实施(每阶段一个验证门 ✅,过了才进下一阶段)

### Phase A — 脚手架与配置(不碰现网产物)
1. `config`:`mrt_collectors` 数组(默认 `["rrc01","rrc06"]`),旧 `mrt_collector` 兼容回退;`config show` 显示。
2. `mrt.py`:`latest_bview_url` 接受 collector 参数;ingest 主循环改为**遍历 collectors**,每个 RIB 解析后把
   观测(含 `collector`/`peer_ip`)append 进 DuckDB `obs`。**放开 `keep_pred` 的 `family==4`**,v4/v6 都收。
3. 新建 `ipcollect/store.py`(或改造 `db.py`):DuckDB 连接 + 工作表 DDL + `--reset`。
4. **不删 SQLite 代码**(Phase C 才删),A 阶段新旧并存、互不影响线上 daily-refresh。

✅ 门:`./ipc ingest --reset --limit <小批> --family 6` 能把 rrc01+rrc06 的 v6 观测灌进 DuckDB,
`SELECT count(*), count(DISTINCT prefix) FROM obs WHERE family=6` 合理(v6 全表 ~150–250k 前缀级别)。

### Phase B — v6 验证 track(端到端旁路,先不动 v4 product)
1. ingest 仅出 v6(`--family 6`),DuckDB 去重出 v6 `prefix`/`pathobs`。
2. geo:ingest 启动时**检查 GeoLite 是否过期→必要才下载**(§2.6);`geo-import` 把 **GeoLite2-City.mmdb**
   遍历展开为区间、与 ipdb 按优先级合并为非重叠集,**全球切城市级**;同时跑 **GeoLite2-ASN.mmdb** 建
   `asn_dim`(org)。`GeoIndex` v4/v6 各一实例;`carve`/`_forest`/`_subtract` 喂 v6(逻辑复用)。
3. `parquet_export`:产出 **仅 v6 那套** Parquet(`*_v6`)到一个**旁路目录**(如 `dist/data` 但只加 v6 文件,
   不动 v4 文件),`meta.json` 加 v6 字段。
4. 前端:`db.js` 增加 v6 文件清单读取;子网搜索识别 v6 输入走 BigInt + `prefixes_v6`;AS_PATH/origin 搜索
   union v6 结果。**放在一个开关后**(如 `?v6=1` 或 feature flag),不影响默认 v4 体验。
5. 本地 `ipc serve` + 无头自检验证 v6 查询正确。

✅ 门(v6 正确性):随机抽若干已知 v6 前缀,核对
- 子网搜索 `2001:db8::/32` 命中覆盖它的所有 v6 前缀;父子段关系正确;
- AS_PATH 连续子序列搜索在 v6 上命中正确、best★ 合理;
- origin AS 搜索只读对应 1 个 `pathsearch_v6` 分片(区间索引生效);
- HUGEINT 在前端正确显示(无 BigInt 截断/精度丢失)。

### Phase C — v4 迁移到同引擎 + 退役 SQLite(高风险,在 worktree/分支做)
1. ingest 默认 v4+v6 全收;去重/carve 复用同一套(family 区分)。
2. `parquet_export` 同时产出 v4 + v6 两套(v4 输出**字节级对齐现状**为目标,逐文件 diff 校验)。
3. **并行比对**:同一 RIB 下,新管线 v4 产物 vs 旧 SQLite 管线 v4 产物 —— 前缀数/路径数/抽样搜索结果一致。
4. 删除 SQLite 代码路径(`db.py` 旧 schema、`ATTACH`、`ON CONFLICT` 等);**删除 CLI 查询子命令
   `query/stats/insight` 与 `report.py`** —— CLI 只保留部署/处理快捷入口(ingest / export-parquet /
   geo-import / build / serve)。**source of truth = 原始 MRT**,旧 DB 与中间库都是可丢的中间态,不留迁移脚本。
5. `daily-refresh.sh`:命令不变(`ipc ingest --reset` / `ipc export-parquet`),但内部已是 DuckDB;
   验证 R2/CN-VPS 同步与 `?v=` 失效照常。

✅ 门(v4 不回归):新旧 v4 产物比对一致;线上关键搜索路径(子网/AS_PATH/origin/国家)结果不变;
`peer.as` 部署后冒烟通过。

### Phase D — 收尾
- 删 `ipcollect.db*` 残留与死代码;`requirements.txt` 去 sqlite 相关(若有)、确认 `duckdb` 固定版本。
- 前端去掉 v6 feature flag,v6 默认开启;关于/CHANGELOG 双语加"新增 IPv6 支持 + 双采集点 rrc01/rrc06"。
- 同步 `AGENTS.md`(文件地图、数据维护流程、不变量)与 `docs/GLOBAL_DESIGN.md`;更新 memory
  (v6 已落地、数据源改 rrc01/rrc06、SQLite 退役)。

---

## 5. 文件改动地图
| 文件 | 改动 |
|---|---|
| `config.py` / `config.example.json` | `mrt_collectors` 数组(默认 rrc01,rrc06);弃 rrc00 |
| `mrt.py` | 遍历 collectors;放开 v6;观测带 collector/peer_ip;append 进 DuckDB(替代 SQLite 写) |
| `db.py`→`store.py` | DuckDB 工作库连接 + DDL(HUGEINT, family);`--reset`;退役 SQLite schema |
| `geoip.py` | start/end→HUGEINT;新增 **mmdb 导入**(GeoLite2-City 遍历展开 + 与 ipdb 按优先级合并非重叠);GeoLite2-ASN→`asn_dim`(org);v4/v6 各一个 `GeoIndex` 实例 |
| `cli.py` | `geo-import` 接 GeoLite 选项;**删除 `query`/`stats`/`insight` 等查询子命令**(CLI 只留部署+处理快捷入口) |
| `report.py` | **整文件删除**(查询/渲染随 CLI 查询入口一起退役) |
| `build.py` | `_forest`/`_subtract`/`carve` 数据源改 DuckDB;按 family 处理 |
| `parquet_export.py` | 去掉 ATTACH;去重用 `GROUP BY`;输出 v4+v6 两套;`pathsearch_v6` 区间索引;`asn_dim` 带 org;meta 扩展 |
| `requirements.txt` | 加 `maxminddb`、`duckdb`(钉版本);去 sqlite 相关(若有) |
| `ssg.py` | (v6 落地页可选;先沿用国家页,不强求 v6 SSG) |
| `web/src/lib/db.js` | v6 文件清单;HUGEINT/BigInt;`pathsearchFilesForOrigin` v6 版 |
| `web/src/lib/queries.js` | 子网搜索按 family 路由;AS_PATH/origin union v4+v6;显示合并 |
| `web/src/components/AsnTag.svelte` | 显示 AS organization(来自 `asn_dim.org`) |
| `web/public/_headers` | `*_v6` 路径长缓存 |
| `scripts/daily-refresh.sh` | 命令不变;注释更新(双采集点);缓存清理**保留 GeoLite mmdb + 版本戳**(ingest 内按过期检查决定是否重下,勿每次删) |
| `AGENTS.md` / `docs/GLOBAL_DESIGN.md` | 同步设计契约 |

---

## 6. 风险与回滚
- **v6 数据源体量**:rrc01+rrc06 的 v6 RIB 较小,Phase B 验证快、风险低 —— 这正是"v6 先行"的目的。
- **双 collector ingest 时长/磁盘**:两份 RIB 下载+解析 ≈ 2×;`daily-refresh` 已有"先清旧缓存再下"逻辑,
  需确认同时最多存 2 份 RIB(每点 1 份)而非旧+新叠加。
- **HUGEINT 前端 BigInt 坑**:v6 区间比较必须走 BigInt;留抽样核对避免精度丢失。
- **v4 回归**:Phase C 用"新旧产物逐文件/抽样比对"做硬门槛;不过门不删 SQLite。
- **回滚**:A/B 阶段新管线旁路,线上仍是旧 SQLite 管线,随时可弃。C 阶段在分支/worktree 做,
  比对不过就不合并。

---

## 7. 决策记录

**已定**(本轮拍板):
- **v6/国际 geo = GeoLite2-City.mmdb**;同时用 **GeoLite2-ASN.mmdb** 补 AS organization。ipdb(国内城市级)
  优先,GeoLite 补国际+v6,RIR 兜底;import 期合并为非重叠区间集(§2.6)。
- **CLI 退役所有查询入口**:删 `query/stats/insight` + `report.py`;CLI 仅留部署/处理快捷入口。
- **不留旧 DB / 迁移脚本**:source of truth = 原始 MRT,中间库可丢、reset 重建。
- **拆表粒度**:工作库统一(family 列)+ Parquet 输出按 family 拆(§2.3)。
- **国际→城市:一步到位**:v4/v6 全球都切城市级(§2.6),不再限 `focus_cities`/CN。
- **GeoLite 同步:跟随 MRT**:每次 ingest 先查远端 release 是否更新,过期才下载(§2.6),无独立定时任务。

**无悬而未决项** —— 设计已闭合,可进入实施(Phase A)。

---

## 8. 实施记录 / 经验(随实现更新)

**已完成并验证(后端全链路)**:Phase A(ingest)+ Phase B geo + 导出重写 + Phase C/D 退役 SQLite。
v6 端到端实测通过:ingest(rrc 单点 8000 v6 前缀)→ geo(GeoLite 合并)→ export → 直接查 parquet
(子网搜索/origin/AS_PATH/geo 段)均正确。已删 `db.py`/`report.py`/`build.py`,CLL 去掉 query/stats/insight/geo-lookup。

**踩坑与定论(重要,后续勿重蹈)**:
1. **IP 列必须 `UHUGEINT`(无符号 128 位),不是 `HUGEINT`**:HUGEINT 是有符号(max 2¹²⁷−1),装不下 v6 的
   2¹²⁸−1。且**所有对 UHUGEINT 列的 Python 字面量/参数比较都要 `::UHUGEINT` cast**,否则 DuckDB 把公共类型
   推断成有符号 HUGEINT → v6 高位溢出报错。
2. **DuckDB 把 UHUGEINT 取进 Python(fetchall)极慢**:实测原生取 5 万行 16.6s,VARCHAR cast 取 v6 全量
   86s(大数 → 39 位字符串转换慢)。**解法:SQL 里把 UHUGEINT 拆成 hi/lo 两个 UBIGINT(64 位原生快取),
   Python 端 `hi*2^64+lo` 还原**(932k 行 8.8s,10×)。见 `util.uhuge_halves`。**反过来:UHUGEINT 取进前端
   (DuckDB-WASM)也会丢精度(变 float)** → 前端 v6 比较必须在 SQL 里做(`?::UHUGEINT`),返回展示的 v6 值
   要走 VARCHAR/hi-lo→BigInt 或预算成 CIDR 串,**不要直接把 v6 ip 整数取回 JS**。
3. **carve 在 6M 段 geo 上会炸**:① geo-import 末尾**合并相邻同 (cc,prov,city) 段**(`coalesce_geo`,6.12M→3.39M);
   ② carve 对**覆盖 geo 段数 > `SEG_OVERLAP_CAP`(256)的超大聚合前缀退化为国家级单段**(`carve_cc(cap=)`),
   把成本压到 O(log n)。两者合起来 8000 v6 前缀 carve ~1s。
4. **geo 跟随 ingest**:`ipc ingest` 先 `ensure_geolite`(查 release tag,过期才下),geo 表缺失或 GeoLite 更新时
   才 `build_geo`(否则复用,`--reset` 不清 geo)。`geo_tag` meta 记当前 GeoLite 版本。
5. **代表 cc 用 ASOF join**(`prefix.ip_start` ASOF `geo.start_num`,geo 非重叠 → 取最近 start 再校验 ≤end)。
6. **geo-import 成本**:GeoLite City 5.8M 段遍历 ~225s + 非重叠窗口去重 + 合并,总 ~11min;只在 GeoLite 更新时跑。

**待办(收尾)**:① 前端 v6(`db.js`/`queries.js`/`bgp.js`/`AsnTag`:family 路由 + BigInt/CIDR 展示 + union +
org 显示);② `daily-refresh.sh` 注释更新(双采集点、geo 跟随);③ 全量 v4+v6 真实 ingest 与现网 v4 产物比对;
④ `AGENTS.md`/`README`/`CHANGELOG`/memory 同步。
