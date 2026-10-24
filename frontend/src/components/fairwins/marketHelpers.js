// Shared helpers for friend-market UIs. Imported by FriendMarketsModal,
// MyMarketsModal, and ShareWagerModal so the same display logic and
// acceptance-URL format apply everywhere.

import { isOpenChallengeMarket } from './wagerCardHelpers'

export const formatUSD = (amount, symbol) => {
  const num = parseFloat(amount) || 0
  const isStablecoin = symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI'

  if (isStablecoin) {
    if (num === 0) return '$0.00'
    if (num < 0.01) return '< $0.01'
    return `$${num.toFixed(2)}`
  }
  return `${num} ${symbol || 'tokens'}`
}

export const getMarketDescription = (market) => {
  if (market.metadata && market.canView !== false) {
    const title = market.metadata.name || market.metadata.description || market.metadata.question
    if (
      title &&
      title !== 'Private Market' &&
      title !== 'Private Wager' &&
      title !== 'Encrypted Market' &&
      title !== 'Encrypted Wager'
    ) {
      return title
    }
  }

  const desc = market.description
  if (
    desc &&
    desc !== 'Encrypted Market' &&
    desc !== 'Encrypted Wager' &&
    desc !== 'Private Market' &&
    desc !== 'Private Wager'
  ) {
    return desc
  }

  const stakeInfo = market.stakeAmount ? `${market.stakeAmount} ${market.stakeTokenSymbol || 'POL'}` : ''
  // Open challenges (feature 024) have no bound opponent and code-gated terms — label them honestly.
  if (isOpenChallengeMarket(market)) return `Open Challenge${stakeInfo ? ` - ${stakeInfo}` : ''}`
  return `Private Bet${stakeInfo ? ` - ${stakeInfo}` : ''}`
}

export const getMarketUrl = (market, fallbackCreator = '') => {
  if (!market?.id) return `${window.location.origin}/friend-market/preview`

  const params = new URLSearchParams({
    marketId: market.id,
    creator: market.creator || fallbackCreator || '',
    stake: market.stakeAmount || '0',
    token: market.stakeTokenSymbol || 'POL',
    deadline: market.acceptanceDeadline
      ? new Date(market.acceptanceDeadline).getTime().toString()
      : ''
  })

  if (market.ipfsCid) {
    params.set('cid', market.ipfsCid)
  }

  return `${window.location.origin}/friend-market/accept?${params.toString()}`
}
