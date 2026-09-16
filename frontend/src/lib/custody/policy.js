// Spec 049 — multisig policy engine client library. Reads/encodes SafePolicyGuard state, builds
// the vault-creation setup payload and threshold-approved change transactions, runs pre-flight
// checks via the guard's own previewTransaction (so client display can never drift from on-chain
// enforcement), and decodes the guard's typed errors into plain language (FR-011/FR-012).
// See specs/049-multisig-policy-engine/contracts/frontend-integration.md.

import { decodeErrorResult, encodeFunctionData, zeroAddress } from 'viem'
import { NoRpcEndpointError, normalizeAbi, readContract } from '../chains/readContract'
import { getPublicClient } from '../chains/publicClient'
import { getAddress } from '../evm/address'
import { formatUnits } from '../evm/units'
import { POLICY_GUARD_SETUP_ABI, SAFE_POLICY_GUARD_ABI } from '../../abis/SafePolicyGuard'
import { getContractAddressForChain } from '../../config/contracts'

/** keccak256("guard_manager.guard.address") — the Safe v1.4.1 guard storage slot. */
export const GUARD_STORAGE_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'

/** Native-coin asset key inside the guard (address(0)). */
export const NATIVE_ASSET = zeroAddress

/**
 * The parsed ABIs, exported in place of the ethers `Interface`s this module used to hand out
 * (spec 110). Consumers encode with `encodeFunctionData({ abi: GUARD_ABI, … })` and decode with
 * `decodeFunctionData` / `decodeErrorResult`.
 */
export const GUARD_ABI = normalizeAbi(SAFE_POLICY_GUARD_ABI)
export const SETUP_ABI = normalizeAbi(POLICY_GUARD_SETUP_ABI)
const SET_GUARD_ABI = normalizeAbi(['function setGuard(address guard)'])

/** Policy engine addresses for a chain; null when the engine is not deployed there (FR-013). */
export function getPolicyEngineAddresses(chainId) {
  const guard = getContractAddressForChain('safePolicyGuard', chainId)
  const setup = getContractAddressForChain('policyGuardSetup', chainId)
  if (!guard || !setup) return null
  return { guard: getAddress(guard), setup: getAddress(setup) }
}

/** Whether the policy engine is available on a chain. */
export function isPolicySupported(chainId) {
  return getPolicyEngineAddresses(chainId) !== null
}

/**
 * Read the guard address set on a vault (the zero address when none).
 *
 * No `provider` parameter since spec 110: the chain is NAMED, so the slot is always read on the
 * chain the vault instance lives on rather than through whatever connection was passed down. That
 * is the point of the seam — a vault on Base is read on Base whatever the wallet is doing.
 */
export async function readVaultGuard(vaultAddress, chainId) {
  const client = getPublicClient(chainId)
  if (!client) throw new NoRpcEndpointError(chainId)
  const raw = await client.getStorageAt({ address: getAddress(vaultAddress), slot: GUARD_STORAGE_SLOT })
  return getAddress('0x' + String(raw).slice(-40))
}

/**
 * Derive a vault's policy status (US2): 'unsupported' (engine not on this network),
 * 'none' (no guard set), 'managed' (our guard), or 'foreign' (another guard —
 * "unrecognized rule — manage with the interface that created it").
 */
export async function getPolicyStatus(vaultAddress, chainId) {
  const engine = getPolicyEngineAddresses(chainId)
  // FR-013: networks without the engine surface "policy unsupported" — no guard-slot read needed.
  if (!engine) return 'unsupported'
  const guardSet = await readVaultGuard(vaultAddress, chainId).catch(() => zeroAddress)
  if (guardSet === zeroAddress) return 'none'
  return guardSet === engine.guard ? 'managed' : 'foreign'
}

/**
 * Aggregate one vault's full policy for rendering (FR-005/FR-006, batched for SC-004):
 * summary + per-asset rules with live window state + allowlist + next-allowed time.
 */
