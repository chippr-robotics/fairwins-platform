/**
 * Plain-language descriptions of admin-Safe proposals — what an owner is being asked to approve.
 *
 * This is the half of "view the transaction" a hardware device cannot do. A Ledger or Trezor
 * approving a Safe proposal is shown `approveHash(bytes32)` on a Safe address and nothing else:
 * the action itself (a role grant, an upgrade, a pause) lives behind the hash. So the console has
 * to say what the hash COMMITS to, decoded from the hub's verified preimage, and print the hash so
 * the owner can match it against the device screen.
 *
 * Same honesty rule as `lib/custody/describeProposal.js`: describe only what is POSITIVELY
 * recognised, and otherwise return the raw selector + calldata. A confident wrong description of
 * an upgrade is worse than hex (constitution III).
 */
import { decodeFunctionData, getAddress, keccak256, parseAbi, stringToHex } from 'viem'
import { getContractAddressForChain } from '../../config/contracts'
import { describeProposal } from '../custody/describeProposal'

const ROLE_NAMES = [
  'UPGRADER_ROLE',
  'GUARDIAN_ROLE',
  'ACCOUNT_MODERATOR_ROLE',
  'ROLE_MANAGER_ROLE',
  'SANCTIONS_ADMIN_ROLE',
  'FEE_ADMIN_ROLE',
  'STAKING_ADMIN_ROLE',
  'LIQUIDITY_ADMIN_ROLE',
  'APP_CURATOR_ROLE',
  'CURATOR_ROLE',
  'MODERATOR_ROLE',
  'VERIFIER_ROLE',
  'PAUSER_ROLE',
  'WAGER_PARTICIPANT_ROLE',
  'POOL_PARTICIPANT_ROLE',
]

/** role hash (lowercase) → name. DEFAULT_ADMIN_ROLE is the zero hash by OZ convention. */
export const ROLE_BY_HASH = Object.freeze(
  Object.fromEntries([
    ['0x' + '00'.repeat(32), 'DEFAULT_ADMIN_ROLE'],
    ...ROLE_NAMES.map((n) => [keccak256(stringToHex(n)).toLowerCase(), n]),
  ]),
)

const ROLE_KEYS = {
  admin: '0x' + '00'.repeat(32),
  upgrader: keccak256(stringToHex('UPGRADER_ROLE')),
}

/** Deployment keys the console writes to — used to NAME a proposal's target, never to trust it. */
const KNOWN_CONTRACT_KEYS = [
  'wagerRegistry',
  'wagerRegistryIntents',
  'membershipManager',
  'wagerPoolFactory',
  'fundingPoolFactory',
  'feeRouter',
  'bridgeRouter',
  'liquidityRouter',
  'stakingRouter',
  'callsignRegistry',
  'miniAppRegistry',
  'sanctionsGuard',
  'safeProposalHub',
  'tokenFactory',
  'polymarketAdapter',
  'umaAdapter',
  'chainlinkDataFeedAdapter',
  'chainlinkFunctionsAdapter',
  'verifyingPaymaster',
  'safePolicyGuard',
  'safePolicyGuardV2',
]

/** The deployment key recorded at `address` on `chainId`, or null. */
export function contractNameAt(address, chainId) {
  if (!address || chainId == null) return null
  let target
  try {
    target = getAddress(address)
  } catch {
    return null
  }
  for (const key of KNOWN_CONTRACT_KEYS) {
    const at = getContractAddressForChain(key, chainId)
    if (!at) continue
    try {
      if (getAddress(at) === target) return key
    } catch {
      /* malformed record — skip, never match */
    }
  }
  return null
}

const ADMIN_ABI = parseAbi([
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function renounceRole(bytes32 role, address callerConfirmation)',
  'function upgradeToAndCall(address newImplementation, bytes data)',
  'function pause()',
  'function unpause()',
  'function transferOwnership(address newOwner)',
  'function setTreasury(address treasury)',
  'function setIntentExtension(address extension)',
])

