/**
 * The two perps fee rails as DATA and DECISIONS (spec 083 US5, contracts/fee-rails.md).
 *
 * Split out of `PerpsFeesPanel.jsx` for the same reason `positionSheetActions.js` was split out of
 * the position sheet: the rendering is the least interesting part. What matters here is which
 * contract each rail is read from, and the one guard standing between an administrator and a
 * transaction that would re-point revenue at their own wallet. Those are worth asserting directly,
 * not only through a DOM.
 *
 *   GMX v2       authority is GMX's OWN `DataStore` on Arbitrum. There is deliberately no
 *                `perps.gmx.uifee` FeeRouter service: it would be a second config store for a rate
 *                FairWins cannot enforce, and its admin control would silently do nothing.
 *   Hyperliquid  authority is the FairWins `FeeRouter` service `perps.hyperliquid.builder`. It is
 *                READ here and EDITED in the Fees tab — one value, one control.
 *   Gains        a venue-paid rebate. No authority, no rate, and therefore no function here.
 *
 * Every read returns a three-state `chainReadResult` (read / not-deployed / unreadable). On a fee
 * schedule a silent 0 is read as "we charge nothing", so an unreachable chain must never produce
 * one — which is why there is no code path in this module that turns a failure into a number.
 *
 * The reads go through `readContract(chainId, …)` (spec 110 Phase 1), and each rail's chain is a
 * CONSTANT here — GMX is on Arbitrum, the Hyperliquid service on the build's mainnet chain — so
 * neither can drift to the wallet's. The `provider` argument stays, and is now purely the
 * AVAILABILITY GATE it always really was: `readProviderFor` is cohort-bounded (spec 071), so a
 * null from it means this build may not read that chain at all, which is a different answer from
 * a read that was attempted and failed. Losing that distinction would report a testnet build's
 * refusal as an unreachable mainnet.
 */
import { keccak256, stringToBytes, zeroAddress } from 'viem'
import { FEE_ROUTER_ABI } from '../../abis/FeeRouter'
import { GMX_DATA_STORE_ABI } from '../../abis/perps/gmxDataStore'
import { MAINNET_CHAIN_ID } from '../../config/networks'
import { PERP_VENUES } from '../../config/perps'
import {
  GMX_MAX_UI_FEE_FACTOR_KEY,
  gmxUiFeeFactorKey,
  gmxUiFeeFactorToBps,
} from '../../lib/perps/feeUnits'
import { notDeployed, readOk, unreadable } from '../../lib/chains/chainReadResult'
import { networkName } from '../../lib/chains/estate'
import { readContract } from '../../lib/chains/readContract'
import { getAddress, isAddress } from '../../lib/evm/address'

/**
 * GMX v2 is deployed on Arbitrum and nowhere else this product touches, so the venue registry is
 * the source for its chain — a literal here would be a second one that could drift from the
 * registry the rest of the feature resolves addresses from.
 */
export const GMX_CHAIN_ID = PERP_VENUES.gmx.chains[0]

/**
 * The Hyperliquid builder-fee service lives on the FeeRouter of this build's MAINNET chain
 * (Polygon 137 on a mainnet build, per fee-rails.md). It is derived, not written as a second
 * literal `137`, and the panel refuses to render off a mainnet cohort — so this can never resolve
 * to a testnet chain and quietly read the wrong estate.
 */
export const HL_FEE_CHAIN_ID = MAINNET_CHAIN_ID

/** `keccak256("perps.hyperliquid.builder")` — the registered FeeRouter service id. */
export const HL_BUILDER_SERVICE_ID = keccak256(stringToBytes('perps.hyperliquid.builder'))

/** A short address for display. The zero address renders as nothing, never as `0x0000…0000`. */
export function shortAddr(a) {
  return a && a !== zeroAddress ? `${a.substring(0, 6)}…${a.substring(a.length - 4)}` : ''
}

/** bps as a percentage, for the second reading of every rate. Fractional bps survive. */
export function bpsPct(bps) {
  return `${(Number(bps) / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}%`
}

/**
 * Is this the same account? Checksum-VALIDATING, which is the half viem does not do for itself.
 *
 * ethers' `getAddress` THREW on a mixed-case address whose EIP-55 checksum did not verify, so the
 * old `try/catch` here failed closed on one — the guard below refused, with a reason. viem's
 * `getAddress` does not validate the casing it is handed; it silently re-checksums it. Dropping
 * the check on the way past would have turned a loud refusal on a suspicious literal into a quiet
 * comparison, in the one function on this screen that decides whether an operator is allowed to
 * send `setUiFeeFactor`. `isAddress` from the address seam reproduces ethers' rule exactly
 * (all-lower and ALL-UPPER carry no checksum and are accepted; mixed case must verify), so this
 * keeps the original behaviour rather than the original code.
 */
function sameAddress(a, b) {
  if (!isAddress(a) || !isAddress(b)) return false
  return getAddress(a) === getAddress(b)
}

