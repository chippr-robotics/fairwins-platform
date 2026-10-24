# 05 — Annex: Cryptographic Bill of Materials

> Every primitive, curve, domain, KDF, key and pinned library the platform
> actually uses, with evidence. A CBOM earns its keep in two situations: an
> algorithm has to be migrated, and a key has to be rotated after a compromise.
> Both need the same thing — an exhaustive list of where a primitive is reached
> and what hangs off each key — so the two load-bearing sections here are the
> **key-derivation hierarchy** (§5) and the **key material inventory** (§6).

## The three roots

Nearly all member-side cryptography descends from one of three roots, and knowing
which one a secret hangs from tells you its blast radius:

| Root | What it is | What hangs off it | Rotation story |
|---|---|---|---|
| **Passkey PRF master seed** | 32 bytes from the WebAuthn PRF extension, per credential | X25519 envelope key, X-Wing key, unified backup key, **and the entire Bitcoin key tree** | None — the seed is a property of the credential; the four HKDF info strings and the PRF salt are **wallet-breaking constants** |
| **Platform KMS keys** | `EC_SIGN_SECP256K1_SHA256` in Cloud KMS | Relayer gas signing, paymaster op authorization | Key versions in KMS; material never exportable, so compromise means revoking use, not recovering the key |
| **Floppy keystore mnemonic** | Air-gapped, physically-held | Admin/deploy authority, paymaster `owner` | Physical; deliberately outside every automated path |

Below those sit three lower-assurance tiers: Secret Manager (deployer key, alto
executor EOAs), the device secure enclave (the passkey credentials themselves),
and member-held device-only credentials (RPC keys, the GutterToken `sk-…` key) —
which are test-asserted *absent* from the backup registry, so they cannot leave
the device that created them.

## What this annex does not find

Stated because an absence verified is worth more than an absence assumed: there
is **no live ZK/Semaphore path** (the Groth16 material is archive-only), **no
MPC/TSS/Shamir**, and **no weak primitive anywhere** — MD5, SHA-1, DES, RC4 and
ECB mode are all absent, and `eth_sign` appears only inside a refusal list.

## Full CBOM

**Scope:** `/home/user/prediction-dao-research` @ `version.json` / `package.json` version **1.18.0**.
**Method:** static read of source + `package-lock.json`. Every row cites `path:line`. Read-only; nothing modified.
**Convention:** "NOT DETERMINED" means the repo does not state it and I refused to guess.

---

## 0. Executive risk register (details in the sections cited)

| # | Finding | Severity | Evidence |
|---|---|---|---|
| R1 | **Hand-rolled X-Wing hybrid KEM**, commented "per IETF draft-connolly-cfrg-xwing-kem" but **demonstrably divergent from it**: the label literal `'\\./\n\\./\n'` evaluates to the **8 bytes** `5C 2E 2F 0A 5C 2E 2F 0A`, where the draft's label is the **6-byte** `\.//^\`; and the ML-KEM/X25519 component seeds are expanded with three ad-hoc `SHA3-256("xwing-mlkem-1"/"xwing-mlkem-2"/"xwing-x25519" ‖ seed)` calls rather than the draft's expansion. Self-consistent (encap/decap agree) but **not interoperable** and unaudited. Combiner shape `SHA3-256(label‖ss_M‖ss_X‖ct_X‖pk_X)` does match. | High (crypto-implementation) | `frontend/src/utils/crypto/envelopeEncryption.js:41` (label), `:44-54` (combiner), `:62-80` (keygen/seed expansion), `:92-121` (encap), `:132-169` (decap) |
| R2 | **Claim codes carry ~2^44 entropy** and deterministically derive a **secp256k1 private key** that is the on-chain `claimAuthority` for an open challenge. | High | `frontend/src/utils/claimCode/wordlist.js:4`; `frontend/src/utils/claimCode/deriveFromCode.js:47` |
| R3 | **Envelope/backup/address-book keys are `keccak256(signature_hex_string)`** — the wallet signature *is* the key material, so a leaked or replayed signature is a permanent key compromise with no rotation path. | High | `frontend/src/lib/backup/backupCrypto.js:17,21`; `frontend/src/utils/crypto/envelopeEncryption.js` (sig-derived paths) |
| R4 | **Two incompatible floppy-keystore MAC schemes coexist.** `keystore.js` writes/verifies Web3-V3 `keccak256(dk[16:32]‖ct)` with a constant-time compare; `loader.js` + `store-admin-key.js` use `HMAC-SHA256` with a **non-constant-time `mac.equals()`**, and at **scrypt N=2^14** vs the config's 2^18. | Medium-High | `scripts/operations/floppy-key/keystore.js:55-60,130-133`; `loader.js:278-283`; `store-admin-key.js:59,86`; `config.js:16,22` |
| R5 | **`script-src 'unsafe-inline'` in production CSP** alongside `blob:` (needed for mini-app package execution). The file itself documents the cost. | Medium | `frontend/nginx.conf:96` |
| R6 | **`connect-src https:` scheme-wide** (BYO-RPC, spec 069) — any HTTPS origin is a valid exfiltration sink for an injected script. Accepted trade-off, documented. | Medium | `frontend/nginx.conf:96` |
| R7 | ~~**Dead but present NaCl/XSalsa20 module.**~~ **CLOSED (spec 110 T028):** `frontend/src/utils/encryption.js` is DELETED. It had no importers in shipped or test paths, and it also could not have run: it imported `recoverPublicKey` from `ethers`, which **ethers v6 does not export** (`SigningKey.recoverPublicKey` is the v6 static), so `derivePublicKeyFromSignature` — and the two exported functions that called it — would have thrown `TypeError` on first use. Deadness was not merely unproven demand, it was unrunnable code, presumably since the v5→v6 migration. `tweetnacl`/`tweetnacl-util` are now unused but are deliberately LEFT in `frontend/package.json`: removing them re-resolves the root lockfile, which is the npm/cli#4828 hazard that silently drops the platform rolldown binary (spec 075). Drop them in a change whose only job is dependencies, behind `npm run check:deps`. | Closed | module deleted (spec 110 T028) |
| R8 | **Safe vault `saltNonce = Date.now()`** — predictable, low entropy; identical owner-set + same-millisecond creation collides. | Low-Medium | `frontend/src/components/custody/createflow/CreateVaultFlow.jsx:31` |
| R9 | **Origin-lock is a shared secret compared by nginx `map`** (not constant-time), and the doc itself names mTLS/Authenticated Origin Pulls as the stronger control, out of scope. | Low-Medium | `infra/cloudflare/origin-lock.md:6,38-40,57-63` |
| R10 | **x402 replay protection is in-process only** (a Map in one gateway instance); durability delegated to the token's own `authorizationState`. Honest, but multi-instance dedup is not local. | Low (documented) | `services/relay-gateway/src/x402/verify.js:63-87,273` |
| R11 | **Two `solc` versions in the tree**: root pinned `0.8.24` (the solcjs bytecode path), plus hardhat's own transitive `solc@0.8.26`. CLAUDE.md notes the byte gate does not cover the solcjs path. | Low-Medium | root `package.json` `"solc": "0.8.24"`; `package-lock.json` → `node_modules/hardhat/node_modules/solc` = `0.8.26`; `hardhat.config.js:198-232` |
| R12 | **`elliptic@6.6.1` present** (pulled in transitively, force-`overrides`-pinned). Historically CVE-heavy ECDSA implementation; 6.6.1 is the remediated line but it is still in the graph. | Low | root `package.json` `"overrides": { "elliptic": "^6.6.1" }`; lock `node_modules/elliptic` = 6.6.1 |
| R13 | **`ethers@5.8.0` coexists with `ethers@6.17.0`** (under `@chainlink/contracts`, dev-only). Two signing stacks in one lockfile. | Low | lock: `node_modules/@chainlink/contracts/node_modules/ethers` = 5.8.0 |
| R14 | **No `@simplewebauthn/*` server-side verification anywhere.** WebAuthn assertion verification is **on-chain only** (FreshCryptoLib / RIP-7212). No off-chain attestation checking, and `attestation` is not requested at creation. Deliberate-looking, but it means credential provenance is never checked. | Informational | `contracts/account/lib/webauthn-sol/WebAuthn.sol:152-162`; `frontend/src/lib/passkey/credentials.js:344-356` (no `attestation` key) |

---

## 1. Signature schemes & curves

