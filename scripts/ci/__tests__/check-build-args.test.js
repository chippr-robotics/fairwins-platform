/**
 * The gate must FAIL on the shapes it exists to catch. A gate nobody has watched fail is a gate
 * nobody knows works — and this one's whole subject is a failure that looks like success.
 */
const test = require('node:test')
const assert = require('node:assert')
const { readDockerfile, readCloudbuild } = require('../check-build-args.js')

test('parses ARG and ENV names out of a Dockerfile', () => {
  const df = readDockerfile('ARG VITE_A\nENV VITE_A=${VITE_A}\nARG VITE_B\n')
  assert.deepStrictEqual([...df.args].sort(), ['VITE_A', 'VITE_B'])
  assert.deepStrictEqual([...df.envs], ['VITE_A'])
})

test('parses build args out of a Cloud Build file, quoted or not', () => {
  const used = readCloudbuild("      - 'VITE_X=https://x'\n      - VITE_Y=2\n")
  assert.ok(used.has('VITE_X'))
  assert.ok(used.has('VITE_Y'))
})

test('ignores non-VITE args — the gate is about what Vite inlines', () => {
  const used = readCloudbuild("      - 'NODE_ENV=production'\n      - 'VITE_Z=1'\n")
  assert.deepStrictEqual([...used], ['VITE_Z'])
})

test('MUST-FAIL: a build arg set with no ARG is detected as missing', () => {
  const df = readDockerfile('ARG VITE_DECLARED\nENV VITE_DECLARED=${VITE_DECLARED}\n')
  const used = readCloudbuild("- 'VITE_DECLARED=a'\n- 'VITE_DROPPED=b'\n")
  const missing = [...used].filter((n) => !df.args.has(n))
  assert.deepStrictEqual(missing, ['VITE_DROPPED'], 'the undeclared arg must be reported')
})

test('MUST-FAIL: an ARG with no matching ENV is detected', () => {
  const df = readDockerfile('ARG VITE_ORPHAN\n')
  const orphans = [...df.args].filter((n) => !df.envs.has(n))
  assert.deepStrictEqual(orphans, ['VITE_ORPHAN'])
})

test('the real repo passes its own gate', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = path.resolve(__dirname, '..', '..', '..')
  const df = readDockerfile(fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'))
  for (const file of ['cloudbuild.yaml', 'cloudbuild.staging.yaml']) {
    for (const name of readCloudbuild(fs.readFileSync(path.join(root, file), 'utf8'))) {
      assert.ok(df.args.has(name), `${file} sets ${name} with no ARG in the Dockerfile`)
    }
  }
})
