/**
 * useVisiblePolling (spec 114 slice 6) — run `task` on a schedule that costs nothing when nobody is looking.
 *
 *  - It runs only while the tab is VISIBLE and `enabled`; hiding the tab clears the timer, showing it runs the
 *    task at once and restarts the schedule (a hidden tab does not hold a request budget).
 *  - It BACKS OFF: each run whose task returned anything other than `true` ("something changed") lengthens the
 *    next wait by `factor`, up to `maxMs`; a change resets it to `baseMs`.
 *  - A task that throws is a quiet run, not a crash; runs never overlap.
 *  - `immediate: false` waits one `baseMs` before the first run (for callers that already load on mount).
 *  - `resetKey` restarts the schedule from `baseMs` when it changes (a different account, a different chain).
 */
import { useEffect, useRef } from 'react'

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

export function useVisiblePolling(task, { enabled = true, baseMs, maxMs = baseMs, factor = 1.5, immediate = true, resetKey = null } = {}) {
  const taskRef = useRef(task)
  useEffect(() => {
    taskRef.current = task
  })

  useEffect(() => {
    if (!enabled) return undefined
    let timer = null
    let cancelled = false
    let running = false
    let quiet = 0

    const clear = () => {
      if (timer != null) clearTimeout(timer)
      timer = null
    }
    const schedule = () => {
      clear()
      if (cancelled || !visible()) return
      timer = setTimeout(run, Math.min(maxMs, Math.round(baseMs * factor ** quiet)))
    }
    async function run() {
      clear()
      if (cancelled || running || !visible()) return
      running = true
      let changed
      try {
        changed = (await taskRef.current()) === true
      } catch {
        changed = false
      }
      running = false
      quiet = changed ? 0 : quiet + 1
      schedule()
    }
    const onVisibility = () => {
      if (!visible()) return clear()
      quiet = 0
      run()
    }

    document.addEventListener('visibilitychange', onVisibility)
    if (immediate && visible()) run()
    else schedule()
    return () => {
      cancelled = true
      clear()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, baseMs, maxMs, factor, immediate, resetKey])
}

export default useVisiblePolling
