# Feature Specification: Multi-service name resolution (ENS + HENS + Zcash Names)

**Feature Branch**: `116-multi-naming-services`

**Created**: 2026-11-28

**Status**: Reserved. Spec skeleton only; `/speckit-clarify` and `/speckit-plan` follow in the
feature PR.

**Input**: "We currently detect ENS names for Ethereum addresses. We need to also accept other
naming services, such as HENS on ETC and Zcash Names on ZEC. Create a new spec to cover these
naming services: https://hens.domains/#docs, https://www.zcashnames.com/docs"

## Problem statement

Every address field in the app understands exactly one naming system. `useEnsResolution`
(`frontend/src/hooks/useEnsResolution.js`) recognises a hardcoded ENS TLD list
(`utils/validation.js#isEnsName`: `.eth`, `.xyz`, `.app`, …) and always resolves on Ethereum
mainnet. A member who pastes `alice.etc` sees "Enter a valid Ethereum address or ENS name", even
though `.etc` is a live, on-chain name on a network the app supports (ETC 61). A `.zcash` / `.zec`
name gets the same answer.

That is a fact about our code, not about the names. Two services now matter:

| | **HENS** (`.etc`) | **Zcash Names / ZNS** (`.zcash`, `.zec`) |
|---|---|---|
| Network | Ethereum Classic mainnet (61). No testnet deployment is published. | Zcash mainnet and testnet. Not EVM. |
| Source of truth | One contract, `NameNFT` `0xFfC26c447c90f9eBdAe34A0C368f702c4643de34` (ERC-721 + registrar + resolver, non-upgradeable). No separate registry. | Shielded-note memos (`ZNS:claim:…`) read by a **resolver** that is identified by a published unified full viewing key. No contract. |
| Forward | `resolve(tokenId)`. `addr(coinType)` reads the explicit SLIP-44 record first, then falls back to `resolve()`. Inactive or in-grace names return `address(0)`. | JSON-RPC `resolve {query}` → `NameRecord` (`address`, `txid`, `height`, `last_action`, `expires_at`) or `null`. |
| Reverse | `reverseResolve(addr)`. It returns a name only if that name forward-resolves back to `addr` and is active. | `reverse_lookup {address}` → every name bound to a UA. There is no "primary name". |
| Record | EVM address per coin type, plus text and contenthash records. | Exactly one unified address (`u1…` / `utest1…`) with a Sapling or Ironwood receiver. |
| Normalisation | ASCII lowercase, as the contract does. Labels are UTF-8 bytes. Not UTS-46 or ENSIP-15. | `^[a-z0-9]{1,63}$` after trim + lowercase + stripping one `.zcash` / `.zec`. The suffix never appears on chain. |
| Trust | On-chain read. | The resolver need not be trusted: its `status().viewing_key` must equal the published key, and answers are checkable against chain. Running our own resolver is supported. |

Research for this section, including what each service does not document, belongs in
`research.md` in the feature PR. HENS publishes no testnet, ABI file, SDK or ENSIP-10 statement.
ZNS publishes no public resolver URL and no CORS policy.

## Why this is not "add two TLDs to a regex"

1. **A name resolves on a chain, and that chain is not necessarily the one the value moves on.**
   ENS today resolves on mainnet whatever the wallet is on. A `.etc` name resolves on 61. Its
   `addr(60)`, `addr(61)` and `addr(<other coin>)` can legitimately differ. Sending to whichever
   one came back first sends to an address the name's owner may never have meant for that chain.
2. **ZNS resolves to an address the app cannot pay.** FairWins has no Zcash network. A `.zcash`
   name in an EVM field has to be refused with a stated reason, never resolved to a string that
   then fails address validation (or worse, passes some looser check).
3. **ZNS resolution is an off-chain read through somebody's resolver.** It needs a stated
   verification step. A resolver that answers with the wrong viewing key is not a degraded
   source; it is not a source.
4. **The value path depends on it.** A resolved name becomes the recipient of a transfer, a wager
   counterparty, a vault owner or a pool member. A name that changes between display and signature
   is a substitution attack whether or not anyone intended one.

## User Scenarios & Testing *(mandatory)*

### User Story 1: Send to a `.etc` name (Priority: P1)

As a member sending on ETC, I type `alice.etc` into the recipient field. I see the address it
resolves to, and the name labels that address everywhere the app shows it.

**Independent Test**: On the no-chain tier with a stubbed `NameNFT`, `alice.etc` resolves, the
resolved address is shown in full before confirmation, and the transfer is built to that address.

