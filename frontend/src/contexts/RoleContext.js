import { createContext } from 'react'

export const RoleContext = createContext(null)

/**
 * Roles in the P2P wager system.
 *
 * One user-purchasable role (`WAGER_PARTICIPANT`) and four on-chain admin
 * roles enforced via OpenZeppelin AccessControl on MembershipManager and
 * WagerRegistry. Each admin role gates a distinct piece of the operator
 * surface; see docs/system-overview/roles-and-tiers.md for the canonical
 * description of who can do what.
 */
export const ROLES = {
  // Sole user-purchasable role
  WAGER_PARTICIPANT: 'WAGER_PARTICIPANT',

  // Administrative roles (on-chain via AccessControl)
  ADMIN: 'ADMIN',                          // DEFAULT_ADMIN_ROLE
  GUARDIAN: 'GUARDIAN',                    // GUARDIAN_ROLE — pause/unpause
  ACCOUNT_MODERATOR: 'ACCOUNT_MODERATOR',  // ACCOUNT_MODERATOR_ROLE — freeze
  ROLE_MANAGER: 'ROLE_MANAGER',            // ROLE_MANAGER_ROLE — grant/revoke memberships
  SANCTIONS_ADMIN: 'SANCTIONS_ADMIN',      // SANCTIONS_ADMIN_ROLE — deny-list (on SanctionsGuard)
  FEE_ADMIN: 'FEE_ADMIN',                  // FEE_ADMIN_ROLE — platform-fee rates (on FeeRouter, spec 060)
  STAKING_ADMIN: 'STAKING_ADMIN',          // STAKING_ADMIN_ROLE — staking provider addrs + validator allowlist (on StakingRouter, spec 066)
  LIQUIDITY_ADMIN: 'LIQUIDITY_ADMIN',      // LIQUIDITY_ADMIN_ROLE — bridge routes + curated pools (on BOTH BridgeRouter and LiquidityRouter, spec 067)
}

export const ROLE_INFO = {
  [ROLES.WAGER_PARTICIPANT]: {
    name: 'Wager Participant',
    description: 'Create and accept peer-to-peer wagers in USDC or WPOL',
    premium: true,
    isAdminRole: false
  },
  [ROLES.ADMIN]: {
    name: 'Administrator',
    description: 'Full system access: tier config, treasury, and authority to grant other admin roles',
    premium: false,
    isAdminRole: true
  },
  [ROLES.GUARDIAN]: {
    name: 'Emergency Guardian',
    description: 'Pause and unpause the WagerRegistry in response to security incidents',
    premium: false,
    isAdminRole: true
  },
  [ROLES.ACCOUNT_MODERATOR]: {
    name: 'Account Moderator',
    description: 'Freeze and unfreeze individual accounts. See the account moderation policy for criteria',
    premium: false,
    isAdminRole: true
  },
  [ROLES.ROLE_MANAGER]: {
    name: 'Role Manager',
    description: 'Grant or revoke memberships outside the purchase flow (gifts, support, dispute resolution)',
    premium: false,
    isAdminRole: true
  },
  [ROLES.SANCTIONS_ADMIN]: {
    name: 'Compliance Officer',
    description: 'Maintain the discretionary deny-list on SanctionsGuard (block/unblock addresses with an on-chain reason)',
    premium: false,
    isAdminRole: true
  },
  [ROLES.FEE_ADMIN]: {
    name: 'Fee Administrator',
    description: 'Set platform-fee rates (within their hard caps) on the FeeRouter — wrapper services and the Polymarket builder fee',
    premium: false,
    isAdminRole: true
  },
  [ROLES.STAKING_ADMIN]: {
    name: 'Staking Administrator',
    description: 'Manage staking provider addresses and the curated validator allowlist on the StakingRouter (the fee rate is set by the Fee Administrator)',
    premium: false,
    isAdminRole: true
  },
  [ROLES.LIQUIDITY_ADMIN]: {
    name: 'Liquidity Administrator',
    description: 'Curate bridge routes and the supplied pool list, and set their limits and addresses, on the BridgeRouter and LiquidityRouter (the fee rate is set by the Fee Administrator)',
    premium: false,
    isAdminRole: true
  },
}

/**
 * Admin roles that grant access to the admin portal.
 * Each individual tab inside the portal is gated separately by its role.
 */
export const ADMIN_ROLES = [
  ROLES.ADMIN,
  ROLES.GUARDIAN,
  ROLES.ACCOUNT_MODERATOR,
  ROLES.ROLE_MANAGER,
  ROLES.SANCTIONS_ADMIN,
  ROLES.FEE_ADMIN,
  ROLES.STAKING_ADMIN,
  ROLES.LIQUIDITY_ADMIN,
]

export function isAdminRole(role) {
  return ADMIN_ROLES.includes(role)
}

export function getRoleName(role) {
  return ROLE_INFO[role]?.name || role
}
