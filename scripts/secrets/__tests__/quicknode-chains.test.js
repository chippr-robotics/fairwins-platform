/**
 * The derivation is pure arithmetic over a URL, and the failure mode of getting it wrong is a
 * 200 from the wrong chain — so the pure half is pinned here, and the network half (--verify)
 * asserts eth_chainId at run time rather than being simulated.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEndpoint, deriveChainUrl, redact, EVM_CHAIN_SLUGS } from '../quicknode-chains.js'
import { allSecretIds } from '../registry.js'

const TOKEN = 'abc123DEF456'

test('parses an infixless (Ethereum-mainnet-base) endpoint URL', () => {
  const ep = parseEndpoint(`https://my-endpoint-001.quiknode.pro/${TOKEN}`)
  assert.deepEqual(ep, { name: 'my-endpoint-001', token: TOKEN })
})

test('parses an infixed base URL (e.g. a matic-base endpoint) to the same name+token', () => {
  const ep = parseEndpoint(`https://my-endpoint-002.matic.quiknode.pro/${TOKEN}/`)
  assert.deepEqual(ep, { name: 'my-endpoint-002', token: TOKEN })
})

test('trailing whitespace/newline from a secret payload does not break parsing', () => {
  const ep = parseEndpoint(`https://ep.quiknode.pro/${TOKEN}\n`)
  assert.equal(ep.token, TOKEN)
})

test('refuses a non-quiknode payload rather than deriving garbage hostnames', () => {
  assert.throws(() => parseEndpoint('https://polygon.drpc.org'), /not a https/)
  assert.throws(() => parseEndpoint(''), /not a https/)
})

test('Ethereum mainnet derives WITHOUT an infix; every other chain derives WITH its slug', () => {
  const ep = { name: 'ep', token: TOKEN }
  assert.equal(deriveChainUrl(ep, 1), `https://ep.quiknode.pro/${TOKEN}/`)
  assert.equal(deriveChainUrl(ep, 10), `https://ep.optimism.quiknode.pro/${TOKEN}/`)
  assert.equal(deriveChainUrl(ep, 8453), `https://ep.base-mainnet.quiknode.pro/${TOKEN}/`)
  assert.equal(deriveChainUrl(ep, 42161), `https://ep.arbitrum-mainnet.quiknode.pro/${TOKEN}/`)
  assert.equal(deriveChainUrl(ep, 137), `https://ep.matic.quiknode.pro/${TOKEN}/`)
  assert.equal(deriveChainUrl(ep, 80002), `https://ep.matic-amoy.quiknode.pro/${TOKEN}/`)
})

test('an unmapped chainId throws instead of guessing a slug', () => {
  assert.throws(() => deriveChainUrl({ name: 'ep', token: TOKEN }, 61), /no QuickNode slug/)
})

test('deriving from a base URL of a DIFFERENT network still lands on the requested chain', () => {
  // The whole point of parse-then-derive: the payload's own infix is discarded, so a matic-base
  // payload derives a correct Optimism URL rather than a matic-optimism chimera.
  const ep = parseEndpoint(`https://ep.matic.quiknode.pro/${TOKEN}`)
  assert.equal(deriveChainUrl(ep, 10), `https://ep.optimism.quiknode.pro/${TOKEN}/`)
})

test('redact removes the token and keeps the host', () => {
  const r = redact(`https://ep.optimism.quiknode.pro/${TOKEN}/`)
  assert.ok(!r.includes(TOKEN))
  assert.ok(r.includes('ep.optimism.quiknode.pro'))
})

test('every slug entry names a real frontend build variable shape', () => {
  for (const [chainId, { envName }] of Object.entries(EVM_CHAIN_SLUGS)) {
    assert.match(envName, /^VITE_RPC_URL_[A-Z]+$/, `chain ${chainId}`)
  }
})

test('every declared secretId is a real registry entry', () => {
  // The join that makes --provision safe. A secretId that is not in the registry is not in
  // `workstation_secret_ids` either (the terraform-parity test enforces that half), so provisioning
  // it would write a version nobody can read — and the failure surfaces later as PERMISSION_DENIED,
  // which reads exactly like a broken login.
  const declared = new Set(allSecretIds())
  for (const [chainId, { secretId }] of Object.entries(EVM_CHAIN_SLUGS)) {
    if (secretId === null) continue
    assert.ok(declared.has(secretId), `chain ${chainId} names ${secretId}, which the registry does not declare`)
  }
})

test('the four provisioned EVM mainnets each have their own container, and no two share one', () => {
  // Per-chain means per-chain: two chains pointing at one container would store one URL and read it
  // back for both, which is the multichain ambiguity this work exists to remove.
  const ids = [1, 10, 8453, 42161].map((c) => EVM_CHAIN_SLUGS[c].secretId)
  assert.ok(ids.every(Boolean), 'every one of chains 1/10/8453/42161 must name a container')
  assert.equal(new Set(ids).size, ids.length, 'two chains share a secret container')
  assert.equal(EVM_CHAIN_SLUGS[137].secretId, 'fairwins-quicknode-polygon-url')
})

test('Amoy declares NO container rather than borrowing another chain\'s', () => {
  // `null` is the honest answer (no Amoy-cohort node exists) and it is what makes --provision
  // refuse the chain instead of guessing an id.
  assert.equal(EVM_CHAIN_SLUGS[80002].secretId, null)
})
