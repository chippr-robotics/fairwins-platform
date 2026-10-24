#!/usr/bin/env node
/**
 * Spec registry gate (issue #1460).
 *
 * `specs/` is the shared namespace that several agents write into at the same time, and until this
 * gate existed nothing noticed when two of them claimed the same number. Five collisions reached an
 * integration branch that way — 017, 041, 050, 102 and 104 — each a pair of unrelated features
 * whose documents, branches and cross-references now disagree about what "spec 041" means.
 *
 * 104 is worth pausing on: it landed on `staging` on 2026-09-04 and 2026-09-05, i.e. WHILE this
 * gate was being written, from two agents neither of whom did anything wrong. That is the rate.
 *
 * The failure is structural, not careless. `create-new-feature.sh` answers "what is the next
 * number?" with `max(existing) + 1`, which is correct exactly once per merge: two agents who ask
 * before either has merged get the same answer, and both are right at the moment they ask. A
 * convention ("check first") cannot fix that, because both agents DID check.
 *
 * So the number is claimed by MERGING a reservation PR to `staging` (see
 * docs/developer-guide/multi-agent-workflow.md § Reserve the number), and this gate is what makes
 * the claim binding: the second PR to reach `staging` with the same number fails here instead of
 * merging quietly.
 *
 * Dependency-free by design — it reads directory names and one file per spec, nothing else — so it
 * runs in CI without `npm ci`, in the same tier as every other structural gate.
 *
 * Rules:
 *   S-01  No two spec directories share a numeric prefix.
 *   S-02  A spec directory is `NNN-kebab-case` (3+ digits), or is named in NON_NUMBERED.
 *   S-03  Every numbered spec directory contains a spec.md.
 *   S-04  The legacy-collision baseline is CLOSED: every entry must still describe a real
 *         collision, and no entry may be added. (Repo-tree rule — see `checkBaseline` below.)
 *
 * Usage: node scripts/specs/check-spec-registry.js [--json] [--specs-dir <path>]
 */

const fs = require('fs');
const path = require('path');

/**
 * Spec directories that legitimately carry no number. Keep this list tiny: a spec without a number
 * is a spec nobody can cite.
 */
const NON_NUMBERED = new Set(['design-prompts']);

/**
 * The collisions that predate this gate, frozen.
 *
 * "Predate" means the gate had not yet run on them, not that they are old: 104 was created while
 * this file was being written and was found by the gate's first CI run, on this very PR. Both 104
 * specs were already merged to `staging` with complete artifact sets, by two agents each of whom
 * had computed a correct next-number.
 *
 * These are NOT forgiven — they are recorded so the gate can go green on the tree as it stands
 * while still failing on the next one. Renumbering them is a separate, deliberate change owned by
 * whoever owns those specs: the numbers appear in CLAUDE.md, in docs/, in branch names and in
 * merged PR titles, and 102 in particular cannot simply be bumped to 103 because 103 is taken.
 * Whoever renumbers a pair deletes its entry here, and S-04 fails if an entry is left behind that
 * no longer collides — so the list shrinks and never silently rots.
 *
 * ADDING to this list is not a way to get CI green. Once this gate is on `staging`, S-01 fails
 * before a second claimant can merge, so a new entry could only ever describe a collision the gate
 * was never able to see — which, after it lands, is none.
 *
 * Each key is the shared number; the value is the exact set of directories that share it.
 */
const LEGACY_COLLISIONS = {
  '017': ['017-subgraph-v2-wager-transfers', '017-wager-grid-redesign'],
  '041': ['041-oracle-open-challenges', '041-passkey-wallet-login'],
  '050': ['050-earn-lending-rewards', '050-sponsored-paymaster'],
  '102': ['102-capacitor-channels', '102-multisig-chain-abstraction'],
  // Landed on `staging` 2026-09-04 / 2026-09-05, while this gate was in review (issue #1460).
  '104': ['104-guttertoken-assistant-rail', '104-passkey-account-recovery'],
};

