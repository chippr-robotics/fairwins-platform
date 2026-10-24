// ***********************************************
// FairWins E2E Test Custom Commands
//
// Provides wallet mocking, navigation, form helpers,
// and Hardhat node interaction for E2E testing.
// ***********************************************

const TEST_ACCOUNTS = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // #0 Creator / Admin
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // #1 Opponent
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', // #2 Arbitrator
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906', // #3 Guardian / Moderator
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', // #4 Bystander
]

/**
 * Inject a mock Web3 provider into the page.
 * Call BEFORE cy.visit() to ensure provider is available when the app loads.
 */
Cypress.Commands.add('mockWeb3Provider', (options = {}) => {
  const networkId = options.networkId || Cypress.env('NETWORK_ID') || 1337
  const rpcUrl = options.rpcUrl || Cypress.env('RPC_URL') || 'http://localhost:8545'
  const initialAccount = options.account || TEST_ACCOUNTS[0]
  /*
   * A real injected wallet reports NO accounts until the site has been authorised: `eth_accounts`
   * returns [] and only `eth_requestAccounts` (the user pressing Connect) grants access.
   *
   * This mock used to return the account for BOTH, which made it look permanently pre-authorised.
   * That was invisible while the mock itself was undiscoverable — but once it announces over
   * EIP-6963 (issue #1016), wagmi finds it, sees a non-empty eth_accounts, and AUTO-CONNECTS on
   * load. The app then renders the connected header, `.wallet-connect-button` never exists, and
   * specs written to click Connect fail on a UI that skipped straight past them.
   *
   * So the default is now honestly disconnected. Pass `{ preAuthorized: true }` for a spec that
   * wants a restored session.
   */


  /*
   * The chain is MUTABLE, because a real wallet's chain is. `wallet_switchEthereumChain` used to
   * resolve(null) without moving `networkId`, so the app's auto-switch (WalletContext: unsupported
   * chain -> switchChain(PRIMARY_CHAIN_ID), banner only `onError`) reported success while every
   * subsequent eth_chainId still returned the old chain. Nothing could ever reach either real
   * outcome — recovered, or told to switch — so the wrong-network specs asserted neither.
   *
   * `rejectChainSwitch: true` models the other honest wallet behaviour: the member declines, or the
   * wallet has no such chain. That is the ONLY path that raises the network error banner.
   */

  /*
   * `rejectConnect: true` models the member pressing Cancel on the wallet's connect prompt:
   * `eth_requestAccounts` rejects with EIP-1193 4001 and the wallet grants nothing.
   *
   * It has to live HERE rather than in a spec's own `window:before:load`, which is what WAL-07
   * used to do. That handler assigned its own `win.ethereum` wholesale, so it raced this mock's
   * handler for the same window — and, more decisively, it announced nothing over EIP-6963, so
   * wagmi never discovered it and the connect modal offered no connector to decline with. A
   * refusal is a property of the wallet this mock already announces, not of a second wallet.
   */

  /*
   * This call's wallet state. ONE object per mockWeb3Provider() CALL, closed over by the
   * handler below — so it SURVIVES page loads (that persistence is load-bearing: connect once,
   * and every later cy.visit auto-restores the session because `authorized` is still true).
   * The window only ever holds a POINTER to the currently-winning call's state.
   */
  const st = {
    activeAccount: initialAccount,
    activeChainId: Number(networkId),
    authorized: options.preAuthorized === true,
    rejectChainSwitch: options.rejectChainSwitch === true,
    rejectConnect: options.rejectConnect === true,
    /*
     * `eth_getBalance` answers a FIXED 100 ETH by default, which is fine while a spec only needs
     * the connected account to look funded. It is a fabrication the moment a spec reads the
     * balance of an account it does NOT control — a recovered legacy key, say — because the stub
     * answers 100 ETH for every address on earth, including one holding nothing.
     *
     * `realBalances: true` asks the node instead, so a balance the app displays (and the gas
     * reserve it sizes from that balance) is the chain's own answer. Opt-in: the default is
     * unchanged for every spec written against the stub.
     */
    realBalances: options.realBalances === true,
  }

  cy.on('window:before:load', (win) => {
    // Suppress the dev banner so its fixed-position overlay doesn't cover
    // interactive elements in tests.
    try {
      win.localStorage.setItem('dev_warning_banner_dismissed', 'true')
    } catch { /* localStorage may be unavailable; ignore */ }

    /*
     * ONE provider object per page load, whatever the handler count.
     *
     * cy.on('window:before:load') handlers registered in a `before` hook are bound to the FIRST
     * test, so that test's page load runs the hook's handler AND its own. Each used to build its
     * own provider object and announce it — and mipd keeps the FIRST announce per uuid, so wagmi
     * connected to the HOOK's provider, whose closure account was whatever ensureEncryptionKeys
     * touched last (an account with a key and NO membership). The spec's first create then failed
     * the contract's membership gate while every later test passed: CRE-01 / ACC-01 / DEC-01, and
     * only ever test #1.
     *
     * Handlers run in registration order and each points win.__cyMockActive at ITS call's
     * closure state, so the LAST caller wins deterministically and exactly one provider is
     * ever announced. The state itself stays in the closure — NOT on the window — because a
     * window resets every page load, and `authorized` surviving cy.visit is what lets a
     * connected session auto-restore on the next page (the first cut of this fix moved the
     * state onto the window and every post-connect visit woke up logged out).
     */
    /*
     * The window carries a POINTER to the winning call's state, never the state itself.
     * Handlers run in registration order on every load, so the LAST mockWeb3Provider call's
     * closure wins deterministically — and because the state object itself lives in that
     * call's closure, mutations made through the provider (connect, __cySetAccount) persist
     * across this test's later page loads exactly as they always did.
     */
    win.__cyMockActive = st
    const S = () => win.__cyMockActive
    if (win.ethereum) {
      // A provider from an earlier handler on THIS load — just re-point its surface fields.
      win.ethereum.selectedAddress = st.activeAccount
      win.ethereum.chainId = `0x${st.activeChainId.toString(16)}`
      win.ethereum.networkVersion = String(st.activeChainId)
      return
    }

    /**
     * Forward a JSON-RPC call to the node, mapping a JSON-RPC error onto a real rejection
     * (EIP-1193 shape) so viem/ethers see reverts and failed estimates instead of `undefined`.
     * That is what makes write txs work: a reverting eth_estimateGas rejects, and
     * eth_sendTransaction / eth_sendRawTransaction surface the node's own error.
     */
    const forwardToNode = (method, params, resolve, reject) => {
      fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data && data.error) {
            const e = new Error(data.error.message || 'RPC error')
            e.code = data.error.code
            e.data = data.error.data
            reject(e)
          } else {
            resolve(data.result)
          }
        })
        .catch((err) => reject(err))
    }

    win.ethereum = {
      isMetaMask: true,
      selectedAddress: S().activeAccount,
      networkVersion: networkId.toString(),
      chainId: `0x${networkId.toString(16)}`,

      request: ({ method, params }) => {
        return new Promise((resolve, reject) => {
          switch (method) {
            case 'eth_requestAccounts':
              if (S().rejectConnect) {
                // The member pressed Cancel in the wallet. EIP-1193 4001, and NOTHING is
                // granted — `authorized` stays false, so a later eth_accounts is still empty.
                const rejected = new Error('User rejected the request.')
                rejected.code = 4001
                reject(rejected)
                break
              }
              // The user pressing Connect. Grants access for the rest of this page load.
              S().authorized = true
              resolve([S().activeAccount])
              break
            case 'eth_accounts':
              // Silent probe on load — empty until authorised, exactly like a real wallet.
              resolve(S().authorized ? [S().activeAccount] : [])
              break
            case 'eth_chainId':
              resolve(`0x${S().activeChainId.toString(16)}`)
              break
            case 'wallet_switchEthereumChain':
              if (S().rejectChainSwitch) {
                // EIP-1193 user-rejection. 4902 (unrecognised chain) is the other realistic
                // refusal; both leave the wallet on its original chain, which is the point.
                const err = new Error('User rejected the request.')
                err.code = 4001
                reject(err)
                break
              }
              win.ethereum.__cySetChain(Number(params?.[0]?.chainId ?? S().activeChainId))
              resolve(null)
              break
            case 'wallet_addEthereumChain':
              resolve(null)
              break
            case 'net_version':
              resolve(S().activeChainId.toString())
              break
            case 'eth_getBalance':
              // The stub answers for EVERY address, so a spec reading an account it does not
              // control gets a fabricated balance. `realBalances` asks the node instead.
              if (S().realBalances) forwardToNode(method, params, resolve, reject)
              else resolve('0x56bc75e2d63100000') // 100 ETH
              break
            case 'personal_sign':
            case 'eth_sign':
              // Deterministic PER-ACCOUNT signature. encryption.js derives keys via
              // keccak256(toUtf8Bytes(signature)) and never verifies the signature,
              // so any account-distinct deterministic value yields per-account keys
              // (a same-for-all value would let a non-participant decrypt). Expand
              // the 40-hex-char account to a 65-byte (130-hex) value.
              resolve('0x' + S().activeAccount.slice(2).toLowerCase().repeat(4).slice(0, 130))
              break
            case 'eth_signTypedData_v4':
            case 'eth_signTypedData':
              /*
               * Deterministic PER-ACCOUNT typed-data signature, the same idea as personal_sign
               * above and with the same hard limit: IT DOES NOT VERIFY. No key produced it, so
               * `ecrecover` over the EIP-712 digest returns some other address, and ERC-1271
               * would return nothing at all. Any surface whose signature is actually CHECKED —
               * the registry's `…WithSig` twins, the relay's signer recovery — needs a real
               * signer (the on-chain tier) or an explicitly stubbed verification boundary.
               *
               * What it IS for is the surfaces where the member's signature is the ceremony and
               * something else is under test. Spec 095's API-key grant is signed here, encoded
               * into an `fw1.…` capability token, and verified by the GATEWAY — which a
               * no-chain-tier spec intercepts — so the signature never has to be real for the
               * flow to be real.
               *
               * Shaped like a 65-byte secp256k1 signature (r‖s‖v) and ending in a plausible `v`
               * byte, which also makes it distinguishable from this mock's personal_sign value.
               */
              resolve('0x' + S().activeAccount.slice(2).toLowerCase().repeat(4).slice(0, 128) + '1b')
              break
            default:
              forwardToNode(method, params, resolve, reject)
          }
        })
      },

      enable: () => Promise.resolve([S().activeAccount]),
      send: (method, params) => win.ethereum.request({ method, params }),

      /*
       * Switch the connected account the way a real wallet does — mutate the LIVE provider and
       * emit `accountsChanged`. Used by cy.switchAccount.
       *
       * The old cy.switchAccount called cy.mockWeb3Provider() again and reloaded. That registered a
       * SECOND `window:before:load` handler; both ran on reload, the later one won, and it carried
       * a fresh `S().authorized = false`. Probed result: the provider reported `eth_accounts: []` while
       * the UI still displayed account 0 — the app showed a stale account while the provider said
       * disconnected, and every post-switch assertion in 05-wager-acceptance was reading the wrong
       * account. Reloading is also not what a switch does: a real member switches in MetaMask and
       * the live page follows.
       */
      __cySetAccount: (next) => {
        S().activeAccount = next
        win.ethereum.selectedAddress = next
        S().authorized = true
        const cbs = (win.ethereum._callbacks && win.ethereum._callbacks.accountsChanged) || []
        cbs.forEach((cb) => cb([next]))
      },

      /*
       * Move the chain the way a real wallet does: mutate the LIVE provider and emit
       * `chainChanged` with the hex id, so wagmi's watcher reconciles instead of the app
       * re-reading a chain that silently never moved.
       */
      __cySetChain: (next) => {
        S().activeChainId = Number(next)
        const hex = `0x${S().activeChainId.toString(16)}`
        win.ethereum.chainId = hex
        win.ethereum.networkVersion = S().activeChainId.toString()
        const cbs = (win.ethereum._callbacks && win.ethereum._callbacks.chainChanged) || []
        cbs.forEach((cb) => cb(hex))
      },

      on: (event, callback) => {
        win.ethereum._callbacks = win.ethereum._callbacks || {}
        win.ethereum._callbacks[event] = win.ethereum._callbacks[event] || []
        win.ethereum._callbacks[event].push(callback)
      },
      removeListener: (event, callback) => {
        if (win.ethereum._callbacks && win.ethereum._callbacks[event]) {
          win.ethereum._callbacks[event] = win.ethereum._callbacks[event]
            .filter(cb => cb !== callback)
        }
      },
      removeAllListeners: (event) => {
        if (win.ethereum._callbacks) {
          if (event) delete win.ethereum._callbacks[event]
          else win.ethereum._callbacks = {}
        }
      }
    }

    /*
     * ANNOUNCE THE PROVIDER OVER EIP-6963 (issue #1016).
     *
     * Setting `window.ethereum` alone is no longer enough. This app uses wagmi 3
     * (src/wagmi.js -> injected({ shimDisconnect: true })), which discovers wallets through
     * EIP-6963 announcements via mipd — it never inspects window.ethereum to build the connector
     * list. So the mock was invisible: ConnectModal rendered no available `.connector-option`,
     * every wallet spec failed with "Expected to find element .connector-option:not(.unavailable)",
     * and it had been that way since the wagmi migration — silently, because the E2E gate could
     * not fail (fixed in #1015).
     *
     * The contract is exactly mipd's (node_modules/mipd/dist/esm/utils.js):
     *   · dispatch `eip6963:announceProvider` with a FROZEN { info, provider } detail
     *   · keep answering `eip6963:requestProvider`, because the app requests on mount — which is
     *     after this hook runs, so a single fire-and-forget announcement would be missed
     *
     * Events go through `win`, not Cypress's own window: this is the application's realm.
     */
    const detail = Object.freeze({
      info: Object.freeze({
        // A stable uuid keeps the connector identity stable across re-announcements within a spec.
        uuid: '00000000-0000-4000-8000-0000000f1a17',
        name: 'MetaMask',
        // rdns is what wagmi keys the connector on; io.metamask matches the mock's isMetaMask.
        rdns: 'io.metamask',
        // Inline SVG: EIP-6963 requires a data URI, and a remote icon would be a network
        // dependency in a test.
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      }),
      provider: win.ethereum,
    })

    const announce = () => {
      try {
        win.dispatchEvent(new win.CustomEvent('eip6963:announceProvider', { detail }))
      } catch { /* realm torn down mid-test; nothing to announce to */ }
    }
    win.addEventListener('eip6963:requestProvider', announce)
    announce()
  })
})

