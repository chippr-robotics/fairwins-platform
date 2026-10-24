/**
 * IPFS Service
 *
 * Service for interacting with IPFS gateway to retrieve and upload data.
 * Provides caching, retry logic, and error handling for IPFS requests.
 *
 * Features:
 * - Fetch data from IPFS with caching
 * - Upload JSON metadata to IPFS
 * - Batch operations for multiple requests
 * - Gateway health checks
 */

import {
  IPFS_CONFIG,
  IPFS_GATEWAY,
  IPFS_UPLOAD_API,
  PINATA_CONFIG,
  getIpfsUrl,
  buildIpfsPath,
  isValidCid
} from '../constants/ipfs'

/**
 * In-memory cache for IPFS data
 * Structure: { key: { data, timestamp } }
 */
const cache = new Map()

/**
 * Sleep utility for retry delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after delay
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Check if cached data is still valid
 * @param {number} timestamp - Cache timestamp
 * @returns {boolean} True if cache is still valid
 */
const isCacheValid = (timestamp) => {
  return Date.now() - timestamp < IPFS_CONFIG.CACHE_DURATION
}

/**
 * Get data from cache
 * @param {string} key - Cache key
 * @returns {any|null} Cached data or null if not found/expired
 */
const getFromCache = (key) => {
  const cached = cache.get(key)
  if (cached && isCacheValid(cached.timestamp)) {
    return cached.data
  }
  if (cached) {
    cache.delete(key) // Remove expired cache
  }
  return null
}

/**
 * Store data in cache
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 */
const setInCache = (key, data) => {
  cache.set(key, {
    data,
    timestamp: Date.now()
  })
}

/**
 * Clear all cache
 */
export const clearCache = () => {
  cache.clear()
}

/**
 * Clear specific cache entry
 * @param {string} key - Cache key to clear
 */
export const clearCacheEntry = (key) => {
  cache.delete(key)
}

/**
 * Fetch data from IPFS with retry logic
 * @param {string} url - Full IPFS URL
 * @param {Object} options - Fetch options
 * @returns {Promise<any>} Parsed JSON response
 * @throws {Error} If all retry attempts fail
 */
const fetchWithRetry = async (url, options = {}) => {
  let lastError
  
  for (let attempt = 0; attempt < IPFS_CONFIG.MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), IPFS_CONFIG.TIMEOUT)
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          ...options.headers,
        },
      })
      
      clearTimeout(timeoutId)
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
      
      const data = await response.json()
      return data
      
    } catch (error) {
      lastError = error
      
      // Don't retry on abort (timeout)
      if (error.name === 'AbortError') {
        throw new Error('IPFS request timeout', { cause: error })
      }
      
      // Wait before retry (except on last attempt)
      if (attempt < IPFS_CONFIG.MAX_RETRIES - 1) {
        await sleep(IPFS_CONFIG.RETRY_DELAY * (attempt + 1)) // Exponential backoff
      }
    }
  }
  
  throw new Error(`IPFS fetch failed after ${IPFS_CONFIG.MAX_RETRIES} attempts: ${lastError.message}`)
}

/**
 * Fetch data from IPFS with caching
 * @param {string} path - IPFS path or CID
 * @param {Object} options - Options
 * @param {boolean} options.skipCache - Skip cache check
 * @returns {Promise<any>} Data from IPFS
 */
export const fetchFromIpfs = async (path, options = {}) => {
  const { skipCache = false } = options
  
  // Check cache first unless skipCache is true
  if (!skipCache) {
    const cached = getFromCache(path)
    if (cached) {
      return cached
    }
  }
  
  // Fetch from IPFS
  const url = getIpfsUrl(path)
  const data = await fetchWithRetry(url)
  
  // Store in cache
  setInCache(path, data)
  
  return data
}

/**
 * Fetch token metadata from IPFS
 * @param {string} tokenAddress - Token contract address
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Token metadata
 */
export const fetchTokenMetadata = async (tokenAddress, options = {}) => {
  if (!tokenAddress) {
    throw new Error('Token address is required')
  }
  
  const path = buildIpfsPath.tokenMetadata(tokenAddress)
  return fetchFromIpfs(path, options)
}

/**
 * Fetch market data from IPFS
 * @param {string} marketId - Market identifier
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Market data
 */
export const fetchMarketData = async (marketId, options = {}) => {
  if (!marketId) {
    throw new Error('Market ID is required')
  }
  
  const path = buildIpfsPath.marketData(marketId)
  return fetchFromIpfs(path, options)
}

