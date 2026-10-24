#!/usr/bin/env bash
#
# infra/vm/bundler/single-alto-gate.sh — make "exactly one alto" MECHANICAL, not procedural.
#
# WHY THIS EXISTS
# ALTO_EXECUTOR_PRIVATE_KEYS and ALTO_UTILITY_PRIVATE_KEY resolve to the same per-chain secret, so a
# second alto ON THE SAME KEY is a second executor on ONE EOA: colliding nonces, stuck bundles, and —
# because ALTO_DEPLOY_SIMULATIONS_CONTRACT=true — even a cold start can emit a transaction from that
# wallet. There is no in-band detection: both instances look healthy.
#
# THE INVARIANT IS PER (CHAIN, EXECUTOR KEY) — NOT PER HOST.
# That distinction did not matter while one chain had a bundler, and the original step 3 below was
# written as "no other alto on this host". At N chains those two readings come apart in both
# directions, and both are wrong:
#   · FALSE REFUSAL — a legitimate second-chain alto, its own key, no possible nonce collision,
#     would be refused merely for sharing a host.
#   · FALSE PASS — the exclusion `grep -v '^fairwins-bundler-alto'` was a PREFIX with no end anchor,
#     so `fairwins-bundler-alto-137` and `fairwins-bundler-alto-8453` were BOTH excluded: two altos
#     for the SAME chain, side by side, and the gate printed "OK — exactly one alto may run".
#     `--filter ancestor=<one pinned tag>` compounded it — an alto on any other tag was invisible,
#     which is exactly the state during a staged version rollout.
# Step 3 now asserts the real thing: on this host, at most one alto per chain, and the chain it runs
# must be one this host is declared to serve.
#
# THREE INDEPENDENT RE-ARMING PATHS EXIST. min-instances=0 alone is NOT sufficient.
#   (a) --min-instances=0 still cold-starts an instance on ANY inbound request, and the Cloud Run
#       service is `run.googleapis.com/ingress: all` with a public *.run.app URL. The origin lock runs
#       INSIDE the instance, so a request that gets 403'd has already started an alto.
#       => the service must ALSO be --ingress=internal (or deleted).
#   (b) .claude/skills/fairwins-infra/manage.sh `cmd_scale up` runs
#       `gcloud run services update --min-instances=1`, which starts an instance regardless of
#       ingress. The skill's own description tells the operator to run it before testing gasless
#       transactions. => it must be neutered before cutover, not at decommission.
#   (c) cloudbuild.yaml renders services/alto-bundler/deploy/service.yaml and runs
#       `gcloud run services replace` on EVERY merge to main. That manifest restores BOTH
#       minScale: "1" AND ingress: all. => the build step must be removed in the cutover commit.
#
# This gate runs as ExecStartPre of the bundler stack AND every 60s from probe.sh, so a merge that
# re-arms Cloud Run is caught within a minute even though it cannot un-start this VM.
#
# DEPLOYING THIS CHANGE. The gate and the compose file that declares FW_CHAIN_ID must land
# TOGETHER — they are one commit for that reason. probe.sh also runs this gate every 60s, so between
# `rsync` and `systemctl restart fairwins-stack@bundler` one probe tick can see the NEW gate against
# the OLD container and refuse it for having no FW_CHAIN_ID. That is a transient, self-resolving page
# during a deploy that is already restarting the stack — and it is the correct trade: the alternative
# is passing an alto the gate cannot attribute, which is precisely the blind spot being removed.
#
# Exit 0 = safe to run the VM's alto. Any other exit = do not start / page.
#
set -euo pipefail

PROJECT="${FW_PROJECT:-chippr-bots-site-wp}"
REGION="${FW_REGION:-us-central1}"
SERVICE="${FW_CLOUD_RUN_BUNDLER:-fairwins-alto-bundler}"

log()  { printf '[single-alto-gate] %s\n' "$*" >&2; }
fail() { printf '[single-alto-gate] REFUSE: %s\n' "$*" >&2; exit 1; }

