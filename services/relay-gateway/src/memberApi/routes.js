/**
 * Member API routes — /v1/member/* (spec 095).
 *
 * Contract: specs/095-member-api-agentic-access/contracts/member-api.md, and the OpenAPI document
 * this module itself serves at /v1/member/openapi.json.
 *
 * Structured exactly like src/perps/routes.js: module killswitch -> global killswitch -> enabled
 * check -> per-route auth -> handler, with the gateway-wide nested `{ error: { code, reason } }`
 * body. Paths come from `contract.js`'s ROUTES, which `openapi.js` also reads, so the served
 * specification and the mounted server cannot drift.
 *
 * WHAT THIS MODULE CAN AND CANNOT DO. Every route here is a READ, a QUOTE, or the registration of a
 * member-signed revocation. There is no route that moves value and no credential in the process
 * that could: a capability token authorises the gateway to ANSWER QUESTIONS about a member, never
 * to act as one. Relaying a signed intent stays where it already was — the public `POST /v1/intents`
 * — because that pipeline recovers the signer itself, and duplicating it here would mean two places
 * deciding what a signature authorises.
 *
 * OPTIONAL INFRASTRUCTURE. Off unless MEMBER_API_ENABLED=true, and off means 503
 * `member_api_unconfigured` on every route including the OpenAPI document, so a client can tell
 * "the operator turned it off" from "this gateway is too old to have it". The router is mounted
 * unconditionally for exactly that reason.
 */
import express from 'express'
import { GatewayError } from '../errors.js'
import {
  MAKER_CAP_BPS as POLYMARKET_MAKER_CAP_BPS,
  PERPS_HL_BUILDER_CAP_BPS,
  TAKER_CAP_BPS as POLYMARKET_TAKER_CAP_BPS,
} from '../fees/onchain.js'
import { PaymentRequiredError } from '../x402/requirements.js'
import { x402Status } from '../x402/paywall.js'
import { ERROR_CODES, ROUTES, SCOPES, routeOf } from './contract.js'
import { verifyRevocation } from './auth.js'
import { buildIntent } from './intents.js'
import { estimateTurnTokens, parseChatRequest } from './assistant.js'
import { buildOpenApiDocument } from './openapi.js'
import { selectTools, toolsForMessages } from '@fairwins/assistant-contract/tools'

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const DEFAULT_PAGE = 50
const MAX_PAGE = 200

/**
 * @param {object} config full gateway config (only .memberApi, .chains and .feeRouter are read)
 * @param {{
 *   auth: {authenticate: Function, referenceChainId: number},
 *   revocations: {revoke: Function, isRevoked: Function, durable: boolean},
 *   wagerReader: {read: Function},
 *   assistant: {chat: Function, configured: boolean},
 *   providers: Record<number, object>,
 *   quotas: {hit: Function},              // authenticated traffic, keyed by the recovered account
 *   publicQuotas: {hit: Function},        // unauthenticated traffic — its OWN window (see guardPublic)
 *   revokeQuotas: {hit: Function},        // POST /keys/revoke alone — its OWN window again
 *   assistantQuotas: {hit: Function},     // model CALLS, a tighter class than the general reads
 *   assistantBudget: {reserve: Function}, // model TOKENS — the ceiling on money rather than traffic
 *   killSwitch: {isActive: () => boolean},
 *   paywall: {offers: Function, settleOrChallenge: Function},   // spec 096; see guard() below
 *   feeRates?: object|null,
 *   audit?: (fields: object) => void,
 *   now?: () => number,   // unix SECONDS, matching the gateway-wide clock
 * }} deps
 *
 * There is deliberately no `membership` dep here: the authenticator has already performed that read
 * to decide whether the token is usable at all, and it hands the result back. A second read would
 * be a second chain call for a fact just established — and, worse, one that could disagree with the
 * one the request was admitted on.
 */
