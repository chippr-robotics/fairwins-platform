/**
 * useStakingOptions (spec 065, US1) — the curated staking options across every
 * staking-enabled network (chain 1 at launch), normalized into one list. Like
 * the Earn lending list, network selection is transparent: each option carries
 * its chainId and the UI badges it; submitting handles any network switch.
 *
 * Options come from config (Lido + sPOL liquid, plus the curated validator
 * allowlist for delegated). Live enrichment — Lido APR, sPOL rate/TVL/fee,
 * validator commission/status — is best-effort and degrades to null ("—")
 * without hiding the option (constitution III). The Polygon staking API only
 * decorates allowlisted validators; it never expands the list (FR-008).
 *
 * Status: 'loading' | 'ready' | 'unavailable'. A hard failure to build the base
 * list is 'unavailable' (staking disabled) — never stale numbers as truth.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NETWORKS, getStakingNetworks } from '../config/networks'
import { POL_TOKEN_L1, stakingRouterServiceIdFor } from '../config/staking'
import { getPublicClient } from '../lib/chains/publicClient'
import { fetchLidoApr, readLidoPosition } from '../lib/staking/lidoStaking'
import { readSpolTvl, readSpolRewardFee } from '../lib/staking/spolStaking'
import { fetchValidatorDecoration, unbondingLabel, readStakeManagerTiming } from '../lib/staking/polygonDelegation'
import { readStakingRouterConfig } from '../lib/staking/stakingRouter'
import { fetchFeeQuote } from '../lib/fees/feeQuote'

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const sameAddr = (a, b) => a && b && a.toLowerCase() === b.toLowerCase()
// A router provider slot is only usable if it's a real, non-zero address. A router deployed with a
// provider not yet configured returns the zero address (truthy) — overlaying that over the known-good
// spec-065 constant would silently break staking, so we keep the constant instead.
const isSetAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO_ADDR

/**
 * Overlay the on-chain StakingRouter config onto the spec-065 base options for one
 * network (spec 066). Provider addresses, the validator allowlist, the paused flag,
 * and the per-provider LIQUID fee are sourced from the router when it is deployed;
 * when it is absent/unreadable the options keep the spec-065 constants verbatim
 * (fee-free, direct, availability as configured — FR-009). Mutates `options` in place.
 */
export async function overlayRouterConfig(options, { chainId, provider }) {
  let cfg = null
  if (provider) {
    try {
      cfg = await readStakingRouterConfig({ chainId, provider })
    } catch {
      cfg = null
    }
  }
  if (!cfg) return options // no router (or unreadable) ⇒ spec-065 defaults, fee-free

  const kept = []
  for (const opt of options) {
    opt.stakingRouterAddress = cfg.routerAddress
    opt.stakingPaused = cfg.paused
    if (opt.providerKind === 'lido' && isSetAddr(cfg.providers.lido?.steth) && isSetAddr(cfg.providers.lido?.wsteth)) {
      opt.contracts = { ...opt.contracts, steth: cfg.providers.lido.steth, wsteth: cfg.providers.lido.wsteth }
    }
    if (opt.providerKind === 'spol' && isSetAddr(cfg.providers.spol?.controller) && isSetAddr(cfg.providers.spol?.token)) {
      opt.contracts = { ...opt.contracts, controller: cfg.providers.spol.controller, token: cfg.providers.spol.token }
    }
    // Delegated: the on-chain allowlist is the source of truth for NEW delegations. A validator
    // removed on-chain drops from the offered options (existing positions stay exitable via
    // useStakingPositions). When the router carries no allowlist yet, keep none for new delegations.
    if (opt.providerKind === 'validator-share') {
      if (!cfg.validators.some((v) => sameAddr(v, opt.validatorShare))) continue
    }
    // LIQUID fee overlay: read the live per-provider rate; a present-but-unreadable router blocks
    // only the fee-bearing path (never assume a lower rate).
    const serviceId = stakingRouterServiceIdFor(opt.providerKind)
    if (serviceId) {
      try {
        opt.feeQuote = await fetchFeeQuote({ serviceId, chainId, provider })
        opt.stakingFeeBps = opt.feeQuote?.available ? opt.feeQuote.bps : 0
      } catch {
        opt.feeQuote = null
        opt.feeBlocked = true
      }
    }
    kept.push(opt)
  }
  // Replace in place so removed validators drop from the returned list.
  options.length = 0
  options.push(...kept)
  return options
}

