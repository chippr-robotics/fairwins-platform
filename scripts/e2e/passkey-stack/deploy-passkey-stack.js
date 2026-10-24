/**
 * Bootstrap the ERC-4337 prerequisites on the LOCAL e2e chain (spec 041 + spec 050).
 *
 *   HARDHAT_LOCAL_CHAIN_ID=80002 npx hardhat node
 *   npm run setup:e2e
 *   npx hardhat run scripts/e2e/passkey-stack/deploy-passkey-stack.js --network localhost   # proxy + EntryPoint + account stack
 *   PM_VERIFYING_SIGNER=… npx hardhat run scripts/deploy/deploy-verifying-paymaster.js --network localhost
 *
 * WHY THIS SCRIPT EXISTS AT ALL. `deploy-account-stack.js` deliberately REFUSES a chain that has
 * neither the Arachnid CREATE2 proxy nor EntryPoint v0.6 ("on local dev use the test fixtures"),
 * and it is right to: recording a non-deterministic factory address would break FR-023, and the
 * app's `ACCOUNT_INIT_CODE_HASH` is pinned to the implementation that the canonical salt produces.
 * So rather than fork that script for CI, this one makes the local chain LOOK like every other EVM
 * network — same CREATE2 proxy address, same EntryPoint address — and then the real deploy scripts
 * run unmodified. That is what makes the e2e stack a test of the shipped deployment path instead of
 * a parallel one.
 *
 * Two things are deployed here and neither is invented:
 *
 *  1. **The Arachnid deterministic-deployment proxy** at 0x4e59b448…4956C. Mainnet got it from a
 *     pre-EIP-155 presigned transaction; a CREATE address is a pure function of (sender, nonce), so
 *     impersonating that same sender at nonce 0 with the same init code lands the same address
 *     without needing the signature. The script ASSERTS the address rather than assuming it.
 *
 *  2. **EntryPoint v0.6** at 0x5FF1…2789, CREATE2'd through that proxy with the canonical zero salt
 *     — which is exactly how the live one was deployed, so the address falls out rather than being
 *     forced. Its creation bytecode comes from `npm pack @account-abstraction/contracts@0.6.0` into
 *     a temp dir: the package is NEVER added to package.json (spec 075 — a lockfile touch here
 *     drops the platform rolldown binary and breaks every Vite build). The address assertion is
 *     also the integrity check: a tampered or wrong-version tarball CANNOT produce 0x5FF1…2789.
 *     Do not "simplify" this to `hardhat_setCode` with the deployed runtime — EntryPoint's
 *     `senderCreator` is an immutable baked into that runtime, and a copied one points at a
 *     contract this chain does not have, so first-use account deployment (initCode) reverts.
 *
 * Nothing here is production code and nothing here may run against a public network: the guard
 * below refuses anything that is not a local node.
 */
const hre = require("hardhat");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// The canonical deterministic-deployment proxy and the account that deployed it (Arachnid).
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const CREATE2_DEPLOYER_EOA = "0x3fAB184622Dc19b6109349B94811493BF2a45362";
// init = 14-byte prologue (return 69 bytes from offset 14) + the 69-byte runtime, which is exactly
// what `eth_getCode(0x4e59b448…)` returns on every live chain.
const CREATE2_PROXY_INITCODE =
  "0x604580600e600039806000f350fe" +
  "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0" +
  "3601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

const ENTRYPOINT_V06 = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
const ENTRYPOINT_PKG = "@account-abstraction/contracts@0.6.0";
const ZERO_SALT = "0x" + "0".repeat(64);

// Chain ids this script will touch. 80002 is the Amoy-impersonating local node the full tier uses
// (see the E2E_AMOY_LOCAL seam); 1337 is the plain local sandbox.
const LOCAL_CHAIN_IDS = [80002, 1337, 31337];

