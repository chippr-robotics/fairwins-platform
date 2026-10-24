/**
 * Mini-app manifest parsing + validation (spec 073, data-model.md §2 · FR-017).
 *
 * The manifest is a package's runtime contract AND its integrity anchor: the
 * registry stores `keccak256(manifest.json bytes)`, so these exact bytes are
 * what a curator approved. By the time this module runs, `integrity.js` has
 * already proven the bytes are the approved ones — but "approved" is not
 * "well-formed". A curator approves a hash, not a schema review, so every field
 * this host acts on is validated here before it is allowed to influence what
 * gets fetched or executed.
 *
 * The rules that matter for safety (everything else is shape checking):
 *
 * - **Unknown `schema` ⇒ refuse.** A future manifest revision may mean the
 *   opposite of what this parser assumes. Guessing is how a `permissions` list
 *   silently stops being enforced.
 * - **`hostApi` newer than this host ⇒ refuse** with a version message. The app
 *   was built against a contract this host cannot honor; mounting it anyway
 *   produces a broken surface the member cannot diagnose.
 * - **Paths cannot escape the package.** `entry`, `styles` and every `files` key
 *   are matched against a strict allowlist — no `..`, no absolute path, no
 *   scheme, no backslash. The loader turns these strings into gateway URLs, so
 *   a path that escaped would let a package point the host's fetch (and then
 *   its Blob `import()`) at bytes nobody hashed.
 * - **`entry` must be listed in `files`.** The digest map is the only thing that
 *   authenticates executable bytes; an entry absent from it would be fetched
 *   with nothing to verify it against.
 * - **Declared capabilities must exist.** `permissions` and `sharedDeps` are
 *   checked against what this host actually provides, so a manifest can never
 *   claim a capability the host would silently not enforce or a module the host
 *   cannot supply.
 *
 * Refusals are typed (`ManifestError` / `HostApiError`) and carry a stable
 * `reason` code plus a member-facing `userMessage` — never a bare string, so
 * callers can branch on the cause and the workspace can explain itself.
 *
 * BUILD-SIDE TWIN: `tools/miniapp-build/constants.js` declares the same schema
 * id, host API version, permission set, shared-module list and id/version/
 * store-key patterns for the packaging preset. The two files are a matched pair
 * across the build/host boundary (the preset is Node tooling, not a frontend
 * dependency) and MUST be changed together — a drift makes packages that build
 * cleanly and refuse to launch.
 */

import { normalizeDigestHex } from './integrity'

/** Manifest schema identifier; an unknown value is a launch refusal, not a warning. */
export const MANIFEST_SCHEMA = 'fairwins-miniapp-manifest/1'

/**
 * The highest `manifest.hostApi` this host can honor
 * (`specs/073-miniapp-platform/contracts/host-context.md`). Bumped only when
 * the runtime contract changes; a package declaring more than this is refused.
 */
export const SUPPORTED_HOST_API = 2

/** Capabilities the host context exposes; a manifest may declare any subset. */
export const HOST_PERMISSIONS = Object.freeze([
  'wallet:submit',
  'store',
  'audit',
  'toast',
  'navigate',
  // hostApi 2. Both hand over inert PUBLIC data — deployment addresses and
  // chain descriptors — and neither can move value or read a member's data.
  // They exist because the alternative is worse: a package cannot bundle the
  // host's address book (`config/contracts.js` reaches `virtual:tenant`, a
  // plugin the package preset does not register), and a hand-copied table
  // frozen into immutable bytes turns a routine redeploy into a re-publish,
  // re-review and re-approve for every installed app.
  'contracts',
  'network',
])

/**
 * Contract names a package may be allowed to resolve (`manifest.contracts`).
 *
 * Deliberately a per-package ALLOWLIST rather than open access to the address
 * book. A reviewer approving a package reads one manifest line — "this app can
 * resolve tokenFactory" — instead of diffing a bundled table, and an app that
 * later tries to resolve something it never declared is refused rather than
 * quietly served.
 */
export const CONTRACT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{1,63}$/
export const MAX_DECLARED_CONTRACTS = 16

