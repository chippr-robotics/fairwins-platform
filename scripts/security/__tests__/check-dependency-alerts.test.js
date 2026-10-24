/**
 * Must-fail fixtures for the dependency vulnerability gate (issue #1521).
 *
 * The gate exists because 45 Dependabot alerts accumulated while every required check stayed green.
 * A gate that enforces nothing prints the same "intact" line as one that enforces everything, so
 * every rule is driven against input it MUST reject — including the states this repository was
 * actually in: an alert nobody accounted for, and an acceptance that outlived its excuse.
 *
 * Dependency-free: node:test plus a throwaway tree under os.tmpdir().
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkPolicyShape,
  checkWorkflowWiring,
  reconcile,
  fetchOpenAlerts,
  nextLink,
  qualifies,
  scopeOf,
  loadPolicy,
} = require('../check-dependency-alerts.js');

const TODAY = '2026-09-06';

const GOOD_POLICY = {
  failOn: [
    { severity: 'critical', scopes: ['development', 'runtime'] },
    { severity: 'high', scopes: ['runtime'] },
  ],
  acceptances: [
    {
      ghsa: 'GHSA-gcfj-64vw-6mp9',
      package: 'axios',
      issue: 1519,
      expires: '2026-10-15',
      reason: 'Nested copy under a vendor SDK that pins it; the root install is already patched and out of range.',
    },
  ],
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const rules = (violations) => violations.map((v) => v.rule);

const alert = ({ ghsa, severity = 'high', scope = 'runtime', name = 'axios', number = 1 }) => ({
  number,
  dependency: { scope, package: { name } },
  security_advisory: { ghsa_id: ghsa, severity, summary: 'test advisory' },
});

/* ------------------------------------------------------------ D-01 / D-02 */

test('D-01 accepts a well-formed policy', () => {
  assert.deepStrictEqual(checkPolicyShape(GOOD_POLICY, TODAY), []);
});

test('D-01 rejects an acceptance with no reason', () => {
  const p = clone(GOOD_POLICY);
  delete p.acceptances[0].reason;
  assert.ok(rules(checkPolicyShape(p, TODAY)).includes('D-01'));
});

test('D-01 rejects a reason too short to be one — a label is not a rationale', () => {
  const p = clone(GOOD_POLICY);
  p.acceptances[0].reason = 'false positive';
  assert.ok(rules(checkPolicyShape(p, TODAY)).includes('D-01'));
});

test('D-01 rejects an acceptance with no expiry — the whole point is that it ends', () => {
  const p = clone(GOOD_POLICY);
  delete p.acceptances[0].expires;
  assert.ok(rules(checkPolicyShape(p, TODAY)).includes('D-01'));
});

test('D-01 rejects an acceptance with no tracking issue', () => {
  const p = clone(GOOD_POLICY);
  delete p.acceptances[0].issue;
  assert.ok(rules(checkPolicyShape(p, TODAY)).includes('D-01'));
});

test('D-01 rejects a malformed GHSA id', () => {
  const p = clone(GOOD_POLICY);
  p.acceptances[0].ghsa = 'CVE-2026-77465';
  assert.ok(rules(checkPolicyShape(p, TODAY)).includes('D-01'));
});

test('D-01 rejects a duplicate acceptance', () => {
  const p = clone(GOOD_POLICY);
  p.acceptances.push(clone(p.acceptances[0]));
  assert.ok(rules(checkPolicyShape(p, TODAY)).includes('D-01'));
});

test('D-01 rejects an empty or missing failOn — no threshold is not "fail on everything"', () => {
  const p = clone(GOOD_POLICY);
  p.failOn = [];
  assert.ok(rules(checkPolicyShape(p, TODAY)).includes('D-01'));
});

test('D-01 rejects a failOn scope that is not a real scope', () => {
  const p = clone(GOOD_POLICY);
  p.failOn = [{ severity: 'high', scopes: ['production'] }];
  assert.ok(rules(checkPolicyShape(p, TODAY)).includes('D-01'));
});

test('D-02 rejects an expired acceptance', () => {
  const p = clone(GOOD_POLICY);
  p.acceptances[0].expires = '2026-09-05';
  assert.ok(rules(checkPolicyShape(p, TODAY)).includes('D-02'));
});

