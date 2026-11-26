/**
 * readClient (spec 114 T036b/T036c) — the read-only client shape shared by the order tracker and the open-orders
 * list, and the proof that a read can never raise a ceremony: with cached credentials `ensureClobCreds` (what a
 * cancel runs first) builds no client and signs nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import { readOnlySigner, readClientOptions } from '../../lib/predict/readClient'
import { ensureClobCreds } from '../../lib/predict/clobSession'

const ME = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'

describe('readOnlySigner', () => {
  it('names the address and refuses to sign', async () => {
    const s = readOnlySigner(ME)
    await expect(s.getAddress()).resolves.toBe(ME)
    await expect(s._signTypedData({}, {}, {})).rejects.toThrow(/never signs/)
  })
})

describe('readClientOptions', () => {
  it('a passkey session is the ERC-1271 shape, funded by the account', () => {
    expect(readClientOptions({ loginMethod: 'passkey', address: ME })).toEqual({ signatureType: 3, funderAddress: ME })
  })
  it('anything else is the plain shape', () => {
    expect(readClientOptions({ loginMethod: 'wallet', address: ME })).toEqual({})
    expect(readClientOptions({ loginMethod: undefined, address: ME })).toEqual({})
  })
  it('reads the RESOLVED kind (what usePredictTrade signs with), and ignores whether the session could sign', () => {
    const resolve = vi.fn(() => ({ kind: 'passkey', canSign: false, reason: 'Sign in again with your passkey to trade.' }))
    expect(readClientOptions({ loginMethod: 'wallet', address: ME, resolve })).toEqual({ signatureType: 3, funderAddress: ME })
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ address: ME }))
  })
})

describe('a cancel for a session whose credentials are cached raises no ceremony', () => {
  it('ensureClobCreds returns the cache before any client (and so any L1 signature) exists', async () => {
    const creds = { key: 'k', secret: 's', passphrase: 'p' }
    const storage = { getItem: () => JSON.stringify(creds), setItem: vi.fn(), removeItem: vi.fn() }
    const ClobClientImpl = vi.fn()
    const signer = { getAddress: vi.fn(), _signTypedData: vi.fn() }
    await expect(ensureClobCreds(signer, { address: ME, storage, ClobClientImpl })).resolves.toEqual(creds)
    expect(ClobClientImpl).not.toHaveBeenCalled()
    expect(signer._signTypedData).not.toHaveBeenCalled()
  })
})
