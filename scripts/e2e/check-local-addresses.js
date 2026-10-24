#!/usr/bin/env node
/**
 * E2E deploy-order gate (issue #1298).
 *
 * WHY THIS EXISTS
 * The frontend does NOT read the local chain's deployed addresses back. It uses the hardcoded
 * block in frontend/src/config/contracts.js that `NETWORK_CONTRACTS` maps the chain id to. So the
 * app is only pointed at the right contracts for as long as those constants happen to equal what
 * the deploys produced — and those addresses move both when a contract changes and when the deploy
 * sequence does.
 *
 * WHICH ADDRESSES MOVE, AND WHY — TWO MECHANISMS, NOT ONE
 * Both are common, they have DIFFERENT remedies, and an earlier draft of this gate named only the
 * first. A report that blames deploy order for an address that moved because a constructor arg
 * changed sends the reader to the wrong file.
 *
 *   1. INIT CODE (CREATE2). Most of scripts/deploy/deploy.js goes through `deployDeterministic` —
 *      CREATE2 via the singleton factory — so the address is keccak over the salt AND THE INIT
 *      CODE. It does not care about the deployer's nonce, but it moves the moment the init code
 *      changes: an edit to the contract's own source or anything it inherits, a compiler/optimizer
 *      settings change, or a different CONSTRUCTOR ARGUMENT. This is the ordinary case — every
 *      contract change moves its address — and the remedy is to re-derive the constants
 *      (`npm run sync:frontend-contracts:local`) and commit them, not to reorder anything.
 *
 *   2. DEPLOYER NONCE (plain CREATE). `upgrades.deployProxy` (scripts/deploy/lib/upgradeable.js)
 *      deploys with plain CREATE, so each proxy's address is a function of the DEPLOYER'S NONCE at
 *      the moment that transaction is sent: `membershipManager`, `wagerRegistry` and `tokenFactory`
 *      in deploy.js, `callsignRegistry` in deploy-callsign-registry.js, plus every `…Impl` behind
 *      them. Any additional deployer transaction inserted BEFORE one of those calls — another
 *      deploy, a role grant, a mock — shifts it by a nonce slot. This is #1289, and the remedy is
 *      to APPEND rather than insert (then re-sync).
 *
 * The two are not independent: a CREATE2 contract whose constructor takes one of those proxies
 * (`membershipVoucher` takes `membershipManager`) has the nonce hazard fed into its init code, so
 * an inserted deploy moves it too. That is why the gate classifies each mismatch by mechanism
 * rather than asserting one cause for all of them.
 *
 * Nothing about the resulting failure names its cause. A read against an address with no code
 * returns empty rather than reverting, so nothing throws and the UI simply never renders. It
 * surfaces 10-15 minutes later as unrelated-looking Cypress timeouts in three different
 * subsystems, on whichever shard happened to pack those specs — which reads like flake and invites
 * a re-run. It is not flake. #1289 burned two full CI cycles on it.
 *
 * The deploy step already carried a comment warning about the ordering. That comment did not
 * prevent the mistake, because a comment is a convention and conventions decay. This is the gate:
 * it runs in seconds immediately after the deploys, compares what the app is hardcoded to use
 * against what was ACTUALLY deployed, and fails naming each key, expected vs actual, and the rule
 * that was broken.
 *
 * WHAT IT COMPARES
 *   what actually deployed  →  deployments/<network>-chain<chainId>-v2.json (written by the deploy)
 *   what the app will use   →  frontend/src/config/contracts.js, the block NETWORK_CONTRACTS maps
 *                              this chain id to (1337 → HARDHAT_CONTRACTS, 80002 → AMOY_CONTRACTS)
 *
 * The target block is read out of `NETWORK_CONTRACTS` rather than from a table kept here, so this
 * gate cannot drift from the map the app itself resolves.
 *
 * FOUR OUTCOMES PER KEY, AND THEY ARE NOT INTERCHANGEABLE
 *   matched      — hardcoded and deployed agree. The only thing that counts as a pass.
 *   MISMATCH     — the app points somewhere this deploy did not put that contract. FATAL.
 *   UNSET        — the app's constant is empty (its "not deployed on this chain" state) but the
 *                  record shows the contract WAS deployed. The app will behave as though the
 *                  contract does not exist: the surface hides or its calls go nowhere, which is
 *                  the same silent-timeout failure a mismatch causes. FATAL for a deployed
 *                  contract; reported-only for the record's provenance fields (`deployer`,
 *                  `treasury`), which are configuration, not deploys — `treasury` is
 *                  `TREASURY_ADDRESS || deployer`, so a hardcoded constant for it would be a lie
 *                  rather than a fix.
 *   unverifiable — hardcoded, but this record does not carry the key, so nothing is known either
 *                  way. Never a pass, never a failure. The custody contracts (safePolicyGuard,
 *                  safePolicyGuardV2, policyGuardSetup, safeProposalHub) come from
 *                  scripts/deploy/custody/, so a record written by the core deploy alone says
 *                  nothing about them.
 * Addresses the record carries that the app's block has no key for at all are listed too
 * ("unmapped"), because that is how a newly added deploy shows up before anyone wires it in.
 *
 * THE THIRD SOURCE (issue #1298 names three), AND WHAT IS HONESTLY NOT COVERABLE HERE
 * The third source is `frontend/package.json` `dev:e2e`'s VITE_AMOY_UNISWAP_FACTORY / _SWAP_ROUTER
 * / _QUOTER / _POSITION_MANAGER and VITE_AMOY_WMATIC, consumed by the `dex` block in
 * frontend/src/config/networks.js. Those values are the same hazard in a second place, and they
 * are what produced the issue's SW-01 (".trade-summary never found") failure.
 *
 * Two halves, and only one of them can be built at this commit:
 *
 *   what the app will use — covered. `collectSwapValues` reads those names from the environment
 *     AND from `frontend/package.json`'s script strings, so a hardcoded `VITE_AMOY_UNISWAP_QUOTER=0x…`
 *     in a `dev:e2e` script is checked without anyone having to export it first. (An earlier draft
 *     read only `process.env`, which made this whole leg inert in CI, where nothing sets them.)
 *
 *   what actually deployed — NOT coverable here, and not by writing more code in this file. There
 *     is no `deploy:local:swap` in package.json, no swap-mock deploy script under scripts/deploy/,
 *     and no MockUniswapFactory/Quoter/SwapRouter under contracts/mocks/ (only MockUniswapV3Pool).
 *     The mocks the issue measured do not exist in this tree, so there is nothing to record and
 *     nothing to compare against. The issue's ask — "deploy:local:swap should record its addresses
 *     instead of only logging them" — belongs to the commit that reintroduces that deploy; the
 *     record key it must write under is listed in SWAP_ENV_KEYS below so that commit has one place
 *     to look.
 *
 * Until then a swap value that is set but has no counterpart in the record is reported UNRECORDED,
 * naming the missing piece — never passed and never silently skipped. The gate starts enforcing
 * the third source the moment the swap deploy records anything.
 *
 * Usage:
 *   node scripts/e2e/check-local-addresses.js [--network localhost] [--chainId 1337]
 *                                             [--deployment <path>] [--contractsFile <path>]
 *                                             [--frontendPackage <path>] [--json]
 *
 * Exit code 0 = every hardcoded address the record can speak to matches. 1 = at least one mismatch
 * or a deployed-but-unset contract, or the comparison could not be made at all (missing record,
 * unresolvable block). Reported-only findings never fail the run.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Top-level fields of a deployment record (they sit beside `contracts`; see the record built at the
 * end of scripts/deploy/deploy.js), split by what they mean:
 *
 *   token      — contract addresses that merely happen to be recorded at the top level. Treated
 *                exactly like `contracts`: if one is deployed and the app has it empty, the app is
 *                broken.
 *   provenance — who ran the deploy and where fees go. Not deployments, so the nonce hazard does
 *                not apply, and `treasury` is environment-dependent by design.
 */
