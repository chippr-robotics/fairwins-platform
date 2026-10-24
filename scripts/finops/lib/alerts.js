/**
 * Grafana alert rules, generated from the catalogue (spec 089, FR-015…FR-018).
 *
 * The estate's existing alerting is entirely about liveness — uptime checks, VM CPU, VM disk. Not
 * one alert is about money. These are.
 *
 * THREE RULES SHAPE EVERY DEFINITION HERE:
 *
 *   1. RUNWAY, NOT BALANCE (FR-015). A balance floor is only correct at the burn rate it was chosen
 *      for; at 10x traffic a "safe" floor is minutes of warning. Alerting on projected runway keeps
 *      the threshold meaningful with nobody editing a number.
 *
 *   2. STALENESS IS ITS OWN ALERT AND NEVER RESOLVES A VALUE ALERT (FR-016). A balance that cannot
 *      be read is not a healthy balance. If a staleness alert could silence a runway alert, the
 *      worst case — we lost sight of the pool AND it is draining — would page nobody.
 *
 *   3. EVERY ALERT NAMES ITS RUNBOOK (FR-018). An alert that says what is wrong but not what to do
 *      gets acknowledged and forgotten.
 */

/**
 * A PLACEHOLDER, resolved by the provisioner against the live stack.
 *
 * It must NOT be `${datasource}`. That is a DASHBOARD template variable: correct on a panel, where
 * the viewer picks a datasource, and meaningless in an alert rule, which has no variable scope. A
 * rule provisioned with it cannot resolve a datasource at all, so its query returns nothing, and
 * `noDataState: Alerting` — which is deliberate and stays — turns that into a firing alert.
 *
 * Measured 2026-08-17, 17h after provisioning: ALL 29 rules were firing, every one of them a false
 * alarm, including both runway rules for pools that were perfectly healthy. An alert channel in that
 * state is worse than none, because the real one is now indistinguishable from the noise.
 *
 * It is also not hardcodable: the uid differs per stack (`grafanacloud-prom` here). So the committed
 * JSON carries this sentinel and `provision-grafana.js` substitutes the stack's real Prometheus uid
 * at push time, failing loudly if it cannot find one.
 */
export const DATASOURCE_PLACEHOLDER = '__PROM_DATASOURCE_UID__'
const DATASOURCE_UID = DATASOURCE_PLACEHOLDER
const RUNBOOK_BASE = 'https://github.com/chippr-robotics/fairwins-platform/blob/main/docs/runbooks/finops-operations.md'

/** A Grafana unified-alerting query stage. */
function query(refId, expr) {
  return {
    refId,
    relativeTimeRange: { from: 600, to: 0 },
    datasourceUid: DATASOURCE_UID,
    model: { refId, expr, instant: true, datasource: { type: 'prometheus', uid: DATASOURCE_UID } },
  }
}

/** Reduce + threshold stages. Grafana needs both; the threshold is what actually fires. */
function threshold(refId, input, evaluator) {
  return {
    refId,
    datasourceUid: '__expr__',
    model: {
      refId,
      type: 'threshold',
      expression: input,
      conditions: [{ evaluator, operator: { type: 'and' }, reducer: { type: 'last' } }],
      datasource: { type: '__expr__', uid: '__expr__' },
    },
  }
}

function rule({ uid, title, expr, evaluator, forDuration, severity, summary, runbookAnchor, labels = {}, noData = 'Alerting' }) {
  return {
    uid,
    title,
    condition: 'C',
    // NoData is ALERTING, not OK. A finance alert whose data disappeared is the case we most need to
    // hear about: "the series vanished" and "everything is fine" produce the same silence otherwise.
    noDataState: noData,
    execErrState: 'Alerting',
    for: forDuration,
    data: [query('A', expr), threshold('C', 'A', evaluator)],
    labels: { severity, team: 'finops', ...labels },
    annotations: {
      summary,
      runbook_url: `${RUNBOOK_BASE}#${runbookAnchor}`,
      // Grafana templates these at fire time, so the notification names the observed value rather
      // than making somebody open the dashboard to find out what tripped.
      description: `Observed: {{ $values.A }}. Rule: ${title}.`,
    },
  }
}

