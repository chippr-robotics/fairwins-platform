/**
 * Spec 073 T041 — isolation hardening (FR-018, FR-013).
 *
 * `store.test.js` already covers that two apps get separate data and that the
 * store API takes no argument naming a namespace. This file is the ADVERSARIAL
 * pass: it asks what a hostile package would actually try, and it asserts the
 * two properties the whole trust model rests on.
 *
 *   1. No pair of valid app ids can be made to share a storage key, and nothing
 *      an app writes can be made to appear under another app's id — including
 *      through the backup seam, which is the one place app ids are PARSED back
 *      out of storage keys rather than only built.
 *   2. The frozen `host` object is the entire privileged surface. Nothing
 *      reachable from it — by property, by prototype, by a returned value —
 *      hands back a host-internal store, a signer, a storage handle, or another
 *      app's anything.
 *
 * These are asserted about the SHIPPED objects, not about a description of
 * them, because the failure being guarded against is a future refactor quietly
 * widening the surface.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { MiniAppHostProvider, useMiniAppHost } from '../../lib/miniapps/hostContext'
import {
  createAppStore,
  appStoreStorageKey,
  appStoreFeatureKey,
  listStoredAppIds,
  loadMiniAppState,
  __resetMiniAppStores,
} from '../../lib/miniapps/store'
import { APP_ID_PATTERN } from '../../lib/miniapps/manifest'
import { getUserPreference } from '../../utils/userStorage'

const ACCT = '0xAbC0000000000000000000000000000000000041'
const OTHER = '0xDdE0000000000000000000000000000000000041'

/* The host's seams, stubbed exactly as hostContext.test.jsx stubs them, so the
   walk below runs against the real provider rather than a stand-in. */
const seams = vi.hoisted(() => ({ provider: null }))

vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => ({ chainId: 137, isConnected: true, openConnectModal: () => {} }),
}))
vi.mock('../../hooks/useEffectiveAccount', () => ({
  useEffectiveAccount: () => ({
    address: '0xAbC0000000000000000000000000000000000041',
    connectedAddress: '0xAbC0000000000000000000000000000000000041',
    chainId: null,
  }),
}))
vi.mock('../../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({
    isVault: false,
    isLegacy: false,
    canActAsVault: false,
    canActAsLegacy: false,
    submit: async () => ({ kind: 'sent', txHash: '0xdead' }),
  }),
}))
vi.mock('../../hooks/useUI', () => ({ useNotification: () => ({ showNotification: () => {} }) }))
vi.mock('../../utils/rpcProvider', () => ({ getReadProvider: () => seams.provider }))

/** Mount the real provider and return the host object an app would receive. */
function mountRealHost(appId = 'evil') {
  const ref = { current: null }
  function Probe() {
    ref.current = useMiniAppHost()
    return null
  }
  render(
    <MiniAppHostProvider appId={appId}>
      <Probe />
    </MiniAppHostProvider>,
  )
  return ref.current
}

beforeEach(() => {
  localStorage.clear()
  __resetMiniAppStores()
  const provider = { call: async () => '0x', destroy: vi.fn(), removeAllListeners: vi.fn() }
  provider.provider = provider // AbstractProvider's self-returning getter
  seams.provider = provider
})

/* ------------------------------------------------------------------ *
 * 1. Namespace collision
 * ------------------------------------------------------------------ */

