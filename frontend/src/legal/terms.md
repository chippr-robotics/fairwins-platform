# FairWins — Terms & Conditions


---

## Key Points — Please Read

Before you agree, understand the following in plain language. The full terms below control, but these are the points that matter most:

- **FairWins is software, not a bookmaker.** You wager directly against other people. FairWins is never the other side of your bet, never sets odds, never holds your money, and never takes a cut of any wager.
- **Your membership fee buys access only.** It is not a bet, not a deposit, and not refundable.
- **Some things you do here carry a fee, and you always see it before you sign.** Wagers, pools, and sending money carry no FairWins fee. Certain other services do, and some outside venues pay us out of the fee they already charge, at no extra cost to you. Section 4.3 lists every way we earn, in full.
- **You can lose everything you wager.** There is no insurance and no regulator you can appeal to.
- **Perpetual futures and other leveraged products trade on someone else's venue.** They can be liquidated and lose your entire stake during ordinary market movement. Your own wallet owns the position — FairWins does not execute, hold, or guarantee anything, and cannot reverse or recover a trade.
- **You must qualify to use FairWins.** You must be at least 21, not located in a restricted jurisdiction, and not subject to sanctions.
- **You control your own wallet.** If you lose your keys, no one — including FairWins — can recover your funds or your account.
- **Disputes with FairWins go to arbitration, individually.** You give up the right to a court trial and to class actions against us.

If you do not agree with these points, do not use FairWins.

---

## 1. Who We Are and What These Terms Cover

These Terms & Conditions (the "**Terms**") are a binding agreement between you ("**you**," "**User**," "**Member**") and **Chippr Robotics LLC** ("**FairWins**," "**we**," "**us**," "**our**"), governing your access to and use of the FairWins platform, websites, smart contracts, interfaces, and related services (collectively, the "**Service**").

These Terms incorporate by reference the **FairWins Risk Disclosure** and the **FairWins Privacy Policy**, each of which forms part of your agreement with us.

## 2. Acceptance and Layered Consent

You accept these Terms through a layered process, and **each step independently confirms your agreement**:

1. **Entry.** By selecting "Enter" on the age and eligibility gate, you confirm your eligibility and acceptance of these Terms.
2. **Membership.** By purchasing or upgrading a membership pass, you re-confirm your eligibility and acceptance through individually-acknowledged attestations.
3. **Key generation.** By signing the account key-generation message with your wallet, you cryptographically confirm that you meet and continue to meet the eligibility requirements and agree to these Terms as published.

If any provision of a more specific step (membership attestation, signed message) conflicts with these Terms, these Terms control unless the specific step expressly states otherwise.

## 3. Definitions

- **"Member"** — a User holding a current, valid membership pass.
- **"Membership Pass"** — the access right described in Section 8.
- **"Wager"** — a peer-to-peer agreement between Users on the outcome of a specified event, settled by Smart Contract.
- **"Private Wager"** — a Wager offered to and accepted by a specific counterparty.
- **"Public Wager"** — a Wager broadcast for acceptance by any address.
- **"Trading Venue"** — any third-party protocol, exchange, or platform that FairWins does not operate and which you may reach through the Service, including perpetual-futures venues, prediction markets, marketplaces, bridges, and lending or staking protocols.
- **"Perpetual Future"** (a "**perp**") — a leveraged derivative contract with no fixed expiry, offered by a Trading Venue, in which you post collateral ("**margin**") to hold exposure larger than that collateral, and which the venue may forcibly close ("**liquidate**") when your collateral no longer supports it.
- **"Leveraged Derivative"** — a Perpetual Future or any other product in which your exposure exceeds the collateral you post.
- **"Notional"** — the full size of a leveraged position: your margin multiplied by your leverage. A fee charged on Notional is therefore larger, relative to the money you actually put in, than a fee charged on that money.
- **"Position"** — your open exposure at a Trading Venue, owned by the account that opened it.
- **"Smart Contract"** — the FairWins protocol contracts deployed on the Polygon network.
- **"Resolution Mechanism"** — the on-chain process, including any oracle and dispute procedure, by which the outcome of a Wager is determined and settled, as described in the Service documentation.
- **"Restricted Jurisdiction"** — any jurisdiction listed in **Schedule A**, as amended from time to time.
- **"Restricted Party"** — any person subject to sanctions administered by OFAC or any other applicable authority, or named on any government restricted-party or denied-persons list.

