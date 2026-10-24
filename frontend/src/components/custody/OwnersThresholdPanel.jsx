// Spec 043 (US4, FR-018/019) — vault governance: add/remove an owner or change the threshold. Each is an
// ordinary vault transaction targeting the Safe itself, proposed through the same queue as any other action
// (onPropose === useVaultProposals.propose). Presentational; the encoding is delegated to vaultTransaction's
// governance builders. Owners only (FR-016).

import { useState, useMemo } from 'react'
import { getAddress } from 'viem'
import CustodyAddressField from './CustodyAddressField'
import {
  buildAddOwner,
  buildRemoveOwner,
  buildChangeThreshold,
  prevOwnerOf,
} from '../../lib/custody/vaultTransaction'

const isAddr = (v) => {
  try {
    getAddress(v)
    return true
  } catch {
    return false
  }
}

export default function OwnersThresholdPanel({ vault, onPropose, busy }) {
  const [mode, setMode] = useState(null) // null | 'add' | 'remove' | 'threshold'
  const [newOwner, setNewOwner] = useState('')
  const [removeTarget, setRemoveTarget] = useState('')
  const [threshold, setThreshold] = useState(vault?.threshold ?? 1)
  const [error, setError] = useState(null)

  const owners = useMemo(() => vault?.owners || [], [vault?.owners])

  const validation = useMemo(() => {
    if (mode === 'add') {
      if (!isAddr(newOwner.trim())) return 'Enter a valid owner address'
      if (owners.some((o) => o.toLowerCase() === newOwner.trim().toLowerCase())) return 'Already an owner'
      const max = owners.length + 1
      if (threshold < 1 || threshold > max) return `Threshold must be between 1 and ${max}`
    } else if (mode === 'remove') {
      if (!removeTarget) return 'Select an owner to remove'
      if (owners.length <= 1) return 'A vault must keep at least one owner'
      const max = owners.length - 1
      if (threshold < 1 || threshold > max) return `Threshold must be between 1 and ${max}`
    } else if (mode === 'threshold') {
      if (threshold < 1 || threshold > owners.length) return `Threshold must be between 1 and ${owners.length}`
    }
    return null
  }, [mode, newOwner, removeTarget, threshold, owners])

  if (!vault?.owner) return null // view-only members can't propose governance

  const submit = async () => {
    setError(null)
    try {
      let tx
      if (mode === 'add') {
        tx = buildAddOwner(vault.address, newOwner.trim(), threshold, 0)
      } else if (mode === 'remove') {
        const prev = prevOwnerOf(owners, removeTarget)
        tx = buildRemoveOwner(vault.address, prev, removeTarget, threshold, 0)
      } else if (mode === 'threshold') {
        tx = buildChangeThreshold(vault.address, threshold, 0)
      }
      // propose() recomputes the nonce; we only pass the target + encoded call.
      await onPropose({ to: tx.to, value: 0n, data: tx.data })
      setMode(null)
      setNewOwner('')
      setRemoveTarget('')
    } catch (e) {
      setError(e?.message || 'Could not create the governance proposal')
    }
  }

  return (
    <div className="custody-governance" role="region" aria-label="Vault governance">
      <h5>Governance</h5>
      <div className="custody-actions">
        <button type="button" onClick={() => setMode(mode === 'add' ? null : 'add')}>Add owner</button>
        <button type="button" onClick={() => setMode(mode === 'remove' ? null : 'remove')}>Remove owner</button>
        <button type="button" onClick={() => setMode(mode === 'threshold' ? null : 'threshold')}>
          Change threshold
        </button>
      </div>

      {mode === 'add' && (
        // Spec 068 (US5) — an owner address is the highest-stakes address in Protect; entry goes
        // through the shared field (paste, address book, QR), never a bare text input.
        <CustodyAddressField
          id="gov-new-owner"
          label="New owner address"
          value={newOwner}
          onChange={setNewOwner}
          chainId={vault?.chainId}
        />
      )}

      {mode === 'remove' && (
        <div className="custody-field">
          <label htmlFor="gov-remove-owner">Owner to remove</label>
          <select id="gov-remove-owner" value={removeTarget} onChange={(e) => setRemoveTarget(e.target.value)}>
            <option value="">Select…</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      )}

      {mode && (
        <div className="custody-field">
          <label htmlFor="gov-threshold">New threshold (approvals required)</label>
          <input id="gov-threshold" type="number" min={1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
        </div>
      )}

      {mode && validation && (
        <p className="custody-error" role="alert">
          {validation}
        </p>
      )}
      {error && (
        <p className="custody-error" role="alert">
          {error}
        </p>
      )}

      {mode && (
        <div className="custody-actions">
          <button type="button" onClick={submit} disabled={!!validation || busy}>
            Propose {mode === 'threshold' ? 'threshold change' : mode === 'add' ? 'add owner' : 'remove owner'}
          </button>
        </div>
      )}
    </div>
  )
}
