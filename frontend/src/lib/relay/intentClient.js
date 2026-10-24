/**
 * Shared intent-relay client (specs 035 + 036) — generalizes the dormant spec-034 prototypes
 * (lib/pools/gasless.js + lib/pools/relayerClient.js) into the one client every gasless flow uses.
 *
 * The relayer is GAS INFRASTRUCTURE, not an app backend: when `VITE_RELAYER_URL` is unset,
 * `makeRelayer()` returns null and every flow self-submits (the safe, zero-footprint default).
 * The relayer is untrusted — it can censor, never steal: every consequential parameter is inside the
 * signed EIP-712 struct, and the money leg is a recipient-bound EIP-3009 `receiveWithAuthorization`
 * stapled to the action via `paymentNonce` (FR-007/FR-013).
 *
 * Error contract (see ./errors.js): RelayerUnavailable (429/503/network/timeout — self-submit),
 * PaymentUnsupportedOnChain (FR-020 pre-sign domain check — self-submit),
 * RelayRejected (gateway validation verdict — surface `code`/`reason`).
 */
import { toHex } from 'viem'
import { splitSignature } from '../evm/signature'
import {
  INTENT_ACTIONS,
  INTENT_TYPES,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  membershipManagerDomain,
  stablecoinDomain,
  wagerPoolDomain,
  wagerPoolFactoryDomain,
  wagerRegistryDomain,
} from './intentTypes'
import { PaymentUnsupportedOnChain, RelayRejected, RelayerUnavailable } from './errors'

const DEFAULT_VALIDITY_SECONDS = 3600
const RELAY_TIMEOUT_MS = 15000
const HEALTH_BUDGET_MS = 2000

/** The configured relay-gateway base URL, or '' when unset. Read at call time so tests can stub the env. */
export function relayerBaseUrl() {
  return (import.meta.env.VITE_RELAYER_URL || '').trim().replace(/\/$/, '')
}

/** A fresh random 32-byte nonce (2-D replay nonce / EIP-3009 nonce / uniquenessMarker). */
export function randomNonce() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

/** Serialize a uint-ish value (bigint/number/string) to a JSON-safe decimal string. */
function toUintString(v) {
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') return Math.trunc(v).toString()
  return String(v)
}

/** Serialize signed params for the gateway body — DEEP (bigints → decimal strings), so nested arrays
 *  like a pool payout matrix ([{ winner, amount: bigint }]) survive JSON.stringify. */
function serializeParams(params) {
  const conv = (v) => {
    if (typeof v === 'bigint') return v.toString()
    if (Array.isArray(v)) return v.map(conv)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)]))
    return v
  }
  return conv(params || {})
}

/** Resolve an intent's EIP-712 domain by verifier/domain key (the pool split adds wagerPool[Factory]). */
function buildIntentDomain(kind, chainId, verifyingContract) {
  switch (kind) {
    case 'membershipManager':
      return membershipManagerDomain(chainId, verifyingContract)
    case 'wagerPool':
      return wagerPoolDomain(chainId, verifyingContract)
    case 'wagerPoolFactory':
      return wagerPoolFactoryDomain(chainId, verifyingContract)
    default:
      return wagerRegistryDomain(chainId, verifyingContract)
  }
}

