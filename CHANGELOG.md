# 更新日志 / Changelog

PEER.AS 的功能更新记录。仅记录**面向用户的功能性变更**（新功能、可见行为变化）；
纯维护/重构/数据刷新不计入。最新在上。

Feature-level changelog for PEER.AS. Only **user-facing functional changes** are listed
(new features, visible behavior changes); pure maintenance/refactors/data refreshes are omitted. Newest first.

## 2026-07-21

- **修正：AS_PATH 搜索改按匹配观测占比判断主导路径。** 搜索结果不再用一条最短完整路径冒充“全球最优路径”，而是汇总所有匹配路径的 peer 观测数，显示“匹配 / 全部”及百分比并据此排序；只有超过半数观测匹配才标星。原星标路径改称“代表观测路径”，不再声称是实际流量路径。
  **Fixed: AS_PATH search now determines dominance by matching-observation share.** Results no longer treat one shortest full path as a “global best path”; they aggregate peer observations across every matching path, show the matched/total count and percentage, and rank by that share. A star now requires a strict majority. The former best-path marker is renamed “representative observed path” and no longer claims to describe actual traffic.

## 2026-07-12

- **改进：新增 AS4837 美国路由视角。** 在原有 4 个公开全表采集点之外，新增 AS4837 美国网络内部视角，补充其可见前缀的回程 AS_PATH；数据源列表同时展示各视角的快照新鲜度。
  **Improved: added an AS4837 US routing perspective.** Alongside the four public full-table collectors, an internal AS4837 US perspective now adds back-haul AS_PATH visibility for its observed prefixes; the source list also shows snapshot freshness for each perspective.

## 2026-07-11

- **新增：NextTrace 路径分享卡。** 分享 `peer.as/trace?nt=<id>` 时，社交预览现在以极简路径图展示去重后的地理位置、逐跳 ASN 与运营商，并在过长路径中自动折叠中间跳点。
  **Added: NextTrace route share cards.** Sharing `peer.as/trace?nt=<id>` now produces a compact route preview with deduplicated locations, hop ASNs and operators, automatically collapsing the middle of long paths.

## 2026-07-01

- **新增：PeeringDB 画像。** ASN 详情面板新增 PeeringDB 分区，展示该网络的**自报概况**（类型 / 流量规模 / 对等策略 / IRR as-set 等）、**接入的交换中心（IX presence）**（含端口速率、是否与 route server 对等）与**入驻的数据中心（facility presence）**。数据来自 CAIDA PeeringDB 快照，全部预处理成静态数据、前端零后端查询。
  **Added: PeeringDB profiles.** The ASN detail panel gains a PeeringDB section showing the network's **self-reported profile** (type / traffic scale / peering policy / IRR as-set, etc.), its **IX presence** (with port speeds and route-server peering) and its **facility presence**. Data comes from the CAIDA PeeringDB snapshot, fully pre-processed into static assets with zero backend queries.
- **新增：IXP 浏览器与 IX 目录。** 可查询任一互联网交换中心（IXP）的详情——**成员网络**（可即时筛选 / 排序、点行下钻 ASN）、**交换网段（IXLAN）与前缀**、**route server**、**所在数据中心**与总接入容量。配套 `peer.as/ixps` **按国家/地区浏览的 IX 目录**（SSR 落地页，利于检索与收录）。从 ASN 详情点某个 IX 时，左侧切到 IXP 视图、右侧详情面板保留不刷新。
  **Added: an IXP browser and IX directory.** You can now look up any Internet Exchange Point (IXP) — its **member networks** (instant filter / sort, click a row to drill into the ASN), **peering LANs (IXLANs) and prefixes**, **route servers**, **facilities** and total connected capacity. A companion `peer.as/ixps` **IX directory by country/region** (SSR landing pages) aids discovery and indexing. Clicking an IX from an ASN detail opens the IXP view on the left while keeping the detail panel on the right.
