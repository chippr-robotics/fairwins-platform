# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records (ADRs) for the ClearPath & FairWins prediction market platform. ADRs document significant architectural decisions, their context, and their consequences.

## What is an ADR?

An Architecture Decision Record (ADR) captures an important architectural decision made along with its context and consequences. ADRs help teams:

- Understand why certain decisions were made
- Provide context for future architectural changes
- Document the evolution of the system architecture
- Facilitate knowledge transfer to new team members

## What Belongs in an ADR?

ADRs should document **significant architectural decisions** such as:
- Technology stack choices (frameworks, libraries, tools)
- Architectural patterns and system design
- Security infrastructure and approaches
- Data storage and management strategies
- Integration and API design decisions

ADRs should **NOT** include:
- Implementation guides (use `docs/active_build/`)
- Operational runbooks (use `docs/runbooks/`)
- User documentation (use `docs/user-guide/`)
- Detailed API references (use `docs/reference/`)

## ADR Format

Each ADR follows a consistent structure:
- **Title**: Concise description of the decision
- **Status**: Proposed, Accepted, Deprecated, or Superseded
- **Context**: The problem or requirement driving the decision
- **Decision**: The chosen solution and rationale
- **Consequences**: Impact, trade-offs, and implications

## ADR Index

### Active ADRs

| ADR | Title | Status | Date | Category |
|-----|-------|--------|------|----------|
| [001](./001-trail-of-bits-toolchain.md) | Adoption of Trail of Bits Security Testing Toolchain | Accepted | 2024-06-15 | Security |
| [002](./002-integration-testing-strategy.md) | Integration Testing Strategy for E2E Workflows | Accepted | 2025-12-23 | Testing |
| [003](./003-xwing-post-quantum-encryption.md) | X-Wing Post-Quantum Encryption for Private Markets | Accepted | 2026-01-24 | Security |
| [004](./004-upgradeable-registry-uups.md) | Upgradeable contracts via UUPS proxies | Accepted | 2026-06-20 | Architecture |
| [005](./005-remove-unused-x3dh-messaging-layer.md) | Remove the unused X3DH/Double-Ratchet messaging layer | Accepted | 2026-06-22 | Security |
| [006](./006-dependency-version-policy.md) | Dependency version policy: selection, holds, detection, review | Accepted | 2026-10-09 | Supply chain |

### Superseded ADRs

None yet.

## Related Documentation

### Active Build Documentation (`docs/active_build/`)
Current implementation work and technical specifications:
- [Scalability Architecture](../active_build/scalability-architecture.md) - System scaling design and implementation
- [Implementation Summary](../active_build/scalability-implementation.md) - Current phase results and status

### Operational Runbooks (`docs/runbooks/`)
Step-by-step operational guides:
- [Batch Operations](../runbooks/batch-operations.md) - Integration guide for batch processing APIs

### Other Documentation
- [Security Testing](../security/) - Detailed testing procedures and tools
- [Developer Guide](../developer-guide/) - Setup and contribution guidelines
- [System Overview](../system-overview/) - Architecture and design overview

## How to Create a New ADR

1. Create a new file in this directory with the format: `NNN-title-with-dashes.md`
   - Use the next available number (e.g., `002-your-decision.md`)
   - Use lowercase with dashes for the title
   - Focus on **architectural decisions**, not implementation details

2. Use this template structure:

```markdown
# ADR NNN: Title of Decision

**Status**: Proposed | Accepted | Deprecated | Superseded by [ADR-XXX]

**Date**: YYYY-MM-DD

**Deciders**: List of people involved in the decision

**Technical Story**: Link to issue/ticket if applicable

## Context

What is the architectural issue or problem that we're addressing? 
What factors influenced this decision?

## Decision

What architectural change are we proposing/doing?
What technology, pattern, or approach are we adopting?

## Rationale

Why did we choose this approach?
What alternatives did we consider?

## Consequences

What becomes easier or more difficult because of this architectural decision?

### Positive

- List of benefits and improvements

### Negative

- List of drawbacks and trade-offs

### Neutral

- Other implications or considerations

## Implementation

High-level approach to implementing this decision.
(Detailed implementation goes in docs/active_build/)

## References

- Links to related documents, tools, or external resources
```

3. Update this README to include your new ADR in the index

4. Get the ADR reviewed and approved before marking it as "Accepted"

## Contributing

When making significant architectural changes:

1. Create a new ADR following the template
2. Focus on the "why" not the "how" (how goes in docs/active_build/)
3. Discuss with the team before implementation
4. Update this README with the new ADR
5. Mark as "Proposed" until team consensus
6. Update to "Accepted" after decision is finalized
7. Link to implementation documentation in docs/active_build/

## Questions?

For questions about ADRs or architectural decisions, contact the development team or refer to:
- [Developer Guide](../developer-guide/architecture.md)
- [System Overview](../system-overview/how-it-works.md)
- [Contributing Guidelines](../developer-guide/contributing.md)
