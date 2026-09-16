/**
 * MiniAppRegistry read client (spec 073) — the only path from the app to the mini-app catalog.
 *
 * Everything the host eventually EXECUTES is decided by what this module reports: which listings
 * exist, which are Approved, and which on-chain `(cid, manifestHash)` tuple the loader is allowed to
 * fetch and verify (FR-010/FR-011). That makes this a trust boundary rather than a data-access
 * convenience, and three rules follow from it.
 *
 * 1. **ABSENCE AND FAILURE ARE DIFFERENT ANSWERS, AND NEITHER OF THEM IS AN EMPTY CATALOG.**
 *    `{ status: 'not-deployed' }` is a FACT about this build: no registry address is configured for
 *    the cohort's registry chain, so there is no catalog to have an opinion about. `{ status:
 *    'unreachable' }` is the ABSENCE of a fact: a registry exists and we could not read it. Those
 *    lead to different copy and different affordances, so they are different outcomes — the
 *    `fetchFeeQuote` distinction (spec 060/067), applied to listings instead of rates.
 *
 *    Collapsing either into `apps: []` would be a lie with teeth: an empty catalog reads to a member
 *    as "nothing is approved", so an RPC outage would render exactly like a curator having suspended
 *    every app — and a *single* unreadable page would render exactly like one app having been
 *    suspended. So no failure path in this module ever produces an `apps` array at all, and a
 *    partial page read fails the WHOLE catalog rather than presenting a subset as the complete
 *    curated list (spec.md edge case: "states it cannot verify listings", never stale-as-verified).
 *
 * 2. **THE CACHE NEVER DECIDES WHAT EXECUTES.** `fetchCatalog` memoises its result so browsing does
 *    not re-page the registry on every keystroke, and stamps `fetchedAt` so a surface can disclose
 *    how old the list is. The launch path does not use it: `fetchApp` always re-reads the single
 *    record it is about to run (FR-010), because the window this closes is precisely the one a
 *    curator uses — suspending a compromised app between a member opening the catalog and clicking
 *    Launch. A cached snapshot is offered on failure only under the `stale` key, never as `apps`, so
 *    no caller can render it as verified by accident.
 *
 * 3. **ONE CHAIN, RESOLVED HERE.** The registry lives on the cohort's single reference chain
 *    (`miniAppChainId()`, FR-025) and is read through the chain seam so the member's own RPC
 *    route applies (spec 069). Callers never pass a chain id or a provider: a mini-app catalog read
 *    against the wrong chain would approve packages under an authority this build must not trust.
 */
import { readContract } from '../chains/readContract'
import { AppStatus, MINI_APP_REGISTRY_ABI } from '../../abis/miniAppRegistry'
import { getContractAddressForChain } from '../../config/contracts'
import { miniAppChainId } from '../../config/networks'
import { getPublicClient } from '../chains/publicClient'
import { APP_ID_PATTERN } from './manifest'

/** Discriminants every function in this module returns. Never a bare value, never a bare array. */
export const REGISTRY_STATUS = Object.freeze({
  /** The registry answered. */
  OK: 'ok',
  /** No registry address is configured for this build's registry chain. */
  NOT_DEPLOYED: 'not-deployed',
  /** A registry IS configured and we could not read it. Not evidence that anything is unapproved. */
  UNREACHABLE: 'unreachable',
  /** The registry answered and holds no such record. Only `fetchApp`/`fetchAppByName` return it. */
  NOT_FOUND: 'not-found',
})

/** Why an `unreachable` outcome happened, so a surface can be specific without guessing. */
export const UNREACHABLE_REASON = Object.freeze({
  /** No read route to the registry chain at all (no member endpoint, no build default). */
  NO_ROUTE: 'no-route',
  /** The call failed: RPC down, request rejected, wrong/undeployed bytecode at the address. */
  READ_FAILED: 'read-failed',
  /** The call succeeded but returned something no healthy registry could have produced. */
  BAD_RESPONSE: 'bad-response',
})

