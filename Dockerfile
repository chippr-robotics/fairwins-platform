# Multi-stage build for React frontend with Vite
# Stage 1: Build the React application
FROM node:22.23.3-alpine3.24 AS build

# Build from the REPO ROOT, not frontend/ (spec 075). There is one root lockfile now, so
# `COPY frontend/package*.json` matched only package.json and `npm ci` failed outright with
# "can only install with an existing package-lock.json". Restoring a child lockfile is not the
# fix either: frontend/package.json declares @fairwins/intent-types and @fairwins/miniapp-build,
# which are `private: true` workspace packages that can never resolve from the registry.
WORKDIR /app

# Manifests first, so a source-only change does not invalidate the install layer.
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY packages/intent-types/package.json ./packages/intent-types/
# spec 104: frontend/src/lib/assistant imports @fairwins/assistant-contract — same dangling-
# symlink hazard the gateway Dockerfile documents; omit this and vite dies at resolve time.
COPY packages/assistant-contract/package.json ./packages/assistant-contract/
COPY tools/miniapp-build/package.json ./tools/miniapp-build/

# Native-module toolchain (spec 085): @trezor/connect-web transitively pulls `usb`, whose install
# builds libusb via node-gyp when no prebuild matches. Build-stage-only — the runtime image is
# untouched, and the browser bundle never imports the Node transport that needs it.
RUN apk add --no-cache python3 make g++ linux-headers eudev-dev

RUN npm ci --workspace frontend --include-workspace-root=false

# The linked workspace SOURCES. `npm ci` writes a workspace link whether or not the target
# directory exists — a missing one yields a DANGLING symlink and an install that looks clean,
# which is exactly how the relay-gateway image built successfully and then crashed on boot.
COPY packages/intent-types/ ./packages/intent-types/
COPY packages/assistant-contract/ ./packages/assistant-contract/
COPY tools/miniapp-build/ ./tools/miniapp-build/

# Source + tenant manifests (spec 072 — the tenant-branding plugin resolves tenants/ as a
# sibling of the frontend tree; the build fails loudly if the directory is missing).
COPY frontend/ ./frontend/
COPY tenants/ ./tenants/

WORKDIR /app/frontend

# Build arguments for environment variables (baked into JS bundle at build time)
# Note: VITE_PINATA_JWT is NOT included here - it's handled at runtime via nginx proxy
# Tenant selection (spec 072): one image = one tenant. Unset => the default
# (fairwins) tenant, byte-identical to the pre-072 build.
# Build stamp for the nav drawer's version label (src/config/buildInfo.js). Passed as a build ARG
# rather than derived: .dockerignore excludes .git, so the image build cannot run `git rev-parse`.
# Unset resolves to 'dev', which the drawer displays honestly instead of hiding the label.
ARG VITE_COMMIT_SHA
ARG VITE_TENANT_ID
ARG VITE_WALLETCONNECT_PROJECT_ID
ARG VITE_APP_URL
ARG VITE_NETWORK_ID
ARG VITE_RPC_URL
# Per-chain RPC primaries for the EVM mainnets (spec 069's `NETWORKS[chainId].rpcUrl`, resolved
# through lib/network/rpcEndpoints.js). Unset or BLANK falls back to the committed public default
# in config/networks.js, so an image that sets none of these is byte-identical to the pre-existing
# build — `'' || 'https://ethereum-rpc.publicnode.com'` takes the fallback.
#
# ⚠ THESE COMPILE INTO THE PUBLIC BUNDLE (spec 097 rule 5). A VITE_ value is readable by anyone who
# loads the app, so ONLY a QuickNode endpoint with referrer/origin restrictions may be set here.
# The archive endpoints in the secrets registry (fairwins-quicknode-<chain>-url) are a DIFFERENT
# credential and must never be passed to this build — moving one here does not hide it, it
# publishes it.
ARG VITE_RPC_URL_MAINNET
ARG VITE_RPC_URL_OPTIMISM
ARG VITE_RPC_URL_BASE
ARG VITE_RPC_URL_ARBITRUM
ARG VITE_IPFS_GATEWAY
# v2 WagerRegistry subgraph (Spec 017 / #707) — public, build-time only.
ARG VITE_SUBGRAPH_URL
ARG VITE_WAGER_SOURCE
# Gasless relayer base URL (spec 036). Unset => gasless disabled, everything self-submits.
ARG VITE_RELAYER_URL
# Bitcoin gateway base URL (spec 061 / issue #1263). Optional: unset (or blank) falls back to
# VITE_RELAYER_URL, so an image that sets only that one is byte-identical. Set it to point the
# Bitcoin client at a gateway without turning on the other gateway-backed clients. It cannot turn
# Bitcoin OFF — blank means "fall through", so an image with VITE_RELAYER_URL set has a configured
# Bitcoin client either way; leaving Bitcoin unconfigured means leaving both names unset.
ARG VITE_BITCOIN_GATEWAY_URL
# Passkey ERC-4337 bundler URL(s), comma-separated (spec 041). Unset => passkeyConfig(137) is null,
# so passkey smart accounts stay disabled on Polygon.
ARG VITE_BUNDLER_URLS_POLYGON
# The same, per chain (#1501). One alto process serves one chain, so each chain that gains a bundler
# needs its own URL — and its own ARG here, because docker DROPS a --build-arg the Dockerfile never
# declared, with only a warning. Unset => passkeyConfig(<chain>) is null and passkey stays dark
# there, which is the honest default. ETC 61 and Mordor 63 are deliberately absent: they lack
# opcodes that block features, and are out of scope for the bundler rollout.
ARG VITE_BUNDLER_URLS_MAINNET
ARG VITE_BUNDLER_URLS_OPTIMISM
ARG VITE_BUNDLER_URLS_BASE
ARG VITE_BUNDLER_URLS_ARBITRUM
ARG VITE_BUNDLER_URLS_AMOY
# Sponsored-paymaster endpoint (spec 050): the relay-gateway's /v1/paymaster. Set => passkey UserOps
# are gasless (FairWins sponsors gas); unset => the account self-funds and the UI discloses honestly.
# DELIBERATELY POLYGON + AMOY ONLY. Sponsorship is not being extended with the bundler rollout: on
# every other chain a passkey member pays their own gas, which the confirm surfaces already disclose
# from `sponsorPaymasterUrl` being absent. Adding an ARG for a chain with no paymaster would invite
# someone to set it and quietly promise sponsorship that does not exist.
ARG VITE_SPONSOR_PAYMASTER_POLYGON
ARG VITE_SPONSOR_PAYMASTER_AMOY
# Non-production marker (FR-026d). It had NO ARG until #1501's build-arg gate found it: staging set
# it, docker dropped it, and the banner warning that staging sends REAL mainnet transactions never
# rendered once.
ARG VITE_STAGING_BANNER
# Perps position management (spec 083). Read-only perps market data needs only VITE_RELAYER_URL;
# this flag is what lets a member OPEN, CLOSE, REDUCE or PROTECT a leveraged position from the app.
# Unset (the default) => the Perps view renders exactly as spec 082 shipped it: pairs, insights and
# read-only positions, with management on the venue. Setting it to 'true' makes real leveraged
# trading reachable, so it is deliberately absent from every cloudbuild until that is a decision
# someone has made on purpose.
ARG VITE_PERPS_MANAGE_ENABLED
# Release identity (spec 076, FR-029/FR-032). Baked in at build so the running app can name the
# release it came from. VITE_APP_VERSION is the tag at the built commit, or empty when the commit
# is not a published release — in which case the app reports `unreleased+<sha>` rather than the
# nearest tag (FR-031). Never hardcode either value; both come from the build.
ARG VITE_APP_VERSION
ARG VITE_GIT_SHA

