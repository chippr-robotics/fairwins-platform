/**
 * Multi-asset sweep (spec 062, US2) — quoteAllAssets / sweepAllAssets.
 *
 * ── WHY THERE IS A FAKE NODE HERE AND NOT A FAKE LIBRARY ──────────────────────────────────────
 * This file used to mock `ethers` itself: a `StubContract` whose constructor ignored the ABI and
 * whose `transfer` recorded its arguments. That fake could not fail on anything this module
 * actually gets wrong — a transfer encoded against the wrong function, an argument in the wrong
 * order, a value that does not survive encoding, a chain id that never reached the signature —
 * because nothing was ever encoded. It asserted that the test's own bookkeeping matched itself.
 *
 * So the seam moved down to the wire. A REAL viem client is built over a fake EIP-1193 node, the
 * sweep really signs, and the node PARSES the raw transaction it is handed. Every assertion below
 * is therefore about bytes that a real chain would have accepted or refused: the calldata is
 * decoded back through the ERC-20 ABI, the nonce and the fee fields come out of the signed
 * envelope, and a leg that "sent" produced a signature over exactly what is claimed.
 */
import { describe, it, expect, vi } from 'vitest'
import { createPublicClient, custom, parseTransaction, decodeFunctionData, keccak256, encodeAbiParameters, parseAbi } from 'viem'
import {
  quoteAllAssets,
  sweepAllAssets,
  supportedAssetsForChain,
  describeTransferFailure,
} from '../../lib/recovery/legacyKeys'

const USDC = ('0x' + 'a'.repeat(40)).toLowerCase()
const DAI = ('0x' + 'b'.repeat(40)).toLowerCase()
const LEGACY_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const TO = '0x' + 'd'.repeat(40)

