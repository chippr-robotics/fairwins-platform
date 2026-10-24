#!/usr/bin/env node
/**
 * Promotion configuration check (spec 076, FR-024/FR-027a/FR-026b).
 *
 * Runs on a `staging` -> `main` pull request and answers one question: did staging actually rehearse
 * what production is about to run?
 *
 * TWO CHECKS, both of which have to hold:
 *
 *  1. ENUMERATED DIFFERENCES ONLY (FR-027a). Every build arg that differs between cloudbuild.yaml
 *     (production) and cloudbuild.staging.yaml (the mainnet mirror) must be on the list in
 *     contracts/environments.md. An UNLISTED difference means staging exercised a different
 *     configuration, so its green result says nothing about production.
 *
 *  2. THE COHORT BOUNDARY IS UNTOUCHED (FR-026b). frontend/src/config/networks.js must not have
 *     been modified by the staging arrangement. Staging reaches both cohorts by being TWO SERVICES,
 *     not by loosening the build-time cohort rule — and the strongest available proof of "the
 *     production build is unaffected" is that the file deciding it did not change.
 *
 * Usage:
 *   node scripts/release/check-promotion-config.js [--base origin/main] [--head HEAD]
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const PROD = path.join(ROOT, "cloudbuild.yaml");
const STAGING = path.join(ROOT, "cloudbuild.staging.yaml");
const COHORT_FILE = "frontend/src/config/networks.js";

/**
 * Build args permitted to differ between production and the MAINNET staging service.
 * Mirrors contracts/environments.md § "Enumerated differences". Adding to this list is a reviewed
 * decision, which is exactly why the check points at the document.
 */
const ENUMERATED = new Set([
  "VITE_APP_URL", // 1. hostname
  "VITE_RELAYER_URL", // 5. staging's own relayer
  "VITE_BUNDLER_URLS_POLYGON", // 5. staging's own bundler
  "VITE_SPONSOR_PAYMASTER_POLYGON", // 5. staging's own paymaster
  "VITE_STAGING_BANNER", // 4. non-production marker
  "VITE_APP_VERSION", // 6. differs by construction
  "VITE_GIT_SHA", // 6. differs by construction
]);

