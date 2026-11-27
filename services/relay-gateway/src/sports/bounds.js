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
  // Fight view (slice 3). Switched off until observed on a live card (FR-020), so these are PROVISIONAL.
  //  - `card` (ESPN MMA scoreboard): the same transport and cache floor as `plays`, so the same cache-window
  //    multiples. Its live cadence for MMA has never been observed.
  //  - `figures` (UFC's own JSON): NEVER live until its live cadence has been observed (2026-12-05 card);
  //    delayed <= 120 s is a cache-window multiple, not a measurement.
  card: Object.freeze({ liveMs: 30_000, delayedMs: 120_000 }),
  figures: Object.freeze({ liveMs: null, delayedMs: 120_000 }),
})
