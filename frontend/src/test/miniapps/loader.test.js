/**
 * Mini-app loader (spec 073, T018 · research R1/R3, FR-011/FR-012).
 *
 * The loader decides what executes, so the assertion that matters in every
 * refusal case below is the same one: **`importImpl` was never called, and no
 * Blob URL was ever minted**. A test that only checked the thrown error would
 * pass just as happily against a loader that imported first and complained
 * afterwards. `expect(importImpl).not.toHaveBeenCalled()` IS the security
 * property; the error type is only how the refusal is explained.
 *
 * Everything is driven through injected `fetchImpl` / `importImpl` /
 * object-URL functions, so the whole chain runs with no network and no browser
 * module loader — and each case can state precisely which byte it corrupted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { keccak256 } from 'ethers'

import { AppStatus } from '../../abis/miniAppRegistry'
import { IntegrityError as IntegrityErrorSource, sha256Hex } from '../../lib/miniapps/integrity'
import {
  HostApiError as HostApiErrorSource,
  MANIFEST_REFUSAL,
  MANIFEST_SCHEMA,
  ManifestError as ManifestErrorSource,
  SUPPORTED_HOST_API,
} from '../../lib/miniapps/manifest'
import {
  AppNotLaunchableError,
  GatewayUnavailableError,
  HostApiError,
  IntegrityError,
  LoadCancelledError,
  MANIFEST_FILENAME,
  ManifestError,
  loadMiniApp,
  normalizeGateways,
  resolveMiniAppGateways,
} from '../../lib/miniapps/loader'

// `Uint8Array.from(...)` re-homes the bytes into this module's realm. jsdom's
// TextEncoder returns a view from the jsdom realm, which ethers' own
// `instanceof Uint8Array` check rejects — a test-environment artifact (in a
// browser both are native and same-realm) that would otherwise break the
// fixture builder for a reason unrelated to what is under test.
const utf8 = (text) => Uint8Array.from(new TextEncoder().encode(text))

const G1 = 'https://g1.example'
const G2 = 'https://g2.example'
const GATEWAYS = [G1, G2]
const CID = 'bafybeigdyrztfairwinsminiapppackagecidexampleaaaaaaaaaaaaaaaaaaaa'
const APP_ID = 'token-mint'

const ENTRY_SOURCE = 'export default function TokenMint() { return null }\n'
const STYLE_SOURCE = '.token-mint { color: rebeccapurple }\n'

/**
 * Build a package exactly as `tools/miniapp-build/` would: entry + optional
 * stylesheet, a manifest listing their sha-256 digests, and the keccak256 of
 * the manifest bytes that the registry would hold as `approved.manifestHash`.
 */
function buildPackage({ entry = ENTRY_SOURCE, style = STYLE_SOURCE, overrides = {} } = {}) {
  const entryBytes = utf8(entry)
  const styleBytes = style === null ? null : utf8(style)

  const files = { 'entry.js': { sha256: sha256Hex(entryBytes) } }
  if (styleBytes) files['style.css'] = { sha256: sha256Hex(styleBytes) }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    id: APP_ID,
    name: 'Token Mint',
    version: '3.1.0',
    entry: 'entry.js',
    styles: styleBytes ? ['style.css'] : [],
    hostApi: SUPPORTED_HOST_API,
    sharedDeps: ['react', 'react/jsx-runtime'],
    permissions: ['wallet:submit', 'toast'],
    storeKeys: ['drafts'],
    files,
    ...overrides,
  }

  const manifestBytes = utf8(`${JSON.stringify(manifest, null, 2)}\n`)
  return {
    manifest,
    manifestBytes,
    manifestHash: keccak256(manifestBytes),
    entryBytes,
    styleBytes,
    /** What a gateway would serve for this package. */
    files: {
      [MANIFEST_FILENAME]: manifestBytes,
      'entry.js': entryBytes,
      ...(styleBytes ? { 'style.css': styleBytes } : {}),
    },
  }
}

/** A registry record carrying ONLY an approved tuple, as the launch path receives it. */
function approvedRecord(pkg, overrides = {}) {
  return {
    id: 1n,
    appId: APP_ID,
    name: 'Token Mint',
    status: AppStatus.APPROVED,
    approved: { cid: CID, manifestHash: pkg.manifestHash, version: 3n },
    proposed: { cid: '', manifestHash: `0x${'0'.repeat(64)}`, version: 0n },
    ...overrides,
  }
}

