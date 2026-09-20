/**
 * Legacy key & word-list recovery library (Recovery section).
 *
 * Real crypto, real signing, no mocked library — so the tests exercise the actual
 * classification, at-rest encryption, vault, and sweep-quote math. The network is a fake
 * EIP-1193 node that a REAL viem client is built over, and the nonce assertions read the signed
 * envelope back off the wire rather than an object the test handed the signer.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPublicClient, custom, parseTransaction, keccak256 } from 'viem'
import {
  classifySecret,
  encryptLegacySecret,
  decryptLegacySecret,
  legacyKeyVault,
  quoteNativeSweep,
  sweepNativeToSmartAccount,
  addressFromSecret,
  signerForSecret,
} from '../../lib/recovery/legacyKeys'

// Hardhat account #0 — private key and 12-word mnemonic both resolve to this.
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const MNEMONIC = 'test test test test test test test test test test test junk'
const EXPECTED_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

describe('classifySecret', () => {
  it('recognizes a 0x-prefixed private key and derives its address', () => {
    const c = classifySecret(PK)
    expect(c.kind).toBe('privateKey')
    expect(c.address).toBe(EXPECTED_ADDR)
    expect(c.secret).toBe(PK)
  })

  it('accepts a private key without the 0x prefix', () => {
    const c = classifySecret(PK.slice(2))
    expect(c.kind).toBe('privateKey')
    expect(c.address).toBe(EXPECTED_ADDR)
  })

  it('recognizes a valid BIP-39 word list and normalizes case/whitespace', () => {
    const c = classifySecret(`  ${MNEMONIC.toUpperCase()}  `)
    expect(c.kind).toBe('mnemonic')
    expect(c.address).toBe(EXPECTED_ADDR)
    expect(c.wordCount).toBe(12)
    expect(c.secret).toBe(MNEMONIC)
  })

  it('flags empty input and gibberish distinctly', () => {
    expect(classifySecret('').kind).toBe('empty')
    expect(classifySecret('   ').kind).toBe('empty')
    expect(classifySecret('not a real key at all').kind).toBe('invalid')
    // 12 words but a bad checksum ⇒ invalid, never a false positive.
    expect(classifySecret('test test test test test test test test test test test test').kind).toBe('invalid')
    // Right length hex but not 64 nibbles.
    expect(classifySecret('0x1234').kind).toBe('invalid')
  })

  it('refuses a 64-hex string that is not a valid secp256k1 key', () => {
    // Shape alone is not validity: zero and anything at or above the curve order are the right
    // length and control nothing. ethers refused them and so does viem (checked in both
    // libraries), but the refusal here rides on a try/catch around the derivation rather than on
    // a rule of this module's own — so it is asserted, not assumed.
    expect(classifySecret('0x' + '00'.repeat(32)).kind).toBe('invalid')
    expect(classifySecret('0x' + 'ff'.repeat(32)).kind).toBe('invalid')
    // Exactly the curve order n — the first value that is one too many.
    expect(classifySecret('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141').kind).toBe('invalid')
  })
})

describe('encrypt/decrypt at rest', () => {
  it('round-trips a private key under the right passphrase', async () => {
    const c = classifySecret(PK)
    const entry = await encryptLegacySecret({ secret: c.secret, kind: c.kind, address: c.address, passphrase: 'correct horse', deps: { now: 111 } })
    expect(entry.address).toBe(EXPECTED_ADDR)
    expect(entry.importedAt).toBe(111)
    // The ciphertext must not leak the secret.
    expect(JSON.stringify(entry)).not.toContain(PK)
    const back = await decryptLegacySecret({ entry, passphrase: 'correct horse' })
    expect(back).toBe(PK)
  })

  it('round-trips a mnemonic', async () => {
    const c = classifySecret(MNEMONIC)
    const entry = await encryptLegacySecret({ secret: c.secret, kind: c.kind, address: c.address, passphrase: 'passw0rd!' })
    const back = await decryptLegacySecret({ entry, passphrase: 'passw0rd!' })
    expect(back).toBe(MNEMONIC)
  })

  it('rejects a wrong passphrase without leaking data', async () => {
    const c = classifySecret(PK)
    const entry = await encryptLegacySecret({ secret: c.secret, kind: c.kind, address: c.address, passphrase: 'right-one-here' })
    await expect(decryptLegacySecret({ entry, passphrase: 'wrong-one-here' })).rejects.toThrow(/did not unlock/i)
  })

  it('refuses a too-short passphrase', async () => {
    await expect(
      encryptLegacySecret({ secret: PK, kind: 'privateKey', address: EXPECTED_ADDR, passphrase: 'short' })
    ).rejects.toThrow(/at least 8/i)
  })
})

describe('legacyKeyVault', () => {
  // Per-account vault backed by an injected in-memory map (bypasses userStorage).
  const account = '0x' + '1'.repeat(40)
  let mem
  let deps
  beforeEach(() => {
    mem = {}
    deps = { load: () => mem, save: (_acc, m) => { mem = m } }
  })

  it('stores by lowercased address, lists newest-first, and deletes', () => {
    const vault = legacyKeyVault(account, deps)
    vault.set({ address: EXPECTED_ADDR, kind: 'privateKey', importedAt: 100 })
    vault.set({ address: '0x' + 'b'.repeat(40), kind: 'mnemonic', importedAt: 200 })
    expect(vault.list().map((e) => e.importedAt)).toEqual([200, 100])
    expect(vault.has(EXPECTED_ADDR.toLowerCase())).toBe(true)
    expect(vault.get(EXPECTED_ADDR.toUpperCase())).toBeTruthy()
    vault.delete(EXPECTED_ADDR)
    expect(vault.has(EXPECTED_ADDR)).toBe(false)
    expect(vault.list()).toHaveLength(1)
  })

  it('re-storing the same address replaces rather than duplicates', () => {
    const vault = legacyKeyVault(account, deps)
    vault.set({ address: EXPECTED_ADDR, kind: 'privateKey', importedAt: 1 })
    vault.set({ address: EXPECTED_ADDR.toLowerCase(), kind: 'privateKey', importedAt: 2 })
    expect(vault.list()).toHaveLength(1)
    expect(vault.get(EXPECTED_ADDR).importedAt).toBe(2)
  })
})

/**
 * A node that answers the handful of calls a native sweep makes, and PARSES what it is asked to
 * broadcast. The nonce a test asserts on therefore comes out of a signed transaction, which is
 * the only version of it a chain would ever see.
 */
