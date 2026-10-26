"use strict";

/**
 * Must-fail fixtures for the policy completeness gate (spec 112, FR-002). The gate is proven by
 * the trees it REJECTS: an unlisted contract, a stale entry, a rationale-less reportOnly entry.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { makeTree } = require("./helpers");
const { checkCompleteness } = require("../check-policy-completeness");

const VALUE = "contract Router { function f() external { } }";
const POLICY = {
  tiers: { A: { minStatements: 95, minBranches: 90 } },
  gated: [{ path: "contracts/bridge/Router.sol", tier: "A" }],
  reportOnly: [],
  excluded: [{ pathGlob: "contracts/**/interfaces/**", reason: "no executable logic" }],
};

const run = (files, policy) => {
  const root = makeTree({ ...files, "coverage-threshold-policy.json": policy });
  return checkCompleteness({ root, policyPath: path.join(root, "coverage-threshold-policy.json") });
};

test("complete policy passes", () => {
  const r = run({ "contracts/bridge/Router.sol": VALUE }, POLICY);
  assert.deepStrictEqual(r.violations, []);
});

test("MUST FAIL: a new contract under a value directory with no policy entry", () => {
  const r = run(
    { "contracts/bridge/Router.sol": VALUE, "contracts/bridge/NewRouter.sol": VALUE },
    POLICY,
  );
  assert.strictEqual(r.violations.length, 1);
  assert.strictEqual(r.violations[0].rule, "P-01");
  assert.match(r.violations[0].message, /contracts\/bridge\/NewRouter\.sol/);
});

test("MUST FAIL: every value directory is scanned (naming, apps, clearpath ...)", () => {
  for (const dir of ["naming", "apps", "clearpath", "staking", "fees", "liquidity", "privacy", "upgradeable"]) {
    const r = run({ "contracts/bridge/Router.sol": VALUE, [`contracts/${dir}/X.sol`]: VALUE }, POLICY);
    assert.strictEqual(r.violations.length, 1, dir);
    assert.match(r.violations[0].path, new RegExp(`contracts/${dir}/X.sol`));
  }
});

test("MUST FAIL: a stale policy entry whose file is gone", () => {
  const r = run({}, POLICY);
  assert.strictEqual(r.violations[0].rule, "P-02");
});

test("MUST FAIL: reportOnly without a rationale, excluded without a reason", () => {
  const r = run(
    { "contracts/bridge/Router.sol": VALUE, "contracts/bridge/Other.sol": VALUE },
    { ...POLICY, reportOnly: [{ path: "contracts/bridge/Other.sol", tier: "C" }], excluded: [{ pathGlob: "contracts/x/**" }] },
  );
  assert.deepStrictEqual(r.violations.map((v) => v.rule).sort(), ["P-03", "P-03"]);
});

test("reportOnly with a rationale satisfies the gate", () => {
  const r = run(
    { "contracts/bridge/Router.sol": VALUE, "contracts/bridge/Other.sol": VALUE },
    { ...POLICY, reportOnly: [{ path: "contracts/bridge/Other.sol", tier: "C", rationale: "helper" }] },
  );
  assert.deepStrictEqual(r.violations, []);
});

test("exempt: interface-only files, abstract signature-only files, excluded paths", () => {
  const r = run(
    {
      "contracts/bridge/Router.sol": VALUE,
      "contracts/bridge/IRouter.sol": "interface IRouter { function f() external; }",
      "contracts/staking/Base.sol": "abstract contract Base { error E(); function f() external virtual; }",
      "contracts/bridge/interfaces/IX.sol": VALUE,
      "contracts/account/lib/solady/Vendored.sol": VALUE,
      "contracts/test/Fuzz.sol": VALUE,
      "contracts/mocks/Mock.sol": VALUE,
      "contracts/other/Outside.sol": VALUE,
    },
    POLICY,
  );
  assert.deepStrictEqual(r.violations, []);
  assert.deepStrictEqual(r.skipped.sort(), ["contracts/bridge/IRouter.sol", "contracts/staking/Base.sol"]);
});

test("MUST FAIL: abstract contract WITH implemented functions still needs an entry", () => {
  const r = run(
    {
      "contracts/bridge/Router.sol": VALUE,
      "contracts/upgradeable/Base.sol": "abstract contract Base { function f() internal pure returns (uint) { return 1; } }",
    },
    POLICY,
  );
  assert.strictEqual(r.violations.length, 1);
});
