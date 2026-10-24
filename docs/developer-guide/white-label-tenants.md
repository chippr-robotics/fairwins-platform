# White-Label Tenants

The platform is delivered as **tenant instances** (spec 072): each tenant (customer)
runs its own branded instance with its own configuration and — for tenants that need
asset isolation — its own contract deployments. The FairWins instance is the
**default tenant** (`tenants/fairwins/manifest.json`).

Full design: `specs/072-white-label-tenants/` (spec, plan, research D1–D11, data-model,
quickstart, tasks).

## The tenant manifest is the single source of truth

`tenants/<tenant-id>/manifest.json` describes one tenant: identity (name, domains, brand
assets, theme tokens), settings (features, chains, membership tier pricing, fee bps),
and contract set (`shared` | `dedicated`). Rules:

- **Never hardcode a tenant identity value the manifest defines.** Member-visible
  names, logos, URLs, PWA metadata, share text, and support/legal links resolve through
  `frontend/src/config/tenant.js`.
- **No secrets.** Manifests are public config, baked into client bundles.
- `npm run tenants:validate` enforces structure, cross-manifest domain uniqueness, fee
  caps, cohort separation, and dedicated-mode record presence. CI gates on it
  (`tenant-manifests` job in `.github/workflows/test.yml`).

## Frontend

- **Selection is build-time**: `VITE_TENANT_ID` picks the manifest (default
  `fairwins`). One origin = one tenant; there is no runtime tenant switching, so a
  built instance physically contains only its own tenant's identity. An unknown id
  throws at module init — absence never falls back to another tenant.
- `frontend/src/config/tenant.js` exposes `getActiveTenant()`, `tenantBrand()`,
  `tenantLinks()`, `isFeatureEnabled(id)`, `tenantChainIds(cohort)`,
  `tenantThemeClass()`, `tenantContractMode()`.
- **Theming rides the existing `platform-*` seam**: the default tenant's tokens stay
  static in `frontend/src/theme.css`; non-default tenants get an equivalent
  `.platform-<id>` rule set generated from their manifest and injected by
  `frontend/src/theme/tenantTheme.js`. `ThemeContext` applies
  `platform-<activeTenantId>` and persists `themePlatform` for the pre-hydration
  script.
- Feature gating: a feature absent from `settings.features` must be absent from
  nav/routes — never present-but-broken.
- **Assistant providers (spec 104).** Two feature ids and one optional settings block govern the
  member assistant:
    - `assistant` — the assistant itself and the **Tools ▸ Assistant** tab that hosts its
      preferences and the API access console. Members still opt in individually.
    - `assistant-byok` — offers the **GutterToken (your credits)** provider: the member pastes their
      own GutterToken `sk-…` key (stored on their device only, wallet-scoped, never backed up) and
      their browser calls `api.guttertokens.com` directly. The tenant is not in that request path,
      sees no message content and charges nothing for it. **Requires `assistant`** (the validator
      refuses `assistant-byok` without it — it is a radio inside the Assistant card, not a surface).
      A tenant that wants the assistant on its membership-funded rail only simply leaves this out.
      `fairwins` enables both.
    - `settings.assistant.guttertokenReferralCode` — **optional** string, `^[A-Za-z0-9_-]{1,64}$`,
      delivered as `https://app.guttertokens.com/signup?ref=<code>` (it prefills GutterToken's
      referral field) from the **Get a key** link on the Assistant card. Absent means the plain link; present, the card discloses in words that the
      tenant receives GutterToken credit when a member funds an account through it. The validator
      refuses a code on a tenant that does not enable `assistant-byok` (dead config that would still
      read as a live referral arrangement in the FinOps catalogue, entry `referral-guttertoken`).
      It is an identity value like any other manifest field: public, never a credential, and never
      hardcoded in a shipped path — resolve it through `getActiveTenant().settings.assistant`.
      No code is registered for `fairwins` yet, so its manifest carries no `settings.assistant`
      block.

## Contract isolation (dedicated tenants)

- Isolation for value-bearing state is **on-chain, by separate proxy instances** of the
  audited implementations — never by a frontend/gateway filter alone. v1 ships zero
  Solidity changes.
- Deploys reuse the deterministic CREATE2 flow: setting `TENANT_ID=<id>` on the
  existing deploy scripts prefixes salts (`tenant:<id>:…`) and writes records to
  `deployments/tenants/<id>/<network>-chain<chainId>-v2.json` (same schema as the
  shared records). `TENANT_ID` unset — or `fairwins` — is the shared estate,
  byte-identical to before.
- **A tenant id is immutable once deployed** (salts derive from it).
- A dedicated tenant resolves ONLY its own contract set; a contract absent from the
  set on a chain reads as not-deployed for that tenant there. No silent fallback to
  the shared estate, ever. The set is generated:
  `node scripts/utils/sync-frontend-contracts.js --tenant <id> --network <n> --chainId <c>`
  merges the tenant's record into `frontend/src/config/tenants/<id>.contracts.json`,
  which the tenant-branding plugin injects via `virtual:tenant`;
  `getContractAddress`/`getContractAddressForChain` consult it before (instead of) the
  shared maps whenever `isDedicatedTenant()`. A **live** dedicated tenant with no
  generated set fails the build.
- Per-tenant gateway: run a relay-gateway instance against the tenant's deployment
  records — its startup allowlist (spec 036 FR-025) then *is* the tenant scoping.

## Lifecycle

`draft → live ⇄ suspended → retired`, changed by PR (git history is the audit trail).
Suspension never traps value: contracts don't know about suspension; members keep the
documented direct-claim path. Shared-mode ("branding-only") tenants have cosmetic
isolation only — this must be disclosed to the tenant, and graduation to dedicated
contracts preserves claimability of positions opened on the shared estate.

## Native channels (spec 102)

A tenant gets iOS/Android apps by adding the OPTIONAL `native` block to its
manifest (`tenants/<id>/manifest.json`; schema in `tenants/manifest.schema.json`):

```jsonc
"native": {
  "ios":     { "appId": "app.<tenant>.member" },   // bundle identifier
  "android": { "appId": "app.<tenant>.member" },   // application id
  "displayName": "<Home-screen name>",
  "iconSource": "icons/native/"
}
```

Rules, all gated: appIds are reverse-DNS and globally unique ACROSS tenants
(the same tenant may reuse one id on both platforms); an absent block means
NO native channel — a native build for that tenant fails naming it, never
borrowing another tenant's identity; the associated domain (passkey RP +
universal links) is the tenant's `identity.domains[0]`, synced into both
shells by `scripts/native/sync-native-config.js --tenant <id>`.

Onboarding beyond the manifest is the OPERATOR ceremony — store records under
the tenant's appIds, association files generated per tenant
(`scripts/native/generate-association-files.js --tenant <id> …`) and served
from the TENANT's origin, and its own support-floor document. See
`docs/runbooks/native-release-operations.md` and
`docs/developer-guide/native-channels.md`.
