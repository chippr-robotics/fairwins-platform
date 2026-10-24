/**
 * AssistantPanel (specs 095 + 104) — the chat surface behind the floating launcher.
 *
 * Built on `ActionSheet` rather than beside it: that component already owns the dialog role, the
 * focus trap, the Escape/backdrop close, the background scroll lock, the z-1500 backdrop that sits
 * above the fixed bottom nav, and the mobile safe-area padding. A second implementation of those
 * would be a second set of bugs.
 *
 * FOUR THINGS THIS PANEL WILL NOT DO:
 *
 * 1. **It never invents a reply.** Every failure has its own honest sentence and a retry — an
 *    unreachable gateway reads as unreachable, a disabled assistant reads as disabled, an empty
 *    GutterToken balance reads as empty. The one unacceptable behaviour for an assistant is
 *    answering when its backend did not.
 * 2. **It never signs or submits**, and every reply says so in its own footer rather than once at
 *    the top where it scrolls away.
 * 3. **It never asks for a session silently.** Whenever a signature is wanted, the panel explains,
 *    in advance, what it is for, what it authorises, how long it lasts and that the token never
 *    leaves this tab — then asks.
 * 4. **Its live region is `polite`.** A reply is not an error, and `assertive` interrupts whatever
 *    a screen-reader user was doing.
 *
 * SPEC 104 — TWO RAILS, ONE PANEL. Who answers is decided by `resolveProvider`, never by this
 * component, and the header names the rail every time ("Answered by GutterToken on your credits").
 * The first step follows from that decision:
 *   · FairWins  → the session grant IS the rail (the gateway is the model path), so "Sign to start"
 *                 stays exactly as it was.
 *   · GutterToken → the chat opens at once — no FairWins service is in the model path — and the
 *                 grant is OFFERED, dismissibly, only to a member whose own data the tools could
 *                 read. Accepting it starts a NEW thread: the tool set is part of what a
 *                 conversation is, and it must not change under one (research § 8.4).
 *   · Nothing   → a chooser (add a key, or become a member), or — for pending/unreadable
 *                 membership — an honest sentence. Never a denial for a read that did not happen.
 *
 * TOOLS ARE VISIBLE WHILE THEY RUN. A row per read ("Reading your wagers…") that ends in "read" or
 * "could not be read" — never a zero — and a compact Sources line under the reply. Tool results
 * themselves are the member's own data and are NEVER written to `memoryStore`: only the text turns
 * are persisted (research § 8.6).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import PropTypes from 'prop-types'
import ActionSheet from '../account/ActionSheet'
import { useWallet } from '../../hooks/useWalletManagement'
import useRoleDetails from '../../hooks/useRoleDetails'
import { isFeatureEnabled } from '../../config/tenant'
import { resolveGrantSigner } from '../../lib/apiAccess/grantSigner'
import {
  ASSISTANT_SESSION_SCOPES,
  authorizeSession,
  hasSession,
  sessionToken,
} from '../../lib/assistant/assistantClient'
import {
  isMemoryRetained,
  setAssistantProvider,
  subscribeAssistantPrefs,
} from '../../lib/assistant/assistantPrefs'
import * as keyStore from '../../lib/assistant/guttertokenKeyStore'
import { resolveProvider } from '../../lib/assistant/resolveProvider'
import { runAssistantTurn } from '../../lib/assistant/conversation'
import { GUTTERTOKEN_BILLING_URL } from '../../lib/assistant/providers/guttertoken'
import { clearMemory, loadMemory, saveMemory } from '../../lib/assistant/memoryStore'
import { extractInAppLinks } from '../../lib/assistant/replyLinks'
import GutterTokenKeySheet from './GutterTokenKeySheet'
import { PROVIDER_COST_LINES, applyToolEvent, errorCopy, providerBadgeText } from './providerCopy'
import './AssistantPanel.css'

/** The gateway accepts at most 20 turns per request; send the most recent window. */
const MAX_TURNS_SENT = 20

