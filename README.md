# FairWins — Digital Asset Infrastructure

> Self-custody digital asset infrastructure for modern financial products:
> embedded wallets, policy-governed custody, payments and settlement, markets
> connectivity, and built-in compliance — across major networks, available
> **white-label** under your own brand. Live at [fairwins.app](https://fairwins.app).

FairWins is the platform layer a digital asset business would otherwise
assemble from multiple vendors. One stack provides the wallet, custody,
payment, trading, and compliance components — behind one interface, on
deterministically deployed smart contracts — with a property no
aggregation of vendors gives you: **the platform never takes custody.** Every
value-bearing action is signed by the end user's own keys (passkey smart
account, external wallet, or multisig vault).

📖 **Full documentation:** [docs/](docs/index.md) (MkDocs site — user guide,
architecture, contract reference, runbooks)

> **On the repository name.** This repository is the FairWins platform
> monorepo. It is still hosted at `chippr-robotics/prediction-dao-research`,
> which is a **historical name** from the futarchy-research project this code
> grew out of — not a description of what is in it. The npm package is
> `fairwins-platform`, the documentation site is FairWins, and the product is
> FairWins. The GitHub path is kept for now because the old name is still
> load-bearing outside this repository: the Graph Studio subgraph slug, the
> Cloud Run service, the Artifact Registry image path and the relayer service
> names all contain it, and each is a migration with its own cutover rather
> than a string edit. **229 occurrences across 108 files** are inventoried and
> sequenced by blast radius in **#1628**; the naming rationale is **#1617**.

## Platform capabilities

| Capability | What it provides |
|-----------|------------------|
| **Embedded wallets** | Passkey (WebAuthn) ERC-4337 smart accounts — no seed phrases, optional sponsored gas — plus external wallets and hardware signers via WalletConnect |
| **Custody & policy** | Safe multisig vaults with an on-chain policy engine: ordered rules, approver requirements, and thresholds enforced by contract, multi-chain |
| **Payments & settlement** | Stablecoin transfer/request rails with QR flows, address book, and gasless (EIP-3009 + relayer) settlement |
| **Portfolio & reporting** | Unified multi-chain portfolio (tokens, positions, NFTs) with a complete activity ledger and tax reporting |
| **Markets connectivity** | Direct order flow into Polymarket prediction markets, plus escrowed peer-to-peer settlement with oracle resolution (Polymarket, Chainlink, UMA) |
| **Trading & liquidity** | Per-network DEX execution (Uniswap, ETCswap), cross-chain bridging via Across (no-custody routers), supplied liquidity |
| **Yield** | Third-party lending vaults, liquid staking, and reward claims — positions stay withdrawable |
| **Bitcoin** | Native BTC wallet beside the EVM accounts: client-side key derivation, rotating addresses, hard fee ceilings |
| **Collectibles** | NFT portfolio with live floors and OpenSea sell-side integration |
| **Compliance** | Chainalysis sanctions screening enforced at the contract layer, jurisdiction gating at the edge, immutable audit records |
| **Operations console** | Estate-wide reads across every network — balances, fees, roles, pauses — with honest `read / not-deployed / unreadable` state |
| **Recovery** | End-to-end encrypted backup/sync, cross-device account recovery, legacy key import and asset sweeps |

Every fee on the platform has one source of truth (an on-chain `FeeRouter`
with per-service hard caps) and is disclosed to the user before signature.

## White-label, multi-tenant

FairWins is delivered as **tenant instances**. A validated configuration
manifest (`tenants/<id>/manifest.json`) defines an instance's identity (brand,
theme, domains), settings (features, networks, membership tiers, fees), and
contract set:

- **Branding-only instances** front the shared contract estate under your
  domain and brand — live in days.
- **Dedicated instances** get an isolated on-chain estate: deterministic,
  tenant-salted deployments of the same contracts, with your own
  membership base, fee configuration, treasury, and admin keys. Isolation is
  enforced by separate contract instances — never by an application filter.

One origin serves one tenant; an instance physically contains no other
tenant's identity or addresses. See
[White-Label Tenants](docs/developer-guide/white-label-tenants.md) and the
[Tenant Operations runbook](docs/runbooks/tenant-operations.md).

## Network coverage

