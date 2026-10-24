require("@nomicfoundation/hardhat-toolbox");
require("@openzeppelin/hardhat-upgrades");
require("dotenv").config();

const { subtask } = require("hardhat/config");

// Floppy keystore loader for secure key storage
// Usage: npm run floppy:mount && npm run floppy:create (one-time setup)
const {
  getFloppyPrivateKeys,
  isFloppyMounted,
  keystoreExists,
  adminKeystoreExists,
  CONFIG: FLOPPY_CONFIG
} = require('./scripts/operations/floppy-key/loader');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Synchronously decrypt a keystore file
 * Supports both admin keystore (HMAC-SHA256 MAC) and mnemonic keystore (keccak256 MAC)
 * @param {string} keystorePath - Path to the keystore JSON file
 * @param {string} password - Decryption password
 * @returns {Buffer|null} - Decrypted data or null on failure
 */
function decryptKeystoreSync(keystorePath, password) {
  try {
    const keystoreJson = fs.readFileSync(keystorePath, 'utf8');
    const keystore = JSON.parse(keystoreJson);
    const { crypto: cryptoParams } = keystore;
    const keystoreType = keystore.type; // 'admin-private-key' or 'mnemonic'

    const salt = Buffer.from(cryptoParams.kdfparams.salt, 'hex');
    const iv = Buffer.from(cryptoParams.cipherparams.iv, 'hex');
    const ciphertext = Buffer.from(cryptoParams.ciphertext, 'hex');
    const storedMac = Buffer.from(cryptoParams.mac, 'hex');

    // Derive key synchronously (maxmem needed for high N values)
    const derivedKey = crypto.scryptSync(
      password,
      salt,
      cryptoParams.kdfparams.dklen,
      {
        N: cryptoParams.kdfparams.n,
        r: cryptoParams.kdfparams.r,
        p: cryptoParams.kdfparams.p,
        maxmem: 512 * 1024 * 1024  // 512MB for high N values
      }
    );

    // Verify MAC - different algorithms for different keystore types
    let computedMac;
    if (keystoreType === 'admin-private-key') {
      // Admin keystore uses HMAC-SHA256
      computedMac = crypto.createHmac('sha256', derivedKey.slice(16, 32))
        .update(ciphertext)
        .digest();
    } else {
      // Mnemonic keystore uses keccak256(derivedKey[16:32] || ciphertext)
      const { keccak256 } = require('ethers');
      const macInput = Buffer.concat([
        Buffer.from(derivedKey.slice(16, 32)),
        ciphertext
      ]);
      computedMac = Buffer.from(keccak256(macInput).slice(2), 'hex');
    }

    if (!computedMac.equals(storedMac)) {
      return null;
    }

    // Decrypt
    const decipher = crypto.createDecipheriv(
      cryptoParams.cipher,
      derivedKey.slice(0, 16),
      iv
    );
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
  } catch (err) {
    return null;
  }
}

/**
 * Load keys from floppy keystore (admin key or mnemonic)
 * SECURITY: This is the ONLY way to load keys for production networks
 * PRIVATE_KEY fallback only works for localhost/hardhat networks
 *
 * @param {boolean} allowFallback - Whether to allow PRIVATE_KEY fallback (development only)
 * @returns {string[]} Array of private keys, or empty array if not available
 */
