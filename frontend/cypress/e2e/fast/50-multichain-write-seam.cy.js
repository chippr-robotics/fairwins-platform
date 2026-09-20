// =============================================================================
// 50-multichain-write-seam.cy.js
// Fast-tier E2E for spec 110 — `multichain.refused-switch-discloses`.
//
// THE CLAIM UNDER TEST IS THE GENERALIZATION, not any one surface's wording.
// Before T026 four write surfaces each carried their own copy of the
// switch-then-settle loop and their own sentence for the same event: a member
// who declined a network change was told something different depending on which
// button they had pressed, and one of the four named neither the chain the
// wallet was on nor the fact that nothing had been signed. `settleWalletOn`
// (lib/chains/submitOn.js) is now the single loop and the single sentence, with
// only the opening NOUN passed in per surface.
//
// Two existing tests already prove one surface each — `full/45-wrap-cross-chain`
// WXC-02 and `fast/42-protect-vault-sheet` VS-04 — and both assert that the two
// chain names appear. Neither can see the thing that regresses here: a surface
// quietly going back to a sentence of its own. So MCW-03 drives TWO structurally
// different surfaces in one test and requires the two sentences, with the subject
// and the chain names normalized out, to be BYTE-IDENTICAL. That assertion fails
// the moment either surface stops sharing the seam, and it cannot be satisfied by
// a surface that merely happens to mention both chains.
//
// No chain, per the tier admission rule: nothing here can cost a member anything.
// Every test asserts the refusal path, and the refusal's whole content is that
// nothing was signed — which MCW-01 confirms against the RPC log rather than
// against the interface's own claim about itself.
//
// NOT COVERED HERE, and deliberately not faked (see specs/110-.../tasks.md T029):
// the two on-chain rows — `multichain.claim-on-action-chain` and
// `multichain.intent-signs-without-switch` — describe surfaces that do not name
// a target chain yet. Every one of the 22 `useGaslessWrite` call sites omits
// `cfg.chainId`, the claim path calls `switchNetwork()` with no argument, and
// `FriendMarketsContext` reads a single chain, so a wager living on another
// network is never listed to begin with. Those rows stay `absent` until T040/T041
// build the surfaces; a test written now would pass by never reaching its subject.
//
// Checklist: MCW-01 (vault approve), MCW-02 (wrap), MCW-03 (one sentence, two surfaces)
// =============================================================================

import {
  installVaultRpcStub,
  seedVaultEstate,
  TEST_ACCOUNT,
  VAULT,
  WALLET_CHAIN,
  STUB_CHAINS,
  stubUrl,
  PENDING_COUNT,
  SIGNING_METHODS,
} from '../../support/vaultRpcStub'

const WALLET_RPC = stubUrl(STUB_CHAINS[WALLET_CHAIN].port)
const DIALOG = '[role="dialog"]'
const ROW = '[data-testid="vault-queue-row"]'
const SUMMARY = '[data-testid="vault-queue-summary"]'
const rowOn = (chainId) => `${ROW}[data-chain-id="${chainId}"]`
const menu = (a) => `[data-testid="vault-menu-${String(a).toLowerCase()}"]`
const card = (a) => `[data-testid="vault-card-${String(a).toLowerCase()}"]`

const WRAP_URL = '/wallet?tab=trade&view=wrap'
const ONE_ETHER = '0x0de0b6b3a7640000'

/**
 * The shared sentence, as `settleWalletOn` composes it. Captures the three parts that are allowed
 * to differ between surfaces: the opening noun and the two chain names.
 */
const SHARED_REFUSAL =
  /(This[a-z ]*) goes to ([^,]+), but the wallet stayed on ([^,]+), so nothing has been signed\./

/** The sentence with everything surface-specific removed — what every surface must agree on. */
function skeletonOf(text) {
  const m = String(text).match(SHARED_REFUSAL)
  if (!m) return null
  return String(text)
    .slice(m.index, m.index + m[0].length)
    .replace(m[1], '<subject>')
    .replace(m[2], '<target>')
    .replace(m[3], '<wallet>')
}

/** Stub the mainnet cohort's read rails so the Wrap picker can render without a live endpoint. */
function stubWrapChains() {
  const rails = [
    [/ethereum-rpc\.publicnode\.com|eth\.drpc\.org/, '0x1'],
    [/optimism-rpc\.publicnode\.com|optimism\.drpc\.org/, '0xa'],
    [/etc\.rivet\.link|etc\.etcdesktop\.com/, '0x3d'],
    [/polygon-bor-rpc\.publicnode\.com|polygon\.drpc\.org/, '0x89'],
    [/base-rpc\.publicnode\.com|base\.drpc\.org/, '0x2105'],
    [/arbitrum-one-rpc\.publicnode\.com|arbitrum\.drpc\.org/, '0xa4b1'],
  ]
  for (const [url, chainIdHex] of rails) {
    cy.intercept({ method: 'POST', url }, (req) => {
      const one = ({ method, id }) => {
        let result
        switch (method) {
          case 'eth_chainId': result = chainIdHex; break
          case 'net_version': result = String(parseInt(chainIdHex, 16)); break
          case 'eth_blockNumber': result = '0x1000000'; break
          case 'eth_getBalance': result = ONE_ETHER; break
          case 'eth_gasPrice': result = '0x3b9aca00'; break
          default: result = '0x'
        }
        return { jsonrpc: '2.0', id, result }
      }
      req.reply({ statusCode: 200, body: Array.isArray(req.body) ? req.body.map(one) : one(req.body || {}) })
    })
  }
}

