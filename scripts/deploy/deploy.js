/**
 * deploy.js - P2P Betting v2 Deployment
 *
 * Replaces 01-06. Deploys the three-contract architecture deterministically
 * via the Safe Singleton Factory, seeds tier configs, and writes the deployment
 * record to deployments/<network>-chain<id>-v2.json.
 *
 * Deployed:
 *   - PolymarketOracleAdapter (or MockPolymarketCTF first if needed)
 *   - MembershipManager (seeds WAGER_PARTICIPANT tiers at $2/$8/$25/$100)
 *   - WagerRegistry (allowlists USDC + WMATIC; admin seeded with GUARDIAN +
 *     ACCOUNT_MODERATOR + DEFAULT_ADMIN roles)
 *   - KeyRegistry
 *
 * Usage:
 *   npx hardhat run scripts/deploy/deploy.js --network localhost
 *   npx hardhat run scripts/deploy/deploy.js --network amoy
 *
 *   MOCK_POLYMARKET=true     - force deploy a MockPolymarketCTF (used on Amoy
 *                              when no canonical Polymarket CTF exists)
 *   POLYMARKET_CTF=0x...     - override CTF address
 *   TREASURY=0x...           - treasury address (defaults to deployer)
 */

const hre = require("hardhat");
const { ethers } = require("hardhat");
const path = require("path");

const {
  SALT_PREFIXES,
  TOKENS,
  POLYMARKET_CTF,
  CHAINLINK_FUNCTIONS_ROUTER,
  CHAINLINK_DATA_FEEDS,
  UMA_OOV3,
  WAGER_PARTICIPANT_TIERS,
  MAINNET_CHAIN_IDS,
  NETWORK_DEPLOY_FLAGS,
  ROLE_HASHES,
  SINGLETON_FACTORY_ADDRESS,
} = require("./lib/constants");

// ResolutionType enum ordinals (must match IWagerRegistry.sol)
const RT = { Either: 0, Creator: 1, Opponent: 2, ThirdParty: 3, Polymarket: 4, ChainlinkDataFeed: 5, ChainlinkFunctions: 6, UMA: 7 };

const {
  generateSalt,
  deployDeterministic,
  ensureSingletonFactory,
  saveDeployment,
  getDeploymentFilename,
} = require("./lib/helpers");

const { deployProxy } = require("./lib/upgradeable");

const USDC_DECIMALS = 6;

// Convert a tier config's price (authored in 18-decimal ethers) to the payment
// token's own decimals. Tier prices are denominated in whole dollars, so a token
// with `decimals` decimals needs price18 / 10^(18 - decimals). USDC/USC (6) →
// /10^12; an 18-decimal stablecoin → no scaling. Reading decimals on-chain (not
// assuming 6) keeps membership tier prices correct on any stablecoin (Spec 015 U1).
function toTokenUnits(price18, decimals) {
  if (decimals > 18) throw new Error(`Unsupported stablecoin decimals ${decimals} (>18)`);
  return price18 / (10n ** BigInt(18 - decimals));
}

async function resolvePolymarketCTF(networkName, deployer, saltPrefix) {
  const envOverride = process.env.POLYMARKET_CTF;
  if (envOverride && ethers.isAddress(envOverride)) {
    console.log(`Using POLYMARKET_CTF override: ${envOverride}`);
    return envOverride;
  }

  const configured = POLYMARKET_CTF[networkName];
  if (configured) {
    console.log(`Using configured Polymarket CTF for ${networkName}: ${configured}`);
    return configured;
  }

  const mockFlag = String(process.env.MOCK_POLYMARKET || "").toLowerCase() === "true";
  const isProd = networkName === "polygon";
  if (!mockFlag && !isProd) {
    console.log(`No Polymarket CTF configured for ${networkName}; deploying MockPolymarketCTF (set MOCK_POLYMARKET=false to skip)`);
  } else if (!mockFlag && isProd) {
    throw new Error(`Polymarket CTF address required for production network '${networkName}'. Set POLYMARKET_CTF env var.`);
  }

  const mock = await deployDeterministic(
    "MockPolymarketCTF",
    [],
    generateSalt(saltPrefix + "MockPolymarketCTF"),
    deployer
  );
  return mock.address;
}

