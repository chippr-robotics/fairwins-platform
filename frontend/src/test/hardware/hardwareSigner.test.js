/**
 * HardwareSigner (spec 087, FR-008/FR-009). Uses real ethers v6: the mock
 * session signs with a real Wallet's signing key so the recover-and-cross-check
 * guard is exercised for real — a session signing with the wrong account must
 * never serialize a broadcastable transaction.
 *
 * SPEC 110 T028 — the module under test is now viem, and ethers stays here as the ORACLE. That is
 * the point: this file builds the bytes a member is asked to approve on a device screen, so the
 * assertion that matters is not "it produced something plausible" but "it produced the same bytes
 * the previous implementation did", over every shape the app can hand it. `src/test/lint/
 * ethersRatchet.test.js` exempts `src/test/**`, and converting these imports to viem would make
 * the check tautological — it would assert that viem agrees with itself.
 */
import { describe, it, expect, vi } from 'vitest'
import { Wallet, Transaction, TypedDataEncoder, getAddress } from 'ethers'
import { createPublicClient, custom, parseTransaction, keccak256, recoverTransactionAddress } from 'viem'
import { HardwareSigner, yParityFrom, transactionTypeOf } from '../../lib/hardware/hardwareSigner'
import { HardwareWalletError } from '../../lib/hardware/errors'

// Well-known hardhat test keys — nothing secret.
const PK_A = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const PK_B = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const PATH = "m/44'/60'/0'/0/0"
const TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

/** A device session that really signs — backed by an ethers Wallet's key. */
function sessionFor(wallet) {
  return {
    vendor: 'ledger',
    signTransaction: vi.fn(async (path, unsignedSerialized) => {
      const tx = Transaction.from(unsignedSerialized)
      const sig = wallet.signingKey.sign(tx.unsignedHash)
      return { r: sig.r, s: sig.s, v: sig.v }
    }),
    signPersonalMessage: vi.fn(),
    signTypedData: vi.fn(),
    close: vi.fn(async () => {}),
  }
}

const txRequest = {
  to: TO,
  value: 1n,
  chainId: 137,
  nonce: 0,
  gasLimit: 21000n,
  maxFeePerGas: 1n,
  maxPriorityFeePerGas: 1n,
  type: 2,
}

describe('yParityFrom', () => {
  it('passes raw yParity bits through', () => {
    expect(yParityFrom(0)).toBe(0)
    expect(yParityFrom(1)).toBe(1)
  })

  it('normalizes legacy 27/28', () => {
    expect(yParityFrom(27)).toBe(0)
    expect(yParityFrom(28)).toBe(1)
  })

  it('normalizes EIP-155 v values (chainId 1 → 37/38)', () => {
    expect(yParityFrom(37)).toBe(0)
    expect(yParityFrom(38)).toBe(1)
    // Polygon (chainId 137): v = 35 + 2*137 + parity = 309/310
    expect(yParityFrom(309)).toBe(0)
    expect(yParityFrom(310)).toBe(1)
  })

  it('accepts hex strings', () => {
    expect(yParityFrom('0x1b')).toBe(0)
    expect(yParityFrom('0x1c')).toBe(1)
    expect(yParityFrom('0x0')).toBe(0)
    expect(yParityFrom('0x1')).toBe(1)
  })

  it('throws a HardwareWalletError on an unreadable v', () => {
    expect(() => yParityFrom('zz')).toThrow(HardwareWalletError)
  })
})

