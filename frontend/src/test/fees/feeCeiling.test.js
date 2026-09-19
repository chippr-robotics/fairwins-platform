/**
 * Spec 067 T119 — the platform-fee CEILING contract, on both surfaces.
 *
 * Three properties are asserted here and nowhere else, because each one is silent when
 * it breaks — the app still renders, still submits, and only the member's money notices:
 *
 *   1. THE QUOTED RATE IS A HARD CEILING. Whatever rate the confirm step disclosed is
 *      the exact number encoded as `maxFeeBps` in the calldata (FR-028). The rate moving
 *      on-chain after the quote cannot raise what was signed — it can only make the
 *      transaction revert, which is the protection working.
 *
 *   2. A ZERO RATE RENDERS NO FEE LINE AT ALL — not a line reading 0.00 (FR-029), and a
 *      bridge-liquidity deposit shows none at ANY rate, because there is no lever there
 *      to charge with (research R3). A 0.00 line would advertise a fee that does not
 *      exist and a control that cannot be turned.
 *
 *   3. AN UNREADABLE FeeRouter BLOCKS RATHER THAN ASSUMING ZERO (FR-051 / spec 060
 *      FR-015). Failing to read a rate is not evidence of a lower rate. The undeployed
 *      case stays a separate answer: that one is honestly fee-free and proceeds.
 *
 * Both call builders are exercised through their real ABIs and the calldata is decoded,
 * so a wrong argument position — a `maxFeeBps` that silently lands on a deadline — fails
 * here instead of on-chain.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Interface } from 'ethers'

const m = vi.hoisted(() => ({ fns: {}, address: null }))

// Only the FeeRouter read is faked — at the spec-110 chain seam it now rides;
// every Interface/decode path stays real ethers (cross-library byte parity).
vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (_chainId, { functionName, args }) => {
      const f = m.fns[functionName]
      if (!f) throw new Error('unmocked contract method: ' + functionName)
      return f(...(args || []))
    },
  }
})

vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: vi.fn(() => m.address),
}))

import {
  FEE_SERVICES,
  FeeQuoteUnavailable,
  fetchFeeQuote,
  maxFeeBpsFor,
  splitFee,
} from '../../lib/fees/feeQuote'
import { BRIDGE_QUOTE_LINE, buildBridgeQuote } from '../../lib/bridge/acrossQuotes'
import { buildBridgeCalls } from '../../lib/bridge/bridgeRouter'
import { buildSupplyCalls, maxSupplyFee, POOL_KIND, supplyMinimums } from '../../lib/liquidity/liquidityRouter'
import { feeCeilingCopy, liquidityFeeCopy } from '../../lib/liquidity/liquidityCopy'
import { BRIDGE_ROUTER_ABI } from '../../abis/BridgeRouter'
import { LIQUIDITY_ROUTER_ABI } from '../../abis/LiquidityRouter'

const BRIDGE_IFACE = new Interface(BRIDGE_ROUTER_ABI)
const LIQUIDITY_IFACE = new Interface(LIQUIDITY_ROUTER_ABI)

const ROUTER = '0x1111111111111111111111111111111111111111'
const FEE_ROUTER = '0x00000000000000000000000000000000000000f1'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const POOL = '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8'
const ROUTE_ID = '0x00000000000000000000000000000000000000000000000000000000000000a1'
const POOL_ID = '0x00000000000000000000000000000000000000000000000000000000000000b2'
const DEADLINE = 1_800_000_000

/** A live registered service: `feeBps` inside its own immutable `capBps`. */
const service = (feeBps, capBps = 250) => async () => ({
  kind: 1n,
  feeBps: BigInt(feeBps),
  capBps: BigInt(capBps),
})

const route = { routeId: ROUTE_ID, inputToken: USDC_POLYGON, outputToken: USDC, destinationChainId: 1, enabled: true, nativeInput: false, maxAmount: 0n }
const pool = {
  poolId: POOL_ID,
  kind: POOL_KIND.TRADING_LP,
  enabled: true,
  feeTier: 3000,
  token0: USDC,
  token1: WETH,
  poolAddress: POOL,
  maxDeposit0PerTx: 0n,
  maxDeposit1PerTx: 0n,
}

/** A coherent Across response for the NET amount handed to it. */
const suggestedForNet = (net) => ({
  outputAmount: (BigInt(net) - 3_500_000n).toString(),
  totalRelayFee: { total: '3500000' },
  lpFee: { total: '1000000' },
  relayerCapitalFee: { total: '1500000' },
  relayerGasFee: { total: '1000000' },
  quoteTimestamp: '1799999900',
  fillDeadline: '1800003600',
  exclusivityDeadline: '0',
})

