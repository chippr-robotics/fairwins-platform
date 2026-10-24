/**
 * resolveProvider (spec 104) — the whole matrix, as a table.
 *
 * Inputs: the preference (`off` | `fairwins` | `guttertoken`), whether a key is saved, and the
 * three-state membership read. Output: the rail, the reason the panel renders, and whether the
 * Settings radio is live. Two rows carry the design's weight — a member who chose GutterToken and
 * lost the key is NOT moved back to FairWins, and an unreadable membership is never "not a member".
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { __resetAssistantPrefsForTests, setAssistantEnabled, setAssistantProvider } from '../../lib/assistant/assistantPrefs'
import { __resetGutterTokenKeyForTests, saveGutterTokenKey } from '../../lib/assistant/guttertokenKeyStore'
import { resolveProvider } from '../../lib/assistant/resolveProvider'

const ACCOUNT = '0xAbCdEF0123456789abcdef0123456789ABCDEF01'
const KEY = 'sk-gt-0123456789abcdefghijklmnopqrstuvwxyz'

const MEMBERSHIP = {
  pending: null,
  unreadable: { readable: false, isActive: false },
  active: { readable: true, isActive: true },
  inactive: { readable: true, isActive: false },
}

beforeEach(() => {
  localStorage.clear()
  __resetAssistantPrefsForTests()
  __resetGutterTokenKeyForTests()
})

function arrange({ pref, key }) {
  if (pref !== 'off') {
    setAssistantEnabled(ACCOUNT, true)
    setAssistantProvider(ACCOUNT, pref)
  }
  if (key) saveGutterTokenKey(ACCOUNT, KEY)
}

describe('resolveProvider matrix', () => {
  it.each([
    // pref          key    membership     → provider       reason        canChoose
    ['off',          false, 'active',       null,           'disabled',   false],
    ['off',          true,  'active',       null,           'disabled',   false],
    ['off',          true,  'pending',      null,           'disabled',   false],

    ['guttertoken',  true,  'active',       'guttertoken',  'key',        true],
    ['guttertoken',  true,  'inactive',     'guttertoken',  'key',        false],
    ['guttertoken',  true,  'pending',      'guttertoken',  'key',        false],
    ['guttertoken',  true,  'unreadable',   'guttertoken',  'key',        false],
    // The choice is respected: no silent move back to the membership rail.
    ['guttertoken',  false, 'active',       null,           'no-key',     false],
    ['guttertoken',  false, 'inactive',     null,           'no-key',     false],
    ['guttertoken',  false, 'pending',      null,           'no-key',     false],
    ['guttertoken',  false, 'unreadable',   null,           'no-key',     false],

    ['fairwins',     false, 'active',       'fairwins',     'member',     false],
    ['fairwins',     true,  'active',       'fairwins',     'member',     true],
    ['fairwins',     false, 'pending',      null,           'pending',    false],
    ['fairwins',     true,  'pending',      null,           'pending',    false],
    ['fairwins',     false, 'unreadable',   null,           'unreadable', false],
    ['fairwins',     true,  'unreadable',   null,           'unreadable', false],
    // A non-member's only rail is the key.
    ['fairwins',     true,  'inactive',     'guttertoken',  'key',        false],
    ['fairwins',     false, 'inactive',     null,           'not-member', false],
  ])('pref=%s key=%s membership=%s → %s / %s / canChoose=%s', (pref, key, membership, provider, reason, canChoose) => {
    arrange({ pref, key })
    expect(resolveProvider({ account: ACCOUNT, membership: MEMBERSHIP[membership] })).toEqual({ provider, reason, canChoose })
  })

  it('treats a truthy-but-not-true isActive as not active', () => {
    arrange({ pref: 'fairwins', key: false })
    expect(resolveProvider({ account: ACCOUNT, membership: { readable: true, isActive: 'yes' } })).toEqual({
      provider: null,
      reason: 'not-member',
      canChoose: false,
    })
  })

  it('reports disabled for no account at all', () => {
    expect(resolveProvider({ account: null, membership: MEMBERSHIP.active })).toEqual({ provider: null, reason: 'disabled', canChoose: false })
  })
})
