import type { Application, Collection, Database } from '@tego/server';

import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { createAccessConfigValidation } from '../../actions/validate-access-config';
import { externalIdentity, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const request = () => ({ dataSourceKey: 'main', collectionName: 'documents', config: initialConfig() });

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('configuration validation action (%s)', (dialect) => {
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
  const invoke = (ctx = context()) => createAccessConfigValidation(app)(ctx as never, async () => {});
  const store = () =>
    new AccessConfigStore(db, () =>
      resolveModelMetadata(collection, {
        resolveCollectionKey: (target) =>
          accessCollectionKey({ ...mainIdentity, collectionName: target.name, collectionKey: target.options.key }),
      }),
    );

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
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

  it('validates new rules without writes, runtime activation or incrementing the base revision', async () => {
    const sql: string[] = [];
    db.sequelize.options.logging = (query: string) => sql.push(query);
    const ctx = context();
    await invoke(ctx);
    expect(ctx.body).toEqual({ identity: mainIdentity, config: initialConfig() });
    expect(sql.every((query) => !/\b(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i.test(query))).toBe(true);
    expect(await store().read(mainIdentity)).toBeNull();
    expect(await db.getRepository('tenantAccessRevisions').count()).toBe(0);
    expect(collection.options).not.toHaveProperty('tenantAccess');
  });

  it('checks the base revision but does not overwrite an existing configuration', async () => {
    const saved = await store().save(mainIdentity, initialConfig(), { userId: 28 });
    await expect(invoke()).rejects.toMatchObject({ status: 409, code: 'ACCESS_CONFIG_CONFLICT' });
    const ctx = context({ ...request(), config: { ...saved, rules: [] } });
    await invoke(ctx);
    expect(ctx.body).toEqual({ identity: mainIdentity, config: { ...saved, rules: [] } });
    expect(await store().read(mainIdentity)).toEqual(saved);
    expect(await db.getRepository('tenantAccessRevisions').count()).toBe(1);
  });

  it.each([
    null,
    [],
    {},
    { ...request(), dataSourceKey: '' },
    { ...request(), collectionKey: 'forged' },
    { ...request(), config: undefined },
  ])('rejects malformed selections before querying: %j', async (values) => {
    const read = vi.spyOn(db.getCollection('collections').model, 'findAll');
    await expect(invoke(context(values))).rejects.toMatchObject({ status: 400 });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { ...initialConfig(), schemaVersion: 2 },
    { ...initialConfig(), revision: -1 },
    { ...initialConfig(), ownership: { enabled: 'yes' } },
    {
      ...initialConfig(),
      rules: [
        { ...initialConfig().rules[0], condition: { type: 'isNull', operand: { type: 'field', path: 'missing' } } },
      ],
    },
  ])('validates rule shape and fields against trusted metadata: %j', async (config) => {
    await expect(invoke(context({ ...request(), config }))).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_ACCESS_RULE',
      message: 'translated: Access rule validation failed. Check rule conditions and collection fields.',
    });
    expect(await store().read(mainIdentity)).toBeNull();
  });

  it('rejects nested accessors and cycles without invoking request code', async () => {
    const values = request();
    const getter = vi.fn();
    Object.defineProperty(values.config.rules[0], 'name', { get: getter });
    await expect(invoke(context(values))).rejects.toMatchObject({ status: 400 });
    expect(getter).not.toHaveBeenCalled();
    const cyclic = request();
    Object.assign(cyclic.config, { cycle: cyclic.config });
    await expect(invoke(context(cyclic))).rejects.toMatchObject({ status: 400 });
  });

  it('captures all request values before awaiting and never uses a request-supplied database', async () => {
    const values = request();
    const original = structuredClone(values.config);
    const model = db.getCollection('collections').model;
    const read = model.findAll.bind(model);
    vi.spyOn(model, 'findAll').mockImplementationOnce(async (options) => {
      values.dataSourceKey = 'external';
      values.collectionName = 'other';
      values.config.rules = [];
      return read(options);
    });
    const ctx = {
      ...context(values),
      db: {
        getCollection: () => {
          throw new Error('untrusted');
        },
      },
    };
    await invoke(ctx);
    expect(ctx.body).toEqual({ identity: mainIdentity, config: original });
  });

  it('requires authentication and POST before reading metadata', async () => {
    const read = vi.spyOn(db.getCollection('collections').model, 'findAll');
    const ctx = context();
    ctx.state.currentUser = undefined as never;
    await expect(invoke(ctx)).rejects.toMatchObject({ status: 401 });
    const get = context();
    get.method = 'GET';
    await expect(invoke(get)).rejects.toMatchObject({ status: 405 });
    expect(read).not.toHaveBeenCalled();
  });

  it('validates external same-named collections independently and does not fall back to main', async () => {
    const external = sqliteDatabase();
    try {
      external.collection({
        name: 'documents',
        key: externalIdentity.collectionKey,
        fields: [{ name: 'externalTitle', type: 'string' }],
      });
      app.dataSourceManager.dataSources.set('external', { collectionManager: { db: external } } as never);
      const config = { ...initialConfig(), ownership: { enabled: false }, rules: [] };
      const ctx = context({ ...request(), dataSourceKey: 'external', config });
      await invoke(ctx);
      expect(ctx.body).toEqual({ identity: externalIdentity, config });
      await expect(invoke(context({ ...request(), dataSourceKey: 'external' }))).rejects.toMatchObject({ status: 400 });
      app.dataSourceManager.dataSources.delete('external');
      await expect(invoke(context({ ...request(), dataSourceKey: 'external', config }))).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      await external.close();
    }
  });

  it('rejects a configuration change during inspection', async () => {
    await store().save(mainIdentity, initialConfig(), { userId: 28 });
    const model = db.getCollection('collections').model;
    const read = model.findOne.bind(model);
    let reads = 0;
    vi.spyOn(model, 'findOne').mockImplementation(async (options) => {
      const record = await read(options);
      if (++reads === 2) {
        const options = structuredClone(record.getDataValue('options'));
        options.tenantAccess.revision++;
        record.setDataValue('options', options);
      }
      return record;
    });
    await expect(invoke(context({ ...request(), config: { ...initialConfig(), revision: 1 } }))).rejects.toMatchObject({
      status: 409,
    });
  });

  it('rechecks metadata used only by the proposed rules before returning success', async () => {
    const values = request();
    values.config.rules[0].condition = { type: 'isNull', operand: { type: 'field', path: 'name' } };
    const model = db.getCollection('collections').model;
    const read = model.findOne.bind(model);
    let reads = 0;
    const original = collection.model.rawAttributes.name.field;
    vi.spyOn(model, 'findOne').mockImplementation(async (options) => {
      const record = await read(options);
      if (++reads === 2) collection.model.rawAttributes.name.field = 'replacement_name';
      return record;
    });
    try {
      await expect(invoke(context(values))).rejects.toMatchObject({
        status: 409,
        message: 'translated: The collection or access rules changed. Refresh and try again.',
      });
    } finally {
      collection.model.rawAttributes.name.field = original;
    }
  });

  it.each(['field', 'key'] as const)(
    'also rechecks association %s referenced by a disabled proposed rule',
    async (change) => {
      const participants = db.collection({
        name: 'participants',
        key: 'participants-key',
        timestamps: false,
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'documentId', type: 'bigInt' },
        ],
      });
      collection.setField('participants', { type: 'hasMany', target: 'participants', foreignKey: 'documentId' });
      const values = request();
      values.config.rules[0].enabled = false;
      values.config.rules[0].condition = {
        type: 'exists',
        path: 'participants',
        condition: { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
      };
      const model = db.getCollection('collections').model;
      const read = model.findOne.bind(model);
      let reads = 0;
      const original = participants.model.rawAttributes.tenantId.field;
      vi.spyOn(model, 'findOne').mockImplementation(async (options) => {
        const record = await read(options);
        if (++reads === 2) {
          if (change === 'key') participants.options.key = 'replacement-participants-key';
          else participants.model.rawAttributes.tenantId.field = 'replacement_tenant';
        }
        return record;
      });
      try {
        await expect(invoke(context(values))).rejects.toMatchObject({ status: 409 });
      } finally {
        participants.model.rawAttributes.tenantId.field = original;
        participants.options.key = 'participants-key';
      }
    },
  );

  it('rejects a replaced runtime identity and propagates unexpected database failures', async () => {
    collection.options.key = 'replacement';
    await expect(invoke()).rejects.toMatchObject({ status: 409 });
    collection.options.key = mainIdentity.collectionKey;
    const error = new Error('database failure');
    vi.spyOn(db.getCollection('collections').model, 'findAll').mockRejectedValueOnce(error);
    await expect(invoke()).rejects.toBe(error);
  });
});
