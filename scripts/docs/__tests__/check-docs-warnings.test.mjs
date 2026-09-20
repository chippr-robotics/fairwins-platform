import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWarnings, verdict } from '../check-docs-warnings.mjs'

/*
 * The counting rule is the whole gate, so it is driven against the output that actually broke it.
 */

test('counts only lines mkdocs emits as warnings', () => {
  const output = [
    'INFO    -  Cleaning site directory',
    "WARNING -  Doc file 'a.md' contains a link './B.md', but the target is not found.",
    "WARNING -  Doc file 'c.md' contains a link './D.md', but the target is not found.",
    'INFO    -  Documentation built in 4.21 seconds',
  ].join('\n')
  assert.equal(parseWarnings(output).length, 2)
})

test('does NOT count a FILENAME that contains the word', () => {
  // The real miscount: mkdocs echoes the nav tree, and one page is named
  // `research/FRIEND_MARKET_WARNING_UI.md`. `grep -c WARNING` returns 103 where the true
  // count is 102 — a budget one too generous, forever, which is exactly the slack a
  // regression needs to slip through unnoticed.
  const output = [
    '  - research/FRIEND_MARKET_WARNING_UI.md',
    "WARNING -  Doc file 'a.md' contains a link './B.md', but the target is not found.",
  ].join('\n')
  const warnings = parseWarnings(output)
  assert.equal(warnings.length, 1)
  assert.ok(!warnings[0].includes('FRIEND_MARKET'))
})

test('does not count the word inside a warning message body', () => {
  const output = "WARNING -  Doc file 'x.md' contains a link './WARNING-NOTES.md', but the target is not found."
  assert.equal(parseWarnings(output).length, 1)
})

test('empty output is zero warnings, not a crash', () => {
  assert.equal(parseWarnings('').length, 0)
  assert.equal(parseWarnings(undefined).length, 0)
})

test('a rise fails and says how many were added', () => {
  const v = verdict(105, 102)
  assert.equal(v.ok, false)
  assert.equal(v.code, 'over')
  assert.match(v.message, /adds 3/)
})

test('a fall fails too, telling you to lock the improvement in', () => {
  // Shrink-only is the point: a fix that leaves the budget high has bought nothing, because the
  // next regression fits in the gap it left.
  const v = verdict(99, 102)
  assert.equal(v.ok, false)
  assert.equal(v.code, 'under')
  assert.match(v.message, /Lower the budget to 99/)
})

test('at budget passes', () => {
  const v = verdict(102, 102)
  assert.equal(v.ok, true)
  assert.equal(v.code, 'exact')
})