async function seedTiers(membershipManager, deployer, role, label, tierConfigs, decimals = USDC_DECIMALS) {
  console.log(`\nSeeding tiers for ${label} (payment token decimals: ${decimals})...`);
  for (const cfg of tierConfigs) {
    const priceUSDC = toTokenUnits(cfg.price, decimals);
    const limits = {
      monthlyMarketCreation:
        cfg.limits.monthlyMarketCreation > 2n ** 32n - 1n
          ? 0  // unlimited
          : Number(cfg.limits.monthlyMarketCreation),
      maxConcurrentMarkets:
        cfg.limits.maxConcurrentMarkets > 2n ** 32n - 1n
          ? 0
          : Number(cfg.limits.maxConcurrentMarkets),
    };
    const tierNames = ["NONE", "BRONZE", "SILVER", "GOLD", "PLATINUM"];
    console.log(`  ${label} ${tierNames[cfg.tier]}: ${ethers.formatUnits(priceUSDC, decimals)} (token units), ${limits.monthlyMarketCreation || "∞"}/mo, ${limits.maxConcurrentMarkets || "∞"} concurrent`);
    const tx = await membershipManager.connect(deployer).setTier(
      role,
      cfg.tier,
      priceUSDC,
      30, // durationDays
      limits,
      true // active
    );
    await tx.wait();
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("P2P Betting v2 Deployment");
  console.log("=".repeat(60));

  const network = await ethers.provider.getNetwork();
  const networkName = hre.network.name;
  const chainId = Number(network.chainId);
  console.log(`\nNetwork: ${networkName} (chainId ${chainId})`);

  if (MAINNET_CHAIN_IDS.includes(chainId)) {
    if (!process.env.CONFIRM_MAINNET) {
      throw new Error("Mainnet deployment requires CONFIRM_MAINNET=true env var.");
    }
  }

  await ensureSingletonFactory();

  const [rawDeployer] = await ethers.getSigners();
  if (!rawDeployer) throw new Error(`No signer for network '${networkName}'`);
  // Wrap the signer in a client-side NonceManager so a sequence of txs doesn't
  // re-fetch a stale nonce from a load-balanced public RPC (the "nonce too low"
  // failure mode). The base nonce is fetched once, then incremented locally.
  const { NonceManager } = require("ethers");
  const deployer = new NonceManager(rawDeployer);
  deployer.address = await rawDeployer.getAddress();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`\nDeployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ${networkName === "amoy" ? "POL" : "ETH"}`);

  const treasury = process.env.TREASURY && ethers.isAddress(process.env.TREASURY)
    ? process.env.TREASURY
    : deployer.address;
  console.log(`Treasury: ${treasury}`);

  // -------- Per-network deploy flags --------
  // Ethereum Classic (Mordor) is core-only: no Polymarket adapter, real stake
  // tokens only (Classic USD + WETC), no mock wrapped-native (Spec 015).
  const flags = NETWORK_DEPLOY_FLAGS[networkName] || {};

  // -------- Resolve token addresses --------
  let usdc = TOKENS[networkName]?.USC;
  // Wrapped native: prefer an explicit WMATIC, else the chain's wrapped-native
  // (WETC on Ethereum Classic). Both are real tokens — never a mock here.
  let wmatic = TOKENS[networkName]?.WMATIC || TOKENS[networkName]?.WETC || null;
  const deployments = {};

  // Never let a mainnet deployment fall back to a worthless MockERC20 as the
  // stake token. On a recognised mainnet (see MAINNET_CHAIN_IDS) a real token
  // address is mandatory — configure TOKENS[network] in lib/constants.js.
  const isMainnet = MAINNET_CHAIN_IDS.includes(chainId);
  if (isMainnet && (!usdc || !wmatic)) {
    throw new Error(
      `Real token addresses are required on mainnet '${networkName}' (chainId ${chainId}). ` +
        `Missing: ${[!usdc && "USDC", !wmatic && "WMATIC"].filter(Boolean).join(", ")}. ` +
        `Set TOKENS["${networkName}"] in scripts/deploy/lib/constants.js.`
    );
  }

  // requireRealStablecoin (Spec 015 FR-003): on flagged networks the stablecoin
  // MUST be a pre-existing real token — abort rather than mint a MockERC20.
  if (flags.requireRealStablecoin && (!usdc || !ethers.isAddress(usdc))) {
    throw new Error(
      `A real stablecoin (Classic USD) address is required on '${networkName}'. ` +
        `Set TOKENS["${networkName}"].USC in scripts/deploy/lib/constants.js and ` +
        `verify it on-chain before deploying (Spec 015, T001). No mock is substituted.`
    );
  }

  if (!usdc) {
    console.log(`\nNo USDC configured for ${networkName}; deploying MockERC20...`);
    const mock = await deployDeterministic(
      "MockERC20",
      ["USD Coin", "USDC", 0],
      generateSalt(SALT_PREFIXES.V2 + "MockUSDC"),
      deployer
    );
    usdc = mock.address;
    deployments.mockUSDC = mock.address;
  }
  if (!wmatic) {
    if (flags.noMockWrappedNative) {
      // Core-only network with no real wrapped-native: allowlist the stablecoin
      // alone rather than minting a mock (Spec 015, Constitution III).
      console.log(`\nNo real wrapped-native for ${networkName}; allowlisting stablecoin only (no mock).`);
    } else {
      // WETH9-shaped, not a plain MockERC20 (spec 108): the recorded `wmatic` is what the
      // Wrap surface resolves as the chain's wrapped native, and a wrapped-native mock with
      // no payable deposit() made the on-chain wrap flow unrunnable against the local stack.
      // MockWNative keeps MockERC20's mint/burn test API, so swap fixtures are unchanged.
      console.log(`\nNo WMATIC configured for ${networkName}; deploying MockWNative (18 dec)...`);
      const mock = await deployDeterministic(
        "MockWNative",
        ["Wrapped Matic", "WMATIC", 0],
        generateSalt(SALT_PREFIXES.V2 + "MockWMATIC"),
        deployer
      );
      wmatic = mock.address;
      deployments.mockWMATIC = mock.address;
    }
  }

  // Read the stablecoin's decimals on-chain so tier prices scale correctly on any
  // payment token (Spec 015 U1 — never assume 6).
  let stablecoinDecimals = USDC_DECIMALS;
  try {
    const erc20 = new ethers.Contract(usdc, ["function decimals() view returns (uint8)"], ethers.provider);
    stablecoinDecimals = Number(await erc20.decimals());
  } catch (e) {
    console.log(`  ⚠️  could not read decimals() of ${usdc}; defaulting to ${USDC_DECIMALS}`);
  }

  // Allowlisted stake tokens for WagerRegistry — real tokens only, drop empties.
  const stakeTokens = [usdc, wmatic].filter(Boolean);
  console.log(`USDC:   ${usdc} (decimals ${stablecoinDecimals})`);
  console.log(`WMATIC/WETC: ${wmatic || "(none — stablecoin-only allowlist)"}`);

  // -------- Polymarket CTF + Adapter --------
  // On core-only networks (Ethereum Classic has no Polymarket), skip the adapter
  // and Mock CTF entirely and construct WagerRegistry with a zero adapter, which
  // disables the Polymarket resolution type (WagerRegistry.sol: "may be zero to
  // disable"). The zero address is intentionally NOT recorded as polymarketAdapter
  // — the frontend capability tag treats any 40-hex address as "deployed", so a
  // zero would falsely light up (Spec 015 FR-001/FR-008).
  let polymarketCTF = null;
  let adapterAddress = ethers.ZeroAddress;
  if (flags.noPolymarket) {
    console.log("Polymarket: skipped (core-only network) — WagerRegistry adapter = address(0)");
  } else {
    polymarketCTF = await resolvePolymarketCTF(networkName, deployer, SALT_PREFIXES.V2);
    console.log(`Polymarket CTF: ${polymarketCTF}`);
    if (deployments.mockUSDC || polymarketCTF !== POLYMARKET_CTF[networkName]) {
      deployments.polymarketCTF = polymarketCTF;
    }

    const adapter = await deployDeterministic(
      "PolymarketOracleAdapter",
      [deployer.address, polymarketCTF],
      generateSalt(SALT_PREFIXES.V2 + "PolymarketOracleAdapter"),
      deployer
    );
    adapterAddress = adapter.address;
    deployments.polymarketAdapter = adapter.address;
  }

  // -------- MembershipManager (UUPS proxy — spec 027) --------
  // The membership authority is now upgradeable: deployed behind an ERC1967 UUPS proxy so future logic
  // (immediately, spec 026's voucher redemption) ships as an in-place upgrade — stable address, preserved
  // state — instead of a fresh address that strands memberships. The PROXY is recorded under
  // `membershipManager` (stable); the implementation under `membershipManagerImpl` (changes on upgrade).
  // NOTE: unlike the prior CREATE2 deploy this is NOT idempotent — re-running mints a new proxy; to change
  // logic on an existing deployment, run an upgrade (lib/upgradeable.js `upgradeProxy`), not this script.
  console.log("\nDeploying MembershipManager behind a UUPS proxy...");
  const mgrProxy = await deployProxy({
    name: "MembershipManager",
    initArgs: [deployer.address, usdc, treasury],
  });
  // Re-sync the client-side NonceManager after the plugin's raw-signer txs (see WagerRegistry note below).
  if (typeof deployer.reset === "function") deployer.reset();
  const mgrDeploy = { address: mgrProxy.proxy, contract: mgrProxy.contract, alreadyDeployed: false };
  deployments.membershipManager = mgrProxy.proxy;
  deployments.membershipManagerImpl = mgrProxy.implementation;
  const membershipManager = mgrDeploy.contract;

  if (!mgrDeploy.alreadyDeployed || process.env.FORCE_SEED_TIERS === "true") {
    await seedTiers(membershipManager, deployer, ROLE_HASHES.WAGER_PARTICIPANT_ROLE, "WAGER_PARTICIPANT", WAGER_PARTICIPANT_TIERS, stablecoinDecimals);
  } else {
    console.log("\nMembershipManager already deployed — skipping tier seed (idempotent re-runs should re-seed manually if config changed)");
  }

  // -------- MembershipVoucher (immutable — spec 026) --------
  // Transferable ERC-721 bearer voucher; redemption burns it and mints a soulbound membership via the
  // MembershipManager proxy. Immutable by design (a bearer asset's rules must not change post-sale).
  const voucherDeploy = await deployDeterministic(
    "MembershipVoucher",
    [deployer.address, mgrDeploy.address],
    generateSalt(SALT_PREFIXES.V2 + "MembershipVoucher"),
    deployer
  );
  deployments.membershipVoucher = voucherDeploy.address;
  if ((await membershipManager.voucher()).toLowerCase() !== voucherDeploy.address.toLowerCase()) {
    console.log("\nWiring MembershipVoucher into MembershipManager...");
    const tx = await membershipManager.connect(deployer).setVoucher(voucherDeploy.address);
    await tx.wait();
    console.log("  ✓ redeemVoucher enabled (voucher rail live)");
  }

  // -------- VoucherBatchMinter (immutable helper — spec 026) --------
  // Single-tx "buy N vouchers" / "gift to an address" rail over the immutable MembershipVoucher (whose mint()
  // makes one token, to the caller). Custody-free: pulls exactly quantity*price USDC and forwards every minted
  // voucher to the recipient in the same tx. Immutable, no admin, no withdrawal path.
  const batchMinterDeploy = await deployDeterministic(
    "VoucherBatchMinter",
    [voucherDeploy.address],
    generateSalt(SALT_PREFIXES.V2 + "VoucherBatchMinter"),
    deployer
  );
  deployments.voucherBatchMinter = batchMinterDeploy.address;

  // -------- WagerRegistry (UUPS proxy — spec 025) --------
  // The registry is now upgradeable: deployed behind an ERC1967 UUPS proxy so future logic ships as an
  // in-place upgrade (stable address, preserved state) instead of a fresh address that strands wagers.
  // The PROXY address is the stable one recorded under `wagerRegistry`; the implementation is recorded
  // under `wagerRegistryImpl` (changes on each upgrade). Storage-layout safety is validated by the plugin
  // here and by `npm run check:storage-layout` in CI. NOTE: unlike the prior CREATE2 deploy this is NOT
  // idempotent — re-running mints a new proxy; to change logic on an existing deployment, run an upgrade
  // (scripts/deploy/lib/upgradeable.js `upgradeProxy`), not this script.
  console.log("\nDeploying WagerRegistry behind a UUPS proxy...");
  const regProxy = await deployProxy({
    name: "WagerRegistry",
    initArgs: [deployer.address, mgrDeploy.address, adapterAddress, stakeTokens],
  });
  const regDeploy = { address: regProxy.proxy, contract: regProxy.contract, alreadyDeployed: false };
  deployments.wagerRegistry = regProxy.proxy;
  deployments.wagerRegistryImpl = regProxy.implementation;

  // The hardhat-upgrades plugin sends the impl+proxy txs via the raw signer, bypassing our client-side
  // NonceManager — so reset its cached nonce to re-sync with the chain before the next tx (else: "Nonce too
  // low"). reset() is an ethers v6 NonceManager method; guard for older shapes.
  if (typeof deployer.reset === "function") deployer.reset();

  if (!regDeploy.alreadyDeployed) {
    console.log("\nAuthorizing WagerRegistry on MembershipManager...");
    const tx = await membershipManager.connect(deployer).setAuthorizedCaller(regDeploy.address, true);
    await tx.wait();
    console.log("  ✓ WagerRegistry can call recordCreate/recordClose");
  }
  const wagerRegistry = regDeploy.contract;

  // -------- SanctionsGuard (Spec 007, FR-054) --------
  // Resolve the Chainalysis on-chain Sanctions Oracle per chain. Mainnet 137 has the real
  // oracle; Amoy/local have none, so deploy a MockSanctionsOracle there (mocks confined to
  // contracts/mocks; never used on a mainnet path — constitution III / FR-022). Address is
  // injected, never hardcoded in the contract (FR-055).
  const CHAINALYSIS_ORACLE = { 137: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb" };
  let sanctionsOracleAddr =
    process.env[`CHAINALYSIS_SANCTIONS_ORACLE_${chainId}`] || CHAINALYSIS_ORACLE[chainId];
  if (sanctionsOracleAddr && !ethers.isAddress(sanctionsOracleAddr)) {
    throw new Error(`CHAINALYSIS_SANCTIONS_ORACLE_${chainId} is not a valid address: ${sanctionsOracleAddr}`);
  }
  if (!sanctionsOracleAddr) {
    if (isMainnet) {
      throw new Error(
        `A Chainalysis sanctions oracle address is required on mainnet '${networkName}' (chainId ${chainId}). ` +
          `Set CHAINALYSIS_SANCTIONS_ORACLE_${chainId} or add it to CHAINALYSIS_ORACLE in deploy.js.`
      );
    }
    console.log(`\nNo Chainalysis oracle on ${networkName}; deploying MockSanctionsOracle...`);
    const mockOracle = await deployDeterministic(
      "MockSanctionsOracle",
      [],
      generateSalt(SALT_PREFIXES.V2 + "MockSanctionsOracle"),
      deployer
    );
    sanctionsOracleAddr = mockOracle.address;
    deployments.mockSanctionsOracle = mockOracle.address;
  }
  console.log(`Chainalysis Sanctions Oracle: ${sanctionsOracleAddr}`);

  const guardDeploy = await deployDeterministic(
    "SanctionsGuard",
    [deployer.address, sanctionsOracleAddr],
    generateSalt(SALT_PREFIXES.V2 + "SanctionsGuard"),
    deployer
  );
  deployments.sanctionsGuard = guardDeploy.address;

  // Wire the guard into both fund contracts (idempotent: skip if already pointing at it).
  if ((await wagerRegistry.sanctionsGuard()).toLowerCase() !== guardDeploy.address.toLowerCase()) {
    console.log("\nWiring SanctionsGuard into WagerRegistry...");
    const tx = await wagerRegistry.connect(deployer).setSanctionsGuard(guardDeploy.address);
    await tx.wait();
    console.log("  ✓ WagerRegistry screens create/accept");
  }
  if ((await membershipManager.sanctionsGuard()).toLowerCase() !== guardDeploy.address.toLowerCase()) {
    console.log("Wiring SanctionsGuard into MembershipManager...");
    const tx = await membershipManager.connect(deployer).setSanctionsGuard(guardDeploy.address);
    await tx.wait();
    console.log("  ✓ MembershipManager screens purchase/upgrade/extend");
  }

  // -------- Chainlink + UMA oracle adapters --------
  // Each adapter is only deployed when its required network config resolves.
  // Skipped adapters log a reason; the WagerRegistry just won't accept that
  // ResolutionType on this network until the address gets filled in later.
  const oracleDeployments = {};

  // Chainlink Data Feeds
  const feedMap = CHAINLINK_DATA_FEEDS[networkName] || {};
  if (Object.keys(feedMap).length > 0) {
    const cl = await deployDeterministic(
      "ChainlinkDataFeedOracleAdapter",
      [deployer.address],
      generateSalt(SALT_PREFIXES.V2 + "ChainlinkDataFeedOracleAdapter"),
      deployer
    );
    oracleDeployments.chainlinkDataFeedAdapter = cl.address;
    deployments.chainlinkDataFeedAdapter = cl.address;
    if (!cl.alreadyDeployed) {
      // Allowlist every feed configured for this network
      for (const [pair, addr] of Object.entries(feedMap)) {
        const tx = await cl.contract.connect(deployer).setFeedAllowed(addr, true);
        await tx.wait();
        console.log(`  ✓ allowlisted Chainlink ${pair}: ${addr}`);
      }
    }
    if (!cl.alreadyDeployed || !regDeploy.alreadyDeployed) {
      const wireTx = await wagerRegistry.connect(deployer).setOracleAdapter(RT.ChainlinkDataFeed, cl.address);
      await wireTx.wait();
      console.log(`  ✓ ChainlinkDataFeedOracleAdapter wired into WagerRegistry`);
    }
  } else {
    console.log(`Skipping ChainlinkDataFeedOracleAdapter on ${networkName}: no feeds configured`);
  }

  // Chainlink Functions
  const fnRouter = CHAINLINK_FUNCTIONS_ROUTER[networkName];
  if (fnRouter && ethers.isAddress(fnRouter)) {
    const fn = await deployDeterministic(
      "ChainlinkFunctionsOracleAdapter",
      [deployer.address, fnRouter],
      generateSalt(SALT_PREFIXES.V2 + "ChainlinkFunctionsOracleAdapter"),
      deployer
    );
    oracleDeployments.chainlinkFunctionsAdapter = fn.address;
    deployments.chainlinkFunctionsAdapter = fn.address;
    if (!fn.alreadyDeployed || !regDeploy.alreadyDeployed) {
      const wireTx = await wagerRegistry.connect(deployer).setOracleAdapter(RT.ChainlinkFunctions, fn.address);
      await wireTx.wait();
      console.log(`  ✓ ChainlinkFunctionsOracleAdapter wired into WagerRegistry`);
      if (!fn.alreadyDeployed) {
        console.log(`  ⚠️  add ${fn.address} as a consumer on your LINK subscription before calling registerCondition`);
      }
    }
  } else {
    console.log(`Skipping ChainlinkFunctionsOracleAdapter on ${networkName}: no router configured`);
  }

  // UMA Optimistic Oracle V3
  const ooAddr = UMA_OOV3[networkName];
  if (ooAddr && ethers.isAddress(ooAddr)) {
    const uma = await deployDeterministic(
      "UMAOptimisticOracleV3Adapter",
      [deployer.address, ooAddr],
      generateSalt(SALT_PREFIXES.V2 + "UMAOptimisticOracleV3Adapter"),
      deployer
    );
    oracleDeployments.umaAdapter = uma.address;
    deployments.umaAdapter = uma.address;
    if (!uma.alreadyDeployed || !regDeploy.alreadyDeployed) {
      const wireTx = await wagerRegistry.connect(deployer).setOracleAdapter(RT.UMA, uma.address);
      await wireTx.wait();
      console.log(`  ✓ UMAOptimisticOracleV3Adapter wired into WagerRegistry`);
    }
  } else {
    console.log(`Skipping UMAOptimisticOracleV3Adapter on ${networkName}: no OOv3 address configured`);
  }

  // -------- KeyRegistry --------
  const keyDeploy = await deployDeterministic(
    "KeyRegistry",
    [],
    generateSalt(SALT_PREFIXES.V2 + "KeyRegistry"),
    deployer
  );
  deployments.keyRegistry = keyDeploy.address;

  // -------- TokenFactory + token templates (UUPS proxy — spec 028) --------
  // Token-issuance authority/registry: deploys per-issuer tokens as EIP-1167 clones of immutable templates,
  // gates creation behind TOKEN_ISSUER_ROLE, and screens issuers via the SanctionsGuard. Upgradeable (stable
  // address, append-only storage) like the membership/wager proxies; to change logic, run an upgrade
  // (lib/upgradeable.js `upgradeProxy`), not this script. The open ERC-20/721 + ERC-1404 classes ship now; the
  // T-REX/ERC-3643 class (US4) is deferred (the vendored suite is OZ-4.x / Solidity-0.8.17 only). The clone
  // templates are immutable and deployed deterministically; their initializers are disabled in-constructor.
  console.log("\nDeploying token templates (spec 028)...");
  const openERC20Tpl = await deployDeterministic(
    "OpenERC20", [], generateSalt(SALT_PREFIXES.V2 + "OpenERC20"), deployer
  );
  const openERC721Tpl = await deployDeterministic(
    "OpenERC721", [], generateSalt(SALT_PREFIXES.V2 + "OpenERC721"), deployer
  );
  const restrictedERC20Tpl = await deployDeterministic(
    "RestrictedERC20", [], generateSalt(SALT_PREFIXES.V2 + "RestrictedERC20"), deployer
  );
  deployments.openERC20Impl = openERC20Tpl.address;
  deployments.openERC721Impl = openERC721Tpl.address;
  deployments.restrictedERC20Impl = restrictedERC20Tpl.address;

  console.log("\nDeploying TokenFactory behind a UUPS proxy...");
  const tokenFactoryProxy = await deployProxy({
    name: "TokenFactory",
    initArgs: [
      deployer.address,
      guardDeploy.address, // issuers screened by the same SanctionsGuard wired into the rest of the platform
      openERC20Tpl.address,
      openERC721Tpl.address,
      restrictedERC20Tpl.address,
    ],
  });
  // Re-sync the client-side NonceManager after the plugin's raw-signer txs (see WagerRegistry note above).
  if (typeof deployer.reset === "function") deployer.reset();
  deployments.tokenFactory = tokenFactoryProxy.proxy;
  deployments.tokenFactoryImpl = tokenFactoryProxy.implementation;

  // Grant the deployer (platform admin) the issuer role so issuance is usable immediately; the admin can
  // grant/revoke TOKEN_ISSUER_ROLE to other members out-of-band (research R4).
  {
    const tokenFactory = tokenFactoryProxy.contract;
    const issuerRole = await tokenFactory.TOKEN_ISSUER_ROLE();
    if (!(await tokenFactory.hasRole(issuerRole, deployer.address))) {
      const tx = await tokenFactory.connect(deployer).grantRole(issuerRole, deployer.address);
      await tx.wait();
      console.log("  ✓ TOKEN_ISSUER_ROLE granted to deployer");
    }
  }

  // -------- Summary --------
  console.log("\n" + "=".repeat(60));
  console.log("Deployment Summary");
  console.log("=".repeat(60));
  console.log(`Network:           ${networkName} (chainId ${chainId})`);
  console.log(`Deployer:          ${deployer.address}`);
  console.log(`Treasury:          ${treasury}`);
  console.log(`Singleton Factory: ${SINGLETON_FACTORY_ADDRESS}`);
  console.log("\nAddresses:");
  for (const [k, v] of Object.entries(deployments)) {
    console.log(`  ${k.padEnd(22)} ${v}`);
  }
  console.log(`  USDC                   ${usdc}`);
  console.log(`  WMATIC/WETC            ${wmatic || "(none — stablecoin-only allowlist)"}`);

  // -------- WagerRegistryIntents (specs 035 + 036) --------
  // The registry is TWO facets behind ONE proxy: WagerRegistry delegatecalls unknown selectors to
  // this extension because the main implementation sits against the 24 KB code limit. Everything
  // that lives here — every `…WithSig` / `…WithAuthorization` twin, `batchExpireOpen`, and the
  // `autoResolveFrom*` family — reverts `UnknownFunction()` until the proxy is pointed at it.
  //
  // This wiring previously existed ONLY in scripts/deploy/upgrade-gasless-intents.js, which is a
  // migration for chains that already had a pre-035 registry. A brand-new chain never runs it, so
  // every deployment from this script shipped with no gasless rail and no auto-resolution, and
  // nothing said so: the record looked complete because `wagerRegistryIntents` was simply absent
  // rather than flagged (issue #1227).
  //
  // DEPLOYED LAST, DELIBERATELY. Every deploy consumes a nonce, and `tokenFactory` above is a
  // plain (nonce-derived) proxy deploy — inserting this earlier would move its address on every
  // future deployment. The CREATE2 deploys are salt-derived and would not care; that one would.
  console.log("\nDeploying WagerRegistryIntents (registry extension facet)...");
  const intentsDeploy = await deployDeterministic(
    "WagerRegistryIntents",
    [],
    generateSalt(SALT_PREFIXES.V2 + "WagerRegistryIntents"),
    deployer
  );
  deployments.wagerRegistryIntents = intentsDeploy.address;

  const currentExtension = await wagerRegistry.intentExtension();
  if (currentExtension.toLowerCase() !== intentsDeploy.address.toLowerCase()) {
    console.log("Pointing the proxy fallback at the facet (setIntentExtension)...");
    const extTx = await wagerRegistry.connect(deployer).setIntentExtension(intentsDeploy.address);
    await extTx.wait();
  }

  // FAIL LOUDLY rather than shipping a half-wired registry. An unset extension is invisible from
  // the deployment record and only shows up when a member hits a gasless path and gets a revert
  // with no arguments, so the absence has to be caught here.
  const wiredExtension = await wagerRegistry.intentExtension();
  if (!wiredExtension || wiredExtension === ethers.ZeroAddress) {
    throw new Error(
      "WagerRegistry.intentExtension() is unset after deployment — the …WithSig twins, " +
      "batchExpireOpen and autoResolveFrom* would all revert UnknownFunction(). Refusing to " +
      "record this deployment as complete."
    );
  }
  console.log(`  ✓ Intent extension wired: ${wiredExtension}`);

  // Persist the EXACT constructor args used for each contract so verify.js can
  // reproduce them without recomputing from env/constants (which could drift
  // between this deploy and a later standalone `verify.js` run). These are read
  // in the SAME process as the deploy, so they equal the deploy-time values.
  const constructorArgs = {
    // UUPS proxies (spec 025/027): implementations are verified with EMPTY constructor args (init data lives
    // in the proxy, not the implementation's constructor). verify.js verifies the implementation addresses.
    membershipManagerImpl: [],
    membershipVoucher: [deployer.address, mgrDeploy.address],
    voucherBatchMinter: [voucherDeploy.address],
    wagerRegistryImpl: [],
    wagerRegistryIntents: [],
    sanctionsGuard: [deployer.address, sanctionsOracleAddr],
    keyRegistry: [],
    // spec 028: UUPS factory impl verified with empty args; clone templates have no constructor args.
    tokenFactoryImpl: [],
    openERC20Impl: [],
    openERC721Impl: [],
    restrictedERC20Impl: [],
  };
  if (!flags.noPolymarket) constructorArgs.polymarketAdapter = [deployer.address, polymarketCTF];
  if (oracleDeployments.chainlinkDataFeedAdapter) constructorArgs.chainlinkDataFeedAdapter = [deployer.address];
  if (oracleDeployments.chainlinkFunctionsAdapter) constructorArgs.chainlinkFunctionsAdapter = [deployer.address, CHAINLINK_FUNCTIONS_ROUTER[networkName]];
  if (oracleDeployments.umaAdapter) constructorArgs.umaAdapter = [deployer.address, UMA_OOV3[networkName]];
  if (deployments.mockSanctionsOracle) constructorArgs.mockSanctionsOracle = [];
  if (deployments.mockUSDC) constructorArgs.mockUSDC = ["USD Coin", "USDC", 0];
  if (deployments.mockWMATIC) constructorArgs.mockWMATIC = ["Wrapped Matic", "WMATIC", 0];
  if (deployments.polymarketCTF) constructorArgs.mockPolymarketCTF = [];

  const record = {
    network: networkName,
    chainId,
    deployer: deployer.address,
    treasury,
    paymentToken: usdc,
    wmatic,
    polymarketCTF,
    contracts: {
      // polymarketAdapter is omitted on core-only networks (zero adapter) so the
      // frontend capability tag does not falsely report it as deployed.
      ...(flags.noPolymarket ? {} : { polymarketAdapter: adapterAddress }),
      membershipManager: mgrDeploy.address, // ERC1967 proxy (stable address)
      membershipManagerImpl: mgrProxy.implementation, // current implementation (changes on upgrade)
      membershipVoucher: voucherDeploy.address, // immutable ERC-721 voucher (spec 026)
      voucherBatchMinter: batchMinterDeploy.address, // immutable batch/gift helper (spec 026)
      wagerRegistry: regDeploy.address, // ERC1967 proxy (stable address)
      wagerRegistryImpl: regProxy.implementation, // current implementation (changes on upgrade)
      wagerRegistryIntents: intentsDeploy.address, // extension facet the proxy delegates to (specs 035/036)
      keyRegistry: keyDeploy.address,
      sanctionsGuard: guardDeploy.address,
      // spec 028 — token issuance: factory proxy (stable) + impl (changes on upgrade) + immutable templates.
      tokenFactory: tokenFactoryProxy.proxy,
      tokenFactoryImpl: tokenFactoryProxy.implementation,
      openERC20Impl: openERC20Tpl.address,
      openERC721Impl: openERC721Tpl.address,
      restrictedERC20Impl: restrictedERC20Tpl.address,
      ...oracleDeployments,
    },
    mocks: deployments.mockUSDC || deployments.mockWMATIC || deployments.polymarketCTF || deployments.mockSanctionsOracle
      ? {
          mockUSDC: deployments.mockUSDC,
          mockWMATIC: deployments.mockWMATIC,
          mockPolymarketCTF: deployments.polymarketCTF,
          mockSanctionsOracle: deployments.mockSanctionsOracle,
        }
      : null,
    constructorArgs,
    saltPrefix: SALT_PREFIXES.V2,
    timestamp: new Date().toISOString(),
  };

  saveDeployment(getDeploymentFilename(network, "v2"), record);
  console.log("\n✓ Deployment record saved");
  console.log("\nNext:");
  console.log("  1. sync frontend:  npm run sync:frontend-contracts -- --network " + networkName + " --chainId " + chainId);
  console.log("  2. verify source:  npx hardhat run scripts/deploy/verify.js --network " + networkName);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
