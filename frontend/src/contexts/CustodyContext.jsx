// Spec 043 (US3) — the active-identity provider. A member operates either as their personal wallet (default)
// or "as" one of their vaults / recovered accounts / hardware accounts. This is a per-session choice (not
// persisted) and always resets to personal when the connected account changes. Authorization still keys off
// the connected wallet address; the active identity only changes where prepared actions are *sent*.
//
// Spec 088 — switching is ADDRESS-ONLY and instant: choosing a recovered or hardware account
// takes effect immediately with no unlock or device ceremony (the public address is enough to
// view, receive, and navigate as the account). The ceremony is DEFERRED to the moment a
// signature is actually needed: `requestActingSigner()` parks the caller on a promise, the
// globally-mounted SignerRequestHost renders the right dialog (passphrase/biometric unlock, or
// device connect), and `attachActingSigner` resolves the send and caches the signer for the
// session. Cancelling the dialog rejects the pending action — never a silent hang.
//
// Spec 102 (D6, FR-013) — acting as a vault binds to the ADDRESS. `active.chainIds` is every chain
// the vault exists on at switch time; `active.chainId` is the wallet's chain when the vault has an
// instance there, else the vault's pinned chain. A wallet chain change re-evaluates that with no
// prompt: it follows the wallet where the vault exists, and holds the pin where it does not (so a
// send auto-switches back — useActiveAccount). Consumers that read `active.chainId` keep working.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useWallet } from '../hooks'
import { CustodyContext } from './CustodyContext'
import { pickVaultChain } from '../lib/custody/vaultGroups'

