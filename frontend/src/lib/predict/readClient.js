/**
 * The ONE way Predict builds a CLOB client for READING the member's own state (spec 114 T036b/T036c): the order
 * tracker's lookups and the open-orders list. Reads need the member's cached CLOB session (L2 credentials) and the
 * account's address — never a signature — so the signer handed to the SDK can name the address and REFUSES to
 * sign. That is what lets a passkey session read exactly like a wallet session, and what guarantees a read can
 * never raise a ceremony or a wallet prompt.
 *
 * The client SHAPE (signature type + funder) follows the RESOLVED signer kind — `resolveTradeSigner`, the same
 * resolution `usePredictTrade` signs with — and not a raw `loginMethod` string, which `WalletContext` itself
 * documents as informational only.
 */
import { resolveTradeSigner } from './tradeSigner'
import { SIG_TYPE_POLY_1271 } from './clobSession'

/** A signer that can say which address it is and nothing else. */
export const readOnlySigner = (address) => ({
  getAddress: async () => address,
  _signTypedData: async () => {
    throw new Error('Reading the venue never signs.')
  },
})

/**
 * The SDK client options for a read, from the resolved signer kind. `canSign` is deliberately ignored: whether this
 * session could SIGN an order says nothing about whether it may READ.
 */
export function readClientOptions({ loginMethod, address, resolve = resolveTradeSigner } = {}) {
  const { kind } = resolve({ loginMethod, walletClient: null, address, credentialId: null })
  return kind === 'passkey' ? { signatureType: SIG_TYPE_POLY_1271, funderAddress: address } : {}
}
