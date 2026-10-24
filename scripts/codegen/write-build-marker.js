#!/usr/bin/env node
/**
 * Build marker (issue #1090).
 *
 * `bytecode-digest.js --compare` used to trust whatever sat in `artifacts/` unconditionally.
 * A FAILED `npm run compile` (a stalled solc download, a syntax error, a killed CI step) can
 * leave a partial or simply STALE `artifacts/` tree behind from the last time compile actually
 * succeeded, and the gate would report "byte-identical" having never re-hashed anything produced
 * by the change under review.
 *
 * This script is the ONLY thing that writes the marker, and it runs ONLY as npm's `postcompile`
 * hook (package.json: `compile` -> `hardhat compile`, npm auto-runs `postcompile` after it exits
 * 0) — so it fires exactly when `hardhat compile` itself succeeded, never on a failed or skipped
 * one. It commits to the repo-root `.build-marker.json` (beside artifacts/, which hardhat prunes):
 *   - sourcesHash: sha256 over every `contracts/**\/*.sol` file's path + bytes
 *   - fileCount:   how many source files went into that hash (surfaced in mismatch errors)
 *   - writtenAt:   for a human reading the file; freshness is judged from the marker's own
 *                  mtime on disk, not this field, so clock skew between machines can't matter
 *
 * `--compare` (scripts/codegen/bytecode-digest.js) refuses to trust `artifacts/` unless a marker
 * exists, its recorded hash matches a FRESH hash over the CURRENT sources, and it is not older
 * than any of them. Never delete this file to get past a compare failure and never `rm -rf
 * artifacts/` to "fix" a stale marker — the only correct move is `npm run compile`.
 */
const fs = require("fs");
const path = require("path");
const { hashSources, ROOT } = require("./lib/sourceHash");

const ARTIFACTS_DIR = path.join(ROOT, "artifacts");
// The marker lives BESIDE artifacts/, never inside it: hardhat prunes files it did not emit
// from artifacts/ on every invocation (a no-op `hardhat compile` deletes a foreign dotfile
// there — measured), so a marker inside the directory disappears the moment any later step
// runs `hardhat run`/`compile`, and the gate then fails about the wrong thing.
const MARKER_PATH = path.join(ROOT, ".build-marker.json");

if (!fs.existsSync(ARTIFACTS_DIR)) {
  console.error(
    "FAIL: artifacts/ does not exist after `hardhat compile` reported success — nothing to mark fresh."
  );
  process.exit(1);
}

const { sourcesHash, fileCount } = hashSources();
const marker = {
  writtenAt: new Date().toISOString(),
  sourcesHash,
  fileCount,
};
fs.writeFileSync(MARKER_PATH, `${JSON.stringify(marker, null, 1)}\n`);
console.log(
  `build marker written: ${fileCount} contracts/**/*.sol files, hash ${sourcesHash.slice(0, 12)}…`
);
