/**
 * Active tenant resolution (spec 072).
 *
 * The tenant manifest (tenants/<id>/manifest.json at the repo root) is the
 * single source of truth for a tenant's identity, settings, and contract set.
 * Selection is BUILD-TIME: VITE_TENANT_ID picks the manifest (default
 * "fairwins", the tenant that reproduces today's FairWins product). One served
 * origin is one tenant — there is deliberately no runtime tenant switching
 * (spec 072 FR-007), so a built instance physically contains only its own
 * tenant's identity.
 *
 * An unknown tenant id fails the BUILD (the tenant-branding Vite plugin throws
 * while resolving the virtual module) — it must never silently fall back to
 * another tenant's identity.
 *
 * Only the active tenant's manifest exists in the bundle: `virtual:tenant` is
 * provided by frontend/vite-plugins/tenant-branding.js and injects exactly one
 * manifest. A built instance physically contains no other tenant's identity
 * (spec 072, research D2) — which is also why resolveTenant() can only answer
 * for the active tenant.
 */

import { activeTenantManifest, featureCatalog, tenantContractSets } from 'virtual:tenant'

export const DEFAULT_TENANT_ID = 'fairwins'

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

const ACTIVE_TENANT = deepFreeze(activeTenantManifest)
const FEATURE_CATALOG = deepFreeze(featureCatalog ?? [])
const CONTRACT_SETS = deepFreeze(tenantContractSets ?? {})

/**
 * Resolve a tenant id to its manifest. Only the active tenant is present in
 * this build (one origin = one tenant, FR-007); any other id throws.
 */
export function resolveTenant(tenantId) {
  if (tenantId !== ACTIVE_TENANT.id) {
    throw new Error(
      `[tenant] unknown tenant id "${tenantId}" — this build serves only "${ACTIVE_TENANT.id}" ` +
        '(one origin = one tenant, spec 072 FR-007). Build with VITE_TENANT_ID=<id> after authoring ' +
        'tenants/<id>/manifest.json and running `npm run tenants:validate`.'
    )
  }
  return ACTIVE_TENANT
}

/** The full frozen manifest of the tenant this build serves. */
export function getActiveTenant() {
  return ACTIVE_TENANT
}

export function getActiveTenantId() {
  return ACTIVE_TENANT.id
}

export function isDefaultTenant() {
  return ACTIVE_TENANT.id === DEFAULT_TENANT_ID
}

/** Identity + brand for member-visible surfaces (names, logos, PWA, share frames). */
export function tenantBrand() {
  return {
    id: ACTIVE_TENANT.id,
    displayName: ACTIVE_TENANT.identity.displayName,
    tagline: ACTIVE_TENANT.identity.tagline ?? '',
    appUrl: ACTIVE_TENANT.identity.appUrl,
    docsUrl: ACTIVE_TENANT.identity.docsUrl ?? null,
    copyrightNotice: ACTIVE_TENANT.identity.copyrightNotice ?? ACTIVE_TENANT.identity.legalName ?? ACTIVE_TENANT.identity.displayName,
    logo: ACTIVE_TENANT.brand.logo,
    logoMark: ACTIVE_TENANT.brand.logoMark,
    favicon: ACTIVE_TENANT.brand.favicon,
    pwa: ACTIVE_TENANT.brand.pwa,
    htmlTitle: ACTIVE_TENANT.brand.htmlTitle ?? ACTIVE_TENANT.identity.displayName,
  }
}

/** Support/social/legal links for footers, entry gates, and docs surfaces. */
export function tenantLinks() {
  return {
    support: ACTIVE_TENANT.identity.support ?? {},
    social: ACTIVE_TENANT.identity.social ?? {},
    legal: ACTIVE_TENANT.identity.legal ?? {},
  }
}

/**
 * The tenant's raw theme tokens (`brand.theme` — base/light/dark blocks of CSS
 * custom properties). Surfaces that cannot consume CSS variables — the PDF
 * statement renderer, for one — read the values from here so a tenant still
 * brands them from the manifest alone.
 */
export function tenantThemeTokens() {
  return ACTIVE_TENANT.brand.theme
}

/** Feature ids this tenant enables (validated subset of tenants/features.json). */
export function tenantFeatures() {
  return ACTIVE_TENANT.settings.features
}

/**
 * Whether a feature surface should exist in this tenant's instance. A disabled
 * feature is absent from nav/routes — never present-but-broken.
 */
export function isFeatureEnabled(featureId) {
  return ACTIVE_TENANT.settings.features.includes(featureId)
}

/** The known feature catalog (for admin/validation surfaces). */
export function knownFeatureIds() {
  return FEATURE_CATALOG
}

/**
 * The tenant's assistant settings block (spec 104), or `{}`.
 *
 * The block is OPTIONAL and no tenant ships one today, so every read of it has to survive its
 * absence — which is why this returns an object rather than letting a caller reach through
 * `settings.assistant.x` and throw on a manifest that never declared it. The only member today is
 * `guttertokenReferralCode`, a public identity value (never a credential) that the schema
 * constrains to `^[A-Za-z0-9_-]{1,64}$` because it is interpolated into a URL.
 *
 * @returns {{guttertokenReferralCode?: string}}
 */
export function tenantAssistantSettings() {
  const assistant = ACTIVE_TENANT.settings?.assistant
  return assistant && typeof assistant === 'object' && !Array.isArray(assistant) ? assistant : {}
}

/**
 * Chain ids the tenant enables for a cohort ('mainnet' | 'testnet'). Callers
 * must still intersect with the build cohort rules (spec 071) — a tenant list
 * never crosses the testnet/mainnet boundary.
 */
export function tenantChainIds(cohort) {
  const chains = ACTIVE_TENANT.settings.chains
  if (cohort !== 'mainnet' && cohort !== 'testnet') {
    throw new Error(`[tenant] unknown cohort "${cohort}" — use 'mainnet' or 'testnet'`)
  }
  return chains[cohort]
}

/**
 * The platform CSS class for the active tenant, consumed by ThemeContext and
 * the pre-hydration script contract (theme-<mode> + platform-<id> on <html>).
 * The default tenant's tokens live statically in theme.css; non-default
 * tenants get theirs injected by src/theme/tenantTheme.js.
 */
export function tenantThemeClass() {
  return `platform-${ACTIVE_TENANT.id}`
}

/**
 * Contract-set mode: 'shared' fronts the platform estate (existing
 * config/contracts.js resolution unchanged); 'dedicated' resolves ONLY the
 * tenant's own generated set (frontend/src/config/tenants/<id>.contracts.json,
 * written by sync-frontend-contracts --tenant and injected via virtual:tenant).
 */
export function tenantContractMode() {
  return ACTIVE_TENANT.contractSet.mode
}

export function isDedicatedTenant() {
  return ACTIVE_TENANT.contractSet.mode === 'dedicated'
}

/**
 * The active tenant's address record for a chain — DEDICATED tenants only.
 * Returns undefined for shared-mode tenants (callers fall through to the
 * shared estate's maps) AND for chains absent from a dedicated tenant's set
 * (absence stays absence — a dedicated tenant never resolves the shared
 * estate's addresses, spec 072 FR-003/D6).
 */
export function tenantContractsForChain(chainId) {
  if (!isDedicatedTenant()) return undefined
  return CONTRACT_SETS[chainId] ?? CONTRACT_SETS[String(chainId)]
}
