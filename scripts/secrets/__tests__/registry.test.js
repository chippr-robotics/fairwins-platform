/**
 * Tests for the spec-088 secret registry and its fallback rule.
 *
 * These assert the properties the rest of the system relies on being true. The fallback tests in
 * particular are the important ones: `mayFallBack` is the single decision that separates "a token
 * was unavailable so a feature degraded" from "a signing key was unavailable so we used whatever
 * was lying around in the environment".
 *
 * Run: node --test "scripts/secrets/__tests__/*.test.js"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SECRETS,
  PROFILES,
  CLASS,
  secretsForProfile,
  allManagedEnvNames,
  allSecretIds,
  PUBLIC_ENV_KEYS,
} from '../registry.js'
import { mayFallBack } from '../fetch.js'

test('every secret id carries the fairwins- prefix required by guardrail G-10', () => {
  for (const s of SECRETS) {
    assert.match(s.id, /^fairwins-/, `${s.id} would be rejected by check:iac`)
  }
})

test('secret ids are unique', () => {
  const ids = SECRETS.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('no environment variable is claimed by two different secrets', () => {
  const seen = new Map()
  for (const s of SECRETS) {
    for (const name of [...s.env, ...(s.expand ?? [])]) {
      assert.equal(seen.has(name), false, `${name} is claimed by both ${seen.get(name)} and ${s.id}`)
      seen.set(name, s.id)
    }
  }
})

test('every secret declares at least one profile, and every profile is reachable', () => {
  for (const s of SECRETS) assert.ok(s.profiles.length > 0, `${s.id} belongs to no profile`)
  for (const p of PROFILES) assert.ok(secretsForProfile(p).length > 0)
})

test('an unknown profile throws rather than resolving to an empty set', () => {
  // A typo must not look like "this profile legitimately needs nothing".
  assert.throws(() => secretsForProfile('depoly'), /Unknown secret profile/)
})

test('json entries declare the expansion they produce', () => {
  for (const s of SECRETS.filter((x) => x.json)) {
    assert.ok(Array.isArray(s.expand) && s.expand.length > 0, `${s.id} is json but declares no expand`)
  }
})

test('the three QuickNode URL aliases resolve to one secret', () => {
  // Regression guard for the condition this migration found: three byte-identical copies of one
  // credentialed URL, which would otherwise rotate independently.
  const owners = ['POLYGON_RPC_URL', 'QUICKNODE_POLYGON_RPC_URL', 'ALTO_RPC_URL'].map(
    (name) => SECRETS.find((s) => s.env.includes(name))?.id,
  )
  assert.equal(new Set(owners).size, 1, 'the QuickNode URL aliases must share one secret container')
  assert.equal(owners[0], 'fairwins-quicknode-polygon-url')
})

test('a derived secret names the command that produces it, and is not a json bundle', () => {
  // `derived` is what stops migrate.js uploading whatever stand-in sits in a local .env. A blank or
  // vague value would leave an operator reading "derived, not migrated" with nowhere to go, and the
  // json expansion path has no meaning for a computed single-value payload.
  for (const s of SECRETS.filter((x) => x.derived)) {
    assert.match(s.derived, /quicknode-chains\.js --provision \d+/, `${s.id} names no usable command`)
    assert.equal(s.json, undefined, `${s.id} cannot be both derived and a json bundle`)
  }
})

test('the four per-chain QuickNode endpoints are all derived', () => {
  // The regression this guards: adding a fifth chain, forgetting `derived`, and having the next
  // `secrets:migrate --apply` quietly upload a PUBLIC RPC URL into a container everything downstream
  // trusts as the keyed archive endpoint. It reads back byte-exact forever, so nothing ever errors.
  for (const id of [
    'fairwins-quicknode-ethereum-url',
    'fairwins-quicknode-optimism-url',
    'fairwins-quicknode-base-url',
    'fairwins-quicknode-arbitrum-url',
  ]) {
    const entry = SECRETS.find((s) => s.id === id)
    assert.ok(entry, `${id} is missing from the registry`)
    assert.ok(entry.derived, `${id} must declare how its payload is produced`)
  }
})

test('managed names and public names do not overlap', () => {
  const managed = new Set(allManagedEnvNames())
  for (const k of PUBLIC_ENV_KEYS) {
    assert.equal(managed.has(k), false, `${k} is declared both managed and public`)
  }
})

test('allSecretIds is sorted and complete — it feeds the Terraform inputs', () => {
  const ids = allSecretIds()
  assert.deepEqual(ids, [...ids].sort())
  assert.equal(ids.length, SECRETS.length)
})

// ---- the fallback rule -----------------------------------------------------------------------

const keyEntry = { id: 'k', class: CLASS.KEY, env: ['PRIVATE_KEY'] }
const tokenEntry = { id: 't', class: CLASS.TOKEN, env: ['ETHERSCAN_API_KEY'] }

test('nothing falls back when the caller did not ask for it', () => {
  assert.equal(mayFallBack(tokenEntry, { allowEnvFallback: false }), false)
  assert.equal(mayFallBack(keyEntry, { allowEnvFallback: false }), false)
})

test('a token may fall back on the caller opt-in alone', () => {
  assert.equal(mayFallBack(tokenEntry, { allowEnvFallback: true }), true)
})

test('key material needs the second, explicit opt-in as well', () => {
  delete process.env.FW_ALLOW_ENV_SECRETS
  assert.equal(mayFallBack(keyEntry, { allowEnvFallback: true }), false)
  process.env.FW_ALLOW_ENV_SECRETS = 'true'
  assert.equal(mayFallBack(keyEntry, { allowEnvFallback: true, network: 'hardhat' }), true)
  delete process.env.FW_ALLOW_ENV_SECRETS
})

test('key material never falls back on a public network, even fully opted in', () => {
  // The failure this prevents: signing a Polygon mainnet transaction with a key that happened to be
  // exported in the shell, because the vault was briefly unreachable.
  process.env.FW_ALLOW_ENV_SECRETS = 'true'
  for (const network of ['polygon', 'mainnet', 'mordor', 'amoy']) {
    assert.equal(
      mayFallBack(keyEntry, { allowEnvFallback: true, network }),
      false,
      `key material must not fall back on ${network}`,
    )
  }
  delete process.env.FW_ALLOW_ENV_SECRETS
})
