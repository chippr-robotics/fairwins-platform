/**
 * FairWins passkey connector (spec 041, T024) — a first-class wagmi connector
 * beside `injected` and `walletConnect`, per contracts/passkey-connector.md.
 *
 * The connector owns: capability detection (FR-004), the sign-up / sign-in
 * ceremonies (via lib/passkey/credentials), session persistence with NO
 * self-expiry (FR-003, clarification Q4), silent reconnect, and an EIP-1193
 * facade whose write path routes through the submission router. Identity
 * semantics (roles, screening) never depend on this connector type (FR-002).
 */

import { createConnector } from 'wagmi'
import { getAddress } from 'viem'
import {
  detectCapability,
  createCredential,
  getAssertion,
  rememberCredential,
  upsertCredential,
  knownCredentials,
  isTransactComplete,
  hasExistingCredential,
  nameCredentialForAccount,
} from '../lib/passkey/credentials'
import { deriveAddress, publicKeyToOwnerBytes, readControllers } from '../lib/passkey/smartAccount'
import { getCurrentChainId } from '../config/networks'

export const PASSKEY_CONNECTOR_ID = 'fairwinsPasskey'
const SESSION_KEY = 'fairwins.passkey.session.v1'

/** Methods the facade refuses: this connector holds no key (see getProvider). */
const PASSKEY_WRITE_METHODS = new Set([
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
])

/**
 * The chain a passkey session reports when nothing else names one (issue #1286).
 *
 * NOT `config.chains[0].id`. That list is ordered Polygon-first in `wagmi.js` so 137 is
 * wagmi's default chain, and using it here made EVERY passkey session claim 137 whatever
 * the build was for. A classic wallet is unaffected because an injected connector reports
 * its own chain; a passkey account has no wallet to ask, so the connector is the only thing
 * that can answer — and it was answering with a constant.
 *
 * On a mainnet build 137 was accidentally right, which is why it went unnoticed. On a
 * testnet-cohort build it is a read across the testnet/mainnet boundary that constitution
 * III forbids outright, and it reached members as a false statement: the wager create path
 * looked up the opponent's X25519 key in the WRONG chain's KeyRegistry, found nothing, and
 * told the member their opponent had not registered a key.
 *
 * `getCurrentChainId()` is the build's own home network (`VITE_NETWORK_ID`, else
 * `PRIMARY_CHAIN_ID`) and the same value `buildIsTestnet()` derives the cohort from — so this
 * stays truthful per build without a second literal `137` to drift, exactly as
 * `membershipChainId()` avoids one.
 *
 * Falls back to wagmi's default only when the build chain is not registered in `chains`:
 * wagmi refuses to store an unconfigured chain id, so reporting one would leave the session
 * claiming a chain the config cannot represent. That fallback is the exact state this function
 * exists to prevent, and only a broken build can reach it (a non-numeric `VITE_NETWORK_ID` parses
 * to `NaN`; every id in `NETWORKS` is registered in `wagmi.js#chains`), so it says so loudly
 * rather than silently putting a testnet build back on Polygon.
 */
function buildDefaultChainId(config) {
  const target = getCurrentChainId()
  if (config.chains?.some((c) => c.id === target)) return target
  const fallback = config.chains?.[0]?.id
  console.error(
    `[passkey] Build chain ${target} is not a configured wagmi chain — passkey sessions will ` +
      `report ${fallback} instead, which may cross the testnet/mainnet cohort boundary. ` +
      'Check VITE_NETWORK_ID (issue #1286).'
  )
  return fallback
}

