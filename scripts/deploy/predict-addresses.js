#!/usr/bin/env node
"use strict";

/**
 * Predict deterministic CREATE2 addresses (spec 080, T012 / FR-006)
 *
 * Computes, WITHOUT CONTACTING ANY CHAIN, the address every deterministically
 * deployed contract will land at:
 *
 *     address = keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]
 *     initCode = creation bytecode ++ abi.encode(constructor args)
 *
 *   factory : the Safe Singleton Factory, read from scripts/deploy/lib/constants.js
 *   salt    : ethers.id(identifier), tenant-prefixed when TENANT_ID is set —
 *             mirrors generateSalt() in scripts/deploy/lib/helpers.js
 *   bytecode: the hardhat artifact for the contract named at the deploy call site
 *
 * WHY THIS RUNS AS PLAIN NODE
 * ---------------------------
 * `node scripts/deploy/predict-addresses.js`, never `npx hardhat run`. The whole
 * claim of FR-006 is that no chain is contacted, and the most convincing way to
 * make that true is to have no provider in the process at all. That is also why
 * the factory address is PARSED out of constants.js rather than required from it:
 * constants.js does `require("hardhat")` at module load.
 *
 * CONSTRUCTOR ARGUMENTS ARE THE HARD PART
 * ---------------------------------------
 * A contract with constructor arguments has different initcode — and therefore a
 * different address — than the same contract with none. Assuming empty arguments
 * would print a CONFIDENT WRONG ADDRESS, which is worse than printing nothing:
 * an operator would deploy against it, land somewhere else, and only find out
 * after spending a transaction. So the rule here is absolute:
 *
 *   - constructor takes no arguments        -> predictable, nothing is assumed
 *   - arguments are literals at the call site -> predictable, resolved from source
 *   - anything else                         -> UNPREDICTABLE, with the reason
 *
 * The resolver is deliberately literal-only. It can fail to resolve a value it
 * could in principle have computed; it cannot invent one. `[deployer.address]`,
 * `[voucherDeploy.address]` and friends are chain- and run-specific — they are
 * reported as unpredictable, and the report says which expression defeated it.
 *
 * Contracts that link a library are unpredictable for the same reason: the
 * library address is substituted into the creation bytecode at deploy time, so
 * the initcode is not known until that address is.
 *
 * WHAT --compare-deployed CAN AND CANNOT SEE
 * ------------------------------------------
 * It reads `deployments/*.json` — the recorded source of truth (FR-019) — and
 * NOTHING ELSE. It never contacts a chain, so:
 *
 *   - `not-deployed` means NOT RECORDED. A contract could exist on a chain
 *     without a record; this tool cannot know that.
 *   - `unknown-chain-unreachable` means the record for that chain could not be
 *     read or parsed. An unreadable record and an absent contract call for
 *     opposite actions (FR-018), so they are never merged.
 *
 * EXPECTED DIVERGENCE FROM THE LEGACY ADDRESSES (research.md R5)
 * --------------------------------------------------------------
 * Ten contracts are already deployed via CREATE2. This branch changed compiled
 * bytecode (`metadata: { bytecodeHash: "none" }`), so predictions made from the
 * CURRENT bytecode DO NOT match those legacy addresses. That is the documented,
 * deliberate one-time move for the five `transitional` contracts — it is not a
 * bug in this tool and must not be "fixed" by tuning the prediction. To check the
 * tool against reality, predict from PRE-CHANGE artifacts:
 *
 *     node scripts/deploy/predict-addresses.js --compare-deployed \
 *          --artifacts /path/to/pre-change/artifacts
 *
 * CLI
 * ---
 *   node scripts/deploy/predict-addresses.js                     # human report
 *   node scripts/deploy/predict-addresses.js --json              # machine readable
 *   node scripts/deploy/predict-addresses.js --compare-deployed  # vs deployments/*.json
 *   node scripts/deploy/predict-addresses.js --artifacts <dir>   # alternate artifact tree
 *   node scripts/deploy/predict-addresses.js --deployments <dir> # alternate record set
 *   node scripts/deploy/predict-addresses.js --verbose           # + unpredictable reasons in full
 *
 * Exit code:
 *   1  any MISMATCH under --compare-deployed (a recorded address that is not the
 *      predicted one), or the registry/artifacts could not be read at all.
 *   0  otherwise. Unpredictable contracts do NOT fail the run on their own —
 *      they are reported, loudly, as the open work they are.
 */

const fs = require("fs");
const path = require("path");

const { id: ethersId, keccak256, getCreate2Address, getAddress, AbiCoder, ParamType } = require("ethers");

let acorn;
try {
  acorn = require("acorn");
} catch (cause) {
  // Fail closed. A parser we cannot load must never degrade into "no constructor
  // arguments found, everything is predictable".
  throw new Error(
    "predict-addresses requires the 'acorn' parser and could not load it. " +
      "Run `npm run deps:reinstall` (never `npm install`). " +
      `Cause: ${cause && cause.message ? cause.message : String(cause)}`
  );
}

const { buildSaltRegistry } = require("./lib/salt-registry");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CONSTANTS_PATH = path.join(REPO_ROOT, "scripts", "deploy", "lib", "constants.js");
const DEPLOYMENTS_DIR = path.join(REPO_ROOT, "deployments");
const DEFAULT_ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");

const abiCoder = AbiCoder.defaultAbiCoder();

/** Repo-relative when the path is inside the repo, absolute otherwise. */
function displayPath(absPath) {
  const relative = path.relative(REPO_ROOT, absPath);
  return relative && !relative.startsWith("..") ? relative : absPath;
}

// =============================================================================
// THE CREATE2 DEPLOYER
// =============================================================================

/**
 * Read SINGLETON_FACTORY_ADDRESS out of scripts/deploy/lib/constants.js.
 *
 * Parsed, not required: constants.js loads hardhat, and this script must run
 * with no provider in the process. Parsed, not copied: constants.js stays the
 * single source of truth, and a change to its shape fails here loudly instead of
 * leaving a stale duplicate silently predicting addresses under the wrong
 * deployer — every address in the report would be wrong and nothing would say so.
 *
 * @returns {string} checksummed factory address
 */
