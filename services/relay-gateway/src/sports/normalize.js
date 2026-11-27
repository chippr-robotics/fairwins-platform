/**
 * Upstream -> the spec-115 envelope (contracts/gateway-sports-api.md).
 *
 * THE RULE OF THE FILE: a number exists only where a source gave one. There is no `?? 0` and no
 * `|| 0` below; `Number('')` is 0 and `Number(null)` is 0, so numbers are read only through
 * `intOrNull`, which accepts a finite integer or a string of digits and nothing else. Text from a
 * source is forwarded as text: control characters stripped, length capped, no HTML, no URL, no
 * image field is ever copied across.
 */
import { plainText } from '../polymarket/normalize.js'
import { leagueConfig } from './leagues.js'

/** A non-negative integer from a number or a string of digits; null for anything else (incl. '' / null). */
export function intOrNull(v, max = 999) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null
  if (typeof v === 'string' && /^\d{1,6}$/.test(v)) {
    const n = Number(v)
    return n <= max ? n : null
  }
  return null
}

const text = (v, max) => {
  const t = plainText(v, max)
  return t == null ? null : t.trim() === '' ? null : t.trim()
}

const SCORE_RE = /^\s*(\d{1,3})\s*-\s*(\d{1,3})\s*$/
const SCHEDULED_RE = /^(scheduled|notstarted|not started|ns|upcoming|pre)$/i
const LIVE_RE = /^(inprogress|in progress|running|live|in)$/i
const OFF_RE = /(cancel|postpon|suspend|abandon|delay|forfeit)/i

/** One venue frame -> the small object the feed keeps, or null when it names no integer game. */
export function parseVenueFrame(raw, receivedAt) {
  const gameId = intOrNull(raw?.gameId, Number.MAX_SAFE_INTEGER)
  if (gameId == null || gameId === 0) return null
  const league = typeof raw.leagueAbbreviation === 'string' ? raw.leagueAbbreviation.trim().toLowerCase().slice(0, 32) : null
  const homeTeam = text(raw.homeTeam, 60)
  const awayTeam = text(raw.awayTeam, 60)
  const scoreText = typeof raw.score === 'string' ? text(raw.score, 40) : null

  // Which number is whose is a per-league fact (leagues.js). Unknown league => no integer score.
  let score = null
  const order = leagueConfig(league)?.scoreOrder
  const m = typeof raw.score === 'string' ? SCORE_RE.exec(raw.score) : null
  if (m && order) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    score = order === 'away-home' ? { home: b, away: a } : { home: a, away: b }
  }

  const statusWord = typeof raw.status === 'string' ? raw.status.trim() : ''
  let status = null
  if (OFF_RE.test(statusWord)) status = null // not a game state we can name
  else if (raw.ended === true) status = 'ended'
  else if (raw.live === true || LIVE_RE.test(statusWord)) status = 'in-progress'
  else if (SCHEDULED_RE.test(statusWord)) status = 'scheduled'

  // `turn` is a lower-case team code; it names a side only when it equals one of the two codes.
  let possession = null
  if (typeof raw.turn === 'string' && raw.turn.trim() !== '') {
    const t = raw.turn.trim().toLowerCase()
    if (homeTeam && t === homeTeam.toLowerCase()) possession = 'home'
    else if (awayTeam && t === awayTeam.toLowerCase()) possession = 'away'
  }

  return {
    gameId,
    league,
    homeTeam,
    awayTeam,
    status,
    score,
    scoreText: score ? null : scoreText,
    period: text(raw.period, 20),
    clock: text(raw.elapsed, 20),
    possession,
    receivedAt,
  }
}

// ---- ESPN ---------------------------------------------------------------------------------------

const ESPN_STATE = { pre: 'scheduled', in: 'in-progress', post: 'ended' }

export function footballPeriodLabel(n) {
  if (!Number.isInteger(n) || n < 1) return null
  if (n <= 4) return `Q${n}`
  return n === 5 ? 'OT' : `${n - 4}OT`
}

