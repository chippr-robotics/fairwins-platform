/**
 * Predict per-user CLOB session (spec 057, "Option A") — mints each member's OWN Polymarket CLOB API
 * credentials client-side (one L1 wallet signature) and drives order submit/cancel/open-orders DIRECTLY
 * against clob.polymarket.com via the official viem-native `@polymarket/clob-client`.
 *
 * WHY per-user creds (not one shared gateway key): CLOB V2 binds every order to its signer — it rejects
 * any order whose `signer` != the address the API key was registered under ("the order signer address has
 * to be the address of the API KEY" / 401 "Invalid api key"). A single shared key therefore cannot submit
 * trades for other wallets (verified against live CLOB). Each member derives their OWN creds; they live
 * in-session only (sessionStorage), never on a FairWins server — consistent with the no-backend rule.
 *
 * WHY client-direct: clob.polymarket.com serves `Access-Control-Allow-Origin: *` (verified), so the SPA
 * calls it straight from the browser. The creds never transit our gateway. The gateway stays for the
 * PUBLIC read feed (markets/positions/fee-rate) only.
 *
 * Attribution (FairWins builder revenue) rides on the shared builder credential via `BuilderConfig` remote
 * signing at the gateway (POLY_BUILDER_* headers). When that isn't configured, trades still go through
 * UNATTRIBUTED — never stranded (FR-015).
 *
 * Two signing rails share this session module (tradeSigner.js decides which):
 *   - EOA (signatureType 0): maker == signer == funder == the connected EOA, ECDSA via the viem
 *     walletClient. Unchanged.
 *   - Passkey smart account (signatureType 3, POLY_1271): maker == signer == funder == the account
 *     itself; the "signer" handed to the SDK is `passkeyClobSigner.js`, whose signatures are the
 *     account's ERC-1271 WebAuthn envelope. The API key mints against the ACCOUNT address (the L1
 *     ClobAuth attestation is signed the same way), satisfying CLOB V2's signer-binding rule.
 */
import { ClobClient, Side, OrderType, ExchangeOrderBuilder, getContractConfig } from '@polymarket/clob-client'

export const CLOB_HOST = 'https://clob.polymarket.com'
export const POLYGON = 137

// signatureType 0 = EOA. The order's maker/signer/funder are all the connected EOA.
const SIG_TYPE_EOA = 0

// signatureType 3 = POLY_1271: a smart-wallet maker whose order signatures the CLOB validates by
// calling the wallet's own `isValidSignature` (ERC-1271). The pinned SDK (5.8.1, archived) predates
// this member of the enum — its SignatureType stops at POLY_GNOSIS_SAFE = 2 — but the value is
// forwarded into the signed order struct unvalidated, so the raw number is the whole integration.
export const SIG_TYPE_POLY_1271 = 3

const credsKey = (address) => `predict.clob.creds.${String(address || '').toLowerCase()}`
const safeStorage = () => {
  try { return globalThis.sessionStorage ?? null } catch { return null }
}

/** The member's cached CLOB creds for this session, or null. Shape: { key, secret, passphrase }. */
export function loadCachedCreds(address, storage = safeStorage()) {
  try {
    const raw = storage?.getItem(credsKey(address))
    const c = raw ? JSON.parse(raw) : null
    return c?.key && c?.secret && c?.passphrase ? c : null
  } catch {
    return null
  }
}

export function cacheCreds(address, creds, storage = safeStorage()) {
  try { storage?.setItem(credsKey(address), JSON.stringify(creds)) } catch { /* private mode / quota — derive again next time */ }
}

export function clearCachedCreds(address, storage = safeStorage()) {
  try { storage?.removeItem(credsKey(address)) } catch { /* noop */ }
}

/**
 * Mint (or reuse) the member's own CLOB creds. `createOrDeriveApiKey` is deterministic per wallet —
 * one L1 EIP-712 signature (a wallet/passkey prompt, no gas). Cached per address for the session so
 * the member signs at most once. `walletClient` is any signer the SDK accepts: a viem walletClient
 * (EOA) or the passkey ERC-1271 shim. Returns { key, secret, passphrase }.
 */
