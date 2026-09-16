/**
 * Legacy key & word-list recovery (Recovery section).
 *
 * Many members arrive holding an *old* secret: a raw EOA private key, or a
 * BIP-39 word list (12/15/18/21/24 words) from a previous wallet. FairWins can
 * take custody of that secret ONLY on this device, encrypted at rest, and — the
 * important part — help the member move the funds off that legacy key onto a
 * modern passkey smart account, which is what the rest of the app protects.
 *
 * Security posture (mirrors the passkey blob approach in lib/passkey/prfKeys.js):
 *  - the raw secret is NEVER persisted in the clear and never leaves the device;
 *  - at rest it is wrapped with AES-GCM under a key stretched from a
 *    member-chosen passphrase (PBKDF2-SHA256), so localStorage alone is useless;
 *  - a wrong passphrase fails the AES-GCM tag — we never fall through to a
 *    different/empty secret.
 *
 * A legacy EOA is a liability, not a destination: the module makes "move the
 * funds to a smart account" the recommended follow-up, but it is OPTIONAL —
 * storing the key completes recovery on its own. When chosen, the move sweeps
 * ALL supported assets (native + supported ERC-20s), not just the native coin.
 */

import { ethers } from 'ethers'
import { isValidMnemonic } from '../evm/mnemonic'
import { getPortfolioRegistry } from '../../config/assetTaxonomy'
import { TRANSFER_ABI } from '../transfer/eip3009Transfer'
import { loadLegacyRecoveredKeys, saveLegacyRecoveredKeys } from './legacyRecoveredKeysStore'
import { getAssertion } from '../passkey/credentials'
import { prfSalt, EncryptionUnavailable } from '../passkey/prfKeys'

// PBKDF2 work factor. OWASP's 2023 floor for PBKDF2-HMAC-SHA256 is 600k; we sit
// above it. Stored per-entry so a future bump stays backward-compatible.
export const PBKDF2_ITERATIONS = 650000
const MIN_PASSPHRASE_LEN = 8

// HKDF context for the biometric (passkey-PRF) wrapping key. Distinct from the
// spec-041 master-seed KEK info ('fairwins-kek-v1') so the same PRF output can
// never derive both keys — domain separation.
const LEGACY_PRF_KEK_INFO = new TextEncoder().encode('fairwins-legacy-kek-v1')

// BIP-39 word lists come in these lengths only.
const VALID_WORD_COUNTS = [12, 15, 18, 21, 24]
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/

const subtleOf = (deps = {}) => deps.subtle ?? globalThis.crypto?.subtle
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))
const toB64 = (u8) => btoa(String.fromCharCode(...u8))
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * Classify a pasted secret without persisting anything. Recognizes a raw
 * private key (64 hex chars, optional 0x) or a valid BIP-39 mnemonic, and
 * returns the address it controls so the member can confirm it's the right one
 * before we ever store it.
 *
 * @param {string} input
 * @returns {{ kind: 'privateKey'|'mnemonic', address: string, secret: string, wordCount: number }
 *          | { kind: 'empty'|'invalid' }}
 */
export function classifySecret(input) {
  const raw = (input || '').trim()
  if (!raw) return { kind: 'empty' }

  // Private key — accept with or without the 0x prefix.
  const hex = raw.startsWith('0x') ? raw : `0x${raw}`
  if (PRIVATE_KEY_RE.test(hex)) {
    try {
      const wallet = new ethers.Wallet(hex)
      return { kind: 'privateKey', address: wallet.address, secret: hex.toLowerCase(), wordCount: 0 }
    } catch {
      /* not a usable key — fall through to invalid */
    }
  }

  // Word list — normalize whitespace/case the way BIP-39 expects.
  const words = raw.split(/\s+/).filter(Boolean)
  if (VALID_WORD_COUNTS.includes(words.length)) {
    const phrase = words.join(' ').toLowerCase()
    try {
      // Spec 110 — the seam, NOT `ethers.Mnemonic.isValidMnemonic`, and never dropped as
      // redundant. This gate is what stops viem's `mnemonicToAccount` deriving a real, plausible
      // address from a phrase with one mistyped word (divergence h, measured): the member would be
      // shown an address, told the import worked, and find an empty account while their actual
      // funds sit somewhere they were never shown.
      if (isValidMnemonic(phrase)) {
        const wallet = ethers.HDNodeWallet.fromPhrase(phrase)
        return { kind: 'mnemonic', address: wallet.address, secret: phrase, wordCount: words.length }
      }
    } catch {
      /* invalid checksum / word — fall through */
    }
  }

  return { kind: 'invalid' }
}