/**
 * Fetch market metadata from IPFS
 * @param {string} marketId - Market identifier
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Market metadata
 */
export const fetchMarketMetadata = async (marketId, options = {}) => {
  if (!marketId) {
    throw new Error('Market ID is required')
  }
  
  const path = buildIpfsPath.marketMetadata(marketId)
  return fetchFromIpfs(path, options)
}

/**
 * Fetch data from IPFS using CID
 * @param {string} cid - IPFS content identifier
 * @param {Object} options - Fetch options
 * @returns {Promise<any>} Data from IPFS
 */
export const fetchByCid = async (cid, options = {}) => {
  if (!cid) {
    throw new Error('CID is required')
  }
  
  if (!isValidCid(cid)) {
    throw new Error('Invalid CID format')
  }
  
  const path = buildIpfsPath.fromCid(cid)
  return fetchFromIpfs(path, options)
}

/**
 * Batch fetch multiple items from IPFS
 * @param {Array<string>} paths - Array of IPFS paths or CIDs
 * @param {Object} options - Fetch options
 * @returns {Promise<Array>} Array of results (null for failed fetches)
 */
export const batchFetch = async (paths, options = {}) => {
  if (!Array.isArray(paths) || paths.length === 0) {
    return []
  }
  
  const promises = paths.map(async (path) => {
    try {
      return await fetchFromIpfs(path, options)
    } catch (error) {
      console.error(`Failed to fetch from IPFS path ${path}:`, error)
      return null
    }
  })
  
  return Promise.all(promises)
}

/**
 * Check if IPFS gateway is accessible
 * @returns {Promise<boolean>} True if gateway is accessible
 */
export const checkGatewayHealth = async () => {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 5000)

    // Try to fetch a known IPFS CID or health endpoint
    const response = await fetch(`${IPFS_GATEWAY}/`, {
      method: 'HEAD',
      signal: controller.signal,
    })

    clearTimeout(timeoutId)
    return response.ok || response.status === 404 // 404 is ok, means gateway is up
  } catch {
    return false
  }
}

// ==========================================
// IPFS Upload Functions (Pinata Integration)
// ==========================================

/**
 * Get Pinata authentication headers
 * Prefers JWT over API Key/Secret if available
 * When using the proxy, returns empty object (nginx handles auth)
 * @returns {Object} Headers object with authorization
 */
const getPinataAuthHeaders = () => {
  // When using proxy, nginx handles authentication - no headers needed from frontend
  if (PINATA_CONFIG.USE_PROXY) {
    return {}
  }

  if (PINATA_CONFIG.JWT) {
    return {
      'Authorization': `Bearer ${PINATA_CONFIG.JWT}`,
    }
  }

  if (PINATA_CONFIG.API_KEY && PINATA_CONFIG.API_SECRET) {
    return {
      'pinata_api_key': PINATA_CONFIG.API_KEY,
      'pinata_secret_api_key': PINATA_CONFIG.API_SECRET,
    }
  }

  throw new Error('Pinata authentication not configured. Please set VITE_PINATA_JWT or VITE_PINATA_API_KEY and VITE_PINATA_API_SECRET environment variables.')
}

/**
 * Get the Pinata upload endpoint URL
 * Uses proxy in production, direct API in development
 * @returns {string} The upload endpoint URL
 */
const getPinataUploadUrl = () => {
  if (PINATA_CONFIG.USE_PROXY) {
    return `${PINATA_CONFIG.PROXY_URL}/pinJSONToIPFS`
  }
  return `${PINATA_CONFIG.API_URL}/pinning/pinJSONToIPFS`
}

/**
 * Generate a unique timestamped filename for Pinata
 * Format: prefix-YYYYMMDD-HHMMSSmmm.json (UTC)
 * @param {string} prefix - Filename prefix (e.g., 'market-metadata', 'token-metadata')
 * @returns {string} Unique filename
 */
const generateTimestampedFilename = (prefix = 'metadata') => {
  const now = new Date()
  const timestamp = now.toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\.\d{3}Z$/, '')
  const ms = now.getMilliseconds().toString().padStart(3, '0')
  return `${prefix}-${timestamp}${ms}.json`
}

