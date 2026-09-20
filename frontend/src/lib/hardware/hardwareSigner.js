// Spec 085 — an ethers-SHAPED signer backed by a connected hardware-wallet session. This is what
// makes a saved hardware account able to ACT (operate-as, spec 062 recipe): the CustodyContext
// holds one of these in memory while the member operates as the account, exactly like the unlocked
// legacy signer — never persisted, cleared on any identity change.
//
// Every signing method routes through the device, so each call is a physical confirmation on the
// device's own screen. Nothing here can sign silently; that is the security property, not a
// limitation.
//
// ── SPEC 110 T028 — THE LAST SIGNER-SHAPED FILE OFF ethers ────────────────────────────────────
// This file is the one that BUILDS the bytes a device is asked to approve and then checks what
// came back, so a byte that changes here changes what a member signs. Four things were measured
// against real ethers before a line of it moved, and the results are written out below rather than
// summarised, because each one is a way this could have been silently wrong:
//
//   1. **Type inference.** `ethers.Transaction.from` picks the HIGHEST type its fields admit, and
//      that is not the obvious rule: a request carrying only `gasPrice` becomes type 1 (EIP-2930
//      with an empty access list), and one carrying NO fee fields at all becomes type 2 with zero
//      fees. viem infers `legacy` for the first and REFUSES the second. `transactionTypeOf` writes
//      ethers' rule out; 22/22 well-formed shapes over {type} × {gasPrice} × {1559 fees} ×
//      {accessList} serialize byte-identically, and `hardwareSigner.test.js` keeps real ethers as
//      the oracle over that matrix rather than a fixture table.
//
//   2. **DIVERGENCE 31 — viem SILENTLY DROPS a field that contradicts an explicit type, where
//      ethers refused to build the transaction at all.** `{ type: 0, maxFeePerGas: … }` serialized
//      as a legacy transaction with `gasPrice` 0 — a transaction that cannot be mined, built from
//      a request that asked for something else, with nothing raised. ethers' two refusals are
//      reproduced verbatim below. They are the 10 cases in that matrix where the two libraries
//      disagree, and every one of them is ethers refusing.
//
//   3. **DIVERGENCE 32 — viem's LEGACY serializer requires `v` as a BIGINT, and a `yParity`
//      number throws `Cannot mix BigInt and other types`** from inside the library. ethers took
//      `{ r, s, yParity }` on every type. The message names neither the field nor the transaction,
//      so this presents as an unrelated bug — and it fires only on legacy chains, which here means
//      **ETC 61 and Mordor 63** (no EIP-1559), i.e. exactly the two chains no EIP-1559 test would
//      have covered. `signatureForViem` converts once, for every type.
//
//   4. **Typed-data hashing.** `TypedDataEncoder.hashDomain` / `.from(types).hash(value)` are
//      `hashDomain` + `hashStruct` on viem, identical over five domain shapes (including `salt`
//      and the empty domain) and a nested `Person[]` table. The primary type comes from the
//      `lib/evm/typedData` seam, which is ethers' own "the type no other type references" rule.
//
// The suite that made this conversion safe is `src/test/hardware/speculosDevice.test.js`: real
// Ledger firmware, real APDUs, real screens. It passed against the ethers implementation before
// this change and must still pass after it — including case 6, which signs a LEGACY transaction
// on ETC and is the one that sees (3).

import {
  serializeTransaction,
  recoverTransactionAddress,
  hashDomain,
  hashStruct,
  getTypesForEIP712Domain,
} from 'viem'
import { getAddress } from '../evm/address'
import { primaryTypeOf } from '../evm/typedData'
import { getPublicClient } from '../chains/publicClient'
import { providerLike, waitForReceipt } from '../chains/ethersCompat'
import { HardwareWalletError, HW_ERROR_CODES } from './errors'

const toBytes = (message) => (typeof message === 'string' ? new TextEncoder().encode(message) : message)

const refuse = (message) => {
  throw new HardwareWalletError(HW_ERROR_CODES.UNKNOWN, message)
}

/** Normalize any vendor v (0/1 yParity, 27/28, or EIP-155 legacy v) to a yParity bit. */
export function yParityFrom(v) {
  const n = typeof v === 'string' ? parseInt(v, 16) : Number(v)
  if (!Number.isFinite(n)) throw new HardwareWalletError(HW_ERROR_CODES.UNKNOWN, 'Device returned an unreadable signature.')
  if (n >= 35) return (n - 35) % 2
  if (n >= 27) return n - 27
  return n & 1
}

const TYPE_NAMES = ['legacy', 'eip2930', 'eip1559']

/**
 * ethers' `Transaction.inferType()`, written out — see note 1 in the header.
 *
 * An explicit type wins, in either spelling (ethers numbered them, viem names them). Otherwise the
 * highest type the fields admit: 1559 fees → `eip1559`; a bare `gasPrice` → `eip2930` (ethers'
 * type 1 with an empty access list, NOT legacy); nothing at all → `eip1559`.
 */
