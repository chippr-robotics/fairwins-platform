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

/**
 * ESPN's `post` means "no longer on the schedule as upcoming", not "played to a finish": a postponed
 * or cancelled game is also `post`, with `completed: false`. Calling that `ended` would put "Ended"
 * beside a market for a game that was never played, and freeze it. So `ended` needs ESPN's own
 * `completed: true`; a `post` without it has NO state we can name (ESPN's text still rides in
 * `periodText`, e.g. "Postponed").
 */
export function espnState(type) {
  const state = ESPN_STATE[type?.state] ?? null
  if (state === 'ended' && type?.completed !== true) return null
  return state
}

/**
 * Play-list period label. ESPN's summary gives a play only a period NUMBER, so 1-4 are labelled Q1-Q4
 * and anything else (overtime — never observed, research R3) is null rather than a guess.
 */
export function footballPeriodLabel(n) {
  return Number.isInteger(n) && n >= 1 && n <= 4 ? `Q${n}` : null
}

/**
 * ESPN's own period text for a game row, from `status.type.shortDetail`: "9:44 - 3rd" -> "3rd",
 * "Final" -> "Final". Nothing is mapped or invented: a pre-game shortDetail is a date string and
 * is not a period, so it is null; an unrecognised shape is forwarded whole as ESPN's text.
 */
export function espnPeriodText(state, shortDetail) {
  if (state === 'pre') return null
  const t = text(shortDetail, 40)
  if (!t) return null
  const m = /^\S+ - (.+)$/.exec(t)
  return m ? m[1] : t
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
    const state = espnState(comp.status?.type)
    // A scheduled game has no score and no clock: ESPN prints "0" and "0:00" there, which are filler, not figures.
    const scheduled = state === 'scheduled'
    if (scheduled) {
      home.score = null
      away.score = null
    }
    out.push({
      id,
      startMs,
      state,
      period: periodN != null && periodN > 0 ? periodN : null,
      periodText: espnPeriodText(comp.status?.type?.state, comp.status?.type?.shortDetail),
      clock: scheduled ? null : text(comp.status?.displayClock, 20),
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
  const state = espnState(header?.status?.type)
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
  source: null,
  status: null,
  score: null,
  scoreText: null,
  period: null,
  clock: null,
  possession: null,
  confirmedAt: null,
  changedAt: null,
  agree: null,
  venue: null,
})

const playScoreOf = (e) => (e.home.score != null && e.away.score != null ? { home: e.home.score, away: e.away.score } : null)

/**
 * One row from what each source said. `venue` is `{frame, changedAt, confirmedAt}` (the feed's read),
 * `play` is `{event, at, league}` (the plays source's scoreboard event and when it was read) — either may be null.
 *
 * WHOSE FIGURES (spec 115 amended FR-008, research R1): the venue's feed is a minute-tick sample that
 * ran a median 34 s (max 203 s) behind ESPN and never ahead, so where the play source was read AND matched
 * the row is the play source's (status incl. ended, score, period text, clock, possession); the venue's own
 * figures ride beside it in `venue`, and `agree` compares the scores. Otherwise the row is the venue's, and
 * otherwise it is all null with `source: null`. Figures from two moments are never mixed in one row.
 */
export function buildRow(gameId, venue, play) {
  const f = venue?.frame ?? null
  const venueView = f
    ? { status: f.status, score: f.score, scoreText: f.scoreText, period: f.period, clock: f.clock, changedAt: venue.changedAt }
    : null
  if (play?.event) {
    const e = play.event
    const score = playScoreOf(e)
    return {
      gameId,
      league: play.league ?? f?.league ?? null,
      source: 'plays',
      status: e.state,
      score,
      scoreText: null,
      period: e.periodText,
      clock: e.clock,
      possession: e.situation?.possession ?? null,
      confirmedAt: play.at,
      changedAt: null,
      agree: f?.score && score ? sameScore(f.score, score) : null,
      venue: venueView,
    }
  }
  if (f) {
    return {
      gameId,
      league: f.league,
      source: 'venue',
      status: f.status,
      score: f.score,
      scoreText: f.scoreText,
      period: f.period,
      clock: f.clock,
      possession: f.possession,
      confirmedAt: venue.confirmedAt,
      changedAt: venue.changedAt,
      agree: null,
      venue: null,
    }
  }
  return emptyRow(gameId)
}