/**
 * May THIS wallet send `setUiFeeFactor`?
 *
 * The single most dangerous decision on the perps fee screen. `allowed: false` means the control is
 * not OFFERED — not that it is offered and fails — because the transaction would SUCCEED and simply
 * do something other than what the operator meant: GMX stores the factor under `msg.sender`, and
 * `claimUiFees` is `msg.sender`-keyed too, so signing from the wrong wallet configures a rate for
 * that wallet, leaves the rate FairWins orders actually carry untouched, and makes anything that
 * accrues claimable only by the signer.
 *
 * A refusal ALWAYS carries a reason: a control that vanishes without one is indistinguishable from
 * a bug, and this is the one place on the screen where an operator would go looking for a
 * workaround.
 */
export function uiFeeReceiverGuard({ account, receiver }) {
  if (!receiver) {
    return {
      allowed: false,
      reason:
        'No FairWins UI-fee receiver is configured, so there is no key to set a factor under. ' +
        'GMX charges a zero UI fee when the receiver is the zero address — the integration is ' +
        'structurally fee-free until a receiver is recorded in config/perps.js.',
    }
  }
  if (!account) {
    return {
      allowed: false,
      reason:
        `Connect the UI-fee receiver wallet (${receiver}) to change this rate. ` +
        '`setUiFeeFactor` credits `msg.sender`, so whichever wallet signs it becomes the receiver ' +
        'of the factor it sets.',
    }
  }
  if (!sameAddress(account, receiver)) {
    return {
      allowed: false,
      reason:
        `This wallet (${account}) is not the configured FairWins UI-fee receiver (${receiver}). ` +
        '`setUiFeeFactor` stores the factor under `msg.sender`, and `claimUiFees` is ' +
        '`msg.sender`-keyed too — so signing from here would configure a rate for THIS wallet ' +
        'instead, leave the rate FairWins orders actually carry unchanged, and make anything that ' +
        'accrued claimable only by this wallet. Switch to the receiver wallet, or change the ' +
        'recorded receiver first.',
    }
  }
  return { allowed: true, reason: null }
}

/**
 * Read the GMX rail from GMX's own DataStore — the contract that will charge it.
 *
 * The ceiling is read too, never assumed: GMX can raise `MAX_UI_FEE_FACTOR`, and a hardcoded 10 bps
 * shown as the venue's ceiling would be a false statement about what the venue enforces.
 */
export async function readGmxUiFeeRail({ provider, dataStore, receiver }) {
  if (!dataStore) return notDeployed(GMX_CHAIN_ID)
  // No receiver is a DEFINITE answer, not a failed read: GMX early-returns a zero UI fee when the
  // receiver is the zero address, so the integration is structurally fee-free and there is no key
  // to read a rate from.
  if (!receiver) return notDeployed(GMX_CHAIN_ID)
  const key = gmxUiFeeFactorKey(receiver)
  if (!key) {
    return unreadable(GMX_CHAIN_ID, 'the configured UI-fee receiver is not a valid address')
  }
  if (!provider) {
    return unreadable(GMX_CHAIN_ID, `no read connection to ${networkName(GMX_CHAIN_ID)}`)
  }
  try {
    const getUint = (slot) =>
      readContract(GMX_CHAIN_ID, {
        address: dataStore,
        abi: GMX_DATA_STORE_ABI,
        functionName: 'getUint',
        args: [slot],
      })
    const [factor, maxFactor] = await Promise.all([getUint(key), getUint(GMX_MAX_UI_FEE_FACTOR_KEY)])
    return readOk(GMX_CHAIN_ID, {
      factor,
      maxFactor,
      bps: gmxUiFeeFactorToBps(factor),
      maxBps: gmxUiFeeFactorToBps(maxFactor),
    })
  } catch (e) {
    return unreadable(GMX_CHAIN_ID, e?.message || String(e))
  }
}

/**
 * Read the Hyperliquid rail from the FeeRouter service the gateway quotes from.
 *
 * `kind === 0` is the FeeRouter's own "unregistered" answer and is reported as such — "nothing is
 * charged" — rather than as a rate of 0, which would imply a registered service set to zero.
 */
export async function readHyperliquidRail({ provider, routerAddr }) {
  if (!routerAddr) return notDeployed(HL_FEE_CHAIN_ID)
  if (!provider) {
    return unreadable(HL_FEE_CHAIN_ID, `no read connection to ${networkName(HL_FEE_CHAIN_ID)}`)
  }
  try {
    const svc = await readContract(HL_FEE_CHAIN_ID, {
      address: routerAddr,
      abi: FEE_ROUTER_ABI,
      functionName: 'getService',
      args: [HL_BUILDER_SERVICE_ID],
    })
    return readOk(HL_FEE_CHAIN_ID, {
      feeBps: Number(svc.feeBps),
      capBps: Number(svc.capBps),
      kind: Number(svc.kind),
      routerAddr,
    })
  } catch (e) {
    return unreadable(HL_FEE_CHAIN_ID, e?.message || String(e))
  }
}
