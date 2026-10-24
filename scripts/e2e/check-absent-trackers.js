#!/usr/bin/env node
/**
 * E2E matrix tracker-hygiene gate (issue #1400 — "matrix hygiene").
 *
 * WHY THIS EXISTS
 * `frontend/cypress/coverage/matrix.json` carries an `issue: '#NNNN'` tracker on every `absent` and
 * `partial` row — the promise being "this gap has an open home, go there for the plan to close it".
 * #1400 found that promise was false for most of the matrix: 11 of its 15 absent rows cited issues
 * that were already CLOSED (#1364, #1366, #1370, #1268, #1271). A closed tracker on an open gap is
 * not a paperwork error — it means nobody is notified the gap still exists, and the gate that is
 * supposed to prove coverage progress (`npm run e2e:matrix`) renders a closed issue number next to
 * `absent` and calls that informative. This is also a RECURRING class, not a one-off: #1400 is
 * itself the second time this was found. A comment on a row does not stay true by itself — closing
 * an issue does not walk back to the matrix rows that cited it. Hence a gate, not a note.
 *
 * WHAT IT CHECKS
 * Every `absent`/`partial` flow row's `issue` field must:
 *   1. exist and match `#<number>` (a missing or malformed field is exactly as bad as a bad one —
 *      there is no tracker to check, so there is no plan to close the gap either); and
 *   2. name a GitHub issue that is OPEN in this repository right now.
 *
 * A `covered` or `out-of-scope` row is not checked — those states are not gaps, and forcing an
 * issue reference onto them would just be more paperwork than the reason for this gate justifies.
 *
 * NO-TOKEN BEHAVIOUR IS DELIBERATE
 * Without a token this gate cannot ask GitHub anything, and "could not check" must never render as
 * "passed" — that is the exact failure this gate exists to close (a stale reference sitting there
 * because nothing ever re-verified it). So with no `GITHUB_TOKEN` the gate prints a loud notice and:
 *   - exits 2 (a distinct code from the tracker-found-a-problem case, `1`) unless `--allow-offline`
 *     is passed, in which case it exits 0 so a contributor can run the local suite without a token.
 * CI always carries `GITHUB_TOKEN` and never passes `--allow-offline` — see
 * .github/workflows/e2e-matrix-trackers.yml.
 *
 * An issue that cannot be resolved even WITH a token (a 404, a rate limit, a network error) is
 * likewise never a silent pass — it is reported as its own finding, because a reference nothing can
 * verify is not evidence of an open tracker either.
 *
 * Usage:
 *   node scripts/e2e/check-absent-trackers.js [--matrix <path>] [--repo <owner/repo>]
 *                                             [--allow-offline] [--json]
 *
 * Exit codes: 0 = every absent/partial row cites a verified-open tracker (or nothing to check, or
 * --allow-offline with no token). 1 = at least one row's tracker is closed, missing, malformed, or
 * unverifiable. 2 = no GITHUB_TOKEN and --allow-offline was not passed.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_MATRIX = path.join(ROOT, "frontend", "cypress", "coverage", "matrix.json");
const DEFAULT_REPO = "chippr-robotics/fairwins-platform";

/** `#1234` only — anything else (bare number, whitespace-mangled, a range, absent) is malformed. */
const ISSUE_RE = /^#([1-9]\d*)$/;

const readMatrix = (matrixPath) => JSON.parse(fs.readFileSync(matrixPath, "utf8"));

/** Every flow in the file, each carrying the spec it came from — mirrors generate-coverage-matrix.js. */
function allFlows(matrix) {
  return matrix.specs.flatMap((spec) =>
    (spec.flows || []).map((flow) => ({ ...flow, specId: spec.id }))
  );
}

/** The rows this gate exists for: gaps that are supposed to carry a live tracker. */
function absentOrPartialRows(matrix) {
  return allFlows(matrix).filter((f) => f.status === "absent" || f.status === "partial");
}