/**
 * Upload JSON data to IPFS via Pinata
 * @param {Object} data - JSON data to upload
 * @param {Object} options - Upload options
 * @param {string} options.name - Optional name for the content (auto-generated with timestamp if not provided)
 * @param {string} options.namePrefix - Optional prefix for auto-generated timestamped name (default: 'metadata')
 * @returns {Promise<{cid: string, uri: string}>} Upload result with CID and URI
 * @throws {Error} If upload fails
 */
export const uploadJson = async (data, options = {}) => {
  if (!data || typeof data !== 'object') {
    throw new Error('Data must be a valid object')
  }

  // Validate that data can be stringified (no circular references)
  let jsonString
  try {
    jsonString = JSON.stringify(data)
  } catch (error) {
    throw new Error(`Cannot stringify data: ${error.message}`, { cause: error })
  }

  // Generate unique timestamped filename for auditing if name not explicitly provided
  const filename = options.name || generateTimestampedFilename(options.namePrefix || 'metadata')

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), IPFS_CONFIG.UPLOAD_TIMEOUT)

  try {
    // Get auth headers for Pinata (empty when using proxy)
    const authHeaders = getPinataAuthHeaders()

    // Use proxy endpoint in production, direct API in development
    const uploadUrl = getPinataUploadUrl()
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        pinataContent: data,
        pinataMetadata: {
          name: filename,
        },
        pinataOptions: {
          cidVersion: 1, // Use CIDv1 for better compatibility
        },
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      const responseText = await response.text()
      let errorMessage
      let details = ''
      try {
        const errorData = JSON.parse(responseText)
        errorMessage = errorData?.error?.reason || errorData?.error?.message || errorData?.message || null
        // Pinata puts the ACTIONABLE half in `details` — `reason` alone is an opaque token.
        // `NO_SCOPES_FOUND` (a valid key with no permitted scopes, i.e. the wrong key for this
        // endpoint) reads as a generic app error without it, and the operator has nothing to act
        // on. Same for the status: 401/403 says "credential", 429 says "wait", 5xx says "Pinata".
        const rawDetails = errorData?.error?.details || errorData?.details
        if (typeof rawDetails === 'string' && rawDetails) details = ` — ${rawDetails}`
      } catch {
        errorMessage = null
      }
      if (!errorMessage) {
        const bodySnippet = responseText ? responseText.slice(0, 200) : ''
        errorMessage = `Pinata upload failed with status ${response.status}` + (bodySnippet ? `. Response: ${bodySnippet}` : '')
        throw new Error(errorMessage)
      }
      throw new Error(`${errorMessage}${details} (HTTP ${response.status})`)
    }

    const result = await response.json()

    // Pinata returns IpfsHash (CID) in the response
    const cid = result.IpfsHash
    if (!cid) {
      throw new Error('Pinata response missing IpfsHash (CID)')
    }

    console.log('Successfully pinned to Pinata:', {
      cid,
      name: filename,
      size: result.PinSize,
      timestamp: result.Timestamp,
    })

    return {
      cid,
      uri: `ipfs://${cid}`,
      size: result.PinSize || new Blob([jsonString]).size,
      timestamp: result.Timestamp,
    }
  } catch (error) {
    clearTimeout(timeoutId)

    if (error.name === 'AbortError') {
      throw new Error('Pinata upload timeout', { cause: error })
    }

    // Re-throw auth errors as-is
    if (error.message.includes('authentication not configured')) {
      throw error
    }

    throw new Error(`Pinata upload failed: ${error.message}`, { cause: error })
  }
}

/**
 * Upload market metadata to IPFS
 * Validates and formats metadata according to OpenSea standard
 * @param {Object} metadata - Market metadata object
 * @returns {Promise<{cid: string, uri: string}>} Upload result
 */
export const uploadMarketMetadata = async (metadata) => {
  // Validate required fields
  if (!metadata.name) {
    throw new Error('Market metadata requires a name/question field')
  }
  if (!metadata.description) {
    throw new Error('Market metadata requires a description')
  }

  // Ensure proper format
  const formattedMetadata = {
    // Standard OpenSea fields
    name: metadata.name,
    description: metadata.description,
    image: metadata.image || 'ipfs://QmDefaultMarketImage',
    external_url: metadata.external_url,

    // Attributes array for structured data
    attributes: Array.isArray(metadata.attributes) ? metadata.attributes : [],

    // Custom properties
    properties: {
      ...metadata.properties,
      schema_version: '1.1.0',
      uploaded_at: new Date().toISOString(),
    },
  }

  return uploadJson(formattedMetadata, { namePrefix: 'market-metadata' })
}

