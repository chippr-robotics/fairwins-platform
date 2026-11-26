/**
 * toleranceChoices (spec 114, T032a) — the price tolerance a member may choose on the amount-first ticket.
 *
 * The limit of a marketable order is the worst level the order touches PLUS a tolerance (see `planOrder`). The
 * default is ONE TICK, the tightest there is. The member may widen it to 1¢ or 2¢ and never further (research R7:
 * a limit that sits far past the book is not a limit). Each choice is converted to `toleranceTicks` from the
 * READING's own tick, and a choice is OFFERED only when it is honest on this market:
 *  - never finer than the tick (a 1¢ choice on a 2¢-tick market would be a half tick);
 *  - a whole number of ticks (1¢ on a 0.3¢ tick has no grid point);
 *  - the limit it produces stays inside (0, 1): for a buy `worst + offset ≤ 1 − tick`, for a sell
 *    `worst − offset ≥ tick`. `planOrder` would clamp a limit that went past those, which would silently give the
 *    member LESS than the tolerance they chose — so such a choice is withheld instead of clamped.
 * The first choice (`id: 'tick'`) is always present and always the tightest. Pure; BigInt micro-units.
 */
const ONE = 1_000_000n
const CENT = 10_000n

function micro(value) {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value.trim())) return null
  const [w, f = ''] = value.trim().split('.')
  if (f.length > 6) return null
  return BigInt(w) * ONE + BigInt(f.padEnd(6, '0'))
}

/** The tolerance ids, tightest first. `tick` is the default and never persists (see OrderTicket). */
export const TOLERANCE_IDS = ['tick', '1c', '2c']
export const DEFAULT_TOLERANCE = 'tick'

/**
 * @param {{ tickSize?: string, side: 'buy'|'sell', basis?: string|null }} args
 *   `basis` — the price the limit is measured from: the worst level the order touches (else the top of the book).
 *   Unknown ⇒ the bound check cannot run and only the tick check applies (the choice is re-checked as soon as a
 *   plan exists, because the component recomputes this on every render).
 * @returns {{ id: string, ticks: number, cents: number|null }[]}  `tick` first; an unusable tick yields only it.
 */
export function toleranceChoices({ tickSize, side, basis = null } = {}) {
  const base = [{ id: 'tick', ticks: 1, cents: null }]
  const tick = micro(tickSize)
  if (tick == null || tick <= 0n || tick >= ONE) return base
  const worst = basis == null ? null : micro(basis)
  const out = [...base]
  for (const [id, cents] of [['1c', 1n], ['2c', 2n]]) {
    const offset = cents * CENT
    if (offset <= tick || offset % tick !== 0n) continue // not wider than one tick, or no whole number of ticks
    if (worst != null) {
      if (side === 'sell' ? worst < offset + tick : worst + offset > ONE - tick) continue
    }
    out.push({ id, ticks: Number(offset / tick), cents: Number(cents) })
  }
  return out
}

/** The ticks for a chosen id among the choices on offer; anything not on offer is the default (one tick). */
export function ticksFor(choices, id) {
  return (choices.find((c) => c.id === id) ?? choices[0]).ticks
}
export function effectiveId(choices, id) {
  return choices.some((c) => c.id === id) ? id : DEFAULT_TOLERANCE
}
