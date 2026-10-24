import { describe, it, expect } from 'vitest'
import { buildFundingPoolUrl, parseFundingRef, FUNDING_ROUTE_PREFIX } from '../../lib/funding/deepLink'

const ADDR = '0x5067457698Fd6Fa1C6964e416b3f42713513B3dD'

describe('buildFundingPoolUrl (FR-020)', () => {
  it('prefers the four words, hyphen-joined, under /fund/', () => {
    expect(buildFundingPoolUrl({ phrase: 'river amber tiger kite', address: ADDR, origin: 'https://app.test' }))
      .toBe('https://app.test/fund/river-amber-tiger-kite')
  })
  it('falls back to the address when the phrase is missing or malformed', () => {
    expect(buildFundingPoolUrl({ phrase: null, address: ADDR, origin: 'https://app.test' })).toBe(`https://app.test/fund/${ADDR}`)
    expect(buildFundingPoolUrl({ phrase: 'only three words', address: ADDR, origin: '' })).toBe(`/fund/${ADDR}`)
  })
  it('percent-encodes non-Latin words', () => {
    const url = buildFundingPoolUrl({ phrase: 'あいこくしん あおぞら あんこ いえき', origin: '' })
    expect(url.startsWith(FUNDING_ROUTE_PREFIX)).toBe(true)
    expect(url).not.toMatch(/[^\x20-\x7e]/)
    expect(parseFundingRef(url)).toEqual({ words: ['あいこくしん', 'あおぞら', 'あんこ', 'いえき'] })
  })
  it('throws with nothing to build from', () => {
    expect(() => buildFundingPoolUrl({})).toThrow()
  })
})

describe('parseFundingRef', () => {
  it('reads an address, hyphenated words, spaced words, and a pasted full link', () => {
    expect(parseFundingRef(ADDR)).toEqual({ address: ADDR })
    expect(parseFundingRef('river-amber-tiger-kite')).toEqual({ words: ['river', 'amber', 'tiger', 'kite'] })
    expect(parseFundingRef('  River Amber  tiger kite ')).toEqual({ words: ['river', 'amber', 'tiger', 'kite'] })
    expect(parseFundingRef('https://app.test/fund/river-amber-tiger-kite?x=1#y')).toEqual({ words: ['river', 'amber', 'tiger', 'kite'] })
    expect(parseFundingRef(`https://app.test/fund/${ADDR}`)).toEqual({ address: ADDR })
  })
  it('returns null for anything else', () => {
    expect(parseFundingRef('')).toBeNull()
    expect(parseFundingRef('three words only')).toBeNull()
    expect(parseFundingRef('0x1234')).toBeNull()
    expect(parseFundingRef(null)).toBeNull()
  })
})
