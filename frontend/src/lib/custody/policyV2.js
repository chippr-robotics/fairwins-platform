// Spec 068 — ordered policy engine client library. Reads/encodes SafePolicyGuardV2 state, builds
// threshold-approved change transactions (including the two-step adopt/upgrade), mirrors on-chain
// matching for previews, and decodes the guard's typed errors into rule-numbered plain language
// (FR-012/SC-003). See specs/068-protect-multi-chain-policies/contracts/frontend-integration.md.
//
// v1 (`policy.js`) is untouched and keeps serving vaults that have not adopted V2; `getPolicyStatus`
// here is the single router that tells the UI which engine a vault is on.

import { decodeErrorResult, decodeFunctionData, encodeFunctionData, zeroAddress } from 'viem'
import { SAFE_POLICY_GUARD_V2_ABI } from '../../abis/SafePolicyGuardV2'
import { POLICY_GUARD_SETUP_ABI } from '../../abis/SafePolicyGuard'
import { getContractAddressForChain } from '../../config/contracts'
import { normalizeAbi, readContract } from '../chains/readContract'
import { getAddress, isAddress } from '../evm/address'
import { GUARD_STORAGE_SLOT, NATIVE_ASSET, readVaultGuard } from './policy'

export { GUARD_STORAGE_SLOT, NATIVE_ASSET }

/** Asset sentinel meaning "any asset" (matches SafePolicyGuardV2.ANY_ASSET). */
export const ANY_ASSET = '0x0000000000000000000000000000000000000001'

/** Bounds mirrored from the contract so the composer can validate before proposing. */
export const MAX_RULES = 16
export const MAX_APPROVERS = 8
export const MAX_TARGETS = 16
export const MAX_COOLDOWN = 365 * 24 * 60 * 60

/** Parsed ABIs, exported in place of the ethers `Interface`s this module used to hand out. */
export const GUARD_V2_ABI = normalizeAbi(SAFE_POLICY_GUARD_V2_ABI)
export const SETUP_ABI = normalizeAbi(POLICY_GUARD_SETUP_ABI)

const SET_GUARD_ABI = normalizeAbi(['function setGuard(address guard)'])

/**
 * Decode calldata and assert it is the function named.
 *
 * ethers' `decodeFunctionData(name, data)` threw when the selector belonged to another function;
 * viem's derives the name FROM the selector, so without this the classifier below would decode
 * some other guard call and hand its arguments to the rule mapper.
 */
function decodeAs(abi, functionName, data) {
  const decoded = decodeFunctionData({ abi, data })
  if (decoded.functionName !== functionName) throw new Error(`expected ${functionName} calldata`)
  return decoded.args
}

/** V2 engine addresses for a chain; null when the ordered engine is not deployed there. */
export function getPolicyEngineV2Addresses(chainId) {
  const guard = getContractAddressForChain('safePolicyGuardV2', chainId)
  const setup = getContractAddressForChain('policyGuardSetup', chainId)
  if (!guard || !setup) return null
  return { guard: getAddress(guard), setup: getAddress(setup) }
}

/** Whether the ordered policy engine is available on a chain. */
export function isPolicyV2Supported(chainId) {
  return getPolicyEngineV2Addresses(chainId) !== null
}

/**
 * Which engine (if any) governs a vault:
 *   'unsupported'  — no policy engine deployed on this chain
 *   'none'         — no guard set on the vault
 *   'managed'      — spec 049 v1 guard (legacy; read-only + upgrade path)
 *   'managed-v2'   — spec 068 ordered engine
 *   'foreign'      — some other guard entirely
 */
export async function getPolicyStatus(vaultAddress, chainId) {
  const v2 = getPolicyEngineV2Addresses(chainId)
  const v1Guard = getContractAddressForChain('safePolicyGuard', chainId)
  if (!v2 && !v1Guard) return 'unsupported'
  const guardSet = await readVaultGuard(vaultAddress, chainId).catch(() => zeroAddress)
  if (guardSet === zeroAddress) return 'none'
  if (v2 && guardSet === v2.guard) return 'managed-v2'
  if (v1Guard && guardSet === getAddress(v1Guard)) return 'managed'
  return 'foreign'
}

/** Normalize one on-chain rule tuple into a plain object the UI can hold. */
function toRule(raw, index) {
  return {
    index,
    asset: getAddress(raw.asset),
    perTxLimit: raw.perTxLimit,
    windowLimit: raw.windowLimit,
    approvalsRequired: Number(raw.approvalsRequired),
    banded: Boolean(raw.banded),
    approvers: [...raw.approvers].map((a) => getAddress(a)),
    targets: [...raw.targets].map((t) => getAddress(t)),
  }
}

