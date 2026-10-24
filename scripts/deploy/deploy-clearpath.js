/**
 * Targeted spec-030 deploy: add the ClearPath contracts to an ALREADY-deployed network WITHOUT
 * touching existing core contracts. Reuses the network's recorded MembershipManager + SanctionsGuard and
 * APPENDS the new addresses to its `deployments/<net>-chain<id>-v2.json` record (never overwrites).
 *
 * TWO PILLARS, TWO CHAIN SETS — and the difference is the whole point of this script.
 *
 *   Pillar B — `ExternalDAORegistry` (register/track DAOs deployed elsewhere). Imports only the
 *   `IGovernor` INTERFACE, so it is paris-safe and deploys on EVERY supported chain, ETC 61 and
 *   Mordor 63 included.
 *
 *   Pillar A — `StandardDAOFactory` + its three creation-code modules (launch a native standard DAO).
 *   CANCUN-ONLY. OpenZeppelin 5.4.0's `Governor` reaches `utils/Bytes.sol`, which uses the `mcopy`
 *   opcode, and no compiler flag emulates it. The maintainer's decision on issue #1268 is to take the
 *   LATEST OZ Governor and DROP pre-Cancun chain support for this contract, so ETC 61 and Mordor 63 do
 *   not get native DAO creation. That is an EXCLUSION BY DECISION, not a deferral — nothing is pending
 *   for those chains, and this script skips them by name rather than silently doing less.
 *   (Superseding the 2026-06-24 note that deferred pillar A entirely.)
 *
 *   GAS_PRICE_WEI=100000000000 npx hardhat run scripts/deploy/deploy-clearpath.js --network mordor
 *   npx hardhat run scripts/deploy/deploy-clearpath.js --network amoy
 *   npx hardhat run scripts/deploy/deploy-clearpath.js --network polygon
 *
 * Then: npm run sync:frontend-contracts  (frontend picks up externalDAORegistry + standardDaoFactory).
 */
const hre = require("hardhat");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const { saveDeployment, getDeploymentFilename } = require("./lib/helpers");
const { deployProxy } = require("./lib/upgradeable");

/**
 * Chains whose EVM answers `mcopy`, i.e. where pillar A can exist at all.
 *
 * AN ALLOWLIST, DELIBERATELY, not "everything except 61 and 63". A denylist opts every future chain
 * in by default and would put an undeployable factory on the next pre-Cancun network somebody adds;
 * this way an unlisted chain refuses and says what to check. Same reasoning as `SWAP_CHAIN_IDS` in
 * frontend/src/config/networks.js.
 */
const CANCUN_CHAIN_IDS = new Set([
  1, // Ethereum
  10, // Optimism
  137, // Polygon
  8453, // Base
  42161, // Arbitrum One
  80002, // Polygon Amoy
  11155111, // Sepolia
  560048, // Hoodi
  1337, // local hardhat node
]);

/** Chains excluded on purpose, with the reason the operator should see printed. */
const PRE_CANCUN_CHAIN_IDS = new Map([
  [61, "Ethereum Classic — pre-Cancun EVM: no MCOPY, so the OZ 5.4.0 Governor cannot be deployed"],
  [63, "Mordor (ETC testnet) — pre-Cancun EVM: same reason as ETC 61"],
]);

async function main() {
  const network = await ethers.provider.getNetwork();
  const networkName = hre.network.name;
  const chainId = Number(network.chainId);
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("=".repeat(60));
  console.log("ClearPath (spec 030) — targeted deploy");
  console.log("=".repeat(60));
  console.log(`Network:  ${networkName} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)}`);

  const filename = getDeploymentFilename(network, "v2");
  const filepath = path.join(process.cwd(), "deployments", filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`No existing deployment record at deployments/${filename}. Run the core deploy first.`);
  }
  const record = JSON.parse(fs.readFileSync(filepath, "utf8"));
  const contracts = record.contracts || (record.contracts = {});

  const membershipManager = contracts.membershipManager;
  if (!membershipManager || !ethers.isAddress(membershipManager)) {
    throw new Error(`No membershipManager in deployments/${filename}; cannot wire ClearPath tier gating.`);
  }
  console.log(`Reusing MembershipManager: ${membershipManager}`);

  let touched = false;

  // ── Pillar B: ExternalDAORegistry (every chain) ────────────────────────────────────────────────
  if (contracts.externalDAORegistry) {
    console.log(`\n⚠️  externalDAORegistry already recorded (${contracts.externalDAORegistry}). To change logic,`);
    console.log(`   run an in-place upgrade (lib/upgradeable.js upgradeProxy), not this script. Skipping.`);
  } else {
    console.log("\nDeploying ExternalDAORegistry behind a UUPS proxy...");
    const proxy = await deployProxy({
      name: "ExternalDAORegistry",
      initArgs: [deployer.address, membershipManager],
    });
    contracts.externalDAORegistry = proxy.proxy;
    contracts.externalDAORegistryImpl = proxy.implementation;
    record.constructorArgs = record.constructorArgs || {};
    record.constructorArgs.externalDAORegistryImpl = [];
    touched = true;
  }

  // ── Pillar A: StandardDAOFactory (Cancun chains only, issue #1268) ─────────────────────────────
  await deployStandardDAOFactory({ chainId, contracts, record, deployer, membershipManager, filename })
    .then((did) => {
      touched = touched || did;
    });

  if (!touched) {
    console.log("\nNothing to do — every ClearPath contract this chain can host is already recorded.");
    return;
  }

  record.clearpathDeployedAt = new Date().toISOString();
  saveDeployment(filename, record);

  console.log("\n" + "=".repeat(60));
  console.log("Appended to deployments/" + filename);
  console.log("=".repeat(60));
  for (const key of [
    "externalDAORegistry",
    "externalDAORegistryImpl",
    "standardDaoFactory",
    "standardDaoFactoryImpl",
    "standardDaoTimelockDeployer",
    "standardDaoTokenDeployer",
    "standardDaoGovernorDeployer",
  ]) {
    if (contracts[key]) console.log(`  ${key.padEnd(28)} ${contracts[key]}`);
  }
  console.log(`\nNext: npm run sync:frontend-contracts (frontend reads the addresses)`);
}

