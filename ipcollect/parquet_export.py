"""把 **DuckDB 工作库**(store)导出为 Parquet 数据集, 供 DuckDB-WASM 前端按 HTTP Range 查询(无后端)。

按 family 出**两套**(v4 无后缀 / v6 带 `_v6`), 前端按输入 IP 的 family 路由或 union(见 docs/DUCKDB_V6_REFACTOR.md):
  prefixes{,_v6}/   全部前缀, 按 ip_start 排序(子网搜索/父子段/pid 详情)。即 ipindex。
  paths{,_v6}/      每前缀去重 AS_PATH(<=PATH_CAP), 按 pid 排序(insight 抽屉)。
  pathsearch{,_v6}/ 全表一行/前缀(paths_blob+origin_asn+cc), 按 origin_asn 排序(不选国家时全局搜索)。
  geo{,_v6}/<cc>/   国家 working-set: 每 (pid,cc,city) 一行 + segs(本段范围) + paths_blob + prefix。
  meta.json         version + files(含 _v6) + counts + dfz_ref{,_v6} + countries + country_names(country_dim) +
                    cities + asn_names/ops + asn org(asn_dim) + site_base。
另: ssg.generate 产出 c/<cc>.html 双语 SEO 落地页 + sitemap + robots。

**v4/v6 类型**: v4 的 ip_start/ip_end/segs 导成 **BIGINT**(前端按 number 处理, 行为不变);
v6 导成 **UHUGEINT**(DuckDB-WASM 给前端 BigInt, 比较隔离在 v6 路径)。geo 表非重叠 -> 代表 cc 用 ASOF join。
排序/分目录是性能命门(row-group min/max 行级裁剪); duckdb 溢出目录走真盘(store.connect 已配)。
"""
from __future__ import annotations

import csv
import ipaddress
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from . import asset, bgp, geoip, irr, profile, rpki, util


def _subtract(s: int, e: int, holes: list) -> list[tuple]:
    """从 [s,e] 扣掉若干 holes(不相交, 已在 [s,e] 内), 返回剩余区间。位宽无关, v4/v6 通用。
    有效路由范围 = 前缀范围 − 更具体子段(longest-prefix-match: 子段自有路由, 不归母段)。"""
    out, cur = [], s
    for hs, he in sorted(holes):
        if hs > cur:
            out.append((cur, hs - 1))
        cur = max(cur, he + 1)
        if cur > e:
            break
    if cur <= e:
        out.append((cur, e))
    return out

PATH_CAP = 128  # 每前缀导出的去重 AS_PATH 上限(按 path_len ASC, n_peers DESC 取头部)。
                # 4 采集点(rrc01/06/03+route-views2)下 n_distinct_paths max≈94/mean≈69 -> 128 ship 全量且留头room。
                # 注: 这是**会生效的截顶杠杆** —— 再加采集点冲破 128 时此处会静默丢尾, 届时要么提 cap 要么记 log。
                # (24 旧值会截断 ~93% 前缀的路径列表/路由图/AS_PATH 搜索, 掩盖多采集点的路径多样性)。
FILE_SIZE = "16MB"
PATHSEARCH_FILE_SIZE = "6MB"
# prefixes 切得更细 + 每文件 [min ip_start, max ip_end] 区间索引(prefixes_ip), 让精确 IP/子网查询
# 只读区间相交的那 1 个小文件(其余整文件跳过), 而非整套 ~24MB。约 2MB 分片 -> 实测单 IP 查 ~2MB(降 ~12x)。
# **必须单线程 + preserve_insertion_order 写**(见下), 否则多线程并行写令各文件 ip_start 不连续、跨满全表 ->
# 区间索引退化(每文件都覆盖全空间)、裁剪失效。同 pathsearch 的处理。
PREFIX_FILE_SIZE = "2MB"
# carve 时, 若一个前缀覆盖的 geo 段数 > 此值, 视为粗聚合 -> 退化国家级单段(防超大 v6/v4 聚合炸开)。
SEG_OVERLAP_CAP = 256
# 每个 (前缀,城市) 最多内嵌多少条 CIDR 子段(跨城大段会很多, 截断)。
SEG_CAP = 48


def _autnums(url: str) -> dict[int, str]:
    """APNIC autnums(handle 作 ASN 名), 缓存复用; 失败返回空(降级到 config 注册表)。"""
    import requests
    cache = util.CACHE_DIR / "autnums.txt"
    try:
        if not cache.exists() or cache.stat().st_size < 10000:
            util.log(f"  下载 ASN 名称表: {url}")
            cache.write_text(requests.get(url, timeout=180).text, encoding="utf-8", errors="replace")
    except Exception as e:  # noqa
        util.log(f"  ! autnums 下载失败({e}); ASN 名仅用 config 注册表", err=True)
        return {}
    out: dict[int, str] = {}
    for line in cache.read_text(encoding="utf-8", errors="replace").splitlines():
        p = line.strip().split(None, 1)
        if len(p) < 2 or not p[0].isdigit():
            continue
        full = p[1].rsplit(",", 1)[0].strip()
        handle = full.split(" - ", 1)[0].strip()
        if handle:
            out[int(p[0])] = handle[:40]
    return out


def _merge(ivs: list) -> list[tuple]:
    out: list[list] = []
    for s, e in sorted(ivs):
        if out and s <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


def copy_web(out_dir: str = "dist") -> int:
    """把已构建的 Svelte SPA(ipcollect/web/dist/)拷进 out_dir。返回拷贝文件数。"""
    out = Path(out_dir)
    if (out / "assets").exists():
        shutil.rmtree(out / "assets")
    webdist = Path(__file__).resolve().parent / "web" / "dist"
    if not webdist.exists():
        util.log("  ! web/dist 不存在 —— 请先在 ipcollect/web 跑 `npm ci && npm run build`", err=True)
        return 0
    n_files = 0
    for p in webdist.rglob("*"):
        if p.is_file():
            dst = out / p.relative_to(webdist)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, dst); n_files += 1
    return n_files


# ----------------------------------------------------------------------------
# 层状森林 + 有效路由切段(从 DuckDB prefix 读, 位宽无关 Python 整数算)
# ----------------------------------------------------------------------------
def _forest_duck(con, family: int):
    """某 family 前缀的层状(laminar)森林: 栈扫描得 children(pid->[直接子段])。"""
    # UHUGEINT 拆 hi/lo 取(原生快路径, 见 util.uhuge_halves); 避开 UHUGEINT->python/VARCHAR 慢转换。
    SH = util.SH64
    rows = con.execute(
        f"SELECT pid, {util.uhuge_halves('ip_start')}, {util.uhuge_halves('ip_end')} "
        f"FROM prefix WHERE family=? ORDER BY ip_start", [family]).fetchall()
    items = [{"id": int(r[0]), "start": r[1] * SH + r[2], "end": r[3] * SH + r[4]} for r in rows]
    items.sort(key=lambda x: (x["start"], -x["end"]))
    children: dict[int, list] = {}
    stack: list[dict] = []
    for it in items:
        while stack and stack[-1]["end"] < it["start"]:
            stack.pop()
        if stack:
            children.setdefault(stack[-1]["id"], []).append(it)
        stack.append(it)
    return items, children


