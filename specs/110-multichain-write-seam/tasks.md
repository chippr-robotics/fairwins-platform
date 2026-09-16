# Tasks: Seamless multichain UX — chain-abstracted writes on a single EVM seam

**Input**: Design documents from `/specs/110-multichain-write-seam/` (spec.md, plan.md) + measured
research in issue #1552.

**Organization**: Grouped by delivery phase; each phase is a sub-issue of #1552 and merges as its
own PR (or small PR series) with `Closes #<sub-issue>` in the body. `[P]` = parallelizable within
its phase. Counts marked *(re-measure)* are re-taken at phase start — they drift.

## Phase 0 — Free wins and the ratchet (#1591)

- [x] T001 Re-measure the ethers import inventory over `frontend/src` (non-test): pure-util-only /
      read-path / signer-touching classes; record the file lists in the PR (192 at plan time).
- [x] T002 Add ESLint `no-restricted-imports` for `ethers` scoped to `frontend/src`, allowlist
      seeded at the T001 inventory. The allowlist only ever shrinks; shrinking it is part of every
      later phase's definition of done.
- [x] T003 [P] Codemod the pure-util-only files (67 measured at phase start; the issue estimated 43) to viem equivalents (`formatUnits`,
      `parseUnits`, `getAddress`, `isAddress`, `keccak256`, `zeroAddress`, …); shrink the
      allowlist by the same set. Full suite, not scoped runs (spec 075 stale-import caveat).
- [x] T004 [P] Add `viem` to `HOST_SHARED_MODULES` in `frontend/src/lib/miniapps/manifest.js` —
      additive, minor `hostApi` bump; update `specs/073-miniapp-platform/contracts/host-context.md`.
- [x] T005 Gates: `npm run check:deps`, byte gates, full frontend suite; `deps:reinstall` only.

## Phase 1 — The read seam (#1592)

- [x] T010 Pin current provider semantics with tests before converting: spec-069 endpoint
      precedence, header credential attachment, failover behavior, `useEndpointsRevision`
      reactivity (extend `src/test/network/` as needed). — `src/test/chains/publicClient.test.js`
      runs against the REAL endpoint store and real viem transports, beside the surviving ethers
      twin, so both seams are pinned to the same spec-069 rules while they coexist.
- [x] T011 Build `frontend/src/lib/chains/readContract.js`:
      `readContract(chainId, { address, abi, functionName, args })` on a viem `PublicClient` per
      chain, member-endpoint resolution via the one seam, `fallback` transport at quorum-1
      semantics, stable client identity per chain (mini-app `readProvider` caching precedent).
      Also `lib/chains/eventScan.js`, the viem twin of a contract for `lib/chain/logScan`'s duck
      contract, so a scanning caller converts in one line. The seam additionally RESTORES the
      parameter names viem drops on multi-output results — see the note under T012.
