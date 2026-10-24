/**
 * The GMX keeper (execution) fee — its DataStore keys, its formula, and the live read (spec 083).
 *
 * WHY THIS SUITE IS WORTH ITS LENGTH. Every GMX order the member signs declares an `executionFee`,
 * and GMX validates it at `createOrder` against its own arithmetic
 * (`GasUtils.validateExecutionFee` → `InsufficientExecutionFee`). Get it wrong low and the
 * member's close reverts or is never executed while their collateral sits in a position they
 * believe they exited; get it wrong high with no refund and they were overcharged. Both failures
 * are silent at review time, which is why the constants are pinned to reads of the deployed
 * contract and the formula is checked against hand-computed values rather than against itself.
 *
 * THE KEYS WERE READ, NOT REMEMBERED. Every value below came from `eth_call`ing
 * `getUint(bytes32)` on GMX's Arbitrum DataStore **0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8**
 * on **2026-08-12** at block **493,775,585**. The hashes are pinned exactly because a flat
 * `bytes32 → uint256` map cannot tell you that you asked the wrong question.
 *
 * AND THE ONE THAT WOULD HAVE GOT THROUGH: `keccak256(abi.encode(INCREASE_ORDER_GAS_LIMIT))` —
 * the double hash older GMX getters used — is a DIFFERENT live key that answers **4,000,000**
 * instead of 3,000,000. Two plausible derivations, two non-zero answers, and the usual "a wrong
 * key returns 0" reasoning proves nothing. `Keys.increaseOrderGasLimitKey()` returns the flat
 * constant (gmx-synthetics `contracts/data/Keys.sol` L246/L655), so the flat one is what GMX
 * validates against; the double hash is asserted to be a different key so nobody "fixes" it back.
 *
 * Nothing here touches a network: the provider, the DataStore contract and the gas price are all
 * injected.
 */
import { describe, it, expect, vi } from 'vitest'
import { AbiCoder, keccak256 } from 'ethers'

import {
  GMX_DECREASE_ORDER_GAS_LIMIT_KEY,
  GMX_ESTIMATED_GAS_FEE_BASE_AMOUNT_KEY,
  GMX_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR_KEY,
  GMX_ESTIMATED_GAS_FEE_PER_ORACLE_PRICE_KEY,
  GMX_EXECUTION_FEE_BUFFER_BPS,
  GMX_INCREASE_ORDER_GAS_LIMIT_KEY,
  GMX_ORACLE_PRICE_COUNT_BASE,
  GMX_ORDER_KIND,
  GMX_SINGLE_SWAP_GAS_LIMIT_KEY,
  buildClosePositionCalls,
  estimateExecutionFee,
  orderGasLimitKeyFor,
  readExecutionFee,
} from '../../lib/perps/venues/gmx'
import { defaultReadVenueQuote, formatWeiAmount } from '../../components/perps/positionSheetActions'

const ARBITRUM = 42161
const ABI_CODER = AbiCoder.defaultAbiCoder()

/* --------------------------------------------------------------------------------------------- *
 * What the deployed Arbitrum DataStore actually answered (2026-08-12, block 493,775,585)
 * --------------------------------------------------------------------------------------------- */

const LIVE = Object.freeze({
  baseGasLimit: 207_024n, // ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1
  gasPerOraclePrice: 525_368n, // ESTIMATED_GAS_FEE_PER_ORACLE_PRICE
  multiplierFactor: 1_584_563_439_287_042_000_000_000_000_000n, // ≈ ×1.5845634, 1e30 fixed point
  increaseOrderGasLimit: 3_000_000n, // INCREASE_ORDER_GAS_LIMIT  (the FLAT key)
  decreaseOrderGasLimit: 3_000_000n, // DECREASE_ORDER_GAS_LIMIT  (the FLAT key)
  singleSwapGasLimit: 1_000_000n, // SINGLE_SWAP_GAS_LIMIT
})

