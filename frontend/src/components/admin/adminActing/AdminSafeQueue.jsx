/**
 * AdminSafeQueue — the admin Safe's pending proposals, readable, and finishable with an owner key.
 *
 * Built for the device that cannot show what it is approving. A Ledger or Trezor approving a Safe
 * proposal displays `approveHash` on the Safe and a 32-byte hash; the action itself is behind that
 * hash. So each row says, in words, what the hash commits to (`describeAdminCall`, decoded from the
 * hub's VERIFIED preimage — the hub only lists a proposal whose recomputed hash matches), shows the
 * raw call underneath, and prints the hash with the characters to check on the device screen.
 *
 * Actions use the owner key the console is signing with. "Approve and execute" folds the last
 * approval into the execution: Safe v1.4.1 accepts a pre-validated signature from `msg.sender`
 * itself, so the owner whose approval reaches the threshold signs ONE transaction, not two.
 */
import { useState } from 'react'
import { encodeFunctionData } from 'viem'
import { describeAdminCall, deviceCheck } from '../../../lib/admin/describeAdminCall'
import { buildPrevalidatedSignatures, encodeExecTransaction } from '../../../lib/custody/vaultTransaction'
import { STATUS } from '../../../lib/custody/proposalStatus'
import { normalizeAbi } from '../../../lib/chains/readContract'
import { SAFE_ABI } from '../../../abis/Safe'
import { HardwareWalletError, describeHardwareError } from '../../../lib/hardware/errors'
import { chainDisplayName } from '../../../lib/custody/chainName'

const SAFE_ABI_PARSED = normalizeAbi(SAFE_ABI)
const lower = (a) => String(a || '').toLowerCase()
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '')

function errorSentence(err) {
  if (err instanceof HardwareWalletError) return describeHardwareError(err)
  return err?.shortMessage || err?.message || 'The action failed. Nothing was changed.'
}

function ProposalRow({ p, acting, currentNonce, busy, onRun }) {
  const { safeAddress, ownerAddress, ownerSigner, safeFacts, chainId } = acting
  const isOwner = safeFacts.state === 'read' && safeFacts.value.isOwner
  const approved = p.approvers.some((a) => lower(a) === lower(ownerAddress))
  const isNext = currentNonce != null && BigInt(p.nonce) === BigInt(currentNonce)
  const ready = p.status === STATUS.READY && isNext
  const lastApproval = isOwner && !approved && isNext && p.approvals + 1 >= p.threshold
  const canApprove = isOwner && !approved && Boolean(ownerSigner)
  const call = describeAdminCall({ to: p.to, value: p.value, data: p.data }, { chainId, safeAddress })
  const check = deviceCheck(p.safeTxHash)
  const delegate = Number(p.operation) === 1

  const approveAndExecute = async () => {
    const signatures = buildPrevalidatedSignatures([...p.approvers, ownerAddress])
    const tx = await ownerSigner.sendTransaction({
      to: safeAddress,
      data: encodeFunctionData({
        abi: SAFE_ABI_PARSED,
        functionName: 'execTransaction',
        args: encodeExecTransaction(p.safeTx, signatures),
      }),
    })
    await tx.wait()
  }

  return (
    <li className={`admin-safe-proposal${call.critical ? ' is-critical' : ''}`}>
      <div className="admin-safe-proposal-head">
        <div>
          <p className="admin-safe-proposal-title">
            {call.title}
            {call.critical && <span className="admin-safe-chip admin-safe-chip-critical">Sensitive</span>}
            {!call.recognised && <span className="admin-safe-chip">Not decoded</span>}
          </p>
          {call.detail && <p className="admin-safe-proposal-detail">{call.detail}</p>}
        </div>
        <div className="admin-safe-proposal-meta">
          <span>Nonce {String(p.nonce)}</span>
          <span>
            {p.approvals} of {p.threshold} approvals
          </span>
          {!isNext && currentNonce != null && (
            <span className="admin-safe-muted">Queued behind nonce {String(currentNonce)}</span>
          )}
        </div>
      </div>

      {delegate && (
        <p className="admin-safe-warning" role="alert">
          This proposal is a DELEGATECALL — it runs foreign code with the Safe&apos;s full authority. Approve it
          only if you know exactly what the target contract does.
        </p>
      )}

      <details className="admin-safe-details">
        <summary>Transaction details and what your device will show</summary>
        <dl>
          <dt>Target</dt>
          <dd className="admin-safe-mono">
            {p.to}
            {call.targetName ? ` (${call.targetName})` : ''}
          </dd>
          <dt>Value</dt>
          <dd className="admin-safe-mono">{String(p.value ?? 0)} wei</dd>
          <dt>Calldata</dt>
          <dd className="admin-safe-mono admin-safe-wrap">{p.data}</dd>
          <dt>Safe transaction hash</dt>
          <dd className="admin-safe-mono admin-safe-wrap">{p.safeTxHash}</dd>
          <dt>Approved by</dt>
          <dd className="admin-safe-mono">{p.approvers.length ? p.approvers.map(short).join(', ') : 'nobody yet'}</dd>
          <dt>Proposed by</dt>
          <dd className="admin-safe-mono">{p.proposer ?? '—'}</dd>
        </dl>
        <p className="admin-safe-device-hint">
          Approving: your device shows a contract call to the Safe <span className="admin-safe-mono">{short(safeAddress)}</span>{' '}
          with data starting <span className="admin-safe-mono">{check.calldataPrefix}</span> (approveHash) and ending{' '}
          <strong className="admin-safe-mono">…{check.tail}</strong>. If the last characters differ, reject it on the
          device. Executing: the device shows <span className="admin-safe-mono">execTransaction</span> on the same Safe.
        </p>
      </details>

      <div className="admin-safe-actions">
        {!isOwner && safeFacts.state === 'read' && (
          <p className="admin-safe-muted">
            {short(ownerAddress)} is not an owner of this Safe, so it can view this proposal but not approve it.
          </p>
        )}
        {approved && !ready && <p className="admin-safe-muted">You have approved this. Waiting for another owner.</p>}
        {ready && (
          <button type="button" className="confirm-btn primary" disabled={busy || !ownerSigner}
            onClick={() => onRun(p.safeTxHash, () => acting.proposals.execute(p), 'Executed on the Safe.')}>
            Execute
          </button>
        )}
        {!ready && lastApproval && canApprove && (
          <button type="button" className="confirm-btn primary" disabled={busy}
            onClick={() => onRun(p.safeTxHash, approveAndExecute, 'Approved and executed on the Safe.')}>
            Approve and execute
          </button>
        )}
        {!ready && canApprove && (
          <button type="button" className={lastApproval ? 'confirm-btn' : 'confirm-btn primary'} disabled={busy}
            onClick={() => onRun(p.safeTxHash, () => acting.proposals.approve(p.safeTxHash), 'Approval recorded on the Safe.')}>
            {lastApproval ? 'Approve only' : 'Approve'}
          </button>
        )}
      </div>
    </li>
  )
}

