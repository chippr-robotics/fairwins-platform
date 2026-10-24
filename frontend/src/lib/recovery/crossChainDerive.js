/**
 * Cross-chain derivation from a recovered legacy secret (spec 063, US2/US3 / T008).
 *
 * Turns an unlocked recovered secret into the per-chain accounts it controls, so the
 * app can discover balances and move funds beyond the default Ethereum address:
 *   - EVM: the single address (works on every EVM chain; a raw private key stops here).
 *   - Solana: the candidate accounts across the schemes real wallets use (memory-only keys).
 *   - Bitcoin: the account handle (seed + ledger id) that legacyBitcoin discovery/send use.
 *
 * A recovered MNEMONIC yields the full multi-chain tree; a recovered PRIVATE KEY yields
 * only the EVM address (not a derivable tree, FR-013). ALL key material here is memory-only
 * (FR-017/018) — never persisted, logged, or transmitted.
 */

import { addressFromSecret } from './legacyKeys'
import { seedFromMnemonic } from '../bitcoin/legacyDerivation'
import { bitcoinAccountId } from '../bitcoin/legacyBitcoin'
import { deriveSolanaKeypair, SOLANA_SCHEMES } from '../solana/derivation'

/**
 * @param {{kind:'mnemonic'|'privateKey', secret:string}} recovered
 * @param {{ solanaAccounts?:number, bitcoinNetwork?:'bitcoin'|'bitcoin-testnet' }} [opts]
 * @returns {{
 *   kind:'mnemonic'|'privateKey',
 *   evm:{ address:string },
 *   derivable:boolean,
 *   seed?:Uint8Array,                       // memory-only (mnemonic case)
 *   solana?:Array<{scheme:string, account:number, address:string, pubkey:Uint8Array, secret:Uint8Array}>,
 *   bitcoin?:{ accountId:string, network:string },
 * }}
 */
export function deriveCrossChainAccounts(recovered, { solanaAccounts = 1, bitcoinNetwork = 'bitcoin' } = {}) {
  const { kind, secret } = recovered || {}
  const evm = { address: addressFromSecret({ kind, secret }) }

  // A raw private key is a single key — reusable across EVM, but NOT a derivable tree (FR-013).
  if (kind !== 'mnemonic') {
    return { kind, evm, derivable: false }
  }

  const seed = seedFromMnemonic(secret)

  // Solana candidates: each scheme at accounts 0..solanaAccounts-1 (bareSeed has no account).
  const solana = []
  for (const scheme of SOLANA_SCHEMES) {
    const accounts = scheme === 'bareSeed' ? [0] : Array.from({ length: solanaAccounts }, (_, i) => i)
    for (const account of accounts) {
      const kp = deriveSolanaKeypair(seed, { scheme, account })
      solana.push({ scheme, account, address: kp.address, pubkey: kp.pubkey, secret: kp.secret })
    }
  }

  return {
    kind,
    evm,
    derivable: true,
    seed,
    solana,
    bitcoin: { accountId: bitcoinAccountId(seed), network: bitcoinNetwork },
  }
}
