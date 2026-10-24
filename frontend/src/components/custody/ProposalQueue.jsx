// Spec 043 (US2) — the vault's pending queue + history with approve/execute actions. Non-owners see state
// but no action buttons (FR-016). Blocked states are surfaced honestly (approvals remaining; not-ready).
// Spec 049 (US3) — proposals targeting the chain's SafePolicyGuard that decode as configureRules render as a
// distinct "Policy change" entry with the decoded rule diff; a self-tx setting that guard renders as
// "Activate policy engine". Anything that fails to decode renders exactly as before.

import { decodeFunctionData, parseAbi } from 'viem'
import { formatUnits } from '../../lib/evm/units'
import { STATUS } from '../../lib/custody/proposalStatus'
import { approvalsRemaining } from '../../lib/custody/proposalStatus'
import { getContractAddressForChain } from '../../config/contracts'
import { GUARD_ABI, NATIVE_ASSET, shortAddress, formatDuration } from '../../lib/custody/policy'
// Spec 068 — ordered-engine proposals (setRules / adopt) decode through the V2 classifier and render
// the resulting rule list in order, since one call replaces the whole policy.
import { classifyPolicyProposalV2, describeRulesV2 } from '../../lib/custody/policyV2'
import './Policy.css'

const SAFE_GUARD_ABI = parseAbi(['function setGuard(address guard)'])

function shortHash(h) {
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : ''
}

function assetName(asset) {
  return asset === NATIVE_ASSET ? 'native coin' : `token ${shortAddress(asset)}`
}

function assetAmount(asset, amount) {
  return asset === NATIVE_ASSET ? formatUnits(amount, 18) : `${amount} base units`
}

/**
 * Classify a queued proposal against the chain's policy engine (spec 049). Returns
 * `{ kind: 'configure', changes: string[] }`, `{ kind: 'set-guard' }`, `{ kind: 'remove-guard' }`,
 * or null for an ordinary proposal. Never throws — unknown data renders as today.
 */
function classifyPolicyProposal(p, chainId, vaultAddress) {
  try {
    const guard = getContractAddressForChain('safePolicyGuard', chainId)
    if (!guard || !p?.to || !p?.data || p.data === '0x') return null
    const to = String(p.to).toLowerCase()
    const guardLc = guard.toLowerCase()

    if (to === guardLc) {
      // viem THROWS on calldata this ABI cannot decode where ethers' `parseTransaction` returned
      // null; the surrounding try/catch already treats both as "not a policy proposal".
      const parsed = decodeFunctionData({ abi: GUARD_ABI, data: p.data })
      if (parsed?.functionName !== 'configureRules') return null
      const [limits, cooldown, allowlistEnabled, adds, removes] = parsed.args
      const changes = []
      for (const l of limits) {
        const per = BigInt(l.perTxLimit)
        const win = BigInt(l.windowLimit)
        changes.push(
          `${assetName(l.asset)}: per-transaction limit ${per > 0n ? assetAmount(l.asset, per) : 'off'}, ` +
            `24-hour window limit ${win > 0n ? assetAmount(l.asset, win) : 'off'}`,
        )
      }
      const cd = Number(cooldown)
      changes.push(cd > 0 ? `Transaction delay: ${formatDuration(cd)}` : 'Transaction delay: off')
      changes.push(`Recipient allowlist: ${allowlistEnabled ? 'enabled' : 'disabled'}`)
      for (const a of adds) changes.push(`Add recipient ${shortAddress(a)}`)
      for (const a of removes) changes.push(`Remove recipient ${shortAddress(a)}`)
      return { kind: 'configure', changes }
    }

    if (vaultAddress && to === String(vaultAddress).toLowerCase()) {
      // Throws on a selector this ABI does not carry; the enclosing catch renders the
      // proposal exactly as an undecodable one, which is what it is.
      const parsed = decodeFunctionData({ abi: SAFE_GUARD_ABI, data: p.data })
      if (!parsed || parsed.functionName !== 'setGuard') return null
      const target = String(parsed.args[0]).toLowerCase()
      if (target === guardLc) return { kind: 'set-guard' }
      if (/^0x0{40}$/.test(target)) return { kind: 'remove-guard' }
      return null
    }
    return null
  } catch {
    return null
  }
}

