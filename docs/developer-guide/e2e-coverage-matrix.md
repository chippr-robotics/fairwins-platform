<!-- GENERATED FILE — do not edit by hand.
     Source: frontend/cypress/coverage/matrix.json
     Regenerate: npm run e2e:matrix -->

# End-to-End Coverage Matrix

Every directory under `specs/` appears here exactly once — including the ones with no member
surface, which carry a reason instead of flows. That is what makes the staleness gate a set
comparison rather than a judgement about which features "should" have been listed.

**Status** is what exists. **Depth** is what the tests prove, and it is a separate fact: a flow
can be `covered` at depth `smoke`, and several are. That combination is the finding, not a
contradiction — a test that passes when its precondition is absent reports as coverage while
proving nothing.

| Value | Status means | Depth means |
|---|---|---|
| 1 | 🟢 `covered` — tests prove the outcome | `settled` — read back from the authority that decides it (chain state, a balance) |
| 2 | 🟡 `partial` — a named part is unproven | `flow` — the journey completed and the interface agreed |
| 3 | 🔴 `absent` — nothing drives it | `smoke` — a surface rendered, a control existed |
| 4 | ⚪ `out-of-scope` — deliberately untested, with a reason | `none` — no test, or only assertions that cannot fail |

See [the tiering policy](./e2e-testing-policy.md) for what belongs in which tier.

## Totals

| Metric | Count |
|---|---|
| Spec directories | 114 |
| With a member-facing flow | 90 |
| Member-facing flows | 210 |
| 🟢 covered | 188 |
| 🟡 partial | 5 |
| 🔴 absent | 8 |
| ⚪ out of scope | 9 |
| **Covered but not proven** (status `covered`, depth below `flow`) | **13** |

The last row is the honest read of the suite: those flows have passing tests that do not
establish the outcome. They are listed in full at the end of this document.

## Custody — member funds are escrowed, moved, bridged, swept or sent

86 flows — 🟢 69 · 🟡 5 · 🔴 4 · ⚪ 8 · covered-but-not-proven 0

### `001-cypress-e2e-flows` — Core wager lifecycle (create → accept → resolve → claim/refund)

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.claim-payout` | The winner claims the escrowed stakes | 🟢 covered | settled | `on-chain` | `10-claim-payouts.cy.js` (CLM-01, CLM-02, CLM-03, CLM-04, CLM-05, CLM-06, CLM-07, CLM-08, CLM-09, CLM-10) |  |
| `wagers.refund-on-timeout` | An unaccepted or unresolved wager refunds after its deadline | 🟢 covered | settled | `on-chain` | `11-refund-timeout.cy.js` (REF-01, REF-02) |  |
| `wagers.decline-and-cancel` | Decline an offer, or cancel one you created before it is accepted | 🟢 covered | settled | `on-chain` | `06-decline-cancel.cy.js` (DEC-01, DEC-02, DEC-03, DEC-04, DEC-05, DEC-06) |  |
| `wagers.full-lifecycle` | One wager driven end to end, create through settlement | 🟢 covered | settled | `on-chain` | `23-lifecycle-e2e.cy.js` (E2E-01, E2E-02, E2E-03, E2E-04, E2E-05) |  |

### `003-polymarket-only-oracle-ui` — Polymarket-only oracle UI

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `oracle.auto-resolve-from-condition` | A resolved Polymarket condition settles the wager without either party acting | 🟢 covered | settled | `on-chain` | `08-oracle-resolution.cy.js` (ORC-01, ORC-02, ORC-03) |  |

### `004-draw-resolution` — Draw resolution

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.declare-draw` | An arbitrator declares a draw and both stakes are returned | 🟢 covered | settled | `on-chain` | `07-manual-resolution.cy.js` (RES-15, RES-16) |  |

### `022-membership-purchase-progress` — Membership purchase progress

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `membership.purchase-progress` | Watch a membership purchase progress through its steps | 🟢 covered | flow | `on-chain` | `02-membership.cy.js` (MEM-04, MEM-05, MEM-06) |  |

### `024-open-challenge-wagers` — Open challenge wagers

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.create-open-challenge` | Post a wager anyone may accept | 🟢 covered | settled | `on-chain` | `04-wager-creation-tx.cy.js` (CRE-09, CRE-10) |  |
| `wagers.accept-open-challenge` | Accept someone else's open challenge | 🟢 covered | settled | `on-chain` | `05-wager-acceptance.cy.js` (ACC-14, ACC-15) |  |

### `026-membership-vouchers` — Membership vouchers

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `membership.redeem-voucher` | Redeem a voucher for membership without paying | 🟢 covered | settled | `on-chain` | `33-transfers-swap-vouchers.cy.js` (VC-01) |  |
| `membership.buy-voucher` | Buy a voucher at the tier price, paid in USDC | 🟢 covered | settled | `on-chain` | `33-transfers-swap-vouchers.cy.js` (VC-02) |  |
| `membership.send-voucher-from-portfolio` | Send/Gift a held FWMV voucher from the Portfolio asset sheet, voucher preselected | 🟢 covered | settled | `on-chain` | `43-voucher-send-from-portfolio.cy.js` (VSP-01) |  |

### `028-token-mint` — Token Mint mini-app

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `miniapp.token-mint-deploy` | Mint a token through the Token Mint mini-app | 🟢 covered | settled | `on-chain` | `32-miniapps.cy.js` (MA-04) |  |

### `030-clearpath-standard-daos` — ClearPath mini-app

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `miniapp.clearpath-register-dao` | Register an external DAO through ClearPath | 🟢 covered | settled | `on-chain` | `32-miniapps.cy.js` (MA-06) |  |
| `miniapp.clearpath-create-native-dao` | Create a native standard DAO through ClearPath (spec 030 pillar A) | 🟢 covered | settled | `on-chain` | `42-clearpath-native-dao.cy.js` (CD-01) |  |

### `033-network-aware-swap` — Network-aware swap

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `trade.swap-quote-and-execute` | Swap one asset for another on the active network | 🟢 covered | settled | `on-chain` | `33-transfers-swap-vouchers.cy.js` (SW-01) |  |

### `034-zk-wager-pools` — Wager pools

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `pools.create-and-join` | Create a group pool and have members join with their stake | 🟢 covered | settled | `on-chain` | `24-wager-pools.cy.js` (POOL-01) |  |
| `pools.settle-payout-matrix` | Creator proposes a payout matrix, members approve to threshold, the winner claims | 🟢 covered | settled | `on-chain` | `24-wager-pools.cy.js` (POOL-02) |  |
| `pools.deadline-refund` | A pool that never resolves returns members' stakes after the deadline | 🟢 covered | settled | `on-chain` | `24-wager-pools.cy.js` (POOL-03) |  |
| `pools.join-with-authorization` | Join a pool gaslessly by signing an EIP-3009 authorization | 🟢 covered | settled | `on-chain` | `24-wager-pools.cy.js` (POOL-04) |  |

### `035-intent-based-payments` — Gasless intents

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `intents.sign-and-relay` | Authorize an action by signature and have a relayer submit it | 🟢 covered | settled | `on-chain` | `07-manual-resolution.cy.js` (RES-17, RES-18, RES-19) |  |

### `036-relayer-infrastructure` — Relayer gateway

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `relay.gateway-policy` | A relayed action is screened, quota-checked and submitted | ⚪ out-of-scope | none | — (proposed: on-chain) | — | The gateway is a separate service with its own test suite; driving it from the browser suite would test the deployment, not the product. The member-visible half — the self-submit fallback — is tracked under intents.sign-and-relay. |

### `041-oracle-open-challenges` — Oracle-resolved open challenges

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.open-challenge-oracle-resolution` | An open challenge resolves from its oracle condition once settled | 🟢 covered | settled | `on-chain` | `08-oracle-resolution.cy.js` (ORC-02, ORC-03) |  |

### `041-passkey-wallet-login` — Passkey wallet login

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `passkey.recover-account` | Recover the account on a new device | 🟢 covered | settled | `account-native` | `recovery.cy.js` (RC-01, RC-04) |  |
| `membership.purchase-from-passkey` | Buy a membership from a passkey account in one ceremony: sponsored when the paymaster offers it, self-funded (never stranded) when it does not | 🟢 covered | settled | `account-native` | `membership-purchase.cy.js` (MP-01, MP-02) |  |

