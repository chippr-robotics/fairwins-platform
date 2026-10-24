import { tenantBrand } from '../config/tenant'
/**
 * @fileoverview Metadata generation utilities for creating OpenSea-compatible metadata
 * @module utils/metadataGenerator
 * 
 * This module provides functions to generate IPFS metadata for various platform resources
 * following the OpenSea metadata standard. It bridges on-chain data with off-chain metadata.
 */

/**
 * Generate market metadata in OpenSea format
 * @param {Object} params - Market parameters
 * @param {number} params.marketId - Market ID
 * @param {string} params.name - Market title
 * @param {string} params.description - Market description (markdown supported)
 * @param {string} params.category - Market category
 * @param {string} [params.subcategory] - Market subcategory
 * @param {string} [params.imageUrl] - Market image URL
 * @param {string} [params.backgroundColor] - Hex color (without #)
 * @param {number} [params.proposalId] - Associated proposal ID
 * @param {string} [params.passToken] - PASS token address
 * @param {string} [params.failToken] - FAIL token address
 * @param {string} [params.collateralToken] - Collateral token address
 * @param {string} [params.creator] - Creator address
 * @param {string} [params.correlationGroupId] - Correlation group ID
 * @param {Array<string>} [params.tags] - Market tags
 * @param {Array<string>} [params.oracleSources] - Oracle data sources
 * @param {string} [params.resolutionCriteria] - Detailed resolution criteria
 * @param {Object} params.onChainData - On-chain market data
 * @returns {Object} OpenSea-compatible metadata object
 */
export function generateMarketMetadata(params) {
  const {
    marketId,
    name,
    description,
    category,
    subcategory,
    imageUrl = 'ipfs://QmDefaultMarketImage',
    backgroundColor,
    proposalId,
    passToken,
    failToken,
    collateralToken,
    creator,
    correlationGroupId,
    tags = [],
    oracleSources = [],
    resolutionCriteria,
    onChainData = {}
  } = params

  const metadata = {
    name,
    description, // Short question/title for the market
    external_url: `${tenantBrand().appUrl}/market/${marketId}`,
    image: imageUrl,
    attributes: [
      {
        trait_type: 'Category',
        value: category
      },
      {
        trait_type: 'Status',
        value: onChainData.status || 'Active'
      }
    ]
  }

  // Add optional background color
  if (backgroundColor) {
    metadata.background_color = backgroundColor.replace('#', '')
  }

  // Add subcategory if provided
  if (subcategory) {
    metadata.attributes.push({
      trait_type: 'Subcategory',
      value: subcategory
    })
  }

  // Add numeric attributes from on-chain data
  if (onChainData.totalLiquidity !== undefined) {
    metadata.attributes.push({
      trait_type: 'Total Liquidity',
      value: parseFloat(onChainData.totalLiquidity),
      display_type: 'number'
    })
  }

  if (onChainData.passTokenPrice !== undefined) {
    metadata.attributes.push({
      trait_type: 'Pass Token Price',
      value: parseFloat(onChainData.passTokenPrice),
      display_type: 'number',
      max_value: 1.0
    })
  }

  if (onChainData.failTokenPrice !== undefined) {
    metadata.attributes.push({
      trait_type: 'Fail Token Price',
      value: parseFloat(onChainData.failTokenPrice),
      display_type: 'number',
      max_value: 1.0
    })
  }

  if (onChainData.tradingEndTime) {
    metadata.attributes.push({
      trait_type: 'Trading End Time',
      value: Math.floor(new Date(onChainData.tradingEndTime).getTime() / 1000),
      display_type: 'date'
    })
  }

  if (correlationGroupId) {
    metadata.attributes.push({
      trait_type: 'Correlation Group',
      value: correlationGroupId
    })
  }

  if (onChainData.betType) {
    metadata.attributes.push({
      trait_type: 'Bet Type',
      value: onChainData.betType
    })
  }

  // Add properties section
  metadata.properties = {
    market_id: marketId
  }

  if (proposalId !== undefined) {
    metadata.properties.proposal_id = proposalId
  }

  if (passToken) {
    metadata.properties.pass_token = passToken
  }

  if (failToken) {
    metadata.properties.fail_token = failToken
  }

  if (collateralToken) {
    metadata.properties.collateral_token = collateralToken
  }

  if (creator) {
    metadata.properties.creator = creator
  }

  if (onChainData.createdAt) {
    metadata.properties.created_at = onChainData.createdAt
  }

  if (correlationGroupId) {
    metadata.properties.correlation_group_id = correlationGroupId
  }

  if (tags.length > 0) {
    metadata.properties.tags = tags
  }

  if (oracleSources.length > 0) {
    metadata.properties.oracle_sources = oracleSources
  }

  // Store resolution criteria separately (detailed description)
  if (resolutionCriteria) {
    metadata.properties.resolution_criteria = resolutionCriteria
  }

  return metadata
}

