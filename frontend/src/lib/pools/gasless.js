/**
 * Client-side gasless join for Wager Pools (spec 034, US3, address-based) — WITHOUT an app backend.
 *
 * The "no-backend footprint" directive forbids a FairWins server, so there is no "Payload Packer"
 * service. Instead the client signs an EIP-3009 `ReceiveWithAuthorization` here; a THIRD-PARTY relayer
 * (e.g. Gelato/Biconomy/OZ Defender, or the user's own) submits `WagerPool.joinWithAuthorization` and
 * pays gas. The join is identity-free: membership is keyed by the member's public wallet address, so the
 * only thing signed is the EIP-3009 authorization that pulls USDC into the pool. The authorization binds
 * amount + recipient and is replay-protected by the token, so the relayer is untrusted (it can censor,
 * never steal). When no relayer is configured, the member joins normally (paying gas) — gasless is purely
 * additive.
 */
import { toHex } from 'viem'
import { splitSignature } from '../evm/signature'

// Single source: @fairwins/intent-types (spec 075, FR-025). This table was previously duplicated
// here AND in services/relay-gateway/src/intent/intentTypes.js, kept in step by hand. It is the
// money path — EIP-3009 `joinWithAuthorization` and stake pulls — so a silent divergence would
// produce signatures that do not verify against real USDC.
import { RECEIVE_WITH_AUTHORIZATION_TYPES } from '@fairwins/intent-types'

// Re-exported for existing callers that import it from here.
export { RECEIVE_WITH_AUTHORIZATION_TYPES }

/**
 * Produce a signed EIP-3009 authorization that lets a relayer pull `value` from the member into the pool.
 * @returns {Promise<object>} { from, to, value, validAfter, validBefore, nonce, v, r, s }
 */
export async function signReceiveAuthorization({
  signer,
  token,
  tokenName = 'USD Coin',
  tokenVersion = '2',
  chainId,
  to,
  value,
  nowSeconds,
  validitySeconds = 3600,
}) {
  const from = await signer.getAddress()
  const now = nowSeconds != null ? nowSeconds : Math.floor(Date.now() / 1000)
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const domain = { name: tokenName, version: tokenVersion, chainId, verifyingContract: token }
  const message = { from, to, value: value.toString(), validAfter: 0, validBefore: now + validitySeconds, nonce }
  // `lib/evm/signature.js`, not viem's `parseSignature` — which refuses the 64-byte compact form a
  // wallet may return AND hands back `v` as a BIGINT where ethers gave a number. This object is
  // handed to a third-party relayer and serialized, and `JSON.stringify` throws on a bigint, so the
  // swap would have turned a working gasless join into a failed one on the money path.
  const sig = splitSignature(await signer.signTypedData(domain, RECEIVE_WITH_AUTHORIZATION_TYPES, message))
  if (!sig) throw new Error('The wallet returned something that is not a signature, so nothing has been authorized.')
  return { from, to, value, validAfter: 0, validBefore: message.validBefore, nonce, v: sig.v, r: sig.r, s: sig.s }
}

/**
 * Relay a gasless join via a pluggable third-party relayer. `relayer` is a function
 * (authorization, { pool }) => Promise<{ txHash }>. No relayer ⇒ a clear error so the UI falls back to a
 * normal (gas-paying) join. This keeps gas abstraction entirely off the FairWins footprint (no app
 * backend). The join is identity-free — only the pool address is passed alongside the authorization.
 */
export async function relayGaslessJoin(relayer, authorization, { pool }) {
  if (typeof relayer !== 'function') {
    throw new Error('No gasless relayer configured. Join normally (you pay gas), or configure a third-party relayer.')
  }
  return relayer(authorization, { pool })
}
