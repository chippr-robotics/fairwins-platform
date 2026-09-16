import { describe, it, expect, vi } from 'vitest'
import { ethers } from 'ethers'
import {
  signTransferAuthorization,
  relayGaslessTransfer,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from '../lib/transfer/eip3009Transfer'

// Pay & Transfer gasless leg (no backend): the sender signs an EIP-3009 TransferWithAuthorization; a
// third-party relayer submits token.transferWithAuthorization and pays gas. We verify the signature
// recovers to the sender (so the token will accept it) and that relaying is gated on a configured relayer.

describe('Pay & Transfer — EIP-3009 transferWithAuthorization', () => {
  it('signs an authorization that recovers to the sender', async () => {
    // Fixed key (Wallet.createRandom's mnemonic path hits an ethers/jsdom crypto quirk under vitest).
    const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
    const token = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' // Polygon native USDC
    const to = '0x00000000000000000000000000000000000000aa'
    const auth = await signTransferAuthorization({
      signer: wallet,
      token,
      tokenName: 'USD Coin',
      tokenVersion: '2',
      chainId: 137,
      to,
      value: ethers.parseUnits('25', 6),
      nowSeconds: 1_000_000,
      validitySeconds: 3600,
    })

    const domain = { name: 'USD Coin', version: '2', chainId: 137, verifyingContract: token }
    const recovered = ethers.verifyTypedData(
      domain,
      TRANSFER_WITH_AUTHORIZATION_TYPES,
      {
        from: auth.from,
        to: auth.to,
        value: auth.value.toString(),
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
      },
      ethers.Signature.from({ v: auth.v, r: auth.r, s: auth.s })
    )
    expect(recovered).toBe(wallet.address)
    // Spec 110 divergence 10 — the authorization is JSON-serialized to a relayer, and viem's
    // parseSignature would have made `v` a bigint, which JSON.stringify refuses. A recovery check
    // cannot see this: ethers' Signature.from accepts a bigint v perfectly happily.
    expect(typeof auth.v).toBe('number')
    expect(() => JSON.stringify(auth, (k, x) => (typeof x === 'bigint' ? x.toString() : x))).not.toThrow()
    expect(auth.from).toBe(wallet.address)
    expect(auth.to).toBe(to)
    expect(auth.validBefore).toBe(1_000_000 + 3600)
  })

  it('relays through a configured relayer, and errors clearly without one', async () => {
    const relayer = vi.fn().mockResolvedValue({ txHash: '0xabc' })
    const res = await relayGaslessTransfer(relayer, { from: '0x1', to: '0x2' }, { token: '0xtok', chainId: 137 })
    expect(res.txHash).toBe('0xabc')
    expect(relayer).toHaveBeenCalledWith({ from: '0x1', to: '0x2' }, { token: '0xtok', chainId: 137 })
    // Identity-free: only token + chain travel with the authorization, no FairWins identity.
    expect(relayer.mock.calls[0][1]).not.toHaveProperty('identityCommitment')

    await expect(relayGaslessTransfer(null, {}, {})).rejects.toThrow(/no gasless relayer/i)
  })
})