### `043-safe-multisig-custody` — Safe multisig custody

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `custody.create-vault` | Create a Safe vault and add its owners | 🟢 covered | settled | `on-chain` | `29-protect-custody.cy.js` (CV-01) |  |
| `custody.propose-and-execute` | Propose a transaction, collect approvals, execute it | 🟢 covered | settled | `on-chain` | `29-protect-custody.cy.js` (CV-02) |  |
| `custody.operate-as-vault` | Act as the vault rather than as yourself, and see which you are | 🟢 covered | flow | `on-chain` | `29-protect-custody.cy.js` (CV-03) |  |
| `custody.vault-action-sheet` | One sheet offers the four vault actions, and states why any is closed | 🟢 covered | flow | `no-chain` | `41-protect-vault-actions.cy.js` (VA-01, VA-05, VA-06) |  |
| `custody.create-vault-defaults` | A new vault defaults to a majority threshold and a starter policy, and refuses 1-of-1 with none | 🟢 covered | flow | `no-chain` | `41-protect-vault-actions.cy.js` (VA-02, VA-03, VA-04) |  |

### `049-multisig-policy-engine` — Multisig policy engine

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `custody.policy-v1-enforced` | A vault policy refuses a transaction that breaks its rules | 🟢 covered | settled | `on-chain` | `29-protect-custody.cy.js` (CV-07) |  |

### `050-earn-lending-rewards` — Earn — lending

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `earn.deposit-to-vault` | Deposit into a lending vault and see the position | 🟢 covered | settled | `on-chain` | `31-earn-lend-stake.cy.js` (EL-01) |  |
| `earn.withdraw-from-vault` | Withdraw a lending position back to the wallet | 🟢 covered | settled | `on-chain` | `31-earn-lend-stake.cy.js` (EL-02) |  |

### `050-sponsored-paymaster` — Sponsored paymaster

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `paymaster.sponsored-userop` | Send a passkey transaction with the fee sponsored | 🟢 covered | settled | `account-native` | `sponsored-userop.cy.js` (SU-01, SU-02) |  |