- **革新：全新搜索建议下拉。** 顶栏搜索框与 WHOIS 首页命令行现在共用同一套**智能建议**：输入即给出分组结果——**直达**（ASN / 前缀 / 域名 / as-set）、**自治系统**（按 AS 名反查）、**交换中心**（按 IX 名 / 城市），配合**最近搜索历史**；支持键盘上下选择、回车直达。
  **Revamped: a new search-suggestions dropdown.** The top-bar search and the WHOIS home command line now share one **smart-suggestion** engine: as you type it groups results into **direct hits** (ASN / prefix / domain / as-set), **autonomous systems** (reverse AS-name lookup) and **exchanges** (by IX name / city), alongside your **recent-search history**, with arrow-key navigation and Enter-to-go.
- **改进：WHOIS 首页直接展示完整详情。** 首页查询结果不再是浅层 WHOIS 卷宗——现在内联展开与详情面板一致的**完整信息**（ASN 含 PeeringDB / 邻居关系 / 通告前缀；前缀含路径图 / IRR / RPKI / 全部观测路径；域名含 DNS/RDAP），无需再点「查看更多」跳转。
  **Improved: the WHOIS home page now shows full details inline.** Home-page results are no longer a shallow WHOIS card — they inline the **complete information** matching the detail panel (ASN with PeeringDB / neighbors / originated prefixes; prefix with the path graph / IRR / RPKI / all observed paths; domain with DNS/RDAP), with no more «see more» hop.
- **改进：设施 / 交换中心行显示所在国家/地区国旗。** PeeringDB 设施行、IX 目录与详情标题前加上对应国家/地区的旗标，一眼定位地理归属。
  **Improved: country/region flags on facility & exchange rows.** PeeringDB facility rows and IX directory/detail headers now show the corresponding country/region flag for quick geographic orientation.

## 2026-06-16

- **新增：NextTrace traceMap 可直接在全球网测地球上打开。** NextTrace 生成的 traceMap 链接现在可通过
  `peer.as/trace?nt=<id>` 在 PEER.AS 的全球网测界面复用现有地球可视化查看，逐跳路径、目标位置和原始 traceMap
  来源链接会一并显示；原有 globalping 实时网测流程不变。
  **Added: NextTrace traceMap can open directly on the global trace globe.** NextTrace-generated traceMap results can now
  be viewed through PEER.AS at `peer.as/trace?nt=<id>`, reusing the existing globe visualization with hop paths, target
  location and a source link back to the original traceMap; the existing live globalping flow is unchanged.

## 2026-06-13

- **新增：AS_PATH 显示并标注 prepend（`ASN ×N`）。** 详情面板的观测路径列表现在**保留 AS prepend**——某个 AS 在路径里连续出现多次会折叠成 `ASN ×N`，悬停提示「AS prepend ×N」。prepend 是各网络表达**入向流量工程（inbound TE）**的信号，之前被折叠丢掉了，现在能看到了。
  **Added: AS_PATH now shows & annotates prepends (`ASN ×N`).** The observed-path list in the detail panel **preserves AS prepends** — an AS repeated consecutively folds into `ASN ×N` with an «AS prepend ×N» tooltip. Prepends are how networks express **inbound traffic engineering**; they were previously collapsed away and are now visible.
- **改进：采集点 2 → 4，回程可见性更全。** 新增 RIPE RIS **rrc03**（阿姆斯特丹 AMS-IX）与 RouteViews **route-views2**（美国 Oregon）两个采集点，与原有的 rrc01（伦敦）/ rrc06（东京）互补。可见的 AS 互联关系（邻接边）增加约 **22%**、去重路径增加约 **90%**，更多 transit 与 IXP 路径能被观测到。
  **Improved: 2 → 4 collection points for broader back-haul visibility.** Added RIPE RIS **rrc03** (Amsterdam AMS-IX) and RouteViews **route-views2** (Oregon, US), complementing the existing rrc01 (London) / rrc06 (Tokyo). Visible AS adjacencies grew ~**22%** and distinct paths ~**90%** — more transit and IXP paths are now observed.
- **改进：ASN 查询更快。** 「某 AS 通告的前缀」改用精简的预建 origin 索引 + 预聚合计数，每次查询读取的数据量大幅降低。
  **Improved: faster ASN lookups.** «Prefixes originated by an AS» now uses a lean pre-built origin index plus pre-aggregated counts, sharply cutting the data read per query.

## 2026-06-07

