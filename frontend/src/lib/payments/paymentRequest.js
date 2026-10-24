import { getAddress, isAddress } from 'viem'
import { parseUnits } from '../evm/units'
/**
 * Payment-request URIs (spec 058 US2) — build and parse the EIP-681 subset
 * FairWins uses for its Request QR codes:
 *
 *   ERC-20 (stablecoin):
 *     ethereum:<tokenAddress>@<chainId>/transfer?address=<to>&uint256=<units>[&message=<note>]
 *   Native coin:
 *     ethereum:<to>@<chainId>?value=<units>[&message=<note>]
 *
 * The `message` parameter is additive: standard wallets ignore unknown
 * params, FairWins reads it back. Amounts are base-unit integer strings
 * (parseUnits) — never floats, never scientific notation.
 *
 * This module is pure (no hooks, no I/O) and deliberately separate from
 * lib/addressBook/scanAddress.js, whose regex-only address extraction stays
 * untouched for its existing callers.
 *
 * Contract: specs/058-send-request-home/contracts/payment-request-uri.md
 */

export const NOTE_MAX_LENGTH = 280

const RAW_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Build an EIP-681 payment-request URI.
 *
 * @param {object} input
 * @param {number} input.chainId - network the request is payable on (always encoded)
 * @param {string} input.to - requester's receiving address
 * @param {'stable'|'native'} input.kind - selects the URI shape
 * @param {string} [input.tokenAddress] - token contract (required for kind 'stable')
 * @param {number} input.decimals - token/native decimals for base-unit conversion
 * @param {string} input.amount - human-readable decimal amount (> 0)
 * @param {string} [input.note] - optional note; trimmed, capped, URL-encoded
 * @returns {string} the URI
 */
export function buildPaymentRequestUri({ chainId, to, kind, tokenAddress, decimals, amount, note }) {
  if (!isAddress(to)) throw new Error('A valid receiving address is required.')
  if (!Number.isInteger(Number(chainId)) || Number(chainId) <= 0) {
    throw new Error('A valid chain id is required.')
  }
  if (kind === 'stable' && !isAddress(tokenAddress || '')) {
    throw new Error('A token address is required for a stablecoin request.')
  }

  let units
  try {
    units = parseUnits(String(amount), decimals)
  } catch {
    throw new Error('Enter a valid amount.')
  }
  if (units <= 0n) throw new Error('Enter an amount greater than zero.')

  const trimmedNote = typeof note === 'string' ? note.trim().slice(0, NOTE_MAX_LENGTH) : ''
  const messageParam = trimmedNote ? `&message=${encodeURIComponent(trimmedNote)}` : ''

  if (kind === 'stable') {
    return `ethereum:${tokenAddress}@${Number(chainId)}/transfer?address=${to}&uint256=${units.toString()}${messageParam}`
  }
  return `ethereum:${to}@${Number(chainId)}?value=${units.toString()}${messageParam}`
}

/** Parse an EIP-681 chain id (`@1`, `@0x89`); null on anything malformed. */
function parseChainId(raw) {
  if (!raw) return null
  const n = /^0x[0-9a-fA-F]+$/.test(raw) ? Number.parseInt(raw, 16) : /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Parse a base-unit integer param into a bigint; null on anything malformed. */
function parseUnitsParam(raw) {
  if (raw == null || !/^\d+$/.test(raw)) return null
  try {
    return BigInt(raw)
  } catch {
    return null
  }
}

/** Checksum-normalize an address-ish string; null unless it's a valid address. */
function normalizeAddress(raw) {
  if (!raw || !RAW_ADDRESS_RE.test(raw)) return null
  try {
    return getAddress(raw.toLowerCase())
  } catch {
    return null
  }
}

/**
 * Parse a scanned string into a payment request.
 *
 * Accepts full EIP-681 token (`/transfer`) and native forms, bare
 * `ethereum:<address>` URIs, and raw 0x addresses. Returns null for anything
 * unrecognizable (the caller shows a "code not usable" message). Malformed
 * numeric params degrade to an address-only prefill — never a wrong amount.
 *
 * @param {string} decodedText
 * @returns {{to: string, chainId: number|null, tokenAddress: string|null,
 *   amountUnits: bigint|null, note: string|null} | null}
 */
export function parsePaymentRequest(decodedText) {
  if (typeof decodedText !== 'string') return null
  const text = decodedText.trim()
  if (!text) return null

  // Raw address — recipient-only prefill (FR-009).
  const rawAddr = normalizeAddress(text)
  if (rawAddr) return { to: rawAddr, chainId: null, tokenAddress: null, amountUnits: null, note: null }

  if (!/^ethereum:/i.test(text)) return null

  // ethereum:[pay-]<target>[@chainId][/<function>][?query]
  const body = text.slice('ethereum:'.length).replace(/^pay-/i, '')
  const [beforeQuery, queryString = ''] = splitOnce(body, '?')
  const [targetPart, functionName = null] = splitOnce(beforeQuery, '/')
  const [targetRaw, chainRaw = null] = splitOnce(targetPart, '@')

  const target = normalizeAddress(targetRaw)
  if (!target) return null
  const chainId = parseChainId(chainRaw)

  // URLSearchParams handles the %XX decoding of `message` and ignores params
  // we don't know about.
  const params = new URLSearchParams(queryString)
  const note = params.get('message') || null

  if (functionName != null) {
    // Token form: only `transfer` is a payment request we understand.
    if (functionName !== 'transfer') return null
    const to = normalizeAddress(params.get('address'))
    if (!to) return null
    return { to, chainId, tokenAddress: target, amountUnits: parseUnitsParam(params.get('uint256')), note }
  }

  // Native form (a bare `ethereum:<address>` URI is the amount-less case).
  return { to: target, chainId, tokenAddress: null, amountUnits: parseUnitsParam(params.get('value')), note }
}

/** Split on the FIRST occurrence only; [head, tail|fallback]. */
function splitOnce(str, sep) {
  const i = str.indexOf(sep)
  return i === -1 ? [str, undefined] : [str.slice(0, i), str.slice(i + 1)]
}
