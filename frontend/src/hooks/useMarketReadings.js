/**
 * useMarketReadings(keys) → Map<key, PriceReading> (spec 114). Subscribes through lib/markets/feed,
 * unsubscribes on unmount and when the key set changes. A key with no reading yet is
 * `unknown('not-yet-read')` — never an empty book or a zero. The Map keeps its identity until a reading
 * changes.
 */
import { useEffect, useMemo, useState } from 'react'
import { subscribe } from '../lib/markets/feed'
import { unknown } from '../lib/markets/priceReading'

const NOT_YET_READ = unknown('not-yet-read')

export function useMarketReadings(keys) {
  // A stable string identity for the key set, so a new array with the same keys does not resubscribe.
  const keySig = useMemo(() => JSON.stringify([...new Set(Array.isArray(keys) ? keys : [])].sort()), [keys])
  const keyList = useMemo(() => JSON.parse(keySig), [keySig])
  const [state, setState] = useState(() => ({ sig: keySig, map: new Map() }))

  useEffect(() => {
    if (keyList.length === 0) return undefined
    return subscribe(keyList, (changed) => {
      setState((prev) => {
        const map = new Map(prev.sig === keySig ? prev.map : [])
        for (const [k, v] of changed) map.set(k, v)
        return { sig: keySig, map }
      })
    })
  }, [keySig, keyList])

  return useMemo(() => {
    const out = new Map()
    for (const k of keyList) out.set(k, (state.sig === keySig && state.map.get(k)) || NOT_YET_READ)
    return out
  }, [keyList, keySig, state])
}

export default useMarketReadings