/** The exact key hashes those values were read at. */
const LIVE_KEYS = Object.freeze({
  base: '0x39288f227e5db9a793e9f4afb15aa22b77dbb7e410ffc973c816a19a6ed921cd',
  perOraclePrice: '0xf95915378e4358fb5f51ae0fd75853a15a29a978eb14b73d5c5b7d69d3b9fccc',
  multiplier: '0xce135f2a886cf6d862269f215b1e64498fa09cb04f90b771b163399df2a82b81',
  increase: '0x983e0a7f5307213e84497f2543331fe5e404db14ddf98f98dc956e0ee3ab6875',
  decrease: '0xfce7a3444b72c2d30987163c1f2e6c00cffa03bf0b6ca2f077e8db006b4cae8b',
  singleSwap: '0x3be28fb346f7abc4a956a16d3739c8c4bfcca9385988c64bf86cdd16638c1f81',
})

/** Arbitrum's gas price at the same read. Small, and the fee is linear in it. */
const GAS_PRICE = 20_000_000n // 0.02 gwei

/**
 * The DataStore, answering exactly what the live one answers. A key it does not know answers 0 —
 * which is what the real contract does for a mis-derived key, and what the read must refuse.
 */
function dataStore(values = {}) {
  const table = {
    [GMX_ESTIMATED_GAS_FEE_BASE_AMOUNT_KEY]: LIVE.baseGasLimit,
    [GMX_ESTIMATED_GAS_FEE_PER_ORACLE_PRICE_KEY]: LIVE.gasPerOraclePrice,
    [GMX_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR_KEY]: LIVE.multiplierFactor,
    [GMX_INCREASE_ORDER_GAS_LIMIT_KEY]: LIVE.increaseOrderGasLimit,
    [GMX_DECREASE_ORDER_GAS_LIMIT_KEY]: LIVE.decreaseOrderGasLimit,
    [GMX_SINGLE_SWAP_GAS_LIMIT_KEY]: LIVE.singleSwapGasLimit,
    ...values,
  }
  return { getUint: vi.fn(async (key) => table[key] ?? 0n) }
}

/**
 * A viem PublicClient's gas-price surface, which is where ethers' single `getFeeData` went
 * (spec 110): `getGasPrice` is `eth_gasPrice` — the number GMX validates `tx.gasprice` against —
 * and `estimateFeesPerGas` is the EIP-1559 ceiling the producer only falls back to. A fake that
 * still answered `getFeeData` would pass every assertion below while the real client answered
 * nothing, which is the failure mode this whole migration keeps finding.
 */
const client = (over = {}) => ({
  getGasPrice: async () => GAS_PRICE,
  estimateFeesPerGas: async () => ({}),
  ...over,
})

/** A client whose legacy gas price is unavailable, leaving only the 1559 ceiling. */
const noLegacyGasPrice = (fees) => ({
  getGasPrice: async () => {
    throw new Error('eth_gasPrice unsupported')
  },
  estimateFeesPerGas: async () => fees,
})

/** Every seam injected — this is what makes the producer testable with no network. */
function deps(over = {}) {
  const store = over.store ?? dataStore()
  return {
    store,
    dep: {
      getClient: () => client(),
      makeContract: () => store,
      ...over.dep,
    },
  }
}

/* --------------------------------------------------------------------------------------------- *
 * The keys
 * --------------------------------------------------------------------------------------------- */

