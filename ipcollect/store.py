"""DuckDB 工作存储 —— 取代 SQLite 作为 ingest 的可变中间库(见 docs/DUCKDB_V6_REFACTOR.md)。

为什么换掉 SQLite:
  * 去重从"逐前缀 UPSERT + DELETE 重插"变成一句 `GROUP BY`(见 finalize)。
  * 128 位 v6 地址靠 **UHUGEINT** 原生装下(SQLite INTEGER 只有 64 位, 装不下)。
  * 导出本就在 DuckDB —— 现在 ingest 也在 DuckDB, 去掉 SQLite→DuckDB 的 ATTACH 桥。

**UHUGEINT 关键坑**:ip_start/ip_end 用 UHUGEINT(无符号 128 位, 0..2^128-1), 同时容纳
v4(≤2^32) 与 v6(≤2^128-1)。但比较/参数绑定时 DuckDB 会把公共类型推断成**有符号** HUGEINT
(max 2^127-1) -> v6 高位地址溢出报错。故所有对 UHUGEINT 列的字面量/参数比较都要 `::UHUGEINT`。

数据流:
  ingest 期 -> obs(每 collector 去重后的 (prefix,path) 行, 带 n_peers 与 collector 标签)
  finalize() -> pathobs(跨 collector 合并同 path, 累加 n_peers) + prefix(每前缀一行 + pid + 代表 origin)
  export 直接读本库(无 ATTACH)。
"""
from __future__ import annotations

import csv
import os
from pathlib import Path
from typing import Optional

from . import util

# obs: ingest 落盘的中间观测。每行 = 某 collector 下、某前缀的一条去重 AS_PATH(已在 Python 端按
# (prefix,path) 去重、n_peers=该 collector 里观测到此 path 的 peer 数)。跨 collector 合并留给 finalize。
OBS_DDL = """
CREATE TABLE IF NOT EXISTS obs (
    prefix     VARCHAR,
    ip_start   UHUGEINT,
    ip_end     UHUGEINT,
    family     UTINYINT,
    plen       UTINYINT,
    path_raw   VARCHAR,
    path_clean VARCHAR,
    path_len   USMALLINT,
    origin_asn BIGINT,
    collector  VARCHAR,
    n_peers    UINTEGER
);
CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR);
"""

# obs CSV 列序(Python 写 / DuckDB read_csv 读, 必须一致)
_OBS_COLS = ["prefix", "ip_start", "ip_end", "family", "plen",
             "path_raw", "path_clean", "path_len", "origin_asn", "collector", "n_peers"]


def connect(path: Optional[Path] = None, *, read_only: bool = False):
    """连 DuckDB 工作库, 套用线程/内存/溢出目录(沿用 IPC_DUCKDB_* 环境变量与 cache/duck_tmp 真盘)。"""
    import duckdb
    p = str(path or util.DUCK_PATH)
    con = duckdb.connect(p, read_only=read_only)
    con.execute(f"PRAGMA threads={os.environ.get('IPC_DUCKDB_THREADS', '4')};")
    con.execute(f"PRAGMA memory_limit='{os.environ.get('IPC_DUCKDB_MEM', '16GB')}';")
    # 溢出目录必须落真盘(/tmp 多为 tmpfs=RAM, 往那溢出照样 OOM)。见 parquet_export._duck。
    tmp = os.environ.get("IPC_DUCKDB_TMP") or str(util.CACHE_DIR / "duck_tmp")
    os.makedirs(tmp, exist_ok=True)
    con.execute(f"SET temp_directory='{tmp}';")
    con.execute("SET max_temp_directory_size='200GB';")
    return con


def init_schema(con) -> None:
    con.execute(OBS_DDL)


def reset(con) -> None:
    """清空 ingest 产物(obs/pathobs/prefix), 供 --reset 重建。meta 保留。"""
    for t in ("obs", "pathobs", "prefix"):
        con.execute(f"DROP TABLE IF EXISTS {t};")
    con.execute(OBS_DDL)


def set_meta(con, key: str, value) -> None:
    con.execute(
        "INSERT INTO meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [key, str(value)],
    )


def get_meta(con, key: str, default=None):
    row = con.execute("SELECT value FROM meta WHERE key=?", [key]).fetchone()
    return row[0] if row else default


# ----------------------------------------------------------------------------
# obs 批量写入: Python 端流式写 CSV(ip 以十进制字符串避开 arrow 无 uint128 限制),
# DuckDB read_csv + ::UHUGEINT cast 灌入(实测 5M 行 ~3s, 远快于 executemany 的 ~分钟级)。
# ----------------------------------------------------------------------------
class ObsWriter:
    """流式把 obs 行写到临时 CSV; close 后用 load_csv() 灌进 DuckDB。每 collector 一个实例。"""

    def __init__(self, tag: str):
        util.ensure_dirs()
        tmp = os.environ.get("IPC_DUCKDB_TMP") or str(util.CACHE_DIR / "duck_tmp")
        os.makedirs(tmp, exist_ok=True)
        self.path = os.path.join(tmp, f"obs_{tag}_{os.getpid()}.csv")
        self._f = open(self.path, "w", newline="", encoding="utf-8")
        self._w = csv.writer(self._f)
        self.n = 0

    def write(self, prefix, ip_start, ip_end, family, plen,
              path_raw, path_clean, path_len, origin_asn, collector, n_peers) -> None:
        self._w.writerow((prefix, ip_start, ip_end, family, plen,
                          path_raw, path_clean, path_len, origin_asn, collector, n_peers))
        self.n += 1

    def close(self) -> None:
        if self._f:
            self._f.close()
            self._f = None