## 4. Nature of the Service

**4.1 Non-custodial, peer-to-peer software.** FairWins provides software that enables Users to enter into Wagers directly with one another. Wagers are agreements *between Users*, escrowed and settled by Smart Contracts on the Polygon network.

**4.2 What FairWins is not.** FairWins is not, and does not act as, a counterparty, bookmaker, sportsbook, casino, exchange, broker-dealer, swap execution facility, designated contract market, futures commission merchant, money transmitter, money services business, custodian, or fiduciary. FairWins does not set odds or prices, does not take the other side of any Wager, does not hold or control User funds, and **takes no rake, vigorish, commission, or share of any Wager.**

**4.3 How the Service is funded.** The Service is funded in the ways set out below, and in no others. Rates and caps are published in the Service and recorded on-chain, and may change; **the rate that applies to you is the one shown to you at the time you act.** Where a rate is set to zero there is no fee and no fee line at all. A fee described here arises only where the service it relates to is available to you and you choose to use it.

*Amounts you pay:*

1. **Membership fees** — consideration for access only (Section 8). They bear no relationship to the size, frequency, or outcome of any Wager.
2. **Platform fees on wrapped services** — a percentage of the **capital you commit** when you use certain services through the Service, currently lending, staking, bridging, and supplying liquidity. This fee is charged **on entry only and never on withdrawal**, at **0.50% (50 basis points)** where it is switched on today, under a hard cap of **2.50% (250 basis points)**. On some networks these services are configured at **0%**.
3. **Builder and interface fees on third-party venues** — where you trade on a Trading Venue through the Service, the venue may calculate a fee on the **Notional size of your trade** and credit it to FairWins. On prediction markets this is currently **0.50% (50 basis points) from takers and 0% from makers**, capped at 1.00% (100 basis points). On perpetual-futures venues, where this fee is switched on, it is **0.05% (5 basis points) of Notional, charged both when a position is opened and when it is closed**, capped at 0.10% (10 basis points) by the venue itself and calculated by the venue at the moment it executes your order — so an order that is cancelled or never filled carries no FairWins fee. **A fee on Notional is not a fee on the money you put in: at 10× leverage, 5 basis points of Notional is about 50 basis points — 0.50% — of your own margin.** This fee is an additional cost to you, and is disclosed as its own line before you are asked to sign.

*Amounts a venue pays us, which cost you nothing:*

4. **Referral rebates paid by a venue out of its own fee** — some Trading Venues share part of the fee they already charge with the interface that referred you. **This does not change your price and adds nothing to what you pay**, and on at least one venue being referred also gives you a **discount** on that venue's own fee. Where such an arrangement has not been activated by the venue, FairWins earns nothing from it.
5. **Referral credit from a third-party assistant service** — if you open and fund a GutterToken account through the link in the Service (Section 4.6), GutterToken may credit FairWins' own GutterToken account with **prepaid usage credit** under GutterToken's referral programme. That credit is granted by GutterToken out of its own allowance, is not cash, cannot be withdrawn, and **adds nothing to what GutterToken charges you**; any first-deposit credit GutterToken offers you is GutterToken's own promotion, on its terms. Where no referral code is configured, FairWins receives nothing from it.

*And nothing else:* **FairWins takes no fee of any kind on Wagers, on pools, or on sending money.** For those you pay network gas and nothing more.

**4.4 Access to third-party venues, including leveraged derivatives.** The Service also provides a non-custodial **interface** to Trading Venues operated by third parties, including venues offering **Perpetual Futures and other Leveraged Derivatives**. In that role FairWins prepares a transaction and nothing else: **your wallet signs it and your wallet is the sender.** FairWins is not a broker, dealer, exchange, trading facility, clearing house, or counterparty; it does not execute, match, clear, settle, custody, or guarantee any transaction; it does not operate, control, or supervise any Trading Venue; and it never owns or controls a Position. Section 10 governs your use of Trading Venues.

