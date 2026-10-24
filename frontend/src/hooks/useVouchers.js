import { useCallback, useState } from 'react'
import { encodeFunctionData, decodeEventLog, parseAbiItem, zeroHash } from 'viem'
import { readContract, normalizeAbi } from '../lib/chains/readContract'
import { eventScanHandle } from '../lib/chains/eventScan'
import { isAddress, getAddress } from '../lib/evm/address'
import { useWallet } from './useWalletManagement'
import { getContractAddressForChain, getDeploymentBlockForChain } from '../config/contracts'
import { MEMBERSHIP_VOUCHER_ABI } from '../abis/MembershipVoucher'
import { MEMBERSHIP_MANAGER_ABI } from '../abis/MembershipManager'
import { VOUCHER_BATCH_MINTER_ABI } from '../abis/VoucherBatchMinter'
import { ERC20_ABI } from '../abis/ERC20'
import { useGaslessWrite } from '../lib/relay/useGaslessWrite'

/**
 * Normalize a Terms hash into the 0x-prefixed bytes32 hex the contract expects. The source of
 * truth (`frontend/src/utils/legalDocs.js#getCurrentDocument('terms').hash` — the same one the
 * purchase rail reads, see `PremiumPurchaseModal.jsx`) returns a bare 64-char lowercase hex
 * digest with no `0x` prefix; `MembershipManager.redeemVoucher`/`redeemVoucherWithSig` take
 * `bytes32`. Falls back to the zero hash (the contract's `_recordTerms` no-ops on it) when no
 * in-force hash was resolved, matching `blockchainService.js`'s normalization for purchases.
 * Exported for tests (spec 026 FR-013/SC-005).
 */
export function normalizeTermsHash(termsHash) {
  if (typeof termsHash !== 'string' || !termsHash) return zeroHash
  return termsHash.startsWith('0x') ? termsHash : `0x${termsHash}`
}

/**
 * useVouchers — buy and redeem membership voucher NFTs (spec 026).
 *
 * Two acquisition rails converge on the same soulbound membership: this hook drives the *voucher* rail.
 * - mintVouchers: buy a quantity of vouchers and (optionally) gift them to another address in a single
 *   approval + single transaction via the VoucherBatchMinter helper. Falls back to a direct single self-mint
 *   on the (immutable) voucher when the helper isn't deployed and the order is just one voucher for yourself.
 * - listMyVouchers: enumerate the connected wallet's currently-held vouchers via a bounded on-chain Transfer
 *   scan (the voucher isn't ERC721Enumerable and the subgraph isn't live yet).
 * - redeemVoucher: burn a voucher you own to mint a soulbound membership to the CONNECTED wallet. Redeeming
 *   from a fresh wallet (one that received the voucher by transfer) decouples it from the buying wallet —
 *   pseudonymity, not cryptographic unlinkability (mints/transfers/burns are public on-chain).
 *
 * Addresses/ABIs come only from synced config (Principle V). When the voucher isn't deployed on the active
 * network, {voucherAvailable} is false and the UI surfaces that honestly rather than implying it works.
 */
const MANAGER_ABI_PARSED = normalizeAbi(MEMBERSHIP_MANAGER_ABI)
const VOUCHER_ABI_PARSED = normalizeAbi(MEMBERSHIP_VOUCHER_ABI)
const MINTER_ABI_PARSED = normalizeAbi(VOUCHER_BATCH_MINTER_ABI)
const ERC20_ABI_PARSED = normalizeAbi(ERC20_ABI)

const managerCall = (functionName, args) =>
  encodeFunctionData({ abi: MANAGER_ABI_PARSED, functionName, args })
const voucherCall = (functionName, args) =>
  encodeFunctionData({ abi: VOUCHER_ABI_PARSED, functionName, args })
const minterCall = (functionName, args) =>
  encodeFunctionData({ abi: MINTER_ABI_PARSED, functionName, args })
const erc20Call = (functionName, args) =>
  encodeFunctionData({ abi: ERC20_ABI_PARSED, functionName, args })

