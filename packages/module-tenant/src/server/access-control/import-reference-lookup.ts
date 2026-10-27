import type { ImportXlsxCell, ImportXlsxColumn } from '@tachybase/plugin-action-import';
import { Op, type Collection, type Database, type Transaction } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { resolveBelongsTo } from './association-metadata';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { MAX_CREATION_REFERENCES, type AccessCreationReference } from './creation';
import type { AccessCreationLink } from './creation-links';
import type { AccessCreationTargetAuthorizer } from './creation-reference';
import { captureAccessFilter } from './filter-input';
import { captureFinalActionPermission } from './final-action-permission';
import { captureScalarImportField } from './import-fields';
import { resolveManyToMany } from './many-to-many-metadata';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { AccessReadGrantAdapter } from './read-grants';
import { AccessReadService } from './reads';
import { AccessRoleFilterCompiler } from './role-filter';
import { captureRelatedReadPermission, type AccessRootReadContext } from './root-read-context';
import { cloneDeep, invalid, MAX_MUTATION_INPUT_NODES, normalizeKeys, plain, unavailable } from './write-support';

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
    const plan = this.capture(ctx, source, authenticated, columns, authorize, false);
    return {
      ...plan,
      resolve: async (input: unknown, transaction?: Transaction) => (await plan.resolve(input, transaction)).references,
    };
  }

  prepareLinks(...args: Parameters<AccessImportReferenceLookup['prepare']>) {
    const plan = this.capture(...args, true);
    return {
      ...plan,
      resolve: async (input: unknown, transaction?: Transaction) => (await plan.resolve(input, transaction)).links,
    };
  }

  private capture(
    ctx: AccessRootReadContext,
    source: AccessCollectionIdentity,
    authenticated: AccessIdentity,
    columns: unknown,
    authorize: AccessCreationTargetAuthorizer,
    multiple: boolean,
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
      const throughModel = (association as typeof association & { through?: { model?: typeof target.model } }).through
        ?.model;
      const through = throughModel && this.db.modelCollection.get(throughModel);
      const throughIdentity = multiple && through ? cloneDeep(this.resolveIdentity(through)) : undefined;
      if (multiple && (!throughIdentity || throughIdentity.collectionName !== through?.name))
        invalid('Import link join identity is unavailable');
      const relation = multiple
        ? resolveManyToMany(this.db, this.prepared, this.queries, ctx, source, targetIdentity, throughIdentity!, name)
        : resolveBelongsTo(this.db, this.prepared, this.queries, ctx, source, targetIdentity, name);
      if (!multiple && blacklist?.includes(relation.foreignKey))
        invalid('Import reference foreign key is not authorized');
      if (!Object.hasOwn(target.model.rawAttributes, lookup)) invalid('Import lookup field is unavailable');
      const lookupType = (target.model.rawAttributes[lookup].type as { key?: string }).key;
      if (!['STRING', 'TEXT', 'BOOLEAN', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT'].includes(lookupType))
        invalid('Import lookup fields require text, boolean or integer values');
      const scalar = captureScalarImportField(this.db, target, lookup);
      const metadata = accessMetadataGuard(
        this.db,
        [
          { model: relation.sourceModel, config: relation.sourceConfig },
          { model: relation.targetModel, config: this.prepared.configuration(ctx, targetIdentity)! },
        ],
        [{ model: relation.sourceModel, path: [name] }],
      );
      const assertCurrent = () => {
        relation.current();
        metadata();
        scalar.assertCurrent();
        const current = this.resolveIdentity(target);
        const currentSource = this.resolveIdentity(collection);
        const currentThrough = multiple && through ? this.resolveIdentity(through) : undefined;
        if (
          !current ||
          current.collectionName !== target.name ||
          accessCollectionKey(current) !== accessCollectionKey(targetIdentity) ||
          !currentSource ||
          accessCollectionKey(currentSource) !== accessCollectionKey(source) ||
          (multiple &&
            (!currentThrough ||
              currentThrough.collectionName !== through!.name ||
              accessCollectionKey(currentThrough) !== accessCollectionKey(throughIdentity!))) ||
          collection.getField(name) !== field ||
          field.target !== target.name ||
          field.options.interface === 'attachment'
        )
          invalid('Import reference identity changed during lookup');
      };
      assertCurrent();
      return { column, name, lookup, target, targetIdentity, throughIdentity, relation, scalar, assertCurrent };
    });
    const checks = selections.map((selection) => selection.assertCurrent);
    const assertCurrent = () => checks.forEach((check) => check());
    const captureTargets = async () => {
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
        }).capturePlan(selection.targetIdentity, decision, new AccessRoleFilterCompiler(this.db, this.resolveIdentity));
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
      return grants;
    };
    let authorization: ReturnType<typeof captureTargets> | undefined;
    const targets = () => (authorization ??= captureTargets());
    let used = false;
    return {
      assertCurrent,
      // Final ACL preparation may read configuration through its own connection.
      // Complete it before reserving the file transaction; business matches remain transactional.
      authorizeTargets: async () => {
        await targets();
        assertCurrent();
      },
      resolve: async (
        input: unknown,
        transaction?: Transaction,
      ): Promise<{ references: AccessCreationReference[][]; links: AccessCreationLink[][] }> => {
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
        // A short cell may expand into many targets. Bound the whole expansion before
        // authorizing/parsing/querying, using the same node budget as mutation inputs.
        let expandedNodes = 1;
        const selectedRows = rows.map((row) => {
          expandedNodes++;
          return row.map((raw) => {
            const cell = typeof raw === 'string' ? raw.trim() : raw;
            const cells = multiple
              ? cell === null || cell === ''
                ? []
                : typeof cell === 'string'
                  ? cell.split(';', 1001).map((part) => part.trim())
                  : [cell]
              : [cell];
            expandedNodes += cells.length + 1;
            if (
              multiple &&
              (expandedNodes > MAX_MUTATION_INPUT_NODES ||
                cells.length > 1000 ||
                cells.some((part) => part === '') ||
                new Set(cells).size !== cells.length)
            )
              invalid('Import link selections exceed the input budget or contain empty or duplicate values');
            return cells;
          });
        });
        assertCurrent();
        const grants = await targets();
        assertCurrent();
        const result: AccessCreationReference[][] = [];
        const linkResult: AccessCreationLink[][] = [];
        for (const row of selectedRows) {
          const references: AccessCreationReference[] = [];
          const links: AccessCreationLink[] = [];
          for (let index = 0; index < selections.length; index++) {
            const selection = selections[index];
            const { reader, grant, primary } = grants[index];
            const cells = row[index];
            const keys: string[] = [];
            for (const cell of cells) {
              let key: string | null = null;
              assertCurrent();
              if (cell !== null && cell !== '') {
                let value: unknown;
                if (selection.lookup === primary) value = normalizeKeys([cell], selection.target)[0];
                else {
                  const parser = selection.scalar.createParser(
                    transaction ? { ...ctx, transaction } : ctx,
                    selection.column,
                  );
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
              if (multiple) {
                if (key === null || keys.includes(key)) invalid('Import link targets must be distinct');
                keys.push(key);
              } else
                references.push({
                  association: selection.name,
                  target: cloneDeep(selection.targetIdentity),
                  key,
                  where: cloneDeep(grant.where),
                });
            }
            if (multiple)
              links.push({
                association: selection.name,
                target: cloneDeep(selection.targetIdentity),
                through: cloneDeep(selection.throughIdentity!),
                keys,
                where: cloneDeep(grant.where),
              });
          }
          result.push(references);
          linkResult.push(links);
        }
        assertCurrent();
        return { references: result, links: linkResult };
      },
    };
  }
}
