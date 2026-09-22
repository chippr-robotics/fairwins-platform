import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { zeroAddress } from 'viem'
import { readContract } from '../lib/chains/readContract'
import { formatUnits } from '../lib/evm/units'
import { useWallet, useWeb3 } from '../hooks'
import MarketAcceptanceModal from '../components/fairwins/MarketAcceptanceModal'
import { WAGER_REGISTRY_ABI } from '../abis/WagerRegistry'
import { getContractAddressForChain, DEPLOYED_CONTRACTS } from '../config/contracts'
import { WAGER_DEFAULTS, deriveWagerType } from '../constants/wagerDefaults'
import { parseEncryptedIpfsReference } from '../utils/ipfsService'
import './MarketAcceptancePage.css'

const Status = { None: 0, Open: 1, Active: 2, Resolved: 3, Cancelled: 4, Refunded: 5 }
const STATUS_NAMES = ['none', 'pending_acceptance', 'active', 'resolved', 'cancelled', 'refunded']

// Map token address → friendly metadata (decimals, symbol). Anything else is
// treated as a generic 18-decimal token.
function tokenInfo(addr) {
  if (!addr || addr === zeroAddress) return { decimals: 18, symbol: 'tokens' }
  const a = addr.toLowerCase()
  const usdc = (DEPLOYED_CONTRACTS.paymentToken || '').toLowerCase()
  const wmatic = (DEPLOYED_CONTRACTS.wmatic || '').toLowerCase()
  if (a === usdc) return { decimals: 6, symbol: 'USDC' }
  if (a === wmatic) return { decimals: 18, symbol: 'WPOL' }
  return { decimals: 18, symbol: 'tokens' }
}

function isEncryptedDescription(desc) {
  if (!desc || typeof desc !== 'string') return false
  const ipfsRef = parseEncryptedIpfsReference(desc)
  if (ipfsRef.isIpfs) return true
  try {
    const parsed = JSON.parse(desc)
    return parsed.version && parsed.algorithm && parsed.content
  } catch { return false }
}

function getIpfsCid(desc) {
  if (!desc || typeof desc !== 'string') return null
  const ipfsRef = parseEncryptedIpfsReference(desc)
  return ipfsRef.isIpfs ? ipfsRef.cid : null
}

/**
 * MarketAcceptancePage — v2.
 *
 * Reads from WagerRegistry.getWager(id) and synthesizes a `marketData` object
 * with the same field names the legacy modal expects.
 *
 * Route: /friend-market/accept?marketId=X (legacy URL kept for QR compatibility)
 */
