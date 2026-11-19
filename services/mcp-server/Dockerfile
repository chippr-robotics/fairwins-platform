# FairWins MCP server (spec 095) — the member API as a Model Context Protocol server.
#
# BUILD CONTEXT = THIS DIRECTORY, not the repo root:
#   docker build -f services/mcp-server/Dockerfile -t fairwins-mcp-server services/mcp-server
#
# That is the opposite of the relay-gateway and finops-exporter images, and it is deliberate: this
# service depends on NOTHING — no workspace package, no npm registry, no lockfile. There is no
# `npm ci` stage here at all, so there is no install to go wrong, no dangling workspace symlink to
# die at boot on (the failure both other images have hit), and no third-party code in the image
# beyond Node itself. Keep it that way: the moment this needs a dependency it needs the root
# lockfile, the repo-root context, and everything spec 075 documents about both.
#
# HOLDS NO SECRET AND CANNOT SIGN. There is no key, no seed and no signer in this service, and the
# API it talks to has no write route. The member's own capability token arrives per request as an
# Authorization header (or, for a single-member deployment, in FAIRWINS_API_TOKEN at runtime) and is
# never baked in.
FROM node:22.23.3-alpine3.24 AS runtime
WORKDIR /app
ENV NODE_ENV=production

# package.json is copied for its version — `initialize` reports it as serverInfo.version, and an
# image that answered "unknown" would make a bug report unanswerable.
COPY package.json ./
COPY src ./src

# Drop privileges: the node image ships a non-root `node` user.
USER node

# The container serves the HTTP transport. Where an MCP client spawns this server itself it uses the
# stdio transport instead and never touches this port.
ENV PORT=8790
EXPOSE 8790

# `wget` is not in node:22-alpine's default image; Node's own fetch is, and it is the same runtime
# the service uses — so a healthcheck failing means the runtime is genuinely unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No literal port: `--http` alone reads $PORT (Cloud Run injects it) and falls back to 8790,
# which ENV PORT above pins for local runs so the EXPOSE/HEALTHCHECK behavior is identical.
#
# `--host 0.0.0.0` IS EXPLICIT HERE ON PURPOSE. The server defaults to 127.0.0.1 (a laptop running
# `--http` should not put a member's tools on every interface), and a container that inherited that
# default would be unreachable through `-p 8790:8790` while its HEALTHCHECK — which curls loopback
# from INSIDE the namespace — went on reporting healthy. Binding every interface is right here
# because the network namespace is the boundary, not the bind address: what is exposed is decided by
# the operator's `-p` / the Cloud Run ingress. Saying it in the CMD rather than leaning on the
# K_SERVICE fallback puts that decision where somebody reading this file can see it.
CMD ["node", "src/server.js", "--http", "--host", "0.0.0.0"]