describe('two apps can never collide on a storage key', () => {
  /**
   * The key is `fw_user_<account>_miniapp_<appId>_v1`. Because APP_ID_PATTERN
   * admits no underscore, the `_v1` suffix cannot be forged by an app id, and
   * `miniapp_` cannot be re-entered. These ids are the near-misses that would
   * break a sloppier scheme.
   */
  const ADVERSARIAL_IDS = [
    'a-v1',            // ends the way the suffix does
    'av1',
    'v1',
    'miniapp',         // re-enters the infix
    'miniapp-v1',
    'token-mint',
    'token-mint-v1',
    'x'.repeat(31),    // max length
    'ab',              // min length
  ]

  it('every adversarial id is actually valid, so this test is testing something', () => {
    for (const id of ADVERSARIAL_IDS) expect(APP_ID_PATTERN.test(id)).toBe(true)
  })

  it('produces a distinct storage key for every distinct id', () => {
    const keys = ADVERSARIAL_IDS.map((id) => appStoreStorageKey(ACCT, id))
    expect(new Set(keys).size).toBe(ADVERSARIAL_IDS.length)
  })

  it('keeps adjacent ids\' data entirely separate when all of them write the same key', () => {
    for (const id of ADVERSARIAL_IDS) createAppStore(ACCT, id).set('secret', id)
    for (const id of ADVERSARIAL_IDS) {
      expect(createAppStore(ACCT, id).get('secret')).toBe(id)
    }
  })

  it('round-trips every adversarial id through the backup seam under its own id', () => {
    for (const id of ADVERSARIAL_IDS) createAppStore(ACCT, id).set('secret', id)
    const bundle = loadMiniAppState(ACCT)
    // The backup seam PARSES ids back out of storage keys; a mis-parse here
    // would hand one app's state to another on restore.
    expect(Object.keys(bundle).sort()).toEqual([...ADVERSARIAL_IDS].sort())
    for (const id of ADVERSARIAL_IDS) expect(bundle[id]).toEqual({ secret: id })
  })

  it('separates the same app id across two accounts', () => {
    createAppStore(ACCT, 'token-mint').set('secret', 'mine')
    createAppStore(OTHER, 'token-mint').set('secret', 'theirs')
    expect(createAppStore(ACCT, 'token-mint').get('secret')).toBe('mine')
    expect(listStoredAppIds(OTHER)).toEqual(['token-mint'])
    expect(loadMiniAppState(OTHER)).toEqual({ 'token-mint': { secret: 'theirs' } })
  })

  it('does not let a crafted VALUE surface as another app\'s namespace', () => {
    // Writing an object that looks like a whole bundle must stay one value in
    // one namespace — it is data, not structure.
    createAppStore(ACCT, 'evil').set('payload', { 'token-mint': { stolen: true } })
    expect(loadMiniAppState(ACCT)).toEqual({ evil: { payload: { 'token-mint': { stolen: true } } } })
    expect(createAppStore(ACCT, 'token-mint').get('stolen')).toBeNull()
  })
})

describe('the store interface exposes no path to another namespace', () => {
  it('takes only keys — every namespace-shaped argument reads as a plain miss', () => {
    createAppStore(ACCT, 'victim').set('secret', 'do-not-leak')
    const evil = createAppStore(ACCT, 'evil')

    for (const attempt of [
      'victim',
      'victim.secret',
      '../victim/secret',
      appStoreFeatureKey('victim'),
      appStoreStorageKey(ACCT, 'victim'),
      '__proto__',
      'constructor',
    ]) {
      expect(evil.get(attempt, 'MISS')).toBe('MISS')
    }
    // …and nothing above wrote through to the victim either.
    expect(createAppStore(ACCT, 'victim').get('secret')).toBe('do-not-leak')
  })

  it('cannot be re-pointed: the returned store is frozen and holds no app id', () => {
    const store = createAppStore(ACCT, 'evil')
    expect(Object.isFrozen(store)).toBe(true)
    expect(Object.keys(store).sort()).toEqual(['get', 'set', 'subscribe'])
    // No appId/account/namespace property to overwrite, and freezing means an
    // attempt to add one fails rather than silently taking effect.
    expect(() => { store.appId = 'victim' }).toThrow()
    expect(store.appId).toBeUndefined()
  })

  it('writes reach only the writer\'s own userStorage feature key', () => {
    createAppStore(ACCT, 'evil').set('k', 'v')
    expect(getUserPreference(ACCT, appStoreFeatureKey('evil'), null, true)).not.toBeNull()
    expect(getUserPreference(ACCT, appStoreFeatureKey('victim'), null, true)).toBeNull()
  })
})

/* ------------------------------------------------------------------ *
 * 2. Host-internal stores are unreachable from the host object
 * ------------------------------------------------------------------ */

