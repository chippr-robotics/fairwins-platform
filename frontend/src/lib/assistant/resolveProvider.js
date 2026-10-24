/**
 * Which rail answers this account right now, and why (spec 104).
 *
 * Three facts decide it — the member's preference (`assistantPrefs.provider`), whether a GutterToken
 * key is saved on this device, and the membership read — and the answer is always a REASON as well
 * as a rail, because the panel renders the reason: "sign to start" is the wrong sentence for a
 * member who chose GutterToken and has no key, and "become a member" is the wrong one for a member
 * whose membership simply has not been read yet.
 *
 * THE CHOICE IS RESPECTED. A member who selected GutterToken and then removed the key is told they
 * have no key — they are NOT silently moved back to the membership rail, which would send their next
 * message to a different processor than the one they last agreed to. Falling the other way IS
 * allowed: a non-member on the default preference with a key present gets GutterToken, because
 * GutterToken is the only rail a non-member has, and their key is their consent.
 *
 * THE MEMBERSHIP READ IS THREE-STATE, and two of the states are not answers. `null` is pending and
 * `{ readable: false }` is unreadable; both resolve to no provider with the honest reason. An RPC
 * failure is not evidence about a member's tier and must never read as "not a member".
 *
 * `canChoose` is whether the radio in Settings should be live: only a paid member WITH a key has two
 * rails to pick between. Everyone else has at most one, and a disabled radio with a reason says so.
 */
import { loadAssistantPrefs } from './assistantPrefs'
import { hasGutterTokenKey } from './guttertokenKeyStore'

/**
 * @param {{account: string|null|undefined, membership: null|{readable?: boolean, isActive?: boolean}}} args
 *   `membership` is the `useRoleDetails` shape: `null` while pending, `readable: false` when the
 *   reference chain would not answer, else `isActive` says whether the tier is live.
 * @returns {{provider: 'fairwins'|'guttertoken'|null, reason: 'member'|'key'|'no-key'|'not-member'|'pending'|'unreadable'|'disabled', canChoose: boolean}}
 */
export function resolveProvider({ account, membership }) {
  const prefs = loadAssistantPrefs(account)
  if (prefs.enabled !== true) return { provider: null, reason: 'disabled', canChoose: false }

  const keyPresent = hasGutterTokenKey(account) === true
  const pending = membership == null
  const unreadable = !pending && membership.readable === false
  const memberActive = !pending && !unreadable && membership.isActive === true
  const canChoose = memberActive && keyPresent

  if (prefs.provider === 'guttertoken') {
    return keyPresent
      ? { provider: 'guttertoken', reason: 'key', canChoose }
      : { provider: null, reason: 'no-key', canChoose }
  }

  // Default rail: the membership.
  if (memberActive) return { provider: 'fairwins', reason: 'member', canChoose }
  if (pending) return { provider: null, reason: 'pending', canChoose }
  if (unreadable) return { provider: null, reason: 'unreadable', canChoose }
  // Read, and not active: the key is the only rail left.
  return keyPresent
    ? { provider: 'guttertoken', reason: 'key', canChoose }
    : { provider: null, reason: 'not-member', canChoose }
}

export default resolveProvider
