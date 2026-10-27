import type { ImportXlsxCell, ImportXlsxColumn } from '@tachybase/plugin-action-import';
import { Op, type Collection, type Database, type Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { MAX_CREATION_REFERENCES, type AccessCreationReference } from './creation';
import type { AccessCreationTargetAuthorizer } from './creation-reference';
import { captureAccessFilter } from './filter-input';
import { captureFinalActionPermission } from './final-action-permission';
import { captureScalarImportField } from './import-fields';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter } from './read-grants';
import { AccessReadService } from './reads';
import { AccessRoleFilterCompiler } from './role-filter';
import { captureRelatedReadPermission, type AccessRootReadContext } from './root-read-context';
import { cloneDeep, invalid, normalizeKeys, plain, unavailable } from './write-support';

function names(value: unknown): string[] | undefined {
  if (value === undefined) return;
  const result = captureAccessFilter(value);
  if (
    !Array.isArray(result) ||
    result.some((name) => typeof name !== 'string') ||
    new Set(result).size !== result.length
  )
    invalid('Import reference field grants require distinct names');
  return result as string[];
}

function dense(value: unknown, limit: number): asserts value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > limit ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    invalid('Import reference selections require bounded dense arrays');
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index)) invalid('Import reference selections cannot contain holes');
}

