/**
 * useDataBackup (spec 032) — orchestrates the explicit, member-initiated encrypted backup & restore.
 *
 * Backup:  build the unified network-tagged bundle → derive the wallet key → encrypt → pin to IPFS → record
 *          the pointer on the canonical network (one tx). Success is shown ONLY after the pin AND the pointer
 *          tx both confirm. Local data is only read during backup, never written — a failure leaves it intact.
 * Restore: read the pointer (free) → fetch by CID → decrypt → validate → merge/replace into local data. A
 *          missing pointer = "nothing to restore"; a corrupt/undecryptable backup = "no usable backup" — both
 *          leave local data untouched.
 *
 * No backend: encryption is client-side, storage is IPFS, the locator is on-chain. Strictly per-wallet.
 */
import { useCallback, useEffect, useState } from 'react'
import { useWallet } from './useWalletManagement'
import { useNotification } from './useUI'
import { getNetwork } from '../config/networks'
import { uploadJson, fetchByCid } from '../utils/ipfsService'
import { getUserPreference, saveUserPreference, removeUserPreference } from '../utils/userStorage'
import { deriveKey, deriveKeyFromSeed, encryptBundle, decryptBundle } from '../lib/backup/backupCrypto'
import { buildBundle, parseBundle, applyBundle } from '../lib/backup/backupBundle'
import { readPointer, writePointer, buildSetPointerCall, isBackupAvailable, CANONICAL_CHAIN_ID } from '../lib/backup/backupRegistry'
import { resolveMasterSeed } from '../lib/passkey/encryption'
import { readSession } from '../connectors/passkey'

const SIZE_WARN_BYTES = 1024 * 1024 // ~1 MB soft cap (FR-021)
const LAST_BACKUP_KEY = 'data_backup_last_at'

// Honest passkey-UserOp lifecycle states as returned by sendCalls (mirrors LIFECYCLE in
// lib/passkey/submission.js — kept as literals here to avoid pulling the relay graph into this hook).
const OP_STATE = Object.freeze({ INCLUDED: 'included', FAILED: 'failed' })

// Session-only key cache (in-memory; cleared on reload or account change) so a backup+restore in one session
// doesn't double-prompt for the signature/ceremony. Never persisted to disk.
let keyCache = { account: null, key: null }
function cachedKey(account) {
  const a = account ? String(account).toLowerCase() : null
  return keyCache.account === a ? keyCache.key : null
}

// Derive (and cache) the backup key for the active session, login-method agnostic:
//  - classic wallet: one signature over the fixed domain message (deriveKey);
//  - passkey account: one WebAuthn PRF ceremony → the account's master seed → deriveKeyFromSeed.
// Both are deterministic per account, so a backup made under either controller restores under any controller
// that holds the same account's key material.
async function keyFor({ signer, account, loginMethod }) {
  const a = account ? String(account).toLowerCase() : null
  const hit = cachedKey(a)
  if (hit) return hit
  let key
  if (loginMethod === 'passkey') {
    const credentialId = readSession()?.credentialId
    const seed = await resolveMasterSeed({ account, credentialId })
    key = deriveKeyFromSeed(seed)
  } else {
    key = await deriveKey(signer) // wallet signature prompt
  }
  keyCache = { account: a, key }
  return key
}

