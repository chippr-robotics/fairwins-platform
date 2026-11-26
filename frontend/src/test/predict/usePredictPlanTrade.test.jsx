/**
 * usePredictPlanTrade (spec 114 slice 5) — reading → plan → fees → REVIEW → sign. The properties that carry the
 * money: no signature before review; a reading that is not live yields no figures and no signing; an
 * unconfirmed fee blocks signing; the order is re-planned against the CURRENT reading when Sign is pressed and,
 * when the reviewed limit no longer reaches the depth, NOTHING is signed and the new figures come back for
 * review; the order that IS signed carries the REVIEWED limit. Region, network and signer-rail gates are the
 * existing ones (usePredictTrade), driven here through the plan hook.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import { WalletContext } from '../../contexts/WalletContext.js'
import { usePredictPlanTrade } from '../../hooks/usePredictPlanTrade'
import { unknown } from '../../lib/markets/priceReading'
import { liquid, bookReading, TOKEN } from './ticketFixtures'

const TRADER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const FEE = { feeRateBps: 100, builderTakerFeeBps: 50, builderMakerFeeBps: 0 }
const CREDS = { key: 'k', secret: 's', passphrase: 'p' }

function makeDeps(over = {}) {
  return {
    checkGeoblock: vi.fn().mockResolvedValue({ blocked: false, ok: true }),
    fetchFeeRate: vi.fn().mockResolvedValue(FEE),
    ensureCreds: vi.fn().mockResolvedValue(CREDS),
    makeClient: vi.fn(() => ({ id: 'clob-client' })),
    makeBuilderConfig: vi.fn(() => undefined),
    submitOrder: vi.fn().mockResolvedValue({ orderId: '0xlegacy', status: 'live' }),
    submitRestingOrder: vi.fn().mockResolvedValue({ orderId: '0xresting', status: 'live' }),
    submitMarketOrder: vi.fn().mockResolvedValue({ orderId: '0xmarket', status: 'matched' }),
    cancelOrder: vi.fn(),
    resolveTradeSigner: vi.fn(() => ({ canSign: true, kind: 'eoa', address: TRADER })),
    loadCachedCreds: vi.fn(() => CREDS), // trading already enabled unless a test says otherwise
    gatewayUrl: vi.fn(() => ''),
    ...over,
  }
}

const wrapperFor = (walletOver = {}) => {
  const wallet = { address: TRADER, loginMethod: 'wallet', switchChain: vi.fn().mockResolvedValue(), ...walletOver }
  return ({ children }) => <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
}

const base = (deps, over = {}) => ({ tokenId: TOKEN, reading: liquid(), side: 'buy', typed: '50', deps, ...over })

async function ready(deps, props = {}, walletOver = {}) {
  const hook = renderHook((p) => usePredictPlanTrade(p), { initialProps: base(deps, props), wrapper: wrapperFor(walletOver) })
  await waitFor(() => expect(hook.result.current.fee).toBe(FEE))
  return hook
}

const nothingSigned = (deps) => {
  expect(deps.ensureCreds).not.toHaveBeenCalled()
  expect(deps.makeClient).not.toHaveBeenCalled()
  expect(deps.submitMarketOrder).not.toHaveBeenCalled()
  expect(deps.submitOrder).not.toHaveBeenCalled()
  expect(deps.submitRestingOrder).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  setWalletChain(137)
})

describe('usePredictPlanTrade — before review', () => {
  it('checks the region and the fees once, then plans from the live reading — and requests NO signature', async () => {
    const deps = makeDeps()
    const { result } = await ready(deps)
    expect(deps.checkGeoblock).toHaveBeenCalledTimes(1)
    expect(deps.fetchFeeRate).toHaveBeenCalledWith(137, TOKEN)
    expect(result.current.state).toBe('planning')
    expect(result.current.view).toMatchObject({ status: 'ok', payAtMost: '50', limitPrice: '0.95' })
    expect(result.current.quote.feeLines.map((l) => l.label)).toEqual(['FairWins builder fee'])
    expect(result.current.quote.builderFeeUnits).toBe(250000n)
    nothingSigned(deps)
  })

  it('nothing typed: idle, and Review is refused', async () => {
    const deps = makeDeps()
    const { result } = await ready(deps, { typed: '' })
    expect(result.current.state).toBe('idle')
    let accepted
    act(() => {
      accepted = result.current.review()
    })
    expect(accepted).toBe(false)
    expect(result.current.state).toBe('idle')
  })

  it('a reading that is not live: waiting-price, NO figure at all, and Review does nothing (FR-013)', async () => {
    for (const reading of [liquid({ age: 6000 }), liquid({ age: 31000 }), unknown('not-yet-read')]) {
      const deps = makeDeps()
      const { result } = await ready(deps, { reading })
      expect(result.current.state).toBe('waiting-price')
      expect(result.current.view).toEqual({ status: 'not-live' })
      expect(result.current.quote).toBeNull()
      let accepted
      act(() => {
        accepted = result.current.review()
      })
      expect(accepted).toBe(false)
      expect(result.current.state).toBe('waiting-price')
      nothingSigned(deps)
    }
  })

  it('BLOCKS when the fee cannot be confirmed — no review, no signing (spec 057 FR-010)', async () => {
    const deps = makeDeps({ fetchFeeRate: vi.fn().mockRejectedValue(new Error('down')) })
    const { result } = renderHook(() => usePredictPlanTrade(base(deps)), { wrapper: wrapperFor() })
    await waitFor(() => expect(result.current.state).toBe('blocked'))
    expect(result.current.reason).toMatch(/confirm the fees/i)
    expect(result.current.quote).toBeNull()
    let accepted
    act(() => {
      accepted = result.current.review()
    })
    expect(accepted).toBe(false)
    nothingSigned(deps)
  })

  it('a restricted region is refused before any fee or signature (geoblock stays a browser call)', async () => {
    const deps = makeDeps({ checkGeoblock: vi.fn().mockResolvedValue({ blocked: true, country: 'US', ok: true }) })
    const { result } = renderHook(() => usePredictPlanTrade(base(deps)), { wrapper: wrapperFor() })
    await waitFor(() => expect(result.current.state).toBe('geoblocked'))
    expect(result.current.geoInfo).toMatchObject({ country: 'US' })
    expect(deps.fetchFeeRate).not.toHaveBeenCalled()
    nothingSigned(deps)
  })

  it('an account that cannot sign is blocked with its reason', async () => {
    const deps = makeDeps({ resolveTradeSigner: vi.fn(() => ({ canSign: false, kind: 'none', reason: 'Connect a wallet to trade.' })) })
    const { result } = renderHook(() => usePredictPlanTrade(base(deps)), { wrapper: wrapperFor() })
    await waitFor(() => expect(result.current.state).toBe('blocked'))
    expect(result.current.reason).toBe('Connect a wallet to trade.')
    expect(result.current.canTrade).toBe(false)
  })
})

describe('usePredictPlanTrade — review, then sign', () => {
  it('Review freezes the figures and signs nothing; Edit goes back, still nothing signed', async () => {
    const deps = makeDeps()
    const { result } = await ready(deps)
    act(() => {
      expect(result.current.review()).toBe(true)
    })
    expect(result.current.state).toBe('review')
    expect(result.current.reviewed).toMatchObject({ payAtMost: '50', limitPrice: '0.95', signed: { amount: '50' } })
    expect(result.current.reviewedQuote.totalCostUnits).toBe(50_250000n)
    expect(result.current.reviewedCeiling.totalCostUnits).toBe(50_250000n)
    nothingSigned(deps)
    act(() => result.current.edit())
    expect(result.current.state).toBe('planning')
    expect(result.current.reviewed).toBeNull()
    nothingSigned(deps)
  })

  it('Sign with an unchanged book: signs through the SDK with the REVIEWED amount and limit, fill-and-kill path', async () => {
    const deps = makeDeps()
    const { result } = await ready(deps, { negRisk: true })
    act(() => result.current.review())
    await act(async () => {
      await result.current.confirm()
    })
    expect(result.current.state).toBe('done')
    expect(deps.submitMarketOrder).toHaveBeenCalledTimes(1)
    const [client, order] = deps.submitMarketOrder.mock.calls[0]
    expect(client).toEqual({ id: 'clob-client' })
    expect(order).toEqual({ tokenId: TOKEN, side: 'BUY', amount: '50', limitPrice: '0.95', negRisk: true, tickSize: '0.01' })
    expect(deps.submitOrder).not.toHaveBeenCalled()
    expect(result.current.result).toMatchObject({ kind: 'submitted', orderId: '0xmarket', status: 'matched' })
  })

  it('the first trade enables trading (creds) before the order, and says so while it does', async () => {
    let release
    const deps = makeDeps({
      loadCachedCreds: vi.fn(() => null),
      ensureCreds: vi.fn(() => new Promise((r) => { release = () => r(CREDS) })),
    })
    const { result } = await ready(deps)
    act(() => result.current.review())
    let p
    act(() => {
      p = result.current.confirm()
    })
    await waitFor(() => expect(result.current.state).toBe('enabling'))
    expect(deps.submitMarketOrder).not.toHaveBeenCalled()
    deps.ensureCreds.mockResolvedValue(CREDS)
    await act(async () => {
      release()
      await p
    })
    expect(deps.submitMarketOrder).toHaveBeenCalledTimes(1)
  })

  it('MOVED before the ceremonies: asks beyond the reviewed limit ⇒ nothing signed, the new figures to review, no creds touched (FR-021)', async () => {
    const deps = makeDeps()
    const { result, rerender } = await ready(deps)
    act(() => result.current.review())
    const reviewedLimit = result.current.reviewed.limitPrice
    expect(reviewedLimit).toBe('0.95')
    rerender(base(deps, { reading: bookReading({ asks: [['0.97', '1000']] }) }))
    let out
    await act(async () => {
      out = await result.current.confirm()
    })
    expect(out).toEqual({ moved: true })
    expect(result.current.state).toBe('moved')
    expect(result.current.notice).toMatchObject({ code: 'moved', reason: 'beyond-limit' })
    expect(result.current.reviewed.limitPrice).toBe('0.98') // the NEW figures, shown for review again
    nothingSigned(deps)

    // Sign again on the (unchanged) new book: the order carries the limit the member has now reviewed.
    await act(async () => {
      await result.current.confirm()
    })
    expect(result.current.state).toBe('done')
    expect(deps.submitMarketOrder.mock.calls[0][1]).toMatchObject({ limitPrice: '0.98', amount: '50' })
  })

  it('a book that got BETTER still signs — with the reviewed limit, never a tighter one invented at sign time', async () => {
    const deps = makeDeps()
    const { result, rerender } = await ready(deps)
    act(() => result.current.review())
    rerender(base(deps, { reading: bookReading({ asks: [['0.90', '1000']] }) }))
    await act(async () => {
      await result.current.confirm()
    })
    expect(result.current.state).toBe('done')
    expect(deps.submitMarketOrder.mock.calls[0][1].limitPrice).toBe('0.95')
  })

  it('the reading stops being live during review: the review is closed by the hook, back to waiting, nothing signed', async () => {
    const deps = makeDeps()
    const { result, rerender } = await ready(deps)
    act(() => result.current.review())
    rerender(base(deps, { reading: liquid({ age: 6000 }) }))
    // The review is closed by the hook itself (FR-013) — no figure from a price that is not live.
    await waitFor(() => expect(result.current.state).toBe('waiting-price'))
    expect(result.current.reviewed).toBeNull()
    expect(result.current.notice).toMatchObject({ code: 'not-live' })
    nothingSigned(deps)
  })

  it('time passes with no new reading and no re-render: Sign measures the age itself and refuses a price that has gone stale', async () => {
    const deps = makeDeps()
    const { result } = await ready(deps)
    act(() => result.current.review())
    const real = performance.now.bind(performance)
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => real() + 10_000)
    let out
    await act(async () => {
      out = await result.current.confirm()
    })
    spy.mockRestore()
    expect(out).toEqual({ moved: true })
    expect(result.current.notice).toMatchObject({ code: 'not-live' })
    nothingSigned(deps)
  })

  it('MOVED during the ceremonies: re-planned again right before the order is built (the member can take minutes)', async () => {
    let release
    const deps = makeDeps({ ensureCreds: vi.fn(() => new Promise((r) => { release = () => r(CREDS) })) })
    const { result, rerender } = await ready(deps)
    act(() => result.current.review())
    let p
    act(() => {
      p = result.current.confirm()
    })
    await waitFor(() => expect(deps.ensureCreds).toHaveBeenCalled())
    // While the member is in the wallet prompt the book moves.
    rerender(base(deps, { reading: bookReading({ asks: [['0.97', '1000']] }) }))
    let out
    await act(async () => {
      release()
      out = await p
    })
    expect(out).toEqual({ moved: true })
    expect(result.current.state).toBe('moved')
    expect(deps.makeClient).not.toHaveBeenCalled()
    expect(deps.submitMarketOrder).not.toHaveBeenCalled()
  })

  it('the venue refusing to match at the limit is "the market moved": back to a fresh review, never an order "sent"', async () => {
    const deps = makeDeps({ submitMarketOrder: vi.fn().mockRejectedValue(new Error('no orders found to match with FAK order')) })
    const { result } = await ready(deps)
    act(() => result.current.review())
    await act(async () => {
      await result.current.confirm()
    })
    expect(result.current.state).toBe('moved')
    expect(result.current.notice).toMatchObject({ code: 'moved', reason: 'venue' })
    expect(result.current.result).toBeNull()
  })

  it('a submit-time geoblock (403) is the region state', async () => {
    const err = Object.assign(new Error('Trading restricted in your region'), { raw: { status: 403 } })
    const deps = makeDeps({ submitMarketOrder: vi.fn().mockRejectedValue(err) })
    const { result } = await ready(deps)
    act(() => result.current.review())
    await act(async () => {
      await result.current.confirm()
    })
    expect(result.current.state).toBe('geoblocked')
  })

  it('wrong network: the switch is attempted at Sign, and a refusal signs nothing (FR-021 of 057)', async () => {
    setWalletChain(1)
    const switchChain = vi.fn().mockRejectedValue(new Error('declined'))
    const deps = makeDeps()
    const { result } = await ready(deps, {}, { switchChain })
    expect(result.current.onWrongNetwork).toBe(true)
    act(() => result.current.review())
    await act(async () => {
      await result.current.confirm()
    })
    expect(result.current.state).toBe('error')
    expect(result.current.reason).toMatch(/Polygon/)
    expect(deps.submitMarketOrder).not.toHaveBeenCalled()
  })

  it('a plain failure is an honest error with the reason, and Edit recovers the ticket', async () => {
    const deps = makeDeps({ submitMarketOrder: vi.fn().mockRejectedValue(new Error('market is closed')) })
    const { result } = await ready(deps)
    act(() => result.current.review())
    await act(async () => {
      await result.current.confirm()
    })
    expect(result.current.state).toBe('error')
    expect(result.current.reason).toBe('market is closed')
    act(() => result.current.edit())
    expect(result.current.state).toBe('planning')
  })

  it('a balance or allowance shortfall is an error that says so — NOT "the market moved" (it would never succeed on a re-sign)', async () => {
    for (const said of ['not enough balance / allowance', 'insufficient balance']) {
      const deps = makeDeps({ submitMarketOrder: vi.fn().mockRejectedValue(Object.assign(new Error(said), { status: 400 })) })
      const { result, unmount } = await ready(deps)
      act(() => result.current.review())
      let out
      await act(async () => {
        out = await result.current.confirm()
      })
      expect(out).toBeNull()
      expect(result.current.state).toBe('error')
      expect(result.current.notice).toBeNull()
      expect(result.current.reason).toMatch(/does not have enough|not allowed/)
      expect(result.current.reason).toMatch(/Nothing was placed/)
      unmount()
    }
  })

  it('OUTCOME UNKNOWN: an answer that never arrived is neither sent nor failed, and there is no way back to Sign', async () => {
    const lost = Object.assign(new Error('Polymarket did not confirm whether it received this order.'), { outcomeUnknown: true })
    const deps = makeDeps({ submitMarketOrder: vi.fn().mockRejectedValue(lost) })
    const { result } = await ready(deps)
    act(() => result.current.review())
    let out
    await act(async () => {
      out = await result.current.confirm()
    })
    expect(out).toEqual({ outcomeUnknown: true })
    expect(result.current.state).toBe('unknown')
    expect(result.current.reason).toMatch(/may have been placed/)
    expect(result.current.reason).toMatch(/before you send anything again/)
    expect(result.current.result).toBeNull()
    // Edit must not turn an unknown outcome back into a signable ticket, and Sign does nothing.
    act(() => result.current.edit())
    expect(result.current.state).toBe('unknown')
    await act(async () => {
      await result.current.confirm()
    })
    expect(deps.submitMarketOrder).toHaveBeenCalledTimes(1)
  })

  it('two Sign presses delivered before a re-render post ONE order', async () => {
    const deps = makeDeps()
    const { result } = await ready(deps)
    act(() => result.current.review())
    await act(async () => {
      // Both calls close over the same render: `confirming` is false in each.
      const confirm = result.current.confirm
      await Promise.all([confirm(), confirm()])
    })
    expect(deps.submitMarketOrder).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('done')
  })

  it('enabling trading is noticed in the same session: the next order does not run the setup again', async () => {
    let cached = null
    const deps = makeDeps({
      loadCachedCreds: vi.fn(() => cached),
      ensureCreds: vi.fn(async () => {
        cached = CREDS
        return CREDS
      }),
    })
    const { result } = await ready(deps)
    expect(result.current.tradingEnabled).toBe(false)
    act(() => result.current.review())
    await act(async () => {
      await result.current.confirm()
    })
    expect(result.current.state).toBe('done')
    expect(result.current.tradingEnabled).toBe(true)
  })
})

describe('usePredictPlanTrade — the order types and the signer rails', () => {
  it('a named price rests (GTC) with whole-hundredth shares at that price, ON THE TICK IT WAS REVIEWED ON', async () => {
    const deps = makeDeps()
    const { result } = await ready(deps, { ownPrice: '0.57' })
    expect(result.current.view).toMatchObject({ kind: 'resting', shares: '87.71', payAtMost: '49.9947' })
    act(() => result.current.review())
    await act(async () => {
      await result.current.confirm()
    })
    expect(deps.submitRestingOrder).toHaveBeenCalledTimes(1)
    const [client, order] = deps.submitRestingOrder.mock.calls[0]
    expect(client).toEqual({ id: 'clob-client' })
    // The tick travels with the order so the SDK refuses, rather than re-rounds, if the venue's tick is now coarser.
    expect(order).toStrictEqual({ tokenId: TOKEN, side: 'BUY', price: '0.57', size: '87.71', negRisk: undefined, tickSize: '0.01' })
    expect(deps.submitMarketOrder).not.toHaveBeenCalled()
    expect(deps.submitOrder).not.toHaveBeenCalled()
  })

  it('negRisk is passed only when STATED: unknown is left out so the SDK asks the venue, never signed as false', async () => {
    for (const [given, sent] of [[true, true], [false, false], [undefined, undefined], [null, null]]) {
      const deps = makeDeps()
      const { result, unmount } = await ready(deps, { negRisk: given })
      act(() => result.current.review())
      await act(async () => {
        await result.current.confirm()
      })
      expect(deps.submitMarketOrder.mock.calls[0][1].negRisk).toBe(sent)
      unmount()
    }
  })

  it('FEES: an order that rests is quoted at the MAKER rate; its ceiling allows for the taker rate and says it is contingent', async () => {
    const deps = makeDeps()
    // 57¢ is below the best ask (93¢): it rests.
    const { result } = await ready(deps, { ownPrice: '0.57' })
    expect(result.current.view.crossesBook).toBe(false)
    expect(result.current.quote.builderFeeUnits).toBe(0n) // maker rate is 0 bps
    expect(result.current.quote.feeLines).toEqual([])
    expect(result.current.ceiling.contingent).toBe(true)
    expect(result.current.ceiling.builderFeeUnits).toBeGreaterThan(0n) // taker rate: 50 bps of 49.9947
    expect(result.current.ceiling.totalCostUnits).toBe(result.current.ceiling.notionalUnits + result.current.ceiling.builderFeeUnits)
  })

  it('FEES: a named price that crosses the book fills at once — the TAKER rate, on both the quote and the ceiling', async () => {
    const deps = makeDeps()
    const { result } = await ready(deps, { ownPrice: '0.95' })
    expect(result.current.view).toMatchObject({ kind: 'resting', crossesBook: true })
    expect(result.current.quote.builderFeeUnits).toBeGreaterThan(0n)
    expect(result.current.ceiling.contingent).toBe(false)
    expect(result.current.ceiling.builderFeeUnits).toBe(result.current.quote.builderFeeUnits)
  })

  it('a sell signs the shares at the limit below the worst bid', async () => {
    const deps = makeDeps()
    const { result } = await ready(deps, { side: 'sell', typed: '100' })
    act(() => result.current.review())
    await act(async () => {
      await result.current.confirm()
    })
    expect(deps.submitMarketOrder.mock.calls[0][1]).toEqual({ tokenId: TOKEN, side: 'SELL', amount: '100', limitPrice: '0.92', tickSize: '0.01' })
  })

  it('CUSTODY: a passkey session signs through the same ERC-1271 client (signatureType 3, maker == funder == the account)', async () => {
    const SHIM = { getAddress: async () => TRADER, _signTypedData: async () => '0xenvelope' }
    const deps = makeDeps({
      resolveTradeSigner: vi.fn(() => ({ canSign: true, kind: 'passkey', address: TRADER, credentialId: 'cred-1' })),
      makePasskeySigner: vi.fn().mockResolvedValue(SHIM),
      missingApprovals: vi.fn().mockResolvedValue([]),
      readSession: vi.fn(() => ({ credentialId: 'cred-1' })),
    })
    const { result } = await ready(deps, {}, { loginMethod: 'passkey', sendCalls: vi.fn() })
    act(() => result.current.review())
    await act(async () => {
      await result.current.confirm()
    })
    expect(result.current.state).toBe('done')
    const [signerArg, creds, opts] = deps.makeClient.mock.calls[0]
    expect(signerArg).toBe(SHIM)
    expect(creds).toEqual(CREDS)
    expect(opts).toMatchObject({ signatureType: 3, funderAddress: TRADER })
  })

  it('a passkey first trade batches the approvals BEFORE the order, exactly as the fixed-price path does', async () => {
    const SHIM = { getAddress: async () => TRADER, _signTypedData: async () => '0xenvelope' }
    const order = []
    const sendCalls = vi.fn(async () => {
      order.push('approvals')
    })
    const deps = makeDeps({
      loadCachedCreds: vi.fn(() => null),
      resolveTradeSigner: vi.fn(() => ({ canSign: true, kind: 'passkey', address: TRADER, credentialId: 'cred-1' })),
      makePasskeySigner: vi.fn().mockResolvedValue(SHIM),
      missingApprovals: vi.fn().mockResolvedValue([{ target: '0xUSDC', data: '0x1' }]),
      readSession: vi.fn(() => ({ credentialId: 'cred-1' })),
      ensureCreds: vi.fn(async () => {
        order.push('creds')
        return CREDS
      }),
      submitMarketOrder: vi.fn(async () => {
        order.push('order')
        return { orderId: '0x1', status: 'matched' }
      }),
    })
    const { result } = await ready(deps, {}, { loginMethod: 'passkey', sendCalls })
    act(() => result.current.review())
    await act(async () => {
      await result.current.confirm()
    })
    expect(sendCalls).toHaveBeenCalledWith([{ target: '0xUSDC', data: '0x1' }], { chainId: 137 })
    expect(order.indexOf('approvals')).toBeLessThan(order.indexOf('creds'))
    expect(order[order.length - 1]).toBe('order')
  })

  it('changing the outcome voids any review', async () => {
    const deps = makeDeps()
    const { result, rerender } = await ready(deps)
    act(() => result.current.review())
    expect(result.current.state).toBe('review')
    rerender(base(deps, { tokenId: 'other-token' }))
    expect(result.current.state).toBe('planning')
    expect(result.current.reviewed).toBeNull()
  })
})
