/**
 * The leagues this module has VERIFIED against both sources (spec 115, research R1/R2).
 *
 * A league absent here is not a failure: it has no play source (`not-covered`) and its venue score
 * is carried as the venue's own text, because which side of "a-b" is home is a fact about the
 * league's feed, not something to infer from another league.
 *
 * `scoreOrder` — which side the FIRST number of the venue's `score` belongs to, measured against
 *   ESPN at the same moment (research R1). NFL is "away-home": PHI @ DAL read `10-28` while ESPN
 *   said PHI 10, DAL 28.
 * `aliases` — venue team code -> ESPN team code, ONLY where they differ. Built from observation
 *   (research R2): the venue's 32 NFL codes against ESPN's 32, 30 identical, 2 different. A code
 *   missing from an alias table is assumed identical; if that is wrong the match is simply not
 *   exactly one game and the row says `not-matched` — never a guess.
 */
export const LEAGUES = Object.freeze({
  nfl: Object.freeze({
    espnPath: 'football/nfl',
    scoreOrder: 'away-home',
    plays: true,
    aliases: Object.freeze({ WAS: 'WSH', LA: 'LAR' }),
  }),
})

export const leagueConfig = (league) => (typeof league === 'string' && Object.hasOwn(LEAGUES, league) ? LEAGUES[league] : null)
