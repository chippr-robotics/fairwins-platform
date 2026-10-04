# Changelog

**This file is generated.** Entries are written by `.github/workflows/release.yml` at release time
from the classifications carried on merged pull requests (spec 076). Do not hand-edit it — a
hand-written entry will be overwritten by the next release, and a hand-written version number is
rejected outright by the version gate.

Versions follow the scheme in
`specs/076-monorepo-semantic-versioning/contracts/version-scheme.md`, which defines what
"breaking" means in this repository rather than leaving it to judgment.

Release candidates (`vX.Y.Z-rc.N`) are cut from `staging` and are not recorded here; only published
production releases are.

<!-- RELEASES:START -->

## v1.19.0 — 2026-09-22

Promoted from: v1.19.0-rc.33
Previous release: v1.18.0 · Range: `v1.18.0..v1.19.0` (212 commits)

### 🚀 Features

- feat(110): the wager list is the estate, and the action goes to the wager's chain
- feat(110): the hardware signer on viem, with the emulator as its oracle
- feat(110): the local-key rail — legacyKeys off ethers, and three divergences
- feat(110): the ethers-shaped signer, on viem — built and proven, not yet wired
- feat(110): T027 — the intent rail signs the chain it names
- feat(110): T024 — submitOn, the one place a write names its chain
- feat(110): two BIP-39 files leave ethers, and the reason they could not was wrong
- feat(110): T020 — offline signature recovery leaves ethers, staying synchronous
- feat(110): the legacy v1 event source scans through logScan
- feat(110): both custody policy engines read on a named chain
- feat(110): the liquidity and quote fixtures decode with viem
- feat(110): the Supply surface and the acceptance page read on a named chain
- feat(110): bridge status reads both chains through the chain seam
- feat(110): a vault's queue reads each network by name, not by connection
- feat(110): the Safe transaction encoders leave ethers
- feat(110): GMX calldata and the DataStore read leave ethers
- feat(110): the GMX stuck-order fold reads on a named chain
- feat(110): the perps entry and position sheets read on a named chain
- feat(110): convert the Gains venue encoder and the Control Room pause sweep
- feat(110): the Predict approval check names its chain and keeps its injection seam
- feat(110): the bridge and supply routers' authority read names its chain
- feat(110): move the notification sources onto the chain seam
- feat(110): move the wager registry RPC source and the swap quote onto the seam
- feat(110): the sanctions pre-check reads a chain it was TOLD, not one it asked the wire for
- feat(110): move the mini-app registry catalog reads onto the chain seam
- feat(110): move address screening, membership reads and tier prices onto the seam
- feat(110): move the Across LP client, curator authority and swap balances onto the seam
- feat(110): encode and decode the batched balance reads with viem
- feat(110): move the estate authority read and the stats hooks onto the chain seam
- feat(110): move staking, platform fees and the tax report onto the chain seam
- feat(110): convert the registry-metrics, treasury-stats and perps-positions hooks
- feat(110): convert the liquidity router and Uniswap position libs onto the seam
- feat(110): convert the bridge router lib onto the seam; normalizeAbi learns ethers tuple syntax
- feat(110): convert custody transfer building, proposal describing and vault proposal reads
- feat(110): eventScanHandle — the seam's twin of Contract for logScan callers
- feat(110): convert the fee estate and earn notification reads onto the seam
- feat(110): convert perps venue status and portfolio prices onto the read seam
- feat(110): viem-side test seam + first read-path conversions (callsigns, perps fee units)
- feat(110): the viem read seam — getPublicClient(chainId) + readContract(chainId, …)
- feat(110): Phase 0 — pure-util codemod to viem, ethers import ratchet, viem as a host shared module
- feat(finops): catalogue The Graph, and split the modeller it exposed
- feat(finops): catalogue Pinata, with a read-scoped key that is not the pinning JWT
- feat(109): rank the token-news card instead of listing it

### 🐛 Bug Fixes

- fix(1628): the FinOps gate suite races itself across test files
- fix(1628): subgraph deploy scripts target the slugs that actually serve
- fix(1628): step 1 of the WIF recovery is a replace, not an additive grant
- fix(1628): the rename recovery must not widen the apply identity
- fix(1628): the rename broke GCP Workload Identity Federation — repoint it and document recovery
- fix(110): the re-entry must be declared after the ref it reads, and read a live signer
- fix(110): settle on both paths, and arm the re-entry before the await
- fix(110): never broadcast with the pre-switch signer, and don't read a chain we can't reach
- fix(110): the modal was filtering the estate back down to the wallet's chain
- fix(085): argv arrays instead of shell strings, and drop a no-op replace
- fix(110): the provider is handed to OTHER libraries, so its surface is theirs
- fix(110): the wallet signer must report the chain it was BUILT for
- fix(110): the viem transport retried where ethers made one request
- fix(110): StakingTab's pause and address forms were dead — write() became a function
- fix(110): a focus assertion that pinned an instant, not an outcome
- fix(110): a viem error hides the revert bytes behind `cause`
- fix(110): parseUnits rounded what ethers refused — a silent amount change
- fix(110): freeze the mnemonic fixtures — the test was flaky 1 run in 15
- fix(110): restore the mnemonic refusal, and retire a twice-wrong allowlist reason
- fix(110): divergence 13 — decoded error args lose their names on viem
- fix(110): T026a follow-up — the unified wrap refusal, pinned where it can fail early
- fix(110): T026b — sendCalls refuses a chain it cannot be pinned to
- fix(110): T026a — the fourth settle loop had the check the other three lacked
- fix(ci): give the fast E2E tier the Cypress binary guard the other tiers have
- fix(110): a log scan's head must never come from viem's block cache
- fix(e2e): give FEE-01's deposit confirmation the 90s it was written to have
- fix(screening): the source list scrolls instead of outgrowing the modal it opens in
- fix(screening): an unreadable list gives a member a sentence, not a library's diagnostic
- fix(110): restore parameter names on multi-output reads — an empty list is not "you have none"
- fix(110): units seam emitted a decimal point at zero decimals, where ethers emits none
- fix(docs): name the search dialog and adopt the contrast-safe token export
- fix(finops): bound the boot fan-out, and pace outbound RPC
- fix(finops): QuickNode reports data.credits_used, which we never asked for
- fix(finops): C6 matches a parsed HOST, not a substring of the file
- fix(finops): the exporter never listened, so every panel read "no data"
- fix(security): a green dry run is not a working credential (X-08)
- fix(security): only a plan merged on staging may be applied (X-07)
- fix(security): the #1520 dismissal reasoning was wrong about why
- fix(address-book): one book per panel, and a status role on the loading tag
- fix(address-book): export/import in plain text, on every account type
- fix(1562): point the Cypress ETC stubs at the endpoint the app now resolves
- fix(1562): hoist the service worker's same-origin check out of the fetch handler
- fix(1562): four production console defects — dead ETC RPC, SW undefined-Response, unmapped STAKING_ADMIN, aria-hidden over focus
- fix(087): run the staging services as an account that can do nothing

### ♻️ Refactoring

- refactor(110): ban the ambient chain — 17 useChainId call sites to 0
- refactor(110): WalletContext hands out the viem-backed signer
- refactor(110): the endgame is three files, and one of them was never mounted
- refactor(110): blockchainService off ethers, and four paths nobody calls
- refactor(110): My Wagers off ethers, and `toMatch(/^0x/)` is not an assertion
- refactor(110): the acting-account seam and account recovery, with the tests they lacked
- refactor(110): DexContext off ethers, and a spec-069 bypass on the cross-chain quote
- refactor(110): the accept modal off ethers, closing the loop on its own test
- refactor(110): friend-market creation off ethers — 736 lines, five rails, no new divergence
- refactor(110): open challenges off ethers, and the divergence that costs nine sentences
- refactor(110): transfers off ethers, on the first money path to use the new read routing
- refactor(110): vouchers off ethers, and the overload that viem will not name
- refactor(110): wager pools off ethers — the deferral's trigger, one batch later
- refactor(110): funding pools off ethers — the deferral's own trigger, fired
- refactor(110): useNullifierContracts, and the read seam finally gets a test
- refactor(110): useVaultProposals off ethers, and the custody writes get a test
- refactor(110): the last three admin tabs, and a history scan that failed silently
- refactor(110): ProtocolConfigTab + OracleAdaptersTab, and viem refuses Uint8Array for bytes
- refactor(110): CallsignRegistryAdmin off ethers, and give the read path a test
- refactor(110): MembershipRevenueApp off ethers, and two flaws in my own new tests
- refactor(110): AccessControlApp off ethers — the role grants
- refactor(110): the spec-067 router pair off ethers, and viem is stricter on bool
- refactor(110): three small admin files, and a spec-069 bypass on two pause dashboards
- refactor(110): take the FeeRouter cluster off ethers, and fix a two-chain read
- refactor(110): lift getLogsRange out of the DAO connector it never belonged in
- refactor(110): T028 batch 10 — SubmitAppPanel, and a mock pattern worth naming
- refactor(110): T028 batch 9 — CallsignPanel, with both read shapes measured first
- refactor(110): T028 batch 8 — MiniAppReviewTab, and a mock that had been retired
- refactor(110): T028 batch 7 — claim-code derivation, and fixtures that freeze it
- refactor(110): T028 batch 6 — a viem parseError, without touching revertError
- refactor(110): T028 batch 5 — the passkey envelope, and a primary type that is inferred
- refactor(110): T028 batch 4 — the other two EIP-3009 paths onto the shared split
- refactor(110): T028 batch 3 — one signature split, and the money path off ethers
- refactor(110): T028 batch 2 — proposalHub off ethers, one encoder per call
- refactor(110): T028 batch 1 — delete a dead crypto module, convert two more
- refactor(110): T026 — one settle loop, and a personal send that names its chain
- refactor(110): T025 — the write rail is a chain question, not a custody one
- refactor(110): encode the group-pay transfers with viem
- refactor(110): hash the pool payout matrix with viem, and name what cannot be converted

### 📚 Documentation

- docs(1628): run step 2 of the WIF recovery before step 1
- docs(1628): the MCP config example shows the clone path under its current name
- docs(1628): finish the Tier B sweep. Close the misses that change behaviour
- docs(1628): follow the repo rename through — Tier B URLs, and correct the README pin
- docs(1613,1617): stop claiming these contracts are audited, and name the repo honestly
- docs(110): record what the T028 endgame actually owes, measured
- docs(110): record the clearpath connector deferral and why it is different
- docs(110): divergence 14 — an indexed log topic comes out in the wrong case
- docs(110): the no-chain E2E tier runs locally in ~90 seconds
- docs(110): record why keyRegistryService is deferred, not converted
- docs(110): record the mnemonic-validation trap before T022 is attempted
- docs(110): actually apply the BIP-39 correction to tasks.md
- docs(110): close out Phase 1 and record what de-risks T020
- docs(110): record what blocks the last read-path conversion
- docs(110): record Phase 1 progress and the two decoder differences in tasks.md
- docs(site): keep the dark toggle — the export now scopes the palette per scheme
- docs(site): adopt the Chippr brand tokens and self-hosted faces
- spec(110): plan and tasks — chain-abstracted writes on a single EVM seam
- spec(110): name the phase sub-issues in the delivery assumption
- spec(110): reserve — multichain-write-seam
- docs(architecture): add the architecture workbook — three views and six annexes
- docs(architecture): scaffold the architecture workbook index
- docs: only ONE of the two saved-contact pickers was migrated in #1458
- docs: spec-021 FR-032 was never missing — it is spec 067's

### 🧪 Tests

- test(110): one refusal sentence, proven across surfaces — and a fifth private copy
- test(085): drive the hardware signer against real Ledger firmware, and fix what it found
- test(110): the nonce floor is per (account, CHAIN), asserted rather than read
- test(110): make the retired-mock class a gate instead of a discovery
- test(callsigns): re-point the co-located resolveCallsign harness at the read seam
- test(e2e): widen the DSH-10 banner wait again — the role sweep it depends on tipped 30s
- test(perps): anchor the phase-0 read-only assertion on the row, not the header
- test(security): keep a test title out of the import scanner's path
- test(1562): size DSH-10's wait to the sequential role sweep it actually waits on

### 🏗️ Infrastructure

- ci(085): least-privilege token on the hardware-emulator workflow
- build(gateway): pin finops-52fdb6e2 — the two fixes the working image exposed
- build(deps): refresh the lockfile and re-record the mini-app byte baseline
- build(deps): refresh the lockfile and re-record the mini-app byte baseline
- build(gateway): pin the first finops image that actually serves
- ci(finops): smoke the exporter image, and require it to still be alive after

### 🧹 Maintenance

- chore(1628): record bootstrap state after the WIF repoint
- chore(110): delete useTreasuryVault — dead code for an archived contract
- chore(security): declare and execute the OpenZeppelin alert dismissals
- chore(deps): Bump @uniswap/sdk-core from 7.19.1 to 7.19.2
- chore(deps): Bump viem from 2.56.0 to 2.56.3
- chore(deps): Bump @capacitor/core from 8.5.0 to 8.5.1

### Artifacts