describe('signTransaction', () => {
  it('serializes a transaction that recovers to the connected account', async () => {
    const wallet = new Wallet(PK_A)
    const session = sessionFor(wallet)
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address })

    const raw = await signer.signTransaction(txRequest)
    const parsed = Transaction.from(raw)
    expect(parsed.from).toBe(wallet.address)
    expect(parsed.to).toBe(TO)
    expect(parsed.chainId).toBe(137n)
    expect(session.signTransaction).toHaveBeenCalledWith(PATH, expect.any(String), expect.any(Object))
  })

  it('rejects when the device signed with a different account', async () => {
    const expected = new Wallet(PK_A)
    const actualDevice = new Wallet(PK_B)
    const session = sessionFor(actualDevice)
    const signer = new HardwareSigner(session, { path: PATH, address: expected.address })

    const err = await signer.signTransaction(txRequest).catch((e) => e)
    expect(err).toBeInstanceOf(HardwareWalletError)
    expect(err.message).toMatch(/different account/)
  })

  it('rejects a request whose from field is someone else, before touching the device', async () => {
    const wallet = new Wallet(PK_A)
    const session = sessionFor(wallet)
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address })
    const other = new Wallet(PK_B)

    await expect(signer.signTransaction({ ...txRequest, from: other.address })).rejects.toThrow(
      /not from the connected hardware account/,
    )
    expect(session.signTransaction).not.toHaveBeenCalled()
  })
})

/*
 * ── THE ORACLE MATRIX (spec 110 T028) ────────────────────────────────────────────────────────
 *
 * `ethers.Transaction.from` picks the HIGHEST transaction type its fields admit, which is not the
 * rule viem applies and not the rule anyone would guess: a request carrying only `gasPrice`
 * becomes type 1 (EIP-2930 with an empty access list), and one carrying no fee fields at all
 * becomes type 2 with zero fees. Getting that wrong changes the bytes on the device screen and
 * changes what is broadcast, and nothing else in the app would notice.
 *
 * So every well-formed shape is signed through the real signer and compared BYTE FOR BYTE against
 * the same request signed by ethers with the same key. A fixture table would only prove viem
 * agrees with whatever produced the fixtures.
 */
