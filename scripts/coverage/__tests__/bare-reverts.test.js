"use strict";

/** Must-fail fixtures for the bare-revert gate (spec 112, FR-007). */

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { makeTree } = require("./helpers");
const { checkBareReverts, findBareReverts } = require("../check-bare-reverts");

const run = (files, baseline = {}) => {
  const root = makeTree({ ...files, "baseline.json": { files: baseline } });
  return checkBareReverts({ root, baselinePath: path.join(root, "baseline.json") });
};
const rules = (r) => r.violations.map((v) => v.rule);

test("specific assertions and clean files pass with an empty baseline", () => {
  const r = run({
    "test/a.test.js": `await expect(x()).to.be.revertedWithCustomError(c, "E");
      await expect(y()).to.be.revertedWith("m");
      await expect(z()).to.not.be.reverted;
      await expect(z()).not.to.be.reverted;`,
  });
  assert.deepStrictEqual(r.violations, []);
  assert.strictEqual(r.total, 0);
});

test("MUST FAIL B-01: a bare .to.be.reverted in a file with no baseline", () => {
  const r = run({ "test/a.test.js": `await expect(x()).to.be.reverted;` });
  assert.deepStrictEqual(rules(r), ["B-01"]);
  assert.match(r.violations[0].message, /test\/a\.test\.js/);
});

test("MUST FAIL B-01: .revertedWithoutReason is also bare", () => {
  const r = run({ "test/a.test.js": `await expect(x()).to.be.revertedWithoutReason();` });
  assert.deepStrictEqual(rules(r), ["B-01"]);
});

test("MUST FAIL B-01: a multi-line chain with a bare .reverted", () => {
  const r = run({ "test/a.test.js": `await expect(\n  x()\n)\n  .to.be\n  .reverted;` });
  assert.deepStrictEqual(rules(r), ["B-01"]);
});

test("MUST FAIL B-01: the count rises above the file's baseline", () => {
  const files = { "test/a.test.js": `await expect(x()).to.be.reverted;\nawait expect(y()).to.be.reverted;` };
  assert.deepStrictEqual(rules(run(files, { "test/a.test.js": 1 })), ["B-01"]);
  assert.deepStrictEqual(run(files, { "test/a.test.js": 2 }).violations, []);
});

test("MUST FAIL B-02: baseline overstates (forces the baseline down)", () => {
  const files = { "test/a.test.js": `await expect(x()).to.be.reverted;` };
  const over = run(files, { "test/a.test.js": 3 });
  assert.deepStrictEqual(rules(over), ["B-02"]);
  assert.match(over.violations[0].message, /lower it to 1/);
  const gone = run({ "test/a.test.js": "// clean" }, { "test/a.test.js": 1, "test/deleted.test.js": 2 });
  assert.deepStrictEqual(rules(gone), ["B-02", "B-02"]);
});

test("ANY-REVERT annotation on the same line, the preceding line, or above the expect( exempts", () => {
  const r = run({
    "test/a.test.js": [
      `await expect(x()).to.be.reverted; // ANY-REVERT: depends on OZ internals`,
      `// ANY-REVERT: proxy deploy failure has no stable selector`,
      `await expect(y()).to.be.reverted;`,
      `// ANY-REVERT: multi-line chain`,
      `await expect(`,
      `  z()`,
      `).to.be`,
      `  .reverted;`,
    ].join("\n"),
  });
  assert.deepStrictEqual(r.violations, []);
  assert.strictEqual(r.total, 0);
});

test("an ANY-REVERT reason that wraps onto further comment lines still exempts", () => {
  const r = run({
    "test/a.test.js": [
      `// context line before the annotation`,
      `// ANY-REVERT: SafeProxyFactory discards the initializer's revert data, so`,
      `// neither the guard's error nor GS000 is observable from here.`,
      `await expect(x()).to.be.revertedWithoutReason();`,
    ].join("\n"),
  });
  assert.deepStrictEqual(r.violations, []);
  assert.strictEqual(r.total, 0);
});

test("MUST FAIL B-01: an annotation separated from the statement by code does not exempt", () => {
  const r = run({
    "test/a.test.js": [
      `// ANY-REVERT: belongs to nothing below`,
      `const tx = build();`,
      `await expect(x()).to.be.reverted;`,
    ].join("\n"),
  });
  assert.deepStrictEqual(rules(r), ["B-01"]);
});

test("MUST FAIL B-01/B-03: an annotation with no reason does not exempt", () => {
  const r = run({ "test/a.test.js": `// ANY-REVERT:\nawait expect(x()).to.be.reverted;` });
  assert.deepStrictEqual(rules(r).sort(), ["B-01", "B-03"]);
});

test("an annotation two statements away does not leak onto the next assertion", () => {
  const r = run({
    "test/a.test.js": [
      `// ANY-REVERT: first one only`,
      `await expect(x()).to.be.reverted;`,
      `await expect(y()).to.be.reverted;`,
    ].join("\n"),
  });
  assert.deepStrictEqual(rules(r), ["B-01"]);
  assert.strictEqual(r.total, 1);
});

test("mentions in comments and strings are not sites", () => {
  assert.deepStrictEqual(
    findBareReverts(`// expect(x).to.be.reverted\n/* .reverted */\nconst s = "ok";`),
    [],
  );
});

test("sites under node_modules are ignored; non-test extensions are ignored", () => {
  const r = run({
    "test/node_modules/dep/x.js": `expect(x).to.be.reverted;`,
    "test/readme.md": `expect(x).to.be.reverted;`,
  });
  assert.deepStrictEqual(r.violations, []);
});