// The fee the sweep sees. `estimateFeeData` computes base × 2 + tip (see DIVERGENCE 28), so a node
// reporting base = GAS/2 with a zero tip answers exactly GAS — which keeps every number below the
// same as it was before the conversion, and keeps the arithmetic under test visible.
const GAS = 2_000_000_000n
const TRANSFER_ABI = parseAbi(['function transfer(address to, uint256 value) returns (bool)'])

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const CHAIN = { id: 1, name: 'Test', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:0'] } } }

const hex = (v) => `0x${BigInt(v).toString(16)}`

// Stub the portfolio registry so tests don't depend on live chain config.
vi.mock('../../config/assetTaxonomy', () => ({
  getPortfolioRegistry: () => [
    { id: 'native', kind: 'native', address: null, symbol: 'ETH', decimals: 18 },
    { id: 'usdc', kind: 'erc20', address: '0x' + 'a'.repeat(40), symbol: 'USDC', decimals: 6 },
    { id: 'dai', kind: 'erc20', address: '0x' + 'b'.repeat(40), symbol: 'DAI', decimals: 18 },
    { id: 'nft', kind: 'nft', address: '0x' + 'c'.repeat(40), symbol: 'NFT', decimals: 0 },
  ],
}))

/**
 * A node that answers JSON-RPC, holds a mutable ledger, and PARSES what it is asked to broadcast.
 *
 * @param {object} balances - `{ native, [tokenAddress]: amount }`, mutated as legs mine
 * @param {object} [opts]
 * @param {bigint[]} [opts.prices] - the effective `maxFeePerGas` each fee read answers, in order;
 *   the last entry stands for every read after it (this is how a fee that RISES mid-sweep is
 *   modelled, and the sweep reads the fee once per leg)
 * @param {boolean} [opts.legacyFees] - price in `gasPrice` only, as ETC/Mordor do
 * @param {bigint} [opts.estimateGas] - what `eth_estimateGas` answers
 * @param {bigint} [opts.gasUsed] - gas each mined transfer burns, debited from the coin balance
 * @param {string} [opts.failToken] - a token whose transfer cannot even be estimated (pre-broadcast)
 * @param {Error}  [opts.failBroadcast] - what `eth_sendRawTransaction` throws for the coin leg
 * @param {bigint} [opts.frozenBalance] - what `eth_getBalance` keeps answering, however the ledger
 *   moves: a stale node, which is the failure the coin leg's own bookkeeping exists for
 */
function makeNode(balances, opts = {}) {
  const {
    prices = [GAS], legacyFees = false, estimateGas = 21000n, gasUsed = 0n,
    failToken = null, failBroadcast = null, frozenBalance = null,
  } = opts
  const sent = []
  const receipts = new Map()
  let feeReads = 0

  const priceNow = () => prices[Math.min(feeReads, prices.length - 1)]

  const answer = async ({ method, params }) => {
    switch (method) {
      case 'eth_chainId':
        return '0x1'
      case 'eth_blockNumber':
        return '0x64'
      case 'eth_getBalance':
        return hex(frozenBalance ?? balances.native ?? 0n)
      case 'eth_getTransactionCount':
        return '0x7'
      case 'eth_gasPrice':
        // A legacy chain prices here; a 1559 chain reports it too and the sweep ignores it.
        return hex(priceNow())
      case 'eth_maxPriorityFeePerGas':
        return '0x0'
      case 'eth_getBlockByNumber': {
        // One fee read = one block read. `estimateFeeData` derives base × 2 + tip(0) = the price.
        const price = priceNow()
        feeReads += 1
        return {
          number: '0x64', hash: '0x' + 'aa'.repeat(32), parentHash: '0x' + 'bb'.repeat(32),
          timestamp: '0x65000000', gasLimit: '0x1c9c380', gasUsed: '0x5208',
          miner: '0x' + '11'.repeat(20), transactions: [], difficulty: '0x0', totalDifficulty: '0x0',
          extraData: '0x', logsBloom: '0x' + '00'.repeat(256), nonce: '0x0000000000000000',
          size: '0x100', stateRoot: '0x' + 'cc'.repeat(32), receiptsRoot: '0x' + 'dd'.repeat(32),
          transactionsRoot: '0x' + 'ee'.repeat(32), sha3Uncles: '0x' + 'ff'.repeat(32),
          uncles: [], mixHash: '0x' + '00'.repeat(32),
          ...(legacyFees ? {} : { baseFeePerGas: hex(price / 2n) }),
        }
      }
      case 'eth_call': {
        // The only read this module makes is balanceOf(address) — decoded, never pattern-matched,
        // so a call encoded against the wrong function or argument fails here rather than passing.
        const { to, data } = params[0]
        const decoded = decodeFunctionData({ abi: parseAbi(['function balanceOf(address) view returns (uint256)']), data })
        expect(decoded.functionName).toBe('balanceOf')
        expect(decoded.args[0].toLowerCase()).toBe(LEGACY_ADDR.toLowerCase())
        return encodeAbiParameters([{ type: 'uint256' }], [balances[to.toLowerCase()] ?? 0n])
      }
      case 'eth_estimateGas': {
        const to = params[0]?.to?.toLowerCase()
        if (failToken && to === failToken) {
          throw Object.assign(new Error('execution reverted: ERC20: transfer amount exceeds balance'), { code: 3 })
        }
        return hex(estimateGas)
      }
      case 'eth_sendRawTransaction': {
        const tx = parseTransaction(params[0])
        const isToken = tx.data && tx.data !== '0x'
        if (failBroadcast && !isToken) throw failBroadcast
        const price = tx.maxFeePerGas ?? tx.gasPrice ?? 0n
        const hash = keccak256(params[0])
        sent.push({
          asset: isToken ? tx.to.toLowerCase() : 'native',
          to: tx.to.toLowerCase(),
          value: tx.value ?? 0n,
          nonce: tx.nonce,
          gas: tx.gas,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
          gasPrice: tx.gasPrice,
          type: tx.type,
          chainId: tx.chainId,
          // A token leg's real payload, decoded back through the ABI it claims to speak.
          call: isToken ? decodeFunctionData({ abi: TRANSFER_ABI, data: tx.data }) : null,
        })
        // The ledger moves the way a chain's would: the transfer settles and its gas is burned.
        if (isToken) {
          const token = tx.to.toLowerCase()
          balances[token] = (balances[token] ?? 0n) - decodeFunctionData({ abi: TRANSFER_ABI, data: tx.data }).args[1]
        } else {
          balances.native = (balances.native ?? 0n) - (tx.value ?? 0n)
        }
        balances.native = (balances.native ?? 0n) - gasUsed * price
        receipts.set(hash, {
          transactionHash: hash, transactionIndex: '0x0', blockHash: '0x' + 'cd'.repeat(32),
          blockNumber: '0x65', from: LEGACY_ADDR, to: tx.to, cumulativeGasUsed: hex(gasUsed),
          gasUsed: hex(gasUsed), contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256),
          status: '0x1', type: '0x2', effectiveGasPrice: hex(price),
        })
        return hash
      }
      case 'eth_getTransactionReceipt':
        return receipts.get(params[0]) ?? null
      default:
        // A real node answers an unsupported method with -32601, and viem uses exactly that to
        // decide it must populate the transaction itself. Answering anything else here would be
        // modelling a node that does not exist, and would make viem re-probe on every send.
        throw Object.assign(new Error(`the method ${method} does not exist/is not available`), { code: -32601 })
    }
  }

  const client = createPublicClient({ chain: CHAIN, transport: custom({ request: answer }) })
  return { client, sent, balances }
}

