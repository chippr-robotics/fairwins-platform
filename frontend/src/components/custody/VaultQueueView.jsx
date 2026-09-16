// Spec 102 (US3, FR-005…FR-008) — the vault sheet's Queue view: every pending or ready proposal
// across EVERY network the vault lives on, newest first, each row tagged with its network.
//
// Reads come from useVaultQueueAcrossChains (one provider per instance chain, four-state per
// chain). Actions go through useVaultProposals bound to the CONNECTED chain's instance — a Safe
// approval is chain-scoped, so a row on another network first asks the wallet to switch
// (FR-007). The action then runs from an effect, once the wallet AND the hook are on that chain,
// so it always executes with the REBOUND signer, never a stale one. A refused switch is a stated
// per-row error naming both chains; nothing is signed.
//
// Honesty (FR-019): a chain that could not be read is named with a Retry, a chain with no hub
// deploy block says so, an unknown chain says "not supported in this build" — none of them is
// ever "none pending". While reading, the view says how many networks it is reading.

import { useCallback, useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { useWallet } from '../../hooks'
import { useVaultProposals } from '../../hooks/useVaultProposals'
import { useVaultQueueAcrossChains } from '../../hooks/useVaultQueueAcrossChains'
import { summarizeQueue } from '../../lib/custody/vaultGroups'
import { STATUS, approvalsRemaining } from '../../lib/custody/proposalStatus'
import { chainDisplayName } from '../../lib/custody/chainName'
import { describeProposal } from '../../lib/custody/describeProposal'
import { NETWORKS } from '../../config/networks'
import { getContractAddressForChain } from '../../config/contracts'
import NetworkPill from '../ui/NetworkPill'
import { useOpponentName } from '../../hooks/useOpponentName'
import { shortAccountAddr } from '../../hooks/useAccountSwitcher'

function shortHash(h) {
  return h ? `${h.slice(0, 10)}…${h.slice(-6)}` : ''
}

const ACTION_LABEL = { approve: 'Approval', execute: 'Execution', cancel: 'Cancellation' }

/**
 * Spec 105 (US5) — the decoder's per-chain vocabulary: the chain's everyday stable token and its
 * native symbol. Only POSITIVELY known meta goes in; an unknown token stays undecoded (raw row).
 */
function decodeContext(chainId, vaultAddress) {
  const net = NETWORKS[Number(chainId)]
  const assetMeta = {}
  const stableAddr = getContractAddressForChain('paymentToken', chainId)
  if (stableAddr && net?.stablecoin) {
    assetMeta[stableAddr] = { symbol: net.stablecoin.symbol, decimals: net.stablecoin.decimals ?? 6 }
  }
  return { chainId: Number(chainId), vaultAddress, assetMeta, nativeSymbol: net?.nativeCurrency?.symbol || null }
}

/**
 * The recipient, cross-referenced the way every address in the app is (spec 054 priority:
 * address book > callsign > ENS > generated) — a member reads "to Alice", with the hex kept
 * beside it because the name is a convenience and the address is the fact being signed.
 */
function RowRecipient({ address, chainId }) {
  const { displayName, source } = useOpponentName(address, { chainId })
  const named = displayName && source !== 'generated'
  return (
    <span className="vault-queue__to" data-testid="vault-queue-to" data-source={source || 'none'} title={address}>
      to {named ? <strong>{displayName}</strong> : null} <code aria-label={address}>{shortAccountAddr(address)}</code>
    </span>
  )
}

RowRecipient.propTypes = { address: PropTypes.string.isRequired, chainId: PropTypes.number }

function chainStatusText(chainId, entry, reading = false) {
  const name = chainDisplayName(chainId)
  const state = entry?.state
  if (state === 'read') {
    const n = (entry.proposals || []).filter((p) => p.status === STATUS.PENDING || p.status === STATUS.READY).length
    const base = n > 0 ? `${name}: ${n} pending` : `${name}: none pending`
    return entry.partial ? `${base} (still reading history)` : base
  }
  if (state === 'unreadable') return `${name}: could not be read`
  if (state === 'not-configured') return `${name}: proposal history is not configured on this network`
  if (state === 'not-supported') return `${name}: not supported in this build`
  return entry || reading ? `${name}: reading…` : `${name}: not read`
}

export default function VaultQueueView({ group }) {
  const { chainId: walletChainId, address: connectedAddress, switchNetwork } = useWallet()
  const queue = useVaultQueueAcrossChains(group)
  const { byChain = {}, rows = [], loading, refresh } = queue
  const connectedInstance = group.connectedInstance || null
  const proposals = useVaultProposals(connectedInstance)
  // The hook is read through a ref by the deferred-action effect so the effect re-runs on the
  // facts that matter (wallet chain, instance) and always calls the CURRENT hook binding.
  const proposalsRef = useRef(proposals)
  useEffect(() => {
    proposalsRef.current = proposals
  })

  /*
   * Can this session sign a custody write on the chain it is CONNECTED to? The queue's actions all
   * run through `useVaultProposals`, which is bound to the connected instance, so this is the fact
   * that decides whether a row's buttons can do anything — and it is a property of the signer, not
   * of how the member logged in (lib/chains/writeRail.js).
   */
  const writeRail = proposals?.writeRail
  const canAct = writeRail ? writeRail.available : true
  const railReason = writeRail?.reason || ''

  const [busy, setBusy] = useState(false)
  // Spec 105 (US5) — chip filter over the rendered rows. Pure view state: the cross-chain read,
  // its four-state honesty and the partial-total naming are untouched by any chip.
  const [filter, setFilter] = useState('all')
  const [rowErrors, setRowErrors] = useState({})
  const [pendingAction, setPendingAction] = useState(null) // { chainId, kind, proposal }

  const setRowError = useCallback((hash, message) => {
    setRowErrors((prev) => {
      const next = { ...prev }
      if (message) next[hash] = message
      else delete next[hash]
      return next
    })
  }, [])

  const runAction = useCallback(
    async ({ kind, proposal, chainId }) => {
      const api = proposalsRef.current
      setBusy(true)
      try {
        if (kind === 'approve') await api.approve(proposal.safeTxHash)
        else if (kind === 'execute') await api.execute(proposal)
        else if (kind === 'cancel') await api.cancel(proposal.safeTxHash)
        setRowError(proposal.safeTxHash, null)
        await refresh?.(chainId)
      } catch (e) {
        setRowError(proposal.safeTxHash, e?.message || `${ACTION_LABEL[kind]} failed`)
      } finally {
        setBusy(false)
      }
    },
    [refresh, setRowError],
  )

  const handleAction = async (row, kind) => {
    setRowError(row.safeTxHash, null)
    if (Number(row.chainId) !== Number(walletChainId)) {
      try {
        if (!switchNetwork) throw new Error('This wallet cannot switch networks from here.')
        await switchNetwork(row.chainId)
      } catch {
        setRowError(
          row.safeTxHash,
          `${ACTION_LABEL[kind]} not sent — this proposal is on ${chainDisplayName(row.chainId)}, and the wallet stayed on ${chainDisplayName(walletChainId)}.`,
        )
        return
      }
      // The wallet accepted; the effect below runs the action once the hook has re-bound.
      setPendingAction({ chainId: Number(row.chainId), kind, proposal: row })
      return
    }
    await runAction({ kind, proposal: row, chainId: Number(row.chainId) })
  }

  // Deferred action: run only when the wallet is on the row's chain AND the proposals hook is
  // bound to that chain's instance (so approve/execute close over the rebound signer).
  // `inFlightRef` makes the hand-off idempotent: a re-render while the action is running must
  // not replay it, and the pending marker is cleared when the action settles (not synchronously
  // here — the row keeps its "Switching…" state until the signature request has actually gone out).
  const instanceChainId = connectedInstance?.chainId
  const inFlightRef = useRef(null)
  useEffect(() => {
    if (!pendingAction || inFlightRef.current === pendingAction) return
    if (Number(walletChainId) !== pendingAction.chainId) return
    if (Number(instanceChainId) !== pendingAction.chainId) return
    inFlightRef.current = pendingAction
    runAction(pendingAction).finally(() => {
      inFlightRef.current = null
      setPendingAction((prev) => (prev === pendingAction ? null : prev))
    })
  }, [pendingAction, walletChainId, instanceChainId, runAction])

  const summary = summarizeQueue(byChain)
  const chainIds = group.chainIds || []
  const readableCount = (group.readable || (group.instances || []).filter((i) => i.isSafe === true)).length
  const entriesCount = Object.keys(byChain).length
  // The hook commits its first `loading` entries from an effect, so the very first paint has no
  // entries yet; that is "reading", not "nothing could be read".
  const reading = loading || (entriesCount === 0 && readableCount > 0)
  const readingCount = summary.loading?.length || readableCount || chainIds.length
  const summaryText = reading
    ? `Reading ${readingCount} network${readingCount === 1 ? '' : 's'}…`
    : entriesCount === 0
      ? 'No network could be read for this vault.'
      : summary.line
  const isMine = (p) =>
    Boolean(connectedAddress) && (p.approvers || []).some((a) => String(a).toLowerCase() === String(connectedAddress).toLowerCase())

  // "Needs you": pending, the member is an owner on that row's chain, and they have not approved.
  const rowNeedsYou = (p) => {
    const entry = byChain[p.chainId] || byChain[String(p.chainId)]
    return Boolean(entry?.owner) && p.status === STATUS.PENDING && !isMine(p)
  }
  const needsYouCount = rows.filter(rowNeedsYou).length
  const rowChainIds = [...new Set(rows.map((p) => Number(p.chainId)))]
  const visibleRows =
    filter === 'all' ? rows : filter === 'needs-you' ? rows.filter(rowNeedsYou) : rows.filter((p) => Number(p.chainId) === Number(filter))

  return (
    <div className="vault-queue" role="region" aria-label="Vault queue">
      <div className="vault-queue__head">
        <p
          className={`vault-queue__summary${summary?.partial ? ' is-partial' : ''}`}
          role="status"
          data-testid="vault-queue-summary"
          data-partial={summary?.partial ? 'true' : 'false'}
        >
          {summaryText}
        </p>
        {/*
         * The queue reads when it opens, so anything the chain accepted a moment later — a
         * proposal the member has just made, or a co-owner's approval — is not on screen yet, and
         * a member with no way to re-read cannot tell a settled queue from a stale one. Always
         * offered, not just for a chain that failed: this is about time passing, not a bad read.
         */}
        <button
          type="button"
          className="custody-link"
          data-testid="vault-queue-refresh"
          onClick={() => refresh?.()}
          disabled={reading}
        >
          {reading ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      {rows.length > 0 && (
        <div className="vault-queue__chips" role="group" aria-label="Filter the queue">
          <button
            type="button"
            className={`vault-queue__chip${filter === 'all' ? ' is-active' : ''}`}
            aria-pressed={filter === 'all'}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          <button
            type="button"
            className={`vault-queue__chip${filter === 'needs-you' ? ' is-active' : ''}`}
            aria-pressed={filter === 'needs-you'}
            onClick={() => setFilter('needs-you')}
            data-testid="vault-queue-chip-needs-you"
          >
            Needs you{needsYouCount > 0 ? ` (${needsYouCount})` : ''}
          </button>
          {rowChainIds.map((cid) => (
            <button
              key={cid}
              type="button"
              className={`vault-queue__chip${Number(filter) === cid ? ' is-active' : ''}`}
              aria-pressed={Number(filter) === cid}
              onClick={() => setFilter(cid)}
              data-testid={`vault-queue-chip-${cid}`}
            >
              {chainDisplayName(cid)}
            </button>
          ))}
        </div>
      )}

      {!reading && rows.length === 0 && entriesCount > 0 && (
        <p className="custody-hint" role="status" data-testid="vault-queue-empty">
          Nothing waiting for a signature.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="vault-queue__rows" aria-label="Pending proposals">
          {visibleRows.map((p) => {
            const chainEntry = byChain[p.chainId] || byChain[String(p.chainId)]
            const owner = Boolean(chainEntry?.owner)
            const remaining = approvalsRemaining(p.approvals, p.threshold)
            const hasApproved = isMine(p)
            const chainName = chainDisplayName(p.chainId)
            const err = rowErrors[p.safeTxHash]
            const waiting = pendingAction && pendingAction.proposal?.safeTxHash === p.safeTxHash
            // Decoded ONLY when positively recognised; anything else keeps the raw presentation.
            const described = describeProposal(p, decodeContext(p.chainId, group.address))
            const needsMe = rowNeedsYou(p)
            return (
              <li
                key={`${p.chainId}:${p.safeTxHash}`}
                className="vault-queue__row"
                data-testid="vault-queue-row"
                data-chain-id={p.chainId}
              >
                <div className="vault-queue__row-head">
                  {described && (
                    <span className="vault-queue__title" data-testid="vault-queue-title">
                      {described.title} <span className="vault-queue__title-on">on {chainName}</span>
                    </span>
                  )}
                  <NetworkPill chainId={Number(p.chainId)} name={chainName} />
                  <span className={`custody-status custody-status--${p.status}`}>{p.status}</span>
                  <span className="custody-proposal-meta">
                    {p.approvals}/{p.threshold} approvals
                    {p.status === STATUS.PENDING && remaining > 0 ? ` · ${remaining} more needed` : ''}
                  </span>
                  <code className="custody-proposal-hash" title={p.safeTxHash} aria-label={`Safe transaction hash ${p.safeTxHash}`}>
                    {shortHash(p.safeTxHash)}
                  </code>
                </div>
                <div className="vault-queue__facts">
                  <RowRecipient address={described?.counterparty || p.to} chainId={Number(p.chainId)} />
                  <span>nonce {String(p.nonce)}</span>
                </div>
                <p className="vault-queue__signed" data-testid="vault-queue-signed" data-needs-you={needsMe ? 'true' : 'false'}>
                  {p.approvals} of {p.threshold} signed
                  {needsMe ? ' · needs you' : hasApproved && p.status === STATUS.PENDING ? ' · waiting on other owners' : ''}
                </p>
                {owner && !canAct ? (
                  /*
                   * An owner whose session cannot sign on THIS network. Before this, the buttons
                   * rendered and the failure arrived from inside the batch sender — a member on
                   * Ethereum Classic tapped Approve and got a chain-support error they had asked
                   * no question to receive. The rail is knowable before the tap, so it is said
                   * before the tap, and it names the way out rather than only the obstacle.
                   */
                  <p className="vault-queue__viewonly" data-testid="vault-queue-norail">
                    {railReason}
                  </p>
                ) : owner ? (
                  <div className="custody-actions">
                    {p.status === STATUS.PENDING && (
                      <button
                        type="button"
                        className={needsMe ? 'vault-queue__primary-action' : undefined}
                        onClick={() => handleAction(p, 'approve')}
                        disabled={busy || hasApproved || Boolean(waiting)}
                      >
                        {hasApproved ? 'Approved' : waiting ? 'Switching…' : 'Approve'}
                      </button>
                    )}
                    {p.status === STATUS.READY && (
                      <button type="button" onClick={() => handleAction(p, 'execute')} disabled={busy || Boolean(waiting)}>
                        {waiting ? 'Switching…' : 'Execute'}
                      </button>
                    )}
                    {(p.status === STATUS.PENDING || p.status === STATUS.READY) && (
                      <button type="button" className="custody-link" onClick={() => handleAction(p, 'cancel')} disabled={busy || Boolean(waiting)}>
                        Cancel
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="vault-queue__viewonly" data-testid="vault-queue-viewonly">
                    view-only on {chainName}
                  </p>
                )}
                {err && (
                  <p className="vault-queue__row-error" role="alert">
                    {err}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <ul className="vault-queue__chains" aria-label="Read status by network">
        {chainIds.map((id) => {
          const entry = byChain[id] || byChain[String(id)]
          const state = entry?.state || (reading ? 'loading' : 'unreadable')
          return (
            <li key={id} data-testid="vault-queue-chain" data-chain-id={id} data-state={state}>
              <span>{chainStatusText(id, entry, reading)}</span>
              {state === 'unreadable' && (
                <>
                  {entry?.error && <span className="sr-only">{entry.error}</span>}
                  <button type="button" className="custody-link" onClick={() => refresh?.(id)} data-testid="vault-queue-retry">
                    Retry
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>

      <p className="vault-queue__footer custody-hint" role="note">
        Queued items stay on their own chain. This list is all of them.
      </p>
    </div>
  )
}

VaultQueueView.propTypes = {
  /** VaultGroup (lib/custody/vaultGroups). */
  group: PropTypes.object.isRequired,
}
