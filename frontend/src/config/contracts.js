/**
 * Deployed Contract Addresses
 *
 * Active network is selected via VITE_NETWORK_ID. Each network has its own
 * deployment record. Addresses are deterministic via Safe Singleton Factory,
 * so re-running deploy scripts produces the same addresses.
 *
 * Last updated: 2026-05-09 (Amoy network added for Polymarket integration)
 */

// Network metadata (names, explorers, native currency) lives in networks.js,
// the single source of truth. We import it here to pair on-chain deployments
// with their display info for getDeployedNetworks(). Safe from import cycles:
// networks.js intentionally does NOT import from this file.
import { NETWORKS } from './networks'
// Tenant contract-set resolution (spec 072): a DEDICATED tenant resolves only
// its own generated set; shared-mode tenants (incl. the default) fall through
// to the per-chain maps below. tenant.js has no import back into this file.
import { isDedicatedTenant, tenantContractsForChain } from './tenant'

// Mordor (Ethereum Classic testnet, chainId 63) — v2 P2P betting deployment.
// CORE ONLY: no oracle adapters (ETC has no Polymarket/Chainlink/UMA), so those
// keys are intentionally absent and their capability tags read "unavailable".
// The legacy v1 Mordor deployment is retired (Spec 015 FR-017). Deployed +
// verified on Blockscout (etc-mordor.blockscout.com) 2026-06-16; addresses are
// kept in sync from the record via:
//   npx hardhat run scripts/deploy/deploy.js --network mordor
//   npm run sync:frontend-contracts -- --network mordor --chainId 63
const MORDOR_CONTRACTS = {
  deployer: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
  treasury: '',
  wagerRegistry: '0x3ccB144d8aa838e8d4D695867cC72e548117830C',
  membershipManager: '0x68bCBA1055DAbe11b98Bb8425A16e648Ad65d541',
  keyRegistry: '0xcEFdeBba8E040c035c690ca9057cF22E73247c24',
  sanctionsGuard: '0xdF41355dD5E47FCA4eE2F2205af4C70Dab8C13B3',
  // Classic USD (USC) — real on-chain stablecoin (no mock); set by sync.
  paymentToken: '0xDE093684c796204224BC081f937aa059D903c52a',
  wmatic: '0x1953cab0E5bFa6D4a9BaD6E05fD46C1CC6527a5a',
  membershipVoucher: '0xf514e0e342A898E4681bf51590B672aEC5620401',
  voucherBatchMinter: '0xc26F02da923263e2c9CFB722006e0B8Da2F952B2',
  tokenFactory: '0x5bdf74Ce98D41bf35192c20B25ACd561C75CFe62',
  externalDAORegistry: '0xcEE0fb2e1407f0A0d19Bcf4Fee2726A3005FA3C0',
  // NOTE: there is deliberately NO `standardDaoFactory` key here, and none is coming (issue #1268).
  // Mordor's EVM is pre-Cancun, so OpenZeppelin 5.4.0's Governor — which uses MCOPY — cannot be
  // deployed on it at all. The absence IS the answer: ClearPath's Launch tab names that reason,
  // while the registry above keeps serving register/track/govern on this chain unchanged.
  backupPointerRegistry: '0x664ACAd4d604c626A6160948Df9C10FE38010E11',
  // Wager Pools (spec 034, address-based — Semaphore removed). Pending the fresh WagerPoolFactory
  // deploy; populated by `npm run sync:frontend-contracts` after `deploy-wager-pool-factory.js`.
  // The prior Semaphore-based factory (0x33cD…) is abandoned and intentionally NOT wired here.
  wagerPoolFactory: '0xac78B4EdeF96e74a2653028dF93A26acFCfC613F',
  // Funding pools (spec 103) — sibling factory of wagerPoolFactory. Empty until
  // `deploy-funding-pool-factory.js` runs; populated by `npm run sync:frontend-contracts`.
  fundingPoolFactory: '',
  // Callsigns (spec 054) — %callsign naming registry. Empty until `deploy-callsign-registry.js` runs;
  // populated by `npm run sync:frontend-contracts`.
  callsignRegistry: '',
  // Mini-app registry (spec 073) — the curation authority for the Apps catalog. Empty until
  // `deploy-miniapp-registry.js` runs; populated by `npm run sync:frontend-contracts`.
  // Undeployed ⇒ the catalog says so and refuses every launch: a package is only ever fetched
  // and executed against an Approved on-chain record (FR-010/FR-011), so "no registry" can
  // never degrade into "run it anyway".
  miniAppRegistry: '0xFEd626025225A3B1aB3BA72D429B8c9C74cb5058',
  // Staking control surface (spec 066). Empty until `deploy-staking-router.js` runs; sync populates it.
  // Undeployed ⇒ the member app falls back to spec-065 fee-free direct staking.
  stakingRouter: '',
  // Cross-chain bridge + liquidity supply (spec 067). Empty until
  // `deploy-bridge-liquidity.js` runs; `npm run sync:frontend-contracts` populates them.
  // Undeployed ⇒ the Bridge surface hides and Earn → Supply shows its honest
  // per-network empty state (FR-051) — never invented availability.
  bridgeRouter: '',
  liquidityRouter: '',
  safeProposalHub: '0x94b5b38C247CE51F7C42C83B63115998b7e970E7',
  safePolicyGuardV2: '0xf18B813Ad8C01249FE904A732543A1b8E6CAfd0c',
  policyGuardSetup: '0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b',
  feeRouter: '0x5249e3008Cb1Eb81B5BF39148B7760B1c36e516e',
  entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  accountFactory: '0xd519C25e9dEd0DAC586B764574100479CB318734',
}

