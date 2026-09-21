# Contributing Guidelines

Thank you for considering contributing to Prediction DAO Research! This document provides guidelines for contributing.

## Code of Conduct

Be respectful, inclusive, and collaborative. We're building something important together.

## How to Contribute

### Reporting Bugs

1. Check if the bug is already reported in [GitHub Issues](https://github.com/chippr-robotics/fairwins-platform/issues)
2. If not, create a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (OS, Node version, etc.)
   - Screenshots if applicable

### Suggesting Features

1. Check existing issues and discussions
2. Create a new issue with label "enhancement"
3. Describe the feature and its benefits
4. Explain use cases
5. Consider implementation approach

### Pull Requests

1. **Fork** the repository
2. **Create a branch** from `staging` — never from `main`:
   ```bash
   git fetch origin staging
   git checkout -b feature/my-feature origin/staging
   ```
   `main` is the production branch (spec 076): everything on it is deployed to members, and the
   only ways onto it are a promotion from `staging` or a declared hotfix. `branch-policy.yml`
   enforces that as a merge-blocking check.
3. **Make your changes** with clear commits
4. **Write tests** for new functionality
5. **Update documentation** as needed
6. **Run tests** to ensure everything passes
7. **Submit a pull request** with clear description

### Working alongside agents

Several agents work this repository concurrently, and the coordination protocol they follow is
binding on humans too — most of all the two rules that exist because they were broken:

- **A spec number is claimed by MERGING a reservation PR to `staging`**, not by computing it or by
  opening a draft. `npm run check:specs` fails a PR that claims a number already taken.
- **Assign yourself before starting.** The assignee is the claim — it is how an agent scanning for
  work knows not to start the same thing. There is deliberately no status label to set: state is
  read from the assignee, the linked PRs and whether the issue is closed, and closure comes from
  `Closes #N` in the PR body. GitHub only honours closing keywords on the default branch, so
  `close-linked-issues.yml` applies them on the `staging` merge — check the issue actually closed.

The full protocol — triage, sizing, sub-issues, reviewing delegated work — is in
[Multi-Agent Development Flow](multi-agent-workflow.md).

## Development Workflow

### Setup

```bash
git clone https://github.com/YOUR_USERNAME/prediction-dao-research.git
cd prediction-dao-research
npm install
# (spec 075) one root `npm install` covers frontend and every other workspace
```

### Making Changes

```bash
# Create feature branch (from staging, see above)
git fetch origin staging
git checkout -b feature/my-feature origin/staging

# Make changes
# ... edit files ...

# Run tests
npm test

# Run linting
cd frontend && npm run lint && cd ..

# Commit changes
git add .
git commit -m "Add feature: description"

# Push to your fork
git push origin feature/my-feature
```

### Pull Request Process

1. Update README.md or documentation if needed
2. Ensure all tests pass
3. Update CHANGELOG.md (if exists)
4. **Smart Contract PRs**: The Ethereum Security Review Agent will automatically review all `.sol` file changes for security vulnerabilities and best practices compliance
5. Create pull request with:
   - Clear title
   - Description of changes
   - Related issue numbers
   - Screenshots (for UI changes)

## Coding Standards

### Solidity Style

Follow the [Solidity Style Guide](https://docs.soliditylang.org/en/latest/style-guide.html):

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title MyContract
 * @notice Brief description
 * @dev Detailed implementation notes
 */
contract MyContract {
    // Constants
    uint256 public constant MAX_VALUE = 1000;
    
    // State variables
    address public owner;
    mapping(uint256 => Proposal) public proposals;
    
    // Events
    event ProposalCreated(uint256 indexed proposalId);
    
    // Modifiers
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }
    
    // Functions (grouped by visibility)
    constructor() {
        owner = msg.sender;
    }
    
    function publicFunction() external {
        // Implementation
    }
    
    function _internalFunction() internal {
        // Implementation
    }
}
```

### JavaScript/React Style

```javascript
// Use ES6+ features
const MyComponent = ({ prop1, prop2 }) => {
  const [state, setState] = useState(initialValue);
  
  useEffect(() => {
    // Side effects
  }, [dependencies]);
  
  const handleClick = () => {
    // Event handler
  };
  
  return (
    <div className="my-component">
      {/* JSX */}
    </div>
  );
};

export default MyComponent;
```

### Naming Conventions

- **Contracts**: PascalCase (e.g., `ProposalRegistry`)
- **Functions**: camelCase (e.g., `submitProposal`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_PROPOSAL_AMOUNT`)
- **Private functions**: _leadingUnderscore (e.g., `_internalHelper`)
- **Events**: PascalCase (e.g., `ProposalSubmitted`)