/**
 * Switch to a different Hardhat test account by index (0-4).
 * Mutates the LIVE provider and emits `accountsChanged`, exactly as a wallet does — it does NOT
 * reload the page or re-initialise the mock. Asserts the app followed the switch.
 */
Cypress.Commands.add('switchAccount', (accountIndex) => {
  const account = TEST_ACCOUNTS[accountIndex]
  if (!account) throw new Error(`Invalid account index: ${accountIndex}`)

  cy.window().then((win) => {
    if (!win.ethereum || typeof win.ethereum.__cySetAccount !== 'function') {
      throw new Error('switchAccount: cy.mockWeb3Provider() must run before the visit')
    }
    /*
     * Drop the wager cache BEFORE the switch (#1250). The `friendMarkets:<chainId>` key is
     * per CHAIN, not per account, and this command deliberately does not reload — left in
     * place, the previous account's key would satisfy `cy.settledWagerPanel()` the instant
     * it is called, while the new account's scan is still running. The address change
     * re-runs FriendMarketsContext's effect, so the key is rewritten exactly when THIS
     * account's fetch completes — which is also what the app would show after a reload.
     */
    try {
      Object.keys(win.localStorage)
        .filter((k) => k === 'friendMarkets' || k.startsWith('friendMarkets:'))
        .forEach((k) => win.localStorage.removeItem(k))
    } catch {
      // Storage unavailable in this realm; settledWagerPanel falls back to its timeout.
    }
    win.ethereum.__cySetAccount(account)
  })

  // The app must FOLLOW the switch. Account switching is a core feature, so prove it landed
  // rather than assuming the event was honoured.
  cy.assertActiveAccount(account)
})

/**
 * Assert which account the app currently believes is connected.
 *
 * The address renders only INSIDE the opened account dropdown (WalletButton.jsx puts
 * `.account-address-value` behind `{isOpen && ...}`), so this opens it, checks, and closes it
 * again — leaving the UI as it found it.
 */
Cypress.Commands.add('assertActiveAccount', (address) => {
  const short = `${address.slice(0, 6)}`
  /*
   * SCROLL TO THE TOP FIRST. The account button lives in a POSITION:FIXED header
   * (HeaderBar.css:2). Callers routinely arrive here having scrolled — cy.registerEncryptionKeyViaUI
   * scrollIntoView()s a control far down the Recovery accordion — and Cypress then refuses the
   * click with "not visible because its ancestor has `position: fixed` CSS property and it is
   * overflowed by other elements". That is what failed 02-membership's `before all` hook, taking
   * all 13 of its tests with it, while the thing the hook was actually doing had SUCCEEDED (the
   * key registered on-chain).
   *
   * Deliberately NOT {force: true}: forcing would also sail past a button that is genuinely
   * unreachable, and this repo has already been bitten by force hiding a real defect.
   */
  cy.scrollTo('top', { ensureScrollable: false })
  cy.get('.wallet-account-button', { timeout: 10000 }).should('be.visible').click()
  cy.get('.account-address-value', { timeout: 10000 })
    .invoke('text')
    .should((t) => {
      expect(t.toLowerCase(), `connected account should be ${address}`).to.include(short.toLowerCase())
    })
  cy.get('.wallet-account-button').click()
})

/**
 * Wait for wallet connection UI to appear.
 */
Cypress.Commands.add('waitForWalletConnection', () => {
  /*
   * Wait for the CONNECTED INDICATOR, not for the address text.
   *
   * This helper waited on `[data-testid="wallet-address"], .wallet-address, .connected-wallet`.
   * The first of those has never existed in the app (`git log -S` finds no commit that added it),
   * and the address text itself only renders INSIDE the account dropdown — WalletButton.jsx puts
   * `.account-address-value` behind `{isOpen && ...}`. So the helper waited ten seconds for
   * something that appears only after a click it never makes, and every spec that connects a
   * wallet failed on it. That single helper accounted for 28 of the suite's failures.
   *
   * `.wallet-account-button` IS the connected state: WalletButton renders it in place of the
   * connect button as soon as an account is present.
   */
  cy.get('.wallet-account-button, button[aria-label="Wallet Account"]', { timeout: 10000 })
    .should('be.visible')
})

/**
 * Connect wallet via the UI connect button.
 */
Cypress.Commands.add('connectWallet', () => {
  cy.window().then((win) => {
    if (!win.ethereum) {
      cy.mockWeb3Provider()
    }
  })

  /*
   * ALREADY CONNECTED IS A VALID STATE, not a failure.
   *
   * The mock's `authorized` flag lives in the COMMAND CLOSURE, not in the page, so it survives
   * cy.visit() — and __cySetAccount sets it too. A spec whose `before` hook connected once (e.g.
   * ensureEncryptionKeys, which must connect to register a key) therefore reaches its first test
   * with the session already restored and NO connect button in the DOM. Insisting on the button
   * turned that into a 10s timeout and cost 02-membership all 13 of its tests, on a page that was
   * working correctly and showing the connected account.
   *
   * Clearing localStorage/cookies in a beforeEach does not undo it: the flag is not stored there.
   */
  /*
   * WAIT for a terminal state before branching — a one-shot jQuery check races wagmi's async
   * session restore. After cy.reload() the closure's `authorized` flag makes eth_accounts
   * non-empty, wagmi reconnects a beat later, and a synchronous look at the body sees NEITHER
   * button yet: the check concluded "not connected", went to the fresh-connect ceremony, and
   * then waited on a Connect button that never renders on an already-connected page. Waiting
   * for whichever button appears makes the branch race-free.
   */
  cy.get(
    '.wallet-account-button, button[aria-label="Wallet Account"], .wallet-connect-button, button[aria-label="Connect Wallet"]',
    { timeout: 10000 }
  ).then(($el) => {
    const connected = $el.filter('.wallet-account-button, [aria-label="Wallet Account"]').length > 0
    if (connected) return
    cy.connectWalletFresh()
  })
})

