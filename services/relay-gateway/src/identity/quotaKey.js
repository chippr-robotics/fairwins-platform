/**
 * The metering key (spec 106, FR-011) — ONE helper, so every module keys the same way.
 *
 * ── THE DEFECT THIS REPAIRS ──────────────────────────────────────────────────────────────────
 *
 * The collectibles and prediction-market proxies keyed their quotas on values taken from the
 * REQUEST ITSELF:
 *
 *   guard(address.toLowerCase())   // /v1/opensea/:chainId/account/:address/nfts
 *   guard(slug)                    // /v1/opensea/collections/:slug/stats
 *   guard(`markets:${search}:${offset}`)
 *
 * Every one of those is chosen by the caller. Walking the address, the slug or the search term
 * mints a brand-new bucket per request, so the ceiling is never approached and the quota meters
 * nothing at all. Forty requests naming forty addresses cost one unit each.
 *
 * It also mis-attributes in the ordinary case: a hundred members reading the SAME popular
 * collection share one bucket and throttle each other, while one script reading a hundred
 * different collections is never limited. The keying is wrong in both directions at once.
 *
 * ── WHAT REPLACES IT ─────────────────────────────────────────────────────────────────────────
 *
 * The subject the identity layer resolved, which the caller cannot freely rotate:
 *
 *   member/address  the account behind a signature we verified
 *   human           the digest of a challenge token we verified
 *   anonymous       the network address, which is the weakest key available and the only one left
 *
 * The subject is tier-namespaced upstream (`subjectFor`), so tiers never share a window (FR-012) —
 * exhausting the anonymous allowance cannot deny an authenticated member.
 *
 * ── WHY THE NETWORK ADDRESS IS STILL A FALLBACK ──────────────────────────────────────────────
 *
 * It is genuinely weak: it rotates cheaply, and behind a proxy it can pool unrelated callers
 * together. It is used only where nothing better exists — an anonymous caller has, by definition,
 * proven nothing. The answer to its weakness is the tier ladder (prove something and get a real
 * key, plus a higher ceiling), not a better guess about who is behind an IP.
 *
 * Note `req.ip` is the proxy on the VM deployment, so the anonymous bucket is coarse. That is
 * stated rather than hidden: a coarse anonymous bucket with a low ceiling is the intended shape,
 * because the cheap path for a legitimate heavy reader is to identify themselves.
 */

/**
 * @param {import('express').Request} req
 * @returns {string} a key the caller cannot choose
 */
export function callerQuotaKey(req) {
  // Set by the identity middleware for every request, including when the layer is disabled — so
  // this never has to branch on configuration.
  if (req && typeof req.callerSubject === 'string' && req.callerSubject) return req.callerSubject
  // Defensive only: reachable if a router is mounted without the middleware in front of it (a
  // test harness, say). Falling back keeps metering working rather than throwing; it never
  // silently loosens anything, because a shared fallback bucket is STRICTER than a per-caller one.
  return `unattributed:ip:${(req && req.ip) || 'unknown'}`
}
