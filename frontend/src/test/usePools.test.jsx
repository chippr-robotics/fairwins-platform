import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const wallet = vi.hoisted(() => ({
  signer: { provider: { getNetwork: () => Promise.resolve({ chainId: 137n }) } },
  provider: { getNetwork: () => Promise.resolve({ chainId: 137n }) },
  address: '0x3333333333333333333333333333333333333333',
  chainId: 137,
  sendCalls: vi.fn(async () => ({ txHash: '0xpasskeytx' })),
}))

const gasless = vi.hoisted(() => ({
  closeRun: vi.fn(async () => ({ txHash: '0xgasless' })),
}))

vi.mock('../hooks/useWeb3', () => ({
  useWeb3: () => ({
    signer: wallet.signer,
    provider: wallet.provider,
    address: wallet.address,
    account: wallet.address,
    chainId: wallet.chainId,
    sendCalls: wallet.sendCalls,
  }),
}))

vi.mock('../lib/relay/useGaslessWrite', () => ({
  useGaslessWrite: (action) => {
    if (action === 'poolCloseJoining') return { run: gasless.closeRun }
    return { run: vi.fn(async () => ({ txHash: '0xother' })) }
  },
}))

/**
 * Spec 110: `lib/pools/poolContracts` is NOT mocked any more. It used to be replaced wholesale with
 * `{ getFactory, getPool }` fakes whose `interface.encodeFunctionData` returned the string
 * `'0xclose'` — so the passkey assertion below proved only that the hook passed a mock's return
 * value through, never that the bytes a wallet would be asked to sign are the right ones. The real
 * module encodes here, and the selectors are FROZEN literals (divergence 17: never string-compare
 * calldata you produced with the same encoder you are testing).
 */
const scan = vi.hoisted(() => ({ calls: [], logs: [], decoded: [] }))
vi.mock('../lib/chains/eventScan', () => ({
  eventScanHandle: (chainId, { address }) => {
    // Honours the address: a scan pointed at nothing must not quietly return seeded events.
    if (!address) return null
    scan.calls.push({ chainId, address })
    return {
      target: address,
      provider: {
        getBlockNumber: async () => 1_000_000,
        getLogs: async (filter) => {
          scan.calls[scan.calls.length - 1].filter = filter
          return scan.logs
        },
      },
      filters: new Proxy(
        {},
        { get: (_t, name) => () => ({ getTopicFilter: () => [`topic:${String(name)}`] }) },
      ),
      interface: { parseLog: (log) => scan.decoded[log.__i] },
    }
  },
}))

vi.mock('../lib/pools/gateway', () => ({
  phraseToIndices: vi.fn(),
  resolvePool: vi.fn(),
  indicesToPhrase: vi.fn(),
}))
vi.mock('../lib/pools/payout', () => ({ payoutMatrixHash: () => '0xhash' }))
vi.mock('../config/contracts', () => ({
  getContractAddressForChain: vi.fn(() => '0x00000000000000000000000000000000000000f1'),
  getDeploymentBlockForChain: vi.fn(() => 4242),
}))
vi.mock('../lib/lookup/myWagersSources', () => ({ recordJoinedPool: vi.fn() }))

import { usePools } from '../hooks/usePools'

// Frozen: `closeJoining()` on WagerPool. Byte-compared against ethers' Interface before the swap.
const CLOSE_JOINING_CALLDATA = '0x6be61602'
const POOL = '0x00000000000000000000000000000000000000a1'

describe('usePools signer wiring', () => {
  beforeEach(() => {
    wallet.signer = { provider: { getNetwork: () => Promise.resolve({ chainId: 137n }) } }
    wallet.provider = { getNetwork: () => Promise.resolve({ chainId: 137n }) }
    wallet.sendCalls.mockReset().mockResolvedValue({ txHash: '0xpasskeytx' })
    gasless.closeRun.mockReset().mockResolvedValue({ txHash: '0xgasless' })
    scan.calls = []
    scan.logs = []
    scan.decoded = []
  })

  it('keeps classic signer closeJoining path on gasless seam', async () => {
    const { result } = renderHook(() => usePools())
    let txHash
    await act(async () => { txHash = await result.current.closeJoining(POOL) })
    expect(txHash).toBe('0xgasless')
    expect(gasless.closeRun).toHaveBeenCalledWith(POOL)
    expect(wallet.sendCalls).not.toHaveBeenCalled()
  })

  it('supports passkey sessions without signer by routing closeJoining through sendCalls', async () => {
    wallet.signer = null
    const { result } = renderHook(() => usePools())
    let txHash
    await act(async () => { txHash = await result.current.closeJoining(POOL) })
    expect(txHash).toBe('0xpasskeytx')
    expect(wallet.sendCalls).toHaveBeenCalledTimes(1)
    expect(wallet.sendCalls.mock.calls[0][0][0]).toMatchObject({
      target: POOL,
      data: CLOSE_JOINING_CALLDATA,
    })
  })

  it('supports read-only member lookups with provider + address and no signer', async () => {
    wallet.signer = null
    const member = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    scan.logs = [{ __i: 0 }]
    scan.decoded = [{ name: 'Joined', args: { member } }]
    const { result } = renderHook(() => usePools())
    let members
    await act(async () => { members = await result.current.getMembers(POOL) })
    expect(members).toHaveLength(1)
    expect(members[0].address).toBe(member)
    // The roster reads the POOL's own log, on the wallet's chain, from the factory's deploy block
    // — never from genesis, because this seam bisects and an unbounded range is a request storm.
    expect(scan.calls).toHaveLength(1)
    expect(scan.calls[0]).toMatchObject({ chainId: 137, address: POOL })
    expect(scan.calls[0].filter).toMatchObject({
      address: POOL,
      topics: ['topic:Joined'],
      fromBlock: 4242,
      toBlock: 1_000_000,
    })
  })
})
