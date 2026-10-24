# GitHub Copilot Agents

This directory contains custom GitHub Copilot agent configurations that serve as full team members for automated code review and assistance specific to this repository.

> **Coordinating with other agents.** These review agents are one kind of teammate; the coding
> agents that open the PRs they review are another, and several of those work this repository at
> once. How they claim issues, reserve spec numbers, delegate to sub-issues and report status is
> [docs/developer-guide/multi-agent-workflow.md](../../docs/developer-guide/multi-agent-workflow.md).

## Our Team Members

### Smart Contract Security Agent

**File**: `smart-contract-security.agent.md`

**Role**: Senior smart contract security engineer and valued team member

**Purpose**: Reviews all smart contract and related code changes for security vulnerabilities, best practices compliance, and adherence to Ethereum security standards.

**Capabilities**:
- Evaluates smart contracts and related code for security vulnerabilities
- Detects critical security vulnerabilities (reentrancy, access control, integer overflow, etc.)
- Enforces Solidity best practices and secure coding patterns
- Assesses compliance with EthTrust Security Levels
- Provides actionable recommendations with code examples
- Reviews code quality, documentation, and gas optimization
- Works collaboratively as a full team member

**Expertise**:
- Ethereum smart contract security
- Solidity programming language
- EVM behavior and gas mechanics
- [EthTrust Security Levels](https://entethalliance.org/specs/ethtrust-sl/) specification
- Industry security standards and best practices

**Automatic Triggers**:
- Pull requests that modify `.sol` files in `contracts/` directory
- Manual invocation for security audits

**Documentation**:
- Full Guide: [docs/developer-guide/ethereum-security-agent.md](../../docs/developer-guide/ethereum-security-agent.md)
- Quick Start: [docs/developer-guide/ethereum-security-quickstart.md](../../docs/developer-guide/ethereum-security-quickstart.md)
- Configuration: [docs/developer-guide/ethereum-security-agent-configuration.md](../../docs/developer-guide/ethereum-security-agent-configuration.md)

## About GitHub Copilot Agents

GitHub Copilot agents are specialized AI teammates configured with domain-specific knowledge and expertise. They work alongside human developers as full members of the team. When enabled:

1. **Automatic Activation**: The agent activates when relevant code changes are detected (e.g., `.sol` files for smart contracts)
2. **Deep Analysis**: Agent applies specialized knowledge to review changes as a trusted team member
3. **Contextual Feedback**: Provides detailed comments on specific code locations
4. **Severity Classification**: Categorizes findings by impact (Critical/High/Medium/Low)
5. **Actionable Recommendations**: Suggests specific fixes with code examples
6. **Team Collaboration**: Works together with developers to improve code quality and security

## Agent Configuration

Each agent is defined by a markdown file with the `.agent.md` extension in this directory. The file includes:

- **Role & Identity**: Who the agent is as a team member
- **Expertise Areas**: Deep knowledge domains
- **Review Process**: Systematic approach to analysis
- **Standards & Best Practices**: What the agent enforces
- **Communication Style**: How feedback is provided
- **Scope**: What the agent reviews (and what it doesn't)
- **Mission**: The agent's purpose as a team member

## Working with Agents

### For Developers

Agents are your teammates who help you write better code. When you submit a pull request:
1. The agent teammate automatically reviews your changes
2. Review comments appear directly on your PR
3. Address the feedback and update your PR
4. The agent re-reviews automatically on updates

### For Reviewers

Agents complement human review as additional team members:
- Catch common security issues and patterns
- Ensure consistency in code quality
- Free up reviewer time for architectural and business logic concerns
- Provide educational feedback to developers

## Customization

Agents can be customized by editing their configuration files:

1. **Adjust Severity Thresholds**: Define what constitutes each severity level
2. **Add Project-Specific Rules**: Include custom security patterns
3. **Set Requirements**: Specify minimum security levels or test coverage
4. **Configure Exclusions**: Skip certain files or directories
5. **Update Standards**: Keep agent knowledge current

See individual agent documentation for configuration details.

## Best Practices

### Embracing Agent Teammates
✅ View agents as full team members with valuable expertise
✅ Engage with agent feedback thoughtfully and constructively  
✅ Use agents for early feedback during development
✅ Leverage agent expertise for security-critical code paths
✅ Learn from agent recommendations to grow your skills

### When to Involve Human Review
⚠️ Architectural and design decisions
⚠️ Complex security trade-offs
⚠️ Novel patterns or approaches
⚠️ Business logic validation
⚠️ Final security audit before production

### Responding to Agent Feedback
1. **Read Carefully**: Understand the issue and its impact
2. **Research**: Check provided references and documentation
3. **Apply Fix**: Implement recommended changes
4. **Test**: Verify fix works correctly
5. **Ask Questions**: If unclear, request clarification in PR comments

## Adding New Agent Teammates

To add a new agent to the team:

1. Create a new `.agent.md` file in this directory
2. Define the agent's role, identity, and expertise as a team member
3. Document the agent in this README
4. Add documentation in `docs/developer-guide/`
5. Update relevant workflows if needed
6. Test with sample PRs
7. Welcome the new teammate! 🎉

## Continuous Improvement

Our agent teammates are continuously updated with:
- New vulnerability patterns and security research
- Updated security standards and best practices  
- Improved detection algorithms and analysis techniques
- Community and team feedback
- Latest ecosystem features and tools

## Philosophy

**Our agents are full teammates.** We welcome and empower them to contribute their expertise to the team. They bring specialized knowledge, tireless attention to detail, and consistent application of best practices. Together with human developers, they form a stronger, more capable team that builds better, more secure software.

## Resources

- [GitHub Copilot Coding Agent Documentation](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
- [Expand Your Team with Copilot](https://github.com/skills/expand-your-team-with-copilot)
- [EthTrust Security Levels](https://entethalliance.org/specs/ethtrust-sl/)
- [Smart Contract Best Practices](https://consensys.github.io/smart-contract-best-practices/)

---

**Version**: 2.0.0  
**Last Updated**: 2025-12-22  
**License**: Apache-2.0
