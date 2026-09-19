/**
 * Wager writes and the account switcher (spec 088 FR-001/FR-002).
 *
 * `useFriendMarketCreation` and `MarketAcceptanceModal` both had exactly ONE acting-account branch
 * — the vault one — and every other kind fell straight past it into the gasless / self-submit legs,
 * which sign with the CONNECTED wallet. A member acting as a recovered or hardware account
 * therefore staked the connected wallet's money and became the connected wallet's creator or
 * opponent on-chain, with the switcher naming somebody else the whole time.
 *
 * Two claims per surface, and they are not the same claim:
 *   1. the write goes through `submitAsActive` — the active-account seam that fetches THAT
 *      account's signer (spec 088's deferred ceremony) — carrying the same [approve?, action]
 *      batch the vault branch builds; and
 *   2. nothing reaches the connected wallet's rails: no relayed intent, no `sendCalls` UserOp, no
 *      `signer`-bound contract write.
 *
 * Reads are asserted too, because a signature routed correctly over the wrong balance is still the
 * FR-001 bug: the stake balance and the allowance must be read for the ACTING address.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
// `vi.mock('ethers')` below replaces only `Contract`, so `Interface` here is the real one — which
// is the point: the batch's calldata is decoded by the library the encoder is being checked against.
import { Interface } from 'ethers'
import { WAGER_REGISTRY_ABI } from '../../abis/WagerRegistry'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderHook } from '@testing-library/react'

const CONNECTED = '0x1111111111111111111111111111111111111111'
const ACTING = '0x2222222222222222222222222222222222222222'
const OPPONENT = '0x3333333333333333333333333333333333333333'
const REGISTRY_IFACE = new Interface(WAGER_REGISTRY_ABI)
const ERC20_IFACE = new Interface(['function approve(address spender, uint256 amount) returns (bool)'])
const REGISTRY = '0x4444444444444444444444444444444444444444'
const TOKEN = '0x5555555555555555555555555555555555555555'

// ---- the acting identity, driven per test -------------------------------------------
let activeAccount
const submitAsActive = vi.fn(async () => ({ kind: 'sent', txHash: '0xACTING' }))
const personal = () => ({
  identity: { mode: 'personal' },
  isVault: false, isLegacy: false, isHardware: false,
  canActAsVault: false, canActAsLegacy: false, canActAsHardware: false,
  submit: submitAsActive,
  operateAsPersonal: vi.fn(),
})
const actingAs = (mode) => ({
  identity: { mode, address: ACTING, label: mode === 'hardware' ? 'Ledger Nano' : 'Recovered key' },
  isVault: false,
  isLegacy: mode === 'legacy',
  isHardware: mode === 'hardware',
  canActAsVault: false, canActAsLegacy: mode === 'legacy', canActAsHardware: mode === 'hardware',
  submit: submitAsActive,
  operateAsPersonal: vi.fn(),
})
vi.mock('../../hooks/useActiveAccount', () => ({
  useActiveAccount: () => activeAccount,
  default: () => activeAccount,
}))

// ---- the connected wallet's own rails. Every one of these is a way to sign as the WRONG
// account while acting, so each is a spy the tests assert was never touched. ------------
const connectedSignerWrite = vi.fn(async () => ({
  hash: '0xCONNECTED-WRITE',
  wait: async () => ({ hash: '0xCONNECTED-WRITE', logs: [] }),
}))
const connectedSigner = {
  id: 'connected-signer',
  getAddress: async () => CONNECTED,
  provider: { getNetwork: async () => ({ chainId: 137n }) },
  // Spec 110: the signer rail is `sendTransaction` now, not a signer-bound ethers Contract. It is
  // a SPY rather than absent on purpose — a missing method would make the acting tests pass by
  // throwing, which proves the write did not happen but not that it went anywhere right.
  sendTransaction: (...a) => connectedSignerWrite(...a),
  estimateGas: async () => 100_000n,
}
const sendCalls = vi.fn(async () => ({ txHash: '0xUSEROP' }))
const gaslessRun = vi.fn(async () => ({ txHash: '0xRELAYED' }))
vi.mock('../../lib/relay/useGaslessWrite', () => ({
  useGaslessWrite: () => ({ run: (...a) => gaslessRun(...a), status: 'idle' }),
}))

/**
 * Spec 110 — `useFriendMarketCreation` reads through the chain seam now, so the seam is faked here
 * from the SAME `balances`/`allowances` state the ethers `Contract` fake below serves. The ethers
 * mock stays because `MarketAcceptanceModal`, the other surface in this file, is still an ethers
 * consumer — this file genuinely needs both.
 *
 * `staticCallFrom` keeps its job and its meaning: it records who the create was simulated AS,
 * which is the whole of FR-001. ethers took that from `{ from }`; the seam takes it as `account`.
 */
