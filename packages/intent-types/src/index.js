/**
 * @fairwins/intent-types — the SINGLE definition of every FairWins EIP-712 intent struct.
 *
 * WHY THIS PACKAGE EXISTS (spec 075, FR-024/FR-025)
 * These field lists decide what a member's signature authorises. A mismatch between the signer and
 * the verifier does not raise an error — it produces a signature that verifies against something
 * other than what the member was shown. CLAUDE.md required three copies (contract typehashes, the
 * frontend, the relay gateway) to stay byte-identical, enforced only by human discipline.
 *
 * Discipline held for 26 of 27 structs. It did not hold for the 27th: `InvalidateNonce` existed in
 * the contract and the frontend and was ABSENT from the gateway, so a relayed `invalidateNonce`
 * was an unknown action there. That is the whole argument for this file.
 *
 * WHY IT COULD NOT SIMPLY BE IMPORTED BEFORE
 * `frontend/src` uses extensionless relative imports (Vite-resolved) — 2,966 of them — while the
 * gateway is plain Node ESM, which requires extensions. The gateway physically could not import
 * the frontend's copy, so it kept its own. This package is authored Node-resolvable (extensioned
 * imports, explicit `exports`) so BOTH can consume it.
 *
 * RULES FOR THIS FILE
 *   · Zero runtime dependencies. It is pure data plus pure functions.
 *   · Never import from frontend/src, services/, or a Vite virtual module.
 *   · Changing a struct changes what signatures mean. test/intent/TypehashParity.test.js checks
 *     every entry against the deployed contract's own *_TYPEHASH constant and fails on a mismatch.
 *   · The same is true of the DOMAINS below: a correct type table signed under the wrong
 *     name/version produces a signature that verifies nowhere. Same file, same gate.
 */

/**
 * OFF-CHAIN definitions (spec 095) live in ./offchain.js and are re-exported here so both trees
 * keep one import specifier — `@fairwins/intent-types`. They are in a SEPARATE FILE, and are
 * deliberately absent from `CONTRACT_VERIFIED_TYPES` / `CONTRACT_DOMAINS`, because no Solidity
 * verifies them: the member-API capability token is checked by the relay gateway alone. Read that
 * file's header before adding anything beside them.
 */
export {
  MEMBER_API_DOMAIN,
  MEMBER_API_GRANT_TYPES,
  MEMBER_API_REVOCATION_TYPES,
  canonicalScopeString,
} from './offchain.js'

/**
 * EIP-712 DOMAINS, keyed by the `getContractAddressForChain` key of the contract that verifies the
 * signature. `chainId` and `verifyingContract` are runtime values, so only the two STATIC halves
 * live here — they are what the contract fixed at `__EIP712_init(name, version)` and can never be
 * inferred from the struct tables above.
 *
 * WHY THESE ARE HERE AND NOT NEXT TO THE CALL SITES
 * A struct table is only half of what a signature commits to. The digest is
 * `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct)`, so a byte-perfect struct signed under the
 * wrong domain name or version produces a signature that verifies against NOTHING — the member is
 * prompted, pays nothing, and the relay simply fails, or (worse, if some other deployment shares
 * that domain) verifies somewhere it was never meant to. These pairs previously existed in three
 * production copies (the frontend's five `*Domain()` helpers, the gateway's `CONTRACT_DOMAINS`, and
 * a sixth literal in the claim-code signer) with nothing tying any of them to the Solidity.
 *
 * Entries are `{ name, version }` and NOTHING else, deliberately: consumers spread them into an
 * EIP-712 domain object, so any extra key would land in the domain and change the separator.
 *
 * AUTHORITY: `DOMAIN_SOURCES` below names the contract each pair is copied from;
 * test/intent/TypehashParity.test.js parses that contract's own `__EIP712_init(...)` arguments and
 * fails if either half drifts, in either direction.
 */
