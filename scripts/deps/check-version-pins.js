#!/usr/bin/env node
/**
 * Version-pin gate: every third-party version outside the npm lockfile is a recorded decision
 * (ADR-006, issue #1648).
 *
 * Dependabot watches npm and GitHub Actions. Nothing watched the rest: container base images,
 * compose `image:` tags, the engine images we BUILD from an upstream git tag, or the toolchains. So a
 * pin there was decided once and never revisited. #1648 is the case: the relay engine was pinned at
 * OZ Relayer v1.4.0 on a day v1.5.0 was already two months old, and no file said why. When "the
 * engine is outdated" was reported, nobody could tell a decision from an accident.
 *
 * `version-pins.json` is the record. This script keeps it honest in two halves, the same split as
 * the vulnerability gate (scripts/security/check-dependency-alerts.js, #1521):
 *
 *   --offline (default)  No network and no token, so it runs on EVERY pull request. It fails on
 *                        things that are wrong NOW:
 *     V-01  registry shape. A hold needs a reason, a ref and a reviewBy date.
 *     V-02  a hold past its `reviewBy`, or dated beyond the review window. A hold with no end
 *           date is how 1.4.0 happened.
 *     V-03  drift. Each pin's `contains` string must still appear in each recorded file, and
 *           must contain the pinned version. A bump that forgets the registry fails in the same PR.
 *     V-04  coverage. Every image named by a tracked Dockerfile or compose file must be claimed
 *           by a pin, or sit under a first-party prefix. A watcher that cannot see a pin is not
 *           protection: the FinOps C2b lesson (spec 089).
 *     V-05  floating tags. A third-party image must carry an exact x.y.z tag or a digest, and NO
 *           image may be `latest` or untagged. A floating tag is not reproducible, and it gives no
 *           upgrade signal because the version moves under you without telling you.
 *     V-06  the live half's workflow is wired (scheduled, runs --live, no continue-on-error).
 *     V-07  a toolchain line declared in many files (a pin's `scan`) is the same everywhere.
 *
 *   --live               Asks upstream for each pin (git tags, Docker Hub, endoflife.date) and
 *                        writes a markdown report. It REPORTS rather than fails, because being
 *                        one minor behind is not a defect, and a gate that is red every Monday
 *                        gets bypassed.
 *                        AN UNREADABLE UPSTREAM IS NAMED, NEVER "UP TO DATE". Same three-state
 *                        rule as spec 071 / 089: a value exists only when it was read.
 *
 * Usage:
 *   node scripts/deps/check-version-pins.js [--offline] [--live] [--report <file>] [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const REGISTRY_PATH = path.join(__dirname, 'version-pins.json');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'version-watch.yml');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['container-image', 'git-built-image', 'binary', 'terraform', 'toolchain', 'mobile'];
const STATUSES = ['track', 'hold'];
const UPSTREAM_TYPES = ['git', 'dockerhub', 'none'];
/** Exact enough to be reproducible: x.y.z somewhere in the tag (e.g. `22.20.0-alpine3.22`, `v1.2.7`). */
const EXACT_TAG = /\d+\.\d+\.\d+/;
/** Pre-releases never count as "latest stable". */
const PRERELEASE = /(alpha|beta|rc|pre|preview|nightly|canary|dev|snapshot)/i;

const v = (rule, message) => ({ rule, message });

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function loadRegistry(registryPath = REGISTRY_PATH) {
  return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
}

/* ------------------------------------------------------------------ V-01 / V-02 */

