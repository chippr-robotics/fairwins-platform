/**
 * Send EVM transactions signed by a GCP KMS key.
 *
 * Why this exists
 * ---------------
 * `services/relay-gateway/src/paymaster/sign.js` can already sign a MESSAGE with a KMS key
 * (EIP-191, for ERC-7677 paymaster authorizations), and
 * `scripts/operations/relayer/kms-gas-address.js` can already derive the ADDRESS from a KMS public
 * key. Neither can produce a signed *transaction*, which is what an owner needs in order to send
 * `approveHash` — and therefore what a KMS key needs in order to participate in the admin Safe at
 * all. This closes that gap.
 *
 * The whole trick is one line: KMS `EC_SIGN_SECP256K1_SHA256` signs the 32 bytes you hand it in
 * `digest.sha256`. It does not verify that those bytes came from SHA-256. So an Ethereum signature
 * is produced by passing `keccak256(rlp(unsignedTx))` — the transaction's `unsignedHash` — where
 * paymaster/sign.js passes an EIP-191 message digest instead. Everything else (DER→{r,s}, low-S
 * normalisation, recovering `v` by parity trial) is identical.
 *
 * NOTE ON DUPLICATION: this is the fourth SPKI→point/DER→rs implementation in the repo
 * (paymaster/sign.js, kms-gas-address.js, the oz-relayer Rust signer, here). They are duplicated
 * because the first is ESM inside a workspace package and this must be CommonJS under scripts/.
 * Consolidating them into a shared package under `packages/` is worth doing; adding a fifth is not.
 *
 * Usage:
 *   const { createKmsTransactionSigner } = require('./lib/kmsSigner');
 *   const signer = await createKmsTransactionSigner({ keyName: KMS_KEY, provider });
 *   const receipt = await signer.sendTransaction({ to, data });
 */
const { ethers } = require('ethers');

const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

/** SubjectPublicKeyInfo PEM → 128-hex-char raw (x||y) uncompressed public key (drops the 0x04 tag). */
function spkiDerToRawPubKey(pem) {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  const point = der.subarray(der.length - 65);
  if (point[0] !== 0x04) throw new Error('KMS public key is not an uncompressed EC point');
  return point.subarray(1).toString('hex');
}

/** DER ECDSA signature → { r, s } hex, low-S normalised (EIP-2). */
function derToRs(der) {
  const buf = Buffer.from(der);
  let o = 2;
  if (buf[o] !== 0x02) throw new Error('bad DER: r');
  const rLen = buf[o + 1];
  const r = buf.subarray(o + 2, o + 2 + rLen);
  o = o + 2 + rLen;
  if (buf[o] !== 0x02) throw new Error('bad DER: s');
  const sLen = buf[o + 1];
  const s = buf.subarray(o + 2, o + 2 + sLen);

  const toBig = (b) => BigInt('0x' + b.toString('hex'));
  let sBig = toBig(s);
  if (sBig > SECP256K1_N / 2n) sBig = SECP256K1_N - sBig;
  const hex32 = (n) => '0x' + n.toString(16).padStart(64, '0');
  return { r: hex32(toBig(r) & ((1n << 256n) - 1n)), s: hex32(sBig) };
}

/**
 * @param {object}  opts
 * @param {string}  opts.keyName  full KMS resource name (projects/…/cryptoKeyVersions/1)
 * @param {object}  opts.provider ethers Provider, already pointed at the target chain
 */
async function createKmsTransactionSigner({ keyName, provider }) {
  const { KeyManagementServiceClient } = require('@google-cloud/kms');
  const client = new KeyManagementServiceClient();

  const [pub] = await client.getPublicKey({ name: keyName });
  const address = ethers.computeAddress('0x' + spkiDerToRawPubKey(pub.pem));

  /** Sign a raw 32-byte digest, returning an ethers Signature with the correct `v`. */
  async function signDigest(digestHex) {
    const [res] = await client.asymmetricSign({
      name: keyName,
      digest: { sha256: ethers.getBytes(digestHex) },
    });
    const { r, s } = derToRs(res.signature);
    for (const v of [27, 28]) {
      const sig = ethers.Signature.from({ r, s, v });
      // recoverAddress over the RAW digest — the tx hash is already the thing that was signed.
      if (ethers.recoverAddress(digestHex, sig) === address) return sig;
    }
    throw new Error('KMS signature: could not recover signer parity — wrong key for this address?');
  }

  /**
   * Build, sign and broadcast a transaction. Returns the mined receipt.
   *
   * TYPE IS CHOSEN BY ASKING THE CHAIN, NOT BY A LIST. Ethereum Classic never adopted EIP-1559, so
   * Mordor 63 and ETC 61 reject a type-2 transaction outright:
   *
   *     transaction type not supported: type 2 rejected, pool not yet in London
   *
   * This signer hardcoded `type: 2` and, having had no callers until now, had never met that. The
   * detection is the same fact the error names: a chain that has activated London puts
   * `baseFeePerGas` in its blocks, and one that has not does not. Reading it self-corrects if ETC
   * ever activates London, where a hardcoded chain-id list would silently keep sending legacy
   * transactions and overpaying forever.
   *
   * Note `getFeeData()` is NOT a reliable signal here — ethers synthesises `maxFeePerGas` from
   * `gasPrice` on a pre-London chain, so it comes back non-null and looks like 1559 support.
   */
  async function sendTransaction({ to, data = '0x', value = 0n, gasLimit }) {
    const [net, nonce, fee, block] = await Promise.all([
      provider.getNetwork(),
      provider.getTransactionCount(address, 'pending'),
      provider.getFeeData(),
      provider.getBlock('latest'),
    ]);

    const limit = gasLimit ?? ((await provider.estimateGas({ from: address, to, data, value })) * 12n) / 10n;
    const london = block?.baseFeePerGas != null;

    const common = { chainId: net.chainId, to, data, value, nonce, gasLimit: limit };
    const tx = ethers.Transaction.from(
      london
        ? { ...common, type: 2, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }
        // Pre-London: type 0 with a flat gasPrice. `fee.gasPrice` is what the node itself suggests.
        : { ...common, type: 0, gasPrice: fee.gasPrice },
    );

    tx.signature = await signDigest(tx.unsignedHash);
    const sent = await provider.broadcastTransaction(tx.serialized);
    return sent.wait();
  }

  return { address, signDigest, sendTransaction };
}

module.exports = { createKmsTransactionSigner, spkiDerToRawPubKey, derToRs };
