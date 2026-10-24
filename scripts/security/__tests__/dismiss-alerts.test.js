/**
 * Must-fail fixtures for the dismissal plan (issue #1520).
 *
 * A dismissal tells GitHub, permanently, that an alert describes code this repository does not
 * contain. The failure mode is silent by construction: a wrongly dismissed alert looks exactly like
 * a correctly dismissed one, and nothing ever brings it back. So every rule is driven against input
 * it MUST reject, including the two states that would actually happen here — the pin moving out
 * from under the argument, and the live set being a different size than the one that was reviewed.
 *
 * Dependency-free: node:test only. Picked up by `npm run test:dep-alerts`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  parseVersion,
  rangeIncludes,
  checkPlanShape,
  ineligibleReason,
  selectAlerts,
  loadPlan,
  MAX_COMMENT,
  reviewedEntryMatches,
  fetchReviewedPlan,
  REVIEW_BRANCH,
  describeWriteCapability,
  probeWriteCapability,
} = require('../dismiss-alerts.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const rulesOf = (violations) => violations.map((x) => x.rule);

const PKG = { devDependencies: { '@openzeppelin/contracts': '5.4.0', '@openzeppelin/contracts-upgradeable': '5.4.0' } };

const ENTRY = {
  id: 'openzeppelin-nested-unreachable',
  issue: 1520,
  dismissedReason: 'not_used',
  expectedCount: 2,
  match: {
    ecosystem: 'npm',
    packages: ['@openzeppelin/contracts', '@openzeppelin/contracts-upgradeable'],
    scope: 'development',
    maxSeverity: 'high',
    compiledVersion: '5.4.0',
  },
  comment: 'Unreachable: nested 4.7.3 copy under a vendor package that solc never reads. See #1520.',
};

const alert = (over = {}) => ({
  number: over.number || 1,
  dependency: {
    package: { ecosystem: 'npm', name: over.name || '@openzeppelin/contracts' },
    scope: over.scope || 'development',
  },
  security_advisory: { severity: over.severity || 'medium', ghsa_id: 'GHSA-aaaa-bbbb-cccc' },
  security_vulnerability: { vulnerable_version_range: over.range || '>= 4.5.0, < 4.9.6' },
});

/* ------------------------------------------------------------ range logic */

test('a range excluding the compiled version makes an alert eligible', () => {
  assert.equal(rangeIncludes('>= 4.5.0, < 4.9.6', '5.4.0'), false);
  assert.equal(rangeIncludes('< 4.8.3', '5.4.0'), false);
  assert.equal(ineligibleReason(alert(), ENTRY), '');
});

test('a range that INCLUDES the compiled version is never dismissed', () => {
  assert.equal(rangeIncludes('>= 5.0.0, < 5.5.0', '5.4.0'), true);
  const reason = ineligibleReason(alert({ range: '>= 5.0.0, < 5.5.0' }), ENTRY);
  assert.match(reason, /reachable/);
});

test('an unparseable range counts as including it — unproven is not proven safe', () => {
  for (const range of ['', null, '>= 4.0.0-beta.1', 'sometimes', '>= 1.2', undefined]) {
    assert.equal(rangeIncludes(range, '5.4.0'), true, `range ${JSON.stringify(range)} must not be treated as excluding`);
  }
  assert.equal(parseVersion('5.4.0-rc.1'), null);
});

/* -------------------------------------------------------------- selection */

test('a runtime-scope alert on the same package is refused', () => {
  assert.match(ineligibleReason(alert({ scope: 'runtime' }), ENTRY), /scope is runtime/);
});

test('an unknown scope counts as runtime, never as development', () => {
  const a = alert();
  delete a.dependency.scope;
  assert.match(ineligibleReason(a, ENTRY), /scope is runtime/);
});

test('a severity above the reviewed ceiling is refused', () => {
  assert.match(ineligibleReason(alert({ severity: 'critical' }), ENTRY), /above the reviewed ceiling/);
});

test('an alert on another package is not this entry\'s business', () => {
  assert.equal(ineligibleReason(alert({ name: 'axios' }), ENTRY), null);
});

test('near misses are reported, not silently dropped', () => {
  const [sel] = selectAlerts([alert({ number: 1 }), alert({ number: 2, scope: 'runtime' })], { dismissals: [ENTRY] });
  assert.deepEqual(sel.eligible.map((a) => a.number), [1]);
  assert.equal(sel.nearMisses.length, 1);
  assert.equal(sel.nearMisses[0].alert.number, 2);
});

/* ------------------------------------------------------------- plan shape */

test('X-02 fails when the pin moves out from under the argument', () => {
  const bumped = { devDependencies: { ...PKG.devDependencies, '@openzeppelin/contracts': '5.5.0' } };
  const out = checkPlanShape({ dismissals: [ENTRY] }, bumped);
  assert.ok(rulesOf(out).includes('X-02'), 'a pin that disagrees with compiledVersion must fail');
  assert.match(out.find((x) => x.rule === 'X-02').message, /5\.5\.0/);
});

