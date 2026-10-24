const { expect } = require("chai");
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..", "..");

/**
 * Spec 074, FR-002 / SC-002 — the EVM target must be DECLARED BY THIS REPOSITORY.
 *
 * Before spec 075 only the 0.8.23 compiler entry pinned `evmVersion`. The 0.8.24 entry — 116 of
 * the repo's 120 contracts — and all 38 per-file overrides declared nothing, so their EVM target
 * came from Hardhat's own internal default
 * (config-resolution.js: `compiler.settings?.evmVersion ?? "paris"` for solc >= 0.8.20)
 * while `hardhat` is depended on as a caret range. The EVM target of nearly all deployed bytecode
 * was therefore a property of a floating third-party default rather than of this repo.
 *
 * Why that matters concretely: `shanghai` emits PUSH0 and `cancun` emits MCOPY. Both are
 * undeployable on ETC 61 and Mordor 63 (live networks per CLAUDE.md), and both change deployed
 * bytecode — hence every CREATE2 address — against UUPS proxies at STABLE addresses.
 *
 * READ `hre.userConfig`, NOT `hre.config`.
 * ---------------------------------------
 * This is the whole point of the test and it is easy to get wrong. `hre.config` is the RESOLVED
 * config, into which Hardhat has already substituted its default — so an assertion against it
 * passes whether or not the repo declared anything. Measured at adoption: userConfig reported
 * evmVersion on 0 of 38 overrides while the resolved config reported it on all 38. A test written
 * against `hre.config` is a gate that cannot fail, which is exactly what spec 075 exists to
 * eliminate. `hre.userConfig` is the raw module export and is the only surface that answers
 * "did WE declare this?".
 *
 * Both surfaces are checked below: userConfig for the declaration, hre.config for the effective
 * value that actually reaches solc.
 */
const REQUIRED_EVM_VERSION = "paris";

/**
 * THE ONE DOCUMENTED EXCEPTION (spec 030 pillar A, issue #1268).
 *
 * OpenZeppelin 5.4.0's `Governor` closure reaches `utils/Bytes.sol`, which uses the Cancun `mcopy`
 * opcode; there is no compiler flag that emulates it, so native DAO creation cannot be compiled for
 * `paris` at all. The maintainer's decision is to take the latest OZ Governor and DROP pre-Cancun
 * chains FOR THAT CONTRACT ONLY: `StandardDAOFactory` and the contracts it deploys ship on the
 * Cancun EVM chains and are absent, by decision, on ETC 61 and Mordor 63. Pillar B's
 * `ExternalDAORegistry` imports only the `IGovernor` INTERFACE, stays `paris`, and still serves them.
 *
 * THIS SET IS PINNED IN BOTH DIRECTIONS BELOW, and that is the whole point of writing it down. A file
 * added here silently becomes undeployable on ETC/Mordor — the exact regression the paris pin exists
 * to prevent — and a file removed here stops compiling. Neither is something a reviewer should have to
 * notice unaided, and neither shows up as a test failure anywhere else: an over-broad cancun target
 * produces a perfectly successful build.
 *
 * Two kinds of entry, for two different reasons:
 *   - reaches `utils/Bytes.sol` transitively, so it CANNOT compile at paris. Hardhat roots a
 *     compilation job at every RESOLVED file, dependencies included, so this covers the OZ governance
 *     files too — not only the first-party contracts that import them.
 *   - is DEPLOYED BY `StandardDAOFactory` (`TimelockController`, `StandardDAOToken`), so its creation
 *     code is embedded from the factory's cancun job. Left on paris its committed artifact would
 *     describe bytes that are not the bytes on chain, breaking source verification of a live treasury.
 */
const CANCUN_TARGETED = [
  "contracts/clearpath/StandardDAOFactory.sol",
  "contracts/clearpath/StandardDAODeployers.sol",
  "contracts/clearpath/StandardDAOGovernor.sol",
  "contracts/clearpath/StandardDAOToken.sol",
  "@openzeppelin/contracts/governance/Governor.sol",
  "@openzeppelin/contracts/governance/TimelockController.sol",
  "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol",
  "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol",
  "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol",
  "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol",
  "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol",
  "@openzeppelin/contracts/utils/Bytes.sol",
  "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol",
];

