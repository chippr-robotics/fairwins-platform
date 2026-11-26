/**
 * Whether the gateway answers the spec-114 books route (spec 114, FR-029). The app and the gateway deploy on
 * different trains: a gateway without `/books` makes every reading unknowable, so no ticket could ever become
 * live — and a member must still be able to trade. The market-data seam records the one fact that matters
 * ("the books route answered 404") here, and the order surface reads it to fall back to the fixed-price
 * confirm. Cleared the moment a books answer arrives; a transient failure (5xx, timeout) is NOT recorded,
 * because an outage is not an absent route and must not strand the member on the old form.
 */
let booksMissing = false
const listeners = new Set()

export const booksRouteMissing = () => booksMissing

export function setBooksRouteMissing(value) {
  const next = Boolean(value)
  if (next === booksMissing) return
  booksMissing = next
  for (const l of [...listeners]) {
    try {
      l()
    } catch {
      /* a listener's failure is its own */
    }
  }
}

export function subscribeBooksRoute(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetRouteSupportForTests() {
  booksMissing = false
  listeners.clear()
}
