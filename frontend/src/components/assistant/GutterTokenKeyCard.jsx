/**
 * GutterTokenKeyCard (spec 104) — the "GutterToken key" card of the Assistant tab.
 *
 * The key is the member's OWN credential for a third-party service, and this card handles it the
 * way the Protect surfaces handle a hardware wallet: the UI never holds the secret. It reads
 * `hasGutterTokenKey` (a boolean) and a REDACTED hint from the store; the raw key is loaded only
 * inside `lib/assistant` when a request is signed, never by a component. So "Test" asks the store
 * to test the key it holds rather than reading it out to pass it back in.
 *
 * Four things this card says out loud, because each is a fact the member is trusting us with:
 *   · what the key can do (spend their GutterToken balance, from this device, for this account),
 *   · where it lives (this device only — never backed up, never synced, deliberately absent from
 *     `lib/backup/syncedObjects.js`),
 *   · that the "Get a key" link may earn FairWins referral credit (spec 057's disclosure rule: a
 *     revenue path is stated as its own sentence, never implied to be neutral),
 *   · what a test result MEANS — accepted with a model count, refused, or GutterToken unreachable —
 *     three outcomes, never collapsed to a green tick.
 */

import { useCallback, useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { useWallet } from '../../hooks/useWalletManagement'
import AccordionSection from '../account/AccordionSection'
import NavIcon from '../nav/NavIcon'
import * as keyStore from '../../lib/assistant/guttertokenKeyStore'
import { REFERRAL_DISCLOSURE, describeTestOutcome, gutterTokenSignupUrl } from './providerCopy'

/**
 * The redacted form of the stored key, or null. `describeGutterTokenKey` is the only shape of the
 * key a screen may know — the card never loads the clear value, and a store that has one but cannot
 * describe it still reports presence honestly rather than claiming there is no key.
 */
function storedKeyHint(account) {
  const described = keyStore.describeGutterTokenKey(account)
  if (!described.present) return null
  return described.redacted || 'Saved — hidden'
}

export default function GutterTokenKeyCard({ onAddKey, lastOutcome = null }) {
  const { address: account, isConnected } = useWallet()
  const [revision, setRevision] = useState(0)
  const rerender = useCallback(() => setRevision((n) => n + 1), [])
  useEffect(() => keyStore.subscribeGutterTokenKey(rerender), [rerender])

  const [testing, setTesting] = useState(false)
  const [testOutcome, setTestOutcome] = useState(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  void revision

  const connected = Boolean(isConnected && account)
  const hint = connected ? storedKeyHint(account) : null
  const hasKey = hint !== null

  // A save from the sheet is a fresh fact about the key; it replaces whatever the last test said.
  useEffect(() => {
    if (lastOutcome) setTestOutcome(lastOutcome)
  }, [lastOutcome])

  const runTest = useCallback(async () => {
    if (!account || testing) return
    setTesting(true)
    setTestOutcome(null)
    try {
      // The STORE tests its own key: a component that read the clear value out to test it would be
      // the second caller of `loadGutterTokenKey`, which is exactly the thing that must not exist.
      const result = await keyStore.testStoredGutterTokenKey(account)
      setTestOutcome(describeTestOutcome(result))
    } catch (e) {
      setTestOutcome(describeTestOutcome({ ok: false, state: e?.state || 'unreachable', message: e?.message }))
    } finally {
      setTesting(false)
    }
  }, [account, testing])

  const remove = useCallback(() => {
    if (!account) return
    keyStore.removeGutterTokenKey(account)
    setConfirmRemove(false)
    setTestOutcome(null)
    rerender()
  }, [account, rerender])

  const summary = !connected ? 'Connect a wallet' : hasKey ? hint : 'None'

  return (
    <AccordionSection
      id="guttertoken-key"
      title="GutterToken key"
      summary={summary}
      icon={<NavIcon name="key" size={18} />}
      className="guttertoken-key"
      data-testid="guttertoken-key-panel"
    >
      {!connected ? (
        <p role="note">Connect your wallet to add a GutterToken key.</p>
      ) : (
        <>
          <p className="guttertoken-key__lead">
            Your own GutterToken key lets the assistant answer on <strong>your prepaid credits</strong>,
            from this device, without a membership. FairWins is not in the path and charges nothing.
          </p>

          <div className="guttertoken-key__value" data-testid="guttertoken-key-value">
            <span className="guttertoken-key__value-label">Key</span>
            <code className="guttertoken-key__masked">{hasKey ? hint : 'None'}</code>
          </div>

          <div className="guttertoken-key__actions">
            <button type="button" className="btn btn-primary" onClick={onAddKey} data-testid="guttertoken-key-add">
              {hasKey ? 'Replace key' : 'Add key'}
            </button>
            {hasKey && (
              <>
                <button type="button" className="btn" onClick={runTest} disabled={testing} data-testid="guttertoken-key-test">
                  {testing ? 'Testing…' : 'Test'}
                </button>
                {!confirmRemove ? (
                  <button type="button" className="btn" onClick={() => setConfirmRemove(true)} data-testid="guttertoken-key-remove">
                    Remove
                  </button>
                ) : null}
              </>
            )}
          </div>

          {confirmRemove && (
            <div className="guttertoken-key__confirm" role="group" aria-label="Remove this key?" data-testid="guttertoken-key-confirm">
              <p>
                Remove the key from this device? The assistant falls back to the FairWins rail if your
                membership allows it, otherwise it has nothing to answer with. Your GutterToken account
                and balance are untouched.
              </p>
              <div className="guttertoken-key__actions">
                <button type="button" className="btn btn-danger" onClick={remove} data-testid="guttertoken-key-remove-confirm">
                  Remove key
                </button>
                <button type="button" className="btn" onClick={() => setConfirmRemove(false)}>
                  Keep it
                </button>
              </div>
            </div>
          )}

          {testOutcome && (
            <p
              className={`guttertoken-key__outcome guttertoken-key__outcome--${testOutcome.tone}`}
              role="status"
              data-testid="guttertoken-key-outcome"
            >
              {testOutcome.text}
            </p>
          )}

          <div className="guttertoken-key__get">
            <a
              href={gutterTokenSignupUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="guttertoken-key__link"
              data-testid="guttertoken-key-signup"
            >
              Get a key ↗
            </a>
            <span className="guttertoken-key__disclosure">{REFERRAL_DISCLOSURE}</span>
          </div>

          <div className="guttertoken-key__can">
            <h4>What this key can do</h4>
            <ul>
              <li>Spend your GutterToken balance from this device, for this account, when you ask the assistant something.</li>
              <li>It is stored on this device only — never backed up, never synced to another device.</li>
              <li>It is never sent to FairWins. Requests go from this browser straight to GutterToken.</li>
              <li>Remove it here at any time, or revoke it at GutterToken — either one ends its use.</li>
            </ul>
          </div>
        </>
      )}
    </AccordionSection>
  )
}

GutterTokenKeyCard.propTypes = {
  /** Opens the key sheet (add or replace). */
  onAddKey: PropTypes.func.isRequired,
  /** The sheet's last save outcome (`describeTestOutcome` shape), shown as the card's status. */
  lastOutcome: PropTypes.shape({ tone: PropTypes.string, text: PropTypes.string }),
}
