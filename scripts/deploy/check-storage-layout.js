/**
 * Storage-layout & upgrade-safety gate (spec 025, FR-010/SC-005).
 *
 * Two independent checks per upgradeable contract:
 *
 *   1. UNSAFE PATTERNS in the freshly compiled implementation — constructor state initialisation,
 *      `delegatecall`, `selfdestruct`, missing `_disableInitializers`, and the rest of OpenZeppelin's
 *      implementation validations. Needs nothing but the compiled artifact.
 *
 *   2. APPEND-ONLY COMPATIBILITY against every implementation that is actually LIVE — for every
 *      chain the repo has a deployment record for, not just whichever network hardhat happens to be
 *      pointed at. This is the check that blocks a state-corrupting upgrade before it is applied.
 *
 * ── WHY THIS DOES NOT USE `upgrades.validateUpgrade(deployedAddress, Factory)` ────────────────────
 * It used to, and the result was a gate that reported success without checking anything.
 *
 * That call resolves the deployed layout through the network manifest for the CONNECTED chain, so it
 * only ever works when hardhat is pointed at the chain the implementation lives on. `package.json`
 * defines the script with no `--network` and CI runs it bare, which means it ran against the default
 * hardhat network (chain 1337) — where `deployments/hardhat-chain1337-v2.json` records no
 * implementations at all. Every contract fell through to the "no deployed impl to diff against"
 * branch and printed a ✓. Verified by mutation: inserting a slot above `_apps` in MiniAppRegistry and
 * shrinking its `__gap` — precisely the corruption this gate exists to catch — passed the literal CI
 * command with exit 0, while the same command with `--network polygon` correctly failed.
 *
 * So the comparison is done directly instead. Both sides are available OFFLINE: the compiled layout
 * comes from hardhat's own build info, and each live implementation's layout is already committed to
 * `.openzeppelin/<network>.json`. Nothing here needs an RPC endpoint, a network flag, or a secret,
 * which is the only way a gate like this survives contact with CI.
 *
 * ── UNVERIFIABLE IMPLEMENTATIONS ─────────────────────────────────────────────────────────────────
 * An implementation recorded in `deployments/` with no layout in any `.openzeppelin/` manifest cannot
 * be diffed against, and saying nothing about it would be the same lie in a new place. Each one must
 * be declared in `KNOWN_UNVERIFIABLE` with a reason; an undeclared one FAILS. The declared ones are
 * printed on every run so they stay visible rather than becoming permanent silence.
 *
 * Usage: `npm run check:storage-layout` — no network flag needed or used.
 */
const { ethers, upgrades } = require("hardhat");
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const core = require("@openzeppelin/upgrades-core");
const { readValidations } = require("@openzeppelin/hardhat-upgrades/dist/utils/validations");

// Upgradeable contracts and the deployments key holding their PROXY address (impl is `<key>Impl`).
const UPGRADEABLE_CONTRACTS = [
  { name: "WagerRegistry", deploymentsKey: "wagerRegistry" },
  { name: "MembershipManager", deploymentsKey: "membershipManager" }, // spec 027 — second adopter of UUPSManaged
  { name: "TokenFactory", deploymentsKey: "tokenFactory" }, // spec 028 — token-issuance authority/registry
  { name: "ExternalDAORegistry", deploymentsKey: "externalDAORegistry" }, // spec 030 — ClearPath external-DAO registry
  { name: "StandardDAOFactory", deploymentsKey: "standardDaoFactory" }, // spec 030 pillar A — native standard-DAO factory (the DAOs it creates are immutable and have no layout to gate)
  { name: "WagerPoolFactory", deploymentsKey: "wagerPoolFactory" }, // spec 034 — WagerPools factory (address-based)
  { name: "FundingPoolFactory", deploymentsKey: "fundingPoolFactory" }, // spec 103 — funding pools factory (sibling of the wager-pool factory)
  { name: "CallsignRegistry", deploymentsKey: "callsignRegistry" }, // spec 054 — in-house %callsign naming registry
  { name: "FeeRouter", deploymentsKey: "feeRouter" }, // spec 060 — unified platform-fee registry + wrapper
  { name: "StakingRouter", deploymentsKey: "stakingRouter" }, // spec 066 — staking control surface + liquid fee router
  { name: "BridgeRouter", deploymentsKey: "bridgeRouter" }, // spec 067 — cross-chain bridge control surface + fee router
  { name: "LiquidityRouter", deploymentsKey: "liquidityRouter" }, // spec 067 — liquidity-supply control surface + fee router
  { name: "MiniAppRegistry", deploymentsKey: "miniAppRegistry" }, // spec 073 — mini-app catalog + curation authority
];