/** The actual connect ceremony. Split out so connectWallet can skip it when already connected. */
Cypress.Commands.add('connectWalletFresh', () => {
  cy.contains('button', /connect wallet/i, { timeout: 10000 })
    .should('be.visible')
    .should('not.be.disabled')
    .click({ force: true })

  /*
   * Clicking "Connect Wallet" only OPENS ConnectModal — it does not connect anything.
   * Something has to choose a connector from the dialog, and this helper never did, so
   * `waitForWalletConnection` below sat waiting on a connection nobody had initiated.
   * Every one of the 14 `cy.connectWallet()` call sites failed on it.
   *
   * The specs that connect successfully are precisely the ones that drive the dialog
   * themselves via `cy.selectInjectedConnector()`; this makes the helper do the same.
   */
  cy.selectInjectedConnector()

  cy.waitForWalletConnection()
})

/**
 * Verify the connected network chain ID.
 */
Cypress.Commands.add('verifyNetwork', (expectedChainId = Number(Cypress.env('NETWORK_ID')) || 1337) => {
  cy.window().then((win) => {
    if (win.ethereum) {
      return win.ethereum.request({ method: 'eth_chainId' })
    }
  }).then((chainId) => {
    const numericChainId = parseInt(chainId, 16)
    expect(numericChainId).to.equal(expectedChainId)
  })
})

/*
 * WAGERS_PATH, inlined from src/config/appNav.js:74.
 *
 * Deliberately NOT imported: appNav.js -> config/tenant.js imports the Vite virtual module
 * `virtual:tenant`, and the Cypress preprocessor has no plugin that can resolve it — importing it
 * fails the whole spec bundle. src/test/ guards the real value; this is a copy under test.
 */
const WAGERS_PATH = '/wallet?tab=paytransfer&view=wagers'

/*
 * Resolution-type labels, from FriendMarketsModal.jsx RESOLUTION_TYPE_LABELS. Keyed by the numeric
 * ResolutionType so specs can keep passing the enum value they always passed.
 */
const RESOLUTION_TYPE_LABELS = {
  0: 'Either of Us (equal stakes)',
  1: 'Me (Creator)',
  2: 'Them (Opponent)',
  3: 'A Friend (Arbitrator)',
  4: 'An Oracle (Polymarket)',
}

/**
 * Choose who can resolve the wager.
 *
 * The control is a `PillSelect` — `role="radiogroup"` of `role="radio"` BUTTONS — not a `<select>`,
 * so `.select()` could never drive it. Specs targeted `#fm-resolution-type, .fm-select`; neither
 * string appears in any `.jsx` in the app. Click the pill by its visible label instead.
 *
 * @param {number|string} type ResolutionType enum value, or the label itself
 */
Cypress.Commands.add('selectResolutionType', (type) => {
  const label = RESOLUTION_TYPE_LABELS[type] || type
  cy.contains('[role="radiogroup"] [role="radio"]', label, { timeout: 10000 })
    .click({ force: true })
    .should('have.attr', 'aria-checked', 'true')
})

/**
 * Visit the wager surface.
 *
 * Spec 073 moved wager creation off `/fairwins` (which still exists and renders HomeScreen) to
 * Finance > Transfer > Wagers. Every quick-action card — Friends Decide, Oracle Settles, Make an
 * Offer, My Wagers — is rendered by Dashboard, and Dashboard is mounted ONLY by PayTransferPanel
 * under `?view=wagers`. Specs that kept visiting /fairwins were asking a page that had stopped
 * hosting those controls to produce them.
 */
Cypress.Commands.add('visitWagers', () => {
  cy.visit(WAGERS_PATH)
  cy.get('body', { timeout: 10000 }).should('be.visible')
})

/**
 * Navigate to the FairWins dashboard and verify it loaded.
 */
Cypress.Commands.add('navigateToDashboard', () => {
  cy.visit('/fairwins')
  cy.get('body', { timeout: 10000 }).should('be.visible')
})

/**
 * Navigate to a path and verify the URL matches.
 */
Cypress.Commands.add('navigateAndVerify', (path, urlPattern) => {
  cy.visit(path)
  cy.url().should('match', urlPattern || new RegExp(path))
})

/**
 * Open the wager creation modal for a specific type.
 * Group wagers are no longer supported — the v2 contract is 1v1 only. The
 * 1v1 flow is split into participant-resolved ("Friends Decide") and
 * oracle-resolved ("Oracle Settles") cards.
 * @param {'oneVsOne'|'oracle'|'offer'} type
 */
Cypress.Commands.add('openCreateWagerModal', (type = 'oneVsOne') => {
  const buttonMap = {
    oneVsOne: /friends decide|1v1|create wager/i,
    oracle: /oracle settles/i,
    offer: /make an offer/i,
  }

  const pattern = buttonMap[type] || buttonMap.oneVsOne
  cy.contains('button, [role="button"]', pattern, { timeout: 10000 })
    .should('be.visible')
    .click({ force: true })

  cy.get('[role="dialog"], .modal', { timeout: 5000 }).should('be.visible')
})

/**
 * Fill the wager creation form with the given configuration.
 */
/*
 * Lead with the ids FriendMarketsModal actually renders (#fm-description, #fm-opponent,
 * #fm-stake), the way cy.attemptCreateWager already does.
 *
 * The `[data-testid="wager-*"]` selectors these led with have never existed in the app, and for
 * DESCRIPTION every fallback missed too: the field is an `<input type="text">`, so
 * `textarea[name="description"]` and the bare `textarea` matched nothing and five CRE tests
 * failed on it. Opponent and stake only worked by falling through to their THIRD alternative,
 * which is why the same defect stayed invisible in those two.
 */
Cypress.Commands.add('fillWagerForm', (config = {}) => {
  if (config.opponent) {
    cy.get('#fm-opponent, [role="dialog"] input[placeholder*="0x"]')
      .first()
      .clear()
      .type(config.opponent)
  }

  if (config.description) {
    cy.get('#fm-description, [role="dialog"] input[type="text"]')
      .first()
      .clear()
      .type(config.description)
  }

  /*
   * `!= null` rather than a truthiness check: `stake: 0` is FALSY, so the old guard silently
   * skipped the keypad and left the field on WAGER_DEFAULTS.STAKE_AMOUNT ('10'). CRE-21, the test
   * named "zero stake shows validation error", therefore submitted a stake of ten and had never
   * once entered a zero. The keypad itself handles '0' correctly. (#1019)
   */
  if (config.stake != null) {
    cy.enterAmountViaKeypad('fm-stake', config.stake)
  }
})

/**
 * Enter an amount into an AmountKeypad.
 *
 * The stake field is NOT a text input — `AmountKeypad` renders `role="group"` with one button
 * per digit and no `<input>` anywhere, so `.type()` could never drive it and every selector that
 * assumed one (`#fm-stake`, `input[type="number"]`) matched nothing. The `id` passed to the
 * component is a BASE id: it renders `#<base>-hero` for the display and `#<base>-key-<digit>`,
 * `-key-decimal`, `-key-back` for the pad.
 *
 * @param {string} baseId  the id given to AmountKeypad, e.g. 'fm-stake'
 * @param {string|number} amount  digits and at most one '.'
 */
Cypress.Commands.add('enterAmountViaKeypad', (baseId, amount) => {
  const text = String(amount)
  // Unambiguous form of `\d*\.?\d*` — the original let a digit match on either side of the
  // optional dot, which is the polynomial-backtracking shape CodeQL flags (js/polynomial-redos).
  // Same accepted language: digits, at most one '.', either side optionally empty.
  if (!/^\d*(?:\.\d*)?$/.test(text)) {
    throw new Error(`enterAmountViaKeypad: "${text}" is not a plain decimal amount`)
  }

  cy.get(`#${baseId}-hero`, { timeout: 10000 }).should('exist')

  // Clear whatever is there. The pad has no "clear", only backspace, and the display is capped
  // well under 20 digits — pressing back past empty is a no-op, so this is safe to over-press.
  cy.get(`#${baseId}-key-back`).then(($back) => {
    for (let i = 0; i < 20; i += 1) cy.wrap($back).click({ force: true })
  })

  for (const ch of text) {
    const keyId = ch === '.' ? `${baseId}-key-decimal` : `${baseId}-key-${ch}`
    cy.get(`#${keyId}`).click({ force: true })
  }

  /*
   * WAIT FOR THE COMMAND'S OWN EFFECT TO LAND.
   *
   * Each key click dispatches a React state update; clicking submit immediately after the last one
   * can submit while formData.stakeAmount is still stale, which fails validation with "Valid stake
   * amount is required" and never reaches the success screen. The hero (`#<base>-hero`) is the
   * rendered value, so asserting it is a deterministic settle rather than a sleep.
   *
   * This is what an instrumented diagnostic was accidentally supplying: it read #fm-stake-hero
   * before submitting, and that read — not the extra time — was doing the work.
   */
  cy.get(`#${baseId}-hero`, { timeout: 10000 })
    .invoke('text')
    .should((shown) => {
      const digits = shown.replace(/[^0-9.]/g, '')
      const want = text === '' ? '0' : text
      expect(digits, `keypad ${baseId} should show ${want}`).to.contain(want)
    })
})

/**
 * Open My Wagers modal and navigate to the specified tab.
 * @param {'participating'|'created'|'history'} tab
 */
