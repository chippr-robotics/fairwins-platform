/**
 * /v1/member/* member API tests (spec 095).
 *
 * Same build-the-app-with-injected-deps pattern as perps.test.js and polymarket.test.js: real
 * `loadConfig` against the real deployments/ records, mocked providers and upstreams, every request
 * carrying X-Origin-Auth. Tokens are signed for real with an `ethers.Wallet` against the real
 * `@fairwins/intent-types` tables — a hand-rolled fixture would only prove the gateway agrees with
 * this file.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { ethers } from 'ethers'
import { createApp } from '../src/server.js'
import { createKillSwitch } from '../src/policy/killswitch.js'
import { testConfig, mockEngine, wallet, ORIGIN_SECRET, TEST_NOW } from './helpers.js'
import { ALL_SCOPES_V1, KEY_ID, MEMBER_API_ENV, memberApiProviders, memberToken, revocationBody } from './memberApiHelpers.js'
import { declaredPaths } from '../src/memberApi/routes.js'
import { buildOpenApiDocument, documentedPaths } from '../src/memberApi/openapi.js'

const SUBGRAPH_137 = 'https://subgraph.test.invalid/fairwins-polygon'

/** One wager row in the shape the real subgraph serves (strings for BigInt fields). */
const SUBGRAPH_WAGER = {
  id: '42',
  status: 'active',
  resolutionType: 1,
  creator: wallet.address.toLowerCase(),
  opponent: '0x0000000000000000000000000000000000000002',
  token: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  creatorStake: '1000000',
  opponentStake: '1000000',
  winner: null,
  createdAt: '1799000000',
  resolvedAt: null,
  metadataUri: 'ipfs://bafy',
  metadataHash: '0x' + 'ab'.repeat(32),
}

const ASSISTANT_OK = {
  content: [{ type: 'text', text: 'Wagers live under Transfer. Check /wallet?tab=pay.' }],
  model: 'claude-sonnet-5',
  usage: { input_tokens: 120, output_tokens: 30 },
  stop_reason: 'end_turn',
}

/**
 * One injectable fetch serving both member-API upstreams, routed by URL. `overrides` lets a test
 * make exactly one of them fail — a subgraph outage must not look like an assistant outage.
 */
function mockMemberFetch({ subgraph = { data: { wagers: [SUBGRAPH_WAGER] } }, subgraphFails = false, assistant = ASSISTANT_OK, assistantStatus = 200, assistantThrows = false } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('subgraph')) {
      if (subgraphFails) throw new Error('network down')
      return { ok: true, status: 200, json: async () => subgraph }
    }
    if (assistantThrows) throw new Error('network down')
    return { ok: assistantStatus < 400, status: assistantStatus, json: async () => assistant }
  }
  impl.calls = calls
  return impl
}

function build({ env = {}, providerOpts = {}, providers, killSwitch = createKillSwitch(false), memberApiFetch = mockMemberFetch(), auditLines = [] } = {}) {
  const config = testConfig({ ...MEMBER_API_ENV, ...env })
  // Exercise the env-fallback fee path; the on-chain path is covered in fees.test.js.
  config.feeRouter = { ...config.feeRouter, address: null }
  const { app } = createApp(config, {
    providers: providers ?? memberApiProviders(config, providerOpts),
    engineClient: mockEngine(),
    now: () => TEST_NOW,
    killSwitch,
    auditSink: (line) => auditLines.push(line),
    memberApiFetch,
  })
  return { app, config, memberApiFetch, auditLines }
}

const get = (app, path) => request(app).get(path).set('X-Origin-Auth', ORIGIN_SECRET)
const post = (app, path) => request(app).post(path).set('X-Origin-Auth', ORIGIN_SECRET)
const auth = (req, token) => req.set('Authorization', `Bearer ${token}`)

// ---- module gating ------------------------------------------------------------------------------

