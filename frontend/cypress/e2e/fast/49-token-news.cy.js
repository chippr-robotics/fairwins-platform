// =============================================================================
// 49-token-news.cy.js
// Fast-tier E2E for token news on the portfolio and trade surfaces (spec 109).
//
// News is a READ-ONLY advisory feed over the relay-gateway's Alphaday proxy, so
// every flow here is validatable without a chain — admission rule 1 puts all of
// it in the no-chain tier. The dev:fast build points VITE_RELAYER_URL at a dead
// port, so each test stubs the gateway's answers itself with cy.intercept; the
// asset→slug mapping (config/newsAssets.js) is real and client-side, which is
// exactly what TN-02 exercises: an unmapped asset never produces a request.
//
// The portfolio card needs a holding row to open the AssetDetailSheet, and the
// fast tier starts no chain — so every test stubs the read-provider JSON-RPC at
// every configured provider host, answering a single non-zero native balance on
// Ethereum Classic. Every other chain reads zero and contributes no row, which
// is per-chain isolation working, not a gap. See the stub below for why the one
// funded chain is ETC rather than Polygon.
// =============================================================================

const TEST_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const PORTFOLIO_URL = '/wallet?tab=account&view=portfolio'

// ---- gateway fixtures (FeedReading shapes per contracts/gateway-news-api.md) ----

const newsItem = (over = {}) => ({
  id: '409910',
  title: 'Network upgrade lands on schedule',
  url: 'https://news.example/upgrade-story',
  source: { name: 'Example Wire', slug: 'example_wire' },
  publishedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), // 3h ago
  sentiment: 0,
  ...over,
})

const readBody = (items) => ({
  state: 'read',
  fetchedAt: new Date().toISOString(),
  stale: false,
  items,
})

// ---- read-provider JSON-RPC stub ---------------------------------------------------------------
//
// EVERY shipped read provider is intercepted, not just the one this spec cares about, so the spec
// is hermetic: no assertion here depends on a real network answering. Intercepting only
// publicnode.com left the ETC/Mordor/Amoy reads reaching out. In CI that merely makes the spec
// slower and non-deterministic; in a sandbox whose egress proxy resets such connections it
// aborts the run outright (an untouched spec, 30-verify-message.cy.js, does the same there), so
// full coverage is also what makes this spec runnable and verifiable off CI. The host set and the
// hostname match are the ones 33-account-surfaces.cy.js already proved; the host->chain map is
// read off config/networks.js.
//
// Only Ethereum Classic answers a non-zero balance, so exactly one native ETC row exists to open.
// Contract reads answer a zero word, so ERC-20 rows hold nothing and stay out of the way.

const RPC_HOSTS = /publicnode\.com$|rivet\.link$|etccooperative\.org$|polygon\.technology$|etcdesktop\.com$/

/** Host fragment -> chain id, per the rpcUrl values in frontend/src/config/networks.js. */
const CHAIN_BY_RPC = [
  // Amoy before Polygon: both are publicnode `*-bor-rpc` hosts, and this list is first-match.
  ['polygon-amoy-bor-rpc', 80002],
  ['polygon-bor-rpc', 137],
  ['arbitrum-one-rpc', 42161],
  ['base-rpc', 8453],
  ['optimism-rpc', 10],
  ['ethereum-sepolia-rpc', 11155111],
  ['ethereum-rpc', 1],
  ['etcdesktop.com', 61], // ETC's rpcUrl; was rivet.link until that host stopped resolving
  ['mordor.etccooperative.org', 63],
]

const hex = (n) => `0x${Number(n).toString(16)}`
const ZERO_WORD = `0x${'0'.repeat(64)}`

function chainIdForRpcUrl(url) {
  for (const [fragment, chainId] of CHAIN_BY_RPC) if (url.includes(fragment)) return chainId
  return 137 // the wallet rail, which cy.mockWeb3Provider pins to Polygon
}

