/**
 * The host's shared-module scope (spec 073, research R2 ·
 * `contracts/host-context.md`).
 *
 * A mini-app package ships NO copy of React, ReactDOM or ethers. The build
 * preset (`tools/miniapp-build/hostScopePlugin.js`) rewrites those bare imports
 * into shims that read their bindings from
 * `globalThis[Symbol.for('fairwins.miniapp.host')]` at module-evaluation time.
 * This module is the other half of that contract: it puts the host's own
 * singleton namespaces there, once, before anything can be mounted.
 *
 * That is a correctness requirement before it is a size optimization — two
 * copies of React cannot share one element tree, so a mini-app that bundled its
 * own React could not render inside the host's workspace at all. The scope is
 * also how the SDK reaches an app: `@fairwins/miniapp-sdk` has no
 * implementation on disk, because the host IS the implementation.
 *
 * Three properties are load-bearing, and each is enforced rather than assumed:
 *
 * - **A registered symbol.** A Blob-imported mini-app is a different module
 *   graph from the host, so a module-local symbol could never be shared between
 *   them. `Symbol.for` is the same key in both graphs and is namespaced enough
 *   that nothing else on the page will collide with it.
 * - **Installed once and not re-pointable.** The property is defined
 *   non-writable and non-configurable, and a second `installHostScope()` returns
 *   the existing scope instead of replacing it. Otherwise the first mini-app to
 *   run could swap the scope out from under every app loaded after it —
 *   substituting its own "React" for the host's is precisely the attack the
 *   frozen scope exists to prevent.
 * - **Exactly the documented surface.** The scope is checked against
 *   {@link HOST_SHARED_MODULES} at install: a missing specifier would surface as
 *   an unattributable crash inside an app's own code, and an EXTRA one would be
 *   a privileged module handed to third-party code that nothing in the manifest
 *   ever declared (FR-013 — anything not listed is unreachable by design).
 *
 * BUILD-SIDE TWIN: `tools/miniapp-build/constants.js` declares the same symbol
 * key, host API version and shared-module list for the packaging preset. The
 * two are a matched pair across the build/host boundary (the preset is Node
 * tooling, not a frontend dependency) and MUST change together — a drift means
 * a package that builds cleanly and gets `undefined` at runtime. The gating
 * test is `src/test/miniapps/hostScope.test.js`.
 */

import * as react from 'react'
import * as reactDom from 'react-dom'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ethers from 'ethers'
import * as viem from 'viem'

import { HOST_SHARED_MODULES, SUPPORTED_HOST_API } from './manifest'
import { useMiniAppHost } from './hostContext'

/**
 * Key of the frozen shared-module scope on `globalThis`. Registered
 * (`Symbol.for`) so the host and a Blob-imported package resolve the same
 * symbol from separate module graphs.
 */
export const HOST_SCOPE_SYMBOL = Symbol.for('fairwins.miniapp.host')

/**
 * The runtime-contract version this host implements (`manifest.hostApi`).
 *
 * Derived from the manifest validator's `SUPPORTED_HOST_API` rather than
 * restated: "the newest contract this host implements" and "the newest contract
 * this host will accept a package for" are the same number, and two literals
 * would eventually disagree about it.
 */
export const HOST_API_VERSION = SUPPORTED_HOST_API

/**
 * The mini-app SDK, published on the scope as `@fairwins/miniapp-sdk`.
 *
 * Deliberately one hook. Everything privileged is reached through the host
 * object it returns, so the SDK has no second door — and the build preset
 * discovers this package's exports from the declared list in
 * `tools/miniapp-build/constants.js`, which means adding a binding here without
 * adding it there produces a package that cannot import it.
 */
const miniAppSdk = Object.freeze({ useMiniAppHost })

/**
 * Build the scope object. Keyed by the BARE SPECIFIER a mini-app writes
 * (`scope['react/jsx-runtime']`), so `manifest.sharedDeps` is a literal list of
 * scope keys with no translation table to drift.
 *
 * Values are module NAMESPACE objects — what the generated shim expects, and
 * what makes `export default` resolve correctly for a CJS package (React's
 * `default`) and an ESM one (ethers, which has none) alike.
 */
function buildHostScope() {
  const scope = {
    react,
    'react-dom': reactDom,
    'react/jsx-runtime': jsxRuntime,
    ethers,
    viem,
    '@fairwins/miniapp-sdk': miniAppSdk,
  }

  // Set equality against the declared list, both directions (see the header).
  // This can only fail on a programming error, which is why it fails loudly:
  // the alternative is a mini-app crashing somewhere the member cannot diagnose.
  const provided = Object.keys(scope)
  const missing = HOST_SHARED_MODULES.filter((specifier) => !provided.includes(specifier))
  const extra = provided.filter((specifier) => !HOST_SHARED_MODULES.includes(specifier))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `miniapps/hostScope: shared-module scope does not match the declared surface — ` +
        `missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`,
    )
  }

  return Object.freeze(scope)
}

/**
 * Install the shared-module scope. Called once at bootstrap (`main.jsx`), before
 * the first render, so it is in place long before any workspace can import a
 * package.
 *
 * Idempotent: a second call is a no-op that returns the scope already
 * installed — it never throws and never replaces, so a duplicate bootstrap
 * (StrictMode, a hot reload, a test importing the module twice) cannot hand two
 * different Reacts to two different apps.
 *
 * @returns {Readonly<object>} the installed scope
 */
export function installHostScope() {
  const existing = globalThis[HOST_SCOPE_SYMBOL]
  if (existing) return existing

  const scope = buildHostScope()
  Object.defineProperty(globalThis, HOST_SCOPE_SYMBOL, {
    value: scope,
    // Non-writable AND non-configurable: once mini-app code is running in this
    // realm, the scope must be something it can read and nothing it can swap.
    writable: false,
    configurable: false,
    enumerable: false,
  })
  return scope
}

/**
 * Whether this host can honor a package built against `hostApi`.
 *
 * Older contracts stay supported — a package built against v1 must keep running
 * on a v2 host — and anything newer is refused, because the app expects
 * capabilities this host does not have and would fail in ways the member cannot
 * diagnose. The launch path raises `HostApiError` (`manifest.js`) for the
 * refusal; this predicate is for surfaces that need to ask before trying, such
 * as the catalog marking a listing unavailable.
 *
 * @param {unknown} hostApi - a package's declared `manifest.hostApi`
 * @returns {boolean}
 */
export function isHostApiSupported(hostApi) {
  return Number.isInteger(hostApi) && hostApi >= 1 && hostApi <= HOST_API_VERSION
}
