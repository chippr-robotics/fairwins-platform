/**
 * Gateway usage collector (spec 106/#1447) — WHO is spending the platform-held credentials.
 *
 * Scrapes the relay-gateway's counters endpoint (an UNPUBLISHED compose-network port — reachable
 * from this exporter, invisible from outside the VM) and emits per-tier and per-upstream request
 * counts as `vendor_usage` series. This is the series that says where the QuickNode account's
 * 50 req/s went, and which assurance tier the collectible/prediction-market keys are being spent
 * for.
 *
 * ── WHY IN-PROCESS COUNTERS ARE ADMISSIBLE HERE, WHEN THE CATALOGUE REJECTS THEM FOR REVENUE ─
 *
 * `sources.js` refuses gateway counters as a REVENUE source, and its reasoning stands: a counter
 * that resets on restart yields an UNDERCOUNT that still looks like a number, and a revenue level
 * is a level. These are COUNTERS consumed as rates: cumulative-since-boot, scraped into the
 * metrics pipeline (whose WAL is the persistence), and `rate()` treats a reset exactly the way it
 * treats every process restart in every Prometheus deployment — a moment of zero slope, never a
 * negative, never a phantom level. The failure mode the catalogue rule exists for cannot occur in
 * this shape, which is why the FR-033 amendment says the collector persists what it scrapes
 * rather than pretending the gateway can.
 *
 * ── HONESTY ──────────────────────────────────────────────────────────────────────────────────
 *
 * Unreachable is `unreadable`, never zero — a gateway that cannot be scraped is not a gateway
 * serving no traffic. Unset URL is `not-configured`. An unrecognised response shape is an ERROR:
 * a zero parsed out of the wrong shape would report "no consumption" for a gateway that is
 * definitely consuming.
 */
import { read, notConfigured, unreadable } from '../reading.js'

export function createGatewayUsageCollector({ config, fetchImpl = fetch }) {
  /** @type {{tierRequests: Record<string, number>, upstreamCalls: Record<string, number>}|null} */
  let last = null

  async function collectGatewayUsage() {
    const url = config.gateway?.metricsUrl
    if (!url) return notConfigured('FINOPS_GATEWAY_METRICS_URL is not set')

    let body
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
      if (!res.ok) return unreadable(`gateway counters HTTP ${res.status}`)
      body = await res.json()
    } catch (err) {
      return unreadable(err?.message ?? err)
    }

    const tiers = body?.tierRequests
    const upstreams = body?.upstreamCalls
    if (!tiers || typeof tiers !== 'object' || !upstreams || typeof upstreams !== 'object') {
      return unreadable(`gateway counters response had no recognisable shape (keys: ${Object.keys(body ?? {}).join(',')})`)
    }

    // `sponsoredOps` is OPTIONAL and its absence is meaningful: a gateway with no sponsorship
    // counter wired reports nothing rather than an empty object, so "not configured" never renders
    // as "configured and granting nothing" (#1539).
    const sponsored = body?.sponsoredOps
    last = {
      tierRequests: tiers,
      upstreamCalls: upstreams,
      sponsoredOps: sponsored && typeof sponsored === 'object' ? sponsored : null,
    }
    const total = Object.values(tiers).reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0)
    return read(total, 'requests')
  }

  collectGatewayUsage._last = () => last

  return collectGatewayUsage
}

/**
 * The per-series detail: one `vendor_usage` sample per tier and per upstream. Labels are BOUNDED
 * BY CONSTRUCTION on the gateway side (tiers from the fixed ladder, upstreams from the route
 * table) — and re-bounded here, because a collector must not trust a scrape target to keep a
 * cardinality promise on its behalf.
 */
const TIER_LABELS = new Set(['anonymous', 'human', 'address', 'member'])
const UPSTREAM_LABEL_RE = /^[a-z]{2,24}$/

export function emitGatewayUsage(registry, collector, source) {
  const last = collector._last?.()
  if (!last) return
  for (const [tier, count] of Object.entries(last.tierRequests)) {
    if (!TIER_LABELS.has(tier) || !Number.isFinite(count)) continue
    registry.emit(
      'vendor_usage',
      'counter',
      'Cumulative gateway requests since boot, by resolved assurance tier. Consume with rate().',
      { source: source.id, metric: 'tier_requests', tier },
      count,
    )
  }
  // Sponsored UserOps granted, per chain — the DEMAND signal that makes
  // `executor_nonce_stale_seconds` interpretable (#1539). Staleness alone is not a fault: an idle
  // bundler is healthy. Staleness WHILE this counter is advancing is the 2026-07-12 stall.
  for (const [chain, count] of Object.entries(last.sponsoredOps ?? {})) {
    // Bounded: chain ids are numeric strings from the gateway's own configured set, never request
    // content. Anything else is dropped rather than growing the label space (FR-036).
    if (!/^[0-9]+$/.test(chain) || !Number.isFinite(count)) continue
    registry.emit(
      'sponsored_ops_total',
      'counter',
      'Sponsored UserOps GRANTED since gateway boot, per chain. The demand signal to pair with executor nonce staleness — a refused request is not demand. Consume with rate().',
      { chain },
      count,
    )
  }

  for (const [upstream, count] of Object.entries(last.upstreamCalls)) {
    if (!UPSTREAM_LABEL_RE.test(upstream) || !Number.isFinite(count)) continue
    registry.emit(
      'vendor_usage',
      'counter',
      'Cumulative outbound calls since boot, per platform-credentialed upstream. Consume with rate().',
      { source: source.id, metric: 'upstream_calls', upstream },
      count,
    )
  }
}
