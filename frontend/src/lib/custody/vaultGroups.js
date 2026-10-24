// Spec 102 — a vault is an ADDRESS; a network is a property of a transaction. The reference store
// stays keyed (chainId, address) (spec 068 per-chain reads, failure isolation and backup are all
// untouched), and this module is the VIEW that folds those per-chain instances into one group per
// vault for the member-facing surfaces. Pure functions, no React, no chain access.
//
// Honesty rules (constitution III): the threshold shown is the FIRST readable instance's, and
// `thresholdVaries` is set when readable instances disagree — never an average, never "0 of 0".
// A group whose only instance is unreachable still exists (with `threshold: null`) and NAMES the
// unreachable chain; it is never dropped and never rendered as a vault with no owners.

import { NETWORKS } from '../../config/networks'
import { isQueued } from './proposalStatus'

/** Strict chain name (never `getNetwork()`, which would relabel an unknown chain as the default). */
export function vaultChainName(chainId) {
  return NETWORKS[Number(chainId)]?.name || `Chain ${Number(chainId)}`
}

/** "Polygon", "Polygon and Base", "Polygon, Base and Optimism" — member copy, no Oxford comma. */
export function listChainNames(chainIds) {
  const names = (chainIds || []).map(vaultChainName)
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const lower = (a) => String(a || '').toLowerCase()

/**
 * The chain a vault-scoped action should target.
 * Precedence: an explicit `preferred` that the vault is actually on → the wallet's chain when the
 * vault is on it → the first instance. Returns `null` for an empty set.
 *
 * @param {{ chainIds: Array<number|string>, walletChainId?: number|string, preferred?: number|string }} p
 * @returns {number|null}
 */
export function pickVaultChain({ chainIds, walletChainId, preferred } = {}) {
  const ids = (chainIds || []).map(Number).filter(Number.isFinite)
  if (ids.length === 0) return null
  if (preferred != null && ids.includes(Number(preferred))) return Number(preferred)
  if (walletChainId != null && ids.includes(Number(walletChainId))) return Number(walletChainId)
  return ids[0]
}

/**
 * Fold the enriched per-chain vault objects from `useCustodyVaults` into one `VaultGroup` per
 * distinct address (case-insensitive). Instance order is preserved both within a group and across
 * groups (first appearance wins). Shape documented in specs/102-…/data-model.md.
 *
 * @param {object[]} vaults enriched instances `{ address, chainId, label, isSafe, reachable, owners, threshold, owner, … }`
 * @param {{ walletChainId?: number|string }} [opts]
 * @returns {object[]} VaultGroup[]
 */
export function groupVaults(vaults, { walletChainId } = {}) {
  const byKey = new Map()
  for (const v of vaults || []) {
    if (!v?.address) continue
    const key = lower(v.address)
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(v)
  }

  const groups = []
  for (const [key, instances] of byKey) {
    const chainIds = instances.map((i) => Number(i.chainId))
    const readable = instances.filter((i) => i.isSafe === true)
    const unreachable = instances.filter((i) => i.reachable === false).map((i) => Number(i.chainId))
    // Reachable but not a Safe there — distinct from unreachable: the chain answered, and the answer was "no".
    const unreadable = instances.filter((i) => i.reachable !== false && i.isSafe === false).map((i) => Number(i.chainId))

    const first = readable[0] || null
    const threshold = first ? { value: Number(first.threshold), of: (first.owners || []).length } : null
    const thresholdVaries = readable.some(
      (i) => Number(i.threshold) !== threshold.value || (i.owners || []).length !== threshold.of,
    )

    // Owner union, deduped case-insensitively; the first-seen spelling (checksummed upstream) is kept.
    const seen = new Set()
    const owners = []
    for (const i of readable) {
      for (const o of i.owners || []) {
        const k = lower(o)
        if (seen.has(k)) continue
        seen.add(k)
        owners.push(o)
      }
    }

    const ownerChainIds = instances.filter((i) => i.owner === true).map((i) => Number(i.chainId))
    const withPolicy = readable.find((i) => i.policyStatus != null) || null
    const pinnedChainId = pickVaultChain({ chainIds, walletChainId })
    const connectedInstance =
      walletChainId == null ? null : instances.find((i) => Number(i.chainId) === Number(walletChainId)) || null

    groups.push({
      key,
      address: instances[0].address,
      label: instances.find((i) => typeof i.label === 'string' && i.label.trim())?.label || '',
      instances,
      chainIds,
      readable,
      unreachable,
      unreadable,
      networkLine: chainIds.length === 1 ? vaultChainName(chainIds[0]) : `${chainIds.length} networks`,
      threshold,
      thresholdVaries,
      owners,
      anyOwner: ownerChainIds.length > 0,
      ownerChainIds,
      policyStatus: withPolicy?.policyStatus,
      policySummary: withPolicy?.policySummary,
      pinnedChainId,
      connectedInstance,
    })
  }
  return groups
}

const joinNames = (ids) => ids.map(vaultChainName).join(', ')

/**
 * The queue totals line for a group's per-chain reads (`useVaultQueueAcrossChains#byChain`).
 * A count exists only for a chain in state `read`; every other chain is NAMED in the line and
 * makes the total partial — a chain that could not be read is never "0 pending".
 *
 * @param {Record<string, {state:string, proposals?:object[], partial?:boolean}>} byChain
 * @returns {{ pending:number, networks:number, missing:number[], loading:number[], partial:boolean, line:string }}
 */
export function summarizeQueue(byChain) {
  const entries = Object.entries(byChain || {}).map(([id, e]) => [Number(id), e || {}])
  const read = entries.filter(([, e]) => e.state === 'read')
  const loading = entries.filter(([, e]) => e.state === 'loading').map(([id]) => id)
  // A chain still loading is not yet KNOWN to be missing; naming it "not read" would be a claim
  // about a read that has not finished. It is reported separately.
  const missing = entries.filter(([, e]) => e.state !== 'read' && e.state !== 'loading').map(([id]) => id)
  const catchingUp = read.filter(([, e]) => e.partial === true).map(([id]) => id)
  const pending = read.reduce(
    (n, [, e]) => n + (e.proposals || []).filter((p) => isQueued(p.status)).length,
    0,
  )
  const networks = read.length
  const partial = missing.length > 0 || catchingUp.length > 0

  let line = `${pending} pending`
  if (networks > 1) line += ` across ${networks} networks`
  if (missing.length > 0) line += ` · ${joinNames(missing)} not read`
  if (catchingUp.length > 0) line += ` · ${joinNames(catchingUp)} still catching up`

  return { pending, networks, missing, loading, partial, line }
}