/**
 * Records per `getAppsPaged` call. This value must never EXCEED the contract's `MAX_PAGE_LIMIT`,
 * which is **25** (`MiniAppRegistry.sol:82`) — the same number, so this page size sits exactly AT
 * the cap, not under it.
 *
 * That equality is load-bearing and is why `MINIAPP_MAX_PAGE_LIMIT` below exists to pin it. Ask for
 * more than the cap and the contract silently clamps the page (`if (limit > MAX_PAGE_LIMIT) limit =
 * MAX_PAGE_LIMIT`), `readAllRecords` sees a page shorter than it asked for, takes that as the end of
 * the catalog and stops — reporting a TRUNCATED list as a complete one, with `status: 'ok'`. A
 * fabricated-completeness failure is the one outcome the rest of this module is built to avoid, and
 * it would be invisible: no error, no partial flag, just apps missing from the catalog.
 *
 * An `AppView` is mostly bounded STRINGS, so a page is far heavier than the record count suggests:
 * worst case per record is name 64 B + description 512 B + two package tuples at 256 B of CID each,
 * which ABI-encodes to roughly 1.8 KB and travels as ~3.6 KB of JSON-RPC hex. A full 100-record page
 * is therefore ~180 KB encoded / ~360 KB on the wire from a single `eth_call` — enough to hit
 * response-size ceilings and view-gas caps on ordinary public endpoints (and on a member's own node,
 * whose limits we do not control, spec 069). Twenty-five keeps a worst-case page near 45 KB / 90 KB,
 * which every endpoint we target serves comfortably.
 *
 * Paging cost is not the trade-off it looks like: the catalog is a curated enterprise list of tens of
 * apps, so this is one or two round trips either way.
 */
export const CATALOG_PAGE_SIZE = 25

/**
 * The contract's own `MAX_PAGE_LIMIT`, mirrored here so the invariant above is checkable.
 *
 * Duplicating a contract constant in the client is normally a smell; here it is the only way to
 * state the relationship at all, since the client cannot read a constant it has not called. The
 * test that pins `CATALOG_PAGE_SIZE <= MINIAPP_MAX_PAGE_LIMIT` reads BOTH numbers out of the
 * Solidity source, so raising the cap on chain without raising it here — or vice versa — fails.
 */
export const MINIAPP_MAX_PAGE_LIMIT = 25

/**
 * How long a catalog snapshot is served from memory before the next `fetchCatalog` re-reads.
 *
 * Short on purpose. This governs only BROWSING (what the catalog grid shows); it governs nothing
 * about what runs, because the launch path re-reads (rule 2 above). A minute is long enough to make
 * typing in the search box free and short enough that a curator action shows up while the member is
 * still looking at the page.
 */
export const CATALOG_CACHE_TTL_MS = 60_000

/**
 * The most listings we will believe `appCount()` about.
 *
 * A wrong address in the deployment record can decode an unrelated storage word as a `uint256`, and
 * paging to that number would issue millions of requests against the member's endpoint. This is a
 * loudness guard, not a truncation: exceeding it yields `unreachable` (we cannot present a catalog),
 * never a silently shortened list presented as the complete curated set.
 */
const MAX_PLAUSIBLE_APP_COUNT = 10_000

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const ZERO_HASH = `0x${'0'.repeat(64)}`

/** chainId -> { registryAddress, fetchedAt, apps, allApps }. Module-scoped; see rule 2. */
const catalogCache = new Map()

/**
 * The registry address for this build's registry chain, or null when there is none.
 *
 * A blank or malformed entry both mean the same thing to a caller — this build has no usable
 * registry — and both are configuration facts rather than runtime failures, so both read as
 * not-deployed rather than as an outage.
 *
 * @param {number} [chainId] defaults to the cohort registry chain
 * @returns {string|null}
 */
export function miniAppRegistryAddress(chainId = miniAppChainId()) {
  const address = getContractAddressForChain('miniAppRegistry', chainId)
  return address && ADDRESS_RE.test(address) ? address : null
}

/** Where this build reads the catalog from — for "the catalog lives on X" disclosure. */
export function registryLocation() {
  const chainId = miniAppChainId()
  return { chainId, registryAddress: miniAppRegistryAddress(chainId) }
}

/** Drop the memoised catalog. Call after a curator/vendor write, or when the account context changes. */
export function clearCatalogCache() {
  catalogCache.clear()
}

function notDeployed(chainId) {
  return { status: REGISTRY_STATUS.NOT_DEPLOYED, chainId, registryAddress: null }
}

/**
 * Build an `unreachable` outcome, attaching the last good snapshot (if any) under `stale`.
 *
 * `stale` is deliberately NOT `apps`: spec.md allows a previously verified list to be shown only
 * behind an explicit "verification unavailable" disclosure, and a caller has to reach for a
 * differently-named key to do that. A caller that renders `result.apps` gets nothing, which is the
 * correct default.
 */
function unreachable({ chainId, registryAddress, reason, error }) {
  const entry = catalogCache.get(chainId)
  const stale =
    entry && entry.registryAddress === registryAddress
      ? {
          apps: entry.apps,
          allApps: entry.allApps,
          fetchedAt: entry.fetchedAt,
          ageMs: Date.now() - entry.fetchedAt,
        }
      : null
  return {
    status: REGISTRY_STATUS.UNREACHABLE,
    chainId,
    registryAddress,
    reason,
    error: error instanceof Error ? error : new Error(String(error?.message || error || reason)),
    stale,
  }
}

