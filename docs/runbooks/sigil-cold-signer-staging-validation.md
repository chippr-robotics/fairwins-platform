# Sigil cold signer: staging validation with a real disk (spec 111)

CI proves the app, the adapter and the **real** bridge against a stand-in daemon
(`fast/51-protect-sigil`, `full/46-sigil-operate-as-send`). This protocol covers the part CI
cannot reach: the real `sigil-daemon`, the 2-party presignature combination, and a floppy. Run it
on staging before calling a release Sigil-ready, and record the result on the release issue.

## Prerequisites

- A computer with a floppy drive (USB is fine) and the Sigil agent material imported:
  - `sigil import-agent-shard`;
  - `sigil import-child-shares`, from the mother's encrypted QR / file.
- `sigil-daemon` built from a Sigil version that includes chippr-robotics/sigil#66 (`child_pubkey` in `DiskStatus`). Check with `sigil disk`, which must print a `Public key:` line.
- A child disk created by `sigil-mother` with presignatures remaining.
- Node ≥ 20 and a checkout of this repository, for `services/sigil-bridge`.
- A small amount of testnet gas on the disk's address (Amoy for a testnet build). Get the address from step 2.

## Protocol

| # | Step | Pass when |
|---|---|---|
| 1 | Start the bridge: `node services/sigil-bridge/src/main.js --allow-origin <staging origin> --confirm` | It prints the listen address, the socket and the token **file** path. It never prints the token. |
| 2 | Staging ▸ Protect ▸ Off chain ▸ Add ▸ **Sigil**. Paste the token file's contents, insert the disk, then Connect. Allow local-network access if the browser asks. | The pick step shows one account. The address matches what `sigil disk` implies. The "N of M signatures left" figure equals `sigil presig-count`. |
| 3 | Save the account and reload the page. | The account is listed with the **Sigil** badge. DevTools ▸ Application ▸ Local storage: the token appears only under `fw_global_prefs.sigil_bridge`, never in `…_hardware_accounts`. |
| 4 | Remove the disk and try to connect again. | "No Sigil disk is inserted…" `sigil presig-count` is unchanged. |
| 5 | Reinsert the disk. Act as the Sigil account (identity caret) ▸ Protect ▸ Verify ▸ Sign a message. | The reconnect dialog says the disk is the consent, not a device screen. The bridge terminal prompts `[y/N]` with an EIP-191 description. After `y`, the Check sheet verifies the signature as **valid** for the Sigil address. |
| 6 | Home ▸ Pay a small amount to a second address you control, as the Sigil account. Answer `y` at the bridge. | The transaction settles on the explorer **from the Sigil address**. `sigil presig-count` fell by exactly 1. The disk usage log records the tx hash; check it at the mother during reconciliation. |
| 7 | Repeat step 6 and answer `n` at the bridge. | The app says the signature was declined at the bridge. Nothing is broadcast and no presignature is spent. |
| 8 | Insert a **different** Sigil disk and try to send as the saved account. | "The inserted Sigil disk belongs to a different account…" No presignature is spent from either disk. |
| 9 | Stop the bridge and try to send. | "The Sigil bridge on this computer did not answer…" |

Record the Sigil commit, the bridge version (`GET /v1/health`), the browser version, the chain, the
transaction hash from step 6, and the presig counts before and after.

## Known limits (not failures)

- There is **no proof-of-execution check** yet (chippr-robotics/sigil#67). Do not treat `proof_hash` in Sigil's own logs as one.
- Bitcoin and FROST schemes are out of scope (see the developer guide).