/**
 * The chain THIS session reports — and the reason a session carries `chainChosen` (issue #1286).
 *
 * Only `switchChain` sets that flag, so it marks a chain the MEMBER named. Everything else is a
 * chain we derived, and a derived chain must re-derive on every load rather than freeze into the
 * session: the session has no expiry BY DESIGN (clarification Q4), so a stored default outlives
 * the build that minted it forever. Two cases make that concrete — a member who signed in before
 * this fix has `{"chainId":137}` on disk from the old `config.chains[0].id` default and would keep
 * reading mainnet on a testnet build (`WalletContext`'s auto-switch will not correct it either,
 * because 137 is a *supported* id), and a staging build repointed to another testnet would never
 * reach anyone already signed in.
 *
 * A chosen chain is honoured verbatim, including across the cohort: the Testnet/Mainnet toggle
 * deliberately crosses the pair, so clamping a member's own switch would snap them back.
 */
function sessionChainId(session, config) {
  if (session?.chainChosen && session.chainId != null) return session.chainId
  return buildDefaultChainId(config)
}

export function readSession(storage = globalThis.localStorage) {
  try {
    return JSON.parse(storage.getItem(SESSION_KEY) || 'null')
  } catch {
    return null
  }
}

export function writeSession(session, storage = globalThis.localStorage) {
  if (session === null) storage.removeItem(SESSION_KEY)
  else storage.setItem(SESSION_KEY, JSON.stringify(session))
}

/**
 * wagmi connector factory. `options`:
 *   mode          'sign-up' | 'sign-in' (the surface sets it per user choice)
 *   deps          injectable ceremonies/clients for tests
 */
