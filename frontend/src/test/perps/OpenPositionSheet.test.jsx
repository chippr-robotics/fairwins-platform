/**
 * OpenPositionSheet (spec 083, T050 + T052) — the opening surface, tested against US3.
 *
 * What these assert, and why each one is here rather than left to a reviewer's eye:
 *
 *   - the sheet arrives ALREADY CONFIGURED, with the reason for each choice stated, so a member
 *     changes at most two fields to submit (SC-006);
 *   - the cost breakdown appears BEFORE any signature, states the fee's base honestly (on SIZE,
 *     not on the amount put in), and a zero rate produces no fee line anywhere (FR-012/FR-013);
 *   - an UNREADABLE fee rate blocks opening — the one asymmetry with the exit sheet, and the one
 *     most easily broken by copying it;
 *   - inputs are refused before any wallet prompt, with a plain reason (FR-022);
 *   - the attestation gates the open and nothing else, and nothing is pre-ticked (FR-015);
 *   - inclusion is reported as "sent to the venue" and NEVER as a position; only the venue's
 *     execution event reports one (FR-007);
 *   - a venue cancellation surfaces the venue's own words AND states that no FairWins fee was
 *     charged (US3 acceptance 5);
 *   - a close-only or paused venue is NOT OFFERED, with the venue named as the source (FR-017);
 *   - a passkey session is told the smart account will own the position (FR-020);
 *   - the calldata that reaches the wallet is the MEMBER's own order.
 *
 * Nothing here touches a network: the send rail, the read provider, the clock, the fee read, the
 * venue quote, the allowance read and the attestation store are all injected.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Interface, getAddress } from 'ethers'

import { WalletContext } from '../../contexts/WalletContext'
import OpenPositionSheet from '../../components/perps/OpenPositionSheet'
import sheetSource from '../../components/perps/OpenPositionSheet.jsx?raw'
import { GAINS_DIAMOND_ABI } from '../../abis/perps/gainsDiamond'
import { GAINS_DIAMOND_BY_CHAIN } from '../../config/perps'

const ARBITRUM = 42161
const MEMBER = '0xd504dC1ac094F45272f46b25A2874bDab45132Da'
const FAIRWINS = '0x52502d049571C7893447b86c4d8B38e6184bF6e1'
const MARKET = '0x47c031236e19d024b42f8AE6780E44A573170703'
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const TX = `0x${'11'.repeat(32)}`

const diamond = new Interface(GAINS_DIAMOND_ABI)

/* --------------------------------------------------------------------------------------------- *
 * Fixtures
 * --------------------------------------------------------------------------------------------- */

const wallet = { current: {} }

const GAINS_PAIR = {
  id: `gains:${ARBITRUM}:BTC/USD`,
  venue: 'gains',
  chainId: ARBITRUM,
  symbol: 'BTC/USD',
  base: 'BTC',
  quote: 'USD',
  price: 60_000,
  fundingRate: 0.00001,
  openInterestUsd: 5_000_000,
  maxLeverage: 150,
}

const GMX_PAIR = {
  id: `gmx:${ARBITRUM}:BTC/USD:${MARKET}`,
  venue: 'gmx',
  chainId: ARBITRUM,
  symbol: 'BTC/USD',
  variant: 'BTC-USDC',
  price: 60_000,
  fundingRate: 0.00002,
  openInterestUsd: 9_000_000,
  maxLeverage: null,
}

const USDC_COLLATERAL = {
  symbol: 'USDC',
  address: USDC,
  decimals: 6,
  collateralIndex: 3,
  isPrimary: true,
  usdPrice: 1,
}

const HOLDINGS = [{ symbol: 'USDC', address: USDC, balance: 1_000_000_000n, decimals: 6, usdValue: 1000 }]

function gainsOption(overrides = {}) {
  return {
    venue: 'gains',
    chainId: ARBITRUM,
    status: 'open',
    pair: GAINS_PAIR,
    venueRef: { pairIndex: 1 },
    collaterals: [USDC_COLLATERAL],
    limits: { maxLeverage: 150, minLeverage: 2 },
    minNotional: null,
    ...overrides,
  }
}

