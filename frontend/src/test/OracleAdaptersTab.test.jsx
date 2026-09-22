/**
 * OracleAdaptersTab tests.
 *
 * Spec 071 US4 rewired this tab: adapter addresses no longer come from the build's single
 * `contracts` record but from `getContractAddressForChain(key, scopeChainId)`, where the scope is
 * a network the OPERATOR picks (seeded from the wallet's chain), and every WRITE is gated on the
 * wallet actually being on that scoped chain. This suite was written before that and handed the
 * tab a `contracts` prop with no `chainId`, so the scope seeded to the first cohort network, the
 * addresses resolved empty, and every adapter read as "not deployed" — which is why the owner
 * banner and all four write assertions failed.
 *
 * The behaviours asserted here are unchanged; what changed is the setup needed to reach them:
 * a `chainId` the wallet is on, and a per-chain address book. The scope rules themselves are
 * asserted at the bottom, because "the adapter is not deployed here" and "your wallet is on
 * another network" are the two ways an operator's write is now legitimately withheld, and both
 * must say so rather than fail silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { ethers as realEthers } from 'ethers'
import { NETWORKS, cohortChainIds } from '../config/networks'
import OracleAdaptersTab from '../components/admin/OracleAdaptersTab'

// Mock ethers so the component never makes real RPC calls. We intercept
// `new ethers.Contract(addr, abi, signerOrProvider).<fn>(...)` by returning
// stub instances with the methods the tab calls.

const { dataFeedStub, functionsStub, umaStub } = vi.hoisted(() => {
  const txReceipt = { wait: vi.fn().mockResolvedValue({ status: 1 }) }
  return {
    dataFeedStub: {
      owner: vi.fn().mockResolvedValue('0x52502d049571C7893447b86c4d8B38e6184bF6e1'),
      setFeedAllowed: vi.fn().mockResolvedValue(txReceipt),
      registerCondition: vi.fn().mockResolvedValue(txReceipt),
      linkMarket: vi.fn().mockResolvedValue(txReceipt),
    },
    functionsStub: {
      owner: vi.fn().mockResolvedValue('0x52502d049571C7893447b86c4d8B38e6184bF6e1'),
      registerCondition: vi.fn().mockResolvedValue(txReceipt),
      linkMarket: vi.fn().mockResolvedValue(txReceipt),
    },
    umaStub: {
      owner: vi.fn().mockResolvedValue('0x52502d049571C7893447b86c4d8B38e6184bF6e1'),
      registerCondition: vi.fn().mockResolvedValue(txReceipt),
      linkMarket: vi.fn().mockResolvedValue(txReceipt),
    },
  }
})

/** address → stub, shared by the read mock and the decoding signer below. */
const ADDRESS_STUBS = {
  '0x7ae8220Dc02D0504EDCBa2C1B1AbA579AA3F0f23': dataFeedStub,
  '0x074fC18C1E322a7537b53B8B2Bf0762629E3b532': functionsStub,
  '0xcEa9b4A01CcD3aA6545ea834a268C69e7eEfee88': umaStub,
}

const ADAPTER_ADDRESSES = {
  chainlinkDataFeedAdapter: '0x7ae8220Dc02D0504EDCBa2C1B1AbA579AA3F0f23',
  chainlinkFunctionsAdapter: '0x074fC18C1E322a7537b53B8B2Bf0762629E3b532',
  umaAdapter: '0xcEa9b4A01CcD3aA6545ea834a268C69e7eEfee88',
}

/**
 * Reads and writes through the chain seam (spec 110), routed BY ADDRESS exactly as the
 * `new ethers.Contract(addr, …)` fake this replaces was — that routing is what makes "the UMA form
 * wrote to the UMA adapter" assertable, and it is the half most fakes drop.
 *
 * Writes are calldata now, so the signer DECODES them with ethers against the same ABI and
 * dispatches to the same stub method. Every `expect(umaStub.registerCondition).toHaveBeenCalled…`
 * below reads unchanged — and is now backed by the actual bytes rather than by an argument list a
 * fake was handed.
 */
