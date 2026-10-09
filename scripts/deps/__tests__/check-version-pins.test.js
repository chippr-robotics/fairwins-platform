/**
 * Must-fail fixtures for the version-pin gate (ADR-006, issue #1648).
 *
 * A gate that enforces nothing prints the same "✓" line as one that enforces everything, so every
 * rule is driven against input it MUST reject. That includes the state this repository was
 * actually in: an engine pinned below upstream with no recorded reason, floating base-image tags,
 * and a Node line past its EOL.
 *
 * Dependency-free: node:test plus a throwaway tree under os.tmpdir(). No network: the live half is
 * driven through injected fetch/exec.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkRegistryShape,
  checkDrift,
  checkImages,
  checkWorkflowWiring,
  discoverImages,
  splitRef,
  latestStable,
  describeBehind,
  readUpstream,
  renderReport,
  loadRegistry,
} = require('../check-version-pins.js');

const TODAY = '2026-10-09';

const holdPin = () => ({
  id: 'oz-relayer-engine',
  kind: 'git-built-image',
  owner: 'relay',
  pinned: 'v1.4.0',
  status: 'hold',
  locations: [{ path: 'svc/Dockerfile', contains: 'engine-base:v1.4.0' }],
  upstream: { type: 'git', repo: 'https://github.com/OpenZeppelin/openzeppelin-relayer' },
  hold: {
    reason: '1.5.0 finalizes mined txs as Failed on a load-balanced RPC (#817).',
    ref: '#1648',
    watch: ['#817'],
    reviewBy: '2027-01-09',
  },
});

const trackPin = () => ({
  id: 'node-runtime-image',
  kind: 'container-image',
  owner: 'mark',
  pinned: '22.23.3',
  status: 'track',
  locations: [{ path: 'Dockerfile', contains: 'node:22.23.3-alpine3.24' }],
  upstream: { type: 'dockerhub', image: 'library/node', tagPattern: '^22\\.\\d+\\.\\d+-alpine$' },
  eol: { product: 'nodejs', cycle: '22' },
});

const registry = (over = {}) => ({
  reviewWindowDays: 180,
  firstPartyPrefixes: ['registry.example/ours/'],
  exemptions: [],
  pins: [holdPin(), trackPin()],
  ...over,
});

const rules = (vs) => vs.map((x) => x.rule);

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-pins-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

/* ---------------------------------------------------------------- V-01 / V-02 */

test('V-01: a well-formed registry passes', () => {
  assert.deepStrictEqual(checkRegistryShape(registry(), TODAY), []);
});

test('V-01: a hold with no reason is refused (how 1.4.0 happened)', () => {
  const p = holdPin();
  delete p.hold.reason;
  assert.ok(rules(checkRegistryShape(registry({ pins: [p] }), TODAY)).includes('V-01'));
});

test('V-01: a label-length reason is not a reason', () => {
  const p = holdPin();
  p.hold.reason = 'untested';
  assert.ok(rules(checkRegistryShape(registry({ pins: [p] }), TODAY)).includes('V-01'));
});

test('V-01: a hold with no ref or no reviewBy is refused', () => {
  const a = holdPin();
  delete a.hold.ref;
  const b = holdPin();
  b.id = 'b';
  delete b.hold.reviewBy;
  const vs = checkRegistryShape(registry({ pins: [a, b] }), TODAY);
  assert.strictEqual(vs.filter((x) => x.rule === 'V-01').length, 2);
});

test('V-01: duplicate ids, missing owner, bad upstream, track carrying a hold', () => {
  const dup = trackPin();
  const noOwner = { ...trackPin(), id: 'x' };
  delete noOwner.owner;
  const badUp = { ...trackPin(), id: 'y', upstream: { type: 'git', repo: 'not-a-url' } };
  const both = { ...trackPin(), id: 'z', hold: holdPin().hold };
  const vs = checkRegistryShape(registry({ pins: [trackPin(), dup, noOwner, badUp, both] }), TODAY);
  assert.ok(vs.length >= 4, JSON.stringify(vs));
  assert.ok(vs.every((x) => x.rule === 'V-01'));
});

test('V-01: an unwatchable pin must say why', () => {
  const p = { ...trackPin(), upstream: { type: 'none' } };
  assert.ok(rules(checkRegistryShape(registry({ pins: [p] }), TODAY)).includes('V-01'));
});

