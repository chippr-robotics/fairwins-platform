/**
 * FeesTab WCAG 2.1 AA audit (spec 060) — the unified fee screen with tables,
 * forms, and history must pass axe in its loaded state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { ethers } from 'ethers'

const m = vi.hoisted(() => ({ routerAddr: null, reads: {}, logs: [] }))

vi.mock('../config/contracts', () => ({
  getContractAddressForChain: vi.fn(() => m.routerAddr),
}))
vi.mock('../hooks/useGatewayStatus', () => ({ gatewayBaseUrl: () => '' }))
vi.mock('../config/blockExplorer', () => ({
  getBlockscoutUrl: () => 'https://explorer.example/address/0xrouter',
}))
// Every read the tab makes goes through the chain seam (spec 110). The `vi.mock('ethers')` this
// replaced intercepted nothing once FeesTab stopped constructing a Contract — the retired-mock
// shape `src/test/lint/ethersMockRatchet.test.js` exists to catch, and did catch, here.
vi.mock('../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (_chainId, { functionName, args = [] }) => {
      const f = m.reads[functionName]
      if (!f) throw new Error('unmocked contract method: ' + functionName)
      return f(...args)
    },
  }
})

vi.mock('../lib/chains/eventScan', () => ({
  eventScanHandle: (_chainId, { address }) => ({
    target: address,
    provider: {
      getBlockNumber: async () => 100,
      getLogs: async () => m.logs,
    },
    filters: { FeeBpsChanged: () => ({ getTopicFilter: () => ['0xfeebps'] }) },
    interface: { parseLog: (log) => ({ name: 'FeeBpsChanged', args: log.args }) },
  }),
}))

vi.mock('../lib/chains/publicClient', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    getPublicClient: () => ({ getBlock: async () => ({ timestamp: 1_752_800_000n }) }),
  }
})

import FeesTab from '../components/admin/FeesTab'

const EARN_LEND = ethers.id('earn.lend')

beforeEach(() => {
  m.routerAddr = '0x00000000000000000000000000000000000000f1'
  m.reads = {
    serviceCount: async () => 1n,
    serviceAt: async () => EARN_LEND,
    getService: async () => ({ capBps: 250n, feeBps: 50n, kind: 1n }),
    treasury: async () => '0x1111111111111111111111111111111111111111',
    MAX_WRAPPED_FEE_BPS: async () => 250n,
  }
  m.logs = [
    {
      args: { serviceId: EARN_LEND, oldBps: 0n, newBps: 50n, actor: '0x1111111111111111111111111111111111111111' },
      blockNumber: 1,
      transactionHash: '0xabc',
    },
  ]
})

describe('FeesTab accessibility', () => {
  it('has no WCAG 2.1 AA violations in the loaded state (tables + forms + history)', async () => {
    const { container } = render(
      <FeesTab
        signer={{}}
        chainId={137}
        provider={{ isReadProvider: true }}
        runTx={vi.fn()}
        pendingTx={false}
        isAdmin
        isFeeAdmin
      />,
    )
    await screen.findAllByText(/earn — vault lending/i)
    await screen.findByText('0 → 50 bps')
    expect(await axe(container)).toHaveNoViolations()
  })
})