export async function ensureClobCreds(walletClient, { address, storage = safeStorage(), ClobClientImpl = ClobClient } = {}) {
  const addr = address ?? walletClient?.account?.address
  const cached = loadCachedCreds(addr, storage)
  if (cached) return cached
  const boot = new ClobClientImpl(CLOB_HOST, POLYGON, walletClient)
  const creds = await boot.createOrDeriveApiKey()
  if (creds?.key && creds?.secret && creds?.passphrase) cacheCreds(addr, creds, storage)
  return creds
}

/**
 * Builder attribution config for FairWins revenue (POLY_BUILDER_* headers). The builder creds are a
 * SHARED secret, so they stay server-side: this returns a light client the CLOB SDK calls to fetch the
 * four headers from the gateway's remote builder-sign endpoint (the gateway holds the creds and does the
 * HMAC). We deliberately do NOT import `@polymarket/builder-signing-sdk` here — it statically pulls in
 * `node:crypto` (`createHmac`) and cannot be bundled for the browser; it is a server-only SDK. The CLOB
 * client duck-types this object: it only calls `isValid()` and `generateBuilderHeaders(method, path, body)`
 * (see `@polymarket/clob-client` `_generateBuilderHeaders`). The gateway generates + bakes the timestamp
 * into `POLY_BUILDER_TIMESTAMP` and signs over the same body, so the shim just forwards {method,path,body}.
 * Returns undefined when no gateway is configured — trades then post UNATTRIBUTED (never-stranded, FR-015).
 * @param {string} gatewayBaseUrl  e.g. VITE_RELAYER_URL (no trailing slash); '' => no attribution
 * @param {number} [chainId]
 */
export function makeBuilderConfig(gatewayBaseUrl, chainId = POLYGON, { fetchImpl } = {}) {
  const base = String(gatewayBaseUrl || '').trim().replace(/\/$/, '')
  if (!base) return undefined
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args))
  const url = `${base}/v1/polymarket/${chainId}/builder-sign`
  return {
    isValid: () => true,
    // Attribution is best-effort: any failure returns undefined so the SDK posts the order UNATTRIBUTED
    // rather than blocking it (never-stranded, FR-015).
    async generateBuilderHeaders(method, path, body) {
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, path, body: body ?? null }),
        })
        if (!res?.ok) return undefined
        const h = await res.json()
        return h?.POLY_BUILDER_API_KEY && h?.POLY_BUILDER_SIGNATURE ? h : undefined
      } catch {
        return undefined
      }
    },
  }
}

/**
 * An authed CLOB client bound to the member's signer + their creds, with optional builder attribution.
 * @param {object} walletClient  viem WalletClient (EOA) or the passkey ERC-1271 signer shim
 * @param {{key,secret,passphrase}} creds
 * @param {{ builderConfig?: object, signatureType?: number, funderAddress?: string, ClobClientImpl?: Function }} [opts]
 *   signatureType defaults to EOA (0); passkey sessions pass SIG_TYPE_POLY_1271 with
 *   funderAddress = the account (maker == signer == funder).
 */
export function makeClobClient(
  walletClient,
  creds,
  { builderConfig, signatureType = SIG_TYPE_EOA, funderAddress, ClobClientImpl = ClobClient } = {}
) {
  return new ClobClientImpl(
    CLOB_HOST,
    POLYGON,
    walletClient,
    creds,
    signatureType,
    funderAddress, // undefined => funder = signer (EOA)
    undefined, // geoBlockToken
    false, // useServerTime
    builderConfig, // POLY_BUILDER_* attribution (optional)
  )
}

/* ── Spec 114 slice 5 — the amount-first (market) order ───────────────────────────────────────────── */

const MICRO = 1_000_000n
const DECIMAL_STRING = /^\d+(\.\d+)?$/

/** A decimal string → micro-units (6 dp), or null when it is not a plain decimal with at most 6 places. */
function toMicroStrict(value) {
  if (typeof value !== 'string' || !DECIMAL_STRING.test(value)) return null
  const [whole, frac = ''] = value.split('.')
  if (frac.length > 6) return null
  return BigInt(whole) * MICRO + BigInt(frac.padEnd(6, '0'))
}

