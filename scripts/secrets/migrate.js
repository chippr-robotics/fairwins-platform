#!/usr/bin/env node
/**
 * scripts/secrets/migrate.js — one-time move of workstation credentials out of a plaintext `.env`
 * and into Secret Manager. Spec 088.
 *
 *   node scripts/secrets/migrate.js              # dry run: report only, nothing is written
 *   node scripts/secrets/migrate.js --apply      # create containers + add versions
 *   node scripts/secrets/migrate.js --apply --prune-env   # ...then strip the values from .env
 *
 * DRY RUN IS THE DEFAULT because the destructive half of this script edits a file that is, at the
 * moment it runs, the only copy of several live private keys.
 *
 * Ordering is the whole safety argument, and it is: upload -> read back -> compare bytes -> only
 * then touch `.env`. `--prune-env` refuses to run if any secret failed its readback, so the local
 * copy cannot be removed while the remote copy is unverified. A migration that writes and trusts is
 * how you discover a truncated payload after deleting the original.
 *
 * IDEMPOTENT: a secret whose latest version already matches the local value is left alone rather
 * than accumulating identical versions. Re-running is safe and reports "already current".
 */

import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECT_ID, SECRETS, PUBLIC_ENV_KEYS } from './registry.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENV_PATH = join(REPO_ROOT, '.env')

const APPLY = process.argv.includes('--apply')
const PRUNE = process.argv.includes('--prune-env')

const log = (m) => process.stdout.write(`${m}\n`)

/** execFile promise wrapper. `input` is written to stdin — never passed as an argument. */
function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.toString('utf8').trim() || err.message))
        resolve(stdout)
      },
    )
    if (input !== undefined) {
      child.stdin.end(input)
    }
  })
}

const gcloudBase = [`--project=${PROJECT_ID}`]

async function secretExists(id) {
  try {
    await run('gcloud', ['secrets', 'describe', id, ...gcloudBase])
    return true
  } catch {
    return false
  }
}

async function readLatest(id) {
  try {
    const out = await run('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${id}`, ...gcloudBase])
    return out.toString('utf8')
  } catch {
    return null
  }
}

/**
 * Parse `.env` into { key: rawValue } plus the original line list, preserving order and comments
 * so the pruned file stays readable and reviewable rather than being regenerated from scratch.
 */
function parseEnv(text) {
  const lines = text.split('\n')
  const values = new Map()
  lines.forEach((line, idx) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) return
    let v = m[2]
    // Strip one layer of surrounding quotes, matching dotenv's own behaviour.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    values.set(m[1], { value: v, line: idx })
  })
  return { lines, values }
}

/** Build the payload for one registry entry from the parsed .env, or null if absent locally. */
function payloadFor(entry, values) {
  if (entry.json) {
    const parts = entry.expand.map((name) => values.get(name)?.value)
    if (parts.some((p) => !p)) return null
    return JSON.stringify(parts)
  }
  // An entry may have several aliases; the first one present locally is the source of truth.
  for (const name of entry.env) {
    const found = values.get(name)
    if (found?.value) return found.value
  }
  return null
}

