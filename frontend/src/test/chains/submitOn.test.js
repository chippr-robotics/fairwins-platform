/**
 * Spec 110 T024 — `submitOn(chainId, payload)`.
 *
 * The assertions that matter here are NEGATIVE ones: that the passkey and intent rails never call
 * `switchNetwork`, and that every refusal path signs nothing. A test that only checked the returned
 * value would pass just as happily on a seam that prompted the member for a network change it did
 * not need, or that switched the wallet and then refused — which is the worse half of a bad
 * refusal, because the member is left somewhere they did not ask to be.
 */

import { describe, it, expect, vi } from 'vitest'
import { submitOn, ChainSwitchRefused, RAILS, SETTLE_TIMEOUT_MS, SETTLE_POLL_MS } from '../../lib/chains/submitOn'

const BASE = 8453
const POLYGON = 137
const NAMES = { [BASE]: 'Base', [POLYGON]: 'Polygon', 61: 'Ethereum Classic' }
const chainName = (id) => NAMES[Number(id)] || `Chain ${id}`

const PAYLOAD = { calls: [{ to: '0x' + '11'.repeat(20), data: '0xabcd' }] }

/** A wallet snapshot that can be moved, the way a real one moves across renders. */
function wallet({ chainId = POLYGON, signer = { id: 'signer' }, provider = { id: 'provider' } } = {}) {
  const state = { chainId, signer, provider }
  return {
    read: () => ({ ...state }),
    moveTo(next, over = {}) {
      Object.assign(state, { chainId: next, ...over })
    },
    state,
  }
}

/**
 * The rail decision is INJECTED for the routing tests. Whether a given chain carries a deployed
 * bundler is a deployment fact, and a unit test that depended on it would start failing the day a
 * contract landed on one more network — it would be asserting the estate, not this seam. One test
 * below deliberately uses the REAL resolver, to prove the two are actually wired together.
 */
const railing = (rail) => () => ({ rail, available: true, reason: null })

const io = (over = {}) => ({
  readWallet: over.wallet?.read ?? wallet().read,
  chainName,
  sleep: async () => {},
  sendWithSigner: vi.fn(async () => ({ hash: '0xsigner' })),
  sendPasskeyBatch: vi.fn(async () => ({ hash: '0xpasskey' })),
  submitIntent: vi.fn(async () => ({ hash: '0xintent' })),
  switchNetwork: vi.fn(async () => {}),
  ...over,
})

describe('submitOn — the rails that carry the chain never move the wallet', () => {
  it('passkey: submits to the TARGET chain with no switch, from a wallet sitting elsewhere', async () => {
    const w = wallet({ chainId: POLYGON, signer: null }) // no browser key ⇒ passkey rail
    const deps = io({ wallet: w, loginMethod: 'passkey', address: '0xacct', resolveRail: railing(RAILS.PASSKEY) })
    const out = await submitOn(BASE, PAYLOAD, deps)

    expect(out).toMatchObject({ rail: RAILS.PASSKEY, chainId: BASE })
    expect(deps.sendPasskeyBatch).toHaveBeenCalledWith(expect.objectContaining({ chainId: BASE, address: '0xacct' }))
    // THE POINT: the member was never asked to change networks, and did not.
    expect(deps.switchNetwork).not.toHaveBeenCalled()
    expect(w.state.chainId).toBe(POLYGON)
    expect(deps.sendWithSigner).not.toHaveBeenCalled()
  })

  it('intent: signs against the target chain with no switch, and beats the signer rail when preferred', async () => {
    const w = wallet({ chainId: POLYGON })
    const deps = io({ wallet: w, preferIntent: true })
    const out = await submitOn(BASE, PAYLOAD, deps)

    expect(out).toMatchObject({ rail: 'intent', chainId: BASE })
    expect(deps.submitIntent).toHaveBeenCalledWith(expect.objectContaining({ chainId: BASE }))
    expect(deps.switchNetwork).not.toHaveBeenCalled()
    expect(deps.sendWithSigner).not.toHaveBeenCalled()
  })
})

