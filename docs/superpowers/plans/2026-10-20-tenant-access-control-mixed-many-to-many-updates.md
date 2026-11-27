# Mixed scalar and many-to-many updates

Continue the approved design on `feat/tenant-access-control`. Extend the existing
root update adapter to save scalar fields with exactly one BelongsToMany field.
Do not add routes, enable business tables, edit targets, or support multiple
association fields in one request.

## Contract

- Use finalized update fields and role predicates and authorize source ownership
  from the locked old row.
- Require list/read/G/V for added targets only. Preserve unchanged hidden links;
  removing a link never edits the target.
- Save changed scalar fields, legacy claim and join-row differences in the same
  serializable transaction. Denial, hooks and metadata drift roll everything back.
- No actual scalar or link change means no write and no historical claim. Reuse
  ORM-aware no-op detection; never call business setters to predict a write.
- Preserve standalone add/remove/set behavior. Raw join keys, nested target edits,
  multiple associations and non-pure through collections remain rejected.

## Files and steps

- Modify `packages/module-tenant/src/server/__tests__/access-control/many-to-many-mutation-handler.test.ts`.
- Modify `packages/module-tenant/src/server/access-control/reference-mutation-handler.ts`.
- Modify `packages/module-tenant/src/server/access-control/many-to-many.ts`.
- Modify `packages/module-tenant/src/server/access-control/write-support.ts` and
  `belongs-to.ts` only to share the already-tested ORM-aware change predicate.
- Update `docs/superpowers/specs/2026-10-13-tenant-access-control-design.md`.

1. Add PostgreSQL cases for mixed success and field filtering, denied target,
   link-only and scalar-only writes, no-op legacy preservation, historical claim,
   hook/metadata rollback, and old role-scope exit. Run the focused file in a new
   isolated local test database and confirm missing support fails.
2. Extract `hasPersistedChanges(record, values)` into `write-support.ts`, use it
   from BelongsTo, and route the captured scalar patch through the existing
   `authorizeExisting` plan when present.
3. In `withLinks`, determine scalar changes and connection differences after
   locking. Write their union through the existing Repository and relation APIs,
   then run existing protected-value, owner, and final-link checks before commit.
4. Run PostgreSQL tests for belongs-to and many-to-many handlers plus reference
   regressions; run focused oxlint/format checks and the module-tenant build.
   Request independent review, fix blockers, and make one signed commit.

## Evidence

- PostgreSQL-enabled focused regression run: 375 passed, 75 skipped across the
  many-to-many, BelongsTo, reference, and root-update suites. Tests used a
  randomly named isolated local database, which was dropped after the run.
- Fresh rerun of the four focused Vitest files without
  `TENANT_ACCESS_TEST_DATABASE_URL`: 140 passed, 75 skipped. The PostgreSQL-only
  cases were skipped because the database URL was not present in this shell.
- `pnpm exec oxlint` on changed TypeScript files: 0 warnings, 0 errors.
- Prettier check on changed source and documentation: passed.
- `pnpm exec tegod build @tachybase/module-tenant`: passed.
- `git diff --check`: passed.
- No business database data was changed; the temporary isolated PostgreSQL
  database from the PostgreSQL-enabled run was removed after testing.
