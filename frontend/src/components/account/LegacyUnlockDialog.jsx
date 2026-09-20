/**
 * Unlock a recovered legacy account into a live signer so the app can "act as"
 * it (spec 062 follow-up). Biometric-protected keys unlock with one Face/Touch ID
 * assertion (no input); passphrase-protected keys prompt for the passphrase. On
 * success the chain-bound signer is handed back to the caller,
 * which passes it to CustodyContext.operateAsLegacy — the key stays in memory
 * only, never persisted.
 */

import { useCallback, useState } from 'react'
import PropTypes from 'prop-types'
import { useWallet } from '../../hooks/useWalletManagement'
import { getNetwork } from '../../config/networks'
import { unlockLegacyAccount } from '../../lib/recovery/legacyKeys'
import ActionSheet from './ActionSheet'
import './LegacyKeyRecoveryPanel.css'

const shortAddr = (a) => (a ? `${a.substring(0, 6)}…${a.substring(a.length - 4)}` : '')

export default function LegacyUnlockDialog({ open, entry, onClose, onUnlocked, deps = {} }) {
  const { chainId } = useWallet()
  const [passphrase, setPassphrase] = useState('')
  const [phase, setPhase] = useState('idle') // idle | unlocking
  const [error, setError] = useState(null)

  const isPasskey = entry?.protection === 'passkey'
  const networkName = getNetwork(chainId)?.name || 'this network'

  const close = useCallback(() => {
    if (phase === 'unlocking') return
    setPassphrase('')
    setError(null)
    onClose?.()
  }, [phase, onClose])

  const doUnlock = useCallback(async () => {
    if (!entry) return
    setError(null)
    setPhase('unlocking')
    try {
      const signer = await unlockLegacyAccount({
        entry,
        passphrase,
        // The chain is an ARGUMENT (spec 110): the signer is bound to the chain the member is on
        // when they unlock, and `attachActingSigner` records that same chainId beside it.
        chainId,
        client: deps.client,
        deps,
      })
      setPhase('idle')
      setPassphrase('')
      onUnlocked?.(signer)
    } catch (e) {
      setPhase('idle')
      setError(e.message)
    }
  }, [entry, passphrase, chainId, deps, onUnlocked])

  const busy = phase === 'unlocking'

  return (
    <ActionSheet open={open} onClose={close} title="Use this account" closeDisabled={busy}>
      <div className="recover-step">
        <p>
          Act as <code>{shortAddr(entry?.address)}</code> — the app will sign with this recovered account on{' '}
          {networkName} until you switch back.
        </p>
        {isPasskey ? (
          <>
            <p className="recover-step__hint">Unlock with this device&apos;s biometrics (Face/Touch ID).</p>
            {error && <p role="alert" className="lkr-notice lkr-notice--error">{error}</p>}
            <div className="recover-step__actions">
              <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={doUnlock} disabled={busy}>
                {busy ? 'Confirming…' : 'Unlock with biometrics'}
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="lkr-field">
              <span>Passphrase</span>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => { setPassphrase(e.target.value); setError(null) }}
                autoComplete="off"
                aria-label="Passphrase"
              />
            </label>
            {error && <p role="alert" className="lkr-notice lkr-notice--error">{error}</p>}
            <div className="recover-step__actions">
              <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={doUnlock} disabled={busy || !passphrase}>
                {busy ? 'Unlocking…' : 'Unlock'}
              </button>
            </div>
          </>
        )}
      </div>
    </ActionSheet>
  )
}

LegacyUnlockDialog.propTypes = {
  open: PropTypes.bool,
  entry: PropTypes.object,
  onClose: PropTypes.func,
  onUnlocked: PropTypes.func,
  deps: PropTypes.object,
}
