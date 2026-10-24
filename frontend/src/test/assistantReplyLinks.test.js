/**
 * In-app links inside an assistant reply (spec 095).
 *
 * The allow-list is the security property: a model can emit any string, so a path that is not a
 * route this app serves must stay inert text rather than become a link. It is still SHOWN — hiding
 * what the assistant said would be its own dishonesty — it simply is not pressable.
 */
import { describe, it, expect } from 'vitest'
import { extractInAppLinks } from '../lib/assistant/replyLinks'

const paths = (text) => extractInAppLinks(text).map((l) => l.path)

describe('extractInAppLinks', () => {
  it('finds the in-app paths the gateway prompt tells the assistant to use', () => {
    expect(paths('Lending lives at /wallet?tab=earn and the catalog is at /apps.')).toEqual([
      '/wallet?tab=earn',
      '/apps',
    ])
  })

  it('keeps a card deep link intact, hash and all', () => {
    expect(paths('Open /wallet?tab=settings#api-access to create one.')).toEqual([
      '/wallet?tab=settings#api-access',
    ])
  })

  it('trims sentence punctuation but not path characters', () => {
    expect(paths('Try /wallet?tab=trade&view=perps.')).toEqual(['/wallet?tab=trade&view=perps'])
    expect(paths('(see /privacy)')).toEqual(['/privacy'])
  })

  it('de-duplicates and preserves order', () => {
    expect(paths('/app then /wallet then /app again')).toEqual(['/app', '/wallet'])
  })

  it('ignores a path this app does not route — it stays plain text, never a link', () => {
    expect(paths('Go to /admin-secret or /etc/passwd or /not-a-route')).toEqual([])
  })

  it('never produces an off-origin link, whatever the model writes', () => {
    expect(paths('Visit https://evil.example/wallet?tab=earn now')).toEqual([])
    expect(paths('Visit //evil.example/app')).toEqual([])
  })

  it('trims a whole run of trailing punctuation, not just the last character', () => {
    expect(paths('Open /apps!!!')).toEqual(['/apps'])
    expect(paths('(see /privacy).')).toEqual(['/privacy'])
  })

  it('stays linear on a reply built to make punctuation trimming backtrack', () => {
    // A long run of dots that never ends the match is the rejecting input a
    // `replace(/[.,;:!?)\]}'"`]+$/, '')` costs quadratic time on. The text here is a model's
    // reply — the least controlled string this app renders — so the trim has to be a single pass.
    const hostile = (n) => `/wallet?q=${'.'.repeat(n)}x`
    expect(paths(hostile(50))).toEqual([hostile(50)])

    const elapsed = (n) => {
      const started = performance.now()
      extractInAppLinks(hostile(n))
      return performance.now() - started
    }
    // Best-of-5: a single-shot reading is at the mercy of a GC pause or JIT tier-up on a busy CI
    // runner, and one 1.5ms hiccup fails a linearity claim the code actually satisfies. The
    // minimum over several runs discards hiccups while still rejecting a quadratic trim, whose
    // *floor* for 4x the input is ~16x the time.
    const best = (n) => Math.min(...Array.from({ length: 5 }, () => elapsed(n)))
    elapsed(2000) // warm up
    const small = Math.max(best(20000), 0.05)
    const large = best(80000)
    expect(large).toBeLessThan(small * 8)
  })

  it('handles empty and non-string input', () => {
    expect(extractInAppLinks('')).toEqual([])
    expect(extractInAppLinks(null)).toEqual([])
    expect(extractInAppLinks(42)).toEqual([])
  })
})
