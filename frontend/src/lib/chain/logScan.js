import { DEFAULT_LOG_RANGE } from '../../config/logScanEndpoints'

/**
 * Bounded, resumable `eth_getLogs` scanning — the one way this app reads event history.
 *
 * WHY THIS EXISTS. Every public RPC caps the block range of a single `eth_getLogs`; the app's own
 * default Polygon endpoint caps it at 10,000 blocks and answers anything wider with
 * `-32701 exceed maximum block range: 10000`. Callers that handed a contract's deploy block
 * straight to `queryFilter` were therefore asking for ~2,000,000 blocks in one request and getting
 * a hard error on every single call — the Protect proposal queue and the membership voucher scan
 * were both dead on Polygon for exactly this reason, and the activity poller turned the first of
 * those into a red "Couldn't refresh some activity" banner on every session (issue: activity
 * refresh error).
 *
 * Three things make the naive fix ("just chunk it") wrong on its own, and all three are handled
 * here rather than in each caller:
 *
 *  1. **Chunking multiplies requests.** 2.1M blocks at 10k a chunk is 216 requests. Doing that on
 *     every 30s activity poll would be far worse than the single failing request it replaced. So a
 *     completed scan is CACHED for the session and later calls only ask for blocks that are new.
 *  2. **The first backfill still costs those requests.** Callers may pass `maxChunks` to bound one
 *     invocation; the scan then stops early, reports `complete: false`, and RESUMES from its cursor
 *     on the next call. A background poller spends a few requests per cycle and converges; a
 *     foreground read the member is waiting on can spend the lot.
 *  3. **A partial scan is not a complete one, and must never be presented as one.** `complete` is
 *     part of the result, not an afterthought — a caller that ignores it will render "no pending
 *     proposals" from a scan that simply has not reached them yet. That is the same class of lie
 *     the honest-state rule exists to prevent (Constitution III), so it is the caller's job to say
 *     "still catching up", and this module's job to always tell them which they have.
 *
 * Events that share a contract are scanned TOGETHER (one request per chunk for the whole group,
 * via a topic0 OR-set) rather than once per event — the difference between 8 backfills and 3 for a
 * custody vault. Group only events whose remaining indexed topics match; `eventName` on each
 * returned log tells them apart afterwards.
 *
 * A chunk that fails is retried in narrower sub-chunks (some endpoints cap by result size, not
 * range). A sub-chunk that still fails THROWS: a silently skipped range is a hole in history that
 * looks exactly like "nothing happened".
 *
 * REQUEST VOLUME (the 429 fix). Four more rules keep a scan from becoming a storm:
 *
 *  5. **Width follows the endpoint.** History is read through the chain's log client
 *     (`config/logScanEndpoints.js`), whose handle reports `maxLogRange` — Arbitrum's public
 *     endpoint takes millions of blocks per request, so its whole history is a handful of calls
 *     instead of ~3,900. A refusal that STATES a cap ("limited to a 10,000 range") shrinks the width
 *     to it and the width is remembered for that endpoint, so the next chunk is not refused too.
 *  6. **An endpoint that cannot serve history fails FAST.** "Archive requests require a personal
 *     token", or a cap so small that the history would take thousands of requests, throws
 *     `LogHistoryUnavailableError` at once — no ten-way sub-chunk retry of a refusal that narrowing
 *     cannot fix. The caller renders it as unreadable, which is what it is.
 *  7. **One scan per key at a time.** Several surfaces read the same contract history (the vault
 *     queue, the cross-chain queue, the notification source); concurrent callers now queue behind
 *     one scan and then read its cache, instead of each issuing the same backfill.
 *  8. **A finished scan survives a reload.** The watermark and raw logs are kept per device
 *     (localStorage), so a reload reads only new blocks. The reason this used to be session-only —
 *     "a stale watermark across releases would silently skip history" — is answered by what the key
 *     holds and what is restored: the key is chain + address + topics + fromBlock (a changed filter
 *     or deploy block is a different key), raw logs are re-DECODED with the current ABI on restore,
 *     the version prefix is bumped on any change to this format, and the last `REORG_MARGIN` blocks
 *     are always re-read. Logs are public chain data; nothing member-specific is stored.
 */

