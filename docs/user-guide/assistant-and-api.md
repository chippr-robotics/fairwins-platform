# Assistant & API Access

Two optional tools, both on **Tools → Assistant** in the menu:

- the **Assistant**, an in-app helper you can ask questions about FairWins — and, since it can now
  read your own wagers, membership and fee rates, about your own position; and
- **API access**, private keys that let a program — including an AI agent — read your FairWins
  data on your behalf.

Both are **off until you turn them on**, and neither can move your money. Nothing in either
feature can sign a transaction, spend from your wallet, or send funds. Signing always happens in
your own wallet, in the app, with you looking at it.

The assistant is available to **members with an active membership**, and to **anyone who brings
their own GutterToken credits** — see [Choosing who answers](#choosing-who-answers).

---

## The Assistant

### Turning it on

**Menu → Tools → Assistant.** (It used to live under Settings; old links still take you there.)

The card shows its own state. Before you enable it, the summary line reads *"Off — nothing is
sent."* That is literal: while the assistant is off, nothing you type anywhere in the app is sent
to us or to anyone else, and the assistant button does not appear.

Turn on the master toggle to enable it. A small chat button then appears above the bottom
navigation on every screen.

### Choosing who answers

The **Answered by** row on the same card offers two services. They answer the same questions in the
same panel; the difference is **who runs the model, who pays for it, and where your messages go**.

| | **FairWins assistant (membership)** | **GutterToken (your credits)** |
|---|---|---|
| Who can use it | Members with an active paid membership | Anyone who saves a GutterToken key |
| Who pays for the model | FairWins — it is part of your membership | **You**, from prepaid credit you deposit with GutterToken, per token, at GutterToken's own rates |
| Where your messages go | From your device to the FairWins gateway, then to our model provider | **From your device directly to GutterToken.** FairWins is not in between, does not receive your messages, and does not charge anything |
| What FairWins can see | The messages, for the reply only (never stored; never used to train) | Nothing — not your messages, not your key, not your balance |
| Whose terms cover it | Ours: [Privacy Policy](https://fairwins.app/privacy) §2 and §5 | Your own agreement with GutterToken |

If you are not a member, the GutterToken option is the only one offered. If you are a member you
may use either, and switch at any time; the panel header always tells you which one is answering.

### Getting a GutterToken key

[GutterToken](https://app.guttertokens.com) sells prepaid access to AI models. You open an account
there, deposit credit, and copy an API key that starts with `sk-`. **The account is yours, on
GutterToken's site and terms** — FairWins cannot open it for you, cannot sign you in to it, and
never sends anything to GutterToken on your behalf.

**Creating the account.** Press **Get a key ↗** on the Assistant card. It opens GutterToken's
signup page in a new tab. *If the link carries a referral code, the card says so: FairWins receives
usage credit from GutterToken when you fund an account through it. It adds nothing to your price,
and GutterToken's own first-deposit offer, if any, is theirs.* GutterToken offers two ways to sign
up:

- **With an e-mail address.** Available to everyone, and the option to choose if you use FairWins
  with a **passkey**: GutterToken's wallet sign-up only detects a browser-extension wallet, and a
  passkey account is a smart account with no extension to detect, so the wallet option simply will
  not appear for you. This is normal — use e-mail.
- **With a browser wallet** (MetaMask or similar). If you use FairWins with a classic wallet, the
  same extension will be offered on GutterToken's page. You sign a short message *there*, in your
  wallet, on GutterToken's site — it costs nothing and sends no transaction. Use the **same address
  you use in FairWins** if you intend to top up from it. Note that an account created with a wallet
  **and no e-mail** can only ever be reached through that wallet: lose its key and the account and
  its credit are gone.

GutterToken also offers its own passkey sign-in. That is GutterToken's feature for GutterToken's
site, and it has nothing to do with your FairWins passkey — the two are not linked in any way.

**Adding credit.** In GutterToken's dashboard, deposit USDC or USDT on Ethereum, Base, Arbitrum One
or Polygon, from a wallet you can sign for (an exchange withdrawal cannot be claimed). **Your
balance is visible only there.** FairWins has no way to read it and will never show it to you.

**Copying the key.** Also in GutterToken's dashboard, under its API keys section: create a key and
copy it — it begins with `sk-`. Unlike a FairWins API key, a GutterToken key **can be viewed and
re-copied there later**, and **revoked there** at any time; revoking it at GutterToken is what
actually stops it spending, wherever it was pasted.

### Saving the key in FairWins

1. On the Assistant card, press **Add** next to *GutterToken key*. A sheet explains what the key
   allows — spending your GutterToken balance, from this device, for this account — and that it is
   stored **on this device only**.
2. Paste the key and press **Test**. The app makes one request to GutterToken with it. If
   GutterToken rejects the key you will be told and the key is not saved; if GutterToken cannot be
   reached, the key saves and the failure is shown so you can try again later.
3. Press **Save**, then choose **GutterToken (your credits)** under *Answered by*.

The card shows the key masked — `sk-…` and its last four characters — and never the whole thing
again. Use **Test** whenever you want to confirm it still works, **Add / Replace** after you rotate
it at GutterToken, and **Remove** to delete it from this device.

**Where the key lives, and where it does not.** It is stored in your browser, on this device, for
the wallet you saved it with. It is **not** sent to FairWins, **not** part of your encrypted backup,
and does **not** follow you to another device or browser — on a new device, paste it again. Another
wallet on the same device does not inherit it. If you believe the key has leaked, revoke it at
GutterToken; removing it here only removes this device's copy.

### What it costs

- **FairWins assistant:** nothing beyond your membership.
- **GutterToken:** GutterToken charges your prepaid balance per token — for what you send and for
  what comes back — at rates GutterToken sets and may change. **FairWins charges nothing on this
  path and does not see the charge.** The app does not show GutterToken's rates or your remaining
  balance, because it has no way to read either; GutterToken's own billing page is the place for
  both. Where a reply reports how many tokens it used, the panel may show that count — it is a
  fact GutterToken sent — but never a dollar figure, which would be a guess.

### If GutterToken says no

The panel tells you plainly what happened and what to do. It never makes up an answer instead.

| You see | What happened | What to do |
|---|---|---|
| *"GutterToken did not accept this key. It may have been revoked."* | GutterToken rejected the key | Copy a fresh key from GutterToken and use **Add / Replace**. |
| *"Your GutterToken balance is empty. Top up at GutterToken and try again."* | Your prepaid credit is used up | Follow the link to GutterToken's billing page and add credit. FairWins cannot see your balance and cannot add to it. |
| *"GutterToken is rate-limiting requests from your network."* | GutterToken limits requests **per network address**, so a shared office or home network can hit its limit | Wait a moment and retry. This is not a FairWins limit. |
| *"The assistant service is not reachable"* (naming GutterToken) | GutterToken could not be reached, or has no capacity right now | Retry. Check GutterToken's own status page if it persists. |

FairWins support cannot help with GutterToken billing, credit, refunds or account access — those
are between you and GutterToken. **A GutterToken account opened with a browser wallet alone, and no
e-mail, cannot be recovered by anyone if you lose that wallet's key**, and the credit in it is lost
with it.

### What happens when you use it

**On the FairWins assistant**, the first time you open the panel after enabling it you are asked to
**authorise a session**: you sign a short message in your wallet that grants a 24-hour, read-only
permission. This does not approve any spending — there is no token approval, no transaction, and
no cost. The permission is held in your browser's memory only and disappears when you disconnect,
switch accounts, or close the tab. Once authorised, what you type is sent to the FairWins gateway
and on to our model provider, which generates the reply.

**On GutterToken**, no session is needed to chat — your device talks to GutterToken directly with
your key. The assistant can still **look things up about you**, but only if you grant it the same
24-hour read-only permission; the panel offers it the first time you ask something that needs your
data. Until you do, it can answer general questions and public look-ups (prediction markets, perps
pairs, gateway status) and find screens in the app, and it will tell you it cannot see your own
position.

### What the assistant can look up

To answer your questions, the assistant can **read** — never change — these things, in your own
browser, and tell you what it read:

- your **profile**, **membership tier**, **open wagers** and the **live fee rates** — with the
  read-only permission above;
- **public prediction markets**, **perpetual-futures pairs** and whether the FairWins gateway's
  optional features are switched on — no permission needed;
- **where a screen is in the app**, from the app's own menu index, so the links it offers are real
  ones.

While it is reading, the panel shows what it is reading. If a read fails — a network is down, an
index is unavailable — the assistant is told the read failed and says so. **It is never handed a
zero**, because "you have no open wagers" and "the wager index did not answer" are different facts.

### What the assistant will and will not do

- It **explains** surfaces, fees, deadlines and options, and links you straight to the right screen.
- It **never signs anything, never submits anything, and never moves your screen or fills in a form
  for you.** Every reply carries that reminder. Links it offers are ordinary links you choose to tap.
- It **will never ask you for a private key, a seed phrase, a recovery word list, or an API key.**
  If anything in this app ever asks you for those, it is not us — stop and report it.
- It can be **wrong.** It is generated text — including when it has just read your own data. Verify
  anything consequential before you act on it, and never treat a number it states as the number you
  are about to sign. Text it reads from the platform — a wager description, a market name — was
  written by someone else and may be designed to mislead it.

If the service is unreachable, the assistant says so and offers a retry. **It never invents a
reply** — an answer you cannot trust is worse than no answer.

### Memory, and clearing it

If you leave memory retention on, your recent conversation — the messages you and the assistant
exchanged, never the data it looked up — is kept **on this device only**, capped at the last 50
messages. It is not sent to us for storage, is not part of your encrypted backup, and does not
follow you to another device or browser.

**Tools → Assistant → Clear conversation memory** wipes it. The button shows how many entries are
stored before you press it.

### Turning it off

Flip the master toggle off. The button disappears immediately and nothing further is sent — on
either service. Clearing your memory and removing a GutterToken key are separate actions — do all
three if you want no trace left on this device.

---

## API access

### What an API key is here

An API key is a **capability you sign** with your own wallet. It is not a password we issue, and we
do not store it — the key itself carries the permission, cryptographically, and we simply check the
signature when a program presents it.

That has three consequences worth understanding:

- **You choose exactly what it can do.** You tick the permissions when you create it: your profile,
  your wagers, your membership, live fee rates, building unsigned transactions, and the assistant.
  Every one of those is a read or a quote. **None of them can spend, transfer, or sign.**
- **You choose when it expires.** 7, 30 or 90 days. The expiry is signed into the key, so it is
  binding — nobody can extend it, including us.
- **We only ever see it when it is used.** There is no key list on our side to be leaked.

### Creating one

**Menu → Tools → Assistant → API access.**

1. Give the key a label, so you can recognise it later. The label is for your eyes only.
2. Tick the permissions the program actually needs. Give the smallest set that works.
3. Pick an expiry.
4. Sign in your wallet. This is a signature, not a transaction — it costs nothing and confirms
   nothing on chain.

**The token is shown once.** Copy it then. We cannot show it again, because we never had it. If you
lose it, revoke it and create another.

The panel keeps a note of the key's label, permissions and expiry so you can see what you have
outstanding. **The token itself is never stored** — not in the app, not in your backup.

### Guard the token like a password

Anyone holding your token can read whatever you granted it, for as long as it lasts. Treat it as a
credential:

- Paste it into a configuration file or a password manager, never into a chat, an issue, or a
  screenshot.
- Give a separate key to each program, so you can revoke one without breaking the others.
- Prefer short expiries. A key that expires on its own is one you cannot forget about.

### Revoking a key

Press **Revoke** and sign. Read the confirmation carefully, because it tells you two different
things:

- The revocation is registered on the **live gateway** and takes effect immediately.
- The revocation is **not permanent by itself.** If our gateway restarts, it forgets the revocation
  and the key works again **until its expiry date**, which the panel shows you.

If a key has been exposed and its expiry is far away, revoke it and then contact support — and in
the meantime, assume it may still be usable for reads. This is why short expiries are worth the
minor inconvenience.

---

## Connecting an AI agent (MCP)

FairWins publishes an **MCP server**, which is the standard way to give an AI assistant such as
Claude access to a tool. It uses the key you created above, and it inherits exactly the permissions
you granted — no more.

The API access card generates the configuration snippet for you. It looks like this:

```json
{
  "mcpServers": {
    "fairwins": {
      "command": "node",
      "args": ["/path/to/services/mcp-server/src/server.js"],
      "env": {
        "FAIRWINS_API_URL": "https://relay.fairwins.app",
        "FAIRWINS_API_TOKEN": "fw1.…"
      }
    }
  }
}
```

Paste it into your MCP client's configuration, correct the path to wherever you put the server, and
restart the client. The server needs Node 20 or newer and installs nothing — it has no dependencies
at all, which is deliberate: it is a program that holds your key, so there is nothing else in it.

What the agent can then do: read your profile, membership, wagers and live fee rates, look up
public prediction markets and perpetual-futures pairs, and **prepare** an unsigned transaction for
you to review. These are the same look-ups the in-app assistant makes, with one addition: preparing
a transaction is offered to an external agent — which hands it back to you to sign in your own
wallet — and deliberately **not** to the in-app assistant.

What it cannot do: sign, submit, spend, transfer, or change anything. A prepared transaction comes
back to you, and you sign it yourself in your wallet. **The server has no key** and no way to
acquire one.

If a read fails — a network is down, an index is unavailable — the agent is told the read failed.
It is not given a zero. That matters: an agent that is handed "0 open wagers" will tell you that
you have none.

---

## What leaves your device

| While… | What is sent | Where it goes |
|---|---|---|
| The assistant is **off** and you have **no API key** | Nothing | — |
| The assistant is **on**, answered by **FairWins** | The messages you type in it, and the name of the screen you are on | FairWins gateway → our model provider, for the reply only |
| The assistant is **on**, answered by **GutterToken** | The messages you type in it, and the name of the screen you are on | **Directly from your device to GutterToken**, under your own GutterToken agreement. FairWins receives none of it |
| The assistant **looks up your data** to answer (either service) | A read request under the permission you signed | FairWins gateway, back to your own device only. We keep a count of reads, never their content |
| The assistant is **on** | Your conversation memory | **Nowhere.** It stays on this device. |
| You have saved a **GutterToken key** | The key | **Nowhere but GutterToken**, with each request you make. Never to FairWins, never into your backup |
| You hold an **API key** and a program uses it | Your wallet address, the key's id, its permissions and expiry — and the data you granted access to | FairWins gateway, to the program holding the key |

We do not collect your name, email, or identity documents for either feature. Full detail is in the
[Privacy Policy](https://fairwins.app/privacy) — see §2 *What We Process* and §5 *Sharing*.

---

## Opting out completely

1. **Tools → Assistant** — turn the master toggle off, then **Clear conversation memory**, then
   **Remove** any GutterToken key (and revoke it at GutterToken if you no longer want it anywhere).
2. **Tools → Assistant → API access** — revoke every key you are not using, and note each remaining
   key's expiry date.
3. Remove the FairWins entry from any MCP client configuration and delete the token from it.

After that, nothing about either feature is active for your account, and nothing is sent.

---

## Related

- [Privacy Policy](https://fairwins.app/privacy) — what is processed and who processes it
- [Risk Disclosure](https://fairwins.app/risk) §13 — AI and automation risk, and prepaid GutterToken credit
- [Terms & Conditions](https://fairwins.app/terms) §4.3(5) and §4.6 — AI components, the GutterToken service, and your responsibility for keys
- [FAQ](faq.md)
