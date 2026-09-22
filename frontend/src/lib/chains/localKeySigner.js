/**
 * The ethers-shaped signer for a key THIS APP HOLDS — spec 110 T028, the local-key rail.
 *
 * `walletSigner` covers the injected wallet, where the wallet populates the transaction. Here
 * nobody else will: a recovered legacy account (spec 062) signs with its own key, so the nonce,
 * the fees, the gas limit and the chain id all have to be filled in before anything is signed.
 * That is what made this a different job from the wallet rail rather than the same swap twice.
 *
 * ── WHAT viem ALREADY DOES, checked rather than assumed ────────────────────────────────────────
 * The populator does not have to be written. For a LOCAL account viem's `sendTransaction` runs
 * `prepareTransactionRequest`, which fills nonce, fees and gas exactly as ethers' `Wallet` did.
 * What needed checking was the nonce discipline `ManagedLegacySigner` was built for. viem's
 * `nonceManager` reproduces its three documented behaviours ALMOST exactly, and the exception is
 * the one that matters here, so read all four points together:
 *
 *   1. it tracks locally and increments per send, so two quick sends are n and n+1 even when the
 *      provider's own `eth_getTransactionCount` has not caught up;
 *   2. it refuses to go BACKWARDS — `if (previousNonce > 0 && nonce <= previousNonce) return
 *      previousNonce + 1` — which is the stale-read guard, and the reason the class existed;
 *   3. `sendTransaction` RESETS it when the send throws (`nonceManager.reset` in its catch), so a
 *      refused transaction does not leave a gap the next send would skip into; and it is bypassed
 *      entirely when the caller supplies its own nonce, which is what the multi-asset sweep does.
 *
 * **Except at nonce ZERO, where (2) does not hold** — and checking that is why it is written down
 * rather than taken on trust. `previousNonce > 0` makes the guard skip an account whose last
 * consumed nonce was 0, so a node still answering 0 hands the SECOND transaction the first's
 * nonce and it is refused "nonce too low". That is precisely the spec-098 failure the wrapper
 * class was written for — approve, then pay — and a recovered account that has never sent
 * anything is exactly the account it happens to. `nonceFloor` below closes it: a per-(account,
 * chain) floor of the last nonce actually consumed, applied in the manager's own SOURCE, so
 * viem's re-read per send is kept and only the zero case changes.
 *
 * ── DERIVATION IS THE WALLET-BREAKING PART, AND IT IS PROVEN ──────────────────────────────────
 * A member's recovered phrase must produce the SAME address it always did, or the app quietly
 * points them at an account that is not theirs. `ethers.HDNodeWallet.fromPhrase` and viem's
 * `mnemonicToAccount` both default to m/44'/60'/0'/0/0; that was checked over 300 generated
 * phrases (address AND private key), 500 private keys, 12- and 24-word lengths and the published
 * Hardhat vector before a line of this was written, and is pinned by
 * `src/test/recovery/derivationParity.test.js` — which keeps real ethers as the oracle over
 * generated input (40 phrases at both lengths, 100 keys, the phrase's PRIVATE KEY as well as its
 * address, and a signed message) rather than a fixture table that would only prove viem agrees
 * with whatever produced the fixtures. The one-off probe that preceded it ran 300 phrases and
 * 500 keys; the committed suite is sized to stay a gate rather than a benchmark.
 */
import { createWalletClient, custom, toHex } from 'viem'
import { privateKeyToAccount, mnemonicToAccount, createNonceManager } from 'viem/accounts'
import { getTransactionCount } from 'viem/actions'
import { getPublicClient } from './publicClient'
import { providerLike, waitForReceipt } from './ethersCompat'
import { primaryTypeOf } from '../evm/typedData'

/**
 * viem's nonce manager with the zero case closed (see the header).
 *
 * The floor lives in the SOURCE rather than around the manager, because that is the one place
 * every read passes through — `consume` reports the nonce it settled on via `source.set`, and the
 * next `get` refuses to answer at or below it. `reset` drops the floor as well as viem's own
 * cache: a send that threw consumed NOTHING, so the next one must be free to re-read the node and
 * come back with the same number.
 */
const nonceFloor = new Map() // `${address}.${chainId}` -> the last nonce actually consumed
const floorKey = ({ address, chainId }) => `${address}.${chainId}`
// viem's own `jsonRpc()` source is not exported from the package entry, so its one line is
// written out here: the PENDING count, which is what includes a transaction already in the pool.
const managedNonces = createNonceManager({
  source: {
    async get({ address, client, ...rest }) {
      const fresh = await getTransactionCount(client, { address, blockTag: 'pending' })
      const parameters = { address, ...rest }
      const floor = nonceFloor.get(floorKey(parameters))
      return floor != null && fresh <= floor ? floor + 1 : fresh
    },
    set(parameters, nonce) {
      nonceFloor.set(floorKey(parameters), nonce)
    },
  },
})

