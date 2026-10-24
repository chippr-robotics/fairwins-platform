#!/usr/bin/env node
/**
 * Guard the E2E shard bypass (issue #1460).
 *
 * `test.yml` skips the Cypress tiers — 12 fast legs, 4 on-chain shards, the passkey full stack —
 * when ci-manager's `app` path filter says the diff cannot reach the running app. That saves a
 * large amount of CI on documentation changes, and it is safe for exactly one reason:
 *
 *   `app` is a NEGATIVE list. It starts at `'**'` and subtracts known-inert paths, so a path
 *   nobody has thought about matches `**`, sets `app` true, and RUNS the suite.
 *
 * Invert it to a positive allowlist and it behaves as the opposite: everything unlisted skips —
 * and because a SKIPPED job SATISFIES a required status check, such a change merges green having
 * tested nothing. That is spec 075's documented hole, reached by a one-line edit that looks
 * tidier than what it replaced.
 *
 * The edit is small, plausible and catastrophic, which is the profile of a thing that needs a
 * gate rather than a comment. Rules:
 *
 *   C-01  ci-manager declares an `app` filter, and its FIRST entry is `'**'`.
 *   C-02  every other `app` entry is an exclusion (`!`).
 *   C-03  `app` is exported as a job output and passed to test.yml as `run_e2e`.
 *   C-04  every Cypress job in test.yml is gated on `inputs.run_e2e`.
 *   C-05  `run_e2e` defaults to TRUE, so a caller that omits it runs everything.
 *
 * Dependency-free (text scanning, no YAML parser) so it runs in CI without `npm ci`, in the same
 * tier as the other structural gates.
 *
 * Usage: node scripts/ci/check-ci-gating.js [--json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CI_MANAGER = path.join(ROOT, '.github', 'workflows', 'ci-manager.yml');
const TEST_WF = path.join(ROOT, '.github', 'workflows', 'test.yml');

/** Cypress jobs that the bypass is allowed to skip. Each MUST carry the `inputs.run_e2e` guard. */
const GATED_JOBS = ['cypress-fast-e2e', 'cypress-full-e2e', 'cypress-passkey-full-stack'];

/** Strip `#` comment lines so a comment ABOUT the rule is never mistaken for the rule. */
const stripComments = (raw) =>
  raw
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/**
 * Pull the entries of the `app:` filter out of ci-manager's `filters: |` block.
 *
 * Text, not YAML: the filters are a block SCALAR (a string that dorny/paths-filter parses itself),
 * so a YAML loader hands back one string and we would be scanning text anyway — with a dependency.
 */
function readAppFilter(text) {
  const lines = stripComments(text).split('\n');
  const startIdx = lines.findIndex((l) => /^\s*app:\s*$/.test(l));
  if (startIdx === -1) return null;

  const indent = lines[startIdx].match(/^\s*/)[0].length;
  const entries = [];
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const lead = line.match(/^\s*/)[0].length;
    if (lead <= indent) break; // dedented: the filter ended
    const m = line.match(/^\s*-\s*'?([^'\n]+)'?\s*$/);
    if (!m) break;
    entries.push(m[1].trim());
  }
  return entries;
}

/**
 * @param {{ciManagerPath?: string, testWfPath?: string}} paths overridable so the self-test can
 *   drive each rule against a workflow pair that MUST be rejected, without touching the repo's.
 */