function readSingletonFactoryAddress() {
  const source = fs.readFileSync(CONSTANTS_PATH, "utf8");
  const match = /const\s+SINGLETON_FACTORY_ADDRESS\s*=\s*["'](0x[0-9a-fA-F]{40})["']/.exec(source);
  if (!match) {
    throw new Error(
      `Could not find SINGLETON_FACTORY_ADDRESS in ${path.relative(REPO_ROOT, CONSTANTS_PATH)}. ` +
        "It is the CREATE2 deployer every prediction is derived from; refusing to guess."
    );
  }
  return getAddress(match[1]);
}

// =============================================================================
// ARTIFACTS
// =============================================================================

/**
 * Index every hardhat artifact by contract name.
 * @param {string} absDir - artifacts directory
 * @returns {{byName: Map<string, Array<Object>>, count: number}}
 */
function indexArtifacts(absDir) {
  const byName = new Map();
  let count = 0;

  const walk = (dir) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dirent.name === "build-info") continue;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
        continue;
      }
      if (!dirent.isFile() || !full.endsWith(".json") || full.endsWith(".dbg.json")) continue;
      let artifact;
      try {
        artifact = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch {
        continue;
      }
      if (!artifact || typeof artifact.contractName !== "string" || typeof artifact.bytecode !== "string") continue;
      count += 1;
      if (!byName.has(artifact.contractName)) byName.set(artifact.contractName, []);
      byName.get(artifact.contractName).push({
        artifactPath: path.relative(REPO_ROOT, full),
        sourceName: artifact.sourceName,
        bytecode: artifact.bytecode,
        abi: Array.isArray(artifact.abi) ? artifact.abi : [],
        linkReferences: artifact.linkReferences || {},
      });
    }
  };

  walk(absDir);
  return { byName, count };
}

/**
 * Where a contract's source lives, by filename, under contracts/ and
 * contracts-archive/.
 *
 * This exists so "no artifact" gets an ACCURATE reason. Telling an operator to
 * run `npm run compile` for a contract whose source is in contracts-archive/ is
 * advice that can never work — that tree is reference-only, never imported and
 * never deployed (CLAUDE.md), so no amount of compiling will produce an artifact.
 * Half the unpredictable set is of exactly that kind.
 */
function indexSources() {
  const byName = new Map();
  const walk = (dir, label) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, label);
      else if (entry.isFile() && entry.name.endsWith(".sol")) {
        const name = entry.name.slice(0, -4);
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push({ tree: label, file: path.relative(REPO_ROOT, full) });
      }
    }
  };
  walk(CONTRACTS_DIR, "active");
  walk(path.join(REPO_ROOT, "contracts-archive"), "archive");
  return byName;
}

/** Reason string for a contract that has no artifact, given where its source is. */
function missingArtifactReason(contractName, sourceIndex) {
  const found = sourceIndex.get(contractName) || [];
  const active = found.filter((f) => f.tree === "active");
  const archived = found.filter((f) => f.tree === "archive");
  if (active.length > 0) {
    return `no compiled artifact named "${contractName}" although ${active[0].file} exists — run \`npm run compile\``;
  }
  if (archived.length > 0) {
    return (
      `no compiled artifact: the source is ${archived[0].file}, which is reference-only — never imported, ` +
      "never deployed, never compiled. The deploy script naming it is historical, so this identifier " +
      "has no address to predict and compiling will not give it one"
    );
  }
  return (
    `no compiled artifact and no ${contractName}.sol under contracts/ or contracts-archive/ ` +
    "(searched by filename)"
  );
}

/**
 * Resolve exactly one artifact for a contract name.
 * Two artifacts with the same name and DIFFERENT bytecode is not resolvable: the
 * deploy scripts name contracts by bare name too, so which one deploys is
 * genuinely ambiguous, and picking one would predict an address for code that
 * may not be the code that deploys.
 */
function resolveArtifact(index, contractName) {
  const found = index.byName.get(contractName);
  if (!found || found.length === 0) {
    return {
      ok: false,
      missingArtifact: true,
      reason: `no compiled artifact named "${contractName}"`,
    };
  }
  if (found.length > 1) {
    const distinct = new Set(found.map((a) => a.bytecode));
    if (distinct.size > 1) {
      return {
        ok: false,
        reason:
          `${found.length} artifacts named "${contractName}" with different bytecode ` +
          `(${found.map((a) => a.sourceName).join(", ")}) — which one deploys is ambiguous`,
      };
    }
  }
  return { ok: true, artifact: found[0], duplicates: found.length - 1 };
}

/**
 * Cheap staleness signal: a .sol newer than every artifact means the artifacts
 * were built before the current source.
 *
 * Reported as a WARNING and not a hard failure ON PURPOSE — mtime is not a
 * content hash, and `git checkout` touches files it does not change, so a hard
 * failure here would be wrong often enough to be ignored. The quickstart's
 * standing rule stands regardless: `rm -rf artifacts cache && npm run compile`
 * before trusting any byte-derived number.
 */
function detectStaleArtifacts(artifactsDir) {
  const newestMtime = (dir, filter) => {
    let newest = 0;
    let newestFile = null;
    const walk = (d) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && filter(full)) {
          const { mtimeMs } = fs.statSync(full);
          if (mtimeMs > newest) {
            newest = mtimeMs;
            newestFile = path.relative(REPO_ROOT, full);
          }
        }
      }
    };
    walk(dir);
    return { newest, newestFile };
  };

  const sol = newestMtime(CONTRACTS_DIR, (f) => f.endsWith(".sol"));
  const art = newestMtime(artifactsDir, (f) => f.endsWith(".json") && !f.endsWith(".dbg.json"));
  if (!sol.newestFile || !art.newestFile) return { possiblyStale: false };
  if (sol.newest <= art.newest) return { possiblyStale: false };
  return {
    possiblyStale: true,
    newestSource: sol.newestFile,
    newestArtifact: art.newestFile,
  };
}

// =============================================================================
// CONSTRUCTOR ARGUMENTS — LITERAL-ONLY RESOLUTION
// =============================================================================

const SKIP_KEYS = new Set(["type", "start", "end", "loc", "range", "raw"]);

function childNodes(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === "string") out.push(item);
    } else if (value && typeof value.type === "string") {
      out.push(value);
    }
  }
  return out;
}

