import { useEffect, useRef, useState } from 'react'

import { validateCreateForm, toParams } from './createDaoForm'

/**
 * Spec 030 pillar A — the network-fee disclosure for launching a native standard DAO (issue #1408).
 *
 * WHY THIS EXISTS
 * Creating a DAO is ONE transaction that deploys three contracts — a `TimelockController`, a stock
 * OZ `Governor` and (usually) a fixed-supply `ERC20Votes` — around 6.3M gas, all of it paid by the
 * member who signs. The Launch tab used to disclose the chain, the Silver requirement and the
 * immutability of the result, but never the cost, so the single most expensive action in the app was
 * also the only one that said nothing about what it costs.
 *
 * THE THREE STATES, AND WHY THERE IS NO FOURTH
 * A fee estimate is a READ, and a read has three outcomes, exactly as the estate rules (spec 071)
 * require of every other read in this codebase:
 *
 *   `read`      — gas AND a gas price came back; a cost in the chain's own unit can be stated.
 *   `gas-only`  — the call estimated, but no gas price could be read. The gas is a fact; the cost
 *                 is not, and inventing one from a "typical" price would be a fabricated number.
 *   `unavailable` — the estimate did not come back at all (no endpoint, a revert because the member
 *                 is below the factory's Silver floor, an RPC timeout).
 *
 * `unavailable` NEVER degrades into "no fee" or "free": the fee statement itself is unconditional
 * and does not depend on the read succeeding. Only the NUMBER is conditional. That ordering is the
 * whole design — spec 061's Bitcoin rule ("the confirm UI must say the member pays the network
 * fee") is a statement about the sentence, not about the estimate.
 *
 * WHY THE PACKAGE NEVER SAYS "SPONSORED"
 * `host.wallet` carries `address`, `connectedAddress`, `chainId`, `isConnected`, `submit`,
 * `switchChain` and `requestConnect` — and nothing about which rail `submit` will choose or whether
 * a paymaster will reimburse it (specs 073/050; the omission is deliberate, so an app has nothing to
 * branch on). A package therefore CANNOT confirm sponsorship, so it must not claim it: member-pays
 * is both the honest default and, for this call, the near-certain one — spec 050's paymaster
 * authorises account-native operations, not arbitrary mini-app calldata, and the passkey rail falls
 * back to a self-funded UserOp when sponsorship is unavailable. If the host ever exposes a
 * sponsorship fact, this is the module that should read it; until then the word does not appear.
 */

/** Estimate shapes. `idle` is "not asked yet", which is not a read outcome and states no fee number. */
export const FEE_IDLE = 'idle'
export const FEE_ESTIMATING = 'estimating'
export const FEE_READ = 'read'
export const FEE_GAS_ONLY = 'gas-only'
export const FEE_UNAVAILABLE = 'unavailable'

/**
 * The sentence that is true whatever the read did. Rendered unconditionally, above the button.
 *
 * It names the deployment because the size is the surprising part: a member who has only ever sent
 * a transfer has no reason to expect a five-figure-gas intuition to be off by two orders of
 * magnitude.
 */
export const FEE_STATEMENT =
  'You pay the network fee for this deployment. Launching deploys real contracts — a governor, a ' +
  'timelock treasury and, unless you bring your own, a governance token — in one transaction, so it ' +
  'costs far more gas than an ordinary transfer.'

/** Whatever happens to the estimate, the wallet is the last word — and it is shown before signing. */
const WALLET_CONFIRMS = 'Your wallet shows the final amount before you sign.'

/** `6340000n` → `"6,340,000"`. BigInt formats exactly; Number would silently round a large estimate. */
export function formatGas(gas) {
  try {
    return BigInt(gas).toLocaleString('en-US')
  } catch {
    return null
  }
}

/**
 * Wei → a short decimal string in the chain's own unit, e.g. `"0.0421"`.
 *
 * Four significant digits, because this is an estimate against a gas price that moves between now
 * and the signature; rendering 18 decimals would dress a guess up as a settlement.
 */
export function formatNative(wei, decimals = 18) {
  let value
  try {
    value = BigInt(wei)
  } catch {
    return null
  }
  if (value < 0n) return null
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18
  const scale = 10n ** BigInt(d)
  const whole = value / scale
  const frac = value % scale
  const asNumber = Number(whole) + Number(frac) / Number(scale)
  if (!Number.isFinite(asNumber)) return null
  if (asNumber === 0) return value === 0n ? '0' : '< 0.0001'
  if (asNumber < 0.0001) return '< 0.0001'
  return asNumber.toLocaleString('en-US', { maximumSignificantDigits: 4, useGrouping: true })
}

/**
 * The estimate half of the disclosure, as one sentence.
 *
 * Every branch either states a number that was READ or says plainly that it could not be confirmed.
 * There is no branch that omits the subject, because a fee line that renders nothing while a
 * read is failing is indistinguishable from a surface with no fee.
 */
