/**
 * Spec 041 T019 — smart-account layer: owner-bytes encodings (must match the
 * MultiOwnable ABI exactly — parity vectors from test/account/factory.test.js),
 * batch composition, guard refusals, capability gating per network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeAbiParameters } from 'viem'

const SIGNATURE_WRAPPER_ABI = [
  {
    type: 'tuple',
    components: [
      { name: 'ownerIndex', type: 'uint8' },
      { name: 'signatureData', type: 'bytes' },
    ],
  },
]
const stubOwnerIndex = (sig) => Number(decodeAbiParameters(SIGNATURE_WRAPPER_ABI, sig)[0].ownerIndex)
const stubSignatureData = (sig) => decodeAbiParameters(SIGNATURE_WRAPPER_ABI, sig)[0].signatureData

vi.mock('../../../config/networks', () => ({
  getNetwork: vi.fn((chainId) => {
    if (chainId === 80002) {
      return {
        chainId: 80002,
        rpcUrl: 'https://rpc.example',
        capabilities: { passkeyAccounts: true },
        passkey: { bundlerUrls: ['https://bundler.example'], sponsorPaymasterUrl: null },
      }
    }
    if (chainId === 137) {
      return {
        chainId: 137,
        rpcUrl: 'https://rpc.example',
        capabilities: { passkeyAccounts: true },
        passkey: {
          bundlerUrls: ['https://bundler.example/polygon'],
          sponsorPaymasterUrl: 'https://paymaster.example/polygon',
        },
      }
    }
    return { chainId, capabilities: { passkeyAccounts: false }, passkey: null }
  }),
  // `defaultPublicClient` now resolves its route through the spec-069 seam (spec 104 FR-012),
  // and `rpcEndpoints` reads the build default off this map.
  NETWORKS: {
    80002: { chainId: 80002, rpcUrl: 'https://rpc.example' },
    137: { chainId: 137, rpcUrl: 'https://rpc.example' },
  },
}))

vi.mock('../../../config/contracts', () => ({
  getContractAddressForChain: vi.fn((key, chainId) => {
    if (chainId !== 80002 && chainId !== 137) return null
    return {
      accountFactory: '0xFAC70000000000000000000000000000000000001'.slice(0, 42),
      entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    }[key]
  }),
}))

// viem 2.53's `toCoinbaseSmartAccount.getStubSignature()` for a WebAuthn owner:
// a SignatureWrapper with a HARDCODED ownerIndex 0 (word[1] == 0) wrapping a
// dummy WebAuthnAuth. Estimation validates this against slot 0 (see the
// stub-index override under test).
const VIEM_WEBAUTHN_STUB =
  '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000170000000000000000000000000000000000000000000000000000000000000001949fc7c88032b9fcb5f6efc7a7b8c63668eae9871b765e23123bb473ff57aa831a7c0d9276168ebcc29f2875a0239cffdf2a9cd1c2007c5c77c071db9264df1d000000000000000000000000000000000000000000000000000000000000002549960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97630500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008a7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a2273496a396e6164474850596759334b7156384f7a4a666c726275504b474f716d59576f4d57516869467773222c226f726967696e223a2268747470733a2f2f7369676e2e636f696e626173652e636f6d222c2263726f73734f726967696e223a66616c73657d00000000000000000000000000000000000000000000'

vi.mock('viem/account-abstraction', async () => {
  const actual = await vi.importActual('viem/account-abstraction')
  return {
    ...actual,
    toWebAuthnAccount: vi.fn(() => ({ type: 'webAuthnAccount' })),
    // Echo the pinned `address` param (the factory-mismatch fix pins the sender) and expose an
    // isDeployed the getFactoryArgs override consults; default counterfactual.
    // getStubSignature mirrors viem's WebAuthn stub (hardcoded ownerIndex 0) so the
    // stub-index override in buildAccount can be exercised.
    toCoinbaseSmartAccount: vi.fn(async (params) => ({
      address: params?.address ?? '0xACC0000000000000000000000000000000000001',
      isDeployed: vi.fn().mockResolvedValue(false),
      getStubSignature: vi.fn().mockResolvedValue(VIEM_WEBAUTHN_STUB),
    })),
    createBundlerClient: vi.fn((opts) => opts),
    createPaymasterClient: vi.fn((opts) => ({ __isPaymasterClient: true, ...opts })),
  }
})

import { createBundlerClient, createPaymasterClient, toCoinbaseSmartAccount } from 'viem/account-abstraction'
import {
  publicKeyToOwnerBytes,
  addressToOwnerBytes,
  buildAction,
  buildAccount,
  rewrapStubOwnerIndex,
  resolveOwnerIndex,
  encodeRemoveOwner,
  encodeAddWalletOwner,
  requirePasskeySupport,
  deriveAddress,
  computeAccountAddress,
  defaultPublicClient,
  ChainNotSupportedError,
  LastControllerError,
  CredentialRecordIncomplete,
  CredentialNotControllerError,
} from '../smartAccount'

const X = '0x' + '11'.repeat(32)
const Y = '0x' + '22'.repeat(32)

describe('owner-bytes encodings (MultiOwnable ABI parity)', () => {
  it('encodes a P-256 public key as 64 bytes x||y (abi.encode(bytes32,bytes32))', () => {
    const bytes = publicKeyToOwnerBytes({ x: X, y: Y })
    expect(bytes).toBe('0x' + '11'.repeat(32) + '22'.repeat(32))
    expect(bytes.length).toBe(2 + 128)
  })

  it('encodes an EOA as 32 bytes left-padded (abi.encode(address))', () => {
    const addr = '0xAbCd000000000000000000000000000000000123'
    const bytes = addressToOwnerBytes(addr)
    expect(bytes).toBe('0x' + '0'.repeat(24) + addr.slice(2).toLowerCase())
    expect(bytes.length).toBe(2 + 64)
  })
})

describe('capability gating (FR-022)', () => {
  it('resolves the stack on a supported network', () => {
    const out = requirePasskeySupport(80002)
    expect(out.factory).toMatch(/^0xFAC7/i)
    expect(out.bundlerUrls).toHaveLength(1)
  })

  it('throws ChainNotSupportedError on ETC/Mordor-class networks', () => {
    expect(() => requirePasskeySupport(63)).toThrow(ChainNotSupportedError)
  })
})

describe('defaultPublicClient (issue #854 — client.chain.id crash)', () => {
  it('sets a chain with the network id, not just a bare transport', () => {
    // viem's toCoinbaseSmartAccount reads `client.chain.id` unconditionally inside
    // sign/signMessage/signTypedData/signUserOperation. A publicClient built without
    // a `chain` leaves that undefined, so every passkey ceremony crashed with
    // "Cannot read properties of undefined (reading 'id')" the moment it tried to sign.
    const client = defaultPublicClient(80002)
    expect(client.chain).toBeDefined()
    expect(client.chain.id).toBe(80002)
  })

  it('is reused as-is by buildAccount/deriveAddress/readControllers (no separate bare client)', () => {
    const client = defaultPublicClient(137)
    expect(client.chain.id).toBe(137)
  })

  it("honours the MEMBER's own endpoint rather than the build default (spec 069 / spec 104 FR-012)", async () => {
    // This path used to build its transport straight from NETWORKS[chainId].rpcUrl, which spec 069
    // forbids: a member who configured their own endpoint had it honoured everywhere except the
    // one read path that decides whether they can reach their account. Recovery is read-heavy, so
    // it is also the path most likely to be rate-limited off a shared default — and the cost there
    // is not a slow screen, it is an `unverified` verdict on a member's own account.
    const { saveEndpointSettings, resetEndpointSettings } = await import('../../network/endpointStore')
    saveEndpointSettings(80002, { url: 'https://member.example/rpc' })
    try {
      const client = defaultPublicClient(80002)
      // A member route yields a fallback stack (their endpoint, then the build default behind it),
      // so a custom endpoint going dark degrades instead of taking the chain down with it.
      expect(JSON.stringify(client.transport)).toContain('member.example')
    } finally {
      resetEndpointSettings(80002)
    }
  })
})

describe('deriveAddress', () => {
  it('computes the address LOCALLY — no RPC, so sign-in works on any chain', async () => {
    // Was an eth_call to the factory's getAddress behind requirePasskeySupport, which made
    // sign-in fail on chains with no passkey config. A rejecting client proves nothing is read.
    const publicClient = { readContract: vi.fn().mockRejectedValue(new Error('RPC must not be used')) }
    const ownersBytes = [publicKeyToOwnerBytes({ x: X, y: Y })]
    const addr = await deriveAddress({ chainId: 80002, ownersBytes, nonce: 7n, deps: { publicClient } })
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(publicClient.readContract).not.toHaveBeenCalled()
  })

  it('binds owners and nonce into the salt (different inputs ⇒ different accounts)', async () => {
    const owners = [publicKeyToOwnerBytes({ x: X, y: Y })]
    const other = [publicKeyToOwnerBytes({ x: Y, y: X })]
    const [a, b, c] = await Promise.all([
      deriveAddress({ chainId: 80002, ownersBytes: owners, nonce: 0n }),
      deriveAddress({ chainId: 80002, ownersBytes: owners, nonce: 7n }),
      deriveAddress({ chainId: 80002, ownersBytes: other, nonce: 0n }),
    ])
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe('action composition + guards', () => {
  it('buildAction shapes approve+act as one batch (FR-016)', () => {
    const { calls } = buildAction([
      { target: '0x' + 'a'.repeat(40), data: '0x01' },
      { target: '0x' + 'b'.repeat(40), data: '0x02', value: 5n },
    ])
    expect(calls).toEqual([
      { to: '0x' + 'a'.repeat(40), value: 0n, data: '0x01' },
      { to: '0x' + 'b'.repeat(40), value: 5n, data: '0x02' },
    ])
  })

  it('encodeRemoveOwner refuses to strand the account (FR-020 client half)', () => {
    expect(() => encodeRemoveOwner({ index: 0n, ownerBytes: '0x' + '0'.repeat(64), ownerCount: 1n })).toThrow(
      LastControllerError
    )
  })

  it('encodeRemoveOwner / encodeAddWalletOwner produce calldata for the vendored ABI', () => {
    const remove = encodeRemoveOwner({
      index: 1n,
      ownerBytes: addressToOwnerBytes('0x' + 'c'.repeat(40)),
      ownerCount: 2n,
    })
    expect(remove.startsWith('0x')).toBe(true)
    const add = encodeAddWalletOwner('0x' + 'd'.repeat(40))
    expect(add.startsWith('0x')).toBe(true)
    expect(add.toLowerCase()).toContain('d'.repeat(40))
  })
})

describe('buildAccount credential validation (spec 045 FR-006)', () => {
  it('refuses an incomplete record before any ceremony — the old "reading id" crash', async () => {
    const publicClient = { readContract: vi.fn(), getCode: vi.fn() }
    await expect(
      buildAccount({ chainId: 80002, credential: { address: '0xA11CE' }, deps: { publicClient } })
    ).rejects.toBeInstanceOf(CredentialRecordIncomplete)
    await expect(
      buildAccount({ chainId: 80002, credential: { credentialId: 'c1' }, deps: { publicClient } })
    ).rejects.toBeInstanceOf(CredentialRecordIncomplete)
    expect(publicClient.readContract).not.toHaveBeenCalled()
  })
})

describe('buildAccount sponsoring-paymaster wiring (spec 050)', () => {
  const credential = { credentialId: 'c1', publicKey: { x: X, y: Y } }
  const publicClient = { readContract: vi.fn(), getCode: vi.fn() }

  beforeEach(() => {
    createBundlerClient.mockClear()
    createPaymasterClient.mockClear()
  })

  it('builds a paymaster client from the network config, passes it to the bundler client, and reports sponsored:true', async () => {
    const out = await buildAccount({ chainId: 137, credential, ownerIndex: 0, deps: { publicClient } })

    expect(createPaymasterClient).toHaveBeenCalledTimes(1)
    const bundlerOpts = createBundlerClient.mock.calls[0][0]
    expect(bundlerOpts.paymaster).toEqual(expect.objectContaining({ __isPaymasterClient: true }))
    expect(out.sponsored).toBe(true)
  })

  it('omits the paymaster (native-token fallback, sponsored:false) when no sponsor endpoint is configured', async () => {
    const out = await buildAccount({ chainId: 80002, credential, ownerIndex: 0, deps: { publicClient } })

    expect(createPaymasterClient).not.toHaveBeenCalled()
    const bundlerOpts = createBundlerClient.mock.calls[0][0]
    expect(bundlerOpts.paymaster).toBeUndefined()
    expect(out.sponsored).toBe(false)
  })

  it('deps.noPaymaster forces self-funding even when a sponsor endpoint is configured (never-stranded retry)', async () => {
    const out = await buildAccount({ chainId: 137, credential, ownerIndex: 0, deps: { publicClient, noPaymaster: true } })

    expect(createPaymasterClient).not.toHaveBeenCalled()
    const bundlerOpts = createBundlerClient.mock.calls[0][0]
    expect(bundlerOpts.paymaster).toBeUndefined()
    expect(out.sponsored).toBe(false)
  })

  it('a test-injected deps.paymaster still overrides the configured URL', async () => {
    const injected = { __testPaymaster: true }
    const out = await buildAccount({ chainId: 137, credential, ownerIndex: 0, deps: { publicClient, paymaster: injected } })

    expect(createPaymasterClient).not.toHaveBeenCalled()
    const bundlerOpts = createBundlerClient.mock.calls[0][0]
    expect(bundlerOpts.paymaster).toBe(injected)
    expect(out.sponsored).toBe(true)
  })
})

describe('buildAccount FairWins-factory address pinning (factory-mismatch fix)', () => {
  const credential = { credentialId: 'c1', publicKey: { x: X, y: Y } }
  const ownerBytes = publicKeyToOwnerBytes({ x: X, y: Y })
  const FUNDED = '0xF1F269F7ABF9C94963692D53A0D9386DB36EA4C0'

  beforeEach(() => {
    toCoinbaseSmartAccount.mockClear()
  })

  it('pins the viem sender to the caller-supplied account address (never viem’s Coinbase-factory address)', async () => {
    const publicClient = { readContract: vi.fn(), getCode: vi.fn() }
    const out = await buildAccount({
      chainId: 137,
      credential,
      accountAddress: FUNDED,
      ownerIndex: 0,
      deps: { publicClient },
    })
    // viem is told the address explicitly — it must NOT query its own (wrong) factory to derive it.
    expect(toCoinbaseSmartAccount.mock.calls[0][0].address).toBe(FUNDED)
    expect(publicClient.readContract).not.toHaveBeenCalled()
    expect(out.account.address).toBe(FUNDED)
  })

  it('derives the sender from the FairWins factory params when the caller omits it', async () => {
    // Derivation is LOCAL now (CREATE2 over the configured factory + pinned initCodeHash), so no
    // RPC is consulted — but the result must still be exactly what the factory would have
    // returned, and it must be what viem is pinned to. Pinning viem to anything else is the
    // factory-mismatch bug this describe block exists to prevent.
    const publicClient = { readContract: vi.fn(), getCode: vi.fn() }
    await buildAccount({ chainId: 137, credential, ownerIndex: 0, deps: { publicClient } })
    const expected = computeAccountAddress({ ownersBytes: [ownerBytes], nonce: 0n })
    expect(publicClient.readContract).not.toHaveBeenCalled()
    expect(toCoinbaseSmartAccount.mock.calls[0][0].address).toBe(expected)
  })

  it('overrides getFactoryArgs to deploy via the FairWins factory while counterfactual', async () => {
    const publicClient = { readContract: vi.fn(), getCode: vi.fn() }
    const out = await buildAccount({
      chainId: 137,
      credential,
      accountAddress: FUNDED,
      ownerIndex: 0,
      deps: { publicClient },
    })
    const args = await out.account.getFactoryArgs()
    // The FairWins factory (0xFAC7…), NOT viem’s hardwired Coinbase factory (0x0ba5ed0c…).
    expect(args.factory).toMatch(/^0xFAC7/i)
    expect(args.factory.toLowerCase()).not.toBe('0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428a')
    // createAccount([ownerBytes], 0) calldata carries the initial owner bytes.
    expect(args.factoryData.toLowerCase()).toContain('11'.repeat(32) + '22'.repeat(32))
  })

  it('emits NO initCode once the account is deployed (preserves viem’s isDeployed guard)', async () => {
    const publicClient = { readContract: vi.fn(), getCode: vi.fn() }
    const out = await buildAccount({
      chainId: 137,
      credential,
      accountAddress: FUNDED,
      ownerIndex: 0,
      deps: { publicClient },
    })
    out.account.isDeployed.mockResolvedValue(true)
    const args = await out.account.getFactoryArgs()
    expect(args).toEqual({ factory: undefined, factoryData: undefined })
  })
})

describe('resolveOwnerIndex (spec 045 FR-009)', () => {
  const credential = { credentialId: 'c1', publicKey: { x: X, y: Y } }
  const myOwnerBytes = publicKeyToOwnerBytes({ x: X, y: Y })

  it('returns the credential’s REAL slot on a deployed multi-controller account', async () => {
    const readControllers = vi.fn().mockResolvedValue({
      deployed: true,
      controllers: [
        { index: 0n, kind: 'wallet', ownerBytes: addressToOwnerBytes('0x' + 'e'.repeat(40)) },
        { index: 2n, kind: 'passkey', ownerBytes: myOwnerBytes },
      ],
    })
    const out = await resolveOwnerIndex({
      chainId: 80002,
      accountAddress: '0xACC',
      credential,
      deps: { readControllers },
    })
    expect(out).toBe(2)
  })

  it('falls back to slot 0 for counterfactual (undeployed) accounts', async () => {
    const readControllers = vi.fn().mockResolvedValue({ deployed: false, controllers: [] })
    expect(
      await resolveOwnerIndex({ chainId: 80002, accountAddress: '0xACC', credential, deps: { readControllers } })
    ).toBe(0)
  })

  it('falls back to slot 0 when controllers cannot be read (RPC failure)', async () => {
    const readControllers = vi.fn().mockRejectedValue(new Error('rpc down'))
    expect(
      await resolveOwnerIndex({ chainId: 80002, accountAddress: '0xACC', credential, deps: { readControllers } })
    ).toBe(0)
  })

  it('throws (never guesses) when the deployed account no longer lists the credential', async () => {
    const readControllers = vi.fn().mockResolvedValue({
      deployed: true,
      controllers: [{ index: 0n, kind: 'wallet', ownerBytes: addressToOwnerBytes('0x' + 'e'.repeat(40)) }],
    })
    await expect(
      resolveOwnerIndex({ chainId: 80002, accountAddress: '0xACC', credential, deps: { readControllers } })
    ).rejects.toBeInstanceOf(CredentialNotControllerError)
  })
})

describe('rewrapStubOwnerIndex (estimation stub validates the signing owner slot)', () => {
  it('viem’s WebAuthn stub really does hardcode ownerIndex 0 (the bug it fixes)', () => {
    expect(stubOwnerIndex(VIEM_WEBAUTHN_STUB)).toBe(0)
  })

  it('re-points the stub at a non-zero index, preserving the dummy signatureData', () => {
    const rewrapped = rewrapStubOwnerIndex(VIEM_WEBAUTHN_STUB, 2)
    expect(stubOwnerIndex(rewrapped)).toBe(2)
    // Only the index changes — the dummy WebAuthnAuth payload is untouched.
    expect(stubSignatureData(rewrapped)).toBe(stubSignatureData(VIEM_WEBAUTHN_STUB))
  })

  it('is a byte-for-byte no-op for slot 0 (pristine single-passkey accounts unchanged)', () => {
    expect(rewrapStubOwnerIndex(VIEM_WEBAUTHN_STUB, 0)).toBe(VIEM_WEBAUTHN_STUB)
  })

  it('returns an undecodable stub untouched (never blocks a send)', () => {
    expect(rewrapStubOwnerIndex('0xdeadbeef', 3)).toBe('0xdeadbeef')
  })
})

describe('buildAccount stub-index override (validateUserOp-reverts-on-Prepare fix)', () => {
  const credential = { credentialId: 'c1', publicKey: { x: X, y: Y } }
  const publicClient = { readContract: vi.fn(), getCode: vi.fn() }

  it('re-points the estimation stub at the credential’s real owner index (slot 1)', async () => {
    const out = await buildAccount({ chainId: 137, credential, accountAddress: '0xACC', ownerIndex: 1, deps: { publicClient } })
    const stub = await out.account.getStubSignature()
    // Without the override this is 0 → validateUserOp reverts (InvalidOwnerBytesLength)
    // during estimation on an account whose slot 0 was removed. With it, estimation
    // validates the SAME live slot signUserOperation signs with.
    expect(stubOwnerIndex(stub)).toBe(1)
  })

  it('leaves the stub untouched for slot 0 (no override installed)', async () => {
    const out = await buildAccount({ chainId: 137, credential, accountAddress: '0xACC', ownerIndex: 0, deps: { publicClient } })
    const stub = await out.account.getStubSignature()
    expect(stub).toBe(VIEM_WEBAUTHN_STUB)
    expect(stubOwnerIndex(stub)).toBe(0)
  })
})