/** Internal read-only preparation for an eventual import writer; no importer or routes are installed. */
export class AccessImportReferenceLookup {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  prepare(
    ctx: AccessRootReadContext,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    columns: unknown,
    authorize: AccessCreationTargetAuthorizer,
  ) {
    source = cloneDeep(source);
    const actor = Object.freeze(cloneDeep(authenticated));
    const action = Object.getOwnPropertyDescriptors(ctx.action);
    if (
      ctx.db !== this.db ||
      !plain(actor) ||
      typeof actor.roleName !== 'string' ||
      action.resourceName?.value !== source.collectionName ||
      action.actionName?.value !== 'importXlsx' ||
      action.sourceId?.value !== undefined ||
      action.resourceOf?.value !== undefined ||
      typeof authorize !== 'function'
    )
      invalid('Import reference context does not match the root import operation');
    const permission = captureFinalActionPermission(ctx.permission, {
      resourceName: source.collectionName,
      actionName: 'importXlsx',
      roleName: actor.roleName,
    });
    if (!permission.allowed || !plain(permission.params)) invalid('Import reference operation is not authorized');
    const fields = names(permission.params.fields);
    const whitelist = names(permission.params.whitelist);
    const blacklist = names(permission.params.blacklist);
    dense(columns, MAX_CREATION_REFERENCES);
    if (!columns.length) invalid('Select at least one import reference');
    const captured = cloneDeep(columns) as ImportXlsxColumn[];
    const selectedNames = new Set<string>();
    // Prepare all mappings synchronously before invoking any independent target authorization.
    const selections = captured.map((column) => {
      if (!plain(column)) invalid('Import reference columns must be plain objects');
      dense(column.dataIndex, 2);
      const [name, lookup] = column.dataIndex;
      if (
        column.dataIndex.length !== 2 ||
        typeof name !== 'string' ||
        typeof lookup !== 'string' ||
        selectedNames.has(name) ||
        (fields !== undefined && !fields.includes(name)) ||
        (whitelist !== undefined && !whitelist.includes(name)) ||
        blacklist?.includes(name)
      )
        invalid('Import reference mapping is unavailable or unauthorized');
      selectedNames.add(name);
      const collection = this.db.getCollection(source.collectionName);
      const field = collection?.getField(name);
      const association = collection?.model.associations[name];
      const target = association && this.db.modelCollection.get(association.target);
      const targetIdentity = target && cloneDeep(this.resolveIdentity(target));
      if (
        !field ||
        field.options.interface === 'attachment' ||
        !target ||
        !targetIdentity ||
        targetIdentity.collectionName !== target.name
      )
        invalid('Import reference target identity is unavailable');
      // This plan only reads. The eventual writer independently validates FK write protection.
      const relation = resolveBelongsTo(this.db, this.prepared, this.queries, ctx, source, targetIdentity, name);
      if (blacklist?.includes(relation.foreignKey)) invalid('Import reference foreign key is not authorized');
      if (!Object.hasOwn(target.model.rawAttributes, lookup)) invalid('Import lookup field is unavailable');
      const lookupType = (target.model.rawAttributes[lookup].type as { key?: string }).key;
      if (!['STRING', 'TEXT', 'BOOLEAN', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT'].includes(lookupType))
        invalid('Import lookup fields require text, boolean or integer values');
      const scalar = captureScalarImportField(this.db, target, lookup);
      const metadata = accessMetadataGuard(
        this.db,
        [
          { model: relation.sourceModel, config: relation.sourceConfig },
          { model: relation.targetModel, config: relation.targetConfig },
        ],
        [{ model: relation.sourceModel, path: [name] }],
      );
      const assertCurrent = () => {
        relation.current();
        metadata();
        scalar.assertCurrent();
        const current = this.resolveIdentity(target);
        const currentSource = this.resolveIdentity(collection);
        if (
          !current ||
          current.collectionName !== target.name ||
          accessCollectionKey(current) !== accessCollectionKey(targetIdentity) ||
          !currentSource ||
          accessCollectionKey(currentSource) !== accessCollectionKey(source) ||
          collection.getField(name) !== field ||
          field.target !== target.name ||
          field.options.interface === 'attachment'
        )
          invalid('Import reference identity changed during lookup');
      };
      assertCurrent();
      return { column, name, lookup, target, targetIdentity, relation, scalar, assertCurrent };
    });
    const checks = selections.map((selection) => selection.assertCurrent);
    const assertCurrent = () => checks.forEach((check) => check());
    let used = false;
    return {
      assertCurrent,
      resolve: async (input: unknown, transaction?: Transaction): Promise<AccessCreationReference[][]> => {
        if (used) invalid('Import reference lookup plans are single-use');
        used = true;
        dense(input, 1000);
        if (!input.length) invalid('Select at least one import reference row');
        for (const row of input) dense(row, selections.length);
        const rows = cloneDeep(input) as ImportXlsxCell[][];
        if (
          rows.some(
            (row) =>
              row.length !== selections.length ||
              row.some(
                (cell) =>
                  cell !== null &&
                  typeof cell !== 'string' &&
                  typeof cell !== 'boolean' &&
                  !(typeof cell === 'number' && Number.isFinite(cell)),
              ),
          )
        )
          invalid('Import reference cells must match the selected columns');
        assertCurrent();
        const grants = [];
        for (const selection of selections) {
          const related = await authorize(selection.target);
          assertCurrent();
          if (!related) invalid('Import reference target operation is not authorized');
          const decision = captureRelatedReadPermission(this.db, selection.target, actor.roleName, related);
          const plan = new AccessReadGrantAdapter(this.db, (collection) => {
            const identity = this.resolveIdentity(collection);
            return identity && accessCollectionKey(identity);
          }).capturePlan(
            selection.targetIdentity,
            decision,
            new AccessRoleFilterCompiler(this.db, this.resolveIdentity),
          );
          const primary = selection.target.model.primaryKeyAttribute;
          if (!plan || !plan.grant.fields.includes(primary) || !plan.grant.fields.includes(selection.lookup))
            invalid('Import target key and lookup field must be readable');
          checks.push(plan.assertCurrent);
          const grant = {
            ...plan.grant,
            where: { [Op.and]: [plan.grant.where ?? {}, selection.relation.scope ?? {}] },
          };
          const reader = new AccessReadService(
            this.db,
            this.prepared,
            this.queries,
            (collection, path) => {
              if (collection !== selection.target || path.length)
                invalid('Import lookup requires a root scalar predicate');
              return grant;
            },
            assertCurrent,
          );
          grants.push({ reader, grant, primary });
        }
        assertCurrent();
        const result: AccessCreationReference[][] = [];
        for (const row of rows) {
          const references: AccessCreationReference[] = [];
          for (let index = 0; index < selections.length; index++) {
            const selection = selections[index];
            const { reader, grant, primary } = grants[index];
            const raw = row[index];
            const cell = typeof raw === 'string' ? raw.trim() : raw;
            let key: string | null = null;
            assertCurrent();
            if (cell !== null && cell !== '') {
              let value: unknown;
              if (selection.lookup === primary) value = normalizeKeys([cell], selection.target)[0];
              else {
                const parser = selection.scalar.createParser(ctx, selection.column);
                await parser.setValue(cell);
                assertCurrent();
                if (parser.errors.length) invalid(`Import reference value is invalid: ${parser.errors.join('; ')}`);
                value = parser.getValue();
                if (value instanceof Date) value = value.toISOString();
              }
              if (
                !(
                  typeof value === 'string' ||
                  typeof value === 'boolean' ||
                  (typeof value === 'number' && Number.isSafeInteger(value))
                )
              )
                invalid('Import reference value did not resolve to a scalar');
              const matches = await reader.list(ctx, selection.targetIdentity, actor, {
                filter: { [selection.lookup]: { $eq: value } },
                attributes: [primary],
                limit: 2,
                transaction,
              });
              assertCurrent();
              if (!matches.length) unavailable();
              if (matches.length !== 1) invalid('Import reference must match exactly one readable record');
              // The driver may decode BIGINT as an unsafe JS number. A direct PK equality
              // already proves the exact normalized input; other lookups must reject lossy keys.
              key = normalizeKeys([selection.lookup === primary ? value : matches[0][primary]], selection.target)[0];
            }
            references.push({
              association: selection.name,
              target: cloneDeep(selection.targetIdentity),
              key,
              where: cloneDeep(grant.where),
            });
          }
          result.push(references);
        }
        assertCurrent();
        return result;
      },
    };
  }
}
