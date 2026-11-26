/**
 * THE ORDER'S ID BEFORE THE POST (spec 114 slice 6). An answer that never arrives leaves no venue id, so the
 * ticket computes the order's EIP-712 hash from the SIGNED order — the id the exchange contract and the venue
 * know the order by — and posts it as a separate call. These tests run the REAL `@polymarket/clob-client` (a
 * throwaway local key; only the tick / neg-risk / fee-rate lookups and the final HTTP post are answered
 * locally) and pin three things:
 *   1. splitting build and post signs the SAME order as the SDK's one-call path (only the random salt, and so
 *      the signature, differ);
 *   2. the hash we compute is the digest that was signed: an independent hashTypedData (the exchange's
 *      published domain and Order struct) agrees, and the signature recovers to the signer over exactly it;
 *   3. the exchange chosen for the domain follows `negRisk`.
 * What they cannot show is that the VENUE uses this hash as its `orderID` — that needs a funded account; the
 * tracker therefore learns it from the first real post (orderProgress `idScheme`).
 */
import { describe, it, expect, vi } from 'vitest'
import { createWalletClient, http, hashTypedData, recoverAddress } from 'viem'
import { polygon } from 'viem/chains'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { makeClobClient, submitMarketOrder, submitRestingOrder, signedOrderHash } from '../../lib/predict/clobSession'

// The suite-wide setup stubs the SDK; this file needs the real one, for clobSession.js too.
vi.mock('@polymarket/clob-client', async (importActual) => importActual())

const SDK = await vi.importActual('@polymarket/clob-client')
const TOKEN = '71321045679252212594626385532706912750332728571942532289631379312455583992563'

const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' }, { name: 'expiration', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' }, { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' },
  ],
}
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'

const account = privateKeyToAccount(generatePrivateKey())
const wallet = () => createWalletClient({ account, chain: polygon, transport: http('http://127.0.0.1:9') })

/** A real ClobClient whose lookups and POST are answered locally; `posted` collects what would have been sent. */
function offlineClient({ negRisk = false } = {}) {
  const client = makeClobClient(wallet(), { key: 'k', secret: 's', passphrase: 'p' }, { ClobClientImpl: SDK.ClobClient })
  client.getTickSize = async () => '0.01'
  client.getNegRisk = async () => negRisk
  client.getFeeRateBps = async () => 0
  const posted = []
  client.postOrder = async (order, type) => {
    posted.push({ order, type })
    return { success: true, orderID: '0xvenue', status: 'matched' }
  }
  return { client, posted }
}
const withoutSalt = ({ salt, signature, ...rest }) => rest // eslint-disable-line no-unused-vars

const digestOf = (order, verifyingContract) =>
  hashTypedData({
    domain: { name: 'Polymarket CTF Exchange', version: '1', chainId: 137, verifyingContract },
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: order,
  })

describe('the split build-then-post signs the same order as the SDK one-call path', () => {
  it('market order (FAK): identical maker, taker, price, side, fee and type — only the salt and signature differ', async () => {
    const a = offlineClient()
    await a.client.createAndPostMarketOrder(
      { tokenID: TOKEN, side: SDK.Side.BUY, amount: 50, price: 0.95, orderType: SDK.OrderType.FAK },
      { tickSize: '0.01', negRisk: false },
      SDK.OrderType.FAK,
    )
    const b = offlineClient()
    await submitMarketOrder(b.client, { tokenId: TOKEN, side: 'BUY', amount: '50', limitPrice: '0.95', negRisk: false, tickSize: '0.01' })
    expect(a.posted).toHaveLength(1)
    expect(b.posted).toHaveLength(1)
    expect(withoutSalt(b.posted[0].order)).toEqual(withoutSalt(a.posted[0].order))
    expect(b.posted[0].type).toBe(a.posted[0].type)
    expect(b.posted[0].type).toBe('FAK')
  })

  it('resting order (GTC): identical too, on a sell and a neg-risk market', async () => {
    const a = offlineClient({ negRisk: true })
    await a.client.createAndPostOrder(
      { tokenID: TOKEN, price: 0.57, side: SDK.Side.SELL, size: 87.71 },
      { tickSize: '0.01', negRisk: true },
      SDK.OrderType.GTC,
    )
    const b = offlineClient({ negRisk: true })
    await submitRestingOrder(b.client, { tokenId: TOKEN, side: 'SELL', price: '0.57', size: '87.71', negRisk: true, tickSize: '0.01' })
    expect(withoutSalt(b.posted[0].order)).toEqual(withoutSalt(a.posted[0].order))
    expect(b.posted[0].type).toBe(a.posted[0].type)
    expect(b.posted[0].type).toBe('GTC')
  })

  it('an unstated negRisk is asked of the venue, and the order is signed for the exchange it answered', async () => {
    const b = offlineClient({ negRisk: true })
    const out = await submitMarketOrder(b.client, { tokenId: TOKEN, side: 'BUY', amount: '10', limitPrice: '0.5', tickSize: '0.01' })
    expect(out.orderHash).toBe(digestOf(b.posted[0].order, NEG_RISK_EXCHANGE))
  })
})

describe('the id computed before the post is the digest that was signed', () => {
  it.each([
    ['market, standard exchange', false, EXCHANGE],
    ['market, neg-risk exchange', true, NEG_RISK_EXCHANGE],
  ])('%s: equals an independent hashTypedData and the signature recovers to the signer over it', async (_n, negRisk, exchange) => {
    const { client, posted } = offlineClient({ negRisk })
    const out = await submitMarketOrder(client, { tokenId: TOKEN, side: 'BUY', amount: '25', limitPrice: '0.6', negRisk, tickSize: '0.01' })
    const order = posted[0].order
    expect(out.orderHash).toBe(digestOf(order, exchange))
    expect(await recoverAddress({ hash: out.orderHash, signature: order.signature })).toBe(account.address)
  })

  it('a resting order: same', async () => {
    const { client, posted } = offlineClient()
    const out = await submitRestingOrder(client, { tokenId: TOKEN, side: 'BUY', price: '0.42', size: '30', negRisk: false, tickSize: '0.01' })
    expect(out.orderHash).toBe(digestOf(posted[0].order, EXCHANGE))
    expect(await recoverAddress({ hash: out.orderHash, signature: posted[0].order.signature })).toBe(account.address)
  })

  it('the standard and the neg-risk exchange give DIFFERENT ids for the same order (the domain matters)', () => {
    const order = { salt: '5', maker: account.address, signer: account.address, taker: '0x0000000000000000000000000000000000000000', tokenId: TOKEN, makerAmount: '1', takerAmount: '2', expiration: '0', nonce: '0', feeRateBps: '0', side: 0, signatureType: 0 }
    expect(signedOrderHash(order, false)).not.toBe(signedOrderHash(order, true))
  })

  it('is null, never a guess, for something that is not an order', () => {
    expect(signedOrderHash({}, false)).toBeNull()
    expect(signedOrderHash(null, false)).toBeNull()
  })
})