**4.5 Information purpose.** FairWins is designed to support information discovery through peer-to-peer markets. Nothing on the Service is an offer, solicitation, or recommendation to enter any Wager or transaction.

**4.6 Automated and AI components.** Portions of the Service are developed, maintained, and operated with the assistance of automated systems and AI agents. You acknowledge this and accept the associated risks described in the Risk Disclosure.

The Service may also make available, at your option, **member-facing AI features** — an in-app assistant, and private API keys that allow programs you authorise, including AI agents, to access your own data. **These features are off unless you enable them.** They are provided **"as is"**, they are **informational only and are not advice of any kind**, and their output may be inaccurate. **You remain solely responsible for every transaction you sign.** No AI feature of the Service signs, submits, or authorises a transaction, holds or transfers your assets, or acts at any Trading Venue on your behalf, and nothing an AI feature outputs creates any obligation on us or any entitlement for you.

**The assistant may read your own data to answer you.** When you ask it a question, it may read your wagers, your membership, and live fee rates through the same member API described below, under a short, read-only grant you sign in your wallet. It reads; it does not write, sign, or submit. What it tells you about that data is still generated text and may be wrong, and a read that fails is reported to you as failed, never as a zero.

**Third-party assistant service (GutterToken).** Where the Service offers it, you may choose to have the assistant answered by **GutterToken**, a third-party service that sells prepaid access to AI models, using **your own GutterToken account and your own prepaid credit**. If you do: (a) you contract with GutterToken, on **GutterToken's own terms, acceptable-use policy, and privacy terms**, and FairWins is not a party to that relationship; (b) your messages, and the name of the screen you are on, travel **from your own device directly to GutterToken** — FairWins does not receive them, does not process them, and does not charge anything for that use; (c) **GutterToken alone bills you**, per token at its own rates, from credit you deposited with it — FairWins does not set, see, or collect those charges, cannot show you your balance, and **provides no support for GutterToken billing, credit, refunds, or account access**; (d) the GutterToken key you enter is stored on your device only, and **any use of your GutterToken credit by a program presenting that key is a matter between you and GutterToken**; and (e) FairWins may receive referral credit from GutterToken as described in Section 4.3(5). FairWins does not operate, control, or endorse GutterToken, makes no representation about its availability or continued operation, and may withdraw the option at any time without affecting your GutterToken account.

**Safeguarding an API key you create is your responsibility.** A key is created by **your own wallet signature**; FairWins does not issue, hold, or store it, and cannot recover, reissue, or extend it. **Any use of the Service by a person or program presenting your key is treated as authorised by you, and you are responsible for it**, including for what any third-party program or agent you connect does with the access you granted. A key confers only the read and quotation permissions you selected when you signed it; **it cannot move funds, sign a transaction, or bind you to a Wager.** Revocation takes effect on the live Service but is **not guaranteed to persist across a Service restart** — the binding limit on a key is the **expiry time you signed into it**, after which it stops working. You are responsible for choosing an appropriate expiry and permission set, and for revoking any key you no longer use or believe to be exposed.

## 5. Eligibility

You may use the Service only if you meet **all** of the following at all times. By using the Service you represent and warrant that:

- (a) you are at least **21 years of age** and of legal capacity to enter a binding contract;
- (b) you are not located, resident, incorporated, or established in any **Restricted Jurisdiction**;
- (c) you are **not a Restricted Party** and do not act on behalf of any Restricted Party;
- (d) your access to and use of peer-to-peer wagering software — and of any other service you reach through the Service, **including Leveraged Derivatives** — is **lawful in the jurisdiction from which you access it**, and you bear sole responsibility for that determination; and
- (e) you have **sole and exclusive control** of the wallet and private keys you use with the Service.

These representations are renewed each time you access the Service, purchase or renew a Membership Pass, sign a Service message, or enter a Wager.

## 6. Restricted Jurisdictions

The Service is not offered to, and may not be used by, persons in any Restricted Jurisdiction (**Schedule A**). We may add jurisdictions to Schedule A at any time, including in response to legal or regulatory developments, and may block access accordingly without notice and without refund.

## 7. No Circumvention

