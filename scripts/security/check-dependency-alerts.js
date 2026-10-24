#!/usr/bin/env node
/**
 * Dependency vulnerability gate (issue #1521).
 *
 * `.github/dependabot.yml` has said this in its own header since it landed:
 *
 *   "There is currently no vulnerability gate anywhere in CI while `npm audit` reports findings on
 *    every install, so this is the first automated pressure on that."
 *
 * The pressure it meant was Dependabot opening PRs. Nothing ever read the ALERTS, so they were not
 * a signal anybody had to answer, and 45 accumulated (1 critical, 9 high) with every required check
 * green. Every comparable invariant in this repo that survived was made a gate, because a prose
 * rule with no enforcement is the rule that gets broken.
 *
 * WHY NOT `npm audit`. It re-resolves the tree to answer, and an incremental resolve in this repo
 * silently drops the platform rolldown binary from node_modules AND the lockfile (npm/cli#4828,
 * spec 075) — so the gate would break the builds it is meant to protect. It also cannot see
 * dismissals, so the 12 OpenZeppelin alerts against a 4.7.3 copy that solc never reads (#1520)
 * would keep it permanently red for a reason already understood. This reads the alerts API, where a
 * dismissed alert is simply not `open`.
 *
 * WHY A THRESHOLD, NOT A COUNT. 32 of the 45 are development-scope. A gate that fails on any alert
 * is red on day one and gets bypassed within a week, which is how the last one stayed useless. It
 * fails on what would actually matter:
 *
 *     critical — at any scope
 *     high     — on the runtime path only
 *
 * declared in `dependency-alert-policy.json` so the threshold is reviewable rather than buried here.
 *
 * TWO HALVES, because they need different things.
 *
 *   --offline (default)  schema, expiry and workflow wiring. No network, no token, no npm ci, so it
 *                        runs on EVERY pull request including forks and Dependabot's own.
 *   --live               reconciles the policy against the real alert list. Needs a token with
 *                        `vulnerability-alerts: read`.
 *
 * The live half deliberately does NOT run per-PR. Dependabot alerts are computed for the
 * repository, not for a branch, so a pull request's own diff cannot move them — running it there
 * would re-report repository state as if it were a property of the change, and would fail on every
 * fork PR, where the token has no such permission. It runs on push to the integration branches and
 * on a schedule, which is where the answer means something.
 *
 * AN UNREADABLE ALERT LIST IS A FAILURE, NEVER A PASS (D-05). Same rule the estate reads follow
 * (spec 071) and the FinOps catalogue follows (spec 089): a value exists only when it was read. A
 * gate that goes green when it cannot see is worse than no gate, because it also reports success.
 *
 * Usage:
 *   node scripts/security/check-dependency-alerts.js [--offline] [--live] [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const POLICY_PATH = path.join(__dirname, 'dependency-alert-policy.json');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'dependency-alerts.yml');

/** Severities the API can report, weakest first. */
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
/** Scopes the API can report. `null` (unknown) is treated as runtime — absence is not safety. */
const SCOPES = ['development', 'runtime'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GHSA_ID = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

const v = (rule, message) => ({ rule, message });

/* ------------------------------------------------------------------ policy */

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = fs.readFileSync(policyPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * D-01/D-02 — the policy file itself.
 *
 * An acceptance with no reason is a silenced alert; one with no expiry is a permanent silence
 * bought in a hurry. Both are how a gate becomes decoration, so both are refused here rather than
 * left to review.
 */
function checkPolicyShape(policy, today) {
  const out = [];

  if (!Array.isArray(policy.failOn) || policy.failOn.length === 0) {
    out.push(v('D-01', '`failOn` must be a non-empty array of { severity, scopes } threshold rules.'));
  } else {
    policy.failOn.forEach((rule, i) => {
      if (!SEVERITIES.includes(rule.severity)) {
        out.push(v('D-01', `failOn[${i}].severity "${rule.severity}" is not one of ${SEVERITIES.join(', ')}.`));
      }
      if (!Array.isArray(rule.scopes) || rule.scopes.length === 0 || rule.scopes.some((s) => !SCOPES.includes(s))) {
        out.push(v('D-01', `failOn[${i}].scopes must be a non-empty subset of ${SCOPES.join(', ')}.`));
      }
    });
  }

  const acceptances = policy.acceptances;
  if (!Array.isArray(acceptances)) {
    out.push(v('D-01', '`acceptances` must be an array (use [] when nothing is accepted).'));
    return out;
  }

  const seen = new Set();
  acceptances.forEach((a, i) => {
    const where = `acceptances[${i}]${a && a.ghsa ? ` (${a.ghsa})` : ''}`;

    if (!a || typeof a !== 'object') {
      out.push(v('D-01', `${where} must be an object.`));
      return;
    }
    if (!GHSA_ID.test(a.ghsa || '')) {
      out.push(v('D-01', `${where} needs a valid \`ghsa\` id (GHSA-xxxx-xxxx-xxxx).`));
    }
    if (!a.package) out.push(v('D-01', `${where} needs the \`package\` it concerns.`));
    // A reason short enough to be a label is not a reason.
    if (!a.reason || String(a.reason).trim().length < 30) {
      out.push(
        v(
          'D-01',
          `${where} needs a \`reason\` of at least 30 characters saying why this is tolerable. ` +
            'An acceptance without one is an alert that was silenced, not triaged.',
        ),
      );
    }
    if (!Number.isInteger(a.issue)) {
      out.push(v('D-01', `${where} needs \`issue\`: the number of the issue tracking its removal.`));
    }
    if (!ISO_DATE.test(a.expires || '')) {
      out.push(v('D-01', `${where} needs \`expires\` as YYYY-MM-DD. An acceptance with no end date never gets one.`));
    } else if (a.expires < today) {
      out.push(
        v(
          'D-02',
          `${where} expired on ${a.expires} (today is ${today}). Fix the alert, or renew the ` +
            'acceptance deliberately with a fresh reason — renewing is a decision, not a formality.',
        ),
      );
    }
    if (a.ghsa) {
      const key = `${a.ghsa}::${a.package || ''}`;
      if (seen.has(key)) out.push(v('D-01', `${where} is a duplicate entry.`));
      seen.add(key);
    }
  });

  return out;
}

/**
 * D-06 — the live half must actually be able to read.
 *
 * Without `vulnerability-alerts: read` every live run resolves "unreadable" and fails, which looks
 * like a broken gate rather than a missing permission. Caught here, offline, on every PR.
 */
function checkWorkflowWiring(workflowPath = WORKFLOW_PATH) {
  if (!fs.existsSync(workflowPath)) {
    return [v('D-06', `${path.relative(ROOT, workflowPath)} is missing — the live reconciliation has nowhere to run.`)];
  }
  const text = fs.readFileSync(workflowPath, 'utf8');
  const body = text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  const out = [];
  if (!/vulnerability-alerts:\s*read/.test(body)) {
    out.push(
      v(
        'D-06',
        'dependency-alerts.yml must declare `vulnerability-alerts: read`. It is the only permission ' +
          'that lets GITHUB_TOKEN list Dependabot alerts; without it every run fails as unreadable.',
      ),
    );
  }
  if (!/--live/.test(body)) {
    out.push(v('D-06', 'dependency-alerts.yml must invoke the gate with `--live`; the offline half proves nothing about real alerts.'));
  }
  if (/continue-on-error/.test(body)) {
    out.push(v('D-06', 'dependency-alerts.yml must not use `continue-on-error` (Constitution IV).'));
  }
  return out;
}

/* -------------------------------------------------------------------- live */

/** Scope is `runtime` unless the API positively said `development`. Unknown is never treated as safe. */
const scopeOf = (alert) => ((alert.dependency || {}).scope === 'development' ? 'development' : 'runtime');

const qualifies = (alert, failOn) =>
  failOn.some((r) => r.severity === (alert.security_advisory || {}).severity && r.scopes.includes(scopeOf(alert)));

/**
 * Fetch every open Dependabot alert. Throws on any non-OK response — the caller turns that into
 * D-05, never into an empty list.
 *
 * NOTE the pagination. This endpoint does NOT accept `page`; it answers
 * `400 Pagination using the \`page\` parameter is not supported.` and pages by cursor through the
 * `Link` header instead. The first draft here used `?page=N`, passed every unit test against a
 * stubbed fetch, and failed on the first real call — which is why the live run is part of building
 * this and not just part of reviewing it.
 */
async function fetchOpenAlerts({ repo, token, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw new Error('no token supplied (set GITHUB_TOKEN with `vulnerability-alerts: read`)');
  if (!repo) throw new Error('no repository supplied (set GITHUB_REPOSITORY)');

  const alerts = [];
  let url = `https://api.github.com/repos/${repo}/dependabot/alerts?state=open&per_page=100`;

  for (let hop = 0; url && hop < 50; hop += 1) {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const hint =
        res.status === 403
          ? ' — the token is missing `vulnerability-alerts: read`, or Dependabot alerts are disabled for this repository'
          : '';
      throw new Error(`GET ${url} -> ${res.status} ${res.statusText}${hint}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error(`unexpected response shape from ${url}`);
    alerts.push(...batch);
    url = nextLink(res.headers);
  }
  return alerts;
}

/** Pull the `rel="next"` cursor URL out of a Link header, or null when this was the last page. */
function nextLink(headers) {
  const link = headers && typeof headers.get === 'function' ? headers.get('link') : null;
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * D-03/D-04 — reconcile the live alert list against the policy.
 *
 * D-04 mirrors the spec registry's S-04: an entry that outlives the thing it excuses is removed by
 * the gate that owns it, so the accepted set can only shrink on its own.
 */
function reconcile(alerts, policy) {
  const out = [];
  const accepted = new Map((policy.acceptances || []).map((a) => [a.ghsa, a]));
  const qualifying = alerts.filter((a) => qualifies(a, policy.failOn));

  for (const alert of qualifying) {
    const adv = alert.security_advisory || {};
    if (accepted.has(adv.ghsa_id)) continue;
    const dep = (alert.dependency || {}).package || {};
    out.push(
      v(
        'D-03',
        `${adv.severity} ${scopeOf(alert)} alert #${alert.number} on \`${dep.name}\` (${adv.ghsa_id}) ` +
          `is not accounted for: ${adv.summary || 'no summary'}. Fix it, or add an acceptance with a ` +
          'reason, a tracking issue and an expiry.',
      ),
    );
  }

  const openGhsas = new Set(alerts.map((a) => (a.security_advisory || {}).ghsa_id));
  for (const a of policy.acceptances || []) {
    if (!openGhsas.has(a.ghsa)) {
      out.push(
        v(
          'D-04',
          `acceptance for ${a.ghsa} (\`${a.package}\`) no longer matches any open alert — it was fixed ` +
            'or dismissed. Delete the entry; a list of excuses for things that are not happening is ' +
            'how the next real one gets lost.',
        ),
      );
    }
  }

  return { violations: out, qualifying, total: alerts.length };
}

/* -------------------------------------------------------------------- main */

async function main(argv) {
  const json = argv.includes('--json');
  const live = argv.includes('--live');
  const today = new Date().toISOString().slice(0, 10);

  let policy;
  try {
    policy = loadPolicy();
  } catch (err) {
    const violations = [v('D-01', `cannot read ${path.relative(ROOT, POLICY_PATH)}: ${err.message}`)];
    return report(violations, { json, live, scanned: null });
  }

  const violations = [...checkPolicyShape(policy, today), ...checkWorkflowWiring()];

  let scanned = null;
  if (live) {
    try {
      const alerts = await fetchOpenAlerts({
        repo: process.env.GITHUB_REPOSITORY,
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      });
      const res = reconcile(alerts, policy);
      violations.push(...res.violations);
      scanned = { total: res.total, qualifying: res.qualifying.length };
    } catch (err) {
      // D-05. Never degrade to a pass: not reading is not the same as nothing to read.
      violations.push(
        v(
          'D-05',
          `could not read the Dependabot alert list, so this run proves nothing: ${err.message}. ` +
            'Treated as a failure on purpose — a gate that goes green when it cannot see also ' +
            'reports success when it is broken.',
        ),
      );
    }
  }

  return report(violations, { json, live, scanned, policy });
}

function report(violations, { json, live, scanned, policy }) {
  if (json) {
    console.log(JSON.stringify({ mode: live ? 'live' : 'offline', scanned, violations }, null, 2));
    return violations.length === 0 ? 0 : 1;
  }

  if (violations.length === 0) {
    const accepted = policy ? (policy.acceptances || []).length : 0;
    if (live && scanned) {
      console.log(
        `✅ Dependency alerts: ${scanned.total} open, ${scanned.qualifying} above threshold, ` +
          `all ${accepted} accounted for by an unexpired acceptance.`,
      );
    } else {
      console.log(`✅ Dependency alert policy intact — ${accepted} acceptance(s), none expired, live job wired.`);
    }
    return 0;
  }

  console.error(`❌ Dependency alerts: ${violations.length} violation(s)\n`);
  for (const x of violations) console.error(`  [${x.rule}] ${x.message}\n`);
  console.error('See docs/developer-guide/dependency-alert-gate.md');
  return 1;
}

module.exports = { checkPolicyShape, checkWorkflowWiring, reconcile, fetchOpenAlerts, nextLink, qualifies, scopeOf, loadPolicy };

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`❌ Dependency alert gate crashed: ${err.stack || err.message}`);
      process.exit(1);
    });
}
