# 07 — Annex: On-Chain Estate

> The contract layer: every live contract, its upgradeability, the chains it is
> deployed on, the roles that govern it, and the external protocol contracts the
> platform calls but does not own. This is the other half of
> [02](02-architecture-view.md).

## Deployment reality differs sharply from code completeness

The single most useful thing to know before reading the tables: **the estate is
not uniform across chains, and the code compiling is not evidence of deployment.**

| Chain | What is actually there |
|---|---|
| **137 Polygon** | The whole estate |
| **63 Mordor** | Nearly all of it, minus oracle adapters and callsigns |
| **80002 Amoy** | The wager/membership core only |
| **61 ETC** | Custody + account stack only — **no FeeRouter** |
| **1 / 10 / 8453 / 42161** | Routers + FeeRouter + account stack only |
| **Sepolia, Hoodi** | Present in `NETWORKS` with **zero contracts** |

Complete-but-undeployed: `FundingPoolFactory`/`FundingPool` exist nowhere on
chain, and `StakingRouter` is undeployed even though its two fee services are
already registered on the FeeRouter. `CallsignRegistry` is Polygon-only.
`StandardDAOFactory` can *never* ship on Mordor — pre-Cancun EVM, and OZ
`Governor` emits `MCOPY`.

## Two traps for anyone reading addresses

**Nonce-derived address reuse across chains.** Ethereum's `liquidityRouter` proxy
is byte-identical to the **BridgeRouter** proxy on chains 10, 8453 and 42161.
A label is only valid together with its chain id; carrying one across a chain
boundary produces a confident wrong answer. Base's Uniswap and Chainalysis
addresses also genuinely differ from the other four mainnets.

**The `wagerRegistryIntents` facet is recorded on 137 and 63 but not on Amoy
80002** — so the testnet membership chain has no gasless twin facet. Self-submit
is unaffected, which is exactly why this could go unnoticed.

## Authority: what is settled and what is not

The historical deployer `0x52502d04…F6e1` is **the compromised key**. Ten recorded
Mordor contracts were migrated to the current 2-of-3 admin Safe
`0xcf76db7a…0447`; roughly 60 sole-held roles and 62 `Ownable` owners across 23
unrecorded contracts were **deliberately written off** rather than migrated. Two
live gaps remain open:

- `DEFAULT_ADMIN_ROLE` on the Bridge and Liquidity routers is still a **single hot
  key** (issue #966) — treat those routers accordingly.
- The recorded `treasury` on chains 1, 10, 8453 and 42161 is still the
  **superseded** Safe `0x8cc564E3…c3fa`.


Evidence-based inventory of the smart-contract layer and its chain topology.
Repo root: `/home/user/prediction-dao-research`. Read-only pass; nothing modified.

**Rules observed while writing this:** no address appears here that is not quoted from a
repo file, and every row cites `path:line`. `deployments/**` is the source of truth for
addresses (per `CLAUDE.md` repository map); `frontend/src/config/contracts.js` is the
*client* copy, synced by `npm run sync:frontend-contracts`, and the two diverge in places
that are flagged below.

---

## 0. Executive shape

| Layer | What it is | Where |
|---|---|---|
| Escrow / wagers | `WagerRegistry` UUPS proxy + `WagerRegistryIntents` delegatecall facet over one `WagerRegistryCore` layout | `contracts/wagers/` |
| Access / identity | `MembershipManager` (UUPS), `MembershipVoucher` (immutable ERC-721), `VoucherBatchMinter` (immutable), `SanctionsGuard` (immutable singleton), `CallsignRegistry` (UUPS) | `contracts/access/`, `contracts/naming/` |
| Group escrow | `WagerPoolFactory` (UUPS) → `WagerPool` ERC-1167 clones; `FundingPoolFactory` (UUPS) → `FundingPool` clones | `contracts/pools/` |
| Fees | `FeeRouter` (UUPS) — single on-chain fee source of truth | `contracts/fees/` |
| DeFi routers | `BridgeRouter`, `LiquidityRouter`, `StakingRouter` (all UUPS, transient custody only) | `contracts/bridge/`, `contracts/liquidity/`, `contracts/staking/` |
| Apps catalog | `MiniAppRegistry` (UUPS) | `contracts/apps/` |
| Accounts (4337) | `CoinbaseSmartWallet` + `CoinbaseSmartWalletFactory` (vendored) + `FairWinsVerifyingPaymaster` | `contracts/account/` |
| Custody (Safe) | `SafePolicyGuard` (v1), `SafePolicyGuardV2`, `PolicyGuardSetup`, `SafeProposalHub` — all **non-upgradeable singletons** | `contracts/custody/` |
| Oracles | Polymarket / Chainlink data-feed / Chainlink Functions / UMA OOv3 adapters (all `Ownable`, immutable) | `contracts/oracles/` |
| Tokens / DAO | `TokenFactory` (UUPS) + clone templates, `ExternalDAORegistry` (UUPS), `StandardDAOFactory` (UUPS) | `contracts/tokens/`, `contracts/clearpath/` |
| Privacy / misc | `KeyRegistry`, `BackupPointerRegistry` (tiny immutable registries) | `contracts/privacy/` |
| Reference-only | `contracts-archive/` — v1 estate incl. `FriendGroupMarketFactory`; never import or deploy | `contracts-archive/markets/FriendGroupMarketFactory.sol` |

`contracts/mocks/**` and `contracts/test/**` are test-only (fuzz harnesses, mock USDC, mock
Safe, mock Uniswap, `MockERC4626Vault`, etc.) and are excluded from the live inventory.

---

## 1. Contract inventory

Columns: **Upgradeability** | **deployments key(s)** | **Chains** | **Roles** | **Holds/escrows** | **Facet/pair** | **Evidence**

### 1.1 Wagers (specs 025 / 035 / 036)

| Contract | Purpose | Upgradeability | deployments key(s) | Chains deployed | Key roles | Holds / escrows | Facet / pair | Evidence |
|---|---|---|---|---|---|---|---|---|
| **WagerRegistry** | P2P wager escrow: named creator/opponent, ERC-20 stake, resolution `Either/Creator/Opponent/ThirdParty/Polymarket/+oracle` | **UUPS proxy** at a stable address (`UUPSManaged`) | `wagerRegistry` / `wagerRegistryImpl` | 137, 63, 80002 | `DEFAULT_ADMIN_ROLE` (config: membership mgr, adapter, token allowlist), `GUARDIAN_ROLE` (pause), `ACCOUNT_MODERATOR_ROLE` (freeze accounts), `UPGRADER_ROLE` (impl **and** the intents facet) | **Yes** — escrows both parties' ERC-20 stakes; `safeTransferFrom(from, address(this), amount)` | Main facet; delegatecalls unknown selectors to `WagerRegistryIntents` | `contracts/wagers/WagerRegistry.sol:18-35`, roles at `:20-24`; escrow pull `contracts/wagers/WagerRegistryCore.sol:246`; payouts `:548-601`; fallback `contracts/wagers/WagerRegistry.sol:93-110` |
| **WagerRegistryIntents** | The gasless/signer-attributed twin facet (`…WithSig` / `…WithAuthorization`) plus relocated cold paths (`batchExpireOpen`, `autoResolveFrom*`) — exists because the main impl sits against the 24 KB limit | Separate **implementation**, never initialized; reached by delegatecall from the proxy | `wagerRegistryIntents` | **137, 63 only** — **absent on Amoy 80002** | inherits the same roles (shared storage) | executes in the proxy's storage, so the proxy holds the escrow | Pairs with `WagerRegistry`; both inherit `WagerRegistryCore` | `contracts/wagers/WagerRegistryIntents.sol:10-32`; intents typehashes `:34-68`; presence per chain: `deployments/polygon-chain137-v2.json` / `mordor-chain63-v2.json` have `wagerRegistryIntents`, `deployments/amoy-chain80002-v2.json` does not |
| **WagerRegistryCore** | The **single** storage-layout + internal action bodies for the pair. Abstract — never deployed on its own | abstract base (`UUPSManaged`, `ReentrancyGuardUpgradeable`, `PausableUpgradeable`, `EIP712Upgradeable`) | — (no key) | — | declares `WAGER_PARTICIPANT_ROLE`, `GUARDIAN_ROLE`, `ACCOUNT_MODERATOR_ROLE` | — | the shared parent of both facets | `contracts/wagers/WagerRegistryCore.sol:20-45`, storage block `:53-80`; bounds `MAX_ACCEPT_WINDOW = 30 days` / `MAX_RESOLVE_WINDOW = 180 days` `:46-47` |

EIP-712 domain: `"FairWins WagerRegistry"` / `"1"` — `contracts/wagers/WagerRegistry.sol:63`.
Open-challenge accept typehash `OpenAccept(uint256 wagerId,address taker)` —
`contracts/wagers/WagerRegistryCore.sol:52`.

### 1.2 Membership / access (specs 007 / 026 / 027)

| Contract | Purpose | Upgradeability | deployments key(s) | Chains | Key roles | Holds | Pair | Evidence |
|---|---|---|---|---|---|---|---|---|
| **MembershipManager** | Tiered, time-bound memberships per `bytes32` role; USDC-priced; only paid role is `WAGER_PARTICIPANT_ROLE` | **UUPS proxy** (`UUPSManaged` + `SignerIntentBase`) | `membershipManager` / `membershipManagerImpl` | 137, 63, 80002 | `DEFAULT_ADMIN_ROLE` (treasury, tier config, role admin), `ROLE_MANAGER_ROLE` (grant/revoke out-of-band), plus an `authorizedCallers` map for the WagerRegistry hook | Holds `accruedFees` (undrawn USDC) + takes payment to `treasury` | Burns `MembershipVoucher` on redeem | `contracts/access/MembershipManager.sol:13-20`, `ROLE_MANAGER_ROLE` `:26`, state `:43-62` |
| **MembershipVoucher** | Transferable ERC-721 bearer claim on a `(role,tier)` membership; confers nothing while held | **Deliberately immutable** ("a tradable bearer asset's rules must not change after purchase") | `membershipVoucher` | 137, 63, 80002 | `AccessControl`; `membershipManager` is `immutable` and the sole redemption-burner; ERC-2981 royalty ≤ `MAX_ROYALTY_BPS = 500` | Pays USDC straight to treasury at mint — holds no funds at rest | Pairs with `MembershipManager` | `contracts/access/MembershipVoucher.sol:23-37` |
| **VoucherBatchMinter** | "Buy N / gift" helper — batches voucher mints + gift transfer in one tx | **Immutable, no admin, no withdrawal path** | `voucherBatchMinter` | 137, 63, 80002 | none (stateless, custody-free) | Holds nothing at rest; `MAX_QUANTITY = 50` | Pairs with `MembershipVoucher` | `contracts/access/VoucherBatchMinter.sol:23-45` |
| **SanctionsGuard** | Non-bypassable on-chain screening: Chainalysis oracle + operator deny-list; **fail-closed** (configured-but-unreachable oracle ⇒ everyone not-allowed) | **Immutable singleton** (`AccessControl`, constructor-configured) | `sanctionsGuard` | 137, 63, 80002 | `SANCTIONS_ADMIN_ROLE` (deny-list), `DEFAULT_ADMIN_ROLE` (set oracle) — both granted to the air-gapped floppy-keystore admin at deploy | Nothing | consulted read-only by `WagerRegistry`, `MembershipManager`, pool factories, routers, `MiniAppRegistry`, `CallsignRegistry` | `contracts/access/SanctionsGuard.sol:8-36`; `isAllowed` fail-closed `:41-48` |

### 1.3 Group pools

| Contract | Purpose | Upgradeability | deployments key(s) | Chains | Key roles | Holds | Pair | Evidence |
|---|---|---|---|---|---|---|---|---|
| **WagerPoolFactory** (spec 034) | Authority + registry for group wager pools; screens creator, assigns a 4-word BIP-39 tuple, clones pools, network-scoped registry, serves clones' compliance callbacks (`screen`/`requireMembership`) | **UUPS proxy** | `wagerPoolFactory` / `wagerPoolFactoryImpl` / `poolImpl` | 137, 63 | `POOL_PARTICIPANT_ROLE` (membership role it *requires*, not a role it grants); `DEFAULT_ADMIN_ROLE` + `UPGRADER_ROLE` from `UUPSManaged` | No escrow itself — the clones hold it | Clones `WagerPool`; EIP-712 domain `"FairWins WagerPoolFactory"`/`"1"` | `contracts/pools/WagerPoolFactory.sol:22-52`; `POOL_PARTICIPANT_ROLE` `:39`; caps `MAX_MEMBERS_CAP = 1000`, 30 d/180 d `:41-48` |
| **WagerPool** | Immutable per-pool escrow: members `join`/`approve`/`claim` by **public wallet address** (no Semaphore/ZK); resolves by creator-proposed payout matrix keyed by winner address, approved to a fraction-of-joined threshold | **ERC-1167 clone** of an immutable template | `poolImpl` (template) | 137, 63 (clones created on-chain) | none — authority is the roster + factory hooks | **Yes** — escrows USDC buy-ins; only exits are `claim` (Resolved) and `refund`/`cancel` | Cloned by `WagerPoolFactory`; every actor action has a `…WithSig` twin + `joinWithAuthorization` (EIP-3009) baked into the template | `contracts/pools/WagerPool.sol:34-56` |
| **FundingPoolFactory** (spec 103) | Sibling of the wager factory with the wager removed; own 4-word namespace, own registry | **UUPS proxy** | `fundingPoolFactory` / `fundingPoolFactoryImpl` / `fundingPoolImpl` | **NONE — undeployed on every chain** | `POOL_PARTICIPANT_ROLE` (same role as wager pools, so one tier config covers both) | — | Clones `FundingPool`; EIP-712 domain `"FairWins FundingPoolFactory"`/`"1"` | `contracts/pools/FundingPoolFactory.sol:21-52`; key registered in the storage gate `scripts/deploy/check-storage-layout.js:54`; deploy script `scripts/deploy/deploy-funding-pool-factory.js`; empty in `frontend/src/config/contracts.js` (Mordor `fundingPoolFactory: ''` ~L53, Polygon likewise) and **absent from every `deployments/*-v2.json`** |
| **FundingPool** | Variable contributions toward a public `purpose` + `goal`; organizer closes at any time and the pot pays the organizer's own address (no `recipient`, no admin sweep); organizer / strict majority of contributors / settle deadline flip to `Refunding` with pull refunds | **ERC-1167 clone**, immutable | `fundingPoolImpl` | **undeployed** | none | Would escrow contributions; only exits are `close` → organizer and `claimRefund` → exactly `contributed[claimant]` | Cloned by `FundingPoolFactory` | `contracts/pools/FundingPool.sol:34-52` |

### 1.4 Naming, fees, apps

| Contract | Purpose | Upgradeability | deployments key(s) | Chains | Key roles | Holds | Evidence |
|---|---|---|---|---|---|---|---|
| **CallsignRegistry** (spec 054) | Optional `%callsign` naming registry, gated on `getActiveTier(user, WAGER_PARTICIPANT_ROLE) >= Gold`; ENS-style commit→reveal; delayed repoint | **UUPS proxy** (`UUPSManaged` + `SignerIntentBase`) | `callsignRegistry` / `callsignRegistryImpl` | **137 only** (empty on Mordor + Amoy) | `REGISTRY_CURATOR_ROLE`, `MODERATOR_ROLE`, `VERIFIER_ROLE` — least privilege, **none can reassign a callsign** | **No funds** ("holds NO funds") | `contracts/naming/CallsignRegistry.sol:8-31`; domain `"FairWins CallsignRegistry"`/`"1"` per `CLAUDE.md`; Mordor/Amoy `callsignRegistry: ''` in `frontend/src/config/contracts.js` |
| **FeeRouter** (spec 060) | Single on-chain source of truth for configurable platform fees (`bytes32 serviceId` → rate + per-service cap) **and** the atomic wrapper (`depositToVaultWithFee`: fee → treasury + net → ERC-4626 vault in one tx) | **UUPS proxy** | `feeRouter` / `feeRouterImpl` | **1, 10, 137, 8453, 42161, 63** (not 61 ETC, not 80002) | `FEE_ADMIN_ROLE` (change rates within caps), `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE` — all three granted to `admin` in `initialize` | Holds no balance outside a transaction; `treasury == address(0)` ⇒ fees skipped, never lost | `contracts/fees/FeeRouter.sol:12-58`; `MAX_WRAPPED_FEE_BPS = 250` `:37`; `__gap` `:46` |
| **MiniAppRegistry** (spec 073) | Curated catalog of third-party mini-app packages; vendor submits (Pending) → curator approves/suspends/deprecates. `isLaunchable(id)` — never `status` — is the serving decision; `approveApp(id, expectedManifestHash)` is content-committed | **UUPS proxy** | `miniAppRegistry` / `miniAppRegistryImpl` | **137 + 63 only** (deliberately not Amoy) | `APP_CURATOR_ROLE` — **self-administering** (`_setRoleAdmin(APP_CURATOR_ROLE, APP_CURATOR_ROLE)`), the platform's entire supply-chain trust boundary, required non-zero at `initialize`, held by the compliance multisig; `DEFAULT_ADMIN_ROLE` only for gate config; optional vendor tier gate (`membershipManager` + `minTier`, `address(0)` ⇒ gate off) | **Fund-free** — "never holds, moves, or approves value" | `contracts/apps/MiniAppRegistry.sol:9-55`, role `:67`, gate state `:104-112`, `initialize` `:129-153` |

### 1.5 Routers (spec 066 / 067)

| Contract | Purpose | Upgradeability | deployments key(s) | Chains | Key roles | Holds | Evidence |
|---|---|---|---|---|---|---|---|
| **BridgeRouter** | Curated Across V3 route registry + per-tx limits + pause; charges `bridge.transfer` by reading `FeeRouter`, skims to treasury, forwards net to the SpokePool atomically | **UUPS proxy** | `bridgeRouter` / `bridgeRouterImpl` | **1, 10, 137, 8453, 42161** | `LIQUIDITY_ADMIN_ROLE` (routes/limits/protocol addresses), `GUARDIAN_ROLE` (pause new bridges), `DEFAULT_ADMIN_ROLE` (fund-path addresses), `UPGRADER_ROLE` | **Transient custody only** — `nonReentrant`, resets approvals to 0, asserts `ResidualFunds` | `contracts/bridge/BridgeRouter.sol:16-59`; **THE MEMBER IS THE DEPOSITOR** (`depositV3` gets `msg.sender`, never `address(this)`) `:28-38`; service id `keccak256("bridge.transfer")` `:59` |
| **LiquidityRouter** | Curates supply pools (Uniswap V3 trading pools + Across bridge pools) and is the fee path for **Uniswap supplies only** | **UUPS proxy** | `liquidityRouter` / `liquidityRouterImpl` | **1, 10, 137, 8453, 42161** | `LIQUIDITY_ADMIN_ROLE`, `GUARDIAN_ROLE`, `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE` | **Never in an exit path**; position NFTs mint to the member; Across `addLiquidity` is a direct member call it never touches | `contracts/liquidity/LiquidityRouter.sol:16-58`; no `removePool` `:31-33`; `MAX_FEE_BPS = 250` enforced in the *charging* contract `:55-60`; service id `keccak256("liquidity.deposit")` `:52` |
| **StakingRouter** (spec 066) | Per-network control surface for staking + liquid-staking fee path | **UUPS proxy** | `stakingRouter` | **NONE deployed** (empty string in every frontend map that declares it) | `STAKING_ADMIN_ROLE`, `GUARDIAN_ROLE` | — | `contracts/staking/StakingRouter.sol:14-44`; registered in `scripts/deploy/check-storage-layout.js:57`; `stakingRouter: ''` for Mordor/Amoy/Polygon in `frontend/src/config/contracts.js` |

### 1.6 ERC-4337 accounts + paymaster (specs 041 / 050)

| Contract | Purpose | Upgradeability | deployments key(s) | Chains | Key roles | Holds | Evidence |
|---|---|---|---|---|---|---|---|
| **CoinbaseSmartWalletFactory** (vendored) | Deterministic factory for passkey smart accounts; emits `AccountCreated(address,bytes[],uint256)` | Immutable factory; `implementation` is `immutable` | `accountFactory` | **1, 10, 61, 63, 137, 8453, 42161, 80002** — the same address `0xd519C25e9dEd0DAC586B764574100479CB318734` on all of them | none | nothing | `contracts/account/CoinbaseSmartWalletFactory.sol:13-36`; addresses per chain in `deployments/*-v2.json` `contracts.accountFactory` |
| **CoinbaseSmartWallet** (vendored) | ERC-4337 account, `MultiOwnable`, ERC-1271, self-UUPS-upgradeable, WebAuthn/P-256 owners | Per-account **ERC-1967 proxy**, member-upgradeable | `accountImpl` = `0xfC5086A397e4FbAAF8f73892807415Da8d255E61` on all eight chains | same eight | account owner set (`MultiOwnable`) | **Yes** — it is the member's wallet | `contracts/account/CoinbaseSmartWallet.sol:15-22` |
| **FairWinsVerifyingPaymaster** (spec 050) | ERC-4337 **v0.6** verifying paymaster; sponsors a UserOp iff `paymasterAndData` carries a valid `verifyingSigner` (KMS, relay-gateway) signature over the op + validity window. Validation is signature-only, zero-storage | **Immutable**, `Ownable`; `entryPoint` is `immutable` | `verifyingPaymaster` (+ `verifyingPaymasterSigner` recorded) | **137 + 80002 only** | `owner` (floppy keystore) — the only withdrawer; `verifyingSigner` rotatable via `setVerifyingSigner`. A compromised signer can grief the deposit on gas but **cannot withdraw** | Holds the FairWins **EntryPoint deposit** — the bounded loss cap | `contracts/account/FairWinsVerifyingPaymaster.sol:12-52`; addresses `deployments/polygon-chain137-v2.json` (`0xe14554D14eB5DeC47f7824ebeeDa6C9f3A50d105`), `deployments/amoy-chain80002-v2.json` (`0xA00A06ae44FA2bd40Ec10D9613c96afD779b6898`); shared signer `0x9Ec0d8fF320c3590b47Da5B06ae0253Ab1Ca22CD` |
| `p256Verifier` | RIP-7212 fallback verifier slot | — | `p256Verifier` | **`null` on every chain** — recorded but never deployed | — | — | `deployments/*-v2.json` `contracts.p256Verifier: null` (all 8) |

### 1.7 Custody / Protect (specs 043 / 049 / 068)

| Contract | Purpose | Upgradeability | deployments key(s) | Chains | Key roles | Holds | Evidence |
|---|---|---|---|---|---|---|---|
| **SafePolicyGuard** (v1, spec 049) | Safe v1.4.1 transaction guard: per-tx + 24 h-window spend limits, recipient allowlist, cooldown. Still enforcing for vaults that have not adopted V2 | **Deliberately NOT upgradeable** — "an upgrade key would be a backdoor over every vault's enforcement" | `safePolicyGuard` | **137** (`0xa0F188776a65794cc06777412432e47dcB0d0c4B`) + 1337 local | **No owner, no admin role.** Authority is the vault itself: every mutator requires `msg.sender == safe`, i.e. a threshold-approved Safe self-transaction. Lockout-proof (txs to the Safe or the guard bypass fund rules) | Nothing, non-payable everywhere | `contracts/custody/SafePolicyGuard.sol:6-32`; `WINDOW = 24 hours`, `MAX_COOLDOWN = 365 days`, `MAX_ASSETS = 16` `:35-42` |
| **SafePolicyGuardV2** (spec 068) | Ordered rule array replaced atomically by `setRules`, **first-match-governs**, one fall-through for an unmet approver requirement of *strictly identical scope*; **no matching rule ⇒ denial**. Approver sets verified against the vault's own `approvedHashes` at `nonce()-1`, and an approver counts only while still an owner | **NOT upgradeable**; new rule types ship as a new guard version. Migration is **vault-consented** via a threshold-approved `setGuard` | `safePolicyGuardV2` | **1337, 10, 61, 63, 137, 8453, 42161** — identical address `0xf18B813Ad8C01249FE904A732543A1b8E6CAfd0c` on all six real chains (1337 differs) | same model as v1 — vault-is-authority, no admin | Nothing | `contracts/custody/SafePolicyGuardV2.sol:26-47`; the `ISafeMinimal` view-only slice `:5-24` |
| **PolicyGuardSetup** | Stateless helper `delegatecall`ed from `Safe.setup(to,data,…)` so a vault is policy-governed from its first transaction; writes the guard slot, emits Safe's `ChangedGuard`, then `call`s the guard config (so `msg.sender` seen by the guard IS the new Safe) | Stateless, immutable | `policyGuardSetup` | **10, 61, 63, 137, 8453, 42161, 1337** — `0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b` everywhere | none | Nothing; no payable/fallback, no selfdestruct | `contracts/custody/PolicyGuardSetup.sol:6-45`; guard slot `keccak256("guard_manager.guard.address")` `:23` |
| **SafeProposalHub** | **Events-only** broadcaster of Safe tx preimages for serverless co-owner discovery — no hosted Safe Transaction Service, no backend. Clients MUST recompute `Safe.getTransactionHash(...)` and reject mismatches | Stateless, immutable; uses no OpenZeppelin so it compiles pre-Cancun (ETC/Mordor) | `safeProposalHub` | **10, 61, 63, 137, 8453, 42161, 1337** — `0x94b5b38C247CE51F7C42C83B63115998b7e970E7` everywhere | none — "value-free and authority-free" | Nothing | `contracts/custody/SafeProposalHub.sol:4-45`; events `Proposed`/`Cancelled` `:27-42`; `MAX_DATA_LENGTH = 8192` `:18` |

### 1.8 Oracle adapters

| Contract | Purpose | Upgradeability | deployments key(s) | Chains | Roles | Holds | Evidence |
|---|---|---|---|---|---|---|---|
| **PolymarketOracleAdapter** | Reads Polymarket **Gnosis CTF** conditions (`conditionId = keccak256(oracle, questionId, outcomeSlotCount)`; `[1,0]`/`[0,1]`), caches resolutions | Immutable, `Ownable` + `ReentrancyGuard` | `polymarketAdapter` | **137** (`0x83688e9b8D4f085E3eF4619D91e0e6303cFcf0A4`), **80002** (`0x98fe63209f5BffcCe905bF8779a1F06576A2C313`), 1337 | `owner` | Nothing | `contracts/oracles/PolymarketOracleAdapter.sol:5-31`; stores `polymarketCTF` |
| **ChainlinkDataFeedOracleAdapter** | Reads a Chainlink price feed after a deadline and compares to a threshold (`GT/GTE/LT/LTE/EQ`); per-feed allowlist | Immutable, `Ownable` | `chainlinkDataFeedAdapter` | **137** (`0x7ae8220Dc02D0504EDCBa2C1B1AbA579AA3F0f23`), **80002** (same address) | `owner`, `allowedFeeds` | Nothing | `contracts/oracles/ChainlinkDataFeedOracleAdapter.sol:5-30` |
| **ChainlinkFunctionsOracleAdapter** | Sends a Chainlink Functions request to a DON and caches the boolean in the fulfillment callback | Immutable; `FunctionsClient` + **`ConfirmedOwner`** (two-step ownership — does **not** complete on transfer) | `chainlinkFunctionsAdapter` | **137** (`0x148C2E347a601AC1a680b17321529b0Ffc31AeFc`), **80002** (`0x074fC18C1E322a7537b53B8B2Bf0762629E3b532`) | `ConfirmedOwner` | Nothing (Functions subscription pays) | `contracts/oracles/ChainlinkFunctionsOracleAdapter.sol:5-32`; two-step-ownership caveat `docs/runbooks/key-compromise-recovery.md:88` |
| **UMAOptimisticOracleV3Adapter** | Resolves via UMA OOv3 assertions (asserter posts a bond; undisputed liveness ⇒ true; disputes escalate to the DVM via the same callback) | Immutable, `Ownable` | `umaAdapter` | **137** (`0x8224433d099Af6cd30540A78421aBFd6e044E949`), **80002** (`0xcEa9b4A01CcD3aA6545ea834a268C69e7eEfee88`) | `owner` | May move bond tokens (`SafeERC20`) | `contracts/oracles/UMAOptimisticOracleV3Adapter.sol:5-29`; `MIN_LIVENESS = 30` `:19`; CEI sentinel `:21-26` |
| `IOracleAdapter` | The standard interface every adapter implements (`oracleType`, `isAvailable`, `getConfiguredChainId`, `isConditionSupported`) | interface | — | — | — | — | `contracts/oracles/IOracleAdapter.sol:9-35` |

Registry wiring: `WagerRegistry` keeps a **dedicated `polymarketAdapter` slot** for ABI
compatibility plus a generic `mapping(ResolutionType => IOracleAdapter) oracleAdapters`
(`contracts/wagers/WagerRegistryCore.sol:60-69`). **ETC 61 / Mordor 63 have no oracle
adapters at all** — "ETC has no Polymarket/Chainlink/UMA", so those keys are intentionally
absent (`frontend/src/config/contracts.js:22-27`).

### 1.9 Tokens, DAO, privacy

| Contract | Purpose | Upgradeability | deployments key(s) | Chains | Roles | Evidence |
|---|---|---|---|---|---|---|
| **TokenFactory** (spec 028) | Platform token-issuance authority + registry; clones ERC-20/721 templates | **UUPS proxy** | `tokenFactory` / `tokenFactoryImpl` + `openERC20Impl`, `openERC721Impl`, `restrictedERC20Impl`, and `…V2Impl` variants | **137** (v1 templates), **63** (v1 + V2 templates) | `TOKEN_ISSUER_ROLE` | `contracts/tokens/TokenFactory.sol:17-30` |
| Token templates | `OpenERC20(V2)`, `OpenERC721(V2)`, `RestrictedERC20(V2)` (ERC-1404) | **ERC-1167 clones** of immutable templates | the `…Impl` keys above | 137 / 63 | `MINTER_ROLE`, `PAUSER_ROLE`, `BURNER_ROLE`, `COMPLIANCE_ROLE` | `contracts/tokens/templates/OpenERC20V2.sol:32-34`, `OpenERC721V2.sol:30-32`, `RestrictedERC20V2.sol:13` |
| **ExternalDAORegistry** (spec 030 / ClearPath) | Network-scoped registry of DAOs deployed by other platforms | **UUPS proxy** | `externalDAORegistry` / `externalDAORegistryImpl` | **63 only** | `DAO_MEMBER_ROLE` | `contracts/clearpath/ExternalDAORegistry.sol:10-22` |
| **StandardDAOFactory** | One call deploys a member's standard DAO (OZ `TimelockController` + `Governor` + token) | **UUPS proxy** | `standardDaoFactory` | **NONE** — empty on Polygon and Amoy, and **never coming on Mordor**: Mordor's EVM is pre-Cancun and OZ 5.4.0's `Governor` uses `MCOPY` (issue #1268) | `DAO_MEMBER_ROLE` | `contracts/clearpath/StandardDAOFactory.sol:20-54`; the absence-is-the-answer note `frontend/src/config/contracts.js:43-47` |
| **KeyRegistry** | address → encryption public key | Immutable, no roles | `keyRegistry` | **137, 63, 80002** (`0xcEFdeBba8E040c035c690ca9057cF22E73247c24` on 63 + 80002), 1337 | none | `contracts/privacy/KeyRegistry.sol:4-11` |
| **BackupPointerRegistry** | Per-wallet pointer to an off-chain encrypted backup (e.g. an IPFS CID) | Immutable, no roles | `backupPointerRegistry` | **137, 63** — `0x664ACAd4d604c626A6160948Df9C10FE38010E11` on both, plus 1337 | none | `contracts/privacy/BackupPointerRegistry.sol:4-13` |

### 1.10 Bases and legacy

| Item | Status | Evidence |
|---|---|---|
| **UUPSManaged** | Abstract base every upgradeable contract inherits. `UPGRADER_ROLE` separated from `DEFAULT_ADMIN_ROLE`; constructor `_disableInitializers()` locks bare-impl hijack; `_authorizeUpgrade` is the only, never-removed gate (non-brickable); `uint256[50] __gap` | `contracts/upgradeable/UUPSManaged.sol:8-46` |
| **SignerIntentBase** | Shared EIP-712 intent layer: per-signer 2-D replay-nonce map (`signer → nonce → used`), `_verifyIntent`, `invalidateNonce(WithSig)`. Storage is **ERC-7201 namespaced** (slot `0x4640730a…2400`), so bolting it onto a live proxy shifts no sequential slots and costs no `__gap` | `contracts/upgradeable/SignerIntentBase.sol:12-50` |
| **FriendGroupMarketFactory** (v1) | **LEGACY.** Source lives only in `contracts-archive/markets/FriendGroupMarketFactory.sol` — reference-only, never imported or deployed. No live network configures its address; `frontend/src/config/contracts.js` keeps only a `friendGroupMarketFactory` **deploy block** (63 → 15658191, 0 elsewhere) for legacy reads. Events: `MarketCreatedPending`/`ParticipantAccepted`/`WinningsClaimed`/`StakeRefunded` | `contracts/oracles/PolymarketOracleAdapter.sol:12` (only in-tree mention); blocks `frontend/src/config/contracts.js:396,411,425,458,474`; legacy fallback readers `frontend/src/data/wagers/EventsSource.js:41,165`, `frontend/src/utils/blockchainService.js:152,252,535`, `frontend/src/data/reports/reportDataSource.js:139-140` |
| **zkWagerPool\*** (Semaphore) | **Abandoned.** `zkWagerPoolSemaphore`, `semaphoreVerifier`, `poseidonT3`, `zkWagerPoolFactory(+Impl)` are recorded on Mordor 63 but "the prior Semaphore-based factory (`0x33cD…`) is abandoned and intentionally NOT wired here" | `deployments/mordor-chain63-v2.json` `contracts`; `frontend/src/config/contracts.js:48-51` |

---

## 2. Chain topology

### 2.1 EVM networks

`NETWORKS` in `frontend/src/config/networks.js` — ten numeric entries. Cohort split is
**total** (`isTestnet` on every entry); `cohortChainIds()` is the only roster an estate read
may use, because `listSupportedChainIds()` spans both cohorts and would breach
constitution III (`frontend/src/config/networks.js:1160-1172`).

| chainId | Name | Cohort | Reference-chain roles | Our contracts present | Evidence |
|---|---|---|---|---|---|
| **137** | Polygon | mainnet | **Membership chain** (`MAINNET_CHAIN_ID`), **mini-app registry chain**, `PRIMARY_CHAIN_ID` | Everything except `fundingPoolFactory`, `stakingRouter`, `standardDaoFactory`, `tokenFactory` V2 impls, `externalDAORegistry` | `networks.js:59,557-559`; `deployments/polygon-chain137-v2.json` |
| **80002** | Polygon Amoy | testnet | **Membership chain for testnet builds** (`TESTNET_CHAIN_ID`); deliberately **not** the mini-app registry chain | wagerRegistry (**no intents facet**), membershipManager, voucher, batchMinter, keyRegistry, sanctionsGuard, 3 oracle adapters, entryPoint/accountFactory/accountImpl, verifyingPaymaster | `networks.js:60,254`; `deployments/amoy-chain80002-v2.json` |
| **63** | Ethereum Classic Mordor | testnet | **Mini-app registry chain for testnet builds** (`MINIAPP_TESTNET_CHAIN_ID = 63`) — the one reference chain that does **not** derive from `TESTNET_CHAIN_ID`, because Amoy has no registry | Most of the estate + tokenFactory V2 + externalDAORegistry + abandoned zk pools; **no oracle adapters**, no callsignRegistry, no bridge/liquidity router | `networks.js:1141-1159,375-377`; `deployments/mordor-chain63-v2.json` |
| **61** | Ethereum Classic | mainnet | — | **Custody only**: `safeProposalHub`, `safePolicyGuardV2`, `policyGuardSetup`, `entryPoint`, `accountFactory`, `accountImpl`. **No `feeRouter`** | `networks.js:469-471`; `deployments/etc-chain61-v2.json`; `frontend/src/config/contracts.js` `ETC_CONTRACTS` ~L298 |
| **1** | Ethereum | mainnet | — | `feeRouter`, `bridgeRouter`, `liquidityRouter`, account stack. **Only chain with an Across HubPool** | `networks.js:815-817`; `deployments/mainnet-chain1-v2.json` |
| **10** | Optimism | mainnet | — | custody trio + `feeRouter` + `bridgeRouter` + `liquidityRouter` + account stack | `deployments/optimism-chain10-v2.json` |
| **8453** | Base | mainnet | — | same as Optimism | `deployments/base-chain8453-v2.json` |
| **42161** | Arbitrum One | mainnet | — | same as Optimism | `deployments/arbitrum-chain42161-v2.json` |
| **11155111** | Sepolia | testnet | — | **none** (no entry in `NETWORK_CONTRACTS`) | `networks.js:897-899` |
| **560048** | Hoodi | testnet | — | **none** | `networks.js:974-976` |
| **1337** | Hardhat | testnet, **local-only** | `isLocalOnlyChain(1337)`; `selectable: false`; `subgraphUrl: null` | full local sandbox set | `networks.js:1026-1035`; `frontend/src/config/contracts.js:549-562` |

`isLocalOnlyChain` is exported because local-only is a fact about **reachability**: a shipped
build can never reach `http://127.0.0.1:8545`, so `screeningChainIds() = cohortChainIds()
.filter(id => !isLocalOnlyChain(id))` (`frontend/src/lib/screening/sources.js:185-187`).

`NETWORK_CONTRACTS` mapping (`frontend/src/config/contracts.js:370-381`) — note the
**E2E Amoy impersonation**: `80002: E2E_AMOY_LOCAL ? HARDHAT_CONTRACTS : AMOY_CONTRACTS`,
DEV-guarded so the branch is dead code in production bundles.

### 2.2 Non-EVM networks (parallel registries — never merged into `NETWORKS`)

| id | Kind | Cohort | Notes | Evidence |
|---|---|---|---|---|
| `'bitcoin'` | Bitcoin (spec 061) | mainnet | **String id, no chainId, no contracts, no subgraph.** `coinType: 0`, hrp `bc`, gateway segment `mainnet`. Capabilities: portfolio/send/receive only; wagers/pools/membership/gasless/swap/earn/predict all **false**; `collect: 'stamps-only'` | `frontend/src/config/bitcoinNetworks.js:28-60` |
| `'bitcoin-testnet'` | Bitcoin Testnet4 | testnet | `coinType: 1`, hrp `tb`, gateway segment `testnet` | `bitcoinNetworks.js:61-70` |
| `'solana'` / `'solana-devnet'` | Solana (spec 063) | mainnet / testnet | Same parallel pattern; `coinType: 501`; ids must never reach `getContractAddressForChain`, wagmi, or subgraph code | `frontend/src/config/solanaNetworks.js:1-30` |
| `hyperliquid` (venue, not a network) | Perps venue (spec 082) | — | `evm: false`, `chains: []` — "its own L1 — never a numeric chain id (FR-012)". `isEvmPerpVenue` is the boundary guard. Read-only market data; the **only** platform-priced perps fee | `frontend/src/config/perps.js:42-56` |

Boundary guards: `isBitcoinNetworkId` (`bitcoinNetworks.js:74-76`), `isSolanaNetworkId`,
`isEvmPerpVenue` (`perps.js:54-56`).

### 2.3 Proxy → implementation, per chain (from `deployments/**`)

Only rows where `deployments/` records both halves. Addresses quoted verbatim.

#### Polygon 137 — `deployments/polygon-chain137-v2.json`

| Contract | Proxy | Implementation |
|---|---|---|
| WagerRegistry | `0xE878b62887fC8A5F739B8Ce61bC19546A280Ef89` | `0x9c52C1ef4Bbe65CF19a5C26bebD4A22100964898` |
| WagerRegistryIntents (facet) | — (reached via the proxy) | `0x8878C8d6822De61cA8886Ae1D8BDA60b61ca1d81` |
| MembershipManager | `0xEfd1a880c6BfBf38A661A3F5fF6d5ECB296D557a` | `0x7177470fE3c5D89CEf965A596540E57cE290C939` |
| TokenFactory | `0x5806e76cA3c838524E7cF43db7625bdFBA0783a0` | `0xE819f7b672D81A8b78d40b1C99Fe5d646513D12C` |
| WagerPoolFactory | `0x420aEC3c76859eB74ab21c769c16AcdAB221f723` | `0x754d8aa4785Ec4bEE7c921f8d032D5E3a78d9308` (clone template `poolImpl` `0xB153e4456FaD1A7E96e35e14094Cf6964348BC40`) |
| CallsignRegistry | `0x22BD6Dd351Db375b64C2886Bda6f3E3F4fd31dA2` | `0xD220D34ed2148B9F4DC65C1bc75169D7DECFBB49` |
| FeeRouter | `0xf8161fC26172621E9fbcc6c39500Bb14b0902B35` | `0x40ee755246E60f66E7bA425F99C6d704859d38db` |
| BridgeRouter | `0x8064F3Cd9F8f113691B981d2B15EF85D95Abd551` | `0x8F7A7e7437733326BD2F8045BFceD9B821aF1De1` |
| LiquidityRouter | `0x13762c059c2A22E3bCd8A44F36EA44e8e3B22B31` | `0x33818052Ca8B5b8Bb9777Bf6eBbaFCD8Faae6e65` |
| MiniAppRegistry | `0x5a168Cc9FeFaf40e7BC536C8C61669e6d547A0A2` | `0x41858006aD6dd0788b84F9fb17A28d8167C7b331` |
| Immutable singletons | `sanctionsGuard 0x2Dc53d91A189be71DfE96Ea9BCFCF6aDDA77BC76`, `membershipVoucher 0xCB28DC438564672067a6f84131B5130e6Cf7ECC6`, `voucherBatchMinter 0x4b50d24ca28CbDC029714e5830f7D16a0ebEDb0e`, `keyRegistry 0xcEFdeBba8E040c035c690ca9057cF22E73247c24`, `backupPointerRegistry 0x664ACAd4d604c626A6160948Df9C10FE38010E11`, `safePolicyGuard 0xa0F188776a65794cc06777412432e47dcB0d0c4B`, `safePolicyGuardV2 0xf18B813Ad8C01249FE904A732543A1b8E6CAfd0c`, `policyGuardSetup 0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b`, `safeProposalHub 0x94b5b38C247CE51F7C42C83B63115998b7e970E7`, `verifyingPaymaster 0xe14554D14eB5DeC47f7824ebeeDa6C9f3A50d105` | — |

#### Mordor 63 — `deployments/mordor-chain63-v2.json`

| Contract | Proxy | Implementation |
|---|---|---|
| WagerRegistry | `0x3ccB144d8aa838e8d4D695867cC72e548117830C` | `0x9FfE701be18Ff033706f2df19cd8730F5CB884B2` |
| WagerRegistryIntents | — | `0x81a9c5904A109F0b7bC6329ba6F2be2de5B6abB1` |
| MembershipManager | `0x68bCBA1055DAbe11b98Bb8425A16e648Ad65d541` | `0x7D38F7Ef26f7E2409d5C04a62c1d9A3Ec002A49e` |
| TokenFactory | `0x5bdf74Ce98D41bf35192c20B25ACd561C75CFe62` | `0x135108EB6f81e361b6cF131d2Cb9A01E92Cd8ED9` |
| ExternalDAORegistry | `0xcEE0fb2e1407f0A0d19Bcf4Fee2726A3005FA3C0` | `0x28270cB71E87D2D6C662e61CFE6eD02d05d43B7A` |
| WagerPoolFactory | `0xac78B4EdeF96e74a2653028dF93A26acFCfC613F` | `0xfB6F9F7EfD86a220eE1aD7906278247051B25430` (template `poolImpl 0xd0b94a77DA7Aaa488343CF89978f1Bbf9E72E277`) |
| FeeRouter | `0x5249e3008Cb1Eb81B5BF39148B7760B1c36e516e` | `0x744b8E56d84bb8D7657b2Bb13426cB882c93B7E6` |
| MiniAppRegistry | `0xFEd626025225A3B1aB3BA72D429B8c9C74cb5058` | `0xc8Dd8601b35aDa3AF367C9E41f24Fd0503Ced674` |
| **Abandoned** | `zkWagerPoolFactory 0x33cDfa339AbE993FEfEB9fE1A8341105ba55D586` | `0xd3e851FDDa9D5796D503daFd34b2403D7336d9fD` — deliberately not wired |

#### Amoy 80002 — `deployments/amoy-chain80002-v2.json`

| Contract | Proxy | Implementation |
|---|---|---|
| WagerRegistry | `0xA429CdaD3E1497e33BEA7D6FE7d6913fE880241b` | `0xa2176F5Fea39888cD1697Be4651415490C78905d` — **no `wagerRegistryIntents` recorded**, so the gasless facet is unavailable here |
| MembershipManager | `0x89158f2E044C73c687dA12B7FA42b94F9A6D8465` | `0xb6499596703cEE6eA4BE5b5F01DEc4d7ccfe10bD` |

#### Ethereum 1 / Optimism 10 / Base 8453 / Arbitrum 42161

| Contract | Ethereum 1 | Optimism 10 / Base 8453 / Arbitrum 42161 |
|---|---|---|
| FeeRouter proxy → impl | `0xB9F80D6D4CfD3ecC60b63810aDF9d88931D0e3d3` → `0x5cCd55D62Ce7Df730c39543B332dD8d6054B5d00` | `0x98218248CA53Dd88159979af20172C86b94e8B29` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea` (same on all three) |
| BridgeRouter proxy → impl | `0x258181DF2aa45EA3a3eAC748d6491D5e1f2675eE` → `0xcA277Cc3485Da12771d6171a9D0A894B8DD159f8` | `0x1afcAC1949BD306F7D4818999f509941F2E85582` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5` |
| LiquidityRouter proxy → impl | `0x1afcAC1949BD306F7D4818999f509941F2E85582` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5` | `0xA273aF8ebB76d1D0Dcd55692C1f5a7db956F7EED` → `0x7Af46728e7C969b75723398e3F93b565E968A3ba` |

> **Address-collision caution for the workbook:** Ethereum's `liquidityRouter` proxy
> `0x1afcAC…5582` is byte-identical to the *BridgeRouter proxy* address on 10/8453/42161, and
> its impl `0x41ba6bca…` is the BridgeRouter impl there. This is a nonce-derived artefact of
> deploying from one EOA in a fixed order, and `scripts/deploy/check-storage-layout.js:118`
> documents exactly this overlap. Never read one chain's label onto another.

#### ETC 61 — `deployments/etc-chain61-v2.json`
Custody + account stack only: `safePolicyGuardV2 0xf18B813A…fd0c`, `policyGuardSetup
0xD0CB9D0c…8C2b`, `safeProposalHub 0x94b5b38C…70E7`, `entryPoint 0x5FF137D4…2789`,
`accountFactory 0xd519C25e…8734`, `accountImpl 0xfC5086A3…5E61`. No FeeRouter, no routers,
no wager/membership estate.

### 2.4 Recorded deploy blocks (event-scan floors)

`deployments/*-v2.json` `deployBlocks` and the client copy in
`frontend/src/config/contracts.js:409-470`:

| Chain | Recorded blocks |
|---|---|
| 137 | `backupPointerRegistry 90120712`, `safePolicyGuard 90120723`, `policyGuardSetup 90120725`, `safeProposalHub 90120743`, `safePolicyGuardV2 90932886`, `feeRouter 90939919`, `miniAppRegistry 91265680`, `accountFactory 89725718`; client-side also `wagerRegistry 89717915`, `membershipVoucher 89717905` (*measured*), `membershipManager 89717895` (*measured*), `tokenFactory 89717942`, `wagerPoolFactory 89720740`, oracle adapters 87937162/87937176/87937184 |
| 63 | `wagerRegistry 16404317`, `membershipManager 16404308`, `membershipVoucher 16404315`, `voucherBatchMinter 16407208`, `backupPointerRegistry 16430733`, `wagerPoolFactory 16495564`, `poolImpl 16497337`, `safePolicyGuardV2 16645528`, `policyGuardSetup 16645530`, `safeProposalHub 16645531`, `feeRouter 16646334`, `miniAppRegistry 16685064`, `accountFactory 16650970` |
| 80002 | `wagerRegistry 40521027`, `membershipManager 40521018`, `membershipVoucher 40521024`, `voucherBatchMinter 40545690` |
| 61 / 10 / 8453 / 42161 | `safeProposalHub` only: 25026893 / 154753770 / 49158472 / 488059169 (**plus** `safePolicyGuardV2`, `policyGuardSetup`, `feeRouter`, `accountFactory` in `deployments/`) |
| 1 | `accountFactory 25625767` |

**`safeProposalHub` MUST carry a block on every custody chain** — `useVaultProposals`
refuses to scan without one, so a missing entry silently kills proposal discovery even
where the hub is deployed (`frontend/src/config/contracts.js:400-403`). `miniAppRegistry`'s
block is a placeholder `0` on several chains and disables nothing, because catalog/launch
reads are view calls, never event scans (`contracts.js:404-408`).
Separately, `deployBlocks.accountFactory` is recorded but the spec-104 passkey **discovery**
path is blocked on it per `CLAUDE.md` — and `deployBlocks?.X || 0` makes a missing entry a
silent scan from block 0.

---

## 3. Roles & authority

### 3.1 Role constants found in `contracts/**` (excluding `mocks/`, `test/`)

| Role constant | Contract(s) | What it can do | Evidence |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` (OZ) | every `UUPSManaged` adopter + `SanctionsGuard` | Config: on WagerRegistry the membership manager, oracle adapter, token allowlist; on MembershipManager the treasury + tier config + role admin; on the routers the **fund-path addresses** (`spokePool`/`positionManager`/`feeRouter`/`sanctionsGuard`); on MiniAppRegistry only the vendor gate | `contracts/upgradeable/UUPSManaged.sol:33-36`; `contracts/wagers/WagerRegistry.sol:21` |
| `UPGRADER_ROLE` | `UUPSManaged` (all adopters) | Replace the implementation — and on `WagerRegistry` also `setIntentExtension`, because swapping the facet is equivalent to an upgrade | `contracts/upgradeable/UUPSManaged.sol:18-20,40`; `contracts/wagers/WagerRegistry.sol:91,109-110` |
| `GUARDIAN_ROLE` | `WagerRegistryCore`, `BridgeRouter`, `LiquidityRouter`, `StakingRouter` | Emergency pause / unpause of **new** activity. **Per-router** — it does *not* inherit the WagerRegistry guardian set; admin tabs read authority from the router in scope (`readRouterAuthority`) | `WagerRegistryCore.sol:43`, `BridgeRouter.sol:56`, `LiquidityRouter.sol:48`, `StakingRouter.sol:44` |
| `ACCOUNT_MODERATOR_ROLE` | `WagerRegistryCore` | Freeze / unfreeze individual accounts (a frozen account cannot create/accept/cancel/declare/claim/refund) | `WagerRegistryCore.sol:44`; `WagerRegistry.sol:23,26-27` |
| `WAGER_PARTICIPANT_ROLE` | `WagerRegistryCore` (declared); `MembershipManager` (the paid membership key) | The gate a member must hold to wager; the **only paid role** | `WagerRegistryCore.sol:42`; `MembershipManager.sol:14-16` |
| `ROLE_MANAGER_ROLE` | `MembershipManager` | Grant / revoke memberships out-of-band | `MembershipManager.sol:26` |
| `SANCTIONS_ADMIN_ROLE` | `SanctionsGuard` | Add/remove discretionary deny-list entries (`DEFAULT_ADMIN_ROLE` sets the oracle) | `SanctionsGuard.sol:18-19,24` |
| `POOL_PARTICIPANT_ROLE` | `WagerPoolFactory`, `FundingPoolFactory` | Membership role gating pool participation — distinct from `WAGER_PARTICIPANT_ROLE`; **the same role for both pool kinds**, so one tier config covers both | `WagerPoolFactory.sol:37-39`; `FundingPoolFactory.sol:35-37` |
| `FEE_ADMIN_ROLE` | `FeeRouter` | Change service rates within their registered caps; granted to `admin` in `initialize` alongside `DEFAULT_ADMIN_ROLE` + `UPGRADER_ROLE`. History = `FeeBpsChanged` events | `FeeRouter.sol:33-34,49-58` |
| `LIQUIDITY_ADMIN_ROLE` | `BridgeRouter`, `LiquidityRouter` | Curate routes / pools / limits (reversible) — as distinct from `DEFAULT_ADMIN_ROLE`, which owns the fund-path addresses (not reversible) | `BridgeRouter.sol:52-54`; `LiquidityRouter.sol:47` |
| `STAKING_ADMIN_ROLE` | `StakingRouter` | Staking config (contract undeployed) | `StakingRouter.sol:42` |
| `APP_CURATOR_ROLE` | `MiniAppRegistry` | Approve / suspend / deprecate listings — **the platform's entire supply-chain trust boundary**. Self-administering (`_setRoleAdmin(APP_CURATOR_ROLE, APP_CURATOR_ROLE)`), required non-zero at `initialize`, "held by the compliance multisig and granted post-deploy, never in `initialize`" | `MiniAppRegistry.sol:19-21,67,129-151` |
| `REGISTRY_CURATOR_ROLE`, `MODERATOR_ROLE`, `VERIFIER_ROLE` | `CallsignRegistry` | Policy params / moderation / verification marker. **None can reassign a callsign to a different owner** | `CallsignRegistry.sol:28-31` |
| `TOKEN_ISSUER_ROLE` | `TokenFactory` | Gate token creation | `TokenFactory.sol:30` |
| `MINTER_ROLE`, `PAUSER_ROLE`, `BURNER_ROLE` | `OpenERC20V2`, `OpenERC721V2` | Per-token-clone operations | `OpenERC20V2.sol:32-34`; `OpenERC721V2.sol:30-32` |
| `COMPLIANCE_ROLE` | `RestrictedERC20V2` | ERC-1404 transfer restrictions | `RestrictedERC20V2.sol:13` |
| `DAO_MEMBER_ROLE` | `ExternalDAORegistry`, `StandardDAOFactory` | ClearPath registry/factory membership gate | `ExternalDAORegistry.sol:22`; `StandardDAOFactory.sol:54` |
| **No role at all (by design)** | `SafePolicyGuard`, `SafePolicyGuardV2`, `PolicyGuardSetup`, `SafeProposalHub`, `KeyRegistry`, `BackupPointerRegistry`, `VoucherBatchMinter` | Authority for the guards is the **vault itself** (`msg.sender == safe`); the hub and registries are authority-free | `SafePolicyGuard.sol:14-18`; `SafePolicyGuardV2.sol:34-39`; `SafeProposalHub.sol:11-15` |
| `owner` (Ownable / ConfirmedOwner) | 4 oracle adapters, `FairWinsVerifyingPaymaster` | Adapter config; on the paymaster the **only** withdrawer of the EntryPoint deposit | `FairWinsVerifyingPaymaster.sol:28-31,32` |
| `verifyingSigner` (not a role) | `FairWinsVerifyingPaymaster` | Authorize sponsorship. A compromised signer can grief the deposit on gas but cannot withdraw; rotate with `setVerifyingSigner` | `FairWinsVerifyingPaymaster.sol:28-31,37-38` |

Not an on-chain role, but the same class of authority: `authorizedCallers` on
`MembershipManager` (`MembershipManager.sol:45`) — kept for the WagerRegistry hook surface.

### 3.2 Who holds what — recorded facts and open items

| Fact | Detail | Evidence |
|---|---|---|
| **Admin Safe (current)** | `0xcf76db7aa9Fb1BFe08E010468F3344bB45830447`, **2-of-3**, owners `0x26235546…1C9A`, `0x12151853…8575`, `0x48cBca63…2275`, `saltNonce 68` — the same address on chains 1, 10, 61, 63, 137, 8453, 42161 | `deployments/admin-safe.json` |
| **Admin Safe (superseded)** | `0x8cc564E3dF4003c2F0a33C679c8DfE6237c5c3fa` — retired 2026-08-22 because "owner set included a compromised hot EOA and a passkey CONTRACT that only had code on Polygon, leaving an effective 2-of-2 off Polygon". Replacement is KMS HSM + Ledger + Trezor, all EOAs, so all three sign on every chain. **Note this same address is still the recorded `treasury` on chains 1, 10, 8453, 42161** | `deployments/admin-safe.json` `superseded`; `treasury` in `deployments/{mainnet,optimism,base,arbitrum}-*.json` |
| **Key-compromise write-off (Mordor)** | 2026-08-22: a chain-wide `RoleGranted`/`OwnershipTransferred` scan of Mordor found **23 unrecorded contracts** holding live authority — superseded WagerRegistry/MembershipManager iterations, the `contracts-archive` v1 RBAC estate (`RoleManager`, `MembershipPaymentManager`, `FriendGroupMarketFactory`) and token clones — carrying ~**60 sole-held roles** and **62 Ownable owners** still held by the compromised EOA `0x52502d04…F6e1`. Decision: **NOT MIGRATED — deliberately abandoned.** The 10 *recorded* Mordor contracts were migrated in full to the admin Safe. "Do NOT deploy anything new that depends on these, and do not read their state as trustworthy." | `deployments/mordor-chain63-v2.json` `legacyContractsWriteOff`; runbook `docs/runbooks/key-compromise-recovery.md` |
| **Deployer EOA** | `0x52502d049571C7893447b86c4d8B38e6184bF6e1` on every non-local chain (`0xf39Fd6e5…2266` on Hardhat) — **this is the compromised key** named in the write-off above | `deployer` in every `deployments/*-v2.json` |
| **Outstanding: router admin handoff (#966)** | Per `CLAUDE.md`: BridgeRouter + LiquidityRouter "are now deployed and recorded on all five EVM mainnets (1/10/137/8453/42161); the admin handoff off the deployer EOA is still outstanding (issue #966), so treat `DEFAULT_ADMIN_ROLE` on these routers as held by a single hot key until that lands." | `CLAUDE.md` spec-067 guardrail |
| **⚠️ Stale doc** | `docs/developer-guide/bridge-and-liquidity.md:25` still says *"neither router is deployed on any network yet (issue #966)"* — contradicted by the addresses now in `deployments/{mainnet,optimism,polygon,base,arbitrum}-*.json`. The **deployment** half of #966 is done; the **handoff** half is not. Flagging so the workbook does not inherit the stale claim | `docs/developer-guide/bridge-and-liquidity.md:25-28` vs `deployments/*-v2.json` |
| **Two-step ownership trap** | `ChainlinkFunctionsOracleAdapter` uses `ConfirmedOwner`: ownership does **not** complete on transfer — the recipient must accept | `docs/runbooks/key-compromise-recovery.md:88` |
| **Sanctions/oracle admin** | Both `SANCTIONS_ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE` on `SanctionsGuard` are "granted to the air-gapped floppy-keystore admin at deploy" | `contracts/access/SanctionsGuard.sol:18-19` |
| **Paymaster owner** | "only `owner` (floppy keystore) withdraws"; `verifyingSigner` is the relay-gateway KMS key (`verifyingPaymasterSigner 0x9Ec0d8fF320c3590b47Da5B06ae0253Ab1Ca22CD` on both 137 and 80002) | `contracts/account/FairWinsVerifyingPaymaster.sol:28-29`; `deployments/polygon-chain137-v2.json`, `amoy-chain80002-v2.json` |
| **Treasuries** | 137 → `0x1215185387E70a48b07D73AcB67002A073F18575`; 1/10/8453/42161 → `0x8cc564E3dF4003c2F0a33C679c8DfE6237c5c3fa` (the *superseded* Safe); 63/80002 → the deployer EOA | `treasury` in each `deployments/*-v2.json` |
| **No Projects-v2 / role mirror** | Off-chain: there is deliberately **no `status:*` label mirror**; on-chain authority is read from the contract that will enforce it, and an *unconfirmed* authority read leaves a control offered rather than hiding a killswitch on an RPC timeout | `CLAUDE.md` multi-agent + spec-071 guardrails |

### 3.3 Fee services registered on `FeeRouter` (config, all ship at 0 bps)

| serviceId | Kind | Cap | Charged by | Evidence |
|---|---|---|---|---|
| `earn.lend` | **Wrapped** | 250 bps | `FeeRouter.depositToVaultWithFee` (the only on-chain charging path) | `scripts/deploy/lib/feeServices.js:18` |
| `polymarket.taker` | ConfigOnly | 100 bps | relay-gateway reads (spec-057 cap) | `feeServices.js:19` |
| `polymarket.maker` | ConfigOnly | 50 bps | relay-gateway reads | `feeServices.js:20` |
| `stake.lido` | ConfigOnly | 250 bps | `StakingRouter` skims + forwards | `feeServices.js:24` |
| `stake.polygon` | ConfigOnly | 250 bps | `StakingRouter` | `feeServices.js:25` |
| `perps.hyperliquid.builder` | ConfigOnly | **10 bps** (Hyperliquid's own limit, not our 250) | Hyperliquid, per order | `feeServices.js:31` |
| `bridge.transfer` | ConfigOnly | 250 bps | `BridgeRouter` (value-out) | `scripts/deploy/deploy-bridge-liquidity.js:110` |
| `liquidity.deposit` | ConfigOnly | 250 bps | `LiquidityRouter` (Uniswap supply, value-in) | `scripts/deploy/deploy-bridge-liquidity.js:111` |

`registerService` is **one-shot per id** (`AlreadyRegistered`); the deploy script asserts the
live table matches `feeServices.js` (`deploy-fee-router.js:180,221,252`). `ConfigOnly` is
load-bearing: it makes `depositToVaultWithFee("bridge.transfer", …)` revert
`ServiceNotWrapped` (`deploy-bridge-liquidity.js:100-111`).

---

## 4. On-chain ↔ off-chain seams

### 4.1 Client resolution seam

Everything the browser resolves goes through
`frontend/src/config/contracts.js#getContractAddressForChain(name, chainId)` (`:535-546`),
backed by per-chain literal maps. Never hand-build an address; never hand-build a provider
either — reads go through `frontend/src/lib/network/rpcEndpoints.js#resolveRpcEndpoints` →
`utils/rpcProvider.js#makeReadProvider` / `getReadProvider(chainId)` (member override →
build default). Per-chain key sets (`frontend/src/config/contracts.js`, line numbers from
the `const *_CONTRACTS` declarations):

| Map (line) | Chain | Keys declared (`''` = declared-but-undeployed) |
|---|---|---|
| `MORDOR_CONTRACTS` (:29) | 63 | deployer, wagerRegistry, membershipManager, keyRegistry, sanctionsGuard, paymentToken, wmatic, membershipVoucher, voucherBatchMinter, tokenFactory, externalDAORegistry, backupPointerRegistry, wagerPoolFactory, miniAppRegistry, safeProposalHub, safePolicyGuardV2, policyGuardSetup, feeRouter, entryPoint, accountFactory — **`''`:** treasury, fundingPoolFactory, callsignRegistry, stakingRouter, bridgeRouter, liquidityRouter |
| `HARDHAT_CONTRACTS` (:82) | 1337 (and 80002 under `E2E_AMOY_LOCAL`) | full local set incl. standardDaoFactory, safePolicyGuard, fundingPoolFactory, callsignRegistry, feeRouter |
| `AMOY_CONTRACTS` (:207) | 80002 | wagerRegistry, membershipManager, keyRegistry, sanctionsGuard, polymarketAdapter, paymentToken, wmatic, 2 chainlink adapters, umaAdapter, membershipVoucher, voucherBatchMinter, entryPoint, verifyingPaymaster, accountFactory — **`''`:** callsignRegistry, miniAppRegistry, stakingRouter, bridgeRouter, liquidityRouter, standardDaoFactory |
| `POLYGON_CONTRACTS` (:246) | 137 | the full estate — **`''`:** fundingPoolFactory, stakingRouter, standardDaoFactory |
| `ETC_CONTRACTS` (:298) | 61 | deployer, safeProposalHub, safePolicyGuardV2, policyGuardSetup, entryPoint, accountFactory |
| `ETHEREUM_CONTRACTS` (:310) | 1 | bridgeRouter, liquidityRouter, feeRouter, deployer, entryPoint, accountFactory |
| `OPTIMISM_/BASE_/ARBITRUM_CONTRACTS` (:319/:331/:343) | 10 / 8453 / 42161 | bridgeRouter, liquidityRouter, safeProposalHub, safePolicyGuardV2, policyGuardSetup, feeRouter, deployer, entryPoint, accountFactory |

**Note:** `wagerRegistryIntents` has **no** client key — a grep of `frontend/src` returns
nothing. That is correct: the facet is only ever reached through the proxy's fallback, so
the client resolves `wagerRegistry` and gets a merged ABI. Tests deploy the pair via
`test/helpers/proxy.js#deployWagerRegistry`.

Tenant seam (spec 072): a **dedicated** tenant resolves only its own generated set from
`tenantContractsForChain(chainId)` — "absence stays absence, no fallback to the shared
estate" (`frontend/src/config/contracts.js:493-503`).

### 4.2 Subgraph (`subgraph/**`)

Only **Polygon 137 (`network: matic`)** is in the committed manifest. Eight data sources +
two templates:

| Data source | Address (137) | Start block | Events handled | Entities |
|---|---|---|---|---|
| `WagerRegistry` | `0xE878b628…Ef89` | 89717915 | `WagerCreated`, `OpenWagerCreated`, `WagerAccepted`, `PayoutClaimed`, `WagerRefunded`, `WagerDrawn`, `WagerCancelled`, `WagerResolved`, `WagerDeclined`, `DrawProposed`, `DrawRevoked` | `Wager`, `WagerTransfer` |
| `MembershipVoucher` | `0xCB28DC43…ECC6` | 89717905 | `VoucherMinted`, `Transfer` | `Voucher` |
| `MembershipManager` | `0xEfd1a880…557a` | 89717895 | `MembershipRedeemed` | `Voucher` |
| `ChainlinkDataFeedOracleAdapter` | `0x7ae8220D…0f23` | 87937162 | `ConditionRegistered`, `MarketLinked`, `ConditionResolved` | `OracleCondition`, `OracleMarketLink` |
| `ChainlinkFunctionsOracleAdapter` | `0x148C2E34…AeFc` | 87937176 | same three | same |
| `UMAOptimisticOracleV3Adapter` | `0x8224433d…E949` | 87937184 | same three | same |
| `TokenFactory` | `0x5806e76c…83a0` | 89717942 | `TokenCreated` | `Token` |
| `WagerPoolFactory` | `0x420aEC3c…f723` | 89720740 | `PoolCreated`, `TokenAllowed` | `Pool`, `PoolAllowedToken` |
| **template** `TokenInstance` | dynamic | — | `Transfer`, `Paused`, `Unpaused`, `Frozen`, `RoleGranted`, `RoleRevoked` | `Holder`, `TokenActivity` |
| **template** `WagerPool` | dynamic (clones) | — | `Joined`, `JoiningClosedEvent`, `OutcomeProposed`, `Approved`, `OutcomeLocked`, `Claimed`, `Refunded`, `PoolCancelled` | `PoolMember`, `PoolProposal`, `PoolPayoutEntry`, `PoolApproval`, `PoolClaim`, `PoolRefund` |

Schema entities (`subgraph/schema.graphql`): `Wager`:41, `WagerTransfer`:73, `Voucher`:102,
`OracleCondition`:137, `OracleMarketLink`:164, `Token`:184, `Holder`:207, `TokenActivity`:224,
`Pool`:251, `PoolMember`:294, `PoolProposal`:311, `PoolPayoutEntry`:337, `PoolApproval`:351,
`PoolClaim`:364, `PoolRefund`:378, `PoolAllowedToken`:389.

`subgraph/networks.json` additionally declares deployable address sets for **`mordor`**
(WagerRegistry, MembershipVoucher, MembershipManager, TokenFactory, WagerPoolFactory) and
**`polygon-amoy`** (WagerRegistry, MembershipVoucher, MembershipManager + 3 oracle adapters).

**Not indexed by any subgraph** — read on-chain only: `FeeRouter`, `BridgeRouter`,
`LiquidityRouter`, `CallsignRegistry`, `MiniAppRegistry`, `SafeProposalHub`/policy guards,
`SanctionsGuard`, `FundingPoolFactory`/`FundingPool` (spec 103 ships "no subgraph entity
yet" — the feed is the clone's own log bounded at `createdBlock`), `KeyRegistry`,
`BackupPointerRegistry`, the account stack and the paymaster. Chains with
`subgraphUrl: null` (e.g. 1337) read straight over RPC (`networks.js:1035-1036`).

### 4.3 Event-scan floors and the reads that depend on them

| Reader | Needs | Consequence if missing |
|---|---|---|
| `useVaultProposals` (custody queue) | `getDeploymentBlockForChain('safeProposalHub', chainId)` | **Refuses to scan** → proposal discovery silently dead on that chain (`frontend/src/config/contracts.js:400-403`) |
| Mini-app catalog / launch | nothing (view calls only) | a `0` block cannot make Apps look available; availability comes from a non-empty address + an Approved record (`contracts.js:404-408`) |
| `useVouchers#listMyVouchers` | `membershipVoucher` block | a block *later* than real creation renders an honest-looking empty list for a holding that exists — the Amoy E2E case (`contracts.js:437-447`) |
| passkey account **discovery** (spec 104 R2) | `deployBlocks.accountFactory` | `deployBlocks?.X \|\| 0` ⇒ a silent scan from block 0 rather than a loud failure (`CLAUDE.md` spec-104 guardrail) |

### 4.4 Browser-direct vs relay-gateway

| Path | Rail | Evidence |
|---|---|---|
| Every contract **read** (balances, wagers, membership, pools, fee rates, vault queues, screening) | **Browser-direct** over `getReadProvider(chainId)` / `makeReadProvider`, member RPC override first | `CLAUDE.md` spec-069 guardrail; `frontend/src/lib/screening/sources.js` uses `readProviderFor` |
| Relayed intents (contract actions + EIP-3009) | `services/relay-gateway` policy gateway → `services/oz-relayer` engine. Every gasless flow keeps a **self-submit fallback** | `CLAUDE.md` spec-035/036; gateway targets are validated per chain from the deployment record — `wagerRegistry`, `membershipManager`, `sanctionsGuard` all required (`services/relay-gateway/src/config/index.js:313,329-332`) |
| Sponsored UserOps | alto bundler (EntryPoint v0.6) + KMS-signed ERC-7677 endpoint `POST /v1/paymaster` on the **same** gateway | `deployments/polygon-chain137-v2.json` `infra` (alto `ghcr.io/pimlicolabs/alto:v1.2.7`, executor `0x7C6da19ae005D4F13BB8660Ac989c48aCcFE84F6`, key in Secret Manager `alto-executor-key-137`) |
| `FeeRouter` rate reads by the gateway | gateway reads the router **read-only** via `services/relay-gateway/src/fees/onchain.js`; env bps are fallback. `FEE_ROUTER_CHAIN_ID` defaults **137**, address defaults to the deployment record's `feeRouter` and a contradicting env value **fails boot** | `services/relay-gateway/src/config/index.js:200-205,1203-1218` |
| Gateway enabled-chain gate | A chain may be enabled only if the record has all three of `wagerRegistry`/`membershipManager`/`sanctionsGuard`; a chain with custody contracts only (no wagerRegistry) **fails** to enable. Membership reference chain must be enabled *and* have a `membershipManager`, else boot refuses ("no member could be authenticated") | `services/relay-gateway/src/config/index.js:7-12,313,925-987` |
| Gateway chain table | 137 + 80002 support EIP-3009 payment (`tokenDomain` `{USD Coin,2}` / `{USDC,2}`); **61 + 63 are `paymentSupported: false`** — the live USC token is permit-only, no EIP-3009 — and both are `noBatch` (their endpoints return batch responses ethers v6 cannot decode) | `services/relay-gateway/src/config/chains.js:10-63` |
| Read-only proxies (no contracts) | Polymarket (`polymarket/`), Perps (`perps/`), OpenSea (`opensea/`), Bitcoin (`bitcoin/`), News (`news/`), member API (`memberApi/`), x402 (`x402/`) | `services/relay-gateway/src/` listing |

---

## 5. External protocol contracts (called, not owned)

| Protocol | Address(es) | Chain(s) | Source file | Notes |
|---|---|---|---|---|
| **EntryPoint v0.6** | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | 1, 10, 61, 63, 137, 8453, 42161, 80002 | `deployments/*-v2.json` `contracts.entryPoint`; `frontend/src/config/contracts.js:77,103,237,269,303,315,327,339,351` | Canonical v0.6. The paymaster's `entryPoint` is `immutable`; alto runs `deploy-simulations-contract=false` because v0.6 has built-in `simulateHandleOp` |
| **Safe v1.4.1 singletons** | `singleton 0x41675C099F32341bf84BFc5382aF534df5C7461a`, `singletonL2 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`, `proxyFactory 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, `fallbackHandler (CompatibilityFallbackHandler, EIP-1271) 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`, `multiSendCallOnly 0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | 10, 61, 63, 137, 8453, 42161 (+ 80002 **DEV-only** E2E impersonation) | `frontend/src/config/safeContracts.js:13-48` | Identical on every chain the **Safe Singleton Factory** reached; hand-maintained (NOT synced by `sync:frontend-contracts`); all verified live. `CUSTODY_SUPPORTED_CHAIN_IDS` derives from this map |
| **Across V3 SpokePool** | 1 `0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5`; 10 `0x6f26Bf09B1C792e3228e5467807a900A503c0281`; 137 `0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096`; 8453 `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64`; 42161 `0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A` | those five | `frontend/src/config/networks.js:620,683,740,788,854-857`; mirrored as `acrossSpokePool` in each `deployments/*-v2.json` | `bridge` in networks.js is a **build-time display fallback only**; the authoritative address, routes, limits and pause state are read from the on-chain `BridgeRouter` |
| **Across HubPool** | `0xc186fA914353c44b2E33eBE05f21846F1048bEda` | **Ethereum 1 only** | `frontend/src/config/networks.js:854-857`; `acrossHubPool: null` in every other deployment record | An L1 contract by design. `addLiquidity` has **no recipient parameter**, so bridge-LP deposits are a direct member call that never touches a FairWins contract — do not copy this address to an L2 |
| **Uniswap V3** | Canonical set (1, 10, 137, 42161): `factory 0x1F98431c8aD98523631AE4a59f267346ea31F984`, `swapRouter 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`, `quoter 0x61fFE014bA17989E743c5F6cB21bF9697530B21e`, `positionManager 0xC36442b4a4522E871399CD717aBDD847Ab11FE88`. **Base 8453 differs**: `factory 0x33128a8fC17869897dcE68Ed026d694621f6FDfD`, `positionManager 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1`, `quoter 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` | 1, 10, 137, 8453, 42161 | `frontend/src/config/networks.js:214-219` (`CANONICAL_UNISWAP`), `:742-747` (Base); `uniswapFactory`/`uniswapPositionManager` in `deployments/{polygon,optimism,base,arbitrum}-*.json` | "Addresses are NOT identical across chains… Never copy an address from one chain to another." `scripts/ops/verify-protocol-addresses.js` re-checks bytecode |
| **ETCswap V3** (Uniswap fork) | ETC 61 defaults: `quoter 0x4d8c163400CB87Cbe1bae76dBf36A09FED85d39B`, `positionManager 0x3CEDe6562D6626A04d7502CC35720901999AB699` (factory/router from env) | 61, 63 (env-driven, null when unset) | `frontend/src/config/networks.js:507-516` | ETC/Mordor have **neither Across nor Uniswap** and cannot host the spec-067 routers |
| **ERC-4626 vaults (Morpho)** | **No addresses in config by design** — the vault list comes from the Morpho data API; only `merklDistributor 0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae` (Merkl's canonical claim contract, same address on every chain it supports) and `legacyRewardsUrl` are config-fixed | `earn` block present on **1 + 137** only (and 80002 under `E2E_AMOY_LOCAL`) | `frontend/src/config/networks.js:69` (`MERKL_DISTRIBUTOR`), `:79-83` (`earnConfig`), `:622,859` | `FeeRouter.depositToVaultWithFee` takes the vault as a parameter and forwards into `IERC4626` — `contracts/fees/FeeRouter.sol:7`. The local E2E stand-in is `contracts/mocks/MockERC4626Vault.sol` |
| **USDC / USDT / stablecoins** | Native USDC: 1 `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, 10 `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`, 137 `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`, 8453 `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 42161 `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, 80002 `0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582`. USDT (1) `0xdAC17F958D2ee523a2206206994597C13D831ec7`. Mordor 63 **Classic USD (USC)** `0xDE093684c796204224BC081f937aa059D903c52a` | — | `frontend/src/lib/screening/sources.js:82-90` (issuer list, native issuers only); `paymentToken` in each `deployments/*-v2.json`; `stablecoin` blocks in `networks.js` (e.g. `:840-846`) | Wrapped native: `wmatic` 137 `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270`, 63 `0x1953cab0E5bFa6D4a9BaD6E05fD46C1CC6527a5a`, 80002 `0x0ae690AAD8663aaB12a671A6A0d74242332de85f`; WETH (1) `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` (`networks.js:850`) |
| **Chainalysis Sanctions Oracle** | `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` on 1, 10, 137, 42161; **Base 8453 differs: `0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B`** | those five | `frontend/src/lib/screening/sources.js:63-71` (`CHAINALYSIS_ORACLES`); interface `contracts/interfaces/IChainalysisSanctionsOracle.sol` | Read via `isSanctioned(address)`. `SanctionsGuard` treats a configured-but-unreachable oracle as **deny-all**; an unset oracle (`address(0)`) means deny-list-only, the deliberate config on networks without it (Amoy uses `MockSanctionsOracle 0xa5F0bB3a63C55721078be5ee80653E9cB0927D9E`) |
| **Issuer freeze lists** | Circle `isBlacklisted` on the native USDC of 1/10/137/8453/42161/80002; Tether `isBlackListed` on mainnet USDT. **Different selectors that hash differently** | — | `frontend/src/lib/screening/sources.js:78-97` | Only **native** issuer contracts are listed — a bridged token (Polygon PoS USDT, Arbitrum bridged USDT) is a different contract with no freeze function and would report *unreadable* |
| **Polymarket CTF (Gnosis Conditional Token Framework)** | 137 `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`; 80002 mock `0x95F40ea10E6C51892783c4E7721Ada1425917e22` | 137 (80002 = `MockPolymarketCTF`) | `frontend/src/config/networks.js:609-612`; `polymarketCTF` in `deployments/{polygon,amoy,hardhat}-*.json` | `conditionId = keccak256(oracle, questionId, outcomeSlotCount)`; resolution `[1,0]`/`[0,1]` |
| **Polymarket CLOB / Gamma / Data** | **HTTP only — no on-chain address in this repo.** `gamma-api.polymarket.com`, `data-api.polymarket.com`; CLOB key + L2 creds are gateway-only secrets | 137 only (Predict hides off 137) | `services/relay-gateway/src/config/index.js:640-672`; `networks.js:611` | Builder code is `bytes32` env `POLYMARKET_BUILDER_CODE` (unset ⇒ orders post **unattributed**, never blocked); taker fee default 50 bps hard-capped 100, maker 0 capped 50 — out-of-range **fails boot** |
| **UMA Optimistic Oracle V3** | Address held **in the adapter's own state**, not in a config file | 137, 80002 | interface `contracts/interfaces/IOptimisticOracleV3.sol`; adapter `contracts/oracles/UMAOptimisticOracleV3Adapter.sol` | Local stand-in `contracts/test/MockOptimisticOracleV3.sol` |
| **Chainlink** (aggregators + Functions router) | Per-condition feed addresses in `conditions`/`allowedFeeds`; `router` is `immutable` on the Functions adapter | 137, 80002 | `contracts/oracles/ChainlinkDataFeedOracleAdapter.sol:26-30`; `ChainlinkFunctionsOracleAdapter.sol:28` | `@chainlink/contracts` is **pinned exactly** — a floating 1.3.0→1.5.0 changed this adapter's bytecode (`CLAUDE.md` spec-075) |
| **Perps venues** (read-only, spec 082) | Gains diamond: 42161 `0xFF162c694eAA571f685030649814282eA457f169`, 8453 `0x6cD5aC19a07518A8092eEFfDA4f1174C72704eeb`, 137 `0x209A9A01980377916851af2cA075C2b170452018`. GMX v2 (**Arbitrum only**): `exchangeRouter 0x7dE39FF2e232A2203196788d37e234cF8F1b83f1`, `router 0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6` (approval target), `reader 0xfA26cBb46e2614609406de08CA1Dc7f70a684184`, `dataStore 0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8`, `orderVault 0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5`, `eventEmitter 0xC8ee91A54287DB53897056e12D9819156D3822Fb`, `referralStorage 0xe6fab3F0c7199b0d34d7FbE83394fc0e0D06e99d`. **Hyperliquid: no address — non-EVM** | 42161, 8453, 137 | `frontend/src/config/perps.js:106-110,129-137` | "a GMX entry for any other chain would be a fabricated address" |
| **Staking (local E2E stand-ins only)** | Lido `steth 0x82e01223d51Eb87e16A03E24687EDF0F294da6f1`, `wsteth 0x2bdCC0de6bE1f7D2ee689a0342D76F52E8EFABa3`; sPOL `token 0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650`, `controller 0xc351628EB244ec633d5f21fBD6621e1a683B1181`; Polygon `stakeManager 0xFD471836031dc5108809D173A067e8486B9047A3` | **local E2E node only** (`E2E_AMOY_LOCAL`, `import.meta.env.DEV`-guarded) | `frontend/src/config/networks.js:145-190` (`localStakingConfig`) | Real mainnet staking config is declared per-network elsewhere; the `StakingRouter` itself is undeployed |
| **Semaphore / Poseidon** | Mordor 63 `semaphoreVerifier 0x3A6397C09A287A18af58Bd4711Aebd6c56467B6D`, `poseidonT3 0xC855eCa5f522Be73cEF1E3Db2bd1E66B2287e687` | 63 | `deployments/mordor-chain63-v2.json` | **Abandoned with the ZK pool design** — Semaphore was removed so ETC/Mordor could be unblocked |

---

## 6. Flags: undeployed, planned, legacy, or inconsistent

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | **`FundingPoolFactory` / `FundingPool` (spec 103)** | **Code complete, deployed nowhere.** No `fundingPoolFactory` key in any `deployments/*-v2.json`; `''` in the Mordor and Polygon client maps; registered in the storage gate and has a deploy script. Locally `deploy:local:funding` is the **last** step of `setup:e2e` (#1289) | `contracts/pools/FundingPoolFactory.sol`; `scripts/deploy/check-storage-layout.js:54`; `frontend/src/config/contracts.js` |
| 2 | **`StakingRouter` (spec 066)** | **Undeployed everywhere** (`''` in every map that declares it), yet two of its fee services (`stake.lido`, `stake.polygon`) are registered on the FeeRouter | `contracts/staking/StakingRouter.sol`; `feeServices.js:24-25` |
| 3 | **`StandardDAOFactory`** | Undeployed; and on **Mordor it never will be** — pre-Cancun EVM cannot run OZ 5.4.0 `Governor` (`MCOPY`), issue #1268. The absence is the answer | `frontend/src/config/contracts.js:43-47` |
| 4 | **`p256Verifier`** | Recorded as `null` on all eight chains — slot written down, never deployed | `deployments/*-v2.json` |
| 5 | **`CallsignRegistry`** | **Polygon 137 only.** Mordor + Amoy carry `''`; frontend soft-fails to raw addresses / ENS when undeployed | `frontend/src/config/contracts.js` |
| 6 | **`WagerRegistryIntents` missing on Amoy** | 137 and 63 record the facet; **80002 does not** — the testnet membership chain has no gasless twin facet. Self-submit is unaffected (never-stranded), but a gasless intent there has no target | `deployments/amoy-chain80002-v2.json` vs `polygon-`/`mordor-` |
| 7 | **`FeeRouter` absent on ETC 61** | 61 has custody + account stack only; no fee router, no bridge/liquidity routers (neither Across nor Uniswap exists there) | `deployments/etc-chain61-v2.json` |
| 8 | **`bridge-and-liquidity.md` is stale** | Says "neither router is deployed on any network yet (#966)"; both are recorded on all five EVM mainnets. The open half of #966 is the **admin handoff off the deployer EOA** — treat `DEFAULT_ADMIN_ROLE` there as a single hot key | `docs/developer-guide/bridge-and-liquidity.md:25` vs `deployments/*-v2.json`; `CLAUDE.md` |
| 9 | **Mordor unrecorded-authority write-off** | 23 unrecorded Mordor contracts, ~60 sole-held roles and 62 Ownable owners still held by the compromised deployer EOA — deliberately abandoned. Do not depend on them; do not read their state as trustworthy | `deployments/mordor-chain63-v2.json` `legacyContractsWriteOff` |
| 10 | **Treasury on 1/10/8453/42161** | Still the **superseded** admin Safe `0x8cc564E3…c3fa`, whose owner set is documented as having included a compromised hot EOA + a Polygon-only passkey contract | `deployments/{mainnet,optimism,base,arbitrum}-*.json` vs `deployments/admin-safe.json` |
| 11 | **`FriendGroupMarketFactory` (v1)** | **Legacy.** Source only in `contracts-archive/`; no live network configures its address; retained in the client only as a deploy-block + explicit legacy fallback in ledger/report/stats readers | `contracts-archive/markets/FriendGroupMarketFactory.sol`; readers listed in §1.10 |
| 12 | **Semaphore/ZK wager pools** | Abandoned on Mordor; addresses recorded but "intentionally NOT wired here" | `frontend/src/config/contracts.js:48-51` |
| 13 | **Sepolia 11155111 / Hoodi 560048** | In `NETWORKS` but in **no** `NETWORK_CONTRACTS` entry — zero contracts, no subgraph | `frontend/src/config/networks.js:897,974`; `contracts.js:370-381` |
| 14 | **Amoy mocks** | `mockPolymarketCTF 0x95F40ea1…7e22`, `mockSanctionsOracle 0xa5F0bB3a…7D9E` are recorded on the testnet membership chain — real reads, mock upstreams | `deployments/amoy-chain80002-v2.json` `mocks` |
| 15 | **Planned, not built** | FinOps catalogues `miniapp licenses` and `wager platform fee` as `planned` — "exist NOWHERE (no contract has a fee)". Perps **execution** is FR-018-barred (read-only; an execution wrapper is a follow-up spec) | `CLAUDE.md` spec-089 / spec-082 guardrails |
| 16 | **Address collisions across chains** | Nonce-derived reuse means the same literal names different contracts on different chains (Ethereum's `liquidityRouter` proxy == the BridgeRouter proxy address on 10/8453/42161). Never carry a label across a chain boundary | `scripts/deploy/check-storage-layout.js:118` |