const TOP_LEVEL_TOKEN_FIELDS = ["paymentToken", "wmatic", "polymarketCTF"];
const TOP_LEVEL_PROVENANCE_FIELDS = ["deployer", "treasury"];

/**
 * Sections whose absence from the app's block is a real hazard rather than bookkeeping.
 * `provenance` is excluded: nothing breaks because the app does not know the treasury address.
 */
const DEPLOYED_SECTIONS = new Set(["contracts", "mocks", "token"]);

/**
 * The keys whose address is a function of the DEPLOYER'S NONCE rather than of init code — i.e. the
 * plain-CREATE deploys. Derived from the `deployProxy` call sites: three in scripts/deploy/deploy.js
 * (membershipManager, wagerRegistry, tokenFactory) and one in deploy-callsign-registry.js, each of
 * which deploys an implementation and then its proxy. Everything else in those scripts goes through
 * `deployDeterministic` (CREATE2).
 *
 * This is used only to LABEL a mismatch with the mechanism that can have moved it, so a stale entry
 * misdirects a reader rather than passing a bad address. Add a key here whenever a new
 * `deployProxy` call joins the local deploy sequence.
 */
const NONCE_ORDERED_KEYS = new Set([
  "membershipManager",
  "membershipManagerImpl",
  "wagerRegistry",
  "wagerRegistryImpl",
  "tokenFactory",
  "tokenFactoryImpl",
  "callsignRegistry",
  "callsignRegistryImpl",
  // spec 103 — deploy-funding-pool-factory.js (appended last in setup:e2e)
  "fundingPoolFactory",
  "fundingPoolFactoryImpl",
]);