const seamReads = []
vi.mock('../../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [], account }) => {
      seamReads.push({ chainId, address, functionName, args, account })
      if (String(address).toLowerCase() === TOKEN.toLowerCase()) {
        if (functionName === 'decimals') return 6
        if (functionName === 'symbol') return 'USDC'
        if (functionName === 'balanceOf') return balances[String(args[0]).toLowerCase()] ?? 0n
        if (functionName === 'allowance') return allowances[String(args[0]).toLowerCase()] ?? 0n
      }
      if (functionName === 'getMembership') return { tier: 0n, activeCount: 0n }
      if (functionName === 'getUserWagerCount') return 0n
      if (functionName === 'getUserWagers' || functionName === 'getUserWagerIds') return []
      if (/^createWager/.test(functionName)) {
        // The pre-flight. `account` is who it is simulated AS.
        staticCallFrom({ from: account })
        return undefined
      }
      throw new Error(`unexpected seam read ${functionName} on ${address}`)
    },
  }
})

// ---- ethers: real everywhere except the Contract factory, which is the chain seam -----
const balances = { [ACTING.toLowerCase()]: 10_000_000n, [CONNECTED.toLowerCase()]: 10_000_000n }
const allowances = {} // `${owner}` -> bigint
const registryWrite = vi.fn(async () => ({ hash: '0xSIGNER-WRITE', wait: async () => ({ hash: '0xSIGNER-WRITE', logs: [] }) }))
const tokenApproveWrite = vi.fn(async () => ({ hash: '0xSIGNER-APPROVE', wait: async () => ({ hash: '0xSIGNER-APPROVE' }) }))
const staticCallFrom = vi.fn()

function makeContract(address, _abi, runner) {
  const iface = { encodeFunctionData: (fn, args) => `0xENC:${fn}:${JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}` }
  if (String(address).toLowerCase() === TOKEN.toLowerCase()) {
    const c = {
      interface: iface,
      runner,
      decimals: async () => 6n,
      symbol: async () => 'USDC',
      balanceOf: async (who) => balances[String(who).toLowerCase()] ?? 0n,
      allowance: async (owner) => allowances[String(owner).toLowerCase()] ?? 0n,
      approve: tokenApproveWrite,
    }
    return c
  }
  const create = Object.assign((...args) => registryWrite(...args), {
    staticCall: (...args) => { staticCallFrom(args[args.length - 1]); return Promise.resolve() },
    estimateGas: async () => 100_000n,
  })
  return {
    interface: iface,
    runner,
    address,
    createWager: create,
    createWagerWithTerms: create,
    acceptWager: registryWrite,
    getWager: async () => ({ opponentStake: 5_000_000n, token: TOKEN, status: 1 }),
    getUserWagerCount: async () => 0n,
    getUserWagers: async () => [],
    getUserWagerIds: async () => [],
    getMembership: async () => ({ tier: 0n, activeCount: 0n }),
    batchExpireOpen: registryWrite,
  }
}

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal()
  const Contract = function (address, abi, runner) { return makeContract(address, abi, runner) }
  return { ...actual, Contract, ethers: { ...actual.ethers, Contract } }
})

vi.mock('../../config/contracts', () => ({
  getContractAddress: (name) => (name === 'wagerRegistry' ? REGISTRY : TOKEN),
  getContractAddressForChain: (name) => (name === 'wagerRegistry' ? REGISTRY : TOKEN),
}))
vi.mock('../../utils/feeOverrides', () => ({ getFeeOverrides: async () => ({}) }))
vi.mock('../../utils/ipfsService', () => ({
  uploadEncryptedEnvelope: vi.fn(),
  buildEncryptedIpfsReference: vi.fn(),
  fetchEncryptedEnvelope: vi.fn(),
}))

// ---- wallet seams --------------------------------------------------------------------
const web3 = () => ({
  signer: connectedSigner,
  sendCalls,
  loginMethod: 'injected',
  provider: connectedSigner.provider,
  address: CONNECTED,
  account: CONNECTED,
  chainId: 137,
  isCorrectNetwork: true,
  switchNetwork: vi.fn(),
})
vi.mock('../../hooks/useWeb3', () => ({ useWeb3: () => web3() }))
vi.mock('../../hooks', () => ({
  useWeb3: () => web3(),
  useWallet: () => ({ isConnected: true, account: CONNECTED, address: CONNECTED, chainId: 137 }),
}))
vi.mock('../../hooks/useEncryption', () => ({
  useEncryption: () => ({
    decryptMetadata: vi.fn(),
    canUserDecrypt: () => false,
    isInitialized: false,
    isInitializing: false,
    initializeKeys: vi.fn(),
  }),
}))

