/**
 * Prime Mapping Utilities
 *
 * High-level utilities for mapping market data and addresses to prime numbers
 * for use with the RSA accumulator nullification system.
 *
 * @module primeMapping
 */

import { isAddress } from 'viem'
import {
  hashToPrime,
  computeMarketHash,
  computeAddressHash,
  isProbablePrime,
  bigintToHex,
  computeMarketHashSimple
} from './rsaAccumulator'

// Re-export for convenience
export { computeMarketHashSimple }

// ============================================================================
// Market Prime Mapping
// ============================================================================

/**
 * Compute the nullification prime for a market
 * @param {Object} market - Market object from contract or API
 * @returns {Object} {hash, prime} - Market hash and its prime representative
 */
export function getMarketNullificationData(market) {
  // Extract required fields from market
  const marketData = {
    proposalId: BigInt(market.proposalId || market.id || 0),
    collateralToken: market.collateralToken || market.collateral,
    conditionId: market.conditionId || '0x' + '0'.repeat(64),
    passPositionId: BigInt(market.passPositionId || 0),
    failPositionId: BigInt(market.failPositionId || 0)
  }

  const hash = computeMarketHash(marketData)
  const prime = hashToPrime(hash)

  return { hash, prime, marketData }
}

/**
 * Compute prime for multiple markets
 * @param {Object[]} markets - Array of market objects
 * @returns {Object[]} Array of {marketId, hash, prime}
 */
export function batchGetMarketPrimes(markets) {
  return markets.map(market => {
    const { hash, prime } = getMarketNullificationData(market)
    return {
      marketId: market.id || market.marketId,
      hash,
      prime
    }
  })
}

/**
 * Create market data object from individual fields
 * @param {Object} params
 * @returns {Object} Market data for hashing
 */
export function createMarketData({
  proposalId,
  collateralToken,
  conditionId,
  passPositionId,
  failPositionId
}) {
  return {
    proposalId: BigInt(proposalId),
    collateralToken,
    conditionId,
    passPositionId: BigInt(passPositionId),
    failPositionId: BigInt(failPositionId)
  }
}

// ============================================================================
// Address Prime Mapping
// ============================================================================

/**
 * Compute the nullification prime for an address
 * @param {string} address - Ethereum address
 * @returns {Object} {hash, prime} - Address hash and its prime representative
 */
export function getAddressNullificationData(address) {
  if (!isAddress(address)) {
    throw new Error('Invalid Ethereum address')
  }

  const hash = computeAddressHash(address)
  const prime = hashToPrime(hash)

  return { hash, prime, address }
}

/**
 * Compute primes for multiple addresses
 * @param {string[]} addresses - Array of Ethereum addresses
 * @returns {Object[]} Array of {address, hash, prime}
 */
export function batchGetAddressPrimes(addresses) {
  return addresses.map(address => {
    const { hash, prime } = getAddressNullificationData(address)
    return { address, hash, prime }
  })
}

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Verify a claimed prime is correctly derived from a market hash
 * @param {string} marketHash - The market hash (0x prefixed)
 * @param {bigint|string} claimedPrime - The claimed prime
 * @returns {boolean} True if prime is correct
 */
export function verifyMarketPrime(marketHash, claimedPrime) {
  const prime = typeof claimedPrime === 'bigint' ? claimedPrime : BigInt(claimedPrime)

  // Check it's actually prime
  if (!isProbablePrime(prime)) {
    return false
  }

  // Check it matches the expected prime
  const expectedPrime = hashToPrime(marketHash)
  return prime === expectedPrime
}

/**
 * Verify a claimed prime is correctly derived from an address
 * @param {string} address - The address
 * @param {bigint|string} claimedPrime - The claimed prime
 * @returns {boolean} True if prime is correct
 */
export function verifyAddressPrime(address, claimedPrime) {
  const prime = typeof claimedPrime === 'bigint' ? claimedPrime : BigInt(claimedPrime)

  if (!isProbablePrime(prime)) {
    return false
  }

  const { prime: expectedPrime } = getAddressNullificationData(address)
  return prime === expectedPrime
}

// ============================================================================
// Nullification Set Management
// ============================================================================

/**
 * Create a nullification set from market and address data
 * @param {Object[]} nullifiedMarkets - Array of nullified market objects
 * @param {string[]} nullifiedAddresses - Array of nullified addresses
 * @returns {Object} {marketPrimes, addressPrimes, allPrimes}
 */
