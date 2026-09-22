/**
 * RSA Accumulator Library
 *
 * Provides cryptographic RSA accumulator operations for managing nullified markets and addresses.
 * This library is used by the frontend to:
 * 1. Compute prime representatives from market/address hashes
 * 2. Generate non-membership proofs
 * 3. Verify that elements are not in the nullified set
 *
 * Security Properties:
 * - RSA modulus is a product of two safe primes (2048-bit)
 * - Elements are mapped to prime numbers for security
 * - Non-membership proofs are based on Bezout's identity
 *
 * @module rsaAccumulator
 */

import { encodePacked, keccak256 } from 'viem'
// ============================================================================
// Constants
// ============================================================================

// Default RSA parameters (2048-bit) - Replace with production parameters from contract
// These are EXAMPLE values for development. Real deployment requires trusted setup.
// NOTE: The default values are set to null to force loading from the contract.
// Using hardcoded values could break cryptographic security if not properly generated.
export const DEFAULT_RSA_PARAMS = {
  // Must be loaded from contract - no default to prevent security issues
  n: null,
  // Generator (typically 2 or a quadratic residue)
  g: BigInt(2)
}

// Miller-Rabin deterministic witnesses for numbers up to 2^64
const SMALL_WITNESSES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]

// ============================================================================
// RSA Accumulator Class
// ============================================================================

/**
 * RSA Accumulator for managing set membership
 */
export class RSAAccumulator {
  /**
   * Create an RSA Accumulator instance
   * @param {bigint} n - RSA modulus
   * @param {bigint} g - Generator
   */
  constructor(n, g) {
    this.n = n
    this.g = g
    this.accumulator = g // Initial accumulator value is the generator
    this.elements = new Set() // Track accumulated elements (primes)
  }

  /**
   * Initialize from contract parameters
   * @param {string} nHex - RSA modulus as hex string
   * @param {string} gHex - Generator as hex string
   * @param {string} accumulatorHex - Current accumulator value as hex string
   * @returns {RSAAccumulator}
   */
  static fromContractParams(nHex, gHex, accumulatorHex) {
    const instance = new RSAAccumulator(
      BigInt(nHex),
      BigInt(gHex)
    )
    instance.accumulator = BigInt(accumulatorHex)
    return instance
  }

  /**
   * Add an element to the accumulator
   * @param {bigint} prime - Prime representative of the element
   * @returns {bigint} New accumulator value
   */
  add(prime) {
    if (this.elements.has(prime)) {
      return this.accumulator // Already added
    }

    // A' = A^prime mod n
    this.accumulator = modPow(this.accumulator, prime, this.n)
    this.elements.add(prime)
    return this.accumulator
  }

  /**
   * Batch add multiple elements
   * @param {bigint[]} primes - Array of prime representatives
   * @returns {bigint} New accumulator value
   */
  batchAdd(primes) {
    let product = 1n
    for (const prime of primes) {
      if (!this.elements.has(prime)) {
        product *= prime
        this.elements.add(prime)
      }
    }

    if (product > 1n) {
      this.accumulator = modPow(this.accumulator, product, this.n)
    }

    return this.accumulator
  }

  /**
   * Remove an element from the accumulator (requires knowing all elements)
   * @param {bigint} prime - Prime to remove
   * @returns {bigint} New accumulator value
   */
  remove(prime) {
    if (!this.elements.has(prime)) {
      return this.accumulator // Not in set
    }

    this.elements.delete(prime)

    // Recompute accumulator from scratch
    this.accumulator = this.g
    for (const p of this.elements) {
      this.accumulator = modPow(this.accumulator, p, this.n)
    }

    return this.accumulator
  }

  /**
   * Generate membership witness for an element
   * @param {bigint} prime - Prime to generate witness for
   * @returns {bigint|null} Membership witness or null if not member
   */
  generateMembershipWitness(prime) {
    if (!this.elements.has(prime)) {
      return null // Not a member
    }

    // Compute product of all OTHER primes
    let product = 1n
    for (const p of this.elements) {
      if (p !== prime) {
        product *= p
      }
    }

    // Witness = g^(product) mod n
    return modPow(this.g, product, this.n)
  }