// Local Hardhat sandbox (chainId 1337) — populated by deploy.js + sync.
const HARDHAT_CONTRACTS = {
  deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  treasury: '',
  wagerRegistry: '0x9A676e781A523b5d0C0e43731313A708CB607508',
  membershipManager: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
  keyRegistry: '0xA5EB1dEB58Ebc18D334d72EDDED5406e612D042A',
  // Spec 032 backup pointer. Deterministic (CREATE2) so a fresh local chain reproduces it;
  // deployed by `npm run deploy:local:backup-pointer` inside setup:e2e.
  backupPointerRegistry: '0x73722720e024fED5840361437f55dfd44acc5460',
  sanctionsGuard: '0xA3Fd27637C50a407E43B2CF889E83CdABF070D17',
  polymarketAdapter: '0xeA913b1a96D9447080bBfA7Cb7C397ae0A0fcADB',
  paymentToken: '0xbc4D54AE49ED9C6075770CD6acA930A728dcf526',
  // Passkey smart-account stack (spec 041). NOT nonce-derived like everything else in this block:
  // the implementation and factory are CREATE2-deployed from the canonical Arachnid proxy with a
  // fixed salt and EntryPoint v0.6 sits at its canonical address, so FR-023 makes all three the
  // SAME addresses on every chain — including a local node the passkey full-stack e2e job has
  // bootstrapped (scripts/e2e/passkey-stack/deploy-passkey-stack.js, which fails loudly if the
  // deterministic deploy does not reproduce them). They are stated here because
  // `requirePasskeySupport` reads them per chain: without them the local 80002 impersonation can
  // sign in but can submit no UserOp at all. A plain local sandbox that has not run that bootstrap
  // has no bundler configured either, so `isPasskeySupported` still answers false there.
  entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  accountFactory: '0xd519C25e9dEd0DAC586B764574100479CB318734',
  // Spec 108: the local wrapped native is now the WETH9-shaped MockWNative (payable
  // deposit()/withdraw()), because the Wrap surface's on-chain flow runs a REAL wrap here.
  // CREATE2 (salt V2+"MockWMATIC" + MockWNative init code), so the address is the same on
  // every clean local chain; re-derived from a fresh node:e2e + setup:e2e run.
  wmatic: '0x637914a81B4F67BeA3acd94fc5a233656f8C08f7',
  /*
   * spec 030 pillar A — the native standard-DAO factory. NONCE-DERIVED, deployed by
   * `deploy:local:clearpath` (which `setup:e2e` runs after the seed); recorded from a clean
   * `node:e2e` + `setup:e2e` run and verified by `check:e2e-addresses` on every full-tier run.
   * Without this key the app resolves `null` and ClearPath's Launch tab honestly says
   * "not deployed" — the app working, which is why full/42-clearpath-native-dao.cy.js asserts
   * the precondition first.
   */
  standardDaoFactory: '0x172076E0166D1F9Cc711C77Adf8488051744980C',
  // spec 049 — multisig policy engine (synced from deployments/hardhat-chain1337-v2.json)
  safePolicyGuard: '0xBE509C8E6c4F132e2Af49761A318FfA362e9CE38',
  // Spec 068 ordered rule engine; deployed alongside v1 (both guards stay live — vaults adopt V2
  // through a threshold-approved setGuard, never a forced migration).
  safePolicyGuardV2: '0xc01E5F3EAFd2C0138e98382A3F54B6CeB3dc05cf',
  policyGuardSetup: '0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b',
  safeProposalHub: '0x94b5b38C247CE51F7C42C83B63115998b7e970E7',
  /*
   * spec 073 — the mini-app catalog registry, the trust boundary for which packages the host
   * fetches, verifies and EXECUTES. On a shipped build this key is empty here and the catalog
   * resolves to Polygon or Mordor; the local node gets one so the 073 flows can submit a package,
   * approve it, and swap it under the curator — none of which is possible against a public chain.
   * Deployed by `scripts/deploy/deploy-miniapp-registry.js`, which `setup:e2e` runs LAST so no
   * earlier nonce-derived address moves. See `miniAppChainId()` in config/networks.js.
   */
  miniAppRegistry: '0x5081a39b8A5f0E35a8D959395a630b68B74Dd30f',
  /*
   * spec 066 — the staking control surface. Deployed on the local node by
   * `scripts/deploy/deploy-staking-router.js` (which also stands up the Lido/sPOL/Polygon
   * doubles it points at), so the specs 065/066 flows have a router to read, pause and
   * curate. NONCE-DERIVED from the `setup:e2e` order, like every address in this block.
   */
  stakingRouter: '0xB0D4afd8879eD9F52b28595d31B441D079B2Ca07',
  // Cross-chain bridge + liquidity supply (spec 067). Empty until
  // `deploy-bridge-liquidity.js` runs; `npm run sync:frontend-contracts` populates them.
  // Undeployed ⇒ the Bridge surface hides and Earn → Supply shows its honest
  // per-network empty state (FR-051) — never invented availability.
  /*
   * Spec 067 routers. NONCE-DERIVED like the two entries at the bottom of this map, and for the
   * same reason: `deploy-bridge-liquidity.js` runs as a targeted deploy inside `setup:e2e` (after
   * the custody fixtures, before the seed) and `deployProxy` uses plain CREATE. Inserting or
   * reordering a deploy in that script silently repoints these at addresses nothing was deployed
   * to — `frontend/cypress/e2e/full/30-bridge-liquidity.cy.js` asserts both against the chain, so
   * a reordering fails saying so rather than as "the Bridge surface is unavailable".
   *
   * On a local chain the routers point at contracts/mocks stand-ins for Across and Uniswap, which
   * that same script deploys. They are test doubles and cannot reach a real network.
   */
  bridgeRouter: '0x4c5859f0F772848b2D91F1D83E2Fe57935348029',
  liquidityRouter: '0x5f3f1dBD7B74C6B46e8c44f98792A1dAf8d69154',
  membershipVoucher: '0xF2fc5Ac192E7e48B2EE95D3528870c6ED26908e4',
  voucherBatchMinter: '0xE0b0F625F876f7D78413cc6c402FB92C8E47Ea05',
  tokenFactory: '0x4A679253410272dd5232B3Ff7cF5dbB88f295319',
  /*
   * spec 030 — ClearPath's ExternalDAORegistry. NONCE-DERIVED, and it is the LAST deploy
   * `setup:e2e` performs (after the seed, deliberately: appending there left every address
   * above it byte-identical). It exists locally because the ClearPath mini-app declares
   * `externalDAORegistry` in its manifest, and `host.contracts(name)` THROWS for a declared
   * name it cannot resolve — so without this entry the app's own Register surface would refuse
   * before reaching the chain, and the e2e flow would be measuring a missing constant.
   */
  externalDAORegistry: '0x36b58F5C1969B7b6591D752ea6F5486D069010AB',
  /*
   * spec 054 — the %callsign registry. NONCE-DERIVED, deployed by `deploy:local:callsigns`, which
   * runs after the swap doubles and before the package publish. Registration is Gold-gated and
   * commit→reveal, so the on-chain flow needs a registry it can actually write to; a shipped build
   * still resolves this from the per-network maps above (Polygon has one, Mordor does not yet).
   */
  callsignRegistry: '0xf953b3A269d80e3eB0F2947630Da976B896A8C5b',
  /*
   * THE TWO ENTRIES BELOW ARE NONCE-DERIVED, AND THEIR ORDER IS THE `setup:e2e` ORDER.
   *
   * Both come from targeted deploys that run AFTER `deploy:local` (`deploy:local:pools`, then
   * `deploy:local:fees`), and `deployProxy` uses plain CREATE — so each address is a function of
   * the deployer's nonce at that moment. Inserting or reordering a deploy in `setup:local` /
   * `setup:e2e` silently repoints these at addresses nothing was deployed to; the note beside
   * those scripts in package.json says the same thing from the other end.
   *
   * They are hardcoded rather than synced because the E2E tier deliberately does not run
   * `sync:frontend-contracts` (it would overwrite AMOY_CONTRACTS' real addresses with local
   * ones), so these constants are what the app actually resolves.
   */
  // spec 034 — Wager Pools factory (address-based, no Semaphore).
  wagerPoolFactory: '0xc3e53F4d16Ae77Db1c982e75a937B9f60FE63690',
  // Funding pools (spec 103). NONCE-DERIVED — deployed by `deploy-funding-pool-factory.js`, which
  // `setup:e2e` runs LAST so no earlier nonce-derived address moves (#1289). Recorded from a real run.
  fundingPoolFactory: '0x18E317A7D70d8fBf8e6E893616b52390EbBdb629',
  /*
   * spec 060 — the platform-fee source of truth.
   * `frontend/cypress/e2e/full/25-platform-fees.cy.js` asserts this against the address the chain
   * actually holds, so a reordering fails with the reason rather than as "deposits are paused".
   */
  feeRouter: '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9',
}

