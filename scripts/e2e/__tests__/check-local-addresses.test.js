#!/usr/bin/env node
/**
 * Tests for the E2E deploy-order gate (issue #1298).
 *
 * The scenario every one of these exists for is #1289: an extra deployer transaction landed before
 * a plain-CREATE deploy, so each later address slid one nonce slot. A gate that passes that input
 * is worse than no gate, because its green tick is then cited as evidence the addresses agree.
 * The shifted-address case is asserted directly, with the real measured addresses.
 *
 * The second family of tests is the one the first round of this gate got wrong: "the contract is
 * deployed but the app's constant is empty" was skipped outright, so the issue's own leading
 * failure (CR-01, `callsignRegistry`) passed the gate. An empty constant is a CLAIM about the
 * chain, and the record can contradict it.
 *
 * The third is the round after that: the gate correctly found seven mismatches on a clean deploy
 * and then EXPLAINED them wrongly, telling the reader every CREATE2 address is immovable and to go
 * look at the deploy order. All seven were CREATE2 addresses moved by changed init code. A gate
 * that fires accurately and diagnoses wrongly costs a debugging session per firing, so the
 * mechanism labelling is asserted per key here, in both directions.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  checkSwapEnv,
  collectSwapValues,
  compareAddresses,
  flattenDeployment,
  formatReport,
  isFailing,
  mechanismFor,
  parseContractsBlock,
  resolveBlockName,
  main,
  NONCE_ORDERED_KEYS,
} = require("../check-local-addresses.js");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const CONTRACTS_FILE = path.join(ROOT, "frontend", "src", "config", "contracts.js");

// Measured on a fresh local chain (issue #1298): same commit, only the deploy sequence changed.
// Re-measured after spec-030 pillar A grew deploy-clearpath.js (the "checks the swap env vars it
// is given" test reads the REAL frontend/package.json dev:e2e as its third source, so APPENDED
// must track the values a fresh `setup:e2e` run actually produces).
const APPENDED = {
  callsignRegistry: "0xf953b3A269d80e3eB0F2947630Da976B896A8C5b",
  mockUniswapRates: "0xD84379CEae14AA33C123Af12424A37803F885889",
  mockUniswapQuoter: "0x367761085BF3C12e5DA2Df99AC6E1a824612b8fb",
};
const INSERTED = {
  callsignRegistry: "0x49fd2BE640DB2910c2fAb69bB8531Ab6E76127ff",
  mockUniswapRates: "0x2B0d36FACD61B71CC05ab8F3D2355ec3631C0dd5",
  mockUniswapQuoter: "0xfbC22278A96299D91d41C453234d97b4F5Eb9B2d",
};

const REPORT_CONTEXT = {
  blockName: "HARDHAT_CONTRACTS",
  contractsFile: CONTRACTS_FILE,
  deploymentFile: path.join(ROOT, "deployments", "localhost-chain1337-v2.json"),
};

// ── the failure this gate exists for ───────────────────────────────────────────────────────────

test("rejects the shifted addresses an inserted (rather than appended) deploy produces", () => {
  const { mismatches, matched } = compareAddresses(APPENDED, INSERTED);

  assert.equal(matched, 0);
  assert.deepEqual(
    mismatches.map((m) => m.key).sort(),
    ["callsignRegistry", "mockUniswapQuoter", "mockUniswapRates"]
  );

  const rates = mismatches.find((m) => m.key === "mockUniswapRates");
  assert.equal(rates.configured, APPENDED.mockUniswapRates);
  assert.equal(rates.actual, INSERTED.mockUniswapRates);
});

test("the shifted-address report names each key, expected and actual", () => {
  const result = compareAddresses(APPENDED, INSERTED);
  const report = formatReport(result, REPORT_CONTEXT);

  for (const key of Object.keys(APPENDED)) assert.match(report, new RegExp(key));
  assert.match(report, new RegExp(APPENDED.callsignRegistry));
  assert.match(report, new RegExp(INSERTED.callsignRegistry));
  assert.match(report, /expected/);
  assert.match(report, /actual/);
  assert.doesNotMatch(report, /APPEND new deploys at the END/);
});

// ── which mechanism moved it ───────────────────────────────────────────────────────────────────
//
// The first round of this gate asserted ONE cause: "CREATE2 addresses do not move, so look at the
// deployProxy sequence". That is false, and measurably so — a clean deploy at the commit this gate
// landed on moved seven CREATE2 addresses (keyRegistry, sanctionsGuard, polymarketAdapter,
// paymentToken, wmatic, membershipVoucher, voucherBatchMinter) because their init code had changed
// since the constants were last synced, and none of them because of ordering. A report that names
// deploy order for those sends the reader to the wrong file and the wrong fix. These tests exist so
// the message cannot regress to a single cause.

test("a mismatch on a CREATE2 deploy is explained as init code, not as deploy order", () => {
  // keyRegistry is `deployDeterministic` — the exact case the real failing run produced.
  const result = compareAddresses(
    { keyRegistry: APPENDED.mockUniswapRates },
    { keyRegistry: INSERTED.mockUniswapRates }
  );
  const report = formatReport(result, REPORT_CONTEXT);

  assert.match(report, /keyRegistry.*\[CREATE2 — salt \+ init code\]/);
  assert.match(report, /init code/i);
  assert.match(report, /CONSTRUCTOR ARGUMENT/);
  assert.match(report, /sync:frontend-contracts:local/, "the remedy is a re-derive");
  assert.doesNotMatch(
    report,
    /deployProxy/,
    "nothing here moved by nonce, so the proxy sequence must not be offered as the cause"
  );
});

test("a mismatch on a plain-CREATE proxy is explained as the deployer's nonce", () => {
  const result = compareAddresses(
    { wagerRegistry: APPENDED.callsignRegistry },
    { wagerRegistry: INSERTED.callsignRegistry }
  );
  const report = formatReport(result, REPORT_CONTEXT);

  assert.match(report, /wagerRegistry.*\[plain CREATE — deployer nonce\]/);
  assert.match(report, /deployProxy/);
  assert.match(report, /nonce/i);
  assert.match(report, /#1289/);
});

test("a mixed failure names both mechanisms, each against the keys it explains", () => {
  const result = compareAddresses(
    { keyRegistry: APPENDED.mockUniswapRates, tokenFactory: APPENDED.callsignRegistry },
    { keyRegistry: INSERTED.mockUniswapRates, tokenFactory: INSERTED.callsignRegistry }
  );
  const report = formatReport(result, REPORT_CONTEXT);

  assert.match(report, /keyRegistry.*\[CREATE2 — salt \+ init code\]/);
  assert.match(report, /tokenFactory.*\[plain CREATE — deployer nonce\]/);
  assert.match(report, /the two mechanisms/);
});

test("mechanismFor knows the plain-CREATE deploys and treats everything else as CREATE2", () => {
  for (const key of ["wagerRegistry", "membershipManager", "tokenFactory", "callsignRegistry"]) {
    assert.equal(mechanismFor(key), "nonce", `${key} is deployed by upgrades.deployProxy`);
  }
  for (const key of ["keyRegistry", "sanctionsGuard", "membershipVoucher", "paymentToken"]) {
    assert.equal(mechanismFor(key), "create2", `${key} is deployed by deployDeterministic`);
  }
});

test("NONCE_ORDERED_KEYS still covers every deployProxy call in the local deploy sequence", () => {
  // The set is a hand-kept mirror of the call sites, and a stale mirror mislabels a failure. This
  // fails the moment a proxy joins the sequence without being listed.
  const countProxies = (file) =>
    (fs.readFileSync(path.join(ROOT, file), "utf8").match(/deployProxy\(\{/g) || []).length;

  assert.equal(
    countProxies("scripts/deploy/deploy.js"),
    3,
    "deploy.js gained/lost a deployProxy — add its proxy and impl keys to NONCE_ORDERED_KEYS"
  );
  assert.equal(
    countProxies("scripts/deploy/deploy-callsign-registry.js"),
    1,
    "the callsign deploy gained/lost a deployProxy — update NONCE_ORDERED_KEYS"
  );
  for (const key of ["wagerRegistry", "wagerRegistryImpl", "callsignRegistry", "callsignRegistryImpl"]) {
    assert.ok(NONCE_ORDERED_KEYS.has(key), `${key} must be listed as nonce-ordered`);
  }
});

test("a deployed-but-empty constant is not blamed on an address moving", () => {
  // Nothing moved: the deploy put a contract on the chain and the constant was never written.
  const result = compareAddresses(
    { callsignRegistry: "" },
    flattenDeployment({ contracts: { callsignRegistry: APPENDED.callsignRegistry } })
  );
  const report = formatReport(result, REPORT_CONTEXT);

  assert.match(report, /did not move/);
  assert.doesNotMatch(report, /WHY AN ADDRESS MOVES/);
});

test("passes when every hardcoded address is where the deploy put it", () => {
  const { mismatches, unset, matched } = compareAddresses(APPENDED, {
    ...APPENDED,
    extraKey: "0x" + "1".repeat(40),
  });
  assert.deepEqual(mismatches, []);
  assert.deepEqual(unset, []);
  assert.equal(matched, 3);
});

// ── deployed, but the app's constant is empty (the CR-01 shape) ────────────────────────────────

test("a contract that deployed while the app's constant is empty is FATAL, not skipped", () => {
  const result = compareAddresses(
    { callsignRegistry: "" },
    flattenDeployment({ contracts: { callsignRegistry: APPENDED.callsignRegistry } })
  );

  assert.deepEqual(result.mismatches, []);
  assert.equal(result.matched, 0, "an empty constant is never a verified address");
  assert.equal(result.unset.length, 1);
  assert.deepEqual(result.unset[0], {
    key: "callsignRegistry",
    configured: "",
    actual: APPENDED.callsignRegistry,
    section: "contracts",
    fatal: true,
  });
  assert.equal(isFailing(result), true);

  const report = formatReport(result, REPORT_CONTEXT);
  assert.match(report, /callsignRegistry/);
  assert.match(report, new RegExp(APPENDED.callsignRegistry));
  assert.doesNotMatch(report, /PASS/);
});

test("a mock that deployed while the app's constant is empty is FATAL too", () => {
  const result = compareAddresses(
    { mockUniswapQuoter: "" },
    flattenDeployment({ mocks: { mockUniswapQuoter: APPENDED.mockUniswapQuoter } })
  );
  assert.equal(result.unset[0].fatal, true);
  assert.equal(isFailing(result), true);
});

test("an empty constant for a provenance field is reported, not failed", () => {
  // `treasury` is TREASURY_ADDRESS || deployer — configuration, not a deploy. Hardcoding it would
  // be a lie rather than a fix, so it is named in the output and the run still passes.
  const result = compareAddresses(
    { treasury: "" },
    flattenDeployment({ treasury: "0x" + "a".repeat(40) })
  );

  assert.deepEqual(result.mismatches, []);
  assert.equal(result.unset.length, 1);
  assert.equal(result.unset[0].fatal, false);
  assert.equal(isFailing(result), false);

  const report = formatReport(result, REPORT_CONTEXT);
  assert.match(report, /treasury/);
  assert.match(report, /PASS/);
});

test("an empty constant with nothing deployed under that key stays silent", () => {
  const result = compareAddresses({ bridgeRouter: "", liquidityRouter: "" }, {});
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.unset, []);
  assert.deepEqual(result.unverifiable, []);
  assert.equal(isFailing(result), false);
});

test("a deployed contract the app's block has no key for is surfaced, not dropped", () => {
  const result = compareAddresses(
    { wagerRegistry: APPENDED.callsignRegistry },
    flattenDeployment({
      contracts: { wagerRegistry: APPENDED.callsignRegistry, callsignRegistry: APPENDED.mockUniswapQuoter },
      deployer: "0x" + "a".repeat(40),
    })
  );

  assert.deepEqual(result.unmapped.map((u) => u.key), ["callsignRegistry"]);
  assert.equal(isFailing(result), false, "the record carries impls and mocks the app never maps");
  assert.match(formatReport(result, REPORT_CONTEXT), /callsignRegistry/);
});

// ── what is and is not a mismatch ──────────────────────────────────────────────────────────────

test("checksum casing is not a mismatch", () => {
  const { mismatches, matched } = compareAddresses(
    { wagerRegistry: APPENDED.callsignRegistry },
    { wagerRegistry: APPENDED.callsignRegistry.toLowerCase() }
  );
  assert.deepEqual(mismatches, []);
  assert.equal(matched, 1);
});

test("a key the record does not carry is unverifiable — never a pass, never a failure", () => {
  const result = compareAddresses({ safePolicyGuard: APPENDED.callsignRegistry }, {});
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.matched, 0, "an unchecked key must not be counted as verified");
  assert.deepEqual(result.unverifiable, [
    { key: "safePolicyGuard", configured: APPENDED.callsignRegistry },
  ]);
  assert.equal(isFailing(result), false);
});

// ── the third source: dev:e2e's swap env vars ──────────────────────────────────────────────────

test("a swap env var that disagrees with the recorded mock is fatal", () => {
  const deployed = flattenDeployment({ mocks: { mockUniswapQuoter: APPENDED.mockUniswapQuoter } });
  const swap = checkSwapEnv({ VITE_AMOY_UNISWAP_QUOTER: INSERTED.mockUniswapQuoter }, deployed);

  assert.equal(swap.matched, 0);
  assert.deepEqual(swap.unrecorded, []);
  assert.equal(swap.mismatches.length, 1);
  assert.equal(swap.mismatches[0].varName, "VITE_AMOY_UNISWAP_QUOTER");
  assert.equal(swap.mismatches[0].actual, APPENDED.mockUniswapQuoter);
  assert.equal(isFailing(compareAddresses({}, deployed), swap), true);
});

test("a swap env var that agrees with the recorded mock passes", () => {
  const deployed = flattenDeployment({ mocks: { mockUniswapQuoter: APPENDED.mockUniswapQuoter } });
  const swap = checkSwapEnv({ VITE_AMOY_UNISWAP_QUOTER: APPENDED.mockUniswapQuoter }, deployed);
  assert.equal(swap.matched, 1);
  assert.deepEqual(swap.mismatches, []);
});

test("a swap env var no record can speak to is UNRECORDED, never a silent pass", () => {
  // The state at this commit: the swap mocks are printed by their deploy and recorded nowhere, so
  // there is nothing to compare against. Saying so is the honest output; passing would not be.
  const swap = checkSwapEnv({ VITE_AMOY_UNISWAP_FACTORY: APPENDED.mockUniswapRates }, {});
  assert.equal(swap.matched, 0);
  assert.deepEqual(swap.mismatches, []);
  assert.equal(swap.unrecorded.length, 1);
  assert.equal(swap.unrecorded[0].varName, "VITE_AMOY_UNISWAP_FACTORY");

  const report = formatReport(compareAddresses({}, {}), { ...REPORT_CONTEXT, swap });
  assert.match(report, /UNRECORDED/);
  assert.match(report, /VITE_AMOY_UNISWAP_FACTORY/);
  assert.match(report, /PASS/, "unrecorded is reported, not failed");
});

test("a swap value hardcoded in a frontend/package.json script is collected, not just env vars", () => {
  // The issue names `frontend/package.json` `dev:e2e` as the third source. Reading only
  // process.env made this leg inert on the one run it was written for: nothing in
  // torture-test.yml exports these, so an env-only check reports "not set" and moves on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-swap-"));
  const pkg = path.join(dir, "package.json");
  fs.writeFileSync(
    pkg,
    JSON.stringify({
      scripts: {
        dev: "vite",
        "dev:e2e": `VITE_AMOY_UNISWAP_QUOTER=${APPENDED.mockUniswapQuoter} VITE_AMOY_WMATIC=${APPENDED.mockUniswapRates} vite`,
      },
    })
  );

  const values = collectSwapValues({}, pkg);
  assert.equal(values.VITE_AMOY_UNISWAP_QUOTER.value, APPENDED.mockUniswapQuoter);
  assert.match(values.VITE_AMOY_UNISWAP_QUOTER.source, /dev:e2e/);
  assert.equal(values.VITE_AMOY_WMATIC.value, APPENDED.mockUniswapRates);
  assert.ok(!("VITE_AMOY_UNISWAP_FACTORY" in values), "only what is actually written is collected");

  // …and it is checked like any other value: a script-hardcoded address that disagrees with the
  // record fails, with the script named so the reader knows where to edit.
  const deployed = flattenDeployment({ mocks: { mockUniswapQuoter: INSERTED.mockUniswapQuoter } });
  const swap = checkSwapEnv(values, deployed);
  assert.equal(swap.mismatches.length, 1);
  assert.match(formatReport(compareAddresses({}, {}), { ...REPORT_CONTEXT, swap }), /dev:e2e/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("the environment wins over a frontend/package.json script — it is what a build would see", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-swap-"));
  const pkg = path.join(dir, "package.json");
  fs.writeFileSync(
    pkg,
    JSON.stringify({ scripts: { "dev:e2e": `VITE_AMOY_UNISWAP_QUOTER=${INSERTED.mockUniswapQuoter} vite` } })
  );

  const values = collectSwapValues({ VITE_AMOY_UNISWAP_QUOTER: APPENDED.mockUniswapQuoter }, pkg);
  assert.equal(values.VITE_AMOY_UNISWAP_QUOTER.value, APPENDED.mockUniswapQuoter);
  assert.equal(values.VITE_AMOY_UNISWAP_QUOTER.source, "environment");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("collectSwapValues survives a missing or unreadable package.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-swap-"));
  assert.deepEqual(collectSwapValues({}, path.join(dir, "nope.json")), {});

  const broken = path.join(dir, "package.json");
  fs.writeFileSync(broken, "{ not json");
  assert.deepEqual(collectSwapValues({}, broken), {});

  fs.rmSync(dir, { recursive: true, force: true });
});

test("unset swap env vars are reported as not checked rather than as verified", () => {
  const swap = checkSwapEnv({}, flattenDeployment({ mocks: { mockUniswapQuoter: APPENDED.mockUniswapQuoter } }));
  assert.equal(swap.matched, 0);
  assert.deepEqual(swap.mismatches, []);
  assert.deepEqual(swap.unrecorded, []);

  const report = formatReport(compareAddresses({}, {}), { ...REPORT_CONTEXT, swap });
  assert.match(report, /were not checked/);
});

// ── reading the two sources ────────────────────────────────────────────────────────────────────

test("flattenDeployment merges the record's sections and tags each with its origin", () => {
  const flat = flattenDeployment({
    deployer: "0x" + "a".repeat(40),
    paymentToken: "0x" + "b".repeat(40),
    treasury: "",
    contracts: { wagerRegistry: "0x" + "c".repeat(40), paymentToken: "0x" + "d".repeat(40) },
    mocks: { mockUSDC: "0x" + "e".repeat(40), mockWMATIC: null },
  });

  assert.deepEqual(flat.deployer, { address: "0x" + "a".repeat(40), section: "provenance" });
  assert.deepEqual(flat.wagerRegistry, { address: "0x" + "c".repeat(40), section: "contracts" });
  assert.deepEqual(
    flat.paymentToken,
    { address: "0x" + "d".repeat(40), section: "contracts" },
    "contracts must override the top-level field"
  );
  assert.deepEqual(flat.mockUSDC, { address: "0x" + "e".repeat(40), section: "mocks" });
  assert.ok(!("treasury" in flat));
  assert.ok(!("mockWMATIC" in flat));
});

test("parseContractsBlock reads quoted addresses and tolerates comments", () => {
  const source = [
    "const HARDHAT_CONTRACTS = {",
    "  // a leading comment line",
    "  wagerRegistry: '0x9A676e781A523b5d0C0e43731313A708CB607508',",
    "  callsignRegistry: '', // spec 054 — synced after deploy",
    "  nested: { a: 1 },",
    "}",
    "",
    "const AMOY_CONTRACTS = {",
    "  wagerRegistry: '0xA429CdaD3E1497e33BEA7D6FE7d6913fE880241b',",
    "}",
  ].join("\n");

  const hardhat = parseContractsBlock(source, "HARDHAT_CONTRACTS");
  assert.equal(hardhat.wagerRegistry, "0x9A676e781A523b5d0C0e43731313A708CB607508");
  assert.equal(hardhat.callsignRegistry, "");

  // Brace matching must stop at the right block, not run into the next one.
  const amoy = parseContractsBlock(source, "AMOY_CONTRACTS");
  assert.equal(amoy.wagerRegistry, "0xA429CdaD3E1497e33BEA7D6FE7d6913fE880241b");

  assert.equal(parseContractsBlock(source, "NOPE_CONTRACTS"), null);
});

test("the block name comes from the app's own NETWORK_CONTRACTS map", () => {
  const source = fs.readFileSync(CONTRACTS_FILE, "utf8");
  assert.equal(resolveBlockName(source, 1337), "HARDHAT_CONTRACTS");
  assert.equal(resolveBlockName(source, 137), "POLYGON_CONTRACTS");
  assert.equal(resolveBlockName(source, 999999), null);
});

test("the local chain's block is readable and holds real addresses", () => {
  const source = fs.readFileSync(CONTRACTS_FILE, "utf8");
  const hardhat = parseContractsBlock(source, resolveBlockName(source, 1337));
  assert.ok(hardhat, "HARDHAT_CONTRACTS must stay parseable — the gate reads it, not the module");

  // Every contract `setup:e2e` deploys must be non-empty here, or the app hides a surface the E2E
  // suite is about to exercise. callsignRegistry is in this list because it was the issue's own
  // leading failure (CR-01) and it is now deployed by `deploy:local:callsign`.
  for (const key of [
    "wagerRegistry",
    "membershipManager",
    "keyRegistry",
    "sanctionsGuard",
    "tokenFactory",
    "paymentToken",
    "callsignRegistry",
  ]) {
    assert.match(
      hardhat[key] || "",
      /^0x[0-9a-fA-F]{40}$/,
      `${key} is deployed by setup:e2e, so the committed constant must hold its address`
    );
  }
});

// ── the CLI ────────────────────────────────────────────────────────────────────────────────────

function withSilencedConsole(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("a missing deployment record fails — it is never treated as nothing to check", () => {
  const missing = path.join(os.tmpdir(), `fw-no-such-deployment-${Date.now()}.json`);
  const code = withSilencedConsole(() => main(["--deployment", missing], {}));
  assert.equal(code, 1);
});

test("main exits non-zero on a mismatch and zero on agreement", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-addr-"));
  const contractsFile = path.join(dir, "contracts.js");
  const deploymentFile = path.join(dir, "localhost-chain1337-v2.json");

  fs.writeFileSync(
    contractsFile,
    [
      "const HARDHAT_CONTRACTS = {",
      `  callsignRegistry: '${APPENDED.callsignRegistry}',`,
      "}",
      "",
      "const NETWORK_CONTRACTS = {",
      "  1337: HARDHAT_CONTRACTS,",
      "}",
      "",
    ].join("\n")
  );

  const write = (callsignRegistry) =>
    fs.writeFileSync(
      deploymentFile,
      JSON.stringify({ network: "localhost", chainId: 1337, contracts: { callsignRegistry } })
    );

  write(INSERTED.callsignRegistry);
  assert.equal(
    withSilencedConsole(() =>
      main(["--deployment", deploymentFile, "--contractsFile", contractsFile], {})
    ),
    1
  );

  write(APPENDED.callsignRegistry);
  assert.equal(
    withSilencedConsole(() =>
      main(["--deployment", deploymentFile, "--contractsFile", contractsFile], {})
    ),
    0
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("main exits non-zero when a deployed contract's constant is empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-addr-"));
  const contractsFile = path.join(dir, "contracts.js");
  const deploymentFile = path.join(dir, "localhost-chain1337-v2.json");

  fs.writeFileSync(
    contractsFile,
    [
      "const HARDHAT_CONTRACTS = {",
      "  callsignRegistry: '', // spec 054 — synced after deploy",
      "}",
      "",
      "const NETWORK_CONTRACTS = {",
      "  1337: HARDHAT_CONTRACTS,",
      "}",
      "",
    ].join("\n")
  );
  fs.writeFileSync(
    deploymentFile,
    JSON.stringify({
      network: "localhost",
      chainId: 1337,
      contracts: { callsignRegistry: APPENDED.callsignRegistry },
    })
  );

  assert.equal(
    withSilencedConsole(() =>
      main(["--deployment", deploymentFile, "--contractsFile", contractsFile], {})
    ),
    1
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("main checks the swap env vars it is given rather than the ambient environment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-addr-"));
  const contractsFile = path.join(dir, "contracts.js");
  const deploymentFile = path.join(dir, "localhost-chain1337-v2.json");

  fs.writeFileSync(
    contractsFile,
    ["const HARDHAT_CONTRACTS = {", "}", "", "const NETWORK_CONTRACTS = {", "  1337: HARDHAT_CONTRACTS,", "}", ""].join("\n")
  );
  fs.writeFileSync(
    deploymentFile,
    JSON.stringify({
      network: "localhost",
      chainId: 1337,
      mocks: { mockUniswapQuoter: APPENDED.mockUniswapQuoter },
    })
  );

  const run = (env) =>
    withSilencedConsole(() =>
      main(["--deployment", deploymentFile, "--contractsFile", contractsFile], env)
    );

  assert.equal(run({ VITE_AMOY_UNISWAP_QUOTER: INSERTED.mockUniswapQuoter }), 1);
  assert.equal(run({ VITE_AMOY_UNISWAP_QUOTER: APPENDED.mockUniswapQuoter }), 0);
  assert.equal(run({}), 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a chain NETWORK_CONTRACTS does not map fails rather than checking some other block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-addr-"));
  const contractsFile = path.join(dir, "contracts.js");
  const deploymentFile = path.join(dir, "localhost-chain4242-v2.json");

  fs.writeFileSync(
    contractsFile,
    ["const HARDHAT_CONTRACTS = {", "  wagerRegistry: '0x" + "1".repeat(40) + "',", "}", "", "const NETWORK_CONTRACTS = {", "  1337: HARDHAT_CONTRACTS,", "}", ""].join("\n")
  );
  fs.writeFileSync(deploymentFile, JSON.stringify({ chainId: 4242, contracts: {} }));

  assert.equal(
    withSilencedConsole(() =>
      main(["--deployment", deploymentFile, "--contractsFile", contractsFile], {})
    ),
    1
  );

  fs.rmSync(dir, { recursive: true, force: true });
});