- [x] T012 Convert the read-path files (~80, *(re-measure)*) onto `readContract`; delete the
      ethers `_lastFatalError` workaround in `frontend/src/utils/rpcProvider.js` rather than
      porting it. Shrink the allowlist per file converted. **DONE at allowlist 134 → 70, verified
      green on b87bcf18 (50/50: 4 on-chain shards, 12 fast legs across both viewport profiles,
      passkey full stack, unit/lint/build).** The one read-path entry left is T012a below, which is
      blocked on config rather than code. Of the remaining 67, most are the write/signer surface
      (Phase 2), and five are a decision rather than pending work — `lib/pools/bip39Lists.js`, the
      MULTI-LANGUAGE BIP-39 registry (ethers bundles ten wordlists, viem exports only English, so
      converting it would silently drop nine languages and break spec 034 SC-008),
      `miniapps/hostScope.js` (ethers is part of the spec-073 host API, so Phase 5), and
      `utils/rpcProvider.js` itself, which leaves last with its final caller. The allowlist
      header says so too, so the list explains itself.

      A CORRECTION WORTH KEEPING. This entry previously retired all THREE BIP-39 files on the
      grounds that "viem bundles none, so moving them is a lockfile change and therefore the
      spec-075 rolldown hazard". That was wrong: `viem/accounts` exports `english`, identical to
      ethers' `en` word for word (2048 entries, same order — compared rather than assumed, because
      a claim code is derived from word INDICES and a list differing anywhere would change every
      code generated afterwards and invalidate every one already issued, with nothing failing at
      the time). No lockfile change was ever needed and no rolldown hazard applied. Two of the
      three used `wordlists.en` ONLY and are converted; only the multi-language registry is
      genuinely stuck, for a different reason than the one written down. A wrong reason on an
      exemption list is worse than an open task — an open task gets picked up, a wrong reason
      retires the work permanently.

      TWO DECODER DIFFERENCES BIT DURING THIS AND ARE WORTH KNOWING BEFORE CONVERTING MORE.
      (a) viem returns a BARE ARRAY for a function with several named outputs where ethers
      returned a Result addressable both ways, so `raw.token0` became `undefined` — not an error,
      a field that quietly is not there. A caller read it, judged the record unreadable, and
      rendered an EMPTY position list, which a member reads as "you have none". Every unit fake
      returns ethers-shaped objects, so no unit suite could see it; the on-chain tier did. It is
      fixed once in the seam rather than per call site. (b) For integers of 48 bits or fewer viem
      returns a NUMBER where ethers returned a bigint. Both classes were audited across every
      converted file. (c) `isAddress` — the first divergence about a VALIDATOR rather than a
      decoder, and the only one where the obvious one-word fix is the unsafe direction. ethers
      verifies a checksum only when the string CARRIES one, i.e. when it is mixed case; viem's
      default `strict: true` additionally REFUSES a valid ALL-UPPERCASE address, and
      `{ strict: false }` — the tempting "be permissive" fix — ACCEPTS a mistyped mixed-case one,
      which is precisely what EIP-55 exists to catch, and silently, because viem's `getAddress`
      (unlike ethers') does not throw on a bad checksum either. Both halves now come from
      `lib/evm/address.js`, whose differential test asserts against BOTH viem settings so the seam
      fails loudly if a future viem release makes it redundant. It was found by a safety-invariant
      test in `venues/gmx.js` that deliberately case-shifts the FairWins address to prove the
      receiver guard refuses it by identity rather than by format — and it had already landed
      unnoticed in three earlier conversions (`venues/gains.js`, `perps/feeUnits.js`,
      `screening/screenEstate.js`), which now take the seam too. (d2) TRANSACTION RECEIPTS: viem
      reports `status: 'success' | 'reverted'` where ethers used `1 | 0`, so the repo-wide idiom
      `Number(receipt.status) === 0` stops seeing reverts entirely (`Number('reverted')` is NaN,
      which compares false). Normalized once in the bridge status handle rather than at each
      reader. (e) THE BLOCK-NUMBER CACHE, and the only one a unit test cannot see from the value:
      viem caches `eth_blockNumber` for `cacheTime` — 4000ms by default, shared across every caller
      of the client — where ethers cached it for 250ms. `scanLogs` records "I have scanned up to
      HEAD", so a head from before the caller's own transaction completes a scan over a range that
      excludes it. It emptied the Protect vault queue for a member who proposed and opened the
      Queue within four seconds, and those surfaces read on mount and do not poll, so it did not
      recover. Every scan head now passes `cacheTime: 0`, and the seam's test asserts on the
      REQUEST — the stale value is a real block number, just the wrong one, so nothing about the
      returned value can distinguish it.

      THE PATTERN ACROSS ALL FIVE: viem and ethers disagree on a DEFAULT, silently, and always in
      the direction of reporting LESS than there is — a missing field, a narrower range, a refused
      address, a revert that reads as a success. None of them throws. Read each conversion for
      what it makes impossible to OBSERVE, not only for what it changes.
- [x] T013 Estate reads (`lib/chains/estate.js`, spec-089 reading constructors) keep three-state
      semantics byte-for-byte — assert no `?? 0` path appears in conversion. `readAuthority` now
      names its chain while `provider` stays the availability gate, because that gate is also
      where the cohort bound lives. Its three answers gained direct coverage they lacked, and the
      UNCONFIRMED one — the answer that is silent when it breaks, since hardening it into a denial
      takes a killswitch from the operator who holds it — is asserted to keep the control offered.
- [ ] T012a `hooks/useOracleConditions.js` is the LAST read-path entry and is deliberately not a
      mechanical port. Three things have to be decided rather than translated. (1) It calls
      `queryFilter(filter, 0, 'latest')` — one unbounded request from GENESIS, which is the exact
      pathology `lib/chain/logScan` exists to prevent and which fails outright against any 10k-range
      cap. Moving it to `scanLogs` fixes that but backfills thousands of chunks from block 0 unless
      the adapter's DEPLOY BLOCK is recorded first (`getDeploymentBlockForChain`), so the conversion
      is blocked on config, not on code. Do not paper over it by keeping a single unbounded
      `getLogs`. (2) It takes NO chainId — it reads on whatever chain the wallet happens to be on,
      through `useWeb3().provider`. An oracle adapter address belongs to a chain, so naming it is a
      real behaviour change for the one caller (`OracleConditionPicker`), not a refactor.
      (3) `contract.on(...)` has no like-for-like viem twin: `watchContractEvent` polls or installs a
      filter depending on the transport, so the live-update leg needs its own decision about cost on
      a sparse, owner-write-only adapter.

      T020 IS ALREADY DE-RISKED, and the reason it names `@noble/curves` rather than viem is not a
      library preference. **viem's `verifyMessage` and `recoverAddress` are ASYNC** where ethers'
      are synchronous, so converting to them would break the spec-084 invariant stated in CLAUDE.md
      — "`verifyMessage` is OFFLINE and SYNCHRONOUS … never make it async: the type is what
      enforces it." The type is the guard against someone later putting a network call inside
      signature arithmetic, and an async signature removes it silently. Three facts checked rather
      than assumed: `@noble/curves` is ALREADY a direct frontend dependency (^2.3.0), so T020 needs
      no lockfile change and the spec-075 rolldown hazard does not apply; noble v2 RENAMED the point
      serializer to `toBytes(false)` (`toRawBytes` is gone, so v1-era guidance reads fine and fails
      at runtime); and a fully synchronous recovery —
      `Signature.fromHex(r+s).addRecoveryBit(v).recoverPublicKey(hash).toBytes(false).slice(1)`,
      keccak256, last 20 bytes — matches `ethers.verifyMessage` on 16/16 cases (4 keys × 4 messages
      including empty, 200-char and unicode) and returns a string, not a Promise.
- [x] T014 Gates: full suite + both e2e tiers green; allowlist reflects every converted file.
      **Met on b87bcf18** — 50/50, nothing failing, every Cypress leg of both tiers green. Worth
      recording HOW the two on-chain-only defects were caught, because no amount of local green
      would have: the empty Supply list (multi-output names) and the empty Protect queue (the
      cached scan head) each passed all ~9,100 unit tests, because every unit fake returns
      ethers-shaped objects and so answers a question the chain no longer answers. Both were found
      by a red on-chain shard and localized by bisecting against the last head that was green
      there. Budget for that in Phase 2: a local sweep is a precondition for pushing, never
      evidence that a conversion is correct.

## Phase 2 — The write seam (#1593) 🎯 the chain abstraction

**Capabilities first (each testable in isolation):**

- [x] T020 [P] Sync `verifyMessage`/`recoverAddress` on `@noble/curves` in
      `frontend/src/lib/verify/` — signature stays synchronous, takes no client; spec 084 fixture
      suite (`src/test/fixtures/signedMessages.js`) passes unchanged. **Done**, and it turned up
      the SEVENTH divergence — the first that fails toward a confident WRONG answer rather than
      toward reporting less. ethers' encoder REFUSED a malformed `bytes` value (`0x123`, `0xZZ`,
      even `nothex`); viem's `encodeFunctionData` accepts all three and encodes something. In
      `checkErc1271` that meant garbage would be put to the contract and whatever it answered
      reported as a verdict on the member's signature — the existing test caught it returning
      `valid: true` for `0x123`. The shape check is now explicit rather than inherited from the
      library. Two more: the recovery must also accept the 64-byte EIP-2098 COMPACT form (ethers
      did, viem's `parseSignature` rejects it, and this surface verifies other people's proofs, so
      refusing an encoding turns a good proof into "unverifiable"); and `Buffer` does not exist in
      the browser, so the keccak output goes through viem's `bytesToHex`. Verified against
      `ethers.verifyMessage` on 18 curated cases plus a 300-case fuzz over both encodings —
      identical every time, negatives included. Two regression tests were added for the things no
      value assertion can see: that the function is not a Promise, and that the compact form
      recovers.
