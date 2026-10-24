import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The ambient-chain ban (spec 110 Phase 3 — issue #1594, defect #1030).
 *
 * `useChainId()` reads wagmi's `config.state.chainId`, and wagmi only ever writes a CONFIGURED
 * chain there — so with the member's wallet on a chain absent from `src/wagmi.js`, it keeps
 * reporting the previous configured one. Measured with the wallet on BNB: the app displayed
 * "Polygon", raised no warning, and pointed every read at Polygon.
 *
 * WHY A TEST BESIDE THE LINT RULE, rather than the rule alone. The eslint ban rides inside the
 * existing `no-restricted-imports` rule, because flat config REPLACES a rule rather than merging
 * it — a second block would have switched the ethers ban off for every file it matched. That rule
 * carries `ETHERS_ALLOWLIST` in its `ignores`, so those 15 files are exempt from everything in it,
 * this ban included. `src/test/**` is exempt too. This test has no such holes: it walks the whole
 * tree, tests and all.
 *
 * The one legitimate consumer is nothing: `useWalletChainId` reads `useAccount().chainId` and
 * falls back to the BUILD's own `getCurrentChainId()`, never to wagmi's default chain (which is
 * `chains[0]` = Polygon, a MAINNET chain even in a testnet build).
 *
 * SHIPPED source only. A test that stubs the wagmi module may name `useChainId` in its mock
 * factory, and that is not the app reading an ambient chain — it is a fake being complete about
 * the module it replaces. What this test adds over the lint rule is the ETHERS_ALLOWLIST files,
 * which ship and which the rule cannot see.
 */

// vitest runs with cwd = frontend (the workspace member root)
const SRC = join(process.cwd(), 'src')

/** `import { …, useChainId, … } from 'wagmi'` in any spelling the codebase could use. */
const IMPORTS_USE_CHAIN_ID = /import\s*\{[^}]*\buseChainId\b[^}]*\}\s*from\s*['"]wagmi['"]/

const isTestPath = (p) => p.includes(`${sep}test${sep}`) || p.includes(`${sep}__tests__${sep}`)

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (!isTestPath(`${p}${sep}`)) walk(p, out)
    } else if (/\.(js|jsx)$/.test(name) && !isTestPath(p)) {
      out.push(p)
    }
  }
  return out
}

describe('the ambient chain is banned (spec 110 Phase 3)', () => {
  const files = walk(SRC)

  it('walks a tree that actually contains the app', () => {
    // Guards the guard: a walk that found nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((f) => f.endsWith(join('hooks', 'useWalletChainId.js')))).toBe(true)
  })

  it('no file imports useChainId from wagmi — not even the ones eslint exempts', () => {
    const offenders = files
      .filter((f) => IMPORTS_USE_CHAIN_ID.test(readFileSync(f, 'utf8')))
      .map((f) => relative(process.cwd(), f))
    expect(
      offenders,
      'useWalletChainId() answers where the wallet is; a write\'s target chain comes from the action',
    ).toEqual([])
  })

  it('useWalletChainId takes the wallet chain from the connection and falls back to the BUILD default', () => {
    const src = readFileSync(join(SRC, 'hooks', 'useWalletChainId.js'), 'utf8')
    // The connection's chainId is written verbatim by the connector's `chainChanged` handler;
    // wagmi's config chain is filtered to configured chains and is the whole defect.
    expect(src).toMatch(/useAccount\(\)/)
    expect(src).toMatch(/getCurrentChainId\(\)/)
    // If this hook ever reaches for wagmi's chain again, the ban has a hole shaped like its one
    // sanctioned consumer.
    expect(IMPORTS_USE_CHAIN_ID.test(src)).toBe(false)
  })
})
