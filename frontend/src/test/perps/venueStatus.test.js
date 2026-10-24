/**
 * Per-venue operational state (spec 083, T018).
 *
 * The assertions that matter here are the ones about FAILURE: a venue we could not read must never
 * be treated as open, one venue's failure must never blank another, and no status — not even
 * `paused` — may be able to withdraw the exit control (SC-004).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VENUE_STATUS,
  STATUS_VENUE_IDS,
  readGainsStatus,
  readGmxStatus,
  readVenueStatuses,
  canOpen,
  canClose,
  canReduce,
  exitAvailability,
  openBlockedNote,
} from '../../lib/perps/venueStatus'

// Vite rewrites `new URL(<relative>, import.meta.url)` into an asset URL, so resolve from the
// test file's own directory instead.
const SOURCE_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../lib/perps/venueStatus.js')

const ARBITRUM = 42161

/** A diamond stub whose two reads can each be made to resolve or reject independently. */
function gainsDeps({ activated = 0n, timeout = 200n, activatedError, timeoutError, provider = {} } = {}) {
  return {
    getProvider: () => provider,
    makeContract: () => ({
      getTradingActivated: () => (activatedError ? Promise.reject(activatedError) : Promise.resolve(activated)),
      getMarketOrdersTimeoutBlocks: () =>
        timeoutError ? Promise.reject(timeoutError) : Promise.resolve(timeout),
    }),
  }
}

function gmxDeps({ code = '0x60806040', routerCode, getCodeError, provider } = {}) {
  const codes = { exchange: code, router: routerCode === undefined ? code : routerCode }
  return {
    getProvider: () =>
      provider !== undefined
        ? provider
        : {
            getCode: (address) => {
              if (getCodeError) return Promise.reject(getCodeError)
              // The ExchangeRouter is the call target; the Router is the approval target.
              return Promise.resolve(
                address === '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6' ? codes.router : codes.exchange,
              )
            },
          },
  }
}

describe('readGainsStatus — the venue is the authority', () => {
  it('maps ACTIVATED / CLOSE_ONLY / PAUSED to the app vocabulary', async () => {
    expect((await readGainsStatus(ARBITRUM, gainsDeps({ activated: 0n }))).status).toBe(VENUE_STATUS.OPEN)
    expect((await readGainsStatus(ARBITRUM, gainsDeps({ activated: 1n }))).status).toBe(
      VENUE_STATUS.CLOSE_ONLY,
    )
    expect((await readGainsStatus(ARBITRUM, gainsDeps({ activated: 2n }))).status).toBe(VENUE_STATUS.PAUSED)
  })

  it('carries the live timeout block count rather than a hardcoded one', async () => {
    const arb = await readGainsStatus(ARBITRUM, gainsDeps({ timeout: 200n }))
    const base = await readGainsStatus(8453, gainsDeps({ timeout: 30n }))
    expect(arb.timeoutBlocks).toBe(200)
    expect(base.timeoutBlocks).toBe(30)
  })

  it('reports not-deployed — not unreadable — on a chain Gains is not on', async () => {
    const res = await readGainsStatus(1, gainsDeps())
    expect(res.status).toBe(VENUE_STATUS.NOT_DEPLOYED)
    expect(res.detail).toMatch(/not deployed/i)
  })

  it('is unreadable when the chain has no read connection', async () => {
    const res = await readGainsStatus(ARBITRUM, { getProvider: () => null })
    expect(res.status).toBe(VENUE_STATUS.UNREADABLE)
    expect(res.detail).toMatch(/read connection/i)
  })

  it('is unreadable when the provider factory itself throws', async () => {
    const res = await readGainsStatus(
      ARBITRUM,
      {
        getProvider: () => {
          throw new Error('endpoint misconfigured')
        },
      },
    )
    expect(res.status).toBe(VENUE_STATUS.UNREADABLE)
  })

  it('is unreadable — never open — when getTradingActivated reverts', async () => {
    const res = await readGainsStatus(ARBITRUM, gainsDeps({ activatedError: new Error('CALL_EXCEPTION') }))
    expect(res.status).toBe(VENUE_STATUS.UNREADABLE)
    expect(canOpen(res)).toBe(false)
  })

  it('is unreadable for a trading state it cannot map, and reports the raw value', async () => {
    const res = await readGainsStatus(ARBITRUM, gainsDeps({ activated: 7n }))
    expect(res.status).toBe(VENUE_STATUS.UNREADABLE)
    expect(res.raw).toBe('7')
  })

  it('keeps the status when only the auxiliary timeout read fails', async () => {
    const res = await readGainsStatus(
      ARBITRUM,
      gainsDeps({ activated: 1n, timeoutError: new Error('rpc hiccup') }),
    )
    expect(res.status).toBe(VENUE_STATUS.CLOSE_ONLY)
    expect(res.timeoutBlocks).toBeNull()
  })

  it('never rejects, whatever it is handed', async () => {
    await expect(readGainsStatus(undefined, gainsDeps())).resolves.toBeTruthy()
    await expect(readGainsStatus('not-a-chain', gainsDeps())).resolves.toBeTruthy()
    await expect(
      readGainsStatus(ARBITRUM, {
        getProvider: () => ({}),
        makeContract: () => {
          throw new Error('bad abi')
        },
      }),
    ).resolves.toMatchObject({ status: VENUE_STATUS.UNREADABLE })
  })
})

