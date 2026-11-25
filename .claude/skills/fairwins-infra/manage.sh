#!/usr/bin/env bash
#
# FairWins gasless-infra control — bring the always-on Cloud Run services UP (warm)
# or DOWN (scale-to-zero) to control cost, and check status/health/config.
#
# Manages ONLY the two gasless-stack services (both run min=1 + cpu-throttling=false,
# i.e. a full vCPU allocated 24/7 — that is the cost we're toggling):
#   - fairwins-alto-bundler   (the ERC-4337 bundler)
#   - fairwins-relay-gateway  (the ERC-7677 paymaster + EIP-3009 relay signer)
#
# It NEVER touches the SPA (prediction-dao-research, already scales to zero) or any
# other project's services (clearpath-*, fukuii-*, kings-edge-*).
#
# "Down" sets min-instances=0: the service scales to zero and costs ~$0 when idle,
# but still cold-starts to serve an on-demand request. "Up" sets min-instances=1
# (warm) for active testing/use. Scaling changes do NOT alter env vars.
#
# Usage:
#   ./manage.sh status [bundler|gateway|all]     # default: all
#   ./manage.sh up      [bundler|gateway|all]     # warm (min=1) + health check
#   ./manage.sh down    [bundler|gateway|all]     # scale to zero (min=0)
#
set -euo pipefail

PROJECT="chippr-bots-site-wp"
REGION="us-central1"
# The zone both migrated VMs live in (docs/runbooks/vm-migration.md).
VM_ZONE="us-central1-a"

BUNDLER_SVC="fairwins-alto-bundler"
GATEWAY_SVC="fairwins-relay-gateway"
BUNDLER_HEALTH_URL="https://bundler.fairwins.app"
GATEWAY_HEALTH_URL="https://relay.fairwins.app"

# --- helpers ---------------------------------------------------------------

svc_name() {  # alias -> Cloud Run service name
  case "$1" in
    bundler) echo "$BUNDLER_SVC" ;;
    gateway) echo "$GATEWAY_SVC" ;;
    *) echo "" ;;
  esac
}

targets() {  # "all"|"bundler"|"gateway" -> alias list
  case "${1:-all}" in
    all|"") echo "bundler gateway" ;;
    bundler) echo "bundler" ;;
    gateway) echo "gateway" ;;
    *) echo "ERR" ;;
  esac
}

get_min() {  # current minScale for a service name ("" -> 0)
  local n; n=$(gcloud run services describe "$1" --project="$PROJECT" --region="$REGION" \
    --format='value(spec.template.metadata.annotations["autoscaling.knative.dev/minScale"])' 2>/dev/null || true)
  echo "${n:-0}"
}

get_ready() {  # Ready condition for a service name
  gcloud run services describe "$1" --project="$PROJECT" --region="$REGION" \
    --format='value(status.conditions[0].status)' 2>/dev/null || echo "?"
}

# MIGRATED_TO_VM — the bundler no longer lives on Cloud Run.
#
# `manage.sh up` used to run --min-instances=1 on fairwins-alto-bundler. After the VM migration that
# starts a SECOND executor against alto-executor-key-137 (both ALTO_EXECUTOR_PRIVATE_KEYS and
# ALTO_UTILITY_PRIVATE_KEY resolve to that one secret), which collides nonces with the VM's alto and
# is invisible in-band — both instances look healthy. min-instances>0 starts an instance regardless
# of ingress, so --ingress=internal does NOT protect against this path.
#
# This is a hard refusal rather than a warning: the skill's own description tells the operator to run
# `up` before testing gasless transactions, so it is the lever most likely to be pulled by reflex.
#
# 2026-08-12: the GATEWAY has migrated too, and the guard had not followed it. Measured:
# `gcloud run services describe fairwins-relay-gateway` reports "Cannot find service" while
# `fairwins-gateway` (e2-small, us-central1-a) is RUNNING and serving relay.fairwins.app. `status`
# was therefore printing "DOWN (scale-to-zero)" for a service that does not exist, next to a health
# line that passes because it pings the public URL — so the output read as "the gateway is off and
# cheap" while a VM billed 24/7. A stale monitor that answers confidently is worse than one that
# errors, which is why both names are listed here now.
MIGRATED_TO_VM="fairwins-alto-bundler fairwins-relay-gateway"

