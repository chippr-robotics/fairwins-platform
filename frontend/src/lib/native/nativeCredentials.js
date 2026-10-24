/**
 * Native passkey ceremony bridge (spec 102 R3/R3a,
 * contracts/native-runtime-seams.md §2).
 *
 * A `navigator.credentials`-shaped adapter over `@capgo/capacitor-passkey`,
 * consumed by `lib/passkey/credentials.js` through its existing
 * `deps.credentials` seam — everything above that file (PRF-derived keys,
 * smart account, signing) cannot tell which rail ran.
 *
 * Two encoding hazards this adapter exists to absorb, both found by reading
 * the plugin source (R3a):
 *
 *  1. REQUEST extensions are JSON-cloned by the plugin
 *     (`cloneExtensions = JSON.parse(JSON.stringify(...))`), which mangles a
 *     `Uint8Array` PRF salt into an index-keyed object. The adapter
 *     pre-encodes extension binary fields to WebAuthn-JSON base64url strings,
 *     which the clone then carries losslessly and the platform APIs expect.
 *
 *  2. RESPONSE fields arrive as WebAuthn-JSON (base64url strings), while the
 *     credential layer reads WebAuthn-API shapes (`ArrayBuffer`s,
 *     `getPublicKey()`, `getClientExtensionResults()` with PRF results as
 *     buffers). The adapter decodes — including `prf.results.first/second` —
 *     so a PRF output that the native ceremony DID produce round-trips intact
 *     (contract §2: PRF round-trips or the ceremony refuses; a silently
 *     dropped PRF output would surface as an account that signs in but
 *     cannot derive its keys).
 */

function base64urlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function bytesToBase64url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let raw = ''
  for (const b of bytes) raw += String.fromCharCode(b)
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const isBinary = (v) => v instanceof Uint8Array || v instanceof ArrayBuffer

/** Deep-copy extensions with every binary leaf encoded base64url (WebAuthn JSON). */
export function encodeExtensionBinaries(value) {
  if (value === undefined || value === null) return value
  if (isBinary(value)) return bytesToBase64url(value)
  if (Array.isArray(value)) return value.map(encodeExtensionBinaries)
  if (typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = encodeExtensionBinaries(entry)
    return out
  }
  return value
}

/** Decode the PRF leaves of clientExtensionResults back to buffers. */
export function decodePrfResults(clientExtensionResults) {
  if (!clientExtensionResults || typeof clientExtensionResults !== 'object') return {}
  const out = { ...clientExtensionResults }
  const prf = out.prf
  if (prf && typeof prf === 'object') {
    const results = prf.results && typeof prf.results === 'object' ? { ...prf.results } : undefined
    if (results) {
      for (const slot of ['first', 'second']) {
        if (typeof results[slot] === 'string') results[slot] = base64urlToBytes(results[slot]).buffer
      }
    }
    out.prf = { ...prf, ...(results ? { results } : {}) }
  }
  return out
}

function decodeResponse(json) {
  const base = { clientDataJSON: base64urlToBytes(json.clientDataJSON).buffer }
  if ('attestationObject' in json) {
    return {
      ...base,
      attestationObject: base64urlToBytes(json.attestationObject).buffer,
      getPublicKey: () => (json.publicKey ? base64urlToBytes(json.publicKey).buffer : null),
      getPublicKeyAlgorithm: () => json.publicKeyAlgorithm ?? -7,
      getTransports: () => (json.transports ? [...json.transports] : []),
      getAuthenticatorData: () => (json.authenticatorData ? base64urlToBytes(json.authenticatorData).buffer : null),
    }
  }
  return {
    ...base,
    authenticatorData: base64urlToBytes(json.authenticatorData).buffer,
    signature: base64urlToBytes(json.signature).buffer,
    userHandle: json.userHandle ? base64urlToBytes(json.userHandle).buffer : null,
  }
}

/** WebAuthn-JSON credential -> the PublicKeyCredential shape the layer reads. */
export function credentialFromJson(json) {
  const extensions = decodePrfResults(json.clientExtensionResults)
  return {
    type: 'public-key',
    id: json.id,
    rawId: base64urlToBytes(json.rawId ?? json.id).buffer,
    authenticatorAttachment: json.authenticatorAttachment ?? null,
    response: decodeResponse(json.response),
    getClientExtensionResults: () => extensions,
  }
}

function withEncodedExtensions(publicKey) {
  if (!publicKey?.extensions) return publicKey
  return { ...publicKey, extensions: encodeExtensionBinaries(publicKey.extensions) }
}

/**
 * The credentials-shaped adapter. `loadPlugin` is injectable for tests; the
 * default lazy-imports the plugin so the web bundle never pays for it.
 */
export function nativeCredentialManager({
  loadPlugin = () => import('@capgo/capacitor-passkey').then((m) => m.CapacitorPasskey),
} = {}) {
  return {
    async create(options) {
      const plugin = await loadPlugin()
      const json = await plugin.createCredential({ ...options, publicKey: withEncodedExtensions(options.publicKey) })
      return credentialFromJson(json)
    },
    async get(options) {
      const plugin = await loadPlugin()
      const json = await plugin.getCredential({ ...options, publicKey: withEncodedExtensions(options.publicKey) })
      return credentialFromJson(json)
    },
  }
}
