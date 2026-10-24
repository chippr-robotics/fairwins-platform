import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ethers } from 'ethers'
import {
  SANCTIONED_ADDRESS_SELECTOR,
  revertReasonFrom,
  sanctionedAddressFrom,
  screenedActorMessage,
  screenedPartyMessage,
} from '../../lib/wagers/sanctionsRevert'
import { translateRevert } from '../../hooks/useFriendMarketCreation'
import { translateOpenCreateRevert } from '../../hooks/useOpenChallengeCreate'
import { translateAcceptRevert } from '../../hooks/useOpenChallengeAccept'

// #1292 — a screened member was shown "execution reverted (unknown custom error)". ISanctionsGuard's
// errors are not in the registry ABI the frontend ships, so nothing could name the revert; the copy
// that replaces it must also be true, which is what most of this file pins.

const MEMBER = '0x1111111111111111111111111111111111111111'
const CREATOR = '0x2222222222222222222222222222222222222222'
const encodeSanctioned = (address) => `${SANCTIONED_ADDRESS_SELECTOR}${address.slice(2).toLowerCase().padStart(64, '0')}`

describe('sanctionsRevert: selector', () => {
  it('matches the error signature this repo actually compiles', () => {
    // The hardcoded selector is only defensible while it agrees with the Solidity in this build.
    // Derive it from the interface source (the parity pattern of `test/intent/TypehashParity.test.js`):
    // renaming `SanctionedAddress` or changing its arity must fail HERE, not silently return every
    // screened member to "execution reverted (unknown custom error)" with the suite still green.
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../../contracts/interfaces/ISanctionsGuard.sol'),
      'utf8',
    )
    const declaration = source.match(/error\s+SanctionedAddress\s*\(([^)]*)\)\s*;/)
    expect(declaration, 'ISanctionsGuard no longer declares SanctionedAddress').not.toBeNull()

    const types = declaration[1]
      .split(',')
      .map((param) => param.trim().split(/\s+/)[0])
      .filter(Boolean)
    expect(ethers.id(`SanctionedAddress(${types.join(',')})`).slice(0, 10)).toBe(SANCTIONED_ADDRESS_SELECTOR)
  })
})

describe('sanctionsRevert: revertReasonFrom', () => {
  const sanctionedData = encodeSanctioned(MEMBER)

  it('names SanctionedAddress from the revert selector on error.data', () => {
    const err = { data: sanctionedData, shortMessage: 'execution reverted (unknown custom error)' }
    expect(revertReasonFrom(err)).toBe('SanctionedAddress')
  })

  it('finds the selector on the nested RPC error shapes ethers uses', () => {
    expect(revertReasonFrom({ info: { error: { data: sanctionedData } } })).toBe('SanctionedAddress')
    expect(revertReasonFrom({ error: { data: sanctionedData } })).toBe('SanctionedAddress')
  })

  it('finds the selector on the wallet shapes that nest the payload deeper', () => {
    // MetaMask leaves the node payload under `data.data` (err.data is an OBJECT there), and
    // wrapped providers double the `error` nesting — the shared `rawRevertData` walk covers both.
    expect(revertReasonFrom({ data: { data: sanctionedData } })).toBe('SanctionedAddress')
    expect(revertReasonFrom({ error: { error: { data: sanctionedData } } })).toBe('SanctionedAddress')
  })

  it('ignores err.transaction.data — that is the calldata we SENT, not what came back', () => {
    // Reading it would shadow the real revert data on almost every failure, since it is populated
    // whether or not the call reverted with a custom error.
    const err = { transaction: { data: sanctionedData }, shortMessage: 'execution reverted: NotOpen' }
    expect(revertReasonFrom(err)).toBe('execution reverted: NotOpen')
    expect(sanctionedAddressFrom(err)).toBeNull()
  })

  it('falls back to the reason ethers already decoded', () => {
    expect(revertReasonFrom({ reason: 'MembershipDenied', data: '0xdeadbeef' })).toBe('MembershipDenied')
    expect(revertReasonFrom({ shortMessage: 'execution reverted: ZeroStake' }))
      .toBe('execution reverted: ZeroStake')
    expect(revertReasonFrom({ message: 'network error' })).toBe('network error')
  })

  it('returns an empty reason for an error carrying nothing usable', () => {
    expect(revertReasonFrom({})).toBe('')
    expect(revertReasonFrom(null)).toBe('')
    expect(revertReasonFrom(undefined)).toBe('')
  })
})