import { useFriendMarketCreation } from '../../hooks/useFriendMarketCreation'
import MarketAcceptanceModal from '../../components/fairwins/MarketAcceptanceModal'

/** The decoded `to` addresses of whatever batch was handed to the acting seam. */
const batchTargets = () => (submitAsActive.mock.calls[0]?.[0]?.batch || []).map((c) => c.to)
/**
 * The function names in that batch, in order — DECODED from real calldata by selector. The old
 * helper split the fake's `0xENC:<fn>:<args>` string, which could only ever report back what the
 * fake had been told to write.
 */
const nameForSelector = (data) => {
  const text = String(data)
  // `MarketAcceptanceModal` is still an ethers consumer (see the allowlist), so its half of this
  // file still goes through the `Contract` fake above and its calldata is that fake's
  // `0xENC:<fn>:<args>` marker, not real bytes. Named explicitly rather than silently tolerated:
  // when the modal converts, this branch goes and the assertions get stronger for free.
  if (text.startsWith('0xENC:')) return text.split(':')[1]
  const selector = text.slice(0, 10)
  for (const iface of [REGISTRY_IFACE, ERC20_IFACE]) {
    try {
      const fn = iface.getFunction(selector)
      if (fn) return fn.name
    } catch {
      /* not this ABI's selector */
    }
  }
  return selector
}
const batchFns = () =>
  (submitAsActive.mock.calls[0]?.[0]?.batch || []).map((c) => nameForSelector(c.data))

beforeEach(() => {
  activeAccount = personal()
  submitAsActive.mockClear()
  sendCalls.mockClear()
  gaslessRun.mockClear()
  registryWrite.mockClear()
  tokenApproveWrite.mockClear()
  connectedSignerWrite.mockClear()
  staticCallFrom.mockClear()
  seamReads.length = 0
  for (const k of Object.keys(allowances)) delete allowances[k]
})

// =====================================================================================
describe('createWager while acting as a recovered / hardware account (spec 088 FR-002)', () => {
  const wagerInput = {
    marketType: 'oneVsOne',
    data: {
      description: 'Test wager',
      opponent: OPPONENT,
      stakeAmount: '5',
      collateralToken: TOKEN,
      resolutionType: 1, // Creator
      acceptanceDeadline: 48,
      onProgress: () => {},
    },
  }

  it.each(['legacy', 'hardware'])('routes the [approve, create] batch through the acting seam (%s)', async (mode) => {
    activeAccount = actingAs(mode)
    const { result } = renderHook(() => useFriendMarketCreation())
    await result.current.createFriendMarket(wagerInput)

    expect(submitAsActive).toHaveBeenCalledTimes(1)
    // Same shape the vault branch builds — approval first, then the create, in that order.
    expect(batchTargets()).toEqual([TOKEN, REGISTRY])
    // `createWagerWithTerms` when the registry carries the spec-007 overload, plain `createWager`
    // otherwise — the point is that the CREATE is the second leg, not which overload it picked.
    expect(batchFns()[0]).toBe('approve')
    expect(batchFns()[1]).toMatch(/^createWager/)
  })

  it.each(['legacy', 'hardware'])('never touches the connected wallet’s rails (%s)', async (mode) => {
    activeAccount = actingAs(mode)
    const { result } = renderHook(() => useFriendMarketCreation())
    await result.current.createFriendMarket(wagerInput)

    expect(gaslessRun).not.toHaveBeenCalled()   // no relayed intent signed by the connected wallet
    expect(sendCalls).not.toHaveBeenCalled()    // no passkey UserOp from the connected account
    expect(registryWrite).not.toHaveBeenCalled() // no signer-bound contract write
    expect(tokenApproveWrite).not.toHaveBeenCalled()
    expect(connectedSignerWrite).not.toHaveBeenCalled() // nor the signer's own sendTransaction
  })

  it('simulates the create AS the acting account, so a refusal is reported before any ceremony', async () => {
    activeAccount = actingAs('hardware')
    const { result } = renderHook(() => useFriendMarketCreation())
    await result.current.createFriendMarket(wagerInput)

    // The `from` handed to staticCall decides which account membership/screening is checked for.
    expect(staticCallFrom).toHaveBeenCalledWith(expect.objectContaining({ from: ACTING }))
  })

  it('checks the ACTING account’s stake balance, not the connected wallet’s (FR-001)', async () => {
    activeAccount = actingAs('legacy')
    balances[ACTING.toLowerCase()] = 1n // the acting account cannot cover the 5 USDC stake…
    balances[CONNECTED.toLowerCase()] = 10_000_000n // …while the connected wallet easily could
    const { result } = renderHook(() => useFriendMarketCreation())

    await expect(result.current.createFriendMarket(wagerInput)).rejects.toThrow(/insufficient/i)
    expect(submitAsActive).not.toHaveBeenCalled()
    balances[ACTING.toLowerCase()] = 10_000_000n
  })

  it('leaves the personal member on the gasless / self-submit rail, unchanged', async () => {
    activeAccount = personal()
    const { result } = renderHook(() => useFriendMarketCreation())
    await result.current.createFriendMarket(wagerInput)

    expect(gaslessRun).toHaveBeenCalledTimes(1)
    expect(submitAsActive).not.toHaveBeenCalled()
  })
})