Range: `v1.18.0..v1.19.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | moved | `api-access` v1.0.2<br>`clearpath` v1.2.1<br>`token-mint` v1.0.3 |
| Subgraph endpoint | moved | `v0.3.0` |

### Native channel artifacts (v1.19.0)

| Channel | Artifact | SHA-256 | Signed |
|---|---|---|---|
| android | `FairWins-v1.19.0.aab` | `5a247ddf5d6a4009774ab967b2bad2b1c6bf7b5bf1c12a08fa1cafbdf3996db0` | yes |
| ios | `FairWins-v1.19.0-ios.xcarchive.zip` | `5549052aea8ed6cd1c258562bd31d98bc600de32d63039a1b4e0cc4930a495ea` | no — operator signing ceremony (see docs/runbooks/native-release-operations.md) |

## v1.18.0 — 2026-09-08

Promoted from: v1.18.0-rc.26
Previous release: v1.17.0 · Range: `v1.17.0..v1.18.0` (100 commits)

### 🚀 Features

- feat(1378): declare the Android upload-key reader, scoped to exactly two secrets
- feat(finops): the nonce signal actually emits, and gains the demand to read it against
- feat(109): enable token news on the gateway, and make the rollout order safe
- feat(109): closers — FinOps entry, e2e coverage, docs (Phase 6)
- feat(109): assistant get_token_news tool (US3)
- feat(109): trade-pair news feed (US2)
- feat(109): portfolio token news card (US1)
- feat(109): gateway news read-proxy and curated asset-news mapping seam
- feat(finops): observe the executor's NONCE, because balance cannot see a stall
- feat(screening): screen an entered address against every list on every cohort chain (#1458)
- feat(passkey): enumerate creation nonces so leg A can find a retried account
- feat(108): multi-currency wrap/unwrap — the asset is the entry point
- feat(ops): measure deploy blocks from public sources, and record accountFactory

### 🐛 Bug Fixes

- fix(screening): make the estate screen readable on testnet, and the notice legible
- fix(109): report the news module in /status so the pre-pin check can run
- fix(perps): hold the market controls to the 36px floor the comment claims
- fix(perps): collapse the market filters so the table gets the viewport
- fix(109): make the token-news e2e spec actually run
- fix(passkey): the bundler list finally submits through more than its first entry
- fix(109): check news liveness before validation, and pin the order
- fix(payments): withdraw the multi-recipient affordance from the send surfaces
- fix(bundler): the single-alto gate enforced per-HOST a rule that is per-KEY
- fix(e2e-matrix): repoint spec-104 recovery rows at open tracker #1514
- fix(build): a build arg the Dockerfile never declares is silently dropped
- fix(106): `enforcing` is operator-only, and FR-015 moves to boot where it belongs
- fix(screening): the Unscreened sentence names uncovered networks even when sources existed
- fix(e2e-matrix): repoint the spec-104 gap rows at open tracker #1504
- fix(108): make the local wrapper real, settle on a verified signer, and keep a typed amount
- fix(ops): validate the address and topic before they reach a URL
- fix(ops): stop building regexes from --contract (CodeQL, 2 high)
- fix(e2e): fast/48 tests the cohort the fast build actually resolves
- fix(e2e-matrix): spec-108 rows use the declared risk enum
- fix(e2e-matrix): repoint spec-105 partial rows at open tracker #1494
- fix(ci): gh issue close has no --comment-file flag

### 📚 Documentation

- docs(109): fix two spec comments left describing the replaced stub
- docs(109): correct why the e2e spec stubs every provider host
- spec(109): tasks — dependency-ordered task list for token news
- spec(109): address review — concrete SC-005 bound, story-vs-issue priority note
- spec(109): specify — token news on portfolio and trade surfaces
- docs(G-11): the rule was about a service name; the invariant is about a key
- spec(109): reserve — token-news
- docs(bundler): three documents that would cause the incident they warn about
- docs(research): evaluate issue #1465 (token news + agent context) against the estate
- docs(107): the keyed RPC access runbook, written from the live-fire run
- docs(108): actor-critic screenshots (round 1 clean) + lint-clean return
- docs(108): plan, research, data model, quickstart, tasks
- spec(108): keep matrix.json's original unicode escaping
- spec(108): reserve — multi-currency-wrap

### 🧪 Tests

- test(recover): keep the real ethers around the Contract stub
- test(109): the MCP server serves nine tools, not eight
- test(e2e): MS-06 scrolls the pill's details into view before asserting on them
- test(108): e2e for the multi-currency picker + cross-chain submit, docs
- test(api-access): the unreachable arm must leave chain height readable, or nothing ever recovers
- test(api-access): stub BOTH provider rungs in API-05's unreachable arm

### 🏗️ Infrastructure

- ci: gate dependency vulnerabilities instead of only reporting them

### 🧹 Maintenance

- chore(1378): create the Android upload-key reader identity
- chore(109): pin the gateway image that actually carries the news module
- chore(native): sync the shells to v1.17.0 — ported base-branch fix
- revert(e2e): drop the superseded API-05 alias/wait delta — branch now matches staging

### Artifacts

Range: `v1.17.0..v1.18.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | moved | `amoy-chain80002-v2/membershipManagerImpl` → `0xb6499596703cEE6eA4BE5b5F01DEc4d7ccfe10bD`<br>`amoy-chain80002-v2/wagerRegistryImpl` → `0xa2176F5Fea39888cD1697Be4651415490C78905d`<br>`amoy-chain80002-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`arbitrum-chain42161-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`arbitrum-chain42161-v2/bridgeRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`arbitrum-chain42161-v2/liquidityRouterImpl` → `0x7Af46728e7C969b75723398e3F93b565E968A3ba`<br>`arbitrum-chain42161-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`base-chain8453-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`base-chain8453-v2/bridgeRouterImpl` → `0x41ba6bcA216bd6A4c5A0Bf8F9b2d682ec0a879D5`<br>`base-chain8453-v2/liquidityRouterImpl` → `0x7Af46728e7c969b75723398E3f93b565E968A3bA`<br>`base-chain8453-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`etc-chain61-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mainnet-chain1-v2/feeRouterImpl` → `0x5cCd55D62Ce7Df730c39543B332dD8d6054B5d00`<br>`mainnet-chain1-v2/bridgeRouterImpl` → `0xcA277Cc3485Da12771d6171a9D0A894B8DD159f8`<br>`mainnet-chain1-v2/liquidityRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`mainnet-chain1-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mordor-chain63-v2/membershipManagerImpl` → `0x7D38F7Ef26f7E2409d5C04a62c1d9A3Ec002A49e`<br>`mordor-chain63-v2/wagerRegistryImpl` → `0x9FfE701be18Ff033706f2df19cd8730F5CB884B2`<br>`mordor-chain63-v2/tokenFactoryImpl` → `0x135108EB6f81e361b6cF131d2Cb9A01E92Cd8ED9`<br>`mordor-chain63-v2/openERC20Impl` → `0xd8E67C6C058a6D35E69c691B44b8D5f858591971`<br>`mordor-chain63-v2/openERC721Impl` → `0x02819fd0d338F4C3FC58E6d9aF299ACA75d624BB`<br>`mordor-chain63-v2/restrictedERC20Impl` → `0x0dD67E2af8Ad301a3B5308c2AD41CCb2220b0444`<br>`mordor-chain63-v2/openERC20V2Impl` → `0x92169007926fBc8Ac90cdD311dD3C2557158C395`<br>`mordor-chain63-v2/openERC721V2Impl` → `0xEeaBC05214FF0C42cbA42b365aB400b7ca4311cE`<br>`mordor-chain63-v2/restrictedERC20V2Impl` → `0x664d87bed13ea4D50Cd3da8e0aC5A8D70A302A0B`<br>`mordor-chain63-v2/externalDAORegistryImpl` → `0x28270cB71E87D2D6C662e61CFE6eD02d05d43B7A`<br>`mordor-chain63-v2/zkWagerPoolFactoryImpl` → `0xd3e851FDDa9D5796D503daFd34b2403D7336d9fD`<br>`mordor-chain63-v2/poolImpl` → `0xd0b94a77DA7Aaa488343CF89978f1Bbf9E72E277`<br>`mordor-chain63-v2/wagerPoolFactoryImpl` → `0xfB6F9F7EfD86a220eE1aD7906278247051B25430`<br>`mordor-chain63-v2/feeRouterImpl` → `0x744b8E56d84bb8D7657b2Bb13426cB882c93B7E6`<br>`mordor-chain63-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mordor-chain63-v2/miniAppRegistryImpl` → `0xc8Dd8601b35aDa3AF367C9E41f24Fd0503Ced674`<br>`optimism-chain10-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`optimism-chain10-v2/bridgeRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`optimism-chain10-v2/liquidityRouterImpl` → `0x7Af46728e7C969b75723398e3F93b565E968A3ba`<br>`optimism-chain10-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`polygon-chain137-v2/membershipManagerImpl` → `0x7177470fE3c5D89CEf965A596540E57cE290C939`<br>`polygon-chain137-v2/wagerRegistryImpl` → `0x9c52C1ef4Bbe65CF19a5C26bebD4A22100964898`<br>`polygon-chain137-v2/tokenFactoryImpl` → `0xE819f7b672D81A8b78d40b1C99Fe5d646513D12C`<br>`polygon-chain137-v2/openERC20Impl` → `0xd8E67C6C058a6D35E69c691B44b8D5f858591971`<br>`polygon-chain137-v2/openERC721Impl` → `0x02819fd0d338F4C3FC58E6d9aF299ACA75d624BB`<br>`polygon-chain137-v2/restrictedERC20Impl` → `0x0dD67E2af8Ad301a3B5308c2AD41CCb2220b0444`<br>`polygon-chain137-v2/wagerPoolFactoryImpl` → `0x754d8aa4785Ec4bEE7c921f8d032D5E3a78d9308`<br>`polygon-chain137-v2/poolImpl` → `0xB153e4456FaD1A7E96e35e14094Cf6964348BC40`<br>`polygon-chain137-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`polygon-chain137-v2/callsignRegistryImpl` → `0xD220D34ed2148B9F4DC65C1bc75169D7DECFBB49`<br>`polygon-chain137-v2/feeRouterImpl` → `0x40ee755246E60f66E7bA425F99C6d704859d38db`<br>`polygon-chain137-v2/bridgeRouterImpl` → `0x8F7A7e7437733326BD2F8045BFceD9B821aF1De1`<br>`polygon-chain137-v2/liquidityRouterImpl` → `0x33818052Ca8B5b8Bb9777Bf6eBbaFCD8Faae6e65`<br>`polygon-chain137-v2/miniAppRegistryImpl` → `0x41858006aD6dd0788b84F9fb17A28d8167C7b331` |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

### Native channel artifacts (v1.18.0)

| Channel | Artifact | SHA-256 | Signed |
|---|---|---|---|
| android | `FairWins-v1.18.0.aab` | `c5c94a1ce6687074680c4d07495f4f3cb704329334f7478fe61a0862e7541a89` | no — operator signing ceremony (see docs/runbooks/native-release-operations.md) |
| ios | `FairWins-v1.18.0-ios.xcarchive.zip` | `482b766e650ae967db6471a9a4c55ae03d856424ce15da1576dd6b9d3112a2d4` | no — operator signing ceremony (see docs/runbooks/native-release-operations.md) |

## v1.17.0 — 2026-09-06

Promoted from: v1.17.0-rc.24
Previous release: v1.16.1 · Range: `v1.16.1..v1.17.0` (117 commits)

### 🚀 Features

- feat(107): the wagmi rail rides issued access, and degradation gets its sentence
- feat(107): deliver the issuance credentials, adopt the key, arm observe mode
- feat(105): usage gets a kind, the catalogue gets the gateway, and a gate catches its author
- feat(105): say what is enforcing, fail what would publish, write it down
- feat(105): SIGHUP reloads the operational switches; SIGUSR2 keeps its meaning
- feat(105): proof of human — a challenge buys throughput, never entry
- feat(106): the client half — issued access, held in memory, injected per request
- feat(106): the issuance route, dormant until an endpoint exists
- feat(ci): close issues on staging merge, and skip the E2E tiers for inert changes
- feat(process): coordinated multi-agent development flow (#1460)
- feat(105): bound each upstream before the call, not after
- feat(105): enforce route minimums, behind a second switch
- feat(105): prove control of an account without demanding a purchase
- feat(105): resolve who is calling, and deliberately enforce nothing yet
- feat(105): queue readability, load-sheet polish, retired wizard, suites migrated
- feat(105): details is one card — network rows, shared facts with named drift, inline deploy-later
- feat(105): four-sheet guided creation flow + deployment orchestrator hook
- feat(105): creation records, semantic rules realization, deployment core, proposal decode
- feat(assistant): Assistant tab in Tools, provider chooser, GutterToken key surfaces (spec 104 WP-C)
- feat(assistant): provider seam, GutterToken client, key store and client-side tool loop (spec 104 WP-B)
- feat(assistant): gateway tool loop, MCP snapshot parity, legal/FinOps/tenant/docs (spec 104 WP-A/WP-D)
- feat(assistant-contract): prompt, tool table and honest result helpers
- feat(assistant): scaffold spec 104 — assistant-contract workspace package + spec artifacts
- feat(104): look a passkey's account up, never derive one and hope
- feat(passkey): name a saved passkey after the account it signs for (#1425)

### 🐛 Bug Fixes

- fix(e2e): the multi-network coverage rows cite an OPEN tracker again
- fix(rpc): a FallbackProvider that lost both rails once was dead until reload
- fix(ci): drop codeql.yml's base-branch filter on pull_request
- fix(e2e): stub BOTH rpc rails — the drpc failover was answering for a 'failed' chain
- fix(ci): declare CodeQL's languages instead of letting it infer Swift
- fix(ansible): converge the legacy Docker repo entry away instead of colliding with it
- fix(ansible): the per-node playbooks could not see group_vars
- fix(ci): close-linked-issues used a gh flag that does not exist
- fix(membership): bound the membership read so "unreadable" is reachable
- fix(custody): address every propose-mode install call — the hub emit leaked its sendCalls shape
- fix(107): unused param the full-suite lint caught and scoped runs cannot
- fix(106): the new spec-registry gate is right, and this branch yields the number
- fix(ci): a closing keyword only counts at the start of a line
- fix(docs): a staging merge does not close an issue — closing is deliberate
- fix(specs): record the 104 collision the gate caught on its first CI run
- fix(106): the lockout was never real; the capacity ceiling is
- fix(105): quotas metered nothing, because callers chose their own key
- fix(pinata): the pin proxy was a wildcard into Pinata with ACAO:*
- fix(spa-image): copy @fairwins/assistant-contract into both build stages
- fix(assistant-tests): compare parsed URL origin, not a substring prefix
- fix(relay-gateway): reword a describe title the dependency scanner misreads
- fix(relay-gateway): copy @fairwins/assistant-contract into both image stages
- fix(e2e): drop the mainnet RPC stub — it broke the verify tests it never needed to touch
- fix(custody): choose the write rail by the signer, and stop the tick waiting on mainnet
- fix(104): offer a not-yet-deployed account instead of refusing it
- fix(104): make the recovery spec run, and stop two honesty bugs it exposed
- fix(release): sync the native shells into the release record (#1424)

### ⚡ Performance

- perf(1459): one multicall per chain, not one request per asset

### ♻️ Refactoring

- refactor(process): drop the status mirror; derive state from the repo (#1460)

### 📚 Documentation

- docs(membership): say what the sub-ceiling guarantees, not an ordering
- docs(custody): multi-network staging protocol, round-2 screenshot record, and a readable drift disclosure
- docs: the Projects v2 API is real, and GitHub's built-in workflows already move the board
- docs(labels): correct the stale labels-sync header (Copilot review)
- docs(106): the fan-out is the problem, not the plan
- docs(105): matrix rows + regenerated coverage doc, developer guide, guardrail, screenshots
- docs(105): T026-T028 done — quota re-keying landed
- docs(105): track the remaining slices as issues
- spec(105): research says three of my own assumptions were wrong
- spec(105): guided multichain vault creation — one vault, chosen networks
- docs(assistant): actor-critic screenshot record and spec-104 task closure (WP-F)
- docs(research): answer the GutterToken wallet sign-in question from the live signup flow
- docs(research): add Part II — the MCP server and a client-side tool loop
- docs(research): evaluate GutterToken as a member-paid assistant rail
- spec(105): keyed read capacity is issued at runtime, not compiled in
- spec(104): add the coverage matrix row for the new spec directory
- spec(105): authenticate the caller, not the network path
- spec(104): passkey account recovery — find the account, never guess it

### 🧪 Tests

- test(api-access): port #1484's API-05 fix so this PR can reach green
- test(membership): assert the ceiling's magnitude, not just its existence
- test(custody): give loadVault the same 60s card deadline the create flow already has
- test(custody): count the direct install's two Safe transactions in RL-01's nonce arithmetic
- test(custody): chain-judged rules-lane legs and the passkey one-batch create (spec 105)
- test(105): e2e migrated to the guided flow, new create-flow spec, queue/details cases
- test(e2e): spec-104 coverage rows and the two-rail assistant flows (WP-E)

### 🏗️ Infrastructure

- build(gateway): run the spec-106/107 gateway and finops images

### 🧹 Maintenance

- chore(assistant-contract): drop the hand-written version field
- chore(deps): bump @scure/bip39 from 2.3.0 to 2.4.0

### Artifacts

Range: `v1.16.1..v1.17.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

### Native channel artifacts (v1.17.0)

| Channel | Artifact | SHA-256 | Signed |
|---|---|---|---|
| android | `FairWins-v1.17.0.aab` | `4c7519f3e05d3a8051805914a1f87e39a4f36964435cdc3ee564dbff25a9d752` | no — operator signing ceremony (see docs/runbooks/native-release-operations.md) |
| ios | `FairWins-v1.17.0-ios.xcarchive.zip` | `61dd65c52114185f7bb80daab87f947a795da6f23c04836dfd53c04ef2789219` | no — operator signing ceremony (see docs/runbooks/native-release-operations.md) |

## v1.16.1 — 2026-09-04

Promoted from: none — released directly from main
Previous release: v1.16.0 · Range: `v1.16.0..v1.16.1` (8 commits)

### 🐛 Bug Fixes

- fix(passkey): report a credential mismatch out loud, and keep the signal off the bridge
- fix(passkey): fall back to the platform's own list when a pinned request goes unanswered
- fix(release): sync the native shells into the release record
- fix(passkey): never let an unanswered prompt lock a member out

### Artifacts

Range: `v1.16.0..v1.16.1`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

### Native channel artifacts (v1.16.1)

| Channel | Artifact | SHA-256 | Signed |
|---|---|---|---|
| android | `FairWins-v1.16.1.aab` | `3c0f9c219e78678374b93e233fc7c922e30f9ef51870a4e099f4cabb53966fce` | no — operator signing ceremony (see docs/runbooks/native-release-operations.md) |
| ios | `FairWins-v1.16.1-ios.xcarchive.zip` | `2baafb8aa55aa67611f26c8f1050ff3c31c1b6810adb480a6824b7d5aae309cd` | no — operator signing ceremony (see docs/runbooks/native-release-operations.md) |

## v1.16.0 — 2026-09-04

Promoted from: v1.16.0-rc.15
Previous release: v1.15.2 · Range: `v1.15.2..v1.16.0` (93 commits)

### 🚀 Features

