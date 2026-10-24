# Specification Quality Checklist: Gateway Caller Authentication and Abuse Prevention

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-04
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified
- [x] Open questions have a named owner and a resolution path

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Validation Notes

**Zero clarification markers.** The three decisions that would otherwise have been
`[NEEDS CLARIFICATION]` were settled before drafting:

1. *Anonymous read access* — preserved and metered, rather than walled behind authentication.
2. *Interactive challenge and its content-policy cost* — accepted as a single named host, pinned as a
   justified exception so the scheme-wide prohibition stays enforced.
3. *Device attestation* — designed for via an extensible tier, built in a follow-up.

**Vendor names deliberately absent from requirements.** The challenge provider and the two mobile
attestation services are named nowhere in the functional requirements or success criteria — they appear
only as assumptions and dependencies. The requirements bind on *what must be proven*, so substituting a
provider is a planning decision, not a specification change.

**Existing controls are named in Context only.** The Context section names the current origin-lock
header because the specification's entire premise is that this control is widely mistaken for caller
authentication. Naming it is problem definition, not an implementation choice for the new work.

**Constitution alignment**:

- *Honest State (III)* — carried by FR-005 (never claim proof-of-app on the web), FR-009 and FR-017
  (unverifiable is never a denial), FR-015 (disabled is never indistinguishable from absent), FR-028
  (degraded reads disclose rather than render partial as complete), and FR-034 (a value exists only in
  the `read` state; partial totals name what is missing).
- *Fail Loudly in CI (IV)* — carried by FR-018 (the content-policy exception is pinned by an automated
  check), FR-019 (policy parity), and FR-026 (unverified second-factor enforcement refuses rather than
  passes).
- *Test-First (II)* — every success criterion is stated so it can be driven by a failing test first,
  including the negative fixtures in SC-009a, SC-012, SC-016 and SC-018.
- *Simplicity (workflow 4)* — the chosen keyed-access mechanism is the one that adds no traffic path;
  the two rejected alternatives are recorded with the reason, so the choice can be revisited without
  being re-derived.

## Keyed data access: decision record

The scope grew after the first draft. The original spec treated client-visible credentials as already
solved; that is true of every value in the bundle today, but not of the keyed read capacity the product
needs and does not yet publish. Three mechanisms were compared:

| | Credential in browser | Rotate / add a chain | Read traffic path |
|---|---|---|---|
| Publish a restricted endpoint | permanent | **frontend release** | direct |
| **Issue expiring credentials (chosen)** | expiring, read-only | server-side config | direct |
| Proxy reads through the platform | never | server-side config | **through platform** |

Publishing was rejected on rotation cost, and because the provider states its referrer restriction is
bypassable by any non-browser client. Proxying was rejected because read traffic is the product's
heaviest — a multi-chain portfolio screen fans out across every supported chain — and routing it
through platform infrastructure would put a capacity ceiling and a round trip on every screen. It
remains the fallback if the residual below is judged unacceptable, and it is recorded in the spec's
assumptions rather than discarded.

**The residual is stated in the spec rather than hidden**: the client holds the endpoint and its
expiring credential, and both are readable from a browser for that credential's lifetime. The design
bounds theft rather than preventing it. This is why FR-026 exists — the endpoint address alone must
never suffice, so an endpoint whose second-factor enforcement cannot be positively verified is refused.

## Resolved before planning

**Provider plan tier — CLOSED 2026-09-04.** Expiring-credential authentication and provider-side
operation restriction are paid-tier features and the repository recorded neither. The operator
confirmed from the provider dashboard that expiring-credential authentication is enabled on the
account, which places the platform on a tier carrying both. FR-023 and FR-026 have a mechanism; the
chosen design stands and the proxy alternative remains recorded as a fallback rather than a necessity.

It was tracked as a named open assumption with an owner rather than a `[NEEDS CLARIFICATION]` marker,
because it was a fact to be looked up, not a decision to be made.

**What confirming it did not settle.** Availability on the account is not enforcement on an endpoint.
FR-026 verifies enforcement per endpoint at the moment access is served, and treats unverifiable as
disabled — because an endpoint with enforcement off looks identical in every log to one with it on,
and the whole safety of transmitting an endpoint address rests on that address being insufficient
alone. The tier confirmation removed the mechanism risk and none of the configuration risk. No
requirement was relaxed as a result of this answer.

**Never-stranded rule** is explicit at both requirement and outcome level (FR-010, SC-007): no control
in this feature may prevent a member from acting independently, and none may trap member value.
