# Runbook: keyed RPC access (spec 107)

The gateway mints short-lived, read-only credentials for the platform's keyed RPC endpoints so the
SPA can read chain state without the endpoint URL ever being sufficient on its own. This page is
the operational half: what to check, what each refusal means, and how to rotate the signing key.

> **Verified in production on 2026-09-06 (v1.17.0).** Every command below was run against the live
> estate; the results are recorded on issue #1473. Re-run the verification after any change to the
> issuance path or the provider's endpoint security.

## What is deployed

| Piece | Where |
|---|---|
| Issuance route | `POST /v1/access/rpc` on the gateway (`services/relay-gateway/src/access/`) |
| Signing key | Secret Manager `fairwins-rpc-access-signing-key`, delivered as `RPC_ACCESS_SIGNING_KEY` |
| Key id (`kid`) | `infra/vm/gateway/docker-compose.yml` → `RPC_ACCESS_SIGNING_KID` |
| Provider admin key | Secret Manager `finops-quicknode-key`, delivered as `RPC_ACCESS_ADMIN_KEY` |
| Endpoint | QuickNode endpoint `657013`, per-chain URLs in compose |

Both credentials are **optional** in `fetch-secrets.sh`: a missing accessor grant does not abort the
boot, it kills issuance and says so on one journal line. Always read that line before trusting a
deploy:

```bash
sudo journalctl -u fairwins-secrets@gateway -n 80 --no-pager | grep -iE 'RPC_ACCESS|unavailable'
```

## Verifying issuance

```bash
curl -sS -X POST https://relay.fairwins.app/v1/access/rpc \
  -H 'Content-Type: application/json' -d '{"chainId":137}'
```

A healthy answer carries `endpoint`, `credential` (an ES256 JWT whose header states the `kid`),
`expiresAt` and the read-only `permits` list.

**Read the refusals literally — they mean different things:**

| Answer | Meaning |
|---|---|
| `404` | The route does not exist ⇒ **the old image is still running**. NOT "this chain is unserved". |
| `404 chain_unavailable` | Normal and permanent for chains with no issuance endpoint (ETC 61, Mordor 63). Public capacity is the correct path there. |
| `503 access_unconfigured` | The signing key/kid never reached the process. Restart `fairwins-secrets@gateway`, then the stack. |
| `503 endpoint_unverified` | The provider's admin API could not be read (usually `RPC_ACCESS_ADMIN_KEY` missing). **Not** evidence the endpoint is unprotected. |
| `503 endpoint_unprotected` | The endpoint stopped enforcing at the provider — JWTs off, request filter off, or a non-read method in the whitelist. |
| `429` | Mint quota for this subject. The refusal says the current credential remains valid. |

`unverifiable` **refuses** here, unlike everywhere else in the gateway where it is a retryable 503.
That asymmetry is deliberate (FR-026): failing open would transmit a credential that may be
sufficient by itself. Do not "fix" it to match FR-009.

## The four invariants, and how to prove each

```bash
RESP=$(curl -sS -X POST https://relay.fairwins.app/v1/access/rpc \
        -H 'Content-Type: application/json' -d '{"chainId":137}')
CRED=$(echo "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["credential"])')
EP=$(echo   "$RESP" | python3 -c 'import json,sys;print(json.load(sys.stdin)["endpoint"])')
```

1. **The URL alone is never sufficient** (FR-026) — no credential ⇒ `401`:
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$EP" \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
   ```
2. **Reads work with it** — expect a block number.
3. **Writes are refused by the provider's filter** (SC-006) — expect JSON-RPC **`-32611`**:
   ```bash
   curl -sS -X POST "$EP" -H "Authorization: Bearer $CRED" \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0xdeadbeef"]}'
   ```
   Any *other* error is a **failure**, even though nothing was mined — it means something other
   than the filter stopped it.
4. **An expired credential is refused** (SC-008) — replay the same token after `expiresAt`; expect
   `401 UNAUTHORIZED`.

## Rotating the signing key — by SUCCESSION, never cutover

**SIGHUP cannot do this.** The `kid` is container environment (frozen at exec) and the key is loaded
once at boot; `policy/reload.js`'s allowlist deliberately refuses both, because a key swappable by
editing a file and signalling is a key swappable by anyone who can write that file. **Rotation rides
a release.**

Order matters — getting it wrong strands every outstanding credential at once:

1. **Add** the successor private key as a new version of `fairwins-rpc-access-signing-key`.
   Never write the payload to disk or through `$( )` (spec 097 rule 4).
2. **Register** the successor *public* key at the provider under a **new** kid. The predecessor's
   record stays. Verify it landed — the admin API does return the JWT records
   (`{"name":"fairwins-issuer-k1","kid":"k1",…}`), so this is checkable, not an act of faith.
3. **Flip** `RPC_ACCESS_SIGNING_KID` in compose → staging → promote → deploy the VM
   (`docs/runbooks/credential-rotation.md` § "Deploying a change to the VMs").
4. **Confirm** a fresh mint carries the new kid and reads succeed with it.
5. **Retire** the predecessor kid at the provider — **only** after ≥ the longest issued TTL has
   elapsed since the last predecessor mint. This step is **irreversible**.

Outstanding credentials keep working across steps 3–4 because the predecessor's public key is still
registered: that is what makes "zero failed reads" (SC-003) true. Note that property has **no
instrumentation** — the only signal is the absence of the degradation sentence in the portfolio UI,
so record it as an observation, not a measurement.

## Stopping issuance in an incident

`RPC_ACCESS_KILLSWITCH` is SIGHUP-reloadable and is the only lever that does not need a container
recreate. **It does not survive a secrets restart** — see issue #1495: the switch is absent from
compose and `fetch-secrets.sh` truncates the reload env file on every run, so an appended line is
erased by the next fetch, reboot or recreate. Treat it as a live-process lever only, and re-apply it
after any restart until #1495 is resolved.

Losing issuance is not an outage: clients fall back to public capacity. The member-visible cost is
throughput, never access.

## See also

- `docs/developer-guide/caller-identity.md` — the tier ladder and what each verifier proves
- `docs/runbooks/credential-rotation.md` — every other credential, and the VM deploy sequence
- `specs/107-keyed-rpc-access/` — the spec, and #1473 for the recorded live-fire results