// Polygon Amoy testnet deployment (v2 — P2P betting architecture)
// Run: npx hardhat run scripts/deploy/deploy.js --network amoy
//      npm run sync:frontend-contracts -- --network amoy --chainId 80002
const AMOY_CONTRACTS = {
  deployer: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
  treasury: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
  // v2 core (populated by `npm run sync:frontend-contracts -- --network amoy --chainId 80002`)
  wagerRegistry: '0xA429CdaD3E1497e33BEA7D6FE7d6913fE880241b',
  membershipManager: '0x89158f2E044C73c687dA12B7FA42b94F9A6D8465',
  keyRegistry: '0xcEFdeBba8E040c035c690ca9057cF22E73247c24',
  sanctionsGuard: '0xdF41355dD5E47FCA4eE2F2205af4C70Dab8C13B3',
  polymarketAdapter: '0x98fe63209f5BffcCe905bF8779a1F06576A2C313',
  // Stake / payment tokens (Circle USDC + wrapped native (WPOL) on Amoy)
  paymentToken: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  wmatic: '0x0ae690AAD8663aaB12a671A6A0d74242332de85f',
  chainlinkDataFeedAdapter: '0x7ae8220Dc02D0504EDCBa2C1B1AbA579AA3F0f23',
  chainlinkFunctionsAdapter: '0x074fC18C1E322a7537b53B8B2Bf0762629E3b532',
  umaAdapter: '0xcEa9b4A01CcD3aA6545ea834a268C69e7eEfee88',
  membershipVoucher: '0x33C8Ccacf6442Cf4238f01419e38C781cB859769',
  voucherBatchMinter: '0x929A8E9778f26eC49Ba6ed66343e6788f4c689C1',
  callsignRegistry: '', // spec 054 — %callsign naming registry (synced after deploy)
  // Spec 073 — deliberately NOT a deployment target, and NOT "pending". The mini-app registry
  // ships to Polygon and Mordor only, and `miniAppChainId()` sends every testnet build to
  // Mordor 63. The key stays for shape parity with the other chains; deploying one here would
  // create a second testnet catalog that nothing reads.
  miniAppRegistry: '',
  stakingRouter: '', // spec 066 — staking control surface + liquid fee router (synced after deploy)
  // Cross-chain bridge + liquidity supply (spec 067). Empty until
  // `deploy-bridge-liquidity.js` runs; `npm run sync:frontend-contracts` populates them.
  // Undeployed ⇒ the Bridge surface hides and Earn → Supply shows its honest
  // per-network empty state (FR-051) — never invented availability.
  bridgeRouter: '',
  liquidityRouter: '',
  entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  verifyingPaymaster: '0xA00A06ae44FA2bd40Ec10D9613c96afD779b6898', // spec 050 — sponsored-gas paymaster (EntryPoint v0.6)
  accountFactory: '0xd519C25e9dEd0DAC586B764574100479CB318734',
  standardDaoFactory: '', // spec 030 pillar A — native standard-DAO factory (synced after deploy)
}

