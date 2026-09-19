import { describe, it, expect, vi, beforeEach } from 'vitest'

/*
 * Spec 008: the advisory sanctions screen must read the SanctionsGuard on the chain the entry
 * belongs to, never the build-time chain.
 *
 * It used to establish that by ASKING THE PROVIDER — `provider.getNetwork()` — which got the
 * right answer for the wrong reason: the chain came off whatever connection was passed, so the
 * guard that answered was a property of the transport rather than of the address being screened.
 * Since spec 110 the caller NAMES the chain, so this asserts the stronger thing: the named chain
 * decides, and a provider claiming to be somewhere else cannot move it.
 */
const { resolver } = vi.hoisted(() => ({ resolver: vi.fn(() => undefined) }))
vi.mock('../config/contracts', () => ({
  getContractAddress: vi.fn(() => undefined),
  getContractAddressForChain: resolver,
}))

import { screenAddress } from '../utils/sanctionsScreen.js'

const ADDR = '0x0000000000000000000000000000000000000abc'

describe('sanctionsScreen — chain-aware resolution', () => {
  beforeEach(() => resolver.mockClear())

  it('resolves sanctionsGuard for the chain the CALLER named', async () => {
    const res = await screenAddress(ADDR, {}, 137)
    expect(resolver).toHaveBeenCalledWith('sanctionsGuard', 137)
    // No guard on this chain -> fail-closed (it cannot be screened, so it is not "clear").
    expect(res).toEqual({ allowed: false, available: false })
  })

  it('ignores what the provider claims its network is', async () => {
    // A provider that would have answered 1 under the old inference. The named chain wins:
    // the guard that enforces an entry is decided by the entry's chain, not by the wire.
    const lyingProvider = { getNetwork: async () => ({ chainId: 1n }) }
    await screenAddress(ADDR, lyingProvider, 137)
    expect(resolver).toHaveBeenCalledWith('sanctionsGuard', 137)
    expect(resolver).not.toHaveBeenCalledWith('sanctionsGuard', 1)
  })

  it('fails closed with no read connection, whatever chain was named', async () => {
    expect(await screenAddress(ADDR, null, 137)).toEqual({ allowed: false, available: false })
  })
})