test('V-02: an expired hold fails the pull request', () => {
  const p = holdPin();
  p.hold.reviewBy = '2026-10-08';
  assert.ok(rules(checkRegistryShape(registry({ pins: [p] }), TODAY)).includes('V-02'));
});

test('V-02: a hold dated past the review window is no date at all', () => {
  const p = holdPin();
  p.hold.reviewBy = '2027-12-31';
  assert.ok(rules(checkRegistryShape(registry({ pins: [p] }), TODAY)).includes('V-02'));
});

test('V-02: exemptions expire like holds', () => {
  const ex = [{ file: 'c.yml', contains: 'x:latest', reason: 'deployed SHA not yet read from the registry', ref: '#1', reviewBy: '2026-01-01' }];
  assert.ok(rules(checkRegistryShape(registry({ exemptions: ex }), TODAY)).includes('V-02'));
});

/* ---------------------------------------------------------------- V-03 */

test('V-03: a bump that forgets the registry fails', () => {
  const root = tree({ 'Dockerfile': 'FROM node:22.24.0-alpine3.24\n', 'svc/Dockerfile': 'FROM r/engine-base:v1.4.0\n' });
  const vs = checkDrift(registry(), { root });
  assert.deepStrictEqual(rules(vs), ['V-03']);
  assert.match(vs[0].message, /node:22\.23\.3/);
});

test('V-03: `contains` must carry the pinned version', () => {
  const p = trackPin();
  p.locations = [{ path: 'Dockerfile', contains: 'node:22-alpine' }];
  const root = tree({ 'Dockerfile': 'FROM node:22-alpine\n' });
  assert.ok(rules(checkDrift(registry({ pins: [p] }), { root })).includes('V-03'));
});

test('V-03: a vanished file is drift', () => {
  const root = tree({ 'svc/Dockerfile': 'FROM r/engine-base:v1.4.0\n' });
  assert.ok(checkDrift(registry(), { root }).some((x) => /does not exist/.test(x.message)));
});

test('V-03: matching files pass', () => {
  const root = tree({ 'Dockerfile': 'FROM node:22.23.3-alpine3.24 AS b\n', 'svc/Dockerfile': 'FROM r/engine-base:v1.4.0\n' });
  assert.deepStrictEqual(checkDrift(registry(), { root }), []);
});

/* ---------------------------------------------------------------- discovery */

test('discovery finds FROM and image:, and skips build-stage references', () => {
  const root = tree({
    'Dockerfile': 'FROM node:22.23.3-alpine3.24 AS build\nFROM build\nFROM --platform=linux/amd64 nginx:1.30.5-alpine\n',
    'infra/docker-compose.yml': 'services:\n  r:\n    image: "redis:7-alpine" # cache\n',
    'README.md': 'FROM node:latest\n',
  });
  const refs = discoverImages(root).map((r) => `${r.file}:${r.ref}`).sort();
  assert.deepStrictEqual(refs, ['Dockerfile:nginx:1.30.5-alpine', 'Dockerfile:node:22.23.3-alpine3.24', 'infra/docker-compose.yml:redis:7-alpine']);
});

test('discovery sees the forms a regex-on-one-line misses', () => {
  const root = tree({
    'subgraph/api.Dockerfile': 'FROM Ubuntu:22.04 AS Build\nFROM build\nFROM scratch\nCOPY --from=nginx:1.30.5-alpine /x /y\nRUN --mount=type=cache,from=redis:latest,target=/z true\nCOPY --from=Build /a /b\n',
    'deploy/service.yaml': 'spec:\n  containers:\n    - image: redis:7-alpine\n    - name: x\n      image:\n        busybox:latest\n    - image: !!str alpine:3\n',
  });
  const refs = discoverImages(root).map((r) => `${r.file}:${r.line}:${r.ref}`).sort();
  assert.deepStrictEqual(refs, [
    'deploy/service.yaml:3:redis:7-alpine',
    'deploy/service.yaml:6:busybox:latest',
    'deploy/service.yaml:7:alpine:3',
    'subgraph/api.Dockerfile:1:Ubuntu:22.04',
    'subgraph/api.Dockerfile:4:nginx:1.30.5-alpine',
    'subgraph/api.Dockerfile:5:redis:latest',
  ]);
});