/** "nonce" for the plain-CREATE deploys, "create2" for everything else. See NONCE_ORDERED_KEYS. */
function mechanismFor(key) {
  return NONCE_ORDERED_KEYS.has(key) ? "nonce" : "create2";
}

/**
 * The issue's third source: `dev:e2e`'s swap env vars → the record key(s) that would hold the same
 * address. The candidate names are what a swap-mock deploy would most plausibly record under; the
 * deploy does not exist at this commit (see the deferral note above), so when it lands it must
 * record under one of these names or this table must be extended with the name it chose. Anything
 * set here that the record cannot speak to is reported UNRECORDED, never passed.
 */
const SWAP_ENV_KEYS = {
  VITE_AMOY_UNISWAP_FACTORY: ["mockUniswapFactory", "uniswapFactory"],
  VITE_AMOY_UNISWAP_SWAP_ROUTER: ["mockUniswapSwapRouter", "uniswapSwapRouter"],
  VITE_AMOY_UNISWAP_QUOTER: ["mockUniswapQuoter", "uniswapQuoter"],
  VITE_AMOY_UNISWAP_POSITION_MANAGER: ["mockUniswapPositionManager", "uniswapPositionManager"],
  VITE_AMOY_WMATIC: ["mockWMATIC", "wmatic"],
};

// ── parsing ────────────────────────────────────────────────────────────────────────────────────

/**
 * Body of `<const|let|var> <name> = { ... }`, brace-matched. Returns null when there is no such
 * declaration. Same technique as scripts/utils/sync-frontend-contracts.js: contracts.js reaches
 * `virtual:tenant` transitively and cannot be require()d from Node.
 */