export function passkeyConnector(options = {}) {
  const deps = options.deps ?? {}

  return createConnector((config) => {
  /*
   * THE EIP-1193 FACADE, AND WHY IT MAY NEVER BE NULL AGAIN.
   *
   * wagmi's `reconnect` skips any connector whose provider is falsy, BEFORE it ever asks whether
   * the connector is authorized:
   *
   *     const provider = await connector.getProvider().catch(() => undefined)
   *     if (!provider) continue
   *
   * `getProvider` used to answer `deps.provider ?? null`, so with no provider injected wagmi
   * silently skipped the passkey connector on every reconnect and every passkey member was signed
   * out by a page reload — with a complete session and credential record sitting in storage, and
   * FR-003's "silent restore, no ceremony on reload" never once happening in a browser. Nothing
   * reported it: wagmi swallows reconnect failures, and the connector's own unit tests exercise
   * `connect({ isReconnecting: true })` directly, which works.
   *
   * Built ONCE per connector instance, because wagmi also dedupes providers by reference
   * (`providers.some((x) => x === provider)`) — a fresh object per call makes two connectors look
   * distinct when they are not.
   *
   * Reads proxy the configured transport. Writes are refused here BY DESIGN: this connector holds
   * no key, and a passkey transaction is a UserOp assembled by the submission router.
   *
   * The chain it reports comes from `sessionChainId`, not a stored value taken on trust, so the
   * facade and `getChainId()` cannot disagree about which chain the session is on (#1286).
   */
  const provider = deps.provider ?? {
    async request({ method, params } = {}) {
      if (PASSKEY_WRITE_METHODS.has(method)) {
        throw new Error(
          `${method} is not signed by the passkey connector — passkey writes are assembled by the ` +
            'submission router (lib/passkey/submission), not sent as a raw transaction.',
        )
      }
      const session = readSession(deps.storage)
      const chainId = sessionChainId(session, config)
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
        return session ? [getAddress(session.address)] : []
      }
      if (method === 'eth_chainId') return `0x${Number(chainId).toString(16)}`
      return config.getClient({ chainId }).request({ method, params })
    },
    on() {},
    removeListener() {},
  }

  return {
    id: PASSKEY_CONNECTOR_ID,
    name: 'Passkey',
    type: 'passkey',

    /** Capability detection — the login surface hides/disables accordingly (FR-004). */
    async setup() {
      this.capability = await (deps.detectCapability ?? detectCapability)()
    },

    async connect({ chainId, isReconnecting, credentialId, discoverable, accountAddress, acceptCounterfactual, mode: requestedMode } = {}) {
      const targetChain = chainId ?? buildDefaultChainId(config)
      // NO network gate here, deliberately. Signing in is a WebAuthn ceremony plus a local address
      // derivation — it needs no bundler, no EntryPoint and no RPC. Gating it on submission support
      // locked members out: selecting a network without a bundler persisted in the session, and on
      // the next visit the passkey option was refused on the very chain they were already on, with
      // no way to switch back because switching required being signed in. Submission support is
      // enforced where it actually applies, in buildAccount (lib/passkey/smartAccount.js).

      // Silent restore: no ceremony on reload (FR-003). Transactions still
      // require a fresh ceremony each (FR-008) — the session is read-state only.
      // Spec 045 FR-005: only restore sessions the browser can actually sign
      // for — a session whose credential record is missing or incomplete is
      // cleared (honest sign-out) instead of crashing on the first action.
      if (isReconnecting) {
        const session = readSession(deps.storage)
        if (!session) throw new Error('No passkey session to restore')
        const record = knownCredentials(deps.storage).find((c) => c.credentialId === session.credentialId)
        if (!isTransactComplete(record)) {
          writeSession(null, deps.storage)
          throw new Error('Passkey session is unusable on this browser — sign in again.')
        }
        // Re-resolve rather than trust the stored id: only a member's own switch survives a
        // reload (see sessionChainId). Heal the row too, so nothing downstream can read a
        // stale chain straight out of storage.
        const chosen = chainId != null || session.chainChosen === true
        const restored = chainId ?? sessionChainId(session, config)
        if (session.chainId !== restored || Boolean(session.chainChosen) !== chosen) {
          writeSession({ ...session, chainId: restored, ...(chosen && { chainChosen: true }) }, deps.storage)
        }
        return { accounts: [getAddress(session.address)], chainId: restored }
      }

      let credential
      let address
      const mode =
        requestedMode ?? options.mode ?? (hasExistingCredential(deps.storage) ? 'sign-in' : 'sign-up')

      if (mode === 'sign-up') {
        credential = await (deps.createCredential ?? createCredential)({ label: options.label, deps })
        const ownersBytes = [publicKeyToOwnerBytes(credential.publicKey)]
        address = await (deps.deriveAddress ?? deriveAddress)({ chainId: targetChain, ownersBytes, deps })
        rememberCredential({ ...credential, address }, deps.storage)
        // The address exists only now — it is derived from the key the ceremony
        // just produced — so this is the first moment the saved passkey can be
        // named after the account it signs for. Cosmetic and non-throwing.
        await (deps.nameCredential ?? nameCredentialForAccount)({
          userId: credential.userId,
          address,
          deps,
        })
      } else {
        // Sign-in: pinned to the account the user picked in the in-app chooser
        // when `credentialId` is set; otherwise getAssertion offers the whole
        // local book via allowCredentials so the platform must show a chooser
        // (spec 045 US3 — the app never guesses, and neither may the browser).
        // `discoverable` (issue #849) widens that to a bare discoverable request
        // so passkeys this browser never recorded — but that live on the device
        // — become reachable from "Use a different passkey…".
        const assertion = await (deps.getAssertion ?? getAssertion)({
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          credentialId,
          discoverable,
          deps,
        })
        credential = { credentialId: assertion.credentialId }
        // Passing the assertion through enables cross-device sign-in: with no local record, the
        // public key is recovered from this very signature rather than the member being told the
        // passkey "does not have an account on this device".
        const resolved = await (deps.resolveAccount ?? resolveAccountForCredential)({
          credentialId: assertion.credentialId,
          chainId: targetChain,
          assertion,
          // Spec 104: set when the member is recovering by naming their account. It is a hint the
          // chain still has to agree with — it never becomes the session address on its own.
          accountAddress,
          // …and this is the member accepting a not-yet-deployed account of their own, after being
          // shown what it is. Never defaulted on.
          acceptCounterfactual,
          deps,
        })
        address = resolved.address
        // Keep the book transact-complete (spec 045 FR-005): refresh the
        // record for the asserted credential. The key comes from cross-device
        // recovery when that ran, else from the chain when it is unambiguous.
        // Heal the platform's label for a passkey created before it carried the
        // account: the user handle comes back on the assertion even when this
        // browser never stored it.
        await (deps.nameCredential ?? nameCredentialForAccount)({
          userId: assertion.userHandle,
          address,
          deps,
        })
        const record = upsertCredential(
          {
            credentialId: assertion.credentialId,
            address,
            userId: assertion.userHandle,
            publicKey:
              resolved.publicKey ??
              (await repairPublicKey({ credentialId: assertion.credentialId, address, chainId: targetChain, deps })),
            // The slot the CHAIN reported, when a resolution confirmed one. Signatures need the
            // real index (spec 045 FR-009); recording it here saves the next sign-in the read and
            // keeps a rotated account from being signed for at a stale slot.
            ownerIndex: resolved.ownerIndex,
          },
          deps.storage
        )
        // FR-005: sign-in must leave the session able to transact. If the
        // record still lacks its key (and the chain couldn't disambiguate),
        // refuse honestly now instead of minting a session that fails on its
        // first action.
        if (!isTransactComplete(record)) {
          throw new Error(
            'This browser cannot sign for that account yet — its passkey record is incomplete. ' +
              'Use a linked wallet to recover access, or sign in on the browser where this passkey was created.'
          )
        }
      }

      const session = {
        address,
        chainId: targetChain,
        // Marked only when the CALLER named the chain. Without the flag this row is a
        // derived default that re-resolves on the next load — which is what keeps the
        // build, not a months-old snapshot, deciding the chain (issue #1286).
        ...(chainId != null && { chainChosen: true }),
        credentialId: credential.credentialId,
        loginMethod: 'passkey',
        // No expiry field BY DESIGN — persists until explicit sign-out (clarification Q4).
      }
      writeSession(session, deps.storage)
      return { accounts: [getAddress(address)], chainId: targetChain }
    },

    /** Full FR-003 sign-out: the session row is removed atomically. */
    async disconnect() {
      writeSession(null, deps.storage)
    },

    async getAccounts() {
      const session = readSession(deps.storage)
      return session ? [getAddress(session.address)] : []
    },

    async getChainId() {
      // A chain the member SWITCHED to is honoured verbatim; a chain we derived is derived
      // again, so it tracks the build instead of the day the session was created.
      return sessionChainId(readSession(deps.storage), config)
    },

    async isAuthorized() {
      return readSession(deps.storage) !== null
    },

    async switchChain({ chainId }) {
      // Switching to a chain without passkey submission is ALLOWED: the member keeps their session
      // and every read surface (portfolio, receive, history) keeps working. Refusing here was half
      // of the lockout — it made an unsupported chain a one-way door. The write path discloses the
      // limitation honestly at the point of action instead.
      const session = readSession(deps.storage)
      // `chainChosen` is written HERE and nowhere else: this is the one path where a member
      // actually names a chain, and the flag is what makes their choice outrank the build
      // default on every later load (issue #1286).
      if (session) writeSession({ ...session, chainId, chainChosen: true }, deps.storage)
      const chain = config.chains.find((c) => c.id === chainId)
      config.emitter.emit('change', { chainId })
      return chain
    },

    async getProvider() {
      // NEVER null — see the facade above. wagmi's reconnect drops any connector without one.
      return provider
    },

    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {
      writeSession(null, deps.storage)
    },
  }
  })
}

