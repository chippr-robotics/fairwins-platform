/**
 * Where is the wallet? (spec 110 Phase 3 — issue #1594, defect #1030, acceptance scenario 7)
 *
 * `useWalletChainId` is the only answer now that wagmi's `useChainId()` is banned, so the two
 * things it must never do are pinned here: report a CONFIGURED chain when the wallet is somewhere
 * else, and fall back to wagmi's default chain rather than the build's own.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAccount } from 'wagmi'
import { useWalletChainId } from '../../hooks/useWalletChainId'
import { useNetworkMode } from '../../hooks/useNetworkMode'
import { NETWORKS, getCurrentChainId } from '../../config/networks'

// Binance Smart Chain — deliberately NOT in `src/wagmi.js`'s `chains`, which is the whole point:
// this is the shape of chain that produced #1030.
const BNB = 56

const connectedOn = (chainId) =>
  useAccount.mockReturnValue({ address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', isConnected: true, chainId })

afterEach(() => {
  vi.unstubAllEnvs()
  useAccount.mockReturnValue({ address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', isConnected: true, chainId: 61 })
})

describe('useWalletChainId', () => {
  it('reports the chain the wallet is on, including one this build does not know', () => {
    expect(NETWORKS[BNB], 'the premise: BNB is absent from this build').toBeUndefined()
    connectedOn(BNB)
    expect(renderHook(() => useWalletChainId()).result.current).toBe(BNB)
  })

  it('reports a configured chain unchanged', () => {
    connectedOn(137)
    expect(renderHook(() => useWalletChainId()).result.current).toBe(137)
  })

  /*
   * THE FALLBACK IS THE BUILD'S, AND IT IS NOT wagmi's.
   *
   * This hook used to fall back to `useChainId()`, whose disconnected value is `chains[0]` =
   * Polygon — a MAINNET chain, in a TESTNET build too. That is the cohort-crossing answer
   * constitution III forbids, and it is why nine call sites that wrote an explicit
   * `useChainId() || getCurrentChainId()` never got the fallback they asked for.
   */
  it('falls back to the BUILD default when no wallet is connected, in a testnet build too', () => {
    vi.stubEnv('VITE_NETWORK_ID', '80002')
    useAccount.mockReturnValue({ address: undefined, isConnected: false, chainId: undefined })
    expect(getCurrentChainId(), 'the premise: this build is Amoy').toBe(80002)
    expect(renderHook(() => useWalletChainId()).result.current).toBe(80002)
  })
})

describe('acceptance scenario 7 — a wallet on a chain absent from this build', () => {
  it('names no network at all rather than naming one the wallet is not on', () => {
    connectedOn(BNB)
    const { network, chainId, mode, isMainnet, isTestnet } = renderHook(() => useNetworkMode()).result.current

    expect(chainId, 'the real chain, not a configured stand-in').toBe(BNB)
    // A STRICT lookup: `getNetwork()` would have answered with the home network here, which is
    // exactly how an unconfigured chain used to render as "Polygon".
    expect(network, 'no network object is invented for an unknown chain').toBeUndefined()
    expect(mode).toBe('other')
    expect(isMainnet).toBe(false)
    expect(isTestnet).toBe(false)
  })
})
