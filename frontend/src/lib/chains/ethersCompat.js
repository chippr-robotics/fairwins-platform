/**
 * The ethers SHAPE, shared by every viem-backed signer in this migration (spec 110 T028).
 *
 * `walletSigner` (the injected-wallet rail) and `localKeySigner` (a recovered key, a hardware
 * account) hand their callers the same duck type, and the parts that translate viem's answers
 * into ethers' spellings are identical between them. They live here rather than in either file
 * because two copies of this would drift, and the failures that drift produces are the quiet kind:
 * a receipt whose `status` is the string `'success'` reads as a FAILURE to every caller that
 * tests `=== 1`, and nothing throws.
 *
 * What the app's callers actually read, measured across `frontend/src` rather than assumed:
 * `sendTransaction` → `{hash, wait()}`, `getAddress`, `signMessage`, `signTypedData`, and on the
 * provider `getNetwork`/`getCode`/`getBalance`/`getTransactionReceipt`/`waitForTransaction`/
 * `getFeeData`/`call`/`getBlockNumber`. The provider ALSO owes what ethers' own `AbstractSigner`
 * calls on it — `getTransactionCount`, `broadcastTransaction`, `getBlock` — because a provider
 * handed to `wallet.connect(provider)` is populated and broadcast through by ethers itself; that
 * surface is theirs, not the app's, and leaving it out is what broke the acting-account purchase
 * on the on-chain tier (spec 110, divergence 27b).
 */
import { estimateFeeData } from './feeData'

/**
 * DIVERGENCE 29 — **`tx.wait()` RESOLVES on a reverted transaction where ethers THREW**, and the
 * whole app is written against the throw.
 *
 * ethers' `TransactionResponse.wait()` asserts on `receipt.status === 0` and raises
 * `CALL_EXCEPTION` carrying the receipt. viem's `waitForTransactionReceipt` returns the receipt
 * with `status: 'reverted'` and no error at all. Every converted caller here does
 * `await approveTx.wait()` and then proceeds — `MarketAcceptanceModal` approves and then PAYS,
 * `useOpenChallengeAccept` does the same, the legacy sweep records the asset as sent — so a
 * silently-resolving revert turns a failed approval into a payment against an allowance that was
 * never granted, and a failed transfer into an outcome that says the member's money moved.
 *
 * Nothing about that shows up as an error: it is a confident wrong answer, and it is the shape
 * this migration has had to watch for throughout. So the throw is reproduced, once, here —
 * `provider.getTransactionReceipt` and `provider.waitForTransaction` deliberately do NOT throw,
 * because ethers' own provider methods returned a status-0 receipt; only `wait()` asserted.
 */
export async function waitForReceipt(publicClient, hash, confirmations = 1) {
  const receipt = toEthersReceipt(
    await publicClient.waitForTransactionReceipt({ hash, confirmations }),
  )
  if (receipt.status === 0) {
    const error = new Error('transaction execution reverted')
    error.code = 'CALL_EXCEPTION'
    error.shortMessage = 'transaction execution reverted'
    error.reason = null
    error.receipt = receipt
    throw error
  }
  return receipt
}
/** viem's receipt, in the shape ethers' callers read. */
function toEthersReceipt(receipt) {
  return {
    ...receipt,
    // ethers v6 names it `hash`; viem keeps the RPC's `transactionHash`. Both are kept so a
    // caller reading either is right.
    hash: receipt.transactionHash,
    // ethers: 1 | 0. viem: 'success' | 'reverted'. A caller testing `status === 1` would read
    // EVERY successful receipt as a failure if this were passed through.
    status: receipt.status === 'success' ? 1 : 0,
    blockNumber: receipt.blockNumber == null ? receipt.blockNumber : Number(receipt.blockNumber),
    // gasUsed stays a bigint, as ethers returned it — callers `.toString()` it.
  }
}

/**
 * The ethers-`Provider`-shaped view of a viem public client.
 *
 * @param {import('viem').PublicClient} publicClient
 * @param {object} opts
 * @param {object|null} [opts.chain] - the chain this signer was BUILT for. `getNetwork()` answers
 *   from it rather than asking the wallet, because `settleWalletOn` tells a settled signer from a
 *   pre-switch one by that answer (divergence 27a); a live read makes a stale signer look current.
 * @param {string} [opts.account] - the default `from` for calls and estimates.
 */
