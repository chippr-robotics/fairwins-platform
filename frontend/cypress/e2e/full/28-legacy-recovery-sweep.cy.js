/**
 * E2E Tests: legacy account recovery — moving the funds (spec 062, Full-tier)
 *
 * NEEDS A CHAIN, and needs one for the right reason: the member signs these transfers with a key
 * they paste in, value leaves an account, and the invariant under test — **one asset failing never
 * aborts the rest** — only exists because real transfers fail one at a time. Against a mock every
 * leg succeeds and the test proves nothing. The import half of the feature (ciphertext at rest, no
 * clear secret anywhere) needs no chain and lives in `fast/28-legacy-recovery.cy.js`.
 *
 * The portfolio the sweep sees is the app's own (`getPortfolioRegistry`): on this chain that is
 * three fungible assets — the wrapped coin, the stablecoin, and the coin itself — both tokens
 * being the local `MockERC20`s the suite already seeds. Nothing here is arranged privately
 * between the test and the chain: the app resolves the addresses through its OWN config, and
 * `before` asserts the chain was seeded with the same ones.
 *
 * The failure in LKR-S2 is a REFUSAL, not a drained balance: `sweepAllAssets` re-reads balances
 * itself, so emptying a token before "Transfer all" just drops it from the run and proves nothing
 * about the assets behind a failure. A token that holds the balance and declines to move it is
 * also the realistic case — a blocklisting stablecoin does exactly that.
 *
 * Every test mints a FRESH legacy EOA. A fixed key would carry balances between runs and make
 * "what moved" a function of how often the suite had been run rather than of the code.
 *
 * Sub-issue of #1228. Flows:
 *   LKR-S1 recovery.sweep-per-asset-outcomes — the whole portfolio moves, ERC-20s then native
 *   LKR-S2 recovery.sweep-per-asset-outcomes — one asset refuses; the others still move
 *   LKR-S3 recovery.import-legacy-key       — storing the key moves nothing on chain
 *
 * Checklist: LKR-S1..LKR-S3
 */

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // #0 — the signed-in member
const DEST = '0x90F79bf6EB2c4f870365E785982E1f101E93b906'  // #3 — the destination account
const PASSPHRASE = 'correct-horse-battery'

/*
 * The addresses and symbols the APP resolves for this chain (`HARDHAT_CONTRACTS` + `NETWORKS[…]`
 * in frontend/src/config, reached here through the E2E_AMOY_LOCAL seam). Mirrored rather than
 * imported: those modules read `import.meta.env`, which does not exist in the Node process that
 * runs the fixture task.
 *
 * Both are asserted against the deployment record in `before`, so a drift between what the app
 * is built with and what the chain was seeded with is NAMED — rather than discovered as "the
 * sweep only found one token", which reads like a bug in the sweep.
 */
const APP_WRAPPED_NATIVE = '0x637914a81B4F67BeA3acd94fc5a233656f8C08f7'
const APP_STABLECOIN = '0xbc4D54AE49ED9C6075770CD6acA930A728dcf526'
const WRAPPED_SYMBOL = 'WPOL'
const STABLE_SYMBOL = 'USDC'
const NATIVE_SYMBOL = 'POL'
// Registry order: the wrapped coin, then the stablecoin, then the coin itself (native last —
// it pays for every transfer, so it can only go last).
const ASSET_ORDER = [WRAPPED_SYMBOL, STABLE_SYMBOL, NATIVE_SYMBOL]

const ONE_COIN = (10n ** 18n).toString()
const TOKEN_AMOUNT = (5n * 10n ** 18n).toString()

