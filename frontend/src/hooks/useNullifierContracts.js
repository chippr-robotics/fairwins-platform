/**
 * useNullifierContracts Hook
 *
 * Provides React hook for interacting with the NullifierRegistry smart contract.
 * Handles:
 * - Contract state fetching
 * - Market/address nullification operations
 * - Accumulator management
 * - Role verification
 *
 * @module useNullifierContracts
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import { encodeFunctionData, keccak256, stringToHex } from 'viem'
import { readContract as readOnChain, normalizeAbi } from '../lib/chains/readContract'
import { NULLIFIER_REGISTRY_ABI } from '../abis/NullifierRegistry'
import { getMarketNullificationData } from '../utils/primeMapping'
import { getContractAddress, NETWORK_CONFIG } from '../config/contracts'

// Contract address - from contracts.js config (with env override)
const NULLIFIER_REGISTRY_ADDRESS = getContractAddress('nullifierRegistry') || null

// Role hash for NULLIFIER_ADMIN_ROLE
const NULLIFIER_ADMIN_ROLE = keccak256(stringToHex('NULLIFIER_ADMIN_ROLE'))

/**
 * The chain this registry lives on.
 *
 * Taken from `NETWORK_CONFIG.chainId`, which IS the same `ACTIVE_CHAIN_ID` that
 * `getContractAddress` resolves the address from — so the address and the chain cannot disagree.
 * Writing the literal here instead would be a second source for the same fact.
 */
const REGISTRY_CHAIN_ID = NETWORK_CONFIG.chainId

// Polling interval for state refresh (5 minutes, reduced from 30s to minimize load)
const REFRESH_INTERVAL = 300000

/**
 * Hook for interacting with NullifierRegistry contract
 * @param {Object} options
 * @param {Object} options.signer - ethers signer for write operations
 * @param {Object} options.provider - ethers provider for read operations
 * @param {string} options.account - Connected account address
 * @returns {Object} Contract state and functions
 */
