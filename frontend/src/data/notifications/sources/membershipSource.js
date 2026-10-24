/**
 * Membership activity source (spec 031, FR-029). Snapshot-diffs the user's membership (tier + expiry) each
 * cycle: granted / upgraded / expired (informational), plus "expiring soon" (action: renew, anti-spammed once
 * per UTC day) and "voucher redeemable" (action: redeem) from a best-effort bounded voucher scan. Pure
 * snapshot-diff (first-sight = baseline). No hooks; read-only provider.
 */
import { keccak256, stringToHex, isAddress } from 'viem'
import { getPublicClient } from '../../../lib/chains/publicClient'
import { readContract } from '../../../lib/chains/readContract'
import { eventScanHandle } from '../../../lib/chains/eventScan'
import { getContractAddressForChain, getDeploymentBlockForChain } from '../../../config/contracts'
import { MEMBERSHIP_MANAGER_ABI } from '../../../abis/MembershipManager'
import { MEMBERSHIP_VOUCHER_ABI } from '../../../abis/MembershipVoucher'
import { scanLogs } from '../../../lib/chain/logScan'

const ROLE = keccak256(stringToHex('WAGER_PARTICIPANT_ROLE'))
const TIER = ['None', 'Bronze', 'Silver', 'Gold', 'Platinum']
const DAY_S = 86400
const EXPIRING_WINDOW_S = 7 * DAY_S

const tierName = (t) => TIER[t] || `Tier ${t}`

/**
 * Log-scan chunks the voucher backfill may spend per poll. The voucher contract is ~2.1M blocks old
 * on Polygon and the app's default RPC caps one `eth_getLogs` at 10,000 blocks, so this read was a
 * guaranteed error on every 30s cycle before it was chunked — and chunking without a budget would
 * have replaced one doomed request with 216 live ones. Bounded and resumable instead: the scan
 * converges over a few minutes and every later poll costs one chunk.
 */
const VOUCHER_CHUNK_BUDGET_PER_POLL = 12

/**
 * How many vouchers this account still holds (and therefore can redeem).
 *
 * `complete` is false while the history backfill is still short of the chain head. A count taken
 * mid-backfill is not a smaller count, it is an UNKNOWN one — announcing "you have N vouchers to
 * redeem" off it, and then again at N+1 as the scan catches up, would be inventing arrivals that
 * never happened. `held` is null when the scan could not start at all.
 *
 * @returns {Promise<{held: number|null, complete: boolean}>}
 */
async function countRedeemableVouchers(voucherAddr, account, chainId) {
  // Never scan from genesis: without a recorded deploy block there is no honest starting point.
  const fromBlock = getDeploymentBlockForChain('membershipVoucher', chainId)
  if (!fromBlock) return { held: null, complete: false }

  const voucher = eventScanHandle(chainId, { address: voucherAddr, abi: MEMBERSHIP_VOUCHER_ABI })
  if (!voucher) return { held: null, complete: false }
  const { logs, complete } = await scanLogs({
    contract: voucher,
    filters: [voucher.filters.Transfer(null, account)],
    fromBlock,
    chainId,
    maxChunks: VOUCHER_CHUNK_BUDGET_PER_POLL,
  })
  if (!complete) return { held: null, complete: false }

  const ids = [...new Set(logs.map((e) => e.args.tokenId.toString()))]
  let held = 0
  for (const id of ids) {
    try {
      const owner = await readContract(chainId, {
        address: voucherAddr,
        abi: MEMBERSHIP_VOUCHER_ABI,
        functionName: 'ownerOf',
        args: [BigInt(id)],
      })
      if (String(owner).toLowerCase() === String(account).toLowerCase()) held += 1
    } catch { /* burned / redeemed / transferred away */ }
  }
  return { held, complete: true }
}