/** `'#1234'` → `1234`; anything else (undefined, `'1234'`, `'#12,34'`, `''`) → null. */
function parseIssueField(issue) {
  if (typeof issue !== "string") return null;
  const m = ISSUE_RE.exec(issue.trim());
  return m ? Number(m[1]) : null;
}

/** Split rows into those with a parseable `#NNN` issue field and those without one at all. */
function classifyRows(rows) {
  const withNumber = [];
  const malformed = [];
  for (const row of rows) {
    const issueNumber = parseIssueField(row.issue);
    if (issueNumber === null) malformed.push(row);
    else withNumber.push({ row, issueNumber });
  }
  return { withNumber, malformed };
}

/**
 * One issue's state from the GitHub REST API, normalised to a small vocabulary so the caller never
 * has to reason about HTTP status codes:
 *   open / closed  — the two real states GitHub reports.
 *   not_found      — the tracker does not exist (or this token cannot see it) — a 404.
 *   api_error      — anything else that stopped the read from completing (rate limit, network
 *                    failure, an unexpected response shape). Never treated as open.
 */
async function fetchIssueState(repo, issueNumber, token, fetchImpl) {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "fairwins-e2e-matrix-trackers",
      },
    });
  } catch (err) {
    return { state: "api_error", detail: err && err.message ? err.message : String(err) };
  }

  if (res.status === 404) return { state: "not_found" };
  if (!res.ok) return { state: "api_error", detail: `HTTP ${res.status}` };

  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { state: "api_error", detail: `unparseable response body: ${err.message}` };
  }

  if (body.state !== "open" && body.state !== "closed") {
    return { state: "api_error", detail: `unexpected issue state ${JSON.stringify(body.state)}` };
  }
  return { state: body.state };
}

/** One GitHub call per DISTINCT issue number, sequentially — never per row (#1364 alone is cited 4x). */
async function fetchAllIssueStates(issueNumbers, { repo, token, fetchImpl }) {
  const unique = [...new Set(issueNumbers)];
  const states = new Map();
  for (const issueNumber of unique) {
    states.set(issueNumber, await fetchIssueState(repo, issueNumber, token, fetchImpl));
  }
  return states;
}

const rowLabel = (row) => `${row.specId} :: ${row.id} (${row.status})`;

/**
 * Every row that fails the gate, each naming why. `states` is what fetchAllIssueStates returns; pass
 * `null` for the "malformed only" pass used before any network call is made.
 */
function buildFindings(rows, states) {
  const { withNumber, malformed } = classifyRows(rows);
  const findings = [];

  for (const row of malformed) {
    findings.push({
      row: rowLabel(row),
      issue: row.issue === undefined ? null : row.issue,
      reason:
        row.issue === undefined
          ? "missing `issue` field"
          : `malformed \`issue\` field (want "#NNN"): ${JSON.stringify(row.issue)}`,
    });
  }

  if (!states) return findings;

  for (const { row, issueNumber } of withNumber) {
    const state = states.get(issueNumber);
    if (!state || state.state === "open") continue;
    if (state.state === "closed") {
      findings.push({ row: rowLabel(row), issue: row.issue, reason: `tracker #${issueNumber} is CLOSED` });
    } else if (state.state === "not_found") {
      findings.push({
        row: rowLabel(row),
        issue: row.issue,
        reason: `tracker #${issueNumber} does not exist (404) in this repository`,
      });
    } else {
      findings.push({
        row: rowLabel(row),
        issue: row.issue,
        reason: `tracker #${issueNumber} could not be verified (${state.detail})`,
      });
    }
  }

  return findings;
}

