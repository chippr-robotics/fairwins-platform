# sigil-bridge

> **NOT IN SIGIL'S TCB.** This is a convenience transport outside Sigil's trusted computing base,
> built in this repository because Sigil's constitution (Principle I, III; `SECURITY.md` invariant
> 3) keeps every HTTP listener out of `chippr-robotics/sigil`. It cannot cause a signature by
> itself: every signature still needs the Sigil disk in the drive and `sigil-daemon` running.

A loopback HTTP bridge that lets a FairWins browser tab on **this computer** ask the local
`sigil-daemon` for signatures (spec 111, Protect ▸ Off chain ▸ Sigil). No dependencies, only
Node built-ins, Node ≥ 20.

## Run it

On the computer that holds the Sigil agent shard, with `sigil-daemon` running:

```bash
node services/sigil-bridge/src/main.js --allow-origin https://<your FairWins origin>
```

It prints where the pairing token lives. It does **not** print the token itself:

```
sigil-bridge 1.0.0 listening on http://127.0.0.1:7318
  daemon socket: /run/user/1000/sigil.sock
  allowed origins: https://<your FairWins origin>
  pairing token (new): /run/user/1000/sigil-bridge.token
```

In FairWins, open **Protect ▸ Off chain ▸ Add ▸ Sigil**. Keep the bridge address
(`http://127.0.0.1:7318`), paste the contents of the token file, insert the disk and connect. The
browser may ask to let the site reach devices on your local network: allow it. That prompt is
Chrome's Local Network Access, and the bridge opts in to it on its preflight.

| Option | Default | |
| --- | --- | --- |
| `--allow-origin <origin>` | *(required)* | Repeatable. Also `SIGIL_BRIDGE_ORIGINS` (comma-separated). A wildcard is refused. |
| `--port <n>` | `7318` | |
| `--host <addr>` | `127.0.0.1` | Anything but loopback also needs `--allow-non-loopback`, and logs a warning. |
| `--socket <path>` | `$XDG_RUNTIME_DIR/sigil.sock`, else `/run/sigil/sigil.sock` | Same resolution as `sigil-daemon`. Also `SIGIL_SOCKET`. |
| `--token-file <path>` | `$XDG_RUNTIME_DIR/sigil-bridge.token`, else `~/.config/sigil-bridge/token` | Created `0600` on first run. A group- or world-readable file is refused. |
| `--confirm` | off | Asks `[y/N]` on this terminal before every signature, showing the description, chain and digest. Needs a TTY. |

Run it as a user in the daemon's `sigil` group. The daemon's socket permission still applies
underneath the bridge.

## Security model

Each rule answers a named attacker:

| Attacker | Defence |
| --- | --- |
| A malicious page in another tab | **Origin allowlist.** An unlisted origin gets `403`, no CORS headers, and never reaches the daemon.<br>**Pairing token** (`Authorization: Bearer`, compared in constant time).<br>**JSON-only bodies**, so no "simple" cross-site POST reaches a handler. |
| DNS rebinding (`evil.example` → 127.0.0.1) | The `Host` header must name the loopback listener. Anything else gets `421` before any other check. |
| Another local user | The token file is `0600`. The daemon socket's own `0660` group permission stays underneath. |
| Key exfiltration | **There is no route that accepts or returns key material.** The daemon client has no import function at all. `ImportAgentShard` / `ImportChildShares` stay CLI-only, as Sigil Principle IV requires. |
| Two tabs racing one floppy | Signatures are serialized. Each one re-checks the disk and spends one presignature. |

## API

All routes except `/v1/health` need `Authorization: Bearer <token>` and `content-type: application/json`.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /v1/health` | — | `{ service, version }`. It says nothing about the disk. |
| `POST /v1/status` | `{}` | `{ daemon: { version }, disk: { detected, childId, publicKey, presigsRemaining, presigsTotal, daysUntilExpiry, valid } }` |
| `POST /v1/sign` | `{ digest: 0x…32 bytes, chainId, description, expectedPublicKey? }` | `{ signature: 0x r‖s (64 bytes, low-S, no v), presigIndex, presigsRemaining }` |
| `POST /v1/tx-hash` | `{ presigIndex, txHash }` | `{ recorded: true }`. Writes the broadcast hash into the disk usage log. |

Refusals are `{ ok: false, error: { code, message } }`:

- `unauthorized` (401)
- `origin_not_allowed` (403)
- `bad_host` (421)
- `bad_request` (400/413/415)
- `no_disk`, `disk_invalid`, `disk_exhausted`, `wrong_disk` (409). These are checked **before** signing, so a refusal never spends a presignature.
- `operator_declined` (403)
- `daemon_unreachable` (503)
- `daemon_timeout` (504)
- `daemon_refused`, `daemon_protocol` (502)

The daemon's `proof_hash` is deliberately **not** forwarded. Today it is a hash of public data, not
a proof of execution (chippr-robotics/sigil#67).

`publicKey` needs a daemon that reports `child_pubkey` (chippr-robotics/sigil#66). Against an
older daemon the app says so and signs nothing.

## Tests

```bash
cd services/sigil-bridge && node --test test/*.test.js
```

The suite runs against a stand-in daemon on a real Unix socket. CI runs it as **Sigil Bridge
Tests**. The browser path is covered end to end by `frontend/cypress/e2e/fast/51-protect-sigil`
and `full/46-sigil-operate-as-send`, both of which drive this bridge's real code.