/**
 * The 3-argument `safeTransferFrom`, as a ONE-ENTRY ABI (spec 110 divergence 21).
 *
 * ethers let you name an overload by its full signature — `encodeFunctionData(
 * 'safeTransferFrom(address,address,uint256)', …)` — and that is exactly why the string is written
 * out here: ERC-721 overloads it, and the 4-argument form takes a trailing `bytes`. viem REFUSES a
 * signature as `functionName` (`AbiFunctionNotFoundError`); given the bare name it picks an
 * overload by matching the ARGUMENTS it was handed. That happens to land on the same selector for
 * this call, but it makes the choice a consequence of the argument list rather than something the
 * author stated — so the ABI is narrowed to the one entry instead, and the intent survives.
 */
const SAFE_TRANSFER_FROM_3 = parseAbiItem(
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
)

export function useVouchers() {
  const { account, signer, chainId, sendCalls, loginMethod } = useWallet()
  // Passkey smart-account sessions have no ethers signer (spec 041): their writes go through
  // WalletContext.sendCalls (one sponsored ERC-4337 UserOp, approve+action batched), exactly like
  // the transfer/earn/pool surfaces. Reads go through the spec-110 chain seam, named by chainId,
  // for every session kind. Classic wallets keep the signer path for writes.
  const isPasskey = loginMethod === 'passkey'
  const [status, setStatus] = useState('idle') // idle | minting | redeeming | transferring | listing | success | error
  const [error, setError] = useState(null)
  const [lastTxHash, setLastTxHash] = useState(null)

  const voucherAddress = getContractAddressForChain('membershipVoucher', chainId)
  const managerAddress = getContractAddressForChain('membershipManager', chainId)
  const batchMinterAddress = getContractAddressForChain('voucherBatchMinter', chainId)
  const paymentTokenAddress = getContractAddressForChain('paymentToken', chainId)
  const voucherAvailable = Boolean(voucherAddress && managerAddress)
  // Buying >1 or gifting to another address needs the batch helper; a single self-purchase does not.
  const batchMintAvailable = Boolean(voucherAvailable && batchMinterAddress)

  const reset = useCallback(() => {
    setStatus('idle')
    setError(null)
    setLastTxHash(null)
  }, [])

  /**
   * The two reads every purchase path makes, on the chain the purchase will settle on.
   *
   * Spec 110: these went through `new Contract(addr, ABI, provider|signer)` — i.e. through the
   * WALLET's provider for a classic session — which meant a member's own endpoint (spec 069) did
   * not apply to them, and an unsupported wallet chain read the HOME network's state instead of
   * failing. Both are read through the one seam now, named chain first.
   */
  const readTierConfig = useCallback(
    (roleHash, tierId) =>
      readContract(chainId, {
        address: managerAddress,
        abi: MEMBERSHIP_MANAGER_ABI,
        functionName: 'getTierConfig',
        args: [roleHash, tierId],
      }),
    [chainId, managerAddress],
  )

  const readAllowance = useCallback(
    async (spender) =>
      BigInt(
        await readContract(chainId, {
          address: paymentTokenAddress,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [getAddress(String(account)), getAddress(String(spender))],
        }),
      ),
    [chainId, paymentTokenAddress, account],
  )

  // Gasless seam (specs 035 + 036): relay the redeem when a relayer is live, else self-submit the
  // MembershipManager.redeemVoucher call (never-stranded). Signer-attributed (no payment) — the
  // redeemer is the connected wallet, auto-filled by signIntent, so it's omitted from params.
  const voucherTx = useGaslessWrite('redeemVoucher', {
    params: (tokenId, termsHash) => ({ voucherId: tokenId, acceptedTermsHash: normalizeTermsHash(termsHash) }),
    selfSubmit: async (tokenId, termsHash) => {
      const tx = await signer.sendTransaction({
        to: managerAddress,
        data: managerCall('redeemVoucher', [BigInt(tokenId), normalizeTermsHash(termsHash)]),
      })
      setLastTxHash(tx.hash)
      return tx.wait()
    },
  })

  /**
   * Buy `quantity` vouchers of `(roleHash, tierId)` and send them to `recipient` (defaults to the buyer).
   * Uses the VoucherBatchMinter (one approval + one tx) for any quantity > 1 or any gift; uses a direct
   * single mint on the voucher when buying exactly one for yourself (works even before the helper deploys).
   */
  const mintVouchers = useCallback(
    async (roleHash, tierId, quantity = 1, recipient = '') => {
      if (!isPasskey && !signer) throw new Error('Connect a wallet to buy a voucher.')
      if (!voucherAvailable) throw new Error('Membership vouchers are not available on this network yet.')

      const qty = Math.max(1, Math.floor(Number(quantity) || 1))
      const to = recipient && recipient.trim() ? recipient.trim() : account
      if (!isAddress(to)) throw new Error('Enter a valid recipient address.')
      const isGift = to.toLowerCase() !== account.toLowerCase()
      const needsHelper = qty > 1 || isGift

      setStatus('minting')
      setError(null)
      setLastTxHash(null)
      try {
        if (isPasskey) {
          // Passkey rail: batch approve (only if the allowance is short) + the mint into ONE
          // sponsored UserOp. Reads go through the chain seam; encoding needs no signer.
          if (needsHelper && !batchMintAvailable) {
            throw new Error('Buying multiple vouchers or gifting isn’t available on this network yet.')
          }
          const cfg = await readTierConfig(roleHash, tierId)
          if (!cfg.active) throw new Error('That tier is not available for purchase.')
          const price = BigInt(cfg.priceUSDC)
          const spender = needsHelper ? batchMinterAddress : voucherAddress
          const amount = needsHelper ? price * BigInt(qty) : price
          const allowance = await readAllowance(spender)
          const calls = []
          if (allowance < amount) {
            calls.push({ target: paymentTokenAddress, data: erc20Call('approve', [getAddress(String(spender)), amount]), value: 0n })
          }
          if (needsHelper) {
            calls.push({ target: batchMinterAddress, data: minterCall('mintBatch', [roleHash, tierId, qty, getAddress(String(to))]), value: 0n })
          } else {
            calls.push({ target: voucherAddress, data: voucherCall('mint', [roleHash, tierId]), value: 0n })
          }
          const res = await sendCalls(calls)
          const txHash = res?.txHash ?? res?.userOpHash ?? null
          setLastTxHash(txHash)
          setStatus('success')
          // tokenId isn't parsed from a UserOp receipt; the holdings refresh reads it back on-chain.
          return { count: qty, recipient: to, gift: isGift, tokenId: needsHelper ? undefined : null, txHash }
        }

        const cfg = await readTierConfig(roleHash, tierId)
        if (!cfg.active) throw new Error('That tier is not available for purchase.')
        const price = BigInt(cfg.priceUSDC)

        if (needsHelper) {
          if (!batchMintAvailable) {
            throw new Error('Buying multiple vouchers or gifting isn’t available on this network yet.')
          }
          const total = price * BigInt(qty)
          // Approve the batch helper (not the voucher) for the full amount, only if needed.
          const allowance = await readAllowance(batchMinterAddress)
          if (allowance < total) {
            const approveTx = await signer.sendTransaction({
              to: paymentTokenAddress,
              data: erc20Call('approve', [getAddress(String(batchMinterAddress)), total]),
            })
            await approveTx.wait()
          }
          const tx = await signer.sendTransaction({
            to: batchMinterAddress,
            data: minterCall('mintBatch', [roleHash, tierId, qty, getAddress(String(to))]),
          })
          setLastTxHash(tx.hash)
          await tx.wait()
          setStatus('success')
          return { count: qty, recipient: to, gift: isGift, txHash: tx.hash }
        }

        // Single voucher for yourself: mint directly on the voucher (approve it for the price).
        const allowance = await readAllowance(voucherAddress)
        if (allowance < price) {
          const approveTx = await signer.sendTransaction({
            to: paymentTokenAddress,
            data: erc20Call('approve', [getAddress(String(voucherAddress)), price]),
          })
          await approveTx.wait()
        }
        const tx = await signer.sendTransaction({
          to: voucherAddress,
          data: voucherCall('mint', [roleHash, tierId]),
        })
        setLastTxHash(tx.hash)
        const receipt = await tx.wait()
        let tokenId = null
        for (const log of receipt.logs || []) {
          try {
            const parsed = decodeEventLog({
              abi: VOUCHER_ABI_PARSED,
              topics: log.topics,
              data: log.data,
            })
            if (parsed && parsed.eventName === 'VoucherMinted') {
              tokenId = parsed.args.id.toString()
              break
            }
          } catch {
            /* not a voucher log */
          }
        }
        setStatus('success')
        return { count: 1, recipient: account, gift: false, tokenId, txHash: tx.hash }
      } catch (e) {
        setStatus('error')
        setError(e?.shortMessage || e?.message || 'Purchase failed.')
        throw e
      }
    },
    [isPasskey, sendCalls, signer, account, voucherAvailable, batchMintAvailable,
     voucherAddress, batchMinterAddress, paymentTokenAddress, readTierConfig, readAllowance]
  )

  /**
   * Transfer a voucher you hold to another address (e.g. a fresh wallet, or the person you're gifting
   * it to). Uses ERC-721 `safeTransferFrom` so the destination is checked for receiver support. The
   * recipient can then redeem it into their own soulbound membership.
   */
  const transferVoucher = useCallback(
    async (tokenId, to) => {
      if (!isPasskey && !signer) throw new Error('Connect a wallet to transfer a voucher.')
      if (!voucherAvailable) throw new Error('Membership vouchers are not available on this network yet.')
      const dest = (to || '').trim()
      if (!isAddress(dest)) throw new Error('Enter a valid recipient address.')
      if (account && dest.toLowerCase() === account.toLowerCase()) {
        throw new Error('That voucher is already in this wallet.')
      }
      setStatus('transferring')
      setError(null)
      setLastTxHash(null)
      try {
        // The voucher overloads safeTransferFrom; the 3-arg (no data) form is named by the
        // one-entry ABI above, not by an argument count viem would infer.
        const data = encodeFunctionData({
          abi: [SAFE_TRANSFER_FROM_3],
          functionName: 'safeTransferFrom',
          args: [getAddress(String(account)), getAddress(String(dest)), BigInt(tokenId)],
        })
        if (isPasskey) {
          const res = await sendCalls([{ target: voucherAddress, data, value: 0n }])
          const txHash = res?.txHash ?? res?.userOpHash ?? null
          setLastTxHash(txHash)
          setStatus('success')
          return { tokenId, to: dest, txHash }
        }
        const tx = await signer.sendTransaction({ to: voucherAddress, data })
        setLastTxHash(tx.hash)
        await tx.wait()
        setStatus('success')
        return { tokenId, to: dest, txHash: tx.hash }
      } catch (e) {
        setStatus('error')
        setError(e?.shortMessage || e?.message || 'Transfer failed.')
        throw e
      }
    },
    [isPasskey, sendCalls, signer, account, voucherAvailable, voucherAddress]
  )

  /**
   * Redeem voucher `tokenId` into a soulbound membership for the connected wallet. `termsHash` is
   * the caller-resolved in-force Terms version hash (spec 026 FR-013/SC-005 — see
   * `VouchersPage.jsx#onRedeem`, sourced the same way the purchase rail is:
   * `getCurrentDocument('terms').hash`); it's normalized to 0x-bytes32 (or the zero hash, a
   * contract-side no-op) here so every rail records the same accepted-terms artifact the purchase
   * rail does.
   */
  const redeemVoucher = useCallback(
    async (tokenId, termsHash) => {
      if (!isPasskey && !signer) throw new Error('Connect a wallet to redeem.')
      if (!voucherAvailable) throw new Error('Membership vouchers are not available on this network yet.')
      setStatus('redeeming')
      setError(null)
      setLastTxHash(null)
      try {
        if (isPasskey) {
          // Passkey rail: redeemVoucher as one sponsored UserOp (the 035 relay/intent path is
          // signer-only). The redeemer is the smart account — the connected passkey session.
          const data = managerCall('redeemVoucher', [BigInt(tokenId), normalizeTermsHash(termsHash)])
          const res = await sendCalls([{ target: managerAddress, data, value: 0n }])
          const txHash = res?.txHash ?? res?.userOpHash ?? null
          setLastTxHash(txHash)
          setStatus('success')
          return { txHash }
        }
        const result = await voucherTx.run(tokenId, termsHash)
        if (result?.error) throw result.error
        setLastTxHash(result.txHash || lastTxHash)
        setStatus('success')
        return { txHash: result.txHash || lastTxHash }
      } catch (e) {
        setStatus('error')
        setError(e?.shortMessage || e?.message || 'Redemption failed.')
        throw e
      }
    },
    [isPasskey, sendCalls, managerAddress, signer, voucherAvailable, voucherTx, lastTxHash]
  )

  /**
   * List the vouchers currently held by the connected wallet. The voucher isn't ERC721Enumerable, so derive
   * holdings from a bounded Transfer-log scan (incoming to the wallet, from the recorded deploy block), then
   * confirm each is still owned (filters out ones transferred away, burned, or already redeemed) and read its
   * tier/duration. Read-only; never throws into the UI (returns [] on failure).
   */
  const listMyVouchers = useCallback(async () => {
    if (!voucherAvailable || !account) return []
    setStatus('listing')
    setError(null)
    try {
      const fromBlock = getDeploymentBlockForChain('membershipVoucher', chainId)
      const handle = eventScanHandle(chainId, { address: voucherAddress, abi: MEMBERSHIP_VOUCHER_ABI })
      if (!handle) throw new Error('No read connection for this network.')
      // ONE `eth_getLogs`, which is what `queryFilter(filter, fromBlock)` was — not `getLogsRange`,
      // whose bisect would turn a single refusal over a from-deploy-block range into a storm.
      const topics = handle.filters.Transfer(null, getAddress(String(account))).getTopicFilter()
      const toBlock = Number(await handle.provider.getBlockNumber())
      const incoming = await handle.provider.getLogs({
        address: voucherAddress,
        topics,
        fromBlock: Number(fromBlock) || 0,
        toBlock,
      })
      const ids = [
        ...new Set(
          incoming
            .map((log) => {
              try {
                return handle.interface.parseLog(log).args.tokenId.toString()
              } catch {
                return null
              }
            })
            .filter(Boolean),
        ),
      ]
      const askVoucher = (functionName, args) =>
        readContract(chainId, { address: voucherAddress, abi: MEMBERSHIP_VOUCHER_ABI, functionName, args })
      const held = []
      for (const id of ids) {
        try {
          const owner = await askVoucher('ownerOf', [BigInt(id)])
          if (String(owner).toLowerCase() !== account.toLowerCase()) continue
          const info = await askVoucher('voucherInfo', [BigInt(id)])
          held.push({
            tokenId: id,
            // uint8/uint32 decode as NUMBERS under viem where ethers gave bigints (divergence b);
            // `Number` covers both, and the shape this returns is unchanged either way.
            tier: Number(info.tier),
            durationDays: Number(info.durationDays),
            role: info.role,
          })
        } catch {
          /* burned / redeemed / nonexistent — not currently held */
        }
      }
      held.sort((a, b) => Number(a.tokenId) - Number(b.tokenId))
      setStatus('idle')
      return held
    } catch (e) {
      setStatus('error')
      setError(e?.shortMessage || e?.message || 'Could not load your vouchers.')
      return []
    }
  }, [voucherAvailable, account, voucherAddress, chainId])

  return {
    status,
    error,
    lastTxHash,
    voucherAvailable,
    batchMintAvailable,
    voucherAddress,
    mintVouchers,
    redeemVoucher,
    transferVoucher,
    listMyVouchers,
    reset,
  }
}
