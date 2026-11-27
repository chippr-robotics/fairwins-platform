/**
 * Fight feed seam (spec 115 slice 3) — `GET /v1/sports/fights/:gameId`, the fight view's one gateway read.
 *
 * Same machinery as the game feed (sportsRead.js: shared in-flight reads, three outcomes ok / absent / failed,
 * a missing module remembered until reload) with its OWN reader: the fight route being off
 * (`sports_fight_unconfigured`, FR-020) is remembered here and nowhere else, so it cannot stop the game view
 * asking — and a game module that is off or paused is not remembered by the game feed on this feed's behalf.
 *
 * The claim from the listing is `a` and `b` (both fighter names or neither) and `start` (optional, bounded by
 * the gateway to [now − 45 d, now + 30 d]): validated here against the contract's rule before sending, else NONE
 * is sent — a malformed claim would 400 the whole read.
 */
import { createSportsReader } from './sportsRead'
import { sidesOf, teamLabel } from './describe'

export const POLL_MS = 5_000
export const SLOW_POLL_MS = 30_000

const NAME_RE = /^[\p{L}\p{M} .'’-]{2,60}$/u
const DAY = 86_400_000

/** The cadence for the next read, or null to stop. Ended is final; before the start (or cancelled/unknown) is slow. */
export function fightCadenceMs(status) {
  if (status === 'ended') return null
  if (status === 'scheduled' || status === 'cancelled' || status == null) return SLOW_POLL_MS
  return POLL_MS
}

/** The listing's two fighters in the listing's order: `teams`, or the venue's stated home/away. */
export function listingFighters(game) {
  const s = sidesOf(game)
  if (s.kind === 'teams') return [teamLabel(s.teams[0]), teamLabel(s.teams[1])]
  if (s.kind === 'homeAway') return [teamLabel(s.home), teamLabel(s.away)]
  return [null, null]
}

/** `{ a, b [, start] }` or `{}`. `now` is injectable; it only bounds a request parameter, it never ages a reading. */
export function fightIdentityOf(game, now = Date.now()) {
  const [a, b] = listingFighters(game)
  if (!a || !b || !NAME_RE.test(a) || !NAME_RE.test(b)) return {}
  const t = typeof game?.startTime === 'string' ? Date.parse(game.startTime) : NaN
  // Inside the gateway's window, with a day of margin each side so a clock a little off cannot make it a 400.
  const start = Number.isFinite(t) && t >= now - 44 * DAY && t <= now + 29 * DAY ? game.startTime : null
  return start ? { a, b, start } : { a, b }
}

const reader = createSportsReader({ rememberCodes: ['sports_fight_unconfigured', 'sports_unconfigured'] })

export const __resetFightFeedForTests = () => reader.reset()

export function fetchFight(gameId, { identity = {}, fetchImpl } = {}) {
  if (gameId == null || gameId === '') return Promise.resolve({ kind: 'absent' })
  const qs = new URLSearchParams(identity).toString()
  return reader.read(`/v1/sports/fights/${encodeURIComponent(String(gameId))}${qs ? `?${qs}` : ''}`, {
    fetchImpl,
    parse: (body) => {
      const fight = body?.fight
      if (!fight || typeof fight !== 'object' || String(fight.gameId) !== String(gameId) || !Number.isFinite(body.serverNow ?? NaN)) return null
      return { fight, serverNow: body.serverNow, sources: body.sources ?? null }
    },
  })
}
