# Save multiple existing references with scalar fields

Continue the approved tenant access-control design on `feat/tenant-access-control`.
Root update accepts up to 20 distinct registered BelongsTo fields, containing keys
or null, together with scalar fields. Existing single-reference and one-field
BelongsToMany paths retain their behavior. No routes or business configuration change.

## Design

- Extend `AccessBelongsToService` with `withReferences`; keep `withReference` as a
  compatible single-item adapter. Capture all identities, keys and relationships
  before the first await, authorize/lock the source once, then independently check
  only changed non-null targets in the same PostgreSQL serializable transaction.
- Extend the existing reference handler's captured plan rather than adding a
  parallel permission implementation. Every submitted reference requires source
  field permission; each new target requires its own finalized neutral list grant,
  readable primary key, role, G/V and registered scope. Recheck all captured guards
  after asynchronous authorization and persistence.
- Keep unmodified hidden references and clearing references usable without reading
  old targets. A complete no-op does not write or claim historical data. Real edits
  may claim only the source when its G permits editing; referenced targets remain
  unchanged. Any failure rolls back scalar changes, references and a source claim.
- Preserve source authorization against the pre-edit record. Verify every exact
  persisted FK and owner and protect unrelated relationship keys after hooks.
  Reject raw FKs, nested writes, mixed relationship types, duplicates and more than
  20 reference fields. No nested transactions, per-field commits or automatic retries.

## Implementation and validation

- [x] Add a PostgreSQL two-reference success test to
  `packages/module-tenant/src/server/__tests__/access-control/belongs-to-mutation-handler.test.ts`;
  run it against the existing handler and observe the single-association rejection.
- [x] Generalize `packages/module-tenant/src/server/access-control/belongs-to.ts`
  and the existing `reference-mutation-handler.ts` path; retain single-reference
  low-level explicit target constraints and the existing many-to-many adapter.
- [x] Cover independently configured targets, role/key/field denial, changed versus
  unchanged/null references, old-source role conditions, historical claims and
  no-ops, hook rollback, async snapshots/metadata changes, protected FKs and limits.
- [x] Run `belongs-to-mutation-handler.test.ts`, `reference.test.ts`,
  `many-to-many-mutation-handler.test.ts`, `root-mutation-handler.test.ts`, and
  `reference-creation-handler.test.ts` with the isolated PostgreSQL runner. Run
  focused oxlint/Prettier and `pnpm exec tegod build @tachybase/module-tenant`.
- [x] Review actual code/diff, update the main design and validation evidence, and
  make one signed English atomic commit. Do not push or change production.

## Evidence

- Red: the new two-reference save failed with the existing handler's
  `Reference updates require exactly one association` guard; all other cases passed.
- Green: the changed handler suite passes 108 tests with 66 deliberate dialect
  skips. Cases include independent customer/project configurations, exactly 20
  references, rejection of 21 and mixed relationship types before SQL, historical
  claims/no-ops, independent grants/scopes, async metadata/input changes, hook
  rollback and malformed trusted lists.
- The tenant package build, including declarations, passes after capturing the
  narrowed submitted object for asynchronous-plan callbacks. Focused oxlint has
  no warnings/errors. Independent code review found no blocking issue.
- Final related regression: `reference.test.ts`, `many-to-many-mutation-handler.test.ts`,
  `root-mutation-handler.test.ts` and `reference-creation-handler.test.ts` pass
  358 tests with 86 deliberate dialect skips. Together with the changed handler
  suite, all five files pass 466 tests with 152 skips. Both isolated PostgreSQL
  test databases were removed by the runner; no business data was changed.
- Final actual diff review, five-file Prettier check and `git diff --check` pass.
  This increment changes only internal reference updates and their tests/design;
  it does not enable business routes or change production configuration.
