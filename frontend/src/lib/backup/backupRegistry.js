// Spec 032 — the on-chain backup locator. Reads the per-wallet pointer from the canonical-network registry
// (free, via a read-only provider — works regardless of the member's connected network) and writes it with
// the member's signer. Gracefully reports "unavailable" until the registry is deployed + address-synced.

import { encodeFunctionData } from 'viem'
import { isAddress } from '../evm/address'
import { normalizeAbi, readContract } from '../chains/readContract'
import { getContractAddressForChain } from '../../config/contracts'
import { BACKUP_POINTER_REGISTRY_ABI, BACKUP_CANONICAL_CHAIN_ID } from '../../abis/backupPointerRegistry'

export const CANONICAL_CHAIN_ID = BACKUP_CANONICAL_CHAIN_ID

const ABI = normalizeAbi(BACKUP_POINTER_REGISTRY_ABI)

/**
 * The CID must be a STRING, and this check is not defensive noise — it is a refusal ethers used to
 * perform for free and viem does not (spec 110, divergence (i)).
 *
 * `new Interface(...).encodeFunctionData('setPointer', [x])` THREW for any non-string `x`. viem's
 * `encodeFunctionData` STRINGIFIES it instead: `null` encodes as the four-character CID `"null"`,
 * `undefined` and `{}` as `""` and `"[object Object]"`. Both outcomes are silent damage to the one
 * record that says where a member's backup is — `""` is this contract's documented CLEAR value, so
 * a stray `undefined` erases the pointer, and `"null"` leaves a pointer that resolves to nothing
 * while reading, to every surface, as a backup that exists.
 */
function requireCid(cid) {
  if (typeof cid !== 'string') {
    throw new TypeError('backupRegistry: cid must be a string ("" clears the pointer)')
  }
  return cid
}

function registryAddress() {
  return getContractAddressForChain('backupPointerRegistry', CANONICAL_CHAIN_ID)
}

/** Whether the backup registry is deployed + configured on the canonical network. */
export function isBackupAvailable() {
  const addr = registryAddress()
  return !!addr && isAddress(addr)
}

/**
 * Read a wallet's latest backup pointer (CID). Returns "" when there is genuinely no pointer (or the registry
 * isn't configured), and `null` when the read could not be completed (RPC unreachable) — so callers can tell
 * "no backup" apart from "couldn't check" (honest state). Free (read-only provider).
 */
export async function readPointer(owner) {
  if (!isBackupAvailable() || !owner) return ''
  try {
    return await readContract(CANONICAL_CHAIN_ID, {
      address: registryAddress(),
      abi: ABI,
      functionName: 'getPointer',
      args: [owner],
    })
  } catch {
    return null // inconclusive read — not the same as "no pointer"
  }
}

/** Write (or clear with "") the caller's pointer on the canonical network. Requires that network + gas. */
export async function writePointer(signer, cid) {
  if (!isBackupAvailable()) throw new Error('Backup registry is not available on the canonical network yet')
  const tx = await signer.sendTransaction({
    to: registryAddress(),
    data: encodeFunctionData({ abi: ABI, functionName: 'setPointer', args: [requireCid(cid)] }),
  })
  return tx.wait()
}

/**
 * Encode the `setPointer(cid)` call for passkey (smart-account) sessions, which write through `sendCalls`
 * rather than an ethers signer. Returns a `{ target, data }` call the caller batches into one ceremony.
 * `cid` "" clears the pointer, mirroring {@link writePointer}.
 */
export function buildSetPointerCall(cid) {
  if (!isBackupAvailable()) throw new Error('Backup registry is not available on the canonical network yet')
  return {
    target: registryAddress(),
    data: encodeFunctionData({ abi: ABI, functionName: 'setPointer', args: [requireCid(cid)] }),
  }
}
