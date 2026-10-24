/**
 * Signal-driven config reload (spec 106 FR-014 as amended, #1446 / T032).
 *
 * Three properties carry the file:
 *
 *   1. THE ALLOWLIST IS THE BOUNDARY. Operational switches reload; fund-path configuration —
 *      keys, engine URLs, endpoints — does NOT, however it is spelled in the file. A key that
 *      could be swapped by editing a file and signalling is a key swapped by anyone who can
 *      write that file, silently.
 *
 *   2. A RELOAD ACTUALLY TAKES EFFECT, END TO END. The middleware reads its flags per request,
 *      so flipping IDENTITY_ENFORCE in the live config changes the NEXT request's behaviour with
 *      no restart. Without that, reload would be a silent no-op for the identity layer while
 *      /status truthfully reported the new value — the "disabled looks enforcing" split.
 *
 *   3. FAILURE IS LOUD AND HONEST. No source configured, or an unreadable file, says so — an
 *      operator acting during an incident must never be left believing a control landed when it
 *      did not.
 */
import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { applyReload, parseEnvFile, createReloadHandler } from '../../src/policy/reload.js'
import { createKillSwitch } from '../../src/policy/killswitch.js'
import { createIdentityMiddleware } from '../../src/identity/middleware.js'
import { testConfig } from '../helpers.js'

const freshConfig = (over = {}) => testConfig({ IDENTITY_ENABLED: 'true', ...over })

describe('applyReload — the allowlist', () => {
  it('flips an allowlisted switch and reports its NAME', () => {
    const config = freshConfig()
    const ks = createKillSwitch(false)
    const changed = applyReload(config, ks, { IDENTITY_ENFORCE: 'true' })
    expect(config.identity.enforce).toBe(true)
    expect(changed).toEqual(['IDENTITY_ENFORCE'])
  })

  it('reloads the global kill switch through its setter', () => {
    const config = freshConfig()
    const ks = createKillSwitch(false)
    applyReload(config, ks, { KILL_SWITCH: 'true' })
    expect(ks.isActive()).toBe(true)
  })

  it('treats an ABSENT key as "leave alone", never "reset to default"', () => {
    // The delivered env file may be partial. A missing line must not silently re-enable a
    // module an operator switched off at boot.
    const config = freshConfig({ IDENTITY_ENFORCE: 'true' })
    applyReload(config, createKillSwitch(false), { KILL_SWITCH: 'false' })
    expect(config.identity.enforce).toBe(true)
  })

  it('REFUSES to touch fund-path configuration, however the file spells it', () => {
    const config = freshConfig()
    const before = {
      engineUrl: config.engine.url,
      originSecret: config.originAuthSecret,
      opsSecret: config.opsStatusSecret,
      signingKey: config.rpcAccess.signingKeyPem,
    }
    const changed = applyReload(config, createKillSwitch(false), {
      ENGINE_URL: 'http://attacker.example',
      ORIGIN_AUTH_SECRET: 'attacker-secret',
      OPS_STATUS_SECRET: 'attacker-ops-secret', // #1505 — a reloadable disclosure secret is no secret
      RPC_ACCESS_SIGNING_KEY: 'attacker-key',
      RPC_URL_PRIMARY_137: 'http://attacker.example/rpc',
    })
    expect(changed).toEqual([])
    expect(config.engine.url).toBe(before.engineUrl)
    expect(config.originAuthSecret).toBe(before.originSecret)
    expect(config.opsStatusSecret).toBe(before.opsSecret)
    expect(config.rpcAccess.signingKeyPem).toBe(before.signingKey)
  })

  it('reloads an upstream ceiling — tightening a cap is exactly what a burst calls for', () => {
    const config = freshConfig()
    const changed = applyReload(config, createKillSwitch(false), { UPSTREAM_CEILING_OPENSEA: '25' })
    expect(config.identity.upstreamCeilings.opensea).toBe(25)
    expect(changed).toEqual(['UPSTREAM_CEILING_OPENSEA'])
  })

  it('reports nothing when nothing differs — a no-op reload must not read as a change', () => {
    const config = freshConfig()
    expect(applyReload(config, createKillSwitch(false), { IDENTITY_ENABLED: 'true' })).toEqual([])
  })
})

describe('the reload takes effect end to end — per-request flag reads', () => {
  it('turns enforcement ON for the NEXT request, no restart', async () => {
    const options = { enabled: true, enforce: false }
    const app = express()
    app.use(createIdentityMiddleware(options, []))
    app.post('/v1/polymarket/137/builder-sign', (_req, res) => res.json({ ok: true }))

    await request(app).post('/v1/polymarket/137/builder-sign').send({}).expect(200)
    options.enforce = true // what the SIGHUP handler's mutation amounts to
    await request(app).post('/v1/polymarket/137/builder-sign').send({}).expect(403)
  })

  it('turns the layer OFF for the next request, symmetrically', async () => {
    const options = { enabled: true, enforce: true }
    const app = express()
    app.use(createIdentityMiddleware(options, []))
    app.post('/v1/polymarket/137/builder-sign', (_req, res) => res.json({ ok: true }))

    await request(app).post('/v1/polymarket/137/builder-sign').send({}).expect(403)
    options.enabled = false
    await request(app).post('/v1/polymarket/137/builder-sign').send({}).expect(200)
  })
})

describe('createReloadHandler — honest failure', () => {
  it('says plainly that nothing reloaded when no source is configured', () => {
    const log = vi.fn()
    const handler = createReloadHandler(freshConfig(), createKillSwitch(false), { log })
    const out = handler()
    expect(out.reloaded).toBe(false)
    expect(log.mock.calls[0][0]).toMatch(/RELOAD_ENV_FILE is not set/)
  })

  it('reports a FAILED reload when the source cannot be read — never a silent success', () => {
    const log = vi.fn()
    const config = freshConfig({ RELOAD_ENV_FILE: '/run/fairwins/gateway.env' })
    const handler = createReloadHandler(config, createKillSwitch(false), {
      log,
      readFile: () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) },
    })
    expect(handler().reloaded).toBe(false)
    expect(log.mock.calls[0][0]).toMatch(/FAILED/)
  })

  it('applies the file and logs NAMES only — a value in this log line is config in the logs', () => {
    const log = vi.fn()
    const config = freshConfig({ RELOAD_ENV_FILE: '/run/fairwins/gateway.env' })
    const handler = createReloadHandler(config, createKillSwitch(false), {
      log,
      readFile: () => 'IDENTITY_ENFORCE=true\nRPC_ACCESS_KILLSWITCH="true"\n# comment\n',
    })
    const out = handler()
    expect(out).toEqual({ reloaded: true, changed: ['IDENTITY_ENFORCE', 'RPC_ACCESS_KILLSWITCH'] })
    expect(config.identity.enforce).toBe(true)
    expect(config.rpcAccess.killswitch).toBe(true)
    expect(log.mock.calls[0][0]).not.toContain('true') // names, never values
  })
})

describe('parseEnvFile', () => {
  it('parses the delivered format: comments, quotes, blank lines', () => {
    expect(parseEnvFile('# c\nA=1\nB="two"\nC=\'three\'\n\nnoequals\n=novalue\n')).toEqual({
      A: '1',
      B: 'two',
      C: 'three',
    })
  })

  it('keeps an = inside a value intact — tokens contain them', () => {
    expect(parseEnvFile('KEY=abc=def==')).toEqual({ KEY: 'abc=def==' })
  })
})
