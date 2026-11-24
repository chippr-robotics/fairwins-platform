# Admin mini-apps (spec 093)

The operations control plane is no longer one monolithic panel. `/admin` is the **Control
Room** — a launcher listing exactly the admin apps the connected account's on-chain roles
unlock — and each group of admin controls is its own **admin mini-app** at `/admin/<appId>`,
lazily loaded, with `?view=<viewId>` addressing the views inside it.

## Host-bundled, deliberately

Admin apps ride the mini-app *presentation* (tiles, per-app routes, per-app gating) but are
first-party code compiled into the host — **not** spec-073 registry packages. The reasons are
structural, not preferences (research R1): the registry has no private/role-gated visibility
anywhere; the `host` object exposes no authority; packages cannot import `frontend/src`, where
every admin lib lives; and publishing would put admin UI bytes on public IPFS behind a curator
review loop. Do not "finish the job" by converting these to packages — by the platform's own
criterion (shared file closure), they are disqualified the same way Wagers is.

## One source of truth: `adminApps.js`

`frontend/src/components/admin/adminApps.js` defines every app, its views, and each view's role
gate (`specs/093-admin-mini-apps/contracts/admin-app-config.md` is the normative contract). The
Control Room tiles, the per-app rails, the route guard, and the least-privilege tests all read
this module. **Never introduce a second app→view→gate mapping** — two matrices is how a nav gate
and a render gate drift apart. The gates are copied verbatim from the retired
`buildAdminNavGroups`; changing one is a role-model change needing its own spec.

Adding a view to an existing app: add the view descriptor (gate included) to `ADMIN_APPS`, render
it in that app's `renderView`, and `adminApps.test.js` will hold you to totality and gating.
Adding a new app: descriptor + screen component under `admin/apps/` + a lazy entry in
`AdminAppRoute.jsx`.

## The shell owns the chrome

`AdminAppShell` renders the header (back link, name, badge), the collapsible view rail, and
resolves `?view=`. It renders a view **only when that view's own gate passes** — the same
predicate the Control Room used to list the app — and redirects unentitled operators to
`/admin`. The entry gate (`useAdminAccess` + `AdminAccessGate`) keeps the monolith's three-way
distinction: granted / "Access Restricted" (a definite no) / "Could Not Verify Access" (no chain
answered — never dressed as a denial). All data hooks mount *behind* the gate: a denied account
fetches nothing.

The redirect waits for **`access.settled`**. It acts on the ABSENCE of a role flag, and entry can
be granted by the curator authority — one contract read — before the role sweep across the cohort
returns, leaving every flag momentarily false. Without that guard a deep link to an app the
operator *is* entitled to bounced them to the Control Room; `/admin/incident-response` doing that
mid-incident is the case that matters. See `chain-estate-reads.md` §3.

UI gating is presentation. The contracts' `onlyRole` checks are the security boundary; a
hand-typed URL past the matrix reaches nothing (the shell refuses render) and would be refused
on-chain regardless.

## Dashboards and the chart kit

Every app opens on a `dashboard` view (a reserved id, never a legacy tab). Charts come from
`admin/charts/`: `AdminSparkline`, `AdminBarList`, `AdminStatTile` — hand-rolled SVG/CSS on the
`--brand-primary` / chart tokens, no charting dependency. Their contract is honesty:

- `AdminStatTile` takes a spec-071 three-state `chainReadResult`; "zero because the read failed"
  has no code path. Unreadable renders as a sentence, never a number.
- `AdminBarList` prints every value as text (the bar is emphasis), renders **no** fill for a
  zero, and a `partial` annotation names the chains a distribution is missing.
- `AdminSparkline` renders an explicit empty state below two points — never an invented line —
  and its caption states which clock the x-axis carries (block numbers, usually).

Dashboards feed these from reads that already exist (fee estate, gateway status, catalog,
bounded event scans). No new indexing; a history source being down degrades that chart to its
labelled state while live state keeps rendering.

## Write semantics are unchanged

`useAdminTx` is the monolith's `runTx` verbatim (resolves `true`/`false`, never rejects — bulk
sequences observe the boolean), with one addition: an optional third argument, `{ errorAbi }`.
When a write fails with raw revert bytes the wallet never decoded, those fragments turn
"execution reverted (unknown custom error)" into the error's NAME (#1267). It is per **call**, not
per hook — one `runTx` is shared by apps that write to different contracts (Compliance drives both
the deny list and the mini-app registry), so the caller that knows which contract it is writing to
is the one that supplies the fragments. A revert ethers already decoded, or a failure a caller has
already turned into a sentence, is passed through untouched. Scope rules are untouched: `useScopedChain` seeds once and never
follows the wallet; `writeGateReason`'s four sentences stand, including "unreadable stays
permissive" for killswitches; membership writes stay pinned to `membershipChainId()`; incident
controls act on exactly one named chain, refused at the call site as well as the button, and
there is deliberately no control that acts on several chains at once.

## Acting as the admin Safe, signed by an owner's key

Every operator role on the live estate is held by the 2-of-3 admin Safe
(`deployments/admin-safe.json`: KMS + Ledger + Trezor), not by any key. The console used to ask
only what the CONNECTED key held and send every write from it, so an owner connecting their
Ledger was refused entry ("Access Restricted"), and any write would have reverted on a missing
role. `components/admin/adminActing/` separates the two things that were fused:

- **Acting account**: whose authority is used, either the Safe or the signing key itself. Entry,
  role flags, per-contract authority reads and "this account" labels follow it.
  `useAdminWeb3()` is `useWeb3()` with `account`/`signer` swapped for the acting ones. Admin apps
  read it instead of `useWeb3()`, which is why no write site changed. Outside the provider it IS
  `useWeb3()`. Maintenance stays on the wallet: its writes are permissionless, and routing them
  through the Safe would spend owner approvals on nothing.
