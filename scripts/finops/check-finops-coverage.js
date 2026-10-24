#!/usr/bin/env node
/**
 * The FinOps coverage gate (spec 089, FR-019…FR-023).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  THIS IS THE FEATURE'S LOAD-BEARING PIECE.
 *
 *  The brief said: "Any time a new cost or revenue source is added to the platform we MUST update
 *  the dashboard." Every comparable invariant in this repository that survived was made a CI gate —
 *  check:storage-layout, check:iac, check:deps, TypehashParity. A prose rule asking future authors
 *  to remember the dashboard would be the one rule with no enforcement, and it would be broken
 *  within two specs.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Five checks. A new fee service fails at least three of them.
 *
 *   C1  catalogue schema is valid                          (FR-002)
 *   C2  every money path in the platform has an entry       (FR-019)
 *         C2a  on-chain FeeRouter services
 *         C2b  configured platform payees in the relay gateway
 *   C3  every catalogued metric is one a collector emits    (FR-021)
 *   C4  every catalogued source has a dashboard panel       (FR-020)
 *   C5  committed dashboards match a fresh generation       (regenerate-and-diff)
 *
 * Every failure message names the exact file and the edit that resolves it (FR-023). A gate that
 * fails without saying how to satisfy it is a gate somebody disables.
 *
 * ── WHAT THIS GATE STILL CANNOT SEE ──────────────────────────────────────────────────────────
 *
 * Stated plainly, because a gate whose limits are unwritten gets read as covering everything.
 *
 * DISCOVERY IS ONE-SIDED. C2 finds new REVENUE, because revenue leaves a mechanical trace — a fee
 * service id, or an address we control written into configuration. A new vendor COST leaves none:
 * `fetch(vendor)` is byte-for-byte the same call whether the vendor meters it or serves free public
 * data, and this gateway does both (the perps module proxies three free venue APIs; the assistant
 * calls a metered one). Any heuristic over outbound calls would fire on the free ones, and a gate
 * that is wrong on its first run is a gate somebody adds `continue-on-error` to.
 *
 *   A credential-based rule was considered and rejected: a paid vendor account almost always
 *   arrives as a secret, and `infra/vm/common/fetch-secrets.sh` enumerates every secret the gateway
 *   receives — it would have caught ANTHROPIC_API_KEY. It does not ship because the catalogue's
 *   `credential` values are descriptive names ('quicknode-api-key') while fetch-secrets uses the
 *   Secret Manager ids ('finops-quicknode-key'), so joining them means agreeing on a convention that
 *   nothing enforces. Making those two naming schemes agree is the prerequisite, and it is a
 *   separate change from this one.
 *
 * So the cost side is held by C1's mandatory `basis` and by review, not by discovery. What C2b DOES
 * give the cost side is dormancy honesty: a catalogued-but-`planned` cost cannot be switched on in a
 * committed deployment while still claiming there is nothing to read.
 *
 * Usage: node scripts/finops/check-finops-coverage.js [--json]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { SOURCES, FEE_SERVICE_LABELS, validateCatalogue, METRIC_FAMILIES } from '../../packages/finops-catalogue/src/index.js'
import { discoverMoneyPaths, unclaimedMoneyPaths, staleClaims, dormantPathsSwitchedOn } from './lib/moneyPaths.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const CATALOGUE = 'packages/finops-catalogue/src/sources.js'

const violations = []
const fail = (check, message, fix) => violations.push({ check, message, fix })

const readIfExists = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : null)

/** Every file under `rel` matching `test`, as `{ path (repo-relative), text }`. */
function readTree(rel, test) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // node_modules is not our source. Walking it here would be slow and would let a dependency's
      // fixture answer a question about OUR platform.
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(join(dir, entry.name))
      } else if (test(entry.name)) {
        const p = join(dir, entry.name)
        out.push({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') })
      }
    }
  }
  walk(abs)
  return out
}

// ── C1: schema ───────────────────────────────────────────────────────────────────────────────