// Polygon mainnet deployment (v2 — P2P betting architecture) — LIVE
// Run: npx hardhat run scripts/deploy/deploy.js --network polygon
//      npm run sync:frontend-contracts -- --network polygon --chainId 137
const POLYGON_CONTRACTS = {
  deployer: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
  // Treasury / membership-sales recipient = chipprbots.eth (hardware wallet).
  treasury: '0x1215185387E70a48b07D73AcB67002A073F18575',
  // v2 core (populated by `npm run sync:frontend-contracts -- --network polygon --chainId 137`)
  wagerRegistry: '0xE878b62887fC8A5F739B8Ce61bC19546A280Ef89',
  membershipManager: '0xEfd1a880c6BfBf38A661A3F5fF6d5ECB296D557a',
  keyRegistry: '0xcEFdeBba8E040c035c690ca9057cF22E73247c24',
  sanctionsGuard: '0x2Dc53d91A189be71DfE96Ea9BCFCF6aDDA77BC76', // Spec 007 compliance guard
  polymarketAdapter: '0x83688e9b8D4f085E3eF4619D91e0e6303cFcf0A4', // tie-fix + admin-owner redeploy
  // Stake / payment tokens (Circle USDC + wrapped native (WPOL) on Polygon)
  paymentToken: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  wmatic: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  chainlinkDataFeedAdapter: '0x7ae8220Dc02D0504EDCBa2C1B1AbA579AA3F0f23',
  chainlinkFunctionsAdapter: '0x148C2E347a601AC1a680b17321529b0Ffc31AeFc',
  umaAdapter: '0x8224433d099Af6cd30540A78421aBFd6e044E949',
  membershipVoucher: '0xCB28DC438564672067a6f84131B5130e6Cf7ECC6',
  voucherBatchMinter: '0x4b50d24ca28CbDC029714e5830f7D16a0ebEDb0e',
  tokenFactory: '0x5806e76cA3c838524E7cF43db7625bdFBA0783a0',
  wagerPoolFactory: '0x420aEC3c76859eB74ab21c769c16AcdAB221f723',
  // Funding pools (spec 103) — sibling factory of wagerPoolFactory. Empty until
  // `deploy-funding-pool-factory.js` runs; populated by `npm run sync:frontend-contracts`.
  fundingPoolFactory: '',
  entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  verifyingPaymaster: '0xe14554D14eB5DeC47f7824ebeeDa6C9f3A50d105', // spec 050 — sponsored-gas paymaster (EntryPoint v0.6)
  accountFactory: '0xd519C25e9dEd0DAC586B764574100479CB318734',
  backupPointerRegistry: '0x664ACAd4d604c626A6160948Df9C10FE38010E11',
  safeProposalHub: '0x94b5b38C247CE51F7C42C83B63115998b7e970E7',
  safePolicyGuard: '0xa0F188776a65794cc06777412432e47dcB0d0c4B',
  policyGuardSetup: '0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b',
  callsignRegistry: '0x22BD6Dd351Db375b64C2886Bda6f3E3F4fd31dA2', // spec 054 — %callsign naming registry (synced after deploy)
  miniAppRegistry: '0x5a168Cc9FeFaf40e7BC536C8C61669e6d547A0A2', // spec 073 — mini-app catalog registry (synced after deploy)
  stakingRouter: '', // spec 066 — staking control surface + liquid fee router (synced after deploy)
  // Cross-chain bridge + liquidity supply (spec 067). Empty until
  // `deploy-bridge-liquidity.js` runs; `npm run sync:frontend-contracts` populates them.
  // Undeployed ⇒ the Bridge surface hides and Earn → Supply shows its honest
  // per-network empty state (FR-051) — never invented availability.
  bridgeRouter: '0x8064F3Cd9F8f113691B981d2B15EF85D95Abd551',
  liquidityRouter: '0x13762c059c2A22E3bCd8A44F36EA44e8e3B22B31',
  safePolicyGuardV2: '0xf18B813Ad8C01249FE904A732543A1b8E6CAfd0c',
  feeRouter: '0xf8161fC26172621E9fbcc6c39500Bb14b0902B35',
  // spec 030 pillar A — native standard-DAO factory. Empty until
  // `deploy-clearpath.js` runs; `npm run sync:frontend-contracts` populates it.
  // Undeployed ⇒ ClearPath's Launch tab says so honestly and offers nothing.
  standardDaoFactory: '',
}