Cypress.Commands.add('openMyWagers', (tab = 'participating') => {
  cy.contains('button, [role="button"]', /my wagers/i, { timeout: 10000 })
    .should('be.visible')
    .click({ force: true })

  cy.get('[role="dialog"], .modal', { timeout: 5000 }).should('be.visible')

  if (tab !== 'participating') {
    cy.contains('button, [role="tab"]', new RegExp(tab, 'i'))
      .click({ force: true })
  }
})

/**
 * Yield the My Wagers list panel only after the wager fetch has actually finished (#1250).
 *
 * `cy.get('.mm-panel')` waits for the PANEL, not its CONTENT: MyMarketsModal clears its own
 * `loading` flag in the same tick it empties `markets`, while the rows come from
 * `useFriendMarkets()` — a chain scan the modal neither waits on nor renders a pending state
 * for. The panel therefore appears at once saying "No Active Positions" and fills in seconds
 * later, so a `$panel.find(...)` snapshot taken in between reads nothing and both limbs of a
 * conditional no-op. The empty state is NOT terminal, so waiting for "a row OR the empty
 * state" would settle instantly and prove nothing.
 *
 * The one completion edge the app exposes is FriendMarketsContext writing its result —
 * including an empty one — to `friendMarkets:<chainId>` in localStorage. That is an edge and
 * not a coincidence because the key is absent when the wait starts: the money-path specs
 * `cy.clearLocalStorage()` in `beforeEach`, and `cy.switchAccount()` drops the key as it
 * changes account (the cache is per CHAIN and would otherwise carry the previous account's
 * list). Callers settle BEFORE the read that decides anything, never inside a chosen branch.
 *
 * PREFER NOT SNAPSHOTTING AT ALL: where the spec has just arranged the thing it acts on,
 * assert the control retryably — cy.get(PANEL).find(CONTROL, { timeout }).should(...) — so an
 * absent precondition fails there, saying which one. This command is for genuine probes.
 */
const WAGER_PANEL_SELECTOR = '.mm-panel, [role="tabpanel"]'

Cypress.Commands.add('settledWagerPanel', () => {
  cy.get(WAGER_PANEL_SELECTOR, { timeout: 10000 }).should('exist')

  // The key is written verbatim in both this command and `switchAccount`, which clears it,
  // so the two halves of the wait can be read — and guarded — without chasing a constant.
  cy.window({ log: false })
    .its('localStorage', { timeout: 30000 })
    .should((storage) => {
      const done = Object.keys(storage).some(
        (k) => k === 'friendMarkets' || k.startsWith('friendMarkets:'),
      )
      expect(done, 'wager fetch completed (friendMarkets cache written)').to.be.true
    })

  return cy.get(WAGER_PANEL_SELECTOR, { timeout: 10000 })
})

/**
 * Wait for the TransactionProgress component to complete.
 */
Cypress.Commands.add('waitForTx', () => {
  cy.get('[data-testid="tx-progress"], .transaction-progress', { timeout: 30000 })
    .should('exist')

  cy.contains(/complete|confirmed|success/i, { timeout: 30000 })
    .should('be.visible')
})

/**
 * Assert a toast notification appeared with the given type and message pattern.
 * @param {'success'|'error'|'info'|'warning'} type
 * @param {string|RegExp} message
 */
Cypress.Commands.add('assertToast', (type, message) => {
  const toastSelector = `[role="alert"], .toast, .notification, [class*="toast"]`

  cy.get(toastSelector, { timeout: 10000 })
    .should('be.visible')
    .and('contain.text', message instanceof RegExp ? undefined : message)

  if (message instanceof RegExp) {
    cy.get(toastSelector).invoke('text').should('match', message)
  }
})

/*
 * BROWSER-CLOCK SHIM STATE.
 *
 * The offset lives at MODULE level, not on the window: `cy.visit`/`cy.reload` build a new window
 * and every shim installed on the old one goes with it. MEM-06 advanced 29 days into a 30-day
 * membership, reloaded, and then looked for the Extend control — which only renders while the
 * membership is expiring. After the reload the clock had snapped back and the membership looked
 * fresh, so the button correctly was not there. The test was right about the product and wrong
 * about its own harness.
 *
 * A cumulative offset rather than a frozen clock, so intervals keep firing and the UI re-renders
 * on its own — cy.clock() would stop them.
 */
let __cyTimeOffsetMs = 0

function installTimeShim(win) {
  if (!win.__cyTimeShim) {
    const RealDate = win.Date
    const realNow = RealDate.now.bind(RealDate)

    function ShiftedDate(...args) {
      if (args.length === 0) return new RealDate(realNow() + win.__cyTimeOffsetMs)
      return new RealDate(...args)
    }
    ShiftedDate.prototype = RealDate.prototype
    ShiftedDate.now = () => realNow() + win.__cyTimeOffsetMs
    ShiftedDate.parse = RealDate.parse
    ShiftedDate.UTC = RealDate.UTC
    win.Date = ShiftedDate
    win.__cyTimeShim = true
  }
  win.__cyTimeOffsetMs = __cyTimeOffsetMs
}

/*
 * Re-install on every navigation, so a shifted clock survives cy.visit and cy.reload. Registered
 * once at module load via Cypress.on (not cy.on, which binds to the running test). Skipped while
 * the offset is zero so specs that never move the clock keep the real Date untouched.
 */
Cypress.on('window:before:load', (win) => {
  if (__cyTimeOffsetMs !== 0) installTimeShim(win)
})

/**
 * Advance Hardhat node time by the specified seconds.
 * Only works when connected to a real Hardhat node.
 */
Cypress.Commands.add('advanceTime', (seconds) => {
  const rpcUrl = Cypress.env('RPC_URL') || 'http://localhost:8545'

  // 1. The CHAIN clock — what the contracts see.
  cy.request({
    method: 'POST',
    url: rpcUrl,
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'evm_increaseTime',
      params: [seconds]
    }
  })

  cy.request({
    method: 'POST',
    url: rpcUrl,
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'evm_mine',
      params: []
    }
  })

  /*
   * 2. The BROWSER clock — what the UI sees.
   *
   * evm_increaseTime moves the chain only. Every expiry decision in the app is browser-time
   * (`computedStatus` flips to EXPIRED on `Date.now() > acceptDeadline`, and the countdown tiles
   * tick off the same source), so a spec that advanced the chain past a deadline and then asserted
   * the UI said "Expired" was waiting on a clock nothing had moved. That is why the deadline tests
   * could not pass.
   *
   * Shift Date by the same offset inside the app realm. A cumulative offset rather than a frozen
   * clock, so intervals keep firing and the UI re-renders on its own — cy.clock() would stop them.
   */
  __cyTimeOffsetMs += seconds * 1000
  cy.window().then((win) => {
    installTimeShim(win)
  })
})

/**
 * Make the BROWSER clock agree with the CHAIN clock.
 *
 * The app decides every expiry in browser time (`computedStatus`, the countdown tiles, the
 * deadlines the create form computes) while the registry enforces in chain time. Whenever the
 * two disagree the UI and the contract are answering about different `now`s, and a test about a
 * deadline stops meaning anything: spec 07 scored 10/14 alone and 6/14 in the suite purely
 * because earlier specs had moved the chain ~60 days ahead of real time. Its screenshot showed a
 * row reading "Pending Acceptance · 11h 59m remaining" for an offer whose accept window had
 * closed on chain two months earlier.
 *
 * Call after anything that moves the chain independently of the browser — notably an
 * evm_revert, which rewinds chain time under a page that never noticed.
 */
Cypress.Commands.add('syncBrowserClockToChain', () => {
  cy.task('chainNow').then(({ nowMs }) => {
    __cyTimeOffsetMs = nowMs - Date.now()
    cy.window({ log: false }).then((win) => {
      installTimeShim(win)
    })
  })
})

/*
 * `cy.checkA11y` was REMOVED by spec 094 and replaced by `cy.a11yScan` (support/a11y.js), which
 * runs the real axe ruleset.
 *
 * The old command hand-checked image alts and button names, and guarded both loops with
 * `if ($els.length > 0)` — so on a surface with no visible images and no visible buttons it passed
 * having checked nothing. That is anti-pattern 7 wearing a different hat, in the one command whose
 * job was to catch problems. Leaving it beside the new scan would leave a weaker way to do the
 * same thing, which is how a suite ends up with both.
 */

// ***********************************************
// Precondition helpers (chain 1337 setup) — see
// specs/001-cypress-e2e-flows/contracts/test-helpers.md.
// These send admin transactions to the local Hardhat node via the `chainTx`
// task (cypress.config.js) to arrange on-chain state the UI can't set, or that
// is faster to set directly. Account #0 holds all admin roles locally.
// ***********************************************

/** Pause / unpause the WagerRegistry (Guardian = #0). Idempotent. */
Cypress.Commands.add('setProtocolPaused', (paused) => {
  return cy.task('chainTx', { action: paused ? 'pause' : 'unpause' }).then((r) => {
    expect(r.ok, 'setProtocolPaused tx ok').to.be.true
    return r
  })
})

/** Freeze / unfreeze an account (Moderator = #0). */
Cypress.Commands.add('setAccountFrozen', (address, frozen) => {
  return cy.task('chainTx', {
    action: frozen ? 'freeze' : 'unfreeze',
    args: { address },
  }).then((r) => {
    expect(r.ok, 'setAccountFrozen tx ok').to.be.true
    return r
  })
})

/** Grant a WAGER_PARTICIPANT membership (ROLE_MANAGER = #0). */
Cypress.Commands.add('grantMembershipFor', (address, { tier = 1, durationDays = 30 } = {}) => {
  return cy.task('chainTx', {
    action: 'grantMembership',
    args: { address, tier, durationDays },
  }).then((r) => {
    expect(r.ok, 'grantMembershipFor tx ok').to.be.true
    return r
  })
})

/** Resolve a MockPolymarketCTF condition. payouts: [1,0]=YES, [0,1]=NO, [1,1]=tie. */
Cypress.Commands.add('resolveMockCondition', (conditionId, payouts) => {
  return cy.task('chainTx', {
    action: 'resolveCondition',
    args: { conditionId, payouts },
  }).then((r) => {
    expect(r.ok, 'resolveMockCondition tx ok').to.be.true
    return r
  })
})

