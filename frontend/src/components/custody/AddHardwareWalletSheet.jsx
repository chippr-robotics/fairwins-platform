/**
 * Spec 085 — the guided add-a-hardware-wallet flow (FR-002). A step machine in the shared
 * ActionSheet, the same idiom as the legacy-key recovery wizard: one sheet instance whose body
 * switches on `step`:
 *
 *   vendor → connect → pick → saved
 *
 * The vendor step disables what the browser cannot do, with the reason (FR-003). The connect step
 * owns the device ceremony and renders every failure as a stated, human outcome (FR-012). The pick
 * step pages through derived accounts — address + native balance per row — across both derivation
 * schemes (FR-004). Saving persists public metadata only, upserts the address book, captures the
 * audit record, and toasts (FR-005/006/007).
 */

import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { formatEther } from '../../lib/evm/units'
import ActionSheet from '../account/ActionSheet'
import { useWallet } from '../../hooks/useWalletManagement'
// UIContext read with a no-op fallback — see HardwareWalletSection.
import { UIContext } from '../../contexts/UIContext'
import { useAddressBook } from '../../hooks/useAddressBook'
// Strict lookup, deliberately not getNetwork(): that helper falls back to the default network,
// which would label another chain's balances with the wrong symbol (specs 068/071 guardrail).
import { NETWORKS } from '../../config/networks'
import { getReadProvider } from '../../utils/rpcProvider'
import { connectHardware, vendorAvailability, VENDOR_LABELS } from '../../lib/hardware/adapters'
// Connect copy is DERIVED from the transport the adapter would open — a phone pairing over
// Bluetooth must never be told to plug anything in (spec 085 follow-up).
import { connectGuidance } from '../../lib/hardware/connectCopy'
import { reportHardwareError } from '../../lib/hardware/errors'
import { defaultSchemeFor, pagePaths, PATH_SCHEMES } from '../../lib/hardware/derivations'
import { hardwareWalletVault } from '../../lib/hardware/hardwareAccounts'
import { captureHardwareAccountAdded } from '../../data/ledger/sources/hardwareWalletSource'
import './HardwareWallet.css'

const PAGE_SIZE = 5

const STEP_TITLES = {
  vendor: 'Add a hardware wallet',
  connect: 'Connect your device',
  pick: 'Choose accounts',
  saved: 'Accounts saved',
}

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

/** Format a wei balance for a row: trimmed, honest "—" when unknown. */
const fmtBalance = (wei, symbol) => {
  if (wei == null) return '—'
  const n = Number(formatEther(wei))
  const s = n === 0 ? '0' : n < 0.0001 ? '<0.0001' : n.toFixed(4).replace(/\.?0+$/, '')
  return `${s} ${symbol}`
}

