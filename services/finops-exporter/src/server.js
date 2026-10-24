/**
 * FairWins FinOps exporter — HTTP entrypoint (spec 089).
 *
 * Polls every catalogued revenue and cost source at its own interval and exposes them as Prometheus
 * metrics on LOOPBACK. Grafana Alloy, in the same network namespace, scrapes and remote_writes to
 * Grafana Cloud (research R10).
 *
 * Three properties that are not incidental:
 *
 *   READ-ONLY. There is no signer anywhere in this service and no write route. It reports on money
 *   and cannot move any (FR-026).
 *
 *   NOT PUBLIC. It binds 127.0.0.1 and nginx does not proxy it. It has no member-facing surface
 *   (FR-027).
 *
 *   A SCRAPE NEVER FAILS BECAUSE A VENDOR IS DOWN. /metrics serves the scheduler's last readings, so
 *   it is constant-time and cannot be stalled by a slow API. A 500 here would blank every panel,
 *   including the twenty-four that are fine (FR-007).
 *
 * Routes:
 *   GET /metrics             Prometheus exposition (loopback)
 *   GET /healthz             liveness
 *   GET /status              honest per-source states + config presence (never a secret value)
 *   GET /v1/finops/summary   totals with completeness verdicts, for humans and tests
 */
import express from 'express'
import { SOURCES, withinCohort, validateCatalogue } from '@fairwins/finops-catalogue'
import { loadConfig, describeConfig } from './config/index.js'
import { buildProviders } from './chain/providers.js'
import { createCursorStore } from './chain/logs.js'
import { configureSharedRateLimit } from './chain/rateLimit.js'
import { createRegistry } from './registry.js'
import { createScheduler } from './scheduler.js'
import { createBurnTracker } from './burnRate.js'
import { createFeeRouterCollector } from './collectors/feeRouter.js'
import { createMembershipCollector } from './collectors/membership.js'
import { createReferralCollector } from './collectors/referral.js'
import { createX402Collector } from './collectors/x402.js'
import { createPoolsCollector, emitPoolSeries, emitExecutorNonce } from './collectors/pools.js'
import { createGcpBillingCollector, emitGcpDetail } from './collectors/gcpBilling.js'
import { createCloudflareCollector, emitCloudflareUsage } from './collectors/cloudflare.js'
import { createQuickNodeCollector, emitQuickNodeUsage } from './collectors/quicknode.js'
import { createPinataCollector, emitPinataUsage } from './collectors/pinata.js'
import { createFlatSubscriptionCollector } from './collectors/flatSubscription.js'
import { createGatewayUsageCollector, emitGatewayUsage } from './collectors/gateway.js'
import { createFxReader } from './collectors/fx.js'
import { createExecutorNonceCollector } from './executorNonce.js'
import { aggregate } from './aggregate.js'

/** Lazily construct the BigQuery client so the dependency is not required to boot without GCP. */
async function defaultBigQuery(config) {
  if (!config.gcp.projectId) return null
  const { BigQuery } = await import('@google-cloud/bigquery')
  // Application Default Credentials: the node's own service account. No key file, no stored token.
  return new BigQuery({ projectId: config.gcp.projectId })
}