/** The disclosure the member reads, for a 1,000 USDC bridge at `bps`. */
function bridgeQuoteAt(bps) {
  const gross = 1_000_000_000n
  const { feeAmount, netAmount } = splitFee(gross, bps)
  return buildBridgeQuote({
    suggested: suggestedForNet(netAmount),
    inputAmount: gross,
    feeAmount,
    platformFeeBps: bps,
    tokenSymbol: 'USDC',
    decimals: 6,
    originChainId: 137,
    destinationChainId: 1,
    inputToken: USDC_POLYGON,
    outputToken: USDC,
    fetchedAt: 1_800_000_000_000,
  })
}

/** What the member would actually sign for that quote. */
const bridgeCalldata = (quote) =>
  BRIDGE_IFACE.decodeFunctionData(
    'bridgeWithFee',
    buildBridgeCalls({
      routerAddress: ROUTER,
      route,
      inputAmount: BigInt(quote.inputAmount),
      outputAmount: BigInt(quote.outputAmount),
      recipient: '0x2222222222222222222222222222222222222222',
      quoteTimestamp: Number(quote.quoteTimestamp),
      fillDeadline: Number(quote.fillDeadline),
      exclusivityDeadline: 0,
      maxFeeBps: quote.platformFeeBps,
    }).calls.at(-1).data,
  )

const supplyCalldata = (maxFeeBps) =>
  LIQUIDITY_IFACE.decodeFunctionData(
    'mintFullRangeWithFee',
    buildSupplyCalls({
      routerAddress: ROUTER,
      pool,
      amount0Desired: 1_000_000_000n,
      amount1Desired: 500_000_000_000_000_000n,
      // Real slippage bounds, as the shipped caller passes. They are required arguments: a supply
      // built without them mints at any price, which is the sandwich exposure the security review
      // found when the only production caller was letting them default to zero.
      ...supplyMinimums({
        amount0Desired: 1_000_000_000n,
        amount1Desired: 500_000_000_000_000_000n,
        bps: maxFeeBps ?? 0,
      }),
      deadline: DEADLINE,
      maxFeeBps,
    }).calls.at(-1).data,
  )

beforeEach(() => {
  m.fns = {}
  m.address = null
})

// ─────────────────────────────────────────────────────────────────────────────────────
// 3. Unreadable BLOCKS; undeployed is a different, honest answer (T115)
// ─────────────────────────────────────────────────────────────────────────────────────