### `052-payments-style-wager-create` — Payments-style wager create

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.create-and-escrow` | Create a wager and have the stake escrowed | 🟢 covered | settled | `on-chain` | `04-wager-creation-tx.cy.js` (CRE-01, CRE-02, CRE-03, CRE-04, CRE-05) |  |

### `053-home-create-challenge` — Create a challenge from home

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `home.create-challenge-entry` | Start a challenge from the home screen | 🟢 covered | flow | `on-chain` | `04-wager-creation-tx.cy.js` (CRE-11, CRE-12) |  |

### `055-collectibles-portfolio` — Collect — buy side

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `collect.browse-and-buy` | Browse collectibles and buy one | 🟢 covered | flow | `no-chain` | `37-predict-and-collect.cy.js` (CO-01, CO-03) |  |

### `057-predict-polymarket` — Predict — Polymarket

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `predict.place-order` | Place an order on Polymarket's order book | ⚪ out-of-scope | none | — (proposed: no-chain) | — | The order book is a third-party venue with no local stand-in; the member-visible half — quoting, fee disclosure and the Polygon-only gate — is drivable and tracked as predict.builder-fee-disclosed. |

### `058-send-request-home` — Send and request from home

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `transfer.send-from-home` | Send funds to someone from the home screen | 🟢 covered | settled | `on-chain` | `33-transfers-swap-vouchers.cy.js` (TR-01) |  |
| `pay.group-settlement` | Settle a group payment - one batched transaction (passkey), one MultiSend proposal (vault), N separate consecutive-nonce proposals when the vault policy denies batches, or sequential sends with per-recipient outcomes | ⚪ out-of-scope | none | — (proposed: on-chain) | — | Withdrawn by #1441: a member cannot reach a group payment from any surface, so nothing settles one. The engine is untouched and the spec moved to withdrawn/41-group-settlement.cy.js, guarded by GROUP_PAY_ENABLED rather than deleted - GS-01/02/03 settle on chain again the moment it flips (#1538). Still absent when it does: the PASSKEY batched rail (one UserOp carrying every payment). sendPasskeyBatch reaches the chain only through bundlerClient.sendUserOperation after chooseRoute finds a healthy relayer or bundler, and its self-funded fallback drops the paymaster rather than the bundler - so a batch cannot be self-submitted and this rail needs the PASSKEY_FULL_STACK harness (now the cypress-passkey-full-stack job). The three rails a classic or vault member actually uses are covered and settled on chain. |

### `061-bitcoin-transactions` — Bitcoin

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `bitcoin.send` | Send bitcoin, paying the network fee you confirmed | ⚪ out-of-scope | none | — (proposed: on-chain) | — | No local regtest node exists in the harness, so nothing can settle a Bitcoin send. Standing up one is the work; until then this is a named gap rather than a silent skip. |
| `bitcoin.receive-address-rotates` | Get a fresh receive address that is never reissued | 🟢 covered | flow | `account-native` | `bitcoin-receive.cy.js` (BTC-01, BTC-02) |  |

### `062-legacy-account-recovery` — Legacy account recovery

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `recovery.import-legacy-key` | Import an old private key or word list and have it stored encrypted | 🟢 covered | settled | `no-chain` | `28-legacy-recovery.cy.js` (LKR-01, LKR-02, LKR-03, LKR-04) |  |
| `recovery.sweep-per-asset-outcomes` | Sweep a recovered account and see a per-asset result when one asset fails | 🟢 covered | settled | `on-chain` | `28-legacy-recovery-sweep.cy.js` (LKR-S1, LKR-S2, LKR-S3) |  |

### `063-cross-chain-legacy-recovery` — Cross-chain legacy recovery

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `recovery.sweep-across-chains` | Sweep a recovered account on more than one chain | 🟢 covered | flow | `no-chain` | `28-legacy-recovery.cy.js` (LKR-05, LKR-06) |  |

### `065-liquid-delegated-staking` — Liquid delegated staking

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `earn.stake-and-delegate` | Stake into a delegated position and see it | 🟢 covered | settled | `on-chain` | `31-earn-lend-stake.cy.js` (ES-01) |  |
| `earn.unstake` | Unstake and return the position to the wallet | 🟢 covered | settled | `on-chain` | `31-earn-lend-stake.cy.js` (ES-02) |  |

### `067-bridge-pool-liquidity` — Bridge and supplied liquidity

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `bridge.deposit-member-is-depositor` | Bridge funds with yourself as the depositor, so an unfilled deposit refunds to you | 🟢 covered | settled | `on-chain` | `30-bridge-liquidity.cy.js` (BL-03) |  |
| `liquidity.supply-uniswap-position` | Supply a Uniswap position, minted to you and not the router | 🟢 covered | settled | `on-chain` | `30-bridge-liquidity.cy.js` (BL-01) |  |
| `liquidity.pause-stops-new-only` | A pause stops new supplies while existing positions stay withdrawable | 🟢 covered | settled | `on-chain` | `30-bridge-liquidity.cy.js` (BL-02) |  |

### `068-protect-multi-chain-policies` — Protect — policy v2

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `custody.policy-v2-first-match` | A first-match rule array decides a proposal, and no match denies it | 🟢 covered | settled | `on-chain` | `29-protect-custody.cy.js` (CV-05) |  |
| `custody.policy-v2-adoption` | A vault consents to the v2 guard through a threshold-approved change | 🟢 covered | settled | `on-chain` | `29-protect-custody.cy.js` (CV-04) |  |

### `070-safe-receiver` — Safe receiver

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `custody.safe-receiver` | A vault receives assets that require a callback | ⚪ out-of-scope | none | — (proposed: on-chain) | — | Spec 070 is paused with open issues and nothing is shipped; there is no surface to drive. |

### `071-multi-chain-admin-console` — Multi-chain admin console

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `admin.configure-tier` | An operator changes a tier price and the chain reports the price every future purchase is quoted | 🟢 covered | settled | `on-chain` | `15-admin-panel.cy.js` (ADM-04) |  |
| `admin.treasury-withdrawal` | An operator withdraws accrued fees and the named recipient's balance moves by exactly that amount | 🟢 covered | settled | `on-chain` | `15-admin-panel.cy.js` (ADM-05) |  |

### `073-miniapp-platform` — Mini-app platform

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `miniapp.host-submit-screens` | A mini-app transaction is screened inside the host before any rail is touched | 🟢 covered | settled | `on-chain` | `32-miniapps.cy.js` (MA-05) |  |

### `083-perps-position-management` — Perps positions

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `perps.execute-order` | Place or close a perpetuals order in the app | ⚪ out-of-scope | none | — (proposed: on-chain) | — | No in-app execution ships (spec 082 FR-018); there is nothing to drive. An execution wrapper is a later spec with its own security lifecycle. |

### `085-hardware-wallet-protect` — Hardware wallets

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `hardware.add-and-reconnect` | Add a hardware account and reconnect to it later | 🟢 covered | flow | `no-chain` | `27-protect-hardware.cy.js` (HW-01, HW-02, HW-03, HW-04, HW-05) |  |
| `hardware.physical-confirmation` | Confirm a transaction on the device screen | ⚪ out-of-scope | none | — (proposed: no-chain) | — | Requires a physical device; the vendor seam is unit-tested behind connectHardware and the adapter errors are covered by the fast tier. |
| `hardware.bluetooth-transport` | Connect a Ledger over Bluetooth on a phone (BLE rail, transport-aware copy) | 🟢 covered | settled | `no-chain` | `45-hardware-ble-transport.cy.js` (BLE-01, BLE-02) |  |

### `088-instant-acting-accounts` — Instant acting accounts

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `account.act-immediately-after-create` | Switch to an acting account and use it immediately, with no ceremony at switch time | 🟢 covered | flow | `no-chain` | `33-account-surfaces.cy.js` (AA-01) |  |

### `098-acting-account-purchase` — Membership purchase lands on the acting account

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `purchase.acting-account` | A member operating as another account purchases membership that lands on the acting account, on every submit rail - including the split approve/purchase proposals on a policy-guarded vault (money path: on-chain tier required) | 🟡 partial | settled | `on-chain` | `40-acting-account-purchase.cy.js` (AAP-01, AAP-02, AAP-03) | The vault rail (batched and policy-split) and the acting-signer rail are covered end to end. Three rails are not reachable in this tier and are not faked: the HARDWARE rail (the dev-only adapter seam cannot sign or broadcast - hardware takes the identical acting-signer branch AAP-03 drives), the PASSKEY-batch negative of FR-006 (belongs to the cypress-passkey-full-stack job), and the RELAYED-intent rail of FR-007 (dev:e2e configures no relayer, so every gasless path self-submits - which is the never-stranded fallback AAP-03 exercises). |
| `purchase.acting-refusals` | Purchase still refuses, with the reason, when the acting account cannot be msg.sender on the membership chain | 🟡 partial | flow | `no-chain` | `42-acting-purchase-refusals.cy.js` (APR-01, APR-02, APR-03) | FR-003 names two refusal reasons. The chain-mismatch reason is covered (APR-01), as is the negative that the refusal no longer applies to eligible kinds (APR-02 hardware, APR-03 same-chain vault). The second reason - '<account> has no sending identity on <chain>' - is reachable only for acting kind `derived`, and CustodyContext exposes no way to enter that state (personal/vault/legacy/hardware only), so there is no member-facing route to drive. |

### `102-capacitor-channels` — Native release channels (iOS + Android + web)

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `native.passkey-signin` | A member signs in on the native app with the platform passkey ceremony and lands on the SAME account they hold on the web channel, PRF-derived keys intact; an unsupported device refuses with a named reason (unit: src/test/native/passkeyBridge.test.js; device leg: staged manual protocol in docs/runbooks/native-release-operations.md) | 🔴 absent | none | — (proposed: account-native) | #1389 |  |
| `native.ble-signing` | Ledger signing over the native Bluetooth rail with physical confirmation on the device screen | ⚪ out-of-scope | none | — (proposed: account-native) | — | Requires a physical Nano X and a human pressing its buttons - automation cannot confirm on a device screen. Protocol arithmetic and error normalization are unit-pinned (src/test/native/ledgerBleRung.test.js); the device run is the staged manual addendum in docs/runbooks/hardware-wallet-staging-validation.md, required before store submission. |

### `102-multisig-chain-abstraction` — Multisig chain abstraction — one vault, every network

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `custody.cross-chain-approve` | Approve a proposal on another network from the queue — the wallet is switched at tap time, a refusal is stated and nothing is signed | 🟢 covered | flow | `no-chain` | `42-protect-vault-sheet.cy.js` (VS-04) |  |
| `custody.sheet-approve-execute` | Approve and execute a proposal from the vault sheet's queue (money path) | 🟢 covered | settled | `on-chain` | `29-protect-custody.cy.js` (CV-08) |  |

### `103-funding-pools` — Funding pools (Request ▸ Pool)

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `funding.create-and-contribute` | Create a pool from Request ▸ Pool; a contributor opens the link and contributes | 🟢 covered | settled | `on-chain` | `39-funding-pools.cy.js` (FP-01) |  |
| `funding.organizer-close` | The organizer closes below the goal and collects the whole pot | 🟢 covered | settled | `on-chain` | `39-funding-pools.cy.js` (FP-02) |  |
| `funding.majority-refund` | A strict majority of contributors votes to refund; each collects their own contribution | 🟢 covered | settled | `on-chain` | `39-funding-pools.cy.js` (FP-03) |  |
| `funding.deadline-refund` | A pool nobody closes refunds after the settle deadline | 🟢 covered | settled | `on-chain` | `39-funding-pools.cy.js` (FP-04) |  |
| `funding.organizer-refund` | The organizer refunds everyone from an open pool | 🟢 covered | settled | `on-chain` | `39-funding-pools.cy.js` (FP-05) |  |

### `104-passkey-account-recovery` — Passkey account recovery — find the account, never guess it

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `passkey.recover-account-by-lookup` | A member signing in on a new device reaches the account their passkey controls, including when that passkey was added to the account later rather than being the key that created it | 🔴 absent | none | — (proposed: on-chain) | #1504 |  |
| `passkey.recover-never-wrong-account` | A passkey whose account cannot be verified never opens a session on an unverified address; the member is told what could not be confirmed, and an unreachable chain reads as unverified rather than as no account existing | 🟢 covered | flow | `account-native` | `account-recovery.cy.js` (REC-01, REC-02) |  |
| `passkey.recover-by-address` | A member relinks by entering their account address, and is signed in only when the chain lists the recovered key among that account's current owners | 🟡 partial | smoke | `account-native` | `account-recovery.cy.js` (REC-03) | The chain agreeing. This tier reaches no RPC, so what is proven is the form, the refusal of a malformed address, and that the address is handed on to be CHECKED — never that a verified address opens a session on the account it names. That needs a deployed account whose owner set includes a key this browser has no record of, i.e. the full-stack passkey tier. |

### `105-multichain-vault-creation` — Guided Multichain Vault Creation — One Vault, Chosen Networks

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `custody.create-flow-guided` | A non-technical member walks the four-sheet flow (type presets, rules tile grid with live summary, cohort network multi-select) with every refusal stated in plain language and no network question before a signature needs one | 🟢 covered | flow | `no-chain` | `41-protect-vault-actions.cy.js` (VA-02, VA-03, VA-04); `43-vault-create-flow.cy.js` (CF-01, CF-02, CF-03) |  |
| `custody.create-vault-multichain` | The flow deploys the vault and the deployed address IS the predicted one, with per-network status reaching Live from a real receipt | 🟡 partial | settled | `on-chain` | `29-protect-custody.cy.js` (CV-01) | deployment to a SECOND network in the same run (identical address, wallet switch mid-orchestration, per-network failure isolation) — the on-chain tier runs one private chain per leg, so the multi-network half is the staged manual protocol in docs/runbooks/multichain-vault-staging-validation.md (#1491); the state machine and CREATE2 identity across chainIds are Vitest-proven |
| `custody.create-rules-install` | The chosen rules install on each network after deployment — directly where the creator alone meets the threshold, queued as awaiting-approval where co-owners must sign — and an over-cap send is refused by the realized policy | 🟢 covered | settled | `on-chain` | `44-vault-rules-lanes.cy.js` (RL-01, RL-02) |  |
| `custody.create-passkey-batch` | A passkey member creates a governed vault in ONE sendCalls batch (deploy + both rule installs), landing at the predicted address with the record written from it — and a chain with no bundler states the write-rail reason on its chip instead of attempting the batch | 🟢 covered | settled | `account-native` | `vault-create-batch.cy.js` (PVC-01) |  |
| `custody.deploy-later` | From Details, a vault with a creation record deploys to a cohort network it is not on yet at the SAME address; a drifted owner set is disclosed as the original arrangement first; a vault without a record gets the honest reason, never a dead control | 🟡 partial | flow | `on-chain` | `44-vault-rules-lanes.cy.js` (RL-01, RL-02) | the replay deployment itself and FR-019 already-live need a SECOND custody network, which the one-chain full tier cannot host — staged manual protocol (docs/runbooks/multichain-vault-staging-validation.md, #1491). The record gate is chain-proven: the record holder is OFFERED Deploy for the missing cohort network (RL-01) and the no-record co-owner gets the honest FR-018 reason (RL-02); gating, disclosure and orchestrator handoff stay Vitest/component-proven (VaultDetailsView.test.jsx). |
| `custody.vault-details-one-card` | Details renders ONE card — compact network status rows, shared facts stated once with drift naming the differing network and coverage naming the unread one — never a repeated per-network card or an up-front switch gate | 🟢 covered | flow | `no-chain` | `42-protect-vault-sheet.cy.js` (VS-06, VS-12) |  |
| `custody.queue-readability` | Queue chips (All / Needs you / per-network) filter the rows without touching the four-state per-chain read disclosure; recognised proposals read in plain language and unknown calldata keeps the honest raw row | 🟢 covered | flow | `no-chain` | `42-protect-vault-sheet.cy.js` (VS-11) |  |

### `108-multi-currency-wrap` — Multi-currency wrap/unwrap — the asset is the entry point

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `trade.wrap-multi-currency-picker` | The Wrap view offers every cohort chain's base coin the member holds from one trading-view-style picker (icon, symbol, network, balance), with unreadable balances shown as unread (never zero) and unconfigured wrappers honestly absent | 🟢 covered | flow | `no-chain` | `48-wrap-multi-currency.cy.js` (WMC-01, WMC-02, WMC-03, WMC-04) |  |
| `trade.wrap-cross-chain-submit` | Selecting a coin whose chain differs from the wallet's switches the wallet at submit time (settle loop), wraps against that chain's own wrapped-native contract, and a refused switch names both chains and sends nothing | 🟢 covered | settled | `on-chain` | `45-wrap-cross-chain.cy.js` (WXC-01, WXC-02, WXC-03) |  |

### `110-multichain-write-seam` — Seamless multichain UX — chain-abstracted writes on a single EVM seam

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `multichain.claim-on-action-chain` | With the wallet on network B, tapping Claim on a wager living on network A resolves the target chain from the wager, moves the wallet through the one switch-and-settle seam, and completes the claim as a real settled transaction — no in-app 'switch network' step | 🔴 absent | none | — (proposed: on-chain) | #1552 |  |
| `multichain.intent-signs-without-switch` | A relayed EIP-712 intent targeting network A is signed while connected to network B with no network change requested at all — the chain lives in the signature domain | 🔴 absent | none | — (proposed: on-chain) | #1552 |  |

## Disclosure — a member consents to a cost

19 flows — 🟢 17 · 🟡 0 · 🔴 1 · ⚪ 1 · covered-but-not-proven 0

### `050-sponsored-paymaster` — Sponsored paymaster

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `paymaster.fallback-disclosed` | When sponsorship is unavailable, be told honestly that you are paying the fee | 🟢 covered | flow | `account-native` | `paymaster-disclosure.cy.js` (PM-01, PM-02) |  |

### `052-payments-style-wager-create` — Payments-style wager create

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.create-flow-validation` | Be stopped before signing when the wager form is wrong | 🟢 covered | flow | `no-chain` | `04-wager-creation-validation.cy.js` (CRE-17, CRE-18, CRE-19, CRE-20, CRE-21, CRE-22, CRE-23, CRE-24, CRE-25, CRE-26, CRE-27, CRE-28, CRE-29, CRE-30) |  |