export function createApp(overrides = {}) {
  const config = overrides.config ?? loadConfig()
  const log = overrides.log ?? console.warn

  // The catalogue is validated at boot. An invalid entry is a build mistake that `check:finops`
  // should already have caught, so this logs loudly and continues rather than refusing to start —
  // one malformed entry must not take down the observability for everything else.
  const problems = validateCatalogue(SOURCES)
  if (problems.length) {
    log(`[finops] catalogue has ${problems.length} problem(s); run 'npm run check:finops':`)
    for (const p of problems) log(`[finops]   ${p}`)
  }

  // FR-008: only cohort sources are ever collected. A mainnet build has no provider for a testnet
  // chain and no source pinned to one, so testnet financial data cannot enter the same series.
  const sources = withinCohort(SOURCES, config.cohortChainIds)

  // Set BEFORE any collector runs: `scanLogs` reads the shared limiter per call, so configuring it
  // here covers collectors constructed below and the boot pass that follows (#1585).
  configureSharedRateLimit(config.rpcMaxPerSec)

  const providers = overrides.providers ?? buildProviders(config, { log })
  const cursors = createCursorStore()
  const burn = createBurnTracker()
  const fx = overrides.fx ?? createFxReader({ config, providers, log })

  const gcpBilling = createGcpBillingCollector({
    config,
    bigQuery: overrides.bigQuery ?? (() => defaultBigQuery(config)),
    log,
  })
  const cloudflare = createCloudflareCollector({ config, fetchImpl: overrides.fetchImpl, log })
  const quicknode = createQuickNodeCollector({ config, fetchImpl: overrides.fetchImpl, log })
  const pinata = createPinataCollector({ config, fetchImpl: overrides.fetchImpl, log })
  const gatewayUsage = createGatewayUsageCollector({ config, fetchImpl: overrides.fetchImpl })

  // The executor's nonce, read on the pools schedule (#1539). Its state is shared with the emitter
  // rather than re-read at render time, because buildRegistry is synchronous.
  const nonceState = new Map()
  const executorNonce = overrides.executorNonce ?? createExecutorNonceCollector({ config, providers })

  const collectors = {
    feeRouter: createFeeRouterCollector({ config, providers, cursors, log }),
    membership: createMembershipCollector({ config, providers, cursors, log }),
    referral: createReferralCollector({ config, fetchImpl: overrides.fetchImpl }),
    x402: createX402Collector({ config, providers, cursors, log }),
    pools: createPoolsCollector({ config, providers, burn, executorNonce, nonceState }),
    gcpBilling,
    cloudflare,
    quicknode,
    pinata,
    flatSubscription: createFlatSubscriptionCollector({ config }),
    gateway: gatewayUsage,
    /** `planned` sources never reach a collector, but a named one keeps the catalogue self-consistent. */
    none: async () => ({ state: 'not-configured', value: null, unit: null, at: Date.now(), labels: {}, reason: 'not yet live' }),
    ...overrides.collectors,
  }

  const scheduler = createScheduler({ sources, collectors, log, bootConcurrency: config.bootConcurrency })

  /** Build a fresh registry from the scheduler's current readings. */
  function buildRegistry() {
    const registry = createRegistry()
    const readings = scheduler.readings()

    registry.emit('info', 'gauge', 'Exporter build identity.', { ...config.build }, 1)

    for (const { source, reading, durationMs, lastSuccessAt } of readings) {
      // Prepaid pools opt out of the generic value emission: their Reading carries a BALANCE in a
      // native unit, while their catalogue metric is `cost_usd_total`. Letting record() emit it
      // would publish a balance labelled as a USD cost, with no `basis` — so a cost total would add
      // pool balances to actual spend. `emitPoolSeries` publishes the real series below.
      registry.record(source, reading, {}, { lastSuccessAt, emitValue: !source.pool })
      if (durationMs != null) {
        registry.emit(
          'collection_duration_seconds',
          'gauge',
          'How long a source took to collect. The exporter watching its own cost of watching.',
          { source: source.id },
          durationMs / 1000,
        )
      }
    }

    // Series that are functions of several readings, or of a collector's side detail.
    emitPoolSeries(registry, readings, burn, (unit) => fx.rateFor(unit))
    emitExecutorNonce(registry, nonceState)
    fx.emit(registry)

    for (const { source } of readings) {
      if (source.collector === 'gcpBilling') emitGcpDetail(registry, gcpBilling, source)
      if (source.collector === 'cloudflare') emitCloudflareUsage(registry, cloudflare, source)
      if (source.collector === 'quicknode') emitQuickNodeUsage(registry, quicknode, source)
      if (source.collector === 'pinata') emitPinataUsage(registry, pinata, source)
      if (source.collector === 'gateway') emitGatewayUsage(registry, gatewayUsage, source)
    }

    return { registry, readings }
  }

  const app = express()
  app.disable('x-powered-by')

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }))

  app.get('/metrics', (_req, res) => {
    const { registry } = buildRegistry()
    res.set('content-type', 'text/plain; version=0.0.4; charset=utf-8')
    res.send(registry.render())
  })

  app.get('/status', (_req, res) => {
    const readings = scheduler.readings()
    res.json({
      status: 'ok',
      build: config.build,
      // Presence booleans only — never any part of a credential (FR-025).
      config: describeConfig(config),
      sources: readings.map(({ source, reading, stale }) => ({
        id: source.id,
        kind: source.kind,
        status: source.status,
        state: reading.state,
        stale,
        // `reason` is redacted at construction; it is safe to serve on a loopback-only surface.
        reason: reading.reason,
      })),
    })
  })

  app.get('/v1/finops/summary', (_req, res) => {
    const readings = scheduler.readings()
    res.json({
      at: new Date().toISOString(),
      ...aggregate(readings, { rateFor: (u) => fx.rateFor(u) }),
    })
  })

  return { app, config, scheduler, fx, burn, buildRegistry, collectors }
}