# ---- 1. Cloud Run must be structurally unable to serve a bundler --------------------------------
#
# THIS BLOCK FAILS CLOSED. An earlier version ran `describe ... 2>/dev/null || true` and treated
# EMPTY OUTPUT as "the service was decommissioned, safe to proceed". That is wrong: describe returns
# empty on a permission error, an expired credential, an API outage and a network failure just as
# readily as on a genuine 404. The bundler VM's service account had no Cloud Run read permission, so
# the gate concluded "decommissioned" and started a second executor against a live Cloud Run bundler.
# Nothing was emitted (verified: nonce and balance unchanged), but the gate had already failed.
#
# A safety gate must never read "I could not determine the state" as "the state is safe". Only an
# unambiguous NOT_FOUND counts as decommissioned; everything else refuses.
err_file="$(mktemp)"
trap 'rm -f "$err_file"' EXIT
set +e
# Parse JSON, NOT --format='value(a,b)'. gcloud omits absent fields entirely rather than emitting an
# empty column, so when minScale is absent (which is the SAFE state — it means 0) the ingress value
# shifts into $1 and the gate read "minScale=internal". It failed closed, so nothing unsafe happened,
# but it blocked a legitimate cutover. Positional parsing of possibly-empty fields is ambiguous by
# construction; read the document instead.
desc="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" \
          --format=json 2>"$err_file" \
        | python3 -c '
import sys, json
d = json.load(sys.stdin)
t = d.get("spec", {}).get("template", {}).get("metadata", {}).get("annotations", {}) or {}
s = d.get("metadata", {}).get("annotations", {}) or {}
# Absent minScale means 0; absent ingress means "all" (Cloud Run default, the UNSAFE one).
print(t.get("autoscaling.knative.dev/minScale", "0"), s.get("run.googleapis.com/ingress", "all"))
' 2>>"$err_file")"
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
  # These strings are gcloud's WORDING for a genuine 404, verified against the live SDK -- notably
  # "Cannot find service [...]", which is what it actually prints and which an obvious
  # NOT_FOUND-only pattern misses. Anything not matched here (PERMISSION_DENIED, network, quota,
  # expired credentials) is treated as UNKNOWN and refuses. Note gcloud deliberately conflates 403
  # and 404 as "(or resource may not exist)" when the caller lacks read permission, which is exactly
  # why project-level roles/run.viewer is required for this branch to be reachable at all.
  if grep -qiE 'NOT_FOUND|could not be found|does not exist|Cannot find service' "$err_file"; then
    log "Cloud Run service '$SERVICE' returns NOT_FOUND — decommissioned. Safe."
  else
    fail "cannot determine Cloud Run state for '$SERVICE' (exit $rc): $(tr '\n' ' ' <"$err_file" | head -c 300)
       This is NOT proof the service is gone. Grant this VM's service account roles/run.viewer, or
       delete the Cloud Run service outright. Refusing to start alto while the state is unknown."
  fi
elif [ -z "$desc" ]; then
  fail "Cloud Run describe for '$SERVICE' succeeded but returned no data — cannot confirm it is disarmed. Refusing."
else
  min_scale="$(printf '%s' "$desc" | awk '{print $1}')"
  ingress="$(printf '%s' "$desc"  | awk '{print $2}')"
  : "${min_scale:=0}"
  : "${ingress:=all}"

  [ "$min_scale" = "0" ] || fail "Cloud Run '$SERVICE' has minScale=$min_scale — it is running an alto against the SAME executor key. Set --min-instances=0 first."
  [ "$ingress" = "internal" ] || fail "Cloud Run '$SERVICE' ingress=$ingress — any public request cold-starts a second alto (the origin lock runs INSIDE the instance, so even a 403 has already started one). Set --ingress=internal."

  # ADVISORY ONLY — a warm instance may still be draining at minScale=0. Unlike the checks above,
  # an unreadable result here is NOT treated as proof of anything: it warns rather than passing
  # silently. The structural guarantee is minScale=0 + ingress=internal, already asserted above;
  # this only shortens the window where a draining instance overlaps the VM's alto.
  active="$(gcloud monitoring time-series list \
      --project "$PROJECT" \
      --filter="metric.type=\"run.googleapis.com/container/instance_count\" AND resource.labels.service_name=\"$SERVICE\"" \
      --format='value(points[0].value.int64Value)' 2>/dev/null | head -1 || true)"
  if [ -z "${active:-}" ]; then
    # This fired in the real cutover and the overlap it exists to catch happened anyway: the VM's
    # service account has roles/run.viewer but NOT roles/monitoring.viewer, so the metric read
    # returned nothing and this degraded to a notice. Two altos ran for ~4 minutes.
    # It stays advisory (the structural checks are the guarantee, and they held), but the wording
    # must not imply the check passed — it did not run. Grant roles/monitoring.viewer to make it real.
    log "WARNING: instance_count is UNREADABLE — this check did NOT run (likely missing roles/monitoring.viewer)."
    log "         A draining Cloud Run instance would be invisible here. Note that 'services update'"
    log "         itself starts an instance to health-check the new revision, so a disarm performed"
    log "         moments ago may still be draining. Prefer deleting the service outright."
  elif [ "$active" != "0" ]; then
    fail "Cloud Run '$SERVICE' still reports $active live instance(s). Wait for them to drain."
  fi
  log "Cloud Run '$SERVICE': minScale=0, ingress=internal, no live instances. Safe."
