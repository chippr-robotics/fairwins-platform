import { describe, it, expect, afterEach, vi } from 'vitest'
import { stamp, ageMs } from '../../lib/markets/serverClock'

afterEach(() => vi.useRealTimers())

describe('serverClock', () => {
  const t = { confirmedAt: '2026-11-26T02:10:00.000Z', serverNow: '2026-11-26T02:10:01.200Z' }

  it('age = (serverNow - confirmedAt) + monotonic elapsed since receipt', () => {
    const s = stamp(t, 1000)
    expect(ageMs(s, 1000)).toBe(1200)
    expect(ageMs(s, 3500)).toBe(3700)
  })

  it('is unaffected by a device wall clock that is an hour wrong', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-26T03:10:00.000Z')) // device is +1 h
    const s = stamp(t, 500)
    expect(ageMs(s, 500)).toBe(1200)
    vi.setSystemTime(new Date('2026-11-26T01:10:00.000Z')) // and now -1 h
    expect(ageMs(s, 2500)).toBe(3200)
  })

  it('never reads Date.now for the age', () => {
    const spy = vi.spyOn(Date, 'now')
    const s = stamp(t, 0)
    ageMs(s, 10)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('clamps negative gateway skew at 0 (never younger than just now)', () => {
    const s = stamp({ confirmedAt: '2026-11-26T02:10:05.000Z', serverNow: '2026-11-26T02:10:00.000Z' }, 100)
    expect(ageMs(s, 100)).toBe(0)
    expect(ageMs(s, 400)).toBe(300)
  })

  it('unparsable, missing or absent stamps are unknown (null), never 0', () => {
    expect(ageMs(stamp({ confirmedAt: 'nope', serverNow: t.serverNow }, 0), 0)).toBeNull()
    expect(ageMs(stamp({ confirmedAt: t.confirmedAt }, 0), 0)).toBeNull()
    expect(ageMs(stamp({}, 0), 0)).toBeNull()
    expect(ageMs(stamp(undefined, 0), 0)).toBeNull()
    expect(ageMs(undefined, 0)).toBeNull()
    expect(ageMs(null)).toBeNull()
  })
})
