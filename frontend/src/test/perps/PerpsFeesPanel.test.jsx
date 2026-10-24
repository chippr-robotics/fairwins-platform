/**
 * PerpsFeesPanel tests (spec 083 US5, T060).
 *
 * US5's acceptance criteria are about HONESTY more than about rendering:
 *
 *   AC1  each rail shows its live rate, its venue-enforced ceiling, and names the contract that is
 *        the authority for it — the GMX rate from GMX's OWN DataStore, never from the FeeRouter.
 *   AC2  a rate above the venue ceiling is refused, and the ceiling is stated. It is never
 *        silently clamped down to the ceiling, which would charge a rate nobody typed.
 *   AC3  a rate of zero shows no fee line to members and behaves as a fee-free integration.
 *
 * Plus the two rules that make this screen dangerous rather than merely administrative:
 *
 *   • `setUiFeeFactor` credits `msg.sender`, so a signature from any wallet other than the
 *     configured receiver configures a rate for THAT wallet. The control is not offered.
 *   • Gains has no FairWins-settable rate, so it gets no field — a control that silently does
 *     nothing is worse than no control.
 *
 * And spec 071's three honest read states: an unreachable chain must never render as a zero.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ethers } from 'ethers'

import { GMX_ADDRESSES_BY_CHAIN } from '../../config/perps'
import { MAINNET_CHAIN_ID } from '../../config/networks'
import { GMX_MAX_UI_FEE_FACTOR_KEY, gmxUiFeeFactorKey } from '../../lib/perps/feeUnits'

const GMX_CHAIN = 42161
const GMX = GMX_ADDRESSES_BY_CHAIN[GMX_CHAIN]
const RECEIVER = '0x52502d049571C7893447b86c4d8B38e6184bF6e1'
const OTHER_WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const FEE_ROUTER = '0x00000000000000000000000000000000000000f1'

const m = vi.hoisted(() => ({
  // config/perps switches
  cohortMainnet: true,
  manageFlag: false,
  receiver: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
  // contract behaviour
  provider: { isReadProvider: true },
  feeRouterAddr: null,
  getUint: null,
  getService: null,
  // observations
  dataStoreKeys: [],
  serviceIds: [],
  readCalls: [],
  writes: [],
  txCalls: 0,
}))

vi.mock('../../config/perps', async (orig) => {
  const real = await orig()
  return {
    ...real,
    perpsCohortSupported: () => m.cohortMainnet,
    perpsManageFeatureEnabled: () => m.manageFlag,
    perpsUiFeeReceiver: () => m.receiver,
  }
})

vi.mock('../../config/contracts', async (orig) => {
  const real = await orig()
  return { ...real, getContractAddressForChain: (name) => (name === 'feeRouter' ? m.feeRouterAddr : null) }
})

/**
 * Reads resolve through the app's read providers, never a hand-built one (spec 069) — asserted at
 * the source level below, and stubbed here.
 *
 * `readProviderFor` is cohort-bounded, and the vitest build's cohort is the TESTNET one, so the
 * real helper refuses Arbitrum and Polygon outright. That is correct behaviour on a testnet build
 * (the panel says so and renders no rail), and it is not what these tests are about: they exercise
 * the mainnet-cohort panel, which is the only cohort where either rail exists.
 */
vi.mock('../../lib/chains/estate', async (orig) => {
  const real = await orig()
  return { ...real, readProviderFor: () => m.provider }
})

/**
 * Reads route by ADDRESS **and by CHAIN** — the whole point of this panel is that the two rails
 * read two different contracts on two different chains (GMX's DataStore on Arbitrum, the FairWins
 * FeeRouter on the build's mainnet chain), so a mock that could not tell them apart proves nothing.
 *
 * The ethers fake this replaced could tell them apart by address but not by chain: it was handed a
 * `runner` and the chain lived inside it, so a rail read against the WRONG chain's endpoint passed
 * every assertion in this file. `m.readCalls` records the chain now.
 */
vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      m.readCalls.push({ chainId, address, functionName, args })
      if (functionName === 'getUint') {
        m.dataStoreKeys.push(args[0])
        return m.getUint(args[0])
      }
      if (functionName === 'getService') {
        m.serviceIds.push(args[0])
        return m.getService(args[0])
      }
      throw new Error('unmocked read: ' + functionName)
    },
  }
})