/**
 * Resolve a URI to fetch its content
 * Handles ipfs://, https://, and raw CID formats
 * @param {string} uri - URI to resolve
 * @param {Object} options - Fetch options
 * @returns {Promise<any>} Resolved content
 */
export const resolveUri = async (uri, options = {}) => {
  if (!uri) {
    throw new Error('URI is required')
  }

  // Handle IPFS URIs
  if (uri.startsWith('ipfs://')) {
    const cid = uri.replace('ipfs://', '').split('/')[0]
    const path = uri.replace(`ipfs://${cid}`, '') || ''
    return fetchFromIpfs(cid + path, options)
  }

  // Handle raw CIDs
  if (isValidCid(uri)) {
    return fetchByCid(uri, options)
  }

  // Handle HTTPS URLs
  if (uri.startsWith('https://')) {
    // Use caller-provided signal if present; otherwise create a timed abort controller
    const hasCallerSignal = options && options.signal

    if (hasCallerSignal) {
      const response = await fetch(uri, { ...options })
      if (!response.ok) {
        throw new Error(`Failed to fetch ${uri}: ${response.status}`)
      }
      return response.json()
    }

    const controller = new AbortController()
    // Prefer a configured timeout if available, otherwise fall back to a sane default
    const timeoutMs =
      (IPFS_CONFIG && (IPFS_CONFIG.REQUEST_TIMEOUT_MS || IPFS_CONFIG.FETCH_TIMEOUT_MS)) || 10000
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(uri, { ...options, signal: controller.signal })
      if (!response.ok) {
        throw new Error(`Failed to fetch ${uri}: ${response.status}`)
      }
      return response.json()
    } finally {
      clearTimeout(timeoutId)
    }
  }

  throw new Error(`Unsupported URI format: ${uri}`)
}

/**
 * Upload and pin content with metadata registry integration
 * Uploads to IPFS and optionally registers with MetadataRegistry contract
 * Note: If registration fails, metadata remains uploaded to IPFS (orphaned content).
 * This is by design to prevent data loss - the caller can retry registration later.
 * @param {Object} content - Content to upload
 * @param {Object} options - Options
 * @param {string} options.resourceType - Resource type for registry (e.g., 'market')
 * @param {string} options.resourceId - Resource ID for registry
 * @param {Function} options.registerCallback - Callback to register with contract
 * @returns {Promise<{cid: string, uri: string, registered: boolean}>}
 */
export const uploadAndRegister = async (content, options = {}) => {
  // Upload to IPFS first
  const uploadResult = await uploadJson(content, { name: options.name })

  // If registration callback provided, register with MetadataRegistry
  if (options.registerCallback && options.resourceType && options.resourceId) {
    try {
      await options.registerCallback(
        options.resourceType,
        options.resourceId,
        uploadResult.cid
      )
      return { ...uploadResult, registered: true }
    } catch (error) {
      console.error('Failed to register metadata:', error)
      return { ...uploadResult, registered: false, registrationError: error.message }
    }
  }

  return { ...uploadResult, registered: false }
}

// ==========================================
// Encrypted Envelope IPFS Functions
// ==========================================

/**
 * Upload an encrypted envelope to IPFS
 * This is the recommended approach for private market metadata:
 * - Encrypted envelope is stored on IPFS (private, off-chain)
 * - Only the CID is stored on-chain (public, minimal gas)
 *
 * @param {Object} envelope - The encrypted envelope object (from envelopeEncryption)
 * @param {Object} options - Upload options
 * @param {string} options.marketType - Type of market (e.g., 'oneVsOne', 'smallGroup')
 * @returns {Promise<{cid: string, uri: string, size: number}>} Upload result
 */
