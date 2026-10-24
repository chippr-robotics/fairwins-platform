/**
 * Curated asset→news-tag mapping for token news (spec 109, FR-004).
 *
 * THE VENDOR HAS NO CONTRACT IDENTITY (research R4: tags and coins are slug/ticker only, nothing
 * to join on), so this table is the ONE place FairWins decides which news feed an asset gets —
 * beside the canonical asset records it resolves through (the spec-108 offered-beside-resolvable
 * precedent). Rules:
 *
 *   - Resolution starts from the asset's CONCRETE identity: (chainId, address) or `native`,
 *     looked up in the canonical portfolio registry. An asset the registry does not know resolves
 *     to null — a scam token wearing a major's ticker never reaches the slug tables, because it
 *     fails the registry lookup first. null IS the "not covered" outcome; there is no ticker
 *     heuristic and no fallback (wrong-token news is a fabricated fact, spec SC-002).
 *   - EVERY slug below was verified by a live read of the vendor's
 *     `/items/news/?tags=<slug>` before it was written (the spec-021-amendment discipline: a
 *     wrong row costs a member the surface silently). A garbage slug fails closed to zero
 *     results upstream (research R3), so the failure mode of an unverified row is honest
 *     absence — but verify anyway; absence for a covered asset is still a defect.
 *   - Bitcoin network ids are STRING ids (spec 061) and never enter EVM seams; they resolve here
 *     directly, before any registry lookup.
 */
import { getPortfolioRegistry } from './assetTaxonomy'
import { isBitcoinNetworkId } from './bitcoinNetworks'

/**
 * Native / wrapped-native underlyings → tag slug. The key space is the SEC-baseline underlying
 * enum the registry stamps as `baselineSymbol` — a bounded enumeration, not a free-form ticker.
 *
 * Probe-verified 2026-09-07:
 *   ethereum          → items returned
 *   ethereum-classic  → items returned
 *   matic-network     → items returned, fresh and Polygon-focused. NOTE: `polygon`, `matic` and
 *                       `pol` all return ZERO items, and `polygon-ecosystem-token` exists but
 *                       carries only generic market wraps — the legacy-named tag is the live one.
 *   bitcoin           → items returned
 */
const UNDERLYING_SLUGS = {
  ETH: 'ethereum',
  ETC: 'ethereum-classic',
  POL: 'matic-network',
  BTC: 'bitcoin',
}

/**
 * Curated registry ERC-20s → tag slug, keyed by the CANONICAL registry entry's symbol. This is
 * not a bare-ticker lookup: an address only reaches this table after resolving to a canonical
 * registry record, so the symbol here is the registry's curated fact, not caller input.
 *
 * Probe-verified 2026-09-07: usd-coin ✓ (`usdc` returns zero), tether ✓, wrapped-bitcoin ✓
 * (`wbtc` returns zero).
 */
const REGISTRY_SYMBOL_SLUGS = {
  USDC: 'usd-coin',
  USDT: 'tether',
  WBTC: 'wrapped-bitcoin',
}

/**
 * Resolve the news tag slug for one platform asset. Returns null when no curated mapping exists —
 * the caller renders honest absence and makes NO network request (contract §frontend seam).
 *
 * @param {{chainId: number|string, address?: string|null}} asset  `address` null/'native' = the
 *   chain's base coin; Bitcoin string network ids resolve directly.
 * @returns {string|null}
 */
export function newsSlugFor({ chainId, address = null } = {}) {
  if (isBitcoinNetworkId(chainId)) {
    // One asset, both bitcoin networks — the card's testnet-cohort notice carries the
    // cross-cohort honesty (news is a mainnet-asset fact), not a different slug.
    return UNDERLYING_SLUGS.BTC
  }
  if (typeof chainId !== 'number' || !Number.isInteger(chainId)) return null

  const registry = getPortfolioRegistry(chainId)
  if (registry.length === 0) return null
  const id = address == null || address === 'native' ? 'native' : String(address).toLowerCase()
  const entry = registry.find((e) => e.id === id)
  if (!entry) return null

  const underlying = (entry.baselineSymbol || '').toUpperCase()
  if (underlying && UNDERLYING_SLUGS[underlying]) return UNDERLYING_SLUGS[underlying]

  const symbol = (entry.symbol || '').toUpperCase()
  if (REGISTRY_SYMBOL_SLUGS[symbol]) return REGISTRY_SYMBOL_SLUGS[symbol]

  return null
}
