# FairWins FinOps exporter (spec 089) — polls every catalogued revenue and cost source and exposes
# them as Prometheus metrics on loopback.
#
# BUILD CONTEXT = REPO ROOT (it depends on the @fairwins/finops-catalogue workspace package):
#   docker build -f services/finops-exporter/Dockerfile -t fairwins-finops-exporter .
#
# HOLDS NO KEYS AND CANNOT HOLD ONE. There is no signer in this service and no write route: it
# reports on money and must never be able to move any (FR-026). Vendor READ tokens are injected at
# runtime from Secret Manager and are never baked in.
FROM node:22.23.3-alpine3.24 AS deps
WORKDIR /app
# Spec 075: a workspace member's dependencies live in the single ROOT lockfile. Copy the root
# manifest+lock plus this workspace's manifest, then install only this workspace.
COPY package.json package-lock.json ./
COPY services/finops-exporter/package.json ./services/finops-exporter/
# The linked workspace package's manifest must be present too. `npm ci` writes the workspace symlink
# whether or not its target exists, so omitting this produces a DANGLING link, a build that
# succeeds, and a container that dies at boot on ERR_MODULE_NOT_FOUND — exactly the failure the
# relay-gateway image hit with @fairwins/intent-types. The install cannot tell you.
COPY packages/finops-catalogue/package.json ./packages/finops-catalogue/
RUN npm ci --omit=dev --no-audit --no-fund \
      --workspace fairwins-finops-exporter --include-workspace-root=false

FROM node:22.23.3-alpine3.24 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY services/finops-exporter/package.json ./
COPY services/finops-exporter/src ./src
# The symlink copied with node_modules resolves to /app/packages/finops-catalogue, so the RUNTIME
# stage needs the real files as well. src/server.js imports the catalogue at module load, so
# carrying the link alone would start the image and immediately exit.
COPY packages/finops-catalogue ./packages/finops-catalogue
# Drop privileges: the node image ships a non-root `node` user.
USER node
# Documentation only — the container joins the gateway's network namespace and publishes no ports.
# The exporter binds 127.0.0.1 and is unreachable from outside the VM (FR-027).
EXPOSE 9464
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9464)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
