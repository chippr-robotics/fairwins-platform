#!/usr/bin/env node
"use strict";

/**
 * Revert-coverage gate (spec 112, FR-006).
 *
 * Line/branch coverage says a `revert` line EXECUTED; it cannot say a test asserted WHICH revert
 * fired. This gate closes that: every named revert a first-party production contract can raise
 * must be asserted by name in some test, or sit on the shrink-only allowlist
 * (scripts/coverage/revert-allowlist.json, entries { contract, error, reason }).
 *
 * EXTRACTED (production contracts under the value directories, excluding account/lib/**,
 * interfaces/**, contracts/test/**, contracts/mocks/** — lib/solidity-scan.js):
 *   revert X(...)  |  revert Lib.X(...)  |  revert("message")
 *   require(cond, X(...))  |  require(cond, "message")
 *
 * ASSERTED when a file under test/** contains
 *   revertedWithCustomError(<anything>, "X")     (double, single or backtick quotes)
 *   revertedWith("message")
 *
 * FAILS on:
 *   R-01  a raised revert that no test asserts and the allowlist does not list;
 *   R-02  an allowlist entry whose revert IS now asserted           (shrink-only ratchet);
 *   R-03  an allowlist entry whose revert is no longer raised       (shrink-only ratchet);
 *   R-04  a malformed allowlist entry (missing contract / error / reason) or a duplicate.
 *
 * LIMITATION AND MITIGATION. `revertedWithCustomError(contract, "ZeroAddress")` names an error,
 * not the contract that raised it, and plenty of contracts share names (ZeroAddress,
 * NotAuthorized, ...). Matching on the bare name alone would let ONE test for ContractA mark
 * ContractB's identically-named revert as asserted — the exact over-count that made the
 * spec-112 baseline of 42 a lower bound. So an assertion only counts toward a contract when the
 * SAME test file also mentions that contract: any name declared in the raising source file, or
 * any contract anywhere under contracts/ that inherits from one of them (transitively — so a
 * test that deploys WagerRegistry credits errors raised in the abstract WagerRegistryCore it
 * inherits). "Mentions" is a plain substring match, deliberately lenient: `deployWagerRegistry`
 * and `getContractAt("IWagerRegistry")` count. What this still cannot do: tell two reverts with
 * the same name inside ONE contract apart (one assertion credits every raise site of that name),
 * and a test file that exercises ContractA through an unrelated helper whose name omits it is
 * not credited (that fails closed — add the revert to the allowlist or name the contract).
 *
 * Usage: node scripts/coverage/check-revert-coverage.js [--root <repo>] [--allowlist <file>]
 *        [--update-hint]   (prints the allowlist JSON for the current gaps, for seeding only)
 * Exit: 0 / 1 violations / 2 bad input.
 */

const fs = require("fs");
const path = require("path");
const scan = require("./lib/solidity-scan");

const TEST_EXT = /\.(js|mjs|cjs|ts)$/;

function walkFiles(dir, rx, out, skipDirs) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!skipDirs.has(e.name)) walkFiles(path.join(dir, e.name), rx, out, skipDirs); }
    else if (e.isFile() && rx.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

const Q = "[\"'`]";
const RX_CUSTOM = new RegExp(`revertedWithCustomError\\s*\\(\\s*[^,()]*(?:\\([^()]*\\))?[^,()]*,\\s*(${Q})([A-Za-z_]\\w*)\\1\\s*\\)`, "g");
const RX_MESSAGE = new RegExp(`revertedWith\\s*\\(\\s*(${Q})((?:\\\\.|(?!\\1)[^\\\\])*)\\1\\s*\\)`, "g");

/** Assertions in one test file: { custom:Set, message:Set }. */
function extractAssertions(src) {
  const custom = new Set();
  const message = new Set();
  let m;
  RX_CUSTOM.lastIndex = 0;
  while ((m = RX_CUSTOM.exec(src))) custom.add(m[2]);
  RX_MESSAGE.lastIndex = 0;
  while ((m = RX_MESSAGE.exec(src))) message.add(m[2]);
  return { custom, message };
}

/** name -> Set of names that inherit (transitively) from it, over everything under contracts/. */
function descendantsMap(root) {
  const files = walkFiles(path.join(root, "contracts"), /\.sol$/, [], new Set(["node_modules"]));
  const children = new Map();
  for (const f of files) {
    for (const [child, parents] of scan.inheritancePairs(fs.readFileSync(f, "utf8"))) {
      for (const p of parents) {
        if (!children.has(p)) children.set(p, new Set());
        children.get(p).add(child);
      }
    }
  }
  const memo = new Map();
  const all = (name, seen = new Set()) => {
    if (memo.has(name)) return memo.get(name);
    const out = new Set();
    for (const c of children.get(name) || []) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.add(c);
      for (const d of all(c, seen)) out.add(d);
    }
    memo.set(name, out);
    return out;
  };
  return all;
}