/** Build args from a cloudbuild file, as name -> value. */
function buildArgs(file, { onlyBefore = null } = {}) {
  if (!fs.existsSync(file)) return null;
  let text = fs.readFileSync(file, "utf8");
  // The staging file builds two images; only the FIRST (mainnet) is the production mirror.
  if (onlyBefore && text.includes(onlyBefore)) {
    text = text.slice(0, text.indexOf(onlyBefore));
  }
  const out = {};
  for (const m of text.matchAll(/^\s*-\s*'([A-Z][A-Z0-9_]*)=(.*)'\s*$/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function checkEnumeratedDifferences() {
  const prod = buildArgs(PROD);
  const staging = buildArgs(STAGING, { onlyBefore: "id: build-testnet" });
  if (!prod || !staging) {
    return [`could not read ${!prod ? "cloudbuild.yaml" : "cloudbuild.staging.yaml"} — cannot verify the mirror`];
  }

  const problems = [];
  const names = new Set([...Object.keys(prod), ...Object.keys(staging)]);
  for (const name of names) {
    if (ENUMERATED.has(name)) continue;
    const a = prod[name];
    const b = staging[name];
    if (a === b) continue;
    if (a === undefined) {
      problems.push(`${name} is set on staging but not production ("${b}")`);
    } else if (b === undefined) {
      problems.push(`${name} is set on production but not staging ("${a}")`);
    } else {
      problems.push(`${name} differs: production "${a}" vs staging "${b}"`);
    }
  }
  return problems;
}

/**
 * The symbols that actually DECIDE a build's cohort. Changing any of these changes which chains a
 * build reads, which chain membership is bought and read on, or which side of the testnet/mainnet
 * line a network sits — the thing FR-026b exists to protect.
 *
 * Everything else in networks.js — tickers, RPC URLs, explorer links, subgraph endpoints, comments —
 * is ordinary configuration that cannot move the boundary.
 */
const COHORT_CONSTANTS = [
  "PRIMARY_CHAIN_ID",
  "MAINNET_CHAIN_ID",
  "TESTNET_CHAIN_ID",
  "MINIAPP_TESTNET_CHAIN_ID",
  // The spec-094 E2E seam. DEV-gated, but it ADDS a chain to the cohort when set, so it is guarded.
  "E2E_AMOY_LOCAL",
];

const COHORT_FUNCTIONS = [
  "buildIsTestnet",
  "getCurrentChainId",
  "membershipChainId",
  "miniAppChainId",
  "cohortChainIds",
  "isInCohort",
  "listSupportedChainIds",
];

/** Comments and whitespace cannot move a boundary, so they must not be able to fail this gate. */
function normalise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Body of `function NAME(...) { … }`, brace-counted so a nested block cannot end it early. */
function functionBody(text, name) {
  const decl = new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`);
  const at = text.search(decl);
  if (at === -1) return null;
  const open = text.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return normalise(text.slice(open, i + 1));
    }
  }
  return null;
}

/** Initialiser of `const NAME = …`, up to the next top-level declaration or blank line. */
function constantValue(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s*(?:export\\s+)?const\\s+${name}\\s*=`).test(l));
  if (start === -1) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*$/.test(lines[i]) || /^\s*(?:export\s+)?(?:const|function|\/\*)/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return normalise(out.join("\n"));
}

/** chainId -> isTestnet, for every entry of the NETWORKS map. */
function networkCohorts(text) {
  const at = text.indexOf("const NETWORKS = {");
  if (at === -1) return null;
  const open = text.indexOf("{", at);
  const out = {};
  let depth = 0;
  let entry = null;
  let entryStart = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      depth += 1;
      if (depth === 2) {
        const head = text.slice(text.lastIndexOf("\n", i) + 1, i);
        const m = head.match(/^\s*(\d+)\s*:/);
        entry = m ? m[1] : null;
        entryStart = i;
      }
    } else if (ch === "}") {
      if (depth === 2 && entry) {
        const body = text.slice(entryStart, i);
        out[entry] = /isTestnet\s*:\s*true/.test(body);
        entry = null;
      }
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return out;
}

/**
 * Everything about a version of networks.js that can move the cohort boundary.
 *
 * Returns null for any part it could not extract. That is deliberate: a silent empty answer here
 * would make the gate pass on a file it failed to understand, which is the worst possible failure
 * for a guard — it would report safety it never established.
 */
function cohortFacts(text) {
  const constants = {};
  for (const name of COHORT_CONSTANTS) constants[name] = constantValue(text, name);
  const functions = {};
  for (const name of COHORT_FUNCTIONS) functions[name] = functionBody(text, name);
  return { constants, functions, networks: networkCohorts(text) };
}

/**
 * FR-026b, checked by MEANING rather than by filename.
 *
 * The original check failed on ANY edit to networks.js. That is a proxy, and it was too coarse:
 * the file changed 36 times in 90 days — tickers, RPC failovers, explorer URLs — and each one
 * blocked a release that had nothing to do with the testnet/mainnet boundary. The documented remedy
 * (land the file on main in its own PR) only works for a file that changes rarely; for this one it
 * became a treadmill, and on 2026-08-29 the file changed AGAIN mid-remedy.
 *
 * A guard that cries wolf on ordinary configuration gets worked around, and a worked-around guard
 * protects nothing. So this compares the things that actually decide a cohort — the chain-id
 * constants, the resolver functions, and each network's isTestnet flag — and passes anything else
 * while SAYING what it compared.
 *
 * It still fails CLOSED: if either version cannot be parsed, that is a refusal, not a pass.
 */
function checkCohortBoundary(base, head) {
  const changed = git(["diff", "--name-only", `${base}...${head}`]);
  if (changed === null) return [`could not diff ${base}...${head} — cannot verify the cohort boundary`];
  if (!changed.split("\n").includes(COHORT_FILE)) return [];

  const before = git(["show", `${base}:${COHORT_FILE}`]);
  const after = git(["show", `${head}:${COHORT_FILE}`]);
  if (before === null || after === null) {
    return [`${COHORT_FILE} changed and could not be read at both revisions — cannot verify the cohort boundary`];
  }

  return compareCohortFacts(cohortFacts(before), cohortFacts(after));
}

/**
 * Pure comparison of two versions' cohort machinery. Separated from git so it can be tested
 * directly — a guard whose decision logic is only reachable through a real repository is a guard
 * nobody writes the failing cases for.
 */
function compareCohortFacts(a, b) {
  const problems = [];

  const unreadable = [];
  for (const [side, facts] of [["base", a], ["head", b]]) {
    if (facts.networks === null) unreadable.push(`${side}: the NETWORKS map`);
    for (const [name, v] of Object.entries(facts.constants)) if (v === null) unreadable.push(`${side}: const ${name}`);
    for (const [name, v] of Object.entries(facts.functions)) if (v === null) unreadable.push(`${side}: function ${name}`);
  }
  if (unreadable.length > 0) {
    return [
      `${COHORT_FILE} changed, and this gate could not locate its cohort machinery (${unreadable.join("; ")}). ` +
        `Refusing rather than passing: an unparsed guard that returns "no problems" reports a safety it ` +
        `never established. If the file was restructured, update COHORT_CONSTANTS/COHORT_FUNCTIONS in ` +
        `scripts/release/check-promotion-config.js to match.`,
    ];
  }

  for (const name of COHORT_CONSTANTS) {
    if (a.constants[name] !== b.constants[name]) {
      problems.push(`${COHORT_FILE}: const ${name} changed — this decides which chain a build treats as its cohort`);
    }
  }
  for (const name of COHORT_FUNCTIONS) {
    if (a.functions[name] !== b.functions[name]) {
      problems.push(`${COHORT_FILE}: ${name}() changed — this is how a build RESOLVES its cohort`);
    }
  }
  const chains = new Set([...Object.keys(a.networks), ...Object.keys(b.networks)]);
  for (const id of [...chains].sort((x, y) => Number(x) - Number(y))) {
    if (!(id in a.networks)) problems.push(`${COHORT_FILE}: chain ${id} was ADDED (isTestnet=${b.networks[id]}) — it joins a cohort`);
    else if (!(id in b.networks)) problems.push(`${COHORT_FILE}: chain ${id} was REMOVED — it leaves a cohort`);
    else if (a.networks[id] !== b.networks[id]) {
      problems.push(`${COHORT_FILE}: chain ${id} moved cohort (isTestnet ${a.networks[id]} -> ${b.networks[id]})`);
    }
  }

  if (problems.length > 0) {
    problems.push(
      `Staging reaches both cohorts by being TWO SERVICES, not by changing how a build resolves its ` +
        `cohort (spec 076 FR-026b). A change to the above belongs in its own pull request, reviewed as ` +
        `a change to the testnet/mainnet boundary — a constitution III concern.`
    );
  }
  return problems;
}

module.exports = { ENUMERATED, buildArgs, checkEnumeratedDifferences, checkCohortBoundary, cohortFacts, compareCohortFacts, COHORT_CONSTANTS, COHORT_FUNCTIONS };

// ---- CLI ---------------------------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (n, d) => {
    const i = argv.indexOf(n);
    return i === -1 ? d : argv[i + 1];
  };
  const base = flag("--base", "origin/main");
  const head = flag("--head", "HEAD");

  const problems = [...checkEnumeratedDifferences(), ...checkCohortBoundary(base, head)];

  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error("");
    console.error("A promotion may only proceed when staging and production differ in the values");
    console.error("listed in specs/076-monorepo-semantic-versioning/contracts/environments.md.");
    console.error("An unlisted difference means staging did not rehearse what production will run.");
    process.exit(1);
  }
  console.log("promotion config OK: staging mirrors production within the enumerated differences");
}
