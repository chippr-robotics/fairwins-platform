// Spec 049 (US1) — plain-language summary of a DRAFT policy config (the shape fed to
// encodeConfigureRules), used by the vault-creation wizard before anything is on-chain.
// Deployed policies are summarized from live state by policy.js#describeRules instead.

import { formatUnits } from '../evm/units'
import { formatDuration } from './policy'

/**
 * Plain-language lines for a policy config being drafted (US1-AS1), including the FR-002
 * 24-hour-window disclosure. Returns [] for skipped (null) or still-invalid configs.
 * @param {object|null} config `{limits, cooldown, allowlistEnabled, allowlistAdd}` (or `{invalid:true}`)
 * @param {Record<string,{symbol:string,decimals:number}>} assetMeta per-asset display metadata
 */
export function summarizePolicyConfig(config, assetMeta = {}) {
  if (!config || config.invalid) return []
  const fmt = (asset, amount) => {
    const meta = assetMeta[asset]
    return meta ? `${formatUnits(amount, meta.decimals)} ${meta.symbol}` : `${amount} units`
  }
  const lines = []
  for (const l of config.limits || []) {
    if (l.perTxLimit > 0n) lines.push(`Max ${fmt(l.asset, l.perTxLimit)} per transaction`)
    if (l.windowLimit > 0n) {
      lines.push(
        `Max ${fmt(l.asset, l.windowLimit)} per 24-hour window (the window opens with the first spend and resets 24 hours later)`,
      )
    }
  }
  if (config.allowlistEnabled) {
    const n = (config.allowlistAdd || []).length
    lines.push(`Recipients limited to ${n} approved address${n === 1 ? '' : 'es'}`)
  }
  if (config.cooldown > 0) lines.push(`At least ${formatDuration(config.cooldown)} between outgoing transactions`)
  return lines
}
