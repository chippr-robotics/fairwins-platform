// Spec 043 (US2) — SafeProposalHub client: broadcast a proposal preimage, read+verify proposals from chain,
// and the never-stranded EIP-712 payload link/QR fallback. SECURITY: a proposal's integrity is never trusted
// from the hub — every read proposal is reconstructed and its safeTxHash recomputed locally (verifyProposal);
// a mismatch is discarded. See research.md Decision 4.

// Spec 110 T028 — off ethers. The broadcasts below used an ethers `Contract` with a second,
// hand-maintained copy of the propose/cancel argument list; they now send the calldata their own
// pure twins (`emitProposalCall` / `cancelProposalCall`) already build, so there is ONE encoder and
// ONE argument order for each call instead of two that could drift apart. Verified byte-identical
// to the ethers `Interface` over the value/data/nonce extremes before the swap.
import { encodeFunctionData } from 'viem'
import { SAFE_PROPOSAL_HUB_ABI } from '../../abis/SafeProposalHub'
import { scanLogs } from '../chain/logScan'
import { eventScanHandle } from '../chains/eventScan'
import { normalizeAbi, NoRpcEndpointError } from '../chains/readContract'
import { getAddress } from '../evm/address'
import { buildSafeTx, computeSafeTxHash } from './vaultTransaction'

const HUB = normalizeAbi(SAFE_PROPOSAL_HUB_ABI)

/**
 * ethers' `toBeHex`, kept byte-exact on purpose.
 *
 * This is a WIRE FORMAT — `encodePayloadLink` is the never-stranded fallback a member hands to
 * somebody else's device — and viem's `toHex` is not the same function: ethers pads to whole BYTES
 * (`0n` -> `0x00`, `15n` -> `0x0f`, `256n` -> `0x0100`) where viem emits minimal nibbles (`0x0`,
 * `0xf`, `0x100`). Every form round-trips through `BigInt()` to the same value, so nothing would
 * have BROKEN — but a link is a string that other code may compare, log or key on, and three lines
 * is cheaper than being sure nothing does.
 */
function toBeHex(value) {
  const body = BigInt(value).toString(16)
  return '0x' + (body.length % 2 ? '0' + body : body)
}

/** Broadcast a proposal's preimage to the hub. */
export async function emitProposal({ hubAddress, safe, safeTx, safeTxHash, signer }) {
  const call = emitProposalCall({ hubAddress, safe, safeTx, safeTxHash })
  return signer.sendTransaction({ to: call.target, data: call.data })
}

/** Signal cancellation of a proposal (advisory). */
export async function cancelProposal({ hubAddress, safe, safeTxHash, signer }) {
  const call = cancelProposalCall({ hubAddress, safe, safeTxHash })
  return signer.sendTransaction({ to: call.target, data: call.data })
}

/**
 * Pure calldata for `hub.propose(...)` — a `{target,data,value}` call for the passkey rail (sendCalls).
 * Byte-identical to what `emitProposal` sends, minus the signer/broadcast.
 */
export function emitProposalCall({ hubAddress, safe, safeTx, safeTxHash }) {
  return {
    target: getAddress(hubAddress),
    data: encodeFunctionData({ abi: HUB, functionName: 'propose', args: [
      getAddress(safe),
      safeTx.to,
      safeTx.value,
      safeTx.data,
      safeTx.operation,
      safeTx.nonce,
      safeTxHash,
    ] }),
    value: 0n,
  }
}

/** Pure calldata for `hub.cancel(...)` — a `{target,data,value}` call for the passkey rail (sendCalls). */
export function cancelProposalCall({ hubAddress, safe, safeTxHash }) {
  return {
    target: getAddress(hubAddress),
    data: encodeFunctionData({ abi: HUB, functionName: 'cancel', args: [getAddress(safe), safeTxHash] }),
    value: 0n,
  }
}

/** Reconstruct a full SafeTx + metadata from decoded `Proposed` event args. Pure. */
export function reconstructProposal(args) {
  const safeTx = buildSafeTx({
    to: args.to,
    value: args.value,
    data: args.data,
    operation: Number(args.operation),
    nonce: args.nonce,
  })
  return {
    safe: getAddress(args.safe),
    proposer: getAddress(args.proposer),
    safeTxHash: args.safeTxHash,
    safeTx,
    to: safeTx.to,
    value: safeTx.value,
    data: safeTx.data,
    operation: safeTx.operation,
    nonce: safeTx.nonce,
  }
}