- [ ] T021 [P] `lib/hardware/hardwareSigner.js` → viem `toAccount({ address, signMessage,
      signTransaction, signTypedData })`; recover-and-verify-before-broadcast behavior preserved.
- [ ] T022 [P] `lib/recovery/legacyKeys.js`: nonce management re-derived on viem's account
      `nonceManager` — port the reasoning ("a refused transaction never consumed its nonce"), with
      tests proving refusal/re-submit sequences.

      **READ THIS BEFORE TOUCHING THE MNEMONIC PATH.** Derivation itself is safe: `mnemonicToAccount`
      matches `ethers.HDNodeWallet.fromPhrase` on every address checked (three phrases on the default
      `m/44'/60'/0'/0/0`, plus indices 0/1/5), and `privateKeyToAccount` matches `new ethers.Wallet`.
      What is NOT safe is dropping the guard in front of it. This module currently reads
      `if (ethers.Mnemonic.isValidMnemonic(phrase))` before deriving, and that check is doing real
      work: **viem has no mnemonic validator at all, and `mnemonicToAccount` derives happily from an
      INVALID phrase** — a bad BIP-39 checksum, one mistyped word, even `"aaa bbb ccc … lll"`, words
      that are not in the wordlist. ethers threw on all three. So a member who mistypes ONE word of
      their seed phrase would be shown a perfectly valid-looking recovered account at a completely
      different address, holding nothing — which they would read as their money being gone. That is
      the same silent failure spec 104 describes for passkey account lookup, arrived at from the
      other direction, and it is the second divergence in this migration that fails toward a
      CONFIDENT WRONG ANSWER rather than toward reporting less. Keep an explicit checksum check;
      `viem/accounts` exports `english` but no `validateMnemonic`.
