# Feature Specification: Multi-service name resolution (ENS + HENS)

**Feature Branch**: `116-multi-naming-services`

**Created**: 2026-11-28

**Status**: Reserved. Spec skeleton with first clarifications recorded. `/speckit-plan` follows in
the feature PR.

**Input**: "We currently detect ENS names for Ethereum addresses. We need to also accept other
naming services, such as HENS on ETC and Zcash Names on ZEC. Create a new spec to cover these
naming services: https://hens.domains/#docs, https://www.zcashnames.com/docs"

## Clarifications

### Session 2026-11-28

- **Q: Where do `.etc` names resolve on a testnet build, or when the field targets a chain other
  than ETC?** A: **HENS only exists on ETC. Always fall back to ETC mainnet (61).** The Mordor
  deployment (see below) is a developer test deployment. It is never a resolution source for a
  shipped build.
- **Q: A HENS name has no record for the target chain's coin type. Fall back or refuse?** A:
  **Fall back to the ETC mainnet record**: coin-61 `addr`, else the name's `resolve()` target. The
  UI discloses that it did (FR-006).
- **Q: An address has both an ENS and a HENS name. Which one is shown?** A: **ENS.**
- **Q: Zcash Names?** A: **Out of scope for now.** The registry stays extensible, so a later spec
  can add it as a row.

## Problem statement

Every address field in the app understands exactly one naming system. `useEnsResolution`
(`frontend/src/hooks/useEnsResolution.js`) recognises a hardcoded ENS TLD list
(`utils/validation.js#isEnsName`: `.eth`, `.xyz`, `.app`, …) and always resolves on Ethereum
mainnet. A member who pastes `alice.etc` sees "Enter a valid Ethereum address or ENS name", even
though `.etc` is a live, on-chain name on a network the app supports (ETC 61).

### HENS (`.etc`): what the chain says

Sources: https://hens.domains/#docs, https://github.com/HebePlatform/etc-names, and Blockscout
verified source. Every address below was read on chain on 2026-11-28.

| | ETC mainnet (61): **the resolution source** | Mordor (63): test deployment only |
|---|---|---|
| `NameNFT` (ERC-721 + registrar + resolver, non-upgradeable, solc 0.8.30, Blockscout-verified) | `0xFfC26c447c90f9eBdAe34A0C368f702c4643de34` | `0xDe00a0D68Af888a402d532FD20b952BDCc86d58c` |
| `SubdomainRegistrar` | none found from the deployer | `0x55936aD366d7734C5Ce3F99Fc3acA5bE612c1dB7` (its constructor arg points at the Mordor `NameNFT`) |
| `NameMetadataRenderer` | `0x64E11DD4aC0C7ea856AbDC1524dB8094cEfb4c97` | — |
| Creator | `0xA5a52D92ff302fCca9e5b060EC797F01311c66fF` | same EOA |
| Current `owner()` | `0x3520247f76e18b7bb6835bcd24de6925eaa1ab10` (transferred) | `0xA5a52D92…66fF` (deployer) |

On Mordor the deployer also left three older `NameNFT` iterations (`0x4B59…bbA0`, `0x913c…4a3d`,
`0xEEf4…0DBf`/`0xfabA…68Ae` "Etc Name Service"). They are not the Mordor deployment named above,
and nothing may read them.

The resolver surface is **ENS-resolver-shaped**:
- `addr(bytes32)` and `addr(bytes32,uint256) → bytes`, which follow ENSIP-9/11 for coin types;
- `text(bytes32,string)`;
- token-id twins `addr(uint256,uint256)`, `text(uint256,string)` and `resolve(uint256)`;
- `computeNamehash(string)` and `computeId(string)`, exposed on chain;
- `reverseResolve(address) → string` and `primaryName(address)`;
- `isExpired` and `expiresAt`.

Inactive names, and names in their 90-day grace period, resolve to `address(0)`. `reverseResolve`
returns a name only if that name forward-resolves back to the address and is active. Labels are
normalised by ASCII lowercase only (`isAsciiLabel` exists). That is not UTS-46 or ENSIP-15.
HENS publishes no SDK and no HTTP API.

