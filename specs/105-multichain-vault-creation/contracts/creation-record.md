# Contract — vaultCreationRecords synced object

- **Store**: `frontend/src/lib/custody/vaultCreationRecords.js`; userStorage key
  `vault_creation_records`; account-scoped; registered in `lib/backup/syncedObjects.js` as
  NON-network-scoped (the record is the chain-independent facts).
- **API**: `loadCreationRecords(account)`, `getCreationRecord(account, address)`,
  `saveCreationRecord(account, record)` (refuses overwrite of a differing existing record),
  `mergeCreationRecords(current, incoming)` (union by address, existing wins, deterministic).
- **Privacy**: addresses + public deployment parameters only. Never key material, never a secret,
  never a device identifier. Rules amounts are member preferences, synced like vault labels.
- **Honesty**: absence of a record is a first-class state ⇒ FR-018 reason on Add-a-network.
  Presence does not imply deployments — the chain is probed per network.
