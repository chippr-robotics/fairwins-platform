# FairWins relay gateway (spec 036) — intent policy front-end for the OSS submission engine.
#
# BUILD CONTEXT = REPO ROOT (the image bakes in deployments/ for the FR-025 startup check):
#   docker build -f services/relay-gateway/Dockerfile -t fairwins-relay-gateway .
#
# Holds NO keys: the gas hot key lives in the engine (Secret Manager); this container only
# needs the origin-lock + webhook shared secrets injected at runtime (never baked in).
FROM node:22.23.3-alpine3.24 AS deps
WORKDIR /app
# Spec 075: this service is an npm WORKSPACE member, so its dependencies live in the single root
# lockfile. Copy the root manifest+lock plus this workspace's manifest, then install only this
# workspace. The previous `package-lock.json*` glob silently matched nothing once the child lock
# was removed and fell through to a plain `npm install` — a non-reproducible image built from
# whatever the registry served that day.
COPY package.json package-lock.json ./
COPY services/relay-gateway/package.json ./services/relay-gateway/
# The linked workspace package's manifest must be present too. This service depends on
# @fairwins/intent-types (spec 075, FR-024), and `npm ci` writes the workspace symlink whether
# or not its target exists — so omitting it produced a DANGLING link, a build that succeeded,
# and a container that died at boot on ERR_MODULE_NOT_FOUND. The install cannot tell you.
COPY packages/intent-types/package.json ./packages/intent-types/
# Same rule for @fairwins/assistant-contract (spec 104): the assistant's prompt + tool table.
# Forgetting a new linked package here reproduces the exact dangling-symlink boot death above.
COPY packages/assistant-contract/package.json ./packages/assistant-contract/
RUN npm ci --omit=dev --no-audit --no-fund \
      --workspace fairwins-relay-gateway --include-workspace-root=false

FROM node:22.23.3-alpine3.24 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY services/relay-gateway/package.json ./
COPY services/relay-gateway/src ./src
# The symlink copied with node_modules resolves to /app/packages/intent-types, so the RUNTIME
# stage needs the real files as well — carrying the link alone is what made this image start
# and immediately exit. src/intent/intentTypes.js imports it at module load, reached from
# src/server.js at boot, so every gateway surface (035/036 intents, the 050 paymaster endpoint,
# the 057 Polymarket proxy, 060 fee reads, 061 Bitcoin) fails together.
COPY packages/intent-types ./packages/intent-types
# spec 104: src/memberApi/routes.js imports @fairwins/assistant-contract at module load, reached
# from src/server.js at boot — the runtime stage needs the real files behind that symlink too.
COPY packages/assistant-contract ./packages/assistant-contract
# Version-pinned target set (FR-025): the deployments records are baked into the image so the
# startup consistency check validates against the exact addresses this build was shipped with.
COPY deployments ./deployments
ENV DEPLOYMENTS_DIR=/app/deployments
# Drop privileges: the node image ships a non-root `node` user.
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
