"""GeoIP: 地理库导入 + 按 IP 查地理/运营商。

三轨来源(按国家域划分, 互不重叠):
  * ipdb.txt   私有库, **CN 城市级权威**(只取 cc==CN)。格式(| 分隔, 首行表头):
       start_ip|end_ip|start_ip_num|end_ip_num|continent|country|province|city|
       district|isp|area_code|country_english|country_code|longitude|latitude
  * GeoLite2-City.mmdb  全球城市级(含 v4+v6), 取 **非 CN** 部分(CN 让位 ipdb)。
  * RIR delegated       国家级开放兜底(仅在无 GeoLite 时用)。
  * GeoLite2-ASN.mmdb   IP->ASN/organization, 抽出 asn->org 建 asn_dim。

新管线写 **DuckDB 工作库**(store): 表 geo(UHUGEINT start/end + family + cc/prov/city + provider)、
country_dim(cc->zh/en 名)、asn_dim(asn->org)。旧的 import_ipdb/import_rir/GeoIndex(读 SQLite)
保留给退役中的旧路径, Phase C 删。
"""
from __future__ import annotations

import csv
import os
import sqlite3
from bisect import bisect_left, bisect_right
from typing import Optional

from . import util


def _f(x: str) -> Optional[float]:
    x = x.strip()
    if not x:
        return None
    try:
        return float(x)
    except ValueError:
        return None


def import_ipdb(conn: sqlite3.Connection, path: str, batch: int = 50000) -> int:
    """导入(全量覆盖)。返回导入行数。"""
    conn.execute("DELETE FROM geo")
    conn.commit()
    n = 0
    rows: list[tuple] = []
    insert = (
        "INSERT INTO geo(start_num,end_num,country,country_code,province,city,"
        "district,isp,lon,lat) VALUES(?,?,?,?,?,?,?,?,?,?)"
    )
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        header = f.readline()  # 跳过表头
        if not header.startswith("start_ip"):
            # 不是预期表头, 当作数据行回退处理
            f.seek(0)
        for line in f:
            parts = line.rstrip("\n").split("|")
            if len(parts) < 13:
                continue
            try:
                s = int(parts[2]); e = int(parts[3])
            except ValueError:
                continue
            rows.append((
                s, e,
                parts[5] or None,          # country
                parts[12] or None,         # country_code
                parts[6] or None,          # province
                parts[7] or None,          # city
                parts[8] or None,          # district
                parts[9] or None,          # isp
                _f(parts[13]) if len(parts) > 13 else None,
                _f(parts[14]) if len(parts) > 14 else None,
            ))
            if len(rows) >= batch:
                conn.executemany(insert, rows)
                n += len(rows)
                rows.clear()
                if n % 200000 == 0:
                    util.log(f"  geo 导入 {util.human(n)} 行 ...")
        if rows:
            conn.executemany(insert, rows)
            n += len(rows)
    conn.commit()
    util.log(f"  geo 导入完成: {n} 行, 建索引 ...")
    conn.execute("ANALYZE geo")
    conn.commit()
    return n


# ----------------------------------------------------------------------------
# geo provider: RIR delegated-extended (国家级, 完全开放可再分发) —— OSS 复现用
# (官方部署用私有 ipdb 出城市级; 见 docs/GLOBAL_DESIGN.md geo 双轨)
# ----------------------------------------------------------------------------
RIR_URLS = [
    "https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest",
    "https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest",
    "https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest",
    "https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest",
    "https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest",
]


def import_rir(conn: sqlite3.Connection, urls: Optional[list] = None) -> int:
    """从 5 大 RIR 的 delegated-extended 统计导入**国家级** IPv4 范围(country_code, 无城市)。
    完全开放、可随仓库再分发, 让无 ipdb 的环境也能复现(仅国家级)。返回导入行数。"""
    import ipaddress as _ip
    import requests
    conn.execute("DELETE FROM geo"); conn.commit()
    insert = ("INSERT INTO geo(start_num,end_num,country,country_code,province,city,"
              "district,isp,lon,lat) VALUES(?,?,?,?,?,?,?,?,?,?)")
    n = 0; rows: list[tuple] = []
    for url in (urls or RIR_URLS):
        util.log(f"  RIR: 下载 {url}")
        text = requests.get(url, timeout=180).text
        for line in text.splitlines():
            if not line or line[0] == "#":
                continue
            p = line.split("|")
            if len(p) < 7 or p[2] != "ipv4" or not p[1] or p[3] == "*":
                continue
            if p[6] not in ("allocated", "assigned"):
                continue
            try:
                start = int(_ip.IPv4Address(p[3])); cnt = int(p[4])
            except (ValueError, _ip.AddressValueError):
                continue
            rows.append((start, start + cnt - 1, None, p[1], None, None, None, None, None, None))
            if len(rows) >= 50000:
                conn.executemany(insert, rows); n += len(rows); rows.clear()
    if rows:
        conn.executemany(insert, rows); n += len(rows)
    conn.commit()
    util.log(f"  RIR 导入完成: {n} 段(国家级), 建索引...")
    conn.execute("ANALYZE geo"); conn.commit()
    return n


