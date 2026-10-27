import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, Resourcer, type Collection, type Context } from '@tego/server';

import ErrorPlugin from '../../../../../module-error-handler/src/server';
import ImportPlugin from '../../../../../plugin-action-import/src/server';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootImportHandler } from '../../access-control/root-import-handler';
import type { AccessRootReadContext } from '../../access-control/root-read-context';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;
const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const xlsx = createRequire(new URL('../../../../../plugin-action-import/package.json', import.meta.url))('node-xlsx');

/** Real upload, plugin selection, finalized ACL and PostgreSQL; server fixture principals only. */
describe.skipIf(!coreAvailable || !postgresUrl)('tenant reference import over HTTP', () => {
  let app: MockServer;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let unregister: (() => void) | undefined;
  let principal: { tenantId: string; roleName: string; userId: number };
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: collection.name === 'documents' ? mainIdentity.collectionKey : `${collection.name}-key`,
  });
  const identities = () => ['documents', 'projects'].map((name) => identity(app.db.getCollection(name)));

  beforeEach(async () => {
    const isolated = isolatedPostgresDatabase(postgresUrl!);
    // One connection proves authorization preparation does not borrow another inside the file transaction.
    const database = { ...isolated.options, pool: { max: 1, acquire: 2500 } };
    await isolated.close();
    app = mockServer({ acl: false, registerActions: true, database, resourcer: { prefix: '/api' } });
    const errors = new ErrorPlugin(app, { name: 'test-errors' });
    await errors.beforeLoad();
    await errors.load();
    const db = app.db;
    await seedConfigStore(db);
    await seedAclScopes(db);
    db.collection({
      name: 'projects',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'name', type: 'string' },
        { name: 'tenantId', type: 'string' },
      ],
    });
    db.collection({
      name: 'documents',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'integer' },
        { name: 'tenantId', type: 'string' },
        { name: 'project', type: 'belongsTo', target: 'projects', foreignKey: 'projectId' },
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
    await db.sync();
    await db.getCollection('tenants').model.bulkCreate(['B', 'C'].map((id) => ({ id, enabled: true })));
    await db.getCollection('projects').model.bulkCreate([
      { id: 101, name: 'Owned', tenantId: 'B' },
      { id: 102, name: 'Visible', tenantId: 'H' },
      { id: 103, name: 'Hidden', tenantId: 'C' },
      { id: 104, name: 'Legacy', tenantId: null },
    ]);
    await db.getRepository('collections').create({ values: { name: 'projects', key: 'projects-key' } });
    store = new AccessConfigStore(db, (key) =>
      resolveModelMetadata(db.getCollection(key.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    await store.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    const config = configFor(ownerCondition);
    config.rules.push({
      ...configFor(
        {
          type: 'any',
          children: [
            {
              type: 'compare',
              operator: 'eq',
              left: { type: 'field', path: 'name' },
              right: { type: 'literal', value: 'Visible' },
            },
            { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
          ],
        },
        'visibility',
      ).rules[0],
      id: 'visible',
    });
    await store.save(identity(db.getCollection('projects')), { ...config, revision: 0 }, { userId: 28 });
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
    acl = new CoreACL();
    app.mainDataSource.acl = acl;
    acl.setAvailableAction('importXlsx', { type: 'new-data', allowConfigureFields: true });
    acl.setAvailableAction('list', {});
    acl.define({ role: 'importer' }).grantAction('documents:importXlsx', { fields: ['name', 'project', 'amount'] });
    acl.getRole('importer').grantAction('projects:list', { fields: ['id', 'name'] });
    acl.define({ role: 'creator' }).grantAction('documents:create', {});
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    unregister = adapter.register();
    principal = { tenantId: 'B', roleName: 'importer', userId: 28 };
    app.resourcer.use(
      async (ctx, next) => {
        ctx.state.currentRole = principal.roleName;
        ctx.state.currentTenant = { id: principal.tenantId };
        ctx.state.currentUser = { id: principal.userId };
        ctx.state.accessTestActor = { ...principal };
        await adapter.prepare(ctx, identities());
        try {
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'reference-import-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'reference-import-acl', after: 'reference-import-preparation' });
    const handler = new AccessRootImportHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
    const plugin = new ImportPlugin(app, {
      name: 'test-import',
      importResolver: () => async (ctx: Context & { permission: unknown }) => {
        const decisions: AccessRootReadContext[] = [];
        const authorize = async (collection: Collection) => {
          const router = new Resourcer();
          router.define({ name: collection.name, actions: { list: {} } });
          const action = router.getAction(collection.name, 'list').clone();
          Object.assign(action, { resourceName: collection.name, actionName: 'list' });
          action.mergeParams({ resourceName: collection.name, actionName: 'list' });
          const decision = {
            db,
            action,
            permission: undefined as unknown,
            state: ctx.state,
            get: ctx.get.bind(ctx),
            logger: ctx.logger,
            throw: ctx.throw.bind(ctx),
          };
          decisions.push(decision);
          await adapter.prepare(decision, identities());
          await acl.middleware()(decision as never, async () => {});
          return decision;
        };
        try {
          await handler.handle(
            ctx,
            ctx.state.accessTestActor,
            { buffer: ctx.file.buffer, columns: ctx.request.body.columns },
            authorize,
          );
        } finally {
          decisions.forEach((decision) => adapter.release(decision));
        }
      },
    });
    await plugin.beforeLoad();
    await plugin.load();
  });
  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    try {
      await app?.db.sequelize.drop({ cascade: true });
    } finally {
      await app?.destroy();
    }
  });
  const request = (
    data: unknown[][] = [
      ['Name', 'Project', 'Amount'],
      ['First', 'Visible', '12'],
      ['Second', 'Legacy', '23'],
    ],
  ) =>
    supertest(app.callback())
      .post('/api/documents:importXlsx')
      .set('x-tenant-id', 'C')
      .attach('file', xlsx.build([{ name: 'Import', data }]), { filename: 'import.xlsx' })
      .field(
        'columns',
        JSON.stringify([
          { dataIndex: ['name'], defaultTitle: 'Name' },
          { dataIndex: ['project', 'name'], defaultTitle: 'Project' },
          { dataIndex: ['amount'], defaultTitle: 'Amount' },
        ]),
      );
  const rows = async () =>
    (await app.db.getCollection('documents').model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get());

  it('commits visible and legacy references without changing their ownership', async () => {
    const before = (await app.db.getCollection('projects').model.findAll({ order: [['id', 'ASC']] })).map((row) =>
      row.get(),
    );
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ data: [], meta: { successCount: 2, failureCount: 0 } });
    expect(await rows()).toMatchObject([
      { name: 'First', projectId: 102, amount: 12, tenantId: 'B' },
      { name: 'Second', projectId: 104, amount: 23, tenantId: 'B' },
    ]);
    expect(
      (await app.db.getCollection('projects').model.findAll({ order: [['id', 'ASC']] })).map((row) => row.get()),
    ).toEqual(before);
  });
  it('does not substitute create permission for import permission', async () => {
    principal.roleName = 'creator';
    expect((await request()).status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('rejects an ungranted source association without falling back to the original importer', async () => {
    acl.getRole('importer').grantAction('documents:importXlsx', { fields: ['name', 'amount'] });
    expect((await request()).status).toBe(400);
    expect(await rows()).toEqual([]);
  });
  it('enforces the independent target role condition', async () => {
    acl.getRole('importer').grantAction('projects:list', { fields: ['id', 'name'], filter: { name: 'Owned' } });
    expect((await request()).status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('keeps the whole file empty when a later reference is hidden', async () => {
    const response = await request([
      ['Name', 'Project', 'Amount'],
      ['First', 'Visible', '12'],
      ['Second', 'Hidden', '23'],
    ]);
    expect(response.status).toBe(403);
    expect(await rows()).toEqual([]);
  });
  it('rolls back earlier inserts and propagates a later hook failure', async () => {
    app.db.getCollection('documents').model.addHook('beforeCreate', 'fail-upload', (row) => {
      if (row.get('name') === 'Second') throw new Error('Second reference import insert failed');
    });
    const response = await request();
    expect(response.status).toBe(500);
    expect(response.body.errors[0].message).toContain('Second reference import insert failed');
    expect(await rows()).toEqual([]);
  });
  it('cannot create sources using visibility alone', async () => {
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }, 'visibility'), revision: 1 },
      { userId: 28 },
    );
    expect((await request()).status).toBe(403);
    expect(await rows()).toEqual([]);
  });
});