function makeNode({ balance = 0n, gasPrice = 2_000_000_000n, chainId = 1, nonce = 0, fail = null } = {}) {
  const sent = []
  const receipts = new Map()
  let count = nonce
  const hex = (v) => `0x${BigInt(v).toString(16)}`
  const request = async ({ method, params }) => {
    switch (method) {
      case 'eth_chainId': return hex(chainId)
      case 'eth_blockNumber': return '0x64'
      case 'eth_getBalance': return hex(balance)
      case 'eth_getTransactionCount': return hex(count)
      case 'eth_gasPrice': return hex(gasPrice)
      case 'eth_maxPriorityFeePerGas': return '0x0'
      case 'eth_estimateGas': return '0x5208'
      case 'eth_getBlockByNumber': return {
        number: '0x64', hash: '0x' + 'aa'.repeat(32), parentHash: '0x' + 'bb'.repeat(32),
        timestamp: '0x65000000', gasLimit: '0x1c9c380', gasUsed: '0x5208',
        miner: '0x' + '11'.repeat(20), transactions: [], difficulty: '0x0', totalDifficulty: '0x0',
        extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000',
        size: '0x100', stateRoot: '0x' + 'cc'.repeat(32), receiptsRoot: '0x' + 'dd'.repeat(32),
        transactionsRoot: '0x' + 'ee'.repeat(32), sha3Uncles: '0x' + 'ff'.repeat(32),
        uncles: [], mixHash: '0x' + '00'.repeat(32), baseFeePerGas: hex(gasPrice / 2n),
      }
      case 'eth_sendRawTransaction': {
        if (fail?.()) throw Object.assign(new Error('nonce too low'), { code: -32000 })
        const tx = parseTransaction(params[0])
        sent.push(tx)
        const hash = keccak256(params[0])
        receipts.set(hash, {
          transactionHash: hash, transactionIndex: '0x0', blockHash: '0x' + 'cd'.repeat(32),
          blockNumber: '0x65', from: EXPECTED_ADDR, to: tx.to, cumulativeGasUsed: '0x0',
          gasUsed: '0x0', contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256),
          status: '0x1', type: '0x2', effectiveGasPrice: hex(gasPrice),
        })
        return hash
      }
      case 'eth_getTransactionReceipt': return receipts.get(params[0]) ?? null
      default:
        throw Object.assign(new Error(`the method ${method} does not exist`), { code: -32601 })
    }
  }
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:0'] } } }
  return {
    sent,
    client: createPublicClient({ chain, transport: custom({ request }) }),
    /** Let the node catch up with what it has been handed (the non-stale case). */
    advanceTo: (n) => { count = n },
  }
}

