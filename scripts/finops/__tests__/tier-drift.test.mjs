/**
 * C6: an asserted $0 must still describe the tier we actually use.
 *
 * Every other rule in `check:finops` asks whether a source EXISTS. None of them asks whether its
 * declared price is still TRUE, and for most vendors that gap is acceptable — a plan changes when
 * somebody clicks something on a billing page, which is a human event with a human attached to it.
 *
 * The Graph is the exception that made this rule necessary. Its tier is decided by which HOST the
 * app calls: `api.studio.thegraph.com` is the free development tier, `gateway.thegraph.com` is the
 * decentralized network where queries are paid in GRT from a billing balance on Arbitrum One. The
 * entire cost basis therefore flips on a one-line edit to `frontend/src/config/networks.js`, made
 * by somebody thinking about indexing, in a file with no connection to FinOps — and the free
 * allowance does not bill over, it FAILS, so the wrong figure and a member-facing outage arrive
 * together while the dashboard reports everything as free.
 *
 * Driven against a real tree with a real edit, the way the other gate fixtures are: a rule that is
 * only ever exercised on the passing case is a rule nobody has seen work.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
// The C6 cases below edit this REAL file, run the gate against it, and restore it in a `finally`.
// Nothing else may read the tree while that window is open, so `test:finops-gate` passes
// `--test-concurrency=1` — `node --test` otherwise runs the files in this directory in parallel
// processes, and money-paths' "check:finops passes on this tree" then sees the paid-gateway URL
// and fails with a C6 violation it did not cause. That is a race, not a flake: it reproduces
// whenever the two windows overlap, which is why it appeared on CI and not locally. If a mutating
// case is ever added here, keep the suite serialized — or give the gate a tree to read that is not
// the working copy.
const NETWORKS = join(ROOT, 'frontend/src/config/networks.js')
const GATE = join(ROOT, 'scripts/finops/check-finops-coverage.js')

function runGate() {
  try {
    execFileSync('node', [GATE], { cwd: ROOT, stdio: 'pipe' })
    return { ok: true, output: '' }
  } catch (err) {
    return { ok: false, output: (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '') }
  }
}

/**
 * Hosts are PARSED, here as in the gate itself — never matched as substrings of the file.
 *
 * A substring check matches prose, and the prose that would trip it is exactly the comment somebody
 * writes while preparing this migration ("point this at gateway.thegraph.com to publish"). A test
 * asserting the weaker property would pass while the gate it describes cries wolf.
 */
function configuredHosts(text) {
  const hosts = new Set()
  for (const [, literal] of text.matchAll(/['"`](https?:\/\/[^'"`\s]+)['"`]/g)) {
    try {
      hosts.add(new URL(literal).hostname.toLowerCase())
    } catch {
      /* not a URL */
    }
  }
  return hosts
}

test('C6 passes on this tree — every subgraph URL is a Studio endpoint', () => {
  const hosts = configuredHosts(readFileSync(NETWORKS, 'utf8'))
  assert.ok(hosts.has('api.studio.thegraph.com'), 'expected the Studio endpoints this rule is predicated on')
  assert.equal(
    hosts.has('gateway.thegraph.com'),
    false,
    'a gateway URL exists — if this is intentional, C6 should be failing and the plan price revisited',
  )
  assert.ok(runGate().ok, 'check:finops should pass on the committed tree')
})

test('C6 FAILS when a subgraph URL moves to the paid decentralized gateway', () => {
  const original = readFileSync(NETWORKS, 'utf8')
  try {
    writeFileSync(
      NETWORKS,
      original.replace(
        'https://api.studio.thegraph.com/query/1755381/fairwins-polygon/v0.3.0',
        'https://gateway.thegraph.com/api/deadbeef/subgraphs/id/QmFake',
      ),
    )

    const { ok, output } = runGate()
    assert.equal(ok, false, 'the gate must fail once a paid gateway URL is configured')
    assert.match(output, /\[C6\]/)
    assert.match(output, /gateway\.thegraph\.com/)
    // The fix has to name BOTH halves: the figure is wrong AND the balance needs funding, on the
    // right chain. A rule that only says "update the number" leaves the outage in place.
    assert.match(output, /FINOPS_THEGRAPH_PLAN_USD/)
    assert.match(output, /Arbitrum One/)
  } finally {
    writeFileSync(NETWORKS, original)
  }
})

test('a COMMENT naming the gateway host does not trip C6', () => {
  // The false positive that matters. Somebody preparing this migration writes exactly this comment,
  // and a substring-matching gate fails their build with nothing wrong — which is how a gate gets
  // merged past by habit. The rule is about a configured ENDPOINT, not a mention of one.
  const original = readFileSync(NETWORKS, 'utf8')
  try {
    writeFileSync(
      NETWORKS,
      '// TODO: to publish, point these at gateway.thegraph.com (paid, GRT on Arbitrum One)\n' + original,
    )
    assert.ok(runGate().ok, 'a prose mention of the gateway host must not fail the gate')
  } finally {
    writeFileSync(NETWORKS, original)
  }
})

test('the restored tree is byte-identical and green again', () => {
  assert.ok(runGate().ok, 'the fixture must not leave the tree dirty')
  assert.equal(configuredHosts(readFileSync(NETWORKS, 'utf8')).has('gateway.thegraph.com'), false)
})
