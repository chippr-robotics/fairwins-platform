/**
 * Member API capability tokens (spec 095) — the grant, the wire codec, and the metadata store.
 *
 * The two facts worth pinning here are the ones that fail silently in production:
 *   · the typed data this tree signs must be the typed data the gateway verifies, so the tests sign
 *     with a real key and verify with `ethers.verifyTypedData` against the same tables the gateway
 *     imports from `@fairwins/intent-types`;
 *   · the token must never reach storage. That is asserted against the RAW localStorage string, not
 *     against the reader — a reader that hides a field still leaves it on disk.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ethers } from 'ethers'
import {
  MEMBER_API_DOMAIN,
  MEMBER_API_GRANT_TYPES,
  MEMBER_API_REVOCATION_TYPES,
  canonicalScopeString,
} from '@fairwins/intent-types'
import {
  API_KEYS_STORAGE_KEY,
  API_SCOPES,
  EXPIRY_CHOICES_DAYS,
  MAX_TTL_DAYS,
  buildGrant,
  buildRevocation,
  forgetApiKey,
  grantTypedData,
  keyState,
  listKeyRecords,
  markApiKeyRevoked,
  randomKeyId,
  recordApiKey,
  revocationRequestBody,
  revocationTypedData,
  shortKeyId,
} from '../lib/apiAccess/apiKeys'
import { TOKEN_PREFIX, decodeToken, encodeToken } from '../lib/apiAccess/tokenCodec'

const ACCOUNT = ethers.getAddress('0x' + '11'.repeat(20))
const STORAGE_KEY = `fw_user_${ACCOUNT.toLowerCase()}_${API_KEYS_STORAGE_KEY}`

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('buildGrant', () => {
  it('produces a v1 grant with sorted scopes and the requested window', () => {
    const grant = buildGrant({
      account: ACCOUNT,
      scopes: ['read:wagers', 'read:profile'],
      ttlDays: 30,
      label: 'my agent',
      nowSeconds: 1_750_000_000,
    })
    expect(grant.v).toBe(1)
    expect(grant.account).toBe(ACCOUNT)
    expect(grant.keyId).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(grant.scopes).toEqual(['read:profile', 'read:wagers'])
    expect(grant.issuedAt).toBe(1_750_000_000)
    expect(grant.expiresAt).toBe(1_750_000_000 + 30 * 86400)
    expect(grant.label).toBe('my agent')
  })

  it('refuses an unknown scope rather than dropping it', () => {
    // Silently dropping would mint a token narrower than the member was shown.
    expect(() => buildGrant({ account: ACCOUNT, scopes: ['write:everything'], ttlDays: 7 })).toThrow(/unknown scope/i)
  })

  it('refuses a lifetime past the gateway maximum', () => {
    expect(() => buildGrant({ account: ACCOUNT, scopes: ['read:profile'], ttlDays: MAX_TTL_DAYS + 1 })).toThrow(/maximum/i)
  })

  it('only offers expiries the gateway will accept', () => {
    for (const days of EXPIRY_CHOICES_DAYS) expect(days).toBeLessThanOrEqual(MAX_TTL_DAYS)
  })

  it('declares no write-shaped scope — the API can never act as the member', () => {
    for (const scope of API_SCOPES) expect(scope.id.startsWith('write:')).toBe(false)
  })
})

/**
 * Spec 110 T028 — the ethers→viem swap in `apiKeys.js`, and the one property it could have lost.
 *
 * `buildGrant` shape-checked the account with a regex and then called `ethers.getAddress`, which
 * THREW on a mistyped mixed-case address. viem's `getAddress` does not — it re-checksums whatever
 * it is handed — so the refusal had to move to the explicit check, or a typo would have been
 * silently accepted and written into a signed grant.
 */