function assertLocal(chainId) {
  const url = hre.network.config?.url || "";
  const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)\b/.test(url);
  if (!LOCAL_CHAIN_IDS.includes(chainId) || !isLoopback) {
    throw new Error(
      `Refusing to run: this script bootstraps a LOCAL e2e chain only (got chainId ${chainId} at "${url}"). ` +
        `On a real network the CREATE2 proxy and EntryPoint already exist.`
    );
  }
}

/** Fetch the pinned EntryPoint artifact WITHOUT touching the repo's dependency tree. */
function entryPointCreationBytecode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-entrypoint-"));
  // `npm pack` only downloads a tarball; it writes nothing to package.json or package-lock.json.
  const out = execFileSync("npm", ["pack", ENTRYPOINT_PKG, "--pack-destination", dir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tgz = out.trim().split("\n").pop().trim();
  execFileSync("tar", ["xzf", path.join(dir, tgz), "-C", dir, "package/artifacts/EntryPoint.json"], {
    stdio: "inherit",
  });
  const artifact = JSON.parse(fs.readFileSync(path.join(dir, "package/artifacts/EntryPoint.json"), "utf8"));
  if (!/^0x[0-9a-fA-F]+$/.test(artifact.bytecode || "")) {
    throw new Error(`${ENTRYPOINT_PKG}: artifacts/EntryPoint.json has no usable creation bytecode`);
  }
  return artifact.bytecode;
}

/*
 * THE ACCOUNT STACK AT ITS CANONICAL ADDRESSES.
 *
 * FR-023 pins `accountFactory` (0xd519…8734) and `accountImpl` (0xfC50…5E61) to the SAME address on
 * every network, and the SPA asserts that across its configured networks (smartAccount.js
 * accountFactoryAddress). The first CI run showed that the CURRENT compile of CoinbaseSmartWallet
 * does not reproduce them through the canonical CREATE2 path — it lands at 0x33Bf…/0xc36e… —
 * because the live factories were deployed from an earlier compile (metadata/settings drift that
 * the spec-075 byte gate only started pinning afterwards). So `deploy-account-stack.js` correctly
 * REFUSES here (its FR-023 check), and reproducing the old bytes is impossible without the old
 * artifacts.
 *
 * What the e2e tier actually needs is a local chain that LOOKS like every other network to the
 * app: working account code AT the canonical addresses. That is what this installs — the current
 * compile's runtime code, placed with `hardhat_setCode` at the addresses the app is built against:
 *
 *   1. deploy the implementation the ordinary way (any address), copy its runtime to CANON_IMPL;
 *   2. deploy the factory with `implementation_ = CANON_IMPL` (its constructor requires code
 *      there, and bakes the address in as an immutable — so the constructor arg is what makes
 *      the copied runtime point at the canonical impl), copy its runtime to CANON_FACTORY.
 *
 * Storage is not copied: the implementation's constructor locks its own owner slot, and clones
 * carry their own storage, so an unlocked local impl changes nothing a test can observe. The
 * divergence itself is printed loudly every run so nobody mistakes this chain for a proof that
 * the deploy script reproduces production.
 */
const CANON_IMPL = "0xfC5086A397e4FbAAF8f73892807415Da8d255E61";
const CANON_FACTORY = "0xd519C25e9dEd0DAC586B764574100479CB318734";
const ACCOUNT_SALT = ethers.id("fairwins.041.account-stack.v1");

async function setCode(address, code) {
  await hre.network.provider.request({ method: "hardhat_setCode", params: [address, code] });
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`hardhat_setCode left no code at ${address}`);
}