describe('host-internal stores are unreachable from the REAL host object', () => {
  /**
   * `hostContext.test.jsx` already pins the exact key list against the real
   * provider. What is new here is the RECURSIVE walk: a future refactor is far
   * more likely to smuggle an internal in as a nested property of something
   * already exposed than to add an eighth top-level key.
   *
   * It runs against the object a mounted app actually receives, not a stand-in,
   * because a hand-built fixture would only ever prove that the fixture is
   * clean.
   */
  it('reaches no host internal by recursive property walk', () => {
    const host = mountRealHost()

    // Names of the host's own stores, key material, and the handles that would
    // let an app act outside the mediated surface.
    // `contracts` is deliberately absent from this list as of hostApi 2: it is
    // a documented capability, and — as the test below asserts — an ACCESSOR,
    // not the address map itself.
    const FORBIDDEN = [
      'addressBook', 'preferences', 'ledger', 'backup', 'endpoints', 'legacyKeys',
      'vault', 'keystore', 'passkey', 'config', 'namespaces', 'NETWORKS',
      'userStorage', 'localStorage', 'signer', 'getSigner', 'privateKey', 'seed',
      'mnemonic', 'signMessage', 'signTypedData',
    ]
    const seen = new Set()
    const walk = (value, path, depth) => {
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 6) return
      seen.add(value)
      for (const key of Object.keys(value)) {
        expect(
          FORBIDDEN.includes(key),
          `host${path}.${key} would expose a host internal to every mini-app`,
        ).toBe(false)
        let child
        try {
          child = value[key]
        } catch {
          continue // a throwing getter is not a reachable internal
        }
        walk(child, `${path}.${key}`, depth + 1)
      }
    }
    walk(host, '', 0)
  })

  it('hands over an ACCESSOR for deployments, never the address book itself', () => {
    const host = mountRealHost()
    // The distinction the whole hostApi-2 design rests on: a function the host
    // controls, gated by the manifest allowlist, rather than a map the app
    // could enumerate to learn the entire estate.
    expect(typeof host.contracts).toBe('function')
    expect(typeof host.network).toBe('function')
    for (const value of [host.contracts, host.network]) {
      expect(Array.isArray(value)).toBe(false)
      expect(value.NETWORKS).toBeUndefined()
    }
  })

  it('refuses a contract name the manifest never declared', () => {
    // `mountRealHost` declares nothing, so every name is undeclared — the gate
    // fails CLOSED when a workspace forgets to pass the allowlist.
    const host = mountRealHost()
    expect(() => host.contracts('tokenFactory', 137)).toThrow(/not declared/)
  })

  it('gives the app no way to sign outside `submit`', () => {
    const { wallet } = mountRealHost()
    // A signer would let an app sign arbitrary payloads — permits, EIP-712
    // intents, message-based auth — with no host mediation and no audit entry.
    for (const name of ['signer', 'getSigner', 'signMessage', 'signTypedData', 'sendTransaction', 'provider']) {
      expect(wallet[name]).toBeUndefined()
    }
  })

  it('hands back a provider the app can read through but cannot dismantle', () => {
    const provider = mountRealHost().readProvider()
    // NOT a claim that the provider has no RPC surface — an app is entitled to
    // read, and `call` is how it does so. The guarded members are the ones that
    // would take down the provider the HOST shares (see BLOCKED_PROVIDER_MEMBERS).
    expect(typeof provider.call).toBe('function')

    // The blocked members are present but REFUSE LOUDLY rather than silently
    // no-op'ing: an app whose teardown is denied should find out. Either way
    // the call never reaches the shared instance — the host caches ONE provider
    // per endpoint, so a real `destroy()` would take the wallet's reads down.
    expect(() => provider.destroy()).toThrow(/not available to mini-apps/)
    expect(() => provider.removeAllListeners()).toThrow(/not available to mini-apps/)
    expect(seams.provider.destroy).not.toHaveBeenCalled()
    expect(seams.provider.removeAllListeners).not.toHaveBeenCalled()

    // The self-returning `provider` getter must hand back the WRAPPER, or the
    // guard is escaped in one hop.
    expect(() => provider.provider.destroy()).toThrow(/not available to mini-apps/)
    expect(seams.provider.destroy).not.toHaveBeenCalled()
  })
})

describe('the shared module scope publishes only the SDK surface', () => {
  it('exposes no host module beyond the documented singletons', async () => {
    vi.resetModules()
    const { installHostScope, HOST_SCOPE_SYMBOL } = await import('../../lib/miniapps/hostScope')
    installHostScope()
    const scope = globalThis[HOST_SCOPE_SYMBOL]
    // react/react-dom/jsx-runtime/ethers/viem/@fairwins/miniapp-sdk (research R2) —
    // a host module added here would be granted to EVERY package, including
    // third-party ones, forever. `viem` joined under spec 110 Phase 0 (#1591):
    // a client LIBRARY like ethers, no ambient authority — every privileged
    // capability still flows only through the `host` object.
    const allowed = new Set([
      'react',
      'react-dom',
      'react/jsx-runtime',
      'ethers',
      'viem',
      '@fairwins/miniapp-sdk',
    ])
    for (const key of Object.keys(scope)) {
      expect(allowed.has(key), `shared scope publishes "${key}" to every mini-app`).toBe(true)
    }
    expect(Object.isFrozen(scope)).toBe(true)
  })
})