/** Latest wager id (nextWagerId - 1) for status/winner assertions. */
Cypress.Commands.add('lastWagerId', () => {
  return cy.task('lastWagerId')
})

/**
 * Restore global state a spec may have changed so the shared node is clean for
 * later specs. Call in afterEach. Unpauses the protocol and unfreezes the given
 * accounts (defaults to all five test accounts).
 */
Cypress.Commands.add('restoreGlobalState', (accounts = TEST_ACCOUNTS) => {
  cy.task('chainTx', { action: 'unpause' })
  accounts.forEach((address) => cy.task('chainTx', { action: 'unfreeze', args: { address } }))
})

/** Read KeyRegistry: has this account registered an encryption key? */
Cypress.Commands.add('hasRegisteredKey', (address) => {
  return cy.task('chainTx', { action: 'hasKey', args: { address } }).then((r) => r.registered)
})

/**
 * Ensure the given test accounts have an encryption key registered on the local KeyRegistry.
 *
 * THIS IS A PRECONDITION FOR CREATING ANY WAGER. Encryption is mandatory — the opt-out checkbox
 * was removed sprints ago — and FriendMarketsModal refuses to create a wager whose opponent has
 * no key: "Your opponent has not registered their encryption key yet." A fresh local chain has no
 * keys, so every full-tier create silently stalled on that notice with ZERO validation errors and
 * an enabled submit button, which is why it looked like a click problem rather than a fixture gap.
 *
 * Idempotent: checks KeyRegistry first and only drives the UI for accounts that need it. Keys are
 * derived from the mock's deterministic per-account signature, so they stay stable across specs.
 *
 * @param {number[]} indexes indices into TEST_ACCOUNTS
 */
/**
 * Give the test accounts enough membership headroom to create wagers.
 *
 * seed-local grants tier 1 (Bronze), whose `monthlyMarketCreation` cap is small. The full tier
 * shares ONE long-lived local chain across specs, so those creations accumulate: after roughly
 * five wagers the cap is spent and every later create is refused by MembershipManager — silently,
 * from the spec's point of view, because the UI simply never reaches the success screen.
 *
 * That is a fixture problem, not a product one, and it presents exactly like a broken selector:
 * a whole spec "cannot create wagers" while the one before it could.
 *
 * @param {number[]} indexes indices into TEST_ACCOUNTS
 * @param {number} tier membership tier (4 = highest headroom)
 */
Cypress.Commands.add('ensureWagerCapacity', (indexes = [0, 1], tier = 4) => {
  indexes.forEach((i) => {
    const address = TEST_ACCOUNTS[i]
    if (!address) throw new Error(`ensureWagerCapacity: invalid index ${i}`)
    cy.grantMembershipFor(address, { tier, durationDays: 365 })
  })
})

Cypress.Commands.add('ensureEncryptionKeys', (indexes = [0, 1]) => {
  const needed = []

  cy.wrap(indexes, { log: false }).each((i) => {
    const address = TEST_ACCOUNTS[i]
    if (!address) throw new Error(`ensureEncryptionKeys: invalid index ${i}`)
    return cy.task('chainTx', { action: 'hasKey', args: { address } }).then((r) => {
      if (!(r && r.registered)) needed.push(address)
    })
  })

  // Long timeout: the callback drives connect + register + an on-chain poll per account, and
  // `.then()` otherwise inherits the 10s default and aborts mid-registration.
  cy.wrap(null, { log: false }).then({ timeout: 240000 }, () => {
    if (!needed.length) return

    /*
     * Mock ONCE, then switch with __cySetAccount for the rest.
     *
     * Calling cy.mockWeb3Provider() per account would register a fresh `window:before:load`
     * handler each time — handlers accumulate, the last one wins, and it carries its own
     * `authorized` flag. That is exactly the defect that made cy.switchAccount report a stale
     * account against a disconnected provider; there is no reason to reintroduce it here.
     */
    cy.mockWeb3Provider({ account: needed[0] })
    cy.visit('/wallet?tab=security')
    cy.get('body', { timeout: 10000 }).should('be.visible')
    /*
     * cy.connectWallet() rather than a hand-rolled open+select: it already opens ConnectModal,
     * CHOOSES a connector, and waits for .wallet-account-button. Duplicating that here is how the
     * two drifted — this copy opened the dialog by class while connectWallet finds the button by
     * text, and it broke on the fresh-chain path where registration actually has to happen.
     */
    cy.connectWallet()

    needed.forEach((address, pos) => {
      if (pos > 0) {
        cy.window({ log: false }).then((win) => win.ethereum.__cySetAccount(address))
        cy.assertActiveAccount(address)
      }
      cy.registerEncryptionKeyViaUI(address)
    })
  })
})

/**
 * Register the connected account's encryption key via the WalletPage Security tab.
 * Idempotent — if already registered, it just confirms. Polls KeyRegistry until
 * the key is on-chain. The connected account must already be connected (the mock
 * provides per-account signatures so the registered key is account-specific).
 */
Cypress.Commands.add('registerEncryptionKeyViaUI', (address) => {
  /*
   * Deep-link by TAB ID, not by clicking a button labelled "Security". Spec 062 renamed that
   * section to "Recovery" while deliberately keeping the tab id `security` (and a `backup` alias),
   * so `cy.contains('button', /security/i)` has matched nothing since that rename. The id is the
   * stable contract; the label is not.
   */
  cy.visit('/wallet?tab=security')
  cy.get('body', { timeout: 10000 }).should('be.visible')
  /*
   * OPEN THE ACCORDION FIRST. The button lives inside
   * `<AccordionSection id="encryption-key" title="Encryption key">` (WalletPage.jsx), which renders
   * COLLAPSED, so the button exists in the DOM but is not visible and a bare .click() fails
   * ("covered by another element", then "expected to be visible"). Same trap as f855b30f.
   *
   * Deliberately NOT {force: true}: forcing would also sail past a button that is genuinely
   * unreachable, and this repo has already been bitten by force hiding a real defect.
   */
  cy.get('#encryption-key-header', { timeout: 10000 }).then(($h) => {
    if ($h.attr('aria-expanded') !== 'true') cy.wrap($h).click()
  })

  cy.get('body', { timeout: 10000 }).then(($b) => {
    if (/register encryption key/i.test($b.text())) {
      cy.contains('button', /register encryption key/i)
        .scrollIntoView()
        .should('be.visible')
        .click()
    }
  })
  const poll = (n) => cy.task('chainTx', { action: 'hasKey', args: { address } }).then((r) => {
    if (r.registered) return cy.wrap(true)
    if (n <= 0) throw new Error(`encryption key not registered for ${address}`)
    cy.wait(1000)
    return poll(n - 1)
  })
  return poll(30)
})

/** Mint a large stake-token balance to an account (so create/accept never reverts). */
Cypress.Commands.add('fundAccount', (address) => {
  return cy.task('chainTx', { action: 'fund', args: { address } }).then((r) => {
    expect(r.ok, 'fundAccount tx ok').to.be.true
    return r
  })
})

/** Connect the mocked wallet as `account` and reach the app. */
Cypress.Commands.add('connectAs', (account) => {
  cy.mockWeb3Provider({ account })
  cy.visit('/fairwins')
  cy.get('body', { timeout: 10000 }).should('be.visible')
  cy.get('.wallet-connect-button, button[aria-label="Connect Wallet"]', { timeout: 10000 }).click()
  /*
   * `.connector-option` survives ONLY in WalletButton.css — the JSX was renamed to
   * `.connect-modal__option` and the stylesheet was never cleaned up, so this selector
   * has matched nothing since the rename. Route through the one helper that knows the
   * real class instead of keeping a second, drifting copy of it.
   */
  cy.selectInjectedConnector()
  cy.get('.wallet-account-button, button[aria-label="Wallet Account"]', { timeout: 10000 }).should('be.visible')
})

/**
 * Open the create modal, fill it, and submit — WITHOUT asserting success. Use for
 * "blocked" cases (paused / frozen / expired membership) where the create should NOT
 * produce a wager; assert lastWagerId is unchanged after. Requires `interceptIpfs()`:
 * encryption is mandatory, so the metadata upload happens before the contract call
 * even on a create that is meant to be refused.
 */
Cypress.Commands.add('attemptCreateWager', (cfg = {}) => {
  const o = { description: 'E2E automated wager flow', opponent: TEST_ACCOUNTS[1], stake: 2, ...cfg }
  cy.openCreateWagerModal('oneVsOne')
  cy.get('#fm-description, [role="dialog"] input[type="text"]').first().clear().type(o.description)
  cy.get('#fm-opponent, [role="dialog"] input[placeholder*="0x"]').first().clear().type(o.opponent)
  cy.wait(300)
  cy.enterAmountViaKeypad('fm-stake', o.stake)
  // No encryption toggle to clear — encryption is mandatory and FriendMarketsModal renders
  // no `.fm-encryption-toggle`, so this cy.get failed the command rather than skipping the
  // step. The two-space copy of this block escaped the first sweep, which matched only the
  // four-space one inside createWagerViaUI.
  cy.get('[role="dialog"], .modal').find('button').filter(':contains("Create")').click({ force: true })
})

/** Poll lastWagerId until it reaches `target` (default ~40s). Yields the id. */
Cypress.Commands.add('waitForWagerId', (target, tries = 40) => {
  const check = (remaining) => cy.task('lastWagerId').then((id) => {
    if (id >= target) return cy.wrap(id)
    if (remaining <= 0) throw new Error(`wager ${target} not created (last=${id})`)
    cy.wait(1000)
    return check(remaining - 1)
  })
  return check(tries)
})

/**
 * Create a 1v1 wager through the real UI as the connected account, and confirm
 * it landed on-chain (polls the wager count — robust to success-copy wording).
 * The creator must already be funded + approved + a member (e.g. via the same
 * fund/approve/grant the spec does for createAndAcceptWager). "Private Wager" is
 * turned off so the create flow doesn't block on an IPFS upload (no IPFS in tests).
 */