describe('transaction serialization parity with ethers', () => {
  const AL = [{ address: TO, storageKeys: [`0x${'11'.repeat(32)}`] }]
  const shapes = [
    ['1559 explicit', { maxFeePerGas: 30n, maxPriorityFeePerGas: 2n, type: 2 }],
    ['1559 inferred', { maxFeePerGas: 30n, maxPriorityFeePerGas: 2n }],
    ['1559 with an access list', { maxFeePerGas: 30n, maxPriorityFeePerGas: 2n, accessList: AL }],
    ['legacy explicit', { gasPrice: 1_000_000_000n, type: 0 }],
    // ethers infers type 1 here, NOT legacy — an empty access list rides along.
    ['gasPrice alone', { gasPrice: 1_000_000_000n }],
    ['2930 explicit', { gasPrice: 7n, accessList: AL, type: 1 }],
    // ethers infers type 2 with zero fees; viem on its own refuses to infer at all.
    ['no fee fields at all', {}],
  ]

  // ETC 61 and Mordor 63 are the app's legacy chains (no EIP-1559) and the only ones that reach
  // viem's legacy serializer — the one that throws on a `yParity` number (DIVERGENCE 32).
  for (const chainId of [1, 61, 63, 137, 80002]) {
    for (const [label, fee] of shapes) {
      it(`serializes ${label} on chain ${chainId} exactly as ethers did`, async () => {
        const wallet = new Wallet(PK_A)
        const session = sessionFor(wallet)
        const signer = new HardwareSigner(session, { path: PATH, address: wallet.address })
        const req = { to: TO, value: 3n, chainId, nonce: 4, gasLimit: 21000n, data: '0xabcd', ...fee }

        const expected = Transaction.from({ ...req })
        const sig = wallet.signingKey.sign(expected.unsignedHash)
        expected.signature = { r: sig.r, s: sig.s, yParity: sig.yParity }

        const raw = await signer.signTransaction(req)
        expect(raw).toBe(expected.serialized)
        // And the device saw the same unsigned bytes ethers would have handed it.
        expect(session.signTransaction.mock.calls[0][1]).toBe(expected.unsignedSerialized)
        await expect(recoverTransactionAddress({ serializedTransaction: raw })).resolves.toBe(wallet.address)
      })
    }
  }

  /*
   * DIVERGENCE 32, named rather than only covered.
   *
   * viem's LEGACY serializer wants `v` as a bigint; handed ethers' `yParity` bit it throws
   * `Cannot mix BigInt and other types` from inside the library, naming neither the field nor the
   * transaction. A real Ledger signing a legacy transaction returns the EIP-155 `v` (chainId*2+35+
   * parity), so that is what the session returns here — the shape the emulator suite actually
   * produced on ETC.
   */
  it('accepts the EIP-155 v a device returns on a legacy chain', async () => {
    const wallet = new Wallet(PK_A)
    const session = {
      ...sessionFor(wallet),
      signTransaction: vi.fn(async (path, unsigned) => {
        const tx = Transaction.from(unsigned)
        const sig = wallet.signingKey.sign(tx.unsignedHash)
        return { r: sig.r, s: sig.s, v: 61 * 2 + 35 + sig.yParity }
      }),
    }
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address })
    const req = { to: TO, value: 1n, chainId: 61, nonce: 0, gasLimit: 21000n, gasPrice: 1n, type: 0 }
    const raw = await signer.signTransaction(req)
    expect(parseTransaction(raw).type).toBe('legacy')
    await expect(recoverTransactionAddress({ serializedTransaction: raw })).resolves.toBe(wallet.address)
  })

  /*
   * DIVERGENCE 31 — viem drops a field that contradicts an explicit type and serializes anyway.
   * `{ type: 0, maxFeePerGas }` came out as a legacy transaction with `gasPrice` 0: unmineable,
   * built from a request that asked for something else, with nothing raised. ethers refused both
   * of these and so does this.
   */
  it('refuses a request whose fields contradict its explicit type, before touching the device', async () => {
    const wallet = new Wallet(PK_A)
    const session = sessionFor(wallet)
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address })
    const base = { to: TO, value: 1n, chainId: 137, nonce: 0, gasLimit: 21000n }

    await expect(signer.signTransaction({ ...base, type: 0, accessList: [] })).rejects.toThrow(/accessList/)
    await expect(signer.signTransaction({ ...base, type: 0, maxFeePerGas: 1n })).rejects.toThrow(/maxFeePerGas/)
    await expect(signer.signTransaction({ ...base, type: 1, maxPriorityFeePerGas: 1n })).rejects.toThrow(/maxFeePerGas/)
    expect(session.signTransaction).not.toHaveBeenCalled()
    // ethers refused each of these too — the oracle, not this test's opinion. It refused at
    // SERIALIZATION rather than at construction; this refuses one step earlier, which is the
    // same guarantee (nothing reaches the device) stated sooner.
    expect(() => Transaction.from({ ...base, type: 0, accessList: [] }).unsignedSerialized).toThrow(/accessList/)
    expect(() => Transaction.from({ ...base, type: 0, maxFeePerGas: 1n }).unsignedSerialized).toThrow(/maxFeePerGas/)
  })

  it('reads both the ethers and viem spellings of the gas limit', () => {
    expect(transactionTypeOf({ gasPrice: 1n })).toBe('eip2930')
    expect(transactionTypeOf({ type: 'legacy', gasPrice: 1n })).toBe('legacy')
    expect(transactionTypeOf({ type: 'eip1559', maxFeePerGas: 1n })).toBe('eip1559')
    expect(transactionTypeOf({})).toBe('eip1559')
  })

  /*
   * ethers' `Signature.from` validated r and s at 32 bytes. viem instead TRIMS a short value into
   * a shorter RLP item, which the recover-and-cross-check would then report as "a different
   * account" — a true statement naming the wrong cause, on the one screen where a member needs to
   * know what actually happened.
   */
  it('refuses a signature whose r or s is not 32 bytes', async () => {
    const wallet = new Wallet(PK_A)
    const session = sessionFor(wallet)
    session.signTransaction = vi.fn(async () => ({ r: '0xabcd', s: `0x${'11'.repeat(32)}`, v: 27 }))
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address })
    await expect(signer.signTransaction(txRequest)).rejects.toThrow(/unreadable signature/)
  })
})

