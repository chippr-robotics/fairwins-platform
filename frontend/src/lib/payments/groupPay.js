/**
 * Group pay (release 1.14.0) — the pure half: recipient-list validation, rail selection and
 * the disclosure copy that has to be true before a member signs.
 *
 * SCOPE, stated once so nothing has to infer it:
 *
 *   - ONE asset per batch. A group payment moves the asset the member already selected on the
 *     Pay / Transfer form to N recipients; it does not mix assets. Native coin and any ERC-20
 *     on the CONNECTED EVM chain are both in scope, because both are a single call shape the
 *     batch rails already carry (a value move, or `transfer(to, value)`).
 *   - EVM ONLY this release. Bitcoin (spec 061) and the passkey-native Solana / Zcash accounts
 *     (specs 100 / 101) have their own send pipelines, their own fee models and no batch rail.
 *     A recipient on one of those chains is REFUSED — and the refusal names the chain, because
 *     "invalid address" would be a false statement about a perfectly good address.
 *
 * Two judgements are deliberate and are the reason this file exists rather than a pile of
 * inline `if`s:
 *
 *   REFUSED vs FLAGGED. A recipient that cannot be paid (bad address, wrong chain, sanctioned)
 *   is blocking. A recipient that is merely SURPRISING — the same address twice, your own
 *   address — is flagged and left to the member. Paying one person two amounts in one batch is
 *   a normal thing to want (two invoices), and so is moving value to your own second account.
 *   Refusing either would be the app deciding it knows better; saying what will happen is the
 *   honest middle.
 *
 *   BASE UNITS, ALWAYS. The total is summed as bigint base units and formatted once, so a
 *   confirm screen never shows 0.30000000000000004 and the amount the member reads is exactly
 *   the amount the calls carry.
 */

import { isAddress } from 'viem'
import { formatUnits, parseUnits } from '../evm/units'
import { BATCH_SUPPORT } from '../custody/batchPreflight'
import { classifyAddress } from '../bitcoin/addresses'
import { isBitcoinNetworkId } from '../../config/bitcoinNetworks'
import { isValidSolanaAddress } from '../solana/address'

/**
 * A batch this size already asks a member to check twenty numbers on one screen, and a single
 * transaction carrying more than this starts running at the block gas limit on the batch rails.
 * The cap is a product limit, not a protocol one — it is stated to the member rather than
 * silently truncating the list.
 */
export const MAX_GROUP_RECIPIENTS = 20

export const RECIPIENT_ISSUE = Object.freeze({
  EMPTY: 'empty',
  UNRESOLVED: 'unresolved',
  INVALID_ADDRESS: 'invalid_address',
  NON_EVM: 'non_evm',
  INVALID_AMOUNT: 'invalid_amount',
  DUPLICATE: 'duplicate',
  SELF: 'self',
  RESTRICTED: 'restricted',
})

/**
 * Issue #1441 — the multi-recipient affordance is WITHDRAWN from both send surfaces.
 *
 * It was offered unconditionally. On the sequential rail — a browser wallet, a hardware device,
 * an unlocked recovered key, which is most members — "group pay" is N separate transactions with
 * N confirmations and N fees, and on a chain with no bundler the passkey batch cannot be
 * submitted at all. A control that reads as "pay these people together" while producing that is
 * telling the member something untrue before they even reach the confirm screen, which is the
 * one place the app currently corrected it.
 *
 * So the control is removed rather than narrowed, and nothing else is: the engine
 * (`hooks/useGroupPay.js`), this module, the recipient list, the confirm breakdown and the
 * outcome list all stay exactly as they are, exercised by their own tests. THIS FLAG IS THE ONE
 * LEVER. `groupPayAvailability` below already encodes the per-rail and per-network conditions
 * that were the alternative to withdrawing it; flipping this to `true` re-enables the affordance
 * under them, and the e2e specs are guarded by the same fact rather than deleted.
 *
 * Bringing it back is tracked as #1538.
 */
export const GROUP_PAY_ENABLED = false