describe('sanctionsRevert: sanctionedAddressFrom', () => {
  it('decodes the address the guard named, checksummed', () => {
    expect(sanctionedAddressFrom({ data: encodeSanctioned(CREATOR) })).toBe(ethers.getAddress(CREATOR))
    expect(sanctionedAddressFrom({ info: { error: { data: encodeSanctioned(MEMBER) } } }))
      .toBe(ethers.getAddress(MEMBER))
  })

  it('returns null for a different revert, truncated data, or nothing at all', () => {
    expect(sanctionedAddressFrom({ data: '0xdeadbeef' })).toBeNull()
    expect(sanctionedAddressFrom({ data: `${SANCTIONED_ADDRESS_SELECTOR}1234` })).toBeNull()
    expect(sanctionedAddressFrom({ reason: 'SanctionedAddress' })).toBeNull()
    expect(sanctionedAddressFrom(null)).toBeNull()
  })
})

describe('sanctionsRevert: what the copy may claim', () => {
  const everyMessage = [
    screenedActorMessage('the wager was not created'),
    screenedPartyMessage({ outcome: 'the wager was not accepted', sanctioned: MEMBER, account: MEMBER }),
    screenedPartyMessage({ outcome: 'the wager was not accepted', sanctioned: CREATOR, account: MEMBER }),
    screenedPartyMessage({ outcome: 'the wager was not accepted', sanctioned: CREATOR }),
    screenedPartyMessage({ outcome: 'the wager was not accepted' }),
  ]

  it('never asserts that an account is listed or flagged', () => {
    // SanctionsGuard.isAllowed is FAIL-CLOSED: it returns false — so checkBlocked reverts
    // SanctionedAddress — whenever the configured oracle is unreachable or erroring. During an
    // outage every member hits this revert, listed or not, so "you are flagged" is a claim the
    // revert does not establish. Report only that screening did not clear the account.
    for (const message of everyMessage) {
      expect(message).not.toMatch(/flagged|sanctions list|listed|blocked account/i)
      expect(message).toMatch(/did not clear/i)
      expect(message).toMatch(/cannot be reached/i)
    }
  })

  it('never claims nothing was submitted on-chain', () => {
    // On the self-submit legs a stake approval (and, on create, the batchExpireOpen cleanup) are
    // already sent, confirmed and PAID FOR by the time the screened simulation reverts.
    for (const message of everyMessage) {
      expect(message).not.toMatch(/nothing was (submitted|sent|moved)/i)
    }
  })
})

