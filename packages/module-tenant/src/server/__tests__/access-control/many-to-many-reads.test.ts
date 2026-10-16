import { ACL, literal, Op, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { AccessEntryReadService } from '../../access-control/entry-reads';
import { AccessManyToManyReadService } from '../../access-control/many-to-many-reads';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessEntryReadPermission } from '../../access-control/read-grants';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const target = { ...mainIdentity, collectionKey: 'projects-key', collectionName: 'projects' };
const through = { ...mainIdentity, collectionKey: 'links-key', collectionName: 'links' };
const authenticated = { tenantId: 'B' };

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('many-to-many reads (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let links: Collection;
  let store: AccessConfigStore;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let reads: AccessManyToManyReadService;
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
    for (const name of ['documents', 'projects', 'links']) {
      db.collection({
        name,
        tableName: `m2m_read_${name}`,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, field: 'record_id' },
          { name: 'tenantId', type: 'string', field: 'tenant_id' },
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
          ...(name === 'projects' ? [{ name: 'occurredAt', type: 'date', field: 'occurred_at' }] : []),
          ...(name === 'links'
            ? [
                { name: 'documentId', type: 'integer', field: 'document_id' },
                { name: 'projectId', type: 'integer', field: 'project_id' },
                { name: 'deletedAt', type: 'date', field: 'deleted_at' },
              ]
            : []),
        ],
      });
    }
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    links = db.getCollection('links');
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
    });
    for (const collection of [docs, projects, links]) await collection.model.sync();
    await docs.repository.create({
      values: [
        { id: 1, tenantId: 'B', name: 'Owned' },
        { id: 2, tenantId: 'H', name: 'Visible' },
        { id: 3, tenantId: 'C', name: 'Hidden' },
        { id: 4, tenantId: null, name: 'Legacy' },
        { id: 5, tenantId: 'B', name: 'Empty' },
      ],
    });
    await projects.repository.create({
      values: [
        { id: 101, tenantId: 'B', name: 'Owned', amount: 10 },
        { id: 102, tenantId: 'H', name: 'Visible', amount: 20 },
        { id: 103, tenantId: 'C', name: 'Hidden', amount: 100 },
        { id: 104, tenantId: null, name: 'Legacy', amount: 30 },
        { id: 105, tenantId: 'B', name: 'Other', amount: 40 },
        { id: 106, tenantId: 'B', name: 'HiddenLink', amount: 50 },
        { id: 107, tenantId: 'B', name: 'Unlinked', amount: 60 },
      ],
    });
    await links.repository.create({
      values: [
        { id: 1, documentId: 1, projectId: 101, tenantId: 'B', name: 'Owned' },
        { id: 2, documentId: 1, projectId: 101, tenantId: 'H', name: 'Visible' },
        { id: 3, documentId: 1, projectId: 102, tenantId: 'H', name: 'Visible' },
        { id: 4, documentId: 1, projectId: 103, tenantId: 'B', name: 'Owned' },
        { id: 5, documentId: 1, projectId: 104, tenantId: null, name: 'Legacy' },
        { id: 6, documentId: 2, projectId: 105, tenantId: 'B', name: 'Owned' },
        { id: 7, documentId: 3, projectId: 105, tenantId: 'B', name: 'Owned' },
        { id: 8, documentId: 4, projectId: 104, tenantId: null, name: 'Legacy' },
        { id: 9, documentId: 1, projectId: 106, tenantId: 'C', name: 'Hidden' },
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
    for (const identity of [target, through])
      await db
        .getRepository('collections')
        .create({ values: { key: identity.collectionKey, name: identity.collectionName } });
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
    for (const identity of [mainIdentity, target, through])
      await store.save(identity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, stableKey);
    reads = new AccessManyToManyReadService(db, adapter, queries);
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target, through]);
    permissions = new Map();
    permissionResolver = vi.fn((_collection: Collection, path: readonly string[], _operation: object) =>
      permissions.has(path.join('.')) ? permissions.get(path.join('.'))! : { allowed: true, params: {} },
    );
    entry = new AccessEntryReadService(
      db,
      adapter,
      queries,
      (collection) => [mainIdentity, target, through].find((identity) => identity.collectionName === collection.name),
      permissionResolver,
    );
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "m2m_read_links", "m2m_read_projects", "m2m_read_documents", "tenants", "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", "rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db.close();
    }
  });

  const plan = (sourceKey: string | number = 1, extra = {}) =>
    reads.scopeTargets(ctx, mainIdentity, target, through, authenticated, {
      association: 'projects',
      sourceKey,
      ...extra,
    });
  async function ids(sourceKey: string | number = 1, extra = {}) {
    const scoped = await plan(sourceKey, extra);
    return (await projects.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) =>
      row.getDataValue('id'),
    );
  }

  describe('association summary entry', () => {
    const count = (sourceKey: unknown = 1, params: unknown = {}) =>
      entry.countAssociationFromParams(
        ctx,
        mainIdentity,
        authenticated,
        { association: 'projects', sourceKey },
        params,
      );
    const sum = (sourceKey: unknown = 1, params: unknown = { field: 'amount' }) =>
      entry.sumAssociationFromParams(ctx, mainIdentity, authenticated, { association: 'projects', sourceKey }, params);

    it('counts and sums distinct readable targets rather than duplicate or unreadable links', async () => {
      expect(await count()).toBe(3);
      expect(await sum()).toBe(60);
      expect(await count(2)).toBe(1);
      expect(await sum(2)).toBe(40);
      expect(await count(5)).toBe(0);
      expect(await sum(5)).toBeNull();
      expect(await count(1, { filter: { amount: { $gte: 20 } } })).toBe(2);
      expect(await sum(1, { field: 'amount', filter: { amount: { $gte: 20 } } })).toBe(50);
      expect(
        await entry.fromResource(
          ctx,
          authenticated,
          { resourceName: 'documents.projects', sourceId: 1, actionName: 'count' },
          {},
        ),
      ).toBe(3);
      expect(new Set(permissionResolver.mock.calls.map(([, , operation]) => operation.kind))).toEqual(
        new Set(['count', 'sum']),
      );
      expect(permissionResolver.mock.calls.some(([, path]) => path.join('.') === 'projects.$through')).toBe(true);
    });

    it('intersects role filters independently on the source target and through without requiring through fields', async () => {
      permissions.set('', {
        allowed: true,
        params: { fields: [], appends: ['projects.amount'], filter: { name: 'Owned' } },
      });
      permissions.set('projects', { allowed: true, params: { fields: ['amount'], filter: { amount: { $gte: 20 } } } });
      permissions.set('projects.$through', { allowed: true, params: { fields: [], filter: { name: 'Visible' } } });
      expect(await count()).toBe(1);
      expect(await sum()).toBe(20);
      expect(await count(1, { filter: { amount: { $gt: 20 } } })).toBe(0);
      await expect(sum(2)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it('requires the current summary operation at all three permission paths', async () => {
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const path of ['', 'projects', 'projects.$through']) {
        permissions.clear();
        permissions.set(path, { allowed: false, params: {} });
        await expect(count()).rejects.toThrow(/authorized/);
        await expect(sum()).rejects.toThrow(/authorized/);
      }
      expect(sql).not.toHaveBeenCalled();
    });

    it('does not claim legacy rows or make an unreadable source accessible through visible links', async () => {
      expect(await count(4)).toBe(1);
      expect(await sum(4)).toBe(30);
      for (const sourceKey of [3, 999]) {
        await expect(count(sourceKey)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
        await expect(sum(sourceKey)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      }
      expect((await docs.model.findByPk(4))!.getDataValue('tenantId')).toBeNull();
      expect((await projects.model.findByPk(104))!.getDataValue('tenantId')).toBeNull();
      expect((await links.model.findByPk(8))!.getDataValue('tenantId')).toBeNull();
    });

    it('snapshots descriptors filters identities and permissions before the source query', async () => {
      const descriptor = { association: 'projects', sourceKey: 1 };
      const identity = { tenantId: 'B' };
      const params = { field: 'amount', filter: { amount: { $gte: 20 } } };
      const permission = { allowed: true, params: { fields: ['amount'], filter: { amount: { $lte: 20 } } } };
      permissions.set('projects', permission);
      const pending = entry.sumAssociationFromParams(ctx, mainIdentity, identity, descriptor, params);
      descriptor.sourceKey = 2;
      descriptor.association = 'missing';
      identity.tenantId = 'C';
      params.field = 'id';
      params.filter.amount.$gte = 100;
      permission.params.filter.amount.$lte = 100;
      expect(await pending).toBe(20);
    });

    it('uses a trusted live transaction and resolves dates against the target field', async () => {
      await db.sequelize.transaction(async (transaction) => {
        await links.model.update({ projectId: 102 }, { where: { id: 6 }, transaction });
        await projects.model.update(
          { occurredAt: new Date('2026-09-15T16:00:00Z') },
          { where: { id: 102 }, transaction },
        );
        const filter = { occurredAt: { $dateOn: '{{$nDate.today}}' } };
        const dates = { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' };
        const sourceQuery = vi.spyOn(docs.model, 'findOne');
        const targetQuery = vi.spyOn(projects.model, 'sum');
        expect(
          await entry.sumAssociationFromParams(
            ctx,
            mainIdentity,
            authenticated,
            { association: 'projects', sourceKey: 2 },
            { field: 'amount', filter },
            transaction,
            dates,
          ),
        ).toBe(20);
        expect(sourceQuery.mock.calls[0][0]!.transaction).toBe(transaction);
        expect(targetQuery.mock.calls[0][1]!.transaction).toBe(transaction);
        expect(
          await entry.countAssociationFromParams(
            ctx,
            mainIdentity,
            authenticated,
            { association: 'projects', sourceKey: 2 },
            { filter },
            transaction,
            dates,
          ),
        ).toBe(1);
      });
    });

    it('rechecks through and target metadata after asynchronous execution', async () => {
      const originalSource = docs.model.findOne.bind(docs.model);
      const sourceQuery = vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (...args) => {
        const record = await originalSource(...args);
        links.model.rawAttributes.projectId.field = 'changed_column';
        return record;
      });
      await expect(count()).rejects.toThrow(/changed/);
      links.model.rawAttributes.projectId.field = 'project_id';
      sourceQuery.mockRestore();
      const originalSum = projects.model.sum.bind(projects.model);
      vi.spyOn(projects.model, 'sum').mockImplementationOnce(async (...args) => {
        const result = await originalSum(...args);
        projects.model.rawAttributes.amount.field = 'changed_amount';
        return result;
      });
      await expect(sum()).rejects.toThrow(/changed/);
    });

    it('preserves target and through association scopes default scopes and soft deletion', async () => {
      docs.setField('visibleProjects', {
        type: 'belongsToMany',
        target: 'projects',
        through: 'links',
        foreignKey: 'documentId',
        otherKey: 'projectId',
        throughUnique: false,
        scope: { name: 'Visible' },
        throughScope: { name: 'Visible' },
      });
      expect(
        await entry.countAssociationFromParams(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'visibleProjects', sourceKey: 1 },
          {},
        ),
      ).toBe(1);
      expect(
        await entry.sumAssociationFromParams(
          ctx,
          mainIdentity,
          authenticated,
          { association: 'visibleProjects', sourceKey: 1 },
          { field: 'amount' },
        ),
      ).toBe(20);
      links.model.options.paranoid = true;
      (links.model as unknown as { _timestampAttributes: Record<string, string> })._timestampAttributes.deletedAt =
        'deletedAt';
      await links.model.update({ deletedAt: new Date() }, { where: { id: 3 } });
      expect(await count()).toBe(2);
      expect(await sum()).toBe(40);
      links.model.addScope('defaultScope', { where: { name: 'Legacy' } }, { override: true });
      expect(await count()).toBe(1);
      expect(await sum()).toBe(30);
      projects.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
      expect(await count()).toBe(0);
      expect(await sum()).toBeNull();
    });

    it('summarizes shared source target and through models without tenant columns or tenant context', async () => {
      for (const identity of [mainIdentity, target, through])
        await store.save(
          identity,
          { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
          { userId: 28 },
        );
      adapter.release(ctx);
      for (const collection of [docs, projects, links]) {
        collection.removeField('tenantId');
        await db.sequelize.getQueryInterface().removeColumn(collection.model.getTableName(), 'tenant_id');
      }
      await adapter.prepare(ctx, [mainIdentity, target, through]);
      expect(
        await entry.countAssociationFromParams(ctx, mainIdentity, {}, { association: 'projects', sourceKey: 1 }, {}),
      ).toBe(5);
      expect(
        await entry.sumAssociationFromParams(
          ctx,
          mainIdentity,
          {},
          { association: 'projects', sourceKey: 1 },
          { field: 'amount' },
        ),
      ).toBe(210);
      permissions.set('projects.$through', { allowed: true, params: { fields: [], filter: { name: 'Visible' } } });
      expect(
        await entry.countAssociationFromParams(ctx, mainIdentity, {}, { association: 'projects', sourceKey: 1 }, {}),
      ).toBe(2);
    });

    it('keeps summary query counts bounded as linked targets increase', async () => {
      const sql = vi.spyOn(db.sequelize, 'query');
      expect(await count()).toBe(3);
      const before = sql.mock.calls.length;
      await projects.model.bulkCreate(
        Array.from({ length: 20 }, (_, i) => ({ id: 200 + i, tenantId: 'B', name: 'Owned', amount: 1 })),
      );
      await links.model.bulkCreate(
        Array.from({ length: 20 }, (_, i) => ({
          id: 200 + i,
          documentId: 1,
          projectId: 200 + i,
          tenantId: 'B',
          name: 'Owned',
        })),
      );
      sql.mockClear();
      expect(await count()).toBe(23);
      expect(sql.mock.calls.length).toBe(before);
      expect(before).toBeLessThanOrEqual(10);
      sql.mockClear();
      expect(await sum()).toBe(80);
      expect(sql.mock.calls.length).toBe(before);
    });
  });

  describe('many-to-many entry', () => {
    const page = (sourceKey: unknown = 1, params: unknown = { fields: ['id'], sort: 'id' }, association = 'projects') =>
      entry.listAssociationPageFromParams(ctx, mainIdentity, authenticated, { association, sourceKey }, params);
    const detail = (sourceKey: unknown = 1, params: unknown = { fields: ['id'], filterByTk: 101 }) =>
      entry.getAssociationFromParams(ctx, mainIdentity, authenticated, { association: 'projects', sourceKey }, params);
    const route = (actionName = 'list', sourceId: unknown = 1, params: unknown = { fields: ['id'], sort: 'id' }) =>
      entry.fromResource(ctx, authenticated, { resourceName: 'documents.projects', sourceId, actionName }, params);

    it('pages distinct readable targets using readable links and the same count', async () => {
      expect(await page(1, { fields: ['id'], sort: '-amount', pageSize: 1, page: 2 })).toEqual({
        rows: [{ id: 102 }],
        count: 3,
        page: 2,
        pageSize: 1,
        totalPage: 3,
      });
      expect(await route()).toMatchObject({ rows: [{ id: 101 }, { id: 102 }, { id: 104 }], count: 3 });
      expect(await page(5)).toMatchObject({ rows: [], count: 0 });
    });

    it('requires an explicit detail key and excludes hidden unrelated or unlinked targets', async () => {
      expect(await detail()).toEqual({ id: 101 });
      for (const filterByTk of [102, 104])
        expect(await route('get', 1, { fields: ['id'], filterByTk })).toEqual({ id: filterByTk });
      for (const filterByTk of [103, 105, 106, 107, 999])
        expect(await detail(1, { fields: ['id'], filterByTk })).toBeNull();
      expect(await detail(2, { fields: ['id'], filterByTk: 105 })).toEqual({ id: 105 });
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const filterByTk of [undefined, null, {}, [], ''])
        await expect(detail(1, { fields: ['id'], filterByTk })).rejects.toThrow();
      expect(sql).not.toHaveBeenCalled();
    });

    it('uses the core target collection business detail key independently of pairing keys', async () => {
      projects.options.filterTargetKey = 'name';
      docs.options.filterTargetKey = 'name';
      // Core MultipleRelationRepository delegates filterByTk to the target collection repository.
      expect(await detail(1, { fields: ['id'], filterByTk: 'Visible' })).toEqual({ id: 102 });
      expect(await detail(1, { fields: ['id'], filterByTk: 'Hidden' })).toBeNull();
      expect(await detail(1, { fields: ['id'], filterByTk: 'Other' })).toBeNull();
    });

    it('intersects independent source target and through role predicates', async () => {
      permissions.set('', { allowed: true, params: { filter: { name: 'Visible' } } });
      await expect(page()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      permissions.set('', { allowed: true, params: {} });
      permissions.set('projects', { allowed: true, params: { filter: { amount: { $gt: 10 } } } });
      permissions.set('projects.$through', { allowed: true, params: { fields: [], filter: { name: 'Visible' } } });
      expect(await page()).toMatchObject({ rows: [{ id: 102 }], count: 1 });
      expect(await detail(1, { fields: ['id'], filterByTk: 101 })).toBeNull();
      expect(permissionResolver.mock.calls.some(([, path]) => path.join('.') === 'projects.$through')).toBe(true);
      expect(permissionResolver.mock.calls.at(-1)![2]).toMatchObject({ kind: 'get', source: mainIdentity });
    });

    it('does not grant a denied operation association or through permission', async () => {
      for (const [path, permission] of [
        ['', null],
        ['', { allowed: true, params: { fields: ['name'], appends: [] } }],
        ['projects', null],
        ['projects.$through', { allowed: false, params: {} }],
      ] as const) {
        permissions.clear();
        permissions.set(path, permission);
        const sql = vi.spyOn(db.sequelize, 'query');
        await expect(page()).rejects.toThrow(/authorized/);
        await expect(detail()).rejects.toThrow(/authorized/);
        expect(sql).not.toHaveBeenCalled();
        sql.mockRestore();
      }
    });

    it('enforces ancestor nested fields without exposing or requiring join keys', async () => {
      permissions.set('', { allowed: true, params: { fields: [], appends: ['projects.name'] } });
      permissions.set('projects.$through', { allowed: true, params: { fields: [] } });
      expect(await page(1, { fields: ['name'], sort: 'name' })).toMatchObject({
        rows: [{ name: 'Legacy' }, { name: 'Owned' }, { name: 'Visible' }],
        count: 3,
      });
      expect(await detail(1, { fields: ['name'], filterByTk: 101 })).toEqual({ name: 'Owned' });
      const sql = vi.spyOn(db.sequelize, 'query');
      for (const params of [
        { fields: ['id'] },
        { fields: ['name'], filter: { amount: 10 } },
        { fields: ['name'], sort: 'amount' },
        { fields: ['name'], appends: ['links.name'] },
      ])
        await expect(page(1, params)).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(sql).not.toHaveBeenCalled();
    });

    it('keeps root relationship constraints away from expansions and internal role facts', async () => {
      projects.setField('links', { type: 'hasMany', target: 'links', foreignKey: 'projectId' });
      permissions.set('projects', { allowed: true, params: { filter: { links: { id: 9 } } } });
      // A role may use a hidden link internally; root membership still requires a visible link.
      expect(await page()).toMatchObject({ rows: [], count: 0 });
      permissions.set('projects', { allowed: true, params: { filter: { links: { id: 2 } } } });
      expect(await page(1, { fields: ['name'], appends: ['links.name'] })).toMatchObject({
        rows: [{ name: 'Owned', links: [{ name: 'Owned' }, { name: 'Visible' }] }],
        count: 1,
      });
      expect(permissionResolver.mock.calls.some(([, path]) => path.join('.') === 'projects.links')).toBe(true);
    });

    it('reads historical source targets and links without claiming them', async () => {
      expect(await route('get', 4, { fields: ['id'], filterByTk: 104 })).toEqual({ id: 104 });
      for (const [model, id] of [
        [docs.model, 4],
        [projects.model, 104],
        [links.model, 8],
      ] as const)
        expect((await model.findByPk(id))!.getDataValue('tenantId')).toBeNull();
    });

    it('combines relationship membership with authorized association filters and root sorting', async () => {
      projects.setField('links', { type: 'hasMany', target: 'links', foreignKey: 'projectId' });
      permissions.set('projects.$through', { allowed: true, params: { filter: { name: 'Visible' } } });
      // The membership link and the separately requested filter may match different readable rows.
      expect(await page(1, { fields: ['id'], filter: { links: { name: 'Owned' } }, sort: '-amount' })).toMatchObject({
        rows: [{ id: 101 }],
        count: 1,
      });
      permissions.set('projects', { allowed: true, params: { filter: { amount: { $gt: 10 } } } });
      expect(await page(1, { fields: ['id'], filter: { links: { name: 'Visible' } }, sort: '-amount' })).toMatchObject({
        rows: [{ id: 102 }],
        count: 1,
      });
      permissions.clear();
      // Target 105 has a readable link to source 2 and a hidden link to source 3.
      await links.model.update({ tenantId: 'C', name: 'Hidden' }, { where: { id: 7 } });
      expect(await page(2, { fields: ['id'], filter: { links: { id: 7 } }, sort: 'id' })).toMatchObject({
        rows: [],
        count: 0,
      });
    });

    it('keeps underscore reads independent of source and through configuration', async () => {
      const direct = {};
      await adapter.prepare(direct, [target]);
      permissions.set('', { allowed: true, params: {} });
      expect(
        await entry.fromResource(
          direct,
          authenticated,
          {
            resourceName: 'documents.projects',
            sourceId: '_',
            actionName: 'get',
          },
          { fields: ['id'], filterByTk: 106 },
        ),
      ).toEqual({ id: 106 });
      await expect(
        entry.fromResource(
          direct,
          authenticated,
          {
            resourceName: 'documents.projects',
            sourceId: 1,
            actionName: 'get',
          },
          { fields: ['id'], filterByTk: 106 },
        ),
      ).rejects.toThrow();
    });

    it('requires explicit configuration but supports shared targets and links without tenant columns', async () => {
      for (const identity of [target, through])
        await store.save(
          identity,
          {
            ...configFor({ type: 'constant', value: true }),
            ownership: { enabled: false },
            revision: 1,
          },
          { userId: 28 },
        );
      adapter.release(ctx);
      for (const collection of [projects, links]) {
        collection.removeField('tenantId');
        await db.sequelize.getQueryInterface().removeColumn(collection.model.getTableName(), 'tenant_id');
      }
      await adapter.prepare(ctx, [mainIdentity, target, through]);
      expect(await page()).toMatchObject({
        rows: [{ id: 101 }, { id: 102 }, { id: 103 }, { id: 104 }, { id: 106 }],
        count: 5,
      });
      await expect(page(3)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it('preserves relationship scopes default scopes and soft-deleted links', async () => {
      docs.setField('visibleProjects', {
        type: 'belongsToMany',
        target: 'projects',
        through: 'links',
        foreignKey: 'documentId',
        otherKey: 'projectId',
        throughUnique: false,
        scope: { name: 'Visible' },
        throughScope: { name: 'Visible' },
      });
      expect(await page(1, { fields: ['id'] }, 'visibleProjects')).toMatchObject({ rows: [{ id: 102 }], count: 1 });
      links.model.options.paranoid = true;
      (links.model as unknown as { _timestampAttributes: Record<string, string> })._timestampAttributes.deletedAt =
        'deletedAt';
      await links.model.update({ deletedAt: new Date() }, { where: { id: 3 } });
      expect(await page()).toMatchObject({ rows: [{ id: 101 }, { id: 104 }], count: 2 });
      links.model.addScope('defaultScope', { where: { name: 'Legacy' } }, { override: true });
      expect(await page()).toMatchObject({ rows: [{ id: 104 }], count: 1 });
      projects.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
      expect(await page()).toMatchObject({ rows: [], count: 0 });
    });

    it('captures descriptor params and all grants before the source lookup yields', async () => {
      const action = { resourceName: 'documents.projects', sourceId: 1, actionName: 'list' };
      const params = { fields: ['name'], sort: ['name'] };
      const throughFilter = { name: 'Visible' };
      permissions.set('projects.$through', { allowed: true, params: { filter: throughFilter } });
      const original = docs.model.findOne.bind(docs.model);
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        action.sourceId = 2;
        action.actionName = 'get';
        params.fields[0] = 'id';
        params.sort[0] = '-name';
        throughFilter.name = 'Hidden';
        permissions.set('projects', null);
        return original(options);
      });
      expect(await entry.fromResource(ctx, authenticated, action, params)).toMatchObject({
        rows: [{ name: 'Owned' }, { name: 'Visible' }],
        count: 2,
      });
    });

    it('rejects changed through metadata after source lookup and target business keys after detail query', async () => {
      const original = docs.model.findOne.bind(docs.model);
      vi.spyOn(docs.model, 'findOne').mockImplementationOnce(async (options) => {
        const record = await original(options);
        links.model.rawAttributes.projectId.field = 'changed_column';
        return record;
      });
      await expect(page()).rejects.toThrow(/changed/);
      links.model.rawAttributes.projectId.field = 'project_id';
      projects.options.filterTargetKey = 'name';
      const find = projects.model.findAll.bind(projects.model);
      vi.spyOn(projects.model, 'findAll').mockImplementationOnce(async (options) => {
        const rows = await find(options);
        projects.options.filterTargetKey = 'id';
        return rows;
      });
      await expect(detail(1, { fields: ['id'], filterByTk: 'Visible' })).rejects.toThrow(/changed/);
    });

    it('uses trusted transactions and date context while keeping detail queries bounded', async () => {
      await projects.model.update({ occurredAt: new Date('2026-09-15T16:00:00Z') }, { where: { id: 102 } });
      const count = vi.spyOn(projects.model, 'count');
      const find = vi.spyOn(projects.model, 'findAll');
      await db.sequelize.transaction(async (transaction) => {
        await links.model.update({ projectId: 102 }, { where: { id: 6 }, transaction });
        expect(
          await entry.fromResource(
            ctx,
            authenticated,
            {
              resourceName: 'documents.projects',
              sourceId: 2,
              actionName: 'get',
            },
            { fields: ['id'], filterByTk: 102, filter: { occurredAt: { $dateOn: '{{$nDate.today}}' } } },
            transaction,
            { now: '2026-09-16T00:00:00.000Z', timezone: '+08:00' },
          ),
        ).toEqual({ id: 102 });
        expect(find.mock.calls[0][0]).toMatchObject({ transaction, limit: 1 });
      });
      expect(count).not.toHaveBeenCalled();
    });

    it('keeps query counts constant when the number of distinct targets increases', async () => {
      const sql = vi.spyOn(db.sequelize, 'query');
      await page(1, { fields: ['id'], pageSize: 100 });
      const before = sql.mock.calls.length;
      sql.mockClear();
      await projects.model.bulkCreate(
        Array.from({ length: 20 }, (_, i) => ({ id: 200 + i, tenantId: 'B', name: 'Owned' })),
      );
      await links.model.bulkCreate(
        Array.from({ length: 20 }, (_, i) => ({
          id: 200 + i,
          documentId: 1,
          projectId: 200 + i,
          tenantId: 'B',
          name: 'Owned',
        })),
      );
      sql.mockClear();
      expect(await page(1, { fields: ['id'], pageSize: 100 })).toMatchObject({ count: 23 });
      expect(sql.mock.calls.length).toBe(before);
    });
  });

  it('intersects target and through G or V and never claims historical records', async () => {
    expect(await ids()).toEqual([101, 102, 104]);
    expect((await projects.model.findByPk(104))!.getDataValue('tenantId')).toBeNull();
    expect((await links.model.findByPk(5))!.getDataValue('tenantId')).toBeNull();
  });
  it('reads visible and historical sources without claiming them', async () => {
    expect(await ids(2)).toEqual([105]);
    expect(await ids(4)).toEqual([104]);
    expect((await docs.model.findByPk(4))!.getDataValue('tenantId')).toBeNull();
  });
  it('rejects hidden or missing sources', async () => {
    for (const key of [3, 999]) await expect(ids(key)).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('intersects three independent ACL predicates', async () => {
    await expect(ids(1, { sourceWhere: { name: 'Other' } })).rejects.toMatchObject({
      code: 'ACCESS_RECORD_UNAVAILABLE',
    });
    expect(await ids(1, { targetWhere: { amount: { [Op.gt]: 10 } } })).toEqual([102, 104]);
    expect(await ids(1, { throughWhere: { name: 'Owned' } })).toEqual([101]);
    expect(await ids(1, { throughWhere: { name: 'Hidden' } })).toEqual([]);
  });
  it('does not duplicate list pagination count or sum for repeated links', async () => {
    const scoped = await plan();
    expect(await projects.model.count(scoped.query)).toBe(3);
    expect(await projects.model.sum('amount', scoped.query)).toBe(60);
    expect(
      (await projects.model.findAll({ ...scoped.query, limit: 1, offset: 1, order: [['id', 'ASC']] }))[0].getDataValue(
        'id',
      ),
    ).toBe(102);
  });
  it('restricts concrete reads to the real source and explicit target', async () => {
    expect(await ids(1, { targetKey: 102 })).toEqual([102]);
    expect(await ids(1, { targetKey: 105 })).toEqual([]);
    expect(await ids(5)).toEqual([]);
  });
  it('treats underscore as a direct target read even without a readable link', async () => {
    expect(await ids('_')).toEqual([101, 102, 104, 105, 106, 107]);
    expect(await ids('_', { targetKey: 103 })).toEqual([]);
  });
  it('preserves source through and target named bindings and avoids generated prefixes', async () => {
    expect(
      await ids(1, {
        sourceWhere: literal('"documents"."name" = $same'),
        sourceBind: { same: 'Owned' },
        throughWhere: literal('"links"."name" = $tac_scope0_name'),
        throughBind: { tac_scope0_name: 'Visible' },
        targetWhere: literal('"projects"."amount" > $minimum'),
        targetBind: { minimum: 10 },
      }),
    ).toEqual([102]);
  });
  it('rejects colliding through and target bindings rather than overwriting', async () => {
    await expect(plan(1, { throughBind: { key: 'Visible' }, targetBind: { key: 101 } })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
  });
  it('preserves target and through association scopes', async () => {
    docs.setField('visibleProjects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
      scope: { name: 'Visible' },
      throughScope: { name: 'Visible' },
    });
    expect(await ids(1, { association: 'visibleProjects' })).toEqual([102]);
    expect(await ids('_', { association: 'visibleProjects' })).toEqual([102]);
    await links.model.update({ name: 'Owned', tenantId: 'B' }, { where: { id: 3 } });
    expect(await ids(1, { association: 'visibleProjects' })).toEqual([]);
  });
  it('retains all model default scopes', async () => {
    links.model.addScope('defaultScope', { where: { name: 'Owned' } }, { override: true });
    expect(await ids()).toEqual([101]);
    projects.model.addScope('defaultScope', { where: { name: 'Visible' } }, { override: true });
    expect(await ids()).toEqual([]);
    docs.model.addScope('defaultScope', { where: { name: 'Hidden' } }, { override: true });
    await expect(ids()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });
  it('retains through soft deletion', async () => {
    links.model.options.paranoid = true;
    (links.model as unknown as { _timestampAttributes: Record<string, string> })._timestampAttributes.deletedAt =
      'deletedAt';
    await links.model.update({ deletedAt: new Date() }, { where: { id: 3 } });
    expect(await ids()).toEqual([101, 104]);
  });
  it('reads uncommitted relationship changes using the live transaction', async () => {
    const transaction = await db.sequelize.transaction();
    try {
      await links.model.update({ documentId: 2 }, { where: { id: 1 }, transaction });
      const scoped = await plan(2, { transaction });
      expect(scoped.query.transaction).toBe(transaction);
      expect(
        (await projects.model.findAll({ ...scoped.query, order: [['id', 'ASC']] })).map((row) =>
          row.getDataValue('id'),
        ),
      ).toEqual([101, 105]);
    } finally {
      await transaction.rollback();
    }
    expect(await ids(2)).toEqual([105]);
  });
  it('rejects finished transactions', async () => {
    const transaction = await db.sequelize.transaction();
    await transaction.rollback();
    await expect(plan(1, { transaction })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
  });
  it('requires tenant context for enabled ownership rules', async () => {
    await expect(
      reads.scopeTargets(ctx, mainIdentity, target, through, {}, { association: 'projects', sourceKey: 1 }),
    ).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
  });
  it('rejects missing or unmigrated through configuration', async () => {
    const unprepared = {};
    await adapter.prepare(unprepared, [mainIdentity, target]);
    await expect(
      reads.scopeTargets(unprepared, mainIdentity, target, through, authenticated, {
        association: 'projects',
        sourceKey: 1,
      }),
    ).rejects.toThrow();
    await db.getCollection('collections').model.update({ options: {} }, { where: { key: through.collectionKey } });
    const migrated = {};
    await adapter.prepare(migrated, [mainIdentity, target, through]);
    await expect(
      reads.scopeTargets(migrated, mainIdentity, target, through, authenticated, {
        association: 'projects',
        sourceKey: 1,
      }),
    ).rejects.toThrow();
  });
  it('supports an explicit shared through model while preserving its ACL', async () => {
    await store.save(
      through,
      { ...configFor({ type: 'constant', value: true }), ownership: { enabled: false }, revision: 1 },
      { userId: 28 },
    );
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target, through]);
    expect(await ids()).toEqual([101, 102, 104, 106]);
    expect(await ids(1, { throughWhere: { name: 'Owned' } })).toEqual([101]);
  });

  it('compiles the through model own relational visibility without shadowing target correlations', async () => {
    links.setField('document', { type: 'belongsTo', target: 'documents', foreignKey: 'documentId' });
    await store.save(
      through,
      {
        ...configFor(
          {
            type: 'exists',
            path: 'document',
            condition: {
              type: 'compare',
              operator: 'eq',
              left: { type: 'field', path: 'name' },
              right: { type: 'literal', value: 'Visible' },
            },
          },
          'visibility',
        ),
        revision: 1,
      },
      { userId: 28 },
    );
    ctx = {};
    await adapter.prepare(ctx, [mainIdentity, target, through]);
    expect(await ids(1)).toEqual([]);
    expect(await ids(2)).toEqual([105]);
  });

  it('rejects an association override bypassing through soft deletion', async () => {
    links.model.options.paranoid = true;
    (links.model as unknown as { _timestampAttributes: Record<string, string> })._timestampAttributes.deletedAt =
      'deletedAt';
    docs.setField('deletedProjects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
      throughUnique: false,
      throughParanoid: false,
    });
    await expect(plan(1, { association: 'deletedProjects' })).rejects.toMatchObject({
      code: 'INVALID_ACCESS_MUTATION',
    });
  });
  it.each(['association', 'targetKey', 'sourceKey', 'include', 'limit'])('rejects invalid %s input', async (field) => {
    await expect(
      plan(1, {
        [field]: field === 'association' ? 'missing' : field === 'sourceKey' ? [] : field === 'targetKey' ? '_' : [],
      }),
    ).rejects.toThrow();
  });
  it('rejects a forged through identity and cross-data-source identities', async () => {
    for (const identity of [
      { ...through, collectionKey: 'wrong' },
      { ...through, dataSourceKey: 'other' },
      { ...target },
    ])
      await expect(
        reads.scopeTargets(ctx, mainIdentity, target, identity, authenticated, {
          association: 'projects',
          sourceKey: 1,
        }),
      ).rejects.toThrow();
  });
  it('rejects association replacement during async authorization', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      delete docs.model.associations.projects;
      return result;
    });
    await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });
  it('snapshots caller predicates before the first await', async () => {
    const input = { targetWhere: { name: 'Visible' }, throughWhere: { name: 'Visible' } };
    const pending = ids(1, input);
    input.targetWhere.name = 'Owned';
    input.throughWhere.name = 'Owned';
    expect(await pending).toEqual([102]);
  });

  it.each([mainIdentity, target, through])(
    'denies reads when $collectionName has no enabled rules',
    async (identity) => {
      await store.save(identity, { ...(await store.read(identity)), rules: [] }, { userId: 28 });
      ctx = {};
      await adapter.prepare(ctx, [mainIdentity, target, through]);
      if (identity === mainIdentity) await expect(ids()).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
      else expect(await ids()).toEqual([]);
    },
  );

  it.each(['sourceBind', 'targetBind', 'throughBind'])('rejects positional bindings in %s', async (field) => {
    await expect(plan(1, { [field]: [1] })).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
  });

  it('does not publish a query after its prepared phase ends', async () => {
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      adapter.release(ctx);
      return result;
    });
    await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
  });

  it.each(['projects', 'links'])('rejects %s model replacement after authorization', async (name) => {
    const collection = db.getCollection(name);
    const model = collection.model;
    const original = queries.scopeQuery.bind(queries);
    vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].collectionName === name) Object.assign(collection, { model: docs.model });
      return result;
    });
    try {
      await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
    } finally {
      Object.assign(collection, { model });
    }
  });

  it.each(['scope', 'throughScope', 'column', 'defaultScope'])(
    'rejects changed %s metadata across authorization awaits',
    async (kind) => {
      const original = queries.scopeQuery.bind(queries);
      const oldColumn = links.model.rawAttributes.documentId.field;
      vi.spyOn(queries, 'scopeQuery').mockImplementation(async (...args) => {
        const result = await original(...args);
        if (args[1].collectionName === target.collectionName) {
          const association = docs.model.associations.projects as unknown as {
            scope: object;
            through: { scope: object };
          };
          if (kind === 'scope') association.scope = { name: 'Hidden' };
          if (kind === 'throughScope') association.through.scope = { name: 'Hidden' };
          if (kind === 'column') links.model.rawAttributes.documentId.field = 'other_column';
          if (kind === 'defaultScope')
            links.model.addScope('defaultScope', { where: { name: 'Hidden' } }, { override: true });
        }
        return result;
      });
      try {
        await expect(plan()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      } finally {
        links.model.rawAttributes.documentId.field = oldColumn;
      }
    },
  );

  it('keeps authorization query count constant as target count grows', async () => {
    const messages: string[] = [];
    const runtime = db.sequelize as unknown as { options: { logging: false | ((sql: string) => void) } };
    const logging = runtime.options.logging;
    runtime.options.logging = (sql) => messages.push(sql);
    try {
      await ids();
      const before = messages.length;
      await projects.repository.create({
        values: Array.from({ length: 50 }, (_, i) => ({ id: 200 + i, tenantId: 'B', name: 'Owned', amount: 1 })),
      });
      await links.repository.create({
        values: Array.from({ length: 50 }, (_, i) => ({
          id: 200 + i,
          documentId: 1,
          projectId: 200 + i,
          tenantId: 'B',
          name: 'Owned',
        })),
      });
      messages.length = 0;
      expect(await ids()).toHaveLength(53);
      expect(messages).toHaveLength(before);
      expect(before).toBeLessThanOrEqual(5);
    } finally {
      runtime.options.logging = logging;
    }
  });

  it('rejects foreign transactions even for direct target reads', async () => {
    const foreignDb = sqliteDatabase();
    const transaction = await foreignDb.sequelize.transaction();
    try {
      await expect(plan('_', { transaction })).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    } finally {
      await transaction.rollback();
      await foreignDb.close();
    }
  });
});