### `056-collectibles-sell-side` — Collect — sell side

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `collect.list-for-sale` | List a collectible for sale and see the fee disclosure | 🟢 covered | flow | `no-chain` | `37-predict-and-collect.cy.js` (CO-02) |  |

### `057-predict-polymarket` — Predict — Polymarket

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `predict.builder-fee-disclosed` | See the additive builder fee as its own line before signing an order | 🟢 covered | settled | `no-chain` | `37-predict-and-collect.cy.js` (PR-02, PR-04) |  |

### `058-send-request-home` — Send and request from home

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `pay.group-affordance-withdrawn` | The send surfaces offer no multi-recipient control, and a single-recipient send is unchanged | 🟢 covered | flow | `no-chain` | `41-group-pay.cy.js` (GP-10, GP-11) |  |
| `pay.group-recipient-list` | Build a multi-recipient payment: add/remove rows, per-chain refusals, and the confirm disclosure (total, breakdown, rail, fee) | ⚪ out-of-scope | none | — (proposed: no-chain) | — | Withdrawn by #1441: no send surface renders the multi-recipient control, so there is no member-facing flow to drive. GROUP_PAY_ENABLED in frontend/src/lib/payments/groupPay.js is the one lever; fast/41-group-pay.cy.js is guarded by the same constant rather than deleted, and its GP-10/GP-11 assert the withdrawal itself. Restoring it is #1538. |

### `060-platform-fee-wrapper` — Platform fees

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `fees.disclosed-before-signature` | See the live fee rate before signing, and be charged no more than that | 🟢 covered | settled | `on-chain` | `25-platform-fees.cy.js` (FEE-01, FEE-02) |  |
| `fees.zero-rate-shows-no-line` | See no fee line at all when the rate is zero | 🟢 covered | flow | `no-chain` | `28-platform-fee-disclosure.cy.js` (FEE-04, FEE-05) |  |
| `fees.admin-changes-rate` | An operator changes a service's rate and members see the new one | 🟢 covered | settled | `on-chain` | `25-platform-fees.cy.js` (FEE-03) |  |

### `061-bitcoin-transactions` — Bitcoin

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `bitcoin.fee-quote-expiry` | Be refused a stale fee quote rather than signing at the wrong fee | 🟢 covered | flow | `account-native` | `bitcoin-send-fee.cy.js` (BTC-03) |  |

### `067-bridge-pool-liquidity` — Bridge and supplied liquidity

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `bridge.fee-consent-ceiling` | The quoted bps is a ceiling on what can be charged | 🟢 covered | settled | `on-chain` | `30-bridge-liquidity.cy.js` (BL-04) |  |

### `095-member-api-agentic-access` — Member API, private API keys and the opt-in assistant

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `assistant.opt-in` | The assistant does not exist until Tools ▸ Assistant turns it on, and stops existing when it is turned off | 🟢 covered | flow | `no-chain` | `38-assistant.cy.js` (AS-01) |  |
| `assistant.honest-unreachable` | An unreachable assistant service is named and retryable, and never answered for | 🟢 covered | flow | `no-chain` | `38-assistant.cy.js` (AS-02) |  |
| `assistant.memory-clear` | Conversation memory is device-local, counted on the Assistant tab, and clearable to nothing | 🟢 covered | settled | `no-chain` | `38-assistant.cy.js` (AS-03) |  |

### `104-guttertoken-assistant-rail` — GutterToken assistant rail and client-side tools

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `byok.key-lifecycle` | Save a GutterToken key only when GutterToken accepts it, keep it when GutterToken cannot be reached, and remove it | 🟢 covered | settled | `no-chain` | `47-assistant-rails.cy.js` (GT-01, GT-02) |  |
| `byok.non-member-chat` | A non-member with a saved key gets an answer straight from GutterToken, with no request to the FairWins chat route | 🟢 covered | settled | `no-chain` | `47-assistant-rails.cy.js` (GT-03) |  |
| `byok.honest-failures` | GutterToken's 403 and 429 each get their own sentence and action, and neither produces a reply bubble | 🟢 covered | flow | `no-chain` | `47-assistant-rails.cy.js` (GT-04) |  |
| `provider.choice` | A paid member switches rails, and the badge and the transport agree about which one answered | 🟢 covered | flow | `no-chain` | `47-assistant-rails.cy.js` (GT-05) |  |

### `110-multichain-write-seam` — Seamless multichain UX — chain-abstracted writes on a single EVM seam

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `multichain.refused-switch-discloses` | A wallet declining the network change signs nothing, and one message names both networks and what would fix it (spec 108 WXC-04 wording precedent, generalized to every write surface) | 🔴 absent | none | — (proposed: no-chain) | #1552 |  |

## Access — gating, identity and permission

51 flows — 🟢 49 · 🟡 0 · 🔴 2 · ⚪ 0 · covered-but-not-proven 1

### `003-polymarket-only-oracle-ui` — Polymarket-only oracle UI

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `oracle.select-polymarket-resolution` | Choose Polymarket resolution when creating a wager and see the condition bound to it | 🟢 covered | settled | `on-chain` | `04-wager-creation-tx.cy.js` (CRE-06, CRE-07) |  |

