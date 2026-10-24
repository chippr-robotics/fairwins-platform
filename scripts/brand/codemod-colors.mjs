#!/usr/bin/env node
/**
 * One-shot color codemod for spec 090 (Chippr brand alignment).
 *
 * WHY THIS EXISTS
 * The FairWins app stated color values inline in 74 CSS files — 686 hex
 * literals and 169 rgba() brand triples, 447 of them #36B37E alone. A palette
 * change that only edits theme.css would therefore land on almost nothing: the
 * app would render teal tokens next to hardcoded green, which is worse than not
 * rebranding at all.
 *
 * THE RULE
 * A color literal that exactly equals the CURRENT value of a theme token is
 * replaced by `var(--that-token)`. Exact match only — no fuzzy or
 * nearest-color mapping, because "close to the old secondary text grey" is a
 * judgement call and this script does not make judgement calls.
 *
 * THEME SCOPING
 * Some literals are ambiguous: #1F2933 was BOTH the light --text-primary and
 * the dark --surface-color. Those are resolved by where they sit — inside a
 * `.theme-dark` rule they mean the dark token, outside one they mean the light
 * token. A dark-only literal appearing outside a dark scope is REPORTED for
 * human review, never guessed at.
 *
 * This script is committed rather than run-and-discarded so the sweep is
 * reproducible and reviewable. It is idempotent: re-running finds nothing.
 *
 * Usage:
 *   node scripts/brand/codemod-colors.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../..')
const DRY_RUN = process.argv.includes('--dry-run')

// ---------------------------------------------------------------------------
// Mapping tables — see specs/090-chippr-brand-alignment/data-model.md
// ---------------------------------------------------------------------------

/**
 * Literals that mean the same token regardless of theme scope. The tokens
 * themselves are theme-aware, so replacing these also FIXES surfaces that were
 * previously stuck on a light-theme color in dark mode.
 */
const UNIVERSAL = {
  // Outgoing brand hues (banned by src/test/brand/noLegacyBrandColors.test.js)
  '#36B37E': '--brand-primary',
  '#2FA043': '--brand-primary',        // retired 2017 Chippr green
  '#4C9AFF': '--brand-secondary',
  '#4A9EFF': '--brand-secondary',
  '#7BDCB5': '--brand-accent',
  '#2F9E6E': '--primary-button-hover',
  '#45C492': '--primary-button',
  '#5ED6A6': '--primary-button-hover',

  // Light neutrals (exact restatements of tokens whose values this spec moves)
  '#F7F9FA': '--bg-primary',
  '#F3F4F6': '--bg-tertiary',
  '#5A6772': '--text-secondary',
  '#8A959E': '--text-muted',
  '#E3E7EB': '--border-color',

  // Status — the tokens are theme-aware, the old literals were not
  '#22C55E': '--success-color',
  '#2ECC71': '--success-color',
  '#F59E0B': '--warning-color',
  '#F5A623': '--warning-color',
  '#DC2626': '--danger-color',
  '#E5533D': '--danger-color',
  '#3B82F6': '--info-color',
  '#FEF3C7': '--warning-bg',
  '#78350F': '--warning-text',
}

/**
 * Literals whose meaning depends on theme scope. `light` is used outside a
 * `.theme-dark` rule, `dark` inside one. A null side means "this value never
 * legitimately appears in that scope" — report instead of rewriting.
 */
const SCOPED = {
  '#1F2933': { light: '--text-primary', dark: '--surface-color' },
  '#0E141B': { light: null, dark: '--bg-primary' },
  '#141C24': { light: null, dark: '--bg-secondary' },
  '#26323D': { light: null, dark: '--bg-tertiary' },
  '#E6EDF3': { light: null, dark: '--text-primary' },
  '#AAB6C2': { light: null, dark: '--text-secondary' },
  '#7A8590': { light: null, dark: '--text-muted' },
  '#23303D': { light: null, dark: '--border-color' },
}

/**
 * rgba() triples → the matching -rgb token.
 *
 * The status triples were added in round 2 of the screenshot loop. They are the
 * TINT form of the status colours — `rgba(34, 197, 94, 0.1)` behind a success
 * chip — and they are invisible to a hex scan, so 38 bright Tailwind-green
 * surfaces survived the first sweep and photographed as leftover green next to
 * the teal. A tint is as much a brand colour as a fill.
 */