- [ ] T023 [P] `lib/chain/revertError.js` → `decodeErrorResult` + `BaseError.walk()`; keep
      `useAdminTx`'s per-call `errorAbi` contract (#1267).

**The seam:**

- [x] T024 Build `frontend/src/lib/chains/submitOn.js`: `submitOn(chainId, payload)` carrying the
      acting identity; rail resolution → passkey (`sendPasskeyBatch({ chainId })`, no switch) |
      intent (target chain's EIP-712 domain, no switch) | signer (the ONE switch-and-settle loop,
      constants decided once, refusal names both chains and signs nothing). **Built with tests; no
      caller yet — T026 moves them.** Two things the build settled that were not obvious from the
      task text. (1) THE CONSTANTS ACTUALLY DISAGREED: the three loops this replaces used 20s/150ms
      in `useActiveAccount` and `useEarnSend` but 30s/250ms in `useVaultDeployment`, so the same
      wallet on the same chain got ten seconds more patience depending on which button was pressed.
      Nothing chose that — it is what a copied loop does. One pair is exported now. (2) THE TESTS
      THAT MATTER ARE NEGATIVE: the passkey and intent rails must never call `switchNetwork`, and
      every refusal must leave the wallet where it was. A value-only assertion passes just as
      happily on a seam that prompts for a network change it does not need, or that switches and
      then refuses — which is the worse half of a bad refusal, because the member is left somewhere
      they never asked to be. `resolveWriteRail` is injectable so the ROUTING tests do not depend on
      which chains happen to carry a deployed bundler (that is the estate, not this seam); one test
      deliberately uses the real resolver so the two stay wired together.
