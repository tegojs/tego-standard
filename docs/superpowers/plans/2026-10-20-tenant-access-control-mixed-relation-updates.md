# Save single-value and many-to-many references together

Continue the approved G/V design on `feat/tenant-access-control`. A root update
may combine scalar values, BelongsTo keys/null and BelongsToMany key arrays,
with at most 20 association fields in total. No routes or business data change.

The existing many-to-many transaction coordinates the mixed save: capture all
relationships before awaiting, authorize/lock the source once, authorize each
changed non-null reference and each added link independently, then save the
source once and apply the link differences. Keep unchanged hidden references,
no-op behavior, legacy claims and rollback semantics. Verify every selected
foreign key, link set, ownership and other protected keys after all hooks.
Separate transactions or invoking both existing handlers would permit partial
saves or duplicate source writes, so neither approach is used.

## Files and steps

- [x] Add `__tests__/access-control/mixed-relation-mutation-handler.test.ts`
  with real ACL/Resourcer/Repository and isolated PostgreSQL. First demonstrate
  that the old same-type restriction rejects a valid mixed update.
- [x] Extend `access-control/many-to-many.ts` with optional bounded BelongsTo
  references and an independent target-scope callback, preserving existing
  single-type calls. Capture metadata, check added targets before writes and
  verify exact foreign keys after join hooks.
- [x] Update `access-control/reference-mutation-handler.ts` to partition the
  captured associations by actual relationship type, require all source field
  grants and pass independent target guards to the shared transaction.
- [x] Cover reversed input order, multiple fields of both types, hidden existing
  references, per-target scope/ACL denial, source V-only denial, historical
  claim/no-op, snapshot/metadata drift, hook interference, rollback and limits.
- [x] Run the mixed suite plus existing multiple-link, many-to-many,
  many-to-many-handler, belongs-to-handler and reference suites. Run focused
  oxlint/Prettier/diff checks and the tenant build. Obtain independent review,
  update the approved design and make one signed atomic English commit.

Nested target edits, target-foreign-key writes, create with many-to-many fields
and business-bearing join tables remain outside this increment. Tests use an
isolated local database, never the restored business database.

## Verification evidence

- Initial red: valid mixed updates failed with the old same-type restriction
  before SQL. The first green run passed all 18 PostgreSQL scenarios.
- Additional red: a synchronous identity callback changed a later submitted
  BelongsTo field into HasMany; the handler silently omitted it and returned
  success. Capture all submitted relationship types before identity callbacks,
  then partition by that snapshot so the original resolver rejects the change.
- Independent read-only review checked the actual changes, including this final
  correction, and found no blocking issues. Target grant indices remain distinct
  across the two groups and stable across sorted join processing.
- Final command after the source correction:
  `node C:/Users/TomyJan/AppData/Local/Temp/tego-access-reference-runner.cjs mixed-relation-mutation-handler.test.ts multiple-link-mutation-handler.test.ts many-to-many.test.ts many-to-many-mutation-handler.test.ts belongs-to-mutation-handler.test.ts reference.test.ts`.
  All six files pass: 456 passed, 190 intentional dialect skips (646 cases).
  The new suite passes 50 cases with 44 intentional SQLite skips; SQLite still
  verifies malformed root inputs before SQL. The runner removed the isolated
  database `tego_tenant_access_test_d547a49cf8` after the run.
- `pnpm exec tegod build @tachybase/module-tenant`, including declarations, passes
  after the final source correction. Focused oxlint reports zero warnings/errors;
  formatting and diff checks pass. No business database, dependency, route or
  production configuration changed.
