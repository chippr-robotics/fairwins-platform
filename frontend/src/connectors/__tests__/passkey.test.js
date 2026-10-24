/**
 * Spec 041 T025 — passkey connector: fresh connect (sign-up + sign-in),
 * silent reconnect, disconnect clears session, unsupported-chain refusal,
 * session persistence semantics (no self-expiry).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The build's home network (`VITE_NETWORK_ID`, else `PRIMARY_CHAIN_ID`). Mutable so a test can
// stand up a testnet-cohort build and a mainnet one without rebuilding the module graph.
// `vi.hoisted` because the mock factory below is hoisted above every declaration in this file.
const build = vi.hoisted(() => ({ chainId: 80002 }))

vi.mock('../../config/networks', () => ({
  getCurrentChainId: vi.fn(() => build.chainId),
  getNetwork: vi.fn((chainId) =>
    chainId === 80002
      ? {
          chainId: 80002,
          rpcUrl: 'https://rpc.example',
          capabilities: { passkeyAccounts: true },
          passkey: { bundlerUrls: ['https://bundler.example'], sponsorPaymasterUrl: null },
        }
      : { chainId, capabilities: { passkeyAccounts: false }, passkey: null }
  ),
}))
vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: vi.fn((key, chainId) =>
    chainId === 80002
      ? {
          accountFactory: '0xFAC7000000000000000000000000000000000001',
          entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
        }[key]
      : null
  ),
}))

import { passkeyConnector, readSession, writeSession, PASSKEY_CONNECTOR_ID } from '../passkey'
import { ChainNotSupportedError } from '../../lib/passkey/smartAccount'
import { rememberCredential, knownCredentials, isTransactComplete } from '../../lib/passkey/credentials'
import { computeAccountAddress, publicKeyToOwnerBytes } from '../../lib/passkey/smartAccount'
/*
 * `@noble/curves/nist.js`, not `p256.js`. The dependabot bump to @noble/curves 2.x (#1157)
 * removed the per-curve subpath, so `p256.js` is not in the package's exports map any more and the
 * whole FILE fails to load — 0 tests run, which reads as a suite failure rather than a resolution
 * one. Every other passkey test in the tree was already migrated; this branch predates the bump.
 */
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'

const ACCOUNT = '0x00000000000000000000000000000000000a11CE'
const PUBLIC_KEY = { x: '0x' + '1'.repeat(64), y: '0x' + '2'.repeat(64) }

function makeConnector(overrides = {}) {
  const deps = {
    detectCapability: vi.fn().mockResolvedValue({ available: true, platformAuthenticator: true }),
    createCredential: vi
      .fn()
      .mockResolvedValue({ credentialId: 'cred-1', publicKey: PUBLIC_KEY, prfCapable: true }),
    getAssertion: vi.fn().mockResolvedValue({ credentialId: 'cred-1' }),
    deriveAddress: vi.fn().mockResolvedValue(ACCOUNT),
    resolveAddress: vi.fn().mockResolvedValue(ACCOUNT),
    readControllers: vi.fn().mockResolvedValue({ deployed: false, controllers: [] }),
    ...overrides,
  }
  const config = {
    chains: overrides.chains ?? [{ id: 80002 }, { id: 137 }],
    emitter: { emit: vi.fn() },
  }
  const connector = passkeyConnector({ deps, ...overrides.options })(config)
  return { connector, deps, config }
}

/** A transact-complete book record, as sign-up would have written it. */
function rememberCompleteRecord(credentialId = 'cred-1') {
  rememberCredential({ credentialId, publicKey: PUBLIC_KEY, prfCapable: true, address: ACCOUNT })
}

beforeEach(() => {
  localStorage.clear()
  build.chainId = 80002
})