- feat(custody): the vault queue can be re-read, and says so (spec 102)
- feat(custody): compact vault cards and the three-view vault sheet (spec 102)
- feat(custody): vault groups, cross-chain queue reads, load-all, acting identity follows the wallet (spec 102)
- feat(wallet): one display formatter for balances in Wrap, Transfer and the asset picker (spec 102 US7)
- feat(funding-pools): pool money toward a goal from Request ▸ Pool (spec 102)
- feat(097): provision per-chain QuickNode endpoints for the four EVM mainnets (#1403)
- feat(061): light up Bitcoin on the production gateway (#1393)
- feat(native): tenant native-identity proof and onboarding docs (spec 102, T029-T030)
- feat(native): universal/app links land on the linked surface (spec 102, T027-T028)
- feat(native): Ledger BLE rung behind the one hardware seam (spec 102, T024-T026)
- feat(release): native channel artifacts in the release chain (spec 102, T019-T023)
- feat(native): platform passkey bridge behind the credential seam (spec 102, T016-T018)
- feat(native): US1+US2 seams — capability notices, support floor, lifecycle app-lock (spec 102, T010-T015)
- feat(native): foundational seams — runtime, tenant identity, version sync, CSP parity (spec 102, T005-T009)
- feat(native): add Capacitor platforms and shells for iOS/Android channels (spec 102, T001-T004)
- feat(infra): adopt the numbered QuickNode multichain endpoints (#1378 E)

### 🐛 Bug Fixes

- fix(native): cold-start deep links, Android smoke as a file, and stale comments (#1421)
- fix(release): unblock the native channel gate, and check it before main (#1419)
- fix(custody): one queue row per proposal, whatever the scan returns (spec 102)
- fix(custody): an instance the list could not read gets an honest queue entry (spec 102)
- fix(custody): queue reads settle at a ceiling; cards carry a live pending count (spec 102)
- fix(recovery): give the unlocked legacy signer its own nonce count
- fix(e2e): passkey full-stack — lazy account reads, remove-by-index, testnet portfolio opt-in
- fix(funding-pools): judge deadlines by the chain clock; order e2e chain reads after the page renders
- fix(e2e): CORS front for alto, payment-token decimals in tier prices, RC-04 copy
- fix: close #1405 #1407 #1408 by implementation, and drive the tranche-1 tiers to green
- fix(e2e): fund the impersonated CREATE2 deployer by setBalance and cap the proxy tx gas
- fix(frontend): four production defects reported from the live node (#1392)
- fix: restore staging's gates — @solana-program/system 0.14.0 + native shells at v1.15.1 (#1396)
- fix(e2e): settle finite animations before the a11y scan (spec 094/102)
- fix(lint): repair the two errors the re-resolved eslint plugins surfaced (spec 102)
- fix(native): drop unused import in passkeyBridge test (eslint)
- fix(e2e): match the labels the rows actually render, and scroll the resolve control into view
- fix(api-access): derive introspection invalidation instead of scheduling it per keystroke
- fix(recovery): pin every sweep leg to one monotone fee schedule and stop trusting ethers' cached balance read
- fix(backup): settle the pointer write on the passkey rail; pin the e2e pointer read to one block

### 📚 Documentation

- docs(spec-102): round 6 screenshots — the queue's Refresh, both themes and widths
- docs(spec-102): record the queue re-read and what running the suite found
- docs(spec-102): actor-critic screenshot record, four rounds
- docs(097): correct the QuickNode endpoint facts against the Admin API
- docs(native): honest matrix rows, CLAUDE.md guardrails, verify pass (spec 102, T031-T033)
- docs(spec): task breakdown for native release channels (spec 102)
- docs(spec): plan native release channels — research, data model, seam contracts (spec 102)
- docs(spec): specify native release channels — iOS, Android, web (spec 102)

### 🧪 Tests

- test(custody): wait for the chain before reading CV-02's queue
- test(e2e): repair the on-chain custody specs against the vault sheet (spec 102)
- test(e2e): no-chain coverage for the vault sheet — VS-01…VS-10 + a11y (spec 102)
- test(custody): PolicyBadge suite fakes the card's queue read (spec 102)
- test(custody): drive the on-chain custody specs through the vault sheet; governance in Details (spec 102)
- test(funding-pools): reload before asserting the refund count the page could only learn on load
- test(e2e): compare BigInts explicitly in SU-01/SU-02 too
- test(e2e): compare BigInts explicitly in CD-01
- test(e2e): acting-account purchase and refusals (098), voucher send from portfolio (026)
- test(e2e): passkey full-stack tier (bundler + paymaster), ClearPath, app lock, Bitcoin card, BLE
- test(e2e): group settlement on chain (058), and every absent row now cites #1400
- test(e2e): accept the clock-derived 'Pending Resolution' badge on Active wagers
- test(e2e): match the creator's 'Under Consideration' row label in RES-12
- test(e2e): api-access console through the real registry path, and the matrix rows for the batch (#1285)
- test(e2e): establish money-path preconditions instead of snapshotting for them (#1250, #1327 lead 2, #1240)

### 🏗️ Infrastructure

- ci: re-measure the on-chain tier, and stop a timed-out leg reporting green
- ci(e2e): gate absent matrix rows on an OPEN tracking issue; record the #1400 §B decision

### 🧹 Maintenance

- style(custody): the queue's Refresh stays with its summary on a phone (spec 102)
- style(custody): sheet forms take the app's chrome; details and queue rows tightened (spec 102)
- chore(spec): renumber funding pools to spec 103 (102 is capacitor channels on staging)
- chore: refresh CI merge ref after #1396 (gates restore) landed on staging
- chore(deps): bump @solana/kit from 7.1.1 to 8.1.0 (#1334)
- chore(api-access): version 1.0.1 to pair with the introspection-fix bytes
- chore(miniapps): re-record api-access build digests for the introspection fix

### Artifacts

Range: `v1.15.2..v1.16.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | moved | `amoy-chain80002-v2/membershipManagerImpl` → `0xb6499596703cEE6eA4BE5b5F01DEc4d7ccfe10bD`<br>`amoy-chain80002-v2/wagerRegistryImpl` → `0xa2176F5Fea39888cD1697Be4651415490C78905d`<br>`amoy-chain80002-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`arbitrum-chain42161-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`arbitrum-chain42161-v2/bridgeRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`arbitrum-chain42161-v2/liquidityRouterImpl` → `0x7Af46728e7C969b75723398e3F93b565E968A3ba`<br>`arbitrum-chain42161-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`base-chain8453-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`base-chain8453-v2/bridgeRouterImpl` → `0x41ba6bcA216bd6A4c5A0Bf8F9b2d682ec0a879D5`<br>`base-chain8453-v2/liquidityRouterImpl` → `0x7Af46728e7c969b75723398E3f93b565E968A3bA`<br>`base-chain8453-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`etc-chain61-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mainnet-chain1-v2/feeRouterImpl` → `0x5cCd55D62Ce7Df730c39543B332dD8d6054B5d00`<br>`mainnet-chain1-v2/bridgeRouterImpl` → `0xcA277Cc3485Da12771d6171a9D0A894B8DD159f8`<br>`mainnet-chain1-v2/liquidityRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`mainnet-chain1-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mordor-chain63-v2/membershipManagerImpl` → `0x7D38F7Ef26f7E2409d5C04a62c1d9A3Ec002A49e`<br>`mordor-chain63-v2/wagerRegistryImpl` → `0x9FfE701be18Ff033706f2df19cd8730F5CB884B2`<br>`mordor-chain63-v2/tokenFactoryImpl` → `0x135108EB6f81e361b6cF131d2Cb9A01E92Cd8ED9`<br>`mordor-chain63-v2/openERC20Impl` → `0xd8E67C6C058a6D35E69c691B44b8D5f858591971`<br>`mordor-chain63-v2/openERC721Impl` → `0x02819fd0d338F4C3FC58E6d9aF299ACA75d624BB`<br>`mordor-chain63-v2/restrictedERC20Impl` → `0x0dD67E2af8Ad301a3B5308c2AD41CCb2220b0444`<br>`mordor-chain63-v2/openERC20V2Impl` → `0x92169007926fBc8Ac90cdD311dD3C2557158C395`<br>`mordor-chain63-v2/openERC721V2Impl` → `0xEeaBC05214FF0C42cbA42b365aB400b7ca4311cE`<br>`mordor-chain63-v2/restrictedERC20V2Impl` → `0x664d87bed13ea4D50Cd3da8e0aC5A8D70A302A0B`<br>`mordor-chain63-v2/externalDAORegistryImpl` → `0x28270cB71E87D2D6C662e61CFE6eD02d05d43B7A`<br>`mordor-chain63-v2/zkWagerPoolFactoryImpl` → `0xd3e851FDDa9D5796D503daFd34b2403D7336d9fD`<br>`mordor-chain63-v2/poolImpl` → `0xd0b94a77DA7Aaa488343CF89978f1Bbf9E72E277`<br>`mordor-chain63-v2/wagerPoolFactoryImpl` → `0xfB6F9F7EfD86a220eE1aD7906278247051B25430`<br>`mordor-chain63-v2/feeRouterImpl` → `0x744b8E56d84bb8D7657b2Bb13426cB882c93B7E6`<br>`mordor-chain63-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mordor-chain63-v2/miniAppRegistryImpl` → `0xc8Dd8601b35aDa3AF367C9E41f24Fd0503Ced674`<br>`optimism-chain10-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`optimism-chain10-v2/bridgeRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`optimism-chain10-v2/liquidityRouterImpl` → `0x7Af46728e7C969b75723398e3F93b565E968A3ba`<br>`optimism-chain10-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`polygon-chain137-v2/membershipManagerImpl` → `0x7177470fE3c5D89CEf965A596540E57cE290C939`<br>`polygon-chain137-v2/wagerRegistryImpl` → `0x9c52C1ef4Bbe65CF19a5C26bebD4A22100964898`<br>`polygon-chain137-v2/tokenFactoryImpl` → `0xE819f7b672D81A8b78d40b1C99Fe5d646513D12C`<br>`polygon-chain137-v2/openERC20Impl` → `0xd8E67C6C058a6D35E69c691B44b8D5f858591971`<br>`polygon-chain137-v2/openERC721Impl` → `0x02819fd0d338F4C3FC58E6d9aF299ACA75d624BB`<br>`polygon-chain137-v2/restrictedERC20Impl` → `0x0dD67E2af8Ad301a3B5308c2AD41CCb2220b0444`<br>`polygon-chain137-v2/wagerPoolFactoryImpl` → `0x754d8aa4785Ec4bEE7c921f8d032D5E3a78d9308`<br>`polygon-chain137-v2/poolImpl` → `0xB153e4456FaD1A7E96e35e14094Cf6964348BC40`<br>`polygon-chain137-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`polygon-chain137-v2/callsignRegistryImpl` → `0xD220D34ed2148B9F4DC65C1bc75169D7DECFBB49`<br>`polygon-chain137-v2/feeRouterImpl` → `0x40ee755246E60f66E7bA425F99C6d704859d38db`<br>`polygon-chain137-v2/bridgeRouterImpl` → `0x8F7A7e7437733326BD2F8045BFceD9B821aF1De1`<br>`polygon-chain137-v2/liquidityRouterImpl` → `0x33818052Ca8B5b8Bb9777Bf6eBbaFCD8Faae6e65`<br>`polygon-chain137-v2/miniAppRegistryImpl` → `0x41858006aD6dd0788b84F9fb17A28d8167C7b331` |
| Mini-app packages | moved | `api-access` v1.0.1<br>`clearpath` v1.2.0<br>`token-mint` v1.0.2 |
| Subgraph endpoint | moved | `v0.3.0` |

### Native channel artifacts (v1.16.0)

| Channel | Artifact | SHA-256 | Signed |
|---|---|---|---|
| android | `FairWins-v1.16.0.aab` | `33a19c9376412b20b57abf98d784ce86242abc7f58dc1f4a36611eb373166339` | no — operator signing ceremony (see docs/runbooks/native-release-operations.md) |
| ios | `FairWins-v1.16.0-ios.xcarchive.zip` | `044f623e3e8cc5073194142c9950692b953cf7edfd237428a94b59f24d1703ec` | no — operator signing ceremony (see docs/runbooks/native-release-operations.md) |

## v1.15.2 — 2026-08-30

Promoted from: none — released directly from main
Previous release: v1.15.1 · Range: `v1.15.1..v1.15.2` (2 commits)

### 🧹 Maintenance

- chore(release): v1.15.1 (#1391)

### Artifacts

Range: `v1.15.1..v1.15.2`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

## v1.15.1 — 2026-08-30

Promoted from: none — released directly from main
Previous release: v1.15.0 · Range: `v1.15.0..v1.15.1` (5 commits)

### 🐛 Bug Fixes

- fix(087): unblock the converge — dead stdout callback, backwards docker pin
- fix(087): the ansible inventory could never reach a node

### Artifacts

Range: `v1.15.0..v1.15.1`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

## v1.15.0 — 2026-08-29

Promoted from: v1.15.0-rc.4
Previous release: v1.13.5 · Range: `v1.13.5..v1.15.0` (51 commits)

### 🚀 Features

- feat(clearpath): native standard DAO creation - spec 030 pillar A (#1268)
- feat(hardware): Ledger over Bluetooth on phones, behind the one adapter seam
- feat(networks): complete the POL rename sweep and wrap/voucher test alignment
- feat(networks): MATIC to POL on Polygon/Amoy, Bitcoin network card
- feat(nav): account add chooser, wrap as a Trade view, FWMV send from portfolio
- feat(pay): group pay - N recipients from Home Pay and Transfer
- feat(custody): vault actions in one sheet, majority threshold + starter policy defaults
- feat(rpc): QuickNode-ready primaries with distinct public failover on every EVM mainnet
- feat(applock): optional app lock per the spec 041 amendment
- feat(membership): purchase lands on the acting account (spec 098)
- feat(networks): complete the POL rename sweep and wrap/voucher test alignment
- feat(networks): MATIC to POL on Polygon/Amoy, Bitcoin network card
- feat(nav): account add chooser, wrap as a Trade view, FWMV send from portfolio
- feat(096): enable the x402 rail, with the collector that watches it

### 🐛 Bug Fixes

- fix(clearpath): move form helpers out of the CreateStandardDao component file
- fix(e2e): re-derive local addresses after pillar-A deploy-sequence growth
- fix(076): the cohort gate checked a filename, not the boundary
- fix(codegen): the build marker lives beside artifacts/, not inside it
- fix(ci): write the build marker where CI actually compiles
- fix: a11y suppression retired, byte gate fails closed on stale artifacts, dead archive scripts removed
- fix(custody): vault batch proposals pre-flight the guard's own delegatecall answer (#1368)
- fix(e2e): CV-06 must kill Polygon's failover too, now that one exists
- fix(pay): drop unused imports from the resolution-loop regression test
- fix(custody): reset sheet scroll on view change; scroll deep assertions into view
- fix(pay): kill the resolution-announcement update loop in the recipient rows

### 📚 Documentation

- spec(101): passkey-native Zcash - spec, plan, research, tasks, derivation contract
- spec(100): passkey-native Solana - spec, plan, tasks, derivation contract
- spec(098): acting-account membership purchase across every submit rail
- spec(099): network status mini-app board with bridge/supply CTAs
- spec(041): amend with optional app-lock (FR-025..FR-028, SC-010)
- docs(085): commit AND push bootstrap state, every time

### 🧪 Tests

- test(mcp): sample the linearity guard best-of-5 so runner noise cannot fail it
- test(094): the ClearPath matrix row names what it measures (#1268 part 1)
- test(095): make the reply-links linearity check robust to runner hiccups
- test(094): add coverage-matrix rows for specs 098-101
- test(089): the money-path tests encoded x402's dormancy

### 🧹 Maintenance

- chore(085): record bootstrap state

### Artifacts

Range: `v1.14.0..v1.15.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | moved | `amoy-chain80002-v2/membershipManagerImpl` → `0xb6499596703cEE6eA4BE5b5F01DEc4d7ccfe10bD`<br>`amoy-chain80002-v2/wagerRegistryImpl` → `0xa2176F5Fea39888cD1697Be4651415490C78905d`<br>`amoy-chain80002-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`arbitrum-chain42161-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`arbitrum-chain42161-v2/bridgeRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`arbitrum-chain42161-v2/liquidityRouterImpl` → `0x7Af46728e7C969b75723398e3F93b565E968A3ba`<br>`arbitrum-chain42161-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`base-chain8453-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`base-chain8453-v2/bridgeRouterImpl` → `0x41ba6bcA216bd6A4c5A0Bf8F9b2d682ec0a879D5`<br>`base-chain8453-v2/liquidityRouterImpl` → `0x7Af46728e7c969b75723398E3f93b565E968A3bA`<br>`base-chain8453-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`etc-chain61-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mainnet-chain1-v2/feeRouterImpl` → `0x5cCd55D62Ce7Df730c39543B332dD8d6054B5d00`<br>`mainnet-chain1-v2/bridgeRouterImpl` → `0xcA277Cc3485Da12771d6171a9D0A894B8DD159f8`<br>`mainnet-chain1-v2/liquidityRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`mainnet-chain1-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mordor-chain63-v2/membershipManagerImpl` → `0x7D38F7Ef26f7E2409d5C04a62c1d9A3Ec002A49e`<br>`mordor-chain63-v2/wagerRegistryImpl` → `0x9FfE701be18Ff033706f2df19cd8730F5CB884B2`<br>`mordor-chain63-v2/tokenFactoryImpl` → `0x135108EB6f81e361b6cF131d2Cb9A01E92Cd8ED9`<br>`mordor-chain63-v2/openERC20Impl` → `0xd8E67C6C058a6D35E69c691B44b8D5f858591971`<br>`mordor-chain63-v2/openERC721Impl` → `0x02819fd0d338F4C3FC58E6d9aF299ACA75d624BB`<br>`mordor-chain63-v2/restrictedERC20Impl` → `0x0dD67E2af8Ad301a3B5308c2AD41CCb2220b0444`<br>`mordor-chain63-v2/openERC20V2Impl` → `0x92169007926fBc8Ac90cdD311dD3C2557158C395`<br>`mordor-chain63-v2/openERC721V2Impl` → `0xEeaBC05214FF0C42cbA42b365aB400b7ca4311cE`<br>`mordor-chain63-v2/restrictedERC20V2Impl` → `0x664d87bed13ea4D50Cd3da8e0aC5A8D70A302A0B`<br>`mordor-chain63-v2/externalDAORegistryImpl` → `0x28270cB71E87D2D6C662e61CFE6eD02d05d43B7A`<br>`mordor-chain63-v2/zkWagerPoolFactoryImpl` → `0xd3e851FDDa9D5796D503daFd34b2403D7336d9fD`<br>`mordor-chain63-v2/poolImpl` → `0xd0b94a77DA7Aaa488343CF89978f1Bbf9E72E277`<br>`mordor-chain63-v2/wagerPoolFactoryImpl` → `0xfB6F9F7EfD86a220eE1aD7906278247051B25430`<br>`mordor-chain63-v2/feeRouterImpl` → `0x744b8E56d84bb8D7657b2Bb13426cB882c93B7E6`<br>`mordor-chain63-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mordor-chain63-v2/miniAppRegistryImpl` → `0xc8Dd8601b35aDa3AF367C9E41f24Fd0503Ced674`<br>`optimism-chain10-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`optimism-chain10-v2/bridgeRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`optimism-chain10-v2/liquidityRouterImpl` → `0x7Af46728e7C969b75723398e3F93b565E968A3ba`<br>`optimism-chain10-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`polygon-chain137-v2/membershipManagerImpl` → `0x7177470fE3c5D89CEf965A596540E57cE290C939`<br>`polygon-chain137-v2/wagerRegistryImpl` → `0x9c52C1ef4Bbe65CF19a5C26bebD4A22100964898`<br>`polygon-chain137-v2/tokenFactoryImpl` → `0xE819f7b672D81A8b78d40b1C99Fe5d646513D12C`<br>`polygon-chain137-v2/openERC20Impl` → `0xd8E67C6C058a6D35E69c691B44b8D5f858591971`<br>`polygon-chain137-v2/openERC721Impl` → `0x02819fd0d338F4C3FC58E6d9aF299ACA75d624BB`<br>`polygon-chain137-v2/restrictedERC20Impl` → `0x0dD67E2af8Ad301a3B5308c2AD41CCb2220b0444`<br>`polygon-chain137-v2/wagerPoolFactoryImpl` → `0x754d8aa4785Ec4bEE7c921f8d032D5E3a78d9308`<br>`polygon-chain137-v2/poolImpl` → `0xB153e4456FaD1A7E96e35e14094Cf6964348BC40`<br>`polygon-chain137-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`polygon-chain137-v2/callsignRegistryImpl` → `0xD220D34ed2148B9F4DC65C1bc75169D7DECFBB49`<br>`polygon-chain137-v2/feeRouterImpl` → `0x40ee755246E60f66E7bA425F99C6d704859d38db`<br>`polygon-chain137-v2/bridgeRouterImpl` → `0x8F7A7e7437733326BD2F8045BFceD9B821aF1De1`<br>`polygon-chain137-v2/liquidityRouterImpl` → `0x33818052Ca8B5b8Bb9777Bf6eBbaFCD8Faae6e65`<br>`polygon-chain137-v2/miniAppRegistryImpl` → `0x41858006aD6dd0788b84F9fb17A28d8167C7b331` |
| Mini-app packages | moved | `api-access` v1.0.0<br>`clearpath` v1.1.0<br>`token-mint` v1.0.2 |
| Subgraph endpoint | unchanged | `v0.3.0` |

## v1.13.5 — 2026-08-28

Promoted from: v1.13.5-rc.2
Previous release: v1.13.4 · Range: `v1.13.4..v1.13.5` (6 commits)

### 🐛 Bug Fixes

- fix(bootstrap): the apply identity could not even read project IAM policy

### Artifacts

Range: `v1.13.4..v1.13.5`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

## v1.13.4 — 2026-08-27

Promoted from: v1.13.4-rc.4
Previous release: v1.13.3 · Range: `v1.13.3..v1.13.4` (10 commits)

### 🐛 Bug Fixes

- fix(prod): adopt 4 secret containers the failed apply would recreate
- fix(bundler): the uptime probe proxied INTO the origin lock it documents bypassing
- fix(bootstrap): the apply identity could adopt but not create

### Artifacts

Range: `v1.13.3..v1.13.4`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

## v1.13.3 — 2026-08-25

Promoted from: none — released directly from main
Previous release: v1.13.0 · Range: `v1.13.0..v1.13.3` (14 commits)

### 🐛 Bug Fixes

- fix(review): restore readProviderFor's JSDoc to its function; anchor test paths to the file
- fix(assistant): say why the assistant is unreachable when that is knowable
- fix(membership): the other two surfaces that stated the wrong account's status
- fix(membership): read the acting account, and scan on the configured endpoint
- fix(vouchers): block the buy control when no tier is on sale
- fix(membership): never offer a tier the contract has switched off
- fix(paymaster): refuse sponsorship an empty pool cannot pay for; un-strand the AA31 fallback

### 🧪 Tests

- test: wait for the tier-selection repair instead of sampling it
- test(paymaster): correct the deposit-gate boundary comment

### Artifacts

Range: `v1.13.2..v1.13.3`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | unchanged | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | unchanged | `v0.3.0` |

## v1.13.0 — 2026-08-25

Promoted from: v1.13.0-rc.2
Previous release: v1.12.0 · Range: `v1.12.0..v1.13.0` (25 commits)

### 🚀 Features

- feat(frontend): acting-account routing for wager refund/resolve; Earn refuses acting accounts
- feat(frontend): record redemption terms, verify admin write authority, route acting accounts

### 🐛 Bug Fixes

- fix: repair lockfile from the earlier full re-resolve
- fix: stub the real WalletConnect connector under Cypress
- fix(e2e): compare BigInt accrued fees as booleans in ADM-05
- fix(admin): name the actual signing chain in the role header; fix multi-match test query
- fix(membership): expired-renewal purchase-mode fallback refinements

### 🧪 Tests

- test(e2e): cover admin membership/role writes and voucher purchase on-chain

### 🧹 Maintenance

- chore(deps): bump @google-cloud/bigquery from 7.9.4 to 9.0.2
- chore(deps): bump @solana-program/system from 0.13.0 to 0.14.0
- chore(deps-dev): bump @chainlink/contracts in the solidity-sources group

### Artifacts

Range: `v1.12.0..v1.13.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

## v1.12.0 — 2026-08-24

Promoted from: v1.12.0-rc.36
Previous release: v1.11.1 · Range: `v1.11.1..v1.12.0` (298 commits)

### 🚀 Features

- feat(097): land the workstation secrets estate that prod was already running
- feat(ops): KMS transaction signer, and a key-compromise runbook
- feat(096): x402 pay-per-request rail for agents, prod-gateway enablement procedure
- feat(095): adopt express-rate-limit as the coarse outer bound on flagged routes
- feat(095): member API with signed capability keys, MCP server, api-access mini-app, agentic chat assistant
- feat(094/041): run the account-native tier in CI, and stop the matrix over-claiming

### 🐛 Bug Fixes

- fix(deps): declare @google-cloud/kms, which scripts/ops was borrowing
- fix(infra): staging planned two extra public services, and would have succeeded
- fix(infra): a clean plan was hiding three ways to break production
- fix(097): pin ops-workstation to the ref where the module still exists
- fix(infra): wire the orphaned QuickNode credentials, and guard the wrong-chain hazard they invite
- fix(095): a stranger could not have denied key revocation, and nothing bounded model spend
- fix(finops): catalogue x402 + the assistant, and widen C2 past FeeRouter services
- fix(infra): gate the spec-095 MCP Cloud Run modules off, and stop the comment lying
- fix(mcp): bind loopback, validate Origin, refuse a shared identity over HTTP
- fix(bridge): chunk the destination fill scan — it was dead on four of five chains
- fix(x402): check the balance against the SIGNED value, not the quoted price
- fix(ci): make contract deploys manual-only
- fix(a11y): make the disabled fill and label move together (#1260)
- fix(a11y): label brand fills from the audited token pair, not #fff (#1260, #1247)
- fix(#1265): the asset catalog is cohort-bounded too, so a testnet build has a bridge destination
- fix: land the address gate green, and diagnose the right mechanism (#1298)
- fix: only dismiss an expired offer once its reclaim is confirmed (#1297)
- fix: say only what the sanctions revert establishes, on all four screened paths (#1292)
- fix: restore the passkey provider facade, and migrate its test to @noble/curves v2
- fix(#1298): the address gate could never pass on the tier it guards
- fix: walk every observed revert-data nesting on the wager paths
- fix: keep the Bridge form, its copy and its in-flight list on one roster (#1265)
- fix: bound spec-067 Supply and Bridge rosters to the build cohort (#1265)
- fix: clear the development banner on every fixed surface, not just the header (#1248)
- fix: measure the development banner instead of reserving 45px (#1248)
- fix: make the unread-ledger verdict reachable, and never crash on it (#1280)
- fix: never render an unread activity ledger as an empty history (#1280)
- fix: give the Bitcoin gateway its own env var (#1263)
- fix: re-derive an unchosen passkey chain, and stop a failed key read accusing a member (#1286)
- fix: resolve the passkey session chain from the build, not wagmi's default (#1286)
- fix: detect "deployed but unset", and describe the real nonce hazard (#1298)
- fix: fail the e2e setup loudly when a deploy-order shift repoints the app (#1298)
- fix: make the expired-offer reclaim reachable by both routes and safe to fail (#1297)
- fix: restore a reachable route to an expired offer's Reclaim & Clear (#1297)
- fix: tell a screened member only what is true, on both wager paths (#1292)
- fix: name sanctions screening on the wager create path (#1292)
- fix: decode a raw error.data revert so the curator sees StaleProposal (#1267)
- fix(#1019): a member who disconnects stays disconnected, and four wallet tests that never ran (#1296)
- fix(#1228): append the backup-pointer deploy, don't insert it mid-order
- fix(passkey): adapt to @noble/curves v2 — restore cross-device key recovery
- fix(041): a passkey session reports the build's chain, not wagmi's first (#1288)
- fix(095): truthful names and linear regexes end the CodeQL alert class
- fix(095): retire the quadratic trailing-slash trim across all six gateway upstream clients
- fix(095): unambiguous decimal-amount regex in the keypad e2e helper
- fix(095): linear-time parsing on attacker-reachable strings, e2e repairs
- fix(095): drop mcp-server version field (release-computed), clear two eslint errors
- fix(095): versions track the release, never hand-bumped
- fix(095): actor-critic screenshot round — 7 UI fixes, 56 shots landed, harness files untracked
- fix(041/045): passkey reload sign-out and synced-passkey account loss (#1271)
- fix(041): wagmi never reconnected the passkey connector — every reload signed the member out
- fix(041/045): an empty credential book is not proof the member is new
- fix(test): AD-06 read the chain before the pause had been mined
- fix(test): match the RPC intercepts on hostname, not a regex built from a string
- fix(093/071): a deep link must not be redirected while the sweep is running
- fix(071): a chain with nothing deployed is not a chain that answered
- fix: remove the duplicate callsignRegistry key in HARDHAT_CONTRACTS
- fix(062): the native sweep's gas reserve must track a RISING fee, not just a falling balance
- fix(test): sequence multi-step vault changes on the chain, not the queue
- fix(ui): treat a missing browsers root as 'not here', not as a crash
- fix(offer): fall back the offer odds multiplier to the declared default, not 100
- fix(e2e): re-sync browser clock to chain after advancing in POOL-03
- fix(e2e): stop predicting createPool's now, read the mined block instead
- fix(034): CI round 2 — auto-close vs explicit close, retry BadDeadlines
- fix(034): CI failures — stale-checkpoint deadline math and a nonce race
- fix(ci): the Lighthouse artifact has never uploaded anything
- fix(e2e): stop a Lighthouse preset blocking on performance, and record the tier that missed its budget
- fix(deploy): wire the WagerRegistryIntents facet on a fresh deployment
- fix(membership): derive the purchase action from the member, not the entry point
- fix(ci): drop the bare `exit 0` from the chain-readiness step
- fix(admin): derive the denied-access role hint instead of restating it

### ⚡ Performance

- perf(e2e): shard the no-chain tier six ways per profile, and re-measure both tiers (#1284)

### 📚 Documentation

- docs: correct the VITE_BITCOIN_GATEWAY_URL guidance to what the code does
- docs(094): raise the no-chain budget to 7 minutes, with the reason recorded
- docs(094): record the two anti-patterns the account-native tier was built on
- docs(060): correct the open contrast finding's scope and link it to #1260
- spec(094): e2e coverage expansion — spec, plan, research, tasks
- docs(e2e): record that the full tier is not hermetic

### 🧪 Tests

- test(094): give spec 097 its coverage-matrix row
- test(#1250): DEC-02's row assertion waits long enough for a cold wager scan
- test(#1260): the validateTheme fixture defines the label token it now requires
- test(#1267): MA-03 asserts the message the curator now actually gets
- test(e2e): adopt the #1250 settle-wait guard on the post-staging money-path specs
- test(e2e): MC-02 accepts the disclosure granularity the ledger actually reports
- test(e2e): CP-02 matches the honest screening copy, not the retired one
- test(#1292): CP-02 asserts the screening message now that there is one
- test(e2e): label the seeded expired offer with the test's own id (#1297)
- test(#1019): DSH-03 and DSH-04 run again — the span was the assertion's, not the app's (#1307)
- test(#1019): ENC-04 asserts the app's key cache, not the browser's (#1306)
- test(#1019): A11Y-04 runs again — the backdrop click was aimed at the nav gutter (#1305)
- test: repair first-run failures surfaced by integration validation
- test(#1019): WAL-03, UL-02 and UL-04 run again — and UL-04 can now fail (#1304)
- test(#1019): HMM-02, HMM-04 and HMM-05 run again — the covered switcher is gone (#1303)
- test(#1019): three more pending markers cleared — ONB-01, ONB-02, DSH-01 (#1302)
- test(#1228): compliance parity for passkey accounts — three tests that had never run (#1293)
- test(032): the encrypted backup round trip, the half that costs gas
- test(095): fast-tier e2e for the assistant and API access, coverage matrix row, undelivered-revocation honesty
- test(024/035/036/012): on-chain depth for draws, open challenges, relayed intents and wager notifications (#1283)
- test(#1228): 15 coverage rows closed, 8 product bugs fixed, 2 permanent skips removed (#1282)
- test(#1245): read-only member surfaces — 12 absent rows closed, 2 gaps named rather than faked (#1281)
- test(071/093): admin console — three-state estate reads, entry gating, single-chain writes (#1242)
- test(071/093): the estate's three states, the entry gate's three answers, and a single-chain write (#1242)
- test(084/069/054/072/007): identity, access and endpoint flows (#1241)
- test(054): register a %callsign through commit and reveal (#1241)
- test(054/072): a callsign resolves in address entry, and the tenant brand comes from its manifest (#1241)
- test(069/054/007): endpoints, the callsign gate and compliance refusal (#1241)
- test(084/069): Verify's three verdicts and the endpoint credential rules (#1241)
- test(058/033/026): the three money flows of #1240 — send, swap, redeem
- test(073/077): browse the app catalogue, in the tier that flow belongs to (#1238)
- test(030/042): ClearPath registers on chain, and demands a switch instead of signing on the wrong one (#1238)
- test(028/073): Token Mint deploys through the host, and screening bites inside submit (#1238)
- test(073): the curator's content-committed approval (#1238)
- test(073): launch and serving-decision flows against the local registry (#1238)
- test(073): put the mini-app registry on the local E2E chain (#1238)
- test(065/066): settle delegated staking and the operator's controls on chain (#1237)
- test(050-earn): settle the lending vault deposit and withdrawal from chain state (#1237)
- test(067): settle the two bridge flows from chain state, and close #1236
- test(067): settle the two supplied-liquidity flows from chain state (#1236)
- test(067): make the bridge and supply surfaces reachable on the e2e chain
- test(068): drive vault proposals by their nonce, and make the failure explain itself
- test(068): one scenario table for the guard, the client twin and the UI
- test(049,068): cover the multi-chain vault list and v1 enforcement
- test(068): prove first-match-governs and no-match-denies against the chain
- test(068): drive v2 guard adoption as the vault's own threshold-approved decision
- test(043): drive create-vault, propose-and-execute and operate-as-vault on chain
- test(043,049,068): stand up the Protect custody estate on the e2e chain
- test(062,063): retier the sweep spec onto the Amoy-shaped chain and record the matrix rows
- test(062,063): e2e coverage for legacy account recovery, and two sweep defects it found
- test(060): end-to-end coverage for platform-fee disclosure and the maxFeeBps ceiling (#1233)
- test(e2e): add unhappy-path assertions to POOL-01 and POOL-02
- test(e2e): rewrite the 39 vacuous branches in the money-path specs (#1231)
- test(034): full-tier e2e coverage for Wager Pools
- test(e2e): CLM-01 must wait for the list, not snapshot for it
- test(e2e): record the measured shard weights, and keep the on-chain tier on every push
- test(e2e): fix the harness bugs its own first CI run exposed
- test(e2e): address the review — passkey leg, route drift, anchored regex, sub-pixel bounds
- test(e2e): coverage matrix, tiering policy, and the gates that keep them honest (spec 094)
- test(e2e): CLM-10 must actually freeze the winner
- test(e2e): ORC-03 asserts the tie rule, not the absence of auto-resolution
- test(e2e): CRE-12 must pick a side, and a refused submit should say so
- test(e2e): CRE-12/16 assert the selection, not the pixel
- test(e2e): RES-10 establishes its own precondition and asserts the real guard
- test(e2e): the resolve flow has three steps, and the tests only clicked one
- test(e2e): assert the fact, not the copy — chain state for resolve and reject
- test(e2e): stop fighting a modal that closes itself, and wait for the Resolve control
- test(e2e): one acceptance helper, and wait for the modal to decide before branching
- test(e2e): fix CLM-01's acceptance and E2E-01's tab; name E2E-02's revert
- test(e2e): select the outcome by the wording the resolve modal renders
- test(e2e): wait for the accept control instead of snapshotting for it
- test(e2e): DEC-05 must inspect the wager it claims to be inspecting
- test(e2e): close the acceptance modal by its own control
- test(e2e): give spec 05 the acceptance-modal helper 07 already earned
- test(e2e): name the custom error behind a revert, and judge acceptance on chain
- test(e2e): register provider wrappers after the mock, and open the card MEM-06 reads
- test(e2e): make the browser clock track the chain clock
- test(e2e): reject every spend authorization in MEM-12, not just eth_sendTransaction
- test(e2e): fail at the acceptance step instead of three commands later
- test(e2e): register opponent encryption keys in the blocked-case specs
- test(e2e): assert the decrypt gate in PRV-02, not a placeholder
- test(e2e): register the arbitrator's key, and make a failed decrypt say why
- test(e2e): drop the second encryption-toggle copy in attemptCreateWager
- test(e2e): handle the private-wager decrypt gate, and refresh ADM-01 for spec 093
- test(e2e): reset the chain between tests in clock-advancing specs
- test(e2e): repair three dead selectors behind the four near-zero specs
- test(e2e): scope the confirm-acceptance click to its dialog
- test(e2e): scroll the acceptance confirm into view — 07's creates now reach it
- test(e2e): 07 and 10 create wagers too — the interceptIpfs sweep missed their local helpers
- test(e2e): DEC-01 stops at the proven money path — list staleness is #1019's call
- test(e2e): assert the declined offer's absence on a REOPENED list
- test(e2e): a declined wager reads back as None — assert the storage release
- test(e2e): DEC-01 asserts the decline's OUTCOME, not text on a dialog that closed
- test(e2e): mock state lives in the closure; the window holds only a pointer
- test(e2e): one mock provider per page — the before-hook's account was winning
- test(e2e): the impersonating chain's USDC must be the LOCAL mock, decimals included
- test(e2e): assert the Membership tab the app renders, not the one imagined
- test(e2e): fix the lint break and the reconnect race behind MEM-06
- test(e2e): the E2E dev server is a TESTNET-cohort build
- test(e2e): target the Review step's controls, not the panel's visibility
- test(e2e): run the local chain AS the membership home (Amoy-shaped node)
- test(e2e): rewrite the oracle creates against the flow the product ships
- test(e2e): fail checkpoint loudly, cover the arbitrator's key, repair CRE-09, restructure 02
- test(e2e): isolate full-tier specs with a chain checkpoint — run order decided who passed
- test(e2e): treat an already-connected wallet as valid, not as a failure
- test(e2e): scroll to the top before asserting the connected account
- test(e2e): give the full tier an IPFS boundary — the money path could never run
- test(e2e): fix ENC-03's stale Security-tab navigation

### 🏗️ Infrastructure

- ci(e2e): gate the on-chain money paths — add the Cypress Full E2E job

### 🧹 Maintenance

- chore(ops): repin the gateway to agentic-096
- chore: retrigger CI
- chore(deps): hold @openzeppelin/contracts at 5.4.0, with the reason
- chore(ops): record the Mordor legacy-contract write-off as a decision
- chore(ops): record the admin Safe on Amoy 80002
- chore(ops): rotate the admin Safe to KMS + Ledger + Trezor
- chore(deps): reconcile lockfile and raise the gateway runtime to Node 22
- chore(096): prod-gateway enablement block (commented until image repin), staging-gateway truth
- chore(deps): bump @noble/curves from 1.9.7 to 2.3.0
- chore(095): lockfile with api-access workspace member, miniapp byte baseline, verification fixes
- chore(095): wire api-access mini-app into build/publish/digest chains, add test:mcp script
- chore(deps): bump @google-cloud/kms from 5.7.0 to 6.0.0
- chore(deps): bump @scure/btc-signer from 2.2.0 to 2.3.0
- chore(deps): bump @noble/post-quantum from 0.6.1 to 0.7.0
- chore(deps): bump google-github-actions/setup-gcloud from 2 to 3
- chore(deps): bump actions/setup-node from 4 to 7
- chore(deps): bump terraform-linters/setup-tflint from 4 to 6
- chore(config): refresh the stale local-chain (1337) contract defaults
- chore(git): ignore the local-chain deployment record

### Artifacts

Range: `v1.11.1..v1.12.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | moved | `amoy-chain80002-v2/membershipManagerImpl` → `0xb6499596703cEE6eA4BE5b5F01DEc4d7ccfe10bD`<br>`amoy-chain80002-v2/wagerRegistryImpl` → `0xa2176F5Fea39888cD1697Be4651415490C78905d`<br>`amoy-chain80002-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`arbitrum-chain42161-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`arbitrum-chain42161-v2/bridgeRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`arbitrum-chain42161-v2/liquidityRouterImpl` → `0x7Af46728e7C969b75723398e3F93b565E968A3ba`<br>`arbitrum-chain42161-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`base-chain8453-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`base-chain8453-v2/bridgeRouterImpl` → `0x41ba6bcA216bd6A4c5A0Bf8F9b2d682ec0a879D5`<br>`base-chain8453-v2/liquidityRouterImpl` → `0x7Af46728e7c969b75723398E3f93b565E968A3bA`<br>`base-chain8453-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`etc-chain61-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mainnet-chain1-v2/feeRouterImpl` → `0x5cCd55D62Ce7Df730c39543B332dD8d6054B5d00`<br>`mainnet-chain1-v2/bridgeRouterImpl` → `0xcA277Cc3485Da12771d6171a9D0A894B8DD159f8`<br>`mainnet-chain1-v2/liquidityRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`mainnet-chain1-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mordor-chain63-v2/membershipManagerImpl` → `0x7D38F7Ef26f7E2409d5C04a62c1d9A3Ec002A49e`<br>`mordor-chain63-v2/wagerRegistryImpl` → `0x9FfE701be18Ff033706f2df19cd8730F5CB884B2`<br>`mordor-chain63-v2/tokenFactoryImpl` → `0x135108EB6f81e361b6cF131d2Cb9A01E92Cd8ED9`<br>`mordor-chain63-v2/openERC20Impl` → `0xd8E67C6C058a6D35E69c691B44b8D5f858591971`<br>`mordor-chain63-v2/openERC721Impl` → `0x02819fd0d338F4C3FC58E6d9aF299ACA75d624BB`<br>`mordor-chain63-v2/restrictedERC20Impl` → `0x0dD67E2af8Ad301a3B5308c2AD41CCb2220b0444`<br>`mordor-chain63-v2/openERC20V2Impl` → `0x92169007926fBc8Ac90cdD311dD3C2557158C395`<br>`mordor-chain63-v2/openERC721V2Impl` → `0xEeaBC05214FF0C42cbA42b365aB400b7ca4311cE`<br>`mordor-chain63-v2/restrictedERC20V2Impl` → `0x664d87bed13ea4D50Cd3da8e0aC5A8D70A302A0B`<br>`mordor-chain63-v2/externalDAORegistryImpl` → `0x28270cB71E87D2D6C662e61CFE6eD02d05d43B7A`<br>`mordor-chain63-v2/zkWagerPoolFactoryImpl` → `0xd3e851FDDa9D5796D503daFd34b2403D7336d9fD`<br>`mordor-chain63-v2/poolImpl` → `0xd0b94a77DA7Aaa488343CF89978f1Bbf9E72E277`<br>`mordor-chain63-v2/wagerPoolFactoryImpl` → `0xfB6F9F7EfD86a220eE1aD7906278247051B25430`<br>`mordor-chain63-v2/feeRouterImpl` → `0x744b8E56d84bb8D7657b2Bb13426cB882c93B7E6`<br>`mordor-chain63-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`mordor-chain63-v2/miniAppRegistryImpl` → `0xc8Dd8601b35aDa3AF367C9E41f24Fd0503Ced674`<br>`optimism-chain10-v2/feeRouterImpl` → `0x9B68fDbBaEaeafbe2349549A4994A4697462AFea`<br>`optimism-chain10-v2/bridgeRouterImpl` → `0x41ba6bca216bd6A4c5a0bf8F9B2d682EC0a879d5`<br>`optimism-chain10-v2/liquidityRouterImpl` → `0x7Af46728e7C969b75723398e3F93b565E968A3ba`<br>`optimism-chain10-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`polygon-chain137-v2/membershipManagerImpl` → `0x7177470fE3c5D89CEf965A596540E57cE290C939`<br>`polygon-chain137-v2/wagerRegistryImpl` → `0x9c52C1ef4Bbe65CF19a5C26bebD4A22100964898`<br>`polygon-chain137-v2/tokenFactoryImpl` → `0xE819f7b672D81A8b78d40b1C99Fe5d646513D12C`<br>`polygon-chain137-v2/openERC20Impl` → `0xd8E67C6C058a6D35E69c691B44b8D5f858591971`<br>`polygon-chain137-v2/openERC721Impl` → `0x02819fd0d338F4C3FC58E6d9aF299ACA75d624BB`<br>`polygon-chain137-v2/restrictedERC20Impl` → `0x0dD67E2af8Ad301a3B5308c2AD41CCb2220b0444`<br>`polygon-chain137-v2/wagerPoolFactoryImpl` → `0x754d8aa4785Ec4bEE7c921f8d032D5E3a78d9308`<br>`polygon-chain137-v2/poolImpl` → `0xB153e4456FaD1A7E96e35e14094Cf6964348BC40`<br>`polygon-chain137-v2/accountImpl` → `0xfC5086A397e4FbAAF8f73892807415Da8d255E61`<br>`polygon-chain137-v2/callsignRegistryImpl` → `0xD220D34ed2148B9F4DC65C1bc75169D7DECFBB49`<br>`polygon-chain137-v2/feeRouterImpl` → `0x40ee755246E60f66E7bA425F99C6d704859d38db`<br>`polygon-chain137-v2/bridgeRouterImpl` → `0x8F7A7e7437733326BD2F8045BFceD9B821aF1De1`<br>`polygon-chain137-v2/liquidityRouterImpl` → `0x33818052Ca8B5b8Bb9777Bf6eBbaFCD8Faae6e65`<br>`polygon-chain137-v2/miniAppRegistryImpl` → `0x41858006aD6dd0788b84F9fb17A28d8167C7b331` |
| Mini-app packages | moved | `api-access` v1.0.0<br>`clearpath` v1.0.2<br>`token-mint` v1.0.2 |
| Subgraph endpoint | moved | `v0.3.0` |

## v1.11.1 — 2026-08-24

Promoted from: none — released directly from main
Previous release: v1.11.0 · Range: `v1.11.0..v1.11.1` (4 commits)

### 🧪 Tests

- test(094): carry the E2E cohort seams in networks.js to main

### Artifacts

Range: `v1.11.0..v1.11.1`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

## v1.11.0 — 2026-08-17

Promoted from: v1.11.0-rc.6
Previous release: v1.10.1 · Range: `v1.10.1..v1.11.0` (29 commits)

### 🚀 Features

- feat(057): enable passkey smart accounts to trade on Predict via the CLOB's ERC-1271 rail
- feat(store): bound catalog sections as horizontal rails with a full-list modal
- feat(093): surface admin mini-apps in the Apps store with Quick Access pinning
- feat(093): decompose AdminPanel into role-gated admin mini-apps

### 🐛 Bug Fixes

- fix(finops): fold in the billing-export classification, with its premise corrected
- fix(finops): the alert rules were all firing on a healthy estate
- fix(057): address review — pin passkey approvals to Polygon, un-stale the session credential
- fix(finops): stamp the reading and its last-good cache from ONE clock read
- fix(finops): a freshly enabled billing export is not-configured, not broken
- fix(ci): the auto back-merge PR could not satisfy its own required checks

### 📚 Documentation

- docs: correct the spec-067 router deployment status in the agent guide
- spec(093): admin mini-apps — granular operations control
- docs(runbook): credential rotation and the connected-systems inventory

### Artifacts

Range: `v1.10.1..v1.11.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

## v1.10.1 — 2026-08-16

Promoted from: v1.10.1-rc.2
Previous release: v1.10.0 · Range: `v1.10.0..v1.10.1` (5 commits)

### 🧹 Maintenance

- chore(finops): wire the exporter's deploy config (#1205)

### Artifacts

Range: `v1.10.0..v1.10.1`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

## v1.10.0 — 2026-08-16

Promoted from: v1.10.0-rc.6
Previous release: v1.9.0 · Range: `v1.9.0..v1.10.0` (32 commits)

### 🚀 Features

- feat(account): merge activity and stats across the cohort (spec 092)
- feat(account): estate-wide stats and account-aware empty states
- feat(account): show the wager's message on wager activity entries
- feat(brand): align app styling defaults with Chippr Brand Guidelines v1.0
- feat(finops): real-time revenue and cost observability (spec 089)

### 🐛 Bug Fixes

- fix: restore finops spec references clobbered by the brand spec renumber
- fix(brand): resolve the four findings from the actor-critic screenshot loop
- fix(finops): staleness alerts fired for every not-configured source
- fix(ci): unblock and automate the main-into-staging back-merge
- fix(finops): six honesty defects found in review
- fix(finops): let the release set the new manifests' versions
- fix(nav): rename drawer Quick Access labels to Payments and Accounts

### ♻️ Refactoring

- refactor(brand): consolidate the remaining colour literals onto tokens

### 📚 Documentation

- docs(spec): task breakdown for 092 multi-chain activity
- docs(spec): plan + design artifacts for 092 multi-chain activity
- docs(spec): renumber multi-chain activity to 092 (091 double-booked)
- docs(spec): draft spec 090 — multi-chain activity ledger

### 🧪 Tests

- test(account): assert full explorer URL prefixes, not host substrings

### Artifacts

Range: `v1.9.0..v1.10.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

## v1.9.0 — 2026-08-15

Promoted from: v1.9.0-rc.15
Previous release: v1.8.0 · Range: `v1.8.0..v1.9.0` (88 commits)

### 🚀 Features

- feat(transfer): add a Wrap view, drop the intro copy and Activity tab
- feat(earn): search and filter the Supply pool list, trim its explainer text
- feat(account): instant address-only switching, deferred signing, acting-account balances (spec 088)
- feat(account): customize entry is an ellipsis on the card itself
- feat(account): unified, customizable glass account cards (spec 086)
- feat(protect): actor-critic screenshot pass, capture harness and skill
- feat(protect): hardware wallet cold storage for Off chain (spec 085)
- feat(085): Ansible node configuration, CI workflows, developer guide
- feat(085): Terraform layer + IaC guardrail gate
- feat(nav): search protocols, services and preference cards from the drawer

### 🐛 Bug Fixes

- fix(app): tolerate non-promise switchNetwork returns in switch buttons
- fix(app): handle now-real switchNetwork rejections (spec 088 follow-through)
- fix(earn): address review on Supply search, and validate the screens
- fix(deps): patch the graph-cli/gluegun transitives, re-resolved on merged staging
- fix(protect): hardware wallets could not connect in staging — Node globals + Trezor interop
- fix(deps): pin patched transitives in the graph-cli / gluegun closure
- fix(deps): replace the unmaintained @pinata/sdk with the repo's fetch seam
- fix(deps): dedupe browser-shipped axios off the vulnerable 1.13.5 pin
- fix(086): stop checkout's persisted credential overriding the module token
- fix(085): drop the bare `exit 0` from the module-access gate
- fix(085): pass TF_MODULES_TOKEN through env and strip stray whitespace
- fix(085): make terraform validate degrade honestly without module access
- fix(085): invert G-10 from a deny-list to an allow-list
- fix(085): install Ansible collections where ansible.cfg looks for them
- fix(085): drop an unused data source, and stop the infra jobs claiming results they have not produced
- fix(ui): stop AdminPanel CSS sinking every modal below the nav
- fix(nav): tokenize queries like the index, and compare focus ids as values
- fix: route draw-proposal scan and site stats through per-chain subgraph URL
- fix(activity): honour an explicit toBlock, and clear "still reading" on error
- fix(activity): stop the false "Couldn't refresh some activity" banner
- fix(protect): lead the unsettled result with what is certain
- fix(protect): never assume a network the member has not stated

### ♻️ Refactoring

- refactor(ui): cut the narrative intros from the major member views
- refactor(085): move the five modules to the org-wide chippr-tf-modules
- refactor(protect): make signature checking offline by construction

### 📚 Documentation

- spec(account-cards): unified, customizable account cards (spec 086)
- docs(protect): hardware wallet developer guide + staging validation runbook
- docs(085): refresh the task-status banner after the module extraction
- docs(085): record task status and the operator-required remainder
- docs(085): operations runbook, module guide, and source-of-truth re-scoping
- spec(085): Infrastructure as Code (Terraform + Ansible) for issue #1177
- docs(protect): realign the Verify acceptance scenarios with the offline model

### 🧪 Tests

- test(network): assert the switching claim, not its old phrasing
- test(miniapps): locked recovered account routes through submit (spec 088)
- test(protect): hardware wallet coverage — lib, components, e2e
- test(ui): normalise CSS paths in the modal-backdrop guard
- test: widen subgraph-url guard to catch bracket access and destructuring

### 🏗️ Infrastructure

- ci(086): triage the module token via the API so the failure names itself
- ci(086): re-run with the module token scoped to chippr-tf-modules
- ci(085): re-trigger — the revert commit produced no workflow run
- ci(085): fetch the shared modules with a read-only deploy key, not a PAT
- ci(085): try each credential form before blaming the token's access
- ci(085): re-run with the org-owned module token
- ci(085): re-run after the org fine-grained PAT policy was fixed
- ci(085): preflight the module credential and classify why it failed
- ci(085): re-run the infra checks now TF_MODULES_TOKEN exists

### 🧹 Maintenance

- chore(deps): drop the dead Semaphore dependency closure
- chore(deps): Bump @scure/bip39 from 2.2.0 to 2.3.0

### Artifacts

Range: `v1.8.0..v1.9.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.3.0` |

## v1.8.0 — 2026-08-12

Promoted from: v1.8.0-rc.5
Previous release: v1.7.0 · Range: `v1.7.0..v1.8.0` (18 commits)

### 🚀 Features

- feat(protect): add message signing and verification
- feat(perps): venue fees, HIP-3 dex coverage, and the Hyperliquid go/no-go

### 🐛 Bug Fixes

- fix(protect): make the verify seam fail loudly instead of silently
- fix(protect): reject odd-length signature hex and gate Check on parse errors
- fix(test): pin the activity-feed clock — it was red for ~2 minutes every midnight

### ♻️ Refactoring

- refactor(frontend): remove the Trade ticket's account selector

### 📚 Documentation

- docs(protect): add the Spec Kit artifacts for message signing and verify

### 🧹 Maintenance

- chore(deps): Bump @scure/base from 2.2.0 to 2.3.0
- chore(deps): Bump @scure/bip32 from 2.2.0 to 2.3.0

### Artifacts

Range: `v1.7.0..v1.8.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.2.0` |

## v1.7.0 — 2026-08-12

Promoted from: v1.7.0-rc.5
Previous release: v1.6.0 · Range: `v1.6.0..v1.7.0` (23 commits)

### 🚀 Features

- feat(083): perps entry, admin fees, activity — and three more dead paths closed
- feat(083): perps exits — position sheet, stuck-order recovery, protection (phases 3+4)
- feat(083): perps foundations — venue calldata, order state machine, fee units, guards
- feat(ops): GMX UI-fee-factor script — the perps fee rail GMX itself enforces (spec 083)
- feat(perps): visual polish via actor-critic loop, e2e, docs, capture harness (spec 082)
- feat(frontend): Perps view inside Trade — cross-venue pairs, positions, fees, link-outs (spec 082)
- feat(gateway): /v1/perps/* read proxy — Gains, GMX, Hyperliquid market data (spec 082)

### 🐛 Bug Fixes

- fix(infra): enable the perps read proxy, and stop the ops skill reporting a migrated gateway as scaled-to-zero (#1158)
- fix(theme): define missing dark-mode tokens breaking Predict/Perps unavailable banners
- fix(perps): enforce module killswitch, 502 on total venue outage, contract-doc alignment

### 📚 Documentation

- docs(083): record the standing decision to keep the deploy wallet as UI-fee receiver
- docs(083): disclose how the platform is actually funded, and name leveraged derivatives
- spec(083): perps position management — spec, plan, research, calldata/state/fee contracts, tasks
- spec(082): perps trade view — spec, plan, research, gateway API contract, tasks

### 🧪 Tests

- test(083): e2e coverage + actor-critic visual review, and the four defects it found

### Artifacts

Range: `v1.6.0..v1.7.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.2.0` |

## v1.6.0 — 2026-08-11

Promoted from: v1.6.0-rc.8
Previous release: v1.5.6 · Range: `v1.5.6..v1.6.0` (38 commits)

### 🚀 Features

- feat(nav): bound the drawer's height — accordions, capped pin strip, filter, compact density (spec 081)
- feat(frontend): make Preferences the app's Settings, as expandable cards
- feat(reports): statement centre with a bottom-sheet generator (#1026)
- feat(reports): branded account statement PDF with charts and report types (#1026)

### 🐛 Bug Fixes

- fix(reports): statement corrections from design and audit review (#1026)
- fix(ci): re-record token-mint mini-app byte baseline, bump its version

### ♻️ Refactoring

- refactor(frontend): give the renamed-tab alias map one home

### 📚 Documentation

- docs(staging): trigger substitutions are not a place for build config
- docs(staging): name the Cloud Build trigger that builds staging, and the trap that emptied it
- docs: consolidate stale has-unread comment in NotificationBell.css

### 🏗️ Infrastructure

- build(cloudbuild): state the build timeout instead of inheriting 600s
- ci(staging): stop CI pretending to deploy staging

### 🧹 Maintenance

- chore(deps): land eslint 9 -> 10 + plugins, fix the new rules it enables
- chore(deps): land this sprint's safe dependency and CI action bumps
- chore(deps): Bump actions/deploy-pages from 4 to 5
- chore(deps): Bump actions/checkout from 4 to 7
- chore(deps): Bump @scure/base from 1.2.6 to 2.2.0
- chore(deps): Bump dorny/paths-filter from 3 to 4

### Artifacts

Range: `v1.5.7..v1.6.0`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | unchanged | — |
| Contract implementations | unchanged | — |
| Mini-app packages | moved | `clearpath` v1.0.1<br>`token-mint` v1.0.2 |
| Subgraph endpoint | moved | `v0.2.0` |

## v1.5.6 — 2026-08-10

Promoted from: none — released directly from main
Previous release: v1.5.5 · Range: `v1.5.5..v1.5.6` (2 commits)

### 🧹 Maintenance

- chore(release): v1.5.5 [skip release]

### Artifacts

Range: `v1.5.5..v1.5.6`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.2.0` |

## v1.5.5 — 2026-08-10

Promoted from: none — released directly from main
Previous release: v1.5.1 · Range: `v1.5.1..v1.5.5` (6 commits)

### 🐛 Bug Fixes

- fix(infra): bundler cutover complete — remove the step that would recreate the deleted Cloud Run service (#1134)
- fix(ci): a release record opened by GITHUB_TOKEN gets no checks and cannot merge (#1130)
- fix(ci): point dependabot at staging so its PRs are mergeable (#1122)

### 🧹 Maintenance

- chore(release): consolidate 10 lost release records, and stop them accumulating (#1119)

### Artifacts

Range: `v1.5.4..v1.5.5`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | unchanged | — |
| Relay gateway image | unchanged | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.2.0` |

## v1.5.1 — 2026-08-10

> **Consolidated record.** This entry covers the whole range **v1.2.5 → v1.5.1**, i.e. it also
> accounts for the commits released as v1.2.6, v1.2.7, v1.2.8, v1.2.9, v1.3.0, v1.3.1, v1.4.0,
> v1.4.1 and v1.4.2. Those tags exist and are immutable, but their individual release-record pull
> requests were never merged — each was branched from `main`, so they accumulated and conflicted
> with one another until the in-repo record was ten versions behind what had actually shipped.
> `.github/workflows/release.yml` now closes superseded records and derives its range from the
> CHANGELOG rather than the last tag, so a record can no longer be silently lost this way.
>
> One earlier entry could not be recovered: **v1.2.4** was tagged but its record was lost before
> this consolidation, and the commits it covered are folded into the v1.2.5 range above it.

Promoted from: none — released directly from main
Previous release: v1.2.5 · Range: `v1.2.5..v1.5.1` (13 commits)

### 🚀 Features

- feat(080): make compiled bytecode path-independent — addresses stop moving when source moves (#1110)
- feat(frontend): rework Address Book into 3a expandable roster (#1113)
- feat(frontend): modernize Address Book UI with colored network pills (#1023) (#1106)

### 🐛 Bug Fixes

- fix(frontend): stop the Bridge quote fetch loop that flickered between pricing and unavailable (#1111)
- fix(deps): drop @uma/core — 1,138 packages (−35.5%) for 199 lines of Solidity (#1089)

### 📚 Documentation

- spec: Hardhat 3 toolchain migration (079) (#1102)

### 🧹 Maintenance

- chore(release): v1.2.5 [skip release] (#1091)
- chore(deps): Bump @scure/bip39 from 1.6.0 to 2.2.0 (#1100)
- chore(deps): Bump express from 4.22.2 to 5.2.1 (#1098)
- chore(deps): Bump release-drafter/release-drafter from 6 to 7 (#1095)
- chore(deps): Bump actions/setup-python from 5 to 7 (#1093)
- chore(deps): Bump actions/setup-go from 5 to 7 (#1094)
- chore(deps-dev): Bump the dev-tooling group across 1 directory with 16 updates (#1084)

## v1.2.5 — 2026-08-09

Promoted from: none — released directly from main
Previous release: v1.2.4 · Range: `v1.2.4..v1.2.5` (3 commits)

### 🐛 Bug Fixes

- fix(release): grant pull-requests write; require same-repo for the release exemption
- fix(release): open a PR for the release record; backfill v1.0.0-v1.2.3

### Artifacts

Range: `v1.2.4..v1.2.5`

| Artifact | Status | Identity |
|---|---|---|
| SPA image | moved | — |
| Relay gateway image | moved | — |
| Contract implementations | unchanged | — |
| Mini-app packages | unchanged | — |
| Subgraph endpoint | moved | `v0.2.0` |

## v1.2.3 — 2026-08-09

Promoted from: none — released directly from main
Previous release: v1.2.2 · Range: `v1.2.2..v1.2.3` (3 commits)

### 🐛 Bug Fixes

- fix(release): refuse unsupported workspace glob shapes instead of guessing
- fix(release): derive the tracked manifest list from the workspace

## v1.2.2 — 2026-08-09

Promoted from: none — released directly from main
Previous release: v1.2.1 · Range: `v1.2.1..v1.2.2` (2 commits)

### 🧹 Maintenance

- chore(deps): scoped overrides for three vulnerable transitive packages (#1021)

## v1.2.1 — 2026-08-09

Promoted from: none — released directly from main
Previous release: v1.2.0 · Range: `v1.2.0..v1.2.1` (4 commits)

### 📚 Documentation

- docs: the platform binary is rolldown's now, not rollup's (spec 077)
- docs: stop telling people to npm install inside a workspace (T047) + three stale claims

## v1.2.0 — 2026-08-09

Promoted from: none — released directly from main
Previous release: v1.1.0 · Range: `v1.1.0..v1.2.0` (3 commits)

### 🚀 Features

- feat(miniapps): app-store rows, details sheet, fixed bottom nav (spec 077 iteration 2)

### 🐛 Bug Fixes

- fix(miniapps): restore swallowed catalog CSS sections; stop the sheet stealing focus

## v1.1.0 — 2026-08-09

Promoted from: none — released directly from main
Previous release: v1.0.1 · Range: `v1.0.1..v1.1.0` (1 commits)

### 🚀 Features

- feat(miniapps): store UX redesign + vite 8 byte-gate resolution (spec 077) (#1082)

## v1.0.1 — 2026-08-09

Promoted from: none — released directly from main
Previous release: v1.0.0 · Range: `v1.0.0..v1.0.1` (4 commits)

### 🐛 Bug Fixes

- fix(admin): SupplyTab and BridgeTab refetched in a loop, not 4x (#1031)

## v1.0.0 — 2026-08-09

Promoted from: none — released directly from main
First release · 2508 commits

### 🚀 Features

- feat(release): version identity, the merge gate, and staging (076 T012-T049)
- feat(release): add the single version-computation authority (076 T001-T011)
- feat(ui): show which build this is at the bottom of the nav drawer
- feat(1019): remove demo mode — the platform runs against live networks now
- feat(075): turbo.json — the declared target graph (US6)
- feat(075): close the by-name boundary gap; drop eslint-plugin-boundaries (US7)
- feat(075): @fairwins/abi — generate ABIs from compiled artifacts (US5, subgraph migrated)
- feat(075): machine-check client/gateway action parity; deps:reinstall (US4)
- feat(075): npm workspaces — one lockfile, 7 members, zero committed bytes changed (US3)
- feat(075): finish US1/US2 and make the version invariants machine-checked
- feat(074): declare the build inputs so the bytecode is reproducible (US1)
- feat(066): staking fee router, admin controls & emergency pause (#958)
- feat(request): receive-any asset catalog + Pay balance-line cleanup (spec 064 follow-up) (#956)
- feat(assets): universal asset selector for Pay/Request/Wager + trade view (spec 064) (#955)
- feat(wallet): fold "acting as" into a caret dropdown on the wallet biticon (#954)
- feat(wallet): the wallet header identity reflects the ACTING account (#952)
- feat(recovery): biometric-first key protection, dark-mode contrast, recovered acting-account (#950)
- feat(recovery): legacy account recovery — encrypted import, all-asset sweep, address book, backup & audit (#949)
- feat(admin): app-wide membership stats + treasury growth on Overview (#918)
- feat(057): Predict — per-user CLOB creds, client-direct trading (Option A) (#912)
- feat(skill): fairwins-infra — bring gasless Cloud Run services up/down for cost (#897)
- feat(054): wager tag naming registry (%tags) — full implementation (#898)
- feat(passkey): global signature→confirmation progress overlay (#894)
- feat(034/036): Tier 2 gasless group pools — factory-forwarder relayer path (#807)
- feat(036/041): harden alto bundler edge + fix gasless CSP connect-src gap (#808)
- feat(wallet): add Pay & Transfer section for gasless stablecoin + native transfers (#809)
- feat(036): wire gasless UX into the no-fund wager write flows (#803)
- feat(036): gasless relayer — build-from-source engine + Mordor deployment + hardening (#802)
- feat(041): Oracle-settled open challenges (Polymarket) (#801)
- feat(034): remove Semaphore from group pools — address-based WagerPool/WagerPoolFactory, relayer-ready, audit-hardened (#793)
- feat(035+036): gasless intent contracts, relay client, and fully configured relayer (#800)
- feat(037): pool activity source — route pool lifecycle into notifications (#785)
- feat(034): ZK-Wager Pools — deploy prerequisites, Mordor launch, relayer (#776)
- feat(address-book): icon-only buttons on mobile, icon+label on desktop (#779)
- feat(address-book): add copy-to-clipboard button per address (#778)
- feat(034): ZK-Wager Pools — resolution UI + My Account language selector (US1/US2) (#775)
- feat(wallet): make My Account section nav a slide-over drawer on mobile (#774)
- feat(clearpath): detect executor-gated treasuries + "Fund from treasury" action (#773)
- feat(clearpath): proposal timeline, vote receipts, bottom-sheet builder, Self recipient (#771)
- feat(swap): network-aware DEX provider — ETCswap on ETC, Uniswap elsewhere (spec 033) (#766)
- feat(backup): encrypted data backup & restore via IPFS + on-chain pointer (spec 032) (#765)
- feat(notifications): platform-wide notification & activity system (spec 031) (#764)
- feat(clearpath): Standard DAOs & External DAO Connectors (spec 030) (#763)
- feat(tokens): spec 028 — token mint & compliant token administration portal (#761)
- feat(subgraph): index oracle adapter conditions (#751) (#758)
- feat(frontend): serve wager reads over RPC on networks without a subgraph (#742)
- feat(landing): replace "Built on X" badge with a "Deployed on" networks section (#740)
- feat(vouchers): buy a quantity, gift to an address, and redeem from a list (#737)
- feat(subgraph): enable membership voucher indexing on deployed testnets (spec 026) (#734)
- feat: open-challenge wagers gated by a shared claim code (024) (#722)
- feat: Upgradeable WagerRegistry via UUPS proxy + reusable UUPSManaged base (025) (#724)
- feat(wagers): gate "either side submits outcome" to equal-stakes bets (#719)
- feat(notifications): source draw proposals from the subgraph (kill eth_getLogs) (#714)
- feat(017): deploy v2 WagerRegistry subgraph to Studio + resolve Amoy block (#707) (#709)
- feat(019): My Wagers automatic views & simplification
- feat(018): My Wagers views & privacy feedback
- feat(subgraph): index v2 WagerRegistry + per-transfer WagerTransfer records (Spec 017)
- feat(017): My Wagers card grid redesign
- feat(verify): multi-chain contract source verification
- feat(mordor): deploy core v2 to Mordor + Network-tab integration (Spec 015)
- feat(frontend): relocate network selector to My Account, simplify wallet menu
- feat(frontend): wager activity notifications — bell, feed, badges, warnings (spec 012)
- feat(frontend): quick variant for the dashboard Share Account QR
- feat(frontend): Share Account quick action on the dashboard
- feat(frontend): QR color customization with persisted palette choice (spec 011, US3)
- feat(frontend): copy and share actions in address QR modal (spec 011, US2)
- feat(frontend): address QR display in Account tab (spec 011, US1)
- feat(008): chain-aware wager surface — list, create, accept, admin (batch 2)
- feat(008): chain-aware sanctions screen + key registry service (batch 1)
- feat(008): make useSiteStats chain-aware (T014)
- feat(008): scope local role/purchase cache per (chainId, account)
- feat(008): chain-aware membership read hooks + shared network notice (MVP slice)
- feat(007): pre-launch lockdown script + mainnet cutover runbook
- feat(007): membership migration script for the full cutover (dry-run by default)
- feat(007): compliance gating US4–US6 — entry gate, membership attestation, key-gen eligibility
- feat(007): compliance & legal gating — geo-gate, sanctions screening, versioned docs
- feat(dev): local Hardhat dev environment with two funded wallets (Spec Kit 006) (#639)
- feat(dev): local Hardhat dev environment with two funded wallets (Spec Kit 006)
- feat(005): Arbitrating tab in MyMarketsModal + Dashboard button-driven flow tests
- feat(005): re-enable ThirdParty create flow — arbitrator input, key-gate, encrypt-for-arbitrator
- feat(create): collapse the Private Wager encryption explainer behind a disclosure
- feat(005): index the arbitrator in createWager for discovery (composed into 004 v3)
- feat(005): FR-010 terms-unavailable state in wager detail view (T013a + T009a)
- feat(draw): implement Draw resolution (both stakes returned) — Spec Kit 004 US1+US2+US3
- feat(frontend): Polymarket-only oracle UI behind VITE_ORACLE_MODELS (Spec Kit 003)
- feat: route membership sales to chipprbots.eth treasury (Polygon)
- feat(frontend): make Polygon mainnet (137) the primary/default network
- feat(wagers): surface market selection at top with resolution-type tabs (#623)
- feat: add Claim Refund button for wagers past resolution deadline (#615)
- feat: overhaul E2E test suite and fuzzing to cover FairWins functional checklist (#608)
- feat: add wager withdraw and decline functionality (#606)
- feat: store metadataUri on-chain so both participants can decrypt wager messages (#602)
- feat(wagers): per-user EnumerableSet index for O(N_user) lookups
- feat(frontend): replace demo mode toggle with Amoy/Polygon network switcher
- feat(frontend): auto-register encryption key during membership purchase
- feat(frontend): replace static welcome modal with interactive onboarding tutorial
- feat(frontend): condition picker + 3 new oracle types in createWager dropdown
- feat(admin): oracle adapter administration tab + cleanup dead enum
- feat(p2p-roles): refocus protocol on P2P wagers with operator-power separation
- feat(oracles): add Chainlink + UMA wager resolution adapters
- feat(membership): Lower Friend Market entry to $1 and trim UI to enforced limits
- feat(frontend): collapse Polymarket browser once a market is linked
- feat: lock linked-market end time and shorten wager timing
- feat(frontend): auto-start QR scanner, fix scan icon, accept ENS for opponent/arbitrator
- feat(frontend): require creator to declare their side on linked-market bets
- feat(frontend): paginated My Wagers view with subgraph-backed scale
- feat(frontend): add Polymarket top-markets browser to dashboard and wager modal
- feat(frontend): wire Uniswap V3 + Testnet/Mainnet toggle + Polymarket linked-market lookup
- feat: default to Polygon Amoy across the stack
- feat(frontend): chain-aware token labels + theme-aware Mordor banner
- feat: migrate to Polygon Amoy + Polymarket-pegged side-bet E2E
- feat: implement market search and launch navigation in UserManagementModal
- feat: update ZKKeyManager constructor to require initial admin address and add deployment configuration for Mordor network
- feat: add key registry service for on-chain encryption key management
- feat: implement FriendMarketsContext for centralized friend market management and refactor components to use context
- feat: implement shared signature handling for encrypted wagers in MarketAcceptanceModal and FriendMarketsModal
- feat: enhance MarketAcceptanceModal with encryption handling and UI updates
- feat: add new wager statuses and update handling in various components
- feat: privacy-preserving market lookup with event-based discovery
- feat: Complete P2P wager UX update across onboarding, sidebar, and landing CSS
- feat: Update landing page and dashboard to P2P wager-first UX
- feat: Add network-aware oracle availability detection
- feat: Add OracleRegistry integration to FriendGroupMarketFactory (PR8)
- feat: Add UMAOracleAdapter for arbitrary truth assertions (PR7)
- feat: Add ChainlinkOracleAdapter for price-based conditions (PR6)
- feat: Add IOracleAdapter interface and OracleRegistry (PR5)
- feat: Add oracle timeout fallback mechanism (PR4)
- feat: Add claim timeout with treasury fallback (PR3)
- feat: Add challenge period for manual resolutions (PR2)
- feat: Implement claimWinnings() function for stake transfers (PR1)
- feat: Add interactive onboarding tutorial for new users
- feat: Add Polymarket oracle resolution for private markets
- feat: Add friend market notification system with unread indicators and expiration handling
- feat: Add Multicall3 ABI and implement batch fetching for market categories and statuses
- feat: Implement infinite scroll for market grid
- feat: implement lazy loading for IPFS envelopes and metadata in FriendMarketsModal
- feat: implement conditional logger utility and replace console logs with logger methods; increase polling intervals to reduce load
- feat: Update FriendGroupMarketFactory to support Bookmaker markets and resolution types
- feat: add ClearPathUserModal and ClearPathProModal exports; enhance TokenManagementModal styles and functionality
- feat: enhance market metadata generation and improve description parsing in components
- feat: update IPFS gateway to use Pinata Cloud for deployment
- feat: enhance WalletButton role verification by adding RoleManager fallback
- feat: implement nginx proxy for Pinata API with runtime JWT substitution
- feat: add Cloud Build configuration for Docker image build and deployment
- feat: add Perpetual Futures Education Modal and enhance position fetching logic
- feat: add cron scripts for perpetual futures funding settlement and health checks
- feat: consolidate role grant scripts into a single configurable script
- feat: Add error handling and retry mechanism for market decryption
- feat: Implement lazy market decryption for improved performance and UX
- feat: Enhance envelope encryption documentation with IPFS storage details and benefits
- feat: Implement X-Wing post-quantum encryption and decryption functions
- feat: implement transaction progress component and enhance market acceptance modal with encryption handling
- feat: add documentation for private prediction markets and envelope encryption
- feat: enhance market display titles to handle encrypted and private markets
- feat: implement versioned signing messages and update encryption functions for backward compatibility
- feat: implement share modal for FriendMarkets and enhance market status handling
- feat: add role manager configuration for ConditionalMarketFactory and update deployment scripts
- feat: enhance market acceptance functionality with encrypted market handling and dynamic token info
- feat: update TieredRoleManager address and improve contract address retrieval in MarketAcceptancePage
- feat: enhance WalletContext to clear stale WalletConnect data on mount and during disconnect
- feat: configure PaymentProcessor to use TieredRoleManager for role grants
- feat: add script to setup admin roles and configure tier prices in USC
- feat(deploy): update contract addresses and deployment scripts for Mordor network
- feat(deploy): add new deployment scripts and constants for FriendGroupMarketFactory and role management
- feat: Implement birth certificate creation and verification for clones
- feat: add integrity module for floppy keystore with Merkle tree and signing
- feat: add ENS DID support (did:ens)
- feat: add AT Protocol (Bluesky) DID support
- feat: add x402 protocol support for HTTP-native payments
- feat: add agent identity and persistent memory storage
- feat: add multi-chain support to floppy keystore skill
- feat: extract floppy disk keystore as Claude skill
- feat: Update tier pricing mechanism to fetch from TierRegistry contract and adjust fallback prices
- feat: Add FriendGroupMarketFactory balance and withdrawal functionality to AdminPanel
- feat: Implement TreasuryVault management in AdminPanel
- feat: Integrate nullifier system for anti-money laundering protections in FriendGroupMarketFactory and update related documentation
- feat: Add technical specifications and user guide for private market encryption
- feat: Enhance market handling with encrypted metadata support and role management script
- feat: Add scripts for building frontend and managing TierRegistryAdapter deployment and configuration
- feat: Enhance role synchronization logic and add admin scripts for tier management
- feat: Implement unified session manager for encrypted communications in friend markets
- feat: implement functionality to create NFL Divisional Round prediction markets
- feat: implement functionality to create NFL Divisional Round prediction markets
- feat: add utility scripts for contract verification and testing
- feat: implement test script for floppy key management
- feat: add floppy disk keystore management
- feat: Redeploy FriendGroupMarketFactory with updated approval logic and enhance WalletButton for native token handling
- feat: Add Market Acceptance Modal and enhance FriendMarketsModal with acceptance functionality
- feat: Implement user tier loading and syncing for premium purchase modal
- feat: implement tiered membership system in RolePurchaseModal and related components fix: update FriendGroupMarketFactory constructor to accept owner address style: enhance RolePurchaseModal CSS for tier selection and responsiveness chore: update contract addresses in deployment scripts and config files fix: correct role manager address in ConditionalMarketFactory
- feat: add MarketAcceptancePage for handling market acceptance via QR codes
- feat: Add nullification restriction to TreasuryVault withdrawals
- feat: Add RSA accumulator-based nullifier system for market protection
- feat: Enhance LandingPage with social media links and membership contact information
- feat: Implement modular role management system with PaymentProcessor, RoleManagerCore, TierRegistry, UsageTracker, and MembershipManager contracts
- feat: Introduce TieredRoleManagerLite for gas-constrained deployments; implement lazy initialization for tier metadata and enhance deployment script with additional checks
- feat: Add Safe Singleton Factory support for contract initialization and ownership transfer
- feat: Implement comprehensive vault contracts for DAO treasury and market collateral management

### 🐛 Bug Fixes

- fix: remove duplicate portfolio balance header (#1078)
- fix(release): the release pipeline silently published nothing
- fix(release): branch-policy violated two of the repo's own CI gates
- fix(release): the constitution-IV check must match the YAML key, not the word
- fix(release): the promotion rule cannot apply before staging exists
- fix(turbo): close the last three #1036 items
- fix(test): BridgeView screening asserted call ORDER, not the requirement
- fix(spec-075): the ethers fixture GATE 2 was recorded as passing without (#1040)
- fix(eip712): consolidate the domains and gate them against the Solidity (#1038)
- fix(gates): five gates that passed in the states they exist to catch (#1039)
- fix(test): the package boundary gate saw only the minority import style (#1037)
- fix(turbo): three undeclared inputs that could serve a wrong cache hit (#1036)
- fix(test): AdminBridgeTab has the same authority race #1029 fixed in its sibling
- fix(ci): my own container job tripped the exit-code guard
- fix(ci): the two byte-reproducibility gates were never wired into CI
- fix(build): both shipped container images were broken by the workspace conversion
- fix(ci): two more workflows skipped PRs that target a feature branch
- fix(test): the AEAD tamper test sometimes did not tamper
- fix(wallet): read the chain from the WALLET, not from wagmi's config (#1030)
- fix(test): AdminSupplyTab awaited the pool list, then raced the authority read (#1029)
- fix(e2e): WAL-08/09 tested an unreachable banner; make the mock's chain real
- fix(ci): correct the torture-test artifact retention table
- fix(ci): stop the artifact quota from failing every job (-86% per-run bytes)
- fix(1028): arbitrator by real id; CRE-08 asserts render not viewport
- fix(1019,1028): three from the pattern sweep — one is green-but-vacuous on the gate
- fix(1028): assert the success screen EXISTS, not that it is visible
- fix(1028): key seeding works on a fresh chain; keypad waits for its own effect
- fix(1028): the post-submit assertion never waited for the transaction
- fix(1028): wagers can now be created — encryption keys were an unmet precondition
- fix(1028): the four deep full-tier defects, plus the three shared blockers
- fix(e2e,ci): a test that never tested its own name, and the twin of a bug I fixed once
- fix(075): add the Slither finding my baseline regex could not match
- fix(075): baseline Slither's pre-existing High findings so the gate can stay on
- fix(075): pin eslint-plugin-react-hooks to main's version; correct a wrong claim
- fix(075): four CI defects the first pipeline run exposed
- fix(075): mount the root node_modules for Matchstick under workspaces
- fix(075): repoint the subgraph CI guard at the generated ABIs
- fix(075): lift activity-feed group headers out of the list (real a11y defect)
- fix(074): repair the CI gates that could not fail (US2, partial)
- fix(infra): make the single-alto gate fail CLOSED (it started a second executor) (#1002)
- fix(clearpath): repoint two host hooks at the host-side copy after the conversion
- fix(reports): read the chain the report is about, not the build default
- fix: repair the 11 pre-existing frontend test failures
- fix(supply): drop stale HubPool reads; close T144-T150 (#971)
- fix: add scripts/ops/register-fee-service.js, omitted from #969 (#970)
- fix(earn): scope Morpho attribution to Lend and Rewards views (#964)
- fix(my-wagers): lift sheet above mobile bottom nav (#953)
- fix(pwa): shorten install name to 🍀Fairwins (#919)
- fix: preferences toggle switches render as squares on mobile (#916)
- fix(057): wire POLYMARKET_API_ADDRESS from secret in gateway manifest (#911)
- fix(055): launch feedback — Collect label, merged portfolio section, image CSP + deploy wiring (#905)
- fix(frontend): mobile UX — lock viewport, fix modal/menu layering, theme-aware membership card (#903)
- fix(alto): switch Polygon bundler RPC to QuickNode (publicnode archive-403) (#895)
- fix(open-challenge): let passkey takers connect + accept, render terms as prose (#896)
- fix(frontend): let oracle challenge market picker fill the bottom sheet (#851)
- fix(041): clarify oracle open challenge is a peer-to-peer wager (#805)
- fix(039): make info-tooltip triggers blend into labels and read more compact (#798)
- fix(034): make pool nicknames deterministic across users (normalize address casing) (#792)
- fix(034): add wasm-unsafe-eval to the PRODUCTION nginx CSP template (#791)
- fix(ci): apply Semaphore viaIR:false override so contract compile stops timing out (#788)
- fix(024): open-challenge screen patches from testing feedback (#787)
- fix(034): load Semaphore packages via static dynamic import (join was broken) (#781)
- fix(clearpath): gate Execute on timelock ETA, decode revert errors, copy proposal id (#772)
- fix(clearpath): decode ProposalCreated positionally — fixes values .map crash (#770)
- fix(clearpath): two DAO-view bugs — false over-treasury warning + proposal indexing on ETC (#769)
- fix(frontend): flag estimated tier prices when MembershipManager is unreachable (#752) (#756)
- fix(open-challenge): code-key decrypt, deadlines, arbitrator picker, subtle tx (#746)
- fix(csp): allow Mordor/Polygon/ETC RPC hosts in connect-src (#744)
- fix(frontend): disable ethers RPC batching on Ethereum Classic (Mordor reads) (#743)
- fix(frontend): voucher purchase crash + link redeem T&C to a vouchers terms section (#736)
- fix(open-challenge): approve stake before accepting + show funding steps (#733)
- fix(frontend): sync membershipVoucher address to per-network config (#732)
- fix(frontend): complete membership/voucher ABIs + chain-guard, deploy feature-complete Mordor (#730)
- fix(wagers): My Wagers open-challenge display — stake decimals + "Open Challenge" label (#728)
- fix(frontend): address UX tester feedback on My Account & Admin (#725)
- fix(account-stats): correct declined-wager P&L and wire real USDC wallet balance (#713)
- fix(csp): allow api.studio.thegraph.com in connect-src (subgraph) (#712)
- fix(landing): default landing header to dark mode (#711)
- fix(frontend): show wager details on acceptance screen, sync accept-by time, readable notification bell
- fix(frontend): stop border-box padding from collapsing icon-only buttons
- fix(frontend): refresh stale MembershipManager ABI (purchaseTierWithTerms)
- fix(encryption): stop double sign prompt and false "keys not initialized" on wager creation
- fix: allow camera=(self) in production nginx template so QR scanner works
- fix: nginx security-header inheritance, visible scanner error, drop dead deploy workflow
- fix(010): UAT footer & policy-document corrections
- fix(009): allow same-origin camera so the QR scanner works
- fix(009): theme-independent QR rendering + visible scan-button icon
- fix(frontend): read membership tier from the wallet's chain in purchase modal
- fix(frontend): resolve membership-purchase contract by wallet chain
- fix(007): de-dupe synced contract keys + fix sync regex (no-dupe-keys)
- fix(007): wrap lockdown signer in NonceManager for sequential txs
- fix(007): allow LOG_CHUNK override for getLogs paging in migration
- fix(007): make deploy.js resilient to load-balanced RPC nonce lag
- fix(007): persist sanctionsGuard in deployment record + add sync:polygon script
- fix(007): screen grantee in MembershipManager.grantMembership (security review)
- fix(007): address Copilot PR review (#641)
- fix(modals): show Polymarket search in the oracle flow + remove wager items from wallet dropdown
- fix(e2e): mock wallet write-transaction support — UI writes now work
- fix(oracle): PolymarketOracleAdapter takes admin ctor arg (Ownable(admin))
- fix(oracle): refund Polymarket wagers on a tie instead of paying a fixed side
- fix(frontend): resolve six E2E testing bugs (#619)
- fix(wagers): correct resolve timing, clarify outcomes, honest finality UX (#618)
- fix: address critical security findings (#617)
- fix: remove countdown gate on resolve — show button immediately (#616)
- fix: allow both parties to resolve wagers and add resolution window (#614)
- fix: use exact trading period seconds instead of ceil-rounded days for resolve deadline (#612)
- fix: bronze members blocked from creating wagers due to stale concurrent count (#611)
- fix(my-wagers): treat expired pending offers as terminal, fix stale time-left, add Clear/Reclaim path (#609)
- fix: display correct USDC balance when DEX is not configured (#610)
- fix: make acceptance deadline deterministic instead of user-editable (#604)
- fix(my-wagers): derive selectedMarket from id so detail view sees decryption (#603)
- fix(encryption): use X25519 for 1v1 envelopes that add recipients via KeyRegistry
- fix: remove unused getDefaultAcceptanceDeadline import
- fix: auto-set acceptance deadline to midpoint between now and end time
- fix: display USDC balance instead of hardcoded "USC" in wallet dropdown
- fix: update Get USDC button link to Circle faucet (testnet) and Uniswap (mainnet)
- fix(lint): remove unused networkMode and listSupportedChainIds
- fix(frontend): validate MembershipManager contract exists before calling paymentToken()
- fix(a11y): fix Lighthouse target-size failure in onboarding tutorial
- fix(frontend): add oracle resolution methods to onboarding tutorial
- fix(frontend): update welcome modal to reflect peer-to-peer wager mechanics
- fix(frontend): make wager creation modal scrollable
- fix(frontend): wire Polymarket-pegged side bets end-to-end
- fix(oracles): adapter ownership under deterministic deploy + Amoy v2 deploy
- fix(frontend): restore wager modal scroll + spacing CSS
- fix(frontend): clear lint errors unmasked by the etcswap → dex fix
- fix(frontend): green the pipeline for the P2P role refactor
- fix(frontend): silence QR scanner close error and strip text chrome
- fix(frontend): slim dashboard header, theme toggle, collapsible Polymarket feed
- fix(frontend): drop cent prices from linked-market side picker buttons
- fix(frontend): lazy-load footer logo to clear Lighthouse offscreen-images
- fix(frontend): allow gamma-api.polymarket.com in CSP connect-src
- fix(frontend): consolidate header nav into wallet menu and fix theme styling
- fix(frontend): clear lingering setZkPublicKey + unused networkMode
- fix(frontend): drop dead Peg-to-Wager UI block and stale unused refs
- fix(ci): repair sed-mangled mock data, hook deps, and stale test expectations
- fix(frontend): accept any supported chain, not just one EXPECTED_CHAIN_ID
- fix: use wagmi provider/signer for key registration instead of window.ethereum
- fix: update ZKKeyManager deployment to require owner address refactor: remove unused mockPositions from MyMarketsModal tests
- fix: enhance wager cancellation handling and improve error messages
- fix: add missing FRIEND_GROUP_MARKET_FACTORY_ABI and ResolutionType exports
- fix: update frontend tests to match offer/wager terminology
- fix: resolve wager acceptance failure caused by proposalId collision
- fix: reliably fetch and display active wagers for connected wallets
- fix: wager creation error hidden by state race + add staticCall pre-check
- fix: wager creation silent failure and market resolution not implemented
- fix: sync deployment JSONs with latest redeployed contract addresses on Mordor
- fix: Resolve ESLint errors in Dashboard and test file
- fix: add window existence check in WalletContext
- fix: add global observer mocks and fix loading state test
- fix: resolve ESLint errors in OnboardingTutorial and FairWinsAppNew
- fix: regenerate package-lock.json files for CI sync
- fix: Apply PR review feedback - accessibility improvements and Cypress guard
- fix: update test to reflect notification system behavior
- fix: improve state management efficiency in notification hook
- fix: resolve linter errors in friend market notifications
- fix: regenerate frontend package-lock.json for CI compatibility
- fix: sync package-lock.json files with package.json dependencies
- fix: ensure menu closes on screen size change and improve click handling for kebab menu items
- fix: Resolve artifact naming conflicts in CI workflows
- fix: Address PR review feedback for post-quantum encryption
- fix: Mock Pinata credentials in ipfsService tests for CI
- fix: Remove unused imports and variables to pass linting
- fix: Regenerate package-lock.json files for CI compatibility
- fix: remove unnecessary URLs from Lighthouse configuration
- fix: update tests to use buyer1 as msg.sender for processPayment
- fix: address Slither static analysis findings
- fix: add --via-ir flag to Manticore solc compilation
- fix: Update package-lock.json to sync with package.json dependencies
- fix: Re-export computeMarketHashSimple from primeMapping utility
- fix: Remove contact information from development warning modal message
- fix: Improve error handling for contract deployment and ensure deployer signer availability

### ⚡ Performance

- perf(infra): right-size the gasless Cloud Run services (-$98.55/mo) (#1000)

### ♻️ Refactoring

- refactor(075): extract @fairwins/intent-types — one EIP-712 source (US4, extraction only)
- refactor(054): rename "wager tag" → "Callsign" across the stack + redeploy (#900)
- refactor(wallet): use vendor-neutral "Browser Wallet" default + bump web3 deps (#777)
- refactor(landing): move deployed-networks into a subtle header crawler (#745)
- refactor(frontend): Wire up v2 createWager/acceptWager/declareWinner flows
- refactor: Rebuild on-chain layer for P2P betting
- refactor(frontend): focus FriendMarketsModal on creation; migrate viewing to MyMarketsModal
- refactor(frontend): drop ClearPath/TokenMint UI and finish ETC→USDC sweep
- refactor(frontend): drop ETC/Mordor framing from UI copy, mock data, and tests
- refactor(frontend): rename ETCswap → Dex and drop limited-functionality banner
- refactor: Update key registration logic to ensure key is registered only if needed and handle existing keys gracefully
- refactor: Enhance Header component for app mode and update WalletPage layout
- refactor: Update Dashboard component to use new wallet connection hook and adjust tests accordingly
- refactor: Update onboarding tutorial to reflect new resolution methods and remove oracle references
- refactor: rename "market" to "wager" throughout the application for consistency
- refactor: improve code clarity per review feedback
- refactor: update token creation modal to use radio inputs for selection and improve accessibility
- refactor: simplify FRIEND_MARKET role verification by removing unused variables
- refactor: clean up imports and variable names in tests and components
- refactor: replace CONTRACT_ADDRESSES with getContractAddress for factory address retrieval
- refactor: simplify data loading logic in components and ensure cleanup on unmount
- refactor: Reorganize smart contracts into logical folder structure

### 📚 Documentation

- docs(release): record quickstart validation and the operational gap (076 T050-T052)
- spec(076): narrow the no-implementation-details claim, fix problem-statement grammar
- spec(076): monorepo semantic versioning and release promotion
- docs(claude): correct three claims that went stale (#1038, spec 075)
- docs(075): T023 is done — all six E2E layers resolved
- docs(075): repair a tasks.md line mangled by shell backtick expansion
- docs(075): CLAUDE.md guardrail for the workspace + the two monorepo skills
- docs(075): add monorepo-workspace + monorepo-verify skills
- docs(074): spec + plan for monorepo workspaces, packages, and a target graph
- docs: state what the loader actually verifies, not more
- docs: publish the mini-app guide and runbook in the nav
- docs: point the open-challenges guide at Transfer → Wagers
- docs(blog): announce the staking feature (#959)
- docs(065): specify Earn liquid & delegated staking feature (#957)
- spec(063): universal acting-account + cross-chain legacy recovery (design) (#951)
- docs(blog): add 18 Finance Professional Series briefings (#947)
- docs(blog): add 20 Knowledge Base concept primers with schedule (#946)
- docs(blog): rewrite all 34 posts for a semi-technical audience (#945)
- docs(blog): blockchain architecture blog program — inventory + 34 drafted posts (#943)
- spec(056): collectibles sell-side trading (Phase 2) — specify (#907)
- docs(research): OpenSea SDK analysis for minimal in-app NFT trading (#904)
- docs(035,036): intent-based signatures + relayer infrastructure specs (#783)
- spec(034): ZK-Wager Pools — group pools, 4-word gateway, anonymous consensus (#768)
- docs(specs): close shipped-but-unmarked tasks (024/025/026/027) + deploy README (#739)
- docs: remove archived futarchy drift from governance & security (#738)
- docs: align docs with UUPS proxies + open challenges + vouchers (#735)
- spec: membership purchase progress indicator (022) (#718)
- docs: design-agent prompt for My Account stats dashboard (#710)
- docs(spec): add Spec 017 — v2 WagerRegistry subgraph + per-transfer records
- spec(017): clarify surface, detail view, tab labels
- spec(017): My Wagers card grid redesign
- docs(reference): rewrite API/contracts/configuration for v2; archive unshipped badge spec
- docs: refresh documentation to match the live v2 P2P wager system
- docs(009): spec, plan, and tasks for QR share & scan rendering
- spec(008): runtime chain consistency across frontend modals
- docs(speckit): 007 compliance-gating spec/plan/tasks/research/data-model/contracts
- spec: Polymarket-only oracle selection (frontend) — /speckit-specify
- spec: complete remaining E2E stubs (encryption, privacy, lifecycle) — /speckit-specify
- spec: Cypress E2E flow coverage (Spec Kit) + remove obsolete dispute spec
- docs: add FairWins functional testing checklist (#607)
- docs: fix leftover token symbol text regressions
- docs(vault): drop ETC mainnet/Mordor RPC entries from example .env
- docs: drop ETC/Mordor framing from active docs and runbook copy
- docs: plan Polygon Amoy migration to unblock Polymarket-pegged side bets
- docs: Update documentation for P2P wager pivot, archive 27 outdated files
- docs: Update README to reflect P2P wager management focus
- docs: Add comprehensive implementation plan and updated flow diagrams
- docs: Add comprehensive system flow diagrams and consistency analysis
- docs: Add P2P wager platform architecture assessment
- docs: Add comprehensive nullifier system documentation

### 🧪 Tests

- test(1028): membership headroom + deterministic address-resolution wait
- test(1028): seed encryption keys in the wager specs; harden the seeding command
- test(075): get Cypress past the entry gate (T023, layer 1 of at least 3)
- test(074): mini-app byte-reproducibility gate + recorded baseline (US3 prereq)
- test(coverage): include access/upgradeable/integration suites in contract coverage (#748)
- test(024): close the open-challenge hardening test gaps + evidence coverage (#741)
- test(008): regression guard for build-bound chain resolution (FR-011)
- test(007): set VITE_ORACLE_MODELS=all for FriendMarketsModal oracle specs
- test(oracle-hiding): component-level coverage + fix conditional help-text leak
- test(e2e): harden specs per adversarial review (kill false-confidence)
- test(e2e): US3 encrypted privacy round-trip (T006-T007)
- test(e2e): US2 on-chain key registration (T004-T005)
- test(e2e): foundation (T001-T002) + US1 lifecycle journeys (T003)
- test(e2e): salt prepareCondition questionId for node-reuse robustness
- test(e2e): implement US4 oracle-resolution (Polymarket + tie fix)
- test(e2e): implement US3 refund-timeout
- test(e2e): implement US6 admin-panel (read-only)
- test(e2e): implement US2 frozen-accounts + US5 expired-membership
- test(e2e): stabilize createAndAcceptWager via chainTx (verified on live chain)
- test(e2e): US1 paused-protocol — PAU-01 verified on live chain-1337 loop
- test(e2e): suppress dev-warning modal/banner overlays in mockWeb3Provider
- test: update getContractAddressForChain test for the now-live Polygon deployment
- test: add PolymarketOracleAdapter unit suite + lifecycle E2E; measure oracle coverage
- test(admin): drop unused txReceipt destructure to fix lint
- test(smoke): replay patched modal's contract calls on Amoy
- test: Add end-to-end smoke test for the v2 wager lifecycle
- test(frontend): repair Dashboard.test mocks after demoMode + DexContext changes
- test: Add FriendGroupMarketFactory UMA oracle integration tests
- test: Add FriendGroupMarketFactory oracle integration tests
- test: Add OracleRegistry tests and MockOracleAdapter (PR5)
- test: update market metadata tests to store resolution criteria separately and add description parsing tests

### 🏗️ Infrastructure

- ci: draft PRs no longer run CI; stop uploading videos of passing runs
- ci(subgraph): run Matchstick via vendored Docker image
- ci: stop the weekly torture test from spuriously failing
- ci(oracles): soft-skip fork tests on PRs without AMOY_RPC_URL secret

### 🧹 Maintenance

- chore: remove the vestigial pool relayer (#1062)
- chore(deps): Bump @solana/kit from 5.5.1 to 7.0.0
- chore(deps): Bump actions/upload-pages-artifact from 3 to 5
- chore(deps): Bump actions/setup-node from 4 to 7
- chore(deps): Bump actions/github-script from 7 to 9
- chore(deps): ignore hardhat TOOLCHAIN majors, not just hardhat itself
- chore(deps): Bump @solana-program/system from 0.10.0 to 0.13.0
- chore(deps): Bump actions/cache from 4 to 6
- chore(deps): Bump actions/upload-artifact from 4 to 7
- chore(deps): Bump actions/download-artifact from 4 to 8
- chore(075): dependabot + mechanise the archive rule (Polish)
- chore(075): drop 4 unused frontend deps (US3 prerequisite, T035)
- chore(075): renumber 074 -> 075 (spec-number collision with unified-my-account)
- chore(057): pin gateway image to predict-058 (builder-sign live) (#913)
- chore(054): record WagerTagRegistry Polygon mainnet deploy (#899)
- chore(frontend): point Amoy subgraph at fairwins-amoy v0.3.0 (#759)
- chore(frontend): remove dead code surfaced by audit (#753, #754) (#757)
- chore(deploy): Amoy (80002) — feature-complete set (UUPS membership + voucher) (#731)
- chore(deploy): Amoy (80002) — UUPS WagerRegistry + 024 open challenges (#729)
- chore: enable frontend-design plugin; gitignore .playwright-mcp artifacts (#716)
- chore(deploy): redeploy v2 contracts on Polygon Amoy to mainnet parity
- chore(spec-012): mark T033 complete — PR #651 opened
- chore(spec-011): record T021 complete; T020 awaits manual device matrix
- chore(spec-011): polish gates, lint fix, and analysis remediations
- chore(ci): upgrade Node.js 20 → 22 across CI workflows and Dockerfiles
- chore(007): sync frontend to Polygon 137 cutover addresses
- chore(007): record Polygon mainnet (137) cutover addresses
- chore(007): add deploy:polygon npm script
- chore(007): mark T052 — Slither static analysis green in CI
- chore(007): mark Phase 9 a11y/CI/docs tasks complete
- chore(007): phase 9 — a11y tests, fork-test CI wiring, deploy/migration runbook
- chore(005): mark T005/T010 (contract, on 004 branch) + T009a/T013a (FR-010) complete
- chore: set up Spec Kit for spec-driven feature development (#628)
- chore(frontend): wire Polygon mainnet (137) config for live v2 deployment
- chore: update frontend package-lock.json
- revert(frontend): re-apply create-only wager modal from PR #582
- chore(oracles): clean up obsolete comment in UMA CEI block
- chore(oracles): close UMA reentrancy gap, add registry tests + fork CI
- chore(frontend): Move orphan futarchy UI to legacy/
- chore: strip dead ClearPath/TokenMint CSS, theme, and doc stragglers
- chore: catch leftover ETC label in archived perpetual-futures deploy script
- chore: finish ETC/Mordor/USC → MATIC/USDC sweep across non-frontend
- chore(nginx): swap Mordor/ETC RPC hosts for Polygon Amoy in CSP
- chore: final ETC → MATIC sweep across scripts, tests, and contracts list
- chore: strip ETC/Mordor framing from contracts, scripts, tests, and env
- chore: remove Mordor chain from network config and deploy paths
- chore: trigger frontend rebuild after wager terminology refactor
- chore: update dependencies in package.json
- chore: sync package-lock.json files
- style: update card description styling for improved visibility and adjust stats row positioning
- chore: add @walletconnect/ethereum-provider dependency

<!-- RELEASES:END -->
