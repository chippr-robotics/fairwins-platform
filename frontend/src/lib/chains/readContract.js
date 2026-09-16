/**
 * readContract(chainId, …) — THE chain-parameterized contract read (spec 110 Phase 1, #1592).
 *
 * The read-path shape every surface converges on: the chain is an ARGUMENT, exactly as it is
 * for `getReadProvider` and the estate reads (specs 069/071), and the call needs no wallet on
 * any chain. One touch per file: converting a call site onto this seam is also what takes it
 * off ethers (`new Contract(addr, abi, provider)` has no chain parameter to pass — that fusion
 * of "where" with "who" is the structural defect issue #1552 documents).
 *
 * ABIs: the app's `src/abis/` carries both JSON fragments and human-readable signature
 * strings; both are accepted here (strings go through viem's parseAbi), so no ABI file needs
 * re-encoding to convert its callers.
 *
 * Error contract: a chain with no endpoint throws NoRpcEndpointError — the loud twin of
 * `getReadProvider`'s null — and every RPC/decode failure propagates, so three-state readers
 * (`read` / `not-deployed` / `unreadable`, spec 071/089) classify exactly as before. Nothing
 * here returns a default, a zero, or a null value for a failed read.
 */
import { parseAbi } from 'viem'
import { getPublicClient } from './publicClient'

export class NoRpcEndpointError extends Error {
  constructor(chainId) {
    super(`no RPC endpoint is configured for chain ${chainId} — the chain cannot be read`)
    this.name = 'NoRpcEndpointError'
    this.chainId = chainId
  }
}

const parsedAbiCache = new WeakMap()

/** Accept JSON ABIs and human-readable signature arrays alike (cached per array identity). */
export function normalizeAbi(abi) {
  if (!Array.isArray(abi) || abi.length === 0 || typeof abi[0] !== 'string') return abi
  let parsed = parsedAbiCache.get(abi)
  if (!parsed) {
    // ethers v6 spells a struct `tuple(address x, …)`; abitype wants the bare
    // parenthesized form `(address x, …)`. Same grammar otherwise — rewrite the keyword
    // so the repo's ethers-era ABI files parse unchanged.
    parsed = parseAbi(abi.map((fragment) => fragment.replace(/\btuple\(/g, '(')))
    parsedAbiCache.set(abi, parsed)
  }
  return parsed
}

/**
 * Read one contract function on a named chain.
 *
 * @param {number} chainId - the chain the contract lives on (never ambient state)
 * @param {object} call
 * @param {string} call.address
 * @param {Array}  call.abi - JSON ABI or human-readable signatures
 * @param {string} call.functionName
 * @param {Array}  [call.args]
 * @param {bigint|'latest'|string} [call.blockNumber] - optional pinned block / tag
 * @returns {Promise<unknown>} the decoded result (bigints for integers, as ethers v6 returned)
 */
export async function readContract(chainId, { address, abi, functionName, args, blockNumber }) {
  const client = getPublicClient(chainId)
  if (!client) throw new NoRpcEndpointError(chainId)
  return client.readContract({
    address,
    abi: normalizeAbi(abi),
    functionName,
    ...(args !== undefined ? { args } : {}),
    ...(blockNumber !== undefined
      ? typeof blockNumber === 'bigint'
        ? { blockNumber }
        : { blockTag: blockNumber }
      : {}),
  })
}