test('V-04/V-05: a Docker Hub namespace that merely LOOKS first-party is not exempt', () => {
  const reg = registry({ firstPartyPrefixes: ['registry.example/ours/', 'fairwins-relay-gateway:local'] });
  const vs = checkImages(reg, [ref('fairwins-evil/foo:1')]);
  assert.ok(rules(vs).includes('V-04') && rules(vs).includes('V-05'), JSON.stringify(vs));
  assert.deepStrictEqual(checkImages(reg, [ref('fairwins-relay-gateway:local')]), []);
});

test('splitRef handles registries with ports, digests and no tag', () => {
  assert.deepStrictEqual(splitRef('host:5000/a/b:1.2.3'), { name: 'host:5000/a/b', tag: '1.2.3', digest: null });
  assert.deepStrictEqual(splitRef('a/b@sha256:abc'), { name: 'a/b', tag: null, digest: 'sha256:abc' });
  assert.strictEqual(splitRef('redis').tag, null);
});

/* ---------------------------------------------------------------- V-04 / V-05 */

const ref = (r, file = 'Dockerfile') => ({ file, line: 1, ref: r });

test('V-05: the floating tags this repo actually had are refused', () => {
  const reg = registry({ pins: [] });
  for (const r of ['node:22-alpine', 'nginx:alpine', 'redis:7-alpine', 'nginx:1.27-alpine', 'node']) {
    assert.ok(rules(checkImages(reg, [ref(r)])).includes('V-05'), r);
  }
});

test('V-05: `latest` is refused even for first-party images', () => {
  assert.ok(rules(checkImages(registry(), [ref('registry.example/ours/nginx:latest')])).includes('V-05'));
});

test('V-05: a first-party sha tag is fine; a digest is fine', () => {
  assert.deepStrictEqual(checkImages(registry(), [ref('registry.example/ours/gw:spec109-7110b663')]), []);
  const reg = registry({ pins: [{ ...trackPin(), locations: [{ path: 'Dockerfile', contains: 'alpine@sha256' }] }] });
  assert.ok(!rules(checkImages(reg, [ref('alpine@sha256:abc')])).includes('V-05'));
});

test('V-05: a variable-built FROM is refused', () => {
  assert.ok(rules(checkImages(registry(), [ref('node:${NODE}')])).includes('V-05'));
});

test('V-05: a live exemption tolerates the floating tag; a stale one is flagged', () => {
  const ex = { file: 'c.yml', contains: 'ours/nginx:latest', reason: 'deployed SHA not yet read from AR', ref: '#1', reviewBy: '2026-11-30' };
  const reg = registry({ exemptions: [ex] });
  assert.deepStrictEqual(checkImages(reg, [ref('registry.example/ours/nginx:latest', 'c.yml')]), []);
  assert.ok(checkImages(reg, []).some((x) => x.rule === 'V-04' && /matches no image/.test(x.message)));
});

test('V-04: an exact third-party image nobody claims is refused', () => {
  const vs = checkImages(registry({ pins: [] }), [ref('grafana/alloy:v1.10.2', 'c.yml')]);
  assert.deepStrictEqual(rules(vs), ['V-04']);
});

test('V-04: claimed exact images pass', () => {
  assert.deepStrictEqual(checkImages(registry(), [ref('node:22.23.3-alpine3.24')]), []);
});

/* ---------------------------------------------------------------- V-06 */

test('V-06: wiring', () => {
  const dir = tree({
    'ok.yml': "on:\n  schedule:\n    - cron: '0 8 * * 1'\njobs:\n  a:\n    steps:\n      - run: npm run check:version-pins:live\n",
    'nosched.yml': 'on: workflow_dispatch\njobs: { a: { steps: [ { run: npm run check:version-pins:live } ] } }\n',
    'coe.yml': "on:\n  schedule:\n    - cron: '0 8 * * 1'\njobs:\n  a:\n    continue-on-error: true\n    steps:\n      - run: npm run check:version-pins:live\n",
  });
  assert.deepStrictEqual(checkWorkflowWiring(path.join(dir, 'ok.yml')), []);
  assert.ok(checkWorkflowWiring(path.join(dir, 'nosched.yml')).length > 0);
  assert.ok(checkWorkflowWiring(path.join(dir, 'coe.yml')).length > 0);
  assert.ok(checkWorkflowWiring(path.join(dir, 'missing.yml')).length > 0);
});

/* ---------------------------------------------------------------- live helpers */