function checkRegistryShape(registry, today) {
  const out = [];
  const windowDays = registry.reviewWindowDays;
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 366) {
    out.push(v('V-01', '`reviewWindowDays` must be an integer between 1 and 366.'));
  }
  if (!Array.isArray(registry.firstPartyPrefixes)) {
    out.push(v('V-01', '`firstPartyPrefixes` must be an array (use [] when there are none).'));
  }
  if (!Array.isArray(registry.exemptions)) {
    out.push(v('V-01', '`exemptions` must be an array (use [] when there are none).'));
  } else {
    registry.exemptions.forEach((x, i) => {
      const where = `exemptions[${i}]${x && x.contains ? ` (${x.contains})` : ''}`;
      if (!x || !x.file || !x.contains) out.push(v('V-01', `${where} needs \`file\` and \`contains\`.`));
      if (!x || !x.reason || String(x.reason).trim().length < 30) out.push(v('V-01', `${where} needs a \`reason\` of at least 30 characters.`));
      if (!x || !x.ref) out.push(v('V-01', `${where} needs \`ref\`: the issue tracking its removal.`));
      if (!x || !ISO_DATE.test(x.reviewBy || '')) {
        out.push(v('V-01', `${where} needs \`reviewBy\` as YYYY-MM-DD.`));
      } else if (x.reviewBy < today) {
        out.push(v('V-02', `${where} expired on ${x.reviewBy} (today is ${today}). Pin the image, or renew deliberately.`));
      } else if (Number.isInteger(windowDays) && x.reviewBy > addDays(today, windowDays)) {
        out.push(v('V-02', `${where} reviewBy ${x.reviewBy} is more than ${windowDays} days out.`));
      }
    });
  }
  if (!Array.isArray(registry.pins) || registry.pins.length === 0) {
    out.push(v('V-01', '`pins` must be a non-empty array.'));
    return out;
  }

  const seen = new Set();
  registry.pins.forEach((p, i) => {
    const where = `pins[${i}]${p && p.id ? ` (${p.id})` : ''}`;
    if (!p || typeof p !== 'object') {
      out.push(v('V-01', `${where} must be an object.`));
      return;
    }
    if (!p.id || !/^[a-z0-9][a-z0-9.-]*$/.test(p.id)) out.push(v('V-01', `${where} needs a kebab-case \`id\`.`));
    if (seen.has(p.id)) out.push(v('V-01', `${where} duplicates id "${p.id}".`));
    seen.add(p.id);
    if (!KINDS.includes(p.kind)) out.push(v('V-01', `${where}.kind must be one of ${KINDS.join(', ')}.`));
    if (!p.pinned || typeof p.pinned !== 'string') out.push(v('V-01', `${where} needs the \`pinned\` version string.`));
    if (!STATUSES.includes(p.status)) out.push(v('V-01', `${where}.status must be one of ${STATUSES.join(', ')}.`));
    if (!p.owner) out.push(v('V-01', `${where} needs an \`owner\` (the .claude/agents specialist or team that decides bumps).`));

    if (!Array.isArray(p.locations) || p.locations.length === 0) {
      out.push(v('V-01', `${where} needs at least one location { path, contains }.`));
    } else {
      p.locations.forEach((l, j) => {
        if (!l || !l.path || !l.contains) out.push(v('V-01', `${where}.locations[${j}] needs \`path\` and \`contains\`.`));
      });
    }

    const up = p.upstream;
    if (!up || !UPSTREAM_TYPES.includes(up.type)) {
      out.push(v('V-01', `${where}.upstream.type must be one of ${UPSTREAM_TYPES.join(', ')}.`));
    } else if (up.type === 'git' && !/^https:\/\/\S+$/.test(up.repo || '')) {
      out.push(v('V-01', `${where}.upstream.repo must be an https git URL.`));
    } else if (up.type === 'dockerhub' && !up.image) {
      out.push(v('V-01', `${where}.upstream.image is required for dockerhub (e.g. "library/node").`));
    } else if (up.type === 'none' && (!up.why || up.why.length < 20)) {
      out.push(v('V-01', `${where}.upstream.why must say why this pin cannot be watched (≥ 20 chars).`));
    }
    if (up && up.tagPattern) {
      try {
        new RegExp(up.tagPattern);
      } catch (e) {
        out.push(v('V-01', `${where}.upstream.tagPattern is not a valid regex: ${e.message}`));
      }
    }

    if (p.status === 'hold') {
      const h = p.hold || {};
      // A reason short enough to be a label is not a reason.
      if (!h.reason || String(h.reason).trim().length < 30) {
        out.push(
          v(
            'V-01',
            `${where} is a hold and needs \`hold.reason\` (≥ 30 chars) naming why newer is worse FOR US. ` +
              '"Untested" is not a reason.',
          ),
        );
      }
      if (!h.ref) out.push(v('V-01', `${where} is a hold and needs \`hold.ref\`: the issue or doc holding the evidence.`));
      if (!ISO_DATE.test(h.reviewBy || '')) {
        out.push(v('V-01', `${where} is a hold and needs \`hold.reviewBy\` as YYYY-MM-DD.`));
      } else if (h.reviewBy < today) {
        out.push(
          v(
            'V-02',
            `${where} hold expired on ${h.reviewBy} (today is ${today}). Bump it, or renew the hold ` +
              'deliberately with fresh evidence. Renewing is a decision, not a formality.',
          ),
        );
      } else if (Number.isInteger(windowDays) && h.reviewBy > addDays(today, windowDays)) {
        out.push(
          v('V-02', `${where} hold.reviewBy ${h.reviewBy} is more than ${windowDays} days out. A distant date is no date.`),
        );
      }
    } else if (p.hold) {
      out.push(v('V-01', `${where} carries a \`hold\` block but status is "${p.status}". Pick one.`));
    }
  });
  return out;
}