/** Repeated under every reply — not once at the top, where it scrolls out of view. */
export const REPLY_DISCLAIMER = 'AI-generated — verify before acting. The assistant never signs or submits.'

/** The two states retrying cannot change. */
const TERMINAL_STATES = new Set(['unset', 'unconfigured'])

/**
 * One turn. A reply carries its own disclaimer — repeated per bubble rather than stated once at the
 * top, where it scrolls away — and any in-app paths it mentioned become shortcuts. A path the app
 * does not route stays plain text inside the bubble (see `lib/assistant/replyLinks.js`).
 */
function Message({ message, onNavigate }) {
  const links = message.role === 'assistant' ? extractInAppLinks(message.content) : []
  return (
    <div className={`assistant-panel__message assistant-panel__message--${message.role}`}>
      <p className="assistant-panel__bubble">{message.content}</p>
      {message.role === 'assistant' && (
        <>
          {links.length > 0 && (
            <nav className="assistant-panel__links" aria-label="Places in the app">
              {links.map((link) => (
                <Link key={link.path} to={link.path} className="assistant-panel__link" onClick={onNavigate}>
                  {link.path}
                </Link>
              ))}
            </nav>
          )}
          <p className="assistant-panel__disclaimer">{REPLY_DISCLAIMER}</p>
        </>
      )}
    </div>
  )
}

Message.propTypes = {
  message: PropTypes.shape({ role: PropTypes.string, content: PropTypes.string }).isRequired,
  onNavigate: PropTypes.func,
}

/**
 * The panel reads membership ITSELF only when its opener could not hand one over — the launcher's
 * cheap path (a saved key with the GutterToken preference) deliberately never mounts the membership
 * read, and the grant offer still needs to know whether there is a membership to read.
 */
function WithMembership(props) {
  const { getRoleDetails, refresh } = useRoleDetails()
  return <PanelBody {...props} membership={getRoleDetails('WAGER_PARTICIPANT')} onRetryMembership={refresh} />
}

export default function AssistantPanel({ open, onClose, surface = null, membership, onRetryMembership = null }) {
  return (
    <ActionSheet open={open} onClose={onClose} title="FairWins assistant" className="assistant-sheet">
      {membership === undefined ? (
        <WithMembership onClose={onClose} surface={surface} />
      ) : (
        <PanelBody onClose={onClose} surface={surface} membership={membership} onRetryMembership={onRetryMembership} />
      )}
    </ActionSheet>
  )
}

AssistantPanel.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  /** Where the member opened it from, forwarded to the model so answers can be contextual. */
  surface: PropTypes.string,
  /** `getRoleDetails('WAGER_PARTICIPANT')` when the opener has it; `undefined` to read it here. */
  membership: PropTypes.shape({ isActive: PropTypes.bool, readable: PropTypes.bool }),
  onRetryMembership: PropTypes.func,
}

