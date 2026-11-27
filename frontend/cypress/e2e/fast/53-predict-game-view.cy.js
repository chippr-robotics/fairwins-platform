// =============================================================================
// 53-predict-game-view.cy.js
// Fast-tier E2E for the live game view on the Predict event page (spec 115, slices 1-2).
//
// The game view reads ONE gateway route (`GET /v1/sports/games/:id`) and nothing else, so everything it does is
// answerable at the gateway boundary and belongs in the no-chain tier. The gateway is stubbed with
// `cy.intercept`, answering as contracts/gateway-sports-api.md says it does; a module that is off answers 503
// `sports_unconfigured`. The Polymarket routes the event page needs are stubbed minimally (the books route is
// absent, which the page handles by design — this spec is about the game view, not prices).
//
//   PG-01 a live game: score, period, clock, a Live chip; field + plays with their sentences
//   PG-02 the module off: the page is exactly what it was — no game view, no placeholder, one request only
//   PG-03 a source that stops answering: last known, never Live; play detail unreadable is named, no plays
//   PG-04 the event page with a game view has no serious or critical accessibility violations
//   PG-05 a game only the venue's feed has spoken about: Delayed (never Live), the feed named from the envelope,
//         and the game's identity sent from the event listing
//   PG-07 a finished decision: the winner, method, round and time, three judges' scores, the overall table, the
//         market-settles-separately sentence; the claim (fighter names) rides along
//   PG-08 a KO: the winner and the ending, no judges table; a fight in progress shows its round and clock
//   PG-09 the fight module off (503 sports_fight_unconfigured): the page is exactly what it was — no fight view,
//         no scoreboard from fighter names — while a football game on another event still works
//   PG-10 the fight view has no serious or critical accessibility violations
//   PG-06 the play source and the venue's feed disagree: the play source's score is shown, and one line says what
//         the venue's feed shows and when it last changed
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const POLYMARKET = /localhost:8899\/v1\/polymarket/
const SPORTS = /localhost:8899\/v1\/sports\/games\//
const FIGHTS = /localhost:8899\/v1\/sports\/fights\//
const RPC_HOSTS = /publicnode\.com$|rivet\.link$|etcdesktop\.com$|polygon\.technology$/
const TOKEN_YES = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
const TOKEN_NO = '52114319501245915516055106046884209969926127482827954674443846427813813222426'
const SLUG = 'eagles-vs-cowboys'
const FIGHT_SLUG = 'gane-vs-hokit'

const GAME = {
  gameId: 19618,
  league: 'nfl',
  startTime: '2026-11-26T21:30:00Z',
  listed: { status: 'in-progress', scoreText: '10-28', period: 'Q3', clock: '10:39' },
  home: { name: 'Cowboys', code: 'DAL' },
  away: { name: 'Eagles', code: 'PHI' },
}
const EVENT = {
  slug: SLUG,
  title: 'Eagles vs. Cowboys',
  category: 'sports',
  volume: '2400000.5',
  volume24h: '120000',
  endDate: '2030-12-10T12:00:00Z',
  mutuallyExclusive: true,
  marketCount: 1,
  description: 'Resolves to the winner of the game.',
  resolutionSource: 'NFL',
  status: 'open',
  live: null,
  game: GAME,
  markets: [
    {
      conditionId: '0xg1',
      label: 'Cowboys win',
      tradable: true,
      negRisk: false,
      outcomes: [
        { name: 'Yes', tokenId: TOKEN_YES, price: '0.80' },
        { name: 'No', tokenId: TOKEN_NO, price: '0.20' },
      ],
      bestBid: null,
      bestAsk: null,
      lastTradePrice: null,
      volume: '1000',
      volume24h: '10',
      displayPrice: '0.80',
      tickSize: '0.01',
      minOrderSize: '5',
    },
  ],
}

const FIGHT_EVENT = {
  ...EVENT,
  slug: FIGHT_SLUG,
  title: 'UFC 334: Ciryl Gane vs. Josh Hokit',
  game: {
    gameId: 13140,
    league: 'ufc',
    startTime: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    teams: [{ name: 'Ciryl Gane', code: null }, { name: 'Josh Hokit', code: null }],
  },
  markets: [{ ...EVENT.markets[0], conditionId: '0xg2', label: 'Ciryl Gane wins' }],
}
const EVENTS_BY_SLUG = { [SLUG]: EVENT, [FIGHT_SLUG]: FIGHT_EVENT }

