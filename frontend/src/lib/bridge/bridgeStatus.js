/**
 * Bridge status machine + cross-session reconciler (spec 067, US1 — T072/T073/T074).
 *
 * This is the honesty-critical half of the Bridge surface. `acrossQuotes.js` decides what a
 * transfer will cost; this file decides what a member is TOLD about a transfer that is already
 * moving, and it is the only place allowed to promote one to a finished state.
 *
 * The machine is exactly the one in data-model.md:
 *
 *   submitted ──src mined──> source_confirmed ──indexed──> in_flight ──dst fill──> delivered
 *       │                                                      │                   (SETTLED)
 *       │ src revert                                           ├── expiry refund ──> refunded
 *       └──────────> FAILED                                    │                    (CANCELLED)
 *                                                              └── past expectedBy ─> needs_attention
 *                                                                                     (still PENDING)
 *
 * Three rules are load-bearing and every branch below exists to keep one of them:
 *
 *   1. FR-009 — `delivered` is reachable ONLY from confirmed DESTINATION-side evidence: a fill
 *      transaction hash on the destination network. Not an upstream string that says "filled", not
 *      an elapsed timer, not an origin receipt. `deriveBridgeState` will not name that state
 *      without a hash, and `captureBridgeState` refuses to persist it without one either — two
 *      independent gates, because a false completion is the single worst thing this feature can do.
 *      The same evidence rule applies to `refunded`: money coming back is also a claim about money.
 *
 *   2. FR-011 — `needs_attention` is NOT terminal. It is a statement about the clock, not about the
 *      outcome, so a transfer sitting in it can still resolve to `delivered` or `refunded` on a
 *      later poll. It exists so a late transfer says what is known and what the recourse is
 *      (`BRIDGE_NEEDS_ATTENTION_RECOURSE`) instead of spinning forever.
 *
 *   3. FR-010 / FR-053 — an in-flight bridge survives the app closing. Nothing here holds state:
 *      the entry lives in the client ledger store (`sources/bridgeLedgerSource.js`), which is
 *      per-account, persisted, and carried in the spec-032 encrypted backup. On load,
 *      `reconcileBridges` re-derives the truth from evidence. The gateway status endpoint is a
 *      CONVENIENCE, not the authority — when it is unset, killswitched or unreachable the reconciler
 *      falls back to reading the chain (the origin receipt plus a destination fill log), and if even
 *      that is unavailable the clock still runs. A gateway outage can therefore never strand an
 *      already-submitted transfer; it can only make the app know less, and it says so.
 *
 * Everything unknown is reported as unknown. There is no branch in this file that invents progress,
 * and every failure to observe resolves toward the *lower* claim (research R7, FR-054).
 */
import { decodeEventLog, numberToHex, toEventSelector } from 'viem'
import { normalizeAbi } from '../chains/readContract'
import { getPublicClient } from '../chains/publicClient'
import { formatUnits } from '../evm/units'
import { bridgeGatewayUrl } from './acrossQuotes'
import { BRIDGE_STATE, captureBridgeState, listBridgeEntries } from '../../data/ledger/sources/bridgeLedgerSource'
import { BRIDGE_SETTLEMENT } from './bridgeCopy'
import { queueBridgeNotification } from './bridgeActivityBuffer'
import { NETWORKS } from '../../config/networks'
import { getTransactionUrl } from '../../config/blockExplorer'
import { scanLogRange } from '../chain/logScan'

const FETCH_TIMEOUT_MS = 10_000

/** How often an open Bridge surface re-polls a live transfer. */
export const BRIDGE_POLL_INTERVAL_MS = 15_000

/** Where a reconciliation's evidence came from — surfaced so the UI can say "as of" honestly. */
export const BRIDGE_STATUS_SOURCE = Object.freeze({
  GATEWAY: 'gateway',
  CHAIN: 'chain',
  /** Neither could be read. The clock still runs; nothing else is claimed. */
  NONE: 'none',
})

/** Outcomes nothing may overwrite — mirrors `TERMINAL_STATES` in the ledger source. */
const TERMINAL_STATES = Object.freeze([BRIDGE_STATE.DELIVERED, BRIDGE_STATE.REFUNDED, BRIDGE_STATE.FAILED])

/**
 * Progress order for the non-terminal states, so a late or partial observation cannot walk a
 * transfer backwards. `needs_attention` sits at the same rank as `in_flight` because it is a timing
 * observation rather than progress — mirrors `STATE_RANK` in the ledger source, which keeps its own
 * copy as the persistence guard.
 */
const STATE_RANK = Object.freeze({
  [BRIDGE_STATE.SUBMITTED]: 0,
  [BRIDGE_STATE.SOURCE_CONFIRMED]: 1,
  [BRIDGE_STATE.IN_FLIGHT]: 2,
  [BRIDGE_STATE.NEEDS_ATTENTION]: 2,
})

/** True for the three states a bridge never leaves. */
export function isTerminalBridgeState(state) {
  return TERMINAL_STATES.includes(state)
}

/** EVM only: Bitcoin network ids are STRINGS (spec 061) and never bridge (FR-006). */
function isEvmChainId(chainId) {
  return typeof chainId === 'number' && Number.isInteger(chainId) && chainId > 0
}