async function installCanonicalAccountStack(deployer) {
  if ((await ethers.provider.getCode(CANON_FACTORY)) !== "0x") {
    console.log(`account stack: already present at ${CANON_FACTORY}`);
    return;
  }
  const Wallet = await ethers.getContractFactory("CoinbaseSmartWallet");
  const Factory = await ethers.getContractFactory("CoinbaseSmartWalletFactory");

  // Where the CURRENT compile would land through the canonical CREATE2 path — reported, not used.
  const predictedImpl = ethers.getCreate2Address(CREATE2_DEPLOYER, ACCOUNT_SALT, ethers.keccak256(Wallet.bytecode));
  const predictedFactory = ethers.getCreate2Address(
    CREATE2_DEPLOYER,
    ACCOUNT_SALT,
    ethers.keccak256(ethers.concat([Factory.bytecode, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [predictedImpl])]))
  );
  if (predictedFactory.toLowerCase() !== CANON_FACTORY.toLowerCase()) {
    console.warn(
      `account stack: the current compile does NOT reproduce the canonical CREATE2 addresses ` +
        `(would land impl ${predictedImpl} / factory ${predictedFactory}; canonical ${CANON_IMPL} / ${CANON_FACTORY}). ` +
        `Installing the current runtime AT the canonical addresses via hardhat_setCode. ` +
        `A fresh network deployed with deploy-account-stack.js today would diverge — that is a fact about the ` +
        `live deployments' compile, and this chain is not evidence either way.`
    );
  }

  const impl = await Wallet.deploy();
  await impl.waitForDeployment();
  await setCode(CANON_IMPL, await ethers.provider.getCode(await impl.getAddress()));
  console.log(`account stack: CoinbaseSmartWallet runtime installed at ${CANON_IMPL}`);

  const factory = await Factory.deploy(CANON_IMPL);
  await factory.waitForDeployment();
  await setCode(CANON_FACTORY, await ethers.provider.getCode(await factory.getAddress()));
  const reads = await ethers.getContractAt("CoinbaseSmartWalletFactory", CANON_FACTORY);
  const impl_ = await reads.implementation();
  if (impl_.toLowerCase() !== CANON_IMPL.toLowerCase()) {
    throw new Error(`account stack: factory at ${CANON_FACTORY} points at ${impl_}, expected ${CANON_IMPL}`);
  }
  console.log(`account stack: CoinbaseSmartWalletFactory runtime installed at ${CANON_FACTORY} (implementation ${impl_})`);

  // The deployment record the gateway and stack-env.js read (mirrors deploy-account-stack.js#recordStack).
  const { getDeploymentFilename, saveDeployment } = require("../../deploy/lib/helpers");
  const network = await ethers.provider.getNetwork();
  const filename = getDeploymentFilename(network, "v2");
  const filepath = path.join(process.cwd(), "deployments", filename);
  const record = fs.existsSync(filepath) ? JSON.parse(fs.readFileSync(filepath, "utf8")) : { chainId: Number(network.chainId), contracts: {} };
  record.contracts = record.contracts || {};
  record.contracts.entryPoint = ENTRYPOINT_V06;
  record.contracts.accountImpl = CANON_IMPL;
  record.contracts.accountFactory = CANON_FACTORY;
  record.contracts.p256Verifier = record.contracts.p256Verifier || null;
  saveDeployment(filename, record);
  console.log(`account stack: recorded in deployments/${filename}`);
}