/** Build the immediate (config-only) option list for one staking network. */
export function buildBaseOptions(chainId, config) {
  const options = []
  for (const liquid of config.liquid || []) {
    options.push({
      id: `liquid:${liquid.kind}`,
      chainId,
      model: 'liquid',
      providerKind: liquid.kind,
      asset: liquid.asset,
      provider: liquid.provider,
      lstSymbol: liquid.lstSymbol,
      instantExit: Boolean(liquid.unbonding?.instantExit),
      contracts: liquid.contracts,
      referral: liquid.referral,
      unbondingLabel: liquid.unbonding?.kind === 'queue' ? null : '~2–4 days',
      rewardRateApr: null,
      totalStaked: { raw: null, usd: null },
      commissionPct: null,
      validatorName: null,
    })
  }
  const del = config.delegated
  if (del) {
    for (const v of del.validators || []) {
      options.push({
        id: `delegated:${v.validatorId}`,
        chainId,
        model: 'delegated',
        providerKind: 'validator-share',
        asset: del.asset,
        provider: del.provider,
        validatorId: v.validatorId,
        validatorName: v.name,
        validatorShare: v.validatorShare,
        stakeManager: del.stakeManager,
        lstSymbol: null,
        instantExit: false,
        unbondingLabel: null,
        rewardRateApr: null,
        totalStaked: { raw: null, usd: null },
        commissionPct: null,
      })
    }
  }
  return options
}

export function useStakingOptions() {
  const stakingChainIds = useMemo(() => getStakingNetworks().map((net) => net.chainId), [])

  const [options, setOptions] = useState([])
  const [status, setStatus] = useState('loading')
  const reqIdRef = useRef(0)

  const load = useCallback(async () => {
    if (stakingChainIds.length === 0) {
      setOptions([])
      setStatus('unavailable')
      return
    }
    const reqId = ++reqIdRef.current
    setStatus('loading')
    try {
      const all = []
      for (const chainId of stakingChainIds) {
        const config = NETWORKS[chainId].staking
        const base = buildBaseOptions(chainId, config)
        // Availability gate only — reads themselves go through the chain seam.
        const provider = getPublicClient(chainId)

        // Best-effort enrichment — every call degrades to null on failure.
        const lidoApr = await fetchLidoApr(config.liquid?.find((l) => l.kind === 'lido')?.aprApi)
        const spol = config.liquid?.find((l) => l.kind === 'spol')
        let spolTvl = null
        let spolFeeBps = null
        if (spol && provider) {
          spolTvl = await readSpolTvl({ chainId, contracts: spol.contracts })
          spolFeeBps = await readSpolRewardFee({ chainId, contracts: spol.contracts })
        }
        let decoration = new Map()
        let unbondLabel = null
        if (config.delegated && provider) {
          decoration = await fetchValidatorDecoration(
            config.delegated.stakingApi,
            (config.delegated.validators || []).map((v) => v.validatorId),
          )
          try {
            const timing = await readStakeManagerTiming({ stakeManager: config.delegated.stakeManager, chainId })
            unbondLabel = unbondingLabel(timing.withdrawalDelay)
          } catch {
            unbondLabel = null
          }
        }

        for (const opt of base) {
          if (opt.providerKind === 'lido') opt.rewardRateApr = lidoApr
          if (opt.providerKind === 'spol') {
            opt.totalStaked = { raw: spolTvl, usd: null }
            opt.rewardFeeBps = spolFeeBps
            opt.unbondingLabel = unbondLabel || opt.unbondingLabel
          }
          if (opt.providerKind === 'validator-share') {
            const d = decoration.get(opt.validatorId)
            if (d) {
              opt.commissionPct = d.commissionPct
              opt.totalStaked = { raw: d.totalStakedRaw, usd: null }
              opt.status = d.status
              opt.delegationEnabled = d.delegationEnabled
            }
            opt.unbondingLabel = unbondLabel || '~2–4 days'
          }
        }

        // spec 066: overlay the on-chain StakingRouter (addresses, allowlist, paused, LIQUID fee).
        // No-op when the router is undeployed/unreadable — options keep the spec-065 defaults.
        await overlayRouterConfig(base, { chainId, provider })
        all.push(...base)
      }
      if (reqId !== reqIdRef.current) return
      setOptions(all)
      setStatus('ready')
    } catch {
      if (reqId !== reqIdRef.current) return
      setOptions([])
      setStatus('unavailable')
    }
  }, [stakingChainIds])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return useMemo(() => ({ options, status, refresh: load }), [options, status, load])
}

export { POL_TOKEN_L1, readLidoPosition }
export default useStakingOptions