describe("Compiler configuration: EVM target is declared, not inherited", function () {
  describe("declared by this repository (hre.userConfig)", function () {
    it("declares an explicit evmVersion on every compiler entry", function () {
      const compilers = hre.userConfig.solidity.compilers;
      expect(compilers, "expected at least one compiler entry").to.have.length.greaterThan(0);

      const undeclared = compilers
        .filter((c) => !c.settings || typeof c.settings.evmVersion !== "string")
        .map((c) => c.version);

      expect(
        undeclared,
        `compiler entries declaring no evmVersion: ${undeclared.join(", ")}. ` +
          "An undeclared entry silently inherits Hardhat's internal default."
      ).to.deep.equal([]);
    });

    it("declares an explicit evmVersion on every per-file override", function () {
      const overrides = hre.userConfig.solidity.overrides || {};
      const undeclared = Object.entries(overrides)
        .filter(([, cfg]) => !cfg.settings || typeof cfg.settings.evmVersion !== "string")
        .map(([file]) => file);

      expect(
        undeclared.length,
        `${undeclared.length} of ${Object.keys(overrides).length} overrides declare no evmVersion, ` +
          `e.g. ${undeclared.slice(0, 3).join(", ")}`
      ).to.equal(0);
    });
  });

  /*
   * The same argument as evmVersion, for the metadata mode (spec 080, FR-001).
   *
   * `metadata.bytecodeHash: "none"` keeps the source-file fingerprint out of the compiled bytes, so
   * moving or renaming a source file cannot move a contract's bytecode — and therefore cannot move
   * any CREATE2 address derived from it. An entry that omits it silently reverts to embedding the
   * fingerprint, which does not fail anything: it just quietly makes that contract's address
   * path-dependent again. Exactly the invisible regression the evmVersion pin exists to prevent,
   * which is why it is pinned the same way rather than left to a code review to notice.
   */
  describe("metadata mode is declared, not inherited (spec 080)", function () {
    const MODE = "none";

    it("declares bytecodeHash on every compiler entry", function () {
      const compilers = hre.userConfig.solidity.compilers;
      const bad = compilers
        .filter((c) => c.settings?.metadata?.bytecodeHash !== MODE)
        .map((c) => `${c.version} (${c.settings?.metadata?.bytecodeHash ?? "undeclared"})`);

      expect(
        bad,
        `compiler entries not declaring metadata.bytecodeHash="${MODE}": ${bad.join(", ")}. ` +
          "An undeclared entry embeds the source fingerprint, making its addresses path-dependent."
      ).to.deep.equal([]);
    });

    it("declares bytecodeHash on every per-file override", function () {
      const overrides = hre.userConfig.solidity.overrides || {};
      const bad = Object.entries(overrides)
        .filter(([, cfg]) => cfg.settings?.metadata?.bytecodeHash !== MODE)
        .map(([file]) => file);

      expect(
        bad.length,
        `${bad.length} of ${Object.keys(overrides).length} overrides do not declare ` +
          `metadata.bytecodeHash="${MODE}", e.g. ${bad.slice(0, 3).join(", ")}`
      ).to.equal(0);
    });

    it("the effective config reaching solc carries it too", function () {
      // userConfig is what we wrote; config is what solc is actually handed. Asserting only the
      // former would pass while a plugin rewrote the latter.
      const compilers = hre.config.solidity.compilers;
      const bad = compilers
        .filter((c) => c.settings?.metadata?.bytecodeHash !== MODE)
        .map((c) => c.version);
      expect(bad, `resolved compiler entries missing the metadata mode: ${bad.join(", ")}`).to.deep.equal([]);
    });
  });

  describe("effective value reaching solc (hre.config)", function () {
    it("pins every compiler entry to the deployable target", function () {
      for (const c of hre.config.solidity.compilers) {
        expect(
          c.settings.evmVersion,
          `solc ${c.version} targets "${c.settings.evmVersion}". Only "${REQUIRED_EVM_VERSION}" is ` +
            "deployable on ETC 61 / Mordor 63 (shanghai emits PUSH0, cancun emits MCOPY)."
        ).to.equal(REQUIRED_EVM_VERSION);
      }
    });

    it("pins every per-file override to the deployable target, except the declared Cancun set", function () {
      const cancun = new Set(CANCUN_TARGETED);
      for (const [file, cfg] of Object.entries(hre.config.solidity.overrides || {})) {
        if (cancun.has(file)) continue;
        expect(
          cfg.settings.evmVersion,
          `override for ${file} targets "${cfg.settings.evmVersion}", expected "${REQUIRED_EVM_VERSION}". ` +
            "Only the spec-030 pillar-A closure listed in CANCUN_TARGETED may leave paris, and adding " +
            "a file to that list makes it undeployable on ETC 61 / Mordor 63."
        ).to.equal(REQUIRED_EVM_VERSION);
      }
    });

    /*
     * Both directions, because each failure mode is silent on its own:
     *   - a file targeting cancun WITHOUT being declared here is a chain-support decision nobody made;
     *   - a file declared here that is NOT actually targeting cancun makes this list read broader than
     *     the build, which is how an exception quietly becomes the rule.
     */
    it("the Cancun exception is exactly the declared set — no more, no less", function () {
      const overrides = hre.config.solidity.overrides || {};
      const actualCancun = Object.entries(overrides)
        .filter(([, cfg]) => cfg.settings.evmVersion === "cancun")
        .map(([file]) => file)
        .sort();

      expect(
        actualCancun,
        "the set of cancun-targeted overrides drifted from CANCUN_TARGETED in test/config/" +
          "CompilerTargets.test.js. Every entry is a deliberate decision that a contract does not run " +
          "on ETC 61 / Mordor 63 (issue #1268) — reconcile the list, do not widen it to make this pass."
      ).to.deep.equal([...CANCUN_TARGETED].sort());
    });

    it("declares no EVM target other than paris or the documented cancun", function () {
      const allowed = new Set([REQUIRED_EVM_VERSION, "cancun"]);
      const stray = Object.entries(hre.config.solidity.overrides || {})
        .filter(([, cfg]) => !allowed.has(cfg.settings.evmVersion))
        .map(([file, cfg]) => `${file} (${cfg.settings.evmVersion})`);
      expect(
        stray,
        `override(s) targeting an undocumented EVM version: ${stray.join(", ")}. ` +
          "`shanghai` emits PUSH0 and every later target emits more; neither is a target this repo has chosen."
      ).to.deep.equal([]);
    });
  });
});