function walkAll(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of childNodes(node)) walkAll(child, visit);
}

function normalizeExpression(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Resolve a node to a JS value, or refuse.
 *
 * Literals only, on purpose: this function must never produce a value the source
 * does not literally contain. Refusing costs a line in the report; guessing costs
 * a wrong address that looks right.
 */
function literalValue(node, source) {
  if (!node) return { ok: false, reason: "missing expression" };
  const text = () => normalizeExpression(source.slice(node.start, node.end));

  switch (node.type) {
    case "Literal": {
      if (typeof node.bigint === "string") return { ok: true, value: BigInt(node.bigint) };
      const t = typeof node.value;
      if (t === "string" || t === "number" || t === "boolean") return { ok: true, value: node.value };
      return { ok: false, reason: `literal of type ${node.value === null ? "null" : t}` };
    }
    case "TemplateLiteral": {
      if (node.expressions.length === 0) return { ok: true, value: node.quasis[0].value.cooked };
      return { ok: false, reason: `template literal with interpolation: ${text()}` };
    }
    case "UnaryExpression": {
      const inner = literalValue(node.argument, source);
      if (inner.ok && node.operator === "-" && (typeof inner.value === "number" || typeof inner.value === "bigint")) {
        return { ok: true, value: -inner.value };
      }
      return { ok: false, reason: `non-literal unary expression: ${text()}` };
    }
    case "ArrayExpression": {
      const values = [];
      for (const element of node.elements) {
        if (!element) return { ok: false, reason: `hole in array literal: ${text()}` };
        const value = literalValue(element, source);
        if (!value.ok) return value;
        values.push(value.value);
      }
      return { ok: true, value: values };
    }
    default:
      return { ok: false, reason: `not a literal: ${text()}` };
  }
}

/**
 * Parse one deploy script and collect its deployDeterministic() call sites plus
 * its top-level-ish variable declarators (used to follow `const salt = ...`).
 */
function collectCallSites(absFile) {
  const source = fs.readFileSync(absFile, "utf8");
  const options = { ecmaVersion: "latest", locations: true, allowHashBang: true, allowReturnOutsideFunction: true };
  let ast;
  try {
    ast = acorn.parse(source, { ...options, sourceType: "script" });
  } catch {
    ast = acorn.parse(source, { ...options, sourceType: "module" });
  }

  const calls = [];
  const declaratorsByName = new Map();

  walkAll(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
      if (!declaratorsByName.has(node.id.name)) declaratorsByName.set(node.id.name, []);
      declaratorsByName.get(node.id.name).push(normalizeExpression(source.slice(node.init.start, node.init.end)));
    }
    if (node.type !== "CallExpression") return;
    if (node.callee.type !== "Identifier" || node.callee.name !== "deployDeterministic") return;
    const nameNode = node.arguments[0];
    const contractName =
      nameNode && nameNode.type === "Literal" && typeof nameNode.value === "string" ? nameNode.value : null;
    const saltNode = node.arguments[2];
    calls.push({
      contractName,
      contractNameNode: nameNode || null,
      argsNode: node.arguments[1] || null,
      saltNode: saltNode || null,
      saltText: saltNode ? normalizeExpression(source.slice(saltNode.start, saltNode.end)) : null,
      line: node.loc ? node.loc.start.line : 0,
    });
  });

  return { source, calls, declaratorsByName };
}

/**
 * Find the deployDeterministic() call that used this salt, in this file.
 *
 * Three ways, most specific first. The fallback (sole call site naming this
 * contract in the file) is labelled in the output so a reader can see it was
 * inferred rather than matched.
 */
function locateCallSite(parsed, occurrence, contractName) {
  const candidates = parsed.calls.filter((c) => c.contractName === contractName);
  if (candidates.length === 0) {
    return { ok: false, reason: `no deployDeterministic("${contractName}", …) call in ${occurrence.sourceFile}` };
  }

  const direct = candidates.filter((c) => c.saltText === occurrence.expression);
  if (direct.length === 1) return { ok: true, call: direct[0], match: "inline-salt-expression" };

  const viaVar = candidates.filter((c) => {
    if (!c.saltNode || c.saltNode.type !== "Identifier") return false;
    const inits = parsed.declaratorsByName.get(c.saltNode.name) || [];
    return inits.length === 1 && inits[0] === occurrence.expression;
  });
  if (viaVar.length === 1) return { ok: true, call: viaVar[0], match: "salt-variable" };

  if (candidates.length === 1) return { ok: true, call: candidates[0], match: "sole-call-site-for-contract" };

  return {
    ok: false,
    reason:
      `could not attribute this salt to one of the ${candidates.length} ` +
      `deployDeterministic("${contractName}", …) calls in ${occurrence.sourceFile}`,
  };
}

/**
 * Resolve the constructor arguments for one identifier.
 *
 * Every occurrence of the identifier is resolved independently and they must
 * AGREE. Two call sites deploying the same contract under the same salt with
 * different arguments do not have one address — they have two, and only the
 * first to run gets its own. Disagreement is reported, never averaged away.
 */