| Scheme | Curve / params | Where used | Evidence |
|---|---|---|---|
| **secp256k1 ECDSA** (raw tx) | secp256k1, low-S normalized (EIP-2) | Every EOA transaction; hardware signers; recovered legacy keys | `frontend/src/lib/hardware/hardwareSigner.js:76-104` (recover-and-verify before broadcast) |
| **EIP-191 `personal_sign`** | secp256k1 | Message signing (Protect ▸ Verify), encryption-key derivation messages, paymaster sponsorship signature | `frontend/src/lib/verify/verifyMessage.js:71-76`; `services/relay-gateway/src/paymaster/sign.js:22-27` |
| **EIP-712 typed data** | secp256k1 | All gasless intents, pool actions, callsigns, EIP-3009, member-API grants | §2 |
| **EIP-1271 contract signatures** | magic `0x1626ba7e` | Smart-account / vault signature verification; the ONLY accepted success value | `frontend/src/lib/verify/verifyMessage.js:41-42,137`; `contracts/upgradeable/SignerIntentBase.sol:95-107` |
| **ERC-1271 domain (account)** | `CoinbaseSmartWalletMessage(bytes32 hash)` replay-safe wrapper | Passkey smart account | `contracts/account/ERC1271.sol:23,101-136` |
| **P-256 / ES256 WebAuthn** | secp256r1; COSE alg **`-7` ONLY** | Passkey credential creation + assertion | `frontend/src/lib/passkey/credentials.js:349` (`pubKeyCredParams: [{ type: 'public-key', alg: -7 }]`) |
| **P-256 on-chain verification** | RIP-7212 precompile at `address(0x100)`, **fallback to FreshCryptoLib** `FCL_ecdsa.ecdsa_verify` | `WebAuthn.verify` inside the smart account | `contracts/account/lib/webauthn-sol/WebAuthn.sol:50-52,152-162` |
| P-256 malleability guard | `s > n/2` rejected | same | `WebAuthn.sol:48,110` |
| **WebAuthn message hash** | `sha256(authenticatorData ‖ sha256(clientDataJSON))` | same | `WebAuthn.sol:146,150` |
| **BIP-340 Schnorr / Taproot** | **Implemented via `@scure/btc-signer` `p2tr`** — BIP-341 key-path tweak; BIP-86 derivation. No hand-rolled Schnorr. | Bitcoin receive/send | `frontend/src/lib/bitcoin/addresses.js:27,66-70`; `derivation.js:49` |
| **Ed25519** | RFC 8032 via `@noble/curves/ed25519.js` | Solana send/sign (spec: recovered-account cross-chain) | `frontend/src/lib/solana/derivation.js:26,96,106-107` |
| **Safe multisig threshold** | `approveHash` / `approvedHashes(owner, txHash) == 1`, checked at `nonce()-1`, approver must still be `isOwner` | SafePolicyGuardV2 | `contracts/custody/SafePolicyGuardV2.sol:11-12,213-223,583` |
| **KMS secp256k1 signing** | `EC_SIGN_SECP256K1_SHA256`, DER→{r,s} with low-S normalization + parity recovery | Relayer gas keys, paymaster sponsorship signer | `infra/terraform/environments/prod/variables.tf:71-74`; `services/relay-gateway/src/paymaster/sign.js:35-76` |
| **Threshold / MPC** | **NONE.** No MPC, no TSS, no Shamir anywhere in shipped paths. | — | grep: no `shamir`/`mpc`/`tss` hits in `contracts/`, `frontend/src`, `services/` |
| **ZK / Semaphore** | **REMOVED from live paths, ARCHIVED only.** Spec 034 explicitly dropped Semaphore; pools are by public wallet address. `script-src` carries **no WASM grant** because of that removal. Archived Groth16/BN128 verifier is reference-only. | — | `contracts/pools/WagerPool.sol:36`; `contracts/pools/WagerPoolFactory.sol:26`; `frontend/nginx.conf:54`; `contracts-archive/privacy/ZKVerifier.sol:9-14` (Groth16, BN128 `ecPairing 0x08`) — `contracts-archive/` is never imported or deployed |
| EIP-2098 compact sigs | **NOT FOUND.** No compact-signature encoding in any contract or client path. | — | grep `2098` → no hits |

---

## 2. Typed-data / domain separation

### 2.1 EIP-712 domains — contract-verified (single source: `packages/intent-types/src/index.js:65-94`)

`chainId` and `verifyingContract` are runtime values; only name/version are static. Parity to Solidity `__EIP712_init` is gate-enforced by `test/intent/TypehashParity.test.js`.

| Domain key | `name` | `version` | Verifying contract | Evidence |
|---|---|---|---|---|
| `wagerRegistry` | `FairWins WagerRegistry` | `1` | proxy | `intent-types/src/index.js:66`; `contracts/wagers/WagerRegistry.sol:60,82` |
| `membershipManager` | `FairWins MembershipManager` | `1` | proxy | `index.js:67`; `contracts/access/MembershipManager.sol:123,134` |
| `wagerPool` | `FairWins WagerPool` | `1` | **the clone** | `index.js:71`; `contracts/pools/WagerPool.sol:171` |
| `wagerPoolFactory` | `FairWins WagerPoolFactory` | `1` | factory proxy | `index.js:72`; `contracts/pools/WagerPoolFactory.sol:119,129` |
| `callsignRegistry` | `FairWins CallsignRegistry` | `1` | registry proxy | `index.js:73`; `contracts/naming/CallsignRegistry.sol:113` |
| `fundingPool` | `FairWins FundingPool` | `1` | **the clone** | `index.js:77`; `contracts/pools/FundingPool.sol:136` |
| `fundingPoolFactory` | `FairWins FundingPoolFactory` | `1` | factory proxy | `index.js:78`; `contracts/pools/FundingPoolFactory.sol:108` |
| (test only) `Mock` / `1` | — | — | `contracts/mocks/MockSignerIntent.sol:26` |

The **domain/target split** for pools: signature verified under the *clone's* domain, transaction targeted at the *factory forwarder* — `INTENT_ACTIONS[*].domainVerifier` vs `.verifier`, `intent-types/src/index.js:482-489`.

### 2.2 EIP-712 domains — off-chain (no Solidity verifier, by design)

| Domain | `name` | `version` | chainId / verifyingContract | Verifier | Evidence |
|---|---|---|---|---|---|
| Member API capability token | `FairWins Member API` | `1` | **deliberately ABSENT both** (chain-agnostic grant) | `services/relay-gateway/src/memberApi/auth.js` | `packages/intent-types/src/offchain.js:50-63` |

### 2.3 EIP-712 domains — third-party token (EIP-3009), gateway-side

| Chain | `paymentToken` domain `name` | `version` | Evidence |
|---|---|---|---|
| Polygon 137 | `USD Coin` | `2` | `services/relay-gateway/src/config/chains.js:29` |
| Amoy 80002 | `USDC` | `2` | `chains.js:43` |
| ETC 61 / Mordor 63 | `null` — **no EIP-3009** (permit-only USC) | — | `chains.js:53,65` |

### 2.4 Struct / typehash inventory

**Contract-verified** (`CONTRACT_VERIFIED_TYPES` = `INTENT_TYPES ∪ OPEN_ACCEPT_TYPES ∪ FUNDING_POOL_TYPES`, `intent-types/src/index.js:372`). Common trailing fields on nearly all: `nonce bytes32, validAfter uint256, validBefore uint256` (`index.js:119-123`).