export const membershipSource = {
  key: 'membership',
  label: 'Membership',
  async detect({ account, chainId, nowMs, prior }) {
    const managerAddr = getContractAddressForChain('membershipManager', chainId)
    if (!managerAddr || !isAddress(managerAddr)) {
      return { ok: true, entries: [], nextSnapshots: {}, currentIds: [], actionNeededById: {} }
    }
    // The seam is the availability gate: no route, no read, and the caller keeps its prior slice.
    if (!getPublicClient(chainId)) return { ok: false }

    let tier
    let expiresAt
    try {
      const m = await readContract(chainId, {
        address: managerAddr,
        abi: MEMBERSHIP_MANAGER_ABI,
        functionName: 'getMembership',
        args: [account, ROLE],
      })
      tier = Number(m.tier ?? m[0])
      expiresAt = Number(m.expiresAt ?? m[1])
    } catch {
      return { ok: false } // can't read membership — retain prior slice
    }

    const nowSec = Math.floor(nowMs / 1000)
    const dayBucket = Math.floor(nowMs / 86_400_000)
    const entries = []
    const actionNeededById = {}
    const currentIds = ['membership']
    const nextSnapshots = {}
    const nextAux = { ...(prior.aux || {}) }

    const mk = (type, message, severity, actionable = false, link = { to: '/wallet', state: { tab: 'membership' } }) => ({
      id: `membership:membership:${type}:${nowMs}`, domain: 'membership', refId: 'membership', type, message, severity, actionable, link, createdAt: nowMs, read: false,
    })

    const prev = prior.snapshots?.membership
    nextSnapshots.membership = { tier, expiresAt, snappedAt: nowMs }
    if (prev && prev.tier !== tier) {
      if (tier === 0) entries.push(mk('membership-expired', `Your ${tierName(prev.tier)} membership has ended`, 'warning'))
      else if (prev.tier === 0) entries.push(mk('membership-granted', `You're now a ${tierName(tier)} member`, 'success'))
      else if (tier > prev.tier) entries.push(mk('membership-upgraded', `Membership upgraded to ${tierName(tier)}`, 'success'))
      else entries.push(mk('membership-changed', `Membership changed to ${tierName(tier)}`, 'info'))
    }

    // Expiring soon (action: renew) — anti-spam to once per UTC day via aux.
    if (tier > 0 && expiresAt > nowSec && expiresAt - nowSec <= EXPIRING_WINDOW_S) {
      actionNeededById.membership = 'renew'
      if (nextAux.expiringDay !== dayBucket) {
        const days = Math.max(1, Math.ceil((expiresAt - nowSec) / DAY_S))
        entries.push(mk('membership-expiring', `Your ${tierName(tier)} membership expires in ${days} day${days === 1 ? '' : 's'} — renew to keep it`, 'warning', true))
        nextAux.expiringDay = dayBucket
      }
    }

    // Voucher redeemable (action: redeem) — best-effort bounded scan; degrades honestly.
    //
    // A failed or still-catching-up scan keeps the PRIOR slice and marks the cycle partial. It is
    // deliberately not `ok:false`: the membership read above succeeded, and downgrading the whole
    // source would discard a good tier/expiry answer and raise the member-facing "couldn't refresh"
    // notice over a best-effort extra.
    let partial = false
    const voucherAddr = getContractAddressForChain('membershipVoucher', chainId)
    if (voucherAddr && isAddress(voucherAddr)) {
      currentIds.push('voucher')
      const keepPrior = () => {
        partial = true
        if (prior.snapshots?.voucher) {
          nextSnapshots.voucher = prior.snapshots.voucher
          if ((prior.snapshots.voucher.count ?? 0) > 0) actionNeededById.voucher = 'redeemVoucher'
        }
      }
      try {
        const { held, complete } = await countRedeemableVouchers(voucherAddr, account, chainId)
        if (!complete || held == null) {
          keepPrior()
        } else {
          nextSnapshots.voucher = { count: held, snappedAt: nowMs }
          if (held > 0) actionNeededById.voucher = 'redeemVoucher'
          const prevCount = prior.snapshots?.voucher?.count ?? 0
          if (prior.snapshots?.voucher && prevCount === 0 && held > 0) {
            entries.push(mk('voucher-redeemable', `You have ${held} membership voucher${held === 1 ? '' : 's'} to redeem`, 'info', true, { to: '/vouchers' }))
          }
        }
      } catch {
        keepPrior()
      }
    }

    return { ok: true, entries, nextSnapshots, currentIds, actionNeededById, nextAux, partial }
  },
}

export default membershipSource
