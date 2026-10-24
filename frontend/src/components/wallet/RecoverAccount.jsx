/**
 * Recovery by address (spec 104, US3).
 *
 * Reached when a passkey ceremony succeeded but the app could not confirm which account the key
 * controls. The member names their account; the CHAIN decides whether they get in.
 *
 * Two things about this screen are load-bearing.
 *
 * The address is a HINT, never a claim. It goes through exactly the same on-chain confirmation a
 * searched candidate takes — the connector re-runs the ceremony and verifies the key against that
 * account's current owner set — which is what stops "type any address" from being a way into
 * somebody else's account. Nothing here is trusted; this form only supplies a place to look.
 *
 * And the three verdicts stay three. `unverified` (we could not reach the network) must never be
 * rendered as `none-found` (there is nothing there): they are reached by different causes and lead
 * to different actions — retry versus recover — and telling a member with a perfectly good account
 * that they have none is the identity equivalent of rendering an unreadable balance as $0.
 */
import { useState, useCallback } from 'react'
import { isValidEthereumAddress } from '../../utils/validation'

/**
 * @param {object} props
 * @param {'none-found'|'unverified'|'not-controller'} props.outcome  what the resolver concluded
 * @param {string} props.reason      member-facing sentence from the resolver — never a raw RPC error
 * @param {boolean} props.busy       a connect attempt is in flight
 * @param {(address: string) => void} props.onSubmit
 * @param {() => void} props.onRetry  re-attempt the sign-in unchanged (the answer to `unverified`)
 * @param {string|null} props.counterfactualAddress  where this key's OWN account would live
 * @param {() => void} props.onAcceptCounterfactual
 * @param {() => void} props.onBack
 */
export default function RecoverAccount({
  outcome,
  reason,
  busy = false,
  counterfactualAddress = null,
  onSubmit,
  onRetry,
  onAcceptCounterfactual,
  onBack,
}) {
  const [address, setAddress] = useState('')
  const [touched, setTouched] = useState(false)

  const trimmed = address.trim()
  const valid = isValidEthereumAddress(trimmed)
  const showFormatError = touched && trimmed.length > 0 && !valid

  const submit = useCallback(
    (e) => {
      e.preventDefault()
      setTouched(true)
      if (!valid || busy) return
      onSubmit(trimmed)
    },
    [valid, busy, onSubmit, trimmed]
  )

  // An unreachable network is the one outcome where doing nothing differently is the right move,
  // so it leads with retry and offers the address as the fallback rather than the other way round.
  const unreachable = outcome === 'unverified'

  return (
    <div className="connect-modal__list" data-testid="recover-account">
      <p className="connect-modal__hint" data-testid="recover-reason">
        {reason}
      </p>

      {unreachable && (
        <button
          type="button"
          className="connect-modal__option"
          disabled={busy}
          onClick={onRetry}
        >
          <span className="connect-modal__option-name">Try again</span>
        </button>
      )}

      {/*
        A member who signed up on another device and has not spent yet is HERE, and their account is
        legitimately not deployed. The address is a deterministic function of the passkey, so it is
        the very address their first device showed them — continuing to it opens no second account.
        Shown as its own choice, with what it is stated plainly, because US2's rule is that an
        unverified address must never be presented as though the app had confirmed it.
      */}
      {counterfactualAddress && (
        <div className="connect-modal__recover-new">
          <p className="connect-modal__recover-help">
            If you have just created this passkey and not yet sent anything, your account exists but
            has not been used on the network. It is always at this address:
          </p>
          <code className="connect-modal__address">{counterfactualAddress}</code>
          <button
            type="button"
            className="connect-modal__option"
            disabled={busy}
            onClick={onAcceptCounterfactual}
          >
            <span className="connect-modal__option-name">Continue to that account</span>
          </button>
        </div>
      )}

      <form onSubmit={submit} className="connect-modal__recover-form">
        <label className="connect-modal__recover-label" htmlFor="recover-account-address">
          {unreachable ? 'Or enter your account address' : 'Enter your account address'}
        </label>
        <input
          id="recover-account-address"
          className="connect-modal__recover-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck="false"
          placeholder="0x…"
          value={address}
          disabled={busy}
          aria-invalid={showFormatError}
          aria-describedby={showFormatError ? 'recover-account-error' : 'recover-account-help'}
          onChange={(e) => setAddress(e.target.value)}
          onBlur={() => setTouched(true)}
        />
        <p id="recover-account-help" className="connect-modal__recover-help">
          We will check on the network that this passkey is one of that account&apos;s owners. You
          will be asked for your passkey once more.
        </p>
        {showFormatError && (
          /* Text, not colour alone (constitution V). */
          <p id="recover-account-error" className="connect-modal__recover-error" role="alert">
            That does not look like an account address — it should start with 0x and be 42
            characters long.
          </p>
        )}
        {/* Enabled whenever a value is present, even a malformed one. A disabled submit is a dead
            control: the member gets no reason, only a button that does nothing — and "why can I not
            press this?" is the question the form exists to answer. Pressing it explains instead. */}
        <button type="submit" className="connect-modal__option" disabled={busy || trimmed.length === 0}>
          <span className="connect-modal__option-name">
            {busy ? 'Checking…' : 'Find my account'}
          </span>
        </button>
      </form>

      <button type="button" className="connect-modal__back" onClick={onBack} disabled={busy}>
        Back
      </button>
    </div>
  )
}
