# PEER.AS

**A static, reproducible explorer for the global IPv4 + IPv6 BGP table** — every prefix,
its origin ASNs, and the actual **AS_PATH**s that reach it. The whole thing runs in
your browser: there is no backend, no API, and no database server. The site is just
a bundle of static files you can host, fork, or mirror anywhere.

Live at **[peer.as](https://peer.as)**.

It's a looking-glass-style reference for the routing table, delivered as a
self-hostable static artifact rather than a hosted service.

---

## The idea: the AS_PATH is the signal

PEER.AS is built on one opinion about public BGP data: **the part worth reading is
the AS_PATH** — *which* ASNs carry a prefix, and in *what order*. Everything follows
from that, and it deliberately avoids claims the data can't support:

- **Order and adjacency matter.** Searching `23764 4809` means those two ASNs appear
  **consecutively** in the path — a different question from "the path contains both
  somewhere." `1299 23764 4809` and `1299 4809` are genuinely different routes.
- **No line-quality scoring.** A public collector can't distinguish premium from
  standard transit (they often share an AS), so PEER.AS shows the path and does not
  grade it.
- **Origin AS is display-only.** It labels a prefix; it never drives ranking or
  filtering.
- **Multihoming falls out for free.** A collector's RIB is *per-peer*, so the set of
  distinct paths to a prefix is its observed multihome / equal-cost routing, straight
  from the data — nothing inferred.

## What you can do

- **Search by AS_PATH** — type a sequence of ASNs and find every prefix whose path
  contains that **consecutive** run. Supports wildcards (`*` any gap, `?` one hop)
  and exclusion (`!N` = path must *not* contain ASN N). Works globally or scoped to a
  country.
- **Search by origin AS** — exact lookup of everything a given network originates.
- **IP / CIDR lookup** — enter an IPv4 **or IPv6** address or prefix (e.g.
  `2001:db8::/32`) and get every covering and more-specific prefix in the table, most-specific first.
- **Per-prefix insight** — open any prefix for a **route graph** (origin → upstreams
  → Tier-1) drawn from all observed paths, the **best path** highlighted, and its
  **parent / child prefixes** found live by numeric range.
- **Browse by country & city** — prefixes (v4 and v6) are resolved against geo
  databases and grouped into the regions they cover, **city level worldwide**. Hovering
  an ASN shows its organization name.
- **Bilingual (中文 / English)** UI, pre-rendered per-country landing pages, a
  sitemap, and `?lang` / `?cc` / `?city` deep links.
- **Smart search box** — one field auto-detects IP / CIDR / ASN / network-name input.

## Static & reproducible

The dataset is exported to **Parquet** and queried in-browser with **DuckDB-WASM**,
directly against the static files. There is no query server.

How a query stays cheap: `meta.json` carries compact **interval indexes** (by
country, by origin ASN, by prefix id), so the browser loads only the **few Parquet
shards a query actually needs** rather than the whole dataset. A country or origin-AS
lookup typically pulls a few MB out of the ~2 GB dataset; a prefix's detail view
reads one path shard. Pruning is at the **shard** level — DuckDB-WASM fetches each
needed shard in full (the files are sized small enough that whole-file downloads beat
many small range requests). The one heavy case is an **AS_PATH search with no origin
filter**, which has nothing to prune on and scans all path shards.

That design buys:

- **Serverless & cheap** — deploys to any static host; no compute, no per-query cost.
- **Reproducible** — data comes from public sources (RIPE RIS + RouteViews MRT dumps);
  anyone can re-run the pipeline and rebuild the same site.
- **Self-hostable & mirrorable** — it's just files, so you can clone it for archival,
  offline use, or running your own snapshot.

## How it's built

```
4 collectors (RIS + RouteViews) ─ingest─► DuckDB working store (full v4+v6 table,
   MRT RIBs                        │       distinct paths deduped & merged across collectors)
                                   └─export-parquet──► Parquet shards + meta.json
                                                        (geo/<cc>{,_v6}, prefixes{,_v6},
                                                         paths{,_v6}, pathsearch{,_v6},
                                                         byorigin{,_v6}, origin_counts) + SSG
                                                          │
                                          DuckDB-WASM (browser) ──fetch needed shards──► you
```

- **Collector** — a streaming MRT parser ingests the latest RIBs from **4 collectors**
  (RIPE RIS `rrc01` London + `rrc06` Tokyo + `rrc03` Amsterdam AMS-IX, and RouteViews
  `route-views2` Oregon; the layout is chosen automatically by collector name) and stores
  every IPv4 **and IPv6** prefix with its distinct AS_PATHs. Nothing is filtered out at
  ingest. **AS prepends are preserved** (dedup key is the raw path), so inbound traffic
  engineering stays visible; paths are deduped and merged across collectors (peer counts summed).
- **Export** — the DuckDB store is exported to a Parquet dataset (a separate set of
  shards per address family), each table sorted by its access key (prefixes by
  `ip_start`, paths by prefix id, pathsearch / `byorigin` by origin ASN) and split into
  small shards, with interval indexes in `meta.json` so the frontend fetches only the
  relevant shards. ASN lookups read a lean `byorigin` dataset (pathsearch minus the
  heavy path-blob column) plus a pre-aggregated `origin_counts` table for O(1) counts.
  A static-site generator emits per-country pages.
- **Frontend** — a Vite + Svelte 5 app running DuckDB-WASM against the Parquet files.
  IPv6 addresses are 128-bit (`UHUGEINT`); range comparisons run in SQL so the browser
  never loses precision.

**Scale** (per daily 4-collector snapshot): **~1.13 M** IPv4 + **~0.26 M** IPv6
prefixes, **~96 M** distinct AS_PATHs (prepends preserved), ~1.8 M path segments,
250 countries — exported to **~2 GB** Parquet.

### Geolocation: three-way merge

Three geo sources are merged into one **non-overlapping** interval set so every prefix
resolves cleanly, while the project stays fully open where possible:

- **`ipdb`** — a city-level commercial database (private, **not** redistributable) used
  by the hosted deployment for **mainland-China** cities (most accurate there).
- **GeoLite2** — MaxMind's free City DB covers **everywhere else at city level** (v4 and
  v6), and its ASN DB provides per-ASN **organization** names. Auto-downloaded and
  refreshed when a new release appears.