- **新增：首页 3D 地球路由可视化。** peer.as 首页背景新增一个可交互的 3D 地球，自动识别你的连接来源，并把你到各
  **Tier-1 骨干**的回程路由画成动态路线；地球上的 Tier-1 节点可直接点击查询。出现查询结果时整块淡出，回到首页再升起。
  **Added: a 3D globe routing visualization on the home page.** The peer.as home page gains an interactive 3D globe that
  detects your connection's origin and animates the back-haul routes from you to each **Tier-1 backbone**; Tier-1 nodes on
  the globe are clickable to look them up. It fades out when a query result appears and rises back when you return home.
- **新增：「你的接入」自助探测。** 首页向数十个边缘端点（各大 CDN 的 `cdn-cgi/trace` 等）发起请求，探测出你**全部的出口 IP**
  （多线 / 多出口 / 双栈下会各不相同），按 IPv4 / IPv6 分两叠卡片，显示每个出口的**覆盖前缀、地理位置、origin AS（含 AS 名称）**（均可点击下钻）。
  右下角色标注明协议栈，浏览器主用的那一栈以淡橙高亮；点卡堆下方箭头，所有出口会像**发牌**一样摊成网格一览，再点收回；每叠右上角折角钮可**隐藏 IP**（记忆状态）方便截图。
  **Added: a «Your connection» self-probe.** The home page queries dozens of edge endpoints (CDN `cdn-cgi/trace` and friends) to
  discover **all of your egress IPs** (which differ across multi-WAN / multi-egress / dual-stack), grouped into IPv4 / IPv6 card stacks
  showing each egress's **covering prefix, location and origin AS (with AS name)** (all clickable to drill down). A corner tag marks the
  protocol stack — amber for the browser's active one; a chevron **deals** every egress out into a grid (click again to fold), and a corner toggle **hides the IP** (remembered) for screenshots.

## 2026-06-04

- **新增：结果分页与 CSV 导出。** 路由分析的结果表（全表 / 国家 / 子网搜索）状态栏右侧新增**翻页**（上一页 / 下一页，按
  每页条数 offset 翻）和**导出**按钮。点导出弹出浮窗，勾选要导出的列（前缀 / origin AS / AS 名称 / 国家 / 位置 / 前缀长度 /
  观测路径数 / RPKI / IRR / MOAS 源数 / 最优路径 / 覆盖网段），把**当前搜索的全部匹配结果**导出为 UTF-8 CSV（带 BOM，Excel 直接打开不乱码）。
  **Added: result pagination & CSV export.** The routing-analysis result table (global / country / subnet search) gains
  **prev/next paging** (by offset) and an **Export** button on the right of the status bar. Export opens a dialog to pick columns
  (prefix / origin AS / AS name / country / location / prefix length / path count / RPKI / IRR / MOAS / best path / sub-prefixes)
  and downloads **all matching rows of the current search** as a UTF-8 CSV (with BOM, opens cleanly in Excel).
- **新增：WHOIS 查询首页。** peer.as 打开即是一个搜索框，直查任意 **ASN / IP / 前缀 / 域名** 的注册信息，结果以「注册局卷宗」
  样式呈现，并标注数据所用协议（RDAP / WHOIS）；无 RDAP 的 ccTLD（如 `.de`）自动回退到传统 WHOIS。可经 `/whois/<查询>` 直达与分享。
  原「路由分析」（前缀表 / AS_PATH / 地区 / 子网等）移到侧栏切换，落地页为 `/advanced`（`peer.as/4134`、`/1.1.1.0/24` 等链接照旧）。
  搜 as-set、AS 名称等非 WHOIS 对象会自动转到路由分析；搜索框右下角的 **「高级搜索」开关**（记忆状态）勾上后任何查询都直接进路由分析。
  **Added: a WHOIS lookup home page.** peer.as now opens to a search box for any **ASN / IP / prefix / domain** registration data,
  rendered as a «registry dossier» noting the protocol used (RDAP / WHOIS); ccTLDs without RDAP (e.g. `.de`) fall back to classic
  WHOIS. Deep-linkable via `/whois/<query>`. The original «Routing» analysis (prefix table / AS_PATH / region / subnet …) moves to a
  sidebar toggle, landing at `/advanced` (links like `peer.as/4134`, `/1.1.1.0/24` are unchanged). Searching an as-set or AS-name
  (not a WHOIS object) jumps to routing; an **«Advanced» toggle** (remembered) sends every query straight to routing analysis.
  每条结果底部提供「查看更多信息」，一键跳到路由分析里该 ASN / 前缀 / 域名的完整详情（邻居与关系、RPKI/IRR、DNS）。
  无 RDAP 的 ccTLD（.jp / .kr / .de / .ru / .it / .nl / .uk … ）的 WHOIS 原文现在会被解析成与 RDAP 一致的友好字段
  （注册商 / 注册与到期时间 / 名称服务器 / 状态 / DNSSEC 等），日期统一格式化；原始全文仍完整保留。
  Each result offers a «view more details» jump into the Routing view's full record for that ASN / prefix / domain (neighbors &
  relationships, RPKI/IRR, DNS). WHOIS text from ccTLDs without RDAP (.jp / .kr / .de / .ru / .it / .nl / .uk …) is now parsed into
  the same friendly fields as RDAP (registrar / created & expiry / nameservers / status / DNSSEC), with normalized dates; the full
  raw text is still preserved.
