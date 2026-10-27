import { isDeepStrictEqual } from 'node:util';
import { captureImportXlsxRequest } from '@tachybase/plugin-action-import';
import type { Collection, Database, Model } from '@tego/server';

import type { AccessAclScopeAdapter } from './acl-scope';
import { accessCollectionKey, type AccessCollectionIdentity } from './config-store';
import type { AccessIdentity } from './context';
import { AccessCreationService } from './creation';
import { captureAccessFilter } from './filter-input';
import { captureFinalActionPermission } from './final-action-permission';
import { captureScalarImportField } from './import-fields';
import { accessMetadataGuard } from './metadata-snapshot';
import type { AccessQueryService } from './query';
import { AccessRoleFilterCompiler } from './role-filter';
import { cloneDeep, invalid, plain, rootWriteBlockedFields, validateRootValues } from './write-support';

interface AccessImportContext {
  db: Database;
  action: object;
  permission: unknown;
  body?: unknown;
}

function data(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return;
  if (!Object.hasOwn(descriptor, 'value')) invalid('Import context cannot contain accessors');
  return descriptor.value;
}

function names(input: unknown): string[] | undefined {
  if (input === undefined) return;
  const result = captureAccessFilter(input);
  if (
    !Array.isArray(result) ||
    result.some((name) => typeof name !== 'string') ||
    new Set(result).size !== result.length
  )
    invalid('Import field grants must contain distinct field names');
  return result as string[];
}

/** Internal scalar-only entry. No routes or default import handlers are installed here. */
export class AccessRootImportHandler {
  constructor(
    private readonly db: Database,
    private readonly prepared: AccessAclScopeAdapter,
    private readonly queries: AccessQueryService,
    private readonly resolveIdentity: (collection: Collection) => AccessCollectionIdentity | undefined,
  ) {}

  /** Upload input comes from the selected executor, never merged action values or role filters. */
  async handle(ctx: AccessImportContext, authenticated: AccessIdentity, upload: unknown): Promise<void> {
    if (ctx.db !== this.db || !ctx.action || typeof ctx.action !== 'object' || !plain(authenticated))
      invalid('Import database or authenticated context is unavailable');
    const resourceName = data(ctx.action, 'resourceName');
    if (
      typeof resourceName !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(resourceName) ||
      ['_', '__proto__', 'constructor', 'prototype'].includes(resourceName) ||
      data(ctx.action, 'actionName') !== 'importXlsx' ||
      data(ctx.action, 'sourceId') !== undefined ||
      data(ctx.action, 'resourceOf') !== undefined
    )
      invalid('Unsupported root import action');
    const actor = Object.freeze(cloneDeep(authenticated));
    if (typeof actor.roleName !== 'string') invalid('Imports require an authenticated role');
    const permission = captureFinalActionPermission(ctx.permission, {
      resourceName,
      actionName: 'importXlsx',
      roleName: actor.roleName,
    });
    if (!permission.allowed) invalid('Import action is not authorized');
    const grants = permission.params;
    if (
      !plain(grants) ||
      Reflect.ownKeys(grants).some(
        (key) => typeof key !== 'string' || !['fields', 'whitelist', 'blacklist', 'filter', 'own'].includes(key),
      )
    )
      invalid('Unsupported finalized import permission');
    if (Object.hasOwn(grants, 'own') && grants.own !== false)
      invalid('Own-record import permissions must be finalized');
    const fields = names(grants.fields);
    const whitelist = names(grants.whitelist);
    const blacklist = names(grants.blacklist);
    const filter = captureAccessFilter(grants.filter === undefined ? {} : grants.filter);
    const collection = this.db.getCollection(resourceName);
    if (!collection || collection.db !== this.db || this.db.modelCollection.get(collection.model) !== collection)
      invalid('Import collection is unavailable');
    const identity = cloneDeep(this.resolveIdentity(collection));
    if (!identity || identity.collectionName !== resourceName) invalid('Import collection identity is unavailable');
    const config = this.prepared.configuration(ctx, identity);
    if (!config) invalid('Import requires a prepared access configuration');
    const model = collection.model;
    const key = accessCollectionKey(identity);
    const role = new AccessRoleFilterCompiler(this.db, this.resolveIdentity).compile(identity, filter);
    const metadata = accessMetadataGuard(this.db, [{ model, config }]);
    const request = captureImportXlsxRequest(upload);
    if (!request.rows.length || request.rows.length > 1000) invalid('Import between 1 and 1000 explicit records');
    // Validate every mapped column before constructing even the first value parser.
    for (const column of request.columns) {
      const [name] = column.dataIndex;
      if (
        column.dataIndex.length !== 1 ||
        (fields !== undefined && !fields.includes(name)) ||
        (whitelist !== undefined && !whitelist.includes(name)) ||
        blacklist?.includes(name) ||
        (config.ownership.enabled && name === 'tenantId')
      )
        invalid('Import mapping contains an unauthorized or unadapted field');
    }
    validateRootValues(this.db, Object.fromEntries(request.fields.map((name) => [name, null])), collection, 'create');
    const selections = request.columns.map((column) => ({
      column,
      ...captureScalarImportField(this.db, collection, column.dataIndex[0]),
    }));
    const protectedFields = [...rootWriteBlockedFields(this.db, collection, 'create')].sort();
    const assertCurrent = () => {
      const current = this.resolveIdentity(collection);
      if (
        !current ||
        current.collectionName !== resourceName ||
        accessCollectionKey(current) !== key ||
        this.prepared.configuration(ctx, identity) !== config ||
        !this.queries.isCurrentCollection(identity, collection, model)
      )
        invalid('Import entry identity or preparation phase changed');
      role.assertCurrent();
      metadata();
      for (const selection of selections) selection.assertCurrent();
    };
    const values: Array<Record<string, unknown>> = [];
    for (const row of request.rows) {
      const record: Record<string, unknown> = {};
      for (let index = 0; index < selections.length; index++) {
        const cell = row.cells[index];
        if (cell === null) continue;
        assertCurrent();
        const { field, column, createParser } = selections[index];
        const parser = createParser(ctx, column);
        await parser.setValue(typeof cell === 'string' ? cell.trim() : cell);
        assertCurrent();
        if (parser.errors.length)
          invalid(`Import row ${row.rowNumber}, ${column.defaultTitle}: ${parser.errors.join('; ')}`);
        const value: unknown = parser.getValue();
        if (value !== undefined) record[field.name] = cloneDeep(value);
      }
      values.push(record);
    }
    // Database-wide protection discovery belongs to write stages, not each parsed cell.
    const assertWriteCurrent = () => {
      assertCurrent();
      if (!isDeepStrictEqual(protectedFields, [...rootWriteBlockedFields(this.db, collection, 'create')].sort()))
        invalid('Import relationship protection metadata changed');
    };
    assertWriteCurrent();
    const result = await new AccessCreationService(this.db, this.prepared, this.queries).withCreatedRecords(
      ctx,
      identity,
      actor,
      { values, where: role.rootWhere ?? role.where },
      async (plan) => {
        const records: Model[] = [];
        for (const value of plan.values) {
          assertWriteCurrent();
          records.push(
            await collection.repository.create({ values: value, transaction: plan.transaction, context: ctx }),
          );
          assertWriteCurrent();
        }
        return records;
      },
      assertWriteCurrent,
    );
    // This path is all-or-nothing: no failure workbook exists on success.
    ctx.body = { rows: [], successCount: result.affected, failureCount: 0 };
  }
}