- **`rir`** — RIR delegated-extended stats as an openly-redistributable country-level
  fallback for anyone rebuilding without the commercial DB.

## Limitations (worth knowing)

- AS_PATHs are the *outbound* view of whichever peers the 4 collectors have; a given
  network's true vantage is only as complete as those collectors. "Path contains ASN X"
  is the most robust filter (peer-independent); strict ordering depends on the
  collectors' view. IXP route servers are AS-path transparent, so peering across an IXP
  fabric is not directly visible in the path.
- Parent / child segments are computed over **collected** prefixes — a large slice of
  the table, not a private global RIB — so coverage can be partial (the UI says so).
- City-level geolocation is only as good as the underlying geo database.
- An AS_PATH search without an origin filter scans every path shard (~hundreds of MB
  downloaded); scope it by country or origin AS when you can.
- This is a research / education tool over a public, approximate snapshot. It can be
  stale and is **not authoritative for operational decisions**.

## Deploy your own

> 💡 **Fast path — let your agent do it.** This repo is maintained end-to-end by an AI
> coding agent, and **[`AGENTS.md`](AGENTS.md)** is the authoritative, always-current
> runbook (exact build steps, Cloudflare Pages / R2 specifics, gotchas, invariants).
> Open the repo in a coding agent (e.g. Claude Code) and ask it to *"deploy following
> AGENTS.md"* — it will build and push for you. The steps below are the same process
> by hand.

The pipeline is a self-contained CLI (`ipc`).

**1. Build the dataset and site**

```bash
pip install -r requirements.txt              # Python deps (DuckDB, maxminddb, MRT parser, …)
./ipc geo-import                             # build geo: GeoLite (auto-downloaded, city worldwide) [+ ipdb if present]
./ipc ingest --reset                         # download & parse latest RIBs from 4 collectors, full v4+v6 → DuckDB store
( cd ipcollect/web && npm ci && npm run build )   # build the Svelte frontend
./ipc export-parquet --out dist              # DuckDB → Parquet(v4+v6) + meta.json + bilingual SSG, into dist/
```
(`ingest` also auto-checks GeoLite freshness and rebuilds geo when it changes, so the
explicit `geo-import` is only needed for the very first run or a forced refresh.)

`dist/` is now a complete static site (frontend + `dist/data/` Parquet + per-country
SEO pages).

**2a. Host it anywhere (simplest)**

```bash
./ipc serve --port 8812                      # local preview of the same artifact
```

Upload `dist/` to any static host (Cloudflare Pages, Netlify, S3, nginx…). Data is
served same-origin from `dist/data/`. That's it.

**2b. Geo acceleration via a mirror (what peer.as runs)**

Data is served **same-origin** — there's no object-storage split (the in-browser
DuckDB downloads whole shards, never HTTP Range, so an external data host like R2 adds
egress cost/abuse risk for no transfer benefit). For users far from Cloudflare's edge
(e.g. mainland China), the hosted site runs a **second complete copy** of the site on a
well-connected VPS (`cn.peer.as`) and uses **GeoDNS** so `peer.as` resolves to that VPS
within the region. The frontend's `configure()` picks the data source by hostname/geo
with health-checked fallback:

- on the mirror's hostname → same-origin (relative) data + self-hosted DuckDB-WASM;
- on Cloudflare Pages but detected in-region (GeoDNS missed) → switch data to the mirror
  (fallback to same-origin Pages + jsDelivr wasm);
- otherwise → same-origin.

So both domains are standalone full sites with identical layout. Details + the GeoDNS /
TLS-cert caveats are in **[`AGENTS.md`](AGENTS.md)**.

**3. Keep it fresh (optional)**

`scripts/daily-refresh.sh` chains ingest → export → rsync the full site to the mirror →
`wrangler pages deploy`; run it from cron (the hosted site refreshes every 8 hours, tracking the
RIPE RIS bview publish cadence). Details in `AGENTS.md`.

Configuration lives in `config.json` (gitignored; template in `config.example.json`).
Secrets — Cloudflare credentials, the private geo path, `VITE_DATA_BASE`, `R2_BUCKET`
— go in `.env` (template `.env.example`) and are never committed.

## Sponsors

Servers and infrastructure for the hosted **[peer.as](https://peer.as)** deployment
are generously **sponsored by [DMIT](https://www.dmit.io)**.

[![DMIT](ipcollect/web/public/dmit.svg)](https://www.dmit.io)

## Project notes

- **Data source:** [RIPE RIS](https://ris.ripe.net/) (`rrc01`/`rrc06`/`rrc03`) + [RouteViews](https://www.routeviews.org/) (`route-views2`) public MRT RIB dumps.
- **Changelog:** user-facing changes in **[`CHANGELOG.md`](CHANGELOG.md)** (also in-app).
- **Maintenance & deployment:** **[`AGENTS.md`](AGENTS.md)** is the authoritative
  runbook; the DuckDB + IPv6 design/contract is in **`docs/DUCKDB_V6_REFACTOR.md`**.
- For BGP research and education only.
