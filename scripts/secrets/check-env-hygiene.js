#!/usr/bin/env node
/**
 * scripts/secrets/check-env-hygiene.js — fail if a managed secret has a value in a local env file,
 * or if an env file contains something that looks like a credential but is not classified.
 * Spec 088. Run in CI as `npm run check:env-hygiene`.
 *
 * This is the gate that makes the migration stick. Moving credentials into Secret Manager once is
 * easy; the failure mode is somebody pasting a key back into `.env` next week to unblock
 * themselves, and nothing noticing. The registry says what is managed; this says the managed things
 * are not also sitting on disk.
 *
 * TWO CHECKS, and the second is the one that catches what the first cannot:
 *
 *   1. NO MANAGED VALUE ON DISK. Any variable named in the registry must be absent or empty in
 *      every scanned env file.
 *   2. NO UNCLASSIFIED CREDENTIAL-SHAPED VALUE. A 64-hex private key, a JWT, or a URL with an
 *      embedded token, under a name the registry has never heard of, is reported. A new credential
 *      arrives under a new name by definition, so a check that only knows current names would never
 *      see the next one.
 *
 * Scans only files git does NOT track (a tracked `.env.example` is meant to hold placeholders), and
 * reports the variable NAME and the reason, never the value.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SECRETS, PUBLIC_ENV_KEYS } from './registry.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Env files that may exist on a workstation and are never committed. */
const SCANNED = ['.env', '.env.local', 'frontend/.env', 'frontend/.env.local', 'services/relay-gateway/.env']

const MANAGED = new Set(SECRETS.flatMap((s) => [...s.env, ...(s.expand ?? [])]))
const CLASSIFIED = new Set([...MANAGED, ...PUBLIC_ENV_KEYS])

/**
 * Shapes that are credentials regardless of what they are called.
 * `VITE_`-prefixed values are exempt from the JWT rule only in the sense that they are reported as
 * a distinct, weaker finding: anything under `VITE_` is compiled into the client bundle and is
 * public the moment it ships, so the fix is "stop treating it as a secret", not "move it".
 */
const SHAPES = [
  { name: '32-byte hex key', re: /^0x[0-9a-fA-F]{64}$/ },
  { name: 'JWT', re: /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ },
  { name: 'URL with embedded credential', re: /^https?:\/\/[^\s]*\/[A-Za-z0-9]{24,}\/?$/ },
]

function parse(text) {
  const out = []
  text.split('\n').forEach((line, i) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) return
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out.push({ key: m[1], value: v, line: i + 1 })
  })
  return out
}

const problems = []
const notes = []

for (const rel of SCANNED) {
  const path = join(REPO_ROOT, rel)
  if (!existsSync(path)) continue

  for (const { key, value, line } of parse(readFileSync(path, 'utf8'))) {
    if (!value) continue

    if (MANAGED.has(key)) {
      problems.push(
        `${rel}:${line}  ${key} still holds a value on disk. It is managed in Secret Manager `
          + '(scripts/secrets/registry.js) and must be delivered by `npm run sec` instead.',
      )
      continue
    }

    const shape = SHAPES.find((s) => s.re.test(value))
    if (shape && !CLASSIFIED.has(key)) {
      // Spec 106/106 (T038): an RPC endpoint variable carrying a credential SHAPE is a FAILURE,
      // not a note — even under VITE_. The general VITE_ rule below is right for most values
      // ("public once shipped; get a scoped credential"), but for RPC endpoints the platform has
      // an explicit design that makes any credentialed value here a mistake by construction:
      // keyed read capacity is ISSUED at runtime (spec 107) precisely so nothing keyed is ever a
      // build-time constant, and an unrestricted archive URL pasted into one of these slots would
      // ship to every visitor with nothing else firing. This is that gate.
      if (/^VITE_RPC_URL/.test(key) || /^VITE_BUNDLER_URLS/.test(key)) {
        problems.push(
          `${rel}:${line}  ${key} looks like a ${shape.name}. RPC endpoint variables must NEVER `
            + 'carry a credential: keyed read capacity is issued at runtime (spec 107, '
            + 'specs/107-keyed-rpc-access/) so nothing keyed is ever compiled into a build, and a '
            + 'keyed URL here would publish the credential to every visitor. Use the public '
            + 'default, or leave it unset.',
        )
        continue
      }
      if (key.startsWith('VITE_')) {
        notes.push(
          `${rel}:${line}  ${key} looks like a ${shape.name} and is a VITE_ variable, so it is `
            + 'compiled into the client bundle and is PUBLIC once shipped. Treat it as a public '
            + 'identifier with a scoped, rotatable credential — moving it to Secret Manager would '
            + 'not make it private.',
        )
      } else {
        problems.push(
          `${rel}:${line}  ${key} looks like a ${shape.name} but is not classified. Add it to `
            + 'SECRETS (managed) or PUBLIC_ENV_KEYS (genuinely not a secret) in '
            + 'scripts/secrets/registry.js.',
        )
      }
    }
  }
}

if (notes.length) {
  process.stdout.write('env hygiene — notes:\n')
  notes.forEach((n) => process.stdout.write(`  NOTE  ${n}\n`))
  process.stdout.write('\n')
}

if (problems.length) {
  process.stderr.write('env hygiene — FAILED:\n')
  problems.forEach((p) => process.stderr.write(`  FAIL  ${p}\n`))
  process.stderr.write(`\n${problems.length} problem(s).\n`)
  process.exit(1)
}

process.stdout.write(
  `env hygiene: ok — ${MANAGED.size} managed variable(s) absent from ${SCANNED.length} scanned path(s).\n`,
)