/**
 * Spec 075, FR-001/FR-005 — the SAME defect as an unpinned evmVersion, one layer down.
 *
 * Any npm package that contributes Solidity source to the compile is a build input. Declared with
 * a caret range, the version that actually compiles is decided by WHEN someone last resolved the
 * lockfile, not by this repository — so deployed bytecode silently depends on install time.
 *
 * This is not hypothetical. Regenerating the lockfile during the spec-075 workspace conversion
 * floated `@chainlink/contracts` from 1.3.0 to 1.5.0 and changed the compiled bytecode of
 * ChainlinkFunctionsOracleAdapter. The byte-diff gate caught it; nothing else would have.
 * `@uma/core` was floating the same way (2.61.0 -> 2.62.2); it has since been removed
 * entirely — its two interfaces are declared in contracts/interfaces/IOptimisticOracleV3.sol,
 * because AGPL-3.0-only sources cannot live in this Apache-2.0 tree and the package cost
 * 1,157 of 3,202 installed packages to supply 199 lines of Solidity.
 *
 * Solidity-source dependencies must therefore be pinned EXACTLY, exactly as @openzeppelin/contracts
 * and @safe-global/safe-contracts already were.
 */
describe("Solidity-source dependencies are pinned exactly (spec 075, FR-001)", function () {
  // The packages whose .sol files contracts/ is EXPECTED to import. This list is documentation of
  // an intended build surface — it is no longer the input to the check. `solidityImportPackages()`
  // below reads the imports themselves, and the first test asserts the two agree in BOTH
  // directions, so neither a new vendor import nor a stale entry here can pass unnoticed.
  const SOLIDITY_SOURCE_PACKAGES = [
    "@openzeppelin/contracts",
    "@openzeppelin/contracts-upgradeable",
    "@chainlink/contracts",
    "@safe-global/safe-contracts",
  ];

  /**
   * ANCHORED, and that matters (issue #1039).
   *
   * The original was `/^\d+\.\d+\.\d+/` — unanchored, so it matched a PREFIX. `"1.3.0 - 1.5.0"`
   * (a hyphen range spanning three minors) and `"1.3.0 || ^2.0.0"` (an explicit alternative major)
   * both passed a test whose entire purpose is to reject exactly those. Measured on a mutated copy
   * of package.json: both forms → 5 passing.
   *
   * This is the full semver grammar for a SINGLE version — major.minor.patch with optional
   * prerelease and build metadata — anchored at both ends, so anything npm would treat as a range
   * (`^`, `~`, `x`, `>=`, `-`, `||`, `*`, `latest`, `npm:`, `file:`, `git+…`) is rejected.
   *
   * The `semver` package would express this more legibly, but it is NOT declared in the root
   * manifest (verified: absent from dependencies and devDependencies — it is only present as a
   * hoisted transitive of other packages). Importing it here would make `npm run check:deps`
   * report a phantom dependency for the root unit, i.e. fixing one gate by breaking another.
   * A regex with no dependency is the right trade at this size.
   */
  const EXACT_VERSION =
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

  it("the documented package list matches what contracts/ actually imports", function () {
    const imported = solidityImportPackages();
    const documented = new Set(SOLIDITY_SOURCE_PACKAGES);

    const undocumented = [...imported.keys()].filter((p) => !documented.has(p));
    const stale = SOLIDITY_SOURCE_PACKAGES.filter((p) => !imported.has(p));

    expect(
      undocumented,
      "contracts/ imports Solidity source from package(s) missing from SOLIDITY_SOURCE_PACKAGES, so " +
        "nothing checks how their version is pinned:\n  " +
        undocumented.map((p) => `${p}  (e.g. ${imported.get(p)})`).join("\n  "),
    ).to.deep.equal([]);

    expect(
      stale,
      "SOLIDITY_SOURCE_PACKAGES names package(s) no contract imports any more. Delete them — a stale " +
        `entry makes the gate look broader than it is:\n  ${stale.join("\n  ")}`,
    ).to.deep.equal([]);
  });

  it("declares an exact version at the ROOT for every package that compiles into our bytecode", function () {
    // Read from disk rather than `require`, so a mutated copy can be diffed against this same test.
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const imported = solidityImportPackages();

    /*
     * UNDECLARED IS A FAILURE, NOT A PASS (issue #1039).
     *
     * The original filter was `range !== undefined && !EXACT.test(range)` — it skipped any package
     * the root manifest did not declare at all. So it caught "declared loosely" and missed "not
     * declared", which is the strictly worse condition and the one a workspace conversion actually
     * produces: move a Solidity-source dependency into a member's manifest, or let it arrive
     * transitively, and the version compiling into deployed bytecode becomes an install-time
     * artifact with this gate still green. Measured: deleting `@chainlink/contracts` from a mutated
     * package.json → 5 passing.
     *
     * The ROOT manifest specifically: contracts/ compiles in the root project, so a declaration in
     * a workspace member's manifest does not pin what solc reads. (`npm run check:deps` separately
     * fails if two manifests declare disagreeing ranges for the same package.)
     */
    const undeclared = [...imported.keys()].filter((name) => declared[name] === undefined);
    const floating = [...imported.keys()]
      .filter((name) => declared[name] !== undefined && !EXACT_VERSION.test(String(declared[name]).trim()))
      .map((name) => `${name}@${declared[name]}`);

    expect(
      undeclared,
      "These contribute Solidity source to the compile but the ROOT manifest does not declare them " +
        "at all, so the version that produces our bytecode is whatever the install happens to hoist:\n  " +
        undeclared.join("\n  "),
    ).to.deep.equal([]);

    expect(
      floating,
      "These contribute Solidity source but declare a floating range, so the bytecode they produce " +
        "depends on when the lockfile was last resolved rather than on this repo:\n  " +
        floating.join("\n  "),
    ).to.deep.equal([]);
  });
});