const sweep = (node, extra = {}) =>
  sweepAllAssets({ kind: 'privateKey', secret: PK, to: TO, chainId: 1, client: node.client, ...extra })
const quote = (node, extra = {}) =>
  quoteAllAssets({ kind: 'privateKey', secret: PK, chainId: 1, client: node.client, ...extra })

const legOf = (node, asset) => node.sent.find((t) => t.asset === asset)

describe('supportedAssetsForChain', () => {
  it('keeps native + erc20 and drops NFTs', () => {
    expect(supportedAssetsForChain(1).map((a) => a.symbol)).toEqual(['ETH', 'USDC', 'DAI'])
  })
})

describe('quoteAllAssets', () => {
  it('lists non-zero balances, ERC-20s first then native, and reserves gas', async () => {
    const q = await quote(makeNode({ native: 10n ** 17n, [USDC]: 5_000_000n }))
    expect(q.from).toBe(LEGACY_ADDR)
    expect(q.holdings.map((h) => h.asset.symbol)).toEqual(['USDC', 'ETH']) // DAI zero → excluded
    expect(q.hasNative).toBe(true)
    expect(q.nativeGasReserve).toBe((21000n * GAS * 12n) / 10n)
  })

  it('omits native when the coin balance is zero', async () => {
    const q = await quote(makeNode({ native: 0n, [DAI]: 9n }))
    expect(q.holdings.map((h) => h.asset.symbol)).toEqual(['DAI'])
    expect(q.hasNative).toBe(false)
  })

  it('sizes the native reserve + gas limit from a gas estimate to the destination', async () => {
    // A smart-account recipient needs more than 21k; estimate to `to` and buffer 20%.
    const node = makeNode({ native: 10n ** 18n }, { estimateGas: 90_000n })
    const q = await quote(node, { to: TO })
    expect(q.nativeGasLimit).toBe((90_000n * 12n) / 10n) // 108000
    expect(q.nativeGasReserve).toBe(((90_000n * 12n) / 10n) * GAS)
  })

  it('reads a token balance by decodable balanceOf calldata, not by address alone', async () => {
    // The node decodes every `eth_call` and asserts the function and its argument, so a read
    // encoded against the wrong ABI fails here instead of being recorded as a zero balance.
    const q = await quote(makeNode({ native: 0n, [USDC]: 1234n }))
    expect(q.holdings.map((h) => [h.asset.symbol, h.balance])).toEqual([['USDC', 1234n]])
  })
})