/*
 * `sendTransaction` — ethers' `AbstractSigner` used to supply this, populating through whatever
 * provider was attached. It is the signer's own now, on the chain it was BOUND to, and it is
 * driven here against a real viem client over a fake EIP-1193 node so the assertions read the
 * signed envelope off the wire rather than an object the test handed in.
 */
describe('sendTransaction', () => {
  function makeNode({ chainId = 137, nonce = 7, baseFee = 1_000_000_000n } = {}) {
    const sent = []
    const hex = (v) => `0x${BigInt(v).toString(16)}`
    const request = async ({ method, params }) => {
      switch (method) {
        case 'eth_chainId': return hex(chainId)
        case 'eth_blockNumber': return '0x64'
        case 'eth_getTransactionCount': return hex(nonce)
        case 'eth_gasPrice': return hex(baseFee * 2n)
        case 'eth_maxPriorityFeePerGas': return hex(1_000_000n)
        case 'eth_estimateGas': return '0x5208'
        case 'eth_getBlockByNumber': return {
          number: '0x64', hash: `0x${'aa'.repeat(32)}`, parentHash: `0x${'bb'.repeat(32)}`,
          timestamp: '0x65000000', gasLimit: '0x1c9c380', gasUsed: '0x5208',
          miner: `0x${'11'.repeat(20)}`, transactions: [], difficulty: '0x0', totalDifficulty: '0x0',
          extraData: '0x', logsBloom: `0x${'00'.repeat(256)}`, nonce: '0x0000000000000000',
          size: '0x100', stateRoot: `0x${'cc'.repeat(32)}`, receiptsRoot: `0x${'dd'.repeat(32)}`,
          transactionsRoot: `0x${'ee'.repeat(32)}`, sha3Uncles: `0x${'ff'.repeat(32)}`,
          uncles: [], mixHash: `0x${'00'.repeat(32)}`, baseFeePerGas: hex(baseFee),
        }
        case 'eth_sendRawTransaction': {
          sent.push(params[0])
          return keccak256(params[0])
        }
        default:
          throw Object.assign(new Error(`the method ${method} does not exist`), { code: -32601 })
      }
    }
    const client = createPublicClient({
      chain: { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'X', symbol: 'X', decimals: 18 }, rpcUrls: { default: { http: ['http://node'] } } },
      transport: custom({ request }, { retryCount: 0 }),
    })
    return { client, sent }
  }

  it('populates the nonce and fees from the bound chain, then broadcasts what the device signed', async () => {
    const wallet = new Wallet(PK_A)
    const session = sessionFor(wallet)
    const { client, sent } = makeNode({ chainId: 137, nonce: 7 })
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address }, { chainId: 137, client })

    const tx = await signer.sendTransaction({ to: TO, value: 5n, data: '0x' })
    expect(sent).toHaveLength(1)
    const parsed = parseTransaction(sent[0])
    expect(parsed.nonce).toBe(7)
    expect(parsed.chainId).toBe(137)
    expect(parsed.to.toLowerCase()).toBe(TO.toLowerCase())
    expect(parsed.maxFeePerGas).toBeGreaterThan(0n)
    expect(tx.hash).toBe(keccak256(sent[0]))
    await expect(recoverTransactionAddress({ serializedTransaction: sent[0] })).resolves.toBe(wallet.address)
  })

  it('passes a pinned nonce and fee schedule through untouched', async () => {
    const wallet = new Wallet(PK_A)
    const session = sessionFor(wallet)
    const { client, sent } = makeNode({ chainId: 137, nonce: 7 })
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address }, { chainId: 137, client })

    await signer.sendTransaction({ to: TO, value: 1n, nonce: 42, maxFeePerGas: 99n, maxPriorityFeePerGas: 3n, gasLimit: 30000n })
    const parsed = parseTransaction(sent[0])
    expect(parsed.nonce).toBe(42)
    expect(parsed.maxFeePerGas).toBe(99n)
    expect(parsed.gas).toBe(30000n)
  })

  it('says so instead of sending when the session is bound to no network', async () => {
    const wallet = new Wallet(PK_A)
    const signer = new HardwareSigner(sessionFor(wallet), { path: PATH, address: wallet.address })
    expect(signer.provider).toBeNull()
    await expect(signer.sendTransaction({ to: TO })).rejects.toThrow(/not bound to a network/)
  })

  // The binding used to be an ethers Provider. One passed now would leave the signer quietly
  // unable to send, so it is refused at construction with the replacement named.
  it('refuses an ethers provider in place of the binding', () => {
    const wallet = new Wallet(PK_A)
    expect(() => new HardwareSigner(sessionFor(wallet), { path: PATH, address: wallet.address }, { getNetwork: () => {} }))
      .toThrow(/\{ chainId, client \}/)
  })

  it('answers getNetwork with the chain it was bound to', async () => {
    const wallet = new Wallet(PK_A)
    const { client } = makeNode({ chainId: 61 })
    const signer = new HardwareSigner(sessionFor(wallet), { path: PATH, address: wallet.address }, { chainId: 61, client })
    await expect(signer.provider.getNetwork()).resolves.toMatchObject({ chainId: 61n })
  })
})