export function buildAlertRules(sources) {
  const rules = []

  // ── prepaid pools: runway (FR-015) ─────────────────────────────────────────────────────────
  //
  // Two tiers. Both read `pool_runway_seconds` directly — the exporter OMITS that series when runway
  // is unknowable, and NoData=Alerting is what turns that omission into a page instead of silence.
  rules.push(
    rule({
      uid: 'finops-pool-runway-critical',
      title: 'Prepaid pool runway under 24h',
      expr: 'min by (pool) (fairwins_finops_pool_runway_seconds)',
      evaluator: { type: 'lt', params: [86_400] },
      forDuration: '10m',
      severity: 'critical',
      /**
       * THE ONE PLACE NoData MUST NOT ALERT.
       *
       * The exporter deliberately omits `pool_runway_seconds` when runway is unknowable — zero burn
       * or too few samples — rather than emitting `+Inf`. With no gasless traffic the balances do not
       * move, burn is genuinely 0, and the series is absent for a perfectly healthy pool. Measured
       * 2026-08-17 after a 17h soak: no pool had a runway series, and both runway rules were firing.
       *
       * Escalating that is not conservatism, it is a permanent false alarm on an idle estate. The
       * genuinely dangerous case — we cannot READ the pool — is already covered by that pool's own
       * staleness rule (`configured=1, up=0`), which is a different rule with different data and
       * fires independently. This is the only rule here whose absent data means "nothing is
       * happening" rather than "we have lost sight of something".
       */
      noData: 'OK',
      summary:
        'A prepaid gas pool will be exhausted in under 24 hours at the current burn rate. When it empties, ' +
        'sponsorship or relaying STOPS and members see failures.',
      runbookAnchor: 'prepaid-pools',
    }),
    rule({
      uid: 'finops-pool-runway-warning',
      title: 'Prepaid pool runway under 72h',
      expr: 'min by (pool) (fairwins_finops_pool_runway_seconds)',
      evaluator: { type: 'lt', params: [72 * 3600] },
      forDuration: '30m',
      severity: 'warning',
      // Same reasoning as the critical rule above: absent runway means no measured burn, not a lost
      // pool. Unreadability is the staleness rule's job.
      noData: 'OK',
      summary: 'A prepaid gas pool will be exhausted in under 72 hours at the current burn rate. Top it up.',
      runbookAnchor: 'prepaid-pools',
    }),
  )

  // ── staleness, one per live source (FR-016) ────────────────────────────────────────────────
  //
  // Deliberately separate from every value alert above and below. These fire IN ADDITION, never
  // INSTEAD.
  for (const source of sources.filter((s) => s.status === 'live')) {
    rules.push(
      rule({
        uid: `finops-stale-${source.id}`,
        title: `FinOps source stale: ${source.label}`,
        /**
         * THIS EXPRESSION MUST ALWAYS PRODUCE A SAMPLE. That is the whole reason for its shape.
         *
         * The obvious form — `time() - last_success > N and on(source) configured == 1` — yields an
         * EMPTY vector for a source that has never been read successfully, because
         * `source_last_success_timestamp_seconds` is absent until the first success. Combined with
         * `noDataState: Alerting` (correct, and kept), empty means FIRING. So every legitimately
         * `not-configured` source — an unset vendor token, an unregistered referral code, a contract
         * address left blank — would page immediately and forever, which is precisely what FR-006
         * says must not happen and exactly how an alert channel gets muted.
         *
         * Both gauges here are emitted on every scrape for every live source, so the product always
         * has a value:
         *
         *   read            1 * (1 - 1) = 0   quiet
         *   unreadable      1 * (1 - 0) = 1   fires   <- the condition we want
         *   not-configured  0 * (1 - 0) = 0   quiet   <- an unwired feature is not an outage
         *
         * NoData now means something real and worth paging for: the exporter stopped being scraped
         * at all. `for: 15m` supplies the duration that `last_success` used to; the exact age is on
         * the Source health panel and at /status.
         */
        /**
         * `on(source)` IS LOAD-BEARING. The two gauges carry different label sets —
         * `source_configured{source,kind,status}` and `source_up{source,kind}` — so a bare multiply
         * finds no matching series and returns NOTHING, which noDataState escalates. Measured
         * 2026-08-17: the bare form returned 0 series where `on(source)` returns 23, correctly
         * flagging exactly the two unreadable sources.
         *
         * The `status` label only exists on `configured` (a `planned` source has no `up`), which is
         * precisely why the label sets cannot be made identical — so the join must be explicit.
         */
        expr:
          `fairwins_finops_source_configured{source="${source.id}"} * on(source) ` +
          `(1 - fairwins_finops_source_up{source="${source.id}"})`,
        evaluator: { type: 'gt', params: [0] },
        forDuration: '15m',
        severity: source.kind === 'cost' && source.collector === 'pools' ? 'critical' : 'warning',
        summary:
          `${source.label} is configured but could not be read for 15m. ` +
          `Its panels show no data; any total including it is PARTIAL. An unread source is not a zero. ` +
          `(A source that is merely not-configured does NOT reach this alert.)`,
        runbookAnchor: source.docs.split('#')[1] ?? 'source-health',
        labels: { source: source.id },
      }),
    )
  }

  // ── revenue stall (User Story 5) ───────────────────────────────────────────────────────────
  //
  // A fee path that silently broke looks exactly like a quiet day. Only the history distinguishes
  // them, which is why this compares a 24h window against a 14d baseline rather than using a floor.
  rules.push(
    rule({
      uid: 'finops-revenue-stall',
      title: 'Revenue stalled on a source that normally earns',
      expr:
        'increase(fairwins_finops_revenue_total[24h]) == 0 ' +
        'and on(source) (increase(fairwins_finops_revenue_total[14d]) > 0)',
      evaluator: { type: 'gt', params: [0] },
      forDuration: '1h',
      severity: 'warning',
      /**
       * NO BASELINE MEANS "CANNOT JUDGE", NOT "SOMETHING IS WRONG".
       *
       * This rule is defined by its 14-day baseline: a source that has never earned cannot have
       * stalled. Before 14 days of history exist the right-hand side matches nothing, the whole
       * expression is empty, and Alerting-on-NoData would report a stall for every source on a
       * brand-new deployment. Measured 2026-08-17 at 17h uptime: 0 series for the 14d baseline, and
       * this rule pending on NoData.
       *
       * Losing sight of a source is the staleness rule's job, and it fires independently.
       */
      noData: 'OK',
      summary:
        'A revenue source that earned over the last 14 days has earned nothing for 24 hours. This is what a ' +
        'silently broken fee path looks like — it is indistinguishable from a quiet day without the baseline.',
      runbookAnchor: 'revenue-stall',
    }),
  )

  // ── spend anomaly (User Story 5) ───────────────────────────────────────────────────────────
  rules.push(
    rule({
      uid: 'finops-cost-anomaly',
      title: 'Daily cost above 2x the trailing 7-day mean',
      /**
       * THE BASELINE AVERAGES OVER THE DAYS THAT EXIST, not over a hardcoded seven.
       *
       * `increase(...[7d]) / 7` assumes seven days of history. On a young deployment it divides
       * whatever exists by 7, producing a baseline far below the real daily rate — so ANY day's spend
       * trivially exceeds 2x it. Measured 2026-08-17 at 17h uptime: this rule was pending, comparing
       * a full day's cost against a "daily average" that was really 17 hours / 7.
       *
       * The subquery form takes the daily increase at 1-day steps and averages the samples that
       * actually exist, so it is self-normalising: correct at 17 hours, and identical to the old form
       * once a week of history has accumulated.
       */
      expr:
        'sum by (source) (increase(fairwins_finops_cost_usd_total[24h])) ' +
        '> 2 * sum by (source) (avg_over_time(increase(fairwins_finops_cost_usd_total[24h])[7d:1d]))',
      evaluator: { type: 'gt', params: [0] },
      forDuration: '30m',
      severity: 'warning',
      // An absent baseline cannot evidence an anomaly. Unreadability is the staleness rule's job.
      noData: 'OK',
      summary: 'A cost source spent more than twice its trailing daily average in the last 24 hours.',
      runbookAnchor: 'cost-anomaly',
    }),
  )

  // ── fees waived (a misconfiguration that costs money silently) ─────────────────────────────
  rules.push(
    rule({
      uid: 'finops-fees-waived',
      title: 'Platform fees are being waived (no treasury configured)',
      expr: 'increase(fairwins_finops_revenue_waived_total[1h])',
      evaluator: { type: 'gt', params: [0] },
      forDuration: '15m',
      severity: 'critical',
      summary:
        'FeeRouter emitted FeeSkippedNoTreasury: fees are being charged at 0 because no treasury is set. ' +
        'This is live revenue being forgone for a configuration reason, and it is invisible in every other view.',
      runbookAnchor: 'fees-waived',
    }),
  )

  // ── FX staleness (FR-013) ──────────────────────────────────────────────────────────────────
  rules.push(
    rule({
      uid: 'finops-fx-stale',
      title: 'FX rate is stale — USD figures unavailable',
      expr: 'fairwins_finops_fx_age_seconds',
      evaluator: { type: 'gt', params: [6 * 3600] },
      forDuration: '30m',
      severity: 'warning',
      summary:
        'The price feed backing every USD conversion is stale. USD cost figures stop being produced rather than ' +
        'being converted at a rate we know is old; native-unit figures are unaffected.',
      runbookAnchor: 'fx-rate',
    }),
  )

  return {
    // Grafana provisioning envelope.
    apiVersion: 1,
    groups: [
      {
        name: 'fairwins-finops',
        folder: 'FinOps',
        interval: '1m',
        rules,
      },
    ],
  }
}
