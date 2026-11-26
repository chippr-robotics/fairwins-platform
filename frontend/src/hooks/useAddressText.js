/**
 * A text field whose value is ALSO kept in the address (a query parameter), without the address
 * ever overwriting what the member is typing.
 *
 * The naive version is one effect: "when the address value changes, copy it into the field". It
 * is needed, because Back/Forward and shared links change the address from outside. It is also a
 * race: every keystroke writes the address, the router delivers that write back a moment later,
 * and by then the member has typed more. The effect then copies the OLDER address value over the
 * NEWER field value. On a fast machine the echo lands before the next key and nothing shows; on
 * a slow one "harbour" became something else, the search matched nothing, and the list emptied
 * (spec 114 — first seen as a Cypress failure on a loaded CI runner, never locally).
 *
 * The rule here: a value this field wrote to the address moments ago is an ECHO and is ignored;
 * any other address value came from outside and is followed. "Moments ago" is a time window
 * rather than a queue, because a router may deliver every intermediate write, only the last, or
 * the same value twice, and a queue is wrong for at least one of those.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export const ECHO_WINDOW_MS = 2000

const monotonic = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now())

/**
 * @param {string} addressValue the parameter's current value in the address
 * @param {{ echoWindowMs?: number, now?: () => number }} [opts]
 * @returns {[string, (value: string, written?: string) => void]}
 *   `[text, write]` — `write(value, written)` records a change this field is making, by keystroke
 *   or from code such as a Clear button (`written` is what is being put in the address, when it
 *   differs from the field's text, e.g. whitespace written as empty). A Clear is a write like any
 *   other, so an older echo arriving after it cannot refill the field.
 */
export function useAddressText(addressValue, { echoWindowMs = ECHO_WINDOW_MS, now = monotonic } = {}) {
  const [text, setText] = useState(addressValue)
  const written = useRef([]) // [{ value, at }] — what this field put in the address, recently

  useEffect(() => {
    const t = now()
    written.current = written.current.filter((w) => t - w.at < echoWindowMs)
    // Our own write coming back. The field is at least as new as this; leave it alone.
    if (written.current.some((w) => w.value === addressValue)) return
    // Back/forward, a link, or another control changed the address: follow it.
    setText((prev) => (prev === addressValue ? prev : addressValue))
    // `now` and the window are configuration, not triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressValue])

  const write = useCallback(
    (value, writtenValue = value) => {
      written.current.push({ value: writtenValue, at: now() })
      setText(value)
    },
    [now],
  )

  return [text, write]
}

export default useAddressText