function rpcResult(url, { method } = {}) {
  const chainId = chainIdForRpcUrl(url)
  switch (method) {
    case 'eth_chainId':
      return hex(chainId)
    case 'net_version':
      return String(chainId)
    case 'eth_blockNumber':
      return hex(75000000)
    case 'eth_getBalance':
      /*
       * 2 ETC on Ethereum Classic; zero everywhere else, so exactly one native row exists.
       *
       * Deliberately NOT Polygon. Since issue #1459 the five Multicall3 chains
       * (1/10/137/8453/42161) batch every balance — the NATIVE one included — through
       * aggregate3, so an eth_getBalance answer on Polygon is never read and the row never
       * appears. ETC 61 has no verified Multicall3 and falls back to provider.getBalance, which
       * is what this stub can honestly answer. ETC is also a mapped news asset
       * (ethereum-classic), so it is the right anchor for these tests either way.
       */
      return chainId === 61 ? '0x1bc16d674ec80000' : '0x0'
    case 'eth_getCode':
      return '0x'
    case 'eth_call':
      return ZERO_WORD
    case 'eth_getLogs':
      return []
    default:
      return '0x'
  }
}

function stubJsonRpc() {
  cy.intercept({ method: 'POST', hostname: RPC_HOSTS }, (req) => {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    const answer = (entry) => ({ jsonrpc: '2.0', id: entry?.id ?? 1, result: rpcResult(req.url, entry) })
    req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(answer) : answer(body) })
  }).as('readRpc')
}

function openEtcAssetSheet() {
  cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true })
  cy.visit(PORTFOLIO_URL)
  // The one holding the RPC stub creates. Generous timeout: the other chains'
  // reads have to time out around it.
  cy.contains('.portfolio-row-button', 'ETC', { timeout: 60000 }).click()
  cy.get('.asset-sheet', { timeout: 30000 }).should('be.visible')
}