vi.mock('../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: (_chainId, { address, functionName, args = [] }) => {
      const stub = ADDRESS_STUBS[address]
      if (!stub || !stub[functionName]) return Promise.resolve(undefined)
      return stub[functionName](...args)
    },
  }
})

// The address book is per chain now, so the tests decide which networks carry adapters.
// Read lazily inside the mocked function (not in the factory body) so the module can be
// mocked before this file's own bindings initialise.
let adaptersDeployedOn = new Set()
vi.mock('../config/contracts', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getContractAddressForChain: (key, chainId) =>
      adaptersDeployedOn.has(Number(chainId)) ? (ADAPTER_ADDRESSES[key] || '') : '',
  }
})

// Reading a network the wallet is not on goes through the member's configured endpoint. The
// contract instances are stubbed by address above, so the provider only has to be non-null.
vi.mock('../lib/chains/estate', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, readProviderFor: () => ({ _fake: 'read provider' }) }
})

const adminAccount = '0x52502d049571C7893447b86c4d8B38e6184bF6e1'

// Spec 071: the tab scopes to a network the operator picks, seeded from the wallet's chain when
// that chain is in this build's cohort. HOME is where the wallet sits and adapters are deployed;
// AWAY has adapters but no wallet; BARE has neither.
const COHORT = cohortChainIds()
const HOME = COHORT[0]
const AWAY = COHORT[1]
const BARE = COHORT[2]
const nameOf = (chainId) => NETWORKS[chainId].name

/**
 * The write rail. `encodeFunctionData` + `sendTransaction` (spec 110), decoded back here with
 * ethers against the same fragments and dispatched to the stub registered for the `to` address —
 * so the assertions keep their shape and gain the bytes.
 */
const WRITE_FRAGMENTS = [
  'function setFeedAllowed(address feed, bool allowed)',
  'function registerCondition(bytes32 conditionId, address feed, int256 threshold, uint8 op, uint64 deadline)',
  'function registerCondition(bytes32 conditionId, bytes encodedRequest, bytes32 sourceHash, uint64 subscriptionId, uint32 gasLimit, bytes32 donId)',
  'function registerCondition(bytes32 conditionId, bytes claim, address bondCurrency, uint256 bondAmount, uint64 liveness)',
  'function linkMarket(uint256 friendMarketId, bytes32 conditionId)',
]

const writeSigner = {
  provider: {},
  sendTransaction: async ({ to, data }) => {
    const parsed = new realEthers.Interface(WRITE_FRAGMENTS).parseTransaction({ data })
    const stub = ADDRESS_STUBS[to]
    if (!stub || !stub[parsed.name]) throw new Error(`unexpected write ${parsed.name} to ${to}`)
    return stub[parsed.name](...Array.from(parsed.args))
  },
}

const defaultProps = {
  signer: writeSigner,
  account: adminAccount,
  // The build's synced record — only ever consulted for the wallet's own chain, where it agrees
  // with the per-chain address book by construction.
  contracts: { ...ADAPTER_ADDRESSES },
  chainId: HOME,
  runTx: vi.fn((fn) => fn()),
  pendingTx: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  adaptersDeployedOn = new Set([HOME, AWAY])
  // Suppress jsdom alert() bubbles in the validation tests.
  vi.spyOn(window, 'alert').mockImplementation(() => {})
})

