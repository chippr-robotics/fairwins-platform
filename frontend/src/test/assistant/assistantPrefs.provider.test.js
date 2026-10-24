/**
 * Assistant preferences — the `provider` field (spec 104).
 *
 * Default is the membership rail; a stored value routes a conversation to a third party only when it
 * names a rail this build knows; the default is stored as absence so a member who never chose keeps
 * the spec-095 blob byte-for-byte; and the field stays wallet-scoped and out of the backup.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ASSISTANT_PREFS_KEY,
  ASSISTANT_PROVIDERS,
  DEFAULT_ASSISTANT_PREFS,
  __resetAssistantPrefsForTests,
  getAssistantProvider,
  loadAssistantPrefs,
  setAssistantEnabled,
  setAssistantProvider,
  subscribeAssistantPrefs,
} from '../../lib/assistant/assistantPrefs'

const ACCOUNT = '0xAbCdEF0123456789abcdef0123456789ABCDEF01'
const OTHER = '0x' + '7'.repeat(40)
const storageKey = (account) => `fw_user_${account.toLowerCase()}_${ASSISTANT_PREFS_KEY}`

beforeEach(() => {
  localStorage.clear()
  __resetAssistantPrefsForTests()
})

describe('provider preference', () => {
  it('exposes exactly the two rails, membership first, frozen', () => {
    expect(ASSISTANT_PROVIDERS).toEqual(['fairwins', 'guttertoken'])
    expect(Object.isFrozen(ASSISTANT_PROVIDERS)).toBe(true)
    expect(DEFAULT_ASSISTANT_PREFS.provider).toBe('fairwins')
  })

  it('defaults to fairwins for a fresh account and for no account', () => {
    expect(getAssistantProvider(ACCOUNT)).toBe('fairwins')
    expect(getAssistantProvider(undefined)).toBe('fairwins')
    expect(loadAssistantPrefs(ACCOUNT).provider).toBe('fairwins')
  })

  it('round-trips guttertoken and is wallet-scoped', () => {
    setAssistantProvider(ACCOUNT, 'guttertoken')
    expect(getAssistantProvider(ACCOUNT)).toBe('guttertoken')
    __resetAssistantPrefsForTests()
    expect(getAssistantProvider(ACCOUNT)).toBe('guttertoken') // re-read from storage
    expect(getAssistantProvider(OTHER)).toBe('fairwins')
  })

  it('stores the default as absence, so an untouched member keeps the spec-095 blob shape', () => {
    setAssistantEnabled(ACCOUNT, true)
    expect(JSON.parse(localStorage.getItem(storageKey(ACCOUNT)))).toEqual({ enabled: true, retainMemory: true })
    setAssistantProvider(ACCOUNT, 'guttertoken')
    expect(JSON.parse(localStorage.getItem(storageKey(ACCOUNT)))).toEqual({ enabled: true, retainMemory: true, provider: 'guttertoken' })
    setAssistantProvider(ACCOUNT, 'fairwins')
    expect(JSON.parse(localStorage.getItem(storageKey(ACCOUNT)))).toEqual({ enabled: true, retainMemory: true })
  })

  it.each(['openai', '', null, 42, 'GUTTERTOKEN', { provider: 'guttertoken' }])(
    'reads a foreign stored value (%j) as the default rail',
    (value) => {
      localStorage.setItem(storageKey(ACCOUNT), JSON.stringify({ enabled: true, provider: value }))
      expect(getAssistantProvider(ACCOUNT)).toBe('fairwins')
    }
  )

  it('falls back to the default rail when set to something it does not know', () => {
    setAssistantProvider(ACCOUNT, 'guttertoken')
    setAssistantProvider(ACCOUNT, 'anything-else')
    expect(getAssistantProvider(ACCOUNT)).toBe('fairwins')
  })

  it('leaves the other fields alone and notifies subscribers', () => {
    setAssistantEnabled(ACCOUNT, true)
    const seen = []
    subscribeAssistantPrefs(() => seen.push('called'))
    setAssistantProvider(ACCOUNT, 'guttertoken')
    expect(loadAssistantPrefs(ACCOUNT)).toEqual({ enabled: true, retainMemory: true, provider: 'guttertoken' })
    expect(seen).toEqual(['called'])
  })

  it('stays out of the spec-032 synced object registry', () => {
    const registry = readFileSync(resolve(process.cwd(), 'src/lib/backup/syncedObjects.js'), 'utf-8')
    expect(registry).not.toContain(ASSISTANT_PREFS_KEY)
    expect(registry).not.toContain('provider:')
  })
})
