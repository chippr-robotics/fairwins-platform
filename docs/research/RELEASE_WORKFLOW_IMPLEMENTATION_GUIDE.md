# Release Workflow Implementation Guide

## Quick Start

This guide provides step-by-step instructions for implementing the release workflow improvements outlined in [RELEASE_WORKFLOW_ANALYSIS.md](./RELEASE_WORKFLOW_ANALYSIS.md).

## Current Status: Phase 1 Complete ✅

Phase 1 (Release Drafter) has been implemented. This guide covers future phases.

## Phase 1: Release Drafter ✅ COMPLETE

**Status**: Implemented and ready to use

**What's Included**:
- `.github/workflows/release-drafter.yml` - GitHub Actions workflow
- `.github/release-drafter.yml` - Configuration file
- Auto-labeling based on file paths and branch names
- Automatic draft release creation on PR merge

**How to Use**:
1. Label PRs with appropriate types (feature, fix, docs, etc.)
2. Merge PRs to `main`
3. Review draft at [Releases page](https://github.com/chippr-robotics/fairwins-platform/releases)
4. Edit and publish when ready

**Documentation**: [RELEASE_PROCESS.md](./RELEASE_PROCESS.md)

## Phase 2: Conventional Commits Adoption

**Goal**: Standardize commit message format for better automation

**Estimated Effort**: 1-2 days + team training

### Step 1: Document Conventional Commits Standard

Create `.github/COMMIT_CONVENTION.md`:

```markdown
# Commit Message Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/) specification.

## Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

## Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style (formatting, semicolons, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Test additions or modifications
- `build`: Build system changes
- `ci`: CI/CD changes
- `chore`: Other changes (dependencies, etc.)

## Examples

```
feat(governance): add traditional voting mode
fix(market): resolve LMSR overflow in calculatePrice
docs: update deployment quickstart guide
ci: add automated release workflow
```

## Breaking Changes

Use `BREAKING CHANGE:` in footer or add `!` after type:

```
feat(api)!: redesign market creation interface

BREAKING CHANGE: Market creation now requires additional parameters
```
```

### Step 2: Add Commit Message Template

Create `.gitmessage`:

```
# <type>[optional scope]: <description>
# 
# Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
# 
# Examples:
#   feat(governance): add traditional voting mode
#   fix(market): resolve price calculation overflow
#   docs: update README with release process
# 
# Breaking changes: Add ! after type or use BREAKING CHANGE: in footer
```

Configure git to use template:
```bash
git config commit.template .gitmessage
```

### Step 3: Add commitlint (Optional but Recommended)

Install commitlint:
```bash
npm install --save-dev @commitlint/{cli,config-conventional}
```

Create `commitlint.config.js`:
```javascript
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert'
      ]
    ],
    'scope-enum': [
      2,
      'always',
      [
        'governance',
        'market',
        'frontend',
        'contracts',
        'ci',
        'deps',
        'docs'
      ]
    ]
  }
};
```

Add to `package.json`:
```json
{
  "scripts": {
    "commitlint": "commitlint --edit"
  }
}
```

Add GitHub Action to validate commits in PRs:

```yaml
# .github/workflows/commitlint.yml
name: Lint Commit Messages

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  commitlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: wagoid/commitlint-github-action@v5
```

### Step 4: Update Contributing Guidelines

Add to `CONTRIBUTING.md` (create if doesn't exist):

```markdown
# Contributing Guidelines

## Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/) for clear and structured commit history.

### Quick Reference

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation only
- `test:` Test additions/changes
- `ci:` CI/CD changes

### Examples

✅ Good:
```
feat(market): implement TWAP price oracle
fix(frontend): resolve wallet connection timeout
docs: update release process documentation
```

❌ Bad:
```
updated stuff
fix
WIP
```

See [COMMIT_CONVENTION.md](.github/COMMIT_CONVENTION.md) for complete guide.
```

### Step 5: Team Training

**Training Session Outline** (1-2 hours):

1. **Why Conventional Commits?** (15 min)
   - Better changelog generation
   - Automated versioning
   - Clearer history
   - Better collaboration

2. **Format Overview** (20 min)
   - Type, scope, description structure
   - Common types and when to use them
   - Breaking change notation
   - Examples from this repo

3. **Tools and Workflow** (20 min)
   - Git commit template usage
   - commitlint validation
   - PR workflow changes
   - IDE integration (optional)

4. **Practice** (20 min)
   - Write example commits
   - Review and provide feedback
   - Common mistakes to avoid

5. **Q&A** (15 min)

**Training Materials**:
- Presentation slides (create from outline)
- Cheat sheet (print-friendly PDF)
- Hands-on exercises
- Quiz/self-assessment

### Step 6: Grace Period

**Week 1-2**: Soft launch
- Commits validated but not required
- Feedback and coaching
- Document common questions

**Week 3+**: Enforcement
- commitlint blocks non-compliant commits
- PR reviews include commit format check

## Phase 3: semantic-release Implementation

**Goal**: Fully automate versioning, tagging, and release creation

**Estimated Effort**: 1-2 days

### Step 1: Install semantic-release

```bash
npm install --save-dev semantic-release \
  @semantic-release/changelog \
  @semantic-release/git \
  @semantic-release/github
```

### Step 2: Create Configuration

Create `.releaserc.json`:

```json
{
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/changelog",
      {
        "changelogFile": "CHANGELOG.md",
        "changelogTitle": "# Changelog\n\nAll notable changes to this project will be documented in this file. See [Conventional Commits](https://conventionalcommits.org) for commit guidelines."
      }
    ],
    [
      "@semantic-release/npm",
      {
        "npmPublish": false
      }
    ],
    [
      "@semantic-release/git",
      {
        "assets": ["CHANGELOG.md", "package.json", "package-lock.json"],
        "message": "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
      }
    ],
    "@semantic-release/github"
  ]
}
```

### Step 3: Create GitHub Actions Workflow

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  release:
    name: Release
    runs-on: ubuntu-latest
    if: "!contains(github.event.head_commit.message, '[skip ci]')"
    
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Verify tests pass
        run: npm test

      - name: Release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx semantic-release

      - name: Summary
        run: |
          echo "## 🚀 Release Complete" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "Check the [releases page](https://github.com/${{ github.repository }}/releases) for details." >> $GITHUB_STEP_SUMMARY
```

### Step 4: Test on Develop Branch First

Before enabling on `main`, test on `develop`:

1. Update `.releaserc.json` to use `develop` branch:
```json
{
  "branches": ["develop"],
  ...
}
```

2. Merge a test commit to `develop`:
```bash
git checkout develop
git commit --allow-empty -m "feat(test): test semantic-release"
git push
```

3. Verify release is created
4. Check CHANGELOG.md is updated
5. Verify version is bumped in package.json

### Step 5: Enable for Main Branch

Once tested successfully:

1. Update `.releaserc.json`:
```json
{
  "branches": ["main"],
  ...
}
```

2. Merge to `main`
3. Monitor first automated release

### Step 6: Generate Initial CHANGELOG

For historical commits:

```bash
npx conventional-changelog-cli -p angular -i CHANGELOG.md -s -r 0
git add CHANGELOG.md
git commit -m "docs: add historical CHANGELOG"
git push
```

## Phase 4: Documentation and Polish

**Goal**: Complete documentation and team onboarding

**Estimated Effort**: 1 day

### Tasks

1. **Update all documentation**:
   - ✅ RELEASE_PROCESS.md
   - ✅ CI_CD_PIPELINE.md
   - ✅ README.md
   - [ ] CONTRIBUTING.md (if needed)

2. **Create team runbook**:
   - Quick reference for releases
   - Troubleshooting guide
   - Common scenarios

3. **Add badges to README**:
```markdown
![Version](https://img.shields.io/github/v/release/chippr-robotics/fairwins-platform)
![Commits](https://img.shields.io/github/commit-activity/m/chippr-robotics/fairwins-platform)
```

4. **Set up notifications** (optional):
   - Slack webhook for releases
   - Discord announcement
   - Email digest

## Optional Enhancements

### AI-Powered Release Notes Translation

If user-friendly language is important, add custom plugin:

```javascript
// custom-ai-translator-plugin.js
import OpenAI from 'openai';
import { promises as fs } from 'fs';

async function translateReleaseNotes(pluginConfig, context) {
  const { nextRelease } = context;
  
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content: "Convert technical release notes to user-friendly language for a general audience."
      },
      {
        role: "user",
        content: nextRelease.notes
      }
    ],
    temperature: 0.7
  });
  
  const userFriendlyNotes = response.choices[0].message.content;
  
  // Write to separate file
  await fs.writeFile(
    'RELEASE_NOTES_USER_FRIENDLY.md',
    `# ${nextRelease.version}\n\n${userFriendlyNotes}`
  );
  
  return { userFriendlyNotes };
}