You agree **not** to use a VPN, proxy, Tor, false residence or identity information, or any other method to disguise your location or to misrepresent your eligibility, and not to access the Service from any location from which access is restricted. **Any such circumvention is a material breach of these Terms, immediately voids your access and Membership Pass without refund, and may result in forfeiture of access to the Service.** Outcomes already settled on-chain between Users are not reversed by FairWins.

## 8. Membership Passes

**8.1 Access only.** A Membership Pass grants you access to the Service for its stated period. **A Membership Pass is a fee for access only. It is not a Wager, a stake, a deposit, an investment, a security, or a balance held on your behalf, and it confers no ownership interest, profit expectation, or claim on any pool of funds.**

**8.2 Use of fees.** Membership fees fund Service infrastructure, storage, hosting, and development, together with the other funding sources described in Section 4.3. Fees are not pooled, staked, wagered, or returned to Members as winnings, and a Membership Pass gives you no claim on, or share of, any fee or rebate FairWins receives from any source.

**8.3 Non-refundable.** **MEMBERSHIP FEES ARE NON-REFUNDABLE, INCLUDING IF YOU ARE LATER RESTRICTED, SUSPENDED, OR UNABLE TO ACCESS THE SERVICE FOR ANY REASON, AND INCLUDING IF THE SERVICE IS MODIFIED OR DISCONTINUED.**

**8.4 No guarantee.** A Membership Pass does not guarantee uninterrupted access, the availability of any market or counterparty, or any outcome.

### Membership Vouchers

**8.5 What a voucher is.** A Membership Voucher is a transferable token representing a prepaid claim to a Membership Pass of a stated tier. It is a utility access token — **not a Wager, stake, deposit, investment, or security** — and confers no ownership interest, profit expectation, or claim on any pool of funds. Buying a voucher is a non-refundable payment for the right to redeem it for access.

**8.6 Redemption.** Redeeming a voucher burns it and grants the corresponding soulbound Membership Pass to the wallet that redeems it. The membership term begins at redemption. A voucher grants the tier it was minted for, regardless of later changes to tier pricing or configuration, and vouchers do not expire.

**8.7 Eligibility and screening at redemption.** Eligibility, sanctions screening, and acceptance of these Terms are evaluated for the **redeeming wallet at the time of redemption**, on the same fail-closed basis as a direct membership purchase. Buying, holding, gifting, or reselling a voucher does not grant access until it is successfully redeemed by an eligible wallet.

**8.8 Transfers are public; privacy is pseudonymous.** Voucher mints, transfers, and burns are recorded publicly on the blockchain. Redeeming from a fresh wallet that received the voucher keeps your membership from being linked on-chain to the wallet that bought it — this is **pseudonymity, not cryptographic anonymity**, and the transfer history remains public.

**8.9 Resale and royalties.** Vouchers may be gifted or resold on third-party marketplaces. A best-effort resale royalty hint (EIP-2981) directs a small percentage to the treasury where marketplaces honor it; it is not enforced on-chain. FairWins does not operate a marketplace and does not guarantee any resale price, liquidity, or that any marketplace will honor the royalty.

**8.10 Non-refundable; failed redemption.** Voucher purchases are non-refundable. If a redemption is blocked (for example, the redeeming wallet fails screening or eligibility), the voucher is **preserved — not burned and not refunded** — so it remains transferable and can be redeemed later by an eligible wallet.

## 9. How Wagers Work

**9.1 Peer-to-peer.** A Wager is formed when one User's offer is accepted by another User (a Private Wager) or by any address (a Public Wager). The agreement is between those Users. FairWins is not a party to it.

**9.2 Escrow and settlement.** Stakes are escrowed and settled by Smart Contract according to the Resolution Mechanism. FairWins does not hold, direct, or have access to escrowed stakes.

**9.3 Resolution.** Outcomes are determined by the Resolution Mechanism, which may rely on oracles and a defined dispute procedure. You accept that the Resolution Mechanism is the **sole and final** process for resolving Wager outcomes, that it may produce results you disagree with, and that **there is no regulator, court, or authority to which you may appeal a Wager outcome.**