describe('member API module gating', () => {
  it('403s without the edge header, like every other client route', async () => {
    const { app } = build()
    const res = await request(app).get('/v1/member/openapi.json')
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: { code: 'origin_denied', reason: expect.any(String) } })
  })

  it('answers 503 member_api_unconfigured when disabled — a code, never a bare 404', async () => {
    const { app } = build({ env: { MEMBER_API_ENABLED: 'false' } })
    for (const path of ['/v1/member/openapi.json', '/v1/member/me']) {
      const res = await get(app, path)
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('member_api_unconfigured')
    }
  })

  it('answers member_api_killed under the MODULE killswitch, before the global one', async () => {
    const { app } = build({ env: { MEMBER_API_KILLSWITCH: 'true' }, killSwitch: createKillSwitch(true) })
    const res = await get(app, '/v1/member/openapi.json')
    expect(res.status).toBe(503)
    // Module first: an operator who killed this module wants to see THAT, not the global switch.
    expect(res.body.error.code).toBe('member_api_killed')
  })

  it('answers killswitch_active under the global killswitch alone', async () => {
    const { app } = build({ killSwitch: createKillSwitch(true) })
    const res = await get(app, '/v1/member/openapi.json')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('killswitch_active')
  })
})

// ---- the OpenAPI document, and the drift it cannot have -----------------------------------------

describe('GET /v1/member/openapi.json', () => {
  it('serves a 3.1 document without a credential', async () => {
    const { app } = build()
    const res = await get(app, '/v1/member/openapi.json')
    expect(res.status).toBe(200)
    expect(res.body.openapi).toBe('3.1.0')
    expect(res.body.info.title).toBe('FairWins Member API')
    expect(res.body.components.securitySchemes.memberToken.scheme).toBe('bearer')
    expect(res.body.components.securitySchemes.memberToken.bearerFormat).toBe('fw1')
  })

  it('documents exactly the routes the router mounts', async () => {
    // THE ANTI-DRIFT ASSERTION. A documented endpoint the gateway does not serve fails at a
    // member's request instead of at review, which is why this is machine-checked rather than
    // maintained by hand.
    const { config } = build()
    const doc = buildOpenApiDocument(config)
    expect(documentedPaths(doc)).toEqual(declaredPaths())
  })

  it('serves every documented path — none of them 404s', async () => {
    const { app } = build()
    for (const entry of declaredPaths()) {
      const [method, path] = entry.split(' ')
      const res = await request(app)[method.toLowerCase()](path).set('X-Origin-Auth', ORIGIN_SECRET)
      expect(res.status, `${entry} is documented but not served`).not.toBe(404)
    }
  })

  it('names this gateway’s own chains, scopes and refusals rather than a generic API', async () => {
    const { app, config } = build()
    const res = await get(app, '/v1/member/openapi.json')
    expect(res.body.info.description).toContain(`Membership reference chain: ${config.memberApi.referenceChainId}`)
    // Every scope is described in the security scheme, so an agent knows what to ask a member for.
    for (const scope of ALL_SCOPES_V1) {
      expect(res.body.components.securitySchemes.memberToken.description).toContain(scope)
    }
    // A deliberately-refused action is DOCUMENTED, not hidden — otherwise an agent concludes the
    // platform has no cancel path at all.
    expect(res.body.info.description).toContain('invalidateNonce')
  })

  it('models both honest-state envelopes, so a failed read has no shape that reads as empty', async () => {
    const { app } = build()
    const res = await get(app, '/v1/member/openapi.json')
    expect(res.body.components.schemas.ChainWagerResult.properties.state.enum).toEqual(['read', 'not-configured', 'unreadable'])
    expect(res.body.components.schemas.MembershipRead.properties.state.enum).toEqual(['read', 'not-configured', 'unreadable'])
    expect(res.body.components.schemas.RevocationState.properties.durable.const).toBe(false)
  })
})

// ---- /me ----------------------------------------------------------------------------------------

