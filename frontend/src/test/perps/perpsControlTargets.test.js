/**
 * The 36px touch-target floor on the Perps market controls (issue #1440).
 *
 * `Perps.css` states in prose that every interactive target in the controls block clears 36px. It
 * said so while the venue pills were 32px and the sort select declared no floor at all — a comment
 * making a claim about four selectors, checked by nobody, which is exactly how the claim and the
 * code came apart in the first place. This reads the stylesheet and holds them to it.
 *
 * A text parse rather than a rendered assertion: jsdom applies no stylesheet, so a component test
 * would report every height as zero and pass for the wrong reason.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The idiom the brand guards use (`src/test/brand/noHardcodedColors.test.js`) — a `new URL()`
// against `import.meta.url` does not survive vitest's transform here.
const __dirname = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(resolve(__dirname, '../../components/perps/Perps.css'), 'utf8')

/** Every control a member taps in the Perps controls block, with the floor it must declare. */
const TARGETS = [
  ['.perps-search input', 36],
  ['.perps-filter-toggle', 36],
  ['.perps-filter-pill', 36],
  ['.perps-sort select', 36],
]

function declaredMinHeight(selector) {
  // The rule body for exactly this selector (selectors here are one-per-rule, flat and unnested).
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`(^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(CSS)
  if (!rule) return null
  const found = /min-height:\s*(\d+(?:\.\d+)?)px/.exec(rule[2])
  return found ? Number(found[1]) : null
}

describe('Perps market controls keep a 36px touch-target floor', () => {
  it.each(TARGETS)('%s declares a min-height of at least %ipx', (selector, floor) => {
    const declared = declaredMinHeight(selector)
    // null, not 0: a rule that declares no floor is a different failure from one that declares a
    // small floor, and the message should say which.
    expect(declared, `${selector} declares no min-height`).not.toBeNull()
    expect(declared).toBeGreaterThanOrEqual(floor)
  })
})