/**
 * Resolve chain + address + a reader, or the outcome explaining why we cannot read.
 *
 * The no-route case is UNREACHABLE, not not-deployed: a registry that exists on a chain this
 * build currently has no route to is an unread registry, and reporting it as absent would tell a
 * member the platform has no apps when it has a catalog they simply cannot reach right now.
 *
 * Spec 110: the reader NAMES the registry's chain on every call. That matters more here than
 * almost anywhere else in the app — the catalog decides which third-party packages the host
 * EXECUTES, so a read that inherited its chain from an ambient connection could run
 * mainnet-curated code against a testnet wallet (spec 073 rule 2).
 */
function resolveRegistry() {
  const chainId = miniAppChainId()
  const registryAddress = miniAppRegistryAddress(chainId)
  if (!registryAddress) return { outcome: notDeployed(chainId) }

  if (!getPublicClient(chainId)) {
    return {
      outcome: unreachable({
        chainId,
        registryAddress,
        reason: UNREACHABLE_REASON.NO_ROUTE,
        error: new Error(`no read endpoint for chain ${chainId}, where the mini-app registry lives`),
      }),
    }
  }

  const call = (functionName) => (...args) =>
    readContract(chainId, { address: registryAddress, abi: MINI_APP_REGISTRY_ABI, functionName, args })
  const contract = {
    appCount: call('appCount'),
    getAppsPaged: call('getAppsPaged'),
    getApp: call('getApp'),
    idByName: call('idByName'),
    appIdsByVendor: call('appIdsByVendor'),
  }
  return { chainId, registryAddress, contract }
}

/**
 * Normalize one on-chain `PackageRef`.
 *
 * `present` is the load-bearing field. Solidity zero-fills, so an app that has never been approved
 * carries an `approved` tuple of `("", 0x00…, 0)` rather than nothing at all — and a loader handed
 * that would fetch the empty CID. Both halves must be non-empty for the tuple to name a package.
 */
function normalizePackageRef(raw) {
  const cid = typeof raw?.cid === 'string' ? raw.cid : ''
  const manifestHash = raw?.manifestHash ? String(raw.manifestHash) : ZERO_HASH
  return Object.freeze({
    cid,
    manifestHash,
    // uint64, monotonic from 1 — never near the float-safe ceiling.
    version: Number(raw?.version ?? 0),
    present: cid.length > 0 && manifestHash !== ZERO_HASH,
  })
}

/**
 * Normalize one `AppView` tuple into plain, frozen JS.
 *
 * Frozen because these objects are shared out of the cache: an in-place `apps.sort()` by one surface
 * would otherwise reorder another's snapshot, and a mutated `approved.cid` would change what the
 * loader fetches. Callers copy before sorting (`[...apps].sort(…)`); a mutation attempt throws
 * rather than silently corrupting a shared read.
 *
 * `launchable` is the catalog's admission test and comes FROM THE CHAIN (`AppView.launchable`) — it is
 * deliberately NOT re-derived here. It is not the same question as `status === Approved`: a live app
 * whose vendor has an update in review is Pending AND launchable, still serving its last reviewed
 * package (FR-003). Deriving it from status would drop that app out of the catalog the moment its
 * vendor submitted anything — handing every vendor an offline switch for their own live app.
 *
 * The local `&& approved.present` is a belt-and-braces agreement check, not a second opinion: if the
 * chain ever said launchable with no servable tuple we would be offering a launch that can only fail,
 * so we decline it rather than trust it.
 */
export function normalizeApp(raw) {
  const status = Number(raw?.status)
  const approved = normalizePackageRef(raw?.approved)
  return Object.freeze({
    // uint256 ids are allocated sequentially from 1 — Number is exact for any real catalog.
    id: Number(raw?.id ?? 0),
    vendor: raw?.vendor ?? null,
    name: raw?.name ?? '',
    description: raw?.description ?? '',
    category: Number(raw?.category),
    status,
    approved,
    proposed: normalizePackageRef(raw?.proposed),
    submittedAt: Number(raw?.submittedAt ?? 0),
    approvedAt: Number(raw?.approvedAt ?? 0),
    updatedAt: Number(raw?.updatedAt ?? 0),
    launchable: Boolean(raw?.launchable) && approved.present,
  })
}

/**
 * Page the whole catalog. Throws on any failure — a half-read catalog is not a catalog (rule 1).
 *
 * Pages are read SEQUENTIALLY rather than fired in parallel: each response is large (see
 * `CATALOG_PAGE_SIZE`), the transport batches concurrent calls into one request by default, and a failure
 * on page one should abort rather than leave four more heavy requests in flight against a member's
 * endpoint. The loop is bounded by `appCount` — checked for plausibility first — so it cannot spin.
 */