/**
 * Live implementations with no committed layout, and why.
 *
 * These are real coverage gaps, not exemptions: an upgrade that corrupts one of these proxies would
 * not be caught here OR at deploy time (`upgrades.upgradeProxy` validates against the same manifest
 * this reads). Listing them makes the gap explicit and, more importantly, makes a NEW one fail —
 * which is the property that stops the set from quietly growing.
 *
 * The Ethereum-mainnet pair share a cause: hardhat cannot deploy contracts on L1 in this repo (the
 * transaction mines but the script dies on an empty `value.to`), so both were deployed with the
 * plain-ethers `scripts/ops/*-direct.js` path, which never goes through hardhat-upgrades and so never
 * records a manifest entry. Fixing that means re-recording the layout, not re-deploying.
 */
const KNOWN_UNVERIFIABLE = [
  {
    key: "feeRouter",
    chainId: 1,
    impl: "0x5cCd55D62Ce7Df730c39543B332dD8d6054B5d00",
    reason: "Ethereum mainnet — deployed via scripts/ops/*-direct.js (hardhat cannot deploy on L1), so hardhat-upgrades never wrote a manifest entry",
  },
  {
    key: "bridgeRouter",
    chainId: 1,
    impl: "0xcA277Cc3485Da12771d6171a9D0A894B8DD159f8",
    reason: "Ethereum mainnet — same direct-deploy path as feeRouter above",
  },
  {
    key: "liquidityRouter",
    chainId: 1,
    impl: "0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5",
    reason:
      "Ethereum mainnet — same direct-deploy path. Note the address collides with the BridgeRouter implementation on Arbitrum/Base/Optimism; the mainnet proxy 0x1afcAC19… is genuinely LiquidityRouter (verified live: positionManager() returns the Uniswap NFPM 0xC36442b4…)",
  },
  {
    key: "wagerPoolFactory",
    chainId: 137,
    impl: "0x754d8aa4785Ec4bEE7c921f8d032D5E3a78d9308",
    reason: "Polygon — predates the committed-manifest convention; no layout was recorded at deploy time",
  },
];

const isUnverifiable = (key, impl, chainId) =>
  KNOWN_UNVERIFIABLE.some(
    (u) =>
      u.key === key &&
      u.chainId === chainId &&
      u.impl.toLowerCase() === String(impl).toLowerCase(),
  );

/**
 * OpenZeppelin manifest filename for a chain id.
 *
 * ── WHY THE LOOKUP IS CHAIN-SCOPED, AND NOT BY ADDRESS ───────────────────────────────────────────
 * The first version of this rewrite searched every manifest for the implementation address and used
 * whichever layout it found. That is wrong, and it produced a false positive immediately: the
 * Ethereum-mainnet `liquidityRouterImpl` is `0x41ba6bca…`, and that SAME address on Arbitrum, Base
 * and Optimism holds BridgeRouter. The gate compared the compiled LiquidityRouter against
 * BridgeRouter's layout and reported the mainnet proxy as corrupt.
 *
 * It is not — I read the live proxy: `positionManager()` returns the real Uniswap NFPM
 * (0xC36442b4…), and the BridgeRouter proxy beside it answers `spokePool()`. An address identifies
 * a contract only WITHIN one chain, and this repo's estate happens to contain a collision across
 * chains. Reading the layout from the manifest for the recording chain removes the ambiguity.
 *
 * OZ names manifests for known networks and falls back to `unknown-<chainId>` for the rest.
 */
const OZ_MANIFEST_BY_CHAIN = {
  1: "mainnet.json",
  10: "optimism.json",
  137: "polygon.json",
  8453: "base.json",
  42161: "arbitrum-one.json",
};
const ozManifestName = (chainId) => OZ_MANIFEST_BY_CHAIN[chainId] || `unknown-${chainId}.json`;

