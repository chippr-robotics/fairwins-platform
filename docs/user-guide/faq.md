# Frequently Asked Questions (FAQ)

## General

### What is FairWins?

FairWins is a peer-to-peer wager app. You and a friend agree on a bet, both
stakes are locked in a smart-contract escrow on Polygon, and the wager is
settled by whoever you both chose to trust up front: yourselves, a neutral
arbitrator, or an external oracle (Polymarket, Chainlink, UMA).

### Is this a prediction market or a casino?

Neither. There is no order book, no liquidity pool, no odds-setting house, and
no trading. Every wager is a private 1-v-1 agreement; FairWins just holds the
stakes and pays the winner. You can't bet "against the market" — only against
a specific person who accepts your wager.

### Who is the counterparty?

Always a specific person — either someone you invited directly with a QR code
or link, or, for an **open challenge**, whoever takes it using the four-word
code you shared. FairWins never takes the other side of a bet.

### What does it cost?

- A **membership tier** (Bronze → Platinum, priced in USDC) is required to
  create and accept wagers, and sets your monthly/concurrent wager limits. You
  can buy a tier directly or redeem a transferable
  [membership voucher](membership-vouchers.md).
- **Gas** on Polygon (paid in POL, typically a few cents per action).
- There is no rake on the pot itself — the winner claims both stakes in full.

## Getting set up

### Which wallets are supported?

MetaMask (browser) and anything that speaks WalletConnect (mobile wallets).

### Which networks does it run on?

Polygon mainnet (chain 137) is production. Polygon Amoy (chain 80002) is the
testnet, reachable from the toggle in the wallet menu if you want to practice
with test funds.

### What tokens do I need?

POL for gas and USDC for stakes and membership. The Account Center's **Swap**
tab can convert between them via Uniswap.

## Wagers

### What kinds of wagers can I make?

Anything with a binary outcome between two people: even-money (equal stakes)
or an **Offer** (asymmetric stakes at odds you set, where the side that settles
puts up the majority stake). You pick who settles — you (**Me**), your opponent
(**Them**), a neutral **Friend** (arbitrator), or an **Oracle** (Polymarket /
Chainlink Data Feed / Chainlink Functions / UMA).

### What happens to my stake when I create a wager?

It transfers into the `WagerRegistry` escrow contract immediately. If nobody
accepts before the acceptance deadline, you reclaim it. Once accepted, both
stakes stay in escrow until the wager resolves, draws, or times out.

### Can a wager end in a tie?

Yes. For participant-resolved wagers, both parties can consent to a **draw**
(or the arbitrator can declare one), and each side gets its own stake back.

### What if the other person never resolves the wager?

After the resolve deadline passes, either party can trigger a refund — both
stakes go back to their owners. Money can't get stuck.

### What if I picked an oracle and it never reports?

Same refund path: once the resolve deadline passes unresolved, either party
reclaims their stake.

### Can the loser refuse to pay?

No — that's the point. Both stakes are already in escrow, and the contract
pays the winner directly when the wager resolves.

### Can I cancel a wager?

You can cancel your own wager any time *before* it's accepted (and the invitee
can decline it). After acceptance, there's no unilateral cancel — only
resolution, mutual draw, or the deadline-based refund.

### Can I post a wager without naming my opponent?

Yes — that's an **open challenge**. You post the wager with no named opponent
and get a **four-word code**; anyone you share the code with can take the other
side. Creating one needs a **Silver** membership or above; taking one needs any
active tier. Full guide: [Open Challenges](open-challenges.md).

### What is the four-word code, and can I recover it?

It's the key to your open challenge — it finds the challenge, decrypts its
terms, and authorizes acceptance. It's generated in your browser and **cannot
be recovered** if lost (we never store it). Save it as soon as it's shown, and
share it only with people you want to be able to take the bet.

### What does it take to accept an open challenge?

Enter the four words, review the terms, then **approve** your stake token,
**sign** to authorize acceptance, and **confirm** the transaction. Your matching
stake is escrowed on confirmation. The app shows these as a checklist.

## Memberships and vouchers

### How do I get a membership?