function resolveConstructorArgs(occurrences, contractName, inputs, parseCache) {
  if (inputs.length === 0) {
    return { ok: true, values: [], basis: "constructor takes no arguments" };
  }

  const resolutions = [];
  const failures = [];

  for (const occurrence of occurrences) {
    const absFile = path.join(REPO_ROOT, occurrence.sourceFile);
    if (!parseCache.has(absFile)) {
      try {
        parseCache.set(absFile, collectCallSites(absFile));
      } catch (error) {
        parseCache.set(absFile, { error: error.message });
      }
    }
    const parsed = parseCache.get(absFile);
    if (parsed.error) {
      failures.push(`${occurrence.sourceFile}: could not parse (${parsed.error})`);
      continue;
    }

    const located = locateCallSite(parsed, occurrence, contractName);
    if (!located.ok) {
      failures.push(located.reason);
      continue;
    }
    if (!located.call.argsNode) {
      failures.push(`${occurrence.sourceFile}:${located.call.line}: call has no constructor-args argument`);
      continue;
    }
    const value = literalValue(located.call.argsNode, parsed.source);
    if (!value.ok) {
      failures.push(`${occurrence.sourceFile}:${located.call.line}: ${value.reason}`);
      continue;
    }
    if (!Array.isArray(value.value)) {
      failures.push(`${occurrence.sourceFile}:${located.call.line}: constructor args are not an array literal`);
      continue;
    }
    resolutions.push({
      site: `${occurrence.sourceFile}:${located.call.line}`,
      match: located.match,
      values: value.value,
    });
  }

  if (resolutions.length === 0) {
    return {
      ok: false,
      reason:
        `constructor takes ${inputs.length} argument(s) (${inputs.map((i) => `${i.type} ${i.name || ""}`.trim()).join(", ")}) ` +
        `and no call site supplies them as literals — ${failures.join("; ")}`,
    };
  }

  const shapes = new Set(resolutions.map((r) => JSON.stringify(r.values, (_k, v) => (typeof v === "bigint" ? String(v) : v))));
  if (shapes.size > 1) {
    return {
      ok: false,
      reason:
        "constructor arguments differ between call sites, so this identifier does not have one address: " +
        resolutions.map((r) => `${r.site} -> ${JSON.stringify(r.values)}`).join(" vs "),
    };
  }

  return {
    ok: true,
    values: resolutions[0].values,
    basis: `literal arguments at ${resolutions[0].site} [${resolutions[0].match}]`,
    partial: failures.length > 0 ? failures : undefined,
  };
}

// =============================================================================
// PREDICTION
// =============================================================================

/**
 * initCode = creation bytecode ++ abi.encode(constructor args)
 */
function buildInitCode(bytecode, inputs, values) {
  if (inputs.length === 0) return bytecode;
  const types = inputs.map((input) => ParamType.from(input));
  const encoded = abiCoder.encode(types, values);
  return bytecode + encoded.slice(2);
}

function predictAddress(factory, salt, initCode) {
  return getCreate2Address(factory, salt, keccak256(initCode));
}

/**
 * Build one prediction per unique identifier.
 */
function buildPredictions({ registry, artifactIndex, factory, sourceIndex = indexSources() }) {
  const byIdentifier = new Map();
  for (const entry of registry.entries) {
    if (!byIdentifier.has(entry.identifier)) {
      byIdentifier.set(entry.identifier, {
        identifier: entry.identifier,
        salt: entry.salt,
        contractName: entry.contractName,
        occurrences: [],
      });
    }
    const group = byIdentifier.get(entry.identifier);
    group.occurrences.push({ sourceFile: entry.sourceFile, line: entry.line, expression: entry.expression });
    // salt-registry guarantees no true collisions, so a second contract name for
    // one identifier cannot happen without that gate failing first. Recorded
    // rather than assumed away.
    if (entry.contractName && group.contractName && entry.contractName !== group.contractName) {
      group.contractNameConflict = [group.contractName, entry.contractName];
    }
  }

  const parseCache = new Map();
  const predictions = [];

  for (const group of [...byIdentifier.values()].sort((a, b) => a.identifier.localeCompare(b.identifier))) {
    const base = {
      identifier: group.identifier,
      salt: group.salt,
      contractName: group.contractName,
      callSites: group.occurrences.map((o) => `${o.sourceFile}:${o.line}`),
    };

    if (group.contractNameConflict) {
      predictions.push({
        ...base,
        predictable: false,
        reason: `two contracts share this identifier (${group.contractNameConflict.join(" vs ")}) — a salt collision`,
      });
      continue;
    }
    if (!group.contractName) {
      predictions.push({
        ...base,
        predictable: false,
        reason: "the salt registry could not resolve which contract deploys under this identifier",
      });
      continue;
    }

    const resolved = resolveArtifact(artifactIndex, group.contractName);
    if (!resolved.ok) {
      predictions.push({
        ...base,
        predictable: false,
        reason: resolved.missingArtifact ? missingArtifactReason(group.contractName, sourceIndex) : resolved.reason,
      });
      continue;
    }
    const artifact = resolved.artifact;

    const libraries = Object.entries(artifact.linkReferences || {}).flatMap(([file, libs]) =>
      Object.keys(libs).map((lib) => `${file}:${lib}`)
    );
    if (libraries.length > 0) {
      predictions.push({
        ...base,
        sourceName: artifact.sourceName,
        predictable: false,
        reason:
          `links ${libraries.length} librar${libraries.length === 1 ? "y" : "ies"} (${libraries.join(", ")}) — ` +
          "the library address is substituted into the creation bytecode at deploy time, so the initcode " +
          "is not known until that address is",
      });
      continue;
    }

    const constructorAbi = artifact.abi.find((item) => item.type === "constructor");
    const inputs = (constructorAbi && constructorAbi.inputs) || [];
    const args = resolveConstructorArgs(group.occurrences, group.contractName, inputs, parseCache);
    if (!args.ok) {
      predictions.push({
        ...base,
        sourceName: artifact.sourceName,
        constructorInputs: inputs.map((i) => i.type),
        predictable: false,
        reason: args.reason,
      });
      continue;
    }

    let initCode;
    try {
      initCode = buildInitCode(artifact.bytecode, inputs, args.values);
    } catch (error) {
      predictions.push({
        ...base,
        sourceName: artifact.sourceName,
        constructorInputs: inputs.map((i) => i.type),
        predictable: false,
        reason:
          `constructor arguments resolved to ${JSON.stringify(args.values)} but do not abi-encode against ` +
          `(${inputs.map((i) => i.type).join(", ")}): ${error.message}`,
      });
      continue;
    }

    predictions.push({
      ...base,
      sourceName: artifact.sourceName,
      artifactPath: artifact.artifactPath,
      constructorInputs: inputs.map((i) => i.type),
      constructorArgs: args.values.map((v) => (typeof v === "bigint" ? String(v) : v)),
      argsBasis: args.basis,
      ...(args.partial ? { argsPartial: args.partial } : {}),
      initCodeHash: keccak256(initCode),
      initCodeBytes: (initCode.length - 2) / 2,
      predictable: true,
      predictedAddress: predictAddress(factory, group.salt, initCode),
    });
  }

  return predictions;
}

// =============================================================================
// COMPARISON AGAINST deployments/*.json
// =============================================================================