function objectLiteralBody(source, name) {
  const start = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{`).exec(source);
  if (!start) return null;

  const bodyStart = start.index + start[0].length;
  let depth = 1;
  for (let i = bodyStart; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(bodyStart, i);
    }
  }
  return null;
}

/**
 * `{ key: 'value' }` pairs of a named block, in file order. Only single-quoted string literals are
 * collected — every address in contracts.js is written that way, and anything else (a spread, a
 * computed value) is not an address this gate can compare.
 */
function parseContractsBlock(source, blockName) {
  const body = objectLiteralBody(source, blockName);
  if (body === null) return null;

  const entries = {};
  const lineRe = /^\s*([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'\s*,?/;
  for (const line of body.split("\n")) {
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
    const m = lineRe.exec(line);
    if (m) entries[m[1]] = m[2];
  }
  return entries;
}

/**
 * chainId → block name, read from the app's own `NETWORK_CONTRACTS` map. Deliberately not a table
 * in this file: a second copy of that mapping could disagree with the one the app resolves, and
 * this gate would then check a block the app never reads.
 */
function resolveBlockName(source, chainId, { e2e = false } = {}) {
  const body = objectLiteralBody(source, "NETWORK_CONTRACTS");
  if (body === null) return null;

  /*
   * An entry is either a plain identifier or a TERNARY, and 80002 is the ternary:
   *
   *   80002: E2E_AMOY_LOCAL ? HARDHAT_CONTRACTS : AMOY_CONTRACTS
   *
   * because the E2E tier boots its local node AS chain 80002 and impersonates Amoy. Reading the
   * identifier straight after the colon picks up `E2E_AMOY_LOCAL` — the CONDITION, which is not a
   * contracts block at all — and the gate then aborts with "no E2E_AMOY_LOCAL block", on every
   * single e2e setup. So a ternary is resolved to a BRANCH: the consequent under `--e2e` (the
   * local impersonation, which is exactly what setup:e2e just deployed), the alternate otherwise.
   */
  const ternaryRe = /^\s*(\d+)\s*:\s*[A-Za-z_$][\w$]*\s*\?\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\s*,?/;
  const plainRe = /^\s*(\d+)\s*:\s*([A-Za-z_$][\w$]*)\s*,?/;
  for (const line of body.split("\n")) {
    const t = ternaryRe.exec(line);
    if (t && Number(t[1]) === Number(chainId)) return e2e ? t[2] : t[3];
    const m = plainRe.exec(line);
    if (m && Number(m[1]) === Number(chainId)) return m[2];
  }
  return null;
}

/**
 * Flatten a deployment record into one `key → { address, section }` map, keyed the way contracts.js
 * keys are. The section is carried because "this contract was deployed" and "this is who deployed
 * it" are different facts and the gate treats them differently (see DEPLOYED_SECTIONS).
 * `contracts` is applied last so it wins over a same-named top-level field.
 */
function flattenDeployment(record) {
  const flat = {};
  const put = (key, value, section) => {
    if (typeof value === "string" && value) flat[key] = { address: value, section };
  };

  for (const field of TOP_LEVEL_PROVENANCE_FIELDS) put(field, record[field], "provenance");
  for (const field of TOP_LEVEL_TOKEN_FIELDS) put(field, record[field], "token");
  for (const [key, value] of Object.entries(record.mocks || {})) put(key, value, "mocks");
  for (const [key, value] of Object.entries(record.contracts || {})) put(key, value, "contracts");

  return flat;
}

// ── comparison ─────────────────────────────────────────────────────────────────────────────────

/**
 * Compare every key of the app's block against what deployed.
 *
 * `deployed` is the map flattenDeployment returns (`key → { address, section }`); a plain
 * `key → address` map is also accepted, and its entries are treated as deployed contracts.
 *
 * Returns { mismatches, unset, unverifiable, unmapped, matched }. See the four-outcomes note in
 * the file header — the distinction between them is the point of this gate, so nothing here
 * collapses two of them into one.
 *
 * Addresses are compared case-insensitively: a record and a hardcoded constant can hold the same
 * address in different checksum casings, and that is not a mismatch.
 */
function compareAddresses(hardcoded, deployed) {
  const mismatches = [];
  const unset = [];
  const unverifiable = [];
  const unmapped = [];
  let matched = 0;

  const entryFor = (key) => {
    const raw = deployed[key];
    if (!raw) return null;
    return typeof raw === "string" ? { address: raw, section: "contracts" } : raw;
  };

  for (const [key, configured] of Object.entries(hardcoded)) {
    const entry = entryFor(key);

    // The app's constant is not an address. Empty is its "not deployed on this chain" state — which
    // is a claim about the chain, and the record can contradict it. Silently skipping this case is
    // what let "deployed, but the app's key is empty" pass as a green gate (issue #1298 review).
    if (!configured || !ADDRESS_RE.test(configured)) {
      if (entry) {
        unset.push({
          key,
          configured,
          actual: entry.address,
          section: entry.section,
          fatal: DEPLOYED_SECTIONS.has(entry.section),
        });
      }
      continue;
    }

    if (!entry) {
      unverifiable.push({ key, configured });
      continue;
    }
    if (entry.address.toLowerCase() !== configured.toLowerCase()) {
      mismatches.push({ key, configured, actual: entry.address });
      continue;
    }
    matched++;
  }

  // Deployed contracts the app's block has no key for at all. Not a failure — the record carries
  // implementations, clone templates and mocks the app legitimately never maps — but it is how a
  // newly added deploy looks before anyone wires it into contracts.js, so it is never dropped.
  for (const [key, raw] of Object.entries(deployed)) {
    if (key in hardcoded) continue;
    const entry = entryFor(key);
    if (entry && DEPLOYED_SECTIONS.has(entry.section)) {
      unmapped.push({ key, actual: entry.address, section: entry.section });
    }
  }

  return { mismatches, unset, unverifiable, unmapped, matched };
}

/**
 * Where the app's swap values can come from, in the order a build would see them:
 *
 *   1. the environment this gate runs in (a shell export, a workflow `env:` block)
 *   2. `frontend/package.json`'s script strings — `"dev:e2e": "VITE_AMOY_UNISWAP_QUOTER=0x… vite"`
 *
 * (2) is the one the issue names, and reading only (1) is what made this leg inert: nothing in
 * .github/workflows/torture-test.yml sets these, so an env-only check reports "not set" on exactly
 * the run it was written for. A value written into a script string is just as much a hardcoded
 * address as anything in contracts.js, and is checkable without an environment at all.
 *
 * Returns { VAR: { value, source } } for the names in SWAP_ENV_KEYS only; the environment wins,
 * because it is what a build would actually see.
 */
function collectSwapValues(env = {}, frontendPackageFile) {
  const values = {};

  const pkgPath =
    frontendPackageFile || path.join(ROOT, "frontend", "package.json");
  if (fs.existsSync(pkgPath)) {
    let scripts = {};
    try {
      scripts = JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts || {};
    } catch {
      scripts = {}; // an unreadable package.json is not this gate's failure to report
    }
    for (const [scriptName, body] of Object.entries(scripts)) {
      if (typeof body !== "string") continue;
      for (const varName of Object.keys(SWAP_ENV_KEYS)) {
        const m = new RegExp(`${varName}\\s*=\\s*['"]?(0x[0-9a-fA-F]{40})`).exec(body);
        if (m) values[varName] = { value: m[1], source: `frontend/package.json → ${scriptName}` };
      }
    }
  }

  for (const varName of Object.keys(SWAP_ENV_KEYS)) {
    if (env[varName]) values[varName] = { value: String(env[varName]), source: "environment" };
  }

  return values;
}

