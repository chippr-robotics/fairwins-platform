/**
 * The portable signed-message document (Protect ▸ Verify).
 *
 * A signature on its own proves nothing a verifier can check: EIP-191 recovery yields
 * *some* address, and an ERC-1271 signature (a passkey smart account, spec 041) does not
 * recover at all — it can only be checked by asking the account contract, on ONE chain.
 * So the thing a member hands to a counterparty is not the signature, it is this document:
 * the claim (address + chain), the exact message bytes, and the signature that binds them.
 *
 * Two rules the rest of the feature depends on:
 *
 * 1. **`scheme` is a HINT, never authority.** It records how the signature was produced so
 *    the verifier can try the likely path first. `verifyMessage` still tries both and
 *    reaches its own verdict — a document claiming `eip191` over ERC-1271 bytes verifies
 *    exactly as well (or as badly) as one labelled honestly.
 * 2. **The message is carried verbatim.** Whitespace, trailing newlines and Unicode are all
 *    signed bytes; normalizing any of them here would silently invalidate a good signature.
 *    JSON round-trips them exactly, which is why the transport is JSON rather than a
 *    hand-rolled block format.
 */

import { getAddress } from 'viem'
/** Format tag. Bump the suffix only for a breaking field change; `parseSignedMessage` gates on it. */
export const SIGNED_MESSAGE_FORMAT = 'fairwins-signed-message/1'

/** How the signature bytes were produced. */
export const SIGN_SCHEMES = Object.freeze({
  /** Plain ECDSA over the EIP-191 personal-message digest — recoverable, chain-independent. */
  EIP191: 'eip191',
  /** Contract-account signature (spec 041 passkey accounts) — verifiable only on its chain. */
  ERC1271: 'erc1271',
})

/**
 * Build the document for a freshly produced signature.
 *
 * `chainId` is REQUIRED for an ERC-1271 signature (there is no way to check one without
 * knowing which chain hosts the account) and kept for EIP-191 too, purely as provenance —
 * verification of an EIP-191 signature never consults it.
 */
export function buildSignedMessage({ address, chainId, message, signature, scheme, signedAt }) {
  if (!address) throw new Error('buildSignedMessage: address is required')
  if (typeof message !== 'string') throw new Error('buildSignedMessage: message must be a string')
  if (!signature) throw new Error('buildSignedMessage: signature is required')
  if (scheme === SIGN_SCHEMES.ERC1271 && chainId == null) {
    throw new Error('buildSignedMessage: an ERC-1271 signature must record the chain it can be checked on')
  }
  return {
    format: SIGNED_MESSAGE_FORMAT,
    address: getAddress(address),
    chainId: chainId == null ? null : Number(chainId),
    scheme,
    message,
    signature,
    signedAt: signedAt ?? new Date().toISOString(),
  }
}

/** Serialize for the clipboard / a file — pretty-printed, because a human pastes this into a chat. */
export function serializeSignedMessage(doc) {
  return JSON.stringify(doc, null, 2)
}

/**
 * Parse a pasted document.
 *
 * Deliberately tolerant about SHAPE and strict about MEANING: unknown extra keys are fine
 * (a future version may add provenance), but a missing message/signature is refused rather
 * than defaulted, because a defaulted field would verify against something the signer never
 * signed. Returns `{ ok, doc, error }` — never throws, since the input is member-pasted text.
 */
export function parseSignedMessage(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'Paste a signed-message document to read it.' }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: "That doesn't look like a signed-message document — it isn't valid JSON." }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'A signed-message document is a JSON object.' }
  }
  if (raw.format !== SIGNED_MESSAGE_FORMAT) {
    return {
      ok: false,
      error: `Unrecognized document format ${JSON.stringify(String(raw.format ?? 'none'))} — expected ${SIGNED_MESSAGE_FORMAT}.`,
    }
  }
  if (typeof raw.message !== 'string') return { ok: false, error: 'The document has no message.' }
  if (typeof raw.signature !== 'string' || !raw.signature) {
    return { ok: false, error: 'The document has no signature.' }
  }
  let address = null
  if (raw.address != null) {
    try {
      address = getAddress(String(raw.address))
    } catch {
      return { ok: false, error: `The document's address (${String(raw.address)}) is not a valid address.` }
    }
  }
  const chainId = raw.chainId == null || raw.chainId === '' ? null : Number(raw.chainId)
  if (chainId != null && !Number.isFinite(chainId)) {
    return { ok: false, error: "The document's chain id is not a number." }
  }
  return {
    ok: true,
    doc: {
      format: raw.format,
      address,
      chainId,
      // A scheme we don't recognize is carried through as null rather than rejected: it is a
      // hint, and verification does not need it (rule 1 above).
      scheme: raw.scheme === SIGN_SCHEMES.EIP191 || raw.scheme === SIGN_SCHEMES.ERC1271 ? raw.scheme : null,
      message: raw.message,
      signature: raw.signature,
      signedAt: typeof raw.signedAt === 'string' ? raw.signedAt : null,
    },
  }
}

/** True when the text looks like a document rather than a bare signature — drives paste auto-fill. */
export function looksLikeSignedMessage(text) {
  return typeof text === 'string' && text.includes(SIGNED_MESSAGE_FORMAT)
}