/**
 * A provider-connected legacy signer that assigns its OWN nonces.
 *
 * A bare ethers Wallet asks the provider for its nonce on every send, and ethers v6's provider
 * caches every call result for 250 ms (`cacheTimeout`). Two sends in quick succession — approve
 * then pay, or a sweep's ERC-20 transfers — can therefore both be handed the SAME nonce when the
 * first mines inside that window (an automining local chain, a fast L2): the second is refused with
 * "Nonce too low" and the flow fails on the pay leg. The CI log for spec 098's recovered-account
 * purchase showed exactly this — no nonce lookup at all between the approve receipt and the failed
 * pay. ethers' NonceManager tracks the nonce locally and increments per send, so sequential sends
 * are 0, 1, 2 whatever the provider cache says. On a FAILED send the local count is reset, because
 * NonceManager increments before the send and a refused transaction never consumed its nonce —
 * without the reset the next send would be one too high. A transaction that arrives with its own
 * nonce (the multi-asset sweep numbers each leg itself) is sent as given.
 *
 * `address` is kept on the wrapper so callers that read the wallet's address property keep working.
 */
class ManagedLegacySigner extends ethers.NonceManager {
  get address() {
    return this.signer.address
  }

  async sendTransaction(tx) {
    // A caller that numbers its own transactions (the multi-asset sweep) keeps its numbering.
    if (tx && tx.nonce != null) return this.signer.sendTransaction(tx)
    try {
      return await super.sendTransaction(tx)
    } catch (e) {
      this.reset()
      throw e
    }
  }
}

/**
 * Build a signer from a classified secret: a bare Wallet when no provider is given (address
 * derivation only), or a provider-connected, nonce-managed signer for sending.
 */
export function walletFromSecret({ kind, secret }, provider = null) {
  const wallet = kind === 'mnemonic' ? ethers.HDNodeWallet.fromPhrase(secret) : new ethers.Wallet(secret)
  return provider ? new ManagedLegacySigner(wallet.connect(provider)) : wallet
}

async function deriveWrapKey(passphrase, salt, iterations, subtle) {
  const baseKey = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypt a classified secret at rest under a passphrase-derived key. The
 * returned entry is a plain JSON blob safe to keep in localStorage — it reveals
 * the address (so the member can recognize it) but nothing about the secret.
 *
 * @returns {Promise<object>} vault entry
 */
export async function encryptLegacySecret({ secret, kind, address, passphrase, deps = {} }) {
  if (!secret) throw new Error('Nothing to encrypt.')
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new Error(`Choose a passphrase of at least ${MIN_PASSPHRASE_LEN} characters.`)
  }
  const subtle = subtleOf(deps)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveWrapKey(passphrase, salt, PBKDF2_ITERATIONS, subtle)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret)))
  return {
    v: 1,
    kind,
    address,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
    iterations: PBKDF2_ITERATIONS,
    importedAt: deps.now ?? Date.now(),
  }
}

/**
 * Recover the raw secret from a vault entry. A wrong passphrase (or a tampered
 * blob) fails the AES-GCM tag and raises — we never return partial/other data.
 *
 * @returns {Promise<string>} the private key (0x…) or mnemonic phrase
 */
export async function decryptLegacySecret({ entry, passphrase, deps = {} }) {
  if (!entry) throw new Error('No stored key to unlock.')
  const subtle = subtleOf(deps)
  const salt = fromB64(entry.salt)
  const iv = fromB64(entry.iv)
  const key = await deriveWrapKey(passphrase, salt, entry.iterations ?? PBKDF2_ITERATIONS, subtle)
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv }, key, fromB64(entry.ct))
    return new TextDecoder().decode(pt)
  } catch {
    throw new Error('That passphrase did not unlock this key. Check it and try again.')
  }
}

