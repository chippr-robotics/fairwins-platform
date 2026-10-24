// =============================================================================
// 42-clearpath-native-dao.cy.js
// On-chain E2E for ClearPath pillar A — launching a NATIVE standard DAO
// (spec 030, the 2026-08-30 amendment on issue #1268; coverage issue #1400 §A).
//
//   CD-01  miniapp.clearpath-create-native-dao
//
// ── WHY THIS IS IN THE ON-CHAIN TIER ────────────────────────────────────────
// Admission rule 2 (docs/developer-guide/e2e-testing-policy.md): a member signs
// something that costs them money, so it MUST have on-chain coverage. Creation
// is ~6.34M gas of real deployment — an OpenZeppelin `TimelockController`, a
// stock `Governor` and a fixed-supply `ERC20Votes`, all in ONE transaction the
// member pays for. There is no relayer and no paymaster on this path.
//
// But the money is not even the strongest reason. What creation produces is a
// treasury, and whether that treasury belongs to the member turns entirely on
// five role writes the factory performs and then renounces
// (`StandardDAOFactory._wireAndRelinquish`). A mock cannot answer "does the
// platform still hold DEFAULT_ADMIN_ROLE on this timelock?" — only the timelock
// can, and the day the answer changes to `true` is the day FairWins holds a key
// over every DAO it has ever created. That question is the whole point of this
// spec, and it is a chain question.
//
// ── WHAT IS STUBBED, AND WHAT IS NOT ────────────────────────────────────────
// Only the IPFS gateway transport, exactly as `32-miniapps.cy.js` does it:
// there is no IPFS on this machine, so `cy.intercept` answers the loader's own
// `/ipfs/<cid>/<path>` fetches with the bytes `publish:local:miniapps` staged.
// The integrity check stays entirely real — the loader still takes keccak256 of
// the manifest bytes and compares it to the hash THE CHAIN holds.
//
// Everything else is the real thing: a real membership grant against the real
// `MembershipManager` (the factory's Silver floor is satisfied, never bypassed),
// the real `host.wallet.submit` rail with its host-side sanctions screening, and
// a real `StandardDAOFactory` deployed by `deploy:local:clearpath`.
//
// ── PRECONDITION THIS SPEC CANNOT ARRANGE FOR ITSELF ────────────────────────
// The app resolves `standardDaoFactory` from the HARDCODED block in
// `frontend/src/config/contracts.js` (the E2E tier deliberately does not run
// `sync:frontend-contracts`). `deploy:local:clearpath` DOES deploy the factory
// on this chain — 80002 is in its `CANCUN_CHAIN_IDS` — but if `HARDHAT_CONTRACTS`
// carries no `standardDaoFactory` key, `host.contracts()` answers `null` and the
// Launch tab correctly renders its "not deployed" state. That is the app being
// honest, not a bug, which is why this spec asserts the precondition FIRST and
// names the file to fix: a Launch tab that says "not deployed" and a factory
// that is not deployed are different problems with different remedies.
// =============================================================================

/** Hardhat account #0 — the member, and also the deployer holding every admin role locally. */
const MEMBER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

/** The local node impersonates Amoy so it is the app's membership home (see hardhat.config.js). */
const CHAIN_ID = 80002

/** Must match VITE_MINIAPP_GATEWAY in frontend/package.json's dev:e2e. */
const GATEWAY = 'http://localhost:8090'

/** ClearPath's form defaults (frontend/miniapps/clearpath/src/CreateStandardDao.jsx#DEFAULTS). */
const VOTING_DELAY = 1
const VOTING_PERIOD = 50400
const QUORUM_PERCENT = 4
const TIMELOCK_HOURS = 48
const SUPPLY_WHOLE = 1000n
const WEI = 10n ** 18n