### `005-multi-recipient-encryption` — Multi-recipient encryption

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `encryption.register-key` | Register an encryption key so private wagers can be addressed to you | 🟢 covered | settled | `on-chain` | `03-encryption-chain.cy.js` (ENC-02, ENC-03) |  |
| `encryption.private-wager-roundtrip` | Create a private wager and have every intended recipient decrypt it | 🟢 covered | flow | `on-chain` | `16-privacy-encryption.cy.js` (PRV-01, PRV-02, PRV-03, PRV-04, PRV-05, PRV-07) |  |

### `007-compliance-gating` — Compliance gating

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `compliance.accept-terms-before-entry` | Read and accept the versioned terms before reaching the app | 🟢 covered | flow | `no-chain` | `34-member-surfaces.cy.js` (CG-01, CG-02) |  |
| `compliance.sanctioned-address-refused` | A screened address is refused before any transaction is offered | 🟢 covered | settled | `no-chain` | `31-identity-access.cy.js` (CM-01) |  |
| `compliance.frozen-account-blocked` | A frozen account cannot create a wager, and unfreezing restores it | 🟢 covered | settled | `on-chain` | `18-frozen-accounts.cy.js` (FRZ-01, FRZ-02) |  |
| `compliance.paused-protocol-blocked` | A paused protocol refuses new wagers, and unpausing restores them | 🟢 covered | settled | `on-chain` | `19-paused-protocol.cy.js` (PAU-01, PAU-02) |  |
| `compliance.passkey-account-parity` | A passkey account meets the same compliance gates as a classic wallet | 🟢 covered | settled | `on-chain` | `compliance.cy.js` (CP-01); `38-passkey-compliance.cy.js` (CP-02, CP-03) |  |

### `008-runtime-chain-consistency` — Runtime chain consistency

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `network.wrong-chain-guard` | Be told, and blocked, when the wallet is on a different chain than the surface | 🟢 covered | flow | `no-chain` | `21-network-errors.cy.js` (NET-01, NET-02, NET-03) |  |

### `021-address-book` — Address book

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `addressbook.save-and-use-contact` | Save a contact and address a wager or transfer to it | 🟢 covered | settled | `no-chain` | `34-member-surfaces.cy.js` (MS-01) |  |
| `addressbook.export-import-roundtrip` | Export the address book to a plain-text file and import it back, with no wallet signature | 🟢 covered | settled | `no-chain` | `34-member-surfaces.cy.js` (MS-07) |  |

### `022-membership-purchase-progress` — Membership purchase progress

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `membership.expired-blocks-participation` | An expired membership blocks wager creation until it is renewed | 🟢 covered | settled | `on-chain` | `20-expired-membership.cy.js` (EXP-01, EXP-02) |  |

### `032-encrypted-data-sync` — Encrypted data sync

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `backup.encrypted-sync-roundtrip` | Back up local data encrypted and restore it on another device | 🟢 covered | settled | `on-chain` | `35-navigation-and-lookup.cy.js` (BK-01, BK-02); `37-backup-roundtrip.cy.js` (BKC-01, BKC-02) |  |