def lookup_int(conn: sqlite3.Connection, ip_num: int) -> Optional[sqlite3.Row]:
    row = conn.execute(
        "SELECT * FROM geo WHERE start_num<=? ORDER BY start_num DESC LIMIT 1",
        (ip_num,),
    ).fetchone()
    if row and row["end_num"] >= ip_num:
        return row
    return None


def lookup(conn: sqlite3.Connection, ip: str) -> Optional[sqlite3.Row]:
    return lookup_int(conn, util.ip2int(ip))


class GeoIndex:
    """把 geo 表一次性载入内存 (列式 + bisect 二分), 供 ingest 高频查询。

    每次查询 ~1µs (C 级 bisect), 取代每前缀一次 SQL 往返 — 全量 ingest 提速 ~50x。
    """

    def __init__(self, conn: sqlite3.Connection):
        import sys as _sys
        rows = conn.execute(
            "SELECT start_num,end_num,country_code,province,city,isp "
            "FROM geo ORDER BY start_num"
        ).fetchall()
        self.starts: list[int] = [r[0] for r in rows]
        self.ends: list[int] = [r[1] for r in rows]
        intern = _sys.intern
        self.cc = [intern(r[2]) if r[2] else None for r in rows]
        self.prov = [intern(r[3]) if r[3] else None for r in rows]
        self.city = [intern(r[4]) if r[4] else None for r in rows]
        self.isp = [intern(r[5]) if r[5] else None for r in rows]
        util.log(f"  GeoIndex: 载入 {len(self.starts)} 段到内存")

    def _idx(self, ipnum: int) -> int:
        i = bisect_right(self.starts, ipnum) - 1
        if i >= 0 and self.ends[i] >= ipnum:
            return i
        return -1

    def country_of(self, ipnum: int) -> Optional[str]:
        i = self._idx(ipnum)
        return self.cc[i] if i >= 0 else None

    def tag(self, ipnum: int) -> dict:
        i = self._idx(ipnum)
        if i < 0:
            return {"country_code": None, "province": None, "city": None, "geo_isp": None}
        return {"country_code": self.cc[i], "province": self.prov[i],
                "city": self.city[i], "geo_isp": self.isp[i]}

    def carve(self, start: int, end: int, city_set: set | None = None) -> list[tuple]:
        """把 [start,end] 按 ipdb 切成各城市片段 (裁剪到该前缀内)。

        city_set=None: 收所有有城市名的子段(以 ipdb 为准、把跨城大段拆成各城市子段);
        给定集合则只收该集合内城市。返回 [(cstart, cend, city, province), ...] 按地址升序。
        """
        out = []
        i = bisect_right(self.starts, end) - 1   # 最后一个 start<=end 的段
        while i >= 0 and self.ends[i] >= start:   # 仍与 [start,end] 相交
            city = self.city[i]
            if city and (city_set is None or city in city_set):
                out.append((max(start, self.starts[i]), min(end, self.ends[i]), city, self.prov[i]))
            i -= 1
        out.reverse()
        return out

    def carve_cc(self, start: int, end: int) -> list[tuple]:
        """把 [start,end] 按 ipdb 切成各子段, 带国家/省/市 (裁剪到该前缀内)。

        与 carve 不同: **不过滤 city**, 收所有有 country_code 的子段(country-level 也要)。
        返回 [(cstart, cend, cc, province, city), ...] 按地址升序。供全球分层 carve(Parquet)。
        """
        out = []
        i = bisect_right(self.starts, end) - 1
        while i >= 0 and self.ends[i] >= start:
            cc = self.cc[i]
            if cc:
                out.append((max(start, self.starts[i]), min(end, self.ends[i]),
                            cc, self.prov[i], self.city[i]))
            i -= 1
        out.reverse()
        return out