function microToDecimal(micro) {
  const whole = micro / MICRO
  const frac = (micro % MICRO).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : String(whole)
}

/** "050.500" / "50.5" / "50.5." → "50.5": the canonical spelling two equal decimals share. */
function canonicalDecimal(text) {
  const t = String(text).trim()
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null
  const [whole = '0', frac = ''] = t.split('.')
  const w = whole.replace(/^0+(?=\d)/, '') || '0'
  const f = frac.replace(/0+$/, '')
  return f ? `${w}.${f}` : w
}

/**
 * The ONE place a decimal STRING becomes a JavaScript number, and the reason is the SDK's interface:
 * `UserMarketOrder.amount` and `.price` are `number`s, and the SDK then rounds them with float arithmetic.
 * Everything upstream of here (the plan, the review, the fee lines) is exact integer arithmetic on strings,
 * so this boundary refuses to convert anything that does not survive the trip: a value whose number prints
 * back as a DIFFERENT decimal would be signed as something other than what the member was shown.
 */
export function toSdkNumber(decimal) {
  const canonical = canonicalDecimal(decimal)
  if (canonical == null) throw new Error(`not a plain decimal amount: ${String(decimal)}`)
  const n = Number(canonical)
  if (!Number.isFinite(n) || canonicalDecimal(String(n)) !== canonical) {
    throw new Error(`amount does not survive conversion to the SDK's number type: ${canonical}`)
  }
  return n
}

/**
 * What the venue's answer to a POSTED order means — a refusal, an answer nobody can interpret, or an order
 * taken. The SDK never throws from the post itself: its HTTP helper turns every failure into a returned
 * `{ error, status? }`, so a THROW out of `createAndPost…` happened before anything was sent (the order could
 * not be built or the member declined to sign) and a RETURNED error happened at or after the send. Those two
 * are different facts for a member, and this is the one place they are told apart:
 *
 *  - a 4xx: the request was refused before it could match — nothing was placed. A definite failure.
 *  - `success: false` on a 200: the venue's own "no".
 *  - a 5xx, a 408, or no HTTP status at all (the connection failed or the answer never arrived): the order
 *    MAY have been received. `outcomeUnknown` is set, and the caller must not offer the same order again as
 *    if nothing had happened — a fill-and-kill order sent twice can fill twice.
 *
 * The reason text is never a raw HTML error page or an object dump: only a short plain string from the venue
 * is passed through.
 */
function readPostFailure(resp) {
  if (!resp || typeof resp !== 'object') return null
  if ('error' in resp) {
    const status = Number.isInteger(resp.status) ? resp.status : null
    const said = typeof resp.error === 'string' && resp.error.length <= 200 && !/[<>]/.test(resp.error) ? resp.error.trim() : ''
    if (status != null && status >= 400 && status < 500 && status !== 408) {
      return { outcomeUnknown: false, message: said || `Polymarket refused the order (HTTP ${status}).` }
    }
    return {
      outcomeUnknown: true,
      message: 'Polymarket did not confirm whether it received this order.',
    }
  }
  if (resp.success === false) {
    const said = typeof resp.errorMsg === 'string' && resp.errorMsg.length <= 200 && !/[<>]/.test(resp.errorMsg) ? resp.errorMsg.trim() : ''
    return { outcomeUnknown: false, message: said || 'The venue did not accept the order.' }
  }
  return null
}

function readPosted(resp, orderHash = null) {
  const failure = readPostFailure(resp)
  if (failure) {
    throw Object.assign(new Error(failure.message), {
      raw: resp,
      status: resp?.status,
      outcomeUnknown: failure.outcomeUnknown,
      // The id this order has on the venue, computed BEFORE the post: what lets an answer that never arrived be
      // looked up afterwards (orderProgress). Null when it could not be computed.
      orderHash,
    })
  }
  return {
    orderId: resp?.orderID ?? resp?.orderId ?? resp?.id ?? null,
    status: resp?.status ?? (resp?.success ? 'accepted' : null),
    orderHash,
    raw: resp,
  }
}

