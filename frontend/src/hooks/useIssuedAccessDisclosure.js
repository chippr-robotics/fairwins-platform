/**
 * Issued-access disclosure (spec 107 FR-028's member-visible half, #1471).
 *
 * Answers ONE question for a surface: "which of these chains is reading on public capacity
 * because keyed access FAILED?" — and deliberately nothing else. The other four states render as
 * silence, each for its own reason (see issuedAccessState): dormant means the feature does not
 * exist in this build, active means nothing is wrong, acquiring means nothing has settled yet,
 * and declined means the chain's public path is permanent and CORRECT — ETC and Mordor are not
 * degraded, they are normal, and apologising for them would be the false-degradation twin of the
 * false zero.
 *
 * Reactivity rides the issued-access store's OWN listener set, not the endpoints revision: a
 * cooldown transition is not a route change, and bumping the revision for one would re-derive
 * every provider memo in the app on a timer.
 */
import { useMemo, useSyncExternalStore } from 'react'
import {
  issuedAccessState,
  issuedAccessStateVersion,
  subscribeIssuedAccessState,
} from '../lib/network/issuedAccess'
import { NETWORKS } from '../config/networks'

export function useIssuedAccessDisclosure(chainIds) {
  const version = useSyncExternalStore(
    subscribeIssuedAccessState,
    issuedAccessStateVersion,
    issuedAccessStateVersion,
  )
  return useMemo(() => {
    const degraded = (chainIds || []).filter((id) => issuedAccessState(id) === 'degraded')
    return {
      degraded,
      names: degraded.map((id) => NETWORKS[id]?.name || String(id)),
    }
    // `version` is what makes state edges re-evaluate; it has no meaning beyond "something changed".
  }, [chainIds, version])
}

export default useIssuedAccessDisclosure