export default function AdminSafeQueue({ acting }) {
  const { proposals, safeFacts, chainId } = acting
  const { queue, loading, error, partial, refresh } = proposals
  const [busyHash, setBusyHash] = useState(null)
  const [outcome, setOutcome] = useState(null)
  const currentNonce = safeFacts.state === 'read' ? safeFacts.value.nonce : null
  const network = chainId != null ? chainDisplayName(chainId) : 'this network'

  const onRun = async (hash, fn, success) => {
    setBusyHash(hash)
    setOutcome(null)
    try {
      await fn()
      setOutcome({ ok: true, text: success })
      await refresh?.()
      acting.refreshSafe()
    } catch (err) {
      setOutcome({ ok: false, text: errorSentence(err) })
    } finally {
      setBusyHash(null)
    }
  }

  const sorted = [...queue].sort((a, b) => (BigInt(a.nonce) < BigInt(b.nonce) ? -1 : 1))

  return (
    <section className="admin-safe-queue" aria-label="Admin Safe queue">
      <div className="admin-safe-queue-head">
        <h3>Pending on {network}</h3>
        <button type="button" className="confirm-btn" onClick={() => refresh?.()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {outcome && (
        <p className={outcome.ok ? 'admin-safe-ok' : 'admin-safe-error'} role={outcome.ok ? 'status' : 'alert'}>
          {outcome.text}
        </p>
      )}
      {error && (
        <p className="admin-safe-error" role="alert">
          The queue could not be read: {error}
        </p>
      )}
      {partial && (
        <p className="admin-safe-muted" role="status">
          Still reading proposal history — the list below may not be complete yet.
        </p>
      )}
      {!error && !loading && sorted.length === 0 && !partial && (
        <p className="admin-safe-muted">Nothing is waiting for approval on {network}.</p>
      )}
      <ul className="admin-safe-proposals">
        {sorted.map((p) => (
          <ProposalRow key={p.safeTxHash} p={p} acting={acting} currentNonce={currentNonce}
            busy={busyHash != null} onRun={onRun} />
        ))}
      </ul>
    </section>
  )
}