/**
 * The order's EIP-712 hash — the id the exchange contract and the venue know the order by — computed from the
 * SIGNED order the SDK built, before anything is posted. It uses only what the package exports
 * (`ExchangeOrderBuilder.buildOrderTypedData/buildOrderHash`, `getContractConfig`): the exchange the order is
 * signed for is the neg-risk one or not exactly as `createOrder` picks it. Pinned to the SDK's own output by
 * test/predict/orderHash.test.js. Null when it cannot be computed — never a guess; the order is still posted.
 */
export function signedOrderHash(order, negRisk) {
  try {
    const cfg = getContractConfig(POLYGON)
    const builder = new ExchangeOrderBuilder(negRisk ? cfg.negRiskExchange : cfg.exchange, POLYGON, undefined)
    const hash = builder.buildOrderHash(builder.buildOrderTypedData(order))
    return /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash : null
  } catch {
    return null
  }
}

/**
 * Which exchange contract the order is signed for: the stated flag, else the venue's own answer for this exact
 * token. Anything that is not a boolean REFUSES the order before it is built. The SDK's lookup throws on an
 * error answer but returns (and caches) `undefined` for an answer that simply lacks the field, and the order
 * builder then treats that as "not neg-risk" — a guessed `false` about which contract verifies the signature.
 */
async function resolveNegRisk(client, tokenId, negRisk) {
  const resolved = typeof negRisk === 'boolean' ? negRisk : await client.getNegRisk(String(tokenId))
  if (typeof resolved !== 'boolean') {
    throw new Error('Polymarket did not say which of its exchanges this market settles on, so the order was not built. Nothing was signed.')
  }
  return resolved
}

/**
 * Submit a MARKETABLE order: fill-and-kill at a price LIMIT. `limitPrice` is the worst price the member
 * accepted at review — the SDK signs it as the order's price, so the venue can never fill beyond it and
 * whatever is not filled at or inside it is cancelled, not charged. `amount` is USDC for a buy and shares
 * for a sell (the SDK's `UserMarketOrder` meaning). Same client, same builder attribution and same return
 * shape as `submitOrder`; the signer behind the client is whichever rail the session already uses.
 *
 * Anything other than an order the venue took is THROWN, never returned as "order sent": see
 * `readPostFailure` for the three cases. The thrown error keeps `raw` and `status` (so the hook's region
 * mapping reads it exactly as it reads an SDK throw) and carries `outcomeUnknown` when the venue may have
 * received the order.
 *
 * @param {object} client  makeClobClient result
 * @param {{ tokenId:string, side:'BUY'|'SELL', amount:string, limitPrice:string, negRisk?:boolean, tickSize:string }} order
 */
export async function submitMarketOrder(client, { tokenId, side, amount, limitPrice, negRisk, tickSize }) {
  const sdkSide = side === 'SELL' ? Side.SELL : Side.BUY
  // Build and post are SEPARATE calls (what `createAndPostMarketOrder` does in one) so the order's id is known
  // before the post. The exchange is resolved here exactly as the SDK would resolve it (a stated flag, else the
  // venue's answer for this token — a missing flag is never signed as `false`) and handed back to it, so the
  // same order is signed.
  const resolvedNegRisk = await resolveNegRisk(client, tokenId, negRisk)
  const order = await client.createMarketOrder(
    {
      tokenID: String(tokenId),
      side: sdkSide,
      amount: toSdkNumber(amount),
      price: toSdkNumber(limitPrice),
      orderType: OrderType.FAK,
    },
    { tickSize: String(tickSize), negRisk: resolvedNegRisk },
  )
  const orderHash = signedOrderHash(order, resolvedNegRisk)
  return readPosted(await client.postOrder(order, OrderType.FAK), orderHash)
}