describe('submitOn — the signer rail is the only one that switches', () => {
  it('does not switch when the wallet is already on the target chain', async () => {
    const deps = io({ wallet: wallet({ chainId: BASE }) })
    const out = await submitOn(BASE, PAYLOAD, deps)
    expect(out.rail).toBe(RAILS.SIGNER)
    expect(deps.switchNetwork).not.toHaveBeenCalled()
  })

  it('switches, waits for the wallet to settle, and signs with the POST-switch signer', async () => {
    const w = wallet({ chainId: POLYGON, signer: { id: 'stale' } })
    const deps = io({
      wallet: w,
      // A real switch lands a render later, and the signer is re-bound to the new chain with it.
      switchNetwork: vi.fn(async () => w.moveTo(BASE, { signer: { id: 'fresh' } })),
    })
    const out = await submitOn(BASE, PAYLOAD, deps)

    expect(deps.switchNetwork).toHaveBeenCalledWith(BASE)
    expect(out).toMatchObject({ rail: RAILS.SIGNER, chainId: BASE })
    // The stale signer captured at tap time must never be the one that signs.
    expect(deps.sendWithSigner).toHaveBeenCalledWith(expect.objectContaining({ signer: { id: 'fresh' }, chainId: BASE }))
  })

  it('waits for the signer too, not just the chain id', async () => {
    const w = wallet({ chainId: POLYGON, signer: { id: 'stale' } })
    let polls = 0
    const deps = io({
      wallet: w,
      // Chain lands first, signer a beat later — the window where a naive loop signs with nothing.
      switchNetwork: vi.fn(async () => w.moveTo(BASE, { signer: null })),
      sleep: async () => {
        polls += 1
        if (polls === 2) w.moveTo(BASE, { signer: { id: 'fresh' } })
      },
    })
    await submitOn(BASE, PAYLOAD, deps)
    expect(polls).toBeGreaterThanOrEqual(2)
    expect(deps.sendWithSigner).toHaveBeenCalledWith(expect.objectContaining({ signer: { id: 'fresh' } }))
  })

  it('a passkey session is NOT waited on for a browser signer it can never have', async () => {
    // The signer rail with a passkey login: no key will ever appear in the browser, so waiting for
    // one would spin to the deadline and refuse a write that was fine. Only the CHAIN is waited on.
    const w = wallet({ chainId: POLYGON, signer: null })
    const deps = io({
      wallet: w,
      loginMethod: 'passkey',
      resolveRail: railing(RAILS.SIGNER),
      switchNetwork: vi.fn(async () => w.moveTo(BASE, { signer: null })),
    })
    const out = await submitOn(BASE, PAYLOAD, deps)
    expect(out).toMatchObject({ rail: RAILS.SIGNER, chainId: BASE })
    expect(deps.sendWithSigner).toHaveBeenCalledWith(expect.objectContaining({ chainId: BASE, signer: null }))
  })

  it('refuses when the chosen rail has no submitter wired, rather than silently doing nothing', async () => {
    const deps = io({ wallet: wallet({ chainId: BASE, signer: null }), resolveRail: railing(RAILS.PASSKEY) })
    await expect(submitOn(BASE, PAYLOAD, { ...deps, sendPasskeyBatch: undefined })).rejects.toThrow(
      /passkey rail was chosen but no sendPasskeyBatch/i,
    )
  })
})

/**
 * The race `useWrapNative` (spec 108) had already met and written down, which T026's shared loop
 * did not carry because the three hooks it was extracted from had not met it.
 *
 * The context's chainId comes from the connector's `chainChanged` event; the chain-scoped signer is
 * rebuilt by an async effect a beat later. In between, the snapshot pairs the NEW chain with the
 * PRE-switch signer — and ethers only rejects that with "network changed: A => B" AFTER
 * broadcasting, so the member has signed and the transaction is already gone.
 */
describe('submitOn — a signer that exists is not yet a signer that is THERE', () => {
  const signerOn = (id, chainId) => ({ id, provider: { getNetwork: async () => ({ chainId: BigInt(chainId) }) } })

  it('keeps waiting while the snapshot pairs the new chain with the PRE-switch signer', async () => {
    const stale = signerOn('stale', POLYGON)
    const fresh = signerOn('fresh', BASE)
    const w = wallet({ chainId: POLYGON, signer: stale })
    let polls = 0
    const deps = io({
      wallet: w,
      // The chain lands first, still carrying the Polygon-bound signer — the exact window.
      switchNetwork: vi.fn(async () => w.moveTo(BASE, { signer: stale })),
      sleep: async () => {
        polls += 1
        if (polls === 2) w.moveTo(BASE, { signer: fresh })
      },
    })
    await submitOn(BASE, PAYLOAD, deps)

    // THE POINT: the stale signer was on screen as `signer` with the right chainId, and was not used.
    expect(deps.sendWithSigner).toHaveBeenCalledWith(expect.objectContaining({ signer: fresh }))
    expect(deps.sendWithSigner).not.toHaveBeenCalledWith(expect.objectContaining({ signer: stale }))
    expect(polls).toBeGreaterThanOrEqual(2)
  })

  it('accepts a signer with no provider to ask — an absent check is not a failed one', async () => {
    // Waiting for an answer that can never come would spin to the deadline and refuse a write that
    // was fine, which is how the check would turn into the bug it exists to prevent.
    const w = wallet({ chainId: POLYGON, signer: { id: 'plain' } })
    const deps = io({ wallet: w, switchNetwork: vi.fn(async () => w.moveTo(BASE, { signer: { id: 'plain' } })) })
    await submitOn(BASE, PAYLOAD, deps)
    expect(deps.sendWithSigner).toHaveBeenCalledWith(expect.objectContaining({ signer: { id: 'plain' } }))
  })

  it('is not consulted on a passkey session, which has no browser signer to verify', async () => {
    const w = wallet({ chainId: POLYGON, signer: null })
    const deps = io({
      wallet: w,
      loginMethod: 'passkey',
      resolveRail: railing(RAILS.SIGNER),
      switchNetwork: vi.fn(async () => w.moveTo(BASE, { signer: null })),
    })
    const out = await submitOn(BASE, PAYLOAD, deps)
    expect(out).toMatchObject({ rail: RAILS.SIGNER, chainId: BASE })
  })
})