### Comments and Documentation

```solidity
/**
 * @notice Submit a new proposal to the DAO
 * @param title The proposal title (max 100 characters)
 * @param description Detailed proposal description
 * @param fundingAmount Amount of  requested
 * @param recipient Address to receive funds if approved
 * @param welfareMetricId Which metric to evaluate against
 * @return proposalId The ID of the created proposal
 */
function submitProposal(
    string memory title,
    string memory description,
    uint256 fundingAmount,
    address recipient,
    uint256 welfareMetricId
) external payable returns (uint256) {
    // Implementation
}
```

## Testing Requirements

### Required Tests

All new features must include:

- **Unit tests** for individual functions
- **Integration tests** for contract interactions
- **Edge case tests** for boundary conditions
- **Failure tests** for error handling

### Running Tests

```bash
# Run all tests
npm test

# Run specific test
npx hardhat test test/ProposalRegistry.test.js

# Check coverage
npm run test:coverage
```

### Test Coverage

Aim for:

- Statements: > 95%
- Branches: > 90%
- Functions: > 95%

## Git Commit Messages

Write clear, descriptive commit messages:

```
Add proposal submission validation

- Validate title length (max 100 chars)
- Check funding amount against limits
- Ensure welfare metric exists
- Add corresponding tests

Fixes #123
```

Format:

```
<type>: <subject>

<body>

<footer>
```

Types:

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Adding tests
- `refactor`: Code refactoring
- `style`: Code style changes
- `chore`: Build/tooling changes

## Documentation

Update documentation for:

- New features
- Changed behavior
- New configuration options
- API changes

Documentation locations:

- `docs/` - MkDocs documentation
- `README.md` - Project overview
- Code comments - Inline documentation
- Test files - Usage examples

## Review Process

### For Contributors

1. Submit PR with clear description
2. Respond to review feedback
3. Make requested changes
4. Re-request review when ready

### For Reviewers

- Be constructive and respectful
- Explain reasoning for changes
- Approve when satisfied
- Help contributors improve

## Security

### Automated Security Review

All smart contract code changes are automatically reviewed by the **Ethereum Security Review Agent**:

- **Automatic Analysis**: Detects vulnerabilities in Solidity code
- **EthTrust Standards**: Follows [Ethereum Trust Alliance Security Levels](https://entethalliance.org/specs/ethtrust-sl/)
- **Best Practices**: Enforces secure coding patterns
- **Quick Start**: See [Ethereum Security Quick Start](ethereum-security-quickstart.md)
- **Full Guide**: See [Ethereum Security Agent Documentation](ethereum-security-agent.md)

### Reporting Vulnerabilities

**DO NOT** create public issues for security vulnerabilities.

Instead:

1. Email security@example.com
2. Include detailed description
3. Provide reproduction steps
4. Wait for acknowledgment

### Security Review

All security-critical changes require:

- Additional review by security team
- Audit trail documentation
- Comprehensive testing
- Deployment checklist

## Questions?

- Check the [FAQ](../user-guide/faq.md)
- Join community discussions
- Ask in GitHub Discussions
- Reach out to maintainers

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.

Thank you for contributing! 🎉
