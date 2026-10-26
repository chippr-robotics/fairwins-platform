# Coverage restore & audit-gate toolchain

Tooling for spec **046-contract-audit-coverage** — restores a trustworthy contract
coverage measurement and enforces tiered thresholds on the security-critical set.

## Pipeline

```text
hardhat coverage            → instruments contracts, runs all non-fork suites
  (COVERAGE=true, TZ=UTC)      with coverage-scoped block-gas headroom (hardhat.config.js)
        │
        ▼
.solcover.js                → istanbulReporter [json-summary, lcov, text]
        │                       produces coverage/coverage-summary.json
        ▼
lib/first-party.js          → derives the FIRST-PARTY view of the summary,
        │                       excluding vendored (account/lib/**), test, mocks, interfaces
        ▼
check-thresholds.js         → compares each gated contract to its tier in
                              coverage-threshold-policy.json; exits non-zero on breach
```

## Files

| File | Role |
|------|------|
| `../../coverage-threshold-policy.json` | Single source of truth: tiers, gated/report-only/excluded, baseline |
| `lib/first-party.js` | Pure filter/aggregator over `coverage-summary.json` (first-party derived total) |
| `check-thresholds.js` | Gate CLI: `--summary --policy --scope gated\|all`; exit 0 pass / 1 breach / 2 bad input |

## Usage

```bash
# 1. produce coverage/coverage-summary.json
TZ=UTC npm run test:coverage

# 2a. per-PR gate (security-critical set) — used by .github/workflows/test.yml
node scripts/coverage/check-thresholds.js \
  --summary coverage/coverage-summary.json \
  --policy coverage-threshold-policy.json --scope gated

# 2b. weekly full report — used by .github/workflows/torture-test.yml
node scripts/coverage/check-thresholds.js \
  --summary coverage/coverage-summary.json \
  --policy coverage-threshold-policy.json --scope all
```

## Negative-path gates (spec 112)

Coverage proves a revert line RAN, not that a test asserted WHICH revert fired, and it only
enforces what the policy lists. Three static, dependency-free gates (no compile, no coverage run)
close that; each is proven by must-fail fixtures (`npm run test:contract-gates`) and runs in the
`Contract Negative-Path Gates` job of `test.yml` (`npm run check:contract-gates` locally).

| Script | Fails when | Ratchet file |
|--------|-----------|--------------|
| `check-policy-completeness.js` | a first-party `.sol` under a value directory is in none of `gated` / `reportOnly` / `excluded` (interface-only and signature-only abstract files are skipped) | the policy itself |
| `check-revert-coverage.js` | a named revert (`revert X()`, `require(c, X())`, `require(c, "m")`) is raised but no test asserts it by name, or an allowlist entry is now asserted / no longer raised | `revert-allowlist.json` (shrink-only, a `reason` per entry) |
| `check-bare-reverts.js` | `.to.be.reverted` / `.revertedWithoutReason` without `// ANY-REVERT: <reason>` rises above the per-file baseline, or the baseline overstates | `bare-revert-baseline.json` (shrink-only) |

Both ratchets fail in BOTH directions on purpose: whoever writes the missing test must delete the
entry in the same change, so the files can only get shorter. Never add to either to get green.

See `specs/046-contract-audit-coverage/` for the spec, plan, and the policy/gate
interface contract (`contracts/coverage-threshold-policy.md`).
