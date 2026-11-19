"use strict";

/**
 * Shared, dependency-free Solidity source scanning for the spec-112 contract gates
 * (check-policy-completeness.js, check-revert-coverage.js).
 *
 * Deliberately NOT a Solidity parser. It is a comment/string-aware tokenizer plus balanced-paren
 * argument splitting — enough to find `revert X(`, `require(cond, X(...))` and
 * `require(cond, "msg")` without being fooled by a revert mentioned in a comment or a string.
 */

const fs = require("fs");
const path = require("path");

/** Directories whose contracts hold, route or spend value (spec 112 FR-001). */
const VALUE_DIRS = [
  "wagers", "pools", "bridge", "liquidity", "staking", "fees", "account", "custody",
  "access", "naming", "apps", "clearpath", "oracles", "privacy", "tokens", "upgradeable",
];

/** Repo-relative path predicates for what is NOT first-party production code. */
const EXCLUDED_PATTERNS = [
  /^contracts\/account\/lib\//, // vendored FreshCryptoLib / solady / webauthn-sol / account-abstraction
  /(^|\/)interfaces\//,
  /^contracts\/test\//,
  /^contracts\/mocks\//,
];

const isExcludedPath = (rel) => EXCLUDED_PATTERNS.some((rx) => rx.test(rel));

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith(".sol")) out.push(p);
  }
  return out;
}

/** Repo-relative (`contracts/...`) paths of first-party .sol files under the value dirs. */
function listFirstPartySol(repoRoot) {
  const out = [];
  for (const d of VALUE_DIRS) walk(path.join(repoRoot, "contracts", d), out);
  return out
    .map((p) => path.relative(repoRoot, p).split(path.sep).join("/"))
    .filter((rel) => !isExcludedPath(rel))
    .sort();
}

/**
 * Blank out comments, keeping string literals and the file's line structure. Comment characters
 * become spaces (newlines kept) so line numbers stay meaningful.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && d === "*") {
      out += "  "; i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      if (i < n) { out += "  "; i += 2; }
    } else if (c === '"' || c === "'") {
      const q = c;
      out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { out += src[i] + (src[i + 1] || ""); i += 2; continue; }
        out += src[i]; i++;
      }
      if (i < n) { out += q; i++; }
    } else { out += c; i++; }
  }
  return out;
}

/** Same as stripComments, but string literal CONTENTS are also blanked (for structure checks). */
function stripCommentsAndStrings(src) {
  return stripComments(src).replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    (m) => '"' + " ".repeat(Math.max(0, m.length - 2)) + '"',
  );
}

/**
 * True when the file contains executable code: at least one function/modifier/constructor/
 * receive/fallback WITH A BODY. Interfaces, and abstract contracts that only declare
 * `function f() external;` signatures / errors / events / structs, have none and cannot be
 * covered, so they are not required to appear in the coverage policy.
 */
function hasExecutableCode(src) {
  const s = stripCommentsAndStrings(src);
  const rx = /\b(function|modifier|constructor|receive|fallback)\b/g;
  let m;
  while ((m = rx.exec(s))) {
    let depth = 0;
    for (let i = m.index + m[0].length; i < s.length; i++) {
      const c = s[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (depth === 0 && c === ";") break; // declaration only (or a function-type variable)
      else if (depth === 0 && c === "{") return true; // has a body
    }
  }
  return false;
}

/** Index of the matching close paren for the open paren at `open`, or -1. String-literal aware. */
function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Split an argument list on top-level commas. */
function splitArgs(s) {
  const args = [];
  let depth = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const q = c; cur += c; i++;
      while (i < s.length && s[i] !== q) { if (s[i] === "\\") { cur += s[i]; i++; } cur += s[i]; i++; }
      cur += q; continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { args.push(cur); cur = ""; } else cur += c;
  }
  if (cur.trim()) args.push(cur);
  return args;
}

