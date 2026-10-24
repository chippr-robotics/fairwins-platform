/**
 * Tests for the build-marker freshness gate (issue #1090).
 *
 * bytecode-digest.js --compare must fail closed when artifacts/ is not backed by a marker that
 * was just written by a successful compile of the CURRENT sources. Exercised against a throwaway
 * fixture tree (never the real repo's contracts/ or artifacts/) so this suite needs no compile
 * and no chain.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DIGEST_SCRIPT = path.join(REPO_ROOT, "scripts", "codegen", "bytecode-digest.js");
const MARKER_SCRIPT = path.join(REPO_ROOT, "scripts", "codegen", "write-build-marker.js");

// bytecode-digest.js and write-build-marker.js both resolve their own repo root relative to
// __dirname, so a standalone throwaway tree can't be pointed at them directly. Instead each test
// builds a fixture "repo" (contracts/, artifacts/contracts/) and copies the two scripts plus their
// shared lib alongside it, preserving their real relative path (scripts/codegen/…) so
// `path.join(__dirname, "..", "..", "..")` still lands on the fixture root.
function makeFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-marker-test-"));
  const codegenDir = path.join(root, "scripts", "codegen");
  fs.mkdirSync(path.join(codegenDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(codegenDir, "__tests__"), { recursive: true });
  fs.mkdirSync(path.join(root, "contracts"), { recursive: true });
  fs.mkdirSync(path.join(root, "artifacts", "contracts"), { recursive: true });

  for (const rel of [
    "scripts/codegen/bytecode-digest.js",
    "scripts/codegen/write-build-marker.js",
    "scripts/codegen/lib/sourceHash.js",
  ]) {
    fs.copyFileSync(path.join(REPO_ROOT, rel), path.join(root, rel));
  }

  return root;
}

function writeContract(root, relName, source) {
  const abs = path.join(root, "contracts", relName);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, source);
}

function writeArtifact(root, name, bytecode) {
  const abs = path.join(root, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    JSON.stringify({ contractName: name, bytecode, deployedBytecode: bytecode })
  );
}

function runMarker(root) {
  return execFileSync(process.execPath, [path.join(root, "scripts/codegen/write-build-marker.js")], {
    cwd: root,
  });
}

function runCompare(root, baselineName) {
  return execFileSync(
    process.execPath,
    [
      path.join(root, "scripts/codegen/bytecode-digest.js"),
      "--compare",
      path.join(root, baselineName),
    ],
    { cwd: root }
  );
}

function runOut(root, target) {
  return execFileSync(
    process.execPath,
    [path.join(root, "scripts/codegen/bytecode-digest.js"), "--out", path.join(root, target)],
    { cwd: root }
  );
}

test("--compare refuses when no build marker exists", () => {
  const root = makeFixtureRepo();
  writeContract(root, "Foo.sol", "contract Foo {}");
  writeArtifact(root, "Foo", "0x600160005260206000f3");
  fs.writeFileSync(path.join(root, "baseline.json"), JSON.stringify({}));

  assert.throws(() => runCompare(root, "baseline.json"), /no build marker/i);
});

test("--compare refuses when a source file changed after the marker was written", () => {
  const root = makeFixtureRepo();
  writeContract(root, "Foo.sol", "contract Foo {}");
  writeArtifact(root, "Foo", "0x600160005260206000f3");
  runMarker(root);
  runOut(root, "baseline.json");

  // Bump the marker's own mtime back in time so the freshly-edited source unambiguously reads
  // as newer than it, independent of how fast this test runs.
  const markerPath = path.join(root, ".build-marker.json");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(markerPath, past, past);

  // Edit the source AFTER the marker exists, without recompiling.
  writeContract(root, "Foo.sol", "contract Foo { uint256 public x; }");

  assert.throws(() => runCompare(root, "baseline.json"), /older than at least one/i);
});

test("--compare refuses when the marker's hash does not match the current sources", () => {
  const root = makeFixtureRepo();
  writeContract(root, "Foo.sol", "contract Foo {}");
  writeArtifact(root, "Foo", "0x600160005260206000f3");
  runMarker(root);
  runOut(root, "baseline.json");

  // Corrupt just the marker's recorded hash — content on disk still matches what was hashed at
  // write time, but the marker itself is now lying about it.
  const markerPath = path.join(root, ".build-marker.json");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  marker.sourcesHash = "0".repeat(64);
  fs.writeFileSync(markerPath, JSON.stringify(marker));
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(markerPath, future, future);

  assert.throws(() => runCompare(root, "baseline.json"), /does not match the current/i);
});

test("--compare succeeds against a fresh marker and reports byte-identical", () => {
  const root = makeFixtureRepo();
  writeContract(root, "Foo.sol", "contract Foo {}");
  writeArtifact(root, "Foo", "0x600160005260206000f3");
  runMarker(root);
  runOut(root, "baseline.json");

  const out = runCompare(root, "baseline.json").toString();
  assert.match(out, /OK: bytecode byte-identical to baseline/);
});

test("--compare fails closed on an added contract with no baseline entry", () => {
  const root = makeFixtureRepo();
  writeContract(root, "Foo.sol", "contract Foo {}");
  writeArtifact(root, "Foo", "0x600160005260206000f3");
  runMarker(root);
  // Empty baseline: Foo has never been recorded.
  fs.writeFileSync(path.join(root, "baseline.json"), JSON.stringify({}));

  assert.throws(() => runCompare(root, "baseline.json"), (err) => {
    assert.match(err.stdout.toString() + err.stderr.toString(), /ADDED: 1/);
    assert.match(err.stderr.toString(), /NOT byte-identical/i);
    return true;
  });
});
