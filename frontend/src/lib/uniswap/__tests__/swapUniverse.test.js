import { describe, it, expect } from 'vitest'
import {
  buildSwapOptions,
  counterpartFor,
  defaultPairForChain,
  findSwapOption,
  findSwapOptionByAddress,
  getSwapAddresses,
  getSwapTokenMeta,
  getSwapTokens,
  getSwapVenue,
  isSwapChain,
  swapOptionKey,
} from '../swapUniverse'
import { samePair, createPin, PIN_MODE } from '../../assets/networkPin'
import { NETWORKS, getSwapChainIds } from '../../../config/networks'

/**
 * The cross-network swap universe. The properties that matter are the ones a
 * wrong answer would break in a way a member could lose money over:
 *   - a chain is only listed when it has BOTH the policy gate and real router
 *     config (a listed chain with no router is a ticket that cannot fill);
 *   - addresses are strictly per-chain (a borrowed router/quoter is an approval
 *     sent to a foreign address);
 *   - the options this module produces satisfy the SHARED pair rule (`samePair`),
 *     so pair pinning is not re-derived here.
 */

describe('isSwapChain / getSwapChainIds', () => {
  it('lists only chains with both the swap gate and router config, mainnets first', () => {
    const ids = getSwapChainIds()
    expect(ids).toContain(137) // Polygon — canonical Uniswap
    expect(ids).toContain(61) // Ethereum Classic — ETCswap
    expect(ids).toContain(8453) // Base — its own V3 addresses
    expect(ids).not.toContain(1337) // local sandbox: no DEX
    expect(ids.every((id) => isSwapChain(id))).toBe(true)
    const firstTestnet = ids.findIndex((id) => NETWORKS[id].isTestnet)
    if (firstTestnet !== -1) {
      expect(ids.slice(firstTestnet).every((id) => NETWORKS[id].isTestnet)).toBe(true)
    }
  })

  it('refuses chains with no DEX at all', () => {
    expect(isSwapChain(1337)).toBe(false)
    expect(isSwapChain(11155111)).toBe(false)
    expect(isSwapChain(undefined)).toBe(false)
  })
})

describe('getSwapAddresses', () => {
  it('returns that chain’s own router/quoter/wrapped-native, never another chain’s', () => {
    const polygon = getSwapAddresses(137)
    const base = getSwapAddresses(8453)
    expect(polygon.swapRouter).toBe(NETWORKS[137].dex.swapRouter)
    expect(base.swapRouter).toBe(NETWORKS[8453].dex.swapRouter)
    // Base deliberately does NOT share the canonical Uniswap addresses.
    expect(base.swapRouter).not.toBe(polygon.swapRouter)
    expect(base.quoter).not.toBe(polygon.quoter)
    expect(polygon.stablecoin).toBe(NETWORKS[137].stablecoin.address)
  })

  it('returns null for a chain that cannot swap — no silent fallback', () => {
    expect(getSwapAddresses(1337)).toBeNull()
    expect(getSwapAddresses(999999)).toBeNull()
  })
})

describe('getSwapTokens / getSwapTokenMeta', () => {
  it('offers the registry’s ERC-20s and never the native coin (it must be wrapped)', () => {
    const tokens = getSwapTokens(137)
    expect(tokens.length).toBeGreaterThan(1)
    expect(tokens.every((t) => Boolean(t.address))).toBe(true)
    expect(tokens.some((t) => t.symbol === 'POL')).toBe(false)
    expect(tokens.some((t) => t.symbol === 'WPOL')).toBe(true)
    expect(tokens.some((t) => t.symbol === 'USDC')).toBe(true)
    // NFT credentials are not tradeable legs.
    expect(tokens.some((t) => t.symbol === 'FWMV')).toBe(false)
  })

  it('is empty on a chain that cannot swap', () => {
    expect(getSwapTokens(1337)).toEqual([])
  })

  it('resolves leg decimals for quote math, case-insensitively', () => {
    const usdc = NETWORKS[137].stablecoin.address
    expect(getSwapTokenMeta(137, usdc.toUpperCase()).decimals).toBe(6)
    expect(getSwapTokenMeta(137, NETWORKS[137].dex.wnative).decimals).toBe(18)
    // The same address on a chain that does not host it is not a leg there.
    expect(getSwapTokenMeta(8453, usdc)).toBeNull()
  })
})