/** `fetch` with a bounded budget; any transport failure or timeout maps to RelayerUnavailable. */
async function boundedFetch(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (e) {
    throw new RelayerUnavailable(`Relayer unreachable: ${e?.message || e}`, {
      code: e?.name === 'AbortError' ? 'timeout' : 'network_error',
      cause: e,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Best-effort JSON body (the gateway always sends JSON, but never trust a failing proxy). */
async function readJson(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Sign one intent and build the gateway Intent body (spec 036 relay-gateway-api.md / spec 035
 * data-model.md "Client-side: Intent"). ONE wallet interaction per leg: the action intent under the
 * verifying contract's domain, plus — for payment-class actions — an EIP-3009
 * `ReceiveWithAuthorization` under the stablecoin's own domain, its nonce stapled into the struct's
 * `paymentNonce` so the relayer cannot pair the action with a different authorization (FR-007).
 *
 * FR-020 pre-sign check: payment-class on a chain whose stablecoin has `domainVersion: null` throws
 * PaymentUnsupportedOnChain BEFORE any wallet prompt — the caller self-submits.
 *
 * @param {object} args
 * @param {import('ethers').Signer} args.signer - wallet signer (must support signTypedData)
 * @param {number} args.chainId
 * @param {string} args.action - gateway action name (key of INTENT_ACTIONS)
 * @param {string} args.targetContract - verifying contract (proxy) address on `chainId`
 * @param {object} [args.params] - action struct fields EXCEPT the auto-filled actor field,
 *   paymentNonce, nonce, validAfter, validBefore
 * @param {{value: bigint|number|string}} [args.payment] - money leg (required for payment-class actions)
 * @param {number} [args.validAfter=0] - earliest execution (unix seconds)
 * @param {number} [args.validBefore] - expiry (unix seconds); defaults to now + validitySeconds
 * @param {number} [args.validitySeconds=3600]
 * @param {'sponsored'|'fee-netted'} [args.fundingMode='sponsored']
 * @param {bigint|number|string} [args.maxFee] - bounded fee cap (fee-netted mode)
 * @param {'wagerRegistry'|'membershipManager'} [args.verifier] - override for actions both contracts
 *   expose (invalidateNonce); otherwise taken from INTENT_ACTIONS
 * @param {number} [args.nowSeconds] - injectable clock for tests
 * @returns {Promise<object>} the gateway Intent body (POST /v1/intents)
 */
export async function signIntent({
  signer,
  chainId,
  action,
  targetContract,
  params = {},
  payment,
  validAfter = 0,
  validBefore,
  validitySeconds = DEFAULT_VALIDITY_SECONDS,
  fundingMode = 'sponsored',
  maxFee,
  verifier,
  nowSeconds,
}) {
  const meta = INTENT_ACTIONS[action]
  if (!meta) throw new Error(`signIntent: unknown intent action '${action}'`)
  if (!targetContract) throw new Error('signIntent: targetContract is required')
  if (chainId == null) throw new Error('signIntent: chainId is required')

  const verifierKind = verifier || meta.verifier
  if (!verifierKind) throw new Error(`signIntent: action '${action}' needs an explicit verifier`)

  // Pool join (`authOnly`) carries no signer-attributed intent struct — the EIP-3009 authorization IS
  // the whole intent (attribution + binding), so there is no action-domain signature to build.
  const isAuthOnly = !!meta.authOnly

  // Domain/target SPLIT (Tier-2 pools): the intent TARGET is `targetContract` (the factory, pinned +
  // whitelisted at the engine), but the signature may verify under a DIFFERENT contract's domain — the
  // CLONE for the six actor twins (verifyingContract = params[verifyingContractParam]), the FACTORY for
  // createPool, else the target itself. Non-pool actions keep the original behavior (domain == target).
  const domainKind = meta.domainVerifier || verifierKind
  const domainVerifyingContract = meta.verifyingContractParam ? params[meta.verifyingContractParam] : targetContract
  const domain = isAuthOnly ? null : buildIntentDomain(domainKind, chainId, domainVerifyingContract)

  // FR-020: resolve the token domain BEFORE any wallet prompt — throws PaymentUnsupportedOnChain on
  // chains whose stablecoin lacks EIP-3009 (Mordor/ETC USC), so the flow self-submits with zero
  // wasted signatures.
  const tokenDomain = meta.intentClass === 'payment' ? stablecoinDomain(chainId) : null

  const from = await signer.getAddress()
  const now = nowSeconds != null ? nowSeconds : Math.floor(Date.now() / 1000)
  const before = validBefore != null ? validBefore : now + validitySeconds
  const nonce = randomNonce()

  const fields = isAuthOnly ? [] : INTENT_TYPES[meta.primaryType]
  const hasField = (name) => fields.some((f) => f.name === name)

  // The actor field is ALWAYS the wallet's own address — signer attribution is not caller-spoofable.
  const message = isAuthOnly ? {} : { ...params, [meta.actorField]: from }

  // Payment leg: sign the token's ReceiveWithAuthorization and staple its nonce into the struct.
  // ONE marker for the whole payment intent (data-model.md: the uniquenessMarker IS the EIP-3009
  // nonce): paymentNonce == struct nonce == uniquenessMarker. The registry's replay map and the
  // token's authorizationState are separate state spaces, so sharing the value is safe — and the
  // gateway enforces the equality (param_binding_mismatch otherwise).
  let authorization = null
  if (meta.intentClass === 'payment') {
    if (payment == null || payment.value == null) throw new Error(`signIntent: action '${action}' is payment-class and requires payment.value`)
    const paymentNonce = nonce
    const authMessage = {
      from,
      // Money is bound to the pinned target by default; for a pool join it flows into the CLONE
      // (`authToParam: 'pool'`), which the token enforces is the caller so a relayer can't redirect it.
      to: meta.authToParam ? params[meta.authToParam] : targetContract,
      value: toUintString(payment.value),
      validAfter,
      validBefore: before,
      nonce: paymentNonce,
    }
    // See `lib/evm/signature.js`: viem's parseSignature refuses the compact form and returns a
    // bigint `v`, and this authorization is JSON-serialized to the relay gateway.
    const sig = splitSignature(await signer.signTypedData(tokenDomain, RECEIVE_WITH_AUTHORIZATION_TYPES, authMessage))
    if (!sig) throw new Error('The wallet returned something that is not a signature, so nothing has been authorized.')
    authorization = { ...authMessage, validAfter: toUintString(validAfter), validBefore: toUintString(before), v: sig.v, r: sig.r, s: sig.s }
    if (hasField('paymentNonce')) message.paymentNonce = paymentNonce
  }

  if (!isAuthOnly) {
    message.nonce = nonce
    if (hasField('validAfter')) message.validAfter = validAfter
    message.validBefore = before
  }

  const signature = isAuthOnly
    ? '0x'
    : await signer.signTypedData(domain, { [meta.primaryType]: fields }, message)

  const intent = {
    intentClass: meta.intentClass,
    chainId: Number(chainId),
    targetContract,
    action,
    // authOnly: the body params are the raw action params (e.g. { pool }); no struct fields to emit.
    params: serializeParams(isAuthOnly ? params : message),
    signature,
    validAfter,
    validBefore: before,
    uniquenessMarker: nonce,
    fundingMode,
  }
  if (authorization) intent.authorization = authorization
  if (maxFee != null) intent.maxFee = toUintString(maxFee)
  return intent
}

/**
 * POST the signed intent to the gateway (`POST /v1/intents`).
 *
 * @param {object} intent - the body built by signIntent
 * @param {{baseUrl?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{intentId: string, status: string, txHash?: string}>}
 * @throws {RelayerUnavailable} on unset base URL, network error, timeout, 429 or 503 → self-submit
 * @throws {RelayRejected} on any other non-2xx (gateway `error.code` preserved)
 */
export async function relayIntent(intent, { baseUrl, timeoutMs = RELAY_TIMEOUT_MS } = {}) {
  const base = baseUrl != null ? baseUrl.replace(/\/$/, '') : relayerBaseUrl()
  if (!base) throw new RelayerUnavailable('No relayer configured (VITE_RELAYER_URL unset)', { code: 'relayer_unset' })

  const res = await boundedFetch(
    `${base}/v1/intents`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent) },
    timeoutMs
  )
  const data = await readJson(res)

  if (res.status === 429 || res.status === 503) {
    const retryAfter = Number(res.headers?.get?.('Retry-After'))
    throw new RelayerUnavailable(data?.error?.reason || `Relayer unavailable (HTTP ${res.status})`, {
      code: data?.error?.code || (res.status === 429 ? 'backpressure' : 'unavailable'),
      status: res.status,
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null,
    })
  }
  if (!res.ok) {
    throw new RelayRejected(data?.error?.reason || `Relay rejected (HTTP ${res.status})`, {
      code: data?.error?.code,
      status: res.status,
      reason: data?.error?.reason,
    })
  }
  if (!data || typeof data.intentId !== 'string') {
    throw new RelayerUnavailable('Relayer returned no intentId', { code: 'bad_response', status: res.status })
  }
  return { intentId: data.intentId, status: data.status, ...(data.txHash ? { txHash: data.txHash } : {}) }
}

/**
 * Fetch relay status for an accepted intent (`GET /v1/intents/{id}`) — drives the honest status UI
 * (`queued | submitted | confirmed | rejected | failed`; `confirmed` always carries `txHash`).
 *
 * @param {string} intentId
 * @param {{baseUrl?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{intentId: string, status: string, txHash?: string, reason?: string}>}
 */
export async function pollStatus(intentId, { baseUrl, timeoutMs = RELAY_TIMEOUT_MS } = {}) {
  const base = baseUrl != null ? baseUrl.replace(/\/$/, '') : relayerBaseUrl()
  if (!base) throw new RelayerUnavailable('No relayer configured (VITE_RELAYER_URL unset)', { code: 'relayer_unset' })

  const res = await boundedFetch(`${base}/v1/intents/${encodeURIComponent(intentId)}`, { method: 'GET' }, timeoutMs)
  const data = await readJson(res)
  if (!res.ok || !data) {
    throw new RelayerUnavailable(`Relayer status check failed (HTTP ${res.status})`, {
      code: data?.error?.code || 'status_unavailable',
      status: res.status,
    })
  }
  return data
}

/**
 * Probe `GET /status` within a bounded (~2s) budget. Returns true only when the gateway reports
 * `status: 'ok'`, the kill switch is off, and — when the response itemizes chains — `chainId`'s RPC
 * is up. Any failure, timeout, or unset relayer returns false (never throws): a failed probe routes
 * the flow to self-submit BEFORE the user signs (FR-016).
 *
 * NOTE: the path is `/status`, not `/healthz` — Google's GFE intercepts the literal `/healthz` on
 * Cloud Run (*.run.app), so it never reaches the gateway. `/status` is the same handler at a
 * non-reserved path.
 *
 * @param {number} chainId
 * @param {{baseUrl?: string, budgetMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function probeHealth(chainId, { baseUrl, budgetMs = HEALTH_BUDGET_MS } = {}) {
  const base = baseUrl != null ? baseUrl.replace(/\/$/, '') : relayerBaseUrl()
  if (!base) return false
  try {
    const res = await boundedFetch(`${base}/status`, { method: 'GET' }, budgetMs)
    if (!res.ok) return false
    const data = await readJson(res)
    if (!data || data.status !== 'ok' || data.killSwitch === true) return false
    // A caller that names a chain the relayer doesn't serve (absent from the map) must fall back to
    // self-submit — returning true here would prompt a signature and then hard-fail on chain_mismatch,
    // stranding the action (never-stranded, FR-002/FR-003). Only chainId==null (caller doesn't care)
    // trusts the top-level status.
    if (chainId != null) {
      const c = data.chains && data.chains[String(chainId)]
      return !!c && c.rpc === 'up'
    }
    return true
  } catch {
    return false
  }
}

/**
 * Build a relayer handle bound to `chainId`, or null when gasless is disabled — the null return IS
 * the never-stranded switch: every caller treats it as "self-submit" (spec 036 frontend-relay-client.md).
 *
 * @param {number} chainId
 * @returns {null | {chainId: number, baseUrl: string,
 *   relayIntent: (intent: object, opts?: object) => Promise<object>,
 *   pollStatus: (intentId: string, opts?: object) => Promise<object>,
 *   probeHealth: (opts?: object) => Promise<boolean>}}
 */
export function makeRelayer(chainId) {
  const base = relayerBaseUrl()
  if (!base) return null // gasless disabled → every flow self-submits (safe default)
  return {
    chainId: chainId != null ? Number(chainId) : null,
    baseUrl: base,
    relayIntent: (intent, opts = {}) => relayIntent(intent, { baseUrl: base, ...opts }),
    pollStatus: (intentId, opts = {}) => pollStatus(intentId, { baseUrl: base, ...opts }),
    probeHealth: (opts = {}) => probeHealth(chainId, { baseUrl: base, ...opts }),
  }
}
