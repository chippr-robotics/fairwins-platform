import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the IPFS constants module to provide test Pinata credentials
// This prevents "Pinata authentication not configured" errors in upload tests
vi.mock('../constants/ipfs', async (importOriginal) => {
  const original = await importOriginal()
  return {
    ...original,
    PINATA_CONFIG: {
      ...original.PINATA_CONFIG,
      JWT: 'test-jwt-token', // Provide test JWT to pass auth check
    },
  }
})

import {
  fetchFromIpfs,
  fetchTokenMetadata,
  fetchMarketData,
  fetchMarketMetadata,
  fetchByCid,
  batchFetch,
  clearCache,
  clearCacheEntry,
  checkGatewayHealth,
  uploadJson,
  uploadEncryptedEnvelope,
  fetchEncryptedEnvelope,
  parseEncryptedIpfsReference,
  buildEncryptedIpfsReference,
} from '../utils/ipfsService'

// Mock fetch globally
global.fetch = vi.fn()

describe('IPFS Service', () => {
  beforeEach(() => {
    clearCache()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('fetchFromIpfs', () => {
    it('fetches data from IPFS successfully', async () => {
      const mockData = { name: 'Test Token', symbol: 'TEST' }
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      })

      const result = await fetchFromIpfs('/test/path')
      
      expect(result).toEqual(mockData)
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/test/path'),
        expect.any(Object)
      )
    })

    it('uses cached data on subsequent calls', async () => {
      const mockData = { name: 'Cached Data' }
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      })

      // First call - should fetch
      const result1 = await fetchFromIpfs('/test/cache')
      expect(global.fetch).toHaveBeenCalledTimes(1)

      // Second call - should use cache
      const result2 = await fetchFromIpfs('/test/cache')
      expect(global.fetch).toHaveBeenCalledTimes(1) // Still only 1 call
      expect(result2).toEqual(result1)
    })

    it('skips cache when skipCache option is true', async () => {
      const mockData = { name: 'Fresh Data' }
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => mockData,
      })

      await fetchFromIpfs('/test/skip-cache')
      await fetchFromIpfs('/test/skip-cache', { skipCache: true })
      
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('retries on failure and eventually succeeds', async () => {
      const mockData = { name: 'Success After Retry' }
      
      // First call fails, second succeeds
      global.fetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockData,
        })

      const result = await fetchFromIpfs('/test/retry')
      
      expect(result).toEqual(mockData)
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('throws error after max retries', async () => {
      global.fetch.mockRejectedValue(new Error('Network error'))

      await expect(fetchFromIpfs('/test/fail')).rejects.toThrow(
        'IPFS fetch failed after'
      )
    })

    it('handles HTTP error responses', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      await expect(fetchFromIpfs('/test/404')).rejects.toThrow()
    })

    it('handles timeout correctly', async () => {
      // Mock a timeout scenario
      global.fetch.mockImplementationOnce(() => {
        return new Promise((_, reject) => {
          const error = new Error('Timeout')
          error.name = 'AbortError'
          reject(error)
        })
      })

      await expect(fetchFromIpfs('/test/timeout')).rejects.toThrow(
        'IPFS request timeout'
      )
    })
  })

  describe('fetchTokenMetadata', () => {
    it('fetches token metadata with correct path', async () => {
      const mockMetadata = { name: 'Test Token', symbol: 'TEST', decimals: 18 }
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockMetadata,
      })

      const result = await fetchTokenMetadata('0x1234567890123456789012345678901234567890')
      
      expect(result).toEqual(mockMetadata)
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/token/0x1234567890123456789012345678901234567890/metadata.json'),
        expect.any(Object)
      )
    })

    it('throws error when token address is missing', async () => {
      await expect(fetchTokenMetadata('')).rejects.toThrow('Token address is required')
      await expect(fetchTokenMetadata(null)).rejects.toThrow('Token address is required')
    })
  })

  describe('fetchMarketData', () => {
    it('fetches market data with correct path', async () => {
      const mockData = { id: '123', volume: 1000 }
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      })

      const result = await fetchMarketData('market-123')
      
      expect(result).toEqual(mockData)
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/market/market-123/data.json'),
        expect.any(Object)
      )
    })

    it('throws error when market ID is missing', async () => {
      await expect(fetchMarketData('')).rejects.toThrow('Market ID is required')
    })
  })

  describe('fetchMarketMetadata', () => {
    it('fetches market metadata with correct path', async () => {
      const mockMetadata = { title: 'Test Market', description: 'A test market' }
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockMetadata,
      })

      const result = await fetchMarketMetadata('market-456')
      
      expect(result).toEqual(mockMetadata)
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/market/market-456/metadata.json'),
        expect.any(Object)
      )
    })
  })

  describe('fetchByCid', () => {
    it('fetches data by valid CID', async () => {
      const mockData = { content: 'IPFS content' }
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockData,
      })

      const result = await fetchByCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')
      
      expect(result).toEqual(mockData)
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
        expect.any(Object)
      )
    })

    it('throws error for invalid CID format', async () => {
      await expect(fetchByCid('invalid-cid')).rejects.toThrow('Invalid CID format')
    })

    it('throws error when CID is missing', async () => {
      await expect(fetchByCid('')).rejects.toThrow('CID is required')
    })
  })

  describe('batchFetch', () => {
    it('fetches multiple items successfully', async () => {
      const mockData1 = { id: 1 }
      const mockData2 = { id: 2 }
      
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockData1,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockData2,
        })

      const results = await batchFetch(['/path1', '/path2'])
      
      expect(results).toHaveLength(2)
      expect(results[0]).toEqual(mockData1)
      expect(results[1]).toEqual(mockData2)
    })

    it('returns null for failed fetches in batch', async () => {
      const mockData = { id: 1 }
      
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockData,
        })
        .mockRejectedValueOnce(new Error('Failed'))

      const results = await batchFetch(['/path1', '/path2'])
      
      expect(results).toHaveLength(2)
      expect(results[0]).toEqual(mockData)
      expect(results[1]).toBeNull()
    })

    it('returns empty array for empty paths', async () => {
      const results = await batchFetch([])
      expect(results).toEqual([])
    })
  })

  describe('Cache Management', () => {
    it('clears cache entry', async () => {
      const mockData = { data: 'test' }
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => mockData,
      })

      // Fetch and cache
      await fetchFromIpfs('/test/clear-entry')
      expect(global.fetch).toHaveBeenCalledTimes(1)

      // Clear specific entry
      clearCacheEntry('/test/clear-entry')

      // Should fetch again
      await fetchFromIpfs('/test/clear-entry')
      expect(global.fetch).toHaveBeenCalledTimes(2)
    })

    it('clears all cache', async () => {
      const mockData = { data: 'test' }
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => mockData,
      })

      // Fetch and cache multiple items
      await fetchFromIpfs('/test/1')
      await fetchFromIpfs('/test/2')
      expect(global.fetch).toHaveBeenCalledTimes(2)

      // Clear all cache
      clearCache()

      // Should fetch both again
      await fetchFromIpfs('/test/1')
      await fetchFromIpfs('/test/2')
      expect(global.fetch).toHaveBeenCalledTimes(4)
    })
  })

  describe('checkGatewayHealth', () => {
    it('returns true when gateway is accessible', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
      })

      const result = await checkGatewayHealth()
      expect(result).toBe(true)
    })

    it('returns true even with 404 status', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      })

      const result = await checkGatewayHealth()
      expect(result).toBe(true)
    })

    it('returns false when gateway is not accessible', async () => {
      global.fetch.mockRejectedValueOnce(new Error('Network error'))

      const result = await checkGatewayHealth()
      expect(result).toBe(false)
    })
  })

  // ==========================================
  // Encrypted Envelope IPFS Tests
  // ==========================================

  describe('parseEncryptedIpfsReference', () => {
    it('parses encrypted:ipfs:// prefix correctly', () => {
      const result = parseEncryptedIpfsReference('encrypted:ipfs://bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze')
      expect(result.isIpfs).toBe(true)
      expect(result.cid).toBe('bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze')
    })

    it('parses plain ipfs:// prefix correctly', () => {
      const result = parseEncryptedIpfsReference('ipfs://bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze')
      expect(result.isIpfs).toBe(true)
      expect(result.cid).toBe('bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze')
    })

    it('parses raw CIDv1 correctly', () => {
      const result = parseEncryptedIpfsReference('bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze')
      expect(result.isIpfs).toBe(true)
      expect(result.cid).toBe('bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze')
    })

    it('parses CIDv0 (Qm prefix) correctly', () => {
      const result = parseEncryptedIpfsReference('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')
      expect(result.isIpfs).toBe(true)
      expect(result.cid).toBe('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')
    })

    it('returns isIpfs false for plaintext descriptions', () => {
      const result = parseEncryptedIpfsReference('Will ETH reach $5000 by December?')
      expect(result.isIpfs).toBe(false)
      expect(result.cid).toBeNull()
    })

    it('returns isIpfs false for JSON envelopes', () => {
      const envelope = JSON.stringify({ version: '1.0', algorithm: 'x25519-chacha20poly1305' })
      const result = parseEncryptedIpfsReference(envelope)
      expect(result.isIpfs).toBe(false)
      expect(result.cid).toBeNull()
    })

    it('returns isIpfs false for null/undefined', () => {
      expect(parseEncryptedIpfsReference(null).isIpfs).toBe(false)
      expect(parseEncryptedIpfsReference(undefined).isIpfs).toBe(false)
      expect(parseEncryptedIpfsReference('').isIpfs).toBe(false)
    })
  })

  describe('buildEncryptedIpfsReference', () => {
    it('builds correct reference format', () => {
      const cid = 'bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze'
      const result = buildEncryptedIpfsReference(cid)
      expect(result).toBe('encrypted:ipfs://bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze')
    })

    it('throws error for invalid CID', () => {
      expect(() => buildEncryptedIpfsReference('invalid')).toThrow('Invalid CID')
      expect(() => buildEncryptedIpfsReference('')).toThrow('Invalid CID')
      expect(() => buildEncryptedIpfsReference(null)).toThrow('Invalid CID')
    })
  })

  /*
   * A rejected upload has to say enough to act on. In production a valid Pinata key that lacked the
   * `pinJSONToIPFS` scope rejected every wager creation with the bare word `NO_SCOPES_FOUND` — no
   * status, no explanation — which reads as an app bug and points at nothing. Pinata puts the
   * opaque token in `reason` and the sentence in `details`, and the HTTP status is what separates a
   * credential problem (401/403) from rate limiting (429) from Pinata being down (5xx).
   */
  describe('uploadJson error reporting', () => {
    it('carries Pinata’s own explanation and the HTTP status into the thrown error', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({
            error: {
              reason: 'NO_SCOPES_FOUND',
              details: 'This key does not have the required scopes to access this endpoint',
            },
          }),
      })

      await expect(uploadJson({ hello: 'world' })).rejects.toThrow(
        /NO_SCOPES_FOUND.*required scopes.*HTTP 403/s
      )
    })

    it('falls back to the status and a body snippet when the body is not Pinata JSON', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => '<html>Bad Gateway</html>',
      })

      await expect(uploadJson({ hello: 'world' })).rejects.toThrow(/502.*Bad Gateway/s)
    })
  })

  describe('uploadEncryptedEnvelope', () => {
    const validEnvelope = {
      version: '2.0',
      algorithm: 'xwing-chacha20poly1305',
      content: {
        nonce: 'abc123',
        ciphertext: 'def456'
      },
      keys: [
        { address: '0x1234', xwingCiphertext: 'ghi789', nonce: 'jkl012', wrappedKey: 'mno345' }
      ]
    }

    it('uploads valid X-Wing envelope successfully', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          IpfsHash: 'bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze',
          PinSize: 1234,
          Timestamp: '2026-01-24T00:00:00.000Z'
        })
      })

      const result = await uploadEncryptedEnvelope(validEnvelope, { marketType: 'oneVsOne' })

      expect(result.cid).toBe('bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze')
      expect(result.uri).toBe('ipfs://bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze')
    })

    it('uploads valid X25519 envelope successfully', async () => {
      const x25519Envelope = {
        ...validEnvelope,
        version: '1.0',
        algorithm: 'x25519-chacha20poly1305',
        keys: [{ address: '0x1234', ephemeralPublicKey: 'abc', nonce: 'def', wrappedKey: 'ghi' }]
      }

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          IpfsHash: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
          PinSize: 1234
        })
      })

      const result = await uploadEncryptedEnvelope(x25519Envelope)
      expect(result.cid).toBe('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')
    })

    it('uploads a code-keyed envelope (no recipients keys) successfully', async () => {
      // Feature 024: open-challenge terms are sealed under a code-derived key, so the envelope has mode
      // "code" and NO keys array. The validator must accept it (and the code algorithm).
      const codeEnvelope = {
        version: 'code-1.0',
        algorithm: 'code-xchacha20poly1305',
        mode: 'code',
        content: { nonce: 'abc123', ciphertext: 'def456' }
      }
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ IpfsHash: 'bafyCodeKeyedEnvelopeCidExampleValue00000000000000000000', PinSize: 99 })
      })
      const result = await uploadEncryptedEnvelope(codeEnvelope, { marketType: 'openChallenge' })
      expect(result.cid).toBe('bafyCodeKeyedEnvelopeCidExampleValue00000000000000000000')
    })

    it('throws error for invalid envelope structure', async () => {
      await expect(uploadEncryptedEnvelope({})).rejects.toThrow('Invalid envelope format')
      await expect(uploadEncryptedEnvelope({ version: '1.0' })).rejects.toThrow('Invalid envelope format')
    })

    it('throws error for unsupported algorithm', async () => {
      const invalidAlgorithmEnvelope = {
        ...validEnvelope,
        algorithm: 'aes-256-gcm'
      }
      await expect(uploadEncryptedEnvelope(invalidAlgorithmEnvelope)).rejects.toThrow('Unsupported envelope algorithm')
    })

    it('throws error for null envelope', async () => {
      await expect(uploadEncryptedEnvelope(null)).rejects.toThrow('Envelope must be a valid object')
    })
  })

  describe('fetchEncryptedEnvelope', () => {
    it('fetches and validates envelope from IPFS', async () => {
      const mockEnvelope = {
        version: '2.0',
        algorithm: 'xwing-chacha20poly1305',
        content: { nonce: 'abc', ciphertext: 'def' },
        keys: []
      }

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockEnvelope
      })

      const result = await fetchEncryptedEnvelope('bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze')
      expect(result).toEqual(mockEnvelope)
    })

    it('throws error if fetched data is not a valid envelope', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ foo: 'bar' }) // Not an envelope
      })

      await expect(
        fetchEncryptedEnvelope('bafybeic5dplry3twzpb3l5byo5tqyj7vfk3vxl7skrn6kzqd7p6ey3mmze')
      ).rejects.toThrow('not a valid encrypted envelope')
    })

    it('throws error when CID is missing', async () => {
      await expect(fetchEncryptedEnvelope('')).rejects.toThrow('CID is required')
    })
  })
})
