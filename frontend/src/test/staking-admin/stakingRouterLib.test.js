/**
 * Spec 066 (T019): the StakingRouter read layer safe-falls-back when no router is
 * deployed, normalizes the router's config when it is, and the liquid stake-call
 * builders encode the right calldata for the unified send rail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Interface } from 'ethers'
import { STAKING_ROUTER_ABI } from '../../abis/StakingRouter'

const m = vi.hoisted(() => ({ address: null, methods: {} }))

// The router reads ride the spec-110 chain seam — fake them there. The
// Interface/decode assertions below stay real ethers (cross-library byte parity).
vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (_chainId, { functionName, args }) => {
      const f = m.methods[functionName]
      if (!f) throw new Error('unmocked method: ' + functionName)
      return f(...(args || []))
    },
  }
})

vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: vi.fn(() => m.address),
}))

import {
  getStakingRouterAddress,
  readStakingRouterConfig,
  buildLidoRouterStakeCalls,
  buildSpolRouterStakeCalls,
} from '../../lib/staking/stakingRouter'

const IFACE = new Interface(STAKING_ROUTER_ABI)
const ROUTER = '0x1111111111111111111111111111111111111111'

beforeEach(() => {
  m.address = null
  m.methods = {}
})

describe('getStakingRouterAddress', () => {
  it('returns null when the router is undeployed (empty/absent)', () => {
    m.address = ''
    expect(getStakingRouterAddress(1)).toBeNull()
    m.address = undefined
    expect(getStakingRouterAddress(1)).toBeNull()
  })
  it('returns the address when deployed', () => {
    m.address = ROUTER
    expect(getStakingRouterAddress(1)).toBe(ROUTER)
  })
})

describe('readStakingRouterConfig — safe fallback', () => {
  it('returns null when no router is deployed', async () => {
    m.address = null
    expect(await readStakingRouterConfig({ chainId: 1, provider: {} })).toBeNull()
  })

  it('returns null when the load-bearing paused() read fails (unreadable router)', async () => {
    m.address = ROUTER
    m.methods = { paused: () => Promise.reject(new Error('rpc down')) }
    expect(await readStakingRouterConfig({ chainId: 1, provider: {} })).toBeNull()
  })

  it('normalizes provider addresses, validators and paused when readable', async () => {
    m.address = ROUTER
    const V = ['0xaaa0000000000000000000000000000000000001', '0xbbb0000000000000000000000000000000000002']
    m.methods = {
      paused: () => Promise.resolve(true),
      lidoSteth: () => Promise.resolve('0xste'),
      lidoWsteth: () => Promise.resolve('0xwst'),
      spolController: () => Promise.resolve('0xctl'),
      spolToken: () => Promise.resolve('0xspt'),
      polToken: () => Promise.resolve('0xpol'),
      polygonStakeManager: () => Promise.resolve('0xmgr'),
      validatorCount: () => Promise.resolve(2n),
      validatorAt: (i) => Promise.resolve(V[Number(i)]),
    }
    const cfg = await readStakingRouterConfig({ chainId: 1, provider: {} })
    expect(cfg.routerAddress).toBe(ROUTER)
    expect(cfg.paused).toBe(true)
    expect(cfg.providers.lido).toEqual({ steth: '0xste', wsteth: '0xwst' })
    expect(cfg.validators).toEqual(V)
  })
})

describe('liquid router stake-call builders', () => {
  it('encodes stakeLido as a single native-value call, no approve', () => {
    const { calls, requiresApproval } = buildLidoRouterStakeCalls({ routerAddress: ROUTER, amount: 5n, maxFeeBps: 50 })
    expect(requiresApproval).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].target).toBe(ROUTER)
    expect(calls[0].value).toBe(5n)
    const decoded = IFACE.parseTransaction({ data: calls[0].data })
    expect(decoded.name).toBe('stakeLido')
    expect(Number(decoded.args[0])).toBe(50)
  })

  it('encodes stakeSpol as approve-router + stake (no native value)', () => {
    const POL = '0x2222222222222222222222222222222222222222'
    const { calls, requiresApproval } = buildSpolRouterStakeCalls({ routerAddress: ROUTER, polToken: POL, amount: 100n, maxFeeBps: 40 })
    expect(requiresApproval).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0].target).toBe(POL)
    expect(calls[1].target).toBe(ROUTER)
    const stake = IFACE.parseTransaction({ data: calls[1].data })
    expect(stake.name).toBe('stakeSpol')
    expect(stake.args[0]).toBe(100n)
    expect(Number(stake.args[1])).toBe(40)
  })
})
