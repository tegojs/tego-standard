import { pathToFileURL } from 'node:url';
import { ACL, assign, FilterParser, literal, Op, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { compileAccessScopes } from '../../access-control/compile';
import { grantStoredScope, seedAclScopes } from './acl-database';
import { configStore, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { seedDatabase, sqliteDatabase } from './database';
import { documents, exampleConfig, quoteIdentifier } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;

// An optional local draft core entry allows contract validation without dependency changes.
describe.skipIf(!coreAvailable)('tenant scope adapter with the resolving core ACL', () => {
  let db: Database;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: ReturnType<typeof configStore>;
  let unregister: () => void;

  beforeEach(async () => {
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
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
    store = configStore(db);
    acl = new CoreACL();
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
});
