// Release 1.14.0 — starter policy templates for new vaults (spec 068 ordered engine).
//
// Why a template exists at all. Spec 049 shipped the policy step SKIPPABLE, and "skip" is what
// almost everyone picks, which leaves the most common vault shape — one owner, one key, no guard —
// strictly WORSE than a plain account while looking safer. The creation flow now offers a starter
// rule set by default, and refuses the 1-of-1-with-no-policy combination outright.
//
// Two constraints from the V2 engine shape this template, and both are easy to get wrong:
//
//   1. NO MATCHING RULE ⇒ DENIAL. A rule set that names only specific assets silently bricks
//      everything else the vault might ever do. The template therefore always ends with a
//      catch-all `ANY_ASSET` rule, so nothing a member expects to work is refused by accident.
//   2. A WINDOW LIMIT NEEDS A SPECIFIC ASSET (validateRulesConfig): an any-asset 24-hour counter
//      would sum raw base units across assets and mean nothing. The capped rule therefore names
//      the chain's stable token, whose units are the one denomination that means the same thing on
//      every chain — unlike the native coin, where "1" is ~$0.40 on Polygon and ~$3,000 on
//      Ethereum, so no cross-chain default amount could be honest.
//
// The delay is the part that protects a SINGLE-owner vault. Approvals cannot: with one owner the
// guard's approver requirement is exactly the Safe threshold, so it adds nothing. A cooldown does
// something the threshold cannot — it rate-limits a key that has already been stolen, so a drain
// becomes a series of spaced, visible transactions rather than one.
//
// Amounts here are DEFAULTS, not policy: both knobs are member-editable in the wizard and the
// summary shown before signing is rendered from the encoded rules, never from this file's prose.

import { parseUnits } from '../evm/units'
import { NETWORKS } from '../../config/networks'
import { getContractAddressForChain } from '../../config/contracts'
import { ANY_ASSET, describeRulesV2, isPolicyV2Supported, validateRulesConfig } from './policyV2'

/** Stable identifier for the one starter template (a seam, so a second template needs no rewrite). */
export const STARTER_TEMPLATE_ID = 'everyday-limits'

/** Default 24-hour cap on the chain's stable token, in whole stable units. */
export const STARTER_DEFAULT_STABLE_WINDOW = '500'

/** Default minimum spacing between outgoing vault transactions, in seconds. */
export const STARTER_DEFAULT_COOLDOWN_SECONDS = 3600

/** Delay choices offered beside the starter template. */
export const STARTER_COOLDOWN_CHOICES = [
  { value: 0, label: 'No delay' },
  { value: 3600, label: '1 hour' },
  { value: 21600, label: '6 hours' },
  { value: 86400, label: '24 hours' },
]

/**
 * The chain's stable token, or null. Strict NETWORKS lookup on purpose: `getNetwork()` falls back
 * to the default network for an unknown id, which would label this rule with another chain's token
 * — for custody that is exactly the confusion Protect exists to prevent.
 */
export function starterStableAsset(chainId) {
  // `getContractAddressForChain` falls back to the ACTIVE chain when given nothing, which would
  // quietly put another chain's token in a rule; an absent chain is an absent chain.
  if (chainId == null) return null
  const address = getContractAddressForChain('paymentToken', chainId)
  if (!address) return null
  const network = NETWORKS[Number(chainId)]
  return {
    address,
    symbol: network?.stablecoin?.symbol || 'stable token',
    decimals: network?.stablecoin?.decimals ?? 6,
  }
}

/** Whether a starter policy can be attached to a vault created on this chain. */
export function isStarterPolicyAvailable(chainId) {
  // Same fallback hazard as above: without a named chain there is no engine to answer for.
  if (chainId == null) return false
  return isPolicyV2Supported(chainId)
}

/**
 * Build the starter rule set for a chain.
 *
 * @param {object} opts
 * @param {number|string} opts.chainId          deployment chain
 * @param {string} [opts.stableWindowAmount]    24-hour cap in whole stable units ('' / '0' ⇒ no cap)
 * @param {number} [opts.cooldownSeconds]       minimum spacing between outgoing transactions
 * @returns {{rules: Array, cooldown: number, summary: string[], stable: object|null}}
 * @throws when the amount cannot be parsed or the rules do not validate — the caller surfaces the
 *         message and blocks creation, exactly as it does for a hand-composed policy.
 */
export function starterPolicyV2({ chainId, stableWindowAmount = STARTER_DEFAULT_STABLE_WINDOW, cooldownSeconds = STARTER_DEFAULT_COOLDOWN_SECONDS } = {}) {
  if (!isStarterPolicyAvailable(chainId)) {
    throw new Error('The ordered policy engine is not available on this network')
  }
  const stable = starterStableAsset(chainId)
  const raw = String(stableWindowAmount ?? '').trim()

  let windowLimit = 0n
  if (stable && raw) {
    try {
      windowLimit = parseUnits(raw, stable.decimals)
    } catch {
      throw new Error(`Enter the 24-hour ${stable.symbol} limit as a plain number (got "${raw}")`)
    }
    if (windowLimit < 0n) throw new Error('The 24-hour limit must be positive')
  }

  const rules = []
  // Rule 001 — the capped lane. First, so a stable-token movement is governed by the cap rather
  // than by the catch-all below it (first match governs).
  if (stable && windowLimit > 0n) {
    rules.push({
      asset: stable.address,
      perTxLimit: 0n,
      windowLimit,
      approvalsRequired: 0,
      banded: false,
      approvers: [],
      targets: [],
    })
  }
  // Final rule — the catch-all. Without it every asset and every contract call the earlier rules
  // do not name would be DENIED, which is not a default anyone consented to.
  rules.push({
    asset: ANY_ASSET,
    perTxLimit: 0n,
    windowLimit: 0n,
    approvalsRequired: 0,
    banded: false,
    approvers: [],
    targets: [],
  })

  const cooldown = Number(cooldownSeconds ?? 0)
  const validated = validateRulesConfig(rules, cooldown)
  const assetMeta = stable ? { [stable.address]: { symbol: stable.symbol, decimals: stable.decimals } } : {}
  const summary = describeRulesV2(validated, cooldown, { assetMeta }).map((line) =>
    line.number ? `${line.number} — ${line.text}` : line.text,
  )
  return { rules: validated, cooldown, summary, stable }
}

export default starterPolicyV2