async function readAllRecords(contract) {
  const total = Number(await contract.appCount())
  if (!Number.isInteger(total) || total < 0 || total > MAX_PLAUSIBLE_APP_COUNT) {
    const err = new Error(`mini-app registry reported an implausible appCount (${total})`)
    err.code = UNREACHABLE_REASON.BAD_RESPONSE
    throw err
  }

  const records = []
  for (let offset = 0; offset < total; offset += CATALOG_PAGE_SIZE) {
    const page = await contract.getAppsPaged(offset, CATALOG_PAGE_SIZE)
    const length = page?.length ?? 0
    for (let i = 0; i < length; i += 1) records.push(normalizeApp(page[i]))
    // A short page means the registry has nothing more to give (it clamps the window to `appCount`),
    // which also covers a listing count that shrank between the count read and this one.
    if (length < CATALOG_PAGE_SIZE) break
  }
  return records
}

/**
 * Read the whole catalog.
 *
 * On success returns BOTH lists, because two different audiences read this registry and giving them
 * one list would force one of them to be wrong:
 *   - `apps`    — Approved and servable only. The member-facing catalog (FR-007); a Pending or
 *                 Suspended record must never appear here, and nothing in this list can be a package
 *                 the host has no approved tuple for.
 *   - `allApps` — every record, every status. Curator review queues (FR-022) and vendor status
 *                 lists (FR-023) exist precisely to look at the records the catalog hides.
 *
 * `fetchedAt` (epoch ms) and `ageMs` are for disclosure: a surface showing a cached list should say
 * how old it is rather than implying it was just verified.
 *
 * @param {{force?: boolean}} [options] `force: true` bypasses the memo (use after a lifecycle write)
 * @returns {Promise<
 *   {status:'ok', apps: object[], allApps: object[], fetchedAt: number, ageMs: number, cached: boolean, chainId: number, registryAddress: string} |
 *   {status:'not-deployed', chainId: number, registryAddress: null} |
 *   {status:'unreachable', chainId: number, registryAddress: string, reason: string, error: Error, stale: object|null}
 * >}
 */
export async function fetchCatalog({ force = false } = {}) {
  const chainId = miniAppChainId()
  const registryAddress = miniAppRegistryAddress(chainId)
  if (!registryAddress) return notDeployed(chainId)

  if (!force) {
    const entry = catalogCache.get(chainId)
    const ageMs = entry ? Date.now() - entry.fetchedAt : Infinity
    // An entry recorded against a different address belongs to a different registry (a config change
    // between reads), so it is not this catalog's snapshot at all.
    if (entry && entry.registryAddress === registryAddress && ageMs < CATALOG_CACHE_TTL_MS) {
      return {
        status: REGISTRY_STATUS.OK,
        apps: entry.apps,
        allApps: entry.allApps,
        fetchedAt: entry.fetchedAt,
        ageMs,
        cached: true,
        chainId,
        registryAddress,
      }
    }
  }

  const resolved = resolveRegistry()
  if (resolved.outcome) return resolved.outcome

  let allApps
  try {
    allApps = Object.freeze(await readAllRecords(resolved.contract))
  } catch (error) {
    return unreachable({
      chainId,
      registryAddress,
      reason: error?.code === UNREACHABLE_REASON.BAD_RESPONSE ? UNREACHABLE_REASON.BAD_RESPONSE : UNREACHABLE_REASON.READ_FAILED,
      error,
    })
  }

  const apps = Object.freeze(allApps.filter((app) => app.launchable))
  const fetchedAt = Date.now()
  catalogCache.set(chainId, { registryAddress, fetchedAt, apps, allApps })

  return { status: REGISTRY_STATUS.OK, apps, allApps, fetchedAt, ageMs: 0, cached: false, chainId, registryAddress }
}

/**
 * Read ONE record, always from the chain (FR-010).
 *
 * This is the launch read. It never consults — and never populates — the catalog memo, because the
 * whole point of re-reading at launch is to catch the change the memo would hide: a curator
 * suspending a compromised app while a member has the catalog open. A cache "hit" here would defeat
 * the requirement rather than optimise it, so there is no option to opt into one.
 *
 * A record the registry does not hold reverts `AppNotFound()`, which is a definite answer and comes
 * back as `not-found`. An undecodable failure does NOT: not knowing whether an app exists is an
 * outage, and rendering it as "no such app" would blame the member's link for our own downtime.
 *
 * `id` comes from a route parameter, so a malformed one is untrusted input rather than a caller bug:
 * it resolves to `not-found` (a 404 surface) instead of throwing.
 *
 * @param {number|string|bigint} id registry id (allocated from 1)
 * @returns {Promise<{status:'ok', app: object, fetchedAt: number, chainId: number, registryAddress: string} | {status:'not-found', id: *, chainId: number, registryAddress: string} | {status:'not-deployed'} | {status:'unreachable'}>}
 */