### `037-unified-pool-challenge-lookup` — Unified pool and challenge lookup

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.lookup-by-code` | Find a pool or challenge from a code someone sent you | 🟢 covered | flow | `no-chain` | `35-navigation-and-lookup.cy.js` (LK-01) |  |

### `041-passkey-wallet-login` — Passkey wallet login

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `passkey.create-account` | Create an account with a passkey and no seed phrase | 🟢 covered | settled | `account-native` | `onboarding-journey.cy.js` (PK-02) |  |
| `passkey.return-and-sign-in` | Come back on the same device and sign in | 🟢 covered | settled | `account-native` | `returning-user.cy.js` (RU-01, RU-02) |  |
| `passkey.unified-login` | Reach the same account whether you arrive by passkey or by wallet | 🟢 covered | flow | `account-native` | `unified-login.cy.js` (UL-03, UL-05) |  |
| `passkey.controllers` | Add and remove the controllers that may act for the account | 🟢 covered | settled | `account-native` | `controllers.cy.js` (CT-01, CT-02, CT-03) |  |
| `passkey.app-lock` | Lock the screen after idle or on leaving, and unlock with a passkey | 🟢 covered | settled | `account-native` | `app-lock.cy.js` (AL-01, AL-02, AL-03, AL-04, AL-05) |  |

### `042-clearpath-multi-network` — ClearPath across networks

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `miniapp.clearpath-network-switch` | Use ClearPath on a second network | 🟢 covered | settled | `on-chain` | `32-miniapps.cy.js` (MA-07) |  |

### `045-unified-connect-recovery` — Unified connect and recovery

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `connect.choose-a-way-in` | Choose between wallet, passkey and recovery from one entry point | 🟢 covered | flow | `no-chain` | `01-wallet-connection.cy.js` (WAL-01, WAL-02, WAL-03, WAL-04) |  |
| `connect.disconnect-and-switch` | Disconnect, and switch between accounts | 🟢 covered | flow | `no-chain` | `01-wallet-connection.cy.js` (WAL-05, WAL-06, WAL-07, WAL-08, WAL-09, WAL-10, WAL-11) |  |
| `connect.first-run-onboarding` | Arrive with nothing set up and be walked to a way in | 🟢 covered | smoke | `no-chain` | `17-onboarding.cy.js` (ONB-01, ONB-02, ONB-03) |  |

### `054-callsign-registry` — Callsigns

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `callsign.commit-reveal-register` | Register a %callsign through commit and reveal | 🟢 covered | settled | `on-chain` | `34-callsign-registration.cy.js` (CR-01) |  |
| `callsign.resolve-in-address-entry` | Address a transfer to someone by their callsign | 🟢 covered | settled | `no-chain` | `31-identity-access.cy.js` (CS-02) |  |
| `callsign.gated-below-gold` | Be told why registration is unavailable below Gold tier | 🟢 covered | settled | `no-chain` | `31-identity-access.cy.js` (CS-01) |  |

### `057-predict-polymarket` — Predict — Polymarket

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `predict.hidden-off-polygon` | See the Predict tab hidden on a chain Polymarket does not serve | 🟢 covered | settled | `no-chain` | `37-predict-and-collect.cy.js` (PR-03) |  |

### `061-bitcoin-transactions` — Bitcoin

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `bitcoin.network-card-activates` | Open the Bitcoin wallet surface from its network card without touching the EVM chain | 🟢 covered | flow | `no-chain` | `44-bitcoin-network-card.cy.js` (BC-01, BC-02, BC-03) |  |

### `066-staking-admin-controls` — Staking admin controls

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `admin.staking-controls` | An operator pauses or retires a staking route | 🟢 covered | settled | `on-chain` | `31-earn-lend-stake.cy.js` (ES-03) |  |

### `069-network-endpoints-user-panel` — Network endpoints

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `endpoints.save-custom-rpc` | Save your own RPC endpoint and have reads use it | 🟢 covered | settled | `no-chain` | `31-identity-access.cy.js` (EP-01) |  |
| `endpoints.wrong-chain-refused` | Be refused an endpoint that answers with a different chain id | 🟢 covered | settled | `no-chain` | `31-identity-access.cy.js` (EP-02) |  |
| `endpoints.credentials-redacted` | Never see your endpoint credential rendered back to you | 🟢 covered | settled | `no-chain` | `31-identity-access.cy.js` (EP-03) |  |

### `071-multi-chain-admin-console` — Multi-chain admin console

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `admin.estate-reads-three-state` | An operator reads the estate and sees not-deployed and unreadable distinguished from zero | 🟢 covered | settled | `no-chain` | `32-admin-console.cy.js` (AD-04) |  |
| `admin.single-chain-write` | An operator writes to one named chain with authority read from that chain | 🟢 covered | settled | `on-chain` | `35-admin-single-chain-write.cy.js` (AD-06) |  |
| `admin.grant-revoke-membership` | An operator grants a membership tier to a user address and revokes it, judged on-chain | 🟢 covered | settled | `on-chain` | `15-admin-panel.cy.js` (ADM-03) |  |
| `admin.grant-revoke-operator-role` | An operator grants an admin role to an address, the contract confirms it, and a revoke removes it | 🟢 covered | settled | `on-chain` | `35-admin-single-chain-write.cy.js` (AD-07) |  |

### `072-white-label-tenants` — White-label tenants

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `tenant.brand-resolves-from-manifest` | A tenant build shows its own identity and no other tenant's | 🟢 covered | settled | `no-chain` | `31-identity-access.cy.js` (TN-01) |  |

### `073-miniapp-platform` — Mini-app platform

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `miniapp.launch-verified-package` | Launch a mini-app whose bytes are verified against the chain | 🟢 covered | settled | `on-chain` | `32-miniapps.cy.js` (MA-01) |  |
| `miniapp.launchable-not-status` | A live app whose update is in review still launches | 🟢 covered | settled | `on-chain` | `32-miniapps.cy.js` (MA-02) |  |
| `miniapp.curator-approve-content-committed` | A curator approval is refused when the package changed under it | 🟢 covered | settled | `on-chain` | `32-miniapps.cy.js` (MA-03) |  |

### `084-message-signing-verify` — Message signing and Verify

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `verify.three-verdicts` | Verify a signature and get valid, invalid, or unverifiable — never a forged-looking result from an RPC timeout | 🟢 covered | settled | `no-chain` | `30-verify-message.cy.js` (VF-01, VF-02) |  |
| `verify.refused-while-operating-as-vault` | Be refused message signing while acting as a vault | 🟢 covered | flow | `no-chain` | `30-verify-message.cy.js` (VF-03) |  |

### `093-admin-mini-apps` — Admin mini-apps

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `admin.control-room-gating` | An operator sees granted, denied, or could-not-verify — never a silent denial | 🟢 covered | settled | `no-chain` | `32-admin-console.cy.js` (AD-01, AD-02, AD-03); `15-admin-panel.cy.js` (ADM-01, ADM-02) |  |
| `admin.maintenance-permissionless` | Any entrant reaches Maintenance without elevated status | 🟢 covered | settled | `no-chain` | `32-admin-console.cy.js` (AD-05) |  |

### `095-member-api-agentic-access` — Member API, private API keys and the opt-in assistant

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `api-access.create-key` | A member-signed grant is revealed once, persisted nowhere, and leaves only metadata | 🟢 covered | settled | `no-chain` | `39-api-access.cy.js` (API-01, API-05) |  |
| `api-access.revoke-key` | A signed revocation is registered without overstating what registration means | 🟢 covered | flow | `no-chain` | `39-api-access.cy.js` (API-02, API-03) |  |
| `api-access.console` | The api-access developer console: OpenAPI explorer, token introspection, try-it, and the key-ceremony deep link into the host | 🟢 covered | flow | `on-chain` | `39-api-access.cy.js` (API-04); `39-api-access-console.cy.js` (API-06, API-07, API-08, API-09, API-10) |  |

### `102-capacitor-channels` — Native release channels (iOS + Android + web)

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `native.lifecycle-lock` | Backgrounding the native app past the lock threshold re-prompts before any wallet surface on foreground (unit: src/test/native/lifecycle.test.js + the native case in src/test/applock/AppLockOverlay.test.jsx; the release smoke jobs prove launch/render/lifecycle-survival but cannot reach a signed-in lock) | 🔴 absent | none | — (proposed: no-chain) | #1389 |  |

### `102-multisig-chain-abstraction` — Multisig chain abstraction — one vault, every network

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `custody.acting-from-sheet` | Choose the acting account from the vault sheet; the header follows and the switcher lists the vault once | 🟢 covered | flow | `no-chain` | `42-protect-vault-sheet.cy.js` (VS-07) |  |

### `104-guttertoken-assistant-rail` — GutterToken assistant rail and client-side tools

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `controls.moved-to-tools` | The agent controls live on Tools ▸ Assistant, Settings no longer carries them, and the old Settings hashes redirect | 🟢 covered | flow | `no-chain` | `47-assistant-rails.cy.js` (GT-07) |  |

### `110-multichain-write-seam` — Seamless multichain UX — chain-abstracted writes on a single EVM seam

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `multichain.rail-unavailable-before-tap` | An acting identity whose rail cannot reach the target chain (passkey on bundlerless ETC/Mordor; vault signer elsewhere) sees the unavailability stated BEFORE the tap, naming the chain and the way out — never a submit-time chain-support error | 🔴 absent | none | — (proposed: no-chain) | #1552 |  |

## Information — read-only surfaces

50 flows — 🟢 50 · 🟡 0 · 🔴 0 · ⚪ 0 · covered-but-not-proven 12

### `005-multi-recipient-encryption` — Multi-recipient encryption

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `encryption.key-ui` | See encryption state and prompts before any chain write | 🟢 covered | smoke | `no-chain` | `03-encryption-ui.cy.js` (ENC-01, ENC-04, ENC-05, ENC-06, ENC-07) |  |

### `009-fix-qr-share` — Share a wager by QR

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `share.wager-link-and-qr` | Share a wager by link or QR and have the recipient land on it | 🟢 covered | flow | `no-chain` | `12-sharing-ui.cy.js` (SHR-01, SHR-02, SHR-03, SHR-04) |  |

### `010-footer-policy-fixes` — Policy documents

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `legal.read-versioned-policies` | Open terms, risk and privacy from the footer before connecting | 🟢 covered | settled | `no-chain` | `34-member-surfaces.cy.js` (MS-05) |  |

### `011-wallet-address-qr` — Wallet address QR

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `receive.show-address-qr` | Show your address as a QR for someone to send to | 🟢 covered | smoke | `no-chain` | `12-sharing-ui.cy.js` (SHR-05, SHR-06, SHR-07, SHR-08) |  |

### `012-wager-notifications` — Wager notifications

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `notifications.wager-state-change` | Be notified when a wager you are in changes state | 🟢 covered | flow | `on-chain` | `36-wager-notifications.cy.js` (NOT-01, NOT-02) |  |

### `013-polymarket-search-filter` — Polymarket search and filter

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `predict.search-markets` | Search and filter Polymarket markets when choosing a condition | 🟢 covered | settled | `no-chain` | `37-predict-and-collect.cy.js` (PR-01) |  |

### `014-quick-action-dashboard` — Quick-action dashboard

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `home.quick-actions` | Reach the common actions from the home screen | 🟢 covered | smoke | `no-chain` | `13-dashboard.cy.js` (DSH-01, DSH-02, DSH-03, DSH-04) |  |

### `016-wager-tax-report` — Wager tax report

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `reports.export-wager-history` | Export a settled-wager report for tax purposes | 🟢 covered | flow | `no-chain` | `34-member-surfaces.cy.js` (MS-02) |  |

### `017-wager-grid-redesign` — Wager grid redesign

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.browse-grid` | Browse open and participating wagers | 🟢 covered | smoke | `no-chain` | `13-dashboard.cy.js` (DSH-05, DSH-06, DSH-07) |  |

### `018-wager-views-feedback` — Wager view feedback

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.empty-and-loading-states` | See honest empty and loading states rather than a blank grid | 🟢 covered | smoke | `no-chain` | `13-dashboard.cy.js` (DSH-08, DSH-09) |  |

### `019-wager-auto-views` — Automatic wager views

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.auto-view-selection` | Land on the view that matches what you have | 🟢 covered | smoke | `no-chain` | `23-home-modes.cy.js` (HMM-01, HMM-02, HMM-03, HMM-04, HMM-05) |  |

### `020-account-stats-dashboard` — Account stats

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `account.see-stats` | See your wager record and balances | 🟢 covered | smoke | `no-chain` | `13-dashboard.cy.js` (DSH-10, DSH-11, DSH-12) |  |

### `021-address-book` — Address book

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `addressbook.estate-screening-pill` | Enter an address and see whether it is flagged on any list on any network — never a false green | 🟢 covered | settled | `no-chain` | `34-member-surfaces.cy.js` (MS-06); `31-identity-access.cy.js` (CM-01) |  |

### `023-oracle-graph-gating` — Oracle graph gating

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `oracle.graph-unavailable-degrades` | See an honest degraded state when the oracle index is unreachable | 🟢 covered | flow | `no-chain` | `36-activity-and-oracle-gating.cy.js` (OG-01) |  |

### `030-clearpath-standard-daos` — ClearPath mini-app

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `miniapp.clearpath-create-dao-unavailable` | ClearPath Launch tab states why a DAO cannot be created on this chain | 🟢 covered | flow | `no-chain` | `46-clearpath-unavailable.cy.js` (CDU-01, CDU-02) |  |

### `031-platform-notifications` — Platform notifications

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `notifications.platform-feed` | See platform notifications and clear them | 🟢 covered | flow | `no-chain` | `34-member-surfaces.cy.js` (MS-03) |  |

### `038-ux-consistency` — UX consistency

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `ui.consistent-controls` | Find the same control in the same place across surfaces | 🟢 covered | smoke | `no-chain` | `22-accessibility.cy.js` (A11Y-01, A11Y-02, A11Y-03) |  |

