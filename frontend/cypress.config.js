import { defineConfig } from 'cypress'
import { ethers } from 'ethers'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'fs'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import clearpathTasks from './cypress/support/tasks/clearpath.js'
import sigilTasks from './cypress/support/tasks/sigil.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// WAGER_PARTICIPANT_ROLE used by membership grants.
const WAGER_PARTICIPANT_ROLE = ethers.keccak256(ethers.toUtf8Bytes('WAGER_PARTICIPANT_ROLE'))

// Minimal ABIs for the setup transactions the E2E suite needs to arrange
// on-chain preconditions that have no UI (oracle resolution) or that are faster
// to set directly (pause/freeze/grant). All sent from Hardhat account #0, which
// the local deploy seeds with DEFAULT_ADMIN/GUARDIAN/ACCOUNT_MODERATOR/ROLE_MANAGER.
const REGISTRY_ABI = [
  'function pause()',
  'function unpause()',
  'function paused() view returns (bool)',
  'function freezeAccount(address user, string reason)',
  'function unfreezeAccount(address user)',
  'function isFrozen(address) view returns (bool)',
  'function nextWagerId() view returns (uint256)',
  'function createWager(address opponent,address arbitrator,address token,uint128 creatorStake,uint128 opponentStake,uint64 acceptDeadline,uint64 resolveDeadline,uint8 resolutionType,bytes32 polymarketConditionId,bool creatorIsYes,bytes32 metadataHash,string metadataUri) returns (uint256)',
  'function acceptWager(uint256 wagerId)',
  // Spec 024 open challenges: no named opponent. The taker proves possession of the four-word
  // code by presenting an EIP-712 signature from the code-derived claim authority, and that
  // signature is bound to the TAKER, so it cannot be lifted from the mempool and reused.
  'function createOpenWager(address claimAuthority,address arbitrator,address token,uint128 stake,uint64 acceptDeadline,uint64 resolveDeadline,uint8 resolutionType,bytes32 oracleConditionId,bool creatorIsYes,bytes32 metadataHash,string metadataUri) returns (uint256)',
  'function acceptOpenWager(uint256 wagerId, bytes signature)',
  'function openWagerIdForClaim(address authority) view returns (uint256)',
  'function declareWinner(uint256 wagerId, address winner)',
  // Spec 035 intent twin. The RELAYER is msg.sender; the acting identity is the recovered
  // signer, which is what makes the rail gasless for the member without giving the relayer
  // authority. Served via the proxy's fallback from WagerRegistryIntents.
  'function declareWinnerWithSig(uint256 wagerId,address winner,address signer,bytes32 nonce,uint256 validAfter,uint256 validBefore,bytes sig)',
  // Spec 004 draws. ThirdParty settles on the arbitrator's single call; participant types
  // accumulate MUTUAL consent and settle only when both sides have declared.
  'function declareDraw(uint256 wagerId)',
  'function revokeDraw(uint256 wagerId)',
  'function claimRefund(uint256 wagerId)',
  'function claimPayout(uint256 wagerId)',
  'function cancelOpen(uint256 wagerId)',
  'function declineWager(uint256 wagerId)',
  'function autoResolveFromPolymarket(uint256 wagerId)',
  'function getWager(uint256 wagerId) view returns (tuple(address creator,address opponent,address arbitrator,address token,uint128 creatorStake,uint128 opponentStake,uint64 acceptDeadline,uint64 resolveDeadline,uint8 resolutionType,uint8 status,bool paid,bool creatorIsYes,address winner,bytes32 metadataHash,bytes32 polymarketConditionId,string metadataUri))',
]
const MEMBERSHIP_ABI = [
  'function grantMembership(address user, bytes32 role, uint8 tier, uint32 durationDays)',
]
// Hardhat default account private keys (#0–#4) — public test keys, test-only.
/**
 * Hardhat's default mnemonic. The node unlocks the first 20 accounts derived from it, and
 * `eth_sendTransaction` from any of them is signed by the node — which is what lets a flow act as
 * an account this file did not hardcode a key for.
 */
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk'

const ACCOUNT_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
]
const CTF_ABI = [
  'function resolveCondition(bytes32 conditionId, uint256[] payouts)',
  'function prepareCondition(address oracle, bytes32 questionId, uint256 outcomeSlotCount)',
  'function getConditionId(address oracle, bytes32 questionId, uint256 outcomeSlotCount) pure returns (bytes32)',
]
const TOKEN_ABI = [
  'function mint(address to, uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]
// ReentrantToken (contracts/mocks) — a test-only ERC-20 whose next transfer re-enters an armed
// target and bubbles that call's revert. The legacy-recovery sweep uses it to model a token that
// REFUSES a transfer it is perfectly able to make (a blocklisting stablecoin is the real-world
// case), which is the only way to fail one asset and not the others: the sweep re-reads balances
// itself, so anything that changes the balance simply drops the asset from the run instead.
const ARMED_TOKEN_ABI = ['function arm(address target, bytes data)']
const KEYREG_ABI = [
  'function hasKey(address user) view returns (bool)',
  'function getPublicKey(address user) view returns (bytes)',
]
// Spec 032 — the unified backup pointer. Read-only here: what a member's device recorded is the
// fact the round-trip spec checks, and reading it from CHAIN is the only way to know a backup
// happened rather than that a dialog said so.
const BACKUP_POINTER_ABI = [
  'function getPointer(address owner) view returns (string)',
  'function hasPointer(address owner) view returns (bool)',
]
/*
 * Spec 060 platform fees (#1233). `Service` is returned as a struct, so the fragment must spell
 * the tuple out — a bare `returns (uint16,uint16,uint8)` decodes a DIFFERENT calldata shape and
 * would report a plausible-looking rate that is not the one the router holds.
 *
 * `FeeBpsChanged` is here because it is the audit history the third flow reads back: the admin UI
 * renders it, and a test that only re-read `getService` could not tell a rate that was CHANGED
 * from one that was always that value.
 */
const FEE_ROUTER_ABI = [
  'function getService(bytes32 serviceId) view returns (tuple(uint16 capBps, uint16 feeBps, uint8 kind))',
  'function setFeeBps(bytes32 serviceId, uint16 newBps)',
  'function treasury() view returns (address)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function FEE_ADMIN_ROLE() view returns (bytes32)',
  'event FeeBpsChanged(bytes32 indexed serviceId, uint16 oldBps, uint16 newBps, address indexed actor)',
]
// The local MockERC4626Vault (scripts/deploy/deploy-local-earn-vault.js) — the Earn deposit's
// destination, and where a member's NET principal must land when a fee is taken.
const VAULT_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function asset() view returns (address)',
]

// Spec 034 Wager Pools — minimal ABIs for the setup/drive transactions the pools e2e suite (#1232)
// needs to arrange directly (create/join/propose/approve/claim/refund), the same bypass-the-UI
// pattern the wager helpers above use. Addresses come from the deployment record's
// `wagerPoolFactory` key, appended by `deploy-wager-pool-factory.js` (never part of `deploy:local`).
const POOL_FACTORY_ABI = [
  'function createPool((address token,uint256 buyIn,uint32 maxMembers,uint16 thresholdBips,uint64 acceptDeadline,uint64 resolveDeadline) p) returns (uint256 poolId, address pool)',
  'event PoolCreated(uint256 indexed poolId, address indexed pool, address indexed creator, uint32[4] wordIndices, address token, uint256 buyIn, uint32 maxMembers, uint16 thresholdBips, uint64 acceptDeadline, uint64 resolveDeadline)',
]
// Spec 102 funding pools — minimal ABIs for the full-tier funding-pools spec's setup/drive transactions
// (create/contribute/vote/close/cancel/claim/poke) and its chain-state reads. Addresses come from the
// deployment record's `fundingPoolFactory` key, appended by `deploy-funding-pool-factory.js` (never part
// of `deploy:local` itself; last in `setup:e2e`).
const FUNDING_FACTORY_ABI = [
  'function createPool((address token,uint256 goal,string purpose,uint64 contributeDeadline,uint64 settleDeadline) p) returns (uint256 poolId, address pool)',
  'function phraseOfPool(address pool) view returns (uint32[4])',
  'event PoolCreated(uint256 indexed poolId, address indexed pool, address indexed organizer, uint32[4] wordIndices, address token, uint256 goal, string purpose, uint64 contributeDeadline, uint64 settleDeadline)',
]
const FUNDING_POOL_ABI = [
  'function contribute(uint256 amount)',
  'function close()',
  'function cancel()',
  'function voteRefund()',
  'function claimRefund()',
  'function pokeDeadline()',
  'function state() view returns (uint8)',
  'function organizer() view returns (address)',
  'function purpose() view returns (string)',
  'function goal() view returns (uint256)',
  'function totalRaised() view returns (uint256)',
  'function contributorCount() view returns (uint32)',
  'function refundVotes() view returns (uint32)',
  'function refundedCount() view returns (uint32)',
  'function refundReason() view returns (uint8)',
  'function contributeDeadline() view returns (uint64)',
  'function settleDeadline() view returns (uint64)',
  'function contributed(address) view returns (uint256)',
  'function votedRefund(address) view returns (bool)',
  'function refunded(address) view returns (bool)',
]
const POOL_ABI = [
  'function join()',
  'function joinWithAuthorization(address from, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function closeJoining()',
  'function cancel()',
  'function proposeOutcome((address winner,uint256 amount)[] entries)',
  'function approve()',
  'function claim((address winner,uint256 amount)[] entries, uint256 index, address recipient)',
  'function refund()',
  'function state() view returns (uint8)',
  'function memberCount() view returns (uint32)',
  'function maxMembers() view returns (uint32)',
  'function buyIn() view returns (uint256)',
  'function token() view returns (address)',
  'function acceptDeadline() view returns (uint64)',
  'function resolveDeadline() view returns (uint64)',
  'function frozenDenominator() view returns (uint32)',
  'function thresholdBips() view returns (uint16)',
  'function escrowTotal() view returns (uint256)',
  'function currentProposalId() view returns (bytes32)',
  'function hasJoined(address) view returns (bool)',
  'function refunded(address) view returns (bool)',
  'function claimedIndex(uint256) view returns (bool)',
  'function proposalApprovals(bytes32) view returns (uint32)',
  'function approvedBy(bytes32, address) view returns (bool)',
  'event Joined(address indexed member)',
]
// EIP-3009 domain/typehash for MockUSDCPermit (contracts/mocks/MockUSDCPermit.sol) — a 6-decimal USDC
// double supporting `receiveWithAuthorization`, deployed on demand by the `deployMockUSDCPermit` task
// since the local core payment token (18-dec MockERC20) has no EIP-3009 support. OZ ERC20Permit domain
// version is its default "1".
const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

/**
 * Read the local deployment record written by `npm run deploy:local`
 * (`--network localhost` → `deployments/localhost-chain1337-v2.json`). This is
 * the same source `sync:frontend-contracts` mirrors into the UI's
 * HARDHAT_CONTRACTS, so the addresses match what the app uses.
 */
// The chain id this session's mock claims and the tasks target. Default stays 1337 because this
// config also serves the FAST tier, whose specs assert against the chain the mock claims — a
// changed default would silently re-cohort them. The FULL tier's entry points (the CI job and
// scripts that boot hardhat AS Amoy via HARDHAT_LOCAL_CHAIN_ID=80002) pass CYPRESS_NETWORK_ID=80002
// so the local node is the app's membership home; see hardhat.config.js for why impersonation
// rather than reconfiguration.
const E2E_CHAIN_ID = Number(globalThis.process?.env?.CYPRESS_NETWORK_ID) || 1337

function loadLocalDeployment() {
  const path = resolve(__dirname, '..', 'deployments', `localhost-chain${E2E_CHAIN_ID}-v2.json`)
  return JSON.parse(readFileSync(path, 'utf8'))
}


/**
 * Every voucher an address holds, by walking `ownerOf` over the minted range.
 *
 * The voucher contract is a plain ERC-721 with no enumerable extension, so there is no
 * `tokenOfOwnerByIndex` to call — and inventing one in a fixture would test a contract that does
 * not exist. Ids start at 1 and increase by one per mint, so a bounded walk is exact; a gap left
 * by a burned (redeemed) voucher makes `ownerOf` revert, which is skipped rather than treated as
 * the end of the range.
 */
async function ownedVouchers(voucher, owner, max = 64) {
  const held = []
  const want = String(owner).toLowerCase()
  for (let id = 1; id <= max; id += 1) {
    try {
      if (String(await voucher.ownerOf(id)).toLowerCase() === want) held.push(id)
    } catch {
      // Burned or never minted — neither is the end of the range.
    }
  }
  return held
}

