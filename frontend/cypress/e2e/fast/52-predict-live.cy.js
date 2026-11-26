// =============================================================================
// 52-predict-live.cy.js
// Fast-tier E2E for Predict "browse by event" (spec 114, User Story 1).
//
// The list reads the relay-gateway's `/events` route, so everything short of a
// signature is answerable at the gateway boundary and belongs in the no-chain tier
// (e2e-testing-policy: a flow validatable without a chain must not live on-chain).
// The gateway is stubbed here the way 37-predict-and-collect stubs it, and the
// stub MIRRORS the real route's rules — `q` ignores category and sort, a cursor
// pages — so a test can only pass if the app asks the right question, not merely
// if it renders whatever it is given.
//
// Trading is untouched by this slice and stays covered by 37 (PR-02 / PR-04).
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const GATEWAY_URL = /localhost:8899\/v1\/polymarket/
const RPC_HOSTS = /publicnode\.com$|rivet\.link$|etcdesktop\.com$|polygon\.technology$/
const PAGE_SIZE = 3

// Token ids must be long digit strings or the real gateway would drop the outcome.
const TOKEN_YES = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
const TOKEN_NO = '52114319501245915516055106046884209969926127482827954674443846427813813222426'

const row = (conditionId, label, displayPrice) => ({
  conditionId,
  label,
  tradable: true,
  negRisk: false,
  outcomes: [
    { name: 'Yes', tokenId: TOKEN_YES, price: displayPrice },
    { name: 'No', tokenId: TOKEN_NO, price: String(1 - Number(displayPrice)) },
  ],
  bestBid: null,
  bestAsk: null,
  lastTradePrice: null,
  displayPrice,
  tickSize: '0.01',
  minOrderSize: '5',
})

const event = (slug, title, category, markets, over = {}) => ({
  slug,
  title,
  category,
  volume: '61605847.12',
  volume24h: '1820443.90',
  endDate: '2030-12-10T12:00:00Z',
  mutuallyExclusive: markets.length > 1,
  marketCount: markets.length,
  markets,
  ...over,
})

// Order matters: the default view is the FIRST page only (three events); "rain" lives on page two,
// so finding it takes a search — the point of PL-02.
const EVENTS = [
  event('fed-decision-in-december', 'Fed Decision in December?', 'economy', [
    row('0xf1', '25 bps increase', '0.935'),
    row('0xf2', 'No change', '0.05'),
    row('0xf3', '50+ bps decrease', '0.004'),
    row('0xf4', '25 bps decrease', '0.003'),
  ], { marketCount: 6 }),
  event('bitcoin-above-200k', 'Bitcoin above $200k this year?', 'crypto', [row('0xb1', 'Bitcoin above $200k', '0.31')]),
  event('next-election', 'Who wins the next election?', 'politics', [row('0xe1', 'Incumbent party', '0.48')]),
  event('rain-london', 'Will it rain in London tomorrow?', 'world', [row('0xa1', 'Rain in London', '0.62')], { volume: null }),
]

/** The gateway's `/events` rules, in miniature. */
function predictGateway() {
  cy.intercept({ method: 'GET', url: GATEWAY_URL }, (req) => {
    if (!/\/events(\?|$)/.test(req.url)) return req.continue()
    const p = new URL(req.url).searchParams
    const q = (p.get('q') || '').toLowerCase()
    const category = p.get('category') || ''
    const offset = Number(p.get('next') || 0)
    // `q` wins: the venue's search ignores category and sort.
    const all = q
      ? EVENTS.filter((e) => e.title.toLowerCase().includes(q))
      : category
        ? EVENTS.filter((e) => e.category === category)
        : EVENTS
    const events = all.slice(offset, offset + PAGE_SIZE)
    const next = offset + PAGE_SIZE < all.length ? String(offset + PAGE_SIZE) : null
    const now = new Date().toISOString()
    req.reply({ statusCode: 200, body: { events, next, confirmedAt: now, serverNow: now, stale: false } })
  }).as('events')
}