/**
 * Best-effort public-key repair for a sign-in whose local record lost its
 * P-256 key (legacy/partial writes). The chain stores every passkey owner's
 * key as its owner bytes — when the account has exactly ONE passkey
 * controller the mapping is unambiguous and the record can be healed, making
 * "sign out and sign back in" an actual fix for CredentialRecordIncomplete.
 * Ambiguous (multi-passkey) or unreachable accounts return undefined: the
 * upsert then simply keeps whatever the record already had.
 */
async function repairPublicKey({ credentialId, address, chainId, deps }) {
  try {
    const existing = knownCredentials(deps.storage).find((c) => c.credentialId === credentialId)
    if (existing?.publicKey?.x && existing?.publicKey?.y) return undefined // nothing to repair
    const { controllers } = await (deps.readControllers ?? readControllers)({
      chainId,
      accountAddress: address,
      deps,
    })
    const passkeyOwners = controllers.filter((c) => c.kind === 'passkey')
    if (passkeyOwners.length !== 1) return undefined
    const bytes = passkeyOwners[0].ownerBytes
    // Only the exact 64-byte x||y encoding is a P-256 key — persisting a
    // malformed slice would pass isTransactComplete yet break signing later.
    if (typeof bytes !== 'string' || !/^0x[0-9a-fA-F]{128}$/.test(bytes)) return undefined
    return { x: `0x${bytes.slice(2, 66)}`, y: `0x${bytes.slice(66, 130)}` }
  } catch {
    return undefined
  }
}