export { translateReleaseNotes };
```

Add to `.releaserc.json`:
```json
{
  "plugins": [
    ...,
    "./custom-ai-translator-plugin"
  ]
}
```

Add `OPENAI_API_KEY` to GitHub Secrets.

**Cost**: ~$0.05 per release

### Public Changelog Page

Add to MkDocs:

```yaml
# mkdocs.yml
nav:
  - Home: index.md
  - Changelog: ../CHANGELOG.md
```

Or create standalone page:

```bash
# In deploy-docs workflow
pandoc CHANGELOG.md -o site/changelog.html --template=changelog.html
```

### In-App Changelog Widget

See `DEVION_COMPARISON.md` for React component example.

## Testing Checklist

Before going live with each phase:

### Phase 2 (Conventional Commits)
- [ ] Commit template configured
- [ ] commitlint installed and tested
- [ ] GitHub Action validates PR commits
- [ ] Documentation updated
- [ ] Team trained
- [ ] Grace period completed

### Phase 3 (semantic-release)
- [ ] Tested on develop branch
- [ ] Version bumping works correctly
- [ ] CHANGELOG.md generated properly
- [ ] GitHub release created
- [ ] Git tags applied
- [ ] Workflow permissions correct
- [ ] No manual intervention needed

### Phase 4 (Polish)
- [ ] All documentation updated
- [ ] Team runbook created
- [ ] Badges added to README
- [ ] Notifications configured (if any)
- [ ] Team onboarded

## Rollback Plan

If issues occur:

### Rollback Phase 3 (semantic-release)

1. Disable workflow:
```yaml
# .github/workflows/release.yml
on:
  push:
    branches: []  # Disable
