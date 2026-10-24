/**
 * Catalogue schema + validation (spec 089, FR-002).
 *
 * Dependency-free on purpose: this module is imported by the exporter (Node ESM), the dashboard
 * generator and the CI gate, and adding a validation library would make the gate's own dependency
 * tree a thing that can break the gate.
 *
 * The enumerations here are the SAME bounded label sets declared in
 * `specs/089-finops-dashboard/contracts/metrics.md`. They exist in code so `check:finops` can reject
 * an unbounded label rather than trusting prose — cardinality is what decides whether this system
 * costs $0 or outgrows the thing it measures (research R9).
 */

/** Metric label enumerations. Adding a value is cheap; adding a LABEL needs a cardinality argument. */
export const UNITS = ['USDC', 'USD', 'POL', 'ETH', 'ETC']
// 'usage' (spec 106/#1447): a MEASURED consumption fact with no dollar of its own — the gateway's
// per-tier / per-upstream call counts that contextualise the vendor bills beside it. It exists as
// a kind because the alternative was an emitted `source` label with no catalogue entry, which
// breaks the bounded-label promise and is invisible to every coverage gate. A usage source never
// joins a money total and never carries a basis: basis exists to say whether a DOLLAR figure is an
// invoice or our arithmetic, and a request count is neither.
export const KINDS = ['revenue', 'cost', 'usage']
export const STATUSES = ['live', 'planned', 'retired']

/**
 * `billed` came from a billing record; `modelled` was computed by us from usage times a rate we
 * typed into a config file. Research R1: Cloudflare and QuickNode expose no dollar figure at all on
 * our plan, so collapsing these two into one number would present our own arithmetic as an invoice.
 * Mandatory on every cost source for exactly that reason.
 */
export const BASES = ['billed', 'modelled']

/** Chains that may appear in a `chain` label. Cohort filtering happens at runtime (FR-008). */
export const CHAIN_IDS = [1, 10, 61, 63, 137, 8453, 42161]

/** The metric families the exporter is allowed to emit. Mirrors contracts/metrics.md. */
export const METRIC_FAMILIES = [
  'fairwins_finops_revenue_total',
  'fairwins_finops_revenue_accrued',
  'fairwins_finops_revenue_waived_total',
  'fairwins_finops_cost_usd_total',
  'fairwins_finops_vendor_usage',
  'fairwins_finops_pool_balance',
  'fairwins_finops_pool_burn_rate',
  'fairwins_finops_pool_runway_seconds',
  // Executor nonce diagnostics (#1539). NOT a value a source declares — these are side series about
  // an existing pool, emitted beside its balance, and listed here so the allowed-family set stays
  // the whole truth about what the exporter publishes.
  'fairwins_finops_executor_nonce',
  'fairwins_finops_executor_nonce_pending_gap',
  'fairwins_finops_executor_nonce_stale_seconds',
  'fairwins_finops_executor_nonce_observed_seconds',
  'fairwins_finops_sponsored_ops_total',
  'fairwins_finops_relayed_intents_total',
]

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Validate one entry. Returns an array of human-readable problems — empty means valid.
 *
 * Every message names the field AND the file to edit, because a gate that fails without saying how
 * to satisfy it is a gate somebody disables (FR-023).
 */
