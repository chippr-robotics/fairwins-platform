# FairWins — Privacy Policy

---

> This Privacy Policy is incorporated by reference into the
> [Terms & Conditions](/terms) and the [Risk Disclosure](/risk) and forms part of your
> agreement with us. Capitalized terms have the meanings given in the Terms & Conditions.

## 1. Who We Are

This Privacy Policy explains how **Chippr Robotics LLC** ("FairWins," "we," "us") handles
information in connection with the FairWins Service. FairWins is a non-custodial,
peer-to-peer wager management layer; we do not collect identity documents and we do not
operate a traditional user-account database.

## 2. What We Process

- **On-chain data.** Wagers, memberships, key registrations, and sanctions-screening
  outcomes are recorded on the public Polygon blockchain. **Blockchain transactions are
  public, permanent, and pseudonymous (not anonymous)** and may be analyzed and attributed
  by third parties outside our control. We cannot delete or alter on-chain data.
- **Wallet address.** Used to interact with the Service and the smart contracts.
- **Edge/access logs (compliance evidence).** When you access the Service, our edge
  provider (Cloudflare) and our hosting (Google Cloud Run) record standard request logs,
  including your **country of record** (derived from your IP at the edge), your **IP
  address**, user agent, and the access decision (served / denied for legal reasons). We
  use these logs as the record of geographic and eligibility enforcement.
- **Local browser state.** Your acknowledgement of the entry gate and the document
  versions you acknowledged are stored in your browser (local storage), not on our servers.
- **Assistant conversations — only while you enable the assistant.** The in-app assistant is
  **off by default**, and while it is off nothing you type is sent to us or to anyone else. If
  you switch it on, you choose which service answers it, and that choice decides where your
  messages go:
    - **FairWins assistant (membership).** The messages you send in it, and the name of the screen
      you are on when you send them, are transmitted to our gateway and to the AI model provider
      that generates the reply, and are processed for that purpose only.
    - **GutterToken (your own credits).** The same messages and screen name are sent **by your own
      device directly to GutterToken**, a third-party service with which you hold your own account,
      under **your own agreement with GutterToken**. **We do not receive, store, or process them**,
      GutterToken is **not** acting as our processor for that content, and GutterToken's own privacy
      terms govern it. The GutterToken key you enter is stored in your browser on the device you
      used, for the wallet you entered it with, and is never sent to us or included in your backup.

  Whichever service you choose, the assistant may **read your own FairWins data** — your wagers,
  your membership, and live fee rates — through the member API, under a read-only grant you sign
  in your wallet, in order to answer your questions. We record those reads as **counts only**,
  never their content. **We do not use your conversations to train models**, and we do not use or
  share them for advertising. Your conversation **memory** is kept in your browser on the device
  you used, not on our servers, and you can clear it at any time from the assistant's settings.
  Do not enter private keys, recovery phrases, or other secrets into the assistant.
- **API access grants — only if you create an API key.** If you create a private API key, we
  process the grant you signed — your **public wallet address**, the **key identifier**, the
  **permissions** it carries, and its **issue and expiry times** — in order to verify the key
  when a program presents it, together with any **revocation** you submit. The key itself is
  created by your own wallet signature and shown only to you: **we do not issue, hold, or store
  it.** The short, read-only grant the assistant uses to read your data is processed in the same
  way.

We do **not** collect names, government IDs, emails, or payment-card data through the
Service, and we do not run third-party advertising trackers.

## 3. Why We Process It (Lawful Basis)

- **Legal compliance & legitimate interests** — to enforce geographic and eligibility
  restrictions (including sanctions and prohibited jurisdictions), to maintain a defensible
  record of that enforcement, and to operate and secure the Service.
- **Contract** — to provide the Service you request when you interact with it.

## 4. Retention

- **On-chain records** are permanent and outside our control.
- **Accepted-user enforcement evidence** in access logs is retained for the applicable
  statutory/compliance window.
- **Declined/blocked (non-consenting) visitor** access-log records are minimized to the
  compliance-relevant fields (country, IP, timestamp, decision) and retained for a
  shorter, bounded period appropriate to the enforcement purpose.

## 5. Sharing

We share information only: with our infrastructure providers (edge/CDN, hosting, IPFS
pinning) acting on our behalf; with on-chain sanctions-screening sources we read (e.g.,
the Chainalysis on-chain oracle); and where required by law or to protect our rights.

**Where you have enabled the assistant and chosen the FairWins assistant**, we also share the
messages you send in it, and the name of the screen you are on, with the **AI model provider**
that generates the reply (currently **Anthropic**), acting as our processor for that purpose and
for no other. This sharing happens **only while you have the assistant enabled with that service
selected**, and stops when you turn it off or switch to GutterToken. **Where you have chosen
GutterToken**, we share nothing: your own device sends your messages directly to GutterToken under
your own agreement with it, and we are not in that path and do not receive them. Where the
assistant reads your FairWins data to answer you, that data is returned to your own device only.

## 6. Your Choices and Rights

Because the Service is largely non-custodial and pseudonymous, our ability to identify you
is limited. Where applicable law grants you rights over personal data (such as access or
erasure of the access-log data that can be linked to you), you may contact us at howdy@fairwins.app. Note that **on-chain data cannot be erased**.

## 7. Security

We apply reasonable technical and organizational measures, including edge filtering,
origin authentication, and least-privilege access to logs. No method of transmission or
storage is perfectly secure.

## 8. International Transfers

The Service is operated using infrastructure that may process data in the United States
and other regions. Where required, we rely on appropriate safeguards for cross-border
transfers.

## 9. Changes

We may update this Privacy Policy; material changes are indicated by an updated version
(the SHA-256 hash of this document) and, where practical, by notice through the Service.

## 10. Contact

Questions about privacy: Howdy@fairwins.app

*— End of Privacy Policy —*
