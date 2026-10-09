# Contract: Gateway ↔ Submission Engine (OpenZeppelin Relayer)

The gateway delegates transaction mechanics to the OSS engine over its REST API and consumes its status webhooks. The engine sees only a **built transaction**, never a FairWins intent or the recovered signer — all policy stays in the gateway (research §1).

## Gateway → Engine: submit a transaction

`POST {ENGINE_URL}/api/v1/relayers/{relayerId}/transactions` (one `relayerId` per `(chainId, gasWallet)`).

**Body:** `{ "to": <targetContract>, "value": "0", "data": <encoded call>, "speed"?: "fast" }`
- `data` is the ABI-encoded call the gateway built: for `payment` intents, the token/contract `receiveWithAuthorization`-carrying call; for `signer-attributed` intents, the contract's signer-attributed entrypoint call embedding `(signer, params, sig)`.
- The engine allocates the nonce on the lane, prices gas per the network's `features` (**EIP-1559 for 137** — `maxFeePerGas`/`maxPriorityFeePerGas`; **legacy type-0 for ETC/Mordor** — no `maxFeePerGas`), broadcasts, tracks to inclusion, and bumps/replaces a stuck tx up to `gas_price_cap` (FR-005/FR-006, SC-013). Pricing is selected ONLY by the network's `features` containing `"eip1559"` (`EvmNetwork::is_legacy`); a `tags` entry or `policies.eip1559_pricing: true` alone does nothing (issue #1651 — Polygon ran legacy until `features` was fixed).

**Response:** `{ "id": <engineTxId>, "hash": <txHash>, "status": "pending" }`.

## Engine → Gateway: status webhook

`POST {GATEWAY_URL}/v1/engine/webhook` (signed/shared-secret authenticated).

**Body:** `{ "id", "hash", "status": "pending"|"mined"|"confirmed"|"failed"|"cancelled", "receipt"? }`. The gateway maps this to the Intent Status, updates the audit record with the final `txHash`, and resolves the client's status poll. `confirmed` is only surfaced to the client on `mined`/`confirmed` (never on submit).

## Engine configuration (per chain) — `services/oz-relayer/config/`

| Setting | Value | Requirement |
|---------|-------|-------------|
| `network` | 137 / 80002 / 61 / 63 | one relayer per chain |
| `features` | `["eip1559"]` for 137/80002; **omitted** (`[]`) for 61/63 | legacy type-0 gas on ETC/Mordor (research §2). Must be in the network entry's `features`, not only `tags` |
| `rpc_urls` | ≥2 weighted endpoints; `batchMaxCount:1` on 61/63 | failover (FR-007, SC-003) |
| `signer` | Secret Manager / KMS ref | hot key never in env/logs (FR-019a) |
| `gas_price_cap` | per chain | bounds bump/replace (FR-006). Under EIP-1559 it clamps BOTH `maxFeePerGas` and `maxPriorityFeePerGas` (a ceiling, not the spend). On Polygon the engine's own first `maxFee` is ~10× the base fee (`m = min(1.125^(90 s ÷ blocktime), 10)`), so the cap is sized from that, not from `eth_gasPrice`: 10,500 gwei on 137, derivation in `docs/runbooks/relayer-operations.md` § Cap headroom |
| `contract whitelist` (optional) | version-pinned target set | defense-in-depth (FR-025) |

## Failure semantics

- Engine unreachable / all RPCs down → gateway returns `503 chain_unavailable`; client falls back to self-submit (never accept-and-drop).
- Engine only submits what the gateway sends and can censor but never alter/steal (FR-003) — it holds the gas key but no user funds or authority.
- Fallback engine **rrelayer (MIT)** exposes an equivalent submit+webhook surface; the gateway's engine client is written to a thin adapter interface so the engine is swappable without touching policy.
