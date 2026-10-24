/**
 * Mini-app package constants (spec 073).
 *
 * Every value in this file is one half of a cross-boundary contract: the other
 * half lives in the host (`frontend/src/lib/miniapps/`) or on-chain in
 * `MiniAppRegistry`. Changing any of them changes what already-published
 * packages mean, so they are declared once, here, and imported everywhere else.
 *
 * Sources of truth:
 * - manifest shape ....... specs/073-miniapp-platform/data-model.md §2
 * - host scope + context . specs/073-miniapp-platform/contracts/host-context.md
 * - shared-dep dedup ..... specs/073-miniapp-platform/research.md R2
 */

/**
 * Symbol key of the host's frozen shared-module scope. The host installs
 * `globalThis[Symbol.for(HOST_SCOPE_SYMBOL_KEY)]` at bootstrap
 * (`frontend/src/lib/miniapps/hostScope.js`); the shims this preset generates
 * read their bindings from it. A registered symbol (`Symbol.for`) is used
 * deliberately: the host and a Blob-imported mini-app module are different
 * module graphs, so a module-local symbol could never be shared between them.
 */
export const HOST_SCOPE_SYMBOL_KEY = 'fairwins.miniapp.host'

/**
 * Host-context contract version the preset builds against (`manifest.hostApi`).
 * The host refuses to launch a package whose `hostApi` is newer than it
 * supports, so this number is bumped only when the runtime contract in
 * `contracts/host-context.md` changes in a way old hosts cannot honor.
 */
export const HOST_API_VERSION = 2

/** Manifest schema identifier; an unknown value is a launch refusal, not a warning. */
export const MANIFEST_SCHEMA = 'fairwins-miniapp-manifest/1'

/**
 * Package file names. `manifest.json` is the integrity anchor
 * (`keccak256(bytes)` is what the registry stores), so it is never listed in
 * its own `files` map and never itself hashed into the map.
 */
export const MANIFEST_FILENAME = 'manifest.json'
export const ENTRY_FILENAME = 'entry.js'
export const STYLE_FILENAME = 'style.css'

/**
 * App id / registry slug pattern. Mirrors the tenant id pattern
 * (`scripts/tenants/validate-tenant-manifest.js`) because the same string is
 * used as a URL segment (`/apps/:appId`), a `userStorage` namespace
 * (`miniapp_<appId>_v1`) and a client-ledger entry id fragment.
 */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}$/

/**
 * Display version (`manifest.version`); the registry `uint64` is the authoritative ordering.
 *
 * Kept byte-identical with `frontend/src/lib/miniapps/manifest.js` (deliberate mirrors — the
 * package boundary forbids a shared import). Block boundaries are forced at `+` ONLY: the previous
 * `(?:[-+][0-9A-Za-z.-]+)*` was exponentially ambiguous under backtracking because `-` could start
 * a block and sit inside one. Same accepted language, verified by 500k-input differential fuzz.
 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)*)?$/

/** Declared shared-state key pattern (`manifest.storeKeys`). */
export const STORE_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

/**
 * The complete set of capabilities the host context exposes
 * (`contracts/host-context.md`). A package declares the subset it uses in
 * `manifest.permissions`; declaring anything else is a build failure rather
 * than a silently ignored string, so the manifest cannot promise a capability
 * the host does not have.
 */
export const HOST_PERMISSIONS = [
  'wallet:submit',
  'store',
  'audit',
  'toast',
  'navigate',
  // hostApi 2 — inert public data. `contracts` additionally requires the
  // package to declare WHICH names it may resolve (`contracts: [...]`), so a
  // reviewer reads an allowlist instead of a bundled address table.
  'contracts',
  'network',
]

/** Contract names a package may declare in `manifest.contracts` (hostApi 2). */
export const CONTRACT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{1,63}$/
export const MAX_DECLARED_CONTRACTS = 16

/**
 * Modules the host owns as singletons and mini-apps must never bundle (R2).
 *
 * - `specifier` — the bare import a mini-app writes, and the key the host scope
 *   is read by (`scope['react/jsx-runtime']`). Keying the scope by the bare
 *   specifier keeps `manifest.sharedDeps` a literal list of the scope keys a
 *   package needs — no translation table to drift.
 * - `package` — the npm package that owns the specifier, used by the
 *   no-bundled-copy assertion to prove no module from it reached the bundle.
 * - `exports` — fallback binding names, used only when the specifier cannot be
 *   resolved at build time. `@fairwins/miniapp-sdk` has no on-disk
 *   implementation (the host *is* the implementation), so its surface is
 *   declared here and MUST stay in sync with `contracts/host-context.md`.
 */
export const SHARED_MODULES = [
  { specifier: 'react', package: 'react' },
  { specifier: 'react-dom', package: 'react-dom' },
  { specifier: 'react/jsx-runtime', package: 'react' },
  { specifier: 'ethers', package: 'ethers' },
  // spec 110 Phase 0 (#1591): additive — see HOST_SHARED_MODULES in the host manifest module.
  { specifier: 'viem', package: 'viem' },
  { specifier: '@fairwins/miniapp-sdk', package: '@fairwins/miniapp-sdk', exports: ['useMiniAppHost'] }
]

/** Bare specifiers of {@link SHARED_MODULES}, in declaration order. */
export const SHARED_MODULE_SPECIFIERS = SHARED_MODULES.map((entry) => entry.specifier)

/**
 * Env prefix for mini-app builds — deliberately a prefix nothing uses.
 *
 * A mini-app package is published to a content-addressed gateway and served to
 * every member, so build-environment values must never be inlined into it: a
 * stray `VITE_PINATA_JWT` in the shell would otherwise be baked into public
 * bytes (the failure mode `frontend/vite.config.js`'s `pinataSecretGuard`
 * exists to prevent for the host bundle). Mini-apps take configuration from the
 * host context at runtime, never from `import.meta.env`.
 */
export const MINIAPP_ENV_PREFIX = '__MINIAPP_NO_INLINE_ENV__'
