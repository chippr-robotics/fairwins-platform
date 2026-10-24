import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { encodeFunctionData } from 'viem'
import { normalizeAbi } from '../lib/chains/readContract'
import { WalletContext } from '../contexts/WalletContext'
import { useTransfer } from './useTransfer'
import { useActiveAccount } from './useActiveAccount'
import { useEffectiveAccount } from './useEffectiveAccount'
import { useAddressScreening } from './useAddressScreening'
import { isBitcoinNetworkId } from '../config/bitcoinNetworks'
import { BATCH_SUPPORT, mustSplitBatch, previewBatchSupport } from '../lib/custody/batchPreflight'
import { TRANSFER_ABI } from '../lib/transfer/eip3009Transfer'
import { recordTransfer, updateTransfer, TRANSFER_STATUS } from '../lib/transfer/transferStore'
import { appendClientRecord } from '../data/ledger'
import { transferRecordToEntry } from '../data/ledger/sources/transferLedgerSource'
import {
  GROUP_RAIL,
  classifyRecipientAddress,
  describeRail,
  groupPayAvailability,
  parseAmountUnits,
  selectGroupRail,
} from '../lib/payments/groupPay'
import { isPasskeySupported } from '../config/passkeySupport'

/**
 * useGroupPay (release 1.14.0) — pay N recipients with one asset, on whatever rail the acting
 * identity actually has.
 *
 *   passkey account acting as itself → ONE `sendCalls` batch (one ceremony, one transaction)
 *   acting as a vault                → ONE MultiSend proposal (one threshold approval), unless the
 *                                       vault's own policy guard denies delegatecall — then N
 *                                       proposals at consecutive nonces, disclosed before signing
 *   classic wallet / recovered / hardware account → SEQUENTIAL sends through the existing
 *                                       transfer engine, with a per-recipient outcome
 *   anything else (a derived account) → REFUSED, with the reason
 *
 * Three properties are the whole point of the hook:
 *
 *   ONE SUBMISSION WHERE ONE IS POSSIBLE. A member paying five people from a passkey account
 *   confirms once, not five times, and pays one network fee rather than five.
 *
 *   NO ABORT ON THE FIRST FAILURE. On the sequential rail every recipient is attempted and
 *   every recipient gets its own reported outcome — the spec-062 `sweepAllAssets` precedent.
 *   A batch rail is genuinely all-or-nothing and says so instead of pretending otherwise.
 *
 *   SCREENING IS NOT SKIPPABLE. Every recipient is screened at SUBMIT time through the same
 *   seam the single-recipient path uses, forced past the cache (a "clear" from a minute ago is
 *   not a submission-time fact — the spec-067 FR-032 precedent). On a batch rail a flagged
 *   recipient stops the whole submission BEFORE anything is signed: silently dropping one leg
 *   of a batch the member just read and confirmed would submit something they never approved.
 *   On the sequential rail the payments are genuinely independent, so the flagged one is
 *   SKIPPED with its reason and the rest go through.
 */

const ERC20_ABI = normalizeAbi(TRANSFER_ABI)
const OP_STATE = Object.freeze({ INCLUDED: 'included', FAILED: 'failed' })

export const GROUP_OUTCOME = Object.freeze({
  SENT: 'sent',
  PENDING: 'pending',
  PROPOSED: 'proposed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
})

const SCREENING_REASON = 'Flagged by sanctions screening — this payment was not sent.'

/** Mirror a transfer record into the append-only client ledger. Best-effort, exactly as useTransfer. */
function mirrorToLedger(account, record, patch = null, suffix = null) {
  try {
    const entry = transferRecordToEntry({ ...record, ...(patch || {}) }, { account })
    if (!suffix) {
      appendClientRecord(account, entry)
      return
    }
    appendClientRecord(account, {
      ...entry,
      entryId: `${entry.entryId}:${suffix}`,
      recordedAt: Date.now(),
      refs: { ...entry.refs, supersedes: entry.entryId },
    })
  } catch {
    /* the ledger must never break a payment */
  }
}

const summarise = (outcomes, rail, route, { shape = null, batchSupport = null } = {}) => ({
  rail,
  route,
  shape,
  batchSupport,
  total: outcomes.length,
  sent: outcomes.filter((o) => o.status === GROUP_OUTCOME.SENT).length,
  pending: outcomes.filter((o) => o.status === GROUP_OUTCOME.PENDING).length,
  proposed: outcomes.filter((o) => o.status === GROUP_OUTCOME.PROPOSED).length,
  failed: outcomes.filter((o) => o.status === GROUP_OUTCOME.FAILED).length,
  skipped: outcomes.filter((o) => o.status === GROUP_OUTCOME.SKIPPED).length,
})