  /**
   * Verify membership using witness
   * @param {bigint} prime - Prime to verify
   * @param {bigint} witness - Membership witness
   * @returns {boolean} True if witness proves membership
   */
  verifyMembership(prime, witness) {
    // witness^prime should equal accumulator
    const result = modPow(witness, prime, this.n)
    return result === this.accumulator
  }

  /**
   * Generate non-membership witness using extended Euclidean algorithm
   * @param {bigint} prime - Prime to prove non-membership for
   * @returns {Object|null} Non-membership witness {d, b, dNegative} or null if member
   */
  generateNonMembershipWitness(prime) {
    if (this.elements.has(prime)) {
      return null // Is a member, cannot prove non-membership
    }

    // Compute product of all accumulated primes
    let product = 1n
    for (const p of this.elements) {
      product *= p
    }

    // Use extended Euclidean algorithm to find d, e such that:
    // product * d + prime * e = gcd(product, prime) = 1 (since all are coprime primes)
    const { gcd, x: d, y: e } = extendedGcd(product, prime)

    if (gcd !== 1n) {
      // Should not happen if prime is truly coprime to all accumulated elements
      console.warn('GCD is not 1, elements may not be properly coprime')
      return null
    }

    // Non-membership witness:
    // A^d * b^prime = g (where b = g^e)
    // If d is negative, we store |d| and a flag
    const dNegative = d < 0n
    const dAbs = dNegative ? -d : d

    // b = g^e mod n (if e is negative, compute inverse)
    let b
    if (e < 0n) {
      const gPowAbsE = modPow(this.g, -e, this.n)
      b = modInverse(gPowAbsE, this.n)
    } else {
      b = modPow(this.g, e, this.n)
    }

    return {
      d: dAbs,
      b: b,
      dNegative: dNegative
    }
  }

  /**
   * Verify non-membership witness
   * @param {bigint} prime - Prime to verify non-membership for
   * @param {Object} witness - Non-membership witness {d, b, dNegative}
   * @returns {boolean} True if witness proves non-membership
   */
  verifyNonMembership(prime, witness) {
    const { d, b, dNegative } = witness

    // Compute A^d (or A^(-d) if dNegative)
    let aPowD
    if (dNegative) {
      const aPowAbsD = modPow(this.accumulator, d, this.n)
      aPowD = modInverse(aPowAbsD, this.n)
    } else {
      aPowD = modPow(this.accumulator, d, this.n)
    }

    // Compute b^prime mod n
    const bPowPrime = modPow(b, prime, this.n)

    // Check: A^d * b^prime == g (mod n)
    const product = (aPowD * bPowPrime) % this.n
    return product === this.g
  }

  /**
   * Get current accumulator value
   * @returns {bigint}
   */
  getValue() {
    return this.accumulator
  }

  /**
   * Get number of accumulated elements
   * @returns {number}
   */
  size() {
    return this.elements.size
  }

  /**
   * Check if an element is in the accumulated set (local check)
   * @param {bigint} prime - Prime to check
   * @returns {boolean}
   */
  has(prime) {
    return this.elements.has(prime)
  }

  /**
   * Export state for persistence
   * @returns {Object}
   */
  toJSON() {
    return {
      n: this.n.toString(16),
      g: this.g.toString(16),
      accumulator: this.accumulator.toString(16),
      elements: Array.from(this.elements).map(e => e.toString(16))
    }
  }

  /**
   * Import state from persistence
   * @param {Object} json
   * @returns {RSAAccumulator}
   */
  static fromJSON(json) {
    const instance = new RSAAccumulator(
      BigInt('0x' + json.n),
      BigInt('0x' + json.g)
    )
    instance.accumulator = BigInt('0x' + json.accumulator)
    instance.elements = new Set(json.elements.map(e => BigInt('0x' + e)))
    return instance
  }
}