export function createNullificationSet(nullifiedMarkets = [], nullifiedAddresses = []) {
  const marketPrimes = batchGetMarketPrimes(nullifiedMarkets)
  const addressPrimes = batchGetAddressPrimes(nullifiedAddresses)

  const allPrimes = [
    ...marketPrimes.map(m => m.prime),
    ...addressPrimes.map(a => a.prime)
  ]

  return {
    marketPrimes,
    addressPrimes,
    allPrimes,
    marketHashes: new Set(marketPrimes.map(m => m.hash)),
    addressHashes: new Set(addressPrimes.map(a => a.hash))
  }
}

/**
 * Check if a market is in the nullification set
 * @param {Object} market - Market object
 * @param {Set} marketHashes - Set of nullified market hashes
 * @returns {boolean}
 */
export function isMarketInNullificationSet(market, marketHashes) {
  const { hash } = getMarketNullificationData(market)
  return marketHashes.has(hash)
}

/**
 * Check if an address is in the nullification set
 * @param {string} address - Ethereum address
 * @param {Set} addressHashes - Set of nullified address hashes
 * @returns {boolean}
 */
export function isAddressInNullificationSet(address, addressHashes) {
  const { hash } = getAddressNullificationData(address)
  return addressHashes.has(hash)
}

/**
 * Filter markets to exclude nullified ones
 * @param {Object[]} markets - Array of market objects
 * @param {Set} marketHashes - Set of nullified market hashes
 * @returns {Object[]} Filtered markets
 */
export function filterNullifiedMarkets(markets, marketHashes) {
  return markets.filter(market => !isMarketInNullificationSet(market, marketHashes))
}

// ============================================================================
// Encoding/Decoding for Contract Interaction
// ============================================================================

/**
 * Encode a prime for contract call (as bytes32)
 * @param {bigint} prime
 * @returns {string} Hex string padded to 32 bytes
 */
export function encodePrimeForContract(prime) {
  return '0x' + prime.toString(16).padStart(64, '0')
}

/**
 * Decode a prime from contract response
 * @param {string} encoded - Hex string
 * @returns {bigint}
 */
export function decodePrimeFromContract(encoded) {
  return BigInt(encoded)
}

/**
 * Prepare market hash for contract call
 * @param {Object} market - Market object
 * @returns {string} bytes32 hash
 */
export function prepareMarketHashForContract(market) {
  const { hash } = getMarketNullificationData(market)
  return hash
}

/**
 * Prepare witness data for contract verification
 * @param {Object} witness - Witness object {d, b, dNegative}
 * @returns {Object} Encoded witness data for contract
 */
export function prepareWitnessForContract(witness) {
  return {
    witnessD: bigintToHex(witness.d),
    witnessB: bigintToHex(witness.b),
    dNegative: witness.dNegative
  }
}

// ============================================================================
// Local Storage Helpers
// ============================================================================

const NULLIFICATION_CACHE_KEY = 'nullification_cache'

/**
 * Cache nullification data in local storage
 * @param {Object} data - Nullification data to cache
 */
export function cacheNullificationData(data) {
  try {
    const cacheData = {
      timestamp: Date.now(),
      marketHashes: Array.from(data.marketHashes),
      addressHashes: Array.from(data.addressHashes),
      accumulator: data.accumulator?.toString(16)
    }
    localStorage.setItem(NULLIFICATION_CACHE_KEY, JSON.stringify(cacheData))
  } catch (error) {
    console.warn('Failed to cache nullification data:', error)
  }
}

/**
 * Load cached nullification data
 * @param {number} maxAge - Maximum cache age in milliseconds (default: 5 minutes)
 * @returns {Object|null} Cached data or null if expired/missing
 */
export function loadCachedNullificationData(maxAge = 5 * 60 * 1000) {
  try {
    const cached = localStorage.getItem(NULLIFICATION_CACHE_KEY)
    if (!cached) return null

    const data = JSON.parse(cached)
    if (Date.now() - data.timestamp > maxAge) {
      localStorage.removeItem(NULLIFICATION_CACHE_KEY)
      return null
    }

    return {
      marketHashes: new Set(data.marketHashes),
      addressHashes: new Set(data.addressHashes),
      accumulator: data.accumulator ? BigInt('0x' + data.accumulator) : null,
      timestamp: data.timestamp
    }
  } catch (error) {
    console.warn('Failed to load cached nullification data:', error)
    return null
  }
}

/**
 * Clear nullification cache
 */
export function clearNullificationCache() {
  localStorage.removeItem(NULLIFICATION_CACHE_KEY)
}

// ============================================================================
// Export all functions
// ============================================================================

export {
  hashToPrime,
  computeMarketHash,
  computeAddressHash,
  isProbablePrime
} from './rsaAccumulator'
