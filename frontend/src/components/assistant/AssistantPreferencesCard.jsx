/**
 * AssistantPreferencesCard (specs 095 + 104) — the "Assistant" card of the Assistant tab.
 *
 * Moved here from Settings (`components/account/AssistantPreferencesPanel.jsx`) when the agent
 * controls got a tab of their own; the card id `assistant-prefs` is unchanged so the old deep
 * links redirect rather than die. Everything on it still exists to make a trade legible BEFORE a
 * switch is flipped:
 *
 *   · The master switch. Off means the launcher does not render, no session is authorised, and no
 *     message leaves the device — so the summary line says "Off — nothing is sent", a statement of
 *     fact rather than a label.
 *   · "Answered by" (spec 104). TWO rails now exist — FairWins (membership, through the gateway)
 *     and GutterToken (the member's own prepaid credits, browser-direct). Each option carries its
 *     own one-sentence cost/privacy line, because they differ in exactly the two things a member
 *     cares about: who receives the messages and who pays. An option the member cannot take right
 *     now is DISABLED WITH A REASON, never hidden — and an UNREADABLE membership keeps the FairWins
 *     option offered, because an RPC timeout is not a fact about the membership.
 *   · Memory retention, with a LIVE COUNT beside the clear button. A number the member watches go
 *     to zero is a fact; a "Clear" that does not say what it cleared is a promise.
 *
 * The chooser records a PREFERENCE. What actually answers is decided by `resolveProvider`, and the
 * summary line names THAT — a preference for a rail whose key was removed must not read as if the
 * rail were still in use.
 */

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PropTypes from 'prop-types'
import { useWallet } from '../../hooks/useWalletManagement'
import AccordionSection from '../account/AccordionSection'
import NavIcon from '../nav/NavIcon'
import {
  ASSISTANT_PROVIDERS,
  getAssistantProvider,
  isAssistantEnabled,
  isMemoryRetained,
  setAssistantEnabled,
  setAssistantProvider,
  setMemoryRetained,
  subscribeAssistantPrefs,
} from '../../lib/assistant/assistantPrefs'
import * as keyStore from '../../lib/assistant/guttertokenKeyStore'
import { resolveProvider } from '../../lib/assistant/resolveProvider'
import { clearMemory, memoryCount, subscribeAssistantMemory } from '../../lib/assistant/memoryStore'
import { clearSession } from '../../lib/assistant/assistantClient'
import { captureAssistantPreference } from '../../data/ledger/sources/accessLedgerSource'
import {
  PROVIDER_COST_LINES,
  PROVIDER_NAMES,
  PROVIDER_OPTION_LABELS,
  providerOptionReason,
} from './providerCopy'

const PROVIDER_ORDER = Array.isArray(ASSISTANT_PROVIDERS) && ASSISTANT_PROVIDERS.length
  ? ASSISTANT_PROVIDERS
  : ['fairwins', 'guttertoken']