/** Modules the host owns as singletons and resolves from its shared scope (research R2). */
export const HOST_SHARED_MODULES = Object.freeze([
  'react',
  'react-dom',
  'react/jsx-runtime',
  'ethers',
  // spec 110 Phase 0 (#1591): ADDITIVE — packages migrate off ethers independently, and a
  // package declaring `viem` on a host predating this entry is refused at INSTALL by the
  // sharedDeps ⊆ HOST_SHARED_MODULES check (a loud refusal, so no hostApi bump). Removing
  // `ethers` is the breaking half and ships later as its own hostApi major (Phase 5, #1596).
  'viem',
  '@fairwins/miniapp-sdk',
])

/**
 * App id / registry slug. The same string becomes a URL segment (`/apps/:appId`),
 * a `userStorage` namespace (`miniapp_<appId>_v1`) and a client-ledger entry id
 * fragment, so it is restricted to characters that are unambiguous in all three.
 */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/

/**
 * Display version; the registry `uint64` is the authoritative ordering.
 *
 * The suffix is written with block boundaries forced at `+` ONLY. The previous form,
 * `(?:[-+][0-9A-Za-z.-]+)*`, let `-` start a block AND appear inside one, which is exponentially
 * ambiguous under backtracking — measured 1.4s on a 45-character hostile version string, and this
 * pattern runs against ATTACKER-PUBLISHED manifest bytes. Same accepted language (a `-`-started
 * block merges into the previous block's run), verified by 500k-input differential fuzz.
 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)*)?$/

/** Declared shared-state key (`manifest.storeKeys`). */
export const STORE_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

/**
 * One path segment inside a package. Deliberately an allowlist: it cannot match
 * `.`, `..`, an empty segment, a Windows drive letter followed by `:`, or
 * anything containing `/`, `\`, `?`, `#`, `%` or whitespace. A denylist here
 * would be a game of catching encodings (`%2e%2e`, `..%2f`, `\u002e`); an
 * allowlist ends the game.
 */
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/** Bounds. Generous for real packages, finite so a hostile manifest cannot exhaust the tab. */
export const MAX_NAME_LENGTH = 128
export const MAX_PATH_LENGTH = 200
export const MAX_PATH_SEGMENTS = 8
export const MAX_PACKAGE_FILES = 64
export const MAX_STYLES = 8
export const MAX_STORE_KEYS = 32

/**
 * Stable machine codes for every refusal this module can produce. Exported so
 * callers (the workspace, the reviewer panel's pre-approval check, tests) can
 * branch on a cause instead of string-matching a message.
 */
export const MANIFEST_REFUSAL = Object.freeze({
  NOT_BYTES: 'not_bytes',
  NOT_UTF8: 'not_utf8',
  NOT_JSON: 'not_json',
  NOT_OBJECT: 'not_object',
  UNKNOWN_SCHEMA: 'unknown_schema',
  BAD_ID: 'bad_id',
  BAD_NAME: 'bad_name',
  BAD_VERSION: 'bad_version',
  BAD_HOST_API: 'bad_host_api',
  HOST_API_TOO_NEW: 'host_api_too_new',
  BAD_ENTRY: 'bad_entry',
  ENTRY_NOT_LISTED: 'entry_not_listed',
  BAD_STYLES: 'bad_styles',
  STYLE_NOT_LISTED: 'style_not_listed',
  BAD_FILES: 'bad_files',
  UNSAFE_PATH: 'unsafe_path',
  BAD_DIGEST: 'bad_digest',
  BAD_SHARED_DEPS: 'bad_shared_deps',
  UNKNOWN_SHARED_DEP: 'unknown_shared_dep',
  BAD_PERMISSIONS: 'bad_permissions',
  /** `contracts` is not an array of valid contract names, or exceeds the bound. */
  BAD_CONTRACTS: 'bad_contracts',
  UNKNOWN_PERMISSION: 'unknown_permission',
  BAD_STORE_KEYS: 'bad_store_keys',
  FILE_NOT_LISTED: 'file_not_listed',
  IDENTITY_MISMATCH: 'identity_mismatch',
  ENTRY_NO_DEFAULT_EXPORT: 'entry_no_default_export',
})

