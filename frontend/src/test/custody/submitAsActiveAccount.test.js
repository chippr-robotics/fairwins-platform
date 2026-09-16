// Spec 043 (US3) — the active-account seam. Personal mode sends; the SafeTx builder wraps a batch in
// MultiSendCallOnly (delegatecall) and a single call directly. (The full vault emit+approve path is exercised
// via the app; here we cover the routing decision and payload construction, which are the risk points.)

import { describe, it, expect, vi } from 'vitest'
import { getAddress } from 'ethers'
import { buildActiveAccountSafeTx, submitAsActiveAccount } from '../../lib/custody/submitAsActiveAccount'
import { DELEGATECALL, CALL } from '../../lib/custody/vaultTransaction'

const MS = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2'
const TO = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'

describe('buildActiveAccountSafeTx', () => {
  it('uses a single call directly (operation CALL)', () => {
    const tx = buildActiveAccountSafeTx({ to: TO, value: 5n, data: '0x' }, { nonce: 3n, multiSendCallOnly: MS })
    expect(getAddress(tx.to)).toBe(getAddress(TO))
    expect(tx.value).toBe(5n)
    expect(tx.operation).toBe(CALL)
    expect(tx.nonce).toBe(3n)
  })

  it('wraps a batch in MultiSendCallOnly (operation DELEGATECALL to the MS contract)', () => {
    const batch = [
      { to: TOKEN, data: '0xabcd' },
      { to: TO, value: 1n },
    ]
    const tx = buildActiveAccountSafeTx({ batch }, { nonce: 9n, multiSendCallOnly: MS })
    expect(getAddress(tx.to)).toBe(getAddress(MS))
    expect(tx.operation).toBe(DELEGATECALL)
    expect(tx.data.startsWith('0x8d80ff0a')).toBe(true) // multiSend(bytes)
    expect(tx.nonce).toBe(9n)
  })

  // Issue #1368 — when a batch has to be split into N proposals for a policy-guarded vault, they
  // MUST occupy consecutive nonces. Proposed at the same nonce they would be mutually exclusive
  // (executing one invalidates the rest), so only one payment could ever land.
  it('honours an explicit nonce so a split batch can be queued in order', () => {
    const tx = buildActiveAccountSafeTx({ to: TO, value: 1n, nonce: 12n }, { nonce: 4n, multiSendCallOnly: MS })
    expect(tx.nonce).toBe(12n)
    expect(tx.operation).toBe(CALL)
  })

  it('a single-leg batch is a plain CALL, not a one-entry MultiSend delegatecall', () => {
    const tx = buildActiveAccountSafeTx({ batch: [{ to: TOKEN, data: '0xabcd' }] }, { nonce: 1n, multiSendCallOnly: MS })
    expect(getAddress(tx.to)).toBe(getAddress(TOKEN))
    expect(tx.operation).toBe(CALL)
    expect(tx.data).toBe('0xabcd')
  })
})

describe('submitAsActiveAccount (personal mode)', () => {
  it('sends via the connected signer and returns a sent result', async () => {
    const signer = { sendTransaction: vi.fn().mockResolvedValue({ hash: '0xdeadbeef' }) }
    const res = await submitAsActiveAccount({ to: TO, value: 7n, data: '0x' }, { mode: 'personal', signer })
    expect(res).toEqual({ kind: 'sent', txHash: '0xdeadbeef' })
    expect(signer.sendTransaction).toHaveBeenCalledWith({ to: TO, value: 7n, data: '0x' })
  })
})

