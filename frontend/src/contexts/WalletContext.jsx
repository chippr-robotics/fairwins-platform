import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain, useWalletClient } from 'wagmi'
import ConnectModal from '../components/wallet/ConnectModal'
import { ethers } from 'ethers'
import { isSupportedChainId, getNetwork, NETWORKS, PRIMARY_CHAIN_ID, cohortChainIds } from '../config/networks'
import { classifyEstateProbes } from '../lib/chains/estateSweep'
import { ChainSwitchRefused } from '../lib/chains/submitOn'
import { useWalletChainId } from '../hooks/useWalletChainId'
import { makeReadProvider } from '../utils/rpcProvider'
import {
  getUserRoles,
  addUserRole,
  removeUserRole
} from '../utils/roleStorage'
import { hasRoleOnChain } from '../utils/blockchainService'
import { WalletContext } from './WalletContext'
import { beginTx, publishLifecycle, failTx } from '../lib/passkey/txProgressBus'

/** Strict chain name — never `getNetwork()`, which names the DEFAULT network for an unknown id. */
const strictChainName = (id) => NETWORKS[Number(id)]?.name || `chain ${Number(id)}`

export function WalletProvider({ children }) {
  // Wagmi hooks for wallet connection
  const { address, isConnected, connector: activeConnector, status: accountStatus } = useAccount()
  const { connect, connectAsync, connectors } = useConnect()
  const { disconnect, disconnectAsync } = useDisconnect()
  // The WALLET's chain, never the one wagmi's config settled on (issue #1030). Identical to the
  // old `useChainId()` for every configured chain and for every passkey session; it differs only
  // when the wallet sits on a chain the app does not configure — the case this context has to be
  // able to SEE in order to correct it (auto-switch below) instead of silently reading and
  // displaying a different network.
  const chainId = useWalletChainId()
  const { switchChain, switchChainAsync } = useSwitchChain()
  const { data: walletClient } = useWalletClient()

  // Connector-backed write transport for classic wallets only. Passkey sessions never
  // hydrate an injected BrowserProvider/signer here: reads go through `readProvider`
  // and writes go through `sendCalls`.
  const [provider, setProvider] = useState(null)
  const [signer, setSigner] = useState(null)
  
  // Network state
  const [networkError, setNetworkError] = useState(null)
  
  // Balances (cached)
  const [balances, setBalances] = useState({
    native: '0',
    wnative: '0',
    tokens: {} // For other ERC20 tokens
  })
  const [balancesLoading, setBalancesLoading] = useState(false)
  
  // RVAC roles integrated with wallet
  const [roles, setRoles] = useState([])
  const [rolesLoading, setRolesLoading] = useState(false)
  const [blockchainSynced, setBlockchainSynced] = useState(false)
  // Spec 071: WHERE each role was found, and which chains would not answer. `roles` above stays
  // the flat estate-wide list every existing caller reads; these two carry the detail the
  // operations control plane needs to be honest about what it actually learned.
  const [roleChains, setRoleChains] = useState({})
  const [estateRead, setEstateRead] = useState({
    read: [],
    notDeployed: [],
    unreadable: [],
    swept: false,
  })
  // FR-004: false ⇒ membership is UNKNOWN (the reference chain would not answer), which is
  // never the same as "no membership". Surfaces so a gated action can attribute its refusal.
  const [membershipReadable, setMembershipReadable] = useState(true)

  // ---- Spec 045: single connect surface (FR-001) ----
  // Every "Connect" control in the app opens THIS modal; no surface renders
  // its own connector list. `connectInFlightRef` serializes attempts (FR-004):
  // at most one user-initiated connect flow at a time.
  const [isConnectModalOpen, setIsConnectModalOpen] = useState(false)
  const connectInFlightRef = useRef(null)
  const openConnectModal = useCallback(() => setIsConnectModalOpen(true), [])
  const closeConnectModal = useCallback(() => setIsConnectModalOpen(false), [])

  // ---- Spec 041: unified login-method + capability surface (FR-002) ----
  // `loginMethod` is INFORMATIONAL ONLY (signing ceremony differs); identity,
  // gating, and screening always key off `address` — no feature may branch on
  // it for authorization.
  const loginMethod = useMemo(() => {
    if (!isConnected || !activeConnector) return null
    if (activeConnector.id === 'fairwinsPasskey' || activeConnector.type === 'passkey') return 'passkey'
    if (activeConnector.id === 'walletConnect') return 'walletconnect'
    return 'injected'
  }, [isConnected, activeConnector])
  // Reads follow the wallet's own chain. On an unsupported one `getNetwork` falls back to the
  // home network by design — which is now a DISCLOSED fallback rather than a silent misdirection,
  // because the auto-switch below is simultaneously asking the member to move there. Deliberately
  // not nulled: a null provider would leave `balances.native` at its '0' initial value, and a
  // fabricated zero balance is worse than the home chain's real one.
  const readProvider = useMemo(() => {
    const net = getNetwork(chainId)
    const rpcProvider = net?.rpcUrl ? makeReadProvider(net.rpcUrl, chainId) : null
    return loginMethod === 'passkey' ? (rpcProvider || provider) : (provider || rpcProvider)
  }, [chainId, loginMethod, provider])

  // Encryption capability for the FR-012 degradation UI. Classic wallets keep
  // the legacy signature-derived path (always available); passkey sessions
  // resolve through the PRF pipeline lazily (state refined by usePasskeyAccount
  // /account-management surfaces as ceremonies happen).
  const [accountCapabilities, setAccountCapabilities] = useState({ encryption: 'available' })
  useEffect(() => {
    let cancelled = false
    async function resolveCapabilities() {
      if (!isConnected) return setAccountCapabilities({ encryption: 'available' })
      if (loginMethod !== 'passkey') return setAccountCapabilities({ encryption: 'available' })
      try {
        const [{ capability }, { knownCredentials }] = await Promise.all([
          import('../lib/passkey/prfKeys'),
          import('../lib/passkey/credentials'),
        ])
        const cred = knownCredentials().find((c) => c.address?.toLowerCase() === address?.toLowerCase())
        const out = capability({
          account: address,
          credentialId: cred?.credentialId,
          prfCapable: cred?.prfCapable ?? false,
        })
        if (!cancelled) setAccountCapabilities({ encryption: out.state, encryptionReason: out.reason })
      } catch {
        if (!cancelled) {
          setAccountCapabilities({
            encryption: 'unavailable',
            encryptionReason: 'Encrypted-feature capability could not be determined on this device.',
          })
        }
      }
    }
    resolveCapabilities()
    return () => {
      cancelled = true
    }
  }, [isConnected, loginMethod, address])

  /**
   * Unified write abstraction (spec 041): batched calls in one confirmation.
   * - Passkey sessions: fulfilled by the smart-account layer (viem-first) via
   *   the submission router — ONE ceremony covers the whole batch (FR-016).
   * - Classic wallets: sequential signer transactions (existing behavior,
   *   unchanged for existing users — SC-004).
   * Each call: { target, data, value? }.
   *
   * `chainId` option: pins the batch to a NAMED chain instead of the session's current one. A
   * UserOp is chain-targeted by parameter, and a caller whose batch is only correct on one chain
   * (Predict approvals → Polygon) must say so — the session's chain state is React state, so a
   * just-completed switchChain is not yet visible to the closures already running.
   *
   * A CLASSIC WALLET CANNOT BE PINNED, SO IT REFUSES (spec 110 T028). An injected signer
   * broadcasts on whatever network the wallet is on, and this used to IGNORE the option there —
   * a caller that named a chain got its batch sent on a different one, silently, which is the
   * defect T026 closed in `submitAsActiveAccount`'s personal branch. Nothing passes `chainId` on
   * this path today (the two callers that pass it are on the passkey rail), so refusing costs
   * nothing now and converts a silent wrong-chain send into a stated refusal later.
   *
   * It refuses rather than switching ON PURPOSE. `sendCalls` is the SUBMISSION primitive;
   * `lib/chains/submitOn.js#settleWalletOn` is the chain-landing primitive, and composing them is
   * the caller's job — which is exactly what `useEarnSend.sendOnChain` and `useWrapNative` already
   * do. Switching from in here would inject a wallet prompt into a path that has never prompted.
   */
  const sendCalls = useCallback(
    async (calls, { onState, chainId: chainOverride } = {}) => {
      if (!calls?.length) throw new Error('sendCalls: empty batch')
      if (loginMethod === 'passkey') {
        const batchChainId = chainOverride ?? chainId
        const [{ sendPasskeyBatch }, { readSession }] = await Promise.all([
          import('../lib/passkey/sendBatch'),
          import('../connectors/passkey'),
        ])
        // Publish the honest lifecycle to the global progress overlay so EVERY
        // passkey write (transfer, vouchers, wagers, tokens, swap, DAO, custody)
        // shows a signature → submission → confirmation walk-through instead of a
        // frozen "Sending…". The caller's own `onState` (if any) still fires — the
        // bus is additive, and a broken listener never breaks the batch.
        beginTx({ chainId: batchChainId })
        const observe = (s) => {
          try {
            publishLifecycle(s)
          } catch {
            /* progress is best-effort */
          }
          try {
            onState?.(s)
          } catch {
            /* caller observer must not break submission */
          }
        }
        try {
          // Pin the ceremony to the credential this session signed in with —
          // never a different passkey that happens to share the address book
          // (spec 045 US3/FR-008).
          return await sendPasskeyBatch({
            chainId: batchChainId,
            address,
            calls,
            credentialId: readSession()?.credentialId,
            onState: observe,
          })
        } catch (err) {
          // A throw (revert surfaced, or no submission path) never reaches the
          // lifecycle observer — reflect it so the overlay shows the failure
          // instead of vanishing mid-flight.
          failTx(err?.shortMessage || err?.message || 'Transaction failed.')
          throw err
        }
      }
      if (!signer) throw new Error('No signer available')
      if (chainOverride != null && Number(chainOverride) !== Number(chainId)) {
        throw new ChainSwitchRefused(
          `This goes to ${strictChainName(chainOverride)}, but the wallet is on ${strictChainName(chainId)} ` +
            `and a connected wallet sends on the network it is on. Switch it there first — nothing has been sent.`,
          { from: Number(chainId), to: Number(chainOverride) },
        )
      }
      const receipts = []
      for (const c of calls) {
        const tx = await signer.sendTransaction({ to: c.target ?? c.to, data: c.data, value: c.value ?? 0n })
        receipts.push(await tx.wait())
      }
      return { route: 'direct', receipts, txHash: receipts.at(-1)?.hash }
    },
    [loginMethod, chainId, address, signer]
  )

  // Update provider and signer when connection changes
  // Use wagmi's walletClient for proper authorization
  useEffect(() => {
    let cancelled = false
    const updateProviderAndSigner = async () => {
      if (loginMethod === 'passkey') {
        if (cancelled) return
        setProvider(null)
        setSigner(null)
        return
      }
      if (isConnected && walletClient) {
        try {
          // Create provider from walletClient's transport for proper authorization
          // This ensures the signer is authorized for the connected account
          const ethersProvider = new ethers.BrowserProvider(walletClient.transport, {
            chainId: walletClient.chain?.id,
            name: walletClient.chain?.name || 'Unknown'
          })

          // Build the signer directly for the account wagmi already authorized, instead
          // of `ethersProvider.getSigner(address)` — ethers v6's BrowserProvider.getSigner()
          // issues its own `eth_requestAccounts` round-trip to re-verify authorization. That
          // round-trip fires every time this effect re-runs (e.g. right after the auto
          // chain-switch below changes `walletClient`), and MetaMask can surface it as a
          // fresh permission prompt even though the account is already connected. A tester
          // rejecting that redundant prompt threw here, which nulled out a signer that was
          // already valid — breaking every signer-dependent action (encryption key backup/
          // registration included) while the wallet still showed "connected".
          const ethersSigner = new ethers.JsonRpcSigner(ethersProvider, walletClient.account.address)
          if (cancelled) return
          setProvider(ethersProvider)
          setSigner(ethersSigner)
          console.log('[WalletContext] Signer created for:', walletClient.account.address)
        } catch (error) {
          if (cancelled) return
          console.error('Error creating provider/signer from walletClient:', error)

          // Fallback to window.ethereum if walletClient approach fails
          if (typeof window !== 'undefined' && window.ethereum) {
            try {
              const fallbackProvider = new ethers.BrowserProvider(window.ethereum)
              const fallbackSigner = await fallbackProvider.getSigner()
              if (cancelled) return
              setProvider(fallbackProvider)
              setSigner(fallbackSigner)
              console.log('[WalletContext] Using fallback signer')
            } catch (fallbackError) {
              if (cancelled) return
              console.error('Fallback signer creation also failed:', fallbackError)
              setProvider(null)
              setSigner(null)
            }
          } else {
            setProvider(null)
            setSigner(null)
          }
        }
      } else if (isConnected && typeof window !== 'undefined' && window.ethereum) {
        // If walletClient is not available yet, try window.ethereum directly
        try {
          const ethersProvider = new ethers.BrowserProvider(window.ethereum)
          const ethersSigner = await ethersProvider.getSigner()
          if (cancelled) return
          setProvider(ethersProvider)
          setSigner(ethersSigner)
          console.log('[WalletContext] Signer created from window.ethereum')
        } catch (error) {
          if (cancelled) return
          console.error('Error creating provider/signer:', error)
          setProvider(null)
          setSigner(null)
        }
      } else {
        setProvider(null)
        setSigner(null)
      }
    }

    updateProviderAndSigner()
    return () => { cancelled = true }
    // Keyed on the wallet's own address/chain rather than the `walletClient` object
    // itself: wagmi hands back a new `walletClient` reference on unrelated refetches
    // (balance polls, focus revalidation, ...), and re-running this effect for no
    // semantic change was what made the redundant getSigner() re-authorization above
    // fire so often in the first place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, walletClient?.account?.address, walletClient?.chain?.id, loginMethod])

  // Auto-switch to Polygon (PRIMARY_CHAIN_ID) when the wallet connects on an
  // unsupported chain. If the switch fails, show a network error instead.
  //
  // This is unchanged in intent — it just finally RUNS. `chainId` used to come from wagmi's
  // config state, which can only ever hold a configured chain, and every configured chain is
  // also a NETWORKS key, so `isSupportedChainId(chainId)` was unconditionally true and both the
  // switch and the banner were dead code (issue #1030).
  //
  // The passkey rail is untouched by this: its connector reports only ids drawn from
  // `config.chains`, so it takes the `isSupportedChainId` early return exactly as before and
  // never reaches the switch.
  //
  // `autoSwitchedFrom` makes the attempt at-most-once per chain the wallet lands on. Without it
  // this effect is one unstable `switchChain` identity away from prompting the member in a loop,
  // and under StrictMode's double-invoked effects it would raise two wallet prompts for one
  // arrival. Cleared as soon as the wallet is on a supported chain, so a member who wanders back
  // onto an unsupported one is offered the switch again.
  const autoSwitchedFrom = useRef(null)
  useEffect(() => {
    if (!isConnected) {
      autoSwitchedFrom.current = null
      setNetworkError(null)
      return
    }
    if (isSupportedChainId(chainId)) {
      autoSwitchedFrom.current = null
      setNetworkError(null)
      return
    }
    if (autoSwitchedFrom.current === chainId) return
    autoSwitchedFrom.current = chainId
    // Wallet is on an unsupported chain — try switching automatically
    switchChain(
      { chainId: PRIMARY_CHAIN_ID },
      {
        onError: () => {
          const primary = getNetwork(PRIMARY_CHAIN_ID)
          setNetworkError(
            `Please switch to ${primary?.name || 'Polygon'} in your wallet.`
          )
        },
      }
    )
  }, [chainId, isConnected, switchChain])

  // Clear stale WalletConnect data once reconnect has SETTLED and nothing is
  // connected. This prevents "failed to process inbound message" errors from
  // stale sessions. It must not run at mount: wagmi's eager reconnect may
  // still be restoring a WalletConnect session, and deleting relay data mid-
  // restore breaks it (spec 045 FR-004 — background restore is never raced).
  const wcCleanupDoneRef = useRef(false)
  useEffect(() => {
    if (wcCleanupDoneRef.current) return
    if (accountStatus === 'connecting' || accountStatus === 'reconnecting') return
    wcCleanupDoneRef.current = true
    if (accountStatus === 'disconnected') {
      try {
        const keysToRemove = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          // Only clear WalletConnect message/pairing data, not session data
          // This allows reconnection while clearing stale relay messages
          if (key && (key.startsWith('wc@2:core:') || key.includes(':messages:'))) {
            keysToRemove.push(key)
          }
        }
        if (keysToRemove.length > 0) {
          keysToRemove.forEach(key => localStorage.removeItem(key))
          console.log('[WalletContext] Cleared stale WalletConnect data')
        }
      } catch {
        // Silently ignore cleanup errors
      }
    }
  }, [accountStatus])

  /**
   * Sync local roles with blockchain state
   * If a role exists on-chain but not locally, add it
   * If a role exists locally but not on-chain, remove it (expired)
   */
  const syncRolesWithBlockchain = useCallback(async (walletAddress, localRoles, activeChainId) => {
    const premiumRoles = ['WAGER_PARTICIPANT']
    // STAKING_ADMIN was missing from this list while being present in ADMIN_ROLES and in the
    // console's nav, so a staking administrator's role was never synced: `isStakingAdmin` read
    // false forever and the Staking tab never opened for the one operator who could use it.
    // Exactly the class of lockout spec 071 exists to end, so it is fixed here.
    const adminRoles = [
      'ADMIN', 'GUARDIAN', 'ACCOUNT_MODERATOR', 'ROLE_MANAGER',
      'SANCTIONS_ADMIN', 'FEE_ADMIN', 'STAKING_ADMIN', 'LIQUIDITY_ADMIN',
    ]
    const allSyncedRoles = [...premiumRoles, ...adminRoles]

    // ── ESTATE-WIDE, NOT WALLET-CHAIN (spec 071 FR-009) ───────────────────────────────────────
    // Admin roles are granted per contract per chain, so asking only the chain the wallet
    // happens to sit on refused entry to operators who genuinely hold a role somewhere else.
    // Reads span the cohort; the wallet's chain still decides nothing but WRITES.
    const chains = cohortChainIds()
    const walletChainFirst = [
      ...chains.filter((id) => Number(id) === Number(activeChainId)),
      ...chains.filter((id) => Number(id) !== Number(activeChainId)),
    ]

    // Concurrent: 8 roles across the cohort is far too many round-trips to do in sequence, and
    // FR-015 says one slow chain must not hold up the rest.
    const probes = await Promise.all(
      adminRoles.flatMap((roleName) =>
        walletChainFirst.map(async (id) => {
          try {
            const r = await hasRoleOnChain(walletAddress, roleName, id, { detailed: true })
            return {
              roleName,
              chainId: id,
              held: Boolean(r?.held),
              readable: r?.readable !== false,
              // Carried through, not derived: only `hasRoleOnChain` knows whether there was a
              // contract to ask. Dropping it here is what let a chain with nothing deployed
              // count as a chain that answered.
              deployed: r?.deployed !== false,
            }
          } catch (e) {
            // A thrown probe reached for something and failed — an outage, not an absence.
            return { roleName, chainId: id, held: false, readable: false, deployed: true, reason: e?.message }
          }
        }),
      ),
    )

    // Membership resolves on the REFERENCE chain regardless of what is passed (spec 071 FR-003) —
    // `hasRoleOnChain` enforces that internally, so the wallet's chain is irrelevant here.
    //
    // `membershipReadable === false` means UNKNOWN, not "none" (FR-004). A member whose reference
    // chain blipped keeps whatever was cached rather than being told they own nothing, and the
    // unknown is surfaced so a gated action can attribute its refusal to the failed read.
    let membershipHeld
    let membershipReadable
    try {
      const r = await hasRoleOnChain(walletAddress, 'WAGER_PARTICIPANT', activeChainId, { detailed: true })
      membershipReadable = r?.readable !== false
      membershipHeld = membershipReadable ? Boolean(r?.held) : localRoles.includes('WAGER_PARTICIPANT')
    } catch {
      membershipReadable = false
      membershipHeld = localRoles.includes('WAGER_PARTICIPANT')
    }

    // WHERE each role was found. A role with an empty list is not held anywhere we could read.
    const foundOn = {}
    for (const p of probes) {
      if (p.held) (foundOn[p.roleName] ||= []).push(p.chainId)
    }
    // Three states, never two (spec 071 FR-011): a chain answered, a chain has nothing deployed
    // to answer with, or a chain would not answer. `classifyEstateProbes` decides on the probes
    // that actually had a contract to read — a chain carrying none of the operator contracts
    // settles from the address book and must not be counted as having answered.
    const {
      read: readChains,
      notDeployed: notDeployedChains,
      unreadable: unreadableChains,
    } = classifyEstateProbes(probes, walletChainFirst)

    const updatedRoles = [
      ...(membershipHeld ? ['WAGER_PARTICIPANT'] : []),
      ...adminRoles.filter((r) => (foundOn[r] || []).length > 0),
    ]

    // Local storage stays keyed by (address, chainId) exactly as before — the chain dimension
    // was already there, so an estate-wide sweep just writes entries for more chains and needs
    // NO migration. Each role is recorded against the chain it was actually found on.
    let hasChanges = false
    for (const roleName of adminRoles) {
      for (const id of foundOn[roleName] || []) {
        addUserRole(walletAddress, roleName, id)
        hasChanges = true
      }
    }
    // Only prune against the wallet's chain, and only when that chain answered: removing a
    // locally-cached role because some other chain said no would be a different bug. Membership
    // is pruned only when the REFERENCE chain actually answered — never on an unknown.
    if (!unreadableChains.includes(activeChainId)) {
      for (const roleName of allSyncedRoles) {
        if (roleName === 'WAGER_PARTICIPANT' && !membershipReadable) continue
        const heldHere =
          roleName === 'WAGER_PARTICIPANT'
            ? membershipHeld
            : (foundOn[roleName] || []).some((id) => Number(id) === Number(activeChainId))
        if (!heldHere && localRoles.includes(roleName)) {
          removeUserRole(walletAddress, roleName, activeChainId)
          hasChanges = true
        }
      }
    }

    // Anything cached locally that this sweep doesn't manage is left alone.
    for (const role of localRoles) {
      if (!allSyncedRoles.includes(role) && !updatedRoles.includes(role)) updatedRoles.push(role)
    }

    return {
      roles: updatedRoles,
      hasChanges,
      errors: [],
      roleChains: foundOn,
      estateRead: {
        read: readChains,
        notDeployed: notDeployedChains,
        unreadable: unreadableChains,
        swept: true,
      },
      membershipReadable,
    }
  }, [])

  /**
   * Load roles from both localStorage and blockchain
   * Blockchain is the source of truth for premium roles
   */
  const loadRoles = useCallback(async (walletAddress, activeChainId) => {
    setRolesLoading(true)
    setBlockchainSynced(false)
    try {
      // First load from local storage (immediate response), scoped to the chain
      const localRoles = getUserRoles(walletAddress, activeChainId)
      setRoles(localRoles)

      // Then sweep the estate (authoritative source). `roles` is the flat estate-wide answer;
      // roleChains/estateRead carry where each was found and which chains would not answer.
      const synced = await syncRolesWithBlockchain(walletAddress, localRoles, activeChainId)
      setRoles(synced.roles)
      setRoleChains(synced.roleChains || {})
      setEstateRead(
        synced.estateRead || { read: [], notDeployed: [], unreadable: [], swept: true },
      )
      setMembershipReadable(synced.membershipReadable !== false)
      setBlockchainSynced(true)
    } catch (error) {
      console.error('Error loading user roles:', error)
      setRoles([])
      setRoleChains({})
      setMembershipReadable(false)
      // A failed sweep is NOT "you hold nothing" — leave it unswept so the console can say so
      // rather than asserting a denial it never established (FR-012).
      setEstateRead({ read: [], notDeployed: [], unreadable: [], swept: false })
    } finally {
      setRolesLoading(false)
    }
  }, [syncRolesWithBlockchain])

  /**
   * Manually refresh roles from blockchain
   * Call this to get fresh role data from the chain
   */
  const refreshRoles = useCallback(async () => {
    if (!address) return
    await loadRoles(address, chainId)
  }, [address, chainId, loadRoles])

  // Fetch wallet balances
  const fetchBalances = useCallback(async (walletAddress) => {
    if (!readProvider || !walletAddress) return
    
    setBalancesLoading(true)
    try {
      // Get native token balance
      const nativeBalance = await readProvider.getBalance(walletAddress)

      setBalances(prev => ({
        ...prev,
        native: ethers.formatEther(nativeBalance)
      }))
    } catch (error) {
      console.error('Error fetching balances:', error)
    } finally {
      setBalancesLoading(false)
    }
  }, [readProvider])

  // Load RVAC roles when the wallet connects or the active network changes.
  // Membership (the paid WAGER_PARTICIPANT role) lives in a per-chain
  // MembershipManager, so a testnet ↔ mainnet switch must re-query the chain
  // — otherwise a testnet membership would appear active on mainnet where it
  // doesn't exist. chainId is included in the deps to force that re-query.
  useEffect(() => {
    if (isConnected && address) {
      loadRoles(address, chainId)
      fetchBalances(address)
    } else {
      setRoles([])
      setBalances({ native: '0', wnative: '0', tokens: {} })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, isConnected, chainId])

  // Refresh balances manually
  const refreshBalances = useCallback(() => {
    if (address) {
      return fetchBalances(address)
    }
  }, [address, fetchBalances])

  // Get balance for specific token
  const getTokenBalance = useCallback(async (tokenAddress) => {
    if (!provider || !address) {
      throw new Error('Wallet not connected')
    }

    try {
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function balanceOf(address) view returns (uint256)'],
        provider
      )
      const balance = await tokenContract.balanceOf(address)
      const formatted = ethers.formatEther(balance)
      
      // Cache the balance
      setBalances(prev => ({
        ...prev,
        tokens: {
          ...prev.tokens,
          [tokenAddress]: formatted
        }
      }))
      
      return formatted
    } catch (error) {
      console.error('Error getting token balance:', error)
      throw error
    }
  }, [provider, address])

  // Connect wallet (spec 045 FR-001/FR-004).
  // - No connectorId: open the unified connect modal so the USER chooses —
  //   the old behavior silently defaulted to the injected wallet, which made
  //   passkey unreachable from those call sites.
  // - With connectorId: serialized — a second attempt while one is pending is
  //   refused with visible feedback instead of racing it.
  // - `opts` (e.g. { credentialId, mode } for the passkey account picker) is
  //   forwarded to the connector.
  const connectWallet = useCallback(async (connectorId, opts) => {
    if (!connectorId) {
      openConnectModal()
      return true
    }
    if (connectInFlightRef.current) {
      throw new Error('A connection attempt is already in progress — finish or cancel it first.')
    }
    connectInFlightRef.current = connectorId
    try {
      const connector = connectors.find(c => c.id === connectorId)
      if (!connector) {
        throw new Error('No wallet connector available')
      }

      // connectAsync resolves/rejects with the real outcome (plain `connect`
      // is fire-and-forget), which the in-flight guard and the connect
      // modal's error display both depend on. Fallback keeps older test
      // doubles that only stub `connect` working.
      await (connectAsync ?? connect)({ connector, ...(opts || {}) })
      return true
    } catch (error) {
      console.error('Error connecting wallet:', error)

      // Check for user rejection
      if (error.code === 4001 || error.name === 'UserRejectedRequestError') {
        throw new Error('Please approve the connection request', { cause: error })
      }
      throw error
    } finally {
      connectInFlightRef.current = null
    }
  }, [connect, connectAsync, connectors, openConnectModal])

  // Disconnect wallet
  const disconnectWallet = useCallback(async () => {
    // Grab the provider we are signing out of BEFORE the teardown: afterwards there is no
    // connection left to ask, and it is what scopes the shim flags written at the end.
    const activeProvider = await Promise.resolve()
      .then(() => activeConnector?.getProvider?.())
      .catch(() => undefined)

    // Await the real outcome where wagmi offers it: the shim flags written below must land
    // AFTER wagmi has finished tearing the connection down, or the teardown overwrites them.
    if (disconnectAsync) await disconnectAsync().catch(() => {})
    else disconnect()
    setRoles([])
    setBalances({ native: '0', wnative: '0', tokens: {} })

    // Clear wagmi and WalletConnect persistence from storage
    try {
      // List of known wagmi storage keys to clear
      const wagmiKeys = [
        'wagmi.store',
        'wagmi.cache',
        'wagmi.wallet',
        'wagmi.connected',
        'wagmi.recentConnectorId',
      ]

      // Clear from both localStorage and sessionStorage
      wagmiKeys.forEach(key => {
        localStorage.removeItem(key)
        sessionStorage.removeItem(key)
      })

      // Clear WalletConnect v2 storage to prevent stale relay message errors
      // WalletConnect stores data under keys starting with "wc@2:"
      const keysToRemove = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith('wc@2:')) {
          keysToRemove.push(key)
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key))

      // Spec 041 FR-003: sign-out clears the passkey session atomically too.
      // (Credential bookkeeping and wrapped key blobs stay — they are not
      // session state; the passkey itself lives in the platform authenticator.)
      localStorage.removeItem('fairwins.passkey.session.v1')
    } catch (error) {
      console.error('Error clearing wallet persistence:', error)
    }

    /*
     * TELL THE WALLET'S OTHER CONNECTOR IT IS DISCONNECTED TOO.
     *
     * wagmi's `shimDisconnect` flag is PER CONNECTOR — `wagmi.<connector id>.disconnected` — and
     * this app reaches one browser wallet through TWO connectors: the targetless `injected()`
     * configured in wagmi.js, and the one wagmi discovers for the same wallet over EIP-6963.
     * Disconnecting flags only the connector the member happened to connect through. On the next
     * load `reconnect()` walks the remaining connectors, finds the sibling pointed at the very
     * same provider with no flag of its own and a non-empty `eth_accounts`, and reconnects — so a
     * member who signs out and refreshes is silently signed back in. Measured; WAL-05 asserts it.
     *
     * (wagmi's own dedupe does not save us: reconnect() records a provider as "already checked"
     * only for connectors that CONNECTED, so a connector that declined on isAuthorized() leaves
     * its provider open for the next one to try.)
     *
     * Scoped BY PROVIDER IDENTITY, not to every injected connector. A member with two wallets
     * installed has an announced connector for each, and signing out of one is not consent to
     * revoke this site's permissions on the other — `disconnect()` asks the wallet to do exactly
     * that (`wallet_revokePermissions`, MIP-2). Only connectors backed by the very provider the
     * member was connected through are told anything.
     */
    if (activeProvider) {
      await Promise.all(
        (connectors || [])
          .filter((c) => c?.type === 'injected')
          .map((c) => Promise.resolve()
            .then(() => c.getProvider?.())
            .then((p) => (p && p === activeProvider ? c.disconnect?.() : undefined))
            .catch(() => { /* connector already gone; its flag is moot */ }))
      )
    }
  }, [disconnect, disconnectAsync, connectors, activeConnector])

  // Switch to the configured primary network (Polygon Amoy). Invoked from
  // the network-error banner / "Switch Network" button when the user is on
  // an unsupported chain.
  // `targetChainId` defaults to the app's home network, so every existing call site is
  // unchanged. Spec 071 needs an explicit target: a membership purchase must settle on the
  // REFERENCE chain (FR-006), which is not necessarily where the app happens to be homed.
  const switchNetwork = useCallback(async (targetChainId = PRIMARY_CHAIN_ID) => {
    const target = Number(targetChainId) || PRIMARY_CHAIN_ID
    try {
      // The ASYNC mutate, awaited: the old `switchChain` (mutate) resolved immediately, so every
      // `await switchNetwork(...)` in the app returned BEFORE the wallet had changed chains, a
      // user rejection never rejected, and tx buttons raced the switch (spec 088 finding).
      await switchChainAsync({ chainId: target })
      return true
    } catch (error) {
      console.error('Error switching network:', error)
      const targetNet = getNetwork(target)
      throw new Error(`Please manually switch to ${targetNet?.name || `chain ${target}`} in your wallet`, { cause: error })
    }
  }, [switchChainAsync])

  // Send transaction helper
  const sendTransaction = useCallback(async (transactionRequest) => {
    if (!signer) {
      throw new Error('Wallet not connected')
    }

    try {
      const tx = await signer.sendTransaction(transactionRequest)
      return tx
    } catch (error) {
      console.error('Error sending transaction:', error)
      throw error
    }
  }, [signer])

  // Sign message
  const signMessage = useCallback(async (message) => {
    if (!signer) {
      throw new Error('Wallet not connected')
    }

    try {
      const signature = await signer.signMessage(message)
      return signature
    } catch (error) {
      console.error('Error signing message:', error)
      throw error
    }
  }, [signer])

  // RVAC Role management
  // Use the synced `roles` state as source of truth (blockchain is authoritative)
  const hasRole = useCallback((role) => {
    if (!address) return false
    // Check the synced roles state instead of localStorage
    // This ensures we reflect the actual on-chain state
    return roles.includes(role)
  }, [address, roles])

  const hasAnyRole = useCallback((rolesToCheck) => {
    if (!address || !Array.isArray(rolesToCheck)) return false
    return rolesToCheck.some(role => roles.includes(role))
  }, [address, roles])

  const hasAllRoles = useCallback((rolesToCheck) => {
    if (!address || !Array.isArray(rolesToCheck)) return false
    return rolesToCheck.every(role => roles.includes(role))
  }, [address, roles])

  /**
   * Which cohort chains this account holds `role` on. Empty ⇒ not held anywhere readable.
   *
   * Entry to the console is the estate-wide question (`hasRole` above — "you hold something
   * somewhere"). This is the narrower one, for surfaces that need to say WHERE. Neither is
   * authority to write: that is still read from the specific contract on the scoped chain
   * (`lib/chains/estate.js#readAuthority`), because holding GUARDIAN on the WagerRegistry is
   * not holding it on the BridgeRouter.
   */
  const chainsForRole = useCallback((role) => roleChains[role] || [], [roleChains])

  /** Does this account hold `role` on this specific chain? */
  const hasRoleOnChainId = useCallback(
    (role, id) => (roleChains[role] || []).some((c) => Number(c) === Number(id)),
    [roleChains],
  )

  const grantRole = useCallback((role) => {
    if (!address) {
      throw new Error('Cannot grant role: no wallet connected')
    }

    try {
      addUserRole(address, role, chainId)
      const updatedRoles = getUserRoles(address, chainId)
      setRoles(updatedRoles)
      return true
    } catch (error) {
      console.error('Error granting role:', error)
      return false
    }
  }, [address, chainId])

  const revokeRole = useCallback((role) => {
    if (!address) {
      throw new Error('Cannot revoke role: no wallet connected')
    }

    try {
      removeUserRole(address, role, chainId)
      const updatedRoles = getUserRoles(address, chainId)
      setRoles(updatedRoles)
      return true
    } catch (error) {
      console.error('Error revoking role:', error)
      return false
    }
  }, [address, chainId])

  // Computed values. "Correct" here means a supported chain (Polygon Amoy
  // or local Hardhat). Per-chain feature gates (e.g. polymarketSidebets) are
  // enforced via the capabilities map in networks.js.
  const isCorrectNetwork = useMemo(
    () => isConnected && isSupportedChainId(chainId),
    [isConnected, chainId]
  )

  const value = {
    // Wallet state
    address,
    account: address, // Alias for backwards compatibility
    isConnected,
    // wagmi's raw account status ('connecting' | 'reconnecting' | 'connected' |
    // 'disconnected'). Surfaces that act on "definitely signed out" — the
    // auto-connect prompt, the landing forward — must wait for it to SETTLE so
    // they never race the eager reconnect of a stored session (spec 045 FR-004).
    connectionStatus: accountStatus,
    chainId,

    // Available connectors
    connectors,
    
    // Expose the unified read transport here: passkey sessions get direct RPC reads,
    // while classic wallets keep their connector-backed provider (with RPC fallback).
    provider: readProvider,
    signer,
    
    // Network state
    networkError,
    isCorrectNetwork,
    
    // Balances
    balances,
    balancesLoading,
    
    // RVAC roles
    roles,
    rolesLoading,
    blockchainSynced,
    refreshRoles,

    // Wallet actions
    connectWallet,
    disconnectWallet,
    switchNetwork,

    // Spec 045: unified connect surface
    isConnectModalOpen,
    openConnectModal,
    closeConnectModal,
    
    // Transaction methods
    sendTransaction,
    signMessage,
    sendCalls,

    // Spec 041: unified login surface (informational only — never authz)
    loginMethod,
    accountCapabilities,
    
    // Balance methods
    refreshBalances,
    getTokenBalance,
    
    // RVAC role methods
    hasRole,
    hasAnyRole,
    hasAllRoles,
    // Spec 071: where roles were found, and what the sweep could actually read.
    roleChains,
    estateRead,
    chainsForRole,
    hasRoleOnChainId,
    membershipReadable,
    grantRole,
    revokeRole,
  }

  return (
    <WalletContext.Provider value={value}>
      {children}
      {/* Spec 045: the ONE connect surface, mounted once for the whole app. */}
      <ConnectModal />
    </WalletContext.Provider>
  )
}
