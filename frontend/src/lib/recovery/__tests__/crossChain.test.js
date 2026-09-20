// Spec 063 (T008/T009) — cross-chain derivation + discovery from a recovered secret.

import { describe, it, expect, vi } from 'vitest'
import { deriveCrossChainAccounts } from '../crossChainDerive'
import { discoverCrossChain } from '../crossChainDiscovery'
import { ledgerStore } from '../../bitcoin/wallet'

// The `registerEthersCrypto` shim was here for `ethers.HDNodeWallet.fromPhrase` under jsdom.
// Nothing this file reaches derives through ethers any more (spec 110: `crossChainDerive` takes
// its EVM address from `addressFromSecret`, and the Bitcoin/Solana legs were always @scure), so
// the shim is gone rather than left as a setup step that reads like it is still protecting
// something.

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SOL0 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' // m/44'/501'/0'/0'
const BTC_SEGWIT0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'

function memStore() {
  const map = new Map()
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v) }
}

describe('deriveCrossChainAccounts', () => {
  it('derives EVM + Solana candidates + a Bitcoin handle from a mnemonic', () => {
    const d = deriveCrossChainAccounts({ kind: 'mnemonic', secret: MNEMONIC })
    expect(d.derivable).toBe(true)
    expect(d.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(d.solana.find((s) => s.scheme === 'bip44Change' && s.account === 0).address).toBe(SOL0)
    expect(d.bitcoin.accountId).toMatch(/^legacy:[0-9a-f]{8}$/)
    expect(d.seed).toBeInstanceOf(Uint8Array)
  })

  it('stops at the EVM address for a raw private key (not a derivable tree)', () => {
    // A valid 32-byte private key (the "abandon" seed's default EVM key is fine; use a fixed key).
    const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
    const d = deriveCrossChainAccounts({ kind: 'privateKey', secret: key })
    expect(d.derivable).toBe(false)
    expect(d.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(d.solana).toBeUndefined()
    expect(d.bitcoin).toBeUndefined()
  })
})

describe('discoverCrossChain — honest per-chain states', () => {
  const derived = () => deriveCrossChainAccounts({ kind: 'mnemonic', secret: MNEMONIC })

  it('finds a funded Solana account and skips empty ones', async () => {
    const solanaRpc = {
      getBalance: vi.fn(async (addr) => (addr === SOL0 ? 3_000_000_000n : 0n)),
      getSignaturesForAddress: vi.fn(async () => []),
    }
    const res = await discoverCrossChain({ derived: derived(), solanaRpc })
    const found = res.solana.filter((s) => s.status === 'found')
    expect(found).toHaveLength(1)
    expect(found[0].address).toBe(SOL0)
    expect(found[0].balanceLamports).toBe(3_000_000_000n)
  })

  it('marks a Solana account unreachable on RPC error (never zero)', async () => {
    const solanaRpc = {
      getBalance: vi.fn(async () => { throw new Error('rpc down') }),
      getSignaturesForAddress: vi.fn(async () => []),
    }
    const res = await discoverCrossChain({ derived: derived(), solanaRpc })
    expect(res.solana.every((s) => s.status === 'unreachable')).toBe(true)
  })

  it('discovers Bitcoin holdings via the gateway and reports complete', async () => {
    const bitcoinGateway = {
      lookupAddresses: vi.fn(async (_n, addresses) => ({
        ok: true, tipHeight: 100,
        results: addresses.map((address) => ({
          address,
          confirmedSats: address === BTC_SEGWIT0 ? 750000 : 0,
          pendingSats: 0,
          utxos: address === BTC_SEGWIT0 ? [{ txid: 'bb'.repeat(32), vout: 0, valueSats: 750000, confirmations: 3 }] : [],
          hasHistory: address === BTC_SEGWIT0,
        })),
      })),
      getStamps: vi.fn(async () => ({ ok: true, degraded: false, stamps: [] })),
    }
    const res = await discoverCrossChain({ derived: derived(), bitcoinGateway, bitcoinStore: ledgerStore(memStore()) })
    expect(res.bitcoin.status).toBe('complete')
    expect(res.bitcoin.confirmedSats).toBe(750000)
    expect(res.bitcoin.spendableSats).toBe(750000) // segwit ⇒ spendable
  })

  it('isolates a Solana failure from Bitcoin success (one chain never blocks another)', async () => {
    const solanaRpc = { getBalance: vi.fn(async () => { throw new Error('down') }), getSignaturesForAddress: vi.fn(async () => []) }
    const bitcoinGateway = {
      lookupAddresses: vi.fn(async (_n, addresses) => ({ ok: true, tipHeight: 1, results: addresses.map((address) => ({ address, confirmedSats: 0, pendingSats: 0, utxos: [], hasHistory: false })) })),
      getStamps: vi.fn(async () => ({ ok: true, degraded: false, stamps: [] })),
    }
    const res = await discoverCrossChain({ derived: derived(), solanaRpc, bitcoinGateway, bitcoinStore: ledgerStore(memStore()) })
    expect(res.solana.every((s) => s.status === 'unreachable')).toBe(true)
    expect(res.bitcoin.status).toBe('complete') // reachable, just empty — NOT an error
  })
})
