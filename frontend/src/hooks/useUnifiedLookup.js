import { useCallback, useState } from 'react'
import { useOpenChallengeAccept } from './useOpenChallengeAccept'
import { usePools } from './usePools'
import { useFundingPools } from './useFundingPools'
import { useWeb3 } from './useWeb3'
import { getWordListLang } from '../utils/wordListLanguage'
import { resolvePhraseLookup } from '../lib/lookup/resolvePhraseLookup.js'

/**
 * Unified "enter a phrase" lookup (spec 037, US1). Wires the existing open-challenge and pool lookups
 * into the shared resolver and exposes a small state machine to the UnifiedLookupModal:
 *   status: 'idle' | 'resolving' | 'result'
 *   result: LookupResult | null   (see lib/lookup/resolvePhraseLookup.js)
 * The read-only lookup requires no wallet signature (FR-010).
 */
export function useUnifiedLookup() {
  const { lookup: lookupChallenge } = useOpenChallengeAccept()
  const { resolvePhrase } = usePools()
  // Funding pools (spec 103) share the four-word entry point; the resolver reports which kind it found.
  const { resolvePhrase: resolveFunding } = useFundingPools()
  const { account } = useWeb3()
  const [status, setStatus] = useState('idle')
  const [result, setResult] = useState(null)

  const submit = useCallback(async (phrase) => {
    setStatus('resolving')
    setResult(null)
    const res = await resolvePhraseLookup({
      phrase,
      lang: getWordListLang(),
      account,
      deps: { lookupChallenge, resolvePool: resolvePhrase, resolveFunding },
    })
    setResult(res)
    setStatus('result')
    return res
  }, [account, lookupChallenge, resolvePhrase, resolveFunding])

  const reset = useCallback(() => {
    setStatus('idle')
    setResult(null)
  }, [])

  return { status, result, submit, reset }
}

export default useUnifiedLookup
