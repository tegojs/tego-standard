import { ACL, Resourcer, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessResourceMutationHandler } from '../../access-control/resource-mutation-handler';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import type { AccessConfig } from '../../access-control/types';
import { seedAclScopes } from './acl-database';
import { externalIdentity, mainIdentity, seedConfigStore } from './config-database';
import { sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const actor = { tenantId: 'B', roleName: 'editor', userId: 28 };
type Operation = 'list' | 'create' | 'update' | 'destroy';

describe('external resource tenant authority boundary', () => {
  let primary: Database;
  let external: Database;
  let primaryDocs: Collection;
  let externalDocs: Collection;
  let store: AccessConfigStore;
  let primaryAdapter: AccessAclScopeAdapter;
  let externalAdapter: AccessAclScopeAdapter;

  beforeEach(async () => {
    primary = sqliteDatabase();
    external = sqliteDatabase();
    await seedConfigStore(primary);
    await seedAclScopes(primary);
    for (const db of [primary, external]) {
      db.collection({
        name: 'documents',
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'name', type: 'string' },
          { name: 'tenantId', type: 'string' },
        ],
      });
      db.collection({
        name: 'tenants',
        timestamps: false,
        autoGenId: false,
        fields: [
          { name: 'id', type: 'string', primaryKey: true },
          { name: 'parentId', type: 'string' },
          { name: 'enabled', type: 'boolean' },
        ],
      });
      await db.sync();
      await db.getCollection('tenants').model.create({ id: 'B', enabled: db === external });
    }
    primaryDocs = primary.getCollection('documents');
    externalDocs = external.getCollection('documents');
    await primaryDocs.model.bulkCreate([
      { id: 3, name: 'Main owned', tenantId: 'B' },
      { id: 4, name: 'Main hidden', tenantId: 'C' },
    ]);
    await externalDocs.model.bulkCreate([
      { id: 101, name: 'Allowed', tenantId: 'B' },
      { id: 102, name: 'Blocked', tenantId: 'C' },
    ]);
    store = new AccessConfigStore(primary, (identity) => {
      const collection = identity.dataSourceKey === 'main' ? primaryDocs : externalDocs;
      return resolveModelMetadata(collection, { resolveCollectionKey: () => accessCollectionKey(identity) });
    });
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    await store.save(externalIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    primaryAdapter = new AccessAclScopeAdapter(new ACL(), 'main', store, primary);
    externalAdapter = new AccessAclScopeAdapter(new ACL(), 'external', store, external);
  });
  afterEach(async () => {
    await Promise.all([primary?.close(), external?.close()]);
  });

  async function configure(config: AccessConfig) {
    const current = (await store.read(externalIdentity))!;
    return store.save(externalIdentity, { ...config, revision: current.revision }, { userId: 28 });
  }
  const shared = () => ({
    ...configFor({
      type: 'compare' as const,
      operator: 'eq' as const,
      left: { type: 'field' as const, path: 'name' },
      right: { type: 'literal' as const, value: 'Allowed' },
    }),
    ownership: { enabled: false },
  });

  async function context(operation: Operation, side: 'main' | 'external' = 'external') {
    const db = side === 'main' ? primary : external;
    const adapter = side === 'main' ? primaryAdapter : externalAdapter;
    const identity = side === 'main' ? mainIdentity : externalIdentity;
    const acl = new ACL();
    acl.setAvailableAction(operation, {});
    acl.define({ role: actor.roleName }).grantAction(`documents:${operation}`, { fields: ['id', 'name'] });
    const resourcer = new Resourcer();
    resourcer.define({ name: 'documents', actions: { [operation]: {} } });
    const action = resourcer.getAction('documents', operation).clone();
    Object.assign(action, { resourceName: 'documents', actionName: operation });
    action.mergeParams({
      resourceName: 'documents',
      actionName: operation,
      filterByTk: undefined,
      ...(operation === 'list'
        ? { fields: ['id', 'name'], sort: 'id' }
        : operation === 'create'
          ? { values: { name: 'Allowed' } }
          : { filterByTk: 101, ...(operation === 'update' ? { values: { name: 'Changed' } } : {}) }),
    });
    const ctx = {
      db,
      action,
      permission: undefined as unknown,
      body: 'unchanged' as unknown,
      state: { currentRole: actor.roleName, currentUser: { id: actor.userId }, currentTenant: { id: actor.tenantId } },
      get: () => '+08:00',
      logger: { info: vi.fn() },
      throw: (status: number) => {
        throw new Error(String(status));
      },
    };
    await adapter.prepare(ctx, [identity]);
    await acl.middleware()(ctx as never, async () => {});
    return ctx;
  }
  async function execute(
    ctx: Awaited<ReturnType<typeof context>>,
    side: 'main' | 'external' = 'external',
    identity = side === 'main' ? mainIdentity : externalIdentity,
  ) {
    const db = side === 'main' ? primary : external;
    const adapter = side === 'main' ? primaryAdapter : externalAdapter;
    const queries = new AccessQueryService(db, adapter, () => accessCollectionKey(identity));
    try {
      if (ctx.action.actionName === 'list')
        await new AccessRootReadHandler(db, adapter, queries, () => identity).handleResourceWithRelatedContexts(
          ctx,
          actor,
          async () => null,
        );
      else
        await new AccessResourceMutationHandler(db, adapter, queries, () => identity).handle(ctx, actor, {
          read: async () => null,
          update: async () => null,
          source: async () => null,
        });
    } finally {
      primaryAdapter.release(ctx);
      externalAdapter.release(ctx);
    }
    return ctx.body;
  }
  const raw = async (collection: Collection) =>
    (await collection.model.findAll({ order: [['id', 'ASC']] })).map((record) => record.toJSON());

  it.each(['list', 'create', 'update', 'destroy'] as const)(
    'does not authorize external %s using a same-named external tenants table',
    async (operation) => {
      let writes = 0;
      if (operation !== 'list')
        externalDocs.model.addHook(
          operation === 'create' ? 'beforeCreate' : operation === 'update' ? 'beforeUpdate' : 'beforeDestroy',
          () => {
            writes++;
          },
        );
      const ctx = await context(operation);
      await expect(execute(ctx)).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
      expect(ctx.body).toBe('unchanged');
      expect(writes).toBe(0);
      expect(await raw(externalDocs)).toEqual([
        { id: 101, name: 'Allowed', tenantId: 'B' },
        { id: 102, name: 'Blocked', tenantId: 'C' },
      ]);
    },
  );

  it.each(['tenant-subject', 'hierarchy'] as const)(
    'rejects an unmanaged external %s rule without an authoritative tenant adapter',
    async (kind) => {
      const config = shared();
      if (kind === 'tenant-subject')
        config.rules[0].subject = {
          type: 'compare',
          operator: 'eq',
          left: { type: 'context', path: 'tenant.id' },
          right: { type: 'literal', value: 'B' },
        };
      else
        config.rules[0].condition = {
          type: 'tenantRelation',
          tenant: { type: 'field', path: 'tenantId' },
          relation: 'ancestor',
          includeSelf: true,
        };
      await configure(config);
      const ctx = await context('list');
      await expect(execute(ctx)).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
      expect(ctx.body).toBe('unchanged');
    },
  );

  it('rejects managed external ownership even when its rule has no tenant variable', async () => {
    await configure(configFor({ type: 'constant', value: true }));
    const ctx = await context('list');
    await expect(execute(ctx)).rejects.toMatchObject({ code: 'MISSING_ACCESS_CONTEXT' });
    expect(ctx.body).toBe('unchanged');
  });

  it('reads same-named main and external tables with their independent configurations', async () => {
    await primary.getCollection('tenants').model.update({ enabled: true }, { where: { id: 'B' } });
    await configure(shared());
    expect(await execute(await context('list', 'main'), 'main')).toMatchObject({
      rows: [{ id: 3, name: 'Main owned' }],
      count: 1,
    });
    expect(await execute(await context('list'))).toMatchObject({ rows: [{ id: 101, name: 'Allowed' }], count: 1 });
  });

  it.each(['create', 'update', 'destroy'] as const)(
    'keeps supported unmanaged external %s local to its own database',
    async (operation) => {
      await configure(shared());
      const ctx = await context(operation);
      await execute(ctx);
      expect(ctx.body).toEqual({ keys: [operation === 'create' ? 103 : 101], affected: 1 });
      if (operation === 'create')
        expect(await externalDocs.model.findByPk(103).then((row) => row?.toJSON())).toEqual({
          id: 103,
          name: 'Allowed',
          tenantId: null,
        });
      if (operation === 'update')
        expect(await externalDocs.model.findByPk(101).then((row) => row?.toJSON())).toEqual({
          id: 101,
          name: 'Changed',
          tenantId: 'B',
        });
      if (operation === 'destroy') expect(await externalDocs.model.findByPk(101)).toBeNull();
      expect(await raw(primaryDocs)).toEqual([
        { id: 3, name: 'Main owned', tenantId: 'B' },
        { id: 4, name: 'Main hidden', tenantId: 'C' },
      ]);
    },
  );

  it('supports unmanaged external tables without any tenant column or tenant identity table', async () => {
    await configure(shared());
    externalDocs.removeField('tenantId');
    await externalDocs.model.sync({ alter: true });
    external.removeCollection('tenants');
    expect(await execute(await context('list'))).toMatchObject({ rows: [{ id: 101, name: 'Allowed' }], count: 1 });
    expect(await execute(await context('update'))).toEqual({ keys: [101], affected: 1 });
    expect(await raw(externalDocs)).toEqual([
      { id: 101, name: 'Changed' },
      { id: 102, name: 'Blocked' },
    ]);
  });

  it.each(['disabled-tenant-rule', 'user-role'] as const)(
    'keeps an unmanaged %s rule independent of the inactive main tenant',
    async (kind) => {
      const config = shared();
      if (kind === 'disabled-tenant-rule')
        config.rules.push({
          ...configFor({ type: 'constant', value: true }).rules[0],
          id: 'disabled',
          enabled: false,
          subject: {
            type: 'compare',
            operator: 'eq',
            left: { type: 'context', path: 'tenant.id' },
            right: { type: 'literal', value: 'B' },
          },
        });
      else
        config.rules[0].subject = {
          type: 'all',
          children: [
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'context', path: 'user.id' },
              right: { type: 'literal', value: '28' },
            },
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'context', path: 'role.name' },
              right: { type: 'literal', value: 'editor' },
            },
          ],
        };
      await configure(config);
      external.removeCollection('tenants');
      expect(await execute(await context('list'))).toMatchObject({ rows: [{ id: 101, name: 'Allowed' }], count: 1 });
    },
  );

  it.each(['main', 'external'] as const)(
    'does not confuse the other same-named table after a %s configuration save',
    async (side) => {
      await configure(shared());
      await primary.getCollection('tenants').model.update({ enabled: true }, { where: { id: 'B' } });
      const identity = side === 'main' ? mainIdentity : externalIdentity;
      const current = (await store.read(identity))!;
      await store.save(identity, { ...current, rules: [] }, { userId: 28 });
      expect(await execute(await context('list', 'main'), 'main')).toMatchObject({
        rows: side === 'main' ? [] : [{ id: 3, name: 'Main owned' }],
      });
      expect(await execute(await context('list'))).toMatchObject({
        rows: side === 'external' ? [] : [{ id: 101, name: 'Allowed' }],
      });
    },
  );

  it('does not fall back to a configured main table when the external configuration is absent', async () => {
    await primary
      .getRepository('dataSourcesCollections')
      .update({ filterByTk: externalIdentity.collectionKey, values: { options: {} } });
    const ctx = await context('list');
    await expect(execute(ctx)).rejects.toThrow();
    expect(ctx.body).toBe('unchanged');
    expect((await store.read(mainIdentity))?.rules).toHaveLength(1);
  });

  it.each(['database', 'stable-key', 'data-source'] as const)(
    'rejects an external resource with the wrong %s identity',
    async (part) => {
      await configure(shared());
      const ctx = await context('list');
      if (part === 'database') ctx.db = primary;
      const identity = {
        ...externalIdentity,
        ...(part === 'stable-key' ? { collectionKey: mainIdentity.collectionKey } : {}),
        ...(part === 'data-source' ? { dataSourceKey: 'other' } : {}),
      };
      await expect(execute(ctx, 'external', identity)).rejects.toThrow();
      expect(ctx.body).toBe('unchanged');
    },
  );
});
