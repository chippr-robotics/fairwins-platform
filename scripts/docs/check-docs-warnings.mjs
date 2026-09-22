#!/usr/bin/env node
/**
 * The mkdocs --strict warning ratchet (issue #1617).
 *
 * `mkdocs build` runs in CI and in the Pages deploy WITHOUT `--strict`, so every broken
 * cross-reference in the documentation has been invisible: the build is green, the link is dead,
 * and the reader finds out. Turning `--strict` on outright is not available either — it exits
 * non-zero on the first warning, and there are 102 of them, so it would fail every PR from the
 * moment it landed and be switched off again within the day.
 *
 * So this is a RATCHET, the same shape as the ethers allowlist: the count may fall and may never
 * rise. A PR that adds a broken link fails. A PR that fixes one is told to lower the budget, so
 * the improvement is locked in rather than leaving headroom for the next regression. The budget
 * is a committed file, which means the number is reviewable and its history is the record of the
 * cleanup.
 *
 * COUNTING IS THE PART THAT IS EASY TO GET WRONG. `grep -c WARNING` reports 103, not 102,
 * because mkdocs echoes the nav tree and one documentation file is called
 * `research/FRIEND_MARKET_WARNING_UI.md` — the word appears in a FILENAME. A budget set from
 * that number is permanently one too generous, which is precisely the amount of slack a
 * regression needs. Only lines mkdocs emits as warnings count, and `parseWarnings` is unit-tested
 * against that filename so the miscount cannot come back.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const BUDGET_FILE = resolve(REPO, 'docs/.mkdocs-warning-budget')

/**
 * mkdocs writes one warning per line, prefixed `WARNING -`. Anchored at the start of the line so
 * a path, a heading or a quoted message that merely CONTAINS the word is not counted.
 *
 * @param {string} output  combined stdout+stderr of `mkdocs build --strict`
 * @returns {string[]} the warning lines, in order
 */
export function parseWarnings(output) {
  return String(output || '')
    .split('\n')
    .filter((line) => /^WARNING\s+-\s/.test(line))
}

/** The committed ceiling. Absent is a hard error: a missing budget must not read as "no limit". */
export function readBudget(file = BUDGET_FILE) {
  if (!existsSync(file)) {
    throw new Error(`No budget file at ${file}. Create it with the current warning count.`)
  }
  const raw = readFileSync(file, 'utf8')
  const n = Number(raw.trim().split('\n').filter((l) => !l.startsWith('#')).join('').trim())
  if (!Number.isInteger(n) || n < 0) throw new Error(`Budget file ${file} is not a count: ${raw}`)
  return n
}

/**
 * Compare a measured count against the budget.
 *
 * @returns {{ok: boolean, code: 'over'|'under'|'exact', message: string}}
 */
export function verdict(count, budget) {
  if (count > budget) {
    return {
      ok: false,
      code: 'over',
      message:
        `mkdocs --strict reports ${count} warnings; the budget is ${budget}.\n` +
        `This PR adds ${count - budget}. Fix the link(s) it broke — the budget only goes down.`,
    }
  }
  if (count < budget) {
    return {
      ok: false,
      code: 'under',
      message:
        `mkdocs --strict reports ${count} warnings, below the budget of ${budget}.\n` +
        `Lower the budget to ${count} (\`docs/.mkdocs-warning-budget\`, or run with --write) so the\n` +
        `improvement is locked in. Leaving headroom is how the count creeps back up.`,
    }
  }
  return { ok: true, code: 'exact', message: `mkdocs --strict: ${count} warnings, at budget.` }
}

function main() {
  const write = process.argv.includes('--write')
  const run = spawnSync('mkdocs', ['build', '--strict', '--site-dir', '/tmp/mkdocs-warning-check'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  if (run.error) {
    console.error(`Could not run mkdocs: ${run.error.message}`)
    console.error('Install it with: pip install -r requirements.txt')
    process.exit(2)
  }

  const warnings = parseWarnings(`${run.stdout || ''}\n${run.stderr || ''}`)
  const count = warnings.length
  const budget = readBudget()
  const result = verdict(count, budget)

  if (write && result.code === 'under') {
    writeFileSync(BUDGET_FILE, `${count}\n`)
    console.log(`Budget lowered to ${count}.`)
    process.exit(0)
  }

  // The offenders are printed on a rise, because "103 > 102" on its own tells nobody which link
  // to fix, and a gate that cannot be acted on is a gate that gets disabled.
  if (result.code === 'over') {
    console.error(result.message)
    console.error('\nAll current warnings:\n')
    for (const w of warnings) console.error(`  ${w}`)
    process.exit(1)
  }
  if (!result.ok) {
    console.error(result.message)
    process.exit(1)
  }
  console.log(result.message)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