function chainWorld() {
  cy.intercept({ method: 'POST', hostname: RPC_HOSTS }, (req) => {
    const one = ({ method, id }) => {
      const reply = (result) => ({ jsonrpc: '2.0', id, result })
      if (method === 'eth_chainId') return reply('0x89')
      if (method === 'eth_blockNumber') return reply('0x4000000')
      if (method === 'eth_getBalance') return reply('0x0')
      return reply('0x')
    }
    const body = req.body
    req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(one) : one(body || {}) })
  })
}

function connect() {
  cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true, networkId: 137, rpcUrl: 'https://polygon-bor-rpc.publicnode.com' })
}

function openPredict(search = '') {
  chainWorld()
  predictGateway()
  connect()
  cy.visit('/wallet?tab=predict' + search)
  cy.get('[aria-label="Wallet Account"]', { timeout: 40000 }).should('exist')
  cy.get('[aria-label="Predict"]', { timeout: 40000 }).should('exist')
}

describe('Predict — browse by event (spec 114)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[PL-01] predict.browse-by-event — a category narrows the list, is in the address, and survives a reload', () => {
    openPredict()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', PAGE_SIZE)

    cy.get('[role="group"][aria-label="Category"]').contains('button', 'Crypto').click()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
    cy.get('.event-card').should('contain.text', 'Bitcoin above $200k')
    cy.get('.event-card').should('not.contain.text', 'Fed Decision')
    cy.get('[role="group"][aria-label="Category"]').contains('button', 'Crypto').should('have.attr', 'aria-pressed', 'true')
    cy.location('search').should('include', 'tab=predict').and('include', 'cat=crypto')

    // The address IS the view: loading it again, from nothing, lands on the same list.
    cy.location('search').then((search) => {
      openPredict(search.replace(/^\?tab=predict/, ''))
      cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
      cy.get('.event-card').should('contain.text', 'Bitcoin above $200k')
      cy.get('[role="group"][aria-label="Category"]').contains('button', 'Crypto').should('have.attr', 'aria-pressed', 'true')
    })
  })

  it('[PL-02] predict.browse-by-event — a search finds an event off the first page and says it ignores categories', () => {
    openPredict()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', PAGE_SIZE)
    cy.contains('.event-card', 'rain in London').should('not.exist')

    cy.get('[aria-label="Search markets"]').type('rain')
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
    cy.get('.event-card').should('contain.text', 'Will it rain in London tomorrow?')
    cy.contains(/Searching all categories/i).should('be.visible')
    cy.get('[role="group"][aria-label="Category"] button').first().should('be.disabled')
    cy.location('search').should('include', 'q=rain')
  })

  it('[PL-03] predict.browse-by-event — an event with several markets is ONE card with its rows', () => {
    openPredict()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', PAGE_SIZE)
    cy.get('.event-card').filter(':contains("Fed Decision in December?")').should('have.length', 1).within(() => {
      cy.get('.event-card-row').should('have.length', 4)
      cy.contains('25 bps increase').should('exist')
      cy.contains('+2 more').should('exist')
      // 0.935 is 94%; a 0.4% row is "<1%", never a rounded-to-nothing "0%".
      cy.get('.event-card-row').first().should('contain.text', '94%')
      cy.get('.event-card-row').eq(2).should('contain.text', '<1%')
      cy.contains('$61.6M traded').should('exist')
    })
    // The list says what it is: delayed, never live.
    cy.get('.predict-trust-chip').should('contain.text', 'Delayed').and('not.contain.text', 'Live')
  })

  it('[PL-04] predict.browse-by-event — the browse view has no serious or critical accessibility violations', () => {
    openPredict()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', PAGE_SIZE)
    cy.a11yScan({ context: '.predict-panel', label: 'predict browse view' })
  })
})