/**
 * Spec 075 / issue #1039 — a per-file compiler override must describe source that is actually
 * COMPILED.
 *
 * Eight of the 38 overrides named source that had not been in the compilation for months: the
 * Semaphore V4 self-deploy closure, dropped from the pools design by spec 034 along with
 * `contracts/pools/SemaphoreDeploy.sol` itself. Hardhat silently ignores an override that matches
 * no source file, so they cost nothing at build time and read, to anyone auditing the config, as
 * live decisions about how deployed bytecode is produced. Two of the three packages involved
 * (`@zk-kit/lean-imt.sol`, `poseidon-solidity`) were not even root dependencies.
 *
 * File existence alone would NOT have caught them — the packages are still installed transitively,
 * so the .sol files are on disk. The property that distinguishes live from dead is whether the
 * override's package is one contracts/ imports.
 */
describe("Compiler overrides target source that is actually compiled (issue #1039)", function () {
  it("every per-file override names a real file in the compile graph", function () {
    const overrides = Object.keys(hre.userConfig.solidity.overrides || {});
    expect(overrides, "expected at least one per-file override").to.have.length.greaterThan(0);

    const imported = solidityImportPackages();
    const dead = [];

    for (const key of overrides) {
      if (key.startsWith("contracts/")) {
        // First-party: the file must exist. `contracts/pools/SemaphoreDeploy.sol` did not.
        if (!fs.existsSync(path.join(REPO_ROOT, key))) {
          dead.push(`${key}  — no such file in contracts/`);
        }
        continue;
      }
      // Third-party: the package must be one contracts/ imports, AND the file must exist.
      const pkg = key.startsWith("@") ? key.split("/").slice(0, 2).join("/") : key.split("/")[0];
      if (!imported.has(pkg)) {
        dead.push(`${key}  — nothing under contracts/ imports ${pkg}, so this file is never compiled`);
        continue;
      }
      if (!resolveDependencyFile(key)) {
        dead.push(`${key}  — package ${pkg} is imported but this file does not exist in it`);
      }
    }

    expect(
      dead,
      "Dead compiler override(s). Hardhat ignores an override that matches no source file, so these " +
        "are invisible at build time while reading as live compiler decisions. DELETE them rather " +
        "than allowlisting them:\n  " +
        dead.join("\n  "),
    ).to.deep.equal([]);
  });
});