/** The ball's position on the 0-100 axis from the HOME goal line (0) to the AWAY goal line (100), or null. */
export function deriveYardLine(situation, home, away) {
  const t = typeof situation?.possessionText === 'string' ? situation.possessionText.trim() : ''
  let axis = null
  const side = /^([A-Za-z]{2,4}) (\d{1,2})$/.exec(t)
  if (side) {
    const n = Number(side[2])
    if (n >= 1 && n <= 49) {
      const code = side[1].toUpperCase()
      if (home?.code && code === home.code) axis = n
      else if (away?.code && code === away.code) axis = 100 - n
    }
  } else if (t === '50') {
    axis = 50
  }
  if (axis == null) return null
  // Cross-check against ESPN's own numeric `yardLine`. Measured (research R3): it is ALREADY on this
  // axis — yards from the HOME goal line, whoever has the ball (PHI own 21 away => 79; DAL own 41 home
  // => 41). The two readings come from different fields; if they disagree one of them is wrong and we
  // do not know which, so the field is null rather than either guess.
  const numeric = intOrNull(situation?.yardLine, 100)
  if (numeric != null && numeric !== axis) return null
  return axis
}

/** ESPN situation -> contract `detail.situation` (football), or null when none is reported. */
export function normalizeSituation(raw, home, away) {
  if (!raw || typeof raw !== 'object') return null
  const possession = raw.possession == null ? null : String(raw.possession) === home?.id ? 'home' : String(raw.possession) === away?.id ? 'away' : null
  const down = intOrNull(raw.down, 4)
  const distance = intOrNull(raw.distance, 100)
  const yardLine = deriveYardLine(raw, home, away)
  let lineToGain = null
  if (yardLine != null && distance != null && possession != null) {
    const target = possession === 'home' ? yardLine + distance : yardLine - distance
    lineToGain = target >= 0 && target <= 100 ? target : null
  }
  const out = {
    possession,
    yardLine,
    yardLineText: text(raw.possessionText, 20),
    down: down != null && down >= 1 ? down : null,
    distance,
    downDistanceText: text(raw.downDistanceText, 60),
    lineToGain,
    redZone: typeof raw.isRedZone === 'boolean' ? raw.isRedZone : null,
  }
  // Between plays ESPN reports nothing: say null, not a row of nulls.
  return Object.values(out).every((v) => v == null) ? null : out
}

function normalizeCompetitor(c) {
  return {
    id: c?.team?.id == null ? null : String(c.team.id),
    code: typeof c?.team?.abbreviation === 'string' ? c.team.abbreviation.trim().toUpperCase() : null,
    score: typeof c?.score === 'string' || typeof c?.score === 'number' ? intOrNull(c.score) : null,
  }
}

/** ESPN scoreboard body -> events the matcher and the row builder use. Malformed events are dropped. */
export function parseScoreboard(body) {
  const events = Array.isArray(body?.events) ? body.events : []
  const out = []
  for (const e of events) {
    const comp = e?.competitions?.[0]
    const id = typeof e?.id === 'string' && /^\d{1,12}$/.test(e.id) ? e.id : null
    if (!id || !comp) continue
    const competitors = Array.isArray(comp.competitors) ? comp.competitors : []
    const homeRaw = competitors.find((c) => c?.homeAway === 'home')
    const awayRaw = competitors.find((c) => c?.homeAway === 'away')
    if (!homeRaw || !awayRaw) continue
    const home = normalizeCompetitor(homeRaw)
    const away = normalizeCompetitor(awayRaw)
    const startMs = typeof e.date === 'string' && Number.isFinite(Date.parse(e.date)) ? Date.parse(e.date) : null
    const periodN = intOrNull(comp.status?.period, 20)
    const state = ESPN_STATE[comp.status?.type?.state] ?? null
    out.push({
      id,
      startMs,
      state,
      period: periodN != null && periodN > 0 ? periodN : null,
      clock: text(comp.status?.displayClock, 20),
      home,
      away,
      situation: normalizeSituation(comp.situation, home, away),
    })
  }
  return out
}

const MAX_PLAYS = 12