/**
 * The issue's third source, as far as it can be checked here. Only values that are actually SET are
 * considered; an unset one means the app's `dex` block is off, which is not a mispoint.
 *
 * `values` is what collectSwapValues returns (`VAR → { value, source }`); a flat `VAR → address`
 * map is also accepted and treated as coming from the environment.
 *
 * Returns { mismatches, unrecorded, matched }: `mismatches` is fatal, `unrecorded` names a value
 * the record cannot speak to (see the third-source note in the file header) and is reported only.
 */
function checkSwapEnv(values, deployed) {
  const mismatches = [];
  const unrecorded = [];
  let matched = 0;

  for (const [varName, candidates] of Object.entries(SWAP_ENV_KEYS)) {
    const raw = values[varName];
    if (!raw) continue;
    const configured = typeof raw === "string" ? raw : raw.value;
    const source = typeof raw === "string" ? "environment" : raw.source;
    if (!configured) continue;

    const hit = candidates
      .map((key) => {
        const raw = deployed[key];
        if (!raw) return null;
        return { key, address: typeof raw === "string" ? raw : raw.address };
      })
      .find(Boolean);

    if (!hit) {
      unrecorded.push({ varName, configured, candidates, source });
      continue;
    }
    if (hit.address.toLowerCase() !== String(configured).toLowerCase()) {
      mismatches.push({ varName, key: hit.key, configured, actual: hit.address, source });
      continue;
    }
    matched++;
  }

  return { mismatches, unrecorded, matched };
}