const okResponse = (bytes, { contentLength } = {}) => ({
  ok: true,
  status: 200,
  headers: {
    get: (name) =>
      name.toLowerCase() === 'content-length'
        ? String(contentLength ?? bytes.byteLength)
        : null,
  },
  arrayBuffer: async () => bytes.slice().buffer,
})

const errorResponse = (status) => ({
  ok: false,
  status,
  headers: { get: () => null },
  arrayBuffer: async () => new ArrayBuffer(0),
})

/**
 * A fake gateway fleet.
 *
 * `tables` maps a gateway base to `{ [path]: Uint8Array | number (http status) |
 * 'network' | {bytes, contentLength} }`. A gateway with no table at all behaves
 * like an unreachable host.
 */
function makeFetch(tables, { cid = CID } = {}) {
  return vi.fn(async (url, init) => {
    if (init?.signal?.aborted) {
      const aborted = new Error('aborted')
      aborted.name = 'AbortError'
      throw aborted
    }

    const marker = `/ipfs/${cid}/`
    const at = url.indexOf(marker)
    if (at === -1) throw new TypeError(`fake gateway: unexpected URL ${url}`)
    const gateway = url.slice(0, at)
    const path = decodeURIComponent(url.slice(at + marker.length))

    const table = tables[gateway]
    if (!table) throw new TypeError('Failed to fetch')

    const served = table[path]
    if (served === undefined) return errorResponse(404)
    if (served === 'network') throw new TypeError('Failed to fetch')
    if (typeof served === 'number') return errorResponse(served)
    if (served instanceof Uint8Array) return okResponse(served)
    return okResponse(served.bytes, { contentLength: served.contentLength })
  })
}

/** Injected loader plumbing, with the two spies every refusal case asserts on. */
function makeHarness() {
  const importImpl = vi.fn(async () => ({ default: () => null }))
  const createObjectURL = vi.fn(() => 'blob:fairwins/miniapp-1')
  const revokeObjectURL = vi.fn()
  return { importImpl, createObjectURL, revokeObjectURL }
}

/**
 * Assert a refusal: the expected typed error AND — the point of the whole
 * suite — that not a single package byte was made executable.
 */
async function expectRefusal(promise, { name, reason, harness }) {
  let caught
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught, `expected a ${name} refusal`).toBeDefined()
  expect(caught.name).toBe(name)
  if (reason) expect(caught.reason).toBe(reason)
  expect(typeof caught.userMessage).toBe('string')
  expect(caught.userMessage.length).toBeGreaterThan(0)

  expect(harness.importImpl, 'the package must never be imported on a refusal').not.toHaveBeenCalled()
  expect(harness.createObjectURL, 'no Blob URL may be minted on a refusal').not.toHaveBeenCalled()
  return caught
}

/**
 * The bytes actually inside a Blob. jsdom's Blob implements neither
 * `arrayBuffer()` nor `text()`, so `FileReader` is the only way to read one back
 * — and reading it back is the point: `blob.size` would pass just as happily for
 * a same-length substitution.
 */
const readBlobBytes = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })

/** Flip one byte. */
const tamper = (bytes, index = 0) => {
  const copy = new Uint8Array(bytes)
  copy[index] = copy[index] ^ 0x01
  return copy
}

