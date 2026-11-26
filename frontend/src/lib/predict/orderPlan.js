/**
 * orderPlan (spec 114, R7) — what an amount buys (or sells) at the CURRENT depth. Pure.
 *
 * Every figure is BigInt arithmetic in micro-units (6 decimals); prices and sizes come in as decimal
 * strings and leave as decimal strings. `depthShare` is the one JS number (a 0–1 ratio built from
 * BigInts). A plan is refused unless the reading is `plannable` (live) — checked FIRST, so a stale
 * price can never be planned from. Fees are NOT computed here (see `computeCost` / builderFee.js).
 *
 * ROUNDING (always against the member, so the figure shown is never kinder than what executes):
 *  - Buy cost per level = ceil(shares × price); shares per level = floor(budget ÷ price).
 *  - Sell proceeds per level = floor(shares × price).
 *  - averagePrice = cost ÷ shares at 6 decimals: ROUNDED UP for a buy, DOWN for a sell.
 *  - limitPrice: buy = worst + tolerance×tick snapped UP to the tick grid (it must still cross the
 *    deepest level touched), clamped to [tick, 0.99]; sell = worst − tolerance×tick snapped DOWN,
 *    floored at one tick.
 * A member-named `limitPrice` must already be on the tick grid and inside (0, 1); it is never snapped.
 *
 * For a SELL: `amount` is shares, `cost` is the USDC proceeds, `unfilled` is shares with no bid, and
 * `payoutIfRight` is null (it describes shares held to resolution, which a sale gives up).
 */
import { parseUnits, formatUnits } from '../evm/units'
import { USDC_DECIMALS } from './builderFee'

const ONE = 10n ** BigInt(USDC_DECIMALS) // 1.000000

const fmt = (micro) => formatUnits(micro, USDC_DECIMALS)

function micro(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return null
  try {
    return parseUnits(value.trim(), USDC_DECIMALS)
  } catch {
    return null
  }
}

const fail = (reason) => ({ ok: false, reason })
const ceilDiv = (a, b) => (a + b - 1n) / b

function levelsOf(levels) {
  if (!Array.isArray(levels)) return []
  const out = []
  for (const l of levels) {
    const p = micro(Array.isArray(l) ? l[0] : undefined)
    const s = micro(Array.isArray(l) ? l[1] : undefined)
    if (p == null || s == null || p <= 0n || s <= 0n) continue // an unreadable level is skipped, never guessed
    out.push([p, s])
  }
  return out
}

function ratio(part, whole) {
  if (whole <= 0n) return 0
  return Number((part * 10_000n) / whole) / 10_000
}

export function planOrder({ reading, side, amount, toleranceTicks = 1, tickSize, minOrderSize, limitPrice } = {}) {
  if (!reading || reading.plannable !== true) return fail('price-not-live')
  if (side !== 'buy' && side !== 'sell') return fail('invalid-amount')

  const amt = micro(amount)
  if (amt == null || amt <= 0n) return fail('invalid-amount')

  const tick = micro(tickSize ?? reading.tickSize)
  if (tick == null || tick <= 0n || tick >= ONE) return fail('invalid-tick')
  if (!Number.isInteger(toleranceTicks) || toleranceTicks < 0) return fail('invalid-tolerance')
  const minSize = minOrderSize ?? reading.minOrderSize
  const min = minSize == null ? null : micro(minSize)
  if (minSize != null && min == null) return fail('invalid-amount')

  const buy = side === 'buy'

  // Resting: the member named the price; nothing is walked.
  if (limitPrice != null) {
    const p = micro(limitPrice)
    if (p == null || p <= 0n || p >= ONE || p % tick !== 0n) return fail('invalid-limit')
    const shares = buy ? (amt * ONE) / p : amt
    if (shares <= 0n || (min != null && shares < min)) return fail('below-minimum')
    const cost = buy ? ceilDiv(shares * p, ONE) : (shares * p) / ONE
    return {
      ok: true,
      kind: 'resting',
      shares: fmt(shares),
      averagePrice: fmt(p),
      worstPrice: fmt(p),
      limitPrice: fmt(p),
      cost: fmt(cost),
      unfilled: fmt(0n),
      depthShare: 0,
      payoutIfRight: buy ? fmt(shares) : null,
    }
  }

  const levels = levelsOf(buy ? reading.asks : reading.bids)
  if (levels.length === 0) return fail('no-depth')
  const visible = levels.reduce((n, [, s]) => n + s, 0n)

  let shares = 0n
  let cost = 0n
  let worst = null
  let remaining = amt // USDC budget (buy) or shares to sell (sell)
  // True only when every visible level was consumed and something was still left over. A buy that
  // stops inside a level leaves a few micro-units of budget that cannot buy one more micro-share;
  // that is rounding dust, not missing depth, and must not be reported as unfilled.
  let depthExhausted = true
  for (const [p, s] of levels) {
    if (remaining <= 0n) break
    if (buy) {
      const affordable = (remaining * ONE) / p
      const take = s < affordable ? s : affordable
      if (take <= 0n) {
        depthExhausted = false
        break
      }
      const spend = ceilDiv(take * p, ONE)
      shares += take
      cost += spend
      remaining -= spend
      worst = p
      if (take < s) {
        depthExhausted = false // budget exhausted inside this level
        break
      }
    } else {
      const take = s < remaining ? s : remaining
      shares += take
      cost += (take * p) / ONE
      remaining -= take
      worst = p
    }
  }

  if (shares <= 0n || (min != null && shares < min)) return fail('below-minimum')

  const averagePrice = buy ? ceilDiv(cost * ONE, shares) : (cost * ONE) / shares
  const offset = BigInt(toleranceTicks) * tick
  let limit
  if (buy) {
    const raw = worst + offset
    const snapped = ceilDiv(raw, tick) * tick
    // The highest price on this market's grid is one tick below 1. A fixed 0.99 would sit BELOW a
    // 0.995 ask on a 0.001-tick market, and an order capped there could never reach the level it
    // was planned against.
    const maxLimit = ONE - tick
    limit = snapped > maxLimit ? maxLimit : snapped
    if (limit < tick) limit = tick
  } else {
    const raw = worst > offset ? worst - offset : 0n
    limit = (raw / tick) * tick
    if (limit < tick) limit = tick
  }

  return {
    ok: true,
    kind: 'marketable',
    shares: fmt(shares),
    averagePrice: fmt(averagePrice),
    worstPrice: fmt(worst),
    limitPrice: fmt(limit),
    cost: fmt(cost),
    unfilled: fmt(depthExhausted && remaining > 0n ? remaining : 0n),
    depthShare: ratio(shares, visible),
    payoutIfRight: buy ? fmt(shares) : null,
  }
}

/**
 * The USDC notional a plan commits, in micro-units (what `computeCost` takes), or null for a refused
 * plan. Fees are added by `computeCost`, never here.
 */
export function planNotional(plan) {
  if (!plan || plan.ok !== true) return null
  return micro(plan.cost)
}