// ── reporting ──────────────────────────────────────────────────────────────────────────────────

/**
 * The two mechanisms, printed on failure — only the one(s) that can explain the keys that actually
 * failed. Getting this wrong is not cosmetic: an earlier draft asserted that CREATE2 addresses
 * "do NOT move" and sent every reader to the deployProxy sequence, which then contradicted its own
 * finding list on the common case (a contract edit moving seven CREATE2 addresses at once) and
 * named a remedy — reordering — that would have fixed nothing.
 */
const CAUSE_CREATE2 = [
  "CREATE2 (deployDeterministic, via the singleton factory). The address is keccak over the salt",
  "AND THE INIT CODE, so the deployer's nonce is irrelevant but ANY change to the init code moves",
  "it: an edit to the contract or something it inherits, a compiler/optimizer settings change, or",
  "a different CONSTRUCTOR ARGUMENT (which is how the nonce hazard below leaks in — e.g.",
  "membershipVoucher takes membershipManager's address).",
  "  FIX: this is the ordinary case, and it is a re-derive, NOT a reorder. Run",
  "       `npm run sync:frontend-contracts:local` and COMMIT frontend/src/config/contracts.js.",
  "       If you did not change any of those contracts, find out what did before syncing.",
].join("\n  ");

const CAUSE_NONCE = [
  "PLAIN CREATE (upgrades.deployProxy, scripts/deploy/lib/upgradeable.js). The address is a",
  "function of the DEPLOYER'S NONCE when that transaction is sent — membershipManager,",
  "wagerRegistry, tokenFactory (deploy.js) and callsignRegistry (deploy-callsign-registry.js),",
  "plus their implementations. ANY extra deployer transaction sequenced BEFORE one of them — a",
  "deploy, a role grant, a mock — slides it by a nonce slot while the app keeps using the",
  "hardcoded constant. This is #1289.",
  "  FIX: APPEND new deployer work after every deployProxy call rather than inserting it, then",
  "       re-derive as above. If the new ordering is the intended one, re-derive and commit.",
].join("\n  ");

