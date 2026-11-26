/**
 * ticketPlan (spec 114 slice 5) — everything the order ticket and its review say, derived in ONE pure place
 * from a PriceReading and what the member typed, so what is SHOWN is what is SIGNED (FR-017/FR-018).
 *
 * `planOrder` does the depth walk and refuses a reading that is not live. This module wraps it with the
 * three things the SDK adds before it signs:
 *  1. the SDK rounds a market order's input DOWN to 0.01 (cents of USDC for a buy, hundredths of a share for
 *     a sell) — so the amount is normalised FIRST and the plan is built from the normalised amount: the
 *     "You pay at most" figure is then the order's real maker amount, not the typed number;
 *  2. a buy that cannot be filled in full signs only what CAN be (the fillable cost), so the ceiling the
 *     member reads is also the ceiling of the signature — never a larger amount "in case more appears";
 *  3. a resting order signs whole hundredths of a share, at the member's own price.
 *
 * A reading that is not live yields `{ status: 'not-live' }` and nothing else: no average price, no shares,
 * no payout. Pure; no React; BigInt where it counts.
 */
import { planOrder } from './orderPlan'
import { marketOrderSignedAmounts, restingOrderSignedAmounts } from './clobSession'

const MICRO = 1_000_000n
const CENT = 10_000n

