#!/usr/bin/env bash
#
# Start the pimlico **alto** ERC-4337 bundler against the local e2e chain (spec 041/050).
#
# WHY A CONTAINER. alto is not — and must not become — an npm dependency of this repo: adding one
# re-resolves the root lockfile, and npm/cli#4828 then drops the platform rolldown binary, breaking
# every Vite build including the on-chain mini-app release path (spec 075). Production runs alto as
# a container too (infra/vm/bundler/docker-compose.yml), so this is the same artefact the platform
# actually uses, not a CI-only substitute.
#
# WHY PINNED BY DIGEST. A tag can be repointed; a digest cannot. The bundler decides whether a
# member's UserOp lands, so "the version CI proved" and "the version CI ran" have to be the same
# thing. SOAK STEP (ADR-006, #1654): this stack runs v1.2.8 AHEAD of the VM, which is still on v1.2.7
# (infra/vm/bundler/docker-compose.yml; registry ids alto-bundler-e2e / alto-bundler-vm). A bump
# soaks here first, then moves to one chain's VM. Do not read the gap as drift: the VM moves only
# after the Passkey Full Stack tier is green on this digest.
#
# WHY --network host. alto has to reach the hardhat node on 127.0.0.1:8545 and Cypress has to reach
# alto on 127.0.0.1:$ALTO_HOST_PORT. Sharing the runner's namespace is the least machinery; there is
# no origin-lock sidecar here because there is no internet-facing edge in a CI job.
set -euo pipefail

ALTO_IMAGE="${ALTO_IMAGE:-ghcr.io/pimlicolabs/alto:v1.2.8@sha256:f2661042aadefc6a4fc9c5826a14404f574c7ef2de76bdf83fe6a0829137b3c5}"
# alto itself listens on 4338; the SPA-facing :4337 is the CORS proxy started below (alto 404s the
# browser's OPTIONS preflight and emits no CORS headers — production has nginx for this, CI has
# cors-proxy.js). wait-for-stack.js addresses :4337 on purpose: it proves the path the SPA uses.
ALTO_HOST_PORT="${ALTO_HOST_PORT:-4338}"
ALTO_PROXY_PORT="${ALTO_PROXY_PORT:-4337}"
RPC_URL="${ALTO_RPC_URL:-http://127.0.0.1:8545}"
ENTRYPOINT="${ALTO_ENTRYPOINTS:-0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789}"
CONTAINER="${ALTO_CONTAINER_NAME:-fairwins-e2e-alto}"

# Hardhat's well-known development accounts #7 and #8. THESE ARE PUBLIC TEST KEYS — they are printed
# by `npx hardhat node` on every start, hold nothing on any real network, and must never be replaced
# with a credential. Two distinct keys because alto uses the executor to send bundles and the utility
# key for its own maintenance sends (deploying the simulations contract, refunds).
EXECUTOR_KEY="${ALTO_EXECUTOR_PRIVATE_KEYS:-0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356}"
UTILITY_KEY="${ALTO_UTILITY_PRIVATE_KEY:-0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97}"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

docker run -d --name "$CONTAINER" --network host \
  -e ALTO_RPC_URL="$RPC_URL" \
  -e ALTO_ENTRYPOINTS="$ENTRYPOINT" \
  -e ALTO_EXECUTOR_PRIVATE_KEYS="$EXECUTOR_KEY" \
  -e ALTO_UTILITY_PRIVATE_KEY="$UTILITY_KEY" \
  -e ALTO_PORT="$ALTO_HOST_PORT" \
  -e ALTO_NETWORK_NAME="local" \
  -e ALTO_API_VERSION="v1,v2" \
  -e ALTO_LOG_LEVEL="info" \
  `# SAFE MODE OFF, deliberately and only here. Safe mode enforces ERC-7562 opcode/storage rules` \
  `# via debug_traceCall with a JS tracer, which the Hardhat Network does not implement — with it` \
  `# on, every op is rejected before validation and nothing the specs assert can ever happen.` \
  `# Production keeps it at the value the live compose file sets; do NOT copy this line there.` \
  -e ALTO_SAFE_MODE="false" \
  `# alto's own simulations contract, deployed by the utility key on boot. Live Polygon needs this` \
  `# true (with false, filterOps references a contract that is not deployed and the executor never` \
  `# broadcasts) and a fresh local chain has even less reason to differ.` \
  -e ALTO_DEPLOY_SIMULATIONS_CONTRACT="true" \
  "$ALTO_IMAGE"

echo "alto ${ALTO_IMAGE} started as ${CONTAINER} on :${ALTO_HOST_PORT} (entryPoint ${ENTRYPOINT}, rpc ${RPC_URL})"

mkdir -p /tmp/fairwins-passkey-stack
ALTO_PROXY_PORT="$ALTO_PROXY_PORT" ALTO_UPSTREAM="http://127.0.0.1:${ALTO_HOST_PORT}" \
  nohup node "$(dirname "$0")/cors-proxy.js" > /tmp/alto-proxy.log 2>&1 &
echo $! > /tmp/fairwins-passkey-stack/alto-proxy.pid
echo "alto CORS proxy started on :${ALTO_PROXY_PORT} (pid $(cat /tmp/fairwins-passkey-stack/alto-proxy.pid))"