import PerpsFeesPanel from '../../components/admin/PerpsFeesPanel'
import { HL_BUILDER_SERVICE_ID, uiFeeReceiverGuard } from '../../components/admin/perpsFeeRails'
import { GMX_EXCHANGE_ROUTER_ABI } from '../../abis/perps/gmxExchangeRouter'
import panelSource from '../../components/admin/PerpsFeesPanel.jsx?raw'
import railsSource from '../../components/admin/perpsFeeRails.js?raw'

/** Writes are calldata now — the signer records what it was asked to send so it can be decoded. */
const SIGNER = {
  isSigner: true,
  sendTransaction: async (tx) => {
    m.writes.push(tx)
    return { hash: '0xdeadbeef' }
  },
}
const RECEIVER_KEY = gmxUiFeeFactorKey(RECEIVER)

/** 5 bps in GMX's uiFeeFactor units, and 10 bps as the venue ceiling. */
const FACTOR_5_BPS = 5n * 10n ** 26n
const MAX_FACTOR_10_BPS = 10n ** 27n

function runTx(fn) {
  m.txCalls += 1
  return Promise.resolve(fn())
}

function props(overrides = {}) {
  return {
    signer: SIGNER,
    account: RECEIVER,
    chainId: GMX_CHAIN,
    provider: null,
    runTx,
    pendingTx: false,
    onOpenFees: null,
    ...overrides,
  }
}

beforeEach(() => {
  m.cohortMainnet = true
  m.manageFlag = false
  m.receiver = RECEIVER
  m.provider = { isReadProvider: true }
  m.feeRouterAddr = FEE_ROUTER
  m.dataStoreKeys = []
  m.serviceIds = []
  m.readCalls = []
  m.writes = []
  m.txCalls = 0
  m.getUint = async (key) => (key === GMX_MAX_UI_FEE_FACTOR_KEY ? MAX_FACTOR_10_BPS : FACTOR_5_BPS)
  m.getService = async () => ({ capBps: 10, feeBps: 0, kind: 2 })
})

/* --------------------------------------------------------------------------------------------- *
 * AC1 — each rail reads the contract that enforces it, and says which one that is
 * --------------------------------------------------------------------------------------------- */