describe('native sweep', () => {
  const to = '0x' + 'c'.repeat(40)
  const GAS = 2_000_000_000n

  it('quotes sendable = balance minus a padded gas reserve', async () => {
    const { client } = makeNode({ balance: 10n ** 17n }) // 0.1 ETH
    const q = await quoteNativeSweep({ kind: 'privateKey', secret: PK, client })
    expect(q.from).toBe(EXPECTED_ADDR)
    // reserve = 21000 * 2gwei * 1.2
    const expectedReserve = (21000n * GAS * 12n) / 10n
    expect(q.gasReserve).toBe(expectedReserve)
    expect(q.sendable).toBe(10n ** 17n - expectedReserve)
  })

  it('reports zero sendable when the balance cannot cover the fee', async () => {
    const { client } = makeNode({ balance: 1000n })
    const q = await quoteNativeSweep({ kind: 'privateKey', secret: PK, client })
    expect(q.sendable).toBe(0n)
  })

  it('sweep refuses an invalid destination', async () => {
    await expect(
      sweepNativeToSmartAccount({ kind: 'privateKey', secret: PK, to: 'nope', client: makeNode({ balance: 10n ** 18n }).client })
    ).rejects.toThrow(/valid destination/i)
  })

  it('sweep refuses when there is nothing to move after fees', async () => {
    await expect(
      sweepNativeToSmartAccount({ kind: 'privateKey', secret: PK, to, client: makeNode({ balance: 1n }).client })
    ).rejects.toThrow(/nothing to transfer/i)
  })

  it('addressFromSecret derives the same address for key and phrase', () => {
    expect(addressFromSecret({ kind: 'privateKey', secret: PK })).toBe(EXPECTED_ADDR)
    expect(addressFromSecret({ kind: 'mnemonic', secret: MNEMONIC })).toBe(EXPECTED_ADDR)
  })
})

/*
 * The nonce discipline, pinned rather than taken on trust.
 *
 * A signer that asks the node for its nonce on every send can be handed the SAME one twice when a
 * node has not caught up with the transaction before it — approve then pay, or a sweep's
 * consecutive transfers — and the second is refused "nonce too low". The spec-098 recovered-
 * account purchase failed exactly that way in CI.
 *
 * `ManagedLegacySigner` (an `ethers.NonceManager` subclass) is gone; its properties are not. Each
 * test below drives a DIFFERENT chain id, because the nonce state is keyed per (account, chain)
 * and shared across a module — two tests on one chain would be one test with extra steps.
 */
