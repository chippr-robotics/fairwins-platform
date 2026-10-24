#!/usr/bin/env node
/**
 * Tests for the E2E matrix tracker-hygiene gate (issue #1400).
 *
 * The scenario this gate exists for is #1400 itself: 11 of 15 `absent` rows in
 * frontend/cypress/coverage/matrix.json cited issues that were already CLOSED. A gate that lets a
 * closed tracker read as fine is worse than no gate — it is why the situation recurred at all. Each
 * family below is a must-fail fixture the gate has to catch, plus the two "this must NOT fail"
 * shapes (nothing to check; every tracker genuinely open) that prove it does not just fail on
 * anything it sees.
 */
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  absentOrPartialRows,
  parseIssueField,
  classifyRows,
  buildFindings,
  formatReport,
  main,
} = require("../check-absent-trackers.js");

// `main` is async — the finally below must run AFTER it settles, or the real console gets
// restored while main is still paused on an awaited fetch, and its later console.log/error calls
// leak to real stdout instead of being silenced.
async function withSilencedConsole(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

function writeMatrix(dir, flows) {
  const matrixPath = path.join(dir, "matrix.json");
  fs.writeFileSync(
    matrixPath,
    JSON.stringify({
      generatedDoc: "docs/developer-guide/e2e-coverage-matrix.md",
      specs: [{ id: "999-fixture", title: "Fixture spec", memberFacing: true, flows }],
    })
  );
  return matrixPath;
}

/** A fetch stub keyed by issue number → GitHub issue state ('open' | 'closed' | 404 | Error). */
function stubFetch(byIssue) {
  return async (url) => {
    const m = /\/issues\/(\d+)$/.exec(url);
    const n = Number(m[1]);
    const outcome = byIssue[n];
    if (outcome === undefined) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (outcome instanceof Error) throw outcome;
    if (outcome === 404) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ number: n, state: outcome }) };
  };
}

// ── parsing ────────────────────────────────────────────────────────────────────────────────────

test("parseIssueField accepts only #<digits>", () => {
  assert.equal(parseIssueField("#1234"), 1234);
  assert.equal(parseIssueField("#1"), 1);
  assert.equal(parseIssueField("1234"), null, "bare number, no #, is not the row's documented format");
  assert.equal(parseIssueField("#0"), null, "no such issue number");
  assert.equal(parseIssueField("#12,34"), null);
  assert.equal(parseIssueField(""), null);
  assert.equal(parseIssueField(undefined), null);
  assert.equal(parseIssueField(null), null);
  assert.equal(parseIssueField(42), null, "not even a string");
});

test("classifyRows separates a parseable issue field from a malformed/missing one", () => {
  const rows = [
    { id: "a", issue: "#10" },
    { id: "b", issue: "not-an-issue" },
    { id: "c" }, // no issue field at all
  ];
  const { withNumber, malformed } = classifyRows(rows);
  assert.deepEqual(
    withNumber.map((w) => w.row.id),
    ["a"]
  );
  assert.deepEqual(
    malformed.map((m) => m.id),
    ["b", "c"]
  );
});

test("absentOrPartialRows takes absent and partial, and only those", () => {
  const matrix = {
    specs: [
      {
        id: "s",
        flows: [
          { id: "f1", status: "absent" },
          { id: "f2", status: "partial" },
          { id: "f3", status: "covered" },
          { id: "f4", status: "out-of-scope" },
        ],
      },
    ],
  };
  assert.deepEqual(
    absentOrPartialRows(matrix).map((f) => f.id),
    ["f1", "f2"]
  );
});

// ── must-fail fixture: a closed tracker ───────────────────────────────────────────────────────
//
// This is the #1400 scenario measured directly: a row cites a real, well-formed issue number, and
// that issue is closed on GitHub. The gate must name the row and the tracker, and exit non-zero.

test("a CLOSED tracker fails main() and names the row and the issue", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-trackers-"));
  const matrixPath = writeMatrix(dir, [
    { id: "membership.send-voucher-from-portfolio", status: "absent", issue: "#1364" },
  ]);

  const fetchImpl = stubFetch({ 1364: "closed" });
  let code;
  let logged = "";
  const { error } = console;
  console.error = (...args) => {
    logged += args.join(" ") + "\n";
  };
  try {
    code = await main(["--matrix", matrixPath], { GITHUB_TOKEN: "test-token" }, fetchImpl);
  } finally {
    console.error = error;
  }

  assert.equal(code, 1);
  assert.match(logged, /membership\.send-voucher-from-portfolio/);
  assert.match(logged, /#1364/);
  assert.match(logged, /CLOSED/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildFindings reports a closed tracker even for a `partial` row, not only `absent`", () => {
  const rows = [{ specId: "s", id: "p1", status: "partial", issue: "#42" }];
  const states = new Map([[42, { state: "closed" }]]);
  const findings = buildFindings(rows, states);
  assert.equal(findings.length, 1);
  assert.match(findings[0].reason, /CLOSED/);
});

// ── must-fail fixture: a malformed / missing issue field ─────────────────────────────────────
//
// No network call can rescue this — there is no tracker number to look up at all, which is exactly
// as bad as a resolvable-but-closed one: nobody is notified the gap exists.

test("a malformed `issue` field fails, even offline (no token, no --allow-offline)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-trackers-"));
  const matrixPath = writeMatrix(dir, [{ id: "bad.field", status: "absent", issue: "TBD" }]);

  const result = await withSilencedConsole(() => main(["--matrix", matrixPath], {}, stubFetch({})));
  assert.equal(result, 2, "no token at all still exits 2, not 0 — a malformed field is not swallowed by the offline path either");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing `issue` field fails main() with a token present", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-trackers-"));
  const matrixPath = writeMatrix(dir, [{ id: "no.field", status: "partial" }]);

  let logged = "";
  const { error } = console;
  console.error = (...args) => {
    logged += args.join(" ") + "\n";
  };
  let code;
  try {
    code = await main(["--matrix", matrixPath], { GITHUB_TOKEN: "t" }, stubFetch({}));
  } finally {
    console.error = error;
  }

  assert.equal(code, 1);
  assert.match(logged, /missing `issue` field/);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── must-pass fixture: every tracker genuinely open ───────────────────────────────────────────