/**
 * @param {{ asset?: object|null }} [opts] the asset the surface has selected, when it has one —
 *   it is what decides whether the affordance is offered on THIS network (see `available`).
 */
export function useGroupPay({ asset = null } = {}) {
  // Read the wallet context DIRECTLY with a null fallback, the way useEffectiveAccount does: this
  // hook is mounted by two broad send surfaces, and it must not hard-crash one of them in an
  // isolated component test where no WalletProvider is present.
  const { address, chainId, sendCalls } = useContext(WalletContext) ?? {}
  const { isPasskey, send } = useTransfer()
  const { identity, canActAsVault, submit: submitAsActive } = useActiveAccount()
  const { type: actingType, address: effectiveAddress } = useEffectiveAccount()
  const { screenOne } = useAddressScreening()

  const [status, setStatus] = useState('idle') // idle | screening | submitting | done | error
  const [outcomes, setOutcomes] = useState(null)
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState(null)

  const railInfo = useMemo(
    () => selectGroupRail({ actingType, isPasskey, canActAsVault }),
    [actingType, isPasskey, canActAsVault],
  )

  /*
   * Issue #1441 — is the multi-recipient affordance OFFERED here at all? Derived from the rail and
   * the asset's own network, so a surface never renders a control whose submission would not be
   * the one it implies. Keyed on primitives rather than the asset object: `selectedAsset` is a new
   * object on most renders, and an availability that changed identity every render would churn
   * every consumer's memo.
   *
   * `GROUP_PAY_ENABLED` is currently false, so this answers `withdrawn` on every rail. The rest of
   * the hook is untouched and still does exactly what it did — nothing here refuses a submission.
   */
  const availabilityChainId = asset?.chainId ?? chainId ?? null
  const availabilityKind = asset?.kind ?? null
  const availability = useMemo(
    () => groupPayAvailability({
      rail: railInfo.rail,
      railReason: railInfo.reason,
      chainId: availabilityChainId,
      assetKind: availabilityKind,
      passkeySupported: isPasskeySupported(availabilityChainId),
    }),
    [railInfo, availabilityChainId, availabilityKind],
  )

  /*
   * ── Issue #1368: which SHAPE will the vault rail actually create? ───────────────────────────
   * One proposal carrying N payments is a MultiSend, which executes by DELEGATECALL. Both policy
   * guards deny delegatecall once a vault has an active policy, so the batch would be approved by
   * the vault's signers and then revert — on exactly the vaults that followed our own starter-policy
   * guidance. Ask the vault's own guard, once per vault, and let the confirm screen say which shape
   * it is creating BEFORE anything is signed. `unknown` is treated as "split" on this money path
   * (an unconfirmed policy is never assumed to allow a batch) but is disclosed as its own state.
   */
  const vaultAddress = identity?.vaultAddress || (actingType === 'vault' ? effectiveAddress : null)
  const vaultChainId = identity?.chainId ?? null
  const [vaultBatch, setVaultBatch] = useState(null)
  const batchProbe = useRef({ key: null, promise: null })

  const resolveVaultBatch = useCallback((chainIdForRead) => {
    const key = `${String(vaultAddress).toLowerCase()}:${chainIdForRead}`
    if (batchProbe.current.key !== key) {
      batchProbe.current = {
        key,
        promise: Promise.resolve(previewBatchSupport(vaultAddress, chainIdForRead)).catch(() => ({
          support: BATCH_SUPPORT.UNKNOWN,
          reason: "Could not confirm the vault's policy allows a batch.",
          detail: null,
          engine: null,
        })),
      }
    }
    return batchProbe.current.promise
  }, [vaultAddress])

  const onVaultRail = railInfo.rail === GROUP_RAIL.VAULT_PROPOSAL
  useEffect(() => {
    if (!onVaultRail || !vaultAddress || vaultChainId == null) return undefined
    let on = true
    resolveVaultBatch(vaultChainId).then((res) => { if (on) setVaultBatch(res) })
    return () => { on = false }
  }, [onVaultRail, vaultAddress, vaultChainId, resolveVaultBatch])

  const reset = useCallback(() => {
    setStatus('idle')
    setOutcomes(null)
    setSummary(null)
    setError(null)
  }, [])

  const submitGroup = useCallback(async ({ asset, recipients }) => {
    setError(null)
    setOutcomes(null)
    setSummary(null)

    const list = Array.isArray(recipients) ? recipients : []
    if (list.length === 0) throw new Error('Add at least one recipient.')

    // ── Asset scope ────────────────────────────────────────────────────────────────────────
    // Group pay is EVM-only this release. Bitcoin (spec 061) has its own UTXO send pipeline,
    // its own fee ceiling and no batch rail; refusing it by name is more use to a member than
    // a generic "unsupported".
    if (!asset) throw new Error('Choose an asset to pay with.')
    if (asset.kind === 'btc-native' || isBitcoinNetworkId(asset.chainId)) {
      throw new Error('Bitcoin is sent one payment at a time from its own screen — group pay is EVM-only in this release.')
    }
    if (!Number.isFinite(Number(asset.chainId))) {
      throw new Error('Group pay moves value on EVM networks only.')
    }

    const decimals = asset.decimals ?? 18
    const assetChainId = Number(asset.chainId)
    const isNative = asset.kind === 'native' || !asset.address

    // The payments are signed on the connected chain. Both forms gate this with a switch, but a
    // stale selection must never sign against the wrong network (the useTransfer guard, applied to
    // the rails that do not route through it).
    if (Number.isFinite(Number(chainId)) && Number(chainId) !== assetChainId) {
      throw new Error("Switch to this asset's network before paying. Nothing has been signed.")
    }

    // ── Recipient scope ────────────────────────────────────────────────────────────────────
    const prepared = list.map((r) => ({
      id: r.id,
      address: typeof r.address === 'string' ? r.address.trim() : '',
      amount: r.amount,
      units: parseAmountUnits(r.amount, decimals),
      cls: classifyRecipientAddress(typeof r.address === 'string' ? r.address.trim() : ''),
    }))

    const foreign = prepared.find((p) => p.cls.kind !== 'evm')
    if (foreign) {
      throw new Error(
        foreign.cls.label
          ? `${foreign.address} is a ${foreign.cls.label} address. Group pay moves value on this network only — ` +
            `send ${foreign.cls.label} from its own screen. Nothing has been signed.`
          : `${foreign.address || 'One recipient'} is not an address on this network. Nothing has been signed.`,
      )
    }
    const badAmount = prepared.find((p) => p.units == null)
    if (badAmount) {
      throw new Error(`The amount for ${badAmount.address} is not a payable amount. Nothing has been signed.`)
    }

    // ── Rail ───────────────────────────────────────────────────────────────────────────────
    if (railInfo.rail === GROUP_RAIL.REFUSED) throw new Error(railInfo.reason)
    if (railInfo.rail === GROUP_RAIL.BATCH_PASSKEY && typeof sendCalls !== 'function') {
      throw new Error('This account cannot batch payments right now, so nothing has been signed.')
    }
    // The vault's guard decides the SHAPE, and it must be resolved before screening: a split batch
    // is N independent proposals, so a flagged recipient is skipped rather than stopping the rest.
    let batchSupport = null
    if (railInfo.rail === GROUP_RAIL.VAULT_PROPOSAL) {
      const probe = await resolveVaultBatch(vaultChainId ?? assetChainId)
      batchSupport = probe.support
      setVaultBatch(probe)
    }
    const { atomic, shape } = describeRail(railInfo.rail, { count: prepared.length, batchSupport })

    // ── Screening, per recipient, forced past the cache ────────────────────────────────────
    setStatus('screening')
    const statuses = await Promise.all(
      prepared.map((p) =>
        Promise.resolve(screenOne(p.address, assetChainId, { force: true })).catch(() => 'uncertain'),
      ),
    )
    const flagged = prepared.filter((_, i) => statuses[i] === 'restricted')
    if (flagged.length > 0 && atomic) {
      setStatus('error')
      throw new Error(
        `Sanctions screening flags ${flagged.map((f) => f.address).join(', ')}. ` +
        'Nothing has been signed — remove them and try again.',
      )
    }
    const blockedIds = new Set(flagged.map((f) => f.id))

    setStatus('submitting')
    const payable = prepared.filter((p) => !blockedIds.has(p.id))
    const skippedOutcomes = prepared
      .filter((p) => blockedIds.has(p.id))
      .map((p) => ({
        id: p.id, address: p.address, amount: p.amount, symbol: asset.symbol,
        status: GROUP_OUTCOME.SKIPPED, txHash: null, reason: SCREENING_REASON,
      }))

    const legFor = (p) => (isNative
      ? { to: p.address, value: p.units, data: '0x' }
      : { to: asset.address, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [p.address, p.units] }) })

    const base = (p) => ({ id: p.id, address: p.address, amount: p.amount, symbol: asset.symbol })

    let results = []
    let route = null

    try {
      if (railInfo.rail === GROUP_RAIL.BATCH_PASSKEY) {
        // ONE UserOp carrying every payment.
        const calls = payable.map((p) => (isNative
          ? { target: p.address, data: '0x', value: p.units }
          : { target: asset.address, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [p.address, p.units] }), value: 0n }))

        // One Activity record per RECIPIENT: a member who paid five people must see five
        // payments, even though they share one transaction hash.
        const entries = payable.map((p) => {
          try {
            const entry = recordTransfer(address, {
              chainId: assetChainId,
              kind: isNative ? 'native' : 'token',
              symbol: asset.symbol,
              decimals,
              amount: String(p.amount),
              from: effectiveAddress || address,
              to: p.address,
              route: 'gasless',
            })
            mirrorToLedger(address, entry)
            return entry
          } catch {
            return null
          }
        })

        const res = await sendCalls(calls, {
          onState: (s) => { if (s?.state && s.state !== OP_STATE.INCLUDED) setStatus('pending') },
        })
        route = res?.sponsored === true ? 'gasless' : 'self'

        if (res?.state === OP_STATE.FAILED) {
          const reason = res.reason || 'The batch reverted on-chain and nothing was sent.'
          results = payable.map((p) => ({ ...base(p), status: GROUP_OUTCOME.FAILED, txHash: null, reason }))
          entries.forEach((e) => {
            if (!e) return
            updateTransfer(address, e.id, { status: TRANSFER_STATUS.FAILED, error: reason })
            mirrorToLedger(address, e, { status: TRANSFER_STATUS.FAILED, error: reason }, 'fail')
          })
        } else if (res?.state && res.state !== OP_STATE.INCLUDED) {
          // Submitted but not included. A userOpHash is NOT a transaction hash — carry it as its
          // own field and leave txHash null (spec 041 honest lifecycle).
          const ref = res.userOpHash ?? res.intentId ?? null
          results = payable.map((p) => ({
            ...base(p), status: GROUP_OUTCOME.PENDING, txHash: null, userOpHash: ref,
            reason: 'Submitted — still confirming on-chain.',
          }))
          entries.forEach((e) => {
            if (!e) return
            updateTransfer(address, e.id, { status: TRANSFER_STATUS.IN_PROCESS, route, userOpHash: ref })
            mirrorToLedger(address, e, { status: TRANSFER_STATUS.IN_PROCESS, route }, 'submitted')
          })
        } else {
          const txHash = res?.txHash ?? null
          results = payable.map((p) => ({ ...base(p), status: GROUP_OUTCOME.SENT, txHash, reason: null }))
          entries.forEach((e) => {
            if (!e) return
            updateTransfer(address, e.id, { status: TRANSFER_STATUS.COMPLETE, txHash, route })
            mirrorToLedger(address, e, { status: TRANSFER_STATUS.COMPLETE, txHash, route }, 'done')
          })
        }
      } else if (railInfo.rail === GROUP_RAIL.VAULT_PROPOSAL && !mustSplitBatch(batchSupport)) {
        // ONE threshold-gated proposal whose MultiSend carries every payment (the spec-098
        // membership precedent). Nothing is paid here — the vault's signers execute it.
        route = 'vault'
        try {
          const res = await submitAsActive({ batch: payable.map(legFor) })
          results = payable.map((p) => ({
            ...base(p), status: GROUP_OUTCOME.PROPOSED, txHash: null,
            safeTxHash: res?.safeTxHash ?? null, reason: null,
          }))
        } catch (err) {
          const reason = err?.shortMessage || err?.message || 'Could not create the vault proposal.'
          results = payable.map((p) => ({ ...base(p), status: GROUP_OUTCOME.FAILED, txHash: null, reason }))
        }
      } else if (railInfo.rail === GROUP_RAIL.VAULT_PROPOSAL) {
        /*
         * Issue #1368 — the vault's guard denies delegatecall (or could not be read), so a
         * MultiSend proposal would be approved and then revert. One proposal per recipient instead.
         *
         * The nonces MUST be consecutive: proposals sharing a nonce are mutually exclusive on a
         * Safe (executing one invalidates the rest), so N same-nonce proposals would leave exactly
         * one payment executable. The first read is the vault's live nonce; each success advances
         * it. A FAILURE consumes no nonce, so the next attempt re-uses that slot — a gap would make
         * every proposal after it permanently unexecutable, which is the one way this fallback
         * could be worse than the bug it fixes.
         */
        route = 'vault'
        let nextNonce = null
        for (const p of payable) {
          const leg = legFor(p)
          try {
            const res = await submitAsActive(nextNonce == null ? leg : { ...leg, nonce: nextNonce })
            if (res?.nonce != null) nextNonce = Number(res.nonce) + 1
            results.push({
              ...base(p), status: GROUP_OUTCOME.PROPOSED, txHash: null,
              safeTxHash: res?.safeTxHash ?? null, reason: null,
            })
          } catch (err) {
            results.push({
              ...base(p), status: GROUP_OUTCOME.FAILED, txHash: null,
              reason: err?.shortMessage || err?.message || 'Could not create this proposal.',
            })
          }
        }
      } else {
        // Sequential: the existing engine per recipient, so each payment keeps its own gasless
        // routing, its own Activity record and its own honest lifecycle. One failure never
        // stops the rest.
        for (const p of payable) {
          try {
            const res = await send({ asset, to: p.address, amount: String(p.amount) })
            if (!route) route = res?.route ?? null
            if (res?.proposed) {
              results.push({ ...base(p), status: GROUP_OUTCOME.PROPOSED, txHash: null, safeTxHash: res.safeTxHash ?? null, reason: null })
            } else if (res?.pending) {
              results.push({
                ...base(p), status: GROUP_OUTCOME.PENDING, txHash: null,
                userOpHash: res.userOpHash ?? null, reason: 'Submitted — still confirming on-chain.',
              })
            } else {
              results.push({ ...base(p), status: GROUP_OUTCOME.SENT, txHash: res?.txHash ?? null, reason: null })
            }
          } catch (err) {
            results.push({
              ...base(p), status: GROUP_OUTCOME.FAILED, txHash: null,
              reason: err?.shortMessage || err?.message || 'This payment failed.',
            })
          }
        }
      }
    } catch (err) {
      // A rail-level throw (a batch that could not even be submitted) is still reported per
      // recipient — nothing was sent, and the member should see that for every row.
      const reason = err?.shortMessage || err?.message || 'The payment could not be submitted.'
      results = payable.map((p) => ({ ...base(p), status: GROUP_OUTCOME.FAILED, txHash: null, reason }))
    }

    // Outcomes stay in the member's own row order, skipped ones included.
    const byId = new Map([...results, ...skippedOutcomes].map((o) => [o.id, o]))
    const ordered = prepared.map((p) => byId.get(p.id)).filter(Boolean)
    const nextSummary = summarise(ordered, railInfo.rail, route, { shape, batchSupport })

    setOutcomes(ordered)
    setSummary(nextSummary)
    setStatus('done')
    return { outcomes: ordered, summary: nextSummary }
  }, [address, chainId, effectiveAddress, railInfo, screenOne, sendCalls, submitAsActive, send, resolveVaultBatch, vaultChainId])

  const submitGroupSafely = useCallback(async (payload) => {
    try {
      return await submitGroup(payload)
    } catch (err) {
      setStatus('error')
      setError(err?.shortMessage || err?.message || 'The payment could not be submitted.')
      throw err
    }
  }, [submitGroup])

  return useMemo(() => ({
    rail: railInfo.rail,
    railReason: railInfo.reason,
    // Issue #1441 — whether the surface should offer the affordance at all, and why not when it
    // should not. Never a reason to hide an OUTCOME: a payment already submitted is still reported.
    available: availability.available,
    unavailableCode: availability.code,
    unavailableReason: availability.reason,
    // Issue #1368 — the resolved batch shape for the vault rail, so the confirm screen can state
    // which one it will create (and why) before the member signs. Null on every other rail.
    vaultBatch: onVaultRail ? vaultBatch : null,
    status,
    outcomes,
    summary,
    error,
    submitGroup: submitGroupSafely,
    reset,
  }), [railInfo, availability, onVaultRail, vaultBatch, status, outcomes, summary, error, submitGroupSafely, reset])
}

export default useGroupPay