export function providerLike(publicClient, { chain = null, account } = {}) {
  return {
    /*
     * DIVERGENCE 27 — `getNetwork()` answers with the chain this signer was BUILT FOR, not the
     * chain the wallet is on right now, and ethers' static network is what made that true.
     *
     * WalletContext built `new BrowserProvider(walletClient.transport, { chainId, name })` with
     * a FIXED network, so a pre-switch signer kept answering with its OLD chain. That is
     * load-bearing, not incidental: `settleWalletOn` tells a settled signer from a stale one by
     * asking exactly this question (`signerIsOn`), and waits until the signer's OWN provider
     * reports the target — because "the wallet is on the target chain" and "this signer belongs
     * to the target chain" are different facts, and pairing the new chainId with the pre-switch
     * signer is the race that check exists to lose safely.
     *
     * Asking the wallet live (`publicClient.getChainId()`) broke it: the moment the wallet
     * switched, a STALE signer answered with the target, `signerIsOn` said yes, the settle loop
     * handed back the pre-switch signer, and viem's chain assertion then refused the send. The
     * cross-chain wrap never reached its success notice — `45-wrap-cross-chain` WXC-01 on the
     * on-chain tier, with WXC-03's disabled Unwrap button following from the missing balance.
     *
     * The assertion in `sendTransaction` is KEPT for the same reason: ethers refused a stale send
     * too, as `network changed: 63 => 80002` from its fixed-network provider. Both libraries
     * refuse; only the way they answer `getNetwork` differed.
     */
    async getNetwork() {
      const configured = chain?.id
      if (configured != null) {
        return { chainId: BigInt(configured), name: chain?.name ?? `chain-${configured}` }
      }
      // No chain was configured (the window.ethereum fallback path): ask, as ethers' detecting
      // BrowserProvider did when it was given no network.
      const chainId = await publicClient.getChainId()
      return { chainId: BigInt(chainId), name: `chain-${chainId}` }
    },
    getCode: (addr) => publicClient.getBytecode({ address: addr }).then((code) => code ?? '0x'),
    getBalance: (addr) => publicClient.getBalance({ address: addr }),
    getBlockNumber: () => publicClient.getBlockNumber().then(Number),
    call: (tx) => publicClient.call({ to: tx.to, data: tx.data, account: tx.from ?? account }).then((r) => r.data ?? '0x'),
    estimateGas: (tx) => publicClient.estimateGas({ ...tx, account: tx.from ?? account }),
    async getTransactionReceipt(hash) {
      const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null)
      return receipt ? toEthersReceipt(receipt) : null
    },
    async waitForTransaction(hash, confirmations = 1) {
      return toEthersReceipt(await publicClient.waitForTransactionReceipt({ hash, confirmations }))
    },
    /*
     * THE PROVIDER IS HANDED TO OTHER LIBRARIES, so its surface is not "what the app calls on it".
     *
     * Found by the on-chain tier (`40-acting-account-purchase` AAP-03:
     * `checkProvider(...).getTransactionCount is not a function`). A recovered legacy account
     * signs with its OWN ethers signer — `legacyKeys.js` does `wallet.connect(provider)` — and
     * that signer POPULATES and BROADCASTS through whatever provider it was given, which on the
     * acting-account path is this one. An audit of `provider.x(` call sites could never have
     * found that: the caller is inside ethers.
     *
     * So these three are here to satisfy ethers' `AbstractSigner`, not the app:
     * `getTransactionCount` (nonce), `getFeeData` (already below), `estimateGas` + `getNetwork`
     * (above), and `broadcastTransaction` — the one `sendTransaction` ends in. `getBlock` rides
     * along because fee logic reaches for it. `src/test/chains/walletSigner.test.js` drives a real
     * `ethers.Wallet` connected to this object through a full send, which is the only check that
     * proves the shape rather than enumerating it.
     */
    getTransactionCount: (addr, blockTag = 'latest') =>
      publicClient.getTransactionCount({ address: addr, blockTag }),
    broadcastTransaction: async (signedTx) => {
      const hash = await publicClient.sendRawTransaction({ serializedTransaction: signedTx })
      return {
        hash,
        async wait(confirmations = 1) {
          return waitForReceipt(publicClient, hash, confirmations)
        },
      }
    },
    async getBlock(blockTagOrNumber = 'latest') {
      const block =
        typeof blockTagOrNumber === 'number'
          ? await publicClient.getBlock({ blockNumber: BigInt(blockTagOrNumber) })
          : await publicClient.getBlock({ blockTag: blockTagOrNumber })
      return { ...block, number: Number(block.number), timestamp: Number(block.timestamp) }
    },

    // ethers' fee policy, kept deliberately — see DIVERGENCE 28 in `feeData.js`.
    getFeeData: () => estimateFeeData(publicClient),
  }

}

export { toEthersReceipt }