export function useDataBackup() {
  const { account, signer, chainId, isConnected, switchNetwork, loginMethod, sendCalls } = useWallet()
  const { showNotification } = useNotification()

  // A passkey account signs through sendCalls / a PRF ceremony, not an ethers signer — so "can we write?"
  // is "is an account connected with a usable signing path", never "is there a signer object".
  const isPasskey = loginMethod === 'passkey'
  const canSign = Boolean(account) && (Boolean(signer) || isPasskey)

  /*
   * Persist the pointer on the canonical network, using the session's signing path — and RESOLVE
   * ONLY WHEN THE WRITE HAS SETTLED, because both callers treat "returned" as "recorded".
   *
   * The signer path already does: `writePointer` awaits the receipt. The passkey path did not.
   * `sendCalls` resolves to an honest terminal state — included | failed | stalled — and NEVER
   * throws on a stalled or reverted UserOp (submission.js#trackToInclusion returns those). An
   * unchecked `await` therefore let `backup()` say "Your data is backed up" and set remoteState
   * 'yes' for a pointer that is not on chain, and let `remove()` say the backup was removed while
   * it is still pointed at. Both are claims about chain state that nothing established, and a
   * member acts on them: the first stops backing up, the second stops trying to remove.
   *
   * A result carrying no `state` is left alone — that is a non-passkey rail, not a stalled op.
   */
  const persistPointer = useCallback(async (cid) => {
    if (isPasskey) {
      const res = await sendCalls([buildSetPointerCall(cid)])
      if (res?.state === OP_STATE.FAILED) {
        throw new Error(res.reason || 'Recording your backup pointer reverted on chain — nothing was recorded.')
      }
      if (res?.state && res.state !== OP_STATE.INCLUDED) {
        throw new Error('Your backup pointer was submitted but has not confirmed on chain yet — check back shortly before trying again.')
      }
    } else {
      await writePointer(signer, cid)
    }
  }, [isPasskey, sendCalls, signer])

  const [status, setStatus] = useState('idle') // 'idle' | 'backing-up' | 'restoring' | 'error'
  const [lastBackupAt, setLastBackupAt] = useState(null)
  /*
   * THREE states, never two (constitution III / the estate rule).
   *
   * `readPointer` deliberately separates "" (genuinely no pointer) from `null` (the read could not
   * be completed), and the restore path below already honours that distinction. This status did
   * not: `!!null` is `false`, so an unreachable canonical RPC rendered as "None found" — a
   * definite claim about the member's backup that nothing established. That is worse here than on
   * most surfaces, because the two remedies diverge: told they have no backup, a member pays gas
   * to make one they may already have, or concludes there is nothing to restore.
   *
   * 'yes' | 'none' | 'unknown'. `hasRemote` stays exported as the positive case only, so every
   * existing consumer keeps its meaning and none of them can accidentally read 'unknown' as 'none'.
   */
  const [remoteState, setRemoteState] = useState('unknown')

  const available = isBackupAvailable()
  const onCanonical = Number(chainId) === CANONICAL_CHAIN_ID
  const canonicalName = getNetwork(CANONICAL_CHAIN_ID)?.name || `chain ${CANONICAL_CHAIN_ID}`

  // Per-(account) status refresh: local last-backup time + whether an on-chain pointer exists. Honest reads.
  const refreshStatus = useCallback(async () => {
    if (!account) { setLastBackupAt(null); setRemoteState('unknown'); return }
    setLastBackupAt(getUserPreference(account, LAST_BACKUP_KEY, null, true))
    try {
      const cid = await readPointer(account)
      setRemoteState(cid === null ? 'unknown' : cid ? 'yes' : 'none')
    } catch {
      setRemoteState('unknown')
    }
  }, [account])

  // On account change: drop any cached key and refresh status. All setState happens inside the async IIFE
  // (after an await / in the no-account branch) so it never runs synchronously during the effect.
  useEffect(() => {
    keyCache = { account: null, key: null }
    let cancelled = false
    ;(async () => {
      if (!account) {
        if (!cancelled) { setLastBackupAt(null); setRemoteState('unknown') }
        return
      }
      let next
      try {
        const cid = await readPointer(account)
        next = cid === null ? 'unknown' : cid ? 'yes' : 'none'
      } catch {
        next = 'unknown'
      }
      if (!cancelled) {
        setLastBackupAt(getUserPreference(account, LAST_BACKUP_KEY, null, true))
        setRemoteState(next)
      }
    })()
    return () => { cancelled = true }
  }, [account])

  const requireCanonical = useCallback(() => {
    if (onCanonical) return true
    showNotification(`Backing up records a pointer on ${canonicalName} (chain ${CANONICAL_CHAIN_ID}) — switch to that network to continue.`, 'warning')
    try { switchNetwork?.(CANONICAL_CHAIN_ID) } catch { /* member can switch manually */ }
    return false
  }, [onCanonical, switchNetwork, showNotification, canonicalName])

  const backup = useCallback(async () => {
    if (!canSign) { showNotification('Connect your account to back up.', 'warning'); return false }
    if (!available) { showNotification('Backup is not available on this network yet.', 'warning'); return false }
    if (!requireCanonical()) return false
    setStatus('backing-up')
    try {
      const key = await keyFor({ signer, account, loginMethod }) // signature / PRF ceremony (cached for the session)
      const bundle = buildBundle(account, Date.now())
      const envelope = encryptBundle(key, bundle)
      const size = new TextEncoder().encode(JSON.stringify(envelope)).length
      if (size > SIZE_WARN_BYTES) {
        showNotification('Your backup is over 1 MB — it may take longer to store, but will still proceed.', 'warning')
      }
      showNotification('Storing your encrypted backup, then recording the pointer — confirm the prompts on your device…', 'info', 0)
      const { cid } = await uploadJson(envelope, { namePrefix: 'data-backup' }) // pin (await)
      await persistPointer(cid) // pointer tx (await confirm)
      const now = Date.now()
      saveUserPreference(account, LAST_BACKUP_KEY, now, true)
      setLastBackupAt(now)
      setRemoteState('yes')
      setStatus('idle')
      showNotification('Your data is backed up.', 'success')
      return true
    } catch (e) {
      setStatus('error')
      showNotification(e?.shortMessage || e?.reason || e?.message || 'Backup failed — your local data is unchanged.', 'error')
      return false // local data never written during backup
    }
  }, [canSign, signer, account, loginMethod, available, requireCanonical, persistPointer, showNotification])

  // mode: 'merge' (additive, default, non-destructive) | 'replace'
  const restore = useCallback(async (mode = 'merge') => {
    if (!canSign) { showNotification('Connect your account to restore.', 'warning'); return { restored: false, reason: 'no-wallet' } }
    if (!available) { showNotification('Backup is not available on this network yet.', 'warning'); return { restored: false, reason: 'unavailable' } }
    setStatus('restoring')
    try {
      const cid = await readPointer(account) // free, canonical read provider — works on any connected network
      if (cid === null) {
        setStatus('idle')
        showNotification("Couldn't reach the network to check for a backup — your local data is unchanged. Try again later.", 'error')
        return { restored: false, reason: 'unreachable' }
      }
      if (!cid) { setStatus('idle'); showNotification('No backup found to restore.', 'info'); return { restored: false, reason: 'none' } }
      let envelope
      try {
        envelope = await fetchByCid(cid)
      } catch {
        setStatus('idle')
        showNotification("Couldn't fetch your backup right now — your local data is unchanged. Try again later.", 'error')
        return { restored: false, reason: 'fetch-failed' }
      }
      let bundle
      try {
        const key = await keyFor({ signer, account, loginMethod })
        bundle = parseBundle(decryptBundle(key, envelope))
      } catch {
        setStatus('idle')
        showNotification('That backup could not be read (no usable backup). Your local data is unchanged.', 'error')
        return { restored: false, reason: 'unusable' }
      }
      // Apply phase: a failure HERE may have partially written, so do NOT claim "unchanged".
      let conflictsByObject
      try {
        ({ conflictsByObject } = applyBundle(account, bundle, mode))
      } catch (e) {
        setStatus('error')
        showNotification(e?.shortMessage || e?.message || 'Restore could not be completed.', 'error')
        return { restored: false, reason: 'apply-failed' }
      }
      setStatus('idle')
      showNotification(mode === 'replace' ? 'Your data was replaced from the backup.' : 'Your backup was merged into your data.', 'success')
      return { restored: true, mode, conflictsByObject }
    } catch (e) {
      setStatus('idle')
      showNotification(e?.shortMessage || e?.message || 'Restore failed — your local data is unchanged.', 'error')
      return { restored: false, reason: 'error' }
    }
  }, [canSign, signer, account, loginMethod, available, showNotification])

  const remove = useCallback(async () => {
    if (!canSign) { showNotification('Connect your account.', 'warning'); return false }
    if (!available) return false
    if (!requireCanonical()) return false
    setStatus('backing-up')
    try {
      await persistPointer('') // clear the pointer
      removeUserPreference(account, LAST_BACKUP_KEY)
      setLastBackupAt(null)
      setRemoteState('none')
      setStatus('idle')
      showNotification('Your stored backup was removed. Your local data is unchanged.', 'success')
      return true
    } catch (e) {
      setStatus('error')
      showNotification(e?.shortMessage || e?.message || 'Could not remove your backup.', 'error')
      return false
    }
  }, [canSign, account, available, requireCanonical, persistPointer, showNotification])

  return {
    available,
    isConnected,
    onCanonical,
    canonicalChainId: CANONICAL_CHAIN_ID,
    canonicalName,
    status,
    lastBackupAt,
    remoteState,
    hasRemote: remoteState === 'yes',
    refreshStatus,
    backup,
    restore,
    remove,
  }
}

export default useDataBackup