describe('buildSwapOptions', () => {
  it('spans every swap-capable mainnet, keyed by chain and address', () => {
    const options = buildSwapOptions({ connectedChainId: 137 })
    const chains = new Set(options.map((o) => o.chainId))
    expect(chains.size).toBeGreaterThan(1)
    expect(chains.has(137)).toBe(true)
    expect(chains.has(8453)).toBe(true)
    expect(chains.has(61)).toBe(true)

    const wmatic = findSwapOptionByAddress(options, 137, NETWORKS[137].dex.wnative)
    expect(wmatic.key).toBe(swapOptionKey(137, NETWORKS[137].dex.wnative))
    expect(wmatic.networkName).toBe('Polygon')
    expect(wmatic.venueName).toBe('Uniswap')
    // Keys are unique — two chains' USDC must never collide into one option.
    expect(new Set(options.map((o) => o.key)).size).toBe(options.length)
  })

  it('puts the connected network first — its pairs need no switch', () => {
    expect(buildSwapOptions({ connectedChainId: 8453 })[0].chainId).toBe(8453)
    expect(buildSwapOptions({ connectedChainId: 61 })[0].chainId).toBe(61)
  })

  it('hides testnet pairs unless the member is on that testnet', () => {
    const mainnetView = buildSwapOptions({ connectedChainId: 137 })
    expect(mainnetView.some((o) => o.isTestnet)).toBe(false)
    // Mordor's DEX is env-configured; when it is off there is simply nothing to
    // show, which is the same honest outcome as hiding it.
    const mordorView = buildSwapOptions({ connectedChainId: 63 })
    expect(mordorView.filter((o) => o.isTestnet).every((o) => o.chainId === 63)).toBe(true)
  })

  it('produces options the SHARED pair rule accepts (no second pin rule here)', () => {
    const options = buildSwapOptions({ connectedChainId: 137 })
    const base = options.find((o) => o.chainId === 8453)
    const pin = createPin(base, PIN_MODE.SAME_NETWORK)
    const eligible = options.filter((o) => samePair(o, pin))
    expect(eligible.length).toBeGreaterThan(0)
    expect(eligible.every((o) => o.chainId === 8453)).toBe(true)
  })
})

describe('defaultPairForChain', () => {
  it('opens on wrapped-native → the network stablecoin', () => {
    const options = buildSwapOptions({ connectedChainId: 137 })
    const pair = defaultPairForChain(options, 137)
    expect(pair.from.address).toBe(NETWORKS[137].dex.wnative)
    expect(pair.to.address).toBe(NETWORKS[137].stablecoin.address)
  })

  it('returns null where no pair can form', () => {
    const options = buildSwapOptions({ connectedChainId: 137 })
    expect(defaultPairForChain(options, 1337)).toBeNull()
    expect(defaultPairForChain([], 137)).toBeNull()
    expect(defaultPairForChain(options, undefined)).toBeNull()
  })
})

describe('counterpartFor', () => {
  const options = buildSwapOptions({ connectedChainId: 137 })
  const polygonWmatic = findSwapOptionByAddress(options, 137, NETWORKS[137].dex.wnative)
  const polygonUsdc = findSwapOptionByAddress(options, 137, NETWORKS[137].stablecoin.address)
  const baseWeth = findSwapOptionByAddress(options, 8453, NETWORKS[8453].dex.wnative)

  it('keeps a receive leg that is still on the pinned network', () => {
    expect(counterpartFor(options, 137, polygonWmatic, polygonUsdc)).toBe(polygonUsdc)
  })

  it('replaces an off-network leg with the pinned network’s stablecoin', () => {
    const next = counterpartFor(options, 8453, baseWeth, polygonUsdc)
    expect(next.chainId).toBe(8453)
    expect(next.address).toBe(NETWORKS[8453].stablecoin.address)
  })

  it('never returns the leg being sold', () => {
    const baseUsdc = findSwapOptionByAddress(options, 8453, NETWORKS[8453].stablecoin.address)
    const next = counterpartFor(options, 8453, baseUsdc, baseUsdc)
    expect(next.key).not.toBe(baseUsdc.key)
    expect(next.chainId).toBe(8453)
  })

  it('returns null when the network has nothing to pair against', () => {
    expect(counterpartFor([polygonWmatic], 137, polygonWmatic, null)).toBeNull()
  })
})

describe('getSwapVenue / findSwapOption', () => {
  it('names the pair network’s own DEX', () => {
    expect(getSwapVenue(61).name).toBe('ETCswap')
    expect(getSwapVenue(137).name).toBe('Uniswap')
    expect(getSwapVenue(1337)).toBeNull()
  })

  it('finds nothing for an unknown key rather than guessing', () => {
    const options = buildSwapOptions({ connectedChainId: 137 })
    expect(findSwapOption(options, 'nope')).toBeNull()
    expect(findSwapOption(options, undefined)).toBeNull()
  })
})
