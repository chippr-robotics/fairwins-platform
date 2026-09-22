import { useState, useEffect, useCallback } from 'react'
import { keccak256, stringToHex } from 'viem'
import { readContract } from '../lib/chains/readContract'
import { useWeb3 } from './useWeb3'
import { useEffectiveAccount } from './useEffectiveAccount'
import { getContractAddressForChain } from '../config/contracts'
import { membershipChainId } from '../config/networks'
import { getReadProvider } from '../utils/rpcProvider'
import { MEMBERSHIP_MANAGER_ABI } from '../abis/MembershipManager'

/**
 * Hook to read per-user role + tier details from MembershipManager.
 *
 * The protocol has a single user-purchasable role (`WAGER_PARTICIPANT_ROLE`).
 * For each fetch we read `getMembership(user, role)` + `getTierConfig(role, tier)`
 * and project both into the shape consumed by RoleDetailsCard / Dashboard.
 *
 * ── WHICH ACCOUNT (specs 063 + 088) ──────────────────────────────────────────────────────
 * The ACTING account, never the connected wallet. `MembershipManager.purchaseTier` credits
 * `msg.sender` and has no beneficiary parameter, so a membership belongs to exactly one
 * address; and every gated action — creating a wager, registering a callsign — is sent BY the
 * acting account, so the contract checks the acting account's membership. Reading the
 * connected wallet therefore showed a member switched to a multisig/recovered account the
 * WRONG account's tier and expiry: the card said Gold while the account they were operating
 * as held nothing, and the gate that actually matters would have refused.
 *
 * This resolves through `useEffectiveAccount` rather than WalletContext because
 * `CustodyProvider` nests INSIDE `WalletProvider` — the context that knows the acting account
 * is not visible from the one that loads roles, which is why this could not be fixed there.
 */

export const MembershipTier = {
  NONE: 0,
  BRONZE: 1,
  SILVER: 2,
  GOLD: 3,
  PLATINUM: 4,
}

export const TIER_NAMES = {
  0: 'None',
  1: 'Bronze',
  2: 'Silver',
  3: 'Gold',
  4: 'Platinum',
}

export const TIER_COLORS = {
  0: '#666',
  1: '#CD7F32',
  2: '#C0C0C0',
  3: '#FFD700',
  4: '#E5E4E2',
}

export const ROLE_BYTES32 = {
  WAGER_PARTICIPANT: keccak256(stringToHex('WAGER_PARTICIPANT_ROLE')),
}

/**
 * Ceiling on ONE membership read. Exported for tests.
 *
 * ── WHY THIS EXISTS (issue #1463) ────────────────────────────────────────────────────────
 * `readable: false` is only an honest state if the read can actually REACH it. Without a
 * deadline it could not: a reference chain that answers every JSON-RPC call with an error —
 * `eth_chainId` included — leaves ethers retrying network detection with backoff, so
 * `getMembership` neither resolves nor rejects for as long as the retries run. Every consumer
 * derives "checking…" from a membership that is still `null`, so the member sat on a spinner
 * indefinitely instead of getting the unreadable state and its **Try again** button — the
 * unreadable branch was written, tested, and unreachable on exactly the failure it describes.
 *
 * This is the same rule the account lookup states: every leg is deadline-bounded and expires to
 * the honest unknown, the direct lesson of v1.16.1, where an unbounded wait on an external
 * system turned one failure into a permanent lockout. An unbounded wait does not fail safe; it
 * fails silent, which is worse, because a spinner claims progress that is not happening.
 */
export const MEMBERSHIP_READ_TIMEOUT_MS = 15_000

/** Ceiling on the follow-up tier-config read, which degrades rather than failing the whole read. */
export const TIER_CONFIG_READ_TIMEOUT_MS = 5_000

/**
 * Bound `promise` and REJECT past the ceiling — never resolve to a value, which would be this
 * hook inventing a membership. The rejection lands in the caller's `catch`, which is already the
 * one place that produces `readable: false`, so a timeout and a dead RPC report identically:
 * the chain would not answer.
 */
