/**
 * Staking activity source (spec 065 / spec 031, FR-011/FR-012). Two inputs:
 *
 * 1. **Action buffer** — stake/unstake/withdraw/claim flows queue what the
 *    member just did (with the tx hash) via lib/staking/stakingActivityBuffer;
 *    detect drains the buffer into precise entries with explorer links.
 * 2. **Ready-to-withdraw detection** — for options the member has acted on
 *    (tracked set), the open exits are read over the chain provider each cycle.
 *    When an exit newly becomes ready, an **actionable** entry is emitted so it
 *    breaks through a focused notification profile (FR-012). First-sight of a
 *    tracked option is a baseline (no retroactive spam); ids are stable; a hard
 *    read failure returns ok:false so the engine keeps the prior slice.
 */
import { isStakingAvailable, getStakingConfig } from '../../../config/networks'
import { getPublicClient } from '../../../lib/chains/publicClient'
import { drainStakingActions } from '../../../lib/staking/stakingActivityBuffer'
import { stakingPath } from '../../../config/staking'
import { readLidoWithdrawalStatuses } from '../../../lib/staking/lidoStaking'
import { readSpolOpenNonces } from '../../../lib/staking/spolStaking'
import { readOpenUnbonds, readStakeManagerTiming } from '../../../lib/staking/polygonDelegation'

const EMPTY = { ok: true, entries: [], nextSnapshots: {}, currentIds: [], actionNeededById: {} }

/** Resolve an option's read coordinates from config by its id. */
function resolveOption(config, optionId) {
  if (!config || !optionId) return null
  if (optionId.startsWith('liquid:')) {
    const kind = optionId.slice('liquid:'.length)
    const liquid = (config.liquid || []).find((l) => l.kind === kind)
    return liquid ? { providerKind: kind, contracts: liquid.contracts } : null
  }
  if (optionId.startsWith('delegated:')) {
    const id = Number(optionId.slice('delegated:'.length))
    const v = (config.delegated?.validators || []).find((x) => x.validatorId === id)
    return v
      ? { providerKind: 'validator-share', validatorShare: v.validatorShare, stakeManager: config.delegated.stakeManager }
      : null
  }
  return null
}

/** Read the ready-exit handle keys for one tracked option. */
async function readReadyKeys({ optionId, coords, account, chainId, timing }) {
  if (coords.providerKind === 'lido') {
    const statuses = await readLidoWithdrawalStatuses({ contracts: coords.contracts, account, chainId })
    return statuses.filter((s) => s.ready).map((s) => `${optionId}:req:${s.requestId}`)
  }
  if (coords.providerKind === 'spol') {
    const nonces = await readSpolOpenNonces({
      contracts: coords.contracts,
      account,
      chainId,
      currentEpoch: timing?.epoch,
      withdrawalDelay: timing?.withdrawalDelay,
    })
    return nonces.filter((n) => n.ready).map((n) => `${optionId}:nonce:${n.unbondNonce}`)
  }
  const unbonds = await readOpenUnbonds({
    validatorShare: coords.validatorShare,
    account,
    chainId,
    epoch: timing?.epoch,
    withdrawalDelay: timing?.withdrawalDelay,
  })
  return unbonds.filter((u) => u.ready).map((u) => `${optionId}:nonce:${u.unbondNonce}`)
}

export const stakingSource = {
  key: 'staking',
  label: 'Staking',
  async detect({ account, chainId, nowMs, prior }) {
    if (!account || !isStakingAvailable(chainId)) return EMPTY

    const entries = []
    const nextSnapshots = {}
    const currentIds = []
    const actionNeededById = {}
    const actedOptions = new Set()

    // 1) Precise entries for actions the member just performed in the app.
    for (const record of drainStakingActions(account, chainId)) {
      entries.push({
        id: `staking:${chainId}:${record.type}:${record.txHash}`,
        domain: 'staking',
        refId: String(record.refId || record.optionId || '').toLowerCase(),
        type: record.type,
        message: record.message,
        severity: 'success',
        actionable: false,
        link: { to: stakingPath({ chainId }) },
        txUrl: record.txUrl || null,
        createdAt: record.at || nowMs,
        read: false,
      })
      if (record.optionId) {
        actedOptions.add(record.optionId)
        nextSnapshots[`staking:${record.optionId}`] = nextSnapshots[`staking:${record.optionId}`] || null
      }
    }

    // 2) Ready-to-withdraw detection for tracked options.
    const priorSnapshots = prior?.snapshots || {}
    const tracked = new Set([
      ...Object.keys(priorSnapshots).map((sid) => sid.replace(/^staking:/, '')),
      ...actedOptions,
    ])
    if (tracked.size === 0) {
      return { ...EMPTY, entries, currentIds: entries.map((e) => e.refId) }
    }

    const config = getStakingConfig(chainId)
    // The chain seam is the availability gate: no RPC route means the tracked
    // exits cannot be read this cycle (engine keeps the prior slice).
    if (!getPublicClient(chainId)) return { ok: false }

    let timing = null
    if (config?.delegated) {
      try {
        timing = await readStakeManagerTiming({ stakeManager: config.delegated.stakeManager, chainId })
      } catch {
        timing = null
      }
    }

    let anyOk = false
    for (const optionId of tracked) {
      const coords = resolveOption(config, optionId)
      if (!coords) continue
      const sid = `staking:${optionId}`
      currentIds.push(sid)
      let readyKeys
      try {
        readyKeys = await readReadyKeys({ optionId, coords, account, chainId, timing })
        anyOk = true
      } catch {
        if (priorSnapshots[sid]) nextSnapshots[sid] = priorSnapshots[sid]
        continue
      }
      const prevKeys = priorSnapshots[sid]?.readyKeys || null
      nextSnapshots[sid] = { readyKeys, snappedAt: nowMs }

      // First sight = baseline. Afterwards, a ready key not seen before is a
      // freshly-matured unbond → actionable "ready to withdraw".
      if (prevKeys) {
        for (const key of readyKeys) {
          if (!prevKeys.includes(key)) {
            const id = `staking:${chainId}:unbond-ready:${key}`
            entries.push({
              id,
              domain: 'staking',
              refId: optionId,
              type: 'unbond-ready',
              message: 'Your unstaked funds are ready to withdraw',
              severity: 'info',
              actionable: true,
              link: { to: stakingPath({ chainId }) },
              createdAt: nowMs,
              read: false,
            })
            actionNeededById[id] = true
          }
        }
      }
    }

    if (!anyOk && tracked.size > 0 && entries.length === 0) return { ok: false }
    for (const [sid, snap] of Object.entries(nextSnapshots)) {
      if (snap === null) delete nextSnapshots[sid]
    }
    return { ok: true, entries, nextSnapshots, currentIds, actionNeededById }
  },
}

export default stakingSource