/**
 * The ONE build → hash → post path for a limit (resting-capable) order, shared by `submitRestingOrder` (the
 * amount-first ticket) and `submitOrder` (the fixed-price fallback), so the two cannot drift on what the
 * safety rules are: the exchange is resolved by `resolveNegRisk` (a non-boolean answer refuses the order);
 * price and size cross to the SDK through `toSdkNumber`; the order's id is computed before the post; and the
 * answer is read by `readPosted`, so a refusal THROWS and an answer that never arrived carries
 * `outcomeUnknown`.
 *
 * `tickSize` is passed to the SDK ONLY when the caller knows it (the amount-first ticket reviews on a tick, so
 * a venue tick that has become coarser makes the SDK refuse instead of rounding the member's price). The
 * fixed-price ticket has no reviewed tick: it leaves the option out and the SDK resolves the venue's current
 * tick for the token itself — a tick is never invented here.
 */
async function buildAndPostLimit(client, { tokenId, side, price, size, negRisk, tickSize, orderType }) {
  const resolvedNegRisk = await resolveNegRisk(client, tokenId, negRisk)
  const order = await client.createOrder(
    { tokenID: String(tokenId), price: toSdkNumber(price), side: side === 'SELL' ? Side.SELL : Side.BUY, size: toSdkNumber(size) },
    { ...(tickSize != null ? { tickSize: String(tickSize) } : {}), negRisk: resolvedNegRisk },
  )
  const orderHash = signedOrderHash(order, resolvedNegRisk)
  return readPosted(await client.postOrder(order, orderType), orderHash)
}

/**
 * Submit a RESTING order (GTC) at a price the member named, for the amount-first ticket. `tickSize` is the tick
 * the member reviewed on (see `buildAndPostLimit`).
 *
 * @param {object} client  makeClobClient result
 * @param {{ tokenId:string, side:'BUY'|'SELL', price:string, size:string, negRisk?:boolean, tickSize:string }} order
 */
export function submitRestingOrder(client, { tokenId, side, price, size, negRisk, tickSize }) {
  return buildAndPostLimit(client, { tokenId, side, price, size, negRisk, tickSize, orderType: OrderType.GTC })
}

/**
 * Submit a fixed-price order — the spec-057 fallback ticket's path. Same build → hash → post and the same
 * answer reading as `submitRestingOrder`: a refusal is thrown, never returned as "order sent"; an answer that
 * never arrived is thrown with `outcomeUnknown`; `orderHash` is known before the post. No `tickSize`: this path
 * has none to pass, so the SDK resolves it. `negRisk` is a stated boolean or left out (the venue is asked).
 * Returns { orderId, status, orderHash, raw }.
 *
 * @param {object} client  makeClobClient result
 * @param {{ tokenId:string, side:'BUY'|'SELL', price:string|number, size:string|number, negRisk?:boolean, orderType?:string }} order
 */
export function submitOrder(client, { tokenId, side, price, size, negRisk, orderType = OrderType.GTC }) {
  return buildAndPostLimit(client, { tokenId, side, price, size, negRisk, orderType })
}

/**
 * The SDK's per-tick rounding table (`ROUNDING_CONFIG` in clob-client's order-builder helpers, which the
 * package does not export): price decimals, and the decimals of the derived amount. The size/amount input is
 * always rounded to 2 decimals. Pinned to the real SDK by test/predict/signedAmounts.test.js — if a
 * release changes the table, that test fails before a figure can drift from what is signed.
 */
const ROUNDING = {
  '0.1': { price: 1, amount: 3 },
  '0.01': { price: 2, amount: 4 },
  '0.001': { price: 3, amount: 5 },
  '0.0001': { price: 4, amount: 6 },
}
const pow10 = (n) => 10n ** BigInt(n)
const ceilDiv = (a, b) => (a + b - 1n) / b

/** floor(n/d) at `amountDecimals`, after the SDK's "round up at +4 decimals, then down" dance — exact. */
function sdkDerivedAmount(n, d, amountDecimals) {
  const ceiledAtPlus4 = ceilDiv(n * pow10(amountDecimals + 4), d)
  return (ceiledAtPlus4 / pow10(4)) * pow10(6 - amountDecimals)
}

