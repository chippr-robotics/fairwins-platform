# Production relayer — as-built (multichain: Mordor 63 + Polygon 137)

This is the **live** 3-container Cloud Run relayer (`fairwins-relay-gateway`, us-central1),
serving both chains from one service. It supersedes the single-chain snapshot in `../mordor/`.

- **config.json** — OZ engine config (`COPY config /app/config` in the image build; the VM estate
  instead mounts this file read-only from the repo checkout). The currently deployed engine tag is
  `fairwins-relay-engine:multichain-v1.5.0`; the upstream engine version inside it is **unverified
  in-repo** (the `Dockerfile` base is `v1.4.0`) — see `../../README.md` § Version pin. Two relayers (`mordor-63`, `polygon-137`), two KMS signers
  (`gas-key-mordor`, `gas-key-polygon`), two networks. Secrets arrive via env at runtime.
- **service.yaml** — the Cloud Run service (gateway :8788 + engine :8080 + redis). Gateway
  `ENABLED_CHAIN_IDS=63,137`; per-chain `GAS_WALLET_*` / `RPC_URLS_*` / `ENGINE_RELAYER_ID_*`.

## Gas wallets (hot; KMS-held keys, never floppy)
- Mordor  (63):  `0xf505d95F62bEE94437C112d3D64ee7Df0Fa973aC`  (KMS `gas-key-mordor`)
- Polygon (137): `0x3BB28b184b8a748dE22aBD076634F85adADA82db`  (KMS `gas-key-polygon`)

## Polygon go-live (2026-07-05)
KMS `gas-key-polygon` (HSM secp256k1) → gas wallet above; funded 10 POL from deployer
`0x52502d…` (tx `0x780fd70dd50770a50b8647f887eac3165e89f103bc2f4730397d2bb1fdc1eacf`).
Whitelisted receivers = Polygon `wagerRegistry` `0xE878b628…` + `membershipManager` `0xEfd1a880…`.
Polygon USDC supports EIP-3009 → payment intents relay here (unlike Mordor). Verified live:
`/status` → both chains `rpc:up`, Polygon runway ~200h.
