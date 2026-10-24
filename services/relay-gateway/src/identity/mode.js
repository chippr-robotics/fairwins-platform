/**
 * One sentence describing the caller-identity layer's operating mode (spec 106 FR-015).
 *
 * There is exactly one of these because boot and SIGHUP-reload must never be able to describe the
 * same configuration differently — an operator reading the journal after a reload is entitled to
 * compare the two lines directly.
 *
 * This is the disclosure that is ALWAYS available. Since #1505, `enforcing` is operator-only on
 * /status (the origin lock that used to guard it is injected by Cloudflare for every caller, so it
 * gated nothing), which makes this line the thing that keeps "disabled" from being
 * indistinguishable from "enforcing" — the exact property FR-015 exists to protect.
 */
export function describeIdentityMode(config) {
  const enabled = config?.identity?.enabled === true
  const killed = config?.identity?.killswitch === true
  const enforce = config?.identity?.enforce === true

  if (!enabled) return 'caller identity: DISABLED — every caller resolves anonymous, nothing is refused'
  if (killed) return 'caller identity: KILLSWITCH ENGAGED — enabled but refusing nothing'
  if (!enforce) return 'caller identity: OBSERVE MODE — resolving and counting, refusing NOTHING'
  return 'caller identity: ENFORCING — callers below a route\'s required tier are refused'
}