describe('sanctionsRevert: which party the message blames', () => {
  const outcome = 'the wager was not accepted'

  it('says "your account" when the guard named the acting member', () => {
    const message = screenedPartyMessage({ outcome, sanctioned: MEMBER, account: MEMBER })
    expect(message).toMatch(/your account/i)
    expect(message).not.toMatch(/other party/i)
  })

  it('blames the OTHER party — and clears the member — when the guard named the creator', () => {
    // `_runAcceptGuard` screens both (`_screen(taker); _screen(creator);`). A creator listed after
    // their wager was created reverts every accept with the CREATOR's address; telling the acceptor
    // their own clean account was stopped would be a false compliance accusation.
    const message = screenedPartyMessage({ outcome, sanctioned: CREATOR, account: MEMBER })
    expect(message).toMatch(/other party's account/i)
    expect(message).toMatch(/not yours/i)
    expect(message).toMatch(/0x2222…2222/)
    expect(message).not.toMatch(/your account/i)
    // Nothing for the member to fix, so don't send them to support with their own address.
    expect(message).not.toMatch(/the address you are using/i)
  })

  it('says which account without guessing whose when the acting address is unknown', () => {
    const message = screenedPartyMessage({ outcome, sanctioned: CREATOR })
    expect(message).toMatch(/0x2222…2222/)
    expect(message).not.toMatch(/your account|other party/i)
  })

  it('admits it does not know when the revert data was unreadable', () => {
    const message = screenedPartyMessage({ outcome, account: MEMBER })
    expect(message).toMatch(/does not say which one/i)
    expect(message).not.toMatch(/other party's account \(/i)
  })
})

describe('sanctionsRevert: every screened wager entrypoint speaks to it', () => {
  // FOUR entrypoints are screened, not two: createWager + acceptWager (WagerRegistryCore) and
  // createOpenWager + acceptOpenWager. A surface missing this mapping returns its member to the
  // raw "unknown custom error" #1292 reports.
  it('createWager (translateRevert)', () => {
    const message = translateRevert(revertReasonFrom({ data: encodeSanctioned(MEMBER) }))
    expect(message).toMatch(/sanctions screening/i)
    expect(message).toMatch(/wager was not created/i)
    expect(message).not.toMatch(/transaction will fail/i)
  })

  it('createOpenWager (translateOpenCreateRevert)', () => {
    const message = translateOpenCreateRevert(revertReasonFrom({ data: encodeSanctioned(MEMBER) }))
    expect(message).toMatch(/sanctions screening/i)
    expect(message).toMatch(/open challenge was not created/i)
    expect(message).not.toMatch(/unknown custom error/i)
  })

  it('acceptOpenWager (translateAcceptRevert) names the party from the revert data', () => {
    const own = { data: encodeSanctioned(MEMBER) }
    expect(translateAcceptRevert(revertReasonFrom(own), { error: own, account: MEMBER }))
      .toMatch(/your account/i)

    const theirs = { data: encodeSanctioned(CREATOR) }
    const message = translateAcceptRevert(revertReasonFrom(theirs), { error: theirs, account: MEMBER })
    expect(message).toMatch(/other party's account/i)
    expect(message).toMatch(/challenge was not accepted/i)
    expect(message).not.toMatch(/your account/i)
  })

  it('leaves every other revert of those surfaces alone', () => {
    expect(translateOpenCreateRevert('AcceptExpired')).not.toMatch(/sanctions/i)
    expect(translateAcceptRevert('AcceptExpired')).toMatch(/expired/i)
    expect(translateAcceptRevert('MembershipDenied')).toMatch(/active membership/i)
  })
})

/*
 * DIVERGENCE 23 (spec 110). Every translator in this area matches on the STRING this returns —
 * `r.includes('NotOpenChallenge')`, `r.includes('MembershipDenied')`, nine of them on the accept
 * path alone. Under ethers that worked because ethers put a decoded custom error's name on
 * `error.reason`. viem puts it in NO message: its `shortMessage` for the same revert is the whole
 * of `The contract function "…" reverted.`, and the name lives on `cause.data.errorName`.
 *
 * So without this the accept flow would stop naming nine distinct failures and tell every member
 * "Acceptance failed. Please try again." — no error, no crash, nothing red.
 *
 * The errors below are REAL viem errors, produced by driving a real `readContract` against a
 * transport that throws, because a hand-built fixture would agree with whatever this file was
 * written to expect.
 */
describe('revertReasonFrom on a viem error (divergence 23)', () => {
  async function viemRevert(data) {
    const { createPublicClient, custom, parseAbi } = await import('viem')
    const abi = parseAbi([
      'function acceptOpenWager(uint256 id, bytes sig)',
      'error NotOpenChallenge()',
      'error MembershipDenied()',
    ])
    const client = createPublicClient({
      chain: { id: 137, name: 'p', nativeCurrency: { name: 'n', symbol: 'n', decimals: 18 }, rpcUrls: { default: { http: [] } } },
      transport: custom({
        async request({ method }) {
          if (method === 'eth_chainId') return '0x89'
          throw Object.assign(new Error('execution reverted'), { code: 3, data: { data } })
        },
      }),
    })
    try {
      await client.readContract({ address: '0x' + '11'.repeat(20), abi, functionName: 'acceptOpenWager', args: [1n, '0x00'] })
      throw new Error('expected a revert')
    } catch (e) {
      return e
    }
  }

  it('names a decoded custom error that appears in no message', async () => {
    const { encodeErrorResult, parseAbi } = await import('viem')
    const abi = parseAbi(['error NotOpenChallenge()', 'error MembershipDenied()'])
    const err = await viemRevert(encodeErrorResult({ abi, errorName: 'NotOpenChallenge' }))
    // The name is genuinely absent from what a message-reading implementation would have seen.
    expect(err.shortMessage).not.toContain('NotOpenChallenge')
    expect(revertReasonFrom(err)).toBe('NotOpenChallenge')
    expect(translateAcceptRevert(revertReasonFrom(err))).toBe(
      'This challenge is no longer open — someone may have already taken it.',
    )

    const denied = await viemRevert(encodeErrorResult({ abi, errorName: 'MembershipDenied' }))
    expect(translateAcceptRevert(revertReasonFrom(denied))).toBe(
      'An active membership is required to take a challenge. Purchase one and try again.',
    )
  })

  it('prefers the string a plain revert("…") carried over the `Error` wrapper name', async () => {
    const reason = 'ZeroStake'
    const data =
      '0x08c379a0' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      `000000000000000000000000000000000000000000000000000000000000000${reason.length.toString(16)}` +
      Buffer.from(reason).toString('hex').padEnd(64, '0')
    const err = await viemRevert(data)
    expect(revertReasonFrom(err)).toBe('ZeroStake')
  })

  it('still finds SanctionedAddress by selector, which no ABI here decodes', async () => {
    const err = await viemRevert(encodeSanctioned(MEMBER))
    expect(revertReasonFrom(err)).toBe('SanctionedAddress')
  })
})
