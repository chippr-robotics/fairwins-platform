/**
 * Fighter-name matching (spec 115 slice 3). Three sources spell the same person three ways
 * ("José Luiz", "Jose Luiz"; "Tre'ston Vines", "Tre'Ston Vines"; "Levi Rodrigues Jr." vs
 * "Levi Rodrigues Jr"), so a name is compared in a NORMALISED form: Unicode NFD with the combining
 * marks removed, lower case, every run of non-letters/digits collapsed to one space.
 *
 * Normalising is for COMPARING only — the text shown to a member is always a source's own text.
 * A fight matches only when BOTH fighters' normalised names are equal (either order: the venue's
 * home/away is not a corner); exactly one fight, or the caller answers `not-matched`. There is no
 * fuzzy step and no "nearest": a wrong fight's result beside a member's market is worse than none.
 */
export function normName(v) {
  if (typeof v !== 'string') return null
  const n = v
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return n === '' ? null : n
}

/** An unordered pair key from two names, or null when either is not a usable name. */
export function pairKey(a, b) {
  const x = normName(a)
  const y = normName(b)
  if (!x || !y || x === y) return null
  return x < y ? `${x}|${y}` : `${y}|${x}`
}
