import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Regression guard for the open-challenge take flow: accepting escrows the taker's matching stake, so
// the hook MUST approve the registry to pull the stake BEFORE calling acceptOpenWager. Skipping the
// approval is what produced "ERC20: transfer amount exceeds allowance" when taking a challenge.

const TOKEN = '0x1111111111111111111111111111111111111111'
const REGISTRY = '0x2222222222222222222222222222222222222222'
const ACCOUNT = '0x3333333333333333333333333333333333333333'
const STAKE = 10_000_000n // 10 USDC (6 decimals)
const CREATOR = '0x4444444444444444444444444444444444444444'
const reads = []

const { state, calls, sent } = vi.hoisted(() => ({
  state: { allowance: 0n, balance: 100_000_000n, wagerId: 0n, throwLookup: false, metadataUri: '', staticCallReject: null },
  calls: [],
  sent: [],
}))
function makeSigner() {
  return {
    getAddress: () => Promise.resolve(ACCOUNT),
    provider: { getNetwork: () => Promise.resolve({ chainId: 63n }) },
    // The write rail. `to` is what names the call — the hook builds real calldata for both.
    sendTransaction: async ({ to, data }) => {
      calls.push(to === REGISTRY ? 'accept' : 'approve')
      sent.push({ to, data })
      return { hash: '0xtxhash', wait: async () => ({ status: 1, hash: '0xtxhash' }) }
    },
  }
}

const wallet = vi.hoisted(() => ({
  signer: null,
  provider: { isFakeProvider: true },
  sendCalls: vi.fn(async () => ({ txHash: '0xpasskeytx' })),
  loginMethod: 'injected',
}))

vi.mock('../hooks/useWeb3', () => ({
  useWeb3: () => ({
    address: ACCOUNT,
    account: ACCOUNT,
    chainId: 63,
    provider: wallet.provider,
    signer: wallet.signer,
    sendCalls: wallet.sendCalls,
    loginMethod: wallet.loginMethod,
  }),
}))

vi.mock('../config/contracts', () => ({
  getContractAddressForChain: (name) => (name === 'wagerRegistry' ? REGISTRY : ''),
  getContractAddress: (name) => (name === 'wagerRegistry' ? REGISTRY : ''),
}))

vi.mock('../utils/claimCode/wordlist.js', () => ({ isValidCode: () => true }))
// A REAL address. The placeholder here was '0xclaim', which is not one — it survived because the
// claim address only ever reached a fake `Contract` that took it and ignored it. The hook
// checksums it now (spec 110 divergence 16), and `signOpenAccept`'s signature must be 65 bytes
// because it rides into `acceptOpenWager(uint256,bytes)` calldata that is decoded below.
const CLAIM = '0x00000000000000000000000000000000000000c1'
const SIGNATURE = `0x${'ab'.repeat(65)}`
vi.mock('../utils/claimCode/deriveFromCode.js', () => ({
  deriveFromCode: () => ({ claimAddress: CLAIM, symKey: new Uint8Array(32) }),
  signOpenAccept: () => Promise.resolve(SIGNATURE),
}))
// discover-only deps — not exercised by accept(), but imported at module top.
vi.mock('../utils/ipfsService', () => ({ fetchEncryptedEnvelope: vi.fn(), parseEncryptedIpfsReference: vi.fn() }))
vi.mock('../utils/crypto/envelopeEncryption.js', () => ({ decryptEnvelopeCode: vi.fn(), isCodeEnvelope: vi.fn() }))

/**
 * Spec 110 — the reads go through the chain seam and the writes through `signer.sendTransaction`,
 * so those are what is faked. The `vi.mock('ethers')` that stood here installed a `FakeContract`
 * whose `interface.encodeFunctionData` returned the literal strings `'0xacceptcalldata'` and
 * `'0xapprovecalldata'`, so the passkey assertions below checked that the hook passed a mock's
 * return value through — never that the bytes a wallet would be asked to sign are the right ones.
 * The calldata is real now and is DECODED with the real ethers `Interface` (divergence 17: never
 * string-compare calldata against the encoder under test), which is also what recovers
 * `state.acceptArgs`.
 */
