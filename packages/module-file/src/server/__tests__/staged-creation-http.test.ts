import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import { Resourcer, type Collection, type Context } from '@tego/server';

import FilePlugin, {
  captureStagedAttachmentResponse,
  renderStagedAttachmentStorage,
  resolveStagedAttachmentStorage,
  withStagedAttachmentTransaction,
  withStagedAttachmentUpload,
} from '..';
import ErrorPlugin from '../../../../module-error-handler/src/server';
import { seedAclScopes } from '../../../../module-tenant/src/server/__tests__/access-control/acl-database';
import {
  configStore,
  mainIdentity,
  seedConfigStore,
} from '../../../../module-tenant/src/server/__tests__/access-control/config-database';
import { isolatedPostgresDatabase } from '../../../../module-tenant/src/server/__tests__/access-control/database';
import { configFor, ownerCondition } from '../../../../module-tenant/src/server/__tests__/access-control/fixtures';
import { AccessAclScopeAdapter } from '../../../../module-tenant/src/server/access-control/acl-scope';
import { captureAttachmentFieldPermission } from '../../../../module-tenant/src/server/access-control/attachment-creation-entry';
import { accessCollectionKey } from '../../../../module-tenant/src/server/access-control/config-store';
import { AccessQueryService } from '../../../../module-tenant/src/server/access-control/query';
import { AccessRootMutationHandler } from '../../../../module-tenant/src/server/access-control/root-mutation-handler';
import storageDefinition from '../collections/storages';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

