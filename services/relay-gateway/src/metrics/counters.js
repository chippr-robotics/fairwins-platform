/**
 * Identity counters + the counters endpoint (spec 106/#1447, T033).
 *
 * Cumulative-since-boot request counts, per resolved assurance tier — the gateway's half of the
 * FinOps `gateway-upstream-usage` source. Served on an UNPUBLISHED compose-network port that the
 * exporter scrapes; the metrics pipeline's WAL is the persistence, and `rate()` treats a restart
 * the way it treats every Prometheus counter reset. (Why that answers the catalogue's "gateway
 * counters reset" objection is written where the exception lives:
 * services/finops-exporter/src/collectors/gateway.js.)
 *
 * ── LABELS ARE BOUNDED BY CONSTRUCTION (FR-036) ──────────────────────────────────────────────
 *
 * The tier map is pre-seeded from the fixed ladder and NOTHING else can enter it — an unknown
 * value is dropped, not added, so a bug upstream cannot turn series count into a function of
 * request content. Upstream labels come from the route table the same way (see upstreamCeiling's
 * cumulative map, which this endpoint serves alongside).
 *
 * ── WHAT THIS ENDPOINT IS NOT ────────────────────────────────────────────────────────────────
 *
 * Not the operator disclosure (that is the gated /status block), not a Prometheus exposition (the
 * exporter owns metric shape), and not reachable from outside the VM: the port is never published
 * by the compose file, and there is nothing here worth stealing anyway — counts with bounded
 * labels, no addresses, no credentials, no per-member anything.
 */
import http from 'node:http'
import { OBSERVABLE_TIERS } from '../identity/tiers.js'

export function createIdentityCounters() {
  /** Pre-seeded and CLOSED: the ladder is the whole label set. */
  const tierRequests = Object.fromEntries(OBSERVABLE_TIERS.map((t) => [t, 0]))
  return {
    hitTier(tier) {
      // An unknown tier is dropped, never added — bounded means bounded.
      if (Object.prototype.hasOwnProperty.call(tierRequests, tier)) tierRequests[tier] += 1
    },
    snapshot() {
      return { ...tierRequests }
    },
  }
}

/**
 * Sponsored UserOps granted, per chain (#1539) — the DEMAND signal.
 *
 * It exists to make a different metric interpretable. `executor_nonce_stale_seconds` cannot be
 * alerted on alone: an idle bundler has a frozen nonce and is perfectly healthy, so a rule that
 * pages on staleness pages every quiet night, and an alarm that cries wolf is exactly how the
 * 2026-07-12 stall survived 40 minutes with members as the only alarm. Staleness WHILE SPONSORSHIP
 * WAS GRANTED is the stall; the same staleness with no grants is a Tuesday.
 *
 * Counted at the moment sponsorship is GRANTED, not requested — a refused request is not demand the
 * executor was supposed to serve.
 *
 * Labels are bounded by the configured chain set (FR-036); an unconfigured chain is dropped rather
 * than growing the label space, because a chain id that reaches here from request content is
 * exactly the cardinality failure that rule prevents.
 */
export function createSponsorshipCounters(chainIds = []) {
  const granted = Object.fromEntries(chainIds.map((id) => [String(id), 0]))
  return {
    grant(chainId) {
      const key = String(chainId)
      if (Object.prototype.hasOwnProperty.call(granted, key)) granted[key] += 1
    },
    snapshot() {
      return { ...granted }
    },
  }
}

/**
 * Serve `{ tierRequests, upstreamCalls, sinceMs }` as JSON on `port`. Returns the server (tests
 * close it); never throws the boot — a metrics listener that cannot bind logs and stands down,
 * because observability must not take down the thing it observes.
 */
export function startCountersServer({ port, counters, upstreamCeilings, sponsorship = null, log = console.warn, now = () => Date.now() }) {
  const since = now()
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        tierRequests: counters.snapshot(),
        upstreamCalls: upstreamCeilings?.cumulative?.() ?? {},
        // Absent when no sponsorship counter was wired — the exporter reads that as "not
        // configured", which is honest, where a `{}` would read as "wired up and nothing granted".
        ...(sponsorship ? { sponsoredOps: sponsorship.snapshot() } : {}),
        sinceMs: since,
      })
    )
  })
  server.on('error', (err) => {
    log(`[relay-gateway] counters endpoint failed on :${port} (${err.code || 'error'}) — usage export degrades to unreadable at the exporter, nothing else is affected`)
  })
  server.listen(port)
  return server
}