describe('connect', () => {
  it('sign-up: creates a credential, derives the counterfactual address, persists the session', async () => {
    const { connector } = makeConnector()
    const out = await connector.connect({ chainId: 80002 })
    expect(out.accounts[0].toLowerCase()).toBe(ACCOUNT.toLowerCase())
    expect(out.chainId).toBe(80002)
    const session = readSession()
    expect(session.loginMethod).toBe('passkey')
    expect(session.credentialId).toBe('cred-1')
    expect(session.expiry ?? session.expiresAt).toBeUndefined() // no self-expiry (clarification Q4)
  })

  it('sign-in: unpinned assertion (platform picker) resolves the existing account', async () => {
    rememberCompleteRecord()
    const { connector, deps } = makeConnector({ options: { mode: 'sign-in' } })
    const out = await connector.connect({ chainId: 80002 })
    expect(deps.getAssertion).toHaveBeenCalled()
    expect(deps.createCredential).not.toHaveBeenCalled()
    expect(out.accounts[0].toLowerCase()).toBe(ACCOUNT.toLowerCase())
  })

  it('sign-in refreshes the credential book so the session can transact (spec 045 FR-005)', async () => {
    // The old sign-in branch never wrote the book — the transaction path then
    // resolved an undefined credential and crashed with "reading 'id'".
    rememberCompleteRecord()
    const { connector } = makeConnector({ options: { mode: 'sign-in' } })
    await connector.connect({ chainId: 80002 })
    const [rec] = knownCredentials()
    expect(rec.credentialId).toBe('cred-1')
    expect(rec.address).toBe(ACCOUNT)
    expect(rec.publicKey).toEqual(PUBLIC_KEY) // merge never drops the key
  })

  it('sign-in repairs a missing public key from the chain when unambiguous', async () => {
    rememberCredential({ credentialId: 'cred-1', address: ACCOUNT }) // legacy partial record
    const ownerBytes = `0x${'1'.repeat(64)}${'2'.repeat(64)}`
    const { connector } = makeConnector({
      options: { mode: 'sign-in' },
      readControllers: vi.fn().mockResolvedValue({
        deployed: true,
        controllers: [{ index: 0n, kind: 'passkey', ownerBytes }],
      }),
    })
    await connector.connect({ chainId: 80002 })
    const [rec] = knownCredentials()
    expect(rec.publicKey).toEqual(PUBLIC_KEY)
  })

  it('sign-in pinned to a chosen credential passes it to the assertion (spec 045 US3)', async () => {
    rememberCredential({ credentialId: 'cred-2', publicKey: PUBLIC_KEY, address: ACCOUNT })
    const { connector, deps } = makeConnector({
      options: { mode: 'sign-in' },
      getAssertion: vi.fn().mockResolvedValue({ credentialId: 'cred-2' }),
      resolveAddress: vi.fn().mockResolvedValue(ACCOUNT),
    })
    await connector.connect({ chainId: 80002, credentialId: 'cred-2' })
    expect(deps.getAssertion).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 'cred-2' }))
    expect(readSession().credentialId).toBe('cred-2') // session pins what was ASSERTED
  })

  it('sign-in forwards discoverable to the assertion so any device passkey is reachable (issue #849)', async () => {
    rememberCompleteRecord()
    const { connector, deps } = makeConnector({ options: { mode: 'sign-in' } })
    await connector.connect({ chainId: 80002, discoverable: true })
    expect(deps.getAssertion).toHaveBeenCalledWith(expect.objectContaining({ discoverable: true }))
  })

  it('sign-in REFUSES (no session) when the record still cannot transact after repair (FR-005)', async () => {
    // Partial record + ambiguous chain state (two passkey owners): the key
    // cannot be reconstructed, so minting a session would just crash later.
    rememberCredential({ credentialId: 'cred-1', address: ACCOUNT }) // no publicKey
    const ownerBytes = `0x${'1'.repeat(64)}${'2'.repeat(64)}`
    const { connector } = makeConnector({
      options: { mode: 'sign-in' },
      readControllers: vi.fn().mockResolvedValue({
        deployed: true,
        controllers: [
          { index: 0n, kind: 'passkey', ownerBytes },
          { index: 1n, kind: 'passkey', ownerBytes: `0x${'3'.repeat(64)}${'4'.repeat(64)}` },
        ],
      }),
    })
    await expect(connector.connect({ chainId: 80002 })).rejects.toThrow(/recover access/i)
    expect(readSession()).toBeNull()
  })

  it('does not repair from malformed on-chain owner bytes (refuses instead of persisting junk)', async () => {
    rememberCredential({ credentialId: 'cred-1', address: ACCOUNT }) // no publicKey
    const { connector } = makeConnector({
      options: { mode: 'sign-in' },
      readControllers: vi.fn().mockResolvedValue({
        deployed: true,
        controllers: [{ index: 0n, kind: 'passkey', ownerBytes: '0x1234' }], // not 64 bytes
      }),
    })
    await expect(connector.connect({ chainId: 80002 })).rejects.toThrow(/recover access/i)
    const [rec] = knownCredentials()
    expect(rec.publicKey).toBeUndefined() // junk was never persisted
  })

  it('signs in on a network with NO passkey submission support (the lockout fix)', async () => {
    // Chain 63 has no bundler in this mock. Sign-in must still work: it is a WebAuthn ceremony
    // plus a LOCAL address derivation, needing no bundler, EntryPoint or RPC.
    //
    // This used to throw ChainNotSupportedError, which locked members out of their own accounts —
    // the selected network persists, so a member who switched to an unsupported chain returned to
    // find the passkey option refused on the chain they were already on, and switching away
    // required signing in first. Submission support is enforced in buildAccount instead.
    const { connector } = makeConnector()
    const out = await connector.connect({ chainId: 63 })
    expect(out.accounts).toHaveLength(1)
    expect(out.chainId).toBe(63)
  })

  it('derives the same account address whichever chain is connected to (FR-023)', async () => {
    const a = await makeConnector().connector.connect({ chainId: 80002 })
    const b = await makeConnector().connector.connect({ chainId: 63 })
    expect(a.accounts[0]).toBe(b.accounts[0])
  })

  it('silent reconnect restores the session without any ceremony (FR-003)', async () => {
    rememberCompleteRecord()
    writeSession({ address: ACCOUNT, chainId: 80002, credentialId: 'cred-1', loginMethod: 'passkey' })
    const { connector, deps } = makeConnector()
    const out = await connector.connect({ chainId: 80002, isReconnecting: true })
    expect(out.accounts[0].toLowerCase()).toBe(ACCOUNT.toLowerCase())
    expect(deps.createCredential).not.toHaveBeenCalled()
    expect(deps.getAssertion).not.toHaveBeenCalled()
  })

  it('reconnect with no stored session fails (no silent account invention)', async () => {
    const { connector } = makeConnector()
    await expect(connector.connect({ chainId: 80002, isReconnecting: true })).rejects.toThrow(/No passkey session/)
  })

  it('reconnect refuses + clears a session whose credential record cannot transact (spec 045 FR-005)', async () => {
    // Session exists but the book record is incomplete (legacy partial write):
    // restoring it would strand the user with a session that crashes on first
    // action — refuse it honestly instead.
    rememberCredential({ credentialId: 'cred-1', address: ACCOUNT }) // no publicKey
    writeSession({ address: ACCOUNT, chainId: 80002, credentialId: 'cred-1', loginMethod: 'passkey' })
    const { connector } = makeConnector()
    await expect(connector.connect({ chainId: 80002, isReconnecting: true })).rejects.toThrow(/sign in again/)
    expect(readSession()).toBeNull()
  })
})