describe('readGmxStatus — Arbitrum only, and the pinned addresses must be live', () => {
  it('is open when both the ExchangeRouter and the Router have code', async () => {
    const res = await readGmxStatus(ARBITRUM, gmxDeps())
    expect(res.status).toBe(VENUE_STATUS.OPEN)
    expect(canOpen(res)).toBe(true)
  })

  it('reports not-deployed off Arbitrum instead of pretending it failed to read', async () => {
    for (const chainId of [1, 8453, 137, 10]) {
      const res = await readGmxStatus(chainId, gmxDeps())
      expect(res.status).toBe(VENUE_STATUS.NOT_DEPLOYED)
      expect(canOpen(res)).toBe(false)
    }
  })

  it('refuses opening when the APPROVAL target has no code — a stale pin, named', async () => {
    const res = await readGmxStatus(ARBITRUM, gmxDeps({ routerCode: '0x' }))
    expect(res.status).toBe(VENUE_STATUS.UNREADABLE)
    expect(res.detail).toMatch(/Router/)
    expect(canOpen(res)).toBe(false)
  })

  it('names both fund-path addresses when neither has code', async () => {
    const res = await readGmxStatus(ARBITRUM, gmxDeps({ code: '0x' }))
    expect(res.detail).toMatch(/ExchangeRouter and Router/)
  })

  it('is unreadable when the code read fails or there is no provider', async () => {
    expect((await readGmxStatus(ARBITRUM, gmxDeps({ getCodeError: new Error('timeout') }))).status).toBe(
      VENUE_STATUS.UNREADABLE,
    )
    expect((await readGmxStatus(ARBITRUM, gmxDeps({ provider: null }))).status).toBe(
      VENUE_STATUS.UNREADABLE,
    )
  })

  it('has no timeout concept of its own', async () => {
    expect((await readGmxStatus(ARBITRUM, gmxDeps())).timeoutBlocks).toBeNull()
  })
})