// ============================================================================
// Prime Mapping Functions
// ============================================================================

/**
 * Convert a keccak256 hash to a deterministic prime number
 * @param {string} hash - The keccak256 hash (0x prefixed hex string)
 * @returns {bigint} Prime representative
 */
export function hashToPrime(hash) {
  // Start with hash value, ensure it's odd
  let candidate = BigInt(hash) | 1n

  // Search for first prime >= candidate
  let iterations = 0
  const maxIterations = 1000

  while (!isProbablePrime(candidate) && iterations < maxIterations) {
    candidate += 2n // Only check odd numbers
    iterations++
  }

  if (iterations >= maxIterations) {
    throw new Error('Prime search exceeded maximum iterations')
  }

  return candidate
}

/**
 * Compute market hash for nullification
 * @param {Object} marketData - Market data object
 * @param {number|bigint} marketData.proposalId
 * @param {string} marketData.collateralToken
 * @param {string} marketData.conditionId
 * @param {number|bigint} marketData.passPositionId
 * @param {number|bigint} marketData.failPositionId
 * @returns {string} Keccak256 hash
 */
export function computeMarketHash(marketData) {
  const { proposalId, collateralToken, conditionId, passPositionId, failPositionId } = marketData

  return keccak256(encodePacked(
    ['string', 'uint256', 'address', 'bytes32', 'uint256', 'uint256'],
    ['MARKET_V1', proposalId, collateralToken, conditionId, passPositionId, failPositionId]
  ))
}

/**
 * Compute simple market hash (market factory + ID)
 * @param {string} marketFactory - Market factory address
 * @param {number|bigint} marketId - Market ID
 * @returns {string} Keccak256 hash
 */
export function computeMarketHashSimple(marketFactory, marketId) {
  return keccak256(encodePacked(
    ['string', 'address', 'uint256'],
    ['MARKET_SIMPLE_V1', marketFactory, marketId]
  ))
}

/**
 * Compute address hash for nullification
 * @param {string} address - Ethereum address
 * @returns {string} Keccak256 hash
 */
export function computeAddressHash(address) {
  return keccak256(encodePacked(
    ['string', 'address'],
    ['ADDRESS_V1', address]
  ))
}

/**
 * Convert market data to prime representative
 * @param {Object} marketData - Market data object
 * @returns {bigint} Prime representative
 */
export function marketToPrime(marketData) {
  const hash = computeMarketHash(marketData)
  return hashToPrime(hash)
}

/**
 * Convert address to prime representative
 * @param {string} address - Ethereum address
 * @returns {bigint} Prime representative
 */
export function addressToPrime(address) {
  const hash = computeAddressHash(address)
  return hashToPrime(hash)
}

// ============================================================================
// Primality Testing (Miller-Rabin)
// ============================================================================

/**
 * Test if a number is probably prime using Miller-Rabin
 * @param {bigint} n - Number to test
 * @returns {boolean} True if probably prime
 */
export function isProbablePrime(n) {
  if (n < 2n) return false
  if (n === 2n || n === 3n) return true
  if (n % 2n === 0n) return false
  if (n < 9n) return true
  if (n % 3n === 0n) return false

  // Write n-1 as 2^r * d where d is odd
  let d = n - 1n
  let r = 0n
  while (d % 2n === 0n) {
    d /= 2n
    r++
  }

  // Test with deterministic witnesses
  for (const a of SMALL_WITNESSES) {
    if (a >= n - 1n) continue
    if (!millerRabinRound(n, d, r, a)) {
      return false
    }
  }

  return true
}

/**
 * Single round of Miller-Rabin test
 * @param {bigint} n - Number to test
 * @param {bigint} d - Odd factor of n-1
 * @param {bigint} r - Power of 2 in n-1
 * @param {bigint} a - Witness
 * @returns {boolean} True if n passes this round
 */
