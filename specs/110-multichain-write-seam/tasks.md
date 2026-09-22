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
- [x] T021 [P] `lib/hardware/hardwareSigner.js` → viem `toAccount({ address, signMessage,
      signTransaction, signTypedData })`; recover-and-verify-before-broadcast behavior preserved.
- [x] T022 [P] `lib/recovery/legacyKeys.js`: nonce management re-derived on viem's account
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
- [x] T026b **`WalletContext.sendCalls` silently ignored a named chain on the classic rail.** Its
      own comment stated it as intended — "Classic wallets ignore it: an injected signer is bound
      to whatever chain the wallet is on" — but the consequence is not that the option does
      nothing: a caller naming a chain got its batch broadcast on a DIFFERENT one, with no prompt
      and no error. Same defect T026 closed in `submitAsActiveAccount`'s personal branch, still
      live in the function every money-moving surface routes through (transfer, vouchers, wagers,
      tokens, swap, DAO, custody). It now REFUSES with both chains named.
      Bounded on purpose: **nothing passes `chainId` on the classic path today** — the two callers
      that pass it (`useVaultDeployment`, `useWrapNative`) are on the passkey rail — so this costs
      nothing now and converts a silent wrong-chain send into a stated refusal later. It refuses
      rather than SWITCHING because `sendCalls` is the submission primitive and `settleWalletOn` is
      the chain-landing primitive; composing them is the caller's job, which `useEarnSend` and
      `useWrapNative` already do. Switching from in here would inject a wallet prompt into a path
      that has never prompted.
      The function had **no test of its own** — the app's unified write abstraction was unexercised
      at its own boundary. `src/test/wallet/sendCallsChain.test.jsx` is the first, and it pins the
      case that must NOT change (no `chainId` still sends) alongside the new refusal.
      **Still open here, and the reason `submitOn` has no production caller yet:** `sendCalls`
      branches on `loginMethod === 'passkey'`, which `lib/chains/writeRail.js` documents as the one
      thing no feature may do. Today that is near-equivalent (a passkey session holds no browser
      signer) and `smartAccount.js#requirePasskeySupport` already refuses an unsupported chain at
      the boundary, so the gap is the QUALITY of the refusal, not what succeeds:
      `ChainNotSupportedError` names the chain by number and not the way out, where
      `resolveWriteRail` names both. Routing `sendCalls` through `submitOn` is the real T028
      endgame and wants on-chain verification, not a late-session push.
