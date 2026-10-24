# Contract: UI components & integration points

## `AddressBookPanel` (My Account → Address Book tab)

```jsx
<AddressBookPanel address={ownerAddress} />
```

- Lists contacts (via `ContactCard`), each grouping its addresses with a
  `RestrictionTag` per restricted/uncertain address and a contact-level
  "contains restricted" mark (FR-012).
- CRUD: add/edit/delete contact; add/edit/delete address (via `ContactEditModal`)
  (FR-004). Network field defaults to the active chain (FR-003).
- Search box filters contacts/addresses (FR-015 within the panel).
- Import/Export buttons drive `addressBookFile` (plain text since issue #1550) and the
  merge-conflict flow. Each carries an icon beside its word label, and an `aria-label`
  because `.ab-btn-label` is hidden below 640px — an icon-only button with an
  `aria-hidden` icon has no accessible name (FR-033). Neither is gated on a wallet
  signer. A standing note beside them states that an export is readable by anyone who
  opens it (FR-031).
- Screens visible addresses on open via `useAddressScreening` (FR-010, Q5).
- Empty state when the book is empty; no-wallet state consistent with other My
  Account sections (edge case).
- Accessibility: WCAG 2.1 AA; tags use icon + text, not colour alone (FR-023).

## `ContactEditModal`

```jsx
<ContactEditModal contact={contact|null} defaultChainId={activeChainId}
                  onSave={(contactDraft) => void} onCancel={() => void} />
```

- Validates address (FR-005) and shows a duplicate warning when `(address, chainId)`
  already exists (edge case), offering to consolidate or proceed.
- Supports multiple addresses per contact (FR-002), each with network + notes.

## `RestrictionTag`

```jsx
<RestrictionTag status={'restricted' | 'uncertain' | 'clear' | 'loading'} />
```

- `restricted` → visible warning (icon + "Restricted" text).
- `uncertain` → "Unscreened" (icon + text), visually distinct from clear (FR-011).
- `clear`/`loading` → no warning (or a subtle pending indicator).

## `AddressInput` (extended, backward-compatible)

New **optional** props on the existing component
(`frontend/src/components/ui/AddressInput.jsx`):

```jsx
<AddressInput
  // …existing props (value, onChange, onResolvedChange, …) unchanged…
  enableAddressBook={false}   // opt-in; default off → no behaviour change at existing call sites
  chainId={activeChainId}     // network context for screening + saved-address default
/>
```

- When `enableAddressBook`, renders an `AddressBookPicker` affordance; selecting an
  entry populates the field through the existing `onChange`/`onResolvedChange`
  (FR-015/016).
- Surfaces a `RestrictionTag` when the current resolved/selected address screens as
  restricted/uncertain (FR-016).
- With `enableAddressBook` falsy, behaviour is identical to today (no regressions).

## `AddressBookPicker`

```jsx
<AddressBookPicker query={string} onSelect={({ address, chainId, nickname }) => void} />
```

- Searchable dropdown over `searchEntries(book, query)`; shows nickname, shortened
  address, network, and a `RestrictionTag` per result.
- Returns no misleading results when the book is empty (edge case).

## `SaveAddressToast` (post-action, non-blocking — clarified Q4)

```jsx
<SaveAddressToast address={address} chainId={chainId}
                  onSave={(draft) => void} onDismiss={() => void} />
```

- Shown after an action confirms on-chain **only** when the address is not already in
  the book (FR-017). Dismissible; ignoring/dismissing never affects the completed
  action (FR-018).
- "Save" opens a minimal quick-add (nickname required; network prefilled; notes
  optional) or attaches to an existing contact.

## Integration: `WalletPage.jsx`

- Add `{ id: 'addressbook', label: 'Address Book' }` to `WALLET_TABS`.
- Render `<AddressBookPanel address={address} />` when `activeTab === 'addressbook'`.

## Integration: `FriendMarketsModal.jsx`

- Pass `enableAddressBook` + `chainId` to the opponent and arbitrator
  `AddressInput`s.
- After a successful create/accept, trigger `SaveAddressToast` for the counterparty
  address if not already saved.