const task = (name, payload) =>
  cy.task(name, payload).then((r) => {
    expect(r.ok, `${name}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

const dao = (action, args = {}) => task('clearpathDao', { action, args })
const actor = (action, args = {}) => task('appActorFixture', { action, args })
const registry = (action, args = {}) => task('miniappFixture', { action, args })

/**
 * Answer the loader's own gateway fetches with `files`, a { path: text } map.
 *
 * Serves BYTES rather than a parsed body: the manifest is hashed before it is parsed, so a stub
 * that replied with an object would skip the very step that admits the package.
 */
const serveFiles = ({ cid, files }) => {
  for (const [path, text] of Object.entries(files)) {
    cy.intercept('GET', `${GATEWAY}/ipfs/${cid}/${path}`, (req) => {
      req.reply({ statusCode: 200, body: text, headers: { 'content-type': 'text/plain' } })
    })
  }
}

/** Put the REAL ClearPath package on the chain and on the gateway. */
const publishClearPath = () =>
  task('miniappRealPackage', { app: 'clearpath' }).then((pkg) => {
    serveFiles(pkg)
    return registry('ensureServing', {
      name: pkg.name,
      cid: pkg.cid,
      manifestHash: pkg.manifestHash,
    }).then((record) => {
      expect(record.launchable, 'ClearPath is serving').to.equal(true)
      expect(record.approved.manifestHash, 'and it is the package just built').to.equal(pkg.manifestHash)
      return pkg
    })
  })

describe('ClearPath native standard DAOs (spec 030 pillar A)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[CD-01] miniapp.clearpath-create-native-dao — one member-paid transaction deploys a governor, a timelock treasury and a token, and the DAO owns itself', () => {
    const stamp = Date.now().toString().slice(-6)
    const DAO_NAME = `E2E DAO ${stamp}`
    const TOKEN_NAME = `E2E DAO Token ${stamp}`
    const TOKEN_SYMBOL = `ED${stamp}`

    publishClearPath().then((pkg) => {
      expect(pkg.contracts, 'the package declares the factory it resolves').to.include('standardDaoFactory')
      expect(pkg.permissions, 'and asks the host for a write rail').to.include('wallet:submit')

      /*
       * Silver on DAO_MEMBER_ROLE is `StandardDAOFactory.MIN_TIER`, checked on chain in
       * `_checkAuthorized`. Granting it satisfies the gate; it does not bypass it — a run without
       * this line reverts `InsufficientMembershipTier` at the factory, which is the gate working.
       */
      actor('grantDaoTier', { address: MEMBER })

      dao('factoryState').then((factory) => {
        expect(
          factory.deployed,
          'StandardDAOFactory must be deployed AND recorded on the local chain — `deploy:local:clearpath` ' +
            'does that inside `npm run setup:e2e`',
        ).to.equal(true)

        const daosBefore = factory.count

        // The member's balance is read AFTER every arranging transaction (the grant above is sent
        // from this same account) and BEFORE the click, so the only spend between this read and
        // the next one is the creation itself.
        dao('nativeBalance', { address: MEMBER }).then(({ wei: balanceBefore }) => {
          cy.mockWeb3Provider({
            account: MEMBER,
            preAuthorized: true,
            realBalances: true,
            networkId: CHAIN_ID,
          })
          cy.visit('/apps/clearpath')
          cy.get('.miniapp-workspace-root', { timeout: 60000 }).should('exist')
          cy.get('.miniapp-workspace-refusal').should('not.exist')

          cy.contains('.cp-tab', /^Launch$/, { timeout: 30000 }).click()

          /*
           * THE DISCLOSURE, MEASURED AGAINST WHAT THE SURFACE ACTUALLY CLAIMS.
           *
           * The Launch form states three things before a member signs: that this deploys real
           * contracts in ONE transaction on a NAMED network, that it needs a Silver membership,
           * and that nobody — FairWins included — can upgrade or pause the result. Those are the
           * claims the member is being asked to act on, so those are what is asserted.
           *
           * The package ships no explicit "you pay the network fee" line. That absence is
           * reported rather than papered over (see this spec's report); what CAN be checked is
           * that it never claims the opposite, and the chain settles the rest below — `from` is
           * the member and the fee left their balance, which is what "not gasless" means.
           */
          cy.contains('.cp-card', /Launch a DAO/i, { timeout: 20000 }).within(() => {
            cy.contains('.cp-intro', /in one transaction on Polygon Amoy/i).should('be.visible')
            cy.contains('.cp-intro', /Requires a Silver membership/i).should('be.visible')
            cy.contains('.cp-intro', /nobody, including FairWins, can\s+upgrade or pause them afterwards/i)
              .should('be.visible')
          })
          cy.get('.miniapp-workspace-root')
            .invoke('text')
            .should('not.match', /gasless|no gas|free to (launch|create)|we (cover|pay) the gas|sponsored/i)

          // ── The member fills the form the package renders. ──────────────────────────────
          cy.get('#cp-dao-name').clear().type(DAO_NAME)
          cy.get('#cp-dao-purpose').clear().type('End-to-end coverage for spec 030 pillar A')
          cy.get('#cp-dao-token-name').clear().type(TOKEN_NAME)
          cy.get('#cp-dao-token-symbol').clear().type(TOKEN_SYMBOL)
          cy.get('#cp-dao-supply').clear().type(String(SUPPLY_WHOLE))

          // Issue #1408 — the fee disclosure sits directly above the button, BEFORE the signature.
          // The statement is unconditional; the estimate line must have settled to either a read
          // number or the honest "could not be confirmed" sentence — never the pending copy.
          cy.get('.cp-fee-v').should('contain.text', 'You pay the network fee for this deployment')
          cy.get('.cp-fee-est', { timeout: 30000 }).should(($p) => {
            const text = $p.text()
            expect(text, 'the estimate settled').not.to.match(/Estimating the fee/)
            expect(text, 'the estimate is a read number or an honest refusal').to.match(
              /Estimated [\d,]+ gas|could not be confirmed/
            )
          })
          cy.contains('button', /^Launch DAO$/).should('not.be.disabled').click()

          /*
           * The app waits for CONFIRMATION before it shows a DAO — `submit` resolves at broadcast,
           * and `useStandardDao` reads the created addresses out of the receipt's own
           * `StandardDAOCreated` log. So this heading is the app agreeing with the chain rather
           * than guessing, and a `proposed`/`pending` outcome deliberately never reaches it.
           */
          cy.contains('h4', `${DAO_NAME} is live`, { timeout: 120000 }).should('be.visible')
          cy.contains('.cp-ok', /Deployed on Polygon Amoy/i).should('be.visible')

          // The address the SPA is showing the member, taken from the DOM and then checked against
          // the chain. A surface that displayed the wrong address would still look correct here.
          cy.contains('.cp-kv .k', /^Governor$/)
            .parent()
            .find('.cp-mono')
            .invoke('text')
            .then((shownGovernor) => {
              const governor = shownGovernor.trim()
              expect(governor, 'the SPA shows a governor address').to.match(/^0x[0-9a-fA-F]{40}$/)

              dao('daoByGovernor', { governor }).then((created) => {
                // ── The factory recorded exactly one new DAO, and it is this one. ──────────
                expect(created.record.governor, 'the address on screen is the address on chain')
                  .to.equal(governor)
                expect(created.record.creator.toLowerCase(), 'attributed to the member who signed')
                  .to.equal(MEMBER.toLowerCase())
                expect(created.record.name, 'under the name they typed').to.equal(DAO_NAME)
                expect(created.record.tokenDeployed, 'and the factory minted a new token').to.equal(true)
                expect(created.isDAO, 'the factory recognises its own product').to.equal(true)
                expect(created.byCreator, 'and indexes it against the creator').to.include(created.id)
                expect(created.id, 'ids are allocated in order').to.equal(daosBefore + 1)

                // ── The governor is bound to what the record says, by its own account. ─────
                expect(created.governor.name, 'the governor carries the DAO name').to.equal(DAO_NAME)
                expect(created.governor.token, 'and votes on the token the record names')
                  .to.equal(created.record.token)
                expect(created.governor.timelock, 'and queues into the timelock the record names')
                  .to.equal(created.record.timelock)
                // The parameters the member left at their defaults reached the chain intact —
                // a swapped votingDelay/votingPeriod would build a valid but wrong DAO.
                expect(created.governor.votingDelay, 'voting delay').to.equal(VOTING_DELAY)
                expect(created.governor.votingPeriod, 'voting period').to.equal(VOTING_PERIOD)
                expect(created.governor.quorumNumerator, 'quorum %').to.equal(QUORUM_PERCENT)
                expect(created.timelock.minDelay, 'timelock delay, in seconds').to.equal(
                  TIMELOCK_HOURS * 3600,
                )

                /*
                 * ── THE SECURITY CORE, READ BACK FROM THE TIMELOCK ITSELF ─────────────────
                 * Only the governor may schedule against the treasury; execution is open so a
                 * passed proposal can never be stranded behind an absent executor; and the
                 * factory's admin role is GONE. If `_wireAndRelinquish`'s renounce were ever
                 * dropped, FairWins would hold root over this member's treasury — and every
                 * other DAO the factory has created — while every unit test still passed.
                 */
                expect(created.timelock.governorIsProposer, 'the governor may propose').to.equal(true)
                expect(created.timelock.governorIsCanceller, 'and may cancel').to.equal(true)
                expect(created.timelock.executorIsOpen, 'execution is open (address(0))').to.equal(true)
                expect(created.timelock.creatorIsProposer, 'the creator canNOT schedule directly')
                  .to.equal(false)
                expect(created.timelock.factoryIsAdmin, 'the FACTORY holds no admin role').to.equal(false)
                expect(created.timelock.creatorIsAdmin, 'and neither does the creator').to.equal(false)
                expect(created.timelock.selfIsAdmin, 'the timelock administers itself').to.equal(true)

                // ── The electorate exists and can vote immediately. ───────────────────────
                // A fresh ERC20Votes holder has zero weight until they delegate, so a DAO whose
                // only holder never delegated cannot reach quorum on its own first proposal.
                expect(created.token.symbol, 'the token the member named').to.equal(TOKEN_SYMBOL)
                expect(created.token.totalSupply, 'the supply they asked for, at 18 decimals')
                  .to.equal((SUPPLY_WHOLE * WEI).toString())
                expect(created.token.creatorBalance, 'minted to the creator')
                  .to.equal((SUPPLY_WHOLE * WEI).toString())
                expect(created.token.creatorDelegate.toLowerCase(), 'and self-delegated at mint')
                  .to.equal(MEMBER.toLowerCase())

                /*
                 * ── WHO PAID ──────────────────────────────────────────────────────────────
                 * Creation is NOT gasless. The account that signed is the account the chain
                 * charged: a sponsored rail would show a different `from`, and a zero fee would
                 * show a chain that charged nobody.
                 */
                dao('creationTx', { governor }).then((tx) => {
                  expect(tx.status, 'the creating transaction succeeded').to.equal(1)
                  expect(tx.from.toLowerCase(), 'the MEMBER signed and paid — no relayer, no paymaster')
                    .to.equal(MEMBER.toLowerCase())
                  expect(tx.to.toLowerCase(), 'straight to the factory the host resolved')
                    .to.equal(factory.address.toLowerCase())
                  expect(tx.value, 'the factory holds no funds and is sent none').to.equal('0')
                  // Explicit comparisons: chai's ordering matchers are not a contract for BigInt.
                  expect(BigInt(tx.fee) > 0n, 'and the transaction cost real gas').to.equal(true)

                  dao('nativeBalance', { address: MEMBER }).then(({ wei: balanceAfter }) => {
                    expect(BigInt(balanceAfter) < BigInt(balanceBefore), 'the member is poorer than before they signed')
                      .to.equal(true)
                    expect(
                      BigInt(balanceBefore) - BigInt(balanceAfter),
                      'by exactly the fee this transaction cost — nothing else spent from this account',
                    ).to.equal(BigInt(tx.fee))
                  })

                  /*
                   * ── THE FOLLOW-UP THE SURFACE OFFERS ──────────────────────────────────
                   * This chain HAS an on-chain registry, so the offer is "Register in the DAO
                   * registry" rather than device-local tracking, and taking it puts the new
                   * governor in the same list external DAOs live in (FR-009).
                   *
                   * It is also the only end-to-end proof that what the factory built is a real
                   * `IGovernor`: `ExternalDAORegistry.registerExternalDAO` reverts `NotAGovernor`
                   * unless the address answers the ERC-165 probe or the two `IGovernor` views.
                   */
                  actor('daoRegistry', { dao: governor, registrant: MEMBER }).then((before) => {
                    expect(before.registered, 'nothing has registered this DAO yet').to.equal(false)
                  })

                  cy.contains('button', /^Register in the DAO registry$/).should('not.be.disabled').click()
                  cy.contains('.cp-ok', /Added to your DAOs/i, { timeout: 90000 }).should('be.visible')

                  actor('daoRegistry', { dao: governor, registrant: MEMBER }).then((after) => {
                    expect(after.registered, 'the new DAO is registered on chain').to.equal(true)
                    expect(after.byRegistrant, 'against the member who signed')
                      .to.have.length.greaterThan(0)
                  })
                })
              })
            })
        })
      })
    })
  })
})
