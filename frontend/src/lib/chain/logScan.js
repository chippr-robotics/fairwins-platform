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
 * REQUEST VOLUME (the 429 fix). Measured on a cold Protect-queue load of a real vault through a
 * member's QuickNode Polygon endpoint, the old path made 468 HTTP requests (≈1,900 RPC calls,
 * unpaced, tripping "50/second request limit reached") and repeated ALL of it on every reload; with
 * the rules below it is 209 requests cold and 5 on reload. More rules keep a scan from being a storm:
 *
 *  5. **Width follows the endpoint.** History is read through the chain's log client
 *     (`config/logScanEndpoints.js`), whose handle reports `maxLogRange` — Arbitrum's public
 *     endpoint takes 100,000 blocks per request, ten times the old fixed chunk. A refusal that STATES a cap ("limited to a 10,000 range") shrinks the width
 *     to it and the width is remembered for that endpoint, so the next chunk is not refused too.
 *  6. **An endpoint that cannot serve history fails FAST, and says so.** "Archive requests require a
 *     personal token", or a cap so small that the history would take thousands of requests, throws
 *     `LogHistoryUnavailableError` at once — never a sub-chunk retry of a refusal that narrowing
 *     cannot fix, and never a 100-block crawl. The caller renders it as unreadable, which is what it is.
 *  7. **One scan per key at a time.** Several surfaces read the same contract history (the vault
 *     queue, the cross-chain queue, the notification source); concurrent callers now queue behind
 *     one scan and then read its cache, instead of each issuing the same backfill.
 *  8. **A finished scan can survive a reload** — opt-in per caller (`persist: true`; the custody
 *     streams use it). The watermark and raw logs are kept per device (localStorage, a bounded number
 *     of entries), so a reload reads only new blocks. The reason this used to be session-only —
 *     "a stale watermark across releases would silently skip history" — is answered by what the key
 *     holds and what is restored: the key is chain + address + topics + fromBlock (a changed filter
 *     or deploy block is a different key), raw logs are re-DECODED with the current ABI on restore,
 *     the version prefix is bumped on any change to this format, a record written through a different
 *     endpoint is discarded, and roughly the last ten minutes of blocks are always re-read. Logs are
 *     public chain data; nothing member-specific is stored.
 *  9. **A count the chain already knows bounds the scan.** `scanLogsUntil` reads NEWEST-FIRST and
 *     stops once it holds the number of events the caller knows exist (a Safe's execution outcomes
 *     number exactly its `nonce()`), so its cost follows recent activity, not chain age.
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
/** Blocks re-read after a restore from storage (default), so a reorg near the old head cannot leave a ghost. */
export const REORG_MARGIN = 64
/** ~10 minutes of blocks per chain — a block-count margin is 16 seconds on Arbitrum. */
const REORG_MARGIN_BY_CHAIN = { 1: 64, 10: 300, 8453: 300, 137: 300, 80002: 300, 42161: 2_400, 61: 64, 63: 64 }
export function reorgMarginFor(chainId) {
  return REORG_MARGIN_BY_CHAIN[Number(chainId)] ?? REORG_MARGIN
}
/** At most this many persisted scans per device; the least recently written is evicted first. */
const MAX_PERSISTED_ENTRIES = 40
/** Rate-limit refusals delivered in the response BODY (status 200): back off and retry the chunk. */
const RATE_LIMITED = /request limit reached|rate limit|too many requests|exceeded .*capacity|\b429\b/i
const RATE_LIMIT_RETRIES = 3
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** In-flight chunks per scan. Pacing per host is the limiter's job (lib/chains/hostLimiter.js). */
const CONCURRENCY = 4
/** Storage prefix — bump the version on ANY change to what is stored. */
const STORE_PREFIX = 'fw_logscan_v1:'
/** Above this many logs a history is not persisted (it is still cached for the session). */
const MAX_PERSISTED_LOGS = 2_000

/**
 * What a member reads when the endpoint cannot serve history. The provider's own words stay on
 * `cause` (logs, support) — they name a vendor's signup page, which is not this app's advice.
 */
export const HISTORY_UNAVAILABLE =
  "This network's endpoint does not serve transaction history. Add your own endpoint for this network in Network settings to read it."

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
  untilCache.clear()
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
  untilCache.clear()
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