describe('the DataStore keys are the ones the live contract answers to', () => {
  it('pins every key to the hash that was actually read on Arbitrum', () => {
    expect(GMX_ESTIMATED_GAS_FEE_BASE_AMOUNT_KEY).toBe(LIVE_KEYS.base)
    expect(GMX_ESTIMATED_GAS_FEE_PER_ORACLE_PRICE_KEY).toBe(LIVE_KEYS.perOraclePrice)
    expect(GMX_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR_KEY).toBe(LIVE_KEYS.multiplier)
    expect(GMX_INCREASE_ORDER_GAS_LIMIT_KEY).toBe(LIVE_KEYS.increase)
    expect(GMX_DECREASE_ORDER_GAS_LIMIT_KEY).toBe(LIVE_KEYS.decrease)
    expect(GMX_SINGLE_SWAP_GAS_LIMIT_KEY).toBe(LIVE_KEYS.singleSwap)
  })

  it('derives them as keccak256(abi.encode("<NAME>")) — the derivation the venue uses', () => {
    const derive = (name) => keccak256(ABI_CODER.encode(['string'], [name]))
    expect(GMX_ESTIMATED_GAS_FEE_BASE_AMOUNT_KEY).toBe(derive('ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1'))
    expect(GMX_ESTIMATED_GAS_FEE_PER_ORACLE_PRICE_KEY).toBe(derive('ESTIMATED_GAS_FEE_PER_ORACLE_PRICE'))
    expect(GMX_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR_KEY).toBe(derive('ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR'))
    expect(GMX_INCREASE_ORDER_GAS_LIMIT_KEY).toBe(derive('INCREASE_ORDER_GAS_LIMIT'))
    expect(GMX_DECREASE_ORDER_GAS_LIMIT_KEY).toBe(derive('DECREASE_ORDER_GAS_LIMIT'))
    expect(GMX_SINGLE_SWAP_GAS_LIMIT_KEY).toBe(derive('SINGLE_SWAP_GAS_LIMIT'))
    // Not the V2 base amount without the version suffix — a different live key with a different value.
    expect(GMX_ESTIMATED_GAS_FEE_BASE_AMOUNT_KEY).not.toBe(derive('ESTIMATED_GAS_FEE_BASE_AMOUNT'))
  })

  it('is NOT the legacy double hash — the wrong key that answers 4,000,000 rather than nothing', () => {
    for (const [name, key] of [
      ['INCREASE_ORDER_GAS_LIMIT', GMX_INCREASE_ORDER_GAS_LIMIT_KEY],
      ['DECREASE_ORDER_GAS_LIMIT', GMX_DECREASE_ORDER_GAS_LIMIT_KEY],
    ]) {
      const doubled = keccak256(ABI_CODER.encode(['bytes32'], [keccak256(ABI_CODER.encode(['string'], [name]))]))
      expect(key, `${name} used the double hash`).not.toBe(doubled)
    }
    expect(GMX_INCREASE_ORDER_GAS_LIMIT_KEY).not.toBe(
      '0x05f62d77f61186aa369728a64f46f165cde0caa2379ead27c84b04bd7490c327',
    )
  })

  it('an EXIT draws on the decrease limit, and the two kinds are distinct keys', () => {
    // A close, a reduce, and both protection legs are all decrease orders.
    expect(orderGasLimitKeyFor(GMX_ORDER_KIND.DECREASE)).toBe(GMX_DECREASE_ORDER_GAS_LIMIT_KEY)
    expect(orderGasLimitKeyFor(GMX_ORDER_KIND.INCREASE)).toBe(GMX_INCREASE_ORDER_GAS_LIMIT_KEY)
    expect(GMX_DECREASE_ORDER_GAS_LIMIT_KEY).not.toBe(GMX_INCREASE_ORDER_GAS_LIMIT_KEY)
    // A word this module does not know is null, never a silent default onto the other kind.
    for (const junk of ['open', 'close', '', null, undefined, 0, {}]) {
      expect(orderGasLimitKeyFor(junk)).toBeNull()
    }
  })
})

/* --------------------------------------------------------------------------------------------- *
 * The formula, against hand-computed values
 * --------------------------------------------------------------------------------------------- */