## Why this is not "add `.etc` to a regex"

1. **A name resolves on a chain, and that chain is not necessarily the one the value moves on.**
   ENS resolves on mainnet whatever the wallet is on, and HENS resolves on 61. A HENS name can hold
   different addresses per coin type. Silently using whichever record came back first sends to an
   address the owner may not have meant for that chain.
2. **The value path depends on it.** A resolved name becomes the recipient of a transfer, a wager
   counterparty, a vault owner or a pool member. A name that changes between display and signature
   is a substitution attack whether or not anyone intended one.
3. **HENS normalisation is not ENS normalisation.** Running a `.etc` label through `viem/ens`
   `normalize` (ENSIP-15) can produce a different label from the one the contract hashes, and so
   resolve a different name.

## User Scenarios & Testing *(mandatory)*

### User Story 1: Send to a `.etc` name (Priority: P1)

As a member, on any EVM chain and on either build cohort, I type `alice.etc` into a recipient
field. I see the address it resolves to on ETC mainnet, and which record it came from.

**Independent Test**: On the no-chain tier with a stubbed chain-61 `NameNFT`, `alice.etc`
resolves, the resolved address is shown in full before confirmation, and the transfer is built to
that address.

### User Story 2: An address shows its name (Priority: P2)

As a member looking at a counterparty, vault owner or contact, I see its verified HENS primary name
when it has one and no ENS name. When it has both, I see the ENS name.

**Independent Test**: An address holding both renders the ENS name, an address holding only HENS
renders the `.etc` name, and an unverified reverse record renders no name.

### User Story 3: An unreachable chain is not a missing name (Priority: P1)

As a member whose ETC RPC is down, I am told that the name could not be checked. I am not told that
it does not exist, and nothing is offered as a recipient.

**Independent Test**: With a failing chain-61 provider, the field renders `unreadable`, never
`not-found`, and yields no address.

### Edge cases

- **Inactive or in-grace name**: `address(0)`. Render "not active", which is distinct from "not
  found". Never offer zero as a recipient.
- **No record for the target chain's coin type**: fall back to the ETC mainnet record and disclose
  it (FR-006).
- **Non-ASCII label**: normalised as the contract does it. A confusable label is not blocked, but
  the resolved address is always shown in full before signature.
- **The name changes owner or record between the field and the confirm sheet**: FR-010.
- **Testnet build**: still resolves against ETC mainnet (FR-012).
- **Both ENS and HENS names on one address**: ENS wins (FR-008).

## Requirements *(mandatory)*

### Functional requirements

- **FR-001 (one registry)**: Naming services are declared once, in a registry (provisionally
  `config/namingServices.js`). Each row holds: suffixes, the network it resolves on, the address
  family it yields (`evm` today), forward and reverse capability, a normaliser, and the recorded
  contract address with its source link. Suffix detection, field validation and resolution all
  read the registry. `isEnsName`'s hardcoded TLD list is retired into the ENS row. A later service
  (Zcash Names, SNS `.sol`, Unstoppable) is a new row and an adapter, never a new hook in each
  field.
- **FR-002 (four outcomes)**: Every resolution returns exactly one of:
  - `resolved {address, service, chain, record, observedAt}`
  - `not-found`, which also covers inactive, expired and in-grace names, each with a reason
  - `unreadable`, when the chain or RPC could not answer
  - `unsupported`, when the suffix is recognised but the field cannot use it

  Only `resolved` carries an address. An unreachable chain is never `not-found` (the spec-104
  `accountLookup` device).
- **FR-003 (address family gate)**: Each address field declares the address family it accepts.
  A recognised name whose service yields another family is `unsupported`, named, and makes no
  network call. Today every service yields `evm`; the gate exists so the next non-EVM row cannot
  fill an EVM field.
- **FR-004 (ENS unchanged)**: ENS keeps its current behaviour: the mainnet read, the current
  normalisation, and the non-blocking reverse decoration from #1431. This feature generalises the
  ENS path. It does not change ENS results.