/** Read a vault's full ordered policy: rules in enforcement order + live window accounting. */
export async function readPolicyV2(vaultAddress, chainId) {
  const engine = getPolicyEngineV2Addresses(chainId)
  if (!engine) return null
  // Chain NAMED (spec 110). `getRules`/`getMeta`/`getRuleAccounting` are multi-output, which viem
  // returns as bare arrays; `readContract` re-attaches the parameter names, so both the
  // destructuring and the field reads below work unchanged. The uint32s (`cooldown`,
  // `rulesVersion`) come back as NUMBERS rather than bigints and already go through `Number(...)`.
  const guardRead = (functionName, args) =>
    readContract(chainId, { address: engine.guard, abi: SAFE_POLICY_GUARD_V2_ABI, functionName, args })
  const safe = getAddress(vaultAddress)

  const [[rawRules, cooldown], meta, nextAllowed] = await Promise.all([
    guardRead('getRules', [safe]),
    guardRead('getMeta', [safe]),
    guardRead('nextAllowedAt', [safe]),
  ])
  const rules = [...rawRules].map(toRule)
  const accounting = await Promise.all(
    rules.map(async (rule) => {
      const acc = await guardRead('getRuleAccounting', [safe, BigInt(rule.index)])
      return { spentInWindow: acc.spentInWindow, windowStart: acc.windowStart, remaining: acc.remaining }
    }),
  )
  return {
    rules,
    cooldown: Number(cooldown),
    accounting,
    rulesVersion: Number(meta.rulesVersion),
    lastCountedTxAt: meta.lastCountedTxAt,
    nextAllowedAt: nextAllowed,
  }
}

// ---------------------------------------------------------------- validation

/** Display number for a rule position: 1 -> "001". */
export function ruleNumber(index) {
  return String(index + 1).padStart(3, '0')
}

function assertAddressList(list, label, max, seenLabel) {
  if (list.length > max) throw new Error(`${label}: at most ${max} allowed`)
  const seen = new Set()
  for (const entry of list) {
    if (!isAddress(entry)) throw new Error(`${label}: "${entry}" is not a valid address`)
    const key = getAddress(entry)
    if (seen.has(key)) throw new Error(`${label}: ${seenLabel} listed twice`)
    seen.add(key)
  }
}

/**
 * Validate a composed rule set before it is proposed. Throws member-language errors.
 * `owners` (when supplied) enforces FR-010 at composition time: a rule may only name current owners.
 */
export function validateRulesConfig(rules, cooldown, { owners } = {}) {
  if (!Array.isArray(rules)) throw new Error('Rules must be a list')
  if (rules.length > MAX_RULES) throw new Error(`A policy can hold at most ${MAX_RULES} rules`)
  if (!Number.isInteger(cooldown) || cooldown < 0) throw new Error('Cooldown must be a whole number of seconds')
  if (cooldown > MAX_COOLDOWN) throw new Error('Cooldown cannot exceed 365 days')

  const ownerSet = owners ? new Set(owners.map((o) => getAddress(o))) : null

  return rules.map((rule, index) => {
    const label = `Rule ${ruleNumber(index)}`
    const asset = rule.asset ? getAddress(rule.asset) : ANY_ASSET
    const perTxLimit = BigInt(rule.perTxLimit ?? 0n)
    const windowLimit = BigInt(rule.windowLimit ?? 0n)
    const approvers = (rule.approvers || []).map((a) => (isAddress(a) ? getAddress(a) : a))
    const targets = (rule.targets || []).map((t) => (isAddress(t) ? getAddress(t) : t))
    const banded = Boolean(rule.banded)

    assertAddressList(approvers, label, MAX_APPROVERS, 'the same approver is')
    assertAddressList(targets, label, MAX_TARGETS, 'the same destination is')

    if (banded && perTxLimit === 0n) {
      throw new Error(`${label}: a tier needs an amount limit to band on`)
    }
    let approvalsRequired = Number(rule.approvalsRequired ?? 0)
    if (approvers.length === 0) {
      if (approvalsRequired !== 0) throw new Error(`${label}: name the approvers this rule requires`)
    } else {
      if (approvalsRequired === 0) approvalsRequired = approvers.length
      if (approvalsRequired > approvers.length) {
        throw new Error(`${label}: cannot require more approvals than the approvers listed`)
      }
      if (ownerSet) {
        for (const approver of approvers) {
          if (!ownerSet.has(approver)) {
            throw new Error(`${label}: ${approver} is not an owner of this vault`)
          }
        }
      }
    }
    if (windowLimit > 0n && asset === ANY_ASSET) {
      // Honest limitation: an any-asset window counter sums raw amounts across assets, so the
      // number would be meaningless. Keep it out of composed policies.
      throw new Error(`${label}: a daily limit needs a specific asset (native or a token)`)
    }
    return { asset, perTxLimit, windowLimit, approvalsRequired, banded, approvers, targets }
  })
}

