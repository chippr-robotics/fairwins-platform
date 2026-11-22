/**
 * The estate-wide operator-role sweep for ANY address — the probe half of
 * `WalletContext#syncRolesWithBlockchain`, lifted out so the admin console can ask it of an
 * address that is not the connected wallet.
 *
 * Why that matters: on the live estate every operator role is held by the admin SAFE, not by
 * any key. An operator who connects a Ledger or Trezor that OWNS the Safe holds nothing in their
 * own right, so a console that only ever asked about the connected wallet answered "Access
 * Restricted" to the one person meant to run it. The console now asks about the account it is
 * ACTING as (`adminActing/`), which needs the same sweep without the wallet's local-storage
 * bookkeeping — this module has no side effects at all.
 *
 * The three-state rules are unchanged (spec 071 FR-011): a chain answered, a chain carries none
 * of the operator contracts, or a chain would not answer — and only the first counts toward
 * "checked".
 */
import { cohortChainIds } from '../../config/networks'
import { hasRoleOnChain } from '../../utils/blockchainService'
import { classifyEstateProbes } from '../chains/estateSweep'

/**
 * The operator roles the sweep asks about. STAKING_ADMIN was once missing here while present in
 * ADMIN_ROLES, which locked the staking administrator out — keep this list and ADMIN_ROLES in step.
 */
export const SWEPT_ADMIN_ROLES = Object.freeze([
  'ADMIN',
  'GUARDIAN',
  'ACCOUNT_MODERATOR',
  'ROLE_MANAGER',
  'SANCTIONS_ADMIN',
  'FEE_ADMIN',
  'STAKING_ADMIN',
  'LIQUIDITY_ADMIN',
])

/** Cohort chains, with `firstChainId` (the wallet's chain) asked first. */
export function orderedCohort(firstChainId, chains = cohortChainIds()) {
  return [
    ...chains.filter((id) => Number(id) === Number(firstChainId)),
    ...chains.filter((id) => Number(id) !== Number(firstChainId)),
  ]
}

/**
 * One probe per (role, chain), concurrently — a slow chain never holds up the rest (FR-015).
 * A thrown probe is an outage, not an absence.
 *
 * @param {string} address
 * @param {number[]} chainIds
 * @param {{ probe?: typeof hasRoleOnChain, roles?: string[] }} [io]
 */
export async function probeAdminRoles(address, chainIds, { probe = hasRoleOnChain, roles = SWEPT_ADMIN_ROLES } = {}) {
  return Promise.all(
    roles.flatMap((roleName) =>
      chainIds.map(async (id) => {
        try {
          const r = await probe(address, roleName, id, { detailed: true })
          return {
            roleName,
            chainId: id,
            held: Boolean(r?.held),
            readable: r?.readable !== false,
            // Only the probe knows whether there was a contract to ask; dropping this is what once
            // let a chain with nothing deployed count as a chain that answered.
            deployed: r?.deployed !== false,
          }
        } catch (e) {
          return { roleName, chainId: id, held: false, readable: false, deployed: true, reason: e?.message }
        }
      }),
    ),
  )
}

/** Where each role was found. A role with no entry is not held anywhere we could read. */
export function rolesFoundOn(probes) {
  const foundOn = {}
  for (const p of probes) {
    if (p.held) (foundOn[p.roleName] ||= []).push(p.chainId)
  }
  return foundOn
}

/**
 * The whole sweep for an arbitrary address: which operator roles it holds, where, and which
 * chains could not be asked. Never throws — a failure of the sweep itself comes back unswept,
 * which the console renders as "could not verify", never as "you hold nothing".
 *
 * @returns {Promise<{ roles: string[], roleChains: Record<string, number[]>,
 *   estateRead: { read: number[], notDeployed: number[], unreadable: number[], swept: boolean } }>}
 */
export async function sweepAdminRoles(address, { firstChainId = null, chains, probe } = {}) {
  try {
    const ordered = orderedCohort(firstChainId, chains ?? cohortChainIds())
    const probes = await probeAdminRoles(address, ordered, probe ? { probe } : undefined)
    const roleChains = rolesFoundOn(probes)
    const { read, notDeployed, unreadable } = classifyEstateProbes(probes, ordered)
    return {
      roles: SWEPT_ADMIN_ROLES.filter((r) => (roleChains[r] || []).length > 0),
      roleChains,
      estateRead: { read, notDeployed, unreadable, swept: true },
    }
  } catch {
    return { roles: [], roleChains: {}, estateRead: { read: [], notDeployed: [], unreadable: [], swept: false } }
  }
}
