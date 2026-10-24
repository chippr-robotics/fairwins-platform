# CI/CD Pipeline Documentation

## Overview
This repository includes comprehensive CI/CD pipelines for automated testing, accessibility auditing, release management, and deployment to Google Cloud Run.

## Pipeline Structure

### 1. Release Management
**File**: `.github/workflows/release-drafter.yml`

Runs on:
- Pull requests (opened, reopened, synchronize)
- Pushes to `main` branch

**Purpose**: Automatically drafts release notes based on merged pull requests.

**Jobs**:

#### Update Release Draft
- Parses merged PRs and their labels
- Categorizes changes (Features, Bug Fixes, Documentation, etc.)
- Suggests version bump based on labels
- Generates draft release with formatted notes
- Auto-labels PRs based on files changed and branch names
- Acknowledges contributors

**Configuration**: `.github/release-drafter.yml`

**Documentation**: See [RELEASE_PROCESS.md](./RELEASE_PROCESS.md) for complete release workflow.

### 2. Frontend Testing and Accessibility Audits
**File**: `.github/workflows/frontend-testing.yml`

Runs on:
- Pull requests to `main` or `develop` branches
- Pushes to `main` or `develop` branches
- Manual workflow dispatch

**Jobs**:

#### Unit and Integration Tests
- Runs Vitest test suite
- Generates code coverage reports
- Tests UI components and Web3 integration flows
- **Requirement**: All tests must pass

#### Lighthouse Accessibility Audit
- Builds production frontend
- Runs Lighthouse CI on multiple pages
- Checks performance, accessibility, SEO
- **Requirement**: Accessibility score = 100

#### axe Accessibility Audit
- Runs axe-core automated tests
- Validates WCAG 2.1 AA compliance
- **Requirement**: Zero WCAG AA violations

### 3. Cloud Run Deployment
**File**: `.github/workflows/deploy-cloud-run.yml`

Runs on:
- Pushes to `main` branch only
- Manual workflow dispatch

**Jobs**:

#### Test and Audit (Pre-Deployment)
- Runs linter
- Executes test suite
- Builds application
- Runs Lighthouse audit
- **Blocks deployment if tests fail**

#### Build and Deploy
- Authenticates with Google Cloud
- Builds Docker image
- Pushes to Google Container Registry (GCR)
- Deploys to Cloud Run
- Configures service settings

#### Post-Deployment Verification
- Waits for deployment to stabilize
- Verifies service responds with HTTP 200
- Confirms deployment success

### 4. Weekly Torture Test
**File**: `.github/workflows/torture-test.yml`

Runs on:
- Scheduled: Weekly on Monday at 00:00 UTC
- Manual workflow dispatch

**Purpose**: Comprehensive weekly testing including long-running tests, security analysis, and end-to-end testing.

**Jobs**:

#### Hardhat Tests & Gas Report
- Runs full smart contract test suite
- Generates detailed gas usage reports
- Provides insights for optimization

#### Coverage Analysis
- Generates comprehensive coverage reports
- Identifies untested code paths
- Provides metrics for code quality

#### Slither Static Analysis
- Performs static analysis on smart contracts
- Identifies potential vulnerabilities
- Generates detailed security reports

#### Manticore Symbolic Execution
- Runs symbolic execution on all contracts
- Deep analysis for edge cases and vulnerabilities
- Long-running tests (up to 10 minutes per contract)

#### Medusa Fuzz Testing
- Extended fuzzing session (1 hour)
- Tests for unexpected behavior
- Generates test corpus

#### Cypress E2E Tests
- Full end-to-end testing of frontend workflows
- Tests integration with smart contracts
- Validates complete user journeys
- **Note**: Moved from daily CI to weekly testing to optimize development build times

**Rationale**: E2E tests are comprehensive but time-consuming. Running them weekly ensures thorough testing without slowing down daily development cycles.

---

## Setup Instructions

### Release Management Setup