export function describeFeeEstimate(estimate, { symbol } = {}) {
  const unit = symbol || 'the network token'
  switch (estimate?.state) {
    case FEE_ESTIMATING:
      return 'Estimating the fee…'
    case FEE_READ: {
      const gas = formatGas(estimate.gas)
      const cost = formatNative(estimate.feeWei, estimate.decimals ?? 18)
      if (gas && cost) {
        return `Estimated ${gas} gas — about ${cost} ${unit} at the current gas price. ${WALLET_CONFIRMS}`
      }
      // A `read` we cannot render is not a read. Fall through to the honest sentence rather than
      // printing a half-formatted number.
      return `The fee estimate could not be confirmed here. ${WALLET_CONFIRMS}`
    }
    case FEE_GAS_ONLY: {
      const gas = formatGas(estimate.gas)
      if (!gas) return `The fee estimate could not be confirmed here. ${WALLET_CONFIRMS}`
      return `Estimated ${gas} gas. The gas price could not be read here, so the cost in ${unit} could not be confirmed. ${WALLET_CONFIRMS}`
    }
    case FEE_UNAVAILABLE:
      return `The fee estimate could not be confirmed here. ${WALLET_CONFIRMS}`
    case FEE_IDLE:
    default:
      return `The estimate appears once the form is complete. ${WALLET_CONFIRMS}`
  }
}

/**
 * Debounce for the live estimate. The form re-estimates on the calldata it would actually send, and
 * the calldata changes on every keystroke — without this, typing a DAO name is one `eth_estimateGas`
 * per character against the member's own endpoint (spec 069: it may be a metered one they pay for).
 */
export const ESTIMATE_DEBOUNCE_MS = 400

/**
 * Live fee estimate for the form as it currently stands.
 *
 * Estimates the REAL call — the same calldata `createDAO` will submit — so the number cannot drift
 * from the transaction it describes. An incomplete or invalid form has no such calldata, and the
 * hook stays `idle` rather than estimating a different transaction and calling it this one.
 *
 * @param {object}   args
 * @param {object}   args.form             the live form state
 * @param {Function} args.estimateCreateFee `useStandardDao().estimateCreateFee`
 * @param {boolean}  args.enabled          false while submitting, or with no wallet connected
 * @returns {{state: string, gas?: bigint, feeWei?: bigint, decimals?: number}}
 */
export function useCreateDaoFee({ form, estimateCreateFee, enabled = true, debounceMs = ESTIMATE_DEBOUNCE_MS }) {
  // The ANSWER, tagged with the params it answers about. Tagging is what lets the render derive
  // "estimating" instead of writing it from inside the effect: a `setState` in an effect body is a
  // cascading render, and the state it would set is already computable from what is on screen.
  const [answer, setAnswer] = useState({ key: null, estimate: null })
  const latest = useRef(null)

  // The estimate depends on the PARAMS, not on the form object's identity: a re-render with the
  // same values must not re-issue the read.
  let key = null
  if (enabled && !validateCreateForm(form)) {
    try {
      key = JSON.stringify(toParams(form), (_k, v) => (typeof v === 'bigint' ? `${v}` : v))
    } catch {
      key = null // `toParams` can throw on a field validation does not cover (proposalThreshold)
    }
  }
  useEffect(() => {
    // Written in the effect, never during render: this is the "which params are current" marker a
    // late RPC reply is checked against, and it must move only when the committed render did.
    latest.current = key
    if (!key) return undefined
    const timer = setTimeout(() => {
      Promise.resolve()
        // Re-read from the key rather than closing over `form`: the estimate is then provably of
        // the same params the dependency compared, so a render between schedule and fire cannot
        // slip different values into the call the number describes. (The bigints came back as
        // decimal strings, which is what ethers' encoder takes for a uint anyway.)
        .then(() => estimateCreateFee(JSON.parse(key)))
        .then((next) => {
          // A stale answer must never overwrite a newer one: the member keeps typing while an
          // estimate is in flight, and RPC replies do not arrive in the order they were sent.
          if (latest.current === key) setAnswer({ key, estimate: next ?? { state: FEE_UNAVAILABLE } })
        })
        .catch(() => {
          if (latest.current === key) setAnswer({ key, estimate: { state: FEE_UNAVAILABLE } })
        })
    }, debounceMs)
    return () => clearTimeout(timer)
  }, [key, estimateCreateFee, debounceMs])

  if (!key) return { state: FEE_IDLE }
  // An answer about DIFFERENT params is not an answer about these ones. Showing the old number
  // against a changed form would be the one failure mode worse than showing none.
  return answer.key === key ? answer.estimate : { state: FEE_ESTIMATING }
}
