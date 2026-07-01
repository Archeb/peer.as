"""PeeringDB dump -> small static Parquet datasets.

Input is the CAIDA public PeeringDB JSON dump. The raw dump is intentionally not
published to the browser; export keeps only fields useful for ASN and IXP views.
"""
from __future__ import annotations

import csv
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import requests

from . import profile, util


BASE_URL = "https://publicdata.caida.org/datasets/peeringdb"
FILENAME_RE = re.compile(r"peeringdb_2_dump_(\d{4})_(\d{2})_(\d{2})\.json")


def _clean(v: Any, max_len: int = 500) -> str:
    if v is None:
        return ""
    s = str(v).replace("\x00", "").strip()
    return s[:max_len]


def _bool(v: Any) -> bool:
    return bool(v)


def _int(v: Any) -> int:
    try:
        return int(v)
    except Exception:
        return 0


def _float_or_empty(v: Any) -> str:
    if v is None or v == "":
        return ""
    try:
        return str(float(v))
    except Exception:
        return ""


def _first_url(v: Any) -> str:
    if isinstance(v, list):
        for item in v:
            if isinstance(item, dict) and item.get("identifier"):
                return _clean(item.get("identifier"), 300)
    return ""


def _cache_dir() -> Path:
    d = util.CACHE_DIR / "peeringdb"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _cached_files() -> list[Path]:
    d = _cache_dir()
    return sorted((p for p in d.glob("peeringdb_2_dump_*.json") if p.stat().st_size > 1024 * 1024),
                  key=lambda p: p.name)


def _url_filename(url: str) -> str:
    name = url.rstrip("/").rsplit("/", 1)[-1]
    if not FILENAME_RE.fullmatch(name):
        raise ValueError(f"PeeringDB dump URL 文件名无法识别: {url}")
    return name


def _discover_latest(base: str) -> str:
    """Find latest CAIDA PeeringDB dump URL by scanning recent monthly indexes."""
    base = base.rstrip("/")
    now = time.gmtime()
    ym = now.tm_year * 12 + (now.tm_mon - 1)
    candidates: list[tuple[str, str]] = []
    for off in range(0, 18):
        cur = ym - off
        y, m = cur // 12, cur % 12 + 1
        idx_url = f"{base}/{y:04d}/{m:02d}/"
        try:
            r = requests.get(idx_url, timeout=20)
            if not r.ok:
                continue
        except Exception:
            continue
        for name in set(re.findall(r"peeringdb_2_dump_\d{4}_\d{2}_\d{2}\.json", r.text)):
            mm = FILENAME_RE.fullmatch(name)
            if mm:
                candidates.append(("".join(mm.groups()), urljoin(idx_url, name)))
        if candidates:
            break
    if not candidates:
        raise RuntimeError("未能在 CAIDA PeeringDB 目录发现 dump")
    return sorted(candidates)[-1][1]


def ensure_dump(cfg: dict) -> Path | None:
    feats = profile.features(cfg)
    if not feats.get("peeringdb") or cfg.get("peeringdb_enabled") is False:
        return None
    url = os.environ.get("IPC_PEERINGDB_DUMP_URL") or (cfg.get("peeringdb_dump_url") or "").strip()
    base = (cfg.get("peeringdb_base_url") or BASE_URL).strip()
    if not url:
        try:
            url = _discover_latest(base)
        except Exception as e:
            cached = _cached_files()
            if cached:
                util.log(f"  PeeringDB: 最新发现失败({e}); 使用缓存 {cached[-1].name}")
                return cached[-1]
            raise
    name = _url_filename(url)
    dst = _cache_dir() / name
    if dst.exists() and dst.stat().st_size > 1024 * 1024:
        return dst
    util.log(f"  下载 PeeringDB dump: {url}")
    tmp = dst.with_suffix(".tmp")
    try:
        with requests.get(url, stream=True, timeout=300) as r:
            r.raise_for_status()
            with tmp.open("wb") as fp:
                for chunk in r.iter_content(1024 * 1024):
                    if chunk:
                        fp.write(chunk)
        tmp.replace(dst)
        return dst
    except Exception as e:
        # 下载失败(CAIDA 临时不可达等): 回退到最近一次成功缓存的 dump —— 保证 PeeringDB/IXP
        # 不因一次瞬时抖动整体下线(缓存目录不被 deploy 清缓存触及, 见 deploy.sh 只清 mrt/duck_tmp)。
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        cached = _cached_files()
        if cached:
            util.log(f"  PeeringDB: 下载失败({e}); 回退缓存 {cached[-1].name}", err=True)
            return cached[-1]
        raise