// Fixture identities are server supplied. This is an isolated optional executor, never production registration.
describe.skipIf(!postgresUrl)('staged attachment creation over HTTP and PostgreSQL', () => {
  let app: MockServer;
  let docs: Collection;
  let source: Collection;
  let adapter: AccessAclScopeAdapter;
  let configs: ReturnType<typeof configStore>;
  let directory: string;
  let staging: string;
  let root: string;
  let roleName: string;
  let parsed: boolean;
  let copied: boolean;
  let databaseVerified: boolean;
  let sourceField: string | undefined;
  let sourceOperation: 'create' | 'update';
  let sourceFinalFields: string[] | undefined;
  let afterCopy: (() => void) | undefined;
  let sourceContext: { permission: unknown } | undefined;
  let fileContext: { permission: unknown } | undefined;
  const bytes = Buffer.from('Actual HTTP attachment bytes');

  beforeEach(async () => {
    databaseVerified = false;
    sourceField = undefined;
    sourceOperation = 'update';
    sourceFinalFields = undefined;
    afterCopy = undefined;
    sourceContext = undefined;
    fileContext = undefined;
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tego-file-http-create-'));
    root = path.join(directory, 'root');
    staging = path.join(directory, 'staging');
    await fs.mkdir(root);
    await fs.mkdir(staging);
    // Reuse the existing localhost/name allowlist, and confirm the app retained the exact isolated DB options.
    const checked = isolatedPostgresDatabase(postgresUrl);
    const connection = new URL(postgresUrl);
    app = mockServer({
      acl: false,
      registerActions: true,
      resourcer: { prefix: '/api' },
      database: {
        dialect: 'postgres',
        host: connection.hostname,
        port: Number(connection.port || 5432),
        database: connection.pathname.slice(1),
        username: decodeURIComponent(connection.username),
        password: decodeURIComponent(connection.password),
        logging: false,
        pool: { max: 5 },
      },
    });
    await checked.close();
    const db = app.db;
    if (
      db.options.dialect !== 'postgres' ||
      db.options.database !== connection.pathname.slice(1) ||
      db.options.host !== connection.hostname ||
      Number(db.options.port) !== Number(connection.port || 5432)
    )
      throw new Error('HTTP fixture did not retain its dedicated test database');
    databaseVerified = true;
    const errors = new ErrorPlugin(app, { name: 'test-errors' });
    await errors.beforeLoad();
    await errors.load();
    await seedConfigStore(db);
    await seedAclScopes(db);
    let handler: AccessRootMutationHandler;
    await app.pm.add(FilePlugin, {
      name: 'file-manager',
      attachmentResolver: () => async (ctx: Context & { permission: unknown }) => {
        const entry = handler.captureAttachment(ctx, ctx.state.testActor);
        fileContext = ctx;
        let fieldPermission: ReturnType<typeof captureAttachmentFieldPermission> | undefined;
        if (sourceField !== undefined) {
          // Server-selected fixture field, not a client attachmentField or a delegated file decision.
          const resources = new Resourcer();
          resources.define({ name: 'sources', actions: { [sourceOperation]: {} } });
          const action = resources.getAction('sources', sourceOperation).clone();
          Object.assign(action, { resourceName: 'sources', actionName: sourceOperation });
          action.mergeParams({ resourceName: 'sources', actionName: sourceOperation });
          const finalized = {
            db,
            action,
            state: ctx.state,
            logger: ctx.logger,
            get: ctx.get.bind(ctx),
            throw: ctx.throw.bind(ctx),
            permission: undefined as unknown,
          };
          await app.acl.middleware()(finalized as never, async () => {
            if (sourceFinalFields !== undefined)
              (finalized.permission as { parsedParams: { fields?: string[] } }).parsedParams.fields = sourceFinalFields;
            fieldPermission = captureAttachmentFieldPermission(
              db,
              finalized,
              roleName,
              source.getField(sourceField),
              docs,
            );
          });
          if (!fieldPermission) throw new Error('Source field ACL did not finish');
          sourceContext = finalized;
        }
        const selection = await resolveStagedAttachmentStorage(docs, fieldPermission?.field);
        fieldPermission?.assertCurrent();
        const storage = renderStagedAttachmentStorage(
          selection,
          (raw) => app.environment.renderJsonTemplate(raw),
          ctx.state.testActor.tenantId,
        );
        parsed = true;
        ctx.body = await withStagedAttachmentUpload(
          ctx,
          { directory: staging, maxFileSize: 1024, rules: storage.rules },
          (file) =>
            withStagedAttachmentTransaction(db, storage, file, async ({ transaction, values, store }) => {
              const readResponse = captureStagedAttachmentResponse(docs, values, storage);
              let response: Record<string, unknown>;
              await entry.create({
                transaction,
                metadata: values,
                storage: {
                  key: values.storageId,
                  async assertCurrent(transaction) {
                    fieldPermission?.assertCurrent();
                    await selection.assertCurrent(transaction);
                    fieldPermission?.assertCurrent();
                  },
                },
                afterPersist: async () => {
                  await store();
                  copied = true;
                  expect(await fs.readFile(path.join(root, values.path, values.filename))).toEqual(bytes);
                  afterCopy?.();
                },
                verifyRecord: async (key, transaction) => {
                  response = await readResponse(key, transaction);
                },
              });
              return response;
            }),
        );
      },
    });
    const plugin = app.pm.get(FilePlugin);
    await plugin.beforeLoad();
    db.collection(storageDefinition);
    docs = db.collection({
      name: 'documents',
      tableName: 'access_documents',
      template: 'file',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
        { name: 'tenantId', type: 'string', field: 'tenant_id' },
        { name: 'name', type: 'string' },
        { name: 'amount', type: 'integer', defaultValue: 10 },
        { name: 'internalToken', type: 'string', defaultValue: 'private-value' },
        ...['title', 'filename', 'extname', 'path', 'url', 'mimetype'].map((name) => ({ name, type: 'string' })),
        { name: 'size', type: 'integer' },
        { name: 'meta', type: 'jsonb' },
        { name: 'storage', type: 'belongsTo', target: 'storages', foreignKey: 'storageId' },
      ],
    });
    source = db.collection({
      name: 'sources',
      timestamps: false,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'file', type: 'belongsTo', target: 'documents', storage: 'receipts' },
        { name: 'files', type: 'belongsToMany', target: 'documents', through: 'source_files', storage: 'receipts' },
      ],
    });
    db.collection({
      name: 'tenants',
      autoGenId: false,
      timestamps: false,
      fields: [
        { name: 'id', type: 'string', primaryKey: true },
        { name: 'enabled', type: 'boolean' },
      ],
    });
    await db.sync();
    await db.getRepository('tenants').create({ values: [{ id: 'B', enabled: true }] });
    await db.getRepository('storages').create({
      values: {
        id: 17,
        name: 'local',
        type: 'local',
        default: true,
        path: '',
        baseUrl: '/test-files',
        options: { documentRoot: root },
      },
    });
    await db.getRepository('storages').create({
      values: {
        id: 18,
        name: 'receipts',
        type: 'local',
        path: 'field-receipts',
        baseUrl: '/field-files',
        options: { documentRoot: root, secret: 'never-in-a-file-response' },
      },
    });
    configs = configStore(db);
    await configs.save(mainIdentity, { ...configFor(ownerCondition), revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(app.acl, 'main', configs, db);
    const identity = (collection: Collection) =>
      collection === docs
        ? mainIdentity
        : { ...mainIdentity, collectionKey: collection.name, collectionName: collection.name };
    const queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
    handler = new AccessRootMutationHandler(db, adapter, queries, identity);
    app.acl.setAvailableAction('upload', { type: 'new-data' });
    const uploader = app.acl.define({ role: 'uploader' });
    uploader.grantAction('documents:upload', {});
    uploader.grantAction('documents:create', {});
    uploader.grantAction('sources:create', { whitelist: ['file', 'files'] });
    uploader.grantAction('sources:update', { whitelist: ['file', 'files'] });
    app.acl.define({ role: 'creator' }).grantAction('documents:create', {});
    app.acl.define({ role: 'field-editor' }).grantAction('sources:update', { whitelist: ['file', 'files'] });
    roleName = 'uploader';
    app.resourcer.use(
      async (ctx, next) => {
        ctx.state.currentRole = roleName;
        ctx.state.currentUser = { id: 28 };
        ctx.state.testActor = { tenantId: 'B', userId: 28, roleName };
        await adapter.prepare(ctx, [mainIdentity]);
        try {
          await next();
        } finally {
          adapter.release(ctx);
        }
      },
      { tag: 'attachment-test-preparation', after: 'auth', before: 'acl' },
    );
    app.resourcer.use(app.acl.middleware(), { tag: 'acl', after: 'attachment-test-preparation' });
    await plugin.load();
    parsed = false;
    copied = false;
  });
  afterEach(async () => {
    try {
      if (app && databaseVerified) await app.db.sequelize.drop({ cascade: true });
    } finally {
      await app?.destroy();
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
  });

  const upload = (operation = 'upload', query = '') =>
    supertest(app.callback())
      .post('/api/documents:' + operation + query)
      .attach('file', bytes, { filename: 'receipt.txt' });
  async function empty() {
    expect(await docs.repository.count()).toBe(0);
    expect(
      (await fs.readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()),
    ).toEqual([]);
    expect(await fs.readdir(staging)).toEqual([]);
  }

  it.each(['create', 'upload'])(
    'commits %s with current ownership, actual storage relation and bytes',
    async (operation) => {
      const response = await upload(operation);
      expect(response.status, response.text).toBe(200);
      expect(response.body.data).toEqual({
        id: 1,
        title: 'receipt',
        filename: expect.stringMatching(/^[a-f0-9]{32}\.txt$/),
        extname: '.txt',
        mimetype: 'text/plain',
        size: bytes.length,
        path: 'tenants/B',
        url: expect.stringMatching(/^\/test-files\/tenants\/B\/[a-f0-9]{32}\.txt$/),
        storageId: expect.anything(),
        meta: {},
      });
      expect(String(response.body.data.storageId)).toBe('17');
      const row = await docs.repository.findOne({ appends: ['storage'] });
      expect(row.get('tenantId')).toBe('B');
      expect(row.get('storage').get('id')).toBe(17);
      expect(await fs.readFile(path.join(root, row.get('path'), row.get('filename')))).toEqual(bytes);
      expect(await fs.readdir(staging)).toEqual([]);
    },
  );
  it('does not parse or store a file when only create is granted for an upload request', async () => {
    roleName = 'creator';
    expect((await upload()).status).toBe(403);
    expect(parsed).toBe(false);
    await empty();
  });
  it('rolls back the full HTTP upload when only V allows the new record', async () => {
    const previous = await configs.read(mainIdentity);
    await configs.save(
      mainIdentity,
      { ...configFor(ownerCondition, 'visibility'), revision: previous.revision },
      { userId: 28 },
    );
    expect((await upload()).status).toBe(403);
    expect(copied).toBe(true);
    await empty();
  });
  it('retains the actual finalized role filter across multipart parsing and file copying', async () => {
    app.acl.getRole('uploader').grantAction('documents:upload', { filter: { amount: 20 } });
    expect((await upload()).status).toBe(403);
    expect(copied).toBe(true);
    await empty();
  });
  it('rolls back row, staged data and stored bytes after a real metadata tamper hook', async () => {
    app.db.on('documents.beforeCreate', (row) => row.setDataValue('filename', 'changed.txt'));
    expect((await upload()).status).toBe(500);
    expect(copied).toBe(true);
    await empty();
  });
  it('rejects user storageId before parsing a real multipart request', async () => {
    expect((await upload('upload', '?values[storageId]=18')).status).toBe(400);
    expect(parsed).toBe(false);
    await empty();
  });
  it.each(['create', 'upload'])('rejects a record locator before parsing %s multipart data', async (operation) => {
    const response = await upload(operation, '?filterByTk=1');
    expect(response.status, response.text).toBe(400);
    expect(response.body.errors[0].code).toBe('INVALID_ACCESS_MUTATION');
    expect(parsed).toBe(false);
    await empty();
  });
  it('applies final field grants to actual query values separately from generated file metadata', async () => {
    app.acl.getRole('uploader').grantAction('documents:upload', { fields: ['title'] });
    expect((await upload('upload', '?values[title]=Approved&values[amount]=999')).status).toBe(200);
    const row = await docs.repository.findOne();
    expect(row.get('title')).toBe('Approved');
    expect(row.get('amount')).toBe(10);
    expect(row.get('tenantId')).toBe('B');
    expect(row.get('storageId')).toBe(17);
    expect(await fs.readFile(path.join(root, row.get('path'), row.get('filename')))).toEqual(bytes);
    expect(await fs.readdir(staging)).toEqual([]);
  });
  it('returns the saved title without custom private columns or association expansion', async () => {
    app.db.on('documents.beforeCreate', (row) => row.setDataValue('title', 'Normalized receipt'));
    const response = await upload();
    expect(response.status, response.text).toBe(200);
    expect(response.body.data.title).toBe('Normalized receipt');
    expect(response.body.data).not.toHaveProperty('internalToken');
    expect(response.body.data).not.toHaveProperty('tenantId');
    expect(response.body.data).not.toHaveProperty('storage');
    expect(response.body.data).not.toHaveProperty('options');
  });
  it('never publishes a success receipt when commit hooks fail after the row is committed', async () => {
    app.db.on('documents.afterCreate', (_row, options) => {
      options.transaction.afterCommit(() => {
        throw new Error('after commit failed');
      });
    });
    const response = await upload();
    expect(response.status, response.text).toBe(500);
    expect(response.body).not.toHaveProperty('data');
    const row = await docs.repository.findOne();
    expect(row).toBeTruthy();
    expect(await fs.readFile(path.join(root, row.get('path'), row.get('filename')))).toEqual(bytes);
    expect(await fs.readdir(staging)).toEqual([]);
  });
  it('renders actual server environment values before storing in the authenticated tenant directory', async () => {
    app.environment.setVariable('uploadRoot', root);
    app.environment.setVariable('uploadPath', 'receipts');
    app.environment.setVariable('uploadBase', '/rendered-files');
    await app.db.getRepository('storages').update({
      filterByTk: 17,
      values: {
        path: '{{ $env.uploadPath }}',
        baseUrl: '{{ $env.uploadBase }}',
        options: { documentRoot: '{{ $env.uploadRoot }}' },
      },
    });
    app.db.on('documents.beforeCreate', () => {
      app.environment.setVariable('uploadRoot', path.join(directory, 'changed-root'));
      app.environment.setVariable('uploadPath', 'changed-path');
    });
    const response = await upload().set('x-tenant-id', 'forged');
    expect(response.status, response.text).toBe(200);
    expect(response.body.data.path).toBe('receipts/tenants/B');
    expect(response.body.data.url).toMatch(/^\/rendered-files\/receipts\/tenants\/B\/[a-f0-9]{32}\.txt$/);
    const row = await docs.repository.findOne();
    expect(row.get('tenantId')).toBe('B');
    expect(await fs.readFile(path.join(root, 'receipts', 'tenants', 'B', row.get('filename')))).toEqual(bytes);
    expect(await fs.readdir(staging)).toEqual([]);
  });
  it.each([{ size: bytes.length - 1 }, { mimetype: 'image/*' }])(
    'enforces actual selected storage rules %j before database or final file writes',
    async (rules) => {
      await app.db.getRepository('storages').update({ filterByTk: 17, values: { rules } });
      const response = await upload();
      expect(response.status, response.text).toBe(400);
      expect(parsed).toBe(true);
      expect(copied).toBe(false);
      await empty();
    },
  );
  it('accepts actual selected storage rules when size and type both permit the multipart file', async () => {
    await app.db.getRepository('storages').update({
      filterByTk: 17,
      values: { rules: { size: bytes.length + 1, mimetype: 'text/*' } },
    });
    const response = await upload();
    expect(response.status, response.text).toBe(200);
    expect(response.body.data.size).toBe(bytes.length);
    const row = await docs.repository.findOne();
    expect(row.get('tenantId')).toBe('B');
    expect(await fs.readFile(path.join(root, row.get('path'), row.get('filename')))).toEqual(bytes);
    expect(await fs.readdir(staging)).toEqual([]);
  });

  it.each([
    ['create', 'file'],
    ['update', 'file'],
    ['create', 'files'],
    ['update', 'files'],
  ] as const)('uses the independent source %s field %s grant with file ACL and G', async (operation, field) => {
    sourceField = field;
    sourceOperation = operation;
    sourceFinalFields = [field];
    const client = supertest(app.callback());
    expect((await client.get('/api/storages:list')).status).toBe(403);
    expect((await client.get('/api/storages:get?filterByTk=18')).status).toBe(403);
    const response = await upload();
    expect(response.status, response.text).toBe(200);
    expect(response.body.data.path).toBe('field-receipts/tenants/B');
    expect(response.body.data.url).toMatch(/^\/field-files\/field-receipts\/tenants\/B\/[a-f0-9]{32}\.txt$/);
    expect(String(response.body.data.storageId)).toBe('18');
    expect(JSON.stringify(response.body)).not.toContain('never-in-a-file-response');
    const row = await docs.repository.findOne({ appends: ['storage'] });
    expect(row.get('tenantId')).toBe('B');
    expect(row.get('storage').get('id')).toBe(18);
    expect(await fs.readFile(path.join(root, row.get('path'), row.get('filename')))).toEqual(bytes);
    expect(await source.model.count()).toBe(0);
    expect(await app.db.getCollection('source_files').model.count()).toBe(0);
    expect(await fs.readdir(staging)).toEqual([]);
  });

  it.each([{ whitelist: ['title'] }, { blacklist: ['file'] }])(
    'rejects source field restrictions %j before multipart parsing or storage writes',
    async (params) => {
      sourceField = 'file';
      sourceFinalFields = ['file'];
      app.acl.getRole('uploader').grantAction('sources:update', params);
      const response = await upload();
      expect(response.status, response.text).toBe(400);
      expect(parsed).toBe(false);
      expect(copied).toBe(false);
      await empty();
    },
  );

  it('enforces final source fields even when its whitelist allows the attachment', async () => {
    sourceField = 'file';
    sourceFinalFields = ['title'];
    const response = await upload();
    expect(response.status, response.text).toBe(400);
    expect(parsed).toBe(false);
    expect(copied).toBe(false);
    await empty();
  });

  it('does not borrow the file create grant for an ungranted source write', async () => {
    sourceField = 'file';
    roleName = 'creator';
    expect((await upload('create')).status).toBe(403);
    expect(parsed).toBe(false);
    await empty();
  });

  it('does not borrow a source field grant for an ungranted file upload', async () => {
    sourceField = 'file';
    roleName = 'field-editor';
    expect((await upload()).status).toBe(403);
    expect(parsed).toBe(false);
    await empty();
  });

  it('still rolls back selected-field bytes when file G denies the new record', async () => {
    sourceField = 'file';
    const previous = await configs.read(mainIdentity);
    await configs.save(
      mainIdentity,
      { ...configFor(ownerCondition, 'visibility'), revision: previous.revision },
      { userId: 28 },
    );
    expect((await upload()).status).toBe(403);
    expect(copied).toBe(true);
    await empty();
  });

  it('rechecks a source field revocation after copying and rolls back the row and all bytes', async () => {
    sourceField = 'file';
    afterCopy = () => {
      (sourceContext!.permission as { parsedParams: { fields?: string[] } }).parsedParams.fields = [];
    };
    expect((await upload()).status).toBe(400);
    expect(copied).toBe(true);
    await empty();
  });

  it.each(
    ['create', 'upload'].flatMap((operation) =>
      ['decision', 'fields', 'filter'].map((change) => ({ operation, change })),
    ),
  )('rolls back $operation when its final file $change changes after copying', async ({ operation, change }) => {
    afterCopy = () => {
      const final = fileContext!.permission as { can: unknown; skip: boolean; parsedParams: Record<string, unknown> };
      if (change === 'decision') {
        final.can = false;
        final.skip = false;
      }
      if (change === 'fields') final.parsedParams.fields = [];
      if (change === 'filter') final.parsedParams.filter = { id: { $eq: -1 } };
    };
    const response = await upload(operation);
    expect(response.status, response.text).toBe(400);
    expect(copied).toBe(true);
    await empty();
  });

  it('rejects changed field storage selection before copying and rolls back the inserted row', async () => {
    sourceField = 'file';
    app.db.on('documents.beforeCreate', () => {
      source.getField('file').options.storage = 'local';
    });
    expect((await upload()).status).toBe(500);
    expect(parsed).toBe(true);
    expect(copied).toBe(false);
    await empty();
  });
});
