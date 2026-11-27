import { describe, it, expect } from 'vitest'
import { sidesOf, teamLabel, situationSentence, yardWords, downAndDistance, formatStart } from '../../lib/sports/describe'
import { LISTING, TEAMS_LISTING, situation } from '../fixtures/sportsGames'

describe('sidesOf', () => {
  it('is homeAway only when the venue said so', () => {
    expect(sidesOf(LISTING).kind).toBe('homeAway')
    const t = sidesOf(TEAMS_LISTING)
    expect(t.kind).toBe('teams')
    expect(t.teams.map(teamLabel)).toEqual(['Eagles', 'Cowboys'])
    expect(sidesOf({ gameId: 1 }).kind).toBe('none')
    expect(sidesOf(null).kind).toBe('none')
  })
  it('a team with only a code is labelled by it; with neither, null', () => {
    expect(teamLabel({ name: null, code: 'DAL' })).toBe('DAL')
    expect(teamLabel({ name: ' ', code: null })).toBeNull()
  })
})

describe('words', () => {
  const names = { home: 'Cowboys', away: 'Eagles' }
  it('turns the home-axis yard into a team yard line, midfield, or null out of range', () => {
    expect(yardWords(37, { homeName: 'DAL', awayName: 'PHI' })).toBe('DAL 37')
    expect(yardWords(80, { homeName: 'DAL', awayName: 'PHI' })).toBe('PHI 20')
    expect(yardWords(50, {})).toBe('midfield')
    expect(yardWords(null, {})).toBeNull()
    expect(yardWords(104, {})).toBeNull()
  })
  it('down and distance needs both numbers', () => {
    expect(downAndDistance({ down: 3, distance: 7 })).toBe('3rd & 7')
    expect(downAndDistance({ down: 3, distance: null })).toBeNull()
    expect(downAndDistance({ down: 9, distance: 1 })).toBeNull()
  })
  it('carries every fact of the drawing: down and distance, possession, direction, line to gain', () => {
    const s = situationSentence(situation(), names)
    expect(s).toContain('4th & 18 at DAL 37')
    expect(s).toContain('Cowboys have the ball, driving toward the Eagles end zone')
    expect(s).toContain('Line to gain: Eagles 45')
  })
  it('an away drive points the other way; absent facts are skipped, never zero', () => {
    const s = situationSentence(situation({ possession: 'away', lineToGain: null, downDistanceText: null, down: null, distance: null, yardLineText: null }), names)
    expect(s).toBe('Eagles have the ball, driving toward the Cowboys end zone.')
    expect(s).not.toMatch(/\b0\b/)
  })
  it('says nothing for an empty situation', () => {
    expect(situationSentence(null, names)).toBeNull()
    expect(situationSentence(situation({ possession: null, lineToGain: null, downDistanceText: null, down: null, distance: null, yardLineText: null }), names)).toBeNull()
  })
  it('a start that is not a date is null', () => {
    expect(formatStart('not a date')).toBeNull()
    expect(formatStart(null)).toBeNull()
    expect(formatStart('2026-11-26T21:30:00Z')).toEqual(expect.any(String))
  })
})
