import { useState, useEffect, useCallback, useMemo } from 'react'
import { keccak256, stringToHex } from 'viem'
import { formatUnits } from '../lib/evm/units'
import { readContract } from '../lib/chains/readContract'
import { getContractAddressForChain } from '../config/contracts'
import { membershipChainId, NETWORKS } from '../config/networks'
import { getProvider } from '../utils/blockchainService'
import { MEMBERSHIP_MANAGER_ABI } from '../abis/MembershipManager'

/**
 * Hook to fetch tier prices + limits from MembershipManager.
 *
 * The protocol has a single paid role (`WAGER_PARTICIPANT_ROLE`) with four
 * tiers (Bronze/Silver/Gold/Platinum) priced at $2/$8/$25/$100 USDC.
 * The on-chain `Limits` struct enforces only `monthlyMarketCreation` and
 * `maxConcurrentMarkets`; everything else is UI-side presentation.
 */

// The payment token's decimals come from the MEMBERSHIP chain's own config, never a literal 6:
// `getTierConfig` prices in the token's base units, and the full-E2E tier points the reference
// chain's stablecoin at an 18-decimal mock (see `VITE_AMOY_USDC_DECIMALS` in config/networks.js).
// A hardcoded 6 quoted that $2 tier as "$2,000,000,000,000.00" — the same 10^12 error the
// network config comment warns about, on the one surface that names a price before a purchase.
// Strict `NETWORKS[chainId]` lookup (never `getNetwork()`, which falls back to the default network).
function paymentTokenDecimals(chainId) {
  return NETWORKS[chainId]?.stablecoin?.decimals ?? 6
}

const ROLE_HASHES = {
  WAGER_PARTICIPANT: keccak256(stringToHex('WAGER_PARTICIPANT_ROLE')),
}

const TIER_IDS = {
  BRONZE: 1,
  SILVER: 2,
  GOLD: 3,
  PLATINUM: 4
}

// Fallback prices in USDC when MembershipManager is not yet deployed or a
// network call fails. Anchored at $2 Bronze per the v3 ladder.
const FALLBACK_PRICES = {
  BRONZE:   { WAGER_PARTICIPANT: 2   },
  SILVER:   { WAGER_PARTICIPANT: 8   },
  GOLD:     { WAGER_PARTICIPANT: 25  },
  PLATINUM: { WAGER_PARTICIPANT: 100 },
}

