/**
 * AdminActingBar — the console's "acting as / signing with" control and the door to the Safe queue.
 *
 * Rendered above EVERY /admin screen, including the "Access Restricted" one: an owner whose
 * Ledger holds no role of its own is refused until they choose the Safe, so the control that lets
 * them choose it cannot sit behind the gate it unlocks.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { getAddress } from 'viem'
import { describeHardwareError } from '../../../lib/hardware/errors'
import { chainDisplayName } from '../../../lib/custody/chainName'
import AdminSafeQueue from './AdminSafeQueue'
import './AdminActingBar.css'

const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '')
const lower = (a) => String(a || '').toLowerCase()
const VENDOR = { ledger: 'Ledger', trezor: 'Trezor', sigil: 'Sigil' }

function SafeFactsLine({ acting, network }) {
  const { safeFacts, ownerAddress } = acting
  if (safeFacts.state === 'loading' || safeFacts.state === 'idle') {
    return <p className="admin-acting-muted" role="status">Reading the Safe on {network}…</p>
  }
  if (safeFacts.state === 'not-a-safe') {
    return (
      <p className="admin-acting-error" role="alert">
        There is no Safe at this address on {network}. Switch your wallet to a network where it is deployed.
      </p>
    )
  }
  if (safeFacts.state === 'unreadable') {
    return (
      <p className="admin-acting-error" role="alert">
        The Safe could not be read on {network}, so its owners and threshold are unknown — this is a connection
        problem, not a statement about the Safe.{' '}
        <button type="button" className="admin-acting-link" onClick={acting.refreshSafe}>Retry</button>
      </p>
    )
  }
  const { threshold, owners, nonce, isOwner } = safeFacts.value
  return (
    <p className="admin-acting-facts">
      {threshold}-of-{owners.length} Safe on {network} · next nonce {String(nonce)} ·{' '}
      {isOwner ? (
        <span className="admin-acting-ok">{short(ownerAddress)} is an owner</span>
      ) : (
        <span className="admin-acting-error">
          {short(ownerAddress)} is not an owner — it can read the queue but cannot propose or approve
        </span>
      )}
    </p>
  )
}

export default function AdminActingBar({ acting }) {
  const [draft, setDraft] = useState(acting.safeAddress ?? '')
  const [draftError, setDraftError] = useState(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const network = acting.chainId != null ? chainDisplayName(acting.chainId) : 'this network'
  const pending = acting.proposals?.queue?.length ?? 0

  const applySafe = () => {
    try {
      acting.setSafe(getAddress(draft.trim()))
      setDraftError(null)
    } catch {
      setDraftError('That is not a valid address.')
    }
  }

  const stepText =
    acting.proposalStep?.step === 'publish'
      ? 'Confirm on your signer (1 of 2): publish the proposal so the other owners can see it.'
      : acting.proposalStep?.step === 'approve'
        ? 'Confirm on your signer (2 of 2): record your approval on the Safe.'
        : null

  return (
    <section className="admin-acting-bar" aria-label="Acting identity">
      <div className="admin-acting-row">
        <div className="admin-acting-group">
          <span className="admin-acting-label" id="admin-acting-as">Acting as</span>
          {acting.mode === 'safe' ? (
            <>
              <span className="admin-acting-value admin-acting-mono" aria-labelledby="admin-acting-as">
                Safe {short(acting.safeAddress)}
              </span>
              <button type="button" className="admin-acting-link" onClick={acting.clearSafe}>
                Act as the signing key instead
              </button>
            </>
          ) : (
            <form
              className="admin-acting-safe-form"
              onSubmit={(e) => {
                e.preventDefault()
                applySafe()
              }}
            >
              <span className="admin-acting-value" aria-labelledby="admin-acting-as">
                the signing key itself
              </span>
              <label className="admin-acting-sr" htmlFor="admin-acting-safe-input">Admin Safe address</label>
              <input
                id="admin-acting-safe-input"
                className="admin-acting-input admin-acting-mono"
                placeholder="Admin Safe address 0x…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" className="confirm-btn" disabled={!draft.trim()}>
                Act as this Safe
              </button>
              {draftError && <span className="admin-acting-error" role="alert">{draftError}</span>}
            </form>
          )}
        </div>

        <div className="admin-acting-group">
          <span className="admin-acting-label">Signing with</span>
          {acting.ownerSource === 'hardware' ? (
            <>
              <span className="admin-acting-value admin-acting-mono">
                {VENDOR[acting.ownerSigner?.vendor] ?? 'Device'} {short(acting.ownerAddress)}
              </span>
              <button type="button" className="admin-acting-link" onClick={acting.disconnectDevice}>
                Disconnect and use the connected wallet
              </button>
            </>
          ) : (
            <span className="admin-acting-value admin-acting-mono">
              connected wallet {short(acting.ownerAddress)}
            </span>
          )}
        </div>
      </div>

      {acting.ownerSource !== 'hardware' && (
        <div className="admin-acting-row admin-acting-devices">
          {acting.hardwareEntries.length > 0 ? (
            <>
              <span className="admin-acting-muted">Sign with a device instead:</span>
              {acting.hardwareEntries.map((entry) => (
                <button
                  key={lower(entry.address)}
                  type="button"
                  className="confirm-btn"
                  disabled={acting.deviceState.status === 'connecting'}
                  onClick={() => acting.connectDevice(entry)}
                >
                  {acting.deviceState.status === 'connecting' ? 'Connecting…' : `Connect ${VENDOR[entry.vendor] ?? entry.vendor}`}{' '}
                  {entry.label ? `“${entry.label}” ` : ''}
                  {short(entry.address)}
                </button>
              ))}
            </>
          ) : (
            <span className="admin-acting-muted">
              To sign with a Ledger or Trezor directly, add it under{' '}
              <Link to="/wallet?tab=custody#custody-offchain">Protect ▸ Off chain</Link> first. A device connected
              through your wallet extension already signs as the connected wallet.
            </span>
          )}
          {acting.deviceState.error && (
            <span className="admin-acting-error" role="alert">{describeHardwareError(acting.deviceState.error)}</span>
          )}
        </div>
      )}

      {acting.mode === 'safe' && (
        <>
          <SafeFactsLine acting={acting} network={network} />
          <p className="admin-acting-muted">
            Every change you make here becomes a proposal on this Safe on {network}, signed by your key and applied
            only once enough owners approve and someone executes it. To act on another network, switch your wallet
            to it.
          </p>
          {stepText && (
            <p className="admin-acting-step" role="status">{stepText}</p>
          )}
          <div className="admin-acting-row">
            <button
              type="button"
              className="confirm-btn primary"
              aria-expanded={queueOpen}
              aria-controls="admin-safe-queue"
              onClick={() => setQueueOpen((o) => !o)}
            >
              {queueOpen ? 'Hide' : 'Show'} the Safe queue{acting.proposals?.loading ? '' : ` (${pending} pending)`}
            </button>
          </div>
          {queueOpen && (
            <div id="admin-safe-queue">
              <AdminSafeQueue acting={acting} />
            </div>
          )}
        </>
      )}
    </section>
  )
}