is_migrated() {  # service-name
  case " $MIGRATED_TO_VM " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

vm_for() {  # Cloud Run service name -> the GCE VM that replaced it
  case "$1" in
    fairwins-alto-bundler) echo "fairwins-bundler" ;;
    fairwins-relay-gateway) echo "fairwins-gateway" ;;
    *) echo "" ;;
  esac
}

role_for() {  # Cloud Run service name -> the systemd instance name on the VM (fairwins-stack@<role>)
  case "$1" in
    fairwins-alto-bundler) echo "bundler" ;;
    fairwins-relay-gateway) echo "gateway" ;;
    *) echo "" ;;
  esac
}

vm_state() {  # VM name -> RUNNING|TERMINATED|? (never fails the caller)
  gcloud compute instances describe "$1" --project="$PROJECT" --zone="$VM_ZONE" \
    --format='value(status)' 2>/dev/null || echo "?"
}

set_min() {  # service-name min-instances
  if is_migrated "$1"; then
    cat >&2 <<EOF
REFUSING: $1 has been migrated to a GCE VM ($(vm_for "$1"), $VM_ZONE).
  Starting a Cloud Run instance alongside the VM runs a SECOND copy of this service against the same
  secrets. For the bundler that means two executors on one key, colliding nonces with no in-band
  signal — both instances look healthy. Manage it on the VM instead:
    gcloud compute ssh $(vm_for "$1") --zone $VM_ZONE --tunnel-through-iap \\
      --command 'sudo systemctl {start,stop,status} fairwins-stack@$(role_for "$1")'
  To genuinely roll back to Cloud Run, follow the rollback in docs/runbooks/vm-migration.md --
  it is a THREE-part action, and restoring the cloudbuild step is one of them.
EOF
    return 1
  fi
  gcloud run services update "$1" --project="$PROJECT" --region="$REGION" \
    --min-instances="$2" --quiet >/dev/null
}

health() {  # alias -> prints a health line
  local a="$1" code body
  if [ "$a" = "bundler" ]; then
    body=$(curl -s -m 10 -X POST "$BUNDLER_HEALTH_URL" -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_supportedEntryPoints","params":[]}' 2>/dev/null || true)
    if echo "$body" | grep -q '0x5FF137D4'; then echo "healthy (EntryPoint v0.6 responding)"; else echo "NOT responding (${body:0:60})"; fi
  else
    code=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$GATEWAY_HEALTH_URL/" 2>/dev/null || echo "000")
    if [ "$code" = "000" ]; then echo "NOT reachable"; else echo "reachable (HTTP $code)"; fi
  fi
}

bundler_config() {  # warn if the critical env vars have been clobbered (see the auto-deploy gotcha)
  # This guard reads CLOUD RUN, and the bundler no longer lives there — so it now reads nothing.
  # It used to print "(config read failed)", which looks like a transient glitch rather than a
  # safety check that has stopped running. Say what is actually true, and where the config now is.
  if is_migrated "$BUNDLER_SVC"; then
    cat <<EOF
     config drift guard: NOT RUNNING — it reads Cloud Run, and the bundler is on GCE now.
       The live config is the VM's compose env: infra/vm/bundler/docker-compose.yml, applied by
       'sudo systemctl restart fairwins-stack@bundler'. To check it for real:
         gcloud compute ssh fairwins-bundler --zone $VM_ZONE --tunnel-through-iap \\
           --command 'sudo docker inspect fairwins-bundler-alto --format "{{json .Config.Env}}" \\
             | sed -E "s#(https://[^/\\",]+)[/?][^\\",]*#\\1/<redacted>#g"'
       ⚠ THE SED IS NOT OPTIONAL. ALTO_RPC_URL is a KEYED archive URL delivered from Secret
       Manager (fairwins-bundler-rpc-url-137), and its key is in the path or query — a raw dump
       of .Config.Env prints the credential to your terminal and your shell history.
       Watch for: ALTO_RPC_URL must be the keyed provider host and must NOT be publicnode
       (archive-403 breaks receipts), ALTO_DEPLOY_SIMULATIONS_CONTRACT=true, and
       ALTO_GAS_PRICE_MULTIPLIERS set.
EOF
    return 0
  fi
  gcloud run services describe "$BUNDLER_SVC" --project="$PROJECT" --region="$REGION" --format=json 2>/dev/null \
  | python3 -c '
import sys,json
d=json.load(sys.stdin); env={}
for c in d["spec"]["template"]["spec"]["containers"]:
    if c.get("name")=="alto":
        for e in c.get("env",[]): env[e["name"]]=e.get("value")
rpc=env.get("ALTO_RPC_URL",""); sim=env.get("ALTO_DEPLOY_SIMULATIONS_CONTRACT",""); mul=env.get("ALTO_GAS_PRICE_MULTIPLIERS","")
warn=[]
if "publicnode" in rpc: warn.append("RPC is publicnode (archive-403 breaks receipts)")
if sim!="true": warn.append("DEPLOY_SIMULATIONS_CONTRACT!=true (bundle-build fails)")
if not mul or mul=="100,100,100": warn.append("no gas-price multiplier (underprices during congestion)")
print("     RPC:", rpc)
print("     sim-contract:", sim, " gas-multipliers:", mul or "(default)")
if warn:
    print("     ⚠ CONFIG DRIFT — likely clobbered by the auto-deploy; merge/redeploy PR #895:")
    for w in warn: print("        -",w)
else:
    print("     ✓ config looks correct (keyed RPC, sim=true, multiplier set)")
' 2>/dev/null || echo "     (config read failed)"
}

