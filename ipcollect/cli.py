"""命令行入口: ipc <子命令>。"""
from __future__ import annotations

import argparse
import sys

from . import config, geoip, mrt, serve, store, util


# ----------------------------------------------------------------------------
# 子命令实现 (CLI 只做部署/处理快捷入口; 查询入口已退役, source of truth = 原始 MRT)
# ----------------------------------------------------------------------------
def cmd_init(args):
    wrote = config.init_default(force=args.force)
    util.ensure_dirs()
    con = store.connect(); store.init_schema(con); con.close()
    util.log(f"配置: {util.CONFIG_PATH} ({'已写默认' if wrote else '已存在, 保留'})")
    util.log(f"DuckDB 工作库: {util.DUCK_PATH}")
    print("初始化完成。下一步: ipc geo-import  然后  ipc ingest")


def cmd_config(args):
    cfg = config.load()
    if args.action == "show" or args.action is None:
        import json
        print(json.dumps(cfg, ensure_ascii=False, indent=2))
        return
    if args.action == "set":
        key, val = args.key, args.value
        cfg[key] = val
        config.save(cfg)
        print(f"已设置 {key} = {cfg[key]}")


def cmd_geo_import(args):
    """构建 DuckDB geo: ipdb(CN 城市) + GeoLite2-City(非 CN 全球, v4+v6) 合并非重叠 + asn_dim(org)。"""
    cfg = config.load()
    con = store.connect()
    try:
        gl = None
        if not args.no_geolite:
            try:
                gl = geoip.ensure_geolite(cfg, force=args.force_download)
            except Exception as e:  # noqa
                util.log(f"! GeoLite 不可用({e}); 仅 ipdb", err=True)
        r = geoip.build_geo(con, cfg, gl)
        store.set_meta(con, "geo_tag", (gl or {}).get("tag") or "")   # 让后续 ingest 复用 geo
    finally:
        con.close()
    print(f"geo 导入完成: {r}")


def cmd_ingest(args):
    cfg = config.load()
    con = store.connect()
    try:
        only = [c.strip() for c in args.only.split(",") if c.strip()] if args.only else None
        r = mrt.ingest(con, cfg, mrt_file=args.mrt_file, url=args.url,
                       reset=args.reset, limit=args.limit, family=args.family, only=only)
    finally:
        con.close()
    print(f"ingest 完成: {r}")


def cmd_build(args):
    """构建前端(Vite+Svelte: npm run build)并拷进 dist/。改了前端(web/)的日常命令;
    不碰数据(免重跑 export-parquet)。--no-npm 跳过 npm、只拷已构建的 web/dist。"""
    from pathlib import Path
    from . import parquet_export
    web = Path(__file__).resolve().parent / "web"
    if not args.no_npm:
        import subprocess
        util.log("npm run build (ipcollect/web) …")
        subprocess.run(["npm", "run", "build"], cwd=str(web), check=True)
    n = parquet_export.copy_web(out_dir=args.out)
    print(f"前端构建完成: npm run build + 拷 {n} 文件 (web/dist -> {args.out}/); 数据未动。")
    print("部署: scripts/deploy.sh (唯一部署入口; 自动按 config.json 的 site/cf_project 选目标)")


def cmd_export_parquet(args):
    cfg = config.load()
    con = store.connect()   # 需可写: export 建 pgeo/pp/seg 等工作表
    from . import parquet_export
    try:
        r = parquet_export.export(cfg, con, out_dir=args.out)
    finally:
        con.close()
    print(f"parquet 导出: {r['parquet_files']} 文件 / {util.human(r['parquet_bytes'])}B "
          f"(v4={r['v4']} v6={r['v6']} 前缀, {r['paths']} 去重路径, {r['segments']} 切段, "
          f"{r['countries']} 国家) -> {r['out']}/data/parquet/")


def cmd_sync_web(args):
    """只把已构建前端 web/dist 拷进 out(数据没变、web 已 build 时用; 要顺带 npm build 用 `ipc build`)。"""
    from . import parquet_export
    n = parquet_export.copy_web(out_dir=args.out)
    print(f"前端已同步: {n} 文件 (web/dist -> {args.out}/); 未跑 npm、未重导出 parquet/SSG。")


def cmd_rpki_import(args):
    """下载/解析 RPKI VRP -> cache/rpki/(供 export-parquet 标 RPKI 状态)。"""
    from . import rpki
    cfg = config.load()
    m = rpki.refresh(cfg, force=args.force)
    print(f"RPKI VRP: {m['count']} 条 (as of {m['as_of_str']}) <- {m['source']}" if m
          else "RPKI 已跳过(开关关或无数据)")


def cmd_irr_import(args):
    """下载/解析 IRR route 对象 -> cache/irr/(供 export-parquet 标 IRR 登记态 + 明细)。"""
    from . import irr
    cfg = config.load()
    m = irr.refresh(cfg, force=args.force)
    print(f"IRR route: {m['count']} 对象 / {len(m['sources'])} 源 (as of {m['as_of_str']})" if m
          else "IRR 已跳过(开关关或无数据)")


