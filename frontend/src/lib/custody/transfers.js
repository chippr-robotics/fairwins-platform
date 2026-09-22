// Spec 043 (US2) — build a transfer SafeTx payload for the vault: native asset or an ERC-20. Pure.

import { encodeFunctionData, getAddress, parseAbi } from 'viem'
import { parseEther, parseUnits } from '../evm/units'

const ERC20_ABI = parseAbi(['function transfer(address to, uint256 amount)'])

/**
 * @param {{recipient:string, amount:string|number, tokenAddress?:string|null, decimals?:number}} args
 * @returns {{to:string, value:bigint, data:string, operation:number}}
 */
export function buildTransferPayload({ recipient, amount, tokenAddress, decimals }) {
  const to = getAddress(recipient)
  if (tokenAddress) {
    const value = parseUnits(String(amount), Number(decimals ?? 18))
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, value] })
    return { to: getAddress(tokenAddress), value: 0n, data, operation: 0 }
  }
  return { to, value: parseEther(String(amount)), data: '0x', operation: 0 }
}