test('latestStable ignores pre-releases and honours the line pattern', () => {
  const tags = ['v1.4.0', 'v1.8.0', 'v1.9.0-rc.1', 'v2.0.0-beta', 'v1.10.0', 'nightly'];
  assert.strictEqual(latestStable(tags), 'v1.10.0');
  assert.strictEqual(latestStable(['22.23.3-alpine', '24.1.0-alpine', '22.23.4-slim'], '^22\\.\\d+\\.\\d+-alpine$'), '22.23.3-alpine');
  assert.strictEqual(latestStable(['nightly']), null);
});

test('describeBehind', () => {
  assert.strictEqual(describeBehind('v1.4.0', 'v1.8.0'), '4 minor');
  assert.strictEqual(describeBehind('v1.2.7', 'v1.2.8'), '1 patch');
  assert.strictEqual(describeBehind('7.4.11', '8.0.0'), '1 major');
  assert.strictEqual(describeBehind('22.23.3', '22.23.3-alpine'), 'current');
  assert.strictEqual(describeBehind('21', '21'), 'unknown');
});

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test('readUpstream: git pin read through injected exec', async () => {
  const exec = () => 'a\trefs/tags/v1.4.0\nb\trefs/tags/v1.8.0\nc\trefs/tags/v1.9.0-rc1\n';
  const r = await readUpstream(holdPin(), { today: TODAY, exec, fetchImpl: async () => jsonRes([]) });
  assert.strictEqual(r.state, 'read');
  assert.strictEqual(r.latest, 'v1.8.0');
  assert.strictEqual(r.behind, '4 minor');
});

test('readUpstream: an unreachable upstream is UNREADABLE, never current', async () => {
  const exec = () => {
    throw new Error('fatal: unable to access');
  };
  const r = await readUpstream(holdPin(), { today: TODAY, exec });
  assert.strictEqual(r.state, 'unreadable');
  assert.strictEqual(r.latest, undefined);
  const md = renderReport([r], registry(), TODAY);
  assert.match(md, /\*\*unreadable\*\*/);
  assert.match(md, /Unreadable:\*\* 1 \(oz-relayer-engine\)/);
  assert.doesNotMatch(md, /\| current \|/);
});

test('readUpstream: Docker Hub 5xx is unreadable; EOL inside 90 days is flagged', async () => {
  const fetchImpl = async (url) => (url.includes('endoflife') ? jsonRes([{ cycle: '22', eol: '2026-12-01' }]) : jsonRes({}, false, 503));
  const r = await readUpstream(trackPin(), { today: TODAY, fetchImpl });
  assert.strictEqual(r.state, 'unreadable');
  assert.strictEqual(r.eol, '2026-12-01');
  assert.strictEqual(r.eolSoon, true);
  assert.match(renderReport([r], registry(), TODAY), /Needs a decision:\*\* 1/);
});

test('readUpstream: a past-EOL unwatched toolchain is still flagged', async () => {
  const p = { ...trackPin(), upstream: { type: 'none', why: 'language line chosen, not followed' }, eol: { product: 'go', cycle: '1.21' } };
  const fetchImpl = async () => jsonRes([{ cycle: '1.21', eol: '2024-08-13' }]);
  const r = await readUpstream(p, { today: TODAY, fetchImpl });
  assert.strictEqual(r.state, 'unwatched');
  assert.strictEqual(r.eolSoon, true);
  assert.match(renderReport([r], registry(), TODAY), /\*\*2024-08-13\*\* ⚠/);
});

test('readUpstream: a supported line with no published EOL reads "supported", not a blank', async () => {
  const fetchImpl = async (url) => (url.includes('endoflife') ? jsonRes([{ cycle: '22', eol: false }]) : jsonRes({ results: [{ name: '22.23.3-alpine' }], next: null }));
  const r = await readUpstream(trackPin(), { today: TODAY, fetchImpl });
  assert.strictEqual(r.behind, 'current');
  assert.match(renderReport([r], registry(), TODAY), /\| supported \|/);
});

/* ---------------------------------------------------------------- the real registry */

test('the committed registry passes its own offline rules', () => {
  const reg = loadRegistry();
  assert.deepStrictEqual(checkRegistryShape(reg, TODAY), []);
  assert.deepStrictEqual(checkDrift(reg), []);
  assert.deepStrictEqual(checkImages(reg, discoverImages()), []);
  assert.deepStrictEqual(checkWorkflowWiring(), []);
});