def _segments_duck(con, cfg: dict, family: int, gindex) -> list[tuple]:
    """对每个前缀: 有效路由范围(自身 − 更具体子段)按 geo 切成各城市子段(所有国家都到城市), 每
    (pid,cc,city) 的子段**在 Python 里直接算成 CIDR 字符串列表**(精度安全, 前端不必再对 v6 128 位做 BigInt 运算)。
    返回 [(pid, cc, province, city, cidrs_space_joined, plen, origin_asn, n_paths), ...]。"""
    items, children = _forest_duck(con, family)
    info = {int(r[0]): r for r in con.execute(
        "SELECT pid, origin_asn, n_paths, plen FROM prefix WHERE family=?", [family]).fetchall()}
    addrcls = ipaddress.IPv4Address if family == 4 else ipaddress.IPv6Address
    out: list[tuple] = []
    done = 0
    for it in items:
        done += 1
        if done % 200000 == 0:
            util.log(f"  carve v{family}: {util.human(done)}/{util.human(len(items))} 前缀, {util.human(len(out))} 段")
        pid = it["id"]
        meta = info.get(pid)
        if not meta:
            continue
        holes = [(k["start"], k["end"]) for k in (children.get(pid) or [])]
        eff = _subtract(it["start"], it["end"], holes)
        groups: dict[tuple, list] = {}
        prov_of: dict[tuple, str] = {}
        for es, ee in eff:
            # cap: 超大聚合前缀(覆盖 >SEG_OVERLAP_CAP 个 geo 段)退化为国家级单段, 防 carve 炸开。
            for cs, ce, cc, prov, city in gindex.carve_cc(es, ee, cap=SEG_OVERLAP_CAP):
                key = (cc, city)
                groups.setdefault(key, []).append((cs, ce))
                prov_of[key] = prov
        for (cc, city), ivs in groups.items():
            cidrs: list[str] = []
            for s, e in _merge(ivs):
                for net in ipaddress.summarize_address_range(addrcls(s), addrcls(e)):
                    cidrs.append(str(net))
                    if len(cidrs) >= SEG_CAP:
                        break
                if len(cidrs) >= SEG_CAP:
                    break
            out.append((pid, cc, prov_of[(cc, city)], city, " ".join(cidrs),
                        meta[3], meta[1], meta[2]))
    return out


# ----------------------------------------------------------------------------
# geo working-set 导出(carve 切段 -> 逐国家 parquet) —— 仅 geo profile(peeras)用; dn42 不调。
# ----------------------------------------------------------------------------
def _carve_geo_dirs(con, cfg: dict, pq: Path, family: int, suffix: str, geodir: str) -> tuple[list, int]:
    """geo{geodir}/<cc>: carve 切段 -> seg 表 -> 每 (cc,city,pid) 一行 segs + paths_blob + prefix, 逐国家写。
    返回 (ccs, n_segs)。依赖已建好的 pp{suffix} 表(每前缀 paths_blob/best_path)。"""
    gindex = geoip.GeoIndexDuck(con, family)
    util.log(f"  geo v{family}: carve 切段(算 CIDR)...")
    segs = _segments_duck(con, cfg, family, gindex)   # 每行已是一个 (pid,cc,city) + 空格分隔 CIDR 串
    seg_csv = os.path.join(tempfile.gettempdir(), f"ipc_seg_{family}_{os.getpid()}.csv")
    with open(seg_csv, "w", newline="", encoding="utf-8") as f:
        csv.writer(f).writerows(segs)
    con.execute("DROP TABLE IF EXISTS seg;")
    con.execute(f"""
        CREATE TABLE seg AS SELECT
            column0::BIGINT AS pid, column1 AS cc, nullif(column2,'') AS province,
            nullif(column3,'') AS city,
            string_split(column4, ' ') AS segs,            -- list<varchar> CIDR(精度安全, 前端直接显示)
            column5::BIGINT AS plen, column6::BIGINT AS origin_asn, column7::BIGINT AS n_paths
        FROM read_csv('{seg_csv}', header=false, auto_detect=false,
            columns={{'column0':'VARCHAR','column1':'VARCHAR','column2':'VARCHAR','column3':'VARCHAR',
                      'column4':'VARCHAR','column5':'VARCHAR','column6':'VARCHAR','column7':'VARCHAR'}});
    """)
    os.remove(seg_csv)
    con.execute("DROP TABLE IF EXISTS geo_full;")
    con.execute(f"""
        CREATE TABLE geo_full AS
        SELECT g.cc, g.city, g.province, g.pid, pfx.prefix, g.plen, g.origin_asn,
               pfx.n_origins, g.n_paths,
               COALESCE(rs.rpki,0)::UTINYINT AS rpki, COALESCE(irs.irr,0)::UTINYINT AS irr,  -- 代表 origin 的 RPKI/IRR
               g.segs, pp.paths_blob, pp.best_path
        FROM seg g
        LEFT JOIN pp{suffix} pp ON pp.pid = g.pid
        LEFT JOIN prefix pfx ON pfx.pid = g.pid
        LEFT JOIN rpki_status rs  ON rs.pid = g.pid  AND rs.origin = g.origin_asn
        LEFT JOIN irr_status  irs ON irs.pid = g.pid AND irs.origin = g.origin_asn;
    """)
    (pq / geodir).mkdir(parents=True, exist_ok=True)
    ccs = [r[0] for r in con.execute(
        "SELECT DISTINCT cc FROM geo_full WHERE cc IS NOT NULL ORDER BY cc").fetchall()]
    util.log(f"  geo v{family}: 逐国家写出 {len(ccs)} 个...")
    for cc in ccs:
        con.execute(f"""
            COPY (SELECT * FROM geo_full WHERE cc='{cc}' ORDER BY city NULLS FIRST, n_paths DESC)
            TO '{pq}/{geodir}/{cc}' (FORMAT parquet, FILE_SIZE_BYTES '{FILE_SIZE}',
                  ROW_GROUP_SIZE 15000, OVERWRITE_OR_IGNORE);
        """)
    return ccs, len(segs)


