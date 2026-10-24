/**
 * Batched balance reads via Multicall3 (issue #1459).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 *
 * The portfolio read path issued ONE RPC REQUEST PER ASSET, PER CHAIN — ~50–70 requests for a
 * five-mainnet portfolio load. The platform's keyed RPC account is capped at 50 req/s
 * ACCOUNT-WIDE, shared with the relay-gateway, the cost exporter and the alto bundler (which has
 * no failover). One screen load by one member was therefore about a second of the entire
 * account's capacity, and two concurrent loads could starve the bundler.
 *
 * Multicall3 collapses each chain's reads into a single `aggregate3` call: ~5 requests per load
 * instead of ~50–70. It is deployed at ONE canonical address on the five EVM mainnets below —
 * verified by `eth_getCode` on each, identical bytecode — because it is deployed with a
 * deterministic deployer, which is also why a single constant is safe here.
 *
 * ── THE SEMANTICS THAT MUST SURVIVE BATCHING ─────────────────────────────────────────────────
 *
 * The callers' contract is per-asset `Promise.allSettled` semantics: one bad token NEVER fails
 * the portfolio, and a failed read is SKIPPED, never rendered as a zero (constitution III — a
 * false zero tells a member their money is gone). `aggregate3`'s per-call `allowFailure` is what
 * makes batching compatible with that at all, and `decodeReturn` below is where the honesty
 * lives: a call that "succeeded" with EMPTY return data is a failure, not a zero balance —
 * that is what calling `balanceOf` on an address with no contract looks like.
 *
 * ── FALLBACK, NOT ASSUMPTION ─────────────────────────────────────────────────────────────────
 *
 * Chains without a VERIFIED Multicall3 (ETC 61, Mordor 63, the local hardhat chain, testnets not
 * probed) take the existing per-asset path. So does any chain whose aggregate call itself fails —
 * a multicall revert must degrade to the old behaviour, never to an empty portfolio. The
 * allowlist below contains exactly the chains that were verified, not the chains a registry
 * claims; adding one is one line, after running the same `eth_getCode` check.
 */
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'

/** Canonical deterministic deployment — the same address on every chain that has it. */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'

/**
 * Chains where Multicall3 was POSITIVELY verified (eth_getCode, 2026-09-05, identical bytecode).
 * Membership here is an empirical fact, not a hope: a chain missing from this set is not broken,
 * it just takes the per-asset path it always took.
 */
export const MULTICALL3_CHAIN_IDS = Object.freeze(new Set([1, 10, 137, 8453, 42161]))

const MULTICALL3_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])',
  'function getEthBalance(address addr) view returns (uint256)',
])
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)'])
const UINT256 = [{ type: 'uint256' }]

/**
 * `eth_call` over whichever provider shape the caller holds. ethers hands back the return
 * bytes as a hex string; a viem client wraps them in `{ data }`. Reading both keeps this
 * module's one provider dependency as small as its header promises, and lets a caller be
 * converted to the spec-110 seam without touching the batch path.
 */
async function callRaw(provider, tx) {
  const raw = await provider.call(tx)
  return typeof raw === 'string' ? raw : raw?.data
}

/** Decode a `uint256` return, REFUSING empty data — see `decodeReturn` for why that matters. */
function decodeUint(returnData) {
  if (!returnData || returnData === '0x') {
    throw new Error('balance read returned no data')
  }
  return decodeAbiParameters(UINT256, returnData)[0]
}

/** The unbatched read — one request per asset. Kept as the universal fallback. */
async function readSingle(asset, provider, address) {
  if (asset.kind === 'native') return provider.getBalance(address)
  // Encoded by hand and sent through `call` for the same reasons the batch path is — and so the
  // empty-data case is refused HERE too. `Contract.balanceOf` used to reject it for us; a
  // hand-rolled read that quietly decoded `0x` as 0 would put the false zero back on the
  // fallback path only, which is the path nothing notices until an RPC misbehaves.
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [address] })
  return decodeUint(await callRaw(provider, { to: asset.address, data }))
}

/**
 * Decode one aggregate3 result into a settled-style outcome.
 *
 * `success: false` is an explicit failure. `success: true` with EMPTY data is ALSO a failure:
 * that is what a `balanceOf` staticcall to an address holding no contract returns, and decoding
 * it as 0 would render exactly the false zero the honest-state rule forbids.
 */
