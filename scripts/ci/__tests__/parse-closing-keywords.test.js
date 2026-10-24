/**
 * Fixtures for the closing-keyword parser (issue #1460).
 *
 * This decides which issues a merge CLOSES, so the cases that matter are the ones where it must
 * refuse: a number in an example, a number in another repository, a body that closes nothing.
 * Over-matching here silently closes work that is not done.
 *
 * Dependency-free: node:test only.
 */

const test = require('node:test');
const assert = require('node:assert');

const { parseClosingKeywords, KEYWORDS } = require('../parse-closing-keywords.js');

const REPO = 'chippr-robotics/prediction-dao-research';
const parse = (body) => parseClosingKeywords(body, REPO);

test('every keyword GitHub accepts is accepted here', () => {
  for (const kw of KEYWORDS) {
    assert.deepStrictEqual(parse(`${kw} #12`), [12], `${kw} must be recognised`);
    const capitalised = kw[0].toUpperCase() + kw.slice(1);
    assert.deepStrictEqual(parse(`${capitalised} #12`), [12], `${capitalised} must be recognised`);
  }
});

test('THE REGRESSION: a keyword mid-sentence is prose, not an instruction', () => {
  /*
   * This exact string is from PR #1462's own body, explaining that the parser does not interpret
   * negation. On the workflow's first live run it extracted 123, and nothing was closed only
   * because issue #123 happened already to be closed. Had it been open, a documentation change
   * would have closed an unrelated issue.
   */
  const body =
    'the nine keywords, code spans and fences ignored, cross-repo dropped — and negation ' +
    'deliberately *not* interpreted, because GitHub closes on "this does not fix #123" too, and ' +
    'a parser cleverer than the platform is one whose behaviour nobody can predict.'
  assert.deepStrictEqual(parse(body), [], 'a keyword mid-sentence must close nothing')

  for (const prose of [
    'This PR does not fix #123.',
    'Related work that closes #99 is tracked elsewhere.',
    'See the note about how GitHub resolves #7 on merge.',
    'A body that says "fixes #5" in passing should not fix #5.',
  ]) {
    assert.deepStrictEqual(parse(prose), [], `${prose} must close nothing`)
  }
})

test('a closing line still closes, in the shapes people actually write', () => {
  assert.deepStrictEqual(parse('Closes #1460.'), [1460])
  assert.deepStrictEqual(parse('Closes #1460.\n\nSome prose that does not fix #123.'), [1460])
  assert.deepStrictEqual(parse('- Closes #12'), [12])
  assert.deepStrictEqual(parse('* Fixes #12'), [12])
  assert.deepStrictEqual(parse('1. Resolves #12'), [12])
  assert.deepStrictEqual(parse('**Closes** #12'), [12])
  assert.deepStrictEqual(parse('  Closes #12'), [12], 'light indentation is still a closing line')
  // Several on one anchored line: the anchor decides whether the LINE is a closing statement,
  // not how many issues it may name.
  assert.deepStrictEqual(parse('Closes #1, closes #2'), [1, 2])
})

test('a reference without a keyword closes nothing', () => {
  // `Part of #N` is the documented way to say "this advances but does not finish".
  assert.deepStrictEqual(parse('Part of #1460. See also #99.'), []);
  assert.deepStrictEqual(parse('Follow-up to #1461.'), []);
});

test('a number inside code is not an instruction', () => {
  // The failure this guards: a PR body DOCUMENTING this feature contains "Closes #123" as an
  // example, and a parser reading its own documentation would close issue 123.
  assert.deepStrictEqual(parse('Put `Closes #123` in the body'), []);
  assert.deepStrictEqual(parse('```\nCloses #123\n```'), []);
  assert.deepStrictEqual(parse('~~~md\nFixes #123\n~~~'), []);
});

test('another repository is never closed from here', () => {
  // The token is scoped to one repo, and closing someone else's issue on the strength of a PR
  // body is not a power this should have.
  assert.deepStrictEqual(parse('Closes other-org/other-repo#8'), []);
  assert.deepStrictEqual(parse('Fixes https://github.com/other-org/other-repo/issues/8'), []);
});

test('this repository is closed in every form GitHub accepts', () => {
  assert.deepStrictEqual(parse('Closes #1460'), [1460]);
  assert.deepStrictEqual(parse(`Fixes ${REPO}#7`), [7]);
  assert.deepStrictEqual(parse(`Resolves https://github.com/${REPO}/issues/42`), [42]);
  assert.deepStrictEqual(parse('Closes: #5'), [5]);
});

test('several issues, deduplicated and ordered', () => {
  const body = [
    'Closes #30',
    'Closes #10',
    'Fixes #20',
    'closes #10',
    'Part of #999',
  ].join('\n');
  assert.deepStrictEqual(parse(body), [10, 20, 30]);
});

test('an empty or malformed body yields nothing rather than throwing', () => {
  for (const body of ['', null, undefined, '#1460', 'closes #', 'closes #0']) {
    assert.deepStrictEqual(parse(body), [], `${JSON.stringify(body)} must yield nothing`);
  }
});

test('a repo name that is not owner/name yields nothing', () => {
  assert.deepStrictEqual(parseClosingKeywords('Closes #1', 'not-a-repo'), []);
  assert.deepStrictEqual(parseClosingKeywords('Closes #1', ''), []);
});

test('negation is still NOT interpreted ON AN ANCHORED LINE, matching GitHub', () => {
  // The narrowing is about WHERE the parser looks, not about understanding English. A line that
  // opens with a closing keyword closes, whatever the sentence goes on to say — exactly as GitHub
  // does. Being cleverer than the platform about meaning is what makes behaviour unpredictable.
  assert.deepStrictEqual(parse('Closes #12, though arguably it does not'), [12]);
  assert.deepStrictEqual(parse('Fixes #12 partially'), [12]);
});