export function CustodyProvider({ children }) {
  const { address, chainId: walletChainId } = useWallet()
  const [active, setActive] = useState({ mode: 'personal' })
  // Spec 062: when a recovered legacy account HAS been unlocked, the ethers signer lives here in
  // MEMORY ONLY — never persisted, never serialized, cleared on any identity change. It is the
  // private-key material, so it must not leak.
  const [legacySigner, setLegacySigner] = useState(null)
  // Spec 085: the device-backed signer lives here the same way. It holds no key material (the
  // device does), but it wraps a live transport session, so it is session-scoped and cleared on
  // any identity change just like the legacy signer — and the underlying transport is CLOSED
  // when the signer is dropped, or the device stays claimed and unreachable for other
  // tabs/tools until unplug.
  const [hardwareSigner, setHardwareSignerState] = useState(null)
  const setHardwareSigner = useCallback((next) => {
    setHardwareSignerState((prev) => {
      if (prev && prev !== next) {
        try {
          prev.session?.close?.()?.catch?.(() => {})
        } catch {
          /* releasing a dead transport must never break an identity switch */
        }
      }
      return next
    })
  }, [])
  const prevAddress = useRef(address)

  // Spec 088 — the deferred-signing broker. `signerRequest` drives the global SignerRequestHost;
  // the pending promise lives in a ref (it is imperative state, not render state).
  const [signerRequest, setSignerRequest] = useState(null) // { mode: 'legacy'|'hardware', address }
  const pendingRef = useRef(null)
  // Mirror of `active` for the imperative broker paths (requestActingSigner is called from event
  // handlers, always after commit, so the post-render sync is safe).
  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  const settlePending = useCallback((fn) => {
    const pending = pendingRef.current
    pendingRef.current = null
    setSignerRequest(null)
    if (pending) fn(pending)
  }, [])

  const cancelSignerRequest = useCallback(
    (reason) => settlePending((p) => p.reject(reason instanceof Error ? reason : new Error(reason || 'Signing was cancelled.'))),
    [settlePending],
  )

  // Reset to the personal wallet whenever the connected account actually changes or disconnects. This is a
  // deliberate external-sync effect (identity must not carry across accounts); guarded by a ref so it only
  // fires on a real change.
  useEffect(() => {
    if (prevAddress.current !== address) {
      prevAddress.current = address
      setActive({ mode: 'personal' })
      setLegacySigner(null) // drop the in-memory legacy key on account change
      setHardwareSigner(null) // and the device-backed session
      cancelSignerRequest('The connected account changed.')
    }
  }, [address, setHardwareSigner, cancelSignerRequest])

  /**
   * Operate as a vault. `chainIds` is every chain the vault is on; it defaults to `[chainId]` so
   * the single-chain callers (VaultActionSheet, TransferForm's picker) keep working unchanged.
   * The resolved `chainId` prefers an explicit `chainId` the vault is on, then the wallet's chain,
   * then the first instance (`pickVaultChain`).
   */
  const operateAsVault = useCallback((vault) => {
    if (!vault?.address) return
    const chainIds = (Array.isArray(vault.chainIds) && vault.chainIds.length > 0
      ? vault.chainIds
      : vault.chainId != null
        ? [vault.chainId]
        : []
    ).map(Number).filter(Number.isFinite)
    if (chainIds.length === 0) return
    setLegacySigner(null)
    setHardwareSigner(null)
    cancelSignerRequest('The acting account changed.')
    setActive({
      mode: 'vault',
      vaultAddress: vault.address,
      chainIds,
      chainId: pickVaultChain({ chainIds, walletChainId, preferred: vault.chainId }),
      label: vault.label || '',
    })
  }, [setHardwareSigner, cancelSignerRequest, walletChainId])

  // Spec 102 FR-013 — the acting vault follows the wallet's chain where it EXISTS there, and holds
  // its pin otherwise. Functional update + identity return so a no-op change re-renders nothing.
  useEffect(() => {
    const wallet = Number(walletChainId)
    if (!Number.isFinite(wallet)) return
    setActive((a) =>
      a.mode === 'vault' && Array.isArray(a.chainIds) && a.chainIds.includes(wallet) && a.chainId !== wallet
        ? { ...a, chainId: wallet }
        : a,
    )
  }, [walletChainId])

  const operateAsPersonal = useCallback(() => {
    setLegacySigner(null)
    setHardwareSigner(null)
    cancelSignerRequest('The acting account changed.')
    setActive({ mode: 'personal' })
  }, [setHardwareSigner, cancelSignerRequest])

  // Operate as a recovered legacy account — ADDRESS-ONLY (spec 088). The signer is optional:
  // passing one (e.g. right after an explicit unlock in Recovery) pre-fills the session; without
  // one the identity still switches, and the first signature runs the deferred ceremony.
  const operateAsLegacy = useCallback((descriptor) => {
    if (!descriptor?.address) return
    setLegacySigner(descriptor.signer ?? null)
    setHardwareSigner(null)
    cancelSignerRequest('The acting account changed.')
    setActive({
      mode: 'legacy',
      address: descriptor.address,
      // The chain binding belongs to the SIGNER, not the identity: it is set when a signer is
      // attached (unlock binds a provider), and undefined while browsing address-only.
      chainId: descriptor.signer && descriptor.chainId != null ? Number(descriptor.chainId) : undefined,
      kind: descriptor.kind || 'privateKey',
      label: descriptor.label || '',
    })
  }, [setHardwareSigner, cancelSignerRequest])

  // Spec 085/088 — operate as a saved hardware account, address-only. Every signature is
  // confirmed on the device's own screen when it actually happens.
  const operateAsHardware = useCallback((descriptor) => {
    if (!descriptor?.address) return
    setLegacySigner(null)
    setHardwareSigner(descriptor.signer ?? null)
    cancelSignerRequest('The acting account changed.')
    setActive({
      mode: 'hardware',
      address: descriptor.address,
      chainId: descriptor.signer && descriptor.chainId != null ? Number(descriptor.chainId) : undefined,
      vendor: descriptor.vendor || null,
      label: descriptor.label || '',
    })
  }, [setHardwareSigner, cancelSignerRequest])

  /**
   * Spec 088 — ask the member for the acting account's signer (unlock / device connect),
   * via the globally-mounted SignerRequestHost. Resolves with the signer; rejects if the
   * member cancels. Concurrent callers share one ceremony.
   */
  const requestActingSigner = useCallback(() => {
    const current = activeRef.current
    if (current.mode !== 'legacy' && current.mode !== 'hardware') {
      return Promise.reject(new Error('This account needs no unlock ceremony.'))
    }
    if (pendingRef.current) return pendingRef.current.promise
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    pendingRef.current = { promise, resolve, reject }
    setSignerRequest({ mode: current.mode, address: current.address })
    return promise
  }, [])

  /** The ceremony completed: cache the signer, bind its chain, resolve the pending action. */
  const attachActingSigner = useCallback(
    (signer, chainId) => {
      const mode = activeRef.current.mode
      if (mode === 'legacy') setLegacySigner(signer)
      else if (mode === 'hardware') setHardwareSigner(signer)
      setActive((a) => ({ ...a, chainId: chainId != null ? Number(chainId) : a.chainId }))
      settlePending((p) => p.resolve(signer))
    },
    [setHardwareSigner, settlePending],
  )

  /** Drop a stale signer (e.g. bound to a network the wallet has left) so the next action re-runs the ceremony. */
  const dropActingSigner = useCallback(() => {
    setLegacySigner(null)
    setHardwareSigner(null)
    setActive((a) => (a.mode === 'legacy' || a.mode === 'hardware' ? { ...a, chainId: undefined } : a))
  }, [setHardwareSigner])

  const value = useMemo(
    () => ({
      active,
      legacySigner,
      hardwareSigner,
      operateAsVault,
      operateAsPersonal,
      operateAsLegacy,
      operateAsHardware,
      signerRequest,
      requestActingSigner,
      attachActingSigner,
      cancelSignerRequest,
      dropActingSigner,
    }),
    [active, legacySigner, hardwareSigner, operateAsVault, operateAsPersonal, operateAsLegacy, operateAsHardware, signerRequest, requestActingSigner, attachActingSigner, cancelSignerRequest, dropActingSigner],
  )

  return <CustodyContext.Provider value={value}>{children}</CustodyContext.Provider>
}

export default CustodyProvider
