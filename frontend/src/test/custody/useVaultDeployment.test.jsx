// Spec 105 (T-007) — the orchestrator hook. The refusing paths are the feature: a rail that
// cannot act fails the row with ITS reason and attempts nothing; a refused wallet switch fails
// only that network naming both chains; an occupied address is ALREADY-LIVE, not a failure; and
// re-derived statuses come from the chain, with a failed read as UNREADABLE.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

let walletCtx
vi.mock('../../hooks', () => ({ useWallet: () => walletCtx }))

let railImpl
vi.mock('../../lib/chains/writeRail', () => ({
  RAILS: { SIGNER: 'signer', PASSKEY: 'passkey', NONE: 'none' },
  resolveWriteRail: (args) => railImpl(args),
}))

const providers = {}
vi.mock('../../utils/blockchainService', () => ({
  getProvider: (chainId) => providers[Number(chainId)],
}))

vi.mock('../../lib/custody/vaultAddressBook', () => ({ ensureVaultContact: vi.fn() }))

import useVaultDeployment from '../../hooks/useVaultDeployment'
import { DEPLOY_STATUS } from '../../lib/custody/vaultDeployment'

const ME = '0x1111111111111111111111111111111111111111'
const CO = '0x2222222222222222222222222222222222222222'

// A minimal abi-encoded `bytes` return for proxyCreationCode(): offset 0x20, length 2, bytes 0xdead.
const CREATION_CODE_RET =
  '0x' + '20'.padStart(64, '0') + '2'.padStart(64, '0') + 'dead'.padEnd(64, '0')

function fakeProvider({ code = '0x', codeError = false } = {}) {
  return {
    call: vi.fn().mockResolvedValue(CREATION_CODE_RET),
    getCode: codeError ? vi.fn().mockRejectedValue(new Error('rpc down')) : vi.fn().mockResolvedValue(code),
  }
}

function fakeSigner(chainId) {
  return {
    chainId,
    sendTransaction: vi.fn().mockResolvedValue({ hash: '0xhash', wait: vi.fn().mockResolvedValue({ status: 1 }) }),
  }
}

beforeEach(() => {
  localStorage.clear()
  providers[137] = fakeProvider()
  providers[8453] = fakeProvider()
  railImpl = () => ({ available: true, rail: 'signer' })
  walletCtx = {
    address: ME,
    chainId: 137,
    signer: fakeSigner(137),
    loginMethod: 'browser',
    sendCalls: vi.fn(),
    switchNetwork: vi.fn().mockImplementation(async (target) => {
      walletCtx.chainId = Number(target)
    }),
  }
})

const startArgs = (over = {}) => ({
  owners: [ME, CO],
  threshold: 1,
  saltNonce: 7,
  presetType: 'joint',
  semanticRules: null,
  chainIds: [137],
  ...over,
})

describe('useVaultDeployment', () => {
  it('deploys on the connected chain and records the reference + creation record', async () => {
    const { result } = renderHook(() => useVaultDeployment())
    await act(async () => {
      await result.current.start(startArgs())
    })
    expect(walletCtx.signer.sendTransaction).toHaveBeenCalledTimes(1)
    expect(result.current.byChain[137].status).toBe(DEPLOY_STATUS.LIVE)
    expect(result.current.predictedAddress).toMatch(/^0x/)
    expect(result.current.hasRecordFor(result.current.predictedAddress)).toBe(true)
  })

  it('an unavailable rail fails the row with ITS reason and signs nothing', async () => {
    railImpl = () => ({ available: false, reason: 'Connect a wallet that can sign on Ethereum Classic.' })
    const { result } = renderHook(() => useVaultDeployment())
    await act(async () => {
      await result.current.start(startArgs())
    })
    expect(result.current.byChain[137].status).toBe(DEPLOY_STATUS.FAILED)
    expect(result.current.byChain[137].reason).toMatch(/connect a wallet/i)
    expect(walletCtx.signer.sendTransaction).not.toHaveBeenCalled()
  })

  it('a refused switch fails ONLY that network, naming both chains, and the other proceeds', async () => {
    walletCtx.switchNetwork = vi.fn().mockRejectedValue(new Error('user refused'))
    const { result } = renderHook(() => useVaultDeployment())
    await act(async () => {
      await result.current.start(startArgs({ chainIds: [137, 8453] }))
    })
    expect(result.current.byChain[137].status).toBe(DEPLOY_STATUS.LIVE) // wallet already there
    expect(result.current.byChain[8453].status).toBe(DEPLOY_STATUS.FAILED)
    expect(result.current.byChain[8453].stage).toBe('switch')
    // Spec 110 T026 — one shared settle loop, so one refusal sentence. What is asserted is the
    // PROPERTY the row needs (both chains named, and that nothing was signed), not the particular
    // phrasing this hook's retired copy happened to use.
    expect(result.current.byChain[8453].reason).toMatch(/Base/)
    expect(result.current.byChain[8453].reason).toMatch(/Polygon/)
    expect(result.current.byChain[8453].reason).toMatch(/nothing has been signed/i)
  })

  it('an occupied address is ALREADY LIVE — success, nothing sent there (FR-019)', async () => {
    providers[137] = fakeProvider({ code: '0x6080' })
    const { result } = renderHook(() => useVaultDeployment())
    await act(async () => {
      await result.current.start(startArgs())
    })
    expect(result.current.byChain[137].status).toBe(DEPLOY_STATUS.ALREADY_LIVE)
    expect(walletCtx.signer.sendTransaction).not.toHaveBeenCalled()
  })

  it('the passkey rail sends ONE batch — deploy + every install call, each ADDRESSED (issue #1452)', async () => {
    railImpl = () => ({ available: true, rail: 'passkey' })
    walletCtx.loginMethod = 'passkey'
    walletCtx.signer = null
    walletCtx.sendCalls = vi.fn().mockResolvedValue({ txHash: '0xbatch' })
    const { result } = renderHook(() => useVaultDeployment())
    await act(async () => {
      await result.current.start(
        startArgs({
          threshold: 2,
          semanticRules: { dailyCapAmount: '500', cooldownSeconds: 3600, allowedMoney: 'stable', bigSends: 'everyone' },
        }),
      )
    })
    expect(walletCtx.sendCalls).toHaveBeenCalledTimes(1)
    const [calls, opts] = walletCtx.sendCalls.mock.calls[0]
    expect(opts).toMatchObject({ chainId: 137 })
    // create + (hub emit + approveHash) × 2 install steps — the CREATE2 address is known before
    // deployment, which is what makes one batch possible at all.
    expect(calls).toHaveLength(5)
    for (const call of calls) {
      // The propose-mode plan once leaked {target:undefined} into this batch (emitProposalCall's
      // own shape vs the plan's) — every entry must be a real address, on this rail too.
      expect(call.target).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
    expect(result.current.byChain[137].status).toBe(DEPLOY_STATUS.LIVE)
    expect(result.current.byChain[137].rulesStatus).toBe('awaiting-approval')
  })

  it('refreshStatuses derives truth from the chain; a failed read is UNREADABLE, never absence', async () => {
    providers[137] = fakeProvider({ code: '0x6080' })
    providers[8453] = fakeProvider({ codeError: true })
    const { result } = renderHook(() => useVaultDeployment())
    await act(async () => {
      await result.current.refreshStatuses(ME, [137, 8453])
    })
    await waitFor(() => {
      expect(result.current.byChain[137].status).toBe(DEPLOY_STATUS.LIVE)
      expect(result.current.byChain[8453].status).toBe(DEPLOY_STATUS.UNREADABLE)
    })
  })
})
