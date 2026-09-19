/**
 * Screen ONE address against EVERY source on EVERY chain this build may read (spec 021
 * amendment, issue #1458).
 *
 * Rules, each of which has a way to be silently wrong:
 *
 *   1. COHORT-BOUNDED, MINUS WHAT CANNOT BE REACHED. `screeningChainIds()` — the cohort
 *      (constitution III: no testnet build reads mainnet lists, and `readProviderFor` refuses an
 *      out-of-cohort chain anyway) minus the local-only sandboxes, whose reads are guaranteed to
 *      fail from a shipped build and so are never reported as a degraded source (issue #1458).
 *   2. FAILURE-ISOLATED. Every source resolves on its own; one dead endpoint is one `unreadable`
 *      row, never a rejected screen. `screenAddressAcrossEstate` NEVER rejects.
 *   3. DEADLINE-BOUNDED. A source that does not answer within `deadlineMs` is `unreadable` with
 *      that reason. The spec-104 lesson: an unbounded wait on an external system turns one
 *      failure into a hung surface.
 *   4. PROVIDERS COME FROM THE SPEC-069 SEAM. `readProviderFor` reuses the wallet's provider on
 *      the connected chain and resolves the member's endpoint + failover elsewhere. Never
 *      `NETWORKS[chainId].rpcUrl`.
 *   5. A VERDICT IS DERIVED, NEVER STORED. `deriveVerdict` is a pure function of the readings;
 *      the readings are what is cached, so the details a member expands always match the pill.
 *
 * Cached per lowercase address for `SCREENING_TTL_MS` (same TTL as the per-chain screen) with
 * in-flight de-duplication, so five fields showing the same address cost one sweep.
 */
// Not viem's `isAddress`: neither of its settings reproduces ethers' (see the seam's table).
import { getAddress, isAddress } from '../evm/address'
import { readProviderFor } from '../chains/estate'
import { SCREENING_TTL_MS } from '../addressBook/constants'
import { screeningChainIds, screeningSourcesFor } from './sources'
import { deriveVerdict, READ, UNREADABLE, VERDICTS } from './verdict'

export const DEFAULT_DEADLINE_MS = 8_000

const cache = new Map() // key -> { result, ts }
const inflight = new Map() // key -> Promise<result>

/** Test seam. */
export function __clearEstateScreeningCache() {
  cache.clear()
  inflight.clear()
}

function withDeadline(promise, ms, onTimeout) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(onTimeout)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function cacheKey(address, chainIds) {
  return `${address.toLowerCase()}|${chainIds.join(',')}`
}

/**
 * @typedef {object} SourceReading
 * @property {string} id
 * @property {string} kind
 * @property {string} label
 * @property {number} chainId
 * @property {string} address     the list contract
 * @property {'read'|'unreadable'} status
 * @property {boolean} [flagged]  only on `read`
 * @property {string|null} [detail] only on `read`
 * @property {string} [reason]    only on `unreadable` — MEMBER-FACING copy, rendered verbatim
 * @property {Error}  [error]     only on `unreadable` — the underlying failure, never rendered
 */

/**
 * @typedef {object} EstateScreeningResult
 * @property {string} address      checksummed
 * @property {number[]} chainIds   the chains asked
 * @property {SourceReading[]} readings
 * @property {number[]} uncovered  chains asked that have NO source at all
 * @property {string} verdict      one of VERDICTS
 * @property {number} readAt
 */

/**
 * Why a list gave no answer, in words a MEMBER can read.
 *
 * `reason` is rendered verbatim under an address field ("Could not read — …"), so it is copy, not
 * a log line. A decode failure is the common case — a chain whose contract answers `0x`, which is
 * what an address holding no contract returns — and the underlying libraries describe it in their
 * own terms: ethers says "could not decode result data", viem says `The contract function
 * "isAllowed" returned no data ("0x").`, naming a Solidity function a member has never heard of
 * and, in its long form, printing a docs URL and a version. Neither belongs in this sentence.
 *
 * Anything we do not recognise still passes through, because a specific unknown failure is more
 * useful to a member than a generic one — the mapping only replaces the messages we know are
 * internal. The raw error is left on the reading for callers that want it.
 */