function toMicro(value) {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return null
  const [whole, frac = ''] = value.split('.')
  if (frac.length > 6) return null
  return BigInt(whole) * MICRO + BigInt(frac.padEnd(6, '0'))
}
const fromMicro = (micro) => {
  const frac = (micro % MICRO).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${micro / MICRO}.${frac}` : String(micro / MICRO)
}
const floorHundredths = (micro) => micro - (micro % CENT)
/** planOrder spells 93 as "93.0"; the view spells every figure one way ("93"), so equal figures compare equal. */
const canon = (v) => (v == null ? null : (toMicro(v) == null ? null : fromMicro(toMicro(v))))

/**
 * What the member typed → a canonical decimal, or why not. Empty is not an error (nothing typed yet).
 * @returns {{ ok:true, value:string } | { ok:false, empty:true } | { ok:false, reason:'invalid-amount' }}
 */
export function parseTyped(text) {
  const t = String(text ?? '').trim()
  if (t === '') return { ok: false, empty: true }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { ok: false, reason: 'invalid-amount' }
  const normal = t.startsWith('.') ? `0${t}` : t.replace(/\.$/, '')
  const [w, f = ''] = normal.split('.')
  if (f.length > 6) return { ok: false, reason: 'invalid-amount' }
  const whole = w.replace(/^0+(?=\d)/, '')
  const frac = f.replace(/0+$/, '')
  return { ok: true, value: frac ? `${whole}.${frac}` : whole }
}

/** Cents typed by the member ("57", "57.5") → the price as a decimal string ("0.57", "0.575"); null if unusable. */
export function centsToPrice(centsText) {
  const parsed = parseTyped(centsText)
  if (!parsed.ok) return null
  const micro = toMicro(parsed.value)
  if (micro == null || micro <= 0n) return null
  const price = micro / 100n
  if (micro % 100n !== 0n) return null // finer than 0.0001 — no market here has that tick
  return fromMicro(price)
}

/** Whether `price` sits on the market's tick grid (`price` and `tick` decimal strings). */
export function onTickGrid(price, tick) {
  const p = toMicro(price)
  const t = toMicro(tick)
  return p != null && t != null && t > 0n && p > 0n && p < MICRO && p % t === 0n
}

/** buy: a worst price ABOVE the limit is beyond it; sell: BELOW the limit. */
export function beyondLimit(side, worstPrice, limitPrice) {
  const w = toMicro(worstPrice)
  const l = toMicro(limitPrice)
  if (w == null || l == null) return true // unreadable ⇒ not within the limit
  return side === 'buy' ? w > l : w < l
}

function bestFarPrice(reading, side) {
  const level = (side === 'buy' ? reading?.asks : reading?.bids)?.[0]
  return Array.isArray(level) ? level[0] : null
}

/** Smallest order the venue takes here: N shares and about what that is in dollars at the best far price. */
function minimumOrder(reading, side, minOrderSize) {
  const shares = toMicro(minOrderSize ?? reading?.minOrderSize)
  if (shares == null || shares <= 0n) return null
  const best = toMicro(bestFarPrice(reading, side))
  return { shares: fromMicro(shares), usd: best == null ? null : fromMicro((shares * best + MICRO - 1n) / MICRO) }
}

function crosses(reading, side, ownPrice) {
  const best = toMicro(bestFarPrice(reading, side))
  const own = toMicro(ownPrice)
  if (best == null || own == null) return false
  return side === 'buy' ? own >= best : own <= best
}

/**
 * @param {object} args
 * @param {object} args.reading     a PriceReading (the ONLY source of prices)
 * @param {'buy'|'sell'} args.side
 * @param {string} args.typed       what the member typed: USDC to spend (buy) or shares to sell (sell)
 * @param {string} [args.ownPrice]  a price the member named (decimal string) ⇒ a resting order
 * @param {number} [args.toleranceTicks]
 * @param {string} [args.tickSize]  the tick the order is signed on (the reading's, else the listing's)
 * @param {string} [args.minOrderSize]
 * @returns {{status:'empty'}|{status:'invalid',reason:string}|{status:'not-live'}|{status:'refused',reason:string,min?:object}|object}
 *   `status: 'ok'` carries the view documented at the bottom of this function.
 */
export function planForTicket({ reading, side, typed, ownPrice, toleranceTicks = 1, tickSize, minOrderSize } = {}) {
  const parsed = parseTyped(typed)
  if (!parsed.ok) return parsed.empty ? { status: 'empty' } : { status: 'invalid', reason: parsed.reason }

  // The reading's tick is the venue's own, as of its last confirmation; the listing's (passed in) is only the fallback.
  const tick = reading?.tickSize ?? tickSize ?? undefined
  const minSize = reading?.minOrderSize ?? minOrderSize ?? undefined
  const common = { reading, side, toleranceTicks, tickSize: tick, minOrderSize: minSize }

  // `planOrder` refuses anything that is not live FIRST; probing with the member's own number keeps that the
  // one gate, so a non-live reading can never reach the arithmetic below.
  const typedMicro = toMicro(parsed.value)
  const signedMicro = floorHundredths(typedMicro)
  if (!reading || reading.plannable !== true) return { status: 'not-live' }
  if (signedMicro <= 0n) return { status: 'refused', reason: 'rounds-to-zero' }
  const amountSigned = fromMicro(signedMicro)
  const rounded = signedMicro !== typedMicro
  const buy = side === 'buy'

  // ── A price the member named: rests on the book (FR-019) ──
  if (ownPrice != null && ownPrice !== '') {
    const plan = planOrder({ ...common, amount: amountSigned, limitPrice: ownPrice })
    if (!plan.ok) return plan.reason === 'price-not-live' ? { status: 'not-live' } : { status: 'refused', reason: plan.reason, min: minimumOrder(reading, side, minSize) }
    const sharesMicro = floorHundredths(toMicro(plan.shares))
    const min = toMicro(minSize)
    if (sharesMicro <= 0n || (min != null && sharesMicro < min)) return { status: 'refused', reason: 'below-minimum', min: minimumOrder(reading, side, minSize) }
    const signed = restingOrderSignedAmounts({ side: buy ? 'BUY' : 'SELL', shares: fromMicro(sharesMicro), limitPrice: plan.limitPrice, tickSize: tick })
    if (!signed) return { status: 'refused', reason: 'invalid-limit' }
    return {
      status: 'ok',
      kind: 'resting',
      side,
      typed: parsed.value,
      rounded: rounded || (buy && toMicro(plan.shares) !== sharesMicro),
      plan,
      feePlan: { ...plan, cost: signed.usdc },
      limitPrice: plan.limitPrice,
      averagePrice: plan.limitPrice,
      shares: signed.shares,
      payAtMost: buy ? signed.usdc : null,
      proceeds: buy ? null : signed.usdc,
      payoutIfRight: buy ? signed.shares : null,
      depthShare: 0,
      unfilled: '0',
      partial: null,
      crossesBook: crosses(reading, side, plan.limitPrice),
      signed: { kind: 'resting', side: buy ? 'BUY' : 'SELL', size: signed.shares, limitPrice: plan.limitPrice, tickSize: tick, makerAmount: fromMicro(signed.makerUnits), takerAmount: fromMicro(signed.takerUnits) },
    }
  }

  // ── Marketable: fill-and-kill at a limit ──
  let plan = planOrder({ ...common, amount: amountSigned })
  if (!plan.ok) return plan.reason === 'price-not-live' ? { status: 'not-live' } : { status: 'refused', reason: plan.reason, min: minimumOrder(reading, side, minSize) }

  let amountFinal = amountSigned
  let partial = null
  if (toMicro(plan.unfilled) > 0n) {
    // Not all of it has an offer at any price shown. Sign only what can be filled (floored to a cent / hundredth),
    // so the ceiling the member is shown is the ceiling of the signature.
    const fillable = floorHundredths(toMicro(buy ? plan.cost : plan.shares))
    partial = { fillable: fromMicro(fillable), unfilled: canon(plan.unfilled) }
    if (fillable <= 0n) return { status: 'refused', reason: 'below-minimum', min: minimumOrder(reading, side, minSize) }
    amountFinal = fromMicro(fillable)
    const second = planOrder({ ...common, amount: amountFinal })
    if (!second.ok) return { status: 'refused', reason: second.reason, min: minimumOrder(reading, side, minSize) }
    plan = second
  }

  const signed = marketOrderSignedAmounts({ side: buy ? 'BUY' : 'SELL', amount: amountFinal, limitPrice: plan.limitPrice, tickSize: tick })
  // The builder would refuse (or sign something other than the plan) — never show a figure for it.
  if (!signed || signed.maker !== amountFinal) return { status: 'refused', reason: 'invalid-limit' }

  return {
    status: 'ok',
    kind: 'marketable',
    side,
    typed: parsed.value,
    rounded: rounded || amountFinal !== amountSigned,
    plan,
    // Fee lines come from the plan's own notional; the ceiling is what the SIGNATURE can spend.
    feePlan: plan,
    ceilingPlan: buy ? { ...plan, cost: signed.maker } : null,
    limitPrice: plan.limitPrice,
    averagePrice: canon(plan.averagePrice),
    shares: canon(plan.shares),
    payAtMost: buy ? signed.maker : null,
    sellShares: buy ? null : signed.maker,
    proceeds: buy ? null : canon(plan.cost),
    payoutIfRight: canon(plan.payoutIfRight),
    depthShare: plan.depthShare,
    unfilled: canon(plan.unfilled),
    partial,
    crossesBook: false,
    signed: { kind: 'marketable', side: buy ? 'BUY' : 'SELL', amount: amountFinal, limitPrice: plan.limitPrice, tickSize: tick, makerAmount: signed.maker, takerAmount: signed.taker },
  }
}

/**
 * FR-021 — may the REVIEWED order still be signed as reviewed? Re-plans the reviewed signed amount against the
 * CURRENT reading. Returns `{ ok: true }` only when the reviewed limit still reaches everything the order needs;
 * otherwise `{ ok: false, reason, next }` where `next` is a fresh `planForTicket` from what the member typed,
 * to be shown (and reviewed again). The reviewed limit is never replaced by a new one here.
 *
 * @param {object} args  the same inputs as `planForTicket` plus `reviewed` (the view the member signed off on)
 */
export function checkStillSignable({ reviewed, reading, side, typed, ownPrice, toleranceTicks = 1, tickSize, minOrderSize } = {}) {
  const fresh = () => planForTicket({ reading, side, typed, ownPrice, toleranceTicks, tickSize, minOrderSize })
  if (!reading || reading.plannable !== true) return { ok: false, reason: 'not-live', next: { status: 'not-live' } }
  const tick = reading.tickSize ?? tickSize ?? undefined
  if (tick !== reviewed.signed.tickSize) return { ok: false, reason: 'tick-changed', next: fresh() }

  if (reviewed.kind === 'resting') {
    const next = fresh()
    if (next.status !== 'ok' || next.limitPrice !== reviewed.limitPrice || next.signed.size !== reviewed.signed.size) return { ok: false, reason: 'plan-changed', next }
    // Resting at a price that now crosses the book (or no longer does) is a different order: it would take.
    if (next.crossesBook !== reviewed.crossesBook) return { ok: false, reason: 'crossing-changed', next }
    return { ok: true }
  }

  const minSize = reading.minOrderSize ?? minOrderSize ?? undefined
  const plan = planOrder({ reading, side, amount: reviewed.signed.amount, toleranceTicks, tickSize: tick, minOrderSize: minSize })
  if (!plan.ok) return { ok: false, reason: plan.reason === 'price-not-live' ? 'not-live' : 'plan-refused', next: fresh() }
  if (beyondLimit(side, plan.worstPrice, reviewed.limitPrice)) return { ok: false, reason: 'beyond-limit', next: fresh() }
  if (toMicro(plan.unfilled) > 0n) return { ok: false, reason: 'depth-shrank', next: fresh() }
  return { ok: true }
}
