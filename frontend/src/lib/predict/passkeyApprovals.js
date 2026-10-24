/**
 * First-trade approvals for passkey CLOB trading (spec 057, FR-019) — the on-chain prerequisite an
 * EOA trader normally sets on Polymarket's own site, which a passkey (embedded) account cannot visit.
 *
 * The CLOB settles trades on-chain: the exchanges pull USDC (buys) and conditional-token shares
 * (sells) straight from the MAKER, so the passkey account must approve the three settlement
 * contracts — CTF Exchange, NegRisk CTF Exchange, NegRisk Adapter — for both assets. Addresses come
 * from the SDK's own `getContractConfig` (never hand-typed; one source with the order signing).
 *
 * `missingPredictApprovals` READS current allowances (read provider, no wallet) and returns only the
 * calls actually needed, shaped for `WalletContext.sendCalls` — ONE batched UserOp ceremony covers
 * all of them (spec 041 FR-016), and that first UserOp also deploys a counterfactual account
 * (FR-007). Approvals are unlimited (MaxUint256 / setApprovalForAll true), the CLOB's operating
 * model: exact-amount allowances would cost the member a gas-bearing ceremony per trade. An account
 * with every approval in place returns [] — no ceremony, byte-identical repeat-trade flow.
 */

import { decodeFunctionResult, encodeFunctionData, maxUint256, parseAbi } from 'viem'
import { getContractConfig } from '@polymarket/clob-client'
import { readContract } from '../chains/readContract'

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
])
const CTF_ABI = parseAbi([
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
])

// "Approved" means effectively-unlimited. A small stale allowance (e.g. from an exact-amount
// approve) would let the first trades through and then strand a later one mid-flow — re-approve
// below half of MaxUint256 so the check is one-shot per account, not per trade.
const APPROVAL_FLOOR = maxUint256 / 2n

/** The three CLOB settlement spenders for a chain, from the SDK's contract config. */
export function predictSpenders(chainId, { contractConfig } = {}) {
  const cfg = contractConfig ?? getContractConfig(chainId)
  return {
    collateral: cfg.collateral,
    conditionalTokens: cfg.conditionalTokens,
    spenders: [cfg.exchange, cfg.negRiskExchange, cfg.negRiskAdapter],
  }
}

/**
 * The approval calls this account still needs before it can trade, or [] when trading-ready.
 *
 * @param {object} opts
 *   address     the maker (passkey account)
 *   chainId     137 — Predict is Polygon-only
 *   provider    optional read provider override (tests); defaults to getReadProvider(chainId)
 *   contractConfig  test seam for the SDK config
 * @returns {Promise<Array<{ target: string, data: string, label: string }>>}
 */
export async function missingPredictApprovals({ address, chainId, provider, contractConfig } = {}) {
  const { collateral, conditionalTokens, spenders } = predictSpenders(chainId, { contractConfig })
  // `provider` remains a test seam: when a caller injects a reader, its `call` is used exactly as
  // before. Otherwise the reads go through the chain seam, which names the chain (spec 110)
  // instead of inheriting it from whichever provider was built.
  const readVia = provider
    ? async (to, abi, functionName, args) => {
        const raw = await provider.call({ to, data: encodeFunctionData({ abi, functionName, args }) })
        // ethers' `call` answers with the return bytes; a viem client wraps them in `{ data }`.
        return decodeFunctionResult({ abi, functionName, data: typeof raw === 'string' ? raw : raw?.data })
      }
    : (to, abi, functionName, args) => readContract(chainId, { address: to, abi, functionName, args })

  const readAllowance = (spender) => readVia(collateral, ERC20_ABI, 'allowance', [address, spender])
  const readApprovedForAll = (spender) =>
    readVia(conditionalTokens, CTF_ABI, 'isApprovedForAll', [address, spender])

  const checks = await Promise.all(
    spenders.flatMap((spender) => [
      readAllowance(spender).then((a) => ({ spender, asset: 'usdc', ok: a >= APPROVAL_FLOOR })),
      readApprovedForAll(spender).then((ok) => ({ spender, asset: 'ctf', ok })),
    ])
  )

  return checks
    .filter((c) => !c.ok)
    .map(({ spender, asset }) =>
      asset === 'usdc'
        ? {
            target: collateral,
            data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, maxUint256] }),
            label: `Approve USDC for ${spender}`,
          }
        : {
            target: conditionalTokens,
            data: encodeFunctionData({ abi: CTF_ABI, functionName: 'setApprovalForAll', args: [spender, true] }),
            label: `Approve outcome shares for ${spender}`,
          }
    )
}