describe('AC1 — the authority for each rail', () => {
  it('reads the GMX rate from GMX’s own DataStore, keyed by the FairWins receiver', async () => {
    render(<PerpsFeesPanel {...props()} />)
    await screen.findByText(/5 bps \(0\.05%\) of notional/)

    // The two keys, and no others: a mis-derived key returns 0 from a flat bytes32 map, which
    // reads as "no fee" and is indistinguishable from a genuinely unset rate.
    expect(m.dataStoreKeys).toContain(RECEIVER_KEY)
    expect(m.dataStoreKeys).toContain(GMX_MAX_UI_FEE_FACTOR_KEY)
    expect(new Set(m.dataStoreKeys).size).toBe(2)
  })

  it('reads each rail on ITS OWN chain — Arbitrum for GMX, the mainnet chain for the FeeRouter', async () => {
    // What the ethers fake could not show. It routed by address and got the chain from a `runner`
    // object, so a rail read against the wrong chain's endpoint passed every assertion in this
    // file. These are two rails on two chains by design, and reading one on the other's endpoint
    // returns no code at the address — which surfaces as "unreadable", not as a wrong number, but
    // is still a fee screen reporting nothing while both rails are live.
    render(<PerpsFeesPanel {...props()} />)
    await screen.findByText(/5 bps \(0\.05%\) of notional/)
    await waitFor(() => expect(m.readCalls.length).toBeGreaterThanOrEqual(3))

    for (const call of m.readCalls) {
      if (call.functionName === 'getUint') {
        expect(Number(call.chainId)).toBe(Number(GMX_CHAIN))
        expect(call.address).toBe(GMX.dataStore)
      } else {
        expect(Number(call.chainId)).toBe(Number(MAINNET_CHAIN_ID))
        expect(call.address).toBe(FEE_ROUTER)
      }
    }
    // And the two chains really are different here, or the assertion above proves nothing.
    expect(Number(GMX_CHAIN)).not.toBe(Number(MAINNET_CHAIN_ID))
  })

  it('names GMX’s DataStore as the authority and says the FeeRouter is not it', async () => {
    render(<PerpsFeesPanel {...props()} />)
    await screen.findByText(/5 bps \(0\.05%\) of notional/)
    expect(screen.getByText(/not the FairWins FeeRouter/i)).toBeInTheDocument()
  })

  it('reads the Hyperliquid rate from the FeeRouter service that enforces it', async () => {
    m.getService = async () => ({ capBps: 10, feeBps: 4, kind: 2 })
    render(<PerpsFeesPanel {...props()} />)
    await screen.findByText(/4 bps \(0\.04%\) of order notional/)
    expect(m.serviceIds).toEqual([HL_BUILDER_SERVICE_ID])
    expect(HL_BUILDER_SERVICE_ID).toBe(ethers.id('perps.hyperliquid.builder'))
  })

  it('shows the GMX ceiling as READ, not as the assumed 10 bps', async () => {
    // GMX could raise MAX_UI_FEE_FACTOR; a hardcoded ceiling would then be a false statement about
    // what the venue enforces. 2e27 = 20 bps.
    m.getUint = async (key) => (key === GMX_MAX_UI_FEE_FACTOR_KEY ? 2n * 10n ** 27n : FACTOR_5_BPS)
    render(<PerpsFeesPanel {...props()} />)
    expect(await screen.findByText(/20 bps \(0\.2%\) — read live from GMX, not assumed/)).toBeInTheDocument()
  })

  it('discloses that GMX charges the UI fee on both sides, so a close carries it too', async () => {
    render(<PerpsFeesPanel {...props()} />)
    expect(await screen.findByText(/increase/i)).toBeInTheDocument()
    expect(screen.getByText(/so a close\s+carries it too/i)).toBeInTheDocument()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Spec 071 — three honest read states, and an unreachable chain is NEVER a zero
 * --------------------------------------------------------------------------------------------- */

describe('honest read states', () => {
  it('an unreadable GMX DataStore says so, and never renders as a rate of zero', async () => {
    m.getUint = async () => {
      throw new Error('arbitrum endpoint timed out')
    }
    render(<PerpsFeesPanel {...props()} />)
    const notes = await screen.findAllByText(/could not be read \(arbitrum endpoint timed out\)/)
    expect(notes.length).toBeGreaterThan(0)
    expect(screen.getAllByText(/This is not a rate of zero/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/0 bps \(0%\) of notional/)).not.toBeInTheDocument()
  })

  it('an undeployed FeeRouter is a definite answer, stated as such', async () => {
    m.feeRouterAddr = null
    render(<PerpsFeesPanel {...props()} />)
    expect(await screen.findByText(/no FeeRouter is deployed on .* — no rate exists to charge/)).toBeInTheDocument()
    expect(m.serviceIds).toEqual([])
  })

  it('an unregistered Hyperliquid service says nothing is charged, not that the rate is 0', async () => {
    m.getService = async () => ({ capBps: 0, feeBps: 0, kind: 0 })
    render(<PerpsFeesPanel {...props()} />)
    expect(await screen.findByText(/not registered on this FeeRouter — nothing is charged/)).toBeInTheDocument()
  })

  it('an unreadable FeeRouter is not a zero either', async () => {
    m.getService = async () => {
      throw new Error('polygon endpoint refused')
    }
    render(<PerpsFeesPanel {...props()} />)
    expect(await screen.findAllByText(/could not be read \(polygon endpoint refused\)/)).not.toHaveLength(0)
  })

  it('a chain with no read connection is unreadable, not empty and not zero', async () => {
    m.provider = null
    render(<PerpsFeesPanel {...props()} />)
    expect(await screen.findAllByText(/no read connection to/)).not.toHaveLength(0)
    expect(m.dataStoreKeys).toEqual([])
  })

  it('a testnet cohort has no perps rail to administer, and offers no control', async () => {
    m.cohortMainnet = false
    render(<PerpsFeesPanel {...props()} />)
    expect(await screen.findByText(/Every perps venue FairWins integrates is a mainnet venue/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Set GMX UI fee/ })).not.toBeInTheDocument()
    expect(m.dataStoreKeys).toEqual([])
    expect(m.serviceIds).toEqual([])
  })
})

/* --------------------------------------------------------------------------------------------- *
 * The dangerous control — setUiFeeFactor credits msg.sender
 * --------------------------------------------------------------------------------------------- */

describe('the setUiFeeFactor control refuses any wallet but the configured receiver', () => {
  it('offers no control at all to a wallet that is not the receiver', async () => {
    render(<PerpsFeesPanel {...props({ account: OTHER_WALLET })} />)
    await screen.findByText(/This wallet cannot change the GMX UI fee/)
    expect(screen.queryByRole('button', { name: /Set GMX UI fee/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/New UI fee/)).not.toBeInTheDocument()
  })

  it('explains the msg.sender semantics rather than just disabling something', async () => {
    render(<PerpsFeesPanel {...props({ account: OTHER_WALLET })} />)
    const refusal = await screen.findByRole('alert')
    expect(refusal.textContent).toMatch(/msg\.sender/)
    expect(refusal.textContent).toMatch(/claimUiFees/)
    expect(refusal.textContent).toContain(OTHER_WALLET)
    expect(refusal.textContent).toContain(RECEIVER)
  })

  it('refuses when no wallet is connected, naming the wallet that is required', async () => {
    render(<PerpsFeesPanel {...props({ account: null, signer: null })} />)
    const refusal = await screen.findByRole('alert')
    expect(refusal.textContent).toMatch(/Connect the UI-fee receiver wallet/)
    expect(refusal.textContent).toContain(RECEIVER)
  })

  it('offers the control to the receiver wallet on Arbitrum', async () => {
    render(<PerpsFeesPanel {...props()} />)
    const button = await screen.findByRole('button', { name: /Set GMX UI fee/ })
    expect(button).toBeEnabled()
  })

  it('names the chain to switch to instead of failing silently on the wrong one', async () => {
    render(<PerpsFeesPanel {...props({ chainId: 137 })} />)
    const button = await screen.findByRole('button', { name: /Set GMX UI fee/ })
    expect(button).toBeDisabled()
    expect(screen.getByText(/switch to it to send one/i)).toBeInTheDocument()
  })

  describe('uiFeeReceiverGuard', () => {
    it('allows only an exact address match, case-insensitively', () => {
      expect(uiFeeReceiverGuard({ account: RECEIVER, receiver: RECEIVER }).allowed).toBe(true)
      expect(uiFeeReceiverGuard({ account: RECEIVER.toLowerCase(), receiver: RECEIVER }).allowed).toBe(true)
      expect(uiFeeReceiverGuard({ account: OTHER_WALLET, receiver: RECEIVER }).allowed).toBe(false)
      expect(uiFeeReceiverGuard({ account: null, receiver: RECEIVER }).allowed).toBe(false)
      expect(uiFeeReceiverGuard({ account: 'not-an-address', receiver: RECEIVER }).allowed).toBe(false)
    })

    it('refuses when no receiver is configured, and says GMX is then structurally fee-free', () => {
      const gate = uiFeeReceiverGuard({ account: RECEIVER, receiver: null })
      expect(gate.allowed).toBe(false)
      expect(gate.reason).toMatch(/zero address/)
    })

    it('always carries a reason with a refusal — a bare false would be a dead control', () => {
      for (const gate of [
        uiFeeReceiverGuard({ account: OTHER_WALLET, receiver: RECEIVER }),
        uiFeeReceiverGuard({ account: null, receiver: RECEIVER }),
        uiFeeReceiverGuard({ account: RECEIVER, receiver: null }),
      ]) {
        expect(gate.allowed).toBe(false)
        expect(gate.reason).toBeTruthy()
      }
    })
  })
})

/* --------------------------------------------------------------------------------------------- *
 * AC2 — the ceiling refuses, and nothing is silently clamped
 * --------------------------------------------------------------------------------------------- */

describe('AC2 — a rate above the venue ceiling is refused, and the ceiling is stated', () => {
  async function typeAndSubmit(value) {
    render(<PerpsFeesPanel {...props()} />)
    const input = await screen.findByLabelText(/New UI fee/)
    fireEvent.change(input, { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: /Set GMX UI fee/ }))
  }

  it('refuses a rate above the LIVE ceiling before any transaction is built', async () => {
    await typeAndSubmit('11')
    const error = await screen.findByRole('alert')
    expect(error.textContent).toMatch(/above GMX's live MAX_UI_FEE_FACTOR of 10 bps/)
    expect(m.txCalls).toBe(0)
    expect(m.writes).toEqual([])
  })

  it('never clamps down to the ceiling — the operator is told, not quietly overridden', async () => {
    // With the live ceiling unreadable the module constant is the backstop; a clamp would send
    // 10 bps for a typed 25 and nobody would ever find out.
    m.getUint = async (key) => {
      if (key === GMX_MAX_UI_FEE_FACTOR_KEY) throw new Error('ceiling read failed')
      return FACTOR_5_BPS
    }
    render(<PerpsFeesPanel {...props()} />)
    const input = await screen.findByLabelText(/New UI fee/)
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: /Set GMX UI fee/ }))
    const error = await screen.findByRole('alert')
    expect(error.textContent).toMatch(/documented ceiling of 10 bps/)
    expect(error.textContent).toMatch(/not lowered for you/)
    expect(m.writes).toEqual([])
  })

  it('says the live ceiling could not be confirmed rather than presenting the constant as read', async () => {
    m.getUint = async () => {
      throw new Error('endpoint down')
    }
    render(<PerpsFeesPanel {...props()} />)
    expect(await screen.findByText(/GMX's live ceiling could not be read/)).toBeInTheDocument()
  })

  it('refuses a negative or non-numeric rate before any wallet prompt', async () => {
    await typeAndSubmit('-1')
    expect((await screen.findByRole('alert')).textContent).toMatch(/0 or more/)
    expect(m.txCalls).toBe(0)
  })

  it('sends the correct uiFeeFactor to the ExchangeRouter for a valid rate', async () => {
    await typeAndSubmit('5')
    await waitFor(() => expect(m.writes).toHaveLength(1))
    expect(m.writes[0].to).toBe(GMX.exchangeRouter)
    // The calldata is built by viem and decoded here by ETHERS against the same ABI — a live
    // cross-library byte check, not a read-back of arguments a fake was handed.
    const parsed = new ethers.Interface(GMX_EXCHANGE_ROUTER_ABI).parseTransaction({
      data: m.writes[0].data,
    })
    expect(parsed.name).toBe('setUiFeeFactor')
    // 5 bps = 5e26. A missing ×10 anywhere here is a rate the venue would happily enforce.
    expect(parsed.args[0]).toBe(FACTOR_5_BPS)
  })

  it('sends to the ExchangeRouter, never to the Router or the DataStore', async () => {
    await typeAndSubmit('5')
    await waitFor(() => expect(m.writes).toHaveLength(1))
    expect(m.writes[0].to).not.toBe(GMX.router)
    expect(m.writes[0].to).not.toBe(GMX.dataStore)
  })
})

/* --------------------------------------------------------------------------------------------- *
 * AC3 — a zero rate is a fee-free integration, and Gains has no rate at all
 * --------------------------------------------------------------------------------------------- */

describe('AC3 and the un-settable rails', () => {
  it('a zero GMX rate states that members see no fee line at all', async () => {
    m.getUint = async (key) => (key === GMX_MAX_UI_FEE_FACTOR_KEY ? MAX_FACTOR_10_BPS : 0n)
    render(<PerpsFeesPanel {...props()} />)
    expect(
      await screen.findByText(/members see no fee line anywhere and the integration behaves/i),
    ).toBeInTheDocument()
  })

  it('offers no settable field for Gains — a control that does nothing is worse than none', async () => {
    render(<PerpsFeesPanel {...props()} />)
    await screen.findByRole('heading', { name: /Gains Network — no FairWins-settable rate/ })
    // Exactly one input on the whole screen, and it is the GMX one.
    const inputs = document.querySelectorAll('input')
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toBe(screen.getByLabelText(/New UI fee/))
    expect(screen.getByText(/venue pays a referral rebate|pays a referral rebate/i)).toBeInTheDocument()
  })

  it('does not duplicate the Hyperliquid rate control — it links to the Fees tab', async () => {
    const onOpenFees = vi.fn()
    render(<PerpsFeesPanel {...props({ onOpenFees })} />)
    const link = await screen.findByRole('button', { name: /in the Fees tab/ })
    fireEvent.click(link)
    expect(onOpenFees).toHaveBeenCalled()
    // One rate-setting button on the screen, and it is the GMX one.
    const setters = screen
      .getAllByRole('button')
      .filter((b) => /^Set /.test(b.textContent || ''))
      .map((b) => b.textContent)
    expect(setters).toEqual(['Set GMX UI fee'])
  })
})

/* --------------------------------------------------------------------------------------------- *
 * The current state, said out loud
 * --------------------------------------------------------------------------------------------- */

describe('the flag-off state is disclosed rather than implied', () => {
  it('says the rate is configured and charged to nobody while the flag is off', async () => {
    render(<PerpsFeesPanel {...props()} />)
    const banner = await screen.findByText(/Configured, and charged to nobody/)
    expect(banner).toBeInTheDocument()
    expect(screen.getByText('VITE_PERPS_MANAGE_ENABLED')).toBeInTheDocument()
  })

  it('drops the banner once management is enabled', async () => {
    m.manageFlag = true
    render(<PerpsFeesPanel {...props()} />)
    await screen.findByText(/5 bps \(0\.05%\) of notional/)
    expect(screen.queryByText(/Configured, and charged to nobody/)).not.toBeInTheDocument()
  })

  it('states that Hyperliquid trading is read-only, so its rate rides nothing', async () => {
    render(<PerpsFeesPanel {...props()} />)
    expect(await screen.findByText(/read-only this release/)).toBeInTheDocument()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Structural rules the DOM cannot show
 * --------------------------------------------------------------------------------------------- */

describe('structure', () => {
  // Comments stripped: this file's header DESCRIBES the two things asserted against below
  // (`NETWORKS[chainId].rpcUrl`, a `perps.gmx.uifee` service) as the things it must not do, and a
  // test that cannot tell an explanation from an implementation is not testing the code.
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const source = strip(panelSource) + strip(railsSource)

  it('resolves every read connection through the app’s providers (spec 069)', () => {
    expect(source).toMatch(/readProviderFor\(/)
    // Never hand-built from the build default: that would ignore the member's configured endpoint
    // and its failover for every read this panel makes.
    expect(source).not.toMatch(/NETWORKS\[[^\]]*\]\.rpcUrl/)
    expect(source).not.toMatch(/new ethers\.JsonRpcProvider/)
  })

  it('registers no FeeRouter service for the GMX rate — there is deliberately none', () => {
    // A `perps.gmx.uifee` service would be a second config store for a rate FairWins cannot
    // enforce, and its control would silently do nothing.
    expect(source).not.toMatch(/perps\.gmx/)
    expect(source).not.toMatch(/perps\.gains/)
  })

  it('has exactly one write, and it is setUiFeeFactor', () => {
    // Writes are `encodeFunctionData` + `signer.sendTransaction` now (spec 110), so the shape this
    // greps for is the function NAME in the encode — the one place a second write would have to
    // name itself. The old pattern matched `new Contract(ABI, signer).method(`, which no longer
    // exists; leaving it in place would have made this assertion pass over an empty match set.
    const writes = [...source.matchAll(/functionName:\s*'(\w+)'/g)]
      .map((mm) => mm[1])
      .filter((name) => name.startsWith('set'))
    expect(writes).toEqual(['setUiFeeFactor'])
    expect(source).toMatch(/signer\.sendTransaction\(/)
    // The Hyperliquid rate is edited in the Fees tab; this panel must not learn to set it.
    expect(source).not.toMatch(/setFeeBps\(/)
  })

  it('never puts a FairWins address anywhere but the uiFeeReceiver rail (rule 1)', () => {
    // This panel touches no position, but the receiver constant is a FairWins address and the
    // only calldata it may reach is the fee factor keyed by it.
    expect(source).not.toMatch(/createOrder|receiver:|cancellationReceiver/)
  })
})