async function main() {
  log(`FairWins workstation secret migration — project ${PROJECT_ID}`)
  log(APPLY ? 'MODE: apply\n' : 'MODE: dry run (pass --apply to write)\n')

  let envText
  try {
    envText = readFileSync(ENV_PATH, 'utf8')
  } catch {
    log(`No .env at ${ENV_PATH} — nothing to migrate.`)
    return
  }
  const { lines, values } = parseEnv(envText)

  const results = []
  for (const entry of SECRETS) {
    // A DERIVED payload is computed, not copied. Whatever sits under this name in `.env` is a
    // stand-in — for the per-chain QuickNode endpoints it is a PUBLIC RPC URL — and uploading it
    // would fill a container labelled "archive endpoint" with a public one that reads back as
    // correct forever, on every later fetch, with no error anywhere. Skip it and name the command
    // that does produce the real value.
    if (entry.derived) {
      results.push({ entry, status: 'derived' })
      log(`~ ${entry.id}: derived, not migrated — run \`${entry.derived}\``)
      continue
    }

    const payload = payloadFor(entry, values)
    if (payload === null) {
      results.push({ entry, status: 'absent-locally' })
      log(`- ${entry.id}: not present in .env — skipped`)
      continue
    }

    const exists = await secretExists(entry.id)
    const current = exists ? await readLatest(entry.id) : null

    if (current !== null && current === payload) {
      results.push({ entry, status: 'already-current', verified: true })
      log(`= ${entry.id}: already current (${payload.length} bytes)`)
      continue
    }

    if (!APPLY) {
      const what = exists ? 'would add a new version' : 'would create the container and add v1'
      results.push({ entry, status: 'pending' })
      log(`+ ${entry.id}: ${what} (${payload.length} bytes)`)
      continue
    }

    if (!exists) {
      await run('gcloud', [
        'secrets', 'create', entry.id,
        '--replication-policy=automatic',
        `--labels=managed-by=spec-088,surface=workstation,class=${entry.class}`,
        ...gcloudBase,
      ])
      log(`  created container ${entry.id}`)
    }

    // Payload delivered on stdin. `--data-file=-` writes the bytes verbatim: no trailing newline is
    // added and none is stripped, which is what makes the readback comparison below meaningful.
    await run('gcloud', [
      'secrets', 'versions', 'add', entry.id, '--data-file=-', ...gcloudBase,
    ], Buffer.from(payload, 'utf8'))

    const readBack = await readLatest(entry.id)
    const verified = readBack === payload
    results.push({ entry, status: verified ? 'uploaded' : 'MISMATCH', verified })
    log(`${verified ? '+' : '!'} ${entry.id}: ${verified ? `uploaded and verified (${payload.length} bytes)` : 'READBACK MISMATCH'}`)
  }

  const failed = results.filter((r) => r.status === 'MISMATCH')
  const live = results.filter((r) => r.status !== 'absent-locally')
  log('')
  log(`Summary: ${live.length} secret(s) considered, ${failed.length} failed verification.`)

  // ---- unclassified key report -------------------------------------------------------------
  const known = new Set([
    ...SECRETS.flatMap((s) => [...s.env, ...(s.expand ?? [])]),
    ...PUBLIC_ENV_KEYS,
  ])
  const unclassified = [...values.keys()].filter((k) => !known.has(k))
  if (unclassified.length) {
    log('')
    log('UNCLASSIFIED keys in .env (neither a registered secret nor declared public):')
    unclassified.forEach((k) => log(`  ${k}`))
    log('Classify each in scripts/secrets/registry.js before assuming it is safe to keep.')
  }

  if (!PRUNE) return
  if (!APPLY) {
    log('\n--prune-env ignored: it requires --apply.')
    return
  }
  if (failed.length) {
    log('\nREFUSING to prune .env: some secrets did not verify. Fix those first.')
    process.exitCode = 1
    return
  }

  // ---- back up, then prune -----------------------------------------------------------------
  // The backup lives OUTSIDE the repository so it can never be committed by a wildcard add, and is
  // written 0600 in a 0700 directory. It is a transitional artifact: shred it once you have run a
  // deploy through the vault path.
  const backupDir = join(homedir(), '.local', 'share', 'fairwins')
  mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupDir, `env-pre-088-${stamp}`)
  writeFileSync(backupPath, envText, { mode: 0o600 })
  chmodSync(backupPath, 0o600)
  log(`\nBacked up the original .env to ${backupPath} (0600)`)

  // Derived entries are excluded: this run never verified a remote copy of them (it skipped them
  // above), so commenting out the local value would remove the only endpoint on disk while the
  // container may still be empty. They are pruned by hand, after `--provision` reports PASS.
  const managedNames = new Set(
    SECRETS.filter((s) => !s.derived).flatMap((s) => [...s.env, ...(s.expand ?? [])]),
  )
  const derivedNames = SECRETS.filter((s) => s.derived).flatMap((s) => s.env)
  const out = lines.map((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m || !managedNames.has(m[1])) return line
    // The key is retained as a comment so the file still documents what the tooling consumes, and a
    // reader is told where the value went rather than finding an unexplained gap.
    return `# ${m[1]} -> Secret Manager (see scripts/secrets/registry.js); delivered by \`npm run sec\``
  })
  writeFileSync(ENV_PATH, out.join('\n'), { mode: 0o600 })
  log(`Pruned ${managedNames.size} managed variable(s) from .env`)
  if (derivedNames.length) {
    log(
      `LEFT IN PLACE (derived, never uploaded by this script): ${derivedNames.join(', ')}. `
        + 'Remove each by hand once its `--provision` run reports PASS.',
    )
  }
}

main().catch((err) => {
  process.stderr.write(`migrate: ${err.message}\n`)
  process.exit(1)
})
