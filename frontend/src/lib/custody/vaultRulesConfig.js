// Spec 105 — ONE semantic rules config per vault, realized per chain. The member states rules once
// ("$500 of everyday money per day, an hour between sends, big sends need everyone"); each network
// realizes them in its OWN stable token through the spec-068 ordered engine. This is why rules can
// never ride the deployment initializer for a multichain vault: the realized bytes differ per
// chain, and byte-identical initializers are what make the address identical (research D1/D3).
//
// Realization shape (first-match-governs):
//   1. the everyday lane — banded, so an over-cap amount does not match it at all
//   2. the big-send lane — identical asset scope, full owner vote (the engine's one fall-through)
//   3. the catch-all — permissive, or full-vote when "allowed money" is the stable alone
// A chain with no configured stable realizes only cooldown + catch-all and REPORTS the tiles that
// do not apply there — disclosed, never silently skipped (spec edge case).

import { getAddress } from 'viem'
import { parseUnits } from '../evm/units'
import { ANY_ASSET, validateRulesConfig, describeRulesV2 } from './policyV2'
import { starterStableAsset } from './policyTemplates'

export const ALLOWED_MONEY = { STABLE: 'stable', EVERYTHING: 'everything' }
export const BIG_SENDS = { EVERYONE: 'everyone', FOLLOW_ALLOWED: 'follow-allowed' }

export const DEFAULT_SEMANTIC_RULES = {
  dailyCapAmount: '500',
  cooldownSeconds: 3600,
  allowedMoney: ALLOWED_MONEY.STABLE,
  bigSends: BIG_SENDS.EVERYONE,
}

/** Normalize a member-shaped semantic config; throws with a member-facing message when invalid. */
export function sanitizeSemanticRules(input = {}) {
  const raw = { ...DEFAULT_SEMANTIC_RULES, ...(input || {}) }
  const dailyCapAmount = String(raw.dailyCapAmount ?? '').trim()
  const cooldownSeconds = Number(raw.cooldownSeconds ?? 0)
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0) {
    throw new Error('The wait between sends must be a whole number of seconds')
  }
  const allowedMoney = Object.values(ALLOWED_MONEY).includes(raw.allowedMoney)
    ? raw.allowedMoney
    : ALLOWED_MONEY.STABLE
  const bigSends = Object.values(BIG_SENDS).includes(raw.bigSends) ? raw.bigSends : BIG_SENDS.EVERYONE
  return { dailyCapAmount, cooldownSeconds, allowedMoney, bigSends }
}

/** True when the config is the no-rules arrangement (nothing to install anywhere). */
export function isEmptySemanticRules(semantic) {
  const s = sanitizeSemanticRules(semantic)
  return !s.dailyCapAmount && s.cooldownSeconds === 0 && s.allowedMoney === ALLOWED_MONEY.EVERYTHING
}

function fullVote(owners) {
  const clean = owners.map((o) => getAddress(o))
  return { approvers: clean, approvalsRequired: clean.length }
}

/**
 * Realize the semantic config on one chain.
 * @returns {{ rules: Array, cooldown: number, summary: string[], stable: object|null,
 *             inapplicable: string[] }}
 * @throws when the amount cannot be parsed or the realized rules do not validate for these owners
 *         (e.g. more owners than the engine's approver cap) — the caller surfaces the message.
 */
