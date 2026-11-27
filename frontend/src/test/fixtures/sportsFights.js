// Gateway `/v1/sports/fights/:gameId` DTOs (spec 115 contracts/fight-api.md). Values are shaped after the
// recorded UFC payloads in services/relay-gateway/test/fixtures/sports/fight/ (UFC 334, fight 13140).
import { SERVER_NOW } from './sportsGames'
export { SERVER_NOW }

export const FIGHT_LISTING = {
  gameId: 13140,
  league: 'ufc',
  startTime: '2026-11-14T22:00:00Z',
  teams: [{ name: 'Ciryl Gane', code: null }, { name: 'Josh Hokit', code: null }],
}

const NULL_FIGURES = {
  knockdowns: null, sigStrikesLanded: null, sigStrikesAttempted: null, totalStrikesLanded: null, totalStrikesAttempted: null,
  headStrikesLanded: null, headStrikesAttempted: null, bodyStrikesLanded: null, bodyStrikesAttempted: null,
  legStrikesLanded: null, legStrikesAttempted: null, takedownsLanded: null, takedownsAttempted: null,
  reversals: null, submissionsAttempted: null, controlSeconds: null,
}
export const figures = (over = {}) => ({ ...NULL_FIGURES, ...over })

export const ROUND1 = [
  figures({ knockdowns: 0, sigStrikesLanded: 41, sigStrikesAttempted: 65, totalStrikesLanded: 41, totalStrikesAttempted: 66, headStrikesLanded: 34, headStrikesAttempted: 56, bodyStrikesLanded: 7, bodyStrikesAttempted: 9, legStrikesLanded: 0, legStrikesAttempted: 0, takedownsLanded: 0, takedownsAttempted: 0, reversals: 0, submissionsAttempted: 0, controlSeconds: 3 }),
  figures({ knockdowns: 0, sigStrikesLanded: 22, sigStrikesAttempted: 51, totalStrikesLanded: 30, totalStrikesAttempted: 60, headStrikesLanded: 20, headStrikesAttempted: 49, bodyStrikesLanded: 2, bodyStrikesAttempted: 2, legStrikesLanded: 0, legStrikesAttempted: 0, takedownsLanded: 1, takedownsAttempted: 6, reversals: 0, submissionsAttempted: 0, controlSeconds: 71 }),
]
export const OVERALL = [
  figures({ knockdowns: 0, sigStrikesLanded: 237, sigStrikesAttempted: 343, totalStrikesLanded: 298, totalStrikesAttempted: 412, headStrikesLanded: 170, headStrikesAttempted: 273, bodyStrikesLanded: 63, bodyStrikesAttempted: 66, legStrikesLanded: 4, legStrikesAttempted: 4, takedownsLanded: 0, takedownsAttempted: 0, reversals: 0, submissionsAttempted: 0, controlSeconds: 4 }),
  figures({ knockdowns: 0, sigStrikesLanded: 146, sigStrikesAttempted: 283, totalStrikesLanded: 243, totalStrikesAttempted: 384, headStrikesLanded: 138, headStrikesAttempted: 273, bodyStrikesLanded: 8, bodyStrikesAttempted: 10, legStrikesLanded: 0, legStrikesAttempted: 0, takedownsLanded: 3, takedownsAttempted: 30, reversals: 0, submissionsAttempted: 0, controlSeconds: 277 }),
]

export const SOURCES = {
  venue: { state: 'read', label: 'Polymarket' },
  card: { state: 'read', label: 'ESPN' },
  figures: { state: 'read', label: 'UFC' },
}

export const fight = (over = {}) => ({
  gameId: 13140,
  source: 'card',
  status: 'in-progress',
  scheduledRounds: 5,
  weightClass: 'Heavyweight',
  round: 2,
  clock: '3:12',
  confirmedAt: SERVER_NOW - 2000,
  changedAt: null,
  fighters: [{ name: 'Ciryl Gane' }, { name: 'Josh Hokit' }],
  result: null,
  venue: null,
  rounds: [{ round: 1, figures: ROUND1 }],
  overall: null,
  ...over,
})

export const DECISION = {
  source: 'figures',
  outcome: 'win',
  winner: 0,
  method: 'Decision - Unanimous',
  endingRound: 5,
  endingTime: '5:00',
  judges: [
    { name: 'Adrian Castro', scores: [48, 47] },
    { name: 'Junichiro Kamijo', scores: [49, 46] },
    { name: 'Sal D’Amato', scores: [48, 47] },
  ],
}
export const KO = { source: 'figures', outcome: 'win', winner: 1, method: 'KO/TKO', endingRound: 1, endingTime: '0:24', judges: [] }

export const fightEnvelope = (f, over = {}) => ({ serverNow: SERVER_NOW, sources: SOURCES, fight: f, ...over })
