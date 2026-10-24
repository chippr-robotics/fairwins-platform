/**
 * Grafana panel builders (spec 089).
 *
 * Dashboards are GENERATED from the catalogue rather than hand-written. Two reasons, and the second
 * is the important one:
 *
 *   1. 2,000 lines of hand-written dashboard JSON is 2,000 lines nobody diffs.
 *   2. It makes the coverage gate WRITABLE. "Every catalogued source has a panel" is a property you
 *      can only check cheaply if the panels are a function of the catalogue — otherwise the gate has
 *      to parse hand-authored JSON and guess at intent.
 *
 * Every query in this file encodes a rule from contracts/metrics.md. The comments say which, because
 * these expressions look like ordinary PromQL and are not: several of them are shaped specifically
 * to make a missing input produce NO SAMPLE rather than a zero.
 */

const DATASOURCE = { type: 'prometheus', uid: '${datasource}' }

let nextId = 1
export const resetIds = () => {
  nextId = 1
}

function panel(base) {
  return { id: nextId++, datasource: DATASOURCE, ...base }
}

/** Money, with the honest-state overrides that make "no data" readable as "no data". */
function moneyFieldConfig(unit = 'currencyUSD') {
  return {
    defaults: {
      unit,
      decimals: 2,
      /**
       * A panel with no series must SAY so. Grafana's default renders an empty panel, which on a
       * revenue dashboard is indistinguishable from a panel reporting nothing earned.
       *
       * It must also NOT pretend the two absences are one thing. `noValue` is fixed at generate
       * time and cannot read the runtime state, so the honest move is to stop asserting which of
       * them this is and point at the panel that knows — which is why every dashboard now carries
       * a Source health table, not just the overview. Collapsing `unreadable` and `not-configured`
       * into one sentence is the exact distinction spec 089 exists to draw: one is a vendor to fix,
       * the other is a feature nobody wired, and they are not the same call to make at 2am.
       */
      noValue: 'no value published — see “Source health” for whether this is unreadable or not-configured',
      color: { mode: 'thresholds' },
      thresholds: { mode: 'absolute', steps: [{ color: 'text', value: null }] },
    },
    overrides: [],
  }
}

/** The headline revenue/cost/net row. */
export function statPanel({ title, expr, unit = 'currencyUSD', gridPos, description }) {
  return panel({
    type: 'stat',
    title,
    description,
    gridPos,
    fieldConfig: moneyFieldConfig(unit),
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      textMode: 'value_and_name',
      graphMode: 'area',
    },
    targets: [{ refId: 'A', expr, datasource: DATASOURCE, legendFormat: '{{unit}}' }],
  })
}

/**
 * The partial-total banner (FR-011).
 *
 * Counts LIVE sources of a kind that are configured but not up. Non-zero means every total for that
 * kind is understated, and the table beside it names which ones. This is the panel that turns
 * "the number is wrong" into "the number is missing Cloudflare".
 */
export function partialTotalPanel({ kind, gridPos }) {
  return panel({
    type: 'table',
    title: `${kind === 'revenue' ? 'Revenue' : kind === 'usage' ? 'Usage' : 'Cost'} totals — sources currently MISSING`,
    description:
      `Any row here means the ${kind} total above is PARTIAL and understated. An empty table means every live ` +
      `${kind} source was read. Sources that are merely not-configured are excluded on purpose: they are unwired ` +
      `features, not missing data.`,
    gridPos,
    fieldConfig: {
      defaults: { noValue: 'all live sources reporting', custom: { align: 'auto' } },
      overrides: [],
    },
    options: { showHeader: true },
    targets: [
      {
        refId: 'A',
        format: 'table',
        instant: true,
        datasource: DATASOURCE,
        // configured==1 AND up==0 is exactly `unreadable`. `unless` removes the healthy ones.
        expr: `fairwins_finops_source_configured{kind="${kind}",status="live"} == 1 unless on(source) fairwins_finops_source_up == 1`,
      },
    ],
  })
}