// Derive an AES-GCM wrapping key from a passkey PRF assertion output (biometric).
async function kekFromPrfOutput(prfOutput, subtle) {
  const ikm = await subtle.importKey('raw', prfOutput, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: LEGACY_PRF_KEK_INFO },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

async function runPrfAssertion(credentialId, deps) {
  const assertion = await (deps.getAssertion ?? getAssertion)({
    challenge: randomBytes(32),
    credentialId,
    prfSalt: (deps.prfSalt ?? prfSalt)(),
    deps: deps.assertionDeps,
  })
  if (!assertion?.prfOutput) {
    throw new EncryptionUnavailable('this passkey/authenticator cannot derive biometric key material (PRF unsupported)')
  }
  return assertion.prfOutput
}

/**
 * Encrypt a classified secret at rest under a BIOMETRIC (passkey-PRF) key — no
 * passphrase. One WebAuthn assertion (Face/Touch ID) yields the PRF output; the
 * secret is wrapped under an AES-GCM key derived from it. Unlockable only by the
 * same passkey on this account, so a stolen blob is useless without the device's
 * biometric. The returned entry records `protection:'passkey'` + the credential
 * id so unlock knows which ceremony to run.
 *
 * @returns {Promise<object>} vault entry (v2, passkey-protected)
 */
export async function encryptLegacySecretWithPasskey({ secret, kind, address, credentialId, deps = {} }) {
  if (!secret) throw new Error('Nothing to encrypt.')
  if (!credentialId) throw new EncryptionUnavailable('no passkey is available on this device to protect the key')
  const subtle = subtleOf(deps)
  const prfOutput = await runPrfAssertion(credentialId, deps)
  const key = await kekFromPrfOutput(prfOutput, subtle)
  const iv = randomBytes(12)
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret)))
  return {
    v: 2,
    protection: 'passkey',
    kind,
    address,
    credentialId,
    iv: toB64(iv),
    ct: toB64(ct),
    importedAt: deps.now ?? Date.now(),
  }
}

/** Recover a biometric-protected secret (one WebAuthn assertion). Fails closed. */
export async function decryptLegacySecretWithPasskey({ entry, deps = {} }) {
  if (!entry?.credentialId) throw new Error('This stored key is missing its passkey reference.')
  const subtle = subtleOf(deps)
  const prfOutput = await runPrfAssertion(entry.credentialId, deps)
  const key = await kekFromPrfOutput(prfOutput, subtle)
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(entry.iv) }, key, fromB64(entry.ct))
    return new TextDecoder().decode(pt)
  } catch {
    throw new Error('Biometric unlock did not recover this key on this device.')
  }
}

/**
 * Unified unlock: recover the raw secret from a vault entry regardless of how it
 * was protected. Passkey entries run a biometric assertion (no passphrase);
 * passphrase entries need `passphrase`. Callers that sign as a legacy account use
 * this so the unlock method is transparent to them.
 */
export async function unlockLegacySecret({ entry, passphrase, deps = {} }) {
  if (entry?.protection === 'passkey') return decryptLegacySecretWithPasskey({ entry, deps })
  return decryptLegacySecret({ entry, passphrase, deps })
}

/**
 * Unlock a stored recovered account into a live, provider-connected ethers signer
 * that can be used to "act as" that account (spec 062 follow-up). The secret is
 * decrypted (biometric or passphrase) into a signer and returned; the caller
 * holds it in memory only for the session and never persists it.
 *
 * @returns {Promise<ethers.Signer>}
 */
export async function unlockLegacyAccount({ entry, passphrase, provider, deps = {} }) {
  const secret = await unlockLegacySecret({ entry, passphrase, deps })
  return walletFromSecret({ kind: entry.kind, secret }, provider)
}

/**
 * Per-account, device-local vault of encrypted legacy keys, keyed by lowercased
 * address so a given legacy account is stored once. Backed by the same
 * per-account storage the spec-032 backup reads (legacyRecoveredKeysStore), so
 * recovered accounts ride the encrypted backup — the CRUD facade and the backup
 * domain share one source of truth. `deps.load`/`deps.save` are injectable for
 * tests.
 *
 * @param {string} account - the signed-in account that owns this vault
 * @param {{ load?: Function, save?: Function }} [deps]
 */
