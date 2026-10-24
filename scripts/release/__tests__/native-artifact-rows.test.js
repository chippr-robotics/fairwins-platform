// Spec 102 — the native artifact rows script, with the must-fail cases that
// make FR-009 enforceable: a record can never describe an artifact that was
// not handed over (empty digest set fails; a digest missing a field fails),
// and the `signed` column renders honestly.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SCRIPT = path.resolve(__dirname, "..", "native-artifact-rows.js");

function run(args, { expectFailure = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    assert.equal(expectFailure, false, `expected failure, got success:\n${stdout}`);
    return { status: 0, stdout };
  } catch (err) {
    assert.equal(expectFailure, true, `unexpected failure:\n${err.stderr || err.message}`);
    return { status: err.status, stderr: err.stderr };
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "native-rows-"));
}

test("appends one row per digest with sha256 and an honest signed column", () => {
  const dir = tempDir();
  const digests = path.join(dir, "digests");
  fs.mkdirSync(path.join(digests, "native-digest-android"), { recursive: true });
  fs.writeFileSync(
    path.join(digests, "native-digest-android", "android.digest.json"),
    JSON.stringify({ channel: "android", artifact: "FairWins-v1.16.0.aab", sha256: "a".repeat(64), signed: true })
  );
  fs.mkdirSync(path.join(digests, "native-digest-ios"), { recursive: true });
  fs.writeFileSync(
    path.join(digests, "native-digest-ios", "ios.digest.json"),
    JSON.stringify({ channel: "ios", artifact: "FairWins-v1.16.0-ios.xcarchive.zip", sha256: "b".repeat(64), signed: false })
  );
  const table = path.join(dir, "artifacts.md");
  fs.writeFileSync(table, "# existing table\n");

  run(["--digests", digests, "--version", "v1.16.0", "--append", table]);
  const out = fs.readFileSync(table, "utf8");
  assert.match(out, /# existing table/);
  assert.match(out, /\| android \| `FairWins-v1\.16\.0\.aab` \| `a{64}` \| yes \|/);
  assert.match(out, /\| ios \| .* \| `b{64}` \| no — operator signing ceremony/);
});

test("MUST-FAIL: an empty digest set is a hard failure, never a silent omission", () => {
  const dir = tempDir();
  const digests = path.join(dir, "digests");
  fs.mkdirSync(digests, { recursive: true });
  const table = path.join(dir, "artifacts.md");
  fs.writeFileSync(table, "");
  const { stderr } = run(["--digests", digests, "--version", "v1.16.0", "--append", table], { expectFailure: true });
  assert.match(stderr, /did not hand anything over/);
  assert.equal(fs.readFileSync(table, "utf8"), "");
});

test("MUST-FAIL: a digest missing a required field is rejected", () => {
  const dir = tempDir();
  const digests = path.join(dir, "d");
  fs.mkdirSync(digests, { recursive: true });
  fs.writeFileSync(path.join(digests, "x.digest.json"), JSON.stringify({ channel: "android", artifact: "a.aab" }));
  const table = path.join(dir, "artifacts.md");
  fs.writeFileSync(table, "");
  const { stderr } = run(["--digests", digests, "--version", "v1.16.0", "--append", table], { expectFailure: true });
  assert.match(stderr, /missing "sha256"/);
});