/**
 * The manifest cannot be honored as a runtime contract. Terminal for the launch
 * — nothing from the package runs.
 */
export class ManifestError extends Error {
  /**
   * @param {string} reason - one of {@link MANIFEST_REFUSAL}
   * @param {string} message - developer/log detail
   * @param {{field?: string, userMessage?: string}} [detail]
   */
  constructor(reason, message, detail = {}) {
    super(message)
    this.name = 'ManifestError'
    this.reason = reason
    this.field = detail.field ?? null
    this.userMessage =
      detail.userMessage ??
      'This app package is not a valid mini-app, so it was not run. Please report this to the platform team.'
  }
}

/**
 * The package was built against a newer host contract than this host
 * implements. Separate from {@link ManifestError} because the remedy is
 * different and belongs to the member: update the host, not report a bad
 * package.
 */
export class HostApiError extends Error {
  /**
   * @param {number} required - the package's `hostApi`
   * @param {number} supported - the highest version this host honors
   */
  constructor(required, supported) {
    super(`miniapp manifest: hostApi ${required} is newer than this host supports (${supported})`)
    this.name = 'HostApiError'
    this.reason = MANIFEST_REFUSAL.HOST_API_TOO_NEW
    this.required = required
    this.supported = supported
    this.userMessage =
      `This app needs a newer version of the platform (app contract v${required}, ` +
      `this host supports v${supported}). Refresh to pick up the latest release, then try again.`
  }
}

/**
 * Whether a string is a safe package-relative path.
 *
 * Safe means: relative, forward-slash separated, every segment matching
 * {@link PATH_SEGMENT}, bounded in length and depth. That excludes `..`
 * traversal, absolute paths (`/x`, `C:/x`), protocol-relative (`//host/x`) and
 * any URL with a scheme (`https://…`, `javascript:…`, `data:…`) — all of which
 * would otherwise be pasted into a gateway URL by the loader and could redirect
 * a fetch away from the content-addressed package.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafePackagePath(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return false
  // Reject before splitting: whitespace, a backslash, a control character, a
  // URL scheme or a leading slash must never be reachable, even inside a
  // segment that would otherwise pass. The per-segment allowlist below catches
  // all of these too — stating them here as well means a future loosening of
  // the segment pattern cannot quietly re-open path traversal.
  if (/\s|\\/.test(value)) return false
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false
  if (value.startsWith('/')) return false

  const segments = value.split('/')
  if (segments.length > MAX_PATH_SEGMENTS) return false
  return segments.every((segment) => PATH_SEGMENT.test(segment))
}

/** Refuse `value` unless it is a safe package path. */
function requireSafePath(value, field) {
  if (!isSafePackagePath(value)) {
    throw new ManifestError(
      MANIFEST_REFUSAL.UNSAFE_PATH,
      `miniapp manifest: ${field} "${String(value)}" is not a safe package-relative path`,
      { field }
    )
  }
  return value
}

/** Refuse `value` unless it is a plain (non-array, non-null) object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode manifest bytes to text.
 *
 * `fatal: true` so invalid UTF-8 is a typed refusal instead of replacement
 * characters that would parse into a manifest saying something the publisher
 * never wrote.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes
 * @returns {string}
 */
function decodeManifestBytes(bytes) {
  if (typeof bytes === 'string') {
    // Guarded explicitly: accepting text here would invite callers to hand over
    // a re-serialized manifest, which is exactly the shortcut that would make
    // the keccak check in integrity.js meaningless.
    throw new ManifestError(
      MANIFEST_REFUSAL.NOT_BYTES,
      'miniapp manifest: parseManifest takes the raw fetched bytes, not decoded text'
    )
  }
  let view
  try {
    if (bytes instanceof Uint8Array) view = bytes
    else if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes)
    else if (ArrayBuffer.isView(bytes)) view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    else throw new TypeError('not bytes')
  } catch {
    throw new ManifestError(
      MANIFEST_REFUSAL.NOT_BYTES,
      `miniapp manifest: expected raw bytes, got ${bytes === null ? 'null' : typeof bytes}`
    )
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(view)
  } catch (error) {
    throw new ManifestError(
      MANIFEST_REFUSAL.NOT_UTF8,
      `miniapp manifest: bytes are not valid UTF-8 (${error?.message || error})`
    )
  }
}