/**
 * Generate token metadata in OpenSea format
 * @param {Object} params - Token parameters
 * @param {string} params.name - Token name
 * @param {string} params.symbol - Token symbol
 * @param {string} params.description - Token description
 * @param {string} params.tokenAddress - Token contract address
 * @param {string} [params.imageUrl] - Token logo URL
 * @param {string} [params.backgroundColor] - Hex color (without #)
 * @param {number} [params.decimals=18] - Token decimals
 * @param {string} [params.tokenType='ERC20'] - Token type
 * @param {string} [params.creator] - Creator address
 * @param {boolean} [params.listedOnDex=false] - Listed on the active chain DEX
 * @param {Object} [params.tokenomics] - Tokenomics information
 * @param {Array<string>} [params.utility] - Token utility descriptions
 * @param {Object} [params.links] - Social and project links
 * @returns {Object} OpenSea-compatible metadata object
 */
export function generateTokenMetadata(params) {
  const {
    name,
    symbol,
    description,
    tokenAddress,
    imageUrl = 'ipfs://QmDefaultTokenLogo',
    backgroundColor,
    decimals = 18,
    tokenType = 'ERC20',
    creator,
    listedOnDex = false,
    tokenomics,
    utility = [],
    links = {}
  } = params

  const metadata = {
    name,
    symbol,
    description,
    external_url: links.website || `${tenantBrand().appUrl}/token/${tokenAddress}`,
    image: imageUrl,
    attributes: [
      {
        trait_type: 'Token Type',
        value: tokenType
      }
    ]
  }

  if (backgroundColor) {
    metadata.background_color = backgroundColor.replace('#', '')
  }

  // Add properties
  metadata.properties = {
    token_address: tokenAddress,
    decimals,
    created_at: new Date().toISOString(),
    listed_on_dex: listedOnDex
  }

  if (creator) {
    metadata.properties.creator = creator
  }

  if (tokenomics) {
    metadata.properties.tokenomics = tokenomics
    
    if (tokenomics.totalSupply) {
      metadata.attributes.push({
        trait_type: 'Total Supply',
        value: tokenomics.totalSupply,
        display_type: 'number'
      })
    }
  }

  if (utility.length > 0) {
    metadata.properties.utility = utility
  }

  if (Object.keys(links).length > 0) {
    metadata.properties.links = links
  }

  return metadata
}

/**
 * Generate proposal metadata in OpenSea format
 * @param {Object} params - Proposal parameters
 * @param {number} params.proposalId - Proposal ID
 * @param {string} params.title - Proposal title
 * @param {string} params.description - Proposal description
 * @param {number} params.fundingAmount - Requested funding amount
 * @param {string} [params.fundingToken] - Funding token symbol
 * @param {string} [params.proposer] - Proposer address
 * @param {string} [params.recipient] - Recipient address
 * @param {Array<Object>} [params.milestones] - Proposal milestones
 * @param {Array<Object>} [params.documents] - Supporting documents
 * @param {Array<Object>} [params.team] - Team information
 * @returns {Object} OpenSea-compatible metadata object
 */
