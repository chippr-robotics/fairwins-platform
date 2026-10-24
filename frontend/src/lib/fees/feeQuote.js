/**
 * Platform-fee quotes for wrapper services (spec 060).
 *
 * The FeeRouter contract is the single on-chain source of truth for platform
 * fees; member surfaces quote the LIVE rate from it before any signature and
 * pass that quoted rate back as `maxFeeBps`, so a member can never be charged
 * more than the rate they were shown (FR-005). Networks with no router
 * deployed quote `{ available: false, bps: 0 }` — surfaces then behave exactly
 * as before the fee system existed (no fee, no fee line). A FAILED read on a
 * network that HAS a router is different: the caller must block the action
 * rather than proceed on a possibly-understated rate (FR-015).
 *
 * Spec 067 (T115) sharpens that second case rather than restating it. Three
 * things are true here and only here, so no surface has to re-derive them:
 *
 *   1. UNDEPLOYED AND UNREADABLE ARE DIFFERENT ANSWERS. "No router on this
 *      chain" is a fact — the action is honestly fee-free and proceeds. "A
 *      router is configured and we could not read it" is an ABSENCE of a fact,
 *      and the fee-bearing path stops (`FeeQuoteUnavailable`). Collapsing the
 *      second into the first would quote 0% for a rate that might be 2.5% —
 *      the exact dishonesty FR-051 forbids. Failing to read is never evidence
 *      of a lower rate.
 *
 *   2. A RATE IS ONLY USABLE IF IT PASSES ITS OWN CAP. `maxFeeBps` is the
 *      member's ceiling: it is the one number here that can cost them money if
 *      it is wrong. A decoded `feeBps` above the service's immutable `capBps`
 *      (or outside 0…10000) cannot have come from a healthy router, so it is
 *      treated as an unreadable rate and blocks, rather than being disclosed
 *      and then signed as a ceiling nobody vetted.
 *
 *   3. THE CEILING IS COMPUTED IN ONE PLACE. `maxFeeBpsFor` is the only way a
 *      quote becomes a `maxFeeBps` argument. A surface that reads `.bps`
 *      itself can drift into `?? 0` — a silently zero ceiling for a rate that
 *      was never read — so it is the helper that decides, and the helper
 *      throws where a zero would be a lie.
 */
import { keccak256, stringToHex } from 'viem'
import { FEE_ROUTER_ABI } from '../../abis/FeeRouter'
import { getContractAddressForChain } from '../../config/contracts'
import { readContract } from '../chains/readContract'

// keccak256 over the UTF-8 label bytes — byte-identical to ethers v6 `id()`.
const keccakId = (label) => keccak256(stringToHex(label))

/** Launch wrapper service ids (bytes32 = keccak256 of the label). */
export const FEE_SERVICES = {
  EARN_LEND: keccakId('earn.lend'),
  POLYMARKET_TAKER: keccakId('polymarket.taker'),
  POLYMARKET_MAKER: keccakId('polymarket.maker'),
  // Staking (spec 066) — per-provider LIQUID-staking rates the StakingRouter reads.
  // Delegated staking is fee-free in v1 (no service id).
  STAKE_LIDO: keccakId('stake.lido'),
  STAKE_POLYGON: keccakId('stake.polygon'),
  // Cross-chain bridge + liquidity supply (spec 067). Both cap at 250 bps and ship at 0.
  //
  // There is deliberately NO bridge-LP service: Across's HubPool.addLiquidity has no recipient
  // parameter, so a fee-taking wrapper would own the member's LP position and they could never
  // exit it. Registering a rate we cannot charge would put a settable control in the admin panel
  // that silently does nothing — worse than no control (research R3).
  BRIDGE_TRANSFER: keccakId('bridge.transfer'),
  LIQUIDITY_DEPOSIT: keccakId('liquidity.deposit'),
  // Perps (spec 082): the Hyperliquid builder fee — the one platform-priced perps rate, capped at
  // Hyperliquid's own 10 bps perps limit. ConfigOnly: Hyperliquid charges it per order; FairWins
  // surfaces only READ it for disclosure. Gains/GMX referral shares are venue-paid (no service).
  PERPS_HL_BUILDER: keccakId('perps.hyperliquid.builder'),
}

const BPS_DENOMINATOR = 10_000n

/** The widest a rate could ever be. A service's own `capBps` is normally far lower. */
const MAX_BPS = 10_000

/**
 * A router IS present on this network and a rate we can stand behind could not be
 * obtained. Callers MUST block the fee-bearing action; they may keep every path that
 * carries no fee (withdrawals, exits, refunds) open, because none of those depends on
 * this rate.
 *
 * `code` says which absence it was, so a surface can be specific without guessing:
 *   'no_provider'      — no read connection to the network the router lives on
 *   'router_unreadable'— the call failed (RPC down, wrong ABI, reverted)
 *   'rate_unusable'    — the router answered, but with a rate that fails its own cap
 */
export class FeeQuoteUnavailable extends Error {
  constructor(message, { code = 'router_unreadable', routerAddress = null, serviceId = null, cause } = {}) {
    super(message)
    this.name = 'FeeQuoteUnavailable'
    this.code = code
    this.routerAddress = routerAddress
    this.serviceId = serviceId
    /** Mirrors the `{ failed: true }` sentinel surfaces already store in state. */
    this.failed = true
    if (cause !== undefined) this.cause = cause
  }
}

