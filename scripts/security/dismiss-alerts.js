#!/usr/bin/env node
/**
 * Dependabot alert dismissals (issue #1520).
 *
 * Twelve of the forty-five open alerts name `@openzeppelin/contracts` and
 * `@openzeppelin/contracts-upgradeable` and describe Solidity this repository never compiles. They
 * cannot be fixed by a bump — `@chainlink/contracts` is exact-pinned under spec 075 because it
 * contributes Solidity source, and `@openzeppelin/*` is held at 5.4.0 deliberately (5.5+ emits
 * `mcopy`, which fails at `evmVersion: paris`). The only correct outcome is a dismissal with the
 * reasoning recorded where the next reader will meet it: on the alert.
 *
 * WHY THIS IS A SCRIPT AND NOT TWELVE CLICKS. Two reasons, and the second is the real one:
 *
 *   1. Twelve hand-typed paragraphs are twelve slightly different paragraphs.
 *   2. A dismissal records a conclusion but not the CRITERIA that reached it. Clicking leaves no
 *      answer to "why those twelve and not a thirteenth". The plan file is that answer, and it is
 *      reviewed in a pull request before it is ever executed.
 *
 * SELECTION IS BY PROOF, NEVER BY ALERT NUMBER. An alert is eligible only when the advisory's
 * vulnerable range EXCLUDES the version this repository actually compiles against. Alert numbers
 * would go stale and would encode nothing; a range test re-derives the argument on every run, so
 * bumping the pin INTO a vulnerable range makes the alerts stop matching instead of being dismissed
 * anyway. An unparseable range counts as INCLUDING the version — not being able to prove code is
 * unreachable is not the same as proving it is (the spec-071 / spec-089 rule: a value exists only
 * when it was read).
 *
 * WHY IT CANNOT RUN IN CI. Dismissing needs write access to Dependabot alerts, and there is no
 * `vulnerability-alerts: write` for `GITHUB_TOKEN` — `dependency-alerts.yml` gets the read half and
 * that is all Actions offers. This runs from an operator's workstation under a token with the
 * `security_events` scope, which is exactly the class of credential spec 097 keeps in Secret
 * Manager rather than a `.env`.
 *
 * DRY RUN IS THE DEFAULT. `--apply` is required to write, and it refuses when the live selection is
 * a different size than the reviewed `expectedCount`: a set that grew is a set nobody looked at.
 *
 * Usage:
 *   node scripts/security/dismiss-alerts.js              # dry run — print what would be dismissed
 *   node scripts/security/dismiss-alerts.js --apply      # dismiss, needs `security_events`
 *   node scripts/security/dismiss-alerts.js --json
 *   node scripts/security/dismiss-alerts.js --id openzeppelin-nested-unreachable
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { fetchOpenAlerts } = require('./check-dependency-alerts.js');

const ROOT = path.join(__dirname, '..', '..');
const PLAN_PATH = path.join(__dirname, 'dismissals.json');
const PKG_PATH = path.join(ROOT, 'package.json');

/** GitHub's own enumeration for `dismissed_reason`. Anything else is a 422 at the API. */
const DISMISSED_REASONS = ['fix_started', 'inaccurate', 'no_bandwidth', 'not_used', 'tolerable_risk'];
/** `dismissed_comment` is capped by the API. A rejected write would lose the whole reasoning. */
const MAX_COMMENT = 280;
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

const v = (rule, message) => ({ rule, message });

/* --------------------------------------------------------------- versions */

/**
 * Parse a plain `x.y.z`. Returns null for anything with a prerelease or build tag — those compare
 * by rules this does not implement, and a wrong answer here would dismiss a live alert.
 */
function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Does a GitHub `vulnerable_version_range` contain `version`?
 *
 * The API emits comma-separated comparators: `>= 3.2.0, < 4.8.3`, `< 4.9.6`, `= 1.2.3`. Returns
 * `true` when it cannot tell — see the header. Callers treat `true` as "not eligible".
 */
function rangeIncludes(range, version) {
  const target = parseVersion(version);
  if (!target || typeof range !== 'string' || range.trim() === '') return true;

  for (const raw of range.split(',')) {
    const m = /^\s*(>=|<=|>|<|=)?\s*(\S+)\s*$/.exec(raw);
    if (!m) return true;
    const bound = parseVersion(m[2]);
    if (!bound) return true;
    const cmp = compareVersions(target, bound);
    const op = m[1] || '=';
    const satisfied =
      (op === '>=' && cmp >= 0) ||
      (op === '<=' && cmp <= 0) ||
      (op === '>' && cmp > 0) ||
      (op === '<' && cmp < 0) ||
      (op === '=' && cmp === 0);
    if (!satisfied) return false;
  }
  return true;
}

