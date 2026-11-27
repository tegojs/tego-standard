import { ACL, Resourcer, type Collection, type Database, type Transaction } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootReadHandler } from '../../access-control/root-read-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const actor = () => ({ tenantId: 'B', roleName: 'reader', userId: 28 });
const fields = ['id', 'path', 'filename', 'size', 'storageId'];

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('attachment read entry (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let handler: AccessRootReadHandler;
  let store: AccessConfigStore;
  const identity = (collection: Collection) =>
    collection.name === 'documents'
      ? mainIdentity
      : { ...mainIdentity, collectionName: collection.name, collectionKey: `${collection.name}-key` };

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    await seedAclScopes(db);
    docs = db.collection({
      name: 'documents',
      template: 'file',
      timestamps: false,
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tenantId', type: 'string' },
        { name: 'path', type: 'string' },
        { name: 'filename', type: 'string' },
        { name: 'size', type: 'integer' },
        { name: 'storageId', type: 'integer' },
        { name: 'viewable', type: 'boolean' },
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
    await db.getCollection('tenants').model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', path: 'old/tenants/B', filename: 'owned.txt', size: 10, storageId: 18 },
      { id: 2, tenantId: 'H', path: 'old/tenants/H', filename: 'visible.txt', size: 20, storageId: 18, viewable: true },
      { id: 3, tenantId: 'C', path: 'old/tenants/C', filename: 'hidden.txt', size: 30, storageId: 19 },
      { id: 4, tenantId: null, path: 'legacy', filename: 'legacy.txt', size: 40, storageId: 18, viewable: true },
    ]);
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    const config = configFor(ownerCondition);
    config.rules.push({
      ...configFor(
        {
          type: 'compare',
          operator: 'eq',
          left: { type: 'field', path: 'viewable' },
          right: { type: 'literal', value: true },
        },
        'visibility',
      ).rules[0],
      id: 'visible',
    });
    await store.save(mainIdentity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    handler = new AccessRootReadHandler(
      db,
      adapter,
      new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection))),
      identity,
    );
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres') await db.sequelize.drop({ cascade: true });
    } finally {
      await db?.close();
    }
  });

  async function context(key: unknown = 1, grant: object = { fields }, operation = 'download', params: object = {}) {
    const acl = new ACL();
    acl.setAvailableAction(operation, {});
    acl.define({ role: 'reader' }).grantAction(`documents:${operation}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: 'documents', actions: { [operation]: {} } });
    const action = resourcer.getAction('documents', operation).clone();
    Object.assign(action, { resourceName: 'documents', actionName: operation });
    action.mergeParams({ resourceName: 'documents', actionName: operation, filterByTk: key, ...params });
    const ctx = {
      db,
      action,
      state: { currentRole: 'reader' },
      get: () => '+08:00',
      logger: { info() {} },
      throw(status: number) {
        throw new Error(String(status));
      },
      permission: undefined as unknown,
    };
    await acl.middleware()(ctx as never, async () => {});
    await adapter.prepare(ctx, [mainIdentity]);
    return ctx;
  }

  function capture(ctx: Awaited<ReturnType<typeof context>>, authenticated = actor()) {
    return handler.captureAttachment(ctx, authenticated);
  }

  it.each([1, 2, 4])('reads authorized raw metadata without claiming or changing record %s', async (key) => {
    const before = (await docs.model.findByPk(key)).getDataValue('tenantId');
    const entry = capture(await context(key));
    const record = await entry.withRecord(async (proof) => {
      await proof.assertCurrent();
      return proof.record;
    });
    expect(record.key).toBe(key);
    expect(record.storageId).toBe(18);
    expect(record.path).toBe(key === 1 ? 'old/tenants/B' : key === 2 ? 'old/tenants/H' : 'legacy');
    expect(Object.keys(record).sort()).toEqual(['filename', 'key', 'path', 'size', 'storageId']);
    expect((await docs.model.findByPk(key)).getDataValue('tenantId')).toBe(before);
  });

  it.each([3, 999])('does not consume hidden or absent record %s', async (key) => {
    const ctx = await context(key);
    let consumed = false;
    await expect(
      (async () =>
        capture(ctx).withRecord(async () => {
          consumed = true;
        }))(),
    ).rejects.toThrow();
    expect(consumed).toBe(false);
  });

  it('intersects a role row condition with visibility', async () => {
    const ctx = await context(2, { fields, filter: { id: 1 } });
    let consumed = false;
    await expect(
      (async () =>
        capture(ctx).withRecord(async () => {
          consumed = true;
        }))(),
    ).rejects.toThrow();
    expect(consumed).toBe(false);
  });

  it('does not borrow a get decision for the download operation', async () => {
    const ctx = await context(1, { fields }, 'get');
    expect(() => capture(ctx)).toThrow();
  });

  it('rejects a final denied decision even for an owned record', async () => {
    const ctx = await context();
    (ctx.permission as { can: unknown; skip?: boolean }).can = false;
    (ctx.permission as { skip?: boolean }).skip = false;
    expect(() => capture(ctx)).toThrow();
  });

  it.each(fields)('requires the actual raw metadata field %s to be readable', async (denied) => {
    const ctx = await context(1, { fields: fields.filter((field) => field !== denied) });
    await expect((async () => capture(ctx).withRecord(async () => undefined))()).rejects.toThrow();
  });

  it.each([{ path: '../secret' }, { storageId: 19 }, { fields: ['path'] }, { appends: ['storage'] }])(
    'rejects request-provided content options %j',
    async (params) => {
      const ctx = await context(1, { fields }, 'download', params);
      expect(() => capture(ctx)).toThrow();
    },
  );

  it.each([undefined, '_', [1, 2]])('rejects a missing or unsupported record key %j', async (key) => {
    const ctx = await context();
    (ctx.permission as { rawParams: { filterByTk: unknown } }).rawParams.filterByTk = key;
    expect(() => capture(ctx)).toThrow();
  });

  it('does not coerce an object REST locator into an authorized key', async () => {
    const ctx = await context();
    let coerced = false;
    (ctx.permission as { rawParams: { resourceIndex?: unknown } }).rawParams.resourceIndex = {
      toString() {
        coerced = true;
        return '1';
      },
    };
    expect(() => capture(ctx)).toThrow();
    expect(coerced).toBe(false);
  });

  it('accepts a matching scalar REST locator', async () => {
    const ctx = await context(1, { fields }, 'download', { resourceIndex: '1' });
    expect(await capture(ctx).withRecord(async (proof) => proof.record.key)).toBe(1);
  });

  it('reads raw stored locations rather than presentation getters', async () => {
    docs.model.rawAttributes.path.get = () => 'not-the-stored-path';
    docs.model.refreshAttributes();
    expect((await docs.model.findByPk(2)).get('path')).toBe('not-the-stored-path');
    expect(await capture(await context(2)).withRecord(async (proof) => proof.record.path)).toBe('old/tenants/H');
  });

  it('supports an actual read-only transaction and rejects a later ended transaction', async () => {
    const ctx = await context();
    let transaction: Transaction | undefined;
    try {
      transaction = await db.sequelize.transaction();
      if (dialect === 'postgres') await db.sequelize.query('SET TRANSACTION READ ONLY', { transaction });
      expect(
        await capture(ctx).withRecord(async (proof) => {
          await proof.assertCurrent();
          return proof.record.key;
        }, transaction),
      ).toBe(1);
      await transaction.commit();
      await expect(capture(ctx).withRecord(async () => undefined, transaction)).rejects.toThrow();
    } finally {
      if (transaction && !(transaction as Transaction & { finished?: string }).finished) await transaction.rollback();
    }
  });

  it.each(['template', 'mapping'])('rejects changed source %s before using the stored location', async (change) => {
    const entry = capture(await context());
    await expect(
      entry.withRecord(async (proof) => {
        if (change === 'template') docs.options.template = 'general';
        else docs.model.rawAttributes.path.field = 'different_column';
        await proof.assertCurrent();
      }),
    ).rejects.toThrow();
  });

  it('rechecks the active tenant before content release', async () => {
    const entry = capture(await context());
    await expect(
      entry.withRecord(async (proof) => {
        await db.getCollection('tenants').model.update({ enabled: false }, { where: { id: 'B' } });
        await proof.assertCurrent();
      }),
    ).rejects.toThrow();
  });

  it('rechecks a visibility withdrawal before releasing bytes', async () => {
    const entry = capture(await context(2));
    await expect(
      entry.withRecord(async (proof) => {
        await docs.model.update({ viewable: false }, { where: { id: 2 } });
        await proof.assertCurrent();
      }),
    ).rejects.toThrow();
  });

  it.each([{ filename: 'replacement.txt' }, { storageId: 19 }, { path: 'replacement' }, { size: 21 }])(
    'rejects changed stored location %j after an await',
    async (values) => {
      const entry = capture(await context(2));
      await expect(
        entry.withRecord(async (proof) => {
          await docs.model.update(values, { where: { id: 2 } });
          await proof.assertCurrent();
        }),
      ).rejects.toThrow();
    },
  );

  it('rejects changed final fields and an ended preparation phase', async () => {
    const ctx = await context();
    await expect(
      capture(ctx).withRecord(async (proof) => {
        (ctx.permission as { parsedParams: { fields: string[] } }).parsedParams.fields = [];
        await proof.assertCurrent();
      }),
    ).rejects.toThrow();
    const next = await context();
    await expect(
      capture(next).withRecord(async (proof) => {
        await adapter.prepare(next, [mainIdentity]);
        await proof.assertCurrent();
      }),
    ).rejects.toThrow();
  });

  it('prevents request or identity mutation from selecting a different tenant record', async () => {
    const ctx = await context();
    const authenticated = actor();
    const entry = capture(ctx, authenticated);
    authenticated.tenantId = 'C';
    (ctx.permission as { rawParams: { filterByTk: unknown } }).rawParams.filterByTk = 3;
    expect(await entry.withRecord(async (proof) => proof.record.key)).toBe(1);
  });

  it('invalidates the proof after the callback and forbids replaying the entry', async () => {
    const entry = capture(await context());
    const proof = await entry.withRecord(async (proof) => proof);
    await expect(proof.assertCurrent()).rejects.toThrow();
    await expect(entry.withRecord(async () => undefined)).rejects.toThrow();
  });
});