/**
 * Which key in a deployment record holds a given contract.
 *
 * Mapped ONLY where the script that writes the key is the script that deploys
 * the contract with deployDeterministic(). Anything else is left unmapped with a
 * stated reason (below) — inventing a mapping would manufacture a mismatch
 * between two different deployments and bury the real ones.
 */
const RECORD_KEYS_BY_IDENTIFIER = {
  // deploy.js deploys MockERC20 twice, under two identifiers, into two keys.
  "FairWins-P2P-v2.0-MockUSDC": ["mocks.mockUSDC"],
  "FairWins-P2P-v2.0-MockWMATIC": ["mocks.mockWMATIC"],
};

const RECORD_KEYS_BY_CONTRACT = {
  // --- spec 080's ten already-CREATE2-deployed contracts -------------------
  BackupPointerRegistry: ["contracts.backupPointerRegistry"], // deploy-backup-pointer-registry.js:61
  SafeProposalHub: ["contracts.safeProposalHub"], // custody/deploy-safe-proposal-hub.js:76
  VoucherBatchMinter: ["contracts.voucherBatchMinter"], // deploy.js:319, deploy-voucher-batch-minter.js:63
  WagerPool: ["contracts.poolImpl"], // deploy-wager-pool-factory.js, set-pool-template.js
  OpenERC20: ["contracts.openERC20Impl"], // deploy.js:506
  OpenERC721: ["contracts.openERC721Impl"], // deploy.js:507
  RestrictedERC20: ["contracts.restrictedERC20Impl"], // deploy.js:508
  OpenERC20V2: ["contracts.openERC20V2Impl"], // upgrade-token-factory-v2.js:60
  OpenERC721V2: ["contracts.openERC721V2Impl"], // upgrade-token-factory-v2.js:61
  RestrictedERC20V2: ["contracts.restrictedERC20V2Impl"], // upgrade-token-factory-v2.js:62

  // --- other contracts deploy.js and friends deploy deterministically ------
  MembershipVoucher: ["contracts.membershipVoucher"], // deploy.js:301
  KeyRegistry: ["contracts.keyRegistry"], // deploy.js:487
  SanctionsGuard: ["contracts.sanctionsGuard"], // deploy.js:387
  PolymarketOracleAdapter: ["contracts.polymarketAdapter"], // deploy.js:264
  ChainlinkDataFeedOracleAdapter: ["contracts.chainlinkDataFeedAdapter"], // deploy.js:419
  ChainlinkFunctionsOracleAdapter: ["contracts.chainlinkFunctionsAdapter"], // deploy.js:447
  UMAOptimisticOracleV3Adapter: ["contracts.umaAdapter"], // deploy.js:470
  MockPolymarketCTF: ["mocks.mockPolymarketCTF"], // deploy.js:89
  MockSanctionsOracle: ["mocks.mockSanctionsOracle"], // deploy.js:377
  SafePolicyGuard: ["contracts.safePolicyGuard"], // custody/deploy-policy-guard.js TARGETS
  SafePolicyGuardV2: ["contracts.safePolicyGuardV2"], // custody/deploy-policy-guard-v2.js
  PolicyGuardSetup: ["contracts.policyGuardSetup"], // custody/deploy-policy-guard.js TARGETS

  // --- legacy v1 / ClearPath scripts; these keys appear only in the ---------
  // --- localhost-chain1337-*.json records they wrote -----------------------
  FriendGroupMarketFactory: ["contracts.friendGroupMarketFactory"],
  CTF1155: ["contracts.ctf1155"],
  MarketCorrelationRegistry: ["contracts.marketCorrelationRegistry"],
  NullifierRegistry: ["contracts.nullifierRegistry"],
  RoleManagerCore: ["contracts.roleManagerCore"],
  TieredRoleManager: ["contracts.tieredRoleManager"],
  TierRegistry: ["contracts.tierRegistry"],
  UsageTracker: ["contracts.usageTracker"],
  PaymentProcessor: ["contracts.paymentProcessor"],
  MembershipPaymentManager: ["contracts.membershipPaymentManager"],
  TokenMintFactory: ["contracts.tokenMintFactory"],
  DAOFactory: ["contracts.daoFactory"],
  FutarchyGovernor: ["contracts.futarchyGovernor"],
  OracleResolver: ["contracts.oracleResolver"],
  PrivacyCoordinator: ["contracts.privacyCoordinator"],
  ProposalRegistry: ["contracts.proposalRegistry"],
  RagequitModule: ["contracts.ragequitModule"],
  WelfareMetricRegistry: ["contracts.welfareRegistry"],
};

/**
 * Contracts deliberately NOT mapped to a record key, with why. Reported as
 * "not comparable" rather than as a gap or a mismatch (FR-016 / G7).
 */
const UNMAPPED_REASONS = {
  MembershipManager:
    "the live records' `membershipManager` is a UUPS proxy deployed with the upgrades plugin (plain CREATE); " +
    "the CREATE2 identifier here comes from the legacy modular deploy script. Comparing them would compare two " +
    "different deployments. Becomes comparable when the proxy path goes deterministic (spec 080 Phase 4)",
  OracleRegistry: "no key in any deployment record corresponds to this legacy identifier",
  FriendGroupClaimsLib: "libraries are not recorded in deployments/*.json",
  FriendGroupCreationLib: "libraries are not recorded in deployments/*.json",
  FriendGroupResolutionLib: "libraries are not recorded in deployments/*.json",
  ZKKeyManager: "no key in any deployment record corresponds to this legacy identifier",
  PerpetualFuturesFactory: "no key in any deployment record corresponds to this legacy identifier",
  FundingRateEngine: "no key in any deployment record corresponds to this legacy identifier",
  ConditionalMarketFactory: "no key in any deployment record corresponds to this legacy identifier",
  TierRegistryAdapter: "no key in any deployment record corresponds to this legacy identifier",
};

/**
 * Read every deployment record. A record that cannot be read becomes
 * `unreadable` — never an empty record, which would read as "nothing deployed
 * here" and is the exact dishonesty FR-018 forbids.
 */