describe('submitAsActiveAccount (vault mode) guards', () => {
  it('throws a clear error when the hub is not configured', async () => {
    await expect(
      submitAsActiveAccount({ to: TO }, { mode: 'vault', vaultAddress: TO, chainId: 63, hubAddress: undefined, safeContracts: {}, signer: {} }),
    ).rejects.toThrow(/not configured/i)
  })

  it('throws when Safe contracts are unavailable on the network', async () => {
    await expect(
      submitAsActiveAccount({ to: TO }, { mode: 'vault', vaultAddress: TO, chainId: 63, hubAddress: TO, safeContracts: undefined, signer: {} }),
    ).rejects.toThrow(/not available/i)
  })

  it('refuses when the connected provider is on a different chain than the vault', async () => {
    const provider = { getNetwork: async () => ({ chainId: 137n }) }
    await expect(
      submitAsActiveAccount(
        { to: TO },
        { mode: 'vault', vaultAddress: TO, chainId: 63, hubAddress: TO, safeContracts: { multiSendCallOnly: TO }, signer: {}, provider },
      ),
    ).rejects.toThrow(/nothing has been signed/i)
  })

  it('names BOTH chains in that refusal — "wrong network" is not something a member can act on', async () => {
    const provider = { getNetwork: async () => ({ chainId: 137n }) }
    const err = await submitAsActiveAccount(
      { to: TO },
      { mode: 'vault', vaultAddress: TO, chainId: 63, hubAddress: TO, safeContracts: { multiSendCallOnly: TO }, signer: {}, provider },
    ).catch((e) => e)
    expect(err.message).toMatch(/Mordor/)
    expect(err.message).toMatch(/Polygon/)
  })
})

/**
 * Spec 110 T026 — the personal branch used to name no chain at all, so it sent on whatever network
 * the signer happened to be bound to. That is the branch that moves the member's OWN money, and it
 * was the one without the guard the vault branch has had since 043.
 *
 * The assertions that carry weight here are the negative ones: nothing is sent on a refusal, and
 * the absence of a check never reads as a passed one.
 */
describe('submitAsActiveAccount (personal mode) — the chain is no longer ambient', () => {
  const signerOn = (chainId) => ({
    provider: { getNetwork: async () => ({ chainId: BigInt(chainId) }) },
    sendTransaction: vi.fn(async () => ({ hash: '0xsent', wait: async () => {} })),
  })

  it('refuses a send whose named chain is not where the signer is, and sends NOTHING', async () => {
    // Spec 088's acting signer is exactly this shape: the ceremony binds it to the wallet's
    // CURRENT chain and does not switch, so a surface asking for Base while the wallet sits on
    // Polygon used to get a Polygon transaction and a success.
    const signer = signerOn(137)
    const err = await submitAsActiveAccount({ to: TO, value: 1n }, { mode: 'personal', chainId: 8453, signer }).catch((e) => e)
    expect(err.message).toMatch(/Base/)
    expect(err.message).toMatch(/Polygon/)
    expect(err.message).toMatch(/nothing has been signed/i)
    expect(signer.sendTransaction).not.toHaveBeenCalled()
  })

  it('refuses a BATCH the same way, before the first leg goes out', async () => {
    // A sequential batch that fails halfway is the worst outcome available here: the approve is
    // mined on the wrong chain and the member is left holding an allowance they did not want.
    const signer = signerOn(137)
    const err = await submitAsActiveAccount(
      { batch: [{ to: TOKEN, data: '0xabcd' }, { to: TO, value: 1n }] },
      { mode: 'personal', chainId: 8453, signer },
    ).catch((e) => e)
    expect(err.message).toMatch(/nothing has been signed/i)
    expect(signer.sendTransaction).not.toHaveBeenCalled()
  })

  it('sends when the named chain is where the signer is', async () => {
    const signer = signerOn(137)
    const res = await submitAsActiveAccount({ to: TO, value: 1n }, { mode: 'personal', chainId: 137, signer })
    expect(res).toEqual({ kind: 'sent', txHash: '0xsent' })
  })

  it('sends unguarded when no chain was named — the soft gate every unconverted caller still uses', async () => {
    const signer = signerOn(137)
    const res = await submitAsActiveAccount({ to: TO, value: 1n }, { mode: 'personal', signer })
    expect(res.kind).toBe('sent')
    expect(signer.sendTransaction).toHaveBeenCalled()
  })

  it('does not treat a signer it cannot ask as a signer on the right chain', async () => {
    // No provider to read a network from. That is the ABSENCE of a check, and it must not be
    // recorded as a passed one anywhere — it sends, exactly as it did before, and claims nothing.
    const signer = { sendTransaction: vi.fn(async () => ({ hash: '0xsent' })) }
    const res = await submitAsActiveAccount({ to: TO, value: 1n }, { mode: 'personal', chainId: 8453, signer })
    expect(res).toEqual({ kind: 'sent', txHash: '0xsent' })
  })
})