| Primary type | Domain | Notable fields | Evidence (package) | Evidence (Solidity typehash) |
|---|---|---|---|---|
| `CreateWagerIntent` | wagerRegistry | 15 fields + trailing, incl. `metadataHash`, `termsVersionHash`, `paymentNonce` | `index.js:136-153` | `contracts/wagers/WagerRegistryIntents.sol:35` |
| `AcceptWagerIntent` | wagerRegistry | `wagerId, taker, paymentNonce` | `index.js:154-159` | `WagerRegistryIntents.sol:38` |
| `ClaimPayoutIntent` | wagerRegistry | `wagerId, claimant` | `index.js:160-164` | `WagerRegistryIntents.sol:41` |
| `ClaimRefundIntent` | wagerRegistry | `wagerId, actor` | `index.js:165` | `WagerRegistryIntents.sol:44` |
| `DeclareDrawIntent` | wagerRegistry | `wagerId, actor` | `index.js:166` | `WagerRegistryIntents.sol:47` |
| `RevokeDrawIntent` | wagerRegistry | `wagerId, actor` | `index.js:167` | `WagerRegistryIntents.sol:50` |
| `CancelOpenIntent` | wagerRegistry | `wagerId, actor` | `index.js:168` | `WagerRegistryIntents.sol:53` |
| `DeclineIntent` | wagerRegistry | `wagerId, actor` | `index.js:169` | `WagerRegistryIntents.sol:56` |
| `DeclareWinnerIntent` | wagerRegistry | `wagerId, winner, actor` | `index.js:170-175` | `WagerRegistryIntents.sol:59` |
| `PurchaseTierIntent` | membershipManager | `role bytes32, tier uint8, acceptedTermsHash, member, paymentNonce` | `index.js:176-183` | `contracts/access/MembershipManager.sol:30` |
| `UpgradeTierIntent` | membershipManager | same shape | `index.js:184-191` | `MembershipManager.sol:33` |
| `ExtendMembershipIntent` | membershipManager | `role, member, paymentNonce` | `index.js:192-197` | `MembershipManager.sol:36` |
| `RedeemVoucherIntent` | membershipManager | `voucherId, acceptedTermsHash, redeemer` | `index.js:198-203` | `MembershipManager.sol:39` |
| `InvalidateNonce` | either (`verifier: null`) | `signer, nonce, validBefore` — **no `validAfter`** | `index.js:206-210` | `contracts/upgradeable/SignerIntentBase.sol:27-28` (literal: `InvalidateNonce(address signer,bytes32 nonce,uint256 validBefore)`) |
| `ApproveOutcome` | wagerPool (clone) | `member, proposalId` | `index.js:215-219` | `contracts/pools/WagerPool.sol:74` (`APPROVE_TYPEHASH`) |
| `ClaimShare` | wagerPool (clone) | `winner, index, recipient` | `index.js:220-225` | `WagerPool.sol:76` (`CLAIM_TYPEHASH`) |
| `ProposeOutcome` | wagerPool (clone) | `creator, proposalId` | `index.js:226-230` | `WagerPool.sol:78` (`PROPOSE_TYPEHASH`) |
| `CloseJoining` | wagerPool (clone) | `creator` | `index.js:231-234` | `WagerPool.sol:80` (`CLOSE_TYPEHASH`) |
| `Cancel` | wagerPool (clone) | `creator` | `index.js:235-238` | `WagerPool.sol:82` (`CANCEL_TYPEHASH`) |
| `Refund` | wagerPool (clone) | `member` | `index.js:239-242` | `WagerPool.sol:84` (`REFUND_TYPEHASH`) |
| `CreatePool` | wagerPoolFactory | `creator, token, buyIn, maxMembers, thresholdBips, acceptDeadline, resolveDeadline` | `index.js:243-252` | `contracts/pools/WagerPoolFactory.sol:52` |
| `CommitCallsignIntent` | callsignRegistry | `owner, commitment bytes32` (ENS-style commit) | `index.js:256-260` | `contracts/naming/CallsignRegistry.sol:34` |
| `RegisterCallsignIntent` | callsignRegistry | `owner, callsign string, salt bytes32` (reveal; hashed as `keccak256(bytes(callsign))` in the struct encoding, per EIP-712 string handling) | `index.js:261-266` | `CallsignRegistry.sol:36`, encoding at `:336` |
| `ChangeCallsignIntent` | callsignRegistry | `owner, newCallsign, salt` | `index.js:267-272` | `CallsignRegistry.sol:38`, encoding at `:345` |
| `ReleaseCallsignIntent` | callsignRegistry | `owner, callsignHash` | `index.js:273-277` | `CallsignRegistry.sol:40` |
| `RequestRepointIntent` | callsignRegistry | `owner, callsignHash, newOwner` | `index.js:278-283` | `CallsignRegistry.sol:42` |
| `CancelRepointIntent` | callsignRegistry | `owner, callsignHash` | `index.js:284-288` | `CallsignRegistry.sol:44` |
| **`OpenAccept`** | wagerRegistry | `wagerId uint256, taker address` — **no nonce/validity**, signed by the CLAIM-CODE-derived key, not the member | `index.js:307-312` | `contracts/wagers/WagerRegistryCore.sol:52` (`OPEN_ACCEPT_TYPEHASH`) |
| `CloseFundingPool` | fundingPool (clone) | `organizer` | `index.js:345-348` | `contracts/pools/FundingPool.sol:69` |
| `CancelFundingPool` | fundingPool (clone) | `organizer` | `index.js:349-352` | `FundingPool.sol:71` |
| `VoteRefund` | fundingPool (clone) | `contributor` | `index.js:353-356` | `FundingPool.sol:73` |
| `ClaimRefund` | fundingPool (clone) | `contributor` | `index.js:357-360` | `FundingPool.sol:75` |
| `CreateFundingPool` | fundingPoolFactory | `organizer, token, goal, purposeHash = keccak256(bytes(purpose)), contributeDeadline, settleDeadline` | `index.js:361-369` | `contracts/pools/FundingPoolFactory.sol:50` |

**Off-chain-verified structs** (absent from `CONTRACT_VERIFIED_TYPES` on purpose — no Solidity counterpart exists or should):

| Primary type | Fields | Verifier | Evidence |
|---|---|---|---|
| `ApiKeyGrant` | `account address, keyId bytes32, scopes **string** (canonical space-joined, sorted, deduped), issuedAt uint256, expiresAt uint256` — `label` is deliberately NOT signed | relay-gateway `memberApi/auth.js` | `packages/intent-types/src/offchain.js:78-86,122-131`; `services/relay-gateway/src/memberApi/auth.js:147` |
| `ApiKeyRevocation` | `account, keyId, revokedAt` — **self-authorizing, no bearer token required** | same | `offchain.js:99-105`; `auth.js:190` |

