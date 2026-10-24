/**
 * Must-fail fixtures for the E2E bypass guard (issue #1460).
 *
 * The guard exists because one plausible, tidy-looking edit — turning the `app` path filter from a
 * negative list into a positive allowlist — silently stops the entire end-to-end suite from
 * running, and a skipped job SATISFIES a required status check, so the change merges green.
 *
 * Every rule is therefore driven against a workflow pair it must REJECT. A guard that enforces
 * nothing prints the same "intact" line as one that enforces everything.
 *
 * Dependency-free: node:test plus a throwaway tree under os.tmpdir().
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkCiGating, GATED_JOBS } = require('../check-ci-gating.js');

const GOOD_CI_MANAGER = `
jobs:
  detect-changes:
    outputs:
      app: \${{ steps.filter.outputs.app }}
    steps:
      - uses: dorny/paths-filter@v4
        id: filter
        with:
          filters: |
            app:
              - '**'
              - '!**/*.md'
              - '!docs/**'
  smart-contract-tests:
    uses: ./.github/workflows/test.yml
    with:
      run_e2e: \${{ needs.detect-changes.outputs.app == 'true' }}
`;

const gatedJob = (name) => `  ${name}:\n    if: inputs.run_e2e\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;

const GOOD_TEST_WF = `
on:
  workflow_call:
    inputs:
      run_e2e:
        type: boolean
        required: false
        default: true

jobs:
${GATED_JOBS.map(gatedJob).join('')}`;

/** Write a workflow pair and run the guard over it. */
function check({ ci = GOOD_CI_MANAGER, wf = GOOD_TEST_WF } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-gating-'));
  const ciManagerPath = path.join(dir, 'ci-manager.yml');
  const testWfPath = path.join(dir, 'test.yml');
  fs.writeFileSync(ciManagerPath, ci);
  fs.writeFileSync(testWfPath, wf);
  return checkCiGating({ ciManagerPath, testWfPath });
}

const rules = (violations) => violations.map((v) => v.rule);

test('the intended wiring passes', () => {
  assert.deepStrictEqual(check(), []);
});

test('C-01 rejects a POSITIVE allowlist — the edit this guard exists for', () => {
  // Looks tidier. Behaves as the opposite: every unlisted path skips the whole suite, and a
  // skipped job satisfies a required check, so it merges green having tested nothing.
  const inverted = GOOD_CI_MANAGER.replace(
    "              - '**'\n              - '!**/*.md'\n              - '!docs/**'",
    "              - 'frontend/**'\n              - 'contracts/**'",
  );
  const violations = check({ ci: inverted });
  assert.ok(rules(violations).includes('C-01'), 'an allowlist must be rejected');
  assert.match(violations[0].message, /negative list/);
});

test('C-01 rejects the filter being removed entirely', () => {
  const gone = GOOD_CI_MANAGER.replace(/            app:\n(              - .*\n)+/, '');
  assert.ok(rules(check({ ci: gone })).includes('C-01'));
});

test('C-02 rejects a positive entry smuggled in after the negative head', () => {
  const mixed = GOOD_CI_MANAGER.replace(
    "              - '!docs/**'",
    "              - '!docs/**'\n              - 'frontend/**'",
  );
  assert.ok(rules(check({ ci: mixed })).includes('C-02'));
});

test('C-03 rejects the value never reaching test.yml', () => {
  const noOutput = GOOD_CI_MANAGER.replace('      app: ${{ steps.filter.outputs.app }}\n', '');
  assert.ok(rules(check({ ci: noOutput })).includes('C-03'), 'a missing job output must be caught');

  const noWith = GOOD_CI_MANAGER.replace(/    with:\n      run_e2e: .*\n/, '');
  assert.ok(rules(check({ ci: noWith })).includes('C-03'), 'a missing `with:` must be caught');
});

test('C-04 rejects any Cypress tier losing its guard', () => {
  for (const job of GATED_JOBS) {
    const ungated = GOOD_TEST_WF.replace(gatedJob(job), `  ${job}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`);
    assert.ok(
      rules(check({ wf: ungated })).includes('C-04'),
      `${job} losing \`if: inputs.run_e2e\` must be caught`,
    );
  }
});

test('C-05 rejects a default that is not true', () => {
  // workflow_dispatch passes no inputs. A false default would mean a manual run — the thing you
  // reach for when you distrust a result — quietly runs no end-to-end tests at all.
  const falseDefault = GOOD_TEST_WF.replace('default: true', 'default: false');
  assert.ok(rules(check({ wf: falseDefault })).includes('C-05'));

  const noDefault = GOOD_TEST_WF.replace('        default: true\n', '');
  assert.ok(rules(check({ wf: noDefault })).includes('C-05'));
});