/** `<network>-chain<id>-v2.json` → the chain id it records, or null if the name says nothing. */
function chainIdFromDeploymentsFile(file) {
  const m = file.match(/chain(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Ephemeral local chains, skipped (issue #1039).
 *
 * The filename filter accepts ANY `deployments/*.json` naming a chain id, which included a
 * developer's local anvil/hardhat record. Those chains are wiped and redeployed constantly and
 * hardhat-upgrades writes no manifest for them, so every implementation they record is
 * undiffable — and the gate is required to FAIL on an undiffable implementation. Net effect: this
 * gate exited 1 on a clean checkout as soon as anyone ran a local deploy. Measured on this tree,
 * with an untracked `deployments/localhost-chain1337-v2.json` present: 3 failures
 * (WagerRegistry, MembershipManager, TokenFactory), exit 1, nothing actually wrong.
 *
 * A gate that fails for a reason unrelated to what it checks gets ignored, which is how a real
 * failure gets waved through. Local chains carry no upgrade-safety meaning: there is no live proxy
 * whose state a bad layout could corrupt. Skip them, and say so on the run.
 */
const LOCAL_CHAIN_IDS = new Set([1337, 31337]);

/**
 * The estate this repo is KNOWN to have deployed, per chain.
 *
 *   records — implementation entries `deployments/` records for that chain
 *   diffed  — how many of those were actually compared against a committed layout
 *
 * ── WHY A FLOOR, AND NOT JUST `compared === 0` (issue #1039) ─────────────────────────────────────
 * The zero-comparison guard below was written against exactly one threat — everything disappearing
 * — while its own comment named threats that are PARTIAL by nature: "a bad path join, a renamed
 * record, a build system that relocates them". Measured: deleting 13 of the 14 deployment records
 * left the gate green at `compared = 7` (of 26). Losing 73% of the estate's coverage looked
 * identical to a pass, because the only question asked was "more than nothing?".
 *
 * Two floors rather than one, because they catch different regressions:
 *   · `records`  drops when deployment records go missing or stop being found — the relocation
 *                threat, and the one that leaves proxies silently unchecked.
 *   · `diffed`   drops when verification is weakened without records moving — most realistically by
 *                adding a KNOWN_UNVERIFIABLE entry to silence a failure rather than fix it.
 *
 * They are floors (`>=`), so deploying MORE never fails the gate. Deploying to a brand-new chain is
 * reported and requires adding an entry here; that is a deliberate, one-line acknowledgement that
 * the estate grew, not a hurdle.
 */
const EXPECTED_LIVE_IMPLS = {
  1: { records: 3, diffed: 0, label: "Ethereum" }, // all 3 declared unverifiable (direct-deploy path)
  10: { records: 3, diffed: 3, label: "Optimism" },
  63: { records: 7, diffed: 7, label: "Mordor" },
  137: { records: 9, diffed: 8, label: "Polygon" }, // wagerPoolFactory impl is declared unverifiable
  8453: { records: 3, diffed: 3, label: "Base" },
  42161: { records: 3, diffed: 3, label: "Arbitrum" },
  80002: { records: 2, diffed: 2, label: "Amoy" },
};

/**
 * Every implementation this repo records as live, across every chain.
 *
 * Deliberately NOT filtered by the connected network — the whole point is that one run covers the
 * estate. One entry per (chain, address): the same address on two chains is two different
 * implementations to verify, which is exactly the case that broke the first attempt.
 */
function loadRecordedImpls(deploymentsKey, skippedLocal) {
  const dir = path.join(process.cwd(), "deployments");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      continue; // a malformed record is not a layout failure; the deploy scripts own that
    }
    const impl = data[`${deploymentsKey}Impl`] || data.contracts?.[`${deploymentsKey}Impl`];
    if (!impl) continue;
    const chainId = chainIdFromDeploymentsFile(file);
    if (chainId === null) continue;
    if (LOCAL_CHAIN_IDS.has(chainId)) {
      skippedLocal?.add(file.replace(/\.json$/, ""));
      continue;
    }
    out.push({ impl, chainId, where: file.replace(/\.json$/, "") });
  }
  return out;
}

/** chainId -> (lowercased address -> committed storage layout), from `.openzeppelin/`. */
function loadManifestLayouts() {
  const dir = path.join(process.cwd(), ".openzeppelin");
  const byChain = new Map();
  if (!fs.existsSync(dir)) return byChain;
  for (const [chainId, name] of Object.entries(OZ_MANIFEST_BY_CHAIN)) {
    addManifest(dir, name, Number(chainId), byChain);
  }
  for (const file of fs.readdirSync(dir)) {
    const m = file.match(/^unknown-(\d+)\.json$/);
    if (m) addManifest(dir, file, Number(m[1]), byChain);
  }
  return byChain;
}

function addManifest(dir, name, chainId, byChain) {
  const full = path.join(dir, name);
  if (!fs.existsSync(full)) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch {
    return;
  }
  const layouts = byChain.get(chainId) || new Map();
  for (const entry of Object.values(data.impls || {})) {
    if (entry?.address && entry.layout) {
      layouts.set(String(entry.address).toLowerCase(), entry.layout);
    }
  }
  byChain.set(chainId, layouts);
}

/** The freshly compiled storage layout for a contract, straight out of hardhat's build info. */
async function compiledLayout(validations, name) {
  const Factory = await ethers.getContractFactory(name);
  const unlinked = core.getUnlinkedBytecode(validations, Factory.bytecode);
  const version = core.getVersion(unlinked, Factory.bytecode);
  return { Factory, layout: core.getStorageLayout(validations, version) };
}

// Facet pairs sharing ONE proxy's storage (spec 035): the extension facet is delegatecalled from the
// main facet's fallback, so its storage layout MUST be compatible with the main implementation's.
// Validated by treating the facet as if it were an upgrade of the main implementation.
const FACET_PAIRS = [{ main: "WagerRegistry", facet: "WagerRegistryIntents" }];

async function main() {
  let failed = false;
  let compared = 0;
  const unverified = [];
  const skippedLocal = new Set();
  /** chainId -> { records, diffed } actually observed on this run. */
  const observed = new Map();
  const bump = (chainId, field) => {
    const row = observed.get(chainId) || { records: 0, diffed: 0 };
    row[field] += 1;
    observed.set(chainId, row);
  };

  for (const { main: mainName, facet: facetName } of FACET_PAIRS) {
    try {
      const MainFactory = await ethers.getContractFactory(mainName);
      const FacetFactory = await ethers.getContractFactory(facetName);
      // Main → facet: every sequential slot the main facet defines must line up in the extension
      // (both inherit the same storage core; this catches any drift). The reverse direction is NOT
      // validated: the extension additionally carries SignerIntentBase's ERC-7201 namespace, which
      // the main facet legitimately does not declare — that namespace lives at a fixed
      // keccak-derived slot that can never collide with sequential/gap slots.
      await upgrades.validateUpgrade(MainFactory, FacetFactory, { kind: "uups" });
      console.log(`✓ ${mainName} → ${facetName}: facet storage layouts are consistent`);
    } catch (e) {
      failed = true;
      console.error(`✗ ${mainName} ⇄ ${facetName}: ${e.message}`);
    }
  }

  const validations = await readValidations(hre);
  const manifestLayouts = loadManifestLayouts();
  const opts = core.withValidationDefaults({});

  for (const { name, deploymentsKey } of UPGRADEABLE_CONTRACTS) {
    let Factory;
    let updated;
    try {
      ({ Factory, layout: updated } = await compiledLayout(validations, name));
      await upgrades.validateImplementation(Factory, { kind: "uups" });
    } catch (e) {
      failed = true;
      console.error(`✗ ${name}: ${e.message}`);
      continue;
    }

    const recorded = loadRecordedImpls(deploymentsKey, skippedLocal);
    if (recorded.length === 0) {
      console.log(`· ${name}: implementation is upgrade-safe; not deployed anywhere yet`);
      continue;
    }

    for (const { impl, chainId, where } of recorded) {
      bump(chainId, "records");
      const deployed = manifestLayouts.get(chainId)?.get(String(impl).toLowerCase());
      if (!deployed) {
        if (isUnverifiable(deploymentsKey, impl, chainId)) {
          unverified.push({ name, impl, chainId, where });
        } else {
          failed = true;
          console.error(
            `✗ ${name}: live impl ${impl} (${where}) has NO layout in .openzeppelin/${ozManifestName(chainId)} — ` +
              `its storage cannot be verified. Record the layout, or declare it in KNOWN_UNVERIFIABLE with a reason.`,
          );
        }
        continue;
      }
      try {
        core.assertStorageUpgradeSafe(deployed, updated, opts);
        compared += 1;
        bump(chainId, "diffed");
        console.log(`✓ ${name}: storage-compatible with live impl ${impl} (${where})`);
      } catch (e) {
        failed = true;
        console.error(`✗ ${name}: INCOMPATIBLE with live impl ${impl} (${where})\n  ${e.message}`);
      }
    }
  }

  if (unverified.length > 0) {
    // Printed every run, never folded into the pass line: a declared gap that stops being mentioned
    // becomes an undeclared one.
    console.log(`\n⚠ ${unverified.length} live implementation(s) could not be diffed (declared in KNOWN_UNVERIFIABLE):`);
    for (const u of unverified) {
      const reason = KNOWN_UNVERIFIABLE.find(
        (k) => k.chainId === u.chainId && k.impl.toLowerCase() === String(u.impl).toLowerCase(),
      )?.reason;
      console.log(`  · ${u.name} ${u.impl} (${u.where})\n      ${reason}`);
    }
  }

  if (skippedLocal.size > 0) {
    console.log(
      `\n· skipped ${skippedLocal.size} local-chain deployment record(s) — ephemeral dev chains carry no ` +
        `live proxy to protect: ${[...skippedLocal].join(", ")}`,
    );
  }

  // ── COVERAGE FLOORS: comparing SOME of the estate is not a pass either (spec 075, FR-004) ──────
  //
  // The original guard fired only at `compared === 0`. That was the exact failure recorded in the
  // header — every contract fell through "no deployed impl to diff against", the script printed a
  // checkmark, and a deliberately corrupted __gap sailed through — but the fix stopped one step
  // short: a PARTIAL loss of the estate still reported success. Measured with 13 of 14 deployment
  // records removed: green, at `compared = 7` instead of 26.
  const shortfalls = [];
  for (const [chainIdStr, want] of Object.entries(EXPECTED_LIVE_IMPLS)) {
    const chainId = Number(chainIdStr);
    const got = observed.get(chainId) || { records: 0, diffed: 0 };
    if (got.records < want.records) {
      shortfalls.push(
        `${want.label} (chain ${chainId}): found ${got.records} recorded implementation(s), expected at least ${want.records}`,
      );
    }
    if (got.diffed < want.diffed) {
      shortfalls.push(
        `${want.label} (chain ${chainId}): diffed ${got.diffed} implementation(s) against a committed layout, expected at least ${want.diffed}`,
      );
    }
  }

  const newChains = [...observed.keys()].filter((c) => !EXPECTED_LIVE_IMPLS[c]);
  if (newChains.length > 0) {
    console.log(
      `\n· ${newChains.length} chain(s) carry deployment records but no entry in EXPECTED_LIVE_IMPLS: ` +
        `${newChains.join(", ")}. Add them so their coverage is held from now on.`,
    );
  }

  if (shortfalls.length > 0) {
    failed = true;
    console.error(`\n::error::Storage-layout coverage SHRANK on ${shortfalls.length} count(s):`);
    for (const s of shortfalls) console.error(`  · ${s}`);
    console.error(
      "\n  This gate compares compiled layouts against DEPLOYED ones; comparing fewer than the estate\n" +
        "  is known to contain is not a pass, it is a partial abstention that looks identical to one.\n" +
        "  Most likely: deployments/*.json or .openzeppelin/*.json moved, were renamed, or stopped\n" +
        "  being found (they are committed, irreproducible state — see specs/075-monorepo-workspaces/).\n" +
        "  A drop in `diffed` alone usually means a KNOWN_UNVERIFIABLE entry was added to silence a\n" +
        "  failure instead of recording the layout.\n" +
        "  If an estate change is deliberate (a proxy genuinely retired), lower EXPECTED_LIVE_IMPLS in\n" +
        "  this file in the same commit — explicitly, and reviewably.",
    );
  }

  if (failed) {
    console.error("\nStorage-layout / upgrade-safety check FAILED.");
    process.exit(1);
  }

  console.log(
    `\nAll upgradeable contracts passed. ${compared} live implementation(s) diffed for append-only compatibility` +
      (unverified.length ? `; ${unverified.length} declared unverifiable (above).` : ".") +
      `\nCoverage floors met on ${Object.keys(EXPECTED_LIVE_IMPLS).length} chains.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