test('D-02 lets an acceptance expiring today still stand', () => {
  const p = clone(GOOD_POLICY);
  p.acceptances[0].expires = TODAY;
  assert.deepStrictEqual(rules(checkPolicyShape(p, TODAY)).filter((r) => r === 'D-02'), []);
});

/* ------------------------------------------------------ threshold / scope */

test('threshold: critical fails at development scope, high does not', () => {
  const { failOn } = GOOD_POLICY;
  assert.ok(qualifies(alert({ ghsa: 'GHSA-aaaa-bbbb-cccc', severity: 'critical', scope: 'development' }), failOn));
  assert.ok(!qualifies(alert({ ghsa: 'GHSA-aaaa-bbbb-cccc', severity: 'high', scope: 'development' }), failOn));
});

test('threshold: medium never fails, at either scope', () => {
  const { failOn } = GOOD_POLICY;
  assert.ok(!qualifies(alert({ ghsa: 'GHSA-aaaa-bbbb-cccc', severity: 'medium', scope: 'runtime' }), failOn));
});

test('an unknown scope counts as runtime — absence of a "development" label is not safety', () => {
  assert.strictEqual(scopeOf({ dependency: { package: { name: 'x' } } }), 'runtime');
  assert.strictEqual(scopeOf({}), 'runtime');
  assert.ok(qualifies({ dependency: {}, security_advisory: { severity: 'high' } }, GOOD_POLICY.failOn));
});

/* ------------------------------------------------------------ D-03 / D-04 */

test('D-03 rejects a qualifying alert nobody accounted for — the state this repo was in', () => {
  const alerts = [alert({ ghsa: 'GHSA-v5mp-jgw5-2x6j', severity: 'high', scope: 'runtime', name: 'toml' })];
  assert.ok(rules(reconcile(alerts, GOOD_POLICY).violations).includes('D-03'));
});

test('D-03 passes when the qualifying alert is accepted', () => {
  const alerts = [alert({ ghsa: 'GHSA-gcfj-64vw-6mp9' })];
  assert.deepStrictEqual(reconcile(alerts, GOOD_POLICY).violations, []);
});

test('D-03 ignores a below-threshold alert entirely', () => {
  const alerts = [
    alert({ ghsa: 'GHSA-gcfj-64vw-6mp9' }),
    alert({ ghsa: 'GHSA-dddd-eeee-ffff', severity: 'medium', scope: 'development', name: 'undici' }),
  ];
  assert.deepStrictEqual(reconcile(alerts, GOOD_POLICY).violations, []);
});

test('D-04 rejects an acceptance that outlived the alert it excused', () => {
  const alerts = [alert({ ghsa: 'GHSA-zzzz-yyyy-xxxx', severity: 'medium', scope: 'development' })];
  const found = rules(reconcile(alerts, GOOD_POLICY).violations);
  assert.ok(found.includes('D-04'));
});

test('D-04 fires even when the alert list is empty — nothing open means nothing to excuse', () => {
  assert.ok(rules(reconcile([], GOOD_POLICY).violations).includes('D-04'));
});

/* ------------------------------------------------------------------ D-05 */

test('D-05 an HTTP failure throws rather than returning an empty list', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, statusText: 'Forbidden' });
  await assert.rejects(
    () => fetchOpenAlerts({ repo: 'o/r', token: 't', fetchImpl }),
    /403/,
    'a 403 must surface, not degrade to "no alerts"',
  );
});

test('D-05 a missing token throws rather than silently scanning nothing', async () => {
  await assert.rejects(() => fetchOpenAlerts({ repo: 'o/r', token: '', fetchImpl: async () => ({ ok: true, json: async () => [], headers: { get: () => null } }) }));
});

test('D-05 a non-array body is refused', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ message: 'Not Found' }), headers: { get: () => null } });
  await assert.rejects(() => fetchOpenAlerts({ repo: 'o/r', token: 't', fetchImpl }), /unexpected response shape/);
});

