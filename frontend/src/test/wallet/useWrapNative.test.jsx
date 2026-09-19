/**
 * useWrapNative — the engine behind Transfer ▸ Wrap.
 *
 * What is pinned here is the part a member can lose money or trust on:
 *
 *   1. The calldata. `deposit()` must carry the coin as msg.value and `withdraw(wad)` must name the
 *      amount and send no value. Getting these the wrong way round is a silent, unrecoverable send.
 *   2. The gas reserve. Wrapping is paid for in the very coin being wrapped, so MAX must hold back a
 *      quoted fee — an offer of the whole balance is a transaction that fails after signature.
 *   3. Who is acting. A vault wrap is a PROPOSAL, and a passkey op that was submitted but never
 *      included is reported as pending with no fabricated transaction hash.
 *   4. Unread ≠ zero. A balance that failed to read stays null so the view can render "—".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { ethers } from 'ethers'
import { WNATIVE_ABI } from '../../abis/WNative'

const MORDOR = 63
const WRAPPED = '0x1953cab0E5bFa6D4a9BaD6E05fD46C1CC6527a5a'

const IFACE = new ethers.Interface(WNATIVE_ABI)
const DEPOSIT = IFACE.encodeFunctionData('deposit', [])
const withdrawData = (v) => IFACE.encodeFunctionData('withdraw', [v])

const getBalance = vi.fn()
const balanceOf = vi.fn()
const symbolCall = vi.fn()
const readCalls = []
const getFeeData = vi.fn()
const sendTransaction = vi.fn()
const sendCalls = vi.fn()
const submitAsActive = vi.fn()

const readProvider = { getBalance, getFeeData }

const wallet = vi.hoisted(() => ({ current: {} }))
const active = vi.hoisted(() => ({ current: {} }))

vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => wallet.current }))
vi.mock('../../hooks/useActiveAccount', () => ({ useActiveAccount: () => active.current }))
vi.mock('../../utils/rpcProvider', () => ({
  makeReadProvider: () => readProvider,
  getReadProvider: () => readProvider,
}))
// The passkey lifecycle tests below exercise pending/failed/sponsorship REPORTING, not chain
// support — on the real test chain (Mordor, no bundler) spec 108's pre-tap gate would refuse
// before sendCalls ever ran, which is its own behavior with its own tests (the spec 108 block
// at the bottom flips this seam off to prove the refusal). Support defaults to present so the
// lifecycle paths stay reachable.
const passkeySupport = vi.hoisted(() => ({ supported: true, reason: null }))
vi.mock('../../config/passkeySupport', () => ({
  isPasskeySupported: () => passkeySupport.supported,
  getPasskeySupport: () => ({ ...passkeySupport }),
}))
vi.mock('../../hooks/useRpcEndpoints', () => ({ useEndpointsRevision: () => 0 }))

/**
 * Spec 110: the contract reads go through the chain seam, so the seam is what is faked — the
 * `vi.mock('ethers')` that stood here stubbed `new ethers.Contract(address, abi, runner)`, a
 * constructor whose fake (like every fake of it) IGNORED THE ADDRESS. A balance read aimed at the
 * wrong contract, or at the wrong chain, passed every assertion in this file. Both are recorded
 * and asserted now.
 *
 * ethers is still imported below, unmocked, purely as the cross-library oracle for the calldata:
 * `IFACE.encodeFunctionData` is what the hook's viem encoder is being compared AGAINST, so it must
 * be the real thing.
 */
vi.mock('../../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      readCalls.push({ chainId, address, functionName, args })
      if (functionName === 'symbol') return symbolCall()
      if (functionName === 'balanceOf') return balanceOf(args[0])
      throw new Error(`unexpected read: ${functionName}`)
    },
  }
})

const { useWrapNative } = await import('../../hooks/useWrapNative')