/** A per-source timeseries. `status` decides whether it can show a value at all. */
export function sourcePanel({ source, gridPos }) {
  // A planned source has no metric by construction (FR-014). Its panel shows the fact, not a zero.
  if (source.status === 'planned') {
    return panel({
      type: 'text',
      title: `${source.label} — NOT YET LIVE`,
      gridPos,
      options: {
        mode: 'markdown',
        content:
          `**Not yet live.** This source is declared, and produces no value on any current deployment, so it ` +
          `is excluded from every total. That covers two different situations — a path that does not exist ` +
          `anywhere, and one that is built but switched off — and the text below says which this is.` +
          `\n\n${source.meaning}`,
      },
    })
  }

  // A usage source is a COUNTER consumed as a rate, and its interesting axes are its bounded
  // labels (tier, upstream) — never a currency. Rendering it through the money branch below would
  // legend by a unit it does not have and plot a cumulative ramp nobody can read.
  if (source.kind === 'usage') {
    return panel({
      type: 'timeseries',
      title: source.label,
      description: source.meaning,
      gridPos,
      fieldConfig: moneyFieldConfig('short'),
      options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
      targets: [
        {
          refId: 'A',
          datasource: DATASOURCE,
          expr: `sum by (tier) (rate(${source.metric}{source="${source.id}",metric="tier_requests"}[10m]))`,
          legendFormat: 'tier {{tier}}',
        },
        {
          refId: 'B',
          datasource: DATASOURCE,
          expr: `sum by (upstream) (rate(${source.metric}{source="${source.id}",metric="upstream_calls"}[10m]))`,
          legendFormat: 'upstream {{upstream}}',
        },
      ],
    })
  }

  const isCost = source.kind === 'cost'
  return panel({
    type: 'timeseries',
    title: source.label + (isCost && source.basis === 'modelled' ? ' (modelled)' : ''),
    description: source.meaning,
    gridPos,
    fieldConfig: moneyFieldConfig(source.unit === 'USD' ? 'currencyUSD' : 'short'),
    options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    targets: [
      {
        refId: 'A',
        datasource: DATASOURCE,
        expr: `${source.metric}{source="${source.id}"}`,
        legendFormat: `{{unit}}${isCost ? ' ({{basis}})' : ''}`,
      },
    ],
  })
}

/**
 * The honest-state table — every source, its three-state verdict, and how old its data is.
 *
 * This is the panel that makes the whole dashboard trustworthy: it is where an operator confirms
 * that a zero somewhere else is a real zero.
 */
export function healthPanel({ gridPos, kind = null }) {
  // Scoped to one kind on the detail dashboards. A "no data" panel is only readable NEXT TO the
  // thing that says which absence it is, and sending the reader to another dashboard to find that
  // out is how a source sits broken for weeks looking exactly like one that is merely unwired.
  const selector = kind ? `{kind="${kind}"}` : ''
  return panel({
    type: 'table',
    title: `Source health${kind ? ` — ${kind} sources` : ''} — read / unreadable / not-configured`,
    description:
      'configured=1 & up=1 → read. configured=1 & up=0 → UNREADABLE (a real problem). configured=0 → not-configured ' +
      '(a feature that has not been wired up; not an outage). This is the panel that tells you which of those a ' +
      'blank panel above is: they look identical everywhere else, and they are not the same thing to act on.',
    gridPos,
    fieldConfig: { defaults: { custom: { align: 'auto' } }, overrides: [] },
    options: { showHeader: true },
    targets: [
      { refId: 'A', format: 'table', instant: true, datasource: DATASOURCE, expr: `fairwins_finops_source_configured${selector}` },
      { refId: 'B', format: 'table', instant: true, datasource: DATASOURCE, expr: `fairwins_finops_source_up${selector}` },
      {
        refId: 'C',
        format: 'table',
        instant: true,
        datasource: DATASOURCE,
        expr: kind
          ? `time() - (fairwins_finops_source_last_success_timestamp_seconds and on(source) fairwins_finops_source_configured{kind="${kind}"})`
          : 'time() - fairwins_finops_source_last_success_timestamp_seconds',
      },
    ],
  })
}

