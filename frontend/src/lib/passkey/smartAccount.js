/**
 * Smart-account layer for passkey wallets (spec 041, T018).
 *
 * Thin orchestration over viem's account-abstraction module (verified T002:
 * toWebAuthnAccount / toCoinbaseSmartAccount / createBundlerClient) bound to
 * the FairWins-deployed deterministic factory. All addresses come from the
 * synced contract config (constitution V) — never hardcoded.
 *
 * The account address is a pure function of (initial owners, nonce) and the
 * factory address, which is identical on every platform network (FR-023) —
 * so `deriveAddress` is chain-independent by construction.
 */

import {
  http,
  fallback,
  createPublicClient,
  encodeFunctionData,
  encodeAbiParameters,
  decodeAbiParameters,
  getContractAddress,
  keccak256,
  parseAbi,
} from 'viem'
import {
  toWebAuthnAccount,
  toCoinbaseSmartAccount,
  createBundlerClient,
  createPaymasterClient,
} from 'viem/account-abstraction'
import { getNetwork } from '../../config/networks'
import { resolveRpcEndpoints } from '../network/rpcEndpoints'
import { getContractAddressForChain } from '../../config/contracts'
import { CeremonyCancelled, isTransactComplete } from './credentials'
import { bundlerTransport } from './bundlerTransport.js'

export class ChainNotSupportedError extends Error {
  constructor(chainId) {
    super(`Passkey accounts are not yet available on this network (chain ${chainId}).`)
    this.name = 'ChainNotSupportedError'
    this.chainId = chainId
  }
}

export class LastControllerError extends Error {
  constructor() {
    super('An account must always keep at least one controller.')
    this.name = 'LastControllerError'
  }
}

/**
 * Typed error: the local record for this passkey is missing the fields the
 * signer needs (spec 045, FR-006). Historically this surfaced as an internal
 * "Cannot read properties of undefined (reading 'id')" from inside the
 * WebAuthn signer — now it's an actionable message before any ceremony.
 */
export class CredentialRecordIncomplete extends Error {
  constructor() {
    super(
      'This browser’s record of your passkey is incomplete, so it can’t sign transactions. ' +
        'Sign out and sign back in with your passkey; if that doesn’t help, use a linked wallet to recover access.'
    )
    this.name = 'CredentialRecordIncomplete'
  }
}

/** Typed error: the passkey no longer controls the account (removed on-chain). */
export class CredentialNotControllerError extends Error {
  constructor() {
    super(
      'This passkey is no longer a controller of the account. Sign in with another controller ' +
        '(a different passkey or a linked wallet) to manage it.'
    )
    this.name = 'CredentialNotControllerError'
  }
}

const FACTORY_ABI = parseAbi([
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
  'function createAccount(bytes[] owners, uint256 nonce) payable returns (address)',
])

export const ACCOUNT_ABI = parseAbi([
  'function addOwnerAddress(address owner)',
  'function addOwnerPublicKey(bytes32 x, bytes32 y)',
  'function removeOwnerAtIndex(uint256 index, bytes owner)',
  'function ownerAtIndex(uint256 index) view returns (bytes)',
  'function ownerCount() view returns (uint256)',
  'function nextOwnerIndex() view returns (uint256)',
  'function isOwnerAddress(address owner) view returns (bool)',
  'function isOwnerPublicKey(bytes32 x, bytes32 y) view returns (bool)',
  'function replaySafeHash(bytes32 hash) view returns (bytes32)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls) payable',
])

/**
 * The `CoinbaseSmartWallet.SignatureWrapper` tuple — `(uint8 ownerIndex, bytes
 * signatureData)`. Byte-identical to what viem's internal `wrapSignature` emits
 * (a small `uint8` right-aligns in a 32-byte word exactly like the contract's
 * `uint256 ownerIndex`), so decode/re-encode round-trips cleanly.
 */
const SIGNATURE_WRAPPER_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'ownerIndex', type: 'uint8' },
      { name: 'signatureData', type: 'bytes' },
    ],
  },
]

