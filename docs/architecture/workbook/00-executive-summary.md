# 00 — Executive Summary

> **Register:** this page is written for an architecture-review, security-review or
> audit reader who will not read the body. It states the architecture, the controls
> that enforce it, and the open items, in control-narrative form. Everything here
> is expanded and cited in pages [01](01-logical-view.md)–[09](09-findings-and-drift.md).

## 1. What the platform is

FairWins is a **self-custody digital-asset platform**. Members hold their own
keys — by injected browser wallet, passkey-backed ERC-4337 smart account,
hardware device, or an imported legacy key — and the platform takes custody of
member funds at no point in any flow. All value settles on public blockchains:
eight EVM networks plus Bitcoin as a non-EVM portfolio, send and receive surface.

The product surface spans peer-to-peer wagering with escrowed stakes, pooled
value (wager pools and funding pools), consumer finance surfaces (earn, trade,
transfer, bridge, collect, prediction-market access), institutional-style custody
controls (Safe multisig vaults under an on-chain policy guard, hardware cold
storage, message-signature verification), and identity and access primitives
(tiered soulbound membership, optional on-chain names, address book, sanctions
screening). The platform is delivered as a web app, an installable PWA, and iOS
and Android shells, and is white-labellable: one origin serves exactly one tenant,
resolved from a build-time manifest.

## 2. Architecture in one table

| Layer | Realisation | Custody of member funds | Optional |
|---|---|---|---|
| Client | React SPA; Capacitor native shells; untrusted mini-app packages in a narrow host object | Holds member keys, client-side only | No |
| Policy gateway | `relay-gateway` — origin lock, caller-identity tiering, screening, quotas, killswitch, vendor read-proxy, member API, pay-per-request paywall | **None.** Holds no member key | Yes |
| Submission engines | OpenZeppelin Relayer (+ redis); alto ERC-4337 bundler, EntryPoint v0.6 | None. Pay gas only | Yes |
| Auxiliary | MCP server (dependency-free, cannot sign); FinOps exporter (read-only by construction) | None | Yes |
| Settlement | Solidity estate: UUPS proxies, a two-facet registry, ERC-1167 clone pools, routers, guards, registries | **The escrow itself** | No |

The controlling design decision is that **every off-chain component is optional**.
Relayer, paymaster, gateway modules and vendor proxies are conveniences; each
value flow retains a self-submit path. A total outage of FairWins-operated
infrastructure degrades convenience and does not strand member value.

## 3. Control narrative

Twenty platform-wide invariants are enumerated in [01 §4](01-logical-view.md).
The seven that a reviewer should test first:

| Control | Statement | Enforcement |
|---|---|---|
| **No custody** | The member is the depositor on every external protocol call; position NFTs mint to the member; bridge liquidity never touches a FairWins contract. `IBridgeRouter` deliberately exposes **no** rescue or refund function — the absence *is* the control | Contract interfaces; absence is reviewable |
| **Never stranded** | Every deadline has a refund path; escrow always has an exit; a pause stops *new* activity and never traps value; retiring a pool is `setPoolEnabled(false)`, never removal | Contract logic; permissionless upkeep entrypoints |
| **A zero is never an absence** | Every read resolves `read \| not-configured \| unreadable`; a value exists only in the `read` state, enforced by a three-constructor type where one constructor takes a number. Totals missing a source are labelled partial and **name** what is missing | Type discipline + CI gates |
| **Three verdicts, not two** | Wherever a negative could be a network failure, a third state exists: message verification returns `unverifiable`; member-API auth returns retryable 503s that are never denials; passkey account lookup separates "unreachable" from "not found" | Type discipline; route contracts |
| **Fee consent ceiling** | Every fee is disclosed before signature and the quoted rate is passed as `maxFeeBps`; a member can never be charged above what they saw. One fee store (`FeeRouter`), per-service hard caps, no hardcoded basis points | On-chain `FeeAboveQuoted`; FinOps catalogue gate |
| **Screening inside the wrapper** | Sanctions screening happens where value moves and *inside* the privileged wrapper, not beside it — so a third-party package cannot skip it. Green requires **every** configured list to have answered; one unanswered list yields `partial`, never `screened` | `SanctionsGuard`; host `wallet.submit` |
| **Policy guard is not upgradeable** | An upgrade key over a vault policy guard would be a backdoor across every vault. New rule types ship as a new guard *version*, adopted per vault by threshold-approved `setGuard` | Deliberate absence of a proxy |
| **Cohort isolation** | A testnet build cannot read mainnet state: the chain cohort is baked into the artifact at build time | Build-time `VITE_NETWORK_ID`; `cohortChainIds()` |