describe('sweepAllAssets', () => {
  it('transfers every non-zero asset (ERC-20s then native) with per-asset outcomes', async () => {
    const node = makeNode({ native: 10n ** 17n, [USDC]: 5_000_000n })
    const progress = []
    const outcomes = await sweep(node, { onProgress: (o) => progress.push(o.asset.symbol) })
    expect(outcomes.map((o) => `${o.asset.symbol}:${o.status}`)).toEqual(['USDC:sent', 'ETH:sent'])
    expect(progress).toEqual(['USDC', 'ETH'])

    const erc20Legs = node.sent.filter((t) => t.asset !== 'native')
    expect(erc20Legs).toHaveLength(1)
    expect(erc20Legs[0].asset).toBe(USDC)
    // The signed calldata really is `transfer(TO, 5_000_000)` on the USDC contract.
    expect(erc20Legs[0].call.functionName).toBe('transfer')
    expect(erc20Legs[0].call.args[0].toLowerCase()).toBe(TO.toLowerCase())
    expect(erc20Legs[0].call.args[1]).toBe(5_000_000n)
    expect(erc20Legs[0].chainId).toBe(1)
  })

  it('continues past a single token failure and reports it honestly', async () => {
    const node = makeNode({ native: 10n ** 17n, [USDC]: 5_000_000n, [DAI]: 9n }, { failToken: USDC })
    const outcomes = await sweep(node)
    const bySym = Object.fromEntries(outcomes.map((o) => [o.asset.symbol, o.status]))
    expect(bySym).toEqual({ USDC: 'failed', DAI: 'sent', ETH: 'sent' })
  })

  it('skips native when it cannot cover the gas reserve', async () => {
    const outcomes = await sweep(makeNode({ native: 1000n }))
    expect(outcomes).toEqual([
      {
        asset: expect.objectContaining({ symbol: 'ETH' }),
        status: 'skipped',
        error: expect.any(String),
        // Why it could not: the price used, what was reserved, and what was there (issues
        // #1301/#1327). Without these a CI-only failure says an asset did not move, not by how
        // much it missed.
        detail: {
          gasPrice: String(GAS),
          gasLimit: String((21000n * 12n) / 10n),
          reserve: String(((21000n * 12n) / 10n) * GAS),
          balance: '1000',
          coinBalance: '1000',
        },
      },
    ])
  })

  it('numbers each transfer itself, and a pre-broadcast failure consumes no nonce', async () => {
    /*
     * Regression (found by the full-tier sweep spec): every leg was left to the library's own
     * nonce lookup, which a node can answer staleley, so the second transfer went out reusing
     * the first's nonce and was rejected as already used — stranding assets the member had been
     * told would move. The nonce is read once and advanced per BROADCAST.
     *
     * The node answers `eth_getTransactionCount` with 7 FOREVER, which is the stale case; the
     * nonces below come out of the signed envelopes, so they are what a chain would have seen.
     */
    const node = makeNode({ native: 10n ** 17n, [USDC]: 5_000_000n, [DAI]: 9n }, { failToken: USDC })
    const outcomes = await sweep(node)

    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'sent', 'sent'])
    expect(node.sent.map((t) => [t.asset, t.nonce])).toEqual([[DAI, 7], ['native', 8]])
  })

  it('sizes the coin transfer from the balance LEFT after the token legs paid their gas', async () => {
    /*
     * Regression (found by the full-tier sweep spec): the native value was computed from the
     * quote's balance, taken before any ERC-20 moved. Each token transfer then spent coin on
     * gas, so the transfer asked for more than the account still held and the node rejected it
     * for insufficient funds — with any token to move first, the coin never left, and the member
     * saw a failure they could do nothing about.
     */
    const GAS_USED = 15_000n
    const spentPerTransfer = GAS_USED * GAS
    const node = makeNode({ native: 10n ** 18n, [USDC]: 5_000_000n }, { gasUsed: GAS_USED })
    const outcomes = await sweep(node)
    expect(outcomes.map((o) => o.status)).toEqual(['sent', 'sent'])

    const nativeLeg = legOf(node, 'native')
    const reserve = (21000n * GAS * 12n) / 10n
    // Sized from what is actually there (start − one transfer's gas), not from the quote.
    expect(nativeLeg.value).toBe(10n ** 18n - spentPerTransfer - reserve)
  })

  it('refuses an invalid destination', async () => {
    await expect(
      sweepAllAssets({ kind: 'privateKey', secret: PK, to: 'nope', chainId: 1, client: makeNode({ native: 10n ** 18n }).client })
    ).rejects.toThrow(/valid destination/i)
  })

  it('refuses sweeping to the legacy account itself', async () => {
    await expect(
      sweepAllAssets({ kind: 'privateKey', secret: PK, to: LEGACY_ADDR, chainId: 1, client: makeNode({ native: 10n ** 18n }).client })
    ).rejects.toThrow(/destination other than/i)
  })
})