/**
 * Raised when a passkey's account could NOT be confirmed on chain (spec 104).
 *
 * Deliberately not a `CeremonyCancelled`: ConnectModal resets the step for those without showing
 * the message, which would swallow the one thing the member needs to read. Carries the resolver's
 * outcome so the surface can offer the right next step — retry for `unverified`, recover by
 * address for `none-found` — instead of rendering one dead end for both.
 */
export class AccountUnresolved extends Error {
  constructor(resolution, { credentialId, counterfactualAddress } = {}) {
    super(resolution?.reason || 'We could not confirm which account this passkey controls.')
    this.name = 'AccountUnresolved'
    this.outcome = resolution?.outcome
    this.reason = resolution?.reason
    this.address = resolution?.address ?? null
    this.credentialId = credentialId ?? null
    /**
     * The address this key's OWN account would have, present only on `none-found`.
     *
     * Not an account the app found — nothing is deployed there. It is offered because a member who
     * signed up on another device and has not yet transacted is in exactly this state, and their
     * account is legitimately counterfactual: the address is a deterministic function of the key,
     * so it is the same address their first device showed them. Refusing them outright would lock
     * out every member who signs up and does not immediately spend, which is not what US2 asks for
     * — US2 forbids presenting an unverified address *as though it were theirs*, and the fix for
     * that is saying what it is, not withholding it.
     */
    this.counterfactualAddress = counterfactualAddress ?? null
  }
}

/**
 * Resolve a credential to its account address.
 *
 * Order: this browser's own record (fast, and already verified once), then — for a passkey this
 * browser has never seen — the CHAIN.
 *
 * What changed in spec 104 is the last step. This function used to derive an address from the
 * recovered key on the assumption that the key was the account's sole initial owner, read the
 * chain to sanity-check it, and return the derived address anyway when the chain said nothing was
 * deployed there. For a member whose passkey was added to an existing account — or who simply had
 * a second account — that signed them into a brand-new empty one, with no error and no clue: the
 * app showed them a zero balance and called it their wallet.
 *
 * So derivation now produces a CANDIDATE that must be confirmed, and an address leaves this
 * function only when the chain agreed. Where an address cannot be confirmed the caller gets an
 * {@link AccountUnresolved} carrying the outcome, and the member gets a recovery path — never a
 * session on an account nobody verified.
 *
 * Derivation survives untouched where it is truthful: creating a NEW account (`mode: 'sign-up'`),
 * which the member asked for explicitly.
 */