/* ------------------------------------------------------------------ V-03 */

function checkDrift(registry, { root = ROOT } = {}) {
  const out = [];
  for (const p of registry.pins || []) {
    for (const l of p.locations || []) {
      if (!l || !l.path || !l.contains) continue;
      if (!String(l.contains).includes(p.pinned)) {
        out.push(v('V-03', `${p.id}: location ${l.path} expects "${l.contains}", which does not contain pinned "${p.pinned}".`));
      }
      const file = path.join(root, l.path);
      if (!fs.existsSync(file)) {
        out.push(v('V-03', `${p.id}: ${l.path} does not exist. Move the location, or retire the pin.`));
        continue;
      }
      // Comments do not count: a pin repeated in a comment (build notes, a "was vX" line) would
      // otherwise keep V-03 green after the live reference itself moved.
      const live = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(#|\/\/)/.test(line))
        .join('\n');
      if (!live.includes(l.contains)) {
        out.push(
          v(
            'V-03',
            `${p.id}: "${l.contains}" no longer appears in ${l.path}. The file was bumped without the ` +
              'registry (or the reverse). Update both in the same change.',
          ),
        );
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ V-04 / V-05 */

// Dockerfiles (incl. `x.Dockerfile`), compose files, and Cloud Run `service.yaml` manifests.
const IMAGE_FILE = /(^|\/)(Dockerfile[^/]*|[^/]+\.Dockerfile|[^/]*compose[^/]*\.ya?ml|service\.ya?ml)$/;

function trackedImageFiles(root = ROOT) {
  let files;
  try {
    files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n');
  } catch {
    // Not a git checkout (e.g. a fixture tree): walk it.
    files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) walk(rel);
        else files.push(rel);
      }
    };
    walk('');
  }
  return files.filter((f) => f && IMAGE_FILE.test(f) && !f.includes('node_modules/') && !f.startsWith('contracts-archive/'));
}

/** Every image reference a tracked Dockerfile (`FROM`) or compose file (`image:`) names. */
function discoverImages(root = ROOT) {
  const refs = [];
  for (const file of trackedImageFiles(root)) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    // Docker stage names are case-insensitive; `scratch` is the empty image, not a pull.
    const stages = new Set(['scratch']);
    const isStage = (r) => stages.has(r.toLowerCase());
    lines.forEach((line, i) => {
      let m = line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i);
      if (m) {
        // `FROM build` refers to an earlier stage, not an image.
        if (!isStage(m[1])) refs.push({ file, line: i + 1, ref: m[1] });
        if (m[2]) stages.add(m[2].toLowerCase());
        return;
      }
      // `COPY --from=<image>` and `RUN --mount=…,from=<image>` pull images too. A stage name cannot
      // contain ':' or '/', so anything that does is an image.
      for (const f of line.matchAll(/(?:--from=|[,\s]from=)([^\s,]+)/g)) {
        if (/[:/]/.test(f[1]) && !isStage(f[1])) refs.push({ file, line: i + 1, ref: f[1] });
      }
      // Compose / Cloud Run: `image: x`, `- image: x`, a value on the next line, and YAML tags or
      // anchors (`!!str`, `&a`) in front of the value.
      m = line.match(/^\s*(?:-\s+)?image:\s*(.*)$/);
      if (m) {
        let raw = m[1].replace(/\s+#.*$/, '').trim();
        let at = i + 1;
        if (!raw) {
          const next = lines.slice(i + 1).findIndex((l) => l.trim() && !l.trim().startsWith('#'));
          if (next >= 0) {
            raw = lines[i + 1 + next].trim();
            at = i + 2 + next;
          }
        }
        raw = raw.replace(/^(?:(?:!!?\S*|&\S+)\s+)+/, '').replace(/^["']|["']$/g, '');
        if (raw && !raw.startsWith('*')) refs.push({ file, line: at, ref: raw });
      }
    });
  }
  return refs;
}

function splitRef(ref) {
  const [nameTag, digest] = ref.split('@');
  const slash = nameTag.lastIndexOf('/');
  const colon = nameTag.lastIndexOf(':');
  const hasTag = colon > slash;
  return { name: hasTag ? nameTag.slice(0, colon) : nameTag, tag: hasTag ? nameTag.slice(colon + 1) : null, digest: digest || null };
}

function checkImages(registry, refs) {
  const out = [];
  const prefixes = registry.firstPartyPrefixes || [];
  for (const { file, line, ref } of refs) {
    const where = `${file}:${line} \`${ref}\``;
    if (ref.includes('$')) {
      out.push(v('V-05', `${where} is built from a variable. Pin a literal so the version is reviewable and watchable.`));
      continue;
    }
    const { tag, digest } = splitRef(ref);
    const firstParty = prefixes.some((p) => ref.startsWith(p));
    const exempt = (registry.exemptions || []).some((x) => x.file === file && ref.includes(x.contains));

    if (exempt) {
      // Time-boxed by V-02; the floating tag is tolerated, not approved.
    } else if (!digest && (!tag || tag === 'latest')) {
      out.push(v('V-05', `${where} is ${tag ? '`latest`' : 'untagged'}. Pin the exact version that is deployed.`));
    } else if (!firstParty && !digest && !EXACT_TAG.test(tag)) {
      out.push(
        v('V-05', `${where} is a floating tag. Pin an exact x.y.z tag (or a digest) so the build is reproducible and Dependabot can see a bump.`),
      );
    }

    // A registered image must carry its registered pin, first-party or not. Without this, moving a
    // first-party FROM (e.g. the held OZ Relayer base) to another tag passes as long as the old
    // string survives anywhere else in the file.
    const { name } = splitRef(ref);
    for (const p of registry.pins || []) {
      for (const l of p.locations || []) {
        if (l.path !== file || !l.contains.includes(':')) continue;
        const pinnedName = splitRef(l.contains).name;
        if ((name === pinnedName || name.endsWith(`/${pinnedName}`)) && !ref.includes(l.contains)) {
          out.push(v('V-03', `${where} is registered as \`${l.contains}\` (${p.id}). Bump the registry with the file.`));
        }
      }
    }

    if (firstParty) continue;
    const claimed = (registry.pins || []).some((p) => (p.locations || []).some((l) => l.path === file && ref.includes(l.contains)));
    if (!claimed) {
      out.push(v('V-04', `${where} is not claimed by any pin in scripts/deps/version-pins.json. Add it, so something watches it.`));
    }
  }
  // The exemption list must only ever shrink: one that matches nothing is a stale excuse waiting
  // to hide the next floating tag.
  for (const x of registry.exemptions || []) {
    if (!refs.some((r) => r.file === x.file && r.ref.includes(x.contains))) {
      out.push(v('V-04', `exemption for "${x.contains}" in ${x.file} matches no image any more. Remove it.`));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ V-07 */

/**
 * A toolchain LINE declared in many places (e.g. `node-version:` across every workflow) is one pin.
 * Listing a single location would let any other job drift to another line with the gate green, so
 * a pin may declare `scan: { files, pattern }`: every capture of `pattern` in every tracked file
 * matching `files` must equal `pinned`, and at least one must exist.
 */
function checkScans(registry, files, read) {
  const out = [];
  for (const p of registry.pins || []) {
    if (!p.scan) continue;
    let fileRe;
    let re;
    try {
      fileRe = new RegExp(p.scan.files);
      re = new RegExp(p.scan.pattern, 'g');
    } catch (e) {
      out.push(v('V-01', `${p.id}.scan has an invalid regex: ${e.message}`));
      continue;
    }
    let seen = 0;
    for (const f of files.filter((x) => fileRe.test(x))) {
      read(f)
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*#/.test(line)) return;
          for (const m of line.matchAll(re)) {
            seen++;
            if (m[1] !== p.pinned) out.push(v('V-07', `${f}:${i + 1} declares ${m[1]}, but ${p.id} pins ${p.pinned}. Move every declaration together.`));
          }
        });
    }
    if (!seen) out.push(v('V-07', `${p.id}.scan matched nothing. The pattern is wrong, or the pin is stale.`));
  }
  return out;
}

function trackedFiles(root = ROOT) {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
}

/* ------------------------------------------------------------------ V-06 */

function checkWorkflowWiring(workflowPath = WORKFLOW_PATH) {
  if (!fs.existsSync(workflowPath)) {
    return [v('V-06', `${path.relative(ROOT, workflowPath)} is missing. Without it nothing asks upstream, and the registry is a list nobody reads.`)];
  }
  const text = fs.readFileSync(workflowPath, 'utf8');
  const out = [];
  if (!/^\s*schedule:/m.test(text)) out.push(v('V-06', 'version-watch.yml has no `schedule:`. Upstream releases do not push to us.'));
  if (!/check:version-pins:live|check-version-pins\.js\s+--live/.test(text)) out.push(v('V-06', 'version-watch.yml does not run the --live half.'));
  if (/^\s*continue-on-error\s*:/m.test(text)) out.push(v('V-06', 'version-watch.yml must not use continue-on-error (Constitution IV).'));
  return out;
}

/* ------------------------------------------------------------------ live */

/** Numeric x.y.z out of a tag, or null. */
function parseVersion(s) {
  const m = String(s).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The newest stable tag matching `tagPattern` (default: any x.y.z tag). Returns null if none. */
function latestStable(tags, tagPattern) {
  const re = tagPattern ? new RegExp(tagPattern) : null;
  let best = null;
  for (const t of tags) {
    if (PRERELEASE.test(t)) continue;
    if (re && !re.test(t)) continue;
    const ver = parseVersion(t);
    if (!ver) continue;
    if (!best || cmp(ver, best.ver) > 0) best = { tag: t, ver };
  }
  return best ? best.tag : null;
}

function describeBehind(pinned, latest) {
  const a = parseVersion(pinned);
  const b = parseVersion(latest);
  if (!a || !b) return 'unknown';
  if (cmp(a, b) >= 0) return 'current';
  if (b[0] > a[0]) return `${b[0] - a[0]} major`;
  if (b[1] > a[1]) return `${b[1] - a[1]} minor`;
  return `${b[2] - a[2]} patch`;
}

function gitTags(repo, exec = execFileSync) {
  const raw = exec('git', ['ls-remote', '--tags', '--refs', repo], { encoding: 'utf8', timeout: 60_000 });
  return raw
    .split('\n')
    .map((l) => l.split('refs/tags/')[1])
    .filter(Boolean);
}

async function dockerhubTags(image, fetchImpl = globalThis.fetch) {
  const tags = [];
  let url = `https://hub.docker.com/v2/repositories/${image}/tags?page_size=100&ordering=last_updated`;
  // Three pages of the most recently pushed tags is enough to see the newest release of any line.
  for (let page = 0; url && page < 3; page++) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Docker Hub ${res.status} for ${image}`);
    const body = await res.json();
    for (const r of body.results || []) tags.push(r.name);
    url = body.next;
  }
  return tags;
}

async function endOfLife(product, cycle, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`https://endoflife.date/api/${product}.json`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`endoflife.date ${res.status} for ${product}`);
  const rows = await res.json();
  const row = rows.find((r) => String(r.cycle) === String(cycle));
  if (!row) throw new Error(`endoflife.date has no cycle "${cycle}" for ${product}`);
  return row.eol === false ? null : row.eol === true ? 'ended (date unpublished)' : row.eol;
}

/**
 * One reading per pin: { id, state: 'read' | 'unreadable' | 'unwatched', latest?, behind?, eol?, error? }.
 * `latest` exists only on `read`, so "unreadable" can never be rendered as "current".
 */
async function readUpstream(pin, { today, fetchImpl, exec } = {}) {
  const up = pin.upstream || {};
  let eol;
  try {
    // null = the line is supported with no end date published; undefined = no EOL tracked.
    if (pin.eol) eol = await endOfLife(pin.eol.product, pin.eol.cycle, fetchImpl);
  } catch (e) {
    eol = `unreadable (${e.message})`;
  }
  const base = { id: pin.id, pinned: pin.pinned, status: pin.status, owner: pin.owner, eol, eolSoon: eolSoon(eol, today) };
  if (up.type === 'none') return { ...base, state: 'unwatched', why: up.why };
  try {
    const tags = up.type === 'git' ? gitTags(up.repo, exec) : await dockerhubTags(up.image, fetchImpl);
    const latest = latestStable(tags, up.tagPattern);
    if (!latest) return { ...base, state: 'unreadable', error: 'no stable tag matched' };
    return { ...base, state: 'read', latest, behind: describeBehind(pin.pinned, latest) };
  } catch (e) {
    return { ...base, state: 'unreadable', error: e.message.split('\n')[0] };
  }
}

function eolSoon(eol, today) {
  if (typeof eol === 'string' && eol.startsWith('ended')) return true; // ended, date unpublished
  if (!eol || !ISO_DATE.test(eol)) return false;
  return eol <= addDays(today, 90);
}

function renderReport(readings, registry, today) {
  const byId = Object.fromEntries((registry.pins || []).map((p) => [p.id, p]));
  const act = readings.filter((r) => r.eolSoon || (r.state === 'read' && r.behind !== 'current' && r.status === 'track'));
  const unreadable = readings.filter((r) => r.state === 'unreadable');
  const lines = [
    `# Version watch: ${today}`,
    '',
    'Generated by `npm run check:version-pins:live` from `scripts/deps/version-pins.json` (ADR-006).',
    'Being behind is not a defect. Each **track** row that is behind needs a decision at the monthly review:',
    '**bump**, or **hold** with a reason and a reviewBy date. **Hold** rows are listed for visibility; their',
    'reviewBy date is enforced on every PR.',
    '',
    `**Needs a decision:** ${act.length} · **Unreadable:** ${unreadable.length}${
      unreadable.length ? ` (${unreadable.map((r) => r.id).join(', ')})` : ''
    }`,
    '',
    '| Pin | Owner | Status | Pinned | Latest stable | Behind | EOL |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of readings) {
    const hold = byId[r.id] && byId[r.id].hold;
    const status = r.status === 'hold' ? `hold → ${hold ? hold.reviewBy : '?'}` : 'track';
    const latest = r.state === 'read' ? `\`${r.latest}\`` : r.state === 'unwatched' ? '_unwatched_' : `**unreadable**: ${r.error}`;
    const behind = r.state === 'read' ? (r.behind === 'current' ? 'current' : `**${r.behind}**`) : '—';
    const eol = r.eol === undefined ? '—' : r.eol === null ? 'supported' : r.eolSoon ? `**${r.eol}** ⚠` : r.eol;
    lines.push(`| \`${r.id}\` | ${r.owner} | ${status} | \`${r.pinned}\` | ${latest} | ${behind} | ${eol} |`);
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ main */

async function main(argv) {
  const live = argv.includes('--live');
  const json = argv.includes('--json');
  const reportIdx = argv.indexOf('--report');
  const reportPath = reportIdx >= 0 ? argv[reportIdx + 1] : null;
  if (reportIdx >= 0 && (!reportPath || reportPath.startsWith('--'))) {
    console.error('--report needs a file path.');
    return 2;
  }
  const today = new Date().toISOString().slice(0, 10);
  const registry = loadRegistry();

  const violations = [
    ...checkRegistryShape(registry, today),
    ...checkDrift(registry),
    ...checkImages(registry, discoverImages()),
    ...checkScans(registry, trackedFiles(), (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')),
    ...checkWorkflowWiring(),
  ];

  let readings = null;
  if (live) {
    readings = [];
    for (const pin of registry.pins) readings.push(await readUpstream(pin, { today }));
    const md = renderReport(readings, registry, today);
    if (reportPath) fs.writeFileSync(reportPath, md);
    if (!json) process.stdout.write(md);
  }

  if (json) {
    process.stdout.write(JSON.stringify({ violations, readings }, null, 2) + '\n');
  } else if (violations.length) {
    console.error(`\n✗ version-pins: ${violations.length} violation(s)\n`);
    for (const x of violations) console.error(`  [${x.rule}] ${x.message}`);
    console.error('\nPolicy: docs/adr/006-dependency-version-policy.md');
  } else {
    console.log(`✓ version-pins: ${registry.pins.length} pins recorded, every image claimed and exact, no expired holds.`);
  }
  return violations.length ? 1 : 0;
}

module.exports = {
  checkRegistryShape,
  checkDrift,
  checkImages,
  checkWorkflowWiring,
  checkScans,
  trackedFiles,
  discoverImages,
  splitRef,
  latestStable,
  describeBehind,
  parseVersion,
  readUpstream,
  renderReport,
  eolSoon,
  loadRegistry,
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(2);
    });
}