# ----------------------------------------------------------------------------
# 单 family 导出
# ----------------------------------------------------------------------------
def _export_family(con, cfg: dict, pq: Path, family: int, geo_on: bool = True, has_irr: bool = False) -> dict:
    suffix = "" if family == 4 else "_v6"
    iptype = "BIGINT" if family == 4 else "UHUGEINT"
    geodir = "geo" if family == 4 else "geo_v6"
    util.log(f"  === 导出 family v{family} (suffix='{suffix or '(none)'}', iptype={iptype}) ===")

    # prefixes{suffix}: 全部前缀, 代表 cc/prov/city 来自 pgeo(ASOF), ip 按 family 类型, 按 ip_start 排序。
    # 单线程 + preserve_insertion_order: 令各分片为「连续的 ip_start 区段」, 这样 prefixes_ip 区间索引
    # 才能把精确 IP/子网查询裁到 1 个文件(多线程并行写会打乱、每文件跨满全表 -> 索引失效)。
    (pq / f"prefixes{suffix}").mkdir(parents=True, exist_ok=True)
    con.execute("PRAGMA threads=1;")
    con.execute("SET preserve_insertion_order=true;")
    con.execute(f"""
        COPY (
          SELECT pid, prefix, ip_start::{iptype} AS ip_start, ip_end::{iptype} AS ip_end,
                 plen, family, origin_asn, n_origins, n_paths,
                 origin_asns, origin_npaths,   -- MOAS: 全部 origin(详情抽屉, n_origins=1 时为 NULL)
                 rpki, irr, origin_rpki, origin_irr,   -- RPKI/IRR: 代表 origin 状态 + MOAS 每 origin 数组(与 origin_asns 对齐)
                 COALESCE(cc,'ZZ') AS cc, province, city
          FROM pgeo WHERE family={family} ORDER BY ip_start
        ) TO '{pq}/prefixes{suffix}' (FORMAT parquet, FILE_SIZE_BYTES '{PREFIX_FILE_SIZE}',
              ROW_GROUP_SIZE 20000, OVERWRITE_OR_IGNORE);
    """)
    con.execute("SET preserve_insertion_order=false;")
    con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")

    # paths{suffix}: 每前缀去重 path(<=PATH_CAP), 按 pid 排序。
    (pq / f"paths{suffix}").mkdir(parents=True, exist_ok=True)
    # path_str / path_arr 用 **path_clean**(折叠 prepend) —— 子序列搜索与邻接(asn_neigh)口径不变。
    # path_arr_raw 仅在含 prepend(raw≠clean)时带原始数组(供详情抽屉展示 AS×N), 否则 NULL(parquet 近乎零开销)。
    # is_best / rn 按 path_len(**原始**长度)排序: prepend 拉长的路径自然下沉, best=最短真实 AS_PATH。
    con.execute(f"""
        COPY (
          WITH p AS (
            SELECT pid, ' ' || path_clean || ' ' AS path_str,
                   list_transform(string_split(path_clean,' '), x -> TRY_CAST(x AS BIGINT)) AS path_arr,
                   CASE WHEN path_raw = path_clean THEN NULL
                        ELSE list_transform(string_split(path_raw,' '), x -> TRY_CAST(x AS BIGINT))
                   END AS path_arr_raw,
                   path_len, n_peers,
                   row_number() OVER (PARTITION BY pid ORDER BY path_len ASC, n_peers DESC) AS rn
            FROM pathobs WHERE family={family}
          )
          SELECT pid, path_str, path_arr, path_arr_raw, path_len, n_peers, (rn=1) AS is_best
          FROM p WHERE rn <= {PATH_CAP} ORDER BY pid
        ) TO '{pq}/paths{suffix}' (FORMAT parquet, FILE_SIZE_BYTES '{FILE_SIZE}', OVERWRITE_OR_IGNORE);
    """)

    # pp{suffix}: 每前缀 paths_blob(连续序列 LIKE 用) + best_path。从已写的 paths parquet 聚合(列存可溢出)。
    con.execute(f"DROP TABLE IF EXISTS pp{suffix};")
    con.execute(f"""
        CREATE TABLE pp{suffix} AS
        SELECT pid, string_agg(path_str, '|') AS paths_blob,
               any_value(path_str) FILTER (WHERE is_best) AS best_path
        FROM read_parquet('{pq}/paths{suffix}/*.parquet') GROUP BY pid;
    """)

    # geo working-set(carve 切段 + 逐国家 parquet): 仅 geo profile。dn42(geo_on=False)整段跳过, 无 geo 目录。
    if geo_on:
        ccs, n_segs = _carve_geo_dirs(con, cfg, pq, family, suffix, geodir)
    else:
        ccs, n_segs = [], 0

    # pathsearch{suffix}: 全表一行/(前缀,origin), 按 origin_asn 排序(单线程顺序写 -> 每文件连续 origin 区间)。
    # MOAS 关键: 多源前缀按**每个 origin** 各出一行(o_asn), 这样按任一 origin 搜 AS / 看「该 AS 通告的前缀」
    # 都能命中它(以前只留 arg_max 代表 origin -> 次要 origin 搜不到)。is_primary 标记代表 origin 那行,
    # 供纯 AS_PATH 搜索(不按 origin)去重回每前缀一行。n_paths 仍为前缀总 peer 数(列表排序/低可见行为不变)。
    (pq / f"pathsearch{suffix}").mkdir(parents=True, exist_ok=True)
    con.execute("PRAGMA threads=1;")
    con.execute("SET preserve_insertion_order=true;")
    con.execute(f"""
        COPY (
          WITH po AS (SELECT DISTINCT pid, origin_asn AS o_asn FROM pathobs WHERE family={family})
          SELECT p.pid, p.prefix, COALESCE(p.cc,'ZZ') AS cc,
                 po.o_asn AS origin_asn, p.n_origins, p.n_paths,
                 (po.o_asn IS NOT DISTINCT FROM p.origin_asn) AS is_primary,
                 COALESCE(rs.rpki,0)::UTINYINT AS rpki, COALESCE(irs.irr,0)::UTINYINT AS irr,  -- 该 origin 的 RPKI/IRR 状态
                 pp.paths_blob, pp.best_path
          FROM pgeo p
          JOIN po ON po.pid = p.pid
          LEFT JOIN pp{suffix} pp ON pp.pid = p.pid
          LEFT JOIN rpki_status rs  ON rs.pid = p.pid  AND rs.origin = po.o_asn
          LEFT JOIN irr_status  irs ON irs.pid = p.pid AND irs.origin = po.o_asn
          WHERE p.family={family} ORDER BY po.o_asn NULLS LAST
        ) TO '{pq}/pathsearch{suffix}' (FORMAT parquet, FILE_SIZE_BYTES '{PATHSEARCH_FILE_SIZE}',
              ROW_GROUP_SIZE 15000, OVERWRITE_OR_IGNORE);
    """)
    con.execute("SET preserve_insertion_order=false;")
    con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")

    # byorigin{suffix}: pathsearch 的**精简版** —— 去掉占 ~90% 体积的 paths_blob, 只留 origin 查询要的列。
    # 纯 origin 过滤(ASN/名称/person/MOAS, 不含 AS_PATH 子串)读这套: 文件数与 footer ~10× 缩, 小 ASN 查询最受益。
    # 含 AS_PATH 子串的查询仍走 pathsearch(那里有 paths_blob, 本就要扫)。行/排序与 pathsearch 一致, 索引同构。
    (pq / f"byorigin{suffix}").mkdir(parents=True, exist_ok=True)
    con.execute("PRAGMA threads=1;")
    con.execute("SET preserve_insertion_order=true;")
    con.execute(f"""
        COPY (
          WITH po AS (SELECT DISTINCT pid, origin_asn AS o_asn FROM pathobs WHERE family={family})
          SELECT p.pid, p.prefix, COALESCE(p.cc,'ZZ') AS cc,
                 po.o_asn AS origin_asn, p.n_origins, p.n_paths,
                 (po.o_asn IS NOT DISTINCT FROM p.origin_asn) AS is_primary,
                 COALESCE(rs.rpki,0)::UTINYINT AS rpki, COALESCE(irs.irr,0)::UTINYINT AS irr,
                 pp.best_path
          FROM pgeo p
          JOIN po ON po.pid = p.pid
          LEFT JOIN pp{suffix} pp ON pp.pid = p.pid
          LEFT JOIN rpki_status rs  ON rs.pid = p.pid  AND rs.origin = po.o_asn
          LEFT JOIN irr_status  irs ON irs.pid = p.pid AND irs.origin = po.o_asn
          WHERE p.family={family} ORDER BY po.o_asn NULLS LAST
        ) TO '{pq}/byorigin{suffix}' (FORMAT parquet, FILE_SIZE_BYTES '{PATHSEARCH_FILE_SIZE}',
              ROW_GROUP_SIZE 15000, OVERWRITE_OR_IGNORE);
    """)
    con.execute("SET preserve_insertion_order=false;")
    con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")

    # irr{suffix}: 库内已观测前缀 ∩ IRR route 对象(精确前缀匹配), 每 (pid,origin) 一行 + 来源库数组。
    # 按 ip_start 排序 + v4 区间索引(irr_ip), 供详情面板按前缀范围只读相交分片(同 prefixes 思路)。
    if has_irr:
        (pq / f"irr{suffix}").mkdir(parents=True, exist_ok=True)
        con.execute("PRAGMA threads=1;")
        con.execute("SET preserve_insertion_order=true;")
        con.execute(f"""
            COPY (
              SELECT p.pid, p.prefix, p.ip_start::{iptype} AS ip_start, p.ip_end::{iptype} AS ip_end,
                     ir.origin, list(DISTINCT ir.source ORDER BY ir.source) AS sources
              FROM prefix p JOIN irr_route ir
                ON ir.family = p.family AND ir.ip_start = p.ip_start AND ir.ip_end = p.ip_end
              WHERE p.family={family}
              GROUP BY p.pid, p.prefix, p.ip_start, p.ip_end, ir.origin
              ORDER BY p.ip_start
            ) TO '{pq}/irr{suffix}' (FORMAT parquet, FILE_SIZE_BYTES '{PATHSEARCH_FILE_SIZE}',
                  ROW_GROUP_SIZE 15000, OVERWRITE_OR_IGNORE);
        """)
        con.execute("SET preserve_insertion_order=false;")
        con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")

    n_prefix = con.execute("SELECT count(*) FROM prefix WHERE family=?", [family]).fetchone()[0]
    n_paths = con.execute("SELECT count(*) FROM pathobs WHERE family=?", [family]).fetchone()[0]
    dfz_ref = con.execute(
        "SELECT quantile_cont(n_paths, 0.9) FROM prefix WHERE family=?", [family]).fetchone()[0] or 1
    return {"suffix": suffix, "geodir": geodir, "ccs": ccs, "n_prefix": int(n_prefix),
            "n_paths": int(n_paths), "n_segs": n_segs, "dfz_ref": int(round(dfz_ref))}