/** Widest range asked for in one request when the endpoint reports nothing better. */
export const LOG_SCAN_CHUNK = DEFAULT_LOG_RANGE
/** Narrower retry, for endpoints that cap by result size rather than by range. */
export const LOG_SCAN_FALLBACK_CHUNK = 1_000
/**
 * A stated cap below this is treated as "cannot serve history": at 100 blocks a request (drpc's free
 * plan) one Arbitrum history is ~390,000 requests. Refusing is the honest answer; trying is the storm.
 */
export const MIN_USABLE_LOG_RANGE = 1_000
/** Blocks re-read after a restore from storage, so a reorg near the old head cannot leave a ghost. */
export const REORG_MARGIN = 64
/** In-flight chunks per scan. Pacing per host is the limiter's job (lib/chains/hostLimiter.js). */
const CONCURRENCY = 4
/** Storage prefix — bump the version on ANY change to what is stored. */
const STORE_PREFIX = 'fw_logscan_v1:'
/** Above this many logs a history is not persisted (it is still cached for the session). */
const MAX_PERSISTED_LOGS = 2_000

/** The endpoint cannot serve this history at all — retrying narrower will not help. */
export class LogHistoryUnavailableError extends Error {
  constructor(message, { cause } = {}) {
    super(message)
    this.name = 'LogHistoryUnavailableError'
    this.cause = cause
  }
}

/** key -> { scannedTo, logs, raw } for this tab; mirrored to localStorage per rule 8. */
const cache = new Map()
/** key -> promise of the scan currently running for it (rule 7). */
const inflight = new Map()
/** endpoint key -> width learned from a stated cap (rule 5). */
const learnedWidth = new Map()

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** Drop all cached scans — memory AND device storage (tests, and any reset path). */
export function clearLogScanCache() {
  cache.clear()
  inflight.clear()
  learnedWidth.clear()
  const ls = storage()
  if (!ls) return
  try {
    for (let i = ls.length - 1; i >= 0; i -= 1) {
      const k = ls.key(i)
      if (k && k.startsWith(STORE_PREFIX)) ls.removeItem(k)
    }
  } catch {
    /* storage unavailable: nothing persisted to clear */
  }
}

/** Tests only: forget the in-memory cache but keep device storage — i.e. simulate a page reload. */
export function __simulateReloadForTests() {
  cache.clear()
  inflight.clear()
  learnedWidth.clear()
}

const rawOf = (log) => ({
  address: log.address,
  topics: [...log.topics],
  data: log.data,
  blockNumber: Number(log.blockNumber),
  blockHash: log.blockHash,
  transactionHash: log.transactionHash,
  transactionIndex: log.transactionIndex,
  index: log.index ?? log.logIndex,
})

function persist(key, entry) {
  const ls = storage()
  if (!ls) return
  try {
    if (entry.raw.length > MAX_PERSISTED_LOGS) {
      ls.removeItem(STORE_PREFIX + key)
      return
    }
    ls.setItem(STORE_PREFIX + key, JSON.stringify({ scannedTo: entry.scannedTo, raw: entry.raw }))
  } catch {
    /* quota / private mode: the session cache still works */
  }
}

/** Restore a persisted scan, re-decoded with the CURRENT interface and wound back REORG_MARGIN. */
function restore(key, contract, fromBlock) {
  const ls = storage()
  if (!ls) return null
  try {
    const text = ls.getItem(STORE_PREFIX + key)
    if (!text) return null
    const stored = JSON.parse(text)
    if (!Number.isFinite(stored?.scannedTo) || !Array.isArray(stored.raw)) return null
    const scannedTo = Math.max(Number(fromBlock) - 1, stored.scannedTo - REORG_MARGIN)
    const raw = stored.raw.filter((l) => l.blockNumber <= scannedTo)
    const logs = []
    for (const r of raw) {
      const d = decode(contract, r)
      if (d) logs.push(d)
    }
    return { scannedTo, logs, raw }
  } catch {
    return null
  }
}

/**
 * Resolve `contract.filters.X(...)` (a DeferredTopicFilter) or a plain topics array to topic values.
 */
async function topicsOf(filter) {
  if (Array.isArray(filter)) return filter
  if (typeof filter?.getTopicFilter === 'function') return filter.getTopicFilter()
  if (Array.isArray(filter?.topics)) return filter.topics
  throw new Error('logScan: unsupported filter')
}

