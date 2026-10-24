/**
 * Gasless peer-to-peer stablecoin transfer via EIP-3009 `transferWithAuthorization`
 * (Pay & Transfer, wallet feature). WITHOUT an app backend.
 *
 * This is the P2P sibling of the pool-join flow in `lib/pools/gasless.js`. A pool join signs
 * `ReceiveWithAuthorization` because the pool contract is BOTH caller and recipient; a wallet-to-wallet
 * payment signs `TransferWithAuthorization`, which lets ANY relayer submit `token.transferWithAuthorization`
 * and pay gas while the value moves `from → to`. The authorization binds amount + recipient and is
 * replay-protected by the token's own nonce, so the relayer is untrusted (it can censor, never steal or
 * redirect). When no relayer is configured, the sender transfers normally (paying gas) — gasless is purely
 * additive (the never-stranded rule, spec 035/036).
 *
 * The FairWins relay-gateway (services/relay-gateway) is a version-pinned allow-list for wager/membership
 * actions only, so it cannot relay an arbitrary token transfer. This path therefore targets the STABLECOIN
 * contract directly under the token's own EIP-712 domain (native Circle USDC version '2', bridged USDC.e
 * '1'), driven by `stablecoin.domainVersion` in config/networks.js — `null` means the token lacks EIP-3009
 * and this whole path is skipped in favour of a plain `transfer` (e.g. Mordor/ETC USC).
 */
import { toHex } from 'viem'
import { splitSignature } from '../evm/signature'
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from '@fairwins/intent-types'

/*
 * EIP-3009 typed-data for a wallet-to-wallet payment (any relayer may submit it) now comes from
 * @fairwins/intent-types, next to its `ReceiveWithAuthorization` sibling — the escrow-side leg that
 * spec 075 already consolidated. They are the same money path and the same six fields; leaving one
 * behind was how the sibling got two copies in the first place. Pinned to the typehash deployed
 * USDC verifies against by test/intent/TypehashParity.test.js.
 *
 * Re-exported so existing importers of this module are unaffected.
 */
export { TRANSFER_WITH_AUTHORIZATION_TYPES }

/** Minimal ABI for the self-submit fallback + the relayed authorization call. */
export const TRANSFER_ABI = [
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
]

/**
 * Produce a signed EIP-3009 authorization that lets a relayer move `value` from the sender to `to`.
 * @param {object} opts
 * @param {import('ethers').Signer} opts.signer - the sender's signer.
 * @param {string} opts.token - stablecoin contract address (the EIP-712 verifying contract).
 * @param {string} [opts.tokenName='USD Coin'] - token EIP-712 domain name.
 * @param {string} [opts.tokenVersion='2'] - token EIP-712 domain version (Circle USDC '2', USDC.e '1').
 * @param {number} opts.chainId
 * @param {string} opts.to - recipient address.
 * @param {bigint|string} opts.value - amount in the token's base units.
 * @param {number} [opts.nowSeconds] - override "now" (tests); defaults to wall-clock seconds.
 * @param {number} [opts.validitySeconds=3600] - window from now during which the authorization is valid.
 * @returns {Promise<object>} { from, to, value, validAfter, validBefore, nonce, v, r, s }
 */
export async function signTransferAuthorization({
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
  const domain = { name: tokenName, version: tokenVersion, chainId: Number(chainId), verifyingContract: token }
  const message = {
    from,
    to,
    value: value.toString(),
    // A small backdate absorbs clock skew between the signer and the relayer's node.
    validAfter: 0,
    validBefore: now + validitySeconds,
    nonce,
  }
  // `lib/evm/signature.js`, not viem's `parseSignature` — which refuses the 64-byte compact form a
  // wallet may return AND hands back `v` as a BIGINT where ethers gave a number. This authorization
  // is serialized to a relayer, and `JSON.stringify` throws on a bigint (spec 110, divergence 10).
  const sig = splitSignature(await signer.signTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, message))
  if (!sig) throw new Error('The wallet returned something that is not a signature, so nothing has been authorized.')
  return { from, to, value, validAfter: 0, validBefore: message.validBefore, nonce, v: sig.v, r: sig.r, s: sig.s }
}

/**
 * Resolve the pluggable transfer relayer. Returns a function
 * `(authorization, { token, chainId }) => Promise<{ txHash }>` when `VITE_TRANSFER_RELAYER_URL` is set,
 * else `null` so the caller self-submits. Kept intentionally thin: the endpoint receives only the token
 * address and the token-scoped authorization (no FairWins identity), matching the "can censor, cannot
 * steal" bound.
 */
export function getTransferRelayer() {
  const url = import.meta.env?.VITE_TRANSFER_RELAYER_URL
  if (!url) return null
  return async (authorization, { token, chainId }) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        chainId,
        authorization: {
          ...authorization,
          value: authorization.value.toString(),
        },
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Transfer relayer rejected the authorization (${res.status})${detail ? `: ${detail}` : ''}`)
    }
    const json = await res.json()
    const txHash = json?.txHash ?? json?.transactionHash ?? json?.hash
    if (!txHash) throw new Error('Transfer relayer response missing a transaction hash')
    return { txHash }
  }
}

/**
 * Relay a gasless transfer through a pluggable relayer. `relayer` is
 * `(authorization, { token, chainId }) => Promise<{ txHash }>`. A missing relayer throws a clear error so
 * the UI falls back to a normal (gas-paying) transfer. The context is identity-free — only the token +
 * chain travel alongside the token-scoped authorization.
 */
export async function relayGaslessTransfer(relayer, authorization, { token, chainId }) {
  if (typeof relayer !== 'function') {
    throw new Error('No gasless relayer configured. Send normally (you pay gas), or configure a relayer.')
  }
  return relayer(authorization, { token, chainId })
}
