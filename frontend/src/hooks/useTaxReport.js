/**
 * useTaxReport — state machine for generating, downloading, and listing the
 * user's wager tax/activity reports (spec 016-wager-tax-report;
 * contracts/reports-ui.md). States: idle → generating(progress) → ready | error.
 *
 * Scoped to the connected account + active chain (wagmi). All chain/render I/O
 * is injectable so the hook is unit-testable without a provider or wallet.
 */

import { useCallback, useState, useMemo } from 'react'
import { useAccount } from 'wagmi'
import { useWalletChainId } from './useWalletChainId'
import { getNetwork } from '../config/networks'
import { getContractAddressForChain } from '../config/contracts'
import { resolvePeriod, resolveCustomPeriod, validateRange } from '../utils/reportPeriods'
import { buildReport as defaultBuildReport } from '../data/reports/reportBuilder'
import { createReportDataSource } from '../data/reports/reportDataSource'
import { getDefaultLedgerRepository } from '../data/ledger'
import * as pdfReport from '../data/reports/pdfReport'
import * as csvReport from '../data/reports/csvReport'
import * as historyStore from '../data/reports/reportHistoryStore'

export const REPORT_STATUS = Object.freeze({
  IDLE: 'idle',
  GENERATING: 'generating',
  READY: 'ready',
  ERROR: 'error',
})

