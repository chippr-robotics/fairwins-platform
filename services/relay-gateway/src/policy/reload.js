/**
 * Signal-driven configuration reload (spec 106 FR-014 as amended, #1446).
 *
 * ── WHY A SIGNAL, AND WHY NOT AN ADMIN ROUTE ─────────────────────────────────────────────────
 *
 * There is no operator write channel to this gateway, in any form, and that is a considered
 * absence: an authenticated write path INTO the process that guards the platform's credentials is
 * a larger security surface than the problem justifies. The one operator gesture that already
 * exists is a signal over the IAP tunnel — so reload extends that gesture. SIGHUP re-reads;
 * SIGUSR2 keeps its long-documented meaning (toggle the global kill switch) untouched, because
 * silently changing a gesture operators use during incidents is how an incident gets worse.
 *
 * THIS IS A RELOAD, NOT A REMOTE CONTROL. The operator edits the mounted env file (the same file
 * `fetch-secrets.sh` delivers) and signals. The process re-reads THAT FILE — its own environment
 * is frozen at exec, which is why "just restart with new env" was the old answer and a
 * same-process re-read is the new one.
 *
 * ── THE ALLOWLIST IS THE SECURITY BOUNDARY ───────────────────────────────────────────────────
 *
 * Only OPERATIONAL SWITCHES reload: kill switches, enable flags, ceilings. Fund-path
 * configuration — signing keys, engine URLs, chain endpoints, addresses — deliberately does NOT:
 * repointing those live, on a signal, with no boot validation, is precisely the class of change
 * that must go through a deploy where `assertChainEndpoints` and the boot-fatal checks can refuse
 * it. A key that could be swapped by editing a file and signalling would also be a key swapped by
 * anyone who can write that file, silently, with no restart for anyone to notice.
 *
 * ── IN-FLIGHT REQUESTS ───────────────────────────────────────────────────────────────────────
 *
 * Values are applied by MUTATING the live config objects that request handlers read per request.
 * A request that already read a flag completes under what it read; the next request sees the new
 * value. No connection is dropped, nothing restarts.
 */
import fs from 'node:fs'
import { describeIdentityMode } from '../identity/mode.js'

/**
 * Reloadable keys, each with exactly where it lands. Adding one here is a deliberate act — the
 * comment above is the bar it has to clear.
 */
const RELOADABLE = [
  { env: 'KILL_SWITCH', apply: (c, v, ks) => ks.set(v) },
  { env: 'IDENTITY_ENABLED', apply: (c, v) => { c.identity.enabled = v } },
  { env: 'IDENTITY_ENFORCE', apply: (c, v) => { c.identity.enforce = v } },
  { env: 'IDENTITY_KILLSWITCH', apply: (c, v) => { c.identity.killswitch = v } },
  { env: 'RPC_ACCESS_ENABLED', apply: (c, v) => { c.rpcAccess.enabled = v } },
  { env: 'RPC_ACCESS_KILLSWITCH', apply: (c, v) => { c.rpcAccess.killswitch = v } },
  { env: 'BTC_KILLSWITCH', apply: (c, v) => { if (c.bitcoin) c.bitcoin.killSwitch = v } },
  { env: 'BRIDGE_KILLSWITCH', apply: (c, v) => { if (c.bridge) c.bridge.killSwitch = v } },
  { env: 'PERPS_KILLSWITCH', apply: (c, v) => { if (c.perps) c.perps.killSwitch = v } },
  { env: 'MEMBER_API_KILLSWITCH', apply: (c, v) => { if (c.memberApi) c.memberApi.killSwitch = v } },
  { env: 'X402_KILLSWITCH', apply: (c, v) => { if (c.x402) c.x402.killSwitch = v } },
]

/** Numeric ceilings reload too — a burst is exactly when an operator wants to tighten one. */
const RELOADABLE_INT = [
  { env: /^UPSTREAM_CEILING_([A-Z]+)$/, apply: (c, name, v) => { c.identity.upstreamCeilings[name.toLowerCase()] = v } },
]

