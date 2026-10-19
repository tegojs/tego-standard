import { ACL, literal, Op, type Collection, type Database, type HasManyRepository } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessEntryReadService } from '../../access-control/entry-reads';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessEntryReadPermission } from '../../access-control/read-grants';
import { AccessReferenceService } from '../../access-control/references';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { AccessTargetForeignKeyReadService } from '../../access-control/target-foreign-key-reads';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { finalizedReadContext } from './finalized-read-context';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { ...mainIdentity, collectionKey: 'children-key', collectionName: 'children' };
const authenticated = { tenantId: 'B' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('target foreign-key reads (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let children: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let reads: AccessTargetForeignKeyReadService;
  let ctx: object;
  let entry: AccessEntryReadService;
  let permissions: Map<string, AccessEntryReadPermission | null>;
  let permissionResolver: ReturnType<typeof vi.fn>;
  const stableKey = (collection: Collection) =>
    accessCollectionKey({ ...mainIdentity, collectionKey: `${collection.name}-key`, collectionName: collection.name });

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    for (const name of ['documents', 'children']) {
      const collection = db.collection({
        name,
        tableName: `read_${name}`,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
          ...(name === 'children'
            ? [
                { name: 'documentId', type: 'integer', field: 'document_id' },
                { name: 'occurredAt', type: 'date', field: 'occurred_at' },
              ]
            : []),
        ],
      });
      await collection.model.sync();
    }
    docs = db.getCollection('documents');
    children = db.getCollection('children');
    docs.setField('children', { type: 'hasMany', target: 'children', foreignKey: 'documentId' });
    docs.setField('child', { type: 'hasOne', target: 'children', foreignKey: 'documentId' });
    children.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    await docs.repository.create({
      values: [
        { id: 1, tenantId: 'B', name: 'Owned' },
        { id: 2, tenantId: 'H', name: 'Visible' },
        { id: 3, tenantId: 'C', name: 'Hidden' },
        { id: 4, tenantId: null, name: 'Legacy' },
        { id: 5, tenantId: 'B', name: 'Empty' },
      ],
    });
    await children.repository.create({
      values: [
        { id: 101, documentId: 1, tenantId: 'B', name: 'Owned', amount: 10 },
        { id: 102, documentId: 1, tenantId: 'H', name: 'Visible', amount: 20 },
        { id: 103, documentId: 1, tenantId: 'C', name: 'Hidden', amount: 100 },
        { id: 104, documentId: 1, tenantId: null, name: 'Legacy', amount: 30 },
        { id: 105, documentId: 2, tenantId: 'B', name: 'Owned', amount: 40 },
        { id: 106, documentId: 3, tenantId: 'B', name: 'Owned', amount: 50 },
        { id: 107, documentId: 4, tenantId: null, name: 'Legacy', amount: 60 },
      ],
    });
    const tenants = db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'parentId', type: 'string' },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await tenants.model.sync();
    await tenants.repository.create({
      values: [
        { id: 'H', parentId: null, enabled: true },
        { id: 'B', parentId: 'H', enabled: true },
        { id: 'C', parentId: 'H', enabled: true },
      ],
    });
    await db
      .getRepository('collections')
      .create({ values: { key: target.collectionKey, name: target.collectionName } });
    store = new AccessConfigStore(db, (identity) =>
      resolveModelMetadata(db.getCollection(identity.collectionName), { resolveCollectionKey: stableKey }),
    );
    const config = configFor(ownerCondition);
    config.rules.push({
      ...configFor(
        {
          type: 'compare',
          operator: 'in',
          left: { type: 'field', path: 'name' },
          right: { type: 'literal', value: ['Visible', 'Legacy'] },
        },
        'visibility',
      ).rules[0],
      id: 'visible',
    });
    for (const identity of [mainIdentity, target])
      await store.save(identity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    reads = new AccessTargetForeignKeyReadService(db, adapter, queries);
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target]);
    permissions = new Map();
    permissionResolver = vi.fn((_collection: Collection, path: readonly string[], _operation: object) =>
      permissions.has(path.join('.')) ? permissions.get(path.join('.'))! : { allowed: true, params: {} },
    );
    entry = new AccessEntryReadService(
      db,
      adapter,
      queries,
      (collection) => [mainIdentity, target].find((identity) => identity.collectionName === collection.name),
      permissionResolver,
    );
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "read_children", "read_documents", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });

  const plan = (sourceKey: string | number = 1, extra = {}) =>
    reads.scopeTargets(ctx, mainIdentity, target, authenticated, { association: 'children', sourceKey, ...extra });
  async function ids(sourceKey: string | number = 1, extra = {}) {
    const scoped = await plan(sourceKey, extra);
    return (await children.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) =>
      row.getDataValue('id'),
    );
  }

  const page = (sourceKey: unknown = 1, params: unknown = { fields: ['id'], sort: 'id' }, association = 'children') =>
    entry.listAssociationPageFromParams(ctx, mainIdentity, authenticated, { association, sourceKey }, params);
  const loggingOptions = () =>
    (db.sequelize as unknown as { options: { logging: boolean | ((sql: string) => void) } }).options;

  const detail = (
    sourceKey: unknown = 1,
    params: unknown = { fields: ['id'], filterByTk: 101 },
    association = 'children',
  ) => entry.getAssociationFromParams(ctx, mainIdentity, authenticated, { association, sourceKey }, params);

  describe('finalized association handler', () => {
    const identity = () => ({ tenantId: 'B', userId: 28, roleName: 'reader' });
    const finalized = (
      resourceName: string,
      actionName: string,
      params: Record<string, unknown>,
      permission: object,
      sourceId?: string | number,
    ) => finalizedReadContext(db, resourceName, actionName, params, permission, sourceId);
    const source = (permission: object = {}, params: Record<string, unknown> = {}) =>
      finalized('documents', 'list', params, permission);
    const request = (
      kind = 'list',
      params: Record<string, unknown> = { fields: ['id'], sort: 'id' },
      sourceId: string | number = 1,
      permission: object = {},
      relation = 'children',
    ) => finalized(`documents.${relation}`, kind, params, permission, sourceId);
    const handler = (related?: ConstructorParameters<typeof AccessRootReadHandler>[4]) =>
      new AccessRootReadHandler(
        db,
        adapter,
        queries,
        (collection) => [mainIdentity, target].find((value) => value.collectionName === collection.name),
        related,
      );
    const execute = async (
      kind = 'list',
      sourceId: string | number = 1,
      params: Record<string, unknown> = { fields: ['id'], sort: 'id' },
      sourcePermission: object = {},
      targetPermission: object = {},
      relation = 'children',
    ) => {
      const result = Object.assign(ctx, await request(kind, params, sourceId, targetPermission, relation));
      await handler().handleAssociation(result, identity(), await source(sourcePermission));
      return result;
    };

    it('returns only linked readable targets and preserves target pagination', async () => {
      const result = await execute();
      expect(result.body).toEqual({
        rows: [{ id: 101 }, { id: 102 }, { id: 104 }],
        count: 3,
        page: 1,
        pageSize: 20,
        totalPage: 1,
      });
      expect(result.paginate).toBe(true);
    });
    it.each([
      ['get', { fields: ['id'], filterByTk: 102 }, { id: 102 }],
      ['count', {}, 3],
    ] as const)('uses the final target %s decision', async (kind, params, expected) => {
      const result = await execute(kind, 1, params);
      expect(result.body).toEqual(expected);
      expect(result.paginate).toBe(false);
    });
    it.each([2, 4, 5])('applies the source visibility and actual membership for source %s', async (sourceId) => {
      const result = await execute('list', sourceId);
      const ids = sourceId === 2 ? [105] : sourceId === 4 ? [107] : [];
      expect(result.body).toMatchObject({ rows: ids.map((id) => ({ id })), count: ids.length });
    });
    it('rejects a hidden source without exposing the linked readable target', async () => {
      await expect(execute('list', 3)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });
    it('does not borrow target permission for a source outside the source role range', async () => {
      await expect(execute('list', 1, { fields: ['id'] }, { filter: { id: 2 } })).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
    });
    it('intersects the actual target role range and field restrictions', async () => {
      expect(
        (await execute('list', 1, { fields: ['id'] }, {}, { fields: ['id'], filter: { id: 102 } })).body,
      ).toMatchObject({ rows: [{ id: 102 }], count: 1 });
      await expect(execute('list', 1, { fields: ['name'] }, {}, { fields: ['id'] })).rejects.toThrow(/authorized/);
    });
    it.each(['child', 'children'])('supports concrete %s detail without bypassing membership', async (relation) => {
      const result = await execute(
        'get',
        2,
        relation === 'child' ? { fields: ['id'] } : { fields: ['id'], filterByTk: 105 },
        {},
        {},
        relation,
      );
      expect(result.body).toEqual({ id: 105 });
      if (relation === 'children')
        expect((await execute('get', 1, { fields: ['id'], filterByTk: 105 })).body).toBeNull();
    });
    it('resolves nested neutral list permissions relative to the original source', async () => {
      const nested = await source({ fields: ['name'] });
      const result = Object.assign(ctx, await request('get', { fields: ['id', 'document.name'], filterByTk: 101 }));
      const resolve = vi.fn(() => nested);
      await handler(resolve).handleAssociation(result, identity(), await source());
      expect(result.body).toEqual({ id: 101, document: { name: 'Owned' } });
      expect(resolve).toHaveBeenCalledWith(
        docs,
        ['children', 'document'],
        expect.objectContaining({ kind: 'get', source: mainIdentity }),
      );
    });
    it('uses a belongs-to source locator without requiring a target detail key', async () => {
      const sourceContext = await finalized('children', 'list', {}, {});
      const result = Object.assign(
        ctx,
        await finalized('children.document', 'get', { fields: ['name'] }, { fields: ['name'] }, 101),
      );
      await handler().handleAssociation(result, identity(), sourceContext);
      expect(result.body).toEqual({ name: 'Owned' });
    });
    it.each([
      ['placeholder', { sourceId: '_', resourceOf: '_' }, {}, {}],
      ['conflicting source', { resourceOf: 2 }, {}, {}],
      ['conflicting transport source', {}, { associatedIndex: 2 }, {}],
      ['wrong target', {}, {}, { resourceName: 'documents' }],
      ['denied target', {}, {}, { can: false }],
    ] as const)('rejects %s before SQL', async (_name, action, raw, permission) => {
      const result = Object.assign(ctx, await request());
      const sourceContext = await source();
      Object.assign(result.action, action);
      Object.assign((result.permission as { rawParams: object }).rawParams, raw);
      Object.assign(result.permission!, permission);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(handler().handleAssociation(result, identity(), sourceContext)).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
      expect(result.body).toBe('unchanged');
    });
    it.each([{ fields: ['id'] }, { filter: { id: 1 } }])(
      'rejects source context with unavailable relation or nonneutral request %j',
      async (params) => {
        const result = Object.assign(ctx, await request());
        const sourceContext = 'fields' in params ? await source(params) : await source({}, params);
        const sql = vi.spyOn(db.sequelize, 'query');
        await expect(handler().handleAssociation(result, identity(), sourceContext)).rejects.toThrow();
        expect(sql).not.toHaveBeenCalled();
        expect(result.body).toBe('unchanged');
      },
    );

    it('captures source and target decisions and identity before metadata callbacks', async () => {
      const sourceContext = await source();
      const result = Object.assign(ctx, await request('get', { fields: ['id'], filterByTk: 101 }));
      const authenticated = identity();
      const custom = new AccessRootReadHandler(db, adapter, queries, (collection) => {
        authenticated.tenantId = 'C';
        Object.assign(sourceContext.permission!, { can: false });
        Object.assign((result.permission as { rawParams: object }).rawParams, { filterByTk: 103 });
        return [mainIdentity, target].find((value) => value.collectionName === collection.name);
      });
      await custom.handleAssociation(result, authenticated, sourceContext);
      expect(result.body).toEqual({ id: 101 });
    });

    it('rechecks the source relation after execution before publishing a response', async () => {
      const sourceContext = await source();
      const result = Object.assign(ctx, await request());
      vi.spyOn(AccessEntryReadService.prototype, 'fromResource').mockImplementationOnce(async () => {
        docs.model.associations.children = { ...docs.model.associations.children } as never;
        return { rows: [{ id: 101 }] };
      });
      await expect(handler().handleAssociation(result, identity(), sourceContext)).rejects.toThrow(
        /association changed/,
      );
      expect(result.body).toBe('unchanged');
    });

    it('requires an explicit target key for multi-record relation details before SQL', async () => {
      const sourceContext = await source();
      const result = Object.assign(ctx, await request('get', { fields: ['id'] }));
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(handler().handleAssociation(result, identity(), sourceContext)).rejects.toThrow(
        /explicit scalar key/,
      );
      expect(sql).not.toHaveBeenCalled();
    });

    it.each([
      'denied source',
      'wrong source role',
      'wrong source collection',
      'wrong target role',
      'wrong target action',
    ])('rejects %s before SQL', async (mode) => {
      const sourceContext = await source();
      const result = Object.assign(ctx, await request());
      const sourcePermission = sourceContext.permission as { can: object; resourceName: string };
      const permission = result.permission as { can: object; actionName: string };
      if (mode === 'denied source') Object.assign(sourcePermission, { can: false });
      if (mode === 'wrong source role') Object.assign(sourcePermission.can, { role: 'other' });
      if (mode === 'wrong source collection') sourcePermission.resourceName = 'children';
      if (mode === 'wrong target role') Object.assign(permission.can, { role: 'other' });
      if (mode === 'wrong target action') permission.actionName = 'get';
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(handler().handleAssociation(result, identity(), sourceContext)).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
      expect(result.body).toBe('unchanged');
    });
  });

  describe('association scalar aggregate', () => {
    const aggregate = async (
      method: unknown = 'sum',
      extra: Record<string, unknown> = {},
      sourceKey: unknown = 1,
      association = 'children',
    ) =>
      entry.aggregateAssociation(
        ctx,
        mainIdentity,
        authenticated,
        { association, sourceKey },
        { method, field: 'amount', ...extra },
      );

    it.each([
      ['count', 3],
      ['sum', 60],
      ['avg', 20],
      ['min', 10],
      ['max', 30],
    ])('computes %s from linked readable targets', async (method, expected) => {
      expect(await aggregate(method)).toBe(expected);
      expect(permissionResolver.mock.calls.every(([, , operation]) => operation.kind === 'aggregate')).toBe(true);
    });

    it('distinguishes nonnull field counts value distinct and empty results', async () => {
      await children.model.update({ amount: 10 }, { where: { id: 102 } });
      await children.model.update({ amount: null }, { where: { id: 104 } });
      expect(await aggregate('count')).toBe(2);
      expect(await aggregate('count', { distinct: true })).toBe(1);
      expect(await aggregate('sum')).toBe(20);
      expect(await aggregate('sum', { distinct: true })).toBe(10);
      for (const method of ['count', 'sum', 'avg', 'min', 'max'])
        expect(await aggregate(method, {}, 5)).toBe(method === 'count' ? 0 : null);
      await children.model.update({ amount: 11 }, { where: { id: 102 } });
      expect(await aggregate('avg')).toBe(10.5);
    });

    it('intersects target and source role filters without exposing hidden authorization facts', async () => {
      permissions.set('', { allowed: true, params: { fields: [], appends: ['children.amount'] } });
      permissions.set('children', {
        allowed: true,
        params: { fields: ['amount'], filter: { document: { id: 1 }, amount: { $gte: 20 } } },
      });
      expect(await aggregate('sum', { filter: { amount: { $lte: 20 } } })).toBe(20);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(aggregate('sum', { filter: { document: { id: 1 } } })).rejects.toThrow(/authorized/);
      await expect(aggregate('count', { field: 'id' })).rejects.toThrow(/authorized/);
      expect(sql).not.toHaveBeenCalled();
      permissions.set('', { allowed: true, params: { filter: { id: 2 } } });
      await expect(aggregate()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it('rejects denied paths invalid requests and accessors before SQL', async () => {
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const path of ['', 'children']) {
        permissions.set(path, { allowed: false, params: {} });
        await expect(aggregate()).rejects.toThrow();
        permissions.delete(path);
      }
      for (const extra of [
        { method: 'median' },
        { field: 'name' },
        { field: 'document.amount' },
        { distinct: 'true' },
        { group: ['name'] },
        { bind: {} },
        { transaction: {} },
      ])
        await expect(aggregate('sum', extra)).rejects.toThrow();
      const getter = vi.fn(() => 'sum');
      const request = Object.defineProperty({ field: 'amount' }, 'method', { get: getter });
      await expect(
        entry.aggregateAssociation(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'children', sourceKey: 1 },
          request as never,
        ),
      ).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
      await expect(aggregate('sum', {}, '_')).rejects.toThrow();
      await expect(aggregate('sum', {}, 1, 'child')).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
    });

    it('snapshots parameters before permissions and source lookup can change them', async () => {
      const request = { method: 'sum', field: 'amount', filter: { amount: { $gte: 20 } } };
      const descriptor = { association: 'children', sourceKey: 1 };
      permissionResolver.mockImplementation((_collection: Collection, path: readonly string[]) => {
        request.method = 'max';
        request.field = 'id';
        request.filter.amount.$gte = 100;
        return { allowed: true, params: path.length ? { fields: ['amount'] } : {} };
      });
      const pending = entry.aggregateAssociation(ctx, mainIdentity, authenticated, descriptor, request);
      descriptor.sourceKey = 2;
      expect(await pending).toBe(50);
    });

    it('preserves trusted transactions dates and read-only legacy references', async () => {
      expect(await aggregate('sum', {}, 4)).toBe(60);
      expect((await docs.model.findByPk(4))!.getDataValue('tenantId')).toBeNull();
      expect((await children.model.findByPk(107))!.getDataValue('tenantId')).toBeNull();
      const transaction = await db.sequelize.transaction();
      try {
        await children.model.update(
          { documentId: 2, occurredAt: new Date('2026-09-15T16:00:00Z') },
          { where: { id: 101 }, transaction },
        );
        expect(
          await entry.aggregateAssociation(
            ctx,
            mainIdentity,
            authenticated,
            { association: 'children', sourceKey: 2 },
            { method: 'avg', field: 'amount', filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } } },
            transaction,
            { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' },
          ),
        ).toBe(10);
      } finally {
        await transaction.rollback();
      }
      await expect(
        entry.aggregateAssociation(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'children', sourceKey: 1 },
          { method: 'sum', field: 'amount' },
          transaction,
        ),
      ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    });

    it('rechecks relationship metadata after aggregate and rejects hidden sources', async () => {
      for (const key of [3, 999])
        await expect(aggregate('sum', {}, key)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      const original = children.model.aggregate.bind(children.model);
      vi.spyOn(children.model, 'aggregate').mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        Object.assign(docs.model.associations.children, { scope: { name: 'Hidden' } });
        return result;
      });
      await expect(aggregate()).rejects.toThrow(/changed/);
    });
  });

  describe('association summary entry', () => {
    const count = (sourceKey: unknown = 1, params: unknown = {}, association = 'children') =>
      entry.countAssociationFromParams(ctx, mainIdentity, authenticated, { association, sourceKey }, params);
    const sum = (sourceKey: unknown = 1, params: unknown = { field: 'amount' }) =>
      entry.sumAssociationFromParams(ctx, mainIdentity, authenticated, { association: 'children', sourceKey }, params);

    it('counts and sums only linked readable children under independent summary authorization', async () => {
      expect(await count()).toBe(3);
      expect(await sum()).toBe(60);
      expect(await count(2)).toBe(1);
      expect(await sum(2)).toBe(40);
      expect(await count(5)).toBe(0);
      expect(await sum(5)).toBeNull();
      expect(await count(1, { filter: { amount: { $gt: 10 } } })).toBe(2);
      expect(await sum(1, { field: 'amount', filter: { amount: { $gt: 10 } } })).toBe(50);
      expect(new Set(permissionResolver.mock.calls.map(([, , operation]) => operation.kind))).toEqual(
        new Set(['count', 'sum']),
      );
      expect(
        await entry.fromResource(
          ctx,
          authenticated,
          { resourceName: 'documents.children', sourceId: 1, actionName: 'count' },
          {},
        ),
      ).toBe(3);
    });

    it('requires source relationship and target operation grants without borrowing list permissions', async () => {
      permissionResolver.mockImplementation(
        (_collection: Collection, _path: readonly string[], operation: { kind: string }) => ({
          allowed: operation.kind === 'list',
          params: {},
        }),
      );
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(count()).rejects.toThrow(/authorized/);
      await expect(sum()).rejects.toThrow(/authorized/);
      expect(sql).not.toHaveBeenCalled();
      permissionResolver.mockImplementation((_collection: Collection, path: readonly string[]) =>
        permissions.has(path.join('.')) ? permissions.get(path.join('.'))! : { allowed: true, params: {} },
      );
      for (const [path, permission] of [
        ['', null],
        ['', { allowed: true, params: { fields: ['name'], appends: [] } }],
        ['children', { allowed: false, params: {} }],
      ] as const) {
        permissions.clear();
        permissions.set(path, permission);
        await expect(count()).rejects.toThrow(/authorized/);
        await expect(sum()).rejects.toThrow(/authorized/);
      }
      expect(sql).not.toHaveBeenCalled();
    });

    it('intersects source and target role filters and parent field restrictions', async () => {
      permissions.set('', {
        allowed: true,
        params: { fields: [], appends: ['children.amount'], filter: { name: 'Owned' } },
      });
      permissions.set('children', { allowed: true, params: { fields: ['amount'], filter: { amount: { $gte: 20 } } } });
      expect(await count()).toBe(2);
      expect(await sum()).toBe(50);
      await expect(count(2)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      permissions.set('', { allowed: true, params: { fields: [], appends: ['children.name'] } });
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(sum()).rejects.toThrow(/authorized/);
      expect(sql).not.toHaveBeenCalled();
    });

    it('rejects unreadable sources and unsupported summary inputs before SQL', async () => {
      for (const sourceKey of [3, 999]) {
        await expect(count(sourceKey)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
        await expect(sum(sourceKey)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      }
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const params of [
        { page: 1 },
        { fields: ['id'] },
        { bind: {} },
        { transaction: {} },
        { filter: { unknown: 1 } },
      ])
        await expect(count(1, params)).rejects.toThrow();
      for (const params of [
        { field: 'name' },
        { field: 'document.amount' },
        { field: 'missing' },
        { field: 'amount', appends: ['document'] },
      ])
        await expect(sum(1, params)).rejects.toThrow();
      for (const association of ['child', 'missing']) await expect(count(1, {}, association)).rejects.toThrow();
      await expect(count('_')).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
    });

    it('counts legacy references without claiming source or target ownership', async () => {
      expect(await count(4)).toBe(1);
      expect(await sum(4)).toBe(60);
      expect((await docs.model.findByPk(4))!.getDataValue('tenantId')).toBeNull();
      expect((await children.model.findByPk(107))!.getDataValue('tenantId')).toBeNull();
    });

    it('allows operation-only count grants but requires an authorized numeric sum field', async () => {
      permissions.set('children', { allowed: true, params: { fields: [] } });
      expect(await count()).toBe(3);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(sum()).rejects.toThrow(/authorized/);
      expect(sql).not.toHaveBeenCalled();
    });

    it('preserves relation and model default scopes in summaries', async () => {
      docs.setField('visibleChildren', {
        type: 'hasMany',
        target: 'children',
        foreignKey: 'documentId',
        scope: { name: 'Visible' },
      });
      expect(await count(1, {}, 'visibleChildren')).toBe(1);
      expect(
        await entry.sumAssociationFromParams(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'visibleChildren', sourceKey: 1 },
          { field: 'amount' },
        ),
      ).toBe(20);
      children.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
      expect(await count()).toBe(1);
      expect(await sum()).toBe(10);
      docs.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
      await expect(sum()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it('keeps hidden relationship facts internal to role predicates and scopes actual request relationships', async () => {
      permissions.set('children', {
        allowed: true,
        params: { fields: ['amount'], appends: [], filter: { document: { id: 1 } } },
      });
      expect(await count()).toBe(3);
      expect(await sum()).toBe(60);
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(count(1, { filter: { document: { id: 1 } } })).rejects.toThrow(/authorized/);
      expect(sql).not.toHaveBeenCalled();
      permissions.set('children', { allowed: true, params: {} });
      expect(await count(1, { filter: { document: { name: 'Owned' } } })).toBe(3);
      expect(await sum(1, { field: 'amount', filter: { document: { name: 'Hidden' } } })).toBeNull();
    });

    it('uses the same trusted transaction and target dates for count and sum', async () => {
      const transaction = await db.sequelize.transaction();
      try {
        await children.model.update(
          { documentId: 2, occurredAt: new Date('2026-09-15T16:00:00Z') },
          { where: { id: 101 }, transaction },
        );
        const descriptor = { association: 'children', sourceKey: 2 };
        const filter = { occurredAt: { $dateOn: '{{$nDate.today}}' } };
        const dates = { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' };
        const sourceQuery = vi.spyOn(docs.model, 'findOne');
        const targetQuery = vi.spyOn(children.model, 'count');
        expect(
          await entry.countAssociationFromParams(
            ctx,
            mainIdentity,
            authenticated,
            descriptor,
            { filter },
            transaction,
            dates,
          ),
        ).toBe(1);
        expect(
          await entry.sumAssociationFromParams(
            ctx,
            mainIdentity,
            authenticated,
            descriptor,
            { field: 'amount', filter },
            transaction,
            dates,
          ),
        ).toBe(10);
        expect(sourceQuery.mock.calls[0][0]!.transaction).toBe(transaction);
        expect(targetQuery.mock.calls[0][0]!.transaction).toBe(transaction);
      } finally {
        await transaction.rollback();
      }
      expect(await count(2)).toBe(1);
      await expect(
        entry.countAssociationFromParams(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'children', sourceKey: 1 },
          {},
          transaction,
        ),
      ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    });

    it('rejects relation changes after count and phase release after source lookup', async () => {
      const relation = docs.model.associations.children;
      const originalCount = children.model.count.bind(children.model);
      vi.spyOn(children.model, 'count').mockImplementationOnce(async (...args) => {
        const result = await originalCount(...args);
        Object.assign(relation, { scope: { name: 'Hidden' } });
        return result;
      });
      await expect(count()).rejects.toThrow(/changed/);
      Object.assign(relation, { scope: undefined });
      const originalSource = docs.model.findOne.bind(docs.model);
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (...args) => {
        const result = await originalSource(...args);
        adapter.release(ctx);
        return result;
      });
      await expect(sum()).rejects.toThrow();
    });
  });

  describe('belongs-to detail entry', () => {
    const belonging = (sourceKey: unknown = 101, params: unknown = { fields: ['id'] }, association = 'document') =>
      entry.getAssociationFromParams(ctx, target, authenticated, { association, sourceKey }, params);
    const routed = (sourceId: unknown = 101, params: unknown = { fields: ['id'] }, actionName = 'get') =>
      entry.fromResource(ctx, authenticated, { resourceName: 'children.document', sourceId, actionName }, params);

    it('locates the target by its source foreign key and ignores unrelated scalar target keys', async () => {
      for (const filterByTk of [undefined, null, 999, 'unrelated']) {
        expect(await belonging(101, { fields: ['id'], filterByTk })).toEqual({ id: 1 });
        expect(await routed('105', { fields: ['id'], filterByTk })).toEqual({ id: 2 });
      }
      expect(await belonging(102)).toEqual({ id: 1 });
      expect(await belonging(106)).toBeNull();
      expect(await belonging(101, { fields: ['id'], filter: { id: 2 } })).toBeNull();
      expect(
        permissionResolver.mock.calls.every(
          ([, , operation]) => operation.kind === 'get' && operation.source.collectionName === 'children',
        ),
      ).toBe(true);
    });

    it('matches the core single-relation detail protocol', async () => {
      const repository = db.getRepository('children.document', 105) as unknown as Pick<HasManyRepository, 'findOne'>;
      const record = await repository.findOne({ fields: ['id'], filterByTk: 999 });
      expect(await routed(105, { fields: ['id'], filterByTk: 999 })).toEqual({ id: record!.getDataValue('id') });
    });

    it('rejects hidden missing and role-filtered sources independently of a readable target', async () => {
      for (const sourceId of [103, 999])
        await expect(routed(sourceId)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      permissions.set('', { allowed: true, params: { filter: { amount: { $gt: 10 } } } });
      await expect(belonging()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await belonging(102)).toEqual({ id: 1 });
    });

    it('returns null for an empty foreign key or missing target without broadening the query', async () => {
      await children.model.update({ documentId: null }, { where: { id: 101 } });
      expect(await routed()).toBeNull();
      await docs.model.destroy({ where: { id: 2 } });
      expect(await belonging(105)).toBeNull();
    });

    it('keeps foreign keys private and intersects nested field and target role restrictions', async () => {
      permissions.set('', { allowed: true, params: { fields: [], appends: ['document.name'] } });
      permissions.set('document', { allowed: true, params: { fields: ['id', 'name'], filter: { name: 'Visible' } } });
      expect(await belonging(105, { fields: ['name'] })).toEqual({ name: 'Visible' });
      expect(await belonging(101, { fields: ['name'] })).toBeNull();
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const params of [
        { fields: ['id'] },
        { fields: ['name'], filter: { id: 2 } },
        { fields: ['name'], appends: ['children.name'] },
      ])
        await expect(belonging(105, params)).rejects.toThrow(/authorized/);
      expect(sql).not.toHaveBeenCalled();
    });

    it('does not substitute list permissions for get or grant a denied source relationship', async () => {
      for (const [path, permission] of [
        ['', null],
        ['', { allowed: true, params: { fields: ['name'], appends: [] } }],
        ['document', { allowed: false, params: {} }],
      ] as const) {
        permissions.clear();
        permissions.set(path, permission);
        await expect(routed()).rejects.toThrow(/authorized/);
      }
    });

    it('retains original nested permission paths without applying the root constraint to expansions', async () => {
      permissions.set('', {
        allowed: true,
        params: { fields: [], appends: ['document.name', 'document.children.name'] },
      });
      permissions.set('document', { allowed: true, params: { filter: { children: { id: 103 } } } });
      expect(await belonging(101, { fields: ['name'], appends: ['children.name'] })).toEqual({
        name: 'Owned',
        children: [{ name: 'Owned' }, { name: 'Visible' }, { name: 'Legacy' }],
      });
      expect(permissionResolver.mock.calls.some(([, path]) => path.join('.') === 'document.children')).toBe(true);
    });

    it('does not claim legacy source or target records while reading', async () => {
      expect(await routed(107)).toEqual({ id: 4 });
      expect((await children.model.findByPk(107))!.getDataValue('tenantId')).toBeNull();
      expect((await docs.model.findByPk(4))!.getDataValue('tenantId')).toBeNull();
    });

    it('preserves relationship scope and source and target default scopes', async () => {
      children.setField('visibleDocument', {
        type: 'belongsTo',
        target: 'documents',
        foreignKey: 'documentId',
        scope: { name: 'Visible' },
      });
      expect(await belonging(101, { fields: ['id'] }, 'visibleDocument')).toBeNull();
      expect(await belonging(105, { fields: ['id'] }, 'visibleDocument')).toEqual({ id: 2 });
      docs.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
      expect(await belonging(105)).toBeNull();
      children.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
      await expect(belonging()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it('does not use root business keys to locate either end of the relation', async () => {
      children.options.filterTargetKey = 'name';
      docs.options.filterTargetKey = 'name';
      expect(await routed(105)).toEqual({ id: 2 });
    });

    it('reads shared targets without a tenant column', async () => {
      await store.save(
        mainIdentity,
        {
          ...configFor({ type: 'constant', value: true }),
          ownership: { enabled: false },
          revision: 1,
        },
        { userId: 28 },
      );
      adapter.release(ctx);
      docs.removeField('tenantId');
      await db.sequelize.getQueryInterface().removeColumn(docs.model.getTableName(), 'tenant_id');
      await adapter.prepare(ctx, [mainIdentity, target]);
      expect(await routed(106)).toEqual({ id: 3 });
      await expect(routed(103)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it('captures source descriptor params and nested grants before querying the source', async () => {
      const descriptor = { association: 'document', sourceKey: 101 };
      const params = { fields: ['name'], appends: ['children.name'] };
      const names = ['document.name', 'document.children.name'];
      permissions.set('', { allowed: true, params: { fields: [], appends: names } });
      const original = children.model.findOne.bind(children.model);
      vi.spyOn(children.model, 'findOne').mockImplementationOnce(async (options) => {
        descriptor.sourceKey = 105;
        params.fields[0] = 'id';
        params.appends[0] = 'children.id';
        names.splice(0, names.length, 'document.id');
        permissions.set('document.children', null);
        return original(options);
      });
      expect(await entry.getAssociationFromParams(ctx, target, authenticated, descriptor, params)).toEqual({
        name: 'Owned',
        children: [{ name: 'Owned' }, { name: 'Visible' }, { name: 'Legacy' }],
      });
    });

    it('rejects relationship changes after source lookup', async () => {
      const original = children.model.findOne.bind(children.model);
      vi.spyOn(children.model, 'findOne').mockImplementationOnce(async (options) => {
        const record = await original(options);
        Object.assign(children.model.associations.document, { foreignKey: 'amount' });
        return record;
      });
      await expect(routed()).rejects.toThrow(/changed/);
    });

    it('rejects target phase changes after the selected query', async () => {
      const original = docs.model.findAll.bind(docs.model);
      vi.spyOn(docs.model, 'findAll').mockImplementationOnce(async (options) => {
        const records = await original(options);
        adapter.release(ctx);
        await adapter.prepare(ctx, [mainIdentity, target]);
        return records;
      });
      await expect(routed()).rejects.toThrow(/changed/);
    });

    it('uses the trusted transaction and performs bounded detail reads without count', async () => {
      const count = vi.spyOn(docs.model, 'count');
      const sourceQuery = vi.spyOn(children.model, 'findOne');
      const targetQuery = vi.spyOn(docs.model, 'findAll');
      await db.sequelize.transaction(async (transaction) => {
        await children.model.update({ documentId: 2 }, { where: { id: 101 }, transaction });
        expect(
          await entry.fromResource(
            ctx,
            authenticated,
            {
              resourceName: 'children.document',
              sourceId: 101,
              actionName: 'get',
            },
            { fields: ['name'] },
            transaction,
          ),
        ).toEqual({ name: 'Visible' });
        expect(sourceQuery.mock.calls[0][0]!.transaction).toBe(transaction);
        expect(targetQuery.mock.calls[0][0]).toMatchObject({ transaction, limit: 1 });
      });
      expect(count).not.toHaveBeenCalled();
      expect(sourceQuery).toHaveBeenCalledTimes(1);
      expect(targetQuery).toHaveBeenCalledTimes(1);
    });

    it('resolves trusted date shortcuts using the associated target date field', async () => {
      docs.setField('selectedChild', { type: 'belongsTo', target: 'children', foreignKey: 'amount' });
      await docs.model.update({ amount: 105 }, { where: { id: 1 } });
      await children.model.update({ occurredAt: new Date('2026-09-15T16:00:00Z') }, { where: { id: 105 } });
      const action = { resourceName: 'documents.selectedChild', sourceId: 1, actionName: 'get' };
      const params = { fields: ['name'], filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } } };
      expect(
        await entry.fromResource(ctx, authenticated, action, params, undefined, {
          now: '2026-09-16T00:00:00.000Z',
          timezone: '+08:00',
        }),
      ).toEqual({ name: 'Owned' });
      expect(
        await entry.fromResource(ctx, authenticated, action, params, undefined, {
          now: '2026-09-17T00:00:00.000Z',
          timezone: '+08:00',
        }),
      ).toBeNull();
    });

    it('rejects non-primary source locators and changes to the field locator during lookup', async () => {
      const field = children.getField('document');
      field.options.sourceKey = 'amount';
      const sql = vi.spyOn(db.sequelize, 'query');
      await expect(routed()).rejects.toThrow(/primary source key/);
      expect(sql).not.toHaveBeenCalled();
      delete field.options.sourceKey;
      const original = children.model.findOne.bind(children.model);
      vi.spyOn(children.model, 'findOne').mockImplementationOnce(async (options) => {
        const record = await original(options);
        field.options.sourceKey = 'amount';
        return record;
      });
      await expect(routed()).rejects.toThrow(/changed/);
    });

    it('captures lower read inputs synchronously and preserves named predicates', async () => {
      const reads = new AccessReferenceService(db, adapter, queries);
      const request = {
        association: 'document',
        sourceKey: 105,
        sourceWhere: literal('"children"."amount" > $min'),
        sourceBind: { min: 30 },
        targetWhere: literal('"documents"."name" = $name'),
        targetBind: { name: 'Visible' },
      };
      const plan = reads.prepareBelongsToTarget(ctx, target, mainIdentity, authenticated, request);
      request.sourceKey = 101;
      request.sourceBind.min = 100;
      request.targetBind.name = 'Hidden';
      const constraint = await plan.resolve();
      const scoped = await queries.scopeQuery(ctx, plan.target, plan.authenticated, {
        where: constraint.where,
        bind: plan.bind,
        transaction: plan.transaction,
      });
      expect((await docs.model.findAll(scoped!.query)).map((row) => row.getDataValue('id'))).toEqual([2]);
      constraint.assertCurrent();
    });

    it('rejects lower read input accessors and injected capabilities without invoking them', () => {
      const reads = new AccessReferenceService(db, adapter, queries);
      const getter = vi.fn(() => 101);
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const request of [
        { association: 'document', sourceKey: 101, include: [] },
        Object.defineProperty({ association: 'document' }, 'sourceKey', { get: getter }),
      ])
        expect(() =>
          reads.prepareBelongsToTarget(ctx, target, mainIdentity, authenticated, request as never),
        ).toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(sql).not.toHaveBeenCalled();
    });

    it('rejects malformed keys params and unsupported list before SQL', async () => {
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const sourceId of [null, '', {}, [], 1.5]) await expect(routed(sourceId)).rejects.toThrow();
      for (const filterByTk of [[], {}, true, ''])
        await expect(routed(101, { fields: ['id'], filterByTk })).rejects.toThrow();
      await expect(routed(101, { fields: ['id'], where: {} })).rejects.toThrow();
      await expect(routed(101, {}, 'list')).rejects.toThrow();
      await expect(
        entry.listAssociationPageFromParams(
          ctx,
          target,
          authenticated,
          {
            association: 'document',
            sourceKey: 101,
          },
          {},
        ),
      ).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
    });
  });

  describe('concrete resource routing', () => {
    const route = (
      actionName: string = 'get',
      sourceId: unknown = 1,
      params: unknown = { fields: ['id'], filterByTk: 101 },
      association = 'children',
    ) =>
      entry.fromResource(
        ctx,
        authenticated,
        { resourceName: `documents.${association}`, sourceId, actionName },
        params,
      );

    it('routes the concrete HasMany list through its original source and relationship', async () => {
      expect(
        await entry.fromResource(
          ctx,
          authenticated,
          {
            resourceName: 'documents.children',
            sourceId: 1,
            actionName: 'list',
          },
          { fields: ['id'], sort: 'id' },
        ),
      ).toMatchObject({
        rows: [{ id: 101 }, { id: 102 }, { id: 104 }],
        count: 3,
      });
    });

    it('routes HasMany detail and HasOne relation-located detail under get permissions', async () => {
      expect(await route()).toEqual({ id: 101 });
      expect(await route('get', '1', { fields: ['id'], filterByTk: 102 })).toEqual({ id: 102 });
      expect(await route('get', 2, { fields: ['id'], filterByTk: 999 }, 'child')).toEqual({ id: 105 });
      expect(
        permissionResolver.mock.calls.every(
          ([, , operation]) => operation.kind === 'get' && operation.source.collectionName === 'documents',
        ),
      ).toBe(true);
    });

    it('does not broaden hidden missing or unrelated sources to direct target reads', async () => {
      for (const sourceId of [3, 999]) {
        await expect(route('get', sourceId, { fields: ['id'], filterByTk: 106 })).rejects.toMatchObject({
          code: 'ACCESS_RECORD_UNAVAILABLE',
        });
        await expect(route('list', sourceId, { fields: ['id'] })).rejects.toMatchObject({
          code: 'ACCESS_RECORD_UNAVAILABLE',
        });
      }
      expect(await route('get', 2)).toBeNull();
      expect(await route('get', 1, { fields: ['id'], filterByTk: 103 })).toBeNull();
      expect(await route('list', 5, { fields: ['id'] })).toMatchObject({ rows: [], count: 0 });
    });

    it('preserves source and target ACL and the ancestor nested field boundary', async () => {
      permissions.set('', {
        allowed: true,
        params: { fields: [], appends: ['children.name', 'children.document.name'] },
      });
      permissions.set('children', { allowed: true, params: { filter: { amount: { $gt: 10 } } } });
      expect(await route('get', 1, { fields: ['name'], filterByTk: 102, appends: ['document.name'] })).toEqual({
        name: 'Visible',
        document: { name: 'Owned' },
      });
      expect(await route('get', 1, { fields: ['name'], filterByTk: 101 })).toBeNull();
      await expect(route('get', 1, { fields: ['amount'], filterByTk: 102 })).rejects.toThrow(/authorized/);
      permissions.set('children', null);
      await expect(route('get', 1, { fields: ['name'], filterByTk: 102 })).rejects.toThrow(/authorized/);
      permissions.clear();
      permissions.set('', { allowed: true, params: { filter: { name: 'Visible' } } });
      await expect(route()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it('keeps placeholder behavior target-only even when the corresponding concrete source is hidden', async () => {
      expect(await route('get', '_', { fields: ['id'], filterByTk: 106 })).toEqual({ id: 106 });
      expect(permissionResolver.mock.calls.every(([, path]) => path.length === 0)).toBe(true);
      await expect(route('get', 3, { fields: ['id'], filterByTk: 106 })).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
      adapter.release(ctx);
      await adapter.prepare(ctx, [target]);
      expect(await route('get', '_', { fields: ['id'], filterByTk: 106 })).toEqual({ id: 106 });
    });

    it('uses target root detail keys for placeholders and relation keys for concrete sources', async () => {
      docs.options.filterTargetKey = 'name';
      children.options.filterTargetKey = 'amount';
      expect(await route('get', '_', { fields: ['id'], filterByTk: 50 })).toEqual({ id: 106 });
      expect(await route('get', 1, { fields: ['id'], filterByTk: 102 })).toEqual({ id: 102 });
      expect(await route('get', 2, { fields: ['id'] }, 'child')).toEqual({ id: 105 });
    });

    it('reads legacy sources and targets without claiming either', async () => {
      expect(await route('get', 4, { fields: ['id'], filterByTk: 107 })).toEqual({ id: 107 });
      expect((await docs.model.findByPk(4))!.getDataValue('tenantId')).toBeNull();
      expect((await children.model.findByPk(107))!.getDataValue('tenantId')).toBeNull();
    });

    it('captures concrete route params and authorization paths before querying the source', async () => {
      const action = { resourceName: 'documents.children', sourceId: 1 as string | number, actionName: 'get' };
      const params = { fields: ['name'], filterByTk: 102, appends: ['document.name'] };
      const original = docs.model.findOne.bind(docs.model);
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        action.sourceId = '_';
        action.resourceName = 'children';
        action.actionName = 'list';
        params.filterByTk = 106;
        params.fields[0] = 'id';
        params.appends[0] = 'document.id';
        permissions.set('children.document', null);
        return original(options);
      });
      expect(await entry.fromResource(ctx, authenticated, action, params)).toEqual({
        name: 'Visible',
        document: { name: 'Owned' },
      });
    });

    it('rechecks stable source and target identities before returning data', async () => {
      for (const changed of [mainIdentity, target]) {
        const sourceIdentity = { ...mainIdentity };
        const targetIdentity = { ...target };
        const reader = new AccessEntryReadService(
          db,
          adapter,
          queries,
          (collection) => (collection === docs ? sourceIdentity : collection === children ? targetIdentity : undefined),
          permissionResolver,
        );
        const original = docs.model.findOne.bind(docs.model);
        const spy = vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
          const record = await original(options);
          (changed === mainIdentity ? sourceIdentity : targetIdentity).collectionKey = 'recreated';
          return record;
        });
        await expect(
          reader.fromResource(
            ctx,
            authenticated,
            {
              resourceName: 'documents.children',
              sourceId: 1,
              actionName: 'get',
            },
            { fields: ['id'], filterByTk: 101 },
          ),
        ).rejects.toThrow(/identity changed/);
        spy.mockRestore();
      }
    });

    it('carries server-supplied transactions and trusted dates through dispatch', async () => {
      const transaction = await db.sequelize.transaction();
      try {
        await children.model.update(
          { documentId: 2, occurredAt: '2026-10-16T03:00:00.000Z' },
          { where: { id: 101 }, transaction },
        );
        expect(
          await entry.fromResource(
            ctx,
            authenticated,
            {
              resourceName: 'documents.children',
              sourceId: 2,
              actionName: 'get',
            },
            { fields: ['id'], filterByTk: 101, filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } } },
            transaction,
            { now: '2026-10-16T03:00:00.000Z', timezone: '+08:00' },
          ),
        ).toEqual({ id: 101 });
      } finally {
        await transaction.rollback();
      }
      expect(await route('get', 2)).toBeNull();
    });

    it('does not add SQL queries to the existing list and detail adapters', async () => {
      const sql = vi.spyOn(db.sequelize, 'query');
      await page();
      const listCount = sql.mock.calls.length;
      sql.mockClear();
      await route('list', 1, { fields: ['id'], sort: 'id' });
      expect(sql.mock.calls.length).toBe(listCount);
      sql.mockClear();
      await detail();
      const detailCount = sql.mock.calls.length;
      sql.mockClear();
      await route();
      expect(sql.mock.calls.length).toBe(detailCount);
      expect(detailCount).toBeGreaterThan(0);
    });

    it('rejects unsupported concrete relation kinds actions keys and forged capabilities before SQL', async () => {
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const [actionName, sourceId, association] of [
        ['list', null, 'children'],
        ['get', {}, 'children'],
        ['count', 1, 'child'],
        ['count', '_', 'children'],
        ['sum', 1, 'children'],
        ['list', 1, 'child'],
        ['get', 1, 'document'],
      ] as const)
        await expect(route(actionName, sourceId, {}, association)).rejects.toThrow();
      await expect(
        entry.fromResource(
          ctx,
          authenticated,
          {
            resourceName: 'documents.children',
            sourceId: 1,
            actionName: 'get',
            permission: {},
          },
          {},
        ),
      ).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
    });
  });

  describe('association detail entry', () => {
    it('reads only the requested related target through its own ACL and G/V', async () => {
      expect(await detail()).toEqual({ id: 101 });
      expect(await detail(1, { fields: ['id'], filterByTk: 102 })).toEqual({ id: 102 });
      for (const key of [103, 105, 999]) expect(await detail(1, { fields: ['id'], filterByTk: key })).toBeNull();
    });

    it('locates HasOne by the source relation and ignores a scalar or null target key', async () => {
      const params = { fields: ['id'], filter: { name: 'Visible' } };
      for (const filterByTk of [undefined, null, 999, 'unrelated'])
        expect(await detail(1, { ...params, filterByTk }, 'child')).toEqual({ id: 102 });
      expect(await detail(5, { fields: ['id'] }, 'child')).toBeNull();
      expect(await detail(1, { ...params, filter: { id: 103 } }, 'child')).toBeNull();
    });

    it('matches the core primary-key HasMany and relation-located HasOne detail protocol', async () => {
      const many = await db
        .getRepository<HasManyRepository>('documents.children', 1)
        .findOne({ filterByTk: 102, fields: ['id'] });
      // The server facade omits the HasOne class type; assert only its shared read protocol.
      const single = db.getRepository('documents.child', 2) as unknown as Pick<HasManyRepository, 'findOne'>;
      const one = await single.findOne({ filterByTk: 999, fields: ['id'] });
      expect(await detail(1, { fields: ['id'], filterByTk: 102 })).toEqual(many!.toJSON());
      expect(await detail(2, { fields: ['id'], filterByTk: 999 }, 'child')).toEqual(one!.toJSON());
    });

    it('rejects a hidden or missing source even when its requested target is readable', async () => {
      for (const sourceKey of [3, 999]) {
        await expect(detail(sourceKey, { fields: ['id'], filterByTk: 106 })).rejects.toMatchObject({
          code: 'ACCESS_RECORD_UNAVAILABLE',
        });
        await expect(detail(sourceKey, { fields: ['id'] }, 'child')).rejects.toMatchObject({
          code: 'ACCESS_RECORD_UNAVAILABLE',
        });
      }
    });

    it('reads visible and historical sources and targets without claiming them', async () => {
      expect(await detail(2, { fields: ['id'], filterByTk: 105 })).toEqual({ id: 105 });
      expect(await detail(4, { fields: ['id'], filterByTk: 107 })).toEqual({ id: 107 });
      expect(await detail(4, { fields: ['id'] }, 'child')).toEqual({ id: 107 });
      expect((await docs.model.findByPk(4))!.getDataValue('tenantId')).toBeNull();
      expect((await children.model.findByPk(107))!.getDataValue('tenantId')).toBeNull();
    });

    it('uses get permissions at the original source and target paths with nested field restrictions', async () => {
      permissions.set('', { allowed: true, params: { fields: [], appends: ['children.name'] } });
      permissions.set('children', {
        allowed: true,
        params: { fields: ['id', 'name'], filter: { document: { id: 1 }, amount: { $gt: 10 } } },
      });
      expect(await detail(1, { fields: ['name'], filterByTk: 102 })).toEqual({ name: 'Visible' });
      expect(await detail(1, { fields: ['name'], filterByTk: 101 })).toBeNull();
      expect(
        permissionResolver.mock.calls.every(
          ([, , operation]) =>
            operation.kind === 'get' && operation.source.collectionName === mainIdentity.collectionName,
        ),
      ).toBe(true);
      for (const params of [
        { fields: ['id'], filterByTk: 102 },
        { fields: ['name'], filterByTk: 102, filter: { amount: 20 } },
      ])
        await expect(detail(1, params)).rejects.toThrow(/authorized/);
    });

    it('does not grant a denied source association or target get action', async () => {
      for (const [path, permission] of [
        ['', null],
        ['', { allowed: true, params: { fields: ['name'], appends: [] } }],
        ['children', { allowed: false, params: {} }],
      ] as const) {
        permissions.clear();
        permissions.set(path, permission);
        await expect(detail()).rejects.toThrow(/authorized/);
      }
      permissions.clear();
      permissions.set('', { allowed: true, params: { filter: { name: 'Visible' } } });
      await expect(detail()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it('keeps relation locators independent of source and target root detail keys', async () => {
      docs.options.filterTargetKey = 'name';
      children.options.filterTargetKey = 'name';
      expect(await detail('1', { fields: ['name'], filterByTk: '102' })).toEqual({ name: 'Visible' });
      expect(await detail(2, { fields: ['id'] }, 'child')).toEqual({ id: 105 });
      await expect(detail('Owned')).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      await expect(detail(1, { filterByTk: 'Visible' })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });

    it('refuses non-primary relationship keys instead of reading an unrelated target', async () => {
      docs.getField('children').options.targetKey = 'name';
      await expect(detail(1, { fields: ['id'], filterByTk: 'Visible' })).rejects.toThrow(/primary target key/);
      delete docs.getField('children').options.targetKey;
      const relation = docs.model.associations.children;
      Object.assign(relation, { sourceKey: 'name' });
      await expect(detail()).rejects.toThrow();
    });

    it('preserves relation scopes and model default scopes', async () => {
      docs.setField('visibleChild', {
        type: 'hasOne',
        target: 'children',
        foreignKey: 'documentId',
        scope: { name: 'Visible' },
      });
      expect(await detail(1, { fields: ['id'] }, 'visibleChild')).toEqual({ id: 102 });
      children.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
      expect(await detail(1, { fields: ['id'] }, 'visibleChild')).toBeNull();
      docs.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
      await expect(detail()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it('reads shared targets without imposing the source tenant column', async () => {
      await store.save(
        target,
        {
          ...configFor({ type: 'constant', value: true }),
          ownership: { enabled: false },
          revision: 1,
        },
        { userId: 28 },
      );
      adapter.release(ctx);
      children.removeField('tenantId');
      await db.sequelize.getQueryInterface().removeColumn(children.model.getTableName(), 'tenant_id');
      await adapter.prepare(ctx, [mainIdentity, target]);
      expect(await detail(1, { fields: ['id'], filterByTk: 103 })).toEqual({ id: 103 });
      await expect(detail(3, { fields: ['id'], filterByTk: 106 })).rejects.toMatchObject({
        code: 'ACCESS_RECORD_UNAVAILABLE',
      });
    });

    it.each([{}, { filterByTk: undefined }, { filterByTk: null }, { filterByTk: [] }, { filterByTk: {} }])(
      'requires a bounded explicit target locator for HasMany %j',
      async (params) => {
        await expect(detail(1, params)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      },
    );

    it('rejects forged capabilities and accessor descriptors without invoking getters', async () => {
      const getter = vi.fn(() => 1);
      for (const descriptor of [
        { association: 'children', sourceKey: '_' },
        { association: 'children', sourceKey: 1, targetKey: 102 },
        Object.defineProperty({ association: 'children' }, 'sourceKey', { get: getter }),
      ])
        await expect(
          entry.getAssociationFromParams(ctx, mainIdentity, authenticated, descriptor, {
            fields: ['id'],
            filterByTk: 101,
          }),
        ).rejects.toThrow();
      for (const params of [
        { fields: ['id'], filterByTk: 101, sort: 'name' },
        { fields: ['id'], filterByTk: 101, rootConstraint: {} },
        { fields: ['id'], filterByTk: 101, transaction: {} },
        Object.defineProperty({}, 'filterByTk', { get: getter }),
      ])
        await expect(detail(1, params)).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
      await expect(detail(1, { fields: ['id'] }, 'document')).rejects.toThrow();
    });
  });

  describe('association detail lifecycle', () => {
    it('captures request identity fields filters and expansion permissions before source lookup', async () => {
      const descriptor = { association: 'children', sourceKey: 1 };
      const params = { fields: ['name'], appends: ['document.name'], filterByTk: 102, filter: { amount: { $gt: 10 } } };
      const names = ['children.name', 'children.amount', 'children.document.name'];
      permissions.set('', { allowed: true, params: { fields: [], appends: names } });
      const original = docs.model.findOne.bind(docs.model);
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        descriptor.sourceKey = 2;
        params.filterByTk = 105;
        params.fields[0] = 'id';
        params.appends[0] = 'document.id';
        params.filter.amount.$gt = 100;
        names.splice(0, names.length, 'children.id');
        permissions.set('children.document', null);
        return original(options);
      });
      expect(await entry.getAssociationFromParams(ctx, mainIdentity, authenticated, descriptor, params)).toEqual({
        name: 'Visible',
        document: { name: 'Owned' },
      });
      expect(permissionResolver.mock.calls.some(([, path]) => path.join('.') === 'children.document')).toBe(true);
    });

    it('checks metadata after source and target queries and before returning a detail', async () => {
      const original = docs.model.findOne.bind(docs.model);
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        const row = await original(options);
        docs.getField('children').options.targetKey = 'name';
        return row;
      });
      await expect(detail()).rejects.toThrow(/changed/);
      delete docs.getField('children').options.targetKey;
      const targets = children.model.findAll.bind(children.model);
      vi.spyOn(children.model, 'findAll').mockImplementationOnce(async (options) => {
        const rows = await targets(options);
        Object.assign(docs.model.associations.children, { scope: { name: 'Hidden' } });
        return rows;
      });
      await expect(detail()).rejects.toThrow(/changed/);
    });

    it('fails closed when the prepared phase is released while the source is queried', async () => {
      const original = docs.model.findOne.bind(docs.model);
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        const row = await original(options);
        adapter.release(ctx);
        return row;
      });
      await expect(detail()).rejects.toThrow();
    });

    it('carries the live transaction across source target and expanded queries', async () => {
      const transaction = await db.sequelize.transaction();
      try {
        await children.model.update({ documentId: 2 }, { where: { id: 101 }, transaction });
        await docs.model.update({ name: 'In transaction', tenantId: 'B' }, { where: { id: 2 }, transaction });
        expect(
          await entry.getAssociationFromParams(
            ctx,
            mainIdentity,
            authenticated,
            { association: 'children', sourceKey: 2 },
            { fields: ['id'], filterByTk: 101, appends: ['document.name'] },
            transaction,
          ),
        ).toEqual({ id: 101, document: { name: 'In transaction' } });
      } finally {
        await transaction.rollback();
      }
      expect(await detail(2, { fields: ['id'], filterByTk: 101 })).toBeNull();
      await expect(
        entry.getAssociationFromParams(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'children', sourceKey: 1 },
          { fields: ['id'], filterByTk: 101 },
          transaction,
        ),
      ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    });

    it('resolves trusted date filters and avoids an unnecessary count query', async () => {
      await children.model.update({ occurredAt: '2026-10-16T03:00:00.000Z' }, { where: { id: 101 } });
      const count = vi.spyOn(children.model, 'count');
      expect(
        await entry.getAssociationFromParams(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'children', sourceKey: 1 },
          { fields: ['id'], filterByTk: 101, filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } } },
          undefined,
          { now: '2026-10-16T03:00:00.000Z', timezone: '+08:00' },
        ),
      ).toEqual({ id: 101 });
      expect(count).not.toHaveBeenCalled();
    });
  });

  describe('association page entry', () => {
    it('paginates only related readable targets and counts the same roots', async () => {
      expect(await page(1, { fields: ['id'], sort: '-amount', pageSize: 1 })).toEqual({
        rows: [{ id: 104 }],
        count: 3,
        page: 1,
        pageSize: 1,
        totalPage: 3,
      });
      expect(await page(1, { fields: ['id'], sort: '-amount', pageSize: 1, page: 2 })).toMatchObject({
        rows: [{ id: 102 }],
        count: 3,
        page: 2,
      });
      expect(await page(1, { fields: ['id'], filter: { amount: { $gt: 10 } }, sort: 'id' })).toMatchObject({
        rows: [{ id: 102 }, { id: 104 }],
        count: 2,
      });
    });

    it('rejects an unavailable source and preserves genuinely empty lists', async () => {
      for (const key of [3, 999]) await expect(page(key)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      expect(await page(5)).toMatchObject({ rows: [], count: 0, totalPage: 0 });
    });

    it('reads V and historical sources without claiming source or target', async () => {
      expect(await page(2)).toMatchObject({ rows: [{ id: 105 }], count: 1 });
      expect(await page(4)).toMatchObject({ rows: [{ id: 107 }], count: 1 });
      expect((await docs.model.findByPk(4))?.getDataValue('tenantId')).toBeNull();
      expect((await children.model.findByPk(107))?.getDataValue('tenantId')).toBeNull();
    });

    it('locates the source by its relationship key even when root details use a business key', async () => {
      docs.options.filterTargetKey = 'name';
      expect(await page('1')).toMatchObject({ rows: [{ id: 101 }, { id: 102 }, { id: 104 }], count: 3 });
      await expect(page('Owned')).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });

    it('keeps shared targets without a tenant column independent of source tenancy', async () => {
      await store.save(
        target,
        { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
        { userId: 28 },
      );
      adapter.release(ctx);
      children.removeField('tenantId');
      await db.sequelize.getQueryInterface().removeColumn(children.model.getTableName(), 'tenant_id');
      await adapter.prepare(ctx, [mainIdentity, target]);
      expect(await page()).toMatchObject({ rows: [{ id: 101 }, { id: 102 }, { id: 103 }, { id: 104 }], count: 4 });
      await expect(page(3)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it('intersects final source and target permissions using the original operation path', async () => {
      permissions.set('', { allowed: true, params: { filter: { name: 'Visible' } } });
      await expect(page(1)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      permissions.set('', { allowed: true, params: {} });
      permissions.set('children', { allowed: true, params: { fields: ['name'], filter: { amount: { $gt: 10 } } } });
      expect(await page(1, { fields: ['name'], sort: 'name' })).toMatchObject({
        rows: [{ name: 'Legacy' }, { name: 'Visible' }],
        count: 2,
      });
      const operation = permissionResolver.mock.calls[0][2];
      expect(operation).toMatchObject({ kind: 'list', source: mainIdentity, authenticated });
      expect(operation.context).toBe(ctx);
      expect(permissionResolver.mock.calls.some(([, path]) => path.join('.') === 'children')).toBe(true);
    });

    it('preserves parent nested field restrictions for projection filtering and sorting', async () => {
      permissions.set('', { allowed: true, params: { fields: [], appends: ['children.name'] } });
      expect(await page(1, { fields: ['name'], sort: 'name' })).toMatchObject({
        rows: [{ name: 'Legacy' }, { name: 'Owned' }, { name: 'Visible' }],
        count: 3,
      });
      for (const params of [
        { fields: ['amount'] },
        { fields: ['name'], filter: { amount: 10 } },
        { fields: ['name'], sort: 'amount' },
      ])
        await expect(page(1, params)).rejects.toThrow(/authorized/);
    });

    it('does not grant a denied source association or target operation', async () => {
      for (const [path, permission] of [
        ['', null],
        ['', { allowed: true, params: { fields: ['name'], appends: [] } }],
        ['children', { allowed: false, params: {} }],
      ] as const) {
        permissions.clear();
        permissions.set(path, permission);
        await expect(page()).rejects.toThrow(/authorized/);
      }
    });

    it('expands related targets with independent paths and without exposing pairing keys', async () => {
      expect(await page(1, { fields: ['name'], appends: ['document.name'], sort: 'amount' })).toMatchObject({
        rows: [
          { name: 'Owned', document: { name: 'Owned' } },
          { name: 'Visible', document: { name: 'Owned' } },
          { name: 'Legacy', document: { name: 'Owned' } },
        ],
        count: 3,
      });
      expect(permissionResolver.mock.calls.some(([, path]) => path.join('.') === 'children.document')).toBe(true);
    });

    it('keeps source restrictions on the root list rather than internal role relationship facts', async () => {
      permissions.set('children', {
        allowed: true,
        params: { fields: ['name'], filter: { document: { id: 1 } } },
      });
      expect(await page(1, { fields: ['name'], sort: 'name' })).toMatchObject({ count: 3 });
    });

    it('preserves relation scope and source and target default scopes', async () => {
      docs.setField('visibleChildren', {
        type: 'hasMany',
        target: 'children',
        foreignKey: 'documentId',
        scope: { name: 'Visible' },
      });
      expect(await page(1, { fields: ['id'] }, 'visibleChildren')).toMatchObject({ rows: [{ id: 102 }], count: 1 });
      children.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
      expect(await page()).toMatchObject({ rows: [{ id: 101 }], count: 1 });
      docs.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
      await expect(page()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it.each(['_', null, 1.5, {}, [], ''])('rejects unsupported source key %j', async (key) => {
      await expect(page(key)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    });

    it('rejects non-HasMany and forged request capabilities', async () => {
      await expect(page(1, {}, 'child')).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      for (const descriptor of [
        { association: 'children' },
        { association: 'children', sourceKey: 1, where: {} },
        { association: 'children', sourceKey: 1, transaction: {} },
        {
          association: 'children',
          get sourceKey() {
            throw new Error('getter executed');
          },
        },
      ])
        await expect(
          entry.listAssociationPageFromParams(ctx, mainIdentity, authenticated, descriptor, {}),
        ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      await expect(page(1, { fields: ['id'], rootConstraint: {} })).rejects.toMatchObject({
        code: 'INVALID_ACCESS_MUTATION',
      });
    });
  });

  describe('association page lifecycle', () => {
    it('snapshots descriptor params and every permission before querying the source', async () => {
      const descriptor = { association: 'children', sourceKey: 1 };
      const params = { fields: ['name'], appends: ['document.name'], sort: ['name'] };
      const names = ['children.name', 'children.document.name'];
      permissions.set('', { allowed: true, params: { fields: [], appends: names } });
      permissions.set('children', { allowed: true, params: { filter: { amount: { $gt: 10 } } } });
      const original = docs.model.findOne.bind(docs.model);
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        descriptor.sourceKey = 2;
        params.fields[0] = 'id';
        params.appends[0] = 'document.id';
        params.sort[0] = '-name';
        names.splice(0, names.length, 'children.id');
        permissions.set('children.document', null);
        return original(options);
      });
      expect(
        await entry.listAssociationPageFromParams(ctx, mainIdentity, authenticated, descriptor, params),
      ).toMatchObject({
        rows: [
          { name: 'Legacy', document: { name: 'Owned' } },
          { name: 'Visible', document: { name: 'Owned' } },
        ],
        count: 2,
      });
    });

    it('rejects relation changes after source lookup and after target count', async () => {
      const original = docs.model.findOne.bind(docs.model);
      const relation = docs.model.associations.children;
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        const record = await original(options);
        Object.assign(relation, { scope: { name: 'Hidden' } });
        return record;
      });
      await expect(page()).rejects.toThrow(/changed/);
      Object.assign(relation, { scope: undefined });
      const count = children.model.count.bind(children.model);
      vi.spyOn(children.model, 'count').mockImplementationOnce(async (options) => {
        const result = await count(options);
        Object.assign(relation, { scope: { name: 'Hidden' } });
        return result;
      });
      await expect(page()).rejects.toThrow(/changed/);
    });

    it('rejects prepared phase release while the source lookup is pending', async () => {
      const original = docs.model.findOne.bind(docs.model);
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        const record = await original(options);
        adapter.release(ctx);
        return record;
      });
      await expect(page()).rejects.toThrow();
    });

    it('uses the live transaction for source target count and expanded queries', async () => {
      const transaction = await db.sequelize.transaction();
      try {
        await children.model.update({ documentId: 2 }, { where: { id: 101 }, transaction });
        await docs.model.update({ name: 'In transaction', tenantId: 'B' }, { where: { id: 2 }, transaction });
        expect(
          await entry.listAssociationPageFromParams(
            ctx,
            mainIdentity,
            authenticated,
            { association: 'children', sourceKey: 2 },
            { fields: ['id'], appends: ['document.name'], sort: 'id' },
            transaction,
          ),
        ).toMatchObject({
          rows: [
            { id: 101, document: { name: 'In transaction' } },
            { id: 105, document: { name: 'In transaction' } },
          ],
          count: 2,
        });
      } finally {
        await transaction.rollback();
      }
      expect(await page(2)).toMatchObject({ rows: [{ id: 105 }], count: 1 });
      await expect(
        entry.listAssociationPageFromParams(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'children', sourceKey: 1 },
          {},
          transaction,
        ),
      ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    });

    it('resolves trusted date shortcuts using target field metadata', async () => {
      await children.model.update({ occurredAt: '2026-10-15T17:00:00Z' }, { where: { id: 101 } });
      await children.model.update({ occurredAt: '2026-10-16T16:00:00Z' }, { where: { id: 102 } });
      expect(
        await entry.listAssociationPageFromParams(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'children', sourceKey: 1 },
          { fields: ['id'], filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } } },
          undefined,
          { now: '2026-10-16T03:00:00.000Z', timezone: '+08:00' },
        ),
      ).toMatchObject({ rows: [{ id: 101 }], count: 1 });
    });

    it('keeps query counts independent of page length', async () => {
      const messages: string[] = [];
      const logging = loggingOptions().logging;
      loggingOptions().logging = (sql) => messages.push(sql);
      try {
        const params = { fields: ['id'], appends: ['document.name'], pageSize: 100, sort: 'id' };
        await page(1, params);
        const before = messages.length;
        await children.model.bulkCreate(
          Array.from({ length: 40 }, (_, index) => ({
            id: 200 + index,
            documentId: 1,
            tenantId: 'B',
            name: 'Owned',
          })),
        );
        messages.length = 0;
        expect((await page(1, params)).rows).toHaveLength(43);
        expect(messages).toHaveLength(before);
        expect(before).toBeLessThanOrEqual(10);
      } finally {
        loggingOptions().logging = logging;
      }
    });
  });

  it('filters related targets by G or V without claiming legacy data', async () => {
    expect(await ids()).toEqual([101, 102, 104]);
    expect((await children.model.findByPk(104))?.getDataValue('tenantId')).toBeNull();
  });

  it('reads visibility-only and historical sources without changing their ownership', async () => {
    expect(await ids(2)).toEqual([105]);
    expect(await ids(4)).toEqual([107]);
    expect((await docs.model.findByPk(4))?.getDataValue('tenantId')).toBeNull();
  });

  it('rejects hidden or missing sources even when targets are readable', async () => {
    for (const key of [3, 999]) await expect(ids(key)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });

  it('intersects source and target ACL predicates independently', async () => {
    await expect(ids(1, { sourceWhere: { name: 'Other' } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await ids(1, { targetWhere: { amount: { [Op.gt]: 10 } } })).toEqual([102, 104]);
    expect(await ids(1, { targetWhere: { id: 105 } })).toEqual([]);
  });

  it('uses the same target scope for pagination count and sum', async () => {
    const scoped = await plan();
    expect(await children.model.count(scoped.query)).toBe(3);
    expect(await children.model.sum('amount', scoped.query)).toBe(60);
    expect(
      (await children.model.findAll({ ...scoped.query, limit: 1, offset: 1, order: [['id', 'ASC']] }))[0].getDataValue(
        'id',
      ),
    ).toBe(102);
  });

  it('preserves named bindings without colliding with generated scope bindings', async () => {
    expect(
      await ids(1, {
        sourceWhere: literal('"documents"."name" = $source_name'),
        sourceBind: { source_name: 'Owned' },
        targetWhere: literal('"children"."amount" > $tac_scope0_min'),
        targetBind: { tac_scope0_min: 10 },
      }),
    ).toEqual([102, 104]);
  });

  it('does not query a fictional source for the underscore target-list protocol', async () => {
    expect(await ids('_')).toEqual([101, 102, 104, 105, 106, 107]);
    expect(await ids('_', { targetKey: 103 })).toEqual([]);
  });

  it('keeps explicit target keys within the actual relationship', async () => {
    expect(await ids(1, { targetKey: 102 })).toEqual([102]);
    expect(await ids(1, { targetKey: 105 })).toEqual([]);
    expect(await ids(5)).toEqual([]);
  });

  it('reads a HasOne target with its own visibility and preserves empty results', async () => {
    expect(await ids(2, { association: 'child' })).toEqual([105]);
    expect(await ids(5, { association: 'child' })).toEqual([]);
    await children.model.update({ tenantId: 'C' }, { where: { id: 105 } });
    expect(await ids(2, { association: 'child' })).toEqual([]);
  });

  it('preserves association scope for concrete sources and underscore reads', async () => {
    docs.setField('visibleChildren', {
      type: 'hasMany',
      target: 'children',
      foreignKey: 'documentId',
      scope: { name: 'Visible' },
    });
    expect(await ids(1, { association: 'visibleChildren' })).toEqual([102]);
    expect(await ids('_', { association: 'visibleChildren' })).toEqual([102]);
  });

  it('retains source and target default scopes', async () => {
    children.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
    expect(await ids()).toEqual([101]);
    docs.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
    await expect(ids()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });

  it('keeps the live transaction object and reads uncommitted changes through it', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await children.model.update({ documentId: 2 }, { where: { id: 101 }, transaction });
      const scoped = await plan(2, { transaction });
      expect(scoped.query.transaction).toBe(transaction);
      expect(
        (await children.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) =>
          row.getDataValue('id'),
        ),
      ).toEqual([101, 105]);
    } finally {
      await transaction.rollback();
    }
    expect(await ids(2)).toEqual([105]);
  });

  it('rejects a finished or foreign transaction', async () => {
    const transaction = await db.sequelize.transaction();
    await transaction.rollback();
    await expect(plan(1, { transaction })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    const foreignDb = sqliteDatabase();
    const foreign = await foreignDb.sequelize.transaction();
    try {
      await expect(plan('_', { transaction: foreign })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    } finally {
      await foreign.rollback();
      await foreignDb.close();
    }
  });

  it('snapshots scalar inputs predicates and bindings before the first await', async () => {
    const sourceWhere = { name: 'Owned' };
    const targetBind = { min: 10 };
    const request = {
      association: 'children',
      sourceKey: 1,
      sourceWhere,
      targetWhere: literal('"children"."amount" > $min'),
      targetBind,
    };
    const pending = reads.scopeTargets(ctx, mainIdentity, target, authenticated, request);
    request.sourceKey = 3;
    sourceWhere.name = 'Hidden';
    targetBind.min = 999;
    const scoped = await pending;
    expect(
      (await children.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) => row.getDataValue('id')),
    ).toEqual([102, 104]);
  });

  it('does not publish a plan after its prepared phase ends', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const scoped = await original(...args);
      adapter.release(ctx);
      return scoped;
    });
    await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });

  it('rejects an association scope changed during target authorization', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const scoped = await original(...args);
      if (args[1].collectionName === target.collectionName)
        Object.assign(docs.model.associations.children, { scope: { name: 'Hidden' } });
      return scoped;
    });
    await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('rejects a target model identity replaced during authorization', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const scoped = await original(...args);
      Object.assign(children, { model: docs.model });
      return scoped;
    });
    try {
      await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    } finally {
      Object.assign(children, { model: db.sequelize.models.children });
    }
  });

  it('requires a verified active tenant when a rule needs it', async () => {
    for (const identity of [{}, { tenantId: 'missing' }]) {
      await expect(
        reads.scopeTargets(ctx, mainIdentity, target, identity, { association: 'children', sourceKey: '_' }),
      ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    }
  });

  it('rejects the wrong relation target and cross-data-source identity', async () => {
    await expect(plan(1, { association: 'document' })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    await expect(
      reads.scopeTargets(ctx, mainIdentity, { ...target, dataSourceKey: 'external' }, authenticated, {
        association: 'children',
        sourceKey: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    await expect(
      reads.scopeTargets(ctx, mainIdentity, mainIdentity, authenticated, { association: 'children', sourceKey: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it.each([{ sourceKey: null }, { sourceKey: 1.5 }, { targetKey: '_' }, { include: ['document'] }, { limit: 10 }])(
    'rejects unsupported selection %j',
    async (extra) => {
      await expect(plan(1, extra)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    },
  );

  it('rejects positional SQL bindings', async () => {
    await expect(plan(1, { targetBind: [1] })).rejects.toMatchObject({ code: 'INVALID_ACCESS_RULE' });
  });

  it('keeps authorization query count independent of the number of returned targets', async () => {
    const messages: string[] = [];
    const logging = loggingOptions().logging;
    loggingOptions().logging = (sql) => messages.push(sql);
    try {
      await ids();
      const before = messages.length;
      await children.repository.create({
        values: Array.from({ length: 50 }, (_, i) => ({
          id: 200 + i,
          documentId: 1,
          tenantId: 'B',
          name: 'Owned',
          amount: 1,
        })),
      });
      messages.length = 0;
      expect(await ids()).toHaveLength(53);
      expect(messages).toHaveLength(before);
      expect(before).toBeLessThanOrEqual(4);
    } finally {
      loggingOptions().logging = logging;
    }
  });

  it('denies targets when their migrated configuration has no rules', async () => {
    const config = await store.read(target);
    await store.save(target, { ...config, rules: [] }, { userId: 28 });
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity, target]);
    expect(await ids()).toEqual([]);
  });

  it('rejects an unprepared collection instead of falling back to old behavior', async () => {
    adapter.release(ctx);
    await adapter.prepare(ctx, [mainIdentity]);
    await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });
});