- **Owner key**: who signs, either the connected wallet (an extension-connected Ledger is
  already this) or a Protect ▸ Off chain hardware account (spec 085 `HardwareSigner`), re-derived
  on the device and bound to the wallet's chain. The device session is memory-only and its
  transport is closed when dropped. The Safe choice is a device-local preference (a public
  address), never synced.

When acting as a Safe, the signer handed to the apps is `lib/admin/safeProposingSigner.js`. Its
`sendTransaction`:

1. **Simulates the call FROM the Safe**, so a write the Safe cannot make fails before the
   device is asked for anything.
2. **Publishes the preimage to the SafeProposalHub** (prompt 1) and waits for it to land.
3. **Records this owner's `approveHash`** (prompt 2).

The result is marked `proposed: true` and `useAdminTx` says "proposed, not applied", never the
success message. A 2-of-3 Safe has changed nothing until a second owner approves and someone
executes.

**Nonces.** The SafeProposalHub is PERMISSIONLESS. A verified preimage proves the hash
matches, not that any owner wants the proposal. So allocation walks up from the on-chain nonce
contiguously, and skips only two kinds of nonce: those held by an owner-endorsed proposal (at
least one current owner's approval) and those this session already reserved. A spam entry at
nonce 1,000,000 therefore cannot push admin actions out of reach. Allocation also refuses
(retryably) while the queue is loading, partial or failed.

**Before any device prompt** the signer checks two things on chain: that the Safe can make the
call, and that the signing key still `isOwner`. The device session closes when the console
unmounts, so a login changed elsewhere cannot reuse it.

**The Safe queue** (`AdminSafeQueue`, opened from the acting bar) is where the second owner
finishes the job. It uses the same `useVaultProposals` hook as Protect, which now takes an
optional `{ signer }` override for the device key. Each row has four parts:

- **The decoded action**: `lib/admin/describeAdminCall.js`. Role grants and revokes,
  upgrades, pause, treasury and intents-facet changes are recognised and flagged *Sensitive*.
  Anything else stays raw, never guessed.
- **The raw call underneath.**
- **The device check**: a device approving shows only `approveHash` on the Safe, with data
  `0xd4d9bdcd…<hash>`, so the row prints the hash tail to compare on screen.
- **The action buttons.** The owner whose approval reaches the threshold gets **Approve and
  execute** as ONE transaction. Safe v1.4.1 accepts a pre-validated signature from
  `msg.sender` itself.

The acting bar renders ABOVE the access gate (layout route `AdminActingLayout`), because an owner
whose key holds nothing is refused until they choose the Safe.

**Where it cannot run.** Proposals need a `safeProposalHub` with a recorded deploy block and a
Safe contract set (`config/safeContracts.js`). Ethereum mainnet (chain 1) has neither today, so
the console refuses there by name. Use the Safe's own tooling on chain 1.

## Discovery: the store's "Operator tools" section and Quick Access pins

Admin apps also surface in the Apps store (FR-013/FR-014 follow-up) so operators can find and pin
them — **derived client-side, never from the registry**:

- `components/admin/adminToolCatalog.js` adapts `buildAdminApps(flags)` into store entries and
  owns the favorite-id namespace (`admin-tool:<appId>`, disjoint from registry integer ids; the
  appId is recoverable from the id alone).
- `components/admin/useOperatorFlags.js` reads the role flags tolerantly (no provider / no roles
  ⇒ no section) and deliberately WITHOUT the curator registry read — the store must not add a
  network round-trip for every member. A curator holding nothing else reaches curation via
  `/admin`, which asks the registry properly.
- The section renders only when at least one tool is derived, never under the verified-market
  badge, and independently of registry status (an unreachable registry does not take the
  operator's own tools down).
- Pins ride the existing favorites store (`lib/miniapps/favorites.js`) and the drawer's capped
  pinned strip; admin tiles show their NavIcon glyph (no registry record ⇒ no store artwork) and
  route to `/admin/<appId>`. A pin is a device-scoped shortcut: revoking the role later leaves
  the pin pointing at the access gate's honest refusal, exactly like a typed URL.

## Tests that gate this surface

- `test/admin/adminApps.test.js` — matrix totality + per-flag gating (replaces `adminNav.test.js`).
- `test/admin/ControlRoom.test.jsx` — render-gate ≡ config-gate per single flag (replaces the
  raw-source `adminLeastPrivilege` diff), tile-status honesty.
- `test/admin/adminRoutes.test.jsx` — unknown-id redirect, `?view=` resolution, denied-at-depth,
  and no redirect while the sweep is still running.
- `test/admin/estateSweepClassification.test.js` — the sweep's read / not-deployed / unreadable
  classification, including the total-outage case that used to render as a denial.
- `cypress/e2e/fast/32-admin-console.cy.js` — the three-way entry gate, the three-state estate
  reads, and Maintenance's permissionless tile, answered at the RPC boundary (#1242).
- `test/admin/adminEstateGuard.test.js` — recursive scan: no admin file resolves a contract from
  the wallet's chain, no cross-chain sums.
- `test/admin/adminCharts.test.jsx`, `appDashboards.test.jsx` — three-state honesty + axe.
- `test/admin/adminActingSafe.test.jsx` — the proposing signer (simulate-from-Safe before any
  prompt, publish then approve, `proposed` wording), nonce reservation, the any-address role sweep,
  Safe-role entry, and the queue's decode / device-check / view-only / unreadable states.
- Screenshot record: `specs/093-admin-mini-apps/screenshots/` (actor-critic loop, harness at
  `scripts/ui/capture-admin-apps.mjs`).

See `specs/093-admin-mini-apps/` for the spec, plan, research, and parity audit.
