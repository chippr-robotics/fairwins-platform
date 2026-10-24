/**
 * Self-test for the spec registry gate (issue #1460).
 *
 * Every rule is driven against a tree that MUST be rejected. A gate that enforces nothing and a
 * gate that enforces everything both print "clean" on a clean tree, so the only evidence that this
 * one works is a fixture it refuses.
 *
 * Dependency-free: node:test plus a throwaway tree under os.tmpdir(). No repo state is read.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkSpecRegistry,
  LEGACY_COLLISIONS,
} = require('../check-spec-registry.js');

/** Build a throwaway specs/ tree. `dirs` maps directory name -> whether to write spec.md. */
function makeSpecsTree(dirs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-registry-'));
  for (const [name, withSpec] of Object.entries(dirs)) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    if (withSpec) fs.writeFileSync(path.join(root, name, 'spec.md'), '# spec\n');
  }
  return root;
}

/** The frozen baseline, materialised, so a fixture starts from a tree the gate accepts. */
function legacyTree() {
  const dirs = {};
  for (const names of Object.values(LEGACY_COLLISIONS)) {
    for (const name of names) dirs[name] = true;
  }
  return dirs;
}

const rules = (violations) => violations.map((v) => v.rule);

test('a clean tree passes', () => {
  const root = makeSpecsTree({ '001-first-thing': true, '002-second-thing': true });
  assert.deepStrictEqual(checkSpecRegistry(root), []);
});

test('S-01 rejects two directories claiming the same number', () => {
  const root = makeSpecsTree({
    '001-first-thing': true,
    '002-one-agent-got-here': true,
    '002-and-so-did-this-one': true,
  });
  const violations = checkSpecRegistry(root);
  assert.ok(rules(violations).includes('S-01'), 'duplicate number must be rejected');
  assert.match(violations[0].message, /reservation PR/);
});

test('S-01 accepts exactly the frozen legacy collisions and nothing more', () => {
  const baseline = legacyTree();
  assert.deepStrictEqual(
    checkSpecRegistry(makeSpecsTree(baseline)),
    [],
    'the recorded pre-gate collisions must not fail the tree they were recorded from',
  );

  // A THIRD directory on a legacy number is new drift, not part of the baseline.
  const number = Object.keys(LEGACY_COLLISIONS)[0];
  const grown = { ...baseline, [`${number}-a-third-claimant`]: true };
  assert.ok(
    rules(checkSpecRegistry(makeSpecsTree(grown))).includes('S-01'),
    'the baseline must not absorb a new collision on a legacy number',
  );
});

test('S-02 rejects a directory that is not NNN-kebab-case', () => {
  for (const bad of ['my-new-feature', '12-too-few-digits', '004_underscores', '005-Mixed-Case']) {
    const root = makeSpecsTree({ '001-first-thing': true, [bad]: true });
    assert.ok(
      rules(checkSpecRegistry(root)).includes('S-02'),
      `${bad} must be rejected as a spec directory name`,
    );
  }
});

test('S-02 allows the explicitly non-numbered directories', () => {
  const root = makeSpecsTree({ '001-first-thing': true, 'design-prompts': false });
  assert.deepStrictEqual(checkSpecRegistry(root), []);
});

test('S-03 rejects a reserved number with no spec.md', () => {
  const root = makeSpecsTree({ '001-first-thing': true, '002-reserved-and-empty': false });
  const violations = checkSpecRegistry(root);
  assert.ok(rules(violations).includes('S-03'), 'an empty reservation must be rejected');
});

test('S-04 is off unless the caller says it is checking the repo tree', () => {
  // The frozen collisions are a fact about specs/, not about every tree. Asserting them
  // by default made unrelated fixtures fail four times over for nothing.
  const root = makeSpecsTree({ '001-first-thing': true });
  assert.deepStrictEqual(checkSpecRegistry(root), []);
  assert.ok(
    rules(checkSpecRegistry(root, { checkBaseline: true })).includes('S-04'),
    'with checkBaseline the missing baseline must be reported',
  );
});

test('S-04 rejects a legacy entry that no longer describes the tree', () => {
  const baseline = legacyTree();
  const [number, names] = Object.entries(LEGACY_COLLISIONS)[0];

  // Simulate a renumber that freed the number but left the exemption behind.
  const renumbered = { ...baseline };
  delete renumbered[names[1]];
  renumbered['900-renumbered-elsewhere'] = true;

  const violations = checkSpecRegistry(makeSpecsTree(renumbered), { checkBaseline: true });
  assert.ok(
    rules(violations).includes('S-04'),
    `a stale LEGACY_COLLISIONS entry for ${number} must be rejected, not carried`,
  );
});
