/**
 * The opening surface's venue work (spec 083, T050) — asserted directly, because these are the
 * parts that decide what a member signs.
 *
 * What is checked here, and why each one rather than left to a reviewer's eye:
 *
 *   - THE MEMBER IS `msg.sender`: the descriptor has nowhere to put an owner, and the calldata the
 *     hook builds from it names the member in every ownership field on both venues;
 *   - a venue handle is never guessed — a missing `pairIndex` or market address REFUSES with the
 *     venue named, rather than resolving to some other market;
 *   - `acceptablePrice` for an INCREASE is the mirror of the exit path's bound, in both directions
 *     (getting this backwards produces an order that can never fill);
 *   - eligibility fails CLOSED for every status that is not a positive "open";
 *   - the preview's numbers are estimates that go null rather than fabricated, and a zero rate
 *     produces no fee amount at all;
 *   - screening reads the cohort's reference chain and treats every failure as unconfirmed.
 */
import { describe, it, expect, vi } from 'vitest'
import { Interface, getAddress } from 'ethers'

import {
  buildOpenDescriptor,
  canOfferOpen,
  collateralSpenderFor,
  collateralUsdPrice,
  defaultReadAllowance,
  defaultReadCollateralBalances,
  defaultReadOpenQuote,
  defaultScreenAccount,
  estimateLiquidationPrice,
  increaseAcceptablePrice,
  normalizeVenueOptions,
  openEligibility,
  openVenueOptionsFor,
  previewOpen,
  resolveVenueHandle,
  toBaseUnits,
  toHumanAmount,
} from '../../components/perps/openPositionActions'
import { defaultBuildCalls, normalizeDescriptor } from '../../hooks/usePerpsTrade'
import { GAINS_DIAMOND_ABI } from '../../abis/perps/gainsDiamond'
import { GMX_EXCHANGE_ROUTER_ABI } from '../../abis/perps/gmxExchangeRouter'
import { GAINS_DIAMOND_BY_CHAIN, GMX_ADDRESSES_BY_CHAIN } from '../../config/perps'

const ARBITRUM = 42161
const MEMBER = '0xd504dC1ac094F45272f46b25A2874bDab45132Da'
/** The FairWins UI-fee receiver — the one FairWins address allowed anywhere in venue calldata. */
const FAIRWINS = '0x52502d049571C7893447b86c4d8B38e6184bF6e1'
const MARKET = '0x47c031236e19d024b42f8AE6780E44A573170703'
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'

const diamond = new Interface(GAINS_DIAMOND_ABI)
const exchangeRouter = new Interface(GMX_EXCHANGE_ROUTER_ABI)

const USDC_COLLATERAL = {
  symbol: 'USDC',
  address: USDC,
  decimals: 6,
  collateralIndex: 3,
  balance: 1_000_000_000n, // 1,000 USDC
  usdPrice: 1,
}

function gainsInput(overrides = {}) {
  return {
    venue: 'gains',
    chainId: ARBITRUM,
    handle: { pairIndex: 1 },
    isLong: true,
    collateral: USDC_COLLATERAL,
    collateralAmount: 100_000_000n, // 100 USDC
    leverage: 2,
    entryPrice: 60_000,
    notionalUsd: 200,
    venueLimits: { maxLeverage: 150 },
    slippagePct: 1,
    ...overrides,
  }
}

function gmxInput(overrides = {}) {
  return {
    venue: 'gmx',
    chainId: ARBITRUM,
    handle: { market: MARKET },
    isLong: true,
    collateral: USDC_COLLATERAL,
    collateralAmount: 100_000_000n,
    leverage: 2,
    entryPrice: 60_000,
    notionalUsd: 200,
    venueLimits: { maxLeverage: 50 },
    slippagePct: 1,
    quote: { executionFee: 10n ** 15n },
    uiFeeReceiver: FAIRWINS,
    ...overrides,
  }
}

/** Descriptor → the calls the wallet would actually be handed. */
function callsFor(built, account = MEMBER) {
  expect(built.ok).toBe(true)
  const spec = normalizeDescriptor(built.descriptor, { account })
  expect(spec.ok).toBe(true)
  return defaultBuildCalls(spec)
}

/* --------------------------------------------------------------------------------------------- *
 * Rule 1 — the member is always msg.sender
 * --------------------------------------------------------------------------------------------- */