export async function readPolicy(vaultAddress, chainId) {
  const engine = getPolicyEngineAddresses(chainId)
  if (!engine) return null
  // `getPolicy` and `getAssetRule` are MULTI-OUTPUT, which viem returns as a bare array where
  // ethers returned a named Result. `readContract` re-attaches the parameter names, so the field
  // reads below are unchanged — see the note in `lib/chains/readContract.js`. The small integers
  // (`allowlistCount`/`cooldown`, uint32) come back as NUMBERS rather than bigints; every one of
  // them already goes through `Number(...)`, and a new one must too.
  const guardRead = (functionName, args) =>
    readContract(chainId, { address: engine.guard, abi: SAFE_POLICY_GUARD_ABI, functionName, args })
  const safe = getAddress(vaultAddress)
  const [summary, allowlist, nextAllowed] = await Promise.all([
    guardRead('getPolicy', [safe]),
    guardRead('getAllowlist', [safe]),
    guardRead('nextAllowedAt', [safe]),
  ])
  const configuredAssets = [...summary.configuredAssets]
  const assetRules = await Promise.all(
    configuredAssets.map(async (asset) => {
      const [rule, remaining] = await Promise.all([
        guardRead('getAssetRule', [safe, asset]),
        guardRead('remainingInWindow', [safe, asset]),
      ])
      return {
        asset: getAddress(asset),
        perTxLimit: rule.perTxLimit,
        windowLimit: rule.windowLimit,
        spentInWindow: rule.spentInWindow,
        windowStart: rule.windowStart,
        remainingInWindow: remaining,
      }
    }),
  )
  return {
    hasRules: summary.hasRules,
    allowlistEnabled: summary.allowlistEnabled,
    allowlistCount: Number(summary.allowlistCount),
    cooldown: Number(summary.cooldown),
    lastCountedTxAt: Number(summary.lastCountedTxAt),
    nextAllowedAt: Number(nextAllowed),
    allowlist: allowlist.map((a) => getAddress(a)),
    assetRules,
  }
}

/**
 * Validate a policy config before encoding (FR-015). Throws with a user-facing message.
 * @param {{limits?:Array<{asset:string,perTxLimit:bigint,windowLimit:bigint}>, cooldown?:number,
 *   allowlistEnabled?:boolean, allowlistAdd?:string[], allowlistRemove?:string[]}} config
 */
export function validatePolicyConfig(config) {
  const { limits = [], cooldown = 0, allowlistEnabled = false, allowlistAdd = [], allowlistRemove = [] } = config
  const MAX_UINT128 = (1n << 128n) - 1n
  const seen = new Set()
  for (const l of limits) {
    let asset
    try {
      asset = getAddress(l.asset)
    } catch {
      throw new Error(`Invalid asset address: ${l.asset}`)
    }
    if (seen.has(asset)) throw new Error(`Duplicate asset in limits: ${asset}`)
    seen.add(asset)
    const perTx = BigInt(l.perTxLimit ?? 0)
    const window = BigInt(l.windowLimit ?? 0)
    if (perTx < 0n || window < 0n) throw new Error('Limits must be positive')
    if (perTx > MAX_UINT128 || window > MAX_UINT128) throw new Error('Limit exceeds the maximum representable amount')
    if (perTx > 0n && window > 0n && perTx > window) {
      throw new Error('A per-transaction limit above the 24-hour window limit can never be reached')
    }
  }
  if (limits.length > 16) throw new Error('At most 16 assets can carry limits')
  const cd = Number(cooldown)
  if (!Number.isInteger(cd) || cd < 0) throw new Error('Cooldown must be a whole number of seconds')
  if (cd > 365 * 24 * 3600) throw new Error('Cooldown cannot exceed 365 days')
  for (const a of [...allowlistAdd, ...allowlistRemove]) {
    try {
      getAddress(a)
    } catch {
      throw new Error(`Invalid allowlist address: ${a}`)
    }
  }
  if (allowlistAdd.length + allowlistRemove.length > 64) throw new Error('At most 64 allowlist changes per update')
  if (allowlistEnabled && allowlistAdd.length === 0 && allowlistRemove.length === 0 && !config.allowlistAlreadyPopulated) {
    // Guard enforces non-empty on-chain; catch the obvious client case early.
    throw new Error('Enable the allowlist with at least one recipient — an empty allowlist would block everything')
  }
}

/** Encode a full `configureRules` call for the guard (used at creation and for changes). */
export function encodeConfigureRules(config) {
  validatePolicyConfig(config)
  const { limits = [], cooldown = 0, allowlistEnabled = false, allowlistAdd = [], allowlistRemove = [] } = config
  return encodeFunctionData({ abi: GUARD_ABI, functionName: 'configureRules', args: [
    limits.map((l) => ({
      asset: getAddress(l.asset),
      perTxLimit: BigInt(l.perTxLimit ?? 0),
      windowLimit: BigInt(l.windowLimit ?? 0),
    })),
    Number(config.cooldown ?? cooldown),
    allowlistEnabled,
    allowlistAdd.map((a) => getAddress(a)),
    allowlistRemove.map((a) => getAddress(a)),
  ] })
}

