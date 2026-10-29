import { ACL, Resourcer, Transaction, type Collection, type Database } from '@tego/server';

import { AccessAclScopeAdapter } from '../../access-control/acl-scope';
import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { AccessQueryService } from '../../access-control/query';
import { AccessRootMutationHandler } from '../../access-control/root-mutation-handler';
import { seedAclScopes } from './acl-database';
import { mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, queryRows, sqliteDatabase } from './database';
import { configFor, ownerCondition } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;
const actor = () => ({ tenantId: 'B', roleName: 'editor', userId: 28 });

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('attachment removal preparation (%s)', (dialect) => {
  let db: Database;
  let docs: Collection;
  let adapter: AccessAclScopeAdapter;
  let queries: AccessQueryService;
  let handler: AccessRootMutationHandler;
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
    // Only a test observer: proves preparation and consumer failures share the caller's transaction.
    db.collection({ name: 'removalObservations', timestamps: false, fields: [{ name: 'note', type: 'string' }] });
    await db.sync();
    await db.getCollection('tenants').model.bulkCreate(['H', 'B', 'C'].map((id) => ({ id, enabled: true })));
    await docs.model.bulkCreate([
      { id: 1, tenantId: 'B', path: 'original/tenants/B', filename: 'owned.pdf', size: 10, storageId: 18 },
      { id: 2, tenantId: 'H', path: 'original/tenants/H', filename: 'visible.pdf', size: 20, storageId: 18 },
      { id: 3, tenantId: null, path: 'legacy', filename: 'legacy.pdf', size: 30, storageId: 19 },
    ]);
    store = new AccessConfigStore(db, (value) =>
      resolveModelMetadata(db.getCollection(value.collectionName), {
        resolveCollectionKey: (collection) => accessCollectionKey(identity(collection)),
      }),
    );
    const config = configFor(ownerCondition);
    config.rules.push({ ...configFor({ type: 'constant', value: true }, 'visibility').rules[0], id: 'visible' });
    // Even explicit legacy G does not allow direct deletion before an allowed edit claims ownership.
    config.rules.push({
      ...configFor({ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }).rules[0],
      id: 'legacy-owner',
    });
    await store.save(mainIdentity, { ...config, revision: 0 }, { userId: 28 });
    adapter = new AccessAclScopeAdapter(new ACL(), 'main', store, db);
    queries = new AccessQueryService(db, adapter, (collection) => accessCollectionKey(identity(collection)));
    handler = new AccessRootMutationHandler(db, adapter, queries, identity);
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres') await db.sequelize.drop({ cascade: true });
    } finally {
      await db?.close();
    }
  });

  async function context(key: unknown = 1, grant: object = {}, operation = 'destroy', params: object = {}) {
    const acl = new ACL();
    acl.setAvailableAction(operation, {});
    acl.define({ role: 'editor' }).grantAction(`documents:${operation}`, grant);
    const resourcer = new Resourcer();
    resourcer.define({ name: 'documents', actions: { [operation]: {} } });
    const action = resourcer.getAction('documents', operation).clone();
    Object.assign(action, { resourceName: 'documents', actionName: operation });
    action.mergeParams({ resourceName: 'documents', actionName: operation, filterByTk: key, ...params });
    const ctx = {
      db,
      action,
      state: { currentRole: 'editor' },
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

  const transaction = <T>(run: (tx: Transaction) => Promise<T>) =>
    db.sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, run);
  const observations = () => db.getCollection('removalObservations').model;

  describe('native removal predicate preparation', () => {
    const run = <T>(consume: (tx: Transaction) => Promise<T>) =>
      db.sequelize.transaction(
        { type: Transaction.TYPES.IMMEDIATE, isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE },
        consume,
      );
    async function matching(proof: { sql: string; rootAlias: string; transaction: Transaction }) {
      const alias = `"${proof.rootAlias.replaceAll('"', '""')}"`;
      return (
        await queryRows<{ id: number }>(db, `SELECT id FROM "documents" AS ${alias} WHERE ${proof.sql} ORDER BY id`, {
          transaction: proof.transaction,
        })
      ).map((row) => row.id);
    }

    it('binds the final destroy role, G and exact original record in the caller transaction', async () => {
      await docs.model.create({ id: 4, tenantId: 'B', path: 'other', filename: 'other.pdf', size: 10, storageId: 18 });
      const ctx = await context(1, { filter: { size: { $gte: 10 } } });
      await run((tx) =>
        handler.captureAttachmentRemoval(ctx, actor()).withNativePredicate(async (proof) => {
          expect(proof.collection).toBe(docs);
          expect(proof.transaction).toBe(tx);
          expect(Object.isFrozen(proof)).toBe(true);
          expect(await matching(proof)).toEqual([1]);
          await proof.assertCurrent();
        }, tx),
      );
      expect(await docs.model.count()).toBe(4);
    });

    it('quotes original locations as literal values without rewriting dollar tokens', async () => {
      await docs.model.update(
        { path: "original/$tac_0/it's here", filename: "a' OR TRUE -- $tac_1 $$.pdf" },
        { where: { id: 1 }, hooks: false },
      );
      const ctx = await context();
      await run((tx) =>
        handler.captureAttachmentRemoval(ctx, actor()).withNativePredicate(async (proof) => {
          expect(await matching(proof)).toEqual([1]);
        }, tx),
      );
      expect(await docs.model.count()).toBe(3);
    });

    it('rechecks the final decision after asynchronous native scope resolution before publishing the predicate', async () => {
      const ctx = await context();
      const original = queries.resolveNativeScopes.bind(queries);
      vi.spyOn(queries, 'resolveNativeScopes').mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        Object.assign(ctx.permission as object, { can: false, skip: false });
        return result;
      });
      await expect(
        run((tx) =>
          handler.captureAttachmentRemoval(ctx, actor()).withNativePredicate(async () => {
            await observations().create({ note: 'must not consume stale predicate' }, { transaction: tx });
          }, tx),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
      expect(await observations().count()).toBe(0);
      expect(await docs.model.count()).toBe(3);
    });

    it.each([2, 3, 999])('does not issue a native predicate for a visible, legacy or absent record %s', async (key) => {
      const ctx = await context(key);
      await expect(
        run((tx) => handler.captureAttachmentRemoval(ctx, actor()).withNativePredicate(async () => undefined, tx)),
      ).rejects.toMatchObject({ code: key === 3 ? 'LEGACY_DATA_READ_ONLY' : 'ACCESS_RECORD_UNAVAILABLE' });
    });

    it.each([{ path: 'different' }, { filename: 'different.pdf' }, { size: 99 }, { storageId: 99 }, { tenantId: 'C' }])(
      'includes original location and actual owner in SQL even with unrestricted G: %j',
      async (values) => {
        const saved = await store.read(mainIdentity);
        await store.save(
          mainIdentity,
          { ...configFor({ type: 'constant', value: true }), revision: saved!.revision },
          { userId: 28 },
        );
        const ctx = await context();
        let entered = false;
        await expect(
          run((tx) =>
            handler.captureAttachmentRemoval(ctx, actor()).withNativePredicate(async (proof) => {
              entered = true;
              await docs.model.update(values, { where: { id: 1 }, transaction: tx, hooks: false });
              expect(await matching(proof)).toEqual([]);
            }, tx),
          ),
        ).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        expect(entered).toBe(true);
        expect((await docs.model.findByPk(1)).getDataValue('tenantId')).toBe('B');
        expect((await docs.model.findByPk(1)).getDataValue('path')).toBe('original/tenants/B');
      },
    );

    it.each(['decision', 'filter', 'phase', 'delete'])(
      'keeps the original preparation contract after %s drift',
      async (kind) => {
        const ctx = await context();
        let entered = false;
        await expect(
          run((tx) =>
            handler.captureAttachmentRemoval(ctx, actor()).withNativePredicate(async (proof) => {
              entered = true;
              expect(await matching(proof)).toEqual([1]);
              await observations().create({ note: 'rollback native preparation' }, { transaction: tx });
              if (kind === 'decision') Object.assign(ctx.permission as object, { can: false, skip: false });
              if (kind === 'filter')
                Object.assign((ctx.permission as { parsedParams: object }).parsedParams, { filter: { id: 2 } });
              if (kind === 'phase') {
                adapter.release(ctx);
                await adapter.prepare(ctx, [mainIdentity]);
              }
              if (kind === 'delete') await docs.model.destroy({ where: { id: 1 }, transaction: tx, hooks: false });
            }, tx),
          ),
        ).rejects.toMatchObject({ code: kind === 'delete' ? 'ACCESS_RECORD_UNAVAILABLE' : 'INVALID_ACCESS_MUTATION' });
        expect(entered).toBe(true);
        expect(await observations().count()).toBe(0);
        expect(await docs.model.count()).toBe(3);
      },
    );

    it('expires the native proof and shares the entry single-use limit with ordinary preparation', async () => {
      const ctx = await context();
      const entry = handler.captureAttachmentRemoval(ctx, actor());
      let expired: () => Promise<void>;
      await run(async (tx) => {
        await entry.withNativePredicate(async (proof) => {
          expired = proof.assertCurrent;
          expect(await matching(proof)).toEqual([1]);
        }, tx);
        await expect(expired!()).rejects.toMatchObject({ code: 'INVALID_ACCESS_MUTATION' });
        await expect(entry.withRecord(async () => undefined, tx)).rejects.toMatchObject({
          code: 'INVALID_ACCESS_MUTATION',
        });
      });
    });

    it.skipIf(dialect !== 'postgres').each(['G scalar', 'G relation', 'role relation'])(
      'evaluates all %s facts instead of merely matching tenantId and location',
      async (change) => {
        docs.setField('allowDelete', { type: 'boolean' });
        await db.sequelize.query('ALTER TABLE "documents" ADD COLUMN "allowDelete" BOOLEAN DEFAULT TRUE');
        const facts = db.collection({
          name: 'removalFacts',
          timestamps: false,
          fields: [
            { name: 'documentId', type: 'integer' },
            { name: 'allowed', type: 'boolean' },
            { name: 'authorized', type: 'boolean' },
          ],
        });
        docs.setField('facts', {
          type: 'hasMany',
          target: 'removalFacts',
          foreignKey: 'documentId',
          onDelete: 'RESTRICT',
        });
        await facts.model.sync();
        await facts.model.create({ documentId: 1, allowed: true, authorized: true });
        const saved = await store.read(mainIdentity);
        await store.save(
          mainIdentity,
          {
            ...configFor({
              type: 'all',
              children: [
                ownerCondition,
                {
                  type: 'compare',
                  operator: 'eq',
                  left: { type: 'field', path: 'allowDelete' },
                  right: { type: 'literal', value: true },
                },
                {
                  type: 'exists',
                  path: 'facts',
                  condition: {
                    type: 'compare',
                    operator: 'eq',
                    left: { type: 'field', path: 'allowed' },
                    right: { type: 'literal', value: true },
                  },
                },
              ],
            }),
            revision: saved!.revision,
          },
          { userId: 28 },
        );
        const ctx = await context(1, { filter: { facts: { authorized: true } } });
        let entered = false;
        await expect(
          run((tx) =>
            handler.captureAttachmentRemoval(ctx, actor()).withNativePredicate(async (proof) => {
              entered = true;
              expect(await matching(proof)).toEqual([1]);
              if (change === 'G scalar')
                await docs.model.update({ allowDelete: false }, { where: { id: 1 }, transaction: tx, hooks: false });
              else
                await facts.model.update(change === 'G relation' ? { allowed: false } : { authorized: false }, {
                  where: { documentId: 1 },
                  transaction: tx,
                  hooks: false,
                });
              expect(await matching(proof)).toEqual([]);
            }, tx),
          ),
        ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
        expect(entered).toBe(true);
        expect((await facts.model.findOne()).getDataValue('allowed')).toBe(true);
        expect((await facts.model.findOne()).getDataValue('authorized')).toBe(true);
      },
    );
  });

  it('prepares the owned raw location without deleting or changing the file row', async () => {
    const ctx = await context(1, { fields: [] });
    const result = await transaction(async (tx) =>
      handler.captureAttachmentRemoval(ctx, actor()).withRecord(async (proof) => {
        expect(proof.collection).toBe(docs);
        expect(proof.transaction).toBe(tx);
        await proof.assertCurrent();
        return proof.record;
      }, tx),
    );
    expect(result).toEqual({
      key: 1,
      path: 'original/tenants/B',
      filename: 'owned.pdf',
      size: 10,
      storageId: 18,
    });
    expect((await docs.model.findByPk(1)).getDataValue('tenantId')).toBe('B');
    expect(await docs.model.count()).toBe(3);
  });

  it.each([2, 3, 999])('never prepares visible-only, unassigned or absent record %s', async (key) => {
    const ctx = await context(key);
    await expect(
      transaction((tx) =>
        handler.captureAttachmentRemoval(ctx, actor()).withRecord(async () => {
          await observations().create({ note: 'unexpected' }, { transaction: tx });
        }, tx),
      ),
    ).rejects.toThrow();
    expect(await observations().count()).toBe(0);
    expect(await docs.model.count()).toBe(3);
  });

  it('intersects final destroy role conditions with G', async () => {
    const ctx = await context(1, { filter: { id: 2 } });
    await expect(
      transaction((tx) => handler.captureAttachmentRemoval(ctx, actor()).withRecord(async () => undefined, tx)),
    ).rejects.toMatchObject({ code: 'ACCESS_RECORD_UNAVAILABLE' });
  });

  it.each(['get', 'update', 'download'])('cannot borrow the %s action decision', async (operation) => {
    const ctx = await context(1, {}, operation);
    expect(() => handler.captureAttachmentRemoval(ctx, actor())).toThrow();
  });

  it('rejects final denied destroy decisions', async () => {
    const ctx = await context();
    Object.assign(ctx.permission as object, { can: false, skip: false });
    expect(() => handler.captureAttachmentRemoval(ctx, actor())).toThrow();
  });

  it.each([{ path: 'other' }, { storageId: 19 }, { values: {} }, { filter: { id: 1 } }, { appends: ['storage'] }])(
    'rejects request-provided removal options %j',
    async (params) => {
      const ctx = await context(1, {}, 'destroy', params);
      expect(() => handler.captureAttachmentRemoval(ctx, actor())).toThrow();
    },
  );

  it.each([undefined, '_', [1], { id: 1 }])('rejects unsupported locators %j', async (key) => {
    const ctx = await context();
    (ctx.permission as { rawParams: { filterByTk: unknown } }).rawParams.filterByTk = key;
    expect(() => handler.captureAttachmentRemoval(ctx, actor())).toThrow();
  });

  it.each(['decision', 'fields', 'filter', 'location', 'record', 'phase'])(
    'rolls back consumer work after %s drift',
    async (kind) => {
      const ctx = await context();
      await expect(
        transaction((tx) =>
          handler.captureAttachmentRemoval(ctx, actor()).withRecord(async () => {
            await observations().create({ note: 'must rollback' }, { transaction: tx });
            if (kind === 'decision') Object.assign(ctx.permission as object, { can: false, skip: false });
            if (kind === 'fields')
              Object.assign((ctx.permission as { parsedParams: object }).parsedParams, { fields: ['id'] });
            if (kind === 'filter')
              Object.assign((ctx.permission as { parsedParams: object }).parsedParams, { filter: { id: 2 } });
            if (kind === 'location')
              await docs.model.update({ path: 'replaced' }, { where: { id: 1 }, transaction: tx, hooks: false });
            if (kind === 'record') await docs.model.destroy({ where: { id: 1 }, transaction: tx, hooks: false });
            if (kind === 'phase') await adapter.prepare(ctx, [mainIdentity]);
          }, tx),
        ),
      ).rejects.toThrow();
      expect(await observations().count()).toBe(0);
      expect((await docs.model.findByPk(1)).getDataValue('path')).toBe('original/tenants/B');
    },
  );

  it('does not consume location metadata without a current authenticated tenant', async () => {
    const ctx = await context();
    await expect(
      transaction((tx) =>
        handler.captureAttachmentRemoval(ctx, { roleName: 'editor', userId: 28 }).withRecord(async () => {
          await observations().create({ note: 'unexpected' }, { transaction: tx });
        }, tx),
      ),
    ).rejects.toThrow();
    expect(await observations().count()).toBe(0);
  });

  it('rejects reference cascades before a consumer can prepare removal work', async () => {
    db.collection({
      name: 'dependents',
      timestamps: false,
      fields: [{ name: 'document', type: 'belongsTo', target: 'documents', onDelete: 'CASCADE' }],
    });
    await db.getCollection('dependents').model.sync();
    const ctx = await context();
    await expect(
      transaction((tx) =>
        handler.captureAttachmentRemoval(ctx, actor()).withRecord(async () => {
          await observations().create({ note: 'unexpected' }, { transaction: tx });
        }, tx),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ACCESS_MUTATION' });
    expect(await observations().count()).toBe(0);
    expect(await docs.model.count()).toBe(3);
  });

  it('rolls back consumer errors and expires the escaped proof', async () => {
    const ctx = await context();
    let assertExpired: () => Promise<void>;
    await expect(
      transaction((tx) =>
        handler.captureAttachmentRemoval(ctx, actor()).withRecord(async (proof) => {
          assertExpired = proof.assertCurrent;
          await observations().create({ note: 'must rollback' }, { transaction: tx });
          throw new Error('consumer failed');
        }, tx),
      ),
    ).rejects.toThrow('consumer failed');
    await expect(assertExpired!()).rejects.toThrow();
    expect(await observations().count()).toBe(0);
    expect(await docs.model.count()).toBe(3);
  });

  it.each([{ size: -1 }, { storageId: null }, { filename: null }])(
    'rejects invalid persisted removal metadata %j before consuming it',
    async (values) => {
      await docs.model.update(values, { where: { id: 1 }, hooks: false });
      const ctx = await context();
      await expect(
        transaction((tx) =>
          handler.captureAttachmentRemoval(ctx, actor()).withRecord(async () => {
            await observations().create({ note: 'unexpected' }, { transaction: tx });
          }, tx),
        ),
      ).rejects.toThrow();
      expect(await observations().count()).toBe(0);
    },
  );

  it('does not coerce a complex REST locator to the selected record', async () => {
    const ctx = await context();
    let coerced = false;
    (ctx.permission as { rawParams: { resourceIndex?: unknown } }).rawParams.resourceIndex = {
      toString() {
        coerced = true;
        return '1';
      },
    };
    expect(() => handler.captureAttachmentRemoval(ctx, actor())).toThrow();
    expect(coerced).toBe(false);
  });

  it('uses raw persisted metadata instead of presentation getters', async () => {
    const ctx = await context();
    docs.model.rawAttributes.path.get = () => 'presentation-path';
    docs.model.refreshAttributes();
    expect((await docs.model.findByPk(1)).get('path')).toBe('presentation-path');
    const path = await transaction((tx) =>
      handler.captureAttachmentRemoval(ctx, actor()).withRecord(async (proof) => proof.record.path, tx),
    );
    expect(path).toBe('original/tenants/B');
  });

  it('rejects ownership drift even when G includes the new owner', async () => {
    const saved = await store.read(mainIdentity);
    await store.save(
      mainIdentity,
      { ...configFor({ type: 'constant', value: true }), revision: saved!.revision },
      { userId: 28 },
    );
    const ctx = await context();
    await expect(
      transaction((tx) =>
        handler.captureAttachmentRemoval(ctx, actor()).withRecord(async () => {
          await docs.model.update({ tenantId: 'C' }, { where: { id: 1 }, transaction: tx, hooks: false });
        }, tx),
      ),
    ).rejects.toThrow();
    expect((await docs.model.findByPk(1)).getDataValue('tenantId')).toBe('B');
  });

  it.skipIf(dialect !== 'postgres')(
    'holds the actual file row lock until the caller transaction finishes',
    async () => {
      const ctx = await context();
      let contender: Promise<unknown> | undefined;
      try {
        await transaction((tx) =>
          handler.captureAttachmentRemoval(ctx, actor()).withRecord(async (proof) => {
            contender = docs.model.update({ path: 'after-commit' }, { where: { id: 1 }, hooks: false });
            void contender.catch(() => {});
            await vi.waitFor(
              async () => {
                const [rows] = await db.sequelize.query(
                  "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'UPDATE %documents%';",
                );
                expect(rows).toHaveLength(1);
              },
              { timeout: 3000, interval: 25 },
            );
            await proof.assertCurrent();
            expect(proof.record.path).toBe('original/tenants/B');
          }, tx),
        );
      } finally {
        await contender;
      }
      expect((await docs.model.findByPk(1)).getDataValue('path')).toBe('after-commit');
    },
  );

  it('requires an active write transaction before consuming metadata', async () => {
    const ctx = await context();
    const entry = handler.captureAttachmentRemoval(ctx, actor());
    await expect(entry.withRecord(async () => undefined, undefined!)).rejects.toThrow();
  });

  it('expires the proof and never reuses an entry', async () => {
    const ctx = await context();
    const entry = handler.captureAttachmentRemoval(ctx, actor());
    let assertExpired: () => Promise<void>;
    await transaction(async (tx) => {
      await entry.withRecord(async (proof) => {
        assertExpired = proof.assertCurrent;
      }, tx);
      await expect(assertExpired!()).rejects.toThrow();
      await expect(entry.withRecord(async () => undefined, tx)).rejects.toThrow();
    });
    expect(await docs.model.count()).toBe(3);
  });
});
