"use strict";

/** Must-fail fixtures for the Medusa verdict (spec 112, FR-009): green needs positive evidence. */

const test = require("node:test");
const assert = require("node:assert");
const { evaluate } = require("../check-medusa-output");

const GOOD = [
  "⇾ Fuzzer stopped, test results follow below ...",
  "⇾ [PASSED] Property Test: WagerRegistryFuzzTest.property_a()",
  "⇾ [PASSED] Assertion Test: KeyRegistryFuzzTest.check(uint256)",
  "⇾ Test summary: 2 test(s) passed, 0 test(s) failed",
].join("\n");
const rules = (r) => r.problems.map((p) => p.rule);

test("a completed campaign with every property held passes", () => {
  const r = evaluate(GOOD, { targets: ["WagerRegistryFuzzTest", "KeyRegistryFuzzTest"] });
  assert.deepStrictEqual(r.problems, []);
});

test("ANSI colour codes do not hide the summary", () => {
  const coloured = GOOD.replace("[PASSED]", "\u001b[32m[PASSED]\u001b[0m").replace("Test summary", "\u001b[1mTest summary\u001b[0m");
  assert.deepStrictEqual(evaluate(coloured).problems, []);
});

test("MUST FAIL M-03: a failed property", () => {
  const out = GOOD.replace("[PASSED] Property Test: WagerRegistryFuzzTest.property_a()", "[FAILED] Property Test: WagerRegistryFuzzTest.property_a()")
    .replace("2 test(s) passed, 0 test(s) failed", "1 test(s) passed, 1 test(s) failed");
  const r = evaluate(out);
  assert.deepStrictEqual(rules(r), ["M-03"]);
  assert.deepStrictEqual(r.failedNames, ["Property Test: WagerRegistryFuzzTest.property_a()"]);
});

test("MUST FAIL M-03: a [FAILED] line even if the summary line says 0 failed", () => {
  const r = evaluate(GOOD.replace("[PASSED] Property", "[FAILED] Property"));
  assert.deepStrictEqual(rules(r), ["M-03"]);
});

test("MUST FAIL M-02: unrecognisable output (crash, toolchain error) is not a pass", () => {
  for (const out of ["", "crytic-compile: error: solc not found", "Traceback (most recent call last):\n  ...", "all good"]) {
    assert.deepStrictEqual(rules(evaluate(out)), ["M-02"], JSON.stringify(out));
  }
});

test("MUST FAIL M-04: a campaign that ran zero tests", () => {
  assert.deepStrictEqual(rules(evaluate("⇾ Test summary: 0 test(s) passed, 0 test(s) failed")), ["M-04"]);
});

test("MUST FAIL M-01: non-zero exit status fails even with a clean-looking transcript", () => {
  assert.deepStrictEqual(rules(evaluate(GOOD, { exitCode: 7 })), ["M-01"]);
});

test("MUST FAIL M-05: a target contract that silently dropped out", () => {
  const r = evaluate(GOOD, { targets: ["WagerRegistryFuzzTest", "KeyRegistryFuzzTest", "WagerPoolFuzzTest"] });
  assert.deepStrictEqual(rules(r), ["M-05"]);
  assert.match(r.problems[0].message, /WagerPoolFuzzTest/);
});

test("M-05 matches whole names: a target that is a prefix of another does not count as present", () => {
  const out = "⇾ [PASSED] Property Test: WagerPoolFuzzTestV2.property_a()\n⇾ Test summary: 1 test(s) passed, 0 test(s) failed";
  assert.deepStrictEqual(rules(evaluate(out, { targets: ["WagerPoolFuzzTest"] })), ["M-05"]);
});
