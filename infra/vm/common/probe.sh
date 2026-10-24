#!/usr/bin/env bash
#
# infra/vm/common/probe.sh — periodic functional probe, run every 60s by fairwins-probe.timer.
#
# Emits single-line records to stderr -> journald -> Ops Agent -> Cloud Logging, where the log-based
# metric `fairwins_probe_failures` counts every "fairwins-probe FAIL" line and an alert policy pages.
#
# This covers what the uptime checks structurally CANNOT:
#   * numeric thresholds (gas-wallet runway) — a string matcher cannot express "< 24 hours"
#   * a crash-looping engine (the gateway serves /status, the paymaster and the proxies without it,
#     so an uptime check stays green while relaying is dead)
#   * a Cloud Run bundler re-armed by a merge to main — two executors on one EOA, invisible in-band
#
# Secrets are NEVER placed on a command line (/proc/<pid>/cmdline is world-readable). Where the
# origin-lock header is needed, it is passed via a curl config file on stdin.
set -uo pipefail
ROLE="${1:?role required}"

ok()   { printf 'fairwins-probe OK %s %s\n'   "$ROLE" "$*" >&2; }
bad()  { printf 'fairwins-probe FAIL %s %s\n' "$ROLE" "$*" >&2; RC=1; }
RC=0

case "$ROLE" in
  bundler)
    # Straight to alto at :3000 inside the namespace. Host :8080 is the origin-lock nginx, which
    # 403s any request lacking Cloudflare's X-Origin-Auth header once the lock is armed — probing
    # through it reports a perfectly healthy alto as down, every minute, forever.
    if docker exec fairwins-bundler-alto wget -qO- --timeout=8 \
         --header='Content-Type: application/json' \
         --post-data='{"jsonrpc":"2.0","id":1,"method":"eth_supportedEntryPoints","params":[]}' \
         http://127.0.0.1:3000 2>/dev/null | grep -q 0x5FF137D4; then
      ok entrypoints
    else
      bad "alto not serving eth_supportedEntryPoints"
    fi
    # alto binds its listener only after a successful RPC round trip, so a stale/failing upstream
    # shows up here rather than as a dead port.
    if docker exec fairwins-bundler-alto wget -qO- --timeout=8 \
         --header='Content-Type: application/json' \
         --post-data='{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
         http://127.0.0.1:3000 2>/dev/null | grep -q 0x89; then
      ok chainid
    else
      bad "alto RPC round trip failing (no chainId 0x89)"
    fi

    # Re-check the single-alto invariant every minute: a merge to main can re-arm Cloud Run at any
    # time and this VM cannot prevent that — it can only detect it fast.
    if /opt/fairwins/bundler/single-alto-gate.sh >/dev/null 2>&1; then
      ok single-alto
    else
      bad "SECOND EXECUTOR RISK — Cloud Run bundler appears re-armed; run single-alto-gate.sh for detail"
    fi
    ;;

  gateway)
    # Ask for the disclosed view so runway numbers are present. The secret is read from tmpfs and
    # handed to curl via a config file on stdin, never argv.
    status="$(
      { printf 'header = "X-Origin-Auth: '
        sed -n "s/^ORIGIN_AUTH_SECRET='\(.*\)'$/\1/p" /run/fairwins/gateway.env | tr -d '\n'
        printf '"\n'
      } | curl -fsS -m 25 --config - http://127.0.0.1:8788/status 2>/dev/null
    )" || status=""

    if [ -z "$status" ]; then
      bad "gateway /status unreachable"
    else
      ok status
      # Per-chain rpc reachability.
      for chain in 63 137; do
        if printf '%s' "$status" | python3 -c "
import sys,json
d=json.load(sys.stdin); c=d.get('chains',{}).get('$chain')
sys.exit(0 if c and c.get('rpc')=='up' else 1)" 2>/dev/null; then
          ok "chain-$chain-rpc-up"
        else
          bad "chain $chain rpc not up"
        fi
      done
      # Gas-wallet runway — the numeric check no string matcher can do. If the relay gas wallet runs
      # dry, gasless relaying stops platform-wide and members silently fall back to paying their own
      # gas. Threshold is generous because topping up is a manual, human-latency operation.
      # ABSENT IS NOT HEALTHY. This check previously read `if r is not None and r < 48`, so a
      # response with no runway fields at all appended nothing, exited 0 and reported `ok runway`.
      # The runway numbers live in the DISCLOSED view, so the way they go missing is the probe's own
      # X-Origin-Auth failing — i.e. exactly when the operator has least reason to trust silence.
      # A missing number is now its own failure, distinct from a number below the threshold.
      printf '%s' "$status" | python3 -c "