function persistedKeys(ls) {
  const keys = []
  for (let i = 0; i < ls.length; i += 1) {
    const k = ls.key(i)
    if (k && k.startsWith(STORE_PREFIX)) keys.push(k)
  }
  return keys
}

function persist(key, entry, endpoint) {
  const ls = storage()
  if (!ls) return
  try {
    if (entry.raw.length > MAX_PERSISTED_LOGS) {
      ls.removeItem(STORE_PREFIX + key)
      return
    }
    ls.setItem(STORE_PREFIX + key, JSON.stringify({ endpoint, at: Date.now(), scannedTo: entry.scannedTo, raw: entry.raw }))
    const keys = persistedKeys(ls)
    if (keys.length > MAX_PERSISTED_ENTRIES) {
      const aged = keys
        .map((k) => {
          try {
            return [k, JSON.parse(ls.getItem(k))?.at ?? 0]
          } catch {
            return [k, 0]
          }
        })
        .sort((a, b) => a[1] - b[1])
      for (const [k] of aged.slice(0, keys.length - MAX_PERSISTED_ENTRIES)) ls.removeItem(k)
    }
  } catch {
    /* quota / private mode: the session cache still works */
  }
}

/**
 * Restore a persisted scan, re-decoded with the CURRENT interface and wound back by the chain's
 * reorg margin. A record written through a different endpoint is discarded: a reload must still
 * heal a watermark that a bad endpoint produced.
 */