describe('readVenueStatuses — per-venue isolation', () => {
  it('returns one entry per readable venue, in a stable shape', async () => {
    const statuses = await readVenueStatuses(ARBITRUM, {
      readers: {
        gains: () => readGainsStatus(ARBITRUM, gainsDeps()),
        gmx: () => readGmxStatus(ARBITRUM, gmxDeps()),
      },
    })
    expect(Object.keys(statuses)).toEqual([...STATUS_VENUE_IDS])
    expect(statuses.gains.status).toBe(VENUE_STATUS.OPEN)
    expect(statuses.gmx.status).toBe(VENUE_STATUS.OPEN)
    expect(statuses.gains.label).toBe('Gains Network')
    expect(statuses.gains.manageable).toBe(true)
  })

  it('never lets Hyperliquid appear — it stays read-only this release', async () => {
    const statuses = await readVenueStatuses(ARBITRUM, {
      readers: { gains: () => readGainsStatus(ARBITRUM, gainsDeps()), gmx: () => readGmxStatus(ARBITRUM, gmxDeps()) },
    })
    expect(statuses.hyperliquid).toBeUndefined()
  })

  it('a REJECTING venue reader leaves the other venue intact', async () => {
    const statuses = await readVenueStatuses(ARBITRUM, {
      readers: {
        gains: () => Promise.reject(new Error('gains rpc exploded')),
        gmx: () => readGmxStatus(ARBITRUM, gmxDeps()),
      },
    })
    expect(statuses.gains.status).toBe(VENUE_STATUS.UNREADABLE)
    expect(statuses.gains.detail).toMatch(/exploded/)
    expect(statuses.gmx.status).toBe(VENUE_STATUS.OPEN)
    expect(canOpen(statuses.gmx)).toBe(true)
  })

  it('a THROWING venue reader leaves the other venue intact', async () => {
    const statuses = await readVenueStatuses(ARBITRUM, {
      readers: {
        gains: () => readGainsStatus(ARBITRUM, gainsDeps({ activated: 1n })),
        gmx: () => {
          throw new Error('synchronous boom')
        },
      },
    })
    expect(statuses.gains.status).toBe(VENUE_STATUS.CLOSE_ONLY)
    expect(statuses.gmx.status).toBe(VENUE_STATUS.UNREADABLE)
  })

  it('a venue reader returning junk is unreadable, not open', async () => {
    const statuses = await readVenueStatuses(ARBITRUM, {
      readers: { gains: () => Promise.resolve(null), gmx: () => Promise.resolve(undefined) },
    })
    expect(statuses.gains.status).toBe(VENUE_STATUS.UNREADABLE)
    expect(statuses.gmx.status).toBe(VENUE_STATUS.UNREADABLE)
  })

  it('marks a venue this build cannot manage on the chain as not manageable', async () => {
    // GMX has no calldata path off Arbitrum, and Base carries Gains only.
    const statuses = await readVenueStatuses(8453, {
      readers: { gains: () => readGainsStatus(8453, gainsDeps()), gmx: () => readGmxStatus(8453, gmxDeps()) },
    })
    expect(statuses.gains.manageable).toBe(true)
    expect(statuses.gmx.manageable).toBe(false)
    expect(statuses.gmx.status).toBe(VENUE_STATUS.NOT_DEPLOYED)
  })

  it('never rejects even when every reader fails', async () => {
    await expect(
      readVenueStatuses(ARBITRUM, {
        readers: {
          gains: () => Promise.reject(new Error('a')),
          gmx: () => Promise.reject(new Error('b')),
        },
      }),
    ).resolves.toMatchObject({
      gains: { status: VENUE_STATUS.UNREADABLE },
      gmx: { status: VENUE_STATUS.UNREADABLE },
    })
  })
})

describe('canOpen — fails closed on entry', () => {
  it('permits opening in exactly one state', () => {
    expect(canOpen(VENUE_STATUS.OPEN)).toBe(true)
    for (const status of [
      VENUE_STATUS.CLOSE_ONLY,
      VENUE_STATUS.PAUSED,
      VENUE_STATUS.NOT_DEPLOYED,
      VENUE_STATUS.UNREADABLE,
    ]) {
      expect(canOpen(status)).toBe(false)
    }
  })

  it('refuses a status it has never heard of, and junk', () => {
    expect(canOpen('probably-fine')).toBe(false)
    expect(canOpen(null)).toBe(false)
    expect(canOpen(undefined)).toBe(false)
    expect(canOpen({})).toBe(false)
    expect(canOpen(0)).toBe(false)
  })

  it('accepts a result object as well as a bare status', async () => {
    const res = await readGainsStatus(ARBITRUM, gainsDeps({ activated: 0n }))
    expect(canOpen(res)).toBe(true)
  })
})

