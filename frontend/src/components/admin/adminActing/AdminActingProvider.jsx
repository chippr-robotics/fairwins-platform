/**
 * AdminActingProvider — lets the operations console act AS the admin Safe, signed by one of its
 * owners' keys (the connected wallet, or a Ledger/Trezor reached directly).
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────────────────────────
 * Every operator role on the live estate is held by a 2-of-3 Safe (`deployments/admin-safe.json`).
 * The console asked only "what does the CONNECTED WALLET hold?" and sent every write FROM it, so an
 * owner connecting their Ledger was refused entry ("Access Restricted" — the Ledger itself holds
 * nothing), and had they got in, every write would have reverted on a missing role. There was no
 * way to propose, see, approve or execute an admin action from here at all.
 *
 * ── WHAT THIS DOES ──────────────────────────────────────────────────────────────────────────────
 * It separates two things the console had fused:
 *
 *   ACTING ACCOUNT — whose authority is used: the Safe, or the signing key itself. Role flags,
 *     per-contract authority reads and "this account" labels all follow it (via `useAdminWeb3`).
 *   OWNER KEY — who signs: the connected wallet, or a saved Protect ▸ Off chain hardware account
 *     (spec 085), re-derived on the device and bound to the wallet's current chain.
 *
 * When the acting account is a Safe, the signer handed to the console is a PROPOSING signer
 * (`lib/admin/safeProposingSigner.js`): each write is simulated from the Safe, published to the
 * SafeProposalHub and approved by this owner — never executed in one step, because the Safe needs
 * a second owner. The queue (`useVaultProposals`, the same hook Protect uses) is where the second
 * owner approves and anyone executes.
 *
 * Reads follow the spec-071 rules: the Safe's facts are `read` / `unreadable` / `not-a-safe`,
 * never a fabricated "0 of 0"; the role sweep is three-state per chain, and an unswept read is
 * "could not verify", never "you hold nothing".
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useWeb3 } from '../../../hooks/useWeb3'
import { useVaultProposals } from '../../../hooks/useVaultProposals'
import { readContract } from '../../../lib/chains/readContract'
import { getPublicClient } from '../../../lib/chains/publicClient'
import { SAFE_ABI } from '../../../abis/Safe'
import { getContractAddressForChain } from '../../../config/contracts'
import { getSafeContracts } from '../../../config/safeContracts'
import { sweepAdminRoles } from '../../../lib/admin/adminRoleSweep'
import { createSafeProposingSigner, nextFreeNonce } from '../../../lib/admin/safeProposingSigner'
import { connectHardwareAccount } from '../../../lib/hardware/connectAccount'
import {
  loadHardwareAccounts,
  subscribeHardwareAccounts,
  getHardwareAccountsRevision,
} from '../../../lib/hardware/hardwareAccountsStore'
import { AdminActingContext } from './AdminActingContext'
import {
  subscribeAdminActing,
  getAdminActing,
  setAdminSafe,
  setAdminHardwareSigner,
} from './adminActingStore'

const lower = (a) => String(a || '').toLowerCase()

/** `${safe}:${chainId}` → { nonce, previous } — the last nonce this browser reserved there, and the
 *  reservation it replaced (so a failed proposal can hand its nonce back). */
const RESERVED_NONCES = new Map()

/** The Safe's facts on one chain, three-state. `value` exists only when `state === 'read'`. */
async function readSafeFacts(safeAddress, chainId, owner) {
  try {
    const ask = (functionName, args = []) =>
      readContract(chainId, { address: safeAddress, abi: SAFE_ABI, functionName, args })
    const [owners, threshold, nonce] = await Promise.all([ask('getOwners'), ask('getThreshold'), ask('nonce')])
    const ownerList = (owners || []).map(String)
    return {
      state: 'read',
      value: {
        owners: ownerList,
        threshold: Number(threshold),
        nonce: BigInt(nonce),
        isOwner: owner ? ownerList.some((o) => lower(o) === lower(owner)) : false,
      },
    }
  } catch (err) {
    // A failed read is only "not a Safe" when the chain positively says there is no code there.
    try {
      const code = await getPublicClient(chainId).getCode({ address: safeAddress })
      if (!code || code === '0x') return { state: 'not-a-safe', reason: 'No contract at this address on this network.' }
    } catch {
      /* the code read failed too — that is unreadable, not absent */
    }
    return { state: 'unreadable', reason: err?.shortMessage || err?.message || 'The Safe could not be read.' }
  }
}