describe('session lifecycle', () => {
  it('disconnect clears the persisted session atomically (FR-003 sign-out)', async () => {
    const { connector } = makeConnector()
    await connector.connect({ chainId: 80002 })
    expect(readSession()).not.toBeNull()
    await connector.disconnect()
    expect(readSession()).toBeNull()
    expect(await connector.getAccounts()).toEqual([])
    expect(await connector.isAuthorized()).toBe(false)
  })

  it('getAccounts / getChainId / isAuthorized reflect the persisted session', async () => {
    const { connector } = makeConnector()
    await connector.connect({ chainId: 80002 })
    expect((await connector.getAccounts())[0].toLowerCase()).toBe(ACCOUNT.toLowerCase())
    expect(await connector.getChainId()).toBe(80002)
    expect(await connector.isAuthorized()).toBe(true)
  })

  it('switchChain allows an unsupported chain and keeps the session (never a one-way door)', async () => {
    // Refusing here was the other half of the lockout: it made an unsupported chain unreachable
    // AND unleavable. The member keeps their session and every read surface; only the write path
    // is limited, and it says so at the point of action.
    const { connector, config } = makeConnector()
    await connector.connect({ chainId: 80002 })
    await connector.switchChain({ chainId: 63 })
    expect(readSession().chainId).toBe(63)
    expect(config.emitter.emit).toHaveBeenCalledWith('change', { chainId: 63 })
    // …and the member can always switch back.
    await connector.switchChain({ chainId: 80002 })
    expect(readSession().chainId).toBe(80002)
  })

  it('exposes the stable connector id used by walletLabel (vendor-neutral)', () => {
    const { connector } = makeConnector()
    expect(connector.id).toBe(PASSKEY_CONNECTOR_ID)
    expect(connector.type).toBe('passkey')
  })
})