/**
 * Prepaid-pool runway (FR-015).
 *
 * Queries `pool_runway_seconds` DIRECTLY rather than dividing balance by burn rate in PromQL. The
 * exporter deliberately omits that series when runway is unknowable, and a division done here would
 * resurrect the `+Inf` the exporter went out of its way not to emit.
 */
export function runwayPanel({ gridPos }) {
  return panel({
    type: 'timeseries',
    title: 'Prepaid pool runway',
    description:
      'Projected seconds until each prepaid pool empties, at the trailing burn rate. A pool with NO LINE has an ' +
      'unknown runway (zero or unmeasured burn) — that is not the same as a long runway, and it is why this panel ' +
      'reads the exporter series instead of dividing balance by burn here.',
    gridPos,
    fieldConfig: {
      defaults: {
        unit: 's',
        noValue: 'runway unknown — check pool balance and source health',
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'red', value: null },
            { color: 'orange', value: 72 * 3600 },
            { color: 'green', value: 7 * 86400 },
          ],
        },
      },
      overrides: [],
    },
    options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    targets: [{ refId: 'A', datasource: DATASOURCE, expr: 'fairwins_finops_pool_runway_seconds', legendFormat: '{{pool}}' }],
  })
}

export function poolBalancePanel({ gridPos }) {
  return panel({
    type: 'timeseries',
    title: 'Prepaid pool balances',
    description: 'Native-unit balance of each prepaid pool. Never summed across units.',
    gridPos,
    fieldConfig: { defaults: { unit: 'short', noValue: 'no data — pool unreadable' }, overrides: [] },
    options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    targets: [{ refId: 'A', datasource: DATASOURCE, expr: 'fairwins_finops_pool_balance', legendFormat: '{{pool}} ({{unit}})' }],
  })
}

/**
 * Unit economics (FR-012).
 *
 * The `and on()` guard is load-bearing: without it a failed op-count read makes the numerator
 * divide by an absent series and the panel shows nothing — or worse, a stale denominator produces a
 * confident wrong number. With it, the ratio simply does not exist unless BOTH inputs were read.
 */
export function kpiPanel({ title, numerator, denominator, guardSources, unit, gridPos, description }) {
  const guard = guardSources.map((s) => `(fairwins_finops_source_up{source="${s}"} == 1)`).join(' and on() ')
  return panel({
    type: 'stat',
    title,
    description,
    gridPos,
    fieldConfig: {
      defaults: {
        unit,
        decimals: 6,
        noValue: 'not computed — an input was unavailable',
      },
      overrides: [],
    },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, textMode: 'value' },
    targets: [
      {
        refId: 'A',
        datasource: DATASOURCE,
        expr: `(${numerator}) / (${denominator}) and on() ${guard}`,
      },
    ],
  })
}

/** FX provenance (FR-013): every converted figure must be auditable back to a rate and its age. */
export function fxPanel({ gridPos }) {
  return panel({
    type: 'table',
    title: 'FX rate provenance',
    description:
      'The rate used for every USD conversion on this dashboard, its source, and its age. A conversion made from ' +
      'a stale rate is visibly stale here rather than silently applied.',
    gridPos,
    fieldConfig: { defaults: { custom: { align: 'auto' } }, overrides: [] },
    options: { showHeader: true },
    targets: [
      { refId: 'A', format: 'table', instant: true, datasource: DATASOURCE, expr: 'fairwins_finops_fx_rate' },
      { refId: 'B', format: 'table', instant: true, datasource: DATASOURCE, expr: 'fairwins_finops_fx_age_seconds' },
    ],
  })
}

/** Header text panel — the dashboard says out loud what its numbers do and do not mean. */
export function headerPanel({ gridPos, content }) {
  return panel({ type: 'text', title: '', gridPos, options: { mode: 'markdown', content } })
}
