# Runbook: Multichain Vault Creation — Staged Validation (spec 105, issue #1453)

The on-chain E2E tier runs ONE private chain per leg, so "the same address lands on two real
networks, with the wallet switching between them mid-orchestration" is structurally untestable in
CI. Following the spec-103 precedent, that gap is covered by this staged MANUAL protocol — never by
fake CI coverage. Run it before enabling multichain creation for members on a new cohort, and again
after any change to `useVaultDeployment`, `vaultDeployment.js`, or the wallet switch/settle seams.

## What CI already proves (do not re-prove by hand)

- **CREATE2 identity across chainIds** — the pure plan refuses divergent canonical sets and
  predicts one address (`frontend/src/test/custody/vaultDeployment.test.js`).
- **Per-network state machine** — failure isolation, refused-switch reasons, retry re-entering one
  network, reopen re-derivation (`frontend/src/test/custody/useVaultDeployment.test.jsx`).
- **Single-network end to end** — deployed address IS the predicted address, from a real receipt
  (`cypress/e2e/full/29-protect-custody.cy.js` CV-01).
- **Rules realization governs money** — direct + queued installs, banded-lane allow, big-send
  refusal and completion (`cypress/e2e/full/44-vault-rules-lanes.cy.js` RL-01/RL-02).

What only this protocol proves: real wallet switch prompts mid-orchestration, two real networks
answering for one address, and truthful status rows while the member does unhelpful things.

## Why this runs on a MAINNET build

The custody estate has exactly ONE testnet-cohort network (Mordor 63) — the testnet cohort cannot
host a two-network run at all. Use a mainnet build with **dust amounts** on two cheap networks:
**Optimism (10) + Base (8453)** for the core protocol, and **Ethereum Classic (61)** for the
signer-rail variant (ETC has no bundler, so it also exercises the "signer first" rail rule).

## Prerequisites

- Staging URL of the mainnet build under test.
- An injected wallet (e.g. MetaMask) holding **dust only**: ~$2 of native gas on Optimism and
  Base (and ETC if running the variant). **Test accounts only — never an admin or funded key.**
- A second owner address you control (a second account in the same wallet is fine).
- DevTools console open throughout; copy any raised error alongside the member-facing sentence
  into the results comment.

Record results as a checklist comment on issue #1491 (protocol letter → pass/fail + notes). #1453 asked for this protocol and closed when it shipped; #1491 tracks RUNNING it.

## Protocol A — one flow, two networks, one address

1. Protect ▸ Vault actions ▸ Create. Pick **Joint account**, your two addresses, a label.
2. Rules sheet: keep the defaults (cap + wait). Continue.
3. Networks sheet: select **Optimism AND Base**. Expected: both chips selectable regardless of
   which chain the wallet is currently on — the connected chain gates nothing here.
4. Tap Deploy. Expected, in order:
   - The **predicted address renders before any signature** (FR-007), labelled as the same on
     every network.
   - The wallet prompts to switch to the first network **only when its deployment starts**, never
     up front. Approve, sign; the row reaches **Live** from the receipt (not a timer) and then
     shows the rules state (Joint ⇒ direct install: two more signatures, then plain Live).
   - The second network's row stays honestly Queued until its turn, then prompts its own switch.
5. When both rows are Live: the deployed address on BOTH explorers is byte-identical to the
   predicted one. Record the address.
6. Open Details. Expected: ONE card; two network rows each with its pill and Live state; shared
   facts (arrangement, rules) stated once; "Same address on every network."; the remaining
   cohort networks (61/63/137/42161) listed as Not deployed **with a Deploy control** (the
   creation record exists on this device).

## Protocol B — leave mid-flow, reopen, truth re-derived

1. Repeat A steps 1–4, but **close the sheet after the FIRST network reaches Live** (before the
   second starts or while it is Confirming).
2. Expected on close: no warning about lost funds — the flow states networks already live stay
   live.
3. Reopen Protect → the vault card exists. Open Details. Expected: the first network row Live
   (re-derived from the chain, not from session memory), the second listed as **Not deployed
   with a Deploy control** — not stuck "Deploying", not an error.
4. Tap Deploy for the second network and complete it. Expected: same predicted address, row
   reaches Live, and the arrangement on the new network matches the ORIGINAL record (FR-017 —
   if you changed owners in between, the disclosure names the original arrangement first).

## Protocol C — a refused switch isolates one network

1. Repeat A steps 1–4, but when the wallet prompts to switch to the SECOND network, **reject the
   prompt**.
2. Expected: that row alone goes **Failed**, with a reason naming both chains ("stayed on X
   instead of switching to Y… nothing was signed there"); the first network's Live row is
   untouched; nothing retries silently.
3. Tap Retry on the failed row and approve the switch. Expected: it re-enters only that network
   and reaches Live at the same address.

## Protocol D — already-live is success (FR-019)

1. From a SECOND browser profile restored from the same backup (so the creation record synced),
   or after clearing local vault references while keeping the record: open Details and tap
   Deploy for a network the vault is **already on** (arranged via Protocol B/C leftovers, or by
   letting your co-owner deploy first).
2. Expected: the row reports **Already live** without requesting any signature — the probe found
   the address occupied and treated it as success, never "address in use" as an error.

## Protocol E — Controlled vault: queued installs per network

1. Run A with **Controlled** (2-of-2) instead of Joint, both networks.
2. Expected per network: vault Live, rules **"awaiting approval"** (never shown active); each
   network's Queue holds its own two proposals (setRules, setGuard) tagged with its pill.
3. As the second owner, approve + execute both on ONE network only. Expected: that network's
   rules become active; the other network still says awaiting approval — per-network truth, no
   cross-network merging.

## Sweep

Vault dust back out (or keep the vaults as future test fixtures — note their addresses in the
issue), and remove the test vault references from the staging profile.

## Assessment: a second local chain in CI (the candidate follow-up)

Teaching one full-tier leg to boot **two hardhat nodes** with distinct chainIds (a second
impersonation beside 80002) is feasible but not cheap, and it buys less than it appears to:

- **What it would take**: a second node + deploy/seed pass per leg (~2–3 min added), a second
  E2E-only entry in `SAFE_CONTRACTS`/`NETWORK_CONTRACTS` behind the same DEV seam, custody
  fixtures placed on both nodes, and the mock wallet's `switchNetwork` re-pointing its provider
  between two RPC URLs.
- **What it would prove**: the orchestration loop crossing two live RPCs in one run — real
  receipts on both, one address on both.
- **What it still would NOT prove**: the thing this runbook exists for. The mock wallet switches
  chains instantly and never refuses; a real wallet PROMPTS, and the prompt (approve / reject /
  ignore) is exactly where Protocols A/C live. The settle loop, refusal reasons, and isolation
  are already Vitest-proven against a scripted wallet with the same fidelity the mock would give
  Cypress.

Verdict: worth doing only if a regression ever slips through that the two-node leg would have
caught (none has); the manual protocol stays the coverage of record for the wallet-switch UX.
Tracked in #1453 — reopen the assessment there if the mock wallet gains prompt semantics.