function gridOf(tickSize, limitPrice) {
  const cfg = ROUNDING[String(tickSize)]
  const tick = toMicroStrict(String(tickSize))
  const price = toMicroStrict(String(limitPrice))
  if (!cfg || tick == null || price == null) return null
  return { cfg, tick, price }
}

/**
 * What the SDK will SIGN for a market order (`createMarketOrder`): the maker/taker amounts and the price,
 * as decimal strings. Pure BigInt.
 *
 * The MAKER amount (what the member gives: USDC on a buy, shares on a sell) is exact for every input, and it
 * is the figure the review shows as "You pay at most" / "You sell up to". The TAKER amount (the minimum the
 * member receives) is derived, and the SDK derives it in floating point. Measured against the installed SDK
 * over 200,000 random orders on every tick (2026-11-26):
 *   - the maker amount never differed;
 *   - a taker amount under 100,000 (shares or USDC) never differed (146,899 orders);
 *   - from 100,000 up to a billion it differed in about 1 order in 50, by ONE step of the last decimal place
 *     the SDK signs on that tick (0.0001 at a 0.01 tick, 0.00001 at 0.001, 0.000001 at 0.0001);
 *   - above a billion the SDK's arithmetic runs out of precision and the difference grows (20 steps at tens
 *     of billions) — sizes no book here has the depth for.
 * That is measured, not proven, which is why no surface shows the taker amount as an exact figure: shares
 * are "about".
 *
 *  - BUY: maker = USDC spent = `amount` rounded DOWN to cents (the SDK's 2-decimal input rounding);
 *    taker = the minimum shares = maker ÷ price at the tick's amount precision.
 *  - SELL: maker = shares sold = `amount` rounded DOWN to 0.01; taker = the minimum USDC = shares × price.
 *
 * Returns null for anything the SDK itself would refuse (price outside [tick, 1 − tick], an unknown tick, a
 * non-decimal) — a figure is never invented for an order that would not be built.
 *
 * @returns {{ side:'BUY'|'SELL', maker:string, taker:string, makerUnits:bigint, takerUnits:bigint, price:string } | null}
 */
export function marketOrderSignedAmounts({ side, amount, limitPrice, tickSize }) {
  const grid = gridOf(tickSize, limitPrice)
  const amt = toMicroStrict(String(amount))
  if (!grid || amt == null) return null
  const { cfg, tick, price } = grid
  // The SDK floors the price to the tick's decimals (a price already on the grid is unchanged).
  const priceUnits = price - (price % pow10(6 - cfg.price))
  if (priceUnits < tick || priceUnits > MICRO - tick) return null
  const makerUnits = amt - (amt % 10_000n) // roundDown(amount, 2)
  if (makerUnits <= 0n) return null
  const buy = side !== 'SELL'
  const takerUnits = buy
    ? sdkDerivedAmount(makerUnits, priceUnits, cfg.amount)
    : sdkDerivedAmount(makerUnits * priceUnits, MICRO * MICRO, cfg.amount)
  return {
    side: buy ? 'BUY' : 'SELL',
    maker: microToDecimal(makerUnits),
    taker: microToDecimal(takerUnits),
    makerUnits,
    takerUnits,
    price: microToDecimal(priceUnits),
  }
}

/**
 * What the SDK will sign for a RESTING (GTC) order from `submitOrder` (`createOrder`): `shares` is rounded
 * DOWN to 0.01 and the other leg is shares × price. Same contract as `marketOrderSignedAmounts`.
 *
 * @returns {{ side:'BUY'|'SELL', shares:string, usdc:string, makerUnits:bigint, takerUnits:bigint, price:string } | null}
 */