function formatReport(result, { blockName, contractsFile, deploymentFile, swap }) {
  const { mismatches, unset, unverifiable, unmapped, matched } = result;
  const swapResult = swap || { mismatches: [], unrecorded: [], matched: 0 };
  const lines = [];
  const rel = (p) => path.relative(ROOT, p) || p;

  const fatalUnset = unset.filter((u) => u.fatal);
  const notedUnset = unset.filter((u) => !u.fatal);
  const failing = mismatches.length + fatalUnset.length + swapResult.mismatches.length;

  for (const { key, configured } of unverifiable) {
    lines.push(
      `  warn  ${key}: hardcoded ${configured}; ${rel(deploymentFile)} carries no such key, so this ` +
        `address is UNVERIFIED — not a pass.`
    );
  }
  for (const { key, actual, section } of notedUnset) {
    lines.push(
      `  note  ${key}: the record has ${actual} (${section}) but ${blockName} leaves it empty. ` +
        `Not a deployed contract, so this is configuration rather than a mispoint.`
    );
  }
  if (unmapped.length > 0) {
    lines.push(
      `  note  the record also carries ${unmapped.length} deployed address${unmapped.length === 1 ? "" : "es"} ` +
        `${blockName} has no key for: ${unmapped.map((u) => u.key).join(", ")}. Expected for ` +
        `implementations, clone templates and mocks the app never reads — but a NEW deploy the app ` +
        `is supposed to use looks exactly like this until someone adds its key.`
    );
  }
  for (const { varName, configured, candidates, source } of swapResult.unrecorded) {
    lines.push(
      `  warn  ${varName}=${configured} (from ${source || "environment"}) is UNRECORDED: ` +
        `${rel(deploymentFile)} carries none of ` +
        `${candidates.join(", ")}, so nothing can check it. The swap-mock deploy must write its ` +
        `addresses into the deployment record (issue #1298, third source) — a value that exists ` +
        `only in stdout is uncheckable.`
    );
  }
  if (swapResult.matched === 0 && swapResult.unrecorded.length === 0) {
    lines.push(
      `  note  no VITE_AMOY_UNISWAP_* / VITE_AMOY_WMATIC value is set in the environment or written ` +
        `into a frontend/package.json script, so the swap-mock addresses (issue #1298, third ` +
        `source) were not checked. Nothing in this repo deploys those mocks at present.`
    );
  }

  if (failing === 0) {
    lines.push(
      `E2E address gate: PASS (${matched} address${matched === 1 ? "" : "es"} verified, ` +
        `${unverifiable.length} not in this record, ${swapResult.matched} swap env value` +
        `${swapResult.matched === 1 ? "" : "s"} verified)`
    );
    return lines.join("\n");
  }

  lines.push("");
  lines.push(
    `E2E address gate: ${failing} address${failing === 1 ? "" : "es"} the app uses ` +
      `${failing === 1 ? "is" : "are"} not what was deployed.`
  );
  lines.push("");
  lines.push(`  expected = ${rel(contractsFile)} → ${blockName} (what the app will use)`);
  lines.push(`  actual   = ${rel(deploymentFile)} (what was actually deployed just now)`);
  lines.push("");
  // Each mismatch is labelled with the mechanism that can have moved THAT key, so the reader is
  // never handed a cause that does not apply to the thing in front of them.
  const label = (key) =>
    mechanismFor(key) === "nonce"
      ? "plain CREATE — deployer nonce"
      : "CREATE2 — salt + init code";

  for (const { key, configured, actual } of mismatches) {
    lines.push(`  ${key}  — points at an address this deploy did not use   [${label(key)}]`);
    lines.push(`        expected  ${configured}`);
    lines.push(`        actual    ${actual}`);
  }
  for (const { key, actual } of fatalUnset) {
    lines.push(`  ${key}  — DEPLOYED, but ${blockName} leaves it empty, so the app will not use it`);
    lines.push(`        expected  ${actual}   (set the constant to this)`);
    lines.push(`        actual    '' — the app's "not deployed on this chain" state`);
  }
  for (const { varName, key, configured, actual, source } of swapResult.mismatches) {
    lines.push(
      `  ${varName}  — value from ${source || "environment"} does not match the deployed ${key}` +
        `   [${label(key)}]`
    );
    lines.push(`        expected  ${configured}`);
    lines.push(`        actual    ${actual}`);
  }

  // Only the mechanisms that can explain these findings. A deployed-but-unset key is neither: the
  // address did not move, the constant was never written.
  const movedKeys = [
    ...mismatches.map((m) => m.key),
    ...swapResult.mismatches.map((m) => m.key),
  ];
  const causes = [];
  if (movedKeys.some((k) => mechanismFor(k) === "create2")) causes.push(CAUSE_CREATE2);
  if (movedKeys.some((k) => mechanismFor(k) === "nonce")) causes.push(CAUSE_NONCE);

  if (causes.length > 0) {
    lines.push("");
    lines.push(
      `  WHY AN ADDRESS MOVES — ${causes.length === 1 ? "the mechanism" : "the two mechanisms"} ` +
        `behind the mismatch${mismatches.length + swapResult.mismatches.length === 1 ? "" : "es"} above:`
    );
    for (const cause of causes) {
      lines.push("");
      lines.push(`  ${cause}`);
    }
  }
  if (fatalUnset.length > 0) {
    lines.push("");
    lines.push(
      `  The DEPLOYED-but-empty key${fatalUnset.length === 1 ? "" : "s"} above did not move: the ` +
        `deploy put a contract on this chain and`
    );
    lines.push(
      `  ${blockName} never got the address. Copy each "expected" value into ` +
        `${rel(contractsFile)} (or run`
    );
    lines.push("  `npm run sync:frontend-contracts:local`, which writes exactly that).");
  }
  lines.push("");
  lines.push("  Do not start the E2E suite against this chain. The app would call addresses with no");
  lines.push("  code, or skip a contract that exists: nothing reverts, the UI simply never renders, and");
  lines.push("  it surfaces much later as unrelated-looking Cypress timeouts in whichever specs happen");
  lines.push("  to touch those contracts.");
  lines.push("");

  return lines.join("\n");
}

