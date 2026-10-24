# Research Documents

This directory contains in-depth research and analysis documents for proposed enhancements and integrations to the Prediction DAO platform.

## Available Research

### [GutterToken Assistant Integration](guttertoken-assistant-integration.md)

**Status**: Evaluation - Input to a feature spec  
**Date**: September 5, 2026

Evaluates how FairWins members could run the spec-095 assistant on their own GutterToken prepaid
credits, as an alternative to the members-only FairWins-funded rail. Measures what the GutterToken
API actually offers (open CORS, bearer keys, no account or balance endpoint, no delegated auth),
compares bring-your-own-key browser-direct, gateway passthrough, a FairWins-owned account, and a
mini-app, and recommends the browser-direct pattern surfaced through the existing bottom sheets.
Part II evaluates how the existing MCP server should relate to the assistant and recommends a
client-side tool loop over a shared tool table rather than the MCP transport or Anthropic's MCP
connector.

### [Dex v3 Integration Analysis](dex-v3-integration-analysis.md)

**Status**: Final - Ready for Review  
**Date**: December 23, 2025

A comprehensive analysis exploring the integration of Dex v3 (Uniswap v3 fork) concentrated liquidity mechanics into Prediction DAO. This research document covers:

- **Architecture Analysis**: Deep dive into V3's concentrated liquidity mechanisms, tick mathematics, and fee structures
- **Comparative Study**: Detailed comparison between current LMSR markets and V3 AMM approaches
- **Integration Strategy**: Platform-specific approach with clear rationale
- **Technical Design**: Proposed smart contract architecture and implementation details
- **Risk Assessment**: Comprehensive analysis of technical, economic, and operational risks
- **Implementation Roadmap**: Phased rollout plan for FairWins V3 integration

**Key Recommendation**: Platform-specific approach where ClearPath uses LMSR with Nightmarket privacy for governance (privacy-first), and FairWins uses V3 concentrated liquidity for prediction markets (efficiency-first).

### [Alternative Approaches (Appendix)](dex-v3-alternative-approaches.md)

**Status**: Reference Material  
**Date**: December 23, 2025

Detailed documentation of four alternative integration approaches that were evaluated but not recommended. Includes:

- **Option 2**: Parallel Markets (both mechanisms on both platforms)
- **Option 3**: Hybrid Model (LMSR base with V3 supplementary)
- **Option 4**: Specialized Markets (mechanism by market type)
- **Option 5**: Post-Resolution Secondary Market (V3 for resolved tokens)

Each option includes concept, architecture diagrams, advantages, disadvantages, and rationale for why it wasn't selected. Useful for understanding the decision-making process and future reconsideration scenarios.

---

## Research Process

Research documents follow this structure:

1. **Executive Summary**: High-level findings and recommendations
2. **Background**: Problem statement and context
3. **Technical Analysis**: Deep dive into technology/approach
4. **Comparative Analysis**: How it compares to existing systems
5. **Integration Design**: Proposed implementation approach
6. **Benefits & Risks**: Comprehensive trade-off analysis
7. **Roadmap**: Phased implementation plan with milestones
8. **Conclusion**: Summary and next steps

## Contributing Research

To contribute a new research document:

1. Create a new markdown file in this directory
2. Follow the established structure and format
3. Include comprehensive technical analysis
4. Provide clear recommendations with supporting evidence
5. Add references to all external sources
6. Update this README with a summary
7. Add to `mkdocs.yml` navigation

## Research Standards

All research documents should:

- ✅ Be technically accurate and well-researched
- ✅ Include multiple perspectives and trade-offs
- ✅ Provide actionable recommendations
- ✅ Reference credible sources
- ✅ Consider security implications
- ✅ Include implementation considerations
- ✅ Be accessible to technical and non-technical readers

## Questions?

For questions about research documents or to propose new research topics, please:

- Open an issue on [GitHub](https://github.com/chippr-robotics/fairwins-platform/issues)
- Contact the core team

---

*Last Updated: December 23, 2025*
