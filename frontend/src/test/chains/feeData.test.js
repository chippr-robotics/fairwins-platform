/**
 * The fee read, checked against the REAL ethers `getFeeData` it replaces — spec 110, divergence 28.
 *
 * Both libraries are driven over the SAME fake node, twice: once as an EIP-1559 chain and once as
 * a legacy-priced one (ETC 61 / Mordor 63 are the live examples, and they are in the cohort). The
 * oracle is ethers, unmocked — an expectation written out of viem would only assert that viem
 * agrees with itself, and both halves of this divergence are places where it does not agree with
 * what shipped.
 */
import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { createPublicClient, custom } from 'viem'
import { estimateFeeData } from '../../lib/chains/feeData'

const CHAIN = { id: 137, name: 'Polygon', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:0'] } } }
const BASE = 30_000_000_000n // 30 gwei
const TIP = 2_000_000_000n // 2 gwei
const GAS_PRICE = 31_000_000_000n

const hex = (v) => `0x${v.toString(16)}`

/** A node that answers the three calls a fee read makes; `baseFeePerGas` absent ⇒ legacy chain. */
function fakeNode({ baseFeePerGas = BASE, priorityFee = hex(TIP), gasPrice = hex(GAS_PRICE) } = {}) {
  const seen = []
  const block = {
    number: '0x4000000', hash: '0x' + 'aa'.repeat(32), parentHash: '0x' + 'bb'.repeat(32),
    timestamp: '0x65000000', gasLimit: '0x1c9c380', gasUsed: '0x5208', miner: '0x' + '11'.repeat(20),
    transactions: [], difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', logsBloom: '0x' + '00'.repeat(256),
    nonce: '0x0000000000000000', size: '0x100', stateRoot: '0x' + 'cc'.repeat(32),
    receiptsRoot: '0x' + 'dd'.repeat(32), transactionsRoot: '0x' + 'ee'.repeat(32),
    sha3Uncles: '0x' + 'ff'.repeat(32), uncles: [], mixHash: '0x' + '00'.repeat(32),
    ...(baseFeePerGas == null ? {} : { baseFeePerGas: hex(baseFeePerGas) }),
  }
  const answers = {
    eth_chainId: '0x89',
    eth_blockNumber: '0x4000000',
    eth_getBlockByNumber: block,
    eth_gasPrice: gasPrice,
    eth_maxPriorityFeePerGas: priorityFee,
  }
  return {
    seen,
    request: async ({ method }) => {
      seen.push(method)
      if (!(method in answers)) throw new Error(`unexpected RPC: ${method}`)
      const answer = answers[method]
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

const ours = (node) => estimateFeeData(createPublicClient({ chain: CHAIN, transport: custom(node) }))
const theirs = (node) => new ethers.BrowserProvider(node, { chainId: 137, name: 'Polygon' }).getFeeData()

describe('estimateFeeData — ethers’ fee policy, kept', () => {
  it('matches ethers on an EIP-1559 chain, base × 2 + tip', async () => {
    const mine = await ours(fakeNode())
    const ethersFee = await theirs(fakeNode())

    expect(mine.maxPriorityFeePerGas).toBe(ethersFee.maxPriorityFeePerGas)
    expect(mine.maxFeePerGas).toBe(ethersFee.maxFeePerGas)
    expect(mine.gasPrice).toBe(ethersFee.gasPrice)
    // Stated outright, so the number this file's callers size a gas reserve from is pinned here
    // and not merely equal to whatever ethers happens to do next release.
    expect(mine.maxFeePerGas).toBe(BASE * 2n + TIP)
  })

  /*
   * DIVERGENCE 28b — viem's own estimate is base × 1.2 + tip. The margin is what covers a base
   * fee that climbs between signing and inclusion, and the legacy sweep pins `maxFeePerGas` to
   * exactly this number while sending `balance − gasLimit × it`, so a smaller margin does not
   * produce an error, it produces a transaction that never mines.
   */
  it('keeps the 2× headroom that viem’s own estimate would halve', async () => {
    const client = createPublicClient({ chain: CHAIN, transport: custom(fakeNode()) })
    const viemsOwn = await client.estimateFeesPerGas()
    expect(viemsOwn.maxFeePerGas).toBe((BASE * 12n) / 10n + TIP)

    const mine = await ours(fakeNode())
    expect(mine.maxFeePerGas).toBeGreaterThan(viemsOwn.maxFeePerGas)
  })

  /*
   * DIVERGENCE 28a — viem THROWS where ethers answered. ETC and Mordor price in legacy gasPrice,
   * so without this the sweep raises an exception on a chain where the whole read used to work.
   */
  it('answers gasPrice on a legacy-priced chain, where viem’s own estimate throws', async () => {
    const client = createPublicClient({ chain: CHAIN, transport: custom(fakeNode({ baseFeePerGas: null })) })
    await expect(client.estimateFeesPerGas()).rejects.toThrow()

    const mine = await ours(fakeNode({ baseFeePerGas: null }))
    const ethersFee = await theirs(fakeNode({ baseFeePerGas: null }))
    expect(mine.gasPrice).toBe(GAS_PRICE)
    expect(mine.gasPrice).toBe(ethersFee.gasPrice)
    expect(mine.maxFeePerGas).toBeNull()
    expect(ethersFee.maxFeePerGas).toBeNull()
    expect(mine.maxPriorityFeePerGas).toBeNull()
  })

  it('falls back to ethers’ 1 gwei tip when the node has no eth_maxPriorityFeePerGas', async () => {
    const absent = () => fakeNode({ priorityFee: new Error('the method eth_maxPriorityFeePerGas does not exist') })
    const mine = await ours(absent())
    const ethersFee = await theirs(absent())
    expect(mine.maxPriorityFeePerGas).toBe(1_000_000_000n)
    expect(mine.maxPriorityFeePerGas).toBe(ethersFee.maxPriorityFeePerGas)
    expect(mine.maxFeePerGas).toBe(ethersFee.maxFeePerGas)
  })

  it('never throws when the block read fails — the fee is unknown, not fatal', async () => {
    const node = fakeNode()
    const broken = { ...node, request: async ({ method, params }) => {
      if (method === 'eth_getBlockByNumber') throw new Error('node unreachable')
      return node.request({ method, params })
    } }
    const mine = await ours(broken)
    expect(mine.maxFeePerGas).toBeNull()
    expect(mine.gasPrice).toBe(GAS_PRICE)
  })
})