/** Every finding that must fail the run, across both sources. */
function isFailing(result, swap) {
  const swapResult = swap || { mismatches: [] };
  return (
    result.mismatches.length > 0 ||
    result.unset.some((u) => u.fatal) ||
    swapResult.mismatches.length > 0
  );
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { network: "localhost", chainId: 1337, json: false, e2e: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--network") out.network = argv[++i];
    else if (a === "--chainId") out.chainId = Number(argv[++i]);
    else if (a === "--e2e") out.e2e = true;
    else if (a === "--deployment") out.deployment = argv[++i];
    else if (a === "--contractsFile") out.contractsFile = argv[++i];
    else if (a === "--frontendPackage") out.frontendPackage = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

function main(argv, env = process.env) {
  const args = parseArgs(argv);

  const deploymentFile = args.deployment
    ? path.resolve(ROOT, args.deployment)
    : path.join(ROOT, "deployments", `${args.network}-chain${args.chainId}-v2.json`);
  const contractsFile = args.contractsFile
    ? path.resolve(ROOT, args.contractsFile)
    : path.join(ROOT, "frontend", "src", "config", "contracts.js");

  // A missing record is fatal, not a skip. It means the deploys did not run, ran against another
  // network, or failed — and in every one of those cases the suite would run against a chain
  // nobody has checked.
  if (!fs.existsSync(deploymentFile)) {
    console.error(
      `\nE2E address gate: no deployment record at ${path.relative(ROOT, deploymentFile)}.\n\n` +
        `  Run the E2E deploys first (npm run setup:e2e), or point at the record with\n` +
        `  --deployment <path>. Refusing to report a pass: with no record there is nothing to\n` +
        `  compare the hardcoded addresses against.\n`
    );
    return 1;
  }

  const record = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const source = fs.readFileSync(contractsFile, "utf8");

  const chainId = Number(record.chainId) || args.chainId;
  const blockName = resolveBlockName(source, chainId, { e2e: args.e2e });
  if (!blockName) {
    console.error(
      `\nE2E address gate: NETWORK_CONTRACTS in ${path.relative(ROOT, contractsFile)} maps no block ` +
        `to chain ${chainId}.\n\n` +
        `  The app therefore has no address map for the chain these contracts were deployed to.\n` +
        `  Add the chain to NETWORK_CONTRACTS (and its block) before running the E2E suite.\n`
    );
    return 1;
  }

  const hardcoded = parseContractsBlock(source, blockName);
  if (!hardcoded) {
    console.error(
      `\nE2E address gate: ${path.relative(ROOT, contractsFile)} has no "${blockName}" block, though ` +
        `NETWORK_CONTRACTS maps chain ${chainId} to it.\n`
    );
    return 1;
  }

  const deployed = flattenDeployment(record);
  const result = compareAddresses(hardcoded, deployed);
  const swap = checkSwapEnv(collectSwapValues(env, args.frontendPackage), deployed);
  const failing = isFailing(result, swap);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ chainId, blockName, ...result, swap }, null, 2)}\n`);
  } else {
    const report = formatReport(result, { blockName, contractsFile, deploymentFile, swap });
    if (failing) console.error(report);
    else console.log(report);
  }

  return failing ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  checkSwapEnv,
  collectSwapValues,
  compareAddresses,
  flattenDeployment,
  formatReport,
  isFailing,
  mechanismFor,
  objectLiteralBody,
  parseContractsBlock,
  resolveBlockName,
  main,
  NONCE_ORDERED_KEYS,
  SWAP_ENV_KEYS,
};