vi.mock('../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      reads.push({ chainId, address, functionName, args })
      if (address === REGISTRY) {
        if (functionName === 'openWagerIdForClaim') {
          if (state.throwLookup) throw new Error('rpc down')
          return state.wagerId
        }
        if (functionName === 'getWager') {
          return {
            token: TOKEN, opponentStake: STAKE, creatorStake: STAKE, creator: CREATOR,
            metadataUri: state.metadataUri,
            // Oracle linkage fields (spec 041) — already part of the on-chain struct.
            resolutionType: 4n, polymarketConditionId: '0xc0ffee', creatorIsYes: true,
          }
        }
        if (functionName === 'acceptOpenWager') {
          // The pre-flight. A string is a plain revert reason; an object is a raw error shape —
          // used for the custom errors the shipped ABI cannot decode, where all the information
          // is in `data`.
          const spec = state.staticCallReject
          if (!spec) return undefined
          if (typeof spec === 'string') throw Object.assign(new Error(spec), { reason: spec })
          throw Object.assign(new Error(spec.message || 'execution reverted (unknown custom error)'), spec)
        }
      }
      if (address === TOKEN) {
        if (functionName === 'decimals') return 6
        if (functionName === 'symbol') return 'USDC'
        if (functionName === 'balanceOf') return state.balance
        if (functionName === 'allowance') return state.allowance
      }
      if (functionName === 'hasActiveRole') return true
      throw new Error(`unexpected read ${functionName} on ${address}`)
    },
  }
})

import { useOpenChallengeAccept } from '../hooks/useOpenChallengeAccept'
import { SANCTIONED_ADDRESS_SELECTOR } from '../lib/wagers/sanctionsRevert'

