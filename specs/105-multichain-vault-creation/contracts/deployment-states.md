# Contract — per-network deployment state machine (UI contract)

States (vault × chainId): `not-selected | queued | awaiting-signature | deploying | confirming |
live | already-live | failed{stage, reason}`. Rules sub-state: `none | installing | active |
awaiting-approval | install-failed | unreadable`.

Rules:
1. Transitions are driven ONLY by: member selection, a probe result, a wallet/rail event, a sent
   tx, a receipt, or a read — never by a timer pretending progress.
2. `already-live` requires a positive `getCode` ≠ '0x' at the predicted address; it is success, not failure.
3. `failed` always carries the stage (`switch | deploy | rules-setRules | rules-setGuard`) and a
   member-facing reason naming the network; retry re-enters that stage only.
4. Before `awaiting-signature`, the write rail is resolved (`resolveWriteRail`) — an unavailable
   rail renders the reason and the way out on the row; nothing is attempted.
5. One network in flight at a time (one wallet, one active chain). Order = member's selection order.
6. On mount/reopen, every state is re-derived: probe ⇒ live/not; hub + `readPolicyV2` ⇒ rules
   sub-state; anything unreadable renders `unreadable` with retry — never a fabricated status.
7. Passkey rail batches deploy + rules install in one `sendCalls` where the creator alone meets
   threshold; signer rail sends sequential txs with per-tx status.
8. The same machine and UI serve creation (NetworksSheet) and deploy-later (Details row → sheet).
