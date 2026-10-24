import { useEffect, useState } from 'react'

import { tenantBrand } from '../../config/tenant'
import { isNativeRuntime } from '../../lib/native/runtime'
import { checkSupportFloor } from '../../lib/native/supportFloor'

import './NativeNotice.css'

/**
 * FR-015 (spec 102): a native build older than the published support floor
 * says so, naming the update path, BEFORE degraded behavior gets attributed
 * to anything else. Renders nothing on web (always latest), nothing while the
 * floor is unknown (no floor published, or unreachable — a network failure is
 * not a fact about the member's build), and nothing when supported.
 */
export default function StaleBuildNotice() {
  const [result, setResult] = useState({ state: 'unknown' })

  useEffect(() => {
    if (!isNativeRuntime()) return undefined
    let cancelled = false
    checkSupportFloor({ origin: tenantBrand().appUrl }).then((r) => {
      if (!cancelled) setResult(r)
    })
    return () => { cancelled = true }
  }, [])

  if (result.state !== 'below-floor') return null
  return (
    <p className="native-capability-notice stale-build-notice" role="status">
      This app version ({result.current}) is older than the oldest supported
      version ({result.floor}). Update the app
      {result.updateUrl ? ' from the store page' : ''} before relying on it —
      older builds may not work correctly against current services.
      {result.updateUrl && (
        <>
          {' '}
          <a href={result.updateUrl} target="_blank" rel="noreferrer">Open the update page</a>
        </>
      )}
    </p>
  )
}