export function legacyKeyVault(account, deps = {}) {
  const load = deps.load ?? loadLegacyRecoveredKeys
  const save = deps.save ?? saveLegacyRecoveredKeys
  const read = () => load(account)
  const write = (all) => save(account, all)
  return {
    list() {
      return Object.values(read()).sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0))
    },
    get(address) {
      return read()[String(address).toLowerCase()] ?? null
    },
    has(address) {
      return Boolean(this.get(address))
    },
    set(entry) {
      const all = read()
      all[String(entry.address).toLowerCase()] = entry
      write(all)
    },
    delete(address) {
      const all = read()
      delete all[String(address).toLowerCase()]
      write(all)
    },
  }
}

// Pad the estimated fee by 20% so a small gas-price bump between quote and send
// doesn't strand the sweep — the leftover dust stays on the legacy key.
const GAS_BUFFER_NUM = 12n
const GAS_BUFFER_DEN = 10n
const TRANSFER_GAS_LIMIT = 21000n

/**
 * Quote a native-currency sweep from a legacy key to a destination: how much is
 * on it, the reserved gas, and the sendable remainder. Read-only.
 *
 * @returns {Promise<{ from: string, balance: bigint, gasReserve: bigint,
 *   sendable: bigint, gasLimit: bigint, gasPrice: bigint }>}
 */
export async function quoteNativeSweep({ kind, secret, provider }) {
  if (!provider) throw new Error('No network connection to check the balance.')
  const from = walletFromSecret({ kind, secret }).address
  const [balance, feeData] = await Promise.all([provider.getBalance(from), provider.getFeeData()])
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n
  const gasReserve = (TRANSFER_GAS_LIMIT * gasPrice * GAS_BUFFER_NUM) / GAS_BUFFER_DEN
  const sendable = balance > gasReserve ? balance - gasReserve : 0n
  return { from, balance, gasReserve, sendable, gasLimit: TRANSFER_GAS_LIMIT, gasPrice }
}

/**
 * Sweep the sendable native balance of a legacy key to `to`. Leaves the gas
 * reserve behind so the transaction can pay for itself. Native currency only —
 * ERC-20 balances are not moved (disclosed in the UI).
 *
 * @returns {Promise<object>} the sent transaction (already broadcast)
 */
export async function sweepNativeToSmartAccount({ kind, secret, to, provider }) {
  if (!ethers.isAddress(to)) throw new Error('Enter a valid destination address.')
  const quote = await quoteNativeSweep({ kind, secret, provider })
  if (quote.sendable <= 0n) {
    throw new Error('This key does not hold enough to cover the network fee — there is nothing to transfer.')
  }
  const wallet = walletFromSecret({ kind, secret }, provider)
  return wallet.sendTransaction({ to, value: quote.sendable, gasLimit: quote.gasLimit })
}

// Minimal ABI for reading an arbitrary account's ERC-20 balance.
const BALANCE_OF_ABI = ['function balanceOf(address) view returns (uint256)']

/**
 * The fee fields a transaction must CARRY so it is priced exactly as the reserve set aside for
 * it was sized — never left to be read again during populate, where a tick up in the price turns
 * `value + gas <= balance` from an identity into a refusal.
 *
 * A chain that reported no fee at all (price 0) is left to the library: an explicit zero would be
 * a worse guess than its own. A chain that prices in legacy `gasPrice` must NOT be handed
 * `maxFeePerGas` — the node would reject a type-2 transaction it cannot price.
 *
 * @param {bigint} price - max fee per gas (or the legacy gas price)
 * @param {bigint|null} priority - the tip, or null on a legacy-priced chain
 */
export function pinnedFeeFields(price, priority) {
  if (price === 0n) return {}
  if (priority == null) return { gasPrice: price }
  return { maxFeePerGas: price, maxPriorityFeePerGas: priority > price ? price : priority }
}

