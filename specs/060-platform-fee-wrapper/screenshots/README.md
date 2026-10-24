# Platform-fee disclosure — actor-critic screenshot rounds

Captured by `scripts/ui/capture-platform-fees.mjs` while writing the end-to-end fee coverage for
[#1233](https://github.com/chippr-robotics/fairwins-platform/issues/1233). The flow tests
prove the *arithmetic* — that the amount taken on chain matches the rate that was rendered. These
shots are the other half: that the rendered thing is legible, honest, and visibly different in each
of the three states a member can meet.

```bash
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright     # once
npm run dev --workspace frontend -- --port 5199 --strictPort &
NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-platform-fees.mjs
```

## The matrix

Four scenarios × {desktop 1280×900, mobile 390×844} × {light, dark} = 16 shots. The only thing that
changes between the first three is what the `FeeRouter` answers, because those three states are
supposed to look meaningfully different and whether they do is the review.

| Scenario | World | What it must show |
|---|---|---|
| `deposit-fee-charged` | `earn.lend` at 100 bps | The rate, the fee in the token's own units, and what actually reaches the vault |
| `deposit-fee-zero` | `earn.lend` at 0 bps | **No fee line at all** — not a line reading 0 |
| `deposit-fee-unreadable` | the router does not answer | Deposits blocked, said in a sentence, submit disabled, withdrawals explicitly unaffected |
| `admin-fees` | the operator's Fees tab | Live rates, hard caps, enforcement kind, the change form and the audit history |

Everything under review is real — the components, their CSS, the theme tokens. The world behind them
is posed at the app's own seams: chain reads via the spec-069 member RPC override to a loopback
stub, an EIP-6963 wallet on Polygon, and Morpho's vault API fulfilled by the harness (there is no
vault list without it, and the list is not what is under review).

## Rounds

### Round 1 — one finding, fixed

**The fee-services table was clipped at phone width.** `admin-fees-mobile-*` cut the **Enforcement**
column off mid-word with no way to reach it, and the table pushed the page sideways. That column is
the one that says whether a service is *charged on chain* or only *read by the gateway* — i.e.
whether a rate costs a member money — so an operator on a phone could read a rate without being able
to read what enforces it.

Fixed in `FeesTab.jsx` by wrapping both tables in `.admin-table-scroll`, the container
`AccessControlApp` and `MaintenanceApp` already use; no new CSS. Measured after: the table is 358px
inside a 252px scroll container and the document is 390px in a 390px viewport — reachable, and the
page no longer scrolls horizontally.

The harness now **asserts** this on every shot rather than leaving it to the eye: a full-page
screenshot is taken at the document's own width, so a clipped column and a sideways page look
identical in the PNG. See the overflow check in `captureOnce`.

### Round 2 — clean

All 16 shots re-captured with no findings. Reviewed against the checklist: every control is visibly
a control in both themes; the shots show real balances and a real disabled state rather than
placeholders; the blocked state is a stated sentence, not a spinner; nothing is clipped and the
sheets fit one screen at 390px in every step.

## Open finding — NOT fixed here, and why → #1260

**The primary button's label fails contrast in dark mode, app-wide.** `.earn-btn.primary` fills with
`var(--brand-primary)` (`#83B9C4` in dark) and hardcodes `color: #fff` — **2.16:1**, against 4.5:1
for a 15px non-bold label and below even the 3:1 large-text floor. It is most visible on
`Deposit USDC`, the control a member presses to accept a disclosed fee. Compare
`fees-deposit-fee-charged-desktop-dark.png` with `fees-deposit-fee-unreadable-desktop-dark.png`: the
disabled state is only `opacity: 0.55` over the same pale fill, so enabled and disabled are barely
distinguishable there too.

The design system already carries the right answer and the component bypasses it:
`--primary-button` / `--primary-button-text` are a matched pair (`#2E7D8C` + white at 4.74:1 in
light; `#6FAEBB` + Gunmetal `#1C333B` at 5.33:1 in dark). So the fix is to *use the tokens*, never to
darken one — spec 090 is explicit that Chippr Teal is a large-text-and-fill colour.

Three guards look adjacent and none of them sees it: `tokenContrast.test.js` audits the palette
(and the correct pair passes), `noHardcodedColors.test.js` exempts white as an absolute, and
`cy.a11yScan()` runs one theme. What is missing is a *usage* guard.

It is left open deliberately: **66 rules across 43 stylesheets carry the same brand-token fill +
white label**, so changing Earn alone would make one surface disagree with its neighbours — the
structural case the skill says to stop patching pixels for. Tracked as **#1260**, with the
enumeration script and the triage note (a handful of those rules are decorative badges whose labels
may legitimately sit under the 3:1 rule).
