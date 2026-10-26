#!/usr/bin/env node
"use strict";

/**
 * Bare-revert assertion gate (spec 112, FR-007).
 *
 * `expect(tx).to.be.reverted` and `.to.be.revertedWithoutReason` pass on ANY revert — including
 * a revert for the wrong reason (an unfunded account, a missing approval, a typo in the call).
 * A negative test that cannot tell its target guard from an accident does not protect the guard.
 *
 * FLAGGED in test/**.{js,mjs,cjs,ts}: the matchers `.reverted` and `.revertedWithoutReason`,
 * including chains split across lines (`.to\n.be\n.reverted`). NOT flagged: `.not.be.reverted`
 * (that asserts SUCCESS, not a revert), and anything inside a comment.
 *
 * EXEMPT: an annotation `// ANY-REVERT: <non-empty reason>` on the matcher's line, the line
 * before it, or anywhere in the contiguous `//` comment block that ends right above the `expect(`
 * that starts the statement (a reason may wrap across comment lines).
 *
 * SHRINK-ONLY BASELINE (scripts/coverage/bare-revert-baseline.json, { files: { path: count } }).
 * The sites that exist today are being converted by another workstream, so the gate ratchets:
 *   B-01  a file has MORE unannotated bare reverts than its baseline (or is not in the baseline);
 *   B-02  a baseline entry overstates the file's count (or the file is gone) — lower/delete it,
 *         so the baseline can only ever fall and a regression cannot hide behind slack;
 *   B-03  an `// ANY-REVERT:` annotation with no reason.
 * Annotated sites do not count toward the baseline.
 *
 * Usage: node scripts/coverage/check-bare-reverts.js [--root <repo>] [--baseline <file>]
 *        [--update-hint]   (prints the baseline JSON for the current counts, for seeding only)
 * Exit: 0 / 1 violations / 2 bad input.
 */

const fs = require("fs");
const path = require("path");
const { stripComments } = require("./lib/solidity-scan"); // same // and /* */ grammar as Solidity

const TEST_EXT = /\.(js|mjs|cjs|ts)$/;
const RX_MATCHER = /\.\s*(reverted|revertedWithoutReason)\b/g;
const RX_NOT = /\.\s*not(?:\s*\.\s*(?:to|be))*\s*$/;
const RX_ANNOTATION = /\/\/\s*ANY-REVERT\s*:(.*)$/;

function walkFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (e.name !== "node_modules") walkFiles(path.join(dir, e.name), out); }
    else if (e.isFile() && TEST_EXT.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

/** Bare-revert sites in one file's source: [{ line, matcher, annotated, badAnnotation }]. */
function findBareReverts(src) {
  const code = stripComments(src);
  const rawLines = src.split("\n");
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1; // 1-based
  };

  const sites = [];
  let m;
  RX_MATCHER.lastIndex = 0;
  while ((m = RX_MATCHER.exec(code))) {
    if (RX_NOT.test(code.slice(Math.max(0, m.index - 40), m.index))) continue;
    const line = lineOf(m.index);
    // Start of the statement: the nearest `expect(` at or above this line (within 12 lines).
    let stmtLine = line;
    for (let l = line; l >= Math.max(1, line - 12); l--) {
      if (/\bexpect\s*\(/.test(rawLines[l - 1] || "")) { stmtLine = l; break; }
    }
    const candidates = new Set([line, line - 1, stmtLine, stmtLine - 1]);
    // A reason often wraps onto a second comment line, so also accept the annotation anywhere in
    // the contiguous `//` comment block that ends right above the statement.
    for (let l = stmtLine - 1; l >= 1 && /^\s*\/\//.test(rawLines[l - 1] || ""); l--) candidates.add(l);
    let annotated = false, bad = false;
    for (const l of candidates) {
      const a = RX_ANNOTATION.exec(rawLines[l - 1] || "");
      if (!a) continue;
      if (a[1].trim()) annotated = true; else bad = true;
    }
    sites.push({ line, matcher: m[1], annotated, badAnnotation: bad && !annotated });
  }
  return sites;
}

function checkBareReverts({ root, baselinePath }) {
  const raw = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const baseline = raw.files;
  if (!baseline || typeof baseline !== "object") throw new Error('baseline must be { "files": { "<path>": <count> } }');

  const violations = [];
  const counts = new Map();
  for (const f of walkFiles(path.join(root, "test"), []).sort()) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    const sites = findBareReverts(fs.readFileSync(f, "utf8"));
    let n = 0;
    for (const s of sites) {
      if (s.badAnnotation) {
        violations.push({ rule: "B-03", message: `${rel}:${s.line} has \`// ANY-REVERT:\` with no reason` });
      }
      if (!s.annotated) n++;
    }
    if (n > 0) counts.set(rel, n);
  }

  for (const [rel, n] of counts) {
    const allowed = Object.prototype.hasOwnProperty.call(baseline, rel) ? baseline[rel] : 0;
    if (n > allowed) {
      violations.push({
        rule: "B-01",
        message:
          `${rel} has ${n} bare \`.reverted\`/\`.revertedWithoutReason\` assertion(s), baseline allows ${allowed}. ` +
          "Assert the specific error (revertedWithCustomError / revertedWith), or annotate `// ANY-REVERT: <reason>`.",
      });
    }
  }
  for (const [rel, allowed] of Object.entries(baseline)) {
    const n = counts.get(rel) || 0;
    if (allowed > n) {
      violations.push({
        rule: "B-02",
        message: `baseline overstates ${rel}: lists ${allowed}, found ${n}. The baseline only shrinks — ${n === 0 ? "delete the entry" : `lower it to ${n}`}.`,
      });
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return { violations, counts, total };
}

function main(argv) {
  let root = path.resolve(__dirname, "..", "..");
  let baselinePath;
  let hint = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = path.resolve(argv[++i]);
    else if (argv[i] === "--baseline") baselinePath = path.resolve(argv[++i]);
    else if (argv[i] === "--update-hint") hint = true;
  }
  baselinePath = baselinePath || path.join(root, "scripts", "coverage", "bare-revert-baseline.json");
  let res;
  try {
    res = checkBareReverts({ root, baselinePath });
  } catch (e) {
    console.error(`check-bare-reverts: bad input: ${e.message}`);
    return 2;
  }
  console.log(`bare reverts: ${res.total} unannotated site(s) in ${res.counts.size} file(s)`);
  if (hint) console.log(JSON.stringify(Object.fromEntries(res.counts), null, 2));
  if (res.violations.length) {
    for (const v of res.violations) console.error(`FAIL ${v.rule}: ${v.message}`);
    console.error(`bare reverts: ${res.violations.length} violation(s)`);
    return 1;
  }
  console.log("bare reverts: OK");
  return 0;
}

module.exports = { checkBareReverts, findBareReverts };

if (require.main === module) process.exit(main(process.argv.slice(2)));
