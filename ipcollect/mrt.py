"""MRT (RIPE rrc00 RIB) 下载 + 快速流式解析 + 入库。

自写的 TABLE_DUMP_V2 二进制解析 (RFC 6396), 比 mrtparse 快很多:
  * 流式 gzip, 不解压全表进内存;
  * 焦点 ASN 的 4 字节大端模式作前置过滤, 跳过 99% 不相关前缀;
  * 只对命中的前缀做完整属性解析。
"""
from __future__ import annotations

import bz2
import gzip
import os
import struct
import time
from typing import Callable, Iterator, Optional

from . import bgp, store, util


def _open_mrt(path: str):
    """按扩展名选解压: dn42 GRC 是 .bz2, RIPE RIS 是 .gz。两者都是流式只读。"""
    return bz2.open(path, "rb") if path.endswith(".bz2") else gzip.open(path, "rb")

# MRT / TABLE_DUMP_V2 常量
MRT_TABLE_DUMP_V2 = 13
ST_PEER_INDEX_TABLE = 1
ST_RIB_IPV4_UNICAST = 2
ST_RIB_IPV6_UNICAST = 4
ST_RIB_IPV4_UNICAST_ADDPATH = 8
ST_RIB_IPV6_UNICAST_ADDPATH = 10
ATTR_AS_PATH = 2

_HDR = struct.Struct(">IHHI")


# ----------------------------------------------------------------------------
# 下载
# ----------------------------------------------------------------------------
def collectors(cfg: dict) -> list[str]:
    """配置的采集点列表(默认 mrt_collectors; 回退单值 mrt_collector)。"""
    cs = cfg.get("mrt_collectors") or []
    if not cs and cfg.get("mrt_collector"):
        cs = [cfg["mrt_collector"]]
    return [c for c in cs if c]


# RouteViews 归档默认根。采集点名以 "route-views" 开头者走 RouteViews 布局, 否则走 RIPE RIS。
ROUTEVIEWS_BASE = "https://archive.routeviews.org"


def collector_source(name: str) -> str:
    """按采集点名判定来源: route-views* -> RouteViews; rrc* / 其他 -> RIPE RIS。"""
    return "routeviews" if name.startswith("route-views") else "ris"


def _latest_in_months(murl_for, file_re: str, months: list[str], where: str) -> str:
    """从最新月份往回找第一个含 RIB 文件的月份(归档可能预建空的未来月目录)。"""
    for month in sorted(months, reverse=True):
        murl = murl_for(month)
        files = _list_links(murl, file_re)
        if files:
            return murl + sorted(files)[-1]
    raise RuntimeError(f"无法在 {where} 任一月份目录里列出 RIB 文件")


def latest_bview_url(cfg: dict, collector: Optional[str] = None) -> str:
    coll = collector or cfg.get("mrt_collector") or (collectors(cfg) or ["rrc01"])[0]

    if collector_source(coll) == "routeviews":
        # RouteViews: <base>/<coll>/bgpdata/<YYYY.MM>/RIBS/rib.<date>.<time>.bz2(每 2h 一份)。
        base = (cfg.get("routeviews_base_url") or ROUTEVIEWS_BASE).rstrip("/")
        root = f"{base}/{coll}/bgpdata/"
        months = _list_links(root, r"20\d\d\.\d\d/")
        if not months:
            raise RuntimeError(f"无法在 {root} 列出月份目录")
        return _latest_in_months(lambda m: f"{root}{m}RIBS/",
                                  r"rib\.\d{8}\.\d{4}\.bz2", months, root)

    # RIPE RIS: <base>/<coll>/<YYYY.MM>/bview.<date>.<time>.gz(每 8h 一份)。
    base = cfg["mrt_base_url"].rstrip("/")
    root = f"{base}/{coll}/"
    months = _list_links(root, r"20\d\d\.\d\d/")
    if not months:
        raise RuntimeError(f"无法在 {root} 列出月份目录")
    return _latest_in_months(lambda m: root + m,
                             r"bview\.\d{8}\.\d{4}\.gz", months, root)