function loadDeploymentRecords(deploymentsDir = DEPLOYMENTS_DIR) {
  const records = [];
  let files;
  try {
    files = fs.readdirSync(deploymentsDir).filter((f) => f.endsWith(".json")).sort();
  } catch (error) {
    return { records, error: `cannot read ${deploymentsDir}: ${error.message}` };
  }

  for (const file of files) {
    const full = path.join(deploymentsDir, file);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (error) {
      records.push({ file, unreadable: true, reason: `unparseable JSON: ${error.message}` });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !parsed.contracts || typeof parsed.contracts !== "object") {
      // Not an address record at all (deployments/admin-safe.json is a Safe
      // configuration). Skipping it is correct; silently treating it as a chain
      // with nothing deployed would not be.
      records.push({ file, skipped: true, reason: "no `contracts` section — not a per-chain address record" });
      continue;
    }
    records.push({
      file,
      network: parsed.network || file.replace(/\.json$/, ""),
      chainId: parsed.chainId ?? null,
      contracts: parsed.contracts,
      mocks: parsed.mocks || {},
      constructorArgs: parsed.constructorArgs || {},
    });
  }
  return { records };
}

function recordLookup(record, dottedKey) {
  const [section, key] = dottedKey.split(".");
  const bucket = section === "mocks" ? record.mocks : record.contracts;
  return bucket ? bucket[key] : undefined;
}

