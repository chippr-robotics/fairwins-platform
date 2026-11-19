/**
 * Targeted spec-103 deploy: add the funding-pool factory (+ its immutable FundingPool clone template) to
 * an ALREADY-deployed network WITHOUT touching the existing core contracts. Reuses the network's recorded
 * SanctionsGuard (and, when enabled, MembershipManager) and APPENDS the new addresses to its
 * `deployments/<net>-chain<id>-v2.json` record (never overwrites the live UUPS proxies).
 *
 * A sibling of deploy-wager-pool-factory.js (spec 034) — same launch sequence (Mordor, then Polygon), same
 * compliance posture, same env knobs, same per-network USDC table (scripts/deploy/lib/wagerPoolConfig.js):
 *   GAS_PRICE_WEI=100000000000 npx hardhat run scripts/deploy/deploy-funding-pool-factory.js --network mordor
 *   GAS_PRICE_WEI=30000000000  npx hardhat run scripts/deploy/deploy-funding-pool-factory.js --network polygon
 *
 * Then: npm run sync:frontend-contracts -- --network <name> --chainId <id>  (frontend reads the address).
 *
 * Locally it is APPENDED to `setup:e2e` / `setup:local` (after every other deploy) so no existing
 * nonce-derived address moves (#1289) — the factory proxy is a plain-CREATE deploy.
 *
 * Config / env (identical names to the wager-pool script so one operator runbook covers both):
 *   - POOL_ENABLE_MEMBERSHIP=1 | POOL_MEMBERSHIP_MANAGER=0x…  membership gate (POOL_PARTICIPANT_ROLE), off by default
 *   - POOL_SCREENING_REQUIRED=1|0   defaults true on mainnets (137, 61), false on testnets/localhost
 *   - POOL_USDC_<chainId>            escrow token to allow-list (FR-024 analogue)
 *   - POOL_ADMIN=0x… | deployer | safe   who gets DEFAULT_ADMIN_ROLE (default: the chain's admin Safe;
 *                                        `deployer` on localhost/hardhat, which host no Safe)
 *
 * ADMIN IS THE SAFE BY DEFAULT, NOT THE DEPLOYER (issue #966). Every earlier factory was initialised
 * with `deployer.address` and then handed over afterwards, which is how the estate accumulated 79
 * (contract, role) pairs still held by a superseded Safe and a deploy key that is now DISABLED in
 * Secret Manager. Initialising with the Safe skips the handoff entirely: there is no window in which
 * a hot key is the admin, and nothing to renounce later.
 *
 * THE COST, STATED PLAINLY: `setAllowedToken` is onlyRole(DEFAULT_ADMIN_ROLE), so when the admin is
 * the Safe THIS SCRIPT CANNOT ALLOW-LIST THE ESCROW TOKEN. It prints the exact call for the Safe to
 * execute instead. Until that lands, `createPool` reverts `TokenNotAllowed` on a screened network —
 * a closed, honest failure (the feature is simply not live yet), never a pool that takes funds it
 * cannot handle. On localhost/hardhat the default is the deployer instead: the local E2E chain reports
 * chainId 80002, so the admin-safe.json lookup would name Amoy's Safe — which has no bytecode there and
 * would trip the guard below on every `setup:e2e`. POOL_ADMIN=safe forces the Safe path anyway.
 */
const hre = require("hardhat");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const { SALT_PREFIXES } = require("./lib/constants");
const {
  generateSalt,
  deployDeterministic,
  ensureSingletonFactory,
  saveDeployment,
  getDeploymentFilename,
} = require("./lib/helpers");
const { deployProxy } = require("./lib/upgradeable");
const { getWagerPoolConfig } = require("./lib/wagerPoolConfig");

const MAINNETS = new Set([137, 61]);