**9.4 Finality.** Settled Wagers are recorded on the Polygon blockchain and are **irreversible**. FairWins cannot reverse, refund, or modify a settled Wager.

**9.5 Your responsibility.** You are solely responsible for understanding each Wager you enter, including its terms, counterparty, resolution source, and risk.

## 10. Third-Party Trading Venues and Leveraged Products

**10.1 What this Section covers.** The Service can prepare transactions for Trading Venues operated by third parties, including venues offering **Perpetual Futures and other Leveraged Derivatives**. This Section governs everything you do at a Trading Venue through the Service.

**10.2 You contract with the venue, not with us.** Your transaction is with the Trading Venue, on **that venue's own terms, and subject to that venue's own risks**. You are responsible for reading and complying with them. FairWins is not a party to that relationship, makes no representation about any venue's solvency, integrity, code, or continued operation, and does not endorse any venue by making it reachable.

**10.3 The venue sets the rules.** The Trading Venue — not FairWins — determines its own fees, spreads, funding and borrowing charges, price and oracle sources, leverage limits, margin requirements, liquidation rules, order execution and cancellation, and any restriction, downtime, or close-only period. **The venue's own charges are separate from, and in addition to, any FairWins fee described in Section 4.3.**

**10.4 We cannot execute, reverse, or recover.** FairWins builds a transaction; **your wallet signs it, and your wallet is the sender.** Once it is submitted, FairWins cannot execute, match, modify, cancel, reverse, or recover it. FairWins cannot guarantee that an order is filled, or filled at any particular price, or filled at all; cannot prevent, delay, or undo a liquidation; and cannot restore a Position or collateral lost at a venue. Information about a venue shown in the Service comes from that venue or from public chain data, and may be delayed, incomplete, or unavailable.

**10.5 Your wallet owns the Position.** FairWins never holds your funds at a Trading Venue, never owns or controls a Position, and holds no approval, authority, or standing instruction over your Positions. **The account you trade from is the owner of every Position it opens, and you can always act on it directly at the venue** — including if the Service is unavailable, restricted to you, or discontinued altogether. This follows from how the Service is built; it is a structural property, not a promise about our conduct.

**10.6 Some venues are display-only.** For some venues the Service can show a Position but cannot act on it. Where that is so, the Service says so plainly, and you manage that Position at the venue itself.

**10.7 Leverage risk.** **PERPETUAL FUTURES AND OTHER LEVERAGED DERIVATIVES ARE HIGH-RISK PRODUCTS. A LEVERAGED POSITION CAN BE LIQUIDATED DURING ORDINARY MARKET MOVEMENT, AT ANY TIME AND WITHOUT NOTICE, AND YOU CAN LOSE THE ENTIRE AMOUNT OF COLLATERAL YOU POSTED.** Leverage multiplies losses as well as gains, and fees charged on Notional are charged on your whole position size, not on the money you put in. There is no insurance, no deposit protection, and no regulator or authority to which you may appeal a venue's execution, liquidation, or outcome.

**10.8 Eligibility for leveraged derivatives.** Access to Leveraged Derivatives is restricted or prohibited for many persons and in many jurisdictions, and those restrictions are **broader than the general Restricted Jurisdiction list in Schedule A**. By opening a Position you represent and warrant, in addition to Section 5 and each time you do so, that **you are legally permitted to trade Leveraged Derivatives in the jurisdiction from which you access the Service**, that you are not a Restricted Party, and that you understand the product. **Section 7 (No Circumvention) applies to this Section with full force**: disguising your location or misrepresenting your eligibility in order to reach a leveraged product is a material breach of these Terms.

**10.9 Availability may change.** Any Trading Venue, and any capability at it, may be limited, suspended, withdrawn, or never enabled for you, by the venue or by us, at any time and without notice. We are not obliged to make any venue or product available to you.

## 11. Disputes Between Users

Disputes about a Wager's outcome are resolved **exclusively** through the Resolution Mechanism described in the Service documentation. FairWins does not adjudicate Wager outcomes between Users and is not liable for them. This Section is separate from, and does not limit, the arbitration provision in Section 23, which governs disputes *with FairWins*.

## 12. Sanctions and Compliance Screening