let harness
beforeEach(() => {
  harness = makeHarness()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the happy path', () => {
  it('fetches, verifies and imports a package, then revokes the object URL', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: pkg.files })

    const result = await loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness })

    expect(result.manifest.id).toBe(APP_ID)
    expect(result.component).toBe(result.module.default)
    expect(result.styles).toEqual([{ path: 'style.css', css: STYLE_SOURCE }])
    expect(result.gateway).toBe(G1)
    expect(result.cid).toBe(CID)
    expect(result.manifestHash).toBe(pkg.manifestHash.toLowerCase())

    // The imported URL is the one minted from the VERIFIED bytes, and it does
    // not outlive the import (research R1).
    const [blob] = harness.createObjectURL.mock.calls[0]
    expect(blob.type).toBe('text/javascript')
    expect(blob.size).toBe(pkg.entryBytes.byteLength)
    // Byte-for-byte, not just the right length: the whole integrity chain is
    // worth nothing if what gets imported is a re-encoded, re-fetched or
    // otherwise different copy of what was hashed.
    expect(Array.from(await readBlobBytes(blob))).toEqual(Array.from(pkg.entryBytes))
    expect(harness.importImpl).toHaveBeenCalledWith('blob:fairwins/miniapp-1')
    expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:fairwins/miniapp-1')
  })

  it('requests the manifest before anything else, and only declared files', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: pkg.files })
    await loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness })

    const paths = fetchImpl.mock.calls.map(([url]) => url.split(`/ipfs/${CID}/`)[1])
    expect(paths).toEqual([MANIFEST_FILENAME, 'entry.js', 'style.css'])
  })

  it('loads a package with no stylesheet', async () => {
    const pkg = buildPackage({ style: null })
    const fetchImpl = makeFetch({ [G1]: pkg.files })
    const result = await loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness })
    expect(result.styles).toEqual([])
  })
})

describe('integrity refusals — nothing executes', () => {
  it('REFUSES tampered entry bytes', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({
      [G1]: { ...pkg.files, 'entry.js': tamper(pkg.entryBytes, 7) },
    })

    const error = await expectRefusal(
      loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness }),
      { name: 'IntegrityError', reason: 'file_hash_mismatch', harness }
    )
    expect(error.path).toBe('entry.js')
    expect(error.expected).toBe(sha256Hex(pkg.entryBytes))
  })

  it('REFUSES tampered manifest bytes before the entry is even requested', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({
      [G1]: { ...pkg.files, [MANIFEST_FILENAME]: tamper(pkg.manifestBytes, 12) },
    })

    await expectRefusal(loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness }), {
      name: 'IntegrityError',
      reason: 'manifest_hash_mismatch',
      harness,
    })
    // Nothing downstream of the anchor ran: the manifest was never parsed, so
    // the entry it names was never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toContain(MANIFEST_FILENAME)
  })

  it('REFUSES tampered stylesheet bytes', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: { ...pkg.files, 'style.css': utf8('.evil{}') } })

    await expectRefusal(loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness }), {
      name: 'IntegrityError',
      reason: 'file_hash_mismatch',
      harness,
    })
  })

  it('does NOT fail over on a hash mismatch — tampering must surface, not be routed around', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({
      [G1]: { ...pkg.files, [MANIFEST_FILENAME]: tamper(pkg.manifestBytes) },
      [G2]: pkg.files, // an honest fallback that must never be consulted
    })

    await expectRefusal(loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness }), {
      name: 'IntegrityError',
      reason: 'manifest_hash_mismatch',
      harness,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0].startsWith(`${G1}/`)).toBe(true)
  })

  it('REFUSES a record whose on-chain hash does not describe the package at all', async () => {
    const pkg = buildPackage()
    const other = buildPackage({ entry: 'export default () => null\n' })
    const fetchImpl = makeFetch({ [G1]: pkg.files })

    await expectRefusal(
      loadMiniApp(approvedRecord(pkg, { approved: { cid: CID, manifestHash: other.manifestHash, version: 3n } }), {
        gateways: GATEWAYS,
        fetchImpl,
        ...harness,
      }),
      { name: 'IntegrityError', reason: 'manifest_hash_mismatch', harness }
    )
  })
})

