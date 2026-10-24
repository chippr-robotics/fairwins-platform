#!/usr/bin/env node
/**
 * Bytecode digest snapshot (spec 075, FR-005 / SC-001).
 *
 * Records a sha256 of `bytecode` + `deployedBytecode` for every compiled contract so a build-system
 * change can be PROVEN byte-neutral. Any change to compiler settings, dependency resolution, or the
 * OpenZeppelin version that wins the hoist shows up here as a differing digest.
 *
 * Usage:
 *   node scripts/codegen/bytecode-digest.js --out <file>          # record
 *   node scripts/codegen/bytecode-digest.js --compare <baseline>  # verify (exit 1 on any diff)
 *
 * --compare trusts artifacts/ ONLY when it is backed by a fresh build marker (issue #1090): a
 * failed or skipped `npm run compile` can leave a stale artifacts/ tree from a PRIOR successful
 * compile in place, and this gate used to hash whatever was there with no way to tell — silently
 * approving a diff it never actually re-compiled. See checkFreshness() below and
 * scripts/codegen/write-build-marker.js (the only thing that writes the marker, as npm's
 * `postcompile` hook — so it never fires on a failed compile).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { hashSources, ROOT } = require("./lib/sourceHash");

const ARTIFACTS_ROOT = path.join(__dirname, "..", "..", "artifacts");
const ARTIFACTS = path.join(ARTIFACTS_ROOT, "contracts");
// Beside artifacts/, not inside it — hardhat prunes foreign files from artifacts/ on every
// invocation, so an in-tree marker would vanish under any later `hardhat run` step.
const MARKER_PATH = path.join(__dirname, "..", "..", ".build-marker.json");

// Fail CLOSED: --compare must never trust artifacts/ that were not just produced by a
// successful `npm run compile` of the sources currently on disk. Never "fix" a failure here by
// deleting the marker or artifacts/ — the only correct response is `npm run compile`.
function checkFreshness() {
  if (!fs.existsSync(MARKER_PATH)) {
    console.error(
      `FAIL: no build marker at ${path.relative(ROOT, MARKER_PATH)}.\n` +
        "artifacts/ has not been confirmed fresh by a successful `npm run compile` in this " +
        "workspace — it may be stale, partial, or left over from a failed compile.\n" +
        "Run `npm run compile` (never rm -rf artifacts/ and re-run this script against whatever " +
        "happens to already be on disk)."
    );
    process.exit(1);
  }

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(MARKER_PATH, "utf8"));
  } catch (e) {
    console.error(
      `FAIL: build marker at ${path.relative(ROOT, MARKER_PATH)} is not valid JSON (${e.message}).\n` +
        "Run `npm run compile` to regenerate it."
    );
    process.exit(1);
  }

  const markerMtimeMs = fs.statSync(MARKER_PATH).mtimeMs;
  const { sourcesHash, fileCount, newestMtimeMs } = hashSources();

  if (newestMtimeMs > markerMtimeMs) {
    console.error(
      "FAIL: the build marker is older than at least one contracts/**/*.sol file.\n" +
        "A source file changed after the last successful `npm run compile` — artifacts/ does not " +
        "reflect it. Run `npm run compile` again."
    );
    process.exit(1);
  }

  if (marker.sourcesHash !== sourcesHash) {
    console.error(
      "FAIL: the build marker's source hash does not match the current contracts/**/*.sol tree " +
        `(marker recorded ${marker.fileCount} files, current tree has ${fileCount}).\n` +
        "artifacts/ was not produced by compiling what is on disk now. Run `npm run compile`."
    );
    process.exit(1);
  }
}

function collect(dir, out = {}) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(p, out);
      continue;
    }
    if (!entry.name.endsWith(".json") || entry.name.endsWith(".dbg.json")) continue;
    let artifact;
    try {
      artifact = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    // Interfaces and abstract contracts compile to "0x"; keep them — a contract that STARTS
    // producing bytecode is as much a change as one whose bytecode moves.
    if (typeof artifact.bytecode !== "string") continue;
    const key = path.relative(path.join(__dirname, "..", ".."), p);
    out[key] = crypto
      .createHash("sha256")
      .update(`${artifact.bytecode}|${artifact.deployedBytecode || ""}`)
      .digest("hex");
  }
  return out;
}

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const cmpIdx = args.indexOf("--compare");
const digests = collect(ARTIFACTS);

if (Object.keys(digests).length === 0) {
  console.error("FAIL: no artifacts found — run `npm run compile` first");
  process.exit(2);
}

if (outIdx !== -1) {
  const target = args[outIdx + 1];
  fs.writeFileSync(target, `${JSON.stringify(digests, null, 1)}\n`);
  console.log(`recorded ${Object.keys(digests).length} contracts -> ${target}`);
  process.exit(0);
}

if (cmpIdx !== -1) {
  checkFreshness();
  const baseline = JSON.parse(fs.readFileSync(args[cmpIdx + 1], "utf8"));
  const bKeys = Object.keys(baseline).sort();
  const dKeys = Object.keys(digests).sort();
  const changed = bKeys.filter((k) => digests[k] && digests[k] !== baseline[k]);
  const removed = bKeys.filter((k) => !digests[k]);
  // A contract present now with no baseline entry (issue #1090 asked this be confirmed, not
  // assumed): it IS counted below (`added.length` feeds the same exit-1 branch as changed/removed)
  // — a compiled contract nobody has ever recorded a baseline for is exactly as unproven as one
  // whose bytecode moved, so this already fails closed rather than exiting 0.
  const added = dKeys.filter((k) => !baseline[k]);

  console.log(`baseline: ${bKeys.length} contracts | current: ${dKeys.length} contracts`);
  console.log(`CHANGED: ${changed.length}  REMOVED: ${removed.length}  ADDED: ${added.length}`);
  for (const k of changed.slice(0, 25)) console.log(`  ! changed  ${k}`);
  for (const k of removed.slice(0, 25)) console.log(`  - removed  ${k}`);
  for (const k of added.slice(0, 25)) console.log(`  + added    ${k}`);

  if (changed.length || removed.length || added.length) {
    console.error(
      "\nFAIL: bytecode is NOT byte-identical to the baseline.\n" +
        "Per spec 075 FR-005 this BLOCKS the change. Do not merge.\n" +
        "If the compiler target moved, treat it as an incident against the live implementations first."
    );
    process.exit(1);
  }
  console.log("\nOK: bytecode byte-identical to baseline.");
  process.exit(0);
}

console.error("usage: bytecode-digest.js --out <file> | --compare <baseline>");
process.exit(2);
