import { useEffect, useMemo, useState } from 'react'
import { formatUnits, parseUnits } from '../../lib/evm/units'
import Button from '../ui/Button'
import SensitiveValue from '../common/SensitiveValue'
import { useWallet } from '../../hooks/useWalletManagement'
import { payoutMatrixHash, payoutMatrixSum, serializeMatrix, parseMatrix } from '../../lib/pools/payout'
import { saveProposedMatrix } from '../../lib/pools/proposalStore'
import { sortParticipants } from '../../lib/pools/participantOrder'

/**
 * PoolResolutionActions (spec 034, address-based) — the resolution loop with no "claim code": a member's
 * wallet ADDRESS is their identity in the payout matrix.
 *
 *  - The creator builds ONE row per participant (auto-seeded from the roster in rank order) — no manual
 *    "add winner" row — and enters an amount per member. Proposing shares an annotated payout the whole
 *    group can see (medals/amounts land on the roster cards), and can be REVISED if the operator mis-keyed.
 *  - Members who disagree can construct a suggested alternative split to send the creator (off-chain);
 *    if the group never approves, the resolution window lapses and everyone is refunded.
 *  - Claiming is one tap: the app fills the matrix, finds the row whose winner is the connected wallet,
 *    and pays that wallet (or any address the member chooses).
 *
 * Verification of the proposal against the on-chain proposalId happens in the parent (PoolPage), which
 * passes the verified `payoutByAddress` down; this component reflects it and drives the actions.
 */