export default function AddHardwareWalletSheet({ open, onClose, onSaved, deps = {} }) {
  const { address: owner, chainId } = useWallet()
  const ui = useContext(UIContext)
  const { findByAddress, addContact, updateContact } = useAddressBook()

  const [step, setStep] = useState('vendor')
  const [vendor, setVendor] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [schemeId, setSchemeId] = useState('bip44')
  const [rows, setRows] = useState([]) // { path, index, address, balance, known }
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState({}) // { [lowerAddress]: true }
  const [label, setLabel] = useState('')
  const [savedEntries, setSavedEntries] = useState([])
  const sessionRef = useRef(null)

  const network = chainId != null ? NETWORKS[chainId] : null
  const symbol = network?.nativeCurrency?.symbol || 'ETH'
  const connectFn = deps.connect ?? connectHardware
  const availability = deps.availability ?? vendorAvailability
  const guidance = deps.guidance ?? connectGuidance

  const releaseSession = useCallback(() => {
    const s = sessionRef.current
    sessionRef.current = null
    if (s) s.close().catch(() => {})
  }, [])

  // Reset to a clean wizard whenever the sheet closes; also release the device transport so other
  // tabs/tools can reach it (the session is the caller's to close — see adapters.js).
  const close = useCallback(() => {
    if (busy) return
    releaseSession()
    setStep('vendor')
    setVendor(null)
    setError(null)
    setRows([])
    setOffset(0)
    setSelected({})
    setLabel('')
    setSavedEntries([])
    onClose?.()
  }, [busy, releaseSession, onClose])

  useEffect(() => () => releaseSession(), [releaseSession])

  const pickVendor = useCallback((v) => {
    setVendor(v)
    setSchemeId(defaultSchemeFor(v))
    setError(null)
    setStep('connect')
  }, [])

  /** Load one page of derived accounts (also the initial load after connect). */
  const loadAccounts = useCallback(
    async (session, sId, from) => {
      const paths = pagePaths(sId, from, PAGE_SIZE).map((p) => p.path)
      const derived = await session.getAddresses(paths)
      const vault = owner ? hardwareWalletVault(owner) : null
      const provider = deps.provider ?? (chainId != null ? getReadProvider(chainId) : null)
      const balances = await Promise.allSettled(
        derived.map((d) => (provider ? provider.getBalance(d.address) : Promise.reject(new Error('no provider')))),
      )
      return derived.map((d, i) => ({
        ...d,
        index: from + i,
        balance: balances[i].status === 'fulfilled' ? balances[i].value : null,
        known: Boolean(vault?.has(d.address)),
      }))
    },
    [owner, chainId, deps.provider],
  )

  const doConnect = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const session = sessionRef.current ?? (await connectFn(vendor))
      sessionRef.current = session
      const page = await loadAccounts(session, schemeId, 0)
      setRows(page)
      setOffset(PAGE_SIZE)
      setStep('pick')
    } catch (e) {
      setError(reportHardwareError(e, 'hardware-add'))
    } finally {
      setBusy(false)
    }
  }, [connectFn, vendor, schemeId, loadAccounts])

  const loadMore = useCallback(async () => {
    if (!sessionRef.current) return
    setError(null)
    setBusy(true)
    try {
      const page = await loadAccounts(sessionRef.current, schemeId, offset)
      setRows((r) => [...r, ...page])
      setOffset((o) => o + PAGE_SIZE)
    } catch (e) {
      setError(reportHardwareError(e, 'hardware-add'))
    } finally {
      setBusy(false)
    }
  }, [loadAccounts, schemeId, offset])

  const switchScheme = useCallback(
    async (sId) => {
      if (sId === schemeId || !sessionRef.current) return
      setSchemeId(sId)
      setSelected({})
      setError(null)
      setBusy(true)
      try {
        const page = await loadAccounts(sessionRef.current, sId, 0)
        setRows(page)
        setOffset(PAGE_SIZE)
      } catch (e) {
        setRows([])
        setError(reportHardwareError(e, 'hardware-add'))
      } finally {
        setBusy(false)
      }
    },
    [schemeId, loadAccounts],
  )

  const toggleRow = useCallback((address) => {
    const key = String(address).toLowerCase()
    setSelected((s) => ({ ...s, [key]: !s[key] }))
  }, [])

  const selectedRows = rows.filter((r) => selected[String(r.address).toLowerCase()])

  const doSave = useCallback(() => {
    if (!owner || selectedRows.length === 0) return
    setError(null)
    try {
      const vault = hardwareWalletVault(owner)
      const saved = []
      for (const row of selectedRows) {
        const rowLabel =
          selectedRows.length === 1 ? label.trim() : label.trim() ? `${label.trim()} ${row.index + 1}` : ''
        const { entry } = vault.add({ address: row.address, vendor, path: row.path, label: rowLabel })
        saved.push(entry)
        // App-wide availability (FR-006): upsert into the address book, usable in every address field.
        try {
          const found = findByAddress(row.address, chainId)
          const nickname = rowLabel || `${VENDOR_LABELS[vendor]} ${short(row.address)}`
          if (found) {
            updateContact(found.contact.id, { nickname })
          } else {
            addContact({
              nickname,
              addresses: [{ address: row.address, chainId, notes: `${VENDOR_LABELS[vendor]} hardware wallet (${row.path})` }],
            })
          }
        } catch {
          /* the address book is additive convenience — a failure must not lose the saved account */
        }
        // Audit (FR-007): metadata only, idempotent per (chain, address).
        try {
          captureHardwareAccountAdded(owner, chainId, { address: row.address, vendor, path: row.path })
        } catch {
          /* audit is best-effort */
        }
      }
      releaseSession()
      setSavedEntries(saved)
      setStep('saved')
      ui?.showNotification?.(
        saved.length === 1
          ? `Hardware account ${short(saved[0].address)} saved.`
          : `${saved.length} hardware accounts saved.`,
        'success',
      )
      onSaved?.(saved)
    } catch (e) {
      setError(e.message)
    }
  }, [owner, selectedRows, label, vendor, chainId, findByAddress, updateContact, addContact, releaseSession, ui, onSaved])

  const vendorStep = (
    <div className="hw-step" data-testid="hw-step-vendor">
      <p className="hw-step__lead">Keep funds on a device whose keys never touch this browser.</p>
      <div className="hw-vendor-options">
        {['ledger', 'trezor'].map((v) => {
          const a = availability(v)
          // The hint names the rail this browser would actually use — USB on a computer,
          // Bluetooth on a phone — or, when there is none, the reason it cannot.
          const hint = a.available ? guidance(v).optionHint : a.reason
          return (
            <button
              key={v}
              type="button"
              className="hw-vendor-option"
              onClick={() => pickVendor(v)}
              disabled={!a.available}
              data-testid={`hw-vendor-${v}`}
            >
              <span className="hw-vendor-option__name">{VENDOR_LABELS[v]}</span>
              <span className="hw-vendor-option__hint">{hint}</span>
            </button>
          )
        })}
      </div>
    </div>
  )

  const connectSteps = vendor ? guidance(vendor).steps : []
  const connectStep = (
    <div className="hw-step" data-testid="hw-step-connect">
      {connectSteps.length > 0 ? (
        <ol className="hw-checklist">
          {connectSteps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      ) : (
        // No rail at all: the stated reason stands in for a checklist that could not succeed.
        <p className="hw-step__lead">{vendor ? guidance(vendor).optionHint : ''}</p>
      )}
      {error && (
        <p role="alert" className="hw-error">
          {error}
        </p>
      )}
      <div className="hw-actions">
        <button type="button" className="btn" onClick={() => { setError(null); setStep('vendor') }} disabled={busy}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={doConnect} disabled={busy} data-testid="hw-connect">
          {busy ? 'Looking for the device…' : `Connect ${VENDOR_LABELS[vendor] || ''}`}
        </button>
      </div>
    </div>
  )

  const pickStep = (
    <div className="hw-step" data-testid="hw-step-pick">
      <div className="hw-scheme-toggle" role="radiogroup" aria-label="Derivation scheme">
        {PATH_SCHEMES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={schemeId === s.id}
            className="hw-scheme-toggle__option"
            onClick={() => switchScheme(s.id)}
            disabled={busy}
          >
            {s.label}
          </button>
        ))}
      </div>

      <ul className="hw-account-list">
        {rows.map((row) => {
          const key = String(row.address).toLowerCase()
          return (
            <li key={key} className="hw-account-row">
              <label className="hw-account-row__main">
                <input
                  type="checkbox"
                  checked={Boolean(selected[key])}
                  onChange={() => toggleRow(row.address)}
                  disabled={busy}
                  aria-label={`Account ${row.index + 1}: ${short(row.address)}`}
                />
                <span className="hw-account-row__text">
                  <span className="hw-account-row__address">{short(row.address)}</span>
                  <span className="hw-account-row__path">{row.path}</span>
                </span>
              </label>
              <span className="hw-account-row__meta">
                {row.known && <span className="hw-account-row__known">Saved</span>}
                <span className="hw-account-row__balance">{fmtBalance(row.balance, symbol)}</span>
              </span>
            </li>
          )
        })}
      </ul>

      <button type="button" className="hw-load-more" onClick={loadMore} disabled={busy} data-testid="hw-load-more">
        {busy ? 'Reading the device…' : 'Show more accounts'}
      </button>

      <label className="hw-field">
        <span>Label (optional)</span>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Cold storage"
          maxLength={40}
        />
      </label>

      {error && (
        <p role="alert" className="hw-error">
          {error}
        </p>
      )}
      <div className="hw-actions">
        <button type="button" className="btn" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={doSave}
          disabled={busy || selectedRows.length === 0}
          data-testid="hw-save"
        >
          {selectedRows.length > 1 ? `Save ${selectedRows.length} accounts` : 'Save account'}
        </button>
      </div>
    </div>
  )

  const savedStep = (
    <div className="hw-step" data-testid="hw-step-saved">
      <p className="hw-step__lead">
        {savedEntries.length === 1 ? 'The account is saved' : `${savedEntries.length} accounts are saved`} and added
        to your address book. Find {savedEntries.length === 1 ? 'it' : 'them'} in the account switcher and every
        address field.
      </p>
      <ul className="hw-saved-list">
        {savedEntries.map((e) => (
          <li key={e.address} className="hw-saved-list__row">
            <code>{short(e.address)}</code>
            <span>{e.label || `${VENDOR_LABELS[e.vendor]} account`}</span>
          </li>
        ))}
      </ul>
      <p className="hw-step__hint">The device stays in charge: nothing can be sent from these accounts without confirming on it.</p>
      <div className="hw-actions">
        <button type="button" className="btn btn-primary" onClick={close} data-testid="hw-done">
          Done
        </button>
      </div>
    </div>
  )

  return (
    <ActionSheet
      open={open}
      onClose={close}
      title={STEP_TITLES[step]}
      closeDisabled={busy}
      className="action-sheet--hardware"
    >
      {step === 'vendor' && vendorStep}
      {step === 'connect' && connectStep}
      {step === 'pick' && pickStep}
      {step === 'saved' && savedStep}
    </ActionSheet>
  )
}

AddHardwareWalletSheet.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func,
  /** Called with the saved entries after a successful save. */
  onSaved: PropTypes.func,
  /** Test seam: { connect, availability, guidance, provider } */
  deps: PropTypes.object,
}
