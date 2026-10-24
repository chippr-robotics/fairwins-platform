# Spec 108 — actor-critic screenshot record

Harness: `scripts/ui/capture-wrap-multi.mjs` (Playwright against the dev server on :5199).
Matrix: 4 scenarios × {desktop 1280×900, mobile 390×844} × {light, dark} = 16 shots.

Real machinery, not posed pixels: balances are live reads against two loopback stub chains —
Polygon 137 (the wallet's chain, 12.5 POL / 4.25 WPOL) and ETC 61 (3.2 ETC / 0 WETC) — routed by
the spec-069 member RPC override; the other four mainnet-cohort coins are deliberately unrouted so
their rows photograph the app's own unread state ("…"), and the refusal shot is the wallet mock
genuinely rejecting `wallet_switchEthereumChain` (EIP-1193 4001).

| Scenario | What it shows |
|---|---|
| `wrap-default-*` | Landed view: the picker leads, default = the wallet's chain's coin, both balances read, fee line names the target coin. |
| `wrap-picker-*` | Open picker: all six mainnet-cohort coins with network sub-badges; read balances beside honest "…" unread rows; selected row highlighted; search field. |
| `wrap-cross-chain-*` | ETC selected while the wallet sits on Polygon: the Network preview row and the button both disclose the coming switch ("Wrap ETC on Ethereum Classic"). |
| `wrap-refused-switch-*` | The declined switch: the alert names BOTH chains ("runs on Ethereum Classic, but the wallet stayed on Polygon — nothing was sent"), no success state anywhere. |

## Round 1 — clean (no findings)

The critic pass over all 16 frames found nothing to fix:

- **Legible** in both themes: the picker rows, disclosure row and alert all hold contrast on dark;
  the disabled submit takes the spec-091 disabled fill/label pair rather than a washed opacity.
- **Functional**: the numbers on screen are chain reads from the loopback stubs, and the two read
  rows visibly differ (12.5 vs 3.2) — not one copied figure.
- **Honest**: unread rows show "…" and stay selectable; the refusal is a stated sentence naming
  both chains, not a bare disabled control.
- **Composed**: no clipping or horizontal scroll; the mobile picker scrolls inside its own
  popover; the mobile refusal alert sits below the fold at capture scroll position — page scroll
  reaches it, and the sentence is fully legible in-frame.

## Not photographed (documented, not faked)

- The **unavailable passkey rail** (`wrap-rail-unavailable`) needs a real passkey session; it is
  pinned by `WrapView.test.jsx` ("renders an unavailable rail's reason in place of the submit
  control") instead.
- The **settled cross-chain wrap** (post-switch success) needs a chain that accepts the
  transaction; it is the on-chain tier's WXC-01 (`full/45-wrap-cross-chain.cy.js`), a real
  deposit() asserted from the chain.