export function useTaxReport(options = {}) {
  const wagmiAccount = useAccount()
  const wagmiChainId = useWalletChainId()
  // An explicit `account`/`chainId` option is authoritative (including a null
  // account for the disconnected state); otherwise fall back to wagmi.
  const account = 'account' in options ? options.account : (wagmiAccount?.address ?? null)
  const chainId = 'chainId' in options ? options.chainId : wagmiChainId

  // Injectable collaborators (defaults wire to the real app). Memoized so the
  // useCallback hooks below keep stable identities across renders.
  const buildReportFn = useMemo(() => options.buildReport || defaultBuildReport, [options.buildReport])
  const makeDataSource = useMemo(() => options.createDataSource || createReportDataSource, [options.createDataSource])
  // Spec 051: the report reads the SAME activity ledger the Account tab
  // renders, so line items and totals can never disagree (FR-014/FR-015).
  // Injectable for tests; `ledger: null` forces the legacy wager-only path.
  const hasLedgerOption = 'ledger' in options
  const ledgerOption = options.ledger
  const ledger = useMemo(
    () => (hasLedgerOption ? ledgerOption : getDefaultLedgerRepository()),
    [hasLedgerOption, ledgerOption],
  )
  const networkOf = useMemo(() => options.getNetwork || getNetwork, [options.getNetwork])
  const escrowOf = useMemo(
    () =>
      options.getEscrow ||
      ((cid) =>
        getContractAddressForChain('wagerRegistry', cid) ||
        getContractAddressForChain('friendGroupMarketFactory', cid)),
    [options.getEscrow],
  )
  const history = useMemo(() => options.history || historyStore, [options.history])
  const saveAs = useMemo(
    () => options.saveAs || ((blobOrText, name) => triggerDownload(blobOrText, name)),
    [options.saveAs],
  )
  const now = useMemo(() => options.now || (() => Date.now()), [options.now])

  const [status, setStatus] = useState(REPORT_STATUS.IDLE)
  const [progress, setProgress] = useState({ fraction: 0, label: '' })
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  const [refreshTick, setRefreshTick] = useState(0)

  // Read history during render (a pure localStorage read) rather than syncing
  // it into state from an effect; bumping `refreshTick` re-reads after a
  // generate/remove. Re-derives whenever account/chainId change.
  const entries = useMemo(() => {
    void refreshTick // cache-bust signal: re-read after generate/remove
    return history.list(account, chainId)
  }, [history, account, chainId, refreshTick])
  const refreshHistory = useCallback(() => setRefreshTick((t) => t + 1), [])

  const generate = useCallback(
    async ({ kind, from, to }) => {
      setError(null)
      const nowMs = now()
      let period
      try {
        period = resolvePeriod({ kind, from, to, nowMs })
      } catch (e) {
        setStatus(REPORT_STATUS.ERROR)
        setError(e.message || 'Invalid period.')
        return null
      }
      const check = validateRange(period, nowMs)
      if (!check.valid) {
        setStatus(REPORT_STATUS.ERROR)
        setError(check.error)
        return null
      }
      if (!account) {
        setStatus(REPORT_STATUS.ERROR)
        setError('Connect a wallet to generate a report.')
        return null
      }

      setStatus(REPORT_STATUS.GENERATING)
      setProgress({ fraction: 0, label: 'Starting…' })
      try {
        const networkMeta = { ...networkOf(Number(chainId)), wagerRegistry: escrowOf(chainId) }
        const built = await buildReportFn({
          account,
          chainId,
          period,
          dataSource: makeDataSource({ chainId }),
          networkMeta,
          ledger,
          generatedAt: nowMs,
          onProgress: (fraction, label) => setProgress({ fraction, label }),
        })
        setReport(built)
        setStatus(REPORT_STATUS.READY)
        // Persist metadata so the report can be re-listed/re-downloaded (FR-010).
        history.add(account, chainId, {
          periodKind: period.kind,
          from: new Date(period.from).toISOString(),
          to: new Date(period.to).toISOString(),
          label: period.label,
        })
        refreshHistory()
        return built
      } catch (e) {
        setStatus(REPORT_STATUS.ERROR)
        setError(e?.message || 'Failed to generate the report.')
        return null
      }
    },
    [account, chainId, buildReportFn, makeDataSource, ledger, networkOf, escrowOf, history, refreshHistory, now],
  )

  // `statementOptions` chooses the statement type and sections (issue #1026).
  // They are a RENDER-time choice, not a build-time one: the same generated
  // report can be printed as a full account statement or a wagering statement
  // without going back to the chain.
  const downloadPdf = useCallback(
    (r = report, statementOptions = {}) => {
      if (!r) return
      saveAs(pdfReport.render(r, statementOptions), pdfReport.fileName(r, statementOptions))
    },
    [report, saveAs],
  )

  const downloadCsv = useCallback(
    (r = report) => {
      if (!r) return
      saveAs(new Blob([csvReport.render(r)], { type: 'text/csv;charset=utf-8' }), csvReport.fileName(r))
    },
    [report, saveAs],
  )

  const removeEntry = useCallback(
    (id) => {
      history.remove(account, chainId, id)
      refreshHistory()
    },
    [account, chainId, history, refreshHistory],
  )

  // Regenerate a stored report on demand from immutable chain data and download
  // it, without adding a new history entry (FR-010 — re-download).
  const redownload = useCallback(
    async (entry, format = 'pdf', statementOptions = {}) => {
      if (!entry || !account) return
      const period = {
        ...resolveCustomPeriod(Date.parse(entry.from), Date.parse(entry.to)),
        kind: entry.periodKind || 'custom',
        label: entry.label || '',
      }
      const networkMeta = { ...networkOf(Number(chainId)), wagerRegistry: escrowOf(chainId) }
      const built = await buildReportFn({
        account,
        chainId,
        period,
        dataSource: makeDataSource({ chainId }),
        networkMeta,
        ledger,
        generatedAt: now(),
      })
      if (format === 'csv') {
        saveAs(new Blob([csvReport.render(built)], { type: 'text/csv;charset=utf-8' }), csvReport.fileName(built))
      } else {
        saveAs(pdfReport.render(built, statementOptions), pdfReport.fileName(built, statementOptions))
      }
      return built
    },
    [account, chainId, buildReportFn, makeDataSource, ledger, networkOf, escrowOf, saveAs, now],
  )

  return {
    account,
    chainId,
    status,
    progress,
    report,
    error,
    entries,
    isEmpty: status === REPORT_STATUS.READY && report?.lineItems?.length === 0,
    generate,
    downloadPdf,
    downloadCsv,
    removeEntry,
    redownload,
    refreshHistory,
  }
}

/** Default browser download (file-saver loaded lazily to keep the hook light). */
async function triggerDownload(blobOrText, name) {
  const { saveAs } = await import('file-saver')
  saveAs(blobOrText, name)
}