import sys,json
d=json.load(sys.stdin)
chains=(d.get('chains') or {})
bad=[]
if not chains:
    bad.append('no-chains-in-status')
for cid,c in chains.items():
    # key absent  => the disclosed view did not arrive (credential/gating problem)
    # key present, value null => genuinely unknown for this chain (e.g. no paymaster there)
    if 'gasWalletRunwayHrs' not in c:
        bad.append(f'{cid}:runway-not-disclosed')
    else:
        r=c.get('gasWalletRunwayHrs')
        if r is None: bad.append(f'{cid}:runway-unreadable')
        elif r < 48: bad.append(f'{cid}:{r}h')
    p=c.get('paymasterDepositRunwayHrs')
    if p is not None and p < 48: bad.append(f'{cid}-paymaster:{p}h')
print(' '.join(bad))
sys.exit(1 if bad else 0)" >/tmp/.probe_runway 2>/dev/null \
        && ok runway \
        || bad "runway check failed: $(cat /tmp/.probe_runway 2>/dev/null)"
    fi

    # The engine is the piece whose death is invisible from the public surface: the gateway keeps
    # serving /status, the paymaster and the proxies without it, so every outside-in check stays green
    # while relaying is dead.
    #
    # Two things this check must get right, both learned the hard way:
    #   1. The engine's port is NOT published to the host. Only the namespace owner (gateway) publishes
    #      (127.0.0.1:8788); engine and redis join that namespace, so :8080 is reachable only from
    #      inside it. A host-side curl returns 000 no matter how healthy the engine is.
    #   2. /api/v1/health is the ONLY unauthenticated engine route (matching the client's /api/v1/...
    #      base, engine/client.js:61). /health, /v1/health and / all return 401 -- and `curl -fsS`
    #      treats 401 as failure, so probing those reports a healthy engine as down.
    # Getting either wrong makes this a permanent false page.
    if docker exec fairwins-gateway-gateway \
         wget -qO- --timeout=8 http://127.0.0.1:8080/api/v1/health >/dev/null 2>&1; then
      ok engine
    else
      bad "OZ relayer engine not answering — relaying is down (intents will self-submit)"
    fi

    # A LIVE engine can still be STUCK (issue #1648, upstream OpenZeppelin/openzeppelin-relayer#808,
    # present from v1.4.0 through v1.8.0). Once a gas spike pushes the minimum replacement price
    # above `gas_price_cap`, the engine logs "bumped gas price does not meet minimum requirement,
    # skipping resubmission" and returns without repricing. The tx stays `submitted`, /api/v1/health
    # stays green, and every later tx on that lane queues behind the stuck nonce. That log line is the
    # ONLY signal. Until #1653 the engine logged to the json-file driver, so the line never reached
    # Cloud Logging on its own; it now also ships via gcplogs (docker logs keeps working through
    # Docker's dual-logging cache, which is what this reads). This check stays as the BACKSTOP: it does
    # not depend on the log shipper or on a log-based metric, and re-emitting the line here puts it on
    # the probe's FAIL path, which already pages.
    #
    # --since 120s overlaps the 60s timer on purpose: a minute lost to a slow `docker exec` above
    # must not hide a hit. Double-counting is harmless; the alert counts FAIL lines, not hits.
    # An unreadable log is its own failure, never a pass. Runbook:
    # docs/runbooks/relayer-operations.md#stuck-transactions
    if engine_logs="$(docker logs --since 120s fairwins-gateway-engine 2>&1)"; then
      stuck="$(printf '%s' "$engine_logs" | grep -c 'skipping resubmission' || true)"
      if [ "${stuck:-0}" -gt 0 ]; then
        bad "relay lane STUCK at gas_price_cap — engine skipped resubmission ${stuck}x in 120s (runbook: relayer-operations.md#stuck-transactions)"
      else
        ok engine-resubmission
      fi
    else
      bad "engine logs unreadable — cannot rule out a stuck lane"
    fi
    ;;
  *) bad "unknown role"; ;;
esac

exit $RC