/* ------------------------------------------------------------------- plan */

function loadPlan(planPath = PLAN_PATH) {
  return JSON.parse(fs.readFileSync(planPath, 'utf8'));
}

/**
 * X-01/X-02 — the plan file itself, checked offline so a rotten plan never reaches the API.
 *
 * X-02 is the one that matters over time. `compiledVersion` is an assertion about this repository,
 * and the day someone bumps `@openzeppelin/contracts` it stops being true. Left unchecked, the plan
 * would keep dismissing alerts using an argument that no longer holds.
 */
function checkPlanShape(plan, pkg) {
  const out = [];
  if (!plan || !Array.isArray(plan.dismissals) || plan.dismissals.length === 0) {
    return [v('X-01', '`dismissals` must be a non-empty array.')];
  }

  const seen = new Set();
  for (const d of plan.dismissals) {
    const id = d && d.id ? `\`${d.id}\`` : '(unnamed entry)';
    if (!d.id || typeof d.id !== 'string') out.push(v('X-01', `${id}: every dismissal needs a stable \`id\`.`));
    else if (seen.has(d.id)) out.push(v('X-01', `${id}: duplicate \`id\`.`));
    else seen.add(d.id);

    if (!Number.isInteger(d.issue)) out.push(v('X-01', `${id}: needs the \`issue\` that decided this.`));
    if (!DISMISSED_REASONS.includes(d.dismissedReason)) {
      out.push(v('X-01', `${id}: \`dismissedReason\` must be one of ${DISMISSED_REASONS.join(', ')}.`));
    }
    if (typeof d.comment !== 'string' || d.comment.trim().length < 40) {
      out.push(v('X-01', `${id}: \`comment\` must carry the reasoning — that is the whole point of doing this in a file.`));
    } else if (d.comment.length > MAX_COMMENT) {
      out.push(
        v('X-01', `${id}: \`comment\` is ${d.comment.length} characters; the API caps it at ${MAX_COMMENT} and rejects the write.`),
      );
    }
    if (!Number.isInteger(d.expectedCount) || d.expectedCount < 1) {
      out.push(v('X-01', `${id}: \`expectedCount\` must be the number of alerts this was reviewed against.`));
    }

    const m = d.match;
    if (!m || typeof m !== 'object') {
      out.push(v('X-01', `${id}: needs a \`match\` block — selection is by criteria, never by alert number.`));
      continue;
    }
    if (!Array.isArray(m.packages) || m.packages.length === 0) {
      out.push(v('X-01', `${id}: \`match.packages\` must name the packages this covers.`));
    }
    if (m.maxSeverity && !SEVERITIES.includes(m.maxSeverity)) {
      out.push(v('X-01', `${id}: \`match.maxSeverity\` must be one of ${SEVERITIES.join(', ')}.`));
    }
    if (!parseVersion(m.compiledVersion)) {
      out.push(v('X-02', `${id}: \`match.compiledVersion\` must be a plain x.y.z — it is the version the range test compares against.`));
      continue;
    }
    for (const name of m.packages || []) {
      const pinned = (pkg.devDependencies || {})[name] || (pkg.dependencies || {})[name];
      if (!pinned) {
        out.push(v('X-02', `${id}: \`${name}\` is not a dependency of this repository any more; the plan is stale.`));
      } else if (pinned !== m.compiledVersion) {
        out.push(
          v(
            'X-02',
            `${id}: \`${name}\` is pinned at ${pinned} but the plan argues about ${m.compiledVersion}. ` +
              'Re-derive the reachability argument against the real pin before dismissing anything with it.',
          ),
        );
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------- selection */

const scopeOf = (alert) => ((alert.dependency || {}).scope === 'development' ? 'development' : 'runtime');

/**
 * X-03/X-04 — is this alert eligible under this entry?
 *
 * Returns a reason string when it is NOT, so a near-miss can be printed rather than silently
 * dropped. A thirteenth alert that ALMOST matches is the most interesting thing a dry run can say.
 */
function ineligibleReason(alert, entry) {
  const m = entry.match;
  const dep = (alert.dependency || {}).package || {};
  const adv = alert.security_advisory || {};
  const vuln = alert.security_vulnerability || {};

  if (m.ecosystem && dep.ecosystem !== m.ecosystem) return `ecosystem is ${dep.ecosystem || 'unknown'}`;
  if (!m.packages.includes(dep.name)) return null; // not this entry's business at all
  if (m.scope && scopeOf(alert) !== m.scope) return `scope is ${scopeOf(alert)}, not ${m.scope}`;
  if (m.maxSeverity && SEVERITIES.indexOf(adv.severity) > SEVERITIES.indexOf(m.maxSeverity)) {
    return `severity is ${adv.severity}, above the reviewed ceiling of ${m.maxSeverity}`;
  }
  const range = (vuln || {}).vulnerable_version_range;
  if (rangeIncludes(range, m.compiledVersion)) {
    return `advisory range "${range}" includes the compiled ${m.compiledVersion} — this one is reachable, or unparseable`;
  }
  return '';
}

function selectAlerts(alerts, plan, { only } = {}) {
  const entries = (plan.dismissals || []).filter((d) => !only || d.id === only);
  return entries.map((entry) => {
    const eligible = [];
    const nearMisses = [];
    for (const alert of alerts) {
      const reason = ineligibleReason(alert, entry);
      if (reason === '') eligible.push(alert);
      else if (reason) nearMisses.push({ alert, reason });
    }
    return { entry, eligible, nearMisses };
  });
}

/* ------------------------------------------------- X-07: the reviewed plan */

/** Where a plan must be merged before it may be executed. */
const REVIEW_BRANCH = 'staging';

/**
 * X-07 — an apply may only execute the plan that is MERGED on the review branch.
 *
 * The premise of this whole file is "the criteria are reviewed before they are ever executed", and
 * until now that was a sentence in a comment rather than something enforced. Two ways to break it,
 * one of which a reviewing agent hit within hours of the plan landing:
 *
 *   1. STALE. #1575 corrected the dismissal comment, but until it merges `staging` still carries
 *      the retracted wording. "Pull staging first, then apply" — the instruction given at the
 *      time — would therefore have stamped the RETRACTED text onto twelve alerts. A
 *      `dismissed_comment` is what the next reader meets, and unlike a file it cannot be fixed by
 *      a later pull request.
 *   2. UNREVIEWED. Nothing stopped someone editing `dismissals.json` locally and applying it. The
 *      review is the only thing standing between a typed paragraph and twelve permanent records.
 *
 * Both are the same bug — executing a plan nobody merged — so both get the same gate: fetch the
 * plan from the review branch and refuse unless it is byte-identical to the one in hand.
 *
 * There is deliberately NO override flag. An override is how this becomes decoration again, and
 * the legitimate path is short: merge the plan, then apply it.
 *
 * An unreadable review branch REFUSES rather than proceeding (the D-05 rule, again): not being
 * able to confirm the plan was reviewed is not the same as it having been.
 */
async function fetchReviewedPlan({ repo, token, branch = REVIEW_BRANCH, fetchImpl = globalThis.fetch }) {
  const url =
    `https://api.github.com/repos/${repo}/contents/` +
    `scripts/security/dismissals.json?ref=${encodeURIComponent(branch)}`;
  const res = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github.v3.raw',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}

/** Compare the entry that is about to run against the same entry on the review branch. */
function reviewedEntryMatches(reviewedText, entry) {
  let reviewed;
  try {
    reviewed = JSON.parse(reviewedText);
  } catch (err) {
    return { ok: false, why: `the plan on ${REVIEW_BRANCH} is not valid JSON: ${err.message}` };
  }
  const there = (reviewed.dismissals || []).find((d) => d.id === entry.id);
  if (!there) return { ok: false, why: `no dismissal with id \`${entry.id}\` exists on ${REVIEW_BRANCH} — this plan was never merged` };

  for (const field of ['comment', 'dismissedReason', 'expectedCount']) {
    if (JSON.stringify(there[field]) !== JSON.stringify(entry[field])) {
      return {
        ok: false,
        why:
          `\`${field}\` differs from the version merged on ${REVIEW_BRANCH}.\n` +
          `      merged:  ${JSON.stringify(there[field])}\n` +
          `      local:   ${JSON.stringify(entry[field])}`,
      };
    }
  }
  if (JSON.stringify(there.match) !== JSON.stringify(entry.match)) {
    return { ok: false, why: `\`match\` differs from the version merged on ${REVIEW_BRANCH}` };
  }
  return { ok: true };
}

/* ------------------------------------------------- X-08: can this token write? */

/**
 * X-08 — a green dry run must not mean "this credential can apply".
 *
 * Field evidence from the first real run (#1520): a token carrying `repo` but not `security_events`
 * READS the alert list perfectly well and 403s only on the PATCH. So the dry run passes, prints a
 * clean selection, and the scope gap does not surface until the write — where the natural reading of
 * a green dry run is that the credential is good.
 *
 * That would be a mild annoyance on its own. What makes it worth a gate is the state it can leave
 * behind: the apply loop had no error handling, so a 403 on the SEVENTH alert would leave six
 * dismissed and throw. On the next run the open set is 6 where `expectedCount` is 12, X-05 fires,
 * and the tool refuses to finish the job it half did. The operator is then stuck between an
 * unfinished dismissal and editing a reviewed plan. We got away with it because the failing token
 * failed on the first PATCH and wrote nothing.
 *
 * GitHub advertises a classic PAT's scopes on every response (`x-oauth-scopes`), so for that case
 * the gap is knowable BEFORE any write. Fine-grained and app tokens send no such header, and
 * "unknown" is reported as unknown rather than guessed either way — the third state, same as
 * everywhere else here.
 */
function describeWriteCapability(headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('x-oauth-scopes') : null;
  if (!raw || !raw.trim()) {
    return {
      state: 'unknown',
      reason:
        'this token does not advertise its scopes (fine-grained or app tokens do not), so whether it ' +
        'may dismiss cannot be known until the first write',
    };
  }
  const scopes = raw.split(',').map((x) => x.trim()).filter(Boolean);
  if (scopes.includes('security_events')) {
    return { state: 'can-write', reason: `token carries \`security_events\`` };
  }
  return {
    state: 'cannot-write',
    reason:
      `token carries [${scopes.join(', ')}] but not \`security_events\`. Reading alerts only needs ` +
      '`repo`, which is why the dry run passed — the PATCH will 403',
  };
}

/** Probe the alerts endpoint purely to read its scope headers back. */
async function probeWriteCapability({ repo, token, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/dependabot/alerts?state=open&per_page=1`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  return describeWriteCapability(res.headers);
}

/* ------------------------------------------------------------------ write */

async function dismissAlert({ repo, token, number, entry, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/dependabot/alerts/${number}`, {
    method: 'PATCH',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({
      state: 'dismissed',
      dismissed_reason: entry.dismissedReason,
      dismissed_comment: entry.comment,
    }),
  });
  if (!res.ok) {
    const hint =
      res.status === 403
        ? ' — the token needs the `security_events` scope (or fine-grained "Dependabot alerts: write"); ' +
          'GITHUB_TOKEN in Actions cannot do this'
        : '';
    throw new Error(`PATCH alert #${number} -> ${res.status} ${res.statusText}${hint}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------- main */

async function main(argv) {
  const json = argv.includes('--json');
  const apply = argv.includes('--apply');
  const onlyIdx = argv.indexOf('--id');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

  const plan = loadPlan();
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

  const violations = checkPlanShape(plan, pkg);
  if (violations.length > 0) return report({ violations, json });

  let alerts;
  try {
    alerts = await fetchOpenAlerts({
      repo: process.env.GITHUB_REPOSITORY || 'chippr-robotics/fairwins-platform',
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    });
  } catch (err) {
    // Same rule as the gate's D-05: not reading is not the same as nothing to read.
    violations.push(v('X-06', `could not read the open alert list, so nothing was dismissed: ${err.message}`));
    return report({ violations, json });
  }

  const selections = selectAlerts(alerts, plan, { only });
  if (selections.length === 0) {
    violations.push(v('X-01', only ? `no dismissal has id \`${only}\`.` : 'the plan selected nothing.'));
    return report({ violations, json });
  }

  // X-05 — the reviewed count is the consent. A live set of a different size was not reviewed.
  for (const { entry, eligible } of selections) {
    if (eligible.length !== entry.expectedCount) {
      violations.push(
        v(
          'X-05',
          `\`${entry.id}\`: ${eligible.length} alert(s) match but the plan was reviewed against ` +
            `${entry.expectedCount}. Nothing was dismissed. Re-read the list, then update \`expectedCount\` ` +
            'in the same change that explains why it moved.',
        ),
      );
    }
  }

  // X-07 — refuse to execute a plan that is not the one merged on the review branch.
  if (apply && violations.length === 0) {
    let reviewedText = null;
    try {
      reviewedText = await fetchReviewedPlan({
        repo: process.env.GITHUB_REPOSITORY || 'chippr-robotics/fairwins-platform',
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      });
    } catch (err) {
      violations.push(
        v('X-07', `could not read the plan on ${REVIEW_BRANCH}, so it cannot be confirmed reviewed: ${err.message}`),
      );
    }
    if (reviewedText !== null) {
      for (const { entry } of selections) {
        const { ok, why } = reviewedEntryMatches(reviewedText, entry);
        if (!ok) {
          violations.push(
            v(
              'X-07',
              `\`${entry.id}\` is not the plan merged on ${REVIEW_BRANCH}: ${why}\n` +
                `      Nothing was dismissed. A dismissal comment is permanent and cannot be corrected by a ` +
                `later PR, so only a REVIEWED plan may be applied. Merge the plan, pull, re-run the dry run, ` +
                'then apply.',
            ),
          );
        }
      }
    }
  }

  // X-08 — refuse before writing anything when the token is KNOWN not to be able to.
  let capability = null;
  if (apply && violations.length === 0) {
    try {
      capability = await probeWriteCapability({
        repo: process.env.GITHUB_REPOSITORY || 'chippr-robotics/fairwins-platform',
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      });
    } catch {
      capability = { state: 'unknown', reason: 'the scope probe itself failed' };
    }
    if (capability.state === 'cannot-write') {
      violations.push(
        v('X-08', `this token cannot dismiss: ${capability.reason}. Nothing was attempted.`),
      );
    }
  }

  const applied = [];
  let writeFailure = null;
  if (apply && violations.length === 0) {
    outer: for (const { entry, eligible } of selections) {
      for (const alert of eligible) {
        try {
          await dismissAlert({
            repo: process.env.GITHUB_REPOSITORY || 'chippr-robotics/fairwins-platform',
            token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
            number: alert.number,
            entry,
          });
          applied.push(alert.number);
        } catch (err) {
          // Stop at the first failure rather than hammering, and make the half-done state legible
          // — silence here is what turns a partial apply into a plan that can never be completed.
          writeFailure = { number: alert.number, message: err.message };
          break outer;
        }
      }
    }
    if (writeFailure) {
      violations.push(
        v(
          'X-08',
          `stopped at alert #${writeFailure.number}: ${writeFailure.message}\n` +
            `      ${applied.length} alert(s) WERE dismissed before this: ${applied.join(', ') || 'none'}.\n` +
            '      Those are permanent. The remaining ones are still open, and because the open set is now ' +
            `smaller than \`expectedCount\`, a re-run will fail X-05 until the plan's count is corrected ` +
            'in a change that is merged (X-07). Fix the credential first, then adjust the count once.',
        ),
      );
    }
  }

  return report({ violations, json, selections, apply, applied, total: alerts.length });
}

function report({ violations, json, selections = [], apply = false, applied = [], total = null }) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          mode: apply ? 'apply' : 'dry-run',
          openAlerts: total,
          selections: selections.map(({ entry, eligible, nearMisses }) => ({
            id: entry.id,
            expectedCount: entry.expectedCount,
            matched: eligible.map((a) => a.number),
            nearMisses: nearMisses.map(({ alert, reason }) => ({ number: alert.number, reason })),
          })),
          applied,
          violations,
        },
        null,
        2,
      ),
    );
    return violations.length === 0 ? 0 : 1;
  }

  for (const { entry, eligible, nearMisses } of selections) {
    console.log(`\n${entry.id} (#${entry.issue}) — reason: ${entry.dismissedReason}, expected ${entry.expectedCount}`);
    console.log(`  "${entry.comment}"`);
    for (const a of eligible) {
      const adv = a.security_advisory || {};
      const dep = (a.dependency || {}).package || {};
      console.log(`  • #${a.number} ${adv.severity} ${dep.name} ${adv.ghsa_id} (${(a.security_vulnerability || {}).vulnerable_version_range})`);
    }
    for (const { alert, reason } of nearMisses) {
      console.log(`  ↷ #${alert.number} NOT eligible: ${reason}`);
    }
  }

  if (violations.length > 0) {
    console.error(`\n❌ ${violations.length} problem(s); nothing was dismissed\n`);
    for (const x of violations) console.error(`  [${x.rule}] ${x.message}\n`);
    return 1;
  }

  if (apply) console.log(`\n✅ Dismissed ${applied.length} alert(s): ${applied.join(', ')}`);
  else console.log(`\nDry run — nothing was written. Re-run with --apply and a token carrying \`security_events\`.`);
  return 0;
}

module.exports = {
  describeWriteCapability,
  probeWriteCapability,
  fetchReviewedPlan,
  reviewedEntryMatches,
  REVIEW_BRANCH,
  parseVersion,
  compareVersions,
  rangeIncludes,
  loadPlan,
  checkPlanShape,
  ineligibleReason,
  selectAlerts,
  dismissAlert,
  DISMISSED_REASONS,
  MAX_COMMENT,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`❌ Dismissal run crashed: ${err.stack || err.message}`);
      process.exit(1);
    });
}
