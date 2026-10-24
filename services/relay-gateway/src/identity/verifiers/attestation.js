/**
 * Device-attestation verifier (spec 106, FR-004) — A REGISTRATION SEAM THAT ALWAYS ABSTAINS.
 *
 * This file deliberately verifies nothing. It exists so that FR-004's extension point is REAL
 * rather than promised: adding hardware-rooted attestation later must be a verifier registration,
 * not a redesign of the resolver, the route table or any route handler. A seam nobody has ever run
 * a second implementation through is a claim, not a seam — so the third implementation ships now,
 * abstaining, and proves the shape holds for something that is not a bearer credential.
 *
 * WHY IT ABSTAINS RATHER THAN REFUSING. Returning `rejected` would mean "this caller presented an
 * attestation and it was bad", which is false for every caller today. `absent` means "I have nothing
 * to say about this request", which is true, and which the resolver folds away without affecting the
 * verdict. The distinction is the same one FR-009 turns on elsewhere: a verifier that cannot speak
 * must never be mistaken for one that said no.
 *
 * WHY IT IS NOT MERELY OMITTED. Registering it keeps the resolver's fan-out honest — `/status`
 * reports `attestation: "not-built"` rather than silently omitting a tier that the ladder declares.
 * "Not built" and "disabled" are different facts, and only one of them can be turned on.
 *
 * WHAT SHIPPING IT FOR REAL WOULD REQUIRE, so the next reader does not underestimate it: Apple App
 * Attest and Play Integrity verification server-side, publisher enrolment on both platforms (which
 * is operator-held), and a native bridge in the Capacitor shells — a new plugin, and therefore a
 * lockfile event under the monorepo's exact-pinning rules. None of that is in this feature.
 */

import { TIERS } from '../tiers.js'

export const KIND = 'attestation'

/**
 * @returns {{kind: string, outcome: 'absent', tierIfAccepted: string}}
 */
export function createAttestationVerifier() {
  return {
    kind: KIND,
    /** Configured-ness is a fact about the deployment; this one is a fact about the codebase. */
    state: 'not-built',
    async verify() {
      return { kind: KIND, outcome: 'absent', tierIfAccepted: TIERS.APP }
    },
  }
}