function PanelBody({ onClose, surface, membership, onRetryMembership }) {
  const { address: account, signer, loginMethod } = useWallet()
  const byokEnabled = isFeatureEnabled('assistant-byok')

  // The body mounts fresh on every opening (ActionSheet renders nothing while closed), so the
  // remembered conversation is restored in the initialiser rather than in an effect. Retention off
  // means there is nothing to restore, which is the whole point of the preference.
  const retain = account ? isMemoryRetained(account) : false
  const [messages, setMessages] = useState(() => (account && retain ? loadMemory(account) : []))
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null) // { state, message, retryAfterSeconds }
  const [authorizing, setAuthorizing] = useState(false)
  const [authorized, setAuthorized] = useState(() => hasSession(account))
  const [toolRows, setToolRows] = useState([])
  const [lastSources, setLastSources] = useState(null)
  const [notice, setNotice] = useState(null)
  const [grantDismissed, setGrantDismissed] = useState(false)
  const [grantPrompted, setGrantPrompted] = useState(false)
  const [forceChooser, setForceChooser] = useState(false)
  const [keySheetOpen, setKeySheetOpen] = useState(false)
  const threadRef = useRef(null)

  // The rail can change while the panel is open — a key saved in its own sheet, a preference
  // flipped on the Tools tab in another window — so subscribe rather than resolve once.
  const [, bump] = useState(0)
  useEffect(() => subscribeAssistantPrefs(() => bump((n) => n + 1)), [])
  useEffect(() => keyStore.subscribeGutterTokenKey(() => bump((n) => n + 1)), [])

  const resolution = resolveProvider({ account, membership })
  const provider = resolution.provider
  const membershipActive = Boolean(membership?.isActive)

  const grantSigner = useMemo(
    () => resolveGrantSigner({ loginMethod, signer, address: account }),
    [loginMethod, signer, account]
  )

  // Keep the newest turn in view.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, sending, error, toolRows])

  const persist = useCallback(
    (next) => {
      setMessages(next)
      if (account && retain) saveMemory(account, next)
    },
    [account, retain]
  )

  const authorize = useCallback(async () => {
    setError(null)
    if (!grantSigner.canSign) {
      setError({ state: 'unauthorized', message: grantSigner.reason || 'This account cannot authorize a session.' })
      return
    }
    setAuthorizing(true)
    try {
      await authorizeSession({ account, sign: grantSigner.sign })
      setAuthorized(true)
      setGrantPrompted(false)
      // A grant changes what the assistant can read, and the tool set is part of what a
      // conversation IS. So a new grant starts a new thread rather than swapping tools under the
      // one on screen — on both rails; on FairWins there was no thread yet, so this is a no-op.
      if (messages.length > 0) {
        persist([])
        if (account) clearMemory(account)
        setToolRows([])
        setLastSources(null)
        setNotice('New conversation — the assistant can now read your own wagers and membership when you ask.')
      }
    } catch (e) {
      const rejected =
        e?.code === 'ACTION_REJECTED' ||
        e?.name === 'CeremonyCancelled' ||
        /reject|denied|cancel/i.test(e?.message || '')
      setError({
        state: 'unauthorized',
        message: rejected
          ? 'Signature was cancelled — the assistant was not authorized.'
          : e?.message || 'The assistant session could not be authorized.',
      })
    } finally {
      setAuthorizing(false)
    }
  }, [account, grantSigner, messages.length, persist])

  const send = useCallback(
    async (thread) => {
      setSending(true)
      setError(null)
      setNotice(null)
      setToolRows([])
      setLastSources(null)
      let rows = []
      try {
        const payload = thread.slice(-MAX_TURNS_SENT).map((m) => ({ role: m.role, content: m.content }))
        const result = await runAssistantTurn({
          account,
          provider,
          thread: payload,
          surface,
          membershipActive,
          sessionToken: hasSession(account) ? sessionToken(account) : null,
          onToolEvent: (event) => {
            rows = applyToolEvent(rows, event)
            setToolRows(rows)
          },
        })
        // Text turns only — tool results are the member's own data and never reach the memory.
        persist([...thread, { role: 'assistant', content: result.reply, at: Date.now() }])
        // Whichever channel reported the tools, the Sources line reflects what was actually read.
        let done = rows.filter((r) => r.status !== 'pending')
        if (done.length === 0 && Array.isArray(result.toolEvents)) {
          done = result.toolEvents.reduce((acc, ev) => applyToolEvent(acc, { ...ev, phase: 'done' }), [])
        }
        setLastSources(done.length > 0 ? done : null)
        setToolRows([])
        if (result.roundsExhausted) {
          setNotice('The assistant reached its reading limit for this question, so the answer may be incomplete.')
        }
      } catch (e) {
        if (e?.state === 'unauthorized') setAuthorized(false)
        if (e?.state === 'key_missing') setForceChooser(true)
        if (e?.state === 'no_grant') {
          setGrantPrompted(true)
          setGrantDismissed(false)
        }
        setError({
          state: e?.state || 'rejected',
          message: errorCopy(e, provider),
          retryAfterSeconds: e?.retryAfterSeconds ?? null,
        })
        setToolRows(rows.map((r) => (r.status === 'pending' ? { ...r, status: 'unreadable' } : r)))
      } finally {
        setSending(false)
      }
    },
    [account, membershipActive, persist, provider, surface]
  )

  const submit = useCallback(
    (e) => {
      e?.preventDefault?.()
      const text = draft.trim()
      if (!text || sending) return
      const next = [...messages, { role: 'user', content: text, at: Date.now() }]
      persist(next)
      setDraft('')
      send(next)
    },
    [draft, messages, persist, send, sending]
  )

  const retry = useCallback(() => {
    // Resend the thread as it stands: the member's last question is still the last turn, so this
    // never duplicates it.
    if (messages.length > 0) send(messages)
  }, [messages, send])

  const forget = useCallback(() => {
    if (account) clearMemory(account)
    setMessages([])
    setError(null)
    setLastSources(null)
    setNotice(null)
  }, [account])

  const chooseGutterToken = useCallback(() => setKeySheetOpen(true), [])
  const chooseFairWins = useCallback(() => {
    if (!account) return
    setAssistantProvider(account, 'fairwins')
    setForceChooser(false)
    setError(null)
  }, [account])
  const onKeySaved = useCallback(() => {
    // The member chose "use my own credits" and now has a key: make the preference say so, or a
    // stale FairWins preference could leave the chooser on screen with a perfectly good key saved.
    if (account) setAssistantProvider(account, 'guttertoken')
    setForceChooser(false)
    setError(null)
  }, [account])

  const lastReply = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') return messages[i].content
    }
    return ''
  }, [messages])

  // ------------------------------------------------------------------ which step
  let step
  if (forceChooser || (!provider && (resolution.reason === 'no-key' || resolution.reason === 'not-member'))) step = 'choose'
  else if (!provider && resolution.reason === 'pending') step = 'pending'
  else if (!provider && resolution.reason === 'unreadable') step = 'unreadable'
  else if (!provider) step = 'disabled'
  else if (provider === 'fairwins' && !authorized) step = 'sign'
  else step = 'chat'

  const showGrantOffer =
    step === 'chat' && provider === 'guttertoken' && !authorized && membershipActive && (grantPrompted || !grantDismissed)

  const badge = providerBadgeText(provider)

  return (
    <>
      {badge && (
        <p className="assistant-panel__provider" data-testid="assistant-provider-badge">
          {badge}
        </p>
      )}

      {step === 'choose' && (
        <div className="assistant-panel__choose" data-testid="assistant-choose">
          <p className="assistant-panel__lead">
            Nothing can answer yet. The assistant runs either on a FairWins membership or on your own
            GutterToken credits — choose one.
          </p>
          {/* The bring-your-own-key rail exists only where the tenant enables it — offering it on a
              tenant that has none would open a sheet for a rail the app will never use. */}
          {byokEnabled && (
            <div className="assistant-panel__choice">
              <button type="button" className="btn btn-primary" onClick={chooseGutterToken} data-testid="assistant-choose-guttertoken">
                Use your own GutterToken credits
              </button>
              <p className="assistant-panel__hint">{PROVIDER_COST_LINES.guttertoken}</p>
            </div>
          )}
          <div className="assistant-panel__choice">
            {membershipActive ? (
              <button type="button" className="btn" onClick={chooseFairWins} data-testid="assistant-choose-fairwins">
                Use the FairWins assistant (membership)
              </button>
            ) : membership && membership.readable !== false ? (
              <Link to="/wallet?tab=membership" className="btn assistant-panel__linkbtn" onClick={onClose} data-testid="assistant-choose-fairwins">
                Become a member
              </Link>
            ) : (
              <p className="assistant-panel__hint" data-testid="assistant-choose-fairwins">
                {membership == null
                  ? 'Checking your membership for the FairWins option…'
                  : 'Your membership could not be read right now, so the FairWins option cannot be confirmed yet. Nothing is wrong with your account.'}
              </p>
            )}
            <p className="assistant-panel__hint">{PROVIDER_COST_LINES.fairwins}</p>
          </div>
        </div>
      )}

      {step === 'pending' && (
        <p className="assistant-panel__lead" role="status" data-testid="assistant-pending">
          Checking your membership…
        </p>
      )}

      {step === 'unreadable' && (
        <div className="assistant-panel__gate" data-testid="assistant-unreadable">
          <p className="assistant-panel__lead">
            Your membership could not be read just now, so it is not yet known who can answer. This is a
            network problem, not an answer about your account.
          </p>
          {onRetryMembership && (
            <button type="button" className="btn" onClick={() => onRetryMembership()}>
              Try again
            </button>
          )}
        </div>
      )}

      {step === 'disabled' && (
        <p className="assistant-panel__lead" role="status">
          The assistant is switched off for this account. Turn it on under Tools ▸ Assistant.
        </p>
      )}

      {step === 'sign' && (
        <div className="assistant-panel__authorize" data-testid="assistant-authorize">
          <p className="assistant-panel__lead">
            The assistant needs a short-lived key of your own before it can answer. You will be asked
            to sign one message — <strong>no transaction, no fee, nothing moves</strong>.
          </p>
          <ul className="assistant-panel__list">
            <li>
              It authorises reading your own data and talking to the assistant
              (<code>{ASSISTANT_SESSION_SCOPES.join(', ')}</code>). It cannot move funds.
            </li>
            <li>It lasts 24 hours and is kept in this tab only — never saved, never backed up.</li>
            <li>Closing the tab or switching accounts ends it.</li>
          </ul>
          <button
            type="button"
            className="btn btn-primary"
            onClick={authorize}
            disabled={authorizing}
            data-testid="assistant-authorize-button"
          >
            {authorizing ? 'Waiting for your signature…' : 'Sign to start'}
          </button>
          {error && (
            <div className="assistant-panel__error" role="alert" data-testid="assistant-error">
              <p>{error.message}</p>
            </div>
          )}
        </div>
      )}

      {step === 'chat' && (
        <>
          {showGrantOffer && (
            <div className="assistant-panel__offer" role="note" data-testid="assistant-grant-offer">
              <p>
                Sign to let it read your own wagers and membership (optional, 24 h, read-only). One
                message to sign — no transaction, no fee, nothing moves — and the token stays in this
                tab. Signing starts a new conversation.
              </p>
              <div className="assistant-panel__offer-actions">
                <button type="button" className="btn btn-primary" onClick={authorize} disabled={authorizing} data-testid="assistant-grant-offer-sign">
                  {authorizing ? 'Waiting for your signature…' : 'Sign to allow'}
                </button>
                <button type="button" className="btn" onClick={() => { setGrantDismissed(true); setGrantPrompted(false) }} disabled={authorizing} data-testid="assistant-grant-offer-dismiss">
                  Not now
                </button>
              </div>
            </div>
          )}

          <div className="assistant-panel__thread" ref={threadRef} data-testid="assistant-thread">
            {messages.length === 0 && !sending && (
              <p className="assistant-panel__empty">
                Ask about anything in the app — a screen, a fee, what a wager is waiting on. The
                assistant explains and points you at the right place; it never acts for you.
              </p>
            )}
            {messages.map((message, index) => (
              <Message
                key={`${message.role}-${index}-${message.at ?? index}`}
                message={message}
                onNavigate={onClose}
              />
            ))}
            {lastSources && !sending && (
              <p className="assistant-panel__sources" data-testid="assistant-tool-result">
                Sources:{' '}
                {lastSources.map((r, i) => (
                  <span key={r.key}>
                    {i > 0 ? ' · ' : ''}
                    {r.subject}{' '}
                    <span className={`assistant-panel__chip assistant-panel__chip--${r.status}`}>
                      {r.status === 'read' ? 'read' : 'could not be read'}
                    </span>
                  </span>
                ))}
              </p>
            )}
            {(sending || toolRows.length > 0) && (
              <div className="assistant-panel__progress" data-testid="assistant-tool-progress">
                {toolRows.length > 0 && (
                  <ul className="assistant-panel__progress-list">
                    {toolRows.map((r) => (
                      <li key={r.key} className="assistant-panel__progress-row" data-testid="assistant-tool-progress-row">
                        <span>{r.status === 'pending' ? `Reading ${r.subject}…` : `Read ${r.subject}`}</span>
                        {r.status !== 'pending' && (
                          <span className={`assistant-panel__chip assistant-panel__chip--${r.status}`}>
                            {r.status === 'read' ? 'read' : 'could not be read'}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {sending && <p className="assistant-panel__pending">Thinking…</p>}
              </div>
            )}
          </div>

          {/* Replies are announced POLITELY — a reply is not an alert (area7 constraint 8). */}
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {sending ? 'The assistant is thinking.' : lastReply}
          </div>

          {notice && (
            <p className="assistant-panel__notice" role="status" data-testid="assistant-notice">
              {notice}
            </p>
          )}

          {error && (
            <div className="assistant-panel__error" role="alert" data-testid="assistant-error">
              <p>{error.message}</p>
              {error.state === 'quota' && error.retryAfterSeconds ? (
                <p className="assistant-panel__hint">Try again in about {error.retryAfterSeconds} seconds.</p>
              ) : null}
              {/* The two TERMINAL states offer no retry, because retrying cannot change them. A bare
                  sentence over a still-live composer reads as "try again anyway", so say what this
                  is instead: nothing on this member's side is wrong, and nothing they do here will
                  fix it. */}
              {TERMINAL_STATES.has(error.state) ? (
                <p className="assistant-panel__hint">
                  Nothing is wrong with your account or your key — the assistant is switched off for
                  this app right now, so sending again will get the same answer. Everything else in
                  the app works as usual.
                </p>
              ) : null}
              <div className="assistant-panel__error-actions">
                {error.state === 'unauthorized' ? (
                  <button type="button" className="btn" onClick={authorize} disabled={authorizing}>
                    Authorize again
                  </button>
                ) : error.state === 'key_invalid' ? (
                  <button type="button" className="btn" onClick={() => setKeySheetOpen(true)} data-testid="assistant-error-update-key">
                    Update key
                  </button>
                ) : error.state === 'key_missing' ? (
                  <button type="button" className="btn" onClick={() => setForceChooser(true)}>
                    Choose who answers
                  </button>
                ) : error.state === 'no_grant' ? null : TERMINAL_STATES.has(error.state) ? null : (
                  <>
                    {error.state === 'out_of_credit' && (
                      <a
                        href={GUTTERTOKEN_BILLING_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn assistant-panel__linkbtn"
                        data-testid="assistant-error-top-up"
                      >
                        Top up at GutterToken ↗
                      </a>
                    )}
                    <button type="button" className="btn" onClick={retry} disabled={sending}>
                      Try again
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          <form className="assistant-panel__composer" onSubmit={submit}>
            <label htmlFor="assistant-input" className="sr-only">
              Message the assistant
            </label>
            <textarea
              id="assistant-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, 4000))}
              placeholder="Ask about anything in the app"
              rows={2}
              disabled={sending}
            />
            <div className="assistant-panel__composer-actions">
              <button type="button" className="btn" onClick={forget} disabled={messages.length === 0 || sending}>
                Clear
              </button>
              <button type="submit" className="btn btn-primary" disabled={sending || draft.trim() === ''}>
                Send
              </button>
            </div>
          </form>
        </>
      )}

      <GutterTokenKeySheet open={keySheetOpen} onClose={() => setKeySheetOpen(false)} account={account} onSaved={onKeySaved} />
    </>
  )
}

PanelBody.propTypes = {
  onClose: PropTypes.func.isRequired,
  surface: PropTypes.string,
  membership: PropTypes.shape({ isActive: PropTypes.bool, readable: PropTypes.bool }),
  onRetryMembership: PropTypes.func,
}
