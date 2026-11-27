# Mixed scalar and belongs-to updates

Continue the approved access-control design on `feat/tenant-access-control`.
This increment supports one root update containing scalar fields and one
BelongsTo reference. It does not register runtime routes or migrate business tables.

## Contract

- Apply finalized source update field grants and role conditions, then ownership
  authorization against the old record. Preserve server-managed ownership checks.
- Read-authorize only a changed, non-null target. Never edit or claim the target.
- Persist the scalar patch and reference in the same existing serializable
  transaction. A denied target, hook failure or metadata drift rolls both back.
- A finalized no-op must not claim historical data. Compare scalar values through
  ORM field normalization; do not run business setters while predicting changes.
- Preserve unchanged hidden references and allow an authorized edit to leave its
  previous role/ownership condition.
- Reject raw foreign keys, nested target edits and multiple associations. Mixed
  many-to-many updates remain outside this increment.

## Implementation and verification

1. Add PostgreSQL regression cases to `belongs-to-mutation-handler.test.ts` and
   observe missing mixed-update support fail before implementation.
2. Split the captured input into one association and scalar values. Validate and
   filter scalar values using the root-update contract, retaining managed tenantId
   for anti-transfer validation even when ACL excludes it.
3. Pass the sanitized patch into `AccessBelongsToService`; reuse
   `AccessMutationService.authorizeExisting` inside its transaction instead of
   starting a second transaction or weakening `authorizeReferenceSource`.
4. Verify mixed success, field grants, unchanged hidden references, old-state
   authorization, historical claims, target denials, hook failures and async drift.
   Run focused reference/root/many-to-many regressions, lint and tenant build in
   isolated local test databases. Review and make one signed atomic commit.

## Evidence

Implementation complete. New mixed-update cases first failed against the old
single-field entry. PostgreSQL regressions also reproduced an unchanged historical
record being claimed, an unchanged date submitted as JSON being misclassified,
and a model-level setter being called twice; each was fixed and rechecked.

- `belongs-to-mutation-handler.test.ts`: 71 passed, 31 SQLite relationship-write
  cases skipped; actual writes exercised on PostgreSQL.
- `reference.test.ts`: 58 passed.
- `root-mutation-handler.test.ts`: 109 passed, 1 skipped.
- `many-to-many-mutation-handler.test.ts`: 129 passed, 35 SQLite relationship-write
  cases skipped.
- Total: 367 passed, 67 skipped. Each file used its own new isolated local
  PostgreSQL database, removed after the run; business data was not changed.
- Focused oxlint: no warnings/errors. Prettier and `git diff --check`: passed.
- `pnpm exec tegod build @tachybase/module-tenant`: passed, including declarations.
- Independent review: date normalization and model-level setter findings fixed,
  regression-tested and re-reviewed; no remaining blockers.