describe('estimateExecutionFee reproduces GMX’s own arithmetic', () => {
  const inputs = {
    gasPrice: GAS_PRICE,
    baseGasLimit: LIVE.baseGasLimit,
    gasPerOraclePrice: LIVE.gasPerOraclePrice,
    orderGasLimit: LIVE.decreaseOrderGasLimit,
    multiplierFactor: LIVE.multiplierFactor,
  }

  /*
   * Worked by hand from the live constants:
   *   oraclePriceCount = 3 + 0                                  = 3
   *   applyFactor(3,000,000, 1.584563439287042e30)              = 4,753,690   (floor, ÷1e30)
   *   gasLimit = 207,024 + 525,368×3 + 4,753,690                = 6,536,818
   *   baseFee  = 6,536,818 × 20,000,000 wei                     = 130,736,360,000,000 wei
   *   fee      = baseFee × 1.10                                 = 143,809,996,000,000 wei
   */
  it('matches the hand-computed gas limit and fee for a close at the live constants', () => {
    const estimate = estimateExecutionFee({ ...inputs, bufferBps: 0 })
    expect(estimate.oraclePriceCount).toBe(3)
    expect(estimate.oraclePriceCount).toBe(GMX_ORACLE_PRICE_COUNT_BASE)
    expect(estimate.gasLimit).toBe(6_536_818n)
    expect(estimate.baseFee).toBe(130_736_360_000_000n)
    expect(estimate.fee).toBe(estimate.baseFee) // no buffer asked for, none applied
    expect(estimate.gasPrice).toBe(GAS_PRICE)
  })

  it('is a BigInt count of WEI, not a float and not gwei', () => {
    const estimate = estimateExecutionFee(inputs)
    expect(typeof estimate.fee).toBe('bigint')
    expect(typeof estimate.baseFee).toBe('bigint')
    expect(typeof estimate.gasLimit).toBe('bigint')
    expect(estimate.fee).toBe(143_809_996_000_000n)
    // ~0.00014 ETH. A fee that came back in gwei would be ~1e-9 of this and would strand the order.
    expect(estimate.fee).toBeGreaterThan(10_000_000_000_000n)
    expect(estimate.fee).toBeLessThan(10_000_000_000_000_000n)
  })

  it('biases HIGH by the documented buffer — overpaying is refunded, underpaying strands', () => {
    const estimate = estimateExecutionFee(inputs)
    expect(GMX_EXECUTION_FEE_BUFFER_BPS).toBe(1000) // 10%
    expect(estimate.bufferBps).toBe(GMX_EXECUTION_FEE_BUFFER_BPS)
    expect(estimate.fee).toBe(estimate.baseFee + (estimate.baseFee * 1000n) / 10_000n)
    expect(estimate.fee).toBeGreaterThan(estimate.baseFee)
    // The buffer is a knob, not a constant baked into the arithmetic.
    expect(estimateExecutionFee({ ...inputs, bufferBps: 2500 }).fee).toBe(
      estimate.baseFee + (estimate.baseFee * 2500n) / 10_000n,
    )
  })

  it('scales linearly with gas price — the only input that moves between quote and signature', () => {
    const cheap = estimateExecutionFee({ ...inputs, gasPrice: GAS_PRICE / 2n })
    const dear = estimateExecutionFee({ ...inputs, gasPrice: GAS_PRICE })
    expect(cheap.fee * 2n).toBe(dear.fee)
    expect(cheap.gasLimit).toBe(dear.gasLimit)
  })

  it('counts one extra oracle price AND one swap gas limit per swap hop', () => {
    const swapped = estimateExecutionFee({
      ...inputs,
      bufferBps: 0,
      swapPathLength: 2,
      singleSwapGasLimit: LIVE.singleSwapGasLimit,
    })
    expect(swapped.oraclePriceCount).toBe(5)
    // 207,024 + 525,368×5 + applyFactor(3,000,000 + 1,000,000×2, factor)
    const applied = ((LIVE.decreaseOrderGasLimit + LIVE.singleSwapGasLimit * 2n) * LIVE.multiplierFactor) / 10n ** 30n
    expect(swapped.gasLimit).toBe(LIVE.baseGasLimit + LIVE.gasPerOraclePrice * 5n + applied)
    expect(swapped.gasLimit).toBeGreaterThan(estimateExecutionFee({ ...inputs, bufferBps: 0 }).gasLimit)
  })

  it('refuses swap hops it was given no swap gas limit for, rather than under-counting them', () => {
    // The dangerous half-answer: the hops raise the oracle-price count while contributing no gas,
    // so the estimate comes back plausible and SHORT. This feature never swaps, so the honest
    // outcome is null and a disclosed unknown.
    expect(estimateExecutionFee({ ...inputs, swapPathLength: 1 })).toBeNull()
    expect(estimateExecutionFee({ ...inputs, swapPathLength: 1, singleSwapGasLimit: 'nope' })).toBeNull()
    // Zero hops needs no swap limit at all — that is the path every order in this feature takes.
    expect(estimateExecutionFee({ ...inputs, swapPathLength: 0 })).not.toBeNull()
  })

  it('returns null rather than inventing a venue constant it was not given', () => {
    expect(estimateExecutionFee()).toBeNull()
    expect(estimateExecutionFee(null)).toBeNull()
    for (const key of ['gasPrice', 'baseGasLimit', 'gasPerOraclePrice', 'orderGasLimit', 'multiplierFactor']) {
      expect(estimateExecutionFee({ ...inputs, [key]: undefined }), key).toBeNull()
      expect(estimateExecutionFee({ ...inputs, [key]: 'nope' }), key).toBeNull()
      expect(estimateExecutionFee({ ...inputs, [key]: -1n }), key).toBeNull()
    }
  })

  it('produces a fee the calldata builder accepts, in the field GMX reads it from', () => {
    // The estimate and the `sendWnt` amount are the SAME value or GMX reverts
    // `InsufficientWntAmountForExecutionFee` — proven here by feeding one into the other.
    const { fee } = estimateExecutionFee(inputs)
    const call = buildClosePositionCalls({
      chainId: ARBITRUM,
      account: '0xd504dC1ac094F45272f46b25A2874bDab45132Da',
      market: '0x47c031236e19d024b42f8AE6780E44A573170703',
      collateralToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      sizeDeltaUsd: 1_000n * 10n ** 30n,
      acceptablePrice: 62_500n * 10n ** 30n,
      executionFee: fee,
      isLong: true,
    })
    expect(call.value).toBe(fee)
  })
})