/** Read a Hardhat-compiled artifact (abi + bytecode) written by `npm run compile` / `deploy:local`. */
function loadArtifact(contractPath, contractName) {
  const path = resolve(__dirname, '..', 'artifacts', 'contracts', contractPath, `${contractName}.json`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/*
 * Name the custom error behind a revert.
 *
 * The task drives the registry through a minimal human-readable ABI, which carries no error
 * fragments — so every custom error arrived as the useless "execution reverted (unknown custom
 * error)". ORC-01/02 reported exactly that. Decode against the compiled artifacts instead;
 * BOTH facets are needed because the proxy delegates unknown selectors to WagerRegistryIntents,
 * which is where autoResolveFrom* lives (spec 035/036). The pool contracts (spec 034) are
 * included too, so a reverting pool precondition names its custom error the same way.
 *
 * Best-effort: if the artifacts have not been compiled, fall through to the raw message rather
 * than failing the task for a diagnostic.
 */
let __revertIface = null
function revertInterface() {
  if (__revertIface) return __revertIface
  const fragments = []
  for (const rel of [
    '../artifacts/contracts/wagers/WagerRegistry.sol/WagerRegistry.json',
    '../artifacts/contracts/wagers/WagerRegistryIntents.sol/WagerRegistryIntents.json',
    '../artifacts/contracts/pools/WagerPool.sol/WagerPool.json',
    '../artifacts/contracts/pools/WagerPoolFactory.sol/WagerPoolFactory.json',
    // Spec 060: `FeeAboveQuoted` and `CapExceeded` are the two reverts the fee specs assert on,
    // and both are custom errors — without the fragments they arrive as "unknown custom error"
    // and a test could not tell the ceiling holding from an unrelated failure.
    '../artifacts/contracts/fees/FeeRouter.sol/FeeRouter.json',
  ]) {
    try {
      fragments.push(...JSON.parse(readFileSync(resolve(__dirname, rel), 'utf8')).abi)
    } catch {
      // Not compiled in this environment — decode with whatever else we found.
    }
  }
  __revertIface = new ethers.Interface(fragments)
  return __revertIface
}

function describeRevert(e) {
  const base = e.shortMessage || e.reason || e.message
  const data = e.data ?? e.info?.error?.data ?? e.error?.data
  if (typeof data === 'string' && data.length >= 10) {
    try {
      const parsed = revertInterface().parseError(data)
      if (parsed) {
        const args = parsed.args?.length ? `(${parsed.args.map(String).join(', ')})` : ''
        return `${parsed.name}${args}`
      }
    } catch {
      // Unknown selector — the raw message plus the selector still beats "unknown custom error".
    }
    return `${base} [selector ${data.slice(0, 10)}]`
  }
  return base
}

export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:5173',
    specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    supportFile: 'cypress/support/e2e.js',
    viewportWidth: 1280,
    viewportHeight: 720,
    video: true,
    /*
     * Cypress 13+ defaults videoCompression to false, i.e. raw video: the fast suite
     * produced ~45 MB per run, which on a private repo (artifacts bill against the
     * account storage quota) was 84% of all CI artifact storage and eventually failed
     * every job on upload. 32 is Cypress's own pre-13 default CRF.
     */
    videoCompression: 32,
    screenshotOnRunFailure: true,
    defaultCommandTimeout: 10000,
    requestTimeout: 10000,
    responseTimeout: 30000,

    env: {
      // Spec 094: which viewport profile this run uses — `desktop` (1280×720, what every existing
      // spec was written against) or `phone` (390×844). CI runs the no-chain tier once per profile.
      // Override with CYPRESS_VIEWPORT_PROFILE.
      VIEWPORT_PROFILE: 'desktop',
      // Hardhat local testnet configuration (Amoy-shaped when the full tier passes
      // CYPRESS_NETWORK_ID=80002 — see E2E_CHAIN_ID above)
      NETWORK_ID: E2E_CHAIN_ID,
      RPC_URL: 'http://localhost:8545',
      // Test wallet private key (Hardhat account #0 — holds all admin roles locally)
      PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    },

    setupNodeEvents(on, config) {
      /*
       * Chain-state checkpoint (full tier only). Eight of the fifteen full specs move the chain
       * clock with evm_increaseTime — 02-membership alone jumps it 31 days to expire a membership —
       * and chain time can NEVER move backwards. Without isolation, whichever spec runs first
       * poisons every later one: create forms compute deadlines from the browser clock, the chain
       * rejects them as ~a month in its past, and the failure surfaces as "Invalid deadlines" in
       * specs that did nothing wrong. Which specs pass then depends on RUN ORDER — the definition
       * of a suite without isolation, and why single-spec experiments kept contradicting full runs.
       *
       * The plugin process lives for the whole `cypress run`, so this closure survives across
       * specs. Each spec reverts to the post-seed snapshot and immediately re-snapshots (hardhat
       * consumes a snapshot id on revert).
       */
      let chainSnapshotId = null

      /*
       * Runtime code displaced by `legacyFixture: makeTokenRefuse`, keyed by lowercased address,
       * so `restoreTokenCode` can put it back. Lives out here with the snapshot id for the same
       * reason: the plugin process spans the whole `cypress run`.
       */
      const originalTokenCode = new Map()

      on('task', {
        log(message) {
          console.log(message)
          return null
        },

        /*
         * Spec 094: hand the runner the installed axe-core source so cy.a11yScan can evaluate it
         * in the app window. Resolved through require.resolve rather than a hardcoded path — the
         * package hoists to the ROOT node_modules in this workspace (spec 075) but need not, and a
         * path that silently missed would make every accessibility scan quietly do nothing.
         *
         * Returns null on failure rather than throwing, so the command raises the honest error
         * ("could not load axe-core") instead of a task rejection with no context.
         */
        axeSource() {
          try {
            return readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8')
          } catch (e) {
            console.error('axeSource: could not resolve axe-core —', e.message)
            return null
          }
        },

        /*
         * ── PASSKEY FULL-STACK TIER (specs 041 + 050) ────────────────────────────────────────
         * These three tasks serve `cypress/e2e/passkey/**` when the job in
         * .github/workflows/test.yml (cypress-passkey-full-stack) has brought up the local chain,
         * the ERC-4337 EntryPoint, the account factory, the verifying paymaster, an alto bundler
         * and the relay gateway. Every one of them either arranges a precondition the flow cannot
         * reach through the UI, or reads a fact back from the CHAIN — never from a dialog.
         */

        /**
         * Fund a passkey smart account so its first action has something to move.
         *
         * NAMED for the flow it serves but it takes the ADDRESS explicitly: a Node task has no view
         * of the browser, so "the active session" has to be read in the spec (the header account
         * control publishes it) and handed over. The alternative — a task that guessed — would fund
         * some other account and the failure would look like a broken transfer.
         *
         * `native` defaults to ZERO on purpose. An account holding no native token is what makes a
         * sponsored UserOp provable: it is the only funding state in which the operation cannot
         * have paid for itself.
         */
        async seedUsdcForActiveSession({ address, usdc = '1000', native = '0', ownerBytes = null } = {}) {
          if (!/^0x[0-9a-fA-F]{40}$/.test(address || '')) {
            throw new Error(`seedUsdcForActiveSession: needs the session address, got ${JSON.stringify(address)}`)
          }
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const admin = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))
          const d = loadLocalDeployment()
          const token = new ethers.Contract(d.paymentToken, TOKEN_ABI, admin)
          // 18-dec mock stablecoin on the local chain (see VITE_AMOY_USDC_DECIMALS in dev:e2e).
          await (await token.mint(address, ethers.parseUnits(String(usdc), 18))).wait(1)
          if (native !== '0' && native !== 0) {
            await provider.send('hardhat_setBalance', [address, '0x' + ethers.parseEther(String(native)).toString(16)])
          }
          /*
           * ACTIVATION. A counterfactual account has no code until its first UserOp deploys it, and
           * the controllers panel disables every mutation until it does — so a spec about adding and
           * removing controllers cannot reach its own subject without one. `createAccount` on the
           * factory is permissionless and CREATE2-deterministic on the initial owner set, so calling
           * it here deploys EXACTLY the address the browser derived; it is the same first-use deploy
           * the sponsored path performs, arranged rather than driven. The sponsored spec drives the
           * real one. Idempotent: the factory returns the existing account if it is already deployed.
           */
          if (ownerBytes) {
            const factory = new ethers.Contract(
              d.contracts.accountFactory,
              ['function createAccount(bytes[] owners, uint256 nonce) payable returns (address)'],
              admin,
            )
            await (await factory.createAccount([ownerBytes], 0)).wait(1)
            if ((await provider.getCode(address)) === '0x') {
              throw new Error(
                `seedUsdcForActiveSession: createAccount left no code at ${address} — the browser's derived ` +
                  'address and the factory disagree, so nothing this account signs could ever land.',
              )
            }
          }
          return {
            ok: true,
            address,
            deployed: (await provider.getCode(address)) !== '0x',
            usdc: (await token.balanceOf(address)).toString(),
            native: (await provider.getBalance(address)).toString(),
          }
        },

        /**
         * Flag an address on the LOCAL SanctionsGuard — the same contract the app's own
         * `screenController` reads, so the refusal under test is the product's, not a stub's.
         * Takes a bare address string because that is how the controllers spec calls it.
         */
        async flagAddress(address) {
          const target = typeof address === 'string' ? address : address?.address
          if (!/^0x[0-9a-fA-F]{40}$/.test(target || '')) {
            throw new Error(`flagAddress: expected an address, got ${JSON.stringify(address)}`)
          }
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const admin = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))
          const d = loadLocalDeployment()
          const guard = new ethers.Contract(
            d.contracts.sanctionsGuard,
            [
              'function setDenied(address account, bool denied, string reason)',
              'function isDenied(address account) view returns (bool)',
            ],
            admin,
          )
          if (!(await guard.isDenied(target))) {
            await (await guard.setDenied(target, true, 'e2e passkey fixture')).wait(1)
          }
          const denied = await guard.isDenied(target)
          // Read back rather than trusting the send: a flag that did not take would make the
          // refusal test pass for the wrong reason (nothing to refuse).
          if (!denied) throw new Error(`flagAddress: ${target} is still not denied after setDenied`)
          return { ok: true, address: target, denied }
        },

        /**
         * Chain and service state for the sponsored-UserOp flow.
         *
         * action ∈ deposit | balances | ownerCount | deployed | setSponsorship
         *
         * `setSponsorship` drives the REAL gateway rather than intercepting the request in the
         * browser: SIGUSR2 toggles its kill switch (server.js bootstrap), and the task then polls
         * /status until the gateway AGREES it changed. A stub would prove the client can handle a
         * refusal it was handed; this proves it handles the refusal the deployment actually issues.
         */
        async passkeyStack({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const d = loadLocalDeployment()
          const entryPoint = d.contracts.entryPoint
          const paymaster = d.contracts.verifyingPaymaster
          const gatewayUrl = config.env.GATEWAY_URL || 'http://127.0.0.1:8788'

          switch (action) {
            case 'deposit': {
              // EntryPoint.balanceOf(paymaster) — the sponsorship pool. It going DOWN across a send
              // is the only direct evidence that the paymaster, and not the member, paid.
              const ep = new ethers.Contract(entryPoint, ['function balanceOf(address) view returns (uint256)'], provider)
              return { ok: true, paymaster, deposit: (await ep.balanceOf(paymaster)).toString() }
            }
            case 'balances': {
              const token = new ethers.Contract(d.paymentToken, TOKEN_ABI, provider)
              return {
                ok: true,
                native: (await provider.getBalance(args.address)).toString(),
                usdc: (await token.balanceOf(args.address)).toString(),
              }
            }
            case 'fundNative': {
              const wei = ethers.parseEther(String(args.amount ?? '1'))
              await provider.send('hardhat_setBalance', [args.address, '0x' + wei.toString(16)])
              return { ok: true, native: (await provider.getBalance(args.address)).toString() }
            }
            case 'deployed':
              return { ok: true, deployed: (await provider.getCode(args.address)) !== '0x' }
            case 'ownerCount': {
              // MultiOwnable.ownerCount() on the smart account — the chain's own answer to "how many
              // keys can move this money", which is what a controller add/remove is FOR.
              const acct = new ethers.Contract(args.address, ['function ownerCount() view returns (uint256)'], provider)
              try {
                return { ok: true, ownerCount: Number(await acct.ownerCount()) }
              } catch (e) {
                return { ok: false, error: e.shortMessage || e.message }
              }
            }
            case 'setSponsorship': {
              const want = Boolean(args.enabled)
              const read = async () => {
                const res = await fetch(`${gatewayUrl}/status`)
                const body = await res.json()
                return body.killSwitch === false // sponsorship is offered when the switch is OFF
              }
              if ((await read()) === want) return { ok: true, sponsorship: want, toggled: false }
              const pidFile = config.env.GATEWAY_PID_FILE || '/tmp/fairwins-passkey-stack/gateway.pid'
              const pid = Number(readFileSync(pidFile, 'utf8').trim())
              if (!Number.isInteger(pid) || pid <= 0) throw new Error(`setSponsorship: no gateway pid in ${pidFile}`)
              globalThis.process.kill(pid, 'SIGUSR2')
              for (let i = 0; i < 40; i++) {
                if ((await read()) === want) return { ok: true, sponsorship: want, toggled: true }
                await new Promise((r) => setTimeout(r, 250))
              }
              throw new Error(`setSponsorship: gateway did not report sponsorship=${want} after SIGUSR2`)
            }
            default:
              throw new Error(`passkeyStack: unknown action '${action}'`)
          }
        },

        /**
         * Send a setup transaction to the local Hardhat node as account #0.
         * action ∈ pause | unpause | freeze | unfreeze | grantMembership | resolveCondition
         * Returns a small status object (never the raw tx) so specs stay declarative.
         */
        async chainTx({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const wallet = new ethers.Wallet(config.env.PRIVATE_KEY, provider)
          const d = loadLocalDeployment()
          const registry = new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, wallet)
          const membership = new ethers.Contract(d.contracts.membershipManager, MEMBERSHIP_ABI, wallet)
          const ctfAddr = (d.mocks && d.mocks.mockPolymarketCTF) || d.polymarketCTF
          const ctf = new ethers.Contract(ctfAddr, CTF_ABI, wallet)
          const token = new ethers.Contract(d.paymentToken, TOKEN_ABI, wallet)

          try {
          let tx
          switch (action) {
            case 'fund':
              // Mint a large stake-token balance so create/accept never reverts on
              // transferFrom (the mock is 18-dec; this covers any stake amount).
              tx = await token.mint(args.address, args.amount || (10n ** 24n)); break
            case 'approve': {
              // Approve the registry as account #idx (uses that account's key).
              const aw = new ethers.Wallet(ACCOUNT_KEYS[args.index ?? 0], provider)
              tx = await new ethers.Contract(d.paymentToken, TOKEN_ABI, aw)
                .approve(d.contracts.wagerRegistry, ethers.MaxUint256)
              break
            }
            case 'createWager': {
              // Reliable on-chain wager creation as account #creatorIndex (bypasses
              // the UI create wizard, which doesn't send txs under the mock wallet).
              const cw = new ethers.Wallet(ACCOUNT_KEYS[args.creatorIndex ?? 0], provider)
              const creg = new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, cw)
              const now = (await provider.getBlock('latest')).timestamp
              // creatorStake/opponentStake default to the shared `stake` (the common equal-stakes
              // case); pass them individually for an asymmetric "offer" wager. Either-party
              // resolution requires equal stakes on chain (EitherRequiresEqualStakes) — an
              // asymmetric wager needs resolutionType Creator/Opponent/ThirdParty.
              const base = BigInt(args.stake ?? (10n ** 18n))
              const creatorStake = args.creatorStake !== undefined ? BigInt(args.creatorStake) : base
              const opponentStake = args.opponentStake !== undefined ? BigInt(args.opponentStake) : base
              const sent = await creg.createWager(
                args.opponent, args.arbitrator || ethers.ZeroAddress, d.paymentToken,
                creatorStake, opponentStake,
                now + (args.acceptIn ?? 3600), now + (args.resolveIn ?? 7200),
                args.resolutionType ?? 0, args.conditionId ?? ethers.ZeroHash,
                args.creatorIsYes ?? false, ethers.id('e2e-meta'), ''
              )
              const rc = await sent.wait(1)
              const reg = new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, provider)
              return { ok: rc.status === 1, wagerId: Number(await reg.nextWagerId()) - 1 }
            }
            case 'acceptWager': {
              const ow = new ethers.Wallet(ACCOUNT_KEYS[args.opponentIndex ?? 1], provider)
              tx = await new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, ow)
                .acceptWager(args.wagerId)
              break
            }
            case 'declareWinner': {
              const rw = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              tx = await new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, rw)
                .declareWinner(args.wagerId, args.winner)
              break
            }
            case 'declareWinnerWithSig': {
              /*
               * Sign as the MEMBER, submit as the RELAYER. `signerIndex` is who authorises;
               * `relayerIndex` is who pays gas and appears as msg.sender. The gap between those
               * two accounts is the entire point of the intent rail.
               */
              const member = new ethers.Wallet(ACCOUNT_KEYS[args.signerIndex ?? 0], provider)
              const relayer = new ethers.Wallet(ACCOUNT_KEYS[args.relayerIndex ?? 3], provider)
              const inet = await provider.getNetwork()
              const nonce = args.nonce ?? ethers.hexlify(ethers.randomBytes(32))
              const inow = (await provider.getBlock('latest')).timestamp
              const validAfter = args.validAfter ?? 0
              const validBefore = args.validBefore ?? (inow + 3600)
              const message = {
                wagerId: args.wagerId,
                winner: args.winner,
                actor: args.actorOverride ?? member.address,
                nonce,
                validAfter,
                validBefore,
              }
              const isig = await member.signTypedData(
                {
                  name: 'FairWins WagerRegistry',
                  version: '1',
                  chainId: Number(inet.chainId),
                  verifyingContract: d.contracts.wagerRegistry,
                },
                {
                  DeclareWinnerIntent: [
                    { name: 'wagerId', type: 'uint256' },
                    { name: 'winner', type: 'address' },
                    { name: 'actor', type: 'address' },
                    { name: 'nonce', type: 'bytes32' },
                    { name: 'validAfter', type: 'uint256' },
                    { name: 'validBefore', type: 'uint256' },
                  ],
                },
                message,
              )
              tx = await new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, relayer)
                .declareWinnerWithSig(
                  args.wagerId, args.winner, args.signerAddressOverride ?? member.address,
                  nonce, validAfter, validBefore, isig,
                )
              break
            }
            case 'createOpenWager': {
              /*
               * The claim authority stands in for the four-word code: the client derives a
               * keypair from the phrase, and possession of the phrase IS possession of the key.
               * The test generates one and keeps the private key so it can sign as the holder.
               */
              const ow = new ethers.Wallet(ACCOUNT_KEYS[args.creatorIndex ?? 0], provider)
              const authority = ethers.Wallet.createRandom()
              const oreg = new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, ow)
              const onow = (await provider.getBlock('latest')).timestamp
              const osent = await oreg.createOpenWager(
                authority.address, args.arbitrator || ethers.ZeroAddress, d.paymentToken,
                BigInt(args.stake ?? (10n ** 18n)),
                onow + (args.acceptIn ?? 3600), onow + (args.resolveIn ?? 7200),
                args.resolutionType ?? 0, args.conditionId ?? ethers.ZeroHash,
                args.creatorIsYes ?? false, ethers.id('e2e-open'), ''
              )
              const orc = await osent.wait(1)
              const oread = new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, provider)
              return {
                ok: orc.status === 1,
                wagerId: Number(await oread.nextWagerId()) - 1,
                claimAuthority: authority.address,
                claimKey: authority.privateKey,
              }
            }
            case 'acceptOpenWager': {
              // Sign OpenAccept(wagerId, taker) as the code holder, then submit AS the taker.
              const tw = new ethers.Wallet(ACCOUNT_KEYS[args.takerIndex ?? 1], provider)
              const holder = new ethers.Wallet(args.claimKey)
              const net = await provider.getNetwork()
              const sig = await holder.signTypedData(
                {
                  name: 'FairWins WagerRegistry',
                  version: '1',
                  chainId: Number(net.chainId),
                  verifyingContract: d.contracts.wagerRegistry,
                },
                { OpenAccept: [{ name: 'wagerId', type: 'uint256' }, { name: 'taker', type: 'address' }] },
                { wagerId: args.wagerId, taker: args.taker ?? tw.address },
              )
              tx = await new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, tw)
                .acceptOpenWager(args.wagerId, args.signatureOverride ?? sig)
              break
            }
            case 'declareDraw': {
              const dw = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              tx = await new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, dw)
                .declareDraw(args.wagerId)
              break
            }
            case 'revokeDraw': {
              const rvw = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              tx = await new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, rvw)
                .revokeDraw(args.wagerId)
              break
            }
            case 'claimRefund': {
              const cw2 = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              tx = await new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, cw2)
                .claimRefund(args.wagerId)
              break
            }
            case 'claimPayout': {
              const pw = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              tx = await new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, pw)
                .claimPayout(args.wagerId)
              break
            }
            case 'cancelOpen': {
              const cow = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              tx = await new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, cow)
                .cancelOpen(args.wagerId)
              break
            }
            case 'declineWager': {
              const dw = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              tx = await new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, dw)
                .declineWager(args.wagerId)
              break
            }
            case 'registerKey': {
              /*
               * Register an encryption key for a hardhat account, signed by that account.
               *
               * `cy.ensureEncryptionKeys` does this through the UI, which connects the injected
               * mock and leaves an authorized session behind — harmless for a spec that wants a
               * classic wallet, fatal for one that then signs in with a PASSKEY, because the mock
               * auto-reconnects over it and the passkey session never happens. `registerKey` is
               * self-callable on the contract, so a fixture can do it without a browser at all.
               *
               * The key's VALUE is not under test here (X25519 material is generated client-side);
               * what the create path needs is a registered 32-byte key for the opponent.
               */
              const kw = new ethers.Wallet(ACCOUNT_KEYS[args.index ?? 0], provider)
              const kr = new ethers.Contract(
                d.contracts.keyRegistry,
                ['function registerKey(bytes publicKey)', 'function hasKey(address) view returns (bool)'],
                kw,
              )
              if (await kr.hasKey(kw.address)) return { ok: true, address: kw.address, noop: true }
              const pub = args.publicKey || ethers.hexlify(ethers.randomBytes(32))
              const rc = await (await kr.registerKey(pub)).wait(1)
              return { ok: rc.status === 1, address: kw.address }
            }
            case 'hasKey': {
              const kr = new ethers.Contract(d.contracts.keyRegistry, KEYREG_ABI, provider)
              return { ok: true, registered: await kr.hasKey(args.address) }
            }
            case 'clearBackupPointer': {
              /*
               * Reset the member's pointer so a spec can start from a KNOWN absence.
               *
               * Needed because the mock IPFS CIDs come from a per-run counter, so two runs against
               * one node pin the same CID — "the pointer changed" is therefore not a claim a spec
               * can make, and "there is none yet" is only true on a fresh chain. Clearing makes the
               * starting state explicit instead of assumed. `setPointer("")` is the contract's own
               * clear, signed by the owner, exactly as a member removing their backup would.
               */
              const clearAddr = d.contracts.backupPointerRegistry
              if (!clearAddr) return { ok: false, error: 'backupPointerRegistry is not in the local deployment record' }
              const ow = new ethers.Wallet(ACCOUNT_KEYS[args.ownerIndex ?? 0], provider)
              const rc = await (await new ethers.Contract(clearAddr, ['function setPointer(string cid)'], ow)
                .setPointer('')).wait(1)
              return { ok: rc.status === 1 }
            }
            case 'backupPointer': {
              // Absent registry is reported as such rather than as "no pointer": the two have
              // opposite remedies, and a spec that cannot tell them apart proves neither.
              const addr = d.contracts.backupPointerRegistry
              if (!addr) return { ok: false, error: 'backupPointerRegistry is not in the local deployment record' }
              const bp = new ethers.Contract(addr, BACKUP_POINTER_ABI, provider)
              /*
               * ONE BLOCK FOR BOTH READS. `hasPointer` IS `getPointer().length != 0` on chain, so
               * the two can only disagree across block heights — and unpinned they are two separate
               * eth_calls, which a `setPointer` landing between them straddles. That returns
               * `{ has: true, cid: '' }`: a state the contract cannot be in, which a poll waiting on
               * `has` reads as settled and then asserts against the pre-write CID (#1327).
               */
              const blockTag = await provider.getBlockNumber()
              return {
                ok: true,
                blockTag,
                cid: await bp.getPointer(args.address, { blockTag }),
                has: await bp.hasPointer(args.address, { blockTag }),
              }
            }
            case 'tokenBalance': {
              const t = new ethers.Contract(args.token || d.paymentToken, TOKEN_ABI, provider)
              return { ok: true, balance: (await t.balanceOf(args.address)).toString() }
            }
            // ---- Spec 034 Wager Pools (#1232) ----
            case 'deployMockUSDCPermit': {
              // A fresh, isolated 6-dec USDC double with EIP-3009 support, for the gasless-join spec —
              // the local core payment token (18-dec MockERC20) has no `receiveWithAuthorization`.
              //
              // Explicit nonce management for the deploy-then-mint pair: two back-to-back sends from
              // the SAME wallet, each auto-computing its nonce via getTransactionCount('pending'),
              // intermittently raced under resetChainBetweenTests()' per-test evm_revert (observed in
              // CI as "Nonce too low. Expected nonce to be N+1 but got N") — the revert leaves the
              // node's pending-nonce bookkeeping momentarily inconsistent with 'latest'. Fetching once
              // from 'latest' and incrementing locally sidesteps it.
              let nonce = await provider.getTransactionCount(wallet.address, 'latest')
              const art = loadArtifact('mocks/MockUSDCPermit.sol', 'MockUSDCPermit')
              const cf = new ethers.ContractFactory(art.abi, art.bytecode, wallet)
              const c = await cf.deploy({ nonce: nonce++ })
              await c.waitForDeployment()
              const tokenAddr = await c.getAddress()
              if (args.mintTo) {
                await (await c.mint(args.mintTo, BigInt(args.amount ?? 10n ** 12n), { nonce: nonce++ })).wait(1)
              }
              return { ok: true, token: tokenAddr }
            }
            case 'createPool': {
              if (!d.contracts.wagerPoolFactory) {
                return { ok: false, error: 'wagerPoolFactory is not deployed — run deploy-wager-pool-factory.js --network localhost' }
              }
              const cw = new ethers.Wallet(ACCOUNT_KEYS[args.creatorIndex ?? 0], provider)
              const factory = new ethers.Contract(d.contracts.wagerPoolFactory, POOL_FACTORY_ABI, cw)
              // `resetChainBetweenTests()` reverts to a checkpoint taken once, real minutes before a
              // later test runs, and a `now` predicted from either `Date.now()` or a mere READ of
              // 'latest' kept reverting BadDeadlines() in CI regardless of which clock (or their max)
              // it was anchored to — a short window is exactly what exposes a predicted `now` that's
              // wrong by any amount. Stop predicting: force-mine an empty block and read what
              // timestamp Hardhat's automine ACTUALLY assigned it. That is (mechanism-independent of
              // whatever Hardhat does internally across the revert) the same rule the createPool tx's
              // own block gets, so anchoring to it is exact rather than estimated.
              await provider.send('evm_mine', [])
              const now = (await provider.getBlock('latest')).timestamp
              const params = {
                token: args.token || d.paymentToken,
                buyIn: BigInt(args.buyIn ?? 10n * 10n ** 18n),
                maxMembers: args.maxMembers ?? 5,
                thresholdBips: args.thresholdBips ?? 5100,
                acceptDeadline: now + (args.acceptIn ?? 3600),
                resolveDeadline: now + (args.resolveIn ?? 7200),
              }
              const sent = await factory.createPool(params)
              const rc = await sent.wait(1)
              const ev = rc.logs
                .map((l) => { try { return factory.interface.parseLog(l) } catch { return null } })
                .find((e) => e && e.name === 'PoolCreated')
              if (!ev) return { ok: false, error: 'PoolCreated event not found in receipt' }
              return { ok: rc.status === 1, poolId: Number(ev.args.poolId), pool: ev.args.pool }
            }
            case 'joinPool': {
              // Approve-then-join as account #index — mirrors the self-submit path usePools.joinPool
              // takes when no relayer is live (the path the mocked-wallet Cypress harness always hits).
              // Explicit nonce management: see the comment on deployMockUSDCPermit — the same
              // approve-then-send pattern from one wallet hit the same post-revert nonce race.
              const jw = new ethers.Wallet(ACCOUNT_KEYS[args.index ?? 1], provider)
              const tokenAddr = args.token || d.paymentToken
              const jTok = new ethers.Contract(tokenAddr, TOKEN_ABI, jw)
              const jPool = new ethers.Contract(args.pool, POOL_ABI, jw)
              const buyIn = BigInt(args.buyIn)
              let nonce = await provider.getTransactionCount(jw.address, 'latest')
              const allowance = await jTok.allowance(jw.address, args.pool)
              if (allowance < buyIn) await (await jTok.approve(args.pool, buyIn, { nonce: nonce++ })).wait(1)
              tx = await jPool.join({ nonce: nonce++ })
              break
            }
            case 'closeJoiningPool': {
              const ccw = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              tx = await new ethers.Contract(args.pool, POOL_ABI, ccw).closeJoining()
              break
            }
            case 'proposePoolOutcome': {
              const ppw = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              const entries = args.entries.map((e) => ({ winner: e.winner, amount: BigInt(e.amount) }))
              tx = await new ethers.Contract(args.pool, POOL_ABI, ppw).proposeOutcome(entries)
              break
            }
            case 'approvePoolOutcome': {
              const apw = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              tx = await new ethers.Contract(args.pool, POOL_ABI, apw).approve()
              break
            }
            case 'claimPool': {
              const clw = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              const entries = args.entries.map((e) => ({ winner: e.winner, amount: BigInt(e.amount) }))
              tx = await new ethers.Contract(args.pool, POOL_ABI, clw)
                .claim(entries, args.index, args.recipient || clw.address)
              break
            }
            case 'refundPool': {
              const rfw = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              tx = await new ethers.Contract(args.pool, POOL_ABI, rfw).refund()
              break
            }
            case 'poolInfo': {
              const piPool = new ethers.Contract(args.pool, POOL_ABI, provider)
              const [state, memberCount, maxMembers, buyIn, tokenAddr, acceptDeadline, resolveDeadline, frozenDenominator, thresholdBips, currentProposalId] =
                await Promise.all([
                  piPool.state(), piPool.memberCount(), piPool.maxMembers(), piPool.buyIn(), piPool.token(),
                  piPool.acceptDeadline(), piPool.resolveDeadline(), piPool.frozenDenominator(),
                  piPool.thresholdBips(), piPool.currentProposalId(),
                ])
              return {
                ok: true,
                state: Number(state),
                memberCount: Number(memberCount),
                maxMembers: Number(maxMembers),
                buyIn: buyIn.toString(),
                token: tokenAddr,
                acceptDeadline: Number(acceptDeadline),
                resolveDeadline: Number(resolveDeadline),
                frozenDenominator: Number(frozenDenominator),
                thresholdBips: Number(thresholdBips),
                currentProposalId,
              }
            }
            case 'poolMemberInfo': {
              const pmPool = new ethers.Contract(args.pool, POOL_ABI, provider)
              const hasJoined = await pmPool.hasJoined(args.address)
              const refunded = await pmPool.refunded(args.address)
              const approvedBy = args.proposalId ? await pmPool.approvedBy(args.proposalId, args.address) : null
              return { ok: true, hasJoined, refunded, approvedBy }
            }
            case 'signPoolJoinAuthorization': {
              // Client-side signing only — no transaction. `fromIndex` is the JOINING member; they never
              // submit anything themselves (see submitPoolJoinAuthorization for the relayer leg).
              const fromWallet = new ethers.Wallet(ACCOUNT_KEYS[args.fromIndex ?? 1], provider)
              const value = BigInt(args.value)
              const nowBlk = (await provider.getBlock('latest')).timestamp
              const validAfter = args.validAfter ?? 0
              const validBefore = args.validBefore ?? nowBlk + 3600
              const nonce = ethers.hexlify(ethers.randomBytes(32))
              const domain = { name: 'USD Coin', version: '1', chainId: E2E_CHAIN_ID, verifyingContract: args.token }
              const message = { from: fromWallet.address, to: args.pool, value, validAfter, validBefore, nonce }
              const sig = await fromWallet.signTypedData(domain, RECEIVE_WITH_AUTHORIZATION_TYPES, message)
              const { v, r, s } = ethers.Signature.from(sig)
              return {
                ok: true, from: fromWallet.address, value: value.toString(), validAfter, validBefore, nonce, v, r, s,
              }
            }
            case 'submitPoolJoinAuthorization': {
              // Submitted by a DIFFERENT account (the relayer) — proves the joining member never sent a
              // transaction, only signed one. Resubmitting the same signature must revert — either the
              // pool's own AlreadyJoined guard or the token's authorization-reuse check, whichever runs
              // first — never a second join or a second pull of funds.
              const relayer = new ethers.Wallet(ACCOUNT_KEYS[args.relayerIndex ?? 0], provider)
              const rPool = new ethers.Contract(args.pool, POOL_ABI, relayer)
              tx = await rPool.joinWithAuthorization(
                args.from, BigInt(args.value), args.validAfter, args.validBefore, args.nonce, args.v, args.r, args.s
              )
              break
            }
            case 'createFundingPool': {
              if (!d.contracts.fundingPoolFactory) {
                return { ok: false, error: 'fundingPoolFactory is not deployed — run deploy-funding-pool-factory.js --network localhost' }
              }
              const fw = new ethers.Wallet(ACCOUNT_KEYS[args.organizerIndex ?? 0], provider)
              const ff = new ethers.Contract(d.contracts.fundingPoolFactory, FUNDING_FACTORY_ABI, fw)
              // Same anchoring rule as createPool above: read the timestamp Hardhat actually assigned.
              await provider.send('evm_mine', [])
              const fnow = (await provider.getBlock('latest')).timestamp
              const fparams = {
                token: args.token || d.paymentToken,
                goal: BigInt(args.goal ?? 100n * 10n ** 18n),
                purpose: args.purpose ?? 'E2E funding pool',
                contributeDeadline: fnow + (args.contributeIn ?? 3600),
                settleDeadline: fnow + (args.settleIn ?? 7200),
              }
              const fsent = await ff.createPool(fparams)
              const frc = await fsent.wait(1)
              const fev = frc.logs
                .map((l) => { try { return ff.interface.parseLog(l) } catch { return null } })
                .find((e) => e && e.name === 'PoolCreated')
              if (!fev) return { ok: false, error: 'PoolCreated event not found in receipt' }
              const wordIndices = [...fev.args.wordIndices].map(Number)
              return { ok: frc.status === 1, poolId: Number(fev.args.poolId), pool: fev.args.pool, wordIndices }
            }
            case 'contributeFunding': {
              // Approve-then-contribute as account #index — mirrors useFundingPools.contribute's self-submit path.
              const cw = new ethers.Wallet(ACCOUNT_KEYS[args.index ?? 1], provider)
              const cTok = new ethers.Contract(args.token || d.paymentToken, TOKEN_ABI, cw)
              const cPool = new ethers.Contract(args.pool, FUNDING_POOL_ABI, cw)
              const amount = BigInt(args.amount)
              let cNonce = await provider.getTransactionCount(cw.address, 'latest')
              const cAllow = await cTok.allowance(cw.address, args.pool)
              if (cAllow < amount) await (await cTok.approve(args.pool, amount, { nonce: cNonce++ })).wait(1)
              tx = await cPool.contribute(amount, { nonce: cNonce++ })
              break
            }
            case 'fundingAction': {
              // close | cancel | voteRefund | claimRefund | pokeDeadline as account #callerIndex.
              const fa = new ethers.Wallet(ACCOUNT_KEYS[args.callerIndex ?? 0], provider)
              const faPool = new ethers.Contract(args.pool, FUNDING_POOL_ABI, fa)
              if (!['close', 'cancel', 'voteRefund', 'claimRefund', 'pokeDeadline'].includes(args.fn)) {
                return { ok: false, error: `fundingAction: unknown fn ${args.fn}` }
              }
              tx = await faPool[args.fn]()
              break
            }
            case 'fundingInfo': {
              const fi = new ethers.Contract(args.pool, FUNDING_POOL_ABI, provider)
              const [fstate, forg, fpurpose, fgoal, fraised, fcount, fvotes, frefunded, freason, fcd, fsd] = await Promise.all([
                fi.state(), fi.organizer(), fi.purpose(), fi.goal(), fi.totalRaised(), fi.contributorCount(),
                fi.refundVotes(), fi.refundedCount(), fi.refundReason(), fi.contributeDeadline(), fi.settleDeadline(),
              ])
              return {
                ok: true,
                state: Number(fstate),
                organizer: forg,
                purpose: fpurpose,
                goal: fgoal.toString(),
                totalRaised: fraised.toString(),
                contributorCount: Number(fcount),
                refundVotes: Number(fvotes),
                refundedCount: Number(frefunded),
                refundReason: Number(freason),
                contributeDeadline: Number(fcd),
                settleDeadline: Number(fsd),
              }
            }
            case 'fundingMemberInfo': {
              const fm = new ethers.Contract(args.pool, FUNDING_POOL_ABI, provider)
              const [contributed, voted, refunded] = await Promise.all([
                fm.contributed(args.address), fm.votedRefund(args.address), fm.refunded(args.address),
              ])
              return { ok: true, contributed: contributed.toString(), voted, refunded }
            }
            case 'isFrozen': {
              const reg3 = new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, provider)
              return { ok: true, frozen: await reg3.isFrozen(args.address) }
            }
            /*
             * The registry's pause flag, READ. `pause`/`unpause` above are writes that no-op when
             * already in the wanted state, so neither can witness a pause the UI performed — which
             * is the whole assertion of the single-chain-write flow (#1242).
             */
            case 'registryPaused': {
              const reg4 = new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, provider)
              return { ok: true, paused: await reg4.paused() }
            }
            case 'autoResolve':
              tx = await registry.autoResolveFromPolymarket(args.wagerId); break
            case 'prepareCondition': {
              // Prepare a FRESH Polymarket condition owned by #0; return its id.
              // The questionId is salted so reusing the node across runs can't
              // collide with an already-prepared/resolved condition (createWager
              // reverts ConditionAlreadyResolved on a resolved id).
              const oracle = wallet.address
              const salt = `${args.question || 'q'}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
              const qid = ethers.id(salt)
              const cid = await ctf.getConditionId(oracle, qid, 2)
              await (await ctf.prepareCondition(oracle, qid, 2)).wait(1)
              return { ok: true, conditionId: cid }
            }
            case 'wagerInfo': {
              const reg2 = new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, provider)
              const w = await reg2.getWager(args.wagerId)
              return {
                ok: true, status: Number(w.status), winner: w.winner, paid: w.paid, metadataUri: w.metadataUri,
                resolutionType: Number(w.resolutionType), creator: w.creator, opponent: w.opponent,
              }
            }
            case 'pause':
              if (await registry.paused()) return { ok: true, noop: true }
              tx = await registry.pause(); break
            case 'unpause':
              if (!(await registry.paused())) return { ok: true, noop: true }
              tx = await registry.unpause(); break
            case 'freeze':
              tx = await registry.freezeAccount(args.address, args.reason || 'e2e'); break
            case 'unfreeze':
              if (!(await registry.isFrozen(args.address))) return { ok: true, noop: true }
              tx = await registry.unfreezeAccount(args.address); break
            case 'grantMembership':
              tx = await membership.grantMembership(
                args.address, WAGER_PARTICIPANT_ROLE, args.tier ?? 1, args.durationDays ?? 30
              ); break
            case 'resolveCondition':
              tx = await ctf.resolveCondition(args.conditionId, args.payouts); break

            // ---------------------------------------------------------------- spec 060 fees
            /*
             * The coordinates the fee spec needs, read from the deployment record and the chain
             * rather than restated in the spec. Two of them are assertions in disguise:
             *
             *   · a `feeRouter` the FRONTEND cannot resolve makes every quote fail and every
             *     deposit block, which would look like a product bug rather than a missing
             *     fixture — so the spec compares this address against the one the app is built
             *     with and says which it is;
             *   · a ZERO treasury means the router SKIPS the fee (FeeRouter.depositToVaultWithFee),
             *     so a "charged the disclosed rate" assertion would pass at a rate of nothing.
             *     Reported here so the spec can refuse to run rather than prove the wrong thing.
             */
            case 'feeFixtures': {
              const routerAddress = d.contracts?.feeRouter
              const vaultAddress = d.mocks?.mockEarnVault
              if (!routerAddress || !vaultAddress) {
                return {
                  ok: false,
                  error:
                    `the local deployment record has no ${!routerAddress ? 'contracts.feeRouter' : 'mocks.mockEarnVault'} — ` +
                    'run `npm run setup:e2e` (which deploys both) before the fee specs',
                }
              }
              const feeRouter = new ethers.Contract(routerAddress, FEE_ROUTER_ABI, provider)
              const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider)
              return {
                ok: true,
                feeRouter: routerAddress,
                treasury: await feeRouter.treasury(),
                vault: vaultAddress,
                asset: await vault.asset(),
              }
            }
            case 'feeService': {
              const feeRouter = new ethers.Contract(d.contracts.feeRouter, FEE_ROUTER_ABI, provider)
              const svc = await feeRouter.getService(ethers.id(args.label))
              return {
                ok: true,
                kind: Number(svc.kind),
                feeBps: Number(svc.feeBps),
                capBps: Number(svc.capBps),
              }
            }
            case 'setFeeBps': {
              // Sent as #0, which the local deploy seeds with FEE_ADMIN_ROLE on the router it
              // initialised. Used to ARRANGE a rate; the flow that proves an operator can change
              // one drives the AdminPanel Fees tab instead.
              const feeRouter = new ethers.Contract(d.contracts.feeRouter, FEE_ROUTER_ABI, wallet)
              tx = await feeRouter.setFeeBps(ethers.id(args.label), args.bps)
              break
            }
            case 'feeHistory': {
              const feeRouter = new ethers.Contract(d.contracts.feeRouter, FEE_ROUTER_ABI, provider)
              const filter = feeRouter.filters.FeeBpsChanged(ethers.id(args.label))
              const logs = await feeRouter.queryFilter(filter, args.fromBlock ?? 0, 'latest')
              return {
                ok: true,
                changes: logs.map((l) => ({
                  oldBps: Number(l.args.oldBps),
                  newBps: Number(l.args.newBps),
                  actor: l.args.actor,
                  blockNumber: l.blockNumber,
                })),
              }
            }
            case 'vaultPosition': {
              const vault = new ethers.Contract(d.mocks.mockEarnVault, VAULT_ABI, provider)
              const shares = await vault.balanceOf(args.address)
              return {
                ok: true,
                shares: shares.toString(),
                assets: (await vault.convertToAssets(shares)).toString(),
                totalAssets: (await vault.totalAssets()).toString(),
              }
            }
            // ------------------------------------------------- membership/role admin e2e (#1228)
            case 'hasAdminRole': {
              // The role registry the AccessControlApp grants on: the WagerRegistry for
              // operator roles, the MembershipManager for ROLE_MANAGER.
              const target = args.contract === 'membershipManager'
                ? d.contracts.membershipManager
                : d.contracts.wagerRegistry
              const c = new ethers.Contract(
                target,
                ['function hasRole(bytes32 role, address account) view returns (bool)'],
                provider,
              )
              return { ok: true, held: await c.hasRole(ethers.id(args.role), args.address) }
            }
            case 'membershipAdminState': {
              // Compiled ABI for the same reason voucherFixture spells out: TierConfig is a
              // nested tuple and a hand-written one decodes to garbage without throwing.
              const managerAbi = loadArtifact('access/MembershipManager.sol', 'MembershipManager').abi
              const m = new ethers.Contract(d.contracts.membershipManager, managerAbi, provider)
              const cfg = await m.getTierConfig(WAGER_PARTICIPANT_ROLE, args.tier ?? 1)
              return {
                ok: true,
                manager: d.contracts.membershipManager,
                paymentToken: d.paymentToken,
                treasury: await m.treasury(),
                accruedFees: (await m.accruedFees()).toString(),
                tierPriceUSDC: cfg.priceUSDC.toString(),
                tierDurationDays: Number(cfg.durationDays),
                tierActive: Boolean(cfg.active),
              }
            }
            case 'blockNumber':
              return { ok: true, blockNumber: await provider.getBlockNumber() }

            default:
              throw new Error(`chainTx: unknown action '${action}'`)
          }
          const receipt = await tx.wait(1)
          return { ok: receipt.status === 1, hash: receipt.hash }
          } catch (e) {
            // Return a soft failure so specs can assert "blocked" cases (e.g. a
            // premature claimRefund) instead of the task rejecting the test.
            return { ok: false, error: describeRevert(e) }
          }
        },

        /**
         * Fixtures for the legacy account recovery sweep (spec 062).
         *
         * The sweep signs with a key the MEMBER pastes in, not with the connected wallet, so a
         * test needs a real funded EOA whose private key it can hand to the UI. Every run mints
         * a FRESH one: a fixed key would accumulate balances across runs and make "what moved"
         * a function of how many times the suite had been run.
         *
         * `makeTokenRefuse` is how ONE asset is failed without disturbing the others — see its
         * own comment for why a drained balance cannot do that job.
         *
         * action ∈ newAccount | makeTokenRefuse | restoreTokenCode | fundNative | mintToken |
         *          balances | deploymentAddresses
         */
        /**
         * Fixtures for bridge + supplied liquidity (spec 067).
         *
         * Both routers are deployed on the local chain by `deploy-bridge-liquidity.js` (inside
         * `setup:e2e`), pointed at contracts/mocks stand-ins for Across and Uniswap. Those doubles
         * are what make the issue's central assertions possible at all: the SpokePool records
         * `lastDepositor`, and the position manager is a real ERC-721, so "the member is the
         * depositor" and "the position minted to the member" are read from chain state rather than
         * inferred from a success message.
         *
         * A trading pool has to be LISTED before it can be supplied to, and `listPool`
         * cross-checks the listing against the pool it names (token0/token1/fee), so the fixture
         * deploys a real MockUniswapV3Pool rather than listing an arbitrary address.
         *
         * action ∈ listTradingPool | poolPaused | setPaused | lastDepositor | positionOwner |
         *          tokenBalanceOf
         */
        async liquidityFixture({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const admin = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))
          const d = loadLocalDeployment()

          // Signatures copied from the contracts, not written from memory — a guessed one selects a
          // different function and reverts with nothing to explain it (see legacyFixture).
          const ROUTER_ABI = [
            'function listPool((uint8 kind, bool enabled, uint24 feeTier, address token0, address token1, address poolAddress, uint256 maxDeposit0PerTx, uint256 maxDeposit1PerTx) pool)',
            'function setPoolEnabled(bytes32 poolId, bool enabled)',
            'function computePoolId(uint8 kind, address poolAddress, address token0, address token1) pure returns (bytes32)',
            'function getPool(bytes32 poolId) view returns ((uint8 kind, bool enabled, uint24 feeTier, address token0, address token1, address poolAddress, uint256 maxDeposit0PerTx, uint256 maxDeposit1PerTx))',
            'function poolAt(uint256 index) view returns (bytes32)',
            'function pause()',
            'function unpause()',
            'function paused() view returns (bool)',
            'function poolCount() view returns (uint256)',
          ]
          const ERC721_ABI = [
            'function ownerOf(uint256 tokenId) view returns (address)',
            'function balanceOf(address owner) view returns (uint256)',
            // MockPositionManager's own counter: the id the NEXT mint will use. Read before a
            // supply so the test knows which token to look up afterwards — token ids accumulate
            // across specs on a shared node, so a hardcoded `1` asserts on whatever an earlier
            // run happened to leave behind.
            'function nextTokenId() view returns (uint256)',
            'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
          ]
          const ERC20_ABI = [
            'function balanceOf(address) view returns (uint256)',
            'function mint(address to, uint256 amount)',
          ]

          const liquidityRouter = d.contracts.liquidityRouter

          try {
            switch (action) {
              case 'listTradingPool': {
                /*
                 * Token order matters to Uniswap: token0 < token1 by address, and `listPool`
                 * cross-checks the listing against the pool contract it names — a listing whose
                 * fee tier or token order disagrees with the real pool is REJECTED, which is the
                 * point of that check. So the fixture deploys a pool with exactly the tuple it
                 * then lists.
                 */
                const [token0, token1] = [args.tokenA, args.tokenB].sort((a, b) =>
                  a.toLowerCase() < b.toLowerCase() ? -1 : 1,
                )
                const feeTier = args.feeTier ?? 3000
                const router0 = new ethers.Contract(liquidityRouter, ROUTER_ABI, admin)

                /*
                 * REUSE an already-curated pool for this pair AND FEE TIER. Listing a second one is not just
                 * wasteful: every listing renders as its own row for the same two tokens on the
                 * same network, and a spec that opens "the Amoy row" then has two identical rows
                 * to choose between — so which pool it supplied to would depend on curation order.
                 * One pool per (pair, fee tier) keeps the row a spec opens the pool it asserts on,
                 * and keeps repeated local runs from piling up listings on a long-lived node. The
                 * fee tier is what lets two specs each own a pool of the same pair: it is the one
                 * distinguishing thing the row renders ("0.30% fee").
                 */
                const existingCount = Number(await router0.poolCount())
                for (let i = 0; i < existingCount; i += 1) {
                  const id = await router0.poolAt(i)
                  const listed = await router0.getPool(id)
                  if (
                    Number(listed.kind) === 2 &&
                    listed.enabled &&
                    Number(listed.feeTier) === feeTier &&
                    listed.token0.toLowerCase() === token0.toLowerCase() &&
                    listed.token1.toLowerCase() === token1.toLowerCase()
                  ) {
                    return {
                      ok: true,
                      poolId: id,
                      poolAddress: listed.poolAddress,
                      token0: listed.token0,
                      token1: listed.token1,
                      feeTier: Number(listed.feeTier),
                      reused: true,
                    }
                  }
                }
                const artifactPath = resolve(
                  __dirname, '..', 'artifacts', 'contracts', 'mocks',
                  'MockUniswapV3Pool.sol', 'MockUniswapV3Pool.json',
                )
                const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
                const deployed = await new ethers.ContractFactory(
                  artifact.abi, artifact.bytecode, admin,
                // Tick spacing follows the fee tier, as Uniswap's factory enforces it
                // (500→10, 3000→60, 10000→200). The router derives full-range ticks from the
                // pool's own spacing, so a mismatched pair mints a position at the wrong bounds.
                ).deploy(token0, token1, feeTier, { 500: 10, 3000: 60, 10000: 200 }[feeTier] ?? 60)
                await deployed.waitForDeployment()
                const poolAddress = await deployed.getAddress()

                const router = new ethers.Contract(liquidityRouter, ROUTER_ABI, admin)
                const TRADING_LP = 2 // ILiquidityRouter.PoolKind — Unlisted, BridgeLp, TradingLp
                const rc = await (await router.listPool({
                  kind: TRADING_LP,
                  enabled: true,
                  feeTier,
                  token0,
                  token1,
                  poolAddress,
                  maxDeposit0PerTx: 0n,
                  maxDeposit1PerTx: 0n,
                })).wait(1)
                const poolId = await router.computePoolId(TRADING_LP, poolAddress, token0, token1)
                return { ok: rc.status === 1, poolId, poolAddress, token0, token1, feeTier }
              }
              case 'poolPaused': {
                const router = new ethers.Contract(liquidityRouter, ROUTER_ABI, provider)
                return { ok: true, paused: await router.paused() }
              }
              case 'setPaused': {
                // IDEMPOTENT on purpose. OpenZeppelin's Pausable reverts `ExpectedPause` /
                // `EnforcedPause` when the flag is already where you are asking it to go, so a
                // spec establishing a known starting state would fail on the state it wanted.
                const router = new ethers.Contract(liquidityRouter, ROUTER_ABI, admin)
                const want = Boolean(args.paused)
                if ((await router.paused()) === want) return { ok: true, paused: want, changed: false }
                const rc = await (await (want ? router.pause() : router.unpause())).wait(1)
                return { ok: rc.status === 1, paused: want, changed: true }
              }
              case 'positionOwner': {
                const nfpm = new ethers.Contract(d.uniswapPositionManager, ERC721_ABI, provider)
                const [owner, position] = await Promise.all([
                  nfpm.ownerOf(BigInt(args.tokenId)),
                  nfpm.positions(BigInt(args.tokenId)),
                ])
                return { ok: true, owner, liquidity: position.liquidity.toString() }
              }
              case 'positionCounters': {
                // `nextTokenId` identifies the token a supply is ABOUT to mint; `balance` is how
                // many the member holds. Together they let a flow assert on the position it just
                // created without assuming it is the only one on the chain.
                const nfpm = new ethers.Contract(d.uniswapPositionManager, ERC721_ABI, provider)
                const [nextTokenId, balance] = await Promise.all([
                  nfpm.nextTokenId(),
                  nfpm.balanceOf(args.owner),
                ])
                return { ok: true, nextTokenId: Number(nextTokenId), balance: Number(balance) }
              }
              case 'tokenBalanceOf': {
                const token = new ethers.Contract(args.token, ERC20_ABI, provider)
                return { ok: true, balance: (await token.balanceOf(args.address)).toString() }
              }
              default:
                throw new Error(`liquidityFixture: unknown action '${action}'`)
            }
          } catch (e) {
            return { ok: false, error: e.shortMessage || e.reason || e.message }
          }
        },

        /**
         * Fixtures for the bridge half of spec 067 (issue #1236).
         *
         * Everything a bridge flow needs that the app cannot do for itself: an operator-curated
         * route, the platform rate on the `bridge.transfer` service, and — the point of the whole
         * exercise — what the SpokePool wrote down. `MockAcrossSpokePool` records `depositor`
         * verbatim, and that field is the one the refund path depends on: Across refunds an
         * unfilled deposit to the depositor on the ORIGIN chain, so a router that named itself
         * there would strand every member's refund.
         *
         * action ∈ setRoute | lastDeposit | setBridgeFeeBps | bridgePaused
         */
        async bridgeFixture({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const admin = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))
          const d = loadLocalDeployment()

          // Signatures copied from contracts/bridge/IBridgeRouter.sol and contracts/fees, never
          // written from memory: a plausible-looking guess selects a different function and
          // reverts with nothing to explain it.
          const BRIDGE_ABI = [
            'function setRoute((address inputToken, bool enabled, bool nativeInput, uint32 expectedFillSeconds, address outputToken, uint256 destinationChainId, uint256 maxAmount) route)',
            'function computeRouteId(address inputToken, address outputToken, uint256 destinationChainId) pure returns (bytes32)',
            'function paused() view returns (bool)',
            'function routeCount() view returns (uint256)',
          ]
          const SPOKE_ABI = [
            'function lastDepositor() view returns (address)',
            'function lastRecipient() view returns (address)',
            'function lastInputAmount() view returns (uint256)',
            'function depositCount() view returns (uint256)',
          ]
          const FEE_ABI = [
            'function setFeeBps(bytes32 serviceId, uint16 bps)',
            'function feeBps(bytes32 serviceId) view returns (uint16)',
          ]
          const BRIDGE_TRANSFER = ethers.keccak256(ethers.toUtf8Bytes('bridge.transfer'))

          try {
            switch (action) {
              case 'setRoute': {
                const router = new ethers.Contract(d.contracts.bridgeRouter, BRIDGE_ABI, admin)
                const route = {
                  inputToken: args.inputToken,
                  enabled: args.enabled !== false,
                  nativeInput: Boolean(args.nativeInput),
                  expectedFillSeconds: args.expectedFillSeconds ?? 120,
                  outputToken: args.outputToken,
                  destinationChainId: BigInt(args.destinationChainId),
                  maxAmount: BigInt(args.maxAmount ?? 0),
                }
                const rc = await (await router.setRoute(route)).wait(1)
                const routeId = await router.computeRouteId(
                  route.inputToken, route.outputToken, route.destinationChainId,
                )
                return { ok: rc.status === 1, routeId }
              }
              case 'lastDeposit': {
                const spoke = new ethers.Contract(d.acrossSpokePool, SPOKE_ABI, provider)
                const [depositor, recipient, amount, count] = await Promise.all([
                  spoke.lastDepositor(), spoke.lastRecipient(), spoke.lastInputAmount(), spoke.depositCount(),
                ])
                return {
                  ok: true,
                  depositor,
                  recipient,
                  amount: amount.toString(),
                  depositCount: Number(count),
                }
              }
              case 'setBridgeFeeBps': {
                const fees = new ethers.Contract(d.contracts.feeRouter, FEE_ABI, admin)
                const rc = await (await fees.setFeeBps(BRIDGE_TRANSFER, Number(args.bps))).wait(1)
                return { ok: rc.status === 1, bps: Number(await fees.feeBps(BRIDGE_TRANSFER)) }
              }
              case 'bridgeFeeBps': {
                const fees = new ethers.Contract(d.contracts.feeRouter, FEE_ABI, provider)
                return { ok: true, bps: Number(await fees.feeBps(BRIDGE_TRANSFER)) }
              }
              default:
                throw new Error(`bridgeFixture: unknown action '${action}'`)
            }
          } catch (e) {
            return { ok: false, error: e.shortMessage || e.reason || e.message }
          }
        },

        /**
         * The committed mini-app package fixture, read on the NODE side.
         *
         * `src/test/miniapps/fixtures/index.js` imports `node:fs`, so a spec cannot import it.
         * The files are UTF-8 text and are handed over AS TEXT: a base64 round-trip through
         * `cy.intercept`'s body ended up re-encoded, and the loader — correctly — refused the
         * result as a failed integrity check. What has to survive intact is the exact byte
         * sequence, because that is what gets hashed.
         *
         * `variant: 'tampered'` returns the committed tampered bytes — the same CID, different
         * content — which is the supply-chain attack the loader's hashing exists to refuse.
         */
        miniappPackage({ variant = 'approved' } = {}) {
          const dir = resolve(__dirname, 'src', 'test', 'miniapps', 'fixtures')
          const onchain = JSON.parse(readFileSync(resolve(dir, 'onchain.json'), 'utf8'))
          const from = resolve(dir, variant === 'tampered' ? 'tampered' : 'package')
          // The tampered fixture only carries the files it actually changed; anything it does not
          // override is served from the approved package, so the ONLY difference reaching the
          // loader is the tampering itself.
          const read = (name) => {
            const candidate = resolve(from, name)
            const file = existsSync(candidate) ? candidate : resolve(dir, 'package', name)
            return readFileSync(file, 'utf8')
          }
          return {
            ok: true,
            variant,
            cid: onchain.approved.cid,
            manifestHash: onchain.approved.manifestHash,
            files: {
              'manifest.json': read('manifest.json'),
              'entry.js': read('entry.js'),
              'style.css': read('style.css'),
            },
          }
        },


        /**
         * A mini-app catalog, ABI-ENCODED — the no-chain tier's registry.
         *
         * Browsing a catalogue is reading, filtering and pinning: nothing signs, nothing settles,
         * and nothing about it needs a chain. The e2e admission rule is explicit that a flow
         * validatable without a chain must NOT live in the on-chain tier, so this one runs in the
         * fast tier and the registry read is answered from here.
         *
         * The encoding is done with the REAL ABI fragment the app reads through
         * (`frontend/src/abis/miniAppRegistry.js`), on the Node side, so the spec never
         * hand-assembles a tuple: a field added to `AppView` changes what this returns rather than
         * producing plausible garbage that decodes into the wrong columns.
         *
         * Answers are keyed by SELECTOR so a spec can dispatch on `params[0].data.slice(0, 10)`
         * without knowing how either call is encoded.
         */
        miniappCatalogWorld({ apps = [] } = {}) {
          const iface = new ethers.Interface([
            'function appCount() view returns (uint256)',
            'function getAppsPaged(uint256 offset, uint256 limit) view returns ((uint256 id, address vendor, string name, string description, uint8 category, uint8 status, bool launchable, (string cid, bytes32 manifestHash, uint64 version) approved, (string cid, bytes32 manifestHash, uint64 version) proposed, uint64 submittedAt, uint64 approvedAt, uint64 updatedAt)[] apps)',
          ])
          const now = Math.floor(Date.UTC(2026, 0, 1) / 1000) // fixed: nothing here may depend on the clock
          const rows = apps.map((a, i) => [
            BigInt(a.id ?? i + 1),
            a.vendor ?? '0x00000000000000000000000000000000000000a1',
            a.name,
            a.description ?? `${a.name} — a curated mini-app.`,
            a.category ?? 0,
            a.status ?? 1, // Approved
            a.launchable ?? true,
            [a.cid ?? `bafybei${'x'.repeat(45)}`, a.manifestHash ?? `0x${'11'.repeat(32)}`, BigInt(a.version ?? 1)],
            ['', `0x${'00'.repeat(32)}`, 0n],
            BigInt(now),
            BigInt(now),
            BigInt(now),
          ])
          return {
            ok: true,
            count: rows.length,
            answers: {
              [iface.getFunction('appCount').selector]: iface.encodeFunctionResult('appCount', [rows.length]),
              [iface.getFunction('getAppsPaged').selector]: iface.encodeFunctionResult('getAppsPaged', [rows]),
            },
          }
        },



        /**
         * The tenant manifests, read from disk (spec 072).
         *
         * `tenants/<id>/manifest.json` is the single source of truth for a tenant's identity, and
         * the flow's claim is that the RENDERED brand comes from it. Comparing the page against
         * values hardcoded in a spec would only prove the spec and the page agree; comparing it
         * against the manifest compares two independent sources, and a manifest edit that the app
         * stops honouring then fails here.
         *
         * `others` carries every OTHER tenant's display name, so "and no other tenant's identity"
         * is derived from what exists rather than from a name someone remembered to list.
         */
        tenantManifests({ id = 'fairwins' } = {}) {
          const dir = resolve(__dirname, '..', 'tenants')
          const ids = readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && existsSync(resolve(dir, e.name, 'manifest.json')))
            .map((e) => e.name)
          const read = (tenantId) => JSON.parse(readFileSync(resolve(dir, tenantId, 'manifest.json'), 'utf8'))
          const active = read(id)
          return {
            ok: true,
            id: active.id,
            displayName: active.identity.displayName,
            htmlTitle: active.brand.htmlTitle ?? active.identity.displayName,
            copyrightNotice:
              active.identity.copyrightNotice ?? active.identity.legalName ?? active.identity.displayName,
            logo: active.brand.logo,
            others: ids.filter((t) => t !== id).map((t) => read(t).identity.displayName),
          }
        },

        /**
         * ABI-encoded answers for the identity surfaces (specs 054 + 007), no-chain tier.
         *
         * Callsign resolution, the Gold gate and sanctions screening are all single contract READS,
         * and all three decide something a member sees rather than anything that settles. So the
         * flows belong in the no-chain tier, and the reads are answered here — encoded with the
         * app's OWN ABI fragments so a struct field added to `CallsignInfo` changes what this
         * returns rather than decoding into the wrong columns.
         *
         * Keyed by SELECTOR so a spec can dispatch on `params[0].data.slice(0, 10)` without knowing
         * how any of them is encoded. Anything not listed stays unanswered on purpose: `0x` makes
         * ethers reject the decode, which every caller here turns into an honest unavailable state
         * rather than into a fabricated value.
         */
        identityWorld({ callsign = null, owner = null, tier = 0, allowed = true, vaultOwners = null } = {}) {
          // Copied from frontend/src/abis/callsignRegistry.js and the membership/guard ABIs.
          const CALLSIGN_INFO =
            '(address owner, string callsign, uint8 status, bool verified, address pendingOwner, uint64 repointEffectiveAt, uint64 quarantinedUntil)'
          const iface = new ethers.Interface([
            `function resolve(string callsign) view returns (${CALLSIGN_INFO})`,
            'function getActiveTier(address user, bytes32 role) view returns (uint8)',
            'function isAllowed(address account) view returns (bool)',
            // The four reads `lib/custody/safeVault.js#loadVault` makes. A vault is a PRECONDITION
            // for the "refused while operating as a vault" flow, never its subject: what is under
            // test is a client-side refusal, and a Safe that answers is the cheapest way to reach
            // it. Answering them is strictly less than deploying one.
            'function getOwners() view returns (address[])',
            'function getThreshold() view returns (uint256)',
            'function nonce() view returns (uint256)',
            'function VERSION() view returns (string)',
          ])
          const CALLSIGN_STATUS_ACTIVE = 1
          const answers = {
            [iface.getFunction('getActiveTier').selector]: iface.encodeFunctionResult('getActiveTier', [tier]),
            [iface.getFunction('isAllowed').selector]: iface.encodeFunctionResult('isAllowed', [allowed]),
          }
          if (vaultOwners) {
            answers[iface.getFunction('getOwners').selector] = iface.encodeFunctionResult('getOwners', [vaultOwners])
            answers[iface.getFunction('getThreshold').selector] = iface.encodeFunctionResult('getThreshold', [
              Math.min(2, vaultOwners.length),
            ])
            answers[iface.getFunction('nonce').selector] = iface.encodeFunctionResult('nonce', [0])
            answers[iface.getFunction('VERSION').selector] = iface.encodeFunctionResult('VERSION', ['1.4.1'])
          }
          if (callsign && owner) {
            answers[iface.getFunction('resolve').selector] = iface.encodeFunctionResult('resolve', [
              [owner, callsign, CALLSIGN_STATUS_ACTIVE, true, ethers.ZeroAddress, 0n, 0n],
            ])
          }
          return { ok: true, answers }
        },

        /**
         * A REAL first-party mini-app package (Token Mint, spec 028 / ClearPath, spec 030),
         * read from what `npm run publish:local:miniapps` staged.
         *
         * Not a fixture. These are the same bytes `scripts/miniapps/publish.js` would pin, built
         * by the same preset, hashed by the same pipeline — the `--dev` mode differs from the
         * pinned one only in where the files end up, which is the property that makes serving
         * them here worth anything. The staging id it prints is `dev<manifestHash minus 0x>`, so
         * the CID is recomputed here from the manifest rather than parsed out of that output:
         * the value the chain is told and the value the gateway is asked for then come from the
         * same bytes by construction.
         *
         * `styles` is read from the manifest instead of assumed, because a package that ships no
         * stylesheet is a shape the host must handle and a hardcoded `style.css` would hide it.
         */
        miniappRealPackage({ app }) {
          const dir = resolve(__dirname, 'miniapps', app, 'dist')
          if (!existsSync(resolve(dir, 'manifest.json'))) {
            return {
              ok: false,
              error:
                `frontend/miniapps/${app}/dist/manifest.json is missing — run \`npm run setup:e2e\` ` +
                '(whose last step is `publish:local:miniapps`) before the mini-app specs',
            }
          }
          const manifestText = readFileSync(resolve(dir, 'manifest.json'), 'utf8')
          const manifestHash = ethers.keccak256(ethers.toUtf8Bytes(manifestText))
          const manifest = JSON.parse(manifestText)
          const files = { 'manifest.json': manifestText }
          for (const name of [manifest.entry, ...(manifest.styles || [])]) {
            files[name] = readFileSync(resolve(dir, name), 'utf8')
          }
          return {
            ok: true,
            app,
            name: manifest.name,
            appId: manifest.id,
            // `dev` + the hash, exactly as publish.js derives it for a locally staged package.
            cid: `dev${manifestHash.slice(2)}`,
            manifestHash,
            permissions: manifest.permissions || [],
            contracts: manifest.contracts || [],
            files,
          }
        },

        /**
         * Fixtures for the mini-app platform (specs 073 / 077 / 028 / 030).
         *
         * The registry is the trust boundary for what code the host EXECUTES, so this task only
         * ARRANGES chain state — submit a listing, approve it, propose an update, suspend it —
         * and READS it back. It never fetches or verifies a package: the bytes reach the app
         * through the gateway the loader itself calls, and the hashing that admits them is the
         * app's own. A fixture that verified on the app's behalf would be testing itself.
         *
         * The vendor gate is real too (Silver on WAGER_PARTICIPANT_ROLE), so `submitApp` seeds
         * membership rather than routing around the check.
         *
         * action ∈ submitApp | approve | reject | submitUpdate | suspend | appState | reset
         */
        async miniappFixture({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const admin = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))
          const d = loadLocalDeployment()

          // Signatures copied verbatim from contracts/apps/MiniAppRegistry.sol and its interface.
          const REGISTRY_ABI = [
            'function submitApp(string name, string description, uint8 category, string cid, bytes32 manifestHash) returns (uint256)',
            'function submitUpdate(uint256 id, string cid, bytes32 manifestHash)',
            'function approveApp(uint256 id, bytes32 expectedManifestHash)',
            'function rejectProposal(uint256 id, bytes32 expectedManifestHash)',
            'function suspendApp(uint256 id)',
            'function isLaunchable(uint256 id) view returns (bool)',
            'function idByName(string name) view returns (uint256)',
            'function appCount() view returns (uint256)',
            // Field ORDER copied from IMiniAppRegistry.sol#AppView — a plausible reordering decodes
            // to garbage or throws, and neither failure names the ABI as the cause.
            'function getApp(uint256 id) view returns (tuple(uint256 id, address vendor, string name, string description, uint8 category, uint8 status, bool launchable, tuple(string cid, bytes32 manifestHash, uint64 version) approved, tuple(string cid, bytes32 manifestHash, uint64 version) proposed, uint64 submittedAt, uint64 approvedAt, uint64 updatedAt))',
          ]
          // `durationDays` is uint32, NOT uint256 — copied from contracts/access/MembershipManager.sol.
          // A uint256 here selects a function that does not exist, falls through, and reverts with
          // no data, which reads like a failing require rather than a wrong ABI.
          const MEMBERSHIP_ABI = [
            'function grantMembership(address user, bytes32 role, uint8 tier, uint32 durationDays)',
          ]
          const WAGER_PARTICIPANT_ROLE = ethers.id('WAGER_PARTICIPANT_ROLE')

          const registryAddress = d.contracts?.miniAppRegistry
          if (!registryAddress) {
            return {
              ok: false,
              error:
                'the local deployment record has no contracts.miniAppRegistry — run `npm run setup:e2e` ' +
                '(which now includes `deploy:local:miniapps`) before the mini-app specs',
            }
          }
          const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, admin)

          const view = async (id) => {
            const a = await registry.getApp(BigInt(id))
            return {
              id: Number(a.id),
              vendor: a.vendor,
              status: Number(a.status), // Pending 0, Approved 1, Suspended 2, Deprecated 3
              launchable: a.launchable,
              name: a.name,
              approved: { cid: a.approved.cid, manifestHash: a.approved.manifestHash, version: Number(a.approved.version) },
              proposed: { cid: a.proposed.cid, manifestHash: a.proposed.manifestHash, version: Number(a.proposed.version) },
            }
          }

          try {
            switch (action) {
              case 'submitApp': {
                // The vendor tier gate is real; seed it rather than route around it.
                const membership = new ethers.Contract(d.contracts.membershipManager, MEMBERSHIP_ABI, admin)
                await (await membership.grantMembership(
                  await admin.getAddress(), WAGER_PARTICIPANT_ROLE, args.tier ?? 3, 365,
                )).wait(1)

                // Idempotent: a spec re-run against a long-lived node must not hit DuplicateName.
                const existing = Number(await registry.idByName(args.name))
                if (existing !== 0) return { ok: true, id: existing, reused: true, ...(await view(existing)) }

                const rc = await (await registry.submitApp(
                  args.name,
                  args.description ?? 'A committed fixture package, served to the loader over the gateway.',
                  args.category ?? 0,
                  args.cid,
                  args.manifestHash,
                )).wait(1)
                const id = Number(await registry.idByName(args.name))
                return { ok: rc.status === 1, id, reused: false, ...(await view(id)) }
              }
              /*
               * Bring the listing to "serving this exact package, nothing in review", FROM ANY
               * STATE. The fixture manifest claims the id `fixture-app`, and the loader checks
               * that against `appSlug(record.name)` — so every flow here has to share ONE record,
               * and a spec that assumed a clean chain would fail on its own second run against
               * whatever the previous one left behind.
               *
               * It converges rather than resetting: read the record, clear any proposal with the
               * proposal's OWN hash (the contract is content-committed, so a guessed hash is
               * refused), then approve if it is not already serving.
               */
              case 'ensureServing': {
                const membership = new ethers.Contract(d.contracts.membershipManager, MEMBERSHIP_ABI, admin)
                await (await membership.grantMembership(
                  await admin.getAddress(), WAGER_PARTICIPANT_ROLE, args.tier ?? 3, 365,
                )).wait(1)

                let id = Number(await registry.idByName(args.name))
                if (id === 0) {
                  await (await registry.submitApp(
                    args.name,
                    args.description ?? 'A committed fixture package, served to the loader over the gateway.',
                    args.category ?? 0,
                    args.cid,
                    args.manifestHash,
                  )).wait(1)
                  id = Number(await registry.idByName(args.name))
                }

                let cur = await view(id)
                // A proposal for the package we WANT is the thing to approve, not to clear — on a
                // freshly submitted record that proposal is the only copy there is, and rejecting
                // it leaves nothing to approve at all (`NothingProposed`). Only a FOREIGN proposal,
                // left by a flow that swapped one in, gets cleared.
                if (cur.proposed.cid && cur.proposed.manifestHash !== args.manifestHash) {
                  await (await registry.rejectProposal(BigInt(id), cur.proposed.manifestHash)).wait(1)
                  cur = await view(id)
                }
                // The record exists but holds our package nowhere — a listing whose only proposal
                // was rejected has neither an approved nor a proposed tuple, and there is nothing
                // for `approveApp` to promote. Re-propose it.
                if (!cur.proposed.cid && cur.approved.manifestHash !== args.manifestHash) {
                  await (await registry.submitUpdate(BigInt(id), args.cid, args.manifestHash)).wait(1)
                  cur = await view(id)
                }
                /*
                 * Approve when the record is not serving AT ALL, and equally when it is serving
                 * something ELSE. The second case is the one that bit: a record left launchable on
                 * a previous version satisfied `launchable`, so the new proposal sat in review and
                 * the flow served bytes the chain had not approved. The loader refused them — and
                 * the failure read "and it is the package just built", which is true and says
                 * nothing about why.
                 */
                if (!cur.launchable || cur.approved.manifestHash !== args.manifestHash) {
                  // Promote the proposal if there is one; otherwise reinstate what was approved
                  // before (the shape `approveApp` takes for a suspended record).
                  const expected = cur.proposed.cid ? cur.proposed.manifestHash : cur.approved.manifestHash
                  await (await registry.approveApp(BigInt(id), expected)).wait(1)
                  cur = await view(id)
                }
                return { ok: true, id, ...cur }
              }
              case 'approve': {
                const rc = await (await registry.approveApp(BigInt(args.id), args.expectedManifestHash)).wait(1)
                return { ok: rc.status === 1, ...(await view(args.id)) }
              }
              case 'reject': {
                const rc = await (await registry.rejectProposal(BigInt(args.id), args.expectedManifestHash)).wait(1)
                return { ok: rc.status === 1, ...(await view(args.id)) }
              }
              case 'submitUpdate': {
                const rc = await (await registry.submitUpdate(BigInt(args.id), args.cid, args.manifestHash)).wait(1)
                return { ok: rc.status === 1, ...(await view(args.id)) }
              }
              case 'suspend': {
                const rc = await (await registry.suspendApp(BigInt(args.id))).wait(1)
                return { ok: rc.status === 1, ...(await view(args.id)) }
              }
              case 'appState': {
                const id = args.id ?? Number(await registry.idByName(args.name))
                if (!id) return { ok: true, id: 0, exists: false }
                return { ok: true, exists: true, appCount: Number(await registry.appCount()), ...(await view(id)) }
              }
              default:
                throw new Error(`miniappFixture: unknown action '${action}'`)
            }
          } catch (e) {
            return { ok: false, error: e.shortMessage || e.reason || e.message }
          }
        },

        /**
         * Sanctions screening state (spec 021 guard, used here for spec 073's host rule).
         *
         * Nothing about the screening path is stubbed: `useAddressScreening` reads the on-chain
         * `SanctionsGuard`, so making an account restricted means writing the deny list the app
         * will actually read. That is what lets the mini-app flow assert the host refused a
         * submission rather than assert that a mock said it would.
         *
         * IDEMPOTENT and reversible. The e2e member IS the deployer, so a flow that denies it
         * must put it back — otherwise every later test in the file inherits a restricted wallet
         * and fails for a reason that has nothing to do with what it measures.
         *
         * action ∈ setDenied | status
         */
        async sanctionsFixture({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const admin = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))
          const d = loadLocalDeployment()
          // Copied from contracts/access/SanctionsGuard.sol — `setDenied` carries a reason string
          // and is gated on SANCTIONS_ADMIN_ROLE, which the local deployer holds.
          const guard = new ethers.Contract(
            d.contracts.sanctionsGuard,
            [
              'function setDenied(address account, bool denied, string reason)',
              'function isAllowed(address account) view returns (bool)',
              'function isDenied(address account) view returns (bool)',
            ],
            admin,
          )
          try {
            switch (action) {
              case 'setDenied': {
                const denied = Boolean(args.denied)
                // Writing the state it is already in is a wasted block, not an error — but the
                // read afterwards is what the caller is told, either way.
                if ((await guard.isDenied(args.address)) !== denied) {
                  await (await guard.setDenied(args.address, denied, args.reason ?? 'e2e fixture')).wait(1)
                }
                return { ok: true, denied: await guard.isDenied(args.address), allowed: await guard.isAllowed(args.address) }
              }
              case 'status':
                return { ok: true, denied: await guard.isDenied(args.address), allowed: await guard.isAllowed(args.address) }
              default:
                throw new Error(`sanctionsFixture: unknown action '${action}'`)
            }
          } catch (e) {
            return { ok: false, error: e.shortMessage || e.reason || e.message }
          }
        },

        /**
         * Fixtures for ClearPath (spec 030) and Token Mint (spec 028) — the two real packages.
         *
         * Both apps act on contracts the HOST resolves and the CHAIN gates, so everything here
         * either arranges an authorization the member genuinely needs (a membership tier, the
         * token-issuer role) or reads back what the chain recorded. No app action is performed:
         * the flow drives those through the mini-app's own UI, which is the only way the claim
         * "the package can do this" means anything.
         *
         * `deployGovernor` is the one exception in spirit and not in fact: the registry's
         * `_isGovernor` probe is a real on-chain call, and a local node has no DAO to point it at,
         * so a stand-in has to exist before the flow can exercise the probe at all.
         *
         * action ∈ grantDaoTier | daoRegistry | deployGovernor | tokenCount
         */
        async appActorFixture({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const admin = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))
          const d = loadLocalDeployment()

          // `durationDays` is uint32 — see the note on miniappFixture's copy of this signature.
          const MEMBERSHIP_ABI = ['function grantMembership(address user, bytes32 role, uint8 tier, uint32 durationDays)']
          const DAO_MEMBER_ROLE = ethers.id('DAO_MEMBER_ROLE')

          try {
            switch (action) {
              case 'grantDaoTier': {
                const membership = new ethers.Contract(d.contracts.membershipManager, MEMBERSHIP_ABI, admin)
                // Silver is the registry's floor (ExternalDAORegistry#registerExternalDAO); Gold is
                // granted so the flow is not sitting exactly on the boundary it is not testing.
                await (await membership.grantMembership(args.address, DAO_MEMBER_ROLE, args.tier ?? 3, 365)).wait(1)
                return { ok: true }
              }
              case 'daoRegistry': {
                // Field order copied from contracts/clearpath/ExternalDAORegistry.sol.
                const registry = new ethers.Contract(
                  d.contracts.externalDAORegistry,
                  [
                    'function isRegistered(address dao) view returns (bool)',
                    'function getExternalDAOsByRegistrant(address who) view returns (uint256[])',
                    'function externalCount() view returns (uint256)',
                  ],
                  provider,
                )
                return {
                  ok: true,
                  registered: await registry.isRegistered(args.dao),
                  byRegistrant: (await registry.getExternalDAOsByRegistrant(args.registrant ?? args.dao)).map(Number),
                  externalCount: Number(await registry.externalCount()),
                }
              }
              /*
               * A FRESH Governor for the flow to register, deployed per call.
               *
               * `registerExternalDAO` reverts `AlreadyRegistered` for a DAO already in the
               * registry, so a single recorded stand-in would make the register flow pass exactly
               * once and then fail against the same node for the rest of its life. Registration is
               * permanent by design — there is no unregister — so the only re-runnable shape is a
               * new DAO each time.
               *
               * `contracts/mocks/clearpath/MockGovernorLike.sol` is the same double the contract
               * suite uses for `_isGovernor`, so the e2e flow and the unit tests agree on what a
               * Governor is. `true` = it answers the ERC-165 probe.
               */
              case 'deployGovernor': {
                const art = loadArtifact('mocks/clearpath/MockGovernorLike.sol', 'MockGovernorLike')
                const gov = await new ethers.ContractFactory(art.abi, art.bytecode, admin).deploy(true)
                await gov.waitForDeployment()
                return { ok: true, address: await gov.getAddress() }
              }
              case 'tokenCount': {
                const factory = new ethers.Contract(
                  d.contracts.tokenFactory,
                  [
                    'function tokenCount() view returns (uint256)',
                    'function getTokensByIssuer(address issuer) view returns (uint256[])',
                  ],
                  provider,
                )
                return {
                  ok: true,
                  total: Number(await factory.tokenCount()),
                  byIssuer: args.issuer ? (await factory.getTokensByIssuer(args.issuer)).map(Number) : [],
                }
              }
              default:
                throw new Error(`appActorFixture: unknown action '${action}'`)
            }
          } catch (e) {
            return { ok: false, error: e.shortMessage || e.reason || e.message }
          }
        },


        /**
         * Fixtures for membership vouchers (spec 026) and the swap doubles (spec 033).
         *
         * Everything here is either an on-chain PRECONDITION the member would otherwise have had
         * to buy, or a read of what the chain recorded. The redemption itself is never performed:
         * that is the flow's job, through the app, which is the only way "a member can redeem a
         * voucher" means anything.
         *
         * Vouchers are minted BY the recipient (the contract mints to `msg.sender` and charges
         * that tier's USDC price), so this funds and approves that account first. Routing around
         * the payment would make the mint a different transaction than the one a member sends.
         *
         * action ∈ mintVoucher | vouchersOf | membership | swapRate
         */
        async voucherFixture({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const admin = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))
          const d = loadLocalDeployment()

          /*
           * COMPILED ABIs, not hand-written ones.
           *
           * `TierConfig` is `{uint128 priceUSDC; uint32 durationDays; bool active; Limits limits}`
           * and `Membership` carries an `activeCount` between `monthCount` and `monthAnchor` —
           * neither matches the plausible ordering, and a wrong one does not throw: it decodes to
           * garbage, so `cfg.priceUSDC` came back as something that funded the buyer with nothing
           * and the mint reverted on an allowance the fixture thought it had set. Reading the
           * artifact removes the whole class of that mistake, and costs nothing here because
           * `npm run compile` has already run before any E2E setup.
           */
          const VOUCHER_ABI = loadArtifact('access/MembershipVoucher.sol', 'MembershipVoucher').abi
          const MANAGER_ABI = loadArtifact('access/MembershipManager.sol', 'MembershipManager').abi
          const TOKEN = [
            'function mint(address to, uint256 amount)',
            'function approve(address spender, uint256 amount) returns (bool)',
            'function balanceOf(address) view returns (uint256)',
          ]
          const WAGER_PARTICIPANT_ROLE = ethers.id('WAGER_PARTICIPANT_ROLE')

          const voucherAddress = d.contracts?.membershipVoucher
          if (!voucherAddress) {
            return { ok: false, error: 'no contracts.membershipVoucher in the local deployment record — run `npm run setup:e2e`' }
          }

          try {
            switch (action) {
              /*
               * A redeemer with NO active membership, plus a voucher in their hands.
               *
               * `redeemVoucher` reverts `AlreadyActive` for a member who already has one, and
               * redeeming is permanent for the membership's duration — so a fixed account makes
               * this flow pass exactly once against any given node and fail for the rest of its
               * life. That is the "unfalsifiable when run alone" failure the policy names, arriving
               * from the other direction.
               *
               * So the account is CHOSEN, not fixed: walk hardhat's own unlocked accounts and take
               * the first that owes nothing to an earlier run. It must be one the node can sign
               * for — the browser sends `redeemVoucher` through `eth_sendTransaction`, which the
               * node signs with an unlocked key — which is why this derives from hardhat's default
               * mnemonic rather than inventing an address. Exhaustion fails loudly with the reason
               * rather than looking like a product bug.
               */
              case 'freshRedeemer': {
                const manager = new ethers.Contract(d.contracts.membershipManager, MANAGER_ABI, provider)
                let buyer = null
                for (let i = args.startIndex ?? 3; i < (args.endIndex ?? 20); i += 1) {
                  const w = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`)
                  if (Number(await manager.getActiveTier(w.address, WAGER_PARTICIPANT_ROLE)) === 0) {
                    buyer = { index: i, wallet: w.connect(provider) }
                    break
                  }
                }
                if (!buyer) {
                  return {
                    ok: false,
                    error:
                      'every hardhat account already holds an active WAGER_PARTICIPANT membership — ' +
                      'this node has been re-used past what the voucher flow can arrange. Restart it ' +
                      'and re-run `npm run setup:e2e`.',
                  }
                }
                return { ok: true, index: buyer.index, address: buyer.wallet.address }
              }
              case 'mintVoucher': {
                // The recipient mints for themselves, paying the tier price, exactly as the
                // Vouchers page's Buy section does.
                const buyer = new ethers.NonceManager(
                  args.address
                    ? ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${args.index}`).connect(provider)
                    : new ethers.Wallet(ACCOUNT_KEYS[args.index ?? 1], provider),
                )
                const buyerAddress = await buyer.getAddress()
                if (args.address && buyerAddress.toLowerCase() !== String(args.address).toLowerCase()) {
                  return { ok: false, error: `derived ${buyerAddress} for index ${args.index}, expected ${args.address}` }
                }
                const manager = new ethers.Contract(d.contracts.membershipManager, MANAGER_ABI, provider)
                const tier = args.tier ?? 1 // Bronze
                const cfg = await manager.getTierConfig(WAGER_PARTICIPANT_ROLE, tier)
                if (!cfg.active) return { ok: false, error: `tier ${tier} is not active for WAGER_PARTICIPANT_ROLE` }

                // Native gas needs no arranging: hardhat funds all 20 derived accounts at boot.
                const token = new ethers.Contract(d.paymentToken, TOKEN, admin)
                await (await token.mint(buyerAddress, cfg.priceUSDC * 4n)).wait(1)
                await (await new ethers.Contract(d.paymentToken, TOKEN, buyer).approve(voucherAddress, cfg.priceUSDC * 4n)).wait(1)

                const voucher = new ethers.Contract(voucherAddress, VOUCHER_ABI, buyer)
                const rc = await (await voucher.mint(WAGER_PARTICIPANT_ROLE, tier)).wait(1)
                // The id is read back rather than parsed out of a log: `balanceOf` + `ownerOf` is
                // what the app itself lists from, so the fixture and the surface agree by
                // construction.
                const held = await ownedVouchers(new ethers.Contract(voucherAddress, VOUCHER_ABI, provider), buyerAddress)
                return { ok: rc.status === 1, address: buyerAddress, tier, held, priceUSDC: cfg.priceUSDC.toString() }
              }
              /*
               * USDC for a UI voucher purchase — and only the balance. The Buy section sends
               * its own `approve` before the mint (useVouchers' EOA rail), so approving here
               * would leave that half of the flow untested.
               */
              case 'fundBuyer': {
                const manager = new ethers.Contract(d.contracts.membershipManager, MANAGER_ABI, provider)
                const cfg = await manager.getTierConfig(WAGER_PARTICIPANT_ROLE, args.tier ?? 1)
                if (!cfg.active) return { ok: false, error: `tier ${args.tier ?? 1} is not active for WAGER_PARTICIPANT_ROLE` }
                const token = new ethers.Contract(d.paymentToken, TOKEN, admin)
                await (await token.mint(args.address, cfg.priceUSDC * 4n)).wait(1)
                return { ok: true, priceUSDC: cfg.priceUSDC.toString() }
              }
              /*
               * A real purchaseTier by a fresh derived account, so `accruedFees` is non-zero —
               * the treasury-withdrawal flow's precondition. Purchases (not grants, not voucher
               * mints) are what accrue into MembershipManager.accruedFees, so ARRANGING accrued
               * money means buying a membership. Walks for an inactive account the same way
               * freshRedeemer does, from the top of the range so the two never race each other.
               */
              case 'purchaseTier': {
                const managerRead = new ethers.Contract(d.contracts.membershipManager, MANAGER_ABI, provider)
                let buyer = null
                for (let i = args.startIndex ?? 19; i >= (args.endIndex ?? 10); i -= 1) {
                  const w = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`)
                  if (Number(await managerRead.getActiveTier(w.address, WAGER_PARTICIPANT_ROLE)) === 0) {
                    buyer = new ethers.NonceManager(w.connect(provider))
                    break
                  }
                }
                if (!buyer) {
                  return { ok: false, error: 'no derived account without an active membership left in 10..19 — restart the node' }
                }
                const buyerAddress = await buyer.getAddress()
                const tier = args.tier ?? 1
                const cfg = await managerRead.getTierConfig(WAGER_PARTICIPANT_ROLE, tier)
                if (!cfg.active) return { ok: false, error: `tier ${tier} is not active for WAGER_PARTICIPANT_ROLE` }
                const token = new ethers.Contract(d.paymentToken, TOKEN, admin)
                await (await token.mint(buyerAddress, cfg.priceUSDC * 2n)).wait(1)
                await (await new ethers.Contract(d.paymentToken, TOKEN, buyer).approve(d.contracts.membershipManager, cfg.priceUSDC * 2n)).wait(1)
                const rc = await (await new ethers.Contract(d.contracts.membershipManager, MANAGER_ABI, buyer).purchaseTier(WAGER_PARTICIPANT_ROLE, tier)).wait(1)
                return { ok: rc.status === 1, address: buyerAddress, priceUSDC: cfg.priceUSDC.toString() }
              }
              case 'vouchersOf': {
                const v = new ethers.Contract(voucherAddress, VOUCHER_ABI, provider)
                return { ok: true, held: await ownedVouchers(v, args.address) }
              }
              case 'membership': {
                const manager = new ethers.Contract(d.contracts.membershipManager, MANAGER_ABI, provider)
                const m = await manager.getMembership(args.address, WAGER_PARTICIPANT_ROLE)
                return {
                  ok: true,
                  tier: Number(await manager.getActiveTier(args.address, WAGER_PARTICIPANT_ROLE)),
                  storedTier: Number(m.tier),
                  expiresAt: Number(m.expiresAt),
                }
              }
              case 'swapRate': {
                const rates = d.mocks?.mockUniswapRates
                if (!rates) return { ok: false, error: 'no mocks.mockUniswapRates — run `npm run setup:e2e`' }
                const c = new ethers.Contract(rates, ['function rate(address,address) view returns (uint256)'], provider)
                return {
                  ok: true,
                  rates,
                  usdc: d.paymentToken,
                  wmatic: d.wmatic,
                  usdcToWmatic: (await c.rate(d.paymentToken, d.wmatic)).toString(),
                  wmaticToUsdc: (await c.rate(d.wmatic, d.paymentToken)).toString(),
                }
              }
              default:
                throw new Error(`voucherFixture: unknown action '${action}'`)
            }
          } catch (e) {
            return { ok: false, error: e.shortMessage || e.reason || e.message }
          }
        },


        /**
         * Fixtures for callsign registration (spec 054), on-chain tier.
         *
         * Registration is Gold-gated and permanent until released, and one account may hold at
         * most one callsign — so a fixed account makes the flow pass exactly once against any node
         * (`AlreadyHasCallsign` from then on). `freshOwner` therefore CHOOSES an account the way
         * the voucher flow chooses a redeemer: walk hardhat's own unlocked accounts, take the first
         * that owes nothing to an earlier run, and fail loudly rather than mysteriously when they
         * are exhausted. The browser can act as any of them because `eth_sendTransaction` is signed
         * by the node.
         *
         * `grantGold` arranges an authorization the member genuinely needs — the tier gate is not
         * bypassed, it is satisfied.
         *
         * action ∈ freshOwner | grantGold | callsignOf | registryState
         */
        async callsignFixture({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const admin = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))
          const d = loadLocalDeployment()

          const registryAddress = d.contracts?.callsignRegistry
          if (!registryAddress) {
            return {
              ok: false,
              error:
                'the local deployment record has no contracts.callsignRegistry — run `npm run setup:e2e` ' +
                '(whose `deploy:local:callsigns` step deploys it) before the callsign spec',
            }
          }
          // Compiled ABIs, for the reason spelled out on voucherFixture: a hand-written tuple that
          // decodes to garbage does not throw, it lies.
          const REGISTRY_ABI = loadArtifact('naming/CallsignRegistry.sol', 'CallsignRegistry').abi
          const MEMBERSHIP_ABI = ['function grantMembership(address user, bytes32 role, uint8 tier, uint32 durationDays)']
          const WAGER_PARTICIPANT_ROLE = ethers.id('WAGER_PARTICIPANT_ROLE')
          const registry = new ethers.Contract(registryAddress, REGISTRY_ABI, provider)

          try {
            switch (action) {
              case 'freshOwner': {
                for (let i = args.startIndex ?? 5; i < (args.endIndex ?? 20); i += 1) {
                  const w = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`)
                  if (!(await registry.callsignOf(w.address))) {
                    return { ok: true, index: i, address: w.address }
                  }
                }
                return {
                  ok: false,
                  error:
                    'every hardhat account already holds a callsign — this node has been re-used past ' +
                    'what the registration flow can arrange. Restart it and re-run `npm run setup:e2e`.',
                }
              }
              case 'grantGold': {
                // Gold is tier 3 (None 0, Bronze 1, Silver 2, Gold 3, Platinum 4) and is the
                // registry's own floor, hard-configured — see `minTier` in CallsignRegistry.
                const membership = new ethers.Contract(d.contracts.membershipManager, MEMBERSHIP_ABI, admin)
                await (await membership.grantMembership(args.address, WAGER_PARTICIPANT_ROLE, 3, 365)).wait(1)
                return { ok: true }
              }
              case 'callsignOf':
                return { ok: true, callsign: await registry.callsignOf(args.address) }
              case 'registryState': {
                const info = await registry.resolve(args.callsign)
                return {
                  ok: true,
                  owner: info.owner,
                  callsign: info.callsign,
                  status: Number(info.status),
                  available: await registry.isAvailable(args.callsign),
                }
              }
              default:
                throw new Error(`callsignFixture: unknown action '${action}'`)
            }
          } catch (e) {
            return { ok: false, error: e.shortMessage || e.reason || e.message }
          }
        },

        /**
         * Fixtures for Earn ▸ Stake (specs 065 + 066).
         *
         * The delegated path never touches a FairWins contract — it is a direct member call to
         * Polygon's ValidatorShare — so everything this task does is either ARRANGING the world
         * (minting POL, advancing a checkpoint epoch, curating the allowlist) or READING BACK
         * what the chain says happened. It never performs a member action: that is the flow's job.
         *
         * action ∈ mintPol | polBalance | delegation | advanceEpoch | routerState | setPaused |
         *          setValidator
         */
        async stakingFixture({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const admin = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))
          const d = loadLocalDeployment()

          // Signatures copied from the contracts, never written from memory.
          const POL_ABI = [
            'function mint(address to, uint256 amount)',
            'function balanceOf(address) view returns (uint256)',
          ]
          const VALIDATOR_ABI = [
            'function getTotalStake(address user) view returns (uint256, uint256)',
            'function unbondNonces(address user) view returns (uint256)',
            'function unbonds_new(address user, uint256 unbondNonce) view returns (uint256 shares, uint256 withdrawEpoch)',
            'function setRewards(address account, uint256 amount)',
          ]
          const STAKE_MANAGER_ABI = [
            'function epoch() view returns (uint256)',
            'function withdrawalDelay() view returns (uint256)',
            'function advanceEpoch(uint256 by)',
          ]
          const ROUTER_ABI = [
            'function paused() view returns (bool)',
            'function pause()',
            'function unpause()',
            'function addValidator(address validatorShare)',
            'function removeValidator(address validatorShare)',
            'function isValidator(address validatorShare) view returns (bool)',
            'function validatorCount() view returns (uint256)',
          ]

          const polToken = d.mocks?.mockPolToken
          const validatorShare = d.mocks?.mockValidatorShare
          const stakeManager = d.mocks?.mockPolygonStakeManager
          const stakingRouter = d.contracts?.stakingRouter
          if (!polToken || !validatorShare || !stakeManager || !stakingRouter) {
            return {
              ok: false,
              error:
                'the local deployment record has no staking fixtures — run `npm run setup:e2e` ' +
                '(which now includes `deploy:local:staking`) before the Earn ▸ Stake specs',
            }
          }

          try {
            switch (action) {
              case 'mintPol': {
                const pol = new ethers.Contract(polToken, POL_ABI, admin)
                const rc = await (await pol.mint(args.address, BigInt(args.amount))).wait(1)
                return { ok: rc.status === 1, balance: (await pol.balanceOf(args.address)).toString() }
              }
              case 'polBalance': {
                const pol = new ethers.Contract(polToken, POL_ABI, provider)
                return { ok: true, balance: (await pol.balanceOf(args.address)).toString() }
              }
              case 'delegation': {
                const vs = new ethers.Contract(validatorShare, VALIDATOR_ABI, provider)
                const sm = new ethers.Contract(stakeManager, STAKE_MANAGER_ABI, provider)
                const [stake, nonce, epoch, delay] = await Promise.all([
                  vs.getTotalStake(args.address),
                  vs.unbondNonces(args.address),
                  sm.epoch(),
                  sm.withdrawalDelay(),
                ])
                const unbond =
                  nonce > 0n ? await vs.unbonds_new(args.address, nonce) : { shares: 0n, withdrawEpoch: 0n }
                return {
                  ok: true,
                  staked: stake[0].toString(),
                  unbondNonce: Number(nonce),
                  unbondShares: (unbond.shares ?? unbond[0]).toString(),
                  withdrawEpoch: Number(unbond.withdrawEpoch ?? unbond[1]),
                  epoch: Number(epoch),
                  withdrawalDelay: Number(delay),
                }
              }
              case 'advanceEpoch': {
                const sm = new ethers.Contract(stakeManager, STAKE_MANAGER_ABI, admin)
                const rc = await (await sm.advanceEpoch(BigInt(args.by ?? 1))).wait(1)
                return { ok: rc.status === 1, epoch: Number(await sm.epoch()) }
              }
              case 'routerState': {
                const router = new ethers.Contract(stakingRouter, ROUTER_ABI, provider)
                const [paused, listed, count] = await Promise.all([
                  router.paused(),
                  router.isValidator(validatorShare),
                  router.validatorCount(),
                ])
                return {
                  ok: true,
                  paused,
                  validatorListed: listed,
                  validatorCount: Number(count),
                  validatorShare,
                  stakingRouter,
                }
              }
              case 'setPaused': {
                // IDEMPOTENT: Pausable reverts when the flag is already where you are asking it
                // to go, so a spec establishing a known starting state would fail on the state
                // it wanted.
                const router = new ethers.Contract(stakingRouter, ROUTER_ABI, admin)
                const want = Boolean(args.paused)
                if ((await router.paused()) === want) return { ok: true, paused: want, changed: false }
                const rc = await (await (want ? router.pause() : router.unpause())).wait(1)
                return { ok: rc.status === 1, paused: want, changed: true }
              }
              case 'setValidator': {
                // Also idempotent, for the same reason (`AlreadyListed` / `NotListed`).
                const router = new ethers.Contract(stakingRouter, ROUTER_ABI, admin)
                const want = args.listed !== false
                if ((await router.isValidator(validatorShare)) === want) {
                  return { ok: true, listed: want, changed: false }
                }
                const rc = await (
                  await (want ? router.addValidator(validatorShare) : router.removeValidator(validatorShare))
                ).wait(1)
                return { ok: rc.status === 1, listed: want, changed: true }
              }
              default:
                throw new Error(`stakingFixture: unknown action '${action}'`)
            }
          } catch (e) {
            return { ok: false, error: e.shortMessage || e.reason || e.message }
          }
        },

        /**
         * Fixtures for Protect (specs 043 / 049 / 068).
         *
         * A Safe is a real contract, and every test here needs one that already exists — so the
         * vault is created on chain by this task and brought into the app through its own "Load
         * existing" path. Only `custody.create-vault` drives the wizard, because only that test is
         * about creating one.
         *
         * The canonical Safe v1.4.1 addresses are the same ones the app resolves
         * (frontend/src/config/safeContracts.js); `scripts/e2e/setup-custody-fixtures.js` is what
         * puts code behind them on this chain, and this task fails loudly if that has not run.
         *
         * action ∈ createVault | fundVault | vaultInfo | nativeBalance
         */
        async custodyFixture({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const funder = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))

          const SAFE = {
            singletonL2: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
            proxyFactory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
            fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99',
          }
          const SAFE_ABI = [
            'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
            'function getOwners() view returns (address[])',
            'function getThreshold() view returns (uint256)',
            'function nonce() view returns (uint256)',
            'function VERSION() view returns (string)',
            'function getStorageAt(uint256 offset, uint256 length) view returns (bytes)',
          ]
          const FACTORY_ABI = [
            'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
            'event ProxyCreation(address indexed proxy, address singleton)',
          ]
          // Safe keeps its guard in a fixed storage slot (keccak256("guard_manager.guard.address")).
          const GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'

          try {
            switch (action) {
              case 'createVault': {
                if ((await provider.getCode(SAFE.proxyFactory)) === '0x') {
                  throw new Error(
                    'no Safe proxy factory on this chain — run `npm run setup:e2e:custody` ' +
                    '(scripts/e2e/setup-custody-fixtures.js) before the custody specs',
                  )
                }
                const safeIface = new ethers.Interface(SAFE_ABI)
                const initializer = safeIface.encodeFunctionData('setup', [
                  args.owners, args.threshold, ethers.ZeroAddress, '0x',
                  SAFE.fallbackHandler, ethers.ZeroAddress, 0, ethers.ZeroAddress,
                ])
                const factory = new ethers.Contract(SAFE.proxyFactory, FACTORY_ABI, funder)
                // A distinct salt per call so repeated runs never collide on an existing proxy.
                const saltNonce = BigInt(args.saltNonce ?? Date.now())
                const rc = await (await factory.createProxyWithNonce(
                  SAFE.singletonL2, initializer, saltNonce,
                )).wait(1)
                const created = rc.logs
                  .map((l) => { try { return factory.interface.parseLog(l) } catch { return null } })
                  .find((parsed) => parsed && parsed.name === 'ProxyCreation')
                if (!created) throw new Error('no ProxyCreation event — the vault was not deployed')
                return { ok: true, address: created.args[0] }
              }
              case 'createV1PolicyVault': {
                /*
                 * A vault governed by the SPEC-049 guard, created the way a v1 vault was: the
                 * Safe's own `setup` delegatecalls PolicyGuardSetup.enablePolicy, attaching the
                 * guard and its rules atomically at creation.
                 *
                 * This is a fixture rather than a UI journey because the UI cannot produce one
                 * here: on a chain where the ordered engine is deployed, the wizard attaches V2.
                 * v1 vaults exist because migration is vault-CONSENTED and never happens at
                 * release time — so a v1 vault to test against has to be made, not adopted.
                 */
                const V1_GUARD = '0xBE509C8E6c4F132e2Af49761A318FfA362e9CE38'
                const SETUP = '0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b'
                // Signatures copied verbatim from frontend/src/abis/SafePolicyGuard.js. The limit
                // fields are uint128, not uint256 — a plausible-looking guess selects a different
                // function and the Safe's setup delegatecall reverts with no data to explain it.
                const guardIface = new ethers.Interface([
                  'function configureRules((address asset, uint128 perTxLimit, uint128 windowLimit)[] limits, uint32 cooldown, bool allowlistEnabled, address[] allowlistAdd, address[] allowlistRemove)',
                ])
                const setupIface = new ethers.Interface([
                  'function enablePolicy(address guard, bytes configureCalldata)',
                ])
                const configure = guardIface.encodeFunctionData('configureRules', [
                  [{ asset: ethers.ZeroAddress, perTxLimit: BigInt(args.perTxLimit), windowLimit: 0n }],
                  0, false, [], [],
                ])
                const safeIface = new ethers.Interface(SAFE_ABI)
                const initializer = safeIface.encodeFunctionData('setup', [
                  args.owners, args.threshold,
                  SETUP, setupIface.encodeFunctionData('enablePolicy', [V1_GUARD, configure]),
                  SAFE.fallbackHandler, ethers.ZeroAddress, 0, ethers.ZeroAddress,
                ])
                const factory = new ethers.Contract(SAFE.proxyFactory, FACTORY_ABI, funder)
                const rc = await (await factory.createProxyWithNonce(
                  SAFE.singletonL2, initializer, BigInt(args.saltNonce ?? Date.now()),
                )).wait(1)
                const created = rc.logs
                  .map((l) => { try { return factory.interface.parseLog(l) } catch { return null } })
                  .find((parsed) => parsed && parsed.name === 'ProxyCreation')
                if (!created) throw new Error('no ProxyCreation event — the v1 policy vault was not deployed')
                return { ok: true, address: created.args[0], guard: V1_GUARD }
              }
              case 'fundVault': {
                const rc = await (await funder.sendTransaction({
                  to: args.address,
                  value: BigInt(args.amount ?? String(10n ** 18n)),
                })).wait(1)
                return { ok: rc.status === 1 }
              }
              case 'vaultInfo': {
                const safe = new ethers.Contract(args.address, SAFE_ABI, provider)
                const [owners, threshold, nonce, version, guardWord] = await Promise.all([
                  safe.getOwners(), safe.getThreshold(), safe.nonce(), safe.VERSION(),
                  provider.getStorage(args.address, GUARD_SLOT),
                ])
                return {
                  ok: true,
                  owners: owners.map((o) => String(o)),
                  threshold: Number(threshold),
                  nonce: Number(nonce),
                  version,
                  // The guard is the low 20 bytes of that slot; ZeroAddress means "no guard".
                  guard: ethers.getAddress('0x' + guardWord.slice(-40)),
                }
              }
              case 'nativeBalance':
                return { ok: true, balance: (await provider.getBalance(args.address)).toString() }
              case 'mintToken': {
                // Fund a vault with the LOCAL stable (the deployment's paymentToken — the same
                // address the app's 80002 seam resolves), so a spec can drive the spec-105
                // everyday/big-send lanes, which are realized in the chain's stable token.
                const d = loadLocalDeployment()
                const token = new ethers.Contract(args.token || d.paymentToken, TOKEN_ABI, funder)
                const rc = await (await token.mint(args.address, BigInt(args.amount))).wait(1)
                return { ok: rc.status === 1, token: await token.getAddress() }
              }
              case 'tokenBalance': {
                const d = loadLocalDeployment()
                const token = new ethers.Contract(args.token || d.paymentToken, TOKEN_ABI, provider)
                return { ok: true, balance: (await token.balanceOf(args.address)).toString() }
              }
              case 'policyRules': {
                /*
                 * Read the ordered rules the GUARD holds for this vault — the on-chain truth the
                 * spec-105 realization (`vaultRulesConfig.realizeRules`) must match. Tuple shape
                 * copied from frontend/src/abis/SafePolicyGuardV2.js (field order is load-bearing).
                 */
                const guard = new ethers.Contract(
                  args.guard,
                  ['function getRules(address safe) view returns ((address asset, uint128 perTxLimit, uint128 windowLimit, uint8 approvalsRequired, bool banded, address[] approvers, address[] targets)[] rules, uint32 cooldown)'],
                  provider,
                )
                const [rules, cooldown] = await guard.getRules(args.address)
                return {
                  ok: true,
                  cooldown: Number(cooldown),
                  rules: rules.map((r) => ({
                    asset: String(r.asset),
                    perTxLimit: r.perTxLimit.toString(),
                    windowLimit: r.windowLimit.toString(),
                    approvalsRequired: Number(r.approvalsRequired),
                    banded: Boolean(r.banded),
                    approvers: r.approvers.map((a) => String(a)),
                    targets: r.targets.map((t) => String(t)),
                  })),
                }
              }
              case 'proposalCount': {
                // Count what the HUB actually recorded for this vault. A queue that renders
                // nothing is either a vault with no proposals or a discovery problem, and only
                // the chain can tell the two apart.
                const hub = new ethers.Contract(
                  args.hub,
                  // Signature copied from frontend/src/abis/SafeProposalHub.js — a hand-guessed
                  // one hashes to a different topic0 and silently matches nothing, which reads
                  // exactly like "the app proposed nothing".
                  ['event Proposed(address indexed safe, address indexed proposer, bytes32 indexed safeTxHash, address to, uint256 value, bytes data, uint8 operation, uint256 nonce)'],
                  provider,
                )
                const logs = await provider.getLogs({
                  address: args.hub,
                  topics: [
                    hub.interface.getEvent('Proposed').topicHash,
                    ethers.zeroPadValue(ethers.getAddress(args.address), 32),
                  ],
                  fromBlock: 0,
                  toBlock: 'latest',
                })
                return { ok: true, count: logs.length }
              }
              default:
                throw new Error(`custodyFixture: unknown action '${action}'`)
            }
          } catch (e) {
            return { ok: false, error: e.shortMessage || e.reason || e.message }
          }
        },

        async legacyFixture({ action, args = {} }) {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          /*
           * NonceManager, not a bare Wallet: several fixture actions send two transactions in a
           * row (deploy then arm), and ethers caches the nonce lookup for a moment — on a local
           * chain the second send reuses the first's nonce and is rejected. The fixture's sends
           * must all land, so tracking the nonce locally is exactly right here.
           */
          const funder = new ethers.NonceManager(new ethers.Wallet(config.env.PRIVATE_KEY, provider))
          const d = loadLocalDeployment()
          /*
           * WHICH token the sweep sees is decided by the APP, not by this record — the portfolio
           * registry scans what `config/wrappedNative.js` and the network's stablecoin config
           * resolve. So the caller passes the address the app will actually read, and the spec
           * asserts that address against this record: the two agreeing is a fact worth checking,
           * not one to assume (the frontend's constants are only refreshed by
           * `npm run sync:frontend-contracts`, which the E2E job does not run).
           */
          const tokenAddress = args.token || d.wmatic
          const token = new ethers.Contract(tokenAddress, TOKEN_ABI, funder)

          try {
            switch (action) {
              case 'newAccount': {
                const wallet = ethers.Wallet.createRandom()
                return { ok: true, address: wallet.address, privateKey: wallet.privateKey, tokenAddress }
              }
              case 'makeTokenRefuse': {
                /*
                 * Make ONE transfer of an existing token fail, without touching its balances.
                 *
                 * Deploy ReentrantToken, copy its RUNTIME code over the token's, and arm it to
                 * re-enter the token itself with an unknown selector — the token has no fallback,
                 * so that call reverts and the transfer reverts with it. Only the code changes:
                 * ERC-20 storage lives in the same slots, so who holds what is unchanged.
                 *
                 * This is the only way to fail one asset and not the others: `sweepAllAssets`
                 * re-reads balances itself, so emptying a token just drops it from the run.
                 *
                 * The original runtime code is captured here and put back by `restoreTokenCode`,
                 * which the spec calls in an `after` hook. The chain checkpoint is NOT enough on
                 * its own: it only rewinds within one `cypress run` process, so a node reused for
                 * a second run starts it with a wrapped coin that refuses every transfer — and the
                 * spec then fails in LKR-S1, which arms nothing and is innocent. (Reproduced: a
                 * shard rerun against a node left over from a single-spec run.)
                 */
                const artifactPath = resolve(
                  __dirname, '..', 'artifacts', 'contracts', 'mocks', 'ReentrantToken.sol', 'ReentrantToken.json',
                )
                const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
                const deployed = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, funder).deploy()
                await deployed.waitForDeployment()
                // Capture BEFORE overwriting, and only the first time: a second arm of the same
                // token must not record the reentrant code as if it were the original.
                if (!originalTokenCode.has(tokenAddress.toLowerCase())) {
                  originalTokenCode.set(tokenAddress.toLowerCase(), await provider.getCode(tokenAddress))
                }
                await provider.send('hardhat_setCode', [
                  tokenAddress,
                  await provider.getCode(await deployed.getAddress()),
                ])
                const rc = await (await new ethers.Contract(tokenAddress, ARMED_TOKEN_ABI, funder)
                  .arm(tokenAddress, '0xdeadbeef')).wait(1)
                return { ok: rc.status === 1, address: tokenAddress }
              }
              case 'restoreTokenCode': {
                // Idempotent: a spec that never armed the token still calls this in `after`.
                const saved = originalTokenCode.get(tokenAddress.toLowerCase())
                if (!saved) return { ok: true, restored: false }
                await provider.send('hardhat_setCode', [tokenAddress, saved])
                originalTokenCode.delete(tokenAddress.toLowerCase())
                return { ok: true, restored: true }
              }
              case 'fundNative': {
                const tx = await funder.sendTransaction({
                  to: args.address,
                  value: BigInt(args.amount ?? String(10n ** 18n)),
                })
                const rc = await tx.wait(1)
                return { ok: rc.status === 1 }
              }
              case 'mintToken': {
                const rc = await (await token.mint(args.address, BigInt(args.amount ?? String(10n ** 18n)))).wait(1)
                return { ok: rc.status === 1 }
              }
              case 'deploymentAddresses':
                return { ok: true, paymentToken: d.paymentToken, wmatic: d.wmatic }
              case 'balances': {
                // `tokens` is an ORDERED list so the caller can index it the same way it named it.
                const tokens = args.tokens || [tokenAddress]
                const native = await provider.getBalance(args.address)
                const reads = await Promise.all(
                  tokens.map((t) =>
                    new ethers.Contract(t, TOKEN_ABI, provider).balanceOf(args.address),
                  ),
                )
                return { ok: true, native: native.toString(), tokens: reads.map((b) => b.toString()) }
              }
              default:
                throw new Error(`legacyFixture: unknown action '${action}'`)
            }
          } catch (e) {
            return { ok: false, error: e.shortMessage || e.reason || e.message }
          }
        },

        /**
         * The chain's current timestamp, in ms. The app decides every expiry in BROWSER time
         * while the registry enforces in CHAIN time, so a deadline test is only meaningful
         * when the two agree — see cy.syncBrowserClockToChain.
         */
        async chainNow() {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const provider = new ethers.JsonRpcProvider(rpcUrl, E2E_CHAIN_ID, { staticNetwork: true })
          const block = await provider.getBlock('latest')
          return { ok: true, nowMs: Number(block.timestamp) * 1000 }
        },

        /** Read the latest wager id (nextWagerId - 1) for status/winner assertions. */
        async lastWagerId() {
          const provider = new ethers.JsonRpcProvider(config.env.RPC_URL, E2E_CHAIN_ID, { staticNetwork: true })
          const d = loadLocalDeployment()
          const registry = new ethers.Contract(d.contracts.wagerRegistry, REGISTRY_ABI, provider)
          const next = await registry.nextWagerId()
          return Number(next) - 1
        },

        /**
         * Revert the chain to the last checkpoint (post-seed state) and take a fresh one.
         * Called from the support file's `before` at the start of every FULL-tier spec.
         * Restores the clock AND the state: keys registered or wagers created by a previous
         * spec are rolled back too, which is why each spec's own `before` hook re-establishes
         * its preconditions (ensureEncryptionKeys already checks hasKey and re-registers).
         */
        async chainCheckpoint() {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const chainId = Number(config.env.NETWORK_ID) || 1337
          const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true })
          let reverted = false
          if (chainSnapshotId !== null) {
            reverted = await provider.send('evm_revert', [chainSnapshotId])
            if (!reverted) {
              // FAIL FAST. A false return means the snapshot id was invalid or already
              // consumed — the next spec would run on a dirty clock/state and this task
              // would then re-snapshot the contamination as if it were the baseline.
              // A loud death here is a broken harness; a quiet one is a wrong measurement.
              throw new Error(
                `chainCheckpoint: evm_revert(${chainSnapshotId}) returned false — ` +
                'refusing to re-snapshot a dirty chain. Restart the node and re-seed.'
              )
            }
          }
          chainSnapshotId = await provider.send('evm_snapshot', [])
          return { reverted, snapshotId: chainSnapshotId }
        },

        /*
         * Move the restore point FORWARD without reverting: drop the held snapshot id and take
         * a new one at the current state. A spec whose before-hook writes durable fixtures
         * (encryption keys, membership) calls this after that hook, so per-test reverts land
         * AFTER the fixtures rather than wiping them — reverting to the spec-start snapshot
         * would undo the very setup the tests depend on.
         */
        async chainRebase() {
          const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
          const chainId = Number(config.env.NETWORK_ID) || 1337
          const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true })
          chainSnapshotId = await provider.send('evm_snapshot', [])
          return { snapshotId: chainSnapshotId }
        },
        /*
         * ClearPath native standard DAOs (spec 030 pillar A). `clearpathDao` reads the local
         * chain for full/42-clearpath-native-dao.cy.js; `clearpathRegistryWorld` ABI-encodes a
         * registry record for the no-chain fast/46-clearpath-unavailable.cy.js and touches no
         * chain. See frontend/cypress/support/tasks/clearpath.js.
         */
        ...clearpathTasks(config),
        ...sigilTasks(config),
      })

      /*
       * Keep video only for specs that actually failed. A video of a passing spec is
       * never watched, and the artifact upload only runs `if: failure()` anyway — so on
       * a mixed run this drops every passing spec's recording before it is ever bundled.
       * Deleting here rather than in the workflow means the bytes never leave the runner.
       */
      on('after:spec', (spec, results) => {
        if (!results?.video) return
        const failed = (results.tests ?? []).some((test) =>
          (test.attempts ?? []).some((attempt) => attempt.state === 'failed')
        )
        if (failed) return
        try {
          unlinkSync(results.video)
        } catch {
          // Already gone (or never written) — nothing to reclaim, and this must not
          // fail the run: video cleanup is housekeeping, not a gate.
        }
      })

      return config
    },
  },

  component: {
    devServer: {
      framework: 'react',
      bundler: 'vite',
    },
  },
})