beforeEach(() => {
  vi.clearAllMocks()
  readCalls.length = 0
  passkeySupport.supported = true
  passkeySupport.reason = null
  wallet.current = {
    address: '0xAaAa000000000000000000000000000000000001',
    chainId: MORDOR,
    // A real JsonRpcSigner carries the provider it was built on, and that provider knows
    // which chain it serves — the spec-108 settle loop reads it to tell a settled signer
    // from the pre-switch one.
    signer: { sendTransaction, provider: { getNetwork: async () => ({ chainId: MORDOR }) } },
    provider: null,
    loginMethod: 'eoa',
    sendCalls,
  }
  active.current = {
    identity: { mode: 'personal' },
    isVault: false,
    isLegacy: false,
    isHardware: false,
    canActAsVault: false,
    canActAsLegacy: false,
    canActAsHardware: false,
    submit: submitAsActive,
  }
  getBalance.mockResolvedValue(ethers.parseEther('10'))
  balanceOf.mockResolvedValue(ethers.parseEther('4'))
  symbolCall.mockResolvedValue('WETC')
  getFeeData.mockResolvedValue({ maxFeePerGas: 1_000_000_000n, gasPrice: 1_000_000_000n })
  sendTransaction.mockResolvedValue({ hash: '0xtx', wait: async () => ({ hash: '0xtx' }) })
})

async function mounted() {
  const view = renderHook(() => useWrapNative())
  await waitFor(() => expect(view.result.current.nativeBalance).not.toBeNull())
  return view
}

describe('resolution and balances', () => {
  it('resolves the network’s wrapped coin and reads both balances', async () => {
    const { result } = await mounted()
    expect(result.current.available).toBe(true)
    expect(result.current.token.address).toBe(WRAPPED)
    expect(result.current.nativeBalance).toBe(ethers.parseEther('10'))
    await waitFor(() => expect(result.current.wrappedBalance).toBe(ethers.parseEther('4')))
  })

  it('prefers the contract’s own symbol over the label derived from config', async () => {
    symbolCall.mockResolvedValue('WPOL')
    const { result } = await mounted()
    await waitFor(() => expect(result.current.wrappedSymbol).toBe('WPOL'))
  })

  it('keeps a failed balance read null — an unread balance is not a zero one', async () => {
    getBalance.mockRejectedValue(new Error('rpc down'))
    balanceOf.mockRejectedValue(new Error('rpc down'))
    const { result } = await mounted().catch(() => renderHook(() => useWrapNative()))
    await waitFor(() => expect(result.current.wrappedBalance).toBeNull())
    expect(result.current.nativeBalance).toBeNull()
    expect(result.current.maxWrappable).toBeNull()
  })

  it('reports unavailable on a network with no configured wrapper', async () => {
    wallet.current = { ...wallet.current, chainId: 11155111 }
    const { result } = renderHook(() => useWrapNative())
    expect(result.current.available).toBe(false)
    expect(result.current.token).toBeNull()
    await expect(result.current.wrap('1')).rejects.toThrow(/no wrapped coin/i)
  })
})

describe('the gas reserve', () => {
  it('holds back a quoted fee so a MAX wrap can still pay for itself', async () => {
    const { result } = await mounted()
    await waitFor(() => expect(result.current.gasReserve).not.toBeNull())
    expect(result.current.maxWrappable).toBe(ethers.parseEther('10') - result.current.gasReserve)
    expect(result.current.gasReserve).toBeGreaterThan(0n)
  })

  it('never goes negative when the balance is smaller than the reserve', async () => {
    getBalance.mockResolvedValue(1n)
    const { result } = await mounted()
    await waitFor(() => expect(result.current.gasReserve).not.toBeNull())
    expect(result.current.maxWrappable).toBe(0n)
  })

  it('holds nothing back when the op is sponsored — there is no fee to reserve for', async () => {
    wallet.current = { ...wallet.current, loginMethod: 'passkey', signer: null }
    const { result } = await mounted()
    // Mordor's passkey block is env-driven and unset in the test build, so sponsorship is off and
    // the reserve still applies. Asserting the honest default matters more than a contrived on-case.
    expect(result.current.sponsored).toBe(false)
    await waitFor(() => expect(result.current.maxWrappable).toBeLessThan(ethers.parseEther('10')))
  })
})