Cypress.Commands.add('createWagerViaUI', (cfg = {}) => {
  // description must be >= 10 chars (form validation)
  const o = { description: 'E2E automated wager flow', opponent: TEST_ACCOUNTS[1], stake: 2, resolutionType: 0, ...cfg }
  cy.lastWagerId().then((before) => {
    cy.openCreateWagerModal('oneVsOne')
    cy.get('#fm-description, [role="dialog"] input[type="text"]').first().clear().type(o.description)
    cy.get('#fm-opponent, [role="dialog"] input[placeholder*="0x"]').first().clear().type(o.opponent)
    cy.wait(300)
    cy.enterAmountViaKeypad('fm-stake', o.stake)
    if (o.resolutionType !== undefined) {
      /*
       * Resolution type is a radio tab strip, not a <select>: FriendMarketsModal renders
       * no `#fm-resolution-type` and no `.fm-select`, so the old lookup failed the command
       * outright (PAU-02 died here). cy.selectResolutionType clicks the pill by its visible
       * label, which is what the passing CRE specs already use.
       */
      cy.selectResolutionType(String(o.resolutionType))
    }
    /*
     * The end date is NOT a form input. Spec 038 replaced `#fm-end-date` with the
     * DeadlineTimeline: the editable ENDS tile opens SetTimeModal (`.stm-input`, confirm
     * "Set"). `cy.get('#fm-end-date')` does not degrade to a no-op — it FAILS the command,
     * which is why this whole spec died in its before-all hook and skipped five tests.
     * Same flow CRE-09 uses; 5 days, formatted LOCAL (toISOString is UTC and can land on
     * the wrong day near midnight), inside the modal's 1h..21d bounds.
     */
    const end = new Date(Date.now() + 5 * 24 * 3600 * 1000)
    const p2 = (n) => String(n).padStart(2, '0')
    const dtl = `${end.getFullYear()}-${p2(end.getMonth() + 1)}-${p2(end.getDate())}T${p2(end.getHours())}:${p2(end.getMinutes())}`
    cy.get('.fm-stat-tiles', { timeout: 10000 }).contains('button', /ends/i).click()
    cy.get('.stm-input', { timeout: 10000 }).clear().type(dtl)
    cy.get('.stm-dialog').contains('button', /^set$/i).click()
    /*
     * No encryption toggle to clear: encryption is MANDATORY on the create path, so
     * FriendMarketsModal renders no `.fm-encryption-toggle` and this cy.get failed the
     * command rather than skipping. Callers that need a public wager cannot get one here;
     * callers that need a private one should use createPrivateWagerViaUI, which asserts the
     * `encrypted:ipfs` metadata reference. Either way `interceptIpfs()` must be active.
     */
    cy.get('[role="dialog"], .modal').find('button').filter(':contains("Create")').click({ force: true })
    cy.waitForWagerId(before + 1)
  })
})

/**
 * Drive the acceptance modal: through the decrypt gate if there is one, then Accept Offer and
 * the confirmation. Leaves the modal open so callers can assert on the result.
 *
 * WAIT FOR THE MODAL TO DECIDE before branching. `$m.find('button:contains("Decrypt")')` inside
 * .then() reads the DOM once, and the modal renders before it knows whether the wager is private
 * — so the check ran too early, found no gate, skipped it, and then "Accept Offer" was never
 * found because it sits BEHIND that gate. The screenshot showed the Decrypt button plainly on
 * screen. Waiting for one of the modal's terminal states first is what makes the branch honest.
 *
 * Also scopes every lookup to the dialog: unscoped, /accept/i matches Dashboard's Scan QR card
 * ("Accept a wager from a friend") sitting behind the overlay, which is visible and un-clickable.
 */
Cypress.Commands.add('acceptOfferInModal', () => {
  cy.get('.ma-modal', { timeout: 10000 }).should('be.visible')
  // One of: the decrypt gate, the decrypted terms, or a decrypt failure.
  cy.get('.ma-modal')
    .find('.ma-decrypt-prompt, .ma-description, .ma-decrypt-error', { timeout: 20000 })
    .should('exist')

  cy.get('.ma-modal').then(($m) => {
    if ($m.find('.ma-decrypt-prompt button').length === 0) return
    cy.get('.ma-modal').contains('button', /decrypt/i).click({ force: true })
    // Re-query: decrypting re-renders the modal, so $m's nodes are detached by the time it lands.
    cy.get('.ma-modal')
      .find('.ma-description, .ma-decrypt-error', { timeout: 20000 })
      .should('exist')
      .then(($r) => {
        if ($r.hasClass('ma-decrypt-error')) {
          throw new Error(`decrypt failed: ${$r.text().trim()}`)
        }
      })
  })

  cy.get('.ma-modal').contains('button', /accept offer/i, { timeout: 10000 }).click()
  cy.contains('.ma-modal, [role="dialog"]', /confirm offer acceptance/i).within(() => {
    cy.contains('button', /i understand|confirm|accept/i)
      .scrollIntoView()
      .should('be.visible')
      .click()
  })
})

/**
 * Resolve a wager through the My Wagers sub-modal.
 *
 * THE FLOW HAS THREE STEPS, not two: pick an outcome, "Continue" to a confirmation step, then
 * "Confirm Resolution" — the only button wired to handleSubmit. Both specs clicked once and
 * stopped at the confirmation screen, so no transaction was ever sent and the wager sat at
 * Active while the test waited for Resolved. The old text assertion hid that by accepting the
 * word "resolve" from a modal that was merely offering to.
 *
 * Outcomes are labelled by PARTY — "Creator wins — <name>", "Opponent wins — <name>", "Draw —
 * both parties refunded" — never Pass/Fail, so callers pass a pattern.
 *
 * @param {RegExp} outcomePattern which outcome to select
 */
Cypress.Commands.add('resolveWagerInModal', (outcomePattern = /creator wins/i) => {
  cy.get('.mm-sub-modal, .mm-sub-modal-backdrop', { timeout: 15000 }).should('exist')
  cy.get('.mm-sub-modal').contains(outcomePattern).click()
  cy.get('.mm-sub-modal').contains('button', /^continue$/i).should('not.be.disabled').click()
  cy.get('.mm-sub-modal').contains('button', /confirm resolution/i, { timeout: 10000 }).click()
})

/**
 * Poll the registry until `wagerId` is Resolved (status 3).
 */
Cypress.Commands.add('waitForWagerResolved', (wagerId, tries = 45) => {
  const poll = (remaining) => cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
    if (i.status === 3) return undefined
    if (remaining <= 0) throw new Error(`wager ${wagerId} never reached Resolved (status=${i.status})`)
    cy.wait(1000)
    return poll(remaining - 1)
  })
  return poll(tries)
})

/**
 * Poll the registry until `wagerId` is marked paid — the fact a claim actually landed, not a word
 * in the detail panel (which can render "Claimed" optimistically before the transaction confirms,
 * or simply repeat text that was already on screen).
 */
Cypress.Commands.add('waitForWagerPaid', (wagerId, tries = 45) => {
  const poll = (remaining) => cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
    if (i.paid) return undefined
    if (remaining <= 0) throw new Error(`wager ${wagerId} was never marked paid`)
    cy.wait(1000)
    return poll(remaining - 1)
  })
  return poll(tries)
})

/**
 * Dismiss the acceptance modal if it is still open.
 *
 * It CLOSES ITSELF once the acceptance lands, so an unconditional close failed with "expected
 * to find .ma-close-btn" on every test whose acceptance had just succeeded — the harness
 * complaining that it could not tidy up something that had already tidied itself.
 *
 * The `should` settles first — either the modal is gone or its close control has rendered — so
 * the branch below is reading a decided state rather than racing one.
 */
Cypress.Commands.add('dismissAcceptanceModal', () => {
  cy.get('body', { timeout: 15000 }).should(($b) => {
    const gone = $b.find('.ma-modal').length === 0
    const closable = $b.find('.ma-modal .ma-close-btn, .ma-modal button[aria-label="Close modal"]').length > 0
    expect(gone || closable, 'acceptance modal settled (closed itself, or offers a close control)').to.be.true
  })
  cy.get('body').then(($b) => {
    if ($b.find('.ma-modal').length === 0) return
    cy.get('.ma-modal .ma-close-btn, .ma-modal button[aria-label="Close modal"]')
      .first()
      .click({ force: true })
  })
})

/**
 * Poll the registry until `wagerId` is Active (status 2). Success is a fact about the chain, not
 * a word in a dialog — the acceptance modal sits on "Processing…" for as long as the tx takes,
 * and a public-subgraph 429 can stretch that well past any fixed wait.
 */
Cypress.Commands.add('waitForWagerActive', (wagerId, tries = 60) => {
  const poll = (remaining) => cy.task('chainTx', { action: 'wagerInfo', args: { wagerId } }).then((i) => {
    if (i.status === 2) return undefined
    if (remaining <= 0) {
      throw new Error(`wager ${wagerId} never became Active after acceptance (status=${i.status})`)
    }
    cy.wait(1000)
    return poll(remaining - 1)
  })
  return poll(tries)
})

/**
 * Refuse every JSON-RPC call the PAGE makes over HTTP, so the no-chain tier genuinely has no
 * chain. Call BEFORE `cy.visit`.
 *
 * The fast tier's premise is that no node is running, but nothing was enforcing it: the app's
 * read transports point at PUBLIC endpoints, and a CI runner has internet, so any chain the app
 * happened to read answered for real. That was harmless only while the wager list read exactly
 * one chain — the wallet's, which in this tier is 1337 at 127.0.0.1:8545 and refuses instantly.
 * Spec 110 made the list span the build's whole cohort, and a `dev:fast` build has no
 * VITE_NETWORK_ID, so the cohort is the five MAINNETS. Live Polygon then answered the seeded
 * test account authoritatively — "this address has no wagers" — and the estate read did the
 * correct thing with a correct answer: it replaced that chain's cache with the empty truth,
 * deleting the wagers the spec had just seeded.
 *
 * So this is not a workaround for the product. It removes a dependency the tier was never
 * supposed to have, and on which its result would otherwise turn: whether a public RPC host is
 * reachable from the runner at that moment.
 *
 * Matching is on the REQUEST BODY, not the URL: a JSON-RPC envelope is unmistakable and no
 * endpoint list has to be kept in step with `NETWORKS`. Everything else — IPFS, the gateway,
 * Vite's own asset requests — is left to `req.continue()` untouched. The injected wallet is
 * unaffected too: `cy.mockWeb3Provider` answers in-process on `window.ethereum` and never
 * issues an HTTP request for the interceptor to see.
 */
