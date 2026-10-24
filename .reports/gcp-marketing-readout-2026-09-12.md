# GCP live-state readout for the blog-publishing pipeline

**For:** session_01Bysb826QbKDMJNoPSSWxRZ (blog-publishing-automation planning)
**By:** session_015D3avTLhv3hnkeFZnKuyWE · 2026-09-12 · project `chippr-bots-site-wp`
**READ-ONLY.** Nothing was created, changed, started, or stopped. No secret *value* was read —
names and metadata only. One API-enable prompt (Cloud DNS) was declined rather than accepted.

**Delivery note:** the `claude-code-remote` MCP tools (`create_trigger`/`fire_trigger`/
`delete_trigger`) are **not connected to this session**, so I could not reply the way you asked.
`RemoteTrigger` is available but it manages claude.ai *routines* and takes no
`persistent_session_id`; I did not guess at an undocumented body shape to fire something at another
session. This file is the fallback you named.

---

## 1. WordPress VM

| | |
|---|---|
| Instance | `openlitespeed-wordpress-3-vm` |
| State | **RUNNING** |
| Machine / zone | `n1-standard-1`, `us-central1-a` |
| IPs | internal `10.128.0.3`, external `104.197.253.232` |
| Created | 2022-10-19 (Deployment Manager: `openlitespeed-wordpress-3`) |
| Doc root | `/var/www/html` |

### Domain: **`chipprbots.com`** — no "e". `chipperbots.com` does not exist.

```
chipprbots.com      -> 104.21.19.38, 172.67.184.244   (Cloudflare, proxied)
www.chipprbots.com  -> same
chipperbots.com     -> NO RECORD
blog.chipprbots.com -> NO RECORD
```

Note the site is **behind Cloudflare** — public DNS never points at `104.197.253.232`. Cert is
Google Trust Services `CN=chipprbots.com`, SAN `chipprbots.com` + `*.chipprbots.com`, valid
2026-09-02 → 2026-12-01. The wildcard SAN means a new subdomain needs no new cert.

**DNS is not in GCP.** The Cloud DNS API is not enabled on this project, and the FairWins infra
already manages edge DNS at Cloudflare — so zone edits belong there, not here.

### REST API: **reachable and healthy**

`GET https://chipprbots.com/wp-json/` → **HTTP 200**, `application/json`, 1.43 MB, 29 namespaces.
Site name "Chippr Robotics", tagline "Happy Helpful Robots", `gmt_offset -5`. `wp/v2` is present,
so programmatic posting works once you have credentials.

### Social publishing: **already installed and active** — more than you asked about

`wp plugin list` (via wp-cli on the VM):

| plugin | status | version | relevance |
|---|---|---|---|
| **`wp-linkedin-auto-publish`** | **active** | 8.26 | **This is your LinkedIn publisher — it already exists** |
| **`twitter-auto-publish`** | **active** | 1.7.7 | X/Twitter auto-post |
| `activitypub` | active | 9.3.1 | Federates posts to Mastodon/Fediverse |
| `enable-mastodon-apps` | active | 1.6.4 | Mastodon *clients* can post into WP |
| `webfinger` / `nodeinfo` | active | 3.2.7 / 3.1.0 | Federation discovery (webfinger returns 200) |
| `friends` + `friends-post-collection` | active | 4.3.1 / 1.2.1 | Fediverse reader/collector |
| `display-medium-posts` | active | 5.0.1 | Medium |
| `share-on-pixelfed` | **inactive** | 0.9.0 | Pixelfed — installed, switched off |
| `hum` | **inactive** | 1.3.4 | Short-URL generator — installed, switched off |
| `litespeed-cache` | active | 7.9 | Cache — **will need purging after automated posts** |

Plus WooCommerce 11.1.0 and four Woo extensions (a real storefront, not a demo).

**Correction worth carrying:** `jetpack/v4` appears in the REST namespaces, but **Jetpack is NOT
installed** — there is no `jetpack` plugin directory. That namespace comes from the Jetpack
connection library bundled inside `woocommerce-payments`. So **Jetpack Social is not available**,
and a plan that assumed it would be building on something that is not there. **Blog2Social is also
absent.** The LinkedIn path you want is `wp-linkedin-auto-publish`, which is already live.

**Operational trap:** `wp` CLI **fails at the default 128 MB PHP memory limit** — WooCommerce's
action-scheduler exhausts it and returns "critical error" rather than a memory message. Every
wp-cli call needs `php -d memory_limit=768M $(command -v wp) …`. Anything automating through
wp-cli will hit this immediately and the error will not say why.

---

## 2. Bluesky / AT Protocol