You represent that you are not a Restricted Party. We may screen wallet addresses and may decline, block, or refuse to facilitate interaction with any address that we or our screening providers associate with a Restricted Party, sanctioned activity, or illicit finance, in each case in our discretion and without liability to you.

## 13. Prohibited Uses

You agree not to use the Service to: violate any law or regulation applicable to you; launder money or finance illicit activity; manipulate a market or resolution source; trade on material non-public information where prohibited; access the Service while ineligible; interfere with, attack, or reverse-engineer the Service except as permitted by its open-source license; or harm other Users.

## 14. No Professional Advice

The Service and its contents do not constitute investment, financial, legal, accounting, or tax advice. **You are solely responsible for your own decisions.** Consult your own professional advisors.

## 15. Assumption of Risk

**YOU ACKNOWLEDGE THAT YOU HAVE READ AND UNDERSTAND THE FAIRWINS RISK DISCLOSURE AND THAT YOU KNOWINGLY AND VOLUNTARILY ASSUME ALL RISKS DESCRIBED IN IT, INCLUDING THE RISK OF TOTAL LOSS, SMART-CONTRACT AND ORACLE RISK, ABSENCE OF REGULATORY PROTECTION, AND LOSS OF ACCESS DUE TO LOSS OF YOUR KEYS.**

## 16. Intellectual Property and Open Source

The FairWins protocol and certain components are released under their applicable open-source license(s), and your use of those components is governed by those licenses. The FairWins name, marks, and interface content not so licensed remain our property. Nothing here grants you rights beyond those expressly stated or granted by an applicable open-source license.

## 17. Privacy

Your use of the Service is subject to the FairWins Privacy Policy. You acknowledge that blockchain transactions are public, permanent, and pseudonymous rather than anonymous, and that on-chain activity may be analyzed and attributed by third parties beyond our control.

## 18. Taxes

**You are solely responsible for determining, reporting, and paying any taxes** arising from your use of the Service, including from Wagers and winnings. FairWins does not withhold or report on your behalf.

## 19. Disclaimers

**THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.** We do not warrant that the Service will be uninterrupted, secure, error-free, or free of harmful components, or that any Smart Contract, oracle, or Resolution Mechanism will function without fault. You use the Service at your own risk.

## 20. Limitation of Liability

**TO THE MAXIMUM EXTENT PERMITTED BY LAW, FAIRWINS AND CHIPPR ROBOTICS LLC, AND THEIR MEMBERS, OFFICERS, CONTRIBUTORS, AND AGENTS, WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOST PROFITS, LOST WAGERS, LOST FUNDS, OR LOSS OF DATA, ARISING FROM OR RELATING TO THE SERVICE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.**

**TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR TOTAL AGGREGATE LIABILITY ARISING FROM OR RELATING TO THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE TOTAL MEMBERSHIP FEES YOU PAID TO US IN THE [SIX (6)] MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM, OR (B) [USD 100].**

Because FairWins is non-custodial and is not a party to any Wager, we are not liable for the conduct of any counterparty or for any Wager outcome. For the same reason, we are not liable for the acts, omissions, fees, pricing, execution, liquidation, downtime, restriction, or insolvency of any Trading Venue, or for any loss on a Position.

## 21. Indemnification

You will indemnify and hold harmless FairWins and Chippr Robotics LLC and their members, officers, contributors, and agents from any claim, loss, or expense (including reasonable legal fees) arising from your breach of these Terms, your misuse of the Service, your violation of law, or your false eligibility representations.

## 22. Suspension and Termination

We may restrict, suspend, or terminate your access to the Service at any time, including for suspected ineligibility, circumvention, sanctions concerns, or breach, **without notice and without refund**. Settled on-chain Wagers are unaffected by termination.

### Account Moderation

An **Account Moderator** is a protocol role that can freeze — and later unfreeze — an individual account for cause. Cause includes suspected fraud or abuse, sanctions or eligibility concerns, or a court order or other lawful demand. While an account is frozen it cannot create or accept wagers, cancel, declare a winner, or claim payouts or refunds on the WagerRegistry. Permissionless on-chain resolution (for example Polymarket auto-resolution) may still occur, but a frozen account cannot claim until it is unfrozen. Freezing is an on-chain action recorded on the WagerRegistry; it does not entitle you to any refund of membership or other fees and does not affect already-settled Wagers.

