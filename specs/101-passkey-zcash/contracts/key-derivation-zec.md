# Contract: Zcash Key Derivation (spec 101)

Normative. Any change to these constants is a **wallet-breaking change** and
requires a versioned migration path — funds live at the derived addresses.
Extends the spec-041 derivation stack (`frontend/src/lib/passkey/prfKeys.js`,
"derived keys = existing derivation stack fed from masterSeed") exactly the way
spec 061 did for Bitcoin (`contracts/key-derivation-btc.md`).

## Inputs

- `masterSeed`: the 32-byte spec-041 per-account master seed (PRF-recoverable,
  memory-only). Never any other secret.

## Derivation

```
zecSeed   = HKDF-SHA256(ikm = masterSeed,
                        salt = 32 zero bytes,
                        info = "fairwins-zec-seed-v1",
                        length = 64)
root      = BIP32.fromMasterSeed(zecSeed)          // @scure/bip32 (secp256k1)
acct      = root.derive("m/44'/{coin}'/0'")        // BIP44, transparent P2PKH
coin      = 133' for network 'zcash' (mainnet)     // SLIP-44 Zcash
            1'   for network 'zcash-testnet'       // SLIP-44 shared testnet
receive(i)  = acct.derive("0/" + i)                // external chain only
```

- **Address encoding**: `taddr(i)` = Base58Check over the **two-byte** Zcash
  t-addr prefix ‖ `HASH160(compressed pubkey)`:
  - mainnet P2PKH prefix `0x1C 0xB8` → `t1…`
  - testnet P2PKH prefix `0x1D 0x25` → `tm…`
  Checksum = first 4 bytes of double-SHA256 (standard Base58Check;
  `@scure/base` `base58check(sha256)`).
  Destination classification additionally recognizes (pay-to only, never
  derived): mainnet P2SH `0x1C 0xBD` (`t3…`), testnet P2SH `0x1C 0xBA`
  (`t2…`).
- **Change chain (`…/1/i`) is RESERVED but unused in v1**: change returns to
  the next unissued **external** receive address (keeps discovery/monitoring
  to one chain per account, mirroring the Bitcoin contract). If a later
  version adopts the change chain, it must ship with widened discovery.
- **One address type**: P2PKH only. There is no segwit/taproot equivalent on
  Zcash's transparent layer; no type toggle exists on this wallet.

## Signing (consensus-critical)

- Transactions are **Zcash v5** (NU5+): header version `0x80000005`
  (overwintered flag ‖ 5), `nVersionGroupId = 0x26A7270A`, the current
  `nConsensusBranchId`, and an `nExpiryHeight` (tip + 40 blocks).
- The signature digest is the **ZIP-244 transaction digest**: BLAKE2b-256 over
  the ZIP-244 digest tree with its 16-byte domain personalizations (e.g.
  `ZTxIdHeadersHash`, `ZTxIdTranspaHash`; outer personalization
  `"ZcashTxHash_" ‖ CONSENSUS_BRANCH_ID (LE)`), with the per-input transparent
  amounts/scripts digests ZIP-244 §S.2 requires. Transparent-only collapses
  the tree: the Sapling and Orchard bundle digests are the fixed
  empty-bundle constants.
- `nConsensusBranchId` is **fetched from live network state — never
  hardcoded** (spec FR-019). Unknown/unconfirmable branch id ⇒ refuse to
  sign, honestly.
- ECDSA over secp256k1 (`SIGHASH_ALL`), low-S, via the already-shipped
  `@noble/curves` — the same curve stack as Bitcoin.
- **Legacy pre-v5 sighash (ZIP-243/BIP-143 hybrid) is deliberately NOT
  implemented** — v1 signs v5 transactions only.

## Invariants (tested)

1. **Determinism**: same `masterSeed` ⇒ byte-identical addresses on every
   device, forever. Pinned test vectors: a fixed 32-byte test seed and its
   first 3 addresses per network are committed in the test suite; BIP32
   reference vectors validate the underlying lib.
2. **Domain separation**: no other consumer of `masterSeed` may use the info
   string `"fairwins-zec-seed-v1"`; the Zcash tree cannot collide with the
   spec-041 KEK path, the spec-061 Bitcoin tree (`fairwins-btc-seed-v1`), or
   any future consumer. A test asserts the BTC and ZEC trees diverge from the
   same seed.
3. **Memory-only**: `zecSeed`, `root`, account xprvs, and child private keys
   are never persisted, logged, serialized, or transmitted. Zeroize
   references on wallet lock where the runtime allows.
4. **xpub confinement**: the account xpub may be held in memory for address
   derivation but MUST NOT be persisted or sent to any service (the gateway
   receives bare t-addresses only, ≤50 per call).
5. **No wrong keys**: if the master seed is `unavailable`/`uninitialized`
   (non-PRF authenticator, external EVM wallet, no blob), the Zcash wallet
   status is `unavailable` with the honest reason — never a fallback
   derivation from any other material.
6. **Never-decreasing cursor**: the receive rotation index per network only
   increases; recovery sets it to `max(discovered used index, cached) + 1`
   with gap-limit-20 discovery.
7. **Sighash gate**: `zip244` signature digests MUST pass the official
   `zcash/zips` ZIP-244 reference vectors AND a differential cross-check
   against an independent implementation (test-only oracle) in CI before any
   mainnet signing path is reachable. This gate is CI-blocking, not advisory.
8. **Distinctness from 063**: this is the passkey-native wallet
   (masterSeed-rooted). Spec 063's US4 derives from a *recovered BIP-39
   seed* over the same path family (`m/44'/133'/a'/0/i`) — different root
   material, shared path/encoding/signing library. Nothing here constrains
   063's account-index scanning.

## Availability matrix (drives FR-004/FR-021 capability disclosure)

Identical to Bitcoin's (spec 061) — the wallet exists exactly where the master
seed does:

| Account situation | Zcash wallet |
|---|---|
| Passkey + PRF authenticator, seed blob present | `ready` after one PRF ceremony |
| Passkey + PRF, fresh account (no blob) | `ready` after `initMasterSeed` ceremony |
| Passkey, non-PRF authenticator | `unavailable` — honest PRF reason, everything else unaffected |
| Injected / WalletConnect EVM wallet | `unavailable` — Zcash requires a FairWins passkey account |