/**
 * Re-read the fee, and never come back with LESS than the floor already reserved.
 *
 * Every leg pays out of the same coin balance, so a fee that climbs mid-sweep has to be picked up
 * by the legs behind it; a fee that falls is not a reason to cut the margin the member was quoted.
 * Monotone by construction, so the schedule the sweep pins is the highest price it has seen.
 */
async function raisedFeeSchedule(provider, price, priority) {
  try {
    const fresh = await provider.getFeeData()
    const freshPrice = fresh?.maxFeePerGas ?? fresh?.gasPrice ?? 0n
    if (freshPrice > price) {
      return {
        price: freshPrice,
        priority: fresh?.maxFeePerGas != null ? (fresh.maxPriorityFeePerGas ?? 0n) : null,
      }
    }
  } catch {
    /* fee unavailable — the floor stands, which is strictly safer than guessing lower */
  }
  return { price, priority }
}

const asBigInt = (v) => {
  try {
    return v == null ? null : BigInt(v)
  } catch {
    return null
  }
}

/**
 * What one broadcast leg actually took out of the coin balance.
 *
 * Preferred order is receipt (a fact) → the limit the transaction carried at the pinned price (an
 * upper bound) → nothing. Never guessed upward from thin air: this figure is only ever used
 * alongside a live balance read, and the SMALLER of the two is what the coin leg is sized from,
 * so an unknowable cost degrades to trusting the read rather than to inventing a number.
 */
function coinSpentBy(tx, receipt, price) {
  const fee = asBigInt(receipt?.fee)
  if (fee != null) return fee
  const gasUsed = asBigInt(receipt?.gasUsed)
  const paid = asBigInt(receipt?.gasPrice ?? receipt?.effectiveGasPrice)
  if (gasUsed != null && paid != null) return gasUsed * paid
  const limit = asBigInt(tx?.gasLimit)
  if (limit != null) return limit * price
  return 0n
}

/**
 * The node's own words, where ethers wrapped them in a placeholder.
 *
 * ethers raises `could not coalesce error` whenever a JSON-RPC failure matches none of the shapes
 * it knows — which includes Hardhat's insufficient-funds message, because that message does not
 * contain the string "insufficient funds". The underlying error is still attached; reaching for it
 * is the difference between telling a member their coin could not cover the fee and telling them
 * nothing at all.
 */
function nodeMessageOf(e) {
  return e?.info?.error?.message ?? e?.error?.message ?? e?.info?.message ?? null
}

/**
 * A stable, honest reason for a per-asset failure. Never surfaces the library's own
 * `could not coalesce error` placeholder, which names no cause a member (or a CI log) can act on.
 *
 * @returns {string}
 */
export function describeTransferFailure(e) {
  const node = nodeMessageOf(e)
  const raw = e?.reason || e?.shortMessage || e?.message || ''
  const both = `${raw} ${node ?? ''}`
  if (/insufficient funds|enough funds|max upfront cost|gas \* price \+ value/i.test(both)) {
    return 'Not enough coin left to cover this transfer and its network fee.'
  }
  if (/could not coalesce/i.test(raw)) {
    return node || 'The network refused this transfer without saying why.'
  }
  return raw || 'The transfer did not go through.'
}

/**
 * Diagnostics for a per-asset outcome: enough to answer "by how much did it miss?" from a CI log
 * alone. Decimal strings so a bigint survives structured cloning and JSON. Balances and fees
 * only — NEVER key material, never the secret, never the mnemonic.
 */
const outcomeDetail = ({ gasPrice, gasLimit, reserve, balance, coinBalance }) => {
  const detail = {
    gasPrice: String(gasPrice),
    reserve: String(reserve),
    balance: String(balance),
    coinBalance: String(coinBalance),
  }
  if (gasLimit != null) detail.gasLimit = String(gasLimit)
  return detail
}

/** The platform-supported fungible assets on a chain (native + ERC-20; NFTs excluded). */
export function supportedAssetsForChain(chainId, registry) {
  const all = registry ?? getPortfolioRegistry(chainId)
  return (all || []).filter((a) => a && (a.kind === 'native' || a.kind === 'erc20'))
}

