// Gateway `/v1/sports/*` DTOs (spec 115 contracts/gateway-sports-api.md) as fixtures. The gateway is built
// separately, so these ARE the contract as far as the frontend is concerned.
export const SERVER_NOW = 1795737600000

export const LISTING = {
  gameId: 19618,
  league: 'nfl',
  startTime: '2026-11-26T21:30:00Z',
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
  confirmedAt: SERVER_NOW - 2000,
  confirmedBy: 'venue',
  agree: true,
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
  behindVenue: false,
  ...over,
})

export const envelope = (r, over = {}) => ({
  serverNow: SERVER_NOW,
  sources: { venue: { state: 'read' }, plays: { state: 'read' } },
  games: [r],
  ...over,
})