def tag_for_prefix(conn: sqlite3.Connection, start_num: int) -> dict:
    """给前缀打地理标签 (用网络地址查)。返回 dict 便于写入 prefix 表。"""
    row = lookup_int(conn, start_num)
    if not row:
        return {"country_code": None, "province": None, "city": None, "geo_isp": None}
    return {
        "country_code": row["country_code"],
        "province": row["province"],
        "city": row["city"],
        "geo_isp": row["isp"],
    }


# ============================================================================
# 新管线: GeoLite mmdb + ipdb -> DuckDB 工作库 (见 docs/DUCKDB_V6_REFACTOR.md §2.6)
# ============================================================================

def _gh_latest_release(repo: str) -> dict:
    """取 GitHub 最新 release 的 {tag, assets:{name:url}}。失败抛异常。"""
    import requests
    r = requests.get(f"https://api.github.com/repos/{repo}/releases/latest", timeout=30)
    r.raise_for_status()
    j = r.json()
    return {"tag": j.get("tag_name"),
            "assets": {a["name"]: a["browser_download_url"] for a in j.get("assets", [])}}


def ensure_geolite(cfg: dict, force: bool = False) -> dict:
    """检查本地 GeoLite mmdb 是否过期, 过期(或 force)才下载。跟随每次 ingest 调用。

    版本戳存 cache/geo/geolite.version(= 最新 release tag)。本地 tag == 远端 tag 则跳过下载。
    返回 {tag, city, asn}(本地路径); 离线且本地已有则用本地; 都没有则抛异常。
    """
    import requests
    util.ensure_dirs()
    gdir = util.GEO_CACHE_DIR
    city = gdir / cfg.get("geolite_city_asset", "GeoLite2-City.mmdb")
    asn = gdir / cfg.get("geolite_asn_asset", "GeoLite2-ASN.mmdb")
    stamp = gdir / "geolite.version"
    local_tag = stamp.read_text().strip() if stamp.exists() else None

    try:
        rel = _gh_latest_release(cfg.get("geolite_repo", "P3TERX/GeoLite.mmdb"))
    except Exception as e:  # noqa: 离线/限流 -> 用本地
        util.log(f"  ! GeoLite release 查询失败({e}); 用本地缓存", err=True)
        rel = None

    fresh = rel and rel["tag"] == local_tag and city.exists() and asn.exists()
    if fresh and not force:
        util.log(f"  GeoLite 已是最新({local_tag}), 跳过下载")
        return {"tag": local_tag, "city": str(city), "asn": str(asn)}

    if rel is None:
        if city.exists() and asn.exists():
            return {"tag": local_tag, "city": str(city), "asn": str(asn)}
        raise RuntimeError("GeoLite 不可下载且无本地缓存")

    for name, dst in ((cfg.get("geolite_city_asset", "GeoLite2-City.mmdb"), city),
                      (cfg.get("geolite_asn_asset", "GeoLite2-ASN.mmdb"), asn)):
        u = rel["assets"].get(name)
        if not u:
            raise RuntimeError(f"release {rel['tag']} 缺资产 {name}")
        util.log(f"  下载 GeoLite {name} ({rel['tag']})")
        data = requests.get(u, timeout=300).content
        dst.write_bytes(data)
    stamp.write_text(rel["tag"])
    util.log(f"  GeoLite 更新到 {rel['tag']}")
    return {"tag": rel["tag"], "city": str(city), "asn": str(asn)}


def _pick_city(rec: dict) -> tuple[Optional[str], Optional[str], Optional[str], Optional[str], Optional[str]]:
    """从 GeoLite City 记录取 (cc, prov_en, city, country_zh, country_en)。city 优先中文名。"""
    c = rec.get("country") or rec.get("registered_country") or {}
    cc = c.get("iso_code")
    cnames = c.get("names") or {}
    cn_zh, cn_en = cnames.get("zh-CN"), cnames.get("en")
    subs = rec.get("subdivisions") or []
    prov = (subs[0].get("names") or {}).get("en") if subs else None
    cnm = (rec.get("city") or {}).get("names") or {}
    city = cnm.get("zh-CN") or cnm.get("en")
    return cc, prov, city, cn_zh, cn_en