### User Story 2: An address shows its name, whichever service holds it (Priority: P2)

As a member looking at a counterparty, vault owner or contact, I see its `.etc` name when it has a
verified HENS primary name. I see its ENS name when it has one. The rule for which one wins on a
given chain is stated, not incidental.

**Independent Test**: An address holding both an ENS and a HENS primary name renders the
chain-appropriate one, and an unverified reverse record renders no name.

### User Story 3: A name the field cannot use is refused by name (Priority: P1)

As a member who pastes `alice.zcash` into an EVM field, I am told that this is a Zcash name, that
it resolves to a Zcash address, and that this field cannot send there. I am not told that it is an
"invalid ENS name".

**Independent Test**: Every recognised suffix that is incompatible with the field's address family
renders a named refusal and resolves nothing over the network.

### User Story 4: Resolve a Zcash name where a Zcash address is accepted (Priority: P3)

As a member saving a Zcash contact, or using any future Zcash surface, I can enter `alice.zec` and
get a unified address that a verified resolver returned. If no verified resolver is reachable, I
am told so.

**Independent Test**: With a stub resolver, a matching viewing key yields `resolved`, a mismatched
key yields `unverifiable` (never `resolved`), and an unreachable resolver yields `unreadable`.

### Edge cases

- **HENS name in grace or inactive.** It resolves to `address(0)`. Render "not active", which is
  distinct from "not found". Never offer zero as a recipient.
- **HENS record for a coin other than the target chain's.** See FR-006.
- **ZNS name past `expires_at` with no release note yet.** It still resolves. Disclose the expiry.
- **ZNS `last_action: release`.** The name is not found, not stale.
- **Non-ASCII HENS label.** It is normalised the way the contract does it. A visually confusable
  label is not blocked, but the resolved address is always shown in full before signature.
- **The name changes owner or record between the field and the confirm sheet.** See FR-010.
- **Testnet build.** HENS has no Mordor deployment. Whether `.etc` names resolve on a testnet
  build is a clarify item (see Open questions).
- **The same address has names on several services.** See FR-008.

## Requirements *(mandatory)*

### Functional requirements

- **FR-001 (one registry)**: Naming services are declared once, in a registry (provisionally
  `config/namingServices.js`). Each row holds: suffixes, the network it resolves on, the address
  family it yields (`evm` / `zcash`), forward and reverse capability, a normaliser, and
  per-cohort availability. Suffix detection, field validation and resolution all read the registry.
  `isEnsName`'s hardcoded TLD list is retired into the ENS row. Adding a service (for example SNS
  `.sol` or Unstoppable) is a new row and an adapter, never a new hook in each field.
- **FR-002 (three-state result, plus not-found)**: Every resolution returns exactly one of four
  outcomes:
  - `resolved {address, service, chain, observedAt}`
  - `not-found`, which also covers inactive and released names, each with a reason
  - `unreadable`, when the network or resolver could not answer
  - `unverifiable`, when a ZNS resolver answered but failed the viewing-key check

  Only `resolved` carries an address. An unreachable chain is never `not-found` (the spec-104
  `accountLookup` device).
- **FR-003 (address family gate)**: Each address field declares the address family it accepts. A
  recognised name whose service yields a different family is refused before any network call. The
  refusal names the service and the family.
- **FR-004 (ENS unchanged)**: ENS resolution keeps its current behaviour: the mainnet read, the
  current normalisation, and the non-blocking reverse decoration from #1431. This feature
  generalises the ENS path. It does not change ENS results.
- **FR-005 (HENS)**: `.etc` names are read directly from `NameNFT` on chain 61 through the
  spec-069 read seam (`getReadProvider` / `readProviderFor`), never through a hand-built
  provider. Labels are normalised as the contract does it, and the tokenId derivation is taken
  from the contract source, not from ENS namehash by assumption. The contract address is recorded
  config with a source link, not a literal scattered across call sites.
- **FR-006 (coin type follows the transaction)**: For a field bound to a target chain, HENS
  resolution reads `addr(coinType)` for that chain's SLIP-44 / ENSIP-11 coin type. It falls back to
  the coin-61 / owner address only under a rule settled in clarify. Whenever the fallback is used,
  the UI says which record the address came from.
