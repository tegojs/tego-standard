# Create a record with an existing BelongsTo reference

Continue the approved tenant access design on `feat/tenant-access-control`.
Support a single root create with scalar fields and one BelongsTo key or null.
Keep the existing scalar-only creation entry compatible. Do not register business
routes, enable business tables, add nested creates, or accept raw foreign keys.

## Design

- Reuse `AccessRootMutationHandler` and `AccessCreationService`, including final
  create permission, field filtering, INSERT receipts, persisted ownership and G.
- Capture the selected relation, key, identity and metadata before asynchronous
  target authorization. Require final neutral list permission with a readable
  target key for a non-null reference, independently of source create permission.
- Validate target role conditions, G/V and association scope inside the same
  PostgreSQL serializable transaction as the INSERT. A reference never edits or
  claims its target. Source G and role conditions inspect the actual inserted row.
- Add only the resolved registered foreign key to the server-owned creation plan.
  Verify its exact persisted value, retaining rejection of other relationship
  keys introduced by defaults or hooks. Recheck metadata through final queries.
- Null does not require a target list decision, but still validates relation
  metadata and source field permission. Missing/hidden targets, invalid roles,
  hooks and phase changes fail without publishing a success response.

## Files

- `packages/module-tenant/src/server/access-control/creation-reference.ts`:
  capture one registered reference and its independent finalized target grant.
- `packages/module-tenant/src/server/access-control/root-mutation-handler.ts`:
  accept an optional trusted target authorizer for create and preserve scalar-only
  behavior, source field filtering and protected ownership checks.
- `packages/module-tenant/src/server/access-control/creation.ts`: authorize the
  reference and persist its exact FK within the existing creation transaction.
- `packages/module-tenant/src/server/__tests__/access-control/reference-creation-handler.test.ts`:
  actual ACL/Repository regression cases for success and all denial boundaries.
- `docs/superpowers/specs/2026-10-13-tenant-access-control-design.md`: describe the
  supported entry and its remaining limits.

## Steps

- [x] Add a visible-target creation regression.
- [x] Implement the captured reference and same-transaction creation plan.
- [x] Test source G/create/field and target list/key/role/G/V independently;
  legacy targets, null, invalid/nested/raw-key input, hooks, metadata changes and
  input snapshots must preserve atomicity and ownership.
- [x] Run the new file plus creation, root-creation, reference and root-mutation
  regressions in a dedicated randomly named local PostgreSQL test database.
- [x] Run focused oxlint, Prettier, module-tenant build and diff checks. Review and
  make one signed English commit; do not push or change business data.

## Evidence

- `reference-creation-handler.test.ts`: 33 passed, 21 skipped. Actual relation
  writes run on PostgreSQL; SQLite verifies invalid input and scalar compatibility.
- Existing regressions: `creation.test.ts` 78 passed, `root-creation-handler.test.ts`
  82 passed / 2 skipped, `reference.test.ts` 58 passed,
  `root-mutation-handler.test.ts` 109 passed / 1 skipped.
- First combined run found one overly specific new error-text assertion: a
  constrained target lookup was correctly rejected by an earlier parameter guard.
  Asserted its stable error code instead; the full new file passed on rerun.
  Total passing coverage across the five files: 360 passed, 24 skipped.
- Tests used new randomly named local PostgreSQL databases, removed after each
  run. No business tables, production data or runtime routes were changed.
- Focused oxlint: 0 errors/warnings; Prettier and `git diff --check`: passed.
- `pnpm exec tegod build @tachybase/module-tenant`: passed, including declarations.
- Independent read-only review found no blockers. Added the recommended case
  proving a readable target outside the registered association scope is rejected
  without creating the source or modifying the target; it passed on PostgreSQL.
