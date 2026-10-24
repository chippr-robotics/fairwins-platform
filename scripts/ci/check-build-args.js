#!/usr/bin/env node
/**
 * Every VITE_ build arg a Cloud Build file sets MUST be declared in the Dockerfile.
 *
 * WHY THIS GATE EXISTS. Vite inlines `import.meta.env.VITE_*` at build time from the environment of
 * the build process. Docker does not pass `--build-arg FOO` into the build unless the Dockerfile
 * declares `ARG FOO`, and it does not fail when you pass one it never declared — it prints a warning
 * nobody reads and carries on. So a build arg that is set but not declared is SILENTLY DROPPED: the
 * pipeline is green, the image is built, and the feature it configures is simply absent.
 *
 * That is not hypothetical. This gate's first run found `VITE_STAGING_BANNER` set in
 * cloudbuild.staging.yaml with no matching ARG — so the marker that tells people staging sends REAL
 * mainnet transactions had never once rendered, while the promotion config gate happily listed it as
 * an enumerated difference between the two environments.
 *
 * It also guards the multi-chain bundler rollout (#1501): turning a chain on is
 * `VITE_BUNDLER_URLS_<NET>` in both Cloud Build files, and without a matching ARG the SPA ships with
 * that chain's passkey support still dark, having merged green.
 *
 * TWO ASSERTIONS:
 *   1. set-but-not-declared — the silent drop above.
 *   2. declared-but-not-exported — an `ARG` with no matching `ENV` reaches the build stage's
 *      environment only if the ARG is in scope at that stage; this repo's convention is an explicit
 *      `ENV X=${X}` for each, and a missing one is the same silent absence by another route.
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const DOCKERFILE = path.join(ROOT, 'Dockerfile')
const CLOUDBUILDS = ['cloudbuild.yaml', 'cloudbuild.staging.yaml']

/** ARG/ENV names the Dockerfile declares. */
function readDockerfile(text) {
  return {
    args: new Set([...text.matchAll(/^ARG\s+(VITE_[A-Z0-9_]+)/gm)].map((m) => m[1])),
    envs: new Set([...text.matchAll(/^ENV\s+(VITE_[A-Z0-9_]+)\s*=/gm)].map((m) => m[1])),
  }
}

/** VITE_ build args a Cloud Build file sets, as `- 'NAME=value'` entries. */
function readCloudbuild(text) {
  return new Set([...text.matchAll(/['"]?(VITE_[A-Z0-9_]+)=/g)].map((m) => m[1]))
}

function main() {
  const df = readDockerfile(fs.readFileSync(DOCKERFILE, 'utf8'))
  const problems = []

  for (const file of CLOUDBUILDS) {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) {
      // Absent is not OK here: this gate's whole job is to notice missing things.
      problems.push(`${file}: not found — the gate cannot verify a file that is not there`)
      continue
    }
    for (const name of [...readCloudbuild(fs.readFileSync(full, 'utf8'))].sort()) {
      if (!df.args.has(name)) {
        problems.push(
          `${file} sets ${name}, but Dockerfile declares no \`ARG ${name}\` — ` +
            'docker DROPS it with only a warning, so the value never reaches the build.'
        )
      }
    }
  }

  for (const name of [...df.args].sort()) {
    if (!df.envs.has(name)) {
      problems.push(`Dockerfile declares \`ARG ${name}\` with no matching \`ENV ${name}=\${${name}}\` — it will not reach the build stage.`)
    }
  }

  if (problems.length) {
    console.error('\nbuild args: DECLARED AND SET MUST AGREE\n')
    for (const p of problems) console.error(`  ✖ ${p}`)
    console.error(
      '\n  Fix by adding the ARG (and its ENV) to the Dockerfile, next to the others.\n' +
        '  Do NOT fix by deleting the build arg unless the feature is genuinely being withdrawn —\n' +
        '  a dropped arg and an unset feature look identical from outside, which is the bug.\n'
    )
    process.exit(1)
  }

  const total = df.args.size
  console.log(`build args: OK — ${total} VITE_ args declared, every Cloud Build value has a home.`)
}

if (require.main === module) main()
module.exports = { readDockerfile, readCloudbuild }