- [x] T025 Generalize `lib/custody/writeRail.js#resolveWriteRail` out of custody; add
      reachability verification so availability is stated before the tap, never discovered at
      submit (`requireWriteRail` throwing form kept for callbacks).
      **Done — now `lib/chains/writeRail.js`** (old module DELETED, not shimmed: a re-export would
      have left `vi.mock('../../lib/custody/writeRail')` in `useVaultDeployment.test.jsx` pointing
      at a module the hook no longer imports, which is the retired-mock trap — a mock that goes on
      looking like protection while protecting nothing). Reachability answers three ways —
      `unchecked` / `reachable` / `unreachable` — and `walletChainId`/`canSwitchChain` are
      OPTIONAL: a caller that omits them gets `unchecked`, never `reachable`, because a gate that
      reports "verified" from an absence of evidence is worse than no gate. Every pre-T025 caller
      is byte-compatible. One answer DID change: a chainId absent from `NETWORKS` is now refused on
      every rail including the signer rail — there is no network definition to hand the wallet and
      no RPC behind it, so `available: true` there was a confident wrong answer.
- [x] T026 Replace `submitAsActiveAccount`'s chain-blind personal branch with the seam (vault
      branch keeps spec-102 tap-time switching semantics through the same loop); retire the three
      settle-loop copies in `hooks/useEarnSend.js`, `hooks/useActiveAccount.js`,
      `hooks/useVaultDeployment.js`.
      **Done.** The shared loop is `settleWalletOn` — exported from `submitOn.js` rather than
      folded into it, because a vault deployment settles ONCE and then sends a deploy plus N rule
      installs off the same signer; those hooks need the loop, not the whole seam. Two facts fell
      out of unifying it: (a) the three copies had drifted to different patience (20s/150ms twice,
      30s/250ms once) so the same wallet on the same chain got ten extra seconds depending on which
      button was pressed — now one pair, and `useVaultDeployment` is the one that changed; (b) the
      only thing that genuinely differed between the three refusals was the NOUN, so `subject` is
      the one thing still passed in. `useEarnSend`'s retired wording ("Could not switch to Ethereum
      — approve the network change and try again") named neither the chain the wallet was on nor
      that nothing had been signed; two tests were updated to assert those PROPERTIES rather than
      the old phrasing.
      The personal-branch guard is the other half and it is the one that moves the member's own
      money: `ctx.chainId` in, and the SAME wrong-chain refusal the vault branch has had since 043.
      It bites hardest on spec-088's acting signer, which the ceremony binds to the wallet's CURRENT
      chain and deliberately does not switch — a surface asking for Base while the wallet sat on
      Polygon got a Polygon transaction and a success. `ctx.chainId` is OPTIONAL and omitting it
      leaves the send unguarded exactly as before: a soft gate, closed by T028. A signer with no
      provider to ask is the ABSENCE of a check, never a passed one, and a test asserts that.
- [x] T027 `lib/relay/useGaslessWrite.js` stops resolving signer/domain/verifier from the ambient
      chain — target chain in, domain out; no wallet switch on the intent rail.
      **Done.** `cfg.chainId` drives all three things that used to come from wherever the wallet
      happened to be: the EIP-712 domain, the verifier lookup, and which relayer is probed. The
      domain is the one that matters — a correctly-typed intent under the WRONG domain is not an
      error, it is a valid signature over something nobody will honour (issue #1038 by another
      route), and no assertion about the params can see it. Optional, so all 31 call sites are
      byte-compatible; T028 closes them.
      The intent rail prompts for nothing: the signature names its own chain. The SELF-SUBMIT
      fallback does need the wallet there, so when a target chain was named it settles first
      (shared T026 loop) and refuses naming both chains rather than broadcasting on the wrong one.
      The wrapper is applied ONLY when a chain was named AND `selfSubmit` is a function — wrapping
      a missing one would hand `useIntentAction` a function and silence its never-stranded
      wiring-time guard.
      **Owed to T029, and not to be restated as settled:** some injected wallets validate a
      typed-data domain's chainId against their own selected chain and refuse a mismatch. Where
      that happens it lands as a signature failure and falls through to the settling self-submit,
      so nothing signs on the wrong chain either way — but "no prompt on the intent rail" is proven
      for the app-held rails and ASSUMED for injected ones.