/*
 * The native leg's reserve has to survive a RISING fee, not just a falling balance.
 *
 * `quoteAllAssets` reads the fee once, before anything has mined. Every ERC-20 leg then mines,
 * and on a chain whose base fee is climbing the native transfer's own max fee ends up larger than
 * the reserve set aside for it — `value + gas > balance`, the node refuses it for insufficient
 * funds, and the member is told their coin "failed" for a reason they could do nothing about.
 *
 * A REVERTING ERC-20 leg is the sharpest case: a reverted transfer consumes its whole gas limit,
 * which is exactly what fills a block and lifts the base fee. That is the shape of the full-tier
 * failure this was found by (`28-legacy-recovery-sweep.cy.js::LKR-S2`, which mines exactly one
 * reverting transfer before the coin moves).
 *
 * The balance re-read alone cannot catch it, which is why this is its own test.
 */
describe('sweepAllAssets — the native reserve tracks a rising fee', () => {
  it('leaves enough behind to pay the fee that is current when the coin moves', async () => {
    const LATER = GAS * 3n
    const balance = 10n ** 17n
    const node = makeNode({ native: balance, [USDC]: 5_000_000n }, { prices: [GAS, LATER] })

    await sweep(node)

    const nativeSend = legOf(node, 'native')
    expect(nativeSend, 'the coin still moved').toBeTruthy()

    // 21000 baseline * the 20% buffer the quote applies.
    const nativeGasLimit = (21000n * 12n) / 10n
    expect(
      nativeSend.value + nativeGasLimit * LATER,
      'what is sent plus what the CURRENT fee will cost must fit in the balance',
    ).toBeLessThanOrEqual(balance)
  })

  /*
   * The reserve leaves ZERO margin by construction: `value` is `balance - gasLimit * price`, so
   * the node's funding check (`value + gasLimit * maxFeePerGas <= balance`) is satisfied only
   * while the price on the transaction is no higher than the price the reserve was sized from.
   *
   * Left to the library that price is read a THIRD time, during populate — after the sweep's own
   * re-read, with nothing between them. A fee that ticks up in that window refuses the coin for
   * insufficient funds and reports it as a failure the member could do nothing about: the exact
   * outcome the reserve exists to prevent, reached by a narrower door. Pinning the fee to the
   * reserved price turns the inequality into an identity, so there is no window left to lose.
   */
  it('sends the coin at the price its reserve was sized from, leaving no window to lose', async () => {
    const balance = 10n ** 17n
    const node = makeNode({ native: balance, [USDC]: 5_000_000n })

    await sweep(node)

    const nativeSend = legOf(node, 'native')
    const nativeGasLimit = (21000n * 12n) / 10n
    expect(nativeSend.maxFeePerGas, 'the fee is stated, not left to be read again').toBe(GAS)
    expect(
      nativeSend.value + nativeGasLimit * nativeSend.maxFeePerGas,
      'what is sent plus what the stated fee can cost is exactly the balance',
    ).toBe(balance)
  })

  it('pins the RISEN price when the fee moved between the quote and the send', async () => {
    const LATER = GAS * 3n
    const node = makeNode({ native: 10n ** 17n, [USDC]: 5_000_000n }, { prices: [GAS, LATER] })
    await sweep(node)
    expect(legOf(node, 'native').maxFeePerGas, 'the transaction carries the fee that was reserved').toBe(LATER)
  })

  it('pins gasPrice on a chain that prices in gasPrice, and no 1559 fields', async () => {
    /*
     * A chain with no EIP-1559 fee data must not be handed maxFeePerGas — the node would reject a
     * type-2 transaction it cannot price. This is also DIVERGENCE 28a: viem's own
     * `estimateFeesPerGas` THROWS on such a chain rather than answering `gasPrice`, and ETC (61)
     * and Mordor (63) are exactly that kind of chain, so without the seam's fee policy this whole
     * sweep would raise instead of running.
     */
    const balance = 10n ** 17n
    const node = makeNode({ native: balance }, { legacyFees: true })

    await sweep(node)

    const nativeSend = legOf(node, 'native')
    expect(nativeSend.gasPrice, 'the legacy price is stated').toBe(GAS)
    expect(nativeSend.maxFeePerGas, 'no 1559 fields on a legacy-priced chain').toBeUndefined()
    expect(nativeSend.type).toBe('legacy')
  })

  it('never reserves less than the quote did when the fee falls', async () => {
    // A cheaper fee is not a reason to cut the margin the member was quoted. The reserve is a
    // floor, so a falling fee simply leaves a little more behind — never less.
    const balance = 10n ** 17n
    const node = makeNode({ native: balance }, { prices: [GAS, GAS / 4n] })

    await sweep(node)

    const quotedReserve = ((21000n * 12n) / 10n) * GAS
    expect(legOf(node, 'native').value, 'the quoted reserve still stands').toBe(balance - quotedReserve)
  })
})