// Ethereum Classic mainnet (chainId 61) — CUSTODY ONLY. ETC hosts no FairWins wager/membership
// deployment; it gained a contracts block with spec 068 so Protect vaults can live there (Safe
// v1.4.1 is canonical on ETC). Every other lookup honestly resolves empty.
//   npx hardhat run scripts/deploy/custody/deploy-policy-guard-v2.js --network etc
//   npm run sync:frontend-contracts -- --network etc --chainId 61
const ETC_CONTRACTS = {
  deployer: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
  safeProposalHub: '0x94b5b38C247CE51F7C42C83B63115998b7e970E7',
  safePolicyGuardV2: '0xf18B813Ad8C01249FE904A732543A1b8E6CAfd0c',
  policyGuardSetup: '0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b',
  entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  accountFactory: '0xd519C25e9dEd0DAC586B764574100479CB318734',
}

// Spec 067 bridge/liquidity networks. These chains host NO FairWins wager/membership
// deployment — only the two spec-067 routers — so their maps carry just those keys and
// every other lookup honestly resolves empty.
const ETHEREUM_CONTRACTS = {
  bridgeRouter: '0x258181DF2aa45EA3a3eAC748d6491D5e1f2675eE',
  liquidityRouter: '0x1afcAC1949BD306F7D4818999f509941F2E85582',
  feeRouter: '0xB9F80D6D4CfD3ecC60b63810aDF9d88931D0e3d3',
  deployer: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
  entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  accountFactory: '0xd519C25e9dEd0DAC586B764574100479CB318734',
}

const OPTIMISM_CONTRACTS = {
  bridgeRouter: '0x1afcAC1949BD306F7D4818999f509941F2E85582',
  liquidityRouter: '0xA273aF8ebB76d1D0Dcd55692C1f5a7db956F7EED',
  safeProposalHub: '0x94b5b38C247CE51F7C42C83B63115998b7e970E7',
  safePolicyGuardV2: '0xf18B813Ad8C01249FE904A732543A1b8E6CAfd0c',
  policyGuardSetup: '0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b',
  feeRouter: '0x98218248CA53Dd88159979af20172C86b94e8B29',
  deployer: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
  entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  accountFactory: '0xd519C25e9dEd0DAC586B764574100479CB318734',
}

const BASE_CONTRACTS = {
  bridgeRouter: '0x1afcAC1949BD306F7D4818999f509941F2E85582',
  liquidityRouter: '0xA273aF8ebB76d1D0Dcd55692C1f5a7db956F7EED',
  safeProposalHub: '0x94b5b38C247CE51F7C42C83B63115998b7e970E7',
  safePolicyGuardV2: '0xf18B813Ad8C01249FE904A732543A1b8E6CAfd0c',
  policyGuardSetup: '0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b',
  feeRouter: '0x98218248CA53Dd88159979af20172C86b94e8B29',
  deployer: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
  entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  accountFactory: '0xd519C25e9dEd0DAC586B764574100479CB318734',
}