/**
 * Parse and validate manifest bytes.
 *
 * Takes bytes rather than a parsed object so there is exactly one place a
 * manifest becomes structured data, immediately after `integrity.js` has proven
 * those same bytes are the approved ones.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes - exactly the bytes fetched and hash-verified
 * @param {{supportedHostApi?: number}} [options]
 * @returns {Readonly<object>} the frozen, normalized manifest
 * @throws {ManifestError|HostApiError} typed refusal — never a bare string
 */
export function parseManifest(bytes, options = {}) {
  const text = decodeManifestBytes(bytes)
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new ManifestError(
      MANIFEST_REFUSAL.NOT_JSON,
      `miniapp manifest: not valid JSON (${error?.message || error})`
    )
  }
  return validateManifest(value, options)
}

/**
 * Validate an already-parsed manifest value.
 *
 * Separate from {@link parseManifest} only so the reviewer panel can validate a
 * candidate manifest it has already decoded; the launch path always goes
 * through `parseManifest` so the bytes and the object can never diverge.
 *
 * @param {unknown} value
 * @param {{supportedHostApi?: number}} [options]
 * @returns {Readonly<object>} the frozen, normalized manifest
 * @throws {ManifestError|HostApiError}
 */
export function validateManifest(value, options = {}) {
  const supportedHostApi = options.supportedHostApi ?? SUPPORTED_HOST_API

  if (!isPlainObject(value)) {
    throw new ManifestError(
      MANIFEST_REFUSAL.NOT_OBJECT,
      `miniapp manifest: top level must be an object, got ${Array.isArray(value) ? 'array' : typeof value}`
    )
  }

  // Schema first: every rule below is only correct for this schema revision.
  if (value.schema !== MANIFEST_SCHEMA) {
    throw new ManifestError(
      MANIFEST_REFUSAL.UNKNOWN_SCHEMA,
      `miniapp manifest: unknown schema "${String(value.schema)}" (this host reads ${MANIFEST_SCHEMA})`,
      {
        field: 'schema',
        userMessage:
          'This app package uses a manifest format this platform does not recognize, so it was not run.',
      }
    )
  }

  if (typeof value.id !== 'string' || !APP_ID_PATTERN.test(value.id)) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_ID,
      `miniapp manifest: id "${String(value.id)}" is not a valid app slug`,
      { field: 'id' }
    )
  }

  if (typeof value.name !== 'string' || value.name.trim() === '' || value.name.length > MAX_NAME_LENGTH) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_NAME,
      `miniapp manifest: name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`,
      { field: 'name' }
    )
  }

  if (typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_VERSION,
      `miniapp manifest: version "${String(value.version)}" is not a semantic version`,
      { field: 'version' }
    )
  }

  // hostApi before anything capability-shaped: if the contract version is one
  // we cannot honor, no other field means what we think it means.
  if (!Number.isInteger(value.hostApi) || value.hostApi < 1) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_HOST_API,
      `miniapp manifest: hostApi must be a positive integer, got ${String(value.hostApi)}`,
      { field: 'hostApi' }
    )
  }
  if (value.hostApi > supportedHostApi) {
    throw new HostApiError(value.hostApi, supportedHostApi)
  }

  const files = normalizeFiles(value.files)

  const entry = requireSafePath(value.entry, 'entry')
  if (!Object.prototype.hasOwnProperty.call(files, entry)) {
    // The digest map is the only thing that authenticates executable bytes.
    // An entry missing from it would be fetched with nothing to check it
    // against — the one file that must be verified, unverifiable.
    throw new ManifestError(
      MANIFEST_REFUSAL.ENTRY_NOT_LISTED,
      `miniapp manifest: entry "${entry}" is not listed in files — its bytes could not be verified`,
      { field: 'entry' }
    )
  }

  const styles = normalizeStyles(value.styles, files)
  const sharedDeps = normalizeSharedDeps(value.sharedDeps)
  const permissions = normalizePermissions(value.permissions)
  const storeKeys = normalizeStoreKeys(value.storeKeys)
  const contracts = normalizeContracts(value.contracts)

  // Declaring names without declaring the capability that reads them is a
  // manifest that misdescribes itself — a reviewer would see the allowlist and
  // assume the app resolves addresses, while the host would refuse every call.
  if (contracts.length > 0 && !permissions.includes('contracts')) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_CONTRACTS,
      'miniapp manifest: contracts are declared but the "contracts" permission is not',
      { field: 'contracts' }
    )
  }

  return Object.freeze({
    schema: value.schema,
    id: value.id,
    name: value.name,
    version: value.version,
    entry,
    styles,
    hostApi: value.hostApi,
    sharedDeps,
    permissions,
    storeKeys,
    contracts,
    files,
  })
}