export const GROUP_RAIL = Object.freeze({
  BATCH_PASSKEY: 'passkey-batch',
  VAULT_PROPOSAL: 'vault-proposal',
  SEQUENTIAL: 'sequential',
  REFUSED: 'refused',
})

/** Human network names for the non-EVM chains a member can plausibly paste an address from. */
const NON_EVM_LABEL = Object.freeze({
  bitcoin: 'Bitcoin',
  solana: 'Solana',
  zcash: 'Zcash',
})

// Zcash transparent (t1/t3, testnet tm/t2), Sapling (zs1, testnet ztestsapling1) and unified
// (u1, testnet utest1) prefixes. Checked BEFORE Bitcoin and Solana: a t-address is base58check
// like a Bitcoin legacy address and would otherwise fall through to "unknown", which tells the
// member nothing about why their address was refused.
const ZCASH_PREFIX = /^(t1|t3|tm|t2|zs1|ztestsapling1|zc|u1|utest1)/

let seq = 0

/**
 * What chain does this string look like an address for? Never throws.
 * @returns {{ kind: 'empty'|'evm'|'bitcoin'|'solana'|'zcash'|'unknown', label: string|null }}
 */
export function classifyRecipientAddress(raw) {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s === '') return { kind: 'empty', label: null }
  if (isAddress(s)) return { kind: 'evm', label: null }
  if (ZCASH_PREFIX.test(s)) return { kind: 'zcash', label: NON_EVM_LABEL.zcash }
  for (const net of ['bitcoin', 'bitcoin-testnet']) {
    try {
      if (classifyAddress(s, net).valid) return { kind: 'bitcoin', label: NON_EVM_LABEL.bitcoin }
    } catch {
      /* a classifier that cannot answer is not evidence of anything */
    }
  }
  if (isValidSolanaAddress(s)) return { kind: 'solana', label: NON_EVM_LABEL.solana }
  return { kind: 'unknown', label: null }
}

/** A blank recipient row. Ids are list-local and only need to be unique within a draft. */
export function makeRecipient(init = {}) {
  seq += 1
  return { id: `gp${seq}`, raw: '', address: '', amount: '', ...init }
}

/** Parse one amount into base units, or null when it is not a payable amount. */
export function parseAmountUnits(amount, decimals) {
  const s = String(amount ?? '').trim()
  if (s === '') return null
  let units
  try {
    units = parseUnits(s, decimals)
  } catch {
    return null // unparseable, or more decimal places than the asset has
  }
  return units > 0n ? units : null
}

/** Format base units for display, trimming the trailing zeros ("0.300000" → "0.3"). */
export function formatAmount(units, decimals) {
  const s = formatUnits(units, decimals)
  const trimmed = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
  return trimmed === '' ? '0' : trimmed
}

const issue = (code, message, blocking) => ({ code, message, blocking })

/**
 * Validate a recipient list against the selected asset, the acting account's balance and
 * whatever screening statuses are known so far.
 *
 * @param {Array<{id,raw?,address,amount}>} recipients
 * @param {object} opts
 *   decimals     the selected asset's decimals (amounts are parsed against it)
 *   symbol       for messages
 *   balance      the acting account's balance as a number, or null while it is unknown — an
 *                unknown balance never blocks (honest state: we do not know that it is short)
 *   selfAddress  the acting account's own address, lowercased or not
 *   screening    { [lowercased address]: 'clear'|'restricted'|'uncertain' }
 *   max          batch cap (defaults to MAX_GROUP_RECIPIENTS)
 */
