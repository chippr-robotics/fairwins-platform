/**
 * Per-operation sponsorship limits (spec 050, FR-010 defense-in-depth). The killswitch, sanctions
 * screen, and per-account/global quotas are the SAME modules the intent path uses (composed in the
 * route); this module adds the two per-op ceilings that bound a single sponsored op's cost so one
 * deliberately-expensive UserOp can't burn a large slice of the deposit.
 */
import { estCostWei, requiredPrefundWei, totalGas } from './build.js'

/**
 * @param {object} userOp
 * @param {{maxCostWei: bigint, maxGas: bigint}} limits
 * @returns {{ok: true} | {ok: false, code: 'cost_ceiling_exceeded'|'gas_ceiling_exceeded', detail: string}}
 */
export function checkOpLimits(userOp, { maxCostWei, maxGas }) {
  const gas = totalGas(userOp)
  if (maxGas != null && gas > maxGas) {
    return { ok: false, code: 'gas_ceiling_exceeded', detail: `totalGas ${gas} > ${maxGas}` }
  }
  const cost = estCostWei(userOp)
  if (maxCostWei != null && cost > maxCostWei) {
    return { ok: false, code: 'cost_ceiling_exceeded', detail: `estCostWei ${cost} > ${maxCostWei}` }
  }
  return { ok: true }
}

/**
 * Deposit gate (the 2026-08-26 incident): the grant path signed sponsorship without ever reading
 * the pool, so a drained deposit surfaced as a raw bundler `AA31` in the member's purchase flow
 * instead of this endpoint's refusal (which the SPA answers by self-funding — never-stranded).
 *
 * Semantics mirror the estate rules: a DEFINITE "deposit < this op's worst-case prefund" refuses
 * with `paymaster_deposit_low`; an UNREADABLE deposit does NOT refuse — an RPC blip is not an
 * empty pool, the bundler's own AA31 is the backstop, and the client now classifies that AA31 as
 * sponsorship-unavailable too. Reads are cached briefly so sponsorship doesn't add a chain
 * round-trip per request.
 */
export function createDepositGate({ providers, chains, ttlMs = 30_000, now = Date.now }) {
  const cache = new Map() // chainId -> { at, depositWei }

  async function readDeposit(chainId) {
    const hit = cache.get(chainId)
    if (hit && now() - hit.at < ttlMs) return hit.depositWei
    const chainCfg = chains[chainId]
    const provider = providers[chainId]
    if (!provider || !chainCfg?.paymaster) return null
    // EntryPoint.balanceOf(paymaster) — selector 0x70a08231, address left-padded to 32 bytes.
    const data = '0x70a08231' + chainCfg.paymaster.address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    const raw = await provider.call({ to: chainCfg.paymaster.entryPoint, data })
    const depositWei = BigInt(raw)
    cache.set(chainId, { at: now(), depositWei })
    return depositWei
  }

  return {
    /** @returns {{ok:true, unconfirmed?:true, depositWei?:bigint} | {ok:false, code:'paymaster_deposit_low', detail:string}} */
    async check(chainId, userOp) {
      let depositWei
      try {
        depositWei = await readDeposit(chainId)
      } catch {
        return { ok: true, unconfirmed: true }
      }
      if (depositWei == null) return { ok: true, unconfirmed: true }
      const need = requiredPrefundWei(userOp)
      if (depositWei < need) {
        return {
          ok: false,
          code: 'paymaster_deposit_low',
          detail: `deposit ${depositWei} wei < required prefund ${need} wei`,
        }
      }
      return { ok: true, depositWei }
    },
  }
}