/**
 * Build the `Safe.setup` delegatecall payload attaching the guard + initial rules at vault
 * creation (US1). Feed the result to `buildSetupInitializer`'s `setupTo`/`setupData`.
 * @returns {{setupTo:string, setupData:string}}
 */
export function buildEnablePolicySetup(chainId, config) {
  const engine = getPolicyEngineAddresses(chainId)
  if (!engine) throw new Error(`The policy engine is not available on chain ${chainId}`)
  const configureCalldata = config ? encodeConfigureRules(config) : '0x'
  return {
    setupTo: engine.setup,
    setupData: encodeFunctionData({ abi: SETUP_ABI, functionName: 'enablePolicy', args: [engine.guard, configureCalldata] }),
  }
}

/**
 * Build the Safe self-transaction that changes a deployed vault's policy (US3). The returned
 * `{to, value, data}` goes through the existing spec 043 propose/approve queue, so FR-007
 * (threshold) and FR-009 (approvals bind to exact content via safeTxHash) are inherited.
 */
export function buildPolicyChangeTx(chainId, config) {
  const engine = getPolicyEngineAddresses(chainId)
  if (!engine) throw new Error(`The policy engine is not available on chain ${chainId}`)
  return { to: engine.guard, value: 0n, data: encodeConfigureRules(config) }
}

/**
 * Build the Safe self-transaction that attaches the guard to an EXISTING vault via
 * `Safe.setGuard` (queued AFTER the configureRules tx so rules exist before the guard activates
 * — no half-set gap; frontend-integration.md).
 */
export function buildSetGuardTx(vaultAddress, chainId) {
  const engine = getPolicyEngineAddresses(chainId)
  if (!engine) throw new Error(`The policy engine is not available on chain ${chainId}`)
  return {
    to: getAddress(vaultAddress),
    value: 0n,
    data: encodeFunctionData({ abi: SET_GUARD_ABI, functionName: 'setGuard', args: [engine.guard] }),
  }
}

/**
 * Pre-flight a drafted vault transaction against the vault's live policy (US4/FR-012) using the
 * guard's own read-only evaluation. Returns `{ok:true}` or `{ok:false, violation}`.
 */
export async function previewPolicy(vaultAddress, chainId, { to, value = 0n, data = '0x', operation = 0 }) {
  const engine = getPolicyEngineAddresses(chainId)
  if (!engine) return { ok: true, unsupported: true }
  const [ok, revertData] = await readContract(chainId, {
    address: engine.guard,
    abi: SAFE_POLICY_GUARD_ABI,
    functionName: 'previewTransaction',
    args: [getAddress(vaultAddress), getAddress(to), BigInt(value), data, operation],
  })
  if (ok) return { ok: true }
  return { ok: false, violation: decodePolicyError(revertData) }
}

/**
 * Decode guard revert data into `{rule, message, args}` (FR-011). Shared by pre-flight and
 * failed-execution surfaces so members always see the same explanation.
 * @param {string} revertData raw error bytes from previewTransaction or a failed execution
 * @param {{formatAmount?:(asset:string, amount:bigint)=>string}} [opts]
 */
export function decodePolicyError(revertData, opts = {}) {
  const fmt = opts.formatAmount || ((asset, amount) => `${amount} ${asset === NATIVE_ASSET ? '(native)' : shortAddress(asset)}`)
  let parsed
  try {
    // viem names the field `errorName` where ethers used `name`, and THROWS on data it cannot
    // match instead of returning null — both are handled here so an unrecognised revert still
    // reaches the honest "Blocked by the vault policy" fallback rather than taking the sheet down.
    const { errorName, args } = decodeErrorResult({ abi: GUARD_ABI, data: revertData })
    parsed = { name: errorName, args }
  } catch {
    parsed = null
  }
  if (!parsed) return { rule: 'unknown', message: 'Blocked by the vault policy', args: {} }
  switch (parsed.name) {
    case 'PerTxLimitExceeded': {
      const [asset, amount, limit] = parsed.args
      return {
        rule: 'perTxLimit',
        message: `Exceeds the per-transaction limit: ${fmt(asset, amount)} is over the ${fmt(asset, limit)} cap`,
        args: { asset: getAddress(asset), amount, limit },
      }
    }
    case 'WindowLimitExceeded': {
      const [asset, attempted, remaining] = parsed.args
      return {
        rule: 'windowLimit',
        message: `Exceeds the 24-hour spending window: ${fmt(asset, attempted)} attempted, only ${fmt(asset, remaining)} remaining`,
        args: { asset: getAddress(asset), attempted, remaining },
      }
    }
    case 'RecipientNotAllowed': {
      const [recipient] = parsed.args
      return {
        rule: 'allowlist',
        message: `Recipient ${shortAddress(recipient)} is not on the vault's allowlist`,
        args: { recipient: getAddress(recipient) },
      }
    }
    case 'CooldownActive': {
      const [nextAllowedAtTs] = parsed.args
      return {
        rule: 'cooldown',
        message: `The vault's transaction delay is active — next transaction allowed ${formatTimestamp(Number(nextAllowedAtTs))}`,
        args: { nextAllowedAt: Number(nextAllowedAtTs) },
      }
    }
    case 'DelegatecallBlocked':
      return { rule: 'delegatecall', message: 'Delegate-call transactions are not allowed on a policy-managed vault', args: {} }
    case 'GasRefundBlocked':
      return { rule: 'gasRefund', message: 'Gas-refund transactions are not allowed on a policy-managed vault', args: {} }
    case 'ValueToGuardBlocked':
      return { rule: 'valueToGuard', message: 'The policy engine cannot receive funds', args: {} }
    default:
      return { rule: parsed.name, message: 'Blocked by the vault policy', args: {} }
  }
}