- [ ] T028 Convert the signer-touching files (~65, *(re-measure)*) onto `submitOn`; empty the
      ethers allowlist for shipped `frontend/src` paths. **In progress — allowlist 67 -> 58.**
      - `src/utils/encryption.js` — **DELETED, not converted.** No importers anywhere in the repo,
        and the cryptographic BOM already carried it as risk R7 ("attack surface with no owner").
        It also could not have RUN: it imported `recoverPublicKey` from `ethers`, which **ethers v6
        does not export** (the v6 spelling is the `SigningKey.recoverPublicKey` static), so
        `derivePublicKeyFromSignature` and both exported functions that call it would have thrown
        `TypeError` on first use — presumably since the v5->v6 migration. Converting it would have
        made dead, unrunnable code look maintained. R7 is closed in
        `docs/architecture/workbook/05-cryptographic-bom.md`. `tweetnacl`/`tweetnacl-util` are now
        unused but deliberately LEFT DECLARED: dropping them re-resolves the root lockfile, which
        is the npm/cli#4828 rolldown-binary hazard (spec 075). Do it in a dependencies-only change.
      - `src/lib/apiAccess/apiKeys.js` — `hexlify(randomBytes(32))` -> `toHex(crypto.getRandomValues(
        new Uint8Array(32)))`, `getAddress` from `lib/evm/address`. The refusal moved: the shape
        regex passed a mistyped mixed-case address and it was `ethers.getAddress` that threw a line
        later, where viem's just re-checksums. `isAddress` from the seam now refuses it cleanly.
        Verified non-vacuous by reverting the guard and watching the test fail.
      - `src/lib/backup/backupRegistry.js` — onto `readContract` + `encodeFunctionData`, and it
        turned up the **NINTH divergence, the third that fails toward a confident WRONG answer**:
        **viem's `encodeFunctionData` STRINGIFIES a non-string argument for a `string` parameter**
        where ethers' `Interface` refused it. Not just `bytes` (divergence 7) — `string` too, and
        the conversions are silent: `null` encodes as the four-character CID `"null"`, `undefined`
        and `{}` as `""` and `"[object Object]"`. On THIS contract `""` is the documented CLEAR
        value, so a stray `undefined` erases the member's backup locator, and `"null"` leaves a
        pointer that resolves to nothing while reading, on every surface, as a backup that exists.
        `requireCid` restores the refusal. The module had NO direct test — every suite mocked it
        whole — so `src/test/backup/backupRegistry.test.js` is new and keeps an ethers `Interface`
        as a live cross-library byte check over the exact encoder that was replaced.
      - `src/lib/custody/proposalHub.js` — its header said it "leaves the ratchet when the write
        rail does, not before", and that turned out to be untrue: `emitProposal`/`cancelProposal`
        used an ethers `Contract` carrying a SECOND, hand-maintained copy of the propose/cancel
        argument list, while pure viem twins (`emitProposalCall`/`cancelProposalCall`) already
        built the same calldata a few lines below. The broadcasts now send the twins' own bytes —
        one encoder, one argument order, instead of two that could drift — so the file comes off
        ethers today with no write-rail dependency at all. Calldata verified byte-identical to the
        ethers `Interface` across the value/data/nonce extremes.
        `toBeHex` is REIMPLEMENTED rather than swapped for viem's `toHex`, because
        `encodePayloadLink` is a WIRE FORMAT handed to another person's device and the two are not
        the same function: ethers pads to whole bytes (`0n`->`0x00`, `15n`->`0x0f`,
        `256n`->`0x0100`), viem emits minimal nibbles (`0x0`, `0xf`, `0x100`). Every form
        round-trips through `BigInt()` so nothing would have broken — but a link is a string other
        code may compare or key on, and three lines is cheaper than being sure nothing does. Both
        new assertions were verified non-vacuous by reverting the code and watching them fail.
      - `src/lib/pools/gasless.js` (EIP-3009 MONEY path) — and it produced the **TENTH divergence,
        which is two faults in one function**: `ethers.Signature.from` has no correct viem
        replacement, because `parseSignature` (1) REFUSES the 64-byte EIP-2098 compact form ethers
        accepted, and (2) returns `v` as a **BIGINT** where ethers returned a NUMBER. The second one
        breaks this call site outright: the `v` rides into the authorization object handed to a
        third-party relayer, and `JSON.stringify` throws on a bigint — loud rather than silent, but
        "it will throw somewhere" is not a migration plan.
        So the split now lives once, in **`src/lib/evm/signature.js`**, and `lib/verify/verifyMessage.js`
        consumes it instead of keeping the private copy T020 wrote (two implementations of signature
        splitting is the exact duplication this migration exists to remove). Checked against
        `ethers.Signature.from` over 200 real typed-data signatures in BOTH encodings — 400
        comparisons, r/s/v identical every time — before the swap, and `src/test/evm/signature.test.js`
        keeps ethers as the live oracle over the function that was replaced.
      - `src/lib/transfer/eip3009Transfer.js` and `src/lib/relay/intentClient.js` — the same two
        primitives (`hexlify(randomBytes(32))`, `Signature.from`) on the same money path, now on
        the shared seam. Both files' suites already reassembled the parts with ethers and verified
        recovery, which is a real cross-library check — but a recovery check CANNOT see divergence
        10, because `ethers.Signature.from` accepts a bigint `v` perfectly happily. Both suites now
        also assert `typeof v === 'number'` and that the authorization serializes.
      - `src/lib/passkey/intentSigner.js` — the ERC-1271 envelope and the intent digest. Tuple
        encoding is byte-identical to `AbiCoder.defaultAbiCoder()` (empty / unicode / 300-byte /
        max-uint256 cases, and viem accepts a JS number for a `uint256` exactly as ethers did), but
        typed data is NOT: **`ethers.TypedDataEncoder.hash` INFERS the primary type and viem's
        `hashTypedData` demands one** (divergence 11). `Object.keys(types)[0]` is the tempting fix
        and it is wrong for a NESTED table, where the first key can be a SUB-type — viem will hash
        against it whenever the message shape allows, producing a valid signature over the wrong
        structure, which nothing downstream can detect. So ethers' own rule (the type no other type
        references) is written out in **`src/lib/evm/typedData.js#primaryTypeOf`**, checked against
        `TypedDataEncoder.from(...).primaryType` over all 27 real intent tables plus nested,
        array-of-sub-type, two-level and declaration-order-reversed shapes. An ambiguous table
        returns null and `hashTypedDataLike` throws — ethers refused too, and nothing guesses.
        ONE deliberate difference is recorded in the module: a table carrying its own
        `EIP712Domain` entry made ethers throw, and this answers normally.
        Divergence 11b: **ethers' `hashMessage` accepted raw bytes, viem's refuses a bare
        `Uint8Array`** (it wants `{ raw }`) — loud, but this adapter advertises ethers-signer
        compatibility, so both forms are accepted. `src/test/passkey/intentSignerEncoding.test.js`
        is new: these bytes are only verified on chain (`SignerIntentBase.erc1271`) and by the
        gateway, neither of which runs in this tier, so a drift would have left the frontend suite
        green and surfaced as a rejected signature in production.
        **For T021:** `lib/hardware/hardwareSigner.js:63` does the same
        `TypedDataEncoder.from(cleanTypes).primaryType` — use `primaryTypeOf`, do not re-roll it.
      - `src/components/admin/useAdminTx.js` + **`src/lib/evm/revertParser.js`** (new) — this is the
        T023 shape, arrived at from the caller side as planned. `lib/chain/revertError.js` is
        UNTOUCHED: it still imports nothing and still takes any object with
        `parseError(data) => {name, args}|null`, and `errorParser(abi)` is that object built on
        viem. Named errors and BOTH builtins (`Error(string)`, `Panic(uint256)`) decode identically
        to `new Interface(abi).parseError`, the builtins even when the ABI does not declare them.
        **Divergence 12 — two shape differences, normalised in the adapter rather than left to
        callers**: on an UNKNOWN selector ethers returned `null` and viem THROWS; for a
        no-argument error ethers gave `[]` and viem gives `undefined`. Both happen to work today —
        through `extractRevert`'s catch and `describeRevert`'s `?? []` respectively — which is
        exactly the problem: they work by accident, and stop working for the first caller that
        trusts the declared signature.
        Three callers still construct an ethers `Interface` for this (`MiniAppReviewTab`,
        `CallsignPanel`, `SubmitAppPanel`); each also does other ethers work, so they convert with
        their own file.