export function useTierPrices() {
  const [tierPrices, setTierPrices] = useState(FALLBACK_PRICES)
  const [tierLimits, setTierLimits] = useState({})
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  // True whenever the displayed prices include the hardcoded FALLBACK_PRICES
  // (no MembershipManager on this chain, or a per-tier read failed) rather than
  // being fully sourced on-chain. Starts true (initial state IS the fallback)
  // and is flipped to false only after a clean on-chain fetch. Lets the UI warn
  // that prices for a real-money product may be estimates / out of sync.
  const [usingFallbackPrices, setUsingFallbackPrices] = useState(true)

  // ── PRICES COME FROM THE REFERENCE CHAIN (spec 071 FR-003/FR-006/FR-008) ──────────────────
  // These used to resolve against the WALLET's connected chain. Since spec 071 routes every
  // purchase to the reference chain, that combination quoted one chain's price for a purchase
  // that settles on another — and on any chain without a MembershipManager (every mainnet but
  // Polygon) it found no contract at all and fell back to HARDCODED prices. A member was shown
  // a placeholder price for a real charge, which is precisely what constitution III forbids.
  //
  // The price the member is quoted is now read from the same contract that will take their
  // money, so the two cannot disagree.
  const referenceChainId = membershipChainId()
  const provider = useMemo(() => getProvider(referenceChainId), [referenceChainId])

  // A reader bound to the reference chain, or null when no manager is deployed there.
  // `provider` stays the availability gate it was.
  const contract = useMemo(() => {
    const addr = getContractAddressForChain('membershipManager', referenceChainId)
    if (!addr || !provider) return null
    return {
      getTierConfig: (roleHash, tierId) =>
        readContract(referenceChainId, {
          address: addr,
          abi: MEMBERSHIP_MANAGER_ABI,
          functionName: 'getTierConfig',
          args: [roleHash, tierId],
        }),
    }
  }, [provider, referenceChainId])

  const fetchPrices = useCallback(async () => {
    if (!contract) {
      // No MembershipManager on the REFERENCE chain — a build misconfiguration rather than a
      // member being on the "wrong" network, since the reference chain no longer moves with the
      // wallet. `usingFallbackPrices` stays true so the UI keeps disclosing that these are
      // estimates rather than a quote from the contract that will take the money.
      setTierPrices(FALLBACK_PRICES)
      setTierLimits({})
      setUsingFallbackPrices(true)
      setError('MembershipManager not deployed')
      setIsLoading(false)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const prices = { BRONZE: {}, SILVER: {}, GOLD: {}, PLATINUM: {} }
      const limits = { BRONZE: {}, SILVER: {}, GOLD: {}, PLATINUM: {} }
      let usedFallback = false
      for (const [roleKey, roleHash] of Object.entries(ROLE_HASHES)) {
        for (const [tierName, tierId] of Object.entries(TIER_IDS)) {
          try {
            const cfg = await contract.getTierConfig(roleHash, tierId)
            prices[tierName][roleKey] = parseFloat(formatUnits(cfg.priceUSDC, paymentTokenDecimals(referenceChainId)))
            limits[tierName][roleKey] = {
              monthlyMarketCreation: Number(cfg.limits.monthlyMarketCreation),
              maxConcurrentMarkets: Number(cfg.limits.maxConcurrentMarkets),
              durationDays: Number(cfg.durationDays),
              isActive: cfg.active,
            }
          } catch {
            prices[tierName][roleKey] = FALLBACK_PRICES[tierName]?.[roleKey] ?? 0
            usedFallback = true
          }
        }
      }
      setTierPrices(prices)
      setTierLimits(limits)
      setUsingFallbackPrices(usedFallback)
      setLastUpdated(new Date())
    } catch (err) {
      console.error('Error fetching tier prices:', err)
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [contract, referenceChainId])

  useEffect(() => {
    fetchPrices()
    const interval = setInterval(fetchPrices, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [fetchPrices])

  const getPrice = useCallback((roleKey, tierName) => {
    return tierPrices[tierName]?.[roleKey] ?? FALLBACK_PRICES[tierName]?.[roleKey] ?? 0
  }, [tierPrices])

  const getTotalPrice = useCallback((roleKeys, tierName) => {
    return roleKeys.reduce((sum, roleKey) => sum + getPrice(roleKey, tierName), 0)
  }, [getPrice])

  const getLimits = useCallback((roleKey, tierName) => {
    return tierLimits[tierName]?.[roleKey] ?? null
  }, [tierLimits])

  /**
   * THREE-STATE, and the third state is why this exists: `true` (the chain says purchasable),
   * `false` (the chain says NOT purchasable — `MembershipManager.setTier(..., active=false)`),
   * `null` (never read, or that tier's read failed).
   *
   * It used to answer `?? true`, so an unknown tier claimed to be purchasable — and no caller
   * consumed it at all, which is how production offered Bronze at 2 USDC while the contract had
   * it inactive: the member approved USDC and `purchaseTierWithTerms` reverted `TierInactive()`
   * (0x4ed1bf50) with their approval already on chain.
   *
   * Callers hide a DEFINITE `false` and keep offering `null` — an RPC blip must not empty the
   * tier grid, and the contract stays the real gate (the same rule the admin write controls use).
   */
  const isTierActive = useCallback((roleKey, tierName) => {
    const known = tierLimits[tierName]?.[roleKey]
    if (!known) return null
    return known.isActive
  }, [tierLimits])

  return {
    tierPrices,
    tierLimits,
    isLoading,
    error,
    lastUpdated,
    usingFallbackPrices,
    fetchPrices,
    getPrice,
    getTotalPrice,
    getLimits,
    isTierActive,
    TIER_IDS,
    ROLE_HASHES,
    FALLBACK_PRICES,
  }
}

export default useTierPrices