describe('useOpenChallengeAccept.accept (funding flow)', () => {
  beforeEach(() => {
    calls.length = 0
    sent.length = 0
    reads.length = 0
    state.allowance = 0n
    state.balance = 100_000_000n
    state.staticCallReject = null
    wallet.signer = makeSigner()
    wallet.provider = { isFakeProvider: true }
    wallet.sendCalls.mockReset().mockResolvedValue({ txHash: '0xpasskeytx' })
    wallet.loginMethod = 'injected'
  })

  it('approves the registry BEFORE sending acceptOpenWager when allowance is short', async () => {
    const { result } = renderHook(() => useOpenChallengeAccept())
    const steps = []
    let res
    await act(async () => {
      res = await result.current.accept('river tiger kite zoo', 4n, (p) => steps.push(p.step))
    })
    expect(res.txHash).toBe('0xtxhash')
    // The order matters — approval must precede acceptance.
    expect(calls).toEqual(['approve', 'accept'])
    // Steps are surfaced for the UI checklist.
    expect(steps).toEqual(expect.arrayContaining(['check', 'approve', 'sign', 'accept']))
  })

  it('routes the send through the gasless seam, threading the claim-code proof to acceptOpenWager', async () => {
    // With no relayer configured (VITE_RELAYER_URL unset in tests) useGaslessWrite self-submits, so
    // acceptOpenWager(wagerId, claimCodeSig) must still receive the code-derived signature verbatim —
    // the same proof the relay path would carry in its intent params (rebound to taker=signer on-chain).
    const { result } = renderHook(() => useOpenChallengeAccept())
    await act(async () => {
      await result.current.accept('river tiger kite zoo', 4n)
    })
    // DECODED, not string-compared: the calldata the signer was handed really carries this wager
    // id and this claim-code proof (divergence 17 — never compare calldata as text).
    const { Interface } = await import('ethers')
    const { WAGER_REGISTRY_ABI } = await import('../abis/WagerRegistry')
    const accept = sent.find((c) => c.to === REGISTRY)
    const [id, sig] = new Interface(WAGER_REGISTRY_ABI).decodeFunctionData('acceptOpenWager', accept.data)
    expect(id).toBe(4n)
    expect(sig).toBe(SIGNATURE)
  })

  it('skips approval when the existing allowance already covers the stake', async () => {
    state.allowance = STAKE
    const { result } = renderHook(() => useOpenChallengeAccept())
    await act(async () => {
      await result.current.accept('river tiger kite zoo', 4n)
    })
    expect(calls).toEqual(['accept'])
  })

  it('throws a friendly error (and never sends) when the balance is short', async () => {
    state.balance = 1n
    const { result } = renderHook(() => useOpenChallengeAccept())
    await expect(
      act(async () => {
        await result.current.accept('river tiger kite zoo', 4n)
      })
    ).rejects.toThrow(/Insufficient USDC balance/i)
    expect(calls).toEqual([])
  })

  it('isolates passkey sessions onto sendCalls even when a signer object exists', async () => {
    wallet.loginMethod = 'passkey'
    const { result } = renderHook(() => useOpenChallengeAccept())
    const steps = []
    let res
    await act(async () => {
      res = await result.current.accept('river tiger kite zoo', 4n, (p) => steps.push(p.step))
    })
    expect(res.txHash).toBe('0xpasskeytx')
    expect(wallet.sendCalls).toHaveBeenCalledTimes(1)
    const batch = wallet.sendCalls.mock.calls[0][0]
    expect(batch).toHaveLength(2) // approve + accept
    expect(calls).toEqual([]) // no direct signer contract write path used
    expect(steps).toEqual(expect.arrayContaining(['check', 'approve', 'sign', 'accept']))

    // The batch a passkey member is asked to sign, DECODED. Its old assertion was that the two
    // calls carried the mock's own `'0xapprovecalldata'`/`'0xacceptcalldata'` strings, which said
    // nothing about the bytes; these are the real ones. The approve must be for the REGISTRY (the
    // escrow puller), and the accept must carry this wager and this proof.
    const { Interface, MaxUint256 } = await import('ethers')
    const { WAGER_REGISTRY_ABI } = await import('../abis/WagerRegistry')
    const erc20 = new Interface(['function approve(address spender, uint256 amount) returns (bool)'])
    expect(batch[0].target).toBe(TOKEN)
    const [spender, amount] = erc20.decodeFunctionData('approve', batch[0].data)
    expect(spender.toLowerCase()).toBe(REGISTRY)
    expect(amount).toBe(MaxUint256)
    expect(batch[1].target).toBe(REGISTRY)
    const [id, sig] = new Interface(WAGER_REGISTRY_ABI).decodeFunctionData('acceptOpenWager', batch[1].data)
    expect(id).toBe(4n)
    expect(sig).toBe(SIGNATURE)
  })

  it('does not let the isolated pre-flight block a passkey taker on a not-yet-granted allowance', async () => {
    // Same deadlock as create: a fresh passkey taker has 0 allowance and the approve is batched
    // with accept, so the isolated pre-flight staticCall reverts on the allowance. It must not be
    // fatal, or the taker can never accept their first challenge.
    wallet.loginMethod = 'passkey'
    state.allowance = 0n
    state.staticCallReject = 'ERC20: transfer amount exceeds allowance'
    const { result } = renderHook(() => useOpenChallengeAccept())
    let res
    await act(async () => {
      res = await result.current.accept('river tiger kite zoo', 4n)
    })
    expect(res.txHash).toBe('0xpasskeytx')
    expect(wallet.sendCalls).toHaveBeenCalledTimes(1)
    expect(wallet.sendCalls.mock.calls[0][0]).toHaveLength(2) // approve + accept still submitted
  })

  it('still surfaces a real pre-flight revert (e.g. expired challenge) before sending', async () => {
    // The pre-flight staticCall lives on the passkey/sendCalls branch; the EOA path pre-flights
    // inside its own gasless seam.
    wallet.loginMethod = 'passkey'
    state.allowance = 0n
    state.staticCallReject = 'AcceptExpired()'
    const { result } = renderHook(() => useOpenChallengeAccept())
    let err
    await act(async () => {
      try { await result.current.accept('river tiger kite zoo', 4n) } catch (e) { err = e }
    })
    expect(err?.message).toMatch(/expired/i)
    expect(calls).toEqual([])
    expect(wallet.sendCalls).not.toHaveBeenCalled()
  })

  // #1292 — ISanctionsGuard's errors are not in the registry ABI the frontend ships, so a screened
  // taker's pre-flight arrives as a bare "unknown custom error" with the answer only in `data`.
  const encodeSanctioned = (address) => `${SANCTIONED_ADDRESS_SELECTOR}${address.slice(2).padStart(64, '0')}`

  it('names sanctions screening — not the raw custom error — when the TAKER is the screened party', async () => {
    wallet.loginMethod = 'passkey'
    state.staticCallReject = { data: encodeSanctioned(ACCOUNT) }
    const { result } = renderHook(() => useOpenChallengeAccept())
    let err
    await act(async () => {
      try { await result.current.accept('river tiger kite zoo', 4n) } catch (e) { err = e }
    })
    expect(err?.message).toMatch(/sanctions screening/i)
    expect(err?.message).toMatch(/your account/i)
    expect(err?.message).not.toMatch(/unknown custom error/i)
    expect(wallet.sendCalls).not.toHaveBeenCalled()
  })

  it('blames the CREATOR, not the taker, when the guard named the creator', async () => {
    // `_runAcceptGuard` screens both parties, so a creator listed after their challenge was posted
    // reverts every accept — with the CREATOR's address. Telling the taker their own clean account
    // was stopped would be a false compliance accusation.
    wallet.loginMethod = 'passkey'
    state.staticCallReject = { data: encodeSanctioned(CREATOR) }
    const { result } = renderHook(() => useOpenChallengeAccept())
    let err
    await act(async () => {
      try { await result.current.accept('river tiger kite zoo', 4n) } catch (e) { err = e }
    })
    expect(err?.message).toMatch(/other party's account/i)
    expect(err?.message).not.toMatch(/your account/i)
    expect(wallet.sendCalls).not.toHaveBeenCalled()
  })
})

// Spec 037, T004: structured, non-throwing lookup(code) used by the unified phrase lookup.
describe('useOpenChallengeAccept.lookup (structured outcome)', () => {
  beforeEach(() => { calls.length = 0; state.wagerId = 0n; state.throwLookup = false })

  it('returns not-found when the code maps to no open challenge (wagerId 0)', async () => {
    state.wagerId = 0n
    const { result } = renderHook(() => useOpenChallengeAccept())
    let res
    await act(async () => { res = await result.current.lookup('river tiger kite zoo') })
    expect(res.status).toBe('not-found')
    expect(res.reason).toBe('no-match')
    // A read-only lookup never signs or sends.
    expect(calls).toEqual([])
  })

  it('returns matched with the wager payload when the code resolves', async () => {
    state.wagerId = 4n
    const { result } = renderHook(() => useOpenChallengeAccept())
    let res
    await act(async () => { res = await result.current.lookup('river tiger kite zoo') })
    expect(res.status).toBe('matched')
    expect(res.payload.wagerId).toBe(4n)
    expect(res.payload.wager.creator).toBe(CREATOR)
    expect(calls).toEqual([])
  })

  it('returns errored (not not-found) when the on-chain read fails — so the UI can say "couldn\'t check"', async () => {
    state.throwLookup = true
    const { result } = renderHook(() => useOpenChallengeAccept())
    let res
    await act(async () => { res = await result.current.lookup('river tiger kite zoo') })
    expect(res.status).toBe('errored')
    expect(res.error).toBeInstanceOf(Error)
  })
})

// Spec 041: the lookup payload must carry the on-chain oracle linkage untouched, and a
// sealed terms bundle with an `oracle` block must reach the caller — the claimant view
// (TakeChallengePanel) renders the bet from exactly these fields. Accept is unchanged.
describe('useOpenChallengeAccept.lookup (oracle open challenges, spec 041)', () => {
  beforeEach(() => { calls.length = 0; state.wagerId = 7n; state.throwLookup = false; state.metadataUri = 'ipfs-enc://cid' })

  it('passes through resolutionType/polymarketConditionId/creatorIsYes and the sealed oracle block', async () => {
    const { parseEncryptedIpfsReference, fetchEncryptedEnvelope } = await import('../utils/ipfsService')
    const { decryptEnvelopeCode, isCodeEnvelope } = await import('../utils/crypto/envelopeEncryption.js')
    parseEncryptedIpfsReference.mockReturnValue({ isIpfs: true, cid: 'cid' })
    fetchEncryptedEnvelope.mockResolvedValue({ sealed: true })
    isCodeEnvelope.mockReturnValue(true)
    decryptEnvelopeCode.mockReturnValue({
      description: 'Will ETH flip BTC? — creator takes Yes · settled automatically by Polymarket',
      oracle: { source: 'polymarket', conditionId: '0xc0ffee', question: 'Will ETH flip BTC?', outcomes: ['Yes', 'No'], creatorSide: 0 },
    })

    const { result } = renderHook(() => useOpenChallengeAccept())
    let res
    await act(async () => { res = await result.current.lookup('river tiger kite zoo') })

    expect(res.status).toBe('matched')
    const { wager, terms, termsUnavailable } = res.payload
    expect(termsUnavailable).toBe(false)
    expect(wager.resolutionType).toBe(4n)
    expect(wager.polymarketConditionId).toBe('0xc0ffee')
    expect(wager.creatorIsYes).toBe(true)
    expect(terms.oracle).toMatchObject({ source: 'polymarket', conditionId: '0xc0ffee', outcomes: ['Yes', 'No'] })
    // Read-only — no approval/acceptance sent by a lookup.
    expect(calls).toEqual([])
  })
})