export default function AdminActingProvider({ children }) {
  const web3 = useWeb3()
  const { account: walletAccount, signer: walletSigner } = web3
  // NAMED, not inherited by habit (adminEstateGuard): every Safe action lands where the owner key
  // signs, which is the wallet's chain — the Safe tx hash is chain-scoped, so an approval made on
  // one network approves nothing on another. The admin views already require the wallet to be on
  // their scoped chain before they write, so this is the same chain they name.
  const writeChainId = web3.chainId ?? null
  const chainId = writeChainId
  const { safeAddress, hardwareSigner } = useSyncExternalStore(subscribeAdminActing, getAdminActing, getAdminActing)

  // An identity must not carry across accounts: a device session opened under one login is
  // dropped (and its transport closed) when the login changes.
  const prevAccount = useRef(walletAccount)
  useEffect(() => {
    if (prevAccount.current !== walletAccount) {
      prevAccount.current = walletAccount
      setAdminHardwareSigner(null)
    }
  }, [walletAccount])

  // Saved hardware accounts live under the member's own account (spec 085 store).
  const hwRevision = useSyncExternalStore(subscribeHardwareAccounts, getHardwareAccountsRevision, getHardwareAccountsRevision)
  const hardwareEntries = useMemo(
    () => (walletAccount ? Object.values(loadHardwareAccounts(walletAccount)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [walletAccount, hwRevision],
  )

  // The owner key, bound to the chain the wallet is on (that is where every write lands).
  const ownerSigner = useMemo(() => {
    if (!hardwareSigner) return walletSigner ?? null
    if (chainId == null) return null
    return Number(hardwareSigner.chainId) === Number(chainId) ? hardwareSigner : hardwareSigner.connect({ chainId })
  }, [hardwareSigner, walletSigner, chainId])
  const ownerAddress = hardwareSigner ? hardwareSigner.address : walletAccount ?? null
  const ownerSource = hardwareSigner ? 'hardware' : 'wallet'

  const actingAccount = safeAddress ?? ownerAddress
  const actingDiffers = Boolean(actingAccount) && lower(actingAccount) !== lower(walletAccount)

  // ── The Safe's facts on the wallet's chain ──────────────────────────────────────────────────
  const [safeFacts, setSafeFacts] = useState({ state: 'idle' })
  const [factsRev, setFactsRev] = useState(0)
  useEffect(() => {
    let cancelled = false
    if (!safeAddress || chainId == null) {
      setSafeFacts({ state: 'idle' })
      return undefined
    }
    setSafeFacts({ state: 'loading' })
    readSafeFacts(safeAddress, chainId, ownerAddress).then((r) => {
      if (!cancelled) setSafeFacts(r)
    })
    return () => {
      cancelled = true
    }
  }, [safeAddress, chainId, ownerAddress, factsRev])

  // ── Roles of the acting account, when it is not the wallet ─────────────────────────────────
  const [roleSweep, setRoleSweep] = useState(null)
  const [sweepRev, setSweepRev] = useState(0)
  useEffect(() => {
    let cancelled = false
    if (!actingDiffers) {
      setRoleSweep(null)
      return undefined
    }
    setRoleSweep({ roles: [], roleChains: {}, estateRead: { read: [], notDeployed: [], unreadable: [], swept: false }, loading: true })
    sweepAdminRoles(actingAccount, { firstChainId: chainId }).then((r) => {
      if (!cancelled) setRoleSweep({ ...r, loading: false })
    })
    return () => {
      cancelled = true
    }
  }, [actingDiffers, actingAccount, chainId, sweepRev])
  const retrySweep = useCallback(() => setSweepRev((n) => n + 1), [])

  // ── The Safe's queue, approved with the owner key ──────────────────────────────────────────
  const vault = useMemo(
    () => (safeAddress && chainId != null ? { isSafe: true, address: safeAddress, chainId: Number(chainId) } : null),
    [safeAddress, chainId],
  )
  const proposals = useVaultProposals(vault, { signer: ownerSigner })
  const { queue, refresh: refreshQueue } = proposals

  // Nonces this session has handed out, so two proposals in a row never share one. Kept per
  // (Safe, chain) at module scope: a remount between two proposals must not forget the first.
  const reserveNonce = useCallback(async () => {
    const key = `${lower(safeAddress)}:${chainId}`
    const onchainNonce = await readContract(chainId, { address: safeAddress, abi: SAFE_ABI, functionName: 'nonce' })
    const next = nextFreeNonce({
      onchainNonce,
      queuedNonces: (queue || []).map((p) => p.nonce).filter((n) => n != null),
      lastReserved: RESERVED_NONCES.get(key)?.nonce ?? null,
    })
    RESERVED_NONCES.set(key, { nonce: next, previous: RESERVED_NONCES.get(key) ?? null })
    return next
  }, [chainId, safeAddress, queue])

  const releaseNonce = useCallback(
    (nonce) => {
      const key = `${lower(safeAddress)}:${chainId}`
      const held = RESERVED_NONCES.get(key)
      // Only undo the reservation that is still the latest; a later one already moved past it.
      if (held && BigInt(held.nonce) === BigInt(nonce)) {
        if (held.previous) RESERVED_NONCES.set(key, held.previous)
        else RESERVED_NONCES.delete(key)
      }
    },
    [chainId, safeAddress],
  )

  const simulate = useCallback(
    ({ from, to, data, value }) => getPublicClient(chainId).call({ account: from, to, data, value }),
    [chainId],
  )

  const [proposalStep, setProposalStep] = useState(null)
  const actingSigner = useMemo(() => {
    if (!safeAddress) return ownerSigner
    if (!ownerSigner || chainId == null) return null
    return createSafeProposingSigner({
      safeAddress,
      chainId: Number(chainId),
      ownerSigner,
      hubAddress: getContractAddressForChain('safeProposalHub', writeChainId),
      safeContracts: getSafeContracts(chainId),
      reserveNonce,
      releaseNonce,
      simulate,
      onStep: setProposalStep,
      onProposed: () => {
        setProposalStep(null)
        refreshQueue?.()
        setFactsRev((n) => n + 1)
      },
    })
  }, [safeAddress, ownerSigner, chainId, reserveNonce, releaseNonce, simulate, refreshQueue])

  // ── Device connection ──────────────────────────────────────────────────────────────────────
  const [deviceState, setDeviceState] = useState({ status: 'idle', error: null })
  const connectDevice = useCallback(
    async (entry) => {
      setDeviceState({ status: 'connecting', error: null })
      try {
        const signer = await connectHardwareAccount({ entry, chainId })
        setAdminHardwareSigner(signer)
        setDeviceState({ status: 'idle', error: null })
        return true
      } catch (err) {
        setDeviceState({ status: 'idle', error: err })
        return false
      }
    },
    [chainId],
  )
  const disconnectDevice = useCallback(() => {
    setAdminHardwareSigner(null)
    setDeviceState({ status: 'idle', error: null })
  }, [])

  const value = useMemo(
    () => ({
      mode: safeAddress ? 'safe' : 'self',
      safeAddress,
      setSafe: setAdminSafe,
      clearSafe: () => setAdminSafe(null),
      safeFacts,
      refreshSafe: () => setFactsRev((n) => n + 1),
      ownerSigner,
      ownerAddress,
      ownerSource,
      hardwareEntries,
      deviceState,
      connectDevice,
      disconnectDevice,
      actingAccount,
      actingSigner,
      roleSweep: actingDiffers ? roleSweep : null,
      retrySweep,
      proposals,
      proposalStep,
      chainId,
    }),
    [
      safeAddress, safeFacts, ownerSigner, ownerAddress, ownerSource, hardwareEntries, deviceState,
      connectDevice, disconnectDevice, actingAccount, actingSigner, actingDiffers, roleSweep, retrySweep,
      proposals, proposalStep, chainId,
    ],
  )

  return <AdminActingContext.Provider value={value}>{children}</AdminActingContext.Provider>
}
