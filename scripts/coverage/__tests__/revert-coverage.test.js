"use strict";

/** Must-fail fixtures for the revert-coverage gate (spec 112, FR-006). */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { makeTree } = require("./helpers");
const { checkRevertCoverage, extractAssertions } = require("../check-revert-coverage");

const POOL = `
  contract Pool {
    error NotOwner(); error Closed();
    function a() external { if (msg.sender != address(0)) revert NotOwner(); }
    function b() external { require(true, Closed()); }
    function c() external { require(true, "bad input"); }
  }`;
const FULL_TEST = `
  const pool = await ethers.deployContract("Pool");
  await expect(pool.a()).to.be.revertedWithCustomError(pool, "NotOwner");
  await expect(pool.b()).to.be.revertedWithCustomError(pool, 'Closed');
  await expect(pool.c()).to.be.revertedWith("bad input");`;

const run = (files, allow = []) => {
  const root = makeTree({ ...files, "allow.json": { entries: allow } });
  return checkRevertCoverage({ root, allowlistPath: path.join(root, "allow.json") });
};
const rules = (r) => r.violations.map((v) => v.rule);
const entry = (error) => ({ contract: "contracts/pools/Pool.sol", error, reason: "unreachable: guarded earlier" });

test("fully asserted contract passes with an empty allowlist", () => {
  const r = run({ "contracts/pools/Pool.sol": POOL, "test/pools/Pool.test.js": FULL_TEST });
  assert.deepStrictEqual(r.violations, []);
  assert.strictEqual(r.raised, 3);
  assert.strictEqual(r.asserted, 3);
});

test("MUST FAIL R-01: a raised custom error no test asserts", () => {
  const r = run({
    "contracts/pools/Pool.sol": POOL,
    "test/pools/Pool.test.js": FULL_TEST.replace(/.*NotOwner.*\n/, ""),
  });
  assert.deepStrictEqual(rules(r), ["R-01"]);
  assert.match(r.violations[0].message, /NotOwner/);
  assert.match(r.violations[0].message, /contracts\/pools\/Pool\.sol/);
});

test("MUST FAIL R-01: a raised require-string that no test asserts", () => {
  const r = run({
    "contracts/pools/Pool.sol": POOL,
    "test/pools/Pool.test.js": FULL_TEST.replace(/.*bad input.*/, ""),
  });
  assert.deepStrictEqual(rules(r), ["R-01"]);
  assert.match(r.violations[0].message, /bad input/);
});

test("MUST FAIL R-01: a bare .reverted does not count as asserting a named revert", () => {
  const r = run({
    "contracts/pools/Pool.sol": POOL,
    "test/pools/Pool.test.js": FULL_TEST.replace(/.*Closed.*/, "await expect(pool.b()).to.be.reverted;"),
  });
  assert.deepStrictEqual(rules(r), ["R-01"]);
});

test("allowlist entry excuses a gap", () => {
  const r = run(
    { "contracts/pools/Pool.sol": POOL, "test/pools/Pool.test.js": FULL_TEST.replace(/.*Closed.*\n/, "") },
    [entry("Closed")],
  );
  assert.deepStrictEqual(r.violations, []);
});

test("MUST FAIL R-02: allowlist entry whose revert is now asserted (shrink-only)", () => {
  const r = run({ "contracts/pools/Pool.sol": POOL, "test/pools/Pool.test.js": FULL_TEST }, [entry("Closed")]);
  assert.deepStrictEqual(rules(r), ["R-02"]);
});

test("MUST FAIL R-03: allowlist entry whose revert is no longer raised (shrink-only)", () => {
  const r = run({ "contracts/pools/Pool.sol": POOL, "test/pools/Pool.test.js": FULL_TEST }, [entry("Ghost")]);
  assert.deepStrictEqual(rules(r), ["R-03"]);
});

test("MUST FAIL R-04: allowlist entry without a reason, and duplicates", () => {
  const files = { "contracts/pools/Pool.sol": POOL, "test/pools/Pool.test.js": FULL_TEST.replace(/.*Closed.*\n/, "") };
  const noReason = run(files, [{ contract: "contracts/pools/Pool.sol", error: "Closed" }]);
  assert.ok(rules(noReason).includes("R-04"));
  const dup = run(files, [entry("Closed"), entry("Closed")]);
  assert.ok(rules(dup).includes("R-04"));
});

test("shared error names: another contract's assertion does not credit this one", () => {
  const other = `contract Other { error NotOwner(); function a() external { revert NotOwner(); } }`;
  const r = run({
    "contracts/pools/Pool.sol": POOL,
    "contracts/pools/Other.sol": other,
    // asserts NotOwner, Closed and the message, but only ever mentions Pool
    "test/pools/Pool.test.js": FULL_TEST,
  });
  assert.deepStrictEqual(rules(r), ["R-01"]);
  assert.match(r.violations[0].message, /Other\.sol/);
});

test("inherited errors: a test of the child credits an error raised in the abstract base", () => {
  const r = run({
    "contracts/wagers/Core.sol": "abstract contract Core { error Frozen(); function g() internal pure { revert Frozen(); } }",
    "contracts/wagers/Reg.sol": "contract Reg is Core { function h() external pure { g(); } }",
    "test/Reg.test.js": `deploy("Reg"); expect(x).to.be.revertedWithCustomError(reg, "Frozen");`,
  });
  assert.deepStrictEqual(r.violations, []);
});

test("excluded production paths are not scanned (vendored lib, interfaces, mocks, test)", () => {
  const r = run({
    "contracts/account/lib/V.sol": "contract V { function f() external { revert Vendored(); } }",
    "contracts/bridge/interfaces/I.sol": "contract I { function f() external { revert Iface(); } }",
    "contracts/mocks/M.sol": "contract M { function f() external { revert Mocky(); } }",
    "contracts/test/T.sol": "contract T { function f() external { revert Fuzzy(); } }",
  });
  assert.strictEqual(r.raised, 0);
  assert.deepStrictEqual(r.violations, []);
});

test("extractAssertions handles multi-line calls, nested call receivers and all quote styles", () => {
  const a = extractAssertions(`
    .to.be.revertedWithCustomError(
      pool.connect(x),
      "One"
    )
    .to.be.revertedWithCustomError(await getReg(), 'Two')
    .to.be.revertedWithCustomError(reg, \`Three\`)
    .to.be.revertedWith("with, comma")`);
  assert.deepStrictEqual([...a.custom].sort(), ["One", "Three", "Two"]);
  assert.deepStrictEqual([...a.message], ["with, comma"]);
});

test("extractAssertions credits Prettier's trailing comma when a call wraps", () => {
  // Prettier wraps a long call one argument per line and appends a trailing comma; the
  // gate missed exactly this shape and allowlisted four reverts the custody suites assert.
  const a = extractAssertions(`
    await expect(hub.propose(vault, to, 0, data, 2)).to.be.revertedWithCustomError(
      hub,
      "InvalidOperation",
    );
    await expect(x).to.be.revertedWith(
      "Only callable by owner",
    );`);
  assert.deepStrictEqual([...a.custom], ["InvalidOperation"]);
  assert.deepStrictEqual([...a.message], ["Only callable by owner"]);
});