export function useNullifierContracts({ signer, provider, account } = {}) {
  // State
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [nullifierState, setNullifierState] = useState({
    nullifiedMarketCount: 0,
    nullifiedAddressCount: 0,
    totalNullifications: 0,
    totalReinstatements: 0,
    lastAccumulatorUpdate: 0,
    paramsInitialized: false,
    paused: false,
    accumulator: null,
    rsaParams: { n: null, g: null }
  })
  const [nullifiedMarkets, setNullifiedMarkets] = useState([])
  const [nullifiedAddresses, setNullifiedAddresses] = useState([])
  const [hasNullifierRole, setHasNullifierRole] = useState(false)

  // Check if registry is available
  const isRegistryAvailable = !!NULLIFIER_REGISTRY_ADDRESS

  // Get contract instance
  /**
   * Reads. `provider` stays the availability gate exactly as it was — a null one meant no contract
   * instance and every caller already guards on that.
   *
   * NOTE for anyone touching the call sites: `getStats` is a FIVE-output view read BY NAME
   * (`stats.markets`, `stats.addresses`, …). That is spec 110 divergence (a) — viem returns a bare
   * array where ethers returned a named Result — and it is silent: without the seam's
   * `withOutputNames` every one of those counters becomes `Number(undefined)`, i.e. NaN on the
   * screen. The seam handles it and has its own test; do not bypass it with a raw viem call.
   */
  const readRegistry = useMemo(() => {
    if (!NULLIFIER_REGISTRY_ADDRESS || !provider) return null
    return (functionName, args = []) =>
      readOnChain(REGISTRY_CHAIN_ID, {
        address: NULLIFIER_REGISTRY_ADDRESS,
        abi: NULLIFIER_REGISTRY_ABI,
        functionName,
        args,
      })
  }, [provider])

  const writeRegistry = useMemo(() => {
    if (!NULLIFIER_REGISTRY_ADDRESS || !signer) return null
    return (functionName, args = []) =>
      signer.sendTransaction({
        to: NULLIFIER_REGISTRY_ADDRESS,
        data: encodeFunctionData({
          abi: normalizeAbi(NULLIFIER_REGISTRY_ABI),
          functionName,
          args,
        }),
      })
  }, [signer])

  // ========== Fetch Functions ==========

  /**
   * Fetch current nullifier state from contract
   */
  const fetchNullifierState = useCallback(async () => {
    if (!readRegistry) return

    setIsLoading(true)
    setError(null)

    try {
      const [stats, paramsInitialized, paused, accumulator] = await Promise.all([
        readRegistry('getStats'),
        readRegistry('paramsInitialized'),
        readRegistry('paused'),
        readRegistry('getAccumulator')
      ])

      let rsaParams = { n: null, g: null }
      if (paramsInitialized) {
        const [n, g] = await readRegistry('getRSAParams')
        rsaParams = { n, g }
      }

      setNullifierState({
        nullifiedMarketCount: Number(stats.markets),
        nullifiedAddressCount: Number(stats.addresses),
        totalNullifications: Number(stats.nullifications),
        totalReinstatements: Number(stats.reinstatements),
        lastAccumulatorUpdate: Number(stats.lastUpdate),
        paramsInitialized,
        paused,
        accumulator,
        rsaParams
      })
    } catch (err) {
      console.error('Error fetching nullifier state:', err)
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }, [readRegistry])

  /**
   * Fetch all nullified markets
   */
  const fetchNullifiedMarkets = useCallback(async () => {
    if (!readRegistry) return []

    try {
      const markets = []
      let offset = 0
      const limit = 50
      let hasMore = true

      while (hasMore) {
        const [hashes, more] = await readRegistry('getNullifiedMarkets', [offset, limit])
        markets.push(...hashes)
        hasMore = more
        offset += limit
      }

      setNullifiedMarkets(markets)
      return markets
    } catch (err) {
      console.error('Error fetching nullified markets:', err)
      setError(err.message)
      return []
    }
  }, [readRegistry])

  /**
   * Fetch all nullified addresses
   */
  const fetchNullifiedAddresses = useCallback(async () => {
    if (!readRegistry) return []

    try {
      const addresses = []
      let offset = 0
      const limit = 50
      let hasMore = true

      while (hasMore) {
        const [addrs, more] = await readRegistry('getNullifiedAddresses', [offset, limit])
        addresses.push(...addrs)
        hasMore = more
        offset += limit
      }

      setNullifiedAddresses(addresses)
      return addresses
    } catch (err) {
      console.error('Error fetching nullified addresses:', err)
      setError(err.message)
      return []
    }
  }, [readRegistry])

  /**
   * Check if current account has NULLIFIER_ADMIN_ROLE
   */
  const checkNullifierRole = useCallback(async () => {
    if (!readRegistry || !account) {
      setHasNullifierRole(false)
      return false
    }

    try {
      const hasRole = await readRegistry('hasRole', [NULLIFIER_ADMIN_ROLE, account])
      setHasNullifierRole(hasRole)
      return hasRole
    } catch (err) {
      console.error('Error checking nullifier role:', err)
      setHasNullifierRole(false)
      return false
    }
  }, [readRegistry, account])

  // ========== Query Functions ==========

  /**
   * Check if a market is nullified
   * @param {string} marketHash - Market hash (bytes32)
   * @returns {Promise<boolean>}
   */
  const isMarketNullified = useCallback(async (marketHash) => {
    if (!readRegistry) return false
    try {
      return await readRegistry('isMarketNullified', [marketHash])
    } catch (err) {
      console.error('Error checking market nullification:', err)
      return false
    }
  }, [readRegistry])

  /**
   * Check if an address is nullified
   * @param {string} address - Ethereum address
   * @returns {Promise<boolean>}
   */
  const isAddressNullified = useCallback(async (address) => {
    if (!readRegistry) return false
    try {
      return await readRegistry('isAddressNullified', [address])
    } catch (err) {
      console.error('Error checking address nullification:', err)
      return false
    }
  }, [readRegistry])

  /**
   * Get market nullification details
   * @param {string} marketHash
   * @returns {Promise<Object>}
   */
  const getMarketDetails = useCallback(async (marketHash) => {
    if (!readRegistry) return null
    try {
      const [nullified, timestamp, admin] = await readRegistry('getMarketNullificationDetails', [marketHash])
      return { nullified, timestamp: Number(timestamp), admin }
    } catch (err) {
      console.error('Error getting market details:', err)
      return null
    }
  }, [readRegistry])

  /**
   * Get address nullification details
   * @param {string} address
   * @returns {Promise<Object>}
   */
  const getAddressDetails = useCallback(async (address) => {
    if (!readRegistry) return null
    try {
      const [nullified, timestamp, admin] = await readRegistry('getAddressNullificationDetails', [address])
      return { nullified, timestamp: Number(timestamp), admin }
    } catch (err) {
      console.error('Error getting address details:', err)
      return null
    }
  }, [readRegistry])

  // ========== Write Functions ==========

  /**
   * Nullify a market
   * @param {Object} market - Market object with data for hash computation
   * @param {number} marketId - Market ID for logging
   * @param {string} reason - Reason for nullification
   * @returns {Promise<Object>} Transaction result
   */
  const nullifyMarket = useCallback(async (market, marketId, reason = 'Admin action') => {
    if (!writeRegistry) throw new Error('Wallet not connected')
    if (!hasNullifierRole) throw new Error('Requires NULLIFIER_ADMIN_ROLE')

    setIsLoading(true)
    setError(null)

    try {
      const { hash } = getMarketNullificationData(market)

      const tx = await writeRegistry('nullifyMarket', [hash, marketId, reason])
      const receipt = await tx.wait()

      await fetchNullifierState()
      await fetchNullifiedMarkets()

      return { success: true, hash: tx.hash, receipt }
    } catch (err) {
      console.error('Error nullifying market:', err)
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [writeRegistry, hasNullifierRole, fetchNullifierState, fetchNullifiedMarkets])

  /**
   * Nullify a market by hash directly
   * @param {string} marketHash - Market hash (bytes32)
   * @param {number} marketId - Market ID for logging
   * @param {string} reason - Reason for nullification
   * @returns {Promise<Object>} Transaction result
   */
  const nullifyMarketByHash = useCallback(async (marketHash, marketId, reason = 'Admin action') => {
    if (!writeRegistry) throw new Error('Wallet not connected')
    if (!hasNullifierRole) throw new Error('Requires NULLIFIER_ADMIN_ROLE')

    setIsLoading(true)
    setError(null)

    try {
      const tx = await writeRegistry('nullifyMarket', [marketHash, marketId, reason])
      const receipt = await tx.wait()

      await fetchNullifierState()
      await fetchNullifiedMarkets()

      return { success: true, hash: tx.hash, receipt }
    } catch (err) {
      console.error('Error nullifying market:', err)
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [writeRegistry, hasNullifierRole, fetchNullifierState, fetchNullifiedMarkets])

  /**
   * Reinstate a nullified market
   * @param {string} marketHash - Market hash (bytes32)
   * @param {number} marketId - Market ID for logging
   * @param {string} reason - Reason for reinstatement
   * @returns {Promise<Object>} Transaction result
   */
  const reinstateMarket = useCallback(async (marketHash, marketId, reason = 'Admin action') => {
    if (!writeRegistry) throw new Error('Wallet not connected')
    if (!hasNullifierRole) throw new Error('Requires NULLIFIER_ADMIN_ROLE')

    setIsLoading(true)
    setError(null)

    try {
      const tx = await writeRegistry('reinstateMarket', [marketHash, marketId, reason])
      const receipt = await tx.wait()

      await fetchNullifierState()
      await fetchNullifiedMarkets()

      return { success: true, hash: tx.hash, receipt }
    } catch (err) {
      console.error('Error reinstating market:', err)
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [writeRegistry, hasNullifierRole, fetchNullifierState, fetchNullifiedMarkets])

  /**
   * Nullify an address
   * @param {string} address - Address to nullify
   * @param {string} reason - Reason for nullification
   * @returns {Promise<Object>} Transaction result
   */
  const nullifyAddress = useCallback(async (address, reason = 'Admin action') => {
    if (!writeRegistry) throw new Error('Wallet not connected')
    if (!hasNullifierRole) throw new Error('Requires NULLIFIER_ADMIN_ROLE')

    setIsLoading(true)
    setError(null)

    try {
      const tx = await writeRegistry('nullifyAddress', [address, reason])
      const receipt = await tx.wait()

      await fetchNullifierState()
      await fetchNullifiedAddresses()

      return { success: true, hash: tx.hash, receipt }
    } catch (err) {
      console.error('Error nullifying address:', err)
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [writeRegistry, hasNullifierRole, fetchNullifierState, fetchNullifiedAddresses])

  /**
   * Reinstate a nullified address
   * @param {string} address - Address to reinstate
   * @param {string} reason - Reason for reinstatement
   * @returns {Promise<Object>} Transaction result
   */
  const reinstateAddress = useCallback(async (address, reason = 'Admin action') => {
    if (!writeRegistry) throw new Error('Wallet not connected')
    if (!hasNullifierRole) throw new Error('Requires NULLIFIER_ADMIN_ROLE')

    setIsLoading(true)
    setError(null)

    try {
      const tx = await writeRegistry('reinstateAddress', [address, reason])
      const receipt = await tx.wait()

      await fetchNullifierState()
      await fetchNullifiedAddresses()

      return { success: true, hash: tx.hash, receipt }
    } catch (err) {
      console.error('Error reinstating address:', err)
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [writeRegistry, hasNullifierRole, fetchNullifierState, fetchNullifiedAddresses])

  /**
   * Batch nullify markets
   * @param {string[]} marketHashes - Array of market hashes
   * @param {number[]} marketIds - Array of market IDs
   * @param {string} reason - Reason for nullification
   * @returns {Promise<Object>} Transaction result
   */
  const batchNullifyMarkets = useCallback(async (marketHashes, marketIds, reason = 'Batch admin action') => {
    if (!writeRegistry) throw new Error('Wallet not connected')
    if (!hasNullifierRole) throw new Error('Requires NULLIFIER_ADMIN_ROLE')

    setIsLoading(true)
    setError(null)

    try {
      const tx = await writeRegistry('batchNullifyMarkets', [marketHashes, marketIds, reason])
      const receipt = await tx.wait()

      await fetchNullifierState()
      await fetchNullifiedMarkets()

      return { success: true, hash: tx.hash, receipt }
    } catch (err) {
      console.error('Error batch nullifying markets:', err)
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [writeRegistry, hasNullifierRole, fetchNullifierState, fetchNullifiedMarkets])

  /**
   * Batch nullify addresses
   * @param {string[]} addresses - Array of addresses
   * @param {string} reason - Reason for nullification
   * @returns {Promise<Object>} Transaction result
   */
  const batchNullifyAddresses = useCallback(async (addresses, reason = 'Batch admin action') => {
    if (!writeRegistry) throw new Error('Wallet not connected')
    if (!hasNullifierRole) throw new Error('Requires NULLIFIER_ADMIN_ROLE')

    setIsLoading(true)
    setError(null)

    try {
      const tx = await writeRegistry('batchNullifyAddresses', [addresses, reason])
      const receipt = await tx.wait()

      await fetchNullifierState()
      await fetchNullifiedAddresses()

      return { success: true, hash: tx.hash, receipt }
    } catch (err) {
      console.error('Error batch nullifying addresses:', err)
      setError(err.message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [writeRegistry, hasNullifierRole, fetchNullifierState, fetchNullifiedAddresses])

  // ========== Effects ==========

  // Initial fetch on mount
  useEffect(() => {
    if (readRegistry) {
      fetchNullifierState()
      fetchNullifiedMarkets()
      fetchNullifiedAddresses()
    }
  }, [readRegistry, fetchNullifierState, fetchNullifiedMarkets, fetchNullifiedAddresses])

  // Check role when account changes
  useEffect(() => {
    checkNullifierRole()
  }, [checkNullifierRole])

  // Periodic refresh
  useEffect(() => {
    if (!readRegistry) return

    const interval = setInterval(() => {
      fetchNullifierState()
    }, REFRESH_INTERVAL)

    return () => clearInterval(interval)
  }, [readRegistry, fetchNullifierState])

  // ========== Return ==========

  return {
    // State
    isLoading,
    error,
    nullifierState,
    nullifiedMarkets,
    nullifiedAddresses,
    hasNullifierRole,
    isRegistryAvailable,

    // Fetch functions
    fetchNullifierState,
    fetchNullifiedMarkets,
    fetchNullifiedAddresses,
    checkNullifierRole,

    // Query functions
    isMarketNullified,
    isAddressNullified,
    getMarketDetails,
    getAddressDetails,

    // Write functions
    nullifyMarket,
    nullifyMarketByHash,
    reinstateMarket,
    nullifyAddress,
    reinstateAddress,
    batchNullifyMarkets,
    batchNullifyAddresses,

    // Utilities
    NULLIFIER_ADMIN_ROLE,
    contractAddress: NULLIFIER_REGISTRY_ADDRESS
  }
}

export default useNullifierContracts