def _write_csv(path: Path, rows: list[tuple]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fp:
        csv.writer(fp).writerows(rows)


def _load(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fp:
        return json.load(fp)


def _data(d: dict, key: str) -> list[dict]:
    v = d.get(key) or {}
    rows = v.get("data") if isinstance(v, dict) else None
    return rows if isinstance(rows, list) else []


def export(con, cfg: dict, pq: Path) -> dict:
    """Export PeeringDB-derived Parquet. Failures are caller-handled."""
    dump = ensure_dump(cfg)
    if not dump:
        return {"enabled": False, "counts": {}}
    util.log(f"  PeeringDB: 解析 {dump.name}")
    raw = _load(dump)
    out = pq / "peeringdb"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)

    nets = [r for r in _data(raw, "net") if r.get("status") == "ok" and r.get("asn")]
    ixes = [r for r in _data(raw, "ix") if r.get("status") == "ok"]
    ixlans = [r for r in _data(raw, "ixlan") if r.get("status") == "ok"]
    ixpfx = [r for r in _data(raw, "ixpfx") if r.get("status") == "ok"]
    facs = [r for r in _data(raw, "fac") if r.get("status") == "ok"]
    netix = [r for r in _data(raw, "netixlan") if r.get("status") == "ok"]
    netfac = [r for r in _data(raw, "netfac") if r.get("status") == "ok"]
    ixfac = [r for r in _data(raw, "ixfac") if r.get("status") == "ok"]
    as_set_map = {}
    try:
        m = raw.get("as_set", {}).get("data", [{}])[0]
        if isinstance(m, dict):
            as_set_map = {int(k): _clean(v, 240) for k, v in m.items() if str(k).isdigit() and v}
    except Exception:
        as_set_map = {}

    net_by_id = {_int(r.get("id")): r for r in nets}
    net_asn = {_int(r.get("id")): _int(r.get("asn")) for r in nets}

    tmpdir = Path(tempfile.mkdtemp(prefix="ipc_peeringdb_"))
    try:
        # ASN network profile.
        _write_csv(tmpdir / "pdb_net.csv", [(
            _int(r.get("asn")), _int(r.get("id")), _int(r.get("org_id")), _clean(r.get("name"), 240),
            _clean(r.get("aka"), 240), _clean(r.get("name_long"), 300), _clean(r.get("website"), 300),
            _first_url(r.get("social_media")), _clean(r.get("looking_glass"), 300),
            _clean(r.get("route_server"), 300), _clean(r.get("irr_as_set") or as_set_map.get(_int(r.get("asn")), ""), 240),
            _clean(r.get("info_type"), 80), "|".join(_clean(x, 80) for x in (r.get("info_types") or [])),
            _int(r.get("info_prefixes4")), _int(r.get("info_prefixes6")), _clean(r.get("info_traffic"), 80),
            _clean(r.get("info_ratio"), 80), _clean(r.get("info_scope"), 80), _bool(r.get("info_unicast")),
            _bool(r.get("info_multicast")), _bool(r.get("info_ipv6")), _bool(r.get("info_never_via_route_servers")),
            _int(r.get("ix_count")), _int(r.get("fac_count")), _clean(r.get("policy_url"), 300),
            _clean(r.get("policy_general"), 80), _clean(r.get("policy_locations"), 80),
            _bool(r.get("policy_ratio")), _clean(r.get("policy_contracts"), 80), _clean(r.get("status_dashboard"), 300),
            _clean(r.get("rir_status"), 40), _clean(r.get("updated"), 40)
        ) for r in sorted(nets, key=lambda x: _int(x.get("asn")))])

        _write_csv(tmpdir / "pdb_ix.csv", [(
            _int(r.get("id")), _int(r.get("org_id")), _clean(r.get("name"), 240), _clean(r.get("aka"), 240),
            _clean(r.get("name_long"), 300), _clean(r.get("city"), 240), _clean(r.get("country"), 2),
            _clean(r.get("region_continent"), 80), _clean(r.get("media"), 80), _bool(r.get("proto_unicast")),
            _bool(r.get("proto_multicast")), _bool(r.get("proto_ipv6")), _clean(r.get("website"), 300),
            _first_url(r.get("social_media")), _clean(r.get("url_stats"), 300), _int(r.get("net_count")),
            _int(r.get("fac_count")), _int(r.get("ixf_net_count")), _clean(r.get("ixf_last_import"), 40),
            _clean(r.get("service_level"), 120), _clean(r.get("terms"), 120), _clean(r.get("updated"), 40)
        ) for r in sorted(ixes, key=lambda x: (-_int(x.get("net_count")), _clean(x.get("name"))))])

        _write_csv(tmpdir / "pdb_ixlan.csv", [(
            _int(r.get("id")), _int(r.get("ix_id")), _clean(r.get("name"), 180), _clean(r.get("descr"), 300),
            _int(r.get("mtu")), _clean(r.get("dot1q_support"), 80), _int(r.get("rs_asn")),
            _clean(r.get("arp_sponge"), 80), _bool(r.get("ixf_ixp_import_enabled")), _clean(r.get("updated"), 40)
        ) for r in sorted(ixlans, key=lambda x: (_int(x.get("ix_id")), _int(x.get("id"))))])

        _write_csv(tmpdir / "pdb_ixpfx.csv", [(
            _int(r.get("id")), _int(r.get("ixlan_id")), _clean(r.get("protocol"), 12),
            _clean(r.get("prefix"), 80), _bool(r.get("in_dfz")), _clean(r.get("updated"), 40)
        ) for r in sorted(ixpfx, key=lambda x: (_int(x.get("ixlan_id")), _clean(x.get("prefix"))))])

        _write_csv(tmpdir / "pdb_fac.csv", [(
            _int(r.get("id")), _int(r.get("org_id")), _clean(r.get("org_name"), 240), _int(r.get("campus_id")),
            _clean(r.get("name"), 260), _clean(r.get("aka"), 240), _clean(r.get("name_long"), 300),
            _clean(r.get("website"), 300), _first_url(r.get("social_media")), _clean(r.get("clli"), 40),
            _int(r.get("net_count")), _int(r.get("ix_count")), _int(r.get("carrier_count")),
            _clean(r.get("region_continent"), 80), _clean(r.get("address1"), 260), _clean(r.get("address2"), 260),
            _clean(r.get("city"), 180), _clean(r.get("country"), 2), _clean(r.get("state"), 80),
            _clean(r.get("zipcode"), 40), _float_or_empty(r.get("latitude")), _float_or_empty(r.get("longitude")),
            _clean(r.get("updated"), 40)
        ) for r in sorted(facs, key=lambda x: (-_int(x.get("net_count")), _clean(x.get("name"))))])

        netix_rows = [(
            net_asn.get(_int(r.get("net_id"))) or _int(r.get("asn")), _int(r.get("net_id")), _int(r.get("ix_id")),
            _int(r.get("ixlan_id")), _int(r.get("id")), _clean(r.get("name"), 220), _int(r.get("speed")),
            _clean(r.get("ipaddr4"), 80), _clean(r.get("ipaddr6"), 120), _bool(r.get("is_rs_peer")),
            _bool(r.get("bfd_support")), _bool(r.get("operational")), _clean(r.get("updated"), 40)
        ) for r in netix if (net_asn.get(_int(r.get("net_id"))) or _int(r.get("asn")))]
        _write_csv(tmpdir / "pdb_netixlan_asn.csv", sorted(netix_rows, key=lambda x: (x[0], x[2], -x[6])))
        _write_csv(tmpdir / "pdb_netixlan_ix.csv", sorted(netix_rows, key=lambda x: (x[2], -x[6], x[0])))

        netfac_rows = [(
            net_asn.get(_int(r.get("net_id"))), _int(r.get("net_id")), _int(r.get("fac_id")), _int(r.get("id")),
            _clean(r.get("name"), 220), _clean(r.get("city"), 180), _clean(r.get("country"), 2),
            _int(r.get("local_asn")), _clean(r.get("updated"), 40)
        ) for r in netfac if net_asn.get(_int(r.get("net_id")))]
        _write_csv(tmpdir / "pdb_netfac_asn.csv", sorted(netfac_rows, key=lambda x: (x[0], x[2])))

        _write_csv(tmpdir / "pdb_ixfac.csv", [(
            _int(r.get("id")), _int(r.get("ix_id")), _int(r.get("fac_id")), _clean(r.get("name"), 220),
            _clean(r.get("city"), 180), _clean(r.get("country"), 2), _clean(r.get("updated"), 40)
        ) for r in sorted(ixfac, key=lambda x: (_int(x.get("ix_id")), _int(x.get("fac_id"))))])

        _write_csv(tmpdir / "pdb_as_set.csv", sorted([(a, s) for a, s in as_set_map.items()]))

        def load_csv(name: str, cols: dict[str, str]) -> None:
            con.execute(f"DROP TABLE IF EXISTS {name};")
            colspec = ",".join(f"'{k}':'VARCHAR'" for k in cols)
            exprs = []
            for k, typ in cols.items():
                if typ == "VARCHAR":
                    exprs.append(k)
                elif typ == "DOUBLE":
                    exprs.append(f"NULLIF({k}, '')::{typ} AS {k}")
                else:
                    exprs.append(f"{k}::{typ} AS {k}")
            casts = ", ".join(exprs)
            con.execute(f"""
                CREATE TABLE {name} AS
                SELECT {casts}
                FROM read_csv('{tmpdir / (name + ".csv")}', header=false, auto_detect=false,
                    columns={{{colspec}}});
            """)

        load_csv("pdb_net", {
            "asn": "BIGINT", "net_id": "BIGINT", "org_id": "BIGINT", "name": "VARCHAR", "aka": "VARCHAR",
            "name_long": "VARCHAR", "website": "VARCHAR", "social_url": "VARCHAR", "looking_glass": "VARCHAR",
            "route_server": "VARCHAR", "irr_as_set": "VARCHAR", "info_type": "VARCHAR", "info_types": "VARCHAR",
            "info_prefixes4": "BIGINT", "info_prefixes6": "BIGINT", "info_traffic": "VARCHAR",
            "info_ratio": "VARCHAR", "info_scope": "VARCHAR", "info_unicast": "BOOLEAN",
            "info_multicast": "BOOLEAN", "info_ipv6": "BOOLEAN", "info_never_via_route_servers": "BOOLEAN",
            "ix_count": "BIGINT", "fac_count": "BIGINT", "policy_url": "VARCHAR", "policy_general": "VARCHAR",
            "policy_locations": "VARCHAR", "policy_ratio": "BOOLEAN", "policy_contracts": "VARCHAR",
            "status_dashboard": "VARCHAR", "rir_status": "VARCHAR", "updated": "VARCHAR",
        })
        load_csv("pdb_ix", {
            "ix_id": "BIGINT", "org_id": "BIGINT", "name": "VARCHAR", "aka": "VARCHAR", "name_long": "VARCHAR",
            "city": "VARCHAR", "country": "VARCHAR", "region_continent": "VARCHAR", "media": "VARCHAR",
            "proto_unicast": "BOOLEAN", "proto_multicast": "BOOLEAN", "proto_ipv6": "BOOLEAN",
            "website": "VARCHAR", "social_url": "VARCHAR", "url_stats": "VARCHAR", "net_count": "BIGINT",
            "fac_count": "BIGINT", "ixf_net_count": "BIGINT", "ixf_last_import": "VARCHAR",
            "service_level": "VARCHAR", "terms": "VARCHAR", "updated": "VARCHAR",
        })
        load_csv("pdb_ixlan", {
            "ixlan_id": "BIGINT", "ix_id": "BIGINT", "name": "VARCHAR", "descr": "VARCHAR", "mtu": "BIGINT",
            "dot1q_support": "VARCHAR", "rs_asn": "BIGINT", "arp_sponge": "VARCHAR",
            "ixf_ixp_import_enabled": "BOOLEAN", "updated": "VARCHAR",
        })
        load_csv("pdb_ixpfx", {
            "ixpfx_id": "BIGINT", "ixlan_id": "BIGINT", "protocol": "VARCHAR", "prefix": "VARCHAR",
            "in_dfz": "BOOLEAN", "updated": "VARCHAR",
        })
        load_csv("pdb_fac", {
            "fac_id": "BIGINT", "org_id": "BIGINT", "org_name": "VARCHAR", "campus_id": "BIGINT",
            "name": "VARCHAR", "aka": "VARCHAR", "name_long": "VARCHAR", "website": "VARCHAR",
            "social_url": "VARCHAR", "clli": "VARCHAR", "net_count": "BIGINT", "ix_count": "BIGINT",
            "carrier_count": "BIGINT", "region_continent": "VARCHAR", "address1": "VARCHAR",
            "address2": "VARCHAR", "city": "VARCHAR", "country": "VARCHAR", "state": "VARCHAR",
            "zipcode": "VARCHAR", "latitude": "DOUBLE", "longitude": "DOUBLE", "updated": "VARCHAR",
        })
        load_csv("pdb_netixlan_asn", {
            "asn": "BIGINT", "net_id": "BIGINT", "ix_id": "BIGINT", "ixlan_id": "BIGINT", "netixlan_id": "BIGINT",
            "name": "VARCHAR", "speed": "BIGINT", "ipaddr4": "VARCHAR", "ipaddr6": "VARCHAR",
            "is_rs_peer": "BOOLEAN", "bfd_support": "BOOLEAN", "operational": "BOOLEAN", "updated": "VARCHAR",
        })
        load_csv("pdb_netixlan_ix", {
            "asn": "BIGINT", "net_id": "BIGINT", "ix_id": "BIGINT", "ixlan_id": "BIGINT", "netixlan_id": "BIGINT",
            "name": "VARCHAR", "speed": "BIGINT", "ipaddr4": "VARCHAR", "ipaddr6": "VARCHAR",
            "is_rs_peer": "BOOLEAN", "bfd_support": "BOOLEAN", "operational": "BOOLEAN", "updated": "VARCHAR",
        })
        load_csv("pdb_netfac_asn", {
            "asn": "BIGINT", "net_id": "BIGINT", "fac_id": "BIGINT", "netfac_id": "BIGINT", "name": "VARCHAR",
            "city": "VARCHAR", "country": "VARCHAR", "local_asn": "BIGINT", "updated": "VARCHAR",
        })
        load_csv("pdb_ixfac", {
            "ixfac_id": "BIGINT", "ix_id": "BIGINT", "fac_id": "BIGINT", "name": "VARCHAR",
            "city": "VARCHAR", "country": "VARCHAR", "updated": "VARCHAR",
        })
        load_csv("pdb_as_set", {"asn": "BIGINT", "irr_as_set": "VARCHAR"})

        for name, order, size in [
            ("pdb_net", "asn", "2MB"),
            ("pdb_ix", "net_count DESC, name", "1MB"),
            ("pdb_ixlan", "ix_id, ixlan_id", "1MB"),
            ("pdb_ixpfx", "ixlan_id, prefix", "1MB"),
            ("pdb_fac", "net_count DESC, name", "2MB"),
            ("pdb_netixlan_asn", "asn, ix_id, speed DESC", "2MB"),
            ("pdb_netixlan_ix", "ix_id, speed DESC, asn", "2MB"),
            ("pdb_netfac_asn", "asn, fac_id", "2MB"),
            ("pdb_ixfac", "ix_id, fac_id", "1MB"),
            ("pdb_as_set", "asn", "1MB"),
        ]:
            (out / name).mkdir(parents=True, exist_ok=True)
            con.execute(f"""
                COPY (SELECT * FROM {name} ORDER BY {order})
                TO '{out / name}' (FORMAT parquet, FILE_SIZE_BYTES '{size}', OVERWRITE_OR_IGNORE);
            """)
            con.execute(f"DROP TABLE IF EXISTS {name};")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    mm = FILENAME_RE.search(dump.name)
    as_of = "-".join(mm.groups()) if mm else ""
    counts = {
        "net": len(nets), "ix": len(ixes), "ixlan": len(ixlans), "ixpfx": len(ixpfx),
        "fac": len(facs), "netixlan": len(netix), "netfac": len(netfac), "ixfac": len(ixfac),
        "as_set": len(as_set_map),
    }
    util.log(f"  PeeringDB: ASN {util.human(len(nets))}, IX {util.human(len(ixes))}, netixlan {util.human(len(netix))}")
    return {"enabled": True, "as_of": as_of, "dump": dump.name, "counts": counts}
