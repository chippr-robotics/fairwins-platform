/**
 * The ethers-shaped signer, on viem — spec 110 T028, the wallet rail.
 *
 * `WalletContext` hands ~90 call sites an object they use as
 * `signer.sendTransaction({to, data}) → tx.hash → await tx.wait()`. That object is currently an
 * ethers `JsonRpcSigner` wrapped around wagmi's `walletClient`, which is itself viem — so ethers
 * sits in the middle of a viem-to-viem path purely as a SHAPE. This module is that shape, built
 * on the viem clients directly, so the call sites keep their contract while the dependency goes.
 *
 * ── WHAT ethers' `JsonRpcSigner.sendTransaction` ACTUALLY DOES ──────────────────────────────────
 * Reading it is what made this tractable (provider-jsonrpc.js, `sendUncheckedTransaction`). Before
 * `eth_sendTransaction` it does exactly three things: sets `from`, resolves `to`, and — the one
 * that matters — **estimates gas when `gasLimit` is absent**, with the reason in its own comment:
 *
 *     // The JSON-RPC for eth_sendTransaction uses 90000 gas; if the user
 *     // wishes to use this, it is easy to specify explicitly, otherwise
 *     // we look it up for them.
 *
 * It does NOT fill nonce or fees; the wallet does that. So the "transaction population" that makes
 * `hardwareSigner` and `legacyKeys` a much bigger job is, on THIS rail, a single gas estimate.
 *
 * ── DIVERGENCE 25: viem does not make that estimate, and the difference is not cosmetic ─────────
 * `walletClient.sendTransaction` for a JSON-RPC account forwards to the wallet WITHOUT a `gas`
 * field unless one is supplied. Two things change if the estimate is simply dropped:
 *
 *   1. a wallet or node that applies the 90 000 default under-gases every write that needs more —
 *      the failure ethers' comment exists to prevent;
 *   2. **a transaction that would revert stops failing BEFORE the prompt.** Today the estimate
 *      throws and the member sees "this will fail"; without it they are asked to sign, approve,
 *      and then watch it revert on chain having paid for it. Every confirm surface in this app is
 *      written against the first behaviour.
 *
 * So the estimate is reproduced here, in the same place and on the same condition, and the
 * differential test pins the RPC SEQUENCE (`eth_estimateGas` then `eth_sendTransaction` carrying a
 * `gas` field) rather than just the returned hash — a test that only checked the hash would pass
 * with the estimate deleted.
 *
 * ── WHAT IS DELIBERATELY NOT REPRODUCED ────────────────────────────────────────────────────────
 * ethers anchors on `eth_blockNumber` and then POLLS `eth_getTransactionByHash` until the tx is
 * visible, so it can return a replaceable `TransactionResponse`. Callers here read `.hash` and
 * `.wait()` and nothing else (measured across `frontend/src`), and viem's
 * `waitForTransactionReceipt` does its own replacement detection — so the adapter resolves as soon
 * as the wallet returns the hash. The visible difference is that "sent" renders a beat sooner.
 */
import { toHex } from 'viem'
import { primaryTypeOf } from '../evm/typedData'
import { providerLike, waitForReceipt } from './ethersCompat'

/**
 * @param {object} io
 * @param {import('viem').WalletClient} io.walletClient - the wagmi wallet client (the signer)
 * @param {import('viem').PublicClient} io.publicClient - reads + receipt waits for the same chain
 * @param {string} io.address - the account wagmi authorized
 * @returns {object} an object with the ethers-signer surface this app uses
 */
export function walletSigner({ walletClient, publicClient, address }) {
  if (!walletClient || !publicClient || !address) return null
  const account = walletClient.account ?? address

  const provider = providerLike(publicClient, { chain: walletClient.chain ?? null, account })

  return {
    provider,

    async getAddress() {
      return address
    },

    async estimateGas(tx) {
      return provider.estimateGas(tx)
    },

    async signMessage(message) {
      // ethers signs a STRING as its UTF-8 bytes and a byte array as-is; viem spells the second
      // form `{ raw }`. Passing bytes straight through would sign their JSON-ish coercion.
      const payload = typeof message === 'string' ? message : { raw: toHex(message) }
      return walletClient.signMessage({ account, message: payload })
    },

    async signTypedData(domain, types, value) {
      // ethers INFERS the primary type; viem requires it. `primaryTypeOf` is ethers' own rule
      // (the type no other type references), already checked against `TypedDataEncoder` over all
      // 32 intent tables — never `Object.keys(types)[0]`, which can name a SUB-type and sign a
      // valid signature over the wrong structure.
      const table = { ...types }
      delete table.EIP712Domain
      const primaryType = primaryTypeOf(table)
      if (!primaryType) {
        throw new Error('signTypedData: ambiguous typed-data table — no single primary type, so nothing has been signed.')
      }
      return walletClient.signTypedData({ account, domain, types: table, primaryType, message: value })
    },

    async sendTransaction(tx) {
      const request = {
        account,
        chain: walletClient.chain ?? null,
        to: tx.to,
        ...(tx.data !== undefined ? { data: tx.data } : {}),
        ...(tx.value !== undefined ? { value: BigInt(tx.value) } : {}),
      }
      // DIVERGENCE 25 (see the header): ethers estimates here when no gas limit was given, and
      // the app's confirm surfaces depend on a doomed transaction failing BEFORE the prompt.
      const gasLimit = tx.gasLimit ?? tx.gas
      request.gas =
        gasLimit != null
          ? BigInt(gasLimit)
          : await publicClient.estimateGas({
              account,
              to: tx.to,
              ...(tx.data !== undefined ? { data: tx.data } : {}),
              ...(tx.value !== undefined ? { value: BigInt(tx.value) } : {}),
            })

      const hash = await walletClient.sendTransaction(request)
      return {
        hash,
        async wait(confirmations = 1) {
          return waitForReceipt(publicClient, hash, confirmations)
        },
      }
    },
  }
}

export default walletSigner
