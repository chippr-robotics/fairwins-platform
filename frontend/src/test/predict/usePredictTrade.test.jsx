/**
 * usePredictTrade (spec 057) — the state machine over the SDK client-direct trade flow: region gate
 * (geoblock -> link out, FR-019), fee-blocks-signing (FR-010), derive-creds + submit via the SDK,
 * network-switch prompt (FR-021), price-move re-confirm (FR-008), unsupported account honest reason
 * (FR-019). All external calls (clobSession + geoblock) are injected.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import { WalletContext } from '../../contexts/WalletContext.js'
import { usePredictTrade } from '../../hooks/usePredictTrade'

const TRADER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const TOKEN = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
const FEE = { feeRateBps: 100, builderTakerFeeBps: 50, builderMakerFeeBps: 0 }
const BUY = { tokenId: TOKEN, side: 'BUY', price: '0.5', size: '100', isMaker: false }

function makeDeps(over = {}) {
  return {
    checkGeoblock: vi.fn().mockResolvedValue({ blocked: false, ok: true }),
    fetchFeeRate: vi.fn().mockResolvedValue(FEE),
    ensureCreds: vi.fn().mockResolvedValue({ key: 'k', secret: 's', passphrase: 'p' }),
    makeClient: vi.fn(() => ({ id: 'clob-client' })),
    makeBuilderConfig: vi.fn(() => undefined),
    submitOrder: vi.fn().mockResolvedValue({ orderId: '0xneworder', status: 'matched' }),
    cancelOrder: vi.fn().mockResolvedValue({ cancelled: true }),
    resolveTradeSigner: vi.fn(() => ({ canSign: true, kind: 'eoa', address: TRADER })),
    loadCachedCreds: vi.fn(() => null),
    gatewayUrl: vi.fn(() => ''),
    ...over,
  }
}

function wrapperFor(walletOver = {}) {
  const wallet = { address: TRADER, loginMethod: 'wallet', switchChain: vi.fn().mockResolvedValue(), ...walletOver }
  return ({ children }) => <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
}

beforeEach(() => {
  vi.clearAllMocks()
  setWalletChain(137)
})

describe('usePredictTrade', () => {
  it('checks the region then loads the fee and becomes ready', async () => {
    const deps = makeDeps()
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.loadFee(TOKEN) })
    expect(deps.checkGeoblock).toHaveBeenCalled()
    expect(result.current.status).toBe('ready')
    expect(result.current.fee).toBe(FEE)
  })

  it('shows the region link-out when geoblocked — never signs (FR-019)', async () => {
    const deps = makeDeps({ checkGeoblock: vi.fn().mockResolvedValue({ blocked: true, country: 'US', region: 'TX', ok: true }) })
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.loadFee(TOKEN) })
    expect(result.current.status).toBe('geoblocked')
    expect(result.current.geoInfo).toMatchObject({ country: 'US', region: 'TX' })
    expect(deps.fetchFeeRate).not.toHaveBeenCalled()
    expect(deps.submitOrder).not.toHaveBeenCalled()
  })

  it('BLOCKS when the fee cannot be confirmed — never signs (FR-010)', async () => {
    const deps = makeDeps({ fetchFeeRate: vi.fn().mockRejectedValue(new Error('down')) })
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.loadFee(TOKEN) })
    expect(result.current.status).toBe('blocked')
    expect(deps.submitOrder).not.toHaveBeenCalled()
  })

  it('previews the honest total including the additive builder fee', async () => {
    const deps = makeDeps()
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.loadFee(TOKEN) })
    const p = result.current.preview(BUY)
    expect(p.totalCostUnits).toBe(50_250000n)
    expect(p.feeLines.map((l) => l.label)).toContain('FairWins builder fee')
  })

  it('derives creds then submits the order via the SDK (attribution rides on the builder config)', async () => {
    const deps = makeDeps()
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.loadFee(TOKEN) })
    await act(async () => { await result.current.submit(BUY, { negRisk: true }) })
    expect(result.current.status).toBe('done')
    expect(deps.ensureCreds).toHaveBeenCalled()
    expect(deps.makeBuilderConfig).toHaveBeenCalled()
    expect(deps.submitOrder).toHaveBeenCalledOnce()
    const [client, order] = deps.submitOrder.mock.calls[0]
    expect(client).toEqual({ id: 'clob-client' })
    expect(order).toMatchObject({ tokenId: TOKEN, side: 'BUY', price: '0.5', size: '100', negRisk: true })
  })

  it('prompts a network switch when off Polygon (FR-021)', async () => {
    setWalletChain(1)
    const deps = makeDeps()
    const switchChain = vi.fn().mockRejectedValue(new Error('declined'))
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor({ switchChain }) })
    expect(result.current.onWrongNetwork).toBe(true)
    await act(async () => { await result.current.loadFee(TOKEN) })
    await act(async () => { await result.current.submit(BUY, {}) })
    expect(result.current.status).toBe('error')
    expect(result.current.reason).toMatch(/Polygon/)
    expect(deps.submitOrder).not.toHaveBeenCalled()
  })

  it('re-confirms on a price move (FR-008)', async () => {
    const deps = makeDeps({ submitOrder: vi.fn().mockRejectedValue(new Error('order not marketable at price')) })
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.loadFee(TOKEN) })
    let res
    await act(async () => { res = await result.current.submit(BUY, {}) })
    expect(res).toEqual({ priceChanged: true })
    expect(result.current.reason).toMatch(/moved/)
  })

  it('surfaces a submit-time geoblock (403) as the region state, not an error', async () => {
    const err = Object.assign(new Error('Trading restricted in your region'), { raw: { status: 403 } })
    const deps = makeDeps({ submitOrder: vi.fn().mockRejectedValue(err) })
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor() })
    await act(async () => { await result.current.loadFee(TOKEN) })
    await act(async () => { await result.current.submit(BUY, {}) })
    expect(result.current.status).toBe('geoblocked')
  })

  it('shows an honest reason when the account cannot sign (FR-019) — never a dead button', async () => {
    const deps = makeDeps({ resolveTradeSigner: vi.fn(() => ({ canSign: false, kind: 'passkey', reason: "Trading isn't available for passkey accounts yet." })) })
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor({ loginMethod: 'passkey' }) })
    expect(result.current.canTrade).toBe(false)
    expect(result.current.unsupportedReason).toMatch(/passkey/)
    await act(async () => { await result.current.loadFee(TOKEN) })
    expect(result.current.status).toBe('blocked')
  })

  // ---- Passkey (ERC-1271 smart account) rail — spec 057 FR-019 ----

  const PASSKEY_SIGNER = { getAddress: async () => TRADER, _signTypedData: async () => '0xenvelope' }

  function passkeyDeps(over = {}) {
    return makeDeps({
      resolveTradeSigner: vi.fn(() => ({ canSign: true, kind: 'passkey', address: TRADER, credentialId: 'cred-1' })),
      makePasskeySigner: vi.fn().mockResolvedValue(PASSKEY_SIGNER),
      missingApprovals: vi.fn().mockResolvedValue([]),
      readSession: vi.fn(() => ({ credentialId: 'cred-1' })),
      ...over,
    })
  }

  it('passkey submit signs through the ERC-1271 shim with signatureType 3, maker == funder == the account', async () => {
    const deps = passkeyDeps()
    const sendCalls = vi.fn()
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor({ loginMethod: 'passkey', sendCalls }) })
    await act(async () => { await result.current.loadFee(TOKEN) })
    await act(async () => { await result.current.submit(BUY, {}) })
    expect(result.current.status).toBe('done')
    expect(deps.makePasskeySigner).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 137, address: TRADER, credentialId: 'cred-1' })
    )
    expect(deps.ensureCreds).toHaveBeenCalledWith(PASSKEY_SIGNER, { address: TRADER })
    const [signerArg, , opts] = deps.makeClient.mock.calls[0]
    expect(signerArg).toBe(PASSKEY_SIGNER)
    expect(opts).toMatchObject({ signatureType: 3, funderAddress: TRADER })
    expect(sendCalls).not.toHaveBeenCalled() // fully approved account: no ceremony
  })

  it('passkey first trade batches the missing approvals through sendCalls BEFORE minting creds', async () => {
    const approvals = [
      { target: '0xUSDC', data: '0xapprove1' },
      { target: '0xCTF', data: '0xapprove2' },
    ]
    const order = []
    const deps = passkeyDeps({
      missingApprovals: vi.fn(async () => { order.push('approvals-check'); return approvals }),
      ensureCreds: vi.fn(async () => { order.push('creds'); return { key: 'k', secret: 's', passphrase: 'p' } }),
    })
    const sendCalls = vi.fn(async () => { order.push('sendCalls') })
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor({ loginMethod: 'passkey', sendCalls }) })
    await act(async () => { await result.current.loadFee(TOKEN) })
    await act(async () => { await result.current.submit(BUY, {}) })
    expect(result.current.status).toBe('done')
    expect(sendCalls).toHaveBeenCalledWith(
      [
        { target: '0xUSDC', data: '0xapprove1' },
        { target: '0xCTF', data: '0xapprove2' },
      ],
      { chainId: 137 } // pinned by parameter — a stale session chain must never retarget the batch
    )
    expect(order).toEqual(['approvals-check', 'sendCalls', 'creds'])
  })

  it('enableTrading enforces Polygon BEFORE any approvals ceremony (FR-021)', async () => {
    setWalletChain(1)
    const deps = passkeyDeps({ missingApprovals: vi.fn().mockResolvedValue([{ target: '0xUSDC', data: '0x1' }]) })
    const sendCalls = vi.fn()
    const switchChain = vi.fn().mockRejectedValue(new Error('declined'))
    const { result } = renderHook(() => usePredictTrade({ deps }), {
      wrapper: wrapperFor({ loginMethod: 'passkey', sendCalls, switchChain }),
    })
    await act(async () => { await result.current.loadFee(TOKEN) })
    let ok
    await act(async () => { ok = await result.current.enableTrading() })
    expect(ok).toBe(false)
    expect(result.current.status).toBe('error')
    expect(result.current.reason).toMatch(/Polygon/)
    expect(sendCalls).not.toHaveBeenCalled()
    expect(deps.ensureCreds).not.toHaveBeenCalled()
  })

  it('a failed approvals batch surfaces as an honest error with the link-out path — never a submit', async () => {
    const deps = passkeyDeps({ missingApprovals: vi.fn().mockResolvedValue([{ target: '0xUSDC', data: '0x1' }]) })
    const sendCalls = vi.fn().mockRejectedValue(new Error('User cancelled the passkey prompt'))
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor({ loginMethod: 'passkey', sendCalls }) })
    await act(async () => { await result.current.loadFee(TOKEN) })
    await act(async () => { await result.current.submit(BUY, {}) })
    expect(result.current.status).toBe('error')
    expect(result.current.reason).toMatch(/cancelled/i)
    expect(deps.submitOrder).not.toHaveBeenCalled()
  })

  it('passkey cancel needs creds only — no approvals read, no ceremony', async () => {
    const deps = passkeyDeps()
    const sendCalls = vi.fn()
    const { result } = renderHook(() => usePredictTrade({ deps }), { wrapper: wrapperFor({ loginMethod: 'passkey', sendCalls }) })
    await act(async () => { await result.current.cancel({ orderId: '0xopen' }) })
    expect(result.current.status).toBe('done')
    expect(deps.missingApprovals).not.toHaveBeenCalled()
    expect(sendCalls).not.toHaveBeenCalled()
    const [, , opts] = deps.makeClient.mock.calls[0]
    expect(opts).toMatchObject({ signatureType: 3, funderAddress: TRADER })
  })
})
