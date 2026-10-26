#!/usr/bin/env node
"use strict";

/**
 * Coverage-policy completeness gate (spec 112, FR-001 / FR-002).
 *
 * `check-thresholds.js` only enforces what the policy LISTS; a new contract that nobody adds to
 * `coverage-threshold-policy.json` counts toward the blended total and nothing else, and ten
 * value-bearing contracts sat in exactly that state. This gate closes the door from the other
 * side: every first-party contract under a value directory must appear in `gated`, `reportOnly`
 * (with a rationale) or `excluded` (with a reason), or the build fails and NAMES the contract.
 *
 * Scope: contracts/{wagers,pools,bridge,liquidity,staking,fees,account,custody,access,naming,
 * apps,clearpath,oracles,privacy,tokens,upgradeable}/**.sol minus
 *   account/lib/** (vendored), interfaces/** , contracts/test/**, contracts/mocks/**.
 *
 * Interface-only / abstract-without-code files are SKIPPED, because istanbul has nothing to
 * measure in them. Detection (lib/solidity-scan.js#hasExecutableCode): strip comments and string
 * contents, then look for any function / modifier / constructor / receive / fallback whose header
 * ends in `{` (a body) rather than `;` (a bare signature). A file with no body anywhere — an
 * `interface`, or an `abstract contract` that only declares signatures, errors, events and structs —
 * is skipped. An abstract contract WITH implemented functions (WagerRegistryCore, UUPSManaged,
 * SignerIntentBase ...) has executable code and must be listed.
 *
 * Also fails on a policy entry whose file no longer exists (a stale entry silently stops gating).
 * `reportOnly` entries must carry a `rationale`, `excluded` entries a `reason`.
 *
 * Usage: node scripts/coverage/check-policy-completeness.js [--root <repo>] [--policy <file>]
 * Exit: 0 complete / 1 violations / 2 bad input.
 */

const fs = require("fs");
const path = require("path");
const scan = require("./lib/solidity-scan");
const fp = require("./lib/first-party");

function checkCompleteness({ root, policyPath }) {
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  const violations = [];
  const listed = new Map(); // path -> bucket
  for (const e of policy.gated || []) listed.set(e.path, "gated");
  for (const e of policy.reportOnly || []) {
    listed.set(e.path, "reportOnly");
    if (!e.rationale || !String(e.rationale).trim()) {
      violations.push({ rule: "P-03", path: e.path, message: `reportOnly entry ${e.path} has no rationale` });
    }
  }
  for (const e of policy.excluded || []) {
    if (!e.reason || !String(e.reason).trim()) {
      violations.push({ rule: "P-03", path: e.pathGlob, message: `excluded entry ${e.pathGlob} has no reason` });
    }
  }

  const files = scan.listFirstPartySol(root);
  const excludedRx = (policy.excluded || []).map((e) => fp.globToRegExp(e.pathGlob));
  const skipped = [];
  for (const rel of files) {
    if (listed.has(rel)) continue;
    if (excludedRx.some((rx) => rx.test(rel))) continue;
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    if (!scan.hasExecutableCode(src)) { skipped.push(rel); continue; }
    violations.push({
      rule: "P-01",
      path: rel,
      message:
        `${rel} is under a value directory but is in none of gated / reportOnly / excluded in ` +
        "coverage-threshold-policy.json. Add it to `gated` (preferred) or `reportOnly` with a rationale.",
    });
  }

  for (const [p, bucket] of listed) {
    if (!fs.existsSync(path.join(root, p))) {
      violations.push({ rule: "P-02", path: p, message: `${bucket} entry ${p} does not exist on disk (stale entry)` });
    }
  }
  return { violations, checked: files.length, skipped };
}

function main(argv) {
  let root = path.resolve(__dirname, "..", "..");
  let policyPath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = path.resolve(argv[++i]);
    else if (argv[i] === "--policy") policyPath = path.resolve(argv[++i]);
  }
  policyPath = policyPath || path.join(root, "coverage-threshold-policy.json");
  let res;
  try {
    res = checkCompleteness({ root, policyPath });
  } catch (e) {
    console.error(`check-policy-completeness: bad input: ${e.message}`);
    return 2;
  }
  console.log(
    `policy completeness: ${res.checked} first-party files under value directories, ` +
      `${res.skipped.length} skipped as interface/abstract with no executable code`,
  );
  for (const s of res.skipped) console.log(`  skipped (no executable code): ${s}`);
  if (res.violations.length) {
    for (const v of res.violations) console.error(`FAIL ${v.rule}: ${v.message}`);
    console.error(`policy completeness: ${res.violations.length} violation(s)`);
    return 1;
  }
  console.log("policy completeness: OK");
  return 0;
}

module.exports = { checkCompleteness };

if (require.main === module) process.exit(main(process.argv.slice(2)));
