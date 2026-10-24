// Spec 111 — the ONE client of the Sigil daemon's IPC socket.
//
// The daemon (chippr-robotics/sigil, crates/sigil-daemon) speaks newline-delimited JSON on a Unix
// socket: one request line in, one response line out, serde-tagged on `type`. This module speaks
// exactly the three read/sign operations the bridge exposes and NOTHING else — in particular it has
// no path to `ImportAgentShard` / `ImportChildShares`. Sigil's constitution (Principle IV) forbids
// key material over a convenience transport, and the cheapest way to keep that true is for the
// bridge to have no function that could send it.

import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** Where a default-configured daemon listens (sigil-daemon config.rs `default_ipc_path`). */
export function defaultSocketPath(env = process.env) {
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'sigil.sock')
  return os.platform() === 'win32' ? '\\\\.\\pipe\\sigil' : '/run/sigil/sigil.sock'
}

export class DaemonError extends Error {
  /** @param {'unreachable'|'timeout'|'protocol'|'refused'} kind */
  constructor(kind, message) {
    super(message)
    this.name = 'DaemonError'
    this.kind = kind
  }
}

/**
 * Send one request and read one response line.
 * @param {string} socketPath
 * @param {object} request an IpcRequest (`{ type, ... }`)
 * @param {{ timeoutMs?: number }} [opts]
 */
export function request(socketPath, req, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let buffer = ''
    const socket = net.createConnection(socketPath)
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn(value)
    }
    const timer = setTimeout(
      () => finish(reject, new DaemonError('timeout', 'The Sigil daemon did not answer in time.')),
      timeoutMs,
    )
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(req)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      // A response line is small; anything this large is not a daemon we understand.
      if (buffer.length > 64 * 1024) {
        finish(reject, new DaemonError('protocol', 'The Sigil daemon sent an oversized response.'))
        return
      }
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      try {
        finish(resolve, JSON.parse(buffer.slice(0, nl)))
      } catch {
        finish(reject, new DaemonError('protocol', 'The Sigil daemon sent a response that is not JSON.'))
      }
    })
    socket.on('error', (err) => {
      const kind = err.code === 'EACCES' || err.code === 'EPERM' ? 'refused' : 'unreachable'
      const message =
        kind === 'refused'
          ? 'The Sigil daemon socket refused this user. Run the bridge as a member of the `sigil` group.'
          : 'The Sigil daemon is not running (no socket at the configured path).'
      finish(reject, new DaemonError(kind, message))
    })
    socket.on('end', () => {
      if (!settled) finish(reject, new DaemonError('protocol', 'The Sigil daemon closed the connection without answering.'))
    })
  })
}

/** A daemon client bound to one socket. The only three operations the bridge can perform. */
export function createDaemonClient({ socketPath = defaultSocketPath(), signTimeoutMs = 90_000 } = {}) {
  const expect = (res, type) => {
    if (res?.type === 'Error') throw new DaemonError('refused', String(res.message || 'The Sigil daemon refused the request.'))
    if (res?.type !== type) throw new DaemonError('protocol', `Expected ${type} from the Sigil daemon, got ${res?.type ?? 'nothing'}.`)
    return res
  }
  return {
    socketPath,
    async ping() {
      return expect(await request(socketPath, { type: 'Ping' }), 'Pong')
    },
    async diskStatus() {
      return expect(await request(socketPath, { type: 'GetDiskStatus' }), 'DiskStatus')
    },
    async sign({ digestHex, chainId, description }) {
      return expect(
        await request(
          socketPath,
          { type: 'Sign', message_hash: digestHex, chain_id: chainId, description },
          { timeoutMs: signTimeoutMs },
        ),
        'SignResult',
      )
    },
    async updateTxHash({ presigIndex, txHashHex }) {
      return expect(
        await request(socketPath, { type: 'UpdateTxHash', presig_index: presigIndex, tx_hash: txHashHex }),
        'Ok',
      )
    },
  }
}
