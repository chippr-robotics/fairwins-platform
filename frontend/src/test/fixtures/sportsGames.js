// Gateway `/v1/sports/*` DTOs (spec 115 contracts/gateway-sports-api.md) as fixtures. The gateway is built
// separately, so these ARE the contract as far as the frontend is concerned.
export const SERVER_NOW = 1795737600000

export const LISTING = {
  gameId: 19618,
  league: 'nfl',
  startTime: '2026-11-26T21:30:00Z',
  listed: { status: 'in-progress', scoreText: '10-28', period: 'Q3', clock: '10:39' },
  home: { name: 'Cowboys', code: 'DAL' },
  away: { name: 'Eagles', code: 'PHI' },
}

export const TEAMS_LISTING = {
  gameId: 19619,
  league: 'nfl',
  startTime: '2026-11-26T21:30:00Z',
  teams: [
    { name: 'Eagles', code: 'PHI' },
    { name: 'Cowboys', code: 'DAL' },
  ],
}

export const row = (over = {}) => ({
  gameId: 19618,
  league: 'nfl',
  status: 'in-progress',
  score: { home: 28, away: 10 },
  period: 'Q3',
  clock: '10:39',
  possession: 'home',
  source: 'plays',
  confirmedAt: SERVER_NOW - 2000,
  changedAt: null,
  agree: true,
  venue: null,
  ...over,
})

export const situation = (over = {}) => ({
  possession: 'home',
  yardLine: 37,
  yardLineText: 'DAL 37',
  down: 4,
  distance: 18,
  downDistanceText: '4th & 18 at DAL 37',
  lineToGain: 55,
  redZone: false,
  ...over,
})

export const plays = () => [
  { id: 'p3', period: 'Q3', clock: '10:44', text: 'Dak Prescott pass incomplete to CeeDee Lamb.', scoring: false, side: 'home' },
  { id: 'p2', period: 'Q3', clock: '11:20', text: 'Jake Elliott 42 yard field goal is GOOD.', scoring: true, side: 'away' },
  { id: 'p1', period: 'Q3', clock: '12:05', text: 'Kickoff returned to the 25.', scoring: false, side: 'home' },
]

export const detail = (over = {}) => ({
  state: 'read',
  confirmedAt: SERVER_NOW - 3000,
  situation: situation(),
  plays: plays(),
  ...over,
})

/** A venue-sourced row: its own frame time, never live whatever its age. */
export const venueRow = (over = {}) =>
  row({ source: 'venue', score: { home: 21, away: 10 }, possession: null, changedAt: SERVER_NOW - 40_000, confirmedAt: SERVER_NOW - 5000, agree: null, ...over })

export const SOURCES = { venue: { state: 'read', label: 'Polymarket' }, plays: { state: 'read', label: 'ESPN' } }

export const envelope = (r, over = {}) => ({
  serverNow: SERVER_NOW,
  sources: SOURCES,
  games: [r],
  ...over,
})
