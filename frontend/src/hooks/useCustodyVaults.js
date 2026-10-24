// Spec 043 — vault list + create/load orchestration for the Custody On chain section (US1). Reads the
// member's saved vault references, enriches each with live on-chain state, and exposes create/load actions
// that persist a reference. Honest state: on-chain reads are the source of truth; references are just labels.
//
// Spec 068 (US1) makes the list MULTI-CHAIN: every saved vault is listed with its own chain identity
// regardless of which network the wallet is on, each enriched through a read provider for ITS chain.
// Enrichment failures are isolated per vault — one unreachable network must never blank the list —
// and `onVaultChain` gates every state-changing action so nothing can be submitted to the wrong chain.
//
// Spec 102 — a vault is an ADDRESS. `vaults` stays the per-chain instance list (the policy panels and
// propose/approve still need instances), and `groups` is the one-card-per-address view over it
// (`lib/custody/vaultGroups`). Loading an address adds EVERY network it is a Safe on; forgetting a
// vault forgets every network; the member is never asked to pick a chain.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useWallet } from '.'
import { isCustodySupported, CUSTODY_SUPPORTED_CHAIN_IDS } from '../config/safeContracts'
import { NETWORKS } from '../config/networks'
import { getProvider } from '../utils/blockchainService'
import {
  createVault as createVaultTx,
  buildCreateVaultTx,
  loadVault,
  findVaultAcrossChains,
  parseVaultAddressInput,
  isVaultOwner,
} from '../lib/custody/safeVault'
import {
  loadVaultReferences,
  upsertVaultReference,
  removeVaultReference,
} from '../lib/custody/vaultReferences'
import { readPolicy, summarizeRules } from '../lib/custody/policy'
import { ensureVaultContact, vaultDisplayName } from '../lib/custody/vaultAddressBook'
import { loadAddressBook, ADDRESS_BOOK_CHANGED } from '../lib/addressBook/addressBookStore'
import { getPolicyStatus as getPolicyStatusV2, readPolicyV2 } from '../lib/custody/policyV2'
import { groupVaults, pickVaultChain } from '../lib/custody/vaultGroups'

/**
 * Spec 049 (US2/FR-006) — per-vault policy badge data for the list. Resilient by design: any
 * failure yields `{}` so the row simply renders without a badge; custody itself is unaffected.
 * Spec 068 adds the ordered engine: a `managed-v2` vault carries its rule count instead of a v1
 * rule summary.
 */
async function readPolicyBadge(vaultAddress, chainId) {
  try {
    const policyStatus = await getPolicyStatusV2(vaultAddress, chainId)
    if (policyStatus === 'managed-v2') {
      const policy = await readPolicyV2(vaultAddress, chainId)
      const count = policy?.rules?.length ?? 0
      return { policyStatus, policySummary: `${count} ordered rule${count === 1 ? '' : 's'}` }
    }
    if (policyStatus !== 'managed') return { policyStatus }
    const policy = await readPolicy(vaultAddress, chainId)
    return { policyStatus, policySummary: summarizeRules(policy) }
  } catch {
    return {}
  }
}

/**
 * Chain identity for a saved vault (FR-002). Strict lookup only: `getNetwork()` falls back to the
 * default network for unknown ids, which would label a vault with the wrong chain — for custody
 * that is exactly the confusion this feature exists to prevent.
 */
function chainIdentity(chainId) {
  const net = NETWORKS[Number(chainId)]
  if (!net) return { chainName: `Chain ${Number(chainId)}`, isTestnet: false, chainKnown: false }
  return { chainName: net.name, isTestnet: Boolean(net.isTestnet), chainKnown: true }
}