export async function fetchApp(id) {
  const resolved = resolveRegistry()
  if (resolved.outcome) return resolved.outcome
  const { chainId, registryAddress, contract } = resolved

  const numericId = Number(id)
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return { status: REGISTRY_STATUS.NOT_FOUND, id, chainId, registryAddress }
  }

  try {
    const raw = await contract.getApp(numericId)
    return {
      status: REGISTRY_STATUS.OK,
      app: normalizeApp(raw),
      fetchedAt: Date.now(),
      chainId,
      registryAddress,
    }
  } catch (error) {
    if (isAppNotFound(error)) return { status: REGISTRY_STATUS.NOT_FOUND, id, chainId, registryAddress }
    return unreachable({ chainId, registryAddress, reason: UNREACHABLE_REASON.READ_FAILED, error })
  }
}

/**
 * Whether a failed call was the registry saying "no such app" rather than the network saying nothing.
 *
 * This is the file's sharpest honest-state line, and it is decided by the shape of a decoded
 * revert — which is library-specific, so all the shapes are read rather than one. viem raises a
 * `ContractFunctionRevertedError` somewhere in the `cause` chain carrying `data.errorName`;
 * ethers (still the shape some callers hand us, and what the fixtures assert) lifts it onto
 * `error.revert.name`, with older/wrapped forms using `errorName`. Anything else — missing revert
 * data, a transport error, undecodable bytes — is NOT a not-found: it is an unread record.
 *
 * Getting this wrong in the permissive direction is the dangerous one: an RPC failure reported as
 * "no such app" tells a member the platform has no such package when it may simply be unreachable.
 */
function isAppNotFound(error) {
  if ((error?.revert?.name || error?.errorName) === 'AppNotFound') return true
  // viem nests the decoded revert; walk the cause chain rather than guessing its depth.
  for (let e = error, hops = 0; e && hops < 8; e = e.cause, hops += 1) {
    if (e?.data?.errorName === 'AppNotFound') return true
  }
  return false
}

/**
 * Resolve a display name to its registry id, or `not-found`.
 *
 * The chain answers `0` for an unclaimed name, and ids start at 1 exactly so that zero can mean
 * "no such name" without ambiguity — so zero is translated here into an explicit outcome instead of
 * being handed back as a falsy id for callers to re-interpret.
 *
 * The name is passed through verbatim: the registry case-folds ASCII itself when computing its name
 * key, and folding again on this side would be a second, drifting definition of name equality.
 *
 * Primary use is the duplicate-name pre-check on the vendor submission form (FR-006/FR-021) — cheaper
 * and kinder than letting the submission revert.
 */
export async function fetchAppByName(name) {
  const resolved = resolveRegistry()
  if (resolved.outcome) return resolved.outcome
  const { chainId, registryAddress, contract } = resolved

  if (typeof name !== 'string' || name.length === 0) {
    return { status: REGISTRY_STATUS.NOT_FOUND, name, chainId, registryAddress }
  }

  let id
  try {
    id = Number(await contract.idByName(name))
  } catch (error) {
    return unreachable({ chainId, registryAddress, reason: UNREACHABLE_REASON.READ_FAILED, error })
  }
  if (!Number.isInteger(id) || id <= 0) return { status: REGISTRY_STATUS.NOT_FOUND, name, chainId, registryAddress }
  return fetchApp(id)
}

// =============================================================================
// App identity: slug (the URL + manifest binding) and namespace key (storage +
// audit attribution). Two DIFFERENT identities on purpose — see below.
// =============================================================================

/**
 * The registry's own name normalization, mirrored exactly
 * (`MiniAppRegistry._nameKey`): ASCII `A`-`Z` folded to lower case, runs of
 * `0x20` spaces collapsed to one, leading/trailing spaces dropped.
 *
 * This function is a TWIN of Solidity, not an approximation, and the two must
 * change together. If this folded more than the contract does, two names the
 * chain treats as distinct listings would collapse to one slug here and a member
 * clicking a link could reach the wrong vendor's app. If it folded less, a
 * legitimate listing would simply be unreachable by URL. So: no `toLowerCase()`
 * (it case-folds Unicode, which the contract deliberately does not), no `trim()`
 * (it strips tabs and newlines, which the contract rejects outright rather than
 * ignores), and bytes >= 0x80 pass through untouched exactly as they do on-chain.
 *
 * That last point is what makes "twin" literally true across the UTF-8/UTF-16
 * boundary: the contract folds BYTES, this folds code units, and the two agree
 * because every byte of a multi-byte UTF-8 sequence is >= 0x80 — so no non-ASCII
 * character can contain the `0x20` or `0x41`–`0x5A` bytes either side acts on.
 *
 * @param {unknown} name
 * @returns {string} the folded name, or `''` for anything unusable
 */