describe('manifest refusals — nothing executes', () => {
  it('REFUSES a hostApi newer than this host supports', async () => {
    const pkg = buildPackage({ overrides: { hostApi: SUPPORTED_HOST_API + 1 } })
    const fetchImpl = makeFetch({ [G1]: pkg.files })

    const error = await expectRefusal(
      loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness }),
      { name: 'HostApiError', reason: MANIFEST_REFUSAL.HOST_API_TOO_NEW, harness }
    )
    expect(error.required).toBe(SUPPORTED_HOST_API + 1)
    expect(error.supported).toBe(SUPPORTED_HOST_API)
    // The manifest was authentic — it is the host that is behind — so only the
    // anchor was fetched and nothing was executed.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('REFUSES an unknown manifest schema', async () => {
    const pkg = buildPackage({ overrides: { schema: 'fairwins-miniapp-manifest/2' } })
    const fetchImpl = makeFetch({ [G1]: pkg.files })
    await expectRefusal(loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness }), {
      name: 'ManifestError',
      reason: MANIFEST_REFUSAL.UNKNOWN_SCHEMA,
      harness,
    })
  })

  it('REFUSES a manifest whose files map omits the entry', async () => {
    const pkg = buildPackage()
    const withoutEntryDigest = buildPackage({
      overrides: { files: { 'style.css': { sha256: sha256Hex(pkg.styleBytes) } } },
    })
    const fetchImpl = makeFetch({ [G1]: withoutEntryDigest.files })

    await expectRefusal(
      loadMiniApp(approvedRecord(withoutEntryDigest), { gateways: GATEWAYS, fetchImpl, ...harness }),
      { name: 'ManifestError', reason: MANIFEST_REFUSAL.ENTRY_NOT_LISTED, harness }
    )
    // The unverifiable entry was never requested — the host does not fetch
    // bytes it has no digest for.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('REFUSES a path that escapes the package, without ever requesting it', async () => {
    const escaped = buildPackage({
      overrides: {
        entry: '../../../host/main.js',
        styles: [],
        files: { '../../../host/main.js': { sha256: sha256Hex(utf8(ENTRY_SOURCE)) } },
      },
    })
    const fetchImpl = makeFetch({ [G1]: escaped.files })

    await expectRefusal(
      loadMiniApp(approvedRecord(escaped), { gateways: GATEWAYS, fetchImpl, ...harness }),
      { name: 'ManifestError', reason: MANIFEST_REFUSAL.UNSAFE_PATH, harness }
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls.some(([url]) => url.includes('..'))).toBe(false)
  })

  it('REFUSES an absolute URL smuggled in as the entry path', async () => {
    const smuggled = buildPackage({
      overrides: {
        entry: 'https://evil.example/payload.js',
        styles: [],
        files: { 'https://evil.example/payload.js': { sha256: sha256Hex(utf8(ENTRY_SOURCE)) } },
      },
    })
    const fetchImpl = makeFetch({ [G1]: smuggled.files })

    await expectRefusal(
      loadMiniApp(approvedRecord(smuggled), { gateways: GATEWAYS, fetchImpl, ...harness }),
      { name: 'ManifestError', reason: MANIFEST_REFUSAL.UNSAFE_PATH, harness }
    )
    expect(fetchImpl.mock.calls.some(([url]) => url.includes('evil.example'))).toBe(false)
  })

  it('REFUSES a package that claims a different app id than the one being launched', async () => {
    // The app id is the namespace root for the per-app store; a package
    // answering to another id would read and write that app's data.
    const impostor = buildPackage({ overrides: { id: 'clearpath' } })
    const fetchImpl = makeFetch({ [G1]: impostor.files })

    await expectRefusal(
      loadMiniApp(approvedRecord(impostor, { appId: APP_ID }), { gateways: GATEWAYS, fetchImpl, ...harness }),
      { name: 'ManifestError', reason: MANIFEST_REFUSAL.IDENTITY_MISMATCH, harness }
    )
  })
})