/**
 * Quote a full-portfolio sweep: enumerate every platform-supported asset on the
 * active chain and read the legacy account's balance for each. Only non-zero
 * balances are returned (native listed last). Read-only — no signing.
 *
 * When `to` is a valid address, the native leg's gas is estimated against that
 * exact destination (a smart-account recipient with a `receive()`/fallback needs
 * more than the 21k EOA baseline), and both the reserved fee and the gas limit
 * used at send time are sized from that estimate.
 *
 * @returns {Promise<{ from: string, holdings: Array<{ asset: object, balance: bigint }>,
 *   nativeGasReserve: bigint, nativeGasLimit: bigint, gasPrice: bigint,
 *   maxPriorityFeePerGas: bigint|null, hasNative: boolean }>}
 */
export async function quoteAllAssets({ kind, secret, chainId, provider, registry, to }) {
  if (!provider) throw new Error('No network connection to read balances.')
  const from = walletFromSecret({ kind, secret }).address
  const assets = supportedAssetsForChain(chainId, registry)

  const reads = await Promise.all(
    assets.map(async (asset) => {
      try {
        if (asset.kind === 'native') {
          return { asset, balance: await provider.getBalance(from) }
        }
        const erc20 = new ethers.Contract(asset.address, BALANCE_OF_ABI, provider)
        return { asset, balance: await erc20.balanceOf(from) }
      } catch {
        // A single unreadable token must not fail the whole quote — treat as zero.
        return { asset, balance: 0n }
      }
    })
  )

  const erc20Holdings = reads.filter((h) => h.asset.kind === 'erc20' && h.balance > 0n)
  const nativeRead = reads.find((h) => h.asset.kind === 'native')
  const hasNative = Boolean(nativeRead && nativeRead.balance > 0n)

  const feeData = await provider.getFeeData()
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n
  /*
   * The tip that goes with that price, or null on a chain that priced in legacy `gasPrice`.
   * Carried out of the quote because the native send PINS the fee to the price the reserve was
   * sized from (see sweepAllAssets) — and a type-2 transaction needs both halves to do that.
   */
  const maxPriorityFeePerGas =
    feeData.maxFeePerGas != null ? (feeData.maxPriorityFeePerGas ?? 0n) : null

  // Estimate the native-transfer gas against the real destination so a smart
  // account (contract) recipient is funded for its receive()/fallback; fall back
  // to the EOA baseline if estimation is unavailable. Buffer the gas units by 20%
  // and derive the reserve from the SAME buffered limit, so `value + gas ≤ balance`.
  let estimatedGas = TRANSFER_GAS_LIMIT
  if (hasNative && to && ethers.isAddress(to) && typeof provider.estimateGas === 'function') {
    try {
      estimatedGas = await provider.estimateGas({ from, to, value: 1n })
    } catch {
      estimatedGas = TRANSFER_GAS_LIMIT
    }
  }
  const nativeGasLimit = (estimatedGas * GAS_BUFFER_NUM) / GAS_BUFFER_DEN
  const nativeGasReserve = nativeGasLimit * gasPrice

  // ERC-20s first, native last (native pays the gas for every transfer).
  const holdings = [...erc20Holdings]
  if (hasNative) holdings.push(nativeRead)
  return { from, holdings, nativeGasReserve, nativeGasLimit, gasPrice, maxPriorityFeePerGas, hasNative }
}

/**
 * Sweep ALL supported assets held by the legacy key to `to`. Transfers each
 * ERC-20 first, then the native currency last (leaving a gas reserve so the
 * transaction pays for itself). A single asset failing NEVER aborts the rest —
 * every asset gets an honest outcome, so nothing is silently dropped and funds
 * are never stranded.
 *
 * @param {(outcome: object) => void} [onProgress] - called after each asset
 * @returns {Promise<Array<{ asset: object, status: 'sent'|'skipped'|'failed',
 *   txHash?: string, error?: string, detail?: object }>>}
 */