function foldRegistryName(name) {
  if (typeof name !== 'string') return ''
  let out = ''
  let pendingSpace = false
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i)
    if (code === 0x20) {
      // Never leading (nothing emitted yet), and a run yields at most one space.
      if (out.length > 0) pendingSpace = true
      continue
    }
    if (pendingSpace) {
      out += ' '
      pendingSpace = false
    }
    // Iterating by UTF-16 code unit re-emits surrogate halves in order, so
    // non-ASCII names survive this loop unchanged rather than being mangled.
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : name[i]
  }
  // A trailing run dies with `pendingSpace`, exactly as the contract discards it.
  return out
}

/**
 * The on-chain names a slug could have come from, in resolution order.
 *
 * The slug renders the folded name's spaces as hyphens, and that rendering is
 * not injective: `"Token Mint"` and `"Token-Mint"` are two distinct listings
 * on-chain (two different `_nameKey`s) that both render as `token-mint`. Rather
 * than pretend otherwise, both candidates are tried — the space form first,
 * because a registry name is a DISPLAY name and display names carry spaces.
 *
 * The consequence is stated plainly because it is real: when both listings
 * exist, the space form owns the URL. That is a collision in the URL space
 * only — it is not a collision in identity. Identity is the numeric registry id
 * (see {@link appNamespaceKey}), the launch still verifies the package against
 * the hash on THAT record, and the manifest-id binding still has to agree. A
 * lookalike name that reaches a member is a curation question, which is where
 * the contract's own comment says that judgement belongs.
 */
function slugNameCandidates(slug) {
  // EXACTLY ONE candidate, on purpose. A slug's hyphens are always encoded spaces, because
  // `appSlug` refuses any name whose folded form already contains a hyphen — that refusal is what
  // makes the slug space injective. Also probing the literal hyphen spelling would undo it: with
  // both `Token Mint` and `Token-Mint` registered, one URL would resolve to whichever candidate was
  // tried first, and the loser's catalog card would launch the winner's package.
  return [slug.replace(/-/g, ' ')]
}

/**
 * The URL/manifest slug for a registry display name, or `null` when the name
 * cannot produce one.
 *
 * WHY THIS EXISTS. `loader.js` refuses a package whose `manifest.id` is not the
 * app being launched — but a registry record carries no id field, so until the
 * host could NAME the app it was launching, that check had nothing to compare
 * against and was inert. The registry `name` is the one identifier the chain
 * already guarantees is unique (the duplicate-name guard runs on exactly the
 * normalization mirrored above), so the slug derived from it is what binds a
 * listing to the package bytes that claim to be it.
 *
 * The slug is STRICT, and deliberately so. A name is slugged, never sanitized:
 * a name that does not fold to something matching {@link APP_ID_PATTERN} gets
 * `null`, not a lossy best effort. Stripping characters to force a slug would
 * map `"Token Mint!"` and `"Token Mint"` — two separate listings on-chain — onto
 * one slug, one URL, one store namespace and one audit attribution, which is the
 * exact confusion this binding exists to prevent. Names with no slug are
 * therefore not launchable by URL, and the workspace says so specifically.
 *
 * Consequences a vendor should know about, all of them properties of
 * {@link APP_ID_PATTERN} (which is also what a `manifest.id` must satisfy):
 * a name must start with an ASCII letter, be 2–31 characters after folding, and
 * contain only letters, digits and single spaces (or hyphens). `"2Fast"`, `"A"`
 * and any non-ASCII name have no slug.
 *
 * @param {unknown} name - the registry record's `name`
 * @returns {string|null} the slug, or null when the name cannot be one
 */
