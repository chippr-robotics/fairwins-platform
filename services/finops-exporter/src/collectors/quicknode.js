/**
 * QuickNode collector, and the flat-subscription modeller (spec 089, FR-005; research R1 + R3).
 *
 * ⚠ QUICKNODE REPORTS CREDITS, NOT DOLLARS. `GET /v0/usage/rpc` on the Admin API returns API-credit
 * consumption. Credits convert to dollars through plan-specific pricing, and on a Flat Rate RPS plan
 * spend is decoupled from usage entirely — the bill is the same whether we send one request or a
 * billion. So:
 *
 *   - credit usage is emitted as measured VENDOR USAGE (a fact);
 *   - the dollar figure is `basis="modelled"`, and which model applies depends on the plan:
 *       metered  → credits x FINOPS_QUICKNODE_USD_PER_MCREDIT
 *       flat RPS → FINOPS_QUICKNODE_PLAN_USD, with credits informational only.
 *
 * This collector reads QUICKNODE ONLY. The flat-subscription modeller it used to also host now
 * lives in `flatSubscription.js`: at four sources, a module named for one vendor was reporting
 * `QUICKNODE_API_KEY is not set` for vendors QuickNode has nothing to do with.
 */
import { read, notConfigured, unreadable } from '../reading.js'

export function createQuickNodeCollector({ config, fetchImpl = fetch, log = console.warn }) {
  /** @type {number|null} */
  let lastCredits = null
  /** @type {{remaining: number|null, limit: number|null}|null} */
  let lastQuota = null

  async function readCredits() {
    const { apiKey, endpoint, prometheusUrl } = config.quicknode

    // Prefer the Prometheus exporter when the plan includes it (research R3): it is the vendor's own
    // metrics rather than our parse of a JSON shape they may change.
    if (prometheusUrl) {
      const res = await fetchImpl(prometheusUrl, { headers: apiKey ? { 'x-api-key': apiKey } : {} })
      if (!res.ok) throw new Error(`quicknode prometheus HTTP ${res.status}`)
      const text = await res.text()
      const m = /^quicknode_api_credits_used(?:\{[^}]*\})?\s+([0-9.eE+-]+)$/m.exec(text)
      if (!m) throw new Error('quicknode prometheus response had no credit metric')
      return Number(m[1])
    }

    if (!apiKey) return null

    const res = await fetchImpl(`${endpoint}/usage/rpc`, {
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`quicknode admin API HTTP ${res.status}`)

    const body = await res.json()

    /**
     * THE VENDOR ANSWERS ERRORS WITH HTTP 200 AND AN `error` FIELD, so `res.ok` above proves only
     * that the request arrived. Reported verbatim (through the Reading's redactor), because the
     * generic "no recognisable credit field" below is a true statement that sends the reader to
     * the wrong place: this estate spent weeks with the key wired and a message that read like a
     * parser bug when the vendor was plainly saying something specific about the account.
     */
    if (body?.error) {
      const detail = typeof body.error === 'string' ? body.error : JSON.stringify(body.error)
      throw new Error(`quicknode admin API returned an error: ${detail}`)
    }

    /**
     * THE REAL SHAPE, observed against the live Admin API on 2026-09-12:
     *
     *   { data: { start_time, end_time, credits_used, credits_remaining, limit, overages }, error: null }
     *
     * `data.credits_used` is the field. None of the five names this previously guessed
     * (`data.credits`, `credits`, `usage.credits`, `data.apiCredits`, `apiCredits`) exist, so the
     * source reported `unreadable` for its entire life with a message that read like a parser bug —
     * which it was, but of the "we never checked" kind rather than the "they changed it" kind. The
     * guesses are kept behind the real name: they cost nothing, and the docs still do not pin this.
     *
     * An UNRECOGNISED shape stays an error, never a zero. A zero would report "no RPC usage" for an
     * estate that is definitely making RPC calls.
     */
    const credits =
      body?.data?.credits_used ??
      body?.data?.credits ??
      body?.credits ??
      body?.usage?.credits ??
      body?.data?.apiCredits ??
      body?.apiCredits
    if (typeof credits !== 'number' || !Number.isFinite(credits)) {
      const nested = body?.data && typeof body.data === 'object' ? ` data:{${Object.keys(body.data).join(',')}}` : ''
      // Name the NESTED keys too. The old message said `keys: data,error` — true, and useless:
      // it described the envelope while the answer was one level down.
      throw new Error(
        `quicknode usage response had no recognisable credit field (keys: ${Object.keys(body ?? {}).join(',')}${nested})`,
      )
    }

    // The plan's own headroom, which the same response carries for free. Not a dollar and not a
    // guess — `credits_remaining` against `limit` is the one thing that says whether the 50 req/s
    // ceiling this account keeps hitting is a rate problem or a quota problem. They are different
    // failures and they are fixed differently.
    lastQuota = {
      remaining: typeof body?.data?.credits_remaining === 'number' ? body.data.credits_remaining : null,
      limit: typeof body?.data?.limit === 'number' ? body.data.limit : null,
    }

    return credits
  }

  async function collectQuickNode(_source) {
    const { planMonthlyUsd, usdPerMillionCredits } = config.quicknode

    let credits
    try {
      credits = await readCredits()
    } catch (err) {
      return unreadable(err?.message ?? err)
    }

    if (credits == null) return notConfigured('QUICKNODE_API_KEY (or QUICKNODE_PROMETHEUS_URL) is not set')
    lastCredits = credits

    // Metered plan: cost tracks usage.
    if (usdPerMillionCredits != null) {
      return read((credits / 1_000_000) * usdPerMillionCredits, 'USD', { labels: { basis: 'modelled' } })
    }
    // Flat Rate RPS: the subscription is the cost, and credits are informational.
    if (planMonthlyUsd != null) {
      return read(planMonthlyUsd, 'USD', { labels: { basis: 'modelled' } })
    }

    log('[finops] quicknode: credits read, but neither plan price nor credit rate is set — no cost modelled')
    return notConfigured('credits available; set FINOPS_QUICKNODE_PLAN_USD or FINOPS_QUICKNODE_USD_PER_MCREDIT to model a cost')
  }

  collectQuickNode._lastCredits = () => lastCredits
  collectQuickNode._lastQuota = () => lastQuota

  return collectQuickNode
}

/**
 * Emit measured credit consumption — the part of the QuickNode picture that is not a model.
 *
 * Only `quicknode` names this collector now, which is what makes this emitter safe again. It
 * previously served three sources — the other two reused the flat-subscription modeller that lived
 * here — and published QuickNode's credit count under `source="grafana-cloud"` and
 * `source="alphaday-news-api"`: one vendor's measured usage attributed to two that publish none.
 * Latent only because credits never read successfully here; it would have become a fabricated fact
 * the day QuickNode started answering. Splitting the modeller out removes the class, not the symptom.
 */
export function emitQuickNodeUsage(registry, collector, source) {
  const credits = collector._lastCredits?.()
  if (credits == null) return
  const emit = (metric, value) => {
    // `null` means the vendor did not return that field — skipped, never zeroed. A 0 here would
    // read as "no credits left", which is the opposite of "we could not see how many".
    if (value == null) return
    registry.emit(
      'vendor_usage',
      'gauge',
      'Raw vendor usage over the trailing window. Measured, unlike the modelled dollar figure beside it.',
      { source: source.id, metric },
      value,
    )
  }
  emit('api_credits', credits)
  const quota = collector._lastQuota?.()
  emit('api_credits_remaining', quota?.remaining)
  emit('api_credits_limit', quota?.limit)
}