/**
 * Merge several single-event filters into one `{ topics }` for a combined request.
 * Every filter must agree on topics 1..n and differ only in topic0.
 */
function mergeTopics(topicSets) {
  const [first, ...rest] = topicSets
  const tail = first.slice(1)
  for (const t of rest) {
    const otherTail = t.slice(1)
    if (JSON.stringify(otherTail) !== JSON.stringify(tail)) {
      throw new Error('logScan: filters differ beyond topic0 and cannot be merged')
    }
  }
  const topic0 = topicSets.map((t) => t[0])
  return [topic0.length === 1 ? topic0[0] : topic0, ...tail]
}

/** The width to ask for on this provider: learned cap > the endpoint's declared range > default. */
function widthFor(provider) {
  const learned = provider?.logEndpointKey ? learnedWidth.get(provider.logEndpointKey) : undefined
  const declared = Number(provider?.maxLogRange) > 0 ? Number(provider.maxLogRange) : LOG_SCAN_CHUNK
  return Math.max(1, Math.min(learned ?? Infinity, declared))
}

/**
 * Split `[from..to]` into INCLUSIVE ranges no wider than `width` blocks.
 *
 * The one definition of "how wide is a chunk" in this app. Note the arithmetic: a request for
 * `fromBlock..fromBlock + width - 1` spans exactly `width` blocks because both ends are inclusive
 * — the off-by-one that turns a 10,000-block cap into a 10,001-block request is the whole failure
 * mode this module exists to prevent, so it is written down once and only once.
 *
 * @param {number} from - first block, inclusive
 * @param {number} to - last block, inclusive
 * @param {number} [limit] - stop after this many chunks (a budget); omit for the whole range
 * @param {number} [width] - chunk width; defaults to LOG_SCAN_CHUNK
 */
function planChunks(from, to, limit = Infinity, width = LOG_SCAN_CHUNK) {
  const chunks = []
  let cursor = from
  while (cursor <= to && chunks.length < limit) {
    const end = Math.min(cursor + width - 1, to)
    chunks.push({ from: cursor, to: end })
    cursor = end + 1
  }
  return chunks
}

function errorText(err) {
  const parts = []
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    parts.push(e.details, e.shortMessage, e.message)
  }
  return parts.filter(Boolean).join(' | ')
}

/** "This endpoint will not serve history" — narrowing the range cannot fix it. */
const UNSERVABLE = /archive requests|personal token|archive (?:data|node|state).*not|api ?key (?:not found|required)|tenant disabled/i

/** A cap the refusal states, in blocks — or null when it states none. */
export function statedRangeCap(text) {
  const patterns = [
    /limited to (?:a |an )?([\d,]+)[ -]*(?:block)?s? ?range/i, // "eth_getLogs is limited to a 10,000 range"
    /limited to 0 ?- ?([\d,]+) blocks?/i, // 1rpc: "limited to 0 - 50 blocks range"
    /maximum block range:? ?([\d,]+)/i, // publicnode/polygon: "exceed maximum block range: 50000"
    /ranges over ([\d,]+) blocks/i, // drpc: "ranges over 100 blocks are not supported"
    /block range (?:greater|larger) than ([\d,]+)/i, // flashbots: "block range greater than 2000 max"
    /(?:up to|max(?:imum)?(?: of)?) ([\d,]+) blocks?/i, // "query up to 10000 blocks"
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (m) {
      const n = Number(m[1].replace(/,/g, ''))
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return null
}

/**
 * One range, adapting to what the endpoint says. Throws when the range cannot be read — a
 * `LogHistoryUnavailableError` when no narrower request could succeed either.
 */
async function getLogsRange(provider, base, from, to) {
  try {
    return await provider.getLogs({ ...base, fromBlock: from, toBlock: to })
  } catch (err) {
    const text = errorText(err)
    if (UNSERVABLE.test(text)) {
      throw new LogHistoryUnavailableError(`This network's endpoint does not serve event history (${text.slice(0, 120)})`, { cause: err })
    }
    const span = to - from + 1
    const cap = statedRangeCap(text)
    if (cap != null) {
      if (cap < MIN_USABLE_LOG_RANGE) {
        throw new LogHistoryUnavailableError(`This network's endpoint only serves ${cap}-block log ranges — too narrow to read history`, { cause: err })
      }
      if (provider?.logEndpointKey) learnedWidth.set(provider.logEndpointKey, Math.min(cap, learnedWidth.get(provider.logEndpointKey) ?? Infinity))
      if (cap >= span) throw err // it refused a range already inside its own cap: not a width problem
      const out = []
      for (const c of planChunks(from, to, Infinity, cap)) out.push(...(await provider.getLogs({ ...base, fromBlock: c.from, toBlock: c.to })))
      return out
    }
    // No stated cap (some endpoints cap by RESULT size): one narrower pass, then give up loudly.
    if (span <= LOG_SCAN_FALLBACK_CHUNK) throw err
    const sub = Math.max(LOG_SCAN_FALLBACK_CHUNK, Math.ceil(span / 10))
    const out = []
    for (const c of planChunks(from, to, Infinity, sub)) out.push(...(await provider.getLogs({ ...base, fromBlock: c.from, toBlock: c.to })))
    return out
  }
}

/** Decode a raw log against the contract's interface. Undecodable logs are dropped, not guessed. */
function decode(contract, log) {
  let parsed
  try {
    parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data })
  } catch {
    return null
  }
  if (!parsed) return null
  return {
    address: log.address,
    topics: log.topics,
    data: log.data,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    index: log.index,
    args: parsed.args,
    eventName: parsed.name,
  }
}

