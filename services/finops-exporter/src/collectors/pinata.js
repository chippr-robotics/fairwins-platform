/**
 * Pinata / IPFS collector (spec 089, FR-005).
 *
 * WHY THIS SOURCE EXISTS AT ALL. Pinata is a paid vendor on the MEMBER WRITE PATH — wager creation,
 * open challenges and encrypted data backup all pin JSON with no fallback — plus the mini-app
 * publishing path, whose CIDs are keccak-committed on chain. `docs/architecture/workbook/
 * 06-external-vendors.md` has recorded it as "we pay them (not catalogued as a cost source)" since
 * the vendor audit, which is the gap this closes. Neither discovery route in `check:finops` could
 * ever have found it: it registers no FeeRouter `serviceId` and no gateway `_PAY_TO`, because the
 * money flows the other way — we are the customer.
 *
 * ⚠ THE CREDENTIAL HERE IS NOT THE PINNING JWT, AND MUST NOT BE.
 *
 * `PINATA_JWT` / `VITE_PINATA_JWT` authorise `pinJSONToIPFS` and `pinFileToIPFS` — they are WRITE
 * credentials, and the exporter is read-only by construction (FR-026): no signer, no write route,
 * and `fetch-secrets.sh` refuses to boot if key material reaches its env. Handing it a credential
 * that can write to a member-facing store would make that guarantee false for the sake of a
 * storage figure.
 *
 * So this reads `FINOPS_PINATA_READ_JWT`: a SEPARATE Pinata key scoped to `data/userPinnedDataTotal`
 * and nothing else. Unset ⇒ `not-configured`, which is honest and costs nothing.
 *
 * Pinata's own scope model is why that separation is worth the extra key rather than a convenience
 * to skip. A key valid for `pinFileToIPFS` but not `pinJSONToIPFS` authenticates correctly, passes
 * `testAuthentication`, and breaks every member write — a real production incident on 2026-08-30.
 * Scope is load-bearing on this vendor and is not observable from whether the credential "works".
 *
 * ⚠ USAGE IS MEASURED; THE DOLLAR FIGURE IS NOT. `GET /data/userPinnedDataTotal` (verified against
 * the vendor's API reference: bearer auth, returns `pin_count`, `pin_size_total`,
 * `pin_size_with_replications_total`) reports STORAGE, never money — Pinata publishes no billing
 * API on our plan. Same split as Cloudflare and QuickNode: the bytes are a fact, the cost is
 * `basis="modelled"` from a declared plan price, and the two are reported independently so an
 * unpriced plan never looks like an API outage.
 */
import { read, notConfigured, unreadable } from '../reading.js'

/**
 * Both size figures are published, deliberately.
 *
 * `pin_size_total` is the logical size of what we pinned; `pin_size_with_replications_total` is
 * what Pinata actually stores. Which of them a plan bills against is the vendor's business and not
 * something this collector can observe, so it publishes both under distinct `metric` labels rather
 * than silently electing one and presenting it as "our storage". Picking would be an unstated
 * assumption inside a cost system, which is the thing this whole catalogue exists to not do.
 */
export function createPinataCollector({ config, fetchImpl = fetch, log = console.warn }) {
  /** @type {{pins: number, bytes: number, bytesWithReplication: number}|null} */
  let lastUsage = null

  async function collectPinata(source) {
    const { readJwt, endpoint, planMonthlyUsd } = config.pinata ?? {}

    if (!readJwt) {
      return notConfigured(
        'FINOPS_PINATA_READ_JWT is not set — it must be a READ-SCOPED key (data/userPinnedDataTotal only), never the pinning JWT',
      )
    }

    let body
    try {
      const res = await fetchImpl(`${endpoint}/data/userPinnedDataTotal`, {
        headers: { authorization: `Bearer ${readJwt}`, accept: 'application/json' },
      })
      // 401/403 here is very likely a SCOPE problem rather than a dead key, given this vendor's
      // history — say so, because "unauthorized" sends an operator to rotate a credential that is
      // probably fine.
      if (res.status === 401 || res.status === 403) {
        return unreadable(
          `pinata rejected the read key (HTTP ${res.status}) — check its SCOPE covers data/userPinnedDataTotal, not just that the key is valid`,
        )
      }
      if (!res.ok) throw new Error(`pinata API HTTP ${res.status}`)
      body = await res.json()
    } catch (err) {
      return unreadable(err?.message ?? err)
    }

    const pins = body?.pin_count
    const bytes = body?.pin_size_total
    // An unrecognised shape is an error, never a zero: "0 bytes pinned" would report that the
    // member-facing store is empty, which for this estate is a claim that is definitely false.
    if (typeof bytes !== 'number' || !Number.isFinite(bytes)) {
      return unreadable(
        `pinata usage response had no numeric pin_size_total (keys: ${Object.keys(body ?? {}).join(',')})`,
      )
    }

    lastUsage = {
      pins: typeof pins === 'number' && Number.isFinite(pins) ? pins : null,
      bytes,
      bytesWithReplication:
        typeof body?.pin_size_with_replications_total === 'number' ? body.pin_size_with_replications_total : null,
    }

    // The usage read SUCCEEDED. Whether a dollar figure can be put on it is a separate question,
    // and conflating them would make an undeclared plan price look like a vendor outage.
    if (planMonthlyUsd == null) {
      log('[finops] pinata: usage read, but FINOPS_PINATA_PLAN_USD is unset — no cost modelled')
      return notConfigured('usage available; FINOPS_PINATA_PLAN_USD is unset so no cost can be modelled')
    }

    return read(planMonthlyUsd, 'USD', { labels: { basis: 'modelled' } })
  }

  collectPinata._lastUsage = () => lastUsage

  return collectPinata
}

/** Emit the measured storage. A fact, even when the dollar figure beside it is a model. */
export function emitPinataUsage(registry, collector, source) {
  const usage = collector._lastUsage?.()
  if (!usage) return
  const series = {
    pinned_objects: usage.pins,
    pinned_bytes: usage.bytes,
    pinned_bytes_with_replication: usage.bytesWithReplication,
  }
  for (const [metric, value] of Object.entries(series)) {
    // `null` means the vendor did not return that field. Skipped rather than zeroed — an absent
    // series reads as unknown, and `0` would read as "nothing pinned".
    if (value == null) continue
    registry.emit(
      'vendor_usage',
      'gauge',
      'Raw vendor usage over the trailing window. Measured, unlike the modelled dollar figure beside it.',
      { source: source.id, metric },
      value,
    )
  }
}