/**
 * ESPN summary body -> `{ plays, final }`: at most 12 plays, newest first. Side comes from the DRIVE's
 * team (a play carries none) and is null when the drive's team is not one of the two competitors.
 */
export function parseSummary(body) {
  const header = body?.header?.competitions?.[0]
  const comps = Array.isArray(header?.competitors) ? header.competitors : []
  const idSide = new Map()
  for (const c of comps) if (c?.team?.id != null && (c.homeAway === 'home' || c.homeAway === 'away')) idSide.set(String(c.team.id), c.homeAway)
  const drives = [...(Array.isArray(body?.drives?.previous) ? body.drives.previous : []), ...(body?.drives?.current ? [body.drives.current] : [])]
  const seen = new Set()
  const plays = []
  let order = 0
  for (const d of drives) {
    const side = d?.team?.id == null ? null : (idSide.get(String(d.team.id)) ?? null)
    for (const p of Array.isArray(d?.plays) ? d.plays : []) {
      const id = p?.id == null ? null : String(p.id).slice(0, 40)
      const t = text(p?.text, 300)
      if (!id || seen.has(id) || !t) continue
      seen.add(id)
      const seq = typeof p.sequenceNumber === 'string' && /^\d{1,12}$/.test(p.sequenceNumber) ? Number(p.sequenceNumber) : null
      plays.push({
        id,
        seq,
        order: order++,
        period: footballPeriodLabel(intOrNull(p?.period?.number, 20)),
        clock: text(p?.clock?.displayValue, 20),
        text: t,
        scoring: p?.scoringPlay === true,
        side,
      })
    }
  }
  plays.sort((a, b) => (a.seq != null && b.seq != null ? b.seq - a.seq : b.order - a.order))
  const state = ESPN_STATE[header?.status?.type?.state] ?? null
  return {
    state,
    plays: plays.slice(0, MAX_PLAYS).map(({ id, period, clock, text: t, scoring, side }) => ({ id, period, clock, text: t, scoring, side })),
  }
}

// ---- the row -------------------------------------------------------------------------------------

const sameScore = (a, b) => a != null && b != null && a.home === b.home && a.away === b.away

export const emptyRow = (gameId) => ({
  gameId,
  league: null,
  status: null,
  score: null,
  scoreText: null,
  period: null,
  clock: null,
  possession: null,
  confirmedAt: null,
  confirmedBy: null,
  agree: null,
})

/**
 * One row from what each source said. `venue` is `{frame, at}`, `play` is `{event, at}` (the plays
 * source's scoreboard event and the time it was read) — either may be null.
 *
 * Where the sources disagree the VENUE's score is returned (FR-008). When the venue has spoken, every
 * field of the row is the venue's: mixing a venue score with an ESPN clock would present two moments
 * as one. The plays source supplies the row only when the venue has said nothing about the game.
 */
export function buildRow(gameId, venue, play) {
  if (venue) {
    const f = venue.frame
    const playScore = play?.event && play.event.home.score != null && play.event.away.score != null ? { home: play.event.home.score, away: play.event.away.score } : null
    const agree = f.score && playScore ? sameScore(f.score, playScore) : null
    return {
      gameId,
      league: f.league,
      status: f.status,
      score: f.score,
      scoreText: f.scoreText,
      period: f.period,
      clock: f.clock,
      possession: f.possession,
      // Both sources spoke and agree: the newer confirmation counts. Disagreement or one voice: the venue's own.
      confirmedAt: agree === true ? Math.max(venue.at, play.at) : venue.at,
      confirmedBy: agree === true ? 'both' : 'venue',
      agree,
    }
  }
  if (play?.event) {
    const e = play.event
    const score = e.home.score != null && e.away.score != null ? { home: e.home.score, away: e.away.score } : null
    return {
      gameId,
      league: play.league ?? null,
      status: e.state,
      score,
      scoreText: null,
      period: footballPeriodLabel(e.period),
      clock: e.clock,
      possession: e.situation?.possession ?? null,
      confirmedAt: play.at,
      confirmedBy: 'plays',
      agree: null,
    }
  }
  return emptyRow(gameId)
}
