/**
 * Which rail signs a write on THIS chain, can it run at all, and is the chain even reachable?
 * (spec 110 T025 — issue #1593. Moved here from `lib/custody/writeRail.js`: nothing about the
 * question is custody-specific, and `submitOn` — the seam every write is heading for — asks it.)
 *
 * ── THE RAIL IS A PROPERTY OF THE SIGNER, NOT THE LOGIN ─────────────────────────────────────
 * Custody actions used to branch straight on `loginMethod === 'passkey'`. That is the one thing
 * `WalletContext` says not to do — "`loginMethod` is INFORMATIONAL ONLY (signing ceremony
 * differs); identity, gating, and screening always key off `address` — no feature may branch on
 * it" — and it produced a real refusal: on Ethereum Classic and Mordor there is no bundler, so the
 * passkey UserOp rail cannot run, and every approve/execute/cancel died inside `sendPasskeyBatch`
 * with an error about chain support that the member never asked a question to receive.
 *
 * A wallet that holds a key does not have that problem. An injected wallet, a Ledger, or an
 * unlocked recovered key signs natively and pays the fee in the chain's own currency, so it works
 * on every EVM network the write can land on — ETC included. Nothing about the member's LOGIN
 * should take that away from them.
 *
 * So: a signer, if present, is used. The passkey rail is what you fall to when there is no key in
 * the browser, and it is offered only where it can actually submit. When neither can run, the
 * refusal NAMES the chain and what would fix it — a member told "Ethereum Classic needs a wallet
 * that can sign there" can act on that; one shown `ChainNotSupportedError` cannot.
 *
 * ── REACHABILITY IS PART OF THE ANSWER, AND IT IS OPT-IN ────────────────────────────────────
 * A rail that can sign is not the same as a chain the write can be PLACED on. The signer rail has
 * to move the wallet first (see `submitOn`), and two ways that fails are knowable before the tap:
 *
 *   · the chain is not one this build is configured for, so the app cannot describe the network
 *     it would be asking the wallet to add; and
 *   · the wallet is somewhere else and offers no way to change networks at all.
 *
 * Both used to surface from INSIDE the submit, which is the thing this task exists to stop: a
 * member should be told a button cannot work instead of finding out by pressing it.
 *
 * The two facts needed to check that — where the wallet is, and whether it can switch — are
 * OPTIONAL arguments, and omitting them leaves reachability UNCHECKED rather than assumed good.
 * That is deliberate and it is a soft gate: callers that do not pass them get exactly the answer
 * they got before, and `submitOn` still refuses at the boundary for anything that slips past. The
 * returned `reachability` says which of the three happened, so a surface can never mistake "not
 * asserted" for "verified".
 */

import { NETWORKS } from '../../config/networks'
import { getPasskeySupport } from '../../config/passkeySupport'

export const RAILS = Object.freeze({
  /** A signer — injected wallet, hardware device, or an unlocked recovered key. */
  SIGNER: 'signer',
  /** The spec-041/050 passkey UserOp rail, via `sendCalls`. Needs a bundler on this chain. */
  PASSKEY: 'passkey',
  /** Nothing here can sign. `reason` says why, in words a member can act on. */
  NONE: 'none',
})

export const REACHABILITY = Object.freeze({
  /** The caller did not say where the wallet is, so nothing was asserted either way. */
  UNCHECKED: 'unchecked',
  /** The write can be placed on this chain: already there, or a switch is available. */
  REACHABLE: 'reachable',
  /** It cannot, and `reason` says so before anything is signed. */
  UNREACHABLE: 'unreachable',
})

/**
 * @param {object} args
 * @param {number|null} args.chainId          the chain the write will land on
 * @param {object|null} args.signer           a signer, if the session has one
 * @param {string|null} args.loginMethod      'passkey' | 'injected' | 'walletconnect' | null
 * @param {string|null} [args.chainName]      display name, for the refusal sentence
 * @param {number|null} [args.walletChainId]  where the wallet is NOW. Pass it to have reachability
 *   checked; omit it and `reachability` comes back `unchecked`.
 * @param {boolean} [args.canSwitchChain]     whether this session can change networks at all.
 *   Only consulted when the wallet is somewhere other than `chainId`.
 * @returns {{ rail: string, available: boolean, reason: string|null, reachability: string }}
 */