/**
 * Re-point a stub `SignatureWrapper` at `ownerIndex`, preserving its dummy
 * `signatureData`.
 *
 * viem 2.53's `toCoinbaseSmartAccount.getStubSignature()` hardcodes
 * `ownerIndex = 0` for WebAuthn owners (its constant WebAuthn stub) — unlike
 * `signUserOperation`, which wraps the REAL index. Gas estimation
 * (`eth_estimateUserOperationGas`, the UI "Prepare" step) therefore validates
 * the stub against owner slot 0. On an account whose slot 0 was removed
 * (passkey rotation / recovery, spec 045), `ownerAtIndex(0)` is empty and the
 * account's `validateUserOp` reverts (`InvalidOwnerBytesLength`) — surfaced as
 * "The `validateUserOp` function on the Smart Account reverted." BEFORE the user
 * is ever prompted to sign, on every transaction. Re-wrapping the stub under the
 * credential's real, live owner index makes estimation and signing agree.
 *
 * `ownerIndex` 0 is returned unchanged (viem's stub already targets slot 0 — the
 * pristine single-passkey case, byte-for-byte unchanged). A stub that does not
 * decode as a `SignatureWrapper` is returned as-is (defensive; never blocks a send).
 */
export function rewrapStubOwnerIndex(stub, ownerIndex) {
  if (!ownerIndex) return stub
  try {
    const [{ signatureData }] = decodeAbiParameters(SIGNATURE_WRAPPER_ABI, stub)
    return encodeAbiParameters(SIGNATURE_WRAPPER_ABI, [{ ownerIndex, signatureData }])
  } catch {
    return stub
  }
}

/**
 * Resolve the passkey stack config for a chain, or throw ChainNotSupportedError (FR-022).
 *
 * ⚠️ This is the **SUBMISSION** gate — it answers "can this chain carry a UserOp", which needs a
 * bundler. It is NOT the sign-in gate and must never be called on a login path. Signing in is a
 * WebAuthn ceremony plus an address derivation, neither of which touches a bundler, an EntryPoint,
 * or any chain at all (see computeAccountAddress). Gating login on this locked members out of
 * their own accounts: selecting an unsupported network persisted, and on the next visit the
 * passkey option was hidden on the chain they were already on, with no way back.
 *
 * Callers: buildAccount (and anything downstream of it). Nothing else.
 */
export function requirePasskeySupport(chainId) {
  const net = getNetwork(chainId)
  const factory = safeAddress('accountFactory', chainId)
  const entryPoint = safeAddress('entryPoint', chainId)
  if (!net?.capabilities?.passkeyAccounts || !factory || !entryPoint) {
    throw new ChainNotSupportedError(chainId)
  }
  return {
    network: net,
    factory,
    entryPoint,
    bundlerUrls: net.passkey.bundlerUrls,
    sponsorPaymasterUrl: net.passkey.sponsorPaymasterUrl ?? null,
  }
}

function safeAddress(key, chainId) {
  try {
    const addr = getContractAddressForChain(key, chainId)
    return addr && addr !== '0x0000000000000000000000000000000000000000' ? addr : null
  } catch {
    return null
  }
}

/** ABI-encode a P-256 public key as a MultiOwnable owner entry (64 bytes: x || y). */
export function publicKeyToOwnerBytes({ x, y }) {
  return `0x${x.slice(2).padStart(64, '0')}${y.slice(2).padStart(64, '0')}`
}