export function validateRecipients(recipients, {
  decimals = 18,
  symbol = '',
  balance = null,
  selfAddress = null,
  screening = {},
  max = MAX_GROUP_RECIPIENTS,
} = {}) {
  const list = Array.isArray(recipients) ? recipients : []
  const self = selfAddress ? String(selfAddress).toLowerCase() : null

  const counts = new Map()
  for (const r of list) {
    const key = typeof r?.address === 'string' && isAddress(r.address.trim()) ? r.address.trim().toLowerCase() : null
    if (key) counts.set(key, (counts.get(key) || 0) + 1)
  }

  let totalUnits = 0n
  let anyBlocking = false

  const rows = list.map((r) => {
    const issues = []
    // A row carries what RESOLVED (address book / callsign / ENS / a typed 0x) and what was
    // TYPED. Judge the resolved value when there is one; fall back to the typed text so a
    // Bitcoin or Solana address — which never resolves on an EVM chain — is refused as what it
    // actually is instead of as an empty row.
    const resolved = typeof r?.address === 'string' ? r.address.trim() : ''
    const typed = typeof r?.raw === 'string' ? r.raw.trim() : ''
    const subject = resolved || typed
    const cls = classifyRecipientAddress(subject)
    const looksLikeName = !resolved && (/\.[a-z]{2,}$/i.test(typed) || typed.startsWith('%'))

    if (cls.kind === 'empty') {
      issues.push(issue(RECIPIENT_ISSUE.EMPTY, 'Add an address, or remove this row.', true))
    } else if (looksLikeName) {
      issues.push(issue(RECIPIENT_ISSUE.UNRESOLVED, "This name hasn't resolved to an address yet.", true))
    } else if (cls.kind === 'evm') {
      const key = subject.toLowerCase()
      if ((counts.get(key) || 0) > 1) {
        issues.push(issue(
          RECIPIENT_ISSUE.DUPLICATE,
          'This address appears more than once — each row is paid separately.',
          false,
        ))
      }
      if (self && key === self) {
        issues.push(issue(RECIPIENT_ISSUE.SELF, "This is your own address — you'll be paying yourself.", false))
      }
      if (screening[key] === 'restricted') {
        issues.push(issue(
          RECIPIENT_ISSUE.RESTRICTED,
          'This address is flagged by sanctions screening. Payments to it are blocked.',
          true,
        ))
      }
    } else if (cls.label) {
      issues.push(issue(
        RECIPIENT_ISSUE.NON_EVM,
        `That is a ${cls.label} address. Group pay moves ${symbol || 'this asset'} on this network only — ` +
        `send ${cls.label} from its own screen instead.`,
        true,
      ))
    } else {
      issues.push(issue(RECIPIENT_ISSUE.INVALID_ADDRESS, "That doesn't look like an address on this network.", true))
    }

    const units = parseAmountUnits(r?.amount, decimals)
    if (units == null) {
      issues.push(issue(
        RECIPIENT_ISSUE.INVALID_AMOUNT,
        `Enter an amount greater than zero${Number.isFinite(decimals) ? ` with at most ${decimals} decimal places` : ''}.`,
        true,
      ))
    } else {
      totalUnits += units
    }

    const blocked = issues.some((i) => i.blocking)
    if (blocked) anyBlocking = true
    return { ...r, address: resolved, units, issues, blocked, flagged: issues.some((i) => !i.blocking) }
  })

  const tooMany = list.length > max
  const total = formatAmount(totalUnits, decimals)
  // Compared as numbers, exactly as the single-recipient path does: the balance itself arrives
  // from the portfolio as a JS number, so parsing it back into base units would refuse perfectly
  // ordinary balances (a float with more places than the asset has). A balance we do not know yet
  // (null) never blocks — not knowing is not the same as being short.
  const overBalance =
    balance != null && Number.isFinite(Number(balance)) ? Number(total) > Number(balance) : false

  return {
    rows,
    count: list.length,
    totalUnits,
    total,
    overBalance,
    tooMany,
    blocking: anyBlocking || tooMany || overBalance || list.length === 0,
  }
}

/**
 * Which submission rail does the CURRENT identity get? Derived from the acting identity alone
 * — never from what the connected wallet happens to be able to do.
 *
 * Spec 088 FR-002 applies here as it does at the submit seam: there is no fall-through. An
 * acting kind with no branch is REFUSED, not quietly signed for by the connected wallet.
 *
 * @param {{ actingType?: string, isPasskey?: boolean, canActAsVault?: boolean }} params
 * @returns {{ rail: string, reason: string|null }}
 */