/**
 * Normalize `files` into a frozen, null-prototype map of safe path -> lowercase
 * digest.
 *
 * The null prototype is deliberate: `JSON.parse` creates real own properties
 * for keys like `__proto__` and `constructor`, and a plain-object map would let
 * a lookup for an ordinary-looking path find an inherited `Object.prototype`
 * member instead of a digest.
 */
function normalizeFiles(value) {
  if (!isPlainObject(value)) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_FILES,
      'miniapp manifest: files must be an object mapping package paths to digests',
      { field: 'files' }
    )
  }

  const paths = Object.keys(value)
  if (paths.length === 0) {
    throw new ManifestError(MANIFEST_REFUSAL.BAD_FILES, 'miniapp manifest: files is empty', {
      field: 'files',
    })
  }
  if (paths.length > MAX_PACKAGE_FILES) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_FILES,
      `miniapp manifest: files lists ${paths.length} entries, more than the ${MAX_PACKAGE_FILES} allowed`,
      { field: 'files' }
    )
  }

  const files = Object.create(null)
  for (const path of paths) {
    requireSafePath(path, `files["${path}"]`)
    const entry = value[path]
    const digest = normalizeDigestHex(isPlainObject(entry) ? entry.sha256 : undefined)
    if (digest === null) {
      throw new ManifestError(
        MANIFEST_REFUSAL.BAD_DIGEST,
        `miniapp manifest: files["${path}"].sha256 is not a sha-256 hex digest`,
        { field: `files["${path}"].sha256` }
      )
    }
    files[path] = Object.freeze({ sha256: digest })
  }
  return Object.freeze(files)
}

/** Stylesheets the host injects; every one must be listed in `files` to be verifiable. */
function normalizeStyles(value, files) {
  if (value === undefined || value === null) return Object.freeze([])
  if (!Array.isArray(value) || value.length > MAX_STYLES) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_STYLES,
      `miniapp manifest: styles must be an array of at most ${MAX_STYLES} package paths`,
      { field: 'styles' }
    )
  }
  const styles = value.map((path, index) => requireSafePath(path, `styles[${index}]`))
  for (const path of styles) {
    if (!Object.prototype.hasOwnProperty.call(files, path)) {
      throw new ManifestError(
        MANIFEST_REFUSAL.STYLE_NOT_LISTED,
        `miniapp manifest: style "${path}" is not listed in files — its bytes could not be verified`,
        { field: 'styles' }
      )
    }
  }
  return Object.freeze(styles)
}

/**
 * Shared modules the package expects the host to supply from its frozen scope
 * (research R2). Refusing an unknown name here turns a runtime
 * `undefined is not a function` deep inside a mounted app into an honest
 * pre-launch refusal.
 */
function normalizeSharedDeps(value) {
  if (value === undefined || value === null) return Object.freeze([])
  if (!Array.isArray(value)) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_SHARED_DEPS,
      'miniapp manifest: sharedDeps must be an array of module specifiers',
      { field: 'sharedDeps' }
    )
  }
  for (const dep of value) {
    if (typeof dep !== 'string' || !HOST_SHARED_MODULES.includes(dep)) {
      throw new ManifestError(
        MANIFEST_REFUSAL.UNKNOWN_SHARED_DEP,
        `miniapp manifest: sharedDeps declares "${String(dep)}", which this host does not provide`,
        {
          field: 'sharedDeps',
          userMessage:
            'This app expects a platform module this host does not provide, so it was not run. ' +
            'Please report this to the platform team.',
        }
      )
    }
  }
  return Object.freeze([...value])
}

