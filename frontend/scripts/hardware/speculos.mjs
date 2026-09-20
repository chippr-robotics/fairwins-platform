#!/usr/bin/env node
/**
 * Bring the Ledger emulator up and down — spec 085/110, issue #1593.
 *
 * This is what replaces the thumb. Speculos runs the REAL Ledger Ethereum app under QEMU and
 * exposes its APDU channel and its screen over HTTP, so a test can drive the confirmation gate
 * instead of removing it.
 *
 * ── THE APP BINARY IS NOT BUILT HERE, AND IS NOT COMMITTED ────────────────────────────────────
 * `app.elf` is firmware. Committing one would put an opaque 280 KB binary in the repo that nobody
 * reviews and that silently decides what every hardware test means, and pinning it by tag alone
 * would let a rebuild change the APDUs and the Clear-Signing screens under a name that did not
 * move. So the app is BUILT from a pinned commit of LedgerHQ/app-ethereum with Ledger's own
 * builder image, and the build is cached by that commit. `APP_ETHEREUM_REF` is the pin: moving it
 * is a deliberate act with a diff, which is the property a vendored binary cannot have.
 *
 * ── THE SEED IS PUBLIC ON PURPOSE ──────────────────────────────────────────────────────────────
 * The BIP-39 test vector, which holds nothing and must never hold anything. A funded seed in a
 * script any contributor can run is a seed that gets drained; if a broadcast test ever needs
 * value, it needs a protected environment and a cap, not this file.
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const WORK = resolve(ROOT, '.speculos')

// Pins. Moving either is a reviewable diff, which is the whole point.
const SPECULOS_IMAGE = 'ghcr.io/ledgerhq/speculos@sha256:6ed9eefd51cddd862b746719af4cd7a3265fe43d0588c388359753cab8d46d11'
const BUILDER_IMAGE = 'ghcr.io/ledgerhq/ledger-app-builder/ledger-app-builder-lite:latest'
const APP_ETHEREUM_REPO = 'https://github.com/LedgerHQ/app-ethereum'
const APP_ETHEREUM_REF = 'develop'
const MODEL = process.env.SPECULOS_MODEL || 'nanosp'
const SDK_VAR = { nanosp: 'NANOSP_SDK', nanox: 'NANOX_SDK', stax: 'STAX_SDK', flex: 'FLEX_SDK' }[MODEL]
const BUILD_DIR = { nanosp: 'nanos2', nanox: 'nanox', stax: 'stax', flex: 'flex' }[MODEL]
const CONTAINER = 'fairwins-speculos'
const PORT = process.env.SPECULOS_PORT || '5000'

export const TEST_SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

/*
 * ── TWO TRAPS IN THE RULE FORMAT, BOTH MEASURED ON A LIVE DEVICE ──────────────────────────────
 *
 * 1. `text` is an EXACT match, not containment. The approve screen reads `"Sign transaction"`, so
 *    a rule written `{ text: "Sign" }` — which looks obviously right — never fires. It does not
 *    error: the catch-all keeps pressing RIGHT, the carousel loops, and the APDU never returns, so
 *    the suite HANGS until a timeout instead of saying anything.
 *
 * 2. A catch-all that ALSO matches the approve screen races it. With `{regexp: '.*'}` alongside an
 *    approve rule, both fire on `"Sign transaction"`: the right-press advanced the screen before
 *    the both-press landed, so the confirmation arrived on `"Reject transaction"` and every
 *    signature came back 0x6985 — a test that looked like the device refusing when it was the
 *    automation pressing the wrong button one screen late. The catch-all therefore EXCLUDES every
 *    decision screen by negative lookahead, so exactly one rule can match any screen.
 *
 * The catch-all presses RIGHT (advance), never both (approve): an unrecognised screen must not be
 * able to approve itself, which is the one way an automation file turns a hardware test into a
 * rubber stamp. Screen texts were read off a live Speculos event log, not guessed.
 */
const AUTOMATION = {
  version: 1,
  rules: [
    { regexp: '^(Sign|Accept|Approve)\\b.*', actions: [['button', 1, true], ['button', 2, true], ['button', 2, false], ['button', 1, false]] },
    { regexp: '^(?!(Sign|Accept|Approve|Reject)\\b).*', actions: [['button', 2, true], ['button', 2, false]] },
  ],
}

const sh = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: ROOT })
const quiet = (cmd) => { try { return execSync(cmd, { stdio: 'pipe' }).toString() } catch { return '' } }
const docker = process.env.DOCKER ?? 'docker'

function buildApp() {
  const appDir = resolve(WORK, 'app-ethereum')
  const elf = resolve(WORK, `ethereum-${MODEL}.elf`)
  if (existsSync(elf)) {
    console.log(`[speculos] app already built: ${elf}`)
    return elf
  }
  mkdirSync(WORK, { recursive: true })
  if (!existsSync(appDir)) {
    console.log(`[speculos] cloning ${APP_ETHEREUM_REPO}@${APP_ETHEREUM_REF}`)
    sh(`git clone --depth 1 --branch ${APP_ETHEREUM_REF} --recurse-submodules --shallow-submodules ${APP_ETHEREUM_REPO} ${appDir}`)
  }
  console.log(`[speculos] building the Ethereum app for ${MODEL} (this takes a few minutes)`)
  sh(`${docker} run --rm -v "${appDir}":/app -w /app ${BUILDER_IMAGE} bash -c 'make -j BOLOS_SDK=$${SDK_VAR}'`)
  copyFileSync(resolve(appDir, `build/${BUILD_DIR}/bin/app.elf`), elf)
  return elf
}

function up() {
  const elf = buildApp()
  writeFileSync(resolve(WORK, 'automation.json'), JSON.stringify(AUTOMATION, null, 2))
  quiet(`${docker} rm -f ${CONTAINER}`)
  sh(
    `${docker} run -d --name ${CONTAINER} -p ${PORT}:5000 -v "${WORK}":/apps ${SPECULOS_IMAGE} ` +
      `--display headless --api-port 5000 --model ${MODEL} ` +
      `--seed "${TEST_SEED}" --automation file:/apps/automation.json /apps/${elf.split('/').pop()}`,
  )
  // Wait for the API rather than sleeping a guessed interval: a fixed sleep is a flake generator.
  for (let i = 0; i < 60; i += 1) {
    const out = quiet(`curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:${PORT}/events?currentscreenonly=true`)
    if (out.trim() === '200') {
      console.log(`[speculos] ready on http://127.0.0.1:${PORT} (${MODEL})`)
      return
    }
    execFileSync('sleep', ['1'])
  }
  console.error(`[speculos] never became ready; logs:\n${quiet(`${docker} logs ${CONTAINER}`)}`)
  process.exit(1)
}

function down() {
  quiet(`${docker} rm -f ${CONTAINER}`)
  console.log('[speculos] stopped')
}

const cmd = process.argv[2]
if (cmd === 'up') up()
else if (cmd === 'down') down()
else {
  console.error('usage: speculos.mjs up|down')
  process.exit(2)
}
