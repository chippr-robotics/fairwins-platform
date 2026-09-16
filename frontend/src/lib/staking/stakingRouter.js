/**
 * StakingRouter read + stake-call layer (spec 066).
 *
 * The member app reads the on-chain control surface at runtime and overlays its
 * provider addresses / validator allowlist / paused flag onto the spec-065 options.
 * When the router is undeployed or unreadable this returns `null` and callers fall
 * back to the spec-065 build-time constants verbatim (fee-free, direct staking) — a
 * backwards-compatible, honest-state rollout (FR-009). The fee-bearing path is gated
 * separately by `fetchFeeQuote` (a present-but-unreadable router blocks only that
 * path — never assume a lower rate).
 *
 * It also builds the LIQUID router stake calls (`{ target, data, value }` for the
 * spec-041 unified send rail): Lido stakes native ETH via `value` (no approve leg);
 * sPOL approves the router then calls `stakeSpol`. Delegated staking never routes
 * here (fee-free v1 — a direct `ValidatorShare` call).
 */
import { encodeFunctionData, parseAbi } from 'viem'
import { STAKING_ROUTER_ABI } from '../../abis/StakingRouter'
import { getContractAddressForChain } from '../../config/contracts'
import { readContract, normalizeAbi } from '../chains/readContract'

const ROUTER_ABI = normalizeAbi(STAKING_ROUTER_ABI)
const ERC20_APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

/** Resolve the router address for a chain, or null when it isn't deployed. */
export function getStakingRouterAddress(chainId) {
  const addr = getContractAddressForChain('stakingRouter', chainId)
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? addr : null
}

const safe = (p) => p.then((v) => v).catch(() => undefined)

/**
 * Read the router's managed config for a chain: provider addresses, the validator
 * allowlist, and the paused flag. Returns `null` when no router is deployed OR a
 * core read fails (caller then keeps the spec-065 constants). One missing optional
 * getter never blanks the whole overlay.
 *
 * @returns {Promise<null | { routerAddress, providers, validators, paused }>}
 */
export async function readStakingRouterConfig({ chainId, provider }) {
  const routerAddress = getStakingRouterAddress(chainId)
  if (!routerAddress || !provider) return null

  // Spec 110 Phase 1: reads through the chain seam; `provider` stays the availability gate.
  const routerRead = (functionName, args) =>
    readContract(chainId, { address: routerAddress, abi: ROUTER_ABI, functionName, args })
  // `paused` is the load-bearing read — if even it fails, treat the router as unreadable
  // and fall back to the constants (never guess availability).
  const paused = await safe(routerRead('paused'))
  if (paused === undefined) return null

  const [lidoSteth, lidoWsteth, spolController, spolToken, polToken, polygonStakeManager, count] =
    await Promise.all([
      safe(routerRead('lidoSteth')),
      safe(routerRead('lidoWsteth')),
      safe(routerRead('spolController')),
      safe(routerRead('spolToken')),
      safe(routerRead('polToken')),
      safe(routerRead('polygonStakeManager')),
      safe(routerRead('validatorCount')),
    ])

  const validators = []
  if (count !== undefined) {
    const n = Number(count)
    const entries = await Promise.all(
      Array.from({ length: n }, (_, i) => safe(routerRead('validatorAt', [BigInt(i)]))),
    )
    for (const v of entries) if (v) validators.push(v)
  }

  return {
    routerAddress,
    providers: {
      lido: { steth: lidoSteth, wsteth: lidoWsteth },
      spol: { controller: spolController, token: spolToken },
      polygon: { polToken, stakeManager: polygonStakeManager },
    },
    validators,
    paused: Boolean(paused),
  }
}

/**
 * Lido router stake — native ETH via `value`, no approve leg.
 * @returns {{ calls: Array<{target,data,value}>, requiresApproval: boolean }}
 */
export function buildLidoRouterStakeCalls({ routerAddress, amount, maxFeeBps }) {
  return {
    calls: [
      {
        target: routerAddress,
        data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'stakeLido', args: [BigInt(maxFeeBps)] }),
        value: amount,
      },
    ],
    requiresApproval: false,
  }
}

/**
 * sPOL router stake — approve the router for POL, then `stakeSpol`.
 * @returns {{ calls: Array<{target,data,value}>, requiresApproval: boolean }}
 */
export function buildSpolRouterStakeCalls({ routerAddress, polToken, amount, maxFeeBps }) {
  return {
    calls: [
      {
        target: polToken,
        data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [routerAddress, amount] }),
        value: 0n,
      },
      {
        target: routerAddress,
        data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'stakeSpol', args: [amount, BigInt(maxFeeBps)] }),
        value: 0n,
      },
    ],
    requiresApproval: true,
  }
}
