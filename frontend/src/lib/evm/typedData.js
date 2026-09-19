/**
 * EIP-712 typed-data seam (spec 110 T028).
 *
 * `ethers.TypedDataEncoder.hash(domain, types, message)` INFERS the primary type; viem's
 * `hashTypedData` requires it. That is not a nicety to paper over with `Object.keys(types)[0]`:
 * for a nested table the first key may be a SUB-type, and viem will happily hash against it when
 * the message shape allows — producing a valid signature over the wrong structure, which is the
 * one failure mode no assertion about the message can see. So the inference is written out, and
 * it is ethers' own rule: the primary type is the type no OTHER type references.
 *
 * Checked against `TypedDataEncoder.from(types).primaryType` over all 32 real intent tables plus
 * nested, array-of-sub-type, two-level and declaration-order-reversed shapes — identical.
 *
 * ONE DELIBERATE DIFFERENCE, stated rather than hidden. ethers THROWS when the table also carries
 * an `EIP712Domain` entry ("ambiguous primary types or unused types"); this filters it out and
 * answers normally. A table that declares its own domain type is ordinary EIP-712 and viem accepts
 * it, so ethers' refusal is the odd one out — but it IS a case where something that used to be
 * refused now succeeds, so it is written down here rather than discovered later.
 *
 * A genuinely ambiguous table — two unreferenced roots — returns null, exactly as ethers refused.
 * The caller throws; nothing guesses.
 */
import { hashTypedData } from 'viem'

/**
 * @param {Record<string, Array<{name: string, type: string}>>} types
 * @returns {string|null} the inferred primary type, or null when the table has no single root
 */
export function primaryTypeOf(types) {
  if (!types || typeof types !== 'object') return null
  const names = Object.keys(types).filter((n) => n !== 'EIP712Domain')
  const referenced = new Set()
  for (const name of names) {
    for (const field of types[name] || []) {
      // `Person[]`, `Person[2]`, `Person[][3]` all reference `Person`.
      const base = String(field?.type ?? '').replace(/(\[\d*\])+$/, '')
      if (base !== name && names.includes(base)) referenced.add(base)
    }
  }
  const roots = names.filter((n) => !referenced.has(n))
  return roots.length === 1 ? roots[0] : null
}

/**
 * `ethers.TypedDataEncoder.hash(domain, types, message)`, byte-for-byte, on viem.
 *
 * @throws {Error} when the primary type cannot be inferred — never a guessed one.
 */
export function hashTypedDataLike(domain, types, message) {
  const primaryType = primaryTypeOf(types)
  if (!primaryType) {
    throw new Error('hashTypedDataLike: ambiguous typed-data table — no single primary type, so nothing has been signed.')
  }
  return hashTypedData({ domain, types, primaryType, message })
}