function checkCiGating({ ciManagerPath = CI_MANAGER, testWfPath = TEST_WF } = {}) {
  const violations = [];
  const ciManager = fs.readFileSync(ciManagerPath, 'utf8');
  const testWf = fs.readFileSync(testWfPath, 'utf8');
  const ciBody = stripComments(ciManager);
  const testBody = stripComments(testWf);

  // C-01 / C-02 — the shape that makes an unknown path RUN rather than skip.
  const entries = readAppFilter(ciManager);
  if (!entries || entries.length === 0) {
    violations.push({
      rule: 'C-01',
      message:
        'ci-manager.yml declares no `app:` path filter. The E2E bypass reads it; without it ' +
        '`run_e2e` is empty and the Cypress tiers silently stop running.',
    });
  } else {
    if (entries[0] !== '**') {
      violations.push({
        rule: 'C-01',
        message:
          `The \`app\` filter's first entry is \`${entries[0]}\`, not \`**\`. It MUST be a ` +
          'negative list: starting anywhere else makes it an allowlist, so any path nobody ' +
          'listed skips the whole E2E suite — and a skipped job satisfies a required check.',
      });
    }
    const positives = entries.slice(1).filter((e) => !e.startsWith('!'));
    if (positives.length > 0) {
      violations.push({
        rule: 'C-02',
        message:
          `The \`app\` filter has non-exclusion entries after \`**\`: ${positives.join(', ')}. ` +
          'Every entry after the first must be an exclusion (`!path`) — anything else is an ' +
          'allowlist in disguise.',
      });
    }
  }

  // C-03 — the value has to actually reach test.yml.
  if (!/^\s*app:\s*\$\{\{\s*steps\.filter\.outputs\.app\s*\}\}\s*$/m.test(ciBody)) {
    violations.push({
      rule: 'C-03',
      message: 'detect-changes does not export `app` as a job output, so nothing can read it.',
    });
  }
  if (!/run_e2e:\s*\$\{\{\s*needs\.detect-changes\.outputs\.app\s*==\s*'true'\s*\}\}/.test(ciBody)) {
    violations.push({
      rule: 'C-03',
      message:
        'ci-manager does not pass `run_e2e: needs.detect-changes.outputs.app == \'true\'` to ' +
        'test.yml. Without it test.yml falls back to its default and every change runs the ' +
        'full suite — safe, but the bypass is dead.',
    });
  }

  // C-04 — each expensive job must still be gated.
  for (const job of GATED_JOBS) {
    const block = testBody.split(new RegExp(`^  ${job}:\\s*$`, 'm'))[1];
    if (block === undefined) {
      violations.push({
        rule: 'C-04',
        message: `test.yml has no job \`${job}\`. If it was renamed, update GATED_JOBS here too.`,
      });
      continue;
    }
    // Only the job's own header, before its first step list.
    const header = block.split(/^\s{4}steps:/m)[0];
    if (!/^\s*if:\s*inputs\.run_e2e\s*$/m.test(header)) {
      violations.push({
        rule: 'C-04',
        message:
          `\`${job}\` is not gated on \`if: inputs.run_e2e\`. Either restore the guard or drop ` +
          'it from GATED_JOBS deliberately — an ungated job just always runs, which is safe but ' +
          'means the bypass no longer does what its comments claim.',
      });
    }
  }

  // C-05 — a caller that forgets the input must get the whole suite.
  const inputBlock = testBody.split(/^\s*run_e2e:\s*$/m)[1];
  if (!inputBlock || !/^\s*default:\s*true\s*$/m.test(inputBlock.split(/^\s{6}\w/m)[0] || '')) {
    violations.push({
      rule: 'C-05',
      message:
        '`run_e2e` in test.yml must declare `default: true`. A false or missing default means ' +
        'workflow_dispatch — and any future caller that forgets the input — silently runs no ' +
        'end-to-end tests at all.',
    });
  }

  return violations;
}

function main(argv) {
  const violations = checkCiGating();

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ violations }, null, 2));
    return violations.length === 0 ? 0 : 1;
  }

  if (violations.length === 0) {
    console.log('✅ E2E shard bypass intact — `app` is a negative list and every Cypress tier is gated.');
    return 0;
  }

  console.error(`❌ CI gating: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.message}\n`);
  }
  console.error('See docs/developer-guide/multi-agent-workflow.md § "Skipping the end-to-end tiers".');
  return 1;
}

module.exports = { checkCiGating, readAppFilter, GATED_JOBS };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