async function main() {
  const network = await ethers.provider.getNetwork();
  const networkName = hre.network.name;
  const chainId = Number(network.chainId);
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("=".repeat(60));
  console.log(`Funding pools (spec 103) — targeted append-only deploy`);
  console.log("=".repeat(60));
  console.log(`Network:  ${networkName} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)}`);

  const cfg = getWagerPoolConfig(chainId);
  if (cfg.usdc && !ethers.isAddress(cfg.usdc)) {
    throw new Error(`Funding pools: invalid USDC address for chain ${chainId} in wagerPoolConfig.js: ${cfg.usdc}`);
  }
  console.log(`USDC (escrow token): ${cfg.usdc || "(unset — set POOL_USDC_" + chainId + ")"}`);

  // ---- who will be DEFAULT_ADMIN_ROLE on the new factory ----------------------------------
  let admin;
  let adminIsDeployer = false;
  const isLocalNetwork = networkName === "localhost" || networkName === "hardhat";
  const adminSpec = process.env.POOL_ADMIN || (isLocalNetwork ? "deployer" : "safe");
  if (adminSpec === "deployer") {
    admin = deployer.address;
    adminIsDeployer = true;
  } else if (ethers.isAddress(adminSpec)) {
    admin = ethers.getAddress(adminSpec);
    adminIsDeployer = admin.toLowerCase() === deployer.address.toLowerCase();
  } else {
    const safeFile = path.join(process.cwd(), "deployments", "admin-safe.json");
    if (!fs.existsSync(safeFile)) throw new Error("no deployments/admin-safe.json; pass POOL_ADMIN=0x… or =deployer");
    const entry = JSON.parse(fs.readFileSync(safeFile, "utf8")).chains?.[String(chainId)];
    if (!entry?.address) throw new Error(`admin-safe.json has no Safe for chain ${chainId}; pass POOL_ADMIN=0x…`);
    admin = ethers.getAddress(entry.address);
  }

  // A Safe with no bytecode HERE can never act, and a UUPS factory whose only admin cannot act is
  // permanently unadministrable and permanently un-upgradeable. Same guard as transfer-roles.js.
  if (!adminIsDeployer) {
    const code = await ethers.provider.getCode(admin);
    if (code === "0x") {
      throw new Error(
        `admin ${admin} has NO BYTECODE on chain ${chainId}. Initialising the factory with it would ` +
          `leave it permanently unadministrable. Deploy the Safe here first, or pass POOL_ADMIN=deployer.`,
      );
    }
    console.log(`Admin:    ${admin} (Safe, ${(code.length - 2) / 2} bytes ✓)`);
  } else {
    console.log(`Admin:    ${admin} (DEPLOYER — this factory will need a later handoff, see #966)`);
  }

  const filename = getDeploymentFilename(network, "v2");
  const filepath = path.join(process.cwd(), "deployments", filename);
  if (!fs.existsSync(filepath)) {
    throw new Error(`No existing deployment record at deployments/${filename}. Run the core deploy first.`);
  }
  const record = JSON.parse(fs.readFileSync(filepath, "utf8"));
  const contracts = record.contracts || (record.contracts = {});

  const sanctionsGuard = contracts.sanctionsGuard;
  if (!sanctionsGuard || !ethers.isAddress(sanctionsGuard)) {
    throw new Error(`No sanctionsGuard in deployments/${filename}; funding pools require sanctions screening.`);
  }
  console.log(`SanctionsGuard: ${sanctionsGuard}`);

  let membershipManager = ethers.ZeroAddress;
  if (process.env.POOL_MEMBERSHIP_MANAGER && ethers.isAddress(process.env.POOL_MEMBERSHIP_MANAGER)) {
    membershipManager = process.env.POOL_MEMBERSHIP_MANAGER;
  } else if (process.env.POOL_ENABLE_MEMBERSHIP === "1") {
    if (!contracts.membershipManager || !ethers.isAddress(contracts.membershipManager)) {
      throw new Error(`POOL_ENABLE_MEMBERSHIP=1 but no membershipManager in deployments/${filename}.`);
    }
    membershipManager = contracts.membershipManager;
  }
  const screeningRequired =
    process.env.POOL_SCREENING_REQUIRED != null
      ? process.env.POOL_SCREENING_REQUIRED === "1"
      : MAINNETS.has(chainId);
  console.log(`Membership gate: ${membershipManager === ethers.ZeroAddress ? "OFF (open participation)" : membershipManager}`);
  console.log(`screeningRequired: ${screeningRequired}`);
  if (screeningRequired && membershipManager === ethers.ZeroAddress) {
    throw new Error(
      `screeningRequired=true requires a membership manager. Configure POOL_PARTICIPANT_ROLE tiers then set ` +
        `POOL_ENABLE_MEMBERSHIP=1, or set POOL_SCREENING_REQUIRED=0 for an open testnet launch.`
    );
  }

  if (contracts.fundingPoolFactory) {
    console.log(`\n⚠️  fundingPoolFactory already recorded (${contracts.fundingPoolFactory}). To change logic, run an`);
    console.log(`   in-place upgrade (lib/upgradeable.js upgradeProxy), not this script. Aborting.`);
    return;
  }

  await ensureSingletonFactory();

  // 1) Immutable clone template (deterministic; constructor disables initializers).
  console.log("\nDeploying FundingPool template...");
  const poolImpl = await deployDeterministic(
    "FundingPool",
    [],
    generateSalt(SALT_PREFIXES.V2 + "FundingPool"),
    deployer
  );

  // 2) FundingPoolFactory behind a UUPS proxy, wired to the existing guard(s).
  console.log("\nDeploying FundingPoolFactory behind a UUPS proxy...");
  const proxy = await deployProxy({
    name: "FundingPoolFactory",
    initArgs: [admin, poolImpl.address, sanctionsGuard, membershipManager, screeningRequired],
  });

  // 2b) Allow-list the escrow token. On value-bearing networks createPool is gated on this list.
  //
  // setAllowedToken is onlyRole(DEFAULT_ADMIN_ROLE). When the admin is the Safe, the deployer is not
  // authorised and calling anyway would revert AFTER the proxy is already deployed — a half-finished
  // deploy with a recorded address. So it is not attempted: the call is printed for the Safe.
  if (cfg.usdc && ethers.isAddress(cfg.usdc) && !adminIsDeployer) {
    const data = proxy.contract.interface.encodeFunctionData("setAllowedToken", [cfg.usdc, true]);
    console.log(`\n⚠ ESCROW TOKEN NOT ALLOW-LISTED — the admin is the Safe, not this deployer.`);
    console.log(`  Execute from ${admin}:`);
    console.log(`    to:   ${proxy.proxy}`);
    console.log(`    data: ${data}`);
    console.log(`  Until then createPool reverts TokenNotAllowed. Nothing is broken; the feature is not live.`);
  } else if (cfg.usdc && ethers.isAddress(cfg.usdc)) {
    console.log(`\nAllowlisting escrow token (USDC) ${cfg.usdc}...`);
    const tx = await proxy.contract.setAllowedToken(cfg.usdc, true);
    await tx.wait();
    console.log("  token allowlisted");
  } else if (screeningRequired) {
    console.warn(
      `\nWARNING: screeningRequired=true but POOL_USDC_${chainId} is unset — createPool will revert with ` +
        `TokenNotAllowed until an admin calls setAllowedToken(<usdc>, true).`
    );
  }

  if (typeof deployer.reset === "function") deployer.reset();

  // 3) APPEND to the record (preserve everything already there).
  contracts.fundingPoolFactory = proxy.proxy;
  contracts.fundingPoolFactoryImpl = proxy.implementation;
  contracts.fundingPoolImpl = poolImpl.address;
  record.constructorArgs = record.constructorArgs || {};
  Object.assign(record.constructorArgs, { fundingPoolFactoryImpl: [], fundingPoolImpl: [] });
  record.fundingPoolsDeployedAt = new Date().toISOString();
  saveDeployment(filename, record);

  console.log("\n" + "=".repeat(60));
  console.log("Appended to deployments/" + filename);
  console.log("=".repeat(60));
  console.log(`  fundingPoolFactory      ${contracts.fundingPoolFactory}`);
  console.log(`  fundingPoolFactoryImpl  ${contracts.fundingPoolFactoryImpl}`);
  console.log(`  fundingPoolImpl         ${contracts.fundingPoolImpl}`);
  console.log(`\nNext: npm run sync:frontend-contracts -- --network ${networkName} --chainId ${chainId}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
