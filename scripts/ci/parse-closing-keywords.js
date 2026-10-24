#!/usr/bin/env node
/**
 * Extract the issues a pull request body says it closes (issue #1460).
 *
 * WHY THIS EXISTS. GitHub honours closing keywords only when a PR merges into the repository's
 * DEFAULT branch. Here that is `main`, and every feature PR targets `staging` by design (spec 076),
 * so no feature PR in this repo has ever auto-closed anything — PR #1461 merged with `Closes #1460`
 * in its body and #1461 stayed linked to nothing, with the issue still open. The later
 * `staging` -> `main` promotion does not rescue it either: GitHub reads THAT PR's body.
 *
 * `close-linked-issues.yml` closes them on the merge into `staging` instead. This file is the part
 * with logic in it, so it is separated out and tested against fixtures rather than living as a
 * regex inside a workflow step where nothing can exercise it.
 *
 * It follows GitHub's rules — the nine keywords case-insensitive, `#123` / `owner/repo#123` /
 * full issue URLs, code spans and fenced blocks ignored — with ONE deliberate narrowing:
 *
 *   **A CLOSING KEYWORD ONLY COUNTS AT THE START OF A LINE.**
 *
 * GitHub matches a keyword anywhere in the body. That is safe for GitHub because its UI shows you
 * the linked issues BEFORE you merge; nothing shows you what this workflow will do. Combined with
 * a repository whose pull-request bodies discuss closing keywords in prose, anywhere-matching is
 * a loaded gun.
 *
 * It went off on the very first run (PR #1462, 2026-09-05). That body explained, in prose, that
 * the parser does not interpret negation — using the words `does not fix #123` — and the parser
 * dutifully extracted 123. Nothing was harmed only because issue #123 happened to already be
 * closed and the caller skips those. Had it been open, an unrelated issue would have been closed
 * by a documentation change.
 *
 * The asymmetry decides it: an issue that fails to close is VISIBLE and one command from fixed,
 * while an issue closed by mistake is silent and looks like a decision somebody made. So the
 * narrowing costs a mid-sentence "this closes #12" — which nobody writes when they mean it,
 * because every PR template puts `Closes #N` on its own line — and buys the removal of a whole
 * class of accident.
 *
 * Negation is still NOT interpreted, on an anchored line: "Closes #12" and "Does not close #12"
 * both close, exactly as GitHub does. A parser cleverer than the platform about ENGLISH is one
 * whose behaviour nobody can predict; a parser stricter than the platform about WHERE it looks is
 * merely a narrower, statable rule.
 *
 * Cross-repository references are dropped: this runs with a token scoped to one repository, and
 * closing an issue somewhere else on the strength of a PR body is not a power this should have.
 *
 * Dependency-free. Usage:
 *   node scripts/ci/parse-closing-keywords.js --repo owner/name [--body-file path]
 * Prints one issue number per line (deduplicated, ascending); prints nothing when there are none.
 */

const fs = require('fs');

const KEYWORDS = [
  'close',
  'closes',
  'closed',
  'fix',
  'fixes',
  'fixed',
  'resolve',
  'resolves',
  'resolved',
];

/**
 * Remove fenced blocks and inline code spans.
 *
 * Not cosmetic: a PR body that documents this very feature will contain the string "Closes #123"
 * inside an example, and a parser that reads its own documentation as an instruction would close
 * whatever number the example used.
 */
function stripCode(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/**
 * True when a line OPENS with a closing keyword, allowing the markdown that normally precedes one:
 * a list marker, and/or bold/italic emphasis. `- **Closes** #12` is somebody closing an issue;
 * `because GitHub closes on "does not fix #123"` is somebody writing a sentence.
 */
const ANCHORED = new RegExp(
  `^\\s{0,3}(?:[-*+]\\s+|\\d+[.)]\\s+)?[*_]{0,2}(?:${KEYWORDS.join('|')})\\b`,
  'i',
);

/**
 * Issue numbers the body closes, for `repoFullName` only.
 *
 * Only lines that OPEN with a closing keyword are considered — see the header. Within such a line
 * every keyword+reference pair is taken, so `Closes #1, closes #2` works; the anchor is about
 * whether the line is a closing statement at all, not about how many it may name.
 *
 * @param {string} body PR body markdown
 * @param {string} repoFullName "owner/name"
 * @returns {number[]} ascending, deduplicated
 */
function parseClosingKeywords(body, repoFullName) {
  const [owner, repo] = String(repoFullName || '').split('/');
  if (!owner || !repo) return [];

  const text = stripCode(body)
    .split('\n')
    .filter((line) => ANCHORED.test(line))
    .join('\n');

  const found = new Set();
  const kw = KEYWORDS.join('|');

  // `Closes #123` / `Closes owner/repo#123`
  // `[*_]{0,2}` after the keyword: `**Closes** #12` is a shape people write, and without it the
  // line anchors but the reference never extracts — a silent no-op, which is the worst outcome for
  // something whose whole job is to be predictable.
  const shortForm = new RegExp(
    `\\b(?:${kw})\\b[*_]{0,2}\\s*:?\\s+(?:([\\w.-]+)\\/([\\w.-]+))?#(\\d+)`,
    'gi',
  );
  for (const m of text.matchAll(shortForm)) {
    const [, mOwner, mRepo, num] = m;
    // A bare `#123` means this repository; a qualified one must name it.
    if (mOwner && (mOwner.toLowerCase() !== owner.toLowerCase() || mRepo.toLowerCase() !== repo.toLowerCase())) {
      continue;
    }
    found.add(Number(num));
  }

  // `Closes https://github.com/owner/repo/issues/123`
  const urlForm = new RegExp(
    `\\b(?:${kw})\\b[*_]{0,2}\\s*:?\\s+https?:\\/\\/github\\.com\\/([\\w.-]+)\\/([\\w.-]+)\\/issues\\/(\\d+)`,
    'gi',
  );
  for (const m of text.matchAll(urlForm)) {
    const [, mOwner, mRepo, num] = m;
    if (mOwner.toLowerCase() !== owner.toLowerCase() || mRepo.toLowerCase() !== repo.toLowerCase()) {
      continue;
    }
    found.add(Number(num));
  }

  return [...found].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
}

function main(argv) {
  const repoIdx = argv.indexOf('--repo');
  const fileIdx = argv.indexOf('--body-file');
  const repoFullName = repoIdx !== -1 ? argv[repoIdx + 1] : process.env.GITHUB_REPOSITORY;

  if (!repoFullName) {
    console.error('Error: --repo owner/name (or GITHUB_REPOSITORY) is required.');
    return 2;
  }

  let body = '';
  if (fileIdx !== -1 && argv[fileIdx + 1]) {
    body = fs.readFileSync(argv[fileIdx + 1], 'utf8');
  } else {
    body = fs.readFileSync(0, 'utf8'); // stdin
  }

  for (const n of parseClosingKeywords(body, repoFullName)) console.log(n);
  return 0;
}

module.exports = { parseClosingKeywords, stripCode, KEYWORDS, ANCHORED };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
