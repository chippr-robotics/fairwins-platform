#!/usr/bin/env bash
# Must-fail fixtures for single-alto-gate.sh step 3 (#1501).
#
# The old step 3 PASSED on the two shapes that matter most — two altos for one chain (the prefix
# exclusion was unanchored) and an alto on a different image tag (the ancestor filter was pinned).
# A gate nobody has watched fail is a gate nobody knows works, and this one guards a failure with
# no in-band detection, so each case below is asserted in the direction it must break.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/../single-alto-gate.sh"
REPO="us-central1-docker.pkg.dev/chippr-bots-site-wp/cloud-run-source-deploy/alto"
pass=0; fail=0
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }

# A fake `docker` whose `ps` and `inspect` answers come from the fixture in $FIXTURE.
# Format per line: "<image> <name> <chainId-or-empty>"
make_docker() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/docker" <<'DOCKER'
#!/usr/bin/env bash
case "$1" in
  ps)
    while IFS=' ' read -r img name cid; do [ -n "${img:-}" ] || continue; printf '%s %s\n' "$img" "$name"; done <<< "$FIXTURE"
    ;;
  inspect)
    target="${!#}"
    while IFS=' ' read -r img name cid; do
      [ "$name" = "$target" ] || continue
      [ -n "${cid:-}" ] && printf 'FW_CHAIN_ID=%s\n' "$cid"
    done <<< "$FIXTURE"
    ;;
esac
exit 0
DOCKER
  chmod +x "$dir/docker"
  # gcloud stub: report the Cloud Run service absent so steps 1-2 pass and step 3 is under test.
  cat > "$dir/gcloud" <<'GCLOUD'
#!/usr/bin/env bash
echo "NOT_FOUND: Service not found." >&2
exit 1
GCLOUD
  chmod +x "$dir/gcloud"
}

run_gate() { # $1=fixture  $2=declared chains
  local tmp; tmp="$(mktemp -d)"
  make_docker "$tmp"
  FIXTURE="$1" FW_BUNDLER_CHAIN_IDS="$2" PATH="$tmp:$PATH" bash "$GATE" 2>&1
  local rc=$?; rm -rf "$tmp"; return $rc
}

echo "single-alto-gate step 3:"

out=$(run_gate "$REPO:v1.2.7 fairwins-bundler-alto-137 137" "137"); rc=$?
[ $rc -eq 0 ] && ok "one alto for its declared chain passes" || bad "one alto should pass (rc=$rc): $out"

# THE FALSE PASS the old gate gave: two altos, same chain, both excluded by the prefix match.
out=$(run_gate "$REPO:v1.2.7 fairwins-bundler-alto-137 137
$REPO:v1.2.7 fairwins-bundler-alto-137b 137" "137"); rc=$?
[ $rc -ne 0 ] && ok "two altos on ONE chain are refused (the old prefix-match false pass)" \
              || bad "two altos on one chain MUST refuse — this is two executors on one EOA"

# THE FALSE REFUSAL the old gate gave: a legitimate second chain.
out=$(run_gate "$REPO:v1.2.7 fairwins-bundler-alto-137 137
$REPO:v1.2.7 fairwins-bundler-alto-8453 8453" "137 8453"); rc=$?
[ $rc -eq 0 ] && ok "two altos on DIFFERENT declared chains pass (no shared EOA)" \
              || bad "distinct chains must pass (rc=$rc): $out"

# The tag pin: a duplicate on another tag was invisible to `ancestor=`.
out=$(run_gate "$REPO:v1.2.7 fairwins-bundler-alto-137 137
$REPO:v1.3.0 rogue-alto 137" "137"); rc=$?
[ $rc -ne 0 ] && ok "a duplicate on a DIFFERENT image tag is seen (the old ancestor-pin blind spot)" \
              || bad "a different-tag duplicate MUST refuse"

# Unattributable container: absent chain id is not benign.
out=$(run_gate "$REPO:v1.2.7 mystery-alto " "137"); rc=$?
[ $rc -ne 0 ] && ok "an alto with no FW_CHAIN_ID is refused, not assumed safe" \
              || bad "unattributable alto MUST refuse"

# A chain this host was never declared to serve.
out=$(run_gate "$REPO:v1.2.7 fairwins-bundler-alto-8453 8453" "137"); rc=$?
[ $rc -ne 0 ] && ok "an undeclared chain is refused" || bad "undeclared chain MUST refuse"

echo "  ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