### `039-wager-info-tooltips` — Wager info tooltips

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.explanatory-tooltips` | Read what a wager field means before committing to it | 🟢 covered | smoke | `no-chain` | `13-dashboard.cy.js` (DSH-13, DSH-14) |  |

### `040-my-wagers-refinements` — My Wagers refinements

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.my-wagers-tabs` | Separate what you created from what you joined | 🟢 covered | smoke | `no-chain` | `13-dashboard.cy.js` (DSH-15, DSH-16, DSH-17, DSH-18) |  |

### `044-connected-account-portfolio` — Connected account portfolio

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `portfolio.see-holdings` | See what the connected account holds across supported assets | 🟢 covered | settled | `no-chain` | `33-account-surfaces.cy.js` (AC-02, AC-03) |  |

### `047-mask-sensitive-values` — Mask sensitive values

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `privacy.mask-balances` | Hide balances on screen when someone is looking over your shoulder | 🟢 covered | settled | `no-chain` | `33-account-surfaces.cy.js` (AC-05) |  |

### `051-unified-activity-ledger` — Activity ledger

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `activity.see-unified-history` | See one history across wagers, transfers and membership | 🟢 covered | flow | `no-chain` | `33-account-surfaces.cy.js` (AC-04) |  |

### `059-notification-profiles` — Notification profiles

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `notifications.choose-profile` | Choose how much you are notified | 🟢 covered | flow | `no-chain` | `34-member-surfaces.cy.js` (MS-04) |  |

### `064-universal-asset-selector` — Universal asset selector

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `assets.pick-any-supported-asset` | Pick any supported asset from one selector | 🟢 covered | flow | `no-chain` | `35-navigation-and-lookup.cy.js` (AS-01) |  |

### `068-protect-multi-chain-policies` — Protect — policy v2

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `custody.multi-chain-vault-list` | See vaults across chains, with a failed chain named rather than shown as empty | 🟢 covered | flow | `on-chain` | `29-protect-custody.cy.js` (CV-06) |  |

### `074-unified-my-account` — My Account

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `account.unified-panel` | Reach preferences, membership and network from one account panel | 🟢 covered | settled | `no-chain` | `33-account-surfaces.cy.js` (AC-01) |  |

### `077-miniapp-store-redesign` — Mini-app store

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `miniapp.browse-catalog` | Browse the app catalogue and pin an app to quick access | 🟢 covered | settled | `no-chain` | `29-miniapp-catalog.cy.js` (MC-01, MC-02, MC-03) |  |

### `078-my-wagers-single-table-view` — My Wagers single table

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `wagers.single-table-view` | See every wager you are in as one table | 🟢 covered | smoke | `no-chain` | `13-dashboard.cy.js` (DSH-05, DSH-06) |  |

### `081-nav-drawer-density` — Nav drawer density

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `nav.drawer-sections-and-density` | Fold nav sections and choose a compact density that survives a reload | 🟢 covered | flow | `no-chain` | `35-navigation-and-lookup.cy.js` (NV-01, NV-02) |  |

### `082-perps-trade-view` — Perps market data

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `perps.browse-venues` | Compare perpetuals pairs across venues | 🟢 covered | flow | `no-chain` | `24-perps.cy.js` (PERPS-01, PERPS-02, PERPS-03, PERPS-04, PERPS-05) |  |
| `perps.degraded-venue-named` | A degraded venue is named and its pairs omitted, never shown as zeros | 🟢 covered | flow | `no-chain` | `24-perps.cy.js` (PERPS-01, PERPS-06) |  |
| `trade.wrap-view` | Wrap is a Trade view beside Swap and Perps, with Swap still the default | 🟢 covered | flow | `no-chain` | `40-account-add-wrap-move.cy.js` (TRADE-WRAP-01, TRADE-WRAP-02) |  |
| `trade.wrap-legacy-redirect` | The old Transfer wrap URL redirects into the Trade wrap view | 🟢 covered | flow | `no-chain` | `40-account-add-wrap-move.cy.js` (TRADE-WRAP-03, TRADE-WRAP-04) |  |

### `083-perps-position-management` — Perps positions

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `perps.read-positions` | Read your open positions without being offered a way to trade them here | 🟢 covered | flow | `no-chain` | `25-perps-management.cy.js` |  |

### `086-account-cards` — Account cards

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `account.cards` | See your accounts as cards and switch between them | 🟢 covered | smoke | `no-chain` | `26-trade-account.cy.js` |  |
| `account.add-chooser` | Open the "+" chooser and see the three ways to add an account | 🟢 covered | flow | `no-chain` | `40-account-add-wrap-move.cy.js` (ACC-ADD-01) |  |
| `account.add-hardware` | "Add a hardware account" deep-links to Protect > Off chain with the card open | 🟢 covered | flow | `no-chain` | `40-account-add-wrap-move.cy.js` (ACC-ADD-02) |  |
| `account.add-vault` | "Add a vault" deep-links to Protect > On chain | 🟢 covered | flow | `no-chain` | `40-account-add-wrap-move.cy.js` (ACC-ADD-03) |  |
| `account.add-legacy-recovery` | "Recover a legacy account" deep-links to Recovery's legacy import | 🟢 covered | flow | `no-chain` | `40-account-add-wrap-move.cy.js` (ACC-ADD-04) |  |

### `092-multi-chain-activity` — Multi-chain activity

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `activity.multi-chain-history` | See activity across chains, with an unreadable chain named rather than empty | 🟢 covered | flow | `no-chain` | `36-activity-and-oracle-gating.cy.js` (MC-01, MC-02) |  |

### `102-multisig-chain-abstraction` — Multisig chain abstraction — one vault, every network

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `custody.vault-cards` | See one compact card per vault across every network it lives on | 🟢 covered | flow | `no-chain` | `42-protect-vault-sheet.cy.js` (VS-01) |  |
| `custody.vault-sheet-queue` | Open the vault sheet and read the pending queue with each proposal's network tagged, an unreadable network named | 🟢 covered | flow | `no-chain` | `42-protect-vault-sheet.cy.js` (VS-02, VS-03) |  |
| `custody.vault-style` | Style the vault card from the sheet; the card behind it updates | 🟢 covered | flow | `no-chain` | `42-protect-vault-sheet.cy.js` (VS-05) |  |
| `custody.vault-details` | Read the vault's networks and owners, cross-referenced to the address book, and add an unknown owner in place | 🟢 covered | flow | `no-chain` | `42-protect-vault-sheet.cy.js` (VS-06) |  |
| `custody.remove-all-networks` | Remove a vault from Protect on every network after confirmation | 🟢 covered | flow | `no-chain` | `42-protect-vault-sheet.cy.js` (VS-08) |  |
| `custody.load-all-networks` | Load a vault address and have it added on every network it exists on, without picking one | 🟢 covered | flow | `no-chain` | `42-protect-vault-sheet.cy.js` (VS-09) |  |
| `wallet.balance-display` | Balances in Wrap and Transfer fit the screen (display formatter) | 🟢 covered | flow | `no-chain` | `42-protect-vault-sheet.cy.js` (VS-10) |  |

### `104-guttertoken-assistant-rail` — GutterToken assistant rail and client-side tools

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `tools.honest-progress` | A tool round shows what is being read and reports a failed read as could not be read, never as zero | 🟢 covered | flow | `no-chain` | `47-assistant-rails.cy.js` (GT-06) |  |

### `109-token-news` — Token news on portfolio and trade surfaces

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `news.portfolio-token-card` | Selecting a portfolio token shows that asset's latest news with link-out attribution; an unreadable feed renders a sentence + retry (never an empty feed pretending to be no news), an unmapped asset renders honest absence, and the module off hides the card | 🟢 covered | flow | `no-chain` | `49-token-news.cy.js` (TN-01, TN-03, TN-04, TN-04b, TN-06) |  |
| `news.trade-pair-feed` | Selecting a trade pair shows the pair's token news below the amount entry under the same three-state honesty; items are text with attribution, never rendered HTML | 🟢 covered | flow | `no-chain` | `49-token-news.cy.js` (TN-05, TN-05b) |  |

## No member consequence

4 flows — 🟢 3 · 🟡 0 · 🔴 1 · ⚪ 0 · covered-but-not-proven 0

### `102-capacitor-channels` — Native release channels (iOS + Android + web)

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `native.deep-link-entry` | A share link opened with the app installed lands on the linked surface in-app through any due gate; foreign-origin URLs through the link channel are ignored (unit: src/test/native/deepLinks.test.js) | 🔴 absent | none | — (proposed: no-chain) | #1389 |  |

