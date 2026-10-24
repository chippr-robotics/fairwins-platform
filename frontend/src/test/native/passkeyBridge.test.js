import { describe, it, expect, vi, beforeEach } from 'vitest'

// Spec 102 contract §2 — the passkey bridge is credentials-shaped and
// rail-blind from above. The two rules with teeth:
//  · A Uint8Array PRF salt reaches the plugin as a base64url STRING (the
//    plugin JSON-clones extensions; an index-keyed object mangle is exactly
//    what the adapter absorbs).
//  · A PRF result in the JSON response round-trips back to a buffer the
//    credential layer can read — dropped PRF is an account that signs in
//    but cannot derive keys.

const platformRef = { value: 'ios', plugins: { CapacitorPasskey: true } }
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => platformRef.value,
    isPluginAvailable: (name) => Boolean(platformRef.plugins[name]),
  },
}))

import {
  nativeCredentialManager,
  encodeExtensionBinaries,
  decodePrfResults,
} from '../../lib/native/nativeCredentials'
import { createCredential, getAssertion, detectCapability, AuthenticatorUnavailable } from '../../lib/passkey/credentials'
import { __resetRuntimeForTests } from '../../lib/native/runtime'

const b64u = (bytes) => Buffer.from(bytes).toString('base64url')

function assertionJson({ prf } = {}) {
  return {
    id: 'cred-native-1',
    rawId: b64u(Buffer.from('cred-native-1')),
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: b64u(Buffer.from('{"type":"webauthn.get"}')),
      authenticatorData: b64u(Buffer.alloc(37, 7)),
      signature: b64u(Buffer.alloc(64, 9)),
      userHandle: null,
    },
    clientExtensionResults: prf ? { prf: { results: { first: b64u(prf) } } } : {},
  }
}

function attestationJson() {
  // SPKI whose last 65 bytes are an uncompressed P-256 point (0x04 || x || y).
  const point = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(32, 1), Buffer.alloc(32, 2)])
  const spki = Buffer.concat([Buffer.alloc(26, 0x30), point])
  return {
    id: 'cred-new-1',
    rawId: b64u(Buffer.from('cred-new-1')),
    response: {
      clientDataJSON: b64u(Buffer.from('{"type":"webauthn.create"}')),
      attestationObject: b64u(Buffer.alloc(16, 3)),
      publicKey: b64u(spki),
      publicKeyAlgorithm: -7,
      transports: ['internal'],
    },
    clientExtensionResults: { prf: { enabled: true } },
  }
}

describe('native passkey bridge', () => {
  beforeEach(() => {
    platformRef.value = 'ios'
    platformRef.plugins = { CapacitorPasskey: true }
    __resetRuntimeForTests()
  })

  it('encodes binary extension leaves as base64url strings for the plugin', () => {
    const salt = new Uint8Array(32).fill(5)
    const encoded = encodeExtensionBinaries({ prf: { eval: { first: salt } } })
    expect(typeof encoded.prf.eval.first).toBe('string')
    expect(encoded.prf.eval.first).toBe(b64u(salt))
    // Survives the plugin's JSON clone byte-identically.
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded)
  })

  it('decodes PRF results back to buffers, and leaves prf.enabled alone', () => {
    const out = decodePrfResults({ prf: { results: { first: b64u(Buffer.alloc(32, 8)) } } })
    expect(new Uint8Array(out.prf.results.first)).toEqual(new Uint8Array(32).fill(8))
    expect(decodePrfResults({ prf: { enabled: true } }).prf.enabled).toBe(true)
  })

  it('getAssertion over the bridge returns the same shape as the web rail, PRF intact', async () => {
    const prfBytes = Buffer.alloc(32, 4)
    const getCredential = vi.fn(async (options) => {
      // The salt reached the plugin as a JSON-safe string, not a mangled object.
      expect(typeof options.publicKey.extensions.prf.eval.first).toBe('string')
      return assertionJson({ prf: prfBytes })
    })
    const manager = nativeCredentialManager({ loadPlugin: async () => ({ getCredential, createCredential: vi.fn() }) })

    const result = await getAssertion({
      challenge: new Uint8Array(32),
      credentialId: b64u(Buffer.from('cred-native-1')),
      prfSalt: new Uint8Array(32).fill(6),
      deps: { credentials: { get: manager.get, create: manager.create } },
    })

    expect(result.credentialId).toBe('cred-native-1')
    expect(result.signature).toEqual(new Uint8Array(64).fill(9))
    expect(result.authenticatorData).toEqual(new Uint8Array(37).fill(7))
    expect(result.prfOutput).toEqual(new Uint8Array(prfBytes))
  })

  it('createCredential over the bridge yields the P-256 point and prfCapable', async () => {
    const manager = nativeCredentialManager({
      loadPlugin: async () => ({ createCredential: async () => attestationJson(), getCredential: vi.fn() }),
    })
    const entry = await createCredential({ label: 'Phone', deps: { credentials: manager } })
    expect(entry.credentialId).toBe('cred-new-1')
    expect(entry.publicKey.x).toBe('0x' + '01'.repeat(32))
    expect(entry.publicKey.y).toBe('0x' + '02'.repeat(32))
    expect(entry.prfCapable).toBe(true)
  })

  it('on native WITHOUT the plugin, ceremonies refuse with the seam reason — no dead WebView call', async () => {
    platformRef.plugins = {}
    __resetRuntimeForTests()
    await expect(getAssertion({ challenge: new Uint8Array(32) })).rejects.toBeInstanceOf(AuthenticatorUnavailable)
    const capability = await detectCapability()
    expect(capability.available).toBe(false)
    expect(capability.reason).toMatch(/passkey/i)
  })

  it('on web, detectCapability keeps the browser answer (rail-blind above the seam)', async () => {
    platformRef.value = 'web'
    __resetRuntimeForTests()
    const capability = await detectCapability({})
    expect(capability.available).toBe(false)
    expect(capability.reason).toMatch(/browser/i)
  })
})
