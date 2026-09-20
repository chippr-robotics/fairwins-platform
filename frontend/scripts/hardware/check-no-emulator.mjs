#!/usr/bin/env node
/**
 * The emulator rail must not appear in a production build — spec 085/110.
 *
 * This exists because the structural test was not enough. `adapters.js` gated the rail behind
 * `import.meta.env.DEV` and `src/test/hardware/speculosSeam.test.js` was green, but
 * `ledgerAdapter.js` selected it on a RUNTIME value the bundler could not fold, so the build
 * happily emitted `speculosTransport-*.js` as its own chunk: a module that points device signing
 * at an arbitrary HTTP origin, shipped, with every test passing. A guard over source shape cannot
 * see a bundler decision; only the artifact can answer this.
 *
 *   npm run build && npm run check:no-emulator
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist')
const NEEDLES = ['speculosTransport', 'TransportSpeculosHttp', '/automation', '/apdu']

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|css|html)$/.test(entry)) out.push(full)
  }
  return out
}

let files
try {
  files = walk(DIST)
} catch {
  console.error('[check:no-emulator] no dist/ — run `npm run build` first.')
  process.exit(2)
}

const hits = []
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  for (const needle of NEEDLES) {
    if (source.includes(needle)) hits.push(`${relative(DIST, file)} contains ${JSON.stringify(needle)}`)
  }
}

if (hits.length > 0) {
  console.error('[check:no-emulator] the Speculos rail reached the production bundle:')
  for (const hit of hits) console.error(`  - ${hit}`)
  console.error('\nEvery selection of it must sit behind `import.meta.env.DEV` so the bundler can')
  console.error('fold the branch away — including the one inside ledgerAdapter.js.')
  process.exit(1)
}

console.log(`[check:no-emulator] clean — ${files.length} built files, no emulator rail.`)
