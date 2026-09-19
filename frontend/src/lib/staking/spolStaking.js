/**
 * sPOL liquid staking (spec 065, contracts/spol-liquid-staking.md).
 *
 * Non-custodial calls from the member's wallet against Polygon's official
 * native LST controller on Ethereum L1. Members hold sPOL (exchange-rate,
 * value-accruing). Stake: approve POL → buySPOL. Exit: sellSPOL → unbonding
 * nonce → withdrawPOL after the wait, OR an instant DEX swap of the liquid
 * token. rewardFee is Polygon's fee (on rewards), read for honest disclosure.
 *
 * Spec 110 Phase 1: reads go through the chain seam — the chain is an argument
 * (`chainId`), never an ambient provider.
 */
import { encodeFunctionData } from 'viem'
import { SPOL_CONTROLLER_ABI, SPOL_TOKEN_ABI } from '../../abis/SPOLController'
import { POL_TOKEN_ABI } from '../../abis/PolygonValidatorShare'
import { readContract, normalizeAbi } from '../chains/readContract'

const CONTROLLER_ABI = normalizeAbi(SPOL_CONTROLLER_ABI)
const TOKEN_ABI = normalizeAbi(SPOL_TOKEN_ABI)
const POL_ABI = normalizeAbi(POL_TOKEN_ABI)

const WAD = 1_000_000_000_000_000_000n // 1e18

/**
 * Read the member's sPOL position on a named chain.
 * Returns { lstBalanceRaw (sPOL), stakedRaw (underlying POL) }.
 */
export async function readSpolPosition({ account, chainId, contracts }) {
  const lstBalanceRaw = await readContract(chainId, {
    address: contracts.token,
    abi: TOKEN_ABI,
    functionName: 'balanceOf',
    args: [account],
  })
  let stakedRaw = 0n
  if (lstBalanceRaw > 0n) {
    stakedRaw = await readContract(chainId, {
      address: contracts.controller,
      abi: CONTROLLER_ABI,
      functionName: 'convertSPOLtoPOL',
      args: [lstBalanceRaw],
    })
  }
  return { lstBalanceRaw, stakedRaw }
}

/** Total POL staked in the pool (TVL numerator), or null on failure. */
export async function readSpolTvl({ chainId, contracts }) {
  try {
    return await readContract(chainId, {
      address: contracts.controller,
      abi: CONTROLLER_ABI,
      functionName: 'totalsPOLBalance',
    })
  } catch {
    return null
  }
}

/** Read Polygon's live sPOL reward fee (bps) for disclosure, or null. */
export async function readSpolRewardFee({ chainId, contracts }) {
  try {
    // rewardFee is per-mille (100 = 10%). Convert to bps for a common unit.
    const perMille = Number(
      await readContract(chainId, {
        address: contracts.controller,
        abi: CONTROLLER_ABI,
        functionName: 'rewardFee',
      }),
    )
    return perMille * 10
  } catch {
    return null
  }
}

/**
 * Stake POL → sPOL. Needs a POL approval to the controller when short.
 * Returns { calls, requiresApproval }.
 */
export async function buildStakeCalls({ contracts, polToken, account, amount, chainId }) {
  const allowance = await readContract(chainId, {
    address: polToken,
    abi: POL_ABI,
    functionName: 'allowance',
    args: [account, contracts.controller],
  })
  const requiresApproval = allowance < amount
  const calls = []
  if (requiresApproval) {
    calls.push({
      target: polToken,
      data: encodeFunctionData({
        abi: POL_ABI,
        functionName: 'approve',
        args: [contracts.controller, amount],
      }),
      value: 0n,
    })
  }
  calls.push({
    target: contracts.controller,
    data: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: 'buySPOL', args: [amount] }),
    value: 0n,
  })
  return { calls, requiresApproval }
}

/** Request an unstake (burn sPOL, open unbonding). Returns { calls }. */
export function buildUnstakeCalls({ contracts, amount }) {
  return {
    calls: [
      {
        target: contracts.controller,
        data: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: 'sellSPOL', args: [amount] }),
        value: 0n,
      },
    ],
  }
}

/** Withdraw matured POL after unbonding. Returns { calls }. */
export function buildWithdrawCalls({ contracts }) {
  return {
    calls: [
      {
        // The zero-arg overload of the overloaded withdrawPOL()/withdrawPOL(address)
        // pair — viem selects it by the empty args list.
        target: contracts.controller,
        data: encodeFunctionData({ abi: CONTROLLER_ABI, functionName: 'withdrawPOL', args: [] }),
        value: 0n,
      },
    ],
  }
}

/**
 * Read the member's open sPOL unbonds and whether each is ready.
 * A nonce is ready once its withdrawEpoch has passed the delay — the contract
 * enforces this, so `getUserOpenNonces` returning it as still-open with a
 * withdrawEpoch in the past is our ready signal, compared to the current epoch
 * supplied by the caller (from the StakeManager).
 * Returns [{ unbondNonce, shares, withdrawEpoch, amountRaw, ready }].
 */
export async function readSpolOpenNonces({ contracts, account, chainId, currentEpoch, withdrawalDelay }) {
  const rows = await readContract(chainId, {
    address: contracts.controller,
    abi: CONTROLLER_ABI,
    functionName: 'getUserOpenNonces',
    args: [account],
  })
  return rows.map((r) => {
    const withdrawEpoch = BigInt(r.withdrawEpoch)
    const ready =
      currentEpoch != null && withdrawalDelay != null
        ? withdrawEpoch + BigInt(withdrawalDelay) <= BigInt(currentEpoch)
        : false
    return {
      unbondNonce: r.nonce.toString(),
      shares: r.shares,
      withdrawEpoch: withdrawEpoch.toString(),
      amountRaw: r.polAmount,
      ready,
    }
  })
}

/** Convert an sPOL exchange rate reading into a display fraction (informational). */
export function spolRateToFraction(convertSpolToPolForOne) {
  // convertSPOLtoPOL(1e18) returns how much POL 1 sPOL is worth; >1e18 ⇒ gains.
  if (convertSpolToPolForOne == null) return null
  return Number(convertSpolToPolForOne) / Number(WAD)
}