/*
 * The marginal draw the full-tier spec kept hitting (issues #1301 / #1327).
 *
 * `28-legacy-recovery-sweep.cy.js::LKR-S2` failed intermittently with the coin reported as
 *   `MATIC failed — could not coalesce error`
 * while the token behind it moved. Two facts produce that exactly:
 *
 *  1. a node serves from the state it has, and a failover RPC pool (spec 069) can answer from one
 *     that has not yet seen the token transfer — ethers additionally shared an identical
 *     `getBalance` for 250ms of its own. On a fast local chain the ERC-20 leg mines well inside
 *     that window, so the coin leg's "fresh" re-read comes back as the balance BEFORE that leg
 *     paid its gas. `value + gas` is then larger than the account really holds and the node
 *     refuses the transaction.
 *  2. Hardhat's refusal reads "Sender doesn't have enough funds to send tx…", which matches none
 *     of the shapes the library knows, so it is wrapped in a placeholder that names no cause.
 *     That is what reached the member.
 *
 * The fix has both halves: the coin leg is sized from the SMALLER of the live read and the sweep's
 * own receipt-tracked figure, and no failure is ever reported in the library's placeholder words.
 */
describe('sweepAllAssets — a stale balance read never over-sizes the coin leg', () => {
  const GAS_USED = 15_000n
  const spentPerTransfer = GAS_USED * GAS

  it('sizes the coin from the receipts when the balance read is stale', async () => {
    const start = 10n ** 17n
    // `frozenBalance` is the node that never moves: every `eth_getBalance` answers the quote's
    // figure however much the ledger behind it has actually changed.
    const node = makeNode({ native: start, [USDC]: 5_000_000n }, { gasUsed: GAS_USED, frozenBalance: start })

    const outcomes = await sweep(node)
    expect(outcomes.map((o) => `${o.asset.symbol}:${o.status}`)).toEqual(['USDC:sent', 'ETH:sent'])

    const nativeLeg = legOf(node, 'native')
    const reserve = ((21000n * 12n) / 10n) * GAS
    // The read still says `start`; the receipt says a transfer's gas has gone. The smaller governs.
    expect(nativeLeg.value, 'sized from the receipt, not from the stale read')
      .toBe(start - spentPerTransfer - reserve)
  })

  it('stays affordable when the price jumps between the quote and the send', async () => {
    // Both failures at once: the read is stale AND the fee rose after the quote — the draw the
    // reserve was still marginal under.
    const LATER = GAS * 3n
    const start = 10n ** 17n
    const node = makeNode({ native: start, [USDC]: 5_000_000n }, {
      gasUsed: GAS_USED, frozenBalance: start, prices: [GAS, LATER],
    })

    const outcomes = await sweep(node)
    expect(outcomes.map((o) => o.status)).toEqual(['sent', 'sent'])

    const nativeLeg = legOf(node, 'native')
    const nativeGasLimit = (21000n * 12n) / 10n
    expect(nativeLeg.maxFeePerGas, 'the coin carries the risen price its reserve was sized from').toBe(LATER)
    expect(
      nativeLeg.value + nativeGasLimit * nativeLeg.maxFeePerGas,
      'the node funding check holds against the balance that is really there',
    ).toBeLessThanOrEqual(start - spentPerTransfer)
  })

  it('degrades to a skipped coin with an honest reason when the draw leaves nothing', async () => {
    // A token leg that eats almost the whole coin balance: there is genuinely nothing left to move
    // after the fee, and that must read as "skipped, not enough for the fee" — never as a node
    // refusal the member cannot interpret.
    const reserve = ((21000n * 12n) / 10n) * GAS
    const start = reserve + 10n
    const node = makeNode({ native: start, [USDC]: 5_000_000n }, {
      gasUsed: 50n, frozenBalance: start,
    })

    const outcomes = await sweep(node)
    const coin = outcomes.find((o) => o.asset.symbol === 'ETH')
    expect(coin.status).toBe('skipped')
    expect(coin.error).toMatch(/network fee/i)
    // Nothing was signed for it — a refusal that never reaches the chain costs nothing.
    expect(node.sent.some((s) => s.asset === 'native')).toBe(false)
    // And it says by how much: price, reserve, and what was actually left.
    expect(coin.detail).toEqual({
      gasPrice: String(GAS),
      gasLimit: String((21000n * 12n) / 10n),
      reserve: String(reserve),
      balance: String(start - 50n * GAS),
      coinBalance: String(start - 50n * GAS),
    })
  })
})