def _list_links(url: str, pattern: str) -> list[str]:
    import re
    import requests

    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return sorted(set(re.findall(pattern, r.text)))


def download(url: str, dest: Optional[str] = None, force: bool = False, retries: int = 5) -> str:
    """下载到 dest, 支持**断点续传 + 重试**(RIPE 大 RIB 易中途断流)。
    续传: .part 已有字节则发 Range 续; 服务器不支持(回 200)则从头。重试间隔退避。"""
    import requests

    util.ensure_dirs()
    if dest is None:
        dest = str(util.MRT_CACHE_DIR / os.path.basename(url))
    if os.path.exists(dest) and not force:
        try:
            head = requests.head(url, timeout=30)
            remote = int(head.headers.get("content-length", 0))
        except Exception:
            remote = 0
        local = os.path.getsize(dest)
        if remote == 0 or local == remote:
            util.log(f"  复用已下载 MRT: {dest} ({util.human_bytes(local)})")
            return dest
        util.log(f"  本地大小 {local} != 远端 {remote}, 重新下载")
    tmp = dest + ".part"
    util.log(f"  下载 {url}")
    for attempt in range(1, retries + 1):
        got = os.path.getsize(tmp) if os.path.exists(tmp) else 0
        headers = {"Range": f"bytes={got}-"} if got else {}
        try:
            with requests.get(url, stream=True, timeout=120, headers=headers) as r:
                if got and r.status_code == 200:   # 服务器忽略 Range -> 从头重写
                    got = 0
                elif got and r.status_code == 416:  # 已下全(range 越界) -> 当作完成
                    r.close(); break
                r.raise_for_status()
                total = int(r.headers.get("content-length", 0)) + got
                done = got
                last = time.time()
                with open(tmp, "ab" if got else "wb") as f:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        f.write(chunk)
                        done += len(chunk)
                        if time.time() - last > 3:
                            pct = f"{done/total*100:.0f}%" if total else "?"
                            util.log(f"    {util.human_bytes(done)} / {util.human_bytes(total)} ({pct})")
                            last = time.time()
            break   # 流读完未抛 -> 成功
        except Exception as e:  # noqa: 断流/超时 -> 退避重试(保留 .part 续传)
            if attempt >= retries:
                raise
            wait = min(30, 3 * attempt)
            util.log(f"  ! 下载中断({type(e).__name__}: {e}); {wait}s 后续传(第 {attempt}/{retries} 次, 已 {util.human_bytes(os.path.getsize(tmp) if os.path.exists(tmp) else 0)})", err=True)
            time.sleep(wait)
    os.replace(tmp, dest)
    util.log(f"  下载完成: {dest} ({util.human_bytes(os.path.getsize(dest))})")
    return dest


# ----------------------------------------------------------------------------
# 解析
# ----------------------------------------------------------------------------
def _readn(f, n: int) -> bytes:
    buf = f.read(n)
    if len(buf) == n or len(buf) == 0:
        return buf
    # gzip 流偶尔短读, 补齐
    parts = [buf]
    got = len(buf)
    while got < n:
        more = f.read(n - got)
        if not more:
            break
        parts.append(more)
        got += len(more)
    return b"".join(parts)


def _parse_peer_index(body: bytes) -> list[tuple[Optional[int], Optional[str]]]:
    import socket

    off = 4  # collector_bgp_id
    view_len = int.from_bytes(body[off:off + 2], "big"); off += 2
    off += view_len
    peer_count = int.from_bytes(body[off:off + 2], "big"); off += 2
    peers: list[tuple[Optional[int], Optional[str]]] = []
    for _ in range(peer_count):
        ptype = body[off]; off += 1
        off += 4  # peer_bgp_id
        if ptype & 0x01:  # IPv6
            ip = socket.inet_ntop(socket.AF_INET6, body[off:off + 16]); off += 16
        else:
            ip = socket.inet_ntop(socket.AF_INET, body[off:off + 4]); off += 4
        if ptype & 0x02:  # 4-byte ASN
            asn = int.from_bytes(body[off:off + 4], "big"); off += 4
        else:
            asn = int.from_bytes(body[off:off + 2], "big"); off += 2
        peers.append((asn, ip))
    return peers