/** Rules referencing an address that is no longer an owner (FR-010 read-view flag). */
export function findBrokenRules(rules, owners) {
  if (!Array.isArray(rules) || !Array.isArray(owners)) return []
  const ownerSet = new Set(owners.map((o) => getAddress(o)))
  return rules
    .map((rule, index) => {
      const missing = (rule.approvers || []).filter((a) => !ownerSet.has(getAddress(a)))
      return missing.length > 0 ? { index, missing } : null
    })
    .filter(Boolean)
}

/** Do two rules have strictly identical scope (asset, band, destinations)? */
export function scopeEquals(a, b) {
  if (!a || !b) return false
  if (getAddress(a.asset) !== getAddress(b.asset)) return false
  if (Boolean(a.banded) !== Boolean(b.banded)) return false
  if (a.banded && BigInt(a.perTxLimit) !== BigInt(b.perTxLimit)) return false
  const at = a.targets || []
  const bt = b.targets || []
  if (at.length !== bt.length) return false
  return at.every((t, i) => getAddress(t) === getAddress(bt[i]))
}

/**
 * Rules that can never apply because an earlier rule covers everything they cover (FR-015).
 * A rule is shadowed when an earlier rule has identical scope AND a requirement no stricter than
 * its own — the same-scope alternative means an earlier rule with MORE approvers does not shadow
 * a later, easier one.
 */