export function realizeRules(chainId, semantic, owners) {
  const s = sanitizeSemanticRules(semantic)
  if (!Array.isArray(owners) || owners.length === 0) throw new Error('Owners are required to realize rules')
  const stable = starterStableAsset(chainId)

  let windowLimit = 0n
  if (stable && s.dailyCapAmount) {
    try {
      windowLimit = parseUnits(s.dailyCapAmount, stable.decimals)
    } catch {
      throw new Error(`Enter the daily ${stable.symbol} cap as a plain number (got "${s.dailyCapAmount}")`)
    }
    if (windowLimit < 0n) throw new Error('The daily cap must be positive')
  }

  const inapplicable = []
  if (!stable && s.dailyCapAmount) inapplicable.push('dailyCap', 'bigSends')

  const rules = []
  const vote = fullVote(owners)
  const baseRule = { perTxLimit: 0n, windowLimit: 0n, approvalsRequired: 0, banded: false, approvers: [], targets: [] }

  if (stable && windowLimit > 0n) {
    // 1 — the everyday lane. banded: perTxLimit is a MATCH bound, so an over-cap send skips this
    // rule entirely instead of violating it (SafePolicyGuardV2 amount banding).
    rules.push({ ...baseRule, asset: stable.address, perTxLimit: windowLimit, windowLimit, banded: true })
    if (s.bigSends === BIG_SENDS.EVERYONE) {
      // 2 — the big-send lane: identical asset scope, every owner signs.
      rules.push({ ...baseRule, asset: stable.address, ...vote })
    }
  }

  // 3 — the catch-all. "Allowed money: stable" means everything else needs a full vote; the
  // permissive form is byte-for-byte today's starter catch-all.
  rules.push(
    s.allowedMoney === ALLOWED_MONEY.STABLE
      ? { ...baseRule, asset: ANY_ASSET, ...vote }
      : { ...baseRule, asset: ANY_ASSET },
  )

  const cooldown = s.cooldownSeconds
  const validated = validateRulesConfig(rules, cooldown, { owners })
  const assetMeta = stable ? { [stable.address]: { symbol: stable.symbol, decimals: stable.decimals } } : {}
  const summary = describeRulesV2(validated, cooldown, { assetMeta }).map((line) =>
    line.number ? `${line.number} — ${line.text}` : line.text,
  )
  return { rules: validated, cooldown, summary, stable, inapplicable }
}

/**
 * Member-facing one-liners for the tile grid + live summary. Chain-independent by design (amounts
 * in "everyday money" terms); per-chain token names appear on the network rows, not here.
 */
export function describeSemanticRules(semantic, ownerCount) {
  const s = sanitizeSemanticRules(semantic)
  const lines = []
  if (s.dailyCapAmount) lines.push(`Up to ${s.dailyCapAmount} of everyday money moves per 24 hours.`)
  if (s.cooldownSeconds > 0) lines.push(`${describeDuration(s.cooldownSeconds)} between sends — no back-to-back moves.`)
  lines.push(
    s.allowedMoney === ALLOWED_MONEY.STABLE
      ? 'Other tokens and contract actions need every owner to sign.'
      : 'Every token moves under the same rules.',
  )
  if (s.dailyCapAmount && s.bigSends === BIG_SENDS.EVERYONE) {
    lines.push(`Sends over the daily cap need all ${ownerCount || 'the'} owners.`)
  }
  return lines
}

export function describeDuration(seconds) {
  const n = Number(seconds) || 0
  if (n === 0) return 'No wait'
  if (n % 86400 === 0) return n === 86400 ? '1 day' : `${n / 86400} days`
  if (n % 3600 === 0) return n === 3600 ? '1 hour' : `${n / 3600} hours`
  if (n % 60 === 0) return `${n / 60} minutes`
  return `${n} seconds`
}

const normAddr = (a) => {
  try {
    return getAddress(String(a))
  } catch {
    return String(a)
  }
}

/**
 * Compare realized rules against what a chain actually holds (readPolicyV2 output shape).
 * Returns { matches, differences } — differences name the field, never a merged value (FR-013).
 */
export function compareRealizedRules(realized, onChain) {
  const differences = []
  const a = realized?.rules || []
  const b = onChain?.rules || []
  if (Number(realized?.cooldown ?? 0) !== Number(onChain?.cooldown ?? 0)) differences.push('cooldown')
  if (a.length !== b.length) {
    differences.push('rule-count')
  } else {
    for (let i = 0; i < a.length; i++) {
      const x = a[i]
      const y = b[i]
      const same =
        normAddr(x.asset) === normAddr(y.asset) &&
        BigInt(x.perTxLimit ?? 0) === BigInt(y.perTxLimit ?? 0) &&
        BigInt(x.windowLimit ?? 0) === BigInt(y.windowLimit ?? 0) &&
        Boolean(x.banded) === Boolean(y.banded) &&
        Number(x.approvalsRequired ?? 0) === Number(y.approvalsRequired ?? 0) &&
        (x.approvers || []).length === (y.approvers || []).length &&
        (x.approvers || []).every((p, j) => normAddr(p) === normAddr((y.approvers || [])[j]))
      if (!same) differences.push(`rule-${i + 1}`)
    }
  }
  return { matches: differences.length === 0, differences }
}
