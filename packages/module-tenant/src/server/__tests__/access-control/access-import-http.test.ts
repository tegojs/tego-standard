import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, type Collection, type Context } from '@tego/server';

import ErrorPlugin from '../../../../../module-error-handler/src/server';
import ImportPlugin from '../../../../../plugin-action-import/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootImportHandler } from '../../access-control/root-import-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;
const xlsx = createRequire(new URL('../../../../../plugin-action-import/package.json', import.meta.url))('node-xlsx');

/** Real multipart, selected plugin executor and final ACL; fixture principals are server supplied. */
describe.skipIf(!coreAvailable)('tenant scalar import over HTTP', () => {
  let app: MockServer;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let acl: ACL;
  let unregister: (() => void) | undefined;
  let principal: { tenantId: string; roleName: string; userId: number };
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: collection.name === 'documents' ? mainIdentity.collectionKey : `${collection.name}-key`,
  });

  beforeEach(async () => {
    app = mockServer({
      acl: false,
      registerActions: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      resourcer: { prefix: '/api' },
    });
    const errors = new ErrorPlugin(app, { name: 'test-errors' });
    await errors.beforeLoad();
    await errors.load();
    const db = app.db;
    await seedConfigStore(db);
    await seedAclScopes(db);
    db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'integer' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.getCollection('documents').model.sync();
    await db.getCollection('tenants').model.sync();
    await db.getCollection('tenants').model.bulkCreate(['B', 'C'].map((id) => ({ id, enabled: true })));
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
    acl = new CoreACL();
    app.mainDataSource.acl = acl;
    acl.setAvailableAction('importXlsx', { type: 'new-data', allowConfigureFields: true });
    acl.define({ role: 'importer' }).grantAction('documents:importXlsx', { fields: ['name', 'amount'] });
    acl.define({ role: 'creator' }).grantAction('documents:create', {});
    store = new AccessConfigStore(db, (key) =>
      resolveModelMetadata(db.getCollection(key.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    unregister = adapter.register();
    principal = { tenantId: 'B', roleName: 'importer', userId: 28 };
    app.resourcer.use(
      async (ctx, next) => {
        ctx.state.currentRole = principal.roleName;
        ctx.state.accessTestActor = { ...principal };
        await adapter.prepare(ctx, [mainIdentity]);
        try {
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'access-import-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'access-import-acl', after: 'access-import-preparation' });
    const handler = new AccessRootImportHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
    const plugin = new ImportPlugin(app, {
      name: 'test-import',
      importResolver: () => async (ctx: Context & { permission: unknown }) =>
        handler.handle(ctx, ctx.state.accessTestActor, { buffer: ctx.file.buffer, columns: ctx.request.body.columns }),
    });
    await plugin.beforeLoad();
    await plugin.load();
  });
  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });
  const request = (
    data: unknown[][] = [
      ['Name', 'Amount'],
      ['First', '12'],
      ['Second', '23'],
    ],
    fields = ['name', 'amount'],
  ) =>
    supertest(app.callback())
      .post('/api/documents:importXlsx')
      .set('x-tenant-id', 'C')
      .attach('file', xlsx.build([{ name: 'Import', data }]), { filename: 'import.xlsx' })
      .field(
        'columns',
        JSON.stringify(
          fields.map((name, index) => ({ dataIndex: name.split('.'), defaultTitle: ['Name', 'Amount'][index] })),
        ),
      )
      .field('explain', 'Upload explanation');
  const rows = async () =>
    (await app.db.getCollection('documents').model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());

  it('returns the page import protocol only after committed G-authorized rows', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: [], meta: { successCount: 2, failureCount: 0 } });
    expect(await rows()).toMatchObject([
      { name: 'First', amount: 12, tenantId: 'B' },
      { name: 'Second', amount: 23, tenantId: 'B' },
    ]);
  });
  it('rejects create-only roles instead of using their create permission for import', async () => {
    principal.roleName = 'creator';
    const response = await request();
    expect(response.status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('rejects unauthorized mappings without falling back to the original importer', async () => {
    acl.getRole('importer').grantAction('documents:importXlsx', { fields: ['name'] });
    const response = await request();
    expect(response.status).toBe(400);
    expect(response.body.errors[0].message).toContain('unauthorized');
    expect(await rows()).toEqual([]);
  });
  it('rejects V-only imports and rolls back the physical rows', async () => {
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }, 'visibility'), revision: 1 },
      { userId: 28 },
    );
    const response = await request();
    expect(response.status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('rolls back the entire upload when a later insert fails', async () => {
    app.db.getCollection('documents').model.addHook('beforeCreate', 'reject-import', (row) => {
      if (row.get('name') === 'Second') throw new Error('Import hook failed');
    });
    const response = await request();
    expect(response.status).toBe(500);
    expect(response.body.errors[0].message).toContain('Import hook failed');
    expect(await rows()).toEqual([]);
  });
  it('rejects bad cell conversion instead of persisting valid earlier rows', async () => {
    const response = await request([
      ['Name', 'Amount'],
      ['First', 12],
      ['Second', 'invalid'],
    ]);
    expect(response.status).toBe(400);
    expect(response.body.errors[0].message).toContain('Import row 3, Amount');
    expect(await rows()).toEqual([]);
  });
});
