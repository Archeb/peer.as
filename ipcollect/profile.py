"""站点 Profile / Feature Flags —— 让同一套代码服务多个站点(peer.as 全球公网 / dn42)。

**核心约定(维护铁律)**:差异一律「配置关成 no-op」, **绝不靠删代码分叉** —— 这样主站演进时
dn42 永不冲突, 「改一处两边同步」才成立(见 AGENTS.md「站点 Profile」)。

用法:
    from . import profile
    feats = profile.features(cfg)        # cfg = config.load()
    if feats["geo"]:
        ...                              # geo 管线(geoip/carve/国家 SSG/前端地区导航)

profile 由 `cfg["site"]`(默认 "peeras")选定; 单个开关可被 `cfg["features"]` 覆盖(无需换 site)。
**peeras = 现状全开**, 任何新开关的默认值都必须复现 peer.as 当前行为(否则就是回归)。

本模块**不 import 包内任何东西**(避免循环依赖): config/mrt/parquet_export 都依赖它。
"""
from __future__ import annotations

from typing import Any

# 各站点的特性开关。新增开关时: peeras 的值 = 复现现状; dn42 的值 = 目标行为。
#   geo        geo 管线总开关(geoip ensure/build、export carve+国家 SSG、前端地区导航)。dn42 无地理 => False。
#   cn_mirror  部署 cn.peer.as 整站镜像(deploy.sh 的 CN 段)。dn42 只上 CF Pages => False。
#   whois      前端 whois 后端: "rdap"(公网直连 RDAP+兜底 worker) / "registry"(dn42 registry 静态数据)。[Phase2 前端接线]
#   rpki       RPKI ROA 路由起源验证(rpki.py)。peeras=Cloudflare VRP; dn42=registry max-length。数据缺失时 has_rpki=False 自动 no-op。
#   irr        IRR route 对象登记态(irr.py)。peeras=RIR/RADB dump; dn42=registry route 对象。数据缺失时 has_irr=False 自动 no-op。
#   asset      IRR as-set 客户锥层级树(asset.py)。peeras=RIR/RADB as-set dump; dn42=registry data/as-set。数据缺失时 has_asset=False 自动 no-op。
#   peeringdb  PeeringDB ASN/IXP/facility 数据集。公网站展示 IXP/peering 画像; dn42 无公网 PeeringDB 语义。
PROFILES: dict[str, dict[str, Any]] = {
    "peeras": {
        "geo": True,
        "cn_mirror": True,
        "whois": "rdap",
        "rpki": True,
        "irr": True,
        "asset": True,
        "peeringdb": True,
    },
    "dn42": {
        "geo": False,
        "cn_mirror": False,
        "whois": "registry",
        "rpki": True,
        "irr": True,
        "asset": True,
        "peeringdb": False,
    },
}

DEFAULT_SITE = "peeras"


def site(cfg: dict) -> str:
    s = (cfg or {}).get("site") or DEFAULT_SITE
    return s if s in PROFILES else DEFAULT_SITE


def features(cfg: dict) -> dict[str, Any]:
    """返回该 cfg 的有效特性开关 = 该 site 的 profile, 再叠加 cfg["features"] 的逐项覆盖。"""
    f = dict(PROFILES[site(cfg)])
    overrides = (cfg or {}).get("features")
    if isinstance(overrides, dict):
        f.update(overrides)
    return f
