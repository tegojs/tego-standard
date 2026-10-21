import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { ACL, RelationField, Resourcer, type Collection, type Context } from '@tego/server';

import ExportPlugin from '../../../../../plugin-action-export/src/server';
import {
  createExportXlsx,
  type ExportXlsxResolver,
} from '../../../../../plugin-action-export/src/server/actions/export-entry';
import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import type { AccessRelatedReadAuthorizer } from '../../access-control/related-read-contexts';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { seedDatabase } from './database';
import { configFor, exampleConfig } from './fixtures';

const coreEntry = process.env.TENANT_ACCESS_CORE_ACL_ENTRY;
const coreAvailable = coreEntry || 'registerActionParamsResolver' in ACL.prototype;
const xlsx = createRequire(new URL('../../../../../plugin-action-export/package.json', import.meta.url))(
  'node-xlsx',
) as {
  parse(data: Buffer): Array<{ data: unknown[][] }>;
};

/** Internal export rows over real HTTP/ACL; no production authentication or XLSX activation. */
describe.skipIf(!coreAvailable)('export rows over real HTTP resources', () => {
  let app: MockServer;
  let acl: ACL;
  let adapter: AccessAclScopeAdapter;
  let store: AccessConfigStore;
  let unregister: (() => void) | undefined;
  let principal: { tenantId: string; roleName: string; userId: number };
  let beforeRelated: (() => Promise<void>) | undefined;
  let beforeFileRead: ((ctx: Context & { permission: unknown }) => Promise<void>) | undefined;
  let exportEntry: ReturnType<typeof createExportXlsx> | undefined;
  let read: (ctx: Context & { permission: unknown }) => Promise<void>;
  let readFile: (
    ctx: Context & { permission: unknown },
  ) => ReturnType<AccessRootReadHandler['readExportWithRelatedContexts']>;
  let exportFile: (ctx: Context & { permission: unknown }) => Promise<void>;
  const identity = (collection: Collection) => ({
    ...mainIdentity,
    collectionName: collection.name,
    collectionKey: `${collection.name}-key`,
  });
  const identities = () => ['documents', 'participants'].map((name) => identity(app.db.getCollection(name)));

  async function grant(resource: string, action: string, fields: string[], filter: object = {}) {
    const scope = await app.db.getRepository('dataSourcesRolesResourcesScopes').create({
      values: { key: 'custom', dataSourceKey: 'main', resourceName: resource, scope: filter },
    });
    const stored = await app.db.getRepository('dataSourcesRolesResourcesScopesActions').create({
      values: { name: action, fields, scopeId: scope.get('id') },
    });
    await stored.writeToACL({
      acl,
      role: acl.getRole('reader'),
      resourceName: resource,
      associationFieldsActions: {},
      grantHelper: {},
    });
  }

  beforeEach(async () => {
    beforeRelated = undefined;
    beforeFileRead = undefined;
    exportEntry = undefined;
    app = mockServer({
      acl: false,
      registerActions: true,
      database: { dialect: 'sqlite', storage: ':memory:' },
      resourcer: { prefix: '/api' },
    });
    const db = app.db;
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
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'integer' },
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
    db.collection({
      name: 'tenants',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.getCollection('tenants').model.sync();
    await db.getCollection('tenants').model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    const CoreACL = coreEntry ? (await import(/* @vite-ignore */ pathToFileURL(coreEntry).href)).ACL : ACL;
    acl = new CoreACL();
    app.mainDataSource.acl = acl;
    acl.setAvailableAction('export', {});
    acl.setAvailableAction('list', {});
    acl.define({ role: 'reader' });
    acl.beforeGrantAction((ctx) => {
      const collection = db.getCollection(ctx.resourceName);
      const fields = ctx.params.fields as string[] | undefined;
      if (!collection || !fields) return;
      const appends = fields.filter((name) => collection.getField(name) instanceof RelationField);
      ctx.params = { ...ctx.params, fields: fields.filter((name) => !appends.includes(name)), appends };
    });
    await grant('documents', 'export', ['id', 'name', 'amount', 'participants']);
    await grant('documents', 'list', ['id'], { id: 3 });
    await grant('participants', 'list', ['id', 'businessTenant', 'canView']);
    store = new AccessConfigStore(db, (key) =>
      resolveModelMetadata(db.getCollection(key.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    await store.save(mainIdentity, { ...exampleConfig, revision: 0 }, { userId: 28 });
    await db.getRepository('collections').create({ values: { key: 'participants-key', name: 'participants' } });
    await store.save(
      identity(db.getCollection('participants')),
      {
        ...configFor({
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'canView' },
          right: { type: 'literal', value: true },
        }),
        revision: 0,
        ownership: { enabled: false },
      },
      { userId: 28 },
    );
    adapter = new AccessAclScopeAdapter(acl, 'main', store, db);
    unregister = adapter.register();
    const reader = new AccessRootReadHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
    principal = { tenantId: 'B', roleName: 'reader', userId: 28 };
    app.resourcer.use(
      async (ctx, next) => {
        ctx.state.currentRole = principal.roleName;
        ctx.state.currentTenant = { id: principal.tenantId };
        ctx.state.accessTestActor = { ...principal };
        await adapter.prepare(ctx, identities());
        try {
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'access-export-preparation', after: 'auth' },
    );
    app.resourcer.use(acl.middleware(), { tag: 'access-export-acl', after: 'access-export-preparation' });
    const withRelated = async <T>(
      resourceContext: Context & { permission: unknown },
      execute: (authorize: AccessRelatedReadAuthorizer) => Promise<T>,
    ) => {
      const decisions: Array<Context & { permission: unknown }> = [];
      try {
        return await execute(async (collection) => {
          await beforeRelated?.();
          const resourcer = new Resourcer();
          resourcer.define({ name: collection.name, actions: { list: {} } });
          const target = resourcer.getAction(collection.name, 'list').clone();
          Object.assign(target, { resourceName: collection.name, actionName: 'list' });
          target.mergeParams({ resourceName: collection.name, actionName: 'list', filterByTk: undefined });
          const ctx = Object.assign(Object.create(resourceContext), { action: target, permission: undefined });
          decisions.push(ctx);
          await adapter.prepare(ctx, identities());
          await acl.middleware()(ctx, async () => {});
          return ctx;
        });
      } finally {
        for (const decision of decisions) adapter.release(decision);
      }
    };
    read = (ctx) =>
      withRelated(ctx, (authorize) =>
        reader.handleResourceWithRelatedContexts(ctx, ctx.state.accessTestActor, authorize),
      );
    readFile = (ctx) =>
      withRelated(ctx, (authorize) => reader.readExportWithRelatedContexts(ctx, ctx.state.accessTestActor, authorize));
    exportFile = (ctx) =>
      withRelated(ctx, (authorize) =>
        reader.handleExportWithRelatedContexts(ctx, ctx.state.accessTestActor, authorize),
      );
    app.resourcer.define({
      name: 'documents',
      actions: Object.fromEntries(
        ['list', 'export'].map((action) => [
          action,
          async (ctx: Context & { permission: unknown }, next) => {
            if (action === 'export' && exportEntry) await exportEntry(ctx, next);
            else await read(ctx);
          },
        ]),
      ),
    });
  });

  afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await app?.destroy();
  });

  const runExport = (params: Record<string, unknown> = {}) =>
    app
      .agent()
      .resource('documents')
      .export({ fields: ['id'], sort: ['id'], ...params });

  /** The caller chooses file rendering; the prepared read handler owns row authorization. */
  async function scopedFile(ctx: Context & { permission: unknown }) {
    await beforeFileRead?.(ctx);
    await exportFile(ctx);
  }

  function fileRequest(params: Record<string, unknown> = {}) {
    const { fields = ['id'], sort = ['id'], columns = ['id'], filter, ...rest } = params;
    return supertest(app.callback())
      .get('/api/documents:export')
      .query({
        title: 'Scoped export',
        ...rest,
        'fields[]': fields,
        'sort[]': sort,
        columns: JSON.stringify(columns),
        ...(filter === undefined ? {} : { filter: JSON.stringify(filter) }),
      })
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => done(null, Buffer.concat(chunks)));
        response.on('error', done);
      });
  }

  function pageFileRequest(body: Record<string, unknown>, query: Record<string, unknown> = {}) {
    return supertest(app.callback())
      .post('/api/documents:export')
      .query({ title: '页面导出', sort: 'id', ...query })
      .send(body)
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => done(null, Buffer.concat(chunks)));
        response.on('error', done);
      });
  }

  async function duringNameFormatting(change: (ctx: Context & { permission: unknown }) => Promise<void>) {
    const schemas = app.db.collection({
      name: 'uiSchemas',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'uid', type: 'string', primaryKey: true },
        { name: 'enum', type: 'json' },
      ],
    });
    await schemas.model.sync();
    await schemas.repository.create({
      values: {
        uid: 'export-names',
        enum: [
          { value: 'D1', label: 'First' },
          { value: 'D3', label: 'Third' },
        ],
      },
    });
    app.db.getCollection('documents').setField('name', {
      type: 'string',
      interface: 'select',
      uiSchemaUid: 'export-names',
    });
    let active: Context & { permission: unknown };
    beforeFileRead = async (ctx) => {
      active = ctx;
    };
    const repository = schemas.repository;
    const findById = repository.findById;
    // Preserve the real metadata read and change the lifecycle while the formatter is suspended.
    return vi.spyOn(repository, 'findById').mockImplementationOnce(async function (...args) {
      const schema = await findById.apply(this, args);
      await change(active);
      return schema;
    });
  }

  describe('page export request adaptation', () => {
    beforeEach(async () => {
      app.resourcer.define({ name: 'documents', actions: { export: {} } });
      await registerExportPlugin({ exportResolver: () => scopedFile });
    });

    it('exports requested nested columns from the real page POST without explicit fields', async () => {
      const response = await pageFileRequest(
        {
          columns: [
            { dataIndex: ['id'], title: '编号' },
            { dataIndex: ['participants', 'id'], title: '参与方' },
          ],
        },
        { appends: 'participants', filter: JSON.stringify({ id: 1 }) },
      );
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toContain(encodeURI('页面导出_B.xlsx'));
      expect(xlsx.parse(response.body)[0].data).toEqual([
        ['编号', '参与方'],
        [1, '1,2'],
      ]);
    });

    it('uses the original prepared rule snapshot and loads changed rules only on the next request', async () => {
      beforeFileRead = async () => {
        beforeFileRead = undefined;
        const config = (await store.read(mainIdentity))!;
        await store.save(mainIdentity, { ...config, rules: [] }, { userId: 28 });
      };
      const response = await pageFileRequest({ columns: ['id'] });
      expect(response.status).toBe(200);
      expect(xlsx.parse(response.body)[0].data).toEqual([['id'], [1], [3]]);
      const next = await pageFileRequest({ columns: ['id'] });
      expect(next.status).toBe(200);
      expect(xlsx.parse(next.body)[0].data).toEqual([['id']]);
    });

    it('cannot resurrect a request whose prepared phase has already ended', async () => {
      beforeFileRead = async (ctx) => adapter.release(ctx);
      const response = await pageFileRequest({ columns: ['id'] });
      expect(response.status).toBe(400);
      expect(response.headers).not.toHaveProperty('content-disposition');
    });

    it('does not publish a file after the original phase ends during related authorization', async () => {
      beforeFileRead = async (ctx) => {
        beforeRelated = async () => adapter.release(ctx);
      };
      const response = await pageFileRequest({ columns: [{ dataIndex: ['participants', 'id'] }] });
      expect(response.status).toBe(400);
      expect(response.headers).not.toHaveProperty('content-disposition');
    });

    it('does not publish a file when its prepared phase ends during cell formatting', async () => {
      const formatting = await duringNameFormatting(async (ctx) => adapter.release(ctx));
      try {
        const response = await pageFileRequest({ columns: ['name'] });
        expect(response.status).toBe(400);
        expect(response.headers).not.toHaveProperty('content-disposition');
      } finally {
        formatting.mockRestore();
      }
    });

    it('does not publish a file when its prepared phase is replaced during cell formatting', async () => {
      const formatting = await duringNameFormatting(async (ctx) => {
        adapter.release(ctx);
        await adapter.prepare(ctx, identities());
      });
      try {
        const response = await pageFileRequest({ columns: ['name'] });
        expect(response.status).toBe(400);
        expect(response.headers).not.toHaveProperty('content-disposition');
      } finally {
        formatting.mockRestore();
      }
    });

    it('rechecks participating association metadata after asynchronous cell formatting', async () => {
      const formatting = await duringNameFormatting(async () => {
        Object.assign(app.db.getCollection('documents').model.associations.participants, { scope: { canView: false } });
      });
      try {
        const response = await pageFileRequest({ columns: ['name', { dataIndex: ['participants', 'id'] }] });
        expect(response.status).toBe(400);
        expect(response.headers).not.toHaveProperty('content-disposition');
      } finally {
        formatting.mockRestore();
      }
    });

    it('keeps the real response untouched until the rendered file passes its final lifecycle check', async () => {
      const formatting = await duringNameFormatting(async (ctx) => adapter.release(ctx));
      const original = { marker: 'not a file' };
      let observed: { body: unknown; disposition: string } | undefined;
      await registerExportPlugin({
        exportResolver: () => async (ctx: Context & { permission: unknown }) => {
          ctx.body = original;
          try {
            await scopedFile(ctx);
          } catch (error) {
            observed = { body: ctx.body, disposition: ctx.response.get('content-disposition') };
            throw error;
          }
        },
      });
      try {
        const response = await pageFileRequest({ columns: ['name'] });
        expect(response.status).toBe(400);
        expect(observed?.body).toBe(original);
        expect(observed?.disposition).toBe('');
        expect(response.headers).not.toHaveProperty('content-disposition');
      } finally {
        formatting.mockRestore();
      }
    });

    it('preserves the original formatting failure without publishing a partial file', async () => {
      const failure = new Error('Formatting metadata failed');
      const formatting = await duringNameFormatting(async () => {
        throw failure;
      });
      let caught: unknown;
      await registerExportPlugin({
        exportResolver: () => async (ctx: Context & { permission: unknown }) => {
          try {
            await scopedFile(ctx);
          } catch (error) {
            caught = error;
            throw error;
          }
        },
      });
      try {
        const response = await pageFileRequest({ columns: ['name'] });
        expect(caught).toBe(failure);
        expect(response.status).toBe(500);
        expect(response.headers).not.toHaveProperty('content-disposition');
      } finally {
        formatting.mockRestore();
      }
    });

    it('captures the file timezone before asynchronous related authorization', async () => {
      await app.db.sequelize.query('ALTER TABLE access_documents ADD COLUMN occurred_at DATETIME');
      app.db.getCollection('documents').setField('occurredAt', {
        type: 'date',
        field: 'occurred_at',
        interface: 'datetime',
        uiSchema: {
          'x-component-props': { dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm:ss', showTime: true },
        },
      });
      await app.db.getCollection('documents').model.update(
        { occurredAt: new Date('2026-10-21T00:00:00Z') },
        {
          where: { id: 1 },
        },
      );
      await grant('documents', 'export', ['id', 'occurredAt', 'participants']);
      beforeFileRead = async (ctx) => {
        beforeRelated = async () => {
          ctx.req.headers['x-timezone'] = '+00:00';
        };
      };
      const response = await pageFileRequest(
        { columns: [{ dataIndex: ['occurredAt'] }, { dataIndex: ['participants', 'id'] }] },
        { filter: JSON.stringify({ id: 1 }) },
      ).set('x-timezone', '+08:00');
      expect(response.status).toBe(200);
      expect(xlsx.parse(response.body)[0].data).toEqual([
        ['occurredAt', 'id'],
        ['2026-10-21 08:00:00', '1,2'],
      ]);
    });

    it('captures file options, final permission and filename tenant before related authorization', async () => {
      beforeFileRead = async (ctx) => {
        beforeRelated = async () => {
          const permission = ctx.permission as {
            rawParams: { title: string; values: { columns: Array<{ dataIndex: string[] }> } };
            parsedParams: { filter: unknown };
          };
          permission.rawParams.title = 'Changed title';
          permission.rawParams.values.columns[0].dataIndex[0] = 'amount';
          permission.parsedParams.filter = { id: 4 };
          ctx.state.accessTestActor.tenantId = 'C';
        };
      };
      const response = await pageFileRequest({
        columns: [{ dataIndex: ['id'] }, { dataIndex: ['participants', 'id'] }],
      });
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toContain(encodeURI('页面导出_B.xlsx'));
      expect(xlsx.parse(response.body)[0].data).toEqual([
        ['id', 'id'],
        [1, '1,2'],
        [3, ''],
      ]);
    });

    it('returns authorized rows without writing an intermediate HTTP body', async () => {
      await registerExportPlugin({
        exportResolver: () => async (ctx: Context & { permission: unknown }) => {
          const originalBody = ctx.body;
          const result = await readFile(ctx);
          ctx.body = { unchanged: ctx.body === originalBody, rows: result.data, tenant: result.tenantId };
        },
      });
      const response = await pageFileRequest({ columns: ['id'] });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body.toString())).toEqual({
        data: [{ id: 1 }, { id: 3 }],
        meta: { unchanged: true, tenant: 'B' },
      });
    });

    it('does not export a forbidden column merely because fields only requests a permitted one', async () => {
      await grant('documents', 'export', ['id']);
      const response = await pageFileRequest({ columns: ['amount'] }, { 'fields[]': ['id'] });
      expect(response.status).toBe(400);
      expect(response.headers).not.toHaveProperty('content-disposition');
    });

    it('checks the related permission needed only by a POST column', async () => {
      acl.getRole('reader').revokeAction('participants:list');
      const response = await pageFileRequest({ columns: [{ dataIndex: ['participants', 'id'] }] });
      expect(response.status).toBe(403);
      expect(response.headers).not.toHaveProperty('content-disposition');
    });

    it('uses body columns and query title with the existing exporter precedence', async () => {
      const response = await pageFileRequest(
        { columns: [{ dataIndex: ['amount'], defaultTitle: '金额' }], title: 'Body title' },
        { columns: JSON.stringify(['id']), filter: JSON.stringify({ id: 3 }) },
      );
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toContain(encodeURI('页面导出_B.xlsx'));
      expect(xlsx.parse(response.body)[0].data).toEqual([['金额'], [300]]);
    });

    it.each([
      { columns: ['id'], tenantId: 'C' },
      { columns: ['id'], permission: { skip: true } },
    ])('rejects unsupported body values rather than discarding them: %j', async (body) => {
      const response = await pageFileRequest(body);
      expect(response.status).toBe(400);
      expect(response.headers).not.toHaveProperty('content-disposition');
    });
  });

  async function registerExportPlugin(options: { exportResolver?: ExportXlsxResolver } = {}) {
    const plugin = new ExportPlugin(app, { name: 'export', ...options });
    await plugin.beforeLoad();
    await plugin.load();
    return plugin;
  }

  describe('plugin registered XLSX entry', () => {
    beforeEach(() => {
      app.resourcer.define({ name: 'documents', actions: { export: {} } });
    });

    it('uses the server-selected scoped exporter with independent export permission', async () => {
      await registerExportPlugin({ exportResolver: () => scopedFile });
      acl.getRole('reader').revokeAction('documents:list');
      const response = await fileRequest();
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toContain('Scoped%20export_B.xlsx');
      expect(xlsx.parse(response.body)[0].data).toEqual([['id'], [1], [3]]);
    });

    it.each([{}, { exportResolver: () => undefined }])(
      'preserves the original exporter when startup configuration does not select it: %j',
      async (options) => {
        await registerExportPlugin(options);
        const response = await fileRequest();
        expect(response.status).toBe(200);
        expect(xlsx.parse(response.body)[0].data).toEqual([['id'], [1], [2], [3], [4], [5], [6]]);
      },
    );

    it('keeps the registered resolver after startup options are replaced', async () => {
      const plugin = await registerExportPlugin({ exportResolver: () => scopedFile });
      plugin.options.exportResolver = () => undefined;
      const response = await fileRequest();
      expect(response.status).toBe(200);
      expect(xlsx.parse(response.body)[0].data).toEqual([['id'], [1], [3]]);
    });

    it('does not enable a resolver added after registration', async () => {
      const plugin = await registerExportPlugin();
      plugin.options.exportResolver = () => scopedFile;
      const response = await fileRequest();
      expect(response.status).toBe(200);
      expect(xlsx.parse(response.body)[0].data).toEqual([['id'], [1], [2], [3], [4], [5], [6]]);
    });

    it.each(['documents:export', 'participants:list'])(
      'does not publish a file after revoking %s',
      async (permission) => {
        await registerExportPlugin({ exportResolver: () => scopedFile });
        acl.getRole('reader').revokeAction(permission);
        const response = await fileRequest({
          fields: ['id', 'participants.id'],
          columns: [{ dataIndex: ['id'] }, { dataIndex: ['participants', 'id'] }],
        });
        expect(response.status).toBe(403);
        expect(response.headers).not.toHaveProperty('content-disposition');
      },
    );

    it('retains the independent export role filter', async () => {
      await registerExportPlugin({ exportResolver: () => scopedFile });
      await grant('documents', 'export', ['id'], { id: 1 });
      const response = await fileRequest();
      expect(response.status).toBe(200);
      expect(xlsx.parse(response.body)[0].data).toEqual([['id'], [1]]);
    });

    it('rechecks rules for each file after registration', async () => {
      await registerExportPlugin({ exportResolver: () => scopedFile });
      expect(xlsx.parse((await fileRequest()).body)[0].data).toEqual([['id'], [1], [3]]);
      const config = (await store.read(mainIdentity))!;
      await store.save(mainIdentity, { ...config, rules: [] }, { userId: 28 });
      const response = await fileRequest();
      expect(response.status).toBe(200);
      expect(xlsx.parse(response.body)[0].data).toEqual([['id']]);
    });

    it('uses the current server tenant instead of the client header', async () => {
      await registerExportPlugin({ exportResolver: () => scopedFile });
      principal = { ...principal, tenantId: 'C' };
      const response = await fileRequest().set('x-tenant-id', 'B');
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toContain('Scoped%20export_C.xlsx');
      expect(xlsx.parse(response.body)[0].data).toEqual([['id'], [4], [6]]);
    });

    it.each(['selection', 'execution', 'async selection'])(
      'does not fall back to the old exporter on registered %s failure',
      async (phase) => {
        await registerExportPlugin({
          exportResolver: (() => {
            if (phase === 'selection') throw new Error('Selection failed');
            if (phase === 'async selection') return Promise.reject(new Error('Async selection failed'));
            return async () => {
              throw new Error('Execution failed');
            };
          }) as ExportXlsxResolver,
        });
        const response = await fileRequest();
        expect(response.status).toBe(500);
        expect(response.headers).not.toHaveProperty('content-disposition');
      },
    );

    it('does not fall back when the registered executor produces no response', async () => {
      await registerExportPlugin({ exportResolver: () => async () => {} });
      const response = await fileRequest();
      expect(response.status).toBe(200);
      expect(response.headers).not.toHaveProperty('content-disposition');
      expect(JSON.parse(response.body.toString())).toEqual({});
    });

    it.each([null, false, 'export', {}])(
      'rejects invalid startup configuration before replacing the registered exporter: %j',
      async (resolve) => {
        await registerExportPlugin({ exportResolver: () => scopedFile });
        await expect(
          registerExportPlugin({ exportResolver: resolve as unknown as ExportXlsxResolver }),
        ).rejects.toThrow(TypeError);
        const response = await fileRequest();
        expect(response.status).toBe(200);
        expect(xlsx.parse(response.body)[0].data).toEqual([['id'], [1], [3]]);
      },
    );
  });

  describe('optional XLSX entry', () => {
    it('renders only scoped rows through the real exporter and keeps download headers', async () => {
      exportEntry = createExportXlsx(() => scopedFile);
      acl.getRole('reader').revokeAction('documents:list');
      const response = await fileRequest();
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/octet-stream');
      expect(response.headers['content-disposition']).toContain('Scoped%20export_B.xlsx');
      expect(xlsx.parse(response.body)[0].data).toEqual([['id'], [1], [3]]);
    });

    it('uses independently readable association rows in the Excel cells', async () => {
      exportEntry = createExportXlsx(() => scopedFile);
      const response = await fileRequest({
        fields: ['id', 'participants.id'],
        columns: [{ dataIndex: ['id'] }, { dataIndex: ['participants', 'id'] }],
      });
      expect(response.status).toBe(200);
      expect(xlsx.parse(response.body)[0].data).toEqual([
        ['id', 'id'],
        [1, '1,2'],
        [3, ''],
      ]);
    });

    it('renders authorized relations under any registered alias without hard-coded includes', async () => {
      app.db.getCollection('documents').setField('viewers', {
        type: 'hasMany',
        target: 'participants',
        foreignKey: 'documentId',
      });
      await grant('documents', 'export', ['id', 'viewers']);
      exportEntry = createExportXlsx(() => scopedFile);
      const response = await fileRequest({
        fields: ['id'],
        columns: [{ dataIndex: ['id'] }, { dataIndex: ['viewers', 'businessTenant'] }],
      });
      expect(response.status).toBe(200);
      expect(xlsx.parse(response.body)[0].data).toEqual([
        ['id', 'businessTenant'],
        [1, 'B,B'],
        [3, ''],
      ]);
    });

    it('renders nested authorized association values without requiring their primary keys', async () => {
      app.db.getCollection('participants').setField('document', {
        type: 'belongsTo',
        target: 'documents',
        foreignKey: 'documentId',
      });
      await grant('participants', 'list', ['businessTenant', 'document']);
      await grant('documents', 'list', ['name']);
      exportEntry = createExportXlsx(() => scopedFile);
      const response = await fileRequest({
        fields: ['id'],
        columns: [{ dataIndex: ['id'] }, { dataIndex: ['participants', 'document', 'name'] }],
      });
      expect(response.status).toBe(200);
      expect(xlsx.parse(response.body)[0].data).toEqual([
        ['id', 'name'],
        [1, 'D1,D1'],
        [3, ''],
      ]);
    });

    it('keeps the existing exporter when the server explicitly leaves the request unhandled', async () => {
      exportEntry = createExportXlsx(() => undefined);
      const response = await fileRequest();
      expect(response.status).toBe(200);
      expect(xlsx.parse(response.body)[0].data).toEqual([['id'], [1], [2], [3], [4], [5], [6]]);
    });

    it.each(['documents:export', 'participants:list'])(
      'does not publish a file without the independent permission %s',
      async (permission) => {
        exportEntry = createExportXlsx(() => scopedFile);
        acl.getRole('reader').revokeAction(permission);
        const response = await fileRequest({
          fields: ['id', 'participants.id'],
          columns: [{ dataIndex: ['id'] }, { dataIndex: ['participants', 'id'] }],
        });
        expect(response.status).toBe(403);
        expect(response.headers).not.toHaveProperty('content-disposition');
      },
    );

    it('rejects overflow before rendering instead of falling back to a worker or old query', async () => {
      exportEntry = createExportXlsx(() => scopedFile);
      await app.db
        .getCollection('documents')
        .model.bulkCreate(
          Array.from({ length: 999 }, (_, index) => ({ id: 100 + index, tenantId: 'B', name: 'Owned', amount: 1 })),
        );
      const response = await fileRequest();
      expect(response.status).toBe(400);
      expect(response.headers).not.toHaveProperty('content-disposition');
    });

    it('does not run the old query when a selected executor produces no response', async () => {
      exportEntry = createExportXlsx(() => async () => {});
      const response = await fileRequest();
      expect(response.status).toBe(200);
      expect(response.headers).not.toHaveProperty('content-disposition');
      expect(JSON.parse(response.body.toString())).toEqual({});
    });

    it.each(['selection', 'execution'])('propagates %s failures without publishing an old file', async (phase) => {
      exportEntry = createExportXlsx(() => {
        if (phase === 'selection') throw new Error('Export selection failed');
        return async () => {
          throw new Error('Export execution failed');
        };
      });
      const response = await fileRequest();
      expect(response.status).toBe(500);
      expect(response.headers).not.toHaveProperty('content-disposition');
    });

    it.each([null, {}, Promise.resolve(undefined), Promise.resolve(scopedFile)])(
      'rejects invalid or asynchronous selection without falling back: %j',
      async (selected) => {
        exportEntry = createExportXlsx((() => selected) as unknown as Parameters<typeof createExportXlsx>[0]);
        const response = await fileRequest();
        expect(response.status).toBe(500);
        expect(response.headers).not.toHaveProperty('content-disposition');
      },
    );

    it('consumes an asynchronous selection rejection without falling back or masking its error', async () => {
      exportEntry = createExportXlsx((async () => {
        throw new Error('Async export selection failed');
      }) as unknown as Parameters<typeof createExportXlsx>[0]);
      const response = await fileRequest();
      expect(response.status).toBe(500);
      expect(response.headers).not.toHaveProperty('content-disposition');
    });

    it.each(['selection', 'execution', 'async selection'])(
      'preserves the original %s error at the execution boundary',
      async (phase) => {
        const error = new Error('Export failed');
        const handler = createExportXlsx((() => {
          if (phase === 'selection') throw error;
          if (phase === 'async selection') return Promise.reject(error);
          return async () => {
            throw error;
          };
        }) as Parameters<typeof createExportXlsx>[0]);
        await expect(handler({} as Context, async () => {})).rejects.toBe(error);
      },
    );
  });

  it('exports all owned or visible roots once using export permission rather than list scope', async () => {
    const list = await app
      .agent()
      .resource('documents')
      .list({ fields: ['id'] });
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([{ id: 3 }]);
    const response = await runExport();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [{ id: 1 }, { id: 3 }] });
    expect(response.body).not.toHaveProperty('meta');
  });

  it('does not require root list permission when export is independently allowed', async () => {
    acl.getRole('reader').revokeAction('documents:list');
    const response = await runExport();
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('retains the export role filter and request filter', async () => {
    await grant('documents', 'export', ['id', 'name', 'amount'], { amount: { $gte: 200 } });
    const response = await runExport({ filter: { id: { $in: [1, 3, 4] } } });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 3 }]);
  });

  it('scopes expanded targets independently without dropping readable roots', async () => {
    const response = await runExport({ fields: ['id', 'participants.id'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      { id: 1, participants: [{ id: 1 }, { id: 2 }] },
      { id: 3, participants: [] },
    ]);
  });

  it('exports all matching roots instead of silently stopping at the ordinary default page size', async () => {
    await app.db
      .getCollection('documents')
      .model.bulkCreate(
        Array.from({ length: 25 }, (_, index) => ({ id: 100 + index, tenantId: 'B', name: 'Owned', amount: 1 })),
      );
    const response = await runExport();
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(27);
    expect(response.body.data.at(-1)).toEqual({ id: 124 });
  });

  it('does not use root list permission to authorize export', async () => {
    acl.getRole('reader').revokeAction('documents:export');
    const response = await runExport();
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
  });

  it('uses the trusted tenant and ignores a different client tenant header', async () => {
    principal = { ...principal, tenantId: 'C' };
    const response = await supertest(app.callback())
      .get('/api/documents:export')
      .set('x-tenant-id', 'B')
      .query({ fields: ['id'], sort: ['id'] });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 4 }, { id: 6 }]);
  });

  it('rechecks rules on each independent export request', async () => {
    expect((await runExport()).body.data).toEqual([{ id: 1 }, { id: 3 }]);
    const config = (await store.read(mainIdentity))!;
    await store.save(mainIdentity, { ...config, rules: [] }, { userId: 28 });
    const response = await runExport();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [] });
  });

  it('preserves requested sort and excluded fields', async () => {
    const response = await runExport({ fields: undefined, except: ['name'], sort: '-amount' });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      { id: 3, amount: 300 },
      { id: 1, amount: 100 },
    ]);
  });

  it('rejects requested physical fields excluded by the export permission', async () => {
    await grant('documents', 'export', ['id']);
    const response = await runExport({ fields: ['id', 'amount'] });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it('does not use export permission to authorize an inaccessible related collection', async () => {
    acl.getRole('reader').revokeAction('participants:list');
    const response = await runExport({ fields: ['id', 'participants.id'] });
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
    const unexpanded = await runExport();
    expect(unexpanded.status).toBe(200);
    expect(unexpanded.body.data).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('matches related filters against independently readable targets without duplicating roots', async () => {
    const response = await runExport({ filter: { participants: { businessTenant: 'B' } } });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 1 }]);
    principal = { ...principal, tenantId: 'H' };
    const hidden = await runExport({ filter: { participants: { canView: false } } });
    expect(hidden.status).toBe(200);
    expect(hidden.body.data).toEqual([]);
  });

  it('reads explicitly visible legacy data without claiming or changing it', async () => {
    const config = (await store.read(mainIdentity))!;
    await store.save(
      mainIdentity,
      {
        ...config,
        rules: [
          ...config.rules,
          {
            ...configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }, 'visibility').rules[0],
            id: 'legacy-visible',
          },
        ],
      },
      { userId: 28 },
    );
    const response = await runExport({ filter: { id: 5 } });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 5 }]);
    expect((await app.db.getCollection('documents').model.findByPk(5))!.get('tenantId')).toBeNull();
  });

  it.each([{ fields: ['id'] }, { fields: ['id', 'participants.id'] }])(
    'returns exactly the complete-row bound but refuses a larger authorized result: %j',
    async ({ fields }) => {
      await app.db
        .getCollection('documents')
        .model.bulkCreate(
          Array.from({ length: 998 }, (_, index) => ({ id: 100 + index, tenantId: 'B', name: 'Owned', amount: 1 })),
        );
      const complete = await runExport({ fields });
      expect(complete.status).toBe(200);
      expect(complete.body.data).toHaveLength(1000);
      expect(complete.body.data.at(-1)).toEqual(fields.length === 1 ? { id: 1097 } : { id: 1097, participants: [] });
      await app.db.getCollection('documents').model.create({ id: 2000, tenantId: 'B', name: 'Overflow', amount: 1 });
      const overflow = await runExport({ fields });
      expect(overflow.status).toBe(400);
      expect(overflow.body).not.toHaveProperty('data');
    },
  );

  it('does not include inaccessible roots in the completeness bound', async () => {
    await app.db
      .getCollection('documents')
      .model.bulkCreate(
        Array.from({ length: 1001 }, (_, index) => ({ id: 100 + index, tenantId: 'C', name: 'Hidden', amount: 1 })),
      );
    const response = await runExport();
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it.each([{ fields: ['id'] }, { fields: ['id', 'participants.id'] }])(
    'rejects root-query overflow even when a returned row is deleted before a later count: %j',
    async ({ fields }) => {
      const model = app.db.getCollection('documents').model;
      await model.bulkCreate(
        Array.from({ length: 999 }, (_, index) => ({ id: 100 + index, tenantId: 'B', name: 'Owned', amount: 1 })),
      );
      const findAll = model.findAll;
      // Preserve the real query, inserting a real concurrent delete before the consumer resumes.
      const query = vi.spyOn(model, 'findAll').mockImplementationOnce(async function (options) {
        const rows = await findAll.call(this, options);
        await model.destroy({ where: { id: 1 } });
        return rows;
      });
      try {
        const response = await runExport({ fields });
        expect(await model.findByPk(1)).toBeNull();
        expect(response.status).toBe(400);
        expect(response.body).not.toHaveProperty('data');
      } finally {
        query.mockRestore();
      }
    },
  );

  it('does not publish data when relation metadata changes during target authorization', async () => {
    beforeRelated = async () => {
      Object.assign(app.db.getCollection('documents').model.associations.participants, { scope: { canView: false } });
    };
    const response = await runExport({ fields: ['id', 'participants.id'] });
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });

  it.each([
    { page: 2 },
    { pageSize: 1 },
    { paginate: false },
    { limit: 1 },
    { offset: 1 },
    { filterByTk: 1 },
    { where: { id: 1 } },
    { transaction: { id: 1 } },
    { columns: [{ dataIndex: ['id'] }] },
    { values: { tenantId: 'C' } },
    { permission: { skip: true } },
    { now: '2026-01-01' },
  ])('rejects unsupported export parameters without a partial response: %j', async (extra) => {
    const response = await runExport(extra);
    expect(response.status).toBe(400);
    expect(response.body).not.toHaveProperty('data');
  });
});
