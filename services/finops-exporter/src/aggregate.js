/**
 * Totals, and the rules about what may never be added together (spec 089, FR-011…FR-014).
 *
 * The exporter does NOT emit a total metric. Totals are computed in the dashboard, from the raw
 * series, so a partial total can name exactly which source is missing — a pre-computed total is a
 * number with the missingness already baked out of it, and no panel downstream can recover what was
 * dropped (FR-011).
 *
 * What this module produces is the /v1/finops/summary payload: the same arithmetic, for humans and
 * for tests, with the completeness verdict attached to every figure.
 */
import { READ, NOT_CONFIGURED, UNREADABLE } from './reading.js'

/**
 * Aggregate readings into per-unit subtotals, per kind.
 *
 * FOUR RULES, each of which has a way to be silently wrong:
 *
 *   1. NEVER SUM ACROSS UNITS. USDC and POL are not the same number. Subtotals are per-unit; a USD
 *      roll-up happens only where a rate is available and is labelled as converted (FR-013).
 *   2. `revenue_accrued` IS NOT REVENUE RECEIVED and is excluded from the revenue total. Adding them
 *      double-counts every fee that has since been withdrawn.
 *   3. `revenue_waived` IS NOT REVENUE. It is revenue we did not earn.
 *   4. A TOTAL MISSING A SOURCE IS PARTIAL and names what it is missing. Never silently understated.
 */
export function aggregate(readings, { rateFor = () => null } = {}) {
  const byKind = { revenue: {}, cost: {}, usage: {} }
  const missing = { revenue: [], cost: [], usage: [] }
  const notConfigured = { revenue: [], cost: [], usage: [] }

  for (const { source, reading } of readings) {
    // Planned and retired sources contribute to nothing (FR-014, invariant 4).
    if (source.status !== 'live') continue

    if (reading.state === UNREADABLE) {
      missing[source.kind].push(source.id)
      continue
    }
    if (reading.state === NOT_CONFIGURED) {
      notConfigured[source.kind].push(source.id)
      continue
    }
    if (reading.state !== READ) continue

    // Usage never joins a money total: a request count summed into a dollar figure would be a
    // category error wearing a currency label (spec 106/#1447). Its per-series values flow through
    // the vendor_usage family; only its three-state health is tracked above.
    if (source.kind === 'usage') continue

    // Rules 2 and 3: only `revenue_total` is revenue.
    if (source.kind === 'revenue' && source.metric !== 'fairwins_finops_revenue_total') continue

    const unit = reading.unit ?? source.unit
    byKind[source.kind][unit] = (byKind[source.kind][unit] ?? 0) + reading.value
  }

  return {
    revenue: summarize(byKind.revenue, missing.revenue, notConfigured.revenue, rateFor),
    cost: summarize(byKind.cost, missing.cost, notConfigured.cost, rateFor),
  }
}

function summarize(byUnit, missing, notConfigured, rateFor) {
  // A USD roll-up exists only if EVERY contributing unit has a rate. One unconvertible unit makes
  // the roll-up an understatement, and an understated total that looks complete is the exact failure
  // FR-011 is about.
  const units = Object.keys(byUnit)
  const rates = Object.fromEntries(units.map((u) => [u, rateFor(u)]))
  const unconvertible = units.filter((u) => rates[u] == null)

  const usd = unconvertible.length
    ? null
    : units.reduce((sum, u) => sum + byUnit[u] * rates[u], 0)

  return {
    byUnit,
    usd,
    /** Why there is no USD figure, when there is none. */
    usdUnavailableBecause: unconvertible.length ? `no rate for ${unconvertible.join(', ')}` : null,
    /**
     * `partial` means a LIVE source could not be read. It is deliberately not raised by
     * `not-configured` sources: those are not missing data, they are unwired features (FR-006).
     */
    partial: missing.length > 0,
    missingSources: missing,
    notConfiguredSources: notConfigured,
  }
}

/**
 * A KPI that refuses to exist when an input does not (FR-012).
 *
 * A cost-per-op of 0 because the op count failed to load is not an estimate. It is a fabricated
 * number, and it reads as excellent news.
 */
export function ratio(numerator, denominator) {
  if (numerator?.state !== READ || denominator?.state !== READ) return null
  if (denominator.value === 0) return null
  return numerator.value / denominator.value
}