const fixture = (action, args = {}) =>
  cy.task('legacyFixture', { action, args }).then((r) => {
    // A silent no-op fixture is how a test ends up dying somewhere unrelated: fail here, where
    // the message still says what could not be arranged.
    expect(r.ok, `legacyFixture ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

// Chai's ordering assertions are not a contract for BigInt, so compare explicitly and put the
// real values in the message — a failure should say what the balances were, not just "false".
const isGreater = (a, b) => BigInt(a) > BigInt(b)
const isLess = (a, b) => BigInt(a) < BigInt(b)

const balancesOf = (address) =>
  fixture('balances', { address, tokens: [APP_WRAPPED_NATIVE, APP_STABLECOIN] })

/*
 * ---------------------------------------------------------------------------
 * Seeding the fresh legacy account (#1327)
 * ---------------------------------------------------------------------------
 * What each test needs on the account before it starts, and how to read that holding back off the
 * chain. The read is the point: a seeding send can be refused or dropped for reasons that have
 * nothing to do with the code under test — the funder EOA is shared with every other fixture in
 * the run — and a spec that assumed its arrangement then died somewhere unrelated, with a message
 * about a fixture rather than about the sweep.
 *
 * Retrying blindly would be the wrong fix: a mint whose receipt was lost still MINTED, and a second
 * attempt would leave twice the balance the per-asset assertions are written against. So the retry
 * is driven by the CHAIN — send, read what the account actually holds, and go again only while it
 * is still short. Nothing here is weakened: the seed now ASSERTS its arrangement (exactly this
 * much, on a brand-new account that started at zero) where it previously assumed it, and a
 * double-seed is named here instead of surfacing later as a transfer that moved the wrong amount.
 */
const SEED_ATTEMPTS = 3
const SEED_PLAN = [
  {
    label: NATIVE_SYMBOL,
    action: 'fundNative',
    want: ONE_COIN,
    held: (b) => b.native,
    args: (address) => ({ address, amount: ONE_COIN }),
  },
  {
    label: WRAPPED_SYMBOL,
    action: 'mintToken',
    want: TOKEN_AMOUNT,
    held: (b) => b.tokens[0],
    args: (address) => ({ address, amount: TOKEN_AMOUNT, token: APP_WRAPPED_NATIVE }),
  },
  {
    label: STABLE_SYMBOL,
    action: 'mintToken',
    want: TOKEN_AMOUNT,
    held: (b) => b.tokens[1],
    args: (address) => ({ address, amount: TOKEN_AMOUNT, token: APP_STABLECOIN }),
  },
]

/** Send one seeding transaction and confirm on chain that it landed; retry only while short. */
function seedStep(address, step, attempt = 1) {
  cy.task('legacyFixture', { action: step.action, args: step.args(address) }).then((r) => {
    // A refused send is not fatal on its own — the read below is what decides.
    if (!r.ok) cy.log(`seed ${step.label} attempt ${attempt}: ${r.error || 'no error message returned'}`)
    balancesOf(address).then((balances) => {
      const got = BigInt(step.held(balances))
      const want = BigInt(step.want)
      if (got === want) return
      if (got > want) {
        throw new Error(`seed ${step.label}: landed more than once — holds ${got}, wants ${want}`)
      }
      if (attempt >= SEED_ATTEMPTS) {
        throw new Error(
          `seed ${step.label}: never landed after ${attempt} attempts — holds ${got}, wants ${want}`,
        )
      }
      seedStep(address, step, attempt + 1)
    })
  })
}

/** Import the legacy key and land on the transfer step with a destination entered. */
function openTransferFor(privateKey, destination = DEST) {
  cy.importLegacyKey({ secret: privateKey, passphrase: PASSPHRASE })
  cy.get('.action-sheet').within(() => {
    cy.contains('button', 'Move funds').click()
    cy.get('#lkr-destination').clear().type(destination)
  })
}

/**
 * Assert the rendered outcomes read `SYMBOL:status`, in the order the sweep produced them.
 *
 * The panel renders a failure's REASON next to it, and that reason is the whole diagnostic value
 * of this spec: `expected [Array(3)] to deeply equal [Array(3)]` says an asset did not move but
 * not why, which is what a CI-only failure leaves you with. So the assertion carries the rows as
 * rendered — reasons included — in its message.
 *
 * Not `.should()`: the caller has already waited for all three rows, and a row is only rendered
 * once its own transfer settled, so there is nothing left to retry towards.
 */
function expectOutcomes(expected) {
  cy.get('.lkr-outcome').then(($rows) => {
    const rows = [...$rows].map((row) => ({
      key: `${row.querySelector('.lkr-outcome__sym').textContent.trim()}:${
        row.className.replace(/.*lkr-outcome--(\w+).*/, '$1')
      }`,
      text: row.textContent.replace(/\s+/g, ' ').trim(),
    }))
    expect(
      rows.map((r) => r.key),
      `outcomes as rendered: ${rows.map((r) => r.text).join(' | ')}`,
    ).to.deep.equal(expected)
  })
}

describe('Legacy account recovery — moving the funds (spec 062)', () => {
  let legacy // { address, privateKey } for THIS test

  before(() => {
    // The app is built with these addresses; the chain is seeded at whatever the deploy produced.
    // If the two ever part company the sweep quietly finds one asset fewer, and the failure reads
    // as "the app lost a token" rather than "the build and the chain disagree". Say it here.
    fixture('deploymentAddresses').then(({ paymentToken, wmatic }) => {
      expect(String(wmatic).toLowerCase(), 'the deployed wrapped coin is the one the app scans')
        .to.equal(APP_WRAPPED_NATIVE.toLowerCase())
      expect(String(paymentToken).toLowerCase(), 'the deployed stablecoin is the one the app scans')
        .to.equal(APP_STABLECOIN.toLowerCase())
    })
  })

  /*
   * Put the wrapped coin's real code back. LKR-S2 overwrites it to make one transfer refuse, and
   * the spec-level chain checkpoint only rewinds within a single `cypress run` — a node reused
   * for a second run would hand LKR-S1 a coin that refuses every transfer, failing the one test
   * that arms nothing.
   */
  after(() => {
    fixture('restoreTokenCode', { token: APP_WRAPPED_NATIVE })
  })

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()

    fixture('newAccount').then((account) => {
      legacy = account
      // One send per asset, each confirmed on chain before the next is enqueued (#1327).
      SEED_PLAN.forEach((step) => seedStep(account.address, step))
    })

    /*
     * `realBalances` is load-bearing: the default mock answers a fixed 100 ETH for EVERY address,
     * so the quote would size its gas reserve against a balance the legacy account does not have
     * and the coin leg would fail for reasons that have nothing to do with the app.
     */
    cy.mockWeb3Provider({ account: OWNER, preAuthorized: true, realBalances: true })
    cy.openLegacyRecovery()
  })

  // ---------------------------------------------------------------------------
  // LKR-S1 — the whole portfolio moves: ERC-20s first, coin last, reserve left behind
  // ---------------------------------------------------------------------------
  it('[LKR-S1] sweeps every supported asset, ERC-20s first and the coin last', () => {
    balancesOf(DEST).then((destBefore) => {
      openTransferFor(legacy.privateKey)

      cy.get('.action-sheet').within(() => {
        // Only fungible assets move, and the screen says so before anything is signed.
        cy.contains(/collectibles\/NFTs are not/i).should('be.visible')

        cy.contains('button', 'Check balances').click()
        cy.get('.lkr-quote', { timeout: 20000 }).should('be.visible')
        cy.get('.lkr-quote').should('contain.text', WRAPPED_SYMBOL).and('contain.text', STABLE_SYMBOL)
        // The fee the legacy key will pay is disclosed as its own line: the member is told what
        // stays behind, not only what moves.
        cy.get('.lkr-quote__fee').should('contain.text', 'Estimated network fee')

        cy.contains('button', 'Transfer all').click()
        cy.get('.lkr-outcome', { timeout: 90000 }).should('have.length', 3)
      })

      // Each asset reports its own outcome, in the order the sweep must use: the coin pays for
      // every transfer, so it can only go last.
      expectOutcomes(ASSET_ORDER.map((symbol) => `${symbol}:sent`))
      cy.get('.action-sheet').contains(/funds moved/i).should('be.visible')

      // Judged by chain state, not by the dialog's wording.
      balancesOf(DEST).then((destAfter) => {
        expect(BigInt(destAfter.tokens[0]) - BigInt(destBefore.tokens[0]), 'wrapped token received')
          .to.equal(BigInt(TOKEN_AMOUNT))
        expect(BigInt(destAfter.tokens[1]) - BigInt(destBefore.tokens[1]), 'stablecoin received')
          .to.equal(BigInt(TOKEN_AMOUNT))
        expect(
          isGreater(destAfter.native, destBefore.native),
          `coin received (${destBefore.native} -> ${destAfter.native})`,
        ).to.equal(true)
      })
      balancesOf(legacy.address).then((left) => {
        expect(BigInt(left.tokens[0]), 'wrapped token fully swept').to.equal(0n)
        expect(BigInt(left.tokens[1]), 'stablecoin fully swept').to.equal(0n)
        // The gas reserve is deliberately NOT swept — it is what paid for the sweep. What stays
        // is dust, not a balance: a small fraction of the coin the account started with.
        expect(
          isLess(left.native, (BigInt(ONE_COIN) / 100n).toString()),
          `only reserve dust left behind (${left.native} wei)`,
        ).to.equal(true)
      })
    })
  })

  // ---------------------------------------------------------------------------
  // LKR-S2 — the invariant this tier exists for: one asset fails, the rest still move
  // ---------------------------------------------------------------------------
  it('[LKR-S2] reports a per-asset failure and still moves every asset that can move', () => {
    balancesOf(DEST).then((destBefore) => {
      openTransferFor(legacy.privateKey)

      cy.get('.action-sheet').within(() => {
        cy.contains('button', 'Check balances').click()
        cy.get('.lkr-quote', { timeout: 20000 }).should('contain.text', WRAPPED_SYMBOL)
      })

      // Refuse the FIRST asset's transfer. It has to be the TRANSFER that fails and not the
      // balance: the sweep re-reads balances itself, so draining the token would simply drop it
      // from the run and prove nothing about what happens to the assets behind a failure.
      fixture('makeTokenRefuse', { token: APP_WRAPPED_NATIVE })

      cy.get('.action-sheet').within(() => {
        cy.contains('button', 'Transfer all').click()
        cy.get('.lkr-outcome', { timeout: 90000 }).should('have.length', 3)
      })

      // The refusal is named against the asset it belongs to, and BOTH assets behind it moved —
      // a failure part-way through the portfolio does not abort what follows it.
      expectOutcomes([
        `${WRAPPED_SYMBOL}:failed`,
        `${STABLE_SYMBOL}:sent`,
        `${NATIVE_SYMBOL}:sent`,
      ])


      cy.get('.action-sheet').within(() => {
        // A run with a failure does NOT claim success: the "Funds moved" screen is withheld and
        // the member is left on the transfer step with the outcomes in front of them.
        cy.contains(/funds moved/i).should('not.exist')
      })

      balancesOf(DEST).then((destAfter) => {
        expect(BigInt(destAfter.tokens[1]) - BigInt(destBefore.tokens[1]), 'stablecoin still moved')
          .to.equal(BigInt(TOKEN_AMOUNT))
        expect(
          isGreater(destAfter.native, destBefore.native),
          `coin still moved (${destBefore.native} -> ${destAfter.native})`,
        ).to.equal(true)
        expect(BigInt(destAfter.tokens[0]) - BigInt(destBefore.tokens[0]), 'nothing arrived for the refused asset')
          .to.equal(0n)
      })
      // The refused asset is still where it was — reported as failed, not silently lost.
      balancesOf(legacy.address).then((left) => {
        expect(BigInt(left.tokens[0]), 'refused token stays on the legacy account').to.equal(BigInt(TOKEN_AMOUNT))
      })
    })
  })

  // ---------------------------------------------------------------------------
  // LKR-S3 — recovery is complete without a transfer; nothing moves unless asked
  // ---------------------------------------------------------------------------
  it('[LKR-S3] leaves the legacy account untouched when the member stores the key and stops', () => {
    balancesOf(legacy.address).then((before) => {
      cy.importLegacyKey({ secret: legacy.privateKey, passphrase: PASSPHRASE })
      cy.get('.action-sheet').within(() => {
        cy.contains(/recovery is complete/i).should('be.visible')
        cy.contains('button', 'Done').click()
      })
      cy.get('.action-sheet').should('not.exist')
      cy.get('.lkr-stored__item').should('have.length', 1)

      // Storing the key moved nothing. The transfer is genuinely optional, on chain too.
      balancesOf(legacy.address).then((after) => {
        expect(BigInt(after.native), 'coin untouched').to.equal(BigInt(before.native))
        expect(after.tokens, 'token balances untouched').to.deep.equal(before.tokens)
      })
    })
  })
})
