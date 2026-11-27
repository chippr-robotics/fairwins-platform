/**
 * The fight read seam (spec 115 slice 3, FR-017..FR-020). Three sources, each failing ALONE and named:
 *   `venue`   — the venue's feed: identity (both fighters) and its own result text;
 *   `card`    — ESPN's MMA scoreboard: status, round, clock, scheduled rounds, weight class, winner flag;
 *   `figures` — UFC's own JSON: per-round figures, method, ending round/time, judges, the official outcome.
 *
 * WHO LEADS status/round/clock (research R3): ESPN, where it was read and matched. On five completed cards
 * (64 fights) ESPN and UFC agreed on every ending round, ending clock and winner, so completed data cannot
 * separate them; ESPN leads on structure — one cached read answers the whole card, it states `completed`
 * explicitly, and it is the same transport that was measured on football. UFC's own record leads the RESULT
 * and the FIGURES (method, judges and draw / no contest exist nowhere else; ESPN marks a draw, a no contest
 * and a scheduled fight identically: both competitors `winner: false`). A venue reading is never live and
 * is last in line.
 *
 * Nothing is derived: no total the source did not give, no lead, no score, no "winning". Figures are numbers
 * or null (`intOrNull`) under a FIXED list of keys that is ours (`ufc.js#FIGURE_KEYS`).
 *
 * A CLAIM (two fighter names + a start time from the listing) is request-scoped: used only while the venue
 * has not named the fight, never stored against the gameId. Every map below is keyed by something the
 * sources themselves produced (UFC event/fight ids, ESPN day ranges built from a card's own start time).
 */
import { intOrNull } from './normalize.js'
import { normName, pairKey } from './fightNames.js'
import { SOURCE_LABELS_FIGHT } from './fightLabels.js'

const DAY = 86_400_000
const CARD_WINDOW_MS = 36 * 3_600_000 // a listing's start vs a card's start
const NEAR_NOW_MS = 3 * DAY // no start known: a card that is live or within three days either side

const text = (v, max = 60) => {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001F\u007F]/g, '').trim()
  return t === '' ? null : Array.from(t).slice(0, max).join('')
}

const ESPN_STATE = { pre: 'scheduled', in: 'in-progress', post: 'ended' }

/** ESPN MMA scoreboard body -> competitions (one per fight) with the fields the fight view uses. */
export function parseMmaScoreboard(body) {
  const out = []
  for (const e of Array.isArray(body?.events) ? body.events : []) {
    for (const c of Array.isArray(e?.competitions) ? e.competitions : []) {
      const comps = Array.isArray(c?.competitors) ? c.competitors.slice(0, 2) : []
      if (comps.length !== 2) continue
      const names = comps.map((x) => text(x?.athlete?.displayName ?? x?.athlete?.fullName))
      if (names.some((n) => !normName(n))) continue
      const state = ESPN_STATE[c?.status?.type?.state] ?? null
      const completed = c?.status?.type?.completed === true
      const winners = comps.map((x) => x?.winner === true)
      const period = intOrNull(c?.status?.period, 12)
      const clock = text(c?.status?.displayClock, 12)
      const startMs = [c?.date, c?.startDate].map((d) => (typeof d === 'string' ? Date.parse(d) : NaN)).find((n) => Number.isFinite(n)) ?? null
      out.push({
        id: typeof c?.id === 'string' ? c.id.slice(0, 20) : null,
        startMs,
        names,
        state,
        completed,
        // ESPN prints period 0 and clock "-" for a fight that has not started: those are filler, not a round.
        round: state === 'scheduled' ? null : period != null && period > 0 ? period : null,
        clock: state === 'scheduled' || clock === '-' ? null : clock,
        scheduledRounds: intOrNull(c?.format?.regulation?.periods, 12),
        weightClass: text(c?.type?.abbreviation, 40),
        // Exactly one `winner: true` is a winner. Both false is a draw, a no contest OR a fight not yet fought —
        // ESPN does not say which, so it is NOT read as anything.
        winner: winners[0] !== winners[1] ? (winners[0] ? 0 : 1) : null,
      })
    }
  }
  return out
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '')
/** `YYYYMMDD-YYYYMMDD` covering the day before to the day after `ms` (a card straddles UTC midnight). */
export const espnDateRange = (ms) => `${ymd(ms - DAY)}-${ymd(ms + DAY)}`

/**
 * The venue's own word for a fight, from the parsed frame. `cancelled` exists only as the venue's word
 * (research R3): the parsed status drops "Canceled" to null, so it is read from the period label `CAN`.
 */
function venueFightStatus(f) {
  if (f.period === 'CAN') return 'cancelled'
  return f.status === 'ended' ? 'ended' : f.status === 'in-progress' ? 'in-progress' : null
}