describe('gateway failover (FR-012)', () => {
  it('fails over to the next gateway when the first returns 500', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({
      [G1]: { [MANIFEST_FILENAME]: 500, 'entry.js': 500, 'style.css': 500 },
      [G2]: pkg.files,
    })

    const result = await loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness })

    expect(result.gateway).toBe(G2)
    expect(harness.importImpl).toHaveBeenCalledTimes(1)
    // Gateway 1 was tried for the manifest before the fallback was used.
    expect(fetchImpl.mock.calls[0][0].startsWith(`${G1}/`)).toBe(true)
    expect(fetchImpl.mock.calls[1][0].startsWith(`${G2}/`)).toBe(true)
  })

  it('fails over on a transport error and on a 404', async () => {
    const pkg = buildPackage()
    for (const failure of ['network', 404]) {
      harness = makeHarness()
      const fetchImpl = makeFetch({ [G1]: { [MANIFEST_FILENAME]: failure }, [G2]: pkg.files })
      const result = await loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness })
      expect(result.gateway).toBe(G2)
    }
  })

  it('fails over when a gateway declares an oversize body', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({
      [G1]: { [MANIFEST_FILENAME]: { bytes: pkg.manifestBytes, contentLength: 900_000_000 } },
      [G2]: pkg.files,
    })
    const result = await loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness })
    expect(result.gateway).toBe(G2)
  })

  it('prefers the gateway that served the verified manifest for the rest of the package', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: { [MANIFEST_FILENAME]: 503 }, [G2]: pkg.files })
    await loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness })

    const entryCall = fetchImpl.mock.calls.find(([url]) => url.endsWith('entry.js'))
    expect(entryCall[0].startsWith(`${G2}/`)).toBe(true)
  })

  it('REFUSES with GatewayUnavailableError when every gateway is down', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({}) // no gateway answers at all

    const error = await expectRefusal(
      loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness }),
      { name: 'GatewayUnavailableError', reason: 'all_gateways_failed', harness }
    )
    expect(error.attempts.map((a) => a.gateway)).toEqual([G1, G2])
    expect(error.path).toBe(MANIFEST_FILENAME)
    expect(error.userMessage).toMatch(/unreachable/i)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('REFUSES honestly when no gateway is configured at all', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: pkg.files })

    const error = await expectRefusal(
      loadMiniApp(approvedRecord(pkg), { gateways: [], fetchImpl, ...harness }),
      { name: 'GatewayUnavailableError', reason: 'no_gateway_configured', harness }
    )
    expect(error.userMessage).toMatch(/no app package gateway is configured/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

})

describe('cancellation is not an availability failure', () => {
  // A cancelled load is the one outcome on this path that is not a problem: the
  // member navigated away, or the workspace unmounted. Reporting it as
  // "every configured gateway is unreachable — check your network" is a lie
  // about the member's connection, told to a surface that no longer exists.
  it('reports a signal aborted before the launch as cancelled, without touching a gateway', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: pkg.files, [G2]: pkg.files })
    const controller = new AbortController()
    controller.abort()

    const error = await expectRefusal(
      loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, signal: controller.signal, ...harness }),
      { name: 'LoadCancelledError', reason: 'cancelled', harness }
    )
    expect(error).toBeInstanceOf(LoadCancelledError)
    expect(error.cancelled).toBe(true)
    expect(error.userMessage).not.toMatch(/unreachable|network|vpn/i)
    // Nothing was asked of a gateway on behalf of a caller that had already gone.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a mid-flight abort as cancelled, and stops instead of burning the fallbacks', async () => {
    const pkg = buildPackage()
    const controller = new AbortController()
    // Healthy gateways throughout: the ONLY thing that goes wrong is the abort,
    // so an availability error here would be blaming the wrong party outright.
    const fetchImpl = vi.fn(async (url, init) => {
      controller.abort()
      return makeFetch({ [G1]: pkg.files, [G2]: pkg.files })(url, init)
    })

    const error = await expectRefusal(
      loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, signal: controller.signal, ...harness }),
      { name: 'LoadCancelledError', reason: 'cancelled', harness }
    )
    expect(error.path).toBe(MANIFEST_FILENAME)
    expect(error.attempts.map((a) => a.reason)).toEqual(['cancelled'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does NOT execute a verified package once the caller has gone', async () => {
    // Everything verified; the member left while it was verifying. Importing now
    // would evaluate third-party code into a workspace that no longer exists.
    const pkg = buildPackage()
    const controller = new AbortController()
    const fetchImpl = vi.fn(async (url, init) => {
      const response = await makeFetch({ [G1]: pkg.files })(url, init)
      if (url.endsWith('style.css')) controller.abort()
      return response
    })

    await expectRefusal(
      loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, signal: controller.signal, ...harness }),
      { name: 'LoadCancelledError', reason: 'cancelled', harness }
    )
  })

  it('still reports a genuine timeout as an availability problem', async () => {
    // The distinction has to cut both ways: a gateway that hangs produces the
    // same AbortError as a caller cancel, and it IS an availability failure.
    const pkg = buildPackage()
    const fetchImpl = vi.fn(async () => {
      const aborted = new Error('timed out')
      aborted.name = 'AbortError'
      throw aborted
    })

    const error = await expectRefusal(
      loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, timeoutMs: 5, ...harness }),
      { name: 'GatewayUnavailableError', reason: 'all_gateways_failed', harness }
    )
    expect(error.attempts.map((a) => a.reason)).toEqual(['timeout', 'timeout'])
  })
})

