/**
 * Curator authority on the MiniAppRegistry (spec 073 T037 · FR-004, FR-022).
 *
 * The registry is the platform's supply-chain trust boundary: whoever holds
 * `APP_CURATOR_ROLE` decides which packages a member's browser is allowed to
 * execute. This module answers exactly one question — does THIS account hold
 * that role on THAT registry — and it asks the registry itself.
 *
 * ── WHY NOT THE APP-WIDE ROLE FLAGS ─────────────────────────────────────────
 * `useRoles()`'s booleans are resolved against the WagerRegistry / MembershipManager
 * role sets. `APP_CURATOR_ROLE` lives on neither, and — critically — it
 * **administers itself** (`_setRoleAdmin(APP_CURATOR_ROLE, APP_CURATOR_ROLE)`),
 * so the platform administrator cannot grant it and holding `DEFAULT_ADMIN_ROLE`
 * says nothing about holding it. Deriving curation from an admin flag would make
 * the separation the contract goes out of its way to create purely decorative in
 * the one place a human acts on it. This is the spec-067 `readRouterAuthority`
 * precedent — per-contract authority, asked of the contract that will enforce it
 * — applied to a role whose whole point is that no other role implies it.
 *
 * ── WHY THE OUTCOME IS DISCRIMINATED ────────────────────────────────────────
 * "You do not hold the curator role" and "we could not ask" are different
 * sentences, and only one of them is about the operator's grant. The console
 * already preserves that distinction at its front door (AdminPanel's "Could Not
 * Verify Access" vs "Access Restricted"), and a curation surface that collapsed
 * it would tell a curator during an RPC outage that their multisig grant had not
 * landed — sending them to look for a permissions problem that does not exist.
 * So there are five outcomes, not a boolean:
 *
 *   `not-deployed`  this build has no registry address on the registry chain
 *   `no-account`    nothing is connected, so there is nobody to ask about
 *   `unverified`    a registry exists and we could not read it (route or call failed)
 *   `held` / `not-held`  the registry answered
 *
 * `held` is true ONLY for the definite yes. A caller that reads `.held` and
 * nothing else fails closed on every uncertainty, which is the right default for
 * a write control; a caller that wants to be honest about WHY reads `.status`.
 *
 * ── WHY `getRoleAdmin` IS HERE TOO ──────────────────────────────────────────
 * The self-administration is the mechanism behind the guarantee, and a panel
 * that states it should be stating something it checked rather than something it
 * was told at design time. A deployment that came up without it (a hand-rolled
 * proxy init, a future migration) would still gate writes correctly and would
 * still be materially different from the documented design — so the panel reads
 * the admin role and says which of the two it is looking at.
 */
import { APP_CURATOR_ROLE, MINI_APP_REGISTRY_ABI } from '../../abis/miniAppRegistry'
import { miniAppChainId } from '../../config/networks'
import { getPublicClient } from '../chains/publicClient'
import { readContract } from '../chains/readContract'
import { miniAppRegistryAddress } from './registryClient'

/** Every outcome this module can return. Never a bare boolean — see the header. */
export const CURATOR_AUTHORITY = Object.freeze({
  /** No registry address is configured for this build's registry chain. */
  NOT_DEPLOYED: 'not-deployed',
  /** No account to ask about. A fact about the session, not about anyone's grant. */
  NO_ACCOUNT: 'no-account',
  /** A registry IS configured and the question could not be put to it. */
  UNVERIFIED: 'unverified',
  /** The registry answered: this account holds `APP_CURATOR_ROLE`. */
  HELD: 'held',
  /** The registry answered: this account does not hold it. A definite no. */
  NOT_HELD: 'not-held',
})

/** Why an `unverified` outcome happened, so a surface can be specific without guessing. */
export const UNVERIFIED_REASON = Object.freeze({
  /** No read route to the registry chain at all (no member endpoint, no build default). */
  NO_ROUTE: 'no-route',
  /** The call failed: RPC down, request rejected, wrong/undeployed bytecode at the address. */
  READ_FAILED: 'read-failed',
})

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Resolve chain + address + a reader, or the outcome explaining why not.
 *
 * No route is UNVERIFIED rather than not-deployed for the same reason it is in
 * `registryClient.resolveRegistry`: a registry that exists on a chain this build
 * currently has no route to is an unread registry, and reporting it as absent
 * would say the platform has no curation surface when it has one we cannot reach.
 */
function resolveRegistry() {
  const chainId = miniAppChainId()
  const registryAddress = miniAppRegistryAddress(chainId)
  if (!registryAddress) {
    return { outcome: { status: CURATOR_AUTHORITY.NOT_DEPLOYED, chainId, registryAddress: null } }
  }

  if (!getPublicClient(chainId)) {
    return {
      outcome: {
        status: CURATOR_AUTHORITY.UNVERIFIED,
        chainId,
        registryAddress,
        reason: UNVERIFIED_REASON.NO_ROUTE,
        error: new Error(`no read endpoint for chain ${chainId}, where the mini-app registry lives`),
      },
    }
  }

  const read = (functionName, args) =>
    readContract(chainId, { address: registryAddress, abi: MINI_APP_REGISTRY_ABI, functionName, args })
  return { chainId, registryAddress, read }
}