/*
 * The ERC-20 legs get the same treatment as the coin leg (issue #1301).
 *
 * Left to the library, every token transfer reads the fee again at populate time — so the coin
 * those legs burn is decided by a price the sweep never saw, taken out of the very balance the
 * coin leg's reserve is computed from. Pinning makes what a leg can cost knowable BEFORE it is
 * sent, which is what lets the reserve behind it be sized from a schedule nothing has invalidated.
 */
describe('sweepAllAssets — the ERC-20 legs are pinned to the same fee schedule', () => {
  it('states the fee on a token transfer instead of leaving it to be read again', async () => {
    const node = makeNode({ native: 10n ** 17n, [USDC]: 5_000_000n })
    await sweep(node)

    const tokenLeg = legOf(node, USDC)
    expect(tokenLeg.maxFeePerGas, 'the token leg carries the fee, not a promise to look it up').toBe(GAS)
    expect(tokenLeg.type, 'a 1559 envelope, priced in max fee + tip').toBe('eip1559')
    expect(tokenLeg.gasPrice, 'no legacy field on a 1559-priced chain').toBeUndefined()
    // The tip is pinned at zero here, and zero is what RLP encodes as an EMPTY field — so a
    // parsed transaction reports it absent. That is a fact about the wire, not a gap in the
    // pinning: absent and zero are the same bytes, and the node cannot tell them apart either.
    expect(tokenLeg.maxPriorityFeePerGas ?? 0n).toBe(0n)
  })

  it('pins gasPrice on a chain that prices in gasPrice, and no 1559 fields', async () => {
    const node = makeNode({ native: 10n ** 17n, [USDC]: 5_000_000n }, { legacyFees: true })
    await sweep(node)

    const tokenLeg = legOf(node, USDC)
    expect(tokenLeg.gasPrice).toBe(GAS)
    expect(tokenLeg.maxFeePerGas).toBeUndefined()
  })

  it('never pins a token leg BELOW a risen base fee — the schedule only goes up', async () => {
    // A pinned price that the chain has already outgrown is its own stranding: the transfer sits
    // unmineable and `wait()` never returns. The schedule is monotone for exactly that reason.
    const LATER = GAS * 4n
    const node = makeNode({ native: 10n ** 18n, [USDC]: 5_000_000n }, { prices: [GAS, LATER] })
    await sweep(node)

    expect(legOf(node, USDC).maxFeePerGas, 'the token leg pays the fee that is current when it goes out').toBe(LATER)
  })

  it('reports a token failure with the price, the reserve and the balances it saw', async () => {
    const node = makeNode({ native: 10n ** 17n, [USDC]: 5_000_000n }, { failToken: USDC })
    const outcomes = await sweep(node)

    const token = outcomes.find((o) => o.asset.symbol === 'USDC')
    expect(token.status).toBe('failed')
    expect(token.detail).toEqual({
      gasPrice: String(GAS),
      reserve: String(((21000n * 12n) / 10n) * GAS),
      balance: '5000000',
      coinBalance: String(10n ** 17n),
    })
    // `toEqual` above is the guard that a diagnostic carries fees and balances and NOTHING else:
    // a key, an address or a mnemonic appearing here would fail it outright.
  })
})