/**
 * @param {{
 *   cardEnabled: boolean, figuresEnabled: boolean,
 *   venue: ReturnType<import('./venueFeed.js').createVenueFeed>,
 *   espn: ReturnType<import('./espn.js').createEspn>, ufc: ReturnType<import('./ufc.js').createUfc>,
 *   now?: () => number,
 * }} deps
 */
export function createFightService({ cardEnabled, figuresEnabled, venue, espn, ufc, now = Date.now }) {
  const labels = SOURCE_LABELS_FIGHT

  /** Re-order a pair of source entries into the identity's order by normalised name; null if either is missing. */
  function alignment(identity, sourceNames) {
    const idx = identity.map((n) => sourceNames.map(normName).indexOf(n))
    return idx[0] >= 0 && idx[1] >= 0 && idx[0] !== idx[1] ? idx : null // idx[i] = position in the source of identity fighter i
  }

  async function fight(gameId, claim = null) {
    venue.touch()
    const venueState = venue.state()
    const v = venue.read(gameId)
    const frame = v?.frame ?? null
    const t = now()

    // WHO IS THIS FIGHT? The venue's own frame when it has spoken; else THIS request's claim; else nobody.
    let identity = null
    let startMs = null
    let from = null
    if (frame) {
      from = 'venue'
      if (frame.league === 'ufc') identity = [normName(frame.homeTeam), normName(frame.awayTeam)]
    } else if (claim) {
      from = 'claim'
      identity = [normName(claim.a), normName(claim.b)]
      startMs = claim.startMs ?? null
    }
    if (identity && (!identity[0] || !identity[1] || identity[0] === identity[1])) identity = null
    const covered = frame ? frame.league === 'ufc' : true
    const key = identity ? pairKey(identity[0], identity[1]) : null

    const sources = { venue: { ...venueState, label: labels.venue }, card: null, figures: null }
    const none = (state, reason) => ({ state, ...(reason ? { reason } : {}) })

    // ---- the figures source (UFC): find the card, then the fight ------------------------------------
    let ufcFight = null
    let ufcEvent = null
    let ufcAt = null
    if (!figuresEnabled) sources.figures = none('off')
    else if (!covered) sources.figures = none('not-covered')
    else if (!identity) sources.figures = none('not-matched', 'no_identity')
    else {
      const d = await ufc.discover()
      if (d.state !== 'read') sources.figures = none('unreadable', d.reason)
      else {
        const pool = ufc.candidates(startMs ?? t, startMs != null ? CARD_WINDOW_MS : NEAR_NOW_MS)
        // A card that is not final is re-read (within its TTL) so a viewer sees its current state.
        const fresh = []
        for (const e of pool) {
          if (e.status === 'Final') fresh.push(e)
          else {
            const r = await ufc.refresh(e.id)
            fresh.push(r.state === 'read' ? r.event : e)
          }
        }
        const hits = fresh.flatMap((e) => e.fights.filter((f) => pairKey(f.names[0], f.names[1]) === key).map((f) => ({ e, f })))
        if (hits.length !== 1) sources.figures = none('not-matched', hits.length === 0 ? 'no_candidate' : 'ambiguous')
        else {
          ufcFight = hits[0].f
          ufcEvent = hits[0].e
          ufcAt = ufcEvent.readAt ?? null
          sources.figures = none('read')
        }
      }
    }

    // ---- the card source (ESPN) ----------------------------------------------------------------------
    let espnFight = null
    let espnAt = null
    if (!cardEnabled) sources.card = none('off')
    else if (!covered) sources.card = none('not-covered')
    else if (!identity) sources.card = none('not-matched', 'no_identity')
    else {
      // The date comes from the UFC card's own start when it was found, else the claim's, else today — never raw request text.
      const center = ufcEvent?.startMs ?? startMs ?? t
      const board = await espn.scoreboard('mma/ufc', { dates: espnDateRange(center) })
      if (board.state !== 'read') sources.card = none('unreadable', board.reason)
      else {
        const hits = board.value.filter((c) => pairKey(c.names[0], c.names[1]) === key && (startMs == null || c.startMs == null || Math.abs(c.startMs - startMs) <= CARD_WINDOW_MS))
        if (hits.length !== 1) sources.card = none('not-matched', hits.length === 0 ? 'no_candidate' : 'ambiguous')
        else {
          espnFight = hits[0]
          espnAt = board.fetchedAt
          sources.card = none('read')
        }
      }
    }
    sources.card = { ...sources.card, label: labels.card }
    sources.figures = { ...sources.figures, label: labels.figures }

    // ---- per-fighter figures (only when the card says the fight has begun or ended) ------------------
    let figures = null
    if (ufcFight && ufcFight.status !== 'Upcoming' && ufcFight.status != null) {
      const f = await ufc.figures(ufcFight.id, ufcFight.fighterIds)
      if (f.state !== 'read') sources.figures = { state: 'unreadable', reason: f.reason, label: labels.figures }
      else figures = { value: f.value, at: f.fetchedAt }
    }
    const figuresOK = sources.figures.state === 'read'

    // ---- assemble ------------------------------------------------------------------------------------
    const ufcAlign = ufcFight && figuresOK ? alignment(identity, ufcFight.names) : null
    const espnAlign = espnFight ? alignment(identity, espnFight.names) : null
    const pick = (pair, al) => (al ? [pair[al[0]], pair[al[1]]] : null)

    // fighters: the source's own text, in the identity's order. A claim is never echoed back.
    let fighters = [{ name: null }, { name: null }]
    if (frame && covered && identity) fighters = [{ name: text(frame.homeTeam) }, { name: text(frame.awayTeam) }]
    else if (espnFight && espnAlign) fighters = pick(espnFight.names, espnAlign).map((name) => ({ name }))
    else if (ufcFight && ufcAlign) fighters = pick(ufcFight.names, ufcAlign).map((name) => ({ name }))

    const cardLeads = Boolean(espnFight && espnAlign)
    const figuresLead = !cardLeads && Boolean(ufcFight && ufcAlign && (ufcFight.status === 'Final' || ufcFight.status === 'Upcoming'))
    let source = null
    let status = null
    let round = null
    let clock = null
    let confirmedAt = null
    let changedAt = null
    if (cardLeads) {
      source = 'card'
      // `post` without `completed` is not "ended": ESPN files other terminal states under post (spec 115 amendment).
      status = espnFight.state === 'ended' && !espnFight.completed ? null : espnFight.state
      round = espnFight.round
      clock = espnFight.clock
      confirmedAt = espnAt
    } else if (figuresLead) {
      source = 'figures'
      status = ufcFight.status === 'Final' ? 'ended' : 'scheduled'
      round = status === 'ended' ? (ufcFight.result?.endingRound ?? null) : null
      clock = status === 'ended' ? (ufcFight.result?.endingTime ?? null) : null
      confirmedAt = ufcAt
    } else if (frame && covered) {
      source = 'venue'
      status = venueFightStatus(frame)
      clock = text(frame.clock, 20)
      confirmedAt = v.confirmedAt
      changedAt = v.changedAt
    }

    const venueView = frame && covered && source !== 'venue' ? { status: venueFightStatus(frame), scoreText: frame.scoreText, clock: text(frame.clock, 20), changedAt: v.changedAt } : null

    // result: UFC's official record leads; then ESPN's single winner flag; then the venue's own words.
    let result = null
    const finished = status === 'ended' || status === 'cancelled'
    if (finished || (ufcFight && ufcFight.status === 'Final' && figuresOK)) {
      if (ufcFight && ufcAlign && ufcFight.status === 'Final') {
        const r = ufcFight.result
        const winner = ufcFight.winner == null ? null : ufcAlign.indexOf(ufcFight.winner)
        result = {
          source: 'figures',
          outcome: ufcFight.outcome,
          winner: winner != null && winner >= 0 ? winner : null,
          method: r?.method ?? null,
          endingRound: r?.endingRound ?? null,
          endingTime: r?.endingTime ?? null,
          judges: (r?.judges ?? []).map((j) => ({ name: j.name, scores: [j.scores[ufcAlign[0]], j.scores[ufcAlign[1]]] })),
        }
      } else if (espnFight && espnAlign && status === 'ended' && espnFight.winner != null) {
        result = { source: 'card', outcome: 'win', winner: espnAlign.indexOf(espnFight.winner), method: null, endingRound: null, endingTime: null, judges: [] }
      } else if (frame && covered && venueFightStatus(frame) === 'cancelled') {
        result = { source: 'venue', outcome: 'cancelled', winner: null, method: null, endingRound: null, endingTime: null, judges: [] }
      }
    }

    const fightObj = {
      gameId,
      source,
      status,
      scheduledRounds: espnFight?.scheduledRounds ?? ufcFight?.scheduledRounds ?? null,
      weightClass: espnFight?.weightClass ?? ufcFight?.weightClass ?? null,
      round,
      clock,
      confirmedAt,
      changedAt,
      fighters,
      result,
      venue: venueView,
      rounds: null,
      overall: null,
    }
    if (figures && ufcAlign) {
      const o = (pair) => [pair[ufcAlign[0]], pair[ufcAlign[1]]]
      fightObj.rounds = figures.value.rounds.map((r) => ({ round: r.round, figures: o(r.figures) }))
      fightObj.overall = figures.value.overall ? o(figures.value.overall) : null
    }
    return { serverNow: t, sources, fight: fightObj }
  }

  return { fight, status: () => ({ ufc: ufc.stats() }) }
}
