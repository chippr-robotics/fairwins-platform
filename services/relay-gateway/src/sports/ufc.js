/**
 * UFC's own live JSON (spec 115 slice 3, source `figures`): the event card (fights, fighters, results)
 * and per-fight round figures. Public, keyless, on NO service agreement; there is NO index of events.
 *
 * EVENT DISCOVERY WITHOUT AN INDEX (research R4). Event ids are near date order but not strictly (1345 =
 * 2026-11-14, 1340 = 2026-09-15, 1349 = 2026-12-12 while 1348 = 2026-11-21), and an id that does not
 * exist answers `200 {"LiveEventDetail":{}}`, not a 404. So the module probes upward from a configured
 * ANCHOR id and stops after `probeMax` consecutive empty answers past the last card it found:
 *   - cold cost: (highest − anchor + 1) + probeMax requests, once, shared by everyone;
 *   - refresh (every `discoveryTtlMs`, default 6 h, and only when somebody is asking about a fight):
 *     probeMax requests past the highest known id, plus one per new card;
 *   - a FINAL card is immutable and never re-read; a card that is not final is re-read only when a
 *     viewer needs it, no more often than its TTL;
 *   - single-flight everywhere, failures cached briefly, every fetch deadline-bounded.
 * None of that grows with the number of members, and nothing is polled for a fight nobody is viewing.
 * A stale anchor is only a cost (more ids probed); an anchor ABOVE a card makes that card unreachable
 * ("not-matched"), so it is an operator setting with a default that sits below every card in use.
 */
import { stripTrailingSlashes } from '../strings.js'
import { intOrNull } from './normalize.js'
import { normName } from './fightNames.js'

const FAILURE_TTL_MS = 30_000
const MAX_FINAL_EVENTS = 400
const MAX_FIGHTS = 600

export class UfcUpstreamError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'UfcUpstreamError'
    this.cause = cause
  }
}

const text = (v, max = 60) => {
  if (typeof v !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001F\u007F]/g, '').trim()
  return t === '' ? null : Array.from(t).slice(0, max).join('')
}
const fullName = (n) => text([n?.FirstName, n?.LastName].filter((x) => typeof x === 'string' && x.trim() !== '').join(' '))

/** Our fixed list of figure KEYS and the source field each is read from (FR-018). Nothing else is forwarded. */
export const FIGURE_KEYS = Object.freeze({
  knockdowns: 'Knockdowns',
  sigStrikesLanded: 'SigStrikesLanded',
  sigStrikesAttempted: 'SigStrikesAttempted',
  totalStrikesLanded: 'TotalStrikesLanded',
  totalStrikesAttempted: 'TotalStrikesAttempted',
  headStrikesLanded: 'SigHeadStrikesLanded',
  headStrikesAttempted: 'SigHeadStrikesAttempted',
  bodyStrikesLanded: 'SigBodyStrikesLanded',
  bodyStrikesAttempted: 'SigBodyStrikesAttempted',
  legStrikesLanded: 'SigLegStrikesLanded',
  legStrikesAttempted: 'SigLegStrikesAttempted',
  takedownsLanded: 'TakedownsLanded',
  takedownsAttempted: 'TakedownsAttempted',
  reversals: 'Reversals',
  submissionsAttempted: 'SubmissionsAttempted',
})
export const FIGURE_NAMES = Object.freeze([...Object.keys(FIGURE_KEYS), 'controlSeconds'])