/**
 * Issue #1286 — the chain a passkey session reports.
 *
 * `chains` here is ordered Polygon-FIRST on purpose: that is `src/wagmi.js`'s real order, and
 * `config.chains[0].id` was the old fallback. A passkey account has no wallet to ask its chain,
 * so the connector is the only thing that can answer — and it answered 137 whatever the build
 * was for. On a testnet build every chain-scoped read taken under that session went to mainnet;
 * the wager create path read the wrong KeyRegistry, found nothing, and told the member their
 * opponent had not registered an encryption key.
 */
describe('the provider facade wagmi actually consults', () => {
  /*
   * THE REGRESSION THAT COST EVERY PASSKEY MEMBER THEIR SESSION ON RELOAD.
   *
   * wagmi's `reconnect` filters connectors BEFORE it asks whether they are authorized:
   *
   *     const provider = await connector.getProvider().catch(() => undefined)
   *     if (!provider) continue
   *
   * `getProvider()` returned null, so the passkey connector was skipped every time and the
   * session-restore tests — which have always passed — were never reached in a real browser. The
   * unit test proving the restore works is exactly what made the breakage invisible, so these
   * assert the precondition wagmi actually applies.
   *
   * Carried over from staging when the two branches' passkey suites were merged: they cover the
   * connector's contract with wagmi rather than either branch's chain derivation, so they belong
   * with whichever implementation wins.
   */
  it('exposes a provider at all, because wagmi skips connectors without one', async () => {
    const { connector } = makeConnector()
    const provider = await connector.getProvider()
    expect(provider, 'a null provider makes reconnect unreachable').toBeTruthy()
  })

  it('keeps provider identity stable — wagmi dedupes providers by reference', async () => {
    const { connector } = makeConnector()
    expect(await connector.getProvider()).toBe(await connector.getProvider())
  })

  it('refuses to sign from the facade: this connector holds no key', async () => {
    const { connector } = makeConnector()
    const provider = await connector.getProvider()
    await expect(provider.request({ method: 'eth_sendTransaction', params: [{}] })).rejects.toThrow(
      /submission router/,
    )
    await expect(provider.request({ method: 'personal_sign', params: [] })).rejects.toThrow(
      /submission router/,
    )
  })

  it('answers eth_accounts from the session, so the facade agrees with the connector', async () => {
    rememberCompleteRecord()
    writeSession({ address: ACCOUNT, chainId: 80002, credentialId: 'cred-1', loginMethod: 'passkey' })
    const { connector } = makeConnector()
    const provider = await connector.getProvider()
    expect(await provider.request({ method: 'eth_accounts' })).toEqual(await connector.getAccounts())
  })
})