export function generateProposalMetadata(params) {
  const {
    proposalId,
    title,
    description,
    fundingAmount,
    fundingToken = 'POL',
    proposer,
    recipient,
    milestones = [],
    documents = [],
    team = []
  } = params

  const metadata = {
    name: title,
    description,
    external_url: `${tenantBrand().appUrl}/proposal/${proposalId}`,
    image: 'ipfs://QmDefaultProposalImage',
    attributes: [
      {
        trait_type: 'Funding Amount',
        value: fundingAmount,
        display_type: 'number'
      },
      {
        trait_type: 'Funding Token',
        value: fundingToken
      },
      {
        trait_type: 'Status',
        value: 'Active'
      }
    ],
    properties: {
      proposal_id: proposalId
    }
  }

  if (proposer) {
    metadata.properties.proposer = proposer
  }

  if (recipient) {
    metadata.properties.recipient = recipient
  }

  if (milestones.length > 0) {
    metadata.properties.milestones = milestones
  }

  if (documents.length > 0) {
    metadata.properties.documents = documents
  }

  if (team.length > 0) {
    metadata.properties.team = team
  }

  return metadata
}

/**
 * Generate DAO metadata in OpenSea format
 * @param {Object} params - DAO parameters
 * @param {string} params.name - DAO name
 * @param {string} params.description - DAO description
 * @param {string} params.daoAddress - DAO address
 * @param {string} [params.governanceType='futarchy'] - Governance type
 * @param {string} [params.imageUrl] - DAO logo URL
 * @param {string} [params.bannerUrl] - DAO banner URL
 * @param {Object} [params.contracts] - Contract addresses
 * @param {Object} [params.governance] - Governance configuration
 * @param {Array<Object>} [params.welfareMetrics] - Welfare metrics
 * @param {Object} [params.links] - Social and project links
 * @returns {Object} OpenSea-compatible metadata object
 */
export function generateDAOMetadata(params) {
  const {
    name,
    description,
    daoAddress,
    governanceType = 'futarchy',
    imageUrl = 'ipfs://QmDefaultDAOLogo',
    bannerUrl,
    contracts = {},
    governance = {},
    welfareMetrics = [],
    links = {}
  } = params

  const metadata = {
    name,
    description,
    external_url: links.website || `${tenantBrand().appUrl}/dao/${daoAddress}`,
    image: imageUrl,
    attributes: [
      {
        trait_type: 'Governance Type',
        value: governanceType.charAt(0).toUpperCase() + governanceType.slice(1)
      },
      {
        trait_type: 'Status',
        value: 'Active'
      }
    ],
    properties: {
      dao_address: daoAddress,
      created_at: new Date().toISOString()
    }
  }

  if (bannerUrl) {
    metadata.banner_image = bannerUrl
  }

  if (Object.keys(contracts).length > 0) {
    metadata.properties.contracts = contracts
  }

  if (Object.keys(governance).length > 0) {
    metadata.properties.governance = governance
  }

  if (welfareMetrics.length > 0) {
    metadata.properties.welfare_metrics = welfareMetrics
  }

  if (Object.keys(links).length > 0) {
    metadata.properties.links = links
  }

  return metadata
}

/**
 * Validate metadata against basic requirements
 * @param {Object} metadata - Metadata object to validate
 * @returns {Object} Validation result with valid flag and errors array
 * @description Performs basic validation of metadata structure and format.
 * For full schema validation, use a JSON schema validator with the schema files.
 */
export function validateMetadata(metadata) {
  const errors = []

  // Basic validation
  if (!metadata.name) {
    errors.push('Missing required field: name')
  }

  if (!metadata.description) {
    errors.push('Missing required field: description')
  }

  if (!metadata.image) {
    errors.push('Missing required field: image')
  }

  if (!metadata.attributes || !Array.isArray(metadata.attributes)) {
    errors.push('Missing or invalid required field: attributes')
  }

  // Background color validation
  if (metadata.background_color && !/^[0-9A-Fa-f]{6}$/.test(metadata.background_color)) {
    errors.push('Invalid background_color format (should be 6-character hex without #)')
  }

  // URL validation
  const urlFields = ['external_url', 'image', 'animation_url']
  urlFields.forEach(field => {
    if (metadata[field] && !isValidUrl(metadata[field])) {
      errors.push(`Invalid URL format for ${field}`)
    }
  })

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Check if a string is a valid URL
 * @param {string} url - URL to validate
 * @returns {boolean} True if valid URL
 */
function isValidUrl(url) {
  // Check for IPFS URL format first (not parseable by URL constructor)
  if (url.startsWith('ipfs://')) {
    // Basic IPFS CID validation - should have something after ipfs://
    return url.length > 7
  }
  
  // Check for standard HTTP/HTTPS URLs
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}
