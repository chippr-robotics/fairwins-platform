/**
 * PerpsFeesPanel WCAG 2.1 AA audit (spec 083 US5).
 *
 * Both states are audited, because they render different things and the second is the one an
 * operator meets when something is wrong: the loaded panel with its one form, and the panel whose
 * dangerous control has been REFUSED (the form replaced by an alert). An inaccessible refusal is a
 * refusal nobody reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'

import { GMX_ADDRESSES_BY_CHAIN } from '../../config/perps'
import { GMX_MAX_UI_FEE_FACTOR_KEY } from '../../lib/perps/feeUnits'

const GMX_CHAIN = 42161
const GMX = GMX_ADDRESSES_BY_CHAIN[GMX_CHAIN]
const RECEIVER = '0x52502d049571C7893447b86c4d8B38e6184bF6e1'
const OTHER_WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const m = vi.hoisted(() => ({ receiver: '0x52502d049571C7893447b86c4d8B38e6184bF6e1' }))

vi.mock('../../config/perps', async (orig) => {
  const real = await orig()
  return {
    ...real,
    perpsCohortSupported: () => true,
    perpsManageFeatureEnabled: () => false,
    perpsUiFeeReceiver: () => m.receiver,
  }
})

vi.mock('../../config/contracts', async (orig) => {
  const real = await orig()
  return {
    ...real,
    getContractAddressForChain: () => '0x00000000000000000000000000000000000000f1',
  }
})

vi.mock('../../lib/chains/estate', async (orig) => {
  const real = await orig()
  return { ...real, readProviderFor: () => ({ isReadProvider: true }) }
})

// Both rails read through the chain seam (spec 110). `capBps`/`feeBps`/`kind` come back as NUMBERS
// rather than bigints — they are uint16/uint8, and viem decodes integers of 48 bits or fewer as
// numbers (divergence b) — so the fake answers what the chain now answers.
vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (_chainId, { address, functionName, args = [] }) => {
      if (functionName === 'getUint') {
        if (String(address).toLowerCase() !== GMX.dataStore.toLowerCase()) {
          throw new Error('getUint asked of something other than the GMX DataStore')
        }
        return args[0] === GMX_MAX_UI_FEE_FACTOR_KEY ? 10n ** 27n : 5n * 10n ** 26n
      }
      if (functionName === 'getService') return { capBps: 10, feeBps: 0, kind: 2 }
      throw new Error('unmocked read: ' + functionName)
    },
  }
})

import PerpsFeesPanel from '../../components/admin/PerpsFeesPanel'

beforeEach(() => {
  m.receiver = RECEIVER
})

describe('PerpsFeesPanel accessibility', () => {
  it('has no WCAG 2.1 AA violations with both rails loaded and the control offered', async () => {
    const { container } = render(
      <PerpsFeesPanel
        signer={{ isSigner: true }}
        account={RECEIVER}
        chainId={GMX_CHAIN}
        provider={null}
        runTx={vi.fn()}
        pendingTx={false}
        onOpenFees={vi.fn()}
      />,
    )
    await screen.findByText(/5 bps \(0\.05%\) of notional/)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no violations when the dangerous control is refused', async () => {
    const { container } = render(
      <PerpsFeesPanel
        signer={{ isSigner: true }}
        account={OTHER_WALLET}
        chainId={GMX_CHAIN}
        provider={null}
        runTx={vi.fn()}
        pendingTx={false}
        onOpenFees={null}
      />,
    )
    await screen.findByText(/This wallet cannot change the GMX UI fee/)
    expect(await axe(container)).toHaveNoViolations()
  })
})