export function validateSource(src, index) {
  const problems = []
  const where = `sources.js[${index}]${src?.id ? ` (id: ${src.id})` : ''}`
  const bad = (msg) => problems.push(`${where}: ${msg}`)

  if (!src || typeof src !== 'object') return [`${where}: entry is not an object`]

  if (typeof src.id !== 'string' || !ID_RE.test(src.id)) {
    bad(`'id' must be kebab-case ([a-z0-9-]). It becomes the \`source\` metric label, so renaming one ORPHANS its history — retire the old id and add a new entry instead.`)
  }
  if (!KINDS.includes(src.kind)) bad(`'kind' must be one of ${KINDS.join(' | ')}`)
  if (!STATUSES.includes(src.status)) bad(`'status' must be one of ${STATUSES.join(' | ')}`)
  if (typeof src.label !== 'string' || !src.label.trim()) bad(`'label' is required (it is the panel title)`)
  if (typeof src.meaning !== 'string' || src.meaning.trim().length < 20) {
    bad(`'meaning' must say what this number IS, and where it matters, what it is NOT. A panel whose number nobody can define is a panel nobody can act on.`)
  }
  if (typeof src.docs !== 'string' || !src.docs.trim()) {
    bad(`'docs' is required: every alert must point at the runbook section that resolves it (FR-018)`)
  }
  if (!Number.isFinite(src.interval) || src.interval <= 0) {
    bad(`'interval' (seconds) is required and must be positive`)
  }
  if (typeof src.collector !== 'string' || !src.collector.trim()) bad(`'collector' is required`)

  // A planned source has nothing to emit yet — that is the point (FR-014). A live or retired one must.
  if (src.status === 'planned') {
    if (src.metric != null) {
      bad(`a 'planned' source MUST NOT declare a metric: it emits no value at all, so that it cannot contribute a 0 that reads as "shipped and earning nothing" (FR-014)`)
    }
  } else if (!METRIC_FAMILIES.includes(src.metric)) {
    bad(`'metric' must be one of the families in contracts/metrics.md, got ${JSON.stringify(src.metric)}`)
  }

  if (src.unit != null && !UNITS.includes(src.unit)) {
    bad(`'unit' must be one of ${UNITS.join(' | ')} (bounded label enumeration)`)
  }

  if (src.kind === 'cost' && src.status === 'live' && !BASES.includes(src.basis)) {
    bad(`a live cost source MUST declare 'basis' as ${BASES.join(' or ')}. Research R1: presenting a figure we computed ourselves as if it were an invoice is the specific dishonesty this field exists to prevent.`)
  }
  // A `planned` cost may declare a basis and should: it pre-commits, while nobody is under pressure
  // to publish a number, to whether the eventual figure is an invoice or our own arithmetic. What it
  // may never do is declare one that is not a basis at all.
  if (src.basis != null && !BASES.includes(src.basis)) {
    bad(`'basis' must be ${BASES.join(' or ')}, got ${JSON.stringify(src.basis)}`)
  }
  if (src.kind === 'revenue' && src.basis != null) {
    bad(`'basis' is a cost-source field only`)
  }
  if (src.kind === 'usage') {
    if (src.basis != null) {
      bad(`'basis' is a cost-source field only: a usage count is a measured fact, not a modelled or billed dollar`)
    }
    if (src.status !== 'planned' && src.metric !== 'fairwins_finops_vendor_usage') {
      bad(`a live usage source must emit the 'fairwins_finops_vendor_usage' family — usage never rides a money metric`)
    }
    if (src.unit != null) {
      bad(`'unit' is a currency enumeration and a usage source has no currency — omit it`)
    }
  }

  // The gate's join key back to the platform (FR-019). See moneyPath's comment in sources.js.
  if (src.moneyPath != null) {
    const mp = src.moneyPath
    if (typeof mp !== 'object' || Array.isArray(mp)) bad(`'moneyPath' must be an object`)
    else {
      if (typeof mp.namespace !== 'string' || !ID_RE.test(mp.namespace)) {
        bad(`'moneyPath.namespace' must be kebab-case: it is derived from an env-var prefix by the coverage gate (X402_PAY_TO => 'x402'), and a mismatch means the gate cannot join this entry to the code that earns it.`)
      }
      for (const field of ['payeeEnv', 'enableEnv']) {
        if (mp[field] != null && !/^[A-Z][A-Z0-9_]*$/.test(mp[field])) {
          bad(`'moneyPath.${field}' must be an ENVIRONMENT VARIABLE NAME (upper snake case), never a value`)
        }
      }
    }
  }

  if (src.chains != null) {
    if (!Array.isArray(src.chains) || src.chains.length === 0) bad(`'chains' must be a non-empty array when present`)
    else for (const c of src.chains) {
      if (!CHAIN_IDS.includes(c)) bad(`chain ${c} is not in the declared enumeration [${CHAIN_IDS.join(', ')}]`)
    }
  }

  // The catalogue is world-readable in the repo. It names a secret; it never carries one (FR-003).
  if (src.credential != null && typeof src.credential !== 'string') {
    bad(`'credential' must be the NAME of a Secret Manager secret, never a value`)
  }
  if (typeof src.credential === 'string' && /[=:]|^[A-Za-z0-9+/]{24,}={0,2}$/.test(src.credential)) {
    bad(`'credential' looks like it contains a value. It must be a secret NAME only (FR-003/FR-024).`)
  }

  return problems
}

/** Validate the whole catalogue, including cross-entry rules. */
export function validateCatalogue(sources) {
  const problems = sources.flatMap((s, i) => validateSource(s, i))

  const seen = new Map()
  for (const [i, s] of sources.entries()) {
    if (!s?.id) continue
    if (seen.has(s.id)) problems.push(`sources.js[${i}]: duplicate id '${s.id}' (first seen at index ${seen.get(s.id)}). Ids are metric label values and must be unique.`)
    else seen.set(s.id, i)
  }

  return problems
}
