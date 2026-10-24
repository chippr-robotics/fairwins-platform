/**
 * Seaport order builder (spec 056) — hand-built EIP-712 typed data for a listing, signed through
 * the repo's single `signer.signTypedData(domain, types, message)` seam (EOA or the passkey
 * `passkeyIntentSigner` adapter). See specs/056-collectibles-sell-side/contracts/seaport-order-signing.md.
 *
 * Types live ONLY here (mirrors lib/relay/intentTypes.js). The seller-receipt consideration amount is
 * computed as the SAME `net` the confirm UI shows, so what the user sees equals what they sign (FR-010).
 * No consideration item ever pays a FairWins address — attribution is OpenSea's referral, never a
 * surcharge (FR-015).
 */
import { zeroAddress } from 'viem'
import { formatUnits, parseUnits } from '../evm/units'
// Seaport EIP-712 types (protocol standard; kept in one place).
export const SEAPORT_ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
}

const ITEM_TYPE = { NATIVE: 0, ERC20: 1, ERC721: 2, ERC1155: 3 }
const ZERO_HASH = '0x' + '0'.repeat(64)

/** Human-readable label for a fee recipient given the marketplace-fee recipient from the breakdown. */
function feeLabel(recipient, marketplaceRecipient) {
  return marketplaceRecipient && recipient.toLowerCase() === marketplaceRecipient.toLowerCase()
    ? 'Marketplace fee'
    : 'Creator royalty'
}

/**
 * Compute the fee split + net proceeds in the price currency (integer base units, no float drift).
 * @returns {{ priceUnits: bigint, sellerUnits: bigint, feeItems: Array<{recipient, units, label}>, net: string, feeLines: Array<{label, amount, currency}>, belowFloor: boolean }}
 */
export function computeNet(price, feeBreakdown) {
  const decimals = Number(price.decimals ?? 18)
  const priceUnits = parseUnits(String(price.amount), decimals)
  const required = (feeBreakdown?.fees ?? []).filter((f) => f.required)
  const marketplaceRecipient = feeBreakdown?.marketplaceFee?.recipient ?? null

  let feeTotal = 0n
  const feeItems = required.map((f) => {
    const units = (priceUnits * BigInt(f.basisPoints)) / 10_000n
    feeTotal += units
    return { recipient: f.recipient, units, label: feeLabel(f.recipient, marketplaceRecipient) }
  })
  const sellerUnits = priceUnits - feeTotal
  return {
    priceUnits,
    sellerUnits,
    feeItems,
    net: formatUnits(sellerUnits < 0n ? 0n : sellerUnits, decimals),
    feeLines: feeItems.map((fi) => ({ label: fi.label, amount: formatUnits(fi.units, decimals), currency: price.currency })),
    belowFloor: sellerUnits <= 0n,
  }
}

/**
 * Build the Seaport listing order as EIP-712 typed data.
 *
 * @param {object} item          { chainId, contract, identifier, standard, quantity? }
 * @param {object} price         { amount, currency, decimals, tokenAddress?, native? }
 * @param {object} feeBreakdown  gateway required-fees response (fees + protocol/conduit)
 * @param {object} opts          { offerer, expirySeconds, counter, salt, now }
 * @returns {{ domain, types, message, net, feeLines, belowFloor, currency }}
 */
export function buildOrder(item, price, feeBreakdown, opts) {
  const { offerer, expirySeconds = 30 * 24 * 3600, counter = 0, salt = '0', now } = opts
  const nowSec = Math.floor((now ?? Date.now()) / 1000)
  const { sellerUnits, feeItems, net, feeLines, belowFloor } = computeNet(price, feeBreakdown)

  const payToken = price.native ? zeroAddress : price.tokenAddress
  const payItemType = price.native ? ITEM_TYPE.NATIVE : ITEM_TYPE.ERC20
  const nftItemType = item.standard === 'erc1155' ? ITEM_TYPE.ERC1155 : ITEM_TYPE.ERC721
  const nftAmount = String(item.quantity && item.standard === 'erc1155' ? item.quantity : 1)

  const consideration = [
    // Seller receipt (the honest `net`, in base units) — recipient is the seller.
    {
      itemType: payItemType,
      token: payToken,
      identifierOrCriteria: '0',
      startAmount: sellerUnits.toString(),
      endAmount: sellerUnits.toString(),
      recipient: offerer,
    },
    // Every REQUIRED fee, paid to the marketplace/creator recipients from OpenSea's fee data.
    ...feeItems.map((fi) => ({
      itemType: payItemType,
      token: payToken,
      identifierOrCriteria: '0',
      startAmount: fi.units.toString(),
      endAmount: fi.units.toString(),
      recipient: fi.recipient,
    })),
  ]

  const message = {
    offerer,
    zone: zeroAddress,
    offer: [
      {
        itemType: nftItemType,
        token: item.contract,
        identifierOrCriteria: String(item.identifier),
        startAmount: nftAmount,
        endAmount: nftAmount,
      },
    ],
    consideration,
    orderType: 0, // FULL_OPEN
    startTime: String(nowSec),
    endTime: String(nowSec + expirySeconds),
    zoneHash: ZERO_HASH,
    salt: String(salt),
    conduitKey: feeBreakdown.conduitKey,
    counter: String(counter),
  }

  const domain = {
    name: 'Seaport',
    version: feeBreakdown.protocolVersion || '1.6',
    chainId: Number(item.chainId),
    verifyingContract: feeBreakdown.protocolAddress,
  }

  return { domain, types: SEAPORT_ORDER_TYPES, message, net, feeLines, belowFloor, currency: price.currency }
}