/*
 * A placeholder must never be what a member (or a CI log) is left with.
 *
 * Both libraries bury the node's own sentence. ethers raised `could not coalesce error` whenever a
 * JSON-RPC failure matched none of the shapes it knew — which includes Hardhat's
 * insufficient-funds wording — and attached the original under `info.error`. viem keeps it in
 * `details` and nests the raw error under `cause`. Reaching for it is the difference between
 * naming the cause and naming nothing, so both shapes are covered here: the ethers ones because
 * stored/re-thrown errors still carry them, and the viem one END TO END, from a node that really
 * refuses a broadcast through the sweep's own reporting.
 */
describe('describeTransferFailure', () => {
  const coalesced = (nodeMessage) => {
    const e = new Error('could not coalesce error')
    e.shortMessage = 'could not coalesce error'
    e.code = 'UNKNOWN_ERROR'
    if (nodeMessage) e.error = { code: -32000, message: nodeMessage }
    return e
  }

  it('names the fee when the node refused for want of funds, in words neither library knows', () => {
    expect(
      describeTransferFailure(coalesced(
        "Sender doesn't have enough funds to send tx. The max upfront cost is: 1000 and the sender's account only has: 999",
      )),
    ).toMatch(/network fee/i)
  })

  it('falls back to the node’s own words rather than the placeholder', () => {
    expect(describeTransferFailure(coalesced('replacement transaction rejected by the pool')))
      .toBe('replacement transaction rejected by the pool')
  })

  it('never returns the placeholder, even with nothing underneath it', () => {
    const text = describeTransferFailure(coalesced(null))
    expect(text).not.toMatch(/coalesce/i)
    expect(text).toMatch(/refused/i)
  })

  it('passes a contract revert reason through unchanged', () => {
    const e = new Error('execution reverted')
    e.reason = 'ERC20: transfer amount exceeds balance'
    expect(describeTransferFailure(e)).toBe('ERC20: transfer amount exceeds balance')
  })

  it('reads the node’s words out of a viem error, where they live under `details`', () => {
    // The whole chain, end to end: the node refuses the broadcast in Hardhat's own wording, viem
    // wraps it, and the member is told about the fee rather than shown a library's internal noise.
    const refusal = Object.assign(
      new Error("Sender doesn't have enough funds to send tx. The max upfront cost is: 1000 and the sender's account only has: 999"),
      { code: -32000 },
    )
    const node = makeNode({ native: 10n ** 17n }, { failBroadcast: refusal })
    return sweep(node).then((outcomes) => {
      expect(outcomes[0].status).toBe('failed')
      expect(outcomes[0].error).toMatch(/network fee/i)
      expect(outcomes[0].error).not.toMatch(/Request Arguments/i)
      expect(outcomes[0].detail.gasPrice).toBe(String(GAS))
    })
  })
})