**There is no self-hosted PDS running, and you almost certainly do not need one.**

The account is live on **Bluesky's managed infrastructure**:

```
_atproto.chipprbots.com  TXT  did=did:plc:hyckc5a4scdii4oijbouaiug
did:plc:hyckc5a4scdii4oijbouaiug
  alsoKnownAs : at://chipprbots.com
  PDS         : https://truffle.us-east.host.bsky.network   <- Bluesky's own host
```

So `@chipprbots.com` is a working Bluesky handle, hosted by Bluesky, verified by the TXT record.
Posting to it needs only the app-password API — no infrastructure.

**The abandoned self-hosting attempt, and what survives:**

| | |
|---|---|
| Disk | `at-protocol`, 10 GB, `pd-balanced`, `us-central1-a`, **status READY** |
| Attached | **No — `users` is empty.** The VM it belonged to is gone. |
| Created | 2024-12-05 (from `debian-12-bookworm-v20241112`) |
| Detached | **2026-05-02** |

**The data survives.** An unattached persistent disk is not deleted with its VM — it persists and
keeps billing (~$0.40/mo at 10 GB pd-balanced). It can be re-attached to a new VM read-only to
inspect it. Note the source image is plain Debian, so this was a self-build, not a marketplace PDS.

No PDS-shaped Cloud Run service, no reserved static IP for it, and **no DNS**: `pds.`, `bsky.`,
`atproto.`, `social.` under `chipprbots.com` all return nothing.

**Decision this forces:** the disk is either worth mounting once to recover config, or worth
deleting to stop the charge. It has been detached four months. Nothing depends on it.

---

## 3. Other marketing-adjacent assets

**Secret Manager — exactly ONE social/marketing entry out of ~90:**

```
chippr-social-bluesky     created 2026-08-23, 1 version, enabled
```

Filtered for `twitter|x_|linkedin|instagram|tiktok|mastodon|canva|wordpress|wp_|mail|smtp|
sendgrid|buffer|hootsuite|atproto` — **no matches.** So:

- **No Canva credential exists.** The Canva half of the pipeline starts from zero.
- **No LinkedIn/X API credential in GCP** — the WP plugins hold their own OAuth tokens in the WP
  database, which is why they work without one. Worth knowing: those tokens are **not** backed up
  by anything in Secret Manager, and they live on a VM whose only snapshot is from 2023-08-19.
- **No mail/SMTP config** anywhere in Secret Manager.

There *are* Cloudflare credentials (`chippr_cloudflare_ApiToken`, `chippr_cloudflare_accountId`,
`chippr_cloudflare_access_key_id`, `chippr-cloudflare-secrect-access-key` [sic — typo is in the
name], plus `chippr_cloudflare_s3_api` which suggests R2). Those are the levers for DNS and edge.

**Other infrastructure in this project** (context — none of it marketing):
- VMs `fairwins-bundler` + `fairwins-gateway` (RUNNING, the FairWins gasless stack)
- Cloud Run: `fukuii-primary`, `fukuii-website`, `prediction-dao-research` (×2 regions),
  `prediction-dao-research-staging`, `-staging-testnet`
- Snapshots: `snapshot-1` (WP VM, **2023-08-19 — three years stale**), `snapshot-2`
  (`hoodi-20250927-225140`, 100 GB, 2025-10-18)
- **No stopped VMs at all.** Nothing social-bot-shaped is parked.

---

## What I could not check

- **Plugin *configuration*** — whether `wp-linkedin-auto-publish` and `twitter-auto-publish` hold
  valid, unexpired OAuth tokens. That is in the WP database and needs admin access; the plugins
  being `active` does not prove they can currently post.
- **Cloudflare zone contents** — DNS is there, not in GCP, and I did not use the Cloudflare
  credentials. Subdomain inventory beyond the names I probed by hand is unknown.
- **Whether `chipperbots.com` is registered at all** — it has no DNS, but a registrar lookup is a
  different question from a resolution failure.
- **The `at-protocol` disk's contents** — that needs attaching it to a VM, which is a change.

---

## Three things worth acting on

1. **The LinkedIn publisher already exists and is active.** Plan around
   `wp-linkedin-auto-publish` rather than adding Jetpack Social, which is not installed and whose
   REST namespace is a false positive from WooPayments.
2. **wp-cli needs `-d memory_limit=768M` or it dies with a misleading "critical error".** Any
   automation will hit this on its first call.
3. **The WP VM's only snapshot is from 2023-08-19.** Every social OAuth token, and the whole
   WooCommerce store, lives on one unreplicated 10 GB disk. That is a bigger risk than anything in
   this readout.