describe('the member owns the position', () => {
  it('has nowhere in the descriptor to put an owner', () => {
    const built = buildOpenDescriptor(gainsInput())
    expect(built.ok).toBe(true)
    for (const field of ['trader', 'account', 'user', 'receiver', 'owner', 'cancellationReceiver']) {
      expect(built.descriptor.params).not.toHaveProperty(field)
      expect(built.descriptor).not.toHaveProperty(field)
    }
  })

  it('names the member in Gains’ own Trade.user, and sends no referrer at all', () => {
    // With an allowance already in place there is no approval leg, so the open is the only call.
    const [call] = callsFor(buildOpenDescriptor(gainsInput({ allowance: 10n ** 30n })))
    expect(call.target).toBe(GAINS_DIAMOND_BY_CHAIN[ARBITRUM])
    const [trade, slippage, referrer] = diamond.decodeFunctionData('openTrade', call.data)
    expect(getAddress(trade[0])).toBe(getAddress(MEMBER))
    expect(getAddress(trade[0])).not.toBe(getAddress(FAIRWINS))
    // 1e3 venue units: 1% tolerance, 2x leverage.
    expect(slippage).toBe(1_000n)
    expect(trade[3]).toBe(2_000n)
    // The zero address, NOT a FairWins address one field from `Trade.user`.
    expect(BigInt(referrer)).toBe(0n)
  })

  it('names the member as GMX’s receiver and FairWins only as the UI-fee receiver', () => {
    const [call] = callsFor(buildOpenDescriptor(gmxInput({ allowance: 10n ** 30n })))
    const [inner] = exchangeRouter.decodeFunctionData('multicall', call.data)
    const create = inner.find((data) => data.startsWith(exchangeRouter.getFunction('createOrder').selector))
    const [params] = exchangeRouter.decodeFunctionData('createOrder', create)
    const addresses = params[0]
    expect(getAddress(addresses[0])).toBe(getAddress(MEMBER)) // receiver
    expect(getAddress(addresses[1])).toBe(getAddress(MEMBER)) // cancellationReceiver
    expect(getAddress(addresses[3])).toBe(getAddress(FAIRWINS)) // uiFeeReceiver — the only one
  })

  it('approves the GMX Router, never the ExchangeRouter it calls', () => {
    // No allowance read ⇒ an approval leg. Its target is the collateral token, and the spender
    // inside it is the Router (the address that actually pulls tokens).
    const calls = callsFor(buildOpenDescriptor(gmxInput({ allowance: null })))
    expect(calls).toHaveLength(2)
    expect(getAddress(calls[0].target)).toBe(getAddress(USDC))
    expect(calls[0].data.toLowerCase()).toContain(GMX_ADDRESSES_BY_CHAIN[ARBITRUM].router.slice(2).toLowerCase())
    expect(calls[0].data.toLowerCase()).not.toContain(
      GMX_ADDRESSES_BY_CHAIN[ARBITRUM].exchangeRouter.slice(2).toLowerCase(),
    )
  })

  it('omits the approval when the member already has enough allowance', () => {
    const calls = callsFor(buildOpenDescriptor(gmxInput({ allowance: 100_000_000n })))
    expect(calls).toHaveLength(1)
  })

  it('includes the approval when the allowance could not be read — unknown is not zero-and-fine', () => {
    expect(buildOpenDescriptor(gainsInput({ allowance: null })).descriptor.approval).toEqual({
      token: USDC,
      amount: 100_000_000n,
    })
    expect(buildOpenDescriptor(gainsInput({ allowance: 99_999_999n })).descriptor.approval).not.toBeNull()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Rule 2 — a venue handle is never guessed
 * --------------------------------------------------------------------------------------------- */

describe('the venue’s own handle', () => {
  it('recovers a GMX market from the feed’s own pair id', () => {
    expect(resolveVenueHandle({ venue: 'gmx', pair: { id: `gmx:${ARBITRUM}:BTC/USD:${MARKET}` } })).toEqual({
      ok: true,
      market: MARKET,
    })
  })

  it('refuses rather than guessing when Gains’ pair number is missing', () => {
    const verdict = resolveVenueHandle({ venue: 'gains', pair: { id: `gains:${ARBITRUM}:BTC/USD` } })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/Gains/)
    expect(verdict.reason).toMatch(/could not be read/)
  })

  it('refuses rather than guessing when GMX’s market is missing', () => {
    expect(resolveVenueHandle({ venue: 'gmx', pair: { id: 'not-a-gmx-id' } }).ok).toBe(false)
  })

  it('refuses to build without the handle, even with everything else present', () => {
    expect(buildOpenDescriptor(gainsInput({ handle: {} })).ok).toBe(false)
    expect(buildOpenDescriptor(gmxInput({ handle: {} })).ok).toBe(false)
  })

  it('refuses a Gains collateral index of zero — the venue’s indices are 1-based', () => {
    const verdict = buildOpenDescriptor(
      gainsInput({ collateral: { ...USDC_COLLATERAL, collateralIndex: 0 } }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/collateral/)
  })
})

/* --------------------------------------------------------------------------------------------- *
 * The price bound — the mirror of the exit path, and the direction trap
 * --------------------------------------------------------------------------------------------- */

describe('the acceptable price for an increase', () => {
  it('is a MAXIMUM for a long and a MINIMUM for a short', () => {
    expect(increaseAcceptablePrice(100, true, 1)).toBeCloseTo(101, 9)
    expect(increaseAcceptablePrice(100, false, 1)).toBeCloseTo(99, 9)
  })

  it('is null rather than zero when the price is unreadable', () => {
    for (const junk of [null, undefined, 0, -1, 'abc', {}]) {
      expect(increaseAcceptablePrice(junk, true, 1)).toBeNull()
    }
  })

  it('reaches GMX’s calldata as the bound the member was shown', () => {
    const [call] = callsFor(buildOpenDescriptor(gmxInput({ allowance: 10n ** 30n })))
    const [inner] = exchangeRouter.decodeFunctionData('multicall', call.data)
    const create = inner.find((data) => data.startsWith(exchangeRouter.getFunction('createOrder').selector))
    const [params] = exchangeRouter.decodeFunctionData('createOrder', create)
    // numbers[3] is acceptablePrice in 1e30 units: 60,000 + 1%.
    expect(params[1][3]).toBe(60_600n * 10n ** 30n)
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Eligibility — fails closed, names the venue
 * --------------------------------------------------------------------------------------------- */

describe('what may be offered at all', () => {
  const base = {
    venue: 'gains',
    chainId: ARBITRUM,
    label: 'Gains',
    venueRef: { pairIndex: 1 },
    pair: { id: `gains:${ARBITRUM}:BTC/USD` },
  }

  it('offers a venue only when the venue itself says it is open', () => {
    expect(openEligibility({ ...base, status: 'open' }).ok).toBe(true)
  })

  it.each([
    ['close-only', /close-only/],
    ['paused', /paused/],
    ['not-deployed', /not available/],
    ['unreadable', /could not be confirmed/],
    [null, /could not be confirmed/],
    ['a status this build has never heard of', /could not be confirmed/],
  ])('refuses %s, with the venue named as the source', (status, expected) => {
    const verdict = openEligibility({ ...base, status })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/Gains/)
    expect(verdict.reason).toMatch(expected)
  })

  it('refuses a venue this build has no calldata path for on that chain', () => {
    const verdict = openEligibility({ venue: 'gmx', chainId: 137, label: 'GMX', status: 'open' })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/GMX/)
  })

  it('never says the exit is affected — this is an opening decision only', () => {
    for (const status of ['close-only', 'paused', 'unreadable']) {
      expect(openEligibility({ ...base, status }).reason).not.toMatch(/clos(e|ing) (your|this) position/i)
    }
  })
})

describe('normalizing the venue options', () => {
  it('treats the tapped pair as the single option when nothing else is supplied', () => {
    const pair = { id: `gains:${ARBITRUM}:BTC/USD`, venue: 'gains', chainId: ARBITRUM, symbol: 'BTC/USD' }
    expect(normalizeVenueOptions(pair, null)).toEqual([
      expect.objectContaining({ venue: 'gains', chainId: ARBITRUM, pair, label: 'Gains' }),
    ])
  })

  it('drops a venue this build does not know, rather than inventing one', () => {
    expect(normalizeVenueOptions(null, [{ venue: 'somevenue', chainId: 1 }])).toEqual([])
  })

  it('is total over junk', () => {
    expect(normalizeVenueOptions(null, null)).toEqual([])
    expect(normalizeVenueOptions(undefined, [null, 7, 'x'])).toEqual([])
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Honest numbers
 * --------------------------------------------------------------------------------------------- */

describe('amounts', () => {
  it('truncates below the token’s precision rather than rounding up', () => {
    expect(toBaseUnits('1.2345678', 6)).toBe(1_234_567n)
    expect(toBaseUnits('0.9999999', 6)).toBe(999_999n)
  })

  it('is null for junk and for unknown decimals — an amount in unknown units is not an amount', () => {
    for (const junk of ['', '.', 'abc', '-1', null, undefined]) expect(toBaseUnits(junk, 6)).toBeNull()
    expect(toBaseUnits('1', null)).toBeNull()
    expect(toHumanAmount(1_000_000n, null)).toBeNull()
  })
})

describe('the collateral’s dollar price', () => {
  it('never assumes a stablecoin is worth exactly one dollar', () => {
    expect(collateralUsdPrice({ symbol: 'USDC', decimals: 6, balance: 1_000_000n })).toBeNull()
  })

  it('prefers a published price, then derives one from the member’s own holding', () => {
    expect(collateralUsdPrice({ usdPrice: 0.99 })).toBe(0.99)
    expect(collateralUsdPrice({ decimals: 6, balance: 2_000_000n, usdValue: 1.98 })).toBeCloseTo(0.99, 9)
  })
})

describe('the liquidation estimate', () => {
  it('sits below entry for a long and above it for a short', () => {
    expect(estimateLiquidationPrice({ entryPrice: 100, leverage: 2, isLong: true })).toBeCloseTo(50, 9)
    expect(estimateLiquidationPrice({ entryPrice: 100, leverage: 2, isLong: false })).toBeCloseTo(150, 9)
    expect(estimateLiquidationPrice({ entryPrice: 100, leverage: 10, isLong: true })).toBeCloseTo(90, 9)
  })

  it('is null rather than fabricated when a direction or a leverage is missing', () => {
    expect(estimateLiquidationPrice({ entryPrice: 100, leverage: 2 })).toBeNull()
    expect(estimateLiquidationPrice({ entryPrice: 100, isLong: true })).toBeNull()
    expect(estimateLiquidationPrice(null)).toBeNull()
  })
})

describe('the preview', () => {
  const base = {
    collateralAmount: 100_000_000n,
    collateralDecimals: 6,
    collateralUsdPrice: 1,
    leverage: 10,
    entryPrice: 60_000,
    isLong: true,
  }

  it('sizes the position on the notional, and the fee on the notional too', () => {
    const preview = previewOpen({ ...base, feeBps: 5 })
    expect(preview.collateralUsd).toBeCloseTo(100, 9)
    expect(preview.notionalUsd).toBeCloseTo(1000, 9)
    // 5 bps of $1,000 of SIZE = $0.50 — which is 50 bps of the $100 actually put in.
    expect(preview.feeUsd).toBeCloseTo(0.5, 9)
    expect(preview.totalCostUsd).toBeCloseTo(100.5, 9)
  })

  it('produces no fee amount at all at a zero rate', () => {
    const preview = previewOpen({ ...base, feeBps: 0 })
    expect(preview.feeApplies).toBe(false)
    expect(preview.feeUsd).toBeNull()
    expect(preview.totalCostUsd).toBeCloseTo(100, 9)
  })

  it('goes null rather than fabricating when the collateral’s price is unknown', () => {
    const preview = previewOpen({ ...base, collateralUsdPrice: null, feeBps: 5 })
    expect(preview.collateralUsd).toBeNull()
    expect(preview.notionalUsd).toBeNull()
    expect(preview.feeUsd).toBeNull()
    expect(preview.totalCostUsd).toBeNull()
  })

  it('is total over junk', () => {
    expect(previewOpen(null).notionalUsd).toBeNull()
    expect(previewOpen({}).totalCostUsd).toBeNull()
  })

  /* ------------------------------------------------------------------------------------------- *
   * The VENUE's own fee in the preview
   *
   * The defect this closed: FairWins' fee was the only one with a number beside it, and the venue's
   * showed '—'. That does not read as "one is unknown" — it reads as though our fee were the cost
   * of trading, which is the opposite of what this disclosure exists to do.
   * ------------------------------------------------------------------------------------------- */

  /** BTC/USD's published gains fee, as the gateway normalizes it. */
  const BTC_FEE = { openRate: 0.00035, closeRate: 0.00035, feeFloorNotionalUsd: 285.715, minFeeUsd: 0.10000025 }

  it('charges the venue’s rate on SIZE and folds it into the total the member reads', () => {
    const preview = previewOpen({ ...base, feeBps: 5, venueFee: BTC_FEE })
    // 0.035% of the $1,000 position, not of the $100 put in.
    expect(preview.venueFeeUsd).toBeCloseTo(0.35, 9)
    expect(preview.venueFeeRate).toBe(0.00035)
    expect(preview.venueFeeChargedOnUsd).toBeCloseTo(1000, 9)
    expect(preview.venueFeeAtFloor).toBe(false)
    // $100 collateral + $0.50 FairWins + $0.35 venue.
    expect(preview.totalCostUsd).toBeCloseTo(100.85, 9)
  })

  it('names the venue’s fee floor when the position is under it', () => {
    // $10 collateral at 5× is a $50 position — below the venue's $285.715 fee floor, so gains
    // charges the fee of a floor-sized position. Reporting 0.035% × $50 would understate the real
    // cost nearly six times over.
    const preview = previewOpen({ ...base, collateralAmount: 10_000_000n, leverage: 5, feeBps: 0, venueFee: BTC_FEE })
    expect(preview.notionalUsd).toBeCloseTo(50, 9)
    expect(preview.venueFeeAtFloor).toBe(true)
    expect(preview.venueFeeUsd).toBeCloseTo(0.10000025, 12)
    expect(preview.venueFeeChargedOnUsd).toBeCloseTo(285.715, 9)
  })

  it('shows a dash rather than a zero when the venue publishes no rate', () => {
    const preview = previewOpen({ ...base, feeBps: 5, venueFee: null })
    expect(preview.venueFeeUsd).toBeNull()
    expect(preview.venueFeeRate).toBeNull()
    expect(preview.venueFeeAtFloor).toBe(false)
    // …and the total says so by omitting it, exactly as it did before this existed.
    expect(preview.totalCostUsd).toBeCloseTo(100.5, 9)
  })

  it('cannot state the venue’s fee when the size is unknown', () => {
    const preview = previewOpen({ ...base, collateralUsdPrice: null, feeBps: 5, venueFee: BTC_FEE })
    expect(preview.venueFeeUsd).toBeNull()
    expect(preview.totalCostUsd).toBeNull()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Refusals before any wallet prompt
 * --------------------------------------------------------------------------------------------- */

describe('refusing rather than throwing', () => {
  it.each([
    ['no amount', { collateralAmount: 0n }, /how much/i],
    ['no leverage', { leverage: null }, /leverage/i],
    ['no price', { entryPrice: null }, /price/i],
    ['no direction', { isLong: null }, /long or short/i],
    ['no chain', { chainId: null }, /network/i],
    ['no collateral address', { collateral: { ...USDC_COLLATERAL, address: null } }, /collateral/i],
  ])('refuses with a plain reason: %s', (_name, overrides, expected) => {
    const verdict = buildOpenDescriptor(gainsInput(overrides))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(expected)
  })

  it('refuses a GMX order whose keeper fee could not be read, naming GMX’s own app', () => {
    const verdict = buildOpenDescriptor(gmxInput({ quote: { failed: true } }))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/keeper fee/)
    expect(verdict.reason).toMatch(/on GMX/)
  })

  it('refuses a GMX order whose dollar size could not be worked out', () => {
    expect(buildOpenDescriptor(gmxInput({ notionalUsd: null })).ok).toBe(false)
  })

  it('never throws, whatever it is handed', () => {
    for (const junk of [null, undefined, {}, { venue: 'gains' }, { venue: 'nope', chainId: 1 }]) {
      expect(() => buildOpenDescriptor(junk)).not.toThrow()
      expect(buildOpenDescriptor(junk).ok).toBe(false)
    }
  })

  it('carries the checks the hook runs before signing, in matching units', () => {
    const { descriptor } = buildOpenDescriptor(gainsInput())
    expect(descriptor.validate.collateralAmount).toBe(100_000_000n)
    // Base units on BOTH sides — `validateOpen` refuses to compare a bigint to a human float.
    expect(descriptor.validate.balance).toBe(1_000_000_000n)
    expect(descriptor.validate.leverage).toBe(2)
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Reads — never assumed, always the venue's own
 * --------------------------------------------------------------------------------------------- */

describe('the venue reads', () => {
  it('has no keeper fee to read on a venue that charges none', async () => {
    await expect(defaultReadOpenQuote({ venue: 'gains', chainId: ARBITRUM })).resolves.toBeNull()
  })

  it('reports a GMX keeper fee it could not read as failed, never as zero', async () => {
    await expect(
      defaultReadOpenQuote({ venue: 'gmx', chainId: ARBITRUM, deps: { getClient: () => null } }),
    ).resolves.toEqual({ failed: true })
  })

  it('points a Gains approval at the diamond and a GMX one at the Router', () => {
    expect(collateralSpenderFor('gains', ARBITRUM)).toBe(GAINS_DIAMOND_BY_CHAIN[ARBITRUM])
    expect(collateralSpenderFor('gmx', ARBITRUM)).toBe(GMX_ADDRESSES_BY_CHAIN[ARBITRUM].router)
    expect(collateralSpenderFor('gmx', 137)).toBeNull()
  })

  it('returns null — “we could not ask” — rather than a zero allowance on failure', async () => {
    await expect(
      defaultReadAllowance({
        venue: 'gains',
        chainId: ARBITRUM,
        token: USDC,
        owner: MEMBER,
        getProvider: () => {
          throw new Error('endpoint down')
        },
      }),
    ).resolves.toBeNull()
  })

  it('reads the allowance from the venue’s own spender', async () => {
    const allowance = vi.fn(async () => 5n)
    await expect(
      defaultReadAllowance({
        venue: 'gains',
        chainId: ARBITRUM,
        token: USDC,
        owner: MEMBER,
        getProvider: () => ({}),
        makeContract: () => ({ allowance }),
      }),
    ).resolves.toBe(5n)
    expect(allowance).toHaveBeenCalledWith(MEMBER, GAINS_DIAMOND_BY_CHAIN[ARBITRUM])
  })
})

/* --------------------------------------------------------------------------------------------- *
 * The entry gate — fail-closed, and read where the guard actually lives
 * --------------------------------------------------------------------------------------------- */

describe('screening an open', () => {
  it('reads the cohort’s reference chain, not the venue’s chain', async () => {
    const getProvider = vi.fn(() => ({}))
    await defaultScreenAccount(MEMBER, ARBITRUM, {
      getProvider,
      chainId: 137,
      screen: async () => ({ allowed: true, available: true }),
    })
    // Arbitrum has no FairWins SanctionsGuard; screening there would refuse every member forever.
    expect(getProvider).toHaveBeenCalledWith(137)
    expect(getProvider).not.toHaveBeenCalledWith(ARBITRUM)
  })

  it('is clear only when the guard positively answered', async () => {
    const deps = (result) => ({ getProvider: () => ({}), chainId: 137, screen: async () => result })
    await expect(defaultScreenAccount(MEMBER, ARBITRUM, deps({ allowed: true, available: true }))).resolves.toBe('clear')
    await expect(defaultScreenAccount(MEMBER, ARBITRUM, deps({ allowed: false, available: true }))).resolves.toBe(
      'restricted',
    )
  })

  it.each([
    ['an unavailable guard', { allowed: false, available: false }],
    ['a nonsense answer', null],
  ])('is unconfirmed — never clear — for %s', async (_name, result) => {
    await expect(
      defaultScreenAccount(MEMBER, ARBITRUM, { getProvider: () => ({}), chainId: 137, screen: async () => result }),
    ).resolves.not.toBe('clear')
  })

  it('is unconfirmed for a missing account, a dead endpoint and a throwing guard', async () => {
    await expect(defaultScreenAccount('', ARBITRUM, {})).resolves.toBe('unconfirmed')
    await expect(
      defaultScreenAccount(MEMBER, ARBITRUM, { getProvider: () => null, chainId: 137 }),
    ).resolves.toBe('unconfirmed')
    await expect(
      defaultScreenAccount(MEMBER, ARBITRUM, {
        getProvider: () => ({}),
        chainId: 137,
        screen: async () => {
          throw new Error('reverted')
        },
      }),
    ).resolves.toBe('unconfirmed')
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Composing the venue options for a tapped pair row
 *
 * This is the seam between the FEED and the sheet, and every failure it can have is a member-facing
 * one: offering a chain they did not choose, offering an arbitrary one of two markets that share a
 * name, or offering a venue whose handle the feed never published.
 * --------------------------------------------------------------------------------------------- */

const gainsRow = (over = {}) => ({
  id: 'gains:42161:BTC/USD',
  venue: 'gains',
  chainId: ARBITRUM,
  symbol: 'BTC/USD',
  price: 60_000,
  maxLeverage: 150,
  minLeverage: 2,
  pairIndex: 4,
  collaterals: [{ symbol: 'USDC', address: USDC, decimals: 6, collateralIndex: 3, usdPrice: 1 }],
  ...over,
})
const gmxRow = (over = {}) => ({
  id: `gmx:42161:BTC/USD:${MARKET}`,
  venue: 'gmx',
  chainId: ARBITRUM,
  symbol: 'BTC/USD',
  price: 60_000,
  market: MARKET,
  collaterals: [{ symbol: 'USDC', address: USDC, decimals: 6, collateralIndex: null, usdPrice: 1 }],
  ...over,
})
const OPEN_STATUSES = { gains: { status: 'open' }, gmx: { status: 'open' } }

describe('composing the venue options for a tapped pair', () => {
  it('carries the venue’s own handles, limits and collateral set through to the option', () => {
    const row = gainsRow()
    const [option] = openVenueOptionsFor(row, [row], { statuses: OPEN_STATUSES })
    expect(option.venue).toBe('gains')
    expect(option.chainId).toBe(ARBITRUM)
    expect(option.venueRef).toEqual({ pairIndex: 4 })
    expect(option.limits).toEqual({ maxLeverage: 150, minLeverage: 2 })
    expect(option.collaterals).toBe(row.collaterals)
    // …and the option is genuinely openable, which is what makes the assertions above load-bearing.
    expect(openEligibility(option).ok).toBe(true)
  })

  it('carries the venue’s own fee and its own minimum through, straight off the feed row', () => {
    const venueFee = { openRate: 0.00035, closeRate: 0.00035, feeFloorNotionalUsd: 285.715, minFeeUsd: 0.10000025 }
    const row = gainsRow({ venueFee, minNotional: null, minCollateralUsd: 0.50000125 })
    const [option] = openVenueOptionsFor(row, [row], { statuses: OPEN_STATUSES })
    expect(option.venueFee).toBe(venueFee)
    expect(option.minCollateralUsd).toBeCloseTo(0.50000125, 10)
    // NULL ON PURPOSE, and this is the assertion that keeps it that way: gains' own
    // `minPositionSizeUsd` is a FEE FLOOR, not a minimum position size (v9 removed that check), so
    // publishing $285.72 as a minimum here would refuse a $100 position the venue would fill.
    expect(option.minNotional).toBeNull()
  })

  it('leaves the fee and the minimums null where the feed carried none', () => {
    const row = gainsRow()
    const [option] = openVenueOptionsFor(row, [row], { statuses: OPEN_STATUSES })
    expect(option.venueFee).toBeNull()
    expect(option.minCollateralUsd).toBeNull()
    expect(option.minNotional).toBeNull()
  })

  it('offers every venue that lists the market ON THE TAPPED ROW’S CHAIN, tapped venue first', () => {
    const rows = [gmxRow(), gainsRow()]
    const options = openVenueOptionsFor(gainsRow(), rows, { statuses: OPEN_STATUSES })
    // Input order is `pickVenue`'s tie-break, so the row the member actually chose must lead.
    expect(options.map((o) => o.venue)).toEqual(['gains', 'gmx'])
  })

  it('NEVER offers the same symbol on another chain — that is a different position', () => {
    // Gains lists BTC/USD on Arbitrum, Base and Polygon. Tapping the Polygon row must not silently
    // offer the Arbitrum market, which is a different market on a different network.
    const polygon = gainsRow({ id: 'gains:137:BTC/USD', chainId: 137 })
    const options = openVenueOptionsFor(polygon, [polygon, gainsRow(), gmxRow()], {
      statuses: OPEN_STATUSES,
    })
    expect(options).toHaveLength(1)
    expect(options[0].chainId).toBe(137)
  })

  it('drops a NON-tapped venue that lists two markets for one symbol, rather than picking one', () => {
    // "BTC/USD [WBTC.b-USDC]" and "BTC/USD [BTC-USDC]" are different markets with different
    // collateral. There is no non-arbitrary answer, and a wrong market on a leveraged position is
    // worse than no position — `gmxMarkets.js` refuses the same way.
    const rows = [
      gainsRow(),
      gmxRow({ id: `gmx:42161:BTC/USD:0x${'aa'.repeat(20)}`, market: `0x${'aa'.repeat(20)}` }),
      gmxRow({ id: `gmx:42161:BTC/USD:0x${'bb'.repeat(20)}`, market: `0x${'bb'.repeat(20)}` }),
    ]
    expect(openVenueOptionsFor(gainsRow(), rows, { statuses: OPEN_STATUSES }).map((o) => o.venue)).toEqual([
      'gains',
    ])
  })

  it('but the TAPPED row always settles its own venue, ambiguity or not', () => {
    // The member named the market by tapping it. The ambiguity above is about the OTHER venue.
    const tapped = gmxRow({ id: `gmx:42161:BTC/USD:0x${'aa'.repeat(20)}`, market: `0x${'aa'.repeat(20)}` })
    const rows = [tapped, gmxRow({ id: `gmx:42161:BTC/USD:0x${'bb'.repeat(20)}`, market: `0x${'bb'.repeat(20)}` })]
    const options = openVenueOptionsFor(tapped, rows, { statuses: OPEN_STATUSES })
    expect(options).toHaveLength(1)
    expect(options[0].venueRef.market).toBe(`0x${'aa'.repeat(20)}`)
  })

  it('never offers a non-EVM venue — Hyperliquid cannot reach a chainId seam at all', () => {
    const hl = { id: 'hyperliquid:BTC', venue: 'hyperliquid', chainId: null, symbol: 'BTC/USD' }
    expect(openVenueOptionsFor(hl, [hl], { statuses: OPEN_STATUSES })).toEqual([])
    // …and it is not admitted as a sibling of a real row either.
    expect(
      openVenueOptionsFor(gainsRow(), [gainsRow(), { ...hl, chainId: ARBITRUM }], { statuses: OPEN_STATUSES })
        .map((o) => o.venue),
    ).toEqual(['gains'])
  })

  it('builds the option with NO status when none was read, and that option is refused', () => {
    // The window between the tap and the status read. Silence is not permission (FR-017).
    const [option] = openVenueOptionsFor(gainsRow(), [gainsRow()], { statuses: null })
    expect(option.status).toBeNull()
    expect(openEligibility(option).ok).toBe(false)
    expect(openEligibility(option).reason).toMatch(/could not be confirmed/i)
  })

  it('builds the option with NO handle when the feed published none, and names the venue', () => {
    // An older gateway, or a row the venue described only partly. Refusing by name beats guessing
    // "the first BTC market".
    const bare = gainsRow({ pairIndex: undefined })
    const [option] = openVenueOptionsFor(bare, [bare], { statuses: OPEN_STATUSES })
    expect(option.venueRef).toBeNull()
    expect(openEligibility(option).reason).toMatch(/Gains/)
  })

  it('is total — junk in, empty out, never a throw', () => {
    for (const junk of [null, undefined, {}, { symbol: '' }, { symbol: 'BTC/USD' }, 7, 'x']) {
      expect(openVenueOptionsFor(junk, null, null)).toEqual([])
    }
  })
})

describe('canOfferOpen — the predicate that keeps the entry control from ever being dead', () => {
  const HOLDS_USDC = [{ symbol: 'USDC', address: USDC, decimals: 6, balance: 1_000_000n, usdValue: 1 }]

  it('is true only when a venue is open, manageable, resolvable AND funded', () => {
    const options = openVenueOptionsFor(gainsRow(), [gainsRow()], { statuses: OPEN_STATUSES })
    expect(canOfferOpen(options, HOLDS_USDC)).toBe(true)
  })

  it('is false when the member holds none of the accepted collateral', () => {
    const options = openVenueOptionsFor(gainsRow(), [gainsRow()], { statuses: OPEN_STATUSES })
    expect(canOfferOpen(options, [])).toBe(false)
    expect(canOfferOpen(options, null)).toBe(false)
    // A zero balance is not a holding — it cannot fund anything.
    expect(canOfferOpen(options, [{ symbol: 'USDC', address: USDC, decimals: 6, balance: 0n }])).toBe(false)
  })

  it('is false for a close-only venue even when the member is funded', () => {
    const options = openVenueOptionsFor(gainsRow(), [gainsRow()], {
      statuses: { gains: { status: 'close-only' } },
    })
    expect(canOfferOpen(options, HOLDS_USDC)).toBe(false)
  })

  it('is false for junk', () => {
    for (const junk of [null, undefined, [], 'x', 7]) expect(canOfferOpen(junk, HOLDS_USDC)).toBe(false)
  })
})

describe('reading the member’s collateral balances', () => {
  const options = () => openVenueOptionsFor(gainsRow(), [gainsRow(), gmxRow()], { statuses: OPEN_STATUSES })
  const erc20 = (balances) => (address) => ({ balanceOf: async () => balances[address.toLowerCase()] })

  it('reads each accepted token ONCE, even when two venues share it', async () => {
    const calls = []
    const held = await defaultReadCollateralBalances({
      chainId: ARBITRUM,
      account: MEMBER,
      venueOptions: options(),
      getProvider: () => ({}),
      makeContract: (address) => {
        calls.push(address)
        return { balanceOf: async () => 1_500_000n }
      },
    })
    expect(calls).toHaveLength(1) // Gains and GMX both accept USDC — one read, not two
    expect(held).toEqual([
      { symbol: 'USDC', address: USDC, decimals: 6, balance: 1_500_000n, usdValue: 1.5 },
    ])
  })

  it('prices the holding from the VENUE’s own price, never from an assumed peg', async () => {
    const depegged = gainsRow({
      collaterals: [{ symbol: 'USDC', address: USDC, decimals: 6, collateralIndex: 3, usdPrice: 0.97 }],
    })
    const [held] = await defaultReadCollateralBalances({
      chainId: ARBITRUM,
      account: MEMBER,
      venueOptions: openVenueOptionsFor(depegged, [depegged], { statuses: OPEN_STATUSES }),
      getProvider: () => ({}),
      makeContract: erc20({ [USDC.toLowerCase()]: 1_000_000n }),
    })
    expect(held.usdValue).toBeCloseTo(0.97, 10)
  })

  it('leaves the value NULL when the venue did not price the collateral — never 0, never $1', async () => {
    const unpriced = gainsRow({
      collaterals: [{ symbol: 'WETH', address: MARKET, decimals: 18, collateralIndex: 5, usdPrice: null }],
    })
    const [held] = await defaultReadCollateralBalances({
      chainId: ARBITRUM,
      account: MEMBER,
      venueOptions: openVenueOptionsFor(unpriced, [unpriced], { statuses: OPEN_STATUSES }),
      getProvider: () => ({}),
      makeContract: erc20({ [MARKET.toLowerCase()]: 10n ** 18n }),
    })
    expect(held.balance).toBe(10n ** 18n)
    expect(held.usdValue).toBeNull()
  })

  it('OMITS a token whose balance could not be read — an unreadable balance is not a zero one', async () => {
    const held = await defaultReadCollateralBalances({
      chainId: ARBITRUM,
      account: MEMBER,
      venueOptions: options(),
      getProvider: () => ({}),
      makeContract: () => ({
        balanceOf: async () => {
          throw new Error('endpoint down')
        },
      }),
    })
    // Absent, not `{ balance: 0n }` — the consequence is "this venue is not offered", which is
    // honest, rather than "you hold nothing", which is a claim about the member's wallet.
    expect(held).toEqual([])
  })

  it('omits a zero balance too — it cannot fund a position', async () => {
    const held = await defaultReadCollateralBalances({
      chainId: ARBITRUM,
      account: MEMBER,
      venueOptions: options(),
      getProvider: () => ({}),
      makeContract: erc20({ [USDC.toLowerCase()]: 0n }),
    })
    expect(held).toEqual([])
  })

  it('is total — no account, no provider, a throwing provider factory, all yield []', async () => {
    const base = { chainId: ARBITRUM, venueOptions: options() }
    await expect(defaultReadCollateralBalances({ ...base, account: '' })).resolves.toEqual([])
    await expect(
      defaultReadCollateralBalances({ ...base, account: MEMBER, getProvider: () => null }),
    ).resolves.toEqual([])
    await expect(
      defaultReadCollateralBalances({
        ...base,
        account: MEMBER,
        getProvider: () => {
          throw new Error('no endpoint')
        },
      }),
    ).resolves.toEqual([])
    await expect(defaultReadCollateralBalances()).resolves.toEqual([])
    await expect(
      defaultReadCollateralBalances({ chainId: ARBITRUM, account: MEMBER, venueOptions: null }),
    ).resolves.toEqual([])
  })
})