export default function AssistantPreferencesCard({ membership = null, byokEnabled = true }) {
  const { address: account, chainId, isConnected } = useWallet()

  const [revision, setRevision] = useState(0)
  const rerender = useCallback(() => setRevision((n) => n + 1), [])

  // Three stores feed this card and none of them is React state: the memory count changes from
  // the chat panel, the key from its sheet, the preference from the panel's chooser step.
  useEffect(() => subscribeAssistantMemory(rerender), [rerender])
  useEffect(() => subscribeAssistantPrefs(rerender), [rerender])
  useEffect(() => keyStore.subscribeGutterTokenKey(rerender), [rerender])

  const connected = Boolean(isConnected && account)
  const enabled = connected ? isAssistantEnabled(account) : false
  const retain = connected ? isMemoryRetained(account) : true
  const count = connected ? memoryCount(account) : 0
  const preferred = connected ? getAssistantProvider(account) : 'fairwins'
  const hasKey = connected ? keyStore.hasGutterTokenKey(account) : false
  const resolution = connected ? resolveProvider({ account, membership }) : { provider: null, reason: 'disabled' }
  // `revision` is read so the linter and a reader both see why this component re-renders.
  void revision

  const toggleEnabled = useCallback(() => {
    if (!account) return
    const next = !enabled
    setAssistantEnabled(account, next)
    if (!next) {
      // Switching off drops the in-memory session immediately: the member should not have to
      // reload for "off" to mean off.
      clearSession()
    }
    captureAssistantPreference(account, chainId, next)
    rerender()
  }, [account, chainId, enabled, rerender])

  const toggleRetain = useCallback(() => {
    if (!account) return
    const next = !retain
    setMemoryRetained(account, next)
    // Turning retention off empties what is already held — leaving it would mean "stop remembering"
    // silently kept the part it had already remembered.
    if (!next) clearMemory(account)
    rerender()
  }, [account, retain, rerender])

  const clearNow = useCallback(() => {
    if (!account) return
    clearMemory(account)
    rerender()
  }, [account, rerender])

  const choose = useCallback(
    (provider) => {
      if (!account) return
      setAssistantProvider(account, provider)
      rerender()
    },
    [account, rerender]
  )

  // ------------------------------------------------------------------ summary
  let summary = 'Off — nothing is sent'
  if (!connected) summary = 'Connect a wallet'
  else if (enabled && resolution.provider) {
    summary = `On — answered by ${PROVIDER_NAMES[resolution.provider]}`
  } else if (enabled && resolution.reason === 'pending') summary = 'On — checking membership'
  else if (enabled && resolution.reason === 'unreadable') summary = 'On — membership could not be read'
  else if (enabled) summary = 'On — no rail available yet'

  const effectiveLine = (() => {
    if (!connected) return null
    if (resolution.provider) return `Right now the assistant is answered by ${PROVIDER_NAMES[resolution.provider]}.`
    if (resolution.reason === 'pending') return 'Checking your membership to see which option can answer.'
    if (resolution.reason === 'unreadable') return 'Your membership could not be read right now, so it is not yet known which option can answer. Nothing is wrong with your account.'
    if (resolution.reason === 'no-key') return 'Nothing can answer yet: add a GutterToken key below, or choose the FairWins assistant.'
    if (resolution.reason === 'not-member') return 'Nothing can answer yet: this account has no active membership and no GutterToken key.'
    return null
  })()

  return (
    <AccordionSection
      id="assistant-prefs"
      title="Assistant"
      summary={summary}
      icon={<NavIcon name="chat" size={18} />}
      className="assistant-prefs"
      data-testid="assistant-prefs-panel"
    >
      {!connected ? (
        <p role="note">Connect your wallet to turn the assistant on.</p>
      ) : (
        <>
          <div className="assistant-prefs__row">
            <div className="assistant-prefs__text">
              <span className="assistant-prefs__label" id="assistant-prefs-enable-label">
                Assistant
              </span>
              <span className="assistant-prefs__sub">
                {enabled
                  ? 'On — a button appears in the app. Where what you type goes depends on who answers, below.'
                  : 'Off — the assistant does not appear anywhere, and nothing is sent.'}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-labelledby="assistant-prefs-enable-label"
              className={`assistant-prefs__switch ${enabled ? 'on' : ''}`}
              onClick={toggleEnabled}
              data-testid="assistant-enable-switch"
            >
              <span className="sr-only">{enabled ? 'Assistant on' : 'Assistant off'}</span>
            </button>
          </div>

          {/* Answered by (spec 104). Radios, not a select: both options and both reasons must be
              readable at once — the choice IS the disclosure. */}
          <div className="assistant-prefs__chooser" role="radiogroup" aria-labelledby="assistant-provider-label">
            <span className="assistant-prefs__label" id="assistant-provider-label">
              Answered by
            </span>
            {PROVIDER_ORDER.filter((p) => byokEnabled || p !== 'guttertoken').map((provider) => {
              const reason = providerOptionReason(provider, { membership, hasKey })
              const disabled = Boolean(reason) && !reason.keepEnabled
              const checked = preferred === provider
              return (
                <div key={provider} className={`assistant-prefs__option${disabled ? ' is-disabled' : ''}`}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-disabled={disabled || undefined}
                    disabled={disabled}
                    aria-describedby={`assistant-provider-${provider}-desc`}
                    className={`assistant-prefs__radio${checked ? ' is-checked' : ''}`}
                    onClick={() => !disabled && choose(provider)}
                    data-testid={`assistant-provider-${provider}`}
                  >
                    <span className="assistant-prefs__radio-dot" aria-hidden="true" />
                    <span className="assistant-prefs__radio-label">{PROVIDER_OPTION_LABELS[provider]}</span>
                  </button>
                  <div className="assistant-prefs__option-desc" id={`assistant-provider-${provider}-desc`}>
                    <span className="assistant-prefs__sub">{PROVIDER_COST_LINES[provider]}</span>
                    {reason && (
                      <span
                        className={`assistant-prefs__reason assistant-prefs__reason--${reason.tone}`}
                        data-testid={`assistant-provider-${provider}-reason`}
                      >
                        {reason.text}
                        {reason.membershipLink && (
                          <>
                            {' '}
                            <Link to="/wallet?tab=membership" className="assistant-prefs__link">
                              Go to Membership
                            </Link>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
            {effectiveLine && (
              <p className="assistant-prefs__effective" role="status" data-testid="assistant-provider-effective">
                {effectiveLine}
              </p>
            )}
          </div>

          <div className="assistant-prefs__row">
            <div className="assistant-prefs__text">
              <span className="assistant-prefs__label" id="assistant-prefs-memory-label">
                Remember conversations on this device
              </span>
              <span className="assistant-prefs__sub">
                {retain
                  ? 'On — the last few messages stay in this browser so the assistant remembers where you were. They are never backed up or synced.'
                  : 'Off — the conversation is forgotten as soon as you close the panel.'}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={retain}
              aria-labelledby="assistant-prefs-memory-label"
              className={`assistant-prefs__switch ${retain ? 'on' : ''}`}
              onClick={toggleRetain}
              data-testid="assistant-memory-switch"
            >
              <span className="sr-only">{retain ? 'Memory on' : 'Memory off'}</span>
            </button>
          </div>

          <div className="assistant-prefs__clear">
            <button type="button" className="btn" onClick={clearNow} disabled={count === 0}>
              Clear conversation memory
            </button>
            <span className="assistant-prefs__count" role="status" data-testid="assistant-memory-count">
              {count === 0
                ? 'Nothing stored on this device'
                : `${count} message${count === 1 ? '' : 's'} stored on this device`}
            </span>
          </div>
        </>
      )}
    </AccordionSection>
  )
}

AssistantPreferencesCard.propTypes = {
  /** `useRoleDetails().getRoleDetails('WAGER_PARTICIPANT')` — null while pending. */
  membership: PropTypes.shape({ isActive: PropTypes.bool, readable: PropTypes.bool }),
  /** Tenant feature `assistant-byok`. False drops the GutterToken option entirely (no such rail here). */
  byokEnabled: PropTypes.bool,
}
