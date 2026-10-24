import { describe, it, expect } from 'vitest'

// Spec 102 FR-015 — the stale-build floor. The rule with teeth: every failure
// to LEARN the floor is `unknown` (renders nothing), never `below-floor` — an
// unreachable origin must not manufacture an update banner — and never
// `supported` — an unreachable origin proves nothing about support either.
import {
  compareVersions,
  evaluateSupportFloor,
  checkSupportFloor,
} from '../../lib/native/supportFloor'

describe('supportFloor', () => {
  it('compares semver honestly, v-prefix tolerated, garbage is null', () => {
    expect(compareVersions('1.14.0', 'v1.15.0')).toBeLessThan(0)
    expect(compareVersions('v2.0.0', '1.999.999')).toBeGreaterThan(0)
    expect(compareVersions('1.15.0', '1.15.0')).toBe(0)
    expect(compareVersions('latest', '1.0.0')).toBeNull()
  })

  it('evaluates below-floor with the update path carried through', () => {
    const result = evaluateSupportFloor({ current: '1.10.0', floor: 'v1.14.0', updateUrl: 'https://x' })
    expect(result).toEqual({ state: 'below-floor', current: '1.10.0', floor: '1.14.0', updateUrl: 'https://x' })
    expect(evaluateSupportFloor({ current: '1.14.0', floor: '1.14.0' }).state).toBe('supported')
  })

  it('an unparseable current or floor is unknown, never a verdict', () => {
    expect(evaluateSupportFloor({ current: '0.0.0-dev', floor: '1.0.0' }).state).toBe('unknown')
    expect(evaluateSupportFloor({ current: '1.0.0', floor: undefined }).state).toBe('unknown')
  })

  it('every fetch failure mode is unknown: offline, 404, malformed, missing field', async () => {
    const offline = await checkSupportFloor({
      origin: 'https://t.example',
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    })
    expect(offline.state).toBe('unknown')

    const notFound = await checkSupportFloor({
      origin: 'https://t.example',
      fetchImpl: async () => ({ ok: false, status: 404 }),
    })
    expect(notFound.state).toBe('unknown')

    const malformed = await checkSupportFloor({
      origin: 'https://t.example',
      fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('nope') } }),
    })
    expect(malformed.state).toBe('unknown')

    const missingField = await checkSupportFloor({
      origin: 'https://t.example',
      fetchImpl: async () => ({ ok: true, json: async () => ({ hello: 'world' }) }),
    })
    expect(missingField.state).toBe('unknown')
  })

  it('a published floor above the running build is below-floor', async () => {
    const result = await checkSupportFloor({
      origin: 'https://t.example/',
      current: '1.10.0',
      fetchImpl: async (url) => {
        expect(url).toBe('https://t.example/.well-known/fairwins-native-support.json')
        return { ok: true, json: async () => ({ minimumVersion: '1.14.0', updateUrl: 'https://store' }) }
      },
    })
    expect(result).toEqual({ state: 'below-floor', current: '1.10.0', floor: '1.14.0', updateUrl: 'https://store' })
  })
})