export function selectGroupRail({ actingType = 'personal', isPasskey = false, canActAsVault = false } = {}) {
  switch (actingType) {
    case 'personal':
      return { rail: isPasskey ? GROUP_RAIL.BATCH_PASSKEY : GROUP_RAIL.SEQUENTIAL, reason: null }
    case 'vault':
      return canActAsVault
        ? { rail: GROUP_RAIL.VAULT_PROPOSAL, reason: null }
        : {
            rail: GROUP_RAIL.REFUSED,
            reason: "Switch to the vault's network to propose a payment from it. Nothing has been signed.",
          }
    case 'legacy':
    case 'hardware':
      // These accounts sign one transaction at a time — there is no batch to sign.
      return { rail: GROUP_RAIL.SEQUENTIAL, reason: null }
    default:
      return {
        rail: GROUP_RAIL.REFUSED,
        reason:
          'This account cannot send payments here yet, so nothing has been signed. Switch back to acting as ' +
          'yourself to pay from your own account.',
      }
  }
}

export const GROUP_UNAVAILABLE = Object.freeze({
  /** The affordance is switched off outright — issue #1441. */
  WITHDRAWN: 'withdrawn',
  /** Bitcoin / Solana / Zcash: their own send pipelines, no batch rail (spec 061 and friends). */
  NON_EVM: 'non_evm',
  /** The acting identity cannot send here at all — `selectGroupRail` already said why. */
  RAIL_REFUSED: 'rail_refused',
  /** The signer signs one transaction at a time: N sends, not one batch. */
  NO_BATCH_RAIL: 'no_batch_rail',
  /** A passkey account on a chain with no bundler — the UserOp has nowhere to go. */
  CHAIN_NO_BATCH: 'chain_no_batch',
})

/**
 * Should the multi-recipient affordance be OFFERED at all? Answered before anything is typed, so
 * a member is never shown a control whose submission would not be the one it implies.
 *
 * Shaped like `lib/chains/writeRail.js#resolveWriteRail`: `{ available, code, reason }`, where an
 * unavailable answer NAMES what is missing rather than only that something is. Nothing here reads
 * the network — `passkeySupported` is passed in — so this stays a pure function the surfaces and
 * the hook can both call.
 *
 * `enabled` defaults to `GROUP_PAY_ENABLED`, which is `false`: today every call answers
 * `withdrawn`. The rest of the logic is not dead — it is what #1538 turns back on, and it is
 * tested by passing `enabled: true`.
 *
 * @param {object} args
 * @param {boolean} [args.enabled]           the #1441 lever; defaults to `GROUP_PAY_ENABLED`
 * @param {string} [args.rail]               a `GROUP_RAIL` value from `selectGroupRail`
 * @param {string|null} [args.railReason]    that call's reason, reused verbatim when it refuses
 * @param {number|string|null} [args.chainId] the chain the payment would be signed on
 * @param {string|null} [args.assetKind]     the selected asset's `kind` ('native' | 'erc20' | 'btc-native' | …)
 * @param {boolean} [args.passkeySupported]  can the passkey UserOp rail submit on this chain?
 * @returns {{ available: boolean, code: string|null, reason: string|null }}
 */
