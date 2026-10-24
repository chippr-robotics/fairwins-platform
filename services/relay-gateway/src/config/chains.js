/**
 * Static per-chain definitions for the relay gateway (spec 036 data-model.md "Chain Config").
 *
 * Dynamic values (RPC URLs, quotas, caps) are env-driven in ./index.js; this file holds the
 * facts that are properties of the chain itself:
 *
 * - gasType:          'eip1559' on Polygon/Amoy; 'legacy' (type-0, single gasPrice) on ETC/Mordor —
 *                     ETC never adopted EIP-1559 (research.md §2). The ENGINE prices gas; the
 *                     gateway only needs this for its own estimates and the healthz surface.
 * - paymentSupported: false on 61/63 — the live USC token is permit-only (NO EIP-3009), so the
 *                     `payment` intent class is blocked there (503 payment_unsupported_on_chain)
 *                     until an EIP-3009-capable USC exists (research.md §2).
 * - noBatch:          61/63 endpoints return batch responses ethers v6 cannot decode; mirror the
 *                     frontend's NO_BATCH_CHAIN_IDS workaround with batchMaxCount: 1.
 * - tokenDomain:      EIP-712 domain (name/version) of the chain's EIP-3009 payment token, used to
 *                     recover the signer of a `payment`-class authorization. Native USDC uses
 *                     domain version "2". Overridable via TOKEN_DOMAIN_NAME_<id>/TOKEN_DOMAIN_VERSION_<id>.
 * - defaultRpcUrls:   ≥2 independent public endpoints (FR-007), failover order; override with
 *                     RPC_URLS_<chainId> (comma-separated).
 */

export const CHAIN_DEFS = {
  137: {
    chainId: 137,
    name: 'polygon',
    gasType: 'eip1559',
    paymentSupported: true,
    noBatch: false,
    tokenDomain: { name: 'USD Coin', version: '2' },
    // polygon-rpc.com was the first entry until 2026-08-23, when it was measured answering HTTP
    // 401 without a key — a default that fails closed for anyone who has not set
    // RPC_URLS_137. Production always sets it; this is the path a dev or a fresh deploy takes.
    defaultRpcUrls: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org'],
    // Fallbacks only — used when a live fee read fails; the engine owns real pricing.
    gasPriceFallbackWei: 50_000_000_000n, // 50 gwei
  },
  80002: {
    chainId: 80002,
    name: 'amoy',
    gasType: 'eip1559',
    paymentSupported: true,
    noBatch: false,
    tokenDomain: { name: 'USDC', version: '2' },
    defaultRpcUrls: ['https://rpc-amoy.polygon.technology', 'https://polygon-amoy-bor-rpc.publicnode.com'],
    gasPriceFallbackWei: 30_000_000_000n,
  },
  61: {
    chainId: 61,
    name: 'etc',
    gasType: 'legacy',
    paymentSupported: false, // USC on ETC is permit-only; no EIP-3009 (research.md §2)
    noBatch: true,
    tokenDomain: null,
    // `etc.rivet.link` led this list until it stopped resolving (NXDOMAIN); it was the first
    // endpoint the gateway dialled for ETC, so every call paid a dead lookup before falling through.
    defaultRpcUrls: ['https://etc.etcdesktop.com'],
    gasPriceFallbackWei: 300_000_000_000n, // ~300 gwei legacy oracle suggestion (hardhat.config.js)
  },
  63: {
    chainId: 63,
    name: 'mordor',
    gasType: 'legacy',
    paymentSupported: false,
    noBatch: true,
    tokenDomain: null,
    defaultRpcUrls: ['https://rpc.mordor.etccooperative.org', 'https://geth-mordor.etc-network.info'],
    gasPriceFallbackWei: 300_000_000_000n,
  },
}

export const SUPPORTED_CHAIN_IDS = Object.keys(CHAIN_DEFS).map(Number)