export function analyzeShadowing(rules) {
  const out = []
  for (let i = 0; i < rules.length; i++) {
    for (let j = 0; j < i; j++) {
      if (!scopeEquals(rules[j], rules[i])) continue
      const earlierNeeds = Number(rules[j].approvalsRequired ?? 0)
      const laterNeeds = Number(rules[i].approvalsRequired ?? 0)
      // The earlier rule swallows the later one only when it is no harder to satisfy.
      if (earlierNeeds === 0 || (laterNeeds !== 0 && earlierNeeds <= laterNeeds)) {
        out.push({ index: i, shadowedBy: j })
        break
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- matching preview

const SELECTORS = {
  transfer: '0xa9059cbb',
  transferFrom: '0x23b872dd',
  approve: '0x095ea7b3',
}

/** Client twin of the guard's calldata classification (native `value` is scoped by the caller). */
export function classifyPayload({ to, data = '0x' }) {
  const hex = (data || '0x').toLowerCase()
  const selector = hex.slice(0, 10)
  const word = (n) => '0x' + hex.slice(10 + n * 64, 10 + (n + 1) * 64)
  const addrAt = (n) => getAddress('0x' + hex.slice(10 + n * 64 + 24, 10 + (n + 1) * 64))
  if (selector === SELECTORS.transfer && hex.length >= 10 + 128) {
    return { isTokenAction: true, tokenAsset: getAddress(to), tokenRecipient: addrAt(0), tokenAmount: BigInt(word(1)) }
  }
  if (selector === SELECTORS.approve && hex.length >= 10 + 128) {
    return { isTokenAction: true, tokenAsset: getAddress(to), tokenRecipient: addrAt(0), tokenAmount: BigInt(word(1)) }
  }
  if (selector === SELECTORS.transferFrom && hex.length >= 10 + 192) {
    return { isTokenAction: true, tokenAsset: getAddress(to), tokenRecipient: addrAt(1), tokenAmount: BigInt(word(2)) }
  }
  return { isTokenAction: false, tokenAsset: null, tokenRecipient: null, tokenAmount: 0n }
}

function scopeMatches(rule, ctx) {
  const asset = getAddress(rule.asset)
  if (asset !== ANY_ASSET) {
    const mixed = ctx.value > 0n && ctx.isTokenAction
    if (mixed) return false
    if (asset === NATIVE_ASSET) {
      if (!(ctx.value > 0n && !ctx.isTokenAction)) return false
    } else if (!(ctx.isTokenAction && ctx.tokenAsset === asset && ctx.value === 0n)) {
      return false
    }
  }
  if (rule.banded) {
    const bound = BigInt(rule.perTxLimit)
    if (ctx.value > bound) return false
    if (ctx.isTokenAction && ctx.tokenAmount > bound) return false
  }
  const targets = (rule.targets || []).map((t) => getAddress(t))
  if (targets.length > 0) {
    if (ctx.isTokenAction && !targets.includes(ctx.tokenRecipient)) return false
    if ((!ctx.isTokenAction || ctx.value > 0n) && !targets.includes(getAddress(ctx.to))) return false
  }
  return true
}

/**
 * Which rule would govern a payload, mirroring on-chain first-match-governs including the
 * same-scope alternative. `approvedBy` (optional) lets the preview evaluate approver requirements;
 * without it, approver checks are reported as unknown rather than guessed.
 */
export function matchPreview(rules, payload, { approvedBy } = {}) {
  const cls = classifyPayload(payload)
  const ctx = { ...cls, to: payload.to, value: BigInt(payload.value ?? 0n) }
  const approvals = approvedBy ? new Set(approvedBy.map((a) => getAddress(a))) : null

  let firstFailure = null
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!scopeMatches(rule, ctx)) continue
    if (firstFailure && !scopeEquals(rules[firstFailure.index], rule)) break

    const need = Number(rule.approvalsRequired ?? 0)
    if (need > 0 && approvals) {
      const have = (rule.approvers || []).filter((a) => approvals.has(getAddress(a))).length
      if (have < need) {
        firstFailure = firstFailure || { index: i, have, need }
        continue
      }
    }
    return { matched: true, ruleIndex: i, approverGap: need > 0 && !approvals ? { need } : null }
  }
  if (firstFailure) return { matched: true, ruleIndex: firstFailure.index, approverFailure: firstFailure }
  return { matched: false, ruleIndex: null }
}

// ---------------------------------------------------------------- encoding

/** Encode `setRules` calldata from a validated config. */
export function encodeSetRules(rules, cooldown) {
  const tuples = rules.map((r) => [
    r.asset,
    r.perTxLimit,
    r.windowLimit,
    r.approvalsRequired,
    r.banded,
    r.approvers,
    r.targets,
  ])
  return encodeFunctionData({ abi: GUARD_V2_ABI, functionName: 'setRules', args: [tuples, cooldown] })
}

/** The threshold-approved self-transaction that changes a vault's ordered policy. */
export function buildRulesChangeTx(chainId, rules, cooldown) {
  const engine = getPolicyEngineV2Addresses(chainId)
  if (!engine) throw new Error('The ordered policy engine is not available on this network')
  return { to: engine.guard, value: 0n, data: encodeSetRules(rules, cooldown) }
}

/** The vault self-transaction that activates (or detaches) the V2 guard. */
export function buildSetGuardV2Tx(vaultAddress, chainId, { detach = false } = {}) {
  const engine = getPolicyEngineV2Addresses(chainId)
  if (!engine && !detach) throw new Error('The ordered policy engine is not available on this network')
  return {
    to: getAddress(vaultAddress),
    value: 0n,
    data: encodeFunctionData({ abi: SET_GUARD_ABI, functionName: 'setGuard', args: [detach ? zeroAddress : engine.guard] }),
  }
}

/**
 * The two-step adopt/upgrade flow (FR-017/FR-020): configure the rules FIRST (inert until the guard
 * is active for this vault), then point the vault's guard slot at V2. Proposed as consecutive
 * nonces so ordering is enforced on-chain. Batching is impossible on a policy vault — MultiSend is
 * a delegatecall, which the guard denies.
 */
export function buildAdoptV2Txs(vaultAddress, chainId, rules, cooldown) {
  return [buildRulesChangeTx(chainId, rules, cooldown), buildSetGuardV2Tx(vaultAddress, chainId)]
}

/** Setup payload attaching the V2 guard + initial rules at vault creation. */
export function buildEnablePolicyV2Setup(chainId, rules, cooldown) {
  const engine = getPolicyEngineV2Addresses(chainId)
  if (!engine) return undefined
  return {
    setupTo: engine.setup,
    setupData: encodeFunctionData({ abi: SETUP_ABI, functionName: 'enablePolicy', args: [engine.guard, encodeSetRules(rules, cooldown)] }),
  }
}

// ---------------------------------------------------------------- reads / decoding

/**
 * Pre-flight a payload against the live guard (scope + limits; approvals when a hash is known).
 *
 * `payload.operation` defaults to 0 (a plain CALL), which is what every compose-time preview
 * wants. Issue #1368 passes 1 to ask the guard directly whether it would deny a MultiSend
 * delegatecall from this vault — `_preCheck` answers that before any rule evaluation runs.
 */
export async function previewPolicyV2(vaultAddress, chainId, payload, { executor, approvedTxHash } = {}) {
  const engine = getPolicyEngineV2Addresses(chainId)
  if (!engine) return { ok: true, reason: null }
  const res = await readContract(chainId, {
    address: engine.guard,
    abi: SAFE_POLICY_GUARD_V2_ABI,
    functionName: 'previewTransaction',
    args: [
      getAddress(vaultAddress),
      getAddress(payload.to),
      payload.value ?? 0n,
      payload.data || '0x',
      payload.operation ?? 0,
      executor ? getAddress(executor) : zeroAddress,
      approvedTxHash || '0x' + '0'.repeat(64),
    ],
  })
  if (res.ok) return { ok: true, reason: null }
  return { ok: false, reason: decodePolicyErrorV2(res.revertData) }
}

/**
 * Decode guard revert data into a member-facing message naming the display rule number.
 * Returns null for anything that is not a guard error, so callers can fall back honestly.
 */
export function decodePolicyErrorV2(revertData) {
  if (!revertData || revertData === '0x') return null
  let parsed
  try {
    // viem names the field `errorName` where ethers used `name`, and throws on data it cannot
    // match rather than returning null — both land on the honest null below.
    const { errorName, args } = decodeErrorResult({ abi: GUARD_V2_ABI, data: revertData })
    parsed = { name: errorName, args }
  } catch {
    return null
  }
  if (!parsed) return null
  const n = (i) => ruleNumber(Number(parsed.args[i]))
  switch (parsed.name) {
    case 'NoRuleMatches':
      return { rule: null, code: 'no-rule', message: 'No rule in this policy allows this transaction.' }
    case 'RuleApproversMissing':
      return {
        rule: Number(parsed.args[0]),
        code: 'approvers',
        message: `Rule ${n(0)} needs ${parsed.args[2]} of its named approvers — ${parsed.args[1]} so far.`,
      }
    case 'RulePerTxExceeded':
      return {
        rule: Number(parsed.args[0]),
        code: 'per-tx',
        message: `Rule ${n(0)} caps a single transaction below this amount.`,
      }
    case 'RuleWindowExceeded':
      return {
        rule: Number(parsed.args[0]),
        code: 'window',
        message: `Rule ${n(0)}'s 24-hour limit has too little left for this amount.`,
      }
    case 'CooldownActive':
      return { rule: null, code: 'cooldown', message: 'This vault is still in its cooldown between transactions.' }
    case 'DelegatecallBlocked':
      return { rule: null, code: 'delegatecall', message: 'Policy-managed vaults cannot run delegatecall batches.' }
    case 'GasRefundBlocked':
      return { rule: null, code: 'gas-refund', message: 'Policy-managed vaults cannot pay gas refunds from vault funds.' }
    case 'ValueToGuardBlocked':
      return { rule: null, code: 'value-to-guard', message: 'Funds cannot be sent to the policy engine itself.' }
    default:
      return { rule: null, code: parsed.name, message: parsed.name }
  }
}

/** Decode a queued proposal targeting the V2 engine (queue rendering, FR-019). */
export function classifyPolicyProposalV2(proposal, chainId, vaultAddress) {
  const engine = getPolicyEngineV2Addresses(chainId)
  if (!engine || !proposal?.to) return null
  const to = getAddress(proposal.to)
  if (to === engine.guard) {
    try {
      const decoded = decodeAs(GUARD_V2_ABI, 'setRules', proposal.data)
      // viem decodes a NAMED tuple into an object, not an array — the positional remap this used
      // to do (`raw[0]`…`raw[6]`) would hand `toRule` seven undefineds and build a rule list of
      // nulls with no error anywhere. The decoded rule already has the field names `toRule` reads.
      const rules = decoded[0].map((raw, index) => toRule(raw, index))
      return { kind: 'set-rules', rules, cooldown: Number(decoded[1]) }
    } catch {
      return null
    }
  }
  if (vaultAddress && to === getAddress(vaultAddress)) {
    try {
      const [guard] = decodeAs(SET_GUARD_ABI, 'setGuard', proposal.data)
      if (getAddress(guard) === engine.guard) return { kind: 'adopt-v2' }
      if (getAddress(guard) === zeroAddress) return { kind: 'remove-guard' }
      return { kind: 'set-guard', guard: getAddress(guard) }
    } catch {
      return null
    }
  }
  return null
}

// ---------------------------------------------------------------- description

function shortAddress(addr) {
  const a = getAddress(addr)
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

/** Name approvers using whatever the caller knows (address book / callsign), else a short address. */
function nameOf(addr, names) {
  const key = getAddress(addr)
  return (names && names[key]) || shortAddress(key)
}

/**
 * Plain-language lines for an ordered policy — one per rule, in enforcement order.
 * `assetMeta` maps asset address -> { symbol, decimals } for amount formatting.
 */
export function describeRulesV2(rules, cooldown, { assetMeta = {}, names = {} } = {}) {
  const amount = (value, asset) => {
    const meta = assetMeta[getAddress(asset)] || {}
    const decimals = meta.decimals ?? 18
    const symbol = meta.symbol ? ` ${meta.symbol}` : ''
    const whole = BigInt(value) / 10n ** BigInt(decimals)
    const frac = BigInt(value) % 10n ** BigInt(decimals)
    const shown = frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`
    return `${shown}${symbol}`
  }

  const lines = rules.map((rule, index) => {
    const parts = []
    const asset = getAddress(rule.asset)
    const scope =
      asset === ANY_ASSET ? 'any asset' : asset === NATIVE_ASSET ? 'the network coin' : `token ${shortAddress(asset)}`

    if (rule.approvers?.length) {
      const need = Number(rule.approvalsRequired ?? rule.approvers.length)
      const who = rule.approvers.map((a) => nameOf(a, names))
      parts.push(
        need === rule.approvers.length
          ? `${who.join(' and ')} must all approve`
          : `any ${need} of ${who.join(', ')} must approve`,
      )
    } else {
      parts.push('the vault’s usual approvals are enough')
    }

    if (rule.banded) parts.push(`for ${scope} up to ${amount(rule.perTxLimit, asset)} per transaction`)
    else if (BigInt(rule.perTxLimit) > 0n) parts.push(`for ${scope}, at most ${amount(rule.perTxLimit, asset)} per transaction`)
    else parts.push(`for ${scope}`)

    if (BigInt(rule.windowLimit ?? 0n) > 0n) parts.push(`and at most ${amount(rule.windowLimit, asset)} per 24 hours`)
    if (rule.targets?.length) {
      parts.push(`only to ${rule.targets.map((t) => nameOf(t, names)).join(', ')}`)
    }
    return { index, number: ruleNumber(index), text: parts.join(', ') }
  })

  if (cooldown > 0) {
    const hours = Math.round(cooldown / 3600)
    lines.push({
      index: null,
      number: null,
      text: `At least ${hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${cooldown} seconds`} must pass between fund movements.`,
    })
  }
  return lines
}

/**
 * Pre-populate a V2 composer from a decoded v1 policy so upgrading is lossless and reviewable
 * (FR-020): each v1 asset limit becomes a rule, the v1 allowlist becomes that rule's destinations,
 * and the v1 cooldown carries over unchanged.
 */
export function fromV1Policy(v1Policy) {
  if (!v1Policy) return { rules: [], cooldown: 0 }
  const targets = v1Policy.allowlistEnabled ? (v1Policy.allowlist || []).map((a) => getAddress(a)) : []
  const rules = (v1Policy.assetRules || []).map((rule) => ({
    asset: getAddress(rule.asset),
    perTxLimit: BigInt(rule.perTxLimit ?? 0n),
    windowLimit: BigInt(rule.windowLimit ?? 0n),
    approvalsRequired: 0,
    banded: false,
    approvers: [],
    targets,
  }))
  // A v1 policy with only an allowlist/cooldown still needs one rule, or V2 would deny everything.
  if (rules.length === 0) {
    rules.push({
      asset: ANY_ASSET,
      perTxLimit: 0n,
      windowLimit: 0n,
      approvalsRequired: 0,
      banded: false,
      approvers: [],
      targets,
    })
  }
  return { rules, cooldown: Number(v1Policy.cooldown ?? 0) }
}
