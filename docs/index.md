# Welcome to FairWins

**Self-custody digital asset infrastructure — embedded wallets, policy-governed
custody, payments, markets connectivity, and compliance, available white-label
under your own brand.**

FairWins is the platform layer for digital asset products. One stack provides
the components a digital asset business otherwise assembles from multiple
vendors:

- **Embedded wallets** — passkey (WebAuthn) ERC-4337 smart accounts with no
  seed phrases and optional sponsored gas, plus external wallets and hardware
  signers via WalletConnect
- **Custody & policy** — Safe multisig vaults with an on-chain policy engine:
  spending rules, approver requirements, and thresholds enforced by contract
- **Payments & settlement** — stablecoin transfer/request rails with QR flows,
  address book, and gasless settlement
- **Portfolio & reporting** — unified multi-chain portfolio with a complete
  activity ledger and tax reporting
- **Markets connectivity** — direct order flow into Polymarket prediction
  markets, plus escrowed peer-to-peer settlement with oracle resolution
  (Polymarket, Chainlink, UMA)
- **Trading, bridging & yield** — per-network DEX execution, Across bridging
  through no-custody routers, lending vaults, and liquid staking
- **Bitcoin** — a native BTC wallet beside the EVM accounts, keys held
  client-side
- **Compliance** — Chainalysis sanctions screening enforced at the contract
  layer and jurisdiction gating at the edge

The defining property: **the platform never takes custody.** Every
value-bearing action is signed by the user's own keys, payouts are pull-based,
and refund paths cover every timeout — funds cannot be stranded.

> **Important**: Before purchasing a tier or interacting with the platform,
> please read the [Roles and Tiers](system-overview/roles-and-tiers.md)
> overview and the [Account Moderation Policy](system-overview/account-moderation.md).
> The protocol can be paused by a Guardian role holder, and individual
> accounts can be frozen for cause by an Account Moderator role holder.

## White-label instances

FairWins is delivered as **tenant instances**: a validated configuration
manifest defines an instance's brand, theme, domains, feature set, networks,
and contract set. Branding-only instances front the shared contract estate;
dedicated instances get an **isolated on-chain estate** — deterministic,
tenant-salted deployments of the same contracts with their own
membership base, fee configuration, treasury, and admin keys. Isolation is
enforced by separate contract instances, never by an application filter.
See the [White-Label Tenants guide](developer-guide/white-label-tenants.md).

## Where it runs

| Network | Chain ID | Coverage |
|---------|----------|----------|
| Polygon Mainnet | 137 | **Live** — full platform (primary network) at [fairwins.app](https://fairwins.app) |
| Ethereum Mainnet | 1 | Portfolio, custody, routers, bridge liquidity |
| Optimism / Base / Arbitrum | 10 / 8453 / 42161 | Portfolio, custody, routers |
| Ethereum Classic | 61 | Custody + DEX trading |
| Bitcoin | — | Native wallet (portfolio/send/receive) |
| Polygon Amoy / Mordor | 80002 / 63 | Test networks (toggle in the wallet menu) |

Recorded contract addresses live in [`deployments/`](https://github.com/chippr-robotics/prediction-dao-research/tree/main/deployments)
— see the [Architecture guide](developer-guide/architecture.md) for the full map.

## Privacy & security

- **Self-custody, structurally** — no contract role or operator key can move
  user funds; multisig policy guards are deliberately non-upgradeable
- **End-to-end encryption** — private records are envelope-encrypted
  client-side (X-Wing post-quantum hybrid KEM,
  [ADR-003](adr/003-xwing-post-quantum-encryption.md)); encrypted backups sync
  across devices with keys the platform never sees
- **On-chain key registry** — participants publish encryption public keys via
  `KeyRegistry`
- **Sanctions screening** — `SanctionsGuard` checks the Chainalysis sanctions
  oracle before value flows execute
- **No backend** — the app is a static SPA; state lives on-chain, on IPFS, or
  client-side encrypted
- **Honest fees** — every fee has one on-chain source of truth with hard caps,
  disclosed before signature

## Quick Navigation

<div class="grid cards" markdown>

-   :fontawesome-solid-users:{ .lg .middle } __User Guide__

    ---

    Using the platform: accounts, payments, markets, custody, and recovery.

    [:octicons-arrow-right-24: Getting Started](user-guide/getting-started.md)

-   :fontawesome-solid-code:{ .lg .middle } __Developer Guide__

    ---

    Set up your development environment and learn the system architecture.

    [:octicons-arrow-right-24: Setup Instructions](developer-guide/setup.md)

-   :fontawesome-solid-diagram-project:{ .lg .middle } __Architecture__

    ---

    Understand the contracts, frontend, integrations, and infrastructure.

    [:octicons-arrow-right-24: Architecture](developer-guide/architecture.md)

-   :fontawesome-solid-book:{ .lg .middle } __API Reference__

    ---

    Detailed reference documentation for smart contracts and APIs.

    [:octicons-arrow-right-24: API Docs](reference/api.md)

</div>

## System components

| Contract | Role |
|----------|------|
| `WagerRegistry` | Escrowed peer-to-peer settlement engine (create, accept, resolve, claim, refund) with oracle resolution. **UUPS proxy** — upgradeable at a stable address |
| `MembershipManager` | Tiered access (Bronze → Platinum) with rate limits and voucher redemption. **UUPS proxy** |
| `MembershipVoucher` | Transferable ERC-721 bearer claim on a membership, redeemed for a soulbound membership. **Immutable** by design |
| `FeeRouter` | Single source of truth for platform fees, per-service hard caps. **UUPS proxy** |
| `TokenFactory` | Role-gated, sanctions-screened issuance of ERC-20/721 and restricted ERC-1404 tokens as immutable clones. **UUPS proxy** |
| `SafePolicyGuard` / `SafePolicyGuardV2` | On-chain policy engines for multisig vaults — **non-upgradeable** by design |
| `BridgeRouter` / `LiquidityRouter` | No-custody routers for Across bridging and Uniswap/HubPool liquidity |
| `SanctionsGuard` | Non-bypassable sanctions screening (Chainalysis oracle + deny list) |
| `KeyRegistry` | Public encryption keys for end-to-end encrypted records |
| Oracle adapters | `PolymarketOracleAdapter`, `ChainlinkDataFeedOracleAdapter`, `ChainlinkFunctionsOracleAdapter`, `UMAOptimisticOracleV3Adapter` |

The value-bearing registries are **UUPS upgradeable proxies** — logic is
swapped in place while state and addresses are preserved — so features ship
without stranding funds or memberships (see
[ADR-004](adr/004-upgradeable-registry-uups.md)). Earlier research materials
are preserved under
[`docs/archived/`](https://github.com/chippr-robotics/prediction-dao-research/tree/main/docs/archived)
and `contracts-archive/` (reference only).

## License

This project is licensed under the Apache License 2.0. See [LICENSE](https://github.com/chippr-robotics/prediction-dao-research/blob/main/LICENSE) for details.

## Contributing

Contributions are welcome! Please read our [contributing guidelines](developer-guide/contributing.md) to get started.