export async function sweepAllAssets({ kind, secret, to, chainId, provider, registry, onProgress }) {
  if (!ethers.isAddress(to)) throw new Error('Enter a valid destination address.')
  const quote = await quoteAllAssets({ kind, secret, chainId, provider, registry, to })
  if (to.toLowerCase() === quote.from.toLowerCase()) {
    throw new Error('Choose a destination other than the legacy account.')
  }
  const signer = walletFromSecret({ kind, secret }, provider)
  const outcomes = []
  const record = (o) => {
    outcomes.push(o)
    if (onProgress) onProgress(o)
  }

  /*
   * The nonce is tracked HERE rather than left to the provider.
   *
   * Every leg is signed by the same account through one provider, which looks the nonce up per
   * send — and that lookup can be stale. ethers caches it briefly, and a failover RPC pool
   * (spec 069) can answer from a node that has not yet seen the previous transfer. Either way the
   * next transfer reuses the previous nonce, the node rejects it as already used, and assets the
   * member was told would move quietly do not — which is exactly the stranding this function
   * exists to prevent. (Reproduced by the full-tier sweep spec on a fast local chain, where the
   * first transfer confirms inside the cache window.)
   *
   * Read once, then advance ONLY when a transfer was actually broadcast: an asset that fails
   * before broadcast consumes no nonce, and one that reverts after broadcast consumes its own,
   * so the assets behind it never queue up behind a gap that will never be filled.
   */
  let nonce = await provider.getTransactionCount(quote.from, 'pending')

  /*
   * The coin balance is tracked HERE as well, for the same reason the nonce is — and it is the
   * same failure, one layer along.
   *
   * The coin leg re-reads its balance so the ERC-20 legs' gas is accounted for. But that read can
   * be STALE: ethers shares an identical `getBalance` for 250ms (`cacheTimeout`), and a failover
   * RPC pool (spec 069) can answer from a node that has not yet seen the token transfer. On a fast
   * local chain an ERC-20 leg mines well inside that window, so the "fresh" read comes back as the
   * balance BEFORE it paid its gas — the sweep then asks to send coin the account no longer holds,
   * the node refuses it for insufficient funds, and (because Hardhat's wording contains no string
   * ethers recognises) the member is shown `could not coalesce error` against their coin.
   *
   * So the sweep keeps its own figure: the quoted balance, less what each BROADCAST leg actually
   * took, from its receipt. The coin leg is then sized from the SMALLER of that and the live read
   * — two independent estimates, neither trusted alone, and the conservative one governs.
   * (Issues #1301/#1327; intermittent in `28-legacy-recovery-sweep.cy.js::LKR-S2`.)
   */
  const quotedCoin = quote.holdings.find((h) => h.asset.kind === 'native')?.balance ?? 0n
  let coinSpent = 0n

  /*
   * The fee schedule every leg is PINNED to. Starts at the quote's price and only ever rises
   * (`raisedFeeSchedule`), so the reserve the coin leg keeps back is sized from the same schedule
   * the legs ahead of it were priced at — never from a quote a later leg has already invalidated.
   */
  let price = quote.gasPrice
  let priority = quote.maxPriorityFeePerGas

  for (const { asset, balance } of quote.holdings) {
    if (asset.kind === 'native') {
      /*
       * Re-read the coin balance instead of trusting the quote's.
       *
       * Every ERC-20 leg above paid its gas out of THIS balance, so by the time the native leg
       * runs the quote's figure is stale by exactly that much — and the reserve only ever covered
       * the native transfer's own gas. Sending `quotedBalance - reserve` therefore asks to spend
       * more than the account still holds, and the node rejects it for insufficient funds: with
       * any ERC-20 to move first, the coin was left behind every time, reported as a failure the
       * member could do nothing about. (Found by the full-tier sweep spec; the unit suite could
       * not see it, because a stubbed provider's balance never moves.)
       */
      let read = null
      try {
        read = await provider.getBalance(quote.from)
      } catch {
        /* the live read is one of two estimates, not the only one — fall back to the tracked figure */
      }
      // What the sweep believes is left, from the receipts of the legs it actually broadcast.
      const tracked = quotedCoin > coinSpent ? quotedCoin - coinSpent : 0n
      const current = read == null ? tracked : (read < tracked ? read : tracked)

      /*
       * Re-read the FEE for the same reason the balance is re-read, and it is a separate failure.
       *
       * `quote.nativeGasReserve` was derived from a fee read BEFORE any ERC-20 leg mined. On a
       * chain whose base fee is rising the transaction's own max fee is larger than the reserve set
       * aside for it, so `value + gas > balance` and the node refuses it for insufficient funds —
       * the coin is left behind, reported as a failure the member could do nothing about. A
       * REVERTING ERC-20 leg is the sharpest case, because a reverted transfer consumes its whole
       * gas limit, which is exactly what fills a block and lifts the base fee.
       *
       * Never reserve LESS than the quote did: a falling fee is not a reason to cut the margin the
       * member was quoted, and `raisedFeeSchedule` keeps this strictly safer than what it replaces.
       */
      const coinFee = await raisedFeeSchedule(provider, price, priority)
      price = coinFee.price
      priority = coinFee.priority
      const reserve = quote.nativeGasLimit * price
      const sendable = current > reserve ? current - reserve : 0n
      const detail = outcomeDetail({
        gasPrice: price,
        gasLimit: quote.nativeGasLimit,
        reserve,
        balance: current,
        coinBalance: current,
      })
      if (sendable <= 0n) {
        record({ asset, status: 'skipped', error: 'Not enough to cover the network fee.', detail })
        continue
      }
      /*
       * PIN the fee to the price the reserve was just sized from.
       *
       * `value` is `balance - gasLimit * price`, so the node's funding check
       * (`value + gasLimit * maxFeePerGas <= balance`) holds only while the price the transaction
       * carries is no higher than `price`. Left to ethers, that price is read AGAIN during
       * populate — a second read, at a later moment, with no margin between it and the reserve.
       * Whenever it comes back higher the coin is refused for insufficient funds and reported as
       * a failure the member could do nothing about, which is the whole failure this reserve
       * exists to prevent. Sending the price explicitly turns that inequality into an identity.
       *
       * Pinning is safe as well as exact: `price` is a max fee (base * 2 + tip on an EIP-1559
       * chain), so it still covers a base fee that climbs after the transaction is signed.
       */
      let coinTx = null
      try {
        coinTx = await signer.sendTransaction({
          to,
          value: sendable,
          gasLimit: quote.nativeGasLimit,
          nonce,
          ...pinnedFeeFields(price, priority),
        })
        nonce += 1
        const receipt = await coinTx.wait()
        coinSpent += coinSpentBy(coinTx, receipt, price)
        record({ asset, status: 'sent', txHash: coinTx.hash })
      } catch (e) {
        if (coinTx) coinSpent += coinSpentBy(coinTx, e?.receipt, price)
        record({ asset, status: 'failed', error: describeTransferFailure(e), detail })
      }
      continue
    }
    /*
     * The ERC-20 legs are priced on the SAME pinned schedule as the coin leg (issue #1301).
     *
     * Left to the library, each token transfer reads the fee again at populate time — so the coin
     * these legs burn is decided by a price the sweep never saw, taken out of the very balance the
     * coin leg's reserve is computed from. Pinning makes what a leg can cost knowable before it is
     * sent, which is what lets the reserve behind it be sized honestly; the schedule only ever
     * rises, so a token transfer is never pinned below a base fee that would leave it unmineable.
     */
    const tokenFee = await raisedFeeSchedule(provider, price, priority)
    price = tokenFee.price
    priority = tokenFee.priority
    let tokenTx = null
    try {
      const erc20 = new ethers.Contract(asset.address, TRANSFER_ABI, signer)
      tokenTx = await erc20.transfer(to, balance, { nonce, ...pinnedFeeFields(price, priority) })
      nonce += 1
      const receipt = await tokenTx.wait()
      coinSpent += coinSpentBy(tokenTx, receipt, price)
      record({ asset, status: 'sent', txHash: tokenTx.hash })
    } catch (e) {
      if (tokenTx) coinSpent += coinSpentBy(tokenTx, e?.receipt, price)
      const tracked = quotedCoin > coinSpent ? quotedCoin - coinSpent : 0n
      record({
        asset,
        status: 'failed',
        error: describeTransferFailure(e),
        detail: outcomeDetail({
          gasPrice: price,
          gasLimit: asBigInt(tokenTx?.gasLimit),
          reserve: quote.nativeGasLimit * price,
          balance,
          coinBalance: tracked,
        }),
      })
    }
  }

  return outcomes
}