export function transactionTypeOf(request) {
  const hasGasPrice = request.gasPrice != null
  const hasFee = request.maxFeePerGas != null || request.maxPriorityFeePerGas != null
  const hasAccessList = request.accessList != null

  if (request.type != null) {
    const named = typeof request.type === 'string' ? request.type : TYPE_NAMES[Number(request.type)]
    if (!TYPE_NAMES.includes(named)) {
      refuse(`This transaction asks for type ${request.type}, which this device signer cannot build, so nothing has been signed.`)
    }
    // DIVERGENCE 31 — ethers' two refusals, kept. viem drops the contradicting field instead.
    if (named === 'legacy' && hasAccessList) refuse('legacy transaction cannot have accessList')
    if (named !== 'eip1559' && hasFee) refuse('transaction type cannot have maxFeePerGas or maxPriorityFeePerGas')
    return named
  }
  if (hasFee) return 'eip1559'
  if (hasGasPrice) return 'eip2930'
  return 'eip1559'
}

const big = (v) => (v == null ? undefined : BigInt(v))

/**
 * An ethers-shaped transaction request as the viem transaction it serializes to.
 *
 * `gasLimit` and `gas` are both read, because both spellings reach here: the app's own callers
 * carry ethers' `gasLimit`, and `prepareTransactionRequest` (which populates a send) answers in
 * viem's `gas`.
 */
export function toViemTransaction(request) {
  const type = transactionTypeOf(request)
  const tx = {
    type,
    to: request.to ?? undefined,
    value: big(request.value ?? 0),
    data: request.data && request.data !== '0x' ? request.data : undefined,
    nonce: request.nonce == null ? 0 : Number(request.nonce),
    gas: big(request.gasLimit ?? request.gas ?? 0),
    chainId: Number(request.chainId),
  }
  if (type === 'eip1559') {
    tx.maxFeePerGas = big(request.maxFeePerGas ?? 0)
    tx.maxPriorityFeePerGas = big(request.maxPriorityFeePerGas ?? 0)
    if (request.accessList != null) tx.accessList = request.accessList
  } else if (type === 'eip2930') {
    tx.gasPrice = big(request.gasPrice ?? 0)
    // ethers' inferred type 1 carries an empty list; an explicit one carries the caller's.
    tx.accessList = request.accessList ?? []
  } else {
    tx.gasPrice = big(request.gasPrice ?? 0)
  }
  return tx
}

const THIRTY_TWO_BYTES = /^0x[0-9a-fA-F]{64}$/

/**
 * The device's `{r, s, v}` in the one shape viem accepts on EVERY transaction type.
 *
 * `v` is a bigint of 27/28 rather than a `yParity` bit — see DIVERGENCE 32 in the header. The
 * length check is ethers' (`Signature.from` validated r and s at 32 bytes); viem would instead
 * trim a short value into a shorter RLP item, which the recover-and-cross-check below would catch
 * as "a different account" — a true statement that names the wrong cause.
 */
function signatureForViem({ r, s, v }) {
  if (!THIRTY_TWO_BYTES.test(String(r)) || !THIRTY_TWO_BYTES.test(String(s))) {
    refuse('Device returned an unreadable signature.')
  }
  return { r, s, v: BigInt(27 + yParityFrom(v)) }
}

export class HardwareSigner {
  /**
   * @param {object} session adapter session from `connectHardware`
   * @param {{ path: string, address: string }} account
   * @param {{ chainId?: number, client?: import('viem').PublicClient }} [binding] the network this
   *   signer acts on. Omitted, the signer can still SIGN — which is all the device suite needs —
   *   but `sendTransaction` has no network to populate from or broadcast to, and says so.
   */
  constructor(session, account, binding = null) {
    this.session = session
    this.path = account.path
    this.address = getAddress(account.address)
    this.vendor = session.vendor

    if (binding && typeof binding.getNetwork === 'function') {
      // Spec 110 T028 — this argument used to be an ethers Provider. Passing one now would leave
      // the signer silently unable to send, so it fails here instead, naming the replacement.
      refuse('HardwareSigner takes a { chainId, client } binding, not a provider.')
    }
    const { chainId = null, client = null } = binding && typeof binding === 'object' ? binding : {}
    this.chainId = chainId == null ? null : Number(chainId)
    this.client = client ?? (this.chainId == null ? null : getPublicClient(this.chainId))
    this.chain = this.client?.chain ?? (this.chainId == null ? null : { id: this.chainId })
    // The ethers-`Provider`-shaped view every other converted rail hands its callers, so
    // `assertSignerOnChain` and the fee/estimate readers work on a device account unchanged.
    this.provider = this.client ? providerLike(this.client, { chain: this.chain, account: this.address }) : null
  }

  async getAddress() {
    return this.address
  }

