/**
 * GutterToken key store (spec 104).
 *
 * The properties that matter: the key never appears in anything but `loadGutterTokenKey`'s return
 * value (not in a redaction beyond four characters, not in a validation message, not in a test
 * result, not in the backup registry), and the liveness check maps every upstream answer to a named
 * state without ever reading an error body.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  GUTTERTOKEN_KEY_STORAGE_KEY,
  __resetGutterTokenKeyForTests,
  describeGutterTokenKey,
  gutterTokenKeyRevision,
  hasGutterTokenKey,
  loadGutterTokenKey,
  redactGutterTokenKey,
  removeGutterTokenKey,
  saveGutterTokenKey,
  subscribeGutterTokenKey,
  testGutterTokenKey,
  testStoredGutterTokenKey,
  validateGutterTokenKeyFormat,
} from '../../lib/assistant/guttertokenKeyStore'
import { hangingFetch, response } from './helpers/http'

const ACCOUNT = '0xAbCdEF0123456789abcdef0123456789ABCDEF01'
const OTHER = '0x' + '7'.repeat(40)
const KEY = 'sk-gt-0123456789abcdefghijklmnopqrstuvwxyz'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  __resetGutterTokenKeyForTests()
})

describe('validateGutterTokenKeyFormat', () => {
  it.each([
    ['sk-abcdefghijklmnop', true],
    ['  sk-abcdefghijklmnop  ', true], // trimmed
    ['', false],
    [null, false],
    [42, false],
    ['abcdefghijklmnop', false], // no prefix
    ['sk-short', false], // < 12
    ['sk-' + 'x'.repeat(510), false], // > 512
    ['sk-abc defghijklmnop', false], // inner whitespace
    ['sk-abc\ndefghijklmnop', false],
  ])('%j → ok=%s', (input, ok) => {
    expect(validateGutterTokenKeyFormat(input).ok).toBe(ok)
  })

  it('never echoes the input in an error sentence', () => {
    const weird = 'sk-THIS IS THE SECRET'
    const { error } = validateGutterTokenKeyFormat(weird)
    expect(error).toBeTruthy()
    expect(error).not.toContain('SECRET')
  })
})

describe('redactGutterTokenKey', () => {
  it('shows the prefix and exactly the last four characters', () => {
    expect(redactGutterTokenKey(KEY)).toBe('sk-…wxyz')
    expect(redactGutterTokenKey(`  ${KEY}  `)).toBe('sk-…wxyz')
  })

  it('never leaks more than four characters of the secret part, for any key length', () => {
    for (let n = 0; n < 600; n += 7) {
      const key = 'sk-' + 'a'.repeat(n) + 'ZZZZ'
      const redacted = redactGutterTokenKey(key)
      const secret = key.slice(3)
      // Longest run of the secret that survives is ≤ 4 chars.
      expect(redacted.replace('sk-…', '').length).toBeLessThanOrEqual(4)
      if (secret.length > 4) expect(redacted).not.toContain(secret.slice(0, 5))
    }
  })

  it('shows no tail at all for a key that does not validate', () => {
    expect(redactGutterTokenKey('sk-abc')).toBe('sk-…')
    expect(redactGutterTokenKey(null)).toBe('sk-…')
    expect(redactGutterTokenKey('not-a-key-at-all')).toBe('sk-…')
  })
})

describe('save / load / remove', () => {
  it('starts empty and is wallet-scoped', () => {
    expect(hasGutterTokenKey(ACCOUNT)).toBe(false)
    expect(loadGutterTokenKey(ACCOUNT)).toBeNull()
    expect(describeGutterTokenKey(ACCOUNT)).toEqual({ present: false, redacted: null, savedAt: null })

    expect(saveGutterTokenKey(ACCOUNT, KEY)).toEqual({ ok: true, redacted: 'sk-…wxyz' })
    expect(hasGutterTokenKey(ACCOUNT)).toBe(true)
    expect(loadGutterTokenKey(ACCOUNT)).toBe(KEY)
    expect(hasGutterTokenKey(ACCOUNT.toLowerCase())).toBe(true)
    // Another account on the same device does not inherit it.
    expect(hasGutterTokenKey(OTHER)).toBe(false)
    expect(loadGutterTokenKey(OTHER)).toBeNull()
  })

  it('persists under the versioned wallet-scoped key in localStorage only', () => {
    saveGutterTokenKey(ACCOUNT, KEY)
    const storageKey = `fw_user_${ACCOUNT.toLowerCase()}_${GUTTERTOKEN_KEY_STORAGE_KEY}`
    const stored = JSON.parse(localStorage.getItem(storageKey))
    expect(stored).toMatchObject({ v: 1, key: KEY })
    expect(stored.savedAt).toBeGreaterThan(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('describes the key without exposing it', () => {
    saveGutterTokenKey(ACCOUNT, KEY)
    const described = describeGutterTokenKey(ACCOUNT)
    expect(described.present).toBe(true)
    expect(described.redacted).toBe('sk-…wxyz')
    expect(JSON.stringify(described)).not.toContain(KEY)
  })

  it('refuses a malformed key and stores nothing', () => {
    expect(saveGutterTokenKey(ACCOUNT, 'nope')).toMatchObject({ ok: false })
    expect(hasGutterTokenKey(ACCOUNT)).toBe(false)
    expect(localStorage.length).toBe(0)
  })

  it('refuses to save without a wallet', () => {
    expect(saveGutterTokenKey(null, KEY)).toMatchObject({ ok: false })
    expect(localStorage.length).toBe(0)
  })

  it('reads a foreign or unversioned record as "no key"', () => {
    const storageKey = `fw_user_${ACCOUNT.toLowerCase()}_${GUTTERTOKEN_KEY_STORAGE_KEY}`
    localStorage.setItem(storageKey, JSON.stringify({ key: KEY })) // no v
    expect(hasGutterTokenKey(ACCOUNT)).toBe(false)
    __resetGutterTokenKeyForTests()
    localStorage.setItem(storageKey, JSON.stringify(KEY)) // bare string
    expect(hasGutterTokenKey(ACCOUNT)).toBe(false)
  })

  it('removes, bumps the revision and notifies subscribers with the revision — never the key', () => {
    const seen = []
    const unsubscribe = subscribeGutterTokenKey((rev) => seen.push(rev))
    const r0 = gutterTokenKeyRevision()
    saveGutterTokenKey(ACCOUNT, KEY)
    removeGutterTokenKey(ACCOUNT)
    expect(hasGutterTokenKey(ACCOUNT)).toBe(false)
    expect(loadGutterTokenKey(ACCOUNT)).toBeNull()
    expect(gutterTokenKeyRevision()).toBe(r0 + 2)
    expect(seen).toEqual([r0 + 1, r0 + 2])
    expect(JSON.stringify(seen)).not.toContain('sk-')
    unsubscribe()
    saveGutterTokenKey(ACCOUNT, KEY)
    expect(seen.length).toBe(2)
  })

  it('survives a throwing subscriber', () => {
    subscribeGutterTokenKey(() => {
      throw new Error('bad subscriber')
    })
    expect(() => saveGutterTokenKey(ACCOUNT, KEY)).not.toThrow()
    expect(hasGutterTokenKey(ACCOUNT)).toBe(true)
  })
})

describe('testGutterTokenKey', () => {
  const call = (fetchImpl, key = KEY, opts = {}) => testGutterTokenKey(key, { fetchImpl, timeoutMs: 50, ...opts })

  it('GETs /v1/models with the key in a header and returns the model ids on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }] }))
    await expect(call(fetchImpl)).resolves.toEqual({ ok: true, models: ['claude-opus-5', 'claude-sonnet-5'] })
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.guttertokens.com/v1/models')
    expect(options.method).toBe('GET')
    expect(options.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(url).not.toContain(KEY)
  })

  it.each([
    [401, 'key_invalid'],
    [429, 'quota'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [403, 'rejected'],
    [404, 'rejected'],
  ])('maps HTTP %i to %s without reading the body', async (status, state) => {
    const body = { error: { type: 'x', message: `echo of ${KEY}` } }
    const res = response(status, body)
    res.json = vi.fn(res.json)
    const result = await call(vi.fn().mockResolvedValue(res))
    expect(result).toMatchObject({ ok: false, state })
    expect(result.message).not.toContain(KEY)
    expect(res.json).not.toHaveBeenCalled()
  })

  it('maps a network failure and a timeout to unreachable', async () => {
    const network = await call(vi.fn().mockRejectedValue(new Error(`ECONNREFUSED while sending ${KEY}`)))
    expect(network).toMatchObject({ ok: false, state: 'unreachable' })
    expect(network.message).not.toContain(KEY)

    const timeout = await call(hangingFetch())
    expect(timeout).toMatchObject({ ok: false, state: 'unreachable' })
  })

  it('refuses a malformed key before any request', async () => {
    const fetchImpl = vi.fn()
    await expect(call(fetchImpl, 'not-a-key')).resolves.toMatchObject({ ok: false, state: 'rejected' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('tolerates an unreadable success body', async () => {
    await expect(call(vi.fn().mockResolvedValue(response(200, undefined)))).resolves.toEqual({ ok: true, models: [] })
  })
})

describe('testStoredGutterTokenKey', () => {
  it('answers key_missing without a request when nothing is saved on this device', async () => {
    const fetchImpl = vi.fn()
    await expect(testStoredGutterTokenKey(ACCOUNT, { fetchImpl })).resolves.toMatchObject({ ok: false, state: 'key_missing' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('tests THIS account’s stored key, so the caller never has to read it out', async () => {
    saveGutterTokenKey(ACCOUNT, KEY)
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { data: [{ id: 'claude-opus-5' }] }))
    await expect(testStoredGutterTokenKey(ACCOUNT, { fetchImpl })).resolves.toEqual({ ok: true, models: ['claude-opus-5'] })
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${KEY}`)
    // Another account's key is not this one's, and absence stays absence.
    await expect(testStoredGutterTokenKey(OTHER, { fetchImpl })).resolves.toMatchObject({ state: 'key_missing' })
  })

  it('passes the upstream verdict through without ever quoting the key', async () => {
    saveGutterTokenKey(ACCOUNT, KEY)
    const result = await testStoredGutterTokenKey(ACCOUNT, {
      fetchImpl: vi.fn().mockResolvedValue(response(401, { error: { message: `echo of ${KEY}` } })),
    })
    expect(result).toMatchObject({ ok: false, state: 'key_invalid' })
    expect(result.message).not.toContain(KEY)
  })
})

describe('boundaries', () => {
  it('is deliberately absent from the spec-032 synced object registry', () => {
    const registry = readFileSync(resolve(process.cwd(), 'src/lib/backup/syncedObjects.js'), 'utf-8')
    expect(registry).not.toContain(GUTTERTOKEN_KEY_STORAGE_KEY)
    expect(registry).not.toContain('guttertoken')
    expect(registry).not.toContain('GutterToken')
  })

  it('has the transport as the only caller of loadGutterTokenKey outside the store', () => {
    // The clear key is for an Authorization header and nothing else. A component that needs to
    // show it uses describeGutterTokenKey. This scan is the rule, made checkable.
    const root = resolve(process.cwd(), 'src')
    const allowed = new Set(['lib/assistant/guttertokenKeyStore.js', 'lib/assistant/conversation.js'])
    const offenders = []
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(js|jsx)$/.test(entry.name)) continue
      const abs = join(entry.parentPath ?? entry.path, entry.name)
      const rel = abs.slice(root.length + 1)
      if (rel.startsWith('test/')) continue
      if (allowed.has(rel)) continue
      if (readFileSync(abs, 'utf-8').includes('loadGutterTokenKey(')) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('never console-logs during save, remove or a failed check', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    saveGutterTokenKey(ACCOUNT, KEY)
    await testGutterTokenKey(KEY, { fetchImpl: vi.fn().mockRejectedValue(new Error('x')), timeoutMs: 50 })
    removeGutterTokenKey(ACCOUNT)
    const printed = [spy, warn, error].flatMap((s) => s.mock.calls.flat().map(String)).join('|')
    expect(printed).not.toContain(KEY)
    expect(printed).not.toContain('wxyz')
    spy.mockRestore()
    warn.mockRestore()
    error.mockRestore()
  })
})