describe('signerForSecret — nonces', () => {
  const to = '0x' + 'c'.repeat(40)
  const send = (signer) => signer.sendTransaction({ to, value: 1n })

  it('assigns consecutive nonces when the node answer is stale', async () => {
    // The node keeps answering 5 however many transactions it has taken — the stale case.
    const node = makeNode({ balance: 10n ** 18n, chainId: 1001, nonce: 5 })
    const signer = signerForSecret({ kind: 'privateKey', secret: PK }, { chainId: 1001, client: node.client })
    await send(signer)
    await send(signer)
    expect(node.sent.map((t) => t.nonce)).toEqual([5, 6])
  })

  /*
   * The zero case, which viem's own manager does NOT cover: its stale-read guard is written
   * `previousNonce > 0 && nonce <= previousNonce`, so an account whose last consumed nonce was 0
   * falls straight through it. A recovered account that has never sent anything is exactly that
   * account, and approve-then-pay is exactly the sequence it fails on.
   */
  it('assigns consecutive nonces from ZERO, where the library’s own guard does not apply', async () => {
    const node = makeNode({ balance: 10n ** 18n, chainId: 1002, nonce: 0 })
    const signer = signerForSecret({ kind: 'privateKey', secret: PK }, { chainId: 1002, client: node.client })
    await send(signer)
    await send(signer)
    await send(signer)
    expect(node.sent.map((t) => t.nonce)).toEqual([0, 1, 2])
  })

  it('gives a refused nonce back, so the next send does not skip a slot', async () => {
    let refuse = false
    const node = makeNode({ balance: 10n ** 18n, chainId: 1003, nonce: 0, fail: () => refuse })
    const signer = signerForSecret({ kind: 'privateKey', secret: PK }, { chainId: 1003, client: node.client })
    await send(signer)
    node.advanceTo(1)

    refuse = true
    await expect(send(signer)).rejects.toThrow()
    refuse = false

    // The refused transaction consumed nothing, so 1 is still free — not the 2 an un-reset
    // manager would have skipped ahead to, leaving a gap the node waits on forever.
    await send(signer)
    expect(node.sent.map((t) => t.nonce)).toEqual([0, 1])
  })

  /*
   * The floor is per (account, CHAIN), and the chain half has to be real.
   *
   * Every other test in this block uses a distinct chain id to keep module-level state out of its
   * neighbours' way, which means they would ALSO pass if the key collapsed to the address alone
   * and each test happened to run first. This one cannot: the same address sends on two chains in
   * one test, and a shared floor would carry chain A's count onto chain B — a recovered account
   * that had just swept on Polygon would start its first Mordor transaction several nonces into
   * the future and sit there unmined. viem sources the id from `chain.id` (or `eth_chainId`) and
   * `localKeySigner` always passes a chain, so `undefined` has no way in — asserted, not read.
   */
  it('keeps a separate floor per chain — one address on two chains does not share a count', async () => {
    const first = makeNode({ balance: 10n ** 18n, chainId: 1005, nonce: 0 })
    const second = makeNode({ balance: 10n ** 18n, chainId: 1006, nonce: 0 })

    const onFirst = signerForSecret({ kind: 'privateKey', secret: PK }, { chainId: 1005, client: first.client })
    await send(onFirst)
    await send(onFirst)
    expect(first.sent.map((t) => t.nonce)).toEqual([0, 1])

    // Chain 1006 has seen nothing from this account, so its first transaction is nonce 0 — not
    // the 2 a floor shared with chain 1005 would have handed it.
    const onSecond = signerForSecret({ kind: 'privateKey', secret: PK }, { chainId: 1006, client: second.client })
    await send(onSecond)
    expect(second.sent.map((t) => t.nonce)).toEqual([0])
    expect(second.sent[0].chainId, 'and it really was signed for the second chain').toBe(1006)
  })

  it('passes a caller’s own nonce through untouched — what the multi-asset sweep relies on', async () => {
    const node = makeNode({ balance: 10n ** 18n, chainId: 1004, nonce: 0 })
    const signer = signerForSecret({ kind: 'privateKey', secret: PK }, { chainId: 1004, client: node.client })
    await signer.sendTransaction({ to, value: 1n, nonce: 41 })
    await signer.sendTransaction({ to, value: 1n, nonce: 42 })
    expect(node.sent.map((t) => t.nonce)).toEqual([41, 42])
  })
})