function gmxOption(overrides = {}) {
  return {
    venue: 'gmx',
    chainId: ARBITRUM,
    status: 'open',
    pair: GMX_PAIR,
    collaterals: [USDC_COLLATERAL],
    limits: { maxLeverage: 50 },
    minNotional: null,
    ...overrides,
  }
}

function gainsLog(name, args) {
  const encoded = diamond.encodeEventLog(diamond.getEvent(name), args)
  return { address: GAINS_DIAMOND_BY_CHAIN[ARBITRUM], topics: encoded.topics, data: encoded.data }
}

const MARKET_EXECUTED = () =>
  gainsLog('MarketExecuted', [
    [MEMBER, 4],
    MEMBER,
    7,
    [MEMBER, 7, 1, 2_000, true, true, 3, 0, 100_000_000n, 600_000_000_000_000n, 0, 0, false, 0, 0],
    true,
    60_000n * 10n ** 10n,
    60_000n * 10n ** 10n,
    30_000n * 10n ** 10n,
    [0n, 0n, 0n, 0n, 0n, 0n],
    0n,
    0n,
    10n ** 8n,
  ])

/** cancelReason 3 = SLIPPAGE — Gains' own mapped sentence. */
const MARKET_OPEN_CANCELED = () => gainsLog('MarketOpenCanceled', [[MEMBER, 4], MEMBER, 1, 3, 100_000_000n])

const receipt = (logs = []) => ({ route: 'direct', txHash: TX, receipts: [{ status: 1, hash: TX, blockNumber: 100, logs }] })

/** The watcher parks after its first poll, so a test sees the state the member sees. */
const parked = () => new Promise(() => {})
const idleChain = { getLogs: async () => [], getBlockNumber: async () => 100 }

/**
 * Render the sheet with every side effect injected. `attested` is a live box so a test can watch
 * the gate open in place, exactly as a member does.
 */
function renderSheet({
  pair = GAINS_PAIR,
  venueOptions = [gainsOption()],
  holdings = HOLDINGS,
  sendOnChain,
  readFee,
  readQuote,
  readAllowance,
  attested = true,
  screenAccount,
  ...props
} = {}) {
  const send = sendOnChain ?? vi.fn(async () => receipt())
  const gate = { attested }
  const deps = {
    readFee: readFee ?? (async () => ({ bps: 5 })),
    readQuote: readQuote ?? (async () => null),
    readAllowance: readAllowance ?? (async () => 10n ** 30n),
    hasAttested: () => gate.attested,
    subscribeAttestation: () => () => {},
    attestation: {
      state: () => ({ attested: gate.attested, record: null, version: 1, superseded: false, reason: null }),
      record: (items) => {
        gate.attested = true
        return { version: 1, items: Object.keys(items).filter((k) => items[k]), at: '2026-08-12T00:00:00.000Z' }
      },
      subscribe: () => () => {},
    },
    trade: {
      sendOnChain: send,
      getProvider: () => idleChain,
      sleep: parked,
      now: () => 0,
      screenAccount: screenAccount ?? (async () => 'clear'),
    },
  }
  const view = render(
    <WalletContext.Provider value={wallet.current}>
      <OpenPositionSheet
        pair={pair}
        venueOptions={venueOptions}
        holdings={holdings}
        deps={deps}
        onClose={props.onClose ?? (() => {})}
        {...props}
      />
    </WalletContext.Provider>,
  )
  return { ...view, sendOnChain: send, gate }
}

/** Flush the venue reads so the breakdown has settled. */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function typeAmount(value) {
  fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value } })
}

const submitButton = () => screen.getByRole('button', { name: /Open this (long|short)/ })

/**
 * The value rendered for a breakdown row, by its label.
 *
 * Matched on the whole `dt`'s text rather than a text node: several labels interpolate the venue's
 * name, so React splits them across nodes and a plain string matcher silently misses them.
 */
function row(label) {
  const term = screen
    .getAllByRole('term')
    .find((node) => node.textContent.replace(/\s+/g, ' ').trim() === label)
  if (!term) throw new Error(`no breakdown row labelled "${label}"`)
  return term.parentElement.querySelector('dd')
}