describe('GET /v1/member/me', () => {
  it('introspects the token, the membership behind it, and the revocation state', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await auth(get(app, '/v1/member/me'), token)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      account: wallet.address,
      keyId: KEY_ID,
      label: 'test key',
      scopes: ALL_SCOPES_V1,
      revocation: { revoked: false, durable: false },
    })
    expect(res.body.membership).toMatchObject({ state: 'read', tier: 3, tierName: 'Gold', active: true })
    expect(res.body.membership.chainId).toBe(137)
  })

  it('never echoes the token itself back', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await auth(get(app, '/v1/member/me'), token)
    expect(JSON.stringify(res.body)).not.toContain(token)
    expect(JSON.stringify(res.body)).not.toContain('fw1.')
  })
})

// ---- revocation ---------------------------------------------------------------------------------

describe('POST /v1/member/keys/revoke', () => {
  it('accepts a member-signed revocation with NO bearer token, and says durable:false out loud', async () => {
    const { app } = build()
    const body = await revocationBody()
    const res = await post(app, '/v1/member/keys/revoke').send(body)
    expect(res.status).toBe(200)
    expect(res.body.revoked).toBe(true)
    expect(res.body.durable).toBe(false)
    // The honesty is in the RESPONSE, not only in a comment: a member must be able to act on it.
    expect(res.body.reason).toMatch(/restart/i)
    expect(res.body.reason).toMatch(/expir/i)
  })

  it('makes the revoked key stop working, and reports it via keys/status', async () => {
    const { app } = build()
    const token = await memberToken()
    expect((await auth(get(app, '/v1/member/me'), token)).status).toBe(200)

    await post(app, '/v1/member/keys/revoke').send(await revocationBody())

    const after = await auth(get(app, '/v1/member/me'), token)
    expect(after.status).toBe(401)
    expect(after.body.error.code).toBe('token_revoked')

    // A DIFFERENT key of the same account still works, and can read the revoked one's status.
    const other = await memberToken({ keyId: '0x' + '22'.repeat(32) })
    const status = await auth(get(app, `/v1/member/keys/status?keyId=${KEY_ID}`), other)
    expect(status.status).toBe(200)
    expect(status.body).toMatchObject({ account: wallet.address, keyId: KEY_ID, revoked: true, durable: false })
  })

  it('refuses a revocation not signed by the account it names', async () => {
    const { app } = build()
    const impostor = new ethers.Wallet('0x' + '7'.repeat(63) + '1')
    const body = await revocationBody({ signer: impostor, account: wallet.address })
    const res = await post(app, '/v1/member/keys/revoke').send(body)
    expect(res.status).toBe(401)
    // `invalid_signature`, not `invalid_token`: the body parsed and the account was asked.
    expect(res.body.error.code).toBe('invalid_signature')
  })

  it('rejects a malformed revocation body with 400, not 500', async () => {
    const { app } = build()
    const res = await post(app, '/v1/member/keys/revoke').send({ revocation: { account: 'nope' }, signature: '0x00' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('refuses a revokedAt in the future rather than clamping it', async () => {
    // revokedAt decides how long the in-process record is kept, so an arbitrary future value would
    // let one request pin a record open past every pruning window.
    const { app } = build()
    const body = await revocationBody({ revokedAt: TEST_NOW + 86_400 })
    const res = await post(app, '/v1/member/keys/revoke').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('never answers about another account’s key', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await auth(
      get(app, `/v1/member/keys/status?keyId=${KEY_ID}&account=0x0000000000000000000000000000000000000009`),
      token
    )
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('insufficient_scope')
  })
})

// ---- scopes -------------------------------------------------------------------------------------

describe('scope enforcement', () => {
  it('403s insufficient_scope when the grant omits the endpoint’s scope', async () => {
    const { app } = build()
    const token = await memberToken({ scopes: ['read:profile'] })
    const res = await auth(get(app, '/v1/member/wagers'), token)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('insufficient_scope')
    expect(res.body.error.reason).toContain('read:wagers')
  })

  it('refuses a grant naming a scope this gateway does not serve', async () => {
    // Silently dropping it would hand back a token narrower than the member was shown.
    const { app } = build()
    const token = await memberToken({ scopes: ['read:profile', 'write:everything'] })
    const res = await auth(get(app, '/v1/member/me'), token)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('invalid_token')
    expect(res.body.error.reason).toContain('write:everything')
  })
})

// ---- wagers -------------------------------------------------------------------------------------

describe('GET /v1/member/wagers', () => {
  it('reports not-configured for a chain with no indexer — never an empty list', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await auth(get(app, '/v1/member/wagers'), token)
    expect(res.status).toBe(200)
    for (const entry of Object.values(res.body.chains)) {
      expect(entry.state).toBe('not-configured')
      expect(entry).not.toHaveProperty('wagers')
    }
    // Everything missing is NAMED, so a caller aggregating knows the total is incomplete.
    expect(res.body.partial.sort()).toEqual(['137', '63', '80002'])
    expect(res.body.asOf).toBe(new Date(TEST_NOW * 1000).toISOString())
  })

  it('reads a configured chain and leaves the others honestly absent', async () => {
    const { app } = build({ env: { MEMBER_API_SUBGRAPH_137: SUBGRAPH_137 } })
    const token = await memberToken()
    const res = await auth(get(app, '/v1/member/wagers'), token)
    expect(res.status).toBe(200)
    expect(res.body.chains['137']).toMatchObject({ chainId: 137, state: 'read' })
    expect(res.body.chains['137'].wagers).toHaveLength(1)
    expect(res.body.chains['137'].wagers[0]).toMatchObject({
      id: '42',
      chainId: 137,
      status: 'active',
      // Stakes stay decimal STRINGS — token base units exceed the exact-integer JSON range.
      creatorStake: '1000000',
      winner: null,
    })
    expect(res.body.chains['80002'].state).toBe('not-configured')
    expect(res.body.partial).toEqual(['80002', '63'])
  })

  it('reports unreadable — not an empty list — when the indexer fails', async () => {
    const { app } = build({ env: { MEMBER_API_SUBGRAPH_137: SUBGRAPH_137 }, memberApiFetch: mockMemberFetch({ subgraphFails: true }) })
    const token = await memberToken()
    const res = await auth(get(app, '/v1/member/wagers'), token)
    expect(res.body.chains['137'].state).toBe('unreadable')
    expect(res.body.chains['137']).not.toHaveProperty('wagers')
    expect(res.body.chains['137'].reason).toBeTruthy()
  })

  it('treats a GraphQL error payload as unreadable, not as no wagers', async () => {
    const { app } = build({
      env: { MEMBER_API_SUBGRAPH_137: SUBGRAPH_137 },
      memberApiFetch: mockMemberFetch({ subgraph: { errors: [{ message: 'bad field' }] } }),
    })
    const token = await memberToken()
    const res = await auth(get(app, '/v1/member/wagers'), token)
    expect(res.body.chains['137'].state).toBe('unreadable')
    expect(res.body.chains['137'].reason).toContain('bad field')
  })

  it('scopes the query to ONE chain when asked, and 404s an unenabled one', async () => {
    const { app, memberApiFetch } = build({ env: { MEMBER_API_SUBGRAPH_137: SUBGRAPH_137 } })
    const token = await memberToken()
    const ok = await auth(get(app, '/v1/member/wagers?chainId=137'), token)
    expect(Object.keys(ok.body.chains)).toEqual(['137'])
    expect(ok.body.partial).toBeNull()
    // The account, lowercased, is what the query binds to — never a client-supplied owner.
    const body = JSON.parse(memberApiFetch.calls.at(-1).init.body)
    expect(body.variables.owner).toBe(wallet.address.toLowerCase())

    // A chain outside this cohort is refused, never answered `not-configured` — that state means
    // "enabled here, no indexer", and reusing it would blur two different facts.
    const nope = await auth(get(app, '/v1/member/wagers?chainId=999'), token)
    expect(nope.status).toBe(400)
    expect(nope.body.error.code).toBe('bad_request')
  })

  it('rejects an out-of-range page size rather than silently clamping it', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await auth(get(app, '/v1/member/wagers?first=5000'), token)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })
})

// ---- fees ---------------------------------------------------------------------------------------

describe('GET /v1/member/fees', () => {
  it('serves the gateway’s existing fee reader, labelling where each rate came from', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await auth(get(app, '/v1/member/fees'), token)
    expect(res.status).toBe(200)
    expect(res.body.feeRouter).toEqual({ address: null, chainId: 137 })
    // capBps comes from the same constants the reader clamps against — never a literal here.
    expect(res.body.services['polymarket.taker']).toEqual({ bps: 50, capBps: 100, source: 'env-fallback' })
    expect(res.body.services['polymarket.maker']).toEqual({ bps: 0, capBps: 50, source: 'env-fallback' })
    expect(res.body.services['perps.hyperliquid.builder']).toEqual({ bps: 0, capBps: 10, source: 'env-fallback' })
    expect(res.body.asOf).toBe(new Date(TEST_NOW * 1000).toISOString())
  })
})

// ---- intents/build ------------------------------------------------------------------------------

describe('POST /v1/member/intents/build', () => {
  it('builds typed data and FORCES the actor to the token’s account', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await auth(post(app, '/v1/member/intents/build'), token).send({
      action: 'claimPayout',
      chainId: 137,
      // A caller trying to act for somebody else. It must not survive.
      params: { wagerId: 7, claimant: '0x0000000000000000000000000000000000000009', nonce: '0x' + '01'.repeat(32), validBefore: TEST_NOW + 3600 },
    })
    expect(res.status).toBe(200)
    expect(res.body.typedData.primaryType).toBe('ClaimPayoutIntent')
    expect(res.body.typedData.message.claimant).toBe(wallet.address)
    expect(res.body.typedData.domain).toMatchObject({ name: 'FairWins WagerRegistry', version: '1', chainId: 137 })
    expect(res.body.actorField).toBe('claimant')
    expect(res.body.submitVia.relay).toBe('/v1/intents')
    // The self-submit path is always offered — a relay outage is never "action unavailable".
    expect(res.body.submitVia.selfSubmit).toMatch(/self-submit|own wallet/i)
  })

  it('refuses invalidateNonce with a documented reason rather than a silent omission', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await auth(post(app, '/v1/member/intents/build'), token).send({ action: 'invalidateNonce', chainId: 137 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('unsupported_action')
    expect(res.body.error.reason).toMatch(/direct contract write/i)
  })

  it('returns the EIP-3009 shape for poolJoin instead of inventing a struct', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await auth(post(app, '/v1/member/intents/build'), token).send({
      action: 'poolJoin',
      chainId: 137,
      params: { pool: '0x1111111111111111111111111111111111111111', value: '1000000', validBefore: TEST_NOW + 3600, nonce: '0x' + '02'.repeat(32) },
    })
    expect(res.status).toBe(200)
    expect(res.body.authOnly).toBe(true)
    expect(res.body.typedData.primaryType).toBe('ReceiveWithAuthorization')
    expect(res.body.typedData.message.from).toBe(wallet.address)
    // The money binds to the CLONE, not the factory — the token enforces `to == msg.sender`.
    expect(res.body.typedData.message.to).toBe('0x1111111111111111111111111111111111111111')
    expect(res.body.target).not.toBe(res.body.typedData.message.to)
  })

  it('names missing params instead of emitting a half-built struct', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await auth(post(app, '/v1/member/intents/build'), token).send({ action: 'claimPayout', chainId: 137, params: {} })
    expect(res.status).toBe(400)
    expect(res.body.error.reason).toContain('wagerId')
  })

  it('404s an action whose contract is not recorded on the asked chain', async () => {
    const { app } = build()
    const token = await memberToken()
    // callsignRegistry is not in the gateway's pinned target set on any chain.
    const res = await auth(post(app, '/v1/member/intents/build'), token).send({ action: 'callsignCommit', chainId: 137, params: { commitment: '0x' + '03'.repeat(32) } })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('unsupported_action')
    // Refused HERE, naming both, rather than handing back a payload the relay would reject.
    expect(res.body.error.reason).toContain('callsignRegistry')
    expect(res.body.error.reason).toContain('137')
  })

  it('400s an unknown action', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await auth(post(app, '/v1/member/intents/build'), token).send({ action: 'drainTreasury', chainId: 137 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('unsupported_action')
  })
})

// ---- assistant ----------------------------------------------------------------------------------

describe('POST /v1/member/assistant/chat', () => {
  const ask = (app, token, body) => auth(post(app, '/v1/member/assistant/chat'), token).send(body)

  it('503s assistant_unconfigured when the assistant is off', async () => {
    const { app } = build()
    const token = await memberToken()
    const res = await ask(app, token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('assistant_unconfigured')
  })

  it('503s assistant_unconfigured when enabled but the credential is unset', async () => {
    // A missing optional credential fails THAT route closed; it must never fail the boot.
    const { app } = build({ env: { ASSISTANT_ENABLED: 'true' } })
    const token = await memberToken()
    const res = await ask(app, token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('assistant_unconfigured')
  })

  it('answers, reports usage counts, and sends a server-side system prompt the member cannot replace', async () => {
    const memberApiFetch = mockMemberFetch()
    const { app } = build({ env: { ASSISTANT_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' }, memberApiFetch })
    const token = await memberToken()
    const res = await ask(app, token, { messages: [{ role: 'user', content: 'where are my wagers?' }], surface: 'wallet/earn' })
    expect(res.status).toBe(200)
    expect(res.body.reply).toContain('/wallet?tab=pay')
    expect(res.body.model).toBe('claude-sonnet-5')
    expect(res.body.usage).toEqual({ inputTokens: 120, outputTokens: 30 })

    const sent = JSON.parse(memberApiFetch.calls.at(-1).init.body)
    expect(sent.model).toBe('claude-sonnet-5')
    // Spec 104: the surface rides as a SEPARATE trailing text block on the last user message, so
    // the system prompt stays byte-identical across turns (it is the cache prefix).
    expect(sent.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'where are my wagers?' },
          { type: 'text', text: '[Context: the member is currently on wallet/earn]' },
        ],
      },
    ])
    // The rules that stop the assistant claiming it acted are SERVER-SIDE.
    expect(sent.system).toMatch(/You have NOT performed any action/)
    expect(sent.system).toMatch(/Never ask for, accept, or repeat a private key/)
    expect(sent.system).not.toContain('wallet/earn')
    // ...and the tool table is the gateway's, attached server-side (assistantTools.test.js has the detail).
    expect(Array.isArray(sent.tools)).toBe(true)
    expect(sent.tool_choice).toEqual({ type: 'auto' })
    expect(res.body.stopReason).toBe('end_turn')
    expect(res.body.content).toEqual([{ type: 'text', text: 'Wagers live under Transfer. Check /wallet?tab=pay.' }])
  })

  it('never lets message content reach the audit log', async () => {
    const auditLines = []
    const { app } = build({ env: { ASSISTANT_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' }, auditLines })
    const token = await memberToken()
    const secret = 'my very identifiable question about a wager'
    await ask(app, token, { messages: [{ role: 'user', content: secret }] })
    const joined = auditLines.join('\n')
    expect(joined).toContain('member_api_assistant_chat')
    expect(joined).toContain('"messageCount":1')
    expect(joined).not.toContain(secret)
    // Nor the reply, nor any part of the token.
    expect(joined).not.toContain('/wallet?tab=pay')
    expect(joined).not.toContain('fw1.')
  })

  it('caps size before anything is sent upstream', async () => {
    const memberApiFetch = mockMemberFetch()
    const { app } = build({ env: { ASSISTANT_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' }, memberApiFetch })
    const token = await memberToken()

    const tooMany = await ask(app, token, { messages: Array.from({ length: 21 }, () => ({ role: 'user', content: 'hi' })) })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.error.code).toBe('bad_request')

    const tooLong = await ask(app, token, { messages: [{ role: 'user', content: 'x'.repeat(4001) }] })
    expect(tooLong.status).toBe(400)

    const wrongOrder = await ask(app, token, { messages: [{ role: 'assistant', content: 'hi' }] })
    expect(wrongOrder.status).toBe(400)

    // Not one of them cost an upstream call.
    expect(memberApiFetch.calls).toHaveLength(0)
  })

  it('reports an upstream outage honestly instead of inventing a reply', async () => {
    const { app } = build({
      env: { ASSISTANT_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' },
      memberApiFetch: mockMemberFetch({ assistantThrows: true }),
    })
    const token = await memberToken()
    const res = await ask(app, token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('assistant_unavailable')
    expect(res.body).not.toHaveProperty('reply')
  })

  it('treats an empty or declined answer as unavailable, never as a blank reply', async () => {
    const { app } = build({
      env: { ASSISTANT_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test' },
      memberApiFetch: mockMemberFetch({ assistant: { content: [], stop_reason: 'refusal' } }),
    })
    const token = await memberToken()
    const res = await ask(app, token, { messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('assistant_unavailable')
  })
})

// ---- /status ------------------------------------------------------------------------------------

describe('/status member API block', () => {
  it('reports module state, wager chains and assistant configuration — no member data', async () => {
    const { app } = build({ env: { MEMBER_API_SUBGRAPH_137: SUBGRAPH_137 } })
    const res = await request(app).get('/status')
    expect(res.status).toBe(200)
    expect(res.body.memberApi).toEqual({
      enabled: true,
      killSwitch: false,
      assistant: { configured: false, maxRounds: 4 },
      // Spec 096 added a public-config-only x402 block. Off here, and `network: null` says so —
      // the configured prices stay visible so an operator can read what WOULD be charged.
      x402: { enabled: false, killSwitch: false, network: null, priced: { read: '10000', build: '50000', assistant: '100000' } },
    })
  })

  it('reports enabled:false under either killswitch (honest liveness)', async () => {
    const killed = build({ env: { MEMBER_API_KILLSWITCH: 'true' } })
    expect((await request(killed.app).get('/status')).body.memberApi.enabled).toBe(false)
    const global = build({ killSwitch: createKillSwitch(true) })
    expect((await request(global.app).get('/status')).body.memberApi.enabled).toBe(false)
  })

  it('leaves every existing /status field in place', async () => {
    const { app } = build()
    const res = await request(app).get('/status')
    expect(res.body).toHaveProperty('status', 'ok')
    expect(res.body).toHaveProperty('build')
    expect(res.body).toHaveProperty('chains')
    expect(res.body).toHaveProperty('killSwitch')
    expect(res.body).toHaveProperty('fees')
    expect(res.body).toHaveProperty('perps')
  })
})

// ---- CORS ---------------------------------------------------------------------------------------

describe('CORS', () => {
  it('allows Authorization alongside Content-Type, so a browser can send a bearer token', async () => {
    const { app } = build({ env: { ALLOWED_ORIGINS: 'https://fairwins.app' } })
    const res = await request(app).options('/v1/member/me').set('Origin', 'https://fairwins.app')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type, Authorization')
    // Nothing else about the posture moved: no credentials mode, allow-list unchanged.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
    expect(res.headers['access-control-allow-origin']).toBe('https://fairwins.app')
  })

  it('still sends no CORS headers to an origin that is not allow-listed', async () => {
    const { app } = build({ env: { ALLOWED_ORIGINS: 'https://fairwins.app' } })
    const res = await request(app).get('/status').set('Origin', 'https://evil.test')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['access-control-allow-headers']).toBeUndefined()
  })
})