describe('submitOn — a refusal names both chains and signs nothing', () => {
  it('names where the wallet is AND where the write was going when the switch is refused', async () => {
    const deps = io({
      wallet: wallet({ chainId: POLYGON }),
      switchNetwork: vi.fn(async () => {
        throw new Error('user rejected')
      }),
    })
    const err = await submitOn(BASE, PAYLOAD, deps).catch((e) => e)

    expect(err).toBeInstanceOf(ChainSwitchRefused)
    expect(err.message).toContain('Base')
    expect(err.message).toContain('Polygon')
    expect(err.message).toMatch(/nothing has been signed/i)
    expect(err).toMatchObject({ from: POLYGON, to: BASE })
    expect(err.cause).toBeInstanceOf(Error)
    expect(deps.sendWithSigner).not.toHaveBeenCalled()
  })

  it('refuses rather than signing when the wallet cannot switch at all', async () => {
    const deps = io({ wallet: wallet({ chainId: POLYGON }), switchNetwork: undefined })
    const err = await submitOn(BASE, PAYLOAD, deps).catch((e) => e)
    expect(err).toBeInstanceOf(ChainSwitchRefused)
    expect(deps.sendWithSigner).not.toHaveBeenCalled()
  })

  it('refuses when the wallet agreed but never arrived, and still signs nothing', async () => {
    const w = wallet({ chainId: POLYGON })
    let t = 0
    const deps = io({
      wallet: w,
      switchNetwork: vi.fn(async () => {}), // agreed, but the wallet never lands
      sleep: async () => {
        t += SETTLE_POLL_MS
        vi.setSystemTime(Date.now() + SETTLE_POLL_MS * 4)
      },
    })
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const err = await submitOn(BASE, PAYLOAD, deps).catch((e) => e)
    vi.useRealTimers()

    expect(err).toBeInstanceOf(ChainSwitchRefused)
    expect(err.message).toMatch(/did not complete/i)
    expect(err.message).toContain('Base')
    expect(deps.sendWithSigner).not.toHaveBeenCalled()
    expect(t).toBeGreaterThan(0)
  })

  it('passes through the rail resolver’s own refusal instead of inventing a second wording', async () => {
    // ETC (61) has no bundler, and a passkey session has no key — resolveWriteRail already writes
    // the member-facing sentence for this, naming the way out.
    const deps = io({ wallet: wallet({ chainId: POLYGON, signer: null }), loginMethod: 'passkey' })
    const err = await submitOn(61, PAYLOAD, deps).catch((e) => e)

    expect(err).toBeInstanceOf(ChainSwitchRefused)
    expect(err.message).toMatch(/Ethereum Classic/)
    expect(err.message).toMatch(/connect a wallet that can sign there/i)
    expect(deps.sendPasskeyBatch).not.toHaveBeenCalled()
    expect(deps.switchNetwork).not.toHaveBeenCalled()
  })

  it('refuses a write that does not name its chain — the whole point of the seam', async () => {
    await expect(submitOn(undefined, PAYLOAD, io())).rejects.toThrow(/must name the chain/i)
    await expect(submitOn(Number.NaN, PAYLOAD, io())).rejects.toThrow(/must name the chain/i)
  })
})

describe('submitOn — the settle constants are decided once', () => {
  it('exports ONE timeout and poll interval', () => {
    // The three copies this replaces disagreed (20s/150ms vs 30s/250ms), so the same wallet on the
    // same chain got different patience depending on which button was pressed. Nothing chose that.
    expect(SETTLE_TIMEOUT_MS).toBe(20_000)
    expect(SETTLE_POLL_MS).toBe(150)
  })
})