export const CONTRACT_DOMAINS = Object.freeze({
  wagerRegistry: Object.freeze({ name: 'FairWins WagerRegistry', version: '1' }),
  membershipManager: Object.freeze({ name: 'FairWins MembershipManager', version: '1' }),
  // Tier-2 group pools (spec 034/035). The FACTORY verifies createPoolWithSig under its own domain;
  // each CLONE verifies the six actor twins under a per-clone domain (verifyingContract = the clone),
  // which is why these are two entries and not one.
  wagerPool: Object.freeze({ name: 'FairWins WagerPool', version: '1' }),
  wagerPoolFactory: Object.freeze({ name: 'FairWins WagerPoolFactory', version: '1' }),
  callsignRegistry: Object.freeze({ name: 'FairWins CallsignRegistry', version: '1' }),
  // Funding pools (spec 103) — the same factory/clone split as the wager pools: the FACTORY verifies
  // createPoolWithSig under its own domain, each CLONE verifies the four actor twins under a per-clone
  // domain (verifyingContract = the clone).
  fundingPool: Object.freeze({ name: 'FairWins FundingPool', version: '1' }),
  fundingPoolFactory: Object.freeze({ name: 'FairWins FundingPoolFactory', version: '1' }),
})

/**
 * Which contract each domain is copied FROM — repo-relative, so the parity gate can read the
 * `__EIP712_init` call rather than trusting the comment beside it. Keys must match
 * `CONTRACT_DOMAINS` exactly (asserted). Not used at runtime.
 */
export const DOMAIN_SOURCES = Object.freeze({
  wagerRegistry: 'contracts/wagers/WagerRegistry.sol',
  membershipManager: 'contracts/access/MembershipManager.sol',
  wagerPool: 'contracts/pools/WagerPool.sol',
  wagerPoolFactory: 'contracts/pools/WagerPoolFactory.sol',
  callsignRegistry: 'contracts/naming/CallsignRegistry.sol',
  fundingPool: 'contracts/pools/FundingPool.sol',
  fundingPoolFactory: 'contracts/pools/FundingPoolFactory.sol',
})

/**
 * Build the full EIP-712 domain for a verifying contract on a chain.
 *
 * Throws on an unknown key rather than returning undefined: a missing domain must surface as an
 * error at signing time, never as `signTypedData(undefined, …)` producing a digest under an empty
 * domain.
 *
 * @param {keyof typeof CONTRACT_DOMAINS} key
 * @param {number|bigint|string} chainId
 * @param {string} verifyingContract - the PROXY (or clone) address that will verify the signature
 * @returns {{name: string, version: string, chainId: number, verifyingContract: string}}
 */
export function domainFor(key, chainId, verifyingContract) {
  const d = CONTRACT_DOMAINS[key]
  if (!d) {
    throw new Error(
      `Unknown EIP-712 domain key: ${key}. Known keys: ${Object.keys(CONTRACT_DOMAINS).join(', ')}`,
    )
  }
  return { name: d.name, version: d.version, chainId: Number(chainId), verifyingContract }
}