export function groupPayAvailability({
  enabled = GROUP_PAY_ENABLED,
  rail = null,
  railReason = null,
  chainId = null,
  assetKind = null,
  passkeySupported = true,
} = {}) {
  const no = (code, reason) => ({ available: false, code, reason })

  if (!enabled) {
    return no(
      GROUP_UNAVAILABLE.WITHDRAWN,
      'Paying several people at once is not available yet — send one payment at a time.',
    )
  }

  // Non-EVM first: `useGroupPay` refuses these by name at submit, and an affordance that leads
  // straight to a refusal is worse than no affordance.
  const evmChainId = chainId == null || chainId === '' ? null : Number(chainId)
  if (assetKind === 'btc-native' || isBitcoinNetworkId(chainId) || evmChainId == null || !Number.isFinite(evmChainId)) {
    return no(
      GROUP_UNAVAILABLE.NON_EVM,
      'This asset is sent one payment at a time from its own screen.',
    )
  }

  switch (rail) {
    case GROUP_RAIL.BATCH_PASSKEY:
      return passkeySupported
        ? { available: true, code: null, reason: null }
        : no(
            GROUP_UNAVAILABLE.CHAIN_NO_BATCH,
            'Payments cannot be batched on this network, so they are sent one at a time. ' +
            'Switch to a network that supports batched transactions to pay several people at once.',
          )
    case GROUP_RAIL.VAULT_PROPOSAL:
      // A vault batches by MultiSend. Whether its own policy guard allows that is a per-vault
      // read resolved later and DISCLOSED before signing (#1368) — it is not this decision.
      return { available: true, code: null, reason: null }
    case GROUP_RAIL.SEQUENTIAL:
      return no(
        GROUP_UNAVAILABLE.NO_BATCH_RAIL,
        'This account signs one transaction at a time, so payments here are sent one by one.',
      )
    case GROUP_RAIL.REFUSED:
      return no(GROUP_UNAVAILABLE.RAIL_REFUSED, railReason || 'This account cannot send payments here.')
    default:
      return no(GROUP_UNAVAILABLE.RAIL_REFUSED, railReason || 'This account cannot send payments here.')
  }
}

/**
 * The disclosure for a rail: what will be submitted, who pays the fee, and what happens if part
 * of it fails. Every line is a statement of fact about the rail actually selected — the fee line
 * never says "gasless" unless the batch is genuinely sponsored (spec 050).
 */
export function describeRail(rail, { count = 0, gasless = false, nativeSymbol = '', batchSupport = null } = {}) {
  switch (rail) {
    case GROUP_RAIL.BATCH_PASSKEY:
      return {
        atomic: true,
        shape: 'batch',
        submissionLine: `One transaction carrying all ${count} payments — a single confirmation.`,
        feeLine: gasless
          ? 'Gasless — no network fee.'
          : `You pay the ${nativeSymbol || 'network'} fee for the batch.`,
        outcomeLine: `All ${count} go through together, or none of them do.`,
      }
    case GROUP_RAIL.VAULT_PROPOSAL:
      /*
       * Issue #1368 — one proposal carrying every payment is a MultiSend, which executes by
       * DELEGATECALL, which both policy guards deny for a vault with an active policy. Where the
       * guard is known to deny it (or could not be read at all), the shape is N proposals and the
       * member must be told that BEFORE signing: what they are approving here is a different
       * thing, with a different failure mode, from the one-proposal batch.
       */
      if (batchSupport === BATCH_SUPPORT.DENIED || batchSupport === BATCH_SUPPORT.UNKNOWN) {
        return {
          atomic: false,
          shape: 'split',
          submissionLine:
            `${count} separate proposals — one per recipient. ` +
            (batchSupport === BATCH_SUPPORT.DENIED
              ? "This vault's policy does not allow batched transactions, so each payment is proposed on its own."
              : "We could not confirm this vault's policy allows a batched transaction, so each payment is proposed on its own."),
          feeLine: `The vault pays the network fee for each of the ${count} proposals its signers execute.`,
          outcomeLine:
            `The ${count} proposals are queued in order and are approved and executed one at a time — ` +
            'a proposal that is never executed holds up the ones after it.',
        }
      }
      return {
        atomic: true,
        shape: 'batch',
        submissionLine: `One proposal covering all ${count} payments — the vault's signers must approve it before anything moves.`,
        feeLine: 'The vault pays the network fee when its signers execute the proposal.',
        outcomeLine: `All ${count} execute together, or none of them do.`,
      }
    case GROUP_RAIL.SEQUENTIAL:
      return {
        atomic: false,
        shape: 'sequential',
        submissionLine: `${count} separate transactions — one confirmation each.`,
        feeLine: gasless
          ? `Gasless — no network fee for any of the ${count} payments.`
          : `You pay the ${nativeSymbol || 'network'} fee for each of the ${count} payments.`,
        outcomeLine: "If one payment fails the rest still go through, and you'll see the outcome for each.",
      }
    default:
      return { atomic: false, shape: null, submissionLine: '', feeLine: '', outcomeLine: '' }
  }
}

export default validateRecipients
