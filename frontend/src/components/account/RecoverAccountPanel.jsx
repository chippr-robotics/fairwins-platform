/**
 * Wallet-only passkey account recovery (spec 045, US6/FR-014).
 *
 * A user who lost every passkey but linked an external wallet as a controller
 * regains access here: connect that wallet → verify on-chain that it controls
 * the account (`isOwnerAddress`) → create a fresh passkey on this device →
 * authorize it with an ordinary wallet transaction (`addOwnerPublicKey`).
 * No bundler, relayer, or FairWins-operated service is involved — the same
 * calls work from any generic wallet tool (see
 * docs/runbooks/passkey-account-recovery.md).
 *
 * Recovery is rare and high-stakes, so the flow is a guided series of bottom
 * sheets that explain each step as it happens (mirroring the connect surface),
 * uses the app's standard address entry (paste / address book / QR scan), and
 * turns the raw ethers/WebAuthn failures testers hit into plain-language,
 * actionable guidance instead of an error boundary.
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import PropTypes from 'prop-types'
import { encodeFunctionData } from 'viem'
import { readContract, normalizeAbi } from '../../lib/chains/readContract'
import { getAddress } from '../../lib/evm/address'
import { useWallet } from '../../hooks/useWalletManagement'
import { getNetwork } from '../../config/networks'
import {
  createCredential,
  rememberCredential,
  knownCredentials,
  detectCapability,
  CeremonyCancelled,
} from '../../lib/passkey/credentials'
import AddressInput from '../ui/AddressInput'
import AddressBookButton from '../ui/AddressBookButton'
import QRScanner from '../ui/QRScanner'
import { extractAddressFromScan } from '../../lib/addressBook/scanAddress'
import ActionSheet from './ActionSheet'
import AccordionSection from './AccordionSection'
import './RecoverAccountPanel.css'

// Human-readable fragments for the vendored Coinbase Smart Wallet MultiOwnable
// surface (ethers v6 signer path — the wallet talks to the account directly).
const RECOVERY_ABI = [
  'function isOwnerAddress(address owner) view returns (bool)',
  'function addOwnerPublicKey(bytes32 x, bytes32 y)',
]

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const isHexAddress = (s) => ADDRESS_RE.test((s || '').trim())
const shortAddr = (a) => (a ? `${a.substring(0, 6)}…${a.substring(a.length - 4)}` : '')

// User-facing guide for how passkey account recovery via a linked wallet works.
const RECOVERY_DOCS_URL = 'https://docs.FairWins.app/user-guide/account-recovery/'

const STEP_TITLES = {
  intro: 'Recover your account',
  account: 'Which account?',
  confirm: 'Create your new passkey',
  done: 'Recovery complete',
}

function RecoverAccountPanel({ deps = {}, defaultOpen = false }) {
  const { address: walletAddress, signer, provider, loginMethod, isConnected, chainId } = useWallet()

  const [open, setOpen] = useState(false)
  const [step, setStep] = useState('intro')
  // idle → verifying (account step) | creating → submitting (confirm step)
  const [phase, setPhase] = useState('idle')
  const [notice, setNotice] = useState(null)
  const [accountInput, setAccountInput] = useState('')
  const [accountResolved, setAccountResolved] = useState('')
  const [scanOpen, setScanOpen] = useState(false)
  const [capability, setCapability] = useState(null)

  const networkName = useMemo(() => getNetwork(chainId)?.name || 'this network', [chainId])

  // The account we act on: a resolved address (ENS/callsign/book/QR) wins,
  // otherwise the raw pasted value.
  const target = useMemo(() => {
    const r = (accountResolved || '').trim()
    if (isHexAddress(r)) return r
    return accountInput.trim()
  }, [accountResolved, accountInput])

  // Local hints: addresses this browser has ever associated with a passkey.
  const hints = useMemo(() => {
    const seen = new Set()
    return (deps.knownCredentials ?? knownCredentials)()
      .map((c) => c.address)
      .filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()))
  }, [deps.knownCredentials])

  // Probe passkey capability once the wizard opens so we can warn honestly
  // BEFORE the member invests effort verifying ownership (testers reached the
  // final step in an in-app browser only to hit "Passkeys are not available").
  useEffect(() => {
    if (!open) return undefined
    let cancelled = false
    Promise.resolve((deps.detectCapability ?? detectCapability)())
      .then((c) => {
        if (!cancelled) setCapability(c)
      })
      .catch(() => {
        if (!cancelled) setCapability({ available: false, reason: 'Passkey support could not be confirmed.' })
      })
    return () => {
      cancelled = true
    }
  }, [open, deps.detectCapability])

  const resetWizard = useCallback(() => {
    setStep('intro')
    setPhase('idle')
    setNotice(null)
    setAccountInput('')
    setAccountResolved('')
    setScanOpen(false)
  }, [])

  const openWizard = useCallback(() => {
    resetWizard()
    setOpen(true)
  }, [resetWizard])

  const closeWizard = useCallback(() => {
    // Never yank the sheet out from under an in-flight ceremony/transaction.
    if (phase === 'creating' || phase === 'submitting') return
    setOpen(false)
  }, [phase])

  const applyAddress = useCallback((addr) => {
    setAccountInput(addr)
    setAccountResolved(addr)
    setNotice(null)
  }, [])

  const handleScan = useCallback(
    (decodedText) => {
      const addr = extractAddressFromScan(decodedText)
      if (addr) applyAddress(addr)
      setScanOpen(false)
    },
    [applyAddress]
  )

  const verify = useCallback(async () => {
    setNotice(null)
    setPhase('verifying')
    try {
      const prov = deps.provider ?? provider
      // Preflight: a counterfactual/undeployed account (or the wrong network)
      // returns empty calldata, which surfaced to testers as the cryptic
      // "could not decode result data (value=\"0x\" … isOwnerAddress) BAD_DATA".
      // Catch it here with a plain explanation instead.
      if (prov?.getCode) {
        const code = await prov.getCode(target)
        if (!code || code === '0x') {
          setPhase('idle')
          setNotice({
            kind: 'error',
            text: `No passkey account is deployed at that address on ${networkName}. Recovery only works on the network where your account lives — switch networks (top-right of the app), and double-check you pasted the account address (not a wallet address).`,
          })
          return
        }
      }
      const isOwner = await readContract(chainId, {
        address: target,
        abi: RECOVERY_ABI,
        functionName: 'isOwnerAddress',
        args: [getAddress(String(walletAddress))],
      })
      if (!isOwner) {
        setPhase('idle')
        setNotice({
          kind: 'error',
          text: 'The connected wallet is not a controller of that account. Recovery needs the wallet you linked as a controller while you still had passkey access.',
        })
        return
      }
      setPhase('idle')
      setNotice(null)
      setStep('confirm')
    } catch (e) {
      setPhase('idle')
      // "The address answered, but not like a passkey account." ethers said `BAD_DATA` /
      // "could not decode result data"; viem raises `ContractFunctionZeroDataError` and says the
      // function "returned no data". Both spellings are matched, because this branch is the
      // difference between a sentence a member can act on and the read library's diagnostic —
      // which is the member-facing defect this PR already had to fix once, on the screening list.
      const zeroData =
        e?.name === 'ContractFunctionZeroDataError' ||
        e?.cause?.name === 'ContractFunctionZeroDataError' ||
        /returned no data/i.test(e?.shortMessage || e?.message || '')
      const badData =
        zeroData || e?.code === 'BAD_DATA' || /BAD_DATA|could not decode/i.test(e?.message || '')
      setNotice({
        kind: 'error',
        text: badData
          ? `That address doesn't respond like a FairWins passkey account on ${networkName}. Make sure you're on the right network and that you pasted the account address (not a wallet address).`
          : `Could not verify that account on ${networkName}: ${e.reason || e.shortMessage || e.message}`,
      })
    }
  }, [target, walletAddress, provider, deps.provider, networkName, chainId])

  const recover = useCallback(async () => {
    setNotice(null)
    setPhase('creating')
    let credential
    try {
      credential = await (deps.createCredential ?? createCredential)({ label: 'Recovered device', deps })
    } catch (e) {
      setPhase('idle')
      if (e instanceof CeremonyCancelled || e?.name === 'CeremonyCancelled') return // clean abort
      const unavailable = e?.name === 'AuthenticatorUnavailable'
      setNotice({
        kind: 'error',
        text: unavailable
          ? `${e.message}. This usually happens inside in-app browsers — open fairwins.app in your device's default browser (Safari or Chrome) and run recovery again.`
          : e.message,
      })
      return
    }
    try {
      setPhase('submitting')
      const tx = await (deps.signer ?? signer).sendTransaction({
        to: target,
        data: encodeFunctionData({
          abi: normalizeAbi(RECOVERY_ABI),
          functionName: 'addOwnerPublicKey',
          args: [credential.publicKey.x, credential.publicKey.y],
        }),
      })
      const receipt = await tx.wait()
      if (receipt?.status !== 1) throw new Error('transaction reverted')
      // Only now is the credential a real controller — record it so passkey
      // sign-in works immediately (spec 045 FR-005).
      rememberCredential({ ...credential, address: target }, deps.storage)
      setPhase('idle')
      setStep('done')
    } catch (e) {
      setPhase('idle')
      setNotice({ kind: 'error', text: `Authorizing the new passkey failed: ${e.reason || e.shortMessage || e.message}` })
    }
  }, [target, signer, deps])

  // Wallet-session only: a passkey session manages controllers in the
  // Controllers panel instead; disconnected visitors must connect first.
  if (!isConnected || loginMethod === 'passkey') return null

  const busy = phase === 'creating' || phase === 'submitting'
  const passkeyBlocked = capability && capability.available === false

  return (
    <>
      <AccordionSection
        id="recover-account"
        title="Recover a passkey account"
        summary="Use this wallet to authorize a new passkey"
        defaultOpen={defaultOpen}
        className="recover-account-panel"
      >
        <p className="section-description">
          Lost your passkeys? If this wallet was linked to your passkey account as a controller, it can
          authorize a new passkey — no FairWins involvement required.{' '}
          <a href={RECOVERY_DOCS_URL} target="_blank" rel="noopener noreferrer">
            Learn how account recovery works →
          </a>
        </p>
        <button type="button" className="btn btn-primary recover-account-panel__start" onClick={openWizard}>
          Recover an account
        </button>
      </AccordionSection>

      {/* The wizard lives outside the collapsible region so it is never inside an inert subtree. */}
      <ActionSheet open={open} onClose={closeWizard} title={STEP_TITLES[step]} closeDisabled={busy}>
        {/* Step 1 — what this does + prerequisites, checked while it's fresh. */}
        {step === 'intro' && (
          <div className="recover-step">
            <p>
              You&apos;re signed in with a wallet. If this wallet was linked as a controller of a passkey
              account, you can authorize a brand-new passkey on this device — FairWins is never involved,
              and it takes one wallet transaction.
            </p>
            <ol className="recover-step__list">
              <li>Tell us which passkey account you&apos;re recovering.</li>
              <li>We confirm on-chain that this wallet controls it.</li>
              <li>Create a new passkey and authorize it with one transaction.</li>
            </ol>
            <div className="recover-step__meta">
              <span className="recover-step__chip" title={walletAddress}>
                Wallet {shortAddr(walletAddress)}
              </span>
              <span className="recover-step__chip">{networkName}</span>
            </div>
            {passkeyBlocked && (
              <p className="recover-step__warn" role="status">
                ⚠ This browser can&apos;t create passkeys{capability?.reason ? ` (${capability.reason})` : ''}. You
                can still verify ownership, but to finish you&apos;ll need to open fairwins.app in your
                device&apos;s default browser (Safari or Chrome).
              </p>
            )}
            <p className="recover-step__hint">
              <a href={RECOVERY_DOCS_URL} target="_blank" rel="noopener noreferrer">
                Learn how account recovery works →
              </a>
            </p>
            <div className="recover-step__actions">
              <button type="button" className="btn" onClick={closeWizard}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setStep('account')}>
                Get started
              </button>
            </div>
          </div>
        )}

        {/* Step 2 — standard address entry (paste / address book / QR). */}
        {step === 'account' && (
          <div className="recover-step">
            <p>
              Enter the passkey account you&apos;re recovering. Paste the address, pick it from your address
              book, or scan a QR code.
            </p>
            <div className="recover-step__address-row">
              <div className="recover-step__address-wrap">
                <AddressInput
                  id="recover-account-address"
                  label="Passkey account address"
                  value={accountInput}
                  onChange={(e) => {
                    setAccountInput(e.target.value)
                    setNotice(null)
                  }}
                  onResolvedChange={(addr) => setAccountResolved(addr || '')}
                  chainId={chainId}
                  placeholder="0x… account to recover"
                  disabled={phase === 'verifying'}
                />
              </div>
              <AddressBookButton
                disabled={phase === 'verifying'}
                onSelect={(entry) => applyAddress(entry.address)}
              />
              <button
                type="button"
                className="recover-step__scan-btn"
                onClick={() => setScanOpen(true)}
                disabled={phase === 'verifying'}
                title="Scan QR code"
                aria-label="Scan QR code"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm10-2h2v2h-2v-2zm4 0h2v2h-2v-2zm-4 4h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm0 4h2v2h-2v-2z" />
                </svg>
              </button>
            </div>
            <QRScanner isOpen={scanOpen} onClose={() => setScanOpen(false)} onScanSuccess={handleScan} />

            {hints.length > 0 && (
              <div className="recover-step__hints">
                <span>Known on this browser:</span>
                {hints.map((h) => (
                  <button key={h} type="button" className="btn btn-small" onClick={() => applyAddress(h)}>
                    {shortAddr(h)}
                  </button>
                ))}
              </div>
            )}

            <p className="recover-step__meta-line">
              Verifying with wallet <code>{shortAddr(walletAddress)}</code> on {networkName}.
            </p>

            {notice && (
              <p role="alert" className={`recover-step__notice recover-step__notice--${notice.kind}`}>
                {notice.text}
              </p>
            )}

            <div className="recover-step__actions">
              <button type="button" className="btn" onClick={() => setStep('intro')} disabled={phase === 'verifying'}>
                Back
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!isHexAddress(target) || phase === 'verifying'}
                onClick={verify}
              >
                {phase === 'verifying' ? 'Verifying…' : 'Verify ownership'}
              </button>
            </div>
          </div>
        )}

        {/* Step 3 — verified; create + authorize the new passkey. */}
        {step === 'confirm' && (
          <div className="recover-step">
            <p role="status" data-testid="recover-verified" className="recover-step__ok">
              ✓ This wallet controls <code>{shortAddr(target)}</code>.
            </p>
            <p>
              Next, create a new passkey on this device and authorize it with one wallet transaction. After
              it confirms, you can sign in with the new passkey.
            </p>
            {passkeyBlocked && (
              <p className="recover-step__warn" role="status">
                ⚠ This browser can&apos;t create passkeys{capability?.reason ? ` (${capability.reason})` : ''}.
                Open fairwins.app in your device&apos;s default browser (Safari or Chrome) and run recovery
                there to finish.
              </p>
            )}

            {phase === 'creating' && <p className="recover-step__progress">Waiting for your device…</p>}
            {phase === 'submitting' && <p className="recover-step__progress">Authorizing on-chain…</p>}

            {notice && (
              <p role="alert" className={`recover-step__notice recover-step__notice--${notice.kind}`}>
                {notice.text}
              </p>
            )}

            <div className="recover-step__actions">
              <button type="button" className="btn" onClick={() => setStep('account')} disabled={busy}>
                Back
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={recover}>
                {phase === 'creating'
                  ? 'Waiting for your device…'
                  : phase === 'submitting'
                    ? 'Authorizing on-chain…'
                    : 'Create & authorize new passkey'}
              </button>
            </div>
          </div>
        )}

        {/* Step 4 — done. */}
        {step === 'done' && (
          <div className="recover-step">
            <p role="status" className="recover-step__ok">
              ✓ New passkey authorized.
            </p>
            <p>
              Sign out of this wallet, then choose <strong>Passkey</strong> at sign-in to use your new
              passkey on this device.
            </p>
            <div className="recover-step__actions">
              <button type="button" className="btn btn-primary" onClick={closeWizard}>
                Done
              </button>
            </div>
          </div>
        )}
      </ActionSheet>
    </>
  )
}

RecoverAccountPanel.propTypes = {
  deps: PropTypes.object,
  /** Start expanded (the Recovery tab keeps every section collapsed by default). */
  defaultOpen: PropTypes.bool,
}

export default RecoverAccountPanel
