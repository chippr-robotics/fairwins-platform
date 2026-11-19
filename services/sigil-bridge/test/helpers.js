// A stand-in sigil-daemon: the real wire format (newline-delimited, serde-tagged JSON) on a real
// Unix socket, so the bridge's daemon client is exercised end to end. It records every request so
// tests can assert on what the bridge ASKED for — not only on what it returned.

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PUBKEY = `02${'ab'.repeat(32)}`
export const SIGNATURE = 'cd'.repeat(64)

export function defaultDisk(overrides = {}) {
  return {
    type: 'DiskStatus',
    detected: true,
    child_id: '9e8d7c6b',
    presigs_remaining: 742,
    presigs_total: 1000,
    days_until_expiry: 30,
    is_valid: true,
    child_pubkey: PUBKEY,
    ...overrides,
  }
}

export async function startFakeDaemon({ disk = defaultDisk(), onSign } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-fake-'))
  const socketPath = path.join(dir, 'sigil.sock')
  const requests = []
  const state = { disk, presigIndex: 258 }
  const server = net.createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const req = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        requests.push(req)
        let res
        if (req.type === 'Ping') res = { type: 'Pong', version: '0.6.0' }
        else if (req.type === 'GetDiskStatus') res = state.disk
        else if (req.type === 'Sign') {
          res = onSign ? onSign(req) : { type: 'SignResult', signature: SIGNATURE, presig_index: state.presigIndex, proof_hash: 'ff'.repeat(32) }
          state.presigIndex += 1
        } else if (req.type === 'UpdateTxHash') res = { type: 'Ok' }
        else res = { type: 'Error', message: `unsupported ${req.type}` }
        sock.write(`${JSON.stringify(res)}\n`)
      }
    })
  })
  await new Promise((r) => server.listen(socketPath, r))
  return {
    socketPath,
    requests,
    state,
    async close() {
      await new Promise((r) => server.close(r))
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}
