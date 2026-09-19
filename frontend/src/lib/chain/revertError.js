/**
 * Decoding a custom error off a failed contract call (issue #1267).
 *
 * ethers v6 puts a DECODED custom error on `error.revert` only when it held the ABI at the point
 * the call failed — which is what happens on a `staticCall` through a JsonRpcProvider. On the
 * WRITE path through an injected EIP-1193 wallet the same revert arrives as raw selector bytes on
 * `error.data`, nested one or two levels down inside the RPC payload the wallet forwards, and
 * ethers never lifts it into `.revert`. A caller reading only `.revert` therefore renders
 * "execution reverted (unknown custom error)" for an error whose fragment its OWN ABI carries —
 * which is how the curator console lost the one sentence that distinguishes "your click did not
 * work" from "the package you reviewed is not the package on the registry any more".
 *
 * Decoding is a pure ABI operation: no chain, no provider, nothing to await. This module
 * deliberately does not import ethers — it takes an `Interface` the caller already has, so it
 * cannot become a second place that decides which ABI describes a given failure.
 */

/**
 * Every place a wallet, provider or library has been observed to leave the raw revert bytes.
 *
 * Ordered outermost-first (breadth-first): the shallowest copy is the one the immediate caller
 * produced, and the deeper ones are what a wallet forwarded from the node. A passkey UserOp
 * failure nests one level deeper than a signer transaction does; MetaMask nests the node payload
 * under `data.data`.
 *
 * DIVERGENCE 22 (spec 110) — A VIEM ERROR HIDES THE BYTES BEHIND `cause`, and the hand-listed
 * paths above reached NONE of them. The list was five fixed expressions because the five shapes
 * ethers and the wallets produce are five fixed expressions. viem is not like that: it wraps each
 * layer in a typed error and chains them through `cause`, so the same revert arrives as
 *
 *   ContractFunctionExecutionError
 *     .cause ContractFunctionRevertedError  → `.raw`    ← depth 1
 *   …or, when the node error is not pre-decoded:
 *     .cause CallExecutionError .cause ExecutionRevertedError .cause UnknownRpcError
 *       .cause Error → `.data`                                ← depth 4
 *
 * — both measured, not remembered. Depth varies with the transport and the key is `raw` in one and
 * `data` in the other. So this walks the chain instead of naming positions in it: the same revert
 * has to be findable however the layer above chose to wrap it, or a screened member gets
 * "execution reverted (unknown custom error)" in place of the sentence that tells them why.
 *
 * Breadth-first, depth-bounded, cycle-guarded. Callers filter for what actually looks like revert
 * data and (in `extractRevert`) keep walking when a candidate does not decode, so an extra
 * candidate costs a failed parse, never a wrong answer.
 */
const REVERT_CHAIN_KEYS = ['cause', 'error', 'data']
const MAX_REVERT_DEPTH = 8

function rawRevertCandidates(error) {
  const out = []
  const seen = new Set()
  let frontier = [error]
  for (let depth = 0; depth <= MAX_REVERT_DEPTH && frontier.length > 0; depth += 1) {
    const next = []
    for (const node of frontier) {
      if (!node || typeof node !== 'object' || seen.has(node)) continue
      seen.add(node)
      // Harvest before descending, so a shallower copy is always offered first.
      if (typeof node.data === 'string') out.push(node.data)
      if (typeof node.raw === 'string') out.push(node.raw)
      for (const key of REVERT_CHAIN_KEYS) {
        if (node[key] && typeof node[key] === 'object') next.push(node[key])
      }
      if (node.info?.error && typeof node.info.error === 'object') next.push(node.info.error)
    }
    frontier = next
  }
  return out
}

/**
 * The first raw revert payload found on a failure, or `null`.
 *
 * For callers that map SELECTORS by hand (errors whose fragment their own ABI does not carry,
 * e.g. `ISanctionsGuard.SanctionedAddress` on the wager paths) and therefore cannot use
 * {@link extractRevert}. Walking anything narrower than `rawRevertCandidates` misses the shapes
 * MetaMask (`data.data`) and wrapped providers (`error.error.data`) actually produce.
 *
 * @param {unknown} error the thrown failure
 * @returns {string|null} `0x…` bytes at least a selector long, or `null`
 */
export function rawRevertData(error) {
  if (!error) return null
  for (const data of rawRevertCandidates(error)) {
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) return data
  }
  return null
}

/**
 * Pull a decoded custom error out of a failure, whether it arrived pre-decoded on `.revert`, on
 * the older `errorName`/`errorArgs` pair, or as raw selector bytes somewhere in an RPC payload.
 *
 * Returns `null` when nothing in the error decodes against `iface` — a generic revert, an
 * out-of-gas, a rejected wallet prompt. Callers MUST treat that as "not one of ours": reading an
 * undecodable failure as a named error would tell an operator something specific that did not
 * happen.
 *
 * @param {unknown} error the thrown failure
 * @param {{parseError: (data: string) => {name: string, args: unknown[]}|null}|null} [iface]
 *   the ABI `Interface` of the contract that was called; without it only the pre-decoded shapes
 *   can be read, because raw bytes are meaningless without a fragment list.
 * @returns {{name: string, args: unknown[]}|null}
 */
export function extractRevert(error, iface = null) {
  if (!error) return null
  if (error.revert?.name) return { name: error.revert.name, args: error.revert.args ?? [] }
  if (error.errorName) return { name: error.errorName, args: error.errorArgs ?? [] }
  if (!iface) return null

  for (const data of rawRevertCandidates(error)) {
    // A selector alone is 10 characters ("0x" + 4 bytes); anything shorter cannot name an error.
    if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) continue
    try {
      const parsed = iface.parseError(data)
      if (parsed) return { name: parsed.name, args: parsed.args ?? [] }
    } catch {
      /* not one of this ABI's errors — keep looking through the other shapes */
    }
  }
  return null
}

/** Long hex (a hash, an address) shown head-and-tail so a toast stays one line. */
function formatRevertArg(value) {
  const text = typeof value === 'string' ? value : String(value)
  if (text.startsWith('0x') && text.length > 20) return `${text.slice(0, 10)}…${text.slice(-8)}`
  return text
}

/**
 * A decoded revert as something an operator can read: `StaleProposal(0x1234…5678, 0x…)`.
 *
 * This names WHAT the contract refused, not why it matters — a surface that can say why should
 * say that instead (see `MiniAppReviewTab`, which turns `StaleProposal` into a sentence about the
 * vendor swapping the package). This is the honest fallback for every other named error, which
 * would otherwise reach the operator as "unknown custom error".
 *
 * @param {{name: string, args: unknown[]}|null} revert
 * @returns {string|null}
 */
export function describeRevert(revert) {
  if (!revert?.name) return null
  const args = Array.from(revert.args ?? []).map(formatRevertArg)
  return args.length > 0 ? `${revert.name}(${args.join(', ')})` : revert.name
}