- **新增：RPKI ROA 与 IRR 路由起源验证。** 每个前缀的 origin 现在会显示 **RPKI** 状态徽章（有效=绿 / 无效=红，
  无效细分「origin 未授权」与「比 maxLength 更具体」/ 未找到=中性，参照 bgp.he.net、bgp.tools）；前缀详情面板新增
  **IRR 路由对象**区块，列出该前缀在各 IRR 库（RIPE/APNIC/ARIN/AFRINIC/LACNIC…）登记的 route 对象并标注**权威/第三方**
  可信度。MOAS 多源前缀的每个 origin 各自显示状态。数据每日刷新，面板标注「数据截至」时间。
  **Added: RPKI ROA & IRR route-origin validation.** Each prefix's origin now shows an **RPKI** status badge (Valid=green /
  Invalid=red, split into «origin not authorized» vs «more specific than maxLength» / Not Found=neutral — following
  bgp.he.net & bgp.tools); the prefix detail panel gains an **IRR route objects** section listing the route objects
  registered for that prefix across IRR databases (RIPE/APNIC/ARIN/AFRINIC/LACNIC…) with an **authoritative/third-party**
  trust marker. Each origin of a MOAS prefix is validated independently. Data refreshes daily with an «as of» timestamp.
- **新增：IRR as-set 客户锥层级浏览。** 在搜索框输入 as-set 名（如 `AS-HURRICANE`、`AS2914:AS-GLOBAL`，或带来源
  `RIPE::AS-FOO`），左侧主区会以**可逐层展开的嵌套列表**显示它的成员——子 as-set 点一下就地展开下一层（懒加载、带环检测
  与深度上限），成员 ASN 可点击下钻。ASN 详情面板也新增「所属 as-set」反查（此 AS 被哪些 as-set 直接登记为成员）。
  **Added: IRR as-set customer-cone browser.** Type an as-set name (e.g. `AS-HURRICANE`, `AS2914:AS-GLOBAL`, or
  source-qualified `RIPE::AS-FOO`) and the main pane shows it as an **expandable nested list** — click a child as-set to
  expand the next level in place (lazy-loaded, with cycle detection and a depth cap); member ASNs drill down. The ASN
  detail panel also gains a «member of as-sets» reverse lookup (which as-sets directly list this AS).
- **改进：ASN 完整邻居改为自动、完整、即时。** ASN 详情的「邻居」从原来「点按钮 → 全表扫描（慢、且超 2 万条截断）」改为
  **导出期预计算的全网 AS 邻接**，打开 ASN 即自动展示上游/对端/下游，完整无截断、瞬时返回。
  **Improved: complete ASN neighbors are now automatic, complete and instant.** The ASN detail «neighbors» section
  switched from «click to full-scan (slow, capped at 20k)» to **export-time precomputed global AS adjacency** — opening
  an ASN shows upstream/peer/downstream immediately, complete and uncapped.

## 2026-06-03