for (const problem of validateCatalogue(SOURCES)) {
  fail('C1', problem, `Edit ${CATALOGUE}.`)
}

// ── C2a: on-chain fee services vs the catalogue (FR-019) ─────────────────────────────────────
//
// The fee services are read from TWO independent places and both must agree with the catalogue:
// the frontend's FEE_SERVICES table and the gateway's FEE_SERVICE_IDS. Checking only one would let
// a service that exists in the contracts but in just one client slip through — and the frontend
// table is itself checked against the contracts by the spec-060 suite, so this closes the loop.

/** Extract `keccakId('some.label')` / `ethers.id('some.label')` preimages from a source file. */
function extractServiceLabels(text) {
  if (!text) return []
  const out = new Set()
  for (const m of text.matchAll(/(?:keccakId|ethers\.id|\bid)\(\s*['"]([a-z][a-z0-9.]*\.[a-z0-9.]+)['"]\s*\)/g)) {
    out.add(m[1])
  }
  return [...out]
}

const frontendFees = extractServiceLabels(readIfExists('frontend/src/lib/fees/feeQuote.js'))
const gatewayFees = extractServiceLabels(readIfExists('services/relay-gateway/src/fees/onchain.js'))
const platformFees = new Set([...frontendFees, ...gatewayFees])
const catalogued = new Set(FEE_SERVICE_LABELS)

for (const label of [...platformFees].sort()) {
  if (!catalogued.has(label)) {
    fail(
      'C2a',
      `FeeRouter service '${label}' exists in the platform but has NO catalogue entry, so it earns revenue that appears on no dashboard.`,
      `Add an entry to the FEE_SERVICES array in ${CATALOGUE} with serviceLabel: '${label}', then run \`npm run finops:generate\`.`,
    )
  }
}

// The reverse: a catalogued service the platform no longer has. Its panel would render "No data"
// forever, which on a revenue dashboard is indistinguishable from "no revenue".
for (const label of [...catalogued].sort()) {
  if (platformFees.size && !platformFees.has(label)) {
    fail(
      'C2a',
      `Catalogued fee service '${label}' is not referenced by the frontend fee table or the gateway fee reader. Its panel will show "No data" forever, which reads as "earned nothing".`,
      `Either restore the service in the platform, or set that entry's status to 'retired' in ${CATALOGUE}.`,
    )
  }
}

// ── C2b: configured platform payees vs the catalogue (FR-019) ────────────────────────────────
//
// WHY THIS EXISTS. C2a above is a complete answer for one KIND of revenue and a blind spot for
// every other: its whole discovery surface is `keccakId('x.y')` over two files, so it enumerates
// FeeRouter services and nothing else. The x402 rail (spec 096) takes USDC straight to the platform
// treasury and registers no service id, so it was invisible to this gate BY CONSTRUCTION — the
// catalogue could stay silent about a live revenue stream forever and CI would stay green. A gate
// that cannot see the source is not protection.
//
// So this widens the question from "is every fee service catalogued" to "is every place the
// PLATFORM is named as a recipient of funds catalogued". The signal is a configured payee: the
// gateway holds no key and hardcodes no address, so a recipient we control arrives as an env var.
// See scripts/finops/lib/moneyPaths.js for the detection rules and, importantly, for what is
// deliberately NOT detected and why.

const gatewaySources = readTree('services/relay-gateway/src', (f) => f.endsWith('.js'))
const moneyPaths = discoverMoneyPaths(gatewaySources)

for (const { namespace, evidence } of unclaimedMoneyPaths(moneyPaths, SOURCES)) {
  fail(
    'C2b',
    `The relay gateway configures a platform payee under '${namespace}' (${evidence.join(', ')}), but NO catalogue entry claims it. ` +
      `Money can arrive at an address we control and appear on no dashboard — which is the exact gap that let the x402 rail ship uncatalogued.`,
    `Add a source to ${CATALOGUE} with moneyPath: { namespace: '${namespace}', payeeEnv: '…' }. If it is built but not offered on any ` +
      `deployment, catalogue it as status 'planned' with no metric — it must be NAMED either way, so that switching it on is a gate failure ` +
      `rather than a silent event.`,
  )
}

// The reverse: an entry claiming an env var the gateway no longer reads. Its claim is stale, so the
// path it was watching may have moved somewhere nothing is watching.
for (const source of staleClaims(moneyPaths, SOURCES, gatewaySources)) {
  const payeeEnv = source.moneyPath.payeeEnv
  fail(
    'C2b',
    `Source '${source.id}' claims the payee '${payeeEnv}', which the relay gateway no longer reads. The claim is stale, so whatever replaced it is unwatched.`,
    `Point moneyPath.payeeEnv at the variable that configures the recipient now, or set the entry's status to 'retired' in ${CATALOGUE}.`,
  )
}

// ── C2b (dormancy honesty): a `planned` money path that a deployment has switched on ─────────
//
// `planned` is a claim about the world: there is nothing to read. It is the right answer for a path
// that is built but offered nowhere — reporting $0 would say "offered, and nobody used it". What
// makes it decay is that turning such a path ON is a one-line config change in a deployment file,
// and nothing in this gate used to look at deployment files at all. So the entry would keep saying
// NOT YET LIVE while real money moved, and the dashboard would under-report by exactly that source.
//
// Enabling is therefore where promotion to `live` (with a collector) becomes non-optional. That is
// deliberate: switching on a revenue rail is precisely the moment nobody remembers the dashboard.

const deploymentConfigs = [
  ...readTree('infra/vm', (f) => /\.(ya?ml|env)$/.test(f)),
  ...readTree('services', (f) => /\.ya?ml$/.test(f)).filter(({ path }) => path.includes('/deploy/')),
]

for (const { source, what, hit } of dormantPathsSwitchedOn(SOURCES, deploymentConfigs)) {
  fail(
    'C2b',
    `Source '${source.id}' is catalogued 'planned' — "nothing to read" — but ${what} in ${hit.path}:${hit.line}. ` +
      `The path is being offered, so that claim is no longer true and every total silently omits it.`,
    `Promote '${source.id}' to status 'live' in ${CATALOGUE}: give it a metric, a collector under ` +
      `services/finops-exporter/src/collectors/ that reports read | not-configured | unreadable, then run \`npm run finops:generate\`.`,
  )
}

// ── C3: catalogued metrics vs what the exporter can emit (FR-021) ────────────────────────────
//
// A panel querying a metric no collector emits renders "No data". On a revenue dashboard that is
// indistinguishable from "no revenue", which is precisely the confusion this whole feature exists
// to prevent — so it is a build failure, not a display quirk.

const COLLECTOR_DIR = 'services/finops-exporter/src/collectors'
const collectorFiles = existsSync(join(ROOT, COLLECTOR_DIR)) ? readdirSync(join(ROOT, COLLECTOR_DIR)) : []
const collectorNames = new Set(collectorFiles.map((f) => f.replace(/\.js$/, '')))
collectorNames.add('none') // the sentinel used by `planned` sources

// Every metric family the exporter's registry and collectors can actually produce.
const exporterSources = [
  ...collectorFiles.map((f) => readIfExists(`${COLLECTOR_DIR}/${f}`)),
  readIfExists('services/finops-exporter/src/registry.js'),
  readIfExists('services/finops-exporter/src/server.js'),
].filter(Boolean).join('\n')

// `registry.record` emits `source.metric` verbatim, so any family declared in the schema and
// reachable through record() counts as emitted; families emitted directly appear as string literals.
const emittedDirectly = new Set(
  [...exporterSources.matchAll(/emit\(\s*['"]([a-z_]+)['"]/g)].map((m) => `fairwins_finops_${m[1]}`),
)
const emitsViaRecord = /registry\.record\(|\.record\(source/.test(exporterSources)

for (const source of SOURCES) {
  if (!source.metric) continue // planned sources declare none, by design

  if (!METRIC_FAMILIES.includes(source.metric)) {
    fail(
      'C3',
      `Source '${source.id}' declares metric '${source.metric}', which is not a declared metric family.`,
      `Add it to METRIC_FAMILIES in packages/finops-catalogue/src/schema.js and to specs/089-finops-dashboard/contracts/metrics.md, or fix the typo in ${CATALOGUE}.`,
    )
  }
  if (!emittedDirectly.has(source.metric) && !emitsViaRecord) {
    fail(
      'C3',
      `Source '${source.id}' declares metric '${source.metric}', but no collector emits it. Its panel would render "No data" forever.`,
      `Emit it from ${COLLECTOR_DIR}/${source.collector}.js, or correct the metric in ${CATALOGUE}.`,
    )
  }
  if (!collectorNames.has(source.collector)) {
    fail(
      'C3',
      `Source '${source.id}' names collector '${source.collector}', which does not exist.`,
      `Create ${COLLECTOR_DIR}/${source.collector}.js, or point the entry at an existing collector in ${CATALOGUE}.`,
    )
  }
}

// ── C4: every source has a panel (FR-020) ────────────────────────────────────────────────────

const dashboardDir = join(ROOT, 'infra/grafana/dashboards')
const dashboards = existsSync(dashboardDir)
  ? readdirSync(dashboardDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(dashboardDir, f), 'utf8')))
  : []

/**
 * Collect what each panel actually BINDS to.
 *
 * The dashboards are parsed rather than substring-matched. Raw JSON escapes the quotes inside a
 * PromQL selector (`source=\"gcp\"`), so a naive `text.includes('source="gcp"')` never matches and
 * the gate reports every source as unpanelled — a false failure that would teach everyone to ignore
 * it. Parsing is also what makes "bound by a query" mean the query, not a coincidental substring.
 */
const panelQueries = []
const panelProse = []
for (const dash of dashboards) {
  for (const panel of dash.panels ?? []) {
    for (const target of panel.targets ?? []) {
      if (target.expr) panelQueries.push(target.expr)
    }
    if (panel.title) panelProse.push(panel.title)
    if (panel.options?.content) panelProse.push(panel.options.content)
  }
}

if (!dashboards.length) {
  fail('C4', 'No generated dashboards found in infra/grafana/dashboards/.', 'Run `npm run finops:generate` and commit the result.')
} else {
  for (const source of SOURCES) {
    if (source.status === 'retired') continue
    // A live source is bound by a query naming it; a planned one by its explanatory panel. Both
    // must be present, because "not yet live" is information an operator needs to see.
    const bound = source.status === 'planned'
      ? panelProse.some((t) => t.includes(source.label))
      : panelQueries.some((q) => q.includes(`source="${source.id}"`))
    if (!bound) {
      fail(
        'C4',
        `Source '${source.id}' has a catalogue entry but NO dashboard panel. It would be invisible to operators.`,
        'Run `npm run finops:generate` and commit the result.',
      )
    }
  }
}

// ── C6: an asserted $0 must still describe the tier we actually use ──────────────────────────
//
// A declared plan price is the operator saying "I checked". C1-C4 make sure a source EXISTS; nothing
// makes sure its price is still true, and for most vendors that is fine — a plan changes when
// somebody clicks something on a billing page, which is a human event with a human attached.
//
// The Graph is not like that. Its tier is decided by WHICH ENDPOINT THE APP CALLS.
// `api.studio.thegraph.com` is the free development tier; `gateway.thegraph.com` is the
// decentralized network, where queries are paid in GRT from a billing balance on Arbitrum One. So
// the entire cost basis flips on a one-line edit to `frontend/src/config/networks.js`, made by
// somebody thinking about indexing, in a file that has nothing to do with FinOps — and a $0 that
// was true on Monday is a confidently wrong number on Tuesday, on a dashboard nobody rechecks.
//
// The free allowance also does not bill over, it FAILS. So the wrong figure and a member-facing
// outage arrive together, and the dashboard says everything is free.

const GATEWAY_HOST = 'gateway.thegraph.com'
const networksFile = readIfExists('frontend/src/config/networks.js')
// Reuses C2b's deployment sweep — the same files, for the same reason: a tier assertion lives in a
// committed deployment, and a gate that cannot see deployment files cannot see it change.
const deploymentText = deploymentConfigs.map((c) => c.text ?? '').join('\n')

/**
 * Match on the URL's HOST, parsed — never `text.includes('gateway.thegraph.com')`.
 *
 * Two different failures, and the substring version has both. The one CodeQL names
 * (js/incomplete-url-substring-sanitization) is that a host can appear anywhere in a URL, so
 * `https://evil.example/?x=gateway.thegraph.com` would match a check meant to identify the vendor.
 * That is the weaker half here, since this reads a file we commit rather than anything an attacker
 * supplies.
 *
 * The half that would actually have bitten us: a substring scan matches PROSE. A comment in
 * networks.js reading "to publish, point this at gateway.thegraph.com" — the exact comment someone
 * writes while preparing this migration — would fail the build with nothing wrong. A gate that
 * cries wolf is worse than no gate, because it teaches everyone to merge past it, and this file
 * already carries that lesson at C4 (a naive substring match reported every source as unpanelled).
 *
 * So: pull the quoted URL literals out, parse each, compare hostnames exactly. Anything unparseable
 * is not a URL and cannot be an endpoint.
 */
function configuredHosts(text) {
  const hosts = new Set()
  for (const [, literal] of text.matchAll(/['"`](https?:\/\/[^'"`\s]+)['"`]/g)) {
    try {
      hosts.add(new URL(literal).hostname.toLowerCase())
    } catch {
      // Not a URL. A template literal with an interpolation lands here, and is correctly ignored:
      // this rule is about a committed endpoint, not one assembled at runtime.
    }
  }
  return hosts
}

if (networksFile && configuredHosts(networksFile).has(GATEWAY_HOST)) {
  const assertedZero = /FINOPS_THEGRAPH_PLAN_USD:\s*["']?0["']?/.test(deploymentText)
  if (assertedZero) {
    fail(
      'C6',
      `A subgraph endpoint now points at ${GATEWAY_HOST} (the decentralized network, where queries are paid in GRT), ` +
        `but a committed deployment still asserts FINOPS_THEGRAPH_PLAN_USD=0. That $0 described Subgraph Studio's free tier.`,
      'Set FINOPS_THEGRAPH_PLAN_USD to the real modelled spend (and fund the GRT billing balance on Arbitrum One — ' +
        'the free allowance does not bill over, it fails). See docs/runbooks/finops-operations.md#thegraph-cost.',
    )
  }
}

// ── C5: committed dashboards match a fresh generation ────────────────────────────────────────

try {
  execFileSync('node', [join(ROOT, 'scripts/finops/generate-dashboards.js'), '--check'], {
    cwd: ROOT,
    stdio: 'pipe',
  })
} catch (err) {
  const detail = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '')
  fail(
    'C5',
    `Committed dashboards do not match a fresh generation.\n${detail.trim()}`,
    'Run `npm run finops:generate` and commit the result.',
  )
}

// ── report ───────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2))
  process.exit(violations.length ? 1 : 0)
}

if (!violations.length) {
  const live = SOURCES.filter((s) => s.status === 'live').length
  const planned = SOURCES.filter((s) => s.status === 'planned').length
  console.log(
    `FinOps coverage OK — ${live} live source(s), ${planned} planned, all catalogued, emitted and panelled.\n` +
      `  ${platformFees.size} FeeRouter service(s) and ${moneyPaths.size} configured gateway payee(s) claimed by the catalogue.`,
  )
  process.exit(0)
}

console.error(`\nFinOps coverage gate FAILED with ${violations.length} violation(s):\n`)
for (const v of violations) {
  console.error(`  [${v.check}] ${v.message}`)
  console.error(`         FIX: ${v.fix}\n`)
}
console.error('Why this gate exists: a revenue or cost source that reaches production without a dashboard')
console.error('entry is money moving that nobody is watching. See specs/089-finops-dashboard/spec.md FR-019.\n')
process.exit(1)
