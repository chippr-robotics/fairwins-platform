# FairWins Architecture Workbook

> **Status:** living document. Generated from a full-repository sweep at
> `staging` commit `57676112` (2026-09-11) and maintained against it.
> Every factual claim in this workbook carries a `path:line` citation into
> the repository. Where a fact could not be established from the code, the
> workbook says so rather than guessing.

## Why this workbook exists

`docs/developer-guide/architecture.md` describes FairWins as "three
deployable pieces … with **no application backend**". That was true once.
It is not true now: the platform runs a policy gateway, a bundler estate,
an exporter, and a set of VM-hosted services, across two repositories and a
shared GCP project. This workbook is the current, whole-system picture, and
it is organised as the three standard architecture views so that a reader
can enter at the altitude they need:

| View | Question it answers | Page |
|---|---|---|
| **Logical** | What does the platform do, for whom, and under what rules? | [01-logical-view.md](01-logical-view.md) |
| **Architectural** | What are the components, and what are the seams between them? | [02-architecture-view.md](02-architecture-view.md) |
| **Systems** | Where does it physically run, and along which network paths? | [03-systems-view.md](03-systems-view.md) |

Six reference annexes carry the detail the views point at:

| Annex | Contents | Page |
|---|---|---|
| **04 Connectors & ports** | Every connector crossing a process boundary; every listening socket, bind address, firewall rule and egress path | [04-connectors-and-ports.md](04-connectors-and-ports.md) |
| **05 Cryptographic BOM** | Curves, EIP-712 domains, KDFs, key-material inventory, library pins, risk register | [05-cryptographic-bom.md](05-cryptographic-bom.md) |
| **06 External vendors** | Every third-party dependency, auth model, data exposure, commercial direction | [06-external-vendors.md](06-external-vendors.md) |
| **07 On-chain estate** | Every contract, proxy, facet, role, chain, and the external protocols called but not owned | [07-onchain-estate.md](07-onchain-estate.md) |
| **08 Spec index** | Every numbered spec directory → the capability it delivers | [08-spec-index.md](08-spec-index.md) |
| **09 Findings & drift** | Where the docs, the code and the deployed estate disagree, and what is load-bearing but unguarded | [09-findings-and-drift.md](09-findings-and-drift.md) |

An [executive summary](00-executive-summary.md) states the architecture and
its controls in review-board register, for readers who will not read the body.

## Diagram sources

`diagrams/` holds editable draw.io XML. Open with [app.diagrams.net](https://app.diagrams.net)
or the draw.io desktop app; the `.drawio` file is the source of truth and the
mermaid blocks in the markdown pages are the rendered-in-docs equivalent.

| File | View |
|---|---|
| `diagrams/logical-view.drawio` | Actors, capability map, domain entities, the twenty invariants |
| `diagrams/architecture-view.drawio` | Components, seams, the on-chain estate |
| `diagrams/systems-view.drawio` | Deployment and network topology |
| `diagrams/trust-boundaries.drawio` | The seven trust boundaries and the control enforcing each |

## How to keep it true

**Read [09](09-findings-and-drift.md) before trusting any other page's optimism.**
The sweep that produced this workbook found places where the documentation, the
code and the deployed estate disagree; they are catalogued rather than smoothed
over, because a workbook that reads cleaner than the system is worse than none.

This workbook is descriptive, never authoritative — the code and the CI
gates decide. When the two disagree, the code is right and this document is
a bug. It is deliberately **not** wired into a CI gate: a gate that could
fail on prose would be a gate nobody could fix, and the repository already
carries the enforcement that matters (spec registry, storage layout,
bytecode digests, CBOM-adjacent dependency pins, FinOps catalogue).
