// NextTrace traceMap JSON loader.
//
// traceMap stores a generated JSON next to each HTML map:
//   https://assets.nxtrace.org/tracemap/<id>.json
// The JSON is already shaped for peer.as: { target, probes:[{hops:[]}] }.
// This module only validates ids and fills UI-only fields used by RouteTraceView.

import { traceAsName } from './trace-overrides.js'

const BASE = 'https://assets.nxtrace.org/tracemap/'
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const PALETTE = [
  [45, 212, 191], [56, 189, 248], [251, 191, 36], [167, 139, 250],
]
const hex = ([r, g, b]) => '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')

function cleanId(id) {
  const s = String(id || '').trim()
  if (!ID_RE.test(s)) throw new Error('bad trace id')
  return s
}

function normalizeHop(h, fallbackIdx) {
  return {
    idx: Number.isFinite(Number(h?.idx)) ? Number(h.idx) : fallbackIdx,
    ip: h?.ip || null,
    rdns: h?.rdns || '',
    asn: Number.isFinite(Number(h?.asn)) ? Number(h.asn) : 0,
    name: traceAsName(h?.ip, h?.name),
    cc: h?.cc || '',
    city: h?.city || '',
    lat: h?.lat ?? null,
    lon: h?.lon ?? null,
    rtt: h?.rtt == null ? null : Number(h.rtt),
    loss: Math.round(Number(h?.loss) || 0),
    isTarget: !!h?.isTarget,
  }
}

function normalizeProbe(p, i) {
  const color = PALETTE[i % PALETTE.length]
  const hops = (Array.isArray(p?.hops) ? p.hops : []).map((h, j) => normalizeHop(h, j + 1))
  if (hops.length && !hops.some(h => h.isTarget)) hops[hops.length - 1].isTarget = true
  const rounds = hops.length && hops[hops.length - 1].rtt != null ? [hops[hops.length - 1].rtt] : []
  return {
    id: p?.id || 'ntrace-' + i,
    color,
    colorHex: hex(color),
    city: p?.city || 'NextTrace',
    cc: p?.cc || '',
    country: p?.country || '',
    network: p?.network || 'NextTrace',
    asn: Number.isFinite(Number(p?.asn)) ? Number(p.asn) : 0,
    lat: p?.lat ?? (hops[0]?.lat ?? 0),
    lon: p?.lon ?? (hops[0]?.lon ?? 0),
    status: p?.status || 'done',
    hops,
    rounds,
    raw: '',
    stats: null,
  }
}

function normalizeModel(d, id) {
  if (!d || d.schema !== 'peeras.trace.v1') throw new Error('unsupported trace schema')
  const probes = (Array.isArray(d.probes) ? d.probes : []).map(normalizeProbe)
  return {
    id: d.id || id,
    htmlUrl: d.html_url || '',
    generatedAt: d.generated_at || '',
    type: 'traceroute',
    target: {
      ip: d.target?.ip || '',
      label: d.target?.label || d.target?.ip || '',
      lat: d.target?.lat ?? 0,
      lon: d.target?.lon ?? 0,
      cc: d.target?.cc || '',
      city: d.target?.city || '',
      loc: d.target?.loc || d.target?.city || d.target?.cc || '',
    },
    probes,
  }
}

export async function loadNTraceMap(id, signal = null) {
  const traceId = cleanId(id)
  const r = await fetch(BASE + encodeURIComponent(traceId) + '.json', { headers: { Accept: 'application/json' }, signal })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return normalizeModel(await r.json(), traceId)
}