const short = (a) => {
  try {
    const x = getAddress(a)
    return `${x.slice(0, 6)}…${x.slice(-4)}`
  } catch {
    return String(a)
  }
}

function tryDecode(data) {
  try {
    return decodeFunctionData({ abi: ADMIN_ABI, data })
  } catch {
    return null
  }
}

/**
 * What a hardware device shows when approving: a call to the Safe whose data is the
 * `approveHash(bytes32)` selector followed by the hash — so the hash's last characters are what
 * an owner compares against the screen.
 */
export function deviceCheck(safeTxHash) {
  const h = String(safeTxHash || '').toLowerCase()
  return { calldataPrefix: '0xd4d9bdcd', tail: h.slice(-8) }
}

const roleName = (hash) => ROLE_BY_HASH[String(hash).toLowerCase()] ?? `role ${String(hash).slice(0, 10)}…`

/**
 * @param {{ to: string, value?: bigint|string, data?: string }} call
 * @param {{ chainId: number, safeAddress?: string }} ctx
 * @returns {{ title: string, detail: string|null, target: string, targetName: string|null,
 *   selector: string|null, recognised: boolean, critical: boolean }}
 */
export function describeAdminCall(call, { chainId, safeAddress } = {}) {
  const data = call?.data ?? '0x'
  const targetName = contractNameAt(call?.to, chainId)
  const target = targetName ?? short(call?.to)
  const selector = data.length >= 10 ? data.slice(0, 10) : null
  const base = { target, targetName, selector }

  const decoded = tryDecode(data)

  if (decoded) {
    const [a0, a1] = decoded.args ?? []
    switch (decoded.functionName) {
      case 'grantRole':
        return { ...base, recognised: true, critical: a0 === ROLE_KEYS.admin || a0 === ROLE_KEYS.upgrader,
          title: `Grant ${roleName(a0)}`, detail: `to ${short(a1)} on ${target}` }
      case 'revokeRole':
        return { ...base, recognised: true, critical: a0 === ROLE_KEYS.admin || a0 === ROLE_KEYS.upgrader,
          title: `Revoke ${roleName(a0)}`, detail: `from ${short(a1)} on ${target}` }
      case 'renounceRole':
        return { ...base, recognised: true, critical: true,
          title: `Renounce ${roleName(a0)}`, detail: `held by ${short(a1)} on ${target}` }
      case 'upgradeToAndCall':
        return { ...base, recognised: true, critical: true,
          title: `Upgrade ${target}`,
          detail: `to implementation ${short(a0)}${a1 && a1 !== '0x' ? ' and run an initializer call' : ''}` }
      case 'pause':
        return { ...base, recognised: true, critical: false, title: `Pause ${target}`, detail: null }
      case 'unpause':
        return { ...base, recognised: true, critical: false, title: `Unpause ${target}`, detail: null }
      case 'transferOwnership':
        return { ...base, recognised: true, critical: true, title: `Transfer ownership of ${target}`, detail: `to ${short(a0)}` }
      case 'setTreasury':
        return { ...base, recognised: true, critical: true, title: `Change the treasury of ${target}`, detail: `to ${short(a0)}` }
      case 'setIntentExtension':
        return { ...base, recognised: true, critical: true,
          title: `Repoint the intents facet of ${target}`, detail: `to ${short(a0)} (equivalent to an upgrade)` }
      default:
        break
    }
  }

  // Safe self-management (owners / threshold) and policy changes — the vault Queue's decoder.
  const custody = describeProposal(call, { chainId, vaultAddress: safeAddress })
  if (custody) {
    return { ...base, recognised: true, critical: custody.kind !== 'transfer-native', title: custody.title, detail: custody.detail }
  }

  return {
    ...base,
    recognised: false,
    critical: false,
    title: selector ? `Call ${selector} on ${target}` : `Send to ${target}`,
    detail: null,
  }
}