def _parse_as_path_value(val: bytes) -> list[int]:
    asns: list[int] = []
    i, n = 0, len(val)
    while i + 2 <= n:
        seg_len = val[i + 1]
        i += 2
        for _ in range(seg_len):
            if i + 4 > n:
                return asns
            asns.append(int.from_bytes(val[i:i + 4], "big"))
            i += 4
    return asns


def _parse_attrs_aspath(attrs: bytes) -> list[int]:
    i, n = 0, len(attrs)
    while i + 3 <= n:
        flags = attrs[i]
        tcode = attrs[i + 1]
        i += 2
        if flags & 0x10:  # extended length
            if i + 2 > n:
                break
            alen = int.from_bytes(attrs[i:i + 2], "big"); i += 2
        else:
            alen = attrs[i]; i += 1
        val = attrs[i:i + alen]; i += alen
        if tcode == ATTR_AS_PATH:
            return _parse_as_path_value(val)
    return []


def _parse_rib_body(body: bytes, addpath: bool):
    plen = body[4]
    nb = (plen + 7) // 8
    pfx_bytes = body[5:5 + nb]
    off = 5 + nb
    entry_count = int.from_bytes(body[off:off + 2], "big"); off += 2
    entries = []
    n = len(body)
    for _ in range(entry_count):
        if off + 2 > n:
            break
        peer_index = int.from_bytes(body[off:off + 2], "big"); off += 2
        if addpath:
            off += 4
        off += 4  # originated_time
        if off + 2 > n:
            break
        attrlen = int.from_bytes(body[off:off + 2], "big"); off += 2
        attrs = body[off:off + attrlen]; off += attrlen
        asns = _parse_attrs_aspath(attrs)
        entries.append((peer_index, asns))
    return plen, pfx_bytes, entries


