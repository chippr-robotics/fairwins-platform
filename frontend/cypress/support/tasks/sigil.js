/**
 * Node-side world for the Sigil cold signer (spec 111).
 *
 * WHAT IS REAL AND WHAT STANDS IN — the whole value of these specs is this boundary:
 *
 *   browser (the real app, real adapter, real HardwareSigner, real broadcast)
 *     └─ fetch ─▶ services/sigil-bridge            ◀── the REAL bridge, same code members run:
 *                                                      origin allowlist, pairing token, Host check,
 *                                                      disk pre-checks, serialized signing
 *          └─ unix socket ─▶ STAND-IN sigil-daemon ◀── speaks the daemon's real wire format
 *                                                      (newline-delimited, serde-tagged JSON) and
 *                                                      does exactly the daemon's MATH contract:
 *                                                      a raw 32-byte prehash in, low-S r||s out,
 *                                                      no recovery id, one presignature per call.
 *
 * What the stand-in does NOT do is the 2-party presignature combination and the floppy I/O. Those
 * are Sigil's trusted computing base and are specified and tested in chippr-robotics/sigil
 * (specs 002 and 004); a combined MPC signature is an ordinary ECDSA signature under the child
 * key, which is the only property the app depends on. So the signing KEY here is a local test key,
 * and every signature it makes is a real one — the chain, viem and the app's recover-and-verify
 * gates judge it exactly as they would judge a disk's.
 *
 * Test-only: this file lives under cypress/ and is never bundled into the app.
 */

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { secp256k1 } from '@noble/curves/secp256k1.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BRIDGE_SRC = resolve(__dirname, '../../../../services/sigil-bridge/src')

const hex = (bytes) => Buffer.from(bytes).toString('hex')
const unhex = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/i, ''), 'hex'))

let world = null

function defaultDisk(publicKey) {
  return {
    detected: true,
    child_id: '5e1f0a17',
    presigs_remaining: 742,
    presigs_total: 1000,
    days_until_expiry: 30,
    is_valid: true,
    child_pubkey: publicKey,
  }
}

async function startDaemon({ privateKey, disk }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-e2e-'))
  const socketPath = path.join(dir, 'sigil.sock')
  const sk = unhex(privateKey)
  const publicKey = hex(secp256k1.getPublicKey(sk, true))
  const state = { disk: { ...defaultDisk(publicKey), ...disk }, presigIndex: 258, requests: [] }

  const handle = (req) => {
    state.requests.push(req)
    switch (req.type) {
      case 'Ping':
        return { type: 'Pong', version: '0.7.0-e2e' }
      case 'GetDiskStatus':
        return state.disk.detected ? { type: 'DiskStatus', ...state.disk } : { type: 'DiskStatus', detected: false }
      case 'Sign': {
        if (!state.disk.detected) return { type: 'Error', message: 'No disk detected' }
        const sig = secp256k1.sign(unhex(req.message_hash), sk, { prehash: false, lowS: true })
        const presig = state.presigIndex
        state.presigIndex += 1
        state.disk.presigs_remaining = Math.max(0, state.disk.presigs_remaining - 1)
        return { type: 'SignResult', signature: hex(sig), presig_index: presig, proof_hash: crypto.createHash('sha256').update(sig).digest('hex') }
      }
      case 'UpdateTxHash':
        return { type: 'Ok' }
      default:
        return { type: 'Error', message: `The e2e stand-in does not implement ${req.type}` }
    }
  }

  const server = net.createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let res
        try {
          res = handle(JSON.parse(line))
        } catch (e) {
          res = { type: 'Error', message: String(e?.message || e) }
        }
        sock.write(`${JSON.stringify(res)}\n`)
      }
    })
  })
  await new Promise((r) => server.listen(socketPath, r))
  return { server, socketPath, dir, state, publicKey }
}

async function stopWorld() {
  if (!world) return
  const w = world
  world = null
  await new Promise((r) => w.bridge?.close(() => r()) ?? r())
  await new Promise((r) => w.daemon.server.close(() => r()))
  fs.rmSync(w.daemon.dir, { recursive: true, force: true })
}

export default function sigilTasks(config) {
  const appOrigin = new URL(config.baseUrl || 'http://localhost:5173').origin
  return {
    /**
     * `start`   { privateKey, disk?, port? } → { url, token, publicKey }  (restarts if running)
     * `stopBridge`                           → the bridge goes away, the daemon stays
     * `setDisk` { ...DiskStatus fields }     → e.g. { detected: false } pulls the floppy
     * `log`                                  → every request the daemon received, in order
     * `txFrom`  { hash }                     → the sender the local chain recovered for a tx
     * `stop`
     */
    async sigilWorld({ action, args = {} } = {}) {
      try {
        switch (action) {
          case 'start': {
            await stopWorld()
            if (!/^0x[0-9a-fA-F]{64}$/.test(args.privateKey || '')) throw new Error('sigilWorld start: needs a 0x private key')
            const daemon = await startDaemon({ privateKey: args.privateKey, disk: args.disk })
            const { createDaemonClient } = await import(`${BRIDGE_SRC}/daemon.js`)
            const { createBridgeServer } = await import(`${BRIDGE_SRC}/server.js`)
            const token = crypto.randomBytes(32).toString('hex')
            const port = Number(args.port || 7318)
            const bridge = createBridgeServer({
              daemon: createDaemonClient({ socketPath: daemon.socketPath }),
              token,
              allowedOrigins: [appOrigin],
              port,
            })
            await new Promise((r, j) => {
              bridge.once('error', j)
              bridge.listen(port, '127.0.0.1', r)
            })
            world = { daemon, bridge, token, port }
            return { ok: true, url: `http://127.0.0.1:${port}`, token, publicKey: `0x${daemon.publicKey}` }
          }
          case 'stopBridge': {
            if (world?.bridge) {
              await new Promise((r) => world.bridge.close(() => r()))
              world.bridge = null
            }
            return { ok: true }
          }
          case 'setDisk': {
            if (!world) throw new Error('sigilWorld setDisk: not started')
            Object.assign(world.daemon.state.disk, args)
            return { ok: true, disk: world.daemon.state.disk }
          }
          case 'txFrom': {
            // Who the CHAIN says sent a transaction — recovered by the node from the signature,
            // which is the only judgement of a Sigil signature that matters for value.
            const rpcUrl = config.env.RPC_URL || 'http://localhost:8545'
            const res = await fetch(rpcUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [args.hash] }),
            })
            const json = await res.json()
            if (!json.result) throw new Error(`sigilWorld txFrom: no transaction ${args.hash}`)
            return { ok: true, from: json.result.from, to: json.result.to, chainId: json.result.chainId }
          }
          case 'log':
            return { ok: true, requests: world ? [...world.daemon.state.requests] : [] }
          case 'stop':
            await stopWorld()
            return { ok: true }
          default:
            throw new Error(`sigilWorld: unknown action ${action}`)
        }
      } catch (e) {
        return { ok: false, error: String(e?.message || e) }
      }
    },
  }
}