const RGB_TRIPLES = {
  // brand
  '54,179,126': '--brand-primary-rgb',
  '76,154,255': '--brand-secondary-rgb',
  '123,220,181': '--brand-accent-rgb',
  // success (Tailwind green-500/emerald-500, chakra green, and the old mid-green)
  '34,197,94': '--success-color-rgb',
  '16,185,129': '--success-color-rgb',
  '72,187,120': '--success-color-rgb',
  '45,122,79': '--success-color-rgb',
  '46,204,113': '--success-color-rgb',
  '59,156,120': '--success-color-rgb',
  '0,184,148': '--success-color-rgb',
  // danger
  '229,83,61': '--danger-color-rgb',
  '239,68,68': '--danger-color-rgb',
  '220,38,38': '--danger-color-rgb',
  '220,53,69': '--danger-color-rgb',
  // warning / amber
  '245,158,11': '--warning-color-rgb',
  '245,166,35': '--warning-color-rgb',
  '255,193,7': '--warning-color-rgb',
  '255,152,0': '--warning-color-rgb',
  // info
  '59,130,246': '--info-color-rgb',
  '66,153,225': '--info-color-rgb',
}

const CSS_ROOT = 'frontend/src'
// Path prefixes, matched against the repo-relative path.
const EXCLUDE = [
  'frontend/src/theme.css',   // the source of truth — it STATES the values
  'frontend/src/test/',       // fixtures may name old values while describing history
]

/**
 * Minimal recursive file walk. Deliberately not `glob`: this repo's dependency
 * hygiene gate (spec 075 FR-003) rejects a package that resolves only through
 * npm hoisting, and a ten-line walker is not worth a lockfile re-resolve.
 */
function walkCss(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      walkCss(full, out)
    } else if (entry.name.endsWith('.css')) {
      out.push(full)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Scope-aware rewriting
// ---------------------------------------------------------------------------

/**
 * Split CSS into segments, each tagged with whether it sits inside a
 * `.theme-dark` rule. Tracks a prelude stack so nesting (@media wrapping a
 * .theme-dark rule, or the reverse) resolves correctly — a flat regex over
 * rule bodies gets this wrong the moment a media query is involved.
 */
function segments(css) {
  const out = []
  const stack = []
  let preludeStart = 0
  let i = 0
  let chunkStart = 0

  const isDark = () => stack.some((p) => p.includes('.theme-dark'))
  const push = (end) => {
    if (end > chunkStart) out.push({ text: css.slice(chunkStart, end), dark: isDark() })
    chunkStart = end
  }

  while (i < css.length) {
    const c = css[i]
    if (c === '{') {
      push(i + 1)
      stack.push(css.slice(preludeStart, i))
      preludeStart = i + 1
      i++
    } else if (c === '}') {
      push(i + 1)
      stack.pop()
      preludeStart = i + 1
      i++
    } else {
      i++
    }
  }
  push(css.length)
  return out
}

/**
 * Tokens theme.css actually defines. A `var(--x, #fallback)` whose token is
 * defined can never reach its fallback, so the literal is dead code — and it is
 * dead code that reads like a live color, which is why so many dark-theme
 * values appear outside dark rules. Dropping it is a rewrite, not a guess.
 */
const DEFINED_TOKENS = new Set(
  Array.from(
    readFileSync(resolve(REPO, 'frontend/src/theme.css'), 'utf8').matchAll(/(--[\w-]+)\s*:/g),
    (m) => m[1]
  )
)

function dropDeadFallbacks(text) {
  let out = text.replace(
    /var\(\s*(--[\w-]+)\s*,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^()]*\))\s*\)/g,
    (match, token, fallback) => {
      if (!DEFINED_TOKENS.has(token)) return match
      // ANY colour literal here is unreachable, so dropping it cannot change a
      // rendered pixel — and leaving it is how off-palette colour hides. Round 1
      // of the screenshot loop found `var(--color-success, #15803d)` rendering a
      // bright green next to the teal, because the token was undefined; once
      // defined, the same literal becomes a lie that reads like a value.
      // Non-colour fallbacks (lengths, keywords) are left alone.
      return `var(${token})`
    }
  )

  // The -rgb tokens take a BARE triple as their fallback —
  // `rgba(var(--brand-primary-rgb, 54, 179, 126), 0.1)`. It reads as three
  // fallback arguments rather than one value, so the pattern above skips it,
  // and it was the single most common surviving form after the first sweep.
  out = out.replace(
    /var\(\s*(--[\w-]+)\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/g,
    (match, token, r, g, b) => {
      if (!DEFINED_TOKENS.has(token)) return match
      return RGB_TRIPLES[`${r},${g},${b}`] ? `var(${token})` : match
    }
  )

  return out
}