Two ways: buy a tier directly (it's soulbound to your wallet), or redeem a
**membership voucher** someone bought or gave you. Both produce the same
30-day, time-bound membership. See [Membership Vouchers](membership-vouchers.md).

### What is a membership voucher?

A transferable ERC-721 token you buy with USDC at a tier's price. Holding it
gives you **no** membership — it's a bearer claim you can gift or resell, and
whoever holds it can **redeem** it (which burns it) for the membership.

### Can I buy a voucher as a gift?

Yes. Buy the voucher, then send the NFT to the recipient's address; they redeem
it for the membership. Because redemption is soulbound to the redeemer, let the
recipient redeem it on the wallet they'll wager with.

### Does holding a voucher let me create wagers?

No — you must **redeem** it first. Redeeming burns the voucher and grants the
soulbound membership that unlocks wagering.

## Callsigns

### What is a callsign?

A short, memorable handle for your wallet, shown with a `%` — like `%chipprbots`.
Instead of a long `0x…` address, people can find you by your callsign when they create a
wager, send a transfer, or add you to their address book. See
[Callsigns](callsigns.md) for the full guide.

### Do I need one?

No. Callsigns are **optional** — you can always wager with a raw address. They're a
convenience perk of **Gold membership and above**.

### Can someone steal my callsign or point it at their own wallet?

No. Only you — with the same wallet authorization as your other account actions — can
change, release, or move your callsign. **Not even platform operators** can move it to a
different wallet. Operators can suspend an abusive callsign from resolving, but suspension
never reassigns it or touches any funds.

### Is my callsign private?

No — unlike your on-device address book, the callsign ↔ address mapping is **public and
on-chain**. Anyone can look up the address behind a callsign, so choose a handle you're
comfortable being public.

### What happens to my callsign if my membership lapses?

It keeps working through a **12-month grace period**. Renew Gold before that ends to
keep it; otherwise it eventually becomes reclaimable by others.

## Privacy

### Who can see my wager?

The on-chain record (addresses, stakes, deadlines, status) is public, like all
blockchain data. The **terms** of the wager can be end-to-end encrypted: the
chain stores only a hash and an IPFS pointer, and only the participants (plus
the arbitrator, if any) hold keys to decrypt the content. See
[Private Wager Encryption](private-market-encryption.md).

### What's the encryption key in the Security tab for?

It's your published public key (registered on-chain in `KeyRegistry`) that
lets friends encrypt wager terms so only you can read them. Registering it is
optional but required to participate in encrypted wagers.

## Trust and safety

### Can FairWins take my money?

No. Operators hold two narrowly-scoped powers — a **Guardian** can pause the
protocol, and an **Account Moderator** can freeze a specific account for cause
— but neither can move escrowed stakes or redirect payouts. See the
[Account Moderation Policy](../system-overview/account-moderation.md) and
[Security Model](../system-overview/security.md).

### Why was my transaction blocked?

Wager creation and acceptance screen both addresses against the Chainalysis
sanctions oracle (plus an operator deny list). Sanctioned addresses cannot
participate.

### Are the contracts audited and tested?

The contract suite runs a security pipeline of unit tests, Slither static
analysis, and Medusa fuzzing on every change — see
[Security Testing](../security/index.md). Deployed addresses are recorded in
the repository's `deployments/` directory so you can verify what you're
interacting with.

### Is wagering legal where I live?

That's on you. The app presents an eligibility notice and the
[Terms](https://fairwins.app/terms) and [Risk Disclosure](https://fairwins.app/risk)
before entry — make sure peer-to-peer wagering is lawful in your jurisdiction
before using it.

## Troubleshooting

### The accept link shows a wager but the Accept button is disabled

Check, in order: your wallet is connected, you're on the right network (the
banner offers a one-click switch), the acceptance deadline hasn't passed, you
have an active membership, and you hold enough USDC for the stake plus a
little POL for gas.

### The QR scanner can't see my camera

Grant camera permission to fairwins.app in your browser. On iOS, the scanner
requires Safari's camera permission for the site.

### My wager disappeared from the dashboard

Check the **History** tab of My Wagers — resolved, declined, expired, and
refunded wagers move there.

### Where can I get more help?

Open an issue on
[GitHub](https://github.com/chippr-robotics/fairwins-platform/issues).
