/**
 * How old a confirmation may be before a surface stops calling it live (spec 115, research R1).
 *
 * ONE exported constant, mirrored by the frontend (`lib/sports/gameReading.js`) and stated in
 * contracts/gateway-sports-api.md. Ages are measured on the SERVER's clock against `confirmedAt`.
 *
 *  - `plays` (ESPN, polled): live <= 30 s (three cache windows), delayed <= 120 s.
 *  - `venue`: NEVER live (`liveMs: null`). Its feed sends a frame for a game only when something
 *    changed, on minute ticks, and was measured a median 34 s (max 203 s) BEHIND the play source, so
 *    even a fresh venue figure is not "now". `confirmedAt` for a venue row is the connection's own
 *    heartbeat (a frame of any kind every ~15 s), which is why 75 s (five heartbeats) is a sound
 *    "delayed" ceiling; beyond it the figure is last known.
 */
export const TRUST_BOUNDS = Object.freeze({
  plays: Object.freeze({ liveMs: 30_000, delayedMs: 120_000 }),
  venue: Object.freeze({ liveMs: null, delayedMs: 75_000 }),
})