- **FR-007 (ZNS behind a verified resolver)**: `.zcash` / `.zec` names resolve through a ZNS
  resolver whose `status().viewing_key` matches the published key for the build's cohort (mainnet
  key on mainnet builds, testnet key on testnet builds, never crossed). Whether the browser calls
  the resolver directly or through a relay-gateway proxy (the spec-109 news precedent: optional
  module, default off, 503 when unconfigured) is a plan decision. It turns on the resolver's CORS
  policy, which is undocumented. Lookups use the whole-list mode, which keeps the queried name
  hidden from the resolver, unless the plan records why not.
- **FR-008 (reverse lookup is verified and decorative)**: A reverse name is shown only if it
  forward-resolves back to the same address. That check is built into HENS `reverseResolve`, and
  it is required explicitly for any service whose reverse read does not include it. Reverse lookup
  never blocks the field's success state (#1431). When an address holds names on several services,
  the service native to the field's chain wins, then ENS. The full order is settled in clarify. The
  display priority stays **address book > callsign > name service > generated** (spec 054).
- **FR-009 (screening sees the resolved address)**: The spec-021 screening pill and the submit-time
  screening gate run on the RESOLVED address, never on the name string.
- **FR-010 (no substitution between display and signature)**: The resolved address is shown in
  full on the confirm surface, and the name is re-resolved at confirm. If the address changed, the
  confirm is refused with both addresses shown, and the member re-confirms. The address that is
  signed is the one that was shown.
- **FR-011 (persisted references store addresses)**: Address book entries, wager counterparties,
  pool members and vault owners store the resolved ADDRESS. A name may be stored only as a label,
  and the label is re-verified when displayed. A name that later points elsewhere does not change
  a saved recipient.
- **FR-012 (cohort honesty)**: A service with no deployment in the build's cohort is absent from
  detection on that build, or refused with a stated reason (decided in clarify). It never resolves
  against the other cohort's deployment silently. The existing ENS-on-mainnet-from-testnet
  behaviour is recorded as the precedent this rule is measured against.
- **FR-013 (assistant / MCP)**: Out of scope for v1 unless clarify promotes it. If promoted, it is
  exposed as one public read tool following the spec-104 tool-pull rules, with no navigation and
  no build.

### Key entities

- **NamingService**: a registry row (FR-001).
- **NameResolution**: the four-outcome result (FR-002), keyed by `(service, normalisedName,
  targetChain)`.
- **ReverseName**: the forward-verified name for `(address, chain)`.

## Success criteria *(mandatory)*

- **SC-001**: A `.etc` name resolves in every EVM address field on a mainnet build. No field
  carries its own suffix list (enforced by a test over `isEnsName` callers).
- **SC-002**: No path renders an unreachable resolver or RPC as "name not found" (unit-tested per
  adapter, with a failing fake that asserts on the REQUEST, per the spec-089 lesson).
- **SC-003**: No signature is produced for an address that differs from the one shown on the
  confirm surface (FR-010, covered at the no-chain tier).
- **SC-004**: A ZNS answer from a resolver with the wrong viewing key never yields an address.

## Agent routing

- `glass`: `AddressInput`, the reverse-name label, the confirm-surface disclosure.
- `satchel`: the Zcash address family (string network ids, never a numeric chainId; the
  `isBitcoinNetworkId` precedent) and cohort scoping.
- `relay`: the ZNS proxy, if the plan chooses one, plus a FinOps catalogue entry if it adds a
  vendor.
- `custos`: FR-009 and the screening hand-off.
- `witness`: after every change.

No contract changes. HENS and ZNS are read-only integrations, and FairWins registers no names.

## Out of scope

- Registering, renewing or managing HENS or ZNS names. This includes the ZNS memo-claim flow and
  the HENS commit-reveal flow.
- A Zcash send/receive surface. This spec resolves Zcash names. Paying them is a separate network
  spec on the spec-061 model.
- Changing `%callsign` (spec 054) semantics or priority.
- HENS text records, contenthash and avatar beyond what a later display decision asks for.

## Open questions for `/speckit-clarify`

1. Testnet builds: are `.etc` names absent, refused with a reason, or resolved against chain 61
   (the ENS-on-mainnet precedent)? Is there an unpublished HENS deployment on Mordor?
2. FR-006: when there is no explicit record for the target chain's coin type, does an EVM chain
   other than 61 fall back to the coin-61 / owner address, or refuse?
3. FR-008: the exact reverse-name precedence when an address holds ENS and HENS names.
4. FR-007: which ZNS resolver(s) do we trust, a public one or our own, and does it go through the
   gateway?
5. Is the Address Book in scope for Zcash contacts in v1 (US-4), or is ZNS detection and refusal
   only (US-3) until a Zcash network spec lands?