export function restingOrderSignedAmounts({ side, shares, limitPrice, tickSize }) {
  const grid = gridOf(tickSize, limitPrice)
  const size = toMicroStrict(String(shares))
  if (!grid || size == null) return null
  const { cfg, tick, price } = grid
  if (price % pow10(6 - cfg.price) !== 0n) return null // a resting price is never silently re-rounded
  if (price < tick || price > MICRO - tick) return null
  const sharesUnits = size - (size % 10_000n)
  if (sharesUnits <= 0n) return null
  const usdcUnits = sdkDerivedAmount(sharesUnits * price, MICRO * MICRO, cfg.amount)
  const buy = side !== 'SELL'
  return {
    side: buy ? 'BUY' : 'SELL',
    shares: microToDecimal(sharesUnits),
    usdc: microToDecimal(usdcUnits),
    makerUnits: buy ? usdcUnits : sharesUnits,
    takerUnits: buy ? sharesUnits : usdcUnits,
    price: microToDecimal(price),
  }
}

export const TRADES_SLACK_SECONDS = 3600

/**
 * Look ONE order up by id with the member's own session (spec 114 slice 6). Never posts, never signs. Three
 * outcomes, because they mean three different things to the tracker:
 *   - `found`: the venue returned the order — `order` is its record, `trades` is not read;
 *   - `absent`: the venue answered "no such order" (a 404 or an empty answer) AND the member's trades for that
 *     token were read and none refers to this id. NOT proof it was never received — a fill-and-kill order that
 *     found nothing to match may simply not be kept — which is why the caller decides what absence means;
 *   - `unreadable`: anything else (transport failure, a throw, an answer in a shape this does not recognise).
 *     Not a fact about the order.
 * The order returned is checked against what was signed (token and side) so an answer about a DIFFERENT order is
 * `unreadable`, never adopted.
 *
 * @param {object} client  makeClobClient result
 * @param {{ orderId:string, tokenId:string, side:'BUY'|'SELL', since:number }} ref  `since` is ms epoch
 */
export async function lookupOrder(client, { orderId, tokenId, side, since }) {
  let answer
  try {
    answer = await client.getOrder(String(orderId))
  } catch {
    return { kind: 'unreadable' }
  }
  const notFound = answer == null || (typeof answer === 'object' && 'error' in answer && answer.status === 404) ||
    (typeof answer === 'object' && !('error' in answer) && Object.keys(answer).length === 0)
  if (!notFound) {
    if (typeof answer !== 'object' || 'error' in answer || typeof answer.status !== 'string') return { kind: 'unreadable' }
    const sameId = answer.id == null || String(answer.id).toLowerCase() === String(orderId).toLowerCase()
    const sameToken = answer.asset_id == null || String(answer.asset_id) === String(tokenId)
    const sameSide = answer.side == null || String(answer.side).toUpperCase() === side
    return sameId && sameToken && sameSide ? { kind: 'found', order: answer } : { kind: 'unreadable' }
  }
  // Not found as an order: did it match? The member's own trades name the order they came from.
  let trades
  try {
    // An hour of slack before the time the order was signed: the device's clock may be wrong, and a trade left
    // out of the window is a fill this lookup would never see.
    trades = await client.getTrades({ asset_id: String(tokenId), after: String(Math.max(0, Math.floor(since / 1000) - TRADES_SLACK_SECONDS)) })
  } catch {
    return { kind: 'unreadable' }
  }
  if (!Array.isArray(trades)) return { kind: 'unreadable' }
  const id = String(orderId).toLowerCase()
  const mine = trades.filter(
    (t) => String(t?.taker_order_id ?? '').toLowerCase() === id || (Array.isArray(t?.maker_orders) && t.maker_orders.some((m) => String(m?.order_id ?? '').toLowerCase() === id)),
  )
  return { kind: 'absent', trades: mine }
}

/** Cancel one open order by id. Returns { cancelled, raw }. */
export async function cancelOrder(client, orderId) {
  const resp = await client.cancelOrder({ orderID: String(orderId) })
  return { cancelled: Boolean(resp?.canceled ?? resp?.success ?? true), raw: resp }
}

/** The member's open orders (optionally scoped to one market/condition). Returns an array. */
export async function fetchOpenOrders(client, { market } = {}) {
  const orders = await client.getOpenOrders(market ? { market: String(market) } : undefined)
  return Array.isArray(orders) ? orders : (orders?.data ?? [])
}

export { Side, OrderType }