describe('signMessage', () => {
  it('returns the session signature verbatim, passing the path and message bytes', async () => {
    const wallet = new Wallet(PK_A)
    const session = sessionFor(wallet)
    const fixed = '0x' + 'ab'.repeat(65)
    session.signPersonalMessage.mockResolvedValue(fixed)
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address })

    await expect(signer.signMessage('hello device')).resolves.toBe(fixed)
    const [path, bytes] = session.signPersonalMessage.mock.calls[0]
    expect(path).toBe(PATH)
    expect(new TextDecoder().decode(bytes)).toBe('hello device')
  })
})

describe('signTypedData', () => {
  const domain = {
    name: 'FairWins WagerRegistry',
    version: '1',
    chainId: 137,
    verifyingContract: TO,
  }
  const types = {
    Mail: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  }
  const value = { to: TO, amount: 1n }

  it('hands the adapter the exact domainSeparator and hashStructMessage ethers computes', async () => {
    const wallet = new Wallet(PK_A)
    const session = sessionFor(wallet)
    session.signTypedData.mockResolvedValue('0xsig')
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address })

    await expect(signer.signTypedData(domain, types, value)).resolves.toBe('0xsig')
    const [path, payload] = session.signTypedData.mock.calls[0]
    expect(path).toBe(PATH)
    expect(payload.primaryType).toBe('Mail')
    expect(payload.domainSeparator).toBe(TypedDataEncoder.hashDomain(domain))
    expect(payload.hashStructMessage).toBe(TypedDataEncoder.from(types).hash(value))
    expect(payload.domain).toBe(domain)
    expect(payload.message).toBe(value)
  })

  it('tolerates an explicit EIP712Domain key in types', async () => {
    const wallet = new Wallet(PK_A)
    const session = sessionFor(wallet)
    session.signTypedData.mockResolvedValue('0xsig')
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address })

    const withDomain = {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...types,
    }
    await signer.signTypedData(domain, withDomain, value)
    const [, payload] = session.signTypedData.mock.calls[0]
    expect(payload.hashStructMessage).toBe(TypedDataEncoder.from(types).hash(value))
  })

  it('fails with a stated outcome when the session cannot sign typed data', async () => {
    const wallet = new Wallet(PK_A)
    const session = sessionFor(wallet)
    delete session.signTypedData
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address })
    await expect(signer.signTypedData(domain, types, value)).rejects.toThrow(HardwareWalletError)
  })
})

describe('signer identity', () => {
  it('getAddress returns the checksummed account and connect() keeps it', async () => {
    const wallet = new Wallet(PK_A)
    const session = sessionFor(wallet)
    const signer = new HardwareSigner(session, { path: PATH, address: wallet.address.toLowerCase() })
    await expect(signer.getAddress()).resolves.toBe(getAddress(wallet.address))
    const connected = signer.connect(null)
    expect(connected).toBeInstanceOf(HardwareSigner)
    await expect(connected.getAddress()).resolves.toBe(getAddress(wallet.address))
  })
})