const ARBITRUM_CONTRACTS = {
  bridgeRouter: '0x1afcAC1949BD306F7D4818999f509941F2E85582',
  liquidityRouter: '0xA273aF8ebB76d1D0Dcd55692C1f5a7db956F7EED',
  safeProposalHub: '0x94b5b38C247CE51F7C42C83B63115998b7e970E7',
  safePolicyGuardV2: '0xf18B813Ad8C01249FE904A732543A1b8E6CAfd0c',
  policyGuardSetup: '0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b',
  feeRouter: '0x98218248CA53Dd88159979af20172C86b94e8B29',
  deployer: '0x52502d049571C7893447b86c4d8B38e6184bF6e1',
  entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  accountFactory: '0xd519C25e9dEd0DAC586B764574100479CB318734',
}

/*
 * Full-E2E seam (spec 071 collision): the tier's local hardhat node boots AS chainId 80002 so
 * the local chain is the app's membership home — membershipChainId() is deliberately not
 * runtime-configurable, so the node impersonates Amoy rather than the app trusting a new chain.
 * On that node the deployed addresses are byte-identical to HARDHAT_CONTRACTS (local deploys
 * are deterministic by deployer+nonce, which is chain-id-independent), so 80002 resolves to the
 * hardhat set.
 *
 * DEV-guarded like the spec-085 hardware test adapter: `import.meta.env.DEV &&` makes the whole
 * branch dead code in any production bundle — a shipped build cannot be pointed at this even
 * with the variable set.
 */
const E2E_AMOY_LOCAL =
  Boolean(import.meta.env?.DEV) && import.meta.env?.VITE_E2E_AMOY_LOCAL === '1'

const NETWORK_CONTRACTS = {
  63: MORDOR_CONTRACTS,     // Mordor (Ethereum Classic testnet, v2 core-only)
  80002: E2E_AMOY_LOCAL ? HARDHAT_CONTRACTS : AMOY_CONTRACTS, // Polygon Amoy (v2) — or the local impersonation (E2E)
  137: POLYGON_CONTRACTS,   // Polygon mainnet (v2) — LIVE
  1337: HARDHAT_CONTRACTS,  // Local Hardhat sandbox
  // Spec 068 — custody only (Protect vaults + policy engine; no wager/membership here).
  61: ETC_CONTRACTS,        // Ethereum Classic mainnet
  // Spec 067 — routers only (no wager/membership deployment on these chains).
  1: ETHEREUM_CONTRACTS,    // Ethereum mainnet
  10: OPTIMISM_CONTRACTS,   // Optimism
  8453: BASE_CONTRACTS,     // Base
  42161: ARBITRUM_CONTRACTS,// Arbitrum One
}

// Default to Polygon mainnet (137) — the primary network — when VITE_NETWORK_ID
// isn't set. Test runs pin VITE_NETWORK_ID=63 (frontend/vite.config.js) so this
// default doesn't affect them; the live frontend reads VITE_NETWORK_ID from .env.
const ACTIVE_CHAIN_ID = parseInt(import.meta.env.VITE_NETWORK_ID || '137', 10)

export const DEPLOYED_CONTRACTS =
  NETWORK_CONTRACTS[ACTIVE_CHAIN_ID] || POLYGON_CONTRACTS

/**
 * Deployment block numbers for event scanning.
 * Keyed by chain ID; used as the starting block when no cached index exists.
 *
 * v1 used friendGroupMarketFactory; v2 uses wagerRegistry. Both kept here to
 * support legacy Mordor reads while Amoy migrates.
 */