| Network | Chain ID | Coverage |
|---------|----------|----------|
| Polygon | 137 | Full platform (primary network) |
| Ethereum | 1 | Portfolio, custody, routers, bridge liquidity |
| Optimism / Base / Arbitrum | 10 / 8453 / 42161 | Portfolio, custody, routers |
| Ethereum Classic | 61 | Custody + DEX trading |
| Bitcoin | — | Native wallet (portfolio / send / receive) |
| Polygon Amoy / Mordor | 80002 / 63 | Test networks |

## Security model

1. **Self-custody, structurally** — no contract role or operator key can move
   user funds; payouts are pull-based, and refund paths cover every timeout.
   Policy guards for multisig vaults are deliberately non-upgradeable.
2. **Deterministic deployments** — salted CREATE2 via the Safe Singleton
   Factory; every address is recorded in-repo (`deployments/`, per-tenant
   under `deployments/tenants/<id>/`) and version-pinned by consuming
   services at startup.
3. **Defense at every layer** — checks-effects-interactions, Slither/Medusa in
   CI, storage-layout gates on upgrades, sanctions screening on value flows,
   origin-locked serving, strict CSP.
4. **Honest state** — fees disclosed before signature; absence rendered as
   absence (never a zero); no mocked data in shipped paths. These rules are
   binding: see `.specify/memory/constitution.md`.

### Assurance status

**These contracts have not been audited by a third party.** No external firm
has reviewed them, and no audit report exists. Anyone deciding whether to put
funds at risk should weigh that directly.

What does exist, and what it is worth:

| Control | What it actually covers |
|---|---|
| Internal security review | Every contract change is reviewed against `.github/agents/` before merge — by the people who wrote it, which is not independence |
| Slither + Medusa in CI | Automated static analysis and fuzzing. They catch known classes of defect; they do not reason about whether the design is right |
| Storage-layout gate | `npm run check:storage-layout` blocks an upgrade that would corrupt state on a UUPS proxy |
| Byte-level bytecode diff | Deployed bytecode cannot change without the change being deliberately re-recorded |
| On-chain e2e money-path suite | Create, accept, resolve, claim, refund and cancel are exercised against a real chain, not mocks |

Third-party claims elsewhere in this repository — audited OpenZeppelin
Governor, Safe v1.4.1, Lido, `@noble`/`@scure` — refer to **those projects'**
audits, not to ours.

If an audit is commissioned, this section gets the firm, date, scope and a
link to the report. Until then it says what is true. `README.md`, `docs/`
and the landing page are gated by
`frontend/src/test/claims/noUnsupportedAuditClaims.test.js`, so the word
cannot quietly come back.

## Architecture

- **Contracts** (`contracts/`) — UUPS proxies at stable addresses for the
  value-bearing registries (settlement engine, membership, fee router, token
  factory, staking/bridge/liquidity routers), immutable clones for bearer
  assets and per-group instances, non-upgradeable policy guards, ERC-4337
  account stack, oracle adapters (Polymarket, Chainlink DataFeed/Functions,
  UMA OOv3).
- **Frontend** (`frontend/`) — React + Vite SPA, one build per tenant
  instance, served by nginx on Cloud Run behind Cloudflare. No backend: state
  lives on-chain, on IPFS, or client-side encrypted.
- **Services** (`services/`) — optional per-tenant relay-gateway (gasless
  intents + ERC-7677 paymaster with quotas and killswitch) and ERC-4337
  bundler; The Graph subgraph for indexing.
- **Tooling** (`scripts/`) — deterministic deploy scripts, tenant manifest
  validation, frontend contract-artifact sync, operational runbooks under
  `docs/runbooks/`.

Full picture: [Architecture guide](docs/developer-guide/architecture.md).

## Quick start

```bash
npm install              # ONE install covers every workspace (spec 075)
npm run compile          # contracts
npm test                 # contract suite
npm run test:frontend    # frontend (Vitest)
npm run tenants:validate # tenant manifest validation
npm run frontend         # run the app locally
```

To stand up an instance, see the
[Tenant quickstart](specs/072-white-label-tenants/quickstart.md); to add
integrations or contracts, see the
[developer guide](docs/developer-guide/setup.md).

## Development

This repo uses [Spec Kit](https://github.com/github/spec-kit) for spec-driven
development — see [CLAUDE.md](CLAUDE.md) and the binding standards in
`.specify/memory/constitution.md`. Contract changes must follow
checks-effects-interactions and pass Slither/Medusa in CI.

## License

Apache License 2.0

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## Security

For security concerns, please email security@fairwins.app