Cypress.Commands.add('refuseChainReads', () => {
  cy.intercept({ method: 'POST' }, (req) => {
    const body = req.body
    const envelope = Array.isArray(body) ? body[0] : body
    if (envelope && typeof envelope === 'object' && envelope.jsonrpc === '2.0') {
      req.destroy()
      return
    }
    req.continue()
  })
})

/**
 * Mock the IPFS (Pinata) boundary: store uploaded JSON in-memory and serve it back
 * on fetch, so the app's real encrypt → store → retrieve → decrypt round-trip runs
 * without a network. Call BEFORE cy.visit. `{ failFetch:true }` makes gateway reads
 * return 500 (to drive the graceful-error path). CIDs are valid CIDv0 strings.
 */
// Module-level IPFS store: persists across tests in a spec so a private wager can
// be created once (uploads stored here) and decrypted in a later test (fetched here).
const __ipfsStore = {}
let __ipfsCounter = 0
Cypress.Commands.add('interceptIpfs', (opts = {}) => {
  const mkCid = () => 'Qm' + String(1000 + __ipfsCounter++).split('').map((c) => 'abcdefghij'[+c]).join('') + 'a'.repeat(40)
  cy.intercept('POST', '**/pinJSONToIPFS', (req) => {
    const cid = mkCid()
    const content = (req.body && req.body.pinataContent) || req.body
    __ipfsStore[cid] = content
    req.reply({ statusCode: 200, body: { IpfsHash: cid, PinSize: 1, Timestamp: '2026-01-01T00:00:00Z' } })
  }).as('ipfsUpload')
  cy.intercept('GET', '**/ipfs/*', (req) => {
    if (opts.failFetch) { req.reply({ statusCode: 500, body: 'mock IPFS unreachable' }); return }
    const cid = req.url.split('/ipfs/')[1].split(/[?#/]/)[0]
    if (__ipfsStore[cid]) req.reply({ statusCode: 200, body: __ipfsStore[cid] })
    else req.reply({ statusCode: 404, body: 'not found' })
  }).as('ipfsFetch')
})

/**
 * Create a 1v1 PRIVATE (encrypted) wager through the UI — leaves the "Private
 * Wager" toggle ON. Requires `interceptIpfs()` active and BOTH parties to have a
 * registered encryption key (creator and `opponent`). Confirms the wager landed
 * and its metadataUri is an `encrypted:ipfs` reference. Yields the wagerId.
 */
Cypress.Commands.add('createPrivateWagerViaUI', (cfg = {}) => {
  const o = { description: 'E2E private encrypted wager', opponent: TEST_ACCOUNTS[1], stake: 2, ...cfg }
  cy.lastWagerId().then((before) => {
    cy.openCreateWagerModal('oneVsOne')
    cy.get('#fm-description, [role="dialog"] input[type="text"]').first().clear().type(o.description)
    cy.get('#fm-opponent, [role="dialog"] input[placeholder*="0x"]').first().clear().type(o.opponent)
    cy.wait(300)
    cy.enterAmountViaKeypad('fm-stake', o.stake)
    /*
     * The end date is NOT a form input. Spec 038 replaced `#fm-end-date` with the
     * DeadlineTimeline: the editable ENDS tile opens SetTimeModal (`.stm-input`, confirm
     * "Set"). `cy.get('#fm-end-date')` does not degrade to a no-op — it FAILS the command,
     * which is why this whole spec died in its before-all hook and skipped five tests.
     * Same flow CRE-09 uses; 5 days, formatted LOCAL (toISOString is UTC and can land on
     * the wrong day near midnight), inside the modal's 1h..21d bounds.
     */
    const end = new Date(Date.now() + 5 * 24 * 3600 * 1000)
    const p2 = (n) => String(n).padStart(2, '0')
    const dtl = `${end.getFullYear()}-${p2(end.getMonth() + 1)}-${p2(end.getDate())}T${p2(end.getHours())}:${p2(end.getMinutes())}`
    cy.get('.fm-stat-tiles', { timeout: 10000 }).contains('button', /ends/i).click()
    cy.get('.stm-input', { timeout: 10000 }).clear().type(dtl)
    cy.get('.stm-dialog').contains('button', /^set$/i).click()
    // Leave the encryption toggle ON (do NOT uncheck).
    cy.get('[role="dialog"], .modal').find('button').filter(':contains("Create")').click({ force: true })
    // The encrypted metadata is uploaded to (mocked) IPFS during create.
    cy.wait('@ipfsUpload', { timeout: 30000 }).its('response.statusCode').should('eq', 200)
    cy.waitForWagerId(before + 1).then((id) => {
      cy.task('chainTx', { action: 'wagerInfo', args: { wagerId: id } }).then((i) => {
        expect(i.metadataUri, 'encrypted metadata reference').to.match(/^encrypted:ipfs/)
      })
      return cy.wrap(id)
    })
  })
})

/**
 * Set up a wager directly on-chain (reliable) so specs can assert UI behavior on
 * it. Funds + approves + grants membership for both parties, then createWager and
 * (unless {accept:false}) acceptWager via the chainTx task. Yields the wagerId.
 *
 * cfg: { creatorIndex=0, opponentIndex=1, resolutionType=0, creatorIsYes,
 *        conditionId, acceptIn, resolveIn, stake, accept }
 */
Cypress.Commands.add('createAndAcceptWager', (cfg = {}) => {
  const creatorIndex = cfg.creatorIndex ?? 0
  const opponentIndex = cfg.opponentIndex ?? 1
  const creator = TEST_ACCOUNTS[creatorIndex]
  const opponent = TEST_ACCOUNTS[opponentIndex]
  cy.task('chainTx', { action: 'fund', args: { address: creator } })
  cy.task('chainTx', { action: 'fund', args: { address: opponent } })
  cy.task('chainTx', { action: 'approve', args: { index: creatorIndex } })
  cy.task('chainTx', { action: 'approve', args: { index: opponentIndex } })
  cy.task('chainTx', { action: 'grantMembership', args: { address: creator, tier: 4, durationDays: 365 } })
  cy.task('chainTx', { action: 'grantMembership', args: { address: opponent, tier: 4, durationDays: 365 } })
  return cy.task('chainTx', { action: 'createWager', args: { ...cfg, creatorIndex, opponent } }).then((r) => {
    expect(r.ok, 'createWager ok').to.be.true
    if (cfg.accept === false) return cy.wrap(r.wagerId)
    return cy.task('chainTx', { action: 'acceptWager', args: { opponentIndex, wagerId: r.wagerId } }).then((a) => {
      expect(a.ok, 'acceptWager ok').to.be.true
      return cy.wrap(r.wagerId)
    })
  })
})

/* ------------------------------------------------------------------------- *
 * Entry gate (spec 007 US4) — bypass by default (spec 075)
 * ------------------------------------------------------------------------- *
 *
 * EntryGate is a full-screen compliance overlay that blocks the app until a visitor affirms
 * eligibility. It renders on mount whenever localStorage has no acknowledgement, so it covers the
 * UI in a fresh browser — which is every Cypress run.
 *
 * That is why the E2E suite went red the moment the gate was repaired to be able to fail (spec 075
 * US2): `cy.click()` reported "covered by another element: <div class='entry-gate-overlay'>" on
 * essentially every UI test. Reproduced locally at 11/11 failures in one spec. The tests were not
 * wrong and the app was not broken — nothing had ever told Cypress how to get past the gate,
 * and the muted gate meant nobody saw it.
 *
 * The acknowledgement MUST be seeded before the page loads: EntryGate reads it during the first
 * render, so a post-visit localStorage write is too late. `cy.visit` is overwritten rather than
 * adding a beforeEach to 20+ spec files, so a new spec is covered automatically.
 *
 * A spec that is genuinely TESTING the gate opts out per visit:
 *     cy.visit('/fairwins', { acknowledgeEntryGate: false })
 */
const ENTRY_GATE_ACK_KEY = 'fairwins.entryGate.ack.v1'

/** Shape mirrors utils/entryGateAck.js#writeAck; the app only requires a non-null record. */
const entryGateAckRecord = () => ({
  terms: 'cypress-e2e',
  risk: 'cypress-e2e',
  at: new Date(0).toISOString(),
})

Cypress.Commands.overwrite('visit', (originalFn, url, options = {}) => {
  const { acknowledgeEntryGate = true, autoDismissConnectModal = true, onBeforeLoad, ...rest } = options
  return originalFn(url, {
    ...rest,
    onBeforeLoad(win) {
      /*
       * THREE states, not two.
       *
       *   true (default) — seed an acknowledgement, so the gate never covers the surface a spec
       *                    is actually about.
       *   false          — clear it, so the spec meets a browser that has never entered.
       *   'preserve'     — leave whatever is there alone.
       *
       * The third exists because the second made one thing untestable: whether entering ONCE is
       * enough. A spec that pressed Enter and then re-visited with `false` had its own
       * acknowledgement wiped on load, so the gate reappeared no matter what the app did — the
       * "returning visitor" assertion could not fail, and its mirror image ("declining still
       * asks next time") could not fail either. Both are the point of an entry gate.
       */
      if (acknowledgeEntryGate === 'preserve') {
        // deliberately neither seed nor clear
      } else if (acknowledgeEntryGate) {
        try {
          win.localStorage.setItem(ENTRY_GATE_ACK_KEY, JSON.stringify(entryGateAckRecord()))
        } catch {
          /* storage disabled in this browser context — the spec will see the gate, which is honest */
        }
      } else {
        try {
          win.localStorage.removeItem(ENTRY_GATE_ACK_KEY)
        } catch { /* nothing to clear */ }
      }
      if (onBeforeLoad) onBeforeLoad(win)
    },
  }).then((win) => {
    /*
     * ...and dismiss the auto-opened connect modal.
     *
     * Acknowledging the gate is exactly what triggers AutoConnectPrompt: for a RETURNING,
     * disconnected visitor the app helpfully opens the connect dialog for them
     * (AutoConnectPrompt.jsx — "if (!isConnectModalOpen) openConnectModal()"). Correct product
     * behaviour, and it replaced the entry gate as the thing covering every button: the failure
     * message just changed from `.entry-gate-overlay` to `.connect-modal__backdrop`.
     *
     * These specs predate both surfaces and drive the connect flow themselves, so the harness
     * closes the auto-opened dialog and leaves the app in the state the tests were written
     * against. A spec that WANTS the prompt opts out with `autoDismissConnectModal: false`.
     *
     * Escape is used rather than clicking the backdrop: the backdrop is the element under test in
     * some specs, and ConnectModal binds Escape to the same `close` handler.
     */
    if (autoDismissConnectModal) dismissAutoConnectPrompt()
    return win
  })
})

/*
 * Close the auto-opened connect dialog, if one appeared.
 *
 * Extracted from the `visit` override so it can be reached from a RELOAD too. `cy.reload()` is not
 * `cy.visit()` and never ran this, so a spec that reloaded into a disconnected state got the
 * prompt back with nothing to close it — and the backdrop then covered the very control the spec
 * was asserting on. That is how WAL-05 failed on the phone profile while passing on desktop.
 *
 * Exposed as `cy.dismissAutoConnectPrompt()` for those cases. The `visit` override's behaviour and
 * timing are unchanged: it calls exactly this, exactly where it used to.
 */
function dismissAutoConnectPrompt() {
      /*
       * The prompt opens ASYNCHRONOUSLY — AutoConnectPrompt waits for `connectionStatus` to settle,
       * and WalletContext waits for wallet detection before that. An immediate DOM check races it,
       * and even a short poll can finish BEFORE the dialog appears, which is exactly what happened
       * first time round: Escape fired at nothing and the modal opened a moment later.
       *
       * So: poll generously, dismiss, then confirm — and retry once, because "appeared, dismissed,
       * appeared again" is indistinguishable from "appeared late" without looking twice.
       * Tolerate it never appearing: a spec that is already connected never sees the prompt and
       * must not be delayed or failed by this.
       */
      const waitForBackdrop = (doc, ms) =>
        new Cypress.Promise((resolve) => {
          const deadline = Date.now() + ms
          const poll = () => {
            if (doc.querySelector('[data-testid="connect-modal-backdrop"]')) return resolve(true)
            if (Date.now() > deadline) return resolve(false)
            setTimeout(poll, 100)
          }
          poll()
        })

      /*
       * `timeout` is load-bearing: waitForBackdrop polls for up to 12s, but `.then()` inherits the
       * 10s default command timeout, so on any visit where the connect modal does NOT auto-open the
       * callback outlived its own timeout and failed with "returned a promise that never resolved".
       * That made every visit-without-a-modal fail — which is most of them once a spec is already
       * connected.
       */
      cy.document({ log: false }).then({ timeout: 30000 }, (doc) =>
        waitForBackdrop(doc, 12000).then((appeared) => {
          if (!appeared) return undefined
          // Escape rather than clicking the backdrop: the backdrop is the element under test in
          // some specs, and ConnectModal binds Escape on `document` to the same `close` handler
          // (verified: a single Escape takes the backdrop count 1 -> 0).
          cy.get('body', { log: false }).type('{esc}')
          return cy.document({ log: false }).then((d2) =>
            waitForBackdrop(d2, 1500).then((stillThere) => {
              // Best-effort second attempt, then give up: a shared helper must never be the thing
              // that fails a spec. If the dialog will not close, the spec should say so in its own
              // words.
              if (stillThere) cy.get('body', { log: false }).type('{esc}')
            }),
          )
        }),
      )
}

Cypress.Commands.add('dismissAutoConnectPrompt', dismissAutoConnectPrompt)


/**
 * Select the mocked INJECTED wallet in the connect dialog (issue #1016).
 *
 * Specs used to do `.connect-modal__option:not(.unavailable)').first().click()` with a comment
 * saying "the first available injected connector (MetaMask)". That stopped being true: the dialog
 * now lists Passkey first (marked Recommended), then WalletConnect, then the injected wallet. So
 * `.first()` clicked Passkey — which needs a real platform authenticator, silently never connects,
 * and every "after connection..." assertion then failed on a UI that had not connected.
 *
 * Selecting by NAME instead of by position means a future reordering of the dialog cannot quietly
 * change which wallet the suite tests.
 *
 * Note the dialog can legitimately list the injected wallet twice — once from the EIP-6963
 * announcement and once from wagmi's generic injected connector — so this takes the first match
 * rather than asserting there is exactly one.
 */
Cypress.Commands.add('selectInjectedConnector', () => {
  cy.contains('.connect-modal__option:not(.unavailable)', /metamask|browser wallet|injected/i, {
    timeout: 10000,
  })
    .first()
    .click()
})

// ---------------------------------------------------------------------------
// Legacy account recovery (spec 062 / 063) — shared drivers.
//
// Both tiers import a secret the same way, so the wizard lives here rather than
// twice in two specs. The assertions ABOUT the import (what is on disk, what is
// not) stay in the specs, because that is what each of them is testing.
// ---------------------------------------------------------------------------

/**
 * Open the Recovery tab with the legacy-recovery card already expanded.
 *
 * Uses the real deep link (`#legacy-recovery`, resolved by accordionSectionForHash) rather than
 * clicking the header: a collapsed AccordionSection is `inert`, so anything inside it is
 * unclickable, and landing open is the behaviour the nav search actually ships.
 *
 * Call cy.mockWeb3Provider(...) FIRST — the provider options are the spec's choice.
 *
 * @param {object} [visitOptions] forwarded to cy.visit (e.g. an onBeforeLoad recorder).
 */
Cypress.Commands.add('openLegacyRecovery', (visitOptions = {}) => {
  cy.visit('/wallet?tab=security#legacy-recovery', visitOptions)
  cy.get('[data-attention="legacy-recovery"]', { timeout: 20000 })
    .should('have.attr', 'data-open', 'true')
})

/**
 * Drive the import wizard from the Recovery card to the SAVED screen.
 *
 * Leaves the action sheet OPEN on SAVED, because that screen is where the optional follow-ups
 * (address book, move funds) live and a caller usually wants one of them.
 *
 * @param {{secret: string, passphrase?: string}} args
 */
Cypress.Commands.add('importLegacyKey', ({ secret, passphrase = 'correct-horse-battery' }) => {
  cy.get('.legacy-recovery__start').click()
  // Everything below is inside the sheet. Scoping is not cosmetic: an unscoped cy.contains in
  // this app finds the page behind the dialog, and that element is genuinely visible.
  cy.get('.action-sheet').within(() => {
    cy.contains('button', 'Get started').click()
    cy.get('textarea[aria-label="Private key or recovery word list"]').type(secret, {
      delay: 0,
      // The secret must not be echoed into the Cypress command log / screenshots either.
      log: false,
    })
    // The app recognised the secret and says which account it controls — that is the gate on
    // Continue, so asserting it here means a failure points at detection, not at a dead button.
    cy.get('[data-testid="lkr-detected"]').should('be.visible')
    cy.contains('button', 'Continue').click()

    // Injected (non-passkey) sessions get the passphrase form; biometrics need a real
    // authenticator, which these tiers do not have.
    cy.get('input[type="password"]').first().type(passphrase, { log: false })
    cy.get('input[type="password"]').eq(1).type(passphrase, { log: false })
    cy.contains('button', 'Encrypt & save').click()
    cy.get('[data-testid="lkr-saved"]', { timeout: 15000 }).should('be.visible')
  })
})

/** The on-disk vault map ({ [lowerAddress]: entry }) for a signed-in owner. */
Cypress.Commands.add('legacyVault', (owner) => {
  const key = `fw_user_${String(owner).toLowerCase()}_legacy_recovered_keys`
  return cy.window({ log: false }).then((win) => JSON.parse(win.localStorage.getItem(key) || '{}'))
})

/** The client activity-ledger records for an owner on a chain. */
Cypress.Commands.add('activityLedger', (owner, chainId) => {
  const key = `fw_user_${String(owner).toLowerCase()}_activity_ledger_v1_${chainId}`
  return cy
    .window({ log: false })
    .then((win) => JSON.parse(win.localStorage.getItem(key) || '{"records":[]}').records || [])
})

/**
 * Assert a secret appears NOWHERE observable: not in local/session storage, not in the DOM.
 *
 * Deliberately checks every storage entry rather than the one key we expect to be safe — the
 * invariant is "the clear secret is not persisted", and a copy parked under some other key
 * would satisfy a check that only looked at `legacy_recovered_keys`.
 *
 * Network traffic is covered separately by the spec, which intercepts before the import.
 */
Cypress.Commands.add('assertNoClearSecret', (secret) => {
  const needle = String(secret).toLowerCase()
  cy.window({ log: false }).then((win) => {
    const dump = (storage) =>
      Object.keys(storage).map((k) => `${k}=${storage.getItem(k) || ''}`).join('\n').toLowerCase()
    const local = dump(win.localStorage)
    const session = dump(win.sessionStorage)
    expect(local, 'clear secret in localStorage').to.not.include(needle)
    expect(session, 'clear secret in sessionStorage').to.not.include(needle)
    expect(
      win.document.documentElement.innerHTML.toLowerCase(),
      'clear secret in the DOM',
    ).to.not.include(needle)
  })
})