const lineOf = (s, idx) => s.slice(0, idx).split("\n").length;

function unquote(lit) {
  const m = /^(?:unicode)?("|')([\s\S]*)\1$/.exec(lit.trim());
  return m ? m[2] : null;
}

/**
 * Named reverts a source file can raise. Returns [{ error, kind, line }] where kind is
 * "custom" (error name) or "message" (revert string).
 *   revert X(...)            custom
 *   revert Lib.X(...)        custom (named by its last segment)
 *   revert("msg")            message
 *   require(cond, X(...))    custom
 *   require(cond, "msg")     message
 * Bare `revert()` / `require(cond)` carry no name and are not extracted.
 */
function extractReverts(src) {
  // `s` keeps string contents (for reading messages); `mask` is the same text, same length, with
  // string contents blanked — structure is searched in `mask` so `"revert Fake()"` is not a revert.
  const s = stripComments(src);
  const mask = stripCommentsAndStrings(src);
  const found = [];

  const rxRevert = /\brevert\b\s*(?:([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*)?\(/g;
  let m;
  while ((m = rxRevert.exec(mask))) {
    const open = m.index + m[0].length - 1;
    if (m[1]) {
      const name = m[1].split(".").pop().trim();
      found.push({ error: name, kind: "custom", line: lineOf(s, m.index) });
    } else {
      const close = matchParen(mask, open);
      if (close < 0) continue;
      const lit = unquote(s.slice(open + 1, close));
      if (lit !== null) found.push({ error: lit, kind: "message", line: lineOf(s, m.index) });
    }
  }

  const rxReq = /\brequire\s*\(/g;
  while ((m = rxReq.exec(mask))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(mask, open);
    if (close < 0) continue;
    const maskArgs = splitArgs(mask.slice(open + 1, close));
    if (maskArgs.length < 2) continue;
    // Map the second argument back onto the unmasked text by offset (masking preserves length).
    const start = open + 1 + maskArgs[0].length + 1;
    const reason = s.slice(start, start + maskArgs[1].length).trim();
    const lit = unquote(reason);
    if (lit !== null) { found.push({ error: lit, kind: "message", line: lineOf(s, m.index) }); continue; }
    const call = /^(?:[A-Za-z_]\w*\s*\.\s*)*([A-Za-z_]\w*)\s*\(/.exec(reason);
    if (call) found.push({ error: call[1], kind: "custom", line: lineOf(s, m.index) });
  }
  return found;
}

/** Contract/library/interface names declared in a source file. */
function declaredContracts(src) {
  const s = stripCommentsAndStrings(src);
  const names = [];
  const rx = /\b(?:abstract\s+)?(?:contract|library|interface)\s+([A-Za-z_]\w*)/g;
  let m;
  while ((m = rx.exec(s))) names.push(m[1]);
  return names;
}

/** `[child, [parents]]` pairs from `contract A is B, C(args) {` headers. */
function inheritancePairs(src) {
  const s = stripCommentsAndStrings(src);
  const out = [];
  const rx = /\b(?:abstract\s+)?(?:contract|interface)\s+([A-Za-z_]\w*)\s+is\s+([^{]+)\{/g;
  let m;
  while ((m = rx.exec(s))) {
    const parents = [];
    let depth = 0, cur = "";
    for (const c of m[2]) {
      if (c === "(") depth++;
      else if (c === ")") { depth--; continue; }
      if (c === "," && depth === 0) { parents.push(cur); cur = ""; } else if (depth === 0) cur += c;
    }
    parents.push(cur);
    out.push([m[1], parents.map((p) => p.trim().split(".").pop()).filter(Boolean)]);
  }
  return out;
}

module.exports = {
  VALUE_DIRS, isExcludedPath, walk, listFirstPartySol, stripComments, stripCommentsAndStrings,
  hasExecutableCode, extractReverts, declaredContracts, inheritancePairs, matchParen, splitArgs,
};