Governance of the estate is role-separated with deliberate non-overlap: a Guardian
may pause but not freeze; a Moderator may freeze but not pause or seize; an
Upgrader may replace logic but holds no other authority; **no role can move an
escrowed stake**, and resolution authority is fixed at wager creation.

## 4. Cryptographic posture

Signature schemes are conventional and current: secp256k1 ECDSA with EIP-712
typed data for all intents, ERC-1271 for contract accounts, P-256/ES256 WebAuthn
for passkeys (verified on-chain via the RIP-7212 precompile with a constant-time
software fallback, rejecting high-`s` signatures), Safe threshold approvals
verified against the vault's own on-chain approval state, and BIP-32/84/86 for
Bitcoin. There is **no MPC, no threshold-signature scheme and no live
zero-knowledge path**; the Semaphore/Groth16 material is archive-only. No weak
primitive is present anywhere in the tree.

Key custody is tiered — Cloud KMS (non-exportable) for platform signing, Secret
Manager for deploy and bundler-executor keys, an air-gapped floppy keystore for
admin authority, and the device secure enclave for member passkeys. Member-held
credentials are device-scoped and test-asserted absent from the backup registry,
so they cannot leave the device that created them.

**Three cryptographic findings warrant attention before any external audit**, all
detailed in [05 §0](05-cryptographic-bom.md) and summarised in
[09 §B](09-findings-and-drift.md): the X-Wing post-quantum construction is
internally consistent but is **not** the IETF draft and cannot interoperate with
one; open-challenge claim codes carry ~2⁴⁴ of entropy while deterministically
deriving the key that authorises taking the challenge; and envelope and backup
keys are derived as `keccak256(signature)`, which admits no rotation path that
preserves the data.

## 5. Open items

The register in [09](09-findings-and-drift.md) is the full list. The four an
approving reviewer should require an answer on:

1. **Infrastructure-as-code correspondence is unestablished.** The Terraform apply
   job is gated on two repository variables and skips silently if they are unset;
   a skipped job satisfies a required check. Three management flags
   (`manage_edge`, `manage_spa`, `manage_mcp_server`) are still `false`, so the
   edge, the production SPA service and the MCP service are declared but
   unapplied. A merged infrastructure PR should not be read as an applied one.
2. **The KMS ring holding the gas and paymaster signing keys is declared but
   unadopted**, leaving the IAM on the two most authority-bearing keys managed out
   of band. No KMS key declares a rotation period.
3. **A single hot key still holds `DEFAULT_ADMIN_ROLE` on the Bridge and Liquidity
   routers** (issue #966), and the recorded treasury on four mainnets is a
   superseded Safe. The historical deployer key is known-compromised, and roughly
   60 sole-held roles across 23 unrecorded contracts were written off rather than
   migrated.
4. **One third-party dependency has no fallback and a scope-shaped failure mode.**
   IPFS pinning is required for wager creation, open challenges and encrypted
   backup; its credential is an unmanaged duplicate, and a wrongly-scoped token
   authenticates successfully while breaking every member write — a failure that
   has already occurred in production.

## 6. How to read the rest

| If you are | Start at |
|---|---|
| Assessing product scope or governance | [01 Logical view](01-logical-view.md) |
| Reviewing component boundaries or code ownership | [02 Architectural view](02-architecture-view.md) |
| Assessing hosting, network exposure or blast radius | [03 Systems view](03-systems-view.md) |
| Running a network or firewall review | [04 Connectors & ports](04-connectors-and-ports.md) |
| Preparing a cryptographic audit or key-rotation plan | [05 Cryptographic BOM](05-cryptographic-bom.md) |
| Assessing third-party and concentration risk | [06 External vendors](06-external-vendors.md) |
| Verifying on-chain authority and deployment state | [07 On-chain estate](07-onchain-estate.md) |
| Tracing a capability to its specification | [08 Spec index](08-spec-index.md) |
| Deciding what to fix first | [09 Findings & drift](09-findings-and-drift.md) |