/**
 * Declared capability use. A manifest may only name capabilities the host
 * context actually exposes — otherwise it could advertise (to a reviewer, in
 * the catalog) a permission the host neither grants nor enforces.
 */
function normalizePermissions(value) {
  if (value === undefined || value === null) return Object.freeze([])
  if (!Array.isArray(value)) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_PERMISSIONS,
      'miniapp manifest: permissions must be an array of capability names',
      { field: 'permissions' }
    )
  }
  for (const permission of value) {
    if (typeof permission !== 'string' || !HOST_PERMISSIONS.includes(permission)) {
      throw new ManifestError(
        MANIFEST_REFUSAL.UNKNOWN_PERMISSION,
        `miniapp manifest: permissions declares "${String(permission)}", which is not a host capability`,
        { field: 'permissions' }
      )
    }
  }
  return Object.freeze([...value])
}

/**
 * Declared contract names (hostApi 2). Unlike `storeKeys`, this IS an access
 * gate: `host.contracts(name)` refuses a name the manifest did not declare, so
 * what a reviewer approved is exactly what the app can resolve at runtime.
 */
function normalizeContracts(value) {
  if (value === undefined || value === null) return Object.freeze([])
  if (!Array.isArray(value) || value.length > MAX_DECLARED_CONTRACTS) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_CONTRACTS,
      `miniapp manifest: contracts must be an array of at most ${MAX_DECLARED_CONTRACTS} names`,
      { field: 'contracts' }
    )
  }
  for (const name of value) {
    if (typeof name !== 'string' || !CONTRACT_NAME_PATTERN.test(name)) {
      throw new ManifestError(
        MANIFEST_REFUSAL.BAD_CONTRACTS,
        `miniapp manifest: contracts entry "${String(name)}" is not a valid contract name`,
        { field: 'contracts' }
      )
    }
  }
  return Object.freeze([...value])
}

/** Declared namespaced-store keys — documentation and audit, not an access gate. */
function normalizeStoreKeys(value) {
  if (value === undefined || value === null) return Object.freeze([])
  if (!Array.isArray(value) || value.length > MAX_STORE_KEYS) {
    throw new ManifestError(
      MANIFEST_REFUSAL.BAD_STORE_KEYS,
      `miniapp manifest: storeKeys must be an array of at most ${MAX_STORE_KEYS} keys`,
      { field: 'storeKeys' }
    )
  }
  for (const key of value) {
    if (typeof key !== 'string' || !STORE_KEY_PATTERN.test(key)) {
      throw new ManifestError(
        MANIFEST_REFUSAL.BAD_STORE_KEYS,
        `miniapp manifest: storeKeys entry "${String(key)}" is not a valid key`,
        { field: 'storeKeys' }
      )
    }
  }
  return Object.freeze([...value])
}

/**
 * The declared digest for a package path, refusing anything the manifest does
 * not list.
 *
 * This is the loader's gate on *what may be fetched at all*: a file with no
 * declared digest can never be verified, so it is never requested.
 *
 * @param {Readonly<object>} manifest - a manifest returned by {@link validateManifest}
 * @param {string} path
 * @returns {string} the lowercase sha-256 hex digest
 * @throws {ManifestError} when the path is unsafe or unlisted
 */
export function manifestFileDigest(manifest, path) {
  requireSafePath(path, 'file path')
  const entry = manifest?.files && Object.prototype.hasOwnProperty.call(manifest.files, path)
    ? manifest.files[path]
    : null
  if (!entry) {
    throw new ManifestError(
      MANIFEST_REFUSAL.FILE_NOT_LISTED,
      `miniapp manifest: "${path}" is not listed in files — the host will not fetch unverifiable bytes`,
      { field: 'files' }
    )
  }
  return entry.sha256
}
