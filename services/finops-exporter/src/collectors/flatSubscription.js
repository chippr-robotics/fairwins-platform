/**
 * The flat-subscription modeller (spec 089, FR-005).
 *
 * For vendors where the DECLARED SUBSCRIPTION IS THE ENTIRE MODEL: there is no billing API, no
 * usage API, and often no credential at all. The dollar figure is `basis="modelled"` arithmetic
 * over a rate an operator typed into config, and saying so is the whole contract.
 *
 * WHY THIS IS ITS OWN FILE. It used to live inside `collectors/quicknode.js`, because Grafana Cloud
 * was the only other source that needed it. Two more arrived (Alphaday with spec 109, The Graph
 * here), and at four sources a module named for one vendor stops being a harmless convenience and
 * starts being a false statement about what a source reads: `alphaday-news-api` was reporting
 * `not-configured` citing `QUICKNODE_API_KEY` — a credential for a vendor it has never spoken to —
 * because a missing `flatSubscriptions` key fell through to QuickNode's credit path. That is what a
 * misleading name buys eventually.
 *
 * THE DEFAULT IS `null`, NOT `0`, and the distinction is the point. "The operator confirmed we are
 * on the free tier" and "nobody ever set this" are different facts, and a defaulted zero renders as
 * the first while meaning the second. An unset price is `not-configured` — a first-class state that
 * does not alert and does not make a total partial. `0` is available, and is an ASSERTION.
 */
import { read, notConfigured } from '../reading.js'

export function createFlatSubscriptionCollector({ config }) {
  const flat = config.flatSubscriptions ?? {}

  return async function collectFlatSubscription(source) {
    // A source pointed at this collector with no entry in the table is a WIRING mistake, and it is
    // reported as one. The alternative — treating an unknown id as "no price declared" — is exactly
    // the failure this module was extracted to end: it reads as an operator oversight, so nobody
    // looks at the code, and the source stays silently dead.
    if (!(source.id in flat)) {
      return notConfigured(
        `'${source.id}' uses the flat-subscription collector but has no entry in config.flatSubscriptions — ` +
          `add one in services/finops-exporter/src/config/index.js (this is a wiring bug, not a missing price)`,
      )
    }

    const declared = flat[source.id]
    if (declared == null) {
      return notConfigured(
        `no plan price declared for '${source.id}' — set its FINOPS_*_PLAN_USD (0 asserts a free tier)`,
      )
    }
    return read(declared, 'USD', { labels: { basis: 'modelled' } })
  }
}
