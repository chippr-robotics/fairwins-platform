import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the address resolver + the chain read seam (spec 110 Phase 1) so we can drive
// resolve/callsignOf return values.
const mockResolve = vi.fn()
const mockCallsignOf = vi.fn()

vi.mock('../../../config/contracts', () => ({
  getContractAddressForChain: (name) => (name === 'callsignRegistry' ? '0x00000000000000000000000000000000000000AA' : undefined),
}))

vi.mock('../../chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (_chainId, { functionName, args = [] }) => {
      if (functionName === 'resolve') return mockResolve(...args)
      if (functionName === 'callsignOf') return mockCallsignOf(...args)
      throw new Error('unmocked read: ' + functionName)
    },
  }
})

import { resolveCallsign, lookupCallsignOf, isResolvableForValue, CallsignStatus } from '../resolveCallsign'

const provider = {} // opaque; the mocked Contract ignores it
const opts = { provider, chainId: 137 }
const ACTIVE = {
  owner: '0x1111111111111111111111111111111111111111',
  callsign: 'chipprbots',
  status: 1n,
  verified: true,
  pendingOwner: '0x0000000000000000000000000000000000000000',
  repointEffectiveAt: 0n,
  quarantinedUntil: 0n,
}

beforeEach(() => {
  mockResolve.mockReset()
  mockCallsignOf.mockReset()
})

describe('resolveCallsign', () => {
  it('forward-resolves a valid callsign to owner + ACTIVE status', async () => {
    mockResolve.mockResolvedValue(ACTIVE)
    const info = await resolveCallsign('%ChipprBots', opts)
    expect(info.address).toBe(ACTIVE.owner)
    expect(info.status).toBe(CallsignStatus.ACTIVE)
    expect(isResolvableForValue(info)).toBe(true)
    // normalized before the call
    expect(mockResolve).toHaveBeenCalledWith('chipprbots')
  })

  it('returns null for a non-callsign input (e.g. a 42-char address) without calling the contract', async () => {
    const info = await resolveCallsign('0x1234567890abcdef1234567890abcdef12345678', opts)
    expect(info).toBeNull()
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('soft-fails to null when the contract read throws (FR-013)', async () => {
    mockResolve.mockRejectedValue(new Error('rpc down'))
    expect(await resolveCallsign('chipprbots', opts)).toBeNull()
  })

  it('non-ACTIVE status is not resolvable for value', async () => {
    mockResolve.mockResolvedValue({ ...ACTIVE, status: 3n }) // QUARANTINED
    const info = await resolveCallsign('chipprbots', opts)
    expect(info.status).toBe(CallsignStatus.QUARANTINED)
    expect(isResolvableForValue(info)).toBe(false)
  })
})

describe('lookupCallsignOf', () => {
  it('returns the active callsign + verification for an address', async () => {
    mockCallsignOf.mockResolvedValue('chipprbots')
    mockResolve.mockResolvedValue(ACTIVE)
    const res = await lookupCallsignOf(ACTIVE.owner, opts)
    expect(res).toEqual({ callsign: 'chipprbots', verified: true })
  })

  it('returns null when the address has no active callsign', async () => {
    mockCallsignOf.mockResolvedValue('')
    expect(await lookupCallsignOf(ACTIVE.owner, opts)).toBeNull()
  })

  it('soft-fails to null on read error', async () => {
    mockCallsignOf.mockRejectedValue(new Error('rpc down'))
    expect(await lookupCallsignOf(ACTIVE.owner, opts)).toBeNull()
  })
})