/** Common trailing fields shared by every intent struct (schema: "Common trailing fields"). */
const TRAILING = [
  { name: 'nonce', type: 'bytes32' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
]

/** `{ wagerId, actor }` shape shared by most no-stake wager intents. */
const WAGER_ACTOR = [
  { name: 'wagerId', type: 'uint256' },
  { name: 'actor', type: 'address' },
]

/**
 * EIP-712 struct field lists, keyed by primary type. Pass as
 * `{ [primaryType]: INTENT_TYPES[primaryType] }` to `signer.signTypedData` (no nested custom types).
 */
export const INTENT_TYPES = {
  CreateWagerIntent: [
    { name: 'creator', type: 'address' },
    { name: 'opponent', type: 'address' },
    { name: 'arbitrator', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'creatorStake', type: 'uint128' },
    { name: 'opponentStake', type: 'uint128' },
    { name: 'acceptDeadline', type: 'uint64' },
    { name: 'resolveDeadline', type: 'uint64' },
    { name: 'resolutionType', type: 'uint8' },
    { name: 'conditionId', type: 'bytes32' },
    { name: 'creatorIsYes', type: 'bool' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'metadataUri', type: 'string' },
    { name: 'termsVersionHash', type: 'bytes32' },
    { name: 'paymentNonce', type: 'bytes32' },
    ...TRAILING,
  ],
  AcceptWagerIntent: [
    { name: 'wagerId', type: 'uint256' },
    { name: 'taker', type: 'address' },
    { name: 'paymentNonce', type: 'bytes32' },
    ...TRAILING,
  ],
  ClaimPayoutIntent: [
    { name: 'wagerId', type: 'uint256' },
    { name: 'claimant', type: 'address' },
    ...TRAILING,
  ],
  ClaimRefundIntent: [...WAGER_ACTOR, ...TRAILING],
  DeclareDrawIntent: [...WAGER_ACTOR, ...TRAILING],
  RevokeDrawIntent: [...WAGER_ACTOR, ...TRAILING],
  CancelOpenIntent: [...WAGER_ACTOR, ...TRAILING],
  DeclineIntent: [...WAGER_ACTOR, ...TRAILING],
  DeclareWinnerIntent: [
    { name: 'wagerId', type: 'uint256' },
    { name: 'winner', type: 'address' },
    { name: 'actor', type: 'address' },
    ...TRAILING,
  ],
  PurchaseTierIntent: [
    { name: 'role', type: 'bytes32' },
    { name: 'tier', type: 'uint8' },
    { name: 'acceptedTermsHash', type: 'bytes32' },
    { name: 'member', type: 'address' },
    { name: 'paymentNonce', type: 'bytes32' },
    ...TRAILING,
  ],
  UpgradeTierIntent: [
    { name: 'role', type: 'bytes32' },
    { name: 'tier', type: 'uint8' },
    { name: 'acceptedTermsHash', type: 'bytes32' },
    { name: 'member', type: 'address' },
    { name: 'paymentNonce', type: 'bytes32' },
    ...TRAILING,
  ],
  ExtendMembershipIntent: [
    { name: 'role', type: 'bytes32' },
    { name: 'member', type: 'address' },
    { name: 'paymentNonce', type: 'bytes32' },
    ...TRAILING,
  ],
  RedeemVoucherIntent: [
    { name: 'voucherId', type: 'uint256' },
    { name: 'acceptedTermsHash', type: 'bytes32' },
    { name: 'redeemer', type: 'address' },
    ...TRAILING,
  ],
  // Gasless cancel of an unsubmitted intent (invalidateNonceWithSig, FR-006) — no validAfter: the
  // cancel should be executable immediately, bounded only by validBefore.
  InvalidateNonce: [
    { name: 'signer', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'validBefore', type: 'uint256' },
  ],

  // ---- Tier-2 group pools (spec 035/036) ----
  // Byte-identical to the on-chain typehashes: the six actor twins verify against the CLONE's domain,
  // CreatePool against the FACTORY's. `pool`/`entries` ride in intent.params (calldata), NOT the struct.
  ApproveOutcome: [
    { name: 'member', type: 'address' },
    { name: 'proposalId', type: 'bytes32' },
    ...TRAILING,
  ],
  ClaimShare: [
    { name: 'winner', type: 'address' },
    { name: 'index', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    ...TRAILING,
  ],
  ProposeOutcome: [
    { name: 'creator', type: 'address' },
    { name: 'proposalId', type: 'bytes32' },
    ...TRAILING,
  ],
  CloseJoining: [
    { name: 'creator', type: 'address' },
    ...TRAILING,
  ],
  Cancel: [
    { name: 'creator', type: 'address' },
    ...TRAILING,
  ],
  Refund: [
    { name: 'member', type: 'address' },
    ...TRAILING,
  ],
  CreatePool: [
    { name: 'creator', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'buyIn', type: 'uint256' },
    { name: 'maxMembers', type: 'uint32' },
    { name: 'thresholdBips', type: 'uint16' },
    { name: 'acceptDeadline', type: 'uint64' },
    { name: 'resolveDeadline', type: 'uint64' },
    ...TRAILING,
  ],

  // ---- Callsign registry (spec 054) — signer-attributed, no payment leg (free with Gold membership).
  //      Byte-identical to CallsignRegistry.sol typehashes + services/relay-gateway/src/intent/intentTypes.js.
  CommitCallsignIntent: [
    { name: 'owner', type: 'address' },
    { name: 'commitment', type: 'bytes32' },
    ...TRAILING,
  ],
  RegisterCallsignIntent: [
    { name: 'owner', type: 'address' },
    { name: 'callsign', type: 'string' },
    { name: 'salt', type: 'bytes32' },
    ...TRAILING,
  ],
  ChangeCallsignIntent: [
    { name: 'owner', type: 'address' },
    { name: 'newCallsign', type: 'string' },
    { name: 'salt', type: 'bytes32' },
    ...TRAILING,
  ],
  ReleaseCallsignIntent: [
    { name: 'owner', type: 'address' },
    { name: 'callsignHash', type: 'bytes32' },
    ...TRAILING,
  ],
  RequestRepointIntent: [
    { name: 'owner', type: 'address' },
    { name: 'callsignHash', type: 'bytes32' },
    { name: 'newOwner', type: 'address' },
    ...TRAILING,
  ],
  CancelRepointIntent: [
    { name: 'owner', type: 'address' },
    { name: 'callsignHash', type: 'bytes32' },
    ...TRAILING,
  ],
}

/**
 * `OpenAccept` — the claim-code proof leg of an open-challenge accept (feature 024).
 *
 * WHY IT IS NOT IN `INTENT_TYPES`
 * It is not an intent: it carries no `nonce/validAfter/validBefore`, and it is not signed by the
 * member. It is signed by the key DERIVED FROM THE FOUR-WORD CLAIM CODE
 * (frontend/src/utils/claimCode/deriveFromCode.js), proving the accepter holds the code, and bound
 * to `taker` so a mempool observer cannot re-point it at their own address.
 *
 * WHY IT IS IN THIS PACKAGE ANYWAY
 * It is verified on-chain by WagerRegistryCore's OPEN_ACCEPT_TYPEHASH, under the SAME
 * `wagerRegistry` domain as the intents, and it is a required leg of the relayed
 * `acceptOpenWager` action (`acceptOpenWagerWithAuthorization(..., claimCodeSig, ...)`). It was a
 * hand-maintained two-place struct sitting on exactly the gasless path this package exists to
 * protect — so it belongs under the same gate, in its own table.
 */
export const OPEN_ACCEPT_TYPES = {
  OpenAccept: [
    { name: 'wagerId', type: 'uint256' },
    { name: 'taker', type: 'address' },
  ],
}

/**
 * Every struct in this package that a FAIRWINS contract verifies, merged.
 *
 * This is the set test/intent/TypehashParity.test.js checks in BOTH directions — package→Solidity
 * and Solidity→package. A new table of contract-verified structs must be merged in here, or the
 * Solidity→package direction will report its structs as ungated.
 *
 * The two EIP-3009 tables below are deliberately absent: their authority is Circle's deployed USDC,
 * not a contract in this repo (see the note on them).
 */

/**
 * Funding-pool structs (spec 103) — verified on-chain by FundingPool.sol (the four actor twins, under
 * the per-clone `fundingPool` domain) and FundingPoolFactory.sol (`CreateFundingPool`, under the
 * `fundingPoolFactory` domain).
 *
 * WHY THEY ARE NOT IN `INTENT_TYPES`
 * `INTENT_TYPES` is gated to be exactly the set of structs the relayed action table can sign, and the
 * relay gateway does not serve funding-pool actions in this release (specs/103 research R8): the
 * frontend self-submits (or uses the passkey `sendCalls` rail). A struct in `INTENT_TYPES` with no
 * action would fail the "unreachable struct" gate, and an action with no gateway implementation would
 * fail the gateway's coverage gate — both correctly. So, like `OPEN_ACCEPT_TYPES`, they live in their
 * own table and still join `CONTRACT_VERIFIED_TYPES`, which is what ties them byte-for-byte to the
 * contracts. Promoting them to relayable actions later means moving them into `INTENT_TYPES` and
 * adding the `INTENT_ACTIONS` rows + gateway wiring in the same change.
 *
 * Struct names are unique on purpose: the parity gate rejects a NAME reused with a different string,
 * and the wager-pool `Cancel` / `Refund` structs carry different field names.
 * `purposeHash` = keccak256(bytes(purpose)).
 */
export const FUNDING_POOL_TYPES = {
  CloseFundingPool: [
    { name: 'organizer', type: 'address' },
    ...TRAILING,
  ],
  CancelFundingPool: [
    { name: 'organizer', type: 'address' },
    ...TRAILING,
  ],
  VoteRefund: [
    { name: 'contributor', type: 'address' },
    ...TRAILING,
  ],
  ClaimRefund: [
    { name: 'contributor', type: 'address' },
    ...TRAILING,
  ],
  CreateFundingPool: [
    { name: 'organizer', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'goal', type: 'uint256' },
    { name: 'purposeHash', type: 'bytes32' },
    { name: 'contributeDeadline', type: 'uint64' },
    { name: 'settleDeadline', type: 'uint64' },
    ...TRAILING,
  ],
}

export const CONTRACT_VERIFIED_TYPES = { ...INTENT_TYPES, ...OPEN_ACCEPT_TYPES, ...FUNDING_POOL_TYPES }

/**
 * EIP-3009 — the TOKEN-side legs. Both are structurally identical and differ only in who may
 * submit them, which is the whole reason there are two:
 *
 *   · `ReceiveWithAuthorization` — the token enforces `to == msg.sender`, so ONLY the recipient
 *     contract can submit it. This is the money leg of every gasless payment intent
 *     (`joinWithAuthorization`, stake pulls): the escrow is both caller and recipient.
 *   · `TransferWithAuthorization` — ANY address may submit it, moving `from → to`. This is the
 *     wallet-to-wallet Pay & Transfer leg, where the relayer is not the recipient.
 *
 * NOTE the asymmetry with everything above: these typehashes' authority lives in the DEPLOYED USDC
 * contract, not in this repository. The only in-repo Solidity copy is
 * contracts/mocks/MockUSDCPermit.sol — a MOCK. So they are verified against recorded fixed vectors
 * rather than against a contract constant; asserting them against the mock would prove nothing.
 *
 * Getting these wrong is a money-path failure with two different faces: a wrong shape simply fails
 * to verify, but confusing the two names produces an authorization with the WRONG submitter rule.
 */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

/**
 * Render an EIP-712 type string for `primaryType`, e.g.
 *   `InvalidateNonce(address signer,bytes32 nonce,uint256 validBefore)`
 * (`InvalidateNonce`, not `InvalidateNonceIntent` — the primary type is the key in INTENT_TYPES and
 * is what the contract's typehash literal spells; the trailing `Intent` most siblings carry is part
 * of their name, not a suffix this function adds.)
 *
 * keccak256 of this string is the struct's typehash, which is what the Solidity side stores as a
 * `*_TYPEHASH` constant. That equality is the machine check that replaces the convention.
 *
 * Only flat structs are supported, which is all this repo uses — every intent is a single level
 * with value-type fields. A nested custom type would need its referenced types appended in
 * alphabetical order per EIP-712; throw rather than emit a subtly wrong string.
 */
export function typeStringFor(primaryType, types = INTENT_TYPES) {
  const fields = types[primaryType]
  if (!fields) throw new Error(`Unknown intent primaryType: ${primaryType}`)
  for (const f of fields) {
    if (/^[A-Z]/.test(f.type.replace(/\[\]$/, ''))) {
      throw new Error(
        `typeStringFor does not support nested custom types (${primaryType}.${f.name}: ${f.type}). ` +
          'EIP-712 requires referenced types appended in alphabetical order; add that support ' +
          'deliberately rather than emitting a subtly wrong string.',
      )
    }
  }
  return `${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`
}

/**
 * Gateway `action` -> typed-data + routing metadata. Pure data, so it lives here alongside the
 * structs it references (spec 075): both the client that SIGNS and the gateway that VERIFIES
 * derive their action set from this one table, which is what makes a missing action a test
 * failure instead of a runtime "unknown action".
 *
 * Original contract:
 *   primaryType  — key into INTENT_TYPES
 *   verifier     — which FairWins EIP-712 domain verifies the intent ('wagerRegistry' | 'membershipManager';
 *                  null = both contracts expose it, caller picks via signIntent's `verifier` option)
 *   intentClass  — gateway Intent class ('payment' carries an EIP-3009 authorization; else 'signer-attributed')
 *   actorField   — struct field that MUST equal the recovered signer (auto-filled by signIntent)
 */
export const INTENT_ACTIONS = {
  createWager: { primaryType: 'CreateWagerIntent', verifier: 'wagerRegistry', intentClass: 'payment', actorField: 'creator' },
  acceptWager: { primaryType: 'AcceptWagerIntent', verifier: 'wagerRegistry', intentClass: 'payment', actorField: 'taker' },
  // Open-challenge accept: same AcceptWagerIntent, plus the separate claim-code proof signature
  // (rebound to taker = signer) carried in params by the call site (schema §"Open-challenge accept").
  acceptOpenWager: { primaryType: 'AcceptWagerIntent', verifier: 'wagerRegistry', intentClass: 'payment', actorField: 'taker' },
  claimPayout: { primaryType: 'ClaimPayoutIntent', verifier: 'wagerRegistry', intentClass: 'signer-attributed', actorField: 'claimant' },
  claimRefund: { primaryType: 'ClaimRefundIntent', verifier: 'wagerRegistry', intentClass: 'signer-attributed', actorField: 'actor' },
  declareDraw: { primaryType: 'DeclareDrawIntent', verifier: 'wagerRegistry', intentClass: 'signer-attributed', actorField: 'actor' },
  revokeDraw: { primaryType: 'RevokeDrawIntent', verifier: 'wagerRegistry', intentClass: 'signer-attributed', actorField: 'actor' },
  cancelOpen: { primaryType: 'CancelOpenIntent', verifier: 'wagerRegistry', intentClass: 'signer-attributed', actorField: 'actor' },
  declineWager: { primaryType: 'DeclineIntent', verifier: 'wagerRegistry', intentClass: 'signer-attributed', actorField: 'actor' },
  declareWinner: { primaryType: 'DeclareWinnerIntent', verifier: 'wagerRegistry', intentClass: 'signer-attributed', actorField: 'actor' },
  purchaseTier: { primaryType: 'PurchaseTierIntent', verifier: 'membershipManager', intentClass: 'payment', actorField: 'member' },
  upgradeTier: { primaryType: 'UpgradeTierIntent', verifier: 'membershipManager', intentClass: 'payment', actorField: 'member' },
  extendMembership: { primaryType: 'ExtendMembershipIntent', verifier: 'membershipManager', intentClass: 'payment', actorField: 'member' },
  redeemVoucher: { primaryType: 'RedeemVoucherIntent', verifier: 'membershipManager', intentClass: 'signer-attributed', actorField: 'redeemer' },
  invalidateNonce: { primaryType: 'InvalidateNonce', verifier: null, intentClass: 'signer-attributed', actorField: 'signer' },

  // ---- Tier-2 group pools (spec 035/036, factory-forwarder) ----
  // `verifier` = the getContractAddressForChain KEY that resolves the intent TARGET (the factory, whose
  //   forwarder the relayer calls — the only whitelisted pool address). `domainVerifier` = the EIP-712
  //   domain the signature is verified under; `verifyingContractParam` names the param holding the
  //   verifyingContract (the CLONE) — the domain/target SPLIT. The six actor twins sign under the clone;
  //   createPool signs under the factory. `authOnly` (poolJoin) = no intent struct, the EIP-3009
  //   authorization is the whole intent; `authToParam` binds the money to the clone, not the factory.
  poolCloseJoining: { primaryType: 'CloseJoining', verifier: 'wagerPoolFactory', domainVerifier: 'wagerPool', verifyingContractParam: 'pool', intentClass: 'signer-attributed', actorField: 'creator' },
  poolCancel: { primaryType: 'Cancel', verifier: 'wagerPoolFactory', domainVerifier: 'wagerPool', verifyingContractParam: 'pool', intentClass: 'signer-attributed', actorField: 'creator' },
  poolRefund: { primaryType: 'Refund', verifier: 'wagerPoolFactory', domainVerifier: 'wagerPool', verifyingContractParam: 'pool', intentClass: 'signer-attributed', actorField: 'member' },
  poolApprove: { primaryType: 'ApproveOutcome', verifier: 'wagerPoolFactory', domainVerifier: 'wagerPool', verifyingContractParam: 'pool', intentClass: 'signer-attributed', actorField: 'member' },
  poolProposeOutcome: { primaryType: 'ProposeOutcome', verifier: 'wagerPoolFactory', domainVerifier: 'wagerPool', verifyingContractParam: 'pool', intentClass: 'signer-attributed', actorField: 'creator' },
  poolClaim: { primaryType: 'ClaimShare', verifier: 'wagerPoolFactory', domainVerifier: 'wagerPool', verifyingContractParam: 'pool', intentClass: 'signer-attributed', actorField: 'winner' },
  poolCreate: { primaryType: 'CreatePool', verifier: 'wagerPoolFactory', domainVerifier: 'wagerPoolFactory', intentClass: 'signer-attributed', actorField: 'creator' },
  poolJoin: { verifier: 'wagerPoolFactory', intentClass: 'payment', authOnly: true, authToParam: 'pool' },

  // ---- Callsign registry (spec 054) — target + domain both the registry; owner == recovered signer.
  //      register/change/requestRepoint execute only while the signer holds Gold+ (else revert on-chain);
  //      the gateway SHOULD pre-screen tier. requestRepoint is itself tier-exempt on-chain (recovery safety).
  callsignCommit: { primaryType: 'CommitCallsignIntent', verifier: 'callsignRegistry', domainVerifier: 'callsignRegistry', intentClass: 'signer-attributed', actorField: 'owner' },
  callsignRegister: { primaryType: 'RegisterCallsignIntent', verifier: 'callsignRegistry', domainVerifier: 'callsignRegistry', intentClass: 'signer-attributed', actorField: 'owner' },
  callsignChange: { primaryType: 'ChangeCallsignIntent', verifier: 'callsignRegistry', domainVerifier: 'callsignRegistry', intentClass: 'signer-attributed', actorField: 'owner' },
  callsignRelease: { primaryType: 'ReleaseCallsignIntent', verifier: 'callsignRegistry', domainVerifier: 'callsignRegistry', intentClass: 'signer-attributed', actorField: 'owner' },
  callsignRequestRepoint: { primaryType: 'RequestRepointIntent', verifier: 'callsignRegistry', domainVerifier: 'callsignRegistry', intentClass: 'signer-attributed', actorField: 'owner' },
  callsignCancelRepoint: { primaryType: 'CancelRepointIntent', verifier: 'callsignRegistry', domainVerifier: 'callsignRegistry', intentClass: 'signer-attributed', actorField: 'owner' },
}
