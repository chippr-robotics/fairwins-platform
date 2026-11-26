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
import { ClobClient, Side, OrderType } from '@polymarket/clob-client'

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

/**
 * Submit a signed CLOB order (build + sign + post in one call — the SDK resolves tick size, fee rate, and
 * negRisk, and rounds amounts). Returns { orderId, status, raw }.
 * @param {object} client  makeClobClient result
 * @param {{ tokenId, side:'BUY'|'SELL', price:number, size:number, negRisk?:boolean, orderType?:string }} order
 */
export async function submitOrder(client, { tokenId, side, price, size, negRisk, orderType = OrderType.GTC }) {
  const resp = await client.createAndPostOrder(
    { tokenID: String(tokenId), price: Number(price), side: side === 'SELL' ? Side.SELL : Side.BUY, size: Number(size) },
    { negRisk: Boolean(negRisk) },
    orderType,
  )
  return {
    orderId: resp?.orderID ?? resp?.orderId ?? resp?.id ?? null,
    status: resp?.status ?? (resp?.success ? 'accepted' : null),
    raw: resp,
  }
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
 * Submit a MARKETABLE order: fill-and-kill at a price LIMIT. `limitPrice` is the worst price the member
 * accepted at review — the SDK signs it as the order's price, so the venue can never fill beyond it and
 * whatever is not filled at or inside it is cancelled, not charged. `amount` is USDC for a buy and shares
 * for a sell (the SDK's `UserMarketOrder` meaning). Same client, same builder attribution and same return
 * shape as `submitOrder`; the signer behind the client is whichever rail the session already uses.
 *
 * An answer that carries an error (or `success: false`) is thrown, not returned: the venue refusing an
 * order must never reach the caller as an "order sent". The thrown error keeps `raw` and `status` so the
 * hook's region / price-moved mapping reads it exactly as it reads an SDK throw.
 *
 * @param {object} client  makeClobClient result
 * @param {{ tokenId:string, side:'BUY'|'SELL', amount:string, limitPrice:string, negRisk?:boolean, tickSize:string }} order
 */
export async function submitMarketOrder(client, { tokenId, side, amount, limitPrice, negRisk, tickSize }) {
  const sdkSide = side === 'SELL' ? Side.SELL : Side.BUY
  const resp = await client.createAndPostMarketOrder(
    {
      tokenID: String(tokenId),
      side: sdkSide,
      amount: toSdkNumber(amount),
      price: toSdkNumber(limitPrice),
      orderType: OrderType.FAK,
    },
    { tickSize: String(tickSize), negRisk: Boolean(negRisk) },
    OrderType.FAK,
  )
  const refusal = typeof resp?.error === 'string' && resp.error ? resp.error : resp?.success === false ? resp?.errorMsg || 'The venue did not accept the order.' : null
  if (refusal) {
    throw Object.assign(new Error(refusal), { raw: resp, status: resp?.status })
  }
  return {
    orderId: resp?.orderID ?? resp?.orderId ?? resp?.id ?? null,
    status: resp?.status ?? (resp?.success ? 'accepted' : null),
    raw: resp,
  }
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
 * as exact decimal strings. The review shows these, so what is shown is what is signed. Pure BigInt.
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
