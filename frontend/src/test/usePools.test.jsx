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
  approveRun: vi.fn(async () => ({ txHash: '0xgaslessapprove' })),
}))

// The ONE chain read `vote` makes (`currentProposalId`). Unset => the real module answers, so every
// test that does not care about this read behaves exactly as it did before it was introduced.
const reads = vi.hoisted(() => ({ impl: null, calls: [] }))
vi.mock('../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: (chainId, request) => {
      if (!reads.impl) return actual.readContract(chainId, request)
      reads.calls.push({ chainId, ...request })
      return reads.impl(chainId, request)
    },
  }
})

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
    if (action === 'poolApprove') return { run: gasless.approveRun }
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

import { usePools, ProposalChangedError } from '../hooks/usePools'

// Frozen: `closeJoining()` on WagerPool. Byte-compared against ethers' Interface before the swap.
const CLOSE_JOINING_CALLDATA = '0x6be61602'
const POOL = '0x00000000000000000000000000000000000000a1'

describe('usePools signer wiring', () => {
  beforeEach(() => {
    wallet.signer = { provider: { getNetwork: () => Promise.resolve({ chainId: 137n }) } }
    wallet.provider = { getNetwork: () => Promise.resolve({ chainId: 137n }) }
    wallet.sendCalls.mockReset().mockResolvedValue({ txHash: '0xpasskeytx' })
    gasless.closeRun.mockReset().mockResolvedValue({ txHash: '0xgasless' })
    gasless.approveRun.mockReset().mockResolvedValue({ txHash: '0xgaslessapprove' })
    reads.impl = null
    reads.calls = []
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

  // ---- vote: the approval is bound to the payout the member was SHOWN (residual of #1667) --------
  //
  // #1668 made every rail carry a proposalId. What it carried was a FRESH read of
  // `currentProposalId`, taken when the button was tapped — so a creator who re-proposed after the
  // member read the screen had the replacement read, pinned and approved. The id now comes from the
  // caller (the hash of the matrix on screen) and these tests hold the hook to never substituting
  // its own.
  const REVIEWED = `0x${'11'.repeat(32)}`
  const REPLACED = `0x${'22'.repeat(32)}`
  // Frozen: `approve(bytes32)` on WagerPool = 0xa53a1adf, then the id as one word. Written out, not
  // produced by the encoder under test.
  const approveCalldata = (id) => `0xa53a1adf${id.slice(2)}`

  it('vote submits the REVIEWED proposal id on the passkey rail', async () => {
    wallet.signer = null
    reads.impl = async () => REVIEWED
    const { result } = renderHook(() => usePools())
    let txHash
    await act(async () => { txHash = await result.current.vote(POOL, REVIEWED) })
    expect(txHash).toBe('0xpasskeytx')
    expect(reads.calls[0]).toMatchObject({ address: POOL, functionName: 'currentProposalId' })
    expect(wallet.sendCalls).toHaveBeenCalledTimes(1)
    expect(wallet.sendCalls.mock.calls[0][0][0]).toMatchObject({ target: POOL, data: approveCalldata(REVIEWED) })
  })

  it('vote hands the REVIEWED id to the relayed/self-submit rail for a signer session', async () => {
    reads.impl = async () => REVIEWED
    const { result } = renderHook(() => usePools())
    let txHash
    await act(async () => { txHash = await result.current.vote(POOL, REVIEWED) })
    expect(txHash).toBe('0xgaslessapprove')
    expect(gasless.approveRun).toHaveBeenCalledTimes(1)
    expect(gasless.approveRun.mock.calls[0].slice(0, 2)).toEqual([POOL, REVIEWED])
    expect(wallet.sendCalls).not.toHaveBeenCalled()
  })

  it('vote REFUSES, signing nothing, when the chain holds a different proposal than the one reviewed', async () => {
    // The exact attack: the member was shown REVIEWED; the creator re-proposed; the chain now says
    // REPLACED. Before this fix the hook read REPLACED and approved it.
    for (const session of ['passkey', 'signer']) {
      if (session === 'passkey') wallet.signer = null
      else wallet.signer = { provider: { getNetwork: () => Promise.resolve({ chainId: 137n }) } }
      wallet.sendCalls.mockClear()
      gasless.approveRun.mockClear()
      reads.impl = async () => REPLACED
      const { result } = renderHook(() => usePools())
      let thrown
      await act(async () => {
        try { await result.current.vote(POOL, REVIEWED) } catch (e) { thrown = e }
      })
      expect(thrown, session).toBeInstanceOf(ProposalChangedError)
      expect(thrown.code, session).toBe('PROPOSAL_CHANGED')
      expect(wallet.sendCalls, session).not.toHaveBeenCalled()
      expect(gasless.approveRun, session).not.toHaveBeenCalled()
    }
  })

  it('vote never falls back to the chain\'s id: no reviewed id means no approval', async () => {
    wallet.signer = null
    reads.impl = async () => REPLACED
    const { result } = renderHook(() => usePools())
    for (const missing of [undefined, null, '', '0xabc', `0x${'00'.repeat(32)}`, () => {}]) {
      let thrown
      await act(async () => {
        try { await result.current.vote(POOL, missing) } catch (e) { thrown = e }
      })
      expect(thrown?.message, String(missing)).toMatch(/review the proposed payout/i)
    }
    expect(wallet.sendCalls).not.toHaveBeenCalled()
    // Refused on the argument alone — before any read, so an RPC outage cannot change the answer.
    expect(reads.calls).toHaveLength(0)
  })

  it('an unreadable chain is not a mismatch: vote still submits the REVIEWED id and lets the contract decide', async () => {
    wallet.signer = null
    reads.impl = async () => { throw new Error('rpc down') }
    const { result } = renderHook(() => usePools())
    await act(async () => { await result.current.vote(POOL, REVIEWED) })
    expect(wallet.sendCalls).toHaveBeenCalledTimes(1)
    expect(wallet.sendCalls.mock.calls[0][0][0].data).toBe(approveCalldata(REVIEWED))
  })

  it('the contract\'s own OutcomeMismatch reaches the surface as the same refusal', async () => {
    // The race the early read cannot see: the proposal moves between the read and inclusion.
    wallet.signer = null
    reads.impl = async () => REVIEWED
    wallet.sendCalls.mockRejectedValue(Object.assign(new Error('execution reverted'), { shortMessage: 'reverted: OutcomeMismatch()' }))
    const { result } = renderHook(() => usePools())
    let thrown
    await act(async () => {
      try { await result.current.vote(POOL, REVIEWED) } catch (e) { thrown = e }
    })
    expect(thrown).toBeInstanceOf(ProposalChangedError)
  })
})
