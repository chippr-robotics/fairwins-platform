/**
 * The venue's sports feed (spec 115, source `venue`): ONE upstream WebSocket for the whole gateway.
 *
 * Shape of the feed (research R1, measured 2026-11-27): no auth, no subscribe message, no ping. It
 * pushes one JSON object per game state change / periodic refresh; control frames are a bare JSON
 * `null`, which doubles as the connection's heartbeat. A GAME's silence is not an outage (a game can
 * go minutes without a frame), so a game's age is reported as `changedAt` and the connection's
 * liveness separately as `confirmedAt`.
 *
 * HEARTBEAT (research R1, all four captures): the feed sends a bare JSON `null` about every 15 s
 * (median gap 15.3 s); across 2,602 intra-connection frame gaps the p99 was 20.8 s and the maximum
 * 41.5 s. So a connection is judged DEAD after `deadAfterMs` = 60 s with no frame of any kind (~4
 * heartbeats, 1.4x the worst gap seen) and is closed and reconnected. A frame for a game records
 * `changedAt`; `confirmedAt` is the last frame of any kind on the open connection, but only when that
 * game's frame arrived on THIS connection (a reconnect re-sends nothing, so a game's confirmation
 * falls back to its own `changedAt` until its next frame).
 *
 * Rules this module keeps:
 *  - LAZY: nothing is opened until a request calls `touch()`. CLOSED after `idleCloseMs` (5 min)
 *    with no request, and a closed feed forgets its frames (they would be stale-as-live on reopen).
 *  - A REQUEST NEVER WAITS ON, OR THROWS FROM, THE SOCKET. `touch()` and `read()` are synchronous
 *    and total; every socket failure becomes a `state()` value instead.
 *  - RECONNECT with capped exponential backoff, only while somebody is still asking.
 *  - Frames are kept as the small normalized object the caller supplied a parser for, newest per
 *    game, capped — never the raw frame.
 *  - The WebSocket constructor and the clock/timers are injected (Node 22's global `WebSocket` by
 *    default), so the lifecycle is testable without a network.
 */

const DEFAULTS = Object.freeze({
  idleCloseMs: 300_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  maxGames: 5_000,
  deadAfterMs: 60_000,
})

/**
 * @param {{
 *   url: string,
 *   parseFrame: (raw: unknown, receivedAt: number) => ({gameId: number} & Record<string, unknown>) | null,
 *   WebSocketImpl?: typeof WebSocket,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   idleCloseMs?: number, deadAfterMs?: number, backoffBaseMs?: number, backoffMaxMs?: number, maxGames?: number,
 *   log?: (msg: string) => void,
 * }} opts
 */
