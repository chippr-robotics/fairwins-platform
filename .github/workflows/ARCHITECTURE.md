# CI Manager Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GitHub Event Trigger                         │
│                  (Pull Request / Push / Manual)                      │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    CI Manager Workflow Start                         │
│                     (.github/workflows/ci-manager.yml)               │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Job: detect-changes                             │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  1. Checkout code (fetch-depth: 0)                         │    │
│  │  2. Run paths-filter@v3 action                             │    │
│  │     - Analyze changed files                                │    │
│  │     - Match against path patterns                          │    │
│  │     - Output: contracts, frontend, docs, security, core    │    │
│  │  3. Generate Change Detection Summary                      │    │
│  └────────────────────────────────────────────────────────────┘    │
└────────────────────────────────┬────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │   Component Detection    │
                    │   Results (outputs)      │
                    └────────────┬────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│  contracts:    │     │  frontend:     │     │    docs:       │
│  true/false    │     │  true/false    │     │  true/false    │
└────────┬───────┘     └────────┬───────┘     └────────┬───────┘
         │                      │                      │
         ▼                      ▼                      ▼
         │                      │                      │
         │       ┌──────────────┼──────────────┐      │
         │       │              │              │      │
         ▼       ▼              ▼              ▼      ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ Job: smart-     │   │ Job: frontend-  │   │ Job: docs-      │
│ contract-tests  │   │ tests           │   │ build           │
│                 │   │                 │   │                 │
│ if: contracts   │   │ if: frontend    │   │ if: docs        │
│     OR core     │   │     OR core     │   │                 │
│                 │   │                 │   │                 │
│ Calls:          │   │ Steps:          │   │ Steps:          │
│ test.yml        │   │ - Checkout      │   │ - Checkout      │
│ (workflow_call) │   │ - Setup Node    │   │ - Setup Python  │
│                 │   │ - npm ci        │   │ - pip install   │
│                 │   │ - npm lint      │   │ - mkdocs build  │
│                 │   │ - npm build     │   │                 │
└────────┬────────┘   └────────┬────────┘   └────────┬────────┘
         │                     │                     │
         │                     │                     │
         │            ┌────────┼────────┐           │
         │            │        │        │           │
         ▼            ▼        ▼        ▼           ▼
┌─────────────────────────────────────────────────────────────┐
│            Job: security-analysis                            │
│                                                               │
│  if: (security changes) OR (main branch)                    │
│                                                               │
│  Calls: security-testing.yml (workflow_call)                │
│    - Hardhat tests with gas reporting                       │
│    - Coverage analysis                                       │
│    - Slither static analysis                                │
│    - Medusa fuzz testing                                    │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Job: ci-summary                           │
│                   (always runs)                              │
│                                                               │
│  Collects results from all jobs:                            │
│  - Smart Contract Tests: ✅ Success / ⏭️ Skipped / ❌ Failed │
│  - Frontend Tests: ✅ Success / ⏭️ Skipped / ❌ Failed       │
│  - Documentation Build: ✅ Success / ⏭️ Skipped / ❌ Failed  │
│  - Security Analysis: ✅ Success / ⏭️ Skipped / ❌ Failed    │
│                                                               │
│  Generates final summary table and status                   │
│  Exits with error if any job failed                         │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    Workflow Complete                         │
│              ✅ All jobs passed / ❌ Some failed             │
└─────────────────────────────────────────────────────────────┘


═══════════════════════════════════════════════════════════════

Path Detection Rules (from .github/ci-config.yml):

