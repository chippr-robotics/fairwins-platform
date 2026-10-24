# Contract: Solana Key Derivation (spec 100)

Normative. Any change to these constants is a **wallet-breaking change** and
requires a versioned migration path — funds live at the derived address.
Extends the spec-041 derivation stack (`frontend/src/lib/passkey/prfKeys.js` —
"derived keys = existing derivation stack fed from masterSeed") the same way
spec 061 did for Bitcoin (`fairwins-btc-seed-v1`).

## Inputs

- `masterSeed`: the 32-byte spec-041 per-account master seed (PRF-recoverable,
  memory-only). Never any other secret. A spec-063 recovered BIP-39 seed is
  NEVER an input to this contract — recovery-imported accounts keep their own
  derivation (`lib/solana/derivation.js` fed from the imported seed).

## Derivation

```
solSeed  = HKDF-SHA256(ikm = masterSeed,
                       salt = 32 zero bytes,
                       info = "fairwins-sol-seed-v1",
                       length = 64)
node     = SLIP-0010 ed25519 from solSeed        // HMAC-SHA512("ed25519 seed", solSeed)
path     = m/44'/501'/0'/0'                      // every segment HARDENED
priv     = node(path).key                        // 32-byte ed25519 private key
pubkey   = ed25519.getPublicKey(priv)
address  = base58(pubkey)                        // raw 32-byte pubkey, Bitcoin alphabet, NO checksum
```

- SLIP-0010 ed25519 supports **only hardened children** (non-hardened ed25519
  CKD is mathematically undefined) — all four path segments are hardened, which
  is why the path is written `m/44'/501'/0'/0'`. This is the same scheme
  (`bip44Change`) spec 063 identified as the Phantom/Solflare default.
- The SLIP-0010 walker is the **existing, vector-tested** implementation in
  `frontend/src/lib/solana/derivation.js` (hand-rolled on `@noble/hashes`
  HMAC-SHA512 + `@noble/curves` ed25519 — deliberately NOT `@scure/bip32`,
  which is secp256k1 and derives the wrong keys). Spec 100 feeds it `solSeed`
  instead of a BIP-39 seed; it does not reimplement it.
- The address is **not network-scoped**: the same keypair addresses both
  `'solana'` (mainnet-beta) and `'solana-devnet'`. Cluster separation is a
  read/send-scoping rule (spec FR-008/FR-019), not a derivation property.
- Account index `0'` only in v1. Higher account indices
  (`m/44'/501'/{i}'/0'`) are RESERVED for a future multi-account version and
  MUST NOT be derived or displayed in v1.

## Invariants (tested)

1. **Determinism**: same `masterSeed` ⇒ byte-identical address on every device,
   forever. Pinned test vectors: a fixed 32-byte test seed and its derived
   address are committed in the test suite
   (`frontend/src/lib/solana/__tests__/passkeyDerivation.test.js`); the
   SLIP-0010 ed25519 reference vectors and the spec-063 "abandon ×11 about"
   vector validate the underlying walker.
2. **Domain separation**: no other consumer of `masterSeed` may use the info
   string `"fairwins-sol-seed-v1"`; the Solana tree cannot collide with the
   spec-041 KEK path, the spec-061 Bitcoin tree (`fairwins-btc-seed-v1`), or
   future consumers. A test derives both trees from one seed and asserts
   distinct intermediate keys.
3. **Memory-only**: `solSeed`, the SLIP-0010 nodes, and the private key are
   never persisted, logged, serialized, or transmitted. Zeroize references on
   wallet lock where the runtime allows. Only `address` (and signed
   transactions) may leave the client.
4. **No wrong keys**: if the master seed is `unavailable`/`uninitialized`
   (non-PRF authenticator, external EVM wallet, no blob), the passkey-native
   Solana account status is `unavailable` with the honest reason — never a
   fallback derivation from any other material, and never from a spec-063
   recovered seed.
5. **Recovery-import separation**: the passkey-native key never signs for a
   recovery-imported address and vice versa; the two derivations share the
   SLIP-0010 walker code but never share input seed material.

## Availability matrix (drives FR-017 capability disclosure)

| Account situation | Passkey-native Solana account |
|---|---|
| Passkey + PRF authenticator, seed blob present | `ready` after one PRF ceremony |
| Passkey + PRF, fresh account (no blob) | `ready` after `initMasterSeed` ceremony |
| Passkey, non-PRF authenticator | `unavailable` — honest reason; spec-063 recovery unaffected |
| Injected / WalletConnect EVM wallet | `unavailable` — requires a FairWins passkey account |