export function appSlug(name) {
  const folded = foldRegistryName(name)
  if (folded === '') return null

  // INJECTIVE OR NOTHING. The slug encoding is "space becomes hyphen", so a folded name that
  // ALREADY contains a hyphen would produce a slug indistinguishable from the space-spelled name:
  // the contract treats `Token Mint` and `Token-Mint` as two DIFFERENT listings (proven against a
  // live registry in test/miniapps/slugFolding.test.js), yet both render `token-mint`. Emitting
  // that slug would make one launch URL mean two different vendors' packages, and whichever the
  // resolver happened to try first would win — a member clicking one catalog card could launch the
  // other app entirely. That is a supply-chain failure dressed as a routing bug, so a hyphen in the
  // folded name costs the listing its URL rather than costing someone the wrong package.
  //
  // The cost is real and bounded: such a listing is still catalogued, but it cannot be launched by
  // slug, and CatalogPanel says so instead of rendering a link. If hyphenated names ever become
  // common the fix is an unambiguous reference (e.g. `/apps/<id>-<slug>`, resolving on the id and
  // treating the slug as decoration), NOT a cleverer encoding here.
  if (folded.includes('-')) return null

  const slug = folded.replace(/ /g, '-')
  if (!APP_ID_PATTERN.test(slug)) return null

  // ROUND-TRIP OR NOTHING. A slug this client could not resolve back to this exact name is worse
  // than no slug: it would render a working link in the catalog that lands on "no such app".
  if (!slugNameCandidates(slug).some((candidate) => foldRegistryName(candidate) === folded)) return null

  return slug
}

/**
 * The per-app namespace key: the identity used for the mini-app's private store
 * (FR-018) and for its audit attribution (FR-019).
 *
 * THIS IS NOT THE SLUG, AND THAT IS THE WHOLE POINT. A slug is derived from the
 * registry NAME, and a name is neither immutable nor globally unique:
 *
 *  - a vendor can rename a listing (`updateMetadata`), and a rename must not
 *    orphan the member's saved state or split one app's audit trail in two;
 *  - the same name is registrable on every chain the registry is deployed to,
 *    so a name-keyed namespace would let a Mordor listing read and overwrite the
 *    state of the Polygon listing that happens to share its name — and the
 *    backup this store rides on (`miniAppState`) is deliberately NOT
 *    network-scoped, so nothing downstream would separate them either;
 *  - a slug is what a PACKAGE claims about itself in `manifest.id`, and while
 *    the launch binding now forces that claim to match the record, keying
 *    storage on the immutable side of the check means a bug in the check can
 *    never become a cross-app data leak.
 *
 * The numeric registry id is allocated by the contract, never reused and never
 * editable by anyone; pairing it with the registry chain id makes it unique
 * across every network this build can read. `app-<chainId>-<registryId>` is the
 * result, shaped to satisfy {@link APP_ID_PATTERN} because `createAppStore`
 * refuses any id it cannot guarantee isolation for — a leading letter is
 * required, so the numeric key carries the `app-` prefix rather than starting
 * with a digit.
 *
 * @param {number} chainId - the registry chain the record was read from
 * @param {number} registryId - the record's on-chain `id` (allocated from 1)
 * @returns {string|null} the namespace key, or null when either input is not a
 *   positive integer (a caller with no record has no namespace to open)
 */
export function appNamespaceKey(chainId, registryId) {
  const chain = Number(chainId)
  const id = Number(registryId)
  if (!Number.isInteger(chain) || chain <= 0) return null
  if (!Number.isInteger(id) || id <= 0) return null
  const key = `app-${chain}-${id}`
  // Structurally unreachable for real ids (a 10-digit chain and a 10-digit id
  // still fit), and checked anyway: handing `createAppStore` a key it refuses
  // would surface as a crashed workspace rather than an honest refusal.
  return APP_ID_PATTERN.test(key) ? key : null
}

/**
 * Resolve a URL slug to its record — the launch read behind `/apps/:slug`.
 *
 * Goes through {@link fetchApp}, so this IS an FR-010 launch read: it never
 * consults the catalog memo, and the record it returns is the record the caller
 * is about to run.
 *
 * Two properties matter beyond the plumbing:
 *
 * 1. **The slug is normalized before it reaches the chain.** A member's link may
 *    carry any casing (`/apps/Token-Mint`), and the registry's `idByName`
 *    applies the contract's own folding — so the string handed over must already
 *    be the shape that folding expects.
 * 2. **The record is verified to answer to the slug that asked for it.** After
 *    resolving, `appSlug(record.name)` must equal the requested slug. This
 *    client and the contract normalize independently; if they ever disagreed,
 *    the honest outcome is "no such app", never "here is a different app than
 *    the URL named". A record that fails this check is skipped, not returned.
 *
 * @param {string} slug - the URL segment
 * @returns {Promise<
 *   {status:'ok', app: object, slug: string, fetchedAt: number, chainId: number, registryAddress: string} |
 *   {status:'not-found', slug: *, chainId: number, registryAddress: string} |
 *   {status:'not-deployed'} | {status:'unreachable'}
 * >}
 */
