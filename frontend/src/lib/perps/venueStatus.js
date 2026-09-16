/**
 * Live per-venue operational state (spec 083, T018, FR-017 / FR-018).
 *
 * What a venue currently permits is a fact the VENUE owns, so it is read from the contract that
 * enforces it — Gains' `getTradingActivated()` — and never inferred from a FairWins config flag.
 * A venue that has quietly gone close-only would otherwise let the app offer an open that reverts
 * `Paused()` with the member's gas attached.
 *
 * FOUR RULES, each of which is a specific dishonesty when broken:
 *
 *   1. **An unreadable venue is `unreadable`, never assumed open.** Every failure path here fails
 *      CLOSED for opening. There is no branch that turns a dropped RPC call into "you may trade".
 *   2. **A venue that is not deployed on a chain is `not-deployed`, not `unreadable`.** These are
 *      different member-facing facts ("GMX is not on this network" vs "we could not reach it") and
 *      the repo already draws that line for estate reads (`lib/chains/chainReadResult.js`,
 *      spec 071). Both refuse opening, so nothing is loosened by telling the truth about which.
 *   3. **Per-venue isolation.** One venue's failure never blanks another: `readVenueStatuses`
 *      settles each reader independently, and the readers themselves are total — they return an
 *      `unreadable` result rather than throwing.
 *   4. **Status gates OPENING ONLY.** `exitAvailability()` returns a literal `offer: true` in every
 *      state, including `paused`, because nothing may stand between a member and closing or
 *      reducing a position they already hold (FR-014/FR-015/SC-004). `canClose()` answers the
 *      different question "will the venue accept this right now" — it is for the warning text, and
 *      a caller that uses it to HIDE an exit control has broken SC-004.
 *
 * PROVIDERS come from `utils/rpcProvider` so the member's own endpoint, headers and failover apply
 * (spec 069). Never hand-build one from `NETWORKS[chainId].rpcUrl` here.
 *
 * TOTALITY (the `lib/perps/format.js` convention): nothing in this module throws. These results
 * drive a disabled-with-a-reason control, and a throw would take the sheet down instead.
 */
import { GAINS_DIAMOND_ABI, GAINS_TRADING_ACTIVATED } from '../../abis/perps/gainsDiamond'
import { PERP_VENUES, gainsDiamondFor, gmxAddressesFor, perpsManageEnabled } from '../../config/perps'
import { getPublicClient } from '../chains/publicClient'
import { readContract } from '../chains/readContract'

/**
 * The full status vocabulary. `open`/`close-only`/`paused` mirror `ITradingStorage.TradingActivated`;
 * the last two are the read outcome, kept distinct for the reason in rule 2 above.
 */
export const VENUE_STATUS = Object.freeze({
  OPEN: 'open',
  CLOSE_ONLY: 'close-only',
  PAUSED: 'paused',
  NOT_DEPLOYED: 'not-deployed',
  UNREADABLE: 'unreadable',
})

/**
 * The venues this module can read. Hyperliquid is deliberately absent: it stays read-only this
 * release (FR-021), and inventing a status for it would put a management control behind a gate
 * rather than stating plainly that management happens on the venue.
 */
export const STATUS_VENUE_IDS = Object.freeze(['gains', 'gmx'])

function result(venue, chainId, status, extra = {}) {
  return Object.freeze({
    venue,
    chainId: chainId == null ? null : Number(chainId),
    status,
    // Gains-only: how old a pending market order must be before `cancelOrderAfterTimeout` stops
    // reverting `WaitTimeout()`. null everywhere else, and null when the venue did not answer —
    // never a hardcoded 200/30, which is venue configuration and changes.
    timeoutBlocks: null,
    // Short, honest explanation for the UI and for logs. Never a revert selector.
    detail: null,
    // The venue's own raw value, when it gave one we could not map.
    raw: null,
    ...extra,
  })
}

/* ------------------------------------------------------------------------------------------- *
 * Injectable dependencies
 *
 * Every reader takes its provider factory and contract factory as options so tests can drive the
 * failure paths (dead endpoint, reverting call, unmapped enum value) without a network.
 * ------------------------------------------------------------------------------------------- */

