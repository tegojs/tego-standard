import { Database } from '@tego/server';

import { accessCollectionKey, AccessConfigStore } from '../../access-control/config-store';
import {
  configStore,
  externalIdentity,
  initialConfig,
  mainIdentity,
  registerConfigModels,
  seedConfigStore,
} from './config-database';
import { isolatedPostgresDatabase, sqliteDatabase } from './database';
import { documents } from './fixtures';

const postgresUrl = process.env.TENANT_ACCESS_TEST_DATABASE_URL;

describe.each(['sqlite', ...(postgresUrl ? ['postgres'] : [])])('read-only access revision drafts (%s)', (dialect) => {
  let db: Database;
  let store: AccessConfigStore;

  beforeEach(async () => {
    db = dialect === 'postgres' ? isolatedPostgresDatabase(postgresUrl!) : sqliteDatabase();
    await seedConfigStore(db);
    store = configStore(db);
  });

  afterEach(async () => {
    try {
      if (dialect === 'postgres')
        await db.sequelize.query(
          'DROP TABLE IF EXISTS "access_config_collections", "access_config_dataSourcesCollections", "tenantAccessRevisions"',
        );
    } finally {
      await db?.close();
    }
  });

  async function revisions() {
    const first = await store.save(mainIdentity, initialConfig(), { userId: 28 });
    const second = await store.save(mainIdentity, { ...first, rules: [] }, { userId: 16 });
    await store.save(mainIdentity, { ...second, ownership: { enabled: false } }, { userId: 9 });
    await store.save(externalIdentity, { ...initialConfig(), rules: [] }, { userId: 5 });
    return first;
  }

  it('pages only revision summaries for the exact persistent collection', async () => {
    await revisions();
    const page = await store.listRevisions(mainIdentity, 2);
    expect(page.revisions).toEqual([
      { revision: 3, actorUserId: '9', savedAt: expect.any(String) },
      { revision: 2, actorUserId: '16', savedAt: expect.any(String) },
    ]);
    expect(page.nextBefore).toBe(2);
    expect(await store.listRevisions(mainIdentity, 2, page.nextBefore)).toMatchObject({
      revisions: [{ revision: 1, actorUserId: '28' }],
      nextBefore: null,
    });
    expect(await store.listRevisions(externalIdentity)).toMatchObject({
      revisions: [{ revision: 1, actorUserId: '5' }],
      nextBefore: null,
    });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.revisions[0])).toBe(true);
    expect(Number.isFinite(Date.parse(page.revisions[0].savedAt))).toBe(true);
  });

  it('restores old content as a current-base draft without changing configuration or audit', async () => {
    const first = await revisions();
    const before = await db.getRepository('tenantAccessRevisions').find({ sort: ['id'] });
    const current = await store.read(mainIdentity);
    const draft = await store.revisionDraft(mainIdentity, 1);
    expect(draft).toEqual({ sourceRevision: 1, config: { ...first, revision: 3 } });
    expect(Object.isFrozen(draft.config.rules[0])).toBe(true);
    expect(await store.read(mainIdentity)).toEqual(current);
    const after = await db.getRepository('tenantAccessRevisions').find({ sort: ['id'] });
    expect(after.map((row) => row.get())).toEqual(before.map((row) => row.get()));
  });

  it('returns an empty history for a valid unconfigured collection', async () => {
    expect(await store.listRevisions(mainIdentity)).toEqual({ currentRevision: 0, revisions: [], nextBefore: null });
    await expect(store.revisionDraft(mainIdentity, 1)).rejects.toMatchObject({ status: 404 });
  });

  it('can explicitly save a restored draft as a new revision while retaining the old trail', async () => {
    const first = await revisions();
    const { config } = await store.revisionDraft(mainIdentity, 1);
    const restored = await store.save(mainIdentity, config, { userId: 31 });
    expect(restored).toEqual({ ...first, revision: 4 });
    expect(await store.listRevisions(mainIdentity)).toMatchObject({
      revisions: [
        { revision: 4, actorUserId: '31' },
        { revision: 3, actorUserId: '9' },
        { revision: 2, actorUserId: '16' },
        { revision: 1, actorUserId: '28' },
      ],
    });
    const original = await db
      .getRepository('tenantAccessRevisions')
      .findOne({ filter: { ...mainIdentity, revision: 1 } });
    expect(original.getDataValue('config')).toEqual(first);
  });

  it('rejects an audit payload whose revision disagrees with the selected history row', async () => {
    const first = await revisions();
    await db.getRepository('tenantAccessRevisions').update({
      filter: { ...mainIdentity, revision: 1 },
      values: { config: { ...first, revision: 2 } },
    });
    await expect(store.revisionDraft(mainIdentity, 1)).rejects.toMatchObject({ code: 'INVALID_ACCESS_CONFIG_WRITE' });
    expect((await store.read(mainIdentity)).revision).toBe(3);
  });

  it.skipIf(dialect !== 'postgres')(
    'uses the primary for history and the draft editing base with a stale read pool',
    async () => {
      await revisions();
      await db.sequelize.query('CREATE SCHEMA revision_reader');
      await db.sequelize.query(
        'CREATE TABLE revision_reader."tenantAccessRevisions" (LIKE public."tenantAccessRevisions" INCLUDING ALL)',
      );
      await db.sequelize.query(
        'INSERT INTO revision_reader."tenantAccessRevisions" SELECT * FROM public."tenantAccessRevisions" WHERE revision=1',
      );
      await db.sequelize.query(
        'CREATE TABLE revision_reader.access_config_collections (LIKE public.access_config_collections INCLUDING ALL)',
      );
      const { host, port, database, username, password } = db.options;
      const connection = { host, port, database, username, password };
      const routed = new Database({
        ...db.options,
        replication: {
          write: connection,
          read: [{ ...connection, dialectOptions: { application_name: 'revision-stale-reader' } }],
        },
      });
      routed.sequelize.addHook('afterConnect', async (connection, config) => {
        if (config.dialectOptions?.application_name === 'revision-stale-reader')
          await connection.query('SET search_path TO revision_reader');
      });
      registerConfigModels(routed);
      try {
        expect(await routed.getCollection('tenantAccessRevisions').model.count({ where: mainIdentity })).toBe(1);
        const reader = configStore(routed);
        expect((await reader.listRevisions(mainIdentity)).revisions.map((entry) => entry.revision)).toEqual([3, 2, 1]);
        expect(await reader.revisionDraft(mainIdentity, 1)).toMatchObject({
          sourceRevision: 1,
          config: { revision: 3 },
        });
      } finally {
        await routed.close();
        await db.sequelize.query('DROP SCHEMA revision_reader CASCADE');
      }
    },
  );

  it('does not reuse history after deleting and recreating the same collection name', async () => {
    await revisions();
    await db.getRepository('collections').destroy({ filterByTk: 'documents' });
    await db.getRepository('collections').create({ values: { key: 'replacement', name: 'documents' } });
    await expect(store.listRevisions(mainIdentity)).rejects.toMatchObject({ code: 'ACCESS_COLLECTION_NOT_FOUND' });
    await expect(store.revisionDraft(mainIdentity, 1)).rejects.toMatchObject({ code: 'ACCESS_COLLECTION_NOT_FOUND' });
    expect(await store.listRevisions({ ...mainIdentity, collectionKey: 'replacement' })).toEqual({
      currentRevision: 0,
      revisions: [],
      nextBefore: null,
    });
  });

  it('rejects a historical rule that no longer fits current collection metadata', async () => {
    await revisions();
    const fields = { ...documents.fields };
    delete fields.tenantId;
    const changed = new AccessConfigStore(db, (identity) => ({
      ...documents,
      fields,
      key: accessCollectionKey(identity),
    }));
    // Current revision has no rules; only the selected historical revision needs the removed field.
    await expect(changed.revisionDraft(mainIdentity, 1)).rejects.toMatchObject({ code: 'INVALID_ACCESS_RULE' });
    expect((await store.read(mainIdentity)).revision).toBe(3);
    expect(await db.getRepository('tenantAccessRevisions').count()).toBe(4);
  });

  it('rejects a draft if another save changes its editing base during lookup', async () => {
    await revisions();
    let saved = false;
    const current = await store.read(mainIdentity);
    const changing = new AccessConfigStore(db, async (identity) => {
      if (!saved) {
        saved = true;
        await store.save(mainIdentity, { ...current, ownership: { enabled: true } }, { userId: 30 });
      }
      return { ...documents, key: accessCollectionKey(identity) };
    });
    await expect(changing.revisionDraft(mainIdentity, 1)).rejects.toMatchObject({
      code: 'ACCESS_CONFIG_CONFLICT',
      status: 409,
    });
    expect((await store.read(mainIdentity)).revision).toBe(4);
  });

  it.each([0, -1, 1.5, 101, NaN, Infinity, '2', null])('rejects invalid page size %s', async (limit) => {
    await expect(store.listRevisions(mainIdentity, limit as number)).rejects.toThrow();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    'rejects invalid revision or cursor %s',
    async (revision) => {
      await expect(store.listRevisions(mainIdentity, 20, revision as number)).rejects.toThrow();
      await expect(store.revisionDraft(mainIdentity, revision as number)).rejects.toThrow();
    },
  );
});