describe('the chain a session reports (issue #1286)', () => {
  const POLYGON_FIRST = [{ id: 137 }, { id: 80002 }, { id: 63 }]

  it('a testnet-cohort build reports the TESTNET chain, not wagmi default Polygon', async () => {
    build.chainId = 80002
    const { connector } = makeConnector({ chains: POLYGON_FIRST })
    const out = await connector.connect()
    expect(out.chainId).toBe(80002)
    expect(readSession().chainId).toBe(80002)
    expect(await connector.getChainId()).toBe(80002)
  })

  it('reports the build chain before any session exists (nothing to read yet)', async () => {
    build.chainId = 80002
    const { connector } = makeConnector({ chains: POLYGON_FIRST })
    expect(readSession()).toBeNull()
    expect(await connector.getChainId()).toBe(80002)
  })

  it('a mainnet build still reports 137 (the case that was accidentally right)', async () => {
    build.chainId = 137
    const { connector } = makeConnector({ chains: POLYGON_FIRST })
    expect((await connector.connect()).chainId).toBe(137)
  })

  it('an explicitly requested chain still wins over the build default', async () => {
    build.chainId = 80002
    const { connector } = makeConnector({ chains: POLYGON_FIRST })
    expect((await connector.connect({ chainId: 63 })).chainId).toBe(63)
  })

  it('falls back to wagmi’s default when the build chain is not a configured chain — LOUDLY', async () => {
    // wagmi refuses to store an unconfigured chain id, so reporting one would leave the
    // session claiming a chain the config cannot represent. But this fallback is the very
    // state the fix exists to prevent (a non-numeric VITE_NETWORK_ID parses to NaN and lands
    // a testnet build back on Polygon), so it must never happen silently.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    build.chainId = 999999
    const { connector } = makeConnector({ chains: POLYGON_FIRST })
    expect((await connector.connect()).chainId).toBe(137)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('999999'))
    err.mockRestore()
  })

  it('honours a chain the member SWITCHED to, across reloads and the cohort', async () => {
    // The Testnet/Mainnet toggle deliberately crosses the pair, so a member's own switch
    // outranks the build default forever — clamping it here would snap them back.
    build.chainId = 80002
    rememberCompleteRecord()
    const { connector } = makeConnector({ chains: POLYGON_FIRST })
    await connector.connect()
    await connector.switchChain({ chainId: 137 })
    expect(readSession().chainChosen).toBe(true)
    expect(await connector.getChainId()).toBe(137)
    expect((await connector.connect({ isReconnecting: true })).chainId).toBe(137)
  })

  it('re-derives a session written BEFORE this fix instead of trusting its stored 137', async () => {
    // The population that produced the issue: sessions the old default stamped with 137, on a
    // testnet build. The session has no expiry by design, and 137 is a *supported* id so
    // WalletContext's auto-switch leaves it alone — nothing else would ever correct it. A
    // stored chain with no `chainChosen` is ours, not the member's, so it resolves again.
    build.chainId = 80002
    rememberCompleteRecord()
    writeSession({ address: ACCOUNT, chainId: 137, credentialId: 'cred-1', loginMethod: 'passkey' })
    const { connector } = makeConnector({ chains: POLYGON_FIRST })
    expect(await connector.getChainId()).toBe(80002)
    expect((await connector.connect({ isReconnecting: true })).chainId).toBe(80002)
    // …and the stale row is healed, so nothing downstream can read 137 out of storage.
    expect(readSession().chainId).toBe(80002)
    expect(readSession().chainChosen).toBeUndefined()
  })

  it('re-derives when the BUILD moves under an existing session (staging repointed)', async () => {
    build.chainId = 80002
    rememberCompleteRecord()
    const { connector } = makeConnector({ chains: POLYGON_FIRST })
    await connector.connect()
    expect(readSession().chainChosen).toBeUndefined() // nobody chose it — we derived it

    build.chainId = 63 // same build, repointed to Mordor
    const { connector: next } = makeConnector({ chains: POLYGON_FIRST })
    expect(await next.getChainId()).toBe(63)
  })

  it('remembers an explicitly requested chain as a choice', async () => {
    build.chainId = 80002
    const { connector } = makeConnector({ chains: POLYGON_FIRST })
    await connector.connect({ chainId: 63 })
    expect(readSession().chainChosen).toBe(true)
    expect(await connector.getChainId()).toBe(63)
  })
})

/**
 * Cross-device sign-in: the passkey was created on another device (phone) and is synced here, so
 * the ceremony succeeds but this browser has never recorded the account. Previously this failed
 * with "This passkey is not yet linked to an account on this browser."
 *
 * Uses REAL P-256 signatures — the feature is a claim about what the maths permits, so mocking the
 * crypto would test nothing.
 */