const zeroFigures = {
  knockdowns: 0, sigStrikesLanded: 41, sigStrikesAttempted: 65, totalStrikesLanded: 41, totalStrikesAttempted: 66,
  headStrikesLanded: 34, headStrikesAttempted: 56, bodyStrikesLanded: 7, bodyStrikesAttempted: 9, legStrikesLanded: 0, legStrikesAttempted: 0,
  takedownsLanded: 0, takedownsAttempted: 0, reversals: 0, submissionsAttempted: 0, controlSeconds: 3,
}
const otherFigures = { ...zeroFigures, sigStrikesLanded: 22, sigStrikesAttempted: 51, takedownsLanded: 1, takedownsAttempted: 6, controlSeconds: 71 }

function fightAnswer(kind) {
  const serverNow = Date.now()
  const base = {
    gameId: 13140,
    source: 'figures',
    status: 'ended',
    scheduledRounds: 5,
    weightClass: 'Heavyweight',
    round: 5,
    clock: '5:00',
    confirmedAt: serverNow - 2000,
    changedAt: null,
    fighters: [{ name: 'Ciryl Gane' }, { name: 'Josh Hokit' }],
    venue: null,
    rounds: [{ round: 1, figures: [zeroFigures, otherFigures] }],
    overall: [zeroFigures, otherFigures],
    result: {
      source: 'figures',
      outcome: 'win',
      winner: 0,
      method: 'Decision - Unanimous',
      endingRound: 5,
      endingTime: '5:00',
      judges: [
        { name: 'Adrian Castro', scores: [48, 47] },
        { name: 'Junichiro Kamijo', scores: [49, 46] },
        { name: 'Sal D\u2019Amato', scores: [48, 47] },
      ],
    },
  }
  if (kind === 'ko') {
    base.round = 1
    base.clock = '0:24'
    base.result = { source: 'figures', outcome: 'win', winner: 1, method: 'KO/TKO', endingRound: 1, endingTime: '0:24', judges: [] }
    base.overall = null
  }
  if (kind === 'in-progress') {
    base.source = 'card'
    base.status = 'in-progress'
    base.round = 2
    base.clock = '3:12'
    base.result = null
    base.overall = null
  }
  return {
    serverNow,
    sources: { venue: { state: 'read', label: 'Polymarket' }, card: { state: 'read', label: 'ESPN' }, figures: { state: 'read', label: 'UFC' } },
    fight: base,
  }
}

// The game answer is a knob a test turns BEFORE it visits; the intercept reads it at request time.
// `ageMs` is how far behind the gateway's own `serverNow` the newest confirmation is — the app derives its
// state from THAT, never from the device clock.
const world = { game: 'live', ageMs: 2000, fight: 'decision' }

function playDetail(state = 'read') {
  const serverNow = Date.now()
  if (state === 'unreadable') return { state: 'unreadable', confirmedAt: null, situation: null, plays: [] }
  if (state === 'not-covered') return { state: 'not-covered', confirmedAt: null, situation: null, plays: [] }
  return {
    state: 'read',
    confirmedAt: serverNow - 3000,
    situation: {
      possession: 'home',
      yardLine: 37,
      yardLineText: 'DAL 37',
      down: 4,
      distance: 18,
      downDistanceText: '4th & 18 at DAL 37',
      lineToGain: 55,
      redZone: false,
    },
    plays: [
      { id: 'p3', period: 'Q3', clock: '10:44', text: 'Pass incomplete to CeeDee Lamb.', scoring: false, side: 'home' },
      { id: 'p2', period: 'Q3', clock: '11:20', text: 'Jake Elliott 42 yard field goal is GOOD.', scoring: true, side: 'away' },
    ],
  }
}

