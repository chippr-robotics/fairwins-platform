import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUnifiedLookup } from '../../hooks/useUnifiedLookup'
import { normalizePhrase } from '../../lib/lookup/resolvePhraseLookup.js'
import { isValidWord } from '../../utils/claimCode/wordlist'
import TakeChallengePanel from './TakeChallengePanel'
import JoinPoolPanel from './JoinPoolPanel'
import PhraseWordInputs from './PhraseWordInputs'
import InfoTip from '../ui/InfoTip'
import './FriendMarketsModal.css'
import './OpenChallengeModal.css'

// Split a raw phrase into exactly four editable slots (pad/truncate) for the per-word inputs.
const toWordSlots = (phrase) => {
  const parts = normalizePhrase(phrase || '').split(' ').filter(Boolean).slice(0, 4)
  return [0, 1, 2, 3].map((i) => parts[i] || '')
}

const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)

/**
 * Unified phrase lookup modal (spec 037, US1 / FR-001..013/025).
 *
 * One "enter a phrase" surface that resolves a four-word phrase to EITHER an open challenge or a group
 * pool and shows the matching take/join interface — the user never picks the type. Replaces the separate
 * "Take a challenge" and "Join a pool" entry points. Read-only preview requires no wallet signature
 * (FR-010); only the terminal take/join action signs.
 */
