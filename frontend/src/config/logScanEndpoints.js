/**
 * Where event HISTORY is read from, per chain, and the limits of that endpoint.
 *
 * WHY THIS IS SEPARATE FROM `NETWORKS[chainId].rpcUrl`. The build-default read endpoint is chosen
 * for ordinary reads (`eth_call`, balances, the head) and on most public providers it CANNOT serve
 * `eth_getLogs` over history at all. Measured 2026-11-24 against the SafeProposalHub from its deploy
 * block (address-filtered, i.e. the cheapest possible scan):
 *
 *   - publicnode (the default on 1/10/137/8453/42161): "Archive requests require a personal token"
 *     for anything but the newest blocks — on Arbitrum even for the latest 10,000;
 *   - drpc (the build failover on the same chains): "ranges over 100 blocks are not supported on
 *     free plan";
 *   - 1rpc: 50 blocks; flashbots: 2,000; merkle / meowrpc: rate-limited on the first request.
 *
 * So on Optimism, Base and Arbitrum the Protect queue (and every admin event tab) asked the default
 * rail for history it would never give: the first wave was refused (403) on both rails within a
 * second, the read failed, and every mount, poll and refresh tried again — a queue that could never
 * finish loading, whatever the member did. (Measured cold: 5 HTTP requests, then an error.)
 *
 * The rows below are the PUBLIC, keyless endpoints that DO serve address-filtered history, with the
 * range each accepted. They are defaults, not policy: a member's own endpoint (spec 069) always
 * wins, because a member who configured a node has chosen where their reads go. Chains with no row
 * (Polygon, Ethereum, Base, Amoy, local) keep the normal route — Polygon/Amoy reach history through the
 * platform-issued keyed access (spec 107), and no free Ethereum endpoint was found that serves it.
 *
 * `maxRange` is the widest `eth_getLogs` block span the endpoint accepted; the scanner starts there
 * and shrinks only when told to. `rps` is the pace the scanner holds itself to on that host — the
 * providers publish no number for anonymous use, so these are deliberately conservative, and a 429
 * still backs the whole host off (lib/chains/hostLimiter.js).
 */

/** The width used when nothing better is known — the common public cap. */
export const DEFAULT_LOG_RANGE = 10_000

const LOG_SCAN_ENDPOINTS = {
  // Optimism: the OP Labs public endpoint serves history; capped at exactly 10,000 blocks.
  10: { url: 'https://mainnet.optimism.io', maxRange: 10_000, rps: 4 },
  // Base: NO row. `mainnet.base.org` answers `eth_getLogs` with HTTP 429 "request limit reached"
  // (`x-ratelimit-remaining: 0`) on the FIRST request while `eth_blockNumber` works, and every other
  // free endpoint probed refuses history — so Base history needs a member endpoint, and without one
  // the scan fails fast and says so (logScan LogHistoryUnavailableError), never crawls.
  // Arbitrum One: the Offchain Labs endpoint serves history at up to 100,000 blocks per request
  // ("query spans N blocks …, but only 100000 are allowed") — it answered a single 10M probe, but
  // enforces 100k across a real scan, so 100k is the width to start from.
  42161: { url: 'https://arb1.arbitrum.io/rpc', maxRange: 100_000, rps: 4 },
  // ETC + Mordor: the build defaults already serve history and accepted 10M-block ranges.
  61: { maxRange: 1_000_000, rps: 4 },
  63: { maxRange: 1_000_000, rps: 4 },
}

/**
 * The log-scan endpoint for a chain: `{ url?, maxRange, rps? }`. `url` absent ⇒ use the chain's
 * normal read route. Never null — an unknown chain gets the common default width.
 */
export function logScanEndpointFor(chainId) {
  const row = LOG_SCAN_ENDPOINTS[Number(chainId)]
  return row ? { maxRange: DEFAULT_LOG_RANGE, ...row } : { maxRange: DEFAULT_LOG_RANGE }
}

/** Every host this table sends requests to, with its pace — read by the host limiter. */
export function logScanHostPaces() {
  const out = {}
  for (const row of Object.values(LOG_SCAN_ENDPOINTS)) {
    if (row.url && row.rps) out[new URL(row.url).host] = row.rps
  }
  return out
}