function gateways() {
  cy.intercept({ method: 'GET', url: POLYMARKET }, (req) => {
    const now = new Date().toISOString()
    const json = (body, statusCode = 200) => req.reply({ statusCode, body })
    if (/\/discover(\?|$)/.test(req.url)) return json({ live: { count: 0, events: [] }, topics: [], confirmedAt: now, serverNow: now, stale: false })
    if (/\/fee-rate(\?|$)/.test(req.url)) return json({ builderTakerFeeBps: 50, builderMakerFeeBps: 0, polymarketTakerFeeBps: 0, fetchedAt: Date.now() })
    const detail = /\/events\/([a-z0-9-]+)(\?|$)/.exec(req.url)
    if (detail) return json({ ...(EVENTS_BY_SLUG[detail[1]] ?? EVENT), confirmedAt: now, serverNow: now, stale: false })
    if (/\/prices-history(\?|$)/.test(req.url)) {
      const nowSec = Math.floor(Date.now() / 1000)
      const points = Array.from({ length: 20 }, (_, i) => ({ t: nowSec - (19 - i) * 300, p: (0.7 + 0.01 * i).toFixed(3) }))
      return json({ tokenId: TOKEN_YES, range: '1d', points, confirmedAt: now, serverNow: now, stale: false })
    }
    return json({ error: { code: 'not_found' } }, 404)
  })

  cy.intercept({ method: 'GET', url: SPORTS }, (req) => {
    if (world.game === 'off') return req.reply({ statusCode: 503, body: { error: { code: 'sports_unconfigured', reason: 'sports module is not enabled' } } })
    const serverNow = Date.now()
    const venueOnly = world.game === 'venue'
    const playsUnreadable = world.game === 'plays-unreadable'
    const row = {
      gameId: 19618,
      league: 'nfl',
      source: venueOnly || playsUnreadable ? 'venue' : 'plays',
      status: 'in-progress',
      score: venueOnly || playsUnreadable ? { home: 21, away: 10 } : { home: 28, away: 10 },
      scoreText: null,
      period: 'Q3',
      clock: '10:39',
      possession: venueOnly || playsUnreadable ? null : 'home',
      confirmedAt: serverNow - world.ageMs,
      changedAt: venueOnly || playsUnreadable ? serverNow - 40_000 : null,
      agree: world.game === 'disagree' ? false : venueOnly || playsUnreadable ? null : true,
      venue:
        world.game === 'disagree'
          ? { status: 'in-progress', score: { home: 21, away: 10 }, scoreText: null, period: 'Q3', clock: '10:39', changedAt: serverNow - 120_000 }
          : null,
      detail: playDetail(playsUnreadable ? 'unreadable' : venueOnly ? 'not-covered' : 'read'),
    }
    req.reply({
      statusCode: 200,
      body: {
        serverNow,
        sources: {
          venue: { state: 'read', label: 'Polymarket' },
          plays: { state: playsUnreadable ? 'unreadable' : 'read', label: 'ESPN' },
        },
        games: [row],
      },
    })
  }).as('game')
}

function fightGateway() {
  cy.intercept({ method: 'GET', url: FIGHTS }, (req) => {
    if (world.fight === 'off') {
      return req.reply({ statusCode: 503, body: { error: { code: 'sports_fight_unconfigured', reason: 'the fight view is switched off' } } })
    }
    req.reply({ statusCode: 200, body: fightAnswer(world.fight) })
  }).as('fight')
}

function chainWorld() {
  cy.intercept({ method: 'POST', hostname: RPC_HOSTS }, (req) => {
    const one = ({ method, id }) => ({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x89' : method === 'eth_blockNumber' ? '0x4000000' : method === 'eth_getBalance' ? '0x0' : '0x' })
    const body = req.body
    req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(one) : one(body || {}) })
  })
  cy.intercept({ method: 'GET', url: /polymarket\.com\/api\/geoblock/ }, { statusCode: 200, body: { blocked: false } })
  cy.intercept({ url: /clob\.polymarket\.com/ }, { statusCode: 503, body: { error: 'the venue is not reachable from the no-chain tier' } })
}

function openEvent(game, ageMs = 2000, { slug = SLUG, title = 'Eagles vs. Cowboys', fight = 'decision' } = {}) {
  cy.then(() => {
    world.game = game
    world.ageMs = ageMs
    world.fight = fight
  })
  chainWorld()
  gateways()
  fightGateway()
  cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true, networkId: 137, rpcUrl: 'https://polygon-bor-rpc.publicnode.com' })
  cy.visit(`/wallet?tab=predict&event=${slug}`)
  cy.get('[aria-label="Predict"]', { timeout: 40000 }).should('exist')
  cy.get('.event-page h2', { timeout: 20000 }).should('have.text', title)
}

const openFight = (fight) => openEvent('live', 2000, { slug: FIGHT_SLUG, title: 'UFC 334: Ciryl Gane vs. Josh Hokit', fight })

