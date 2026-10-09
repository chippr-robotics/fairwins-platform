# Production relayer — config (LIVE) and Cloud Run snapshot (HISTORICAL)

Production is the **GCE VM docker-compose estate** (`infra/vm/gateway/docker-compose.yml`, see
`infra/vm/README.md` and `docs/architecture/relayer-infrastructure.md`). Two files live here, and they
are not equally current:

- **config.json — LIVE.** The OZ engine config: two relayers (`mordor-63`, `polygon-137`), two KMS
  signers (`gas-key-mordor`, `gas-key-polygon`), two networks. The VM mounts this file read-only into
  the engine container at `/app/config/config.json` (it is also what `COPY config /app/config` bakes
  into the image, from `../../config/config.json`, which must stay identical). Secrets arrive via env at
  runtime. **Since #1652 the engine reads it only on an EMPTY Redis**, so editing it and restarting
  changes nothing on a populated one; see `docs/runbooks/relayer-operations.md` § Storage mode.
  Polygon is EIP-1559 (`features: ["eip1559"]`, #1651); Mordor is legacy. The currently deployed engine
  tag is `fairwins-relay-engine:multichain-v1.5.0`; the upstream engine version inside it is
  **unverified in-repo** (the `Dockerfile` base is `v1.4.0`, #1650) — see `../../README.md` § Version
  pin.
- **service.yaml — RETAINED HISTORICAL SNAPSHOT, not the production record.** The Cloud Run service
  (gateway :8788 + engine :8080 + redis) that served both chains before the move to GCE. The service was
  deleted (verified absent 2026-08-23) and the manifest is not kept in step with the compose file. Like
  `../mordor/`, it is kept as an audit record only: do not apply it. Its image strings stay
  because the version-pin gate scans them.

## Gas wallets (hot; KMS-held keys, never floppy)
- Mordor  (63):  `0xf505d95F62bEE94437C112d3D64ee7Df0Fa973aC`  (KMS `gas-key-mordor`)
- Polygon (137): `0x3BB28b184b8a748dE22aBD076634F85adADA82db`  (KMS `gas-key-polygon`)

## Polygon go-live (2026-07-05)
KMS `gas-key-polygon` (HSM secp256k1) → gas wallet above; funded 10 POL from deployer
`0x52502d…` (tx `0x780fd70dd50770a50b8647f887eac3165e89f103bc2f4730397d2bb1fdc1eacf`).
Whitelisted receivers = Polygon `wagerRegistry` `0xE878b628…` + `membershipManager` `0xEfd1a880…`.
Polygon USDC supports EIP-3009 → payment intents relay here (unlike Mordor). Verified live:
`/status` → both chains `rpc:up`, Polygon runway ~200h.