export async function fetchAppBySlug(slug) {
  const resolved = resolveRegistry()
  if (resolved.outcome) return resolved.outcome
  const { chainId, registryAddress, contract } = resolved

  const normalized = foldRegistryName(slug)
  // A malformed slug is untrusted input from a route parameter, exactly like a
  // malformed id in `fetchApp`: a 404 surface, not a thrown caller bug.
  if (!APP_ID_PATTERN.test(normalized)) {
    return { status: REGISTRY_STATUS.NOT_FOUND, slug, chainId, registryAddress }
  }

  for (const candidate of slugNameCandidates(normalized)) {
    let id
    try {
      id = Number(await contract.idByName(candidate))
    } catch (error) {
      // Not knowing whether a name is claimed is an outage, never a free "no".
      return unreachable({ chainId, registryAddress, reason: UNREACHABLE_REASON.READ_FAILED, error })
    }
    // Ids are allocated from 1 precisely so zero can mean "unclaimed" — try the
    // next spelling rather than reporting a definite absence we have not proven.
    if (!Number.isInteger(id) || id <= 0) continue

    const outcome = await fetchApp(id)
    if (outcome.status !== REGISTRY_STATUS.OK) return outcome
    if (appSlug(outcome.app.name) !== normalized) continue
    return { ...outcome, slug: normalized }
  }

  return { status: REGISTRY_STATUS.NOT_FOUND, slug, chainId, registryAddress }
}

/**
 * Assert a vendor argument is an address.
 *
 * Throws rather than returning an outcome, and the asymmetry with `fetchApp` is deliberate: a vendor
 * address comes from the connected wallet or an admin form the app controls, so a malformed one is a
 * bug in our code, not a member typing a bad URL. Returning `{ ids: [] }` for it would present "this
 * vendor has submitted nothing" — the same lie rule 1 exists to prevent.
 */
function assertVendorAddress(vendor, fnName) {
  if (typeof vendor !== 'string' || !ADDRESS_RE.test(vendor)) {
    throw new Error(`${fnName}: vendor must be a 0x address, received ${JSON.stringify(vendor)}`)
  }
}

/**
 * The registry ids a vendor has ever submitted, newest last (the contract appends on submission).
 *
 * An empty `ids` array here IS meaningful — the registry answered and this address has submitted
 * nothing — which is exactly why the failure cases are separate outcomes rather than the same
 * empty array.
 *
 * @returns {Promise<{status:'ok', ids: number[], chainId: number, registryAddress: string} | {status:'not-deployed'} | {status:'unreachable'}>}
 */
export async function appIdsByVendor(vendor) {
  assertVendorAddress(vendor, 'appIdsByVendor')
  const resolved = resolveRegistry()
  if (resolved.outcome) return resolved.outcome
  const { chainId, registryAddress, contract } = resolved

  try {
    const raw = await contract.appIdsByVendor(vendor)
    const ids = Array.from(raw ?? [], (value) => Number(value))
    return { status: REGISTRY_STATUS.OK, ids, chainId, registryAddress }
  } catch (error) {
    return unreachable({ chainId, registryAddress, reason: UNREACHABLE_REASON.READ_FAILED, error })
  }
}

/**
 * A vendor's own submissions with their full lifecycle state (FR-023).
 *
 * Reads the vendor index and then each record directly, rather than filtering the catalog: the
 * catalog memo can be a minute old and the vendor's most likely reason for opening this list is that
 * they just submitted something. It also carries every status by construction — a vendor's Pending
 * and Suspended listings are the ones they most need to see, and those are exactly what the catalog
 * omits.
 *
 * A single unreadable record fails the whole list. A vendor shown four of their five submissions
 * would reasonably conclude the fifth was never recorded (FR-021), which is worse than being told
 * the registry could not be read.
 *
 * @returns {Promise<{status:'ok', apps: object[], fetchedAt: number, chainId: number, registryAddress: string} | {status:'not-deployed'} | {status:'unreachable'}>}
 */
export async function fetchVendorApps(vendor) {
  const idsOutcome = await appIdsByVendor(vendor)
  if (idsOutcome.status !== REGISTRY_STATUS.OK) return idsOutcome
  const { chainId, registryAddress, ids } = idsOutcome

  const resolved = resolveRegistry()
  if (resolved.outcome) return resolved.outcome

  try {
    const raws = await Promise.all(ids.map((id) => resolved.contract.getApp(id)))
    return {
      status: REGISTRY_STATUS.OK,
      apps: raws.map((raw) => normalizeApp(raw)),
      fetchedAt: Date.now(),
      chainId,
      registryAddress,
    }
  } catch (error) {
    // A vendor's own index cannot legitimately point at a missing record, so even `AppNotFound` here
    // means the read is not to be trusted — never that the submission is gone.
    return unreachable({ chainId, registryAddress, reason: UNREACHABLE_REASON.READ_FAILED, error })
  }
}