/** Floor fee/net split — mirrors the contract math exactly (member's favor). */
export function splitFee(grossAmount, bps) {
  const gross = BigInt(grossAmount)
  const feeAmount = (gross * BigInt(bps)) / BPS_DENOMINATOR
  return { feeAmount, netAmount: gross - feeAmount }
}

/** "0.50%" for 50 bps — the display form of a rate. */
export function bpsToPercent(bps) {
  return `${(Number(bps) / 100).toFixed(2)}%`
}

/**
 * Quote the live rate for one wrapper service on one chain.
 *
 * Returns:
 *   { available: false, bps: 0, routerAddress: null }  — no router on this
 *     chain (fee system not deployed): proceed WITHOUT a fee, like today.
 *   { available: true, bps, capBps, routerAddress }    — live rate obtained:
 *     disclose it and pass `bps` as maxFeeBps.
 * Throws `FeeQuoteUnavailable` when a router IS configured and no rate we can
 * stand behind came back — callers must treat that as "cannot quote" and block
 * the fee-bearing action (FR-015 / FR-051), never fall back to assuming zero.
 *
 * `routerAddress` overrides which FeeRouter is asked. It exists for the spec-067 operator surfaces,
 * which read the `feeRouter` a wrapping router ACTUALLY holds and quote from that rather than from
 * this build's config. The two can differ — someone repoints a router before the config ships, or
 * ships config before the transaction lands — and in that window the config address answers for a
 * contract that is not the one charging. An operator deciding whether members are being charged
 * correctly needs the live answer, not the built one. Member surfaces keep the default.
 */
export async function fetchFeeQuote({ serviceId, chainId, provider, routerAddress: routerOverride }) {
  const routerAddress = routerOverride || getContractAddressForChain('feeRouter', chainId)
  if (!routerAddress) {
    return { available: false, bps: 0, capBps: 0, routerAddress: null }
  }

  // A configured router with nothing to read it over is an unread rate, not a zero
  // one. Without this the call still fails, but deep inside the RPC client with a
  // message that says nothing about fees.
  if (!provider) {
    throw new FeeQuoteUnavailable(
      `the platform fee rate could not be read: no connection to the network the FeeRouter at ${routerAddress} lives on`,
      { code: 'no_provider', routerAddress, serviceId },
    )
  }

  let service
  try {
    service = await readContract(chainId, {
      address: routerAddress,
      abi: FEE_ROUTER_ABI,
      functionName: 'getService',
      args: [serviceId],
    })
  } catch (cause) {
    throw new FeeQuoteUnavailable(
      `the platform fee rate could not be read from the FeeRouter at ${routerAddress}: ${cause?.message || cause}`,
      { code: 'router_unreadable', routerAddress, serviceId, cause },
    )
  }

  const kind = Number(service?.kind)
  if (kind === 0) {
    // Router deployed but the service is not registered yet — honestly no fee.
    return { available: false, bps: 0, capBps: 0, routerAddress }
  }

  const bps = Number(service?.feeBps)
  const capBps = Number(service?.capBps)
  // The rate is about to become a signed ceiling, so it is checked against the cap
  // the router itself publishes for this service. A rate that cannot be true is an
  // unreadable rate: block, never disclose it and never pass it as `maxFeeBps`.
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BPS || !Number.isInteger(capBps) || capBps < 0 || capBps > MAX_BPS || bps > capBps) {
    throw new FeeQuoteUnavailable(
      `the platform fee rate could not be trusted: the FeeRouter at ${routerAddress} reported ${service?.feeBps} bps against a cap of ${service?.capBps} bps`,
      { code: 'rate_unusable', routerAddress, serviceId },
    )
  }

  return { available: true, bps, capBps, routerAddress }
}

/**
 * The one place a quote becomes the `maxFeeBps` a member signs (FR-028).
 *
 * Returns the integer basis points to pass to the router — exactly the rate that was
 * disclosed, never a recomputed or defaulted one:
 *   - a live quote      → its `bps`, re-checked against its cap
 *   - no router / unregistered service → `0`: the action is honestly fee-free, and 0
 *     is the correct ceiling for it (any charge at all must revert)
 *
 * Throws `FeeQuoteUnavailable` for a quote that is missing, still loading (`null`), or
 * marked failed. That is deliberate: the tempting alternative — treating an unknown
 * rate as a 0 ceiling — looks safe because the transaction would revert, but it sends
 * a member to a wallet prompt for a transfer that cannot succeed. Stopping before the
 * signature is the honest version of the same protection.
 */
export function maxFeeBpsFor(quote) {
  if (quote instanceof FeeQuoteUnavailable) throw quote
  if (!quote || quote.failed) {
    throw new FeeQuoteUnavailable(
      'the platform fee rate has not been read, so there is no ceiling to sign against',
      { code: quote?.failed ? 'router_unreadable' : 'not_quoted', routerAddress: quote?.routerAddress ?? null },
    )
  }
  if (!quote.available) return 0

  const bps = Number(quote.bps)
  const capBps = Number(quote.capBps)
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BPS || (Number.isInteger(capBps) && bps > capBps)) {
    throw new FeeQuoteUnavailable(
      `the quoted platform fee rate (${quote.bps}) is not a usable ceiling`,
      { code: 'rate_unusable', routerAddress: quote.routerAddress ?? null },
    )
  }
  return bps
}