# Set environment variables from build args
ENV VITE_COMMIT_SHA=${VITE_COMMIT_SHA}
ENV VITE_TENANT_ID=${VITE_TENANT_ID}
ENV VITE_WALLETCONNECT_PROJECT_ID=${VITE_WALLETCONNECT_PROJECT_ID}
ENV VITE_APP_URL=${VITE_APP_URL}
ENV VITE_NETWORK_ID=${VITE_NETWORK_ID}
ENV VITE_RPC_URL=${VITE_RPC_URL}
ENV VITE_RPC_URL_MAINNET=${VITE_RPC_URL_MAINNET}
ENV VITE_RPC_URL_OPTIMISM=${VITE_RPC_URL_OPTIMISM}
ENV VITE_RPC_URL_BASE=${VITE_RPC_URL_BASE}
ENV VITE_RPC_URL_ARBITRUM=${VITE_RPC_URL_ARBITRUM}
ENV VITE_IPFS_GATEWAY=${VITE_IPFS_GATEWAY}
ENV VITE_SUBGRAPH_URL=${VITE_SUBGRAPH_URL}
ENV VITE_WAGER_SOURCE=${VITE_WAGER_SOURCE}
ENV VITE_RELAYER_URL=${VITE_RELAYER_URL}
ENV VITE_BITCOIN_GATEWAY_URL=${VITE_BITCOIN_GATEWAY_URL}
ENV VITE_BUNDLER_URLS_POLYGON=${VITE_BUNDLER_URLS_POLYGON}
ENV VITE_BUNDLER_URLS_MAINNET=${VITE_BUNDLER_URLS_MAINNET}
ENV VITE_BUNDLER_URLS_OPTIMISM=${VITE_BUNDLER_URLS_OPTIMISM}
ENV VITE_BUNDLER_URLS_BASE=${VITE_BUNDLER_URLS_BASE}
ENV VITE_BUNDLER_URLS_ARBITRUM=${VITE_BUNDLER_URLS_ARBITRUM}
ENV VITE_BUNDLER_URLS_AMOY=${VITE_BUNDLER_URLS_AMOY}
ENV VITE_SPONSOR_PAYMASTER_POLYGON=${VITE_SPONSOR_PAYMASTER_POLYGON}
ENV VITE_SPONSOR_PAYMASTER_AMOY=${VITE_SPONSOR_PAYMASTER_AMOY}
ENV VITE_STAGING_BANNER=${VITE_STAGING_BANNER}
ENV VITE_PERPS_MANAGE_ENABLED=${VITE_PERPS_MANAGE_ENABLED}
ENV VITE_APP_VERSION=${VITE_APP_VERSION}
ENV VITE_GIT_SHA=${VITE_GIT_SHA}

# Build the application
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:1.30.5-alpine

# Install envsubst for runtime environment variable substitution
RUN apk add --no-cache gettext

# Copy built assets from build stage
COPY --from=build /app/frontend/dist /usr/share/nginx/html

# Copy nginx configuration template (JWT will be substituted at runtime)
COPY frontend/nginx.conf.template /etc/nginx/conf.d/default.conf.template

# Copy entrypoint script
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Expose port 8080 (Google Cloud Run default)
EXPOSE 8080

# Use entrypoint script to substitute env vars and start nginx
ENTRYPOINT ["/docker-entrypoint.sh"]