export function resolveWriteRail({
  chainId,
  signer,
  loginMethod,
  chainName = null,
  walletChainId = undefined,
  canSwitchChain = undefined,
}) {
  const where = chainName || (chainId != null ? `chain ${chainId}` : 'this network')

  // A chain this build cannot describe is unreachable on EVERY rail, signer included: there is no
  // network definition to hand a wallet, and no bundler URL to post a UserOp to. Checked before
  // the rail so the answer names the real obstacle rather than blaming the member's wallet.
  if (chainId == null || !NETWORKS[Number(chainId)]) {
    return {
      rail: RAILS.NONE,
      available: false,
      reason: `FairWins is not configured for ${where}, so nothing can be sent there.`,
      reachability: REACHABILITY.UNREACHABLE,
    }
  }

  // A key in hand beats everything. Deliberately checked BEFORE `loginMethod`: a member operating
  // with a hardware wallet or a recovered account has a signer that works on chains the passkey
  // rail has never reached, and routing them by how they logged in would throw that away.
  if (signer) {
    const reach = reachOnSignerRail({ chainId, where, walletChainId, canSwitchChain })
    return {
      rail: RAILS.SIGNER,
      available: reach.reachability !== REACHABILITY.UNREACHABLE,
      reason: reach.reason,
      reachability: reach.reachability,
    }
  }

  if (loginMethod === 'passkey') {
    const support = getPasskeySupport(chainId)
    // The passkey rail addresses the target chain's bundler directly, so the wallet's own network
    // is irrelevant to it — reachability is settled by whether that bundler exists, full stop.
    if (support.supported) {
      return { rail: RAILS.PASSKEY, available: true, reason: null, reachability: REACHABILITY.REACHABLE }
    }
    // The honest half: passkey submission is genuinely unavailable here, and the way out is a
    // wallet that holds a key. Says what to do, not merely what failed.
    return {
      rail: RAILS.PASSKEY,
      available: false,
      reason:
        `Passkey transactions are not available on ${where}. Connect a wallet that can sign there ` +
        `— a browser wallet, a hardware wallet, or a recovered account — to act on this network.`,
      reachability: REACHABILITY.UNREACHABLE,
    }
  }

  return {
    rail: RAILS.NONE,
    available: false,
    reason: `Connect a wallet to act on ${where}.`,
    reachability: REACHABILITY.UNREACHABLE,
  }
}

/**
 * Can the signer rail actually be placed on `chainId`? Only asked when a signer exists.
 *
 * `walletChainId === undefined` means the caller did not say — which is NOT the same as the wallet
 * being nowhere, so it reports `unchecked` and withholds judgement rather than inventing one.
 */
function reachOnSignerRail({ chainId, where, walletChainId, canSwitchChain }) {
  if (walletChainId === undefined) {
    return { reachability: REACHABILITY.UNCHECKED, reason: null }
  }
  if (Number(walletChainId) === Number(chainId)) {
    return { reachability: REACHABILITY.REACHABLE, reason: null }
  }
  // Somewhere else, and no way to move: this is the refusal that used to come out of the middle of
  // a submit. `canSwitchChain === undefined` is again withheld judgement, not a pass.
  if (canSwitchChain === false) {
    const here = walletChainId == null ? 'another network' : NETWORKS[Number(walletChainId)]?.name || `chain ${walletChainId}`
    return {
      reachability: REACHABILITY.UNREACHABLE,
      reason:
        `This goes to ${where}, but the wallet is on ${here} and cannot change networks from here. ` +
        `Switch it to ${where} in the wallet itself, then try again.`,
    }
  }
  return {
    reachability: canSwitchChain === true ? REACHABILITY.REACHABLE : REACHABILITY.UNCHECKED,
    reason: null,
  }
}

/** Throwing form, for the action callbacks. Returns the rail when it can run. */
export function requireWriteRail(args) {
  const resolved = resolveWriteRail(args)
  if (!resolved.available) throw new Error(resolved.reason)
  return resolved
}
