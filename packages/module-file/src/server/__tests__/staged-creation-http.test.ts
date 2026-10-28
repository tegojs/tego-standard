import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockServer, supertest, type MockServer } from '@tachybase/test';
import type { Collection, Context } from '@tego/server';

import FilePlugin, {
  captureStagedAttachmentResponse,
  resolveStagedAttachmentStorage,
  withStagedAttachmentTransaction,
  withStagedAttachmentUpload,
  type StagedAttachmentStorage,
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
import { accessCollectionKey } from '../../../../module-tenant/src/server/access-control/config-store';
import { AccessQueryService } from '../../../../module-tenant/src/server/access-control/query';
import { AccessRootMutationHandler } from '../../../../module-tenant/src/server/access-control/root-mutation-handler';
import storageDefinition from '../collections/storages';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

// Fixture identities are server supplied. This is an isolated optional executor, never production registration.
describe.skipIf(!postgresUrl)('staged attachment creation over HTTP and PostgreSQL', () => {
  let app: MockServer;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let configs: ReturnType<typeof configStore>;
  let directory: string;
  let staging: string;
  let root: string;
  let roleName: string;
  let parsed: boolean;
  let copied: boolean;
  let databaseVerified: boolean;
  const bytes = Buffer.from('Actual HTTP attachment bytes');

  beforeEach(async () => {
    databaseVerified = false;
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
        const selection = await resolveStagedAttachmentStorage(docs);
        const storage = selection.values as unknown as StagedAttachmentStorage;
        parsed = true;
        ctx.body = await withStagedAttachmentUpload(ctx, { directory: staging, maxFileSize: 1024 }, (file) =>
          withStagedAttachmentTransaction(db, storage, file, async ({ transaction, values, store }) => {
            const readResponse = captureStagedAttachmentResponse(docs, values, storage);
            let response: Record<string, unknown>;
            await entry.create({
              transaction,
              metadata: values,
              storage: { key: values.storageId, assertCurrent: selection.assertCurrent },
              afterPersist: async () => {
                await store();
                copied = true;
                expect(await fs.readFile(path.join(root, values.path, values.filename))).toEqual(bytes);
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
    app.acl.define({ role: 'creator' }).grantAction('documents:create', {});
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
    expect(await fs.readdir(root)).toEqual([]);
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
        path: '',
        url: expect.stringMatching(/^\/test-files\/[a-f0-9]{32}\.txt$/),
        storageId: expect.anything(),
        meta: {},
      });
      expect(String(response.body.data.storageId)).toBe('17');
      const row = await docs.repository.findOne({ appends: ['storage'] });
      expect(row.get('tenantId')).toBe('B');
      expect(row.get('storage').get('id')).toBe(17);
      expect(await fs.readFile(path.join(root, row.get('filename')))).toEqual(bytes);
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
    expect(await fs.readFile(path.join(root, row.get('filename')))).toEqual(bytes);
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
    expect(await fs.readFile(path.join(root, row.get('filename')))).toEqual(bytes);
    expect(await fs.readdir(staging)).toEqual([]);
  });
});