**EIP-3009 token structs** (authority = Circle's deployed USDC, not this repo; verified against recorded vectors, since the only in-repo copy is `contracts/mocks/MockUSDCPermit.sol:16`):

| Primary type | Fields | Submitter rule | Evidence |
|---|---|---|---|
| `ReceiveWithAuthorization` | `from, to, value, validAfter, validBefore, nonce bytes32` | token enforces `to == msg.sender` → only the recipient contract | `intent-types/src/index.js:392-401` |
| `TransferWithAuthorization` | identical field list | **any** address may submit | `index.js:403-412`; used by x402 payer path `services/relay-gateway/src/x402/verify.js:239-250` |

**Typehash derivation helper** (flat structs only; throws on nested custom types rather than emitting a subtly wrong string): `intent-types/src/index.js:428-441`.

---

## 3. Hashes & KDFs

| Primitive | Parameters | Purpose | Evidence |
|---|---|---|---|
| **keccak256** | — | EIP-712 typehashes + domain separators; ERC-7201 storage namespaces; CREATE2 salts; mini-app manifest commitment; FeeRouter `serviceId`s; role ids; claim-code key derivation; symmetric-key derivation from signatures | throughout; see below |
| keccak256 → `serviceId` | `ethers.id('earn.lend')` etc. | FeeRouter service ids | `frontend/src/lib/fees/feeQuote.js:37,43-61` (`earn.lend`, `polymarket.taker`, `polymarket.maker`, `stake.lido`, `stake.polygon`, `bridge.transfer`, `liquidity.deposit`, `perps.hyperliquid.builder`) |
| keccak256 → role | `keccak256("FEE_ADMIN_ROLE")` | AccessControl role ids | `contracts/fees/FeeRouter.sol:34` |
| keccak256 → ERC-7201 slot | `keccak256(abi.encode(uint256(keccak256("fairwins.storage.SignerIntentBase")) - 1)) & ~bytes32(uint256(0xff))` | Namespaced upgradeable storage | `contracts/upgradeable/SignerIntentBase.sol:30,36`; `contracts/account/MultiOwnable.sol:40-41` (`coinbase.storage.MultiOwnable`) |
| keccak256 → CREATE2 salt (platform) | `ethers.id(identifier)`, or `ethers.id("tenant:<id>:<identifier>")` when `TENANT_ID` is set | Deterministic deploys; tenant isolation | `scripts/deploy/lib/helpers.js:73-76` |
| keccak256 → CREATE2 salt (account) | `keccak256(abi.encode(owners, nonce))` | ERC-4337 passkey account address | `contracts/account/CoinbaseSmartWalletFactory.sol:95-96` |
| keccak256 → CREATE2 salt (Safe) | `solidityPackedKeccak256(['bytes32','uint256'], [keccak256(initializer), saltNonce])`, then `getCreate2Address(proxyFactory, salt, keccak256(deploymentData))` | Same-address multichain vaults | `frontend/src/lib/custody/safeVault.js:80-87` |
| keccak256 → mini-app manifest commitment | `keccak256(manifest.json raw bytes)` — re-checked before parsing, on every retrieval incl. cache | Code integrity | `frontend/src/lib/miniapps/integrity.js:33,150-151,180-184`; `loader.js:10-12`; `scripts/miniapps/publish.js:281,481-487` |
| keccak256 → claim key | `keccak256(utf8("FairWins/claim/v1" ‖ normalizedCode))` = secp256k1 scalar; independent `keccak256(utf8(TERMS_DOMAIN ‖ code))` = 32-byte AEAD key | Open-challenge claim codes | `frontend/src/utils/claimCode/deriveFromCode.js:47,51` |
| keccak256 → symmetric key from signature | `getBytes(keccak256(toUtf8Bytes(signature)))` | Backup key, envelope keys | `frontend/src/lib/backup/backupCrypto.js:17,21`; also `keccak256(concat([seed, utf8(DATA_BACKUP_MESSAGE_V1)]))` for the passkey twin, `backupCrypto.js:35` |
| **sha256** | — | Mini-app per-file byte integrity; WebAuthn message hash; bytecode digests; KMS digest input | `frontend/src/lib/miniapps/integrity.js:34,139-140`; `contracts/account/lib/webauthn-sol/WebAuthn.sol:146,150`; `scripts/codegen/bytecode-digest.js:99-101`; `scripts/miniapps/record-build-digests.js:43`; `services/relay-gateway/src/paymaster/sign.js:47` |
| **SHA3-256** | — | X-Wing combiner + component-seed expansion (R1) | `frontend/src/utils/crypto/envelopeEncryption.js:21,47-53,65-69,144-151` |
| **HMAC-SHA256** | — | Double-ratchet MAC; Polymarket L2 auth over `{ts}{METHOD}{path}{body}` with base64url-decoded secret; admin floppy keystore MAC | `frontend/src/utils/crypto/primitives.js:15,63-65`; `services/relay-gateway/src/polymarket/client.js:9-11,37-47`; `scripts/operations/floppy-key/store-admin-key.js:86` |
| **HMAC-SHA512** | key `"ed25519 seed"` | SLIP-0010 ed25519 (Solana), hand-rolled on `@noble` | `frontend/src/lib/solana/derivation.js:7-8,32,47-69` |
| **HKDF-SHA256** — passkey KEK | ikm = WebAuthn PRF output; **salt = 32 zero bytes**; **info = `"fairwins-kek-v1"`**; out = AES-GCM-256 key | Wraps the master seed | `frontend/src/lib/passkey/prfKeys.js:23,41-47` |
| HKDF-SHA256 — legacy-vault biometric KEK | salt = 32 zero bytes; **info = `"fairwins-legacy-kek-v1"`** (domain-separated from the above on purpose) | Passkey-PRF wrapping of imported legacy secrets | `frontend/src/lib/recovery/legacyKeys.js:34-37,196-199` |
| HKDF-SHA256 — Bitcoin seed | ikm = 32-byte master seed; salt = 32 zero bytes; **info = `"fairwins-btc-seed-v1"`**; **L = 64 bytes** | BIP-32 seed for the BTC tree. **WALLET-BREAKING IF CHANGED.** | `frontend/src/lib/bitcoin/derivation.js:42-46,85-86` |
| HKDF-SHA256 — passkey X25519 | salt = 32 zero bytes; **info = `"fairwins-passkey-x25519-v1"`**; L = 32 | Envelope keypair from master seed | `frontend/src/utils/crypto/envelopeEncryption.js:236,238,249` |
| HKDF-SHA256 — passkey X-Wing | salt = 32 zero bytes; **info = `"fairwins-passkey-xwing-v1"`**; L = 32 | X-Wing seed from master seed | `envelopeEncryption.js:237-238,263` |
| HKDF-SHA256 — ratchet | caller-supplied salt/info | Double-ratchet chain keys | `frontend/src/utils/crypto/primitives.js:13,51-55` |
| **PBKDF2-HMAC-SHA256** | **650,000 iterations**, 16-byte random salt, → AES-GCM-256. Iteration count stored per-entry for forward compat. | Legacy imported key/mnemonic vault at rest | `frontend/src/lib/recovery/legacyKeys.js:32,134-141,158-169,185` |
| **scrypt** (mnemonic keystore) | **N=262144 (2^18), r=8, p=1, dklen=32** | Floppy mnemonic keystore | `scripts/operations/floppy-key/config.js:16-19`; `keystore.js:6,38` |
| **scrypt** (admin key keystore) | **N=16384 (2^14), r=8, p=1, dklen=32** — deliberately lower, in-file comment | Floppy admin-private-key keystore | `scripts/operations/floppy-key/store-admin-key.js:58-71` |
| **Argon2 / bcrypt** | **NONE in any shipped path.** (`bcrypt-pbkdf` appears only as a transitive dev dep of `sshpk`.) | — | lock: `node_modules/bcrypt-pbkdf/node_modules/tweetnacl` (dev) |
| **Groth16 / BN128 pairing** | `ecAdd 0x06`, `ecMul 0x07`, `ecPairing 0x08` | **ARCHIVED ONLY** — never imported or deployed | `contracts-archive/privacy/ZKVerifier.sol:9-14,193,327`; `contracts-archive/README.md` |

**AAD binding (terms-version tamper evidence):** `FairWins-TC|<schemaVersion>|<sha256hex>` with `TERMS_AAD_VERSION = '1.1'` — byte-identical on seal and open; deliberately NOT in key derivation so keys stay versionless. `frontend/src/utils/crypto/constants.js:203-226`.

---

## 4. Symmetric encryption at rest

| Channel | Cipher | Key size | Key source | IV / nonce | Where ciphertext lives | Evidence |
|---|---|---|---|---|---|---|
| **Passkey master-seed wrap** | AES-GCM | 256 | HKDF-SHA256 over WebAuthn PRF output (`fairwins-kek-v1`) | `crypto.getRandomValues(12)` per wrap, stored base64 with `{v:1, iv, ct}` | Local blob store + spec-032 synced backup blobs | `frontend/src/lib/passkey/prfKeys.js:44-46,92-94,98` |
| **Legacy imported keys / mnemonics** | AES-GCM | 256 | PBKDF2-SHA256 650k over member passphrase, **or** HKDF over passkey PRF (biometric) | random 12-byte IV; random 16-byte PBKDF2 salt | `userStorage` key `legacy_recovered_keys`; rides spec-032 backup as `legacyRecoveredKeys`. **Plaintext secret is NEVER persisted, transmitted, or logged.** | `frontend/src/lib/recovery/legacyKeys.js:12-14,158-169,183-190`; `legacyRecoveredKeysStore.js` |
| **Unified data backup (spec 032)** | **ChaCha20-Poly1305** | 256 | `keccak256(signMessage("FairWins Data Backup v1"))`, or `keccak256(seed ‖ msg)` for passkey | random 12-byte nonce | Envelope `{format:'fairwins-data-backup', version:1, alg:'chacha20poly1305', nonce, ciphertext}`; AAD = `"fairwins-data-backup:1"` | `frontend/src/lib/backup/backupCrypto.js:13-18,26-45`; `frontend/src/utils/crypto/primitives.js:84-89` |
| **Wager metadata envelope (classical)** | ChaCha20-Poly1305 (`x25519-chacha20poly1305`) | 256 | X25519 ECDH → HKDF-SHA256 (`FairWins_Envelope_v1`) | random 12-byte nonce; AAD = terms binding | IPFS (Pinata) | `frontend/src/utils/crypto/constants.js:137,147-157`; `envelopeEncryption.js` |
| **Wager metadata envelope (PQ)** | ChaCha20-Poly1305 / XChaCha20-Poly1305 (`xwing-chacha20poly1305`) | 256 | X-Wing hybrid KEM (see R1), info `FairWins_XWing_Envelope_v1` | random nonce | IPFS | `constants.js:142,149,154-157`; `envelopeEncryption.js:22` |
| **Floppy mnemonic keystore** | **AES-128-CTR** (unauthenticated cipher + separate MAC, Web3 V3 style) | 128 (dk[0:16]) | scrypt 2^18 | random 16-byte IV; random 32-byte salt | `.keystore/mnemonic-keystore.json` on removable media | `scripts/operations/floppy-key/config.js:22`; `keystore.js:33-83` |
| **Floppy admin-key keystore** | AES-128-CTR | 128 | scrypt 2^14 | random 16-byte IV / 32-byte salt | same media | `store-admin-key.js:55-108` |
| ~~Dead code: NaCl box~~ | XSalsa20-Poly1305 (`x25519-xsalsa20-poly1305`) | 256 | `nacl.box.keyPair.fromSecretKey(keccak256(signature))` | `nacl.randomBytes(nacl.box.nonceLength)` (24) | **REMOVED — module deleted, R7 closed** | — |

**NEVER stored anywhere (asserted by code + gate tests):**
- Bitcoin private keys, xprv, **or xpubs** — memory-only, never persisted/logged/transmitted (`frontend/src/lib/bitcoin/derivation.js:90-95,118-133`).
- The passkey master seed in the clear (only the AES-GCM-wrapped blob).
- The plaintext of any legacy imported key or mnemonic.
- RPC endpoint credentials and the GutterToken `sk-…` key — device-scoped and **deliberately absent from `frontend/src/lib/backup/syncedObjects.js`** (a test asserts the absence): `frontend/src/lib/assistant/guttertokenKeyStore.js:36`.
- Hardware-wallet store holds **public metadata only** (`{address, vendor, path, label, addedAt}`) — never key material, never an xpub.

---

## 5. Key derivation & hierarchies

| Tree | Path / formula | Marked wallet-breaking? | Evidence |
|---|---|---|---|
| **Passkey master seed** | `PRF(salt = "fairwins.prf.salt.v1" zero-padded to 32 B)` → `HKDF-SHA256(info="fairwins-kek-v1")` → KEK → `AES-GCM(KEK, masterSeed)` | **YES** — changing the PRF salt or info string orphans every wrapped seed | `frontend/src/lib/passkey/prfKeys.js:5-7,22,35-38,41-47` |
| Passkey → envelope X25519 | `HKDF-SHA256(seed, salt=0^32, info="fairwins-passkey-x25519-v1", 32)` → `x25519.getPublicKey` | **YES** | `frontend/src/utils/crypto/envelopeEncryption.js:236,247-252` |
| Passkey → X-Wing | `HKDF-SHA256(seed, 0^32, "fairwins-passkey-xwing-v1", 32)` → `xwingKeygen(seed)`; component seeds `SHA3-256("xwing-mlkem-1"‖s)`, `SHA3-256("xwing-mlkem-2"‖s)` (concat → 64 B ML-KEM seed), `SHA3-256("xwing-x25519"‖s)` | **YES** | `envelopeEncryption.js:237,261-266,62-80` |
| Passkey → backup key | `keccak256(seed ‖ utf8("FairWins Data Backup v1"))` | **YES** | `frontend/src/lib/backup/backupCrypto.js:35-39` |
| **Bitcoin (spec 061, current)** | `HKDF-SHA256(masterSeed, 0^32, "fairwins-btc-seed-v1", 64)` → `HDKey.fromMasterSeed` → **`m/84'/{coin}'/0'`** (segwit, P2WPKH) or **`m/86'/{coin}'/0'`** (taproot, P2TR); receive = `account/0/i`, `0 ≤ i < 2^31` non-hardened. `coin` = **0** mainnet, **1** testnet4. | **YES — explicitly** | `frontend/src/lib/bitcoin/derivation.js:5-10,42-52,85-86,103,113-116,141-155` |
| Bitcoin (legacy import, spec 062) | `m/44'` P2PKH `1…` · `m/49'` P2SH-wrapped `3…` · `m/84'` P2WPKH `bc1q…` · `m/86'` P2TR `bc1p…`; account node `m/{purpose}'/{coin}'/{account}'` | Discovery only | `frontend/src/lib/bitcoin/legacyDerivation.js:18-21,37,97` |
| **Solana** | SLIP-0010 ed25519, hardened-only (non-hardened ed25519 CKD undefined). Schemes: `bip44Change` = **`m/44'/501'/i'/0'`** (Phantom/Solflare), `bip44` = **`m/44'/501'/i'`** (Ledger Live), `bareSeed` = first 32 B of the BIP-39 seed (solana-keygen). Coin type **501**. | Yes (address-changing) | `frontend/src/lib/solana/derivation.js:4-13,29-32,80-96` |
| **EVM hardware wallets** | `live` = **`m/44'/60'/i'/0/0`**; `bip44` = **`m/44'/60'/0'/0/i`**. Reconnect RE-DERIVES the saved path and must match the saved address, else refuse. | Yes | `frontend/src/lib/hardware/derivations.js:4-13,35`; `connectAccount.js` |
| **BIP-39** | Accepted word counts **12, 15, 18, 21, 24** | — | `frontend/src/lib/recovery/legacyKeys.js:39` |
| **Claim codes** | 4 words from the BIP-39 English list (2048^4 = **2^44**), uniform rejection sampling over 16-bit reads; `keccak256("FairWins/claim/v1"‖code)` → secp256k1 key; independent `keccak256(TERMS_DOMAIN‖code)` → 32-B AEAD key | R2 | `frontend/src/utils/claimCode/wordlist.js:4,15-16,97-107`; `deriveFromCode.js:41-55` |
| **ERC-4337 account address** | `LibClone.predictDeterministicAddress(initCodeHash(), keccak256(abi.encode(owners, nonce)), factory)` — ERC-1967 proxy. **Lookup, never derivation** on the sign-in path (spec 104); derivation survives only for `mode:'sign-up'` or an explicitly `acceptCounterfactual`'d address. | — | `contracts/account/CoinbaseSmartWalletFactory.sol:50-61,77-78,95-96`; `frontend/src/lib/passkey/accountLookup.js` |
| **Safe vault address** | `initializer` = chain-independent spec-043 encoding (owners + threshold + canonical fallback handler, **no policy setup**); `salt = keccak256(keccak256(initializer) ‖ saltNonce)`; `CREATE2(proxyFactory, salt, keccak256(deploymentData))`. `saltNonce` from `Date.now()` (R8). Policy rules installed **post-deploy** so the initializer stays byte-identical across chains. | — | `frontend/src/lib/custody/vaultDeployment.js:2-3,61-94`; `safeVault.js:80-87`; `CreateVaultFlow.jsx:31` |
| **Tenant-prefixed CREATE2 salts** | `ethers.id("tenant:<TENANT_ID>:<identifier>")`; default tenant unprefixed (IS the shared estate). `TENANT_ID` must match `^[a-z][a-z0-9-]{1,30}$` and **must never change once a tenant has deployed**. | Yes (address-changing) | `scripts/deploy/lib/helpers.js:47-53,67-76` |
| Safe singleton factory | `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7` (`@safe-global/safe-singleton-factory`) | — | `scripts/deploy/lib/constants.js:18`; `helpers.js:9` |

**WebAuthn credential creation parameters** (`frontend/src/lib/passkey/credentials.js:337-372`):
- `challenge`: `crypto.getRandomValues(new Uint8Array(32))` (line 337)
- `pubKeyCredParams`: `[{ type:'public-key', alg: -7 }]` — **ES256/P-256 only** (line 349)
- `authenticatorSelection`: `residentKey: 'required'`, `userVerification: 'required'` (lines 350-352)
- `extensions`: `{ prf: { eval: { first: new Uint8Array(32) } } }` (line 354)
- Public key extracted from SPKI DER: `x = point[1:33]`, `y = point[33:65]` (lines 363-369)
- `prfCapable` = `ext.prf?.enabled ?? ext.prf?.results` (line 372)
- **`attestation` is not requested** — no attestation statement is collected or verified (R14)
- Assertion: `userVerification: 'required'` (lines 431-433)
- Native bridge pre-encodes PRF salts to WebAuthn-JSON base64url and decodes `prf.results.first/second` back to ArrayBuffers, because the Capacitor plugin JSON-clones extensions (`frontend/src/lib/native/nativeCredentials.js:16-22,63-71`)

---

## 6. Key material inventory

| Key / secret | Algorithm | Generated where | Stored where | Who can use it | Rotation / revocation | Blast radius if compromised | Evidence |
|---|---|---|---|---|---|---|---|
| **Deployer / admin EOA** (`PRIVATE_KEY`) | secp256k1 | Operator (floppy flow preferred) | GCP Secret Manager `fairwins-deployer-key`; delivered by `npm run sec -- --profile deploy`; **never** written to `.env` | Workstation operator via impersonation (no SA key files) | Manual key rotation + on-chain role handoff. `DEFAULT_ADMIN_ROLE` on `bridgeRouter`/`liquidityRouter` **still held by a single hot deployer EOA** (issue #966, per CLAUDE.md) | Upgrade authority over UUPS proxies; repoint router fund-path addresses; **catastrophic** | `scripts/secrets/registry.js:75-79`; `infra/terraform/environments/prod/terraform.tfvars` |
| **Floppy keystore passwords** (`FLOPPY_KEYSTORE_PASSWORD`, `FLOPPY_MORDOR_PASSWORD`, `FLOPPY_NAZGUL_PRIME_PASSWORD`) | password (scrypt input) | Operator | Secret Manager, class `PASSWORD`; **never falls back to `process.env` on a public network** | `deploy` profile | Manual | Decrypts the offline admin mnemonic/key if the media is also obtained | `scripts/secrets/registry.js:103-125`; CLAUDE.md spec-097 rule (3) |
| **Floppy mnemonic** (BIP-39) | BIP-39 → BIP-32 | Operator, air-gapped | Encrypted JSON on removable floppy (`scrypt 2^18` + AES-128-CTR + keccak MAC), mounted `noexec,nosuid,nodev,umask=077,sync` | Whoever holds media + password | Physical | Root of the entire admin key hierarchy | `scripts/operations/floppy-key/keystore.js:33-83`; `config.js:15-30` |
| **Creator / seed-player keys** (`CREATOR_PRIVATE_KEY`, `SEED_PLAYER_KEYS`) | secp256k1 | Operator | Secret Manager, `seed` profile | Test seeding only | Manual | Testnet funds + seeded fixtures | `scripts/secrets/registry.js:83-95` |
| **Per-chain alto executor EOA** (`ALTO_EXECUTOR_PRIVATE_KEYS`) | secp256k1 | Operator | Secret Manager `alto-executor-key-137`, injected into the VM alto container | One alto instance per (chain, EOA) — **G-11 invariant; two altos on one EOA = nonce war, both healthy-looking, no in-band detection** | Manual; **one executor key per chain, never shared** | Attacker submits bundles / drains the executor's gas; UserOps stop landing | `services/alto-bundler/deploy/service.yaml:42,127-132`; `infra/terraform/environments/prod/terraform.tfvars:67` |
| `ALTO_UTILITY_PRIVATE_KEY` | secp256k1 | Operator | Secret Manager → alto env | alto | Manual | Bundler utility ops | `services/alto-bundler/deploy/service.yaml:42,132` |
| **Relayer gas keys** (`gas-key-polygon`, `gas-key-mordor`) | **Google Cloud KMS `EC_SIGN_SECP256K1_SHA256`, `ASYMMETRIC_SIGN`** | Cloud KMS (never exported) | KMS key ring, `prevent_destroy`; key VERSIONS are never Terraform-managed (unrecoverable) | OZ Relayer SA with **`cloudkms.signerVerifier` on those keys only** | Revoke the IAM binding / disable the key version. Key material cannot be exfiltrated. | Attacker spends relayer gas; **cannot steal member funds** (the gateway can censor, never steal) | `services/oz-relayer/README.md:43-54`; `services/oz-relayer/config/config.json:50-77`; `infra/terraform/environments/prod/main.tf:229-255`; `variables.tf:71-74` |
| **Paymaster sponsorship signer** (`verifyingSigner`) | KMS secp256k1 (prod) / raw key (dev/CI only) | Cloud KMS | KMS; `FairWinsVerifyingPaymaster.verifyingSigner` on-chain | relay-gateway `POST /v1/paymaster` | **On-chain rotation:** `setVerifyingSigner(newSigner)` emits `VerifyingSignerChanged`; owner-only | Attacker mints sponsorship signatures → **drains the paymaster's EntryPoint deposit**. Bounded: validation is signature-only/zero-storage and **only `owner` (floppy keystore) can withdraw funds** | `services/relay-gateway/src/paymaster/sign.js:2-10,35-58`; `contracts/account/FairWinsVerifyingPaymaster.sol:25-27,37-38,51-69,115-117` |
| `fairwins-rpc-access-signing-key` | NOT DETERMINED (key purpose not stated in the files read) | — | Secret Manager | — | — | — | `infra/terraform/environments/prod/terraform.tfvars:61,164` |
| **Member passkey (P-256)** | ES256 / secp256r1 | **Device authenticator** (platform passkey) | **Device secure enclave / OS keystore**; syncable via the platform's own passkey sync. FairWins holds only `{x, y}` + credentialId | The member, gated on `userVerification: 'required'` | Add/remove controller via `MultiOwnable` (`AddOwner`/`RemoveOwner`); `residentKey: 'required'` | Full control of the member's ERC-4337 account | `frontend/src/lib/passkey/credentials.js:344-381`; `contracts/account/MultiOwnable.sol` |
| **Passkey master seed (32 B)** | HKDF-derived; wrapped AES-GCM-256 | Derived from the PRF output; memory-only in the clear | Wrapped blob in local blob store + spec-032 synced backup | Any PRF-capable credential holding a blob for the account | Per-credential blobs — one credential can be de-provisioned without touching others | **All envelope keys, the Bitcoin tree, the backup key** — the single root of member-side encryption | `frontend/src/lib/passkey/prfKeys.js:5-7,92-98,118-171` |
| **Member legacy imported keys / mnemonics** | secp256k1 / BIP-39 | The member's old wallet (imported) | `userStorage.legacy_recovered_keys`, **AES-GCM-256 ciphertext only**; rides spec-032 backup | The member, after passphrase or passkey-PRF unwrap | Delete the entry; sweep funds out (optional — `sweepAllAssets`, per-asset outcomes) | Full control of the member's old EOA | `frontend/src/lib/recovery/legacyKeys.js:12-20,146-190` |
| **Bitcoin keys** | secp256k1 (BIP-84 ECDSA / BIP-86 Schnorr key-path) | Derived client-side from the passkey master seed | **NOWHERE** — memory-only for the duration of one signing op; xprv and **xpub** never persisted or sent | The member's client only; the gateway sees bare addresses + signed raw txs | Implied by master-seed rotation (which is itself wallet-breaking) | The member's BTC | `frontend/src/lib/bitcoin/derivation.js:90-95,118-133`; `gatewayClient.js` |
| **Solana keys** | ed25519 (SLIP-0010) | Derived from a recovered BIP-39 seed | Not persisted separately | The member's client | — | The member's SOL | `frontend/src/lib/solana/derivation.js:80-107` |
| **Member RPC credentials** | bearer token / custom header | The member's provider | `fw_global_prefs.network_endpoints`, **device-scoped**, **deliberately absent from `syncedObjects.js`** | The member's device | Member deletes/replaces. Ride in a **request HEADER, never in a URL**; redacted at every display/log boundary via `redactRpcUrl`; attach to the PRIMARY endpoint only | Read-only RPC quota abuse | CLAUDE.md spec-069 rules; `frontend/src/lib/network/endpointStore.js` |
| **GutterToken assistant key (`sk-…`)** | vendor API key | The member, at `app.guttertokens.com` | `userStorage.assistant_guttertoken_key_v1`, wallet-scoped, **device-only**, **deliberately absent from `syncedObjects.js`** (test-asserted) | The member's browser **only** — the browser calls `api.guttertokens.com` directly; **FairWins never holds, forwards, or sees it** | Member re-enters on `401 key_invalid`; revoke at the vendor | The member's GutterToken credit balance | `frontend/src/lib/assistant/guttertokenKeyStore.js:24,36-43,88-95,148-176` |
| **Member API `fw1` capability token** | **member-signed EIP-712 `ApiKeyGrant`** — the gateway **stores nothing to issue one** | The member's own wallet, in-app | Wire format `fw1.<b64url(grantJSON)>.<b64url(sig)>` in `Authorization: Bearer`; held by the member's agent/MCP client | Bearer holder, scoped to reads / typed-data BUILDS / assistant — **never relay, never custody**; the actor of every built intent is forced to the token account | Revocation is **in-process only** (`durable: false` on every answer, surfaced to the member); **expiry is the binding limit**, TTL-capped at `MEMBER_API_MAX_TTL_DAYS`. `ApiKeyRevocation` is self-authorizing (no bearer token needed). | Read access to the member's data + ability to have typed data built for them (still requires their signature to move value) | `packages/intent-types/src/offchain.js:28-38,88-105`; `services/relay-gateway/src/memberApi/auth.js:7-9,74-147,257-293` |
| **Polymarket CLOB L2 creds** (`POLY_API_KEY`, secret, passphrase, address) | HMAC-SHA256; L1 = one-time offline EIP-712 wallet signature | Provisioned offline | Gateway-only secrets; **never reach the browser** | relay-gateway `polymarket/` | Re-provision at Polymarket | Order placement / cancellation on FairWins' builder account; **the member's wallet is the only order signer** | `services/relay-gateway/src/polymarket/client.js:8-12,37-47`; `routes.js:7-9,48` |
| **Polymarket builder code** | `bytes32` (`0x6e03…93a3`) — **public config, not a secret** | — | Tenant/gateway config | — | Config change | Revenue attribution only | CLAUDE.md spec-057 |
| `origin-lock-secret` (`X-Origin-Auth`) | 256-bit random (`openssl rand -hex 32`) | Operator | Secret Manager → Cloud Run env `ORIGIN_LOCK_SECRET`; mirrored in a Cloudflare Transform Rule. Read via a Terraform **data source** — the one accepted `prevent_destroy`-adjacent exception, and it lands in state | nginx enforcement in every served location (`/healthz` exempt) | Rotate Secret Manager + Transform Rule **together** | Direct-to-origin access bypassing the geo gate (spec 007 legal control) | `infra/cloudflare/origin-lock.md:6-49`; `frontend/nginx.conf` (via `nginx.conf.template`) |
| `relay-webhook-secret`, `relay-engine-api-key` | shared secret / API key | Operator | Secret Manager | relay-gateway ↔ engine | Manual | Forge engine callbacks / submit to the engine (still bounded by the gateway's policy layer) | `infra/terraform/environments/prod/terraform.tfvars:27-28,68-69` |
| `anthropic-api-key` | vendor API key | Operator | Secret Manager | Gateway assistant rail (FairWins pays) | Rotate at vendor | Model spend | `terraform.tfvars:36,77` |
| Pinata JWT, Graph deploy key, Graph API key, Etherscan key, QuickNode tokens/URLs | bearer tokens | Vendors | Secret Manager, per-profile (`publish`, `verify`, `rpc`, `deploy`) | Named profiles only | Rotate at vendor | IPFS pinning / subgraph deploy / explorer quota / RPC quota. **QuickNode URLs were moved from public env to secrets** because the token rides in the path | `scripts/secrets/registry.js:127-241` |
| FinOps read tokens (`finops-cloudflare-token`, `finops-quicknode-key`, `finops-grafana-cloud-token`) | bearer tokens | Vendors | Secret Manager | finops-exporter — **read-only by construction** (no signer, no write route), binds loopback only; `fetch-secrets.sh` **refuses to boot if key material reaches its env** | Rotate at vendor | Billing-data read | `terraform.tfvars:31-33,72-74`; CLAUDE.md spec-097 |
| **Android upload keystore** | JKS (algorithm inside: NOT DETERMINED) | Operator | Secret Manager `fairwins-android-upload-keystore` + `…-password`; materialised **only into the ephemeral runner temp** | release.yml, gated on the `ANDROID_SIGNING_SERVICE_ACCOUNT` repo variable; unset ⇒ **unsigned bundle recorded `signed:false`, loudly** | Google Play upload-key reset | Publish a malicious update to the Play listing | `.github/workflows/release.yml:105-134` |
| **iOS signing identity** | Apple code-signing cert | Apple | **Operator-held; never enters CI** (research R8) | Operator, manually | Apple revocation | App Store distribution | `.github/workflows/release.yml:161,177-193` (`CODE_SIGNING_ALLOWED=NO`, unsigned `.xcarchive`) |
| **TLS certificates** | NOT DETERMINED in-repo | **Cloudflare (edge termination)**; origin is Cloud Run / VM nginx behind the origin-lock header. No mTLS to origin (documented as future hardening). | Cloudflare-managed | — | Cloudflare | Edge TLS | `infra/cloudflare/origin-lock.md:1-6,57-63`; `frontend/nginx.conf:101` (`Strict-Transport-Security: max-age=31536000`) |
| Cloudflare API token (infra) | bearer | Cloudflare | Secret Manager (Terraform reads containers + bindings only; **never a `secret_version` resource** — it would write the payload into state) | Terraform apply identity | Rotate at Cloudflare | Both Cloudflare rulesets are **authoritative for their phase** — an apply deletes dashboard-added rules, including the HTTP-451 geo gate | CLAUDE.md spec-087 rules (2),(5) |

---

## 7. Transport & platform crypto

| Control | Detail | Evidence |
|---|---|---|
| **TLS termination** | **Cloudflare at the edge**; origin (Cloud Run / VM nginx) authenticated by the shared `X-Origin-Auth` header, not mTLS. `HSTS max-age=31536000` (no `includeSubDomains`, no `preload`). | `infra/cloudflare/origin-lock.md:1-6`; `frontend/nginx.conf:101` |
| Origin lock | `$http_x_origin_auth` mapped → 403 on mismatch in every served location; `/healthz` exempt for probes; enforcement auto-enables only when the secret is present. **nginx `map` comparison is not constant-time (R9).** | `infra/cloudflare/origin-lock.md:35-49` |
| Probe honesty | Probes assert on **CONTENT**, not status: a plain 200 from the bundler proves nothing (the origin-lock nginx serves its own 200 that never reaches alto — the check that stayed green through the 2026-07-12 stall). | CLAUDE.md spec-097; `infra/observability/README.md` |
| **CSP as code-integrity control** | `default-src 'self'`; `script-src 'self' 'unsafe-inline' blob: https://challenges.cloudflare.com https://*.cloudflareinsights.com` — **`blob:` is for verified mini-app bytes ONLY, and `https:` must never be added to `script-src`**; `connect-src` carries a scheme-wide `https:` + loopback `http://localhost:*` `http://127.0.0.1:*` grant for member-run nodes (spec 069); `frame-src` narrow (Cloudflare Turnstile, WalletConnect verify, `connect.trezor.io`). **No `wasm-unsafe-eval`** — a direct consequence of dropping Semaphore. | `frontend/nginx.conf:43-101` (policy string at :96) |
| CSP parity | `CSP_RPC_GRANTS` (endpointStore.js) and both nginx configs must stay in sync — gated by `src/test/nginxCspConnectSrc.test.js`. The **native** meta CSP is **DERIVED from `nginx.conf`** by `scripts/native/nativeCsp.js` and parity-gated (`script-src` keeps `blob:`, never gains `https:`); the web nginx files stay byte-identical. | `scripts/native/nativeCsp.js:10-16`; CLAUDE.md spec-103 rule (3) |
| **Mini-app byte integrity** | Two-layer: (1) `keccak256(manifest.json raw bytes)` === the chain's `approved.manifestHash`, checked **before parsing**; (2) `sha256(file bytes)` === `manifest.files[path].sha256` for **every file executed or injected** (entry + declared stylesheets). Re-checked after **every** retrieval, cache or network. SW cache `fairwins-miniapp-packages-v1` is cache-first because CIDs are immutable and **is not a trust boundary**. `verifyAllDeclaredFiles` is OFF for a launch (files not used are not fetched), ON for a curator review. | `frontend/src/lib/miniapps/integrity.js:8-9,139-151,180-215`; `loader.js:10-12,246-248,340-371,438` |
| Approval is content-committed | `approveApp(id, expectedManifestHash)` reverts `StaleProposal` — reading the proposed tuple at execution time let a vendor swap the package after review. **Never add an id-only overload.** | CLAUDE.md spec-073 rule (1) |
| Immutable IPFS CIDs | Packages served from IPFS by plain CID (`CID_PATTERN` shape-vetted; `${gateway}/ipfs/${cid}/${encodedPath}` with gateway failover). Zero/absent `manifestHash` ⇒ `no_approved_package`, never a fetch. | `frontend/src/lib/miniapps/loader.js:246-248,319-371` |
| **Bytecode digest gate** | `sha256(bytecode ‖ deployedBytecode)` per compiled contract, recorded and diffed (`--out` / `--compare`). Catches a dependency hoist changing deployed bytecode. **Runs in CI** (`test.yml` job `smart-contract-tests`). **Does NOT cover the solcjs path** — a run using the native binary never exercises it, which is how a `0.8.24→0.8.36` solc bump passed (#1084). | `scripts/codegen/bytecode-digest.js:3-11,99-101`; CLAUDE.md spec-075 rule (2) |
| Mini-app build digest gate | `sha256` of every built package file, recorded; the mini-app bytes are keccak-committed on-chain. Own CI job `miniapp-bytes`. Previously reported "output bytes unchanged" after a *failed* build. | `scripts/miniapps/record-build-digests.js:8,43` |
| **Storage-layout gate** | Offline comparison of compiled layout (hardhat build info) vs each live implementation's committed layout (`.openzeppelin/` manifests). Gating in CI. UUPS storage must be append-only with a trailing `__gap`; OZ bases use **ERC-7201** namespaced storage and contribute none. | `scripts/deploy/check-storage-layout.js:2-37`; `contracts/upgradeable/UUPSManaged.sol:45` |
| Guard non-upgradeability | `SafePolicyGuard` / `SafePolicyGuardV2` are **deliberately NOT upgradeable** — an upgrade key over a policy guard is a backdoor across every vault. Migration is vault-consented via a threshold-approved `setGuard`. | CLAUDE.md spec-068; `contracts/custody/SafePolicyGuardV2.sol` |
| x402 payment verification | Everything verified **before** settlement, so a refused payment is never submitted and costs nothing; an engine outage is `503 settlement_unavailable`, never a free serve. Acceptance is **broadcast, not finality**, stated on every surface. Contract-account payers are EOA-only refusals **whose reason says so** (a 1271 check would pass here and revert at the token). | `services/relay-gateway/src/x402/verify.js:20,63-87,139-273` |
| Sanctions screening inside `submit` | Screening happens **inside** the mini-app host's `wallet.submit`, before any rail is touched — strictly stronger than an app-side pre-check a package could skip. | CLAUDE.md spec-073 rule (3) |
| IAM / IaC crypto hygiene | `google_project_iam_binding`/`_iam_policy` rejected by `npm run check:iac` (authoritative → silently strips roles); **never declare `google_secret_manager_secret_version`** (payload lands in state in plaintext); the one exception (origin-lock header via a *data source*) is warned-on so it stays countable; KMS key versions + secret payloads carry `prevent_destroy`. | CLAUDE.md spec-087 rules (1),(2),(3); `infra/terraform/environments/prod/main.tf:229-255` |
| Private module pinning | The five shared Terraform modules are pinned by **commit SHA**, not tag (a tag can be repointed). | `infra/terraform/environments/prod/main.tf:266` (`?ref=838c250b6dc8542fd0730b12ec7050462387bc53`) |

---

## 8. Library & version pins

Versions are from `package-lock.json` (resolved), declarations from the respective `package.json`. **"Bytecode"** = contributes to deployed EVM bytecode.

### 8.1 Solidity / bytecode-affecting (all EXACT-pinned)

| Package | Declared | Locked | Pin | Bytecode? | Evidence |
|---|---|---|---|---|---|
| `@openzeppelin/contracts` | `5.4.0` | 5.4.0 (+ transitive 4.7.3 under `@arbitrum/nitro-contracts`, `@offchainlabs/upgrade-executor`, dev) | **EXACT** | **YES** | root `package.json`; lock |
| `@openzeppelin/contracts-upgradeable` | `5.4.0` | 5.4.0 (+ 4.7.3, 4.9.6 transitive) | **EXACT** | **YES** | root `package.json` |
| `@safe-global/safe-contracts` | `1.4.1` (with an `ethers: $ethers` override) | 1.4.1 | **EXACT** | **YES** | root `package.json` |
| `@safe-global/safe-singleton-factory` | `^2.0.0` | — | ranged | address-affecting | root `package.json`; `scripts/deploy/lib/helpers.js:9` |
| `@chainlink/contracts` | `1.5.0` | 1.5.0 | **EXACT** | **YES** — a float 1.3.0→1.5.0 changed `ChainlinkFunctionsOracleAdapter` bytecode and only the byte gate caught it | root `package.json` |
| **`solc` (npm)** | `0.8.24` | **0.8.24** at root; **0.8.26** under `node_modules/hardhat/node_modules/solc` | **EXACT** (root), transitive (hardhat's) | **YES on the solcjs path** — `hardhat.config.js` resolves `solc/soljson.js` and compiles with it when `FORCE_SOLCJS=true` or in Codespaces. Dependabot-ignored for ANY update; the byte gate does not cover this path. | root `package.json`; lock; `hardhat.config.js:198-232` |
| solc compiler profiles (hardhat config) | `0.8.24` (`optimizer: {enabled:true, runs:1}`, `viaIR:true`, `evmVersion:"paris"`, `metadata.bytecodeHash:"none"`); `0.8.23` (account bytecode, `viaIR:true`, `evmVersion:"paris"`); a `0.8.24` + `evmVersion:"cancun"` variant; a `viaIR:false` Safe profile | — | in-repo config | **YES** | `hardhat.config.js:321-374,456-506` |
| `@openzeppelin/hardhat-upgrades` | `^3.9.0` | — | ranged | tooling | root `package.json` |
| `@openzeppelin/upgrades-core` | `^1.44.2` | 1.46.0 | ranged | tooling (storage-layout gate) | root `package.json`; lock |

### 8.2 JS crypto primitives (client)

| Package | Declared (frontend) | Locked (top-level) | Pin | Used for | Evidence |
|---|---|---|---|---|---|
| `@noble/curves` | `^2.3.0` | **2.4.0** (+ 1.2.0, 1.4.2, 1.8.0, 1.8.2, 1.9.0, 1.9.1, 1.9.7, 2.3.0 transitively) | ranged | X25519 ECDH, ed25519 (Solana) | `frontend/package.json`; `frontend/src/utils/crypto/primitives.js:12`; `lib/solana/derivation.js:26` |
| `@noble/hashes` | `^2.3.0` | **2.4.0** (+ 1.2.0, 1.3.2, 1.4.0, 1.7.0, 1.7.2, 1.8.0, 2.3.0) | ranged | HKDF, SHA-256, SHA3-256, HMAC | `primitives.js:13-15`; `envelopeEncryption.js:19-21`; `lib/bitcoin/derivation.js:32-33` |
| `@noble/ciphers` | `^1.0.0` | **1.3.0** (+ 2.4.0 under `@noble/post-quantum`) | ranged | ChaCha20-Poly1305, XChaCha20-Poly1305, `randomBytes` (webcrypto) | `primitives.js:16-18`; `envelopeEncryption.js:22-24` |
| **`@noble/post-quantum`** | `^0.7.0` | **0.7.1** | ranged — **pre-1.0** | **ML-KEM-768** inside the hand-rolled X-Wing (R1) | `frontend/package.json`; `envelopeEncryption.js:18` |
| `@scure/bip32` | `2.3.0` | 2.3.0 (+ 1.1.5, 1.4.0, 1.7.0) | **EXACT** | BIP-32 HD derivation (Bitcoin) | `frontend/package.json`; `lib/bitcoin/derivation.js:34` |
| `@scure/bip39` | `2.4.0` | 2.4.0 (+ 1.1.1, 1.3.0, 1.6.0) | **EXACT** | BIP-39 mnemonics | `frontend/package.json` |
| **`@scure/btc-signer`** | `2.4.1` | 2.4.1 | **EXACT** | P2WPKH/P2TR address encoding, **BIP-341 taproot tweak**, PSBT signing | `frontend/package.json`; `lib/bitcoin/addresses.js:27` |
| `@scure/base` | `2.4.0` | 2.4.0 (+ 1.1.9, 1.2.6, 2.3.0) | **EXACT** | bech32/bech32m/base58 encoding | `frontend/package.json` |
| `ethers` | `^6.17.0` (root + frontend + gateway) | **6.17.0**; **5.8.0** under `@chainlink/contracts` (dev) | ranged | keccak256, EIP-712 signing/verification, secp256k1, ERC-1271 calls | `package.json` ×3; lock |
| `viem` | `^2.53.1` | **2.56.0** | ranged | wagmi transport layer, UserOp / `sendCalls` | `frontend/package.json` |
| `wagmi` | `^3.6.21` | **3.7.7** | ranged | Wallet connection | `frontend/package.json` |
| `ox` | not declared (transitive) | **0.9.3**, 0.6.9, 0.14.34 | transitive | viem/AppKit crypto utilities | lock |
| **`tweetnacl`** | `^1.0.3` | **1.0.3** (+ 0.14.5 dev-transitive under `sshpk`, `bcrypt-pbkdf`) | ranged | **UNUSED since R7 closed** — its only consumer was deleted; left declared on purpose (a lockfile re-resolve is the spec-075 rolldown hazard), drop it in a dependencies-only change | `frontend/package.json` |
| `tweetnacl-util` | `^0.15.1` | 0.15.1 | ranged | base64/utf8 for the above | `frontend/package.json` |
| **`elliptic`** | `overrides: "^6.6.1"` (root) | **6.6.1** | force-pinned range | transitive ECDSA (R12) | root `package.json` `overrides`; lock |
| `ethereum-cryptography` | `^3.2.0` (root) | 3.2.0 (+ 0.1.3, 1.2.0, 2.2.1) | ranged | **`scrypt` + `keccak256` for the floppy mnemonic keystore** | root `package.json`; `scripts/operations/floppy-key/keystore.js:6-7` |
| `@noble/secp256k1` | not declared | 1.7.1 (dev-transitive) | transitive | — | lock |
| `micro-eth-signer` | not declared | 0.14.0 | transitive | — | lock |
| `@adraffy/ens-normalize` | not declared | 1.11.1 | transitive | ENS name normalization (identity resolution) | lock |

### 8.3 WebAuthn / passkey / hardware / native

| Package | Declared | Locked | Pin | Notes | Evidence |
|---|---|---|---|---|---|
| **`@capgo/capacitor-passkey`** | `8.5.1` | 8.5.1 | **EXACT** | Native WebAuthn bridge; JSON-clones extensions, so the adapter pre-encodes PRF salts to base64url and decodes results | `frontend/package.json`; `frontend/src/lib/native/nativeCredentials.js:16-22,119` |
| `@simplewebauthn/server` / `browser` | — | **NOT IN LOCK** | absent | **No off-chain WebAuthn verification exists.** Verification is on-chain only (R14) | lock query returned no entry |
| `@capacitor/core` / `app` / `android` / `ios` / `cli` | `8.5.0` / `8.1.1` / `8.5.0` / `8.5.0` / `8.5.0` | same | **EXACT** | Capacitor shells (spec 103); Java 21 + newest Xcode required | `frontend/package.json` |
| `@capacitor-community/bluetooth-le` | `8.3.0` | 8.3.0 | **EXACT** | Ledger-over-BLE transport rung | `frontend/package.json` |
| `@ledgerhq/hw-app-eth` | `^7.8.14` (with `axios: ^1.19.0` override) | **7.8.16** | ranged | Ledger EVM app | `frontend/package.json`; root `overrides` |
| `@ledgerhq/hw-transport` | `^6.35.7` | — | ranged | transport base | `frontend/package.json` |
| `@ledgerhq/hw-transport-web-ble` | `^6.35.0` | 6.35.0 | ranged | BLE | `frontend/package.json` |
| `@ledgerhq/hw-transport-webhid` | `^6.36.0` | 6.36.0 | ranged | WebHID | `frontend/package.json` |
| `@ledgerhq/hw-transport-webusb` | `^6.35.0` | 6.35.0 | ranged | WebUSB | `frontend/package.json` |
| `@trezor/connect-web` | `^9.7.3` | 9.7.3 | ranged | Trezor (`frame-src https://connect.trezor.io`) | `frontend/package.json`; `frontend/nginx.conf:96` |
| **In-repo Solidity WebAuthn** | — | — | vendored | `contracts/account/lib/webauthn-sol/WebAuthn.sol` (Coinbase/Daimo lineage) + `contracts/account/lib/FreshCryptoLib/{FCL_ecdsa,FCL_elliptic}.sol` + `contracts/account/lib/solady/` + `contracts/account/lib/account-abstraction/` | not npm-pinned — **vendored source, version NOT DETERMINED** | `contracts/account/lib/` tree |
| `@google-cloud/kms` | `^6.0.0` (root + gateway) | 6.0.0 | ranged | KMS secp256k1 signing; **dynamically imported** so dev/test needs no KMS package | root + gateway `package.json`; `services/relay-gateway/src/paymaster/sign.js:36` |
| `@polymarket/clob-client` | `^5.8.1` | 5.8.1 | ranged | CLOB order signing (client-side) | `frontend/package.json` |
| `@polymarket/builder-signing-sdk` | `^1.0.0` | 1.0.0 | ranged | Builder-code header signing (gateway-side) | gateway `package.json`; `src/polymarket/routes.js:15` |
| `@solana/kit` | `^8.1.0` | 8.2.0 (+ 2.3.0, 5.5.1) | ranged | Solana RPC / tx | `frontend/package.json` |
| `bitcoinjs-lib` | — | **NOT IN LOCK** | absent | Bitcoin uses `@scure/btc-signer` exclusively | lock query |
| `@noble/ed25519` | — | NOT IN LOCK | absent | ed25519 comes from `@noble/curves` | lock query |

### 8.4 Explicitly absent (verified by grep, not assumed)

| Not present | Consequence |
|---|---|
| Semaphore, MACI, circom, snarkjs | No ZK in live paths; no `wasm-unsafe-eval` needed in CSP (`frontend/nginx.conf:54`) |
| Any MPC / TSS / Shamir library | No threshold key splitting |
| MD5, SHA-1, DES, RC4, AES-ECB | No deprecated primitives found in `contracts/`, `frontend/src`, `services/`, `packages/`, `scripts/` |
| `eth_sign` as a signing method | Appears **only** in the passkey connector's **refusal** set (`frontend/src/connectors/passkey.js:35`) |
| `Math.random()` in any crypto path | One hit, in a demo component (`frontend/src/components/StateManagementDemo.jsx:126`) — not crypto |

---

## 9. Explicitly NOT DETERMINED

| Item | Why |
|---|---|
| Vendored `webauthn-sol` / `FreshCryptoLib` / `solady` / `account-abstraction` upstream versions | Source is vendored under `contracts/account/lib/` with no version manifest read; no npm pin exists |
| `fairwins-rpc-access-signing-key` — algorithm and purpose | Named only in `terraform.tfvars:61,164`; no consuming code found in the files read |
| Android upload keystore's internal key algorithm/size | Only the JKS container and its password are referenced (`release.yml:122-130`) |
| TLS cipher suites / certificate algorithm | Cloudflare-managed; nothing in-repo states them |
| KMS key rotation period | `google_kms_crypto_key` declares `purpose` + `version_template.algorithm` and `prevent_destroy`; **no `rotation_period` is set** in `infra/terraform/environments/prod/main.tf:241-255` |
| Whether any FairWins X-Wing ciphertext has ever been produced by, or must interoperate with, a conformant X-Wing implementation | Only that it *would not* — the label and seed expansion diverge (R1). Whether that matters depends on whether anything outside this repo ever decapsulates, which the repo does not say. R1 is therefore raised as *non-interoperable and unaudited*, not *broken*: encap and decap in this file agree with each other. |
| Whether the X-Wing secret key (a 32-byte seed, `envelopeEncryption.js:62-80`) provides the draft's implicit-rejection / FO-transform properties | The implementation regenerates component keys from the seed on every decapsulation rather than storing the ML-KEM secret key; no reasoning about implicit rejection appears in the file |