/**
 * Every external package imported by a .sol file under `contracts/`, mapped to one importing file
 * (for the failure message). Relative imports are skipped; `contracts-archive/` is not scanned
 * because it is reference-only and never compiled.
 */
function solidityImportPackages() {
  const found = new Map();
  const IMPORT_RE = /^\s*import\s+[^;]*?["']([^"']+)["']/gm;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(abs);
      } else if (entry.name.endsWith(".sol")) {
        const src = fs.readFileSync(abs, "utf8");
        for (const m of src.matchAll(IMPORT_RE)) {
          const spec = m[1];
          if (spec.startsWith(".") || spec.startsWith("/")) continue;
          const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
          if (!found.has(pkg)) found.set(pkg, path.relative(REPO_ROOT, abs));
        }
      }
    }
  };

  walk(path.join(REPO_ROOT, "contracts"));
  return found;
}

/** A dependency-relative .sol path (`@scope/pkg/a/b.sol`) → absolute path, or null if absent. */
function resolveDependencyFile(spec) {
  const direct = path.join(REPO_ROOT, "node_modules", spec);
  if (fs.existsSync(direct)) return direct;
  // Fall back to Node resolution for a nested/hoisted-elsewhere install.
  const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  const rest = spec.slice(pkg.length + 1);
  try {
    const base = path.dirname(require.resolve(`${pkg}/package.json`, { paths: [REPO_ROOT] }));
    const full = path.join(base, rest);
    return fs.existsSync(full) ? full : null;
  } catch {
    return null;
  }
}
