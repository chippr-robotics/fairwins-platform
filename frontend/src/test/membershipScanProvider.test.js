/**
 * An event-log scan must never run on the browser wallet's provider.
 *
 * `readProviderFor` prefers the injected wallet provider whenever the scope IS the connected
 * chain. For a point `eth_call` that is right and cheap. For `eth_getLogs` over history it is
 * wrong: the transport then belongs to MetaMask/Brave, whose RPC is typically a free pruned node,
 * and the admin membership scan on Polygon failed with
 *
 *   "History has been pruned for this block"
 *
 * which no amount of member RPC configuration could fix — the configured endpoint was never
 * consulted. `scanProviderFor` always resolves through `getReadProvider`, which is where the
 * member's own archival endpoint (QuickNode etc.) and its credential header live (spec 069), and
 * the only place such a credential CAN live: a credentialed URL in a `VITE_` variable ships in
 * the public bundle (spec 097).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ asked: [], provider: { kind: 'configured-read-endpoint' } }))

vi.mock('../utils/rpcProvider', () => ({
  getReadProvider: (chainId) => {
    m.asked.push(chainId)
    return m.provider
  },
}))

import { scanProviderFor, readProviderFor } from '../lib/chains/estate'
import { cohortChainIds } from '../config/networks'
import { describeScanFailure } from '../hooks/useMembershipTreasuryStats'

const COHORT_CHAIN = cohortChainIds()[0]
const WALLET_PROVIDER = { kind: 'injected-wallet' }

beforeEach(() => {
  m.asked = []
})

describe('scanProviderFor — the scan never inherits the wallet transport', () => {
  it('resolves the configured read endpoint for the chain', () => {
    expect(scanProviderFor(COHORT_CHAIN)).toBe(m.provider)
    expect(m.asked).toEqual([COHORT_CHAIN])
  })

  it('does NOT hand back the wallet provider even on the connected chain', () => {
    // The contrast that IS the bug: same chain, same wallet, two different answers. The left one
    // is what the scan used to get.
    expect(readProviderFor(COHORT_CHAIN, COHORT_CHAIN, WALLET_PROVIDER)).toBe(WALLET_PROVIDER)
    expect(scanProviderFor(COHORT_CHAIN)).not.toBe(WALLET_PROVIDER)
  })

  it('returns null rather than throwing when the chain has no endpoint', () => {
    // Callers report that as `unreadable`; a throw would take the whole panel down.
    const OUT_OF_COHORT = 999_999
    expect(scanProviderFor(OUT_OF_COHORT)).toBeNull()
  })
})

describe('describeScanFailure — a pruned endpoint is actionable, not a JSON dump', () => {
  it('names the cause and the fix for a pruned-history refusal', () => {
    const err = new Error(
      'could not coalesce error (error={ "code": -32701, "message": "History has been pruned for ' +
        'this block. To remove restrictions, order a dedicated full node here: ' +
        'https://www.allnodes.com/pol/host" }, payload={ "method": "eth_getLogs" })',
    )
    const out = describeScanFailure(err)
    expect(out).toMatch(/does not keep enough history/i)
    expect(out).toMatch(/archival/i)
    expect(out).toMatch(/Settings ▸ Network/)
    // The raw text still rides along — a failure nobody can diagnose is its own problem.
    expect(out).toMatch(/History has been pruned/)
  })

  it('matches on the condition, not one vendor’s wording', () => {
    expect(describeScanFailure({ message: 'missing trie node', code: -32000 })).toMatch(/archival/i)
    expect(describeScanFailure({ message: 'nope', error: { code: '-32701' } })).toMatch(/archival/i)
  })

  it('leaves an unrelated failure exactly as it came', () => {
    // Rewriting every error into "configure an archival endpoint" would send an operator chasing
    // an RPC setting over a bug in the scan.
    expect(describeScanFailure(new Error('network timeout'))).toBe('network timeout')
  })
})
