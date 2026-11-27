/**
 * How old a confirmation may be before a surface stops calling it live (spec 115, research R1).
 *
 * ONE exported constant, mirrored by the frontend (`lib/sports/gameReading.js`) and stated in
 * contracts/gateway-sports-api.md. Ages are measured on the SERVER's clock against `confirmedAt`.
 *
 * The numbers come from measurement, not taste: the venue feed has no heartbeat and its NFL
 * cadence was measured at ~60 s per game, so a bound shorter than one cadence would call every
 * quiet minute of a healthy feed "delayed". The plays source is polled on a 10 s cache, so its
 * bounds are a few cache windows. See research.md R1 for the sample sizes behind each figure.
 */
export const TRUST_BOUNDS = Object.freeze({
  venue: Object.freeze({ liveMs: 90_000, delayedMs: 300_000 }),
  plays: Object.freeze({ liveMs: 30_000, delayedMs: 120_000 }),
})