export default function UnifiedLookupModal({ isOpen, onClose, onBuyMembership, initialPhrase = '', autoResolve = false }) {
  const { status, result, submit, reset } = useUnifiedLookup()
  const navigate = useNavigate()
  const [words, setWords] = useState(() => toWordSlots(initialPhrase))
  const [choice, setChoice] = useState(null) // collision disambiguation: 'challenge' | 'pool'

  const phrase = words.join(' ').trim()
  const allWordsValid = words.every(isValidWord)

  useEffect(() => {
    if (!isOpen) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  // Deep-link prefill + auto-resolve (FR-013): a shared ?oc=take&code= link opens here pre-resolved.
  useEffect(() => {
    if (isOpen && autoResolve && initialPhrase) {
      setWords(toWordSlots(initialPhrase))
      submit(initialPhrase)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, autoResolve, initialPhrase])

  const onSubmit = useCallback((e) => {
    e.preventDefault()
    if (!allWordsValid) return
    setChoice(null)
    submit(phrase)
  }, [submit, phrase, allWordsValid])

  const searchAgain = useCallback(() => { setChoice(null); reset() }, [reset])

  if (!isOpen) return null
  const handleBackdrop = (e) => { if (e.target === e.currentTarget) onClose() }

  const code = normalizePhrase(phrase)
  const kind = status === 'result' ? result?.kind : null
  const showingPanel = kind === 'challenge' || kind === 'pool' || kind === 'funding' || kind === 'collision' || kind === 'not-actionable' || kind === 'self'
  const showForm = !showingPanel

  const openPoolManagement = (address) => { onClose(); navigate(`/pools/${address}`) }
  // Funding pools (spec 103, FR-021): the words resolve to a funding pool → its own page, never the join panel.
  const openFundingPool = (address) => { onClose(); navigate(`/fund/${address}`) }
  const fundingRow = result?.funding ? (
    <p className="fm-hint" data-testid="lookup-funding-also">
      These words also match a funding pool — <button type="button" className="fm-link-btn" onClick={() => openFundingPool(result.funding.address)}>open it</button>.
    </p>
  ) : null

  const renderResult = () => {
    if (status !== 'result' || !result) return null
    switch (result.kind) {
      case 'funding':
        return (
          <div className="fm-form" data-testid="lookup-funding">
            <p className="fm-hint">
              Those four words open a <strong>funding pool</strong>: “{result.match.purpose}” — {result.match.raisedFormatted} of {result.match.goalFormatted} {result.match.tokenSymbol} raised.
            </p>
            <div className="fm-success-actions">
              <button type="button" className="fm-btn-primary" onClick={() => openFundingPool(result.match.address)}>Open the pool</button>
              <button type="button" className="fm-btn-secondary" onClick={searchAgain}>Back</button>
            </div>
          </div>
        )
      case 'challenge':
        return <TakeChallengePanel code={code} match={result.match} onClose={onClose} onBuyMembership={onBuyMembership} onBack={searchAgain} />
      case 'pool':
        return (
          <>
            {fundingRow}
            <JoinPoolPanel summary={result.match} onClose={onClose} />
            <div className="fm-success-actions"><button type="button" className="fm-btn-secondary" onClick={searchAgain}>Back</button></div>
          </>
        )
      case 'collision':
        if (!choice) {
          return (
            <div className="fm-form">
              <p className="fm-hint">Those four words match both a challenge and a pool. Which do you want to open?</p>
              <div className="fm-success-actions">
                <button type="button" className="fm-btn-primary" onClick={() => setChoice('challenge')}>Open the challenge</button>
                <button type="button" className="fm-btn-primary" onClick={() => setChoice('pool')}>Open the pool</button>
                <button type="button" className="fm-btn-secondary" onClick={searchAgain}>Back</button>
              </div>
            </div>
          )
        }
        return choice === 'challenge'
          ? <TakeChallengePanel code={code} match={result.challenge} onClose={onClose} onBuyMembership={onBuyMembership} onBack={() => setChoice(null)} />
          : (<>
              <JoinPoolPanel summary={result.pool} onClose={onClose} />
              <div className="fm-success-actions"><button type="button" className="fm-btn-secondary" onClick={() => setChoice(null)}>Back</button></div>
            </>)
      case 'self':
        return (
          <div className="fm-form">
            <p className="fm-hint">
              {result.type === 'pool'
                ? 'You’re already in this pool. Open it to manage your membership.'
                : 'This is your own challenge. Manage it from My Wagers.'}
            </p>
            <div className="fm-success-actions">
              {result.type === 'pool'
                ? <button type="button" className="fm-btn-primary" onClick={() => openPoolManagement(result.match.address)}>Open pool</button>
                : <button type="button" className="fm-btn-primary" onClick={onClose}>Close</button>}
              <button type="button" className="fm-btn-secondary" onClick={searchAgain}>Back</button>
            </div>
          </div>
        )
      case 'not-actionable':
        return (
          <div className="fm-form">
            <div className="oc-notice oc-notice--warn" role="alert">
              {result.type === 'pool'
                ? `This pool can’t be joined right now (${result.reason}).`
                : 'This challenge can no longer be taken.'}
            </div>
            <div className="fm-success-actions"><button type="button" className="fm-btn-secondary" onClick={searchAgain}>Back</button></div>
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div
      className="friend-markets-modal-backdrop"
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="unified-lookup-title"
    >
      <div className="friend-markets-modal" onClick={(e) => e.stopPropagation()}>
        <header className="fm-header">
          <div className="fm-header-content">
            <div className="fm-brand">
              <span className="fm-brand-icon" aria-hidden="true">&#128269;</span>
              <h2 id="unified-lookup-title">Enter a phrase</h2>
            </div>
            <p className="fm-subtitle">Open a challenge or a pool with the four words a friend shared</p>
          </div>
          <button className="fm-close-btn" onClick={onClose} aria-label="Close modal">
            <CloseIcon />
          </button>
        </header>

        <div className="fm-content">
          <div className="fm-panel">
            {showForm && (
              <form className="fm-form" onSubmit={onSubmit}>
                <div className="fm-form-group fm-form-full">
                  <span className="fm-label-row">
                    <label htmlFor="phrase-word-0">Four-word phrase <span className="fm-required">*</span></label>
                    <InfoTip label="About: Four-word phrase">
                      We’ll find whatever the words point to — a challenge or a pool. Type each word and
                      pick from the suggestions — a mistyped word is flagged before you finish.
                    </InfoTip>
                  </span>
                  <PhraseWordInputs
                    words={words}
                    onChange={setWords}
                    disabled={status === 'resolving'}
                  />
                  {/* Every word of the example must itself be a wordlist word — the boxes validate
                      against the same list, so an illustrative phrase that fails validation would
                      leave "Find" disabled for anyone who follows it literally. */}
                  <span className="fm-hint">e.g. crystal orbit harbor velvet</span>
                </div>

                {status === 'result' && result?.kind === 'format-error' && (
                  <div className="fm-error-banner" role="alert">
                    {result.message} Enter exactly four words, e.g. “crystal orbit harbor velvet”.
                  </div>
                )}
                {status === 'result' && result?.kind === 'none' && (
                  <div className="oc-notice" role="status">
                    No pool or challenge matches those four words. Check the words and try again.
                  </div>
                )}
                {status === 'result' && result?.kind === 'lookup-failed' && (
                  <div className="fm-error-banner" role="alert">
                    Couldn’t check right now — a network issue got in the way. Please try again.
                  </div>
                )}

                <div className="fm-success-actions">
                  <button type="submit" className="fm-btn-primary" disabled={status === 'resolving' || !allWordsValid}>
                    {status === 'resolving' ? 'Looking up…' : 'Find'}
                  </button>
                </div>
                <span className="sr-only" role="status" aria-live="polite">
                  {status === 'resolving' ? 'Looking up your phrase' : ''}
                </span>
              </form>
            )}

            {renderResult()}
          </div>
        </div>
      </div>
    </div>
  )
}