```

2. Revert to Release Drafter
3. Manually fix any version issues
4. Investigate and fix root cause
5. Re-test before re-enabling

### Rollback Phase 2 (Conventional Commits)

1. Remove commitlint validation from CI
2. Update documentation to optional
3. Continue using Release Drafter (still works)
4. Address concerns and re-introduce

## Success Metrics

Track these metrics to measure success:

### Phase 2
- Commit message compliance rate (target: >90%)
- Time to fix non-compliant commits
- Developer satisfaction survey

### Phase 3
- Time to create release (target: <5 min)
- Releases per month (expect increase)
- CHANGELOG accuracy (peer review)
- Zero manual version bumps

### Phase 4
- Documentation usage (analytics)
- Support questions about releases (should decrease)
- Community feedback on release notes

## Timeline

**Total estimated time**: 4-5 weeks

| Phase | Duration | Dependencies | Key Deliverables |
|-------|----------|--------------|------------------|
| Phase 1 | ✅ Complete | None | Release Drafter working |
| Phase 2 | 1-2 weeks | Phase 1 | Conventional Commits adopted |
| Phase 3 | 1 week | Phase 2 | semantic-release automated |
| Phase 4 | 3-5 days | Phase 3 | Documentation complete |

## Support and Resources

### Documentation
- [RELEASE_PROCESS.md](./RELEASE_PROCESS.md) - Current release process
- [RELEASE_WORKFLOW_ANALYSIS.md](./RELEASE_WORKFLOW_ANALYSIS.md) - Detailed analysis
- [DEVION_COMPARISON.md](./DEVION_COMPARISON.md) - Solution comparison
- [CI_CD_PIPELINE.md](./CI_CD_PIPELINE.md) - CI/CD documentation

### External Resources
- [Conventional Commits](https://www.conventionalcommits.org/)
- [semantic-release](https://github.com/semantic-release/semantic-release)
- [commitlint](https://commitlint.js.org/)
- [Release Drafter](https://github.com/release-drafter/release-drafter)

### Getting Help

1. Check documentation first
2. Review GitHub Actions logs
3. Search semantic-release issues
4. Ask in team chat
5. Open GitHub issue with details

---

**Document Version**: 1.0  
**Date**: December 2024  
**Author**: GitHub Copilot  
**Status**: Implementation Guide - Phase 1 Complete
