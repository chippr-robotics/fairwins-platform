/**
 * Legacy key & word-list recovery (Recovery section, spec 062).
 *
 * Members who arrive with an *old* secret — a raw EOA private key or a BIP-39
 * word list — use this to bring that account under FairWins. The flow is a
 * guided series of informational bottom sheets (shared ActionSheet, mirroring
 * RecoverAccountPanel) because handling a raw secret is high-stakes:
 *
 *   intro → enter the key/word list → set a passphrase → SAVED
 *
 * Storing the encrypted secret COMPLETES recovery (the SAVED screen); the secret
 * is encrypted on-device with a passphrase-derived key (lib/recovery/legacyKeys)
 * and never leaves the browser, and the recovery is written to the audit ledger
 * with no key material. From the SAVED screen (or later, from a stored-key row)
 * the member may OPTIONALLY move all supported assets to a smart account and/or
 * save the account to their address book so it is usable across the platform.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import { isAddress } from 'viem'
import { formatUnits } from '../../lib/evm/units'
import { useWallet } from '../../hooks/useWalletManagement'
import { useAddressBook } from '../../hooks/useAddressBook'
import { getNetwork } from '../../config/networks'
import { captureLegacyRecovery } from '../../data/ledger/sources/legacyRecoverySource'
import AddressInput from '../ui/AddressInput'
import AddressBookButton from '../ui/AddressBookButton'
import AccountAvatar from './AccountAvatar'
import ActionSheet from './ActionSheet'
import AccordionSection from './AccordionSection'
import CrossChainRecoveryPanel from './CrossChainRecoveryPanel'
import {
  classifySecret,
  encryptLegacySecret,
  encryptLegacySecretWithPasskey,
  decryptLegacySecret,
  decryptLegacySecretWithPasskey,
  legacyKeyVault,
  quoteAllAssets,
  sweepAllAssets,
} from '../../lib/recovery/legacyKeys'
import { readSession } from '../../connectors/passkey'
import { suggestWords, applySuggestion, currentWord, unknownWordsIn } from '../../lib/recovery/bip39Suggest'
import './LegacyKeyRecoveryPanel.css'

const shortAddr = (a) => (a ? `${a.substring(0, 6)}…${a.substring(a.length - 4)}` : '')
const KIND_LABEL = { privateKey: 'private key', mnemonic: 'word list' }
const kindNoun = (kind) => (kind === 'mnemonic' ? 'word list' : 'private key')

function IconMove() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="lkr-icon">
      <path d="M1 8a.75.75 0 0 1 .75-.75h9.69L8.22 4.03a.75.75 0 1 1 1.06-1.06l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 1 1-1.06-1.06l3.22-3.22H1.75A.75.75 0 0 1 1 8Z" />
    </svg>
  )
}

function IconChains() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="lkr-icon">
      <path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0Z" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="lkr-icon">
      <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z" />
    </svg>
  )
}

const STEP_TITLES = {
  intro: 'Recover a legacy account',
  enter: 'Enter your key or word list',
  secure: 'Secure this key on your device',
  saved: 'Recovery complete',
  transfer: 'Move your funds to a smart account',
  unlock: 'Unlock this key',
  done: 'Funds moved',
}

function LegacyKeyRecoveryPanel({ deps = {}, defaultOpen = false }) {
  const { address: sessionAddress, provider, loginMethod, chainId, isConnected } = useWallet()
  const { findByAddress, addContact, updateContact } = useAddressBook()
  // Stable module import ⇒ the memo is preservable and re-derives only when the
  // signed-in account changes. Tests inject a fake vault via the module mock.
  const vault = useMemo(() => legacyKeyVault(sessionAddress), [sessionAddress])

  const [open, setOpen] = useState(false)
  const [step, setStep] = useState('intro')
  const [phase, setPhase] = useState('idle') // idle | encrypting | quoting | sweeping
  const [notice, setNotice] = useState(null)
  const [stored, setStored] = useState(() => vault.list())
  // Spec 063: which stored account (if any) has its cross-chain "Other chains" scan expanded.
  const [scanAddr, setScanAddr] = useState(null)
  // Stored key queued for deletion — removal drops the only on-device copy, so it confirms in a sheet.
  const [pendingRemoval, setPendingRemoval] = useState(null)

  // Import working state.
  const [rawSecret, setRawSecret] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [passphrase2, setPassphrase2] = useState('')
  const [active, setActive] = useState(null) // { kind, address, secret }

  // Biometric-first protection: when the session is a passkey, protect the key
  // with this device's biometrics (no password); fall back to a passphrase only
  // when biometrics aren't available or the member opts out.
  // Read the session's passkey credential inline (cheap localStorage read) so it
  // always reflects the CURRENT session — a memo keyed on deps.readSession alone
  // went stale across sign-in/out and account switches.
  const sessionCredentialId = (deps.readSession ?? readSession)()?.credentialId || null
  const biometricAvailable = loginMethod === 'passkey' && Boolean(sessionCredentialId)
  const [protectMode, setProtectMode] = useState('passkey') // 'passkey' | 'passphrase'

  // Save-to-address-book state (on the SAVED screen).
  const [bookName, setBookName] = useState('')
  const [bookSaved, setBookSaved] = useState(false)

  // Transfer working state.
  const [destInput, setDestInput] = useState('')
  const [destResolved, setDestResolved] = useState('')
  const [quote, setQuote] = useState(null)
  const [outcomes, setOutcomes] = useState(null)

  // Unlock (stored-key → move funds later).
  const [unlockEntry, setUnlockEntry] = useState(null)
  const [unlockPass, setUnlockPass] = useState('')

  const network = useMemo(() => getNetwork(chainId), [chainId])
  const networkName = network?.name || 'this network'
  const nativeSymbol = network?.nativeCurrency?.symbol || 'the native token'
  const nativeDecimals = network?.nativeCurrency?.decimals ?? 18

  const detected = useMemo(() => classifySecret(rawSecret), [rawSecret])
  const alreadyStored = detected.address ? vault.has(detected.address) : false

  // BIP-39 help: only when the input looks like a word list (not a 0x key).
  const looksLikeWords = rawSecret.trim().length > 0 && !rawSecret.trim().toLowerCase().startsWith('0x')
  const wordSuggestions = useMemo(
    () => (looksLikeWords ? suggestWords(currentWord(rawSecret)) : []),
    [looksLikeWords, rawSecret]
  )
  const unknownWords = useMemo(
    () => (looksLikeWords ? unknownWordsIn(rawSecret) : []),
    [looksLikeWords, rawSecret]
  )
  const pickSuggestion = useCallback((word) => {
    setRawSecret((prev) => applySuggestion(prev, word))
    setNotice(null)
  }, [])

  const destTarget = useMemo(() => {
    const r = (destResolved || '').trim()
    if (isAddress(r)) return r
    const i = destInput.trim()
    return isAddress(i) ? i : ''
  }, [destResolved, destInput])

  const refreshStored = useCallback(() => setStored(vault.list()), [vault])
  useEffect(() => { refreshStored() }, [refreshStored])

  const suggestedDest = useCallback(
    () => (loginMethod === 'passkey' && sessionAddress ? sessionAddress : ''),
    [loginMethod, sessionAddress]
  )

  const resetWizard = useCallback(() => {
    setStep('intro')
    setPhase('idle')
    setNotice(null)
    setRawSecret('')
    setPassphrase('')
    setPassphrase2('')
    setActive(null)
    setBookName('')
    setBookSaved(false)
    setQuote(null)
    setOutcomes(null)
    setUnlockEntry(null)
    setUnlockPass('')
    setProtectMode(biometricAvailable ? 'passkey' : 'passphrase')
    const suggest = suggestedDest()
    setDestInput(suggest)
    setDestResolved(suggest)
  }, [suggestedDest, biometricAvailable])

  const openWizard = useCallback(() => {
    resetWizard()
    setOpen(true)
  }, [resetWizard])

  const busy = phase === 'encrypting' || phase === 'sweeping'

  const closeWizard = useCallback(() => {
    if (phase === 'encrypting' || phase === 'sweeping') return // never yank mid-write
    // Clear any secret material from memory as the sheet closes.
    setRawSecret('')
    setPassphrase('')
    setPassphrase2('')
    setActive(null)
    setUnlockPass('')
    setOpen(false)
  }, [phase])

  const goSecure = useCallback(() => {
    const c = classifySecret(rawSecret)
    if (c.kind !== 'privateKey' && c.kind !== 'mnemonic') {
      setNotice({ kind: 'error', text: "That doesn't look like a private key or a valid word list. Check for typos or missing words." })
      return
    }
    setActive({ kind: c.kind, address: c.address, secret: c.secret })
    setBookName('Recovered account')
    setProtectMode(biometricAvailable ? 'passkey' : 'passphrase')
    setNotice(null)
    setStep('secure')
  }, [rawSecret, biometricAvailable])

  // Encrypt + store, write the audit record, land on SAVED (recovery is now complete).
  // Biometric protection uses a WebAuthn assertion (no passphrase); the passphrase
  // path is the fallback.
  const storeAndContinue = useCallback(async () => {
    if (!active) return
    const usePasskey = protectMode === 'passkey' && biometricAvailable
    if (!usePasskey && passphrase !== passphrase2) {
      setNotice({ kind: 'error', text: 'The two passphrases do not match.' })
      return
    }
    setNotice(null)
    setPhase('encrypting')
    try {
      const entry = usePasskey
        ? await encryptLegacySecretWithPasskey({
            secret: active.secret,
            kind: active.kind,
            address: active.address,
            credentialId: sessionCredentialId,
            deps,
          })
        : await encryptLegacySecret({
            secret: active.secret,
            kind: active.kind,
            address: active.address,
            passphrase,
            deps,
          })
      vault.set(entry)
      refreshStored()
      // Audit WITHOUT key material (address/time/type only). Never breaks recovery.
      try {
        captureLegacyRecovery(sessionAddress, chainId, { recoveredAddress: active.address, source: active.kind })
      } catch { /* audit is best-effort */ }
      setPassphrase('')
      setPassphrase2('')
      setBookSaved(false)
      setPhase('idle')
      setStep('saved')
    } catch (e) {
      setPhase('idle')
      setNotice({ kind: 'error', text: e.message })
    }
  }, [active, protectMode, biometricAvailable, sessionCredentialId, passphrase, passphrase2, deps, vault, refreshStored, sessionAddress, chainId])

  // Save the recovered account to the address book (upsert; usable platform-wide).
  const saveToBook = useCallback(() => {
    if (!active) return
    const notes = `Recovered from legacy ${kindNoun(active.kind)}`
    try {
      const found = findByAddress(active.address, chainId)
      if (found) {
        updateContact(found.contact.id, { nickname: bookName || found.contact.nickname })
      } else {
        addContact({ nickname: bookName || 'Recovered account', addresses: [{ address: active.address, chainId, notes }] })
      }
      setBookSaved(true)
    } catch (e) {
      setNotice({ kind: 'error', text: `Could not save to the address book: ${e.message}` })
    }
  }, [active, bookName, chainId, findByAddress, addContact, updateContact])

  const openTransfer = useCallback(() => {
    setNotice(null)
    setQuote(null)
    setOutcomes(null)
    const suggest = suggestedDest()
    setDestInput(suggest)
    setDestResolved(suggest)
    setStep('transfer')
  }, [suggestedDest])

  const checkBalances = useCallback(async () => {
    if (!active) return
    setNotice(null)
    setPhase('quoting')
    try {
      // Pass the destination so the native-leg fee is estimated against it (a
      // smart-account recipient needs more than the 21k EOA baseline).
      const q = await quoteAllAssets({ kind: active.kind, secret: active.secret, chainId, provider: deps.provider ?? provider, to: destTarget || undefined })
      setQuote(q)
      setPhase('idle')
    } catch (e) {
      setPhase('idle')
      setNotice({ kind: 'error', text: `Could not read balances on ${networkName}: ${e.reason || e.shortMessage || e.message}` })
    }
  }, [active, chainId, provider, deps.provider, networkName, destTarget])

  const doSweep = useCallback(async () => {
    if (!active || !destTarget) return
    setNotice(null)
    setPhase('sweeping')
    setOutcomes([])
    try {
      const results = await sweepAllAssets({
        kind: active.kind,
        secret: active.secret,
        to: destTarget,
        chainId,
        provider: deps.provider ?? provider,
        onProgress: (o) => setOutcomes((prev) => [...(prev || []), o]),
      })
      setOutcomes(results)
      setPhase('idle')
      const anyFail = results.some((r) => r.status === 'failed')
      if (!anyFail) setStep('done')
    } catch (e) {
      setPhase('idle')
      setNotice({ kind: 'error', text: `The transfer could not start: ${e.reason || e.shortMessage || e.message}` })
    }
  }, [active, destTarget, chainId, provider, deps.provider])

  const startTransferStored = useCallback((entry) => {
    resetWizard()
    setUnlockEntry(entry)
    setUnlockPass('')
    setStep('unlock')
    setOpen(true)
  }, [resetWizard])

  const doUnlock = useCallback(async () => {
    if (!unlockEntry) return
    setNotice(null)
    setPhase('encrypting')
    try {
      const secret = unlockEntry.protection === 'passkey'
        ? await decryptLegacySecretWithPasskey({ entry: unlockEntry, deps })
        : await decryptLegacySecret({ entry: unlockEntry, passphrase: unlockPass, deps })
      setActive({ kind: unlockEntry.kind, address: unlockEntry.address, secret })
      setUnlockPass('')
      setPhase('idle')
      openTransfer()
    } catch (e) {
      setPhase('idle')
      setNotice({ kind: 'error', text: e.message })
    }
  }, [unlockEntry, unlockPass, deps, openTransfer])

  const removeStored = useCallback((address) => {
    vault.delete(address)
    refreshStored()
    setPendingRemoval(null)
  }, [vault, refreshStored])

  if (!isConnected) return null

  const noticeEl = notice && (
    <p role="alert" className={`lkr-notice lkr-notice--${notice.kind}`}>{notice.text}</p>
  )

  // Tokens present but no native to pay gas ⇒ nothing can be moved from here.
  const noNativeForGas = Boolean(quote && !quote.hasNative && quote.holdings.length > 0)

  const renderOutcomes = () =>
    outcomes && outcomes.length > 0 && (
      <ul className="lkr-outcomes" aria-label="Transfer results">
        {outcomes.map((o, i) => (
          <li key={`${o.asset.symbol}-${i}`} className={`lkr-outcome lkr-outcome--${o.status}`}>
            <span className="lkr-outcome__sym">{o.asset.symbol}</span>
            <span className="lkr-outcome__status">
              {o.status === 'sent' ? '✓ sent' : o.status === 'skipped' ? 'skipped' : `failed${o.error ? ` — ${o.error}` : ''}`}
            </span>
          </li>
        ))}
      </ul>
    )

  return (
    <>
      <AccordionSection
        id="legacy-recovery"
        title="Legacy key & word-list recovery"
        summary={
          stored.length > 0
            ? `${stored.length} recovered ${stored.length === 1 ? 'account' : 'accounts'} on this device`
            : 'Bring in an old private key or word list'
        }
        defaultOpen={defaultOpen}
        className="legacy-recovery"
      >
        <p className="section-description">
          Moving from an older wallet? Bring in a legacy <strong>private key</strong> or <strong>word list</strong>{' '}
          (recovery phrase). FairWins stores it encrypted on this device; you can then optionally move its funds to
          a smart account and save it to your address book.
        </p>
        <button type="button" className="btn btn-primary legacy-recovery__start" onClick={openWizard}>
          Recover a legacy key
        </button>

        {stored.length > 0 && (
          <ul className="lkr-stored" aria-label="Recovered legacy keys stored on this device">
            {stored.map((e) => {
              const bookName = findByAddress(e.address, chainId)?.contact?.nickname
              const displayName = bookName || 'Recovered account'
              return (
                <li key={e.address} className="lkr-stored__item">
                  <div className="lkr-stored__row">
                    <AccountAvatar address={e.address} size={40} className="lkr-stored__avatar" />
                    <div className="lkr-stored__meta">
                      <span className="lkr-stored__kind">Recovered</span>
                      <span className="lkr-stored__name">{displayName}</span>
                      <code className="lkr-stored__addr" title={e.address}>{shortAddr(e.address)}</code>
                      <span className="lkr-stored__sub">
                        {KIND_LABEL[e.kind] || 'key'}
                        {e.importedAt ? ` · saved ${new Date(e.importedAt).toLocaleDateString()}` : ''}
                      </span>
                    </div>
                  </div>
                  <div className="lkr-stored__actions">
                    <button
                      type="button"
                      className="lkr-action-btn"
                      onClick={() => startTransferStored(e)}
                    >
                      <IconMove />
                      <span className="lkr-action-btn__label">Move funds</span>
                    </button>
                    {e.kind === 'mnemonic' && (
                      <button
                        type="button"
                        className="lkr-action-btn"
                        onClick={() => setScanAddr(scanAddr === e.address ? null : e.address)}
                        aria-expanded={scanAddr === e.address}
                      >
                        <IconChains />
                        <span className="lkr-action-btn__label">Other chains</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="lkr-action-btn lkr-action-btn--danger"
                      onClick={() => setPendingRemoval(e)}
                      aria-haspopup="dialog"
                      aria-label={`Remove stored key ${displayName}`}
                    >
                      <IconTrash />
                      <span className="lkr-action-btn__label">Remove</span>
                    </button>
                  </div>
                  {scanAddr === e.address && e.kind === 'mnemonic' && (
                    <CrossChainRecoveryPanel entry={e} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </AccordionSection>

      <ActionSheet open={open} onClose={closeWizard} title={STEP_TITLES[step]} closeDisabled={busy}>
        {/* Step 1 — what this does + the honest warning. */}
        {step === 'intro' && (
          <div className="recover-step">
            <p>
              Recover an account from a legacy <strong>private key</strong> or <strong>word list</strong>. FairWins
              stores it encrypted on this device; moving its funds to a smart account is an optional next step.
            </p>
            <ol className="recover-step__list">
              <li>Paste the private key or word list — we detect which it is.</li>
              <li>Choose a passphrase so we can store it encrypted on this device.</li>
              <li>Optionally move its funds to a smart account and save it to your address book.</li>
            </ol>
            <p className="recover-step__warn" role="note">
              ⚠ Only paste a key you own. Anyone with this secret controls that account — treat it like cash. We
              never send it anywhere; it stays encrypted on this device.
            </p>
            <div className="recover-step__actions">
              <button type="button" className="btn" onClick={closeWizard}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => { setNotice(null); setStep('enter') }}>
                Get started
              </button>
            </div>
          </div>
        )}

        {/* Step 2 — enter + live detection. */}
        {step === 'enter' && (
          <div className="recover-step">
            <p>Paste your private key (starts with <code>0x</code>) or your recovery word list (12–24 words).</p>
            <textarea
              className="lkr-secret-input"
              value={rawSecret}
              onChange={(e) => { setRawSecret(e.target.value); setNotice(null) }}
              placeholder="0x… private key, or your 12–24 recovery words separated by spaces"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              aria-label="Private key or recovery word list"
            />
            {wordSuggestions.length > 0 && (
              <div className="lkr-suggest" role="group" aria-label="Word suggestions">
                {wordSuggestions.map((w) => (
                  <button key={w} type="button" className="lkr-suggest__chip" onClick={() => pickSuggestion(w)}>
                    {w}
                  </button>
                ))}
              </div>
            )}
            {unknownWords.length > 0 && detected.kind !== 'mnemonic' && (
              <p className="lkr-notice lkr-notice--warn" role="status">
                Not in the recovery word list: <strong>{unknownWords.join(', ')}</strong>. Check for a typo.
              </p>
            )}
            {detected.kind === 'privateKey' || detected.kind === 'mnemonic' ? (
              <p className="recover-step__ok" role="status" data-testid="lkr-detected">
                ✓ Detected a {KIND_LABEL[detected.kind]} for account <code>{shortAddr(detected.address)}</code>.
                {alreadyStored && ' This account is already stored — continuing will replace it.'}
              </p>
            ) : detected.kind === 'invalid' ? (
              <p className="lkr-notice lkr-notice--warn" role="status">
                Not a recognizable key yet — keep typing, or check for a missing/mistyped word.
              </p>
            ) : null}
            {noticeEl}
            <div className="recover-step__actions">
              <button type="button" className="btn" onClick={() => setStep('intro')}>Back</button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={detected.kind !== 'privateKey' && detected.kind !== 'mnemonic'}
                onClick={goSecure}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 3 — protect at rest: biometrics first, passphrase fallback. */}
        {step === 'secure' && (
          <div className="recover-step">
            {protectMode === 'passkey' && biometricAvailable ? (
              <>
                <p>
                  Protect this {active ? KIND_LABEL[active.kind] : 'key'} with <strong>this device&apos;s
                  biometrics</strong> (Face/Touch ID). No password to remember — only this passkey can unlock it,
                  and it stays encrypted on this device.
                </p>
                <p className="recover-step__hint">
                  Uses the same passkey you sign in with. If you replace this device, unlock again there or
                  re-import your original {active ? KIND_LABEL[active.kind] : 'key'}.
                </p>
                {noticeEl}
                <div className="recover-step__actions">
                  <button type="button" className="btn" onClick={() => setStep('enter')} disabled={busy}>Back</button>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={storeAndContinue}>
                    {phase === 'encrypting' ? 'Confirming…' : 'Protect with biometrics'}
                  </button>
                </div>
                <p className="lkr-alt">
                  <button type="button" className="lkr-linkbtn" onClick={() => { setNotice(null); setProtectMode('passphrase') }}>
                    Use a passphrase instead
                  </button>
                </p>
              </>
            ) : (
              <>
                <p>
                  Choose a passphrase to encrypt this {active ? KIND_LABEL[active.kind] : 'key'} on this device. You
                  will need it to move funds later. <strong>We can&apos;t reset it</strong> — if you forget it, the
                  stored copy is unrecoverable (your original key still works). You can save it in your password
                  manager.
                </p>
                {/* Hidden identity hint so password managers offer to save this passphrase against the account. */}
                <input
                  type="text"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  autoComplete="username"
                  value={active?.address || ''}
                  readOnly
                />
                <label className="lkr-field">
                  <span>Passphrase</span>
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => { setPassphrase(e.target.value); setNotice(null) }}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                  />
                </label>
                <label className="lkr-field">
                  <span>Confirm passphrase</span>
                  <input
                    type="password"
                    value={passphrase2}
                    onChange={(e) => { setPassphrase2(e.target.value); setNotice(null) }}
                    autoComplete="new-password"
                  />
                </label>
                {noticeEl}
                <div className="recover-step__actions">
                  <button type="button" className="btn" onClick={() => setStep('enter')} disabled={busy}>Back</button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || passphrase.length < 8 || passphrase !== passphrase2}
                    onClick={storeAndContinue}
                  >
                    {phase === 'encrypting' ? 'Encrypting…' : 'Encrypt & save'}
                  </button>
                </div>
                {biometricAvailable && (
                  <p className="lkr-alt">
                    <button type="button" className="lkr-linkbtn" onClick={() => { setNotice(null); setProtectMode('passkey') }}>
                      Use this device&apos;s biometrics instead
                    </button>
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* Step 4 — SAVED: recovery is complete. Optional follow-ups only. */}
        {step === 'saved' && (
          <div className="recover-step">
            <p role="status" className="recover-step__ok" data-testid="lkr-saved">
              ✓ Recovered. <code>{shortAddr(active?.address)}</code> is stored encrypted on this device.
            </p>
            <p>Recovery is complete. These next steps are optional.</p>

            <div className="lkr-saved-action">
              <p className="lkr-saved-action__title">Save to your address book</p>
              <p className="lkr-saved-action__hint">Makes this account available everywhere you pick an address.</p>
              {bookSaved ? (
                <p className="recover-step__ok" role="status">✓ Saved to your address book.</p>
              ) : (
                <div className="lkr-book-row">
                  <input
                    type="text"
                    className="lkr-book-name"
                    value={bookName}
                    onChange={(e) => setBookName(e.target.value)}
                    aria-label="Address book name"
                    placeholder="Name for this account"
                  />
                  <button type="button" className="btn" onClick={saveToBook}>Save to address book</button>
                </div>
              )}
            </div>

            <div className="lkr-saved-action">
              <p className="lkr-saved-action__title">Move funds to a smart account</p>
              <p className="lkr-saved-action__hint">
                Recommended — a smart account supports passkeys, recovery, and gasless actions. Moves all supported
                assets ({nativeSymbol} and tokens).
              </p>
            </div>

            {noticeEl}

            <div className="recover-step__actions">
              <button type="button" className="btn" onClick={closeWizard}>Done</button>
              <button type="button" className="btn btn-primary" onClick={openTransfer}>Move funds</button>
            </div>
          </div>
        )}

        {/* Step 3b — unlock a previously stored key before moving funds. */}
        {step === 'unlock' && (
          <div className="recover-step">
            {unlockEntry?.protection === 'passkey' ? (
              <>
                <p>
                  Unlock <code>{shortAddr(unlockEntry?.address)}</code> with <strong>this device&apos;s
                  biometrics</strong> to move its funds.
                </p>
                {noticeEl}
                <div className="recover-step__actions">
                  <button type="button" className="btn" onClick={closeWizard} disabled={busy}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={doUnlock}>
                    {phase === 'encrypting' ? 'Confirming…' : 'Unlock with biometrics'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>Enter the passphrase for <code>{shortAddr(unlockEntry?.address)}</code> to move its funds.</p>
                <label className="lkr-field">
                  <span>Passphrase</span>
                  <input
                    type="password"
                    value={unlockPass}
                    onChange={(e) => { setUnlockPass(e.target.value); setNotice(null) }}
                    autoComplete="off"
                    aria-label="Passphrase"
                  />
                </label>
                {noticeEl}
                <div className="recover-step__actions">
                  <button type="button" className="btn" onClick={closeWizard} disabled={busy}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={busy || !unlockPass} onClick={doUnlock}>
                    {phase === 'encrypting' ? 'Unlocking…' : 'Unlock'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Step 5 — move ALL supported assets to a smart account (optional). */}
        {step === 'transfer' && (
          <div className="recover-step">
            <p>
              Move the supported assets held by <code>{shortAddr(active?.address)}</code> to a smart account. Send
              them to the account below.
            </p>
            <div className="recover-step__address-row">
              <div className="recover-step__address-wrap">
                <AddressInput
                  id="lkr-destination"
                  label="Destination smart account"
                  value={destInput}
                  onChange={(e) => { setDestInput(e.target.value); setNotice(null) }}
                  onResolvedChange={(addr) => setDestResolved(addr || '')}
                  chainId={chainId}
                  placeholder="0x… smart account to receive funds"
                  disabled={busy}
                />
              </div>
              <AddressBookButton disabled={busy} onSelect={(entry) => { setDestInput(entry.address); setDestResolved(entry.address) }} />
            </div>

            <div className="recover-step__actions">
              <button type="button" className="btn" onClick={checkBalances} disabled={phase !== 'idle' || !destTarget}>
                {phase === 'quoting' ? 'Checking…' : 'Check balances'}
              </button>
            </div>

            {quote && (
              <div className="lkr-quote" role="status">
                {quote.holdings.length === 0 ? (
                  <p className="lkr-quote__empty">No supported-asset balances found on {networkName} for this account.</p>
                ) : (
                  <>
                    {quote.holdings.map((h) => (
                      <div key={h.asset.id || h.asset.symbol}>
                        <span>{h.asset.symbol}</span>
                        <strong>{formatUnits(h.balance, h.asset.decimals ?? 18)}</strong>
                      </div>
                    ))}
                    {quote.hasNative && (
                      <div className="lkr-quote__fee">
                        <span>Estimated network fee</span>
                        <strong>≈ {formatUnits(quote.nativeGasReserve ?? 0n, nativeDecimals)} {nativeSymbol}</strong>
                      </div>
                    )}
                  </>
                )}
                {noNativeForGas && (
                  <p className="lkr-quote__empty">
                    This account has no {nativeSymbol} to pay network fees, so its tokens can&apos;t be moved from here.
                    Send a little {nativeSymbol} to <code>{shortAddr(active?.address)}</code> first, then check balances again.
                  </p>
                )}
              </div>
            )}

            <p className="recover-step__meta-line">
              Only platform-supported assets ({nativeSymbol} + supported tokens) are moved — collectibles/NFTs are
              not. The legacy key pays the network fee from its {nativeSymbol}. Checked on {networkName}.
            </p>

            {renderOutcomes()}
            {noticeEl}

            <div className="recover-step__actions">
              <button type="button" className="btn" onClick={closeWizard} disabled={busy}>
                {outcomes && outcomes.length ? 'Close' : 'Do this later'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !destTarget || !quote || quote.holdings.length === 0 || noNativeForGas}
                onClick={doSweep}
              >
                {phase === 'sweeping' ? 'Transferring…' : 'Transfer all'}
              </button>
            </div>
          </div>
        )}

        {/* Step 6 — done (all assets moved with no failure). */}
        {step === 'done' && (
          <div className="recover-step">
            <p role="status" className="recover-step__ok">✓ Funds moved to your smart account.</p>
            {renderOutcomes()}
            <p>
              Your legacy key stays encrypted on this device in case you need it again — remove it from the Recovery
              list once you&apos;re sure it&apos;s empty.
            </p>
            <div className="recover-step__actions">
              <button type="button" className="btn btn-primary" onClick={closeWizard}>Done</button>
            </div>
          </div>
        )}
      </ActionSheet>

      {/* Deleting the on-device copy of a legacy key is irreversible from here — confirm it. */}
      <ActionSheet
        open={Boolean(pendingRemoval)}
        onClose={() => setPendingRemoval(null)}
        title="Remove this recovered key?"
        closeDisabled={busy}
      >
        <p className="action-sheet__text">
          The encrypted copy stored on this device is deleted. Anything still held by this account stays where it
          is — you would need the original private key or word list to reach it again.
        </p>
        {pendingRemoval?.address && <code className="action-sheet__addr">{pendingRemoval.address}</code>}
        <div className="action-sheet__actions">
          <button type="button" className="btn" onClick={() => setPendingRemoval(null)}>Keep it</button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => removeStored(pendingRemoval.address)}
          >
            Remove key
          </button>
        </div>
      </ActionSheet>
    </>
  )
}

LegacyKeyRecoveryPanel.propTypes = {
  deps: PropTypes.object,
  /** Start expanded (the Recovery tab keeps every section collapsed by default). */
  defaultOpen: PropTypes.bool,
}

export default LegacyKeyRecoveryPanel