/** `m:ss` -> whole seconds, null for anything else (a unit change of a figure the source gave, not a derivation). */
const mmss = (v) => {
  const m = typeof v === 'string' ? /^(\d{1,3}):([0-5]\d)$/.exec(v) : null
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** One fighter's source stats object -> our figure object. EVERY key is present; absent/blank/odd is null, never 0. */
export function figureRow(src) {
  const out = {}
  for (const [ours, theirs] of Object.entries(FIGURE_KEYS)) out[ours] = intOrNull(src?.[theirs], 9999)
  out.controlSeconds = mmss(src?.ControlTime)
  return out
}
export const emptyFigureRow = () => figureRow(null)

const OUTCOMES = { Win: 'win', Loss: 'loss', Draw: 'draw', 'No Contest': 'no-contest' }

/** One FightCard entry -> `{id, status, names, fighterIds, outcome, winner, weightClass, scheduledRounds, result}`. */
export function parseUfcFight(f) {
  const fighters = Array.isArray(f?.Fighters) ? f.Fighters.slice(0, 2) : []
  const id = intOrNull(f?.FightId, Number.MAX_SAFE_INTEGER)
  if (id == null || fighters.length !== 2) return null
  const names = fighters.map((x) => fullName(x?.Name))
  if (names.some((n) => !normName(n))) return null
  const fighterIds = fighters.map((x) => (Number.isSafeInteger(x?.FighterId) ? x.FighterId : null))
  const oc = fighters.map((x) => OUTCOMES[x?.Outcome?.Outcome] ?? null)
  let outcome = null
  let winner = null
  if (oc[0] === 'win' && oc[1] === 'loss') [outcome, winner] = ['win', 0]
  else if (oc[0] === 'loss' && oc[1] === 'win') [outcome, winner] = ['win', 1]
  else if (oc[0] === 'draw' && oc[1] === 'draw') outcome = 'draw'
  else if (oc[0] === 'no-contest' && oc[1] === 'no-contest') outcome = 'no-contest'
  const r = f?.Result
  const judges = []
  for (const j of Array.isArray(r?.FightScores) ? r.FightScores.slice(0, 5) : []) {
    const byId = new Map((Array.isArray(j?.Fighters) ? j.Fighters : []).map((s) => [s?.FighterId, s?.Score]))
    const scores = fighterIds.map((fid) => (fid == null ? null : intOrNull(byId.get(fid), 60)))
    const name = text([j?.JudgeFirstName, j?.JudgeLastName].filter((x) => typeof x === 'string' && x.trim() !== '').join(' '))
    if (scores.some((s) => s != null)) judges.push({ name, scores })
  }
  const result = r && typeof r === 'object' ? { method: text(r.Method, 40), endingRound: intOrNull(r.EndingRound, 12), endingTime: mmss(r.EndingTime) != null ? r.EndingTime : null, judges } : null
  return {
    id,
    status: text(f?.Status, 20),
    names,
    fighterIds,
    outcome,
    winner,
    weightClass: text(f?.WeightClass?.Description, 40),
    scheduledRounds: intOrNull(f?.RuleSet?.PossibleRounds, 12),
    result: result && (result.method || result.endingRound != null || result.judges.length > 0) ? result : null,
  }
}

/** An event body -> `{id, name, startMs, status, live: {fightId, round, elapsed}, fights}`, or null for the empty answer. */
export function parseUfcEvent(body) {
  const e = body?.LiveEventDetail
  const id = intOrNull(e?.EventId, Number.MAX_SAFE_INTEGER)
  const startMs = typeof e?.StartTime === 'string' && Number.isFinite(Date.parse(e.StartTime)) ? Date.parse(e.StartTime) : null
  if (id == null || startMs == null || !Array.isArray(e.FightCard)) return null
  return {
    id,
    name: text(e.Name, 80),
    startMs,
    status: text(e.Status, 20),
    // The three LIVE fields have only ever been seen null, on finished and upcoming cards (research R3).
    live: { fightId: intOrNull(e.LiveFightId, Number.MAX_SAFE_INTEGER), round: intOrNull(e.LiveRoundNumber, 12), elapsed: mmss(e.LiveRoundElapsedTime) != null ? e.LiveRoundElapsedTime : null },
    fights: e.FightCard.map(parseUfcFight).filter(Boolean).slice(0, 40),
  }
}

/**
 * A fight body -> `{official, rounds: [{round, figures: [a, b]}], overall: [a, b] | null}` with the two
 * fighters in the order of `fighterIds` (so the caller's identity order is respected). Only rounds the
 * source reported appear; no total is ever computed here.
 */
export function parseUfcFigures(body, fighterIds) {
  const d = body?.LiveFightDetail
  if (!d || typeof d !== 'object') return null
  const idx = (fid) => fighterIds.indexOf(fid)
  const byFighter = new Map()
  for (const fr of Array.isArray(d.RoundStats) ? d.RoundStats : []) {
    const i = idx(fr?.FighterId)
    if (i < 0) continue
    for (const r of Array.isArray(fr?.Rounds) ? fr.Rounds : []) {
      const n = intOrNull(r?.RoundNumber, 12)
      if (n == null || n < 1) continue
      if (!byFighter.has(n)) byFighter.set(n, [null, null])
      byFighter.get(n)[i] = figureRow(r)
    }
  }
  const rounds = [...byFighter.entries()].sort((a, b) => a[0] - b[0]).map(([round, f]) => ({ round, figures: [f[0] ?? emptyFigureRow(), f[1] ?? emptyFigureRow()] }))
  let overall = null
  const fs = Array.isArray(d.FightStats) ? d.FightStats : []
  if (fs.length > 0) {
    overall = [null, null]
    for (const s of fs) {
      const i = idx(s?.FighterId)
      if (i >= 0) overall[i] = figureRow(s)
    }
    overall = overall.map((o) => o ?? emptyFigureRow())
  }
  return { official: d.OfficialStats === true, final: d.Status === 'Final', rounds, overall }
}

/**
 * @param {{
 *   baseUrl: string, anchorId: number, probeMax?: number, discoveryTtlMs?: number, liveEventTtlMs?: number,
 *   restEventTtlMs?: number, figuresTtlMs?: number, timeoutMs?: number, fetchImpl?: typeof fetch, now?: () => number,
 * }} opts
 */
export function createUfc({
  baseUrl,
  anchorId,
  probeMax = 6,
  discoveryTtlMs = 6 * 3_600_000,
  liveEventTtlMs = 15_000,
  restEventTtlMs = 600_000,
  figuresTtlMs = 15_000,
  timeoutMs = 6000,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const base = stripTrailingSlashes(baseUrl)
  let upstreamCalls = 0
  /** @type {Map<number, {event: object, at: number}>} */
  const events = new Map()
  /** @type {Map<number, object>} immutable: a Final event / an official Final fight, keyed by UFC's own ids */
  const finalEvents = new Map()
  const finalFights = new Map()
  const fightCache = new Map()
  let highest = null // highest event id that answered with a card
  let discovery = { at: 0, result: null, inflight: null }
  const eventInflight = new Map()

  async function getJson(url) {
    upstreamCalls += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal })
      if (!res.ok) throw new UfcUpstreamError(`ufc returned ${res.status}`)
      return await res.json()
    } catch (e) {
      throw e instanceof UfcUpstreamError ? e : new UfcUpstreamError('ufc unreachable', e)
    } finally {
      clearTimeout(timer)
    }
  }
  const reasonOf = (e) => (e instanceof UfcUpstreamError && /returned/.test(e.message) ? 'upstream_error' : 'upstream_unreachable')

  /** Read one event id; `null` for the empty answer. Final events are immutable and kept. */
  async function readEvent(id, { force = false } = {}) {
    const fin = finalEvents.get(id)
    if (fin) return fin
    const slot = events.get(id)
    if (slot && !force) {
      const ttl = slot.event.status === 'Live' || slot.event.live.fightId != null ? liveEventTtlMs : restEventTtlMs
      if (now() - slot.at < ttl) return slot.event
    }
    if (eventInflight.has(id)) return eventInflight.get(id)
    const p = (async () => {
      try {
        const ev = parseUfcEvent(await getJson(`${base}/event/live/${id}.json`))
        if (!ev) return null
        ev.readAt = now() // when the source last said this — a Final card keeps its OWN read time, honestly old
        events.set(id, { event: ev, at: ev.readAt })
        if (ev.status === 'Final') {
          finalEvents.set(id, ev)
          events.delete(id)
          while (finalEvents.size > MAX_FINAL_EVENTS) finalEvents.delete(finalEvents.keys().next().value)
        }
        return ev
      } finally {
        eventInflight.delete(id)
      }
    })()
    eventInflight.set(id, p)
    return p
  }

  /** The discovery walk. Throws on a fetch failure (the caller caches the failure briefly). */
  async function walk() {
    let id = highest != null ? highest + 1 : anchorId
    let misses = 0
    while (misses < probeMax) {
      const ev = await readEvent(id)
      if (ev) {
        highest = Math.max(highest ?? id, id)
        misses = 0
      } else misses += 1
      id += 1
    }
  }

  return {
    /** `{state:'read', fetchedAt}` once discovery has run inside its TTL; failures are cached for 30 s. */
    async discover() {
      const d = discovery
      if (d.result && now() - d.at < (d.result.state === 'read' ? discoveryTtlMs : FAILURE_TTL_MS)) return d.result
      if (d.inflight) return d.inflight
      d.inflight = (async () => {
        let result
        try {
          await walk()
          result = { state: 'read', fetchedAt: now() }
        } catch (e) {
          result = { state: 'unreadable', reason: reasonOf(e), fetchedAt: now() }
        }
        d.at = now()
        d.result = result
        d.inflight = null
        return result
      })()
      return d.inflight
    },

    /** Known events (headers + fights) whose start is within `windowMs` of `centerMs`, or Live. */
    candidates(centerMs, windowMs) {
      const all = [...finalEvents.values(), ...[...events.values()].map((s) => s.event)]
      return all.filter((e) => e.status === 'Live' || Math.abs(e.startMs - centerMs) <= windowMs)
    },

    /** Re-read a non-final candidate if its TTL has lapsed (the Live card, or an upcoming one being viewed). */
    async refresh(id) {
      try {
        const ev = await readEvent(id)
        return ev ? { state: 'read', event: ev } : { state: 'unreadable', reason: 'upstream_error' }
      } catch (e) {
        return { state: 'unreadable', reason: reasonOf(e) }
      }
    },

    /** One fight's round figures. An official Final fight is read once and kept forever (keyed by UFC's own id). */
    async figures(fightId, fighterIds) {
      const fin = finalFights.get(fightId)
      if (fin) return { state: 'read', fetchedAt: fin.at, value: fin.value }
      const slot = fightCache.get(fightId)
      if (slot?.result && now() - slot.at < (slot.result.state === 'read' ? figuresTtlMs : FAILURE_TTL_MS)) return slot.result
      if (slot?.inflight) return slot.inflight
      const entry = slot ?? { at: 0, result: null, inflight: null }
      entry.inflight = (async () => {
        let result
        try {
          const value = parseUfcFigures(await getJson(`${base}/fight/live/${fightId}.json`), fighterIds)
          result = value ? { state: 'read', fetchedAt: now(), value } : { state: 'unreadable', reason: 'upstream_error', fetchedAt: now() }
          if (value?.official && value.final) {
            finalFights.set(fightId, { at: now(), value })
            while (finalFights.size > MAX_FIGHTS) finalFights.delete(finalFights.keys().next().value)
            fightCache.delete(fightId)
          }
        } catch (e) {
          result = { state: 'unreadable', reason: reasonOf(e), fetchedAt: now() }
        }
        entry.at = now()
        entry.result = result
        entry.inflight = null
        return result
      })()
      fightCache.set(fightId, entry)
      while (fightCache.size > MAX_FIGHTS) fightCache.delete(fightCache.keys().next().value)
      return entry.inflight
    },

    stats() {
      return { upstreamCalls, highest, finalEvents: finalEvents.size, liveEvents: events.size, finalFights: finalFights.size }
    },
  }
}