/** Minimal KEY=VALUE parser for the delivered env file. Quotes stripped; no interpolation. */
export function parseEnvFile(text) {
  const out = {}
  for (const raw of String(text).split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Apply the allowlisted keys from `env` onto the LIVE config. Pure with respect to I/O — the
 * file read lives in the handler so this stays unit-testable.
 *
 * @returns {string[]} the names of settings that actually changed (names ONLY — a value here
 *   would put config contents into logs, and the log line is the intended destination)
 */
export function applyReload(config, killSwitch, env) {
  const changed = []
  for (const { env: name, apply } of RELOADABLE) {
    if (!(name in env)) continue // ABSENT means "leave alone", never "reset to default"
    const next = String(env[name]).toLowerCase() === 'true'
    const before = readCurrent(config, killSwitch, name)
    if (before === next) continue
    apply(config, next, killSwitch)
    changed.push(name)
  }
  for (const [key, value] of Object.entries(env)) {
    for (const { env: pattern, apply } of RELOADABLE_INT) {
      const m = key.match(pattern)
      if (!m) continue
      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed) || parsed < 0) continue
      if (config.identity.upstreamCeilings[m[1].toLowerCase()] === parsed) continue
      apply(config, m[1], parsed)
      changed.push(key)
    }
  }
  return changed
}

function readCurrent(config, killSwitch, name) {
  switch (name) {
    case 'KILL_SWITCH': return killSwitch.isActive()
    case 'IDENTITY_ENABLED': return config.identity.enabled
    case 'IDENTITY_ENFORCE': return config.identity.enforce
    case 'IDENTITY_KILLSWITCH': return config.identity.killswitch
    case 'RPC_ACCESS_ENABLED': return config.rpcAccess.enabled
    case 'RPC_ACCESS_KILLSWITCH': return config.rpcAccess.killswitch
    case 'BTC_KILLSWITCH': return config.bitcoin?.killSwitch
    case 'BRIDGE_KILLSWITCH': return config.bridge?.killSwitch
    case 'PERPS_KILLSWITCH': return config.perps?.killSwitch
    case 'MEMBER_API_KILLSWITCH': return config.memberApi?.killSwitch
    case 'X402_KILLSWITCH': return config.x402?.killSwitch
    default: return undefined
  }
}

/**
 * The SIGHUP handler. `RELOAD_ENV_FILE` names the source (the mounted env file the deploy already
 * delivers); unset, the handler answers every signal with an honest "no source configured" rather
 * than pretending to reload — a no-op that logs success would be a killswitch an operator
 * believes they threw.
 */
export function createReloadHandler(config, killSwitch, { readFile = fs.readFileSync, log = console.warn } = {}) {
  const source = config.reloadEnvFile
  return function onReload() {
    if (!source) {
      log('[relay-gateway] SIGHUP received but RELOAD_ENV_FILE is not set — nothing reloaded. Set it to the mounted env file to enable live reload.')
      return { reloaded: false, changed: [] }
    }
    let text
    try {
      text = readFile(source, 'utf8')
    } catch (err) {
      // An unreadable source is a FAILED reload and says so. Operators acting during an incident
      // must never be left believing a control landed when it did not.
      log(`[relay-gateway] SIGHUP reload FAILED: cannot read ${source} (${err.code || 'error'}) — nothing changed.`)
      return { reloaded: false, changed: [] }
    }
    const changed = applyReload(config, killSwitch, parseEnvFile(text))
    log(
      changed.length
        ? `[relay-gateway] SIGHUP reload applied: ${changed.join(', ')}` // names only, never values
        : '[relay-gateway] SIGHUP reload: no allowlisted setting differed — nothing changed.'
    )
    // The resulting MODE, by value — deliberately, and not a breach of the names-only rule above.
    // That rule exists so a secret cannot reach the log; this is a derived operating state that
    // FR-015 requires be legible, and since #1505 made `enforcing` operator-only on /status, an
    // operator who has just changed it has no other way to confirm what they changed it TO.
    log(`[relay-gateway] ${describeIdentityMode(config)}`)
    return { reloaded: true, changed }
  }
}