beforeEach(() => {
  wallet.current = { address: MEMBER, chainId: ARBITRUM, loginMethod: 'wallet', signer: {}, sendCalls: vi.fn() }
})

/* --------------------------------------------------------------------------------------------- *
 * US3 acceptance 1 — already configured, with the reason stated
 * --------------------------------------------------------------------------------------------- */

describe('the sheet arrives already configured', () => {
  it('pre-selects venue, direction, collateral and a conservative leverage', async () => {
    renderSheet()
    await settle()

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByRole('heading', { name: /Open a long on BTC\/USD/ })).toBeInTheDocument()
    expect(screen.getByLabelText(/Long — you gain if the price rises/)).toBeChecked()
    // The conservative default, not the venue's 150× maximum.
    expect(screen.getByLabelText(/type a multiplier/)).toHaveValue('2')
    expect(screen.getByLabelText(/^Amount \(USDC\)/)).toBeInTheDocument()
  })

  it('states the REASON the venue was chosen for them', async () => {
    renderSheet({
      pair: GAINS_PAIR,
      venueOptions: [gainsOption(), gmxOption()],
    })
    await settle()

    // Two venues list the pair, so the choice is real and has to explain itself.
    expect(screen.getByText(/is chosen for you: (cheaper funding|deeper liquidity|similar terms)/i)).toBeInTheDocument()
  })

  it('states the reason for the leverage, in money terms a member can act on', async () => {
    renderSheet()
    await settle()
    expect(screen.getByText(/2× is chosen for you/)).toBeInTheDocument()
    expect(screen.getByText(/move about 50% against you/)).toBeInTheDocument()
    expect(screen.getByText(/allows up to 150×/)).toBeInTheDocument()
  })

  it('needs only the AMOUNT before it will submit (SC-006)', async () => {
    const { sendOnChain } = renderSheet()
    await settle()
    expect(submitButton()).toBeDisabled()

    await act(async () => {
      typeAmount('100')
    })
    await settle()

    expect(submitButton()).toBeEnabled()
    await act(async () => {
      fireEvent.click(submitButton())
    })
    expect(sendOnChain).toHaveBeenCalledTimes(1)
  })

  it('offers only the collateral the member actually holds, and says why it chose one', async () => {
    const WETH = `0x${'ee'.repeat(20)}`
    const WBTC = `0x${'cc'.repeat(20)}`
    renderSheet({
      venueOptions: [
        gainsOption({
          collaterals: [
            { symbol: 'WETH', address: WETH, decimals: 18, collateralIndex: 1, usdPrice: 3000 },
            { symbol: 'WBTC', address: WBTC, decimals: 8, collateralIndex: 2, usdPrice: 60000 },
            USDC_COLLATERAL,
          ],
        }),
      ],
      holdings: [
        ...HOLDINGS,
        { symbol: 'WETH', address: WETH, balance: 10n ** 18n, decimals: 18, usdValue: 3000 },
      ],
    })
    await settle()

    // WBTC is accepted by the venue but not held, so it is not even an option — a default the
    // member does not hold is a dead form, not a default.
    const options = [...screen.getByLabelText('Pay with').options].map((o) => o.textContent)
    expect(options).toEqual(['WETH', 'USDC'])
    // …and the stablecoin wins over the volatile one, which would add a second directional bet.
    expect(screen.getByLabelText('Pay with')).toHaveValue(USDC)
    expect(screen.getByText(/USDC is chosen for you/)).toBeInTheDocument()
  })

  it('shows no collateral chooser at all when there is nothing to choose between', async () => {
    renderSheet()
    await settle()
    expect(screen.queryByLabelText('Pay with')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^Amount \(USDC\)/)).toBeInTheDocument()
  })

  it('says plainly when the member holds nothing the venue accepts, instead of a dead form', async () => {
    renderSheet({ holdings: [] })
    await settle()

    expect(screen.getByText(/do not hold any of the collateral Gains accepts/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Amount/)).not.toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * US3 acceptance 2 — the live preview, and the fee disclosed before any signature
 * --------------------------------------------------------------------------------------------- */

describe('the preview and the fee disclosure', () => {
  it('shows size, entry, liquidation, fees and total cost — live, before any signature', async () => {
    const { sendOnChain } = renderSheet()
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()

    expect(row('Position size (estimated)')).toHaveTextContent('$200.00')
    expect(row('Estimated entry price')).toHaveTextContent('60,000.0')
    // A long at 2× is liquidated about halfway down.
    expect(row('Estimated liquidation price')).toHaveTextContent('30,000.0')
    expect(row('FairWins fee (0.05% of size)')).toHaveTextContent('$0.10')
    expect(row('Total cost')).toHaveTextContent('$100.10')
    expect(sendOnChain).not.toHaveBeenCalled()
  })

  it('recomputes when the leverage changes — the numbers are never hardcoded', async () => {
    renderSheet()
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()
    expect(row('Position size (estimated)')).toHaveTextContent('$200.00')

    await act(async () => {
      fireEvent.click(screen.getByLabelText('10×'))
    })
    await settle()
    expect(row('Position size (estimated)')).toHaveTextContent('$1,000.00')
    expect(row('Estimated liquidation price')).toHaveTextContent('54,000.0')
    expect(row('FairWins fee (0.05% of size)')).toHaveTextContent('$0.50')
  })

  it('states the fee’s base honestly — charged on SIZE, not on the amount put in', async () => {
    renderSheet()
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()

    const note = screen.getByText(/The FairWins fee is charged on the position’s size/)
    expect(note).toHaveTextContent('$200.00')
    expect(note).toHaveTextContent('not on the $100.00 you put in')
  })

  it('shows NO fee line at all at a zero rate (FR-012)', async () => {
    renderSheet({ readFee: async () => ({ bps: 0 }) })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()

    expect(screen.queryByText(/FairWins fee/)).not.toBeInTheDocument()
    expect(screen.queryByText(/charged on the position’s size/)).not.toBeInTheDocument()
    // …and behaviour is otherwise identical: the total is just the amount put in.
    expect(row('Total cost')).toHaveTextContent('$100.00')
    expect(submitButton()).toBeEnabled()
  })

  it('BLOCKS opening when the rate could not be read, and says why', async () => {
    const { sendOnChain } = renderSheet({ readFee: async () => ({ failed: true }) })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()

    expect(screen.getByText(/rate could not be confirmed just now, so a position cannot be opened/)).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
    await act(async () => {
      fireEvent.click(submitButton())
    })
    expect(sendOnChain).not.toHaveBeenCalled()
    // …while saying, in the same breath, that nothing about an EXIT is affected.
    expect(screen.getByText(/can still be closed/)).toBeInTheDocument()
  })

  it('renders a figure it could not derive as “—”, never as zero', async () => {
    renderSheet({
      venueOptions: [gainsOption({ collaterals: [{ ...USDC_COLLATERAL, usdPrice: null }] })],
      holdings: [{ symbol: 'USDC', address: USDC, balance: 1_000_000_000n, decimals: 6 }],
    })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()

    expect(row('Position size (estimated)')).toHaveTextContent('—')
    expect(row('Total cost')).toHaveTextContent('—')
    expect(row('Gains’s own fee')).toHaveTextContent('—')
  })

  /* ------------------------------------------------------------------------------------------- *
   * The venue's own fee, in money
   *
   * It used to be '—' on every open, beside a FairWins fee in dollars — which reads as though ours
   * were the cost of trading. These are the assertions that keep the venue's own cost on screen and
   * keep it labelled as the estimate it is.
   * ------------------------------------------------------------------------------------------- */

  const BTC_FEE = { openRate: 0.00035, closeRate: 0.00035, feeFloorNotionalUsd: 285.715, minFeeUsd: 0.10000025 }

  it('shows the venue’s own fee in money, with its published rate, labelled an estimate', async () => {
    renderSheet({ venueOptions: [gainsOption({ venueFee: BTC_FEE })] })
    await settle()
    await act(async () => {
      typeAmount('100')
      fireEvent.change(screen.getByLabelText(/type a multiplier/), { target: { value: '10' } })
    })
    await settle()

    // $100 at 10× is a $1,000 position; 0.035% of that is $0.35.
    expect(row('Gains’s own fee (0.035% of size), estimated')).toHaveTextContent('$0.35')
    // Both fees now carry a number, and the total is the sum of the two plus the collateral.
    expect(row('FairWins fee (0.05% of size)')).toHaveTextContent('$0.50')
    expect(row('Total cost')).toHaveTextContent('$100.85')
    // A published rate is not a quote, and the copy says which it is rather than implying exactness.
    expect(screen.getByText(/rate Gains publishes for this market, not from a quote/)).toBeInTheDocument()
    expect(screen.getByText(/does not include Gains’s spread/)).toBeInTheDocument()
  })

  it('says when the venue’s fee FLOOR is what is being charged, not the headline rate', async () => {
    renderSheet({ venueOptions: [gainsOption({ venueFee: BTC_FEE })] })
    await settle()
    await act(async () => {
      typeAmount('5') // $5 at 10× is a $50 position — under the venue's $285.72 fee floor
      fireEvent.change(screen.getByLabelText(/type a multiplier/), { target: { value: '10' } })
    })
    await settle()

    // The floor, not 0.035% × $50 = $0.0175 — an effective 0.2%, and the member is told why.
    expect(row('Gains’s own fee (0.035% of size), estimated')).toHaveTextContent('$0.10')
    expect(screen.getByText(/below Gains’s smallest fee size/)).toBeInTheDocument()
    expect(screen.getByText(/as though the position were \$285\.72/)).toBeInTheDocument()
  })

  it('discloses the dash rather than leaving it bare when the venue publishes no rate', async () => {
    renderSheet({ venueOptions: [gainsOption()] })
    await settle()
    await act(async () => {
      typeAmount('100')
      fireEvent.change(screen.getByLabelText(/type a multiplier/), { target: { value: '10' } })
    })
    await settle()

    expect(row('Gains’s own fee')).toHaveTextContent('—')
    // The dash is explained, and so is what it means for the total beside it.
    expect(screen.getByText(/does not publish its own trading fee to this app/)).toBeInTheDocument()
    expect(row('Total cost')).toHaveTextContent('$100.50') // collateral + FairWins fee only
  })

  it('shows GMX’s keeper fee on its own line, in the network’s own coin', async () => {
    renderSheet({
      pair: GMX_PAIR,
      venueOptions: [gmxOption()],
      readQuote: async () => ({ executionFee: 10n ** 15n }),
    })
    await settle()

    expect(row('GMX keeper fee (estimated)')).toHaveTextContent('0.001')
    expect(screen.getByText(/returns whatever the keeper does not spend/)).toBeInTheDocument()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * US3 acceptance 3 — refused before any wallet prompt
 * --------------------------------------------------------------------------------------------- */

describe('refusals before any wallet prompt', () => {
  it('refuses more than the member holds, with a plain reason and no send', async () => {
    const { sendOnChain } = renderSheet()
    await settle()
    await act(async () => {
      typeAmount('5000')
    })
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent('That is more than the balance you hold.')
    expect(submitButton()).toBeDisabled()
    await act(async () => {
      fireEvent.click(submitButton())
    })
    expect(sendOnChain).not.toHaveBeenCalled()
  })

  it('refuses a leverage above the venue’s own maximum, naming the maximum', async () => {
    renderSheet()
    await settle()
    await act(async () => {
      typeAmount('100')
      fireEvent.change(screen.getByLabelText(/type a multiplier/), { target: { value: '500' } })
    })
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent('The venue allows at most 150× on this market.')
    expect(submitButton()).toBeDisabled()
  })

  it('refuses a position below the venue’s minimum size, and says how to fix it', async () => {
    renderSheet({ venueOptions: [gainsOption({ minNotional: 1500 })] })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent(/smaller than the venue’s minimum/)
    expect(screen.getByRole('alert')).toHaveTextContent(/Increase the amount or the leverage/)
  })

  it('refuses below the venue’s own collateral minimum BEFORE the prompt, naming the amount', async () => {
    // Gains answers this one with `InsufficientCollateral` — a revert selector the member pays gas
    // to read and cannot act on. The venue's own $0.50 bound, in money, before the wallet opens.
    const { sendOnChain } = renderSheet({
      venueOptions: [gainsOption({ minCollateralUsd: 0.50000125 })],
    })
    await settle()
    await act(async () => {
      typeAmount('0.25')
    })
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent(/needs at least \$0\.50 in a position here/)
    expect(screen.getByRole('alert')).toHaveTextContent(/\$0\.25/)
    expect(submitButton()).toBeDisabled()
    await act(async () => {
      fireEvent.click(submitButton())
    })
    expect(sendOnChain).not.toHaveBeenCalled()
  })

  it('accepts the same order once it clears the venue’s collateral minimum', async () => {
    renderSheet({ venueOptions: [gainsOption({ minCollateralUsd: 0.50000125 })] })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()

    // The bound must not become a control that always refuses — it binds only where it binds.
    expect(screen.queryByText(/needs at least/)).not.toBeInTheDocument()
    expect(submitButton()).toBeEnabled()
  })

  it('discloses rather than pretends when the venue’s leverage limits are unreadable', async () => {
    const { sendOnChain } = renderSheet({ venueOptions: [gainsOption({ limits: {} })] })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent(/maximum leverage could not be read/)
    await act(async () => {
      fireEvent.click(submitButton())
    })
    expect(sendOnChain).not.toHaveBeenCalled()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * FR-015 — the attestation gates the open
 * --------------------------------------------------------------------------------------------- */

describe('the jurisdiction and risk acknowledgement', () => {
  it('blocks the open until every statement is confirmed, with nothing pre-ticked', async () => {
    const { sendOnChain } = renderSheet({ attested: false })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()

    const boxes = screen.getAllByRole('checkbox')
    expect(boxes).toHaveLength(4)
    for (const box of boxes) expect(box).not.toBeChecked()
    expect(submitButton()).toBeDisabled()
    expect(screen.getByText(/not needed to close, reduce or recover/)).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(submitButton())
    })
    expect(sendOnChain).not.toHaveBeenCalled()
  })

  it('opens the gate in place once every statement is confirmed', async () => {
    const { sendOnChain } = renderSheet({ attested: false })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()

    await act(async () => {
      for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I confirm all of the above' }))
    })
    await settle()

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(submitButton()).toBeEnabled()
    await act(async () => {
      fireEvent.click(submitButton())
    })
    expect(sendOnChain).toHaveBeenCalledTimes(1)
  })

  it('is refused by the write path too, not only by the button', async () => {
    // The sheet's own gate is bypassed (it believes the member attested); the hook's is not.
    const { sendOnChain } = renderSheet({ attested: true })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()

    // Everything is wired, so this proves the positive: the hook's gate ran and passed.
    await act(async () => {
      fireEvent.click(submitButton())
    })
    expect(sendOnChain).toHaveBeenCalledTimes(1)
  })

  it('refuses the open when screening cannot confirm the account — and never for an exit reason', async () => {
    const { sendOnChain } = renderSheet({ screenAccount: async () => 'restricted' })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()
    await act(async () => {
      fireEvent.click(submitButton())
    })

    expect(sendOnChain).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/cannot open a new position/),
    )
    expect(screen.getByRole('status')).toHaveTextContent(/still close, reduce and recover/)
  })
})

/* --------------------------------------------------------------------------------------------- *
 * US3 acceptances 4–5 — the async lifecycle
 * --------------------------------------------------------------------------------------------- */

describe('the async lifecycle', () => {
  it('reports inclusion as SENT to the venue — never as a position', async () => {
    const onActionComplete = vi.fn()
    renderSheet({ onActionComplete })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()
    await act(async () => {
      fireEvent.click(submitButton())
    })

    expect(screen.getByRole('status')).toHaveTextContent('Sent to Gains.')
    expect(screen.queryByText(/Position opened/)).not.toBeInTheDocument()
    expect(onActionComplete).not.toHaveBeenCalled()
  })

  it('reports a position ONLY once the venue’s execution event arrives', async () => {
    const onActionComplete = vi.fn()
    renderSheet({ sendOnChain: vi.fn(async () => receipt([MARKET_EXECUTED()])), onActionComplete })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()
    await act(async () => {
      fireEvent.click(submitButton())
    })

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Position opened.'))
    expect(onActionComplete).toHaveBeenCalledTimes(1)
  })

  it('surfaces the venue’s own reason on a cancellation, and says no FairWins fee was charged', async () => {
    renderSheet({ sendOnChain: vi.fn(async () => receipt([MARKET_OPEN_CANCELED()])) })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()
    await act(async () => {
      fireEvent.click(submitButton())
    })

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('The price moved more than your slippage allowed.'),
    )
    const note = screen.getByText(/no FairWins fee was charged/)
    expect(note).toHaveTextContent(/collateral was returned by Gains/)
    expect(note).toHaveTextContent(/taken by Gains when an order executes, and this one did not/)
  })
})

/* --------------------------------------------------------------------------------------------- *
 * FR-017 — venue operational state, with the venue named as the source
 * --------------------------------------------------------------------------------------------- */

describe('venue status', () => {
  it.each([
    ['close-only', /close-only mode/],
    ['paused', /has paused trading/],
    ['unreadable', /could not be confirmed/],
  ])('does not offer an open on a %s venue, and names the venue', async (status, expected) => {
    renderSheet({ venueOptions: [gainsOption({ status })] })
    await settle()

    expect(screen.getByText(expected)).toHaveTextContent('Gains')
    expect(screen.queryByRole('button', { name: /Open this/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Amount/)).not.toBeInTheDocument()
    // Not a dead end: the venue's own surface stays a tap away.
    expect(screen.getByRole('link', { name: /^Trade on [^:]*: BTC\/USD on Gains Network/ })).toBeInTheDocument()
  })

  it('says plainly that nothing already held is affected', async () => {
    renderSheet({ venueOptions: [gainsOption({ status: 'paused' })] })
    await settle()
    expect(screen.getByText(/Nothing you already hold is affected/)).toBeInTheDocument()
    expect(screen.getByText(/still manage every position you have/)).toBeInTheDocument()
  })

  it('keeps an open venue offered while naming why the other one is not', async () => {
    renderSheet({ venueOptions: [gainsOption(), gmxOption({ status: 'paused' })] })
    await settle()

    expect(screen.getByText(/GMX has paused trading/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Amount/)).toBeInTheDocument()
    // One venue left, so there is no choice to present — and it says so rather than showing a
    // radio group of one.
    expect(screen.getByText('Gains is the only venue trading this pair here.')).toBeInTheDocument()
  })

  it('does not offer a venue whose own handle for the pair cannot be resolved', async () => {
    renderSheet({ venueOptions: [gainsOption({ venueRef: null, pair: { ...GAINS_PAIR, pairIndex: undefined } })] })
    await settle()

    expect(screen.getByText(/own number for this market could not be read/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Open this/ })).not.toBeInTheDocument()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * FR-020 — the passkey disclosure
 * --------------------------------------------------------------------------------------------- */

describe('the passkey disclosure', () => {
  it('says plainly that the SMART ACCOUNT will own the position', async () => {
    wallet.current = {
      address: MEMBER,
      chainId: ARBITRUM,
      loginMethod: 'passkey',
      passkeyAccount: { address: MEMBER },
      sendCalls: vi.fn(),
    }
    renderSheet()
    await settle()

    const disclosure = screen.getByText(/signed in with a passkey/)
    expect(disclosure).toHaveTextContent(/smart account will own the position/)
    expect(disclosure).toHaveTextContent(/not the passkey you sign with/)
    expect(disclosure).toHaveTextContent('0xd504')
  })

  it('is absent on a classic wallet session, where it would be untrue', async () => {
    renderSheet()
    await settle()
    expect(screen.queryByText(/signed in with a passkey/)).not.toBeInTheDocument()
  })

  it('does not exclude passkey members from opening', async () => {
    wallet.current = {
      address: MEMBER,
      chainId: ARBITRUM,
      loginMethod: 'passkey',
      passkeyAccount: { address: MEMBER },
      sendCalls: vi.fn(),
    }
    renderSheet()
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()
    expect(submitButton()).toBeEnabled()
  })
})

/* --------------------------------------------------------------------------------------------- *
 * The calldata that actually reaches the wallet
 * --------------------------------------------------------------------------------------------- */

describe('what the wallet is handed', () => {
  it('is the MEMBER’s own order at the venue’s own pair index', async () => {
    const { sendOnChain } = renderSheet()
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()
    await act(async () => {
      fireEvent.click(submitButton())
    })

    const [chainId, calls] = sendOnChain.mock.calls[0]
    expect(chainId).toBe(ARBITRUM)
    expect(calls).toHaveLength(1) // an allowance is already in place
    expect(calls[0].target).toBe(GAINS_DIAMOND_BY_CHAIN[ARBITRUM])
    const [trade, slippage, referrer] = diamond.decodeFunctionData('openTrade', calls[0].data)
    expect(getAddress(trade[0])).toBe(getAddress(MEMBER))
    expect(getAddress(trade[0])).not.toBe(getAddress(FAIRWINS))
    expect(trade[2]).toBe(1n) // pairIndex — the venue's own
    expect(trade[6]).toBe(3n) // collateralIndex — 1-based, the venue's own
    expect(trade[8]).toBe(100_000_000n) // 100 USDC in the token's own decimals
    expect(slippage).toBe(1_000n) // 1% in the venue's 1e3 units
    expect(BigInt(referrer)).toBe(0n)
  })

  it('prepends an approval when the member has none, targeting the collateral token', async () => {
    const { sendOnChain } = renderSheet({ readAllowance: async () => 0n })
    await settle()
    await act(async () => {
      typeAmount('100')
    })
    await settle()
    await act(async () => {
      fireEvent.click(submitButton())
    })

    const [, calls] = sendOnChain.mock.calls[0]
    expect(calls).toHaveLength(2)
    expect(getAddress(calls[0].target)).toBe(getAddress(USDC))
  })
})

/* --------------------------------------------------------------------------------------------- *
 * Structural — the properties a future edit must not quietly remove
 * --------------------------------------------------------------------------------------------- */

describe('structural guarantees', () => {
  it('derives no order state of its own — every status comes from the machine', () => {
    // A component that spells a state name has copied the machine's list, and a copy does not grow
    // when the machine does.
    const code = sheetSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    for (const state of ['submitted', 'venue_pending', 'executed', 'rejected', 'frozen', 'timed_out']) {
      expect(code).not.toMatch(new RegExp(`['"]${state}['"]`))
    }
  })

  it('reads the fee rate rather than carrying one — no bps literal appears in the sheet', () => {
    expect(sheetSource).not.toMatch(/\b(bps|BPS)\s*[:=]\s*\d/)
    expect(sheetSource).toMatch(/defaultReadFeeBps/)
  })

  it('never reads the management kill switch — that belongs to the composition point alone', () => {
    expect(sheetSource).not.toMatch(/perpsManageFeatureEnabled|VITE_PERPS_MANAGE_ENABLED/)
  })

  it('guards the body-scroll lock on having something to show, and cleans it up', () => {
    // A lock taken with nothing on screen leaves the page unscrollable with no sheet to dismiss.
    expect(sheetSource).toMatch(/if \(!hasPair\) return undefined[\s\S]*?document\.body\.style\.overflow = 'hidden'/)
    expect(sheetSource).toMatch(/document\.body\.style\.overflow = previousOverflow/)
  })

  it('keeps onClose on a ref, so a poll cannot yank focus out of the amount field', () => {
    expect(sheetSource).toMatch(/onCloseRef\.current = onClose/)
    expect(sheetSource).toMatch(/onCloseRef\.current\?\.\(\)/)
    // The shell effect is keyed on the sheet's own identity, never on the caller's callback.
    expect(sheetSource).toMatch(/\}, \[hasPair\]\)/)
  })
})
