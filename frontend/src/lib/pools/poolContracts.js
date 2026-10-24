/**
 * Contract wiring for Wager Pools (spec 034, address-based — Semaphore removed). Addresses come from the
 * synced config (`getContractAddressForChain`), never hardcoded (Principle V); ABIs are mirrored from the
 * compiled artifacts.
 */
import { encodeFunctionData } from 'viem'
import { readContract, normalizeAbi } from '../chains/readContract'
import { WAGER_POOL_FACTORY_ABI } from '../../abis/WagerPoolFactory'
import { WAGER_POOL_ABI } from '../../abis/WagerPool'
import { getContractAddressForChain } from '../../config/contracts'

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]

/** The WagerPoolFactory address for `chainId`, or undefined if not deployed there. */
export function getFactoryAddress(chainId) {
  return getContractAddressForChain('wagerPoolFactory', chainId)
}

/**
 * Read one function on the factory for `chainId`. Throws if wager pools are not deployed there —
 * the same refusal `getFactory` made, kept as a throw rather than a null so a caller cannot
 * mistake "not available here" for "read returned nothing".
 */
export function readPoolFactory(chainId, functionName, args = []) {
  const address = getFactoryAddress(chainId)
  if (!address) throw new Error(`Wager pools are not available on this network (chain ${chainId}).`)
  return readContract(chainId, { address, abi: WAGER_POOL_FACTORY_ABI, functionName, args })
}

/** Read one function on a pool clone. */
export function readPool(chainId, address, functionName, args = []) {
  return readContract(chainId, { address, abi: WAGER_POOL_ABI, functionName, args })
}

/** Calldata for a factory call (the `Interface.encodeFunctionData` this replaces). */
export function encodeFactoryCall(functionName, args) {
  return encodeFunctionData({ abi: normalizeAbi(WAGER_POOL_FACTORY_ABI), functionName, args })
}

/** Calldata for a pool-clone call. */
export function encodePoolCall(functionName, args) {
  return encodeFunctionData({ abi: normalizeAbi(WAGER_POOL_ABI), functionName, args })
}

export { WAGER_POOL_ABI, WAGER_POOL_FACTORY_ABI }

export const POOL_STATE = ['JoiningOpen', 'JoiningClosed', 'Resolved', 'Cancelled']

/**
 * Human display labels for POOL_STATE (tester feedback: the raw enum name "JoiningOpen" leaked into
 * the UI). Keep POOL_STATE as the stable enum-name mapping; render THIS in user-facing surfaces.
 */
export const POOL_STATE_DISPLAY = ['Open', 'Closed — resolving', 'Resolved', 'Cancelled']

/** User-facing label for a pool state (falls back to 'Unknown' for an unrecognized value). */
export function poolStateDisplay(state) {
  return POOL_STATE_DISPLAY[Number(state)] ?? 'Unknown'
}