def build_geo(con, cfg: dict, geolite: Optional[dict] = None) -> dict:
    """把 ipdb(CN 城市) + GeoLite(非 CN 全球, v4+v6) 合并为非重叠 geo 区间, 写 DuckDB。

    国家域划分(避免昂贵的区间相减): ipdb 只取 cc==CN; GeoLite 只取 cc!=CN -> 两域天然不交。
    末尾按 start 排序后裁剪极少数边界处的重叠(ipdb/GeoLite 对某地址是否 CN 的分歧), 保证 carve 不双发。
    顺带建 country_dim(cc->zh/en 名) 与 asn_dim(asn->org, 来自 GeoLite2-ASN)。
    """
    import maxminddb
    util.ensure_dirs()
    tmp = os.environ.get("IPC_DUCKDB_TMP") or str(util.CACHE_DIR / "duck_tmp")
    os.makedirs(tmp, exist_ok=True)
    geo_csv = os.path.join(tmp, f"geo_{os.getpid()}.csv")
    country_zh: dict[str, str] = {}
    country_en: dict[str, str] = {}
    n_ipdb = n_geolite = 0

    with open(geo_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        # 1) ipdb: 只取 CN(城市级权威)。复用 ipdb.txt 解析。
        ipdb_path = cfg.get("ipdb_path") or str(util.DEFAULT_IPDB)
        if os.path.exists(ipdb_path):
            util.log(f"  geo: 读 ipdb(仅 CN 城市) {ipdb_path}")
            with open(ipdb_path, "r", encoding="utf-8", errors="replace") as fp:
                head = fp.readline()
                if not head.startswith("start_ip"):
                    fp.seek(0)
                for line in fp:
                    p = line.rstrip("\n").split("|")
                    if len(p) < 13 or p[12] != "CN":
                        continue
                    try:
                        s, e = int(p[2]), int(p[3])
                    except ValueError:
                        continue
                    w.writerow((s, e, 4, "CN", p[6] or "", p[7] or "", "ipdb"))
                    n_ipdb += 1
                    country_zh.setdefault("CN", p[5] or "中国")
        else:
            util.log(f"  ! ipdb 不存在({ipdb_path}); CN 走 GeoLite 兜底", err=True)

        # 2) GeoLite City: 取非 CN 的全部, **以及 CN 的 v6**(ipdb 只有 v4 -> CN v6 必须靠 GeoLite,
        #    否则 CN v6 前缀无 geo)。CN v4 让位 ipdb(更准), 除非根本没 ipdb。v4+v6。
        if geolite and os.path.exists(geolite["city"]):
            keep_cn_v4 = (n_ipdb == 0)
            util.log(f"  geo: 遍历 GeoLite City(非CN 全部 + CN v6{'，CN v4 兜底' if keep_cn_v4 else ''}, v4+v6, ~5.8M 段)")
            r = maxminddb.open_database(geolite["city"])
            for net, rec in r:
                cc, prov, city, cn_zh, cn_en = _pick_city(rec)
                if not cc:
                    continue
                fam = 4 if net.version == 4 else 6
                if cc == "CN" and fam == 4 and not keep_cn_v4:
                    continue   # CN v4 用 ipdb
                w.writerow((int(net.network_address), int(net.broadcast_address),
                            fam, cc, prov or "", city or "", "geolite"))
                n_geolite += 1
                if cn_zh:
                    country_zh.setdefault(cc, cn_zh)
                if cn_en:
                    country_en.setdefault(cc, cn_en)
            r.close()

    util.log(f"  geo: 灌入 DuckDB(ipdb={n_ipdb}, geolite={n_geolite})")
    con.execute("DROP TABLE IF EXISTS geo_raw;")
    con.execute(f"""
        CREATE TABLE geo_raw AS
        SELECT column0::UHUGEINT AS start_num, column1::UHUGEINT AS end_num,
               column2::UTINYINT AS family, column3 AS cc,
               nullif(column4,'') AS province, nullif(column5,'') AS city, column6 AS provider
        FROM read_csv('{geo_csv}', header=false, auto_detect=false,
            columns={{'column0':'VARCHAR','column1':'VARCHAR','column2':'UTINYINT',
                      'column3':'VARCHAR','column4':'VARCHAR','column5':'VARCHAR','column6':'VARCHAR'}});
    """)
    os.remove(geo_csv)
    # 裁剪重叠: 按 (start, provider 优先) 排序, 用窗口取前缀最大 end, start<=prev_end 的段把 start 抬到 prev_end+1。
    # provider 优先: ipdb > geolite(同 start 时 ipdb 在前, 胜出)。极少数边界分歧才触发。
    con.execute("DROP TABLE IF EXISTS geo;")
    con.execute("""
        CREATE TABLE geo AS
        WITH ord AS (
            SELECT *, CASE provider WHEN 'ipdb' THEN 3 WHEN 'geolite' THEN 2 ELSE 1 END AS prio
            FROM geo_raw
        ),
        s AS (
            SELECT *, max(end_num) OVER (
                ORDER BY start_num, prio DESC
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max_end
            FROM ord
        )
        SELECT
            CASE WHEN prev_max_end IS NOT NULL AND start_num <= prev_max_end
                 THEN prev_max_end + 1 ELSE start_num END AS start_num,
            end_num, family, cc, province, city, provider
        FROM s
        WHERE end_num > COALESCE(prev_max_end, 0::UHUGEINT)            -- 完全被覆盖的段丢弃
          AND (CASE WHEN prev_max_end IS NOT NULL AND start_num <= prev_max_end
                    THEN prev_max_end + 1 ELSE start_num END) <= end_num;
    """)
    con.execute("DROP TABLE IF EXISTS geo_raw;")
    # 合并相邻同 (cc,prov,city) 段: GeoLite 有大量连续同城微段(/24、/64), 合并后段数大降,
    # carve 迭代成本随之大降(且对 carve 输出无影响 —— 本就按城合并)。
    coalesce_geo(con)
    n_geo = con.execute("SELECT count(*) FROM geo").fetchone()[0]

    # country_dim: cc -> 中/英文名(覆盖 CN/TW/HK/MO 规范名, 与前端一致)
    country_zh.update({"CN": "中国大陆", "TW": "中国台湾", "MO": "中国澳门", "HK": "中国香港"})
    country_en.update({"CN": "Chinese Mainland", "TW": "Taiwan, China", "MO": "Macao", "HK": "Hong Kong"})
    con.execute("DROP TABLE IF EXISTS country_dim;")
    con.execute("CREATE TABLE country_dim(cc VARCHAR, name_zh VARCHAR, name_en VARCHAR);")
    rows = [(cc, country_zh.get(cc), country_en.get(cc))
            for cc in set(country_zh) | set(country_en)]
    con.executemany("INSERT INTO country_dim VALUES (?,?,?)", rows)

    # asn_dim: GeoLite2-ASN -> asn -> organization
    n_asn = 0
    if geolite and os.path.exists(geolite["asn"]):
        util.log("  geo: 遍历 GeoLite ASN -> asn_dim(org)")
        orgs: dict[int, str] = {}
        r = maxminddb.open_database(geolite["asn"])
        for net, rec in r:
            a = rec.get("autonomous_system_number")
            o = rec.get("autonomous_system_organization")
            if a and o:
                orgs.setdefault(int(a), o[:80])
        r.close()
        con.execute("DROP TABLE IF EXISTS asn_dim;")
        con.execute("CREATE TABLE asn_dim(asn BIGINT, org VARCHAR);")
        # CSV + read_csv 灌入: executemany 8万行实测 ~400s(逐行事务), read_csv ~0.2s
        # (同 obs/geo_raw 的快路径; org 名可能含逗号/引号 -> csv.writer 引号 + read_csv 默认 RFC4180 解析)。
        if orgs:
            asn_csv = os.path.join(tmp, f"asn_{os.getpid()}.csv")
            with open(asn_csv, "w", newline="", encoding="utf-8") as af:
                aw = csv.writer(af)
                for a, o in orgs.items():
                    aw.writerow((a, o))
            con.execute(f"""
                INSERT INTO asn_dim
                SELECT column0::BIGINT, column1 FROM read_csv('{asn_csv}',
                    header=false, auto_detect=false,
                    columns={{'column0':'VARCHAR','column1':'VARCHAR'}});
            """)
            os.remove(asn_csv)
        n_asn = len(orgs)

    util.log(f"  geo 完成: {n_geo} 段(非重叠), country_dim={len(rows)}, asn_dim={n_asn}")
    return {"geo": n_geo, "countries": len(rows), "asn_org": n_asn,
            "ipdb": n_ipdb, "geolite": n_geolite}


def coalesce_geo(con) -> int:
    """把 geo 表里相邻且同 (family,cc,province,city) 的段合并成最大区间(gaps-and-islands)。
    一次性降段数(GeoLite 大量连续同城微段)。返回合并后段数。"""
    before = con.execute("SELECT count(*) FROM geo").fetchone()[0]
    con.execute("""
        CREATE OR REPLACE TABLE geo AS
        WITH ord AS (
            SELECT *, CASE
                WHEN start_num = (lag(end_num) OVER w) + 1
                     AND cc       IS NOT DISTINCT FROM lag(cc) OVER w
                     AND province IS NOT DISTINCT FROM lag(province) OVER w
                     AND city     IS NOT DISTINCT FROM lag(city) OVER w
                THEN 0 ELSE 1 END AS newgrp
            FROM geo WINDOW w AS (PARTITION BY family ORDER BY start_num)
        ),
        grp AS (SELECT *, sum(newgrp) OVER (PARTITION BY family ORDER BY start_num) AS g FROM ord)
        SELECT min(start_num) AS start_num, max(end_num) AS end_num,
               any_value(family) AS family, any_value(cc) AS cc,
               any_value(province) AS province, any_value(city) AS city,
               any_value(provider) AS provider
        FROM grp GROUP BY family, g;
    """)
    after = con.execute("SELECT count(*) FROM geo").fetchone()[0]
    util.log(f"  geo 合并相邻同城段: {before} -> {after}")
    return after


class GeoIndexDuck:
    """从 DuckDB geo 表载入某 family 的区间到内存(Python int + bisect), 供 carve。

    Python int 任意精度 -> v6 128 位天然支持, carve/_subtract 逻辑与 v4 完全一致(位宽无关)。
    """

    def __init__(self, con, family: int):
        import sys as _sys
        # UHUGEINT 拆 hi/lo 两个 UBIGINT 取(原生快路径), Python 端 hi*2^64+lo 还原。
        # (直接取 UHUGEINT 或 cast VARCHAR 都极慢, 见 util.uhuge_halves。)
        SH = util.SH64
        rows = con.execute(
            f"SELECT {util.uhuge_halves('start_num')}, {util.uhuge_halves('end_num')}, "
            f"cc, province, city FROM geo WHERE family=? ORDER BY start_num", [family]).fetchall()
        self.starts = [r[0] * SH + r[1] for r in rows]
        self.ends = [r[2] * SH + r[3] for r in rows]
        intern = _sys.intern
        self.cc = [intern(r[4]) if r[4] else None for r in rows]
        self.prov = [intern(r[5]) if r[5] else None for r in rows]
        self.city = [intern(r[6]) if r[6] else None for r in rows]
        util.log(f"  GeoIndexDuck(v{family}): 载入 {len(self.starts)} 段")

    def _idx(self, ipnum: int) -> int:
        i = bisect_right(self.starts, ipnum) - 1
        if i >= 0 and self.ends[i] >= ipnum:
            return i
        return -1

    def country_of(self, ipnum: int) -> Optional[str]:
        i = self._idx(ipnum)
        return self.cc[i] if i >= 0 else None

    def tag(self, ipnum: int) -> dict:
        i = self._idx(ipnum)
        if i < 0:
            return {"country_code": None, "province": None, "city": None}
        return {"country_code": self.cc[i], "province": self.prov[i], "city": self.city[i]}

    def carve_cc(self, start: int, end: int, cap: int | None = None) -> list[tuple]:
        """把 [start,end] 切成各子段, 带 cc/prov/city(裁剪到该范围内)。升序。

        cap: 防超大聚合前缀(如 v6 /12)在 6M 段 geo 上炸开。若该范围覆盖的 geo 段数 > cap,
        视为粗聚合 -> 只回 1 段(整段归到网络地址所在国家, 无城市细分), 把 carve 成本压到 O(1)。
        """
        if cap is not None:
            approx = bisect_right(self.starts, end) - bisect_left(self.starts, start)
            if approx > cap:
                i = self._idx(start)
                if i >= 0 and self.cc[i]:
                    return [(start, end, self.cc[i], None, None)]   # 粗: 整段一个国家, 无城市
                return []
        out = []
        i = bisect_right(self.starts, end) - 1
        while i >= 0 and self.ends[i] >= start:
            cc = self.cc[i]
            if cc:
                out.append((max(start, self.starts[i]), min(end, self.ends[i]),
                            cc, self.prov[i], self.city[i]))
            i -= 1
        out.reverse()
        return out
