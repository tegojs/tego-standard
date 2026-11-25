import { ACL, type Application, type Collection, type Database } from '@tego/server';

import { createAccessMigrationPreview } from '../../actions/preview-access-migration';
import { TENANT_ERROR_MESSAGES } from '../../locale';
import { grantStoredScope, seedAclScopes } from './acl-database';
import { externalIdentity, mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const request = () => ({
  dataSourceKey: 'main',
  collectionName: 'documents',
  roleActions: [{ role: 'member', action: 'list' }],
});

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('migration preview action (%s)', (dialect) => {
  let db: Database;
  let acl: ACL;
  let collection: Collection;
  let app: Application;

  const context = (values: unknown = request()) => ({
    method: 'POST',
    state: { currentUser: { id: 28 }, currentRole: 'manager' },
    action: { params: { values } },
    body: undefined as unknown,
    t: (message: string) => `translated: ${message}`,
    throw: (status: number, message: string, properties?: object): never => {
      throw Object.assign(new Error(message), { status, ...properties });
    },
  });
  const invoke = (ctx = context()) => createAccessMigrationPreview(app)(ctx as never, async () => {});

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    collection = db.collection({
      name: 'documents',
      key: mainIdentity.collectionKey,
      tenancy: 'tenantScoped',
      timestamps: false,
      autoGenId: false,
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true, autoIncrement: true },
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string' },
      ],
    });
    await seedConfigStore(db);
    await seedAclScopes(db);
    acl = new ACL();
    await grantStoredScope(db, acl);
    app = { db, acl, dataSourceManager: { dataSources: new Map() } } as unknown as Application;
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "rolesResourcesScopesActions", "dataSourcesRolesResourcesScopesActions", ' +
            '"rolesResourcesScopes", "dataSourcesRolesResourcesScopes", "documents", ' +
            '"access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db?.close();
    }
  });

  it('derives the persistent key and returns a detached preview without writes or registration', async () => {
    const queries: string[] = [];
    db.sequelize.options.logging = (sql: string) => queries.push(sql);
    const ctx = context();
    const next = vi.fn();
    await createAccessMigrationPreview(app)(ctx as never, next);
    expect(ctx.body).toMatchObject({
      identity: mainIdentity,
      draft: { schemaVersion: 1, revision: 0 },
      roleScopes: [{ treatment: 'delegate-builtin-scope' }],
    });
    expect(next).toHaveBeenCalledOnce();
    expect(queries.every((sql) => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i.test(sql))).toBe(true);
    expect(collection.options).not.toHaveProperty('tenantAccess');
    expect(acl.getRole('member').getActionParams('documents:list')).toHaveProperty('filter.tenantId');
  });

  it('rejects an unauthenticated caller before reading metadata', async () => {
    const ctx = context();
    ctx.state.currentUser = undefined;
    const read = vi.spyOn(db.getCollection('collections').model, 'findAll');
    await expect(invoke(ctx)).rejects.toMatchObject({ status: 401 });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects non-POST requests before reading metadata', async () => {
    const ctx = context();
    ctx.method = 'GET';
    const read = vi.spyOn(db.getCollection('collections').model, 'findAll');
    await expect(invoke(ctx)).rejects.toMatchObject({ status: 405 });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not resolve authoritative metadata from a request database', async () => {
    const getCollection = vi.fn(() => {
      throw new Error('untrusted request database');
    });
    const ctx = { ...context(), db: { getCollection } };
    await invoke(ctx);
    expect(ctx.body).toMatchObject({ identity: mainIdentity });
    expect(getCollection).not.toHaveBeenCalled();
  });

  it('accepts a matching collection key and rejects a stale identity', async () => {
    const ctx = context({ ...request(), collectionKey: mainIdentity.collectionKey });
    await invoke(ctx);
    expect(ctx.body).toMatchObject({ identity: mainIdentity });
    const stale = context({ ...request(), collectionKey: 'forged' });
    await expect(invoke(stale)).rejects.toMatchObject({ status: 409, code: 'ACCESS_CONFIG_CONFLICT' });
    expect(stale.body).toBeUndefined();
  });

  it.each([
    null,
    [],
    {},
    { ...request(), collectionName: '' },
    { ...request(), dataSourceKey: 123 },
    { ...request(), collectionKey: '' },
    { ...request(), tenantAccess: {} },
    { ...request(), roleActions: [{ role: 'member', action: 'list', params: {} }] },
    { ...request(), roleActions: Array(1) },
    { ...request(), roleActions: Array(1001).fill({ role: 'member', action: 'list' }) },
  ])('rejects malformed or write-like input before querying: %j', async (values) => {
    const read = vi.spyOn(db.getCollection('collections').model, 'findAll');
    await expect(invoke(context(values))).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_ACCESS_CONFIG_WRITE',
      message: `translated: ${TENANT_ERROR_MESSAGES.accessPreviewInvalid}`,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not evaluate accessors in the request or role selection', async () => {
    const getter = vi.fn(() => 'main');
    const values = request();
    Object.defineProperty(values, 'dataSourceKey', { get: getter });
    await expect(invoke(context(values))).rejects.toMatchObject({ status: 400 });
    Object.defineProperty(values, 'dataSourceKey', { value: 'main' });
    Object.defineProperty(values.roleActions[0], 'role', { get: getter });
    await expect(invoke(context(values))).rejects.toMatchObject({ status: 400 });
    expect(getter).not.toHaveBeenCalled();
  });

  it('captures request identities and selections before the first metadata await', async () => {
    const values = request();
    const model = db.getCollection('collections').model;
    const read = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      values.dataSourceKey = 'external';
      values.collectionName = 'other';
      values.roleActions[0].role = 'other';
      return read(options);
    });
    const ctx = context(values);
    await invoke(ctx);
    expect(ctx.body).toMatchObject({ identity: mainIdentity, roleScopes: [{ role: 'member' }] });
  });

  it('refuses stale or absent runtime keys and missing persistent metadata', async () => {
    collection.options.key = 'replacement';
    await expect(invoke()).rejects.toMatchObject({ status: 409, code: 'ACCESS_CONFIG_CONFLICT' });
    delete collection.options.key;
    await expect(invoke()).rejects.toMatchObject({ status: 409 });
    collection.options.key = mainIdentity.collectionKey;
    await db.getRepository('collections').destroy({ filterByTk: 'documents' });
    await expect(invoke()).rejects.toMatchObject({ status: 404, code: 'ACCESS_COLLECTION_NOT_FOUND' });
  });

  it('uses the external registered DB and ACL with metadata from the primary DB', async () => {
    const externalDb = sqliteDatabase();
    try {
      externalDb.collection({
        name: 'documents',
        key: externalIdentity.collectionKey,
        tenancy: 'shared',
        fields: [{ name: 'name', type: 'string' }],
      });
      const externalAcl = new ACL();
      externalAcl.define({ role: 'member' }).grantAction('documents:list', { filter: { name: 'external-only' } });
      app.dataSourceManager.dataSources.set('external', {
        collectionManager: { db: externalDb },
        acl: externalAcl,
      } as never);
      const ctx = context({ ...request(), dataSourceKey: 'external' });
      await invoke(ctx);
      expect(ctx.body).toMatchObject({
        identity: externalIdentity,
        legacy: { tenancy: 'shared' },
        roleScopes: [{ treatment: 'retain-role-scope', params: { filter: { name: 'external-only' } } }],
      });
    } finally {
      await externalDb.close();
    }
  });

  it.each([undefined, { collectionManager: {}, acl: new ACL() }])(
    'rejects an unavailable or non-database external source without falling back to main',
    async (source) => {
      if (source) app.dataSourceManager.dataSources.set('external', source as never);
      await expect(invoke(context({ ...request(), dataSourceKey: 'external' }))).rejects.toMatchObject({
        status: 404,
      });
    },
  );

  it('rejects source replacement while reading metadata', async () => {
    app.dataSourceManager.dataSources.set('external', { collectionManager: { db }, acl } as never);
    collection.options.key = externalIdentity.collectionKey;
    const model = db.getCollection('dataSourcesCollections').model;
    const read = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      app.dataSourceManager.dataSources.set('external', { collectionManager: { db }, acl } as never);
      return read(options);
    });
    const ctx = context({ ...request(), dataSourceKey: 'external' });
    await expect(invoke(ctx)).rejects.toMatchObject({ status: 409 });
    expect(ctx.body).toBeUndefined();
  });

  it('translates configuration conflicts while preserving status and code', async () => {
    collection.options.tenantAccess = null;
    await expect(invoke()).rejects.toMatchObject({
      status: 409,
      code: 'ACCESS_CONFIG_CONFLICT',
      message: `translated: ${TENANT_ERROR_MESSAGES.accessPreviewConflict}`,
    });
  });

  it('translates invalid effective rule errors without losing their code', async () => {
    collection.options.tenancy = 'unknown';
    await expect(invoke()).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_ACCESS_RULE',
      message: `translated: ${TENANT_ERROR_MESSAGES.accessPreviewInvalid}`,
    });
  });

  it('does not wrap an unexpected database error', async () => {
    const error = new Error('connection lost');
    vi.spyOn(db.getCollection('collections').model, 'findAll').mockRejectedValueOnce(error);
    await expect(invoke()).rejects.toBe(error);
  });
});