describe('cross-device sign-in (fresh browser, synced passkey)', () => {
  const enc = (s) => new TextEncoder().encode(s)
  const concat = (...a) => {
    const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0))
    let o = 0
    for (const x of a) { out.set(x, o); o += x.length }
    return out
  }

  const makeAssertion = (priv, challenge) => {
    const authenticatorData = concat(sha256(enc('fairwins.app')), new Uint8Array([0x05]), new Uint8Array([0, 0, 0, 1]))
    const clientDataJSON = enc(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://fairwins.app' }))
    // prehash:false — an authenticator signs the DIGEST, and @noble/curves v2 prehashes by default.
    const sig = p256.sign(sha256(concat(authenticatorData, sha256(clientDataJSON))), priv, { lowS: false, prehash: false })
    // v2 returns compact BYTES here; v1 returned a Signature instance.
    const sigObj = sig instanceof Uint8Array ? p256.Signature.fromBytes(sig) : sig
    const der = sigObj.toDERRawBytes ? sigObj.toDERRawBytes() : sigObj.toBytes('der')
    return { credentialId: 'cred-phone', authenticatorData, clientDataJSON, signature: new Uint8Array(der) }
  }

  it('resolves the account from the signature and leaves the session able to transact', async () => {
    const priv = p256.utils.randomSecretKey()
    const xy = `0x${Array.from(p256.getPublicKey(priv, false).subarray(1), (b) => b.toString(16).padStart(2, '0')).join('')}`

    let n = 0
    const getAssertion = vi.fn(async () => makeAssertion(priv, `challenge-${n++}`))
    // localStorage is empty (beforeEach clears it) — the fresh-device condition.
    expect(knownCredentials()).toHaveLength(0)

    const { connector } = makeConnector({
      getAssertion,
      deriveAddress: undefined, // use the real local derivation
      resolveAddress: undefined,
      // Spec 104: the derived address is a CANDIDATE now, so this path only yields a session
      // when the chain agrees the key owns it. The double answers as the deployed account does —
      // for ONE address, not for every address it is asked about. Leg A (T-103) enumerates several
      // creation nonces, so a double that says "deployed and owned" to everything now claims the
      // member owns an account at every nonce, and the connector correctly refuses to choose among
      // them. A member has one account here; the double has to say so.
      readControllers: vi.fn(async ({ accountAddress }) =>
        accountAddress === computeAccountAddress({ ownersBytes: [xy], chainId: 80002 })
          ? { deployed: true, controllers: [{ index: 0n, kind: 'passkey', ownerBytes: xy }] }
          : { deployed: false, controllers: [] }
      ),
    })
    const out = await connector.connect({ chainId: 80002, mode: 'sign-in' })

    expect(out.accounts).toHaveLength(1)
    // Two ceremonies: one signature can never identify the key (see lib/passkey/crossDevice.js).
    expect(getAssertion).toHaveBeenCalledTimes(2)

    // The recovered key is persisted, so the very next action can sign without another recovery.
    const record = knownCredentials().find((c) => c.credentialId === 'cred-phone')
    expect(publicKeyToOwnerBytes(record.publicKey)).toBe(xy)
    expect(isTransactComplete(record)).toBe(true)

    // …and the address is exactly what that key derives.
    expect(out.accounts[0].toLowerCase()).toBe(
      computeAccountAddress({ ownersBytes: [xy], nonce: 0n }).toLowerCase()
    )
  })

  it('refuses (no session) rather than guessing when the two confirmations disagree', async () => {
    const a = p256.utils.randomSecretKey()
    const b = p256.utils.randomSecretKey()
    let n = 0
    const getAssertion = vi.fn(async () => makeAssertion(n++ === 0 ? a : b, `challenge-${n}`))

    const { connector } = makeConnector({ getAssertion, deriveAddress: undefined, resolveAddress: undefined })
    await expect(connector.connect({ chainId: 80002, mode: 'sign-in' })).rejects.toThrow()
    expect(readSession()).toBeNull()
  })
})