/* --------------------------------------------------------------------------------------------- *
 * The live read
 * --------------------------------------------------------------------------------------------- */

describe('readExecutionFee — the producer', () => {
  it('reads the four constants plus the gas price and returns the fee in wei', async () => {
    const { store, dep } = deps()
    const estimate = await readExecutionFee({ chainId: ARBITRUM, orderKind: GMX_ORDER_KIND.DECREASE, ...dep })

    expect(typeof estimate.fee).toBe('bigint')
    expect(estimate.fee).toBe(143_809_996_000_000n) // the hand-computed value, end to end
    expect(estimate.gasLimit).toBe(6_536_818n)
    expect(estimate.gasPrice).toBe(GAS_PRICE)
    expect(estimate.bufferBps).toBe(GMX_EXECUTION_FEE_BUFFER_BPS)
    expect(estimate.chainId).toBe(ARBITRUM)
    expect(estimate.orderKind).toBe(GMX_ORDER_KIND.DECREASE)

    const asked = store.getUint.mock.calls.map(([key]) => key)
    expect(asked).toContain(GMX_ESTIMATED_GAS_FEE_BASE_AMOUNT_KEY)
    expect(asked).toContain(GMX_ESTIMATED_GAS_FEE_PER_ORACLE_PRICE_KEY)
    expect(asked).toContain(GMX_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR_KEY)
    expect(asked).toContain(GMX_DECREASE_ORDER_GAS_LIMIT_KEY)
    // An exit is not an increase, and it does not swap — neither key is read.
    expect(asked).not.toContain(GMX_INCREASE_ORDER_GAS_LIMIT_KEY)
    expect(asked).not.toContain(GMX_SINGLE_SWAP_GAS_LIMIT_KEY)
  })

  it('reads the INCREASE limit for an increase, so an open cannot be priced off an exit', async () => {
    const { store, dep } = deps({
      store: dataStore({ [GMX_INCREASE_ORDER_GAS_LIMIT_KEY]: 6_000_000n }),
    })
    const increase = await readExecutionFee({ chainId: ARBITRUM, orderKind: GMX_ORDER_KIND.INCREASE, ...dep })
    const decrease = await readExecutionFee({ chainId: ARBITRUM, orderKind: GMX_ORDER_KIND.DECREASE, ...dep })
    expect(store.getUint.mock.calls.some(([k]) => k === GMX_INCREASE_ORDER_GAS_LIMIT_KEY)).toBe(true)
    expect(increase.fee).toBeGreaterThan(decrease.fee)
  })

  it('defaults to the exit’s kind, so the exit path cannot forget to name it', async () => {
    const { dep } = deps()
    const estimate = await readExecutionFee({ chainId: ARBITRUM, ...dep })
    expect(estimate.orderKind).toBe(GMX_ORDER_KIND.DECREASE)
  })

  it('takes the gas price from the provider, and falls back to the 1559 ceiling — never below it', async () => {
    const { dep } = deps({ dep: { getClient: () => noLegacyGasPrice({ maxFeePerGas: 50_000_000n }) } })
    const estimate = await readExecutionFee({ chainId: ARBITRUM, ...dep })
    expect(estimate.gasPrice).toBe(50_000_000n)
  })

  /* ----------------------------------------------------------------------------------------- *
   * Every failure is null — an honest refusal, never a guess
   * ----------------------------------------------------------------------------------------- */

  it('a DataStore that cannot be read yields null, not a fabricated fee', async () => {
    const failures = {
      'no read connection': { getClient: () => null },
      'client lookup throws': {
        getClient: () => {
          throw new Error('endpoint down')
        },
      },
      'call reverts': {
        makeContract: () => ({
          getUint: async () => {
            throw new Error('execution reverted')
          },
        }),
      },
      'fee data unavailable': { getClient: () => noLegacyGasPrice({}) },
      'fee data rejects': {
        getClient: () => ({
          getGasPrice: async () => {
            throw new Error('no connection')
          },
          estimateFeesPerGas: async () => {
            throw new Error('no connection')
          },
        }),
      },
      // A chain answering ZERO is an unreadable venue. The producer must NOT quietly substitute the
      // 1559 ceiling for it — a real number standing in for a refusal is the whole zero rule.
      'gas price of zero': {
        getClient: () => client({ getGasPrice: async () => 0n, estimateFeesPerGas: async () => ({ maxFeePerGas: 50_000_000n }) }),
      },
    }
    for (const [label, over] of Object.entries(failures)) {
      const { dep } = deps({ dep: over })
      await expect(readExecutionFee({ chainId: ARBITRUM, ...dep }), label).resolves.toBeNull()
    }
  })

  it('a ZERO from any required constant is an unreadable venue, never zero gas', async () => {
    // This is the shape a mis-derived key or a wrong DataStore address produces, and the one that
    // would otherwise sail through: a zero multiplier deletes the dominant term of the fee.
    for (const key of [
      GMX_ESTIMATED_GAS_FEE_BASE_AMOUNT_KEY,
      GMX_ESTIMATED_GAS_FEE_PER_ORACLE_PRICE_KEY,
      GMX_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR_KEY,
      GMX_DECREASE_ORDER_GAS_LIMIT_KEY,
    ]) {
      const { dep } = deps({ store: dataStore({ [key]: 0n }) })
      await expect(readExecutionFee({ chainId: ARBITRUM, ...dep }), key).resolves.toBeNull()
    }
    // …and a DataStore that answers 0 to everything (the wrong address entirely) is null too.
    const empty = deps({ store: { getUint: async () => 0n } })
    await expect(readExecutionFee({ chainId: ARBITRUM, ...empty.dep })).resolves.toBeNull()
  })

  it('is null where GMX is not deployed, and never aims Arbitrum config at another chain', async () => {
    const { store, dep } = deps()
    // `undefined` is deliberately absent: it means "not stated" and falls back to Arbitrum, which
    // is the whole point of a default. A NAMED chain without GMX is what must resolve to nothing.
    for (const chainId of [1, 137, 8453, 63, 0, null, 'arbitrum']) {
      await expect(readExecutionFee({ chainId, ...dep }), String(chainId)).resolves.toBeNull()
    }
    expect(store.getUint).not.toHaveBeenCalled()
  })

  it('refuses an order kind it does not know rather than defaulting to one', async () => {
    const { store, dep } = deps()
    for (const kind of ['swap', 'open', '', null, 42]) {
      await expect(readExecutionFee({ chainId: ARBITRUM, orderKind: kind, ...dep }), String(kind)).resolves.toBeNull()
    }
    expect(store.getUint).not.toHaveBeenCalled()
  })

  it('is TOTAL: it never rejects, whatever it is handed', async () => {
    // Every case here resolves BEFORE a provider is reached, so "no network" stays true.
    await expect(readExecutionFee({ chainId: 999_999 })).resolves.toBeNull()
    await expect(readExecutionFee({ chainId: 999_999, orderKind: null })).resolves.toBeNull()
    await expect(
      readExecutionFee({ chainId: ARBITRUM, swapPathLength: -1, ...deps().dep }),
    ).resolves.toBeNull()
    await expect(readExecutionFee({ chainId: ARBITRUM, swapPathLength: 1.5, ...deps().dep })).resolves.toBeNull()
    await expect(
      readExecutionFee({
        chainId: ARBITRUM,
        addressesFor: () => {
          throw new Error('config exploded')
        },
      }),
    ).resolves.toBeNull()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * The sheet's seam
 * --------------------------------------------------------------------------------------------- */

describe('defaultReadVenueQuote — what the sheet actually calls', () => {
  it('hands GMX a usable executionFee, in wei', async () => {
    const { dep } = deps()
    const quote = await defaultReadVenueQuote({ venue: 'gmx', chainId: ARBITRUM, deps: dep })
    expect(typeof quote.executionFee).toBe('bigint')
    expect(quote.executionFee).toBe(143_809_996_000_000n)
    expect(quote.executionFee).toBeGreaterThan(0n)
    expect(quote.estimate.orderKind).toBe(GMX_ORDER_KIND.DECREASE)
    expect(quote.failed).toBeUndefined()
  })

  it('reports a failed read as failed — so the sheet discloses it instead of guessing', async () => {
    const { dep } = deps({ dep: { getClient: () => null } })
    const quote = await defaultReadVenueQuote({ venue: 'gmx', chainId: ARBITRUM, deps: dep })
    expect(quote).toEqual({ failed: true })
    // …and a failed quote yields no fee, so the descriptor builder refuses rather than sending 0.
    expect(quote.executionFee).toBeUndefined()
  })

  it('is null for a venue with no keeper fee — absence, not failure', async () => {
    for (const venue of ['gains', 'hyperliquid', null, undefined, '']) {
      await expect(defaultReadVenueQuote({ venue, chainId: 137 }), String(venue)).resolves.toBeNull()
    }
    // Called with nothing at all it must still not throw — it runs inside an effect.
    await expect(defaultReadVenueQuote()).resolves.toBeNull()
  })
})

describe('formatWeiAmount', () => {
  it('renders the keeper fee the member is about to pay, truncated not rounded', () => {
    expect(formatWeiAmount(143_809_996_000_000n)).toBe('0.0001438')
    expect(formatWeiAmount(10n ** 18n)).toBe('1')
    expect(formatWeiAmount(1_500_000_000_000_000n)).toBe('0.0015')
    expect(formatWeiAmount(2n * 10n ** 18n + 5n * 10n ** 17n)).toBe('2.5')
  })

  it('never renders a non-zero fee as zero — a cost below the display precision says so', () => {
    expect(formatWeiAmount(1n)).toBe('<0.00000001')
    expect(formatWeiAmount(0n)).toBe('0')
  })

  it('is total: junk in, null out, so a fee line renders “—” rather than crashing the sheet', () => {
    for (const junk of [null, undefined, 'nope', {}, [], NaN, -1n, 1.5]) {
      expect(formatWeiAmount(junk), String(junk)).toBeNull()
    }
  })
})