/**
 * A status could not be read. Same shape and taxonomy as `BridgeQuoteUnavailable` so a surface can
 * treat both alike: `disabled` means an operator turned it off (do not retry), `retryable` means
 * transient. Unlike a quote, an unreadable status is never fatal to the member — the reconciler
 * falls through to the chain and then to the clock.
 */
export class BridgeStatusUnavailable extends Error {
  constructor(message, { code, status, disabled = false, retryable = false, cause } = {}) {
    super(message)
    this.name = 'BridgeStatusUnavailable'
    this.code = code || 'unavailable'
    if (status !== undefined) this.status = status
    this.disabled = disabled
    this.retryable = retryable
    if (cause !== undefined) this.cause = cause
  }
}

/** Gateway error codes that mean "this capability is off", not "try again". */
const DISABLED_CODES = new Set(['bridge_disabled', 'bridge_killed', 'unconfigured', 'unsupported_chain'])
const RETRYABLE_CODES = new Set(['upstream_unavailable', 'upstream_malformed', 'quota_exceeded', 'timeout', 'network_error'])

/**
 * Whether the gateway status endpoint can be asked about this origin chain at all. False is not a
 * failure — the reconciler simply skips straight to the chain fallback.
 */
export function bridgeStatusAvailable(originChainId) {
  if (!isEvmChainId(originChainId)) return false
  return Boolean(NETWORKS[originChainId]?.capabilities?.bridge) && bridgeGatewayUrl() !== ''
}

/**
 * GET the gateway's normalized Across deposit status.
 *
 * Deliberately a separate, small client rather than a shared one with `acrossQuotes.js`: a quote is
 * a price the member signs against and may never be served stale, while a status is an observation
 * where a slightly stale answer is fine (the gateway marks it `stale` and we keep polling). Merging
 * them would tempt a future change to relax the quote rule.
 *
 * @param {{originChainId: number, depositId: string|number|bigint}} params
 * @returns {Promise<{state: string|null, upstreamStatus: string, fillTxHash: string|null,
 *   refundTxHash: string|null, depositTxHash: string|null, destinationChainId: number|null,
 *   fetchedAt: string, stale: boolean}>}
 * @throws {BridgeStatusUnavailable}
 */