export function createMemberApiRouter(config, {
  auth,
  revocations,
  wagerReader,
  assistant,
  providers,
  quotas,
  publicQuotas,
  revokeQuotas,
  assistantQuotas,
  assistantBudget,
  killSwitch,
  paywall,
  feeRates = null,
  audit = () => {},
  now = () => Math.floor(Date.now() / 1000),
}) {
  const memberApi = config.memberApi
  const router = express.Router()

  // The separate windows are not optional plumbing — a missing one would silently reunite the
  // buckets this module exists to keep apart (and a missing budget would remove the only ceiling on
  // model spend), so it fails the BOOT rather than a member's request. Same reasoning as the
  // paywall check below.
  for (const [name, dep] of [
    ['publicQuotas', publicQuotas],
    ['revokeQuotas', revokeQuotas],
    ['assistantQuotas', assistantQuotas],
  ]) {
    if (!dep || typeof dep.hit !== 'function') {
      throw new Error(`[relay-gateway] member API requires a \`${name}\` quota instance of its own (see src/policy/quotas.js)`)
    }
  }
  if (!assistantBudget || typeof assistantBudget.reserve !== 'function') {
    throw new Error('[relay-gateway] member API requires an `assistantBudget` (see createTokenBudget in src/policy/quotas.js)')
  }

  // The paid rail's seam is required even when x402 is switched off — off means `offers()` answers
  // false, which is a decision this module must be able to ASK for. A missing dep would surface as a
  // TypeError inside a request handler and be laundered into a generic 503, so it fails the BOOT.
  if (!paywall || typeof paywall.offers !== 'function' || typeof paywall.settleOrChallenge !== 'function') {
    throw new Error('[relay-gateway] member API requires an x402 paywall dep (see src/x402/paywall.js)')
  }

  /**
   * Mount one route BY ITS CONTRACT ID, so the method and the path can only ever come from
   * `contract.js` — the same array `openapi.js` documents. A route's path cannot be typed here at
   * all, which is what makes the specification and the server unable to disagree; the completeness
   * check at the bottom of this factory turns a forgotten route into a BOOT failure rather than a
   * 404 a member finds.
   */
  const mounted = new Set()
  const mount = (id, handler) => {
    const r = routeOf(id)
    mounted.add(`${r.method.toUpperCase()} ${r.path}`)
    router[r.method](r.path, handler)
  }

  function requireLive() {
    // Module killswitch first (the bitcoin/bridge/perps convention), then the global one.
    if (memberApi.killSwitch) {
      throw new GatewayError(503, 'member_api_killed', 'the member API is temporarily disabled; try again later')
    }
    if (killSwitch.isActive()) {
      throw new GatewayError(503, 'killswitch_active', 'the gateway is temporarily disabled; try again later')
    }
    if (!memberApi.enabled) {
      throw new GatewayError(503, 'member_api_unconfigured', 'the member API is not enabled on this gateway')
    }
  }

  /**
   * Unauthenticated guard, for the two routes that carry no bearer token.
   *
   * THE BUCKET IS AN ARGUMENT, AND THAT IS THE WHOLE FIX. Quotas here can only key on caller IP —
   * there is no signature to recover an identity from yet — and `req.ip` is the nginx proxy on the
   * VM deployment, because `trust proxy` is deliberately unset (setting it would re-key every
   * IP-scoped quota across this estate, which is a far larger change than this problem warrants).
   * So every anonymous caller shares one key, and that key must therefore draw from a window that
   * is ITS OWN. It previously drew from the same instance as the members' — which meant the global
   * counter was shared, and roughly 600 unauthenticated requests a minute would answer 429
   * `quota_exceeded` to every authenticated member on every route of this module.
   *
   * @param {import('express').Request} req
   * @param {{hit: Function}} bucket the window this route draws from — never the authenticated one
   */
  function guardPublic(req, bucket) {
    requireLive()
    const q = bucket.hit(`ip:${req.ip ?? 'unknown'}`)
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} member API quota exceeded`, { retryAfterSec: q.retryAfterSec })
    }
  }

  /**
   * Verdicts on a presented token that the x402 paid rail may STAND IN FOR (spec 096).
   *
   * The set is deliberately narrow, and what is missing matters more than what is here:
   *   · every 503 is absent — `auth_unverifiable`, `membership_unreadable`, `screening_unavailable`
   *     all mean a fact could NOT BE ESTABLISHED. Answering 402 there would invite an agent to pay
   *     because our RPC was slow, which is charging for our own outage.
   *   · `sanctioned_signer` is absent — there is no amount that makes a screened-out account
   *     servable, and offering one would be an offer to sell exactly the thing screening refuses.
   *   · `insufficient_scope` is absent — that caller HAS a working key; the fix is a wider key,
   *     which is free. Charging them for a scope they could mint would be a worse answer than 403.
   *   · `quota_exceeded` is absent — the rate limit is not a price.
   * `membership_required` IS here, and is the point of the whole rail: pay-per-request substitutes
   * membership for one operation.
   */
  const PAYWALL_FALLTHROUGH_CODES = new Set([
    'invalid_token',
    'invalid_signature',
    'token_expired',
    'token_ttl_exceeded',
    'token_revoked',
    'membership_required',
  ])

  /**
   * Authenticated guard: liveness, then the full six-step token check (which also hits quotas).
   *
   * SPEC 096 — THE BEARER PATH IS TRIED FIRST, ALWAYS. A member with a working key never reaches the
   * paywall, is never charged, and never sees a 402: on that path not one line of the x402 module
   * runs. The paid rail is consulted only when there is no Authorization header at all, or when the
   * token produced one of the verdicts above — and only for a route that carries an `opClass` on a
   * gateway where that class is priced. Everywhere else this function behaves exactly as it did
   * before spec 096 existed.
   */
  async function guard(req, res, scope, routeId) {
    requireLive()
    const opClass = routeOf(routeId).opClass
    const priced = Boolean(opClass) && paywall.offers(opClass)

    if (!req.get('authorization')) {
      // No credential. With the paid rail off (or this route unpriced) this is byte-identical to
      // before: `authenticate` throws 401 invalid_token "missing bearer token".
      if (!priced) return auth.authenticate(req, scope)
      return paidPrincipal(req, res, { opClass, routeId, scope })
    }

    try {
      return await auth.authenticate(req, scope)
    } catch (err) {
      if (priced && err instanceof GatewayError && PAYWALL_FALLTHROUGH_CODES.has(err.code)) {
        // The 402 body carries the AUTH verdict as its `error`, so the diagnostic ("your key
        // expired") survives instead of being replaced by a generic "pay me".
        return paidPrincipal(req, res, { opClass, routeId, scope, error: err.code, reason: err.reason })
      }
      throw err
    }
  }

  /**
   * The principal a SETTLED PAYMENT produces.
   *
   * Shaped like an authenticated token so every handler below is unchanged, but it is not one and
   * says so: no `keyId`, no window, no membership — a payer presented no key and this gateway will
   * not invent an identity for them. `scopes` is exactly the ONE scope the route being served
   * requires: a payment buys the operation it was quoted for and nothing adjacent.
   */
  async function paidPrincipal(req, res, { opClass, routeId, scope, error, reason }) {
    const route = routeOf(routeId)
    const { payer, settlement } = await paywall.settleOrChallenge(req, res, {
      opClass,
      routeId,
      description: route.summary,
      error,
      reason,
    })
    return {
      account: payer,
      keyId: null,
      label: null,
      scopes: scope ? [scope] : [],
      issuedAt: null,
      expiresAt: null,
      membership: null,
      paid: settlement,
    }
  }

  function handleError(res, err) {
    // A 402 is the PROTOCOL's body, not the gateway's `{ error: { code, reason } }` — it has to
    // carry the offer, or a client learns it was refused without learning what it could pay.
    if (err instanceof PaymentRequiredError) {
      return res.status(402).json(err.body)
    }
    if (err instanceof GatewayError) {
      if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec))
      return res.status(err.status).json(err.toBody())
    }
    // Never leak internals. Log, then answer with the module's generic unavailable code.
    console.error('[relay-gateway] member API error', err)
    return res
      .status(ERROR_CODES.upstream_unavailable.status)
      .json({ error: { code: 'upstream_unavailable', reason: 'the member API is temporarily unavailable; try again later' } })
  }

  // The document is built once: it is a pure function of config, and rebuilding it per request
  // would let a cheap unauthenticated GET do real work.
  let openApiDoc = null
  const openApi = () => (openApiDoc ??= buildOpenApiDocument(config, { assistantConfigured: assistant.configured }))

  // ---- GET /v1/member/openapi.json -----------------------------------------------------------
  // No credential: a client must be able to read the specification before a member has minted a
  // key. The module must still be enabled, so a disabled gateway answers with a machine-readable
  // 503 rather than a bare 404.
  mount('openapi', (req, res) => {
    try {
      guardPublic(req, publicQuotas)
      res.json(openApi())
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/member/me ---------------------------------------------------------------------
  mount('me', async (req, res) => {
    try {
      const token = await guard(req, res, SCOPES.readProfile, 'me')
      res.json({
        account: token.account,
        keyId: token.keyId,
        label: token.label,
        scopes: token.scopes,
        issuedAt: token.issuedAt,
        expiresAt: token.expiresAt,
        // The membership read the authenticator already performed — re-reading it here would be a
        // second chain call for a fact we just established.
        membership: token.membership,
        revocation: { revoked: false, durable: revocations.durable },
      })
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- POST /v1/member/keys/revoke -----------------------------------------------------------
  // SELF-AUTHORIZING. No bearer token: you revoke a key precisely when the token is the thing that
  // got out, so demanding it would make the endpoint useless exactly when it is needed. A valid
  // ApiKeyRevocation signature by the named account is the whole authorisation, and the worst a
  // forged attempt can do is fail verification.
  //
  // AND IT DRAWS FROM A WINDOW OF ITS OWN, which nothing else can spend. This is the endpoint a
  // member reaches for while their key is loose — which is also, in the case that matters, exactly
  // when this module is being flooded. Sharing a budget with the OpenAPI document would mean an
  // attacker who leaked a token could then deny its withdrawal with unauthenticated GETs.
  //
  // A BUDGET, NOT AN EXEMPTION. Removing the limit here would trade one denial for another: this
  // handler does an ECDSA recovery and, for a contract account, an ERC-1271 chain call on every
  // request, so an unmetered version is an amplifier pointed at our own RPC. What matters is not
  // that revocation is unlimited but that its budget is UNSHARED — no volume of other traffic, on
  // this module or anywhere else on the gateway, can consume it.
  mount('revoke', async (req, res) => {
    try {
      guardPublic(req, revokeQuotas)
      const provider = providers?.[auth.referenceChainId] ?? null
      const { account, keyId, revokedAt } = await verifyRevocation({
        provider,
        body: req.body ?? {},
        now,
        clockSkewSec: memberApi.clockSkewSec,
      })
      revocations.revoke(account, keyId, revokedAt)
      // Metadata only: the account and key id are the member's own public identifiers, and there is
      // no token anywhere in this event.
      audit({ account, keyId, action: 'member_api_key_revoked', outcome: 'registered' })
      res.json({
        revoked: true,
        durable: false,
        reason:
          'This revocation is held in the live gateway process and does NOT survive a gateway restart. ' +
          'What does survive is the grant’s own expiry, which was signed into the key when it was created: ' +
          're-submit this revocation after a restart, or let the key expire.',
      })
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/member/keys/status?keyId= -----------------------------------------------------
  mount('keyStatus', async (req, res) => {
    try {
      const token = await guard(req, res, SCOPES.readProfile, 'keyStatus')
      const keyId = typeof req.query.keyId === 'string' ? req.query.keyId : ''
      if (!BYTES32_RE.test(keyId)) {
        throw new GatewayError(400, 'bad_request', 'keyId must be a 0x-prefixed 32-byte hex value')
      }
      // An `account` query is accepted for symmetry with the signed struct, but never honoured for a
      // DIFFERENT account: this endpoint answers about the caller, and only the caller.
      const asked = typeof req.query.account === 'string' ? req.query.account : token.account
      if (asked.toLowerCase() !== token.account.toLowerCase()) {
        throw new GatewayError(403, 'insufficient_scope', 'a key’s status is only readable by the account that owns it')
      }
      res.json({
        account: token.account,
        keyId,
        revoked: revocations.isRevoked(token.account, keyId),
        durable: revocations.durable,
      })
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/member/membership --------------------------------------------------------------
  mount('membership', async (req, res) => {
    try {
      const token = await guard(req, res, SCOPES.readMembership, 'membership')
      // Reaching this line means the authenticator already read membership successfully — an
      // unreadable one would have 503'd there — so this serves that same read rather than making a
      // second call that could disagree with the first.
      res.json(token.membership)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/member/wagers?chainId=&first= ---------------------------------------------------
  mount('wagers', async (req, res) => {
    try {
      const token = await guard(req, res, SCOPES.readWagers, 'wagers')

      let chainIds = config.enabledChainIds
      if (req.query.chainId != null && req.query.chainId !== '') {
        const asked = Number.parseInt(String(req.query.chainId), 10)
        if (!Number.isInteger(asked)) throw new GatewayError(400, 'bad_request', 'chainId must be an integer')
        if (!config.chains[asked]) {
          // A chain outside this deployment's cohort is refused rather than answered
          // `not-configured`: that state means "enabled here but with no indexer", and using it for
          // a chain this gateway does not serve at all would blur two different facts.
          throw new GatewayError(
            400,
            'bad_request',
            `chain ${asked} is not enabled on this gateway (enabled: ${config.enabledChainIds.join(', ')})`
          )
        }
        chainIds = [asked]
      }

      let first = DEFAULT_PAGE
      if (req.query.first != null && req.query.first !== '') {
        first = Number.parseInt(String(req.query.first), 10)
        if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE) {
          throw new GatewayError(400, 'bad_request', `first must be an integer between 1 and ${MAX_PAGE}`)
        }
      }

      const { chains, partial } = await wagerReader.read(token.account, { chainIds, first })
      res.json({ account: token.account, chains, partial, asOf: new Date(now() * 1000).toISOString() })
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/member/fees ---------------------------------------------------------------------
  // A VIEW of the gateway's existing FeeRouter reader, never a second fee path and never a hardcoded
  // bps. Each service reports where its number came from: `chain` (the live FeeRouter value),
  // `env-fallback` (this gateway's configured default, served when no router is configured) or
  // `unreadable` (a router IS configured and could not be read). That third state matters here more
  // than anywhere else in this module, because ZERO IS A REAL RATE — it means "no fee line at all" —
  // so a failed read must never be served as 0.
  mount('fees', async (req, res) => {
    try {
      await guard(req, res, SCOPES.readFees, 'fees')
      const routerConfigured = Boolean(feeRates?.enabled)
      const fallbackSource = routerConfigured ? 'unreadable' : 'env-fallback'
      const entry = (live, fallbackBps, capBps) =>
        live != null
          ? { bps: live, capBps, source: 'chain' }
          : { bps: routerConfigured ? null : fallbackBps, capBps, source: fallbackSource }

      const pm = feeRates ? await feeRates.getPolymarketBps() : null
      const hl = feeRates ? await feeRates.getPerpsHlBuilderBps() : null

      res.json({
        feeRouter: { address: feeRates?.address ?? null, chainId: config.feeRouter.chainId },
        // Only the services the gateway's own reader can answer for. A service it cannot read is
        // absent rather than guessed — inventing a rate here would make this a second fee store,
        // which is precisely what spec 060 exists to prevent.
        services: {
          'polymarket.taker': entry(pm?.takerBps ?? null, config.polymarket.takerFeeBps, POLYMARKET_TAKER_CAP_BPS),
          'polymarket.maker': entry(pm?.makerBps ?? null, config.polymarket.makerFeeBps, POLYMARKET_MAKER_CAP_BPS),
          'perps.hyperliquid.builder': entry(hl, config.perps.hlBuilderFeeBps, PERPS_HL_BUILDER_CAP_BPS),
        },
        asOf: new Date(now() * 1000).toISOString(),
      })
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- POST /v1/member/intents/build -----------------------------------------------------------
  mount('buildIntent', async (req, res) => {
    try {
      const token = await guard(req, res, SCOPES.buildIntents, 'buildIntent')
      const body = req.body ?? {}
      const chainId = Number.parseInt(String(body.chainId), 10)
      if (!Number.isInteger(chainId)) throw new GatewayError(400, 'bad_request', 'body.chainId must be an integer')
      // `account` is the TOKEN's account. Whatever the caller put in params for the actor field is
      // discarded inside buildIntent — an "on behalf of" address has no code path here.
      const built = buildIntent(config, { action: body.action, chainId, params: body.params, account: token.account })
      res.json(built)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- POST /v1/member/assistant/chat ----------------------------------------------------------
  // THE ONLY ROUTE ON THIS MODULE THAT SPENDS MONEY PER REQUEST, and therefore the only one with a
  // ceiling denominated in something other than requests. Three controls sit in front of the
  // provider, in ascending cost of being wrong:
  //   1. the module's general quota (inside `guard`) — traffic;
  //   2. `assistantQuotas` — a TIGHTER request class, because 120 reads/min and 120 model calls/min
  //      are not the same permission even though they were once the same number;
  //   3. `assistantBudget` — TOKENS, which is the thing actually billed. A request count is a poor
  //      proxy for spend: two turns inside one window can differ by orders of magnitude.
  // Before this existed the counts below were logged and nothing read them, so the only ceiling was
  // `ASSISTANT_ENABLED=false` — a full kill as the first available response to overspend.
  mount('assistantChat', async (req, res) => {
    try {
      const token = await guard(req, res, SCOPES.assistantChat, 'assistantChat')
      const { messages, surface } = parseChatRequest(req.body ?? {})
      // Scoped to the try on purpose: a turn that throws is deliberately NOT settled, so there is no
      // handle for a catch block to reach for.
      let reservation = null

      // Keyed by the account on either rail: a member's token account, or (spec 096) the payer a
      // settled payment names. Neither may be an unattributed caller — this costs real money.
      const q = assistantQuotas.hit(token.account)
      if (!q.allowed) {
        throw new GatewayError(429, 'quota_exceeded', `${q.scope} assistant quota exceeded; retry shortly`, {
          retryAfterSec: q.retryAfterSec,
        })
      }

      // The budget is reserved only once we know a call is genuinely about to be made. An assistant
      // that is switched off or has no credential costs nothing, and must not consume a member's
      // budget to tell them so.
      if (assistant.configured) {
        const worstCase = estimateTurnTokens({ messages, surface, maxTokens: memberApi.assistant.maxTokens })
        const r = assistantBudget.reserve(token.account, worstCase)
        if (!r.allowed) {
          // REFUSED, NAMED, AND NEVER SHORTENED. The tempting failure here is to trim `max_tokens`
          // to whatever headroom is left and answer anyway — which delivers a truncated reply that
          // reads as the assistant's own judgement about how much to say. An exhausted budget is an
          // operational fact and is reported as one, with its own code so an agent can tell it from
          // an ordinary rate limit and back off on the right timescale.
          audit({
            account: token.account,
            keyId: token.keyId,
            action: 'member_api_assistant_chat',
            messageCount: messages.length,
            budgetScope: r.scope,
            spentTokens: r.spentTokens,
            budgetTokens: r.budgetTokens,
            outcome: 'budget_exhausted',
          })
          throw new GatewayError(
            429,
            'assistant_budget_exhausted',
            r.scope === 'account'
              ? 'the assistant token budget for this account is spent for now; it refills as the window rolls forward'
              : 'the gateway’s assistant token budget is spent for now; try again shortly',
            { retryAfterSec: r.retryAfterSec }
          )
        }
        reservation = r
      }

      // THE GATEWAY ATTACHES THE TOOL TABLE (spec 104). Never the client's: on this rail a
      // client-supplied `tools` array would be arbitrary text into the model under FairWins'
      // credential, and parseChatRequest has already refused one. The set is filtered to the
      // scopes the principal actually holds — a paid x402 principal carries `assistant:chat`
      // alone and therefore gets the public and local tools only — because offering the model a
      // tool the gateway would then refuse reads back to it as "the member has nothing".
      const tools = toolsForMessages(selectTools({ hasGrant: true, scopes: token.scopes }))
      const result = await assistant.chat({ messages, surface, tools })

      // Settle the reservation down to what was actually billed. Absent counts stay ABSENT — the
      // reservation stands rather than collapsing to zero, because "the provider told us nothing"
      // is not "the provider charged us nothing". A turn that THREW is likewise never settled: the
      // request had already been sent, so crediting it back would make a retry loop against a
      // failing provider free, which is exactly the spend this control exists to bound.
      const spent =
        result.usage.inputTokens == null && result.usage.outputTokens == null
          ? null
          : (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0)
      reservation?.settle(spent)

      // COUNTS ONLY. Not one character of the conversation reaches the log — on this path or any
      // other. Adding a content key to audit/log.js's FORBIDDEN_KEYS would not substitute for that.
      audit({
        account: token.account,
        keyId: token.keyId,
        action: 'member_api_assistant_chat',
        messageCount: messages.length,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        // How many tools the model asked for this round — a count, never a name's arguments.
        toolUseCount: result.content.filter((b) => b.type === 'tool_use').length,
        stopReason: result.stopReason,
        outcome: 'answered',
      })
      res.json(result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // Completeness: every route the contract declares (and therefore every route the OpenAPI document
  // publishes) must actually be mounted. A missing one fails the BOOT, not a member's request.
  const unmounted = ROUTES.filter((r) => !mounted.has(`${r.method.toUpperCase()} ${r.path}`))
  if (unmounted.length > 0) {
    throw new Error(
      `[relay-gateway] member API declares routes it does not mount: ${unmounted.map((r) => r.id).join(', ')}. ` +
        'The OpenAPI document would advertise endpoints this gateway answers with 404.'
    )
  }

  return router
}

/**
 * /status contribution: operational visibility, no member data.
 *
 * `enabled` is HONEST LIVENESS — the module is enabled only if a request right now would be served,
 * so either killswitch turns it false. Same rule as `perpsStatus`.
 */
export function memberApiStatus(config, { killSwitch, assistantConfigured = false }) {
  const memberApi = config.memberApi
  return {
    // "Would a request right now be served?" — so either killswitch makes this false, not just the
    // config flag. An operator reading `enabled: true` while the module is killed would be reading
    // a claim about configuration dressed as a claim about liveness.
    enabled: Boolean(memberApi.enabled) && !memberApi.killSwitch && !killSwitch.isActive(),
    killSwitch: Boolean(memberApi.killSwitch),
    // A boolean, never the credential and never the model id's provenance. `maxRounds` is the
    // tool-loop ceiling the browser must respect against this gateway (spec 104) — public config.
    assistant: { configured: Boolean(assistantConfigured), maxRounds: memberApi.assistant.maxRounds },
    // Spec 096. PUBLIC CONFIG ONLY — the prices and the network are already in every 402 body, and
    // the treasury's BALANCE is deliberately not here (see x402Status).
    x402: x402Status(config, { killSwitch }),
  }
}

/**
 * Every route this module mounts, as `"<METHOD> <path>"`.
 *
 * Derived from the SAME array `openapi.js` documents and `createMemberApiRouter` mounts from, which
 * is why it is not a third list: the factory's completeness check proves the mounting matches, the
 * OpenAPI builder throws on a route it has no detail for, and `test/memberApi.test.js` probes every
 * entry over HTTP to prove the paths are genuinely served.
 */
export function declaredPaths() {
  return ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort()
}