- **改进：浏览器标签/历史记录显示当前详情。** 打开某个前缀、ASN 或域名详情时，浏览器标签页标题（以及前进/后退
  历史记录里的条目）会随之变成正在查看的对象（如 `1.1.1.0/24 · PEER.AS`、`AS4538 CERNET · PEER.AS`），方便在
  历史记录里快速找回此前看过的页面。
  **Improved: browser tab/history shows the current detail.** When you open a prefix, ASN or domain detail, the
  browser tab title (and the entry in back/forward history) now reflects what you’re viewing (e.g.
  `1.1.1.0/24 · PEER.AS`, `AS4538 CERNET · PEER.AS`), making it easy to find a previously viewed page in history.

- **新增：DNS 解析页。** 在搜索框直接输入域名（如 `example.com`）即可解析 DNS：左侧列出全部记录——A / AAAA
  记录会逐条匹配到库内的 IP 前缀与 origin ASN（可点击下钻到前缀/ASN 详情），其余记录（NS / MX / TXT / SOA /
  CNAME / CAA 等）直接展示；右侧域名详情面板与 ASN 面板逻辑一致，自动尝试查询域名的 RDAP/WHOIS 注册信息
  （注册商、注册/到期时间、名称服务器、DNSSEC 等）。解析走 DNS over HTTPS（Cloudflare 1.1.1.1），纯前端、零后端。
  专属网址 `peer.as/dns/example.com` 可分享。
  **New: DNS lookup page.** Type a domain (e.g. `example.com`) right in the search box to resolve DNS: the left side
  lists all records — A / AAAA records are matched to the covering IP prefix and origin ASN in our dataset (click to
  drill into prefix/ASN detail), while other records (NS / MX / TXT / SOA / CNAME / CAA …) are shown directly; the
  right-side domain panel works like the ASN panel and auto-attempts the domain’s RDAP/WHOIS registration info
  (registrar, registration/expiry dates, nameservers, DNSSEC …). Resolution uses DNS over HTTPS (Cloudflare 1.1.1.1),
  fully client-side with no backend. Shareable URL: `peer.as/dns/example.com`.

## 2026-06-02

- **改进：英文界面国际化。** 英文界面下运营商（电信/联通/移动…→ Telecom/Unicom/Mobile…）、ASN 别名
  （如 CN2、CUII、CERNET）以及地名不再夹杂中文：日韩等城市过去会显示「英文省+中文市」，现在英文界面统一显示英文，
  无英文名的（如国内城市）回退到英文国家/地区名。
  **Improved: English UI internationalization.** In the English UI, operator categories (Telecom/Unicom/Mobile…),
  ASN aliases (e.g. CN2, CUII, CERNET) and place names no longer mix Chinese in: cities in Japan/Korea etc. used to
  show “English province + Chinese city”; the English UI now shows English throughout, falling back to the English
  country/region name where no English name exists (e.g. mainland-China cities).

- **新增：可分享的链接 / 浏览器前进后退。** 现在 ASN 与前缀详情都有独立网址，可直接打开或分享：
  `peer.as/4842`（ASN）、`peer.as/1.1.1.0/24`（前缀，IPv6 同理）会自动填入搜索框、搜索并展开对应详情；
  也支持传统的 `peer.as/?q=关键词` 搜索。在站内切换详情会更新网址，浏览器的前进/后退按钮可在浏览过的详情间穿梭。
  **New: shareable links / browser back-forward.** ASN and prefix details now have their own URLs you can open or share
  directly: `peer.as/4842` (ASN) and `peer.as/1.1.1.0/24` (prefix; IPv6 likewise) auto-fill the search box, search and
  open the matching detail; the classic `peer.as/?q=term` search also works. Navigating details updates the URL, and the
  browser back/forward buttons move through the details you’ve viewed.

- **新增：WHOIS / 注册信息（RDAP）+ ASN 详情面板。** 前缀详情面板新增「WHOIS / 注册信息」区块（持有者、
  netname、分配类型、abuse 联系人、注册/变更时间），浏览器直连各 RIR RDAP 实时获取；在精确框输入一个
  ASN（如 `AS4809`）会自动展开该 ASN 的详情面板——含 WHOIS、通告的前缀、观测到的上游，并可一键全表扫描完整
  上下游邻居。详情面板新增前进/后退导航，可在 ASN 与前缀之间来回；点击前缀详情里的 origin ASN 即可跳到它的
  ASN 页。WHOIS 以传统扁平风格呈现（一行一项、常见字段带图标，嵌套联系人可点击展开）。
  **New: WHOIS / registration (RDAP) + ASN detail panel.** The prefix panel now has a “WHOIS / registration”
  section (holder, netname, allocation type, abuse contact, registration/change dates), fetched live straight
  from the RIRs’ RDAP in your browser. Typing an ASN (e.g. `AS4809`) into the precise box auto-opens that ASN’s
  detail panel — WHOIS, originated prefixes, observed upstreams, with an on-demand full-table scan for complete
  up/downstream neighbors. The detail panel gains back/forward navigation to move between ASN and prefix views;
  click the origin ASN in a prefix panel to jump to its ASN page. WHOIS is shown in a flat, classic style
  (one line per field, icons on common keys, nested contacts expand on click).