// =====================================================================================
describe('acceptWager while acting as a recovered / hardware account (spec 088 FR-002)', () => {
  const marketData = {
    description: 'Test wager description that is long enough',
    creator: OPPONENT,
    opponent: CONNECTED,
    participants: [OPPONENT, CONNECTED],
    acceptanceDeadline: Date.now() + 86_400_000,
    stakePerParticipant: '5.00',
    stakeTokenSymbol: 'USDC',
    marketType: '1v1',
    acceptances: { [OPPONENT.toLowerCase()]: { hasAccepted: true } },
    acceptedCount: 1,
    minAcceptanceThreshold: 2,
  }

  const openAndAccept = async (user) => {
    render(
      <MarketAcceptanceModal
        isOpen
        onClose={vi.fn()}
        marketId="wager-1"
        marketData={marketData}
        onAccepted={vi.fn()}
        contractAddress={REGISTRY}
        contractABI={[]}
      />,
    )
    await user.click(screen.getByRole('button', { name: /^Accept Offer$/i }))
    await user.click(screen.getByRole('button', { name: /I Understand, Accept Offer/i }))
  }

  it.each(['legacy', 'hardware'])('routes the [approve, accept] batch through the acting seam (%s)', async (mode) => {
    activeAccount = actingAs(mode)
    await openAndAccept(userEvent.setup())

    await waitFor(() => expect(submitAsActive).toHaveBeenCalledTimes(1))
    expect(batchTargets()).toEqual([TOKEN, REGISTRY])
    expect(batchFns()).toEqual(['approve', 'acceptWager'])
  })

  it.each(['legacy', 'hardware'])('never touches the connected wallet’s rails (%s)', async (mode) => {
    activeAccount = actingAs(mode)
    await openAndAccept(userEvent.setup())

    await waitFor(() => expect(submitAsActive).toHaveBeenCalled())
    expect(gaslessRun).not.toHaveBeenCalled()
    expect(sendCalls).not.toHaveBeenCalled()
    expect(registryWrite).not.toHaveBeenCalled()
    expect(tokenApproveWrite).not.toHaveBeenCalled()
  })

  it('drops the approval leg when the ACTING account has already approved (FR-001)', async () => {
    activeAccount = actingAs('legacy')
    allowances[ACTING.toLowerCase()] = 1_000_000_000n // acting account: approved
    allowances[CONNECTED.toLowerCase()] = 0n          // connected wallet: not
    await openAndAccept(userEvent.setup())

    await waitFor(() => expect(submitAsActive).toHaveBeenCalled())
    // Reading the connected wallet's allowance here would add a pointless approval and, worse,
    // approve from the wrong account.
    expect(batchFns()).toEqual(['acceptWager'])
  })

  it('refuses on the ACTING account’s balance, not the connected wallet’s (FR-001)', async () => {
    activeAccount = actingAs('hardware')
    balances[ACTING.toLowerCase()] = 1n
    balances[CONNECTED.toLowerCase()] = 10_000_000n
    await openAndAccept(userEvent.setup())

    expect(await screen.findByText(/Insufficient USDC balance/i)).toBeInTheDocument()
    expect(submitAsActive).not.toHaveBeenCalled()
    balances[ACTING.toLowerCase()] = 10_000_000n
  })

  it('leaves the personal member on the gasless / self-submit rail, unchanged', async () => {
    activeAccount = personal()
    await openAndAccept(userEvent.setup())

    await waitFor(() => expect(gaslessRun).toHaveBeenCalledTimes(1))
    expect(submitAsActive).not.toHaveBeenCalled()
  })
})
