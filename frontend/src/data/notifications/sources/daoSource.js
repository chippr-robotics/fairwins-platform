/**
 * ClearPath DAO governance activity source (spec 031 + 042). For every DAO the member tracks on the active
 * network — from the on-chain ExternalDAORegistry where deployed AND the device-local tracked list where not
 * (spec 042) — it discovers proposals via the per-framework connector (OpenZeppelin Governor / GovernorBravo)
 * and turns state changes into feed entries: voting-open / ready-to-queue / ready-to-execute / finalized. Pure
 * snapshot-diff (first-sight = baseline). Action-needed is recomputed live and degrades honestly when a Governor
 * omits the eligibility views. No hooks — runs in the engine; reads via a read-only provider. Strictly
 * network-scoped (FR-014): nothing crosses chains or accounts.
 */
import { isAddress } from 'viem'
import { readContract } from '../../../lib/chains/readContract'
import { getContractAddressForChain } from '../../../config/contracts'
import { getNetwork } from '../../../config/networks'
import { makeReadProvider } from '../../../utils/rpcProvider'
import { EXTERNAL_DAO_REGISTRY_ABI } from '../../../abis/externalDAORegistry'
import { getConnector, detectFramework } from '../../../lib/clearpath/connectors'
import * as trackedDaoStore from '../../../lib/clearpath/trackedDaos'
import { knownDaosForChain } from '../../../lib/clearpath/knownDaos'
import { pruneSnapshotMap } from '../activityStore'

const STATE = { Pending: 0, Active: 1, Canceled: 2, Defeated: 3, Succeeded: 4, Queued: 5, Expired: 6, Executed: 7 }
const TERMINAL = new Set([STATE.Canceled, STATE.Defeated, STATE.Expired, STATE.Executed])

function eventFor(state) {
  if (state === STATE.Active) return { type: 'voting-open', severity: 'info', actionable: true }
  if (state === STATE.Succeeded) return { type: 'ready-to-queue', severity: 'info', actionable: true }
  // Queued: the proposal keeps state==Queued for the whole timelock delay, so the ENTRY only notes it was
  // queued; the ETA-gated "execute" action (deriveAction) is what truthfully signals executability.
  if (state === STATE.Queued) return { type: 'queued', severity: 'info', actionable: false }
  if (state === STATE.Executed) return { type: 'finalized', severity: 'success', actionable: false }
  if (TERMINAL.has(state)) return { type: 'finalized', severity: 'info', actionable: false }
  return null // Pending — not yet notify-worthy
}

