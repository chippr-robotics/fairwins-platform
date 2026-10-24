"use strict";
/**
 * Shared source-hashing used by both write-build-marker.js (writes the marker after a
 * successful `hardhat compile`) and bytecode-digest.js (reads it back at `--compare` time).
 * Kept in one place so the two can never silently hash a different tree (issue #1090).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..", "..", "..");
// Mirrors hardhat.config.js `paths.sources` exactly. `contracts-archive/` is a SIBLING
// directory, not nested under this one, so it is never part of the walk below — consistent
// with CLAUDE.md's "never import or deploy it".
const SOURCES_DIR = path.join(ROOT, "contracts");

function collectSolFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSolFiles(p, out);
      continue;
    }
    if (entry.name.endsWith(".sol")) out.push(p);
  }
  return out;
}

/**
 * Returns { sourcesHash, fileCount, newestMtimeMs } over every `contracts/**\/*.sol` file:
 * a sha256 over each file's repo-relative path + bytes (order-independent — file list is
 * sorted first), the count, and the newest mtime among them (used for the staleness check).
 */
function hashSources() {
  const files = collectSolFiles(SOURCES_DIR)
    .map((p) => path.relative(ROOT, p))
    .sort();
  const hash = crypto.createHash("sha256");
  let newestMtimeMs = 0;
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    const stat = fs.statSync(abs);
    if (stat.mtimeMs > newestMtimeMs) newestMtimeMs = stat.mtimeMs;
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(abs));
    hash.update("\0");
  }
  return { sourcesHash: hash.digest("hex"), fileCount: files.length, newestMtimeMs };
}

module.exports = { hashSources, collectSolFiles, ROOT, SOURCES_DIR };