export function useCustodyVaults() {
  const { address, chainId, signer, provider, sendCalls, loginMethod } = useWallet()
  const isPasskey = loginMethod === 'passkey'
  const [vaults, setVaults] = useState([])
  const [activeAddress, setActiveAddress] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const reqId = useRef(0)

  const supported = isCustodySupported(chainId)

  const refresh = useCallback(async () => {
    // Bump first so any in-flight request is invalidated even on the early-return path.
    const myReq = ++reqId.current
    if (!address) {
      setVaults([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      // Every saved vault, on every chain (FR-003) — the list is the member's whole custody estate,
      // not a view of the connected network.
      const refs = loadVaultReferences(address)
      // Spec 068 — the NAME comes from the address book, because that is where the member renames
      // it. The reference's own label is only a fallback for a vault the book has not seen yet.
      const book = loadAddressBook(address)
      const enriched = await Promise.all(
        refs.map(async (ref) => {
          const refChainId = Number(ref.chainId)
          const onVaultChain = Number(chainId) === refChainId
          const identity = chainIdentity(refChainId)
          try {
            // Read through a provider for the VAULT's chain. The connected wallet provider is only
            // usable when it is already on that chain; otherwise fall back to the chain's own RPC.
            const reader = onVaultChain ? provider : getProvider(refChainId)
            const state = await loadVault(ref.address, refChainId, reader)
            const badge = state.isSafe ? await readPolicyBadge(ref.address, refChainId) : {}
            return {
              ...ref,
              ...identity,
              ...state,
              label: vaultDisplayName(book, { ...ref, chainId: refChainId }),
              chainId: refChainId,
              onVaultChain,
              reachable: true,
              owner: isVaultOwner(state, address),
              ...badge,
            }
          } catch (e) {
            // Per-vault isolation (FR-003): an unreachable chain degrades ONE row, honestly, and
            // never blanks the rest of the estate.
            return {
              ...ref,
              ...identity,
              label: vaultDisplayName(book, { ...ref, chainId: refChainId }),
              chainId: refChainId,
              onVaultChain,
              reachable: false,
              isSafe: undefined,
              loadError: e?.message || 'load failed',
            }
          }
        }),
      )
      if (myReq === reqId.current) setVaults(enriched)
    } catch (e) {
      if (myReq === reqId.current) setError(e?.message || 'Failed to load vaults')
    } finally {
      if (myReq === reqId.current) setLoading(false)
    }
  }, [address, chainId, provider])

  useEffect(() => {
    refresh()
  }, [refresh])

  // A vault's name lives in the address book, so a rename there must show up here. Without this the
  // list keeps the old name until something unrelated happens to re-run the effect.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onChanged = () => refresh()
    window.addEventListener(ADDRESS_BOOK_CHANGED, onChanged)
    return () => window.removeEventListener(ADDRESS_BOOK_CHANGED, onChanged)
  }, [refresh])

  /**
   * Load a vault by address and persist a reference for EVERY network it is a Safe on.
   *
   * Spec 068 — searches EVERY custody chain, not just the connected one. A member with a vault
   * address rarely knows (or should have to know) which chain it is on; making them switch networks
   * until one sticks is not a discovery mechanism.
   *
   * Spec 102 (US2/FR-003) — every match is stored, so the same Safe on six networks becomes ONE
   * card with six instances rather than a "pick another network" prompt. The returned object keeps
   * the spec-068 `picked` semantics (an explicit `preferredChainId`, else the pasted EIP-3770 prefix,
   * else the connected chain, else the first hit) so existing callers still get one instance to
   * confirm against, plus `added` (every chain stored) and `unreachable` (named, re-probeable).
   *
   * The error distinguishes "no Safe anywhere we could reach" from "some chains were unreachable",
   * so a dead RPC never reads as "your vault does not exist".
   */
  const loadByAddress = useCallback(
    async (rawAddress, label = '', nowMs = 0, { preferredChainId } = {}) => {
      setError(null)
      // Safe UIs (incl. the ETC Cooperative fork) display EIP-3770-prefixed addresses
      // ("ETC:0x…", "ETCM:0x…") and members paste them verbatim: strip the prefix and use a
      // recognized one as a chain hint, ranked below an explicit member choice.
      const { address: cleanAddress, chainHint } = parseVaultAddressInput(rawAddress)
      const { matches, unreachable, searched } = await findVaultAcrossChains(
        cleanAddress,
        CUSTODY_SUPPORTED_CHAIN_IDS,
        { providerFor: (id) => (Number(id) === Number(chainId) ? provider : getProvider(id)) },
      )

      if (matches.length === 0) {
        const names = searched.map((id) => chainIdentity(id).chainName).join(', ')
        const err = new Error(
          unreachable.length > 0
            ? `No Safe vault found at this address on ${names}. ` +
              `${unreachable.map((u) => chainIdentity(u.chainId).chainName).join(', ')} could not be reached, ` +
              `so it may exist there — try again shortly.`
            : `No Safe vault found at this address on any supported network (${names}).`,
        )
        err.classification = 'not-found-anywhere'
        err.unreachable = unreachable
        throw err
      }

      const picked =
        matches.find((m) => Number(m.chainId) === Number(preferredChainId)) ||
        (chainHint != null && matches.find((m) => Number(m.chainId) === Number(chainHint))) ||
        matches.find((m) => Number(m.chainId) === Number(chainId)) ||
        matches[0]

      // Every match is stored, role computed PER INSTANCE — owner sets can differ by chain.
      const stamp = nowMs || Date.now()
      const added = []
      for (const m of matches) {
        const owner = isVaultOwner(m, address)
        upsertVaultReference(
          address,
          { chainId: Number(m.chainId), address: m.address, label, role: owner ? 'owner' : 'watch' },
          stamp,
        )
        // The vault joins the address book on each of its networks, so it is renamed and managed
        // like any other address. Non-destructive: an entry the member already renamed is left alone.
        ensureVaultContact(address, { ...m, label })
        added.push(Number(m.chainId))
      }
      await refresh()
      setActiveAddress(picked.address)
      return { ...picked, owner: isVaultOwner(picked, address), matches, unreachable, added }
    },
    [address, chainId, provider, refresh],
  )

  /**
   * Spec 102 (US2 scenario 4) — re-run the cross-chain probe for a vault the member already holds
   * and add ONLY the networks that are new. Existing references are untouched (their labels and
   * roles are the member's), so a "Check again" after an RPC outage can never rewrite what is there.
   * Returns the chains added and the chains still unreachable; never throws for "found nowhere new".
   */
  const probeVault = useCallback(
    async (vaultAddress, nowMs = 0) => {
      setError(null)
      const { address: cleanAddress } = parseVaultAddressInput(vaultAddress)
      const held = new Set(
        loadVaultReferences(address)
          .filter((r) => String(r.address).toLowerCase() === String(cleanAddress).toLowerCase())
          .map((r) => Number(r.chainId)),
      )
      const { matches, unreachable } = await findVaultAcrossChains(cleanAddress, CUSTODY_SUPPORTED_CHAIN_IDS, {
        providerFor: (id) => (Number(id) === Number(chainId) ? provider : getProvider(id)),
      })
      const fresh = matches.filter((m) => !held.has(Number(m.chainId)))
      const stamp = nowMs || Date.now()
      const added = []
      for (const m of fresh) {
        const owner = isVaultOwner(m, address)
        upsertVaultReference(
          address,
          { chainId: Number(m.chainId), address: m.address, label: '', role: owner ? 'owner' : 'watch' },
          stamp,
        )
        ensureVaultContact(address, m)
        added.push(Number(m.chainId))
      }
      if (added.length > 0) await refresh()
      return { added, unreachable }
    },
    [address, chainId, provider, refresh],
  )

  /** Create a new vault and persist its reference (owner role). `policySetup` (spec 049, optional)
   * attaches a policy guard atomically at creation. */
  const createVault = useCallback(
    async ({ owners, threshold, saltNonce, label = '', policySetup }, nowMs = 0) => {
      if (!isPasskey && !signer) throw new Error('Connect a wallet to create a vault')
      setError(null)
      let vaultAddress
      let txHash
      if (isPasskey) {
        // Passkey rail: send createProxyWithNonce as ONE sponsored UserOp. A UserOp receipt has no
        // parseable ProxyCreation log, so the deterministic CREATE2 address (predictedAddress) is
        // authoritative for the deployed vault.
        const tx = await buildCreateVaultTx({ chainId, owners, threshold, saltNonce, policySetup, provider })
        const sent = await sendCalls([{ target: tx.to, data: tx.data, value: tx.value ?? 0n }])
        vaultAddress = tx.predictedAddress
        txHash = sent?.txHash ?? sent?.userOpHash ?? sent?.intentId
      } else {
        const res = await createVaultTx({ signer, chainId, owners, threshold, saltNonce, policySetup })
        vaultAddress = res.address
        txHash = res.txHash
      }
      upsertVaultReference(
        address,
        { chainId: Number(chainId), address: vaultAddress, label, role: 'owner' },
        nowMs || Date.now(),
      )
      ensureVaultContact(address, { address: vaultAddress, chainId: Number(chainId), label })
      await refresh()
      setActiveAddress(vaultAddress)
      return { address: vaultAddress, txHash }
    },
    [isPasskey, signer, sendCalls, provider, address, chainId, refresh],
  )

  /** Preview the deterministic address a new vault would deploy to (before signing, FR US1). */
  const previewVaultAddress = useCallback(
    async ({ owners, threshold, saltNonce, policySetup }) => {
      const { predictedAddress } = await buildCreateVaultTx({
        chainId,
        owners,
        threshold,
        saltNonce,
        policySetup,
        provider,
      })
      return predictedAddress
    },
    [chainId, provider],
  )

  const forget = useCallback(
    async (vaultAddress, vaultChainId) => {
      // References are keyed (chainId, address); with a cross-chain list the caller's vault may not
      // live on the connected chain, so accept its chain explicitly and fall back to the connected
      // one for legacy call sites.
      removeVaultReference(address, vaultChainId ?? chainId, vaultAddress)
      if (activeAddress === vaultAddress) setActiveAddress(null)
      await refresh()
    },
    [address, chainId, activeAddress, refresh],
  )

  /**
   * Spec 102 (FR-015) — "Remove from Protect" forgets the vault on EVERY network. The store is the
   * source of truth for which references exist (not the enriched list, which may be mid-refresh).
   */
  const forgetVault = useCallback(
    async (vaultAddress) => {
      const target = String(vaultAddress || '').toLowerCase()
      for (const r of loadVaultReferences(address)) {
        if (String(r.address).toLowerCase() === target) removeVaultReference(address, r.chainId, r.address)
      }
      if (String(activeAddress || '').toLowerCase() === target) setActiveAddress(null)
      await refresh()
    },
    [address, activeAddress, refresh],
  )

  // Spec 102 (D1) — the one-card-per-address view. Memoised so consumers can use it as an effect
  // dependency without spinning; `vaults` only changes identity when a refresh commits.
  const groups = useMemo(() => groupVaults(vaults, { walletChainId: chainId }), [vaults, chainId])

  // The selected vault's instance on the CONNECTED chain when it has one there, else its pinned
  // instance — so a propose/approve always has a concrete (chainId, address) to act against.
  const activeVault = useMemo(() => {
    if (!activeAddress) return null
    const own = vaults.filter((v) => String(v.address).toLowerCase() === String(activeAddress).toLowerCase())
    if (own.length === 0) return null
    const pinned = pickVaultChain({ chainIds: own.map((v) => v.chainId), walletChainId: chainId })
    return own.find((v) => Number(v.chainId) === pinned) || own[0]
  }, [vaults, activeAddress, chainId])

  return {
    supported,
    vaults,
    groups,
    activeVault,
    activeAddress,
    selectVault: setActiveAddress,
    loading,
    error,
    refresh,
    loadByAddress,
    probeVault,
    createVault,
    previewVaultAddress,
    forget,
    forgetVault,
  }
}

export default useCustodyVaults
