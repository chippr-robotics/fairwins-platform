// Spec 068 (US3) — per-chain catalog of platform-supported on-chain services, used by the Protect
// rule composer's approved-contracts picker (FR-022).
//
// This is a VIEW over configuration the app already carries (the network's swap venue, staking
// contracts, and our own deployed contracts) — deliberately not a second address registry to drift
// from `networks.js` / `deployments/`. Adding a service is a config change, never a code change.
//
// Strict per-chain lookups only: `getNetwork()` falls back to the default network for unknown ids,
// which on a custody surface would offer a member contracts that do not exist on their vault's
// chain. An unknown or non-custody chain yields an empty catalog, and the picker says so honestly.

import { NETWORKS } from './networks'
import { getContractAddressForChain } from './contracts'
import { LIDO_CONTRACTS } from './staking'

const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)

/** Unique, address-bearing entries only — a service with no address on this chain is not offered. */
function entry(id, name, addresses, source, description) {
  const clean = (addresses || []).filter(isAddress)
  if (clean.length === 0) return null
  return { id, name, addresses: [...new Set(clean)], source, description }
}

/**
 * Services a vault on `chainId` may be allowed to interact with.
 * @returns {Array<{id: string, name: string, addresses: string[], source: string, description?: string}>}
 */
export function getServiceCatalog(chainId) {
  const id = Number(chainId)
  const network = NETWORKS[id]
  if (!network) return []

  const out = []

  // Swap venue (Uniswap on Polygon, ETCswap on ETC/Mordor) — named by the network's own provider
  // block so the picker never hardcodes a brand.
  const dex = network.dex
  const dexName = network.dexProvider?.name || 'Swap venue'
  if (dex) {
    out.push(
      entry(
        'dex.swapRouter',
        `${dexName} — swaps`,
        [dex.swapRouter],
        'networks.dex',
        'Trade one token for another at the network’s swap venue.',
      ),
    )
    out.push(
      entry(
        'dex.positionManager',
        `${dexName} — liquidity`,
        [dex.positionManager],
        'networks.dex',
        'Supply or withdraw liquidity positions.',
      ),
    )
  }

  // Staking (spec 065) — the contracts a vault would touch to stake or unstake. Read from the
  // network's own staking block so a chain without staking offers nothing.
  if (network.staking) {
    out.push(
      entry(
        'staking.lido',
        `${network.staking.provider?.name || 'Staking'} — stake`,
        [LIDO_CONTRACTS.steth, LIDO_CONTRACTS.wsteth, LIDO_CONTRACTS.withdrawalQueue],
        'staking',
        'Stake, wrap, and queue withdrawals.',
      ),
    )
  }

  // FairWins contracts a vault legitimately interacts with as a member.
  const platform = [
    ['platform.wagerRegistry', 'FairWins — wagers', 'wagerRegistry', 'Create, accept and settle wagers.'],
    ['platform.wagerPoolFactory', 'FairWins — pools', 'wagerPoolFactory', 'Create and join group wager pools.'],
    ['platform.fundingPoolFactory', 'FairWins — funding pools', 'fundingPoolFactory', 'Pool money toward a shared goal and collect or refund it.'],
    ['platform.membershipManager', 'FairWins — membership', 'membershipManager', 'Buy or renew membership.'],
  ]
  for (const [entryId, name, contractKey, description] of platform) {
    out.push(entry(entryId, name, [getContractAddressForChain(contractKey, id)], 'platform', description))
  }

  return out.filter(Boolean)
}

/** Catalog entry owning a given address on a chain, if any (used to name known destinations). */
export function findServiceByAddress(chainId, address) {
  if (!isAddress(address)) return null
  const needle = address.toLowerCase()
  return (
    getServiceCatalog(chainId).find((service) =>
      service.addresses.some((a) => a.toLowerCase() === needle),
    ) || null
  )
}

export default getServiceCatalog