const nonceManager = {
  ...managedNonces,
  consume: (parameters) => managedNonces.consume(parameters),
  get: (parameters) => managedNonces.get(parameters),
  increment: (parameters) => managedNonces.increment(parameters),
  reset(parameters) {
    nonceFloor.delete(floorKey(parameters))
    return managedNonces.reset(parameters)
  },
}

/**
 * The viem account for a classified secret. Address derivation only — no chain, no network.
 *
 * @param {{kind: 'mnemonic'|'privateKey', secret: string}} classified
 * @param {{managed?: boolean}} [opts] - `managed` attaches the nonce manager above.
 */
export function localAccount({ kind, secret }, { managed = false } = {}) {
  const options = managed ? { nonceManager } : undefined
  return kind === 'mnemonic' ? mnemonicToAccount(secret, options) : privateKeyToAccount(secret, options)
}

/**
 * An ethers-shaped signer for a local key on a named chain.
 *
 * @param {object} args
 * @param {object} args.account - a viem local account (see `localAccount`)
 * @param {number} args.chainId - the chain it signs for; never ambient
 * @param {import('viem').PublicClient} [args.client] - injectable for tests; defaults to the
 *   spec-069 resolved client for `chainId`, which is the same endpoint the read seam uses.
 * @returns {object|null} the ethers duck type, or null when the chain has no RPC route
 */
export function localKeySigner({ account, chainId, client }) {
  const publicClient = client ?? getPublicClient(chainId)
  if (!account || !publicClient) return null
  const chain = publicClient.chain ?? { id: Number(chainId) }

  /*
   * One wallet client over the SAME transport the reads use, so a populated nonce and the balance
   * it was checked against come from one node rather than two.
   *
   * `retryCount: 0` for the reason the read seam has it (DIVERGENCE 24): viem's default is three
   * retries at 150ms, and this transport DELEGATES to `publicClient.request`, which carries its
   * own policy — so the default here does not add retries, it MULTIPLIES them. It also applies to
   * probes that are supposed to fail: viem asks a node for `eth_fillTransaction` before it
   * populates, and a node that answers anything other than "method not found" is asked four times,
   * on every send, before the real work starts. Measured at 5.3s per transfer against a node that
   * refused it in the wrong words — on a sweep, once per asset.
   */
  const walletClient = createWalletClient({
    account,
    chain,
    transport: custom({ request: (args) => publicClient.request(args) }, { retryCount: 0 }),
  })

  const provider = providerLike(publicClient, { chain, account: account.address })

  return {
    provider,
    address: account.address,
    account,

    async getAddress() {
      return account.address
    },

    // ethers' signers carry this (`AbstractSigner.estimateGas`), and two call sites read it off
    // whatever signer is acting — one of which can be a recovered account (`useFriendMarketCreation`).
    async estimateGas(tx) {
      return provider.estimateGas(tx)
    },

    async signMessage(message) {
      // ethers signs a STRING as its UTF-8 bytes and a byte array as-is; viem spells the second
      // form `{ raw }`. Byte-identical to `ethers.Wallet.signMessage` over the same key.
      const payload = typeof message === 'string' ? message : { raw: toHex(message) }
      return account.signMessage({ message: payload })
    },

    async signTypedData(domain, types, value) {
      const table = { ...types }
      delete table.EIP712Domain
      const primaryType = primaryTypeOf(table)
      if (!primaryType) {
        throw new Error('signTypedData: ambiguous typed-data table — no single primary type, so nothing has been signed.')
      }
      return account.signTypedData({ domain, types: table, primaryType, message: value })
    },

    /**
     * Send, populating whatever the caller did not pin.
     *
     * Every field the caller DOES pin is passed through untouched — the sweep pins its own nonce
     * and its own fee schedule precisely so that what a leg can cost is knowable before it is
     * sent, and a populator that re-read either would undo the reserve those numbers were sized
     * from (spec 062, issues #1301/#1327).
     */
    async sendTransaction(tx = {}) {
      const request = {
        account,
        chain,
        to: tx.to,
        ...(tx.data !== undefined ? { data: tx.data } : {}),
        ...(tx.value !== undefined ? { value: BigInt(tx.value) } : {}),
        ...(tx.nonce != null ? { nonce: Number(tx.nonce) } : {}),
        ...(tx.gasLimit != null ? { gas: BigInt(tx.gasLimit) } : {}),
        ...(tx.gas != null ? { gas: BigInt(tx.gas) } : {}),
        ...(tx.maxFeePerGas != null ? { maxFeePerGas: BigInt(tx.maxFeePerGas) } : {}),
        ...(tx.maxPriorityFeePerGas != null
          ? { maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) }
          : {}),
        ...(tx.gasPrice != null ? { gasPrice: BigInt(tx.gasPrice) } : {}),
      }
      const hash = await walletClient.sendTransaction(request)
      return {
        hash,
        // Carried so a caller can price what it sent without a receipt (`coinSpentBy`).
        gasLimit: request.gas ?? null,
        nonce: request.nonce ?? null,
        async wait(confirmations = 1) {
          return waitForReceipt(publicClient, hash, confirmations)
        },
      }
    },
  }
}

export default localKeySigner
