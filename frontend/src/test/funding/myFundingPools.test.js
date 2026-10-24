import { describe, it, expect, beforeEach } from 'vitest'
import { readFundingPools, recordFundingPool, forgetFundingPool } from '../../lib/funding/myFundingPools'

const ACCT = '0xAbC0000000000000000000000000000000000001'
const P1 = '0x1111111111111111111111111111111111111111'
const P2 = '0x2222222222222222222222222222222222222222'

describe('device record of funding pools (FR-023)', () => {
  beforeEach(() => localStorage.clear())

  it('records idempotently, lowercases, and keeps the organizer role once set', () => {
    recordFundingPool(ACCT, P1, 'contributor')
    recordFundingPool(ACCT, P1.toUpperCase().replace('0X', '0x'), 'contributor')
    expect(readFundingPools(ACCT)).toEqual([{ address: P1.toLowerCase(), role: 'contributor' }])
    recordFundingPool(ACCT, P1, 'organizer')
    expect(readFundingPools(ACCT)[0].role).toBe('organizer')
    recordFundingPool(ACCT, P1, 'contributor')
    expect(readFundingPools(ACCT)[0].role).toBe('organizer')
  })

  it('is per account and forgettable', () => {
    recordFundingPool(ACCT, P1, 'organizer')
    recordFundingPool(ACCT, P2, 'contributor')
    expect(readFundingPools('0x0000000000000000000000000000000000000009')).toEqual([])
    forgetFundingPool(ACCT, P1)
    expect(readFundingPools(ACCT).map((e) => e.address)).toEqual([P2.toLowerCase()])
  })

  it('tolerates a corrupt entry', () => {
    localStorage.setItem(`fairwins_funding_pools_v1_${ACCT.toLowerCase()}`, '{not json')
    expect(readFundingPools(ACCT)).toEqual([])
    expect(readFundingPools(null)).toEqual([])
  })
})