def iter_prefixes(
    path: str,
    keep_pred: Optional[Callable[[int, int, int], bool]] = None,
    limit: Optional[int] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> Iterator[dict]:
    """流式解析 RIB, 产出**全部**前缀(全表)。

    keep_pred(start,end,family) 可进一步过滤(如只收 v4 / 某国家)。
    """
    peers: list[tuple] = []
    scanned = 0
    kept = 0
    with _open_mrt(path) as f:
      try:
        while True:
            hdr = _readn(f, 12)
            if len(hdr) < 12:
                break
            _, typ, subtype, length = _HDR.unpack(hdr)
            body = _readn(f, length)
            if len(body) < length:
                break
            if typ != MRT_TABLE_DUMP_V2:
                continue
            if subtype == ST_PEER_INDEX_TABLE:
                peers = _parse_peer_index(body)
                util.log(f"  peer_index: {len(peers)} 个 peer")
                continue
            if subtype not in (ST_RIB_IPV4_UNICAST, ST_RIB_IPV6_UNICAST,
                               ST_RIB_IPV4_UNICAST_ADDPATH, ST_RIB_IPV6_UNICAST_ADDPATH):
                continue
            scanned += 1
            if on_progress and scanned % 200000 == 0:
                on_progress(scanned, kept)
            family = 4 if subtype in (ST_RIB_IPV4_UNICAST, ST_RIB_IPV4_UNICAST_ADDPATH) else 6
            addpath = subtype in (ST_RIB_IPV4_UNICAST_ADDPATH, ST_RIB_IPV6_UNICAST_ADDPATH)
            # 先用前缀头字节算出网段, 把(国家/family)过滤提到完整解析之前 — 跳过非目标前缀的昂贵解析
            plen0 = body[4]
            # 跳过默认路由(0.0.0.0/0 / ::/0): 它不代表任何具体网络的可达性, 入库只会污染搜索/统计。
            if plen0 == 0:
                continue
            nb0 = (plen0 + 7) // 8
            start, end, cidr = util.prefix_from_bytes(body[5:5 + nb0], plen0, family)
            if keep_pred and not keep_pred(start, end, family):
                continue
            plen, pfx_bytes, entries = _parse_rib_body(body, addpath)
            paths = []
            origins: set[int] = set()
            for peer_index, asns in entries:
                if not asns:
                    continue
                pas, pip = peers[peer_index] if peer_index < len(peers) else (None, None)
                origins.add(asns[-1])
                paths.append({"peer_asn": pas, "peer_ip": pip, "asns": asns})
            kept += 1
            yield {
                "prefix": cidr, "start": start, "end": end, "family": family,
                "plen": plen, "origins": origins, "paths": paths,
            }
            if limit and kept >= limit:
                break
      except (EOFError, OSError) as e:
        # 截断/损坏的 gzip(如部分下载): 解析到此为止
        util.log(f"  解析在 EOF/截断处停止: {type(e).__name__}: {e}", err=True)
    if on_progress:
        on_progress(scanned, kept)


# ----------------------------------------------------------------------------
# 入库(DuckDB 工作库; 多采集点; v4+v6)
# ----------------------------------------------------------------------------
def _ingest_one(con, mrt_file: str, collector: str, keep_pred,
                limit: Optional[int]) -> tuple[int, int]:
    """解析单个 collector 的 RIB, 把去重后的 (prefix,path) 行写进 obs。返回 (前缀数, obs 行数)。

    去重在 Python 端按 (prefix, path_raw) 做(含 prepend; 同 collector 内 n_peers=观测此 path 的 peer 数);
    跨 collector 的合并留给 store.finalize()。
    """
    t0 = time.time()

    def progress(scanned: int, kept: int):
        rate = scanned / max(time.time() - t0, 1e-6)
        util.log(f"  [{collector}] 扫描 {util.human(scanned)} 前缀, 命中 {kept} ({util.human(rate)}/s)")

    w = store.ObsWriter(collector)
    n_prefix = n_rows = 0
    for rec in iter_prefixes(mrt_file, keep_pred=keep_pred,
                             limit=limit, on_progress=progress):
        # 去重键 = **原始 path(含 prepend)**: 仅 prepend 次数不同的路径视为不同观测(保留 inbound TE 信号)。
        # path_clean(折叠连续重复)随行携带, 供搜索/邻接/展示折叠; path_len 取**原始**长度(BGP 选路真实口径)。
        dedup: dict[str, list] = {}   # path_raw -> [path_clean, raw_len, origin, n_peers]
        for p in rec["paths"]:
            asns = p["asns"]
            if not asns:
                continue
            clean = bgp.clean_path(asns)
            if not clean:
                continue
            raw_key = " ".join(map(str, asns))
            d = dedup.get(raw_key)
            if d is None:
                dedup[raw_key] = [" ".join(map(str, clean)), len(asns), asns[-1], 1]
            else:
                d[3] += 1
        if not dedup:
            continue
        for raw_key, (clean_str, rlen, origin, n) in dedup.items():
            w.write(rec["prefix"], rec["start"], rec["end"], rec["family"], rec["plen"],
                    raw_key, clean_str, rlen, origin, collector, n)
            n_rows += 1
        n_prefix += 1
    w.close()
    util.log(f"  [{collector}] 灌入 obs: {n_prefix} 前缀 / {n_rows} 去重路径行")
    store.load_csv(con, w.path)
    os.remove(w.path)
    return n_prefix, n_rows


def ingest(
    con,
    cfg: dict,
    mrt_file: Optional[str] = None,
    url: Optional[str] = None,
    reset: bool = False,
    limit: Optional[int] = None,
    family: Optional[int] = None,
    **_legacy,
) -> dict:
    """下载并解析各采集点 RIB, 入 DuckDB 工作库(obs), 末尾 finalize 出 pathobs/prefix。

    family: 4 / 6 / None(两者都收)。`mrt_file` 给定时只解析该本地文件(用首个 collector 作标签, 调试用)。
    """
    util.ensure_dirs()
    store.init_schema(con)
    now = int(time.time())

    if reset:
        util.log("  --reset: 清空 obs/pathobs/prefix")
        store.reset(con)

    # geo 跟随 ingest: 检查 GeoLite 是否过期(过期才下), 首次或 GeoLite 更新时重建 geo(否则复用, geo 不随 reset 清)。
    # profile 关了 geo(dn42 无地理)则整段跳过。peeras 默认 geo=True => 行为不变。
    from . import profile
    if profile.features(cfg)["geo"]:
        try:
            from . import geoip
            rel = geoip.ensure_geolite(cfg)
            has_geo = con.execute(
                "SELECT count(*) FROM information_schema.tables WHERE table_name='geo'").fetchone()[0]
            if not has_geo or store.get_meta(con, "geo_tag") != (rel.get("tag") or ""):
                geoip.build_geo(con, cfg, rel)
                store.set_meta(con, "geo_tag", rel.get("tag") or "")
            else:
                util.log(f"  geo 复用(GeoLite {rel.get('tag')} 未变)")
        except Exception as e:  # noqa: geo 失败不阻断 ingest(导出时 geo 缺则前缀 cc=ZZ)
            util.log(f"  ! geo 准备失败({e}); 继续 ingest", err=True)
    else:
        util.log("  geo: profile 已关闭(无地理), 跳过 GeoLite/geo 构建")

    def keep_pred(start: int, end: int, fam: int) -> bool:
        return (family is None) or (fam == family)

    util.log(f"  入库口径: 全表(v4+v6); family={'全部' if family is None else 'v'+str(family)}; "
             f"采集点={collectors(cfg) if mrt_file is None else '本地文件'}")

    total_prefix = total_rows = 0
    if mrt_file is not None:
        coll = (collectors(cfg) or ["local"])[0]
        store.set_meta(con, "mrt_file", mrt_file)
        p, r = _ingest_one(con, mrt_file, coll, keep_pred, limit)
        total_prefix += p; total_rows += r
    else:
        urls = []
        coll_list = collectors(cfg)
        if url is not None:                       # 显式单 URL -> 用首个 collector 标签
            coll_list = coll_list[:1] or ["rrc01"]
            urls = [(coll_list[0], url)]
        elif cfg.get("mrt_layout") == "dn42":
            # dn42 GRC: 直接取 master4/6_latest.mrt.bz2(无月份目录, bz2)。family 决定取哪个文件。
            base = cfg["mrt_base_url"].rstrip("/")
            label = (coll_list or ["mrt42"])[0]
            if family in (None, 4):
                urls.append((label, f"{base}/master4_latest.mrt.bz2"))
            if family in (None, 6):
                urls.append((label, f"{base}/master6_latest.mrt.bz2"))
            for _, u in urls:
                util.log(f"  [{label}] dn42 RIB: {u}")
        else:
            for c in coll_list:
                u = latest_bview_url(cfg, c)
                util.log(f"  [{c}] 最新 RIB: {u}")
                urls.append((c, u))
        for c, u in urls:
            # 各采集点的 bview 文件名相同(bview.<date>.<time>.gz) -> 缓存路径必须按 collector 命名, 否则互相覆盖。
            dest = str(util.MRT_CACHE_DIR / f"{c}-{os.path.basename(u)}")
            mf = download(u, dest=dest)
            store.set_meta(con, f"mrt_url_{c}", u)
            p, r = _ingest_one(con, mf, c, keep_pred, limit)
            total_prefix += p; total_rows += r

    fin = store.finalize(con)
    store.set_meta(con, "ingest_ts", now)
    store.set_meta(con, "collectors", ",".join(collectors(cfg)))
    util.log(f"  入库完成: obs {total_rows} 行 -> prefix v4={fin['v4']} v6={fin['v6']}, "
             f"pathobs {fin['pathobs']}")
    return {"prefixes_v4": fin["v4"], "prefixes_v6": fin["v6"],
            "pathobs": fin["pathobs"], "obs_rows": total_rows}