function rewriteSegment(text, dark, report) {
  let out = dropDeadFallbacks(text)

  // Hex literals. Case-insensitive; the word boundary stops #36B37E00 (an
  // 8-digit alpha hex) from being partially eaten.
  out = out.replace(/#[0-9a-fA-F]{6}\b/g, (literal) => {
    const key = literal.toUpperCase()
    if (UNIVERSAL[key]) return `var(${UNIVERSAL[key]})`
    if (SCOPED[key]) {
      const token = dark ? SCOPED[key].dark : SCOPED[key].light
      if (token) return `var(${token})`
      report.push({ literal: key, scope: dark ? 'dark' : 'light' })
      return literal
    }
    return literal
  })

  // rgba()/rgb() brand triples.
  out = out.replace(
    /\brgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*([,)])/g,
    (match, r, g, b, tail) => {
      const token = RGB_TRIPLES[`${r},${g},${b}`]
      if (!token) return match
      const prefix = match.trimStart().startsWith('rgba') ? 'rgba(' : 'rgb('
      return `${prefix}var(${token})${tail}`
    }
  )

  return out
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const files = walkCss(resolve(REPO, CSS_ROOT))
  .filter((f) => !EXCLUDE.some((e) => relative(REPO, f) === e || relative(REPO, f).startsWith(e)))
  .sort()

let totalReplaced = 0
let filesChanged = 0
const needsReview = []

for (const file of files) {
  const rel = relative(REPO, file)
  const before = readFileSync(file, 'utf8')
  const report = []
  const after = segments(before)
    .map((s) => rewriteSegment(s.text, s.dark, report))
    .join('')

  if (report.length) {
    needsReview.push({ rel, items: report })
  }
  if (after === before) continue

  // Count literals actually removed. Counting new `var(--` occurrences would
  // undercount: dropping a dead fallback removes a literal without adding a
  // var(), and a report that understates its own effect is not much of a report.
  const countLiterals = (s) => {
    const hex = (s.match(/#[0-9a-fA-F]{6}\b/g) || []).filter(
      (h) => UNIVERSAL[h.toUpperCase()] || SCOPED[h.toUpperCase()]
    ).length
    const rgb = Object.keys(RGB_TRIPLES).reduce(
      // RGB_TRIPLES keys are `d,d,d` — digits and commas only, so they carry no regex
      // metacharacter and need no escaping. `s` has had its whitespace stripped, so the
      // commas match literally.
      (n, t) => n + (s.replace(/\s+/g, '').match(new RegExp(t, 'g')) || []).length,
      0
    )
    return hex + rgb
  }
  const added = countLiterals(before) - countLiterals(after)
  totalReplaced += added
  filesChanged++
  if (!DRY_RUN) writeFileSync(file, after)
  console.log(`  ${added.toString().padStart(4)}  ${rel}`)
}

console.log('')
console.log(`${DRY_RUN ? '[dry run] ' : ''}${totalReplaced} literal(s) tokenized across ${filesChanged} file(s) (of ${files.length} scanned).`)

if (needsReview.length) {
  console.log('')
  console.log('MANUAL REVIEW — a dark-theme value appearing outside a .theme-dark rule.')
  console.log('These are NOT rewritten: the script cannot tell whether the author meant the')
  console.log('dark token or picked the color by eye. Decide per site.')
  for (const { rel, items } of needsReview) {
    const counts = items.reduce((acc, i) => ({ ...acc, [i.literal]: (acc[i.literal] || 0) + 1 }), {})
    console.log(`  ${rel}`)
    for (const [literal, n] of Object.entries(counts)) console.log(`      ${literal} ×${n}`)
  }
  console.log('')
  console.log(`${needsReview.reduce((n, r) => n + r.items.length, 0)} site(s) need review.`)
}
