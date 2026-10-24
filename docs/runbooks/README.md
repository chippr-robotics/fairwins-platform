# Operational Runbooks

This directory contains step-by-step operational guides, integration procedures, and runbooks for using and maintaining the platform.

## Contents

### Operating the platform
- **[operations-control-plane.md](./operations-control-plane.md)** - The operator console at `/admin`: every group and view, role gates, step-by-step how-tos, and troubleshooting
- **[operator-onboarding.md](./operator-onboarding.md)** - Operator personas and responsibilities, role grant/verification procedure, offboarding
- **[relayer-operations.md](./relayer-operations.md)** - Gasless intent relayer (spec 036): gateway/engine components, hot-key management, killswitch, OpenSea/Polymarket proxy ops, incident table
- **[paymaster-operations.md](./paymaster-operations.md)** - Sponsored-gas paymaster (spec 050): deposit funding and runway, monitoring, killswitch, signer rotation, compromise response
- **[callsigns-operations.md](./callsigns-operations.md)** - Deploy the `%callsign` naming registry, wire the frontend, grant operator roles, and moderate / tune / monitor it from the control plane (spec 054)
- **[perps-operations.md](./perps-operations.md)** - Perps fee rails (spec 083): the GMX UI fee on Arbitrum and the Hyperliquid builder fee on the Polygon FeeRouter, the Gains referral, the management feature flag and its legal prerequisite, venue/stuck-order incident playbook
- **[miniapp-registry-operations.md](./miniapp-registry-operations.md)** - Mini-app catalog curation (spec 073): verifying a submitted package before approval, the content-committed `approveApp`, suspend/reinstate/deprecate, gateway config, curator-role handoff, diagnostics
- **[member-api-operations.md](./member-api-operations.md)** - Member API, assistant, and MCP server (spec 095): enabling the module and the assistant, the assistant API key and its `fetch-secrets.sh` delivery, the two killswitches, what revocation does and does not survive, incident playbook, honest-state verification
- **[keyed-rpc-access.md](./keyed-rpc-access.md)** - Keyed RPC access (spec 107): verifying issuance, reading each refusal literally (a `404` means the old image, not an unserved chain), the four invariants and how to prove each, rotating the signing key by succession (it rides a release — SIGHUP cannot flip the kid), and the killswitch's known non-durability (#1495)
- **[contract-upgrades.md](./contract-upgrades.md)** - UUPS proxy upgrade procedure: storage-layout gate, in-place upgrades, rollback
- **[credential-rotation.md](./credential-rotation.md)** - Every credential the estate holds and what breaks when it is wrong: the rotation matrix, the two version-pinned secrets that need a code change, the connected-systems inventory, and why a new secret version does nothing until the stack restarts

### Deploy
- **[relayer-mordor-deploy.md](./relayer-mordor-deploy.md)** - First bring-up of the relayer stack on Mordor: GCP prerequisites, KMS keys, Cloud Run, origin lock, validation
- **[vm-migration.md](./vm-migration.md)** - Cutover + rollback for moving the bundler and relay gateway off Cloud Run onto two GCE VMs: the single-executor invariant, the `cloudbuild.yaml` trap in both directions, functional verification, soak, decommission, and what the move gives up
- **[zk-wager-pools-deploy.md](./zk-wager-pools-deploy.md)** - WagerPoolFactory (spec 034) append-only deploy, wiring matrix, subgraph publish
- **[safe-proposal-hub-deploy.md](./safe-proposal-hub-deploy.md)** - SafeProposalHub (spec 043) events-only helper deploy

### Integration & user-facing procedures
- **[batch-operations.md](./batch-operations.md)** - Complete integration guide for batch processing APIs with examples in JavaScript, Python, and React
- **[passkey-account-recovery.md](./passkey-account-recovery.md)** - End-user recovery paths for passkey smart-wallet accounts

The full inventory of administrative control surfaces (on-chain, service, and
frontend) and the gap analysis behind the control plane's structure live in
[docs/system-overview/control-surface-audit.md](../system-overview/control-surface-audit.md).

## Purpose

Runbooks provide:
- **Step-by-step procedures** for common operations
- **Integration examples** with code samples
- **API usage guides** for developers
- **Troubleshooting procedures** for common issues
- **Deployment checklists** and operational procedures

## Structure

Each runbook should include:
1. **Overview** - What the procedure accomplishes
2. **Prerequisites** - Required setup and dependencies
3. **Step-by-Step Instructions** - Detailed procedures
4. **Code Examples** - Working sample code
5. **Troubleshooting** - Common issues and solutions
6. **References** - Links to related documentation

## Related Documentation

- **ADRs** ([docs/adr/](../adr/)) - Architectural decisions behind these procedures
- **Active Build** ([docs/active_build/](../active_build/)) - Current implementation work
- **Developer Guide** ([docs/developer-guide/](../developer-guide/)) - General development setup

## Contributing

When creating new runbooks:
1. Use clear, imperative language ("Do X", not "You should do X")
2. Include working code examples
3. Test all procedures before documenting
4. Keep procedures focused on a single task
5. Update this README when adding new runbooks
