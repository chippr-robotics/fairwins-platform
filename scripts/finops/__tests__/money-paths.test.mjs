/**
 * Tests for C2b — the money-path half of the FinOps coverage gate (spec 089, FR-019).
 *
 * A gate that silently passes everything is worse than no gate, because it gets cited as evidence
 * that the rules hold. So every rule here is driven twice: once against a fixture that MUST be
 * rejected, and once against the real repository, which MUST be clean.
 *
 * The rejection fixtures are not invented shapes. The x402 fixture is the code that actually shipped
 * uncatalogued, and the "catalogue minus one entry" cases reconstruct the exact state of `main`
 * before this change — which is what makes them proof that these rules fire, rather than proof that
 * they can be made to fire.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

import {
  discoverMoneyPaths,
  unclaimedMoneyPaths,
  staleClaims,
  dormantPathsSwitchedOn,
  findEnvAssignment,
  parsePayeeEnv,
  envReads,
  isTruthyFlag,
} from '../lib/moneyPaths.js'
import { SOURCES } from '../../../packages/finops-catalogue/src/index.js'
import { validateSource } from '../../../packages/finops-catalogue/src/schema.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function readTree(rel, test_) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(join(dir, entry.name))
      } else if (test_(entry.name)) {
        const p = join(dir, entry.name)
        out.push({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') })
      }
    }
  }
  walk(abs)
  return out
}

const gatewayFiles = readTree('services/relay-gateway/src', (f) => f.endsWith('.js'))
const deploymentFiles = [
  ...readTree('infra/vm', (f) => /\.(ya?ml|env)$/.test(f)),
  ...readTree('services', (f) => /\.ya?ml$/.test(f)).filter(({ path }) => path.includes('/deploy/')),
]
const realPaths = discoverMoneyPaths(gatewayFiles)

// ── discovery ────────────────────────────────────────────────────────────────────────────────

test('discovers a configured platform payee — the x402 shape that shipped uncatalogued', () => {
  const found = discoverMoneyPaths([
    { path: 'services/relay-gateway/src/config/index.js', text: `const payTo = opt(env, 'X402_PAY_TO', null)` },
  ])
  assert.ok(found.has('x402'), `expected namespace 'x402', got ${[...found.keys()].join(', ') || '(nothing)'}`)
  assert.match(found.get('x402').evidence[0], /X402_PAY_TO/)
})

test('a payee read through process.env or bracket access is found too', () => {
  for (const text of [`process.env.TIPS_TREASURY`, `env['TIPS_TREASURY']`, `env.TIPS_TREASURY`]) {
    const found = discoverMoneyPaths([{ path: 'services/relay-gateway/src/tips/pay.js', text }])
    assert.ok(found.has('tips'), `not found in: ${text}`)
  }
})

test('a payee hardcoded as an address literal is found, so skipping the env var does not skip the gate', () => {
  const found = discoverMoneyPaths([
    { path: 'services/relay-gateway/src/tips/pay.js', text: `const req = { payTo: '0x1111111111111111111111111111111111111111' }` },
  ])
  assert.ok(found.has('tips'), `expected the module directory as the namespace, got ${[...found.keys()].join(', ')}`)
  assert.match(found.get('tips').evidence[0], /hardcoded payTo/)
})

test("a THIRD PARTY's fee address is NOT reported as a platform payee", () => {
  // OPENSEA_FEE_RECIPIENT is OpenSea's own fee address, hardcoded so the gateway can RECOGNISE their
  // fee in an order. Matching the name anywhere in the text reported it as evidence that FairWins
  // gets paid — a false fact, in a gate whose whole purpose is refusing to state false facts about
  // money. Requiring an actual environment read is what excludes it.
  const found = discoverMoneyPaths([
    {
      path: 'services/relay-gateway/src/opensea/seaport.js',
      text: `export const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719'`,
    },
  ])
  assert.deepStrictEqual([...found.keys()], [], 'a third-party payee constant must not be discovered')
})

test('a member-supplied recipient is not a platform payee', () => {
  // The gateway is full of these — Across quotes, intent structs, Seaport orders. Every one is the
  // MEMBER's address. Matching a bare `recipient` would have raised false positives on day one.
  const found = discoverMoneyPaths([
    { path: 'services/relay-gateway/src/bridge/quotes.js', text: `const { recipient, outputToken } = req.body` },
  ])
  assert.deepStrictEqual([...found.keys()], [])
})

test('parsePayeeEnv takes the LONGEST suffix, and rejects a bare _ADDRESS', () => {
  assert.deepStrictEqual(parsePayeeEnv('FOO_PAYOUT_ADDRESS')?.namespace, 'foo')
  assert.deepStrictEqual(parsePayeeEnv('PERPS_GAINS_REFERRER')?.namespace, 'perps-gains')
  // POLYMARKET_API_ADDRESS is an API identity, not a payee. One suffix meaning two things is how a
  // gate starts producing noise.
  assert.strictEqual(parsePayeeEnv('POLYMARKET_API_ADDRESS'), null)
  assert.strictEqual(parsePayeeEnv('PAY_TO'), null, 'a suffix with no namespace is not a money path')
})

test('envReads finds every environment read regardless of name', () => {
  assert.deepStrictEqual(
    envReads(`opt(env, 'A_TREASURY', null); int(env, 'B_PRICE', 1); env.C_FLAG; process.env.D_KEY`).sort(),
    ['A_TREASURY', 'B_PRICE', 'C_FLAG', 'D_KEY'],
  )
})

// ── rule 1: every discovered money path is claimed ───────────────────────────────────────────

test('unclaimedMoneyPaths FIRES on a payee no catalogue entry claims', () => {
  const found = discoverMoneyPaths([
    { path: 'services/relay-gateway/src/tips/index.js', text: `opt(env, 'TIPS_PAY_TO', null)` },
  ])
  const unclaimed = unclaimedMoneyPaths(found, SOURCES)
  assert.deepStrictEqual(unclaimed.map((p) => p.namespace), ['tips'])
})

test('unclaimedMoneyPaths FIRES on the real x402 rail when its catalogue entry is removed', () => {
  // This is the pre-change state of `main`, reconstructed: the x402 code exactly as it ships, and a
  // catalogue that does not mention it. The gate was green in that state. It must not be.
  const withoutX402 = SOURCES.filter((s) => s.id !== 'x402-agent-payments')
  const unclaimed = unclaimedMoneyPaths(realPaths, withoutX402)
  assert.deepStrictEqual(
    unclaimed.map((p) => p.namespace),
    ['x402'],
    'removing the x402 entry must make the real gateway tree fail C2b',
  )
  assert.match(unclaimed[0].evidence.join(' '), /X402_PAY_TO/)
})

test('every money path the REAL gateway configures is claimed by the catalogue', () => {
  const unclaimed = unclaimedMoneyPaths(realPaths, SOURCES)
  assert.deepStrictEqual(
    unclaimed.map((p) => `${p.namespace} (${p.evidence.join(', ')})`),
    [],
    'an unclaimed money path means money can arrive at an address we control and appear on no dashboard',
  )
})

test('the detector finds the payees the catalogue already knew about, not just x402', () => {
  // Four of the five namespaces were catalogued long before this rule existed. That the detector
  // rediscovers them independently is what says it is a general rule rather than an x402-shaped
  // hole-plug — and it is why the reverse direction (staleClaims) has anything to check.
  assert.deepStrictEqual([...realPaths.keys()].sort(), ['opensea', 'perps-gains', 'perps-gmx', 'polymarket', 'x402'])
})

// ── rule 2: a claim that no longer matches the platform ──────────────────────────────────────

test('staleClaims FIRES on an entry claiming a payee the gateway no longer reads', () => {
  const renamed = SOURCES.map((s) =>
    s.id === 'referral-opensea' ? { ...s, moneyPath: { ...s.moneyPath, payeeEnv: 'OPENSEA_OLD_PAYEE' } } : s,
  )
  assert.deepStrictEqual(staleClaims(realPaths, renamed, gatewayFiles).map((s) => s.id), ['referral-opensea'])
})

test('no catalogue claim is stale against the real gateway', () => {
  assert.deepStrictEqual(staleClaims(realPaths, SOURCES, gatewayFiles).map((s) => s.id), [])
})

// ── rule 3: dormancy honesty ─────────────────────────────────────────────────────────────────

test('findEnvAssignment ignores COMMENTED config — the documented way a built path is parked', () => {
  const files = [{ path: 'infra/vm/gateway/docker-compose.yml', text: '      # X402_ENABLED: "true"\n      # X402_PAY_TO: "0x00"' }]
  assert.strictEqual(findEnvAssignment(files, 'X402_ENABLED', isTruthyFlag), null)
  assert.strictEqual(findEnvAssignment(files, 'X402_PAY_TO'), null)
})

test('findEnvAssignment ignores a deliberately-empty value and a <placeholder>', () => {
  const files = [
    { path: 'a.yml', text: '      OPENSEA_REFERRAL_ADDRESS: ""' },
    { path: 'b.yml', text: '      X402_PAY_TO: "<treasury address — REQUIRED, no default>"' },
  ]
  assert.strictEqual(findEnvAssignment(files, 'OPENSEA_REFERRAL_ADDRESS'), null)
  assert.strictEqual(findEnvAssignment(files, 'X402_PAY_TO'), null)
})

test('findEnvAssignment finds a real assignment, in compose and in env-file form', () => {
  const yaml = findEnvAssignment([{ path: 'a.yml', text: '      X402_PAY_TO: "0x2222222222222222222222222222222222222222"' }], 'X402_PAY_TO')
  assert.strictEqual(yaml.value, '0x2222222222222222222222222222222222222222')
  assert.strictEqual(yaml.line, 1)
  const env = findEnvAssignment([{ path: 'b.env', text: 'X402_ENABLED=true' }], 'X402_ENABLED', isTruthyFlag)
  assert.strictEqual(env.value, 'true')
})

test('dormantPathsSwitchedOn FIRES when a deployment configures a planned path’s treasury', () => {
  // The payee branch is asserted against a CONSTRUCTED planned source rather than a real one. It
  // used to use x402, and broke the moment x402 was promoted to `live` — which is the rule working,
  // not the rule failing, but it left the branch uncovered at exactly the wrong time. No real source
  // is both `planned` and payee-bearing today, and pinning a rule's only test to whichever source
  // happens to be dormant means the test disappears each time one graduates.
  const plannedWithPayee = [
    {
      ...SOURCES.find((s) => s.id === 'x402-agent-payments'),
      status: 'planned',
      metric: null,
      collector: 'none',
    },
  ]
  const switchedOn = [{ path: 'infra/vm/gateway/docker-compose.yml', text: '      X402_PAY_TO: "0x3333333333333333333333333333333333333333"' }]
  const hits = dormantPathsSwitchedOn(plannedWithPayee, switchedOn)
  assert.deepStrictEqual(hits.map((h) => h.source.id), ['x402-agent-payments'])
  assert.match(hits[0].what, /X402_PAY_TO is configured/)
})

test('dormantPathsSwitchedOn FIRES on the assistant’s enable flag — the cost side of the same rule', () => {
  const switchedOn = [{ path: 'infra/vm/gateway/docker-compose.yml', text: '      ASSISTANT_ENABLED: "true"' }]
  assert.deepStrictEqual(
    dormantPathsSwitchedOn(SOURCES, switchedOn).map((h) => h.source.id),
    ['assistant-model-api'],
  )
})

test('a flag set to false does not count as switched on', () => {
  const off = [{ path: 'infra/vm/gateway/docker-compose.yml', text: '      ASSISTANT_ENABLED: "false"' }]
  assert.deepStrictEqual(dormantPathsSwitchedOn(SOURCES, off), [])
})

test('no dormant money path is switched on in any committed deployment today', () => {
  const hits = dormantPathsSwitchedOn(SOURCES, deploymentFiles)
  assert.deepStrictEqual(
    hits.map((h) => `${h.source.id}: ${h.what} in ${h.hit.path}:${h.hit.line}`),
    [],
  )
})

// ── the catalogue entries this rule exists to protect ────────────────────────────────────────

test('x402 is catalogued as LIVE revenue that emits a value', () => {
  const x402 = SOURCES.find((s) => s.id === 'x402-agent-payments')
  assert.ok(x402, 'the x402 paid rail must be catalogued: it takes USDC to the platform treasury')
  assert.strictEqual(x402.kind, 'revenue')
  // Promoted when the rail was switched on, which is the sequencing C2b forces: the deployment that
  // offers a revenue path and the collector that watches it land together. This assertion is the
  // other half of that — a live source MUST emit, or the dashboard has a source it never shows.
  assert.strictEqual(x402.status, 'live')
  assert.strictEqual(x402.metric, 'fairwins_finops_revenue_total')
  assert.notStrictEqual(x402.collector, 'none')
  assert.strictEqual(x402.moneyPath.payeeEnv, 'X402_PAY_TO')
  assert.deepStrictEqual(validateSource(x402, 0), [])
})

test('the Anthropic assistant is catalogued as a MODELLED cost', () => {
  const assistant = SOURCES.find((s) => s.id === 'assistant-model-api')
  assert.ok(assistant, 'the assistant calls a metered model API: that is a vendor cost')
  assert.strictEqual(assistant.kind, 'cost')
  // Declared now, while nothing is at stake. This exporter holds no Anthropic billing credential, so
  // any dollar figure it ever publishes is token counts times a rate we typed in. Only GCP is billed.
  assert.strictEqual(assistant.basis, 'modelled')
  assert.strictEqual(assistant.metric, null)
  assert.deepStrictEqual(validateSource(assistant, 0), [])
})

test('the schema rejects a moneyPath that cannot be joined to the code', () => {
  const base = SOURCES.find((s) => s.id === 'x402-agent-payments')
  const badNamespace = validateSource({ ...base, moneyPath: { namespace: 'X402' } }, 0)
  assert.ok(badNamespace.some((p) => /moneyPath\.namespace/.test(p)), badNamespace.join('\n'))
  const badEnv = validateSource({ ...base, moneyPath: { namespace: 'x402', payeeEnv: 'x402_pay_to' } }, 0)
  assert.ok(badEnv.some((p) => /moneyPath\.payeeEnv/.test(p)), badEnv.join('\n'))
})

test('the schema rejects a basis that is not a basis, on a planned cost too', () => {
  const assistant = SOURCES.find((s) => s.id === 'assistant-model-api')
  const problems = validateSource({ ...assistant, basis: 'estimated' }, 0)
  assert.ok(problems.some((p) => /'basis' must be billed or modelled/.test(p)), problems.join('\n'))
})

// ── the gate as a whole ──────────────────────────────────────────────────────────────────────

test('npm run check:finops passes on this tree', () => {
  // spawnSync, not execFileSync: the gate exits non-zero on a violation, and a throwing call
  // loses the --json payload it just printed. The failure then reads `Command failed: node
  // .../check-finops-coverage.js --json` and names none of the violations, which is the one
  // thing this assertion exists to tell you.
  const run = spawnSync('node', [join(ROOT, 'scripts/finops/check-finops-coverage.js'), '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.ok(run.stdout, `the gate printed no JSON (status ${run.status}): ${run.stderr || run.error}`)
  const { ok, violations } = JSON.parse(run.stdout)
  assert.strictEqual(ok, true, violations.map((v) => `[${v.check}] ${v.message}`).join('\n'))
})