/** ABI-encode an EOA address as an owner entry (32 bytes, left-padded). */
export function addressToOwnerBytes(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`
}

/**
 * `LibClone.initCodeHashERC1967(implementation)` for the FairWins account implementation — the
 * CREATE2 init-code hash every account proxy is deployed from.
 *
 * It is a pure function of the implementation address, and BOTH the implementation and the factory
 * are deployed at the same address on every network (FR-023), so this is one global constant rather
 * than per-chain state. Read from the live factory's `initCodeHash()` and pinned here;
 * `smartAccount.deriveAddress.test.js` asserts the local derivation reproduces the on-chain
 * `getAddress` for fixed vectors, so a drifted constant fails loudly rather than quietly minting
 * addresses nobody can spend from.
 */
export const ACCOUNT_INIT_CODE_HASH = '0x0a40302ceb0b44810777085a7c2c96a8c4d443faad822012befbc253996f4f2e'

/**
 * Chains consulted for the (FR-023-identical) factory address when the active chain has no config
 * of its own. Order is irrelevant — every entry that answers must answer the SAME address, which
 * accountFactoryAddress asserts. This list only has to contain chains where the factory is
 * deployed; it is a lookup convenience, not a support claim.
 */
const FACTORY_LOOKUP_CHAIN_IDS = [137, 1, 10, 8453, 42161, 61, 63, 80002, 1337]

/**
 * The account factory address, which FR-023 requires be identical on every network.
 *
 * Resolved from the synced per-chain config (constitution V — never hardcoded) but WITHOUT taking a
 * chainId: sign-in must work on a chain the app has no passkey config for, so it cannot ask "what
 * is the factory on chain X". Every configured chain must agree; divergence is an FR-023 violation
 * and throws rather than silently picking one, because the two answers would derive different
 * account addresses for the same passkey.
 */
export function accountFactoryAddress(preferredChainId = null) {
  // The active chain answers first when it has config — the common case, and it avoids depending on
  // the candidate list below being complete.
  if (preferredChainId != null) {
    const preferred = safeAddress('accountFactory', Number(preferredChainId))
    if (preferred) return preferred
  }
  const seen = new Map()
  for (const id of FACTORY_LOOKUP_CHAIN_IDS) {
    const addr = safeAddress('accountFactory', id)
    if (addr) seen.set(addr.toLowerCase(), addr)
  }
  if (seen.size === 0) return null
  if (seen.size > 1) {
    throw new Error(
      `FR-023 violation: accountFactory differs across configured networks (${[...seen.values()].join(', ')}). ` +
        `The same passkey would derive a different account address per chain.`
    )
  }
  return [...seen.values()][0]
}

/**
 * Derive the (counterfactual) account address for an owner set — PURE, no chain access.
 *
 * The factory's `getAddress` is `CREATE2(factory, keccak256(abi.encode(owners, nonce)),
 * initCodeHash)`, and all three inputs are chain-independent, so the answer is too. Computing it
 * locally is what lets a member sign in on ANY network — including one with no bundler, no
 * deployment, or no RPC — instead of being locked out by a chain they happened to have selected.
 *
 * Verified against the live factory for single-owner, multi-owner, EOA-owner and non-zero-nonce
 * vectors; the same vectors are pinned as unit tests.
 */
export function computeAccountAddress({ ownersBytes, nonce = 0n, chainId = null }) {
  const factory = accountFactoryAddress(chainId)
  if (!factory) throw new Error('No accountFactory address is configured in any network.')
  const salt = keccak256(encodeAbiParameters([{ type: 'bytes[]' }, { type: 'uint256' }], [ownersBytes, BigInt(nonce)]))
  return getContractAddress({ opcode: 'CREATE2', from: factory, salt, bytecodeHash: ACCOUNT_INIT_CODE_HASH })
}

/**
 * Derive the counterfactual account address for an initial owner set.
 *
 * Kept async and chainId-accepting for call-site compatibility, but neither is used any more: this
 * is now a local computation (see computeAccountAddress). It previously called the factory over RPC
 * behind `requirePasskeySupport`, which made address derivation — and therefore sign-in — fail on
 * any chain without passkey submission config.
 */
export async function deriveAddress({ chainId, ownersBytes, nonce = 0n, deps = {} }) {
  void chainId
  void deps
  return computeAccountAddress({ ownersBytes, nonce, chainId })
}

/**
 * Minimal viem Chain descriptor from our own network config. Without a `chain`,
 * `createPublicClient` leaves `client.chain` undefined — and viem's smart-account
 * signing methods (toCoinbaseSmartAccount's `sign`/`signUserOperation`) read
 * `client.chain.id` unconditionally, so every passkey ceremony crashed with
 * "Cannot read properties of undefined (reading 'id')" (issue #854).
 */
function toViemChain(net) {
  return {
    id: net.chainId,
    name: net.name,
    nativeCurrency: net.nativeCurrency,
    rpcUrls: { default: { http: [net.rpcUrl] } },
  }
}

/**
 * Read client for a chain, honouring the MEMBER's own endpoint (spec 069, spec 104 FR-012).
 *
 * This used to build a transport straight from `getNetwork(chainId).rpcUrl`, which spec 069
 * forbids in as many words: a member who configured their own endpoint had it honoured everywhere
 * except the passkey read path. That matters most in account recovery, which is read-heavy and so
 * the flow most likely to be rate-limited off a shared default — and where the cost is not a slow
 * screen but an `unverified` verdict, i.e. a member turned away from their own account for want of
 * a request their configured endpoint would have served.
 *
 * A member endpoint yields real failover with the build default behind it, so a custom endpoint
 * going dark degrades rather than taking the chain down.
 */
export function defaultPublicClient(chainId) {
  const net = getNetwork(chainId)
  const route = resolveRpcEndpoints(chainId)
  const primary = route.primary?.url || net.rpcUrl
  const options = Object.keys(route.primary?.headers || {}).length
    ? { fetchOptions: { headers: route.primary.headers } }
    : undefined

  // The member's failover, then the build default behind both. Deduped on the URL rather than on
  // the transport object: a member on default settings has all three resolve to the same string,
  // and viem's transport is an opaque callable whose url is not reliably introspectable.
  const urls = [route.failover?.url, route.defaultUrl].filter((u) => u && u !== primary)
  const transports = [http(primary, options), ...new Set(urls)].map((t) =>
    typeof t === 'string' ? http(t) : t
  )

  return createPublicClient({
    chain: toViemChain(net),
    transport: transports.length > 1 ? fallback(transports) : transports[0],
  })
}

/**
 * Resolve which owner slot a credential occupies on a deployed account, so
 * signatures carry the credential's REAL index — hardcoding 0 breaks every
 * account that gained controllers (spec 045, FR-009). Counterfactual (not yet
 * deployed) or unreadable accounts fall back to 0, the initial owner's slot.
 * A deployed account that no longer lists the credential throws — signing
 * would be guessing.
 */
export async function resolveOwnerIndex({ chainId, accountAddress, credential, deps = {} }) {
  let result
  try {
    result = await (deps.readControllers ?? readControllers)({ chainId, accountAddress, deps })
  } catch {
    return 0
  }
  if (!result.deployed) return 0
  const ownerBytes = publicKeyToOwnerBytes(credential.publicKey).toLowerCase()
  const match = result.controllers.find((c) => c.ownerBytes?.toLowerCase() === ownerBytes)
  if (!match) throw new CredentialNotControllerError()
  return Number(match.index)
}

/**
 * Build the viem smart-account + bundler client pair for a credential.
 * `credential` = { credentialId, publicKey: {x, y} } from credentials.js.
 * `signPayload` lets the connector own the ceremony UX (deps-injectable).
 */
export async function buildAccount({ chainId, credential, accountAddress, ownerIndex, nonce = 0n, deps = {} }) {
  const { entryPoint, bundlerUrls, sponsorPaymasterUrl, factory } = requirePasskeySupport(chainId)
  const client = deps.publicClient ?? defaultPublicClient(chainId)

  // Refuse incomplete records BEFORE any ceremony — an undefined id/key here
  // used to surface as "Cannot read properties of undefined (reading 'id')"
  // from inside the WebAuthn signer (spec 045, FR-006).
  if (!isTransactComplete(credential)) throw new CredentialRecordIncomplete()

  // Own the WebAuthn get() call: viem's default dereferences the result
  // without a null guard, and some browsers (Brave) resolve null on cancel
  // instead of rejecting. The request options viem passes already pin
  // allowCredentials to this credential.
  const getFn =
    deps.getFn ??
    (async (options) => {
      const credentials = deps.credentials ?? globalThis.navigator?.credentials
      const result = await credentials.get(options)
      if (!result) throw new CeremonyCancelled()
      return result
    })

  const initialOwnerBytes = publicKeyToOwnerBytes(credential.publicKey)

  const owner = toWebAuthnAccount({
    credential: {
      id: credential.credentialId,
      publicKey: initialOwnerBytes,
    },
    getFn,
    rpId: deps.rpId,
  })

  // The account address is a pure function of (initial owners, nonce) and the FairWins-DEPLOYED
  // factory — the one the connector's `deriveAddress` uses and the address the user funds (their
  // displayed balance). viem's `toCoinbaseSmartAccount` instead hardwires the canonical Coinbase
  // factory (0x0ba5ed0c), which derives a DIFFERENT counterfactual address. Left unpinned, every
  // UserOp was built for that empty Coinbase-factory address — the transfer reverted "exceeds
  // balance" (sponsored) or the sender couldn't prefund gas → AA21 (self-funded). Pin viem to the
  // FairWins address so the sender is the account that actually holds the funds.
  const address =
    accountAddress ??
    (await deriveAddress({ chainId, ownersBytes: [initialOwnerBytes], nonce, deps: { publicClient: client } }))

  // ownerIndex of THIS owner inside the account's owner list. Resolved from the
  // chain by callers (resolveOwnerIndex); 0 is the initial credential's slot.
  // Controller additions never reindex (append-only).
  const resolvedOwnerIndex = ownerIndex ?? deps.ownerIndex ?? 0

  const account = await toCoinbaseSmartAccount({
    client,
    owners: [owner],
    ownerIndex: resolvedOwnerIndex,
    nonce,
    // Pin the sender: viem returns this verbatim from getAddress() instead of querying its
    // own (wrong) factory. Signing (replaySafeHash/ERC-1271) binds this same address + chainId.
    address,
  })

  // Gas estimation runs the account's `validateUserOp` against a STUB signature.
  // viem's WebAuthn stub hardcodes ownerIndex 0 (see rewrapStubOwnerIndex), so an
  // account whose slot 0 was removed reverts during estimation — before the user
  // can sign. Re-point the stub at the credential's real index so estimation
  // validates the same live owner slot that `signUserOperation` will. No-op for
  // slot 0 (viem's stub already targets it) and for a mock without the method.
  if (resolvedOwnerIndex && typeof account.getStubSignature === 'function') {
    const originalGetStubSignature = account.getStubSignature.bind(account)
    account.getStubSignature = async (...args) =>
      rewrapStubOwnerIndex(await originalGetStubSignature(...args), resolvedOwnerIndex)
  }

  // First-use deployment must land the account code at `address`, so the initCode MUST call the
  // FairWins factory's createAccount — not viem's hardwired Coinbase factory (which would deploy a
  // different address and revert AA14). Override viem's getFactoryArgs, preserving its isDeployed
  // guard so a deployed account emits no initCode. Owners here mirror `deriveAddress` exactly, so
  // the deployed address equals `address`. (For counterfactual accounts the connecting credential
  // is always the sole initial owner — controllers can only be added post-deployment.)
  account.getFactoryArgs = async () => {
    if (await account.isDeployed()) return { factory: undefined, factoryData: undefined }
    return {
      factory,
      factoryData: encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: 'createAccount',
        args: [[initialOwnerBytes], nonce],
      }),
    }
  }

  // FairWins-sponsored paymaster (spec 050): when a sponsor endpoint is configured for this network,
  // the bundler client fetches a signed sponsorship automatically so the account never needs a
  // native-token balance to pay gas. Falls back to native-token fees when unconfigured — or when
  // `deps.noPaymaster` forces self-funding (the never-stranded retry in sendBatch.js when sponsorship
  // is unavailable). `deps.paymaster` still lets tests inject a client directly.
  const paymaster = deps.noPaymaster
    ? undefined
    : deps.paymaster ?? (sponsorPaymasterUrl ? createPaymasterClient({ transport: http(sponsorPaymasterUrl) }) : undefined)

  // The whole list, not just [0] (#1535). A second entry has always been configurable and was
  // never able to submit; failover applies to a bundler that did not ANSWER, never to one that
  // answered and rejected the UserOp — see bundlerTransport.js.
  const bundlerClient = createBundlerClient({
    account,
    client,
    transport: bundlerTransport(bundlerUrls),
    ...(paymaster ? { paymaster } : {}),
  })

  // `sponsored` = a paymaster is wired for this attempt; the caller uses it for honest fee
  // disclosure and to decide whether a self-funded fallback is still possible.
  return { account, bundlerClient, entryPoint, bundlerUrls, publicClient: client, sponsored: Boolean(paymaster) }
}

/**
 * Compose an action as ONE batch (FR-016): [approve?, act] → executeBatch calls.
 * Returns { calls } ready for sendUserOperation / the submission router.
 */
export function buildAction(calls) {
  return {
    calls: calls.map((c) => ({ to: c.target ?? c.to, value: c.value ?? 0n, data: c.data ?? '0x' })),
  }
}

/** Encode a controller addition (passkey) as an account self-call. */
export function encodeAddPasskeyOwner({ x, y }) {
  return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'addOwnerPublicKey', args: [x, y] })
}

/** Encode a controller addition (external wallet). Screening happens BEFORE this is built (FR-019). */
export function encodeAddWalletOwner(address) {
  return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'addOwnerAddress', args: [address] })
}

/**
 * Encode a controller removal. Guards the last-controller invariant CLIENT-side
 * (FR-020's UX half — the contract enforces it on-chain regardless).
 */
export function encodeRemoveOwner({ index, ownerBytes, ownerCount }) {
  if (ownerCount <= 1n) throw new LastControllerError()
  return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'removeOwnerAtIndex', args: [index, ownerBytes] })
}

/**
 * Read the full on-chain controller list (AccountController projection, data-model).
 *
 * `strict` decides what an UNREADABLE chain means, and the two answers are genuinely different
 * facts. By default a failed `getCode` is swallowed and reported as `deployed: false`, which suits
 * the callers that only want to know whether there is anything to sign against and treat "cannot
 * tell" as "assume not deployed" (`resolveOwnerIndex` falls back to slot 0; `repairPublicKey` gives
 * up).
 *
 * That default is wrong for anyone deciding whether an account EXISTS: it turns "the network did
 * not answer" into "nothing is there", which is precisely the conflation spec 104 exists to
 * prevent — one layer below where the resolver could see it. `strict: true` rethrows instead, so
 * the caller can report `unverified` rather than a fabricated absence.
 */
export async function readControllers({ chainId, accountAddress, strict = false, deps = {} }) {
  const client = deps.publicClient ?? defaultPublicClient(chainId)
  const code = await client.getCode({ address: accountAddress }).catch((err) => {
    if (strict) throw err
    return null
  })
  if (!code || code === '0x') return { deployed: false, controllers: [] }

  const next = await client.readContract({
    address: accountAddress,
    abi: ACCOUNT_ABI,
    functionName: 'nextOwnerIndex',
  })
  const controllers = []
  for (let i = 0n; i < next; i++) {
    const ownerBytes = await client.readContract({
      address: accountAddress,
      abi: ACCOUNT_ABI,
      functionName: 'ownerAtIndex',
      args: [i],
    })
    if (!ownerBytes || ownerBytes === '0x') continue // removed slot
    controllers.push({
      index: i,
      ownerBytes,
      kind: ownerBytes.length === 2 + 64 ? 'wallet' : 'passkey',
      address: ownerBytes.length === 2 + 64 ? `0x${ownerBytes.slice(-40)}` : null,
    })
  }
  return { deployed: true, controllers }
}
