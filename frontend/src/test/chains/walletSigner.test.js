/**
 * The ethers-shaped signer on viem, checked against the REAL ethers signer it replaces
 * (spec 110 T028).
 *
 * Both are driven over the SAME fake EIP-1193 transport, and the assertions are about what each
 * one puts ON THE WIRE — the RPC method names, in order, and the fields of the
 * `eth_sendTransaction` payload. That is the only comparison that can see divergence 25: a test
 * that checked the returned hash would pass with the gas estimate deleted, because the fake
 * returns the same hash either way.
 *
 * ethers is imported here UNMOCKED, on purpose. It is the oracle, and a test that replaced it
 * with a viem-built expectation would be asserting that viem agrees with itself.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ethers } from 'ethers'
import { createWalletClient, createPublicClient, custom, parseEther } from 'viem'
import { walletSigner } from '../../lib/chains/walletSigner'

const ACCOUNT = '0x00c3ef4e02Ef00Ad6eE955dF5022A22F6ea73dae'
const TO = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const DATA = '0xa9059cbb' + '00'.repeat(60)
const TX_HASH = '0x' + 'ab'.repeat(32)
const CHAIN = { id: 137, name: 'Polygon', nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:0'] } } }

/** An EIP-1193 provider that records every request and answers from a canned table. */
function fakeTransport(overrides = {}) {
  const seen = []
  const answers = {
    eth_chainId: '0x89',
    eth_accounts: [ACCOUNT],
    eth_requestAccounts: [ACCOUNT],
    eth_blockNumber: '0x4000000',
    eth_estimateGas: '0x5208',
    eth_sendTransaction: TX_HASH,
    eth_getTransactionByHash: {
      hash: TX_HASH, blockHash: null, blockNumber: null, from: ACCOUNT, to: TO, value: '0x0',
      gas: '0x5208', gasPrice: '0x1', nonce: '0x1', input: DATA, type: '0x0', chainId: '0x89',
      r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32), v: '0x1b',
    },
    eth_getTransactionReceipt: {
      transactionHash: TX_HASH, transactionIndex: '0x0', blockHash: '0x' + 'cd'.repeat(32),
      blockNumber: '0x4000001', from: ACCOUNT, to: TO, cumulativeGasUsed: '0x5208',
      gasUsed: '0x5208', contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256),
      status: '0x1', type: '0x0', effectiveGasPrice: '0x1',
    },
    personal_sign: '0x' + 'aa'.repeat(65),
    eth_signTypedData_v4: '0x' + 'bb'.repeat(65),
    ...overrides,
  }
  return {
    seen,
    request: async ({ method, params }) => {
      seen.push({ method, params })
      if (!(method in answers)) throw new Error(`unexpected RPC: ${method}`)
      const answer = answers[method]
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

const methodsOf = (transport) => transport.seen.map((r) => r.method)
const paramsFor = (transport, method) => transport.seen.find((r) => r.method === method)?.params?.[0]

function makeAdapter(transport) {
  const walletClient = createWalletClient({ account: ACCOUNT, chain: CHAIN, transport: custom(transport) })
  const publicClient = createPublicClient({ chain: CHAIN, transport: custom(transport) })
  return walletSigner({ walletClient, publicClient, address: ACCOUNT })
}

function makeEthersSigner(transport) {
  const provider = new ethers.BrowserProvider(transport, { chainId: 137, name: 'Polygon' })
  return new ethers.JsonRpcSigner(provider, ACCOUNT)
}

describe('walletSigner — the same wire behaviour as the ethers signer it replaces', () => {
  let ours, theirs
  beforeEach(() => {
    ours = fakeTransport()
    theirs = fakeTransport()
  })

  it('estimates gas when none was given, and sends WITH a gas field — divergence 25', async () => {
    await makeEthersSigner(theirs).sendTransaction({ to: TO, data: DATA })
    const adapterTx = await makeAdapter(ours).sendTransaction({ to: TO, data: DATA })

    // Both estimate, and both carry the result into the send. viem would do NEITHER on its own.
    expect(methodsOf(theirs)).toContain('eth_estimateGas')
    expect(methodsOf(ours)).toContain('eth_estimateGas')
    expect(methodsOf(ours).indexOf('eth_estimateGas')).toBeLessThan(
      methodsOf(ours).indexOf('eth_sendTransaction'),
    )

    const sentByEthers = paramsFor(theirs, 'eth_sendTransaction')
    const sentByUs = paramsFor(ours, 'eth_sendTransaction')
    expect(sentByEthers.gas).toBe('0x5208')
    expect(sentByUs.gas).toBe('0x5208')
    expect(sentByUs.to.toLowerCase()).toBe(sentByEthers.to.toLowerCase())
    expect(sentByUs.from.toLowerCase()).toBe(sentByEthers.from.toLowerCase())
    expect(sentByUs.data).toBe(sentByEthers.data)
    expect(adapterTx.hash).toBe(TX_HASH)
  })

  it('a doomed transaction fails BEFORE the wallet prompt, exactly as it does today', async () => {
    const revert = new Error('execution reverted: ERC20: transfer amount exceeds balance')
    const theirsT = fakeTransport({ eth_estimateGas: revert })
    const oursT = fakeTransport({ eth_estimateGas: revert })

    await expect(makeEthersSigner(theirsT).sendTransaction({ to: TO, data: DATA })).rejects.toThrow()
    await expect(makeAdapter(oursT).sendTransaction({ to: TO, data: DATA })).rejects.toThrow()

    // The point: neither ever asked the wallet to sign. Dropping the estimate would move this
    // failure to AFTER the member approved and paid.
    expect(methodsOf(theirsT)).not.toContain('eth_sendTransaction')
    expect(methodsOf(oursT)).not.toContain('eth_sendTransaction')
  })

  it('an explicit gasLimit is passed through and nothing is estimated', async () => {
    await makeEthersSigner(theirs).sendTransaction({ to: TO, data: DATA, gasLimit: 123456n })
    await makeAdapter(ours).sendTransaction({ to: TO, data: DATA, gasLimit: 123456n })

    expect(methodsOf(theirs)).not.toContain('eth_estimateGas')
    expect(methodsOf(ours)).not.toContain('eth_estimateGas')
    expect(paramsFor(ours, 'eth_sendTransaction').gas).toBe(paramsFor(theirs, 'eth_sendTransaction').gas)
  })

  it('carries value, and sends the same hex for it', async () => {
    await makeEthersSigner(theirs).sendTransaction({ to: TO, value: parseEther('1.5') })
    await makeAdapter(ours).sendTransaction({ to: TO, value: parseEther('1.5') })
    expect(paramsFor(ours, 'eth_sendTransaction').value).toBe(paramsFor(theirs, 'eth_sendTransaction').value)
  })

  /*
   * DIVERGENCE 27 — a STALE signer must be identifiable as stale, and must not send.
   *
   * `settleWalletOn` (lib/chains/submitOn.js) waits for a signer whose OWN provider reports the
   * target chain, because "the wallet switched" and "this signer belongs to the new chain" are
   * different facts. ethers' fixed-network BrowserProvider made the first answer possible; an
   * adapter that asks the wallet live makes a pre-switch signer look settled, the loop hands it
   * back, and the send is refused — which is how the on-chain tier's `45-wrap-cross-chain`
   * WXC-01 failed with no success notice.
   */
  describe('a signer built for one chain, after the wallet moved to another', () => {
    const movedTransport = () => fakeTransport({ eth_chainId: '0x2105' }) // wallet now on 8453

    /** What `signerIsOn` computes: the target chain, or "no answer" (its catch keeps waiting). */
    const reportedChain = async (signer) => {
      try {
        return Number((await signer.provider.getNetwork())?.chainId)
      } catch {
        return null // signerIsOn's catch — "still bound to the old chain", keep waiting
      }
    }

    it('never reports the chain the wallet moved to — so settleWalletOn keeps waiting', async () => {
      // The invariant, not either library's spelling of it. ethers REJECTS here
      // (`network changed: 137 => 8453`, from the fixed network WalletContext gave it) and this
      // adapter ANSWERS 137; `signerIsOn` turns both into "not settled", which is the whole job.
      expect(await reportedChain(makeAdapter(movedTransport()))).toBe(137)
      expect(await reportedChain(makeEthersSigner(movedTransport()))).toBeNull()

      expect(await reportedChain(makeAdapter(movedTransport()))).not.toBe(8453)
      expect(await reportedChain(makeEthersSigner(movedTransport()))).not.toBe(8453)
    })

    it('and on its OWN chain it reports it, so a settled signer is accepted', async () => {
      expect(await reportedChain(makeAdapter(fakeTransport()))).toBe(137)
      expect(await reportedChain(makeEthersSigner(fakeTransport()))).toBe(137)
    })

    it('refuses to send, as ethers refused — neither signs on a chain it was not built for', async () => {
      await expect(
        makeAdapter(movedTransport()).sendTransaction({ to: TO, data: DATA }),
      ).rejects.toThrow(/chain/i)
      await expect(
        makeEthersSigner(movedTransport()).sendTransaction({ to: TO, data: DATA }),
      ).rejects.toThrow(/network changed/i)
    })
  })

  it('`wait()` returns a receipt shaped as ethers shaped it — status 1, not "success"', async () => {
    const tx = await makeAdapter(ours).sendTransaction({ to: TO, data: DATA })
    const receipt = await tx.wait()

    const theirReceipt = await (await makeEthersSigner(theirs).sendTransaction({ to: TO, data: DATA })).wait()

    expect(receipt.status).toBe(1)
    expect(receipt.status).toBe(theirReceipt.status)
    expect(receipt.hash).toBe(theirReceipt.hash)
    expect(Number(receipt.blockNumber)).toBe(Number(theirReceipt.blockNumber))
    expect(receipt.gasUsed).toBe(theirReceipt.gasUsed)
    // A reverted receipt is 0, not the string viem reports.
    expect(typeof receipt.status).toBe('number')
  })

  it('a reverted receipt reports 0, the way every caller tests it', async () => {
    const t = fakeTransport({
      eth_getTransactionReceipt: {
        transactionHash: TX_HASH, transactionIndex: '0x0', blockHash: '0x' + 'cd'.repeat(32),
        blockNumber: '0x4000001', from: ACCOUNT, to: TO, cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208', contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256),
        status: '0x0', type: '0x0', effectiveGasPrice: '0x1',
      },
    })
    const tx = await makeAdapter(t).sendTransaction({ to: TO, data: DATA })
    await expect(tx.wait()).resolves.toMatchObject({ status: 0 })
  })

  it('signs a message as UTF-8 bytes, the same request ethers makes', async () => {
    await makeEthersSigner(theirs).signMessage('hello wager')
    await makeAdapter(ours).signMessage('hello wager')

    const theirCall = theirs.seen.find((r) => r.method === 'personal_sign')
    const ourCall = ours.seen.find((r) => r.method === 'personal_sign')
    expect(ourCall.params[0]).toBe(theirCall.params[0])
    expect(ourCall.params[1].toLowerCase()).toBe(theirCall.params[1].toLowerCase())
  })

  it('signs typed data with the INFERRED primary type, byte-identically', async () => {
    const domain = { name: 'FairWins WagerRegistry', version: '1', chainId: 137, verifyingContract: TO }
    const types = {
      Person: [{ name: 'wallet', type: 'address' }],
      AcceptWager: [
        { name: 'actor', type: 'Person' },
        { name: 'wagerId', type: 'uint256' },
      ],
    }
    const value = { actor: { wallet: ACCOUNT }, wagerId: 42n }

    await makeEthersSigner(theirs).signTypedData(domain, types, value)
    await makeAdapter(ours).signTypedData(domain, types, value)

    const theirPayload = JSON.parse(theirs.seen.find((r) => r.method === 'eth_signTypedData_v4').params[1])
    const ourPayload = JSON.parse(ours.seen.find((r) => r.method === 'eth_signTypedData_v4').params[1])

    // `AcceptWager`, not `Person` — the sub-type is declared FIRST, so `Object.keys(types)[0]`
    // would have signed a valid signature over the wrong structure.
    expect(ourPayload.primaryType).toBe('AcceptWager')
    expect(ourPayload.primaryType).toBe(theirPayload.primaryType)

    /*
     * DIVERGENCE 26 — the two libraries put DIFFERENT JSON on the wire for the same signature,
     * in two places, and this test is where that was found:
     *
     *   field                  ethers                viem
     *   domain.chainId         "0x89" (hex string)   137 (JSON number)
     *   an address in message  lower-cased           checksum case preserved
     *
     * Nothing in the app chooses either; it is each library's own serialisation for
     * `eth_signTypedData_v4`. Neither is forced to match the other, and the reason is the
     * assertion below rather than an argument: the WALLET computes the digest, and both
     * spellings denote the same uint256 and the same 20 address bytes — so the EIP-712 hash,
     * the thing actually signed, is IDENTICAL. That is proven here with ethers' own encoder,
     * over each payload exactly as it went out, so the claim is checkable rather than asserted.
     *
     * What cannot be proven offline is that a given wallet parses a JSON number the way it
     * parses a hex string. Every wallet does — viem's entire user base signs this way — and the
     * alternative is hand-rolling the `eth_signTypedData_v4` request to imitate ethers' spelling,
     * which would trade a difference that provably does not change the digest for the loss of
     * viem's own validation of the request. Recorded rather than papered over.
     */
    expect(ourPayload.domain.chainId).toBe(137)
    expect(theirPayload.domain.chainId).toBe('0x89')
    expect(ourPayload.message.actor.wallet).not.toBe(theirPayload.message.actor.wallet)

    expect(ethers.TypedDataEncoder.hash(ourPayload.domain, types, ourPayload.message)).toBe(
      ethers.TypedDataEncoder.hash(theirPayload.domain, types, theirPayload.message),
    )
  })

  it('the provider surface answers what the app asks of it', async () => {
    const signer = makeAdapter(ours)
    await expect(signer.getAddress()).resolves.toBe(ACCOUNT)
    await expect(signer.provider.getNetwork()).resolves.toMatchObject({ chainId: 137n })
    await expect(signer.provider.getBlockNumber()).resolves.toBe(0x4000000)
    await expect(signer.provider.getTransactionReceipt(TX_HASH)).resolves.toMatchObject({ status: 1 })
  })

  it('refuses to exist without its parts, rather than half-working', () => {
    expect(walletSigner({ walletClient: null, publicClient: {}, address: ACCOUNT })).toBeNull()
    expect(walletSigner({ walletClient: {}, publicClient: null, address: ACCOUNT })).toBeNull()
    expect(walletSigner({ walletClient: {}, publicClient: {}, address: null })).toBeNull()
  })
})