1. **Release Drafter Configuration**
   - Configuration file: `.github/release-drafter.yml`
   - Workflow file: `.github/workflows/release-drafter.yml`
   - No additional secrets required (uses `GITHUB_TOKEN`)

2. **PR Labeling Guidelines**
   - Add appropriate labels to PRs (feature, fix, documentation, etc.)
   - Labels determine version bump and categorization
   - Auto-labeling configured based on file paths and branch names
   - See [RELEASE_PROCESS.md](./RELEASE_PROCESS.md) for label guide

3. **Creating Releases**
   - Merge PRs to `main` with proper labels
   - Review draft release at: `https://github.com/chippr-robotics/fairwins-platform/releases`
   - Edit and publish when ready
   - See [RELEASE_PROCESS.md](./RELEASE_PROCESS.md) for complete workflow

### Prerequisites

1. **GitHub Repository Secrets**
   - `GCP_PROJECT_ID`: Your Google Cloud Project ID
   - `GCP_SA_KEY`: Service Account JSON key with permissions:
     - Cloud Run Admin
     - Cloud Build Editor
     - Storage Admin
     - Service Account User

2. **Google Cloud Setup**
   ```bash
   # Enable required APIs
   gcloud services enable run.googleapis.com
   gcloud services enable containerregistry.googleapis.com
   gcloud services enable cloudbuild.googleapis.com

   # Create service account
   gcloud iam service-accounts create github-actions \
     --display-name="GitHub Actions"

   # Grant permissions
   gcloud projects add-iam-policy-binding PROJECT_ID \
     --member="serviceAccount:github-actions@PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/run.admin"

   gcloud projects add-iam-policy-binding PROJECT_ID \
     --member="serviceAccount:github-actions@PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/cloudbuild.builds.editor"

   gcloud projects add-iam-policy-binding PROJECT_ID \
     --member="serviceAccount:github-actions@PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/iam.serviceAccountUser"

   gcloud projects add-iam-policy-binding PROJECT_ID \
     --member="serviceAccount:github-actions@PROJECT_ID.iam.gserviceaccount.com" \
     --role="roles/storage.admin"

   # Create and download key
   gcloud iam service-accounts keys create key.json \
     --iam-account=github-actions@PROJECT_ID.iam.gserviceaccount.com
   ```

3. **Add Secrets to GitHub**
   - Go to repository Settings > Secrets and variables > Actions
   - Add `GCP_PROJECT_ID` with your project ID
   - Add `GCP_SA_KEY` with contents of `key.json`

### Local Development

#### Install Dependencies
```bash
cd frontend
npm install
```

#### Run Tests
```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run with coverage
npm run test:coverage

# Run specific test file
npm test Button.test
```

#### Run Accessibility Audits
```bash
# Build the application
npm run build

# Run Lighthouse CI
npm install -g @lhci/cli@0.13.x
lhci autorun
```

#### Build and Preview
```bash
# Development server
npm run dev

# Production build
npm run build

# Preview production build
npm run preview
```

---

## Deployment Process

### Automatic Deployment
1. Merge PR to `main` branch
2. GitHub Actions automatically:
   - Runs all tests and audits
   - Builds Docker image
   - Pushes to Google Container Registry
   - Deploys to Cloud Run
   - Verifies deployment

### Manual Deployment
1. Go to Actions tab in GitHub
2. Select "Deploy to Google Cloud Run"
3. Click "Run workflow"
4. Select `main` branch
5. Click "Run workflow"

### Rollback
If deployment fails or issues are found:

```bash
# List recent deployments
gcloud run revisions list --service=prediction-dao-frontend --region=us-central1

# Rollback to previous revision
gcloud run services update-traffic prediction-dao-frontend \
  --to-revisions=REVISION_NAME=100 \
  --region=us-central1
```

---

## Testing Requirements

### Minimum Standards for Deployment

All of the following must pass before deployment:

✅ **Unit Tests**: 100% pass rate
✅ **Integration Tests**: All Web3 flows working
✅ **Lighthouse Accessibility**: Score of 100
✅ **axe DevTools**: Zero WCAG AA violations
✅ **Manual Testing**: All checklist items completed
✅ **Build**: Successful production build
✅ **Linter**: No errors

### Test Coverage Goals
- Overall coverage: 80%+
- Critical paths: 100%
- UI components: 90%+
- Web3 integration: 95%+

---

## Accessibility Requirements

### Automated Tools
1. **Lighthouse CI**
   - Target: 100/100 accessibility score
   - Runs on every PR and deployment
   - Configuration: `frontend/lighthouserc.json`

2. **axe-core**
   - Zero WCAG AA violations
   - Integrated in test suite
   - Runs on component tests

3. **WAVE** (Manual)
   - Zero errors on production site
   - Check after deployment

### Manual Testing
See `MANUAL_ACCESSIBILITY_TESTING.md` for complete checklist:
- Keyboard navigation
- Screen reader testing
- Color contrast verification
- Motion preferences
- Mobile accessibility
- Cross-browser testing

---

## Monitoring and Maintenance

### Post-Deployment Checks
1. Verify service is responding
2. Check logs for errors
3. Run manual accessibility audit
4. Test critical user flows
5. Monitor performance metrics

### Google Cloud Run Dashboard
```bash
# View service details
gcloud run services describe prediction-dao-frontend --region=us-central1

# View recent logs
gcloud run services logs read prediction-dao-frontend --region=us-central1

# Check service metrics
# Visit Cloud Console > Cloud Run > prediction-dao-frontend > Metrics
```

### Health Monitoring
The service is automatically monitored by Cloud Run:
- Request count
- Request latency
- Error rate
- Container instance count

Set up alerts in Cloud Console for:
- Error rate > 5%
- Latency > 1 second (p95)
- Instance count = 0

---

## Troubleshooting

### Tests Failing in CI
1. Check GitHub Actions logs
2. Run tests locally: `npm test`
3. Verify dependencies: `npm ci`
4. Check Node version matches (20.x)

### Lighthouse Score Below 100
1. Review Lighthouse report in artifacts
2. Fix accessibility issues identified
3. Re-run audit locally: `lhci autorun`
4. Update code and push again

### Deployment Fails
1. Check service account permissions
2. Verify secrets are set correctly
3. Review Docker build logs
4. Check Cloud Run quotas and limits

### Service Not Responding
1. Check Cloud Run logs
2. Verify container starts successfully
3. Check port configuration (8080)
4. Verify nginx configuration

### Common Issues

**Issue**: Tests pass locally but fail in CI
**Solution**: Ensure all dependencies in package.json, check Node version

**Issue**: Accessibility score varies between runs
**Solution**: Run multiple times (3x), ensure consistent network conditions

**Issue**: Deployment successful but site not loading
**Solution**: Check Cloud Run logs, verify nginx config, check port 8080

**Issue**: Docker build fails
**Solution**: Verify Dockerfile syntax, check base image availability

---

## Resources

### Documentation
- [GitHub Actions Docs](https://docs.github.com/en/actions)
- [Google Cloud Run Docs](https://cloud.google.com/run/docs)
- [Lighthouse CI Docs](https://github.com/GoogleChrome/lighthouse-ci)
- [Vitest Docs](https://vitest.dev/)
- [axe-core Docs](https://github.com/dequelabs/axe-core)

### Internal Docs
- `FRONTEND_BUILD_BOOK.md` - Frontend development guide
- `MANUAL_ACCESSIBILITY_TESTING.md` - Accessibility testing checklist
- `ACCESSIBILITY_COMPLIANCE_REVIEW.md` - Compliance review

### Support
For issues or questions:
1. Check documentation first
2. Review GitHub Actions logs
3. Consult team leads
4. Open GitHub issue with details

---

**Last Updated**: December 2024
**Maintained By**: DevOps & Frontend Team
