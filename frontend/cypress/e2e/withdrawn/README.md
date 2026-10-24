# `cypress/e2e/withdrawn/`

Specs for surfaces that are **built, tested and still in the tree, but not currently offered to
members**. Every `describe` in here is guarded by the same constant that withdraws the surface, so
the suite reports as *pending* — never as passing.

It is a directory rather than a deletion because deleting a spec loses the harness work, and a
directory rather than a `full/` or `fast/` file because of two gates that would otherwise be made
to lie:

- `frontend/src/test/e2e-policy/coverageMatrix.test.js` requires every spec file under `fast/`,
  `full/` and `passkey/` to be cited by a matrix row. Citing a suite that cannot run would put
  test ids in the generated coverage document as evidence for a flow nothing exercises.
- `frontend/src/test/e2e-policy/tierSharding.test.js` proves each tier's shards partition exactly
  the specs on disk. A permanently-skipped file would occupy a shard and a weight for nothing.

Nothing here runs in CI: the shard splitters (`scripts/e2e/split-fast-tier.js`,
`scripts/e2e/split-full-tier.js`) enumerate `fast/`, `full/` and `passkey/` only. A bare
`cypress run` still picks the files up via `specPattern` and reports them pending, which is the
correct answer to "did this run?".

The matching matrix rows carry `status: "out-of-scope"` with a reason naming the constant and the
issue that restores it.

| Spec | Withdrawn by | Restored by | Guard |
|---|---|---|---|
| `41-group-settlement.cy.js` | #1441 | #1538 | `GROUP_PAY_ENABLED` (`frontend/src/lib/payments/groupPay.js`) |