function sameAddress(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * Compare one prediction against one chain's record.
 *
 * Two prediction bases are allowed to satisfy a match:
 *   static      - constructor args resolved from the source (chain-independent)
 *   record-args - constructor args taken from the record's own `constructorArgs`
 *
 * The second exists because some contracts take chain-specific constructor args
 * today (VoucherBatchMinter takes the voucher address), so their address is a
 * function of configuration — which is exactly what FR-007 says must stop. Using
 * the recorded args still proves salt + bytecode + args -> address, but it is NOT
 * an independent prediction and is labelled every time it is used.
 */
function compareOne({ prediction, record, artifactIndex, factory }) {
  const keys = RECORD_KEYS_BY_IDENTIFIER[prediction.identifier] || RECORD_KEYS_BY_CONTRACT[prediction.contractName] || null;

  if (record.unreadable) {
    return { status: "unknown-chain-unreachable", reason: record.reason };
  }

  if (!keys) {
    return {
      status: "not-comparable",
      reason:
        UNMAPPED_REASONS[prediction.contractName] ||
        `no deployment-record key is mapped to ${prediction.contractName || prediction.identifier}`,
    };
  }

  const present = keys
    .map((key) => ({ key, value: recordLookup(record, key) }))
    .filter((k) => typeof k.value === "string" && k.value.length > 0);

  if (present.length === 0) {
    return { status: "not-deployed", keys, reason: "not recorded on this chain (this tool reads records, not chains)" };
  }

  const candidates = [];
  if (prediction.predictable) {
    candidates.push({ basis: "static", address: prediction.predictedAddress });
  }

  for (const { key } of present) {
    const [, bare] = key.split(".");
    const recordedArgs = record.constructorArgs ? record.constructorArgs[bare] : undefined;
    if (!Array.isArray(recordedArgs)) continue;
    if (prediction.predictable && JSON.stringify(prediction.constructorArgs) === JSON.stringify(recordedArgs)) continue;
    const resolved = resolveArtifact(artifactIndex, prediction.contractName);
    if (!resolved.ok) continue;
    const constructorAbi = resolved.artifact.abi.find((item) => item.type === "constructor");
    const inputs = (constructorAbi && constructorAbi.inputs) || [];
    if (inputs.length !== recordedArgs.length) continue;
    try {
      const initCode = buildInitCode(resolved.artifact.bytecode, inputs, recordedArgs);
      candidates.push({
        basis: "record-args",
        address: predictAddress(factory, prediction.salt, initCode),
        args: recordedArgs,
      });
    } catch {
      // Recorded args that do not encode against the current ABI tell us nothing;
      // leaving the candidate out keeps the comparison honest.
    }
  }

  if (candidates.length === 0) {
    return {
      status: "not-comparable",
      keys: present.map((p) => p.key),
      recorded: present[0].value,
      reason: prediction.predictable ? "no usable prediction for this chain" : `UNPREDICTABLE: ${prediction.reason}`,
    };
  }

  for (const entry of present) {
    const hit = candidates.find((c) => sameAddress(c.address, entry.value));
    if (hit) {
      return {
        status: "match",
        key: entry.key,
        recorded: entry.value,
        predicted: hit.address,
        basis: hit.basis,
        ...(hit.args ? { argsFromRecord: hit.args } : {}),
      };
    }
  }

  return {
    status: "mismatch",
    key: present[0].key,
    recorded: present[0].value,
    predicted: candidates[0].address,
    basis: candidates[0].basis,
    alternatives: candidates.slice(1).map((c) => ({ basis: c.basis, address: c.address })),
  };
}

function compareDeployed({ predictions, artifactIndex, factory, deploymentsDir }) {
  const { records, error } = loadDeploymentRecords(deploymentsDir);
  const usable = records.filter((r) => !r.skipped);
  const rows = [];

  for (const prediction of predictions) {
    const perChain = [];
    for (const record of usable) {
      perChain.push({
        file: record.file,
        network: record.network || record.file,
        chainId: record.chainId ?? null,
        ...compareOne({ prediction, record, artifactIndex, factory }),
      });
    }
    rows.push({ identifier: prediction.identifier, contractName: prediction.contractName, chains: perChain });
  }

  const counts = { match: 0, mismatch: 0, "not-deployed": 0, "unknown-chain-unreachable": 0, "not-comparable": 0 };
  for (const row of rows) for (const chain of row.chains) counts[chain.status] += 1;

  return {
    error: error || null,
    skippedRecords: records.filter((r) => r.skipped).map((r) => ({ file: r.file, reason: r.reason })),
    unreadableRecords: records.filter((r) => r.unreadable).map((r) => ({ file: r.file, reason: r.reason })),
    chainsCompared: usable.length,
    rows,
    counts,
  };
}

// =============================================================================
// REPORT
// =============================================================================

function formatReport(result, { verbose = false } = {}) {
  const lines = [];
  const predictable = result.predictions.filter((p) => p.predictable);
  const unpredictable = result.predictions.filter((p) => !p.predictable);

  lines.push("Deterministic address predictions (spec 080, FR-006)");
  lines.push("=".repeat(96));
  lines.push(`CREATE2 deployer : ${result.factory}  (Safe Singleton Factory, from scripts/deploy/lib/constants.js)`);
  lines.push(`Artifacts        : ${result.artifactsDir}  (${result.artifactCount} artifacts)`);
  lines.push(`Tenant scope     : ${result.tenantId ? result.tenantId : "(none — shared estate, unprefixed salts)"}`);
  lines.push(`Identifiers      : ${result.predictions.length}  (${predictable.length} predictable, ${unpredictable.length} UNPREDICTABLE)`);

  // Coverage gaps inherited from the salt registry. Printed BEFORE the address list, because a
  // reader who scrolls to the addresses and stops must still have seen that the list is incomplete.
  const sr = result.saltRegistry || {};
  if ((sr.parseFailures || []).length > 0) {
    lines.push("");
    lines.push(`!! COVERAGE GAP — ${sr.parseFailures.length} file(s) could not be analysed at all.`);
    lines.push("   Every deterministic deploy in them is INVISIBLE here, so this list is NOT complete:");
    for (const f of sr.parseFailures) lines.push(`     · ${f}`);
  }
  if (sr.trueCollisions > 0) {
    lines.push("");
    lines.push(`!! ${sr.trueCollisions} SALT COLLISION(S) — two different contracts share an address. See salt-registry.js.`);
  }
  if (sr.indeterminateGroups > 0) {
    lines.push("");
    lines.push(
      `!! ${sr.indeterminateGroups} INDETERMINATE salt group(s) — a shared salt whose contracts could not all be` +
        " resolved, i.e. a POSSIBLE collision. See salt-registry.js."
    );
  }
  lines.push("No chain was contacted to produce any address below.");
  lines.push("");

  if (result.staleArtifacts && result.staleArtifacts.possiblyStale) {
    lines.push("!".repeat(96));
    lines.push("WARNING — ARTIFACTS MAY BE STALE. Every address below is derived from compiled bytes.");
    lines.push(`  newest source  : ${result.staleArtifacts.newestSource}`);
    lines.push(`  newest artifact: ${result.staleArtifacts.newestArtifact}  (older)`);
    lines.push("  Run `rm -rf artifacts cache && npm run compile` before trusting these numbers.");
    lines.push("!".repeat(96));
    lines.push("");
  }

  lines.push("-".repeat(96));
  lines.push(`PREDICTABLE (${predictable.length})`);
  lines.push("-".repeat(96));
  for (const p of predictable) {
    lines.push(`  ${p.predictedAddress}  ${p.contractName}`);
    lines.push(`      identifier: ${p.identifier}`);
    lines.push(`      salt      : ${p.salt}`);
    lines.push(`      initcode  : ${p.initCodeHash} (${p.initCodeBytes} bytes)`);
    lines.push(`      args      : ${p.constructorArgs.length ? JSON.stringify(p.constructorArgs) : "[]"} — ${p.argsBasis}`);
    if (verbose) lines.push(`      call sites: ${p.callSites.join(", ")}`);
  }
  lines.push("");

  lines.push("-".repeat(96));
  lines.push(`UNPREDICTABLE (${unpredictable.length}) — NO address is printed for these, deliberately`);
  lines.push("  An assumed-empty constructor would print a confident wrong address. These are the");
  lines.push("  contracts whose initcode is not decidable from the source tree alone.");
  lines.push("-".repeat(96));
  for (const p of unpredictable) {
    lines.push(`  ${(p.contractName || "<unresolved contract>").padEnd(34)} ${p.identifier}`);
    const reason = verbose || p.reason.length <= 300 ? p.reason : `${p.reason.slice(0, 300)}… (--verbose for the rest)`;
    lines.push(`      reason: ${reason}`);
    if (verbose) lines.push(`      call sites: ${p.callSites.join(", ")}`);
  }
  lines.push("");

  if (result.comparison) {
    const c = result.comparison;
    lines.push("=".repeat(96));
    lines.push(`COMPARISON AGAINST ${result.deploymentsDir || "deployments"}/*.json (${c.chainsCompared} records)`);
    lines.push("  Records are the source of truth (FR-019) and are all this reads — no chain is contacted.");
    lines.push("  `not-deployed` therefore means NOT RECORDED, which is not the same as absent from a chain.");
    lines.push("=".repeat(96));
    lines.push(
      `  match ${c.counts.match}   mismatch ${c.counts.mismatch}   not-deployed ${c.counts["not-deployed"]}   ` +
        `unknown-chain-unreachable ${c.counts["unknown-chain-unreachable"]}   not-comparable ${c.counts["not-comparable"]}`
    );
    lines.push("");

    for (const row of c.rows) {
      const interesting = row.chains.filter((ch) => ch.status === "match" || ch.status === "mismatch" || ch.status === "unknown-chain-unreachable");
      if (interesting.length === 0 && !verbose) continue;
      lines.push(`  ${row.contractName || "<unresolved>"}  [${row.identifier}]`);
      for (const ch of verbose ? row.chains : interesting) {
        const tag = ch.status.toUpperCase().padEnd(26);
        if (ch.status === "match") {
          lines.push(`      ${tag} ${ch.network.padEnd(28)} ${ch.recorded}  (${ch.key}, ${ch.basis})`);
          if (ch.basis === "record-args") {
            lines.push(
              "          note: matched using the record's own constructorArgs — this address depends on " +
                "chain-specific configuration, which is what FR-007 exists to end"
            );
          }
        } else if (ch.status === "mismatch") {
          lines.push(`      ${tag} ${ch.network.padEnd(28)} recorded  ${ch.recorded}  (${ch.key})`);
          lines.push(`      ${" ".repeat(26)} ${" ".repeat(28)} predicted ${ch.predicted}  (${ch.basis})`);
        } else {
          lines.push(`      ${tag} ${ch.network.padEnd(28)} ${ch.reason || ""}`);
        }
      }
      lines.push("");
    }

    if (c.unreadableRecords.length) {
      lines.push("-".repeat(96));
      lines.push("UNREADABLE RECORDS — reported as unknown, never as 'contract absent' (FR-018)");
      for (const r of c.unreadableRecords) lines.push(`  ${r.file}: ${r.reason}`);
      lines.push("");
    }
    if (c.skippedRecords.length && verbose) {
      lines.push("-".repeat(96));
      lines.push("SKIPPED FILES (not per-chain address records)");
      for (const r of c.skippedRecords) lines.push(`  ${r.file}: ${r.reason}`);
      lines.push("");
    }

    if (c.counts.mismatch > 0) {
      lines.push("=".repeat(96));
      lines.push(`${c.counts.mismatch} MISMATCH(ES) — a recorded address is not the predicted one.`);
      lines.push("");
      lines.push("  Before treating this as a defect, check WHICH bytecode produced the prediction.");
      lines.push("  Spec 080 changed compiled output (`metadata: { bytecodeHash: \"none\" }`), which moves");
      lines.push("  every CREATE2 address derived from it. Predictions from CURRENT bytecode are EXPECTED");
      lines.push("  not to match addresses deployed before that change — research.md R5, the five");
      lines.push("  `transitional` contracts. Nothing already deployed moved; the next deployment lands");
      lines.push("  somewhere new. To check this tool against reality, predict from pre-change artifacts:");
      lines.push("      node scripts/deploy/predict-addresses.js --compare-deployed --artifacts <pre-change artifacts>");
      lines.push("=".repeat(96));
    }
  }

  return lines.join("\n");
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compute every prediction, and optionally compare against the recorded estate.
 *
 * @param {Object} [options]
 * @param {string} [options.artifactsDir]
 * @param {boolean} [options.compareDeployed]
 * @returns {Object} the full result (also what --json prints)
 */
function predictAddresses(options = {}) {
  const artifactsDir = options.artifactsDir ? path.resolve(options.artifactsDir) : DEFAULT_ARTIFACTS_DIR;
  if (!fs.existsSync(artifactsDir)) {
    throw new Error(`Artifacts directory not found: ${artifactsDir}. Run \`npm run compile\` first.`);
  }

  const factory = readSingletonFactoryAddress();
  const artifactIndex = indexArtifacts(artifactsDir);
  if (artifactIndex.count === 0) {
    throw new Error(`No artifacts under ${artifactsDir}. Run \`npm run compile\` first.`);
  }

  const registry = buildSaltRegistry();
  const predictions = buildPredictions({ registry, artifactIndex, factory });

  const result = {
    factory,
    artifactsDir: displayPath(artifactsDir),
    artifactCount: artifactIndex.count,
    tenantId: registry.tenantId,
    staleArtifacts: detectStaleArtifacts(artifactsDir),
    /*
     * CARRY THE REGISTRY'S BLIND SPOTS, DO NOT DROP THEM.
     *
     * This used to copy four stats fields and discard the rest. The salt registry reports its own
     * limits honestly — parse failures, module fallbacks, indeterminate salt groups, unresolved
     * contract names — and dropping them here meant this tool printed a confident list of "every
     * deterministic address" while an identifier could be invisible to it, e.g. (until issue
     * #1108/#1109 deleted it) scripts/deploy/archive/deploy-correlation-registry.js, which was not
     * parseable JavaScript. The registry said so. This tool did not pass it on.
     *
     * That is honesty lost at a consumer boundary, which is worse than never having had it: the
     * upstream check looks diligent and the downstream output looks complete. Keep carrying these
     * through even now that the known offender is gone — the next broken archive script (or a live
     * one someone breaks) needs the same honesty, not a special case for this one file.
     */
    saltRegistry: {
      identifiers: registry.stats.identifiers,
      uniqueIdentifiers: registry.stats.uniqueIdentifiers,
      trueCollisions: registry.stats.trueCollisions,
      unresolvedIdentifiers: registry.stats.unresolvedIdentifiers,
      unresolvedContractNames: registry.stats.unresolvedContractNames,
      indeterminateGroups: registry.stats.indeterminateGroups,
      parseFailures: (registry.parseFailures || []).map((f) =>
        typeof f === "string" ? f : `${f.sourceFile || f.file}: ${f.reason}`
      ),
      moduleFallbacks: (registry.moduleFallbacks || []).length,
    },
    predictions,
    counts: {
      total: predictions.length,
      predictable: predictions.filter((p) => p.predictable).length,
      unpredictable: predictions.filter((p) => !p.predictable).length,
    },
    comparison: null,
  };

  if (options.compareDeployed) {
    const deploymentsDir = options.deploymentsDir ? path.resolve(options.deploymentsDir) : DEPLOYMENTS_DIR;
    result.deploymentsDir = displayPath(deploymentsDir);
    result.comparison = compareDeployed({ predictions, artifactIndex, factory, deploymentsDir });
  }

  return result;
}

// =============================================================================
// CLI
// =============================================================================

function parseArgv(argv) {
  const args = argv.slice(2);
  const options = { json: false, verbose: false, compareDeployed: false, artifactsDir: null, deploymentsDir: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--compare-deployed") options.compareDeployed = true;
    else if (arg === "--artifacts") {
      options.artifactsDir = args[i + 1];
      i += 1;
      if (!options.artifactsDir) throw new Error("--artifacts needs a directory");
    } else if (arg.startsWith("--artifacts=")) options.artifactsDir = arg.slice("--artifacts=".length);
    else if (arg === "--deployments") {
      options.deploymentsDir = args[i + 1];
      i += 1;
      if (!options.deploymentsDir) throw new Error("--deployments needs a directory");
    } else if (arg.startsWith("--deployments=")) options.deploymentsDir = arg.slice("--deployments=".length);
    else {
      throw new Error(
        `Unknown argument "${arg}". Supported: --json --verbose --compare-deployed --artifacts <dir> --deployments <dir>`
      );
    }
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  let result;
  try {
    result = predictAddresses(options);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result, { verbose: options.verbose })}\n`);
  }

  if (result.comparison && result.comparison.counts.mismatch > 0) return 1;
  if (result.comparison && result.comparison.error) return 1;
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = {
  predictAddresses,
  buildPredictions,
  compareDeployed,
  formatReport,
  readSingletonFactoryAddress,
  indexArtifacts,
  RECORD_KEYS_BY_CONTRACT,
  RECORD_KEYS_BY_IDENTIFIER,
};