- **FR-005 (HENS adapter)**: `.etc` names are read from the chain-61 `NameNFT`
  (`0xFfC26c447c90f9eBdAe34A0C368f702c4643de34`) through the spec-069 read seam
  (`getReadProvider(61)` / `readProviderFor`), never through a hand-built provider. Normalisation
  matches the contract (ASCII lowercase); ENSIP-15 `normalize` is never applied to a `.etc` name.
  The node is whatever the contract's `computeNamehash` / `computeId` produce. The plan verifies
  whether that equals ENS namehash before computing it off chain, and otherwise reads it from the
  contract. The address is recorded config, not a literal at call sites.
- **FR-006 (coin type follows the transaction, ETC record as fallback)**: For a field bound to
  target chain *C*, HENS resolution reads `addr(node, coinTypeOf(C))` (ENSIP-11). If that record is
  empty, it falls back to the ETC mainnet record: `addr(node)` (coin 60/61), else `resolve(id)`.
  `resolved.record` states which one answered, and when the fallback answered the UI says
  "address from the name's ETC record". A field with no target chain (for example the address
  book) uses the ETC record directly.
- **FR-007 (Mordor deployment is a fixture, not a source)**: The Mordor `NameNFT`
  (`0xDe00a0D68Af888a402d532FD20b952BDCc86d58c`) and `SubdomainRegistrar`
  (`0x55936aD366d7734C5Ce3F99Fc3acA5bE612c1dB7`) may be recorded for developer and manual staging
  validation only. No shipped build resolves a member's input against them.
- **FR-008 (reverse lookup is verified, decorative, and prefers ENS)**: A reverse name is shown
  only if it forward-resolves back to the same address. HENS `reverseResolve` does this check
  itself, and the adapter asserts it. Reverse lookup never blocks the field's success state
  (#1431). When an address has both an ENS name and a HENS name, **ENS wins**. The display
  priority stays **address book > callsign > ENS > HENS > generated** (spec 054, extended).
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
- **FR-012 (HENS crosses the cohort on purpose, and says so)**: HENS resolves against ETC mainnet
  on every build, testnet builds included. This is a documented exception to the
  cohort-boundary rule, and it has the same shape as the existing ENS-on-mainnet behaviour: a
  read that maps a name to an address, and never a value read or write. On a testnet build the
  resolved hint says the name was read on ETC mainnet.
- **FR-013 (assistant / MCP)**: Out of scope for v1.

### Key entities

- **NamingService**: a registry row (FR-001).
- **NameResolution**: the four-outcome result (FR-002), keyed by `(service, normalisedName,
  targetChain)`.
- **ReverseName**: the forward-verified name for an address.

## Success criteria *(mandatory)*

- **SC-001**: A `.etc` name resolves in every EVM address field on both build cohorts. No field
  carries its own suffix list (enforced by a test over `isEnsName` callers).
- **SC-002**: No path renders an unreachable RPC as "name not found" (unit-tested per adapter, with
  a failing fake that asserts on the REQUEST, per the spec-089 lesson).
- **SC-003**: No signature is produced for an address that differs from the one shown on the
  confirm surface (FR-010, covered at the no-chain tier).
- **SC-004**: No `.etc` resolution ever reads a chain other than 61 (asserted on the provider the
  adapter requests).

## Agent routing

- `glass`: `AddressInput`, the reverse-name label, the confirm-surface disclosure.
- `satchel`: the cohort exception (FR-012) and coin-type mapping.
- `custos`: FR-009 and the screening hand-off.
- `mark`: recording the HENS addresses as config.
- `witness`: after every change.

No contract changes. HENS is a read-only integration, and FairWins registers no names.

## Out of scope

- **Zcash Names** (`.zcash` / `.zec`, https://www.zcashnames.com/docs). Deferred. For the later
  spec, here is what we know:
  - There is no contract. Names are memo-bound and read through a JSON-RPC resolver, verified
    against a published unified full viewing key.
  - A name resolves to a `u1…` unified address, which the app has no network to pay.
  - The SDK is `zcashname-sdk`.
  - No public resolver URL or CORS policy is documented.
- Registering, renewing or managing HENS names (commit-reveal, the subdomain registrar).
- HENS text records, contenthash and avatar.
- Changing `%callsign` (spec 054) semantics.