def cmd_asset_import(args):
    """下载/解析 IRR as-set 对象 -> cache/asset/(供 export-parquet 出 as-set 层级树)。"""
    from . import asset
    cfg = config.load()
    m = asset.refresh(cfg, force=args.force)
    print(f"as-set: {m['n_sets']} 集合 / {m['n_edges']} 成员边 / {len(m['sources'])} 源 (as of {m['as_of_str']})" if m
          else "as-set 已跳过(开关关或无数据)")


def cmd_serve(args):
    cfg = config.load()
    serve.serve(cfg, out_dir=args.out, port=args.port, host=args.host, rebuild=args.rebuild)


# ----------------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(prog="ipc", description="BGP Insights — 回程 AS_PATH 采集/分析/静态看板")
    p.add_argument("-q", "--quiet", action="store_true", help="减少日志")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("init", help="初始化配置与 DuckDB 工作库")
    s.add_argument("--force", action="store_true", help="覆盖已有配置")
    s.set_defaults(func=cmd_init)

    s = sub.add_parser("config", help="查看/修改配置")
    cs = s.add_subparsers(dest="action")
    cs.add_parser("show").set_defaults(func=cmd_config)
    st = cs.add_parser("set"); st.add_argument("key"); st.add_argument("value")
    st.set_defaults(func=cmd_config)
    s.set_defaults(func=cmd_config)

    s = sub.add_parser("geo-import", help="构建 DuckDB geo: ipdb(CN城市)+GeoLite(非CN全球,v4+v6)+asn_dim(org)")
    s.add_argument("--no-geolite", action="store_true", help="跳过 GeoLite, 仅 ipdb(CN)")
    s.add_argument("--force-download", action="store_true", help="强制重下 GeoLite(忽略版本戳)")
    s.set_defaults(func=cmd_geo_import)

    s = sub.add_parser("ingest", help="下载并解析各采集点 RIB 入 DuckDB 工作库(全表 v4+v6)")
    s.add_argument("--reset", action="store_true", help="清空旧数据重建")
    s.add_argument("--only", help="仅重灌这些采集点(逗号分隔; 其余 obs 保留)——按采集点增量刷新, 需先全量打底")
    s.add_argument("--limit", type=int, help="每采集点最多入库前缀数(调试)")
    s.add_argument("--mrt-file", help="用本地 MRT 文件而非下载(单文件, 调试)")
    s.add_argument("--url", help="指定单个 RIB URL")
    s.add_argument("--family", type=int, choices=[4, 6], help="只收某族(默认 v4+v6 都收)")
    s.set_defaults(func=cmd_ingest)

    s = sub.add_parser("build", help="构建前端(npm run build)并拷进 dist/(改了前端日常用; 不碰数据)")
    s.add_argument("--out", default="dist", help="输出目录(默认 dist)")
    s.add_argument("--no-npm", action="store_true", help="跳过 npm run build, 只拷已构建的 web/dist(同 sync-web)")
    s.set_defaults(func=cmd_build)

    s = sub.add_parser("export-parquet", help="导出 Parquet 数据集(全球, 供 DuckDB-WASM 前端)")
    s.add_argument("--out", default="dist", help="输出目录(默认 dist)")
    s.set_defaults(func=cmd_export_parquet)

    s = sub.add_parser("sync-web", help="只拷已构建前端 web/dist -> dist(不跑 npm; 要顺带 build 用 `ipc build`)")
    s.add_argument("--out", default="dist", help="输出目录(默认 dist)")
    s.set_defaults(func=cmd_sync_web)

    s = sub.add_parser("rpki-import", help="下载 RPKI VRP -> cache/rpki(供 export 标 RPKI 状态)")
    s.add_argument("--force", action="store_true", help="忽略本地缓存强制重下")
    s.set_defaults(func=cmd_rpki_import)

    s = sub.add_parser("irr-import", help="下载 IRR route 对象 -> cache/irr(供 export 标 IRR 登记态)")
    s.add_argument("--force", action="store_true", help="忽略本地缓存强制重下")
    s.set_defaults(func=cmd_irr_import)

    s = sub.add_parser("asset-import", help="下载 IRR as-set 对象 -> cache/asset(供 export 出 as-set 层级树)")
    s.add_argument("--force", action="store_true", help="忽略本地缓存强制重下")
    s.set_defaults(func=cmd_asset_import)

    s = sub.add_parser("serve", help="本地 debug: 静态托管 build 产物")
    s.add_argument("--out", default="dist", help="要托管的目录(默认 dist)")
    s.add_argument("--rebuild", action="store_true", help="先重新 build 再托管")
    s.add_argument("--host", default="127.0.0.1"); s.add_argument("--port", type=int, default=8787)
    s.set_defaults(func=cmd_serve)

    return p


def main(argv=None):
    p = build_parser()
    args = p.parse_args(argv)
    if args.quiet:
        util.set_quiet(True)
    if not getattr(args, "func", None):
        p.print_help(); return 1
    try:
        return args.func(args) or 0
    except KeyboardInterrupt:
        util.log("中断", err=True); return 130
    except Exception as e:  # noqa
        util.log(f"错误: {e}", err=True)
        if __debug__ and "--trace" in (argv or sys.argv):
            raise
        return 1


if __name__ == "__main__":
    sys.exit(main())
