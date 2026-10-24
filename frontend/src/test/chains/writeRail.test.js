/**
 * Which rail signs a write, and can it run here? (lib/chains/writeRail.js)
 *
 * The property under test is that a member holding a KEY is never refused because of how they
 * logged in. Ethereum Classic has no bundler, so the passkey UserOp rail cannot run there — but a
 * browser wallet, a Ledger, or an unlocked recovered account signs a Safe `approveHash` natively
 * and pays the fee in ETC. Routing those by `loginMethod` took that away from them.
 *
 * The reachability half (spec 110 T025) adds the second question a rail cannot answer on its own:
 * a signer that CAN sign is not a chain the write can be PLACED on. Its assertions are mostly
 * about what is NOT claimed — an unsupplied wallet location must come back `unchecked`, never
 * `reachable`, because a gate that reports "verified" from an absence of evidence is worse than
 * no gate at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const support = { supported: true, reason: null }
vi.mock('../../config/passkeySupport', () => ({
  getPasskeySupport: () => support,
  isPasskeySupported: () => support.supported,
}))

import { resolveWriteRail, requireWriteRail, RAILS, REACHABILITY } from '../../lib/chains/writeRail'

const SIGNER = { signTransaction: () => {} } // any ethers-shaped signer

beforeEach(() => {
  support.supported = true
  support.reason = null
})

describe('resolveWriteRail', () => {
  it('uses a SIGNER on a chain the passkey rail cannot reach — the case this exists for', () => {
    // Ethereum Classic: no bundler anywhere in the estate.
    support.supported = false
    support.reason = 'Passkey transactions are not enabled on this network yet'

    const out = resolveWriteRail({ chainId: 61, signer: SIGNER, loginMethod: 'passkey', chainName: 'Ethereum Classic' })

    expect(out.rail).toBe(RAILS.SIGNER)
    expect(out.available).toBe(true)
    expect(out.reason).toBeNull()
  })

  it('prefers the signer even when the passkey rail IS available — a key in hand beats a login label', () => {
    const out = resolveWriteRail({ chainId: 137, signer: SIGNER, loginMethod: 'passkey' })
    expect(out.rail).toBe(RAILS.SIGNER)
  })

  it('takes the passkey rail when there is no signer and the chain supports it', () => {
    const out = resolveWriteRail({ chainId: 137, signer: null, loginMethod: 'passkey' })
    expect(out.rail).toBe(RAILS.PASSKEY)
    expect(out.available).toBe(true)
  })

  it('refuses a keyless passkey session on an unsupported chain, NAMING the chain and the way out', () => {
    support.supported = false
    const out = resolveWriteRail({ chainId: 61, signer: null, loginMethod: 'passkey', chainName: 'Ethereum Classic' })

    expect(out.available).toBe(false)
    // Not merely "unsupported": a member can act on this sentence.
    expect(out.reason).toMatch(/Ethereum Classic/)
    expect(out.reason).toMatch(/hardware wallet|browser wallet|recovered account/i)
  })

  it('falls back to the chain id when no display name was supplied, rather than saying "undefined"', () => {
    support.supported = false
    const out = resolveWriteRail({ chainId: 63, signer: null, loginMethod: 'passkey' })
    expect(out.reason).toContain('chain 63')
    expect(out.reason).not.toMatch(/undefined|null/)
  })

  it('says to connect a wallet when there is neither a signer nor a passkey session', () => {
    const out = resolveWriteRail({ chainId: 61, signer: null, loginMethod: null, chainName: 'Ethereum Classic' })
    expect(out.rail).toBe(RAILS.NONE)
    expect(out.available).toBe(false)
    expect(out.reason).toMatch(/connect a wallet/i)
  })
})

describe('requireWriteRail', () => {
  it('throws the member-facing reason, so the refusal a caller surfaces is the one written here', () => {
    support.supported = false
    expect(() =>
      requireWriteRail({ chainId: 61, signer: null, loginMethod: 'passkey', chainName: 'Ethereum Classic' }),
    ).toThrow(/Ethereum Classic/)
  })

  it('returns the rail when it can run', () => {
    expect(requireWriteRail({ chainId: 61, signer: SIGNER, loginMethod: 'passkey' }).rail).toBe(RAILS.SIGNER)
  })
})

describe('resolveWriteRail — reachability', () => {
  it('reports UNCHECKED, never reachable, when the caller did not say where the wallet is', () => {
    // Every pre-T025 caller is this shape. Withheld judgement has to READ as withheld judgement:
    // if absence of evidence came back `reachable`, the flag would be worthless the day a surface
    // started trusting it.
    const out = resolveWriteRail({ chainId: 137, signer: SIGNER, loginMethod: 'injected' })
    expect(out.available).toBe(true)
    expect(out.reachability).toBe(REACHABILITY.UNCHECKED)
  })

  it('is REACHABLE when the wallet is already on the target chain, switch or no switch', () => {
    const out = resolveWriteRail({
      chainId: 137, signer: SIGNER, loginMethod: 'injected', walletChainId: 137, canSwitchChain: false,
    })
    expect(out.available).toBe(true)
    expect(out.reachability).toBe(REACHABILITY.REACHABLE)
  })

  it('refuses BEFORE the tap when the wallet is elsewhere and cannot change networks', () => {
    // This refusal used to come out of the middle of a submit, after the member had committed to
    // the action. It names both chains and what to do, because "wrong network" is not actionable.
    const out = resolveWriteRail({
      chainId: 8453, signer: SIGNER, loginMethod: 'injected',
      chainName: 'Base', walletChainId: 137, canSwitchChain: false,
    })
    expect(out.available).toBe(false)
    expect(out.reachability).toBe(REACHABILITY.UNREACHABLE)
    expect(out.reason).toMatch(/Base/)
    expect(out.reason).toMatch(/Polygon/)
    expect(out.reason).not.toMatch(/undefined|null|\[object/)
  })

  it('is REACHABLE from another chain when the session can switch', () => {
    const out = resolveWriteRail({
      chainId: 8453, signer: SIGNER, loginMethod: 'injected', walletChainId: 137, canSwitchChain: true,
    })
    expect(out.available).toBe(true)
    expect(out.reachability).toBe(REACHABILITY.REACHABLE)
  })

  it('does not consult the wallet at all on the passkey rail — it addresses the bundler directly', () => {
    // The whole multichain win: a passkey member on Polygon submitting to Base is never asked to
    // move, so where the wallet sits cannot make the rail unreachable.
    const out = resolveWriteRail({
      chainId: 8453, signer: null, loginMethod: 'passkey', walletChainId: 137, canSwitchChain: false,
    })
    expect(out.rail).toBe(RAILS.PASSKEY)
    expect(out.available).toBe(true)
    expect(out.reachability).toBe(REACHABILITY.REACHABLE)
  })

  it('refuses a chain this build is not configured for, even with a key in hand', () => {
    // There is no network definition to hand the wallet and no RPC behind it, so a signer being
    // present says nothing. Answering `available` here would be a confident wrong answer.
    const out = resolveWriteRail({ chainId: 424242, signer: SIGNER, loginMethod: 'injected' })
    expect(out.available).toBe(false)
    expect(out.rail).toBe(RAILS.NONE)
    expect(out.reachability).toBe(REACHABILITY.UNREACHABLE)
    expect(out.reason).toMatch(/not configured/i)
  })

  it('refuses a missing chain id rather than resolving it against the default network', () => {
    const out = resolveWriteRail({ chainId: null, signer: SIGNER, loginMethod: 'injected' })
    expect(out.available).toBe(false)
    expect(out.reason).toMatch(/this network/)
  })
})