describe('Predict — the live game view (spec 115)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[PG-01] predict.game-scoreboard — a live game shows its score, period, clock and a Live chip, above the outcomes', () => {
    openEvent('live')
    cy.get('[data-testid="game-view"]', { timeout: 20000 }).within(() => {
      cy.contains('.game-team', 'Cowboys').should('contain.text', '28')
      cy.contains('.game-team', 'Eagles').should('contain.text', '10')
      cy.get('[data-testid="game-status"]').should('have.text', 'In progress · Q3 · 10:39')
      cy.get('[data-testid="game-trust-chip"]').should('contain.text', 'Game information is live')
      cy.get('[data-testid="game-source"]').should('have.text', 'From ESPN.')
    })
    // The game's identity rode along from the event listing.
    cy.get('@game.all').then((calls) => {
      const q = new URL(calls[0].request.url).searchParams
      expect(Object.fromEntries(q)).to.deep.equal({ league: 'nfl', home: 'DAL', away: 'PHI', start: '2026-11-26T21:30:00Z' })
    })
    // Above the markets list, not below it.
    cy.get('[data-testid="game-view"]').then(($g) => {
      cy.get('#event-page-outcomes').then(($o) => {
        expect($g[0].compareDocumentPosition($o[0]) & Node.DOCUMENT_POSITION_FOLLOWING).to.be.greaterThan(0)
      })
    })
  })

  it('[PG-01] predict.game-field-and-plays — the field, its text equivalent and the plays, with the behind-the-broadcast sentence', () => {
    openEvent('live')
    cy.get('[data-testid="game-field"]', { timeout: 20000 }).within(() => {
      cy.get('svg').should('have.attr', 'aria-hidden', 'true')
      cy.get('.game-field-ball').should('exist')
      cy.get('.game-field-gain').should('exist')
      cy.get('[data-testid="game-field-text"]')
        .should('contain.text', '4th & 18 at DAL 37')
        .and('contain.text', 'Cowboys have the ball')
    })
    cy.get('[data-testid="game-plays"] li').should('have.length', 2).first().should('contain.text', 'Q3 10:44')
    cy.get('[data-testid="game-plays"]').should('contain.text', 'Scored: Jake Elliott 42 yard field goal is GOOD.')
    cy.get('[data-testid="game-view"]').should('contain.text', 'can be behind the broadcast and behind the market')
  })

  it('[PG-02] predict.game-scoreboard — with the module off the page is exactly what it was: no game view, no placeholder, one request', () => {
    openEvent('off')
    cy.get('#event-page-outcomes', { timeout: 20000 }).should('exist')
    cy.get('@game.all').should('have.length', 1)
    cy.get('[data-testid="game-view"]').should('not.exist')
    cy.get('.game-view').should('not.exist')
    // It does not ask again on this page view.
    cy.wait(6500)
    cy.get('@game.all').should('have.length', 1)
  })

  it('[PG-03] predict.game-scoreboard — a game last confirmed two minutes ago is Last known, never Live, and keeps its score', () => {
    openEvent('live', 120_000)
    cy.get('[data-testid="game-trust-chip"]', { timeout: 20000 })
      .should('contain.text', 'Showing the last known game information')
      .and('not.contain.text', 'is live')
    cy.get('.game-view').should('contain.text', '28')
  })

  it('[PG-03] predict.game-field-and-plays — an unreadable play source is named, with no field and no plays; the scoreboard stays', () => {
    openEvent('plays-unreadable')
    cy.get('.game-view', { timeout: 20000 }).should('contain.text', 'Play detail could not be read from ESPN')
    cy.get('[data-testid="game-field"]').should('not.exist')
    cy.get('[data-testid="game-plays"]').should('not.exist')
    // The row falls back to the venue's feed: Delayed, never Live.
    cy.get('[data-testid="game-trust-chip"]').should('contain.text', 'Game information is delayed')
    cy.get('.game-view').should('contain.text', 'Cowboys').and('contain.text', '21')
  })

  it('[PG-05] predict.game-scoreboard — a venue-only game is Delayed, never Live, and names its feed and cadence', () => {
    openEvent('venue', 5000)
    cy.get('[data-testid="game-trust-chip"]', { timeout: 20000 })
      .should('contain.text', 'Game information is delayed')
      .and('not.contain.text', 'is live')
    cy.get('[data-testid="game-source"]').should('contain.text', "Score from Polymarket's game feed, which updates about once a minute. Last changed")
    cy.get('[data-testid="game-field"]').should('not.exist')
  })

  it('[PG-06] predict.game-scoreboard — when the feeds disagree the play source\'s score is shown and one line says what the venue\'s feed shows', () => {
    openEvent('disagree')
    cy.get('[data-testid="game-disagree"]', { timeout: 20000 })
      .should('contain.text', "Polymarket's own game feed still shows Eagles 10, Cowboys 21 (last changed")
    cy.contains('.game-team', 'Cowboys').should('contain.text', '28')
    cy.get('.game-view').should('not.contain.text', 'may be behind the score')
  })

  it('[PG-04] predict.game-scoreboard — the event page with a game view has no serious or critical accessibility violations', () => {
    openEvent('live')
    cy.get('[data-testid="game-field"]', { timeout: 20000 }).should('exist')
    cy.a11yScan({ context: '.predict-panel', label: 'predict event page with game view' })
  })

  it('[PG-07] predict.fight-view — a finished decision: winner, method, round and time, three judges, the overall table, and the claim rides along', () => {
    openFight('decision')
    cy.get('[data-testid="fight-view"]', { timeout: 20000 }).within(() => {
      cy.get('[data-testid="fight-names"]').should('contain.text', 'Ciryl Gane').and('contain.text', 'Josh Hokit')
      cy.get('[data-testid="fight-result"]').should('contain.text', 'Ciryl Gane won').and('contain.text', 'Decision - Unanimous · Round 5 · 5:00')
      cy.get('[data-testid="fight-judges"] tbody tr').should('have.length', 3)
      cy.get('[data-testid="fight-judges"]').should('contain.text', 'Adrian Castro').and('contain.text', '48').and('contain.text', '47')
      cy.get('[data-testid="fight-result"]').should('contain.text', 'market settles separately')
      cy.get('[data-testid="fight-figures"] table').first().find('caption').should('have.text', 'Overall, the whole fight')
      cy.contains('th', 'Significant strikes').parent().should('contain.text', '41 of 65').and('contain.text', '22 of 51')
      cy.contains('Show 1 more table').click()
      cy.get('[data-testid="fight-figures"] table').should('have.length', 2)
    })
    cy.get('[data-testid="game-view"]').should('not.exist')
    cy.get('@fight.all').then((calls) => {
      const q = new URL(calls[0].request.url).searchParams
      expect(q.get('a')).to.equal('Ciryl Gane')
      expect(q.get('b')).to.equal('Josh Hokit')
    })
    cy.get('@game.all').should('have.length', 0)
  })

  it('[PG-08] predict.fight-view — a KO names its winner with no judges table, and a fight in progress shows its round and clock', () => {
    openFight('ko')
    cy.get('[data-testid="fight-result"]', { timeout: 20000 }).should('contain.text', 'Josh Hokit won').and('contain.text', 'KO/TKO · Round 1 · 0:24')
    cy.get('[data-testid="fight-judges"]').should('not.exist')
    openFight('in-progress')
    cy.get('[data-testid="fight-status"]', { timeout: 20000 }).should('have.text', 'In progress · Round 2 of 5 · 3:12')
    cy.get('[data-testid="game-trust-chip"]').should('contain.text', 'Fight information is live')
    cy.get('[data-testid="fight-result"]').should('not.exist')
  })

  it('[PG-09] predict.fight-view — with the fight module off the page is exactly what it was, while a football game on another event still works', () => {
    openFight('off')
    cy.get('#event-page-outcomes', { timeout: 20000 }).should('exist')
    cy.get('@fight.all').should('have.length', 1)
    cy.get('[data-testid="fight-view"]').should('not.exist')
    cy.get('[data-testid="game-view"]').should('not.exist')
    cy.get('.game-view').should('not.exist')
    cy.get('@game.all').should('have.length', 0)
    // The football event, in the same session, with the game module on.
    cy.visit(`/wallet?tab=predict&event=${SLUG}`)
    cy.get('[data-testid="game-view"]', { timeout: 20000 }).should('contain.text', 'Cowboys')
  })

  it('[PG-10] predict.fight-view — the fight view has no serious or critical accessibility violations', () => {
    openFight('decision')
    cy.get('[data-testid="fight-judges"]', { timeout: 20000 }).should('exist')
    cy.a11yScan({ context: '.predict-panel', label: 'predict event page with fight view' })
  })
})