/**
 * Scan one contract's event history in bounded, resumable chunks.
 *
 * @param {object} args
 * @param {import('ethers').Contract} args.contract - supplies the address, the provider and the decoder
 * @param {Array} args.filters - one or more `contract.filters.X(...)`; grouped into one request per chunk
 * @param {number} args.fromBlock - the recorded deploy block. NEVER 0 for a live contract.
 * @param {number|string} args.chainId - part of the cache key; an address alone repeats across chains
 * @param {number} [args.toBlock] - inclusive ceiling on BOTH the scan and the answer; defaults to the head
 * @param {number} [args.maxChunks] - chunks this invocation may spend; omit for "as many as it takes"
 * @param {string} [args.cacheKey] - override the derived key (tests)
 * @returns {Promise<{logs: object[], scannedTo: number, complete: boolean}>} `logs` is every log
 *   found from `fromBlock` up to `scannedTo`, accumulated across calls. `complete` is false when
 *   the budget ran out before the head — the caller MUST disclose that rather than treat the
 *   result as the whole history.
 */
export async function scanLogs(args) {
  const { contract, filters, fromBlock, chainId, cacheKey } = args
  const provider = contract.runner?.provider ?? contract.runner
  if (!provider?.getLogs) throw new Error('logScan: contract has no provider')
  const list = Array.isArray(filters) ? filters : [filters]
  const topics = mergeTopics(await Promise.all(list.map(topicsOf)))
  const key = cacheKey || JSON.stringify([String(chainId), String(contract.target), topics, fromBlock])

  // Rule 7: queue behind any scan already running for this key, then run against its cache.
  const prior = inflight.get(key)
  const run = (prior ? prior.catch(() => {}) : Promise.resolve()).then(() => scanOnce({ ...args, provider, topics, key }))
  inflight.set(key, run)
  try {
    return await run
  } finally {
    if (inflight.get(key) === run) inflight.delete(key)
  }
}