/**
 * Read `getRoleAdmin(APP_CURATOR_ROLE)` — which role may grant and revoke curation.
 *
 * Returned as its own outcome (rather than folded into a boolean) because an
 * unread admin role must not be rendered as "self-administration is not in
 * place": that would accuse a correctly deployed registry of a design flaw on
 * the strength of a timeout.
 *
 * `ok` is about the READ, not about anybody's authority — deliberately not one of the
 * {@link CURATOR_AUTHORITY} values, because reusing that enum here would let a caller mistake
 * "the admin role was legible" for "this account is a curator".
 *
 * @returns {Promise<{ok: boolean, chainId: number, registryAddress: string|null,
 *   roleAdmin: string|null, selfAdministering: boolean|null, reason: string|null, error: Error|null}>}
 */
export async function readCuratorRoleAdmin() {
  const resolved = resolveRegistry()
  if (resolved.outcome) {
    const { chainId, registryAddress, reason = null, error = null } = resolved.outcome
    return { ok: false, chainId, registryAddress, roleAdmin: null, selfAdministering: null, reason, error }
  }
  const { chainId, registryAddress, read } = resolved

  try {
    const roleAdmin = String(await read('getRoleAdmin', [APP_CURATOR_ROLE]))
    return {
      ok: true,
      chainId,
      registryAddress,
      roleAdmin,
      // Case-insensitive: the ABI decodes a lowercase `bytes32`, the constant is
      // written lowercase, and a comparison that could break on casing would
      // report a healthy registry as mis-wired.
      selfAdministering: roleAdmin.toLowerCase() === APP_CURATOR_ROLE.toLowerCase(),
      reason: null,
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      chainId,
      registryAddress,
      roleAdmin: null,
      selfAdministering: null,
      reason: UNVERIFIED_REASON.READ_FAILED,
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

/**
 * Does `account` hold `APP_CURATOR_ROLE` on this build's mini-app registry?
 *
 * Never throws: every failure is one of the outcomes above, because a curation
 * surface has to render SOMETHING and the one thing it must never render is a
 * definite denial it did not establish.
 *
 * The role-admin read rides along (one round trip's worth of extra latency, on a
 * surface that is already making a paged catalog read), but it is deliberately
 * NOT allowed to change the authority verdict: a failure there leaves
 * `roleAdmin: null` / `selfAdministering: null` while `status` still reports what
 * `hasRole` said. Letting a cosmetic disclosure read downgrade a definite yes to
 * "unverified" would withdraw a curator's controls over a sentence in the header.
 *
 * @param {{account?: string|null}} [args]
 * @returns {Promise<{status: string, held: boolean, verified: boolean, account: string|null,
 *   chainId: number, registryAddress: string|null, role: string,
 *   roleAdmin: string|null, selfAdministering: boolean|null,
 *   reason: string|null, error: Error|null}>}
 */
export async function readCuratorAuthority({ account } = {}) {
  const chainId = miniAppChainId()

  /** One shape for every outcome, so a caller has one object to destructure. */
  const outcome = (status, detail = {}) => ({
    status,
    // The ONLY place `held` is true. Every uncertainty fails closed here and is
    // explained by `status` rather than by a second boolean nobody reads.
    held: status === CURATOR_AUTHORITY.HELD,
    verified: status === CURATOR_AUTHORITY.HELD || status === CURATOR_AUTHORITY.NOT_HELD,
    account: typeof account === 'string' ? account : null,
    chainId,
    registryAddress: null,
    role: APP_CURATOR_ROLE,
    roleAdmin: null,
    selfAdministering: null,
    reason: null,
    error: null,
    ...detail,
  })

  if (typeof account !== 'string' || !ADDRESS_RE.test(account)) {
    // Checked BEFORE the registry is resolved: with nobody connected there is no
    // question to put, and "not-deployed" would misreport a build that is fine.
    return outcome(CURATOR_AUTHORITY.NO_ACCOUNT, { account: null })
  }

  const resolved = resolveRegistry()
  if (resolved.outcome) {
    const { status, registryAddress, reason = null, error = null } = resolved.outcome
    return outcome(status, { registryAddress, reason, error })
  }
  const { registryAddress, read } = resolved

  let held
  try {
    held = await read('hasRole', [APP_CURATOR_ROLE, account])
  } catch (error) {
    return outcome(CURATOR_AUTHORITY.UNVERIFIED, {
      registryAddress,
      reason: UNVERIFIED_REASON.READ_FAILED,
      error: error instanceof Error ? error : new Error(String(error)),
    })
  }

  // Disclosure only (see above): read after the verdict and never able to change it.
  let roleAdmin = null
  let selfAdministering = null
  try {
    roleAdmin = String(await read('getRoleAdmin', [APP_CURATOR_ROLE]))
    selfAdministering = roleAdmin.toLowerCase() === APP_CURATOR_ROLE.toLowerCase()
  } catch {
    // Left null: unknown, which is what the panel will say.
  }

  return outcome(held ? CURATOR_AUTHORITY.HELD : CURATOR_AUTHORITY.NOT_HELD, {
    registryAddress,
    roleAdmin,
    selfAdministering,
  })
}