/** Every raised named revert: Map "<path>\u0000<error>" -> { contract, error, kind, line }. */
function collectRaised(root) {
  const raised = new Map();
  for (const rel of scan.listFirstPartySol(root)) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    for (const r of scan.extractReverts(src)) {
      const key = `${rel}\u0000${r.error}`;
      if (!raised.has(key)) raised.set(key, { contract: rel, error: r.error, kind: r.kind, line: r.line });
    }
  }
  return raised;
}

/** Which raised reverts are asserted by some test file that also mentions the raising contract. */
function computeAsserted(root, raised) {
  const testFiles = walkFiles(path.join(root, "test"), TEST_EXT, [], new Set(["node_modules"]));
  const tests = testFiles.map((f) => {
    const src = fs.readFileSync(f, "utf8");
    return { file: f, src, ...extractAssertions(src) };
  });
  const descendants = descendantsMap(root);
  const nameCache = new Map();
  const namesFor = (rel) => {
    if (nameCache.has(rel)) return nameCache.get(rel);
    const declared = scan.declaredContracts(fs.readFileSync(path.join(root, rel), "utf8"));
    const names = new Set(declared);
    for (const d of declared) for (const x of descendants(d)) names.add(x);
    nameCache.set(rel, [...names]);
    return nameCache.get(rel);
  };
  const asserted = new Set();
  for (const [key, r] of raised) {
    const names = namesFor(r.contract);
    for (const t of tests) {
      const set = r.kind === "custom" ? t.custom : t.message;
      if (set.has(r.error) && names.some((n) => t.src.includes(n))) { asserted.add(key); break; }
    }
  }
  return asserted;
}

function checkRevertCoverage({ root, allowlistPath }) {
  const violations = [];
  const raw = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  const entries = Array.isArray(raw) ? raw : raw.entries;
  if (!Array.isArray(entries)) throw new Error("allowlist must be an array or { entries: [...] }");

  const raised = collectRaised(root);
  const asserted = computeAsserted(root, raised);

  const allow = new Map();
  for (const e of entries) {
    if (!e || !e.contract || !e.error || !e.reason || !String(e.reason).trim()) {
      violations.push({ rule: "R-04", message: `malformed allowlist entry (needs contract, error, reason): ${JSON.stringify(e)}` });
      continue;
    }
    const key = `${e.contract}\u0000${e.error}`;
    if (allow.has(key)) { violations.push({ rule: "R-04", message: `duplicate allowlist entry ${e.contract} :: ${e.error}` }); continue; }
    allow.set(key, e);
  }

  const gaps = [];
  for (const [key, r] of raised) {
    if (asserted.has(key)) continue;
    gaps.push(r);
    if (!allow.has(key)) {
      violations.push({
        rule: "R-01",
        message:
          `${r.contract}:${r.line} raises ${r.kind === "custom" ? r.error : JSON.stringify(r.error)} ` +
          "but no test asserts it by name (revertedWithCustomError / revertedWith) and the allowlist does not list it. " +
          "Write the negative test, or add an allowlist entry with a reason.",
      });
    }
  }
  for (const [key, e] of allow) {
    if (!raised.has(key)) {
      violations.push({ rule: "R-03", message: `allowlist entry ${e.contract} :: ${e.error} is no longer raised by that contract — delete the entry` });
    } else if (asserted.has(key)) {
      violations.push({ rule: "R-02", message: `allowlist entry ${e.contract} :: ${e.error} is now asserted by a test — delete the entry (the allowlist only shrinks)` });
    }
  }
  return { violations, raised: raised.size, asserted: asserted.size, gaps, allowlisted: allow.size };
}

function main(argv) {
  let root = path.resolve(__dirname, "..", "..");
  let allowlistPath;
  let hint = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = path.resolve(argv[++i]);
    else if (argv[i] === "--allowlist") allowlistPath = path.resolve(argv[++i]);
    else if (argv[i] === "--update-hint") hint = true;
  }
  allowlistPath = allowlistPath || path.join(root, "scripts", "coverage", "revert-allowlist.json");
  let res;
  try {
    res = checkRevertCoverage({ root, allowlistPath });
  } catch (e) {
    console.error(`check-revert-coverage: bad input: ${e.message}`);
    return 2;
  }
  console.log(
    `revert coverage: ${res.raised} named reverts raised, ${res.asserted} asserted by name, ` +
      `${res.gaps.length} unasserted, ${res.allowlisted} allowlisted`,
  );
  if (hint) {
    console.log(JSON.stringify(res.gaps.map((g) => ({ contract: g.contract, error: g.error })), null, 2));
  }
  if (res.violations.length) {
    for (const v of res.violations) console.error(`FAIL ${v.rule}: ${v.message}`);
    console.error(`revert coverage: ${res.violations.length} violation(s)`);
    return 1;
  }
  console.log("revert coverage: OK");
  return 0;
}

module.exports = { checkRevertCoverage, extractAssertions, collectRaised };

if (require.main === module) process.exit(main(process.argv.slice(2)));