/**
 * Plain-language rule descriptions for the policy views (US2), including the window-semantics
 * disclosure the spec mandates (FR-002).
 * @param {ReturnType<typeof readPolicy>} policy
 * @param {{assetMeta?:Record<string,{symbol:string,decimals:number}>, nativeSymbol?:string}} [opts]
 */
export function describeRules(policy, opts = {}) {
  if (!policy || !policy.hasRules) return []
  const { assetMeta = {}, nativeSymbol = 'ETC' } = opts
  const fmt = (asset, amount) => {
    if (asset === NATIVE_ASSET) return `${formatUnits(amount, 18)} ${nativeSymbol}`
    const meta = assetMeta[asset] || assetMeta[asset?.toLowerCase?.()] || null
    return meta ? `${formatUnits(amount, meta.decimals)} ${meta.symbol}` : `${amount} units of ${shortAddress(asset)}`
  }
  const out = []
  for (const r of policy.assetRules) {
    if (r.perTxLimit > 0n) out.push(`Max ${fmt(r.asset, r.perTxLimit)} per transaction`)
    if (r.windowLimit > 0n) {
      out.push(
        `Max ${fmt(r.asset, r.windowLimit)} per 24-hour window (the window opens with the first spend and resets 24 hours later)`,
      )
    }
  }
  if (policy.allowlistEnabled) {
    out.push(`Recipients limited to ${policy.allowlistCount} approved address${policy.allowlistCount === 1 ? '' : 'es'}`)
  }
  if (policy.cooldown > 0) out.push(`At least ${formatDuration(policy.cooldown)} between outgoing transactions`)
  return out
}

/** One-line summary for vault-list badges (US2 acceptance scenario 1). */
export function summarizeRules(policy) {
  if (!policy || !policy.hasRules) return ''
  const parts = []
  const limited = policy.assetRules.filter((r) => r.perTxLimit > 0n || r.windowLimit > 0n).length
  if (limited > 0) parts.push(`limits on ${limited} asset${limited === 1 ? '' : 's'}`)
  if (policy.allowlistEnabled) parts.push(`${policy.allowlistCount}-address allowlist`)
  if (policy.cooldown > 0) parts.push(`${formatDuration(policy.cooldown)} delay`)
  return parts.join(' · ')
}

export function shortAddress(addr) {
  try {
    const a = getAddress(addr)
    return `${a.slice(0, 6)}…${a.slice(-4)}`
  } catch {
    return String(addr)
  }
}

export function formatDuration(seconds) {
  const s = Number(seconds)
  if (s % (24 * 3600) === 0) {
    const d = s / (24 * 3600)
    return `${d} day${d === 1 ? '' : 's'}`
  }
  if (s % 3600 === 0) {
    const h = s / 3600
    return `${h} hour${h === 1 ? '' : 's'}`
  }
  if (s % 60 === 0) {
    const m = s / 60
    return `${m} minute${m === 1 ? '' : 's'}`
  }
  return `${s} seconds`
}

function formatTimestamp(ts) {
  if (!ts) return 'now'
  try {
    return `at ${new Date(ts * 1000).toLocaleString()}`
  } catch {
    return `at unix time ${ts}`
  }
}
