// Spec 043 (US1) — load an existing vault by address. Distinguishes "not a contract", "not a Safe", and a
// real Safe (owned vs view-only is derived after load). Delegates the chain read to onLoad.
//
// Spec 068 (US5) — address entry goes through the shared Protect field (paste, address book, QR).
// Spec 068 also makes loading CROSS-CHAIN: `onLoad` searches every custody network, so a member
// pasting a vault address does not have to already know which chain it is on.
//
// Spec 102 (US2, FR-003) — every network the address is a Safe on is ADDED, and the result says so
// ("Found on Polygon, Base and Optimism"). The "pick another network" prompt is gone: it asked a
// question the member cannot answer yet. Networks that could not be reached are NAMED and can be
// checked again; nothing is added for them. The form closes as soon as at least one network was
// added, and stays open only when nothing was.

import { useState } from 'react'
import { vaultChainName as chainName, listChainNames } from '../../lib/custody/vaultGroups'
import CustodyAddressField from './CustodyAddressField'

export default function LoadVaultForm({ onLoad, onDone, chainId }) {
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  // Networks the probe could not reach — from a success (some added) or from the "found nowhere
  // reachable" rejection, which carries them so the member can retry rather than give up.
  const [unreachable, setUnreachable] = useState([])

  const handleLoad = async () => {
    setError(null)
    setResult(null)
    setUnreachable([])
    setBusy(true)
    try {
      const vault = await onLoad(address.trim(), label, 0)
      setResult(vault)
      setUnreachable(vault.unreachable || [])
      // Close as soon as the vault was added anywhere. `added` absent means a single-network result
      // from a legacy caller, which always added one.
      const addedCount = vault.added?.length ?? vault.matches?.length ?? 1
      if (addedCount > 0) onDone?.(vault)
    } catch (e) {
      setError(e?.message || 'Could not load that address')
      setUnreachable(Array.isArray(e?.unreachable) ? e.unreachable : [])
    } finally {
      setBusy(false)
    }
  }

  const addedChains = result?.added ?? (result?.matches?.length ? result.matches.map((m) => m.chainId) : [])
  const foundOn = addedChains.length > 1 ? listChainNames(addedChains) : chainName(result?.chainId)

  return (
    <form className="custody-load" onSubmit={(e) => e.preventDefault()} aria-label="Load a vault by address">
      {/* Spec 105 (US4) — the sheet states what it does before asking for anything. */}
      <p className="custody-hint">
        Paste a vault&rsquo;s address — every custody network is searched, and the vault is added on
        each network it lives on.
      </p>
      <CustodyAddressField
        id="load-address"
        label="Vault address"
        value={address}
        onChange={setAddress}
        chainId={chainId}
      />
      <div className="custody-field">
        <label htmlFor="load-label">Label (private, on this device)</label>
        <input id="load-label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>

      {error && (
        <p className="custody-error" role="alert">
          {error}
        </p>
      )}
      {result?.isSafe && (
        <p className="custody-predicted" role="status">
          Found on <strong>{foundOn}</strong>: {result.owner ? 'a vault you co-own' : 'a view-only vault'} with{' '}
          {result.owners.length} owners and a {result.threshold}-of-{result.owners.length} threshold
          {result.version ? ` (Safe ${result.version})` : ''}.
        </p>
      )}

      {unreachable.length > 0 && (
        <div className="custody-hint" role="status">
          <p>
            Not checked on {unreachable.map((u) => chainName(u.chainId)).join(', ')} — those networks could not be
            reached.
          </p>
          <div className="custody-actions">
            <button type="button" onClick={handleLoad} disabled={busy} data-testid="load-vault-check-again">
              Check again
            </button>
          </div>
        </div>
      )}

      <div className="custody-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={handleLoad}
          disabled={!address.trim() || busy}
          data-testid="load-vault-submit"
        >
          {busy ? 'Searching all networks…' : 'Load vault'}
        </button>
      </div>
    </form>
  )
}