# --- commands --------------------------------------------------------------

cmd_status() {
  for a in $(targets "${1:-all}"); do
    local n; n=$(svc_name "$a")
    local min ready
    if is_migrated "$n"; then
      # Do NOT fall through to get_min here: it swallows "Cannot find service" and returns 0, which
      # printed "DOWN (scale-to-zero)" for a service that does not exist — beside a health line that
      # passes because it pings the public URL. That reads as "off and cheap" while a VM bills 24/7.
      local vm; vm=$(vm_for "$n")
      printf '%-8s %-24s  ON GCE VM %s (%s)  health=%s\n' \
        "$a" "$n" "$vm" "$(vm_state "$vm")" "$(health "$a")"
      if [ "$a" = "bundler" ]; then bundler_config; fi
      continue
    fi
    min=$(get_min "$n"); ready=$(get_ready "$n")
    local state="DOWN (scale-to-zero)"; [ "$min" != "0" ] && state="UP (warm, min=$min)"
    printf '%-8s %-24s  %s  ready=%s  health=%s\n' "$a" "$n" "$state" "$ready" "$(health "$a")"
    if [ "$a" = "bundler" ]; then bundler_config; fi
  done
}

cmd_scale() {  # up|down [target]
  local dir="$1" tgt="${2:-all}" min
  [ "$dir" = "up" ] && min=1 || min=0
  local list; list=$(targets "$tgt")
  [ "$list" = "ERR" ] && { echo "unknown target: $tgt (use bundler|gateway|all)"; exit 2; }
  for a in $list; do
    local n; n=$(svc_name "$a")
    echo "==> ${dir^^} $a ($n): setting min-instances=$min ..."
    set_min "$n" "$min"
  done
  echo
  if [ "$dir" = "up" ]; then
    echo "Warming up — verifying health:"
    cmd_status "$tgt"
    echo
    echo "Note: 'up' does not change env vars. If the bundler config shows drift above, redeploy the fixes (or merge PR #895)."
  else
    echo "Scaled to zero. Idle cost ~\$0; the service still cold-starts to serve an on-demand request."
    cmd_status "$tgt"
  fi
}

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  local cmd="${1:-status}"; shift || true
  case "$cmd" in
    status)     cmd_status "${1:-all}" ;;
    up)         cmd_scale up "${1:-all}" ;;
    down)       cmd_scale down "${1:-all}" ;;
    -h|--help|help) usage ;;
    *) echo "unknown command: $cmd"; echo; usage; exit 2 ;;
  esac
}

main "$@"