export async function resolveAccountForCredential({ credentialId, chainId, assertion, accountAddress, acceptCounterfactual = false, deps = {} }) {
  const { knownCredentials } = await import('../lib/passkey/credentials')
  const local = knownCredentials(deps.storage).find((c) => c.credentialId === credentialId)
  if (local?.address) return { address: local.address, publicKey: local.publicKey }
  if (local?.publicKey) {
    // A record this browser wrote is a remembered fact, not a guess: it was written when the
    // account was created here, so the sole-initial-owner assumption genuinely holds. Kept LOCAL
    // and chain-free on purpose — sign-in must not require a working RPC, which is the lockout
    // this path was built to fix.
    const address = await deriveAddress({
      chainId,
      ownersBytes: [publicKeyToOwnerBytes(local.publicKey)],
      deps,
    })
    return { address, publicKey: local.publicKey }
  }

  // Nothing local — the CROSS-DEVICE case: the passkey is synced from another device (iCloud
  // Keychain / Google Password Manager) so the ceremony succeeds, but this browser has never seen
  // the account. Recover the public key from the signature the member just produced; that is the
  // only identity the chain can be asked about, and it also leaves the session able to transact
  // without a further ceremony. Needs one extra confirmation because a single signature cannot
  // identify a key unambiguously — see lib/passkey/crossDevice.js.
  if (assertion) {
    const { recoverPublicKey } = await import('../lib/passkey/crossDevice')
    const { publicKey, ownerBytes } = await (deps.recoverPublicKey ?? recoverPublicKey)({
      first: assertion,
      credentialId,
      deps,
    })

    const { resolveAccounts, verifyAccountForKey, isResolved } = await import('../lib/passkey/accountLookup')

    // An address the MEMBER typed is a hint like any other: it takes the same confirmation a
    // searched candidate takes, and where it came from never shortens the check. Its distinct
    // value is that it can name an account no derivation could reach — one this passkey was added
    // to after creation.
    const resolution = accountAddress
      ? await (deps.verifyAccountForKey ?? verifyAccountForKey)({
          ownerBytes, address: accountAddress, chainId, deps,
        })
      : await (deps.resolveAccounts ?? resolveAccounts)({ ownerBytes, chainId, deps })

    if (!isResolved(resolution)) {
      // `none-found` means no DEPLOYED account lists this key — which is also the honest reading of
      // a brand-new account that has never been used on chain. The member is told which it is and
      // chooses; `acceptCounterfactual` is that choice coming back, never an app-side assumption.
      const counterfactualAddress =
        resolution.outcome === 'none-found'
          ? await deriveAddress({ chainId, ownersBytes: [ownerBytes], deps })
          : null
      if (acceptCounterfactual && counterfactualAddress) {
        return { address: counterfactualAddress, publicKey, counterfactual: true }
      }
      throw new AccountUnresolved(resolution, { credentialId, counterfactualAddress })
    }

    // Release 1 confirms at most one account. When discovery lands (spec 104 Release 2) more than
    // one is possible and the MEMBER picks — the connector must not, which is why this asserts
    // rather than taking [0] silently.
    if (resolution.accounts.length > 1) {
      throw new AccountUnresolved(
        { outcome: 'resolved', reason: 'Several accounts list this passkey. Choose the one to open.' },
        { credentialId }
      )
    }
    const account = resolution.accounts[0]
    return { address: account.address, publicKey, ownerIndex: account.ownerIndex }
  }

  throw new AccountUnresolved(
    {
      outcome: 'none-found',
      reason:
        'This passkey is not yet linked to an account on this browser. Enter your account address to relink.',
    },
    { credentialId }
  )
}

/** Address-only form of {@link resolveAccountForCredential}. */
export async function resolveAddressForCredential({ credentialId, chainId, assertion, accountAddress, acceptCounterfactual, deps = {} }) {
  const { address } = await resolveAccountForCredential({
    credentialId, chainId, assertion, accountAddress, acceptCounterfactual, deps,
  })
  return address
}