async function scanOnce({ contract, provider, topics, key, fromBlock, toBlock, maxChunks = Infinity }) {
  const address = contract.target
  const head = toBlock ?? (await provider.getBlockNumber())
  let entry = cache.get(key)
  if (!entry) {
    entry = restore(key, contract, fromBlock) || { scannedTo: Number(fromBlock) - 1, logs: [], raw: [] }
    cache.set(key, entry)
  }

  // `toBlock` is a CEILING ON THE ANSWER, not just on the scan. The cache is keyed without it (one
  // entry per contract+filter, or a moving head would fragment it into uselessness), so a cache
  // already filled past an explicit ceiling must be trimmed back to it rather than handing the
  // caller blocks it excluded.
  const answer = () => {
    if (toBlock == null) return { logs: entry.logs, scannedTo: entry.scannedTo, complete: entry.scannedTo >= head }
    return {
      logs: entry.logs.filter((l) => l.blockNumber <= toBlock),
      scannedTo: Math.min(entry.scannedTo, toBlock),
      complete: entry.scannedTo >= toBlock,
    }
  }

  // Head can move backwards across a reorg or a load-balanced endpoint; never rewind the cursor
  // (that would re-append logs already held) and never claim to have scanned past the head.
  if (entry.scannedTo >= head) return answer()

  const base = { address, topics }
  let cursor = entry.scannedTo + 1
  let spent = 0

  while (cursor <= head && spent < maxChunks) {
    // One wave of concurrent chunks, still inside the budget. The width is re-read every wave: a
    // refusal in the previous wave may have taught it a smaller cap.
    const wave = planChunks(cursor, head, Math.min(CONCURRENCY, maxChunks - spent), widthFor(provider))
    cursor = wave[wave.length - 1].to + 1
    spent += wave.length
    // A throw here abandons the wave WITHOUT advancing the cursor past it: the caller sees the
    // failure, and the next attempt re-scans from the last block actually accounted for.
    const results = await Promise.all(wave.map((w) => getLogsRange(provider, base, w.from, w.to)))
    for (const raw of results.flat()) {
      const d = decode(contract, raw)
      if (d) {
        entry.logs.push(d)
        entry.raw.push(rawOf(raw))
      }
    }
    entry.scannedTo = wave[wave.length - 1].to
    persist(key, entry)
  }

  return answer()
}

/**
 * One bounded, chunked sweep of a fixed block range. Raw logs, no cache, no cursor, no decoding.
 *
 * `scanLogs` above is built for HISTORY: a fixed `fromBlock` (a deploy block) that never moves, so
 * a session cache and a resumable watermark are pure wins. This is the other shape — a SLIDING
 * window anchored to the head ("the last six hours"), read by a caller that must be able to derive
 * its answer afresh every time:
 *
 *   - the anchor moves with every call, so `scanLogs`' key (which contains `fromBlock`) would
 *     fragment into a new cache entry per poll: never a hit, and an unbounded Map;
 *   - a watermark that never rewinds is exactly wrong for a reorg-sensitive read. `scanLogs` may
 *     keep serving a log the chain has dropped, which for a caller that turns one log into "your
 *     money arrived" is the single worst answer available. Re-deriving costs requests; it cannot
 *     be stale.
 *
 * What IS shared with `scanLogs` — and the reason this lives here rather than in the caller — is
 * the policy: `planChunks` for the width, `getLogsRange` for the adaptive/narrow retry,
 * `CONCURRENCY` for the request rate. Those must never diverge between the two shapes.
 *
 * Throws when a range cannot be read even at the narrow width, for the same reason `scanLogs` does:
 * a silently skipped range is indistinguishable from "nothing happened there". Callers that must
 * degrade honestly catch it and report "no new information" — never a negative result.
 *
 * @param {object} args
 * @param {object} args.provider - anything with `getLogs` (optionally `maxLogRange`/`logEndpointKey`)
 * @param {string} args.address - the contract to read
 * @param {Array} args.topics - an `eth_getLogs` topics array (topic0 may itself be an OR-set)
 * @param {number} args.fromBlock - first block, inclusive
 * @param {number} args.toBlock - last block, inclusive. A NUMBER, never `'latest'`: a range with an
 *   open end cannot be chunked, which is how an over-cap request gets issued in the first place.
 * @returns {Promise<object[]>} every raw log in the range, in no particular order
 */
export async function scanLogRange({ provider, address, topics, fromBlock, toBlock }) {
  if (!provider?.getLogs) throw new Error('logScan: no provider')
  const from = Number(fromBlock)
  const to = Number(toBlock)
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('logScan: scanLogRange needs numeric block bounds')
  if (to < from) return []

  const base = { address, topics }
  const out = []
  let cursor = from
  while (cursor <= to) {
    const wave = planChunks(cursor, to, CONCURRENCY, widthFor(provider))
    cursor = wave[wave.length - 1].to + 1
    const results = await Promise.all(wave.map((w) => getLogsRange(provider, base, w.from, w.to)))
    out.push(...results.flat())
  }
  return out
}

export default scanLogs