function PolicyProposalFacts({ policyInfo }) {
  // Spec 068 — the ordered engine replaces a vault's whole rule set in one call, so the queue shows
  // the proposed rules IN ORDER: what owners approve is the resulting policy, not a delta.
  if (policyInfo.kind === 'set-rules') {
    return (
      <div className="custody-proposal-facts custody-proposal-facts--policy">
        <span className="custody-policy-tag">Policy change</span>
        <ol className="custody-policy-diff" aria-label="Proposed rules, in order">
          {policyInfo.descriptions.map((line, i) => (
            <li key={i}>
              <strong>{line.number}</strong> {line.text}
            </li>
          ))}
        </ol>
        {policyInfo.descriptions.length === 0 && (
          <span>This proposal removes every rule — the vault would refuse all transactions.</span>
        )}
      </div>
    )
  }
  if (policyInfo.kind === 'adopt-v2') {
    return (
      <div className="custody-proposal-facts custody-proposal-facts--policy">
        <span className="custody-policy-tag">Activate ordered rules</span>
        <span>
          Switches this vault to the ordered policy engine — the rules proposed alongside this take effect when
          it executes.
        </span>
      </div>
    )
  }
  if (policyInfo.kind === 'configure') {
    return (
      <div className="custody-proposal-facts custody-proposal-facts--policy">
        <span className="custody-policy-tag">Policy change</span>
        <ul className="custody-policy-diff" aria-label="Proposed rule changes">
          {policyInfo.changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div className="custody-proposal-facts custody-proposal-facts--policy">
      <span className="custody-policy-tag">
        {policyInfo.kind === 'set-guard' ? 'Activate policy engine' : 'Detach policy engine'}
      </span>
      <span>
        {policyInfo.kind === 'set-guard'
          ? 'Attaches the policy engine to this vault — the configured rules take effect when this executes.'
          : 'Removes the policy engine from this vault — rules stop applying when this executes.'}
      </span>
    </div>
  )
}

function ProposalRow({ p, isOwner, hasApproved, onApprove, onExecute, onCancel, busy, chainId, vaultAddress }) {
  const remaining = approvalsRemaining(p.approvals, p.threshold)
  // Try the ordered engine first, then fall back to the v1 classifier — a vault may still be on v1.
  const v2Info = classifyPolicyProposalV2(p, chainId, vaultAddress)
  const policyInfo = v2Info
    ? { ...v2Info, descriptions: v2Info.rules ? describeRulesV2(v2Info.rules, v2Info.cooldown) : [] }
    : classifyPolicyProposal(p, chainId, vaultAddress)
  return (
    <li className="custody-proposal-row">
      <div className="custody-proposal-main">
        <span className={`custody-status custody-status--${p.status}`}>{p.status}</span>
        <span className="custody-proposal-meta">
          {p.approvals}/{p.threshold} approvals
          {p.status === STATUS.PENDING && remaining > 0 ? ` · ${remaining} more needed` : ''}
        </span>
        <code className="custody-proposal-hash">{shortHash(p.safeTxHash)}</code>
      </div>
      {policyInfo && <PolicyProposalFacts policyInfo={policyInfo} />}
      <div className="custody-proposal-facts">
        <span>to <code>{p.to}</code></span>
        <span>nonce {String(p.nonce)}</span>
      </div>
      {isOwner && (
        <div className="custody-actions">
          {p.status === STATUS.PENDING && (
            <button type="button" onClick={() => onApprove(p.safeTxHash)} disabled={busy || hasApproved}>
              {hasApproved ? 'Approved' : 'Approve'}
            </button>
          )}
          {p.status === STATUS.READY && (
            <button type="button" onClick={() => onExecute(p)} disabled={busy}>
              Execute
            </button>
          )}
          {(p.status === STATUS.PENDING || p.status === STATUS.READY) && onCancel && (
            <button type="button" className="custody-link" onClick={() => onCancel(p.safeTxHash)} disabled={busy}>
              Cancel
            </button>
          )}
        </div>
      )}
    </li>
  )
}

export default function ProposalQueue({ queue, history, isOwner, connectedAddress, onApprove, onExecute, onCancel, busy, chainId, vaultAddress }) {
  const approvedByMe = (p) =>
    !!connectedAddress && (p.approvers || []).some((a) => a.toLowerCase() === connectedAddress.toLowerCase())

  return (
    <div className="custody-proposals" role="region" aria-label="Vault proposals">
      <h5>Pending queue</h5>
      {queue.length === 0 ? (
        <p className="custody-hint" role="status">
          No pending transactions.
        </p>
      ) : (
        <ul className="custody-proposal-list">
          {queue.map((p) => (
            <ProposalRow
              key={p.safeTxHash}
              p={p}
              isOwner={isOwner}
              hasApproved={approvedByMe(p)}
              onApprove={onApprove}
              onExecute={onExecute}
              onCancel={onCancel}
              busy={busy}
              chainId={chainId}
              vaultAddress={vaultAddress}
            />
          ))}
        </ul>
      )}

      {history.length > 0 && (
        <>
          <h5>History</h5>
          <ul className="custody-proposal-list custody-proposal-list--history">
            {history.map((p) => (
              <li key={p.safeTxHash} className="custody-proposal-row">
                <span className={`custody-status custody-status--${p.status}`}>{p.status}</span>
                <code className="custody-proposal-hash">{shortHash(p.safeTxHash)}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