function loadFloppyKeysSync(allowFallback = false) {
  if (!isFloppyMounted()) {
    // Not an error, and not worth warning about on every command. The floppy keystore is OPTIONAL
    // for deployment (see the DEPLOYER KEY note above loadDeployerKeys): admin authority lives in
    // the multisig, so an unmounted disk means "sign with the deploy key", not "something is wrong".
    if (allowFallback && process.env.PRIVATE_KEY) return [process.env.PRIVATE_KEY];
    console.warn('[Floppy] Disk not mounted at', FLOPPY_CONFIG.MOUNT_POINT, '— and no PRIVATE_KEY set');
    console.warn('[Floppy] Run: npm run floppy:mount, or set PRIVATE_KEY');
    return [];
  }

  const password = process.env.FLOPPY_KEYSTORE_PASSWORD;
  if (!password) {
    console.warn('[Floppy] FLOPPY_KEYSTORE_PASSWORD not set');
    // Only allow fallback in development mode (hardhat/localhost networks)
    if (allowFallback && process.env.PRIVATE_KEY) {
      console.log('[Floppy] Development mode: Using PRIVATE_KEY env var fallback');
      return [process.env.PRIVATE_KEY];
    }
    return [];
  }

  const keystoreDir = path.join(FLOPPY_CONFIG.MOUNT_POINT, FLOPPY_CONFIG.KEYSTORE_DIR);

  // Try admin keystore first (single private key)
  const adminKeystorePath = path.join(keystoreDir, 'admin-keystore.json');
  if (fs.existsSync(adminKeystorePath)) {
    const decrypted = decryptKeystoreSync(adminKeystorePath, password);
    if (decrypted) {
      console.log('[Floppy] Loaded admin key');
      return ['0x' + decrypted.toString('hex')];
    } else {
      console.warn('[Floppy] Invalid password for admin keystore');
      if (allowFallback && process.env.PRIVATE_KEY) {
        console.log('[Floppy] Using PRIVATE_KEY env var fallback');
        return [process.env.PRIVATE_KEY];
      }
      return [];
    }
  }

  // Try mnemonic keystore (HD wallet)
  const mnemonicKeystorePath = path.join(keystoreDir, 'mnemonic-keystore.json');
  if (fs.existsSync(mnemonicKeystorePath)) {
    const decrypted = decryptKeystoreSync(mnemonicKeystorePath, password);
    if (decrypted) {
      try {
        const mnemonic = decrypted.toString('utf8');
        const { HDNodeWallet } = require('ethers');
        // Derive first account using path parameter directly
        const wallet = HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0");
        console.log('[Floppy] Loaded mnemonic wallet:', wallet.address);
        return [wallet.privateKey];
      } catch (err) {
        console.warn('[Floppy] Failed to derive keys from mnemonic:', err.message);
        return [];
      }
    } else {
      console.warn('[Floppy] Invalid password for mnemonic keystore');
      return [];
    }
  }

  console.warn('[Floppy] No keystore found on disk');
  console.warn('[Floppy] Expected: admin-keystore.json or mnemonic-keystore.json');
  return [];
}

// ---------------------------------------------------------------------------------------------
// DEPLOYER KEY — the floppy keystore is OPTIONAL, deliberately (issue #966).
//
// The air-gapped floppy ceremony existed because the deploy key WAS the admin: it held
// DEFAULT_ADMIN_ROLE and UPGRADER_ROLE on every live contract, so compromising it meant losing the
// protocol. The INTENDED model is that admin authority belongs to the multisig Safe
// (deployments/admin-safe.json — 0xcf76db7aa9Fb1BFe08E010468F3344bB45830447, 2-of-3, same address
// on every supported chain), and the deploy key is a DEPLOYMENT VEHICLE: it pays gas and calls
// CREATE2. Contract addresses are deterministic and independent of who sends the transaction, so a
// compromised deploy key can waste gas and deploy junk — it cannot touch a deployed contract.
//
// THAT MIGRATION IS NOT FINISHED. An earlier version of this comment stated it in the past tense,
// which was wrong and made the blast radius of this key look smaller than it is. Measured: the
// deploy key still holds DEFAULT_ADMIN/UPGRADER and equivalent authority on ~260 (contract, role)
// pairs across eight chains, and is `owner()` on ten Ownable contracts. Granting the Safe was done
// at deploy time on most chains; REVOKING the EOA was never done. Until `scripts/ops/transfer-roles.js`
// has renounced on every chain, this key remains a full admin key — treat it as one.
//
// The superseded Safe 0x8cc564E3dF4003c2F0a33C679c8DfE6237c5c3fa still co-holds those roles and is
// still `feeRouter.treasury()` on chains 1/10/8453/42161; see the `superseded` block in the record.
//
// If the floppy is mounted it is still used, so an operator who wants the ceremony keeps it. If it
// is not, PRIVATE_KEY is used without complaint. What is gone is the per-command warning noise for
// a state that is now normal.
//
// THE CAVEAT THAT MAKES THIS TRUE: it holds only once roles are actually handed to the Safe. Until
// a contract's DEFAULT_ADMIN/UPGRADER is transferred, its deploy key remains its admin and is as
// sensitive as it ever was. Do not read this comment as "the hot key is harmless" — read it as
// "the hot key is harmless for contracts whose admin already lives in the Safe".
// ---------------------------------------------------------------------------------------------
const floppyKeys = loadFloppyKeysSync(true);
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async (args, hre, runSuper) => {
  const solcBuild = await runSuper(args);

  const isCodespaces = Boolean(process.env.CODESPACES || process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN);
  const forceSolcJs =
    (process.env.FORCE_SOLCJS ?? "").toLowerCase() === "true" ||
    (isCodespaces && (process.env.FORCE_NATIVE_SOLC ?? "").toLowerCase() !== "true");

  if (!forceSolcJs) {
    return solcBuild;
  }

  let solcjsPath;
  try {
    solcjsPath = require.resolve("solc/soljson.js");
  } catch (e) {
    throw new Error(
      "solc-js not found. Run `npm install` (or `npm i -D solc@0.8.24`) and retry."
    );
  }

  let longVersion = solcBuild.longVersion;
  try {
    // eslint-disable-next-line global-require
    const solc = require("solc");
    if (typeof solc.version === "function") {
      longVersion = solc.version();
    }
  } catch {
    // ignore
  }

  return {
    version: solcBuild.version,
    longVersion,
    compilerPath: solcjsPath,
    isSolcJs: true,
  };
});

