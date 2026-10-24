# Perps view — visual review record (actor-critic loop)

Captured by `scripts/ui/capture-perps.mjs` against a stubbed gateway (fixture pairs/positions/
config — no live venue data), dev server at 1280×900 and 390×844, deviceScaleFactor 2.

| File | State |
|---|---|
| `perps-desktop-light.png` | Ready state, all venues healthy, light theme, desktop. Merged table + legend row, positions, fee + risk disclosures. |
| `perps-desktop-dark.png` | Same state, dark theme — badge/contrast check. |
| `perps-mobile-light.png` | Ready state at 390px — table scrolls inside its own container; page never scrolls horizontally. |
| `perps-mobile-dark.png` | Same at 390px, dark theme. |
| `perps-degraded-venue.png` | GMX degraded: named banner, GMX pairs absent (never stale-as-live), other venues render. |
| `perps-filters-open-mobile-light.png` | Market controls disclosed at 390px — venue pills + sort inside the panel. Viewport shot, not full-page: how much screen the controls cost before the first pair is the thing under review. |
| `perps-filters-open-mobile-dark.png` | Same, dark theme. |
| `perps-filter-active-collapsed-mobile-light.png` | A live venue filter with the panel CLOSED — the toggle names it and the result count is visible, so a short table is never unexplained. |
| `perps-filter-longest-summary-mobile-light.png` | The widest summary the toggle can carry (longest venue label + a non-default sort) on the narrowest viewport — the toolbar wraps rather than eating the search field. |

Critic findings fixed during the loop (each re-verified by re-capture):

1. **Venue badges unreadable in dark theme** — `--bg-tertiary` pill is light in dark mode →
   switched to a bordered transparent badge that inherits theme text color.
2. **Table clipped its last columns at desktop width** — header InfoTips + wide headers pushed
   `Max leverage`/`Trade ↗` past the container edge with no cue. Fixed by moving term InfoTips
   into a legend row under the table (the Earn convention), naming the funding interval in the
   header (`Funding / 1h`) instead of per cell, tightening cell padding, and shortening chain
   labels ("Arbitrum One" → "Arbitrum"). Verified: table width == container width at 1280.
3. **Forex precision loss** — EUR/USD 1.0841 rendered "1.08"; `formatPairPrice` now keeps up to
   4 decimals for 1 ≤ price < 100.

## Round 2 — market-control density (issue #1440)

The venue pills, the search box and the sort select were three stacked rows, and on a phone the
pills alone wrapped onto two. Together they took roughly a fifth of the viewport before a single
pair was on screen, on a surface whose entire job is the table under them. Search stays on the
toolbar; the venue filter and the sort moved behind a disclosure that is UNMOUNTED when closed.

Collapsing a filter is only safe if the closed control still says what is shaping the table — a
table quietly missing rows is indistinguishable from a venue that stopped reporting, which is the
confusion the rest of this view exists to avoid. So the toggle carries the active filter as a chip,
and the "showing N of M pairs" line (previously `sr-only` always) becomes visible the moment the
search box or the venue filter narrows the list.

Critic findings fixed during this round (each re-verified by re-capture):

4. **The search placeholder truncated mid-word once the toggle carried a filter chip.** The
   toolbar was a non-wrapping row, so the growing button was paid for out of the search field
   ("Search pairs (BTC, ET"). Fixed by letting the toolbar wrap and giving the search a floor of
   the width its own placeholder needs (12rem at 0.9rem). The row stays one line in every default
   state and drops the button to a second line only when a named filter makes the pair too wide —
   two lines beats a search box nobody can read.

Checked and unchanged: both themes at both viewports, no horizontal page scroll, every interactive
target ≥ 36px, the degraded-venue banner, and the desktop table still fitting its container.

## Round 3 — the touch-target floor was a claim, not a fact (PR #1545 review)

Round 2's comment said "every interactive target here clears 36px". It was placed at the top of the
controls block, so it read as governing all four controls — while the venue pills declared 32px and
the sort select declared no floor at all (~28px computed). The prose was true of the toolbar it was
written about and false of the panel it had grown to cover.

Fixed by raising both to the 36px the comment claims, rather than narrowing the comment: the panel
is opened deliberately, so there is nothing to buy by making the controls inside it harder to hit
than the one that revealed them. (32px did pass WCAG 2.2 AA, whose floor is 24px — this is the
repo's own spec-081 density floor, not an accessibility failure.)

The comment now also names its gate. `src/test/perps/perpsControlTargets.test.js` parses the
stylesheet and holds all four selectors to 36px — verified to FAIL on the exact defect (both
selectors, "expected 32 to be greater than or equal to 36") before it was fixed. A paragraph making
a claim about four selectors that nothing checks is how the claim and the code came apart in the
first place.

Re-captured the full matrix afterwards: the taller pills and select change the open panel's height
by 8px and nothing else — no wrap change, no clipping, both themes.