function withReadTimeout(promise, label, ms = MEMBERSHIP_READ_TIMEOUT_MS) {
  let timer
  const ceiling = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not answer within ${Math.round(ms / 1000)}s`)),
      ms
    )
  })
  // The read may settle after the ceiling wins; that late settlement is discarded, and clearing the
  // timer keeps a resolved read from holding a pending timeout open (fake timers in tests, and a
  // needless wake on a real device).
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer))
}

function emptyDetails(roleName) {
  return {
    roleName,
    tier: 0,
    tierName: 'None',
    tierColor: TIER_COLORS[0],
    expiration: null,
    expirationDate: null,
    isActive: false,
    isExpired: false,
    daysRemaining: null,
    hasRole: false,
    // FR-004: `readable: false` means the reference chain would not answer, so tier 0 here is
    // UNKNOWN rather than "no membership". Consumers must not render the two the same way.
    readable: true,
    wagersCreated: 0,
    wagerLimit: 0,
    canCreateWager: false,
    activeWagers: 0,
    concurrentLimit: 0,
  }
}

/**
 * The read itself, lifted out of the hook so the deadline above can wrap it whole. Pure with
 * respect to component state: it returns details or throws, and the single caller decides what a
 * throw means.
 */
async function readMembership(mgr, address, roleBytes, roleName) {
  const m = await mgr.getMembership(address, roleBytes)
  const details = emptyDetails(roleName)

  details.tier = Number(m.tier)
  details.tierName = TIER_NAMES[details.tier] || 'Unknown'
  details.tierColor = TIER_COLORS[details.tier] || '#666'
  details.activeWagers = Number(m.activeCount)

  const now = Math.floor(Date.now() / 1000)
  const ROLLING_WINDOW = 30 * 24 * 3600
  const monthAnchor = Number(m.monthAnchor)
  details.wagersCreated = (now >= monthAnchor + ROLLING_WINDOW) ? 0 : Number(m.monthCount)

  const expiresAt = Number(m.expiresAt)
  if (expiresAt > 0) {
    details.expiration = expiresAt
    details.expirationDate = new Date(expiresAt * 1000)
    details.isExpired = expiresAt <= now
    details.isActive = expiresAt > now && details.tier > 0
    details.daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / 86400))
    details.hasRole = details.tier > 0
  }

  if (details.tier > 0) {
    // Sub-bounded so a STALLED tier config degrades the LIMITS — what the catch below has always
    // done for a failing one — instead of spending the rest of the outer budget on a read whose
    // answer is optional. It does not reorder the ceilings: the outer one still wraps this call,
    // so a membership that itself came back slowly can leave less than the sub-ceiling's worth of
    // budget, and the whole read then expires to `readable: false`. That is the honest reading of
    // a chain that slow, and it is why the sub-ceiling is the smaller number rather than a
    // promise that this stage always survives.
    try {
      const cfg = await withReadTimeout(
        mgr.getTierConfig(roleBytes, details.tier),
        'The tier config',
        TIER_CONFIG_READ_TIMEOUT_MS
      )
      details.wagerLimit = Number(cfg.limits.monthlyMarketCreation)
      details.concurrentLimit = Number(cfg.limits.maxConcurrentMarkets)
      const monthlyOk = details.wagerLimit === 0 || details.wagersCreated < details.wagerLimit
      const concurrentOk = details.concurrentLimit === 0 || details.activeWagers < details.concurrentLimit
      details.canCreateWager = details.isActive && monthlyOk && concurrentOk
    } catch (e) {
      console.debug(`getTierConfig failed for ${roleName}:`, e.message)
    }
  }

  return details
}

export function useRoleDetails() {
  // The acting account's address — the connected wallet only when acting as yourself.
  const { address } = useEffectiveAccount()
  const { provider, chainId, isConnected } = useWeb3()
  const [roleDetails, setRoleDetails] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const fetchRoleDetails = useCallback(async (roleName) => {
    if (!address || !provider) return null
    const roleBytes = ROLE_BYTES32[roleName]
    if (!roleBytes) return null

    // ── MEMBERSHIP READS THE REFERENCE CHAIN (spec 071 FR-003) ────────────────────────────
    // This used to resolve against the wallet's connected chain, which is why a member
    // connected anywhere other than the reference chain saw tier None with no expiry: on
    // mainnet the MembershipManager exists on Polygon and nowhere else, so the lookup found
    // no contract and returned an empty membership. Both the address AND the provider now
    // come from the reference chain, so they cannot disagree.
    const refChain = membershipChainId()
    const managerAddr = getContractAddressForChain('membershipManager', refChain)
    if (!managerAddr) return emptyDetails(roleName)
    const readProvider =
      Number(refChain) === Number(chainId) && provider ? provider : getReadProvider(refChain)
    if (!readProvider) return { ...emptyDetails(roleName), readable: false }

    try {
      // Reads NAME the reference chain (spec 110); `readProvider` above stays the availability
      // gate, so a chain with no route is still `readable: false` rather than "no membership".
      const mgr = {
        getMembership: (...args) =>
          readContract(refChain, {
            address: managerAddr,
            abi: MEMBERSHIP_MANAGER_ABI,
            functionName: 'getMembership',
            args,
          }),
        getTierConfig: (...args) =>
          readContract(refChain, {
            address: managerAddr,
            abi: MEMBERSHIP_MANAGER_ABI,
            functionName: 'getTierConfig',
            args,
          }),
      }
      // The outer ceiling covers the WHOLE read, every hop of it: what must be bounded is how
      // long a consumer can be left in "checking…", which is the sum, not any single call. The
      // sub-ceiling inside only decides whether a stalled follow-up degrades or counts against
      // this budget — it can never extend it.
      return await withReadTimeout(
        readMembership(mgr, address, roleBytes, roleName),
        `Membership chain ${refChain}`
      )
    } catch (err) {
      // Unknown, not "no membership" (FR-004). Returning a bare emptyDetails here told a member
      // whose reference chain blipped that they owned nothing.
      console.error(`Error fetching ${roleName} details:`, err)
      return { ...emptyDetails(roleName), readable: false }
    }
  }, [address, provider, chainId])

  const fetchAllRoleDetails = useCallback(async () => {
    if (!address || !provider) {
      setRoleDetails({})
      return
    }
    setLoading(true)
    setError(null)
    try {
      const roles = ['WAGER_PARTICIPANT']
      const details = {}
      await Promise.all(roles.map(async (roleName) => {
        const detail = await fetchRoleDetails(roleName)
        if (detail) details[roleName] = detail
      }))
      setRoleDetails(details)
    } catch (err) {
      console.error('Error fetching role details:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [address, provider, fetchRoleDetails])

  useEffect(() => {
    if (isConnected && address && provider) {
      fetchAllRoleDetails()
    } else {
      setRoleDetails({})
    }
  }, [isConnected, address, provider, fetchAllRoleDetails])

  const getRoleDetails = useCallback((roleName) => roleDetails[roleName] || null, [roleDetails])
  const getActiveRoles = useCallback(() =>
    Object.values(roleDetails).filter(r => r.hasRole && r.isActive),
    [roleDetails])
  const getExpiringSoonRoles = useCallback(() =>
    Object.values(roleDetails).filter(r =>
      r.hasRole && r.isActive && r.daysRemaining !== null && r.daysRemaining <= 7),
    [roleDetails])
  const getRolesAtLimit = useCallback(() =>
    Object.values(roleDetails).filter(r =>
      r.hasRole && r.isActive && r.wagerLimit > 0 && !r.canCreateWager),
    [roleDetails])

  return {
    roleDetails,
    loading,
    error,
    refresh: fetchAllRoleDetails,
    getRoleDetails,
    getActiveRoles,
    getExpiringSoonRoles,
    getRolesAtLimit,
  }
}

export default useRoleDetails
