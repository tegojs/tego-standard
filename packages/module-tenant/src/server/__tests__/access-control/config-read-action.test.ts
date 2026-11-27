import { type Application, type Collection, type Database } from '@tego/server';

import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { createAccessConfigRead } from '../../actions/read-access-config';
import { externalIdentity, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const request = () => ({ dataSourceKey: 'main', collectionName: 'documents' });

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('configuration read action (%s)', (dialect) => {
  let db: Database;
  let collection: Collection;
  let app: Application;
  const context = (values: unknown = request()) => ({
    method: 'POST',
    state: { currentUser: { id: 28 } },
    action: { params: { values } },
    body: undefined as unknown,
    t: (message: string) => `translated: ${message}`,
    throw: (status: number, message?: string, properties?: object): never => {
      throw Object.assign(new Error(message), { status, ...properties });
    },
  });
  const invoke = (ctx = context()) => createAccessConfigRead(app)(ctx as never, async () => {});
  const store = () =>
    new AccessConfigStore(db, () =>
      resolveModelMetadata(collection, {
        resolveCollectionKey: (target) =>
          accessCollectionKey({ ...mainIdentity, collectionName: target.name, collectionKey: target.options.key }),
      }),
    );

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl) : sqliteDatabase();
    collection = db.collection({
      name: 'documents',
      key: mainIdentity.collectionKey,
      timestamps: false,
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'name', type: 'string' },
      ],
    });
    await seedConfigStore(db);
    app = { db, dataSourceManager: { dataSources: new Map() } } as unknown as Application;
  });
  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "documents", "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db?.close();
    }
  });

  it('reads a saved revision without changing configuration, history or runtime options', async () => {
    const saved = await store().save(mainIdentity, initialConfig(), { userId: 28 });
    const queries: string[] = [];
    db.sequelize.options.logging = (sql: string) => queries.push(sql);
    const ctx = context();
    await invoke(ctx);
    expect(ctx.body).toEqual({ identity: mainIdentity, config: saved });
    expect(queries.every((sql) => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i.test(sql))).toBe(true);
    expect(collection.options).not.toHaveProperty('tenantAccess');
    expect(await db.getRepository('tenantAccessRevisions').count()).toBe(1);
  });

  it('returns null only when no configuration exists', async () => {
    const ctx = context();
    await invoke(ctx);
    expect(ctx.body).toEqual({ identity: mainIdentity, config: null });
    await db.getRepository('collections').update({ filterByTk: 'documents', values: { tenantAccess: null } });
    await expect(invoke()).rejects.toMatchObject({ status: 400 });
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
    { ...request(), dataSourceKey: 1 },
    { ...request(), collectionKey: '' },
    { ...request(), tenantAccess: {} },
  ])('rejects malformed and write-like input before querying: %j', async (values) => {
    const read = vi.spyOn(db.getCollection('collections').model, 'findAll');
    await expect(invoke(context(values))).rejects.toMatchObject({ status: 400, code: 'INVALID_ACCESS_CONFIG_WRITE' });
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects accessors without evaluating them', async () => {
    const getter = vi.fn();
    const values = request();
    Object.defineProperty(values, 'dataSourceKey', { get: getter });
    await expect(invoke(context(values))).rejects.toMatchObject({ status: 400 });
    expect(getter).not.toHaveBeenCalled();
  });

  it('requires authentication and POST before accessing metadata', async () => {
    const read = vi.spyOn(db.getCollection('collections').model, 'findAll');
    const ctx = context();
    ctx.state.currentUser = undefined;
    await expect(invoke(ctx)).rejects.toMatchObject({ status: 401 });
    const get = context();
    get.method = 'GET';
    await expect(invoke(get)).rejects.toMatchObject({ status: 405 });
    expect(read).not.toHaveBeenCalled();
  });

  it('captures the selection before awaiting and ignores the request database', async () => {
    const values = request();
    const model = db.getCollection('collections').model;
    const read = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      values.collectionName = 'other';
      values.dataSourceKey = 'external';
      return read(options);
    });
    const ctx = {
      ...context(values),
      db: {
        getCollection: () => {
          throw new Error('untrusted database');
        },
      },
    };
    await invoke(ctx);
    expect(ctx.body).toEqual({ identity: mainIdentity, config: null });
  });

  it('uses an external registered database and stable identity without a main fallback', async () => {
    const external = sqliteDatabase();
    try {
      external.collection({
        name: 'documents',
        key: externalIdentity.collectionKey,
        fields: [{ name: 'name', type: 'string' }],
      });
      app.dataSourceManager.dataSources.set('external', { collectionManager: { db: external } } as never);
      const externalStore = new AccessConfigStore(db, () =>
        resolveModelMetadata(external.getCollection('documents'), {
          resolveCollectionKey: () => accessCollectionKey(externalIdentity),
        }),
      );
      const config = await externalStore.save(
        externalIdentity,
        { ...initialConfig(), ownership: { enabled: false }, rules: [] },
        { userId: 28 },
      );
      const ctx = context({ ...request(), dataSourceKey: 'external' });
      await invoke(ctx);
      expect(ctx.body).toEqual({ identity: externalIdentity, config });
      app.dataSourceManager.dataSources.delete('external');
      await expect(invoke(context({ ...request(), dataSourceKey: 'external' }))).rejects.toMatchObject({ status: 404 });
    } finally {
      await external.close();
    }
  });

  it('rejects a stale runtime key', async () => {
    collection.options.key = 'replacement';
    await expect(invoke()).rejects.toMatchObject({ status: 409 });
  });

  it('reads rules that reference a registered association without requiring its key to equal the root key', async () => {
    db.collection({
      name: 'participants',
      key: 'participants-key',
      timestamps: false,
      fields: [
        { name: 'tenantId', type: 'string' },
        { name: 'documentId', type: 'bigInt' },
      ],
    });
    collection.setField('participants', { type: 'hasMany', target: 'participants', foreignKey: 'documentId' });
    const input = initialConfig();
    input.rules[0].condition = {
      type: 'exists',
      path: 'participants',
      condition: {
        type: 'compare',
        operator: 'eq',
        left: { type: 'field', path: 'tenantId' },
        right: { type: 'context', path: 'tenant.id' },
      },
    };
    const saved = await store().save(mainIdentity, input, { userId: 28 });
    const ctx = context();
    try {
      await invoke(ctx);
      expect(ctx.body).toEqual({ identity: mainIdentity, config: saved });
    } finally {
      // Only this fixture owns the additional collection.
      if (dialect === 'postgres') await db.sequelize.query('DROP TABLE IF EXISTS "participants"');
    }
  });

  it('rejects a configuration change between the two reads instead of publishing an old version', async () => {
    await store().save(mainIdentity, initialConfig(), { userId: 28 });
    const model = db.getCollection('collections').model;
    const read = model.findOne.bind(model);
    let reads = 0;
    vi.spyOn(model, 'findOne').mockImplementation(async (options) => {
      const record = await read(options);
      if (++reads === 2) {
        const options = structuredClone(record.getDataValue('options'));
        options.tenantAccess.revision += 1;
        record.setDataValue('options', options);
      }
      return record;
    });
    const ctx = context();
    await expect(invoke(ctx)).rejects.toMatchObject({ status: 409, code: 'ACCESS_CONFIG_CONFLICT' });
    expect(ctx.body).toBeUndefined();
  });

  it('rejects missing persistent metadata without guessing a runtime identity', async () => {
    await db.getRepository('collections').destroy({ filterByTk: 'documents' });
    await expect(invoke()).rejects.toMatchObject({ status: 404, code: 'ACCESS_COLLECTION_NOT_FOUND' });
  });

  it('reports a friendly conflict if model metadata changes during the second read', async () => {
    const model = db.getCollection('collections').model;
    const read = model.findOne.bind(model);
    let reads = 0;
    const original = collection.model.rawAttributes.name.field;
    vi.spyOn(model, 'findOne').mockImplementation(async (options) => {
      const record = await read(options);
      if (++reads === 2) collection.model.rawAttributes.name.field = 'changed_name';
      return record;
    });
    const ctx = context();
    try {
      await expect(invoke(ctx)).rejects.toMatchObject({
        status: 409,
        code: 'ACCESS_CONFIG_CONFLICT',
        message: 'translated: The collection or access rules changed. Refresh and try again.',
      });
      expect(ctx.body).toBeUndefined();
    } finally {
      collection.model.rawAttributes.name.field = original;
    }
  });

  it('rejects source replacement during a metadata read', async () => {
    const model = db.getCollection('collections').model;
    const read = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      app.db = sqliteDatabase();
      return read(options);
    });
    try {
      await expect(invoke()).rejects.toMatchObject({ status: 409 });
    } finally {
      if (app.db !== db) await app.db.close();
    }
  });

  it('propagates unexpected database failures', async () => {
    const error = new Error('database failure');
    vi.spyOn(db.getCollection('collections').model, 'findAll').mockRejectedValueOnce(error);
    await expect(invoke()).rejects.toBe(error);
  });
});