describe('Token news (spec 109)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    // Every test in this file loads the app, so every test needs the chain answered. Scoping this
    // to the portfolio block left the trade tests reaching the real network.
    stubJsonRpc()
  })

  // ---------------------------------------------------------------------------
  // Portfolio card (US1) — the AssetDetailSheet mount.
  // ---------------------------------------------------------------------------
  describe('portfolio token card', () => {
    it('[TN-01] a covered token renders attributed, dated, text-only items with a link-out', () => {
      const item = newsItem()
      cy.intercept('GET', '**/v1/news/**', { statusCode: 200, body: readBody([item]) }).as('news')
      openEtcAssetSheet()

      cy.wait('@news').its('request.url').should('contain', 'slug=ethereum-classic')
      cy.get('.token-news-card', { timeout: 15000 }).should('be.visible')

      // The headline is a link out, marked external, and TEXT — no vendor image ever renders.
      // ONE item means one FEATURED item: the layout ranks by published date, so the newest is
      // `.token-news-featured-link` and the compact `.token-news-link` rows are what follows it.
      cy.get('.token-news-card a.token-news-featured-link')
        .should('have.attr', 'href', item.url)
        .and('have.attr', 'target', '_blank')
      cy.get('.token-news-card a.token-news-featured-link').invoke('attr', 'rel').should('contain', 'noopener')
      cy.get('.token-news-card').should('contain.text', item.title)
      cy.get('.token-news-card img').should('not.exist')

      // Attribution and age are mandatory on every item (FR-004/FR-005).
      cy.get('.token-news-meta').should('contain.text', 'Example Wire').and('contain.text', '3h ago')

      // The card never gates the sheet: the instance actions are all still offered.
      cy.get('.asset-sheet-actions button').should('have.length.greaterThan', 0)

      cy.get('.asset-sheet').then(($sheet) => {
        cy.a11yScan({ context: $sheet[0], label: 'asset sheet with news card' })
      })
    })

    it('[TN-03] an unreadable feed is a sentence plus retry — and retry recovers', () => {
      let fail = true
      cy.intercept('GET', '**/v1/news/**', (req) => {
        if (fail) req.reply({ statusCode: 500, body: { error: { code: 'upstream_error' } } })
        else req.reply({ statusCode: 200, body: readBody([newsItem()]) })
      }).as('news')
      openEtcAssetSheet()

      // The failure state names itself; it must never look like "no news".
      cy.get('.token-news-card', { timeout: 15000 }).should(
        'contain.text',
        'The news feed could not be read right now.',
      )
      cy.get('.token-news-card').should('not.contain.text', 'No recent items')
      cy.get('.token-news-card .token-news-retry')
        .should('be.visible')
        .then(($btn) => {
          fail = false
          cy.wrap($btn).click()
        })
      // Retry re-invokes the seam and the items arrive.
      cy.get('.token-news-card a.token-news-featured-link', { timeout: 15000 }).should('be.visible')
    })

    it('[TN-04] an honest-empty read says sparse coverage, with no retry — distinct from unreadable', () => {
      cy.intercept('GET', '**/v1/news/**', { statusCode: 200, body: readBody([]) }).as('news')
      openEtcAssetSheet()

      cy.get('.token-news-card', { timeout: 15000 }).should('contain.text', 'No recent items for ETC.')
      // Empty is NOT the failure state: no retry, no could-not-read sentence.
      cy.get('.token-news-card .token-news-retry').should('not.exist')
      cy.get('.token-news-card').should('not.contain.text', 'could not be read')
    })

    it('[TN-06] the feed is RANKED: newest featured, first paint capped, the tail behind one disclosure', () => {
      // Deliberately out of vendor order and spanning three recency buckets. Ordering is ours,
      // from the published dates — there is no ranking signal here the vendor did not give us.
      const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString()
      const items = [
        newsItem({ id: '3', title: 'Third newest', url: 'https://news.example/3', publishedAt: hoursAgo(5) }),
        newsItem({ id: '1', title: 'The newest thing', url: 'https://news.example/1', publishedAt: hoursAgo(1) }),
        newsItem({ id: '6', title: 'A months-old take', url: 'https://news.example/6', publishedAt: hoursAgo(24 * 70) }),
        newsItem({ id: '2', title: 'Second newest', url: 'https://news.example/2', publishedAt: hoursAgo(3) }),
        newsItem({ id: '4', title: 'Fourth newest', url: 'https://news.example/4', publishedAt: hoursAgo(7) }),
        newsItem({ id: '5', title: 'A last-week piece', url: 'https://news.example/5', publishedAt: hoursAgo(24 * 3) }),
      ]
      cy.intercept('GET', '**/v1/news/**', { statusCode: 200, body: readBody(items) }).as('news')
      openEtcAssetSheet()

      // Exactly one featured item, and it is the NEWEST — not the vendor's first array entry.
      cy.get('.token-news-card a.token-news-featured-link', { timeout: 15000 })
        .should('have.length', 1)
        .and('have.text', 'The newest thing')

      // First paint is capped at featured + 3; the rest is not in the DOM at all, because a
      // control claiming aria-expanded="false" over rows still in the tab order is untrue.
      cy.get('.token-news-card a.token-news-link').should('have.length', 3)
      cy.get('.token-news-card').should('not.contain.text', 'A months-old take')

      // The tail is hours-to-months old, so it is "older", not "Earlier" — the label reports what
      // is actually in it rather than assuming the tail is always ancient.
      cy.get('.token-news-card .token-news-more')
        .should('have.attr', 'aria-expanded', 'false')
        .and('contain.text', 'Show 2 older')
        .click()
      cy.get('.token-news-card .token-news-more').should('have.attr', 'aria-expanded', 'true')
      cy.get('.token-news-card').should('contain.text', 'A months-old take')

      // Recency headings appear only where the bucket CHANGES — the three same-day rows under a
      // same-day featured item carry none, and the two older ones are named.
      cy.get('.token-news-card .token-news-bucket').should('have.length', 2)
      cy.get('.token-news-card .token-news-bucket').first().should('have.text', 'This week')
      cy.get('.token-news-card .token-news-bucket').last().should('have.text', 'Earlier')

      cy.get('.asset-sheet').then(($sheet) => {
        cy.a11yScan({ context: $sheet[0], label: 'asset sheet with an expanded news feed' })
      })
    })

    it('[TN-04b] the module switched off renders NO card — absence, not an empty affordance', () => {
      cy.intercept('GET', '**/v1/news/**', {
        statusCode: 503,
        body: { error: { code: 'news_unconfigured' } },
      }).as('news')
      openEtcAssetSheet()

      cy.wait('@news')
      // The sheet is fine; the news surface simply is not there.
      cy.get('.asset-sheet-actions').should('be.visible')
      cy.get('.token-news-card').should('not.exist')
    })
  })

  // ---------------------------------------------------------------------------
  // Trade-pair feed (US2) — one card per leg, advisory only.
  // ---------------------------------------------------------------------------
  describe('trade-pair feed', () => {
    beforeEach(() => {
      cy.mockWeb3Provider({ account: TEST_ACCOUNT, preAuthorized: true })
    })

    it('[TN-05] partial coverage is labelled per leg, and news never touches the swap form (+ [TN-02] no request for an unmapped asset)', () => {
      const item = newsItem({ title: 'Classic client release cut' })
      const newsCalls = []
      cy.intercept('GET', '**/v1/news/**', (req) => {
        newsCalls.push(req.url)
        req.reply({ statusCode: 200, body: readBody([item]) })
      }).as('news')

      cy.visit('/wallet?tab=trade')
      cy.get('.trade-panel', { timeout: 15000 }).should('exist')

      // Move the pair to WETC/USC on Ethereum Classic: WETC maps to a news slug
      // (baseline ETC → ethereum-classic), USC is deliberately unmapped.
      cy.get('button[aria-label="Token to sell"]').click()
      cy.get('[role="listbox"]', { timeout: 10000 }).should('be.visible')
      cy.get('[role="option"][aria-label="WETC on Ethereum Classic"]').click()

      // One card per leg — a pair with one covered and one uncovered token is
      // labelled partial coverage, never a silently merged feed.
      cy.get('.trade-news .token-news-card', { timeout: 15000 }).should('have.length', 2)
      cy.get('.trade-news').should('contain.text', item.title)
      cy.get('.trade-news').should('contain.text', 'No news source covers USC.')

      // TN-02: the unmapped leg produced ZERO gateway requests — the mapping is
      // client-side and a missing row IS "not covered" (no ticker heuristic).
      cy.get('.trade-news .token-news-card a.token-news-featured-link').should('be.visible')
      /*
       * TN-02, stated as what is actually invariant.
       *
       * A raw request COUNT is not: the card refetches on re-render and the ticket's default pair
       * (WPOL/USDC, both mapped) is fetched before the pair is moved, so "exactly one request" was
       * never true and asserting it proved nothing except that the number happened to be one.
       *
       * What the mapping guarantees is the SET: a request is only ever made for an asset the
       * curated table resolves, so an unmapped asset (USC) can never appear as a slug and costs
       * no network at all. Every slug seen must therefore be one of the mapped three, and the
       * mapped leg of this pair must be among them.
       */
      // EVERY slug the curated table can emit (config/newsAssets.js: the underlying-coin map plus
      // the registry-symbol map). Listing a subset failed here for a good reason — a WETH leg
      // legitimately asked for `ethereum` — and the invariant is not "these three assets" but
      // "only assets the table resolves are ever asked for at all".
      const MAPPED_SLUGS = [
        'ethereum',
        'ethereum-classic',
        'matic-network',
        'bitcoin',
        'usd-coin',
        'tether',
        'wrapped-bitcoin',
      ]
      cy.then(() => {
        const slugs = new Set(newsCalls.map((u) => new URL(u, 'http://x').searchParams.get('slug')))
        for (const slug of slugs) {
          expect(MAPPED_SLUGS, `a request was made for an unmapped asset: slug=${slug}`).to.include(slug)
        }
        expect(slugs.has('ethereum-classic'), 'the mapped leg of this pair was fetched').to.equal(true)
      })

      // FR-006: the ticket is untouched by any news state — the amount entry
      // takes input exactly as if the feed did not exist.
      cy.get('#trade-amount').should('not.be.disabled').type('1').should('have.value', '1')
    })

    it('[TN-05b] an unreadable feed on the trade surface never disables the form', () => {
      cy.intercept('GET', '**/v1/news/**', {
        statusCode: 200,
        body: { state: 'unreadable', reason: 'upstream_unreachable' },
      }).as('news')

      cy.visit('/wallet?tab=trade')
      cy.get('.trade-panel', { timeout: 15000 }).should('exist')
      cy.get('button[aria-label="Token to sell"]').click()
      cy.get('[role="option"][aria-label="WETC on Ethereum Classic"]').click()

      cy.get('.trade-news .token-news-card', { timeout: 15000 })
        .should('contain.text', 'The news feed could not be read right now.')
      cy.get('#trade-amount').should('not.be.disabled').type('2').should('have.value', '2')
    })
  })
})