// --- Which network is this invocation acting on? ---
// Used by BOTH the explorer config below (Etherscan V2 vs Blockscout is a per-network
// choice that has to be made at config time) and requiredRpcUrl() further down, which
// only fails on a missing endpoint for the network actually being targeted.
function targetNetworkName() {
  const i = process.argv.indexOf("--network");
  if (i !== -1) return process.argv[i + 1];
  // Hardhat also accepts the network via the HARDHAT_NETWORK env var (no --network flag).
  return process.env.HARDHAT_NETWORK;
}

// --- RPC endpoint resolution ---
// Every network entry below pins an explicit `chainId`, so hardhat rejects an endpoint
// that answers with a different chain instead of trusting it. That guard is only worth
// anything if we never QUIETLY substitute an endpoint of our own: a baked-in public
// default is exactly how a deploy ends up on the wrong chain, or half-finished against a
// rate-limited node with deployments/ already partly written.
//
// So an unset RPC variable is a hard failure — but ONLY for the network being targeted.
// `npx hardhat compile`, `npm test` and the frontend tooling all load this config on
// machines that have no mainnet endpoints configured at all, and they must keep working.
// Networks nobody asked for therefore resolve to an unroutable `.invalid` sentinel that
// names the missing variable if anything ever does reach it (RFC 2606 reserves .invalid,
// so it cannot resolve to a real host).
function requiredRpcUrl(networkName, envVar) {
  const url = process.env[envVar];
  if (url) return url;
  if (targetNetworkName() === networkName) {
    throw new Error(
      `${envVar} is not set, so network '${networkName}' has no RPC endpoint. ` +
        `It is a MANAGED SECRET (spec 097): run the command through the wrapper, which delivers ` +
        `it from Secret Manager — e.g. \`npm run sec -- --profile deploy --network ${networkName} ` +
        `-- npx hardhat <cmd> --network ${networkName}\`. Putting it back in .env is what ` +
        `check:env-hygiene fails on. Refusing to fall back to a public default: a wrong or ` +
        `throttled endpoint here means deploying to the wrong chain or stranding a partial ` +
        `deployments/ record.`
    );
  }
  return `http://${envVar.toLowerCase().replace(/_/g, "-")}-is-unset.invalid`;
}

// --- Block explorer verification (@nomicfoundation/hardhat-verify) ---
// hardhat-verify 2.x selects Etherscan API V2 (the unified endpoint
// api.etherscan.io/v2/api?chainid=<id>) ONLY when etherscan.apiKey is a STRING; a
// per-network OBJECT forces legacy V1 mode and keeps customChains apiURLs. The two
// modes are mutually exclusive in one config, and Etherscan V2 does NOT cover
// Blockscout chains (Ethereum Classic 61 / Mordor 63). So pick the right shape from
// the --network being acted on:
//   * Etherscan family (mainnet 1, optimism 10, polygon 137, base 8453, arbitrum 42161,
//     amoy 80002) -> V2 unified, single ETHERSCAN_API_KEY. One key covers every one of
//     those chains — there is no per-chain key to mint (Polygonscan V1 keys/endpoints were
//     shut off 2025-08-15; mint the key at etherscan.io).
//   * Blockscout (etc 61, mordor 63) -> V1 object + customChains pointing at <host>/api.
//     Blockscout ignores the key value but hardhat-verify needs a non-empty placeholder.
//
// WHICH chain belongs to WHICH family is not decided here: it comes from
// scripts/deploy/lib/explorers.js, the same table scripts/deploy/verify.js pre-flights
// against. Keeping one list means a new network can never be verifiable-per-verify.js but
// unconfigured-per-hardhat (which fails as a confusing "chain not supported" mid-run).
const EXPLORERS = require("./scripts/deploy/lib/explorers");
const BLOCKSCOUT_VERIFY_NETWORKS = new Set(EXPLORERS.blockscoutNetworkNames());
const etherscanConfig = BLOCKSCOUT_VERIFY_NETWORKS.has(targetNetworkName())
  ? // Blockscout (Ethereum Classic mainnet + Mordor). Key value is ignored by the
    // server but must be a non-empty string for hardhat-verify to resolve the chain.
    EXPLORERS.blockscoutVerifyConfig()
  : {
      // Etherscan V2 unified key (covers Ethereum 1, Optimism 10, Polygon 137, Base 8453,
      // Arbitrum One 42161 and Amoy 80002 via the built-in chain list — no customChains
      // needed). Mint at etherscan.io (NOT polygonscan.com / basescan.org / arbiscan.io).
      apiKey: process.env.ETHERSCAN_API_KEY || "",
    };