/**
 * Deploy pillar A on a Cancun chain, or explain why it is being skipped. Returns whether anything was
 * added to the record.
 *
 * The factory needs the SANCTIONS GUARD as well as the membership manager: creation is a gated action
 * (spec 030 US1, acceptance scenario 4), and `checkBlocked` is fail-closed, so an absent guard would
 * mean an ungated creation path rather than a slightly weaker one. A chain with no recorded guard
 * refuses rather than deploying a factory with screening wired to nothing.
 */
async function deployStandardDAOFactory({ chainId, contracts, record, deployer, membershipManager, filename }) {
  if (PRE_CANCUN_CHAIN_IDS.has(chainId)) {
    console.log(`\n⏭  StandardDAOFactory SKIPPED on chain ${chainId} — ${PRE_CANCUN_CHAIN_IDS.get(chainId)}.`);
    console.log("   This is the issue-#1268 decision, not a deferral: native DAO creation is not coming");
    console.log("   to this chain, and the app hides that surface here and says so. Pillar B is unaffected.");
    return false;
  }
  if (!CANCUN_CHAIN_IDS.has(chainId)) {
    console.log(`\n⏭  StandardDAOFactory SKIPPED on chain ${chainId} — not in CANCUN_CHAIN_IDS.`);
    console.log("   Confirm the chain's EVM supports MCOPY, then add it to that set in this script.");
    console.log("   Deploying blind would either revert or, worse, succeed into an unusable contract.");
    return false;
  }
  if (contracts.standardDaoFactory) {
    console.log(`\n⚠️  standardDaoFactory already recorded (${contracts.standardDaoFactory}). To change logic,`);
    console.log(`   run an in-place upgrade (lib/upgradeable.js upgradeProxy), not this script. Skipping.`);
    return false;
  }

  const sanctionsGuard = contracts.sanctionsGuard;
  if (!sanctionsGuard || !ethers.isAddress(sanctionsGuard)) {
    throw new Error(
      `No sanctionsGuard in deployments/${filename}; StandardDAOFactory screens every creation and ` +
        "refuses to deploy without one.",
    );
  }
  console.log(`Reusing SanctionsGuard:    ${sanctionsGuard}`);

  // The three creation-code modules. They exist because inlining `new Governor/Timelock/Token` put the
  // factory at 44,706 bytes against EIP-170's 24,576 — see contracts/clearpath/StandardDAODeployers.sol.
  // They are plain, stateless, permissionless deploys; they hold nothing and confer nothing.
  console.log("\nDeploying the StandardDAO creation-code modules...");
  const modules = {};
  for (const [key, name] of [
    ["standardDaoTimelockDeployer", "StandardDAOTimelockDeployer"],
    ["standardDaoTokenDeployer", "StandardDAOTokenDeployer"],
    ["standardDaoGovernorDeployer", "StandardDAOGovernorDeployer"],
  ]) {
    const Factory = await ethers.getContractFactory(name);
    const instance = await Factory.deploy();
    await instance.waitForDeployment();
    modules[key] = await instance.getAddress();
    console.log(`  ✓ ${name}: ${modules[key]}`);
  }

  console.log("\nDeploying StandardDAOFactory behind a UUPS proxy...");
  const proxy = await deployProxy({
    name: "StandardDAOFactory",
    initArgs: [
      deployer.address,
      membershipManager,
      sanctionsGuard,
      modules.standardDaoTimelockDeployer,
      modules.standardDaoTokenDeployer,
      modules.standardDaoGovernorDeployer,
    ],
  });

  contracts.standardDaoFactory = proxy.proxy;
  contracts.standardDaoFactoryImpl = proxy.implementation;
  Object.assign(contracts, modules);
  record.constructorArgs = record.constructorArgs || {};
  record.constructorArgs.standardDaoFactoryImpl = [];
  record.constructorArgs.standardDaoTimelockDeployer = [];
  record.constructorArgs.standardDaoTokenDeployer = [];
  record.constructorArgs.standardDaoGovernorDeployer = [];
  record.standardDaoFactoryDeployedAt = new Date().toISOString();

  console.log("\n  NOTE: the created DAOs are IMMUTABLE — this proxy governs creation, never a live DAO.");
  console.log("  DEFAULT_ADMIN_ROLE/UPGRADER_ROLE sit on the deploy key until the Safe handoff (issue #966).");
  return true;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
