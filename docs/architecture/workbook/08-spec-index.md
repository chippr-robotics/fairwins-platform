# 08 — Annex: Spec Index

> FairWins is developed spec-first: `specs/<NNN>-<slug>/` is where a capability is
> defined before it is built, and the number is claimed by **merging a reservation
> PR**, never by computing `max+1`. This annex maps every spec directory to the
> capability it delivers.
>
> **Read the status column with suspicion.** It reproduces the `**Status**` line
> recorded in each `spec.md`. "Draft" on an early spec usually means the *document*
> was never re-stamped, not that the capability is unshipped — the deployment
> records in [Annex 07](07-onchain-estate.md) and the code are better evidence.
>
> Five numbers (`017`, `041`, `050`, `102`, `104`) name two unrelated features
> each. These are pre-gate collisions, frozen in `LEGACY_COLLISIONS` under Spec
> Registry rule S-04 — the list shrinks when a pair is renumbered and fails if an
> entry outlives the collision it excuses. Spec `029` does not exist.


| # | Title | Capability delivered | Recorded status |
|---|---|---|---|
| 001 | Cypress End-to-End Test Flow Coverage | E2E harness for member flows | Draft (superseded by 094) |
| 002 | Remaining E2E Stubs (Encryption, Privacy, Lifecycle) | E2E coverage of encryption + lifecycle | Draft |
| 003 | Polymarket-Only Oracle Selection (Frontend) | Oracle picker narrowing in create | Draft |
| 004 | Draw Resolution | Wager draw path, both stakes returned | Draft (shipped: `WagerDrawn`) |
| 005 | Multi-Recipient Wager Encryption | Terms encrypted to participants + arbitrator | Draft |
| 006 | Local Dev Environment | Local chain + `setup:e2e` | Draft |
| 007 | Compliance & Legal Gating Layer | Geo gate (HTTP 451), legal docs, policy gating | Draft (live; CODEOWNERS-protected) |
| 008 | Runtime Chain Consistency Across Modals | One active chain per write, consistently | Draft |
| 009 | Fix QR Share & Scan Rendering | Share a wager by QR | Draft |
| 010 | Footer & Policy-Document Corrections | Legal footer accuracy | Draft |
| 011 | Wallet Address QR Display & Sharing | Receive-address QR | Draft |
| 012 | Wager Activity Notifications | Per-wager notifications | Draft |
| 013 | Polymarket Search & Category Filter | Market discovery | Draft |
| 014 | Quick Action Dashboard Redesign | Home dashboard | Draft (superseded by 053/058) |
| 015 | Mordor Network Deployment | ETC testnet cohort | Draft (deployed) |
| 016 | Wager Tax & Activity Report Generation | Reporting tab | Draft |
| 017 | v2 WagerRegistry subgraph + per-transfer records | Indexing for wager/transfer history | Draft (number collision) |
| 017 | My Wagers — Card Grid Redesign | Wager list UI | Draft (number collision; superseded by 078) |
| 018 | My Wagers — Views & Privacy Feedback | Wager list views | Draft (superseded by 078) |
| 019 | My Wagers — Automatic Views & Simplification | Wager list views | Draft (superseded by 078) |
| 020 | My Account Stats Dashboard | Accounts ▸ Stats view | Draft |
| 021 | Address Book | Contacts + identity resolution + screening pills | Draft (shipped; amended by #1458) |
| 022 | Membership Purchase Progress Indicator | Purchase UX | Draft |
| 023 | Oracle & Graph Network Gating | Per-chain oracle/subgraph availability | Draft |
| 024 | Open-Challenge Wagers Gated by a Claim Code | Open challenges (four-word code) | Draft (shipped) |
| 025 | Upgradeable WagerRegistry | UUPS proxy at a stable address | Draft (shipped) |
| 026 | Gift & Resell Memberships via Voucher NFTs | Membership vouchers | Draft (shipped as the first membership upgrade) |
| 027 | Upgradeable MembershipManager | UUPS proxy at a stable address | Draft (shipped) |
| 028 | Token Mint & Compliant Token Administration | Token Mint mini-app | Draft (converted to a package) |
| 030 | ClearPath Standard DAOs & External Connectors | ClearPath mini-app | Draft (converted to a package) |
| 031 | Platform-Wide Notification & Activity System | Notifications + activity feed | Draft |
| 032 | Encrypted Data Backup & Restore | Recovery ▸ Data backup, synced objects | Draft (shipped) |
| 033 | Network-Aware Swap Provider | Trade ▸ Swap per chain | Draft |
| 034 | ZK-Wager Pools | Group wager pools (ZK removed; public addresses) | Draft (parallel escrow system) |
| 035 | Intent-Based Signatures | Gasless intents, platform-wide | Draft (shipped) |
| 036 | Intent Relayer Infrastructure | Relay gateway + engine | Draft (shipped, optional) |
| 037 | Unified Phrase Lookup for Pools & Challenges | One lookup for phrases; recovery codes | Draft |
| 038 | UX Consistency Harmonization | Cross-surface consistency | Draft |
| 039 | Wager View Info Tooltips | Reduce text density | Draft |
| 040 | My Wagers — Tester Feedback Refinements | Wager list refinements | Draft |
| 041 | Oracle-Settled Open Challenges (Polymarket) | Oracle resolution for open challenges | Draft (number collision) |
| 041 | Passkey Wallet Accounts & Login Management | Passkey smart accounts, app lock | Draft (shipped; FR-015 superseded by 050) |
| 042 | ClearPath Network-Agnostic Multi-Network DAOs | ClearPath across chains | Draft |
| 043 | Safe Multisig Custody | Protect ▸ On chain: vaults, proposals, operate-as | Draft (shipped) |
| 044 | Connected Account Portfolio | Accounts ▸ Portfolio | **Implemented** (v1.0/v1.1) |
| 045 | Unified Connect & Account Recovery | One connect + recovery entry | Draft |
| 046 | Contract Audit Coverage Restoration | Slither/Medusa/test coverage | Draft |
| 047 | Mask Sensitive Values | Tilt-to-hide for balances/addresses | Draft |
| 048 | Ethereum Mainnet & Testnet Support | Chain 1 in the cohort | Draft (deployed) |
| 049 | Multisig Policy Engine | `SafePolicyGuard` v1 (flat rules) | Draft (shipped; non-upgradeable) |
| 050 | Earn Section — Lending & Rewards | Earn ▸ Lend + Rewards | Draft (number collision) |
| 050 | Sponsored Paymaster for Passkey Smart Accounts | Sponsored UserOps | Draft (supersedes 041 FR-015) |
| 051 | Unified Activity Ledger with Durable Audit Logging | Activity view + client ledger | Draft |
| 052 | Payments-Style Wager Create Sheets | Wager create UX | Draft |
| 053 | Create-a-Challenge Home Screen | Home screen wager entry | Draft (superseded in nav by 073 FR-030) |
| 054 | Callsign Naming Registry | `%callsign` identity (Gold+, optional) | Draft (shipped) |
| 055 | Collectibles Portfolio (Read-Only NFT Display) | Collect ▸ Portfolio | Draft |
| 056 | Collectibles Sell-Side Trading | Collect ▸ sell/list | Draft |
| 057 | Predict — Polymarket Trading | Predict tab (Polygon only), builder-code revenue | Draft |
| 058 | Pay / Request / Wager Home | Payments home: three kinds | Draft (shipped) |
| 059 | Notification Profiles | Alert profiles + quiet hours | Draft |
| 060 | Configurable Platform Fee Wrapper | `FeeRouter`: one fee source of truth | Draft (shipped) |
| 061 | Bitcoin Transactions | First non-EVM network: portfolio/send/receive | Draft |
| 062 | Legacy Account Recovery | Import old key/word list, optional sweep | Draft (shipped) |
| 063 | Universal Acting-Account + Cross-Chain Legacy Recovery | Acting account across chains | Draft |
| 064 | Universal Asset Selector | One asset picker everywhere | Draft |
| 065 | Earn — Liquid & Delegated Staking | Earn ▸ Stake | Draft |
| 066 | Staking Fee Router, Admin Controls & Emergency Pause | Staking admin app view | Draft |
| 067 | Cross-Chain Bridge & Supply Liquidity | Transfer ▸ Bridge, Earn ▸ Supply | Draft (routers deployed on 5 mainnets; admin handoff open, #966) |
| 068 | Protect Multi-Chain Vaults & Advanced Policy Engine | `SafePolicyGuardV2` ordered rules, multi-chain vaults | Draft (shipped) |
| 069 | Network Settings in the User Panel & Member RPC Endpoints | Member-owned RPC endpoints | **Implemented** |
| 070 | Safe Receiver — counterparty-segregated receive addresses | Per-counterparty receive addresses | **Draft — paused**, open design issues |
| 071 | Polygon as membership reference chain; all-chains admin reads | Cohort-wide estate reads; one membership home | Draft (shipped) |
| 072 | White-label multi-tenant platform | Tenant manifests, build-time selection, per-tenant contract sets | Draft (shipped) |
| 073 | Distributed Mini-App Platform | Apps catalog, on-chain curation, host object | Draft (shipped; FR-030 amendment moved Wagers into Transfer) |
| 074 | Unified My Account Experience | Account card carousel + Portfolio/Activity/Stats | Draft (shipped) |
| 075 | Monorepo Workspaces & Build-Target Graph | One lockfile, shared packages, byte gates | Draft (shipped) |
| 076 | Monorepo Semantic Versioning & Release Promotion | Release train, immutable tags | Draft (shipped) |
| 077 | Mini-App Store UX Redesign | Catalog artwork + store UX; Vite 8/rolldown | Draft |
| 078 | My Wagers — One Table View | Single wager table | Draft |
| 079 | Hardhat 3 toolchain migration | Contract toolchain | Draft |
| 080 | Deterministic, cohort-wide contract addresses | CREATE2 addressing across cohort | Draft |
| 081 | Nav Drawer Density | Collapsible sections, capped pins, search, compact mode | Draft (shipped) |
| 082 | Perps — Cross-Protocol Perpetual Markets in Trade | Trade ▸ Perps (read-only) | Draft |
| 083 | Perps Position Management | Perps positions + Perps Fees admin view | Draft |
| 084 | Message Signing and Verification | Protect ▸ Verify (three verdicts) | **Implemented** |
| 085 | Hardware Wallet Cold Storage | Protect ▸ Off chain (Ledger/Trezor) | **In progress** |
| 086 | Unified, Customizable Account Cards | Account cards + cosmetics | **In progress** |
| 087 | Infrastructure as Code (Terraform + Ansible) | Declarative cloud estate | Draft (shipped) |
| 088 | Instant Acting Accounts & Deferred Signing | Acting-account model, no fall-through | **Shipped** |
| 089 | FinOps Dashboard & Alerting | Revenue/cost catalogue + gates + dashboards | Draft (shipped) |
| 090 | Chippr Brand Alignment | Brand tokens; `theme.css` as sole colour source | Draft (shipped) |
| 091 | Neutral and status token consolidation | Finished the colour-token sweep; tier metals | Draft (shipped) |
| 092 | Multi-Chain Activity Ledger | Activity across the cohort | **Implemented** |
| 093 | Admin Mini-Apps | Nine admin apps behind a Control Room | **Implemented** |
| 094 | End-to-End Coverage Expansion | Coverage matrix, tier policy, assertion depth | Draft (gates live) |
| 095 | Member API — Private Keys, MCP Server & Agentic Assistant | Capability tokens, MCP server, assistant | **Implemented** |
| 096 | x402 — Pay-Per-Request Access to the Member API | Unauthenticated paid access to priced ops | Draft (default off) |
| 097 | Workstation secrets and local observability | Secret Manager profiles; loopback Prom/Grafana | **Implemented** (pending Terraform apply) |
| 098 | Acting-Account Membership Purchase | Buy membership as the acting account | Draft |
| 099 | Network Status Mini-App | Chain/service status as a package | Draft |
| 100 | Passkey-native Solana | Non-EVM passkey chain | Draft |
| 101 | Passkey-native Zcash | Non-EVM passkey chain | Draft |
| 102 | Native Release Channels (iOS + Android + Web) | Capacitor shells beside the PWA | Draft (number collision; native jobs live) |
| 102 | Multisig Chain Abstraction — one vault, every network | Vault as an address; per-chain queue | **Implemented** |
| 103 | Funding Pools on the Receive View | Funding pools (own factory, organizer-paid) | Draft (number collision) |
| 104 | GutterToken assistant rail and client-side tools | Second assistant rail (BYOK) + client tool loop | **Approved for implementation** (number collision) |
| 104 | Passkey account recovery — find the account, never guess it | Account lookup with four outcomes | Draft |
| 105 | Guided Multichain Vault Creation | Create one vault on chosen networks; creation records | Draft |
| 106 | Gateway Caller Authentication and Abuse Prevention | Gateway caller auth + quotas | Draft |
| 107 | Keyed RPC Access Without a Published Credential | Keyed RPC without shipping a key | Draft (capacity blocker, #1459) |
| 108 | Multi-Currency Wrap/Unwrap | Wrap any cohort base coin; asset is the entry point | Reserved — skeleton |
| 109 | Token news on portfolio and trade surfaces | Advisory news cards + `get_token_news` tool | Draft |

Number collisions (`017`, `041`, `050`, `102`, `104`) are pre-gate artifacts frozen in
`LEGACY_COLLISIONS` under the Spec Registry rule S-04; spec `029` does not exist.