  /** Rebind to another network. The device session is kept; only the chain changes. */
  connect(binding) {
    return new HardwareSigner(this.session, { path: this.path, address: this.address }, binding)
  }

  async estimateGas(tx) {
    if (!this.provider) refuse('This hardware session is not bound to a network, so nothing can be estimated.')
    return this.provider.estimateGas(tx)
  }

  async signMessage(message) {
    return this.session.signPersonalMessage(this.path, toBytes(message))
  }

  async signTypedData(domain, types, value) {
    if (typeof this.session.signTypedData !== 'function') {
      throw new HardwareWalletError(
        HW_ERROR_CODES.UNKNOWN,
        'This device session cannot sign typed data.',
      )
    }
    // Hand the adapter both forms: Ledger signs the two hashes, Trezor the full document.
    const cleanTypes = { ...types }
    delete cleanTypes.EIP712Domain
    const primaryType = primaryTypeOf(cleanTypes)
    if (!primaryType) {
      refuse('This typed-data table has no single primary type, so nothing has been signed.')
    }
    const payload = {
      domain,
      types,
      primaryType,
      message: value,
      domainSeparator: hashDomain({ domain, types: { EIP712Domain: getTypesForEIP712Domain({ domain }) } }),
      hashStructMessage: hashStruct({ data: value, primaryType, types: cleanTypes }),
    }
    return this.session.signTypedData(this.path, payload)
  }

  async signTransaction(txRequest) {
    const { from, ...fields } = txRequest
    if (from && getAddress(String(from)) !== this.address) {
      throw new HardwareWalletError(HW_ERROR_CODES.UNKNOWN, 'This transaction is not from the connected hardware account.')
    }
    const tx = toViemTransaction(fields)
    const unsignedSerialized = serializeTransaction(tx)

    // Trezor signs from structured fields; Ledger from the unsigned serialization. Build both once.
    const hex = (v) => (v == null ? undefined : `0x${BigInt(v).toString(16)}`)
    const txFields = {
      to: tx.to || undefined,
      value: hex(tx.value ?? 0),
      data: tx.data && tx.data !== '0x' ? tx.data : '0x',
      chainId: tx.chainId,
      nonce: hex(tx.nonce ?? 0),
      gasLimit: hex(tx.gas ?? 0),
      ...(tx.type === 'eip1559'
        ? { maxFeePerGas: hex(tx.maxFeePerGas ?? 0), maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas ?? 0) }
        : { gasPrice: hex(tx.gasPrice ?? 0) }),
    }

    const signed = await this.session.signTransaction(this.path, unsignedSerialized, txFields)
    const serialized = serializeTransaction(tx, signatureForViem(signed))

    // The device is the authority on what was signed; recover and cross-check so a vendor-layer
    // mixup (wrong path, wrong account) can never broadcast silently from someone else's account.
    const recovered = await recoverTransactionAddress({ serializedTransaction: serialized })
    if (getAddress(recovered) !== this.address) {
      throw new HardwareWalletError(
        HW_ERROR_CODES.UNKNOWN,
        'The device signed with a different account than expected. Reconnect and try again.',
      )
    }
    return serialized
  }

  /**
   * Populate, confirm on the device, broadcast.
   *
   * ethers' `AbstractSigner.sendTransaction` did these three steps and this reproduces them in the
   * same order, on the bound network rather than on whatever provider happened to be attached.
   * Anything the caller pinned is passed through untouched — the populator fills only what is
   * missing, exactly as ethers' did.
   */
  async sendTransaction(tx = {}) {
    if (!this.client) {
      refuse('This hardware session is not bound to a network, so nothing has been sent.')
    }
    const request = await this.client.prepareTransactionRequest({
      account: this.address,
      chain: this.chain,
      to: tx.to,
      ...(tx.data !== undefined ? { data: tx.data } : {}),
      ...(tx.value !== undefined ? { value: BigInt(tx.value) } : {}),
      ...(tx.nonce != null ? { nonce: Number(tx.nonce) } : {}),
      ...(tx.gasLimit != null ? { gas: BigInt(tx.gasLimit) } : {}),
      ...(tx.gas != null ? { gas: BigInt(tx.gas) } : {}),
      ...(tx.maxFeePerGas != null ? { maxFeePerGas: BigInt(tx.maxFeePerGas) } : {}),
      ...(tx.maxPriorityFeePerGas != null ? { maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) } : {}),
      ...(tx.gasPrice != null ? { gasPrice: BigInt(tx.gasPrice) } : {}),
    })
    const serialized = await this.signTransaction({ ...request, from: undefined })
    const hash = await this.client.sendRawTransaction({ serializedTransaction: serialized })
    const client = this.client
    return {
      hash,
      gasLimit: request.gas ?? null,
      nonce: request.nonce ?? null,
      async wait(confirmations = 1) {
        return waitForReceipt(client, hash, confirmations)
      },
    }
  }
}

export default HardwareSigner
