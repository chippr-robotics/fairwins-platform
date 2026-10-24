/**
 * The single connect surface (spec 045, US2/FR-001..FR-004). Every entry
 * point — header button, wallet page, dashboard welcome — opens THIS dialog
 * via WalletContext.openConnectModal(); no other component renders connector
 * choices. Passkey and WalletConnect are featured ahead of browser wallets
 * (all three stay fully supported).
 *
 * Passkey path: first-time explainer (US4) → in-app account picker whenever
 * this browser knows at least one passkey (US3 + issue #849 — Brave/Chromium
 * won't reliably offer the choice, and even a lone recorded passkey must not
 * silently pin the member to index 0) → ceremony pinned to the chosen
 * credential, or a discoverable request for a passkey not yet in the book.
 *
 * Returning members open STRAIGHT on that chooser: when this browser already
 * knows a usable passkey there is nothing to decide on the methods list, so the
 * dialog opens as an unlock prompt (one tap to sign in) instead of methods →
 * Passkey → chooser. The choice itself is untouched — #849's "never guess which
 * account" still holds — and "More sign-in options" reaches every connector.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useWallet } from '../../hooks/useWalletManagement'
import { useConnectorAvailability } from '../../hooks/useConnectorAvailability'
import { getWalletLabel, getWalletIcon } from '../../utils/walletLabel'
import { knownCredentials, isTransactComplete, forgetCredential } from '../../lib/passkey/credentials'
import { hasSeenExplainer, markExplainerSeen } from '../../lib/passkey/explainer'
import { PASSKEY_CONNECTOR_ID } from '../../connectors/passkey'
import PasskeyExplainer from './PasskeyExplainer'
import RecoverAccount from './RecoverAccount'
import './ConnectModal.css'

const TYPE_ORDER = { passkey: 0, walletConnect: 1, injected: 2 }
const FEATURED_TYPES = new Set(['passkey', 'walletConnect'])

const shortAddress = (addr) => (addr ? `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}` : '')

function ConnectModal() {
  // Mount the dialog (and its availability probing) only while open — the
  // provider renders this component app-wide.
  const { isConnectModalOpen } = useWallet()
  if (!isConnectModalOpen) return null
  return <ConnectModalDialog />
}

function ConnectModalDialog() {
  const { isConnectModalOpen, closeConnectModal, connectWallet, connectors, isConnected } = useWallet()
  const availability = useConnectorAvailability()
  // Computed once per opening (the dialog only mounts while open): the passkeys
  // this browser can sign in with right now.
  const knownAccounts = useMemo(() => knownCredentials().filter(isTransactComplete), [])
  const unlockFirst = knownAccounts.length > 0
  const [step, setStep] = useState(unlockFirst ? 'picker' : 'methods') // methods | explainer | picker | recover
  const [pendingId, setPendingId] = useState(null)
  const [error, setError] = useState(null)
  const [pickerAccounts, setPickerAccounts] = useState(knownAccounts)
  // Spec 104: what the resolver concluded when a ceremony succeeded but the account could not be
  // confirmed. Held so the recovery step can say WHICH of the three verdicts it is — "we could not
  // reach the network" and "nothing lists this passkey" lead to different actions, and collapsing
  // them tells a member with a good account that they have none.
  const [unresolved, setUnresolved] = useState(null)
  const dialogRef = useRef(null)

  // "Back to where this opened" — the methods list normally, the unlock chooser
  // for a returning member (who would otherwise be dropped a step BACKWARDS
  // after a cancelled ceremony).
  const reset = useCallback(() => {
    setStep(unlockFirst ? 'picker' : 'methods')
    setPendingId(null)
    setError(null)
    setUnresolved(null)
  }, [unlockFirst])

  const close = useCallback(() => {
    reset()
    closeConnectModal()
  }, [reset, closeConnectModal])

  // A successful connection (from any path, including a parallel surface)
  // closes the dialog — never leave a picker over a connected session.
  useEffect(() => {
    if (isConnected && isConnectModalOpen) close()
  }, [isConnected, isConnectModalOpen, close])

  // Esc closes; focus moves into the dialog on open; Tab/Shift+Tab cycle
  // within the dialog's focusable elements (aria-modal focus trap).
  useEffect(() => {
    if (!isConnectModalOpen) return
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        close()
        return
      }
      if (e.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusables = dialog.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const outside = !dialog.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === first || outside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || outside)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKey)
    dialogRef.current?.focus()
    return () => document.removeEventListener('keydown', handleKey)
  }, [isConnectModalOpen, close])

  const doConnect = useCallback(
    async (connectorId, opts) => {
      setPendingId(connectorId)
      setError(null)
      try {
        await connectWallet(connectorId, opts)
      } catch (err) {
        if (err?.name === 'CeremonyCancelled') {
          // Clean abort — back to an immediately re-attemptable idle state:
          // the unlock chooser for a returning member, the methods list otherwise.
          setStep(unlockFirst ? 'picker' : 'methods')
        } else if (err?.name === 'AccountUnresolved') {
          // Spec 104: the passkey answered, the ACCOUNT did not resolve. This is a recoverable
          // state with a next step, not a failure to report and abandon — the member can name
          // their account, or retry an unreachable network. Deliberately NOT surfaced through
          // `setError`, which renders a red sentence over a screen offering nothing to do.
          setUnresolved({
            outcome: err.outcome,
            reason: err.message,
            credentialId: err.credentialId ?? opts?.credentialId ?? null,
            counterfactualAddress: err.counterfactualAddress ?? null,
          })
          setStep('recover')
        } else {
          setError(err?.message || 'Connection failed. Please try again.')
        }
      } finally {
        setPendingId(null)
      }
    },
    [connectWallet, unlockFirst]
  )

  // Both ways out of the recovery step re-run the sign-in. The ceremony happens again — a passkey
  // assertion is not something to hold on to between attempts — pinned to the credential the first
  // one identified, or discoverable when it did not. Written once so the two cannot drift apart.
  const retrySignIn = useCallback(
    (extra = {}) =>
      doConnect(PASSKEY_CONNECTOR_ID, {
        mode: 'sign-in',
        credentialId: unresolved?.credentialId ?? undefined,
        discoverable: unresolved?.credentialId ? undefined : true,
        ...extra,
      }),
    [doConnect, unresolved]
  )

  // The address is only ever a hint: the connector checks it against the chain.
  const recoverWithAddress = useCallback(
    (accountAddress) => retrySignIn({ accountAddress }),
    [retrySignIn]
  )

  // The member accepting their own not-yet-deployed account, having been shown its address and
  // told what it is. Never inferred — it exists as a flag precisely so the app cannot assume it.
  const acceptCounterfactual = useCallback(
    () => retrySignIn({ acceptCounterfactual: true }),
    [retrySignIn]
  )

  const startPasskey = useCallback(() => {
    const known = knownCredentials().filter(isTransactComplete)
    // Issue #849: whenever this browser knows at least one passkey, present the
    // chooser instead of silently pinning to the first (index 0). The picker
    // lets the member select any known passkey, reach a different one on the
    // device via "Use a different passkey…", or create another account.
    //
    // AN EMPTY BOOK GETS THE CHOOSER TOO, and that is the whole point of this
    // branch no longer existing. It used to skip straight to sign-up, on the
    // reasoning that there was "nothing yet to choose between" — true of THIS
    // BROWSER'S book, and false of the member. A passkey that synced through
    // iCloud/Google (the sync this flow's own explainer advertises) lives on
    // the device while the book is empty, so a member opening FairWins on a new
    // browser was signed UP: a second account, and their funds apparently gone.
    // "Use a different passkey…" was the recovery, and it rendered only here —
    // i.e. nowhere they could reach without first minting the stray account.
    //
    // The site cannot know whether a discoverable credential exists; the
    // authenticator can. So we ask the member rather than guessing, which costs
    // a first-time signer one click and costs a returning one nothing.
    setPickerAccounts(known)
    setStep('picker')
  }, [])

  const handleSelect = useCallback(
    (connector) => {
      if (connector.type === 'passkey' && !hasSeenExplainer()) {
        setStep('explainer')
        return
      }
      if (connector.type === 'passkey') return startPasskey()
      doConnect(connector.id)
    },
    [doConnect, startPasskey]
  )

  const handleExplainerContinue = useCallback(() => {
    markExplainerSeen()
    startPasskey()
  }, [startPasskey])

  const handleExplainerDismiss = useCallback(() => {
    markExplainerSeen()
    setStep('methods')
  }, [])

  const removeStaleAccount = useCallback((credentialId) => {
    forgetCredential(credentialId)
    setPickerAccounts((prev) => prev.filter((c) => c.credentialId !== credentialId))
  }, [])

  const sorted = [...connectors].sort(
    (a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)
  )
  const featured = sorted.filter((c) => FEATURED_TYPES.has(c.type))
  const others = sorted.filter((c) => !FEATURED_TYPES.has(c.type))

  const renderConnectorRow = (connector, { recommended } = {}) => {
    const available = availability.isAvailable(connector)
    const reason = availability.unavailableReason(connector)
    const isThisConnecting = pendingId === connector.id
    return (
      <button
        key={connector.id}
        type="button"
        onClick={() => handleSelect(connector)}
        className={`connect-modal__option ${!available ? 'unavailable' : ''} ${isThisConnecting ? 'connecting' : ''}`}
        disabled={pendingId !== null || !available}
        aria-busy={isThisConnecting}
      >
        <span className="connect-modal__option-icon" aria-hidden="true">
          {getWalletIcon(connector)}
        </span>
        <span className="connect-modal__option-name">{getWalletLabel(connector)}</span>
        {isThisConnecting && <span className="connect-modal__status connecting">Connecting...</span>}
        {!isThisConnecting && !available && (
          <span className="connect-modal__status">{reason || 'Not available'}</span>
        )}
        {!isThisConnecting && available && recommended && (
          <span className="connect-modal__badge">Recommended</span>
        )}
        {!isThisConnecting && available && !recommended && connector.type === 'walletConnect' && (
          <span className="connect-modal__badge">QR Code</span>
        )}
      </button>
    )
  }

  return (
    <div className="connect-modal__backdrop" onClick={close} data-testid="connect-modal-backdrop">
      <div
        className="connect-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Connect to FairWins"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="connect-modal__header">
          <h3>
            {step === 'recover'
              ? 'Find your account'
              : step !== 'picker'
                ? 'Connect to FairWins'
                : unlockFirst
                  ? 'Unlock your account'
                  : 'Choose an account'}
          </h3>
          <button type="button" className="connect-modal__close" onClick={close} aria-label="Close">
            ×
          </button>
        </div>

        {error && (
          <div className="connect-modal__error" role="alert" aria-live="assertive">
            {error}
          </div>
        )}

        {step === 'methods' && (
          <>
            <div className="connect-modal__list" data-testid="connect-options">
              {availability.isChecking ? (
                <div className="connect-modal__loading">Detecting options...</div>
              ) : (
                <>
                  {featured.map((c) => renderConnectorRow(c, { recommended: c.type === 'passkey' }))}
                  {others.length > 0 && (
                    <>
                      <div className="connect-modal__divider" role="separator">
                        More options
                      </div>
                      {others.map((c) => renderConnectorRow(c))}
                    </>
                  )}
                </>
              )}
            </div>
            <div className="connect-modal__footer">
              <p>
                New to Web3 wallets?{' '}
                <a href="https://ethereum.org/en/wallets/" target="_blank" rel="noopener noreferrer">
                  Learn more
                </a>
              </p>
              <p>
                Lost your passkey?{' '}
                <a href="/wallet?tab=security">Recover with a linked wallet</a>
              </p>
            </div>
          </>
        )}

        {step === 'explainer' && (
          <PasskeyExplainer onContinue={handleExplainerContinue} onDismiss={handleExplainerDismiss} />
        )}

        {step === 'recover' && (
          <RecoverAccount
            outcome={unresolved?.outcome}
            reason={unresolved?.reason}
            busy={pendingId !== null}
            counterfactualAddress={unresolved?.counterfactualAddress}
            onSubmit={recoverWithAddress}
            onRetry={retrySignIn}
            onAcceptCounterfactual={acceptCounterfactual}
            onBack={() => {
              setUnresolved(null)
              setStep(unlockFirst ? 'picker' : 'methods')
            }}
          />
        )}

        {step === 'picker' && (
          <div className="connect-modal__list" data-testid="passkey-picker">
            <p className="connect-modal__hint">
              {pickerAccounts.length === 0
                ? 'This browser does not know a passkey yet. If you already have a FairWins passkey — on this device, or synced from another — sign in with it. Otherwise create a new account.'
                : pickerAccounts.length > 1
                  ? 'This browser knows several passkey accounts. Pick the one to sign into — the app never guesses.'
                  : 'Pick a passkey to sign into, use another passkey on this device, or create a new account.'}
            </p>
            {pickerAccounts.map((cred) => (
              <div key={cred.credentialId} className="connect-modal__account-row">
                <button
                  type="button"
                  className="connect-modal__option"
                  disabled={pendingId !== null}
                  onClick={() =>
                    doConnect(PASSKEY_CONNECTOR_ID, { credentialId: cred.credentialId, mode: 'sign-in' })
                  }
                >
                  <span className="connect-modal__option-name">{cred.label || 'Passkey account'}</span>
                  {cred.address && <code className="connect-modal__address">{shortAddress(cred.address)}</code>}
                </button>
                <button
                  type="button"
                  className="connect-modal__forget"
                  onClick={() => removeStaleAccount(cred.credentialId)}
                  aria-label={`Remove ${cred.label || shortAddress(cred.address) || 'this account'} from this browser`}
                  title="Remove from this browser (the passkey itself stays on your device)"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="connect-modal__option connect-modal__option--secondary"
              disabled={pendingId !== null}
              onClick={() => doConnect(PASSKEY_CONNECTOR_ID, { mode: 'sign-in', discoverable: true })}
            >
              {pickerAccounts.length === 0 ? 'I already have a passkey' : 'Use a different passkey…'}
            </button>
            <button
              type="button"
              className="connect-modal__option connect-modal__option--secondary"
              disabled={pendingId !== null}
              onClick={() => doConnect(PASSKEY_CONNECTOR_ID, { mode: 'sign-up' })}
            >
              Create a new account
            </button>
            {/* Always reaches the full connector list — a returning member who
                opened straight on the chooser can still pick WalletConnect or a
                browser wallet from here. */}
            <button type="button" className="connect-modal__back" onClick={() => setStep('methods')}>
              {unlockFirst ? 'More sign-in options' : 'Back'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default ConnectModal