test('X-02 fails when the package is no longer a dependency at all', () => {
  const out = checkPlanShape({ dismissals: [ENTRY] }, { devDependencies: {} });
  assert.ok(rulesOf(out).includes('X-02'));
});

test('X-01 rejects a comment the API would refuse', () => {
  const tooLong = { ...ENTRY, comment: 'x'.repeat(MAX_COMMENT + 1) };
  assert.ok(rulesOf(checkPlanShape({ dismissals: [tooLong] }, PKG)).includes('X-01'));
});

test('X-01 rejects an entry with no reasoning, no issue, or an invented reason', () => {
  const cases = [
    { ...ENTRY, comment: 'nope' },
    { ...ENTRY, issue: undefined },
    { ...ENTRY, dismissedReason: 'because_i_said_so' },
    { ...ENTRY, expectedCount: 0 },
    { ...ENTRY, match: undefined },
  ];
  for (const bad of cases) {
    assert.ok(checkPlanShape({ dismissals: [bad] }, PKG).length > 0, `${JSON.stringify(bad.id)} must be refused`);
  }
});

test('X-01 rejects a duplicate id and an empty plan', () => {
  assert.ok(rulesOf(checkPlanShape({ dismissals: [ENTRY, ENTRY] }, PKG)).includes('X-01'));
  assert.ok(rulesOf(checkPlanShape({ dismissals: [] }, PKG)).includes('X-01'));
});

/* ------------------------------------------------------- the shipped plan */

test('the committed plan is valid against the real package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const out = checkPlanShape(loadPlan(), pkg);
  assert.deepEqual(out, [], out.map((x) => `[${x.rule}] ${x.message}`).join('\n'));
});

test('the committed plan argues about the OZ version the contracts actually compile against', () => {
  const [entry] = loadPlan().dismissals;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const name of entry.match.packages) {
    assert.equal(pkg.devDependencies[name], entry.match.compiledVersion);
  }
});

/**
 * The reachability claim itself, checked against the source rather than taken on trust.
 *
 * THIS TEST USED TO ASSERT THE WRONG THING. It read "no contract imports chainlink automation/** —
 * the only route to the nested OZ copy", mirroring a plan-file claim that nitro-contracts is
 * reachable only from `automation/**`. That is false: 16 files in @chainlink/contracts@1.5.0 import
 * nitro and 11 are outside automation/, including `shared/util/ChainSpecificUtil.sol` and three
 * under `functions/` — the two directories this repo does import from. The old assertion therefore
 * passed while proving nothing about the actual risk, and would have kept passing if a contract
 * started importing `shared/util/`.
 *
 * What actually holds is a statement about the CLOSURE: the chainlink files contracts/ imports
 * close over 11 files containing no non-relative imports at all, so they cannot reach node_modules
 * and therefore cannot reach OpenZeppelin. Two halves, because they need different things:
 *
 *   - the ROOTS are in this repo, so they are pinned here and checked on every run;
 *   - the CLOSURE is a property of an installed package, so it is checked by
 *     `chainlink-closure.js` when the package is present, and reported UNVERIFIED when it is not
 *     (this suite runs with no `npm ci`, by design).
 */

/** The exact chainlink surface contracts/ imports. Changing it means re-deriving the closure. */
const EXPECTED_CHAINLINK_ROOTS = [
  '@chainlink/contracts/src/v0.8/functions/v1_0_0/FunctionsClient.sol',
  '@chainlink/contracts/src/v0.8/functions/v1_0_0/interfaces/IFunctionsClient.sol',
  '@chainlink/contracts/src/v0.8/shared/access/ConfirmedOwner.sol',
  '@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol',
];

test('contracts/ imports exactly the four chainlink paths the dismissal argument covers', () => {
  const { chainlinkImportsInContracts } = require('../chainlink-closure.js');
  assert.deepEqual(
    chainlinkImportsInContracts(),
    EXPECTED_CHAINLINK_ROOTS,
    'The #1520 dismissals rest on the import closure of exactly these four files. A new chainlink ' +
      'import may pull OpenZeppelin or nitro into what solc reads, which would make the reasoning ' +
      'recorded on twelve alerts false. Re-derive it with `node scripts/security/chainlink-closure.js`, ' +
      'then update this list and the plan comment together.',
  );
});

test('the closure of those four reaches no package at all (skipped when not installed)', (t) => {
  const { analyze } = require('../chainlink-closure.js');
  const res = analyze();
  if (!res.verified) {
    // Never a silent pass: this suite deliberately runs without `npm ci`, so say which happened.
    t.skip(`UNVERIFIED — ${res.reason}; run \`node scripts/security/chainlink-closure.js\` where it is installed`);
    return;
  }
  assert.deepEqual(res.external, [], 'closure must contain no non-relative imports');
  assert.deepEqual(res.missing, [], 'every relative import must resolve');
  assert.equal(res.mentionsOpenZeppelin, false);
  assert.equal(res.mentionsNitro, false);
});

