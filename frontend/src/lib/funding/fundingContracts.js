/**
 * Contract wiring for funding pools (spec 103). Addresses come from the synced config
 * (`getContractAddressForChain`), never hardcoded (Principle V); ABIs are derived from the compiled
 * artifacts (`src/abis/FundingPool*.js`).
 */
import { encodeFunctionData } from 'viem'
import { readContract, normalizeAbi } from '../chains/readContract'
import { FUNDING_POOL_FACTORY_ABI } from '../../abis/FundingPoolFactory'
import { FUNDING_POOL_ABI } from '../../abis/FundingPool'
import { getContractAddressForChain } from '../../config/contracts'

export { ERC20_ABI } from '../pools/poolContracts'

/** The FundingPoolFactory address for `chainId`, or undefined/'' if not deployed there. */
export function getFundingFactoryAddress(chainId) {
  try {
    return getContractAddressForChain('fundingPoolFactory', chainId)
  } catch {
    return undefined
  }
}

/** True when funding pools are deployed on `chainId`. */
export function isFundingAvailable(chainId) {
  const a = getFundingFactoryAddress(chainId)
  return typeof a === 'string' && a.length === 42
}

/**
 * Read one function on the factory for `chainId`. Throws if funding pools are not deployed there —
 * the same refusal `getFundingFactory` made, kept as a throw rather than a null so a caller cannot
 * mistake "not available here" for "read returned nothing".
 */
export function readFundingFactory(chainId, functionName, args = []) {
  const address = getFundingFactoryAddress(chainId)
  if (!address) throw new Error(`Funding pools are not available on this network (chain ${chainId}).`)
  return readContract(chainId, { address, abi: FUNDING_POOL_FACTORY_ABI, functionName, args })
}

/** Read one function on a pool clone. */
export function readFundingPool(chainId, address, functionName, args = []) {
  return readContract(chainId, { address, abi: FUNDING_POOL_ABI, functionName, args })
}

/** Calldata for a factory call (the `Interface.encodeFunctionData` this replaces). */
export function encodeFactoryCall(functionName, args) {
  return encodeFunctionData({ abi: normalizeAbi(FUNDING_POOL_FACTORY_ABI), functionName, args })
}

/** Calldata for a pool-clone call. */
export function encodePoolCall(functionName, args) {
  return encodeFunctionData({ abi: normalizeAbi(FUNDING_POOL_ABI), functionName, args })
}

export { FUNDING_POOL_ABI, FUNDING_POOL_FACTORY_ABI }

export const FUNDING_STATE = ['Open', 'Closed', 'Refunding']
export const FUNDING_STATE_DISPLAY = ['Open', 'Closed', 'Refunding']
export const REFUND_REASON = { 0: null, 1: 'organizer', 2: 'majority', 3: 'deadline' }
export const REFUND_REASON_TEXT = {
  organizer: 'The organizer chose to refund everyone.',
  majority: 'A majority of contributors voted to refund.',
  deadline: 'The settlement deadline passed without the organizer closing.',
}

/** User-facing label for a pool state. */
export function fundingStateDisplay(state) {
  return FUNDING_STATE_DISPLAY[Number(state)] ?? 'Unknown'
}