test('pagination follows the Link header cursor and keeps every alert', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) =>
    alert({ ghsa: `GHSA-aaaa-bbbb-${String(i).padStart(4, '0')}`, number: i }),
  );
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const first = urls.length === 1;
    return {
      ok: true,
      json: async () => (first ? page1 : [alert({ ghsa: 'GHSA-last-last-last' })]),
      headers: {
        get: (h) =>
          h.toLowerCase() === 'link' && first
            ? '<https://api.github.com/repos/o/r/dependabot/alerts?state=open&per_page=100&after=CUR>; rel="next"'
            : null,
      },
    };
  };
  const all = await fetchOpenAlerts({ repo: 'o/r', token: 't', fetchImpl });
  assert.strictEqual(all.length, 101);
  assert.strictEqual(urls.length, 2);
  assert.match(urls[1], /after=CUR/);
});

test('stops when there is no Link header at all', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => [alert({ ghsa: 'GHSA-aaaa-bbbb-cccc' })], headers: { get: () => null } };
  };
  const all = await fetchOpenAlerts({ repo: 'o/r', token: 't', fetchImpl });
  assert.strictEqual(all.length, 1);
  assert.strictEqual(calls, 1);
});

/**
 * Regression guard. The first implementation paged with `?page=N`, which every stubbed test
 * accepted and which the real endpoint refuses outright:
 *   400 "Pagination using the `page` parameter is not supported."
 * Dependabot alerts page by cursor. A test that only asserts on a stub cannot catch that, so this
 * one asserts on the URL we actually build.
 */
test('never sends a `page` parameter — this endpoint rejects it with a 400', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => [], headers: { get: () => null } };
  };
  await fetchOpenAlerts({ repo: 'o/r', token: 't', fetchImpl });
  assert.ok(urls.length > 0);
  for (const u of urls) assert.ok(!/[?&]page=/.test(u), `built a URL with a page parameter: ${u}`);
});

test('nextLink parses rel="next" and ignores the other rels', () => {
  const h = (link) => ({ get: (k) => (k.toLowerCase() === 'link' ? link : null) });
  assert.strictEqual(nextLink(h('<https://x/a?after=A>; rel="next", <https://x/a?before=B>; rel="prev"')), 'https://x/a?after=A');
  assert.strictEqual(nextLink(h('<https://x/a?before=B>; rel="prev"')), null);
  assert.strictEqual(nextLink(h(null)), null);
  assert.strictEqual(nextLink(undefined), null);
});

/* ------------------------------------------------------------------ D-06 */

const writeWf = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-alerts-'));
  const p = path.join(dir, 'dependency-alerts.yml');
  fs.writeFileSync(p, body);
  return p;
};

const GOOD_WF = `
permissions:
  contents: read
  vulnerability-alerts: read
jobs:
  reconcile:
    steps:
      - run: node scripts/security/check-dependency-alerts.js --live
`;

test('D-06 accepts a correctly wired workflow', () => {
  assert.deepStrictEqual(checkWorkflowWiring(writeWf(GOOD_WF)), []);
});

test('D-06 rejects a workflow missing vulnerability-alerts: read', () => {
  const wf = GOOD_WF.replace('  vulnerability-alerts: read\n', '');
  assert.ok(rules(checkWorkflowWiring(writeWf(wf))).includes('D-06'));
});

test('D-06 is not satisfied by the permission appearing only in a comment', () => {
  const wf = GOOD_WF.replace('  vulnerability-alerts: read', '  # vulnerability-alerts: read');
  assert.ok(rules(checkWorkflowWiring(writeWf(wf))).includes('D-06'));
});

test('D-06 rejects a workflow that never runs --live', () => {
  assert.ok(rules(checkWorkflowWiring(writeWf(GOOD_WF.replace('--live', '')))).includes('D-06'));
});

test('D-06 rejects continue-on-error (Constitution IV)', () => {
  assert.ok(rules(checkWorkflowWiring(writeWf(GOOD_WF + '        continue-on-error: true\n'))).includes('D-06'));
});

test('D-06 rejects a missing workflow file', () => {
  assert.ok(rules(checkWorkflowWiring(path.join(os.tmpdir(), 'nope-does-not-exist.yml'))).includes('D-06'));
});

/* ------------------------------------------------- the shipped policy file */

test('the committed policy passes its own shape rules', () => {
  assert.deepStrictEqual(checkPolicyShape(loadPolicy(), TODAY), []);
});