Separately, a **Guardian-Role** holder may pause the protocol in response to a security incident, which temporarily blocks all wager creation, acceptance, and settlement for everyone until the protocol is unpaused.

## 23. Governing Law; Arbitration; Class Action Waiver

**23.1 Governing law.** These Terms are governed by the laws of `[GOVERNING LAW JURISDICTION]`, without regard to conflict-of-laws rules.

**23.2 Binding arbitration.** **ANY DISPUTE BETWEEN YOU AND FAIRWINS ARISING FROM OR RELATING TO THESE TERMS OR THE SERVICE WILL BE RESOLVED BY FINAL AND BINDING INDIVIDUAL ARBITRATION ADMINISTERED BY `[ARBITRAL INSTITUTION]` UNDER ITS RULES, SEATED IN `[SEAT]`, IN THE ENGLISH LANGUAGE. YOU AND FAIRWINS WAIVE THE RIGHT TO A TRIAL BY JURY OR IN COURT**, except that either party may bring an individual claim in small-claims court where eligible.

**23.3 Class action waiver.** **YOU AND FAIRWINS AGREE THAT CLAIMS MAY BE BROUGHT ONLY IN AN INDIVIDUAL CAPACITY AND NOT AS A PLAINTIFF OR CLASS MEMBER IN ANY CLASS, COLLECTIVE, OR REPRESENTATIVE PROCEEDING.**

**23.4 Opt-out.** You may opt out of this arbitration provision by sending written notice to `[CONTACT]` within thirty (30) days of first accepting these Terms.

## 24. Force Majeure

We are not liable for any failure or delay caused by events beyond our reasonable control, including network failures, blockchain congestion or reorganization, oracle failure, third-party service outages, regulatory action, or acts of god.

## 25. Changes to These Terms

We may update these Terms. Material changes will be indicated by an updated "Last updated" date and version, and where practical by notice through the Service. Your continued use after changes take effect constitutes acceptance. If you do not agree, you must stop using the Service.

## 26. General

**26.1 Severability.** If any provision is held unenforceable, the remainder remains in effect, and the unenforceable provision is modified to the minimum extent necessary to make it enforceable.

**26.2 No waiver.** Our failure to enforce any provision is not a waiver.

**26.3 Assignment.** You may not assign these Terms. We may assign them in connection with a reorganization or transfer of the Service.

**26.4 Entire agreement.** These Terms, with the Risk Disclosure and Privacy Policy, are the entire agreement between you and us regarding the Service.

**26.5 Language.** The English version of these Terms controls.

## 27. Contact

Questions about these Terms: Howdy@fairwins.app.

## 28. Acknowledgement

**BY ENTERING THE SITE, PURCHASING OR UPGRADING A MEMBERSHIP PASS, OR SIGNING THE ACCOUNT KEY-GENERATION MESSAGE, YOU CONFIRM THAT YOU HAVE READ AND UNDERSTOOD THESE TERMS AND THE RISK DISCLOSURE, THAT YOU ARE ELIGIBLE, AND THAT YOU KNOWINGLY AGREE TO BE BOUND BY THEM.**

---

## Schedule A — Restricted Jurisdictions

**This list is not the limit of every restriction.** Restrictions on **Leveraged Derivatives**, including Perpetual Futures, are broader than this list in many jurisdictions: a jurisdiction that is not a Restricted Jurisdiction for wagering may still prohibit or restrict leveraged products, and **Section 10.8 applies to you independently of this Schedule**.

The Service is not available to persons located, resident, incorporated, or established in:

- **Cuba, Iran, North Korea, Syria**, and the **Crimea, Donetsk, and Luhansk** regions;
- Any jurisdiction subject to comprehensive sanctions by OFAC or other applicable authority; and
- Any jurisdiction in which peer-to-peer wagering, prediction markets, or the Service is unlawful, including without limitation.

We may amend this Schedule at any time.

*— End of Terms & Conditions —*