async function deployCreate2Proxy() {
  if ((await ethers.provider.getCode(CREATE2_DEPLOYER)) !== "0x") {
    console.log(`CREATE2 proxy: already present at ${CREATE2_DEPLOYER}`);
    return;
  }
  const nonce = await ethers.provider.getTransactionCount(CREATE2_DEPLOYER_EOA);
  if (nonce !== 0) {
    throw new Error(
      `${CREATE2_DEPLOYER_EOA} has nonce ${nonce} but no proxy at ${CREATE2_DEPLOYER} — the CREATE address ` +
        `depends on that nonce, so this chain cannot reproduce the canonical proxy. Restart the node.`
    );
  }
  // Balance is SET, not sent: a funding transfer would spend a nonce on the deployer account and
  // 1 ETH is not enough anyway — with no gasLimit hardhat prices the tx at the block gas limit
  // (measured: 8.37 ETH upfront on the first CI run). The canonical presigned deployment used
  // 100 gwei x 100,000 gas; the same explicit limit keeps the upfront cost at 0.01 ETH.
  await hre.network.provider.request({
    method: "hardhat_setBalance",
    params: [CREATE2_DEPLOYER_EOA, "0x" + ethers.parseEther("10").toString(16)],
  });
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [CREATE2_DEPLOYER_EOA] });
  try {
    const signer = await ethers.getSigner(CREATE2_DEPLOYER_EOA);
    const tx = await signer.sendTransaction({ data: CREATE2_PROXY_INITCODE, gasLimit: 100_000 });
    const receipt = await tx.wait();
    const landed = receipt.contractAddress;
    if (!landed || landed.toLowerCase() !== CREATE2_DEPLOYER.toLowerCase()) {
      throw new Error(
        `CREATE2 proxy landed at ${landed}, not the canonical ${CREATE2_DEPLOYER}. ` +
          `Every deterministic address downstream (accountFactory, EntryPoint) would diverge.`
      );
    }
  } finally {
    await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [CREATE2_DEPLOYER_EOA] });
  }
  console.log(`CREATE2 proxy: deployed at ${CREATE2_DEPLOYER}`);
}

async function deployEntryPoint(deployer) {
  if ((await ethers.provider.getCode(ENTRYPOINT_V06)) !== "0x") {
    console.log(`EntryPoint v0.6: already present at ${ENTRYPOINT_V06}`);
    return;
  }
  const initCode = entryPointCreationBytecode();
  const predicted = ethers.getCreate2Address(CREATE2_DEPLOYER, ZERO_SALT, ethers.keccak256(initCode));
  if (predicted.toLowerCase() !== ENTRYPOINT_V06.toLowerCase()) {
    // The address IS the checksum: the canonical EntryPoint was CREATE2'd from this proxy with the
    // zero salt, so a different address means different bytes than the network runs.
    throw new Error(
      `${ENTRYPOINT_PKG} does not reproduce the canonical EntryPoint: CREATE2 predicts ${predicted}, ` +
        `expected ${ENTRYPOINT_V06}. Refusing to run a bundler against an EntryPoint nobody else has.`
    );
  }
  const tx = await deployer.sendTransaction({
    to: CREATE2_DEPLOYER,
    data: ethers.concat([ZERO_SALT, initCode]),
    gasLimit: 6_000_000,
  });
  await tx.wait();
  if ((await ethers.provider.getCode(ENTRYPOINT_V06)) === "0x") {
    throw new Error(`EntryPoint deploy landed no code at ${ENTRYPOINT_V06} (tx ${tx.hash}).`);
  }
  console.log(`EntryPoint v0.6: deployed at ${ENTRYPOINT_V06}`);
}

async function main() {
  const { chainId: raw } = await ethers.provider.getNetwork();
  const chainId = Number(raw);
  assertLocal(chainId);

  const [deployer] = await ethers.getSigners();
  console.log(`passkey-stack bootstrap on ${hre.network.name} (chainId ${chainId}) — deployer ${deployer.address}`);

  await deployCreate2Proxy();
  await deployEntryPoint(deployer);
  await installCanonicalAccountStack(deployer);

  /*
   * A BLOCK HEARTBEAT. alto drives its bundling loop off new blocks; a hardhat node in auto-mine
   * only produces one when someone sends a transaction, so a bundler with a queued UserOp and no
   * other traffic can sit waiting for a block that only it would cause. Interval mining gives it
   * the cadence a real chain has. Harmless here — this job runs only the passkey specs, none of
   * which assert on block height, and the full tier's snapshot/revert isolation does not apply to
   * `e2e/passkey/**`.
   */
  await hre.network.provider.send("evm_setIntervalMining", [1000]);
  console.log("interval mining: 1000ms");

  console.log("\nReady for: deploy-verifying-paymaster.js");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
