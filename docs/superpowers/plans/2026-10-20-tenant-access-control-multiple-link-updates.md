# Save multiple existing many-to-many references

Continue the approved access-control design on `feat/tenant-access-control`.
This increment supports a root update containing scalar fields and up to 20
distinct BelongsToMany fields. Each field is a dense array of existing primary
keys; an empty array clears its connections. Mixed relation types, nested target
edits and business-bearing join tables remain outside this increment.

## Design and files

- Extend `packages/module-tenant/src/server/access-control/many-to-many.ts` with
  `withLinkSets`, retaining `withLinks` as the single-field adapter. Capture every
  target, join identity, key and relation before awaiting. Authorize and lock the
  source once in a PostgreSQL serializable transaction, then lock original joins
  in a stable order. Compute all differences and authorize additions independently
  before performing any writes. Bound total requested and existing connections to
  10,000 and reject overlapping join tables to avoid ambiguous replacements.
- Extend `reference-mutation-handler.ts` to capture multiple same-type fields and
  their original array shape, finalized source field grants, independent neutral
  target list decisions and metadata guards. Preserve single-field association
  actions and multiple BelongsTo updates.
- Keep unchanged hidden links and removals usable without reading old targets.
  Actual edits may claim only an editable historical source; complete no-ops do
  not write or claim. Final checks cover every join set, source ownership and
  protected relationship keys after all repository hooks. Any error rolls back
  every scalar/link change and afterCommit callback.
- Add `__tests__/access-control/multiple-link-mutation-handler.test.ts` using real
  ACL/Resourcer/Repository and isolated PostgreSQL. Update the main design with
  the implemented boundary. No routes, dependencies or business data change.

## Steps and validation

- [x] Write a two-field success test, run it against the existing handler and
  observe rejection by the current multiple-association type guard.
- [x] Implement the bounded service and handler extension without nested
  transactions, per-field commits or a second authorization implementation.
- [x] Verify independent permissions/scopes, hidden unchanged/removal behavior,
  historical claim/no-op, snapshots and metadata drift, all-field rollback, join
  hook interference, malformed arrays and relation/batch limits.
- [x] Run the changed suite and `many-to-many.test.ts`,
  `many-to-many-mutation-handler.test.ts`, `belongs-to-mutation-handler.test.ts`
  and `reference.test.ts` using the isolated runner. Run focused oxlint,
  Prettier, diff checks and `pnpm exec tegod build @tachybase/module-tenant`.
- [x] Review the actual changes independently, resolve valid findings, record
  evidence and create one signed atomic English commit. Do not push.

## Evidence

- Red: the two-field success case failed against the original handler with
  `Multiple reference updates support only BelongsTo associations` before SQL.
- Green: the new suite passes 57 tests, with 37 intentional non-PostgreSQL skips.
  It verifies one source authorization/update, independent target grants and
  scopes (including two fields targeting the same collection), changed targets
  only, historical claim/no-op, asynchronous snapshots, metadata drift and final
  phase checks, whole-save rollback, afterCommit non-publication, malformed
  arrays/trusted plans, the 20-field boundary and overlapping joins.
- Final combined run after the last source change: all five files pass 406 tests
  with 146 intentional dialect skips (552 cases). The tenant package build,
  including declarations, also passes. The runner removed its isolated database
  `tego_tenant_access_test_b695557634` after the successful run.
- Independent read-only code review found no blocking issue. Focused oxlint has
  no warnings/errors and all six changed files pass Prettier and diff checks.
- Test data uses randomly named isolated local PostgreSQL databases. The runner
  removes each database; business databases and production are unchanged.