describe('OracleAdaptersTab', () => {
  it('renders the three adapter sub-tabs', async () => {
    render(<OracleAdaptersTab {...defaultProps} />)
    expect(screen.getByRole('tab', { name: /chainlink data feed/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /chainlink functions/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /uma optimistic oracle/i })).toBeInTheDocument()
    // Let the async owner read land inside the test rather than after it (act warning).
    await screen.findByText(/\(you\)/i)
  })

  it('shows the owner banner with "(you)" when account === adapter.owner()', async () => {
    render(<OracleAdaptersTab {...defaultProps} />)
    await waitFor(() => {
      // Owner read populates async; once it resolves the (you) hint appears.
      expect(screen.getByText(/\(you\)/i)).toBeInTheDocument()
    })
  })

  it('warns when the connected account is NOT the adapter owner', async () => {
    dataFeedStub.owner.mockResolvedValueOnce('0x9999999999999999999999999999999999999999')
    render(
      <OracleAdaptersTab
        {...defaultProps}
        account="0x1111111111111111111111111111111111111111"
      />
    )
    await waitFor(() => {
      expect(screen.getByText(/NOT you/i)).toBeInTheDocument()
    })
  })

  it('says an owner it could not read is unread — never "no owner"', async () => {
    dataFeedStub.owner.mockRejectedValueOnce(new Error('rpc down'))
    render(<OracleAdaptersTab {...defaultProps} />)
    await waitFor(() => {
      expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    })
  })

  it('Chainlink Data Feed: setFeedAllowed validates input + calls the adapter', async () => {
    render(<OracleAdaptersTab {...defaultProps} />)

    // Empty form → alert, no tx
    await userEvent.click(screen.getByRole('button', { name: /setFeedAllowed/i }))
    expect(dataFeedStub.setFeedAllowed).not.toHaveBeenCalled()

    // Valid feed → calls the contract
    const feedInput = screen.getByPlaceholderText(/Chainlink AggregatorV3/i)
    await userEvent.type(feedInput, '0xF0d50568e3A7e8259E16663972b11910F89BD8e7')
    await userEvent.click(screen.getByRole('button', { name: /setFeedAllowed/i }))

    expect(defaultProps.runTx).toHaveBeenCalled()
    expect(dataFeedStub.setFeedAllowed).toHaveBeenCalledWith(
      '0xF0d50568e3A7e8259E16663972b11910F89BD8e7',
      true
    )
  })

  it('Chainlink Data Feed: registerCondition forwards the full arg tuple', async () => {
    render(<OracleAdaptersTab {...defaultProps} />)

    const cidInput     = screen.getAllByPlaceholderText(/0x \+ 64 hex chars/i)[0]
    const feedInput    = screen.getAllByPlaceholderText(/must be allowlisted/i)[0]
    const thresholdIn  = screen.getAllByPlaceholderText(/8-dec/i)[0]
    const deadlineIn   = document.querySelector('input[type="datetime-local"]')

    const futureDate = new Date(Date.now() + 7 * 24 * 3600 * 1000)
    const isoLocal = futureDate.toISOString().slice(0, 16)

    await userEvent.type(cidInput, '0x' + 'a'.repeat(64))
    await userEvent.type(feedInput, '0xF0d50568e3A7e8259E16663972b11910F89BD8e7')
    await userEvent.type(thresholdIn, '300000000000')
    fireEvent.change(deadlineIn, { target: { value: isoLocal } })

    await userEvent.click(screen.getByRole('button', { name: /^registerCondition$/i }))

    expect(dataFeedStub.registerCondition).toHaveBeenCalledTimes(1)
    const [conditionId, feed, threshold, op, deadline] = dataFeedStub.registerCondition.mock.calls[0]
    expect(conditionId).toBe('0x' + 'a'.repeat(64))
    expect(feed).toBe('0xF0d50568e3A7e8259E16663972b11910F89BD8e7')
    expect(threshold).toBe(300000000000n)  // BigInt
    // `0n`, not `0`: these are DECODED FROM CALLDATA now, and ethers decodes `uint8` as a bigint.
    // The component still passes a number and viem encodes it identically — what changed is that
    // the assertion reads the transaction rather than the call site.
    expect(op).toBe(0n)  // default = GT
    expect(typeof deadline).toBe('bigint')
    expect(Number(deadline)).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('Chainlink Data Feed: linkMarket validates ids and bytes32', async () => {
    render(<OracleAdaptersTab {...defaultProps} />)

    // The third "0x + 64 hex chars" placeholder belongs to the linkMarket form.
    const linkCidInput = screen.getAllByPlaceholderText(/0x \+ 64 hex chars/i)[1]
    const wagerIdInputs = screen.getAllByRole('spinbutton')  // type=number inputs
    const wagerIdInput = wagerIdInputs[wagerIdInputs.length - 1]

    await userEvent.type(wagerIdInput, '42')
    await userEvent.type(linkCidInput, '0x' + 'b'.repeat(64))
    await userEvent.click(screen.getByRole('button', { name: /^linkMarket$/i }))

    expect(dataFeedStub.linkMarket).toHaveBeenCalledTimes(1)
    expect(dataFeedStub.linkMarket).toHaveBeenCalledWith(42n, '0x' + 'b'.repeat(64))
  })

  it('UMA: registerCondition converts the claim text to UTF-8 bytes', async () => {
    render(<OracleAdaptersTab {...defaultProps} />)

    // Switch to UMA sub-tab.
    await userEvent.click(screen.getByRole('tab', { name: /uma optimistic oracle/i }))

    // The register-condition form is the first "0x + 64 hex chars" cid input.
    const cidInput = screen.getAllByPlaceholderText(/0x \+ 64 hex chars/i)[0]
    const bondAddrInput = screen.getByPlaceholderText(/0x.*e\.g\. USDC/i)
    const claimArea = screen.getByPlaceholderText(/Plain-English claim/i)
    const numberInputs = screen.getAllByRole('spinbutton')
    const [bondAmtInput, livenessInput] = numberInputs

    await userEvent.type(cidInput, '0x' + 'c'.repeat(64))
    await userEvent.type(bondAddrInput, '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582')
    await userEvent.type(bondAmtInput, '5000000')   // 5 USDC (6-dec raw)
    await userEvent.clear(livenessInput)
    await userEvent.type(livenessInput, '7200')
    await userEvent.type(claimArea, 'ETH closes above 3000 on 2026-12-31')

    await userEvent.click(screen.getByRole('button', { name: /^registerCondition$/i }))

    expect(umaStub.registerCondition).toHaveBeenCalledTimes(1)
    const [conditionId, claimBytes, bondCurrency, bondAmount, liveness] =
      umaStub.registerCondition.mock.calls[0]
    expect(conditionId).toBe('0x' + 'c'.repeat(64))
    // ── DIVERGENCE 19, VISIBLE HERE ───────────────────────────────────────────────────────────
    // The claim used to be asserted as a `Uint8Array`, because that is what `ethers.toUtf8Bytes`
    // returns and the fake recorded the value it was handed. viem's encoder REFUSES a Uint8Array
    // for a `bytes` parameter — it wants hex — so the component now passes `stringToHex(...)`, and
    // what the transaction carries (and what decodes back out) is a hex string. The BYTES are
    // identical either way; only the JS type at the boundary differs.
    expect(claimBytes).toBe(realEthers.hexlify(realEthers.toUtf8Bytes('ETH closes above 3000 on 2026-12-31')))
    expect(realEthers.toUtf8String(claimBytes)).toBe('ETH closes above 3000 on 2026-12-31')
    expect(bondCurrency).toBe('0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582')
    expect(bondAmount).toBe(5000000n)
    expect(liveness).toBe(7200n)
  })

  it('Chainlink Functions: registerCondition forwards CBOR + numeric args', async () => {
    render(<OracleAdaptersTab {...defaultProps} />)
    await userEvent.click(screen.getByRole('tab', { name: /chainlink functions/i }))

    const cidInput        = screen.getAllByPlaceholderText(/0x \+ 64 hex chars/i)[0]
    const sourceHashInput = screen.getAllByPlaceholderText(/keccak256 of JS source/i)[0]
    const donIdInput      = screen.getAllByPlaceholderText(/0x66756e/i)[0]
    const encodedInput    = screen.getByPlaceholderText(/CBOR-encoded Functions request/i)
    const numberInputs    = screen.getAllByRole('spinbutton')

    const subscriptionInput = numberInputs[0]
    const gasLimitInput     = numberInputs[1]

    await userEvent.type(cidInput, '0x' + 'd'.repeat(64))
    await userEvent.type(sourceHashInput, '0x' + 'e'.repeat(64))
    await userEvent.type(donIdInput,
      '0x66756e2d706f6c79676f6e2d616d6f792d310000000000000000000000000000')
    await userEvent.type(subscriptionInput, '42')
    await userEvent.clear(gasLimitInput)
    await userEvent.type(gasLimitInput, '300000')
    await userEvent.clear(encodedInput)
    await userEvent.type(encodedInput, '0xdeadbeef')

    await userEvent.click(screen.getByRole('button', { name: /^registerCondition$/i }))

    expect(functionsStub.registerCondition).toHaveBeenCalledTimes(1)
    const [conditionId, encodedRequest, sourceHash, subscriptionId, gasLimit, donId] =
      functionsStub.registerCondition.mock.calls[0]
    expect(conditionId).toBe('0x' + 'd'.repeat(64))
    expect(encodedRequest).toBe('0xdeadbeef')
    expect(sourceHash).toBe('0x' + 'e'.repeat(64))
    expect(subscriptionId).toBe(42n)
    expect(gasLimit).toBe(300000n)  // decoded `uint32` — see the note on `op` above
    expect(donId).toBe('0x66756e2d706f6c79676f6e2d616d6f792d310000000000000000000000000000')
  })

  it('disables all submit buttons when pendingTx is true', async () => {
    render(<OracleAdaptersTab {...defaultProps} pendingTx />)
    const buttons = screen.getAllByRole('button').filter(b => /setFeedAllowed|registerCondition|linkMarket/.test(b.textContent))
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) expect(b).toBeDisabled()
    // Let the async owner read land inside the test rather than after it (act warning).
    await screen.findByText(/\(you\)/i)
  })

  // ── Spec 071 US4: the two ways a write is legitimately withheld, both stated in words ──────
  describe('network scope', () => {
    it('states "not deployed" on a network with no adapters, and refuses the write', async () => {
      // No adapters there, and no synced record either — the build record only ever carries the
      // wallet's own chain, which here is the bare one.
      render(<OracleAdaptersTab {...defaultProps} chainId={BARE} contracts={{}} />)

      expect(await screen.findByText(new RegExp(`Not deployed on ${nameOf(BARE)}`, 'i')))
        .toBeInTheDocument()

      await userEvent.type(
        screen.getByPlaceholderText(/Chainlink AggregatorV3/i),
        '0xF0d50568e3A7e8259E16663972b11910F89BD8e7',
      )
      await userEvent.click(screen.getByRole('button', { name: /setFeedAllowed/i }))

      expect(defaultProps.runTx).not.toHaveBeenCalled()
      expect(dataFeedStub.setFeedAllowed).not.toHaveBeenCalled()
      expect(window.alert).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`not deployed on ${nameOf(BARE)}`, 'i')),
      )
    })

    it('refuses a write for a network the wallet is not on, naming the one to switch to', async () => {
      render(<OracleAdaptersTab {...defaultProps} />)

      // Scope away from the wallet's chain. Reading AWAY is fine; signing for it is not.
      fireEvent.change(screen.getByRole('combobox', { name: /^Network/i }), {
        target: { value: String(AWAY) },
      })
      expect(await screen.findByText(
        new RegExp(`reading ${nameOf(AWAY)} while your wallet is on ${nameOf(HOME)}`, 'i'),
      )).toBeInTheDocument()

      await userEvent.type(
        screen.getByPlaceholderText(/Chainlink AggregatorV3/i),
        '0xF0d50568e3A7e8259E16663972b11910F89BD8e7',
      )
      await userEvent.click(screen.getByRole('button', { name: /setFeedAllowed/i }))

      expect(defaultProps.runTx).not.toHaveBeenCalled()
      expect(dataFeedStub.setFeedAllowed).not.toHaveBeenCalled()
      expect(window.alert).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`switch your wallet to ${nameOf(AWAY)}`, 'i')),
      )
    })
  })
})