export default function PoolResolutionActions({
  summary,
  pools,
  participants = null,
  rankOrder = null,
  verifiedProposal = null,
  payoutByAddress = null,
  onProposalReceived,
  onChanged,
}) {
  const { proposeOutcome, claimWinnings, status } = pools
  const { account } = useWallet()
  const decimals = summary.tokenDecimals || 6
  const escrow = BigInt(summary.frozenDenominator || summary.memberCount || 0) * BigInt(summary.buyIn || 0)

  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard?.writeText(text)
    } catch {
      /* clipboard unavailable (private mode / no permission) — non-fatal */
    }
  }

  // ── Creator: build / revise the payout (one row per participant, amount only — winner = address) ──
  const orderedParticipants = useMemo(
    () => (participants ? sortParticipants(participants, rankOrder) : []),
    [participants, rankOrder]
  )
  const [rows, setRows] = useState([])
  // Seed one row per participant, prefilling amounts from an existing proposal (revise) when present.
  useEffect(() => {
    if (!orderedParticipants.length) return
    const priorByAddress = new Map(
      (verifiedProposal?.entries || []).map((e) => [String(e.winner).toLowerCase(), e.amount])
    )
    setRows((rs) => {
      const pristine = rs.length === 0 || rs.every((r) => !r.amount)
      if (!pristine && rs.length === orderedParticipants.length) return rs
      return orderedParticipants.map((p) => {
        const prior = priorByAddress.get(String(p.address).toLowerCase())
        return {
          address: p.address,
          label: p.nickname.label,
          amount: prior != null ? formatUnits(BigInt(prior), decimals) : '',
        }
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedParticipants, verifiedProposal])
  const setRow = (i, k) => (e) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)))

  const filled = rows.filter((r) => r.amount && Number(r.amount) > 0)
  const entries = filled.map((r) => ({ winner: r.address, amount: parseUnits(String(r.amount || '0'), decimals) }))
  const anyFilled = filled.length > 0
  const sum = anyFilled ? payoutMatrixSum(entries) : 0n
  const sumOk = anyFilled && sum === escrow
  const proposalId = sumOk ? payoutMatrixHash(entries) : null
  const isRevision = Boolean(summary.currentProposalId)

  const propose = async () => {
    setNotice(null)
    setBusy(true)
    try {
      // Commit the full matrix on-chain (validated + emitted by the contract); the id is derived from it.
      await proposeOutcome(summary.address, entries)
      saveProposedMatrix(summary.address, proposalId, entries)
      await copyToClipboard(serializeMatrix(entries))
      setNotice(isRevision
        ? 'Updated. The revised payout is on-chain and copied — the group can review and approve it.'
        : 'Proposed. The payout is on-chain and copied — the group can review and approve it.')
      onChanged?.()
    } catch (e) {
      setNotice(e?.shortMessage || e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  // ── Member: receive the creator's shared payout (pasted once, verified against the on-chain id) ──
  const [pasteText, setPasteText] = useState('')
  const receiveShared = () => {
    setNotice(null)
    const parsed = parseMatrix(pasteText)
    if (!parsed || !parsed.length) { setNotice('Could not read that payout. Ask the creator to re-copy and resend it.'); return }
    if (!summary.currentProposalId || payoutMatrixHash(parsed) !== summary.currentProposalId) {
      setNotice('That payout does NOT match the one proposed on-chain — do not approve based on it.')
      return
    }
    saveProposedMatrix(summary.address, summary.currentProposalId, parsed)
    setPasteText('')
    onProposalReceived?.()
  }

  // ── Member: suggest a different split (off-chain counter-proposal) ─────────────────────────────
  const [disputeOpen, setDisputeOpen] = useState(false)
  const [disputeRows, setDisputeRows] = useState([])
  useEffect(() => {
    if (disputeOpen && disputeRows.length === 0 && orderedParticipants.length) {
      setDisputeRows(orderedParticipants.map((p) => ({ label: p.nickname.label, amount: '' })))
    }
  }, [disputeOpen, disputeRows.length, orderedParticipants])
  const shareDispute = async () => {
    const text = disputeRows
      .filter((r) => r.amount)
      .map((r) => `${r.label}: ${r.amount} ${summary.tokenSymbol}`)
      .join('\n')
    await copyToClipboard(`Suggested split:\n${text}`)
    setNotice('Your suggested split is copied — send it to the creator, who can revise the proposal.')
  }

  // ── Winner: one-tap claim (matrix + row auto-resolved by connected wallet; pays it by default) ──
  const claimEntries = verifiedProposal?.entries || null
  const myAmount = payoutByAddress && account ? payoutByAddress.get(String(account).toLowerCase()) : null
  const [recipient, setRecipient] = useState('')
  const [showAdvancedClaim, setShowAdvancedClaim] = useState(false)
  useEffect(() => { if (account && !recipient) setRecipient(account) }, [account, recipient])

  const claim = async () => {
    setNotice(null)
    setBusy(true)
    try {
      const parsed = claimEntries || parseMatrix(pasteText)
      if (!parsed || !parsed.length) throw new Error('No payout to claim from yet — receive the creator’s payout first.')
      const idx = account
        ? parsed.findIndex((e) => String(e.winner).toLowerCase() === String(account).toLowerCase())
        : -1
      if (idx < 0) throw new Error('Your wallet is not listed in the payout. Ask the creator to include your address.')
      await claimWinnings(summary.address, {
        entries: parsed.map((e) => ({ winner: e.winner, amount: e.amount })),
        index: idx,
        recipient: recipient || account,
      })
      setNotice('Claimed — your winnings are on the way.')
      onChanged?.()
    } catch (e) {
      setNotice(e?.shortMessage || e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  const hasProposalOnChain = summary.state === 1 && summary.currentProposalId
  const memberNeedsToReceive = summary.hasJoined && !summary.isCreator && hasProposalOnChain && !verifiedProposal

  return (
    <section className="pool-resolution-actions" aria-label="Resolution actions">
      {/* Member: FALLBACK only. The proposed payout is normally read straight from the chain
          (OutcomeProposed) and shown on the roster automatically; this paste box appears just when a
          member's RPC can't serve logs, so they can review + verify the creator's shared copy instead. */}
      {memberNeedsToReceive && (
        <div className="pool-receive" data-testid="receive-proposal">
          <h2>Review the proposed payout</h2>
          <p>
            The proposed split is normally read straight from the chain. If it didn&apos;t load here, paste
            the payout the creator shared — we&apos;ll verify it matches the on-chain proposal before you approve.
          </p>
          <label htmlFor="receive-shared">Payout the creator shared</label>
          <textarea id="receive-shared" rows={3} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
          <Button onClick={receiveShared} disabled={!pasteText.trim()}>Review payout</Button>
        </div>
      )}

      {/* Member: verified confirmation (the amounts render on the roster cards above) */}
      {summary.hasJoined && !summary.isCreator && summary.state === 1 && verifiedProposal && (
        <div className="pool-proposal-details" data-testid="proposal-details">
          <p data-testid="proposal-verified">
            Proposed payout verified against the chain ✓ — see the highlighted standings above. Approving locks it in.
          </p>
          <button type="button" className="pool-link-btn" onClick={() => setDisputeOpen((v) => !v)} data-testid="dispute-toggle">
            {disputeOpen ? 'Never mind' : 'Suggest a different split'}
          </button>
          {disputeOpen && (
            <div className="pool-dispute" data-testid="dispute-builder">
              <p className="pool-hint">
                Don’t approve if you disagree. You can send the creator a suggested split; if the group never
                approves, the window lapses and everyone is refunded.
              </p>
              {disputeRows.map((r, i) => (
                <div className="pool-propose-row" key={i}>
                  <span className="pool-propose-nick">{r.label}</span>
                  <input
                    aria-label={`Suggested amount for ${r.label}`}
                    type="number" min="0" step="0.01" placeholder="amount"
                    value={r.amount}
                    onChange={(e) => setDisputeRows((rs) => rs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  />
                </div>
              ))}
              <Button variant="secondary" onClick={shareDispute}>Copy my suggestion for the creator</Button>
            </div>
          )}
        </div>
      )}

      {/* Creator: build / revise the payout — one row per participant, amount only (winner = address) */}
      {summary.isCreator && summary.state === 1 && summary.withinResolutionWindow && (
        <div className="pool-propose" data-testid="propose-builder">
          <h2>{isRevision ? 'Update the proposed payout' : 'Propose the payout'}</h2>
          <p>
            One row per member, in your rank order. Enter each member&apos;s amount; the total must equal the
            escrow (<SensitiveValue>{`${formatUnits(escrow, decimals)} ${summary.tokenSymbol}`}</SensitiveValue>). Leave a member blank to
            give them no payout — their wallet address is their claim.
          </p>
          {rows.length === 0 && <p className="pool-hint">Waiting for members to join…</p>}
          {rows.map((r, i) => (
            <div className="pool-propose-row" key={r.address}>
              <span className="pool-propose-nick" data-testid={`propose-nick-${i}`}>{r.label}</span>
              <input
                aria-label={`Amount for ${r.label}`}
                type="number" min="0" step="0.01" placeholder="amount"
                value={r.amount}
                onChange={setRow(i, 'amount')}
              />
            </div>
          ))}
          <div className="pool-propose-controls">
            {anyFilled && !sumOk && (
              <span className="form-error" role="alert">
                Total <SensitiveValue>{formatUnits(sum, decimals)}</SensitiveValue> ≠ escrow <SensitiveValue>{formatUnits(escrow, decimals)}</SensitiveValue>
              </span>
            )}
            <Button data-testid="propose-outcome" onClick={propose} disabled={!sumOk || busy}>
              {busy ? 'Submitting…' : isRevision ? 'Update payout' : 'Propose payout'}
            </Button>
          </div>
        </div>
      )}

      {/* Resolved: one-tap claim */}
      {summary.state === 2 && (
        <div className="pool-claim" data-testid="claim-form">
          <h2>Claim your winnings</h2>
          {myAmount != null && myAmount > 0n && (
            <p data-testid="claim-amount">Your share: <SensitiveValue as="strong">{`${formatUnits(myAmount, decimals)} ${summary.tokenSymbol}`}</SensitiveValue></p>
          )}
          <Button data-testid="claim" onClick={claim} disabled={busy || status === 'claiming'}>
            {busy || status === 'claiming' ? 'Claiming…' : 'Claim to my wallet'}
          </Button>
          <button type="button" className="pool-link-btn" onClick={() => setShowAdvancedClaim((v) => !v)}>
            {showAdvancedClaim ? 'Hide options' : 'Claim to a different address / paste payout'}
          </button>
          {showAdvancedClaim && (
            <div className="pool-claim-advanced">
              <label htmlFor="claim-recipient">Pay to address</label>
              <input id="claim-recipient" placeholder="0x… (any address)" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
              {!claimEntries && (
                <>
                  <label htmlFor="claim-matrix">Payout the creator shared</label>
                  <textarea id="claim-matrix" rows={3} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {notice && <p role="alert" className="pool-resolution-notice" data-testid="pool-resolution-notice">{notice}</p>}
    </section>
  )
}
