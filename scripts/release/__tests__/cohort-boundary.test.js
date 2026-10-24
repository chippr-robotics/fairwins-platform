/**
 * The cohort-boundary gate (spec 076 FR-026b).
 *
 * WHY THIS SUITE IS MOSTLY FAILING CASES. The gate was narrowed from "networks.js was touched" to
 * "something that decides a cohort changed", and a narrowed guard is only worth having if it still
 * refuses the things it was built to refuse. Every `assertBlocked` below is a case the old
 * filename check would have caught by accident; if the new one lets any of them through it is not
 * a more precise guard, it is a disabled one.
 *
 * The passing cases matter too, and they are the reason for the change: networks.js changed 36
 * times in 90 days — tickers, RPC failovers, explorer links — and each one blocked a release it had
 * nothing to do with. A guard that cries wolf on ordinary configuration gets worked around, and a
 * worked-around guard protects nothing.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { cohortFacts, compareCohortFacts } = require("../check-promotion-config.js");

/** A miniature networks.js carrying every piece of machinery the gate reads. */
function fixture(overrides = {}) {
  const {
    primary = 137,
    mainnet = 137,
    testnet = 80002,
    miniappTestnet = 63,
    e2e = "Boolean(import.meta.env?.DEV) && import.meta.env?.VITE_E2E_AMOY_LOCAL === '1'",
    cohortBody = "return listSupportedChainIds().map((id) => NETWORKS[id]).filter((net) => net && Boolean(net.isTestnet) === buildIsTestnet()).map((net) => net.chainId)",
    networks = [
      { id: 137, isTestnet: false, symbol: "POL", rpc: "https://polygon-bor-rpc.publicnode.com" },
      { id: 80002, isTestnet: true, symbol: "POL", rpc: "https://rpc-amoy.polygon.technology" },
      { id: 63, isTestnet: true, symbol: "ETC", rpc: "https://rpc.mordor.etccooperative.org" },
    ],
  } = overrides;

  const entries = networks
    .map(
      (n) => `  ${n.id}: {
    chainId: ${n.id},
    isTestnet: ${n.isTestnet},
    nativeCurrency: { decimals: 18, name: '${n.symbol}', symbol: '${n.symbol}' },
    rpcUrl: '${n.rpc}',
  },`
    )
    .join("\n");

  return `
const PRIMARY_CHAIN_ID = ${primary}
const MAINNET_CHAIN_ID = ${mainnet}
const TESTNET_CHAIN_ID = ${testnet}

const E2E_AMOY_LOCAL =
  ${e2e}

const NETWORKS = {
${entries}
}

const MINIAPP_TESTNET_CHAIN_ID = ${miniappTestnet}

function getCurrentChainId() {
  const env = import.meta.env?.VITE_NETWORK_ID
  return env ? parseInt(env, 10) : PRIMARY_CHAIN_ID
}

function buildIsTestnet() {
  return Boolean(NETWORKS[getCurrentChainId()]?.isTestnet ?? NETWORKS[PRIMARY_CHAIN_ID]?.isTestnet)
}

export function membershipChainId() {
  return buildIsTestnet() ? TESTNET_CHAIN_ID : MAINNET_CHAIN_ID
}

export function miniAppChainId() {
  if (E2E_AMOY_LOCAL) return TESTNET_CHAIN_ID
  return buildIsTestnet() ? MINIAPP_TESTNET_CHAIN_ID : MAINNET_CHAIN_ID
}

export function cohortChainIds() {
  ${cohortBody}
}

export function isInCohort(chainId) {
  const net = NETWORKS[chainId]
  return Boolean(net) && Boolean(net.isTestnet) === buildIsTestnet()
}

export function listSupportedChainIds() {
  return Object.keys(NETWORKS).map((id) => parseInt(id, 10))
}
`;
}

const compare = (a, b) => compareCohortFacts(cohortFacts(a), cohortFacts(b));
const assertAllowed = (a, b, what) =>
  assert.deepEqual(compare(a, b), [], `${what} must NOT block a promotion — it cannot move the boundary`);
const assertBlocked = (a, b, what) => {
  const problems = compare(a, b);
  assert.ok(problems.length > 0, `${what} MUST block a promotion — it moves the cohort boundary`);
};

// ── the changes that provoked this rewrite: real, and harmless ───────────────────────────────

