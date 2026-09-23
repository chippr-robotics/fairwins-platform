#!/usr/bin/env node
// Spec 111 — `sigil-bridge`: run on the computer that holds the Sigil agent shard, next to
// `sigil-daemon`. See ../README.md for the security model.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import { createDaemonClient, defaultSocketPath } from './daemon.js'
import { createBridgeServer, normalizeOrigin, BRIDGE_VERSION } from './server.js'

export const DEFAULT_PORT = 7318
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

const USAGE = `sigil-bridge ${BRIDGE_VERSION} — loopback bridge from a browser to sigil-daemon

Usage: sigil-bridge --allow-origin <origin> [options]

  --allow-origin <origin>  Web origin allowed to call the bridge (repeatable; required).
                           Also read from SIGIL_BRIDGE_ORIGINS (comma-separated).
  --port <n>               Listen port (default ${DEFAULT_PORT}).
  --host <addr>            Listen address (default 127.0.0.1).
  --allow-non-loopback     Required to listen on anything but loopback. Logged loudly.
  --socket <path>          sigil-daemon IPC socket (default ${defaultSocketPath()}).
  --token-file <path>      Pairing token file (created 0600 if missing).
  --confirm                Ask on this terminal before every signature.
  --help                   Show this help.
`

export function parseArgs(argv, env = process.env) {
  const opts = {
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    allowNonLoopback: false,
    socket: env.SIGIL_SOCKET || defaultSocketPath(env),
    tokenFile: env.SIGIL_BRIDGE_TOKEN_FILE || defaultTokenFile(env),
    origins: String(env.SIGIL_BRIDGE_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    confirm: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`)
      i += 1
      return argv[i]
    }
    if (a === '--allow-origin') opts.origins.push(next())
    else if (a === '--port') opts.port = Number(next())
    else if (a === '--host') opts.host = next()
    else if (a === '--allow-non-loopback') opts.allowNonLoopback = true
    else if (a === '--socket') opts.socket = next()
    else if (a === '--token-file') opts.tokenFile = next()
    else if (a === '--confirm') opts.confirm = true
    else if (a === '--help' || a === '-h') opts.help = true
    else throw new Error(`Unknown option: ${a}`)
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('--port must be 1–65535')
  const bad = opts.origins.filter((o) => !normalizeOrigin(o))
  if (bad.length) throw new Error(`Not a valid origin: ${bad.join(', ')}`)
  if (opts.origins.includes('*')) throw new Error('A wildcard origin is never allowed.')
  if (!LOOPBACK.has(opts.host) && !opts.allowNonLoopback) {
    throw new Error(`Refusing to listen on ${opts.host}: pass --allow-non-loopback to bind beyond loopback.`)
  }
  return opts
}

export function defaultTokenFile(env = process.env) {
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'sigil-bridge.token')
  return path.join(env.HOME || os.homedir(), '.config', 'sigil-bridge', 'token')
}

/** Read the pairing token, creating it (0600, parent 0700) when absent. Never logs it. */
export function loadOrCreateToken(file) {
  if (fs.existsSync(file)) {
    const stat = fs.statSync(file)
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error(`${file} is readable by other users; chmod 600 it (or delete it to mint a new token).`)
    }
    const token = fs.readFileSync(file, 'utf8').trim()
    if (token.length < 32) throw new Error(`${file} does not hold a usable token; delete it to mint a new one.`)
    return { token, created: false }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' })
  return { token, created: true }
}

function terminalConfirm() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return async ({ description, digest, chainId, childId }) => {
    const answer = await rl.question(
      `\nSign with disk ${childId ?? '?'}?\n  ${description}\n  chain ${chainId}  digest ${digest}\n  [y/N] `,
    )
    return /^y(es)?$/i.test(answer.trim())
  }
}

export async function main(argv = process.argv.slice(2)) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`)
    return 2
  }
  if (opts.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (opts.origins.length === 0) {
    process.stderr.write(`At least one --allow-origin is required.\n\n${USAGE}`)
    return 2
  }
  if (opts.confirm && !process.stdin.isTTY) {
    process.stderr.write('--confirm needs an interactive terminal.\n')
    return 2
  }
  if (opts.allowNonLoopback) {
    process.stderr.write(`WARNING: listening on ${opts.host}, beyond loopback. Anyone who can reach it and holds the token can spend presignatures while the disk is inserted.\n`)
  }

  const { token, created } = loadOrCreateToken(opts.tokenFile)
  const daemon = createDaemonClient({ socketPath: opts.socket })
  const server = createBridgeServer({
    daemon,
    token,
    allowedOrigins: opts.origins,
    port: opts.port,
    extraHosts: LOOPBACK.has(opts.host) ? [] : [opts.host],
    confirm: opts.confirm ? terminalConfirm() : null,
    log: (line) => process.stdout.write(`[sigil-bridge] ${line}\n`),
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, opts.host, resolve)
  })
  const shownHost = opts.host === '::1' ? '[::1]' : opts.host
  process.stdout.write(
    [
      `sigil-bridge ${BRIDGE_VERSION} listening on http://${shownHost}:${opts.port}`,
      `  daemon socket: ${opts.socket}`,
      `  allowed origins: ${opts.origins.map(normalizeOrigin).join(', ')}`,
      `  pairing token (${created ? 'new' : 'existing'}): ${opts.tokenFile}`,
      `  confirm each signature on this terminal: ${opts.confirm ? 'yes' : 'no'}`,
      '',
      'To pair, paste the contents of the token file into FairWins ▸ Protect ▸ Off chain ▸ Sigil.',
      '',
    ].join('\n'),
  )
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    if (typeof code === 'number') process.exit(code)
  })
}