const DIR_SHAPE = /^(\d{3,})-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function listSpecDirs(specsDir) {
  if (!fs.existsSync(specsDir)) return [];
  return fs
    .readdirSync(specsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Collect violations for a specs/ tree. Pure over the filesystem so the self-test can drive it.
 *
 * `checkBaseline` is off by default because S-04 is a statement about THIS repository's tree, not
 * about spec trees in general: a fixture that does not contain the frozen collisions is not
 * drifting from the baseline, it simply is not the baseline. Leaving it on by default made every
 * unrelated fixture fail with four S-04 violations, which is the classic gate-that-cries-wolf.
 */
function checkSpecRegistry(specsDir, { checkBaseline = false } = {}) {
  const violations = [];
  const dirs = listSpecDirs(specsDir);
  const byNumber = new Map();

  for (const name of dirs) {
    if (NON_NUMBERED.has(name)) continue;

    const match = DIR_SHAPE.exec(name);
    if (!match) {
      violations.push({
        rule: 'S-02',
        dir: name,
        message:
          `specs/${name} is not \`NNN-kebab-case\`. Either give it a reserved number or add it ` +
          'to NON_NUMBERED in scripts/specs/check-spec-registry.js with a reason.',
      });
      continue;
    }

    const number = match[1];
    if (!byNumber.has(number)) byNumber.set(number, []);
    byNumber.get(number).push(name);

    if (!fs.existsSync(path.join(specsDir, name, 'spec.md'))) {
      violations.push({
        rule: 'S-03',
        dir: name,
        message:
          `specs/${name} has no spec.md. A reserved number with no spec is indistinguishable ` +
          'from an abandoned one — reserve with the spec skeleton in the same PR.',
      });
    }
  }

  for (const [number, names] of [...byNumber.entries()].sort()) {
    if (names.length < 2) continue;

    const legacy = LEGACY_COLLISIONS[number];
    const isKnown =
      Array.isArray(legacy) &&
      legacy.length === names.length &&
      legacy.every((n) => names.includes(n));

    if (isKnown) continue;

    violations.push({
      rule: 'S-01',
      dir: names.join(', '),
      message:
        `Spec number ${number} is claimed by ${names.length} directories: ${names.join(', ')}. ` +
        'A number is claimed by MERGING its reservation PR to staging — rebase on staging and ' +
        'take the next free number (docs/developer-guide/multi-agent-workflow.md).',
    });
  }

  // S-04: the baseline is closed, so an entry that no longer collides must be deleted rather than
  // left as a standing exemption for a number that is now free.
  for (const [number, names] of checkBaseline ? Object.entries(LEGACY_COLLISIONS) : []) {
    const actual = byNumber.get(number) || [];
    const stillCollides =
      actual.length === names.length && names.every((n) => actual.includes(n));
    if (!stillCollides) {
      violations.push({
        rule: 'S-04',
        dir: names.join(', '),
        message:
          `LEGACY_COLLISIONS entry ${number} no longer describes the tree (expected ` +
          `${names.join(', ')}, found ${actual.join(', ') || 'nothing'}). If you renumbered it, ` +
          'delete the entry in scripts/specs/check-spec-registry.js.',
      });
    }
  }

  return violations;
}

function main(argv) {
  const jsonMode = argv.includes('--json');
  const dirFlag = argv.indexOf('--specs-dir');
  const specsDir =
    dirFlag !== -1 && argv[dirFlag + 1]
      ? path.resolve(argv[dirFlag + 1])
      : path.join(__dirname, '..', '..', 'specs');

  const violations = checkSpecRegistry(specsDir, { checkBaseline: true });

  if (jsonMode) {
    console.log(JSON.stringify({ specsDir, violations }, null, 2));
    return violations.length === 0 ? 0 : 1;
  }

  if (violations.length === 0) {
    const count = listSpecDirs(specsDir).length;
    console.log(`✅ Spec registry clean — ${count} spec directories, no number claimed twice.`);
    const legacy = Object.keys(LEGACY_COLLISIONS);
    if (legacy.length > 0) {
      console.log(
        `   Frozen pre-gate collisions still on record: ${legacy.join(', ')} ` +
          '(see LEGACY_COLLISIONS).',
      );
    }
    return 0;
  }

  console.error(`❌ Spec registry: ${violations.length} violation(s)\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.dir}`);
    console.error(`          ${v.message}\n`);
  }
  console.error('See docs/developer-guide/multi-agent-workflow.md for the reservation protocol.');
  return 1;
}

module.exports = { checkSpecRegistry, LEGACY_COLLISIONS, NON_NUMBERED, DIR_SHAPE };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