function millerRabinRound(n, d, r, a) {
  // Compute a^d mod n
  let x = modPow(a, d, n)

  if (x === 1n || x === n - 1n) {
    return true
  }

  for (let i = 1n; i < r; i++) {
    x = (x * x) % n
    if (x === n - 1n) {
      return true
    }
    if (x === 1n) {
      return false
    }
  }

  return false
}

// ============================================================================
// Modular Arithmetic
// ============================================================================

/**
 * Modular exponentiation: base^exp mod mod
 * @param {bigint} base
 * @param {bigint} exp
 * @param {bigint} mod
 * @returns {bigint}
 */
export function modPow(base, exp, mod) {
  if (mod === 1n) return 0n

  let result = 1n
  base = base % mod

  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = (result * base) % mod
    }
    exp = exp >> 1n
    base = (base * base) % mod
  }

  return result
}

/**
 * Modular inverse using extended Euclidean algorithm
 * @param {bigint} a
 * @param {bigint} mod
 * @returns {bigint} a^(-1) mod mod
 */
export function modInverse(a, mod) {
  const { gcd, x } = extendedGcd(a, mod)
  if (gcd !== 1n) {
    throw new Error('Modular inverse does not exist')
  }
  return ((x % mod) + mod) % mod
}

/**
 * Extended Euclidean Algorithm
 * Returns gcd and Bezout coefficients x, y such that ax + by = gcd(a, b)
 * @param {bigint} a
 * @param {bigint} b
 * @returns {Object} {gcd, x, y}
 */
export function extendedGcd(a, b) {
  if (b === 0n) {
    return { gcd: a, x: 1n, y: 0n }
  }

  const { gcd, x: x1, y: y1 } = extendedGcd(b, a % b)
  return {
    gcd,
    x: y1,
    y: x1 - (a / b) * y1
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert bigint to hex string (0x prefixed)
 * @param {bigint} n
 * @returns {string}
 */
export function bigintToHex(n) {
  return '0x' + n.toString(16)
}

/**
 * Convert bigint to bytes (Uint8Array)
 * @param {bigint} n
 * @param {number} length - Desired byte length
 * @returns {Uint8Array}
 */
export function bigintToBytes(n, length = 32) {
  const hex = n.toString(16).padStart(length * 2, '0')
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Convert bytes to bigint
 * @param {Uint8Array|string} bytes
 * @returns {bigint}
 */
export function bytesToBigint(bytes) {
  if (typeof bytes === 'string') {
    return BigInt(bytes)
  }
  let hex = '0x'
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return BigInt(hex)
}

/**
 * Batch verify multiple elements are not nullified
 * @param {RSAAccumulator} accumulator - Accumulator instance
 * @param {bigint[]} primes - Array of primes to check
 * @param {Object[]} witnesses - Array of non-membership witnesses
 * @returns {boolean[]} Array of verification results
 */
export function batchVerifyNonMembership(accumulator, primes, witnesses) {
  return primes.map((prime, i) => {
    try {
      return accumulator.verifyNonMembership(prime, witnesses[i])
    } catch {
      return false
    }
  })
}

/**
 * Create accumulator from nullified set
 * @param {bigint[]} nullifiedPrimes - Array of nullified element primes
 * @param {bigint} n - RSA modulus
 * @param {bigint} g - Generator
 * @returns {RSAAccumulator}
 */
export function createAccumulatorFromSet(nullifiedPrimes, n = DEFAULT_RSA_PARAMS.n, g = DEFAULT_RSA_PARAMS.g) {
  const accumulator = new RSAAccumulator(n, g)
  accumulator.batchAdd(nullifiedPrimes)
  return accumulator
}

// Export default accumulator instance for convenience
export const defaultAccumulator = new RSAAccumulator(DEFAULT_RSA_PARAMS.n, DEFAULT_RSA_PARAMS.g)