- [ ] T029 E2E per spec 094: on-chain coverage for cross-chain claim and intent-without-switch;
      no-chain coverage for refused-switch disclosure and before-tap rail unavailability. Flip the
      four `110-multichain-write-seam` matrix rows as each lands.

## Phase 3 — Ambient-chain ban (#1594)

- [ ] T030 Lint ban on `useChainId()` (wagmi) in `frontend/src`; wallet location reads
      `useAccount().chainId`; target chains come from actions. 27 call sites *(re-measure)* → 0.
- [ ] T031 Delete `hooks/useWalletChainId.js`; honest rendering for a wallet on a chain absent
      from the build (acceptance scenario 7) with a test.

## Phase 4 — Surfaces name their target (#1595)

- [ ] T040 Estate-wide wager/pool reads for action-bearing surfaces (`createEstateLedger` shape):
      `FriendMarketsContext` / `fetchFriendMarketsForUser` gain per-chain three-state readings;
      Claim/Refund/Resolve carry their wager's chain.
- [ ] T041 Retire the 26 `switchNetwork`/`switchChain` call sites across 14 member components
      *(re-measure)* — each becomes a declared target through `submitOn` or is deleted; no member
      surface renders a "Switch to <network>" control (operator console exempt, spec 071).
- [ ] T042 E2E: acceptance scenarios 1, 2, 6, 7 across the tiers; a11y scans on changed surfaces.

