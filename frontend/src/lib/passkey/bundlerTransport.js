/**
 * The bundler transport, with the failover the config has always advertised (#1535).
 *
 * `VITE_BUNDLER_URLS_<NET>` is parsed as a comma-separated LIST (config/networks.js), and
 * `.env.example` has always shown a second entry. The submitting client used `bundlerUrls[0]` and
 * nothing else, so a configured fallback was visible in config, exercised by the health probe, and
 * COULD NEVER SUBMIT. That gap matters more since #1534: a chain is now turned on by pointing at a
 * third-party bundler, and a passkey account with no reachable bundler cannot transact AT ALL —
 * there is no self-submit fallback on the UserOp rail (spec 050 supersedes 041 FR-015 there).
 *
 * WHAT MAY FAIL OVER, AND WHAT MUST NOT.
 * Failover is for "this bundler did not answer" — transport errors, timeouts, 5xx. It must NOT
 * apply to a bundler that answered and said no: an ERC-4337 validation rejection is a fact about
 * the UserOp, not about the bundler, so every other bundler will reject it identically. Fanning it
 * out multiplies latency on a user-visible path, and re-submits an operation the member is waiting
 * on to several third parties for no possible gain.
 *
 * viem's DEFAULT `shouldThrow` is not sufficient here — it stops only on user-rejection and
 * execution-reverted, so a `-32500` "rejected by EntryPoint" would fall through to every configured
 * bundler in turn. This module narrows it.
 */
import { http, fallback } from 'viem'

/**
 * ERC-4337 bundler rejections (EIP-4337 §RPC error codes) plus the JSON-RPC codes that describe
 * the REQUEST rather than the server. Each is deterministic: a second bundler answers the same.
 *
 *   -32500  rejected by EntryPoint's simulateValidation
 *   -32501  rejected by paymaster's validatePaymasterUserOp
 *   -32502  banned opcode
 *   -32503  out of time range (validUntil/validAfter)
 *   -32504  paymaster throttled or banned
 *   -32505  paymaster stake too low
 *   -32506  unsupported signature aggregator
 *   -32507  invalid signature
 *   -32521  execution reverted
 *   -32602  invalid params      -32601  method not found
 */
export const TERMINAL_BUNDLER_CODES = new Set([
  -32500, -32501, -32502, -32503, -32504, -32505, -32506, -32507, -32521, -32602, -32601,
])

/** Walk an error chain — viem wraps the RPC error, so the code is rarely on the outermost object. */
function anyCode(error) {
  const codes = []
  let cur = error
  for (let depth = 0; cur && depth < 6; depth += 1) {
    if (typeof cur.code === 'number') codes.push(cur.code)
    cur = cur.cause
  }
  return codes
}

/**
 * True ⇒ stop, do not try the next bundler.
 *
 * Deliberately errs toward FAILING OVER: an unrecognised error is treated as "this bundler may be
 * broken", because trying the next one costs a round trip while wrongly stopping costs the member
 * their transaction. The listed codes are the ones we can positively say are about the UserOp.
 */
export function isTerminalBundlerError(error) {
  if (!error) return false
  return anyCode(error).some((code) => TERMINAL_BUNDLER_CODES.has(code))
}

/**
 * Build the transport for a chain's bundler list.
 *
 * One URL yields a plain `http()` — byte-identical to the previous behaviour, so a single-bundler
 * chain is unchanged. Two or more yields `fallback` in DECLARED ORDER (`rank: false`): the first
 * entry is the one we chose, and re-ranking by latency would silently move submissions to a
 * third party we listed as a backup.
 */
export function bundlerTransport(bundlerUrls, { httpImpl = http, fallbackImpl = fallback } = {}) {
  const urls = (bundlerUrls ?? []).filter(Boolean)
  if (urls.length === 0) throw new Error('bundlerTransport: no bundler URL configured')
  if (urls.length === 1) return httpImpl(urls[0])
  return fallbackImpl(urls.map((url) => httpImpl(url)), {
    rank: false,
    shouldThrow: isTerminalBundlerError,
  })
}