// Coverage mode: solidity-coverage runs the hardhat `coverage` task. Detect it so
// coverage-only network settings (block-gas headroom for instrumented bytecode —
// spec 046) never leak into `npm test` / gas-report, which must stay realistic.
const COVERAGE = process.env.COVERAGE === "true" || process.argv.includes("coverage");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    // NOTE: use the multi-compiler shape (`compilers: [...]` + `overrides`), NOT the
    // shorthand `{ version, settings, overrides }`. Hardhat treats any solidity config
    // object that has a top-level `version` key as a single SolcUserConfig and SILENTLY
    // DROPS a sibling `overrides` field — so the shorthand form compiles the Semaphore
    // closure below under viaIR:true, which OOM-thrashes the compiler past CI's timeout.
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,  // Optimize for deployment size over runtime gas
          },
          viaIR: true,
          // PIN THE METADATA MODE (spec 080, FR-001). Do NOT remove.
          //
          // `bytecodeHash: "none"` keeps the source-file fingerprint OUT of the compiled bytes.
          // With it the appended CBOR block carries the compiler version and nothing else
          // (measured: 51 bytes -> 10, `a1 "solc" 000818`), so moving or renaming a source file
          // cannot move a contract's bytecode — and therefore cannot move any CREATE2 address
          // derived from it. Without it, reorganising the source tree silently relocates every
          // deterministic address, which is deferred maintenance dressed as determinism.
          //
          // Cost, accepted deliberately: verifiers that compare embedded provenance report a
          // PARTIAL rather than exact match. Verifiers that recompile from declared settings
          // (Etherscan, Blockscout — both used by scripts/deploy/verify.js) are unaffected.
          metadata: { bytecodeHash: "none" },
          // PIN THE EVM TARGET (spec 075, FR-001). Do NOT remove, and do NOT add a compiler
          // entry or an override without it — test/config/CompilerTargets.test.js fails the
          // suite if you do.
          //
          // Until spec 075 this entry declared no evmVersion, so the EVM target of 116 of the
          // repo's 120 contracts was inherited from Hardhat's own internal default
          // (config-resolution.js: `evmVersion ?? "paris"` for solc >= 0.8.20) while hardhat is
          // depended on as a caret range. A hardhat minor moving that default emits PUSH0
          // (shanghai) or MCOPY (cancun) into every contract: undeployable on the live ETC 61 /
          // Mordor 63 targets, and a different CREATE2 address everywhere else — against UUPS
          // proxies at STABLE addresses. Pinning was verified byte-neutral at adoption (all 30
          // build-info records already reported "paris"); see specs/074-monorepo-workspaces/.
          evmVersion: "paris",
        },
      },
      {
        // Vendored Coinbase Smart Wallet closure (contracts/account/, spec 041) pins
        // `pragma solidity 0.8.23` exactly — nothing else in the repo uses this entry.
        // evmVersion "paris" (no PUSH0) keeps the account bytecode deployable byte-identically
        // on every platform network including the later ETC/Mordor increment (FR-022/FR-023).
        version: "0.8.23",
        settings: {
          // spec 080, FR-001 — see the 0.8.24 entry. Both profiles must adopt this or a
          // class of addresses stays path-dependent.
          metadata: { bytecodeHash: "none" },
          optimizer: {
            enabled: true,
            runs: 1,
          },
          viaIR: true,
          evmVersion: "paris",
        },
      },
    ],
    // The vendored Safe v1.4.1 closure (spec 049 test shim contracts/mocks/vendor/) compiles
    // WITHOUT viaIR: Safe's inline assembly is not annotated memory-safe, so the Yul IR pipeline
    // cannot place a memoryguard and dies with a stack-too-deep YulException. The shim is test-only
    // (never deployed by scripts) and no APP contract imports the shim — only the two
    // policy-guard integration suites use the artifacts it pulls in — so legacy codegen here
    // cannot affect the viaIR app contracts.
    //
    // To be precise, since the gate below reasons about exactly this: the Safe closure IS imported,
    // by `contracts/mocks/vendor/SafeVendorImports.sol`, which exists to pull Safe v1.4.1 into the
    // artifact set. That is why the Safe overrides are LIVE and the Semaphore ones below were not.
    //
    // ── DEAD OVERRIDES ARE DELETED, NOT PARKED (spec 075 / issue #1039) ──────────────────────────
    // This block also carried eight overrides for the Semaphore V4 self-deploy closure
    // (`contracts/pools/SemaphoreDeploy.sol` plus `@semaphore-protocol/contracts/*`,
    // `@zk-kit/lean-imt.sol/*` and `poseidon-solidity/PoseidonT3.sol`). Spec 034 removed Semaphore
    // from the pools design and deleted SemaphoreDeploy.sol; nothing under contracts/ has imported
    // any of those packages since, so the entries named files that were never in the compilation.
    // They were pure decoration — and worse than decoration, because an override that matches
    // nothing looks like a live compiler decision when read. `@zk-kit/lean-imt.sol` and
    // `poseidon-solidity` were not even root dependencies (they resolved transitively through
    // `@semaphore-protocol/contracts`, itself then declared as a FLOATING `^4.14.2`), so the config
    // appeared to pin compiler settings for source this repo did not control the version of.
    //
    // The four `@semaphore-protocol/*` manifest entries those resolved through are gone now too.
    // They outlived the source by several specs; `check:deps` reports no phantom import for any of
    // them across 1,935 files, and they were the only reason this tree carried snarkjs, circomkit,
    // circom_tester, `@zk-kit/*`, ffjavascript, poseidon-* and an ethers v5 closure — 93 lockfile
    // entries and 11 advisories, including the snarkjs double-spend, for source nothing compiles.
    //
    // `test/config/CompilerTargets.test.js` now fails on any override whose target is not a real
    // file belonging to a package contracts/ actually imports, so this cannot silently come back.
    overrides: Object.fromEntries([
      // ── THE ONE CANCUN ISLAND (spec 030 pillar A, issue #1268) ─────────────────────────────────
      //
      // Everything else in this repo targets `paris`, because ETC 61 / Mordor 63 are live networks
      // that have neither PUSH0 nor MCOPY. The OpenZeppelin 5.4.0 Governor closure cannot meet that
      // target: `Governor` -> `SignatureChecker` -> `utils/Bytes.sol` uses `mcopy` directly, and no
      // compiler flag emulates it. Spec 030 deferred native DAO creation for exactly this reason.
      //
      // The maintainer's decision (#1268) is to take the LATEST OZ Governor and DROP pre-Cancun
      // chains for THIS CONTRACT ONLY. Native DAO creation therefore ships on the Cancun EVM
      // mainnets + Amoy and is absent — honestly, by decision rather than by deferral — on ETC and
      // Mordor. Pillar B's `ExternalDAORegistry` imports only the `IGovernor` INTERFACE, stays
      // paris, and keeps serving every chain unchanged.
      //
      // WHY THE LIST IS THIS LONG, AND WHY IT IS A LIST. Hardhat builds one compilation job per
      // RESOLVED file — dependencies included, not just the contracts under `contracts/` — and picks
      // that job's settings from the file's OWN override. So overriding only the two first-party
      // contracts leaves `SignatureChecker.sol` (and every Governor file) rooting its own `paris`
      // job that still pulls in `Bytes.sol`, and the build fails with `Function "mcopy" not found`
      // pointing at a file nobody edited. Every file below transitively imports `utils/Bytes.sol`.
      //
      // `TimelockController.sol` and `StandardDAOToken.sol` do NOT import it, and are here for a
      // different reason: `StandardDAOFactory` DEPLOYS both, so their creation code is embedded
      // from ITS job. Left on the default target their committed artifacts would describe `paris`
      // bytes while the factory deployed `cancun` bytes — a source-verification mismatch on a live
      // treasury contract. The artifact must be the thing that gets deployed.
      //
      // Regenerate after changing the pillar-A imports: any file reaching
      // `@openzeppelin/contracts/utils/Bytes.sol` from `contracts/clearpath/StandardDAO*.sol`
      // belongs here. Adding an unrelated file here would silently make it undeployable on ETC and
      // Mordor, which is why `test/config/CompilerTargets.test.js` pins this set exactly.
      ...[
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
      ].map((f) => [
        f,
        // Identical to the 0.8.24 compiler entry in EVERY other setting — only the EVM target moves.
        // A second difference here (optimizer runs, viaIR, metadata) would make the pillar-A
        // bytecode differ from the rest of the estate for a reason nobody chose.
        {
          version: "0.8.24",
          settings: {
            optimizer: { enabled: true, runs: 1 },
            viaIR: true,
            evmVersion: "cancun",
            metadata: { bytecodeHash: "none" },
          },
        },
      ]),
      ...[
        "contracts/mocks/vendor/SafeVendorImports.sol",
        "@safe-global/safe-contracts/contracts/Safe.sol",
        "@safe-global/safe-contracts/contracts/SafeL2.sol",
        "@safe-global/safe-contracts/contracts/base/Executor.sol",
        "@safe-global/safe-contracts/contracts/base/FallbackManager.sol",
        "@safe-global/safe-contracts/contracts/base/GuardManager.sol",
        "@safe-global/safe-contracts/contracts/base/ModuleManager.sol",
        "@safe-global/safe-contracts/contracts/base/OwnerManager.sol",
        "@safe-global/safe-contracts/contracts/common/Enum.sol",
        "@safe-global/safe-contracts/contracts/common/NativeCurrencyPaymentFallback.sol",
        "@safe-global/safe-contracts/contracts/common/SecuredTokenTransfer.sol",
        "@safe-global/safe-contracts/contracts/common/SelfAuthorized.sol",
        "@safe-global/safe-contracts/contracts/common/SignatureDecoder.sol",
        "@safe-global/safe-contracts/contracts/common/Singleton.sol",
        "@safe-global/safe-contracts/contracts/common/StorageAccessible.sol",
        "@safe-global/safe-contracts/contracts/external/SafeMath.sol",
        "@safe-global/safe-contracts/contracts/handler/CompatibilityFallbackHandler.sol",
        "@safe-global/safe-contracts/contracts/handler/HandlerContext.sol",
        "@safe-global/safe-contracts/contracts/handler/TokenCallbackHandler.sol",
        "@safe-global/safe-contracts/contracts/interfaces/ERC1155TokenReceiver.sol",
        "@safe-global/safe-contracts/contracts/interfaces/ERC721TokenReceiver.sol",
        "@safe-global/safe-contracts/contracts/interfaces/ERC777TokensRecipient.sol",
        "@safe-global/safe-contracts/contracts/interfaces/IERC165.sol",
        "@safe-global/safe-contracts/contracts/interfaces/ISignatureValidator.sol",
        "@safe-global/safe-contracts/contracts/interfaces/ViewStorageAccessible.sol",
        "@safe-global/safe-contracts/contracts/libraries/MultiSendCallOnly.sol",
        "@safe-global/safe-contracts/contracts/libraries/SafeStorage.sol",
        "@safe-global/safe-contracts/contracts/proxies/IProxyCreationCallback.sol",
        "@safe-global/safe-contracts/contracts/proxies/SafeProxy.sol",
        "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol",
        // `evmVersion: "paris"` is REQUIRED here, not decorative (spec 075, FR-001). An override
        // that omits it inherits Hardhat's internal default exactly as a compiler entry does —
        // verified: before spec 075 the user config declared evmVersion on 0 of these 38 entries
        // while the resolved config reported it on all 38, so the omission was invisible.
      ].map((f) => [
        f,
        { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 1 }, viaIR: false, evmVersion: "paris", metadata: { bytecodeHash: "none" } } },
      ]),
    ]),
  },
  networks: {
    hardhat: {
      // Default 1337. The full E2E tier boots the node as HARDHAT_LOCAL_CHAIN_ID=80002 so the
      // local chain IS the app's membership home: spec 071 pins membership reads AND purchase
      // settlement to membershipChainId() (Amoy on a testnet cohort), and that constant is
      // deliberately not runtime-configurable — so the node impersonates Amoy rather than the
      // app being taught to trust a different chain. Local deploys are deterministic by
      // (deployer, nonce), which is chain-id-independent, so the deployed addresses are
      // byte-identical to the committed 1337 set.
      chainId: Number(process.env.HARDHAT_LOCAL_CHAIN_ID) || 1337,
      allowUnlimitedContractSize: true,
      // Coverage instrumentation balloons the WagerRegistry deploy far past 2**24 gas.
      // Hardhat's default hardfork (osaka) enables EIP-7825, which CAPS per-tx gas at
      // 2**24 (~16.7M) — so instrumented deploys "run out of gas" (spec 046 root cause).
      // solidity-coverage keys its per-tx gas limit off networks.hardhat.hardfork: any
      // hardfork < osaka disables the cap and it uses 0xffffffffff (~1.1T) instead.
      // Pin the highest pre-osaka fork (prague) ONLY under coverage; non-coverage runs
      // (npm test / gas report) keep the realistic default. The account WebAuthn path
      // falls back to the FreshCryptoLib verifier when the osaka P256 precompile is absent.
      // HARDHAT_HARDFORK is the same lever for the on-chain e2e tier. The local node impersonates
      // Polygon Amoy (no EIP-7825), yet under the osaka default the ClearPath native-DAO deploy
      // (full/42, ~6.4M gas) was refused at eth_estimateGas with "transaction gas limit
      // (19069152) is greater than the cap (16777216)" — the wallet rail's buffered limit meets
      // the osaka per-tx cap, which the chain this node stands in for does not have. The full
      // tier pins prague; the passkey full-stack tier keeps the default so its P256 path runs
      // against the precompile the way it does on Polygon.
      ...(process.env.HARDHAT_HARDFORK ? { hardfork: process.env.HARDHAT_HARDFORK } : COVERAGE ? { hardfork: "prague" } : {}),
      accounts: {
        count: 20, // More accounts for integration tests
        accountsBalance: "100000000000000000000000", // 100,000 ETH each - increased to handle bond-heavy tests
      },
      mining: {
        auto: true,
        interval: 0,
      },
      // Fork mode for oracle fork tests. Activated by setting AMOY_RPC_URL.
      forking: process.env.AMOY_RPC_URL ? {
        url: process.env.AMOY_RPC_URL,
        blockNumber: process.env.AMOY_FORK_BLOCK ? parseInt(process.env.AMOY_FORK_BLOCK, 10) : undefined,
      } : undefined,
      // Hardfork activation history for the chains spec-067 fork tests reset onto
      // (test/fork/bridgeRouter.fork.test.js, liquidityRouter.fork.test.js).
      //
      // Hardhat only ships an activation history for Ethereum mainnet; forking any other
      // chain fails with "No known hardfork for execution on historical block N ... The node
      // was not configured with a hardfork activation history." Declaring the history here is
      // the documented fix.
      //
      // `cancun: 0` is a deliberate simplification, not a historical claim: these fork tests
      // only ever reset onto a RECENT block, and all five networks are well past their
      // Cancun-equivalent upgrade today, so the semantics applied to the blocks we actually
      // execute against are correct. Do NOT rely on this config to replay genuinely historical
      // blocks — pin a real activation history first if that is ever needed.
      chains: {
        10: { hardforkHistory: { cancun: 0 } },     // Optimism
        137: { hardforkHistory: { cancun: 0 } },    // Polygon
        8453: { hardforkHistory: { cancun: 0 } },   // Base
        42161: { hardforkHistory: { cancun: 0 } },  // Arbitrum One
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    mordor: {
      url: process.env.MORDOR_RPC_URL || "https://rpc.mordor.etccooperative.org",
      chainId: 63,
      // Deployer key: floppy keystore when mounted, else PRIVATE_KEY from .env
      // (loadFloppyKeysSync allowFallback=true). Explorer: Blockscout (no API key).
      accounts: floppyKeys,
      // Legacy chain (no EIP-1559). The gas-price oracle suggests ~300 gwei, which
      // pushes the ~4.76M-gas WagerRegistry deploy over the node's 1 ETH tx-fee cap.
      // Pin a lower legacy gasPrice via GAS_PRICE_WEI (e.g. 100000000000 = 100 gwei).
      ...(process.env.GAS_PRICE_WEI ? { gasPrice: Number(process.env.GAS_PRICE_WEI) } : {}),
    },
    // Ethereum Classic mainnet (chainId 61). MAINNET — deploy.js requires
    // CONFIRM_MAINNET=true. Explorer verification is Blockscout (etc.blockscout.com).
    etc: {
      url: process.env.ETC_RPC_URL || "https://etc.etcdesktop.com", // was etc.rivet.link (NXDOMAIN)
      chainId: 61,
      accounts: floppyKeys,
      ...(process.env.GAS_PRICE_WEI ? { gasPrice: Number(process.env.GAS_PRICE_WEI) } : {}),
    },
    amoy: {
      // rpc-amoy.polygon.technology no longer resolves at all (ENOTFOUND, not a 4xx), so it is a
      // dead default that fails every Amoy run before a request is even made. publicnode answers
      // eth_chainId 0x13882 and serves state + logs.
      url: process.env.AMOY_RPC_URL || "https://polygon-amoy-bor-rpc.publicnode.com",
      chainId: 80002,
      accounts: floppyKeys,
      ...(process.env.GAS_PRICE_WEI ? { gasPrice: Number(process.env.GAS_PRICE_WEI) } : {}),
    },
    // Polygon mainnet (production). Deployer key: floppy keystore when mounted,
    // else PRIVATE_KEY from .env (loadFloppyKeysSync allowFallback=true) — keep the
    // production key on the floppy. Prefer a paid POLYGON_RPC_URL over the public
    // endpoint. deploy.js requires CONFIRM_MAINNET=true for chainId 137. Explorer
    // verification is Polygonscan via Etherscan V2 (ETHERSCAN_API_KEY).
    polygon: {
      url: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
      chainId: 137,
      accounts: floppyKeys,
      ...(process.env.GAS_PRICE_WEI ? { gasPrice: Number(process.env.GAS_PRICE_WEI) } : {}),
    },
    // ------------------------------------------------------------------------
    // Control-plane mainnets: Ethereum 1, Optimism 10, Base 8453, Arbitrum 42161.
    // Targets for FeeRouter (spec 060) and BridgeRouter/LiquidityRouter (spec 067),
    // which ship on all five EVM mainnets alongside Polygon above.
    //
    // Shape matches `polygon`: explicit chainId (so a mis-set RPC is REJECTED rather
    // than deployed against), floppy-keystore deployer with the .env PRIVATE_KEY
    // fallback, endpoint from .env via requiredRpcUrl (no public default — see the
    // helper). All four are MAINNETS: they are in MAINNET_CHAIN_IDS
    // (scripts/deploy/lib/constants.js), so deploy scripts demand CONFIRM_MAINNET=true
    // and refuse to substitute mock tokens.
    //
    // GAS: none of these reads GAS_PRICE_WEI, and that omission is deliberate. That
    // variable pins a LEGACY (type-0) gasPrice and exists for the pre-EIP-1559 Classic
    // chains (and as an escape hatch on Polygon, whose ~25-30 gwei bor minimum makes an
    // under-quote fatal). It is one global env var, so honouring it here would mean a
    // shell that still had the Polygon value exported would silently send Polygon-priced
    // legacy transactions to Ethereum and the L2s — overpaying by orders of magnitude on
    // the L2s, and opting out of the 1559 fee market these chains' providers price
    // correctly on their own. Let the provider price each chain. If a specific deploy
    // genuinely needs a fee override, set it on that transaction, not on the network.
    mainnet: {
      url: requiredRpcUrl("mainnet", "MAINNET_RPC_URL"),
      chainId: 1,
      // Deployer key: floppy keystore when mounted, else PRIVATE_KEY from .env
      // (loadFloppyKeysSync allowFallback=true) — keep the production key on the floppy.
      accounts: floppyKeys,
    },
    // OP Stack. The L1 data fee is charged by the chain outside the gas price we set,
    // so an L2-shaped priority fee here does NOT mean the transaction is cheap overall;
    // that is another reason not to pin one.
    optimism: {
      url: requiredRpcUrl("optimism", "OPTIMISM_RPC_URL"),
      chainId: 10,
      accounts: floppyKeys,
    },
    base: {
      url: requiredRpcUrl("base", "BASE_RPC_URL"),
      chainId: 8453,
      accounts: floppyKeys,
    },
    // Arbitrum One. Its gas LIMIT (not price) absorbs the L1 calldata cost, so estimates
    // look large and vary between blocks — that is expected; do not pin `gas` to "fix" it.
    arbitrum: {
      url: requiredRpcUrl("arbitrum", "ARBITRUM_RPC_URL"),
      chainId: 42161,
      accounts: floppyKeys,
    },
    // NOTE: there used to be a commented-out "mainnet-floppy" example here that defaulted
    // to a public endpoint. The real `mainnet` entry above supersedes it: floppy loading is
    // already handled once by loadFloppyKeysSync() and the endpoint must come from .env.
    // Mordor testnet with floppy keystore
    // Note: Use `mordor` network for regular testing, or set PRIVATE_KEY env var
    // "mordor-floppy": {
    //   url: "https://rpc.mordor.etccooperative.org",
    //   chainId: 63,
    //   // accounts must be synchronous or use lazyFunction helper
    //   accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    // },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 120000, // 2 minutes for integration tests
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS ? true : false,
    currency: "USD",
    outputFile: process.env.REPORT_GAS ? "gas-report.txt" : undefined,
    noColors: process.env.REPORT_GAS ? true : false,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
  },
  // Network-aware: Etherscan V2 for the Etherscan-family chains (1/10/137/8453/42161/80002),
  // Blockscout for etc/mordor. Family per chain lives in scripts/deploy/lib/explorers.js;
  // see targetNetworkName()/etherscanConfig above for how the shape is chosen.
  etherscan: etherscanConfig,
};