export async function fetchBridgeStatus({ originChainId, depositId }) {
  if (!isEvmChainId(originChainId)) {
    throw new BridgeStatusUnavailable(
      `bridge status: origin chain id must be a positive integer EVM chain id (got ${JSON.stringify(originChainId)})`,
      { code: 'unsupported_chain', disabled: true },
    )
  }
  const id = depositId == null ? '' : String(depositId)
  if (!/^\d{1,78}$/.test(id)) {
    throw new BridgeStatusUnavailable('bridge status: depositId must be a positive integer', { code: 'invalid_deposit' })
  }

  const base = bridgeGatewayUrl()
  if (!base) {
    throw new BridgeStatusUnavailable('bridge gateway is not configured', { code: 'unconfigured', disabled: true })
  }

  let res
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    res = await fetch(`${base}/v1/bridge/${originChainId}/status?depositId=${id}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
  } catch (e) {
    const code = e?.name === 'AbortError' ? 'timeout' : 'network_error'
    throw new BridgeStatusUnavailable(`bridge gateway unreachable: ${e?.message || e}`, { code, retryable: true, cause: e })
  } finally {
    clearTimeout(timer)
  }

  let body = null
  try {
    body = await res.json()
  } catch {
    /* non-JSON body — handled by the status mapping below */
  }

  if (res.ok) {
    if (body === null || typeof body !== 'object') {
      throw new BridgeStatusUnavailable('bridge gateway returned an unreadable body', { code: 'bad_response', retryable: true })
    }
    return body
  }

  const code = body?.error?.code || `http_${res.status}`
  const disabled = DISABLED_CODES.has(code)
  throw new BridgeStatusUnavailable(body?.error?.reason || `bridge status request failed (${res.status})`, {
    code,
    status: res.status,
    disabled,
    retryable: !disabled && (RETRYABLE_CODES.has(code) || res.status >= 500),
  })
}

/**
 * Turn a gateway status DTO into evidence the state machine can weigh.
 *
 * The gateway has already applied the same evidence rule on its side
 * (`services/relay-gateway/src/bridge/status.js`): it only says `delivered` with a fill hash and
 * only says `refunded` with a refund hash. We do NOT take its word for the state anyway — we take
 * its HASHES and re-derive. That way a future gateway change cannot introduce a false completion
 * into the ledger, and an unrecognised upstream vocabulary (`state: null`) degrades to "the bridge
 * knows about this deposit", which is all it actually proves.
 *
 * @param {object} dto
 * @returns {object} evidence
 */
export function evidenceFromGatewayStatus(dto) {
  if (!dto || typeof dto !== 'object') return { source: BRIDGE_STATUS_SOURCE.NONE }
  const fillTxHash = typeof dto.fillTxHash === 'string' ? dto.fillTxHash : null
  const refundTxHash = typeof dto.refundTxHash === 'string' ? dto.refundTxHash : null
  return {
    source: BRIDGE_STATUS_SOURCE.GATEWAY,
    // The upstream answered at all, so the deposit is known to the bridge — that is the honest
    // reading of any status, including one whose vocabulary this build does not recognise.
    depositIndexed: true,
    sourceMined: dto.depositTxHash ? true : null,
    sourceReverted: null,
    // FR-009 — only a hash promotes. `state: 'delivered'` with no hash cannot happen from our own
    // gateway, and if it ever did it would be ignored here.
    dstTxHash: fillTxHash,
    refundTxHash,
    /**
     * Past its fill deadline and unfilled. There is no separate member-facing state for "expired,
     * refund pending" — `needs_attention` is the honest home for it: non-terminal, names what is
     * known, and resolves to `refunded` once the returning transaction exists.
     */
    expired: dto.state === 'expired',
    upstreamStatus: typeof dto.upstreamStatus === 'string' ? dto.upstreamStatus : null,
    /** True when the gateway served a cached answer that failed to refresh — it can only lag. */
    stale: dto.stale === true,
    fetchedAt: dto.fetchedAt ?? null,
  }
}

/* ------------------------------------------------------------------------------------------------
 * On-chain fallback (research R7) — what keeps FR-010 true through a gateway outage.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The Across SpokePool deposit and fill events, in BOTH the vocabularies a live SpokePool may be
 * on: the V3 pair (`V3FundsDeposited` / `FilledV3Relay`) and the post-rename pair
 * (`FundsDeposited` / `FilledRelay`, addresses widened to `bytes32`, `depositId` widened to
 * `uint256`). Topic hashes are derived from these fragments rather than hand-written, and a matched
 * log is decoded to confirm it really is the event we filtered for.
 *
 * The indexed layout is identical across the rename — `originChainId` then `depositId` then
 * `relayer` — which is what lets one filter serve both. That matters: `RequestedV3SlowFill` is also
 * emitted on the DESTINATION chain with `originChainId` and `depositId` in the same two indexed
 * slots, so filtering on those topics alone (a null topic0) would read a slow-fill REQUEST as a
 * delivery. Constraining topic0 to the fill events is what makes this safe.
 *
 * If a SpokePool ever emits a third vocabulary, the effect is that no log matches: the transfer
 * stays in flight and, past its window, becomes `needs_attention`. An under-claim, never a false
 * delivery.
 */
const SPOKE_POOL_EVENTS = [
  'event V3FundsDeposited(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint32 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, address indexed depositor, address recipient, address exclusiveRelayer, bytes message)',
  'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
  'event FilledV3Relay(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint32 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, address exclusiveRelayer, address indexed relayer, address depositor, address recipient, bytes message, tuple(address updatedRecipient, bytes updatedMessage, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)',
  'event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, tuple(bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)',
]

/**
 * The parsed ABI, exported in place of the ethers `Interface` this module used to hand out
 * (spec 110). Consumers decode with viem's `decodeEventLog({ abi: SPOKE_POOL_ABI, … })` and take
 * topic hashes with `toEventSelector`; tests BUILD fixture logs from the same value through
 * `src/test/helpers/encodeEventLog.js`, so the fragments above are stated exactly once.
 */
export const SPOKE_POOL_ABI = normalizeAbi(SPOKE_POOL_EVENTS)

const DEPOSIT_EVENT_NAMES = ['V3FundsDeposited', 'FundsDeposited']
const FILL_EVENT_NAMES = ['FilledV3Relay', 'FilledRelay']

const eventItem = (name) => SPOKE_POOL_ABI.find((i) => i.type === 'event' && i.name === name)
const topicsFor = (names) => names.map((n) => toEventSelector(eventItem(n)))

/** viem's `decodeEventLog`, total: a log from another contract is `null`, never a throw. */
function parseSpokeLog(log) {
  try {
    return decodeEventLog({ abi: SPOKE_POOL_ABI, topics: [...(log?.topics || [])], data: log?.data ?? '0x' })
  } catch {
    return null
  }
}

/**
 * Approximate seconds per block, used ONLY to size the destination log-scan window. This is a scan
 * heuristic, never a member-facing figure: a window that turns out too short finds no fill, which
 * leaves the transfer in flight (the safe direction), and the gateway path is the normal one.
 */
const APPROX_BLOCK_SECONDS = Object.freeze({ 1: 12, 10: 2, 137: 2, 8453: 2, 42161: 0.25, 11155111: 12 })
const DEFAULT_BLOCK_SECONDS = 12
/** How far back a destination scan looks — generously past any route's expected fill window. */
export const FILL_LOOKBACK_SECONDS = 6 * 60 * 60
/**
 * Ceiling on the SIZE OF THE SWEEP, which since the scan was chunked means a ceiling on the number
 * of REQUESTS it may cost: 120,000 blocks is 12 chunks of `LOG_SCAN_CHUNK`, three waves.
 *
 * It used to be documented as "a range that every RPC will refuse", and that was wrong in both
 * directions. It never fired — it sits 12x above the 10,000-block cap QuickNode and most public
 * endpoints actually enforce — while every range that WAS refused (Polygon/Optimism/Base at 10,800,
 * Arbitrum at 86,400) passed under it untouched. A cap set above every real cap protects nothing.
 *
 * It is deliberately NOT lowered toward 10,000 now that the sweep is chunked. `FILL_LOOKBACK_SECONDS`
 * states a window in TIME; clamping the block count to one chunk would quietly redefine six hours as
 * roughly forty minutes on Arbitrum, and a fill found outside the window reads as no fill at all —
 * which the machine then ages into `needs_attention`. Truncating a real delivery to save eight
 * requests is the wrong trade. Today the ceiling binds nothing (Arbitrum's 86,400 is the widest real
 * value); it exists for a future chain faster than 0.25s/block, or a longer lookback.
 */
const MAX_LOOKBACK_BLOCKS = 120_000

/**
 * How many blocks back a destination fill scan reaches on a given chain.
 *
 * Exported for tests: this arithmetic is what decided the width of the request that four chains'
 * RPCs were rejecting, so it is worth pinning per chain rather than inferring from a mock.
 */
export function fillLookbackBlocksFor(chainId) {
  const seconds = APPROX_BLOCK_SECONDS[chainId] ?? DEFAULT_BLOCK_SECONDS
  return Math.min(MAX_LOOKBACK_BLOCKS, Math.ceil(FILL_LOOKBACK_SECONDS / seconds))
}

/** The configured SpokePool for a chain. Build-time display fallback only — see networks.js. */
export function spokePoolAddress(chainId) {
  if (!isEvmChainId(chainId)) return null
  return NETWORKS[chainId]?.bridge?.spokePool ?? null
}

/**
 * Default read handle for a chain, or null when the network is unknown or has no endpoint.
 *
 * The duck shape (`getTransactionReceipt` / `getBlockNumber` / `getLogs`) is what this module's
 * readers and `scanLogRange` were written against, and injected fakes still satisfy it unchanged.
 * ONE normalization matters: viem reports a receipt's outcome as `'success' | 'reverted'` where
 * ethers used `1 | 0`, and every caller here asks `Number(receipt.status) === 0`. `Number('success')`
 * is NaN, which compares false — so a REVERTED deposit would have read as a successful one and the
 * `src revert` leaf of the state machine would have become unreachable, silently. It is mapped here,
 * once, rather than at each reader.
 */
function defaultProvider(chainId) {
  if (!isEvmChainId(chainId)) return null
  const client = getPublicClient(chainId)
  if (!client) return null
  return {
    async getTransactionReceipt(hash) {
      const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
      if (!receipt) return null
      return { ...receipt, status: receipt.status === 'reverted' ? 0 : 1 }
    },
    async getBlockNumber() {
      // Never cached: this head bounds a log scan, and a stale one silently narrows the window a
      // fill could be found in. See the note in `lib/chains/eventScan.js`.
      return Number(await client.getBlockNumber({ cacheTime: 0 }))
    },
    async getLogs({ address, topics, fromBlock, toBlock }) {
      return client.request({
        method: 'eth_getLogs',
        params: [
          {
            address,
            topics,
            fromBlock: `0x${Number(fromBlock).toString(16)}`,
            toBlock: `0x${Number(toBlock).toString(16)}`,
          },
        ],
      })
    },
  }
}

/**
 * Origin-side evidence, read from the member's own transaction receipt.
 *
 * A receipt is the cheapest and most definitive origin observation there is: `status === 0` is the
 * `src revert` leaf of the state machine, and a deposit event in its own logs proves the bridge
 * accepted the deposit (so the transfer is genuinely in flight, not merely mined). A missing receipt
 * means the transaction is not mined yet — unknown, not failed.
 *
 * @returns {{sourceMined: boolean|null, sourceReverted: boolean|null, depositIndexed: boolean}}
 */
async function readOriginEvidence({ provider, srcTxHash, depositId }) {
  const unknown = { sourceMined: null, sourceReverted: null, depositIndexed: false }
  if (!provider || !srcTxHash) return unknown

  let receipt
  try {
    receipt = await provider.getTransactionReceipt(srcTxHash)
  } catch {
    return unknown
  }
  if (!receipt) return unknown

  const status = Number(receipt.status)
  if (status === 0) return { sourceMined: true, sourceReverted: true, depositIndexed: false }

  const depositTopics = new Set(topicsFor(DEPOSIT_EVENT_NAMES))
  const wanted = depositId == null ? null : String(depositId)
  const depositIndexed = (receipt.logs || []).some((log) => {
    if (!depositTopics.has(log?.topics?.[0])) return false
    const parsed = parseSpokeLog(log)
    if (!parsed) return false
    return wanted == null || String(parsed.args.depositId) === wanted
  })

  return { sourceMined: true, sourceReverted: false, depositIndexed }
}

/**
 * Destination-side evidence: the fill transaction hash, or null.
 *
 * THIS IS THE ONLY THING IN THE CODEBASE THAT MAY PROMOTE A BRIDGE TO `delivered` WITHOUT THE
 * GATEWAY. It answers null for every ambiguity — no provider, no configured SpokePool, an RPC that
 * refuses the range, a decode failure — because "no fill found" is not evidence of non-delivery and
 * must never be reported as one.
 *
 * THE SWEEP IS CHUNKED, and that is load-bearing rather than tidy. Asking for the whole lookback in
 * ONE `eth_getLogs` meant asking for 10,800 blocks on Polygon, Optimism and Base and 86,400 on
 * Arbitrum, against endpoints that cap a single request at 10,000 — verified live against the
 * Polygon SpokePool, where 10,000 answered with 347 logs and 10,001 answered
 * `-32614 eth_getLogs is limited to a 10,000 range`. Only Ethereum's 1,800 fit. The `catch` below
 * meant this degraded honestly (a refused range returns null, which the machine reads as "no new
 * information", so no member was ever falsely told a transfer had not arrived) — but the fill hash,
 * the entire output of this function, was unreachable on four of the five bridging chains. Honest
 * and useless is still useless. `scanLogRange` issues the window as inclusive ranges no wider than
 * `LOG_SCAN_CHUNK`, and re-derives it on every call rather than caching — see its own note on why a
 * never-rewinding watermark is the wrong shape for evidence that money moved.
 *
 * @returns {Promise<string|null>} the fill transaction hash
 */
async function readDestinationFill({ provider, destinationChainId, originChainId, depositId, spokePool, fromBlock, lookbackBlocks }) {
  const address = spokePool || spokePoolAddress(destinationChainId)
  if (!provider || !address || depositId == null) return null

  // The head is needed even when the caller pins `fromBlock`: a chunked sweep has to know where the
  // range ENDS, and `toBlock: 'latest'` is precisely the open end that cannot be divided.
  let head
  try {
    head = Number(await provider.getBlockNumber())
  } catch {
    return null
  }
  if (!Number.isFinite(head)) return null

  const span = lookbackBlocks ?? fillLookbackBlocksFor(destinationChainId)
  const from = fromBlock == null ? Math.max(0, head - span) : Number(fromBlock)

  let logs
  try {
    logs = await scanLogRange({
      provider,
      address,
      fromBlock: from,
      toBlock: head,
      // [any fill event, this origin chain, this deposit]. `uint32` and `uint256` pad to the same
      // 32-byte topic for any value a deposit id can take, so one topic serves both vocabularies.
      topics: [
        topicsFor(FILL_EVENT_NAMES),
        numberToHex(BigInt(originChainId), { size: 32 }),
        numberToHex(BigInt(depositId), { size: 32 }),
      ],
    })
  } catch {
    // A provider that refuses the range (or the chain) tells us nothing. Stay silent.
    return null
  }

  for (const log of logs || []) {
    // Not one of our fill events after all — ignore it rather than count it.
    const parsed = parseSpokeLog(log)
    if (!parsed || !FILL_EVENT_NAMES.includes(parsed.eventName)) continue
    if (String(parsed.args.depositId) !== String(depositId)) continue
    if (String(parsed.args.originChainId) !== String(originChainId)) continue
    if (log.transactionHash) return log.transactionHash
  }
  return null
}

/**
 * Read both sides of a bridge straight from the chains, with no gateway involved (research R7).
 *
 * Each half is independent and each failure is local: an unreadable origin does not suppress a
 * destination fill, and vice versa. Anything unread comes back null/false, which the state machine
 * treats as "no new information" rather than as a negative result.
 *
 * Refunds are deliberately NOT derived here. An expired Across deposit is returned to the depositor
 * — the member, never the router (research R2) — through a bundle-level relayer-refund execution
 * that does not carry the deposit id, so there is no single log this can filter for. A refund is
 * therefore only ever recorded from the gateway's refund hash; without it the transfer stays
 * honestly late (`needs_attention`) rather than being declared resolved.
 *
 * @param {{originChainId: number, destinationChainId: number, depositId: string|number|bigint,
 *   srcTxHash?: string|null, originProvider?: object|null, destinationProvider?: object|null,
 *   spokePool?: string|null, fromBlock?: number|null, lookbackBlocks?: number|null}} params
 * @returns {Promise<object>} evidence
 */
export async function readOnChainEvidence({
  originChainId,
  destinationChainId,
  depositId,
  srcTxHash = null,
  originProvider = null,
  destinationProvider = null,
  spokePool = null,
  fromBlock = null,
  lookbackBlocks = null,
}) {
  if (!isEvmChainId(originChainId)) {
    throw new BridgeStatusUnavailable(
      `bridge status: origin chain id must be a positive integer EVM chain id (got ${JSON.stringify(originChainId)})`,
      { code: 'unsupported_chain', disabled: true },
    )
  }

  const origin = originProvider ?? defaultProvider(originChainId)
  const destination = isEvmChainId(destinationChainId) ? (destinationProvider ?? defaultProvider(destinationChainId)) : null

  const [source, dstTxHash] = await Promise.all([
    readOriginEvidence({ provider: origin, srcTxHash, depositId }),
    destination
      ? readDestinationFill({
          provider: destination,
          destinationChainId,
          originChainId,
          depositId,
          spokePool,
          fromBlock,
          lookbackBlocks,
        })
      : Promise.resolve(null),
  ])

  return {
    source: BRIDGE_STATUS_SOURCE.CHAIN,
    sourceMined: source.sourceMined,
    sourceReverted: source.sourceReverted,
    depositIndexed: source.depositIndexed,
    dstTxHash,
    // Not derivable on chain — see above. Never guessed.
    refundTxHash: null,
    expired: false,
    upstreamStatus: null,
    stale: false,
    /** True when neither side could be read at all: the reconciler still runs the clock. */
    empty: source.sourceMined == null && dstTxHash == null && !source.depositIndexed,
  }
}

/* ------------------------------------------------------------------------------------------------
 * The state machine itself.
 * ---------------------------------------------------------------------------------------------- */

/** Whether a transfer has passed the window its route said it needs (FR-011). */
export function isPastExpectedBy(expectedBy, now = Date.now()) {
  return Number(expectedBy) > 0 && now >= Number(expectedBy)
}

const rank = (state) => STATE_RANK[state] ?? 0

/**
 * Decide what a bridge's state is, given where it was and what has since been observed. Pure — no
 * network, no clock beyond the `now` it is handed, no writes — so the whole matrix is testable.
 *
 * Order of judgement, and why each step sits where it does:
 *
 *   1. Already terminal → nothing moves. Delivered, refunded and failed are final.
 *   2. `sourceReverted` → FAILED. A reverted origin transaction means no deposit exists, so any
 *      later "evidence" about it would be about somebody else's transfer. It is checked first
 *      precisely so it cannot be overtaken by a stale observation.
 *   3. A destination fill hash → DELIVERED. The only route to that state, anywhere (FR-009).
 *   4. A refund hash → REFUNDED. Same evidence rule applied to the other money outcome.
 *   5. Progress, never backwards: an indexed deposit means in flight, a mined source means source
 *      confirmed, and a rank below where the transfer already is is ignored.
 *   6. The clock, LAST — so it can override an in-flight reading but never a settled one. Past
 *      `expectedBy` (or upstream-expired) the transfer is `needs_attention`, which is non-terminal
 *      and will be re-evaluated against evidence on the next pass exactly like any other state.
 *
 * @param {{current?: string, evidence?: object, expectedBy?: number|null, now?: number}} params
 * @returns {{state: string, changed: boolean, dstTxHash: string|null, refundTxHash: string|null,
 *   failureReason: string|null, reason: string}}
 */
export function deriveBridgeState({ current, evidence = {}, expectedBy = null, now = Date.now() } = {}) {
  const from = current && (STATE_RANK[current] != null || isTerminalBridgeState(current)) ? current : BRIDGE_STATE.SUBMITTED
  const dstTxHash = evidence?.dstTxHash ?? null
  const refundTxHash = evidence?.refundTxHash ?? null

  const settle = (state, reason, extra = {}) => ({
    state,
    changed: state !== from,
    dstTxHash,
    refundTxHash,
    failureReason: null,
    reason,
    ...extra,
  })

  if (isTerminalBridgeState(from)) return settle(from, 'terminal')

  if (evidence?.sourceReverted === true) {
    return settle(BRIDGE_STATE.FAILED, 'source_reverted', {
      failureReason: 'The transaction on the sending network did not go through.',
    })
  }
  if (dstTxHash) return settle(BRIDGE_STATE.DELIVERED, 'destination_fill')
  if (refundTxHash) return settle(BRIDGE_STATE.REFUNDED, 'refund_tx')

  let next = from
  if (evidence?.depositIndexed === true && rank(BRIDGE_STATE.IN_FLIGHT) > rank(next)) {
    next = BRIDGE_STATE.IN_FLIGHT
  } else if (evidence?.sourceMined === true && rank(BRIDGE_STATE.SOURCE_CONFIRMED) > rank(next)) {
    next = BRIDGE_STATE.SOURCE_CONFIRMED
  }

  if (evidence?.expired === true || isPastExpectedBy(expectedBy, now)) {
    return settle(BRIDGE_STATE.NEEDS_ATTENTION, evidence?.expired === true ? 'upstream_expired' : 'past_expected_by')
  }

  return settle(next, next === from ? 'unchanged' : 'progress')
}

/* ------------------------------------------------------------------------------------------------
 * Notifications (T111, FR-037) — telling a member about a transfer they are not watching.
 *
 * A bridge is the one FairWins action a member routinely walks away from: it spans two networks and
 * usually finishes minutes later, on a screen they closed. So the three outcomes that change what
 * they know — it arrived, it came back, it is late — are announced.
 *
 * Three rules, each a direct consequence of a rule already enforced above:
 *
 *   1. **The same evidence gate.** `delivered` is announced only with a destination fill hash and
 *      `refunded` only with a returning-transaction hash. `deriveBridgeState` already refuses to
 *      name those states without them, so this is the third independent gate on the same claim —
 *      deliberately, because a false "arrived" push is the worst thing this feature can emit.
 *   2. **One notification per transition.** The emitter runs only when a new state was actually
 *      APPLIED to the ledger, and the ledger will not re-apply a state it already holds, so a
 *      re-poll (or a second poller) cannot produce a duplicate.
 *   3. **Say what is needed.** Every message ends with the action, including when the action is
 *      nothing. `needs_attention` is the only one that asks for anything, and what it asks for is
 *      checking — never "contact support about your missing money", which would be untrue.
 * ---------------------------------------------------------------------------------------------- */

/** The three outcomes worth interrupting a member for (FR-037). Progress states are not. */
export const BRIDGE_NOTIFIED_STATES = Object.freeze([
  BRIDGE_STATE.DELIVERED,
  BRIDGE_STATE.REFUNDED,
  BRIDGE_STATE.NEEDS_ATTENTION,
])

/** Network name for a chain id, or an honest placeholder — never a guessed one. */
function networkName(chainId) {
  return NETWORKS[chainId]?.name || 'the other network'
}

/**
 * `"12.5 USDC"`, or null when the record does not carry both the amount and its decimals. Null
 * means the message simply omits the amount: a bridge notification never states a figure it
 * cannot derive, and never falls back to the INPUT amount when describing what ARRIVED (the two
 * differ by the bridge's own fee).
 */
function amountLabel(raw, decimals, symbol) {
  if (raw == null || decimals == null) return null
  try {
    const value = Number(formatUnits(BigInt(raw), decimals))
    if (!Number.isFinite(value)) return null
    return `${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}${symbol ? ` ${symbol}` : ''}`
  } catch {
    return null
  }
}

/**
 * Build the notification for a bridge transition, or null when this transition is not one members
 * are told about (progress states) or when the evidence for the claim is missing.
 *
 * Pure: no clock, no network, no writes — so every branch, including every refusal, is testable.
 *
 * @param {object} entry a `readBridgeEntry` view of the bridge
 * @param {{to: string, from?: string, dstTxHash?: string|null, refundTxHash?: string|null}} transition
 * @param {{at?: number}} [opts]
 * @returns {null | {type: string, state: string, refId: string, depositId: string|null,
 *   message: string, severity: string, actionable: boolean, txHash: string|null,
 *   txUrl: string|null, at: number|null}}
 */
export function bridgeNotification(entry, transition, { at = null } = {}) {
  const state = transition?.to
  if (!entry || !BRIDGE_NOTIFIED_STATES.includes(state)) return null

  const refId = entry.bridgeId || entry.entryId || null
  if (!refId) return null

  const origin = Number(entry.originChainId)
  const destination = Number(entry.destinationChainId)
  const dstTxHash = transition?.dstTxHash ?? entry.dstTxHash ?? null
  const refundTxHash = transition?.refundTxHash ?? entry.refundTxHash ?? null
  const protocol = entry.settlementProtocol || BRIDGE_SETTLEMENT.protocol

  const base = {
    state,
    refId: String(refId),
    depositId: entry.depositId ?? null,
    at: at ?? entry.timestamp ?? null,
  }

  if (state === BRIDGE_STATE.DELIVERED) {
    // FR-009, third gate: no destination-side transaction, no "arrived".
    if (!dstTxHash) return null
    // The amount that ARRIVED is the output amount. When it was never recorded the message says
    // less rather than quoting the amount that was sent, which is a different (larger) number.
    const arrived = amountLabel(entry.outputAmountRaw, entry.tokenDecimals, entry.tokenSymbol)
    return {
      ...base,
      type: 'bridge-delivered',
      message: arrived
        ? `Your transfer arrived on ${networkName(destination)} — ${arrived} is in your wallet there. Nothing to do.`
        : `Your transfer arrived on ${networkName(destination)} and is in your wallet there. Nothing to do.`,
      severity: 'success',
      actionable: false,
      txHash: dstTxHash,
      txUrl: getTransactionUrl(destination, dstTxHash),
    }
  }

  if (state === BRIDGE_STATE.REFUNDED) {
    // Same rule for the other money outcome: money coming back is also a claim about money.
    if (!refundTxHash) return null
    return {
      ...base,
      type: 'bridge-refunded',
      message: `Your transfer to ${networkName(destination)} could not be delivered, so ${protocol} returned the asset to your wallet on ${networkName(origin)}. Nothing to do — the network cost of the attempt is not returned.`,
      severity: 'info',
      actionable: false,
      txHash: refundTxHash,
      txUrl: getTransactionUrl(origin, refundTxHash),
    }
  }

  // needs_attention — a statement about the clock, not the outcome (FR-011). It stays live, so the
  // message says what is known, what is not, and the one useful thing the member can do.
  return {
    ...base,
    type: 'bridge-needs-attention',
    message: `Your transfer to ${networkName(destination)} is taking longer than this route usually takes. It is not lost and FairWins does not hold it — open Bridge to check the sending transaction and where ${protocol} has it. Transfers that cannot be delivered are returned to the wallet they came from.`,
    severity: 'warning',
    actionable: true,
    txHash: entry.srcTxHash ?? null,
    txUrl: entry.srcTxHash ? getTransactionUrl(origin, entry.srcTxHash) : null,
  }
}

/* ------------------------------------------------------------------------------------------------
 * Reconciliation — the FR-010 cross-session path.
 * ---------------------------------------------------------------------------------------------- */

/** Every bridge on `chainId` that has not reached a terminal outcome. */
export function listLiveBridges(account, chainId) {
  return listBridgeEntries(account, chainId).filter((e) => !isTerminalBridgeState(e.state))
}

/**
 * Bring ONE bridge's recorded state up to date with reality, and persist any change.
 *
 * The degradation ladder, in order, is the whole point of this function:
 *   gateway  →  chain  →  clock only
 * A gateway that is off, killswitched or unreachable simply moves us down a rung; it never blocks
 * the transfer from resolving and never hides it (FR-053). Even at the bottom rung the transfer is
 * still honestly described — a late one becomes `needs_attention` with no service involved at all.
 *
 * Writes go through `captureBridgeState`, which applies the evidence rules a second time at the
 * point of persistence. That redundancy is intentional.
 *
 * @param {string} account
 * @param {object} entry a `readBridgeEntry` view (origin chain, depositId, state, hashes, expectedBy)
 * @param {{now?: number, fetchStatus?: Function, readChain?: Function, onTransition?: Function,
 *   originProvider?: object, destinationProvider?: object, preferChain?: boolean}} [deps]
 * @returns {Promise<{entryId: string|null, depositId: string|null, from: string, to: string,
 *   changed: boolean, applied: boolean, source: string, evidence: object|null,
 *   gatewayError: Error|null, chainError: Error|null}>}
 */
export async function reconcileBridge(account, entry, deps = {}) {
  const now = deps.now ?? Date.now()
  const from = entry?.state || BRIDGE_STATE.SUBMITTED
  const result = {
    entryId: entry?.entryId ?? null,
    depositId: entry?.depositId ?? null,
    from,
    to: from,
    changed: false,
    applied: false,
    source: BRIDGE_STATUS_SOURCE.NONE,
    evidence: null,
    gatewayError: null,
    chainError: null,
  }

  const originChainId = Number(entry?.originChainId)
  if (!account || !entry?.depositId || !isEvmChainId(originChainId)) return result
  // Terminal is terminal — do not spend a request re-asking about a settled transfer.
  if (isTerminalBridgeState(from)) return result

  const fetchStatus = deps.fetchStatus || fetchBridgeStatus
  const readChain = deps.readChain || readOnChainEvidence

  let evidence = null
  if (!deps.preferChain && bridgeStatusAvailable(originChainId)) {
    try {
      evidence = evidenceFromGatewayStatus(await fetchStatus({ originChainId, depositId: entry.depositId }))
    } catch (e) {
      result.gatewayError = e
    }
  }

  const chainArgs = {
    originChainId,
    destinationChainId: Number(entry.destinationChainId),
    depositId: entry.depositId,
    srcTxHash: entry.srcTxHash,
    originProvider: deps.originProvider ?? null,
    destinationProvider: deps.destinationProvider ?? null,
  }

  // No gateway, or it told us nothing: read the chains ourselves. This is what makes an in-flight
  // bridge survive a gateway outage rather than sitting on a spinner (FR-010/FR-053).
  if (!evidence) {
    try {
      const chain = await readChain(chainArgs)
      if (chain && !chain.empty) evidence = chain
      else if (chain) result.evidence = chain
    } catch (e) {
      result.chainError = e
    }
  } else if (
    // A LATE transfer gets a second opinion before we tell the member it needs attention. The
    // gateway's index can lag the chain, and "taking longer than expected" is a worse answer than
    // "delivered" when the destination has in fact delivered. Only the chain can overrule it, and
    // only upward — a chain read that finds nothing changes nothing.
    !evidence.dstTxHash &&
    !evidence.refundTxHash &&
    evidence.sourceReverted !== true &&
    (evidence.expired === true || isPastExpectedBy(entry.expectedBy, now))
  ) {
    try {
      const chain = await readChain(chainArgs)
      if (chain?.dstTxHash) {
        evidence = { ...evidence, dstTxHash: chain.dstTxHash, source: BRIDGE_STATUS_SOURCE.CHAIN }
      }
    } catch (e) {
      result.chainError = e
    }
  }

  result.evidence = evidence ?? result.evidence
  result.source = evidence?.source ?? BRIDGE_STATUS_SOURCE.NONE

  const derived = deriveBridgeState({ current: from, evidence: evidence ?? {}, expectedBy: entry.expectedBy, now })
  result.to = derived.state
  result.changed = derived.changed
  if (!derived.changed) return result

  const written = captureBridgeState(account, originChainId, {
    depositId: entry.depositId,
    state: derived.state,
    dstTxHash: derived.dstTxHash,
    refundTxHash: derived.refundTxHash,
    failureReason: derived.failureReason,
  })
  result.applied = written != null
  // T111 (US3): one emission per APPLIED transition, so a re-poll that observes the same state
  // never re-notifies. `deps.notify` is an injection seam for tests and for a caller that wants a
  // different sink; passing `null` disables buffering. It is deliberately SEPARATE from
  // `onTransition` so a caller that supplies its own UI hook cannot accidentally silence the
  // member-facing notification by doing so.
  if (result.applied) {
    const notify = deps.notify === undefined ? queueBridgeNotification : deps.notify
    if (typeof notify === 'function') {
      try {
        // The derived hashes, not just the result envelope: the emitter re-checks the evidence
        // itself, so it has to be handed the evidence.
        const record = bridgeNotification(
          entry,
          { ...result, dstTxHash: derived.dstTxHash, refundTxHash: derived.refundTxHash },
          { at: now },
        )
        if (record) notify(account, originChainId, record)
      } catch {
        // A notification failure must never break reconciliation.
      }
    }
    if (typeof deps.onTransition === 'function') {
      try {
        deps.onTransition(result)
      } catch {
        // Nor may a caller's own hook.
      }
    }
  }
  return result
}

/**
 * Reconcile every live bridge the account has on `chainId` — the call an app makes on load.
 *
 * This is the concrete answer to FR-010: nothing about a transfer's progress lived in the session
 * that started it. The entries are read back from the persisted ledger and re-derived from evidence,
 * so a member who closes the app mid-bridge and returns hours (or devices) later sees its true
 * current state, including one that finished while they were away.
 *
 * Never throws: one unreadable transfer must not stop the rest from resolving.
 *
 * @param {string} account
 * @param {number} chainId origin chain
 * @param {object} [deps] as `reconcileBridge`
 * @returns {Promise<Array<object>>} one result per live bridge
 */
export async function reconcileBridges(account, chainId, deps = {}) {
  if (!account || !isEvmChainId(Number(chainId))) return []
  const live = listLiveBridges(account, Number(chainId))
  const results = []
  for (const entry of live) {
    // Sequential on purpose: a member's live bridges are few, and one shared gateway quota is
    // better spent in order than in a burst that trips the rate limit.
    results.push(await reconcileBridge(account, entry, deps).catch((e) => ({
      entryId: entry.entryId,
      depositId: entry.depositId,
      from: entry.state,
      to: entry.state,
      changed: false,
      applied: false,
      source: BRIDGE_STATUS_SOURCE.NONE,
      evidence: null,
      gatewayError: null,
      chainError: e,
    })))
  }
  return results
}
