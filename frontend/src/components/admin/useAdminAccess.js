/**
 * useAdminAccess (spec 093) — the one place the operations area answers
 * "may this account enter, and what does it hold?".
 *
 * Extracted verbatim from the monolithic AdminPanel so the Control Room and
 * every admin app shell resolve access identically. Three facts it preserves:
 *
 *  - Role flags are ESTATE-WIDE (`hasRole` is true when held on any cohort
 *    chain — spec 071); each view still re-checks the specific contract for
 *    the network it acts on.
 *  - `isAppCurator` is deliberately NOT a `hasRole` flag: APP_CURATOR_ROLE
 *    administers itself on the MiniAppRegistry, so it is asked of the registry
 *    that will enforce it (readCuratorAuthority) and only a definite yes
 *    counts. It also opens the area for a curator who holds nothing else.
 *  - "You hold no operator role" and "we could not ask" are different
 *    statements (FR-012): `entryState` keeps them apart as 'denied' vs
 *    'unverified', and the denied screens render them differently.
 */
import { useEffect, useState } from 'react'
import { useRoles } from '../../hooks/useRoles'
import { useWeb3 } from '../../hooks/useWeb3'
import { useAdminWeb3, useAdminActing } from './adminActing/useAdminWeb3'
import { ROLES, ADMIN_ROLES } from '../../contexts/RoleContext'
import { readCuratorAuthority } from '../../lib/miniapps/registryAuthority'

export function useAdminAccess() {
  const walletRoles = useRoles()
  const { account: walletAccount, chainId } = useWeb3()
  // The console answers for the account it is ACTING as (adminActing/): on the live estate that
  // is the admin Safe, whose owners' keys hold no role of their own. When it is acting as the
  // wallet itself nothing changes and the wallet's own sweep is used.
  const { account } = useAdminWeb3()
  const acting = useAdminActing()
  const sweep = acting?.roleSweep ?? null
  const hasRole = sweep ? (role) => sweep.roles.includes(role) : walletRoles.hasRole
  const hasAnyRole = sweep
    ? (list) => Array.isArray(list) && list.some((r) => sweep.roles.includes(r))
    : walletRoles.hasAnyRole
  const estateRead = sweep ? sweep.estateRead : walletRoles.estateRead
  const chainsForRole = sweep ? (role) => sweep.roleChains[role] || [] : walletRoles.chainsForRole
  const retryRoles = sweep ? acting.retrySweep : () => walletRoles.loadRoles?.(walletAccount, chainId)

  const [curatorAuthority, setCuratorAuthority] = useState(null)
  useEffect(() => {
    let cancelled = false
    readCuratorAuthority({ account }).then((result) => {
      if (!cancelled) setCuratorAuthority(result)
    })
    return () => {
      cancelled = true
    }
  }, [account])
  const isAppCurator = curatorAuthority?.held === true

  const flags = {
    isAdmin: hasRole(ROLES.ADMIN),
    isGuardian: hasRole(ROLES.GUARDIAN),
    isAccountModerator: hasRole(ROLES.ACCOUNT_MODERATOR),
    isRoleManager: hasRole(ROLES.ROLE_MANAGER),
    isSanctionsAdmin: hasRole(ROLES.SANCTIONS_ADMIN),
    isFeeAdmin: hasRole(ROLES.FEE_ADMIN),
    isStakingAdmin: hasRole(ROLES.STAKING_ADMIN),
    isLiquidityAdmin: hasRole(ROLES.LIQUIDITY_ADMIN),
    isAppCurator,
  }

  const hasAdminAccess = hasAnyRole(ADMIN_ROLES) || isAppCurator

  /*
   * Whether the access read has FINISHED — not the same question as whether it granted entry.
   *
   * `hasAdminAccess` can turn true before the role sweep lands: the curator authority is one
   * contract read and resolves first, so for a moment an operator is granted entry while
   * `flags` are still all-false. Anything that acts on the ABSENCE of a flag has to wait for
   * this, or it acts on a fact that is not in yet — see the deep-link redirect in
   * AdminAppShell, which bounced an entitled operator to the Control Room when they followed a
   * link straight to an app.
   */
  const settled = Boolean(estateRead?.swept) && curatorAuthority !== null

  // FR-012: a refusal during a network outage must not read as a permissions
  // problem. No chain answered ⇒ the sweep proved nothing about what is held.
  const noChainAnswered =
    !estateRead?.swept || (estateRead.read.length === 0 && estateRead.unreadable.length > 0)
  const entryState = hasAdminAccess ? 'granted' : noChainAnswered ? 'unverified' : 'denied'

  return {
    flags,
    hasAdminAccess,
    entryState,
    settled,
    curatorAuthority,
    estateRead,
    chainsForRole,
    retry: retryRoles,
  }
}

/**
 * The operator's headline badge — every role that can open the area names
 * itself, and the last resort says what it means ("Operator", never "Admin").
 */
export function adminBadgeLabel(flags) {
  if (flags.isAdmin) return 'Administrator'
  if (flags.isGuardian) return 'Guardian'
  if (flags.isAccountModerator) return 'Moderator'
  if (flags.isRoleManager) return 'Role Manager'
  if (flags.isSanctionsAdmin) return 'Compliance Officer'
  if (flags.isFeeAdmin) return 'Fee Administrator'
  if (flags.isStakingAdmin) return 'Staking Administrator'
  if (flags.isLiquidityAdmin) return 'Liquidity Administrator'
  return 'Operator'
}
