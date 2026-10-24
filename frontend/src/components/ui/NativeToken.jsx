import { useChainTokens } from '../../hooks/useChainTokens'

/**
 * Renders the active chain's native token symbol (POL on the Polygon pair,
 * ETH on local Hardhat). Use this in JSX where the symbol is the only thing
 * being rendered, so the label tracks the connected chain without per-
 * component wiring.
 */
export function NativeToken() {
  const { native } = useChainTokens()
  return <>{native}</>
}

export default NativeToken
