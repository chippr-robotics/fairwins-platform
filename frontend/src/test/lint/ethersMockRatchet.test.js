/**
 * A `vi.mock('ethers')` must still be guarding something (spec 110 T028).
 *
 * THE FAILURE THIS EXISTS FOR. Three files in a row this session had a test that mocked
 * `ethers.Contract` for a module that had just been converted to viem. The mock intercepted
 * nothing, and the only reason any of them failed loudly is that their assertions happened to read
 * the calls the fake recorded — a suite that merely rendered would have gone on passing while
 * testing nothing at all. That is standing lesson 2 of this migration, and it is exactly the shape
 * that survives review: the mock is still there, still named after the thing it used to do.
 *
 * Worse, each of those fakes stood in for `new ethers.Contract(address, abi, runner)` — a
 * constructor that IGNORES the address in every fake anybody writes. So in all three files a read
 * or write aimed at the WRONG CONTRACT would have passed every assertion. Replacing them with a
 * mock of the chain seam is what made the target assertable.
 *
 * THE RULE. A test that mocks `ethers` must import — statically or dynamically — at least one
 * module that is still on the ethers allowlist. If nothing it touches imports ethers any more,
 * the mock cannot be intercepting anything the subject does.
 *
 * It is deliberately a WEAK rule, because a strong one would be wrong: a test may legitimately
 * import several modules and mock ethers for only one of them, and transitive imports are not
 * followed. It catches the case that actually happened — the last ethers consumer in a file's
 * reach was converted and the mock was left behind — and stays quiet otherwise. A weak gate that
 * never cries wolf is worth more here than a strict one somebody would learn to suppress.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ETHERS_ALLOWLIST } from '../../../eslint-ethers-allowlist.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = normalize(join(HERE, '..', '..'))
const ROOT = normalize(join(SRC, '..'))

/**
 * Tests whose ethers mock is NOT for a module they import, each with the reason.
 *
 * Like the import allowlist, an entry here is a decision rather than pending work, and a wrong
 * reason on it is worse than an open task — it retires a check permanently. Keep it short.
 */
const EXEMPT = new Map([
  [
    'src/test/setup.js',
    'Global setup, not a test. Its MockBrowserProvider serves every suite that mounts ' +
      'WalletContext (still an ethers consumer), so it imports no subject of its own.',
  ],
])

/**
 * Source with comments removed.
 *
 * Without this the scan matches its own prose: every file that DOCUMENTS having replaced a
 * `vi.mock('ethers')` — including this one — would be reported as still having one. That is the
 * same false positive twice over, so the stripping is the first thing the scan does.
 */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(test|spec)\.jsx?$/.test(entry) || entry === 'setup.js') out.push(full)
  }
  return out
}

/** The full text of the `vi.mock(...)` call starting at `open` (the index of its `(`). */
function callText(source, open) {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

/**
 * Specifiers this file REPLACES outright — `vi.mock('…')` whose factory never reaches for the
 * real module (`importOriginal` / `vi.importActual`).
 *
 * A replaced module cannot be what an ethers mock is guarding: its own imports never run, so the
 * fact that IT imports ethers says nothing about the subject under test. Counting it was the hole
 * that let `src/test/wallet/useWrapNative.test.jsx` keep a dead `vi.mock('ethers')` — the hook had
 * moved to the chain seam, and the only allowlisted module the file named was
 * `utils/rpcProvider`, which the same file had entirely replaced.
 *
 * A PARTIAL mock (one that spreads `await importOriginal()`) still loads the real module and still
 * counts, which is why this is a property of the factory rather than of the `vi.mock` call.
 */
function replacedSpecifiers(source) {
  const replaced = new Set()
  const re = /vi\.mock\(\s*'(\.[^']+)'/g
  for (const m of source.matchAll(re)) {
    const open = source.indexOf('(', m.index)
    if (!/\bimportOriginal\b|\bimportActual\b/.test(callText(source, open))) replaced.add(m[1])
  }
  return replaced
}

/** Every local module a file pulls in — `from '…'`, `vi.mock('…')` and `await import('…')`. */
function localSpecifiers(source) {
  const specs = new Set()
  // Each pattern tolerates whitespace and NEWLINES around the specifier: a multi-line
  // `await import(\n  '../../utils/rpcProvider'\n)` is idiomatic here, and missing it made this
  // gate report its first false positive before it had found a single real one.
  for (const re of [
    /from\s+'(\.[^']+)'/g,
    /vi\.mock\(\s*'(\.[^']+)'/g,
    /\bimport\(\s*'(\.[^']+)'\s*\)/g,
  ]) {
    for (const m of source.matchAll(re)) specs.add(m[1])
  }
  // A module the file replaces outright is not one it reaches — unless it ALSO imports it for
  // real, which is how a test asserts against the unmocked original.
  const imported = new Set()
  for (const re of [/from\s+'(\.[^']+)'/g, /\bimport\(\s*'(\.[^']+)'\s*\)/g]) {
    for (const m of source.matchAll(re)) imported.add(m[1])
  }
  for (const spec of replacedSpecifiers(source)) {
    if (!imported.has(spec)) specs.delete(spec)
  }
  return specs
}

function resolveToRepoPath(fromFile, spec) {
  const base = normalize(join(dirname(fromFile), spec))
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, join(base, 'index.js')]) {
    try {
      if (statSync(candidate).isFile()) return relative(ROOT, candidate).split('\\').join('/')
    } catch {
      /* not this one */
    }
  }
  return null
}

describe('ethers mocks are not left on retired modules', () => {
  const allow = new Set(ETHERS_ALLOWLIST)
  const mockers = walk(SRC).filter((f) => /vi\.mock\(\s*'ethers'/.test(code(readFileSync(f, 'utf8'))))

  it('finds the mocks to check — a sweep over nothing would pass forever', () => {
    // If this ever hits zero the migration is done and this file can go, but silence must be a
    // fact rather than a broken glob.
    expect(mockers.length).toBeGreaterThan(0)
  })

  it('every `vi.mock(\'ethers\')` still reaches a module that imports ethers', () => {
    const orphans = []
    for (const file of mockers) {
      const rel = relative(ROOT, file).split('\\').join('/')
      if (EXEMPT.has(rel)) continue
      const source = code(readFileSync(file, 'utf8'))
      const subjects = [...localSpecifiers(source)]
        .map((spec) => resolveToRepoPath(file, spec))
        .filter(Boolean)
      if (!subjects.some((s) => allow.has(s))) orphans.push(rel)
    }
    expect(orphans, `These tests mock 'ethers' but reach no module that still imports it, so the mock intercepts nothing. Mock the chain seam instead (see MiniAppReviewTab/SubmitAppPanel/CallsignPanel for the shape), or add an entry to EXEMPT with the reason:\n  ${orphans.join('\n  ')}`).toEqual([])
  })

  it('has no stale EXEMPT entry — a reason must outlive nothing', () => {
    const stale = [...EXEMPT.keys()].filter((rel) => {
      try {
        return !/vi\.mock\(\s*'ethers'/.test(code(readFileSync(join(ROOT, rel), 'utf8')))
      } catch {
        return true
      }
    })
    expect(stale, 'These EXEMPT entries no longer mock ethers (or no longer exist) — delete them.').toEqual([])
  })
})
