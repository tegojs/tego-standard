# Create a record with multiple existing references

Continue the approved access-control design on `feat/tenant-access-control`.
Extend root creation from one BelongsTo reference to at most 20 distinct registered
BelongsTo fields, each containing a target primary key or null. Keep scalar-only
and single-reference callers compatible. No runtime route or business migration.

## Contract and implementation

- Capture all selected keys, collection identities and relationship metadata before
  the first asynchronous target authorization. Do not prepare later references
  after awaiting earlier decisions. Check every captured guard after each await.
- Require source create field permission for every selected reference. Each
  non-null target needs its own finalized neutral list/key grant and independent
  role, G/V and registered scope checks; null skips only target list authorization.
- Reuse the existing single PostgreSQL serializable creation transaction, INSERT
  receipts and persisted source G/role/ownership checks. Put only the registered
  foreign keys into the server-owned plan and verify every exact stored value.
- Retain the trusted `reference` request option for existing service callers and
  add `references` for the new list; reject supplying both or duplicate fields.
  Raw foreign keys, nested writes, HasMany/HasOne/BelongsToMany, unregistered fields
  and cross-source references remain rejected. A reference never claims a target.

## Files and checks

- [x] Extend `reference-creation-handler.test.ts` with two independently configured
  target collections. Prove the new success case fails with the old one-reference
  guard before implementing the change.
- [x] In `creation-reference.ts`, prepare all references synchronously and expose
  one aggregate lifecycle guard and an ordered resolver returning captured grants.
- [x] In `root-mutation-handler.ts`, recognize all prepared relationship field
  names while retaining scalar filtering and managed ownership validation.
- [x] In `creation.ts`, normalize single/list options, capture all metadata and
  foreign-key expectations, authorize targets in one transaction, and retain the
  existing receipt, hook, rollback and final source authorization behavior.
- [x] Test independent target denial, key/field/role grants, null and historical
  references, async input snapshots and metadata changes, hook rollback and limits.
- [x] Run the changed file plus creation, root-creation, reference and root-mutation
  regressions with `node .../tego-access-reference-runner.cjs <explicit test files>`.
  The local runner creates/removes a random dedicated PostgreSQL database and
  cannot target the business database. Run focused oxlint/Prettier, the tenant
  package build and staged diff checks. Review and make one signed English commit.
- [x] Update the main design's supported capabilities and remaining limits.

## Evidence

- Red: the initial two-reference success case failed with the old single-reference
  guard (`Creation supports exactly one BelongsTo reference`).
- Red: an explicit null trusted reference list reached the writer and failed with
  the wrong error. Normalize only undefined as absent; reject null before writing.
- The changed reference-creation suite passes 54 tests, with 42 deliberate dialect
  skips, including exactly 20 references and rejection of 21 before SQL/authorization.
- The tenant package build (including declarations), focused oxlint and Prettier
  checks pass. Independent review found no blocking issue, including the final
  null-list and 20-reference boundary changes.
- Final focused regression: `reference-creation-handler.test.ts`, `creation.test.ts`,
  `root-creation-handler.test.ts`, `reference.test.ts` and `root-mutation-handler.test.ts`:
  five files passed, 381 tests passed and 45 dialect-specific cases skipped. The
  runner removed its isolated PostgreSQL database after completion; business data
  and routes were unchanged.