test("every row citing an OPEN tracker passes with exit 0", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-trackers-"));
  const matrixPath = writeMatrix(dir, [
    { id: "a", status: "absent", issue: "#100" },
    { id: "b", status: "partial", issue: "#100" }, // same tracker cited twice — one fetch, not two
    { id: "c", status: "covered", issue: "#999" }, // covered rows are never checked at all
  ]);

  let fetchCount = 0;
  const fetchImpl = async (url) => {
    fetchCount++;
    return { ok: true, status: 200, json: async () => ({ state: "open" }) };
  };

  const code = await withSilencedConsole(() =>
    main(["--matrix", matrixPath], { GITHUB_TOKEN: "t" }, fetchImpl)
  );

  assert.equal(code, 0);
  assert.equal(fetchCount, 1, "the same issue number cited by two rows is fetched once, not per-row");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("no absent/partial rows in the matrix passes with exit 0, even with no token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-trackers-"));
  const matrixPath = writeMatrix(dir, [{ id: "a", status: "covered" }]);

  const code = await withSilencedConsole(() => main(["--matrix", matrixPath], {}, stubFetch({})));
  assert.equal(code, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── no-token behaviour ────────────────────────────────────────────────────────────────────────

test("no GITHUB_TOKEN and no --allow-offline: exit 2, never a silent pass", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-trackers-"));
  const matrixPath = writeMatrix(dir, [{ id: "a", status: "absent", issue: "#1" }]);

  const code = await withSilencedConsole(() => main(["--matrix", matrixPath], {}, stubFetch({ 1: "open" })));
  assert.equal(code, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("no GITHUB_TOKEN with --allow-offline: exit 0, loudly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-trackers-"));
  const matrixPath = writeMatrix(dir, [{ id: "a", status: "absent", issue: "#1" }]);

  let logged = "";
  const { error } = console;
  console.error = (...args) => {
    logged += args.join(" ") + "\n";
  };
  let code;
  try {
    code = await main(["--matrix", matrixPath, "--allow-offline"], {}, stubFetch({ 1: "open" }));
  } finally {
    console.error = error;
  }

  assert.equal(code, 0);
  assert.match(logged, /NO GITHUB TOKEN/);
  assert.match(logged, /--allow-offline/);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── unverifiable is never a pass ──────────────────────────────────────────────────────────────

test("a 404 (tracker does not exist) fails even with a token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-trackers-"));
  const matrixPath = writeMatrix(dir, [{ id: "a", status: "absent", issue: "#7777" }]);

  const code = await withSilencedConsole(() =>
    main(["--matrix", matrixPath], { GITHUB_TOKEN: "t" }, stubFetch({}))
  );
  assert.equal(code, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a network error while checking a tracker fails rather than passing silently", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-trackers-"));
  const matrixPath = writeMatrix(dir, [{ id: "a", status: "absent", issue: "#5" }]);

  const fetchImpl = stubFetch({ 5: new Error("ECONNRESET") });
  let logged = "";
  const { error } = console;
  console.error = (...args) => {
    logged += args.join(" ") + "\n";
  };
  let code;
  try {
    code = await main(["--matrix", matrixPath], { GITHUB_TOKEN: "t" }, fetchImpl);
  } finally {
    console.error = error;
  }

  assert.equal(code, 1);
  assert.match(logged, /could not be verified/);
  assert.match(logged, /ECONNRESET/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("a rate-limited (non-ok, non-404) response fails rather than passing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-trackers-"));
  const matrixPath = writeMatrix(dir, [{ id: "a", status: "absent", issue: "#5" }]);

  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const code = await withSilencedConsole(() =>
    main(["--matrix", matrixPath], { GITHUB_TOKEN: "t" }, fetchImpl)
  );
  assert.equal(code, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── --json ────────────────────────────────────────────────────────────────────────────────────

test("--json emits a machine-readable report on both pass and fail", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-e2e-trackers-"));
  const matrixPath = writeMatrix(dir, [{ id: "a", status: "absent", issue: "#9" }]);

  let out = "";
  const { log } = console;
  console.log = (...args) => {
    out += args.join(" ");
  };
  let code;
  try {
    code = await main(["--matrix", matrixPath, "--json"], { GITHUB_TOKEN: "t" }, stubFetch({ 9: "open" }));
  } finally {
    console.log = log;
  }
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.checked, 1);
  assert.deepEqual(parsed.findings, []);

  fs.rmSync(dir, { recursive: true, force: true });
});

// ── report formatting ────────────────────────────────────────────────────────────────────────

test("formatReport names the row, the issue and the remedy, and never suggests editing the matrix", () => {
  const findings = [{ row: "s :: f (absent)", issue: "#1", reason: "tracker #1 is CLOSED" }];
  const report = formatReport(findings, { repo: "chippr-robotics/prediction-dao-research", checked: 1 });
  assert.match(report, /s :: f \(absent\)/);
  assert.match(report, /#1400/);
  assert.match(report, /check:e2e-trackers/);
  assert.match(report, /Never edit the matrix/);
});
