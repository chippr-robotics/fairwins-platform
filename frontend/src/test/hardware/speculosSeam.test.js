/**
 * The emulator rail must be unreachable in a shipped build — spec 085/110.
 *
 * `speculosTransport.js` aims device signing at an arbitrary HTTP origin. That is exactly what
 * makes it useful in a test and exactly what must never exist in a production bundle: a member's
 * signing session pointed somewhere they did not choose. The protection is that every path to it
 * sits inside an `import.meta.env.DEV` branch, which Vite replaces with `false` and dead-code
 * eliminates — the same rule the `window.__fwHardwareTestAdapter__` seam already lives under.
 *
 * A guard is only worth having if it fails, so this asserts the STRUCTURE rather than trusting a
 * convention: every module that names the transport must gate it, and no shipped surface may
 * import it at all.
 *
 * AND STRUCTURE IS NOT ENOUGH, which was learned the expensive way. The seam's guard alone left
 * the rail IN the production bundle as its own chunk: `ledgerAdapter`'s branch tested a runtime
 * value (`requested === SPECULOS`) that the bundler cannot fold, so it kept the dynamic import
 * even though nothing could ever reach it. Every test here was green. Only `grep` over `dist`
 * showed it. So the constant is repeated inside that branch too, and `npm run check:no-emulator`
 * greps the build — a source-shaped test cannot see a bundler decision.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', '..'))

/** Every .js/.jsx under src, except the tests (which are never shipped). */
function sourceFiles(dir = SRC, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'test' || entry === '__tests__') continue
      sourceFiles(full, out)
    } else if (/\.jsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

const TRANSPORT = 'speculosTransport'

describe('the Speculos rail cannot reach a production bundle', () => {
  it('is imported only from the adapter that gates it', () => {
    const importers = sourceFiles()
      .filter((f) => !f.endsWith(`${TRANSPORT}.js`))
      .filter((f) => new RegExp(`['"\\./]${TRANSPORT}['"]`).test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))

    // Exactly one, and it is the vendor adapter — not a component, hook or context. A new importer
    // here is a new way for the rail to be reached, and must be justified rather than assumed.
    expect(importers).toEqual(['lib/hardware/ledgerAdapter.js'])
  })

  it('gates every selection of the rail behind import.meta.env.DEV', () => {
    for (const file of ['lib/hardware/adapters.js', 'lib/hardware/ledgerAdapter.js']) {
      const source = readFileSync(join(SRC, file), 'utf8')
      const mentions = source.split('\n').filter((l) => /TRANSPORT_KINDS\.SPECULOS/.test(l) && !/^\s*\/[/*]/.test(l) && !/^\s*\*/.test(l))
      expect(mentions.length, `${file} should mention the rail in code`).toBeGreaterThan(0)
    }
    // The seam is where the decision is made, and it is the one that must carry the guard: nothing
    // reaches `ledgerAdapter`'s branch except through it.
    const seam = readFileSync(join(SRC, 'lib/hardware/adapters.js'), 'utf8')
    expect(seam).toMatch(/import\.meta\.env\.DEV && transport === TRANSPORT_KINDS\.SPECULOS/)
  })

  it('never selects the emulator from a capability probe', async () => {
    const { ledgerTransportKind, vendorAvailability, TRANSPORT_KINDS } = await import('../../lib/hardware/adapters')
    // Every combination a browser can present — none of them may resolve to the emulator, which is
    // what keeps it something a caller must ASK for by name.
    for (const webhid of [true, false]) {
      for (const webusb of [true, false]) {
        for (const webble of [true, false]) {
          const transports = { webhid, webusb, webble }
          expect(ledgerTransportKind(transports)).not.toBe(TRANSPORT_KINDS.SPECULOS)
          expect(vendorAvailability('ledger', transports).transport).not.toBe(TRANSPORT_KINDS.SPECULOS)
        }
      }
    }
  })
})
