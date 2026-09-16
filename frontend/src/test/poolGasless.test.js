import { describe, it, expect, vi } from 'vitest'
import { ethers } from 'ethers'
import { signReceiveAuthorization, relayGaslessJoin } from '../lib/pools/gasless'

// US3 client-side gasless (spec 034, no backend): the member signs an EIP-3009 authorization; a
// third-party relayer submits. We verify the signature recovers to the signer and that relay is gated.

describe('pool gasless (client-side, no backend)', () => {
  it('signs an EIP-3009 authorization that recovers to the signer', async () => {
    // Fixed key (Wallet.createRandom's mnemonic path hits an ethers/jsdom crypto quirk under vitest).
    const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
    const token = '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'
    const to = '0x00000000000000000000000000000000000000aa'
    const auth = await signReceiveAuthorization({
      signer: wallet,
      token,
      tokenName: 'USD Coin',
      tokenVersion: '2',
      chainId: 80002,
      to,
      value: ethers.parseUnits('10', 6),
      nowSeconds: 1_000_000,
      validitySeconds: 3600,
    })
    const domain = { name: 'USD Coin', version: '2', chainId: 80002, verifyingContract: token }
    const types = {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    }
    const recovered = ethers.verifyTypedData(
      domain,
      types,
      { from: auth.from, to: auth.to, value: auth.value.toString(), validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce },
      ethers.Signature.from({ v: auth.v, r: auth.r, s: auth.s })
    )
    expect(recovered).toBe(wallet.address)
    expect(auth.to).toBe(to)
    // Spec 110 divergence 10 — the authorization is JSON-serialized to a relayer, and viem's
    // parseSignature would have made `v` a bigint, which JSON.stringify refuses. A recovery check
    // cannot see this: ethers' Signature.from accepts a bigint v perfectly happily.
    expect(typeof auth.v).toBe('number')
    expect(() => JSON.stringify(auth, (k, x) => (typeof x === 'bigint' ? x.toString() : x))).not.toThrow()
  })

  it('relays an identity-free join through a configured relayer, and errors clearly without one', async () => {
    const relayer = vi.fn().mockResolvedValue({ txHash: '0xabc' })
    const res = await relayGaslessJoin(relayer, { foo: 1 }, { pool: '0xaa' })
    expect(res.txHash).toBe('0xabc')
    // The relay context is identity-free: only the pool address is forwarded (no commitment).
    expect(relayer).toHaveBeenCalledWith({ foo: 1 }, { pool: '0xaa' })
    expect(relayer.mock.calls[0][1]).not.toHaveProperty('identityCommitment')
    await expect(relayGaslessJoin(null, {}, {})).rejects.toThrow(/no gasless relayer/i)
  })
})