┌──────────────────────────────────────────────────────────────┐
│ Component: CONTRACTS                                         │
│ Patterns:                                                    │
│   - contracts/**                                             │
│   - hardhat.config.js                                        │
│   - scripts/deploy*.js                                       │
│   - test/*.test.js                                           │
│   - test/integration/**                                      │
│   - medusa.json                                              │
│   - slither.config.json                                      │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ Component: FRONTEND                                          │
│ Patterns:                                                    │
│   - frontend/**                                              │
│   - !frontend/README.md (excluded)                           │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ Component: DOCS                                              │
│ Patterns:                                                    │
│   - docs/**                                                  │
│   - mkdocs.yml                                               │
│   - requirements.txt                                         │
│   - *.md (all markdown files)                                │
│   - !frontend/README.md (excluded)                           │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ Component: SECURITY                                          │
│ Patterns:                                                    │
│   - contracts/**                                             │
│   - hardhat.config.js                                        │
│   - test/**                                                  │
│   - medusa.json                                              │
│   - slither.config.json                                      │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ Component: CORE                                              │
│ Patterns:                                                    │
│   - package.json                                             │
│   - package-lock.json                                        │
│   - .github/workflows/**                                     │
└──────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════

Example Flow: Frontend-Only Change

1. Developer changes: frontend/src/App.jsx
2. CI Manager triggered on PR
3. paths-filter analyzes: ✅ frontend=true, ❌ contracts=false, 
                          ❌ docs=false, ❌ security=false
4. Jobs executed:
   - ⏭️ smart-contract-tests: Skipped (no contract changes)
   - ✅ frontend-tests: Running (frontend changed)
   - ⏭️ docs-build: Skipped (no doc changes)
   - ⏭️ security-analysis: Skipped (no security changes, not main)
5. Time saved: ~10-15 minutes
6. Summary posted to PR

═══════════════════════════════════════════════════════════════

Key Benefits:

💰 Cost Savings
   - Reduced CI minutes usage
   - Lower infrastructure costs
   
⚡ Speed
   - Faster feedback for developers
   - Quicker PR merge times
   
🎯 Precision
   - Only run necessary tests
   - Maintain coverage where needed
   
🔒 Security
   - Security tests always run on main
   - Contract changes always trigger security
   
📊 Transparency
   - Clear summaries of what runs
   - Visibility into why tests skipped

═══════════════════════════════════════════════════════════════
```

## File Structure

```
.github/
├── ci-config.yml               # Path pattern configuration
└── workflows/
    ├── ci-manager.yml          # Main orchestration workflow
    ├── test.yml                # Contract tests (reusable)
    ├── security-testing.yml    # Security analysis (reusable)
    ├── deploy-docs.yml         # Docs deployment (independent)
    ├── deploy-contracts.yml    # Contract deployment (independent)
    ├── README.md               # Complete documentation
    ├── QUICKSTART.md           # Quick reference guide
    └── CI_MANAGER_TEST_SCENARIOS.md # Test scenarios
```

## Configuration Flow

```
.github/ci-config.yml (patterns) ──▶ ci-manager.yml (filters) ──▶ Job execution
                                       │
                                       ▼
                              Change detection outputs
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
              contracts=true    frontend=true      docs=true
                    │                  │                  │
                    ▼                  ▼                  ▼
            Run contract tests  Run frontend tests  Build docs
```

## Decision Logic

```
For each job:

smart-contract-tests:
  IF contracts==true OR core==true
    THEN run test.yml
    ELSE skip

frontend-tests:
  IF frontend==true OR core==true
    THEN run inline frontend jobs
    ELSE skip

docs-build:
  IF docs==true
    THEN run inline docs build
    ELSE skip

security-analysis:
  IF security==true OR branch==main
    THEN run security-testing.yml
    ELSE skip
```

## Integration with Existing Workflows

```
Before CI Manager:
┌────────────┐
│ PR Created │
└─────┬──────┘
      │
      ├──▶ test.yml (always runs)
      ├──▶ security-testing.yml (always runs)
      └──▶ deploy-docs.yml (on main only)

After CI Manager:
┌────────────┐
│ PR Created │
└─────┬──────┘
      │
      ▼
┌────────────────┐
│  CI Manager    │ ◀── Smart orchestration
└─────┬──────────┘
      │
      ├──▶ test.yml (conditional)
      ├──▶ security-testing.yml (conditional)
      ├──▶ frontend tests (conditional, inline)
      ├──▶ docs build (conditional, inline)
      └──▶ ci-summary (always)

Existing workflows still work independently when triggered directly!
```