function restore(key, contract, fromBlock, chainId, endpoint) {
  const ls = storage()
  if (!ls) return null
  try {
    const text = ls.getItem(STORE_PREFIX + key)
    if (!text) return null
    const stored = JSON.parse(text)
    if (!Number.isFinite(stored?.scannedTo) || !Array.isArray(stored.raw) || stored.endpoint !== endpoint) {
      ls.removeItem(STORE_PREFIX + key)
      return null
    }
    const scannedTo = Math.max(Number(fromBlock) - 1, stored.scannedTo - reorgMarginFor(chainId))
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
    /but only ([\d,]+) are allowed/i, // arb1: "query spans 5000000 blocks …, but only 100000 are allowed"
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
async function getLogsRange(provider, base, from, to, attempt = 0) {
  try {
    return await provider.getLogs({ ...base, fromBlock: from, toBlock: to })
  } catch (err) {
    const text = errorText(err)
    if (UNSERVABLE.test(text)) {
      throw new LogHistoryUnavailableError(HISTORY_UNAVAILABLE, { cause: err })
    }
    // A rate-limit refusal is not a width problem: narrowing would multiply the very requests that
    // tripped it. Wait (doubling) and ask for the SAME range again; give up loudly after a few.
    if (RATE_LIMITED.test(text)) {
      if (attempt >= RATE_LIMIT_RETRIES) throw err
      await sleep(1000 * 2 ** attempt)
      return getLogsRange(provider, base, from, to, attempt + 1)
    }
    const span = to - from + 1
    const cap = statedRangeCap(text)
    if (cap != null) {
      if (cap < MIN_USABLE_LOG_RANGE) {
        throw new LogHistoryUnavailableError(HISTORY_UNAVAILABLE, { cause: err })
      }
      if (provider?.logEndpointKey) learnedWidth.set(provider.logEndpointKey, Math.min(cap, learnedWidth.get(provider.logEndpointKey) ?? Infinity))
      if (cap >= span) throw err // it refused a range already inside its own cap: not a width problem
      const out = []
      for (const c of planChunks(from, to, Infinity, cap)) out.push(...(await getLogsRange(provider, base, c.from, c.to)))
      return out
    }
    // No stated cap (some endpoints cap by RESULT size): BISECT down to the floor, then give up
    // loudly. Halving keeps a 5M-block refusal from becoming ten 500k requests that all fail too.
    if (span <= LOG_SCAN_FALLBACK_CHUNK) throw err
    const mid = from + Math.floor(span / 2) - 1
    const left = await getLogsRange(provider, base, from, mid)
    const right = await getLogsRange(provider, base, mid + 1, to)
    return [...left, ...right]
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
 * @param {boolean} [args.persist] - keep the finished scan on this device across reloads (rule 8)
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

async function scanOnce({ contract, provider, topics, key, fromBlock, chainId, toBlock, maxChunks = Infinity, persist: keep = false }) {
  const address = contract.target
  const endpoint = provider.logEndpointKey ?? null
  const head = toBlock ?? (await provider.getBlockNumber())
  let entry = cache.get(key)
  if (!entry) {
    entry = (keep && restore(key, contract, fromBlock, chainId, endpoint)) || { scannedTo: Number(fromBlock) - 1, logs: [], raw: [] }
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
    if (keep) persist(key, entry, endpoint)
  }

  return answer()
}

/** key -> { highTo, lowFrom, logs } for count-bounded scans (memory only; they are cheap to redo). */
const untilCache = new Map()

/**
 * Newest-first history read that STOPS once it holds `target` events (rule 9).
 *
 * For a stream whose total the chain already states — a Safe's ExecutionSuccess + ExecutionFailure
 * events number exactly its `nonce()`, because every executed Safe transaction increments the nonce
 * once and emits exactly one of the two — reading from the deploy block forward pays for the chain's
 * whole age to find a handful of events. Reading backwards from the head and stopping at the count
 * pays only for the span since the oldest of them; at `target === 0` it costs nothing at all.
 *
 * `complete` is true when the count is met or the scan reached `fromBlock`. A later call first
 * reads the blocks added since (forward), then continues downward only if the count grew past what
 * it holds. Fewer than `target` events after reaching `fromBlock` is still `complete` — the caller
 * asked for history from there, and it is all read — but `found < target` tells the caller the
 * count and the history disagree (e.g. events before `fromBlock`), which it may disclose.
 *
 * @returns {Promise<{logs: object[], complete: boolean, found: number}>}
 */
export async function scanLogsUntil({ contract, filters, fromBlock, chainId, target, maxChunks = Infinity }) {
  const provider = contract.runner?.provider ?? contract.runner
  if (!provider?.getLogs) throw new Error('logScan: contract has no provider')
  const list = Array.isArray(filters) ? filters : [filters]
  const topics = mergeTopics(await Promise.all(list.map(topicsOf)))
  const key = JSON.stringify(['until', String(chainId), String(contract.target), topics, fromBlock])
  const want = Math.max(0, Number(target) || 0)
  const floor = Number(fromBlock)

  const prior = inflight.get(key)
  const run = (prior ? prior.catch(() => {}) : Promise.resolve()).then(async () => {
    let entry = untilCache.get(key)
    if (want === 0 && !entry) return { logs: [], complete: true, found: 0 }
    const head = await provider.getBlockNumber()
    if (!entry) {
      entry = { highTo: head, lowFrom: head + 1, logs: [] }
      untilCache.set(key, entry)
    }
    const base = { address: contract.target, topics }
    const take = (raws) => {
      for (const raw of raws) {
        const d = decode(contract, raw)
        if (d) entry.logs.push(d)
      }
    }
    // New blocks since the last call first: events land at the head.
    if (head > entry.highTo) {
      take(await scanLogRange({ provider, address: base.address, topics, fromBlock: entry.highTo + 1, toBlock: head }))
      entry.highTo = head
    }
    let spent = 0
    while (entry.logs.length < want && entry.lowFrom > floor && spent < maxChunks) {
      const width = widthFor(provider)
      const waves = []
      let hi = entry.lowFrom - 1
      for (let i = 0; i < CONCURRENCY && hi >= floor && spent + waves.length < maxChunks; i += 1) {
        const lo = Math.max(floor, hi - width + 1)
        waves.push({ from: lo, to: hi })
        hi = lo - 1
      }
      spent += waves.length
      const results = await Promise.all(waves.map((w) => getLogsRange(provider, base, w.from, w.to)))
      take(results.flat())
      entry.lowFrom = waves[waves.length - 1].from
    }
    const found = entry.logs.length
    return { logs: entry.logs, complete: found >= want || entry.lowFrom <= floor, found }
  })
  inflight.set(key, run)
  try {
    return await run
  } finally {
    if (inflight.get(key) === run) inflight.delete(key)
  }
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