export function createVenueFeed(opts) {
  const {
    url,
    parseFrame,
    WebSocketImpl = globalThis.WebSocket,
    now = Date.now,
    setTimer = (fn, ms) => {
      const h = setTimeout(fn, ms)
      h?.unref?.()
      return h
    },
    clearTimer = (h) => clearTimeout(h),
    idleCloseMs = DEFAULTS.idleCloseMs,
    backoffBaseMs = DEFAULTS.backoffBaseMs,
    backoffMaxMs = DEFAULTS.backoffMaxMs,
    maxGames = DEFAULTS.maxGames,
    deadAfterMs = DEFAULTS.deadAfterMs,
    log = () => {},
  } = opts

  /** @type {Map<number, {frame: object, at: number}>} insertion order == least-recently-updated first */
  const games = new Map()
  let socket = null
  let phase = 'closed' // closed | connecting | open | backoff
  let attempts = 0
  let reconnectTimer = null
  let idleTimer = null
  let lastFrameAt = null
  let openedAt = null
  let lastError = null
  let totalFrames = 0
  let connId = 0
  let lastAnyAt = null // last frame of ANY kind on the current connection
  let deadTimer = null
  let deadDrops = 0

  function armIdle() {
    if (idleTimer != null) clearTimer(idleTimer)
    idleTimer = setTimer(closeForIdle, idleCloseMs)
  }

  function closeForIdle() {
    idleTimer = null
    shutdown('idle')
  }

  function shutdown(why) {
    if (reconnectTimer != null) clearTimer(reconnectTimer)
    reconnectTimer = null
    if (idleTimer != null) clearTimer(idleTimer)
    idleTimer = null
    stopWatchdog()
    const s = socket
    socket = null
    phase = 'closed'
    attempts = 0
    games.clear()
    lastFrameAt = null
    lastError = why === 'idle' ? null : lastError
    if (s) {
      // Detach first: our own close must not schedule a reconnect.
      s.onopen = s.onmessage = s.onerror = s.onclose = null
      try {
        s.close()
      } catch {
        /* closing a socket that is already gone is not an event */
      }
    }
  }

  function stopWatchdog() {
    if (deadTimer != null) clearTimer(deadTimer)
    deadTimer = null
  }

  function armWatchdog() {
    stopWatchdog()
    deadTimer = setTimer(() => {
      deadTimer = null
      if (phase !== 'open') return
      if (now() - (lastAnyAt ?? openedAt ?? 0) > deadAfterMs) {
        // A connection that has not even sent its heartbeat is dead whatever the socket claims.
        deadDrops += 1
        lastError = 'heartbeat_lost'
        const s = socket
        socket = null
        if (s) {
          s.onopen = s.onmessage = s.onerror = s.onclose = null
          try {
            s.close()
          } catch {
            /* already gone */
          }
        }
        scheduleReconnect()
      } else armWatchdog()
    }, Math.max(1, Math.floor(deadAfterMs / 4)))
  }

  function scheduleReconnect() {
    stopWatchdog()
    phase = 'backoff'
    const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempts)
    attempts += 1
    reconnectTimer = setTimer(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function onFrame(data) {
    lastAnyAt = now() // any frame — including the bare `null` heartbeat and junk — proves the connection alive
    let parsed
    try {
      parsed = JSON.parse(typeof data === 'string' ? data : String(data))
    } catch {
      return // not JSON: nothing to learn, nothing to throw
    }
    if (parsed === null || typeof parsed !== 'object') return // the feed's bare `null` control frame
    totalFrames += 1
    const at = now()
    lastFrameAt = at
    let frame = null
    try {
      frame = parseFrame(parsed, at)
    } catch {
      frame = null
    }
    if (!frame || !Number.isSafeInteger(frame.gameId)) return
    games.delete(frame.gameId) // re-insert at the tail
    games.set(frame.gameId, { frame, at, connId })
    while (games.size > maxGames) games.delete(games.keys().next().value)
  }

  function connect() {
    if (typeof WebSocketImpl !== 'function') {
      phase = 'closed'
      lastError = 'no_websocket_implementation'
      return
    }
    phase = 'connecting'
    connId += 1
    lastAnyAt = null
    let s
    try {
      s = new WebSocketImpl(url)
    } catch (e) {
      lastError = 'connect_failed'
      log(`[sports] venue feed construct failed: ${e?.name ?? 'error'}`)
      scheduleReconnect()
      return
    }
    socket = s
    s.onopen = () => {
      if (socket !== s) return
      phase = 'open'
      attempts = 0
      openedAt = now()
      lastError = null
      armWatchdog()
    }
    s.onmessage = (ev) => {
      if (socket !== s) return
      onFrame(ev?.data)
    }
    s.onerror = () => {
      if (socket !== s) return
      lastError = 'socket_error'
    }
    s.onclose = () => {
      if (socket !== s) return
      socket = null
      lastError = lastError ?? 'closed_by_peer'
      scheduleReconnect()
    }
  }

  return {
    /** A request wants the feed. Opens it if closed; never waits, never throws. */
    touch() {
      armIdle()
      if (phase === 'closed') connect()
    },
    /**
     * The newest frame for a game with its two times, or null when the feed has not said anything about it.
     * `changedAt`: when the feed last sent a frame for THIS game. `confirmedAt`: the last frame of any kind
     * on the open connection, only if the game's frame arrived on that same connection; else `changedAt`.
     */
    read(gameId) {
      const e = games.get(gameId)
      if (!e) return null
      const onThisConnection = phase === 'open' && e.connId === connId && lastAnyAt != null
      return { frame: e.frame, changedAt: e.at, confirmedAt: onThisConnection ? Math.max(lastAnyAt, e.at) : e.at }
    },
    /**
     * `read` — the socket is open (silence about a game is then just silence);
     * `unreadable` — connecting, reconnecting, or unable to connect, with a reason.
     */
    state() {
      if (phase === 'open') return { state: 'read' }
      return { state: 'unreadable', reason: phase === 'connecting' ? 'connecting' : phase === 'backoff' ? 'reconnecting' : 'not_connected' }
    },
    status() {
      return { phase, games: games.size, frames: totalFrames, lastFrameAt: lastAnyAt ?? lastFrameAt, openedAt, lastError, reconnectAttempts: attempts, heartbeatDrops: deadDrops }
    },
    close() {
      shutdown('close')
    },
  }
}
