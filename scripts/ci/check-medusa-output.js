#!/usr/bin/env node
"use strict";

/**
 * Fail-closed verdict on a captured `medusa fuzz` run (spec 112, FR-009).
 *
 * The weekly job used to `grep -c "PASSED"` / `grep -c "FAILED"` for its SUMMARY only and carried
 * `continue-on-error: true`, so a violated property never failed anything, and an output that did
 * not look like Medusa's at all (a crash before the campaign, a toolchain error) counted as "0
 * failed". This gate inverts the default: green requires POSITIVE evidence of a completed
 * campaign in which every property held.
 *
 * Medusa v1.5.1 ends a campaign with   `Test summary: N test(s) passed, M test(s) failed`
 * (verified against the v1.5.1 binary's format string) and lists each test as
 * `[PASSED] Property Test: Contract.property_x()` / `[FAILED] Assertion Test: Contract.f(...)`.
 *
 * FAIL (exit 1) when ANY of:
 *   M-01  the medusa process exit code (--exit-code) is non-zero;
 *   M-02  no `Test summary:` line is found           (unrecognisable output — crash, wrong tool);
 *   M-03  the summary reports failed > 0, or any `[FAILED]` line is present;
 *   M-04  passed + failed == 0                        (a campaign that tested nothing);
 *   M-05  a `targetContracts` entry of --medusa-config never appears in any test line (Medusa runs
 *         with stopOnFailedContractMatching=false, so a target that failed to deploy is skipped
 *         SILENTLY — without this the harness count could shrink with CI green).
 * The verdict is by summary AND by per-test lines: either one alone saying "failed" fails.
 *
 * Usage: node scripts/ci/check-medusa-output.js <output.txt> [--exit-code N] [--medusa-config medusa.json]
 * Exit: 0 pass / 1 fail / 2 bad input.
 */

const fs = require("fs");

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function parseMedusaOutput(raw) {
  const text = raw.replace(ANSI, "");
  const summaryRx = /Test summary:\s*(\d+)\s+test\(s\)\s+passed,\s*(\d+)\s+test\(s\)\s+failed/gi;
  let summary = null;
  let m;
  while ((m = summaryRx.exec(text))) summary = { passed: Number(m[1]), failed: Number(m[2]) };

  const testLines = [];
  for (const line of text.split("\n")) {
    const t = /^\s*(?:⇾\s*)?\[(PASSED|FAILED)\]\s*(.*)$/.exec(line);
    if (t) testLines.push({ status: t[1], name: t[2].trim() });
  }
  return { summary, testLines, text };
}

function evaluate(raw, { exitCode = 0, targets = [] } = {}) {
  const { summary, testLines, text } = parseMedusaOutput(raw);
  const problems = [];
  if (exitCode !== 0) problems.push({ rule: "M-01", message: `medusa exited with status ${exitCode}` });
  if (!summary) {
    problems.push({ rule: "M-02", message: "no `Test summary: N test(s) passed, M test(s) failed` line — output is not a completed Medusa campaign" });
  } else {
    if (summary.failed > 0) problems.push({ rule: "M-03", message: `${summary.failed} test(s) failed` });
    if (summary.passed + summary.failed === 0) problems.push({ rule: "M-04", message: "campaign reported 0 tests" });
  }
  const failedLines = testLines.filter((t) => t.status === "FAILED");
  if (failedLines.length && !(summary && summary.failed > 0)) {
    problems.push({ rule: "M-03", message: `${failedLines.length} [FAILED] test line(s) despite the summary` });
  }
  if (summary) {
    const named = testLines.length ? testLines.map((t) => t.name).join("\n") : text;
    for (const target of targets) {
      if (!new RegExp(`\\b${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(named)) {
        problems.push({ rule: "M-05", message: `target contract ${target} produced no test line (not deployed or no properties?)` });
      }
    }
  }
  return { problems, summary, failedNames: failedLines.map((t) => t.name), tests: testLines.length };
}

function main(argv) {
  const args = { exitCode: 0 };
  let file;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--exit-code") args.exitCode = Number(argv[++i]);
    else if (argv[i] === "--medusa-config") args.config = argv[++i];
    else if (!file) file = argv[i];
  }
  if (!file || Number.isNaN(args.exitCode)) {
    console.error("usage: check-medusa-output.js <output.txt> [--exit-code N] [--medusa-config medusa.json]");
    return 2;
  }
  let raw, targets = [];
  try {
    raw = fs.readFileSync(file, "utf8");
    if (args.config) targets = JSON.parse(fs.readFileSync(args.config, "utf8")).fuzzing.targetContracts || [];
  } catch (e) {
    console.error(`check-medusa-output: bad input: ${e.message}`);
    return 2;
  }
  const r = evaluate(raw, { exitCode: args.exitCode, targets });
  console.log(
    `medusa: ${r.summary ? `${r.summary.passed} passed / ${r.summary.failed} failed` : "no summary"}, ` +
      `${r.tests} test line(s), ${targets.length} target contract(s) expected`,
  );
  if (r.problems.length) {
    for (const p of r.problems) console.error(`FAIL ${p.rule}: ${p.message}`);
    for (const n of r.failedNames) console.error(`  failed: ${n}`);
    return 1;
  }
  console.log("medusa: OK — campaign completed and every property held");
  return 0;
}

module.exports = { parseMedusaOutput, evaluate };

if (require.main === module) process.exit(main(process.argv.slice(2)));