function decodeReturn({ success, returnData }) {
  if (!success || !returnData || returnData === '0x') {
    return { status: 'rejected', reason: new Error('multicall leg failed or returned no data') }
  }
  try {
    return { status: 'fulfilled', value: decodeUint(returnData) }
  } catch (err) {
    return { status: 'rejected', reason: err }
  }
}

/**
 * One aggregate3 round trip for every asset on one chain. Throws on transport failure.
 *
 * DELIBERATELY NOT a contract object. The calldata is encoded by hand and sent through
 * `provider.call` for two reasons that both bit during development:
 *
 *   - A contract wrapper is the seam every test in this codebase mocks — the global setup
 *     replaces it with a stub that answers `balanceOf` and nothing else. Routed through one, the
 *     batch path would silently throw in every suite and take the per-asset fallback, so the
 *     property this module exists for ("one request per chain") would never be exercised by a
 *     single test.
 *   - `provider.call` with pre-encoded bytes is the smallest possible dependency on the provider:
 *     anything that can send eth_call can carry a batch, including the header-injecting
 *     transports from the spec-069 seam, untouched.
 */
async function readChainBatched(assets, provider, address) {
  const calls = assets.map((asset) =>
    asset.kind === 'native'
      ? // Multicall3 exposes the native balance itself, so native rides the same batch.
        {
          target: MULTICALL3_ADDRESS,
          allowFailure: true,
          callData: encodeFunctionData({
            abi: MULTICALL3_ABI,
            functionName: 'getEthBalance',
            args: [address],
          }),
        }
      : {
          target: asset.address,
          allowFailure: true,
          callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [address] }),
        }
  )
  const data = encodeFunctionData({ abi: MULTICALL3_ABI, functionName: 'aggregate3', args: [calls] })
  const raw = await callRaw(provider, { to: MULTICALL3_ADDRESS, data })
  const results = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', data: raw })
  return results.map(decodeReturn)
}

/**
 * Read balances for every registry entry, batched per chain where Multicall3 is verified.
 *
 * DROP-IN for `Promise.allSettled(registry.map(readAssetBalance))`: returns an array of
 * settled-shaped objects `{status:'fulfilled', value: bigint} | {status:'rejected', reason}`,
 * ALIGNED WITH `registry` BY INDEX — callers already zip results back to assets positionally,
 * and misalignment here would attribute one token's balance to another, which is worse than any
 * outage this function could have.
 *
 * @param {Array<{chainId: number, kind: string, address?: string}>} registry
 * @param {Map<number, object>} providers  chainId -> read provider
 * @param {string} address                 the account being scanned
 * @returns {Promise<Array<{status: 'fulfilled', value: bigint} | {status: 'rejected', reason: Error}>>}
 */
export async function readBalancesSettled(registry, providers, address) {
  const results = new Array(registry.length)

  // Group indices per chain so batches can run concurrently ACROSS chains while each chain
  // contributes exactly one request (or its per-asset fallback).
  const byChain = new Map()
  registry.forEach((asset, i) => {
    const list = byChain.get(asset.chainId) ?? []
    list.push(i)
    byChain.set(asset.chainId, list)
  })

  await Promise.all(
    [...byChain.entries()].map(async ([chainId, indices]) => {
      const provider = providers.get(chainId)
      const assets = indices.map((i) => registry[i])

      const settleSingles = async () => {
        const settled = await Promise.allSettled(assets.map((a) => readSingle(a, provider, address)))
        settled.forEach((res, j) => { results[indices[j]] = res })
      }

      if (!provider) {
        // No provider for the chain — every asset on it fails individually, exactly as the
        // unbatched path would have failed them. Never throw for the whole portfolio.
        indices.forEach((i) => {
          results[i] = { status: 'rejected', reason: new Error(`no read provider for chain ${chainId}`) }
        })
        return
      }

      if (!MULTICALL3_CHAIN_IDS.has(chainId)) {
        await settleSingles()
        return
      }

      try {
        const decoded = await readChainBatched(assets, provider, address)
        decoded.forEach((res, j) => { results[indices[j]] = res })
      } catch {
        // The BATCH failed (transport, revert, a provider that lies about the chain). That is not
        // evidence about any individual asset — degrade to the per-asset path rather than failing
        // the chain, so a Multicall3 hiccup costs efficiency and never data.
        await settleSingles()
      }
    })
  )

  return results
}
