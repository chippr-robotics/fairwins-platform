/**
 * Stale-build support floor (spec 102, FR-015).
 *
 * Web members always run the latest deploy; native members run whatever build
 * they installed. Before a degraded behavior gets blamed on anything else, a
 * build older than the supported floor must SAY so, with the update path
 * named.
 *
 * The floor is published by the tenant origin as a small static document —
 * `/.well-known/fairwins-native-support.json`:
 *   { "minimumVersion": "1.14.0", "updateUrl": "https://…" }
 * Its ABSENCE (404, offline, malformed) resolves `unknown`, which renders
 * NOTHING: no floor published means no claim to make, and an unreachable
 * origin must never manufacture a "please update" banner (constitution III —
 * that would render a network failure as a fact about the member's build).
 */
import { APP_VERSION } from '../../config/buildInfo'

export const SUPPORT_FLOOR_PATH = '/.well-known/fairwins-native-support.json'

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/

export function parseSemver(value) {
  const match = SEMVER_RE.exec(String(value ?? '').trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** negative: a < b · zero: equal · positive: a > b. Null for unparseable input. */
export function compareVersions(a, b) {
  const va = parseSemver(a)
  const vb = parseSemver(b)
  if (!va || !vb) return null
  return (va.major - vb.major) || (va.minor - vb.minor) || (va.patch - vb.patch)
}

/**
 * @returns {{ state: 'supported' } |
 *           { state: 'below-floor', current: string, floor: string, updateUrl?: string } |
 *           { state: 'unknown' }}
 */
export function evaluateSupportFloor({ current = APP_VERSION, floor, updateUrl } = {}) {
  const comparison = compareVersions(current, floor)
  if (comparison === null) return { state: 'unknown' }
  if (comparison < 0) {
    return { state: 'below-floor', current, floor: parseSemverString(floor), updateUrl }
  }
  return { state: 'supported' }
}

function parseSemverString(value) {
  const v = parseSemver(value)
  return `${v.major}.${v.minor}.${v.patch}`
}

/**
 * Fetch the published floor and evaluate this build against it. Every failure
 * mode — offline, 404, malformed JSON, missing field — is `unknown`.
 */
export async function checkSupportFloor({
  origin,
  current = APP_VERSION,
  fetchImpl = typeof fetch !== 'undefined' ? fetch : undefined,
} = {}) {
  if (!origin || !fetchImpl) return { state: 'unknown' }
  try {
    const response = await fetchImpl(`${origin.replace(/\/$/, '')}${SUPPORT_FLOOR_PATH}`)
    if (!response.ok) return { state: 'unknown' }
    const doc = await response.json()
    if (!doc || typeof doc.minimumVersion !== 'string') return { state: 'unknown' }
    return evaluateSupportFloor({
      current,
      floor: doc.minimumVersion,
      updateUrl: typeof doc.updateUrl === 'string' ? doc.updateUrl : undefined,
    })
  } catch {
    return { state: 'unknown' }
  }
}
