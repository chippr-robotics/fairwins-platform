import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, loadOrCreateToken, DEFAULT_PORT } from '../src/main.js'

const env = { XDG_RUNTIME_DIR: '/run/user/1000', HOME: '/home/member' }

test('defaults bind loopback on the default port and read the daemon socket from XDG_RUNTIME_DIR', () => {
  const opts = parseArgs(['--allow-origin', 'https://app.fairwins.example'], env)
  assert.equal(opts.host, '127.0.0.1')
  assert.equal(opts.port, DEFAULT_PORT)
  assert.equal(opts.socket, '/run/user/1000/sigil.sock')
  assert.equal(opts.tokenFile, '/run/user/1000/sigil-bridge.token')
  assert.deepEqual(opts.origins, ['https://app.fairwins.example'])
})

test('origins also come from SIGIL_BRIDGE_ORIGINS', () => {
  const opts = parseArgs([], { ...env, SIGIL_BRIDGE_ORIGINS: 'https://a.example, http://localhost:5173' })
  assert.deepEqual(opts.origins, ['https://a.example', 'http://localhost:5173'])
})

test('a wildcard or malformed origin is refused', () => {
  assert.throws(() => parseArgs(['--allow-origin', '*'], env))
  assert.throws(() => parseArgs(['--allow-origin', 'not a url'], env), /valid origin/)
})

test('binding beyond loopback needs an explicit flag', () => {
  assert.throws(() => parseArgs(['--allow-origin', 'https://a.example', '--host', '0.0.0.0'], env), /allow-non-loopback/)
  const opts = parseArgs(['--allow-origin', 'https://a.example', '--host', '0.0.0.0', '--allow-non-loopback'], env)
  assert.equal(opts.host, '0.0.0.0')
})

test('an unknown flag is an error, not ignored', () => {
  assert.throws(() => parseArgs(['--import-agent-shard'], env), /Unknown option/)
})

test('the token file is minted 0600 once and reused after', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-bridge-'))
  try {
    const file = path.join(dir, 'nested', 'token')
    const first = loadOrCreateToken(file)
    assert.equal(first.created, true)
    assert.match(first.token, /^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const second = loadOrCreateToken(file)
    assert.equal(second.created, false)
    assert.equal(second.token, first.token)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a token file readable by others is refused', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigil-bridge-'))
  try {
    const file = path.join(dir, 'token')
    fs.writeFileSync(file, 'f'.repeat(64), { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    assert.throws(() => loadOrCreateToken(file), /chmod 600/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