describe('only the approved tuple is ever served (FR-011)', () => {
  it('REFUSES a record whose status is not Approved, before any fetch', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: pkg.files })

    for (const status of [AppStatus.PENDING, AppStatus.SUSPENDED, AppStatus.DEPRECATED]) {
      harness = makeHarness()
      await expectRefusal(
        loadMiniApp(approvedRecord(pkg, { status }), { gateways: GATEWAYS, fetchImpl, ...harness }),
        { name: 'AppNotLaunchableError', reason: 'not_approved', harness }
      )
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('REFUSES a record that carries no status at all', async () => {
    // A missing status is not a missing OPINION about a status — it is a record
    // nobody has shown to be Approved. Treating "no field" as "fine" would let a
    // hand-assembled or partially-normalized record skip the FR-010/FR-011
    // lifecycle gate entirely, which is the one thing this check exists to stop.
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: pkg.files })

    for (const status of [undefined, null, '', 'approved', NaN]) {
      harness = makeHarness()
      const record = approvedRecord(pkg)
      record.status = status
      await expectRefusal(loadMiniApp(record, { gateways: GATEWAYS, fetchImpl, ...harness }), {
        name: 'AppNotLaunchableError',
        reason: 'not_approved',
        harness,
      })
    }

    // …and with the property genuinely absent, not merely undefined.
    harness = makeHarness()
    const withoutStatus = approvedRecord(pkg)
    delete withoutStatus.status
    await expectRefusal(loadMiniApp(withoutStatus, { gateways: GATEWAYS, fetchImpl, ...harness }), {
      name: 'AppNotLaunchableError',
      reason: 'not_approved',
      harness,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('REFUSES a record with no approved package, even when a proposed one exists', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: pkg.files })
    const neverApproved = {
      appId: APP_ID,
      status: AppStatus.APPROVED,
      approved: { cid: '', manifestHash: `0x${'0'.repeat(64)}`, version: 0n },
      proposed: { cid: CID, manifestHash: pkg.manifestHash, version: 1n },
    }

    await expectRefusal(loadMiniApp(neverApproved, { gateways: GATEWAYS, fetchImpl, ...harness }), {
      name: 'AppNotLaunchableError',
      reason: 'no_approved_package',
      harness,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('never fetches the proposed tuple of an app with a pending update', async () => {
    const approvedPkg = buildPackage()
    const proposedPkg = buildPackage({ entry: 'export default () => "not yet approved"\n' })
    const proposedCid = 'bafyproposedpackagecidexampleaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

    const fetchImpl = makeFetch({ [G1]: approvedPkg.files })
    const record = {
      appId: APP_ID,
      status: AppStatus.APPROVED,
      approved: { cid: CID, manifestHash: approvedPkg.manifestHash, version: 3n },
      proposed: { cid: proposedCid, manifestHash: proposedPkg.manifestHash, version: 4n },
    }

    const result = await loadMiniApp(record, { gateways: GATEWAYS, fetchImpl, ...harness })
    expect(result.cid).toBe(CID)
    expect(fetchImpl.mock.calls.every(([url]) => url.includes(CID))).toBe(true)
    expect(fetchImpl.mock.calls.some(([url]) => url.includes(proposedCid))).toBe(false)
  })

  it('REFUSES a cid that is not a plain content identifier', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: pkg.files })

    for (const cid of ['../../etc/passwd', 'bafy?query=1', 'https://evil.example/pkg', 'bafy/sub']) {
      harness = makeHarness()
      await expectRefusal(
        loadMiniApp(approvedRecord(pkg, { approved: { cid, manifestHash: pkg.manifestHash, version: 1n } }), {
          gateways: GATEWAYS,
          fetchImpl,
          ...harness,
        }),
        { name: 'AppNotLaunchableError', reason: 'invalid_cid', harness }
      )
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('ACCEPTS the locally staged package id that `publish.js --dev` mints', async () => {
    // `scripts/miniapps/publish.js --dev` stages a package under
    // `dev<keccak hex>` so a developer can serve and launch it without pinning.
    // That id has to satisfy this loader's shape allowlist or the entire local
    // development loop refuses to launch with "not a plain content identifier" —
    // a failure that looks like a broken package and is really a broken tool.
    // Tightening CID_PATTERN (or reintroducing a separator in the dev id) breaks
    // this pair, so they are asserted together.
    const pkg = buildPackage()
    const devCid = `dev${pkg.manifestHash.slice(2)}`
    const fetchImpl = makeFetch({ [G1]: pkg.files }, { cid: devCid })

    const result = await loadMiniApp(
      approvedRecord(pkg, { approved: { cid: devCid, manifestHash: pkg.manifestHash, version: 1n } }),
      { gateways: GATEWAYS, fetchImpl, ...harness }
    )
    expect(result.cid).toBe(devCid)
  })
})

describe('post-verification package defects', () => {
  it('reports a package whose entry does not default-export a component', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: pkg.files })
    const importImpl = vi.fn(async () => ({ mount: () => null }))

    let caught
    try {
      await loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness, importImpl })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ManifestError)
    expect(caught.reason).toBe(MANIFEST_REFUSAL.ENTRY_NO_DEFAULT_EXPORT)
    // Integrity held here — these ARE the approved bytes — so the import did
    // run. The refusal is about the contract the package failed to honor.
    expect(importImpl).toHaveBeenCalledTimes(1)
    expect(harness.revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('revokes the object URL even when the package throws while evaluating', async () => {
    const pkg = buildPackage()
    const fetchImpl = makeFetch({ [G1]: pkg.files })
    const boom = new Error('module blew up')
    const importImpl = vi.fn(async () => {
      throw boom
    })

    await expect(
      loadMiniApp(approvedRecord(pkg), { gateways: GATEWAYS, fetchImpl, ...harness, importImpl })
    ).rejects.toBe(boom)
    expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:fairwins/miniapp-1')
  })
})

describe('gateway list resolution', () => {
  it('keeps https bases, strips trailing slashes and collapses duplicates', () => {
    expect(
      normalizeGateways(['https://a.example/', 'https://a.example', ' https://b.example/ipfs-proxy/ '])
    ).toEqual(['https://a.example', 'https://b.example/ipfs-proxy'])
  })

  it('allows plain http only for a loopback dev gateway', () => {
    expect(normalizeGateways(['http://localhost:5173/miniapps'])).toEqual([
      'http://localhost:5173/miniapps',
    ])
    expect(normalizeGateways(['http://127.0.0.1:8080'])).toEqual(['http://127.0.0.1:8080'])
    expect(normalizeGateways(['http://evil.example'])).toEqual([])
  })

  it('drops anything that could turn a package URL into something else', () => {
    expect(
      normalizeGateways([
        'javascript:alert(1)',
        'data:text/html,x',
        'ftp://files.example',
        '/relative/path',
        '',
        null,
        undefined,
        42,
      ])
    ).toEqual([])
  })

  it('puts the configured mini-app gateway ahead of the default IPFS seam', () => {
    vi.stubEnv('VITE_MINIAPP_GATEWAY', 'https://packages.example, https://backup.example')
    const gateways = resolveMiniAppGateways()
    expect(gateways[0]).toBe('https://packages.example')
    expect(gateways[1]).toBe('https://backup.example')
    expect(gateways.length).toBeGreaterThan(2)
  })
})

describe('error identity', () => {
  it('re-exports the same error classes the verification modules throw', () => {
    // A caller that catches `IntegrityError` imported from the loader must
    // catch the instances integrity.js actually throws.
    expect(IntegrityError).toBe(IntegrityErrorSource)
    expect(ManifestError).toBe(ManifestErrorSource)
    expect(HostApiError).toBe(HostApiErrorSource)
    expect(new AppNotLaunchableError('not_approved', 'x')).toBeInstanceOf(Error)
  })
})
