/**
 * ClearPath — external-DAO governance, as a mini-app package (spec 073 T028).
 *
 * Unlike Token Mint, this app is NETWORK-AGNOSTIC: it reads DAOs from every chain it can operate
 * on, in parallel, independent of where the wallet sits. That is why it declares `network` (for
 * the chain roster and per-chain descriptors) and why `wallet:submit` alone is not enough — a
 * member viewing a DAO on another chain has to be able to move their wallet there.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import react from '@vitejs/plugin-react'

import { createMiniAppConfig } from '@fairwins/miniapp-build/index.js'

/**
 * THE version, read from this package's own `package.json` (spec 075, T037).
 *
 * `manifest.version` lives inside the manifest bytes whose `keccak256` is the
 * on-chain MiniAppRegistry commitment; `package.json`'s `version` is what npm,
 * the workspace and any release tooling read. A literal here made those two
 * numbers independent — bumping the workspace version would change no published
 * byte, and bumping this literal would change the on-chain commitment with no
 * `package.json` change to show for it. They agreed only by coincidence.
 *
 * Read at config-evaluation time rather than imported, so no bundler behaviour
 * (import attributes, JSON interop, `envPrefix`) sits between the file and the
 * value. `import.meta.dirname` is the same anchor `root` already uses below.
 */
const { version } = JSON.parse(readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8'))

export default createMiniAppConfig({
  appId: 'clearpath',
  name: 'ClearPath',
  version,
  root: import.meta.dirname,
  entry: 'src/entry.jsx',
  permissions: [
    'wallet:submit', // register, propose, vote, queue, execute
    'toast',
    'store', // device-tracked DAOs, on networks with no on-chain registry
    'contracts', // ExternalDAORegistry / paymentToken / sanctionsGuard, per chain
    'network', // the chain roster, explorer links, network names
  ],
  storeKeys: ['tracked', 'trackedMigratedAt'],
  /*
   * `sanctionsGuard` is declared for a READ only — the app asks whether a platform sanctions
   * source exists on a chain, to decide how much it can say about screening posture. The screening
   * DECISION is the host's, enforced inside `submit`, and this package does not perform it.
   */
  /*
   * `standardDaoFactory` (spec 030 pillar A) is DECLARED on every chain and DEPLOYED on Cancun ones
   * only. The two answers differ and the app depends on that: an undeclared name THROWS (a packaging
   * bug), while a declared-but-absent one returns `null` — a fact about the estate the Launch tab
   * renders as its own honest unavailable state, naming the reason. Declaring it here is what makes
   * "not on this chain" expressible at all.
   */
  contracts: ['externalDAORegistry', 'standardDaoFactory', 'paymentToken', 'sanctionsGuard'],
  plugins: [react()],
})