describe('canClose / canReduce — open on exit', () => {
  it('close-only permits closing and reducing but not opening', () => {
    expect(canOpen(VENUE_STATUS.CLOSE_ONLY)).toBe(false)
    expect(canClose(VENUE_STATUS.CLOSE_ONLY)).toBe(true)
    expect(canReduce(VENUE_STATUS.CLOSE_ONLY)).toBe(true)
  })

  it('an UNREADABLE venue blocks opening but not the attempt to close', () => {
    expect(canOpen(VENUE_STATUS.UNREADABLE)).toBe(false)
    expect(canClose(VENUE_STATUS.UNREADABLE)).toBe(true)
  })

  it('paused permits neither at the venue', () => {
    expect(canOpen(VENUE_STATUS.PAUSED)).toBe(false)
    expect(canClose(VENUE_STATUS.PAUSED)).toBe(false)
  })
})

describe('exitAvailability — the exit control is never withdrawn', () => {
  it('offers the exit in EVERY status, including paused and unreadable', () => {
    const statuses = [...Object.values(VENUE_STATUS), 'a-status-from-the-future', null, undefined]
    for (const status of statuses) {
      expect(exitAvailability(status).offer).toBe(true)
    }
  })

  it('says honestly when the venue is likely to refuse, without hiding the control', () => {
    const paused = exitAvailability(VENUE_STATUS.PAUSED)
    expect(paused.offer).toBe(true)
    expect(paused.venueWillAccept).toBe(false)
    expect(paused.note).toMatch(/paused/i)

    const open = exitAvailability(VENUE_STATUS.OPEN)
    expect(open.venueWillAccept).toBe(true)
    expect(open.note).toBeNull()
  })
})

describe('openBlockedNote — the venue is named as the source', () => {
  it('is null when opening is available', () => {
    expect(openBlockedNote(VENUE_STATUS.OPEN, 'Gains Network')).toBeNull()
  })

  it('names the venue and preserves the exit in close-only', () => {
    const note = openBlockedNote(VENUE_STATUS.CLOSE_ONLY, 'Gains Network')
    expect(note).toMatch(/Gains Network/)
    expect(note).toMatch(/close or reduce/i)
  })

  it('says the status could not be confirmed rather than inventing a venue reason', () => {
    expect(openBlockedNote(VENUE_STATUS.UNREADABLE, 'GMX')).toMatch(/could not be confirmed/i)
  })

  it('falls back to a neutral subject rather than "undefined"', () => {
    expect(openBlockedNote(VENUE_STATUS.PAUSED)).toMatch(/^This venue/)
  })
})

describe('spec 069 — providers are never hand-built', () => {
  it('resolves read connections through the chain seam only', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8')
    // Spec 110 Phase 1: the spec-069 seam for reads is lib/chains — getPublicClient resolves
    // the member's endpoint, headers and failover through resolveRpcEndpoints exactly as
    // utils/rpcProvider did for ethers reads.
    expect(source).toContain("from '../chains/publicClient'")
    // Comments stripped: the file header NAMES the forbidden pattern in order to warn about it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // A member's configured endpoint and failover are bypassed the moment either of these appears.
    expect(code).not.toMatch(/NETWORKS\[[^\]]*\]\s*\.\s*rpcUrl/)
    expect(code).not.toMatch(/new ethers\.JsonRpcProvider/)
    expect(code).not.toMatch(/createPublicClient/)
  })
})