### `103-funding-pools` — Funding pools (Request ▸ Pool)

| Flow | What a member does | Status | Depth | Tier | Evidence / issue | Note |
|---|---|---|---|---|---|---|
| `funding.request-pool-form` | Switch the Request view from Direct to Pool, validate the form, see the public-purpose disclosure | 🟢 covered | flow | `no-chain` | `42-funding-pools.cy.js` (FP-FAST-01, FP-FAST-02, FP-FAST-03, FP-FAST-04, FP-FAST-07) |  |
| `funding.my-pools-sheet` | Open My Pools, see the honest empty state, find a pool by words or link | 🟢 covered | flow | `no-chain` | `42-funding-pools.cy.js` (FP-FAST-05) |  |
| `funding.unreadable-link` | A pool link the chain cannot answer renders as unreadable, never as zeros | 🟢 covered | flow | `no-chain` | `42-funding-pools.cy.js` (FP-FAST-06) |  |

## No member-facing flow

Listed so the gate can tell "correctly omitted" from "forgotten".

| Spec | Why there is nothing to drive |
|---|---|
| `002-e2e-encryption-lifecycle` — E2E encryption lifecycle | A test-coverage spec for the encryption feature; its flows are recorded under 005-multi-recipient-encryption. |
| `006-local-dev-environment` — Local development environment | Developer tooling; there is no member surface to drive. |
| `015-mordor-network-deployment` — Mordor network deployment | A deployment target; the member-facing surface is network selection, recorded under 069-network-endpoints-user-panel. |
| `017-subgraph-v2-wager-transfers` — Subgraph v2 wager transfers | Indexing infrastructure; the member-facing surface is the wager lists it feeds, recorded under 078. |
| `025-upgradeable-registry` — Upgradeable wager registry | Proxy upgrade mechanics; the member-facing surface is every wager flow that runs against the proxy, and is recorded there. Storage layout is gated by check:storage-layout. |
| `027-upgradeable-membership` — Upgradeable membership manager | Proxy upgrade mechanics; membership's member-facing flows are recorded under 022 and 071. |
| `046-contract-audit-coverage` — Contract audit coverage | Contract test coverage policy; enforced by the Solidity suite and the coverage threshold gate. |
| `048-ethereum-mainnet-support` — Ethereum mainnet support | A network configuration; the member-facing surface is network selection and per-chain reads, recorded under 069 and 071. |
| `075-monorepo-workspaces` — Monorepo workspaces | Build and dependency tooling; no member surface. Gated by check:deps and the byte-diff gates. |
| `076-monorepo-semantic-versioning` — Semantic versioning | Release tooling; no member surface. Gated by the release tooling tests. |
| `079-hardhat-3-migration` — Hardhat 3 migration | Contract toolchain migration; no member surface. |
| `080-deterministic-addresses` — Deterministic addresses | Deployment mechanics; the member-facing effect is that addresses match the recorded deployments, gated by the deploy scripts. |
| `087-infrastructure-as-code` — Infrastructure as code | Cloud provisioning; no member surface. Gated by check:iac and the Terraform plan. |
| `089-finops-dashboard` — FinOps dashboard | Internal revenue and cost dashboards; no member surface. Gated by check:finops. |
| `090-chippr-brand-alignment` — Chippr brand alignment | Design tokens; member-visible but with no journey to drive. Gated by the four brand tests in frontend/src/test/brand/. |
| `091-neutral-token-consolidation` — Neutral token consolidation | Design tokens; gated by noHardcodedColors and noUndefinedTokens. |
| `094-e2e-coverage-expansion` — E2E coverage expansion | This feature: the matrix, the tiering policy and the suite's own gates. Its subject is the coverage of every other row. |
| `096-x402-agentic-payments` — x402 pay-per-request access to the member API | An agent-facing HTTP rail with no member surface: an unauthenticated caller is answered 402 with a price, pays with an X-PAYMENT header, and is served as the payer. No component, route or member journey changes, and a member holding a capability token never enters the path. Its gate is the gateway vitest suite (services/relay-gateway/test/x402.test.js) plus the spec-095 suites passing unchanged with the rail enabled, and node:test coverage of the MCP server's 402 surfacing and payment passthrough. |
| `097-workstation-secrets-observability` — Workstation secrets and local observability | Operator tooling with no member surface: credentials move off a local .env into Secret Manager and are delivered per least-privilege profile by a wrapper, and the Prometheus and Grafana stack is a read-only viewing surface bound to loopback. Nothing here is reachable from the app, and the workstation identity is declared Terraform with no service-account key file. Gated by the scripts/secrets vitest suites (including the registry/tfvars parity test, which fails on drift because a missing grant surfaces later as PERMISSION_DENIED), check:env-hygiene, and the Terraform plan. |
| `099-network-status-miniapp` — Network status mini-app | Spec landed in release 1.14.0; the mini-app package has no member surface yet. Flows are owed when the package ships (#1364). |
| `100-passkey-solana` — Passkey-native Solana | Spec + plan landed in release 1.14.0; no member surface exists yet. Implementation follows the constitution-checked plan (#1364). |
| `101-passkey-zcash` — Passkey-native Zcash | Spec + plan landed in release 1.14.0; no member surface exists yet. Implementation follows the constitution-checked plan (#1364). |
| `106-gateway-caller-auth` — Gateway caller authentication | Gateway-side caller-identity tiers, quota re-keying and enforcement — server behaviour with no member surface of its own, covered by 34 gateway vitest files (test/identity/). The one member-visible artifact today is the invisible, silently-degrading Turnstile widget (aria-hidden until a surface opts into interactive escalation); member-facing flows arrive when a surface adopts it and when IDENTITY_ENFORCE changes refusal paths on the Predict/Collect/BTC write flows already rowed under specs 055-057/061. |
| `107-keyed-rpc-access` — Keyed RPC access | Runtime-issued read-only RPC credentials. Dormant end to end until an issuance endpoint is configured (#1438 runbook); every client failure mode falls back to the public default the app uses today, so there is no member-distinguishable flow yet. Covered by gateway vitest (test/access.test.js) and frontend vitest (src/test/network/issuedAccess.test.js); a member-facing degradation-disclosure flow gets a row when the disclosure surface ships. |

## Covered but not proven

Passing tests that do not establish the outcome. Each needs its assertions deepened, not
another test added beside it.

| Flow | Spec | Depth | Evidence |
|---|---|---|---|
| `encryption.key-ui` | `005-multi-recipient-encryption` | smoke | `03-encryption-ui.cy.js` (ENC-01, ENC-04, ENC-05, ENC-06, ENC-07) |
| `receive.show-address-qr` | `011-wallet-address-qr` | smoke | `12-sharing-ui.cy.js` (SHR-05, SHR-06, SHR-07, SHR-08) |
| `home.quick-actions` | `014-quick-action-dashboard` | smoke | `13-dashboard.cy.js` (DSH-01, DSH-02, DSH-03, DSH-04) |
| `wagers.browse-grid` | `017-wager-grid-redesign` | smoke | `13-dashboard.cy.js` (DSH-05, DSH-06, DSH-07) |
| `wagers.empty-and-loading-states` | `018-wager-views-feedback` | smoke | `13-dashboard.cy.js` (DSH-08, DSH-09) |
| `wagers.auto-view-selection` | `019-wager-auto-views` | smoke | `23-home-modes.cy.js` (HMM-01, HMM-02, HMM-03, HMM-04, HMM-05) |
| `account.see-stats` | `020-account-stats-dashboard` | smoke | `13-dashboard.cy.js` (DSH-10, DSH-11, DSH-12) |
| `ui.consistent-controls` | `038-ux-consistency` | smoke | `22-accessibility.cy.js` (A11Y-01, A11Y-02, A11Y-03) |
| `wagers.explanatory-tooltips` | `039-wager-info-tooltips` | smoke | `13-dashboard.cy.js` (DSH-13, DSH-14) |
| `wagers.my-wagers-tabs` | `040-my-wagers-refinements` | smoke | `13-dashboard.cy.js` (DSH-15, DSH-16, DSH-17, DSH-18) |
| `connect.first-run-onboarding` | `045-unified-connect-recovery` | smoke | `17-onboarding.cy.js` (ONB-01, ONB-02, ONB-03) |
| `wagers.single-table-view` | `078-my-wagers-single-table-view` | smoke | `13-dashboard.cy.js` (DSH-05, DSH-06) |
| `account.cards` | `086-account-cards` | smoke | `26-trade-account.cy.js` |