// NOTE (spec 068): `safeProposalHub` MUST carry a deployment block on every custody chain —
// `useVaultProposals` refuses to scan without one, so a missing entry silently disables custody
// proposal discovery on that chain even when the hub itself is deployed.
// NOTE (spec 073): `miniAppRegistry` carries a placeholder block (0 = unknown, per
// getDeploymentBlockForChain) on every chain whose contract map declares the key, so the slot is
// written down rather than remembered. `deploy-miniapp-registry.js` records the real block in
// `deployments/`; copy it here by hand like every other entry. Unlike `safeProposalHub` above,
// a missing block disables nothing today — catalog and launch reads are view calls (research
// R6), never event scans — so a 0 here cannot make the Apps section look available before the
// registry exists; availability comes from the address being non-empty and the record Approved.
const DEPLOYMENT_BLOCKS_BY_CHAIN = {
  63: {
    friendGroupMarketFactory: 15658191,
    wagerRegistry: 0,
    membershipVoucher: 16404315,
    wagerPoolFactory: 16495564,
    safeProposalHub: 16645531,
    miniAppRegistry: 16685064,
  },
  // Custody-only chains (spec 068). `safeProposalHub` MUST carry a block on every custody chain or
  // useVaultProposals refuses to scan and proposal discovery is silently dead there.
  61: { safeProposalHub: 25026893 }, // Ethereum Classic
  10: { safeProposalHub: 154753770 }, // Optimism
  8453: { safeProposalHub: 49158472 }, // Base
  42161: { safeProposalHub: 488059169 }, // Arbitrum One
  80002: {
    friendGroupMarketFactory: 0,
    wagerRegistry: 0,
    membershipVoucher: 40521024,
    miniAppRegistry: 0,
    /*
     * Custody on Amoy exists ONLY in the local full-E2E impersonation (see the matching seams in
     * safeContracts.js and networks.js), where the chain is a few hundred blocks old and the hub's
     * code is placed by scripts/e2e/setup-custody-fixtures.js. Block 1 scans all of it.
     *
     * The value has to be non-zero: `useVaultProposals` reads 0 as "no recorded block" and refuses
     * to scan rather than sweeping from genesis on a real chain — which is the right default, and
     * is why the local impersonation has to say a block rather than inherit one. DEV-guarded, so a
     * production build still reports nothing here and Amoy proposal discovery stays off.
     */
    // Same seam, same reason: the registry exists on Amoy only in the local impersonation, and
    // its catalog reads scan from a recorded block. 1 covers a chain a few hundred blocks old.
    /*
     * The full-E2E impersonation runs on a local node ~100 blocks long, so every REAL Amoy block
     * number above is a starting point in the far future: a bounded scan from it finds nothing and
     * the surface renders an honest-looking empty list for a holding that exists. `membershipVoucher`
     * is the one that bit — `useVouchers#listMyVouchers` derives holdings from a Transfer-log scan,
     * so the Vouchers page showed "you don't have any vouchers to redeem" for a wallet holding one.
     *
     * Zero is safe HERE and only here: the "never scan from genesis" rule (#703/#704) is about
     * public chains with millions of blocks behind them.
     */
    ...(E2E_AMOY_LOCAL ? { safeProposalHub: 1, miniAppRegistry: 1, membershipVoucher: 0 } : {}),
  },
  // Polygon. Blocks marked (measured) were bisected with `eth_getCode` against an archive node
  // rather than taken from a deploy script's report — the two disagreed by up to ten blocks, and
  // a recorded block LATER than the real creation silently drops any event in between. The
  // wagerRegistry bisection matched its recorded value exactly, which is what validates the rest.
  137: {
    friendGroupMarketFactory: 0,
    wagerRegistry: 89717915,
    membershipVoucher: 89717905, // measured (was 89717915 — 10 blocks late)
    membershipManager: 89717895, // measured
    tokenFactory: 89717942, // measured
    wagerPoolFactory: 89720740, // measured (was 89720731)
    chainlinkDataFeedAdapter: 87937162, // measured
    chainlinkFunctionsAdapter: 87937176, // measured
    umaAdapter: 87937184, // measured
    safeProposalHub: 90120743,
    miniAppRegistry: 91265680,
  },
  1337: { safeProposalHub: 4, safePolicyGuardV2: 2, miniAppRegistry: 0 },
}

export const DEPLOYMENT_BLOCKS =
  DEPLOYMENT_BLOCKS_BY_CHAIN[ACTIVE_CHAIN_ID] || { friendGroupMarketFactory: 0, wagerRegistry: 0 }

/**
 * Deployment block for a contract on a specific chain — the bounded starting block for event scans
 * (never scan from genesis; see issue #703/#704). Returns 0 when unknown.
 * @param {string} contractName
 * @param {number} chainId
 * @returns {number}
 */
export function getDeploymentBlockForChain(contractName, chainId) {
  const blocks = DEPLOYMENT_BLOCKS_BY_CHAIN[chainId]
  return (blocks && blocks[contractName]) || 0
}

/**
 * Get contract address from environment or use deployed default
 * @param {string} contractName - Name of the contract
 * @returns {string} Contract address
 */
export function getContractAddress(contractName) {
  // Dedicated tenant (spec 072): the tenant's own generated set is the ONLY
  // source — no env overrides, no shared-estate fallback. Absence stays absence.
  if (isDedicatedTenant()) {
    const tenantSet = tenantContractsForChain(ACTIVE_CHAIN_ID)
    return tenantSet ? tenantSet[contractName] : undefined
  }

  // Check environment variables first (for custom deployments)
  // Support both legacy style (VITE_ROLEMANAGER_ADDRESS) and snake-case style (VITE_ROLE_MANAGER_ADDRESS)
  const upper = contractName.toUpperCase()
  const snake = contractName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()

  const envKeys = [`VITE_${upper}_ADDRESS`, `VITE_${snake}_ADDRESS`]
  for (const envKey of envKeys) {
    const envAddress = import.meta.env[envKey]
    if (envAddress) return envAddress
  }

  // Fall back to deployed contract addresses
  return DEPLOYED_CONTRACTS[contractName]
}

