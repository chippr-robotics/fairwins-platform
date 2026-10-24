/**
 * The member's wagers across the whole estate (spec 110 Phase 4, T040 — issue #1595).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 * Reads went estate-wide for balances, activity and vaults (specs 071, 092, 102). The wager list
 * did not — and it is the one carrying **actions**. `fetchFriendMarketsForUser(address, chainId)`
 * asked a single chain, `FriendMarketsContext` passed it the wallet's chain, and the Claim button
 * then resolved its registry from the wallet's chain too. Those two agreed by COINCIDENCE, not by
 * construction, and the coincidence is the whole reason Claim could not name a chain: a wager on
 * another network was never in the list to be claimed.
 *
 * ── THE THREE STATES ARE THE POINT, AND ONE OF THEM IS EASY TO LOSE ────────────────────────────
 * `fetchFriendMarketsForUser` returns `[]` for two completely different situations: this chain has
 * no wager contract configured, and this chain has a contract that reported no wagers. It also
 * THROWS when the endpoint is down — which is the good case, because a throw is distinguishable.
 * Flattening all three into "no wagers here" is the dishonesty spec 071's `chainReadResult` was
 * built to prevent, so the deployment question is asked HERE, before the fetch, and the answer is
 * `not-deployed` rather than an empty list.
 *
 * An unreadable chain therefore never renders as "you have no wagers on Base". It renders as a
 * named network the app could not reach, and the member's other chains are unaffected — per-chain
 * failure isolation, exactly as `readAcrossEstate` does it.
 *
 * ── THE DEADLINE IS NEW, AND DELIBERATE ────────────────────────────────────────────────────────
 * `readAcrossEstate` has none. It did not need one: an operator console read that hangs leaves one
 * tile spinning. Here a single hung endpoint would hold the member's ENTIRE wager list — every
 * chain's — behind it, because the list cannot render until the slowest chain answers. So a chain
 * that does not answer in time becomes `unreadable` with a reason, which is what it honestly is.
 */
import { cohortChainIds, isInCohort, getCurrentChainId, NETWORKS } from '../../config/networks'
import { getContractAddressForChain, isLocalOnlyChain } from '../../config/contracts'
import { readOk, notDeployed, unreadable, READ, UNREADABLE } from '../chains/chainReadResult'
import { fetchFriendMarketsForUser } from '../../utils/blockchainService'

/** How long one chain gets before its wagers are reported unreadable rather than awaited. */
export const WAGER_READ_DEADLINE_MS = 20_000

/**
 * The chains this build actually reads wagers from: the cohort MINUS the local-only sandboxes,
 * unless this build is ITSELF pointed at one.
 *
 * `lib/screening/sources.js#screeningChainIds` established the rule and `isLocalOnlyChain`'s own
 * docstring names the obligation: a shipped build can never reach `http://127.0.0.1:8545`, so a
 * read routed there is a GUARANTEED failure, and a caller that would report that failure to a
 * member as a degraded state has to exclude the chain first. Without this, every shipped testnet
 * build names "Hardhat" as a network it could not read on the wager list — permanently, for every
 * member, about a node that was never theirs.
 *
 * The exception is the point of the exception: when `getCurrentChainId()` IS the local chain this
 * is a local build, the node is right there, and dropping it would empty the list it exists to
 * show. Reachability is the test, not the chain id.
 *
 * It also removes a duplicate the e2e rig creates. `setup:e2e` runs with `E2E_AMOY_LOCAL=1` and
 * records the local node's contracts under chain 80002 while `VITE_NETWORK_ID=80002` makes 1337 a
 * cohort member too — one node answering to two chain ids, so the estate read returned every
 * wager TWICE, tagged with a different chain each time. The dedupe cannot collapse those and must
 * not try: two chain ids with the same registry address is a real production shape (CREATE2), and
 * a key that merged them would drop a genuinely distinct wager. The right answer is not to read a
 * chain this build cannot reach.
 */
export function wagerEstateChainIds() {
  const buildChain = Number(getCurrentChainId())
  return cohortChainIds().filter((id) => !isLocalOnlyChain(id) || Number(id) === buildChain)
}

/** Display name for a chain, or an honest placeholder — never a guessed one. */
export const wagerNetworkName = (chainId) => NETWORKS[Number(chainId)]?.name || `Chain ${chainId}`

/**
 * Does this chain carry a wager contract at all? `wagerRegistry` is the active one; the v1
 * `friendGroupMarketFactory` is the legacy fallback the fetcher still honours, so a chain with
 * only that is deployed for this purpose too.
 */
export function hasWagerContract(chainId) {
  for (const name of ['wagerRegistry', 'friendGroupMarketFactory']) {
    try {
      if (getContractAddressForChain(name, chainId)) return true
    } catch {
      // Not configured for this chain — try the next name, then answer no.
    }
  }
  return false
}

/** Stamp a chain onto each wager, with a chain-qualified id so two chains' ids cannot collide. */
export function tagWagers(markets, chainId) {
  return (markets || []).map((m) => ({
    ...m,
    chainId,
    uniqueId: `${chainId || 'unknown'}-${m.contractAddress || 'unknown'}-${m.id}`,
  }))
}

function withDeadline(promise, ms, chainId) {
  if (!ms) return promise
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${wagerNetworkName(chainId)} did not answer in time`)),
        ms,
      )
    }),
  ])
}

/**
 * One three-state reading per cohort chain. Never rejects: a chain that fails fails alone.
 *
 * @param {string} address the member
 * @param {object} [opts]
 * @param {number[]} [opts.chainIds] defaults to `wagerEstateChainIds()` — the build's cohort minus
 *   unreachable local-only sandboxes (constitution III — never `listSupportedChainIds()`, which
 *   spans both cohorts)
 * @param {(address: string, chainId: number) => Promise<Array>} [opts.fetchForChain] injectable
 * @param {number} [opts.deadlineMs]
 * @returns {Promise<Array<object>>} `chainReadResult` shapes; `value` is the tagged wager array
 */
export async function readWagersAcrossEstate(address, { chainIds, fetchForChain = fetchFriendMarketsForUser, deadlineMs = WAGER_READ_DEADLINE_MS } = {}) {
  const ids = (chainIds ?? wagerEstateChainIds()).filter(isInCohort)
  if (!address) return ids.map((chainId) => readOk(chainId, []))

  return Promise.all(
    ids.map(async (chainId) => {
      // Asked BEFORE the fetch, because the fetcher answers `[]` here and `[]` is a claim about
      // the member ("you have none") rather than about the chain ("there is nothing to ask").
      if (!hasWagerContract(chainId)) return notDeployed(chainId)
      try {
        const markets = await withDeadline(fetchForChain(address, chainId), deadlineMs, chainId)
        return readOk(chainId, tagWagers(markets, chainId))
      } catch (e) {
        return unreadable(chainId, e?.message || 'wagers could not be read on this network')
      }
    }),
  )
}

/** Every wager that was actually read, flattened. A chain that did not answer contributes none. */
export function wagersFrom(readings) {
  return (readings || []).filter((r) => r.status === READ).flatMap((r) => r.value || [])
}

/**
 * The networks that could not be read, by name — so a surface can say which, rather than
 * implying the member simply has no wagers there (the spec-071 partial-total rule).
 */
export function unreadableNetworks(readings) {
  return (readings || []).filter((r) => r.status === UNREADABLE).map((r) => wagerNetworkName(r.chainId))
}

/** True when at least one chain did not answer, so any count drawn from this is incomplete. */
export const isPartial = (readings) => unreadableNetworks(readings).length > 0

export default readWagersAcrossEstate