## Phase 5 — Packages, then services (#1596)

- [ ] T050 Migrate 3 first-party packages (21 files) to the viem host module; rebuild; re-record
      digests (`scripts/miniapps/record-build-digests.js` — accepted-bytes decision recorded in
      the PR); re-approve at new CIDs on Polygon 137 and Mordor 63 (resolve by slug, never id
      across cohorts).
- [ ] T051 Remove `ethers` from `HOST_SHARED_MODULES` + `host.readProvider` hands a viem-shaped
      client — hostApi 3 major; update `specs/073-miniapp-platform/contracts/host-context.md`.
- [ ] T052 Migrate `services/relay-gateway` (11 files) and `services/finops-exporter` (6) — or
      record the decision to keep them on ethers deliberately.
- [ ] T053 Final commit: remove `ethers` from root `overrides` and every `package.json`;
      `deps:reinstall`; all byte gates + `check:deps` green.

## Cross-phase invariants (checked in every phase's PR)

- `npm run deps:reinstall`, never `npm install` (npm/cli#4828).
- Full suite / real build for validation — scoped vitest runs cannot see stale imports.
- Ratchet allowlist shrinks monotonically; a PR that grows it is wrong by construction.
- Money-path changes carry on-chain e2e per spec 094; matrix rows move with the work.
- Writes stay single-chain atomic; operator console untouched; non-EVM ids refused at the seam.
