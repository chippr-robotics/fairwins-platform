import { useAccount } from 'wagmi'

/**
 * Put the mocked wallet on a chain (spec 110 Phase 3 — issue #1594).
 *
 * Suites used to steer the app with `useChainId.mockReturnValue(x)`. That hook is banned in
 * shipped code — it reads wagmi's CONFIGURED chain, which is the #1030 defect — and the global
 * wagmi mock no longer provides it, so a fixture steering it would be steering something nothing
 * reads. The chain is a property of the CONNECTION now, so this sets it there.
 *
 * It MERGES into whatever the suite has already configured on `useAccount`, so a test that set
 * its own address or `isConnected` keeps them.
 */
export function setWalletChain(chainId) {
  const current = useAccount() || {}
  useAccount.mockReturnValue({ ...current, chainId })
}

export default setWalletChain