/**
 * Get a contract address for a specific chain id.
 *
 * Unlike `getContractAddress`, which is bound to the build-time
 * VITE_NETWORK_ID, this resolves against the per-chain deployment record so
 * runtime network switches (testnet ↔ mainnet) read the right deployment.
 * Returns undefined when the chain has no deployment for that contract — which
 * is the correct signal for "not available on this network" (e.g. a testnet
 * membership must not appear active on mainnet).
 *
 * Falls back to `getContractAddress` (env overrides + active chain) when no
 * chainId is supplied so existing callers keep their current behavior.
 *
 * @param {string} contractName - Name of the contract
 * @param {number} [chainId] - Target chain id
 * @returns {string|undefined} Contract address
 */
export function getContractAddressForChain(contractName, chainId) {
  if (chainId == null) return getContractAddress(contractName)
  // Dedicated tenant (spec 072): resolve ONLY from the tenant's own set —
  // a chain absent from it reads as not-deployed for this tenant, never as
  // the shared estate's deployment (FR-003/D6).
  if (isDedicatedTenant()) {
    const tenantSet = tenantContractsForChain(chainId)
    return tenantSet ? tenantSet[contractName] : undefined
  }
  const chainContracts = NETWORK_CONTRACTS[chainId]
  return chainContracts ? chainContracts[contractName] : undefined
}

// Local-only sandboxes — never surfaced as public "deployed" networks.
const LOCAL_ONLY_CHAIN_IDS = new Set([1337])

/**
 * Is this chain a local development sandbox rather than a real network?
 *
 * Exported because "local-only" is a fact about REACHABILITY, not just about the landing page:
 * a shipped build can never reach `http://127.0.0.1:8545`, so any read routed at such a chain
 * from a deployed origin is guaranteed to fail. Callers that would otherwise report that
 * guaranteed failure to a member as a degraded state must exclude these chains first —
 * see `lib/screening/sources.js#screeningChainIds` for the case that made this necessary.
 */
export function isLocalOnlyChain(chainId) {
  return LOCAL_ONLY_CHAIN_IDS.has(Number(chainId))
}
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Networks the app has been publicly deployed to — derived from
 * NETWORK_CONTRACTS entries that carry a live `wagerRegistry` (v2 escrow)
 * address, paired with their display metadata from networks.js. Local-only
 * sandboxes (Hardhat 1337) are excluded. Mainnets surface before testnets so
 * the production network reads first.
 *
 * This is the source for the landing page's "Deployed on" section, so it grows
 * automatically as new chains gain a wagerRegistry deployment — no UI edits.
 *
 * @returns {Array<{chainId:number,name:string,isTestnet:boolean,nativeSymbol:string,explorerUrl:string,contractUrl:string}>}
 */
export function getDeployedNetworks() {
  return Object.entries(NETWORK_CONTRACTS)
    .map(([id, contracts]) => ({ chainId: parseInt(id, 10), contracts }))
    .filter(
      ({ chainId, contracts }) =>
        !LOCAL_ONLY_CHAIN_IDS.has(chainId) &&
        ADDRESS_RE.test(contracts?.wagerRegistry || '')
    )
    .map(({ chainId, contracts }) => {
      const net = NETWORKS[chainId]
      const explorerUrl = net?.explorer?.baseUrl || ''
      return {
        chainId,
        name: net?.name || `Chain ${chainId}`,
        isTestnet: Boolean(net?.isTestnet),
        nativeSymbol: net?.nativeCurrency?.symbol || '',
        explorerUrl,
        // Link straight to the deployed escrow contract when an explorer exists.
        contractUrl: explorerUrl
          ? `${explorerUrl.replace(/\/$/, '')}/address/${contracts.wagerRegistry}`
          : '',
      }
    })
    .sort(
      (a, b) =>
        Number(a.isTestnet) - Number(b.isTestnet) || a.name.localeCompare(b.name)
    )
}

/**
 * Network configuration, derived from VITE_NETWORK_ID
 */
const NETWORK_INFO_BY_CHAIN = {
  63: {
    name: 'Mordor Testnet',
    rpcUrl: 'https://rpc.mordor.etccooperative.org',
    blockExplorer: 'https://etc-mordor.blockscout.com',
  },
  80002: {
    name: 'Polygon Amoy',
    // Mirrors config/networks.js — see the note there on why this is not Polygon's own endpoint.
    rpcUrl: 'https://polygon-amoy-bor-rpc.publicnode.com',
    blockExplorer: 'https://amoy.polygonscan.com',
  },
  137: {
    name: 'Polygon',
    // Public keyless endpoint; override per-deploy with VITE_RPC_URL. The
    // legacy https://polygon-rpc.com endpoint now rejects unauthenticated reads.
    rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    blockExplorer: 'https://polygonscan.com',
  },
}

const _activeNetwork = NETWORK_INFO_BY_CHAIN[ACTIVE_CHAIN_ID] || NETWORK_INFO_BY_CHAIN[137]

export const NETWORK_CONFIG = {
  chainId: ACTIVE_CHAIN_ID,
  name: _activeNetwork.name,
  rpcUrl: import.meta.env.VITE_RPC_URL || _activeNetwork.rpcUrl,
  blockExplorer: _activeNetwork.blockExplorer,
}