# ----------------------------------------------------------------------------
# ASN 邻接事实预计算
# ----------------------------------------------------------------------------
# TIER1 **必须镜像** web/src/lib/bgp.js 的 TIER1(弱/强证据门控用)。改一处务必同步两处。
TIER1 = [174, 701, 702, 1239, 1299, 2828, 2914, 3257, 3320, 3356, 3491, 5511, 6453, 6461,
         6762, 6830, 6939, 7018, 7473, 12956, 1273, 3549, 3551, 209]


def _build_asn_neigh(con, pq: Path) -> bool:
    """从已写出的 paths{,_v6} parquet 算全局 AS 邻接计数 -> asn_neigh/(按 asn 排序 + 数值区间索引)。
    每条 (asn,neighbor)：d=强下游证据(neighbor 在 origin 侧 且 X 的收集器侧已过 Tier-1) / u=强上游 / w=弱上 / wd=弱下。
    **只算计数(事实)**；up/peer/down 分类不在此做、留前端 groupRelations。无 paths 则返回 False(has_asn_neigh=False)。"""
    import glob
    files = glob.glob(str(pq / "paths" / "*.parquet")) + glob.glob(str(pq / "paths_v6" / "*.parquet"))
    if not files:
        return False
    src = "read_parquet([" + ",".join("'" + f.replace("\\", "/") + "'" for f in files) + "])"
    ft1 = "least(" + ",".join(f"coalesce(list_position(a,{x}),2000000000)" for x in TIER1) + ")"
    util.log("  asn_neigh: 预计算 AS 邻接计数(d/u/w/wd)...")
    con.execute("DROP TABLE IF EXISTS asn_neigh;")
    con.execute(f"""
        CREATE TABLE asn_neigh AS
        WITH base AS (
            SELECT pid, path_arr AS a, len(path_arr) AS L, {ft1} AS ft1
            FROM {src} WHERE path_arr IS NOT NULL AND len(path_arr) >= 2
        ),
        adj AS (   -- 每条路径展开成相邻 AS 对; weak = X 收集器侧之前无 Tier-1(方向证据不可靠)。带 pid/L 供取代表样本。
            SELECT pid, L, list_extract(a, j) AS asn, list_extract(a, j + 1) AS nb, (ft1 >= j) AS weak, FALSE AS isleft
            FROM base, range(1, L) g(j) WHERE list_extract(a, j) <> list_extract(a, j + 1)
            UNION ALL
            SELECT pid, L, list_extract(a, j) AS asn, list_extract(a, j - 1) AS nb, (ft1 >= j) AS weak, TRUE AS isleft
            FROM base, range(2, L + 1) g(j) WHERE list_extract(a, j) <> list_extract(a, j - 1)
        ),
        agg AS (
            SELECT asn, nb AS neighbor,
                   count(*) FILTER (WHERE NOT isleft AND NOT weak)::INT AS d,
                   count(*) FILTER (WHERE isleft     AND NOT weak)::INT AS u,
                   count(*) FILTER (WHERE isleft     AND weak)::INT     AS w,
                   count(*) FILTER (WHERE NOT isleft AND weak)::INT     AS wd,
                   arg_min(pid, L)::BIGINT AS ev_pid   -- 代表样本: 含该邻接的最短路径的 pid
            FROM adj WHERE asn IS NOT NULL AND nb IS NOT NULL GROUP BY asn, nb
        )
        -- 顺手取该 pid 的前缀串(ev_prefix), 详情弹窗直接显示"在哪条 prefix 上观测到"; path 仍点开按 pid 懒查。
        SELECT g.asn, g.neighbor, g.d, g.u, g.w, g.wd, g.ev_pid, p.prefix AS ev_prefix
        FROM agg g LEFT JOIN prefix p ON p.pid = g.ev_pid;
    """)
    n = con.execute("SELECT count(*) FROM asn_neigh").fetchone()[0]
    (pq / "asn_neigh").mkdir(parents=True, exist_ok=True)
    con.execute("PRAGMA threads=1;")
    con.execute("SET preserve_insertion_order=true;")   # 按 asn 连续区段写 -> 数值区间索引可裁到 1 文件
    con.execute(f"""COPY (SELECT asn, neighbor, d, u, w, wd, ev_pid, ev_prefix FROM asn_neigh ORDER BY asn)
        TO '{pq}/asn_neigh' (FORMAT parquet, FILE_SIZE_BYTES '6MB', OVERWRITE_OR_IGNORE);""")
    con.execute("SET preserve_insertion_order=false;")
    con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")
    con.execute("DROP TABLE IF EXISTS asn_neigh;")
    util.log(f"  asn_neigh: {util.human(n)} 条 (asn,neighbor) 邻接")
    return True