describe('cross-device: the passkey belongs to a DIFFERENT account', () => {
  const enc = (s) => new TextEncoder().encode(s)
  const concat = (...a) => {
    const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0))
    let o = 0
    for (const x of a) { out.set(x, o); o += x.length }
    return out
  }
  const makeAssertion = (priv, challenge) => {
    const authenticatorData = concat(sha256(enc('fairwins.app')), new Uint8Array([0x05]), new Uint8Array([0, 0, 0, 1]))
    const clientDataJSON = enc(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://fairwins.app' }))
    // See the note above: v2 prehashes by default and returns compact bytes.
    const sig = p256.sign(sha256(concat(authenticatorData, sha256(clientDataJSON))), priv, { lowS: false, prehash: false })
    const sigObj = sig instanceof Uint8Array ? p256.Signature.fromBytes(sig) : sig
    return {
      credentialId: 'cred-phone',
      authenticatorData,
      clientDataJSON,
      signature: new Uint8Array(sigObj.toDERRawBytes ? sigObj.toDERRawBytes() : sigObj.toBytes('der')),
    }
  }

  it('refuses when the derived account is deployed but does not list this passkey', async () => {
    // The passkey was added as a SECOND controller to a pre-existing account, so its own key does
    // not derive that account's address. Handing back the derived address would show the member an
    // account that is not theirs.
    //
    // Spec 104 changed what the refusal SAYS. It used to read "this passkey controls an account
    // that this browser cannot identify" — which asserts a fact the app does not have: it does not
    // know the passkey controls anything. The honest statement is that nothing found on this chain
    // lists the key, plus the reason the search could miss one (a passkey added after creation),
    // plus the way out (name the account).
    const priv = p256.utils.randomSecretKey()
    let n = 0
    const { connector } = makeConnector({
      getAssertion: vi.fn(async () => makeAssertion(priv, `c-${n++}`)),
      deriveAddress: undefined,
      resolveAddress: undefined,
      readControllers: vi.fn().mockResolvedValue({
        deployed: true,
        controllers: [{ index: 0n, kind: 'passkey', ownerBytes: `0x${'9'.repeat(128)}` }],
      }),
    })
    await expect(connector.connect({ chainId: 80002, mode: 'sign-in' })).rejects.toThrow(
      /no account on this network lists this passkey/i
    )
    expect(readSession()).toBeNull()
  })

  it('an unreachable chain refuses as UNVERIFIED, and says so in words that are not "no account"', async () => {
    // DELIBERATE INVERSION (spec 104, US2). This used to sign in on the derived address, on the
    // reasoning that sign-in must never require a working RPC. That reasoning still holds for the
    // paths it was written for — a returning member on their own browser resolves from the local
    // record with no chain read at all, and that test sits above unchanged. It does NOT hold here,
    // because this is precisely the case where the app does not know the answer: no local record,
    // an address computed from an assumption, and no way to check it. Proceeding anyway is how a
    // member whose passkey was added to an existing account got signed into an empty new one and
    // read it as their money being gone.
    //
    // So the chain read is required exactly where its absence would mean guessing, and the refusal
    // stays retryable and honest: an unreachable network is not evidence of an absent account, and
    // the message must never let a member conclude they have none.
    const priv = p256.utils.randomSecretKey()
    let n = 0
    const { connector } = makeConnector({
      getAssertion: vi.fn(async () => makeAssertion(priv, `c-${n++}`)),
      deriveAddress: undefined,
      resolveAddress: undefined,
      readControllers: vi.fn().mockRejectedValue(new Error('RPC down')),
    })
    const err = await connector.connect({ chainId: 80002, mode: 'sign-in' }).catch((e) => e)
    expect(err.name).toBe('AccountUnresolved')
    expect(err.outcome).toBe('unverified')
    expect(err.message).toMatch(/does not mean you have no account/i)
    expect(readSession()).toBeNull()
  })

  it('an UNDEPLOYED derived address never becomes the session — the regression this feature exists for', async () => {
    // Before spec 104 this signed the member in on a brand-new empty account, silently. It is the
    // quietest of the failure shapes and the one a member reads as "my money is gone", so the
    // assertion is not merely that it throws: the address must not appear anywhere in the outcome.
    const priv = p256.utils.randomSecretKey()
    let n = 0
    const { connector } = makeConnector({
      getAssertion: vi.fn(async () => makeAssertion(priv, `c-${n++}`)),
      deriveAddress: undefined,
      resolveAddress: undefined,
      readControllers: vi.fn().mockResolvedValue({ deployed: false, controllers: [] }),
    })
    const err = await connector.connect({ chainId: 80002, mode: 'sign-in' }).catch((e) => e)
    expect(err.name).toBe('AccountUnresolved')
    expect(err.outcome).toBe('none-found')
    expect(err.address).toBeNull()
    expect(readSession()).toBeNull()
  })

  it('offers the COUNTERFACTUAL address rather than refusing a member whose account is simply not deployed yet', async () => {
    // The case the blunt version of this rule would have broken, and it is not rare: a member who
    // signed up on another device and has not spent yet has a perfectly good account that holds no
    // code. Refusing them locks out every new member syncing a second device — and they cannot type
    // an address they have never been shown. So the address is OFFERED, labelled as not-yet-used,
    // never silently opened.
    const priv = p256.utils.randomSecretKey()
    const xy = `0x${Array.from(p256.getPublicKey(priv, false).subarray(1), (b) => b.toString(16).padStart(2, '0')).join('')}`
    let n = 0
    const { connector } = makeConnector({
      getAssertion: vi.fn(async () => makeAssertion(priv, `c-${n++}`)),
      deriveAddress: undefined,
      resolveAddress: undefined,
      readControllers: vi.fn().mockResolvedValue({ deployed: false, controllers: [] }),
    })
    const err = await connector.connect({ chainId: 80002, mode: 'sign-in' }).catch((e) => e)
    expect(err.name).toBe('AccountUnresolved')
    // It is the same deterministic address their first device showed them — continuing to it opens
    // no second account, which is what makes offering it safe.
    expect(err.counterfactualAddress.toLowerCase()).toBe(
      computeAccountAddress({ ownersBytes: [xy], nonce: 0n }).toLowerCase()
    )
    expect(readSession()).toBeNull() // offered, NOT taken
  })

  it('opens the counterfactual account only when the member accepted it', async () => {
    const priv = p256.utils.randomSecretKey()
    const xy = `0x${Array.from(p256.getPublicKey(priv, false).subarray(1), (b) => b.toString(16).padStart(2, '0')).join('')}`
    let n = 0
    const { connector } = makeConnector({
      getAssertion: vi.fn(async () => makeAssertion(priv, `c-${n++}`)),
      deriveAddress: undefined,
      resolveAddress: undefined,
      readControllers: vi.fn().mockResolvedValue({ deployed: false, controllers: [] }),
    })
    const out = await connector.connect({ chainId: 80002, mode: 'sign-in', acceptCounterfactual: true })
    expect(out.accounts[0].toLowerCase()).toBe(
      computeAccountAddress({ ownersBytes: [xy], nonce: 0n }).toLowerCase()
    )
  })

  it('does NOT offer a counterfactual when the chain was unreadable — that is not a new account', async () => {
    // An unreachable chain says nothing about whether an account exists, so offering "continue to a
    // new one" here would invite a member with a real account to walk away from it.
    const priv = p256.utils.randomSecretKey()
    let n = 0
    const { connector } = makeConnector({
      getAssertion: vi.fn(async () => makeAssertion(priv, `c-${n++}`)),
      deriveAddress: undefined,
      resolveAddress: undefined,
      readControllers: vi.fn().mockRejectedValue(new Error('RPC down')),
    })
    const err = await connector.connect({ chainId: 80002, mode: 'sign-in' }).catch((e) => e)
    expect(err.outcome).toBe('unverified')
    expect(err.counterfactualAddress).toBeNull()
  })

  it('recovers on an address the MEMBER supplies, once the chain confirms the key owns it', async () => {
    // US3. The address is a hint that reaches the same confirmation a searched candidate does —
    // which is what stops "type any address" from being a way into somebody else's account.
    const priv = p256.utils.randomSecretKey()
    const xy = `0x${Array.from(p256.getPublicKey(priv, false).subarray(1), (b) => b.toString(16).padStart(2, '0')).join('')}`
    const NAMED = '0x00000000000000000000000000000000000BEEF1'
    let n = 0
    const readControllers = vi.fn(async ({ accountAddress }) => {
      // Only the named account lists the key; the derived one does not exist. That is the whole
      // point of this path — it reaches an account no derivation could have found.
      if (accountAddress.toLowerCase() === NAMED.toLowerCase()) {
        return { deployed: true, controllers: [{ index: 2n, kind: 'passkey', ownerBytes: xy }] }
      }
      return { deployed: false, controllers: [] }
    })
    const { connector } = makeConnector({
      getAssertion: vi.fn(async () => makeAssertion(priv, `c-${n++}`)),
      deriveAddress: undefined,
      resolveAddress: undefined,
      readControllers,
    })
    const out = await connector.connect({ chainId: 80002, mode: 'sign-in', accountAddress: NAMED })
    expect(out.accounts[0].toLowerCase()).toBe(NAMED.toLowerCase())
    // The slot the CHAIN reported is what gets recorded — never 0 by assumption (spec 045 FR-009).
    expect(knownCredentials().find((c) => c.credentialId === 'cred-phone').ownerIndex).toBe(2)
  })

  it('refuses an address the member supplies that the key does not control', async () => {
    // The security property of US3 is this NEGATIVE. A test suite that only proves the happy path
    // has not tested the feature.
    const priv = p256.utils.randomSecretKey()
    let n = 0
    const { connector } = makeConnector({
      getAssertion: vi.fn(async () => makeAssertion(priv, `c-${n++}`)),
      deriveAddress: undefined,
      resolveAddress: undefined,
      readControllers: vi.fn().mockResolvedValue({
        deployed: true,
        controllers: [{ index: 0n, kind: 'passkey', ownerBytes: `0x${'9'.repeat(128)}` }],
      }),
    })
    const err = await connector
      .connect({ chainId: 80002, mode: 'sign-in', accountAddress: '0x00000000000000000000000000000000000BEEF1' })
      .catch((e) => e)
    expect(err.name).toBe('AccountUnresolved')
    expect(err.outcome).toBe('not-controller')
    // Named back to the member: "that account exists, this passkey does not control it" is a
    // legible refusal where a bare no is not.
    expect(err.address).toBe('0x00000000000000000000000000000000000BEEF1')
    expect(readSession()).toBeNull()
  })
})
