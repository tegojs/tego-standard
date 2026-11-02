import type { Application, Collection, Database } from '@tego/server';

import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import { resolveModelMetadata } from '../../access-control/model-metadata';
import { createAccessConfigRevisions } from '../../actions/access-config-revisions';
import { externalIdentity, initialConfig, mainIdentity, seedConfigStore } from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])(
  'revision management request boundary (%s)',
  (dialect) => {
    let db: Database;
    let collection: Collection;
    let app: Application;
    const request = () => ({ dataSourceKey: 'main', collectionName: 'documents', revision: 1 });
    const context = (values: unknown = request()) => ({
      method: 'POST',
      state: { currentUser: { id: 28 } as { id: number } | null },
      action: { params: { values } },
      body: undefined as unknown,
      t: (message: string) => `translated: ${message}`,
      throw: (status: number, message?: string, properties?: object): never => {
        throw Object.assign(new Error(message), { status, ...properties });
      },
    });
    const invoke = (ctx = context(), type: 'list' | 'draft' = 'draft') =>
      createAccessConfigRevisions(app, type)(ctx as never, async () => {});

    beforeEach(async () => {
      db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
      collection = db.collection({
        name: 'documents',
        key: mainIdentity.collectionKey,
        timestamps: false,
        fields: [{ name: 'tenantId', type: 'string' }],
      });
      await seedConfigStore(db);
      const store = new AccessConfigStore(db, () =>
        resolveModelMetadata(collection, { resolveCollectionKey: () => accessCollectionKey(mainIdentity) }),
      );
      const first = await store.save(mainIdentity, initialConfig(), { userId: 28 });
      await store.save(mainIdentity, { ...first, rules: [] }, { userId: 28 });
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

    it('captures the selection before a real asynchronous metadata query', async () => {
      const input = request();
      db.getCollection('collections').model.addHook('beforeFind', 'change-caller', () => {
        input.collectionName = 'forged';
        input.revision = 2;
      });
      const ctx = context(input);
      await invoke(ctx);
      expect(input.collectionName).toBe('forged');
      expect(ctx.body).toMatchObject({ identity: mainIdentity, sourceRevision: 1, config: { revision: 2 } });
    });

    it('rejects an accessor without evaluating it or publishing a draft', async () => {
      let evaluated = false;
      const input = Object.defineProperty(request(), 'revision', {
        get() {
          evaluated = true;
          return 1;
        },
        enumerable: true,
      });
      const ctx = context(input);
      await expect(invoke(ctx)).rejects.toMatchObject({ status: 400, code: 'INVALID_ACCESS_CONFIG_WRITE' });
      expect(evaluated).toBe(false);
      expect(ctx.body).toBeUndefined();
    });

    it('revalidates historical rules against the current runtime model', async () => {
      collection.removeField('tenantId');
      const ctx = context();
      await expect(invoke(ctx)).rejects.toMatchObject({ status: 400, code: 'INVALID_ACCESS_RULE' });
      expect(ctx.body).toBeUndefined();
      expect(await db.getRepository('tenantAccessRevisions').count()).toBe(2);
    });

    it('rejects a runtime identity change during the last configuration read', async () => {
      let reads = 0;
      db.getCollection('collections').model.addHook('afterFind', 'replace-runtime', (row) => {
        if (row && !Array.isArray(row) && ++reads === 4) collection.options.key = 'replacement';
      });
      const ctx = context();
      await expect(invoke(ctx)).rejects.toMatchObject({ status: 409, code: 'ACCESS_CONFIG_CONFLICT' });
      expect(collection.options.key).toBe('replacement');
      expect(ctx.body).toBeUndefined();
    });

    it('preserves unknown database errors instead of reporting a missing history', async () => {
      const failure = new Error('metadata database offline');
      db.getCollection('collections').model.addHook('beforeFind', 'database-failure', () => {
        throw failure;
      });
      const ctx = context();
      await expect(invoke(ctx)).rejects.toBe(failure);
      expect(ctx.body).toBeUndefined();
    });

    it('also guards dependencies of a disabled historical rule across the final read', async () => {
      const participants = db.collection({
        name: 'participants',
        key: 'participants-key',
        fields: [
          { name: 'tenantId', type: 'string' },
          { name: 'documentId', type: 'bigInt' },
        ],
      });
      collection.setField('participants', { type: 'hasMany', target: 'participants', foreignKey: 'documentId' });
      const store = new AccessConfigStore(db, () =>
        resolveModelMetadata(collection, {
          resolveCollectionKey: (target) =>
            accessCollectionKey({ ...mainIdentity, collectionName: target.name, collectionKey: target.options.key }),
        }),
      );
      const input = initialConfig();
      input.revision = 2;
      input.rules[0].enabled = false;
      input.rules[0].condition = {
        type: 'exists',
        path: 'participants',
        condition: { type: 'isNull', operand: { type: 'field', path: 'tenantId' } },
      };
      const saved = await store.save(mainIdentity, input, { userId: 28 });
      await store.save(mainIdentity, { ...saved, rules: [] }, { userId: 28 });
      let reads = 0;
      db.getCollection('collections').model.addHook('afterFind', 'change-historical-dependency', (row) => {
        if (row && !Array.isArray(row) && ++reads === 4)
          participants.model.rawAttributes.tenantId.field = 'replacement_tenant';
      });
      const ctx = context({ ...request(), revision: 3 });
      await expect(invoke(ctx)).rejects.toMatchObject({ status: 409, code: 'ACCESS_CONFIG_CONFLICT' });
      expect(participants.model.rawAttributes.tenantId.field).toBe('replacement_tenant');
      expect(ctx.body).toBeUndefined();
    });

    it('keeps an external collection history separate from the same-named primary collection', async () => {
      const external = sqliteDatabase();
      try {
        const target = external.collection({ name: 'documents', key: externalIdentity.collectionKey });
        app.dataSourceManager.dataSources.set('external', { collectionManager: { db: external } } as never);
        const store = new AccessConfigStore(db, () =>
          resolveModelMetadata(target, { resolveCollectionKey: () => accessCollectionKey(externalIdentity) }),
        );
        await store.save(
          externalIdentity,
          { ...initialConfig(), ownership: { enabled: false }, rules: [] },
          { userId: 5 },
        );
        const ctx = context({ ...request(), dataSourceKey: 'external' });
        await invoke(ctx);
        expect(ctx.body).toMatchObject({
          identity: externalIdentity,
          sourceRevision: 1,
          config: { revision: 1, rules: [] },
        });
      } finally {
        await external.close();
      }
    });

    it.each(['list', 'draft'] as const)('requires a signed-in POST for %s', async (type) => {
      const ctx = context(type === 'list' ? { dataSourceKey: 'main', collectionName: 'documents' } : request());
      ctx.method = 'GET';
      await expect(invoke(ctx, type)).rejects.toMatchObject({ status: 405 });
      ctx.method = 'POST';
      ctx.state.currentUser = null;
      await expect(invoke(ctx, type)).rejects.toMatchObject({ status: 401 });
      expect(ctx.body).toBeUndefined();
    });
  },
);
