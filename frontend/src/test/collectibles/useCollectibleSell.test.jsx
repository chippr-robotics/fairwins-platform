/**
 * useCollectibleSell (spec 056) — the state machine: fees-block-signing (FR-009), EOA sign+publish,
 * below-floor block (FR-011), network-switch (FR-021), accept-offer + stale-offer (FR-007), cancel.
 * All external calls are injected.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import { WalletContext } from '../../contexts/WalletContext.js'
import { useCollectibleSell } from '../../hooks/useCollectibleSell'

const SELLER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const ITEM = { chainId: 137, contract: '0x2953399124F0cBB46d2CbACD8A89cF0599974963', identifier: '1234', standard: 'erc721', collectionSlug: 'cool-cats', name: 'Cool Cat #1234', openseaUrl: 'https://opensea.io/x' }
const FEES = {
  fees: [{ recipient: '0x0000a26b00c1F0DF003000390027140000fAa719', basisPoints: 250, required: true }],
  marketplaceFee: { recipient: '0x0000a26b00c1F0DF003000390027140000fAa719', basisPoints: 250 },
  protocolAddress: '0x0000000000000068F116a894984e2DB1123eB395',
  protocolVersion: '1.6',
  conduitKey: '0x' + '00'.repeat(32),
}

function makeDeps(over = {}) {
  return {
    fetchRequiredFees: vi.fn().mockResolvedValue(FEES),
    publishListing: vi.fn().mockResolvedValue({ orderHash: '0xhash' }),
    cancelListing: vi.fn().mockResolvedValue({ cancelled: true, method: 'offchain' }),
    fetchOfferFulfillment: vi.fn().mockResolvedValue({ to: '0xto', data: '0xdead', value: '0' }),
    submitTransaction: vi.fn().mockResolvedValue({ txHash: '0xtx' }),
    readCounter: vi.fn().mockResolvedValue(0),
    resolveOrderSigner: vi.fn(() => ({ canSign: true, kind: 'eoa', address: SELLER, sign: vi.fn().mockResolvedValue('0xsig') })),
    ...over,
  }
}

function wrapperFor(walletOver = {}) {
  const wallet = { address: SELLER, loginMethod: 'wallet', signer: { signTypedData: vi.fn() }, switchChain: vi.fn().mockResolvedValue(), ...walletOver }
  return ({ children }) => <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
}

const price = { amount: '10', currency: 'POL', decimals: 18, native: true }

beforeEach(() => {
  vi.clearAllMocks()
  setWalletChain(137)
})

describe('useCollectibleSell — list', () => {
  it('loads fees then becomes ready', async () => {
    const deps = makeDeps()
    const { result } = renderHook(() => useCollectibleSell(ITEM, { deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.loadFees() })
    expect(result.current.status).toBe('ready')
    expect(result.current.fees).toBe(FEES)
  })

  it('BLOCKS when fees cannot be confirmed (FR-009) — never signs', async () => {
    const deps = makeDeps({ fetchRequiredFees: vi.fn().mockRejectedValue(new Error('down')) })
    const { result } = renderHook(() => useCollectibleSell(ITEM, { deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.loadFees() })
    expect(result.current.status).toBe('blocked')
    expect(result.current.reason).toMatch(/couldn't confirm the marketplace fees/i)
  })

  it('previews net = price − required fees, and signs + publishes on submit', async () => {
    const deps = makeDeps()
    const { result } = renderHook(() => useCollectibleSell(ITEM, { deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.loadFees() })
    expect(result.current.preview(price).net).toBe('9.75') // 10 − 2.5%
    await act(async () => { await result.current.submitListing(price) })
    expect(deps.publishListing).toHaveBeenCalledTimes(1)
    const arg = deps.publishListing.mock.calls[0][1]
    expect(arg.signature).toBe('0xsig')
    expect(arg.order.offerer).toBe(SELLER)
    expect(result.current.status).toBe('done')
    expect(result.current.result.orderHash).toBe('0xhash')
  })

  it('blocks a below-floor price instead of publishing (FR-011)', async () => {
    const deps = makeDeps()
    const { result } = renderHook(() => useCollectibleSell(ITEM, { deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.loadFees() })
    await act(async () => { await result.current.submitListing({ ...price, amount: '0' }) })
    expect(deps.publishListing).not.toHaveBeenCalled()
    expect(result.current.status).toBe('blocked')
  })

  it('is blocked-with-honest-reason when the account cannot sign (FR-019)', async () => {
    const deps = makeDeps({ resolveOrderSigner: vi.fn(() => ({ canSign: false, kind: 'passkey', reason: "Selling isn't available for passkey accounts yet." })) })
    const { result } = renderHook(() => useCollectibleSell(ITEM, { deps }), { wrapper: wrapperFor({ loginMethod: 'passkey', signer: null }) })
    expect(result.current.canSell).toBe(false)
    expect(result.current.unsupportedReason).toMatch(/passkey/i)
    await act(async () => { await result.current.loadFees() })
    expect(result.current.status).toBe('blocked')
  })

  it('prompts a network switch when the wallet is on the wrong chain (FR-021)', async () => {
    setWalletChain(1) // wallet on Ethereum, item on Polygon
    const switchChain = vi.fn().mockResolvedValue()
    const deps = makeDeps()
    const { result } = renderHook(() => useCollectibleSell(ITEM, { deps }), { wrapper: wrapperFor({ switchChain }) })
    expect(result.current.onWrongNetwork).toBe(true)
    await act(async () => { await result.current.loadFees() })
    await act(async () => { await result.current.submitListing(price) })
    expect(switchChain).toHaveBeenCalledWith({ chainId: 137 })
    expect(deps.publishListing).toHaveBeenCalled()
  })
})

describe('useCollectibleSell — accept & cancel', () => {
  it('accepts an offer by submitting the fulfillment transaction', async () => {
    const deps = makeDeps()
    const { result } = renderHook(() => useCollectibleSell(ITEM, { deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.acceptOffer({ orderHash: '0xoffer' }) })
    expect(deps.fetchOfferFulfillment).toHaveBeenCalledWith(137, { orderHash: '0xoffer', fulfiller: SELLER })
    expect(deps.submitTransaction).toHaveBeenCalled()
    expect(result.current.status).toBe('done')
  })

  it('re-confirms (does not settle) when the offer changed (FR-007)', async () => {
    const err = Object.assign(new Error('stale'), { code: 'offer_changed' })
    const deps = makeDeps({ fetchOfferFulfillment: vi.fn().mockRejectedValue(err) })
    const { result } = renderHook(() => useCollectibleSell(ITEM, { deps }), { wrapper: wrapperFor() })
    let res
    await act(async () => { res = await result.current.acceptOffer({ orderHash: '0xoffer' }) })
    expect(res.offerChanged).toBe(true)
    expect(deps.submitTransaction).not.toHaveBeenCalled()
    expect(result.current.reason).toMatch(/review the current best offer/i)
  })

  it('cancels a listing off-chain (free) when the marketplace allows it', async () => {
    const deps = makeDeps()
    const { result } = renderHook(() => useCollectibleSell(ITEM, { deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.cancel({ orderHash: '0xhash' }) })
    expect(deps.cancelListing).toHaveBeenCalled()
    expect(result.current.status).toBe('done')
    expect(result.current.result.kind).toBe('cancelled')
  })

  it('discloses on-chain-only cancellation instead of silently charging gas (FR-008)', async () => {
    const deps = makeDeps({ cancelListing: vi.fn().mockResolvedValue({ cancelled: false, method: 'onchain' }) })
    const { result } = renderHook(() => useCollectibleSell(ITEM, { deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.cancel({ orderHash: '0xhash' }) })
    expect(result.current.status).toBe('error')
    expect(result.current.reason).toMatch(/on-chain/i)
  })
})