def load_csv(con, csv_path: str) -> int:
    """把 ObsWriter 写出的 CSV 灌进 obs 表(ip_start/ip_end cast 成 UHUGEINT)。返回行数。"""
    cols = {
        "prefix": "VARCHAR", "ip_start": "VARCHAR", "ip_end": "VARCHAR",
        "family": "UTINYINT", "plen": "UTINYINT",
        "path_raw": "VARCHAR", "path_clean": "VARCHAR",
        "path_len": "USMALLINT", "origin_asn": "BIGINT", "collector": "VARCHAR",
        "n_peers": "UINTEGER",
    }
    # columns 同时提供列名与类型(header=false 时即为各列名), 不能再传 names。
    coldef = "{" + ",".join(f"'{k}':'{v}'" for k, v in cols.items()) + "}"
    before = con.execute("SELECT count(*) FROM obs").fetchone()[0]
    con.execute(f"""
        INSERT INTO obs
        SELECT prefix, ip_start::UHUGEINT, ip_end::UHUGEINT, family, plen,
               path_raw, path_clean, path_len, origin_asn, collector, n_peers
        FROM read_csv('{csv_path}', header=false, auto_detect=false, columns={coldef});
    """)
    return con.execute("SELECT count(*) FROM obs").fetchone()[0] - before


# ----------------------------------------------------------------------------
# finalize: obs -> pathobs(跨 collector 合并) + prefix(每前缀一行 + pid + 代表 origin)
# ----------------------------------------------------------------------------
def finalize(con) -> dict:
    """从 obs 物化 pathobs 与 prefix。多次 ingest(多 collector)后调一次。

    pathobs: 同 (prefix, path_raw) 跨 collector 合并, n_peers 累加(= 跨采集点的去重 vantage 数);
             path_raw 含 prepend, 故仅 prepend 不同的路径各算一条。path_clean(折叠)随行携带。
    prefix : 每前缀一行 + pid(按 ip_start 排序) + 代表 origin(n_peers 之和最大者) + n_paths/n_origins。
    """
    util.log("  finalize: obs -> pathobs (跨 collector 合并去重路径)")
    con.execute("DROP TABLE IF EXISTS pathobs;")
    con.execute("""
        CREATE TABLE pathobs AS
        SELECT prefix,
               any_value(ip_start) AS ip_start, any_value(ip_end) AS ip_end,
               any_value(family)   AS family,   any_value(plen)   AS plen,
               path_raw,
               any_value(path_clean) AS path_clean,
               any_value(path_len) AS path_len,
               any_value(origin_asn) AS origin_asn,
               sum(n_peers)::BIGINT AS n_peers
        FROM obs GROUP BY prefix, path_raw;
    """)

    util.log("  finalize: pathobs -> prefix (每前缀 + pid + 代表 origin)")
    con.execute("DROP TABLE IF EXISTS prefix;")
    con.execute("""
        CREATE TABLE prefix AS
        WITH agg AS (
            SELECT prefix,
                   any_value(ip_start) AS ip_start, any_value(ip_end) AS ip_end,
                   any_value(family)   AS family,   any_value(plen)   AS plen,
                   sum(n_peers)::BIGINT      AS n_paths,
                   count(*)::BIGINT          AS n_distinct_paths,
                   count(DISTINCT origin_asn)::BIGINT AS n_origins
            FROM pathobs GROUP BY prefix
        ),
        oa AS (   -- 代表 origin = 该前缀下 n_peers 之和最大的 origin
            SELECT prefix, arg_max(origin_asn, ns) AS origin_asn FROM (
                SELECT prefix, origin_asn, sum(n_peers) AS ns
                FROM pathobs GROUP BY prefix, origin_asn
            ) GROUP BY prefix
        )
        SELECT row_number() OVER (ORDER BY agg.ip_start, agg.prefix) AS pid,
               agg.prefix, agg.ip_start, agg.ip_end, agg.family, agg.plen,
               oa.origin_asn, agg.n_origins, agg.n_paths, agg.n_distinct_paths
        FROM agg JOIN oa ON oa.prefix = agg.prefix;
    """)
    # 把 pid 贴回 pathobs(导出 paths/geo/pathsearch 都以 pid 为键)
    con.execute("""
        CREATE OR REPLACE TABLE pathobs AS
        SELECT pf.pid, po.* FROM pathobs po JOIN prefix pf ON pf.prefix = po.prefix;
    """)
    np = {r[0]: r[1] for r in con.execute(
        "SELECT family, count(*) FROM prefix GROUP BY family").fetchall()}
    npath = con.execute("SELECT count(*) FROM pathobs").fetchone()[0]
    util.log(f"  finalize 完成: prefix v4={np.get(4,0)} v6={np.get(6,0)}, pathobs={npath}")
    return {"v4": np.get(4, 0), "v6": np.get(6, 0), "pathobs": npath}