# ----------------------------------------------------------------------------
# 主导出
# ----------------------------------------------------------------------------
def export(cfg: dict, con, out_dir: str = "dist") -> dict:
    """从 DuckDB 工作库(con)导出 Parquet 数据集(v4 + v6)。"""
    out = Path(out_dir)
    data = out / "data"
    pq = data / "parquet"
    if pq.exists():
        shutil.rmtree(pq)
    pq.mkdir(parents=True, exist_ok=True)

    n_files = copy_web(out_dir)

    geo_on = profile.features(cfg)["geo"]   # peeras=True(现状); dn42=False(无地理: pgeo 不连 geo, 无国家 SSG)

    # 代表 geo(每前缀网络地址点查, geo 非重叠 -> ASOF 取 start<=ip_start 的最近段, 再校验 <=end)。
    # geo 关闭时(无 geo 表)退化为不连地理的 pgeo(cc/province/city 全 NULL), 下游 COALESCE 成 'ZZ'。
    # MOAS: 每个**多源**前缀(n_origins>1)的全部 origin + 各自 peer 观测数(按 peer 降序)。
    # 供详情抽屉完整(可折叠)展示。单源前缀不进表 -> pgeo LEFT JOIN 后 origin_asns 为 NULL(parquet 近乎零成本)。
    # ── RPKI ROA + IRR route 验证(rpki.py/irr.py): 对每条 (前缀,origin) 标状态; 数据缺失则空表 -> has_*=False 自动 no-op ──
    rpki_meta = rpki.attach(con, cfg)
    irr_meta = irr.attach(con, cfg)
    asset_meta = asset.attach(con, cfg)   # IRR as-set 层级树(Phase 3): as_set/as_set_member/as_memberof 表
    has_asset = bool(asset_meta)
    con.execute("DROP TABLE IF EXISTS route_origin;")
    con.execute("""
        CREATE TABLE route_origin AS
        SELECT DISTINCT p.pid, p.family, p.ip_start, p.ip_end, p.plen, po.origin_asn AS origin
        FROM prefix p JOIN (SELECT DISTINCT pid, origin_asn FROM pathobs) po USING(pid)
        WHERE po.origin_asn IS NOT NULL;
    """)
    # classify 包 try/except: 数据形状异常(尤其未充分验证的 dn42 路径)只降级到 has_*=False, 绝不让整个导出失败。
    has_rpki = has_irr = False
    if rpki_meta:
        try:
            util.log(f"  RPKI: 验证 (VRP {util.human(rpki_meta['count'])}, as of {rpki_meta.get('as_of_str')})")
            rpki.classify(con); has_rpki = True
        except Exception as e:  # noqa
            util.log(f"  ! RPKI classify 失败, 降级(无 RPKI 标注): {e}", err=True)
            rpki.empty_status(con)
    else:
        rpki.empty_status(con)
    if irr_meta:
        try:
            util.log(f"  IRR: 验证 (route {util.human(irr_meta['count'])} 对象, {len(irr_meta.get('sources') or [])} 源)")
            irr.classify(con); has_irr = True
        except Exception as e:  # noqa
            util.log(f"  ! IRR classify 失败, 降级(无 IRR 标注): {e}", err=True)
            irr.empty_status(con)
    else:
        irr.empty_status(con)

    # prefix_origins(MOAS 详情): 全部 origin + peer 数 + 各 origin 的 rpki/irr 状态(数组与 origin_asns 对齐)。
    con.execute("DROP TABLE IF EXISTS prefix_origins;")
    con.execute("""
        CREATE TABLE prefix_origins AS
        SELECT pid,
               list(origin_asn ORDER BY ns DESC, origin_asn) AS origin_asns,
               list(ns        ORDER BY ns DESC, origin_asn) AS origin_npaths,
               list(COALESCE(rpki,0)::UTINYINT ORDER BY ns DESC, origin_asn) AS origin_rpki,
               list(COALESCE(irr,0)::UTINYINT  ORDER BY ns DESC, origin_asn) AS origin_irr
        FROM (
            SELECT po.pid, po.origin_asn, sum(po.n_peers)::BIGINT AS ns, rs.rpki, irs.irr
            FROM pathobs po JOIN prefix p ON p.pid = po.pid AND p.n_origins > 1
            LEFT JOIN rpki_status rs  ON rs.pid = po.pid  AND rs.origin = po.origin_asn
            LEFT JOIN irr_status  irs ON irs.pid = po.pid AND irs.origin = po.origin_asn
            GROUP BY po.pid, po.origin_asn, rs.rpki, irs.irr
        ) GROUP BY pid;
    """)

    con.execute("DROP TABLE IF EXISTS pgeo;")
    if geo_on:
        con.execute("""
            CREATE TABLE pgeo AS
            WITH px AS (   -- 先把 MOAS origins 列 + 代表 origin 的 rpki/irr 贴上(普通 join), 再做 ASOF(不与其它 join 类型混链)
                SELECT p.pid, p.family, p.prefix, p.ip_start, p.ip_end, p.plen,
                       p.origin_asn, p.n_origins, p.n_paths, mo.origin_asns, mo.origin_npaths,
                       mo.origin_rpki, mo.origin_irr,
                       COALESCE(rs.rpki,0)::UTINYINT AS rpki, COALESCE(irs.irr,0)::UTINYINT AS irr
                FROM prefix p
                LEFT JOIN prefix_origins mo ON mo.pid = p.pid
                LEFT JOIN rpki_status rs  ON rs.pid = p.pid  AND rs.origin = p.origin_asn
                LEFT JOIN irr_status  irs ON irs.pid = p.pid AND irs.origin = p.origin_asn
            )
            SELECT px.pid, px.family, px.prefix, px.ip_start, px.ip_end, px.plen,
                   px.origin_asn, px.n_origins, px.n_paths,
                   px.origin_asns, px.origin_npaths, px.origin_rpki, px.origin_irr, px.rpki, px.irr,
                   CASE WHEN g.start_num IS NOT NULL AND px.ip_start <= g.end_num THEN g.cc END AS cc,
                   CASE WHEN g.start_num IS NOT NULL AND px.ip_start <= g.end_num THEN g.province END AS province,
                   CASE WHEN g.start_num IS NOT NULL AND px.ip_start <= g.end_num THEN g.city END AS city
            FROM px
            ASOF LEFT JOIN geo g ON px.family = g.family AND px.ip_start >= g.start_num;
        """)
    else:
        con.execute("""
            CREATE TABLE pgeo AS
            SELECT p.pid, p.family, p.prefix, p.ip_start, p.ip_end, p.plen,
                   p.origin_asn, p.n_origins, p.n_paths,
                   mo.origin_asns, mo.origin_npaths, mo.origin_rpki, mo.origin_irr,
                   COALESCE(rs.rpki,0)::UTINYINT AS rpki, COALESCE(irs.irr,0)::UTINYINT AS irr,
                   CAST(NULL AS VARCHAR) AS cc, CAST(NULL AS VARCHAR) AS province,
                   CAST(NULL AS VARCHAR) AS city
            FROM prefix p
            LEFT JOIN prefix_origins mo ON mo.pid = p.pid
            LEFT JOIN rpki_status rs  ON rs.pid = p.pid  AND rs.origin = p.origin_asn
            LEFT JOIN irr_status  irs ON irs.pid = p.pid AND irs.origin = p.origin_asn;
        """)

    families = [r[0] for r in con.execute(
        "SELECT DISTINCT family FROM prefix ORDER BY family").fetchall()]
    fam_results = {f: _export_family(con, cfg, pq, f, geo_on, has_irr) for f in families}

    # ── as-set 层级树数据集(Phase 3): 一级成员边 + 反查; 各按字符串键排序写, 配文件级区间索引供前端懒展开 ──
    if has_asset:
        try:
            for nm in ("asset_set", "asset_member", "asset_memberof"):
                (pq / nm).mkdir(parents=True, exist_ok=True)
            con.execute("PRAGMA threads=1;")
            con.execute("SET preserve_insertion_order=true;")
            con.execute(f"""COPY (SELECT set_key, source, name, descr, n_members FROM as_set ORDER BY set_key)
                TO '{pq}/asset_set' (FORMAT parquet, FILE_SIZE_BYTES '4MB', OVERWRITE_OR_IGNORE);""")
            con.execute(f"""COPY (SELECT set_key, ord, kind, val FROM as_set_member ORDER BY set_key, ord)
                TO '{pq}/asset_member' (FORMAT parquet, FILE_SIZE_BYTES '4MB', OVERWRITE_OR_IGNORE);""")
            con.execute(f"""COPY (SELECT member, parent_key FROM as_memberof ORDER BY member)
                TO '{pq}/asset_memberof' (FORMAT parquet, FILE_SIZE_BYTES '4MB', OVERWRITE_OR_IGNORE);""")
            con.execute("SET preserve_insertion_order=false;")
            con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")
        except Exception as e:  # noqa  数据异常只降级, 不让整个导出失败
            util.log(f"  ! as-set 导出失败, 降级(无 as-set 树): {e}", err=True)
            has_asset = False
            con.execute("SET preserve_insertion_order=false;")
            con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")
            for nm in ("asset_set", "asset_member", "asset_memberof"):
                shutil.rmtree(pq / nm, ignore_errors=True)

    # ── ASN 邻接事实预计算(asn_neigh): 替代前端「完整邻居」的全表扫(原 LIKE 全 pathsearch + 2 万截断)。
    #    **只预计算邻接计数**(d/u/w/wd = 强下/强上/弱上/弱下证据)；up/peer/down **分类仍在前端**
    #    (queries.js groupRelations/classifyRelation)做 —— 算法可调、改判定不必重导出。约 +30s / ~4MB。
    #    **TIER1 必须与 web/src/lib/bgp.js 的 TIER1 一致**(弱/强证据按"X 收集器侧之前是否有 Tier-1"门控)。
    try:
        has_asn_neigh = _build_asn_neigh(con, pq)
    except Exception as e:  # noqa
        util.log(f"  ! asn_neigh 预计算失败, 降级(完整邻居回退前端全表扫): {e}", err=True)
        has_asn_neigh = False
        con.execute("SET preserve_insertion_order=false;")
        con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")
        shutil.rmtree(pq / "asn_neigh", ignore_errors=True)

    # ── origin_counts: 每 origin 通告前缀数(v4/v6) 预聚合(跨 family, 单小文件 ~<1MB)。
    #    ASN 视图「通告 N 个前缀」O(1) 直读, 免去 showAsn 里对分片做运行时 SUM 聚合。
    try:
        (pq / "origin_counts").mkdir(parents=True, exist_ok=True)
        con.execute("PRAGMA threads=1;")
        con.execute("SET preserve_insertion_order=true;")
        con.execute(f"""COPY (
            SELECT origin_asn,
                   count(DISTINCT pid) FILTER (WHERE family=4)::BIGINT AS n_v4,
                   count(DISTINCT pid) FILTER (WHERE family=6)::BIGINT AS n_v6
            FROM pathobs WHERE origin_asn IS NOT NULL
            GROUP BY origin_asn ORDER BY origin_asn
        ) TO '{pq}/origin_counts' (FORMAT parquet, FILE_SIZE_BYTES '8MB', OVERWRITE_OR_IGNORE);""")
        con.execute("SET preserve_insertion_order=false;")
        con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")
        has_origin_counts = True
    except Exception as e:  # noqa  失败只降级(前端回退分片聚合计数)
        util.log(f"  ! origin_counts 预聚合失败, 降级: {e}", err=True)
        has_origin_counts = False
        con.execute("SET preserve_insertion_order=false;")
        con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")
        shutil.rmtree(pq / "origin_counts", ignore_errors=True)

    # 数据里出现过的 ASN(路径上 + origin), 名称表只保留这些。
    seen: set[int] = set()
    for f in families:
        suf = fam_results[f]["suffix"]
        for r in con.execute(
                f"SELECT DISTINCT unnest(path_arr) a FROM read_parquet('{pq}/paths{suf}/*.parquet')").fetchall():
            if r[0] is not None:
                seen.add(int(r[0]))
    for r in con.execute("SELECT DISTINCT origin_asn FROM prefix WHERE origin_asn IS NOT NULL").fetchall():
        seen.add(int(r[0]))

    # ASN 名称 + person 导航 + whois。site 决定来源:
    #   dn42  -> registry(as-name / aut-num→person / 静态 whois); 无 org(asn_dim)。
    #   peeras-> APNIC autnums + config 注册表 + GeoLite org(asn_dim)。
    persons_meta: list = []
    asn_person_meta: dict = {}
    if profile.site(cfg) == "dn42":
        from . import registry
        reg = registry.load(cfg)
        asnames = {a: reg["asn_names"][a] for a in seen if a in reg["asn_names"]}
        persons_meta, asn_person_meta = registry.export_dn42(reg, data, seen, con)
        asnorg: dict = {}
    else:
        autnums = _autnums(cfg.get("autnums_url") or "https://thyme.apnic.net/current/data-used-autnums")
        asnames = {a: autnums[a] for a in seen if a in autnums}
        for e in (cfg.get("asn_registry") or []):
            if str(e.get("asn", "")).isdigit() and e.get("name"):
                asnames[int(e["asn"])] = e["name"]
        asnorg = {}
        if con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name='asn_dim'").fetchone()[0]:
            for a, o in con.execute("SELECT asn, org FROM asn_dim").fetchall():
                if int(a) in seen:
                    asnorg[str(int(a))] = o
    (data / "asnames.json").write_text(
        json.dumps({str(k): v for k, v in asnames.items()}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    (data / "asnorg.json").write_text(
        json.dumps(asnorg, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    util.log(f"  asnames.json: {len(asnames)} 名; asnorg.json: {len(asnorg)} org; persons: {len(persons_meta)}")

    # 文件清单 + 区间索引(前端 HTTP 不能 glob)
    def _rel(sub):
        d = pq / sub
        return sorted(str(p.relative_to(pq)).replace("\\", "/")
                      for p in d.rglob("*.parquet")) if d.exists() else []

    def _pid_index(file_list):
        out_ = []
        for f in file_list:
            lo, hi = con.execute(f"SELECT min(pid), max(pid) FROM read_parquet('{pq}/{f}')").fetchone()
            if lo is not None:
                out_.append({"f": f, "lo": int(lo), "hi": int(hi)})
        out_.sort(key=lambda e: e["lo"])
        return out_

    def _ip_index_v4(file_list):
        # 每文件 [min ip_start, max ip_end] 区间(前端按与查询 [start,end] 相交裁剪文件)。
        # **仅 v4**: v4 的 ip 列是 BIGINT(精确)。v6 的 UHUGEINT 写进 parquet 会退化成 DOUBLE(有损,
        # 边界可偏差 ~2^76), 据此裁剪有"误跳过覆盖文件"的风险; 且 v6 prefixes 仅 1~2 个小文件、收益甚微,
        # 故 v6 不建索引(前端 prefixesFilesForRange 对 v6 回退读全部, 行为不变)。
        out_ = []
        for f in file_list:
            lo, hi = con.execute(f"SELECT min(ip_start), max(ip_end) FROM read_parquet('{pq}/{f}')").fetchone()
            if lo is not None:
                out_.append({"f": f, "lo": int(lo), "hi": int(hi)})
        out_.sort(key=lambda e: e["lo"])
        return out_

    def _origin_index(file_list):
        out_ = []
        for f in file_list:
            lo, hi = con.execute(f"SELECT min(origin_asn), max(origin_asn) FROM read_parquet('{pq}/{f}')").fetchone()
            out_.append({"f": f, "lo": (int(lo) if lo is not None else None),
                         "hi": (int(hi) if hi is not None else None)})
        return out_

    def _num_index(file_list, col):
        out_ = []
        for f in file_list:
            lo, hi = con.execute(f"SELECT min({col}), max({col}) FROM read_parquet('{pq}/{f}')").fetchone()
            out_.append({"f": f, "lo": (int(lo) if lo is not None else None),
                         "hi": (int(hi) if hi is not None else None)})
        out_.sort(key=lambda e: (e["lo"] if e["lo"] is not None else 0))
        return out_

    def _str_index(file_list, col):
        # 每文件 [min,max] 字符串区间(前端按 set_key/member 字符串相等裁文件; 数据已按该列排序 -> 区间不重叠)。
        out_ = []
        for f in file_list:
            lo, hi = con.execute(f"SELECT min({col}), max({col}) FROM read_parquet('{pq}/{f}')").fetchone()
            if lo is not None:
                out_.append({"f": f, "lo": lo, "hi": hi})
        out_.sort(key=lambda e: e["lo"])
        return out_

    files: dict = {}
    for f in families:
        r = fam_results[f]; suf = r["suffix"]; gd = r["geodir"]
        files[f"prefixes{suf}"] = _rel(f"prefixes{suf}")
        if f == 4:   # v4 only(见 _ip_index_v4: v6 的 ip 列在 parquet 里是有损 DOUBLE, 不建索引)
            files["prefixes_ip"] = _ip_index_v4(files["prefixes"])
        files[f"paths{suf}"] = _rel(f"paths{suf}")
        files[f"pathsearch{suf}"] = _rel(f"pathsearch{suf}")
        files[f"paths_pid{suf}"] = _pid_index(files[f"paths{suf}"])
        files[f"pathsearch_origin{suf}"] = _origin_index(files[f"pathsearch{suf}"])
        # byorigin: pathsearch 精简版(无 paths_blob) + 同构 origin 区间索引, 供纯 origin 查询走轻量分片。
        files[f"byorigin{suf}"] = _rel(f"byorigin{suf}")
        files[f"byorigin_origin{suf}"] = _origin_index(files[f"byorigin{suf}"])
        files[("geo" if f == 4 else "geo_v6")] = {cc: _rel(f"{gd}/{cc}") for cc in r["ccs"]}
        if has_irr:   # IRR route 对象明细数据集 + v4 区间索引(同 prefixes_ip; v6 前端读全部)
            files[f"irr{suf}"] = _rel(f"irr{suf}")
            if f == 4:
                files["irr_ip"] = _ip_index_v4(files["irr"])

    if has_asset:   # as-set 三数据集 + 字符串键文件级索引(前端懒展开/反查只读相关分片)
        files["asset_set"] = _rel("asset_set")
        files["asset_member"] = _rel("asset_member")
        files["asset_memberof"] = _rel("asset_memberof")
        files["asset_set_key"] = _str_index(files["asset_set"], "set_key")
        files["asset_member_key"] = _str_index(files["asset_member"], "set_key")
        files["asset_memberof_key"] = _str_index(files["asset_memberof"], "member")
    if has_asn_neigh:   # ASN 邻接计数 + asn 数值区间索引(完整邻居只读覆盖该 asn 的 1 分片)
        files["asn_neigh"] = _rel("asn_neigh")
        files["asn_neigh_key"] = _num_index(files["asn_neigh"], "asn")
    if has_origin_counts:   # 每 origin 通告前缀数(v4/v6) 预聚合, 单小文件按 origin 排序
        files["origin_counts"] = _rel("origin_counts")

    # 国家清单(union 两 family) + 双语名(country_dim) + 各国城市清单(侧栏导航)。
    # carve 把**所有**国家都切到城市级, 故城市下拉对每个国家都构建(不再限定焦点国)。
    # geo 关闭(dn42)则全空 —— 无 country_dim 表、无地理可言。
    countries: list = []
    country_names: dict = {}
    country_names_en: dict = {}
    cities: dict = {}
    if geo_on:
        countries = [{"cc": r[0], "n_prefix": int(r[1])} for r in con.execute(
            "SELECT COALESCE(cc,'ZZ') cc, count(*) c FROM pgeo WHERE cc IS NOT NULL GROUP BY 1 ORDER BY c DESC").fetchall()]
        cn_rows = con.execute("SELECT cc, name_zh, name_en FROM country_dim").fetchall()
        country_names = {r[0]: r[1] for r in cn_rows if r[1]}
        country_names_en = {r[0]: r[2] for r in cn_rows if r[2]}
        # 城市统计从 v4 seg 难取(seg 表已被 v6 覆盖); 改从 pgeo 的代表 city 取(够导航用)。一次出全部国家。
        # HAVING count>=2 滤掉「全国仅 1 前缀」的碎地名(GeoLite 城市粒度过细, 如 US 8k+ 地名), 当导航无意义。
        for cc, city, c in con.execute(
            "SELECT cc, city, count(*) c FROM pgeo WHERE cc IS NOT NULL AND city IS NOT NULL "
            "GROUP BY cc, city HAVING count(*) >= 2 ORDER BY cc, c DESC").fetchall():
            cities.setdefault(cc, []).append({"name": city, "n_prefix": int(c)})

    n_prefix_total = sum(fam_results[f]["n_prefix"] for f in families)
    n_paths_total = sum(fam_results[f]["n_paths"] for f in families)
    n_segs_total = sum(fam_results[f]["n_segs"] for f in families)
    now = int(time.time())
    import hashlib as _hashlib
    version = _hashlib.sha1(json.dumps(
        {"files": files, "n": n_prefix_total, "p": n_paths_total, "ts": now},
        sort_keys=True, default=str).encode()).hexdigest()[:12]

    counts = {"prefixes": fam_results.get(4, {}).get("n_prefix", 0),
              "prefixes_v6": fam_results.get(6, {}).get("n_prefix", 0),
              "paths": fam_results.get(4, {}).get("n_paths", 0),
              "paths_v6": fam_results.get(6, {}).get("n_paths", 0),
              "segments": n_segs_total}
    meta = {
        "version": version,
        # 列能力标志: geo/pathsearch 现含 n_origins(MOAS 角标)。旧前端缺标志即视为 false, 不 SELECT 该列 ->
        # 新前端 + 旧数据(无此列)不会报错; 下次刷新后自动点亮列表角标。
        "has_n_origins": True,
        # MOAS v2: pathsearch 按 (前缀,origin) 多行 + is_primary; prefixes 带 origin_asns/origin_npaths 数组。
        # 门控: 详情抽屉完整 origin 列表、纯 path 搜索 is_primary 去重、按次要 origin 搜索命中。
        "has_moas": True,
        # RPKI ROA / IRR route 验证: 列表/详情徽章 + 详情 IRR 区块。数据缺失(import 没跑/开关关)即 False, 前端不 SELECT 该列。
        "has_rpki": has_rpki,
        "has_irr": has_irr,
        "rpki": ({"as_of": rpki_meta.get("as_of_str"), "count": rpki_meta.get("count"),
                  "source": rpki_meta.get("source")} if has_rpki else None),
        "irr": ({"as_of": irr_meta.get("as_of_str"), "count": irr_meta.get("count"),
                 "sources": irr_meta.get("sources"), "authoritative": irr_meta.get("authoritative")} if has_irr else None),
        # as-set 客户锥层级树(Phase 3): 懒展开/反查。
        "has_asset": has_asset,
        "asset": ({"as_of": asset_meta.get("as_of_str"), "n_sets": asset_meta.get("n_sets"),
                   "n_edges": asset_meta.get("n_edges"), "sources": asset_meta.get("sources"),
                   "authoritative": asset_meta.get("authoritative")} if has_asset else None),
        # ASN 邻接计数预计算(完整邻居视图改读索引分片, 不再前端全表扫; 分类仍前端做)。
        "has_asn_neigh": has_asn_neigh,
        # byorigin: pathsearch 精简版(无 paths_blob), 纯 origin 查询走它; origin_counts: 每 origin 前缀数预聚合。
        # 门控: 缺标志(旧数据)时前端回退用 pathsearch + 运行时聚合, 行为不变。
        "has_byorigin": all(f"byorigin{fam_results[f]['suffix']}" in files and files[f"byorigin{fam_results[f]['suffix']}"] for f in families),
        "has_origin_counts": has_origin_counts,
        "files": files,
        "generated_ts": now,
        "generated_str": time.strftime("%Y-%m-%d %H:%M", time.localtime(now)),
        "scope": "global",
        "site": profile.site(cfg),
        "families": families,
        "collectors": [c for c in (cfg.get("mrt_collectors") or [cfg.get("mrt_collector")]) if c],
        "site_base": cfg.get("site_base") or "https://peer.as",
        "counts": counts,
        "dfz_ref": fam_results.get(4, {}).get("dfz_ref", 1),
        "dfz_ref_v6": fam_results.get(6, {}).get("dfz_ref", 1),
        "countries": countries,
        "country_names": country_names,
        "country_names_en": country_names_en,
        "cities": cities,
        # dn42: 按 person 导航(取代国家/地区)。persons=[{id,name,asns,n_prefix}]; asn_person={asn:pid}。peeras 为空。
        "persons": persons_meta,
        "asn_person": asn_person_meta,
        # asn 名称: dn42 用 registry as-name(seen 集); peeras 用 config 注册表(高亮集, 大表在 asnames.json)。
        "asn_names": ({str(a): n for a, n in asnames.items()} if profile.site(cfg) == "dn42"
                      else {str(a): v["name"] for a, v in bgp.ASN_REGISTRY.items()}),
        "asn_names_en": {str(a): v["name_en"] for a, v in bgp.ASN_REGISTRY.items() if v.get("name_en")},
        "asn_ops": {str(a): v["op"] for a, v in bgp.ASN_REGISTRY.items() if v.get("op")},
    }
    data.mkdir(parents=True, exist_ok=True)
    (data / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

    # SSG(SEO 落地页) —— 读 pgeo(代表 cc)取各国 top origin。geo 关闭(dn42)则无国家落地页(Phase2 改按 ASN)。
    if geo_on:
        from . import ssg
        n_ssg = ssg.generate(out, meta, con, asnames)
    else:
        n_ssg = 0

    total_bytes = sum(p.stat().st_size for p in pq.rglob("*.parquet"))
    n_pqfiles = sum(1 for _ in pq.rglob("*.parquet"))
    return {"out": str(out), "parquet_files": n_pqfiles, "parquet_bytes": total_bytes,
            "prefixes": n_prefix_total, "paths": n_paths_total, "segments": n_segs_total,
            "countries": len(countries), "ssg_pages": n_ssg,
            "v4": fam_results.get(4, {}).get("n_prefix", 0),
            "v6": fam_results.get(6, {}).get("n_prefix", 0)}