function formatReport(findings, { repo, checked }) {
  if (findings.length === 0) {
    return `e2e matrix trackers: PASS — ${checked} absent/partial row(s) each cite an open tracker in ${repo}.`;
  }
  const lines = [
    "",
    `e2e matrix trackers: ${findings.length} absent/partial row(s) cite a tracker that is not a live, ` +
      `open issue in ${repo}.`,
    "",
  ];
  for (const f of findings) {
    lines.push(`  ${f.row}`);
    lines.push(`    issue: ${f.issue === null ? "(none)" : f.issue}`);
    lines.push(`    ${f.reason}`);
  }
  lines.push("");
  lines.push(
    "  Every `absent`/`partial` row in frontend/cypress/coverage/matrix.json must cite an OPEN " +
      "tracking issue (#1400)."
  );
  lines.push(
    "  Reopen the tracker, or point the row at a fresh issue describing the gap, then re-run " +
      "`npm run check:e2e-trackers`."
  );
  lines.push("  Never edit the matrix's status/depth to make the gate pass — the gap did not close.");
  lines.push("");
  return lines.join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { json: false, allowOffline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--matrix") out.matrix = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--allow-offline") out.allowOffline = true;
    else if (a === "--json") out.json = true;
  }
  return out;
}

async function main(argv, env = process.env, fetchImpl) {
  const args = parseArgs(argv);
  const matrixPath = args.matrix ? path.resolve(ROOT, args.matrix) : DEFAULT_MATRIX;
  const repo = args.repo || env.GITHUB_REPOSITORY || DEFAULT_REPO;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || "";

  const matrix = readMatrix(matrixPath);
  const rows = absentOrPartialRows(matrix);

  if (rows.length === 0) {
    if (args.json) {
      console.log(JSON.stringify({ ok: true, repo, checked: 0, findings: [] }, null, 2));
    } else {
      console.log("e2e matrix trackers: no absent/partial rows in the matrix — nothing to verify.");
    }
    return 0;
  }

  // Malformed/missing `issue` fields fail regardless of token — no network call can rescue those.
  const preNetworkFindings = buildFindings(rows, null);

  if (!token) {
    const notice = [
      "",
      `e2e matrix trackers: NO GITHUB TOKEN — cannot verify ${rows.length} absent/partial row(s) ` +
        `against ${repo}.`,
      "This is NOT a pass: an unverified tracker reference is exactly the failure this gate exists",
      "to catch (#1400 — 11 of 15 absent rows cited issues that were already closed).",
      "",
      "Set GITHUB_TOKEN to verify for real, or pass --allow-offline for an explicit local skip.",
      "",
    ].join("\n");
    console.error(notice);
    if (preNetworkFindings.length > 0) {
      console.error(formatReport(preNetworkFindings, { repo, checked: rows.length }));
    }
    if (args.allowOffline) {
      console.error("--allow-offline passed: skipping tracker verification, exit 0.");
      return 0;
    }
    return 2;
  }

  const effectiveFetch = fetchImpl || globalThis.fetch;
  if (typeof effectiveFetch !== "function") {
    console.error(
      "e2e matrix trackers: no fetch implementation available (Node 18+ ships one; pass one for tests)."
    );
    return 2;
  }

  const { withNumber } = classifyRows(rows);
  const states = await fetchAllIssueStates(
    withNumber.map((w) => w.issueNumber),
    { repo, token, fetchImpl: effectiveFetch }
  );
  const findings = buildFindings(rows, states);

  if (args.json) {
    console.log(
      JSON.stringify({ ok: findings.length === 0, repo, checked: rows.length, findings }, null, 2)
    );
  } else {
    const report = formatReport(findings, { repo, checked: rows.length });
    if (findings.length > 0) console.error(report);
    else console.log(report);
  }

  return findings.length > 0 ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err && err.stack ? err.stack : String(err));
      process.exit(1);
    }
  );
}

module.exports = {
  allFlows,
  absentOrPartialRows,
  parseIssueField,
  classifyRows,
  fetchIssueState,
  fetchAllIssueStates,
  buildFindings,
  formatReport,
  parseArgs,
  main,
  readMatrix,
  DEFAULT_REPO,
};