- [x] T026a **There was a FOURTH settle loop, and it was the best of the four.** T026's task text
      named three hooks, so `hooks/useWrapNative.js` (spec 108) was not in the sweep — and it alone
      verified that the settled signer's OWN provider reports the target chain before letting it
      sign. The three the shared loop was extracted from had never met that race, so the loop
      T026 shipped was the WEAKER one: the wallet context's `chainId` updates from the connector's
      `chainChanged` event while the chain-scoped signer is rebuilt by an async effect a beat
      later, so the snapshot pairs the NEW chain with the PRE-switch signer — and ethers reports
      `network changed: A => B` **only AFTER broadcasting**, i.e. the member has signed and the
      transaction is already gone. The check is now INSIDE `settleWalletOn`, so the other three
      carry it too, and `useWrapNative` stops maintaining a private copy (four → one).
      A signer with no provider to ask is accepted — the ABSENCE of a check, not a failed one;
      waiting for an answer that can never come would spin to the deadline and refuse a write that
      was fine, which is how the guard would become the bug it prevents. All three new assertions
      were verified non-vacuous by reverting the check.
      **It changed member-facing copy, and I first reported it as a pure deduplication — wrong.**
      Wrap's refusal tail moved from spec 108's "— nothing was sent" to the shared (spec 102)
      "so nothing has been signed". `useWrapNative.test.jsx` stayed green because it asserted a
      LOOSE REGEX (`/Polygon.*Mordor|Mordor.*Polygon/s`) — both chain names still appeared — so the
      change was invisible locally and surfaced as three CI failures: fast `48-wrap-multi-currency`
      at BOTH viewports and on-chain `45-wrap-cross-chain` (shard 1, 53/54 otherwise green, and
      nothing there related to the `sendCalls` change). Resolved by unifying rather than reverting:
      four surfaces had four sentences for one event, none of them chosen, and the shared one is
      spec 102's, already pinned by `useActiveAccount`'s suite. Both Cypress specs now assert the
      shared guarantee, and **the unit test pins the PHRASE, not just the names**, so the next
      wording change fails locally instead of in CI.
      **THE FAST TIER RUNS LOCALLY IN ~90 SECONDS, and nothing said so.** `CLAUDE.md` documents
      only the heavy on-chain repro (`npm run node:e2e`, `npm run setup:e2e`,
      `CYPRESS_NETWORK_ID=80002 …`), so the no-chain tier looked like a CI-only gate. It is not:
      from `frontend/`, `npx start-server-and-test dev:fast http://localhost:5173 "npx cypress run
      --spec cypress/e2e/fast/<spec>.cy.js"` runs it against a real browser with no chain at all
      (verified: 48-wrap-multi-currency, 4/4 in 1m27s). EVERY fast-tier failure this session was
      reproducible that way before pushing. Use it whenever a change touches member-facing copy or
      a surface's behaviour — a unit suite with a loose assertion cannot stand in for it.
      **Method note:** the fourth copy was found by asking who actually CALLS the seam, not by
      searching for the loop. A later sweep confirmed there is no FIFTH: the only remaining
      `SETTLE_TIMEOUT_MS`/`SETTLE_POLL_MS` are `submitOn.js`'s, and every other `Date.now() + …`
      near a `switchNetwork` is a wager deadline, not a chain poll. `settleWalletOn` had four consumers and `submitOn` had NONE outside
      its own test — which is also the honest state of T024 and is now said plainly rather than
      implied.
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
      ethers allowlist for shipped `frontend/src` paths. **In progress — allowlist 67 -> 19.**

      **THE ENDGAME WAS FOUR FILES; READING THEM MADE IT THREE, AND THEN TWO PROBLEMS.**

        `contexts/Web3Context.jsx` is **DELETED, not converted** — the sixth deletion in this
        task and the same shape as the other five. `Web3Provider` is rendered NOWHERE (`main.jsx`
        mounts `WalletProvider` as "the unified blockchain context — single source of truth"),
        `Web3Context.jsx` is imported by nothing, and its context object was imported only by
        itself. `useWeb3()` has always read `WalletContext`. Two reference docs drew it in the
        provider tree marked "legacy — backwards compatibility", beside a `RoleProvider` that is
        also never mounted; both were corrected, because a doc that draws a provider the app does
        not render is worse than one that omits it — a reader trusts it and debugs the wrong
        thing.

        **The remaining three share the duck type but NOT the hard part**, which is what the
        "they move together" framing missed:

          - `contexts/WalletContext.jsx` wraps a wagmi `walletClient` — already viem — in
            `BrowserProvider` + `JsonRpcSigner`. Here the INJECTED WALLET populates the
            transaction (nonce, fees, gas); ethers is a shape, not an engine.
          - `lib/hardware/hardwareSigner.js` extends `AbstractSigner` and
            `lib/recovery/legacyKeys.js` builds `Wallet`/`HDNodeWallet` behind a `NonceManager`.
            Both hold the signing material locally, so nobody else fills those fields: they
            inherit ethers' transaction POPULATION, and converting them means writing a populator
            (nonce, EIP-1559 vs legacy fees, gas limit, chainId) plus `.wait()`. On the hardware
            path that lands where the runbooks deliberately have no automated coverage — device
            confirmations are a staged MANUAL protocol, never faked in CI.

        So the decision, recorded rather than improvised: **an ethers-SHAPED adapter over viem for
        the wallet rail first**, because it is the only split where one commit's blast radius is
        small enough for the on-chain tier to be a real gate. Handing every call site a viem
        `WalletClient` instead would move ~90 sites — `sendTransaction` ×81 alone — in a single
        commit whose first verification is the whole app's write path. The typed-data half of the
        adapter already exists and is already proven: `lib/evm/typedData.js#primaryTypeOf` was
        checked against `TypedDataEncoder.from(types).primaryType` over all 32 real intent tables.
        The two local-key files keep their own task; their populator is not a swap.

      **`lib/chains/walletSigner.js` — the adapter, built and proven, NOT yet wired.** One commit
        for the thing and its differential test; the wiring is its own commit so the on-chain
        tier gates it. Both are driven over the SAME fake EIP-1193 transport, and the assertions
        are about what each puts ON THE WIRE — the RPC sequence and the `eth_sendTransaction`
        fields — because a test that compared returned hashes would pass with the gas estimate
        deleted. Three non-vacuity probes: no estimate (2 tests fail), viem's raw receipt status
        (3 fail), `Object.keys(types)[0]` as the primary type (1 fail).

        **DIVERGENCE 25 — ethers' `JsonRpcSigner.sendTransaction` ESTIMATES GAS and viem does
        not.** Reading `sendUncheckedTransaction` is what made this rail tractable at all: before
        `eth_sendTransaction` ethers does exactly three things — set `from`, resolve `to`, and
        estimate gas when `gasLimit` is absent, with its own comment giving the reason (*"The
        JSON-RPC for eth_sendTransaction uses 90000 gas … otherwise we look it up for them"*). It
        does NOT fill nonce or fees; the wallet does. So the transaction POPULATION that makes
        `hardwareSigner`/`legacyKeys` a different and larger job is, on this rail, one estimate.
        Dropping it changes two things, and the second is the one that matters: a wallet or node
        applying the 90 000 default under-gases every write that needs more, **and a transaction
        that would revert stops failing BEFORE the prompt** — the member is asked to sign,
        approves, pays, and then watches it revert. Every confirm surface here is written against
        the first behaviour. Reproduced in the same place, on the same condition, and pinned by
        the RPC sequence.

        **DIVERGENCE 26 — the two libraries put DIFFERENT JSON on the wire for the same
        signature.** `eth_signTypedData_v4`: ethers serialises `domain.chainId` as the hex STRING
        `"0x89"` where viem sends the JSON NUMBER `137`, and ethers lower-cases an address inside
        the message where viem keeps its checksum case. Neither is forced to match the other, and
        the reason is an assertion rather than an argument: the WALLET computes the digest, both
        spellings denote the same uint256 and the same 20 address bytes, and the test hashes each
        payload AS SENT with ethers' own encoder and shows the EIP-712 hashes are identical. What
        cannot be proven offline is that a wallet parses a JSON number the way it parses a hex
        string — every wallet does, since viem's whole user base signs this way, and imitating
        ethers' spelling would mean hand-rolling the request and losing viem's validation of it.

      **(superseded framing, kept for the trail)** THE ENDGAME IS FOUR FILES AND THEY MOVE TOGETHER, and what is left on the allowlist
      besides them is a recorded decision, not pending work (7 cross-library byte-check test
      files, `rpcProvider` last with its final caller, `hostScope` in Phase 5, and the five
      deferrals with their reasons).

        `contexts/WalletContext.jsx` + `contexts/Web3Context.jsx` CONSTRUCT the ethers
        `BrowserProvider` / `JsonRpcSigner` that every converted write now goes through;
        `lib/recovery/legacyKeys.js` builds `Wallet` / `HDNodeWallet` behind a `NonceManager`, and
        `lib/hardware/hardwareSigner.js` IMPLEMENTS `AbstractSigner`. All four hand out the same
        duck type, so converting any one alone leaves the others producing an object the callers
        no longer understand.

      **The surface that duck type actually owes** — measured across `frontend/src`, not guessed:
      `sendTransaction` ×81, `signMessage` ×19, `getAddress` ×17, `.provider` ×12,
      `signTypedData` ×11, `signTransaction` ×3, `estimateGas` ×1, `connect` ×1, and one
      surviving v5 `_signTypedData`. On the provider side: `getNetwork` ×16, `getCode` ×8,
      `getBalance` ×6, `getFeeData` ×4, `waitForTransaction` ×5, `getTransactionReceipt` ×12.
      That is the contract any replacement has to satisfy, and it is the reason this is a design
      decision rather than a conversion: **either** the contexts start returning a viem
      `WalletClient` and ~15 call sites change with them in one commit, **or** they keep handing
      out an ethers-SHAPED facade backed by viem, which converts the import without converting
      the interface and leaves `tx.wait()` semantics to be reproduced by hand. Neither is a
      mechanical swap, and the second is the one that can look finished while being subtly wrong.

      **Wants on-chain verification. Do not start it blind.** The fast tier cannot see a signer:
      it has no chain, so every write path there is already a refusal. The evidence has to come
      from the on-chain tier (or a local `setup:e2e` chain), and the work should be sequenced so
      that a single commit never leaves the four files disagreeing about the duck type.
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
      - **`src/lib/chains/logRange.js` (new) — the conversion exposed an UPSIDE-DOWN dependency.**
        `getLogsRange` lived in `lib/clearpath/connectors/ozGovernor.js`, a DAO-framework connector,
        and two ALREADY-CONVERTED host hooks reached into it: `useMembershipTreasuryStats` and
        `useCallsignRegistryMetrics`, neither of which has anything to do with governance — they
        scan the MembershipManager and the CallsignRegistry. The function has no governance in it
        and never had any ethers in it either; it is pure recursion over a reader's `getLogs`.
        Moving it is not tidying: while it sat there, taking `ozGovernor.js` off ethers meant
        touching a module two unrelated hooks depend on for reasons unrelated to either.
        The reader stays a DUCK TYPE (one method, `getLogs`) — satisfied by both an ethers provider
        and `eventScan`'s handle, which is exactly why the converted hooks kept calling it unchanged
        through the move. Do NOT narrow it to a chainId: callers already hold the reader they mean,
        and the spec-071 estate reads choose it for reasons a chainId cannot express.
        It had **no test of its own** despite two host hooks depending on it. It has one now, and
        every assertion is on the REQUESTS — a scan returning the right logs from the wrong ranges
        would otherwise pass. The seam-loss case is pinned specifically: splitting `[from..mid]` /
        `[mid+1..to]` wrongly drops the log on the boundary, and dropping it is invisible (a smaller
        number renders, not an error). Verified non-vacuous by introducing that off-by-one.
      - **DIVERGENCE 14, found BEFORE converting `lib/clearpath/connectors/*` rather than after —
        an indexed-address LOG TOPIC comes out in the wrong CASE.** The literal translation of
        ethers' `zeroPadValue(getAddress(addr), 32)` is viem's `pad(getAddress(addr), {size: 32})`,
        and it is wrong: ethers emits the padded topic LOWERCASE, viem's `pad` preserves the EIP-55
        checksum casing. Measured on a real checksummed address — same bytes, different string.
        That value is an `eth_getLogs` TOPIC FILTER. A node that matches the hex string exactly, or
        a cache keyed on the request, returns NOTHING for the mixed-case form — and in
        `ozGovernor.getVoteOf` "no logs" means "this member never voted", rendered as a fact with
        no error anywhere. Use **`encodeEventTopics`**, which is lowercase and byte-identical to
        ethers (verified), never `pad(getAddress(...))`.
        Two other shapes on that path were checked and are SAFE: `ethers.id(sig)` equals viem's
        `keccak256(stringToBytes(sig))` and `toEventSelector(...)` for the topic0; and viem's
        `decodeEventLog` DOES return named args (`args.proposalId` works), unlike the error path of
        divergence 13 — the `uint8 support` arrives a number rather than a bigint, which the call
        site already wraps in `Number(...)`.
        **Reconnaissance for that batch, so the next session does not redo it:** the connectors are
        NOT dead code despite ClearPath being a mini-app — `data/notifications/sources/daoSource.js`
        and two hooks (`useMembershipTreasuryStats`, `useCallsignRegistryMetrics`) import them, and
        `packageBoundary.test.js` explicitly records that as legitimate. `getLogsRange` is a
        recursive bisecting scan over `reader.getLogs`, so the `reader` is an ethers-provider-shaped
        duck type its callers supply — the Phase-1 provider rule applies.
      - **`src/lib/evm/mnemonic.js` (new) + `src/lib/pools/bip39Lists.js` — divergence (h) is WORSE
        than "derives from an invalid mnemonic", and the BIP-39 allowlist entry was wrong TWICE.**
        Measured: viem's `mnemonicToAccount` returns a real, plausible, DIFFERENT address for a bad
        checksum, for a word not in the wordlist, and for a ONE-CHARACTER typo — ethers refused all
        three, and only a wrong word COUNT is refused by both. So a member recovering with one word
        mistyped would be shown an address, told the import worked, and find an empty account while
        their funds sit somewhere they were never shown, with nothing reporting an error. The guard
        is replaced, never dropped: `isValidMnemonic` on `@scure/bip39`, already a DIRECT dependency
        (2.4.0), so no lockfile change and no spec-075 rolldown hazard.
        **The wordlist entry's reason was false for the second time.** It claimed only English was
        available without ethers; `@scure/bip39` ships all TEN and each is identical to ethers' word
        for word — 2048 entries, same order, cz/en/es/fr/it/ja/ko/pt/zh_cn/zh_tw — which matters
        because a pool's phrase is stored as INDICES and a list differing anywhere would rename
        every pool ever created, in one language only. Converted, with the comparison pinned in
        `src/test/pools/bip39Lists.test.js` so the claim stays checkable rather than trusted.
        **And a testing fact worth keeping: ETHERS' BIP-39 PATH IS BROKEN UNDER JSDOM.** Its
        `sha256` receives a cross-realm Node `Buffer`, `instanceof Uint8Array` is false, and
        `getBytes` rejects it — `HDNodeWallet.fromPhrase` throws and, worse,
        `Mnemonic.isValidMnemonic` CATCHES that internally and returns `false` for a valid phrase.
        So the shipped gate was not testable in this suite at all, cross-library parity had to be
        measured in a plain-Node probe, and the swap makes the validator testable where it was not.
        Never assert against ethers' BIP-39 functions in vitest; they answer wrongly there.
        **AND THE TEST THAT CAME WITH IT WAS FLAKY — 1 RUN IN 15 — WHICH IS WORSE THAN A WEAK
        TEST, BECAUSE IT FAILS ON SOMEBODY ELSE'S COMMIT.** It GENERATED a phrase per run and
        derived the invalid cases from it by mutation, including "bad checksum" by swapping the
        last word. The last word of a BIP-39 phrase carries the 4 CHECKSUM bits, so a substitute
        checksums correctly about 1 time in 16 — MEASURED at 6.6% over 2,000 trials. It duly went
        red on `32e03a87`, a DOCS-ONLY commit, reporting that `isValidMnemonic` had returned true
        for a phrase labelled invalid. It was not wrong about that; the fixture was.
        A randomly-generated fixture is not a stronger test than a fixed one — it is the same test
        plus a coin flip, and here the coin decided whether the suite was honest. Every phrase is a
        frozen literal now, each verified before it was pasted, and the file carries three
        assertions ABOUT THE FIXTURES (every valid one validates at its stated length, every
        invalid one fails, and — deliberately keeping the randomness where it belongs — a
        400-trial measurement that a last-word swap is NOT reliably invalid, so the reason the
        literals exist cannot quietly stop being true). The 12-word phrase's ADDRESS is frozen too:
        this is a money path, and "derives the same thing twice" stays green through a derivation
        change that orphans every account ever recovered (standing lesson b, the claimCode lesson,
        re-earned).
        The general form is worth keeping: **a test that generates its own negative cases is
        asserting a probability, not a property.** Generate the POSITIVE direction if you like —
        `generateMnemonic` always produces a valid phrase — but a negative case has to be
        constructed and checked, or frozen.
      - **`src/test/lint/ethersMockRatchet.test.js` (new) — the retired-mock class is a GATE now,
        not a discovery.** Three files in a row was enough: a test that mocks `ethers` must import,
        statically or dynamically, at least one module still on the ethers allowlist, or the mock
        cannot be intercepting anything its subject does. Deliberately a WEAK rule — a test may
        import several modules and mock ethers for one of them, and transitive imports are not
        followed — because a strict version would cry wolf and get suppressed. A sweep of all 35
        current `vi.mock('ethers')` files found **no remaining orphans**: the three fixed this
        session were all of them.
        Two false positives were designed out during its own construction, both worth knowing.
        (1) The scan matched its OWN PROSE — every file documenting a replaced mock, this one
        included, reported as still having one — so comments are stripped before scanning. (2) The
        specifier resolver missed a multi-line `await import(\n  '../../utils/rpcProvider'\n)`,
        which is idiomatic here, and reported `rpcProvider.endpoints.test.js` as an orphan when its
        subject is very much still on the list. Verified non-vacuous by reintroducing the retired
        `ethers.Contract` fake in `MiniAppReviewTab.test.jsx` and watching it fail by name.
      - `src/components/miniapps/SubmitAppPanel.jsx` — the last of the three `extractRevert` callers,
        and **the THIRD file running in a row whose test mocked `ethers.Contract`** (after
        MiniAppReviewTab and CallsignPanel). That is a pattern, not three incidents: every one of
        them faked a constructor that IGNORES the address it is handed, so in all three a write or
        read aimed at the wrong contract would have passed every assertion in the file. All three
        now mock the chain seam and record the request; this one asserts the gate is read on the
        REGISTRY'S OWN chain, which matters because spec 073 pins the registry to one chain per
        cohort and reading the wallet's would state another deployment's gate as this one's.
        `requireStrings` is added at the three encode boundaries: `submitApp`'s name/description/cid
        are `string` parameters, and divergence 9 means a `null` would be committed on chain as the
        four characters `"null"` and an `undefined` as `""` — a fabricated CID is then reviewed by a
        curator and served to members, which is not a value anybody catches by reading the screen.
        The gate read keeps its honest degradation: `getReadProvider` returning null became
        `NoRpcEndpointError`, which the existing catch turns into "gate unknown" exactly as the old
        `if (!provider) return` did.
      - `src/components/account/CallsignPanel.jsx` — the commit→reveal registration path. Two
        shapes were MEASURED before the swap rather than argued: (1) viem returns a NAMED OBJECT
        for a lone tuple, so `resolve()`'s `CallsignInfo` still reads by name — the read seam's
        comment is right; (2) `status` (`uint8`) comes back a NUMBER where ethers gave a bigint
        (divergence (b), live on this exact field), and `toCallsignInfo`'s output is nevertheless
        identical because it already wraps every integer in `Number(...)` — the Phase-1 "eighteen
        reads already normalise" pattern holding. `provider` stays as the availability gate and
        `chainId` becomes the argument, per the Phase-1 provider rule.
        Its passkey test had **the same retired-mock problem as batch 8** (`vi.mock('ethers')`
        stubbing `Contract`); it now mocks the CHAIN SEAM and records every read, so the assertions
        name the chain and the registry address — neither of which the old fake could show, because
        `new ethers.Contract(addr, …)` ignored its address. The file KEEPS its ethers import on
        purpose (it encodes the expected calldata that the panel now builds with viem, so the
        assertion is a live cross-library byte check) and is now the SIXTH documented decision entry
        in the allowlist header rather than looking like pending work.
      - **DIVERGENCE 13, found while scoping `CallsignPanel` and fixed in the seam before converting
        it: ethers' `parseError` returned error args addressable BY NAME; viem's
        `decodeErrorResult` returns a bare array.** The error-path twin of the Phase-1 multi-output
        defect, and it fails the same silent way — `revert.args.nextAllowedAt` is `undefined`, not
        an error and not a failed decode, just a field that quietly is not there.
        `CallsignPanel.describeError` reads exactly that name and survives ONLY because it carries
        an `args?.[0]` fallback; without one the member would be told "try again later" instead of
        when. `errorParser` now attaches the names from `decoded.abiItem.inputs`, non-enumerably,
        the same way `readContract.js#withOutputNames` does — so the args still spread, serialize
        and deep-equal as the plain array they are, and a parameter with no name is left alone
        rather than guessed at. Verified non-vacuous by reverting to `Array.from`.
      - `src/components/admin/MiniAppReviewTab.jsx` — first consumer of `errorParser`, plus the
        curator writes off the ethers `Contract`. **Divergence 7 is NARROWER than recorded, and the
        scope matters at every future call site:** it is DYNAMIC `bytes` only. Measured encode-only
        (a first probe conflated encode with decode and briefly suggested the opposite — re-measured
        before writing anything down): for `bytes`, viem accepts `0x123`, `0xZZ` and `nothex` where
        ethers refused, exactly as T020 found; for FIXED `bytesN` (`bytes32`, `bytes4`) the two
        agree completely, refusing null, undefined, short, odd-length, non-hex and wrong-length
        alike. So spec 073's content commitment (`approveApp(id, expectedManifestHash)`, a `bytes32`)
        cannot be weakened by the swap and needs no guard invented for it.
        **The test had a mock on what became a retired path** — `vi.mock('ethers')` faking
        `new ethers.Contract(...)`, which the component no longer constructs (standing lesson 2).
        It failed LOUDLY only because the assertions read the calls that fake recorded. Replaced
        with a signer whose `sendTransaction` DECODES the calldata via an ethers `Interface` against
        the registry ABI — same `{method,args}` assertions, now over the actual bytes, and a live
        cross-library check on the viem encoder. It also closed a gap the old fake made impossible:
        `new ethers.Contract(addr, …)` ignored its address argument, so a curator write going to the
        WRONG CONTRACT would have passed every assertion in the file. The target is asserted now.
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
      - `src/utils/claimCode/deriveFromCode.js` — WALLET-BREAKING and a MONEY path, and it converted
        with **zero divergences**: private key, `claimAddress` and symmetric key identical to ethers
        over eight codes (empty, 200-char, unicode, mixed-case, trailing space); the 15 open-accept
        signatures identical; and `privateKeyToAccount` refuses EXACTLY what `new SigningKey`
        refused — zero, n, n+1, all-ones, short hex, non-hex. That last one was the open question
        (the file's own comment calls the scalar check load-bearing) and it is now measured rather
        than assumed.
        **The suite could not have caught a derivation change.** It proved determinism and that the
        acceptance signature verifies — both of which stay true when the derivation MOVES, while
        every open challenge ever created is orphaned, because `claimAddress` IS the on-chain
        `claimAuthority`. `claimCode.test.js` now carries FROZEN fixtures computed with the ORIGINAL
        ethers implementation, so they are anchored to what shipped rather than to the code they
        guard; a one-character change to the domain tag fails them and nothing else in the file.
        **Never regenerate them to make a test pass** — a mismatch means the change is wrong.
      - `src/utils/keyRegistryService.js` — **DEFERRED, and it is why (#1612).** Converting it forces
        a decision about a branch that is unreachable today: `hasRegisteredKey` picks between
        `hasKey` (v2) and `hasValidKey` (legacy ZKKeyManager) on
        `typeof contract.hasKey === 'function'`, and the contract is ALWAYS built from
        `KEY_REGISTRY_ABI`, whose functions are exactly `getPublicKey, hasKey, registerKey,
        registerKeyWithEligibility`. ethers makes a method per ABI function, so the test is
        unconditionally true (measured) — it checks WHICH ABI FILE WAS IMPORTED, not which contract
        is deployed, while the address resolver still actively resolves a `zkKeyManager` address.
        The failure mode is the honesty rule this repo enforces everywhere else: the `catch` returns
        `false`, so an unreadable chain says "no registered key" — and `useEncryption.js:616`
        (`opponentHasKey`) turns that into a PRIVACY decision about whether terms are encrypted to
        the counterparty. The same module's `lookupPublicKeyState` already answers three ways for
        exactly this reason. Fixing it changes what a member is told, so it is its own change with
        its own review; this task does not smuggle it in behind a library swap.
        (`registerEncryptionKey:203` and `buildRegisterKeyCalls:251` guard on the same always-true
        condition — harmless, since the `try/catch` is the real fallback, but they read as
        protection they do not provide.)
      - `src/lib/clearpath/connectors/*` (`ozGovernor.js` 28 `ethers.*` uses, `governorBravo.js` 16) —
        **DEFERRED, and the reason is stronger than the other four: `reader` is a PUBLISHED
        CONTRACT, not a parameter.** `specs/042-clearpath-multi-network/contracts/connector-interface.md`
        declares it as the first argument of every method a connector exposes — `detectFramework`,
        `matches`, `readSummary`, `readTreasuries`, `fetchProposals`, `readVoterState` — and the
        ClearPath MINI-APP PACKAGE is built against it: `frontend/miniapps/clearpath/src/`
        (`ExternalDaoView.jsx` imports `getConnector`/`detectFramework`; `ClearPathPanel.jsx` passes
        `reader` / `readerFor(selected.chainId)`). A spec-073 package is frozen at an immutable CID
        and approved on chain per cohort, so narrowing `reader` to a `chainId` is a spec-042
        interface change that orphans a published package — not a caller-signature edit, and not
        something a library migration gets to do as a side effect. The host tree keeps its own copy
        of the connectors (the package boundary forbids sharing), so a change here means the same
        change there, a rebuild, re-recorded digests and re-approval at new CIDs on Polygon 137 and
        Mordor 63 — which is T050's work, in Phase 5, with that lifecycle.
        The bodies convert cleanly otherwise: the uses are `Contract` (19), `isAddress` (11 —
        divergence (d), take it from `lib/evm/address`), `ZeroAddress` (5), `Interface` (4),
        `id` (3), `getAddress` and `zeroPadValue` (1 each), all of which now have measured
        equivalents. Divergence 14 above is the only trap on this path and it is written down.
        The blocker is the signature, nothing in the arithmetic.
        Note also that these are NOT dead code — `data/notifications/sources/daoSource.js` imports
        `getConnector`/`detectFramework` and `packageBoundary.test.js:142` records that as
        legitimate — so leaving them on ethers is a real allowlist entry, not an oversight. What
        this session DID take out of them is the part that never belonged: `getLogsRange`, which two
        unrelated host hooks depended on, now lives in `lib/chains/logRange.js` (above), so the
        connectors are no longer load-bearing for anything outside governance.
      - **The FeeRouter cluster — `src/components/admin/{FeesTab.jsx, PerpsFeesPanel.jsx,
        perpsFeeRails.js}` — and THREE new divergences, two of them dangerous.** One contract
        family, one batch, one review. Probed first, as always: `ethers.id` is byte-identical to
        `keccak256(stringToBytes(...))` over all nine registered service labels plus empty, unicode
        and whitespace-padded fuzz (these strings KEY `KNOWN_SERVICES`, so a wrong byte does not
        throw — it makes a live service fall through to the `Service 0x1234abcd…` label and read as
        somebody else's registration), and `ethers.ZeroAddress` equals viem's `zeroAddress`.
        **DIVERGENCE 15 — viem's `encodeFunctionData` COERCES a non-number into an INTEGER
        parameter where ethers refused.** The integer twin of divergence 9. Measured on
        `setFeeBps(bytes32, uint16)`: `[]` → 0, `''` → 0, `false` → 0, `true` → 1, `[7]` → 7;
        ethers threw on all five. Three of those produce a rate of ZERO — a perfectly valid
        transaction that sets a fee to nothing, with no error anywhere. Both libraries accept a
        numeric STRING (`'250'`) and both refuse `null`/`undefined`, so the gap is exactly the
        values a sloppy form binding produces. Nothing in this batch was exposed (`bps` arrives
        through `Number.parseInt` + `Number.isInteger`, the GMX factor is a bigint behind a null
        guard) — but the next converted write that passes a raw field into an integer param is,
        and the guard to copy is `requireStrings` in `SubmitAppPanel.jsx`.
        **DIVERGENCE 16 — viem's `encodeFunctionData` REFUSES an ALL-UPPERCASE `address` that our
        own `isAddress` accepts, and this one WAS live.** `lib/evm/address.js` deliberately
        reproduces ethers' rule: an all-upper (or all-lower) address carries no checksum, so there
        is nothing to verify and it is valid. viem's encoder disagrees and throws. So on
        `setTreasury` — the control that decides where every platform fee on a chain lands — a
        member pasting upper-case hex passed validation and then hit a raw viem error from
        underneath the button. `getAddress(value)` before encoding produces calldata BYTE-IDENTICAL
        to ethers' (measured, all three casings). **Normalise every address argument through
        `getAddress` before encoding; `isAddress` alone is not enough.**
        **DIVERGENCE 17 — viem preserves the input's hex CASE in calldata; ethers lowercased it.**
        A `bytes32` passed in upper case comes back in the calldata in upper case. Same bytes when
        read as hex, a different STRING — so anything that compares, caches, dedupes or asserts on
        a calldata string breaks while the transaction itself is fine. The sibling of divergence 14
        (which is the same root cause on a log topic, where it is far worse because a node matching
        the string returns no logs). Not live here — the service ids come back lowercase from the
        chain — but it is why calldata assertions in this batch DECODE rather than string-compare.
        **A REAL DEFECT FOUND BY CONVERTING: the fee-history scan was reading TWO CHAINS AT ONCE.**
        `FeesTab.fetchHistory` took its `latest` block and every entry's timestamp from
        `provider` — the WALLET's — while the logs came from the scoped chain's router. This tab
        exists because a fee schedule is per-chain and you read one chain while your wallet sits on
        another; its own banner says so. So the mismatch was the NORMAL case: reading Polygon's fees
        from a wallet on Ethereum measured the 200,000-block window against Ethereum's height and
        then dated every Polygon change by whatever Ethereum block shared its number. Chains do not
        advance together, so the window could miss every change outright, and the dates shown were
        simply another chain's — rendered as fact, nothing failing. The rendered output is identical
        either way, which is why it survived: the ethers fake carried its chain inside a `runner`
        and could not be asked which one it used. Fixed to `scopeChainId` throughout, and the test
        asserts on the REQUESTS (verified non-vacuous — it names both chains).
        The same scan also asked for 200,000 blocks in ONE `eth_getLogs`. Public RPCs cap that at
        ~10,000, so the old single `queryFilter` threw on them and the catch rendered an empty
        history — a statement about the CHAIN made from a fact about the REQUEST. It bisects now
        (`getLogsRange`, the module lifted out of the DAO connectors earlier in this task), with a
        test that seeds a capped provider and is verified non-vacuous against the unbisected call.
        Both test files had the retired-`vi.mock('ethers')` shape; both now mock the CHAIN SEAM and
        record `{chainId, address, functionName, args}`. That is what made the two-chain defect
        assertable at all, and `PerpsFeesPanel` gained the assertion its old fake made impossible —
        each rail read on ITS OWN chain (GMX's DataStore on Arbitrum 42161, the FeeRouter service on
        the build's mainnet chain), verified non-vacuous by pointing one rail at the other's chain.
        Writes are `encodeFunctionData` + `signer.sendTransaction`, and both suites DECODE the
        calldata with an ethers `Interface` against the same ABI — a live cross-library byte check
        rather than a read-back of arguments a fake was handed. One SOURCE-shape assertion needed
        updating with them: `PerpsFeesPanel`'s "exactly one write" test grepped for
        `new Contract(ABI, signer).method(`, a pattern that no longer exists — left alone it would
        have passed forever over an empty match set, which is the retired-mock failure wearing a
        different hat.
        `sameAddress` in `perpsFeeRails.js` kept its fail-closed property DELIBERATELY: ethers'
        `getAddress` threw on a mis-checksummed mixed-case address, so the old `try/catch` refused
        one and the `uiFeeReceiverGuard` withheld `setUiFeeFactor` with a reason. viem's re-checksums
        silently. It validates with `isAddress` first now, which is the original BEHAVIOUR rather
        than the original code.
      - **`LiquidityApp.jsx`, `IncidentResponseApp.jsx`, `MaintenanceTab.jsx` — and a SPEC-069
        BYPASS that both estate dashboards were carrying.** Three low-count files (one `Contract`
        each, plus one in Maintenance's write helper), converted together. Allowlist 50 → 47.
        Both pause dashboards read `readProviderFor(n.chainId, chainId, provider) ||
        getProvider(n.chainId)`. The `||` is the bug: `readProviderFor`'s null is the availability
        gate REFUSING (cohort bound, or no endpoint at all), not a gap to route around, and
        `getProvider` hand-builds a provider from `NETWORKS[chainId].rpcUrl` — which spec 069
        forbids outright, because it ignores the member's configured endpoint and its failover —
        THROUGH `getNetwork`, which falls back to the default network for a chain it does not
        know (`NETWORKS[chainId] || NETWORKS[getCurrentChainId()] || NETWORKS[PRIMARY_CHAIN_ID]`).
        On a dashboard whose entire job is saying which chains are paused, that is one chain's
        pause state rendered under another chain's name. The gate is honoured now and a chain with
        no read connection reports `unreadable`, which is what it is.
        `freezeAccount`/`unfreezeAccount` take the member-typed address through `getAddress` per
        divergence 16 — `isValidEthereumAddress` is a bare regex (`/^0x[a-fA-F0-9]{40}$/`), so it
        accepts ALL-UPPERCASE, which viem's encoder then refuses; it also tested `address.trim()`
        while the caller passed the UNTRIMMED value, so a pasted address with a trailing space
        passed validation and failed at the encoder. Both are fixed by normalising once at the
        encode. Freezing the wrong account is not a recoverable mistake.
        Two source-shape assertions in `adminIncidentEstate.test.jsx` moved with the code and were
        STRENGTHENED rather than merely updated: they matched `incidentWrite().freezeAccount`, a
        call shape that no longer exists, and now assert what they always meant — that the
        transaction's `to` is `incidentRegistryAddr`, the scoped registry, which is the only thing
        between "pause Polygon" and pausing whatever chain the wallet happens to be on.
        **`BridgeTab.jsx` + `SupplyTab.jsx` are deliberately NOT in this batch.** They are the
        spec-067 router pair, they share `liquidityAdminCommon.js`, and their `readProviderFor`
        call passes `requireCohort: false` (their routers exist only on mainnets, so a testnet
        build would otherwise blank them) — a deliberate opt-out from the very rule the three
        files above were violating by accident. Converting them alongside files whose fix is
        "honour the cohort gate" would put two opposite-looking changes in one review. They also
        carry a real ops scan (`queryFilter` + receipts + gateway status). Their own batch.
      - **`BridgeTab.jsx` + `SupplyTab.jsx` + `liquidityAdminCommon.js` — the spec-067 router pair,
        converted together, and TWO more divergences (18 in the opposite direction from 15).**
        Allowlist 47 → 45. These convert as one change because they share the module: it holds
        `readProviderFor` (the `requireCohort: false` opt-out), `isValidAddr`, and
        `loadRouterHistory`, which both tabs call.
        **DIVERGENCE 18 — viem is STRICTER than ethers on `bool`, which is the OPPOSITE of what
        divergence 15 teaches about integers.** Measured on `setRoute`'s struct: viem's
        `encodeFunctionData` REFUSES `1`, `0`, `'true'`, `''`, `[]`, `null` and `undefined` for a
        `bool` parameter, where ethers coerced every one of them (`1`→true, `''`→false,
        `undefined`→false…). So "viem coerces" is the wrong generalisation to carry out of 15: it
        coerces INTEGERS loosely and refuses BOOLS outright. The practical shape is a form field
        that is `undefined` before first interaction — ethers sent `false`, viem throws from under
        the button.
        **Divergences 15, 16 and 18 all reach STRUCT FIELDS**, not just top-level arguments —
        verified on the seven-field `setRoute` tuple.
        And the good news, measured rather than assumed: **TUPLE ENCODING HAS FULL PARITY.** A
        named object encodes identically in ethers and viem, key ORDER does not matter, a
        positional array works in both, and a missing key throws in both. So `setRoute({...})` /
        `listPool({...})` convert with the object literal untouched.
        **`isValidAddr` was already stricter than ethers, and that is a live honesty bug this batch
        fixes.** It was `isAddress(a) && a !== zeroAddress` on **viem's own** `isAddress`, which
        defaults to `strict: true` and REFUSES an all-uppercase address — an address that carries
        no checksum information and is perfectly valid. An operator pasting one from a tool that
        upper-cases hex was told their token address was not an address. It reads from the address
        SEAM now (ethers' rule), and every caller normalises through `getAddress` before encoding,
        because divergence 16 means the encoder refuses exactly what the validator now accepts.
        **The two halves have to move together** — validator alone accepts what the encoder throws
        on; encoder alone is unreachable behind a validator that already refused.
        `loadRouterHistory` takes `{chainId, address, abi, …}` instead of an ethers `Contract`, and
        both scans bisect (`getLogsRange`) instead of asking for 200,000 blocks in one
        `eth_getLogs`. On a range-capping RPC the old single `queryFilter` threw, and the catch
        rendered "this RPC bounds event lookups" — honest, but it meant neither panel could ever
        show history on such a chain. A log the ABI cannot decode is now SKIPPED rather than
        rendered as a blank row, which would read as a change nobody can account for.
        **FOUR test files had the retired-`vi.mock('ethers')` shape, and one of them was about to
        make a regression test silently vacuous.** `AdminSupplyTab` kept its per-read COUNTER inside
        the ethers fake, and the refetch-loop regression test (#1031 — reads were 51 in 250ms and
        rising) asserts on that counter. Left behind, it would have counted nothing while still
        looking like a guard; it only failed loudly because the assertion reads the number. The
        counter now lives in the seam mock. All four record `{chainId, address, functionName}`, and
        both tabs gained the assertion their fakes made impossible — every read and every scan on
        the SCOPED chain at THAT chain's router, driven through the Network control, verified
        non-vacuous by pointing the reads at the wallet's chain.
        Two FIXTURES were never realistic and the real encoder said so: pool and route ids were
        `'0xpool1'` / `'0xroute1'`, which are not `bytes32` and not even hex. The fake never encoded
        them, so nothing checked. They are real 32-byte values now.
        One more shape moved with the chain: block timestamps come from the SCOPED chain's client,
        so a test seeding "this happened two hours ago" seeds it there rather than on the wallet's
        provider — which is a different chain whenever these tabs are doing the job they exist for.
      - **`AccessControlApp.jsx` — the role grants, and the third file in a row where
        `isValidEthereumAddress` was the whole guard on a member-typed address.** Allowlist 45 → 44.
        Eight role hashes (`ethers.keccak256(ethers.toUtf8Bytes(name))` → `keccak256(stringToHex)`)
        byte-compared before the swap, and `ZeroHash` is `zeroHash` exactly. These hashes ARE the
        roles on chain: a wrong byte does not throw, it grants nothing and revokes nothing while
        the surface reports success.
        Divergence 16 again, and this is the sharpest instance of it so far — `grantRole` /
        `revokeRole` normalise through `getAddress` because `isValidEthereumAddress` is a bare
        regex that accepts an ALL-UPPERCASE address and tests `address.trim()` while handing the
        caller the UNTRIMMED value. Both are refused by viem's encoder. The control in question
        grants GUARDIAN_ROLE.
        The test's fake was one of the GOOD ones — `RecordingContract` kept the address it was
        constructed with — so rather than rewrite its assertions, the recording SIGNER decodes the
        calldata back into the same `{address, method, args}` shape. Every assertion reads
        unchanged and is now backed by the actual bytes; `MembershipRevenueApp` still constructs an
        ethers `Contract` in the same file, so one bag has two producers and the mock ratchet stays
        satisfied. Verified non-vacuous by substituting a wrong role hash.
      - **`MembershipRevenueApp.jsx` — membership prices and the fee withdrawal.** Allowlist
        44 → 43, and the retired `RecordingContract` fake in `adminRoleManagement.test.jsx` is
        DELETED, because with both apps in that file off ethers it guarded nothing. Two role hashes
        byte-compared; `formatUnits`/`parseUnits` move to `lib/evm/units.js`, which is already
        ethers-compatible at the input boundary (it coerces the BIGINT decimals a `decimals()` read
        returns, and keeps ethers' trailing `.0`). Divergence 16 on all three member-typed targets
        — `grantMembership`, `revokeMembership` and `withdrawFees`, the last of which names where
        the money goes. 15 and 18 are NOT reachable: every tier integer goes through
        `Number(e.target.value)` and `active` through `e.target.checked`.
        **A TDZ that eslint caught and a test would have too: the `roleId` helper was inserted
        BELOW the two `const` role hashes that call it.** `const` is not hoisted for use, so the
        module would have thrown at load. Worth noting because the same edit in
        `AccessControlApp.jsx` happened to land above its table — the difference was luck, not
        care.
        **THE FAKE RECORDED WHAT IT WAS HANDED, NOT WHAT WOULD BE SENT — and the difference is
        visible now.** `grantMembership`'s `tier`/`durationDays` assertions had to change from
        `1, 30` to `1n, 30n`: they are DECODED FROM CALLDATA now, and ethers decodes `uint8`/
        `uint32` as bigints. The component still passes numbers and viem encodes them identically.
        The old expectation described the call site; the new one describes the transaction.
      - **TWO TEST-QUALITY DEFECTS IN MY OWN NEW GUARDS, both found by insisting on a re-run.**
        Recording them because each has a general form, and this task has now produced three of
        the same family (the mnemonic fixtures being the first).
        (1) **A RACE PHRASED AS AN INVARIANT.** The first version of the scoped-chain test cleared
        the recorder, switched network, and asserted every subsequent call was on the new chain.
        Clearing does not cancel reads already in flight from the previous mount, so a late one
        lands after the clear and fails an assertion that is only usually true — it passed, then
        failed, then passed. Restated as the property actually wanted: **chain and address always
        agree**, over every call, whenever it landed. Race-free, and strictly stronger — it also
        catches a read for chain X sent at chain Y's router.
        (2) **A FIXTURE COLLISION MADE IT VACUOUS, and the only reason that surfaced is that the
        non-vacuity check was run.** The restated test passed with the defect deliberately
        reintroduced. The cause was not the logic: the second router address chosen for the test
        was `0x2222…`, which is exactly what `ROUTER` already is in `AdminSupplyTab.test.jsx` —
        so `{1: ROUTER, 137: OTHER}` mapped both chains to one address and nothing could
        distinguish them. The test now asserts `expect(OTHER).not.toBe(ROUTER)` first, so a future
        collision fails loudly instead of silently retiring the guard.
        **The rule: verify that a fixture DISTINGUISHES what the assertion claims it
        distinguishes.** "Verified non-vacuous" means reintroducing the fault and watching the
        test fail — not reasoning that it would.
      - **`CallsignRegistryAdmin.jsx` — and the read path had NO COVERAGE at all before this.**
        Allowlist 43 → 42. `ethers.id(canonical)` → `keccak256(stringToBytes(canonical))`, checked
        over 21 callsign shapes (both length boundaries, every rejected form, unicode) before the
        swap. That hash IS the registry's on-chain key: a wrong byte does not throw, it looks up
        nothing, and the panel reports a REGISTERED callsign as unregistered.
        Divergence 16 on the role grant/revoke target. `ethers.isAddress` → the address seam.
        **The existing suite rendered with a NULL provider on purpose** — `reader` is null,
        `loadConfig` never runs, the whole tab is synchronous and nothing is ever read. Good for
        what it tested (the not-configured and no-role renders); it also meant the conversion had
        no coverage for the hash, the reads or the chain. A test was added that drives a real
        lookup, and the expected hash is a FROZEN LITERAL computed with the original `ethers.id` —
        asserting against a freshly computed `keccak256(stringToBytes(...))` would use the very
        function under test and prove only that it equals itself (the claimCode lesson, third
        instance). Verified non-vacuous by perturbing the hashed string.
        One practical note for the next admin-tab test: these tabs disable every control when the
        scope is off the wallet's chain (`onScopeNetwork`), and a testnet build's cohort does not
        contain 137 — so a test that interacts with a form must render on `cohortChainIds()[0]`,
        not on a hardcoded mainnet id. That is why the original suite never clicked anything.
      - **`ProtocolConfigTab.jsx` + `OracleAdaptersTab.jsx` — and DIVERGENCE 19.** Allowlist
        42 → 40. Between them these wire the sanctions guard, the Chainalysis oracle, the stake-token
        allowlist, the authorized callers and all three oracle adapters — every address here decides
        what the protocol trusts, so divergence 16 (`getAddress` before encoding) applies to all of
        them, `address(0)` clearing included.
        **DIVERGENCE 19 — viem's `encodeFunctionData` REFUSES a `Uint8Array` for a `bytes`
        parameter; it requires HEX.** The trap is the name: ethers' `toUtf8Bytes` returns a
        Uint8Array, and the obvious one-word translation `stringToBytes` is the one that THROWS.
        `stringToHex` is the correct replacement and is byte-identical to `toUtf8Bytes` over the
        empty string, 200 chars, unicode, emoji, embedded quotes and backslashes, and a
        hex-looking claim. This is the sibling of 11b (viem's `hashMessage` refusing a bare
        `Uint8Array`) and it fails LOUDLY, which makes it the safer kind — but it is live on
        UMA's `registerCondition(bytes32, bytes claim, …)`, the text a dispute is judged against.
        **THREE MORE ASSERTIONS DESCRIBED THE CALL SITE RATHER THAN THE TRANSACTION**, and all
        three changed once the bytes became real: `op` from `0` to `0n` and `gasLimit` from
        `300000` to `300000n` (ethers decodes `uint8`/`uint32` as bigints), and the UMA claim from
        `toBeInstanceOf(Uint8Array)` to a hex string — which is divergence 19 visible in a test.
        The components still pass numbers and viem encodes them identically; what changed is that
        the assertions now read the transaction. Verified non-vacuous by swapping `stringToHex`
        back to `stringToBytes` and watching the UMA test fail.
        `OracleAdaptersTab`'s fake was another address-ROUTING one (the good kind — it is what made
        "the UMA form wrote to the UMA adapter" assertable). It was kept, not traded away: the
        decoding signer dispatches to the same per-address stub, so every
        `expect(umaStub.registerCondition).toHaveBeenCalled…` reads unchanged and is now backed by
        bytes. **The mock ratchet caught this file** the moment `OracleAdaptersTab` left the
        allowlist — its second real catch.
      - **`StakingTab.jsx` + `DenyListAdmin.jsx` + `PaymasterOpsCard.jsx` — the last of the admin
        tabs.** Allowlist 40 → 37. `parseEther`/`formatEther` move to `lib/evm/units.js`;
        divergence 16 on `addValidator`, `removeValidator`, `withdrawTo`, `setVerifyingSigner` and
        `setDenied` — denying the wrong account, or rotating the paymaster's verifying signer to a
        mistyped address, is not a recoverable mistake.
        **A PAYABLE call changes shape, and the shape it changes TO is what it always was on the
        wire.** `deposit({ value })` passed the native amount in an ethers overrides object as a
        trailing argument; it is now `sendTransaction({ to, data, value })` — a field on the
        transaction. Nothing about the transaction differs; only the JS spelling.
        **`StakingTab` had its OWN inline history scan** (not `loadRouterHistory`), and converting
        `routerRead` from an object to a function silently broke it: `routerRead.queryFilter` became
        `undefined`, the `.catch(() => [])` threw on undefined, the outer try swallowed it, and the
        history rendered EMPTY with no error. Caught because a test asserted a row renders. It
        bisects now like the others.
        Three more retired `vi.mock('ethers')` deleted (`adminViewScope`, both `staking-admin`
        files) — the ratchet's third, fourth and fifth catches. `adminViewScope`'s was another
        address-ROUTING fake, so the per-address table was kept and re-pointed at the seam.
        **AND THE MOCK I WROTE TO REPLACE THEM HAD THE FIXTURE-COLLISION DEFECT AGAIN** — a second
        instance in the same task. My `eventScanHandle` stub ignored its `address` and returned a
        handle unconditionally, so the staking history test still passed when the scan was pointed
        at `null`. It returns null for a falsy address now and records `{chainId, address}`. The
        rule stands: **a mock that ignores an argument cannot distinguish what the assertion claims
        it does**, and the only way to find that out is to reintroduce the fault and watch.
      - **`useVaultProposals.js` + a one-line fix in `lib/custody/vaultTransaction.js` — custody,
        and DIVERGENCE 17 inside a dynamic `bytes`.** Allowlist 37 → 36. Safe reads move to
        `readContract`; the log-scan handle is `eventScanHandle`, which IS the duck type `scanLogs`
        consumes, so `readExecutionOutcomes` needed no change at all. The `Interface` becomes a
        three-line `safeCall(fn, args)`.
        Probed first, and `execTransaction` did NOT match: viem's calldata carried the signature
        blob's address in CHECKSUM CASE where ethers emitted lowercase. The blob is built by
        `buildPrevalidatedSignatures` with viem's `pad`, which preserves the casing of the address
        it is handed — divergence 17, reaching inside a dynamic `bytes` argument. **This was
        already live on the branch**, not introduced here: `vaultTransaction.js` had been converted
        earlier and its test lowercases before comparing, with all-digit fixtures, so it could not
        see it.
        **It is COSMETIC, and saying so precisely matters**: the Safe parses hex case-insensitively,
        `keccak256` hashes bytes rather than the string, and `getTransactionHash` does not cover the
        signatures at all — so `safeTxHash` is untouched and no transaction behaves differently. It
        is normalised anyway (`.toLowerCase()` on the padded owner, restoring byte-identity with
        ethers) because a calldata string that silently differs from what shipped is a trap for the
        next byte comparison, not because anything was broken.
        **EVERY EXISTING TEST THAT TOUCHES THIS HOOK MOCKS IT** — `VaultQueueView`,
        `VaultActionSheet` and `VaultDetailsView` all `vi.mock('../../hooks/useVaultProposals')` —
        so the calldata that moves funds out of a multisig had NO coverage. 515 tests passed either
        way. `src/test/custody/useVaultProposals.writes.test.jsx` is new: it drives `approve` and
        `execute` on the classic rail, asserts the transaction's `to` is the VAULT (what an ethers
        `Contract` fake structurally cannot show), pins both selectors as FROZEN literals, and
        byte-compares the whole `execTransaction` calldata against ethers. That last assertion is
        what catches divergence 17 here — verified non-vacuous by removing the `.toLowerCase()`.
      - **An OBSERVATION, not a diagnosis, recorded so the next session does not rediscover it
        cold:** `src/test/perps/perpsActivity.test.js > is written to by the ONE write path` failed
        ONCE in a local sweep-1 run during this batch, and did not reproduce — it passes alone and
        passed a full repeat sweep (5,792/5,792). It is not attributable to this task: neither
        `usePerpsTrade.js` nor that test has been touched, and the names it greps for
        (`recordPerpsOrder`, `queuePerpsAction`) appear in nothing written here.
        What can be said: the test `import.meta.glob`s 200+ files with `?raw`, sweep 1 is the run
        CLAUDE.md warns OOMs this environment, and a starved `?raw` load returning empty would
        produce exactly the observed failure shape (an empty `writers`, so `toEqual` fails) while
        still satisfying the file-count guard above it. That is a plausible mechanism, NOT a
        confirmed cause — the sweep output was tail-truncated before the assertion detail, so the
        actual `writers` value was never seen. **CI's own Frontend Unit Tests job is the authority
        for the full suite and has been green on every commit in this PR.** If it recurs there,
        it is real and the assertion text will be available; do not write it off as this note.
      - **`useNullifierContracts.js`, and THE READ SEAM ITSELF FINALLY GOT A TEST.** Allowlist
        36 → 35. The hook predates spec 071 and resolves its address from the build default, so the
        chain comes from `NETWORK_CONFIG.chainId` — which IS the same `ACTIVE_CHAIN_ID` that
        `getContractAddress` uses, so address and chain cannot disagree. A literal `137` here would
        have been a second source for one fact.
        **This hook is the clearest live instance of divergence (a) in the codebase**:
        `getStats` is a FIVE-output view whose result is read BY NAME (`stats.markets`,
        `stats.addresses`, `stats.nullifications`, `stats.reinstatements`, `stats.lastUpdate`).
        Converted naively, every one of those becomes `Number(undefined)` — **NaN on the screen**,
        no error, no failed read. `withOutputNames` in the seam is the only thing preventing it.
        **And that mechanism had NO DIRECT TEST**, which is the finding worth keeping. It is the
        single guard against the worst of the nineteen divergences — the one that already shipped
        an EMPTY POSITIONS LIST once — and every consumer mocks `readContract` wholesale, so a
        regression in the naming would have surfaced as NaN counters on a dashboard rather than a
        red suite. `src/test/chains/readContract.test.js` is new and covers: names attached for a
        five-output read AND positional destructuring still working; the result still spreading,
        deep-equalling and enumerating as the plain array it is (the names are non-enumerable ON
        PURPOSE — if they enumerated, every `toEqual` against an array elsewhere would break); a
        single output left exactly as viem returned it; an UNNAMED output not guessed at; a
        length/arity mismatch left positional rather than mislabelled; `NoRpcEndpointError` instead
        of a default; `blockNumber` bigint vs tag; and `normalizeAbi` on both ABI dialects plus its
        identity caching. Verified non-vacuous by deleting the `withOutputNames` call.
      - **`useFundingPools.js` — NOT converted, and this is the deferral's own trigger firing.**
        It reaches `factory.interface.encodeFunctionData`, `factory.getAddress()` and `pool.runner`
        — all ethers `Contract` idioms coming out of `lib/funding/fundingContracts.js`, which is
        deferred with the note "contract factories; convert when their callers do". That condition
        is now met, so this is a real batch (factory module + hook + the spec-103 pool clones), not
        a tail-end addition to someone else's. Left whole rather than half-done.
      - **Funding pools (spec 103): `lib/funding/fundingContracts.js` + `useFundingPools.js` — the
        deferral's own trigger, fired.** Allowlist 35 → 33. The factory module's deferral note said
        "convert when their callers do"; it has exactly ONE caller, so both moved together. The two
        `new Contract(...)` factories become `readFundingFactory` / `readFundingPool` /
        `encodeFactoryCall` / `encodePoolCall`, and the "not deployed here" refusal stays a THROW
        rather than becoming a null — a caller must not be able to mistake it for a read that
        returned nothing.
        Probed first on `createPool`, whose struct carries all three dangerous parameter kinds at
        once, and all three divergences reproduce inside it: **9** (`purpose` — a non-string is
        STRINGIFIED, and this is the pool's PUBLIC on-chain purpose, the sentence members read
        before deciding to contribute; a `null` would be committed as the four characters "null"),
        **15** (`goal` — `''`/`[]`/`false` become 0, i.e. a funding goal of nothing) and **16**
        (an all-uppercase `token` refused). The existing `String(...)` and `parseUnits` wrappers
        already covered 9 and 15; `getAddress` covers 16.
        **Three shapes changed and each was a decision, not a translation.**
        (1) `chainNow(contract)` → `chainNow(chainId)`: the clock is a property of the CHAIN, and it
        was being reached by digging `contract.runner.provider` out of an ethers Contract — the
        exact fusion of "where" with "who" this task exists to remove. Its test asserted the
        runner-digging; the BEHAVIOUR it actually protects (chain clock, device clock only as
        fallback, including a zero/absent timestamp) is unchanged and still asserted.
        (2) `decodeActivity` read ethers' `e.fragment.name`; it reads `e.name`, the shape
        `eventScanHandle(...).interface.parseLog` returns. Its fixtures moved with it — a fixture
        keeping `fragment` would describe a decoder the code no longer uses.
        (3) `resolvePool(factory, indices)` was NOT changed, because it lives in
        `lib/pools/gateway.js` and is SHARED with the wager pools, whose contract module is still
        deferred. A duck-typed `factoryReaderFor(chainId)` satisfies the one method it calls — the
        same move `getLogsRange` and `scanLogs` make with their readers — so one batch does not
        reach into another's.
        `queryFilter('*')` (EVERY event the clone emitted) becomes a no-topics `getLogsRange`, so it
        bisects on refusal where the single unbounded call it replaces made the whole feed throw on
        a range-capping RPC; an undecodable log is still skipped rather than rendered blank.
        **The no-chain e2e spec was run locally** (`42-funding-pools.cy.js`, 6/6) — the standing
        lesson applied for the first time on a member-facing conversion. FP-FAST-06 is the one that
        mattered: "a pool link the chain cannot answer renders as unreadable with a retry — never as
        zeros". That honest-degradation path is exactly what this conversion could have broken,
        because the read now raises `NoRpcEndpointError` where a contract call used to reject.
      - **Wager pools (spec 034): `lib/pools/poolContracts.js` + `usePools.js` — the same trigger,
        one batch later.** Allowlist 33 → 31. `poolContracts.js` had the identical
        "contract factories; convert when their callers do" shape as its funding-pool sibling and
        the identical single caller, so the pair moved together: `getFactory`/`getPool` become
        `readPoolFactory` / `readPool` / `encodeFactoryCall` / `encodePoolCall` /
        `getFactoryAddress`, and "not available on this network" stays a THROW.
        Probed first, at the repo root, against ethers' own `Interface`: every selector and every
        full calldata byte-matches — the six no-arg pool calls, `proposeOutcome` and `claim` (both
        carrying the `PayoutEntry[]` STRUCT ARRAY), `createPool`'s six-field struct, and
        `poolByPhrase`'s `uint16[4]`. Then 4,000 fuzz rounds over random addresses in all three
        casings (checksummed / all-lower / ALL-UPPER), through the ERC-20 `approve` encoder and
        through the struct array, all byte-identical once normalised — and the same probe confirmed
        viem still refuses the raw all-uppercase form, so the `normEntries` / `getAddress` guards
        are load-bearing rather than decorative (**divergence 16**, reaching inside array elements
        and inside `createPool`'s `token` field).
        **Two shapes changed and each was a decision.**
        (1) `queryFilter(filter)` becomes a LOCAL `scanPoolEvent` that makes ONE `eth_getLogs`,
        deliberately NOT `getLogsRange`. The funding-pool batch reached for `getLogsRange` because
        its feed genuinely wanted the bisect; here the two scans start at a *deploy block that is 0
        where none is recorded*, and bisecting an unbounded range turns one honest refusal into
        thousands of requests. `queryFilter` made a single request that answered or threw, and that
        is what is preserved. The roster scan additionally gained the deploy-block bound
        `fetchProposedMatrix` already had — a clone cannot emit before the factory that created it
        existed, so it can drop no event.
        (2) `resolvePool` is again left alone, satisfied by a duck-typed `factoryReaderFor(chainId)`
        — this is the OTHER half of the pair the funding-pool batch deliberately did not reach into.
        The shared gateway is now consumed the same way from both sides and still imports no ethers.
        **The old test proved nothing and now does.** `src/test/usePools.test.jsx` mocked
        `lib/pools/poolContracts` wholesale with a fake whose `interface.encodeFunctionData`
        returned the literal string `'0xclose'`, and then asserted the passkey call carried
        `data: '0xclose'` — i.e. that the hook passed a mock's return value through, never that the
        bytes a wallet would be asked to sign are the right ones. The module is no longer mocked;
        the assertion is the FROZEN selector `0x6be61602`, byte-compared against ethers before the
        swap. The roster test now asserts the scan's chain, address, topic and *block range* rather
        than "queryFilter was called". Both were verified non-vacuous by reintroducing the fault:
        encoding `cancel` where `closeJoining` belongs fails the first, scanning from genesis fails
        the second.
        **The wager-pool member surface has no no-chain e2e spec** — `24-wager-pools.cy.js` is
        on-chain tier — so the local run that the funding-pool batch could do was not available
        here, and CI's on-chain shard is what covers it. Said plainly rather than quietly skipped.
      - **`useWrapNative.js` — and DIVERGENCE 20, in the seam that claimed it had no more.**
        Allowlist 31 → 30. The hook itself is small (an `Interface`, two `Contract` reads, a
        `parseUnits`), and `deposit()` / `withdraw(wad)` byte-match ethers across 3,003 fuzzed
        amounts including 0 and 2²⁵⁶−1. The conversion is not what this batch is about.
        **DIVERGENCE 20 — `parseUnits` ROUNDS a value the unit cannot represent; ethers REFUSED
        it.** `lib/evm/units.js` has said since Phase 0 that "throw semantics are preserved". That
        is true of the DECIMALS argument and false of the VALUE:
        `parseUnits('1.0000005', 6)` threw under ethers and is `1000001n` under viem — rounded
        HALF-UP, silently. `'1.9999999999999999999'` at 18 becomes **2.0**, MORE than was typed;
        `'0.0000001'` at 6 becomes **0**, a send of nothing; `'1.5'` at 0 decimals becomes **2**.
        Every call site in this app was written against the refusal and already renders it
        ("Enter a valid amount."), so under viem the same keystrokes produce a DIFFERENT AMOUNT
        than the member consented to — and rounding UP can push a MAX past the balance, moving the
        revert from before the signature to after it. ethers' actual rule is EXACT
        REPRESENTABILITY: trailing zeros are fine (`'1.5000000'` at 6 is `1500000n` in both), a
        non-zero digit beyond the unit's precision is not. Fixed in the seam, for `parseEther`
        too, rather than at ~50 call sites.
        **The existing differential test could not have found it.** It fed only values ethers
        ACCEPTS — it checked the agreement set and never the refusal set, which is where the two
        libraries part company. That is the fixture lesson again, one level up: at the level of
        which CASES a differential test is given, not which values a fixture holds. The new block
        asserts `expect(() => ethersParseUnits(…)).toThrow()` beside `expect(() => parseUnits(…))
        .toThrow()`, so it stays a claim about ethers rather than about a remembered number.
      - **The ethers-mock ratchet was counting modules the test itself had replaced — and a
        SIXTH file fell out of it.** The gate asks whether a `vi.mock('ethers')` still reaches a
        module that imports ethers, and it counted `vi.mock('…')` specifiers as "reaches". But a
        module the file REPLACES outright never loads, so its imports never run: the fact that it
        imports ethers says nothing about the subject. `useWrapNative.test.jsx` is exactly that —
        the hook had just moved to the chain seam, and the only allowlisted path the file named
        was `utils/rpcProvider`, which the same file fully replaces. The gate stayed quiet. Now a
        specifier that is mocked-and-never-really-imported does not count, unless its factory
        reaches for `importOriginal`/`importActual` (a PARTIAL mock does load the real module, so
        it still counts). Both directions were proved with throwaway probe files — one that the
        gate must flag, one that it must not.
        The catch: `src/test/MarketAcceptancePage.test.jsx`, whose fake `Contract` had
        `getFriendMarketWithStatus` on it long after the page moved to `readContract`. It was
        invisible because every case there renders with no provider and reaches no chain read at
        all — the mock cost nothing and proved nothing. Deleted rather than rewritten.
        `useWrapNative.test.jsx`'s own fake was the documented shape: `new Contract(address, …)`
        ignoring its first argument, so a balance read aimed at the wrong contract OR the wrong
        chain passed every assertion. Both are recorded and asserted now — and the moment the
        address became load-bearing, the file's `HW` fixture turned out to be
        `'0xHaRd0000…'`, which is not hex. It had never been an address; nothing had ever looked.
        **The no-chain e2e spec was run locally** (`40-account-add-wrap-move.cy.js`, 8/8).
      - **`useVouchers.js` — DIVERGENCE 21, a topic-filter difference in the shared seam, and the
        read-routing decision the rest of the hooks all turn on.** Allowlist 30 → 29.
        **THE READ-ROUTING DECISION, made once here and not per hook.** Every remaining hook
        (`useTransfer`, `useVouchers`, `useOpenChallenge*`, `useFriendMarketCreation`) reads through
        `new Contract(addr, ABI, provider)` where `provider` is `WalletContext`'s
        `provider || rpcProvider` — i.e. the INJECTED WALLET's provider for a classic session.
        Two things follow from that and neither is wanted: a member's own endpoint (spec 069) does
        NOT apply to these reads, because the wallet wins the `||`; and on a chain the build does
        not know, `getNetwork` falls back to the HOME network, so the app reads one chain's state
        while the wallet sits on another — the ambient-chain defect Phase 3 exists to remove.
        Converting a read to `readContract(chainId, …)` drops the wallet leg. That IS a behaviour
        change, stated rather than slipped in: the member's configured endpoint now applies, and an
        unreachable chain becomes an honest `NoRpcEndpointError` instead of silently-correct-looking
        home-chain data. It is the direction both specs already point, so it is taken here and the
        remaining hooks follow it.
        **DIVERGENCE 21 — viem REFUSES a full signature as `functionName`.** ERC-721 overloads
        `safeTransferFrom`, and this hook named the 3-argument form explicitly —
        `encodeFunctionData('safeTransferFrom(address,address,uint256)', …)`, which ethers accepted.
        viem throws `AbiFunctionNotFoundError`; given the BARE name it instead picks an overload by
        matching the arguments it was handed. That lands on the same selector here, which is
        exactly what makes it worth writing down: the tempting fix (drop the parameter list) turns a
        choice the author STATED into a consequence of an argument list, and it is a one-word edit
        that reviews clean. The ABI is narrowed to a one-entry `parseAbiItem` instead, so the
        signature is still what selects the function.
        **The event seam was padding topic filters.** viem's `encodeEventTopics` emits one slot per
        INDEXED parameter, so `Transfer(null, to)` on a three-indexed event went out as
        `[sig, null, to, null]` where ethers sent `[sig, null, to]`. Semantically identical to a
        conforming `eth_getLogs` — but it is a difference in the bytes on the wire, and the failure
        it would cause is the quiet kind: a provider that rejects the longer form turns the scan
        into an EMPTY RESULT, which on every feed here renders as "nothing happened". Trimmed in
        `eventScanHandle`, checked against `Interface.encodeFilterTopics` for three filter shapes,
        verified non-vacuous.
        Also confirmed live: `voucherInfo` returns `tier`/`durationDays` as NUMBERS under viem
        where ethers gave bigints (**divergence b**) — the existing `Number(...)` wrappers already
        covered it — and `getTierConfig`'s single STRUCT output decodes to a named object in both,
        so `cfg.active`/`cfg.priceUSDC` are unchanged. Four encoders fuzzed 1,500 rounds × 3 address
        casings against ethers, all byte-identical.
        **The passkey test's fake was the documented shape again** — `FakeContract(_addr, abi)`,
        underscore and all, so a tier-config read against the TOKEN or an allowance read against the
        MANAGER satisfied every assertion. Each read now records its chain, address and arguments,
        and the purchase path asserts both targets; verified non-vacuous by pointing `getTierConfig`
        at the payment token. Its calldata decoding still uses the real ethers `Interface` as the
        oracle, which is the one thing that mock got right.
        **Vouchers have no no-chain e2e spec** (`33-transfers-swap-vouchers`,
        `43-voucher-send-from-portfolio` and `40-acting-account-purchase` are all on-chain tier), so
        as with the wager pools that leg is CI's, not a local run. Said rather than skipped.
      - **`useTransfer.js` — the read-routing decision's first money path, and a MIS-CHECKSUMMED
        fixture that had never been looked at.** Allowlist 29 → 28. Eight sites, all ordinary:
        `Interface` → `transferCall`, two `new Contract(token, ABI, signer).transfer(...)` →
        `signer.sendTransaction`, `formatUnits`/`parseUnits`/`isAddress` onto their seams. The
        `transfer` encoder was fuzzed 4,000 rounds × 3 address casings plus 0 / 1 / 2²⁵⁶−1, all
        byte-identical to ethers.
        Two of those are not cosmetic on this surface. `parseUnits` is now the seam that REFUSES
        over-precision (divergence 20) — on the send path that is the difference between sending
        what the member typed and sending a rounded neighbour of it. And the stablecoin balance
        moves onto `readContract(chainId, …)` per the read-routing decision, so the member's own
        endpoint applies and an unreachable chain fails honestly; the NATIVE balance still goes
        through `readProvider`, which is where the wallet-vs-RPC preference actually lives.
        **`useTransfer.balances.test.jsx` held the ONE assertion in the repo that pinned that
        routing** — it checked `new Contract(token, ABI, runner)` got the WALLET's provider on a
        classic session and the RPC provider on a passkey one. It is not deleted: it is restated as
        the new fact, and the new fact is worth having — the token read is now BYTE-IDENTICAL
        across session kinds, where it used to depend on how the member signed in. The native
        preference stays asserted by `getBalance` / `rpcGetBalance`.
        And the file's wallet fixture was `'0xAaAa…0001'`, which ethers' own `getAddress` REJECTS
        as a bad checksum. It had survived because the suite's fake `Contract` constructor took the
        address and ignored it, so nothing had ever checksummed it — the third fixture in three
        batches whose invalidity only became visible once the address became load-bearing. Frozen
        to its EIP-55 form.
        `41-group-pay` (11) and `40-account-add-wrap-move` (8) run locally, green.
      - **DIVERGENCE 22 — a viem error HIDES the revert bytes behind `cause`, and
        `rawRevertCandidates` reached none of them.** Found while converting the first
        `staticCall`: the pre-flight on the open-challenge accept path exists to turn a revert into
        a sentence a member can act on, and `lib/wagers/sanctionsRevert.js` recovers
        `ISanctionsGuard.SanctionedAddress` BY SELECTOR because the registry ABI cannot decode it.
        All of that runs off `rawRevertData`, whose candidate list was FIVE FIXED EXPRESSIONS —
        right, because the shapes ethers and the wallets produce are five fixed expressions.
        viem is not like that. It wraps each layer in a typed error and chains them through `cause`:
        `ContractFunctionExecutionError.cause` → `ContractFunctionRevertedError.raw` at depth 1 when
        the node error is pre-decoded, or `.cause.cause.cause.cause.data` at depth 4 when it is not.
        Two different keys, two different depths, both MEASURED rather than remembered. None of the
        five paths reaches either, so converting any `staticCall` without fixing this first would
        have silently replaced a screened member's explanation with "execution reverted (unknown
        custom error)" — a regression invisible to every existing test, because every existing
        fixture is an ethers-shaped error.
        The walk is now breadth-first over `cause`/`error`/`data`/`info.error`, depth-bounded and
        cycle-guarded, harvesting `data` and `raw`. Widening what is READ never widens what is
        CLAIMED: `extractRevert` still keeps walking when a candidate does not decode, so an extra
        candidate costs a failed parse and nothing else — asserted by a case whose bytes belong to
        no ABI here and still resolve to `null`.
        **The fixtures are REAL viem errors**, produced by driving a real `readContract` against a
        transport that throws, not objects shaped the way the test remembers viem. That is the
        distinction that matters: a hand-built fixture would have agreed with whatever the walk was
        written to expect, which is precisely how the original list came to miss every viem shape.
        Verified non-vacuous by restoring the five-path list — all three viem cases fail.
      - **Open challenges (`useOpenChallengeAccept` + `useOpenChallengeCreate`) — and DIVERGENCE 23,
        the one that would have cost nine sentences.** Allowlist 28 → 26. The pair moved together
        (siblings sharing `resolveRegistry`), and the first `staticCall` conversion in the task is
        what surfaced both revert divergences.
        **DIVERGENCE 23 — viem puts a decoded CUSTOM ERROR's name in NO MESSAGE.** ethers exposed it
        as `error.reason`, which is exactly how every translator here is written:
        `r.includes('NotOpenChallenge')`, `r.includes('MembershipDenied')`, nine of them on the
        accept path alone. viem's `shortMessage` for the same revert is the whole of
        `The contract function "acceptOpenWager" reverted.` — the name is on `cause.data.errorName`
        and appears nowhere else. So converting the pre-flight without this would have replaced
        nine distinct explanations with "Acceptance failed. Please try again." for every one of
        them, with nothing red anywhere. (`Error(string)` happens to survive, because viem folds
        the reason string into the message — which is what would have made this look fine in a
        quick check.) `extractRevert` now finds a PRE-DECODED revert anywhere in the chain, and
        `revertReasonFrom` prefers it over message text, unwrapping `Error`/`Panic` to the string
        they carry. Tested with REAL viem errors driven through a throwing transport, and verified
        non-vacuous.
        Everything else was ordinary and byte-checked: `MaxUint256`/`ZeroAddress`/`ZeroHash` are
        identical constants, `keccak256(toUtf8Bytes(s))` ≡ `keccak256(stringToHex(s))` over 3,000
        fuzzed references including multi-byte UTF-8, and `createOpenWager` (eleven arguments) plus
        `acceptOpenWager` byte-match over 1,000 rounds each. `createOpenWager.staticCall(...args,
        {from: actor})` becomes `readContract(chainId, {…, account})` — the caller stays EXPLICIT
        because `_runAcceptGuard` screens BOTH parties, so who is asking changes the answer.
        **Two more fixtures that had never been looked at**: `deriveFromCode` returned
        `claimAddress: '0xclaim'` and the wager's creator was `'0xCreator'` — neither is hex. Same
        cause as the previous three: the claim address only ever reached a `FakeContract(address)`
        that took it and ignored it.
        **And the mocks' calldata was the mocks' own strings.** Both suites asserted that the
        passkey batch carried `'0xapprovecalldata'` / `'0xacceptcalldata'` / `'0xcreatecalldata'` —
        i.e. that the hook forwarded a fake's return value. Every write is now DECODED with the
        real ethers `Interface`: the approve is checked to be for the REGISTRY at `MaxUint256`, the
        accept to carry this wager id and this claim-code proof, the create to carry this claim
        commitment, token and stake.
        **Rule (d) earned again, sharper.** The first non-vacuity probe on the accept path patched
        the passkey branch while the assertion covered the SIGNER branch — the suite stayed green
        and the fault was real. Reintroducing it on the path the assertion actually covers failed
        as it should, and the miss is what showed the passkey batch had no calldata assertion at
        all. "Reintroduce the fault" is not enough; it has to be on the path under test.
        `35-navigation-and-lookup.cy.js` (6) run locally, green.
      - **`useFriendMarketCreation.js` — the largest single hook in the task (736 lines, five write
        rails), and no new divergence.** Allowlist 26 → 25. That is worth saying: after twenty-three
        findings, a conversion that produces none is evidence the register is converging rather than
        evidence nobody looked. Everything here was byte-checked — `createWager` and
        `createWagerWithTerms` (twelve and thirteen arguments) plus `batchExpireOpen`'s id array over
        1,000 fuzzed rounds, `keccak256(toUtf8Bytes(ref))` over the metadata reference, and the
        `getUserWagers` offset which changed from the literal `0` to `0n` (identical calldata either
        way, checked rather than assumed).
        **One shape changed and it is the task's own thesis in miniature.** `expireStaleWagers` took
        an ethers `Contract` and dug a provider out of it — `registry.runner?.provider ||
        registry.provider` — then asked THAT provider for its network to decide which chain's
        MembershipManager to resolve. Where the read happens was being derived from who the contract
        was bound to. It takes `(chainId, signer, registryAddress, …)` now; the chain is stated.
        `typeof registry.createWagerWithTerms === 'function'` — an ethers feature probe for the
        spec-007 overload — becomes an explicit ABI lookup, which is what the probe was reading
        anyway. The five rails (vault proposal, acting-account batch, passkey UserOp, gasless intent,
        self-submit) keep their exact branching; only the encoding and the reads moved, and
        `estimateGas` + the fee overrides ride on `signer.estimateGas`/`sendTransaction` unchanged.
        **`actingWagerWrites.test.jsx` keeps its `vi.mock('ethers')` ON PURPOSE** — it drives TWO
        surfaces and `MarketAcceptanceModal` is still an ethers consumer, so the mock still has a
        job. Its `batchFns()` helper used to split the fake's `0xENC:<fn>:<args>` marker; it decodes
        a real selector now for the converted half and falls back to the marker for the modal's,
        with the reason named in place so the branch disappears when the modal converts. The
        connected signer gained a `sendTransaction` SPY rather than being left without the method:
        an absent method would make the acting tests pass by throwing, which proves the write did
        not happen but not that it went anywhere right. Both FR-001 claims verified non-vacuous —
        reading the connected wallet's balance fails 6 tests, simulating as the connected wallet
        fails the one that exists for it.
        `04-wager-creation-validation.cy.js` (14) run locally, green.
      - **`useTreasuryVault.js` — DELETED, not converted.** Allowlist 25 → 24. It was the next
        candidate by size (19 ethers uses, 522 lines), and the first thing the survey turned up is
        that it has **no importers anywhere** — not in `components/`, `pages/`, `hooks/`, the
        cypress suites, or anything outside the repo's own bookkeeping. Its contract is
        `contracts-archive/treasury/TreasuryVault.sol`, and CLAUDE.md says that directory is
        "reference-only; never import or deploy it". No network configures `treasuryVault`, so
        `TREASURY_VAULT_ADDRESS` was permanently `null`, which made `readContract`/`writeContract`
        permanently null and every one of the hook's twelve functions an early return or a throw.
        Converting dead code for an archived contract buys nothing and pays for it twice — once in
        the change, and again every time someone reads it and believes it is live. Deleted, on the
        precedent `utils/encryption.js` set earlier in this PR (no importers + a latent defect →
        deleted rather than converted). The repo's own guard test already annotated it "legacy:
        treasuryVault not deployed on v2".
        **The deletion found a gap in a DIFFERENT gate.** `chainResolutionGuard`'s `ALLOW` baseline
        had no staleness check, so this hook's entry would have sat there indefinitely matching
        nothing. That is not merely untidy: the baseline is keyed by PATH, so a stale entry
        silently hands its permitted ceiling to whatever is written at that path next. It now fails
        on an entry naming a file that does not exist — the same discipline `LEGACY_COLLISIONS`
        keeps in `check-spec-registry.js`, and verified non-vacuous with a bogus entry.
        The lint baseline moves 180 → **178**: both warnings belonged to the deleted file, checked
        by restoring it and counting rather than assumed from the delta.
      - **A CI red that was NOT this branch's, and the register's own lesson (b) finding it.**
        `MiniAppWorkspace.test.jsx` went red once on `b8c70146` — a commit that deletes a hook with
        no importers and adds a staleness check, i.e. touches nothing that file can reach. 1 failed
        of 9,504, on a focus assertion, and it passes locally 5/5 alone and in every sweep.
        It is not a flake to re-run away: it is **a race phrased as an invariant**, the same defect
        this task already recorded in its own guards. The test did
        `await screen.findByText(...)` and then asserted `document.activeElement` SYNCHRONOUSLY —
        but `findByText` resolves on the commit that rendered the package, while the focus move is
        a separate `useEffect` gated on `launch.phase`. Two different moments. The ordering holds
        on an idle machine running 33 tests and stops holding inside a full 828-file run, which is
        why only CI ever saw it — and why a file deletion, which reshuffles the full run's file
        ordering, is a plausible trigger for something that was already latent.
        Its own SIBLING test, making the identical claim about the refusal heading, already used
        `waitFor`. This one was the outlier. Fixed to match, which changes what is asserted not at
        all — focus ARRIVING on the heading is the claim; the instant it arrives never was.
        Verified non-vacuous by deleting the focus call from the component: the `waitFor` version
        still fails.
      - **`MarketAcceptanceModal.jsx` — the accept-side twin, and TWO more fixtures that were never
        valid.** Allowlist 24 → 23. Converting it closes the loop the friend-market batch left
        open: that batch had to teach `actingWagerWrites.test.jsx`'s selector helper to fall back
        to the ethers fake's `0xENC:<fn>:` marker because the modal was still an ethers consumer.
        The modal is converted, so the fake, the `vi.mock('ethers')` and the fallback are all GONE
        and both surfaces in that file now assert real calldata by real selector.
        **DIVERGENCE 23 again, on the error path this time.** The modal's own comment said it
        plainly — "selectors omitted — ethers v6 already surfaces the named error in
        `err.shortMessage` / `err.reason`" — and five `knownRevertReasons` patterns plus four
        decline-path patterns are matched against exactly that string. viem puts a decoded custom
        error's name in neither. Both now read through `revertReasonFrom`, which knows both shapes;
        without it every one of those nine would have degraded to its generic sentence the moment a
        revert came back through the chain seam.
        **The fixtures.** `marketId="wager-1"` was being encoded into `acceptWager(uint256)` and
        `contractABI={[]}` was the ABI it was encoded against. NEITHER library can do either —
        checked, both throw — so the batch shape this suite has been asserting was built over
        calldata no real encoder could have produced. Sixth and seventh fixture in seven batches to
        be invalid for the same reason: `new Contract(address, abi, …)` fakes ignore the address,
        the ABI and the arguments, so nothing had ever looked at any of them. Real ABI, encodable
        id, and the batch assertion is now a decode.
        The connected wallet's write spies collapse to ONE (`connectedSignerWrite`), because after
        conversion the signer rail is `sendTransaction` for both surfaces rather than two
        signer-bound contract methods — and it is a spy rather than an absent method on purpose:
        a missing method would make the acting-account tests pass by throwing, which proves the
        write did not happen but not that it went anywhere right. Verified non-vacuous by swapping
        `acceptWager` for `declineWager` in the acting batch (3 tests fail).
        `04-wager-creation-validation.cy.js` (14) run locally, green.
      - **A REAL REGRESSION, shipped nineteen commits ago and green the whole time:
        `StakingTab`'s pause/resume and provider-address forms were DEAD.** Found by the on-chain
        tier (`31-earn-lend-stake` ES-03: "Expected to find content: 'Resume staking' … but never
        did"), on the first head this session where Cypress Full E2E shard 3 was not CANCELLED by
        the next push — it had been cancelled on all ten preceding heads, and last succeeded on
        `5583c978`.
        The conversion turned `write` from a signer-bound contract into a FUNCTION
        `write(functionName, args)`. Two call sites kept the retired shape `write()[fn](...)`:
        `write()` now returns a **Promise**, so `promise['pause']` is `undefined` and the call
        throws `TypeError: write(...)[fn] is not a function`. `togglePause` (US2, GUARDIAN) and
        `setPair` (US3, the Lido/sPOL/POL address forms) were both dead on the operator's console.
        **This is the SAME defect shape this tab already produced once** — the earlier batch
        recorded that turning `routerRead` from an object into a function left
        `routerRead.queryFilter` undefined and the history scan failing silently. Same file, same
        cause, the other half of the pair. A conversion that changes a helper from an OBJECT to a
        FUNCTION has to be grepped for `helper()` with no arguments, every time.
        **Why the unit suite was green: `runTx` was `vi.fn(() => Promise.resolve())`** — it
        ignored the thunk it was handed. Every assertion in the file ("dispatches pause",
        "dispatches add and remove") checked only that the tab CALLED `runTx` with the right toast
        message, and the toast is right even when the write throws. `runTx` now INVOKES the thunk,
        the signer is a spy, and each test decodes the sent calldata by selector — verified
        non-vacuous by restoring the original line, which fails with the exact runtime TypeError.
        That is rule (c) at the level of a TEST HARNESS rather than a fixture: the harness could
        not distinguish "dispatched" from "dispatched something that works".
        **Method note: a cancelled shard is not a green one.** Ten consecutive heads reported
        `cancelled` for shard 3 and the check-in prompt correctly says cancelled is not a failure —
        but it is also not evidence, and a fast push cadence can starve an expensive tier of ever
        running. Worth watching for on any branch that pushes faster than its slowest tier.
      - **`DexContext.jsx` — four contract instances become four addresses, and a spec-069 bypass
        on the cross-chain quote.** Allowlist 23 → 22. The four `new Contract(addr, abi,
        readProvider)` memos held nothing a provider was needed for: the reads name the chain now
        (`readContract(chainId, …)`) and the encoders are module-level, so `contracts` is just the
        four ADDRESSES plus the gate. `readProvider` stays in the gate rather than the read — it is
        what answers "is there anything to read with", and `fetchBalances` still uses it for the
        NATIVE balance, which is a provider call and not a contract call.
        **The spec-069 bypass.** `getBestQuoteOn` built its off-chain quoter with
        `makeReadProvider(NETWORKS[target].rpcUrl, target)` — hand-building a provider from
        `NETWORKS[chainId].rpcUrl`, which spec 069 forbids in as many words. A member who had
        repointed Base in Network settings was quoted through the build default anyway. The quote
        reads through the endpoint seam now, so the override applies.
        `lib/uniswap/quote.js` is NOT touched: it already imports no ethers and duck-types the
        quoter on `quoter.quoteExactInputSingle.staticCall(params)`, deliberately, so that a
        cross-chain quote and a local one are the same computation. A `quoterOn(chainId, address)`
        adapter satisfies that duck type from the seam — the same move `resolvePool`,
        `factoryReaderFor` and `getLogsRange` make with their readers. The adapter also CHECKSUMS
        the struct's `tokenIn`/`tokenOut`: that is the boundary where a caller's struct meets an
        encoder, and `quoteBestRoute` builds the struct from whatever it was handed and has no
        encoder of its own to answer for (divergence 16).
        **The cross-chain test asserted the bypass.** It checked
        `makeReadProvider` had been called with `NETWORKS[8453].rpcUrl` — i.e. it pinned the
        forbidden construction. The claim underneath ("Base's own quoter, because Base does not
        share Uniswap's canonical addresses") is right and is kept, restated against the quoter
        itself: `quoter.address` and `quoter.chainId`, which the adapter now carries precisely so
        WHERE a quote is read is checkable rather than inferred from a constructor's arguments.
        Verified non-vacuous by quoting the connected chain's id instead of the target's.
        Four encoders fuzzed 1,200 rounds × 3 address casings against ethers (ERC-20 `approve`,
        WNative `withdraw`/`deposit`, `exactInputSingle`, `quoteExactInputSingle`), all
        byte-identical. `quoteExactInputSingle` has FOUR outputs, so `res[0]`/`res[3]` in
        `quote.js` keep working against viem's bare array.
        `26-trade-account.cy.js` (3) run locally, green.
      - **`submitAsActiveAccount.js` + `RecoverAccountPanel.jsx` — and the vault proposal path
        finally gets a test.** Allowlist 22 → 21 net (the panel leaves; its TEST joins the
        cross-library byte-check category, stated in the allowlist header rather than smuggled in).
        `submitAsActiveAccount`'s vault branch is two lines: the nonce read (`safe.nonce()` →
        `readContract(chainId, …)`, on the vault's own chain, which `assertSignerOnChain` has just
        proved the signer is on) and the approve (`safe.approveHash(h)` →
        `signer.sendTransaction`). **Its test file said, in its own header, that "the full vault
        emit+approve path is exercised via the app".** That was true and — after StakingTab — not
        good enough: an object→calldata conversion with no invoking test is exactly the shape that
        left a pause button dead for nineteen commits. Two tests now assert WHERE the nonce is read
        (the vault, on the vault's chain) and WHAT the approve carries (the computed `safeTxHash`,
        DECODED from calldata), both verified non-vacuous.
        `RecoverAccountPanel` is one read and one write, but the read is the CONTROLLER GATE — the
        check that decides whether this wallet may add a passkey to that account. Its `ethers`
        double was `class { constructor(target) { this.target = target } }`: it took the address
        and nothing ever read it back, so a gate aimed at the wrong account satisfied every
        assertion. The read's chain, address and argument are asserted now; pointing the gate at
        `target` instead of `walletAddress` fails it.
        **`BAD_DATA` is two spellings now.** The panel turns "that address answered, but not like a
        passkey account" into a sentence a member can act on, and it detected that by ethers'
        `BAD_DATA` / "could not decode result data". viem raises `ContractFunctionZeroDataError`
        and says the function "returned no data" — the same diagnostic this PR already had to stop
        rendering verbatim on the screening list. Both spellings are matched.
        `hardwareSigner.js` is deliberately NOT converted in this batch: it IS an ethers
        `AbstractSigner` implementation, and the whole app's write rail calls
        `signer.sendTransaction(...).wait()` against that shape. It converts with the contexts, not
        before. (T021's `primaryTypeOf` note stands and is separate.)
        `33-account-surfaces.cy.js` (6) run locally, green.
      - **`MyMarketsModal.jsx` — six write rails, one read, and the NINTH invalid fixture.**
        Allowlist 21 → 20. The file is 2,700 lines but the ethers surface is regular: six
        `selfSubmit` closures with the identical `new Contract(addr, ABI, signer)` shape, one
        `getWager` read, two `ZeroAddress` comparisons, and eight
        `new Interface(ABI).encodeFunctionData(...)` calls that never needed a runner at all. One
        module-level `registryCall` replaces all of them; `registry.interface.parseError` becomes
        `errorParser(WAGER_REGISTRY_ABI)`, the seam built for exactly this and already pinned
        against ethers' `Interface.parseError` by its own suite.
        Five encoders fuzzed 2,000 rounds against ethers, byte-identical.
        **`toMatch(/^0x/)` is not an assertion about calldata.** `actingWagerRefundResolve`
        checked the acting rail's payload with exactly that — and the fake it was checking returned
        the marker string `0xENC:<fn>:<args>`, which satisfies it. So the claim "resolves …
        addressed to the registry" covered the ADDRESS and nothing about what was being sent there.
        The selectors are frozen literals now (taken from ethers offline, so the cross-library
        check survives without an ethers import in the file), and the resolve test additionally
        asserts the winner came from the registry's OWN `getWager`, on the modal's chain.
        **And the ids were never encodable**: `'w-refund'` / `'w-resolve'` going into
        `claimRefund(uint256)` / `declareWinner(uint256,address)`. Neither library can encode
        either — the fake's `encodeFunctionData` returned its marker for any input whatsoever, so
        nothing ever tried. That is the ninth fixture in this task invalidated by the same root
        cause, and the pattern is now unambiguous: **a fake of `new Contract(address, abi, runner)`
        discards the address, the ABI and the arguments, so every assertion downstream of one is
        weaker than it reads.**
        `13-dashboard.cy.js` (16 + 2 pending) run locally, green.
      **`utils/blockchainService.js` — the last big one** (allowlist 20 → 19). 1,836 lines and
        ~67 ethers uses, of which a third turned out to be reachable by nobody: `getContract()`,
        `registerZKKey`, `grantRoleOnChain` and `checkRoleSyncNeeded` have **no importer in
        `frontend/src` or `frontend/cypress`** (only an ARCHIVED doc mentions `getContract`), so
        they were deleted rather than converted — writing tests for code nobody calls is the worse
        half of that trade. 389 lines out, and the `chainResolutionGuard` baseline TIGHTENS with
        them (12 → 5 build-bound address reads, 2 → 0 argless `getProvider()`), because a stale
        ceiling permits a regression it was only ever meant to record.
        **`getFriendMarketWithStatus` returns FOURTEEN outputs and is read by name** — the second
        consumer of divergence (a) found in this task, after `normalizePosition`. The seam's
        `withOutputNames` covers it; without it every legacy market would have rendered with an
        undefined stake, status and description.
        **`registerZKKey` had been returning `hash: undefined` since the v5→v6 migration**
        (`receipt.transactionHash`, which ethers v6 spells `receipt.hash`). Noted rather than
        fixed: the function had no caller, and it went out with the other three.
        Role hashes, the five membership encoders and the ERC-20 approve were fuzzed 2,000 rounds
        against ethers (14,012 comparisons in all, byte-identical, hex case included), and
        `formatUnits` over 9,000 random values × 3 decimal places.
        **Divergence 16 on a member path.** `fetchFriendMarketsForUser` validated with `isAddress`
        — which accepts an ALL-UPPERCASE address, as ethers did — and then handed the string
        straight to an encoder that refuses one. My Wagers would have shown an error where a
        member's wagers belong. Checksummed once, immediately after the check that let it through:
        the validator and the encoder move together.
        **Divergence 15 on the legacy market id.** A decimal string encodes identically in both
        libraries; the EMPTY one does not (ethers refused it, viem encodes 0). The ids come back
        through `localStorage`, so `BigInt(marketId)` now refuses exactly what ethers refused,
        inside the same try that already fell back to the cached market.
        **Three `vi.mock('ethers')` fakes replaced, and one of them was argument-less**:
        `intentParams`' `FakeContract()` took NO parameters at all, so every read satisfied it
        whatever the address, ABI or chain. `membershipReferenceChain` proved the reference-chain
        rule through a fixture spelled `0xmm${chainId}` — **not an address**; tenth invalid fixture
        in this task, and it survived for the usual reason. Both now assert the CHAIN each read was
        made on, which is the fact that decides where the answer comes from; the reference-chain
        probe fails on `askedOn` alone when the read is aimed at the caller's chain, with the
        address assertion still green.
        `blockchainService.userWagers.test.js` is new: the My Wagers registry path had NO test at
        all, and it is what two surfaces and the wager notification source call. Paging (100 at a
        time, two reads zipped by index), the chain, the three-state-free empty case and the
        uppercase-address path, each probed non-vacuous.
      **DIVERGENCE 24 — the transport RETRIED where ethers made one request** (found by CI, on the
        one screen whose whole job is to say it could not ask). viem's `http()` retries
        403/408/413/429/500/502/503/504 **and any error carrying no status at all**, three times
        at 150ms exponential; ethers retried exactly ONE status, 429, with its own throttle
        backoff, and made a single attempt at everything else (`FetchRequest.#send`, ~L470 —
        redirects followed, 429 retried, 5xx returned as-is). Measured through the real transport:
        a dead endpoint cost **4 requests instead of 1**, and on a chain with a curated failover
        **8 instead of 2**, because `fallback` carries its own retry of the WHOLE ordered sequence
        on top of its legs (it already zeroes the legs — asserting on a leg's `retryCount` passes
        with the fix removed, which is how the first version of this test was vacuous).
        That is not latency trivia here. Every three-state reader renders a failed read as
        `unreadable`, and the estate probe behind the console is a wide FAN-OUT — 8 admin roles ×
        every cohort chain, concurrently — in which `hasRoleOnChain` then walks its candidate
        contracts SEQUENTIALLY (ADMIN and GUARDIAN have three or four each). Multiplying every one
        of those requests by four, or by eight on a chain with a curated failover, and adding ~1s
        of backoff to each leg of a serial inner loop, is what turned a total outage from seconds
        into minutes before the console could say **"Could Not Verify Access"**.
        *(Corrected after the fact: the commit message for this fix said the sweep was
        `RoleContext` looping over roles. It is not — `RoleProvider` is never rendered anywhere
        (spec 110 deleted its sibling `Web3Provider` for the same reason), and the real sweep is
        `WalletContext`'s `Promise.all`, which is explicitly concurrent. The measured 4×/8× request
        multiplication and the e2e evidence are unaffected; the named mechanism was wrong and a
        reason nobody re-checks is how a wrong one survives.)* — the FR-012 screen, at exactly the moment an incident commander is trying to get
        in. `32-admin-console.cy.js` AD-03 (every chain dead) failed at both viewport profiles and
        was reproduced locally before anything was changed.
        Fixed at the seam: `retryCount: 0` on every transport AND on the fallback itself, with
        ethers' 429 throttle reproduced rather than dropped (`throttledFetch` — same trigger, same
        jittered slot backoff, same 12-attempt ceiling, `retry-after` honoured). One deliberate
        difference: ethers read `retry-after` as MILLISECONDS (`parseInt` straight into its wait)
        where the header is specified in SECONDS — an ethers bug, not a behaviour worth
        reproducing, and the suite says so. Both knobs are pinned by counting real requests
        through the real transport, each verified non-vacuous (4-instead-of-1 and 8-instead-of-2
        are what the probes print).
      **`lib/recovery/legacyKeys.js` — the LOCAL-KEY rail, and three divergences the on-chain
        tier could not have found any earlier than the unit suite did.** A recovered legacy
        account signs with a key this app holds, so nothing else populates its transactions: the
        nonce, the fee, the gas limit and the chain id all have to be filled in before anything is
        signed. That is what made it a different job from the wallet rail rather than the same
        swap twice — and most of it turned out to be already done. viem's `sendTransaction` runs
        `prepareTransactionRequest` for a local account, which fills exactly what ethers' `Wallet`
        filled, so the populator did not have to be written. `class ManagedLegacySigner extends
        ethers.NonceManager` is deleted rather than re-rolled. The chain became an ARGUMENT
        throughout (`chainId`, with `client` as the injection point) — `walletFromSecret(secret,
        provider)` split into `addressFromSecret` and `signerForSecret`, a rename rather than a
        signature change so a stale caller is a build error instead of an address-only object
        where a signer was wanted. Allowlist 17 → 16.

        **DIVERGENCE 28 — the fee read is not a drop-in, in two ways, and ETC is on the wrong
        side of both.** (a) viem's `estimateFeesPerGas` defaults to `type: 'eip1559'` and THROWS
        `Eip1559FeesNotSupportedError` when the latest block carries no `baseFeePerGas`, where
        ethers answered `gasPrice` with the 1559 fields null. **ETC 61 and Mordor 63 are exactly
        that kind of chain and they are in the cohort**, so a member recovering an account there
        would not have got a worse quote — the whole read would have raised. (b) the EIP-1559 max
        fee is `base × 1.2 + tip` (`chain.fees.baseFeeMultiplier`) where ethers' was `base × 2 +
        tip`. That margin is load-bearing HERE and almost nowhere else: the coin leg sends
        `balance − gasLimit × price` and PINS `maxFeePerGas` to that same price, so the headroom
        is the only thing covering a base fee that climbs between signing and inclusion. Halving
        it produces no error — it produces a transaction that never mines, which is the stranding
        the reserve exists to prevent. Reproduced in `lib/chains/feeData.js` (one seam, used by
        `providerLike.getFeeData` too) and checked against real ethers over the same fake node,
        1559 and legacy, including its 1-gwei tip fallback.

        **DIVERGENCE 29 — `tx.wait()` RESOLVES on a reverted transaction where ethers THREW, and
        this was already shipped.** ethers' `TransactionResponse.wait()` asserts on
        `receipt.status === 0` and raises CALL_EXCEPTION carrying the receipt; viem's
        `waitForTransactionReceipt` returns `status: 'reverted'` and no error. The adapter merged
        in #1618 passed that straight through. Roughly forty converted call sites are written
        against the throw — `MarketAcceptanceModal` and `useOpenChallengeAccept` both do
        `await approveTx.wait()` and then PAY, and the legacy sweep records the asset as sent — so
        a silently-resolving revert is a payment against an allowance that was never granted and
        an outcome that says a member's money moved. Fixed once, in `ethersCompat.waitForReceipt`,
        used by both signer rails; `provider.getTransactionReceipt`/`waitForTransaction`
        deliberately do NOT throw, because ethers' own provider methods returned a status-0
        receipt. Pinned by driving a real ethers signer and the adapter over the same reverted
        receipt and requiring both to reject.

        **DIVERGENCE 30 — viem's nonce manager has no stale-read guard AT ZERO, which is the
        account this module is about.** Its guard reads `if (previousNonce > 0 && nonce <=
        previousNonce) return previousNonce + 1`, so an account whose last consumed nonce was 0
        falls through it: a node still answering 0 hands the second transaction the first's nonce
        and it is refused "nonce too low". That is precisely the spec-098 approve-then-pay failure
        `ManagedLegacySigner` was written for, and a recovered account that has never sent
        anything is exactly the account it happens to. The header of the first draft of
        `localKeySigner.js` claimed viem "reproduces all three behaviours"; writing the test that
        was supposed to pin them is what showed the claim was true only above zero. Closed with a
        per-(account, chain) floor inside the manager's own SOURCE — so viem's re-read per send is
        kept and only the zero case changes — and `reset` drops the floor as well, because a send
        that threw consumed nothing. All four behaviours are pinned over a real signed envelope,
        and removing the floor fails exactly one of them.

        **Also found by the new tests, not by CI: the wallet client's transport carried viem's
        DEFAULT retries** — divergence 24 again, in a transport that DELEGATES to
        `publicClient.request`, so the default did not add retries, it multiplied them. It applies
        to probes that are meant to fail: viem asks a node for `eth_fillTransaction` before it
        populates, and a node answering anything other than "method not found" is asked four times
        per send. Measured at 5.3s per transfer; `retryCount: 0` brings the suite from 127s to
        3.3s.

        **The fakes were replaced, not ported.** `legacyKeysMultiAsset.test.js` mocked `ethers`
        itself: a `StubContract` whose constructor ignored the ABI and whose `transfer` recorded
        its own arguments. It could not fail on anything this module actually gets wrong — a
        transfer encoded against the wrong function, arguments in the wrong order, a chain id that
        never reached the signature — because nothing was ever encoded. Both suites now drive a
        REAL viem client over a fake EIP-1193 node that PARSES what it is handed, so every nonce,
        fee field and calldata assertion is about bytes a chain would have accepted. One
        assertion changed meaning as a result and the change is kept visible: a zero
        `maxPriorityFeePerGas` is RLP-encoded as an empty field, so a parsed transaction reports
        it absent — absent and zero are the same bytes, and the node cannot tell them apart
        either. Derivation parity (`derivationParity.test.js`) keeps real ethers as the oracle
        over generated phrases and keys: a wrong path here shows a member an address that is not
        theirs, tells them the import worked, and errors nowhere.
      **`lib/hardware/hardwareSigner.js` — THE INSTRUMENT FIRST, and it found four things before a
        single line of the conversion was written.** This file is the last of the four
        signer-shaped files, and it was the one with no way to check it: the fast tier has no
        chain, a real Nano needs a thumb, and every hardware suite mocks the session — so a fake
        that signs with an ethers `Wallet` key proved the signer's arithmetic and NOTHING about the
        APDUs, the derivation path the device used, or what a member would have been shown. The
        conversion was therefore NOT started first. Converting a file whose only oracle is a mock
        is how divergences 27a/27b shipped, and the same mistake was available here.

        The rail is **Speculos**, Ledger's emulator of the device: real app firmware, real APDUs,
        real screens, with the button driven by software. The confirmation gate is KEPT and
        automated rather than removed, which is what makes it a hardware test. `@ledgerhq/
        hw-transport` is ALREADY a direct dependency and the APDU endpoint is plain HTTP, so the
        transport is ONE FILE and the lockfile does not move — `device-transport-kit-speculos`
        would have re-resolved the root lockfile for a test rail, which is the npm/cli#4828
        rolldown hazard (spec 075) and a bad trade. Verified end to end against app-ethereum
        1.22.4 on an emulated Nano S+: 6/6, and non-vacuous — a wrong derivation path fails 3 of
        them, dropping the new error classification fails exactly 1.

        **FINDING 1 — a Ledger cannot sign our EIP-712 intents with default settings, and the app
        told the member to do something that can never work.** `signEIP712HashedMessage` hands the
        device two hashes; the app will only review those with BLIND SIGNING enabled. With the
        default settings the Nano's own screen reads "Blind signing must be enabled in settings"
        and the app answers 0x6a80 — which `classifyLedgerError` mapped to UNKNOWN, whose sentence
        is "Something went wrong talking to the device. Reconnect it and try again." A member
        reconnecting their device forever would never reach the toggle that fixes it. Now
        `BLIND_SIGNING_REQUIRED`, which names it.

        **FINDING 2 — the DEV guard did not keep the rail out of the bundle, and every test said it
        did.** `adapters.js` gated selection behind `import.meta.env.DEV`; `ledgerAdapter.js` then
        branched on a RUNTIME value (`requested === SPECULOS`) that the bundler cannot fold, so the
        production build emitted `speculosTransport-*.js` as its own chunk — a module that points
        device signing at an arbitrary HTTP origin, shipped, with the structural guard test green.
        `grep` over `dist` is what found it. A source-shaped test cannot see a bundler decision, so
        the constant is repeated inside the inner branch AND `check:no-emulator` greps the artifact
        on every PR's build job. This is the sharpest instance yet of the standing lesson: the
        instrument has to be able to observe the property, not a proxy for it.

        **FINDING 3 — ETC 61 is genuinely supported by the Ethereum app.** It renders "Ethereum
        Classic" and prices in ETC rather than an unnamed chain id, so 61 is a cohort chain in fact
        and not only in our config. Asked of the device instead of assumed, and asserted on the
        screens the member would read.

        **FINDING 4 — Speculos' own `--automation` cannot express what a hardware test needs, and
        both failure modes are SILENT.** (a) `text` is an EXACT match: the approve screen reads
        "Sign transaction", so `{text: "Sign"}` never fires and nothing errors — the catch-all
        keeps pressing right, the carousel loops, the APDU never returns and the suite HANGS.
        (b) rules fire per TEXT EVENT, not per screen (`seproxyhal.apply_automation` loops the
        batch), and one screen emits several — "Network" and "Polygon" are two — so a catch-all
        advances TWICE and overshoots the decision screen; the both-press lands on "Reject
        transaction" and every signature returns 0x6985, which reads exactly like a device
        refusing. The suite therefore DRIVES the screen itself (poll, press once, collect), which
        is what Ledger's own app tests do, and collecting the screens buys the assertion that
        matters: what the member would actually have read, including the destination address the
        device displayed.

        Also measured and written down: jsdom's `fetch` drops Speculos' chunked body (its first
        chunk is empty), returning `''` where the device said `{"data":"…"}` — so the suite has its
        own config pinned to `environment: 'node'`, and is excluded from the default one.
        The conversion off ethers is the NEXT commit, with this suite as its oracle: it passes
        against the ethers implementation today, and must still pass after.

        **THE CONVERSION — and the oracle earned its keep twice.** `AbstractSigner`, `getAddress`,
        `Signature`, `Transaction` and `TypedDataEncoder` are gone; allowlist 16 → 15, which empties
        the signer-shaped files. The device suite is **6/6 after the swap**, unchanged, and the
        unit suite keeps REAL ethers as the oracle over a 35-case serialization matrix ({7 fee
        shapes} × {1, 61, 63, 137, 80002}) asserting the signed envelope BYTE FOR BYTE plus the
        unsigned bytes the device was shown — a fixture table would only have proved viem agrees
        with itself. `sendTransaction` is the signer's own now (`prepareTransactionRequest` →
        device → `sendRawTransaction`), on the chain it was BOUND to: the third constructor
        argument stopped being an ethers `Provider` and became a `{ chainId, client }` binding, and
        one passed anyway is REFUSED at construction rather than left quietly unable to send.

        **DIVERGENCE 31 — viem SILENTLY DROPS a field that contradicts an explicit transaction
        type, where ethers refused to serialize at all.** `{ type: 0, maxFeePerGas: … }` came out
        as a legacy transaction with `gasPrice` 0: unmineable, built from a request that asked for
        something else, with nothing raised. ethers' two refusals ("legacy transaction cannot have
        accessList", "transaction type cannot have maxFeePerGas or maxPriorityFeePerGas") are
        reproduced verbatim — they are exactly the 10 cases in the full inference matrix where the
        libraries disagree, and every one of them is ethers refusing. Related and quieter: ethers'
        `Transaction.from` picks the HIGHEST type its fields admit, so a request carrying only
        `gasPrice` is type 1 (EIP-2930, empty access list) and one carrying no fee fields at all is
        type 2 with ZERO fees — viem infers `legacy` for the first and refuses the second. That
        rule is written out in `transactionTypeOf`; replacing the `gasPrice` branch with viem's own
        answer fails 5 matrix cases.

        **DIVERGENCE 32 — viem's LEGACY serializer requires `v` as a BIGINT, and the only chains it
        can bite are the two no EIP-1559 test would have covered.** Handed ethers' `{ r, s, yParity
        }` it throws `Cannot mix BigInt and other types, use explicit conversions` from inside the
        library, naming neither the field nor the transaction — so it presents as an unrelated bug.
        It fires only on a chain with no EIP-1559, which in this cohort means **ETC 61 and Mordor
        63**. The device suite is what makes that concrete rather than theoretical: reintroducing
        the `yParity` shape, the emulated Nano displays the full transaction, the member presses
        **Sign transaction**, and THEN the TypeError lands — a physical confirmation spent on a
        signature that was never assembled. `signatureForViem` converts once, for every type, and
        also keeps ethers' 32-byte length check on `r`/`s`: viem would instead trim a short value
        into a shorter RLP item, which the recover-and-cross-check reports as "a different account"
        — a true statement naming the wrong cause, on the one screen where the cause matters.

        The typed-data half is the one thing the device suite CANNOT witness, and that is stated
        rather than glossed: its EIP-712 case asserts the blind-signing refusal (FINDING 1), which
        arrives before the hashes are examined, so `hashDomain`/`hashStruct` parity with
        `TypedDataEncoder` is pinned by the unit suite instead — over five domain shapes including
        `salt` and the empty domain, and a nested `Person[]` table.
- [ ] T029 E2E per spec 094. **One row of four flipped, and the other three are blocked on the
      PRODUCT rather than on a test — which is the finding, not an excuse.** Asking what each row
      needed before writing it is what surfaced that; a test written anyway would have passed by
      never reaching its subject (anti-pattern 7).

      **`multichain.refused-switch-discloses` → covered (no-chain), and it found a live
      divergence on its first run.** `fast/50-multichain-write-seam.cy.js`. The row's claim is the
      GENERALIZATION — one sentence on every write surface — and that is not what the two existing
      tests prove: `full/45-wrap-cross-chain` WXC-02 and `fast/42-protect-vault-sheet` VS-04 each
      assert that their surface names both chains, which a surface with a sentence entirely of its
      own satisfies. So MCW-03 drives two unrelated surfaces in one test and requires the two
      sentences, with the subject noun and the chain names normalized out, to be BYTE-IDENTICAL.

      It failed immediately. `VaultQueueView` was still carrying a **fifth private copy**: *"Approval
      not sent — this proposal is on Base, and the wallet stayed on Polygon."* T026 unified the
      switch-then-settle LOOP, and that unified the sentence for every surface that runs the loop —
      but this surface legitimately runs its own (switch, then defer the action until the proposals
      hook has re-bound to the row's chain, which `settleWalletOn` does not model), so the
      unification never reached it. It named both chains, which is exactly why every test looking at
      the chain NAMES passed and nothing saw it. The fix is the smallest one that makes the claim
      true: `submitOn.js#chainSwitchRefusal` composes the sentence, `settleWalletOn` uses it, and a
      surface with its own settle can still speak it — the NOUN stays the caller's ("This approval"
      belongs in a queue row). Restoring the private sentence fails MCW-01 and MCW-03 and leaves
      MCW-02 passing, which is the shape a real gate should have.

      **`multichain.rail-unavailable-before-tap` → still absent, and the reason is structural.** The
      behaviour is live (`vault-queue-norail`, `wrap-rail-unavailable`) and unit-tested, but the only
      branch any surface can actually reach is passkey-on-a-bundlerless-chain. That needs a REAL
      passkey identity — `loginMethod` is derived from the wagmi connector id, so the no-chain tier
      cannot produce one without asserting against its own fake — and the account-native tier, which
      can, configures a bundler on **Amoy only** and connects to Amoy, so no bundlerless chain is
      reachable there either. `proposedTier` moved to `account-native` and the row records the
      blocker. The other half of the row, "vault signer elsewhere", is not wired at all: no surface
      passes `walletChainId`/`canSwitchChain` to `resolveWriteRail`, so reachability is `unchecked`
      in production and a cross-chain vault row switches AT the tap instead — which IS covered, by
      VS-04 and now MCW-01.

      **The two on-chain rows are blocked on T040/T041.** `multichain.claim-on-action-chain` has no
      surface to test: `MyMarketsModal` calls `switchNetwork()` with NO argument, resolves the
      registry from the wallet's chain, and refuses with "Please switch to the correct network" —
      naming neither chain — while `FriendMarketsContext` reads ONE chain (`useChainId()`), so a
      wager living on another network is never listed and the test cannot establish its
      precondition. `multichain.intent-signs-without-switch` is the same shape one layer down:
      `useGaslessWrite` has accepted `cfg.chainId` since T027, and **all 22 production call sites
      omit it**, so every intent is still signed against the ambient chain's domain. The capability
      exists in the seam and nothing names a chain through it yet.

## Phase 3 — Ambient-chain ban (#1594)

- [x] T030 Lint ban on `useChainId()` (wagmi) in `frontend/src`; wallet location reads
      `useAccount().chainId`; target chains come from actions. **17 call sites across 14 files → 0.**

      **The ban rides INSIDE the existing `no-restricted-imports` rule, and that is not a style
      choice.** eslint flat config REPLACES a rule rather than merging it, so a second block
      setting `no-restricted-imports` would have silently switched the ethers ban off for every
      file it matched — a lint rule that quietly disables another lint rule is the worst possible
      shape for a gate. The cost of sharing the rule is that its `ignores` (the 15-entry
      `ETHERS_ALLOWLIST`, plus `src/test/**`) exempt those files from the wagmi ban too, so
      `src/test/lint/ambientChainBan.test.js` walks the shipped tree independently and sees exactly
      the files the rule cannot.

      **DIVERGENCE 33 — the fallback was wagmi's default chain, and nine call sites had already
      written down that they wanted something else.** `useWalletChainId` fell back to
      `useChainId()` when there was no connection, which looked equivalent to the build's own
      default and is not: wagmi's is `chains[0]` = **Polygon**, a MAINNET chain, and it stays
      Polygon in a TESTNET build where `getCurrentChainId()` is Amoy. That is the cohort-crossing
      read constitution III forbids, served to every disconnected member of a testnet build.

      It also explains something that read as deliberate and never worked. Nine call sites wrote
      `useChainId() || getCurrentChainId()` — an explicit fallback to the build's chain that could
      **never fire**, because `useChainId()` always returns something. They were asking for
      precisely what the hook now does and silently getting Polygon. Those `||` clauses are
      deleted rather than carried over: dead code that documents an intention the code did not
      have is worse than no comment.

      **The test fixtures were the bulk of the work, and converting them was the honest option.**
      ~20 suites steered the app with `useChainId.mockReturnValue(x)` against a global wagmi mock.
      Keeping that knob alive would have left a mock of a banned hook as the way every test says
      where the wallet is — the same "headroom where it could quietly return" the ethers ratchet
      test exists to close. So the global mock's `useAccount` carries `chainId`, its `useChainId`
      is gone, and suites steer the CONNECTION through `src/test/helpers/walletChain.js#setWalletChain`,
      which merges rather than clobbering whatever the suite already configured.
- [x] T031 Honest rendering for a wallet on a chain absent from the build (acceptance scenario 7),
      with a test: `src/test/network/walletChainId.test.jsx`. With the wallet on **BNB 56** —
      deliberately absent from `src/wagmi.js` — `useWalletChainId` reports 56, `useNetworkMode`
      returns `network: undefined` and `mode: 'other'`, and nothing names a configured network.
      Both halves are non-vacuous: restoring wagmi's default as the fallback fails the fallback
      test, and restoring `getNetwork()`'s forgiving lookup in `useNetworkMode` fails the
      scenario-7 test — each exactly one.

      **DELIBERATE DEVIATION — `hooks/useWalletChainId.js` is KEPT, where #1594 says to delete it.**
      The issue's reasoning is sound and its conclusion followed from a premise this task changed:
      the file "existed purely as the workaround" for `useChainId()`, so banning the hook should
      leave nothing to work around. But the file does two things, and only one of them was the
      workaround. It also owns the DISCONNECTED fallback — and divergence 33 is exactly the
      finding that this fallback is a decision with a wrong answer available. Deleting the file
      means every one of ~17 call sites re-inlines `useAccount().chainId ?? <something>`, and the
      first one to write `?? useChainId()` out of habit, or to omit the fallback and hand a
      surface `undefined`, does so with no gate watching. That is the four-copies-of-a-loop shape
      T026 spent this spec's own effort removing. The file stays as the ONE seam, and it no longer
      imports wagmi's chain hook at all — which is what "the workaround is gone" actually means.

## Phase 4 — Surfaces name their target (#1595)

- [x] T040 Estate-wide wager reads, and the actions carry their wager's chain.
      `lib/wagers/estateWagers.js` + `hooks/useWagerChain.js`. **Pools are NOT included — see the
      note at the end.**

      **The read and the write had to move together.** An estate-wide list with an ambient-chain
      Claim is worse than either half alone: it shows a member their Base wager and then claims it
      on Polygon. So this task is both — the list spans the cohort, and every action resolves its
      registry from the WAGER's chain.

      **Three states, and one of them was hiding.** `fetchFriendMarketsForUser` answers `[]` for
      two different situations — this chain has no wager contract, and this chain reported no
      wagers — and THROWS for a third. The deployment question is now asked BEFORE the fetch, so a
      chain with no contract is `not-deployed` rather than a claim about the member; an
      unreachable chain is `unreadable` and NAMED (`unreadableNetworks`), never "you have no
      wagers on Base". The test cohort supplies a real not-deployed case (Sepolia, Hoodi), so that
      branch is exercised against the actual roster rather than a contrived id.

      **DIVERGENCE 34 — `switchNetwork()` with no argument goes to PRIMARY_CHAIN_ID.** Every action
      in My Wagers opened with `if (!isCorrectNetwork) { await switchNetwork() }`, which moved the
      member to **Polygon** whatever chain the wager was on, and then resolved the registry from
      the ambient chain. It never mattered only because the list was single-chain: the wager could
      not be from anywhere else, so the wrong target happened to be the right one. The refusal —
      *"Please switch to the correct network"* — named neither chain. `settleOnWagerChain` names
      both and says nothing was signed.

      **THE STALE-CLOSURE TRAP, and why the list re-enters rather than continues.**
      `useGaslessWrite` binds its chain at RENDER: the EIP-712 domain, the verifying contract and
      the relayer all come from the chain current when the hook ran. A handler that settles the
      wallet and then calls `run()` in the same invocation still holds the PRE-switch closure — it
      would sign the old chain's domain, which is a valid signature over something nobody honours
      (issue #1038 by another route) and then self-submit to the old chain's address on the new
      chain. So a cross-chain action RETURNS after settling and the handler is re-entered once
      React has re-rendered, where the ambient resolution is correct by construction. The two
      detail views need none of that: they show ONE wager, so its chain is fixed at render and is
      handed straight to `useGaslessWrite`, whose T027 wrapper settles the self-submit leg itself.

      **The passkey rail is not switched** (`submitOn`'s rail rules): its UserOp addresses the
      target chain's bundler directly, so the target is returned and the wallet is left alone.

      Scenario 6, partially: ResolutionModal's **"Wrong Network → Switch Network" banner is gone**,
      along with the `!isCorrectNetwork` disable that would have blocked every cross-chain resolve.
      The remaining switch call sites are T041.

      **POOLS ARE NOT DONE.** The task says "wager/pool"; this is wagers only. `usePools` has its
      own eight `useGaslessWrite` call sites and its own read path, and folding them in here would
      have doubled a money-path diff that already spans a 2,400-line modal. Recorded rather than
      quietly dropped.
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
