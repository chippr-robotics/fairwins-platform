/**
 * useWrapCoinOptions (spec 108) — the Wrap picker's read layer.
 *
 * What is pinned: FAILURE ISOLATION and the null-is-not-zero rule. One chain whose read
 * fails must neither blank the list nor render as a zero balance, and its coin must stay
 * selectable — an unreachable RPC says nothing about what the member holds there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { ethers } from 'ethers'

const MORDOR = 63

const wallet = vi.hoisted(() => ({ current: {} }))
const active = vi.hoisted(() => ({ current: {} }))
const settledResults = vi.hoisted(() => ({ current: null }))
const readCalls = vi.hoisted(() => ({ current: [] }))

vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => wallet.current }))
vi.mock('../../hooks/useActiveAccount', () => ({ useActiveAccount: () => active.current }))
vi.mock('../../hooks/useRpcEndpoints', () => ({ useEndpointsRevision: () => 0 }))
vi.mock('../../utils/rpcProvider', () => ({
  getReadProvider: (chainId) => ({ chainId }),
}))
// The settled primitive itself is covered by its own suite; here it is mocked at its
// CONTRACT (per-index settled outcomes) so this hook's handling of each outcome is what
// gets tested.
vi.mock('../../lib/portfolio/batchBalances', () => ({
  readBalancesSettled: async (registry, providers, address) => {
    readCalls.current.push({ registry, providers, address })
    return registry.map(
      (asset, i) =>
        settledResults.current?.(asset, i) ?? {
          status: 'fulfilled',
          value: ethers.parseEther('2'),
        },
    )
  },
}))

const { useWrapCoinOptions } = await import('../../hooks/useWrapCoinOptions')
const { WRAP_DIRECTION } = await import('../../hooks/useWrapNative')
const { listWrappableCoins } = await import('../../config/wrappedNative')

beforeEach(() => {
  settledResults.current = null
  readCalls.current = []
  wallet.current = { address: '0xAaAa000000000000000000000000000000000001', chainId: MORDOR }
  active.current = { identity: { mode: 'personal' }, isVault: false, isLegacy: false, isHardware: false }
})

async function mounted(params) {
  const view = renderHook(() => useWrapCoinOptions(params))
  await waitFor(() => expect(view.result.current.options.some((o) => o.readState !== 'pending')).toBe(true))
  return view
}

describe('the candidate list', () => {
  it('offers exactly the wrappable cohort coins, defaulting to the connected chain', async () => {
    const { result } = await mounted()
    const expected = listWrappableCoins().map((c) => c.key)
    expect(result.current.options.map((o) => o.key)).toEqual(expected)
    expect(result.current.defaultKey).toBe(`native:${MORDOR}`)
  })

  it('reads through one spec-069 provider per candidate chain, for the acting address', async () => {
    await mounted()
    const call = readCalls.current[0]
    expect(call.address).toBe(wallet.current.address)
    for (const coin of listWrappableCoins()) {
      expect(call.providers.get(coin.chainId)).toEqual({ chainId: coin.chainId })
    }
  })

  it('reads the vault’s own balances while operating as one (spec 088 FR-001)', async () => {
    const vaultAddress = '0xBbBb000000000000000000000000000000000002'
    active.current = { ...active.current, isVault: true, identity: { mode: 'vault', vaultAddress } }
    await mounted()
    expect(readCalls.current[0].address).toBe(vaultAddress)
  })
})

describe('failure isolation — null is not zero', () => {
  it('a rejecting chain keeps its row unreadable and selectable; others read', async () => {
    const coins = listWrappableCoins()
    const darkChain = coins[0].chainId
    settledResults.current = (asset) =>
      asset.chainId === darkChain
        ? { status: 'rejected', reason: new Error('rpc down') }
        : { status: 'fulfilled', value: ethers.parseEther('3') }

    const { result } = await mounted()
    const dark = result.current.options.find((o) => o.chainId === darkChain)
    expect(dark.balance).toBeNull() // UNREAD — never '0'
    expect(dark.readState).toBe('unreadable')
    for (const o of result.current.options.filter((x) => x.chainId !== darkChain)) {
      expect(o.balance).toBe('3.0')
      expect(o.readState).toBe('read')
    }
  })

  it('never fabricates a zero anywhere on the null path', async () => {
    settledResults.current = () => ({ status: 'rejected', reason: new Error('all dark') })
    const { result } = await mounted()
    for (const o of result.current.options) {
      expect(o.balance).toBeNull()
      expect(o.readState).toBe('unreadable')
    }
  })
})

describe('direction', () => {
  it('the unwrap direction reads the WRAPPED leg and faces the wrapped symbol', async () => {
    const { result } = await mounted({ direction: WRAP_DIRECTION.UNWRAP })
    const call = readCalls.current[0]
    const coins = listWrappableCoins()
    call.registry.forEach((asset, i) => {
      expect(asset.kind).toBe('erc20')
      expect(asset.address).toBe(coins[i].wrapped.address)
    })
    const mordor = result.current.options.find((o) => o.chainId === MORDOR)
    expect(mordor.symbol).toBe(coins.find((c) => c.chainId === MORDOR).wrapped.symbol)
  })

  it('the wrap direction reads the native leg', async () => {
    await mounted({ direction: WRAP_DIRECTION.WRAP })
    for (const asset of readCalls.current[0].registry) expect(asset.kind).toBe('native')
  })
})
