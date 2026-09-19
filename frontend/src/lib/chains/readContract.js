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
 * Give a multi-output result its parameter NAMES back.
 *
 * This is the one ethers behaviour viem does not reproduce, and it fails silently. A function
 * declared `returns (address token0, address token1, uint24 fee, …)` came back from ethers as a
 * Result addressable BOTH ways — `r[2]` and `r.token0`. viem returns a bare array, so `r.token0`
 * is `undefined`: not an error, not a rejected read, just a field that quietly is not there.
 *
 * That is exactly how it escaped. A caller reading `raw.token0` got `undefined`, treated the
 * position as unreadable, and rendered an EMPTY list — which is indistinguishable from "you have
 * no positions". Every unit test kept passing, because their fakes returned ethers-shaped objects
 * and so answered a question the chain no longer answers. Only the on-chain tier saw it.
 *
 * A single output is left exactly as viem returns it (a lone tuple is already an object with its
 * component names, and wrapping it would change every existing caller). Names are attached
 * non-enumerably so the value still behaves as, spreads as, and compares equal to the array it is.
 */
function withOutputNames(abi, functionName, result) {
  if (!Array.isArray(result)) return result
  const fn = abi.find((f) => f?.type === 'function' && f.name === functionName)
  const outputs = fn?.outputs
  if (!outputs || outputs.length < 2 || outputs.length !== result.length) return result
  for (let i = 0; i < outputs.length; i += 1) {
    const name = outputs[i]?.name
    if (!name || name in result) continue
    Object.defineProperty(result, name, { value: result[i], enumerable: false, configurable: true })
  }
  return result
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
 * @param {string} [call.account] - optional caller for the eth_call (ethers' staticCall
 *   `{ from }`) — a simulation that pays out to msg.sender reads differently per caller
 * @returns {Promise<unknown>} the decoded result (bigints for integers, as ethers v6 returned)
 */
export async function readContract(chainId, { address, abi, functionName, args, blockNumber, account }) {
  const client = getPublicClient(chainId)
  if (!client) throw new NoRpcEndpointError(chainId)
  const normalized = normalizeAbi(abi)
  const result = await client.readContract({
    address,
    abi: normalized,
    functionName,
    ...(args !== undefined ? { args } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(blockNumber !== undefined
      ? typeof blockNumber === 'bigint'
        ? { blockNumber }
        : { blockTag: blockNumber }
      : {}),
  })
  return withOutputNames(normalized, functionName, result)
}