export const uploadEncryptedEnvelope = async (envelope, options = {}) => {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Envelope must be a valid object')
  }

  // Code-keyed envelopes (feature 024, open challenges) have NO recipients `keys` list — readability is by
  // the code-derived symmetric key, not registered recipient keys — so the keys checks don't apply to them.
  const isCodeKeyed = envelope.mode === 'code'

  // Validate it looks like an encrypted envelope
  if (!envelope.version || !envelope.algorithm || !envelope.content || (!isCodeKeyed && !envelope.keys)) {
    throw new Error('Invalid envelope format: missing required fields (version, algorithm, content, keys)')
  }

  // Validate keys is an array (recipient-keyed only)
  if (!isCodeKeyed && !Array.isArray(envelope.keys)) {
    throw new Error('Invalid envelope format: keys must be an array')
  }

  // Validate content structure
  if (typeof envelope.content.nonce !== 'string' || typeof envelope.content.ciphertext !== 'string') {
    throw new Error('Invalid envelope format: content must have nonce and ciphertext strings')
  }

  // Validate supported algorithms
  const supportedAlgorithms = ['x25519-chacha20poly1305', 'xwing-chacha20poly1305', 'code-xchacha20poly1305']
  if (!supportedAlgorithms.includes(envelope.algorithm)) {
    throw new Error(`Unsupported envelope algorithm: ${envelope.algorithm}`)
  }

  const namePrefix = options.marketType
    ? `encrypted-market-${options.marketType}`
    : 'encrypted-envelope'

  const result = await uploadJson(envelope, { namePrefix })

  console.log('Encrypted envelope uploaded to IPFS:', {
    cid: result.cid,
    algorithm: envelope.algorithm,
    recipientCount: envelope.keys?.length || 0,
    size: result.size
  })

  return result
}

/**
 * Fetch an encrypted envelope from IPFS
 * Returns the raw envelope object for decryption by the caller
 *
 * @param {string} cid - IPFS content identifier
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} The encrypted envelope object
 */
export const fetchEncryptedEnvelope = async (cid, options = {}) => {
  if (!cid) {
    throw new Error('CID is required')
  }

  const envelope = await fetchByCid(cid, options)

  // Validate it looks like an encrypted envelope
  if (!envelope || !envelope.version || !envelope.algorithm) {
    throw new Error('Fetched data is not a valid encrypted envelope')
  }

  // Validate content structure
  if (!envelope.content || typeof envelope.content.nonce !== 'string' || typeof envelope.content.ciphertext !== 'string') {
    throw new Error('Fetched envelope has invalid content structure: missing nonce or ciphertext')
  }

  // Validate keys is an array (recipient-keyed only). Code-keyed envelopes (feature 024) have no recipients
  // list — readability is by the code-derived symmetric key.
  if (envelope.mode !== 'code' && !Array.isArray(envelope.keys)) {
    throw new Error('Fetched envelope has invalid keys: must be an array')
  }

  console.log('Fetched encrypted envelope from IPFS:', {
    cid,
    algorithm: envelope.algorithm,
    version: envelope.version,
    recipientCount: envelope.keys?.length || 0
  })

  return envelope
}

/**
 * Check if a description field contains an IPFS CID reference
 * Supports formats:
 * - Raw CID: "bafybeic..."
 * - IPFS URI: "ipfs://bafybeic..."
 * - Prefixed: "encrypted:ipfs://bafybeic..."
 *
 * @param {string} description - The description field from on-chain market data
 * @returns {{ isIpfs: boolean, cid: string | null }} Detection result
 */
export const parseEncryptedIpfsReference = (description) => {
  if (!description || typeof description !== 'string') {
    return { isIpfs: false, cid: null }
  }

  // Check for "encrypted:ipfs://" prefix (our standard format)
  if (description.startsWith('encrypted:ipfs://')) {
    const cid = description.replace('encrypted:ipfs://', '').trim()
    if (isValidCid(cid)) {
      return { isIpfs: true, cid }
    }
  }

  // Check for plain "ipfs://" prefix
  if (description.startsWith('ipfs://')) {
    const cid = description.replace('ipfs://', '').split('/')[0].trim()
    if (isValidCid(cid)) {
      return { isIpfs: true, cid }
    }
  }

  // Check for raw CID (starts with 'bafy' for CIDv1 or 'Qm' for CIDv0)
  const trimmed = description.trim()
  if (isValidCid(trimmed)) {
    return { isIpfs: true, cid: trimmed }
  }

  return { isIpfs: false, cid: null }
}

/**
 * Build the on-chain reference string for an encrypted IPFS envelope
 * This is what gets stored on-chain instead of the full encrypted envelope
 *
 * @param {string} cid - The IPFS CID of the uploaded envelope
 * @returns {string} The reference string to store on-chain
 */
export const buildEncryptedIpfsReference = (cid) => {
  if (!cid || !isValidCid(cid)) {
    throw new Error('Invalid CID')
  }
  return `encrypted:ipfs://${cid}`
}