describe('fetchFeeQuote — an unread rate is never a zero rate (T115, FR-051)', () => {
  it('answers fee-free for a chain with NO router, without erroring', async () => {
    const quote = await fetchFeeQuote({ serviceId: FEE_SERVICES.BRIDGE_TRANSFER, chainId: 63, provider: {} })
    expect(quote).toEqual({ available: false, bps: 0, capBps: 0, routerAddress: null })
    // …and that answer is a usable ceiling of zero, not a block.
    expect(maxFeeBpsFor(quote)).toBe(0)
  })

  it('BLOCKS when a deployed router cannot be read, naming the fee as what failed', async () => {
    m.address = FEE_ROUTER
    m.fns.getService = async () => {
      throw new Error('rpc down')
    }
    const err = await fetchFeeQuote({
      serviceId: FEE_SERVICES.LIQUIDITY_DEPOSIT,
      chainId: 137,
      provider: {},
    }).catch((e) => e)
    expect(err).toBeInstanceOf(FeeQuoteUnavailable)
    expect(err.code).toBe('router_unreadable')
    expect(err.routerAddress).toBe(FEE_ROUTER)
    expect(err.message).toMatch(/rpc down/)
    expect(err.failed).toBe(true)
  })

  it('BLOCKS when there is no connection to read a deployed router over', async () => {
    m.address = FEE_ROUTER
    const err = await fetchFeeQuote({
      serviceId: FEE_SERVICES.BRIDGE_TRANSFER,
      chainId: 137,
      provider: null,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(FeeQuoteUnavailable)
    expect(err.code).toBe('no_provider')
  })

  it('BLOCKS a rate that fails its own cap rather than disclosing it as a ceiling', async () => {
    m.address = FEE_ROUTER
    m.fns.getService = service(400, 250) // 4% against a 2.5% immutable cap — impossible on-chain
    const err = await fetchFeeQuote({
      serviceId: FEE_SERVICES.LIQUIDITY_DEPOSIT,
      chainId: 137,
      provider: {},
    }).catch((e) => e)
    expect(err).toBeInstanceOf(FeeQuoteUnavailable)
    expect(err.code).toBe('rate_unusable')
  })

  it('a registered service sitting at zero is a READ rate, not a blocked one', async () => {
    m.address = FEE_ROUTER
    m.fns.getService = service(0)
    const quote = await fetchFeeQuote({ serviceId: FEE_SERVICES.BRIDGE_TRANSFER, chainId: 137, provider: {} })
    expect(quote).toMatchObject({ available: true, bps: 0 })
    expect(maxFeeBpsFor(quote)).toBe(0)
  })
})

describe('maxFeeBpsFor — the only thing that turns a quote into a signed ceiling', () => {
  it('returns exactly the quoted rate', () => {
    expect(maxFeeBpsFor({ available: true, bps: 50, capBps: 250 })).toBe(50)
  })

  it('refuses a rate that has not been read yet — no defaulting to zero', () => {
    // A zero ceiling for an unknown rate would revert on-chain rather than overcharge,
    // but it sends the member to a wallet prompt for a transfer that cannot succeed.
    expect(() => maxFeeBpsFor(null)).toThrow(FeeQuoteUnavailable)
    expect(() => maxFeeBpsFor(undefined)).toThrow(/no ceiling/)
  })

  it('refuses the failed sentinel the surfaces store when the read did not come back', () => {
    const err = (() => {
      try {
        maxFeeBpsFor({ failed: true, available: false, bps: 0 })
        return null
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(FeeQuoteUnavailable)
    expect(err.code).toBe('router_unreadable')
  })

  it('refuses a quote whose rate is above its own cap or outside 0…10000', () => {
    expect(() => maxFeeBpsFor({ available: true, bps: 400, capBps: 250 })).toThrow(/not a usable ceiling/)
    expect(() => maxFeeBpsFor({ available: true, bps: 10_001, capBps: 10_001 })).toThrow(FeeQuoteUnavailable)
    expect(() => maxFeeBpsFor({ available: true, bps: -1, capBps: 250 })).toThrow(FeeQuoteUnavailable)
    expect(() => maxFeeBpsFor({ available: true, bps: 12.5, capBps: 250 })).toThrow(FeeQuoteUnavailable)
  })

  it('re-throws a FeeQuoteUnavailable handed to it instead of swallowing it', () => {
    const cause = new FeeQuoteUnavailable('nope', { code: 'no_provider' })
    expect(() => maxFeeBpsFor(cause)).toThrow(cause)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────
// 1. The disclosed rate IS the signed ceiling (T113/T114)
// ─────────────────────────────────────────────────────────────────────────────────────

describe('the quoted rate is a hard ceiling — bridge (T113, FR-028)', () => {
  it('signs the exact rate the confirm step disclosed', async () => {
    m.address = FEE_ROUTER
    m.fns.getService = service(50)
    const quote = await fetchFeeQuote({ serviceId: FEE_SERVICES.BRIDGE_TRANSFER, chainId: 137, provider: {} })
    const disclosed = maxFeeBpsFor(quote)
    const bridge = bridgeQuoteAt(disclosed)

    // What the member reads…
    expect(bridge.platformFeeBps).toBe(50)
    expect(bridge.platformFeeRaw).toBe('5000000') // 5 USDC of 1,000, exactly
    // …is what the router is authorized to charge, and no more.
    expect(Number(bridgeCalldata(bridge).maxFeeBps)).toBe(50)
  })

  it('a rate raised on-chain AFTER the quote cannot raise what was signed', async () => {
    m.address = FEE_ROUTER
    m.fns.getService = service(50)
    const quote = await fetchFeeQuote({ serviceId: FEE_SERVICES.BRIDGE_TRANSFER, chainId: 137, provider: {} })
    const bridge = bridgeQuoteAt(maxFeeBpsFor(quote))

    // The operator moves the rate to the cap between quote and signature.
    m.fns.getService = service(250)

    // The calldata still carries the disclosed 50 bps: on-chain the raised rate now
    // exceeds the ceiling and the transaction reverts, which is the member being
    // protected — never charged the higher rate.
    expect(Number(bridgeCalldata(bridge).maxFeeBps)).toBe(50)
    expect(bridge.platformFeeBps).toBe(50)
  })

  it('carries a zero ceiling on a chain with no fee system, so any charge would revert', () => {
    const bridge = bridgeQuoteAt(0)
    expect(Number(bridgeCalldata(bridge).maxFeeBps)).toBe(0)
  })
})

describe('the quoted rate is a hard ceiling — liquidity supply (T114, FR-028)', () => {
  it('signs the disclosed rate, positioned as maxFeeBps and nothing else', async () => {
    m.address = FEE_ROUTER
    m.fns.getService = service(25)
    const quote = await fetchFeeQuote({ serviceId: FEE_SERVICES.LIQUIDITY_DEPOSIT, chainId: 137, provider: {} })
    const decoded = supplyCalldata(maxFeeBpsFor(quote))
    expect(Number(decoded.maxFeeBps)).toBe(25)
    // Guards the argument ORDER: a maxFeeBps that landed on the deadline would still be 25.
    expect(Number(decoded.deadline)).toBe(DEADLINE)
    expect(decoded.amount0Desired).toBe(1_000_000_000n)
  })

  it('refuses to build calldata without a quoted rate — a ceiling cannot be defaulted', () => {
    expect(() => supplyCalldata(undefined)).toThrow(/maxFeeBps must be the quoted rate/)
  })

  it('discloses a CEILING, never a figure taken off the gross', () => {
    // The fee lands on the capital the pool actually consumed. The disclosed figure is
    // the fee on everything entered, which is the most it can ever be.
    const entered = 1_000_000_000n
    const consumed = 640_000_000n // the pool's price ratio took 64% of the offered leg
    const ceiling = maxSupplyFee({ amountDesired: entered, bps: 25 })
    const actual = maxSupplyFee({ amountDesired: consumed, bps: 25 })
    expect(ceiling).toBe(2_500_000n)
    expect(actual).toBeLessThan(ceiling)

    const copy = feeCeilingCopy('2.50 USDC + 0.0008 WETH', '997.50 USDC + 0.4992 WETH')
    expect(copy).toMatch(/If the pool takes everything you entered/)
    expect(copy).toMatch(/2\.50 USDC \+ 0\.0008 WETH/)
    // FR-028's "resulting net amount" — stated beside the ceiling, not instead of it.
    expect(copy).toMatch(/997\.50 USDC \+ 0\.4992 WETH goes into the pool/)
    expect(copy).toMatch(/most it can be/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────
// 2. A zero rate renders NO fee line at all (T119, FR-029 / research R3)
// ─────────────────────────────────────────────────────────────────────────────────────

describe('a zero rate renders no fee line at all — not a 0.00 line (FR-029)', () => {
  it('bridge: no platform-fee line, and the whole amount reaches the protocol', () => {
    const bridge = bridgeQuoteAt(0)
    expect(bridge.lines.map((l) => l.id)).toEqual([BRIDGE_QUOTE_LINE.BRIDGE_FEE, BRIDGE_QUOTE_LINE.DESTINATION_GAS])
    expect(bridge.platformFeeRaw).toBeNull()
    // Byte-identical to a build with no fee configured.
    expect(bridge.bridgedAmount).toBe(bridge.inputAmount)
    expect(bridge.totalCostRaw).toBe('3500000')
  })

  it('supply: no fee copy at a zero rate, and none on a chain with no fee system', () => {
    expect(liquidityFeeCopy({ kind: POOL_KIND.TRADING_LP, bps: 0, available: true })).toBeNull()
    expect(liquidityFeeCopy({ kind: POOL_KIND.TRADING_LP, bps: 0, available: false })).toBeNull()
    // An unread rate produces no copy either — the surface blocks instead of showing 0.00.
    expect(liquidityFeeCopy({ kind: POOL_KIND.TRADING_LP, bps: 50, available: false })).toBeNull()
  })

  it('bridge-liquidity shows no fee line at ANY rate (research R3)', () => {
    for (const bps of [0, 25, 250]) {
      expect(liquidityFeeCopy({ kind: POOL_KIND.BRIDGE_LP, bps, available: true })).toBeNull()
    }
  })

  it('a nonzero rate that floors to nothing charges nothing and shows nothing', () => {
    // 199 base units at 50 bps floors to 0 in the member's favor, exactly as the contract does.
    expect(splitFee(199n, 50)).toEqual({ feeAmount: 0n, netAmount: 199n })
    const dust = buildBridgeQuote({
      suggested: suggestedForNet('1000000000'),
      inputAmount: 1_000_000_000n,
      feeAmount: 0n,
      platformFeeBps: 50,
      tokenSymbol: 'USDC',
      decimals: 6,
      originChainId: 137,
      destinationChainId: 1,
      fetchedAt: 1_800_000_000_000,
    })
    expect(dust.lines.find((l) => l.id === BRIDGE_QUOTE_LINE.PLATFORM_FEE)).toBeUndefined()
    // The rate is still carried — it is what travels back as the ceiling.
    expect(Number(bridgeCalldata(dust).maxFeeBps)).toBe(50)
  })
})