function title(p) {
  const d = (p.description || '').split('\n')[0].replace(/^#\s*/, '').trim()
  return d ? d.slice(0, 60) : `Proposal ${String(p.id).slice(0, 10)}`
}

function makeEntry(refId, dao, p, ev, nowMs) {
  const t = title(p)
  const msg =
    ev.type === 'voting-open' ? `DAO proposal open for voting: ${t}`
    : ev.type === 'ready-to-queue' ? `DAO proposal ready to queue: ${t}`
    : ev.type === 'queued' ? `DAO proposal queued (executable after its timelock): ${t}`
    : `DAO proposal finalized: ${t}`
  return {
    id: `dao:${refId}:${ev.type}`,
    domain: 'dao',
    refId,
    type: ev.type,
    message: msg,
    severity: ev.severity,
    actionable: ev.actionable,
    link: { to: '/wallet', state: { tab: 'clearpath', dao } },
    createdAt: nowMs,
    read: false,
  }
}

/**
 * Live action-needed for a proposal, through the DAO's own connector so OZ and Bravo are both handled — honest
 * degrade (null) when eligibility can't be confirmed. Reads are framework-agnostic: readProposalEta gates
 * execute; readVoterState gates vote.
 */
async function deriveAction(connector, provider, dao, p, state, account, nowMs) {
  if (state === STATE.Succeeded) return 'queue'
  if (state === STATE.Queued) {
    const eta = await connector.readProposalEta(provider, dao, p.id)
    return eta != null && eta > 0 && eta * 1000 <= nowMs ? 'execute' : null
  }
  if (state === STATE.Active) {
    const vs = await connector.readVoterState(provider, dao, p, account)
    if (vs.hasVoted) return null
    try {
      return vs.votingPower != null && BigInt(vs.votingPower) > 0n ? 'vote' : null
    } catch {
      return null // unparseable power — do not fake eligibility
    }
  }
  return null
}

/** Enumerate the tracked DAOs on `chainId` for `account`: on-chain registry (if deployed) + device-local list,
 *  deduped by lowercased address. Each carries its framework (registry enum / stored detection). */
async function listTrackedDaos(provider, chainId, account) {
  const out = []
  const seen = new Set()
  const push = (addr, framework) => {
    const lc = String(addr).toLowerCase()
    if (!isAddress(lc) || seen.has(lc)) return
    seen.add(lc)
    out.push({ dao: addr, framework })
  }
  const registryAddr = getContractAddressForChain('externalDAORegistry', chainId)
  if (registryAddr && isAddress(registryAddr)) {
    // The registry read names its chain (spec 110). `provider` stays what the CONNECTORS are
    // handed below — they are still ethers-shaped, and converting them is Phase 2 work.
    const reg = (functionName, args) =>
      readContract(chainId, { address: registryAddr, abi: EXTERNAL_DAO_REGISTRY_ABI, functionName, args })
    const n = Number(await reg('externalCount'))
    for (let id = n; id >= 1; id -= 1) {
      const info = await reg('getExternalDAO', [BigInt(id)])
      push(info[0] ?? info.dao, Number(info[1] ?? info.framework))
    }
  }
  for (const e of trackedDaoStore.list(chainId, account)) push(e.address, e.framework)
  for (const k of knownDaosForChain(chainId)) push(k.address, k.framework)
  return out
}

export const daoSource = {
  key: 'dao',
  label: 'DAO',
  async detect({ account, chainId, nowMs, prior }) {
    const net = getNetwork(chainId)
    // ClearPath must be enabled on this network AND we need a usable RPC — otherwise nothing to track (not a
    // failure). This is capability-driven (spec 042), NOT gated on a deployed registry.
    if (!net?.capabilities?.clearpath || !net?.rpcUrl || !account) {
      return { ok: true, entries: [], nextSnapshots: {}, currentIds: [], actionNeededById: {} }
    }
    let provider
    try {
      provider = makeReadProvider(net.rpcUrl, chainId)
    } catch {
      return { ok: false }
    }

    let daos
    try {
      daos = await listTrackedDaos(provider, chainId, account)
    } catch {
      return { ok: false } // can't read the registry — retain prior slice
    }
    if (!daos.length) {
      return { ok: true, entries: [], nextSnapshots: {}, currentIds: [], actionNeededById: {} }
    }

    const acct = String(account).toLowerCase()
    const entries = []
    const nextSnapshots = { ...(prior.snapshots || {}) }
    const currentIds = []
    const actionNeededById = {}
    let partial = false

    for (const { dao, framework } of daos) {
      // Resolve the connector by stored framework; detect on-chain if unknown. A DAO with no connector is
      // skipped honestly (its prior snapshot carries forward).
      let connector = getConnector(framework)
      if (!connector) {
        const detected = await detectFramework(provider, dao).catch(() => 'unknown')
        connector = getConnector(detected)
      }
      if (!connector) { partial = true; continue }

      let res
      try {
        res = await connector.fetchProposals(provider, dao)
      } catch {
        res = { ok: false, proposals: [] }
      }
      if (!res.ok) { partial = true; continue } // keep prior proposals for this DAO (carry-forward)
      if (res.partial) partial = true
      for (const p of res.proposals || []) {
        const refId = `${String(dao).toLowerCase()}#${p.id}`
        // state:null means the per-proposal state() read reverted. NEVER coerce to 0 (Pending) — it would store
        // a wrong baseline and emit a spurious transition on recovery. Skip this cycle (prior snapshot carries
        // forward via {...prior.snapshots}) and mark partial.
        if (p.state == null) { partial = true; continue }
        currentIds.push(refId)
        const state = Number(p.state)
        const prev = prior.snapshots?.[refId]
        nextSnapshots[refId] = { dao, proposalId: String(p.id), state, snappedAt: nowMs }
        const ev = eventFor(state)
        if (prev && prev.state !== state && ev) entries.push(makeEntry(refId, dao, p, ev, nowMs))
        actionNeededById[refId] = await deriveAction(connector, provider, dao, p, state, acct, nowMs)
      }
    }

    const pruned = pruneSnapshotMap(nextSnapshots, currentIds, nowMs, (s) => TERMINAL.has(s?.state))
    return { ok: true, entries, nextSnapshots: pruned, currentIds, actionNeededById, partial }
  },
}

export default daoSource
