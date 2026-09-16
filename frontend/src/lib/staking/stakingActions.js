/**
 * Shared staking action helpers (spec 065) — amount validation with a
 * native-coin gas reserve, and a dispatcher that turns a stake request into a
 * `{ target, data, value }` batch for the unified send rail, keyed on the
 * option's provider kind.
 *
 * Pure validators reject bad amounts BEFORE any wallet prompt (constitution
 * III), with member-facing wording.
 */
import { buildStakeCalls as buildLidoStake } from './lidoStaking'
import { buildStakeCalls as buildSpolStake } from './spolStaking'
import { buildDelegateCalls } from './polygonDelegation'
import { buildLidoRouterStakeCalls, buildSpolRouterStakeCalls } from './stakingRouter'

// Reserve left behind when staking a NATIVE coin so the member can still pay
// network fees (Max never strands them). Generous flat reserve in wei.
export const NATIVE_GAS_RESERVE = 3_000_000_000_000_000n // 0.003 ETH

/**
 * Validate a stake amount before any wallet prompt.
 * `isNative` toggles the gas-reserve rule. Returns { ok } | { ok:false, reason }.
 */
export function validateStakeAmount({ amount, walletBalance, isNative, minStakeRaw, maxStakeRaw }) {
  if (amount == null || amount <= 0n) {
    return { ok: false, reason: 'Enter an amount greater than zero.' }
  }
  if (minStakeRaw != null && amount < minStakeRaw) {
    return { ok: false, reason: 'That is below the minimum this option accepts.' }
  }
  if (maxStakeRaw != null && maxStakeRaw > 0n && amount > maxStakeRaw) {
    return { ok: false, reason: 'That is more than this option currently accepts.' }
  }
  if (walletBalance != null) {
    if (isNative) {
      if (amount + NATIVE_GAS_RESERVE > walletBalance) {
        return {
          ok: false,
          reason: 'Leave a little of the coin for network fees — try a smaller amount or use Max.',
        }
      }
    } else if (amount > walletBalance) {
      return { ok: false, reason: 'That is more than you have in your wallet.' }
    }
  }
  return { ok: true }
}

/** The most a member can stake given the gas reserve (drives the Max button). */
export function maxStakeable({ walletBalance, isNative }) {
  if (walletBalance == null) return null
  if (!isNative) return walletBalance
  return walletBalance > NATIVE_GAS_RESERVE ? walletBalance - NATIVE_GAS_RESERVE : 0n
}

/**
 * Build the stake calls for an option, dispatching on providerKind.
 * `ctx` carries { account, amount, chainId, polToken, feeQuote }.
 *
 * spec 066: when a LIQUID staking fee applies (a StakingRouter is deployed AND its
 * per-provider rate is > 0), route through the router's fee-and-forward entrypoint so
 * the fee reaches the treasury atomically; otherwise emit the byte-identical spec-065
 * direct provider calls (SC-003). Delegated staking is fee-free in v1 and ALWAYS uses
 * the direct `ValidatorShare` call.
 * Returns { calls, requiresApproval }.
 */
export async function buildStakeForOption(option, ctx) {
  const { account, amount, polToken } = ctx
  const chainId = ctx.chainId ?? option.chainId
  const feeQuote = ctx.feeQuote || option.feeQuote
  const routerAddress = option.stakingRouterAddress
  const feeApplies = Boolean(feeQuote?.available && feeQuote.bps > 0 && routerAddress)

  switch (option.providerKind) {
    case 'lido':
      return feeApplies
        ? buildLidoRouterStakeCalls({ routerAddress, amount, maxFeeBps: feeQuote.bps })
        : buildLidoStake({ contracts: option.contracts, amount })
    case 'spol':
      return feeApplies
        ? buildSpolRouterStakeCalls({ routerAddress, polToken, amount, maxFeeBps: feeQuote.bps })
        : buildSpolStake({ contracts: option.contracts, polToken, account, amount, chainId })
    case 'validator-share':
      return buildDelegateCalls({
        validatorShare: option.validatorShare,
        stakeManager: option.stakeManager,
        polToken,
        account,
        amount,
        chainId,
      })
    default:
      throw new Error(`Unknown staking provider: ${option.providerKind}`)
  }
}

/** Whether an option stakes a native coin (drives the gas-reserve rule). */
export function optionIsNative(option) {
  // Only Lido stakes the native coin (ETH). sPOL/delegation stake the POL ERC-20.
  return option.providerKind === 'lido'
}