function memberReadableReason(error) {
  const text = String(error?.shortMessage || error?.message || error || '')
  if (/returned no data|could not decode result data|BAD_DATA|ZeroData/i.test(text)) {
    return 'this network answered with nothing'
  }
  if (/no RPC endpoint is configured/i.test(text)) return 'no read connection to this network'
  // Keep a short, single-line reason: a multi-line library dump renders as a wall of text in a
  // row that is one line of a list.
  const firstLine = text.split('\n')[0].trim()
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine || 'no answer'
}

async function readSource(source, provider, account, deadlineMs) {
  const base = {
    id: source.id,
    kind: source.kind,
    label: source.label,
    chainId: source.chainId,
    address: source.address,
  }
  if (!provider) return { ...base, status: UNREADABLE, reason: 'no read connection to this network' }
  try {
    const { flagged, detail } = await withDeadline(
      source.read(provider, account),
      deadlineMs,
      `no answer within ${Math.round(deadlineMs / 1000)}s`,
    )
    return { ...base, status: READ, flagged: Boolean(flagged), detail: detail ?? null }
  } catch (e) {
    return { ...base, status: UNREADABLE, reason: memberReadableReason(e), error: e }
  }
}

/**
 * @param {string} address
 * @param {object} [opts]
 * @param {number[]} [opts.chainIds]        defaults to the cohort
 * @param {number}   [opts.walletChainId]
 * @param {*}        [opts.walletProvider]
 * @param {number}   [opts.deadlineMs]
 * @param {boolean}  [opts.force]           bypass the cache (a submission-time re-check)
 * @param {(chainId:number) => any} [opts.providerFor]  test seam; defaults to the spec-069 route
 * @param {(chainId:number) => import('./sources').ScreeningSource[]} [opts.sourcesFor] test seam
 * @returns {Promise<EstateScreeningResult>}
 */
export function screenAddressAcrossEstate(address, opts = {}) {
  const {
    chainIds = screeningChainIds(),
    walletChainId,
    walletProvider,
    deadlineMs = DEFAULT_DEADLINE_MS,
    force = false,
    providerFor = (chainId) => readProviderFor(chainId, walletChainId, walletProvider),
    sourcesFor = screeningSourcesFor,
  } = opts

  if (!isAddress(address)) {
    return Promise.resolve({
      address: String(address ?? ''),
      chainIds: [],
      readings: [],
      uncovered: [],
      verdict: VERDICTS.UNSCREENED,
      readAt: Date.now(),
    })
  }
  const account = getAddress(address)
  const ids = [...new Set(chainIds.map(Number))]
  const key = cacheKey(account, ids)

  if (!force) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.ts < SCREENING_TTL_MS) return Promise.resolve(hit.result)
    if (inflight.has(key)) return inflight.get(key)
  }

  const run = async () => {
    const uncovered = []
    const jobs = []
    for (const chainId of ids) {
      const sources = sourcesFor(chainId)
      if (!sources.length) {
        uncovered.push(chainId)
        continue
      }
      let provider
      try {
        provider = providerFor(chainId)
      } catch {
        provider = null
      }
      for (const s of sources) jobs.push(readSource(s, provider, account, deadlineMs))
    }
    const readings = await Promise.all(jobs)
    const result = {
      address: account,
      chainIds: ids,
      readings,
      uncovered,
      verdict: deriveVerdict(readings),
      readAt: Date.now(),
    }
    cache.set(key, { result, ts: result.readAt })
    return result
  }

  if (force) return run()
  const p = run().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key)
  })
  inflight.set(key, p)
  return p
}

/** Drop one address from the cache so the next screen is a live read. */
export function forgetEstateScreening(address) {
  if (!isAddress(address)) return
  const prefix = `${getAddress(address).toLowerCase()}|`
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k)
}
