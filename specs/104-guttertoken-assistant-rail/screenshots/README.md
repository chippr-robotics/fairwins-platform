# Assistant rail screenshots (spec 104)

Actor-critic screenshot loop over the new assistant surfaces: Tools ▸ Assistant (the `assistant-prefs`
chooser + the `guttertoken-key` card), the GutterToken key sheet, and the floating assistant panel
(launcher, chooser, tool round, GutterToken failure states). Captured with
`scripts/ui/capture-assistant-rails.mjs` against a real dev server, a real EIP-1193 wallet stub
(Hardhat account #0), a loopback JSON-RPC stub for the membership reference chain, a loopback stub of
the relay-gateway's `/status` + `/v1/member/wagers` routes, and `context.route` fulfillment of
`https://api.guttertokens.com/v1/messages` (never the real network). The one state unreachable via the
real app (the panel's `choose` step for a non-member with no key — the floating launcher never renders
an entry point for that account, by design) is captured by mounting `AssistantPanel` directly behind a
temporary Vite alias, the same technique `capture-agentic-access.mjs` uses.

9 scenarios × {desktop 1280×900, mobile 390×844} × {light, dark} = 36 shots, all present.

## Shot table

| Scenario | What it shows |
|---|---|
| `tab-member-key-guttertoken` | Assistant tab, paid member with a saved key, GutterToken selected — both radios live and unblocked, the effective line names GutterToken, the GutterToken-key card's own summary shows the redaction (`sk-…wxyz`) even collapsed |
| `tab-nonmember-nokey` | Non-member, no key — FairWins disabled with "Requires an active membership" + a Membership link, GutterToken disabled with "Add a GutterToken key below to use your own credits" |
| `tab-membership-unreadable` | Membership reference-chain RPC fails outright — the FairWins option stays **offered**, in `--warning-bg`/`--warning-text` tone, never hidden or treated as a denial |
| `keysheet-empty` | Key sheet open, nothing pasted — the lead sentence (what the key authorises) reads before the paste field, `Test and save` disabled |
| `keysheet-invalid-format` | Key sheet, `not-a-real-key` typed — the inline format error renders live (no submit needed), the field's border goes to `--danger-color` |
| `panel-guttertoken-tool-round` | Panel on the GutterToken rail after signing the optional read grant and asking about wagers: the provider badge, a completed tool round with **both** Sources chips (`get_wagers` → could-not-be-read, `get_gateway_status` → read), the model's second-call reply, and the per-reply disclaimer |
| `panel-out-of-credit` | GutterToken 403 `insufficient_quota` — a named sentence in a danger box, a "Top up at GutterToken ↗" link, a "Try again" retry, and no assistant bubble |
| `launcher-over-home` | The floating launcher tethered above the real bottom `SectionIconNav` on `/app` (HomeScreen) |
| `panel-chooser-nonmember-nokey` | The panel's `choose` step (non-member, no key): "Use your own GutterToken credits" / "Become a member", each with its cost line — captured via the direct-mount harness, since the real launcher never offers an entry point in this state |

## Rounds

**Round 1** — full 36-shot matrix + the 4 chooser shots. The chooser harness's own vite server
(port 5198) failed its first run (`assistant-choose` never appeared): the harness page never seeded
`assistant_prefs`, so `resolveProvider` returned reason `disabled` (`step: 'disabled'`, not `choose`).
Fixed by seeding `fw_user_<addr>_assistant_prefs = { enabled: true, retainMemory: true, provider:
'fairwins' }` before mount, which yields `reason: 'not-member'` against the inactive membership prop
— exactly the state the shot needs.

Separately, the chooser harness's own `npx vite` child process outlived the script (`server.kill()`
only killed the `npx` wrapper, not the grandchild vite process it spawned), leaving an orphaned server
on port 5198 that had to be killed by hand before round 2. Fixed by spawning
`node_modules/.bin/vite` directly instead of through `npx`.

**Round 2** — full 36-shot matrix, both fixes applied. One finding, from reading every PNG:

- **Finding**: the three `tab-*` scenarios (element screenshots of `[data-testid="assistant-tools-panel"]`,
  which is taller than the 390×844 mobile viewport) showed a **ghosted duplicate** of the sticky
  `.site-header` and the fixed mobile `.section-icon-nav` partway down the card, overlapping the
  "What leaves this device" disclosure text. Root cause: Playwright's element screenshot stitches
  several scrolled tiles for an element taller than the viewport, and any `position: sticky`/`fixed`
  chrome repaints at the same screen coordinates in every tile — so it gets composited into the final
  PNG once per tile. This is a **capture-harness artifact**, not something a member ever sees (a real
  scroll moves sticky/fixed chrome exactly once); confirmed by the equivalent desktop shots (element
  fits in one viewport, no stitching, no ghosting) being clean the whole time.
  **Fix** (harness-only, `capture-assistant-rails.mjs`): before any element (non-full-viewport)
  screenshot, `addStyleTag` hides `.site-header` and `.section-icon-nav`. No component or CSS file
  changed.

**Round 3** — full 36-shot matrix, re-verified. Zero findings. The three `tab-*` mobile shots render
the complete card stack and the full disclosure text with no duplication, no clipping, and no
horizontal scroll, in both themes.

## Observed, not fixed here (out of scope for spec 104)

`launcher-over-home` (the `/app` HomeScreen, Pay tab) shows the floating launcher's circle
overlapping the trailing edge of the "Add a note — e.g. lunch, rent, thanks…" placeholder text. This
is a genuine interaction between `AssistantLauncher`'s fixed bottom-right position and this specific
page's form layout — but `AssistantLauncher`'s positioning (`useBottomNavOffset`, the z-index tier)
is unchanged by spec 104, so the overlap predates this work package and is not a GutterToken-rail
regression. A fix belongs to whichever surface owns the Pay tab's layout (or a shared launcher-offset
rule for forms with a trailing field), not to this spec's cards/sheet/panel. Nothing was changed to
work around it.

## Critic checklist, final round

1. **Legible** — every control (switches, radios, inputs, chips, buttons) reads clearly in both
   themes; the amber "could not be read" reason uses `--warning-bg`/`--warning-text` (dark amber on
   light, amber-on-dark) per `docs/developer-guide/brand-tokens.md`, never a bare `--warning-color`
   fill under body text. No chrome vanishes onto a same-toned background in either theme.
2. **Functional** — the redacted key is the real `redactGutterTokenKey` output over a key
   `validateGutterTokenKeyFormat` accepts; the tool-round reply is the model's real second-call text,
   produced by a real client-side tool loop against a real (stubbed) gateway; the EIP-712 grant
   signature bridged to Node is a real `ethers` signature over the actual `ApiKeyGrant` the panel
   builds. Nothing is a placeholder or a hand-painted state.
3. **Honest** — every error state (format error, key-refused, out-of-credit, membership-unreadable,
   a failed tool read) is a stated sentence with a named action (retry, top up, update key, Go to
   Membership) or an explicit "nothing is wrong with your account," never a bare disabled control or
   a silently-invented answer.
4. **Composed** — no clipped or overflowing content, no horizontal scroll, mobile sheets fit within
   one 390×844 screen with room to spare, and (after the round-2 fix) no capture-stitching ghosts.
5. **Complete** — all 9 requested scenarios are covered at both viewports and both themes. The one
   state that cannot be reached through the real app (`choose` step, non-member/no-key) is
   nonetheless real component output, captured via a direct-mount harness rather than faked.