describe('buildGrant — the EIP-55 refusal survives the viem swap', () => {
  // Needs LETTERS in the body: a checksum only exists where there are letters to case, and the
  // suite's usual 0x1111… address has none, so a typo cannot be constructed from it at all.
  const MIXED = ethers.getAddress('0xdeadbeefcafebabefeedface0123456789abcdef')
  const ok = (over = {}) => ({ account: MIXED, scopes: ['read:profile'], ttlDays: 1, ...over })

  it('refuses a mixed-case address whose checksum does not verify', () => {
    // One letter case-flipped: still shape-valid hex, but the EIP-55 checksum no longer holds —
    // exactly the typo the checksum exists to catch, and what ethers' getAddress used to throw on.
    const i = MIXED.slice(2).split('').findIndex((c) => /[a-f]/.test(c))
    expect(i).toBeGreaterThanOrEqual(0)
    const typo = '0x' + MIXED.slice(2, 2 + i) + MIXED[2 + i].toUpperCase() + MIXED.slice(3 + i)
    expect(typo).not.toBe(MIXED)
    expect(() => buildGrant(ok({ account: typo }))).toThrow(/must be a 0x address/)
    expect(() => buildRevocation({ account: typo, keyId: randomKeyId() })).toThrow(/must be a 0x address/)
  })

  it('still accepts the caseless forms, which carry no checksum to verify', () => {
    expect(buildGrant(ok({ account: MIXED.toLowerCase() })).account).toBe(MIXED)
    expect(buildGrant(ok({ account: '0x' + MIXED.slice(2).toUpperCase() })).account).toBe(MIXED)
  })

  it('mints key ids that are 32 bytes of hex and do not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomKeyId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('grant typed data', () => {
  it('signs and verifies against the same tables the gateway uses', async () => {
// Fixed key (Wallet.createRandom's mnemonic path hits an ethers/jsdom crypto quirk under vitest).
    const wallet = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
    const grant = buildGrant({
      account: wallet.address,
      scopes: ['assistant:chat', 'read:profile'],
      ttlDays: 7,
      nowSeconds: 1_750_000_000,
    })
    const { domain, types, message } = grantTypedData(grant)

    expect(domain).toEqual({ ...MEMBER_API_DOMAIN })
    expect(types).toBe(MEMBER_API_GRANT_TYPES)
    // The scopes field is ONE canonical line, not an array — a wallet renders an array
    // unpredictably, so a member could approve something they were never shown.
    expect(message.scopes).toBe(canonicalScopeString(grant.scopes))
    expect(message.scopes).toBe('assistant:chat read:profile')

    const signature = await wallet.signTypedData(domain, types, message)
    expect(ethers.verifyTypedData(domain, types, message, signature)).toBe(wallet.address)
  })

  it('builds a revocation the same account can sign', async () => {
// Fixed key (Wallet.createRandom's mnemonic path hits an ethers/jsdom crypto quirk under vitest).
    const wallet = new ethers.Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
    const revocation = buildRevocation({ account: wallet.address, keyId: '0x' + 'ab'.repeat(32), nowSeconds: 1_750_000_100 })
    const { domain, types, message } = revocationTypedData(revocation)
    expect(types).toBe(MEMBER_API_REVOCATION_TYPES)

    const signature = await wallet.signTypedData(domain, types, message)
    expect(ethers.verifyTypedData(domain, types, message, signature)).toBe(wallet.address)

    // The gateway reads `{ revocation, signature }`.
    expect(revocationRequestBody(revocation, signature)).toEqual({ revocation, signature })
  })
})

describe('token codec', () => {
  it('round-trips a grant and signature through the fw1 wire format', async () => {
// Fixed key (Wallet.createRandom's mnemonic path hits an ethers/jsdom crypto quirk under vitest).
    const wallet = new ethers.Wallet('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6')
    const grant = buildGrant({ account: wallet.address, scopes: ['read:profile'], ttlDays: 7, label: 'round trip' })
    const { domain, types, message } = grantTypedData(grant)
    const signature = await wallet.signTypedData(domain, types, message)

    const token = encodeToken(grant, signature)
    expect(token.startsWith(`${TOKEN_PREFIX}.`)).toBe(true)
    expect(token.split('.')).toHaveLength(3)
    // Unpadded base64url: no '=', '+' or '/' anywhere in an Authorization header value.
    expect(token).not.toMatch(/[+/=]/)

    const decoded = decodeToken(token)
    expect(decoded.grant.account).toBe(grant.account)
    expect(decoded.grant.keyId).toBe(grant.keyId)
    expect(decoded.grant.scopes).toEqual(grant.scopes)
    expect(decoded.grant.expiresAt).toBe(grant.expiresAt)
    expect(decoded.grant.label).toBe('round trip')
    expect(decoded.signature.toLowerCase()).toBe(signature.toLowerCase())
  })

  it('rejects anything that is not an fw1 token', () => {
    expect(() => decodeToken('')).toThrow()
    expect(() => decodeToken('Bearer nope')).toThrow(/fw1/)
    expect(() => decodeToken('fw2.a.b')).toThrow(/fw1/)
    expect(() => decodeToken('fw1.###.###')).toThrow()
  })
})

describe('metadata store', () => {
  it('stores metadata only — the token is never written to storage', async () => {
// Fixed key (Wallet.createRandom's mnemonic path hits an ethers/jsdom crypto quirk under vitest).
    const wallet = new ethers.Wallet('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a')
    const grant = buildGrant({ account: ACCOUNT, scopes: ['read:profile'], ttlDays: 7, label: 'agent' })
    const { domain, types, message } = grantTypedData(grant)
    const signature = await wallet.signTypedData(domain, types, message)
    const token = encodeToken(grant, signature)

    recordApiKey(ACCOUNT, grant)

    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).toBeTruthy()
    // The RAW string, not the reader: a reader that omits a field still leaves it on disk.
    expect(raw).not.toContain(token)
    expect(raw).not.toContain(signature)
    expect(raw).not.toContain(TOKEN_PREFIX + '.')
    expect(raw).toContain(grant.keyId)
  })

  it('lists keys newest first and reports each key’s state', () => {
    recordApiKey(ACCOUNT, buildGrant({ account: ACCOUNT, scopes: ['read:profile'], ttlDays: 7, label: 'older', nowSeconds: 1000 }))
    recordApiKey(ACCOUNT, buildGrant({ account: ACCOUNT, scopes: ['read:profile'], ttlDays: 7, label: 'newer', nowSeconds: 2000 }))
    const keys = listKeyRecords(ACCOUNT)
    expect(keys.map((k) => k.label)).toEqual(['newer', 'older'])
    // Both were issued in 1970 by the injected clock, so both have expired by now.
    expect(keyState(keys[0])).toBe('expired')
  })

  it('marks a key revoked without losing it, and can forget it entirely', () => {
    const grant = buildGrant({ account: ACCOUNT, scopes: ['read:profile'], ttlDays: 30 })
    recordApiKey(ACCOUNT, grant)

    markApiKeyRevoked(ACCOUNT, grant.keyId, 1_750_000_500)
    expect(keyState(listKeyRecords(ACCOUNT)[0])).toBe('revoked')

    forgetApiKey(ACCOUNT, grant.keyId)
    expect(listKeyRecords(ACCOUNT)).toHaveLength(0)
  })

  it('drops a foreign or malformed stored entry rather than trusting it', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { keyId: 'not-a-key-id', scopes: ['read:profile'], issuedAt: 1, expiresAt: 2 },
        { keyId: '0x' + 'cd'.repeat(32), scopes: ['made:up'], issuedAt: 1, expiresAt: 2 },
        'a string',
        { keyId: '0x' + 'ef'.repeat(32), scopes: ['read:profile'], issuedAt: 1, expiresAt: 2 },
      ])
    )
    const keys = listKeyRecords(ACCOUNT)
    expect(keys).toHaveLength(1)
    expect(keys[0].keyId).toBe('0x' + 'ef'.repeat(32))
  })

  it('returns an empty list without a wallet instead of throwing', () => {
    expect(listKeyRecords(null)).toEqual([])
  })

  it('shortens a key id for display without pretending it is a secret', () => {
    expect(shortKeyId('0x' + 'ab'.repeat(32))).toContain('…')
  })

  it('is absent from the spec-032 synced object registry', () => {
    // A key is a credential bound to one gateway's live revocation set, and its metadata names
    // credentials that may be live on other devices. Exporting that list into the encrypted backup
    // would carry it to every device a member restores onto — the same call as `network_endpoints`.
    const registry = readFileSync(resolve(process.cwd(), 'src/lib/backup/syncedObjects.js'), 'utf-8')
    expect(registry).not.toContain(API_KEYS_STORAGE_KEY)
    expect(registry).not.toContain('apiKeys')
  })
})