test("a ticker rename does not block — the MATIC to POL case that blocked v1.14.0", () => {
  const before = fixture({ networks: [{ id: 137, isTestnet: false, symbol: "MATIC", rpc: "https://a" }] });
  const after = fixture({ networks: [{ id: 137, isTestnet: false, symbol: "POL", rpc: "https://a" }] });
  assertAllowed(before, after, "renaming a native currency");
});

test("adding an RPC failover URL does not block — the second false positive, same day", () => {
  const before = fixture({ networks: [{ id: 137, isTestnet: false, symbol: "POL", rpc: "https://a" }] });
  const after = fixture({ networks: [{ id: 137, isTestnet: false, symbol: "POL", rpc: "https://b" }] });
  assertAllowed(before, after, "changing an RPC endpoint");
});

test("a comment-only edit does not block", () => {
  const before = fixture();
  const after = fixture().replace("const MAINNET_CHAIN_ID = 137", "// the estate's mainnet home\nconst MAINNET_CHAIN_ID = 137");
  assertAllowed(before, after, "adding a comment");
});

// ── the changes the guard exists for ─────────────────────────────────────────────────────────

test("BLOCKS a change to MAINNET_CHAIN_ID", () => {
  assertBlocked(fixture(), fixture({ mainnet: 8453 }), "repointing the mainnet chain id");
});

test("BLOCKS a change to TESTNET_CHAIN_ID", () => {
  assertBlocked(fixture(), fixture({ testnet: 11155111 }), "repointing the testnet chain id");
});

test("BLOCKS a change to PRIMARY_CHAIN_ID — it is what buildIsTestnet falls back to", () => {
  assertBlocked(fixture(), fixture({ primary: 80002 }), "repointing the primary chain");
});

test("BLOCKS a change to MINIAPP_TESTNET_CHAIN_ID", () => {
  assertBlocked(fixture(), fixture({ miniappTestnet: 80002 }), "moving the mini-app registry's testnet home");
});

test("BLOCKS flipping a network's isTestnet — the boundary itself", () => {
  const before = fixture({ networks: [{ id: 137, isTestnet: false, symbol: "POL", rpc: "https://a" }] });
  const after = fixture({ networks: [{ id: 137, isTestnet: true, symbol: "POL", rpc: "https://a" }] });
  assertBlocked(before, after, "moving a chain across the testnet/mainnet line");
});

test("BLOCKS adding a chain — it joins a cohort", () => {
  const before = fixture({ networks: [{ id: 137, isTestnet: false, symbol: "POL", rpc: "https://a" }] });
  const after = fixture({
    networks: [
      { id: 137, isTestnet: false, symbol: "POL", rpc: "https://a" },
      { id: 42161, isTestnet: false, symbol: "ETH", rpc: "https://b" },
    ],
  });
  assertBlocked(before, after, "adding a network");
});

test("BLOCKS removing a chain — it leaves a cohort", () => {
  const before = fixture({
    networks: [
      { id: 137, isTestnet: false, symbol: "POL", rpc: "https://a" },
      { id: 63, isTestnet: true, symbol: "ETC", rpc: "https://b" },
    ],
  });
  const after = fixture({ networks: [{ id: 137, isTestnet: false, symbol: "POL", rpc: "https://a" }] });
  assertBlocked(before, after, "removing a network");
});

test("BLOCKS rewriting cohortChainIds — how a build RESOLVES its cohort", () => {
  assertBlocked(
    fixture(),
    fixture({ cohortBody: "return listSupportedChainIds()" }),
    "making cohortChainIds span both cohorts"
  );
});

test("BLOCKS loosening the E2E seam — DEV-gated, but it ADDS a chain when set", () => {
  assertBlocked(fixture(), fixture({ e2e: "true" }), "un-gating the E2E cohort seam");
});

// ── fail closed ──────────────────────────────────────────────────────────────────────────────

test("REFUSES when the cohort machinery cannot be found, rather than passing", () => {
  const problems = compare(fixture(), "export const something = 1\n");
  assert.ok(problems.length > 0, "an unparsed file must refuse");
  assert.match(
    problems[0],
    /could not locate its cohort machinery/,
    "the refusal must say the gate could not read the file, not imply the file is safe"
  );
});

test("a restructure that renames the machinery refuses too — it is not silently ignored", () => {
  const renamed = fixture().replace("function buildIsTestnet()", "function resolveCohort()");
  const problems = compare(fixture(), renamed);
  assert.ok(problems.length > 0, "a renamed resolver must refuse rather than pass unnoticed");
});
