/**
 * The game view is information BESIDE a market, never an input to an order (spec 115, FR-010; plan:
 * "a boundary test fails if that changes"). No ticket, plan, signing or trade module may import
 * `lib/sports/`, `hooks/useGameReading` or `components/predict/game/`.
 *
 * Imports are read the way test/miniapps/packageBoundary.test.js reads them: comments stripped first (so a
 * comment naming the path is not a violation), multi-line import statements spanned, dynamic imports and
 * re-exports included — a single-line regex there once let every multi-line import through.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'

const SRC = resolve(__dirname, '..', '..')

function stripComments(source) {
  let out = ''
  let i = 0
  let state = 'code'
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue }
      if (c === "'") state = 'single'
      else if (c === '"') state = 'double'
      else if (c === '`') state = 'template'
      out += c; i++; continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c } i++; continue }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue }
      if (c === '\n') out += c
      i++; continue
    }
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue }
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) state = 'code'
    out += c; i++
  }
  return out
}

function specifiers(source) {
  const code = stripComments(source)
  const found = []
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(code)) !== null) found.push(m[1])
  }
  return found
}

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}
const rel = (file) => relative(SRC, file).replace(/\\/g, '/')

/** Files that make, price, sign or track an order. */
const ORDER_PATH = [
  /^lib\/predict\/ticket[^/]*$/,
  /^lib\/predict\/clobSession\.js$/,
  /^hooks\/usePredictTrade\.js$/,
  /^hooks\/usePredictPlanTrade\.js$/,
  /^components\/predict\/Order[^/]*\.jsx$/,
  /^components\/predict\/TradeConfirm\.jsx$/,
]
/** What they must never reach. */
const GAME_TREE = [/^lib\/sports(\/|$)/, /^hooks\/use(Game|Fight)Reading(\.[jt]sx?)?$/, /^components\/predict\/game(\/|$)/]

const resolveSpec = (file, spec) => (spec.startsWith('.') ? rel(resolve(dirname(file), spec)) : null)

describe('no order path imports the game view', () => {
  const ordered = walk(SRC).filter((f) => ORDER_PATH.some((re) => re.test(rel(f))))

  it('finds the order modules it is guarding (a rename must not turn this into a vacuous pass)', () => {
    const names = ordered.map(rel)
    expect(names).toEqual(expect.arrayContaining([
      'lib/predict/clobSession.js',
      'hooks/usePredictTrade.js',
      'hooks/usePredictPlanTrade.js',
      'components/predict/TradeConfirm.jsx',
    ]))
    expect(names.some((n) => /^components\/predict\/Order/.test(n))).toBe(true)
    expect(names.some((n) => /^lib\/predict\/ticket/.test(n))).toBe(true)
  })

  it('none of them imports lib/sports, useGameReading, useFightReading or components/predict/game', () => {
    const offenders = []
    for (const file of ordered) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const target = resolveSpec(file, spec)
        if (target && GAME_TREE.some((re) => re.test(target))) offenders.push(`${rel(file)} → ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('and the game tree imports none of them (it reads nothing from the ticket either)', () => {
    const game = walk(SRC).filter((f) => GAME_TREE.some((re) => re.test(rel(f))) && /\.(js|jsx)$/.test(f))
    expect(game.length).toBeGreaterThan(5)
    const offenders = []
    for (const file of game) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const target = resolveSpec(file, spec)
        if (!target) continue
        const probe = target.replace(/\.(js|jsx)$/, '')
        if (ORDER_PATH.some((re) => re.test(target) || re.test(`${probe}.js`) || re.test(`${probe}.jsx`))) offenders.push(`${rel(file)} → ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the guarded tree includes the fight files (slice 3), so they cannot reach a ticket either', () => {
    const tree = walk(SRC).filter((f) => GAME_TREE.some((re) => re.test(rel(f)))).map(rel)
    expect(tree).toEqual(expect.arrayContaining([
      'lib/sports/fightReading.js',
      'lib/sports/fightFeed.js',
      'lib/sports/sportsRead.js',
      'hooks/useFightReading.js',
      'components/predict/game/FightView.jsx',
      'components/predict/game/FightFigures.jsx',
      'components/predict/game/FightResult.jsx',
    ]))
  })

  it('the detector sees a violation (multi-line, dynamic, re-export), so a pass means something', () => {
    const bad = [
      "import {\n  x,\n} from '../sports/gameReading'",
      "const m = await import('../../components/predict/game/GameView')",
      "export * from '../sports/gameFeed'",
    ]
    for (const src of bad) expect(specifiers(src).length).toBe(1)
    expect(specifiers("// import x from '../sports/gameReading'\n/* import y from '../sports/a' */")).toEqual([])
  })
})