/** Refuse the switch on the vault queue's Base row, and hand back the refusal's text. */
function refuseOnVaultQueue() {
  const stub = installVaultRpcStub()
  cy.mockWeb3Provider({
    account: TEST_ACCOUNT,
    preAuthorized: true,
    networkId: WALLET_CHAIN,
    rpcUrl: WALLET_RPC,
    rejectChainSwitch: true,
  })
  cy.visit('/wallet?tab=custody', { onBeforeLoad: (win) => seedVaultEstate(win) })
  cy.get(card(VAULT), { timeout: 20000 }).should('contain.text', '3 networks')
  cy.get(menu(VAULT)).click()
  cy.get(DIALOG).should('be.visible')
  cy.get(`${DIALOG} ${ROW}`, { timeout: 20000 }).should('have.length', PENDING_COUNT)
  cy.get(`${DIALOG} ${SUMMARY}`).should('not.contain.text', 'Reading')
  cy.get(`${DIALOG} ${rowOn(8453)}`).contains('button', 'Approve').should('not.be.disabled').click()
  return { stub }
}

/** Refuse the switch on the Wrap surface, and hand back the refusal's text. */
function refuseOnWrap() {
  stubWrapChains()
  cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true, rejectChainSwitch: true })
  cy.visit(WRAP_URL)
  cy.get('[data-testid="wrap-coin-field"]', { timeout: 15000 })
    .find('button[aria-haspopup="listbox"]')
    .click()
  cy.contains('[role="option"]', 'Ethereum Classic').click()
  cy.get('#pt-wrap-amount').type('0.25')
  cy.contains('button', /^Wrap ETC on Ethereum Classic$/).click()
}

describe('Multichain writes — one refusal, every surface (spec 110)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  // ---------------------------------------------------------------------------
  // MCW-01 — the vault-proposal surface ("This proposal …")
  // ---------------------------------------------------------------------------
  it('[MCW-01] a refused switch on a vault approve names both chains, and nothing is signed', () => {
    const { stub } = refuseOnVaultQueue()

    cy.get(`${DIALOG} ${rowOn(8453)} [role="alert"]`, { timeout: 20000 })
      .should('be.visible')
      .invoke('text')
      .then((text) => {
        const m = String(text).match(SHARED_REFUSAL)
        expect(m, `the row's refusal is the shared sentence — got: ${text}`).to.not.equal(null)
        // The proposal's chain, and the one the wallet did not leave. Either name missing (or
        // swapped) is the failure this sentence exists to prevent.
        expect(m[2].trim(), 'the chain the write was going to').to.equal('Base')
        expect(m[3].trim(), 'the chain the wallet stayed on').to.equal('Polygon')
      })

    // The wallet never moved, and the refusal's own claim is checked against the wire rather
    // than against the interface: no signature, no estimate, no send.
    cy.window().its('ethereum.chainId').should('eq', '0x89')
    cy.then(() => {
      const reached = stub.log.filter(
        (c) => SIGNING_METHODS.includes(c.method) || c.method === 'eth_estimateGas',
      )
      expect(reached, 'nothing was estimated, signed or sent after a refused switch').to.deep.equal([])
    })
  })

  // ---------------------------------------------------------------------------
  // MCW-02 — the wrap surface, a different rail and a different noun
  // ---------------------------------------------------------------------------
  it('[MCW-02] a refused switch on a wrap names both chains, in the same sentence', () => {
    refuseOnWrap()

    cy.get('[role="alert"]', { timeout: 15000 })
      .invoke('text')
      .then((text) => {
        const m = String(text).match(SHARED_REFUSAL)
        expect(m, `the wrap refusal is the shared sentence — got: ${text}`).to.not.equal(null)
        expect(m[2].trim(), 'the chain the wrap was going to').to.equal('Ethereum Classic')
        expect(m[3].trim(), 'the chain the wallet stayed on').to.equal('Hardhat')
      })
    // The refusal is the whole outcome — no success notice rides along behind it.
    cy.contains('Done —').should('not.exist')
  })

  // ---------------------------------------------------------------------------
  // MCW-03 — the generalization: ONE sentence, two unrelated surfaces
  // ---------------------------------------------------------------------------
  it('[MCW-03] both surfaces produce the identical sentence once the subject and chains are removed', () => {
    const seen = {}

    // Leg 1 — the vault queue. Its estate and its per-chain stubs are the heavier setup, so it
    // runs first, from the clean slate `beforeEach` leaves.
    refuseOnVaultQueue()
    cy.get(`${DIALOG} ${rowOn(8453)} [role="alert"]`, { timeout: 20000 })
      .invoke('text')
      .then((text) => {
        seen.vault = skeletonOf(text)
        expect(seen.vault, `the vault queue did not produce the shared sentence — got: ${text}`).to.not.equal(null)
      })

    // Leg 2 — Wrap, a different rail, a different noun, none of the vault estate.
    cy.clearLocalStorage()
    refuseOnWrap()
    cy.get('[role="alert"]', { timeout: 15000 })
      .invoke('text')
      .then((text) => {
        seen.wrap = skeletonOf(text)
        expect(seen.wrap, `wrap did not produce the shared sentence — got: ${text}`).to.not.equal(null)
      })

    cy.then(() => {
      // The assertion that fails the moment a surface grows a sentence of its own again — which
      // is how this test found `VaultQueueView`'s private copy on its first run.
      expect(seen.vault, 'both write surfaces read from one seam').to.equal(seen.wrap)
      expect(seen.wrap).to.equal(
        '<subject> goes to <target>, but the wallet stayed on <wallet>, so nothing has been signed.',
      )
    })
  })
})