fi

# ---- 2. The manage.sh re-arming path must be disarmed -------------------------------------------
# Checked on the VM copy of the repo if present; advisory (warn, do not block) because the skill lives
# on the operator's workstation, not here.
SKILL="${FW_REPO:-/opt/fairwins/repo}/.claude/skills/fairwins-infra/manage.sh"
if [ -f "$SKILL" ] && grep -q 'min-instances' "$SKILL" && ! grep -q 'MIGRATED_TO_VM' "$SKILL"; then
  log "WARNING: $SKILL still has a --min-instances lever and no MIGRATED_TO_VM guard. Running 'manage.sh up' would start a second executor."
fi

# ---- 3. At most one alto PER CHAIN on this host --------------------------------------------------
# Compose recreates rather than duplicates, but a hand-run `docker run` would not.
#
# Matched on the image REPOSITORY, never a pinned tag: during a staged upgrade the two versions
# differ, and a duplicate running the other tag is the one this check most needs to see.
ALTO_REPO="${FW_ALTO_REPO:-us-central1-docker.pkg.dev/chippr-bots-site-wp/cloud-run-source-deploy/alto}"

# The chains this host is declared to serve. One entry today; a per-chain rollout sets it explicitly.
# Deliberately NOT inferred from what is running — a gate that derives its expectation from the
# situation it is auditing cannot fail.
DECLARED_CHAINS="${FW_BUNDLER_CHAIN_IDS:-137}"

running_altos() {
  # `--format '{{.Image}} {{.Names}}'` so we can filter by repository ourselves; `ancestor=` needs a
  # fully-qualified tag and would silently miss every other one.
  docker ps --format '{{.Image}} {{.Names}}' 2>/dev/null | awk -v repo="$ALTO_REPO" '
    index($1, repo) == 1 { print $2 }
  ' || true
}

# A container is attributed to a chain by its declared env, not by its name — a name is a label
# somebody chose and can collide. FW_CHAIN_ID is OURS (not an alto setting): it is the compose
# file's declaration of which chain this instance is for, which is the thing the invariant is about.
chain_of() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null \
    | sed -n 's/^FW_CHAIN_ID=//p' | head -1
}

seen_chains=""
while read -r name; do
  [ -n "$name" ] || continue
  cid="$(chain_of "$name")"
  if [ -z "$cid" ]; then
    # Unattributable is NOT benign: it is an alto this gate cannot reason about, which is the
    # condition the whole file exists to refuse. Absent must never read as fine.
    fail "alto container '$name' declares no FW_CHAIN_ID — cannot prove it is not a duplicate executor"
  fi
  case " $DECLARED_CHAINS " in
    *" $cid "*) ;;
    *) fail "alto container '$name' runs chain $cid, which this host is not declared to serve (declared: $DECLARED_CHAINS)" ;;
  esac
  case " $seen_chains " in
    *" $cid "*) fail "two altos are running chain $cid on this host — that is two executors on ONE EOA: $name" ;;
    *) seen_chains="$seen_chains $cid" ;;
  esac
done <<EOF_ALTOS
$(running_altos)
EOF_ALTOS

log "OK — at most one alto per chain (declared: $DECLARED_CHAINS; running:${seen_chains:- none})."
exit 0
