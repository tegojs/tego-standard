import { pathToFileURL } from 'node:url';
import { ACL, assign, FilterParser, literal, Op, Resourcer, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { compileAccessScopes } from '../../access-control/compile';
import { accessCollectionKey } from '../../access-control/config-store';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { grantStoredScope, seedAclScopes } from './acl-database';
import { configStore, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { seedDatabase, sqliteDatabase } from './database';
import { documents, exampleConfig, quoteIdentifier } from './fixtures';

const coreFactoryEntry = process.env.TENANT_ACCESS_CORE_ACL_FACTORY_ENTRY;
const coreAvailable = coreFactoryEntry || 'registerActionParamsResolver' in ACL.prototype;

// An optional built core factory allows contract validation without dependency changes.
describe.skipIf(!coreAvailable)('tenant scope adapter with the resolving core ACL', () => {
  let db: Database;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: ReturnType<typeof configStore>;
  let unregister: () => void;

  beforeEach(async () => {
    const createACL = coreFactoryEntry
      ? (await import(/* @vite-ignore */ pathToFileURL(coreFactoryEntry).href)).createACL
      : () => new ACL();
    db = sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    await seedDatabase(db);
    db.collection({
      name: 'documents',
      tableName: 'access_documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'amount', type: 'integer' },
        { name: 'name', type: 'string' },
      ],
    });
    db.collection({
      name: 'participants',
      tableName: 'access_participants',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'documentId', type: 'integer', field: 'document_id' },
        { name: 'businessTenant', type: 'string', field: 'business_tenant' },
        { name: 'canView', type: 'boolean', field: 'can_view' },
      ],
    });
    db.getCollection('documents').setField('participants', {
      type: 'hasMany',
      target: 'participants',
      foreignKey: 'documentId',
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
    await tenants.model.bulkCreate([
      { id: 'H', enabled: true },
      { id: 'B', parentId: 'H', enabled: true },
      { id: 'C', parentId: 'H', enabled: true },
    ]);
    store = configStore(db);
    acl = createACL();
    await grantStoredScope(db, acl);
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    unregister = adapter.register();
  });
  afterEach(async () => {
    unregister?.();
    await db?.close();
  });

  async function prepare() {
    await store.save(mainIdentity, { ...exampleConfig, revision: 0 }, { userId: 28 });
    const ctx = { state: { currentTenant: { id: 'B' } }, get: () => '+08:00' };
    await adapter.prepare(ctx, [mainIdentity]);
    return ctx;
  }

  async function ids(ctx: object, action: string, requestFilter: object = {}) {
    const permission = acl.can({ role: 'member', resource: 'documents', action, ctx });
    if (!permission) return null;
    const params = await acl.parseJsonTemplate(assign({ filter: requestFilter }, permission.params), ctx as never);
    const plan = compileAccessScopes(adapter.configuration(ctx, mainIdentity), {
      collection: documents,
      context: { 'tenant.id': 'B' },
      quoteIdentifier,
      rootAlias: 'documents',
    });
    const scope = action === 'list' || action === 'get' ? plan.read : plan.ownership;
    const parsed = new FilterParser(params.filter, { collection: db.getCollection('documents') }).toSequelizeParams();
    const rows = await db.getCollection('documents').model.findAll({
      attributes: ['id'],
      where: { [Op.and]: [parsed.where, literal(scope.sql)] },
      bind: scope.bind,
      raw: true,
      order: [['id', 'ASC']],
    });
    return rows.map((row) => row.id);
  }

  it('expands read by V but preserves G for writes and denies ungranted operations', async () => {
    const scope = await db.getRepository('dataSourcesRolesResourcesScopes').findOne({ filter: { key: 'tenant' } });
    const update = await db.getRepository('dataSourcesRolesResourcesScopesActions').create({
      values: { name: 'update', fields: ['name'], scopeId: scope.get('id') },
    });
    await update.writeToACL({
      acl,
      role: acl.getRole('member'),
      resourceName: 'documents',
      associationFieldsActions: {},
      grantHelper: {},
    });
    const ctx = await prepare();
    expect(await ids(ctx, 'list')).toEqual([1, 3]);
    expect(await ids(ctx, 'update')).toEqual([3]);
    expect(await ids(ctx, 'destroy')).toBeNull();
    expect(acl.can({ role: 'member', resource: 'documents', action: 'update', ctx }).params.whitelist).toEqual([
      'name',
    ]);
    expect(acl.can({ role: 'member', resource: 'documents', action: 'list', ctx }).params.fields).toEqual([
      'id',
      'name',
    ]);
  });

  it('retains fixed tenant filters and request filters after scope delegation', async () => {
    const fixed = vi.fn(() => ({ filter: { tenantId: 'H' }, fields: ['id'] }));
    acl.addFixedParams('documents', 'list', fixed);
    const ctx = await prepare();
    expect(await ids(ctx, 'list')).toEqual([1]);
    expect(fixed).toHaveBeenCalledTimes(1);
    expect(await ids(ctx, 'list', { name: 'D3' })).toEqual([]);
    expect(acl.can({ role: 'member', resource: 'documents', action: 'list', ctx }).params.fields).toEqual(['id']);
  });

  it('keeps custom ACL scope restrictions even when the tenant model would allow more', async () => {
    await grantStoredScope(db, acl, { key: 'custom', scope: { amount: { $gte: 200 } } });
    const ctx = await prepare();
    expect(await ids(ctx, 'list')).toEqual([3]);
    expect(await ids(ctx, 'list', { name: 'D1' })).toEqual([]);
  });

  it('leaves unprepared requests on their existing role scope and restores it after unregistering', async () => {
    const ctx = await prepare();
    expect(acl.can({ role: 'member', resource: 'documents', action: 'list', ctx }).params.filter).toBeUndefined();
    expect(acl.can({ role: 'member', resource: 'documents', action: 'list' }).params.filter).toBeDefined();
    unregister();
    expect(acl.can({ role: 'member', resource: 'documents', action: 'list', ctx }).params.filter).toBeDefined();
  });

  it('does not authorize any records for an explicitly empty new configuration', async () => {
    await store.save(mainIdentity, { ...initialConfig(), rules: [] }, { userId: 28 });
    const ctx = { state: { currentTenant: { id: 'B' } }, get: () => '+08:00' };
    await adapter.prepare(ctx, [mainIdentity]);
    expect(await ids(ctx, 'list')).toEqual([]);
  });

  /** Prepare the same context before ACL merges scopes, then use its finalized permission unchanged. */
  async function readContext(actionName: string, params: Record<string, unknown> = {}) {
    const resourcer = new Resourcer();
    resourcer.define({ name: 'documents', actions: { [actionName]: {} } });
    const action = resourcer.getAction('documents', actionName).clone();
    Object.assign(action, { resourceName: 'documents', actionName });
    action.params.filterByTk = undefined;
    action.mergeParams({ resourceName: 'documents', actionName, ...params });
    const ctx = {
      db,
      action,
      state: { currentRole: 'member', currentTenant: { id: 'B' } },
      getCurrentRepository: () => ({ targetCollection: db.getCollection('documents') }),
      get: () => '+08:00',
      logger: { info: vi.fn() },
      throw: (status: number) => {
        throw new Error(String(status));
      },
      permission: undefined as unknown,
      body: 'unchanged' as unknown,
      paginate: false,
    };
    await adapter.prepare(ctx, [mainIdentity]);
    return ctx;
  }

  async function read(ctx: Awaited<ReturnType<typeof readContext>>) {
    const queries = new AccessQueryService(db, adapter, (collection) =>
      accessCollectionKey(
        collection.name === 'documents'
          ? mainIdentity
          : { ...mainIdentity, collectionName: collection.name, collectionKey: `${collection.name}-key` },
      ),
    );
    const handler = new AccessRootReadHandler(db, adapter, queries, (collection) =>
      collection.name === 'documents' ? mainIdentity : undefined,
    );
    const related = vi.fn(async () => null);
    await acl.middleware()(ctx as never, () =>
      handler.handleResourceWithRelatedContexts(ctx, { tenantId: 'B', userId: 28, roleName: 'member' }, related),
    );
    expect(related).not.toHaveBeenCalled();
    return ctx.body;
  }

  it.each([
    ['list', { fields: ['id'], sort: 'id' }, { rows: [{ id: 1 }, { id: 3 }], count: 2 }],
    ['get', { fields: ['id'], filterByTk: 1 }, { id: 1 }],
    ['count', {}, 2],
  ])('applies delegated G/V to the finalized %s handler', async (action, params, expected) => {
    await prepare();
    acl.setAvailableAction('view', { aliases: ['get', 'list', 'count'] });
    const ctx = await readContext(action as string, params as Record<string, unknown>);
    const result = await read(ctx);
    if (action === 'list') expect(result).toMatchObject(expected as object);
    else expect(result).toEqual(expected);
    expect(ctx.paginate).toBe(action === 'list');
  });

  it('retains request and fixed conditions in the finalized handler without duplicating permission evaluation', async () => {
    await prepare();
    const fixed = vi.fn(() => ({ filter: { tenantId: 'H' }, fields: ['id'] }));
    acl.addFixedParams('documents', 'list', fixed);
    const ctx = await readContext('list', { filter: { id: 3 } });
    expect(await read(ctx)).toMatchObject({ rows: [], count: 0 });
    expect(fixed).toHaveBeenCalledTimes(1);
  });

  it('retains field restrictions in the finalized handler', async () => {
    await prepare();
    acl.addFixedParams('documents', 'list', () => ({ fields: ['id'] }));
    const ctx = await readContext('list', { filter: { name: 'D1' } });
    await expect(read(ctx)).rejects.toThrow('Request filter field is not authorized: name');
    expect(ctx.body).toBe('unchanged');
  });

  it('retains a custom role condition in the finalized handler', async () => {
    await grantStoredScope(db, acl, { key: 'custom', scope: { amount: { $gte: 200 } } });
    await prepare();
    const ctx = await readContext('list', { fields: ['id'], sort: 'id' });
    expect(await read(ctx)).toMatchObject({ rows: [{ id: 3 }], count: 1 });
  });

  it('does not use G/V to grant a missing operation in the finalized handler', async () => {
    await prepare();
    acl.setAvailableAction('count', {});
    const ctx = await readContext('count');
    await expect(read(ctx)).rejects.toThrow('403');
    expect(ctx.body).toBe('unchanged');
  });

  it('does not publish a finalized handler result after its preparation phase ends', async () => {
    await prepare();
    const ctx = await readContext('list', { fields: ['id'] });
    adapter.release(ctx);
    await expect(read(ctx)).rejects.toThrow();
    expect(ctx.body).toBe('unchanged');
  });
});