/**
 * Boot.
 *
 * LISTEN FIRST, COLLECT SECOND. The first scrape being thin is a cosmetic cost paid once; the
 * listener being hostage to a fan-out across every vendor and two chains is an availability cost
 * paid forever. This used to `await scheduler.collectAll()` before `app.listen()`, and that put the
 * one surface which REPORTS failures behind the success of the things it reports on: a single slow
 * or hanging collector left the port closed, the health check failing, and every panel blank — with
 * no metric anywhere able to say why, because the exporter is what publishes metrics.
 *
 * Measured, on this estate: that boot collection did not finish in 6m40s and had grown to 2.6 GB.
 * The container's 192 MB ceiling turned it into an OOM kill 45 seconds in, restarting forever.
 *
 * Nothing is lost by serving early. The scheduler answers `unreadable('not collected yet')` for a
 * source it has not reached, which is the honest state and exactly what the Source health panel
 * exists to render — as opposed to a closed port, which renders as nothing at all.
 */
export async function start() {
  const { app, config, scheduler, fx } = createApp()

  const server = await new Promise((resolve) => {
    const s = app.listen(config.port, config.host, () => {
      console.log(`[finops] exporter listening on ${config.host}:${config.port} (cohort ${config.build.cohort})`)
      resolve(s)
    })
  })

  // FX is refreshed on the fastest source interval; a rate older than its max age stops being used
  // rather than being silently applied (FR-013).
  fx.refresh().catch((err) => console.warn(`[finops] fx: initial refresh failed — ${err?.message ?? err}`))
  setInterval(() => fx.refresh().catch(() => {}), 60_000).unref?.()

  // Periodic collection starts NOW, not after the first pass returns. Sequencing the intervals
  // behind `collectAll()` would hand the same hostage problem to a different victim: one collector
  // that never settles would mean no source is ever polled again. The scheduler's in-flight guard
  // makes the overlap safe — a tick that arrives while a source is still collecting is dropped.
  scheduler.start()

  // The first pass is a warm-up, and its failure is a logged fact rather than a dead process:
  // `attempt()` has already turned every collector throw into an `unreadable` Reading, so a
  // rejection here would mean a bug in the scheduler itself.
  scheduler
    .collectAll()
    .catch((err) => console.warn(`[finops] initial collection failed — ${err?.message ?? err}`))

  return server
}

// `node src/server.js` boots; importing it for tests does not.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error('[finops] failed to start:', err)
    process.exit(1)
  })
}
