"use strict";

const test = require("node:test");
const assert = require("node:assert");
const scan = require("../lib/solidity-scan");

test("extractReverts finds every named form and ignores comments/strings/bare reverts", () => {
  const src = `
    // revert NotThis();
    /* require(x, "nor this"); */
    contract A {
      error Foo(); error Bar(uint256);
      function f(uint256 a) external {
        if (a == 0) revert Foo();
        if (a == 1) revert Lib.Bar(a);
        if (a == 2) revert("plain message");
        require(a != 3, Foo());
        require(f2(a, 1) > 0, "msg, with comma");
        require(a != 4);
        if (a == 5) revert();
        string memory s = "revert Fake()";
      }
    }`;
  const got = scan.extractReverts(src).map((r) => `${r.kind}:${r.error}`).sort();
  assert.deepStrictEqual(got, [
    "custom:Bar", "custom:Foo", "custom:Foo", "message:msg, with comma", "message:plain message",
  ]);
});

test("hasExecutableCode: interfaces and signature-only abstracts are not executable", () => {
  assert.strictEqual(scan.hasExecutableCode("interface I { function f() external; error E(); }"), false);
  assert.strictEqual(
    scan.hasExecutableCode("abstract contract B { error E(); event V(); function f() external virtual; }"),
    false,
  );
  assert.strictEqual(scan.hasExecutableCode("abstract contract B { function f() internal pure returns (uint) { return 1; } }"), true);
  assert.strictEqual(scan.hasExecutableCode("contract C { constructor() { } }"), true);
  assert.strictEqual(scan.hasExecutableCode("contract C { modifier m() { _; } }"), true);
  // a function body mentioned only in a comment does not count
  assert.strictEqual(scan.hasExecutableCode("interface I { /* function f() x { } */ function g() external; }"), false);
});

test("inheritancePairs reads multi-parent headers with constructor args", () => {
  const pairs = scan.inheritancePairs("contract A is B, C(1, 2), Lib.D { }\nabstract contract E is F { }");
  assert.deepStrictEqual(pairs, [["A", ["B", "C", "D"]], ["E", ["F"]]]);
});

test("isExcludedPath covers vendored, interfaces, test and mocks", () => {
  for (const p of [
    "contracts/account/lib/solady/X.sol", "contracts/bridge/interfaces/I.sol",
    "contracts/test/Fuzz.sol", "contracts/mocks/M.sol",
  ]) assert.ok(scan.isExcludedPath(p), p);
  assert.ok(!scan.isExcludedPath("contracts/account/CoinbaseSmartWallet.sol"));
});