function MarketAcceptancePage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { provider, chainId } = useWeb3()
  useWallet()

  const [marketData, setMarketData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const marketId = searchParams.get('marketId')

  const urlCreator = searchParams.get('creator')
  const urlStake = searchParams.get('stake')
  const urlToken = searchParams.get('token')
  const urlDeadline = searchParams.get('deadline')
  const urlSharedSignature = searchParams.get('sig') || null
  const urlCid = searchParams.get('cid') || null

  useEffect(() => {
    const fetch = async () => {
      if (!marketId) {
        setError('No wager ID provided')
        setLoading(false)
        return
      }
      if (!provider) {
        // Offline preview from URL params
        if (urlCreator && urlStake) {
          setMarketData({
            id: marketId,
            description: 'Connect wallet to view full offer details',
            creator: urlCreator,
            participants: [],
            arbitrator: null,
            marketType: 'oneVsOne',
            status: 'pending_acceptance',
            acceptanceDeadline: urlDeadline ? Number(urlDeadline) : Date.now() + 86400000,
            minAcceptanceThreshold: 1,
            stakePerParticipant: urlStake,
            stakeToken: null,
            stakeTokenSymbol: urlToken || 'tokens',
            acceptances: {},
            acceptedCount: 0,
          })
        } else {
          setError('Please connect your wallet to view offer details')
        }
        setLoading(false)
        return
      }

      try {
        setLoading(true)
        const registryAddress = getContractAddressForChain('wagerRegistry', chainId)
        if (!registryAddress) throw new Error('WagerRegistry not deployed on this network')

        // `getWager` returns ONE named struct, so viem hands back an object with the same field
        // names ethers gave — but `status` and `resolutionType` are uint8, which viem decodes as a
        // NUMBER where ethers gave a bigint. Every read of them below already goes through
        // `Number(...)`, so both shapes land the same; a new one must keep doing that (spec 110).
        const w = await readContract(chainId, {
          address: registryAddress,
          abi: WAGER_REGISTRY_ABI,
          functionName: 'getWager',
          args: [marketId],
        })

        if (!w.creator || w.creator === zeroAddress) {
          throw new Error(`Wager #${marketId} not found`)
        }

        const { decimals, symbol } = tokenInfo(w.token)
        const status = Number(w.status)
        const statusName = STATUS_NAMES[status] || 'unknown'

        // The opponent puts up opponentStake on acceptance; that's what the modal cares about.
        const stakePerParticipant = formatUnits(w.opponentStake, decimals)

        // v2 WagerRegistry has no marketType field — an Offer is encoded
        // as asymmetric stakes (creatorStake !== opponentStake). Derive the subtype
        // and the offered odds from raw stakes so the offer shows real Offer
        // terms instead of collapsing to even-money 1v1.
        const { type: wagerType, oddsMultiplier } = deriveWagerType(w.creatorStake, w.opponentStake)

        const rawDescription = w.metadataUri || ''
        const ipfsRef = parseEncryptedIpfsReference(rawDescription)
        const ipfsCid = ipfsRef.cid || getIpfsCid(rawDescription) || urlCid || null
        const encrypted = ipfsRef.isIpfs || isEncryptedDescription(rawDescription) || Boolean(urlCid)
        const displayDescription = encrypted
          ? 'Encrypted Wager'
          : (rawDescription || `Wager #${marketId}`)

        const opponentAddr = w.opponent
        const acceptances = {}
        if (opponentAddr && opponentAddr !== zeroAddress) {
          acceptances[opponentAddr.toLowerCase()] = {
            hasAccepted: status >= Status.Active,
            stakedAmount: stakePerParticipant,
            isArbitrator: false,
          }
        }
        // Creator implicitly accepts at creation
        if (w.creator) {
          acceptances[w.creator.toLowerCase()] = {
            hasAccepted: true,
            stakedAmount: formatUnits(w.creatorStake, decimals),
            isArbitrator: false,
          }
        }

        const acceptanceDeadlineMs = Number(w.acceptDeadline) * 1000
        const resolveDeadlineMs = Number(w.resolveDeadline) * 1000

        setMarketData({
          id: marketId,
          description: displayDescription,
          rawDescription,
          isEncrypted: encrypted,
          ipfsCid,
          sharedSignature: urlSharedSignature,
          creator: w.creator,
          participants: opponentAddr && opponentAddr !== zeroAddress ? [w.creator, opponentAddr] : [w.creator],
          arbitrator: (w.arbitrator && w.arbitrator !== zeroAddress) ? w.arbitrator : null,
          marketType: wagerType,
          opponentOddsMultiplier: oddsMultiplier,
          status: statusName,
          acceptanceDeadline: acceptanceDeadlineMs,
          resolveDeadline: resolveDeadlineMs,
          minAcceptanceThreshold: 1,
          stakePerParticipant,
          creatorStake: formatUnits(w.creatorStake, decimals),
          opponentStake: formatUnits(w.opponentStake, decimals),
          stakeToken: w.token,
          stakeTokenSymbol: symbol,
          stakeTokenDecimals: decimals,
          resolutionType: Number(w.resolutionType),
          polymarketConditionId: w.polymarketConditionId,
          creatorIsYes: w.creatorIsYes,
          acceptances,
          acceptedCount: status >= Status.Active ? 2 : 1,
          createdAt: 0,
          estimatedMarketEndDate: resolveDeadlineMs,
        })
      } catch (err) {
        console.error('Error fetching wager:', err)
        if (urlCreator && urlStake) {
          setMarketData({
            id: marketId,
            description: 'Offer details will load when connected...',
            creator: urlCreator,
            participants: [],
            arbitrator: null,
            marketType: 'oneVsOne',
            status: 'pending_acceptance',
            acceptanceDeadline: urlDeadline ? Number(urlDeadline) : Date.now() + 86400000,
            minAcceptanceThreshold: 1,
            stakePerParticipant: urlStake,
            stakeToken: null,
            stakeTokenSymbol: urlToken || 'tokens',
            acceptances: {},
            acceptedCount: 0,
          })
        } else {
          setError(err.message || 'Failed to load wager data. Please ensure you are connected to the correct network.')
        }
      } finally {
        setLoading(false)
      }
    }
    fetch()
  }, [marketId, provider, chainId, urlCreator, urlStake, urlToken, urlDeadline, urlSharedSignature, urlCid])

  const handleClose = () => navigate('/')
  const handleAccepted = () => { setLoading(true); window.location.reload() }

  if (loading) {
    return (
      <div className="map-loading">
        <div className="map-spinner"></div>
        <p>Loading offer details...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="map-error">
        <div className="map-error-icon">&#9888;</div>
        <h2>Unable to Load Offer</h2>
        <p>{error}</p>
        <button className="map-btn" onClick={handleClose}>Go Back</button>
      </div>
    )
  }

  return (
    <div className="map-container">
      <MarketAcceptanceModal
        isOpen={true}
        onClose={handleClose}
        marketId={marketId}
        marketData={marketData}
        onAccepted={handleAccepted}
        contractAddress={getContractAddressForChain('wagerRegistry', chainId)}
        contractABI={WAGER_REGISTRY_ABI}
      />
    </div>
  )
}

export default MarketAcceptancePage
