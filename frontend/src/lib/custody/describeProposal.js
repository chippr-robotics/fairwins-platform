// Spec 105 — plain-language proposal descriptions for the vault Queue (US5). Decodes only what it
// POSITIVELY recognises; anything else returns null and the caller keeps the honest raw rendering
// — a guessed description of a money movement is worse than calldata (constitution III).

import { decodeFunctionData, getAddress, parseAbi } from 'viem'
import { formatUnits } from '../evm/units'
import { classifyPolicyProposalV2 } from './policyV2'

const ERC20_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])
const SAFE_MGMT_ABI = parseAbi([
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold)',
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
  'function changeThreshold(uint256 _threshold)',
])

// ethers' iface.decodeFunctionData('name', data) threw on a selector mismatch, and the
// describe cascade RELIES on that throw to fall through. viem matches by selector across the
// whole ABI, so the name check is restated explicitly.
function decodeAs(abi, functionName, data) {
  const decoded = decodeFunctionData({ abi, data })
  if (decoded.functionName !== functionName) throw new Error('selector mismatch')
  return decoded.args
}

const short = (a) => {
  const x = getAddress(a)
  return `${x.slice(0, 6)}…${x.slice(-4)}`
}

/**
 * Describe one queued proposal, or return null for the raw rendering.
 * @param {{to:string,value?:bigint|string,data?:string,chainId?:number}} proposal
 * @param {{ chainId?:number, vaultAddress?:string,
 *           assetMeta?: Record<string,{symbol:string,decimals:number}>,
 *           nativeSymbol?: string,
 *           resolveName?: (address:string)=>string|null }} opts
 * @returns {{kind:string, title:string, detail:string|null}|null}
 */
export function describeProposal(proposal, opts = {}) {
  if (!proposal?.to) return null
  const { chainId, vaultAddress, assetMeta = {}, nativeSymbol, resolveName } = opts
  const name = (addr) => {
    try {
      return (resolveName && resolveName(getAddress(addr))) || short(addr)
    } catch {
      return String(addr)
    }
  }
  const data = proposal.data ?? '0x'
  const value = BigInt(proposal.value ?? 0)

  // Native send: value with no calldata.
  if (data === '0x' && value > 0n) {
    // Without a known native symbol, an amount alone still beats raw calldata — but only when the
    // symbol is knowable; otherwise stay honest and let the raw form show the wei.
    if (!nativeSymbol) return null
    return {
      kind: 'transfer-native',
      title: `Send ${trimAmount(formatUnits(value, 18))} ${nativeSymbol}`,
      detail: `to ${name(proposal.to)}`,
      counterparty: getAddress(proposal.to),
    }
  }

  // ERC-20 transfer — described ONLY when the token's meta is known; formatting an amount with
  // guessed decimals would state a wrong number, which is worse than none.
  try {
    const [to, amount] = decodeAs(ERC20_ABI, 'transfer', data)
    const meta = assetMeta[getAddress(proposal.to)]
    if (!meta) return null
    return {
      kind: 'transfer-erc20',
      title: `Send ${trimAmount(formatUnits(amount, meta.decimals))} ${meta.symbol}`,
      detail: `to ${name(to)}`,
      counterparty: getAddress(to),
    }
  } catch {
    /* not an ERC-20 transfer */
  }

  // Safe self-management (to === the vault).
  if (vaultAddress) {
    try {
      if (getAddress(proposal.to) === getAddress(vaultAddress)) {
        const described = describeSafeManagement(data, name)
        if (described) return described
      }
    } catch {
      /* invalid address in proposal — raw rendering */
    }
  }

  // Policy governance (guard / setGuard) via the existing classifier.
  if (chainId != null) {
    const policy = classifyPolicyProposalV2(proposal, chainId, vaultAddress)
    if (policy) {
      const titles = {
        'set-rules': 'Change the vault rules',
        'adopt-v2': 'Turn on the vault rules',
        'remove-guard': 'Remove the vault rules',
        'set-guard': 'Change the rules engine',
      }
      return { kind: 'policy', title: titles[policy.kind] || 'Policy change', detail: null }
    }
  }

  return null
}

function describeSafeManagement(data, name) {
  try {
    const [owner] = decodeAs(SAFE_MGMT_ABI, 'addOwnerWithThreshold', data)
    return { kind: 'add-owner', title: 'Add owner', detail: name(owner) }
  } catch { /* next */ }
  try {
    const [, owner] = decodeAs(SAFE_MGMT_ABI, 'removeOwner', data)
    return { kind: 'remove-owner', title: 'Remove owner', detail: name(owner) }
  } catch { /* next */ }
  try {
    const [, oldOwner, newOwner] = decodeAs(SAFE_MGMT_ABI, 'swapOwner', data)
    return { kind: 'swap-owner', title: 'Replace owner', detail: `${name(oldOwner)} → ${name(newOwner)}` }
  } catch { /* next */ }
  try {
    const [threshold] = decodeAs(SAFE_MGMT_ABI, 'changeThreshold', data)
    return { kind: 'change-threshold', title: 'Change approvals needed', detail: `${threshold} required` }
  } catch { /* not management */ }
  return null
}

/** "200.0" → "200", "0.5000" → "0.5" — display only; nothing sent is ever rounded. */
function trimAmount(s) {
  return String(s).replace(/\.?0+$/, '') || '0'
}

/**
 * Does this pending item need THIS member's signature to progress?
 * True iff it is pending, the member is an owner, and they have not already approved.
 */
export function needsYou(proposal, member) {
  if (!proposal || !member) return false
  if (proposal.status && proposal.status !== 'pending') return false
  let me
  try {
    me = getAddress(member)
  } catch {
    return false
  }
  const owners = (proposal.owners || []).map((o) => getAddress(o))
  if (owners.length > 0 && !owners.includes(me)) return false
  const approvers = (proposal.approvers || []).map((a) => getAddress(a))
  return !approvers.includes(me)
}