// Spec 110 Phase 1: the DEFAULTS are viem-seam-backed while the injectable contracts the tests
// drive stay byte-identical — `getProvider(chainId)` still yields a positional-`getCode` object
// and `makeContract(address, abi, provider)` still yields the two Gains views.
function defaultGetProvider(chainId) {
  const client = getPublicClient(chainId)
  if (!client) return null
  return {
    getCode: (address) => client.getCode({ address }).then((code) => code ?? '0x'),
    readContract: (args) => readContract(chainId, args),
  }
}

function defaultMakeContract(address, abi, provider) {
  const view = (functionName) => provider.readContract({ address, abi, functionName })
  return {
    getTradingActivated: () => view('getTradingActivated'),
    getMarketOrdersTimeoutBlocks: () => view('getMarketOrdersTimeoutBlocks'),
  }
}

/** The factory returns null for a chain with no endpoint; it may also throw. Neither escapes. */
function resolveProvider(chainId, getProvider) {
  try {
    return getProvider(chainId) || null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Gains Network
 * ------------------------------------------------------------------------------------------- */

/** `TradingActivated` → our vocabulary. An unmapped value is UNREADABLE: never guess "open". */
function mapTradingActivated(value) {
  const n = Number(value)
  if (n === GAINS_TRADING_ACTIVATED.ACTIVATED) return VENUE_STATUS.OPEN
  if (n === GAINS_TRADING_ACTIVATED.CLOSE_ONLY) return VENUE_STATUS.CLOSE_ONLY
  if (n === GAINS_TRADING_ACTIVATED.PAUSED) return VENUE_STATUS.PAUSED
  return null
}

function toBlockCount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Gains' live state on a chain, straight off the diamond.
 *
 * `getTradingActivated()` is load-bearing and `getMarketOrdersTimeoutBlocks()` is not, so they are
 * settled separately: a timeout read that fails leaves `timeoutBlocks: null` (rendered '—') while
 * the status still reports honestly. Coupling them would let an auxiliary read blank the one value
 * that decides whether opening is offered.
 *
 * @returns {Promise<Readonly<{venue,chainId,status,timeoutBlocks,detail,raw}>>} never rejects
 */
export async function readGainsStatus(chainId, deps) {
  // `?? {}` rather than a parameter-list default: the latter only covers `undefined`, and an explicit
  // null would make this REJECT, breaking the "never rejects" contract in the JSDoc below.
  const {
    diamondFor = gainsDiamondFor,
    getProvider = defaultGetProvider,
    makeContract = defaultMakeContract,
  } = deps ?? {}

  let diamond
  try {
    diamond = diamondFor(chainId)
  } catch {
    diamond = null
  }
  if (!diamond) {
    return result('gains', chainId, VENUE_STATUS.NOT_DEPLOYED, {
      detail: 'Gains Network is not deployed on this network.',
    })
  }

  const provider = resolveProvider(chainId, getProvider)
  if (!provider) {
    return result('gains', chainId, VENUE_STATUS.UNREADABLE, {
      detail: 'No read connection to this network.',
    })
  }

  let contract
  try {
    contract = makeContract(diamond, GAINS_DIAMOND_ABI, provider)
  } catch (e) {
    return result('gains', chainId, VENUE_STATUS.UNREADABLE, {
      detail: readFailureDetail(e),
    })
  }

  const [activated, timeout] = await Promise.allSettled([
    contract.getTradingActivated(),
    contract.getMarketOrdersTimeoutBlocks(),
  ])

  const timeoutBlocks = timeout.status === 'fulfilled' ? toBlockCount(timeout.value) : null

  if (activated.status !== 'fulfilled') {
    return result('gains', chainId, VENUE_STATUS.UNREADABLE, {
      timeoutBlocks,
      detail: readFailureDetail(activated.reason),
    })
  }

  const status = mapTradingActivated(activated.value)
  if (!status) {
    return result('gains', chainId, VENUE_STATUS.UNREADABLE, {
      timeoutBlocks,
      raw: activated.value == null ? null : String(activated.value),
      detail: 'Gains Network reported a trading state this app does not recognise.',
    })
  }

  return result('gains', chainId, status, { timeoutBlocks, raw: String(Number(activated.value)) })
}

/* ------------------------------------------------------------------------------------------- *
 * GMX v2
 * ------------------------------------------------------------------------------------------- */

/**
 * GMX's availability on a chain.
 *
 * GMX HAS NO GLOBAL "trading activated" FLAG to read. Its pauses are per-feature booleans in the
 * DataStore (`CREATE_ORDER_FEATURE_DISABLED` keyed by handler + order type), and the DataStore ABI
 * subset this app maintains exposes `getUint` only. Rather than fabricate a close-only state GMX
 * never reported, this checks the thing that genuinely goes wrong here: the ExchangeRouter and the
 * Router (the ERC-20 APPROVAL target) are pinned from GMX's docs/SDK and are REPLACED on GMX
 * releases. An address with no code means the pin is stale — approving it or calling it would burn
 * the member's gas — so that is `unreadable` and opening is refused until the pin is re-verified.
 *
 * A GMX-side feature pause therefore still surfaces as a venue REJECTION with GMX's own reason,
 * through the order state machine, which is the honest place for it.
 *
 * @returns {Promise<Readonly<{venue,chainId,status,timeoutBlocks,detail,raw}>>} never rejects
 */
export async function readGmxStatus(chainId, deps) {
  const { addressesFor = gmxAddressesFor, getProvider = defaultGetProvider } = deps ?? {}

  let addresses
  try {
    addresses = addressesFor(chainId)
  } catch {
    addresses = null
  }
  if (!addresses) {
    return result('gmx', chainId, VENUE_STATUS.NOT_DEPLOYED, {
      detail: 'GMX is only deployed on Arbitrum.',
    })
  }

  const provider = resolveProvider(chainId, getProvider)
  if (!provider) {
    return result('gmx', chainId, VENUE_STATUS.UNREADABLE, {
      detail: 'No read connection to this network.',
    })
  }

  try {
    // Both are on the fund path: the ExchangeRouter is the call target, the Router is what pulls
    // collateral. A codeless Router is the more dangerous of the two — an approval to it is a
    // signature the member pays for and gets nothing from.
    const [exchangeRouterCode, routerCode] = await Promise.all([
      provider.getCode(addresses.exchangeRouter),
      provider.getCode(addresses.router),
    ])
    const dead = []
    if (!hasCode(exchangeRouterCode)) dead.push('ExchangeRouter')
    if (!hasCode(routerCode)) dead.push('Router')
    if (dead.length) {
      return result('gmx', chainId, VENUE_STATUS.UNREADABLE, {
        detail: `GMX's ${dead.join(' and ')} address has no code on this network — the pinned address needs re-verifying.`,
      })
    }
    return result('gmx', chainId, VENUE_STATUS.OPEN)
  } catch (e) {
    return result('gmx', chainId, VENUE_STATUS.UNREADABLE, { detail: readFailureDetail(e) })
  }
}

function hasCode(code) {
  return typeof code === 'string' && code !== '' && code !== '0x'
}

function readFailureDetail(error) {
  const message = typeof error?.shortMessage === 'string' ? error.shortMessage : error?.message
  // The venue's own words when we have them; never a bare revert selector, which tells a member
  // nothing. A missing message still gets a sentence rather than "undefined".
  return message ? `This venue could not be read just now (${message}).` : 'This venue could not be read just now.'
}

/* ------------------------------------------------------------------------------------------- *
 * Combined read
 * ------------------------------------------------------------------------------------------- */

const DEFAULT_READERS = Object.freeze({ gains: readGainsStatus, gmx: readGmxStatus })

/**
 * Every readable venue's state on a chain, with PER-VENUE ISOLATION.
 *
 * `Promise.allSettled` is belt-and-braces over readers that are already total: a reader replaced or
 * wrapped later must not be able to take its siblings down with it. The result always has the same
 * shape — one entry per venue in `STATUS_VENUE_IDS` — so a caller never has to distinguish "absent
 * because it failed" from "absent because we forgot".
 *
 * @returns {Promise<Record<string, object>>} never rejects
 */
export async function readVenueStatuses(chainId, deps) {
  const { readers = DEFAULT_READERS, ...readerDeps } = deps ?? {}
  const ids = STATUS_VENUE_IDS.filter((id) => typeof readers[id] === 'function')

  // `Promise.resolve().then(...)` rather than calling the reader directly: a reader that throws
  // SYNCHRONOUSLY escapes `Promise.allSettled` entirely and takes every sibling venue with it.
  const settled = await Promise.allSettled(
    ids.map((id) => Promise.resolve().then(() => readers[id](chainId, readerDeps))),
  )

  const out = {}
  ids.forEach((id, i) => {
    const outcome = settled[i]
    const value =
      outcome.status === 'fulfilled' && outcome.value && typeof outcome.value === 'object'
        ? outcome.value
        : result(id, chainId, VENUE_STATUS.UNREADABLE, {
            detail: readFailureDetail(outcome.reason),
          })
    out[id] = Object.freeze({
      ...value,
      venue: id,
      label: PERP_VENUES[id]?.label || id,
      // Whether this BUILD has a calldata path for the venue on this chain — a separate question
      // from what the venue permits. Both must be true to open; neither may gate an exit.
      manageable: perpsManageEnabled(id, chainId),
    })
  })
  return out
}

/* ------------------------------------------------------------------------------------------- *
 * Permissions
 * ------------------------------------------------------------------------------------------- */

/** Accepts a status string or a result object, so callers never unwrap by hand. */
function statusOf(input) {
  if (typeof input === 'string') return input
  return typeof input?.status === 'string' ? input.status : null
}

/**
 * May a NEW position be opened at this venue right now?
 *
 * True for exactly one status. Everything else — including a status string this build has never
 * heard of — is false, so a vocabulary that grows later fails closed rather than silently
 * permitting an open.
 */
export function canOpen(input) {
  return statusOf(input) === VENUE_STATUS.OPEN
}

/**
 * Will the venue ACCEPT a close right now? This is the warning-text question, NOT the
 * render-the-control question — see `exitAvailability`, and do not use this to hide an exit.
 *
 * `unreadable` returns TRUE: we could not read the venue, and refusing the member's exit on our own
 * uncertainty would be the app standing between them and their money. Their close may fail at the
 * venue, which is honest; hiding the attempt is not.
 */
export function canClose(input) {
  const status = statusOf(input)
  if (status === VENUE_STATUS.OPEN) return true
  if (status === VENUE_STATUS.CLOSE_ONLY) return true
  if (status === VENUE_STATUS.UNREADABLE) return true
  // paused (the venue refuses everything), not-deployed (there is nothing there to close), and any
  // unrecognised status.
  return false
}

/** Reducing is a close of part of the position — close-only permits it, and it follows `canClose`. */
export function canReduce(input) {
  return canClose(input)
}

/**
 * The exit control's availability. `offer` is a literal `true` in every state — structurally unable
 * to be false — because SC-004 requires zero code paths that gate a close, reduce, cancel or
 * recovery. `venueWillAccept` carries the honest warning for a paused venue.
 */
export function exitAvailability(input) {
  const status = statusOf(input)
  const venueWillAccept = canClose(status)
  return Object.freeze({
    offer: true,
    venueWillAccept,
    note: venueWillAccept ? null : exitNote(status),
  })
}

function exitNote(status) {
  if (status === VENUE_STATUS.PAUSED) {
    return 'This venue has paused trading, so it may refuse this until it resumes. You can still try.'
  }
  if (status === VENUE_STATUS.NOT_DEPLOYED) {
    return 'This venue is not available on this network.'
  }
  return 'This venue may refuse this right now. You can still try.'
}

/**
 * Member-facing sentence for why opening is unavailable, with the VENUE named as the source
 * (FR-016/FR-017) — FairWins never presents a venue's restriction as its own. `null` when opening
 * is available, so a caller renders nothing rather than an empty notice.
 */
export function openBlockedNote(input, venueLabel) {
  const status = statusOf(input)
  if (status === VENUE_STATUS.OPEN) return null
  const name = venueLabel || (typeof input === 'object' && input?.label) || 'This venue'
  if (status === VENUE_STATUS.CLOSE_ONLY) {
    return `${name} is in close-only mode right now, so new positions cannot be opened there. You can still close or reduce what you hold.`
  }
  if (status === VENUE_STATUS.PAUSED) {
    return `${name} has paused trading, so new positions cannot be opened there.`
  }
  if (status === VENUE_STATUS.NOT_DEPLOYED) {
    return `${name} is not available on this network.`
  }
  return `${name}'s current trading status could not be confirmed, so opening is unavailable. Nothing you already hold is affected.`
}