/* ----------------------------------------------- X-07: the reviewed plan */

/**
 * X-07 exists because a teammate hit both halves of it for real.
 *
 * STALE: #1575 corrected the dismissal comment, but until it merged, `staging` still carried the
 * retracted "reachable only from automation/**" wording. The instruction of the moment — "pull
 * staging first, then apply" — would have stamped the RETRACTED text onto twelve alerts. A
 * dismissed_comment is what the next reader meets and no later PR can correct it.
 *
 * UNREVIEWED: nothing stopped anyone editing the plan locally and applying it, which makes the
 * review — the only thing between a typed paragraph and twelve permanent records — optional.
 *
 * Both are "executing a plan nobody merged", so both fail here. There is deliberately no override.
 */

const REVIEWED = JSON.stringify({ dismissals: [ENTRY] });

test('X-07 accepts the plan that is merged on the review branch', () => {
  assert.deepEqual(reviewedEntryMatches(REVIEWED, ENTRY), { ok: true });
});

test('X-07 refuses a comment that differs from the merged one — the stale-checkout case', () => {
  const retracted = { ...ENTRY, comment: 'Unreachable: nitro is reachable only from automation/** — the retracted wording.' };
  const { ok, why } = reviewedEntryMatches(REVIEWED, retracted);
  assert.equal(ok, false);
  assert.match(why, /comment.*differs/s);
});

test('X-07 refuses a locally edited reason, count or match block', () => {
  for (const local of [
    { ...ENTRY, dismissedReason: 'tolerable_risk' },
    { ...ENTRY, expectedCount: 99 },
    { ...ENTRY, match: { ...ENTRY.match, maxSeverity: 'critical' } },
  ]) {
    assert.equal(reviewedEntryMatches(REVIEWED, local).ok, false, JSON.stringify(local));
  }
});

test('X-07 refuses a plan whose id does not exist on the review branch at all', () => {
  const { ok, why } = reviewedEntryMatches(JSON.stringify({ dismissals: [] }), ENTRY);
  assert.equal(ok, false);
  assert.match(why, /never merged/);
});

test('X-07 refuses rather than proceeding when the review branch is unreadable', async () => {
  await assert.rejects(
    () => fetchReviewedPlan({ repo: 'o/r', token: 't', fetchImpl: async () => ({ ok: false, status: 404, statusText: 'Not Found' }) }),
    /404/,
    'an unreadable review branch must throw, never resolve to something that compares equal',
  );
  // Unparseable content is refused too, rather than treated as "no constraint".
  assert.equal(reviewedEntryMatches('{ not json', ENTRY).ok, false);
});

test('X-07 reads the plan from the review branch, not the default branch', async () => {
  let seen = null;
  await fetchReviewedPlan({
    repo: 'o/r',
    token: 't',
    fetchImpl: async (url) => { seen = url; return { ok: true, text: async () => REVIEWED }; },
  });
  assert.match(seen, /scripts\/security\/dismissals\.json/);
  assert.match(seen, new RegExp(`ref=${REVIEW_BRANCH}`));
});

/* ------------------------------------- X-08: can this token actually write? */

/**
 * From the first real run of #1520: a token carrying `repo` but not `security_events` reads the
 * alert list fine and 403s only on the PATCH, so a GREEN DRY RUN said nothing about whether the
 * credential could apply.
 *
 * The reason that is a gate and not a note is the state a late failure leaves behind. The apply
 * loop had no error handling, so a 403 on the seventh alert would leave six permanently dismissed
 * and throw; the next run then sees 6 open against an `expectedCount` of 12, X-05 fires, and the
 * tool refuses to finish what it half did. That was survived only because the failing token failed
 * on the FIRST write.
 */
const hdr = (value) => ({ get: (k) => (k.toLowerCase() === 'x-oauth-scopes' ? value : null) });

test('X-08 spots a classic PAT that can read but not dismiss', () => {
  const { state, reason } = describeWriteCapability(hdr('repo, read:org, gist'));
  assert.equal(state, 'cannot-write');
  assert.match(reason, /security_events/);
  assert.match(reason, /dry run passed/);
});

test('X-08 accepts a token that carries security_events', () => {
  assert.equal(describeWriteCapability(hdr('repo, security_events')).state, 'can-write');
});

test('X-08 reports unknown — never "fine" — when scopes are not advertised', () => {
  for (const value of [null, '', '   ']) {
    const { state, reason } = describeWriteCapability(hdr(value));
    assert.equal(state, 'unknown', `scopes ${JSON.stringify(value)} must not be read as permission`);
    assert.match(reason, /cannot be known/);
  }
  // A header object that does not support get() at all is also unknown, not a crash.
  assert.equal(describeWriteCapability(undefined).state, 'unknown');
});

test('X-08 probes the alerts endpoint and reads its scope header back', async () => {
  const cap = await probeWriteCapability({
    repo: 'o/r',
    token: 't',
    fetchImpl: async () => ({ headers: hdr('repo') }),
  });
  assert.equal(cap.state, 'cannot-write');
});