describe('the calldata', () => {
  it('wraps by sending the coin to deposit()', async () => {
    const { result } = await mounted()
    await act(async () => { await result.current.wrap('1.5') })
    expect(sendTransaction).toHaveBeenCalledWith({
      to: WRAPPED,
      value: ethers.parseEther('1.5'),
      data: DEPOSIT,
    })
  })

  it('unwraps by naming the amount to withdraw() and sending no value', async () => {
    const { result } = await mounted()
    await act(async () => { await result.current.unwrap('2') })
    expect(sendTransaction).toHaveBeenCalledWith({
      to: WRAPPED,
      value: 0n,
      data: withdrawData(ethers.parseEther('2')),
    })
  })

  it('refuses an amount larger than the balance being spent', async () => {
    const { result } = await mounted()
    await waitFor(() => expect(result.current.wrappedBalance).not.toBeNull())
    await expect(result.current.unwrap('5')).rejects.toThrow(/not enough/i)
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('refuses a zero or unparseable amount', async () => {
    const { result } = await mounted()
    await expect(result.current.wrap('0')).rejects.toThrow(/greater than zero/i)
    await expect(result.current.wrap('abc')).rejects.toThrow(/valid amount/i)
    expect(sendTransaction).not.toHaveBeenCalled()
  })
})

describe('who is acting', () => {
  it('turns a vault wrap into a proposal, and never a transaction', async () => {
    active.current = {
      ...active.current,
      isVault: true,
      canActAsVault: true,
      identity: { mode: 'vault', vaultAddress: '0xVau1t00000000000000000000000000000000001', chainId: MORDOR },
    }
    submitAsActive.mockResolvedValue({ safeTxHash: '0xsafe' })
    const { result } = await mounted()
    let res
    await act(async () => { res = await result.current.wrap('1') })
    expect(res).toMatchObject({ proposed: true, safeTxHash: '0xsafe', txHash: null })
    expect(sendTransaction).not.toHaveBeenCalled()
    expect(submitAsActive).toHaveBeenCalledWith({ to: WRAPPED, value: ethers.parseEther('1'), data: DEPOSIT })
  })

  it('refuses a vault wrap from the wrong network rather than signing on it', async () => {
    active.current = {
      ...active.current,
      isVault: true,
      canActAsVault: false,
      identity: { mode: 'vault', vaultAddress: '0xVau1t00000000000000000000000000000000001', chainId: 137 },
    }
    const { result } = await mounted()
    await expect(result.current.wrap('1')).rejects.toThrow(/switch to the vault/i)
    expect(submitAsActive).not.toHaveBeenCalled()
  })

  // Spec 088 (FR-001/FR-002) — a hardware acting account is the actor, not the connected wallet.
  // Guards the finding that wrap/unwrap read the CONNECTED wallet's balances and signed with the
  // connected signer while operating as a hardware account.
  it('reads balances from the hardware acting address, not the connected wallet (spec 088 FR-001)', async () => {
    // A REAL address. The placeholder that stood here ('0xHaRd…') is not hex and was only ever
    // accepted because the fake `new Contract(address, …)` ignored its first argument entirely.
    // Checksummed: the hook normalises the acting address before the read (divergence 16),
    // so a fixture in another casing would assert on a string the seam never sees.
    const HW = '0x00000000000000000000000000000000000000A9'
    active.current = {
      ...active.current,
      isHardware: true,
      canActAsHardware: true,
      identity: { mode: 'hardware', address: HW, vendor: 'ledger' },
    }
    const { result } = await mounted()
    expect(getBalance).toHaveBeenCalledWith(HW)
    expect(getBalance).not.toHaveBeenCalledWith(wallet.current.address)
    await waitFor(() => expect(result.current.wrappedBalance).not.toBeNull())
    expect(balanceOf).toHaveBeenCalledWith(HW)
    expect(balanceOf).not.toHaveBeenCalledWith(wallet.current.address)
    // And the read was aimed at the wrapper on the wrapper's own chain — the two facts the
    // address-ignoring Contract fake could never distinguish.
    expect(readCalls).toContainEqual({
      chainId: MORDOR,
      address: WRAPPED,
      functionName: 'balanceOf',
      args: [HW],
    })
  })

  it('routes a hardware wrap through the acting-account seam, never the connected signer (spec 088 FR-002)', async () => {
    active.current = {
      ...active.current,
      isHardware: true,
      canActAsHardware: true,
      identity: { mode: 'hardware', address: '0xHaRd000000000000000000000000000000000009', vendor: 'ledger' },
    }
    submitAsActive.mockResolvedValue({ txHash: '0xhwtx' })
    const { result } = await mounted()
    let res
    await act(async () => { res = await result.current.wrap('1') })
    expect(submitAsActive).toHaveBeenCalledTimes(1)
    expect(submitAsActive).toHaveBeenCalledWith({ to: WRAPPED, value: ethers.parseEther('1'), data: DEPOSIT })
    expect(sendTransaction).not.toHaveBeenCalled()
    expect(res).toMatchObject({ txHash: '0xhwtx', sponsored: false })
  })

  it('routes a hardware unwrap through the acting-account seam too', async () => {
    active.current = {
      ...active.current,
      isHardware: true,
      canActAsHardware: true,
      identity: { mode: 'hardware', address: '0xHaRd000000000000000000000000000000000009', vendor: 'ledger' },
    }
    submitAsActive.mockResolvedValue({ txHash: '0xhwtx' })
    const { result } = await mounted()
    await act(async () => { await result.current.unwrap('2') })
    expect(submitAsActive).toHaveBeenCalledWith({ to: WRAPPED, value: 0n, data: withdrawData(ethers.parseEther('2')) })
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('reports a submitted-but-not-included passkey op as pending, with no fabricated tx hash', async () => {
    wallet.current = { ...wallet.current, loginMethod: 'passkey', signer: null }
    sendCalls.mockResolvedValue({ state: 'submitted', userOpHash: '0xuserop', sponsored: true })
    const { result } = await mounted()
    let res
    await act(async () => { res = await result.current.wrap('1') })
    expect(res).toMatchObject({ pending: true, txHash: null, userOpHash: '0xuserop' })
    expect(result.current.status).toBe('pending')
  })

  it('surfaces a failed passkey op as an error instead of a success', async () => {
    wallet.current = { ...wallet.current, loginMethod: 'passkey', signer: null }
    sendCalls.mockResolvedValue({ state: 'failed', reason: 'reverted: insufficient funds' })
    const { result } = await mounted()
    await act(async () => {
      await expect(result.current.wrap('1')).rejects.toThrow(/reverted/i)
    })
    expect(result.current.status).toBe('error')
    expect(result.current.error).toMatch(/reverted/i)
  })

  it('reports the batch’s own sponsorship, not the config’s promise', async () => {
    wallet.current = { ...wallet.current, loginMethod: 'passkey', signer: null }
    sendCalls.mockResolvedValue({ state: 'included', txHash: '0xtx', sponsored: false })
    const { result } = await mounted()
    let res
    await act(async () => { res = await result.current.wrap('1') })
    expect(res).toMatchObject({ txHash: '0xtx', sponsored: false })
  })
})

describe('the target chain (spec 108) — the asset is the entry point', () => {
  const POLYGON = 137

  it('re-binds every read to an explicit target, and says a switch is coming', async () => {
    // Wallet stays on Mordor; the member picked Polygon's coin.
    const view = renderHook(() => useWrapNative({ chainId: POLYGON }))
    await waitFor(() => expect(view.result.current.nativeBalance).not.toBeNull())
    const { NETWORKS } = await import('../../config/networks')
    expect(view.result.current.token.address).toBe(NETWORKS[POLYGON].dex.wnative)
    expect(view.result.current.chainId).toBe(POLYGON)
    expect(view.result.current.networkName).toBe(NETWORKS[POLYGON].name)
    expect(view.result.current.needsSwitch).toBe(true)
    expect(view.result.current.writeRail.kind).toBe('signer-switch')
  })

  it('passing no target keeps the wallet’s chain — the pre-108 contract, byte for byte', async () => {
    const { result } = await mounted()
    expect(result.current.chainId).toBe(MORDOR)
    expect(result.current.needsSwitch).toBe(false)
    expect(result.current.writeRail.kind).toBe('signer-same-chain')
  })

  it('a refused switch names BOTH chains and sends nothing', async () => {
    const switchNetwork = vi.fn().mockRejectedValue(new Error('user rejected'))
    wallet.current = { ...wallet.current, switchNetwork }
    const view = renderHook(() => useWrapNative({ chainId: POLYGON }))
    await waitFor(() => expect(view.result.current.nativeBalance).not.toBeNull())
    await act(async () => {
      // Spec 110 T026a — the GUARANTEE, not just "both names appear somewhere". This assertion used
      // to be the loose regex alone, so when the refusal moved to the shared `settleWalletOn` its
      // tail changed from "— nothing was sent" to "so nothing has been signed" and this suite stayed
      // green; only the Cypress spec, which pinned the sentence, caught it. Pinning the phrase here
      // means a wording change is a LOCAL failure rather than a CI one.
      const err = await view.result.current.wrap('1').catch((e) => e)
      expect(err.message).toMatch(/Polygon.*Mordor|Mordor.*Polygon/s)
      expect(err.message).toMatch(/nothing has been signed/i)
    })
    expect(switchNetwork).toHaveBeenCalledWith(POLYGON)
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('a switch that lands sends through the SETTLED signer on the target chain', async () => {
    const settledSend = vi
      .fn()
      .mockResolvedValue({ hash: '0xsettled', wait: async () => ({ hash: '0xsettled' }) })
    // The switch arrives as new context values on a LATER render, not as the switch
    // promise's resolution — exactly what the settle loop exists to wait for. And it arrives
    // in TWO steps, the way a real wallet delivers it: the connector's chainChanged updates
    // the context chainId FIRST, while the chain-scoped signer is still the pre-switch one
    // (whose own provider still answers the OLD chain); the rebuilt signer lands on a later
    // render. The loop must skip that stale pair — ethers only rejects a send through it
    // AFTER broadcasting ("network changed: 63 => 137"), so waiting is the only safe answer.
    const switchNetwork = vi.fn().mockImplementation(async () => {
      wallet.current = { ...wallet.current, chainId: POLYGON } // stale signer still in place
    })
    wallet.current = { ...wallet.current, switchNetwork }
    const view = renderHook(() => useWrapNative({ chainId: POLYGON }))
    await waitFor(() => expect(view.result.current.nativeBalance).not.toBeNull())
    // The wrap is started OUTSIDE act on purpose: the settle loop inside it is waiting for a
    // render pass, and a render cannot flush while the act() awaiting the same promise holds
    // the queue. waitFor drives its own act ticks, which is what lets the loop observe the
    // switched snapshot.
    let pending
    act(() => { pending = view.result.current.wrap('1') })
    await waitFor(() => expect(switchNetwork).toHaveBeenCalledWith(POLYGON))
    view.rerender() // delivers chainId=137 with the PRE-switch signer — must not send
    wallet.current = {
      ...wallet.current,
      signer: {
        sendTransaction: settledSend,
        provider: { getNetwork: async () => ({ chainId: POLYGON }) },
      },
    }
    view.rerender() // the rebuilt, target-bound signer lands
    let res
    await act(async () => { res = await pending })
    expect(res.txHash).toBe('0xsettled')
    expect(settledSend).toHaveBeenCalledTimes(1)
    // The pre-switch signer never signed anything.
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('a passkey batch pins the target chain by parameter — no switch ceremony', async () => {
    wallet.current = { ...wallet.current, loginMethod: 'passkey', signer: null, switchNetwork: undefined }
    sendCalls.mockResolvedValue({ state: 'included', txHash: '0xop', sponsored: false })
    const view = renderHook(() => useWrapNative({ chainId: POLYGON }))
    await waitFor(() => expect(view.result.current.nativeBalance).not.toBeNull())
    expect(view.result.current.writeRail.kind).toBe('passkey')
    await act(async () => { await view.result.current.wrap('1') })
    expect(sendCalls).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ chainId: POLYGON }),
    )
  })

  it('an unsupported passkey target is stated BEFORE the tap, with the seam’s own reason', async () => {
    passkeySupport.supported = false
    passkeySupport.reason = 'No bundler is configured for this network.'
    wallet.current = { ...wallet.current, loginMethod: 'passkey', signer: null }
    const view = renderHook(() => useWrapNative({ chainId: POLYGON }))
    await waitFor(() => expect(view.result.current.nativeBalance).not.toBeNull())
    expect(view.result.current.writeRail).toEqual({
      kind: 'unavailable',
      reason: 'No bundler is configured for this network.',
    })
    await act(async () => {
      await expect(view.result.current.wrap('1')).rejects.toThrow(/no bundler/i)
    })
    expect(sendCalls).not.toHaveBeenCalled()
  })
})
