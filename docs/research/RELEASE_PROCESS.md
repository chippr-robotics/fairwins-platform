# Release Process Documentation

## Overview

This document describes the release process for the FairWins/Clearpath Prediction Market Platform. Our release workflow is automated using GitHub Actions and follows semantic versioning principles.

## Current Status

### Phase 1: Release Drafter (Implemented)

We currently use [Release Drafter](https://github.com/release-drafter/release-drafter) to automatically draft release notes based on merged pull requests.

**How it works**:
1. When PRs are merged to `main`, Release Drafter automatically updates a draft release
2. Release notes are organized by category (Features, Bug Fixes, Documentation, etc.)
3. Version numbers are suggested based on PR labels
4. Contributors are automatically acknowledged

### Future Phases

- **Phase 2**: Conventional Commits adoption (planned)
- **Phase 3**: semantic-release implementation (planned)
- **Phase 4**: Full automation with changelog generation (planned)

See [RELEASE_WORKFLOW_ANALYSIS.md](./RELEASE_WORKFLOW_ANALYSIS.md) for detailed roadmap.

## Release Types

### Semantic Versioning

We follow [Semantic Versioning](https://semver.org/) (SemVer):

- **MAJOR** (X.0.0): Breaking changes, incompatible API changes
- **MINOR** (0.X.0): New features, backwards-compatible additions
- **PATCH** (0.0.X): Bug fixes, backwards-compatible fixes

### Current Version

Current version: **1.0.0** (defined in `package.json`)

## Pull Request Labels

### Required for Release Notes

Label your PRs to ensure they appear correctly in release notes:

#### Type Labels

- `feature` or `enhancement` - New features (Minor version bump)
- `fix`, `bugfix`, or `bug` - Bug fixes (Patch version bump)
- `major` or `breaking` - Breaking changes (Major version bump)

#### Category Labels

- `documentation` or `docs` - Documentation changes
- `test` or `testing` - Test additions/modifications
- `security` or `vulnerability` - Security fixes
- `performance` or `perf` - Performance improvements
- `ci` or `infrastructure` - CI/CD and infrastructure changes
- `refactor` - Code refactoring
- `chore`, `dependencies`, or `maintenance` - Maintenance tasks

#### Component Labels

- `frontend` - Frontend changes
- `contracts` - Smart contract changes

### Auto-labeling

Our Release Drafter configuration automatically adds labels based on:
- **File paths**: e.g., changes to `*.md` files get `documentation` label
- **Branch names**: e.g., `fix/*` branches get `bug` label
- **PR titles**: e.g., titles containing "feat" get `enhancement` label

## Creating a Release

### Step 1: Prepare Pull Requests

1. Ensure all PRs have appropriate labels
2. Use descriptive PR titles (they become release note entries)
3. Include issue references in PR descriptions

**Good PR title examples**:
```
✅ Add traditional voting mode to ClearPath governance
✅ Fix LMSR calculation overflow in market contracts
✅ Update deployment quickstart documentation
✅ Improve frontend accessibility score to 100
```

**Bad PR title examples**:
```
❌ Update code
❌ Fixes
❌ PR #123
❌ wip
```

### Step 2: Merge to Main

1. Merge approved PRs to `main` branch
2. Release Drafter automatically updates the draft release
3. Review the draft at: `https://github.com/chippr-robotics/fairwins-platform/releases`

### Step 3: Review Draft Release

1. Go to [Releases](https://github.com/chippr-robotics/fairwins-platform/releases)
2. Click "Edit" on the draft release
3. Review generated content:
   - Version number (adjust if needed)
   - Release notes categorization
   - Included changes
   - Contributors list

### Step 4: Edit Release Notes (if needed)

Add any additional context:

```markdown
## Highlights

This release introduces traditional voting mode to ClearPath, 
providing an enterprise-friendly alternative to futarchy governance.

## Breaking Changes

- ⚠️ Updated governance contract interface (see migration guide)

## What's Changed

[Auto-generated content]

## Known Issues

- Documentation site build time increased (tracking in #XXX)

## Migration Guide

[If applicable]
```

### Step 5: Publish Release

1. Finalize the version tag (e.g., `v1.1.0`)
2. Click "Publish release"
3. Release is now public and git tag is created

### Step 6: Post-Release Tasks

1. Verify deployment workflows triggered (if configured)
2. Update documentation site if needed
3. Announce release in communication channels
4. Monitor for issues

## Release Checklist

Use this checklist for each release:

### Pre-Release
- [ ] All planned PRs merged to `main`
- [ ] PRs have appropriate labels
- [ ] All CI/CD checks passing
- [ ] Security analysis completed
- [ ] Documentation updated
- [ ] Breaking changes documented (if any)

### Release
- [ ] Draft release reviewed
- [ ] Version number verified
- [ ] Release notes edited for clarity
- [ ] Known issues documented (if any)
- [ ] Migration guide added (if breaking changes)
- [ ] Release published

### Post-Release
- [ ] Git tag created successfully
- [ ] Deployment workflows completed
- [ ] Documentation site updated
- [ ] Release announced
- [ ] No immediate critical issues reported

## Version Numbering Guidelines

### Major Version (X.0.0)

Increment for breaking changes:
- Contract interface changes requiring upgrades
- Removal of deprecated features
- Database schema changes
- API breaking changes

**Example**: v1.0.0 → v2.0.0

### Minor Version (0.X.0)

Increment for new features:
- New governance modes
- Additional market types
- New frontend features
- New API endpoints

**Example**: v1.0.0 → v1.1.0

### Patch Version (0.0.X)

Increment for bug fixes:
- Security fixes
- Bug fixes
- Documentation updates
- Performance improvements

**Example**: v1.0.0 → v1.0.1

## Release Frequency

### Recommended Schedule

- **Major releases**: As needed (breaking changes)
- **Minor releases**: Monthly (new features)
- **Patch releases**: Weekly or as needed (bug fixes)

### Emergency Releases

For critical security issues:
1. Create hotfix branch from `main`
2. Fix issue and test thoroughly
3. Merge with expedited review
4. Release immediately with `security` label
5. Document in release notes

## Hotfix Process

### Critical Issues in Production

1. **Create hotfix branch**:
   ```bash
   git checkout main
   git pull origin main
   git checkout -b hotfix/critical-issue-description
   ```

2. **Fix and test**:
   ```bash
   # Make fixes
   npm test
   npm run test:coverage
   ```

3. **Create PR**:
   - Title: `[HOTFIX] Brief description`
   - Labels: `bug`, `security` (if applicable)
   - Request expedited review

4. **Merge and release**:
   - Fast-track review
   - Merge to `main`
   - Publish release immediately
   - Bump patch version

5. **Backport if needed**:
   - Cherry-pick to other active branches
   - Document in release notes

## Communication

### Release Announcements

Announce releases in:
- [ ] GitHub Releases (automatic)
- [ ] Repository README (update version badge if exists)
- [ ] Documentation site (changelog page)
- [ ] Team chat/communication channels
- [ ] Community Discord/forums (if applicable)

### Release Notes Audience

Write for multiple audiences:
- **Users**: What's new, how to use new features
- **Developers**: Technical changes, API updates
- **Operators**: Deployment considerations, breaking changes

## Automation Roadmap

### Current (Phase 1)

✅ **Release Drafter**
- Automatic draft creation
- PR-based release notes
- Auto-labeling
- Contributor recognition

### Planned (Phase 2-4)

🔄 **Conventional Commits**
- Standardized commit messages
- Better categorization
- Automatic version determination

🔄 **semantic-release**
- Fully automated releases
- Automatic version bumping
- Automatic git tagging
- Automatic CHANGELOG.md generation
- NPM package publishing (if applicable)

🔄 **Enhanced Automation**
- Multi-language release notes
- Automatic deployment triggers
- Slack/Discord notifications
- Release metrics tracking

See [RELEASE_WORKFLOW_ANALYSIS.md](./RELEASE_WORKFLOW_ANALYSIS.md) for detailed implementation plan.

## Tools and Resources

### GitHub Actions Workflows

- **Release Drafter**: `.github/workflows/release-drafter.yml`
- **CI Manager**: `.github/workflows/ci-manager.yml`
- **Deploy Docs**: `.github/workflows/deploy-docs.yml`

### Configuration Files

- **Release Drafter Config**: `.github/release-drafter.yml`
- **Package Version**: `package.json`

### Documentation

- [Semantic Versioning](https://semver.org/)
- [Release Drafter](https://github.com/release-drafter/release-drafter)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [GitHub Releases Documentation](https://docs.github.com/en/repositories/releasing-projects-on-github)

### Internal Documentation

- [RELEASE_WORKFLOW_ANALYSIS.md](./RELEASE_WORKFLOW_ANALYSIS.md) - Comprehensive analysis and roadmap
- [CI_CD_PIPELINE.md](./CI_CD_PIPELINE.md) - CI/CD documentation
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Contribution guidelines (if exists)

## Troubleshooting

### Release Drafter Not Working

1. Check workflow permissions in `.github/workflows/release-drafter.yml`
2. Verify `GITHUB_TOKEN` has correct permissions
3. Check workflow run logs in Actions tab
4. Ensure PRs are merged (not just closed)

### Wrong Version Number

1. Check PR labels (they determine version bump)
2. Manually edit the draft release version
3. Update version-resolver configuration if needed

### Missing PRs in Release

1. Verify PR was merged (not closed without merge)
2. Check if PR has appropriate labels
3. Ensure PR targeted `main` branch
4. Release Drafter updates on each PR merge

### Release Not Publishing

1. Verify you clicked "Publish release" (not just save draft)
2. Check repository permissions
3. Ensure tag doesn't already exist
4. Review any error messages

## FAQs

### Q: How do I create my first release?

**A**: Merge a few PRs to `main` with proper labels, then go to the Releases page, review the auto-generated draft, and click "Publish release".

### Q: Can I manually create a release?

**A**: Yes, but it's not recommended. Use the draft generated by Release Drafter for consistency.

### Q: How do I handle breaking changes?

**A**: Add the `breaking` or `major` label to the PR, and document the migration steps in the release notes.

### Q: What if I forget to label a PR?

**A**: You can add labels after merging. Release Drafter will update the draft on the next PR merge, or you can manually edit the release notes.

### Q: Can I preview release notes before merging?

**A**: Yes! Release Drafter updates on PR events, so you can see how your PR will appear in the draft before merging.

### Q: How do I exclude a PR from release notes?

**A**: Add the `skip-changelog` label to the PR. Release Drafter will ignore it.

---

**Document Version**: 1.0  
**Last Updated**: December 2024  
**Maintained By**: DevOps Team  
**Status**: Active