- **新增：IPv6 支持。** 现可搜索 IPv6 地址 / CIDR（如 `2001:db8::/32`）、按国家浏览 v6 前缀、查 v6 父子段;
  v4 与 v6 结果在国家/全表搜索里一并呈现。
  **New: IPv6 support.** Search IPv6 addresses/CIDRs (e.g. `2001:db8::/32`), browse v6 prefixes by country,
  and explore v6 parent/child segments; v4 and v6 results show together in country/global search.

- **新增：全球城市级地理 + AS organization。** 国际前缀也定位到城市（GeoLite，国内仍用更准的城市库）;
  ASN 悬停显示其 organization 全名。
  **New: worldwide city-level geo + AS organization.** International prefixes now resolve to city (GeoLite;
  CN still uses a more accurate DB); hovering an ASN shows its full organization name.

- **改进：双采集点。** 数据源改为 RIPE RIS `rrc01`（伦敦）+ `rrc06`（东京）两点合并，路径观测更全面。
  **Improved: dual collectors.** Data now merges RIPE RIS `rrc01` (London) + `rrc06` (Tokyo) for broader path coverage.

## 2026-06-01

- **新增：AS_PATH 通配与排除搜索。** AS_PATH 框现支持 `*`（任意间隔）、`?`（正好一跳）与 `!N`/`-N`（排除某 ASN）；
  搜索框旁的 `?` 图标可打开语法说明弹窗。
  **New: AS_PATH wildcard & exclusion search.** The AS_PATH box now supports `*` (any gap), `?` (exactly one hop)
  and `!N`/`-N` (exclude an ASN); a `?` icon beside the box opens a syntax help dialog.

- **改进：过滤默认路由 `0.0.0.0/0`。** 入库与数据集中不再包含默认路由（它不代表任何具体网络的可达性，
  仅会污染搜索与统计）。
  **Improved: filter the default route `0.0.0.0/0`.** The default route is no longer ingested or included in the
  dataset (it doesn't represent any specific network's reachability and only pollutes search/stats).

- **新增：按 AS 名称搜索。** 主搜索框现在支持直接输入 ASN 名称（中文或英文，如「阿里云」「Cloudflare」），
  自动反推匹配的 origin ASN（可命中多个），并按这些 origin 过滤前缀。
  **New: search by AS name.** The main search box now accepts an ASN name (Chinese or English, e.g. "Cloudflare"),
  automatically resolving it to the matching origin ASN(s) — multiple matches are all included — and filters prefixes by them.

- **改进：路由图绘制 origin → 上游 → Tier-1 的完整链路。** 修复了经多个 Tier-1 转接时被截断、
  以及直连 Tier-1（含 HE / AS6939）未被画出的问题；路径末端恒为 Tier-1，多 Tier-1 转接完整呈现。
  **Improved: route graph now draws the full origin → upstream → Tier-1 chain.** Fixed truncation when a path
  transits multiple Tier-1s, and direct Tier-1 peers (incl. HE / AS6939) not being drawn; the chain always
  terminates at a Tier-1, and multi-Tier-1 transit is shown in full.

- **改进：移动端布局。** 移除浮动侧栏，改为顶部品牌栏 + 右侧下拉菜单（统计、链接、语言/主题/关于/更新日志）。
  **Improved: mobile layout.** Replaced the floating sidebar with a top brand bar + right-side dropdown menu
  (stats, links, language/theme/about/changelog).

- **新增：更新日志。** 网站与仓库均可查看本更新日志。
  **New: changelog.** This changelog is viewable both on the site and in the repository.