/**
 * Verify a reconstructed proposal: recompute the Safe tx hash from its own parameters and compare to the
 * emitted safeTxHash. Returns true only when they match (tampered/malformed preimages are rejected). Pure.
 */
export function verifyProposal(proposal, chainId) {
  const recomputed = computeSafeTxHash(proposal.safe, chainId, proposal.safeTx)
  return recomputed.toLowerCase() === String(proposal.safeTxHash).toLowerCase()
}

/**
 * Read all VERIFIED proposals for a vault from the hub. Decodes `Proposed` logs, reconstructs each, and keeps
 * only those whose recomputed hash matches. Also returns the set of cancelled hashes.
 *
 * The two events are scanned as ONE bounded, resumable pass (`lib/chain/logScan`): the hub is ~1.8M blocks
 * old on Polygon and the app's default RPC caps a single `eth_getLogs` at 10,000 blocks, so the previous
 * one-shot `queryFilter` from the deploy block could only ever fail there. `complete` is false while a
 * budgeted backfill is still catching up — a caller MUST NOT read that as "this vault has no proposals".
 *
 * @returns {Promise<{proposals: object[], cancelled: Set<string>, complete: boolean}>}
 */
export async function readVerifiedProposals({ hubAddress, safeAddress, chainId, contract, fromBlock = 0, maxChunks }) {
  // The scan reads on the chain the vault's instance lives on — NAMED, never inferred from whatever
  // transport was handed in (spec 110). `contract` stays injectable for tests and for a caller that
  // already holds a handle; the default satisfies scanLogs' duck contract from the chain seam.
  const hub = contract ?? eventScanHandle(chainId, { address: getAddress(hubAddress), abi: SAFE_PROPOSAL_HUB_ABI })
  if (!hub) throw new NoRpcEndpointError(chainId)
  const safeTopic = getAddress(safeAddress)
  const { logs, complete } = await scanLogs({
    contract: hub,
    filters: [hub.filters.Proposed(safeTopic), hub.filters.Cancelled(safeTopic)],
    fromBlock,
    chainId,
    maxChunks,
  })

  const cancelled = new Set(
    logs.filter((l) => l.eventName === 'Cancelled').map((l) => String(l.args.safeTxHash).toLowerCase()),
  )
  const proposals = []
  for (const log of logs) {
    if (log.eventName !== 'Proposed') continue
    try {
      const p = reconstructProposal(log.args)
      if (verifyProposal(p, chainId)) {
        proposals.push({ ...p, blockNumber: log.blockNumber, cancelled: cancelled.has(String(p.safeTxHash).toLowerCase()) })
      }
    } catch {
      /* malformed log — skip */
    }
  }
  return { proposals, cancelled, complete }
}

// --- Never-stranded fallback: shareable EIP-712 payload link/QR (no hub required) ---

const PAYLOAD_SCHEMA = 'fairwins-safe-proposal-v1'

/** Serialize a proposal into a compact, shareable payload string (base64url of JSON). Pure. */
export function encodePayloadLink(safe, safeTx, chainId) {
  const payload = {
    schema: PAYLOAD_SCHEMA,
    chainId: Number(chainId),
    safe: getAddress(safe),
    tx: {
      to: safeTx.to,
      value: toBeHex(safeTx.value),
      data: safeTx.data,
      operation: safeTx.operation,
      nonce: toBeHex(safeTx.nonce),
    },
  }
  return base64UrlEncode(JSON.stringify(payload))
}

/**
 * Parse a payload string back into { safe, safeTx, chainId }. The caller MUST recompute the hash and verify
 * before acting — this function does not establish trust, only transport. Pure.
 */
export function parsePayloadLink(link) {
  const obj = JSON.parse(base64UrlDecode(String(link)))
  if (obj?.schema !== PAYLOAD_SCHEMA) throw new Error('Unrecognized proposal payload')
  const safeTx = buildSafeTx({
    to: obj.tx.to,
    value: BigInt(obj.tx.value),
    data: obj.tx.data,
    operation: Number(obj.tx.operation),
    nonce: BigInt(obj.tx.nonce),
  })
  return { safe: getAddress(obj.safe), chainId: Number(obj.chainId), safeTx }
}

function base64UrlEncode(str) {
  // btoa/atob are present in browsers and in the jsdom test environment.
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(s) {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4
  if (pad) b64 += '='.repeat(4 - pad) // some atob implementations require '=' padding
  return atob(b64)
}
